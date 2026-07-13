<script lang="ts">
    import { onMount } from 'svelte';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import CustomSelect from '$lib/components/CustomSelect.svelte';
    import { employeesDB, type AuditLog } from '$lib/stores/db';
    import { getAuditLogPage, getRecentManagerApprovals } from '$lib/stores/database';
    import { toast } from '$lib/stores/toast';

    let logs: AuditLog[] = [];
    let loading = true;
    let loadError = '';
    let approvalsLoading = true;
    let approvalError = '';
    let query = '';
    let appliedQuery = '';
    let actionFilter = '';
    let entityFilter = '';
    let expandedId = '';
    let approvals: any[] = [];
    let actions: string[] = [];
    let entities: string[] = [];
    let page = 1;
    const pageSize = 25;
    let total = 0;
    let mounted = false;
    let filterKey = '';
    let loadKey = '';
    let loadTimer: ReturnType<typeof setTimeout> | null = null;
    let loadRun = 0;

    $: actionOptions = [{ label: 'All actions', value: '' }, ...actions.map((action) => ({ label: humanize(action), value: action }))];
    $: entityOptions = [{ label: 'All record types', value: '' }, ...entities.map((entity) => ({ label: humanize(entity), value: entity }))];
    $: employeeById = new Map($employeesDB.map((employee) => [employee.id, employee.name]));
    $: totalPages = Math.max(1, Math.ceil(total / pageSize));
    $: showingFrom = total === 0 ? 0 : (page - 1) * pageSize + 1;
    $: showingTo = Math.min(total, page * pageSize);
    $: currentFilterKey = `${appliedQuery}|${actionFilter}|${entityFilter}`;
    $: if (mounted && currentFilterKey !== filterKey) {
        filterKey = currentFilterKey;
        if (page !== 1) page = 1;
    }
    $: currentLoadKey = `${appliedQuery}|${actionFilter}|${entityFilter}|${page}`;
    $: if (mounted && currentLoadKey !== loadKey) {
        loadKey = currentLoadKey;
        scheduleLoad();
    }

    function scheduleLoad() {
        if (loadTimer) clearTimeout(loadTimer);
        loadTimer = setTimeout(loadAuditPage, 0);
    }

    async function loadAuditPage() {
        const run = ++loadRun;
        loading = true;
        loadError = '';
        try {
            const result = await getAuditLogPage({
                query: appliedQuery,
                action: actionFilter,
                entityType: entityFilter,
                limit: pageSize,
                offset: (page - 1) * pageSize,
            });
            if (run !== loadRun) return;
            logs = result.rows;
            total = result.total;
            actions = result.actions;
            entities = result.entities;
            expandedId = '';
            const lastPage = Math.max(1, Math.ceil(result.total / pageSize));
            if (page > lastPage) page = lastPage;
        } catch (error) {
            if (run !== loadRun) return;
            logs = [];
            total = 0;
            loadError = `Could not load the audit log: ${error}`;
            toast(`Could not load audit log: ${error}`, 'error');
        } finally {
            if (run === loadRun) loading = false;
        }
    }

    async function loadApprovals() {
        approvalsLoading = true;
        approvalError = '';
        try {
            approvals = await getRecentManagerApprovals(25);
        } catch (error) {
            approvals = [];
            approvalError = `Could not load manager approvals: ${error}`;
            toast(`Could not load manager approvals: ${error}`, 'error');
        } finally {
            approvalsLoading = false;
        }
    }

    async function refreshAll() {
        await Promise.all([loadAuditPage(), loadApprovals()]);
    }

    function goToPage(nextPage: number) {
        page = Math.min(totalPages, Math.max(1, nextPage));
    }

    function runSearch() {
        const nextQuery = query.trim();
        if (nextQuery === appliedQuery) {
            void loadAuditPage();
            return;
        }
        appliedQuery = nextQuery;
    }

    function handleSearchKeydown(event: KeyboardEvent) {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        runSearch();
    }

    function prettyJson(value: string) {
        if (!value) return '';
        try { return JSON.stringify(JSON.parse(value), null, 2); }
        catch { return value; }
    }

    function humanize(value: string) {
        return String(value || 'record')
            .replace(/[_-]+/g, ' ')
            .replace(/\b\w/g, (letter) => letter.toUpperCase());
    }

    function employeeName(employeeId: string) {
        if (!employeeId) return 'System';
        return employeeById.get(employeeId) || 'Unknown employee';
    }

    function formatDate(value: string) {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? 'Unknown time' : date.toLocaleString('en-GB');
    }

    function actionTone(action: string) {
        if (/(deleted|deactivated|voided|refunded|logout)/i.test(action)) return 'danger';
        if (/(created|completed|login|approved)/i.test(action)) return 'success';
        return 'neutral';
    }

    onMount(() => {
        mounted = true;
        filterKey = currentFilterKey;
        loadKey = currentLoadKey;
        refreshAll();
        return () => {
            mounted = false;
            loadRun += 1;
            if (loadTimer) clearTimeout(loadTimer);
        };
    });
