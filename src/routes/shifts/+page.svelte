<script lang="ts">
    import { isTauri } from '@tauri-apps/api/core';
    import { onDestroy, onMount } from 'svelte';
    import { goto } from '$app/navigation';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import CustomSelect from '$lib/components/CustomSelect.svelte';
    import { formatMoney, now, settingsDB, type Shift } from '$lib/stores/db';
    import {
        closeShiftLocalFirst,
        getShiftsPage,
        getShiftSummary,
        triggerSync,
    } from '$lib/stores/database';
    import { currentEmployee, currentShiftId, logout } from '$lib/stores/session';
    import { toast } from '$lib/stores/toast';
    import { hasPermission } from '$lib/permissions';

    type ShiftSummaryRow = Shift & {
        cashierName?: string;
        closedByName?: string;
        tillName?: string;
        orderCount?: number;
        salesTotal?: number;
        cashPayments?: number;
        cardPayments?: number;
        cashMovements?: number;
    };

    const PAGE_SIZE = 20;
    const statusOptions = [
        { value: 'all', label: 'All sessions' },
        { value: 'open', label: 'Open sessions' },
        { value: 'closed', label: 'Closed sessions' },
    ];

    let expandedId = '';
    let countedCash = '';
    let cardMachineTotal = '';
    let closingNotes = '';
    let isClosing = false;
    let activeShift: ShiftSummaryRow | null = null;
    let activeShiftRun = 0;
    let activeShiftKey = '';

    let searchQuery = '';
    let appliedSearchQuery = '';
    let statusFilter = 'all';
    let page = 0;
    let previousFilterKey = '';
    let previousQueryKey = '';
    let shifts: ShiftSummaryRow[] = [];
    let shiftsTotal = 0;
    let overallTotal = 0;
    let shiftsLoading = false;
    let shiftsLoadError = '';
    let shiftsRun = 0;
    let shiftsMounted = false;
    let shiftsLoadTimer: ReturnType<typeof setTimeout> | null = null;

    $: cashUpEnabled = ($settingsDB.find(setting => setting.key === 'cash_up_enabled')?.value ?? 'false') === 'true';
    $: reconcileCard = ($settingsDB.find(setting => setting.key === 'cash_up_reconcile_card')?.value ?? 'true') !== 'false';
    $: canViewShiftHistory = hasPermission($currentEmployee, 'open_reports', $settingsDB);
    $: activeOrderCount = Number(activeShift?.orderCount || 0);
    $: canClose = poundsToPence(countedCash) !== null && (!reconcileCard || poundsToPence(cardMachineTotal) !== null);
    $: pageCount = Math.max(1, Math.ceil(shiftsTotal / PAGE_SIZE));
    $: if (page >= pageCount) page = pageCount - 1;

    $: {
        const filterKey = `${appliedSearchQuery}|${statusFilter}`;
        if (filterKey !== previousFilterKey) {
            previousFilterKey = filterKey;
            page = 0;
            expandedId = '';
        }
    }

    $: {
        const queryKey = `${previousFilterKey}|${page}`;
        if (shiftsMounted && canViewShiftHistory && queryKey !== previousQueryKey) {
            previousQueryKey = queryKey;
            scheduleShiftsLoad();
        }
    }

    $: if (shiftsMounted && $currentShiftId !== activeShiftKey) {
        activeShiftKey = $currentShiftId;
        void loadActiveShift(activeShiftKey);
    }

    onMount(() => {
        shiftsMounted = true;
        activeShiftKey = $currentShiftId;
        previousFilterKey = `${appliedSearchQuery}|${statusFilter}`;
        previousQueryKey = `${previousFilterKey}|${page}`;
        if (canViewShiftHistory) void loadShiftsPage();
        void loadActiveShift(activeShiftKey);
    });

    onDestroy(() => {
        shiftsMounted = false;
        shiftsRun += 1;
        activeShiftRun += 1;
        if (shiftsLoadTimer) clearTimeout(shiftsLoadTimer);
    });

    function scheduleShiftsLoad(delay = 0) {
        if (shiftsLoadTimer) clearTimeout(shiftsLoadTimer);
        shiftsLoadTimer = setTimeout(() => {
            shiftsLoadTimer = null;
            void loadShiftsPage();
        }, delay);
    }

    async function loadShiftsPage() {
        if (!canViewShiftHistory) return;
        const run = ++shiftsRun;
        shiftsLoading = true;
        shiftsLoadError = '';
        try {
            const result = await getShiftsPage({
                query: appliedSearchQuery,
                status: statusFilter,
                limit: PAGE_SIZE,
                offset: page * PAGE_SIZE,
            });
            if (run !== shiftsRun) return;
            shifts = result.rows as ShiftSummaryRow[];
            shiftsTotal = result.total;
            overallTotal = result.overallTotal;
        } catch (error) {
            if (run !== shiftsRun) return;
            shifts = [];
            shiftsTotal = 0;
            overallTotal = 0;
            if (isTauri()) {
                console.warn('shifts: page lookup failed:', error);
                shiftsLoadError = 'Session history is temporarily unavailable.';
            }
        } finally {
            if (run === shiftsRun) shiftsLoading = false;
        }
    }

    async function loadActiveShift(id: string) {
        const run = ++activeShiftRun;
        if (!id) {
            activeShift = null;
            return;
        }
        try {
            const result = await getShiftSummary(id);
            if (run === activeShiftRun) activeShift = result as ShiftSummaryRow | null;
        } catch (error) {
            if (isTauri()) console.warn('shifts: active session lookup failed:', error);
            if (run === activeShiftRun) activeShift = null;
        }
    }

    function runSearch() {
        const nextQuery = searchQuery.trim();
        if (nextQuery === appliedSearchQuery && page === 0) {
            scheduleShiftsLoad();
            return;
        }
        appliedSearchQuery = nextQuery;
        page = 0;
    }

    function handleSearchKeydown(event: KeyboardEvent) {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        runSearch();
    }

    function clearFilters() {
        searchQuery = '';
        appliedSearchQuery = '';
        statusFilter = 'all';
        page = 0;
    }

    function toggle(id: string) {
        expandedId = expandedId === id ? '' : id;
    }

    function money(value: unknown): number {
        const amount = Number(value || 0);
        return Number.isFinite(amount) ? amount : 0;
    }

    function expectedCash(shift: ShiftSummaryRow): number {
        return money(shift.openingFloat) + money(shift.cashPayments) + money(shift.cashMovements);
    }

    function formatDate(value: string, includeYear = false): string {
        if (!value) return '-';
        const date = new Date(value);
        if (!Number.isFinite(date.getTime())) return '-';
        return date.toLocaleString('en-GB', {
            day: '2-digit',
            month: 'short',
            ...(includeYear ? { year: '2-digit' as const } : {}),
            hour: '2-digit',
            minute: '2-digit',
        });
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
            const cardExpected = money(activeShift.cardPayments);
            const actualCard = reconcileCard ? actualCardInput! : cardExpected;
            const closed: Shift = {
                id: activeShift.id,
                registerId: activeShift.registerId,
                employeeId: activeShift.employeeId,
                closedByEmployeeId: $currentEmployee.id,
                openedAt: activeShift.openedAt,
                closedAt: now(),
                openingFloat: money(activeShift.openingFloat),
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
            toast('Till session closed. It will synchronize automatically.', 'success');
            logout();
            await goto('/');
        } catch (error) {
            toast(`Could not close session: ${error}`, 'error');
        } finally {
            isClosing = false;
        }
    }
