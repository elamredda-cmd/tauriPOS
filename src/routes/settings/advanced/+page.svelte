<script lang="ts">
    import { onMount } from 'svelte';
    import { goto } from '$app/navigation';
    import { get } from 'svelte/store';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import { connectionState } from '$lib/stores/connection';
    import { currentEmployee } from '$lib/stores/session';
    import { storeDB, now, type Store } from '$lib/stores/db';
    import { toast } from '$lib/stores/toast';
    import {
        forceFullSync,
        forcePushToServer,
        dismissSyncConflict,
        getSyncConflicts,
        getLatestLocalBackup,
        createLocalBackup,
        migrateLocalDataToServer,
        purgeAllTransactions,
        restoreLatestLocalBackup,
        retrySyncConflict,
        upsert,
        validateDatabaseSchemas,
        wipeAndPullFromServer,
        type SyncConflict,
    } from '$lib/stores/database';

    let schemaStatus = '';
    let migrationStatus = '';
    let syncStatus = '';
    let wipeStatus = '';
    let pushStatus = '';
    let backupStatus = '';
    let restoreStatus = '';
    let purgeStatus = '';
    let purgeResponsibilityAccepted = false;
    let purgeFinalConfirmation = false;
    let migrationConfirmed = false;
    let wipeConfirmed = false;
    let pushConfirmed = false;
    let restoreConfirmed = false;
    let busy = false;
    let taxIncludedInPrice = $storeDB.taxIncludedInPrice;
    let syncConflicts: SyncConflict[] = [];
    let conflictStatus = '';

    onMount(async () => {
        if (get(currentEmployee)?.role !== 'admin') {
            toast('Advanced Maintenance is available to administrators only.', 'error');
            goto('/settings');
            return;
        }
        await refreshConflicts();
    });

    async function refreshConflicts() {
        syncConflicts = await getSyncConflicts();
    }

    async function retryConflict(id: string) {
        busy = true;
        conflictStatus = 'Retrying selected change...';
        try {
            await retrySyncConflict(id);
            await refreshConflicts();
            conflictStatus = 'Retry completed. Any remaining conflict still needs attention.';
        } catch (error) {
            conflictStatus = `Retry failed: ${error}`;
        } finally {
            busy = false;
        }
    }

    async function dismissConflict(id: string) {
        await dismissSyncConflict(id);
        await refreshConflicts();
        conflictStatus = 'Conflict dismissed on this till.';
    }

    async function saveTaxMode() {
        const store = { ...$storeDB, taxIncludedInPrice } as Store;
        storeDB.set(store);
        await upsert('settings', { key: 'store_info', value: JSON.stringify(store), updatedAt: now() }, 'key');
        toast('Tax calculation mode saved', 'success');
    }

    async function validateSchemas() {
        schemaStatus = 'Checking databases...';
        const result = await validateDatabaseSchemas();
        schemaStatus = result.ok ? 'SQLite and MariaDB schemas are ready.' : result.issues.join(' | ');
    }

    async function migrateLocalData() {
        if (!migrationConfirmed) {
            migrationConfirmed = true;
            migrationStatus = 'Click again to migrate local shop data to an empty MariaDB server.';
            return;
        }
        busy = true;
        try {
            migrationStatus = 'Migrating local data...';
            await migrateLocalDataToServer();
            migrationStatus = 'Local data migrated successfully.';
        } catch (error) {
            migrationStatus = `Migration stopped: ${error}`;
        } finally {
            busy = false;
            migrationConfirmed = false;
        }
    }

    async function forcePull() {
        busy = true;
        syncStatus = 'Pulling all server data...';
        try {
            await forceFullSync();
            syncStatus = 'Full server pull completed.';
        } catch (error) {
            syncStatus = `Full pull failed: ${error}`;
        } finally {
            busy = false;
        }
    }

    async function wipeAndPull() {
        if (!wipeConfirmed) {
            wipeConfirmed = true;
            wipeStatus = 'Click again to wipe this till’s local cache and download from MariaDB.';
            return;
        }
        busy = true;
        try {
            wipeStatus = 'Wiping local cache and downloading...';
            await wipeAndPullFromServer();
            wipeStatus = 'Local cache rebuilt successfully.';
        } catch (error) {
            wipeStatus = `Wipe and pull failed: ${error}`;
        } finally {
            busy = false;
            wipeConfirmed = false;
        }
    }

    async function forcePush() {
        if (!pushConfirmed) {
            pushConfirmed = true;
            pushStatus = 'Click again to push all local data to MariaDB.';
            return;
        }
        busy = true;
        try {
            pushStatus = 'Pushing local data...';
            await forcePushToServer();
            pushStatus = 'Local data pushed to MariaDB.';
        } catch (error) {
            pushStatus = `Push failed: ${error}`;
        } finally {
            busy = false;
            pushConfirmed = false;
        }
    }

    async function restoreBackup() {
        const latest = await getLatestLocalBackup();
        if (!latest) {
            restoreStatus = 'No local backup is available.';
            return;
        }
        if (!restoreConfirmed) {
            restoreConfirmed = true;
            restoreStatus = `Click again to replace this till’s local data with ${latest}`;
            return;
        }
        busy = true;
        try {
            restoreStatus = 'Restoring latest backup...';
            await restoreLatestLocalBackup();
            window.location.reload();
        } catch (error) {
            restoreStatus = `Restore failed: ${error}`;
            busy = false;
            restoreConfirmed = false;
        }
    }

    async function createBackup() {
        busy = true;
        backupStatus = 'Creating local backup...';
        try {
            backupStatus = `Backup saved: ${await createLocalBackup()}`;
        } catch (error) {
            backupStatus = `Backup failed: ${error}`;
        } finally {
            busy = false;
        }
    }

    async function purgeTransactions() {
        if (!purgeResponsibilityAccepted) {
            purgeStatus = 'Confirm that you understand this action permanently deletes database history.';
            return;
        }
        if (!purgeFinalConfirmation) {
            purgeFinalConfirmation = true;
            purgeStatus = 'Final warning: click Delete Database Permanently again to continue.';
            return;
        }
        busy = true;
        purgeStatus = 'Deleting database history from every till...';
        try {
            await purgeAllTransactions();
            purgeStatus = 'Database history was deleted. Reloading...';
            window.location.reload();
        } catch (error) {
            purgeStatus = `Database deletion failed: ${error}`;
            busy = false;
            purgeFinalConfirmation = false;
        }
    }
