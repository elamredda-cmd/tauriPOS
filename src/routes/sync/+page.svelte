<script lang="ts">
    import { onMount } from 'svelte';
    import { isTauri } from '@tauri-apps/api/core';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import { connectionState } from '$lib/stores/connection';
    import { toast } from '$lib/stores/toast';
    import {
        canRetrySyncConflict,
        dismissSyncConflict,
        forceFullSync,
        getConnectedTills,
        getOfflineQueueStats,
        getSyncRuntimeDiagnostics,
        getSyncConflicts,
        isReportEpochStaleConflict,
        isRetainedLocalSaleConflict,
        isServerDataEpochMismatchConflict,
        retryOfflineQueueNow,
        retrySyncConflict,
        syncConflictSaleReference,
        triggerSync,
        validateDatabaseSchemas,
        type OfflineQueueStats,
        type ConnectedTill,
        type SyncConflict,
        type SchemaValidationResult,
        type SyncRuntimeDiagnostics,
    } from '$lib/stores/database';

    let stats: OfflineQueueStats | null = null;
    let conflicts: SyncConflict[] | null = null;
    let schema: SchemaValidationResult | null = null;
    let runtimeDiagnostics: SyncRuntimeDiagnostics | null = null;
    let loading = true;
    let busy = '';
    let connectedTills: ConnectedTill[] | null = null;
    let presenceLoading = true;
    let presenceError = '';
    let loadError = '';
    let browserPreview = false;
    let presenceRefreshTimer: ReturnType<typeof setInterval> | null = null;
    $: syncActionsAvailable = !browserPreview
        && runtimeDiagnostics?.syncApplicable === true
        && runtimeDiagnostics.syncReady;

    function lastSeenLabel(secondsAgo: number): string {
        if (secondsAgo < 5) return 'Online now';
        return `Seen ${secondsAgo}s ago`;
    }

    async function loadConnectedTills() {
        connectedTills = null;
        presenceLoading = true;
        if (browserPreview || runtimeDiagnostics?.browserPreview) {
            presenceError = 'Connected-till presence is unavailable in browser preview.';
            presenceLoading = false;
            return;
        }
        if ($connectionState.mode === 'multi' && !runtimeDiagnostics?.syncReady) {
            presenceError = runtimeDiagnostics?.mariaDbReachable
                ? 'MariaDB is reachable, but sync startup is not ready. This till was not published as connected.'
                : 'MariaDB is unreachable, so live till presence is unavailable.';
            presenceLoading = false;
            return;
        }
        try {
            connectedTills = await getConnectedTills();
            presenceError = '';
        } catch (error) {
            connectedTills = null;
            presenceError = String(error).replace(/^Error:\s*/, '');
        } finally {
            presenceLoading = false;
        }
    }

    async function load() {
        loading = true;
        loadError = '';
        stats = null;
        conflicts = null;
        schema = null;
        connectedTills = null;
        browserPreview = !isTauri();

        const [statsResult, conflictsResult, schemaResult, runtimeResult] = await Promise.allSettled([
            browserPreview ? Promise.reject(new Error('unavailable in browser preview')) : getOfflineQueueStats(),
            browserPreview ? Promise.reject(new Error('unavailable in browser preview')) : getSyncConflicts(),
            browserPreview ? Promise.reject(new Error('unavailable in browser preview')) : validateDatabaseSchemas(),
            getSyncRuntimeDiagnostics(),
        ]);

        const failures: string[] = [];
        if (statsResult.status === 'fulfilled') stats = statsResult.value;
        else if (!browserPreview) failures.push(`queue: ${String(statsResult.reason).replace(/^Error:\s*/, '')}`);
        if (conflictsResult.status === 'fulfilled') conflicts = conflictsResult.value;
        else if (!browserPreview) failures.push(`conflicts: ${String(conflictsResult.reason).replace(/^Error:\s*/, '')}`);
        if (schemaResult.status === 'fulfilled') schema = schemaResult.value;
        else if (!browserPreview) failures.push(`schema: ${String(schemaResult.reason).replace(/^Error:\s*/, '')}`);
        if (runtimeResult.status === 'fulfilled') runtimeDiagnostics = runtimeResult.value;
        else {
            runtimeDiagnostics = null;
            failures.push(`runtime: ${String(runtimeResult.reason).replace(/^Error:\s*/, '')}`);
        }

        loadError = failures.join(' · ');
        await loadConnectedTills();
        if (loadError) toast(`Could not load all sync diagnostics: ${loadError}`, 'error');
        loading = false;
    }

    async function refreshRuntimeAndPresence() {
        if (browserPreview) return;
        try {
            runtimeDiagnostics = await getSyncRuntimeDiagnostics();
        } catch (error) {
            runtimeDiagnostics = null;
            presenceError = `Runtime diagnostics failed: ${String(error).replace(/^Error:\s*/, '')}`;
        }
        await loadConnectedTills();
    }

    async function runAction(
        label: string,
        action: () => Promise<unknown>,
        options: { requiresSyncReady?: boolean } = {},
    ) {
        if (busy) return;
        if (options.requiresSyncReady !== false && !syncActionsAvailable) {
            toast('This action needs a fully ready MariaDB sync connection.', 'error');
            return;
        }
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

    function isQuarantinedFinancialIntent(conflict: SyncConflict): boolean {
        return conflict.table_name === '_online_financial_intent';
    }

    async function dismissConflictWithWarning(conflict: SyncConflict) {
        if (isRetainedLocalSaleConflict(conflict)) {
            const reference = syncConflictSaleReference(conflict);
            const confirmed = window.confirm(
                `Dismiss the warning for ${reference}?\n\n` +
                'This does not upload the sale and does not remove it from this till. ' +
                'The local sale remains available for administrator review.',
            );
            if (!confirmed) return;
        }
        await runAction(
            isRetainedLocalSaleConflict(conflict) ? 'Dismiss sale warning' : 'Dismiss conflict',
            () => dismissSyncConflict(conflict.id, {
                acknowledgeRetainedLocalSale: isRetainedLocalSaleConflict(conflict),
            }),
            { requiresSyncReady: false },
        );
    }

    onMount(() => {
        browserPreview = !isTauri();
        void load();
        if (!browserPreview) {
            presenceRefreshTimer = setInterval(() => void refreshRuntimeAndPresence(), 15_000);
        }
        return () => {
            if (presenceRefreshTimer) clearInterval(presenceRefreshTimer);
        };
    });
</script>

<MgmtPage title="Sync Dashboard">
    <button slot="actions" class="btn btn-secondary" disabled={loading || !!busy} on:click={load}>Refresh</button>

    <div class="h-full overflow-y-auto p-5">
        <div class="mb-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <div class="rounded-lg border border-border-flat bg-bg-card p-5">
                <span class="text-xs font-black uppercase tracking-[0.16em] text-text-muted">Mode</span>
                <strong class="mt-2 block text-2xl capitalize">{browserPreview ? 'Preview' : ($connectionState.mode || 'Unknown')}</strong>
                <p class="m-0 mt-1 text-sm text-text-muted">
                    {browserPreview ? 'Browser-only simulation' : ($connectionState.mode === 'multi' ? 'Multi-till desktop' : 'Local desktop')}
                </p>
            </div>
            <div class="rounded-lg border border-border-flat bg-bg-card p-5">
                <span class="text-xs font-black uppercase tracking-[0.16em] text-text-muted">MariaDB</span>
                {#if !runtimeDiagnostics}
                    <strong class="mt-2 block text-2xl text-text-muted">Unavailable</strong>
                    <p class="m-0 mt-1 text-sm text-text-muted">Reachability was not checked</p>
                {:else if runtimeDiagnostics.browserPreview}
                    <strong class="mt-2 block text-2xl text-text-muted">Unavailable</strong>
                    <p class="m-0 mt-1 text-sm text-text-muted">Desktop database access is not present in preview</p>
                {:else if !runtimeDiagnostics.syncApplicable}
                    <strong class="mt-2 block text-2xl text-text-muted">Not configured</strong>
                    <p class="m-0 mt-1 text-sm text-text-muted">This till is local-only</p>
                {:else if runtimeDiagnostics.mariaDbReachable}
                    <strong class="mt-2 block text-2xl text-success">Reachable</strong>
                    <p class="m-0 mt-1 text-sm text-text-muted">The server answered a live query</p>
                {:else}
                    <strong class="mt-2 block text-2xl text-danger">Unreachable</strong>
                    <p class="m-0 mt-1 text-sm text-text-muted">{runtimeDiagnostics.reachabilityError || 'The server did not answer'}</p>
                {/if}
            </div>
            <div class="rounded-lg border border-border-flat bg-bg-card p-5">
                <span class="text-xs font-black uppercase tracking-[0.16em] text-text-muted">Sync readiness</span>
                {#if !runtimeDiagnostics}
                    <strong class="mt-2 block text-2xl text-text-muted">Unavailable</strong>
                    <p class="m-0 mt-1 text-sm text-text-muted">The runtime readiness check did not finish</p>
                {:else if runtimeDiagnostics.browserPreview}
                    <strong class="mt-2 block text-2xl text-text-muted">Unavailable</strong>
                    <p class="m-0 mt-1 text-sm text-text-muted">Cannot run sync in browser preview</p>
                {:else if !runtimeDiagnostics.syncApplicable}
                    <strong class="mt-2 block text-2xl text-text-muted">Local only</strong>
                    <p class="m-0 mt-1 text-sm text-text-muted">MariaDB sync is not enabled</p>
                {:else if runtimeDiagnostics.syncReady}
                    <strong class="mt-2 block text-2xl text-success">Ready</strong>
                    <p class="m-0 mt-1 text-sm text-text-muted">Schema, startup and background sync completed</p>
                {:else}
                    <strong class="mt-2 block text-2xl text-danger">Blocked</strong>
                    <p class="m-0 mt-1 text-sm text-text-muted">{runtimeDiagnostics.syncBlockReason || 'Reachable does not mean ready; startup has not completed'}</p>
                {/if}
            </div>
            <div class="rounded-lg border border-border-flat bg-bg-card p-5">
                <span class="text-xs font-black uppercase tracking-[0.16em] text-text-muted">Pending</span>
                {#if stats}
                    <strong class="mt-2 block text-2xl {stats.pending ? 'text-warning' : 'text-success'}">{stats.pending}</strong>
                    <p class="m-0 mt-1 text-sm text-text-muted">
                        {stats.retrying ? `${stats.retrying} waiting to retry` : 'Writes waiting to upload'}
                    </p>
                {:else}
                    <strong class="mt-2 block text-2xl text-text-muted">—</strong>
                    <p class="m-0 mt-1 text-sm text-text-muted">Queue data unavailable</p>
                {/if}
            </div>
            <div class="rounded-lg border border-border-flat bg-bg-card p-5">
                <span class="text-xs font-black uppercase tracking-[0.16em] text-text-muted">Conflicts</span>
                {#if stats}
                    <strong class="mt-2 block text-2xl {stats.conflicts ? 'text-danger' : 'text-success'}">{stats.conflicts}</strong>
                    <p class="m-0 mt-1 text-sm text-text-muted">Need review</p>
                {:else}
                    <strong class="mt-2 block text-2xl text-text-muted">—</strong>
                    <p class="m-0 mt-1 text-sm text-text-muted">Conflict count unavailable</p>
                {/if}
            </div>
            <div class="rounded-lg border border-border-flat bg-bg-card p-5">
                <span class="text-xs font-black uppercase tracking-[0.16em] text-text-muted">Schema</span>
                {#if !schema || !schema.localAvailable || ($connectionState.mode === 'multi' && schema.mariaDbAvailable === false)}
                    <strong class="mt-2 block text-2xl text-text-muted">Unavailable</strong>
                    <p class="m-0 mt-1 text-sm text-text-muted">A complete schema check did not finish</p>
                {:else}
                    <strong class="mt-2 block text-2xl {schema.ok ? 'text-success' : 'text-danger'}">{schema.ok ? 'Good' : 'Issues'}</strong>
                    <p class="m-0 mt-1 text-sm text-text-muted">SQLite and MariaDB shape</p>
                {/if}
            </div>
        </div>

        {#if browserPreview}
            <div class="mb-5 rounded-lg border border-warning/40 bg-warning/10 p-4 text-warning">
                <strong>Browser preview:</strong> database queue, schema, MariaDB reachability and connected-till data are unavailable here. Run the installed desktop app for live diagnostics.
            </div>
        {/if}

        {#if loadError}
            <div class="mb-5 rounded-lg border border-danger/40 bg-danger/10 p-4 text-danger">
                <strong>Dashboard data unavailable:</strong> {loadError}
            </div>
        {/if}

        {#if $connectionState.syncError}
            <div class="mb-5 rounded-lg border border-danger/40 bg-danger/10 p-4 text-danger">
                <strong>Sync message:</strong> {$connectionState.syncError}
            </div>
        {/if}

        {#if stats?.lastError}
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
                        {browserPreview ? 'Browser preview unavailable' : ($connectionState.mode === 'multi' ? 'Live MariaDB presence' : 'Local device')}
                    </p>
                    <h2 class="m-0 mt-1 text-xl">Connected tills</h2>
                </div>
                <div class="flex h-12 min-w-16 items-center justify-center rounded-md border px-4 text-2xl font-black {connectedTills === null ? 'border-border-flat bg-bg-panel text-text-muted' : 'border-success/35 bg-success/10 text-success'}">
                    {connectedTills === null ? '—' : connectedTills.length}
                </div>
            </div>

            {#if presenceError}
                <div class="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
                    Could not read connected tills: {presenceError}
                </div>
            {:else if presenceLoading}
                <p class="m-0 text-sm text-text-muted">Checking connected tills...</p>
            {:else if connectedTills === null}
                <p class="m-0 text-sm text-text-muted">Connected-till data is unavailable.</p>
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

        <section class="mb-5 rounded-lg border border-border-flat bg-bg-card p-5">
            <h2 class="m-0 mb-3 text-xl">Actions</h2>
            <div class="flex flex-wrap gap-3">
                <button class="btn btn-primary" disabled={!!busy || !syncActionsAvailable} on:click={() => runAction('Retry uploads', retryOfflineQueueNow)}>Retry Uploads</button>
                <button class="btn btn-secondary" disabled={!!busy || !syncActionsAvailable} on:click={() => runAction('Sync now', triggerSync)}>Sync Now</button>
                <button class="btn btn-secondary" disabled={!!busy || !syncActionsAvailable} on:click={() => runAction('Full repair sync', forceFullSync)}>Full Repair Sync</button>
            </div>
            {#if busy}<p class="mt-3 text-sm text-text-muted">{busy} is running...</p>{/if}
            {#if !syncActionsAvailable}
                <p class="m-0 mt-3 text-sm text-text-muted">Sync actions become available only after the desktop app reports MariaDB sync as ready.</p>
            {/if}
        </section>

        <section class="mb-5 rounded-lg border border-border-flat bg-bg-card p-5">
            <h2 class="m-0 mb-3 text-xl">Schema Check</h2>
            {#if !schema}
                <div class="rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
                    Schema results are unavailable. No successful check was returned.
                </div>
            {:else if schema.ok}
                <p class="m-0 text-success">All critical tables and columns are present.</p>
            {:else}
                <div class="grid gap-2">
                    {#each schema.issues as issue}
                        <div class="rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{issue}</div>
                    {/each}
                </div>
            {/if}
        </section>

        <section class="rounded-lg border border-border-flat bg-bg-card p-5">
            <div class="mb-3 flex items-center justify-between gap-3">
                <h2 class="m-0 text-xl">Sync Conflicts</h2>
                <span class="text-sm text-text-muted">
                    {conflicts === null ? 'Unavailable' : `${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'}`}
                </span>
            </div>
            {#if conflicts === null}
                <p class="m-0 text-text-muted">Conflict data is unavailable. This is not confirmation that there are no conflicts.</p>
            {:else if conflicts.length === 0}
                <p class="m-0 text-text-muted">No conflicts waiting for review.</p>
            {:else}
                <div class="grid gap-3">
                    {#each conflicts as conflict}
                        <article class="rounded-lg border border-border-flat bg-bg-panel p-4">
                            <div class="flex flex-wrap items-start justify-between gap-3">
                                <div>
                                    <strong>{conflict.table_name} · {conflict.operation}</strong>
                                    <p class="m-0 mt-1 text-sm text-danger">{conflict.reason}</p>
                                    {#if isReportEpochStaleConflict(conflict)}
                                        <p class="m-0 mt-2 rounded-md border border-warning/35 bg-warning/10 p-2 text-sm text-warning">
                                            {syncConflictSaleReference(conflict)} belongs to an already-closed report period. It remains on this till and will not be uploaded automatically. Dismissing removes only this warning.
                                        </p>
                                    {:else if isServerDataEpochMismatchConflict(conflict)}
                                        <p class="m-0 mt-2 rounded-md border border-warning/35 bg-warning/10 p-2 text-sm text-warning">
                                            {syncConflictSaleReference(conflict)} was created for an older MariaDB dataset. It remains on this till and will not be uploaded automatically. Dismissing removes only this warning.
                                        </p>
                                    {:else if isQuarantinedFinancialIntent(conflict)}
                                        <p class="m-0 mt-2 rounded-md border border-warning/35 bg-warning/10 p-2 text-sm text-warning">
                                            This pre-restore financial intent is retained for review and cannot be replayed automatically.
                                        </p>
                                    {/if}
                                    <p class="m-0 mt-1 text-xs text-text-muted">{new Date(conflict.created_at).toLocaleString('en-GB')}</p>
                                </div>
                                <div class="flex gap-2">
                                    {#if canRetrySyncConflict(conflict)}
                                        <button class="btn btn-secondary" disabled={!!busy} on:click={() => runAction('Retry conflict', () => retrySyncConflict(conflict.id))}>Retry</button>
                                    {/if}
                                    <button class="btn btn-danger" disabled={!!busy} on:click={() => dismissConflictWithWarning(conflict)}>
                                        {isRetainedLocalSaleConflict(conflict) ? 'Dismiss warning' : 'Dismiss'}
                                    </button>
                                </div>
                            </div>
                        </article>
                    {/each}
                </div>
            {/if}
        </section>
    </div>
</MgmtPage>
