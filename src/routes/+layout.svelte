<script lang="ts">
    import { onMount } from 'svelte';
    import { goto } from '$app/navigation';
    import { loadSavedMode } from '$lib/stores/connection';
    import '../app.css';
    import Toast from '$lib/components/Toast.svelte';
    import { initDb, migrateFromLocalStorage, getAll, getActiveProducts, rehydrateBooleans } from '$lib/stores/sqlite';
    import {
        productsDB, categoriesDB, posPagesDB, tilesDB, taxRatesDB, employeesDB,
        settingsDB, customersDB, storeDB, registersDB, discountsDB,
        ordersDB, orderLinesDB, paymentsDB, shiftsDB, cashMovementsDB,
        suppliersDB, productSuppliersDB, inventoryLogDB, loyaltyLogDB, auditLogDB,
        promoGroupsDB, promoGroupItemsDB
    } from '$lib/stores/db';
    import { get } from 'svelte/store';
    import { activeTheme, hydrateTheme } from '$lib/stores/theme';

    let dbReady = false;
    let dbError = '';

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

            // 2. Hydrate every store from SQLite.
            console.log("POS: Hydrating stores...");
            const [
                cats, pages, tiles, prods, taxRates, emps, settings, customers,
                registers, discounts, promoGroups, promoGroupItems,
                orders, orderLines, payments
            ] = await Promise.all([
                getAll('categories'),
                getAll('pos_pages'),
                getAll('pos_tiles'),
                getActiveProducts(),
                getAll('tax_rates'),
                getAll('employees'),
                getAll('settings'),
                getAll('customers'),
                getAll('registers'),
                getAll('discounts'),
                getAll('promo_groups'),
                getAll('promo_group_items'),
                getAll('orders'),
                getAll('order_lines'),
                getAll('payments')
            ]);
            console.log("POS: Hydration data fetched.");

            // Rehydrate integer flags back into booleans so UI bindings keep working.
            categoriesDB.set(cats.map(c => rehydrateBooleans(c, ['isActive', 'showOnPos'])));
            posPagesDB.set(pages);
            tilesDB.set(tiles);
            productsDB.set(prods.map(p => rehydrateBooleans(p, [
                'isActive', 'isWeighable', 'showInGoods', 'showInPos',
                'trackStock'
            ])));
            taxRatesDB.set(taxRates.map(t => rehydrateBooleans(t, ['isDefault'])));
            employeesDB.set(emps.map(e => rehydrateBooleans(e, ['isActive'])));
            settingsDB.set(settings);
            // Restore the user's saved theme preference (if any) before
            // the rest of the UI mounts, so there's no flash of midnight.
            hydrateTheme(settings);
            customersDB.set(customers);
            registersDB.set(registers.map(r => rehydrateBooleans(r, ['isActive'])));
            discountsDB.set(discounts.map(d => rehydrateBooleans(d, ['isActive', 'autoApply'])));
            promoGroupsDB.set(promoGroups.map(g => rehydrateBooleans(g, ['isActive'])));
            promoGroupItemsDB.set(promoGroupItems);
            ordersDB.set(orders);
            orderLinesDB.set(orderLines);
            paymentsDB.set(payments);

            // Store info lives inside the settings table.
            const storeInfo = settings.find((s: any) => s.key === 'store_info');
            if (storeInfo) {
                try {
                    storeDB.set(JSON.parse(storeInfo.value));
                } catch (e) {
                    console.error("Failed to parse store_info:", e);
                }
            }

            // Wipe any legacy LocalStorage data so nothing falls back to it.
            localStorage.clear();

            console.log("POS initialized with SQLite data and LocalStorage cleared.");
            dbReady = true;

            // Check if initial setup (single vs multi POS) has been completed.
            // If not, redirect to the setup wizard — but only if we're not
            // already on the /setup page (avoids an infinite redirect loop).
            const savedMode = await loadSavedMode();
            if (!savedMode && window.location.pathname !== '/setup') {
                goto('/setup');
            }
        } catch (err) {
            console.error("Failed to initialize SQLite:", err);
            dbError = String(err);
        }
    });

    // Reactive theme application via store subscription.
    // Avoid $effect here — using a rune flips the file into runes mode,
    // which makes plain `let dbReady` non-reactive and freezes the loading screen.
    // Apply to BOTH <html> and <body> so the CSS variable cascade is rooted
    // at the document element (matches `:root` specificity exactly) and
    // descendant components can't possibly miss it.
    $: if (typeof document !== 'undefined' && $activeTheme) {
        const targets = [document.documentElement, document.body];
        for (const el of targets) {
            // Snapshot to a static array first — DOMTokenList is live and
            // mutating during forEach skips items.
            for (const c of [...el.classList]) {
                if (c.startsWith('theme-')) el.classList.remove(c);
            }
            el.classList.add(`theme-${$activeTheme}`);
            el.dataset.theme = $activeTheme;
        }
    }
</script>

{#if dbReady}
    <slot />
{:else if dbError}
    <div class="db-loading">
        <div class="db-loading-card error">
            <h2>Database Error</h2>
            <p>{dbError}</p>
        </div>
    </div>
{:else}
    <div class="db-loading">
        <div class="db-loading-card">
            <div class="spinner"></div>
            <p>Loading…</p>
        </div>
    </div>
{/if}
<Toast />

<style>
    .db-loading {
        position: fixed;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--bg-base);
        color: var(--text-main);
        font-family: system-ui, -apple-system, sans-serif;
    }
    .db-loading-card {
        text-align: center;
    }
    .db-loading-card.error {
        max-width: 480px;
        padding: 24px;
        border: 1px solid var(--danger);
        border-radius: var(--radius-md);
        background: var(--bg-panel);
    }
    .spinner {
        width: 36px;
        height: 36px;
        margin: 0 auto 12px;
        border: 3px solid var(--border-flat);
        border-top-color: var(--accent-primary);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
    }
    @keyframes spin {
        to { transform: rotate(360deg); }
    }
</style>
