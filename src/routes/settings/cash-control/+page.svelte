<script lang="ts">
    import { isTauri } from '@tauri-apps/api/core';
    import { onMount, onDestroy } from 'svelte';
    import { LockKeyhole, ShieldCheck, Banknote } from '@lucide/svelte';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import CustomSelect from '$lib/components/CustomSelect.svelte';
    import TouchDigitPad from '$lib/components/TouchDigitPad.svelte';
    import { deviceOperatingMode } from '$lib/deviceMode';
    import { currentEmployee } from '$lib/stores/session';
    import { formatMoney, registersDB, settingsDB } from '$lib/stores/db';
    import { getOrCreateTillId, getTillName } from '$lib/stores/database';
    import { connectionState } from '$lib/stores/connection';
    import { canAccessPath } from '$lib/permissions';
    import {
        cashControlPeriod, cashControlSourceIdentity, cashCountPence, cashVarianceLabel, latestCashControlEntry,
        loadCashControl, localBusinessDate, saveCashControl,
        type CashControlContext, type CashControlEntry,
    } from '$lib/cashControl';

    let native = false;
    let tillId = '';
    let thisTillId = '';
    let thisTillName = '';
    let businessDate = localBusinessDate();
    let pin = '';
    let savePin = '';
    let savePinPadOpen = false;
    let openingCash = '';
    let countedCash = '';
    let reason = '';
    let context: CashControlContext | null = null;
    let editing = false;
    let busy = false;
    let error = '';
    let status = '';
    let actorId = '';
    let unlockedSource = '';
    let requestVersion = 0;
    let disposed = false;
    let lastActivityAt = 0;
    let expiryTimer: ReturnType<typeof setInterval> | undefined;
    // Preserve this id after an ambiguous save response so a retry cannot duplicate a count.
    let pendingRequestId = '';
    let pendingRequestSignature = '';

    $: allowed = canAccessPath($currentEmployee, '/settings/cash-control', $settingsDB);
    $: latest = context ? latestCashControlEntry(context.entries) : null;
    $: history = context ? [...context.entries].sort((a, b) => b.revision - a.revision) : [];
    $: tillOptions = Array.from(new Map([
        ...(thisTillId ? [{ value: thisTillId, label: thisTillName || 'This till' }] : []),
        ...$registersDB.map(register => ({ value: register.id, label: register.name || register.id })),
    ].map(option => [option.value, option])).values());
    $: if (context && (!allowed || $currentEmployee?.id !== actorId ||
        context.tillId !== tillId || context.businessDate !== businessDate ||
        unlockedSource !== cashControlSourceIdentity($connectionState) ||
        ($connectionState.mode === 'multi' && (!$connectionState.mysqlOnline || !$connectionState.mysqlReady)))) {
        lock('Cash Control locked. Verify your PIN again to continue.');
    }
    $: canSave = Boolean(context && (latest ? editing : context.canCreate)
        && cashCountPence(openingCash) !== null && cashCountPence(countedCash) !== null
        && savePin.trim() && reason.trim().length >= 3);

    function activity() { lastActivityAt = Date.now(); }

    function lock(message = '') {
        requestVersion += 1;
        context = null;
        pin = '';
        savePin = '';
        savePinPadOpen = false;
        openingCash = '';
        countedCash = '';
        reason = '';
        editing = false;
        actorId = '';
        unlockedSource = '';
        error = '';
        status = message;
        busy = false;
        pendingRequestId = '';
        pendingRequestSignature = '';
        if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('close-touch-keyboard'));
    }

    function visibilityChanged() {
        if (document.hidden && (context || busy)) lock('Cash Control locked while the app was away. Unlock to check whether a submitted count finished saving.');
    }

    function windowBlurred() {
        if (context || busy) lock('Cash Control locked when the app lost focus. Unlock to check any submitted count.');
    }

    function problem(value: unknown): string {
        return String(value).replace(/^Error:\s*/, '');
    }

    function displayDate(value: string): string {
        const parsed = new Date(value);
        return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString('en-GB') : value;
    }

    async function unlock() {
        if (!allowed || busy || !pin.trim()) return;
        const run = ++requestVersion;
        const employeeId = $currentEmployee!.id;
        const source = cashControlSourceIdentity($connectionState);
        const suppliedPin = pin;
        pin = '';
        busy = true;
        error = '';
        status = '';
        try {
            const result = await loadCashControl(cashControlPeriod(tillId, businessDate), employeeId, suppliedPin);
            if (run !== requestVersion || document.hidden || $currentEmployee?.id !== employeeId || source !== cashControlSourceIdentity($connectionState)) return;
            context = result;
            actorId = employeeId;
            unlockedSource = source;
            activity();
            const existing = latestCashControlEntry(result.entries);
            openingCash = existing ? (existing.openingFloatAmount / 100).toFixed(2) : '';
            countedCash = '';
            reason = existing ? '' : 'End-of-day cash count';
            editing = false;
        } catch (err) {
            if (run === requestVersion) error = problem(err);
        } finally {
            if (run === requestVersion) busy = false;
        }
    }

    function startCorrection(entry: CashControlEntry) {
        activity();
        editing = true;
        openingCash = (entry.openingFloatAmount / 100).toFixed(2);
        countedCash = (entry.countedAmount / 100).toFixed(2);
        reason = '';
        savePin = '';
        error = '';
        status = '';
        pendingRequestId = '';
    }

    async function submitCount() {
        if (!allowed || busy || !canSave || !context) return;
        const run = ++requestVersion;
        const employeeId = $currentEmployee!.id;
        const request = {
            ...cashControlPeriod(tillId, businessDate),
            openingFloatAmount: cashCountPence(openingCash)!,
            countedAmount: cashCountPence(countedCash)!,
            reason: reason.trim(),
            previousEntryId: latest?.id || null,
        };
        const signature = JSON.stringify(request);
        if (!pendingRequestId || pendingRequestSignature !== signature) {
            pendingRequestId = crypto.randomUUID();
            pendingRequestSignature = signature;
        }
        const suppliedPin = savePin;
        savePin = '';
        savePinPadOpen = false;
        busy = true;
        error = '';
        status = '';
        try {
            const entry = await saveCashControl({ ...request, id: pendingRequestId }, employeeId, suppliedPin);
            if (run !== requestVersion || !context || $currentEmployee?.id !== employeeId) return;
            context = { ...context, entries: [...context.entries.filter(row => row.id !== entry.id), entry], canCreate: false };
            editing = false;
            reason = '';
            pendingRequestId = '';
            pendingRequestSignature = '';
            status = entry.revision > 1 ? 'Private correction saved. Original count retained; sales and Z reports unchanged.'
                : 'Private cash count saved. Sales and Z reports unchanged.';
            activity();
            document.dispatchEvent(new CustomEvent('close-touch-keyboard'));
        } catch (err) {
            if (run === requestVersion) error = problem(err);
        } finally {
            if (run === requestVersion) busy = false;
        }
    }

    onMount(async () => {
        native = isTauri();
        if (!native || !allowed) return;
        try {
            [thisTillId, thisTillName] = await Promise.all([getOrCreateTillId(), getTillName()]);
            if (disposed) return;
            tillId = thisTillId;
        } catch (err) { error = problem(err); }
        if (disposed) return;
        expiryTimer = setInterval(() => {
            if (context && !busy && Date.now() - lastActivityAt >= 5 * 60_000) lock('Cash Control locked after 5 minutes of inactivity.');
        }, 15_000);
    });

    onDestroy(() => {
        disposed = true;
        requestVersion += 1;
        if (expiryTimer) clearInterval(expiryTimer);
        context = null;
        pin = '';
        savePin = '';
    });
