<script lang="ts">
    import { onDestroy, onMount } from 'svelte';
    import { goto } from '$app/navigation';
    import { isTauri } from '@tauri-apps/api/core';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import Modal from '$lib/components/Modal.svelte';
    import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
    import CustomSelect from '$lib/components/CustomSelect.svelte';
    import SearchField from '$lib/components/SearchField.svelte';
    import AttendanceClock from '$lib/components/AttendanceClock.svelte';
    import {
        ATTENDANCE_CORRECTION_CONFLICT_CODE,
        ATTENDANCE_CORRECTION_CONFLICT_MESSAGE,
        ATTENDANCE_EXPORT_MAX_ROWS,
        attendanceDateRange,
        attendanceCsvCell,
        attendanceDurationSeconds,
        formatAttendanceDuration,
        fromDatetimeLocalValue,
        toDatetimeLocalValue,
    } from '$lib/attendance';
    import {
        ATTENDANCE_CHANGED_EVENT,
        clockOutEmployeeAttendance,
        getAttendancePage,
        getOpenEmployeeAttendance,
        getOrCreateTillId,
        saveClosedEmployeeAttendance,
    } from '$lib/stores/database';
    import {
        employeesDB,
        registersDB,
        settingsDB,
        type EmployeeAttendance,
    } from '$lib/stores/db';
    import { currentEmployee, isSupportEmployee, logout } from '$lib/stores/session';
    import { toast } from '$lib/stores/toast';
    import { hasPermission } from '$lib/permissions';
    import { connectionState } from '$lib/stores/connection';

    const PAGE_SIZE = 30;
    const today = localDateValue(new Date());
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - 6);

    let startDate = localDateValue(weekStart);
    let endDate = today;
    let employeeFilter = '';
    let statusFilter = 'all';
    let searchQuery = '';
    let appliedSearchQuery = '';
    let page = 0;
    let previousQueryKey = '';
    let rows: EmployeeAttendance[] = [];
    let total = 0;
    let overallTotal = 0;
    let totalWorkedSeconds = 0;
    let openCount = 0;
    let sourceWarning = '';
    let loading = false;
    let loadError = '';
    let loadRun = 0;
    let mounted = false;
    let loadTimer: ReturnType<typeof setTimeout> | null = null;
    let clock = Date.now();
    let clockTimer: ReturnType<typeof setInterval> | null = null;
    let previousAttendanceConnectionReady = false;

    let selfOpen: EmployeeAttendance | null = null;
    let clockModalOpen = false;
    let showEditor = false;
    let editorBusy = false;
    let editingExisting = false;
    let editId = '';
    let editEmployeeId = '';
    let editClockIn = '';
    let editClockOut = '';
    let editClockInTillId = '';
    let editClockOutTillId = '';
    let editNotes = '';
    let editExpectedUpdatedAt = '';
    let exporting = false;
    let showManagerClockOutConfirm = false;
    let managerClockOutRecord: EmployeeAttendance | null = null;
    let managerClockOutBusyId = '';

    $: canViewAll = hasPermission($currentEmployee, 'view_attendance', $settingsDB);
    $: canManage = !isSupportEmployee($currentEmployee)
        && hasPermission($currentEmployee, 'manage_attendance', $settingsDB);
    $: effectiveEmployeeId = canViewAll ? employeeFilter : ($currentEmployee?.id || '');
    $: pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
    $: if (page >= pageCount) page = pageCount - 1;
    $: employeeOptions = [
        { value: '', label: 'All staff' },
        ...[...$employeesDB]
            .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
            .map((employee) => ({
                value: employee.id,
                label: `${employee.name}${employee.isActive ? '' : ' (inactive)'}`,
            })),
    ];
    $: editorEmployeeOptions = employeeOptions.filter((option) => option.value);
    $: tillOptions = [
        { value: '', label: 'Unassigned till' },
        ...[...$registersDB]
            .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
            .map((register) => ({
                value: register.id,
                label: `${register.name}${register.isActive ? '' : ' (retired)'}`,
            })),
    ];
    $: queryKey = `${effectiveEmployeeId}|${statusFilter}|${startDate}|${endDate}|${appliedSearchQuery}|${page}`;
    $: if (mounted && queryKey !== previousQueryKey) {
        previousQueryKey = queryKey;
        scheduleLoad();
    }
    $: attendanceConnectionReady = $connectionState.mode !== 'multi'
        || ($connectionState.mysqlOnline && $connectionState.mysqlReady);
    $: if (mounted && attendanceConnectionReady !== previousAttendanceConnectionReady) {
        const becameReady = attendanceConnectionReady;
        previousAttendanceConnectionReady = attendanceConnectionReady;
        if (becameReady) {
            scheduleLoad();
            void loadSelfStatus();
        }
    }

    const statusOptions = [
        { value: 'all', label: 'All sessions' },
        { value: 'open', label: 'Clocked in' },
        { value: 'closed', label: 'Completed' },
    ];

    onMount(() => {
        mounted = true;
        previousQueryKey = queryKey;
        previousAttendanceConnectionReady = attendanceConnectionReady;
        clockTimer = setInterval(() => (clock = Date.now()), 30_000);
        window.addEventListener(ATTENDANCE_CHANGED_EVENT, handleAttendanceChanged);
        void Promise.all([loadPage(), loadSelfStatus()]);
        return () => {
            window.removeEventListener(ATTENDANCE_CHANGED_EVENT, handleAttendanceChanged);
        };
    });

    onDestroy(() => {
        mounted = false;
        loadRun += 1;
        if (loadTimer) clearTimeout(loadTimer);
        if (clockTimer) clearInterval(clockTimer);
    });

    function localDateValue(date: Date): string {
        const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
        return local.toISOString().slice(0, 10);
    }

    function scheduleLoad(delay = 0) {
        if (loadTimer) clearTimeout(loadTimer);
        loadTimer = setTimeout(() => {
            loadTimer = null;
            void loadPage();
        }, delay);
    }

    function attendanceOptions(limit = PAGE_SIZE, offset = page * PAGE_SIZE) {
        const range = attendanceDateRange(startDate, endDate);
        return {
            employeeId: effectiveEmployeeId,
            query: appliedSearchQuery,
            status: statusFilter,
            ...range,
            limit,
            offset,
        };
    }

    async function loadPage() {
        if (!$currentEmployee) return;
        const run = ++loadRun;
        loading = true;
        loadError = '';
        try {
            const result = await getAttendancePage(attendanceOptions());
            if (run !== loadRun) return;
            rows = result.rows;
            total = result.total;
            overallTotal = result.overallTotal;
            totalWorkedSeconds = result.totalWorkedSeconds;
            openCount = result.openCount;
            sourceWarning = result.warning || '';
        } catch (error) {
            if (run !== loadRun) return;
            console.error('Could not load attendance:', error);
            rows = [];
            total = 0;
            totalWorkedSeconds = 0;
            openCount = 0;
            sourceWarning = '';
            loadError = String(error).replace(/^Error:\s*/, '') || 'Attendance is temporarily unavailable.';
        } finally {
            if (run === loadRun) loading = false;
        }
    }

    async function loadSelfStatus() {
        const employeeId = $currentEmployee?.id || '';
        if (!employeeId) {
            selfOpen = null;
            return;
        }
        try {
            selfOpen = await getOpenEmployeeAttendance(employeeId);
        } catch (error) {
            console.warn('Could not load personal attendance status:', error);
        }
    }

    function handleAttendanceChanged() {
        void Promise.all([loadPage(), loadSelfStatus()]);
    }

    function applySearch() {
        const next = searchQuery.trim();
        if (next === appliedSearchQuery && page === 0) {
            scheduleLoad();
            return;
        }
        appliedSearchQuery = next;
        page = 0;
    }

    function clearSearch() {
        searchQuery = '';
        appliedSearchQuery = '';
        page = 0;
    }

    function handleSearchKeydown(event: KeyboardEvent & { currentTarget: HTMLInputElement }) {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        applySearch();
    }

    async function addManualRecord() {
        if (!canManage || !$currentEmployee) return;
        const end = new Date();
        end.setSeconds(0, 0);
        const start = new Date(end.getTime() - 8 * 60 * 60 * 1000);
        const tillId = isTauri() ? await getOrCreateTillId().catch(() => '') : '';
        editingExisting = false;
        editId = crypto.randomUUID();
        editEmployeeId = employeeFilter || $currentEmployee.id;
        editClockIn = toDatetimeLocalValue(start.toISOString());
        editClockOut = toDatetimeLocalValue(end.toISOString());
        editClockInTillId = tillId;
        editClockOutTillId = tillId;
        editNotes = '';
        editExpectedUpdatedAt = '';
        showEditor = true;
    }

    function editRecord(record: EmployeeAttendance) {
        if (!canManage || record.status !== 'closed') return;
        editingExisting = true;
        editId = record.id;
        editEmployeeId = record.employeeId;
        editClockIn = toDatetimeLocalValue(record.clockInAt);
        editClockOut = toDatetimeLocalValue(record.clockOutAt);
        editClockInTillId = record.clockInTillId || '';
        editClockOutTillId = record.clockOutTillId || '';
        editNotes = record.notes || '';
        editExpectedUpdatedAt = record.updatedAt || '';
        showEditor = true;
    }

    function requestManagerClockOut(record: EmployeeAttendance) {
        if (!canManage || record.status !== 'open' || managerClockOutBusyId) return;
        managerClockOutRecord = record;
        showManagerClockOutConfirm = true;
    }

    async function confirmManagerClockOut() {
        const record = managerClockOutRecord;
        const manager = $currentEmployee;
        if (!record || !manager || !canManage || managerClockOutBusyId) return;
        managerClockOutBusyId = record.id;
        try {
            const tillId = isTauri() ? await getOrCreateTillId() : 'browser-preview-till';
            await clockOutEmployeeAttendance(record.employeeId, tillId, manager.id, record.id);
            toast(`${record.employeeName || 'Staff member'} clocked out by manager.`);
            await Promise.all([loadPage(), loadSelfStatus()]);
        } catch (error) {
            console.error('Could not clock out staff member:', error);
            const message = String(error).replace(/^Error:\s*/, '');
            toast(
                message.includes('ATTENDANCE_NOT_CLOCKED_IN')
                    ? 'This staff member is already clocked out.'
                    : message.includes('ATTENDANCE_SESSION_CHANGED')
                        ? 'This staff member started a different attendance session. Nothing was changed; review the latest row and try again.'
                    : `Could not clock out staff member: ${message}`,
                'error',
            );
            await loadPage();
        } finally {
            managerClockOutBusyId = '';
            managerClockOutRecord = null;
        }
    }

    async function saveEditor() {
        if (editorBusy || !canManage || !$currentEmployee) return;
        editorBusy = true;
        try {
            await saveClosedEmployeeAttendance({
                id: editId,
                employeeId: editEmployeeId,
                clockInAt: fromDatetimeLocalValue(editClockIn),
                clockOutAt: fromDatetimeLocalValue(editClockOut),
                clockInTillId: editClockInTillId,
                clockOutTillId: editClockOutTillId,
                status: 'closed',
                notes: editNotes,
                createdByEmployeeId: $currentEmployee.id,
                updatedByEmployeeId: $currentEmployee.id,
                createdAt: '',
                updatedAt: editExpectedUpdatedAt,
            }, $currentEmployee.id);
            showEditor = false;
            toast(editingExisting ? 'Attendance record corrected' : 'Attendance record added');
            await loadPage();
        } catch (error) {
            console.error('Could not save attendance record:', error);
            const message = String(error).replace(/^Error:\s*/, '');
            if (message.includes(ATTENDANCE_CORRECTION_CONFLICT_CODE)) {
                showEditor = false;
                await loadPage();
                toast(ATTENDANCE_CORRECTION_CONFLICT_MESSAGE, 'error');
            } else {
                toast(message, 'error');
            }
        } finally {
            editorBusy = false;
        }
    }

    async function exportCsv() {
        if (exporting) return;
        exporting = true;
        try {
            const allRows: EmployeeAttendance[] = [];
            let offset = 0;
            let expected = 1;
            while (offset < expected) {
                const result = await getAttendancePage(attendanceOptions(100, offset));
                expected = result.total;
                if (expected > ATTENDANCE_EXPORT_MAX_ROWS) {
                    throw new Error(
                        `This export contains ${expected.toLocaleString()} records. Choose a shorter date range (maximum ${ATTENDANCE_EXPORT_MAX_ROWS.toLocaleString()} records per export).`,
                    );
                }
                allRows.push(...result.rows);
                if (result.rows.length === 0) break;
                offset += result.rows.length;
            }
            const csvRows = [
                ['Staff', 'Clock in', 'Clock out', 'Hours', 'Status', 'Clock-in till', 'Clock-out till', 'Notes'],
                ...allRows.map((record) => [
                    record.employeeName || record.employeeId,
                    formatDate(record.clockInAt, true),
                    record.clockOutAt ? formatDate(record.clockOutAt, true) : '',
                    (attendanceDurationSeconds(record, clock) / 3600).toFixed(2),
                    record.status,
                    record.clockInTillName || record.clockInTillId,
                    record.clockOutTillName || record.clockOutTillId,
                    record.notes,
                ]),
            ];
            const csv = csvRows.map((row) => row.map(attendanceCsvCell).join(',')).join('\r\n');
            const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = `attendance-${startDate}-to-${endDate}.csv`;
            anchor.click();
            URL.revokeObjectURL(url);
            toast(`Exported ${allRows.length} attendance record${allRows.length === 1 ? '' : 's'}`);
        } catch (error) {
            console.error('Could not export attendance:', error);
            toast(`Could not export attendance: ${String(error).replace(/^Error:\s*/, '')}`, 'error');
        } finally {
            exporting = false;
        }
    }

    function formatDate(value: string, includeDate = false): string {
        const date = new Date(value);
        if (!Number.isFinite(date.getTime())) return '-';
        return date.toLocaleString('en-GB', includeDate
            ? { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }
            : { hour: '2-digit', minute: '2-digit' });
    }

    function formatPeriodLabel(start: string, end: string): string {
        const startValue = new Date(`${start}T12:00:00`);
        const endValue = new Date(`${end}T12:00:00`);
        if (!Number.isFinite(startValue.getTime()) || !Number.isFinite(endValue.getTime())) {
            return start === end ? start : `${start} – ${end}`;
        }
        const day = (date: Date) => date.toLocaleDateString('en-GB', { day: 'numeric' });
        const month = (date: Date) => date.toLocaleDateString('en-GB', { month: 'short' });
        const year = (date: Date) => date.getFullYear();
        if (start === end) return `${day(startValue)} ${month(startValue)} ${year(startValue)}`;
        if (startValue.getFullYear() === endValue.getFullYear() && startValue.getMonth() === endValue.getMonth()) {
            return `${day(startValue)}–${day(endValue)} ${month(endValue)} ${year(endValue)}`;
        }
        if (startValue.getFullYear() === endValue.getFullYear()) {
            return `${day(startValue)} ${month(startValue)}–${day(endValue)} ${month(endValue)} ${year(endValue)}`;
        }
        return `${day(startValue)} ${month(startValue)} ${year(startValue)}–${day(endValue)} ${month(endValue)} ${year(endValue)}`;
    }

    function initials(name: string): string {
        return String(name || 'Staff').trim().split(/\s+/).slice(0, 2)
            .map((part) => part[0] || '').join('').toUpperCase() || '?';
    }

    function signOutAttendanceStaff() {
        logout();
        void goto('/', { replaceState: true });
    }
