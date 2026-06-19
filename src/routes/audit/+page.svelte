<script lang="ts">
    import { onMount } from 'svelte';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import CustomSelect from '$lib/components/CustomSelect.svelte';
    import { employeesDB, type AuditLog } from '$lib/stores/db';
    import { getAuditLogPage, getRecentManagerApprovals } from '$lib/stores/database';
    import { toast } from '$lib/stores/toast';

    let logs: AuditLog[] = [];
    let loading = true;
    let approvalsLoading = true;
    let query = '';
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

    $: actionOptions = [{ label: 'All actions', value: '' }, ...actions.map((action) => ({ label: action, value: action }))];
    $: entityOptions = [{ label: 'All records', value: '' }, ...entities.map((entity) => ({ label: entity, value: entity }))];
    $: employeeById = new Map($employeesDB.map((employee) => [employee.id, employee.name]));
    $: totalPages = Math.max(1, Math.ceil(total / pageSize));
    $: showingFrom = total === 0 ? 0 : (page - 1) * pageSize + 1;
    $: showingTo = Math.min(total, page * pageSize);
    $: currentFilterKey = `${query}|${actionFilter}|${entityFilter}`;
    $: if (mounted && currentFilterKey !== filterKey) {
        filterKey = currentFilterKey;
        if (page !== 1) page = 1;
    }
    $: currentLoadKey = `${query}|${actionFilter}|${entityFilter}|${page}`;
    $: if (mounted && currentLoadKey !== loadKey) {
        loadKey = currentLoadKey;
        scheduleLoad();
    }

    function scheduleLoad() {
        if (loadTimer) clearTimeout(loadTimer);
        loadTimer = setTimeout(loadAuditPage, query.trim() ? 250 : 0);
    }

    async function loadAuditPage() {
        const run = ++loadRun;
        loading = true;
        try {
            const result = await getAuditLogPage({
                query,
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
            toast(`Could not load audit log: ${error}`, 'error');
        } finally {
            if (run === loadRun) loading = false;
        }
    }

    async function loadApprovals() {
        approvalsLoading = true;
        try {
            approvals = await getRecentManagerApprovals(25);
        } catch (error) {
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

    function prettyJson(value: string) {
        if (!value) return '';
        try { return JSON.stringify(JSON.parse(value), null, 2); }
        catch { return value; }
    }

    onMount(() => {
        mounted = true;
        filterKey = currentFilterKey;
        loadKey = currentLoadKey;
        refreshAll();
        return () => {
            if (loadTimer) clearTimeout(loadTimer);
        };
    });
</script>

<MgmtPage title="Audit Log">
    <button slot="actions" class="btn btn-secondary" disabled={loading || approvalsLoading} on:click={refreshAll}>Refresh</button>

    <div class="h-full overflow-y-auto p-5">
        <section class="mb-5 rounded-2xl border border-border-flat bg-bg-card p-4">
            <div class="grid gap-3 lg:grid-cols-[1fr_180px_180px]">
                <div class="field">
                    <label for="audit-search">Search Audit</label>
                    <input id="audit-search" bind:value={query} placeholder="Search employee, action, receipt, item, JSON..." />
                </div>
                <div class="field">
                    <CustomSelect label="Action" bind:value={actionFilter} options={actionOptions} />
                </div>
                <div class="field">
                    <CustomSelect label="Record Type" bind:value={entityFilter} options={entityOptions} />
                </div>
            </div>
        </section>

        <section class="rounded-2xl border border-border-flat bg-bg-card p-4">
            <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h2 class="m-0 text-xl">Activity</h2>
                    <span class="text-sm text-text-muted">
                        Showing {showingFrom}-{showingTo} of {total} record{total === 1 ? '' : 's'}
                    </span>
                </div>
                <div class="flex items-center gap-2">
                    <button class="btn btn-secondary" disabled={loading || page <= 1} on:click={() => goToPage(1)}>First</button>
                    <button class="btn btn-secondary" disabled={loading || page <= 1} on:click={() => goToPage(page - 1)}>Previous</button>
                    <span class="text-sm font-bold text-text-muted">Page {page} / {totalPages}</span>
                    <button class="btn btn-secondary" disabled={loading || page >= totalPages} on:click={() => goToPage(page + 1)}>Next</button>
                </div>
            </div>

            {#if loading}
                <div class="p-10 text-center text-text-muted">Loading audit log...</div>
            {:else if logs.length === 0}
                <div class="p-10 text-center text-text-muted">No audit records found.</div>
            {:else}
                <div class="grid gap-3">
                    {#each logs as log}
                        <article class="rounded-xl border border-border-flat bg-bg-panel p-4">
                            <button
                                type="button"
                                class="flex w-full items-start justify-between gap-3 text-left"
                                on:click={() => expandedId = expandedId === log.id ? '' : log.id}
                            >
                                <div>
                                    <strong class="text-text-main">{log.action}</strong>
                                    <p class="m-0 mt-1 text-sm text-text-muted">
                                        {log.entityType || 'record'} · {log.entityId || 'no id'} · {employeeById.get(log.employeeId) || 'Unknown employee'}
                                    </p>
                                </div>
                                <span class="shrink-0 text-sm text-text-muted">{new Date(log.createdAt).toLocaleString('en-GB')}</span>
                            </button>
                            {#if expandedId === log.id}
                                <div class="mt-4 grid gap-3 lg:grid-cols-2">
                                    <div>
                                        <span class="text-xs font-black uppercase tracking-[0.14em] text-text-muted">Before</span>
                                        <pre class="mt-2 max-h-72 overflow-auto rounded-xl border border-border-flat bg-bg-card p-3 text-xs">{prettyJson(log.oldData) || 'No previous data'}</pre>
                                    </div>
                                    <div>
                                        <span class="text-xs font-black uppercase tracking-[0.14em] text-text-muted">After</span>
                                        <pre class="mt-2 max-h-72 overflow-auto rounded-xl border border-border-flat bg-bg-card p-3 text-xs">{prettyJson(log.newData) || 'No new data'}</pre>
                                    </div>
                                </div>
                            {/if}
                        </article>
                    {/each}
                </div>
                <div class="mt-4 flex items-center justify-end gap-2">
                    <button class="btn btn-secondary" disabled={page <= 1} on:click={() => goToPage(page - 1)}>Previous</button>
                    <button class="btn btn-secondary" disabled={page >= totalPages} on:click={() => goToPage(page + 1)}>Next</button>
                </div>
            {/if}
        </section>

        <section class="mt-5 rounded-2xl border border-border-flat bg-bg-card p-4">
            <div class="mb-3 flex items-center justify-between">
                <h2 class="m-0 text-xl">Manager Approvals</h2>
                <span class="text-sm text-text-muted">Latest {approvals.length} approval{approvals.length === 1 ? '' : 's'}</span>
            </div>
            {#if approvalsLoading}
                <p class="m-0 text-text-muted">Loading approvals...</p>
            {:else if approvals.length === 0}
                <p class="m-0 text-text-muted">No manager approvals recorded yet.</p>
            {:else}
                <div class="grid gap-3">
                    {#each approvals as approval}
                        <article class="rounded-xl border border-border-flat bg-bg-panel p-4">
                            <strong>{approval.action}</strong>
                            <p class="m-0 mt-1 text-sm text-text-muted">
                                Requested by {employeeById.get(approval.requestedByEmployeeId) || 'Unknown'} ·
                                approved by {employeeById.get(approval.approvedByEmployeeId) || 'Unknown'}
                            </p>
                            <p class="m-0 mt-1 text-sm text-text-muted">{approval.notes || approval.entityType || 'Approval'}</p>
                            <p class="m-0 mt-1 text-xs text-text-muted">{new Date(approval.createdAt).toLocaleString('en-GB')}</p>
                        </article>
                    {/each}
                </div>
            {/if}
        </section>
    </div>
</MgmtPage>