</script>

<svelte:head><title>Private Cash Control</title></svelte:head>
<svelte:window on:keydown={activity} on:pointerdown={activity} on:blur={windowBlurred} />
<svelte:document on:visibilitychange={visibilityChanged} />

<MgmtPage title="Cash Control" eyebrow="Private · Administrator" backFallback="/settings?section=Administration">
    <svelte:fragment slot="actions">
        {#if context}<button class="btn btn-secondary" disabled={busy} on:click={() => lock()}><LockKeyhole size={17} /> Lock</button>{/if}
    </svelte:fragment>
    <div class="cash-control-page">
        {#if !allowed}
            <section class="cash-card"><h2>Administrator access required</h2><p>This private feature is unavailable to this staff account.</p></section>
        {:else if !native}
            <section class="cash-card"><h2>Open the installed Tauri app</h2><p>Private cash counts are protected by native PIN verification. They cannot be opened or changed in browser preview.</p></section>
        {:else}
            <section class="privacy-notice"><ShieldCheck size={21} /><div><strong>Private reconciliation, not a sales adjustment</strong><p>Counts, differences and corrections stay here. They never change or appear on sales reports, receipts, Z reports or the owner dashboard.</p></div></section>
            <section class="cash-card scope-card">
                <div class="scope-title"><Banknote size={22} /><div><h2>Choose the cash drawer</h2><p>One daily count per till. Any correction keeps the original.</p></div></div>
                <div class="scope-fields">
                    <div class="field"><CustomSelect bind:value={tillId} options={tillOptions} label="Till" disabled={busy || Boolean(context)} /></div>
                    <label class="field"><span>Business date</span><input type="date" bind:value={businessDate} max={localBusinessDate()} disabled={busy || Boolean(context)} /><small>Uses this computer’s local timezone.</small></label>
                    {#if context}<button class="btn btn-secondary" disabled={busy} on:click={() => lock()}>Change till / date</button>{/if}
                </div>
            </section>

            {#if status}<p class="status-message" role="status">{status}</p>{/if}
            {#if error}<div class="error-message" role="alert">{error}</div>{/if}

            {#if !context}
                <form class="cash-card unlock-card" on:submit|preventDefault={unlock}>
                    <LockKeyhole size={25} />
                    <h2>Unlock private cash counts</h2>
                    <p>Verify your administrator PIN. Access locks again when you leave or after five minutes without activity.</p>
                    <label class="field"><span>Administrator PIN</span><input type="password" inputmode="numeric" autocomplete="off" maxlength="12" data-touch-keyboard="off" bind:value={pin} disabled={busy} /></label>
                    {#if $deviceOperatingMode !== 'back_office'}
                        <TouchDigitPad bind:value={pin} masked placeholder="Enter PIN" maxLength={12} disabled={busy} submitDisabled={!pin || !tillId} submitLabel={busy ? 'Verifying…' : 'Unlock Cash Control'} onSubmit={unlock} />
                    {:else}
                        <button class="btn btn-primary" type="submit" disabled={busy || !pin || !tillId}>{busy ? 'Verifying…' : 'Unlock Cash Control'}</button>
                    {/if}
                </form>
            {:else}
                <div class="source-line"><span>{context.source === 'shared' ? 'Shared MariaDB · private ledger' : 'This computer · private ledger'}</span><span>Verified as {$currentEmployee?.name}</span></div>
                {#if context.blockedReason}<p class="warning-message">{context.blockedReason}</p>{/if}
                {#if !latest || editing}
                    <form class="cash-card count-card" on:submit|preventDefault={submitCount}>
                        <div><h2>{editing ? 'Correct the declared count' : 'Count first, compare afterwards'}</h2><p>{editing ? 'The saved cash-flow snapshot stays unchanged. Enter the corrected count and explain why.' : 'Count the physical drawer, including the opening float. Expected cash is revealed only after saving.'}</p></div>
                        <div class="money-fields">
                            <label class="field"><span>Opening cash / float (£)</span><input type="text" inputmode="decimal" placeholder="0.00" maxlength="12" bind:value={openingCash} disabled={busy || (!latest && !context.canCreate)} /><small>Cash already in the drawer at the start of this date.</small></label>
                            <label class="field"><span>Cash physically counted (£)</span><input type="text" inputmode="decimal" placeholder="0.00" maxlength="12" bind:value={countedCash} disabled={busy || (!latest && !context.canCreate)} /><small>Include notes and coins. Enter 0 if genuinely empty.</small></label>
                        </div>
                        <label class="field"><span>{editing ? 'Reason for correction (required)' : 'Private note (required)'}</span><textarea rows="2" maxlength="500" bind:value={reason} placeholder={editing ? 'Explain the counting mistake or float correction' : 'For example, end-of-day cash count'} disabled={busy}></textarea><small>At least 3 characters. Saved only in private Cash Control history.</small></label>
                        <p class="warning-message"><strong>Count only after this till has finished trading and syncing.</strong> For today, the snapshot ends when you save: later sales are not added, even if you correct the count. This does not close a till or its Z-report period. Cash removed must already be recorded as a cash movement.</p>
                        <div class="save-row"><label class="field"><span>Re-enter administrator PIN to save</span><input type="password" inputmode="numeric" autocomplete="off" maxlength="12" data-touch-keyboard="off" bind:value={savePin} disabled={busy} /></label>
                            <button class="btn btn-primary" type="submit" disabled={busy || !canSave}>{busy ? 'Saving…' : editing ? 'Save private correction' : 'Save private count'}</button>
                            {#if editing}<button class="btn btn-secondary" type="button" disabled={busy} on:click={() => { editing = false; savePin = ''; error = ''; }}>Cancel</button>{/if}
                        </div>
                        {#if $deviceOperatingMode !== 'back_office'}
                            <details class="save-pin-pad" bind:open={savePinPadOpen}><summary>Touch PIN pad</summary>
                                <TouchDigitPad bind:value={savePin} masked placeholder="Enter PIN" maxLength={12} disabled={busy} submitDisabled={!canSave} submitLabel={editing ? 'Save private correction' : 'Save private count'} onSubmit={submitCount} />
                            </details>
                        {/if}
                    </form>
                {/if}

                {#if latest && !editing}
                    <section class="cash-card">
                        <div class="result-heading"><div><h2>Saved private count</h2><p>Revision {latest.revision} · {displayDate(latest.createdAt)} · {latest.employeeName}</p></div><button class="btn btn-secondary" on:click={() => startCorrection(latest!)}>Correct count</button></div>
                        <div class="result-grid">
                            <article><span>Expected cash</span><strong>{formatMoney(latest.expectedAmount)}</strong></article>
                            <article><span>Counted cash</span><strong>{formatMoney(latest.countedAmount)}</strong></article>
                            <article class:short={latest.varianceAmount < 0}><span>{cashVarianceLabel(latest.varianceAmount)}</span><strong>{formatMoney(Math.abs(latest.varianceAmount))}</strong></article>
                        </div>
                        <details class="calculation"><summary>How expected cash was calculated</summary><dl>
                            <div><dt>Opening float</dt><dd>{formatMoney(latest.openingFloatAmount)}</dd></div>
                            <div><dt>Cash sales, net of cash refunds</dt><dd>{formatMoney(latest.cashSalesAmount)}</dd></div>
                            <div><dt>Cash customer-account repayments</dt><dd>{formatMoney(latest.accountCashAmount)}</dd></div>
                            <div><dt>Cash paid in / taken out</dt><dd>{formatMoney(latest.cashMovementAmount)}</dd></div>
                            <div><dt>Cashback paid out</dt><dd>−{formatMoney(latest.cashbackAmount)}</dd></div>
                        </dl><p>Cash flow from {displayDate(latest.periodStart)} to {displayDate(latest.periodEnd)}. Corrections retain this original snapshot.</p></details>
                        {#if latest.reason}<p class="private-note">{latest.reason}</p>{/if}
                    </section>
                {/if}

                {#if history.length}
                    <section class="cash-card"><h2>Private history for this day</h2><p>Original entries are never overwritten. This history is kept when sales history is deleted.</p>
                        <div class="history-list">{#each history as entry (entry.id)}<article class="history-entry"><div><strong>{entry.revision === 1 ? 'Original count' : `Correction ${entry.revision - 1}`}</strong><small>{displayDate(entry.createdAt)} · {entry.employeeName}</small><p>{entry.reason || 'No note'}</p></div><div class="history-money"><strong>{formatMoney(entry.countedAmount)}</strong><small>{cashVarianceLabel(entry.varianceAmount)} {formatMoney(Math.abs(entry.varianceAmount))}</small></div></article>{/each}</div>
                    </section>
                {/if}
                <p class="backup-note">{context.source === 'shared' ? 'These private records live in MariaDB. Back up MariaDB to protect them; a local till-cache backup does not include this shared ledger.' : 'These private records are included in a full local database backup.'} Switching database mode does not automatically transfer private counts. Anyone with direct database-administrator access can still read database records.</p>
            {/if}
        {/if}
    </div>
</MgmtPage>

<style>
    .cash-control-page { height: 100%; overflow-y: auto; padding: clamp(.8rem, 2vw, 1.5rem); display: flex; flex-direction: column; gap: 1rem; }
    .cash-card { flex-shrink: 0; min-width: 0; padding: 1.15rem; border: 1px solid var(--border-flat); border-radius: .8rem; background: var(--bg-panel); }
    h2 { margin: 0; font-size: 1.08rem; line-height: 1.4; font-weight: 800; }
    p { margin: .4rem 0 0; color: var(--text-muted); font-size: .875rem; line-height: 1.5; }
    .privacy-notice { display: flex; gap: .75rem; align-items: flex-start; padding: 1rem; background: var(--bg-card); border: 1px solid var(--border-flat); border-radius: .8rem; }
    .privacy-notice :global(svg) { flex-shrink: 0; color: var(--accent-primary); }
    .privacy-notice strong { font-size: .92rem; }
    .scope-title { display: flex; gap: .7rem; align-items: center; margin-bottom: 1rem; }
    .scope-title :global(svg) { color: var(--accent-primary); }
    .scope-fields, .money-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
    .scope-fields > button { align-self: end; }
    .field { display: flex; flex-direction: column; min-width: 0; gap: .4rem; }
    .field > span { font-size: .82rem; font-weight: 750; }
    input, textarea { width: 100%; min-width: 0; border: 1px solid var(--border-flat); border-radius: .6rem; background: var(--bg-input, var(--bg-card)); color: var(--text-main); padding: .7rem .8rem; font-size: 1rem; min-height: 46px; }
    input:focus, textarea:focus { outline: 2px solid var(--accent-primary); outline-offset: 2px; }
    input:disabled, textarea:disabled { opacity: .65; }
    small { font-size: .76rem; line-height: 1.4; color: var(--text-muted); }
    .unlock-card { width: min(100%, 420px); align-self: center; display: grid; gap: .85rem; }
    .unlock-card > :global(svg) { color: var(--accent-primary); }
    .count-card { display: grid; gap: 1rem; }
    .source-line, .result-heading { display: flex; align-items: center; justify-content: space-between; gap: .75rem; flex-wrap: wrap; }
    .source-line { color: var(--text-muted); font-size: .77rem; }
    .save-row { display: flex; align-items: flex-end; gap: .75rem; flex-wrap: wrap; }
    .save-row > .field { flex: 1 1 220px; }
    .btn { display: inline-flex; align-items: center; justify-content: center; gap: .4rem; min-height: 46px; white-space: normal; }
    .status-message, .error-message, .warning-message { padding: .8rem 1rem; border: 1px solid var(--border-flat); border-radius: .6rem; line-height: 1.5; margin: 0; overflow-wrap: anywhere; }
    .status-message { background: var(--bg-card); color: var(--accent-primary); }
    .error-message { color: var(--danger, #b83c40); }
    .warning-message { background: var(--bg-card); font-size: .8rem; }
    .result-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .75rem; margin: 1rem 0; }
    .result-grid article { display: flex; flex-direction: column; gap: .35rem; border: 1px solid var(--border-flat); background: var(--bg-card); border-radius: .65rem; padding: 1rem; }
    .result-grid span { color: var(--text-muted); font-size: .8rem; }
    .result-grid strong { font-size: clamp(1.1rem, 2vw, 1.5rem); overflow-wrap: anywhere; }
    .short strong { color: var(--danger, #b83c40); }
    summary { cursor: pointer; font-weight: 700; font-size: .875rem; }
    dl { display: grid; gap: .5rem; margin: 1rem 0; }
    dl > div { display: flex; justify-content: space-between; gap: 1rem; font-size: .84rem; }
    dd { margin: 0; font-weight: 700; white-space: nowrap; }
    .private-note { padding: .8rem; background: var(--bg-card); border-radius: .5rem; white-space: pre-wrap; overflow-wrap: anywhere; }
    .history-list { margin-top: .75rem; }
    .history-entry { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; padding: .8rem 0; border-top: 1px solid var(--border-flat); }
    .history-entry > div:first-child { min-width: 0; overflow-wrap: anywhere; }
    .history-entry strong, .history-entry small { display: block; }
    .history-entry strong { font-size: .85rem; }
    .history-money { text-align: right; flex-shrink: 0; }
    .backup-note { font-size: .75rem; padding: 0 .3rem 1rem; }
    .save-pin-pad { max-width: 360px; width: 100%; }
    .save-pin-pad > summary { margin-bottom: .75rem; }
    @media (max-width: 620px) {
        .scope-fields, .money-fields { grid-template-columns: 1fr; }
        .result-grid { gap: .4rem; }
        .result-grid article { padding: .7rem .5rem; }
        .cash-card { padding: .9rem; }
    }
</style>