</script>

{#if $currentEmployee?.role === 'admin'}
<MgmtPage title="Advanced Maintenance" backFallback="/settings">
    <div class="advanced-canvas">
        <section class="warning-banner">
            <strong>Administrator tools</strong>
            <p>These controls can change tax calculations, replace local data, or overwrite MariaDB. Create a backup before using repair tools.</p>
        </section>

        <section class="settings-section">
            <h3 class="settings-section-title">Advanced Shop Configuration</h3>
            <p class="text-text-muted mb-4">Changing the tax mode affects how future transaction tax is calculated.</p>
            <div class="flex flex-wrap items-center gap-3">
                <button class="btn {taxIncludedInPrice ? 'btn-success' : 'btn-secondary'}" on:click={() => taxIncludedInPrice = !taxIncludedInPrice}>
                    Tax Included in Price: {taxIncludedInPrice ? 'Yes' : 'No'}
                </button>
                <button class="btn btn-primary" on:click={saveTaxMode}>Save Tax Mode</button>
            </div>
        </section>

        <section class="settings-section">
            <h3 class="settings-section-title">Connection and Migration</h3>
            <div class="status-card">
                <i class:online={$connectionState.mysqlOnline}></i>
                <div>
                    <strong>{$connectionState.mysqlOnline ? 'MariaDB connected' : 'MariaDB offline or local mode'}</strong>
                    <span>{$connectionState.mode === 'multi' ? ($connectionState.mysqlConfig?.host || 'Unknown host') : 'SQLite only'}</span>
                </div>
            </div>
            <div class="button-row">
                <a href="/setup" class="btn btn-secondary">Change Setup / Database Mode</a>
                <button class="btn btn-secondary" disabled={busy} on:click={validateSchemas}>Validate Database Schemas</button>
                {#if $connectionState.mode === 'multi'}
                    <button class="btn btn-primary" disabled={busy} on:click={migrateLocalData}>Migrate Local Data to Multi-Till</button>
                {/if}
            </div>
            {#if schemaStatus}<p class="status-text">{schemaStatus}</p>{/if}
            {#if migrationStatus}<p class="status-text">{migrationStatus}</p>{/if}
        </section>

        {#if $connectionState.mode === 'multi'}
            <section class="settings-section">
                <h3 class="settings-section-title">Database Repair</h3>
                <p class="text-text-muted mb-4">Use these only when normal automatic synchronization cannot repair a problem.</p>
                <div class="repair-grid">
                    <article>
                        <strong>Full Pull from Server</strong>
                        <p>Download every changed row again without deleting the local cache first.</p>
                        <button class="btn btn-secondary" disabled={busy} on:click={forcePull}>Force Full Pull</button>
                        {#if syncStatus}<small>{syncStatus}</small>{/if}
                    </article>
                    <article class="danger-card">
                        <strong>Rebuild This Till</strong>
                        <p>Delete this till’s local shop cache and download a fresh copy from MariaDB.</p>
                        <button class="btn btn-danger" disabled={busy} on:click={wipeAndPull}>Wipe Local Cache &amp; Pull</button>
                        {#if wipeStatus}<small>{wipeStatus}</small>{/if}
                    </article>
                    <article class="danger-card">
                        <strong>Push Local Data</strong>
                        <p>Upload this till’s complete local shop data to MariaDB.</p>
                        <button class="btn btn-danger" disabled={busy} on:click={forcePush}>Push Local Data to Server</button>
                        {#if pushStatus}<small>{pushStatus}</small>{/if}
                    </article>
                </div>
            </section>
        {/if}

        <section class="settings-section">
            <div class="conflict-heading">
                <div>
                    <h3 class="settings-section-title">Sync Conflicts</h3>
                    <p class="text-text-muted">Changes that could not safely overwrite newer MariaDB data appear here for review.</p>
                </div>
                <button class="btn btn-secondary" disabled={busy} on:click={refreshConflicts}>Refresh</button>
            </div>
            {#if syncConflicts.length === 0}
                <div class="status-card"><div><strong>No sync conflicts</strong><span>This till has no changes waiting for administrator review.</span></div></div>
            {:else}
                <div class="conflict-list">
                    {#each syncConflicts as conflict}
                        <article>
                            <div>
                                <strong>{conflict.table_name} · {conflict.operation}</strong>
                                <span>{new Date(conflict.created_at).toLocaleString()}</span>
                                <p>{conflict.reason}</p>
                            </div>
                            <div class="button-row">
                                <button class="btn btn-primary" disabled={busy} on:click={() => retryConflict(conflict.id)}>Retry</button>
                                <button class="btn btn-secondary" disabled={busy} on:click={() => dismissConflict(conflict.id)}>Dismiss</button>
                            </div>
                        </article>
                    {/each}
                </div>
            {/if}
            {#if conflictStatus}<p class="status-text">{conflictStatus}</p>{/if}
        </section>

        <section class="settings-section danger-card">
            <h3 class="settings-section-title !text-danger">Delete Database</h3>
            <p class="text-text-muted mb-3">
                Permanently deletes orders, payments, till shifts, cash movements, sales reports, sales audit logs, and refund approvals.
                Products, current stock levels, customers, loyalty balances and loyalty history, employees, settings, and tills are kept.
            </p>
            {#if $connectionState.mode === 'multi' && !$connectionState.mysqlOnline}
                <p class="purge-warning">MariaDB must be online so every till receives the deletion instruction.</p>
            {/if}
            <div class="purge-disclaimer">
                <strong>Permanent action</strong>
                <p>
                    This action is your decision and cannot be undone. L&amp;Bj POS is not responsible for database
                    history that you choose to permanently delete. Create a backup first if you may need this data later.
                </p>
            </div>
            <button
                type="button"
                class="mb-4 flex w-full items-center justify-between gap-4 rounded-xl border p-4 text-left transition {purgeResponsibilityAccepted ? 'border-danger bg-danger/10 text-danger' : 'border-border-flat bg-bg-panel text-text-main hover:border-danger hover:bg-danger/5'}"
                role="switch"
                aria-checked={purgeResponsibilityAccepted}
                on:click={() => {
                    purgeResponsibilityAccepted = !purgeResponsibilityAccepted;
                    purgeFinalConfirmation = false;
                }}
            >
                <span class="font-bold">I understand this permanently deletes database history from all tills, and I choose to continue.</span>
                <b class="shrink-0 text-xs uppercase tracking-[0.12em]">{purgeResponsibilityAccepted ? 'Accepted' : 'Required'}</b>
            </button>
            <button
                class="btn btn-danger"
                disabled={busy || !purgeResponsibilityAccepted}
                on:click={purgeTransactions}
            >
                {busy ? 'Deleting Database…' : purgeFinalConfirmation ? 'Delete Database Permanently' : 'Continue to Final Confirmation'}
            </button>
            {#if purgeStatus}<p class="status-text">{purgeStatus}</p>{/if}
        </section>

        <section class="settings-section danger-card">
            <h3 class="settings-section-title !text-danger">Local Backups</h3>
            <p class="text-text-muted mb-4">
                Create a safe local database backup before upgrades or risky repair tools. Restore replaces this till’s local database with its latest backup and reloads the app.
            </p>
            <div class="button-row">
                <button class="btn btn-primary" disabled={busy} on:click={createBackup}>Create Local Backup</button>
                <button class="btn btn-danger" disabled={busy} on:click={restoreBackup}>Restore Latest Backup</button>
            </div>
            {#if backupStatus}<p class="status-text break-all">{backupStatus}</p>{/if}
            {#if restoreStatus}<p class="status-text">{restoreStatus}</p>{/if}
        </section>
    </div>
</MgmtPage>
{/if}

<style>
    .advanced-canvas { padding: 1.25rem; display: flex; flex-direction: column; gap: 1rem; }
    .warning-banner { padding: 1rem 1.2rem; border: 1px solid var(--warning); border-radius: .8rem; background: color-mix(in srgb, var(--warning) 10%, var(--bg-card)); }
    .warning-banner strong { color: var(--warning); }
    .warning-banner p, .status-text { margin: .3rem 0 0; color: var(--text-muted); }
    .status-card { margin-bottom: 1rem; padding: 1rem; display: flex; align-items: center; gap: .8rem; border: 1px solid var(--border-flat); border-radius: .7rem; background: var(--bg-panel); }
    .status-card i { width: .75rem; height: .75rem; border-radius: 50%; background: var(--danger); box-shadow: 0 0 10px var(--danger); }
    .status-card i.online { background: var(--success); box-shadow: 0 0 10px var(--success); }
    .status-card div { display: flex; flex-direction: column; }
    .status-card span, article p, article small { color: var(--text-muted); }
    .button-row { display: flex; flex-wrap: wrap; gap: .65rem; }
    .repair-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .8rem; }
    .repair-grid article { padding: 1rem; display: flex; flex-direction: column; gap: .65rem; border: 1px solid var(--border-flat); border-radius: .75rem; background: var(--bg-panel); }
    .repair-grid article .btn { margin-top: auto; }
    .conflict-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 1rem; }
    .conflict-list { display: grid; gap: .7rem; }
    .conflict-list article { padding: .9rem; display: flex; align-items: center; justify-content: space-between; gap: 1rem; border: 1px solid var(--border-flat); border-radius: .7rem; background: var(--bg-panel); }
    .conflict-list article div:first-child { min-width: 0; }
    .conflict-list span { display: block; color: var(--text-muted); font-size: .78rem; }
    .conflict-list p { margin: .3rem 0 0; color: var(--danger); overflow-wrap: anywhere; }
    .danger-card { border-color: color-mix(in srgb, var(--danger) 55%, var(--border-flat)) !important; }
    .purge-disclaimer { max-width: 760px; margin-bottom: .8rem; padding: .9rem 1rem; border: 1px solid var(--danger); border-radius: .7rem; background: color-mix(in srgb, var(--danger) 8%, var(--bg-panel)); }
    .purge-disclaimer strong { color: var(--danger); }
    .purge-disclaimer p { margin: .3rem 0 0; color: var(--text-muted); }
    .purge-warning { color: var(--danger); }
    .purge-warning { margin: 0 0 .8rem; font-weight: 800; }
    @media (max-width: 900px) {
        .repair-grid { grid-template-columns: 1fr; }
        .conflict-list article { align-items: stretch; flex-direction: column; }
    }
</style>
