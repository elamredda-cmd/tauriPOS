<script lang="ts">
    import { onMount } from 'svelte';
    import { goto } from '$app/navigation';
    import { loadSavedMode } from '$lib/stores/connection';
    import '../app.css';
    import Toast from '$lib/components/Toast.svelte';
    import { initDb, migrateFromLocalStorage } from '$lib/stores/sqlite';
    import { hydrateSvelteStores, startBackgroundSync } from '$lib/stores/database';
    import {
        productsDB, categoriesDB, posPagesDB, tilesDB, taxRatesDB, employeesDB,
        settingsDB, customersDB, storeDB, registersDB, discountsDB,
        ordersDB, orderLinesDB, paymentsDB,
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

            // 2. Check saved POS mode (single / multi).
            const savedMode = await loadSavedMode();

            // 3. Hydrate stores from the correct data source.
            if (savedMode === 'multi') {
                // Multi mode: start background sync which immediately
                // pulls from MySQL → writes to SQLite cache → hydrates stores.
                console.log("POS: Multi mode — starting background sync…");
                await startBackgroundSync(30000);
            } else {
                // Single mode (or first launch): hydrate from local SQLite.
                console.log("POS: Hydrating stores from SQLite…");
                await hydrateSvelteStores();
            }

            // Wipe any legacy LocalStorage data so nothing falls back to it.
            localStorage.clear();

            console.log("POS initialized ✅");
            dbReady = true;

            // If no mode has been chosen yet, redirect to setup wizard.
            if (!savedMode && window.location.pathname !== '/setup') {
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
