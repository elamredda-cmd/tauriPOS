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
        hasRestorePendingMariaDbReplace,
        hydrateSvelteStores,
        RESTORE_PENDING_MARIADB_REPLACE_MESSAGE,
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
    import { canManage, currentEmployee, currentShiftId, REMEMBERED_EMPLOYEE_SESSION_KEY } from '$lib/stores/session';
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
    const SYNC_STARTUP_RETRY_MS = 30 * 1000;
    const POS_STARTUP_TABLES = [
        'categories',
        'products',
        'pos_pages',
        'pos_tiles',
        'tax_rates',
        'employees',
        'settings',
        'customers',
        'registers',
        'discounts',
        'promo_groups',
        'promo_group_items',
        'shifts',
        'cash_movements',
    ];
    const LIGHT_STORE_ROUTES = ['/', '/orders', '/items', '/customer-display'];
    let fullStoresHydrated = false;

    primeSoundEngine();

    function clearSyncStartupRetry() {
        if (syncStartupRetry) {
            clearInterval(syncStartupRetry);
            syncStartupRetry = null;
        }
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
        if (!control || control.matches(':disabled, [aria-disabled="true"], .menu-link-disabled')) return;
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

    async function hydrateLightStoresForTillRoute() {
        if (lightStoreHydrationRunning) return;
        lightStoreHydrationRunning = true;
        try {
            await hydrateSvelteStores(POS_STARTUP_TABLES);
            fullStoresHydrated = false;
        } catch (error) {
            console.warn('POS: light store hydration failed after navigation:', error);
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
            const lightStartup = LIGHT_STORE_ROUTES.includes(window.location.pathname);
            await hydrateSvelteStores(lightStartup ? POS_STARTUP_TABLES : undefined);
            fullStoresHydrated = !lightStartup;

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
            const rememberedEmployeeSession = localStorage.getItem(REMEMBERED_EMPLOYEE_SESSION_KEY);
            localStorage.clear();
            if (customerDisplayMonitor !== null) {
                localStorage.setItem('customer_display_monitor', customerDisplayMonitor);
            }
            if (customerDisplayAutoOpen !== null) {
                localStorage.setItem('customer_display_auto_open', customerDisplayAutoOpen);
            }
            if (rememberedEmployeeSession !== null) {
                localStorage.setItem(REMEMBERED_EMPLOYEE_SESSION_KEY, rememberedEmployeeSession);
            }

            console.log("POS initialized ✅");
            dbReady = true;
            if (window.location.pathname !== '/customer-display') {
                stopCustomerDisplayAutoOpen = startCustomerDisplayAutoOpenWatcher();
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
        const allowedForCashier = ['/', '/orders', '/shifts', '/customer-display', '/label-print'];
        const hasActiveAdmin = get(employeesDB).some((employee) =>
            employee.isActive && employee.role === 'admin'
        );
        const setupAllowed = $page.url.pathname === '/setup' && (!hasActiveAdmin || restorePendingMariaDbReplace);
        if (restorePendingMariaDbReplace && $page.url.pathname !== '/setup') {
            goto('/setup');
        } else if (!hasActiveAdmin && $page.url.pathname !== '/setup') {
            goto('/setup');
        } else if (!allowedForCashier.includes($page.url.pathname) && !setupAllowed && !canManage($currentEmployee)) {
            goto('/');
        }
    }

    $: if (
        dbReady &&
        !fullStoresHydrated &&
        typeof window !== 'undefined' &&
        !LIGHT_STORE_ROUTES.includes($page.url.pathname)
    ) {
        fullStoresHydrated = true;
        void hydrateSvelteStores().catch((error) => {
            fullStoresHydrated = false;
            console.warn('POS: full store hydration failed after navigation:', error);
        });
    }

    $: if (
        dbReady &&
        fullStoresHydrated &&
        typeof window !== 'undefined' &&
        LIGHT_STORE_ROUTES.includes($page.url.pathname)
    ) {
        void hydrateLightStoresForTillRoute();
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
