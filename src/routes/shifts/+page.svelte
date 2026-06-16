<script lang="ts">
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import {
        shiftsDB, cashMovementsDB, ordersDB, paymentsDB, registersDB, settingsDB,
        formatMoney, getEmployeeName, now, type Shift
    } from '$lib/stores/db';
    import { closeShiftLocalFirst, triggerSync } from '$lib/stores/database';
    import { currentEmployee, currentShiftId, logout } from '$lib/stores/session';
    import { toast } from '$lib/stores/toast';
    import { goto } from '$app/navigation';

    let expandedId = '';
    let countedCash = '';
    let cardMachineTotal = '';
    let closingNotes = '';
    let isClosing = false;

    $: cashUpEnabled = ($settingsDB.find(s => s.key === 'cash_up_enabled')?.value ?? 'false') === 'true';
    $: reconcileCard = ($settingsDB.find(s => s.key === 'cash_up_reconcile_card')?.value ?? 'true') !== 'false';
    $: activeShift = $shiftsDB.find(s => s.id === $currentShiftId && s.status === 'open') || null;
    $: activeOrderCount = activeShift ? getShiftOrders(activeShift.id).length : 0;
    $: canClose = poundsToPence(countedCash) !== null && (!reconcileCard || poundsToPence(cardMachineTotal) !== null);

    function toggle(id: string) { expandedId = expandedId === id ? '' : id; }
    function getMovements(shiftId: string) { return $cashMovementsDB.filter(m => m.shiftId === shiftId); }
    function getShiftOrders(shiftId: string) {
        // Keep the original voided sale and its negative reversal together so
        // cash/card totals net to zero instead of subtracting the void twice.
        return $ordersDB.filter(o => o.shiftId === shiftId && o.status !== 'hold' && o.status !== 'open');
    }
    function getShiftPayments(shiftId: string) {
        const orderIds = new Set(getShiftOrders(shiftId).map(o => o.id));
        return $paymentsDB.filter(payment => orderIds.has(payment.orderId));
    }
    function shiftSales(shiftId: string) {
        return getShiftOrders(shiftId).reduce((sum, order) => sum + order.total, 0);
    }
    function cashPaymentTotal(shiftId: string) {
        return getShiftPayments(shiftId).reduce((sum, payment) => sum + (payment.cashAmount || 0), 0);
    }
    function cardPaymentTotal(shiftId: string) {
        return getShiftPayments(shiftId).reduce((sum, payment) => sum + (payment.cardAmount || 0), 0);
    }
    function cashMovementTotal(shiftId: string) {
        return getMovements(shiftId).reduce((sum, movement) => sum + movement.amount, 0);
    }
    function expectedCash(shift: Shift) {
        return (shift.openingFloat || 0) + cashPaymentTotal(shift.id) + cashMovementTotal(shift.id);
    }
    function registerName(registerId: string) {
        return $registersDB.find(register => register.id === registerId)?.name || registerId || 'Unknown till';
    }
    function poundsToPence(value: string | number): number | null {
        if (value === '' || value === null || value === undefined) return null;
        const amount = Number(value);
        return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) : null;
    }

    async function closeCurrentShift() {
        if (!activeShift || !$currentEmployee || isClosing) return;
        const actualCash = poundsToPence(countedCash);
        const actualCardInput = poundsToPence(cardMachineTotal);
        if (actualCash === null) {
            toast('Enter the counted cash before closing the shift', 'error');
            return;
        }
        if (reconcileCard && actualCardInput === null) {
            toast('Enter the card-machine total before closing the shift', 'error');
            return;
        }

        isClosing = true;
        try {
            const cashExpected = expectedCash(activeShift);
            const cardExpected = cardPaymentTotal(activeShift.id);
            const actualCard = reconcileCard ? actualCardInput! : cardExpected;
            const closed: Shift = {
                ...activeShift,
                closedByEmployeeId: $currentEmployee.id,
                closedAt: now(),
                expectedCash: cashExpected,
                actualCash,
                cashDifference: actualCash - cashExpected,
                expectedCard: cardExpected,
                actualCard,
                cardDifference: actualCard - cardExpected,
                status: 'closed',
                notes: closingNotes.trim(),
                updatedAt: now(),
            };
            await closeShiftLocalFirst(closed);
            void triggerSync();
            countedCash = '';
            cardMachineTotal = '';
            closingNotes = '';
            toast('Till shift closed. It will synchronize automatically.', 'success');
            logout();
            await goto('/');
        } catch (error) {
            toast(`Could not close shift: ${error}`, 'error');
        } finally {
            isClosing = false;
        }
    }
