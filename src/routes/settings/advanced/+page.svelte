<script lang="ts">
    import { onMount } from 'svelte';
    import { goto } from '$app/navigation';
    import { invoke } from '@tauri-apps/api/core';
    import { open } from '@tauri-apps/plugin-dialog';
    import { revealItemInDir } from '@tauri-apps/plugin-opener';
    import { get } from 'svelte/store';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import { connectionState } from '$lib/stores/connection';
    import { currentEmployee } from '$lib/stores/session';
    import { storeDB, now, type Store } from '$lib/stores/db';
    import { toast } from '$lib/stores/toast';
    import {
        forceFullSync,
        forcePushToServer,
        getAutomaticSetupBackupConfig,
        dismissSyncConflict,
        getSyncConflicts,
        getLatestAutomaticSetupBackup,
        getLatestLocalBackup,
        createAutomaticSetupBackup,
        createLocalBackup,
        migrateLocalDataToServer,
        purgeAllTransactions,
        restoreLatestLocalBackup,
        restoreLocalDatabaseFromPath,
        retrySyncConflict,
        setAutomaticSetupBackupEnabled,
        setAutomaticSetupBackupSchedule,
        upsert,
        validateDatabaseSchemas,
        wipeAndPullFromServer,
        type DatabaseRestoreResult,
        type SyncConflict,
    } from '$lib/stores/database';

    let schemaStatus = '';
    let migrationStatus = '';
    let syncStatus = '';
    let wipeStatus = '';
    let pushStatus = '';
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
    let restoreConfirmed = false;
    let restoreFilePath = '';
    let restoreFileConfirmed = false;
    let busy = false;
    let taxIncludedInPrice = $storeDB.taxIncludedInPrice;
    let syncConflicts: SyncConflict[] = [];
    let conflictStatus = '';
    let latestBackupPath: string | null = null;
    let latestBackupChecked = false;
    let automaticSetupBackupEnabled = true;
    let automaticSetupBackupTime = '03:00';
    let automaticSetupBackupDirectory = '';
    let latestAutomaticBackupPath: string | null = null;
    let automaticBackupStatus = '';
    const RESTORE_NOTICE_KEY = 'pos_restore_notice';

    function cleanError(error: unknown): string {
        return String(error).replace(/^Error:\s*/, '').trim();
    }

    function backupFileName(path: string | null): string {
        if (!path) return '';
        return path.split(/[\\/]/).pop() || path;
    }

    function fullBackupDateTime(path: string | null): string {
        const match = backupFileName(path).match(
            /^pos-backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-(\d{3}))?\.db$/,
        );
        if (!match) return 'Unknown backup time';
        const [, year, month, day, hour, minute, second, milliseconds = '0'] = match;
        const createdAt = new Date(Date.UTC(
            Number(year),
            Number(month) - 1,
            Number(day),
            Number(hour),
            Number(minute),
            Number(second),
            Number(milliseconds),
        ));
        if (Number.isNaN(createdAt.getTime())) return 'Unknown backup time';
        return createdAt.toLocaleString('en-GB', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
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

    function completeRestore(result: DatabaseRestoreResult, clearConfirmation: () => void) {
        const isMultiMode = get(connectionState).mode === 'multi';
        const safetyDetail = `Safety backup: ${result.safetyBackup || 'not needed'}.`;

        if (result.restartRequired) {
            const detail = isMultiMode
                ? `The operating system is still using the current database. Close and reopen the app, then finish the MariaDB restore from Setup. ${safetyDetail}`
                : `The operating system is still using the current database. Close and reopen the app to finish the restore. ${safetyDetail}`;
            const message = isMultiMode
                ? 'Local database restore is ready. Reopen the app, then finish MariaDB restore from Setup.'
                : 'Local database restore is ready. Close and reopen the app to finish it.';

            setRestoreProgress('success', 100, 'Restore ready to finish', detail);
            saveRestoreNotice('success', message, safetyDetail);
            busy = false;
            clearConfirmation();
            return;
        }

        const detail = isMultiMode
            ? `Restored ${result.restoredFrom}. ${safetyDetail} Opening Setup...`
            : `Restored ${result.restoredFrom}. ${safetyDetail} Reloading...`;
        const message = isMultiMode
            ? 'Local database restored. Finish MariaDB restore from Setup before using the POS.'
            : 'Local database restored. Reloading the app.';

        setRestoreProgress('success', 100, 'Restore completed', detail);
        saveRestoreNotice(
            'success',
            message,
            `Restored from: ${result.restoredFrom}. ${safetyDetail}`
        );
        setTimeout(() => {
            if (isMultiMode) {
                window.location.assign('/setup');
            } else {
                window.location.reload();
            }
        }, 700);
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
        await Promise.all([
            refreshConflicts(),
            refreshLatestBackup(),
            refreshAutomaticBackup(),
        ]);
    });

    async function refreshAutomaticBackup() {
        try {
            const config = await getAutomaticSetupBackupConfig();
            automaticSetupBackupEnabled = config.enabled;
            automaticSetupBackupTime = config.time;
            automaticSetupBackupDirectory = config.directory;
            latestAutomaticBackupPath = await getLatestAutomaticSetupBackup(config.directory);
        } catch (error) {
            automaticBackupStatus = `Could not check automatic setup backups: ${cleanError(error)}`;
        }
    }

    async function toggleAutomaticSetupBackup() {
        const enabled = !automaticSetupBackupEnabled;
        automaticSetupBackupEnabled = enabled;
        try {
            await setAutomaticSetupBackupEnabled(enabled);
            automaticBackupStatus = enabled
                ? 'Daily shop setup backup enabled.'
                : 'Daily shop setup backup disabled.';
        } catch (error) {
            automaticSetupBackupEnabled = !enabled;
            automaticBackupStatus = `Could not save automatic backup setting: ${cleanError(error)}`;
        }
    }

    async function createSetupBackupNow() {
        busy = true;
        automaticBackupStatus = 'Creating shop setup backup...';
        try {
            await setAutomaticSetupBackupSchedule(
                automaticSetupBackupTime,
                automaticSetupBackupDirectory,
            );
            const result = await createAutomaticSetupBackup(automaticSetupBackupDirectory);
            latestAutomaticBackupPath = result.path;
            automaticBackupStatus = result.created
                ? `Shop setup backup created and verified: ${backupFileName(result.path)}`
                : `Today's shop setup backup is already ready: ${backupFileName(result.path)}`;
        } catch (error) {
            automaticBackupStatus = `Shop setup backup failed: ${cleanError(error)}`;
        } finally {
            busy = false;
        }
    }

    async function saveAutomaticBackupConfiguration() {
        busy = true;
        automaticBackupStatus = 'Saving automatic backup schedule...';
        try {
            await setAutomaticSetupBackupSchedule(
                automaticSetupBackupTime,
                automaticSetupBackupDirectory,
            );
            latestAutomaticBackupPath = await getLatestAutomaticSetupBackup(
                automaticSetupBackupDirectory,
            );
            latestBackupPath = await getLatestLocalBackup(automaticSetupBackupDirectory);
            automaticBackupStatus = `Automatic setup backup scheduled daily at ${automaticSetupBackupTime}.`;
        } catch (error) {
            automaticBackupStatus = `Could not save automatic backup schedule: ${cleanError(error)}`;
        } finally {
            busy = false;
        }
    }

    async function chooseAutomaticBackupDirectory() {
        automaticBackupStatus = 'Opening folder picker...';
        try {
            const selected = await open({
                directory: true,
                multiple: false,
                title: 'Choose backup destination',
            });
            const directory = Array.isArray(selected) ? selected[0] : selected;
            if (!directory) {
                automaticBackupStatus = 'Backup folder was not changed.';
                return;
            }
            automaticSetupBackupDirectory = directory;
            await saveAutomaticBackupConfiguration();
        } catch (error) {
            automaticBackupStatus = `Could not choose backup folder: ${cleanError(error)}`;
        }
    }

    async function useDefaultAutomaticBackupDirectory() {
        automaticSetupBackupDirectory = '';
        await saveAutomaticBackupConfiguration();
    }

    async function openBackupFolder() {
        const path = latestBackupPath || latestAutomaticBackupPath;
        if (!path) {
            automaticBackupStatus = 'Create a backup first, then its exact folder can be opened.';
            return;
        }
        try {
            await revealItemInDir(path);
            automaticBackupStatus = `Opened backup location: ${path}`;
        } catch (error) {
            automaticBackupStatus = `Could not open backup folder: ${cleanError(error)}`;
        }
    }

    async function refreshLatestBackup() {
        try {
            latestBackupPath = await getLatestLocalBackup();
        } catch (error) {
            backupStatus = `Could not check local backups: ${cleanError(error)}`;
        } finally {
            latestBackupChecked = true;
        }
    }

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
        latestBackupPath = latest;
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
                `Click restore again to use the full backup from ${fullBackupDateTime(latest)}. File: ${latest}`
            );
            restoreStatus = `Click again to restore the backup from ${fullBackupDateTime(latest)}.`;
            return;
        }
        busy = true;
        try {
            setRestoreProgress('running', 20, 'Checking backup', latest);
            setRestoreProgress('running', 55, 'Creating safety backup and replacing database', 'Do not close the app while this is running.');
            const result = await restoreLatestLocalBackup();
            completeRestore(result, () => restoreConfirmed = false);
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
            completeRestore(result, () => restoreFileConfirmed = false);
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
        backupStatus = 'Creating full backup...';
        try {
            await setAutomaticSetupBackupSchedule(
                automaticSetupBackupTime,
                automaticSetupBackupDirectory,
            );
            latestBackupPath = await createLocalBackup(automaticSetupBackupDirectory);
            latestBackupChecked = true;
            backupStatus = `Full backup created and verified: ${latestBackupPath}`;
        } catch (error) {
            backupStatus = `Backup failed: ${cleanError(error)}`;
        } finally {
            busy = false;
        }
    }

    async function purgeTransactions() {
        if (!purgeResponsibilityAccepted) {
            purgeStatus = 'Confirm that you understand this action permanently deletes sales and transaction history.';
            return;
        }
        if (!purgeFinalConfirmation) {
            purgeFinalConfirmation = true;
            purgeStatus = 'Final warning: click Delete History Permanently again to continue.';
            return;
        }
        busy = true;
        purgeStatus = 'Deleting history from every till...';
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

        <section class="settings-section">
            <div class="backup-heading">
                <div>
                    <h3 class="settings-section-title">Backup and Restore</h3>
                    <p class="text-text-muted">
                        Manual full backups include the complete local database, including sales and orders.
                    </p>
                </div>
                <div class="backup-state" class:has-backup={Boolean(latestBackupPath)}>
                    <strong>
                        {latestBackupPath
                            ? `Latest full backup: ${fullBackupDateTime(latestBackupPath)}`
                            : latestBackupChecked ? 'No full backup' : 'Checking backups'}
                    </strong>
                    <span>{latestBackupPath || 'Create a backup before using repair tools.'}</span>
                </div>
            </div>
            {#if $connectionState.mode === 'multi'}
                <p class="backup-mode-note">
                    Creating a backup only writes a file to the destination below. It does not change this till's live database or MariaDB.
                </p>
            {/if}
            <div class="button-row mt-4">
                <button class="btn btn-primary" disabled={busy} on:click={createBackup}>
                    {busy && backupStatus === 'Creating full backup...' ? 'Creating Full Backup...' : 'Create Full Backup'}
                </button>
                <button class="btn btn-danger" disabled={busy || !latestBackupPath} on:click={restoreBackup}>
                    {restoreConfirmed
                        ? `Confirm Restore - ${fullBackupDateTime(latestBackupPath)}`
                        : latestBackupPath
                            ? `Restore Backup - ${fullBackupDateTime(latestBackupPath)}`
                            : 'Restore Backup'}
                </button>
            </div>
            <div class="automatic-backup-row">
                <div class="automatic-backup-copy">
                    <strong>Daily Shop Setup Backup</strong>
                    <span>Includes shop setup, products, current stock, customers, staff, settings and layouts. Sales and orders are excluded. Only the newest two daily files are kept.</span>
                    <small>
                        {latestAutomaticBackupPath
                            ? `Latest: ${backupFileName(latestAutomaticBackupPath)}`
                            : 'No automatic setup backup created yet.'}
                    </small>
                </div>
                <div class="automatic-backup-actions">
                    <button
                        type="button"
                        class="backup-toggle"
                        class:enabled={automaticSetupBackupEnabled}
                        role="switch"
                        aria-checked={automaticSetupBackupEnabled}
                        disabled={busy}
                        on:click={toggleAutomaticSetupBackup}
                    >
                        <i></i>
                        {automaticSetupBackupEnabled ? 'Automatic On' : 'Automatic Off'}
                    </button>
                    <button class="btn btn-secondary" disabled={busy} on:click={createSetupBackupNow}>
                        Create Setup Backup Now
                    </button>
                </div>
                <div class="automatic-backup-config">
                    <label for="automatic-backup-time">
                        <span>Daily time</span>
                        <input
                            id="automatic-backup-time"
                            class="flat-input"
                            type="time"
                            bind:value={automaticSetupBackupTime}
                            disabled={busy}
                        />
                    </label>
                    <label class="backup-directory-field" for="automatic-backup-directory">
                        <span>Backup destination (Full + Setup)</span>
                        <input
                            id="automatic-backup-directory"
                            class="flat-input"
                            value={automaticSetupBackupDirectory}
                            placeholder="Protected app backup folder (default)"
                            readonly
                            title={automaticSetupBackupDirectory || 'Protected app backup folder'}
                        />
                    </label>
                    <button class="btn btn-secondary" disabled={busy} on:click={chooseAutomaticBackupDirectory}>
                        Choose Folder
                    </button>
                    <div class="backup-folder-actions">
                        <button class="btn btn-secondary" disabled={busy || !automaticSetupBackupDirectory} on:click={useDefaultAutomaticBackupDirectory}>
                            Use Default
                        </button>
                        <button class="btn btn-secondary" disabled={busy || (!latestBackupPath && !latestAutomaticBackupPath)} on:click={openBackupFolder}>
                            Open Folder
                        </button>
                        <button class="btn btn-primary" disabled={busy} on:click={saveAutomaticBackupConfiguration}>
                            Save Schedule
                        </button>
                    </div>
                </div>
                <small class="cloud-folder-note">A OneDrive, Google Drive, Dropbox or iCloud Drive folder will be uploaded by its desktop sync application.</small>
            </div>
            {#if automaticBackupStatus}<p class="status-text break-all">{automaticBackupStatus}</p>{/if}
            <details class="restore-file-panel">
                <summary>Restore from another till database</summary>
                <label for="restore-file-path">Database file</label>
                <div class="restore-file-row">
                    <input
                        id="restore-file-path"
                        class="flat-input"
                        bind:value={restoreFilePath}
                        placeholder="Choose a .db file or paste its full path"
                        on:input={() => restoreFileConfirmed = false}
                    />
                    <button class="btn btn-secondary" disabled={busy} on:click={chooseRestoreDatabaseFile}>
                        Choose File
                    </button>
                    <button class="btn btn-danger" disabled={busy || !restoreFilePath.trim()} on:click={restoreDatabaseFile}>
                        {restoreFileConfirmed ? 'Confirm Restore From File' : 'Restore From File'}
                    </button>
                </div>
                <small>The selected database is checked before the current till database is closed or replaced.</small>
            </details>
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
                                Dismiss
                            </button>
                            <button class="btn btn-primary" type="button" disabled={busy} on:click={chooseRestoreDatabaseFile}>
                                Choose Another File
                            </button>
                        </div>
                    {/if}
                </div>
            {/if}
            {#if backupStatus}<p class="status-text break-all">{backupStatus}</p>{/if}
            {#if restoreStatus && restoreProgressState === 'idle'}<p class="status-text break-all">{restoreStatus}</p>{/if}
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
            <h3 class="settings-section-title !text-danger">Delete History</h3>
            <p class="text-text-muted mb-3">
                This permanently removes sales and transaction history from this database and every connected till. Are you sure you want to continue?
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
                <span class="font-bold">I understand this permanently deletes database history from all tills. Are you sure you want to continue?</span>
                <b class="shrink-0 text-xs uppercase tracking-[0.12em]">{purgeResponsibilityAccepted ? 'Accepted' : 'Required'}</b>
            </button>
            <button
                class="btn btn-danger"
                disabled={busy || !purgeResponsibilityAccepted}
                on:click={purgeTransactions}
            >
                {busy ? 'Deleting History…' : purgeFinalConfirmation ? 'Delete History Permanently' : 'Continue to Final Confirmation'}
            </button>
            {#if purgeStatus}<p class="status-text">{purgeStatus}</p>{/if}
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
    .backup-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
    .backup-heading .settings-section-title { margin-bottom: .35rem; }
    .backup-state { min-width: 220px; padding: .8rem 1rem; display: flex; flex-direction: column; border: 1px solid var(--border-flat); border-radius: .55rem; background: var(--bg-panel); }
    .backup-state.has-backup { border-color: var(--success); background: rgba(34, 197, 94, .08); }
    .backup-state strong { color: var(--text-main); }
    .backup-state span { margin-top: .15rem; color: var(--text-muted); font-size: .78rem; overflow-wrap: anywhere; }
    .backup-mode-note { margin-top: .8rem; padding: .65rem .8rem; border-left: 3px solid var(--accent-primary); background: var(--bg-panel); }
    .automatic-backup-row { margin-top: 1rem; padding-top: 1rem; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 1rem; border-top: 1px solid var(--border-flat); }
    .automatic-backup-copy { min-width: 0; display: flex; flex-direction: column; gap: .25rem; }
    .automatic-backup-row strong { color: var(--text-main); }
    .automatic-backup-row span, .automatic-backup-row small { color: var(--text-muted); }
    .automatic-backup-row small { overflow-wrap: anywhere; }
    .automatic-backup-actions { display: flex; flex: 0 0 auto; align-items: center; gap: .65rem; }
    .automatic-backup-config { grid-column: 1 / -1; display: grid; grid-template-columns: 145px minmax(230px, 1fr) auto; align-items: end; gap: .65rem; }
    .automatic-backup-config label { min-width: 0; display: flex; flex-direction: column; gap: .35rem; color: var(--text-main); font-weight: 800; }
    .automatic-backup-config label > span { color: var(--text-muted); font-size: .76rem; }
    .automatic-backup-config input { min-height: 46px; width: 100%; }
    .backup-directory-field { min-width: 0; }
    .backup-directory-field input { overflow: hidden; text-overflow: ellipsis; }
    .backup-folder-actions { grid-column: 2 / -1; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: .65rem; }
    .cloud-folder-note { grid-column: 1 / -1; }
    .backup-toggle { min-height: 46px; padding: .6rem .8rem; display: inline-flex; align-items: center; gap: .5rem; color: var(--text-muted); border: 1px solid var(--border-flat); border-radius: .4rem; background: var(--bg-card); font-weight: 850; }
    .backup-toggle i { width: 1rem; height: 1rem; border: 2px solid currentColor; border-radius: .2rem; background: transparent; }
    .backup-toggle.enabled { color: var(--success); border-color: var(--success); background: rgba(34, 197, 94, .08); }
    .backup-toggle.enabled i { background: currentColor; box-shadow: inset 0 0 0 3px var(--bg-card); }
    .restore-file-panel { margin-top: 1rem; padding: .8rem; border: 1px solid var(--border-flat); border-radius: .55rem; background: var(--bg-panel); }
    .restore-file-panel[open] { display: grid; gap: .55rem; }
    .restore-file-panel summary { cursor: pointer; color: var(--text-main); font-weight: 850; }
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
    .restore-progress-track span { display: block; height: 100%; border-radius: inherit; background: var(--accent-primary); }
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
        .backup-heading { flex-direction: column; }
        .backup-state { width: 100%; min-width: 0; }
        .automatic-backup-row { grid-template-columns: 1fr; align-items: stretch; }
        .automatic-backup-actions { flex-wrap: wrap; }
        .automatic-backup-config { grid-template-columns: 1fr 1fr; }
        .backup-directory-field { grid-column: 1 / -1; }
        .backup-folder-actions { grid-column: 1 / -1; justify-content: flex-start; }
        .restore-file-row { grid-template-columns: 1fr; }
        .repair-grid { grid-template-columns: 1fr; }
        .conflict-list article { align-items: stretch; flex-direction: column; }
    }
</style>