</script>

<MgmtPage title="Cash-up Sessions">
    {#if cashUpEnabled && activeShift}
        <section class="cash-up-panel">
            <div class="cash-up-heading">
                <div>
                    <span class="eyebrow">Current session</span>
                    <h2>{activeShift.tillName || activeShift.registerId} · {activeShift.cashierName || activeShift.employeeId}</h2>
                    <p>Opened {formatDate(activeShift.openedAt, true)}</p>
                </div>
                <div class="open-badge"><i></i><span>Open</span></div>
            </div>

            <div class="shift-snapshot">
                <article><span>Opening Float</span><strong>{formatMoney(money(activeShift.openingFloat))}</strong><small>Cash at start</small></article>
                <article><span>Transactions</span><strong>{activeOrderCount}</strong><small>Completed sales</small></article>
                <article><span>Cashier</span><strong>{activeShift.cashierName || activeShift.employeeId}</strong><small>Signed-in operator</small></article>
                <article><span>Till</span><strong>{activeShift.tillName || activeShift.registerId}</strong><small>Register identity</small></article>
            </div>

            <div class="cash-up-workspace">
                <div class="count-guide">
                    <span class="step-number">1</span>
                    <div><h3>Count before viewing expected totals</h3><p>Count the drawer and use the card-machine report. Differences appear after closing.</p></div>
                </div>
                <div class="close-grid">
                    <label class="money-entry">
                        <span>Counted cash</span>
                        <div><b>£</b><input aria-label="Counted cash" type="number" min="0" step="0.01" bind:value={countedCash} placeholder="0.00" /></div>
                        <button type="button" on:click={() => countedCash = '0'}>No cash</button>
                    </label>
                    {#if reconcileCard}
                        <label class="money-entry">
                            <span>Card-machine total</span>
                            <div><b>£</b><input aria-label="Card-machine total" type="number" min="0" step="0.01" bind:value={cardMachineTotal} placeholder="0.00" /></div>
                            <button type="button" on:click={() => cardMachineTotal = '0'}>No card payments</button>
                        </label>
                    {/if}
                    <label class="notes-field">
                        <span>Closing notes <small>Optional</small></span>
                        <input aria-label="Closing notes" bind:value={closingNotes} placeholder="Explain anything unusual" />
                    </label>
                    <button class="close-button" disabled={isClosing || !canClose} on:click={closeCurrentShift}>
                        <span class="step-number">2</span>
                        <span><strong>{isClosing ? 'Closing Session...' : 'Close Session'}</strong><small>Save counts and show differences</small></span>
                    </button>
                    {#if !canClose}<p class="close-help">Enter the counted cash{reconcileCard ? ' and card-machine total' : ''} to activate closing.</p>{/if}
                </div>
            </div>
        </section>
    {:else if !cashUpEnabled}
        <div class="feature-off"><strong>Till cash-up is disabled.</strong><span>Sessions still record transactions. Enable Till Cash-Up in Settings to use opening and closing counts.</span></div>
    {:else}
        <div class="feature-off"><strong>No open till session.</strong><span>Sign in and open a till session from the POS before using cash-up.</span></div>
    {/if}

    {#if canViewShiftHistory}
        <section class="history-panel">
            <div class="history-heading">
                <div class="history-title"><span class="eyebrow">Audit history</span><h2>Previous Cash-ups</h2></div>
                <div class="history-controls">
                    <input
                        class="search-input"
                        aria-label="Search sessions"
                        value={searchQuery}
                        on:input={(event) => searchQuery = event.currentTarget.value}
                        on:keydown={handleSearchKeydown}
                        placeholder="Till, cashier, date, or note..."
                    />
                    <button class="btn btn-secondary" on:click={runSearch}>Find</button>
                    <div class="status-filter"><CustomSelect bind:value={statusFilter} options={statusOptions} /></div>
                    <span class="result-count">{shiftsLoading ? 'Loading...' : `${shiftsTotal} / ${overallTotal}`}</span>
                    {#if searchQuery || appliedSearchQuery || statusFilter !== 'all'}<button class="btn btn-secondary clear-button" on:click={clearFilters}>Clear</button>{/if}
                </div>
            </div>

            {#if shiftsLoadError}
                <div class="load-error"><span>Could not load sessions: {shiftsLoadError}</span><button class="btn btn-secondary" on:click={loadShiftsPage}>Retry</button></div>
            {/if}

            <div class="table-wrap">
                <table class="tbl shift-table">
                    <thead><tr><th>Till</th><th>Cashier</th><th>Session</th><th>Status</th><th>Sales</th><th>Variance</th></tr></thead>
                    <tbody>
                        {#each shifts as shift}
                            <tr>
                                <td>
                                    <button class="session-toggle" aria-expanded={expandedId === shift.id} aria-label={`${expandedId === shift.id ? 'Hide' : 'View'} details for ${shift.tillName || shift.registerId}`} on:click={() => toggle(shift.id)}>
                                        <span>{expandedId === shift.id ? '-' : '+'}</span>{shift.tillName || shift.registerId || 'Unknown till'}
                                    </button>
                                </td>
                                <td>{shift.cashierName || shift.employeeId || 'Unknown'}</td>
                                <td><strong>{formatDate(shift.openedAt, true)}</strong><small>{shift.closedAt ? `Closed ${formatDate(shift.closedAt, true)}` : 'Still open'}</small></td>
                                <td><span class="tag {shift.status === 'open' ? 'text-success' : 'text-text-muted'}">{shift.status}</span></td>
                                <td class="money"><strong>{formatMoney(money(shift.salesTotal))}</strong><small>{money(shift.orderCount)} orders</small></td>
                                <td>
                                    {#if shift.status === 'closed'}
                                        <strong class:difference-bad={money(shift.cashDifference) !== 0}>Cash {formatMoney(money(shift.cashDifference))}</strong>
                                        <small class:difference-bad={money(shift.cardDifference) !== 0}>Card {formatMoney(money(shift.cardDifference))}</small>
                                    {:else}<span class="text-text-muted">Pending close</span>{/if}
                                </td>
                            </tr>
                            {#if expandedId === shift.id}
                                <tr><td colspan="6" class="details-cell">
                                    <div class="shift-details">
                                        <div><h4>Cash</h4><p><span>Opening Float</span><b>{formatMoney(money(shift.openingFloat))}</b></p><p><span>Cash Payments</span><b>{formatMoney(money(shift.cashPayments))}</b></p><p><span>Cash Movements</span><b>{formatMoney(money(shift.cashMovements))}</b></p><p><span>Expected</span><b>{shift.status === 'closed' ? formatMoney(money(shift.expectedCash)) : 'After close'}</b></p><p><span>Counted</span><b>{shift.status === 'closed' ? formatMoney(money(shift.actualCash)) : '-'}</b></p></div>
                                        <div><h4>Card</h4><p><span>Expected</span><b>{shift.status === 'closed' ? formatMoney(money(shift.expectedCard)) : 'After close'}</b></p><p><span>Machine</span><b>{shift.status === 'closed' ? formatMoney(money(shift.actualCard)) : '-'}</b></p><p><span>Difference</span><b>{shift.status === 'closed' ? formatMoney(money(shift.cardDifference)) : '-'}</b></p></div>
                                        <div><h4>Activity</h4><p><span>Orders</span><b>{money(shift.orderCount)}</b></p><p><span>Total Sales</span><b>{formatMoney(money(shift.salesTotal))}</b></p><p><span>Closed By</span><b>{shift.closedByName || '-'}</b></p>{#if shift.notes}<p><span>Notes</span><b>{shift.notes}</b></p>{/if}</div>
                                    </div>
                                </td></tr>
                            {/if}
                        {/each}
                        {#if shiftsLoading && shifts.length === 0}<tr class="empty-row"><td colspan="6">Loading sessions...</td></tr>{/if}
                        {#if !shiftsLoading && !shiftsLoadError && overallTotal === 0}<tr class="empty-row"><td colspan="6">No till sessions recorded yet.</td></tr>{/if}
                        {#if !shiftsLoading && !shiftsLoadError && overallTotal > 0 && shiftsTotal === 0}<tr class="empty-row"><td colspan="6">No sessions match your filters.</td></tr>{/if}
                    </tbody>
                </table>
            </div>

            {#if shiftsTotal > PAGE_SIZE}
                <div class="pagination"><button class="btn btn-secondary" disabled={page === 0} on:click={() => page--}>Newer</button><span>Page {page + 1} of {pageCount} · {page * PAGE_SIZE + 1}-{Math.min((page + 1) * PAGE_SIZE, shiftsTotal)} of {shiftsTotal}</span><button class="btn btn-secondary" disabled={page >= pageCount - 1} on:click={() => page++}>Older</button></div>
            {/if}
        </section>
    {/if}
</MgmtPage>

<style>
    .cash-up-panel { padding: 1rem 1.25rem 1.15rem; border-bottom: 1px solid var(--border-flat); background: var(--bg-card); }
    .cash-up-heading { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
    .eyebrow { color: var(--accent-primary); font-size: .68rem; font-weight: 900; letter-spacing: .1em; text-transform: uppercase; }
    .cash-up-heading h2 { margin: .15rem 0; font-size: 1.25rem; }
    .cash-up-heading p { margin: 0; color: var(--text-muted); font-size: .8rem; }
    .open-badge { padding: .45rem .7rem; display: flex; align-items: center; gap: .45rem; color: var(--success); font-size: .76rem; font-weight: 900; border: 1px solid rgba(16,185,129,.45); border-radius: .45rem; background: rgba(16,185,129,.09); }
    .open-badge i { width: .5rem; height: .5rem; border-radius: 100%; background: var(--success); }
    .shift-snapshot { margin-top: .85rem; display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); border-block: 1px solid var(--border-flat); }
    .shift-snapshot article { min-width: 0; padding: .75rem .9rem; display: flex; flex-direction: column; gap: .1rem; border-right: 1px solid var(--border-flat); }
    .shift-snapshot article:last-child { border-right: 0; }
    .shift-snapshot span { color: var(--text-muted); font-size: .68rem; font-weight: 800; text-transform: uppercase; }
    .shift-snapshot strong { overflow: hidden; font-size: 1.15rem; text-overflow: ellipsis; white-space: nowrap; }
    .shift-snapshot small { color: var(--text-muted); font-size: .67rem; }
    .cash-up-workspace { padding-top: .85rem; }
    .count-guide { margin-bottom: .7rem; display: flex; align-items: center; gap: .7rem; }
    .count-guide h3 { margin: 0; font-size: .95rem; }
    .count-guide p { margin: .1rem 0 0; color: var(--text-muted); font-size: .76rem; }
    .step-number { width: 1.8rem; height: 1.8rem; flex: 0 0 1.8rem; display: grid; place-items: center; color: white; border-radius: .4rem; background: var(--accent-primary); }
    .close-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: .65rem; }
    .close-grid label { display: flex; flex-direction: column; gap: .3rem; }
    .close-grid label > span { color: var(--text-muted); font-size: .76rem; font-weight: 800; }
    .money-entry > div { min-height: 50px; padding: 0 .75rem; display: flex; align-items: center; gap: .4rem; border: 1px solid var(--border-flat); border-radius: .45rem; background: var(--bg-panel); }
    .money-entry > div:focus-within { border-color: var(--accent-primary); }
    .money-entry > div b { color: var(--success); font-size: 1.15rem; }
    .money-entry > div input { width: 100%; min-width: 0; padding: 0; font-size: 1.25rem; font-weight: 900; border: 0; background: transparent; }
    .money-entry button { align-self: flex-start; padding: .2rem 0; color: var(--accent-primary); font-size: .72rem; font-weight: 800; background: transparent; }
    .notes-field { grid-column: span 2; }
    .notes-field > span { display: flex; gap: .35rem; }
    .notes-field input { min-height: 44px; }
    .notes-field small { font-weight: 500; }
    .close-button { grid-column: span 2; min-height: 56px; padding: .65rem .9rem; display: flex; align-items: center; gap: .7rem; color: white; text-align: left; border: 0; border-radius: .45rem; background: var(--accent-primary); }
    .close-button > span:nth-child(2) { display: flex; flex-direction: column; }
    .close-button small { opacity: .78; }
    .close-button:disabled { opacity: .35; }
    .close-help { grid-column: span 2; margin: -.2rem 0 0; color: var(--warning); font-size: .73rem; font-weight: 700; }
    .feature-off { padding: .8rem 1.25rem; display: flex; flex-direction: column; gap: .15rem; color: var(--text-muted); border-bottom: 1px solid var(--border-flat); background: var(--bg-panel); }
    .feature-off strong { color: var(--text-main); }
    .history-panel { min-width: 0; }
    .history-heading { padding: .75rem 1rem; display: flex; align-items: center; gap: 1rem; border-bottom: 1px solid var(--border-flat); background: var(--bg-panel); }
    .history-title { min-width: 150px; }
    .history-title h2 { margin: .1rem 0 0; font-size: 1rem; }
    .history-controls { min-width: 0; flex: 1; display: flex; align-items: center; justify-content: flex-end; gap: .55rem; }
    .history-controls .search-input { min-width: 190px; max-width: 360px; height: 42px; min-height: 42px; flex: 1; }
    .history-controls .btn { min-height: 42px; height: 42px; padding-inline: .8rem; }
    .status-filter { width: 170px; }
    .result-count { min-width: 74px; text-align: center; color: var(--text-muted); font-size: .76rem; font-weight: 800; }
    .clear-button { font-size: .76rem; }
    .load-error { padding: .65rem 1rem; display: flex; align-items: center; justify-content: space-between; gap: 1rem; color: var(--danger); border-bottom: 1px solid var(--danger); background: rgba(239,68,68,.08); }
    .table-wrap { overflow-x: auto; }
    .shift-table { min-width: 820px; }
    .shift-table td > strong, .shift-table td > small, .shift-table .money strong, .shift-table .money small { display: block; }
    .shift-table td small { margin-top: .15rem; color: var(--text-muted); font-size: .7rem; }
    .session-toggle { min-height: 38px; max-width: 180px; display: flex; align-items: center; gap: .5rem; color: var(--text-main); font-weight: 800; text-align: left; background: transparent; }
    .session-toggle > span { width: 1.7rem; height: 1.7rem; flex: 0 0 1.7rem; display: grid; place-items: center; color: var(--accent-primary); border: 1px solid var(--border-flat); border-radius: .35rem; background: var(--bg-card); }
    .difference-bad { color: var(--danger) !important; font-weight: 800; }
    .details-cell { padding: 0 !important; }
    .shift-details { padding: .85rem 1rem; display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 1rem; background: var(--bg-base); }
    .shift-details > div { min-width: 0; padding-right: 1rem; border-right: 1px solid var(--border-flat); }
    .shift-details > div:last-child { padding-right: 0; border-right: 0; }
    .shift-details h4 { margin: 0 0 .4rem; color: var(--accent-primary); font-size: .85rem; }
    .shift-details p { margin: 0; padding: .2rem 0; display: flex; justify-content: space-between; gap: .75rem; font-size: .8rem; }
    .shift-details p span { color: var(--text-muted); }
    .shift-details p b { overflow-wrap: anywhere; text-align: right; }
    .pagination { padding: .75rem 1rem; display: flex; align-items: center; justify-content: space-between; gap: 1rem; color: var(--text-muted); border-top: 1px solid var(--border-flat); background: var(--bg-panel); font-size: .8rem; font-weight: 700; }
    @media (max-width: 900px) {
        .history-heading { align-items: stretch; flex-direction: column; }
        .history-controls { justify-content: stretch; }
        .history-controls .search-input { max-width: none; }
    }
    @media (max-width: 700px) {
        .cash-up-heading { align-items: stretch; flex-direction: column; }
        .open-badge { align-self: flex-start; }
        .shift-snapshot { grid-template-columns: repeat(2,minmax(0,1fr)); }
        .shift-snapshot article:nth-child(2) { border-right: 0; }
        .shift-snapshot article:nth-child(-n+2) { border-bottom: 1px solid var(--border-flat); }
        .close-grid, .shift-details { grid-template-columns: 1fr; }
        .notes-field, .close-button, .close-help { grid-column: span 1; }
        .history-controls { flex-wrap: wrap; }
        .history-controls .search-input { flex-basis: 100%; }
        .status-filter { flex: 1; }
        .shift-details > div { padding: 0 0 .7rem; border-right: 0; border-bottom: 1px solid var(--border-flat); }
        .shift-details > div:last-child { padding-bottom: 0; border-bottom: 0; }
    }
</style>
