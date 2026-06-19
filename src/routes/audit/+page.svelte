<script lang="ts">
    import { onMount } from 'svelte';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import CustomSelect from '$lib/components/CustomSelect.svelte';
    import { employeesDB, type AuditLog } from '$lib/stores/db';
    import { getAll } from '$lib/stores/database';
    import { toast } from '$lib/stores/toast';

    let logs: AuditLog[] = [];
    let loading = true;
    let query = '';
    let actionFilter = '';
    let entityFilter = '';
    let expandedId = '';
    let approvals: any[] = [];

    $: actions = Array.from(new Set(logs.map((log) => log.action).filter(Boolean))).sort();
    $: entities = Array.from(new Set(logs.map((log) => log.entityType).filter(Boolean))).sort();
    $: actionOptions = [{ label: 'All actions', value: '' }, ...actions.map((action) => ({ label: action, value: action }))];
    $: entityOptions = [{ label: 'All records', value: '' }, ...entities.map((entity) => ({ label: entity, value: entity }))];
    $: employeeById = new Map($employeesDB.map((employee) => [employee.id, employee.name]));
    $: filteredLogs = logs.filter((log) => {
        const search = query.trim().toLowerCase();
        const searchable = [
            log.action, log.entityType, log.entityId,
            employeeById.get(log.employeeId), log.oldData, log.newData,
        ].join(' ').toLowerCase();
        return (!actionFilter || log.action === actionFilter)
            && (!entityFilter || log.entityType === entityFilter)
            && (!search || searchable.includes(search));
    });

    async function load() {
        loading = true;
        try {
            const [auditRows, approvalRows] = await Promise.all([
                getAll('audit_logs'),
                getAll('manager_approvals'),
            ]);
            logs = auditRows.sort((a, b) =>
                new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
            );
            approvals = approvalRows.sort((a, b) =>
                new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
            );
        } catch (error) {
            toast(`Could not load audit log: ${error}`, 'error');
        } finally {
            loading = false;
        }
    }

    function prettyJson(value: string) {
        if (!value) return '';
        try { return JSON.stringify(JSON.parse(value), null, 2); }
        catch { return value; }
    }

    onMount(load);
</script>

<MgmtPage title="Audit Log">
    <button slot="actions" class="btn btn-secondary" disabled={loading} on:click={load}>Refresh</button>

    <div class="h-full overflow-y-auto p-5">
        <section class="mb-5 rounded-2xl border border-border-flat bg-bg-card p-4">
            <div class="grid gap-3 lg:grid-cols-[1fr_180px_180px]">
                <div class="field">
                    <label>Search Audit</label>
                    <input bind:value={query} placeholder="Search employee, action, receipt, item, JSON..." />
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
            <div class="mb-3 flex items-center justify-between">
                <h2 class="m-0 text-xl">Activity</h2>
                <span class="text-sm text-text-muted">{filteredLogs.length} record{filteredLogs.length === 1 ? '' : 's'}</span>
            </div>

            {#if loading}
                <div class="p-10 text-center text-text-muted">Loading audit log...</div>
            {:else if filteredLogs.length === 0}
                <div class="p-10 text-center text-text-muted">No audit records found.</div>
            {:else}
                <div class="grid gap-3">
                    {#each filteredLogs as log}
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
            {/if}
        </section>

        <section class="mt-5 rounded-2xl border border-border-flat bg-bg-card p-4">
            <div class="mb-3 flex items-center justify-between">
                <h2 class="m-0 text-xl">Manager Approvals</h2>
                <span class="text-sm text-text-muted">{approvals.length} approval{approvals.length === 1 ? '' : 's'}</span>
            </div>
            {#if approvals.length === 0}
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
