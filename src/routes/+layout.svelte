<script lang="ts">
    import { onDestroy, onMount } from 'svelte';
    import { goto } from '$app/navigation';
    import { isTauri } from '@tauri-apps/api/core';
    import { connectionState, loadSavedMode, type MysqlConfig } from '$lib/stores/connection';
    import { initMysqlDb } from '$lib/stores/mysql';
    import '../app.css';
    import Toast from '$lib/components/Toast.svelte';
    import { initDb, migrateFromLocalStorage } from '$lib/stores/sqlite';
    import {
        ensureDatabaseIdentityForSync,
        getLightRouteHydrationTables,
        hasRestorePendingMariaDbReplace,
        hydrateSvelteStores,
        isLightStorePath,
        reconcileServerDataEpochBeforeFinancialRecovery,
        recoverOnlineFinancialIntent,
        RESTORE_PENDING_MARIADB_REPLACE_MESSAGE,
        runAutomaticSetupBackupIfEnabled,
        startBackgroundSync,
        verifyDatabaseIdentityBeforeSchemaMutation
    } from '$lib/stores/database';
    import {
        productsDB, categoriesDB, posPagesDB, tilesDB, taxRatesDB, employeesDB,
        settingsDB, customersDB, storeDB, registersDB, discountsDB,
        promoGroupsDB, promoGroupItemsDB, auditLogDB
    } from '$lib/stores/db';
    import { get } from 'svelte/store';
    import { activeTheme, hydrateTheme } from '$lib/stores/theme';
    import { applyTypography } from '$lib/typography';
    import { page } from '$app/stores';
    import {
        currentEmployee,
        currentShiftId,
        currentEmployeeSessionVersionMatches,
        isSupportEmployee,
        logout,
        normalizeEmployeeForRuntime,
        revalidateCurrentEmployeeSession,
    } from '$lib/stores/session';
    import { toast } from '$lib/stores/toast';
    import { canAccessPath } from '$lib/permissions';
    import { playCartButtonFeedback, primeSoundEngine } from '$lib/sounds';
    import GlobalTouchInput from '$lib/components/GlobalTouchInput.svelte';
    import BackOfficeSidebar from '$lib/components/BackOfficeSidebar.svelte';
    import SystemPrintHost from '$lib/components/SystemPrintHost.svelte';
    import LicenseNoticeDialog from '$lib/components/LicenseNoticeDialog.svelte';
    import { startCustomerDisplayAutoOpenWatcher } from '$lib/customerDisplay';
    import { markAppNavigation } from '$lib/navigation';
    import { OWNER_CLOUD_ACTIVATION_EVENT, shouldStartOwnerCloudReporter } from '$lib/ownerCloudConfig';
    import { runTerminalRecovery } from '$lib/terminalRecovery';
    import { cashbackRecoveryMessage } from '$lib/paymentExtraPresentation';
    import {
        deviceOperatingMode,
        isBackOfficeBlockedPath,
        loadDeviceOperatingMode,
    } from '$lib/deviceMode';

    let dbReady = false;
    let dbError = '';
    let syncStartupRetry: ReturnType<typeof setInterval> | null = null;
    let syncStartupRunning = false;
    let mysqlSchemaReadyConfigKey = '';
    let stopCustomerDisplayAutoOpen: (() => void) | null = null;
    let stopOwnerCloudReporter: (() => void) | null = null;
    let ownerCloudStartupTimer: ReturnType<typeof setTimeout> | null = null;
    let ownerCloudActivationListener: (() => void) | null = null;
    let restorePendingMariaDbReplace = false;
    let lightStoreHydrationRunning = false;
    let queuedLightHydrationPath: string | null = null;
    let lastLightHydrationPath = '';
    let automaticBackupStartTimeout: ReturnType<typeof setTimeout> | null = null;
    let automaticBackupInterval: ReturnType<typeof setInterval> | null = null;
    let automaticBackupRunning = false;
    let terminalRecoveryInterval: ReturnType<typeof setInterval> | null = null;
    let terminalRecoveryRunning = false;
    const SYNC_STARTUP_RETRY_MS = 60 * 1000;
    const AUTOMATIC_BACKUP_START_DELAY_MS = 2 * 60 * 1000;
    const AUTOMATIC_BACKUP_CHECK_MS = 5 * 60 * 1000;
    let fullStoresHydrated = false;
    let lastRevokedEmployeeId = '';
    let employeeAuthorityRevalidationKey = '';
    let employeeAuthorityRevalidationRunning = false;
    let employeeAuthorityRevalidationInterval: ReturnType<typeof setInterval> | null = null;
    $: backOfficeWorkspaceVisible = dbReady
        && $deviceOperatingMode === 'back_office'
        && Boolean($currentEmployee)
        && $currentEmployee?.role !== 'attendance'
        && $page.url.pathname !== '/'
        && $page.url.pathname !== '/setup'
        && !isBackOfficeBlockedPath($page.url.pathname);

    if (typeof window === 'undefined' || window.location.pathname !== '/customer-display') {
        primeSoundEngine();
    }

    function clearSyncStartupRetry() {
        if (syncStartupRetry) {
            clearInterval(syncStartupRetry);
            syncStartupRetry = null;
        }
    }

    function clearAutomaticBackupSchedule() {
        if (automaticBackupStartTimeout) {
            clearTimeout(automaticBackupStartTimeout);
            automaticBackupStartTimeout = null;
        }
        if (automaticBackupInterval) {
            clearInterval(automaticBackupInterval);
            automaticBackupInterval = null;
        }
    }

    async function recoverManagedTerminalWork() {
        if (terminalRecoveryRunning) return;
        terminalRecoveryRunning = true;
        try {
            const result = await runTerminalRecovery();
            for (const cashback of result.cashbackToReview) {
                toast(cashbackRecoveryMessage(cashback), 'error', false, undefined, { persistent: true });
            }
            if (result.errors.length > 0) {
                console.warn('POS: managed terminal recovery needs attention:', result.errors);
            }
        } catch (error) {
            console.warn('POS: managed terminal recovery deferred:', error);
        } finally {
            terminalRecoveryRunning = false;
        }
    }

    function startTerminalRecoverySchedule() {
        if (terminalRecoveryInterval) return;
        void recoverManagedTerminalWork();
        terminalRecoveryInterval = setInterval(() => {
            void recoverManagedTerminalWork();
        }, 60_000);
    }

    async function checkAutomaticSetupBackup() {
        if (automaticBackupRunning) return;
        automaticBackupRunning = true;
        try {
            const result = await runAutomaticSetupBackupIfEnabled();
            if (result?.created) {
                console.log(`POS: daily shop setup backup created at ${result.path}`);
            }
        } catch (error) {
            console.warn('POS: automatic shop setup backup failed:', error);
        } finally {
            automaticBackupRunning = false;
        }
    }

    function startAutomaticBackupSchedule() {
        clearAutomaticBackupSchedule();
        automaticBackupStartTimeout = setTimeout(() => {
            automaticBackupStartTimeout = null;
            void checkAutomaticSetupBackup();
            automaticBackupInterval = setInterval(() => {
                void checkAutomaticSetupBackup();
            }, AUTOMATIC_BACKUP_CHECK_MS);
        }, AUTOMATIC_BACKUP_START_DELAY_MS);
    }

    async function startOwnerCloudReporterIfNeeded(force = false) {
        if (stopOwnerCloudReporter || window.location.pathname === '/customer-display') return;
        if (!force && !await shouldStartOwnerCloudReporter()) return;
        try {
            const reporterModule = await import('$lib/ownerCloudReporter');
            stopOwnerCloudReporter = reporterModule.startOwnerCloudReporter();
        } catch (error) {
            console.warn('owner cloud: delayed startup failed', error);
        }
    }

    function isDatabaseStartupSafetyBlock(error: unknown): boolean {
        const message = String(error);
        return message.includes('DATABASE_IDENTITY_MISMATCH')
            || message.includes('DATABASE_IDENTITY_UNVERIFIED')
            || message.includes('MARIADB_RESTORE_MAINTENANCE');
    }

    function mysqlSchemaConfigKey(config: MysqlConfig): string {
        return `${config.user}@${config.host}:${config.port}/${config.database}`;
    }

    function isTransientMariaDbStartupError(error: unknown): boolean {
        const message = String(error).toLowerCase();
        return [
            'connection timed out',
            'connect timeout',
            'connection refused',
            'connection reset',
            'connection closed',
            'connection was reset while opening',
            'server has gone away',
            'lost connection',
            'broken pipe',
            'network is unreachable',
            'temporary failure',
            'temporarily unavailable',
            'too many connections',
            'deadlock found',
            'lock wait timeout',
            'try restarting transaction',
            'dns',
            'econnrefused',
            'econnreset',
            'etimedout',
        ].some((fragment) => message.includes(fragment));
    }

    function isDeterministicMariaDbStartupError(error: unknown): boolean {
        const message = String(error);
        const normalized = message.toLowerCase();
        return message.includes('MARIADB_SCHEMA_MIGRATION_FAILED')
            || message.includes('MARIADB_ACCOUNT_MIGRATION_BLOCKED')
            || message.includes('MARIADB_IDENTIFIER_COLLATION_MIGRATION_FAILED')
            || message.includes('MARIADB_CUSTOMER_COLLATION_MIGRATION_FAILED')
            || message.includes('MariaDB schema migration failed')
            || message.includes('MariaDB customer account migration stopped')
            || normalized.includes('illegal mix of collations')
            || normalized.includes('unknown collation')
            || normalized.includes('collation is not valid')
            || normalized.includes('duplicate values exist')
            || normalized.includes('duplicate entry')
            || normalized.includes('command denied')
            || normalized.includes('access denied')
            || normalized.includes('trigger already exists')
            || normalized.includes('data too long')
            || normalized.includes('cannot be null')
            || normalized.includes('foreign key constraint');
    }

    async function startMultiTillSyncWhenReady(config: MysqlConfig) {
        if (syncStartupRunning) return;
        syncStartupRunning = true;
        connectionState.update((state) => ({
            ...state,
            mysqlReady: false,
            mysqlStatus: 'pending',
        }));
        const schemaConfigKey = mysqlSchemaConfigKey(config);
        let startupStage: 'identity-preflight' | 'schema' | 'identity' | 'epoch' | 'financial-recovery' | 'background-sync' = 'identity-preflight';
        try {
            await verifyDatabaseIdentityBeforeSchemaMutation();
            if (mysqlSchemaReadyConfigKey !== schemaConfigKey) {
                startupStage = 'schema';
                await initMysqlDb(config);
                mysqlSchemaReadyConfigKey = schemaConfigKey;
            }
            startupStage = 'identity';
            await ensureDatabaseIdentityForSync();
            startupStage = 'epoch';
            await reconcileServerDataEpochBeforeFinancialRecovery();
            startupStage = 'financial-recovery';
            await recoverOnlineFinancialIntent(config);
            clearSyncStartupRetry();
            startupStage = 'background-sync';
            await startBackgroundSync();
            connectionState.update((state) => ({
                ...state,
                mysqlOnline: true,
                mysqlReady: true,
                mysqlStatus: 'online',
                syncError: null,
            }));
            startTerminalRecoverySchedule();
        } catch (error) {
            console.warn('POS: MariaDB sync blocked/deferred:', error);
            const transientStartupFailure = isTransientMariaDbStartupError(error);
            // Once DDL/hardening has returned a non-transport error, another
            // timer pass would execute the same migration sequence against the
            // same data. Keep the error visible and wait for an operator fix or
            // an app restart instead of hammering MariaDB every minute.
            const knownDeterministicFailure = isDeterministicMariaDbStartupError(error);
            const deterministicSchemaFailure = startupStage === 'schema'
                && (knownDeterministicFailure || !transientStartupFailure);
            const syncError = deterministicSchemaFailure
                ? `MariaDB schema setup is blocked and automatic retries have stopped: ${String(error)}`
                : String(error);
            connectionState.update((state) => ({
                ...state,
                mysqlOnline: false,
                mysqlReady: false,
                mysqlStatus: transientStartupFailure ? 'offline' : 'blocked',
                syncError,
            }));

            if (isDatabaseStartupSafetyBlock(error) || deterministicSchemaFailure) {
                clearSyncStartupRetry();
                return;
            }

            if (!syncStartupRetry) {
                syncStartupRetry = setInterval(() => {
                    void startMultiTillSyncWhenReady(config);
                }, SYNC_STARTUP_RETRY_MS);
            }
        } finally {
            syncStartupRunning = false;
        }
    }

    function handleGlobalButtonFeedback(event: PointerEvent) {
        const control = (event.target as HTMLElement | null)?.closest('button, a[href], [role="button"]') as HTMLElement | null;
        if (!control || control.matches(':disabled, [aria-disabled="true"], .menu-link-disabled, [data-feedback-silent="true"]')) return;
        playCartButtonFeedback();
    }

    async function startBrowserPreviewMode() {
        console.warn('POS: Running outside Tauri; using seeded in-memory preview data.');
        const operatingMode = await loadDeviceOperatingMode();
        connectionState.update((state) => ({
            ...state,
            mode: 'single',
            mysqlOnline: false,
            mysqlReady: false,
            syncError: null,
        }));
        hydrateTheme(get(settingsDB));

        if (get(customersDB).length === 0) {
            const timestamp = new Date().toISOString();
            customersDB.set([{
                id: 'browser-preview-customer',
                name: 'Preview Customer',
                phone: '07123 456789',
                email: 'preview@example.com',
                postcode: 'LU1 1AA',
                loyaltyCode: '90000001',
                loyaltyPoints: 150,
                notes: 'In-memory browser preview customer',
                createdAt: timestamp,
                updatedAt: timestamp,
            }]);
        }

        const previewEmployee = get(employeesDB).find((employee) =>
            employee.isActive && employee.role === 'admin'
        ) || get(employeesDB).find((employee) => employee.isActive) || null;
        if (get(auditLogDB).length === 0 && previewEmployee) {
            const previewProduct = get(productsDB).find((product) => product.isActive) || get(productsDB)[0];
            const productId = previewProduct?.id || 'browser-preview-product';
            const productName = previewProduct?.name || 'Preview Item';
            const baseTime = Date.now();
            const auditTime = (minutesAgo: number) => new Date(baseTime - minutesAgo * 60_000).toISOString();
            auditLogDB.set([
                {
                    id: 'browser-preview-audit-sale',
                    employeeId: previewEmployee.id,
                    action: 'sale_completed',
                    entityType: 'order',
                    entityId: 'browser-preview-order',
                    oldData: '',
                    newData: JSON.stringify({
                        orderNumber: 1000042,
                        total: 625,
                        paymentMethod: 'cash+loyalty',
                        loyaltyCreditUsed: 125,
                        itemLines: 2,
                        itemQuantity: 3,
                    }),
                    createdAt: auditTime(2),
                },
                {
                    id: 'browser-preview-audit-product',
                    employeeId: previewEmployee.id,
                    action: 'product_updated',
                    entityType: 'product',
                    entityId: productId,
                    oldData: JSON.stringify({ id: productId, name: productName, price: 250, isActive: 1 }),
                    newData: JSON.stringify({ id: productId, name: productName, price: 275, isActive: 1 }),
                    createdAt: auditTime(5),
                },
                {
                    id: 'browser-preview-audit-setting',
                    employeeId: previewEmployee.id,
                    action: 'setting_updated',
                    entityType: 'setting',
                    entityId: 'cctv_pos_enabled',
                    oldData: JSON.stringify({ key: 'cctv_pos_enabled', value: 'false' }),
                    newData: JSON.stringify({ key: 'cctv_pos_enabled', value: 'true' }),
                    createdAt: auditTime(8),
                },
                {
                    id: 'browser-preview-audit-login',
                    employeeId: previewEmployee.id,
                    action: 'employee_login',
                    entityType: 'employee',
                    entityId: previewEmployee.id,
                    oldData: '',
                    newData: JSON.stringify({ id: previewEmployee.id, name: previewEmployee.name, role: previewEmployee.role }),
                    createdAt: auditTime(12),
                },
            ]);
        }
        if (!get(currentEmployee) && previewEmployee && window.location.pathname !== '/') {
            currentEmployee.set(previewEmployee);
        }
        if (operatingMode === 'checkout' && !get(currentShiftId)) {
            currentShiftId.set('browser-preview-shift');
        } else if (operatingMode === 'back_office') {
            currentShiftId.set('');
        }
        dbReady = true;
    }

    async function hydrateLightStoresForTillRoute(pathname = window.location.pathname) {
        queuedLightHydrationPath = pathname;
        if (lightStoreHydrationRunning) return;
        lightStoreHydrationRunning = true;
        try {
            while (queuedLightHydrationPath) {
                const targetPath = queuedLightHydrationPath;
                queuedLightHydrationPath = null;
                try {
                    await hydrateSvelteStores(getLightRouteHydrationTables(targetPath));
                    fullStoresHydrated = false;
                    if (window.location.pathname === targetPath) {
                        lastLightHydrationPath = targetPath;
                    }
                } catch (error) {
                    console.warn(`POS: light store hydration failed for ${targetPath}:`, error);
                }
            }
        } finally {
            lightStoreHydrationRunning = false;
        }
    }

    onMount(async () => {
        employeeAuthorityRevalidationInterval = setInterval(() => {
            const state = get(connectionState);
            const employee = get(currentEmployee);
            if (
                state.mode === 'multi'
                && state.mysqlOnline
                && state.mysqlReady
                && employee
                && !isSupportEmployee(employee)
                && !employeeAuthorityRevalidationRunning
            ) {
                void revalidateEmployeeAgainstMariaDb(employee.id);
            }
        }, 30_000);
        try {
            if (!isTauri()) {
                await startBrowserPreviewMode();
                return;
            }

            const startupPath = window.location.pathname;
            if (startupPath === '/customer-display') {
                // The main window owns schema setup. This read-only window must
                // never execute migrations or start another sync engine.
                await loadDeviceOperatingMode();
                lastLightHydrationPath = startupPath;
                await hydrateSvelteStores(getLightRouteHydrationTables(startupPath));
                dbReady = true;
                return;
            }
            console.log("POS: Starting DB init...");
            await initDb();
            console.log("POS: DB init done.");
            await loadDeviceOperatingMode();

            // 1. One-time seed (only runs when products table is empty).
            console.log("POS: Starting migration...");
            await migrateFromLocalStorage({
                products: get(productsDB),
                categories: get(categoriesDB),
                posPages: get(posPagesDB),
                posTiles: get(tilesDB),
                taxRates: get(taxRatesDB),
                employees: get(employeesDB),
                settings: get(settingsDB),
                registers: get(registersDB),
                discounts: get(discountsDB)
            });
            console.log("POS: Migration done.");

            // 2. Check saved POS mode (single / multi).
            const savedMode = await loadSavedMode();

            // 3. Hydrate stores from the correct data source.
            // Always hydrate from local SQLite instantly first
            console.log("POS: Hydrating stores from SQLite…");
            const lightStartup = isLightStorePath(startupPath);
            if (lightStartup) {
                lastLightHydrationPath = startupPath;
                await hydrateLightStoresForTillRoute(startupPath);
            } else {
                await hydrateSvelteStores();
                fullStoresHydrated = true;
                lastLightHydrationPath = '';
            }

            restorePendingMariaDbReplace = savedMode === 'multi'
                && await hasRestorePendingMariaDbReplace();

            if (restorePendingMariaDbReplace) {
                connectionState.update((state) => ({
                    ...state,
                    mysqlOnline: false,
                    mysqlReady: false,
                    mysqlStatus: 'blocked',
                    syncError: RESTORE_PENDING_MARIADB_REPLACE_MESSAGE,
                }));
            } else if (savedMode === 'multi') {
                // Run server schema migrations on every startup. Keep startup
                // responsive when the server is offline, then start sync.
                const config = get(connectionState).mysqlConfig;
                if (config) {
                    void startMultiTillSyncWhenReady(config);
                } else {
                    startBackgroundSync();
                }
            } else {
                startTerminalRecoverySchedule();
            }

            // Remove legacy app data while preserving device-only preferences.
            const customerDisplayMonitor = localStorage.getItem('customer_display_monitor');
            const customerDisplayAutoOpen = localStorage.getItem('customer_display_auto_open');
            localStorage.clear();
            if (customerDisplayMonitor !== null) {
                localStorage.setItem('customer_display_monitor', customerDisplayMonitor);
            }
            if (customerDisplayAutoOpen !== null) {
                localStorage.setItem('customer_display_auto_open', customerDisplayAutoOpen);
            }
            console.log("POS initialized ✅");
            dbReady = true;
            if (window.location.pathname !== '/customer-display') {
                ownerCloudActivationListener = () => void startOwnerCloudReporterIfNeeded(true);
                window.addEventListener(OWNER_CLOUD_ACTIVATION_EVENT, ownerCloudActivationListener);
                ownerCloudStartupTimer = setTimeout(() => {
                    ownerCloudStartupTimer = null;
                    void startOwnerCloudReporterIfNeeded();
                }, 7000);
                startAutomaticBackupSchedule();
            }

            // A shop without an active administrator cannot be managed yet. Always send it
            // to setup so the first administrator can choose their own PIN.
            const hasActiveAdmin = get(employeesDB).some((employee) =>
                normalizeEmployeeForRuntime(employee)?.isActive
                    && normalizeEmployeeForRuntime(employee)?.role === 'admin'
            );
            if ((restorePendingMariaDbReplace || !savedMode || !hasActiveAdmin) && window.location.pathname !== '/setup') {
                goto('/setup');
            }
        } catch (err) {
            console.error("Failed to initialize:", err);
            dbError = String(err);
        }
    });

    onDestroy(() => {
        stopCustomerDisplayAutoOpen?.();
        stopOwnerCloudReporter?.();
        if (ownerCloudStartupTimer) clearTimeout(ownerCloudStartupTimer);
        if (ownerCloudActivationListener) {
            window.removeEventListener(OWNER_CLOUD_ACTIVATION_EVENT, ownerCloudActivationListener);
        }
        clearSyncStartupRetry();
        clearAutomaticBackupSchedule();
        if (terminalRecoveryInterval) {
            clearInterval(terminalRecoveryInterval);
            terminalRecoveryInterval = null;
        }
        if (employeeAuthorityRevalidationInterval) {
            clearInterval(employeeAuthorityRevalidationInterval);
            employeeAuthorityRevalidationInterval = null;
        }
    });

    // Reactive theme application via store subscription.
    $: if (typeof document !== 'undefined' && $activeTheme) {
        const targets = [document.documentElement, document.body];
        for (const el of targets) {
            for (const c of [...el.classList]) {
                if (c.startsWith('theme-')) el.classList.remove(c);
            }
            el.classList.add(`theme-${$activeTheme}`);
            el.dataset.theme = $activeTheme;
        }
    }

    $: applyTypography($settingsDB);

    async function revalidateEmployeeAgainstMariaDb(employeeId: string): Promise<void> {
        employeeAuthorityRevalidationRunning = true;
        try {
            const authoritative = await revalidateCurrentEmployeeSession();
            if (!authoritative) {
                lastRevokedEmployeeId = employeeId;
                toast('Your staff account is no longer available. Sign in with an active user.', 'error');
                if (typeof window !== 'undefined' && $page.url.pathname !== '/') {
                    await goto('/', { replaceState: true });
                }
            }
        } catch (error) {
            console.error('POS: authoritative staff-session check failed:', error);
            toast('Your staff session could not be verified with MariaDB. Sign in again.', 'error');
            if (typeof window !== 'undefined' && $page.url.pathname !== '/') {
                await goto('/', { replaceState: true });
            }
        } finally {
            employeeAuthorityRevalidationRunning = false;
        }
    }

    // Revalidate once for each offline -> online transition. mysqlReady can
    // stay true during a network outage, so mysqlOnline is part of this edge.
    $: {
        const employee = $currentEmployee;
        const shouldRevalidate = $connectionState.mode === 'multi'
            && $connectionState.mysqlOnline
            && $connectionState.mysqlReady
            && employee
            && !isSupportEmployee(employee);
        const revalidationEmployeeId = shouldRevalidate ? employee?.id || '' : '';
        const nextKey = revalidationEmployeeId ? `online:${revalidationEmployeeId}` : '';
        if (!nextKey) {
            employeeAuthorityRevalidationKey = '';
        } else if (
            nextKey !== employeeAuthorityRevalidationKey
            && !employeeAuthorityRevalidationRunning
        ) {
            employeeAuthorityRevalidationKey = nextKey;
            void revalidateEmployeeAgainstMariaDb(revalidationEmployeeId);
        }
    }

    // Keep authentication tied to the latest shared employee record on every
    // route. Remote deactivation and role changes must not wait for checkout
    // to be mounted before they take effect.
    $: {
        const sessionEmployee = $currentEmployee;
        if (!sessionEmployee || isSupportEmployee(sessionEmployee)) {
            lastRevokedEmployeeId = '';
        } else {
            const latestEmployee = normalizeEmployeeForRuntime(
                $employeesDB.find((employee) => employee.id === sessionEmployee.id),
            );
            const versionChanged = Boolean(
                latestEmployee?.isActive
                && !currentEmployeeSessionVersionMatches(latestEmployee),
            );
            if (!latestEmployee?.isActive || versionChanged) {
                if (lastRevokedEmployeeId !== sessionEmployee.id) {
                    lastRevokedEmployeeId = sessionEmployee.id;
                    toast(
                        versionChanged
                            ? 'Your staff profile changed. Sign in again to use the updated access.'
                            : 'Your staff account is no longer active. Sign in with an active user.',
                        'error',
                    );
                }
                logout();
                if (typeof window !== 'undefined' && $page.url.pathname !== '/') {
                    void goto('/', { replaceState: true });
                }
            } else {
                lastRevokedEmployeeId = '';
                if (latestEmployee !== sessionEmployee) currentEmployee.set(latestEmployee);
            }
        }
    }

    $: if (dbReady && typeof window !== 'undefined') {
        markAppNavigation($page.url.pathname);
    }

    // A customer-facing checkout display is a till function. Start and stop
    // its watcher as this computer's role changes without affecting any other
    // device on the shared database.
    $: if (dbReady && typeof window !== 'undefined') {
        const shouldWatchCustomerDisplay = isTauri()
            && $deviceOperatingMode === 'checkout'
            && $page.url.pathname !== '/customer-display';
        if (shouldWatchCustomerDisplay && !stopCustomerDisplayAutoOpen) {
            stopCustomerDisplayAutoOpen = startCustomerDisplayAutoOpenWatcher();
        } else if (!shouldWatchCustomerDisplay && stopCustomerDisplayAutoOpen) {
            stopCustomerDisplayAutoOpen();
            stopCustomerDisplayAutoOpen = null;
        }
    }

    $: if (dbReady && typeof window !== 'undefined') {
        const pathname = $page.url.pathname;
        const hasActiveAdmin = get(employeesDB).some((employee) =>
            normalizeEmployeeForRuntime(employee)?.isActive
                && normalizeEmployeeForRuntime(employee)?.role === 'admin'
        );
        const setupAllowed = pathname === '/setup' && (!hasActiveAdmin || restorePendingMariaDbReplace);
        const backOfficeMode = $deviceOperatingMode === 'back_office';
        const backOfficeDestination = canAccessPath($currentEmployee, '/admin', $settingsDB)
            ? '/admin'
            : '/';
        if (
            $currentEmployee?.role === 'attendance'
            && pathname !== '/attendance'
            && pathname !== '/customer-display'
        ) {
            void goto('/attendance', { replaceState: true });
        } else if (restorePendingMariaDbReplace && pathname !== '/setup' && pathname !== '/customer-display') {
            goto('/setup');
        } else if (!hasActiveAdmin && pathname !== '/setup' && pathname !== '/customer-display') {
            goto('/setup');
        } else if (backOfficeMode && isBackOfficeBlockedPath(pathname)) {
            void goto(backOfficeDestination, { replaceState: true });
        } else if (backOfficeMode && $currentEmployee && pathname === '/') {
            if (backOfficeDestination === '/admin') {
                void goto('/admin', { replaceState: true });
            } else {
                logout();
                toast('This staff account does not have Back Office access.', 'error');
            }
        } else if (!setupAllowed && !canAccessPath($currentEmployee, pathname, $settingsDB)) {
            void goto('/', { replaceState: true });
        }
    }

    $: if (
        dbReady &&
        isTauri() &&
        !fullStoresHydrated &&
        typeof window !== 'undefined' &&
        !isLightStorePath($page.url.pathname)
    ) {
        fullStoresHydrated = true;
        lastLightHydrationPath = '';
        void hydrateSvelteStores().catch((error) => {
            fullStoresHydrated = false;
            console.warn('POS: full store hydration failed after navigation:', error);
        });
    }

    $: if (
        dbReady &&
        isTauri() &&
        typeof window !== 'undefined' &&
        isLightStorePath($page.url.pathname) &&
        $page.url.pathname !== lastLightHydrationPath
    ) {
        void hydrateLightStoresForTillRoute($page.url.pathname);
    }
