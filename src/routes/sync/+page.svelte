<script lang="ts">
    import { onMount } from 'svelte';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import { connectionState } from '$lib/stores/connection';
    import { toast } from '$lib/stores/toast';
    import {
        dismissSyncConflict,
        forceFullSync,
        getConnectedTills,
        getOfflineQueueStats,
        getSyncConflicts,
        retryOfflineQueueNow,
        retrySyncConflict,
        triggerSync,
        validateDatabaseSchemas,
        type OfflineQueueStats,
        type ConnectedTill,
        type SyncConflict,
        type SchemaValidationResult,
    } from '$lib/stores/database';

    let stats: OfflineQueueStats = {
        pending: 0,
        retrying: 0,
        conflicts: 0,
        oldestPendingAt: '',
        nextRetryAt: '',
        lastError: '',
    };
    let conflicts: SyncConflict[] = [];
    let schema: SchemaValidationResult = { ok: true, issues: [] };
    let loading = true;
    let busy = '';
    let connectedTills: ConnectedTill[] = [];
    let presenceLoading = true;
    let presenceError = '';
    let presenceRefreshTimer: ReturnType<typeof setInterval> | null = null;

    function lastSeenLabel(secondsAgo: number): string {
        if (secondsAgo < 5) return 'Online now';
        return `Seen ${secondsAgo}s ago`;
    }

    async function loadConnectedTills() {
        presenceLoading = connectedTills.length === 0;
        try {
            connectedTills = await getConnectedTills();
            presenceError = '';
        } catch (error) {
            connectedTills = [];
            presenceError = String(error).replace(/^Error:\s*/, '');
        } finally {
            presenceLoading = false;
        }
    }

    async function load() {
        loading = true;
        try {
            [stats, conflicts, schema] = await Promise.all([
                getOfflineQueueStats(),
                getSyncConflicts(),
                validateDatabaseSchemas(),
            ]);
            await loadConnectedTills();
        } catch (error) {
            toast(`Could not load sync dashboard: ${error}`, 'error');
        } finally {
            loading = false;
        }
    }

    async function runAction(label: string, action: () => Promise<unknown>) {
        if (busy) return;
        busy = label;
        try {
            await action();
            await load();
            toast(`${label} finished`, 'success');
        } catch (error) {
            toast(`${label} failed: ${error}`, 'error');
        } finally {
            busy = '';
        }
    }

    onMount(() => {
        void load();
        presenceRefreshTimer = setInterval(() => void loadConnectedTills(), 15_000);
        return () => {
            if (presenceRefreshTimer) clearInterval(presenceRefreshTimer);
        };
    });
</script>

