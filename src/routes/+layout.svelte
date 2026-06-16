<script lang="ts">
    import { onMount } from 'svelte';
    import { goto } from '$app/navigation';
    import { connectionState, loadSavedMode } from '$lib/stores/connection';
    import { initMysqlDb } from '$lib/stores/mysql';
    import '../app.css';
    import Toast from '$lib/components/Toast.svelte';
    import { initDb, migrateFromLocalStorage } from '$lib/stores/sqlite';
    import { ensureDatabaseIdentityForSync, hydrateSvelteStores, startBackgroundSync } from '$lib/stores/database';
    import {
        productsDB, categoriesDB, posPagesDB, tilesDB, taxRatesDB, employeesDB,
        settingsDB, customersDB, storeDB, registersDB, discountsDB,
        ordersDB, orderLinesDB, paymentsDB,
        promoGroupsDB, promoGroupItemsDB
    } from '$lib/stores/db';
    import { get } from 'svelte/store';
    import { activeTheme, hydrateTheme } from '$lib/stores/theme';
    import { page } from '$app/stores';
    import { canManage, currentEmployee } from '$lib/stores/session';
    import { playCartButtonFeedback, primeSoundEngine } from '$lib/sounds';
    import GlobalTouchInput from '$lib/components/GlobalTouchInput.svelte';

    let dbReady = false;
    let dbError = '';

    primeSoundEngine();

    function handleGlobalButtonFeedback(event: PointerEvent) {
        const control = (event.target as HTMLElement | null)?.closest('button, a[href], [role="button"]') as HTMLElement | null;
        if (!control || control.matches(':disabled, [aria-disabled="true"], .menu-link-disabled')) return;
        playCartButtonFeedback();
    }

    onMount(async () => {
        try {
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
            await hydrateSvelteStores();

            if (savedMode === 'multi') {
                // Run server schema migrations on every startup. Keep startup
                // responsive when the server is offline, then start sync.
                const config = get(connectionState).mysqlConfig;
                if (config) {
                    initMysqlDb(config)
                        .then(() => ensureDatabaseIdentityForSync())
                        .then(() => startBackgroundSync())
                        .catch((error) => {
                            console.warn('POS: MariaDB sync blocked/deferred:', error);
                            connectionState.update((state) => ({
                                ...state,
                                mysqlOnline: false,
                                syncError: String(error),
                            }));
                        });
                } else {
                    startBackgroundSync();
                }
            }

            // Remove legacy app data while preserving device-only preferences.
            const customerDisplayMonitor = localStorage.getItem('customer_display_monitor');
            localStorage.clear();
            if (customerDisplayMonitor !== null) {
                localStorage.setItem('customer_display_monitor', customerDisplayMonitor);
            }

            console.log("POS initialized ✅");
            dbReady = true;

            // A shop without an active administrator cannot be managed yet. Always send it
            // to setup so the first administrator can choose their own PIN.
            const hasActiveAdmin = get(employeesDB).some((employee) =>
                employee.isActive && employee.role === 'admin'
            );
            if ((!savedMode || !hasActiveAdmin) && window.location.pathname !== '/setup') {
                goto('/setup');
            }
        } catch (err) {
            console.error("Failed to initialize:", err);
            dbError = String(err);
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

    $: if (dbReady && typeof window !== 'undefined') {
        const allowedForCashier = ['/', '/orders', '/shifts', '/customer-display', '/label-print'];
        const hasActiveAdmin = get(employeesDB).some((employee) =>
            employee.isActive && employee.role === 'admin'
        );
        const setupAllowed = $page.url.pathname === '/setup' && !hasActiveAdmin;
        if (!hasActiveAdmin && $page.url.pathname !== '/setup') {
            goto('/setup');
        } else if (!allowedForCashier.includes($page.url.pathname) && !setupAllowed && !canManage($currentEmployee)) {
            goto('/');
        }
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
