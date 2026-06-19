<script lang="ts">
    import { onMount } from 'svelte';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import { connectionState } from '$lib/stores/connection';
    import { toast } from '$lib/stores/toast';
    import {
        dismissSyncConflict,
        flushOfflineQueue,
        forceFullSync,
        getOfflineQueueStats,
        getSyncConflicts,
        retrySyncConflict,
        triggerSync,
        validateDatabaseSchemas,
        type OfflineQueueStats,
        type SyncConflict,
        type SchemaValidationResult,
    } from '$lib/stores/database';

    let stats: OfflineQueueStats = { pending: 0, conflicts: 0, oldestPendingAt: '' };
    let conflicts: SyncConflict[] = [];
    let schema: SchemaValidationResult = { ok: true, issues: [] };
    let loading = true;
    let busy = '';

    async function load() {
        loading = true;
        try {
            [stats, conflicts, schema] = await Promise.all([
                getOfflineQueueStats(),
                getSyncConflicts(),
                validateDatabaseSchemas(),
            ]);
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

    onMount(load);
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
                <p class="m-0 mt-1 text-sm text-text-muted">Writes waiting to upload</p>
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

        <section class="mb-5 rounded-2xl border border-border-flat bg-bg-card p-5">
            <h2 class="m-0 mb-3 text-xl">Actions</h2>
            <div class="flex flex-wrap gap-3">
                <button class="btn btn-primary" disabled={!!busy} on:click={() => runAction('Flush queue', flushOfflineQueue)}>Flush Queue</button>
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
