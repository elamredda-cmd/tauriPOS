<script lang="ts">
    import { createEventDispatcher, onDestroy, tick } from 'svelte';
    import { isTauri } from '@tauri-apps/api/core';
    import Modal from '$lib/components/Modal.svelte';
    import TouchDigitPad from '$lib/components/TouchDigitPad.svelte';
    import { attendanceDurationSeconds, formatAttendanceDuration } from '$lib/attendance';
    import { employeesDB, type Employee, type EmployeeAttendance } from '$lib/stores/db';
    import { clockInEmployeeAttendance, clockOutEmployeeAttendance, getOpenEmployeeAttendance, getOrCreateTillId } from '$lib/stores/database';
    import { currentEmployee, isSupportEmployee, signInToAttendance, revokeAttendanceSignIn } from '$lib/stores/session';
    import { connectionState } from '$lib/stores/connection';
    import { toast } from '$lib/stores/toast';

    export let show = false;
    export let allowHistoryNavigation = true;
    export let staffSignIn = false;

    const dispatch = createEventDispatcher<{ change: EmployeeAttendance | null }>();
    let authenticated: Employee | null = null;
    let token = '';
    let selected: Employee | null = null;
    let pin = '';
    let pinPanel: HTMLDivElement | undefined;
    let search = '';
    let current: EmployeeAttendance | null = null;
    let loading = false;
    let busy = false;
    let errorMessage = '';
    let completed = '';
    let loadedKey = '';
    let opened = false;
    let request = 0;
    let clock = Date.now();
    let timer: ReturnType<typeof setInterval> | null = null;
    let expiryTimer: ReturnType<typeof setTimeout> | null = null;

    $: staff = $employeesDB.filter(e => e.isActive && !isSupportEmployee(e)).sort((a, b) => a.name.localeCompare(b.name));
    $: filteredStaff = staff.filter(e => e.name.toLocaleLowerCase().includes(search.toLocaleLowerCase().trim()));
    $: employee = staffSignIn ? authenticated : $currentEmployee;
    $: sharedAttendanceReady = $connectionState.mode !== 'multi' || ($connectionState.mysqlOnline && $connectionState.mysqlReady);
    $: attendanceLoadKey = `${employee?.id || ''}|${sharedAttendanceReady}`;
    $: if (!sharedAttendanceReady) loadedKey = '';
    $: if (show && !opened) opened = true;
    $: if (!show && opened) { reset(); opened = false; }
    $: if (show && employee && sharedAttendanceReady && !completed && loadedKey !== attendanceLoadKey) void loadStatus(employee.id, attendanceLoadKey);
    // Nothing ticks while the dialog is closed. Elapsed attendance is shown in minutes.
    $: updateClockTimer(show && Boolean(employee) && Boolean(current) && !completed);
    onDestroy(reset);

    function updateClockTimer(active: boolean) {
        if (active && !timer) { clock = Date.now(); timer = setInterval(() => (clock = Date.now()), 30_000); }
        else if (!active && timer) { clearInterval(timer); timer = null; }
    }
    function clearSignIn() {
        revokeAttendanceSignIn(token);
        token = '';
        authenticated = null;
        pin = '';
        if (expiryTimer) clearTimeout(expiryTimer);
        expiryTimer = null;
    }
    function reset() {
        request++;
        clearSignIn();
        selected = null;
        search = '';
        current = null;
        completed = '';
        errorMessage = '';
        loadedKey = '';
        loading = false;
        busy = false;
        updateClockTimer(false);
    }
    function chooseEmployee(value: Employee) {
        reset();
        selected = value;
        void tick().then(() => pinPanel?.focus({ preventScroll: true }));
    }
    async function signIn() {
        if (!selected || !pin || busy || !sharedAttendanceReady) return;
        const run = ++request;
        const enteredPin = pin;
        pin = '';
        busy = true;
        errorMessage = '';
        try {
            const result = await signInToAttendance(selected.id, enteredPin);
            if (run !== request || !show) { if (result) revokeAttendanceSignIn(result.token); return; }
            if (!result) { errorMessage = 'PIN not recognised. Check your name and try again.'; return; }
            token = result.token;
            authenticated = result.employee;
            loadedKey = '';
            expiryTimer = setTimeout(() => {
                // An action already being saved owns the grant until it finishes.
                if (busy) return;
                request++;
                clearSignIn();
                current = null;
                loadedKey = '';
                loading = false;
                errorMessage = 'Your staff clock sign-in expired. Enter your PIN again.';
            }, Math.max(0, result.expiresAt - Date.now()));
        } catch (error) {
            if (run === request) errorMessage = friendlyError(error);
        } finally { if (run === request) busy = false; }
    }
    function handleKey(event: KeyboardEvent) {
        if (!show || !staffSignIn || !selected || authenticated || completed || busy || !sharedAttendanceReady || event.ctrlKey || event.metaKey || event.altKey) return;
        if (/^\d$/.test(event.key)) { event.preventDefault(); if (pin.length < 8) pin += event.key; }
        else if (event.key === 'Backspace') { event.preventDefault(); pin = pin.slice(0, -1); }
        else if (event.key === 'Enter' && (!(event.target instanceof HTMLButtonElement) || event.target.closest('.digit-pad'))) { event.preventDefault(); void signIn(); }
    }
    async function loadStatus(employeeId: string, key: string) {
        if (loading) return;
        const run = ++request;
        loadedKey = key;
        loading = true;
        current = null;
        errorMessage = '';
        try {
            const result = await getOpenEmployeeAttendance(employeeId, true);
            if (run !== request || !show) return;
            current = result;
            if (!staffSignIn) dispatch('change', current);
        } catch (error) {
            if (run === request) errorMessage = `Could not check attendance. ${friendlyError(error)}`;
        } finally { if (run === request) loading = false; }
    }
    function friendlyError(error: unknown): string {
        const message = String(error).replace(/^Error:\s*/, '');
        if (message.includes('ATTENDANCE_ALREADY_CLOCKED_IN')) return 'You are already clocked in. Sign in again to check the latest status.';
        if (message.includes('ATTENDANCE_NOT_CLOCKED_IN')) return 'You are not currently clocked in. Sign in again to check the latest status.';
        if (message.includes('ATTENDANCE_SESSION_CHANGED')) return 'Your attendance changed on another till. Sign in again to check the latest status.';
        return message;
    }
    async function toggleAttendance() {
        if (!employee || busy || loading || errorMessage || !sharedAttendanceReady || isSupportEmployee(employee) || (staffSignIn && !token)) return;
        const actor = employee;
        const run = ++request;
        busy = true;
        try {
            const tillId = isTauri() ? await getOrCreateTillId() : 'browser-preview-till';
            const proof = staffSignIn ? token : undefined;
            const result = current
                ? await clockOutEmployeeAttendance(actor.id, tillId, actor.id, current.id, proof)
                : await clockInEmployeeAttendance(actor.id, tillId, actor.id, '', proof);
            if (run !== request) return;
            current = result.status === 'open' ? result : null;
            const message = `${actor.name} clocked ${current ? 'in' : 'out'} at ${formatTime(current ? result.clockInAt : result.clockOutAt)}`;
            if (staffSignIn) { completed = message; clearSignIn(); }
            else { dispatch('change', current); toast(message); }
        } catch (error) {
            if (run !== request) return;
            if (staffSignIn) { clearSignIn(); current = null; loadedKey = ''; }
            errorMessage = friendlyError(error);
        } finally { if (run === request) busy = false; }
    }
    function formatTime(value: string): string {
        const date = new Date(value);
        return Number.isFinite(date.getTime()) ? date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '-';
    }
