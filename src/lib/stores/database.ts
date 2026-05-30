/**
 * database.ts — Unified Database Abstraction Layer
 *
 * This is the ONLY file that page components should import from.
 * It re-exports every function name from sqlite.ts, but routes calls
 * through either SQLite (single mode) or MySQL+SQLite cache (multi mode)
 * based on the connection state.
 *
 * In SINGLE mode:  every call goes directly to sqlite.ts (no changes).
 * In MULTI mode:
 *   - Reads:  try MySQL first → fall back to SQLite cache
 *   - Writes: write to MySQL AND update SQLite cache
 *   - If MySQL is down: queue writes in SQLite offline table, flush later
 */

import * as sqlite from './sqlite';
import * as mysql from './mysql';
import { isMultiMode, getMysqlDb, connectionState } from './connection';
import { get } from 'svelte/store';

// ─── Re-exports that never change (always local SQLite) ─────────────────────

export {
    initDb,
    migrateFromLocalStorage,
    rehydrateBooleans,
    getDb,
} from './sqlite';

export type { SeedPayload, SalesOverview, PaymentBreakdown, TopProduct } from './sqlite';

// ─── Offline Queue ──────────────────────────────────────────────────────────

/** Create the offline queue table in local SQLite (called once at startup). */
export async function initOfflineQueue(): Promise<void> {
    const d = await sqlite.getDb();
    await d.execute(`
        CREATE TABLE IF NOT EXISTS _offline_queue (
            id TEXT PRIMARY KEY,
            table_name TEXT NOT NULL,
            operation TEXT NOT NULL,
            data TEXT NOT NULL,
            id_key TEXT DEFAULT 'id',
            created_at TEXT NOT NULL
        )
    `);
}

