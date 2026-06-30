<script lang="ts">
    import { onMount } from 'svelte';
    import { goto } from '$app/navigation';
    import { invoke } from '@tauri-apps/api/core';
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
        replaceMariaDbDataFromThisTill,
        restoreLatestLocalBackup,
        restoreLocalDatabaseFromPath,
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
    let replaceServerStatus = '';
    let backupStatus = '';
    let restoreStatus = '';
    type RestoreProgressState = 'idle' | 'confirm' | 'running' | 'success' | 'stopped';
    let restoreProgressState: RestoreProgressState = 'idle';
    let restoreProgress = 0;
    let restoreProgressTitle = '';
    let restoreProgressDetail = '';
    let purgeStatus = '';
    let purgeResponsibilityAccepted = false;
    let purgeFinalConfirmation = false;
    let migrationConfirmed = false;
    let wipeConfirmed = false;
    let pushConfirmed = false;
    let replaceServerConfirmed = false;
    let restoreConfirmed = false;
    let restoreFilePath = '';
    let restoreFileConfirmed = false;
    let busy = false;
    let taxIncludedInPrice = $storeDB.taxIncludedInPrice;
    let syncConflicts: SyncConflict[] = [];
    let conflictStatus = '';
    const RESTORE_NOTICE_KEY = 'pos_restore_notice';

    function cleanError(error: unknown): string {
        return String(error).replace(/^Error:\s*/, '').trim();
    }

    function setRestoreProgress(
        state: RestoreProgressState,
        progress: number,
        title: string,
        detail = '',
    ) {
        restoreProgressState = state;
        restoreProgress = Math.max(0, Math.min(100, progress));
        restoreProgressTitle = title;
        restoreProgressDetail = detail;
        restoreStatus = detail || title;
    }

    function resetRestoreProgress() {
        restoreProgressState = 'idle';
        restoreProgress = 0;
        restoreProgressTitle = '';
        restoreProgressDetail = '';
        restoreStatus = '';
        restoreConfirmed = false;
        restoreFileConfirmed = false;
    }

    function stopRestoreWithError(message: string) {
        setRestoreProgress('stopped', 100, 'Restore stopped', message);
        toast(`Restore stopped: ${message}`, 'error');
    }

    function saveRestoreNotice(type: 'success' | 'error', message: string, details = '') {
        try {
            sessionStorage.setItem(RESTORE_NOTICE_KEY, JSON.stringify({ type, message, details }));
        } catch {
            // If session storage is unavailable, the on-screen status still shows the message.
        }
    }

    onMount(async () => {
        if (get(currentEmployee)?.role !== 'admin') {
            const restoreNotice = sessionStorage.getItem(RESTORE_NOTICE_KEY);
            if (!restoreNotice) {
                toast('Advanced Maintenance is available to administrators only.', 'error');
                goto('/settings');
            } else {
                goto('/setup');
            }
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

    async function replaceMariaDbFromThisTill() {
        if (!replaceServerConfirmed) {
            replaceServerConfirmed = true;
            replaceServerStatus = 'Click again to delete MariaDB business data and upload this restored till. Employees and settings are kept.';
            return;
        }
        busy = true;
        try {
            replaceServerStatus = 'Replacing MariaDB business data from this restored till...';
            await replaceMariaDbDataFromThisTill();
            replaceServerStatus = 'MariaDB was replaced from this till. Employees and settings were kept.';
        } catch (error) {
            replaceServerStatus = `MariaDB replace failed: ${cleanError(error)}`;
        } finally {
            busy = false;
            replaceServerConfirmed = false;
        }
    }

    async function restoreBackup() {
        const latest = await getLatestLocalBackup();
        if (!latest) {
            stopRestoreWithError('No local backup is available.');
            return;
        }
        if (!restoreConfirmed) {
            restoreConfirmed = true;
            restoreFileConfirmed = false;
            setRestoreProgress(
                'confirm',
                0,
                'Ready to restore latest backup',
                `Click Restore Latest Backup again to replace this till's local data with ${latest}`
            );
            restoreStatus = `Click again to replace this till’s local data with ${latest}`;
            return;
        }
        busy = true;
        try {
            setRestoreProgress('running', 20, 'Checking backup', latest);
            setRestoreProgress('running', 55, 'Creating safety backup and replacing database', 'Do not close the app while this is running.');
            const result = await restoreLatestLocalBackup();
            if (result.restartRequired) {
                setRestoreProgress(
                    'success',
                    100,
                    'Restore ready to finish',
                    `Windows is still using the current database. Close and reopen the app to finish restore. Safety backup: ${result.safetyBackup || 'not needed'}.`
                );
                busy = false;
                restoreConfirmed = false;
                return;
            }
            setRestoreProgress(
                'success',
                100,
                'Restore completed',
                `Restored ${result.restoredFrom}. Safety backup: ${result.safetyBackup || 'not needed'}. Reloading...`
            );
            saveRestoreNotice(
                'success',
                'Database restored. Continue setup or connect MariaDB to finish.',
                `Restored from: ${result.restoredFrom}. Safety backup: ${result.safetyBackup || 'not needed'}.`
            );
            setTimeout(() => window.location.reload(), 700);
        } catch (error) {
            stopRestoreWithError(cleanError(error));
            busy = false;
            restoreConfirmed = false;
        }
    }

    async function restoreDatabaseFile() {
        const path = restoreFilePath.trim();
        if (!path) {
            stopRestoreWithError('Choose the old till database file first.');
            return;
        }
        if (!restoreFileConfirmed) {
            restoreFileConfirmed = true;
            restoreConfirmed = false;
            setRestoreProgress(
                'confirm',
                0,
                'Ready to restore selected file',
                `Click Restore From File again to replace this till's local data with ${path}`
            );
            return;
        }
        busy = true;
        try {
            setRestoreProgress('running', 20, 'Checking selected database', path);
            setRestoreProgress('running', 55, 'Creating safety backup and replacing database', 'Do not close the app while this is running.');
            const result = await restoreLocalDatabaseFromPath(path);
            if (result.restartRequired) {
                setRestoreProgress(
                    'success',
                    100,
                    'Restore ready to finish',
                    `Windows is still using the current database. Close and reopen the app to finish restore. Safety backup: ${result.safetyBackup || 'not needed'}.`
                );
                busy = false;
                restoreFileConfirmed = false;
                return;
            }
            setRestoreProgress(
                'success',
                100,
                'Restore completed',
                `Restored ${result.restoredFrom}. Safety backup: ${result.safetyBackup || 'not needed'}. Reloading...`
            );
            saveRestoreNotice(
                'success',
                'Database restored. Continue setup or connect MariaDB to finish.',
                `Restored from: ${result.restoredFrom}. Safety backup: ${result.safetyBackup || 'not needed'}.`
            );
            setTimeout(() => window.location.reload(), 700);
        } catch (error) {
            stopRestoreWithError(cleanError(error));
            busy = false;
            restoreFileConfirmed = false;
        }
    }

    async function chooseRestoreDatabaseFile() {
        resetRestoreProgress();
        restoreStatus = 'Opening file picker...';
        restoreFileConfirmed = false;
        try {
            const selected = await invoke<string | null>('select_restore_database_file');
            if (!selected) {
                restoreStatus = 'No database file selected.';
                return;
            }
            restoreFilePath = selected;
            restoreStatus = `Selected database file: ${selected}`;
        } catch (error) {
            restoreStatus = `File picker failed: ${cleanError(error)}`;
            toast(restoreStatus, 'error');
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
                    <article class="danger-card">
                        <strong>Replace MariaDB From Restore</strong>
                        <p>Delete MariaDB products, customers, orders, stock, discounts, and reports, then upload this restored till. Employees and settings stay.</p>
                        <button class="btn btn-danger" disabled={busy} on:click={replaceMariaDbFromThisTill}>
                            {replaceServerConfirmed ? 'Confirm Replace MariaDB' : 'Replace MariaDB From This Till'}
                        </button>
                        {#if replaceServerStatus}<small>{replaceServerStatus}</small>{/if}
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
            <div class="restore-file-panel">
                <label for="restore-file-path">Old till database file path</label>
                <div class="restore-file-row">
                    <input
                        id="restore-file-path"
                        class="flat-input"
                        bind:value={restoreFilePath}
                        placeholder="For example: D:\old-till\pos.db"
                        on:input={() => restoreFileConfirmed = false}
                    />
                    <button class="btn btn-secondary" disabled={busy} on:click={chooseRestoreDatabaseFile}>
                        Choose File
                    </button>
                    <button class="btn btn-danger" disabled={busy || !restoreFilePath.trim()} on:click={restoreDatabaseFile}>
                        {restoreFileConfirmed ? 'Confirm Restore From File' : 'Restore From File'}
                    </button>
                </div>
                <small>Use this when moving the database from an old till. Choose the copied .db file, or paste the full path.</small>
            </div>
            {#if restoreProgressState !== 'idle'}
                <div
                    class="restore-progress-panel"
                    class:restore-stopped={restoreProgressState === 'stopped'}
                    class:restore-success={restoreProgressState === 'success'}
                >
                    <div class="restore-progress-head">
                        <div>
                            <strong>{restoreProgressTitle}</strong>
                            {#if restoreProgressDetail}
                                <p>{restoreProgressDetail}</p>
                            {/if}
                        </div>
                        <b>{restoreProgress}%</b>
                    </div>
                    <div class="restore-progress-track" aria-label="Restore progress">
                        <span style={`width: ${restoreProgress}%`}></span>
                    </div>
                    {#if restoreProgressState === 'stopped'}
                        <div class="button-row">
                            <button class="btn btn-secondary" type="button" on:click={resetRestoreProgress}>
                                Stop Restore
                            </button>
                            <button class="btn btn-primary" type="button" disabled={busy} on:click={chooseRestoreDatabaseFile}>
                                Choose Another File
                            </button>
                        </div>
                    {/if}
                </div>
            {/if}
            {#if backupStatus}<p class="status-text break-all">{backupStatus}</p>{/if}
            {#if restoreStatus}<p class="status-text break-all">{restoreStatus}</p>{/if}
        </section>
    </div>
</MgmtPage>
{/if}

<style>
    .advanced-canvas { padding: 1.25rem; display: flex; flex-direction: column; gap: 1rem; }
    .warning-banner { padding: 1rem 1.2rem; border: 1px solid var(--warning); border-radius: .8rem; background: rgba(245, 158, 11, .10); }
    .warning-banner strong { color: var(--warning); }
    .warning-banner p, .status-text { margin: .3rem 0 0; color: var(--text-muted); }
    .status-card { margin-bottom: 1rem; padding: 1rem; display: flex; align-items: center; gap: .8rem; border: 1px solid var(--border-flat); border-radius: .7rem; background: var(--bg-panel); }
    .status-card i { width: .75rem; height: .75rem; border-radius: 50%; background: var(--danger); box-shadow: 0 0 10px var(--danger); }
    .status-card i.online { background: var(--success); box-shadow: 0 0 10px var(--success); }
    .status-card div { display: flex; flex-direction: column; }
    .status-card span, article p, article small { color: var(--text-muted); }
    .button-row { display: flex; flex-wrap: wrap; gap: .65rem; }
    .restore-file-panel { margin-top: 1rem; display: grid; gap: .45rem; }
    .restore-file-panel label { font-weight: 800; color: var(--text-main); }
    .restore-file-panel small { color: var(--text-muted); }
    .restore-file-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: .65rem; align-items: stretch; }
    .restore-file-row input { min-height: 46px; }
    .restore-progress-panel { margin-top: .9rem; display: grid; gap: .7rem; padding: .9rem 1rem; border: 1px solid var(--accent-primary); border-radius: .75rem; background: var(--bg-panel); }
    .restore-progress-panel.restore-stopped { border-color: var(--danger); background: rgba(239, 68, 68, .08); }
    .restore-progress-panel.restore-success { border-color: var(--success); background: rgba(34, 197, 94, .08); }
    .restore-progress-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
    .restore-progress-head strong { color: var(--text-main); }
    .restore-progress-head p { margin: .25rem 0 0; color: var(--text-muted); overflow-wrap: anywhere; }
    .restore-progress-head b { color: var(--text-main); }
    .restore-progress-track { height: .65rem; overflow: hidden; border-radius: 999px; background: var(--border-flat); }
    .restore-progress-track span { display: block; height: 100%; border-radius: inherit; background: var(--accent-primary); transition: width .25s ease; }
    .restore-stopped .restore-progress-track span { background: var(--danger); }
    .restore-success .restore-progress-track span { background: var(--success); }
    .repair-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: .8rem; }
    .repair-grid article { padding: 1rem; display: flex; flex-direction: column; gap: .65rem; border: 1px solid var(--border-flat); border-radius: .75rem; background: var(--bg-panel); }
    .repair-grid article .btn { margin-top: auto; }
    .conflict-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 1rem; }
    .conflict-list { display: grid; gap: .7rem; }
    .conflict-list article { padding: .9rem; display: flex; align-items: center; justify-content: space-between; gap: 1rem; border: 1px solid var(--border-flat); border-radius: .7rem; background: var(--bg-panel); }
    .conflict-list article div:first-child { min-width: 0; }
    .conflict-list span { display: block; color: var(--text-muted); font-size: .78rem; }
    .conflict-list p { margin: .3rem 0 0; color: var(--danger); overflow-wrap: anywhere; }
    .danger-card { border-color: rgba(239, 68, 68, .55) !important; }
    .purge-disclaimer { max-width: 760px; margin-bottom: .8rem; padding: .9rem 1rem; border: 1px solid var(--danger); border-radius: .7rem; background: rgba(239, 68, 68, .08); }
    .purge-disclaimer strong { color: var(--danger); }
    .purge-disclaimer p { margin: .3rem 0 0; color: var(--text-muted); }
    .purge-warning { color: var(--danger); }
    .purge-warning { margin: 0 0 .8rem; font-weight: 800; }
    @media (max-width: 900px) {
        .restore-file-row { grid-template-columns: 1fr; }
        .repair-grid { grid-template-columns: 1fr; }
        .conflict-list article { align-items: stretch; flex-direction: column; }
    }
</style>