</script>

<svelte:window on:pointerdown|capture={handleGlobalButtonFeedback} />

{#if $connectionState.syncError?.includes('DATABASE_IDENTITY_MISMATCH')}
    <div class="fixed inset-0 z-[3000] flex items-center justify-center bg-bg-base p-6 font-sans text-text-main">
        <div class="w-full max-w-[640px] rounded-2xl border border-danger/50 bg-bg-panel p-7 shadow-[0_20px_80px_var(--shadow)]">
            <p class="mb-3 text-xs font-black uppercase tracking-[0.16em] text-danger">Database protected</p>
            <h2 class="mb-3 text-2xl font-black">This database belongs to a different shop</h2>
            <p class="mb-4 text-text-muted">
                Sync has been stopped so this till does not mix data with another shop.
                To use this MariaDB database, reset this local till first or restore a backup that belongs to the same shop.
            </p>
            <div class="rounded-xl border border-border-flat bg-bg-card p-4 text-sm text-text-muted">
                {$connectionState.syncError}
            </div>
        </div>
    </div>
{:else if dbReady}
    {#if backOfficeWorkspaceVisible}
        <div class="back-office-workspace">
            <BackOfficeSidebar />
            <div class="back-office-route" id="back-office-page-content">
                <slot />
            </div>
        </div>
    {:else}
        <slot />
    {/if}
{:else if dbError}
    <div class="fixed inset-0 flex items-center justify-center bg-bg-base font-sans text-text-main">
        <div class="max-w-[480px] rounded-md border border-danger bg-bg-panel p-6 text-center">
            <h2>Database Error</h2>
            <p>{dbError}</p>
        </div>
    </div>
{:else}
    <div class="fixed inset-0 flex items-center justify-center bg-bg-base font-sans text-text-main">
        <div class="text-center">
            <div class="mx-auto mb-3 h-9 w-9 animate-spin rounded-full border-[3px] border-border-flat border-t-accent-primary"></div>
            <p>Loading…</p>
        </div>
    </div>
{/if}
{#if $page.url.pathname !== '/customer-display'}
<SystemPrintHost />
<LicenseNoticeDialog enabled={dbReady} />
<Toast />
{#if $deviceOperatingMode === 'checkout'}
    <GlobalTouchInput />
{/if}
{/if}

<style>
    .back-office-workspace {
        width: 100vw;
        height: var(--workspace-height, 100dvh);
        overflow: hidden;
        display: grid;
        grid-template-columns: 196px minmax(0, 1fr);
        background: var(--bg-base);
    }

    .back-office-route {
        min-width: 0;
        min-height: 0;
        width: 100%;
        height: var(--workspace-height, 100dvh);
        overflow: hidden;
    }

    :global(.back-office-route .admin-page),
    :global(.back-office-route .management-page),
    :global(.back-office-route .items-management-page),
    :global(.back-office-route .tiles-management-page),
    :global(.back-office-route .tile-designer-page),
    :global(.back-office-route .scale-page),
    :global(.back-office-route .barcode-page),
    :global(.back-office-route .studio-shell) {
        width: 100% !important;
        max-width: 100%;
        height: var(--workspace-height, 100dvh) !important;
    }

    @media (max-width: 1100px) {
        .back-office-workspace { grid-template-columns: 88px minmax(0, 1fr); }
    }
    @media (max-width: 600px) {
        .back-office-workspace {
            --workspace-height: calc(100dvh - 76px);
            height: 100dvh;
            grid-template-columns: minmax(0, 1fr);
            grid-template-rows: 76px minmax(0, 1fr);
        }
    }

    @media print {
        .back-office-workspace {
            display: block;
            width: auto;
            height: auto;
            overflow: visible;
        }

        .back-office-workspace :global(.back-office-sidebar) {
            display: none;
        }

        .back-office-route {
            width: auto;
            height: auto;
            overflow: visible;
        }
    }
</style>