/** Queue a write operation for later sync to MySQL. */
async function queueOffline(
    tableName: string,
    operation: 'upsert' | 'remove',
    data: any,
    idKey: string = 'id'
): Promise<void> {
    const d = await sqlite.getDb();
    const id = crypto.randomUUID();
    await d.execute(
        `INSERT INTO _offline_queue (id, table_name, operation, data, id_key, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [id, tableName, operation, JSON.stringify(data), idKey, new Date().toISOString()]
    );
    console.log(`database: queued offline ${operation} for ${tableName}`);
}

/** Flush all queued offline operations to MySQL. Call when MySQL comes back. */
export async function flushOfflineQueue(): Promise<number> {
    const mysqlDb = await getMysqlDb();
    if (!mysqlDb) return 0;

    const d = await sqlite.getDb();
    const rows: any[] = await d.select(
        `SELECT * FROM _offline_queue ORDER BY created_at ASC`
    );

    let flushed = 0;
    for (const row of rows) {
        try {
            const data = JSON.parse(row.data);
            if (row.operation === 'upsert') {
                await mysql.mysqlUpsert(row.table_name, data, row.id_key);
            } else if (row.operation === 'remove') {
                await mysql.mysqlRemove(row.table_name, data.id, row.id_key);
            }
            await d.execute(`DELETE FROM _offline_queue WHERE id = ?`, [row.id]);
            flushed++;
        } catch (e) {
            console.warn(`database: failed to flush queue item ${row.id}:`, e);
            break; // Stop at first failure to maintain order
        }
    }

    if (flushed > 0) {
        console.log(`database: flushed ${flushed} offline operations to MySQL`);
    }
    return flushed;
}

// ─── Helper: try MySQL, fall back to SQLite ─────────────────────────────────

async function tryMysql(): Promise<boolean> {
    if (!isMultiMode()) return false;
    const db = await getMysqlDb();
    return db !== null;
}

// ─── CRUD Operations ────────────────────────────────────────────────────────

export async function upsert(table: string, obj: any, idKey: string = 'id'): Promise<void> {
    // Always write to local SQLite (either primary or cache)
    await sqlite.upsert(table, obj, idKey);

    if (isMultiMode()) {
        try {
            await mysql.mysqlUpsert(table, obj, idKey);
        } catch (e) {
            console.warn(`database: MySQL upsert failed for ${table}, queuing offline:`, e);
            await queueOffline(table, 'upsert', obj, idKey);
            connectionState.update(s => ({ ...s, mysqlOnline: false }));
        }
    }
}

export async function remove(table: string, id: string, idKey: string = 'id'): Promise<void> {
    await sqlite.remove(table, id, idKey);

    if (isMultiMode()) {
        try {
            await mysql.mysqlRemove(table, id, idKey);
        } catch (e) {
            console.warn(`database: MySQL remove failed for ${table}, queuing offline:`, e);
            await queueOffline(table, 'remove', { id }, idKey);
            connectionState.update(s => ({ ...s, mysqlOnline: false }));
        }
    }
}

// ─── Read Operations ────────────────────────────────────────────────────────

export async function searchProduct(query: string): Promise<any | null> {
    // Always search local SQLite for speed (barcode scanning must be instant)
    return sqlite.searchProduct(query);
}

export async function getAll(table: string): Promise<any[]> {
    if (isMultiMode()) {
        try {
            const mysqlDb = await getMysqlDb();
            if (mysqlDb) return mysql.mysqlGetAll(table);
        } catch (e) {
            console.warn(`database: MySQL getAll failed for ${table}, using cache:`, e);
        }
    }
    return sqlite.getAll(table);
}

export async function getActiveProducts(): Promise<any[]> {
    if (isMultiMode()) {
        try {
            const mysqlDb = await getMysqlDb();
            if (mysqlDb) return mysql.mysqlGetActiveProducts();
        } catch (e) {
            console.warn('database: MySQL getActiveProducts failed, using cache:', e);
        }
    }
    return sqlite.getActiveProducts();
}

export async function getTileProducts(): Promise<any[]> {
    if (isMultiMode()) {
        try {
            const mysqlDb = await getMysqlDb();
            if (mysqlDb) return mysql.mysqlGetTileProducts();
        } catch (e) {
            console.warn('database: MySQL getTileProducts failed, using cache:', e);
        }
    }
    return sqlite.getTileProducts();
}

// ─── Product Helpers ────────────────────────────────────────────────────────

export async function addProduct(p: any): Promise<void> {
    await sqlite.addProduct(p);
    if (isMultiMode()) {
        try {
            await mysql.mysqlAddProduct(p);
        } catch (e) {
            await queueOffline('products', 'upsert', p);
            connectionState.update(s => ({ ...s, mysqlOnline: false }));
        }
    }
}

export async function updateProduct(p: any): Promise<void> {
    await sqlite.updateProduct(p);
    if (isMultiMode()) {
        try {
            await mysql.mysqlUpdateProduct(p);
        } catch (e) {
            await queueOffline('products', 'upsert', p);
            connectionState.update(s => ({ ...s, mysqlOnline: false }));
        }
    }
}

export async function deleteProduct(id: string): Promise<void> {
    await sqlite.deleteProduct(id);
    if (isMultiMode()) {
        try {
            await mysql.mysqlDeleteProduct(id);
        } catch (e) {
            console.warn('database: MySQL deleteProduct failed:', e);
        }
    }
}

export async function bulkAddProducts(products: any[]): Promise<void> {
    await sqlite.bulkAddProducts(products);
    if (isMultiMode()) {
        try {
            await mysql.mysqlBulkAddProducts(products);
        } catch (e) {
            // Queue each product individually for retry
            for (const p of products) {
                await queueOffline('products', 'upsert', p);
            }
            connectionState.update(s => ({ ...s, mysqlOnline: false }));
        }
    }
}

// ─── POS Page / Tile Helpers ────────────────────────────────────────────────

export async function savePosPage(p: any): Promise<void> {
    await sqlite.savePosPage(p);
    if (isMultiMode()) {
        try { await mysql.mysqlSavePosPage(p); } catch (e) {
            await queueOffline('pos_pages', 'upsert', p);
        }
    }
}

export async function deletePosPage(id: string): Promise<void> {
    await sqlite.deletePosPage(id);
    if (isMultiMode()) {
        try { await mysql.mysqlDeletePosPage(id); } catch (e) {
            console.warn('database: MySQL deletePosPage failed:', e);
        }
    }
}

export async function addTile(t: any): Promise<void> {
    await sqlite.addTile(t);
    if (isMultiMode()) {
        try { await mysql.mysqlAddTile(t); } catch (e) {
            await queueOffline('pos_tiles', 'upsert', t);
        }
    }
}

export async function deleteTile(id: string): Promise<void> {
    await sqlite.deleteTile(id);
    if (isMultiMode()) {
        try { await mysql.mysqlDeleteTile(id); } catch (e) {
            console.warn('database: MySQL deleteTile failed:', e);
        }
    }
}

// ─── Goods Menu Helpers ─────────────────────────────────────────────────────

export async function limitGoodsMenuItems(): Promise<void> {
    await sqlite.limitGoodsMenuItems();
    if (isMultiMode()) {
        try { await mysql.mysqlLimitGoodsMenuItems(); } catch (e) {
            console.warn('database: MySQL limitGoodsMenuItems failed:', e);
        }
    }
}

export async function batchUpdateGoodsMenu(
    changes: { id: string; showInGoods: boolean; goodsSortOrder: number; updatedAt: string }[]
): Promise<void> {
    await sqlite.batchUpdateGoodsMenu(changes);
    if (isMultiMode()) {
        try { await mysql.mysqlBatchUpdateGoodsMenu(changes); } catch (e) {
            console.warn('database: MySQL batchUpdateGoodsMenu failed:', e);
        }
    }
}

// ─── Report Queries ─────────────────────────────────────────────────────────
// Reports read from MySQL when available (most accurate, aggregates all tills),
// falling back to local SQLite.

export async function getSalesOverview(
    startDate: string, endDate: string, tillNumber?: string
): Promise<sqlite.SalesOverview> {
    if (isMultiMode()) {
        try {
            const mysqlDb = await getMysqlDb();
            if (mysqlDb) return mysql.mysqlGetSalesOverview(startDate, endDate, tillNumber);
        } catch (e) { console.warn('database: MySQL getSalesOverview failed:', e); }
    }
    return sqlite.getSalesOverview(startDate, endDate, tillNumber);
}

export async function getPaymentBreakdown(
    startDate: string, endDate: string, tillNumber?: string
): Promise<sqlite.PaymentBreakdown> {
    if (isMultiMode()) {
        try {
            const mysqlDb = await getMysqlDb();
            if (mysqlDb) return mysql.mysqlGetPaymentBreakdown(startDate, endDate, tillNumber);
        } catch (e) { console.warn('database: MySQL getPaymentBreakdown failed:', e); }
    }
    return sqlite.getPaymentBreakdown(startDate, endDate, tillNumber);
}

export async function getTopProducts(
    startDate: string, endDate: string,
    sortBy: 'quantity' | 'revenue' = 'quantity',
    limit: number = 10, tillNumber?: string
): Promise<sqlite.TopProduct[]> {
    if (isMultiMode()) {
        try {
            const mysqlDb = await getMysqlDb();
            if (mysqlDb) return mysql.mysqlGetTopProducts(startDate, endDate, sortBy, limit, tillNumber);
        } catch (e) { console.warn('database: MySQL getTopProducts failed:', e); }
    }
    return sqlite.getTopProducts(startDate, endDate, sortBy, limit, tillNumber);
}

export async function aggregateDailySummary(date?: string): Promise<void> {
    await sqlite.aggregateDailySummary(date);
    if (isMultiMode()) {
        try { await mysql.mysqlAggregateDailySummary(date); } catch (e) {
            console.warn('database: MySQL aggregateDailySummary failed:', e);
        }
    }
}

// ─── Till / Marker Queries ──────────────────────────────────────────────────

export async function getLastReportMarker(tillNumber: string): Promise<string | null> {
    return sqlite.getLastReportMarker(tillNumber);
}

export async function saveReportMarker(tillNumber: string, periodStart: string, periodEnd: string): Promise<void> {
    await sqlite.saveReportMarker(tillNumber, periodStart, periodEnd);
}

export async function getOrCreateTillId(): Promise<string> {
    return sqlite.getOrCreateTillId();
}

export async function getTillName(): Promise<string> {
    return sqlite.getTillName();
}

export async function setTillName(name: string): Promise<void> {
    await sqlite.setTillName(name);
}

export async function getAllTillNumbers(): Promise<string[]> {
    if (isMultiMode()) {
        try {
            const mysqlDb = await getMysqlDb();
            if (mysqlDb) {
                const rows: any[] = await mysqlDb.select(
                    `SELECT DISTINCT tillNumber FROM orders WHERE tillNumber IS NOT NULL AND tillNumber != '' ORDER BY tillNumber`
                );
                return rows.map((r: any) => r.tillNumber);
            }
        } catch (e) { console.warn('database: MySQL getAllTillNumbers failed:', e); }
    }
    return sqlite.getAllTillNumbers();
}

/**
 * Get the maximum order number across ALL tills.
 * In multi-mode, queries MariaDB directly for the real-time global maximum.
 * Falls back to local SQLite if MariaDB is unreachable.
 */
export async function getGlobalMaxOrderNumber(): Promise<number> {
    if (isMultiMode()) {
        try {
            const mysqlDb = await getMysqlDb();
            if (mysqlDb) {
                const rows: any[] = await mysqlDb.select(
                    `SELECT MAX(orderNumber) as maxNum FROM orders WHERE orderNumber > 0`
                );
                return rows[0]?.maxNum || 0;
            }
        } catch (e) {
            console.warn('database: MySQL getGlobalMaxOrderNumber failed, using local:', e);
        }
    }

    // Fallback: query local SQLite
    const d = await sqlite.getDb();
    const rows: any[] = await d.select(
        `SELECT MAX(orderNumber) as maxNum FROM orders WHERE orderNumber > 0`
    );
    return rows[0]?.maxNum || 0;
}

export async function getTillPeriodReport(
    tillNumber: string, startTime: string, endTime: string
) {
    return sqlite.getTillPeriodReport(tillNumber, startTime, endTime);
}

// ─── Svelte Store Hydration ─────────────────────────────────────────────────

import {
    productsDB, categoriesDB, posPagesDB, tilesDB, taxRatesDB, employeesDB,
    settingsDB, customersDB, storeDB, registersDB, discountsDB,
    ordersDB, orderLinesDB, paymentsDB, suppliersDB, productSuppliersDB,
    inventoryLogDB, loyaltyLogDB, auditLogDB, shiftsDB, cashMovementsDB,
    promoGroupsDB, promoGroupItemsDB
} from './db';
import { hydrateTheme } from './theme';

/**
 * Read all tables from the current data source (MySQL in multi mode,
 * SQLite in single mode) and push the results into the Svelte stores
 * that drive the UI. Call this at startup and after every background sync.
 */
export async function hydrateSvelteStores(): Promise<void> {
    console.log('database: hydrating Svelte stores…');

    const [
        cats, pages, tiles, prods, taxRates, emps, settings, customers,
        registers, discounts, promoGroups, promoGroupItems,
        orders, orderLines, payments, suppliers, productSuppliers,
        inventoryLog, loyaltyLog, auditLog, shifts, cashMovements
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
        getAll('payments'),
        getAll('suppliers'),
        getAll('product_suppliers'),
        getAll('inventory_logs'),
        getAll('loyalty_logs'),
        getAll('audit_logs'),
        getAll('shifts'),
        getAll('cash_movements'),
    ]);

    categoriesDB.set(cats.map(c => sqlite.rehydrateBooleans(c, ['isActive', 'showOnPos'])));
    posPagesDB.set(pages);
    tilesDB.set(tiles);
    productsDB.set(prods.map(p => sqlite.rehydrateBooleans(p, [
        'isActive', 'isWeighable', 'showInGoods', 'showInPos', 'trackStock'
    ])));
    taxRatesDB.set(taxRates.map(t => sqlite.rehydrateBooleans(t, ['isDefault'])));
    employeesDB.set(emps.map(e => sqlite.rehydrateBooleans(e, ['isActive'])));
    settingsDB.set(settings);
    hydrateTheme(settings);
    customersDB.set(customers);
    registersDB.set(registers.map(r => sqlite.rehydrateBooleans(r, ['isActive'])));
    discountsDB.set(discounts.map(d => sqlite.rehydrateBooleans(d, ['isActive', 'autoApply'])));
    promoGroupsDB.set(promoGroups.map(g => sqlite.rehydrateBooleans(g, ['isActive'])));
    promoGroupItemsDB.set(promoGroupItems);
    ordersDB.set(orders);
    orderLinesDB.set(orderLines);
    paymentsDB.set(payments);
    suppliersDB.set(suppliers);
    productSuppliersDB.set(productSuppliers);
    inventoryLogDB.set(inventoryLog);
    loyaltyLogDB.set(loyaltyLog);
    auditLogDB.set(auditLog);
    shiftsDB.set(shifts);
    cashMovementsDB.set(cashMovements);

    // Restore store info from settings
    const storeInfo = settings.find((s: any) => s.key === 'store_info');
    if (storeInfo) {
        try { storeDB.set(JSON.parse(storeInfo.value)); } catch (e) { /* ignore */ }
    }

    console.log('database: Svelte stores hydrated ✅');
}

// ─── Background Sync (Multi Mode) ──────────────────────────────────────────

let syncInterval: any = null;
let fastSyncInterval: any = null;

let isSyncRunning = false;
let isFastSyncRunning = false;

/** Tables that change during transactions — synced frequently (every 5s). */
const FAST_SYNC_TABLES = [
    'orders', 'order_lines', 'payments', 'shifts', 'cash_movements'
];

/** All tables — synced less frequently (every 60s). */
const ALL_SYNC_TABLES = [
    'products', 'categories', 'pos_pages', 'pos_tiles',
    'tax_rates', 'discounts', 'promo_groups', 'promo_group_items',
    'employees', 'settings', 'customers', 'registers',
    'suppliers', 'product_suppliers', 'inventory_logs',
    'orders', 'order_lines', 'payments',
    'loyalty_logs', 'audit_logs', 'shifts', 'cash_movements'
];

/**
 * Run a fast sync cycle that only pulls transaction-related tables
 * (orders, order_lines, payments, shifts, cash_movements) and rehydrates
 * the Svelte stores. This runs every 5 seconds for near-real-time updates.
 */
export async function runFastSyncCycle(): Promise<void> {
    if (!isMultiMode() || isFastSyncRunning || isSyncRunning) return;
    isFastSyncRunning = true;
    try {
        const mysqlDb = await getMysqlDb();
        if (!mysqlDb) return;

        const localDb = await sqlite.getDb();
        const lastSyncRows: any[] = await localDb.select(`SELECT value FROM settings WHERE key = 'last_fast_sync_time'`);
        const lastFastSyncTime = lastSyncRows.length > 0 ? lastSyncRows[0].value : null;
        const newSyncTime = new Date().toISOString();

        let totalChanges = 0;

        for (const table of FAST_SYNC_TABLES) {
            try {
                let rows: any[] = [];
                if (lastFastSyncTime) {
                    rows = await mysql.mysqlGetUpdatedSince(table, lastFastSyncTime);
                } else {
                    rows = await mysql.mysqlGetAll(table);
                }

                if (rows.length === 0) continue;

                const idKey = table === 'settings' ? 'key' : 'id';
                await sqlite.bulkUpsert(table, rows, idKey);
                totalChanges += rows.length;
            } catch (e) {
                // Silently skip
            }
        }

        // Save fast sync time
        await sqlite.upsert('settings', { key: 'last_fast_sync_time', value: newSyncTime, updatedAt: newSyncTime }, 'key');

        // Only rehydrate stores if there were actual changes (avoids unnecessary re-renders)
        if (totalChanges > 0) {
            console.log(`database: fast sync found ${totalChanges} changes, rehydrating…`);
            await hydrateSvelteStores();
        }

        connectionState.update(s => ({ ...s, mysqlOnline: true, syncError: null }));
    } catch (e: any) {
        // Don't mark offline for fast-sync failures — the full sync will handle that
        console.warn('database: fast sync failed:', e);
    } finally {
        isFastSyncRunning = false;
    }
}

/**
 * Run one full sync cycle: flush offline queue → pull MySQL → update
 * local SQLite cache → rehydrate Svelte stores.
 */
export async function runSyncCycle(): Promise<void> {
    if (!isMultiMode() || isSyncRunning) return;
    isSyncRunning = true;
    try {
        const mysqlDb = await getMysqlDb();
        if (!mysqlDb) return;

        // Check if MySQL is empty. If it is, perform an initial upload of local data!
        try {
            const countRes: any[] = await mysqlDb.select('SELECT COUNT(*) as count FROM products');
            if (countRes[0].count === 0) {
                console.log('database: MariaDB is empty! Starting initial upload of local data...');
                const localDb = await sqlite.getDb();
                const tablesToPush = [
                    'categories', 'products', 'pos_pages', 'pos_tiles',
                    'tax_rates', 'discounts', 'promo_groups', 'promo_group_items',
                    'employees', 'settings', 'customers', 'registers',
                    'suppliers', 'product_suppliers', 'inventory_logs',
                    'orders', 'order_lines', 'payments',
                    'loyalty_logs', 'audit_logs', 'shifts', 'cash_movements'
                ];
                for (const table of tablesToPush) {
                    const rows: any[] = await localDb.select(`SELECT * FROM ${table}`);
                    if (rows.length === 0) continue;
                    
                    console.log(`database: Uploading ${rows.length} rows to MariaDB ${table}...`);
                    if (table === 'products') {
                        const chunkSize = 500;
                        for (let i = 0; i < rows.length; i += chunkSize) {
                            await mysql.mysqlBulkAddProducts(rows.slice(i, i + chunkSize));
                        }
                    } else {
                        const idKey = table === 'settings' ? 'key' : 'id';
                        for (const row of rows) {
                            await mysql.mysqlUpsert(table, row, idKey);
                        }
                    }
                }
                console.log('database: Initial upload complete!');
            }
        } catch (e) {
            console.warn('database: failed to run initial upload:', e);
        }

        // Flush any queued offline operations first
        await flushOfflineQueue();

        // Pull fresh data from MySQL → update local SQLite cache
        // Get last sync time to do Delta Syncing
        const localDb = await sqlite.getDb();
        const lastSyncRows: any[] = await localDb.select(`SELECT value FROM settings WHERE key = 'last_sync_time'`);
        const lastSyncTime = lastSyncRows.length > 0 ? lastSyncRows[0].value : null;
        const newSyncTime = new Date().toISOString();

        for (const table of ALL_SYNC_TABLES) {
            try {
                let rows: any[] = [];
                if (lastSyncTime) {
                    rows = await mysql.mysqlGetUpdatedSince(table, lastSyncTime);
                } else {
                    rows = await mysql.mysqlGetAll(table);
                }

                if (rows.length === 0) continue;
                
                const idKey = table === 'settings' ? 'key' : 'id';
                await sqlite.bulkUpsert(table, rows, idKey);
                
                console.log(`database: synced ${rows.length} rows to local cache for ${table}`);
            } catch (e) {
                // Silently skip failed tables (table may not exist yet)
            }
        }

        // Save the new sync time
        await sqlite.upsert('settings', { key: 'last_sync_time', value: newSyncTime, updatedAt: newSyncTime }, 'key');

        // Rehydrate Svelte stores so the UI reflects latest data
        await hydrateSvelteStores();

        connectionState.update(s => ({ ...s, mysqlOnline: true, syncError: null }));
        console.log('database: full sync complete ✅');
    } catch (e: any) {
        console.warn('database: background sync failed:', e);
        connectionState.update(s => ({ ...s, mysqlOnline: false, syncError: e.toString() }));
    } finally {
        isSyncRunning = false;
    }
}

/**
 * Force an immediate sync cycle. Call this after completing a transaction
 * so that other tills see the change quickly without waiting for the timer.
 */
export async function triggerSync(): Promise<void> {
    if (!isMultiMode()) return;
    // Run a fast sync immediately to push/pull transaction data
    await runFastSyncCycle();
}

/**
 * Start periodic background sync from MySQL → SQLite cache → Svelte stores.
 * Runs an immediate full sync first, then:
 *  - Fast sync (transaction tables only) every 5 seconds
 *  - Full sync (all tables) every 60 seconds
 */
export async function startBackgroundSync(intervalMs: number = 5000): Promise<void> {
    if (syncInterval) clearInterval(syncInterval);
    if (fastSyncInterval) clearInterval(fastSyncInterval);

    // Run an immediate full sync so the UI is populated on first load
    await runSyncCycle();

    // Fast sync: pull transaction-related tables every 5 seconds
    fastSyncInterval = setInterval(() => runFastSyncCycle(), intervalMs);

    // Full sync: pull ALL tables every 60 seconds (products, categories, settings, etc.)
    syncInterval = setInterval(() => runSyncCycle(), 60000);
}

/** Stop background sync. */
export function stopBackgroundSync(): void {
    if (syncInterval) {
        clearInterval(syncInterval);
        syncInterval = null;
    }
    if (fastSyncInterval) {
        clearInterval(fastSyncInterval);
        fastSyncInterval = null;
    }
}