</script>

<svelte:window on:keydown={handleKey} />
<Modal bind:show title={staffSignIn ? 'Staff attendance' : 'My Attendance'} width="520px" dismissDisabled={busy}>
    <div class="attendance-clock-shell">
        {#if completed}
            <section class="attendance-confirmation" role="status">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
                <strong>{completed}</strong>
                <p>Your attendance has been saved.</p>
            </section>
            <button class="btn btn-secondary next-worker" on:click={reset}>Next staff member</button>
        {:else}
            {#if !sharedAttendanceReady}
                <div class="attendance-notice" role="status">The shared staff clock is disconnected or still connecting. Please wait for the connection before clocking in or out.</div>
            {/if}
            {#if staffSignIn && !authenticated}
                {#if !selected}
                    <p class="attendance-intro">Choose your name, then enter your PIN to clock in or out.</p>
                    {#if staff.length > 8}
                        <label class="staff-search">Find your name<input type="search" bind:value={search} placeholder="Search staff" /></label>
                    {/if}
                    <div class="staff-list" aria-label="Choose a staff member">
                        {#each filteredStaff as person (person.id)}
                            <button class="staff-choice" disabled={!sharedAttendanceReady} on:click={() => chooseEmployee(person)}>
                                <span class="staff-avatar" aria-hidden="true">{person.name.trim().slice(0, 1).toUpperCase()}</span>
                                <span>{person.name}</span><span class="staff-chevron" aria-hidden="true">›</span>
                            </button>
                        {:else}<p class="attendance-intro">{staff.length ? 'No matching staff members.' : 'No active staff accounts. Add staff in administration first.'}</p>{/each}
                    </div>
                {:else}
                    <div class="staff-pin" bind:this={pinPanel} tabindex="-1" role="group" aria-label="Enter your attendance PIN">
                    <div class="staff-sign-in-heading"><div><small>Signing in for attendance</small><strong>{selected.name}</strong></div><button class="btn btn-secondary" disabled={busy} on:click={reset}>Change</button></div>
                    <TouchDigitPad bind:value={pin} maxLength={8} masked placeholder="Enter your PIN" submitLabel={busy ? 'Signing in…' : 'Sign in'} disabled={busy || !sharedAttendanceReady} submitDisabled={!pin} onSubmit={signIn} />
                    </div>
                {/if}
            {:else}
                <section class:clocked-in={Boolean(current)} class="attendance-state" aria-live="polite">
                    <span class="attendance-state-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></span>
                    <div><small>{employee?.name || 'Staff member'}</small>
                        <strong>{loading ? 'Checking status…' : errorMessage ? 'Status unavailable' : current ? 'Clocked in' : 'Not clocked in'}</strong>
                        {#if !loading && !errorMessage}
                            <span>{current ? `Since ${formatTime(current.clockInAt)} · ${formatAttendanceDuration(attendanceDurationSeconds(current, clock))}` : 'Clock in when you start work.'}</span>
                        {/if}
                    </div>
                </section>
                {#if isSupportEmployee(employee)}<div class="attendance-notice">Support sessions cannot create employee attendance records.</div>{/if}
                {#if errorMessage}
                    <button class="btn btn-secondary" disabled={loading || busy || !sharedAttendanceReady} on:click={() => employee && loadStatus(employee.id, attendanceLoadKey)}>Retry status check</button>
                {:else}
                    <button type="button" class="attendance-clock-action" class:clock-out={Boolean(current)} disabled={loading || busy || !sharedAttendanceReady || !employee || isSupportEmployee(employee)} on:click={toggleAttendance}>
                        {busy ? 'Saving…' : loading ? 'Checking…' : current ? 'Clock Out' : 'Clock In'}
                    </button>
                {/if}
                {#if staffSignIn}<button class="btn btn-secondary" disabled={busy} on:click={reset}>Use a different staff member</button>{/if}
            {/if}
            {#if errorMessage}<div class="attendance-notice" role="alert">{errorMessage}</div>{/if}
            <p class="attendance-help">{staffSignIn ? 'Your PIN is for this attendance action only. The till operator stays signed in.' : 'Attendance is recorded separately from till cash-up and receipt history.'}</p>
        {/if}
    </div>
    <svelte:fragment slot="footer">
        {#if allowHistoryNavigation && !staffSignIn}<a class="btn btn-secondary" href="/attendance" on:click={() => (show = false)}>View Attendance</a>{/if}
        <button class="btn btn-secondary" disabled={busy} on:click={() => (show = false)}>{completed ? 'Done' : 'Close'}</button>
    </svelte:fragment>
</Modal>

<style>
    .attendance-clock-shell { display: flex; flex-direction: column; gap: 1rem; }
    .attendance-intro { margin: 0; color: var(--text-muted); font-size: .9rem; line-height: 1.5; }
    .staff-list { display: grid; gap: .5rem; max-height: 40vh; overflow-y: auto; padding: 3px; }
    .staff-choice { display: flex; align-items: center; gap: .8rem; width: 100%; min-height: 60px; padding: .65rem .8rem; text-align: left; color: var(--text-main); background: var(--bg-panel); border: 1px solid var(--border-flat); border-radius: .6rem; font-weight: 750; overflow-wrap: anywhere; }
    .staff-choice:hover:not(:disabled) { border-color: var(--accent-primary); background: color-mix(in srgb, var(--accent-primary) 8%, var(--bg-panel)); }
    .staff-choice:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 1px; }
    .staff-choice:disabled { opacity: .5; }
    .staff-avatar { display: grid; place-items: center; flex: 0 0 34px; height: 34px; border-radius: 50%; background: color-mix(in srgb, var(--accent-primary) 12%, var(--bg-card)); color: var(--accent-primary); }
    .staff-chevron { margin-left: auto; color: var(--text-muted); font-size: 1.4rem; }
    .staff-search { display: grid; gap: .4rem; font-size: .8rem; font-weight: 750; }
    .staff-search input { width: 100%; min-width: 0; min-height: 46px; }
    .staff-sign-in-heading { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
    .staff-pin { display: grid; gap: 1rem; outline: none; }
    .staff-sign-in-heading div { min-width: 0; }
    .staff-sign-in-heading small { display: block; color: var(--text-muted); }
    .staff-sign-in-heading strong { display: block; font-size: 1.2rem; overflow-wrap: anywhere; }
    .attendance-state { min-height: 112px; padding: 1rem; display: flex; align-items: center; gap: 1rem; border: 1px solid var(--border-flat); border-radius: .55rem; background: var(--bg-panel); }
    .attendance-state.clocked-in { border-color: color-mix(in srgb, var(--success) 55%, var(--border-flat)); background: color-mix(in srgb, var(--success) 10%, var(--bg-panel)); }
    .attendance-state-icon { width: 58px; height: 58px; flex: 0 0 58px; display: grid; place-items: center; color: var(--text-muted); border: 1px solid var(--border-flat); border-radius: 50%; background: var(--bg-card); }
    .clocked-in .attendance-state-icon { color: var(--success); }
    .attendance-state-icon svg { width: 28px; height: 28px; }
    .attendance-state div { min-width: 0; overflow-wrap: anywhere; }
    .attendance-state small, .attendance-state strong, .attendance-state span { display: block; }
    .attendance-state small { color: var(--text-muted); font-size: .72rem; font-weight: 850; text-transform: uppercase; }
    .attendance-state strong { margin-top: .18rem; font-size: 1.35rem; }
    .attendance-state span { margin-top: .3rem; color: var(--text-muted); font-size: .82rem; }
    .attendance-clock-action { min-height: 62px; width: 100%; color: white; border: 1px solid var(--success); border-radius: .55rem; background: var(--success); font-size: 1.08rem; font-weight: 950; }
    .attendance-clock-action.clock-out { border-color: var(--danger); background: var(--danger); }
    .attendance-clock-action:disabled { cursor: not-allowed; opacity: .58; }
    .attendance-help { margin: 0; color: var(--text-muted); text-align: center; font-size: .74rem; line-height: 1.5; }
    .attendance-notice { padding: .75rem .85rem; color: var(--warning); border: 1px solid color-mix(in srgb, var(--warning) 45%, var(--border-flat)); border-radius: .45rem; background: color-mix(in srgb, var(--warning) 9%, var(--bg-card)); font-size: .8rem; line-height: 1.5; overflow-wrap: anywhere; }
    .attendance-confirmation { display: grid; justify-items: center; gap: 1rem; padding: 1.5rem .5rem; text-align: center; }
    .attendance-confirmation svg { color: var(--success); width: 52px; height: 52px; }
    .attendance-confirmation strong { font-size: 1.35rem; overflow-wrap: anywhere; }
    .attendance-confirmation p { margin: 0; color: var(--text-muted); }
    .next-worker { min-height: 48px; }
</style>