</script>

<MgmtPage title="Till Shifts & Cash-Up">
    {#if cashUpEnabled && activeShift}
        <section class="cash-up-panel">
            <div class="cash-up-heading">
                <div>
                    <span class="eyebrow">Current open shift</span>
                    <h2>{registerName(activeShift.registerId)} · {getEmployeeName(activeShift.employeeId)}</h2>
                    <p>Opened {new Date(activeShift.openedAt).toLocaleString('en-GB')}</p>
                </div>
                <div class="open-badge">
                    <i></i>
                    <span>Shift Open</span>
                </div>
            </div>

            <div class="shift-snapshot">
                <article>
                    <span>Opening Float</span>
                    <strong>{formatMoney(activeShift.openingFloat || 0)}</strong>
                    <small>Cash at the start</small>
                </article>
                <article>
                    <span>Transactions</span>
                    <strong>{activeOrderCount}</strong>
                    <small>Completed in this shift</small>
                </article>
                <article>
                    <span>Cashier</span>
                    <strong>{getEmployeeName(activeShift.employeeId)}</strong>
                    <small>Responsible for this shift</small>
                </article>
                <article>
                    <span>Till</span>
                    <strong>{registerName(activeShift.registerId)}</strong>
                    <small>Unique register identity</small>
                </article>
            </div>

            <div class="cash-up-workspace">
                <div class="count-guide">
                    <span class="step-number">1</span>
                    <div>
                        <h3>Count before viewing the expected totals</h3>
                        <p>Count the drawer and use the card-machine report. Differences are revealed only after closing.</p>
                    </div>
                </div>
                <div class="close-grid">
                    <label class="money-entry">
                        <span>Counted cash</span>
                        <div><b>£</b><input type="number" min="0" step="0.01" bind:value={countedCash} placeholder="0.00" /></div>
                        <button type="button" on:click={() => countedCash = '0'}>No cash in drawer</button>
                    </label>
                    {#if reconcileCard}
                        <label class="money-entry">
                            <span>Card-machine total</span>
                            <div><b>£</b><input type="number" min="0" step="0.01" bind:value={cardMachineTotal} placeholder="0.00" /></div>
                            <button type="button" on:click={() => cardMachineTotal = '0'}>No card payments</button>
                        </label>
                    {/if}
                    <label class="notes-field">
                        <span>Closing notes <small>Optional</small></span>
                        <input bind:value={closingNotes} placeholder="Explain anything unusual for the manager" />
                    </label>
                    <button class="close-button" disabled={isClosing || !canClose} on:click={closeCurrentShift}>
                        <span class="step-number">2</span>
                        <span><strong>{isClosing ? 'Closing Shift…' : 'Close Shift'}</strong><small>Save count and show differences</small></span>
                        <b>→</b>
                    </button>
                    {#if !canClose}
                        <p class="close-help">
                            Enter the counted cash{reconcileCard ? ' and card-machine total' : ''} to activate Close Shift.
                        </p>
                    {/if}
                </div>
            </div>
        </section>
    {:else if !cashUpEnabled}
        <div class="feature-off">
            <strong>Till cash-up is disabled.</strong>
            <span>Shifts continue recording transactions automatically. Enable Till Cash-Up in Settings when you want opening and closing counts.</span>
        </div>
    {/if}

    {#if $currentEmployee?.role === 'admin'}
    <section class="history-panel">
        <div class="history-heading">
            <div><span class="eyebrow">Audit history</span><h2>Previous Till Shifts</h2></div>
            <span>{$shiftsDB.length} shifts</span>
        </div>
    <div class="table-wrap">
        <table class="tbl">
            <thead><tr><th>Till</th><th>Cashier</th><th>Opened</th><th>Closed</th><th>Status</th><th>Sales</th><th>Cash Difference</th><th>Card Difference</th></tr></thead>
            <tbody>
                {#each $shiftsDB.slice().sort((a, b) => b.openedAt.localeCompare(a.openedAt)) as shift}
                <tr on:click={() => toggle(shift.id)} class="cursor-pointer">
                    <td class="font-semibold">{registerName(shift.registerId)}</td>
                    <td>{getEmployeeName(shift.employeeId)}</td>
                    <td>{new Date(shift.openedAt).toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}</td>
                    <td>{shift.closedAt ? new Date(shift.closedAt).toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}) : '-'}</td>
                    <td><span class="tag {shift.status === 'open' ? 'text-success' : 'text-text-muted'}">{shift.status}</span></td>
                    <td class="money">{formatMoney(shiftSales(shift.id))}</td>
                    <td class:difference-bad={(shift.cashDifference || 0) !== 0}>{shift.status === 'closed' ? formatMoney(shift.cashDifference || 0) : '-'}</td>
                    <td class:difference-bad={(shift.cardDifference || 0) !== 0}>{shift.status === 'closed' ? formatMoney(shift.cardDifference || 0) : '-'}</td>
                </tr>
                {#if expandedId === shift.id}
                <tr><td colspan="8" class="!p-0">
                    <div class="shift-details">
                        <div>
                            <h4>Cash Summary</h4>
                            <p><span>Opening Float</span><b>{formatMoney(shift.openingFloat || 0)}</b></p>
                            <p><span>Cash Payments</span><b>{formatMoney(cashPaymentTotal(shift.id))}</b></p>
                            <p><span>Cash Movements</span><b>{formatMoney(cashMovementTotal(shift.id))}</b></p>
                            <p><span>Expected Cash</span><b>{shift.status === 'closed' ? formatMoney(shift.expectedCash || 0) : 'Shown after close'}</b></p>
                            <p><span>Counted Cash</span><b>{shift.status === 'closed' ? formatMoney(shift.actualCash || 0) : '-'}</b></p>
                        </div>
                        <div>
                            <h4>Card Summary</h4>
                            <p><span>Expected Card</span><b>{shift.status === 'closed' ? formatMoney(shift.expectedCard || 0) : 'Shown after close'}</b></p>
                            <p><span>Card Machine</span><b>{shift.status === 'closed' ? formatMoney(shift.actualCard || 0) : '-'}</b></p>
                            <p><span>Difference</span><b>{shift.status === 'closed' ? formatMoney(shift.cardDifference || 0) : '-'}</b></p>
                        </div>
                        <div>
                            <h4>Activity</h4>
                            <p><span>Orders</span><b>{getShiftOrders(shift.id).length}</b></p>
                            <p><span>Total Sales</span><b>{formatMoney(shiftSales(shift.id))}</b></p>
                            <p><span>Closed By</span><b>{shift.closedByEmployeeId ? getEmployeeName(shift.closedByEmployeeId) : '-'}</b></p>
                            {#if shift.notes}<p><span>Notes</span><b>{shift.notes}</b></p>{/if}
                        </div>
                    </div>
                </td></tr>
                {/if}
                {/each}
                {#if $shiftsDB.length === 0}<tr class="empty-row"><td colspan="8">No shifts recorded yet.</td></tr>{/if}
            </tbody>
        </table>
    </div>
    </section>
    {/if}
</MgmtPage>

<style>
    .cash-up-panel { margin: 1rem; padding: 1.2rem; border: 1px solid color-mix(in srgb, var(--accent-primary) 55%, var(--border-flat)); border-radius: 1rem; background: linear-gradient(145deg, color-mix(in srgb, var(--accent-primary) 10%, var(--bg-card)), var(--bg-card)); box-shadow: 0 16px 35px color-mix(in srgb, var(--shadow) 22%, transparent); }
    .cash-up-heading { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
    .eyebrow { color: var(--accent-primary); font-size: .68rem; font-weight: 900; letter-spacing: .14em; text-transform: uppercase; }
    .cash-up-heading h2 { margin: .2rem 0; font-size: 1.35rem; }
    .cash-up-heading p { margin: 0; color: var(--text-muted); font-size: .85rem; }
    .open-badge { padding: .55rem .8rem; display: flex; align-items: center; gap: .5rem; color: var(--success); font-size: .78rem; font-weight: 900; border: 1px solid color-mix(in srgb, var(--success) 45%, var(--border-flat)); border-radius: 999px; background: color-mix(in srgb, var(--success) 9%, var(--bg-panel)); }
    .open-badge i { width: .55rem; height: .55rem; border-radius: 100%; background: var(--success); box-shadow: 0 0 8px var(--success); }
    .shift-snapshot { margin-top: 1rem; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: .65rem; }
    .shift-snapshot article { min-width: 0; padding: .85rem; display: flex; flex-direction: column; gap: .15rem; border: 1px solid var(--border-flat); border-radius: .75rem; background: color-mix(in srgb, var(--bg-panel) 88%, transparent); }
    .shift-snapshot span { color: var(--text-muted); font-size: .7rem; font-weight: 800; text-transform: uppercase; }
    .shift-snapshot strong { overflow: hidden; font-size: clamp(1rem, 2vw, 1.35rem); text-overflow: ellipsis; white-space: nowrap; }
    .shift-snapshot small { color: var(--text-muted); font-size: .68rem; }
    .cash-up-workspace { margin-top: .8rem; padding: 1rem; border: 1px solid var(--border-flat); border-radius: .8rem; background: var(--bg-panel); }
    .count-guide { margin-bottom: .8rem; display: flex; align-items: center; gap: .75rem; }
    .count-guide h3 { margin: 0; font-size: 1rem; }
    .count-guide p { margin: .15rem 0 0; color: var(--text-muted); font-size: .78rem; }
    .step-number { width: 2rem; height: 2rem; flex: 0 0 2rem; display: grid; place-items: center; color: white; border-radius: .55rem; background: var(--accent-primary); }
    .feature-off { margin: 1rem; padding: .8rem 1rem; color: var(--text-muted); border: 1px solid var(--border-flat); border-radius: .65rem; background: var(--bg-panel); }
    .feature-off { display: flex; flex-direction: column; gap: .2rem; }
    .feature-off strong { color: var(--text-main); }
    .close-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .75rem; }
    .close-grid label { display: flex; flex-direction: column; gap: .35rem; }
    .close-grid label span { font-size: .78rem; font-weight: 800; color: var(--text-muted); }
    .money-entry > div { min-height: 58px; padding: 0 .8rem; display: flex; align-items: center; gap: .45rem; border: 2px solid var(--border-flat); border-radius: .7rem; background: var(--bg-card); }
    .money-entry > div:focus-within { border-color: var(--accent-primary); }
    .money-entry > div b { color: var(--success); font-size: 1.25rem; }
    .money-entry > div input { width: 100%; min-width: 0; padding: 0; font-size: 1.4rem; font-weight: 900; border: 0; background: transparent; }
    .money-entry button { align-self: flex-start; padding: .2rem 0; color: var(--accent-primary); font-size: .72rem; font-weight: 800; background: transparent; }
    .close-grid input { min-height: 48px; }
    .notes-field { grid-column: span 2; }
    .notes-field span { display: flex; gap: .4rem; }
    .notes-field small { font-weight: 500; }
    .close-button { grid-column: span 2; min-height: 64px; padding: .7rem 1rem; display: flex; align-items: center; gap: .75rem; color: white; text-align: left; border: 0; border-radius: .75rem; background: var(--accent-primary); }
    .close-button > span:nth-child(2) { display: flex; flex: 1; flex-direction: column; }
    .close-button small { opacity: .75; }
    .close-button > b { font-size: 1.5rem; }
    .close-button:disabled { opacity: .35; }
    .close-help { grid-column: span 2; margin: -.25rem 0 0; color: var(--warning); font-size: .75rem; font-weight: 700; }
    .history-panel { margin: 0 1rem 1rem; overflow: hidden; border: 1px solid var(--border-flat); border-radius: .9rem; background: var(--bg-panel); }
    .history-heading { padding: .9rem 1rem; display: flex; align-items: center; justify-content: space-between; gap: 1rem; border-bottom: 1px solid var(--border-flat); }
    .history-heading h2 { margin: .15rem 0 0; font-size: 1.05rem; }
    .history-heading > span { color: var(--text-muted); font-size: .78rem; }
    .table-wrap { overflow-x: auto; }
    .difference-bad { color: var(--danger); font-weight: 800; }
    .shift-details { padding: 1rem 1.25rem; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1rem; background: var(--bg-base); }
    .shift-details > div { padding: .9rem; border: 1px solid var(--border-flat); border-radius: .7rem; background: var(--bg-panel); }
    .shift-details h4 { margin: 0 0 .55rem; color: var(--accent-primary); }
    .shift-details p { margin: 0; padding: .25rem 0; display: flex; justify-content: space-between; gap: 1rem; font-size: .85rem; }
    .shift-details p span { color: var(--text-muted); }
    .shift-details p b { text-align: right; }
    @media (max-width: 850px) {
        .cash-up-heading { align-items: stretch; flex-direction: column; }
        .open-badge { align-self: flex-start; }
        .shift-snapshot { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .close-grid, .shift-details { grid-template-columns: 1fr; }
        .notes-field, .close-button, .close-help { grid-column: span 1; }
    }
    @media (max-height: 720px) {
        .cash-up-panel { margin: .6rem; padding: .8rem; }
        .history-panel { margin: 0 .6rem .6rem; }
        .shift-snapshot { margin-top: .65rem; }
        .shift-snapshot article { padding: .55rem .7rem; }
        .cash-up-workspace { margin-top: .6rem; padding: .7rem; }
        .money-entry > div { min-height: 48px; }
        .close-button { min-height: 54px; }
    }
</style>