</script>

<MgmtPage title="Audit Log">
    <button slot="actions" class="btn btn-secondary" disabled={loading || approvalsLoading} on:click={refreshAll}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"></path><path d="M20 4v7h-7"></path></svg>
        Refresh
    </button>

    <div class="audit-page">
        <section class="audit-filter-panel">
            <div class="audit-filter-heading">
                <div>
                    <span>Recorded activity</span>
                    <strong>{total.toLocaleString()} event{total === 1 ? '' : 's'}</strong>
                </div>
                <small>Changes, staff access, sales and manager approvals</small>
            </div>
            <div class="audit-filter-grid">
                <div class="field">
                    <label for="audit-search">Find Activity</label>
                    <div class="audit-search-control">
                        <input id="audit-search" bind:value={query} on:keydown={handleSearchKeydown} placeholder="Employee, action, receipt, item or record ID" />
                        <button class="btn btn-primary" disabled={loading} on:click={runSearch}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-4-4"></path></svg>
                            Find
                        </button>
                    </div>
                </div>
                <div class="field">
                    <CustomSelect label="Action" bind:value={actionFilter} options={actionOptions} />
                </div>
                <div class="field">
                    <CustomSelect label="Record Type" bind:value={entityFilter} options={entityOptions} />
                </div>
            </div>
        </section>

        <section class="audit-activity-panel">
            <div class="audit-section-header">
                <div>
                    <h2>Activity</h2>
                    <span>Showing {showingFrom}-{showingTo} of {total}</span>
                </div>
                <div class="audit-pager" aria-label="Audit log pages">
                    <button class="audit-icon-button" title="First page" aria-label="First page" disabled={loading || page <= 1} on:click={() => goToPage(1)}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 6 12 12l6 6M6 5v14"></path></svg>
                    </button>
                    <button class="audit-icon-button" title="Previous page" aria-label="Previous page" disabled={loading || page <= 1} on:click={() => goToPage(page - 1)}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m15 18-6-6 6-6"></path></svg>
                    </button>
                    <strong>Page {page} / {totalPages}</strong>
                    <button class="audit-icon-button" title="Next page" aria-label="Next page" disabled={loading || page >= totalPages} on:click={() => goToPage(page + 1)}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg>
                    </button>
                </div>
            </div>

            {#if loadError}
                <div class="audit-error" role="alert">
                    <span>{loadError}</span>
                    <button class="btn btn-secondary" on:click={loadAuditPage}>Try Again</button>
                </div>
            {:else if loading}
                <div class="audit-empty">Loading audit log...</div>
            {:else if logs.length === 0}
                <div class="audit-empty">No audit records match these filters.</div>
            {:else}
                <div class="audit-event-list">
                    {#each logs as log}
                        <article class="audit-event" class:expanded={expandedId === log.id}>
                            <button
                                type="button"
                                class="audit-event-toggle"
                                aria-expanded={expandedId === log.id}
                                on:click={() => expandedId = expandedId === log.id ? '' : log.id}
                            >
                                <span class="audit-action-dot audit-action-{actionTone(log.action)}"></span>
                                <span class="audit-event-main">
                                    <strong>{humanize(log.action)}</strong>
                                    <small>
                                        {humanize(log.entityType || 'record')}
                                        <span title={log.entityId || ''}>{log.entityId || 'No record ID'}</span>
                                    </small>
                                </span>
                                <span class="audit-event-person">{employeeName(log.employeeId)}</span>
                                <time datetime={log.createdAt}>{formatDate(log.createdAt)}</time>
                                <svg class="audit-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg>
                            </button>
                            {#if expandedId === log.id}
                                <div class="audit-details">
                                    <div>
                                        <span>Before</span>
                                        <pre>{prettyJson(log.oldData) || 'No previous data'}</pre>
                                    </div>
                                    <div>
                                        <span>After</span>
                                        <pre>{prettyJson(log.newData) || 'No new data'}</pre>
                                    </div>
                                </div>
                            {/if}
                        </article>
                    {/each}
                </div>
                <div class="audit-bottom-pager">
                    <button class="btn btn-secondary" disabled={page <= 1} on:click={() => goToPage(page - 1)}>Previous</button>
                    <span>Page {page} of {totalPages}</span>
                    <button class="btn btn-secondary" disabled={page >= totalPages} on:click={() => goToPage(page + 1)}>Next</button>
                </div>
            {/if}
        </section>

        <section class="audit-approvals-panel">
            <div class="audit-section-header">
                <div>
                    <h2>Manager Approvals</h2>
                    <span>Latest {approvals.length} approval{approvals.length === 1 ? '' : 's'}</span>
                </div>
            </div>
            {#if approvalError}
                <div class="audit-error" role="alert">
                    <span>{approvalError}</span>
                    <button class="btn btn-secondary" on:click={loadApprovals}>Try Again</button>
                </div>
            {:else if approvalsLoading}
                <div class="audit-empty compact">Loading approvals...</div>
            {:else if approvals.length === 0}
                <div class="audit-empty compact">No manager approvals recorded yet.</div>
            {:else}
                <div class="audit-approval-list">
                    {#each approvals as approval}
                        <article>
                            <span class="audit-action-dot audit-action-success"></span>
                            <div>
                                <strong>{humanize(approval.action)}</strong>
                                <p>{approval.notes || humanize(approval.entityType || 'Approval')}</p>
                                <small>Requested by {employeeName(approval.requestedByEmployeeId)} · Approved by {employeeName(approval.approvedByEmployeeId)}</small>
                            </div>
                            <time datetime={approval.createdAt}>{formatDate(approval.createdAt)}</time>
                        </article>
                    {/each}
                </div>
            {/if}
        </section>
    </div>
</MgmtPage>

<style>
    .audit-page { height: 100%; overflow-y: auto; padding: 1rem; display: flex; flex-direction: column; gap: 1rem; }
    .audit-filter-panel, .audit-activity-panel, .audit-approvals-panel { border: 1px solid var(--border-flat); border-radius: .5rem; background: var(--bg-card); }
    .audit-filter-panel { padding: .85rem; display: grid; grid-template-columns: minmax(190px, .55fr) minmax(0, 1.45fr); align-items: end; gap: 1rem; }
    .audit-filter-heading { min-width: 0; display: flex; flex-direction: column; gap: .18rem; }
    .audit-filter-heading div { display: flex; align-items: baseline; gap: .45rem; }
    .audit-filter-heading span { color: var(--accent-primary); font-size: .68rem; font-weight: 900; letter-spacing: .08em; text-transform: uppercase; }
    .audit-filter-heading strong { color: var(--text-main); font-size: 1.05rem; }
    .audit-filter-heading small { color: var(--text-muted); font-size: .76rem; line-height: 1.25; }
    .audit-filter-grid { min-width: 0; display: grid; grid-template-columns: minmax(220px, 1fr) minmax(150px, .55fr) minmax(150px, .55fr); gap: .65rem; }
    .audit-search-control { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .45rem; }
    .audit-search-control .btn { min-height: 48px; }
    .audit-section-header { min-height: 64px; padding: .75rem .9rem; display: flex; align-items: center; justify-content: space-between; gap: 1rem; border-bottom: 1px solid var(--border-flat); }
    .audit-section-header h2 { margin: 0; font-size: 1.05rem; }
    .audit-section-header span { color: var(--text-muted); font-size: .78rem; }
    .audit-pager { display: flex; align-items: center; gap: .4rem; }
    .audit-pager > strong { min-width: 86px; color: var(--text-muted); font-size: .76rem; text-align: center; }
    .audit-icon-button { width: 38px; height: 38px; display: grid; place-items: center; color: var(--text-main); border: 1px solid var(--border-flat); border-radius: .4rem; background: var(--bg-panel); }
    .audit-icon-button svg { width: 17px; height: 17px; }
    .audit-icon-button:disabled { cursor: not-allowed; opacity: .35; }
    .audit-event-list { display: flex; flex-direction: column; }
    .audit-event { border-bottom: 1px solid var(--border-flat); background: var(--bg-panel); }
    .audit-event:last-child { border-bottom: 0; }
    .audit-event.expanded { background: var(--bg-card); }
    .audit-event-toggle { width: 100%; min-height: 58px; padding: .65rem .8rem; display: grid; grid-template-columns: 10px minmax(180px, 1fr) minmax(100px, .42fr) auto 24px; align-items: center; gap: .7rem; color: var(--text-main); text-align: left; }
    .audit-event-toggle:hover { background: var(--bg-card-hover); }
    .audit-action-dot { width: 8px; height: 8px; display: block; border-radius: 50%; background: var(--text-muted); }
    .audit-action-success { background: var(--success); }
    .audit-action-danger { background: var(--danger); }
    .audit-action-neutral { background: var(--accent-primary); }
    .audit-event-main { min-width: 0; display: flex; flex-direction: column; gap: .15rem; }
    .audit-event-main > strong { overflow: hidden; font-size: .85rem; text-overflow: ellipsis; white-space: nowrap; }
    .audit-event-main > small { min-width: 0; display: flex; gap: .4rem; color: var(--text-muted); font-size: .7rem; }
    .audit-event-main > small span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .audit-event-person { overflow: hidden; color: var(--text-muted); font-size: .76rem; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
    .audit-event-toggle time, .audit-approval-list time { color: var(--text-muted); font-size: .7rem; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .audit-chevron { width: 18px; height: 18px; color: var(--text-muted); transform: rotate(0deg); }
    .audit-event.expanded .audit-chevron { transform: rotate(90deg); }
    .audit-details { padding: 0 .8rem .8rem 1.75rem; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .7rem; }
    .audit-details > div > span { color: var(--text-muted); font-size: .65rem; font-weight: 900; letter-spacing: .1em; text-transform: uppercase; }
    .audit-details pre { min-height: 84px; max-height: 260px; margin: .35rem 0 0; padding: .65rem; overflow: auto; color: var(--text-main); border: 1px solid var(--border-flat); border-radius: .4rem; background: var(--bg-panel); font-family: ui-monospace, monospace; font-size: .69rem; line-height: 1.35; white-space: pre-wrap; overflow-wrap: anywhere; }
    .audit-bottom-pager { padding: .75rem; display: flex; align-items: center; justify-content: flex-end; gap: .65rem; border-top: 1px solid var(--border-flat); }
    .audit-bottom-pager span { color: var(--text-muted); font-size: .75rem; font-weight: 800; }
    .audit-error { margin: .75rem; padding: .65rem; display: flex; align-items: center; justify-content: space-between; gap: .75rem; color: var(--danger); border: 1px solid rgba(239, 68, 68, .45); border-radius: .4rem; background: rgba(239, 68, 68, .10); font-size: .78rem; }
    .audit-empty { min-height: 150px; display: grid; place-items: center; color: var(--text-muted); font-size: .82rem; text-align: center; }
    .audit-empty.compact { min-height: 88px; }
    .audit-approval-list { display: flex; flex-direction: column; }
    .audit-approval-list article { min-height: 62px; padding: .7rem .85rem; display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; align-items: center; gap: .7rem; border-bottom: 1px solid var(--border-flat); background: var(--bg-panel); }
    .audit-approval-list article:last-child { border-bottom: 0; }
    .audit-approval-list strong { font-size: .84rem; }
    .audit-approval-list p { margin: .1rem 0; color: var(--text-main); font-size: .76rem; }
    .audit-approval-list small { color: var(--text-muted); font-size: .7rem; }
    @media (max-width: 1050px) {
        .audit-filter-panel { grid-template-columns: 1fr; }
        .audit-filter-heading { flex-direction: row; align-items: center; justify-content: space-between; gap: 1rem; }
        .audit-filter-heading small { text-align: right; }
        .audit-event-toggle { grid-template-columns: 10px minmax(150px, 1fr) minmax(90px, .35fr) auto 20px; gap: .5rem; }
    }
    @media (max-width: 720px) {
        .audit-page { padding: .55rem; gap: .65rem; }
        .audit-filter-grid { grid-template-columns: 1fr; }
        .audit-filter-heading small { display: none; }
        .audit-section-header { align-items: flex-start; }
        .audit-event-toggle { grid-template-columns: 10px minmax(0, 1fr) 20px; }
        .audit-event-person { grid-column: 2; }
        .audit-event-toggle time { grid-column: 2; }
        .audit-chevron { grid-column: 3; grid-row: 1 / span 3; }
        .audit-details { grid-template-columns: 1fr; padding-left: .8rem; }
    }
</style>
