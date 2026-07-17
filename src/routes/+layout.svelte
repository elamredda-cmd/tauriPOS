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
        RESTORE_PENDING_MARIADB_REPLACE_MESSAGE,
        runAutomaticSetupBackupIfEnabled,
        startBackgroundSync
    } from '$lib/stores/database';
    import {
        productsDB, categoriesDB, posPagesDB, tilesDB, taxRatesDB, employeesDB,
        settingsDB, customersDB, storeDB, registersDB, discountsDB,
        promoGroupsDB, promoGroupItemsDB
    } from '$lib/stores/db';
    import { get } from 'svelte/store';
    import { activeTheme, hydrateTheme } from '$lib/stores/theme';
    import { applyTypography } from '$lib/typography';
    import { page } from '$app/stores';
    import { currentEmployee, currentShiftId } from '$lib/stores/session';
    import { canAccessPath } from '$lib/permissions';
    import { playCartButtonFeedback, primeSoundEngine } from '$lib/sounds';
    import GlobalTouchInput from '$lib/components/GlobalTouchInput.svelte';
    import { startCustomerDisplayAutoOpenWatcher } from '$lib/customerDisplay';

    let dbReady = false;
    let dbError = '';
    let syncStartupRetry: ReturnType<typeof setInterval> | null = null;
    let syncStartupRunning = false;
    let stopCustomerDisplayAutoOpen: (() => void) | null = null;
    let restorePendingMariaDbReplace = false;
    let lightStoreHydrationRunning = false;
    let queuedLightHydrationPath: string | null = null;
    let lastLightHydrationPath = '';
    let automaticBackupStartTimeout: ReturnType<typeof setTimeout> | null = null;
    let automaticBackupInterval: ReturnType<typeof setInterval> | null = null;
    let automaticBackupRunning = false;
    const SYNC_STARTUP_RETRY_MS = 60 * 1000;
    const AUTOMATIC_BACKUP_START_DELAY_MS = 2 * 60 * 1000;
    const AUTOMATIC_BACKUP_CHECK_MS = 5 * 60 * 1000;
    let fullStoresHydrated = false;

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

    function isDatabaseIdentityMismatch(error: unknown): boolean {
        return String(error).includes('DATABASE_IDENTITY_MISMATCH');
    }

    async function startMultiTillSyncWhenReady(config: MysqlConfig) {
        if (syncStartupRunning) return;
        syncStartupRunning = true;
        try {
            await initMysqlDb(config);
            await ensureDatabaseIdentityForSync();
            clearSyncStartupRetry();
            await startBackgroundSync();
            connectionState.update((state) => ({
                ...state,
                mysqlOnline: true,
                syncError: null,
            }));
        } catch (error) {
            console.warn('POS: MariaDB sync blocked/deferred:', error);
            connectionState.update((state) => ({
                ...state,
                mysqlOnline: false,
                syncError: String(error),
            }));

            if (isDatabaseIdentityMismatch(error)) {
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

    function startBrowserPreviewMode() {
        console.warn('POS: Running outside Tauri; using seeded in-memory preview data.');
        connectionState.update((state) => ({
            ...state,
            mode: 'single',
            mysqlOnline: false,
            syncError: null,
        }));
        hydrateTheme(get(settingsDB));

        const previewEmployee = get(employeesDB).find((employee) =>
            employee.isActive && employee.role === 'admin'
        ) || get(employeesDB).find((employee) => employee.isActive) || null;
        if (!get(currentEmployee) && previewEmployee) {
            currentEmployee.set(previewEmployee);
        }
        if (!get(currentShiftId)) {
            currentShiftId.set('browser-preview-shift');
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
        try {
            if (!isTauri()) {
                startBrowserPreviewMode();
                return;
            }

            const startupPath = window.location.pathname;
            if (startupPath === '/customer-display') {
                // The customer display is a second WebView. It only needs enough
                // local state for theme and access guards, never its own sync engine.
                lastLightHydrationPath = startupPath;
                await hydrateSvelteStores(getLightRouteHydrationTables(startupPath));
                dbReady = true;
                return;
            }

            console.log("POS: Starting DB init...");
            await initDb();
            console.log("POS: DB init done.");

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
                stopCustomerDisplayAutoOpen = startCustomerDisplayAutoOpenWatcher();
                startAutomaticBackupSchedule();
            }

            // A shop without an active administrator cannot be managed yet. Always send it
            // to setup so the first administrator can choose their own PIN.
            const hasActiveAdmin = get(employeesDB).some((employee) =>
                employee.isActive && employee.role === 'admin'
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
        clearSyncStartupRetry();
        clearAutomaticBackupSchedule();
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

    $: if (dbReady && typeof window !== 'undefined') {
        const pathname = $page.url.pathname;
        const hasActiveAdmin = get(employeesDB).some((employee) =>
            employee.isActive && employee.role === 'admin'
        );
        const setupAllowed = pathname === '/setup' && (!hasActiveAdmin || restorePendingMariaDbReplace);
        if (restorePendingMariaDbReplace && pathname !== '/setup') {
            goto('/setup');
        } else if (!hasActiveAdmin && pathname !== '/setup') {
            goto('/setup');
        } else if (!setupAllowed && !canAccessPath($currentEmployee, pathname, $settingsDB)) {
            goto('/');
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
    <slot />
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
<Toast />
<GlobalTouchInput />
{/if}