</script>

<MgmtPage
    title="Attendance"
    description={$currentEmployee?.role === 'attendance' ? 'Clock in, clock out and review your hours' : 'Staff clock-ins, hours and corrections'}
    showBack={$currentEmployee?.role !== 'attendance'}
>
    <div slot="actions" class="attendance-page-actions">
        {#if canManage}
            <button class="btn btn-secondary" on:click={addManualRecord}>Add Record</button>
        {/if}
        {#if canViewAll}
            <button class="btn btn-primary" disabled={exporting || loading} on:click={exportCsv}>
                {exporting ? 'Exporting…' : 'Export CSV'}
            </button>
        {/if}
        {#if $currentEmployee?.role === 'attendance'}
            <button class="btn btn-secondary" on:click={signOutAttendanceStaff}>Sign Out</button>
        {/if}
    </div>

    <div class="attendance-shell">
        <section class="self-attendance" class:clocked-in={Boolean(selfOpen)}>
            <span class="self-avatar">{initials($currentEmployee?.name || '')}</span>
            <div class="self-copy">
                <small>My attendance</small>
                <strong>{selfOpen ? 'Clocked in' : 'Not clocked in'}</strong>
                <span>{selfOpen ? `Since ${formatDate(selfOpen.clockInAt)} · ${formatAttendanceDuration(attendanceDurationSeconds(selfOpen, clock))}` : 'Ready to start your work session'}</span>
            </div>
            <button class:clock-out={Boolean(selfOpen)} on:click={() => (clockModalOpen = true)}>
                {selfOpen ? 'Clock Out' : 'Clock In'}
            </button>
        </section>

        <div class="attendance-summary" aria-label="Attendance summary">
            <article><span>Filtered hours</span><strong>{formatAttendanceDuration(totalWorkedSeconds)}</strong></article>
            <article><span>Sessions</span><strong>{total}</strong><small>of {overallTotal}</small></article>
            <article><span>Clocked in</span><strong>{openCount}</strong></article>
            <article><span>Period</span><strong>{formatPeriodLabel(startDate, endDate)}</strong></article>
        </div>

        <section class="attendance-filters">
            {#if canViewAll}
                <div class="filter-select employee-filter"><CustomSelect label="Staff" bind:value={employeeFilter} options={employeeOptions} /></div>
            {/if}
            <div class="filter-select"><CustomSelect label="Status" bind:value={statusFilter} options={statusOptions} /></div>
            <label class="date-field"><span>From</span><input type="date" bind:value={startDate} max={endDate} /></label>
            <label class="date-field"><span>To</span><input type="date" bind:value={endDate} min={startDate} max={today} /></label>
            <div class="attendance-search">
                <SearchField
                    id="attendance-search"
                    bind:value={searchQuery}
                    placeholder="Search staff, till or notes"
                    onKeydown={handleSearchKeydown}
                    onClear={clearSearch}
                />
            </div>
            <button class="btn btn-secondary search-button" on:click={applySearch}>Search</button>
        </section>

        {#if sourceWarning}<div class="attendance-warning">{sourceWarning}</div>{/if}
        {#if loadError}<div class="attendance-error"><span>{loadError}</span><button class="btn btn-secondary" on:click={loadPage}>Retry</button></div>{/if}

        <div class="attendance-table-wrap">
            <table class="tbl attendance-table">
                <thead><tr><th>Staff</th><th>Clock In</th><th>Clock Out</th><th>Worked</th><th>Till</th><th>Status</th>{#if canManage}<th class="action-heading">Action</th>{/if}</tr></thead>
                <tbody>
                    {#each rows as record}
                        <tr class:open-row={record.status === 'open'}>
                            <td><strong>{record.employeeName || record.employeeId || 'Unknown'}</strong>{#if record.notes}<small title={record.notes}>{record.notes}</small>{/if}</td>
                            <td><strong>{formatDate(record.clockInAt, true)}</strong></td>
                            <td>{record.clockOutAt ? formatDate(record.clockOutAt, true) : '—'}</td>
                            <td class="duration-cell"><strong>{formatAttendanceDuration(attendanceDurationSeconds(record, clock))}</strong></td>
                            <td><span>{record.clockInTillName || record.clockInTillId || 'Unassigned'}</span>{#if record.clockOutTillId && record.clockOutTillId !== record.clockInTillId}<small>Out: {record.clockOutTillName || record.clockOutTillId}</small>{/if}</td>
                            <td><span class="attendance-status {record.status}"><i></i>{record.status === 'open' ? 'Clocked in' : 'Completed'}</span></td>
                            {#if canManage}
                                <td class="action-cell">
                                    {#if record.status === 'open'}
                                        <button
                                            class="btn btn-danger manager-clock-out"
                                            disabled={managerClockOutBusyId === record.id || !attendanceConnectionReady}
                                            title={attendanceConnectionReady ? `Clock out ${record.employeeName || 'staff member'}` : 'MariaDB attendance is still connecting'}
                                            on:click={() => requestManagerClockOut(record)}
                                        >
                                            {managerClockOutBusyId === record.id ? 'Clocking Out…' : 'Clock Out'}
                                        </button>
                                    {:else}
                                        <button class="btn-icon edit-attendance" title="Correct attendance record" aria-label="Correct attendance record" on:click={() => editRecord(record)}>
                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>
                                        </button>
                                    {/if}
                                </td>
                            {/if}
                        </tr>
                    {/each}
                    {#if loading && rows.length === 0}<tr class="empty-row"><td colspan={canManage ? 7 : 6}>Loading attendance…</td></tr>{/if}
                    {#if !loading && !loadError && rows.length === 0}<tr class="empty-row"><td colspan={canManage ? 7 : 6}>No attendance records match this period.</td></tr>{/if}
                </tbody>
            </table>
        </div>

        {#if total > PAGE_SIZE}
            <div class="attendance-pagination">
                <button class="btn btn-secondary" disabled={page === 0 || loading} on:click={() => page--}>Newer</button>
                <span>Page {page + 1} of {pageCount} · {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}</span>
                <button class="btn btn-secondary" disabled={page >= pageCount - 1 || loading} on:click={() => page++}>Older</button>
            </div>
        {/if}
    </div>
</MgmtPage>

<AttendanceClock bind:show={clockModalOpen} on:change={(event) => { selfOpen = event.detail; void loadPage(); }} />

<Modal bind:show={showEditor} title={editingExisting ? 'Correct Attendance Record' : 'Add Attendance Record'} width="650px" dismissDisabled={editorBusy}>
    <div class="attendance-editor">
        <div class="span-2"><CustomSelect label="Staff member" bind:value={editEmployeeId} options={editorEmployeeOptions} largeOptions /></div>
        <label><span>Clock in</span><input type="datetime-local" bind:value={editClockIn} /></label>
        <label><span>Clock out</span><input type="datetime-local" bind:value={editClockOut} /></label>
        <CustomSelect label="Clock-in till" bind:value={editClockInTillId} options={tillOptions} />
        <CustomSelect label="Clock-out till" bind:value={editClockOutTillId} options={tillOptions} />
        <label class="span-2"><span>Correction note</span><textarea rows="3" maxlength="500" bind:value={editNotes} placeholder="Optional reason or note"></textarea></label>
        <p class="span-2 editor-note">Every manual record and correction is written to the audit log.</p>
    </div>
    <svelte:fragment slot="footer">
        <button class="btn btn-secondary" disabled={editorBusy} on:click={() => (showEditor = false)}>Cancel</button>
        <button class="btn btn-primary" disabled={editorBusy || !editEmployeeId || !editClockIn || !editClockOut} on:click={saveEditor}>{editorBusy ? 'Saving…' : 'Save Record'}</button>
    </svelte:fragment>
</Modal>

<ConfirmDialog
    bind:show={showManagerClockOutConfirm}
    title="Clock Out Staff Member?"
    message={`Clock out ${managerClockOutRecord?.employeeName || 'this staff member'} now using this till? This manager action will be recorded in the audit log.`}
    confirmText="Clock Out"
    variant="danger"
    on:confirm={confirmManagerClockOut}
    on:cancel={() => (managerClockOutRecord = null)}
/>

<style>
    .attendance-page-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: .6rem; }
    .attendance-page-actions .btn { min-height: 48px; }
    .attendance-shell { height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
    .self-attendance { min-height: 82px; padding: .7rem 1rem; display: flex; align-items: center; gap: .8rem; border-bottom: 1px solid var(--border-flat); background: var(--bg-card); }
    .self-attendance.clocked-in { box-shadow: inset 4px 0 var(--success); }
    .self-avatar { width: 48px; height: 48px; flex: 0 0 48px; display: grid; place-items: center; color: white; border-radius: 50%; background: var(--accent-primary); font-size: .85rem; font-weight: 950; }
    .self-copy { min-width: 0; flex: 1; }
    .self-copy small, .self-copy strong, .self-copy span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .self-copy small { color: var(--text-muted); font-size: .66rem; font-weight: 900; text-transform: uppercase; }
    .self-copy strong { margin-top: .1rem; font-size: 1rem; }
    .self-copy span { margin-top: .14rem; color: var(--text-muted); font-size: .72rem; }
    .self-attendance > button { min-width: 126px; min-height: 52px; padding: .6rem 1rem; color: white; border: 1px solid var(--success); border-radius: .5rem; background: var(--success); font-weight: 950; }
    .self-attendance > button.clock-out { border-color: var(--danger); background: var(--danger); }
    .attendance-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border-bottom: 1px solid var(--border-flat); background: var(--border-flat); gap: 1px; }
    .attendance-summary article { min-width: 0; min-height: 64px; padding: .55rem .8rem; display: flex; flex-direction: column; justify-content: center; background: var(--bg-panel); }
    .attendance-summary span { overflow: hidden; color: var(--text-muted); font-size: .62rem; font-weight: 900; text-overflow: ellipsis; text-transform: uppercase; white-space: nowrap; }
    .attendance-summary strong { margin-top: .1rem; overflow: hidden; font-size: 1rem; text-overflow: ellipsis; white-space: nowrap; }
    .attendance-summary small { color: var(--text-muted); font-size: .65rem; }
    .attendance-filters { padding: .65rem; display: grid; grid-template-columns: minmax(150px, .8fr) minmax(140px, .65fr) 140px 140px minmax(220px, 1.4fr) auto; align-items: end; gap: .55rem; border-bottom: 1px solid var(--border-flat); background: var(--bg-panel); }
    .date-field, .attendance-editor label { min-width: 0; display: flex; flex-direction: column; gap: .35rem; }
    .date-field span, .attendance-editor label > span { color: var(--text-muted); font-size: .68rem; font-weight: 900; text-transform: uppercase; }
    .date-field input, .attendance-editor input, .attendance-editor textarea { width: 100%; min-height: 48px; padding: .65rem .75rem; color: var(--text-main); border: 1px solid var(--border-flat); border-radius: .5rem; background: var(--bg-card); }
    .attendance-search { min-width: 0; }
    .search-button { min-height: 48px; }
    .attendance-warning, .attendance-error { padding: .55rem .75rem; display: flex; align-items: center; justify-content: space-between; gap: .75rem; font-size: .74rem; font-weight: 750; }
    .attendance-warning { color: var(--warning); border-bottom: 1px solid color-mix(in srgb, var(--warning) 45%, var(--border-flat)); background: color-mix(in srgb, var(--warning) 8%, var(--bg-card)); }
    .attendance-error { color: var(--danger); border-bottom: 1px solid color-mix(in srgb, var(--danger) 45%, var(--border-flat)); background: color-mix(in srgb, var(--danger) 8%, var(--bg-card)); }
    .attendance-table-wrap { min-height: 0; flex: 1; overflow: auto; overscroll-behavior: contain; }
    .attendance-table { width: 100%; min-width: 760px; }
    .attendance-table th { position: sticky; top: 0; z-index: 2; }
    .attendance-table td { vertical-align: middle; }
    .attendance-table td strong, .attendance-table td small { display: block; }
    .attendance-table td small { max-width: 190px; margin-top: .12rem; overflow: hidden; color: var(--text-muted); font-size: .68rem; text-overflow: ellipsis; white-space: nowrap; }
    .open-row { box-shadow: inset 3px 0 var(--success); }
    .duration-cell { font-variant-numeric: tabular-nums; }
    .attendance-status { display: inline-flex; align-items: center; gap: .38rem; font-size: .72rem; font-weight: 900; white-space: nowrap; }
    .attendance-status i { width: .5rem; height: .5rem; border-radius: 50%; background: currentColor; }
    .attendance-status.open { color: var(--success); }
    .attendance-status.closed { color: var(--text-muted); }
    .action-heading { text-align: right; }
    .action-cell { width: 112px; text-align: right; }
    .edit-attendance { width: 44px !important; height: 44px !important; }
    .edit-attendance svg { width: 18px; height: 18px; }
    .manager-clock-out { min-width: 96px; min-height: 44px; padding: .5rem .7rem; white-space: nowrap; }
    .attendance-pagination { min-height: 58px; padding: .5rem .75rem; display: flex; align-items: center; justify-content: center; gap: .75rem; border-top: 1px solid var(--border-flat); background: var(--bg-panel); }
    .attendance-pagination span { color: var(--text-muted); font-size: .72rem; font-weight: 800; text-align: center; }
    .attendance-editor { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
    .attendance-editor .span-2 { grid-column: span 2; }
    .attendance-editor textarea { resize: vertical; }
    .editor-note { margin: 0; color: var(--text-muted); font-size: .72rem; }
    @media (max-width: 1100px) {
        .attendance-filters { grid-template-columns: repeat(4, minmax(0, 1fr)); }
        .attendance-search { grid-column: span 3; }
    }
    @media (min-width: 701px) and (max-width: 900px) {
        .attendance-summary article { padding-inline: .6rem; }
        .attendance-summary article:nth-child(4) strong { font-size: .82rem; letter-spacing: -.015em; }
        .attendance-table { min-width: 690px; table-layout: fixed; }
        .attendance-table th, .attendance-table td { padding-inline: .5rem; }
        .attendance-table th { font-size: .65rem; letter-spacing: .04em; }
        .attendance-table td { overflow: hidden; font-size: .74rem; }
        .attendance-table th:nth-child(1) { width: 16%; }
        .attendance-table th:nth-child(2), .attendance-table th:nth-child(3) { width: 15%; }
        .attendance-table th:nth-child(4) { width: 10%; }
        .attendance-table th:nth-child(5) { width: 13%; }
        .attendance-table th:nth-child(6) { width: 16%; }
        .attendance-table th:nth-child(7) { width: 15%; }
        .attendance-table td > strong, .attendance-table td > span { overflow: hidden; text-overflow: ellipsis; }
        .action-heading, .action-cell { text-align: center; }
        .manager-clock-out { min-width: 82px; padding-inline: .4rem; font-size: .68rem; }
    }
    @media (min-width: 701px) and (max-height: 680px) {
        .self-attendance { min-height: 70px; padding-block: .45rem; }
        .self-avatar { width: 42px; height: 42px; flex-basis: 42px; }
        .self-attendance > button { min-height: 48px; }
        .attendance-summary article { min-height: 54px; padding-block: .38rem; }
        .attendance-filters { padding: .45rem .55rem; }
    }
    @media (max-width: 700px) {
        .attendance-shell { height: auto; overflow: visible; }
        .attendance-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .attendance-filters { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .attendance-search { grid-column: span 2; }
        .attendance-table-wrap { overflow: auto; }
        .attendance-editor { grid-template-columns: 1fr; }
        .attendance-editor .span-2 { grid-column: span 1; }
    }
</style>
