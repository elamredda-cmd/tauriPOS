<script lang="ts">
    import { onMount } from 'svelte';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import CustomSelect from '$lib/components/CustomSelect.svelte';
    import { employeesDB, type AuditLog } from '$lib/stores/db';
    import { getAuditLogPage, getRecentManagerApprovals } from '$lib/stores/database';
    import { toast } from '$lib/stores/toast';
    import {
        auditActionLabel,
        auditEntityLabel,
        auditRecordName,
        buildAuditChanges,
        parseAuditJson,
        prettyAuditJson,
        shortAuditReference,
        type AuditFieldChange,
    } from '$lib/auditDisplay';

    interface AuditLogRow extends AuditLog {
        employeeName?: string;
        relatedOrderNumber?: number | null;
        relatedOrderTotal?: number | null;
        relatedPaymentMethod?: string;
        relatedTillName?: string;
        relatedCustomerName?: string;
    }

    let logs: AuditLogRow[] = [];
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

    $: actionOptions = [{ label: 'All actions', value: '' }, ...actions.map((action) => ({ label: auditActionLabel(action), value: action }))];
    $: entityOptions = [{ label: 'All record types', value: '' }, ...entities.map((entity) => ({ label: auditEntityLabel(entity), value: entity }))];
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

    function humanize(value: string) {
        return String(value || 'record')
            .replace(/[_-]+/g, ' ')
            .replace(/\b\w/g, (letter) => letter.toUpperCase());
    }

    function employeeName(employeeId: string, recordedName = '') {
        if (!employeeId) return 'System';
        if (employeeId.startsWith('lbj-support-')) return 'L&Bj Support';
        return recordedName || employeeById.get(employeeId) || 'Former staff member';
    }

    function formatDate(value: string) {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? 'Unknown time' : date.toLocaleString('en-GB', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
        });
    }

    function formatMoney(value: unknown) {
        const amount = Number(value);
        if (!Number.isFinite(amount)) return '';
        return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(amount / 100);
    }

    function auditPayload(log: AuditLogRow) {
        const next = parseAuditJson(log.newData);
        return next && typeof next === 'object' ? next : {};
    }

    function receiptNumber(log: AuditLogRow): number | null {
        const payloadNumber = Number(auditPayload(log).orderNumber || 0);
        const number = Number(log.relatedOrderNumber || payloadNumber || 0);
        return Number.isFinite(number) && number > 0 ? number : null;
    }

    function recordSubject(log: AuditLogRow) {
        const receipt = receiptNumber(log);
        if (receipt) return `Receipt #${receipt}`;
        return auditRecordName(log) || shortAuditReference(log.entityId);
    }

    function eventContext(log: AuditLogRow) {
        const payload = auditPayload(log);
        const parts: string[] = [recordSubject(log)];
        const amount = Number(payload.refundAmount ?? payload.total ?? log.relatedOrderTotal);
        if (Number.isFinite(amount) && amount !== 0) parts.push(formatMoney(amount));
        const paymentMethod = String(payload.paymentMethod || log.relatedPaymentMethod || '').trim();
        if (paymentMethod) parts.push(humanize(paymentMethod.replace(/\+/g, ' + ')));
        return parts.filter(Boolean).join(' · ');
    }

    function resolveAuditReference(log: AuditLogRow, kind: string, value: string): string | undefined {
        if (kind === 'employee') return employeeById.get(value);
        if (kind === 'order') {
            const receipt = receiptNumber(log);
            if (receipt && value === log.entityId) return `Receipt #${receipt}`;
        }
        if (kind === 'customer' && log.relatedCustomerName) return log.relatedCustomerName;
        if (kind === 'till' && log.relatedTillName) return log.relatedTillName;
        return undefined;
    }

    function changesFor(log: AuditLogRow): AuditFieldChange[] {
        return buildAuditChanges(log, (kind, value) => resolveAuditReference(log, kind, value));
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
                                    <strong>{auditActionLabel(log.action)}</strong>
                                    <small>
                                        {auditEntityLabel(log.entityType || 'record')}
                                        <span>{eventContext(log)}</span>
                                    </small>
                                </span>
                                <span class="audit-event-person">{employeeName(log.employeeId, log.employeeName)}</span>
                                <time datetime={log.createdAt}>{formatDate(log.createdAt)}</time>
                                <svg class="audit-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg>
                            </button>
                            {#if expandedId === log.id}
                                {@const changes = changesFor(log)}
                                <div class="audit-details">
                                    <div class="audit-detail-context">
                                        <div>
                                            <span>Recorded by</span>
                                            <strong>{employeeName(log.employeeId, log.employeeName)}</strong>
                                        </div>
                                        <div>
                                            <span>When</span>
                                            <strong>{formatDate(log.createdAt)}</strong>
                                        </div>
                                        <div>
                                            <span>Record</span>
                                            <strong>{recordSubject(log)}</strong>
                                        </div>
                                        {#if log.relatedTillName}
                                            <div>
                                                <span>Till</span>
                                                <strong>{log.relatedTillName}</strong>
                                            </div>
                                        {/if}
                                        {#if log.relatedCustomerName}
                                            <div>
                                                <span>Customer</span>
                                                <strong>{log.relatedCustomerName}</strong>
                                            </div>
                                        {/if}
                                        <div title={log.entityId}>
                                            <span>Reference</span>
                                            <strong>{shortAuditReference(log.entityId)}</strong>
                                        </div>
                                    </div>

                                    <div class="audit-change-section">
                                        <div class="audit-change-heading">
                                            <strong>{log.oldData && log.newData ? 'What changed' : 'Recorded information'}</strong>
                                            <span>{changes.length} visible {changes.length === 1 ? 'field' : 'fields'}</span>
                                        </div>
                                        {#if changes.length === 0}
                                            <p class="audit-no-visible-change">No user-visible field changes were recorded.</p>
                                        {:else}
                                            <div class="audit-change-list">
                                                {#each changes as change}
                                                    <article class="audit-change-row audit-change-{change.kind}">
                                                        <span class="audit-change-label">{change.label}</span>
                                                        {#if change.kind === 'changed'}
                                                            <div class="audit-change-values">
                                                                <span class="audit-value-before"><small>Before</small><strong>{change.before}</strong></span>
                                                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"></path></svg>
                                                                <span class="audit-value-after"><small>After</small><strong>{change.after}</strong></span>
                                                            </div>
                                                        {:else if change.kind === 'added'}
                                                            <div class="audit-change-values single">
                                                                <span class="audit-value-after"><small>Recorded as</small><strong>{change.after}</strong></span>
                                                            </div>
                                                        {:else}
                                                            <div class="audit-change-values single">
                                                                <span class="audit-value-before"><small>Removed value</small><strong>{change.before}</strong></span>
                                                            </div>
                                                        {/if}
                                                    </article>
                                                {/each}
                                            </div>
                                        {/if}
                                    </div>

                                    <details class="audit-technical-details">
                                        <summary>Technical details</summary>
                                        <div>
                                            <section>
                                                <span>Before</span>
                                                <pre>{prettyAuditJson(log.oldData) || 'No previous data'}</pre>
                                            </section>
                                            <section>
                                                <span>After</span>
                                                <pre>{prettyAuditJson(log.newData) || 'No new data'}</pre>
                                            </section>
                                        </div>
                                    </details>
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
                                <strong>{auditActionLabel(approval.action)}</strong>
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
    .audit-details { padding: .8rem; display: flex; flex-direction: column; gap: .75rem; border-top: 1px solid var(--border-flat); }
    .audit-detail-context { padding: .6rem; display: grid; grid-template-columns: repeat(auto-fit, minmax(135px, 1fr)); gap: .45rem; border: 1px solid var(--border-flat); border-radius: .4rem; background: var(--bg-panel); }
    .audit-detail-context > div { min-width: 0; padding: .35rem .45rem; display: flex; flex-direction: column; gap: .14rem; }
    .audit-detail-context span, .audit-change-heading span { color: var(--text-muted); font-size: .64rem; font-weight: 800; text-transform: uppercase; }
    .audit-detail-context strong { overflow: hidden; color: var(--text-main); font-size: .76rem; text-overflow: ellipsis; white-space: nowrap; }
    .audit-change-section { min-width: 0; }
    .audit-change-heading { min-height: 30px; display: flex; align-items: center; justify-content: space-between; gap: .75rem; }
    .audit-change-heading > strong { font-size: .82rem; }
    .audit-change-list { overflow: hidden; border: 1px solid var(--border-flat); border-radius: .4rem; }
    .audit-change-row { min-height: 58px; display: grid; grid-template-columns: minmax(135px, .38fr) minmax(0, 1fr); align-items: stretch; border-bottom: 1px solid var(--border-flat); background: var(--bg-panel); }
    .audit-change-row:last-child { border-bottom: 0; }
    .audit-change-label { padding: .65rem .75rem; display: flex; align-items: center; color: var(--text-main); border-right: 1px solid var(--border-flat); font-size: .74rem; font-weight: 800; overflow-wrap: anywhere; }
    .audit-change-values { min-width: 0; padding: .45rem .55rem; display: grid; grid-template-columns: minmax(0, 1fr) 20px minmax(0, 1fr); align-items: center; gap: .4rem; }
    .audit-change-values.single { grid-template-columns: minmax(0, 1fr); }
    .audit-change-values > svg { width: 16px; height: 16px; color: var(--text-muted); justify-self: center; }
    .audit-value-before, .audit-value-after { min-width: 0; min-height: 42px; padding: .35rem .45rem; display: flex; flex-direction: column; justify-content: center; gap: .08rem; border-radius: .35rem; }
    .audit-value-before { background: rgba(239, 68, 68, .08); }
    .audit-value-after { background: rgba(34, 197, 94, .09); }
    .audit-value-before small, .audit-value-after small { color: var(--text-muted); font-size: .61rem; font-weight: 800; text-transform: uppercase; }
    .audit-value-before strong, .audit-value-after strong { color: var(--text-main); font-size: .76rem; line-height: 1.25; overflow-wrap: anywhere; }
    .audit-no-visible-change { margin: 0; padding: .75rem; color: var(--text-muted); border: 1px solid var(--border-flat); border-radius: .4rem; background: var(--bg-panel); font-size: .75rem; }
    .audit-technical-details { border-top: 1px solid var(--border-flat); }
    .audit-technical-details summary { width: fit-content; padding: .6rem 0 0; color: var(--text-muted); cursor: pointer; font-size: .7rem; font-weight: 800; }
    .audit-technical-details > div { margin-top: .55rem; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .55rem; }
    .audit-technical-details section { min-width: 0; }
    .audit-technical-details section > span { color: var(--text-muted); font-size: .62rem; font-weight: 800; text-transform: uppercase; }
    .audit-technical-details pre { min-height: 84px; max-height: 260px; margin: .3rem 0 0; padding: .65rem; overflow: auto; color: var(--text-main); border: 1px solid var(--border-flat); border-radius: .4rem; background: var(--bg-panel); font-family: ui-monospace, monospace; font-size: .69rem; line-height: 1.35; white-space: pre-wrap; overflow-wrap: anywhere; }
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
        .audit-detail-context { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .audit-change-row { grid-template-columns: 1fr; }
        .audit-change-label { padding-bottom: .4rem; border-right: 0; border-bottom: 1px solid var(--border-flat); }
        .audit-technical-details > div { grid-template-columns: 1fr; }
    }
</style>