<MgmtPage title="Sync Dashboard">
    <button slot="actions" class="btn btn-secondary" disabled={loading || !!busy} on:click={load}>Refresh</button>

    <div class="h-full overflow-y-auto p-5">
        <div class="mb-5 grid gap-4 md:grid-cols-4">
            <div class="rounded-2xl border border-border-flat bg-bg-card p-5">
                <span class="text-xs font-black uppercase tracking-[0.16em] text-text-muted">Mode</span>
                <strong class="mt-2 block text-2xl capitalize">{$connectionState.mode}</strong>
                <p class="m-0 mt-1 text-sm text-text-muted">{$connectionState.mysqlOnline ? 'MariaDB online' : 'Local / offline'}</p>
            </div>
            <div class="rounded-2xl border border-border-flat bg-bg-card p-5">
                <span class="text-xs font-black uppercase tracking-[0.16em] text-text-muted">Pending</span>
                <strong class="mt-2 block text-2xl {stats.pending ? 'text-warning' : 'text-success'}">{stats.pending}</strong>
                <p class="m-0 mt-1 text-sm text-text-muted">
                    {stats.retrying ? `${stats.retrying} waiting to retry` : 'Writes waiting to upload'}
                </p>
            </div>
            <div class="rounded-2xl border border-border-flat bg-bg-card p-5">
                <span class="text-xs font-black uppercase tracking-[0.16em] text-text-muted">Conflicts</span>
                <strong class="mt-2 block text-2xl {stats.conflicts ? 'text-danger' : 'text-success'}">{stats.conflicts}</strong>
                <p class="m-0 mt-1 text-sm text-text-muted">Need review</p>
            </div>
            <div class="rounded-2xl border border-border-flat bg-bg-card p-5">
                <span class="text-xs font-black uppercase tracking-[0.16em] text-text-muted">Schema</span>
                <strong class="mt-2 block text-2xl {schema.ok ? 'text-success' : 'text-danger'}">{schema.ok ? 'Good' : 'Issues'}</strong>
                <p class="m-0 mt-1 text-sm text-text-muted">SQLite and MariaDB shape</p>
            </div>
        </div>

        {#if $connectionState.syncError}
            <div class="mb-5 rounded-2xl border border-danger/40 bg-danger/10 p-4 text-danger">
                <strong>Sync message:</strong> {$connectionState.syncError}
            </div>
        {/if}

        {#if stats.lastError}
            <div class="mb-5 border border-warning/40 bg-warning/10 p-4 text-warning">
                <strong>Last upload problem:</strong> {stats.lastError}
                {#if stats.nextRetryAt}
                    <span class="ml-2 text-sm">Next automatic retry: {new Date(stats.nextRetryAt).toLocaleString('en-GB')}</span>
                {/if}
            </div>
        {/if}

        <section class="mb-5 rounded-lg border border-border-flat bg-bg-card p-5">
            <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                    <p class="m-0 text-xs font-black uppercase tracking-[0.16em] text-text-muted">
                        {$connectionState.mode === 'multi' ? 'Live MariaDB presence' : 'Local device'}
                    </p>
                    <h2 class="m-0 mt-1 text-xl">Connected tills</h2>
                </div>
                <div class="flex h-12 min-w-16 items-center justify-center rounded-md border border-success/35 bg-success/10 px-4 text-2xl font-black text-success">
                    {connectedTills.length}
                </div>
            </div>

            {#if presenceError}
                <div class="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
                    Could not read connected tills: {presenceError}
                </div>
            {:else if presenceLoading}
                <p class="m-0 text-sm text-text-muted">Checking connected tills...</p>
            {:else if connectedTills.length === 0}
                <p class="m-0 text-sm text-text-muted">No tills are currently connected to MariaDB.</p>
            {:else}
                <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {#each connectedTills as till (till.tillId)}
                        <article class="flex min-h-[76px] items-center gap-3 rounded-md border border-border-flat bg-bg-panel p-3">
                            <span class="h-3 w-3 shrink-0 rounded-full bg-success ring-4 ring-success/15"></span>
                            <div class="min-w-0 flex-1">
                                <div class="flex flex-wrap items-center gap-2">
                                    <strong class="truncate text-base text-text-main">{till.tillName}</strong>
                                    {#if till.isCurrent}
                                        <span class="rounded-sm bg-accent-primary/15 px-2 py-0.5 text-[0.68rem] font-black uppercase text-accent-primary">This till</span>
                                    {/if}
                                </div>
                                <p class="m-0 mt-1 text-xs text-success">{lastSeenLabel(till.secondsAgo)}</p>
                            </div>
                        </article>
                    {/each}
                </div>
            {/if}
        </section>

        <section class="mb-5 rounded-2xl border border-border-flat bg-bg-card p-5">
            <h2 class="m-0 mb-3 text-xl">Actions</h2>
            <div class="flex flex-wrap gap-3">
                <button class="btn btn-primary" disabled={!!busy} on:click={() => runAction('Retry uploads', retryOfflineQueueNow)}>Retry Uploads</button>
                <button class="btn btn-secondary" disabled={!!busy} on:click={() => runAction('Sync now', triggerSync)}>Sync Now</button>
                <button class="btn btn-secondary" disabled={!!busy} on:click={() => runAction('Full repair sync', forceFullSync)}>Full Repair Sync</button>
            </div>
            {#if busy}<p class="mt-3 text-sm text-text-muted">{busy} is running...</p>{/if}
        </section>

        <section class="mb-5 rounded-2xl border border-border-flat bg-bg-card p-5">
            <h2 class="m-0 mb-3 text-xl">Schema Check</h2>
            {#if schema.ok}
                <p class="m-0 text-success">All critical tables and columns are present.</p>
            {:else}
                <div class="grid gap-2">
                    {#each schema.issues as issue}
                        <div class="rounded-xl border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{issue}</div>
                    {/each}
                </div>
            {/if}
        </section>

        <section class="rounded-2xl border border-border-flat bg-bg-card p-5">
            <div class="mb-3 flex items-center justify-between gap-3">
                <h2 class="m-0 text-xl">Sync Conflicts</h2>
                <span class="text-sm text-text-muted">{conflicts.length} conflict{conflicts.length === 1 ? '' : 's'}</span>
            </div>
            {#if conflicts.length === 0}
                <p class="m-0 text-text-muted">No conflicts waiting for review.</p>
            {:else}
                <div class="grid gap-3">
                    {#each conflicts as conflict}
                        <article class="rounded-xl border border-border-flat bg-bg-panel p-4">
                            <div class="flex flex-wrap items-start justify-between gap-3">
                                <div>
                                    <strong>{conflict.table_name} · {conflict.operation}</strong>
                                    <p class="m-0 mt-1 text-sm text-danger">{conflict.reason}</p>
                                    <p class="m-0 mt-1 text-xs text-text-muted">{new Date(conflict.created_at).toLocaleString('en-GB')}</p>
                                </div>
                                <div class="flex gap-2">
                                    <button class="btn btn-secondary" disabled={!!busy} on:click={() => runAction('Retry conflict', () => retrySyncConflict(conflict.id))}>Retry</button>
                                    <button class="btn btn-danger" disabled={!!busy} on:click={() => runAction('Dismiss conflict', () => dismissSyncConflict(conflict.id))}>Dismiss</button>
                                </div>
                            </div>
                        </article>
                    {/each}
                </div>
            {/if}
        </section>
    </div>
</MgmtPage>
