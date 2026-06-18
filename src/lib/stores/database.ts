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
import { isMultiMode, getMysqlDb, connectionState, pingMysql, buildMysqlUri } from './connection';
import { get } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';

const PROMOTION_SYNC_TABLES = ['discounts', 'promo_groups', 'promo_group_items'];
const PROMOTION_SYNC_TABLE_SET = new Set(PROMOTION_SYNC_TABLES);

// ─── Re-exports that never change (always local SQLite) ─────────────────────

export {
    initDb,
    migrateFromLocalStorage,
    rehydrateBooleans,
    getDb,
} from './sqlite';

export type {
    SeedPayload, SalesOverview, PaymentBreakdown, TopProduct,
    TillReportOption, TillSalesSummary, DailySalesPoint,
    BusinessSummary, EmployeeSalesSummary
} from './sqlite';

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
    await d.execute(`
        CREATE TABLE IF NOT EXISTS _sync_conflicts (
            id TEXT PRIMARY KEY,
            table_name TEXT NOT NULL,
            operation TEXT NOT NULL,
            data TEXT NOT NULL,
            reason TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
    `);
}

export interface SyncConflict {
    id: string;
    table_name: string;
    operation: string;
    data: string;
    reason: string;
    created_at: string;
}

export async function getSyncConflicts(): Promise<SyncConflict[]> {
    const d = await sqlite.getDb();
    return d.select(`SELECT * FROM _sync_conflicts ORDER BY created_at DESC`);
}

export async function dismissSyncConflict(id: string): Promise<void> {
    const d = await sqlite.getDb();
    await d.execute(`DELETE FROM _sync_conflicts WHERE id = ?`, [id]);
}

export async function retrySyncConflict(id: string): Promise<void> {
    const d = await sqlite.getDb();
    const rows: SyncConflict[] = await d.select(`SELECT * FROM _sync_conflicts WHERE id = ? LIMIT 1`, [id]);
    const conflict = rows[0];
    if (!conflict) return;
    const data = JSON.parse(conflict.data);
    if (conflict.operation === 'saleBundle' && data?.order?.type === 'return') {
        throw new Error('A rejected refund or void cannot be retried. Review it, then dismiss this conflict.');
    }
    await d.execute(
        `INSERT OR REPLACE INTO _offline_queue (id, table_name, operation, data, id_key, created_at)
         VALUES (?, ?, ?, ?, 'id', ?)`,
        [conflict.id, conflict.table_name, conflict.operation, conflict.data, new Date().toISOString()]
    );
    await d.execute(`DELETE FROM _sync_conflicts WHERE id = ?`, [id]);
    await flushOfflineQueue();
}

function isReversalConflict(error: unknown, data: any): boolean {
    if (data?.order?.type !== 'return') return false;
    const message = String(error).toLowerCase();
    return message.includes('sale is not available for refund')
        || message.includes('refund exceeds the remaining')
        || message.includes('original sale was not found')
        || message.includes('invalid refund transaction')
        || message.includes('invalid reversal')
        || message.includes('invalid full reversal')
        || message.includes('invalid void')
        || message.includes('partial refunds cannot restore stock')
        || message.includes('customer loyalty balance changed');
}

async function discardLocalConflictingReversal(bundle: any, mysqlDb: any): Promise<void> {
    const reversalId = bundle?.order?.id;
    const originalId = bundle?.order?.originalOrderId;
    if (!reversalId) return;
    const d = await sqlite.getDb();

    const stockRows: any[] = await d.select(
        `SELECT productId, quantityChange FROM inventory_logs WHERE referenceId = ? AND type = 'return'`,
        [reversalId],
    );
    for (const row of stockRows) {
        await d.execute(
            `UPDATE products SET stockLevel = stockLevel - ? WHERE id = ?`,
            [Math.abs(Number(row.quantityChange || 0)), row.productId],
        );
    }
    const loyaltyRows: any[] = await d.select(
        `SELECT customerId, pointsChange FROM loyalty_logs WHERE orderId = ?`,
        [reversalId],
    );
    for (const row of loyaltyRows) {
        await d.execute(
            `UPDATE customers SET loyaltyPoints = loyaltyPoints - ? WHERE id = ?`,
            [Number(row.pointsChange || 0), row.customerId],
        );
    }
    await d.execute(`DELETE FROM inventory_logs WHERE referenceId = ?`, [reversalId]);
    await d.execute(`DELETE FROM loyalty_logs WHERE orderId = ?`, [reversalId]);
    if (bundle?.audit?.id) {
        await d.execute(`DELETE FROM audit_logs WHERE id = ?`, [bundle.audit.id]);
    }
    await d.execute(`DELETE FROM payments WHERE orderId = ?`, [reversalId]);
    await d.execute(`DELETE FROM order_lines WHERE orderId = ?`, [reversalId]);
    await d.execute(`DELETE FROM orders WHERE id = ?`, [reversalId]);

    if (originalId) {
        const serverRows: any[] = await mysqlDb.select(
            `SELECT * FROM orders WHERE id = ? LIMIT 1`,
            [originalId],
        );
        if (serverRows[0]) await sqlite.upsert('orders', serverRows[0]);
    }
}

/** Queue a write operation for later sync to MySQL. */
async function queueOffline(
    tableName: string,
    operation: 'upsert' | 'remove' | 'adjustStock' | 'saleBundle' | 'promotionBundle' | 'promotionDelete',
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
    await ensureDatabaseIdentityForSync();

    const d = await sqlite.getDb();
    const purgeRows: any[] = await mysqlDb.select(
        `SELECT value FROM settings WHERE \`key\` = 'transaction_purge_at' LIMIT 1`
    );
    if (purgeRows[0]?.value) {
        await d.execute(
            `DELETE FROM _offline_queue
             WHERE created_at <= ? AND (
                operation = 'saleBundle' OR
                table_name IN ('orders','order_lines','payments','shifts','cash_movements','inventory_logs','audit_logs')
             )`,
            [purgeRows[0].value]
        );
    }
    const rows: any[] = await d.select(
        `SELECT * FROM _offline_queue ORDER BY created_at ASC`
    );

    let flushed = 0;
    for (const row of rows) {
        try {
            const data = JSON.parse(row.data);
            if (row.operation === 'upsert') {
                if (row.table_name === 'promo_group_items' && data?.productId) {
                    const products = await getLocalProductsForPromotionItems([data]);
                    await mysql.mysqlEnsureProductSnapshots(products);
                }
                await mysql.mysqlSafeOfflineUpsert(row.table_name, data, row.id_key);
            } else if (row.operation === 'remove') {
                await mysql.mysqlRemove(row.table_name, data.id, row.id_key);
            } else if (row.operation === 'adjustStock') {
                // Replay the stock delta on the server (deltas commute, so order
                // of replay across tills doesn't matter).
                await mysql.mysqlAdjustStock(data.id, data.delta);
            } else if (row.operation === 'saleBundle') {
                const config = get(connectionState).mysqlConfig;
                if (!config) throw new Error('MariaDB configuration is unavailable');
                await invoke('commit_mysql_sale', { mysqlUri: buildMysqlUri(config), bundle: data });
            } else if (row.operation === 'promotionBundle') {
                await mysql.mysqlSavePromotionBundle(
                    data.group,
                    data.discount,
                    Array.isArray(data.items) ? data.items : [],
                    Array.isArray(data.products) ? data.products : [],
                );
            } else if (row.operation === 'promotionDelete') {
                await mysql.mysqlDeletePromotionBundle(
                    Array.isArray(data.discountIds) ? data.discountIds : [data.discountId].filter(Boolean),
                    data.groupId || '',
                );
            }
            await d.execute(`DELETE FROM _offline_queue WHERE id = ?`, [row.id]);
            flushed++;
        } catch (e) {
            const data = JSON.parse(row.data);
            if (String(e).includes('SYNC_CONFLICT') || isReversalConflict(e, data)) {
                if (row.table_name === 'products') {
                    const conflict = String(e).toLowerCase();
                    const product = JSON.parse(row.data);
                    if (conflict.includes('uq_products_scale_plu')) {
                        await d.execute(`UPDATE products SET scalePlu = NULL WHERE id = ?`, [product.id]);
                    } else if (conflict.includes('uq_products_sku')) {
                        await d.execute(`UPDATE products SET sku = NULL WHERE id = ?`, [product.id]);
                    } else if (conflict.includes('uq_products_barcode') || conflict.includes('duplicate entry')) {
                        await d.execute(`UPDATE products SET barcode = NULL WHERE id = ?`, [product.id]);
                    }
                }
                if (isReversalConflict(e, data)) {
                    await discardLocalConflictingReversal(data, mysqlDb);
                }
                await d.execute(
                    `INSERT INTO _sync_conflicts (id, table_name, operation, data, reason, created_at)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [row.id, row.table_name, row.operation, row.data, String(e), new Date().toISOString()]
                );
                await d.execute(`DELETE FROM _offline_queue WHERE id = ?`, [row.id]);
                console.warn(`database: moved offline conflict ${row.id} aside for review`);
                continue;
            }
            console.warn(`database: failed to flush queue item ${row.id}:`, e);
            break; // Stop at first failure to maintain order
        }
    }

    if (flushed > 0) {
        console.log(`database: flushed ${flushed} offline operations to MySQL`);
    }
    return flushed;
}

async function pendingOfflineQueueCount(): Promise<number> {
    const d = await sqlite.getDb();
    const rows: any[] = await d.select(`SELECT COUNT(*) AS count FROM _offline_queue`);
    return Number(rows[0]?.count || 0);
}

function pushWriteInBackground(
    label: string,
    write: () => Promise<void>,
    queue: () => Promise<void>,
): void {
    if (!isMultiMode()) return;
    void ensureDatabaseIdentityForSync().then(write).catch(async (e) => {
        console.warn(`database: background ${label} failed, queuing offline:`, e);
        if (isDatabaseIdentityMismatch(e)) {
            connectionState.update(s => ({ ...s, mysqlOnline: false, syncError: String(e) }));
            return;
        }
        try {
            await queue();
        } catch (queueError) {
            console.warn(`database: failed to queue background ${label}:`, queueError);
        }
        connectionState.update(s => ({ ...s, mysqlOnline: false, syncError: String(e) }));
    });
}

async function writeOrQueueImmediately(
    label: string,
    write: () => Promise<void>,
    queue: () => Promise<void>,
): Promise<void> {
    if (!isMultiMode()) return;
    try {
        await ensureDatabaseIdentityForSync();
        await write();
        connectionState.update(s => ({ ...s, mysqlOnline: true, syncError: null }));
    } catch (e) {
        console.warn(`database: ${label} failed, queuing offline:`, e);
        if (isDatabaseIdentityMismatch(e)) {
            connectionState.update(s => ({ ...s, mysqlOnline: false, syncError: String(e) }));
            throw e;
        }
        try {
            await queue();
        } catch (queueError) {
            console.warn(`database: failed to queue ${label}:`, queueError);
            throw queueError;
        }
        connectionState.update(s => ({ ...s, mysqlOnline: false, syncError: String(e) }));
    }
}

async function tryImmediateProductWrite(
    label: string,
    write: () => Promise<void>,
): Promise<'done' | 'queue' | 'skipped'> {
    if (!isMultiMode()) return 'skipped';
    try {
        await ensureDatabaseIdentityForSync();
        await write();
        connectionState.update(s => ({ ...s, mysqlOnline: true, syncError: null }));
        return 'done';
    } catch (e) {
        console.warn(`database: immediate ${label} failed:`, e);
        if (isDatabaseIdentityMismatch(e)) {
            connectionState.update(s => ({ ...s, mysqlOnline: false, syncError: String(e) }));
            throw e;
        }
        if (String(e).includes('PRODUCT_EDIT_CONFLICT')) {
            throw new Error('This item was changed on another till. Wait for sync, then try again.');
        }
        if (isProductIdentifierConflict(e)) {
            throw friendlyProductIdentifierError(e);
        }
        connectionState.update(s => ({ ...s, mysqlOnline: false, syncError: String(e) }));
        return 'queue';
    }
}

async function queueLocalProductSnapshot(productId: string, fallback?: any): Promise<void> {
    const d = await sqlite.getDb();
    const rows: any[] = await d.select('SELECT * FROM products WHERE id = ? LIMIT 1', [productId]);
    const product = rows[0] || fallback;
    if (!product) throw new Error(`Cannot queue product ${productId}; no local snapshot exists`);
    await queueOffline('products', 'upsert', product);
}

// ─── Helper: try MySQL, fall back to SQLite ─────────────────────────────────

async function tryMysql(): Promise<boolean> {
    if (!isMultiMode()) return false;
    const db = await getMysqlDb();
    return db !== null;
}

// ─── Device-local settings (must NEVER sync between tills) ───────────────────
// These keys identify or configure a single machine. Syncing them would give
// every till the same till_id, leak DB credentials, and clobber sync state.
const LOCAL_ONLY_SETTING_KEYS = new Set([
    'pos_mode', 'mysql_config', 'till_id', 'till_name', 'till_seq',
    'last_sync_time', 'last_fast_sync_time', 'bootstrap_uploaded',
    'transaction_purge_applied_at',
    'cctv_pos_enabled', 'cctv_pos_host', 'cctv_pos_port', 'cctv_pos_number',
    'cctv_pos_name', 'cctv_pos_source_ip', 'cctv_pos_encoding',
    'cctv_pos_send_items', 'cctv_pos_send_receipts',
    'cash_drawer_enabled', 'cash_drawer_printer_host', 'cash_drawer_printer_port',
    'cash_drawer_pin', 'cash_drawer_pulse_on_ms', 'cash_drawer_pulse_off_ms',
    'receipt_printer_enabled', 'receipt_printer_connection', 'receipt_printer_host',
    'receipt_printer_port', 'receipt_printer_name', 'receipt_printer_device_path',
    'receipt_printer_baud_rate', 'receipt_printer_paper_width',
    'receipt_printer_auto_print_after_payment', 'receipt_printer_cut_paper',
    'receipt_printer_open_drawer_after_cash', 'receipt_printer_open_drawer_after_payment',
    'receipt_printer_encoding',
    'label_printer_enabled', 'label_printer_connection', 'label_printer_protocol',
    'label_printer_host', 'label_printer_port', 'label_printer_name',
    'label_printer_device_path', 'label_printer_baud_rate',
    // Server-side control rows — never copy between tills.
    'till_seq_counter', 'bootstrap_done',
]);

function isSyncableSetting(key: string): boolean {
    if (LOCAL_ONLY_SETTING_KEYS.has(key)) return false;
    if (key.startsWith('sync_ts_')) return false;
    if (key.startsWith('migration_')) return false;
    return true;
}

// ─── Shop / database identity guard ─────────────────────────────────────────
// This prevents a till from silently merging Shop A's local SQLite cache with
// Shop B's MariaDB database. Licensing will build on top of this later.

const APP_IDENTITY_ID = 'main';
const DATABASE_IDENTITY_MISMATCH_CODE = 'DATABASE_IDENTITY_MISMATCH';

export interface AppIdentity {
    id: string;
    shopId: string;
    shopName: string;
    licenseId: string;
    createdAt: string;
    updatedAt: string;
    identitySignature: string;
}

export class DatabaseIdentityMismatchError extends Error {
    code = DATABASE_IDENTITY_MISMATCH_CODE;
}

function makeShopId(): string {
    const cryptoObj = globalThis.crypto;
    if (cryptoObj?.randomUUID) return `shop_${cryptoObj.randomUUID()}`;
    return `shop_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeIdentity(row: any | null): AppIdentity | null {
    if (!row?.shopId) return null;
    return {
        id: row.id || APP_IDENTITY_ID,
        shopId: String(row.shopId),
        shopName: String(row.shopName || ''),
        licenseId: String(row.licenseId || ''),
        createdAt: String(row.createdAt || row.updatedAt || new Date().toISOString()),
        updatedAt: String(row.updatedAt || row.createdAt || new Date().toISOString()),
        identitySignature: String(row.identitySignature || ''),
    };
}

async function getLocalAppIdentity(): Promise<AppIdentity | null> {
    const d = await sqlite.getDb();
    const rows: any[] = await d.select(`SELECT * FROM app_identity WHERE id = ? LIMIT 1`, [APP_IDENTITY_ID]);
    return normalizeIdentity(rows[0] || null);
}

async function getRemoteAppIdentity(): Promise<AppIdentity | null> {
    const d = await getMysqlDb();
    if (!d) return null;
    const rows: any[] = await d.select(`SELECT * FROM app_identity WHERE id = ? LIMIT 1`, [APP_IDENTITY_ID]);
    return normalizeIdentity(rows[0] || null);
}

async function saveLocalAppIdentity(identity: AppIdentity): Promise<void> {
    await sqlite.upsert('app_identity', identity, 'id');
}

async function saveRemoteAppIdentity(identity: AppIdentity): Promise<void> {
    await mysql.mysqlUpsert('app_identity', identity, 'id');
}

function makeIdentity(shopName = ''): AppIdentity {
    const stamp = new Date().toISOString();
    return {
        id: APP_IDENTITY_ID,
        shopId: makeShopId(),
        shopName,
        licenseId: '',
        createdAt: stamp,
        updatedAt: stamp,
        identitySignature: '',
    };
}

async function getLocalStoreName(): Promise<string> {
    const d = await sqlite.getDb();
    const rows: any[] = await d.select(`SELECT value FROM settings WHERE key = 'store_info' LIMIT 1`);
    try {
        return rows[0]?.value ? String(JSON.parse(rows[0].value)?.name || '') : '';
    } catch {
        return '';
    }
}

async function getRemoteStoreName(): Promise<string> {
    const d = await getMysqlDb();
    if (!d) return '';
    const rows: any[] = await d.select("SELECT value FROM settings WHERE `key` = 'store_info' LIMIT 1");
    try {
        return rows[0]?.value ? String(JSON.parse(rows[0].value)?.name || '') : '';
    } catch {
        return '';
    }
}

async function remoteHasShopData(): Promise<boolean> {
    const d = await getMysqlDb();
    if (!d) return false;
    const rows: any[] = await d.select(
        `SELECT (SELECT COUNT(*) FROM products) AS products,
                (SELECT COUNT(*) FROM orders) AS orders,
                (SELECT COUNT(*) FROM customers) AS customers,
                (SELECT COUNT(*) FROM employees) AS employees,
                (SELECT COUNT(*) FROM settings WHERE \`key\` = 'store_info') AS storeInfo`
    );
    const row = rows[0] || {};
    return ['products', 'orders', 'customers', 'employees', 'storeInfo']
        .some((key) => Number(row[key] || 0) > 0);
}

function namesConflict(localName: string, remoteName: string): boolean {
    return Boolean(localName.trim() && remoteName.trim()
        && localName.trim().toLowerCase() !== remoteName.trim().toLowerCase());
}

function identityMismatchMessage(localIdentity: AppIdentity, remoteIdentity: AppIdentity): string {
    return `${DATABASE_IDENTITY_MISMATCH_CODE}: This MariaDB database belongs to a different shop. ` +
        `Local shop: ${localIdentity.shopName || localIdentity.shopId}. ` +
        `MariaDB shop: ${remoteIdentity.shopName || remoteIdentity.shopId}. ` +
        `Sync has been blocked to protect your data. Reset this till or restore a backup that belongs to the correct shop.`;
}

export async function ensureLocalShopIdentity(shopName = ''): Promise<AppIdentity> {
    const existing = await getLocalAppIdentity();
    if (existing) {
        const nextName = shopName.trim();
        if (nextName && !existing.shopName) {
            const updated = { ...existing, shopName: nextName, updatedAt: new Date().toISOString() };
            await saveLocalAppIdentity(updated);
            return updated;
        }
        return existing;
    }
    const identity = makeIdentity(shopName.trim() || await getLocalStoreName());
    await saveLocalAppIdentity(identity);
    return identity;
}

export async function ensureDatabaseIdentityForSync(): Promise<AppIdentity | null> {
    if (!isMultiMode()) return ensureLocalShopIdentity();

    const remoteDb = await getMysqlDb();
    if (!remoteDb) return getLocalAppIdentity();

    let localIdentity = await getLocalAppIdentity();
    let remoteIdentity = await getRemoteAppIdentity();
    const localName = localIdentity?.shopName || await getLocalStoreName();
    const remoteName = remoteIdentity?.shopName || await getRemoteStoreName();

    if (localIdentity && remoteIdentity) {
        if (localIdentity.shopId !== remoteIdentity.shopId) {
            throw new DatabaseIdentityMismatchError(identityMismatchMessage(localIdentity, remoteIdentity));
        }
        return localIdentity;
    }

    if (!localIdentity && remoteIdentity) {
        if (namesConflict(localName, remoteIdentity.shopName || remoteName)) {
            const preview = makeIdentity(localName);
            throw new DatabaseIdentityMismatchError(identityMismatchMessage(preview, remoteIdentity));
        }
        await saveLocalAppIdentity(remoteIdentity);
        return remoteIdentity;
    }

    if (localIdentity && !remoteIdentity) {
        if (await remoteHasShopData()) {
            if (namesConflict(localIdentity.shopName || localName, remoteName)) {
                const preview = { ...localIdentity, shopName: localIdentity.shopName || localName };
                const remotePreview = makeIdentity(remoteName);
                throw new DatabaseIdentityMismatchError(identityMismatchMessage(preview, remotePreview));
            }
        }
        const identity = {
            ...localIdentity,
            shopName: localIdentity.shopName || localName || remoteName,
            updatedAt: new Date().toISOString(),
        };
        await saveRemoteAppIdentity(identity);
        if (identity.shopName !== localIdentity.shopName) await saveLocalAppIdentity(identity);
        return identity;
    }

    if (namesConflict(localName, remoteName)) {
        throw new DatabaseIdentityMismatchError(
            `${DATABASE_IDENTITY_MISMATCH_CODE}: This MariaDB database appears to belong to a different shop. ` +
            `Local shop: ${localName}. MariaDB shop: ${remoteName}. ` +
            `Sync has been blocked to protect your data. Reset this till or restore a backup that belongs to the correct shop.`
        );
    }

    const identity = makeIdentity(remoteName || localName);
    await saveLocalAppIdentity(identity);
    await saveRemoteAppIdentity(identity);
    return identity;
}

function isDatabaseIdentityMismatch(error: unknown): boolean {
    return error instanceof DatabaseIdentityMismatchError
        || String(error).includes(DATABASE_IDENTITY_MISMATCH_CODE);
}

// ─── Per-table sync watermarks ──────────────────────────────────────────────
// Each table tracks its own "last successfully synced" server timestamp
// (settings key: sync_ts_<table>). A watermark only advances when that table's
// pull succeeds, so a transient error on one table can never permanently skip
// rows — the root cause of "data missing on the other laptop".

async function getTableWatermark(table: string): Promise<string | null> {
    const d = await sqlite.getDb();
    const rows: any[] = await d.select(`SELECT value FROM settings WHERE key = ?`, [`sync_ts_${table}`]);
    return rows.length > 0 ? rows[0].value : null;
}

async function setTableWatermark(table: string, value: string): Promise<void> {
    await sqlite.upsert('settings', { key: `sync_ts_${table}`, value, updatedAt: value }, 'key');
}

async function purgeLocalTransactionsBefore(marker: string): Promise<void> {
    const d = await sqlite.getDb();
    const oldOrder = `(createdAt IS NULL OR createdAt = '' OR createdAt <= ?)`;
    const oldShift = `(openedAt IS NULL OR openedAt = '' OR openedAt <= ?)`;

    await d.execute(`DELETE FROM inventory_logs WHERE referenceId IN (SELECT id FROM orders WHERE ${oldOrder})`, [marker]);
    await d.execute(`DELETE FROM audit_logs WHERE entityId IN (SELECT id FROM orders WHERE ${oldOrder}) OR ((entityType = 'order' OR action IN ('sale_completed','refund_completed')) AND (createdAt IS NULL OR createdAt = '' OR createdAt <= ?))`, [marker, marker]);
    await d.execute(`DELETE FROM payments WHERE orderId IN (SELECT id FROM orders WHERE ${oldOrder})`, [marker]);
    await d.execute(`DELETE FROM order_lines WHERE orderId IN (SELECT id FROM orders WHERE ${oldOrder})`, [marker]);
    await d.execute(`DELETE FROM cash_movements WHERE shiftId IN (SELECT id FROM shifts WHERE ${oldShift})`, [marker]);
    await d.execute(`DELETE FROM orders WHERE ${oldOrder}`, [marker]);
    await d.execute(`DELETE FROM shifts WHERE ${oldShift}`, [marker]);
    await d.execute(`DELETE FROM daily_sales_summary`);
    await d.execute(`DELETE FROM till_report_markers`);
    await d.execute(
        `DELETE FROM _offline_queue
         WHERE created_at <= ? AND (
            operation = 'saleBundle' OR
            table_name IN ('orders','order_lines','payments','shifts','cash_movements','inventory_logs','audit_logs')
         )`,
        [marker]
    );
    await d.execute(
        `DELETE FROM tombstones WHERE table_name IN ('orders','order_lines','payments','shifts','cash_movements','inventory_logs','audit_logs')`
    );
    await sqlite.upsert('settings', { key: 'transaction_purge_applied_at', value: marker, updatedAt: marker }, 'key');
}

async function applyTransactionPurgeMarker(): Promise<boolean> {
    const d = await sqlite.getDb();
    const rows: any[] = await d.select(
        `SELECT key, value FROM settings WHERE key IN ('transaction_purge_at','transaction_purge_applied_at')`
    );
    const marker = rows.find(row => row.key === 'transaction_purge_at')?.value || '';
    const applied = rows.find(row => row.key === 'transaction_purge_applied_at')?.value || '';
    if (!marker || marker === applied) return false;
    await purgeLocalTransactionsBefore(marker);
    return true;
}

// ─── Tombstones (delete propagation) ────────────────────────────────────────

/** Record a deletion so other tills remove the same row on their next sync. */
async function recordTombstone(table: string, id: string): Promise<void> {
    const tomb = {
        id: `${table}:${id}`,
        table_name: table,
        row_id: id,
        deletedAt: new Date().toISOString(),
    };
    await sqlite.upsert('tombstones', tomb, 'id');
    pushWriteInBackground(
        `tombstone for ${table}/${id}`,
        () => mysql.mysqlUpsert('tombstones', tomb, 'id'),
        () => queueOffline('tombstones', 'upsert', tomb, 'id'),
    );
}

/**
 * Pull tombstones created since our last tombstone watermark and apply the
 * deletions to the local SQLite cache. Returns the number of rows removed.
 */
async function applyTombstones(newSyncTime: string): Promise<number> {
    const since = await getTableWatermark('tombstones');
    const d = await sqlite.getDb();
    let rows: any[];
    try {
        rows = since
            ? await mysql.mysqlGetUpdatedSince('tombstones', since)
            : await mysql.mysqlGetAll('tombstones');
    } catch (e) {
        // Couldn't pull tombstones — keep the watermark so we retry next cycle.
        return 0;
    }

    const allowedTables = new Set([...ALL_SYNC_TABLES, 'tombstones']);
    let applied = 0;
    let failed = false;
    for (const t of rows) {
        if (!allowedTables.has(t.table_name) || !t.row_id) {
            await d.execute(
                `INSERT OR REPLACE INTO _sync_conflicts (id, table_name, operation, data, reason, created_at)
                 VALUES (?, ?, 'remove', ?, ?, ?)`,
                [`tombstone:${t.id}`, String(t.table_name || 'unknown'), JSON.stringify(t),
                    'Invalid deletion record received from MariaDB', new Date().toISOString()]
            );
            continue;
        }
        try {
            await sqlite.remove(t.table_name, t.row_id);
            await sqlite.upsert('tombstones', t, 'id');
            applied++;
        } catch (e) {
            failed = true;
            console.warn(`database: could not apply tombstone ${t.id}:`, e);
        }
    }
    // Never skip a failed deletion. Keep the old watermark and retry the batch.
    if (failed) return applied;
    await setTableWatermark('tombstones', newSyncTime);
    return applied;
}

// ─── Bulk push helpers (initial upload / repair) ────────────────────────────
const PUSH_TABLES = [
    'categories', 'products', 'pos_pages', 'pos_tiles',
    'tax_rates', 'discounts', 'promo_groups', 'promo_group_items',
    'employees', 'settings', 'customers', 'registers',
    'suppliers', 'product_suppliers', 'inventory_logs',
    'orders', 'order_lines', 'payments',
    'loyalty_logs', 'audit_logs', 'shifts', 'cash_movements'
];

/** Push every local table to MariaDB (skips device-local settings keys). */
async function forcePushTables(localDb: any): Promise<void> {
    for (const table of PUSH_TABLES) {
        let rows: any[] = await localDb.select(`SELECT * FROM ${table}`);
        if (table === 'settings') rows = rows.filter((r: any) => isSyncableSetting(r.key));
        if (rows.length === 0) continue;

        console.log(`database: uploading ${rows.length} rows to MariaDB ${table}…`);
        if (table === 'products') {
            const chunkSize = 500;
            for (let i = 0; i < rows.length; i += chunkSize) {
                await mysql.mysqlBulkAddProducts(rows.slice(i, i + chunkSize));
            }
        } else {
            const idKey = table === 'settings' ? 'key' : 'id';
            for (const row of rows) await mysql.mysqlUpsert(table, row, idKey);
        }
    }
}

/**
 * One-time initial upload: only when the server is genuinely empty AND no
 * device has already claimed the bootstrap. A server-side flag prevents two
 * laptops from both uploading and creating duplicate/conflicting data.
 */
async function maybeBootstrapUpload(mysqlDb: any): Promise<void> {
    try {
        await ensureDatabaseIdentityForSync();
        const flag: any[] = await mysqlDb.select(`SELECT value FROM settings WHERE \`key\` = 'bootstrap_done'`);
        if (flag.length > 0) return;

        const localDb = await sqlite.getDb();
        const localFlag: any[] = await localDb.select(`SELECT value FROM settings WHERE key = 'bootstrap_uploaded'`);
        if (localFlag.length > 0) return;

        const counts: any[] = await mysqlDb.select(
            `SELECT (SELECT COUNT(*) FROM products) AS p,
                    (SELECT COUNT(*) FROM categories) AS c,
                    (SELECT COUNT(*) FROM orders) AS o`
        );
        const row = counts[0] || { p: 0, c: 0, o: 0 };
        if (Number(row.p) > 0 || Number(row.c) > 0 || Number(row.o) > 0) return;

        console.log('database: server is empty — performing one-time initial upload…');
        await forcePushTables(localDb);

        await mysql.mysqlUpsert('settings', { key: 'bootstrap_done', value: '1' }, 'key');
        await sqlite.upsert('settings', { key: 'bootstrap_uploaded', value: '1', updatedAt: new Date().toISOString() }, 'key');
        console.log('database: initial upload complete!');
    } catch (e) {
        console.warn('database: bootstrap upload check failed:', e);
    }
}

// ─── CRUD Operations ────────────────────────────────────────────────────────

export async function upsert(table: string, obj: any, idKey: string = 'id'): Promise<void> {
    // Keep local/offline writes eligible for delta sync. MariaDB replaces this
    // with its own server-clock timestamp when the write reaches the server.
    if (table !== 'settings' && !obj.updatedAt) {
        obj = { ...obj, updatedAt: new Date().toISOString() };
    }
    // Always write to local SQLite (either primary or cache)
    await sqlite.upsert(table, obj, idKey);

    if (table === 'settings' && !isSyncableSetting(obj?.key)) {
        return;
    }

    if (PROMOTION_SYNC_TABLE_SET.has(table)) {
        await hydrateSvelteStores([table]);
        await writeOrQueueImmediately(
            `promotion upsert for ${table}`,
            () => table === 'promo_group_items'
                ? mysql.mysqlSafeOfflineUpsert(table, obj, idKey)
                : mysql.mysqlUpsert(table, obj, idKey),
            () => queueOffline(table, 'upsert', obj, idKey),
        );
        return;
    }

    pushWriteInBackground(
        `upsert for ${table}`,
        () => mysql.mysqlUpsert(table, obj, idKey),
        () => queueOffline(table, 'upsert', obj, idKey),
    );
}

export async function remove(table: string, id: string, idKey: string = 'id'): Promise<void> {
    await sqlite.remove(table, id, idKey);

    if (PROMOTION_SYNC_TABLE_SET.has(table)) {
        await hydrateSvelteStores([table]);
        await writeOrQueueImmediately(
            `promotion remove for ${table}`,
            () => mysql.mysqlRemove(table, id, idKey),
            () => queueOffline(table, 'remove', { id }, idKey),
        );
    } else {
        pushWriteInBackground(
            `remove for ${table}`,
            () => mysql.mysqlRemove(table, id, idKey),
            () => queueOffline(table, 'remove', { id }, idKey),
        );
    }

    // Record a tombstone so other tills delete the same row on their next sync.
    // Only for id-keyed tables (tombstone apply removes by the `id` column).
    if (idKey === 'id' && table !== 'tombstones') {
        await recordTombstone(table, id);
    }
}

async function getLocalProductsForPromotionItems(items: any[]): Promise<any[]> {
    const productIds = Array.from(new Set(items.map(item => item.productId).filter(Boolean)));
    if (productIds.length === 0) return [];
    const d = await sqlite.getDb();
    const products: any[] = [];
    for (const productId of productIds) {
        const rows: any[] = await d.select(`SELECT * FROM products WHERE id = ? LIMIT 1`, [productId]);
        if (rows[0]) products.push(rows[0]);
    }
    return products;
}

async function saveLocalPromotionBundle(group: any, discount: any, items: any[]): Promise<void> {
    const d = await sqlite.getDb();
    await sqlite.upsert('promo_groups', group, 'id');
    await sqlite.upsert('discounts', discount, 'id');

    const itemIds = items.map(item => item.id).filter(Boolean);
    if (itemIds.length > 0) {
        const placeholders = itemIds.map(() => '?').join(', ');
        await d.execute(
            `DELETE FROM promo_group_items WHERE groupId = ? AND id NOT IN (${placeholders})`,
            [group.id, ...itemIds],
        );
    } else {
        await d.execute(`DELETE FROM promo_group_items WHERE groupId = ?`, [group.id]);
    }

    for (const item of items) {
        await sqlite.upsert('promo_group_items', item, 'id');
    }
}

export async function savePromotionBundle(group: any, discount: any, items: any[]): Promise<void> {
    await saveLocalPromotionBundle(group, discount, items);
    await hydrateSvelteStores(PROMOTION_SYNC_TABLES);

    const products = await getLocalProductsForPromotionItems(items);
    const payload = { group, discount, items, products };
    await writeOrQueueImmediately(
        `promotion bundle ${discount?.id || group?.id || ''}`,
        () => mysql.mysqlSavePromotionBundle(group, discount, items, products),
        () => queueOffline('promotion_bundle', 'promotionBundle', payload),
    );
}

async function selectPromotionDeleteTargets(discountId: string, groupId = '') {
    const d = await sqlite.getDb();
    const discountRows: any[] = groupId
        ? await d.select(`SELECT id FROM discounts WHERE id = ? OR groupId = ?`, [discountId, groupId])
        : await d.select(`SELECT id FROM discounts WHERE id = ?`, [discountId]);
    const itemRows: any[] = groupId
        ? await d.select(`SELECT id FROM promo_group_items WHERE groupId = ?`, [groupId])
        : [];
    return {
        discountIds: discountRows.map(row => row.id).filter(Boolean),
        itemIds: itemRows.map(row => row.id).filter(Boolean),
        groupId,
    };
}

async function deleteLocalPromotionBundle(discountIds: string[], groupId = ''): Promise<void> {
    const d = await sqlite.getDb();
    if (groupId) await d.execute(`DELETE FROM promo_group_items WHERE groupId = ?`, [groupId]);
    if (discountIds.length > 0) {
        const placeholders = discountIds.map(() => '?').join(', ');
        await d.execute(`DELETE FROM discounts WHERE id IN (${placeholders})`, discountIds);
    }
    if (groupId) await d.execute(`DELETE FROM discounts WHERE groupId = ?`, [groupId]);
    if (groupId) await d.execute(`DELETE FROM promo_groups WHERE id = ?`, [groupId]);
}

export async function deletePromotionBundle(discountId: string, groupId = ''): Promise<void> {
    const targets = await selectPromotionDeleteTargets(discountId, groupId);
    const discountIds = targets.discountIds.length > 0 ? targets.discountIds : [discountId].filter(Boolean);

    await deleteLocalPromotionBundle(discountIds, groupId);

    for (const itemId of targets.itemIds) await recordTombstone('promo_group_items', itemId);
    for (const id of discountIds) await recordTombstone('discounts', id);
    if (groupId) await recordTombstone('promo_groups', groupId);
    await hydrateSvelteStores(PROMOTION_SYNC_TABLES);

    await writeOrQueueImmediately(
        `promotion delete ${discountId || groupId}`,
        () => mysql.mysqlDeletePromotionBundle(discountIds, groupId),
        () => queueOffline('promotion_delete', 'promotionDelete', { discountIds, groupId }),
    );
}

// ─── Read Operations ────────────────────────────────────────────────────────

export async function searchProduct(query: string): Promise<any | null> {
    // Always search local SQLite for speed (barcode scanning must be instant)
    return sqlite.searchProduct(query);
}

export async function searchProductByScalePlu(scalePlu: string): Promise<any | null> {
    return sqlite.searchProductByScalePlu(scalePlu);
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
    p = await prepareProductGoodsMenuWrite(normalizeProductIdentifiers(p));
    await sqlite.assertProductIdentifiersUnique(p);
    const remote = await tryImmediateProductWrite('product add', () => mysql.mysqlAddProduct(p));
    try {
        await sqlite.addProduct(p);
    } catch (e) {
        if (isProductIdentifierConflict(e)) throw friendlyProductIdentifierError(e);
        throw e;
    }
    if (remote === 'queue') await queueLocalProductSnapshot(p.id, p);
}

export async function updateProduct(p: any): Promise<void> {
    p = await prepareProductGoodsMenuWrite(normalizeProductIdentifiers(p));
    await sqlite.assertProductIdentifiersUnique(p);
    const remote = await tryImmediateProductWrite('product update', () => mysql.mysqlUpdateProduct(p));
    try {
        await sqlite.updateProduct(p);
    } catch (e) {
        if (isProductIdentifierConflict(e)) throw friendlyProductIdentifierError(e);
        throw e;
    }
    if (remote === 'queue') await queueLocalProductSnapshot(p.id, p);
}

export async function updateProductFields(
    patch: Record<string, any>,
    expected?: Record<string, any>,
): Promise<void> {
    const stamped = await prepareProductGoodsMenuWrite(
        normalizeProductIdentifiers({ ...patch, updatedAt: new Date().toISOString() }),
    );
    await sqlite.assertProductIdentifiersUnique(stamped);
    try {
        const remote = await tryImmediateProductWrite(
            'product field update',
            () => mysql.mysqlUpdateProductFields(stamped, expected),
        );
        await sqlite.updateProductFields(stamped);
        if (remote === 'queue') await queueLocalProductSnapshot(stamped.id, stamped);
    } catch (e) {
        if (isProductIdentifierConflict(e)) throw friendlyProductIdentifierError(e);
        throw e;
    }
}

async function prepareProductGoodsMenuWrite(product: any): Promise<any> {
    if (!Object.prototype.hasOwnProperty.call(product, 'showInGoods')) return product;
    if (!product.showInGoods || product.isActive === false || product.isActive === 0
        || product.showInPos === false || product.showInPos === 0) {
        return { ...product, showInGoods: false, goodsSortOrder: 0 };
    }
    const d = await sqlite.getDb();
    const rows: any[] = await d.select(
        `SELECT COUNT(*) AS count, COALESCE(MAX(goodsSortOrder), 0) AS maxOrder
         FROM products WHERE isActive = 1 AND showInGoods = 1 AND id <> ?`,
        [product.id],
    );
    if (Number(rows[0]?.count || 0) >= 10) {
        throw new Error('Goods Menu already contains the maximum 10 items');
    }
    return {
        ...product,
        goodsSortOrder: Number(product.goodsSortOrder || 0) > 0
            ? product.goodsSortOrder
            : Number(rows[0]?.maxOrder || 0) + 1,
    };
}

function normalizeProductIdentifiers(product: any): any {
    return {
        ...product,
        ...(Object.prototype.hasOwnProperty.call(product, 'barcode')
            ? { barcode: String(product.barcode || '').trim() || null }
            : {}),
        ...(Object.prototype.hasOwnProperty.call(product, 'scalePlu')
            ? { scalePlu: String(product.scalePlu || '').trim() || null }
            : {}),
        ...(Object.prototype.hasOwnProperty.call(product, 'sku')
            ? { sku: String(product.sku || '').trim() || null }
            : {}),
    };
}

function isProductIdentifierConflict(error: unknown): boolean {
    const message = String(error).toLowerCase();
    return message.includes('duplicate entry')
        || message.includes('unique constraint failed: products.barcode')
        || message.includes('unique constraint failed: products.scaleplu')
        || message.includes('unique constraint failed: products.sku')
        || message.includes('uq_products_barcode')
        || message.includes('uq_products_scale_plu')
        || message.includes('uq_products_sku');
}

function friendlyProductIdentifierError(error: unknown): Error {
    const message = String(error).toLowerCase();
    return new Error(message.includes('scaleplu') || message.includes('scale_plu')
        ? 'Scale PLU is already assigned to another product'
        : message.includes('sku')
            ? 'SKU is already assigned to another product'
            : 'Barcode is already assigned to another product');
}

/**
 * Atomically change a product's stock by `delta` (negative to decrement).
 * Uses `stockLevel = stockLevel + ?` on BOTH stores so concurrent sales on
 * different tills can't clobber each other (the classic read-10-write-9 bug).
 * When offline the delta is queued and replayed on reconnect — deltas commute,
 * so replay order across tills never matters.
 */
export async function adjustStock(productId: string, delta: number): Promise<void> {
    if (!delta) return;
    await sqlite.adjustStock(productId, delta);
    pushWriteInBackground(
        `stock delta for ${productId}`,
        () => mysql.mysqlAdjustStock(productId, delta),
        () => queueOffline('products', 'adjustStock', { id: productId, delta }),
    );
}

/** Set an item's counted stock without overwriting sales made by another till. */
export async function setStockLevel(
    productId: string,
    stockLevel: number,
    expectedStockLevel: number,
): Promise<void> {
    const stamped = { id: productId, stockLevel, updatedAt: new Date().toISOString() };
    await sqlite.setStockLevel(productId, stockLevel);
    pushWriteInBackground(
        `stock count for ${productId}`,
        () => mysql.mysqlSetStockLevel(productId, stockLevel, expectedStockLevel),
        () => queueLocalProductSnapshot(productId, stamped),
    );
}

export interface SaleBundle {
    order: any;
    lines: any[];
    payment: any;
    stockChanges: {
        productId: string;
        delta: number;
        logId: string;
        employeeId: string;
        notes: string;
        movementType?: string;
    }[];
    loyaltyChanges?: {
        id: string;
        customerId: string;
        orderId: string;
        pointsChange: number;
        reason: string;
        createdAt: string;
    }[];
    audit: any;
    originalOrderToUpdate?: string;
    originalStatusUpdate?: string;
}

interface CommitSaleResult {
    bundle: SaleBundle;
}

/**
 * Commit a completed sale as one local transaction. In multi mode the exact
 * same immutable bundle is committed to MariaDB as one transaction, or queued
 * as one unit if the server is unavailable. This prevents half-written sales.
 */
export async function commitSale(bundle: SaleBundle): Promise<SaleBundle> {
    if (isMultiMode() && bundle.order?.type === 'return') {
        const state = get(connectionState);
        if (state.mysqlOnline) {
            if (!state.mysqlConfig) throw new Error('MariaDB configuration is unavailable');
            try {
                const committed = await invoke<CommitSaleResult>('commit_online_reversal', {
                    mysqlUri: buildMysqlUri(state.mysqlConfig),
                    bundle,
                });
                return committed.bundle;
            } catch (e) {
                connectionState.update(s => ({ ...s, syncError: String(e) }));
                throw e;
            }
        }
    }

    const committed = await invoke<CommitSaleResult>('commit_local_sale', { bundle });
    bundle = committed.bundle;

    if (isMultiMode()) {
        const state = get(connectionState);
        const config = state.mysqlConfig;
        if (!state.mysqlOnline) {
            await queueOffline('sale_bundle', 'saleBundle', bundle);
            return bundle;
        }
        if (!config) {
            await queueOffline('sale_bundle', 'saleBundle', bundle);
            connectionState.update(s => ({ ...s, mysqlOnline: false }));
            return bundle;
        }

        // Keep the cashier flow instant: SQLite already committed the sale,
        // so the MariaDB write can finish in the background or queue itself.
        void invoke('commit_mysql_sale', { mysqlUri: buildMysqlUri(config), bundle })
            .catch(async (e) => {
                console.warn('database: MariaDB sale transaction failed, queuing bundle:', e);
                await queueOffline('sale_bundle', 'saleBundle', bundle);
                connectionState.update(s => ({ ...s, mysqlOnline: false }));
            });
    }
    return bundle;
}

export async function deleteProduct(id: string): Promise<void> {
    await sqlite.deleteProduct(id);
    pushWriteInBackground(
        'product deactivation',
        () => mysql.mysqlDeleteProduct(id),
        () => queueLocalProductSnapshot(id),
    );
    await removeProductTiles(id);
}

export async function removeProductTiles(productId: string): Promise<void> {
    const tileIds = await sqlite.getProductTileIds(productId);
    for (const tileId of tileIds) await deleteTile(tileId);
}

export async function bulkAddProducts(products: any[]): Promise<void> {
    await sqlite.bulkAddProducts(products);
    pushWriteInBackground(
        'bulk product import',
        () => mysql.mysqlBulkAddProducts(products),
        async () => {
            for (const p of products) await queueOffline('products', 'upsert', p);
        },
    );
}

// ─── POS Page / Tile Helpers ────────────────────────────────────────────────

export async function savePosPage(p: any): Promise<void> {
    const stamped = { ...p, updatedAt: new Date().toISOString() };
    await sqlite.savePosPage(stamped);
    pushWriteInBackground(
        'POS page save',
        () => mysql.mysqlSavePosPage(stamped),
        () => queueOffline('pos_pages', 'upsert', stamped),
    );
}

export async function deletePosPage(id: string): Promise<void> {
    await sqlite.deletePosPage(id);
    pushWriteInBackground(
        'POS page delete',
        () => mysql.mysqlDeletePosPage(id),
        () => queueOffline('pos_pages', 'remove', { id }),
    );
    // Propagate the page deletion to other tills. (Child tiles are removed
    // locally on each till via deletePosPage's cascade.)
    await recordTombstone('pos_pages', id);
}

export async function addTile(t: any): Promise<void> {
    const stamped = { ...t, updatedAt: new Date().toISOString() };
    await sqlite.addTile(stamped);
    pushWriteInBackground(
        'POS tile save',
        () => mysql.mysqlAddTile(stamped),
        () => queueOffline('pos_tiles', 'upsert', stamped),
    );
}

export async function deleteTile(id: string): Promise<void> {
    await sqlite.deleteTile(id);
    pushWriteInBackground(
        'POS tile delete',
        () => mysql.mysqlDeleteTile(id),
        () => queueOffline('pos_tiles', 'remove', { id }),
    );
    await recordTombstone('pos_tiles', id);
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
    pushWriteInBackground(
        'goods menu batch update',
        () => mysql.mysqlBatchUpdateGoodsMenu(changes),
        async () => {
            const d = await sqlite.getDb();
            for (const change of changes) {
                const rows: any[] = await d.select('SELECT * FROM products WHERE id = ? LIMIT 1', [change.id]);
                if (rows[0]) await queueOffline('products', 'upsert', rows[0]);
            }
        },
    );
}

// ─── Report Queries ─────────────────────────────────────────────────────────
// Reports read from MySQL when available (most accurate, aggregates all tills),
// falling back to local SQLite.

export interface ReportSnapshot {
    overview: sqlite.SalesOverview;
    breakdown: sqlite.PaymentBreakdown;
    topProducts: sqlite.TopProduct[];
    tillOptions: sqlite.TillReportOption[];
    tillSummaries: sqlite.TillSalesSummary[];
    dailyTrend: sqlite.DailySalesPoint[];
    business: sqlite.BusinessSummary;
    employeeSales: sqlite.EmployeeSalesSummary[];
    source: 'mariadb' | 'sqlite';
    warning?: string;
}

async function getSqliteReportSnapshot(
    startDate: string,
    endDate: string,
    sortBy: 'quantity' | 'revenue',
    limit: number,
    tillNumber?: string
): Promise<ReportSnapshot> {
    const [overview, breakdown, topProducts, tillOptions, tillSummaries, dailyTrend, business, employeeSales] =
        await Promise.all([
            sqlite.getSalesOverview(startDate, endDate, tillNumber),
            sqlite.getPaymentBreakdown(startDate, endDate, tillNumber),
            sqlite.getTopProducts(startDate, endDate, sortBy, limit, tillNumber),
            sqlite.getTillReportOptions(),
            sqlite.getTillSalesSummaries(startDate, endDate),
            sqlite.getDailySalesTrend(startDate, endDate, tillNumber),
            sqlite.getBusinessSummary(startDate, endDate, tillNumber),
            sqlite.getEmployeeSalesSummaries(startDate, endDate, tillNumber),
        ]);
    return {
        overview, breakdown, topProducts, tillOptions, tillSummaries,
        dailyTrend, business, employeeSales, source: 'sqlite',
    };
}

async function getMysqlReportSnapshot(
    startDate: string,
    endDate: string,
    sortBy: 'quantity' | 'revenue',
    limit: number,
    tillNumber?: string
): Promise<ReportSnapshot> {
    // The SQL plugin uses a connection pool and does not expose a transaction
    // handle. Verify the headline totals after loading and retry once if a sale
    // landed mid-read, so the sections do not silently describe different
    // moments.
    for (let attempt = 0; attempt < 2; attempt++) {
        const allTillsOverviewBefore = tillNumber
            ? await mysql.mysqlGetSalesOverview(startDate, endDate)
            : null;
        const overviewBefore = await mysql.mysqlGetSalesOverview(startDate, endDate, tillNumber);
        const breakdownBefore = await mysql.mysqlGetPaymentBreakdown(startDate, endDate, tillNumber);
        const businessBefore = await mysql.mysqlGetBusinessSummary(startDate, endDate, tillNumber);
        const topProducts = await mysql.mysqlGetTopProducts(startDate, endDate, sortBy, limit, tillNumber);
        const tillOptions = await mysql.mysqlGetTillReportOptions();
        const tillSummaries = await mysql.mysqlGetTillSalesSummaries(startDate, endDate);
        const dailyTrend = await mysql.mysqlGetDailySalesTrend(startDate, endDate, tillNumber);
        const employeeSales = await mysql.mysqlGetEmployeeSalesSummaries(startDate, endDate, tillNumber);
        const overviewAfter = await mysql.mysqlGetSalesOverview(startDate, endDate, tillNumber);
        const breakdownAfter = await mysql.mysqlGetPaymentBreakdown(startDate, endDate, tillNumber);
        const businessAfter = await mysql.mysqlGetBusinessSummary(startDate, endDate, tillNumber);
        const allTillsOverviewAfter = tillNumber
            ? await mysql.mysqlGetSalesOverview(startDate, endDate)
            : null;
        if (
            JSON.stringify([allTillsOverviewBefore, overviewBefore, breakdownBefore, businessBefore]) ===
            JSON.stringify([allTillsOverviewAfter, overviewAfter, breakdownAfter, businessAfter])
        ) {
            return {
                overview: overviewAfter, breakdown: breakdownAfter, topProducts, tillOptions, tillSummaries,
                dailyTrend, business: businessAfter, employeeSales, source: 'mariadb',
            };
        }
    }
    throw new Error('MariaDB report changed repeatedly while loading');
}

function reportDateBounds(startDate: string, endDate: string): [string, string] {
    const start = new Date(`${startDate}T00:00:00`);
    const end = new Date(`${endDate}T00:00:00`);
    end.setDate(end.getDate() + 1);
    return [start.toISOString(), end.toISOString()];
}

async function missingRemoteReportOrderCount(startDate: string, endDate: string, tillNumber?: string): Promise<number> {
    const localDb = await sqlite.getDb();
    const remoteDb = await mysql.getDb();
    const tillFilter = tillNumber ? ' AND tillNumber = ?' : '';
    const params: any[] = [...reportDateBounds(startDate, endDate)];
    if (tillNumber) params.push(tillNumber);
    const localRows: any[] = await localDb.select(
        `SELECT id FROM orders
         WHERE status IN ('completed','refunded','partially_refunded','voided')
           AND completedAt >= ? AND completedAt < ?${tillFilter}`,
        params
    );
    let missing = 0;
    for (let i = 0; i < localRows.length; i += 500) {
        const ids = localRows.slice(i, i + 500).map(row => row.id);
        if (ids.length === 0) continue;
        const remoteRows: any[] = await remoteDb.select(
            `SELECT id FROM orders WHERE id IN (${ids.map(() => '?').join(',')})`,
            ids
        );
        missing += ids.length - new Set(remoteRows.map(row => row.id)).size;
    }
    return missing;
}

async function pendingReportWriteCount(): Promise<number> {
    const d = await sqlite.getDb();
    const rows: any[] = await d.select(
        `SELECT COUNT(*) AS count FROM _offline_queue
         WHERE operation = 'saleBundle'
            OR table_name IN ('orders','order_lines','payments')`,
    );
    return Number(rows[0]?.count || 0);
}

/**
 * Load every report section from one source. If MariaDB unexpectedly reports
 * no matching sales while the local cache has them, use the local snapshot
 * instead of silently showing an all-zero report.
 */
export async function getReportSnapshot(
    startDate: string,
    endDate: string,
    sortBy: 'quantity' | 'revenue' = 'quantity',
    limit: number = 10,
    tillNumber?: string
): Promise<ReportSnapshot> {
    if (isMultiMode()) {
        try {
            await flushOfflineQueue();
            const pendingWrites = await pendingReportWriteCount();
            if (pendingWrites > 0) {
                const local = await getSqliteReportSnapshot(startDate, endDate, sortBy, limit, tillNumber);
                return {
                    ...local,
                    warning: `${pendingWrites} local transaction update${pendingWrites === 1 ? ' is' : 's are'} waiting to sync, so this report is showing the local SQLite cache.`,
                };
            }
            const mysqlDb = await getMysqlDb();
            if (mysqlDb) {
                const remote = await getMysqlReportSnapshot(startDate, endDate, sortBy, limit, tillNumber);
                const missingOrders = await missingRemoteReportOrderCount(startDate, endDate, tillNumber);
                if (missingOrders === 0) {
                    return remote;
                }
                const local = await getSqliteReportSnapshot(startDate, endDate, sortBy, limit, tillNumber);
                return {
                    ...local,
                    warning: `MariaDB is missing ${missingOrders} transaction${missingOrders === 1 ? '' : 's'} that exist in the local cache, so this report is showing local SQLite.`,
                };
            }
        } catch (e) {
            console.warn('database: MariaDB report snapshot failed, using local SQLite:', e);
            const local = await getSqliteReportSnapshot(startDate, endDate, sortBy, limit, tillNumber);
            return {
                ...local,
                warning: `MariaDB report loading failed (${String(e)}), so this report is showing the local SQLite cache.`,
            };
        }
    }
    return getSqliteReportSnapshot(startDate, endDate, sortBy, limit, tillNumber);
}

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
    const name = await sqlite.getTillName();
    const id = await sqlite.getOrCreateTillId();
    const d = await sqlite.getDb();
    const existing: any[] = await d.select(`SELECT * FROM registers WHERE id = ? LIMIT 1`, [id]);
    if (!existing[0] || existing[0].name !== name) {
        const stamp = new Date().toISOString();
        await upsert('registers', {
            id,
            storeId: existing[0]?.storeId || 'store-main',
            name,
            isActive: true,
            createdAt: existing[0]?.createdAt || stamp,
            updatedAt: stamp,
        });
    }
    return name;
}

export async function setTillName(name: string): Promise<void> {
    await sqlite.setTillName(name);
    const id = await sqlite.getOrCreateTillId();
    const d = await sqlite.getDb();
    const existing: any[] = await d.select(`SELECT * FROM registers WHERE id = ? LIMIT 1`, [id]);
    const stamp = new Date().toISOString();
    await upsert('registers', {
        id,
        storeId: existing[0]?.storeId || 'store-main',
        name: name.trim() || 'Till',
        isActive: true,
        createdAt: existing[0]?.createdAt || stamp,
        updatedAt: stamp,
    });
}

export async function findOpenShiftId(employeeId: string, registerId: string): Promise<string | null> {
    const d = await sqlite.getDb();
    const existing: any[] = await d.select(
        `SELECT id FROM shifts WHERE employeeId = ? AND registerId = ? AND status = 'open' ORDER BY openedAt DESC LIMIT 1`,
        [employeeId, registerId]
    );
    return existing.length > 0 ? existing[0].id : null;
}

export async function findOpenShiftForRegister(registerId: string): Promise<any | null> {
    const d = await sqlite.getDb();
    const rows: any[] = await d.select(
        `SELECT * FROM shifts WHERE registerId = ? AND status = 'open' ORDER BY openedAt DESC LIMIT 1`,
        [registerId]
    );
    return rows[0] || null;
}

export async function retireOpenShiftsBefore(employeeId: string, registerId: string, before: string): Promise<void> {
    if (!before) return;
    const d = await sqlite.getDb();
    const legacyShifts: any[] = await d.select(
        `SELECT * FROM shifts WHERE employeeId = ? AND registerId = ? AND status = 'open' AND openedAt < ?`,
        [employeeId, registerId, before]
    );
    for (const shift of legacyShifts) {
        await upsert('shifts', {
            ...shift,
            closedByEmployeeId: employeeId,
            closedAt: before,
            expectedCash: shift.expectedCash || 0,
            actualCash: shift.actualCash || 0,
            cashDifference: shift.cashDifference || 0,
            expectedCard: shift.expectedCard || 0,
            actualCard: shift.actualCard || 0,
            cardDifference: shift.cardDifference || 0,
            status: 'closed',
            notes: shift.notes || 'Closed automatically when Till Cash-Up was enabled',
            updatedAt: new Date().toISOString(),
        });
    }
}

export async function ensureOpenShift(employeeId: string, registerId: string, openingFloat = 0): Promise<string> {
    const existingShift = await findOpenShiftForRegister(registerId);
    const existingId = existingShift?.id || null;
    if (existingId) {
        if (!get(shiftsDB).some(shift => shift.id === existingId)) {
            shiftsDB.update(list => [...list, existingShift]);
        }
        return existingId;
    }

    const stamp = new Date().toISOString();
    const shift = {
        id: crypto.randomUUID(),
        registerId,
        employeeId,
        closedByEmployeeId: '',
        openedAt: stamp,
        closedAt: '',
        openingFloat,
        expectedCash: 0,
        actualCash: 0,
        cashDifference: 0,
        expectedCard: 0,
        actualCard: 0,
        cardDifference: 0,
        status: 'open',
        notes: '',
        updatedAt: stamp,
    };
    await upsert('shifts', shift);
    shiftsDB.update(list => [...list.filter(existing => existing.id !== shift.id), shift as any]);
    return shift.id;
}

/**
 * Close a till shift immediately in the local cache, then synchronize it in
 * the background. Cashiers must not be held on the closing screen by a slow or
 * temporarily unavailable MariaDB server.
 */
export async function closeShiftLocalFirst(shift: any): Promise<void> {
    const stamped = { ...shift, updatedAt: shift.updatedAt || new Date().toISOString() };
    await sqlite.upsert('shifts', stamped);
    shiftsDB.update(list => list.map(existing => existing.id === stamped.id ? stamped : existing));

    if (!isMultiMode()) return;
    void mysql.mysqlUpsert('shifts', stamped).catch(async (error) => {
        console.warn('database: MariaDB shift close failed, queuing offline:', error);
        await queueOffline('shifts', 'upsert', stamped);
        connectionState.update(state => ({ ...state, mysqlOnline: false }));
    });
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

export async function getTillReportOptions(): Promise<sqlite.TillReportOption[]> {
    if (isMultiMode()) {
        try {
            const mysqlDb = await getMysqlDb();
            if (mysqlDb) return mysql.mysqlGetTillReportOptions();
        } catch (e) { console.warn('database: MySQL getTillReportOptions failed:', e); }
    }
    return sqlite.getTillReportOptions();
}

export async function getTillSalesSummaries(startDate: string, endDate: string): Promise<sqlite.TillSalesSummary[]> {
    if (isMultiMode()) {
        try {
            const mysqlDb = await getMysqlDb();
            if (mysqlDb) return mysql.mysqlGetTillSalesSummaries(startDate, endDate);
        } catch (e) { console.warn('database: MySQL getTillSalesSummaries failed:', e); }
    }
    return sqlite.getTillSalesSummaries(startDate, endDate);
}

export async function getDailySalesTrend(
    startDate: string, endDate: string, tillNumber?: string
): Promise<sqlite.DailySalesPoint[]> {
    if (isMultiMode()) {
        try {
            const mysqlDb = await getMysqlDb();
            if (mysqlDb) return mysql.mysqlGetDailySalesTrend(startDate, endDate, tillNumber);
        } catch (e) { console.warn('database: MySQL getDailySalesTrend failed:', e); }
    }
    return sqlite.getDailySalesTrend(startDate, endDate, tillNumber);
}

export async function getBusinessSummary(
    startDate: string, endDate: string, tillNumber?: string
): Promise<sqlite.BusinessSummary> {
    if (isMultiMode()) {
        try {
            const mysqlDb = await getMysqlDb();
            if (mysqlDb) return mysql.mysqlGetBusinessSummary(startDate, endDate, tillNumber);
        } catch (e) { console.warn('database: MySQL getBusinessSummary failed:', e); }
    }
    return sqlite.getBusinessSummary(startDate, endDate, tillNumber);
}

export async function getEmployeeSalesSummaries(
    startDate: string, endDate: string, tillNumber?: string
): Promise<sqlite.EmployeeSalesSummary[]> {
    if (isMultiMode()) {
        try {
            const mysqlDb = await getMysqlDb();
            if (mysqlDb) return mysql.mysqlGetEmployeeSalesSummaries(startDate, endDate, tillNumber);
        } catch (e) { console.warn('database: MySQL getEmployeeSalesSummaries failed:', e); }
    }
    return sqlite.getEmployeeSalesSummaries(startDate, endDate, tillNumber);
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

// ─── Offline-safe receipt numbering ─────────────────────────────────────────
// Each till draws receipt numbers from its OWN block (tillSeq * RECEIPT_BLOCK
// + local sequence). Because a till only ever issues numbers inside its block
// and computes the next one from its own local orders, receipt numbers can
// never collide across tills — even when several tills are offline at once.
const RECEIPT_BLOCK = 1_000_000;

/** Read a single settings value from local SQLite (null if absent). */
async function getSettingValue(key: string): Promise<string | null> {
    const d = await sqlite.getDb();
    const rows: any[] = await d.select(`SELECT value FROM settings WHERE key = ?`, [key]);
    return rows.length > 0 ? rows[0].value : null;
}

/**
 * This till's numeric sequence index (>= 1), used as its receipt-block prefix.
 * Claimed once from the server via an atomic counter and cached locally so it
 * survives offline. Returns 0 when not in multi mode, or when a brand-new till
 * sells before it has ever reached the server (caller then uses legacy numbering).
 */
export async function getTillSequence(): Promise<number> {
    const cached = await getSettingValue('till_seq');
    if (cached) {
        const n = parseInt(cached, 10);
        if (n > 0) return n;
    }
    if (!isMultiMode()) return 0;
    try {
        const config = get(connectionState).mysqlConfig;
        if (!config) return 0;
        const seq = await invoke<number>('allocate_mysql_till_sequence', {
            mysqlUri: buildMysqlUri(config),
        });
        if (seq > 0) {
            await sqlite.upsert('settings',
                { key: 'till_seq', value: String(seq), updatedAt: new Date().toISOString() }, 'key');
            console.log(`database: claimed till sequence #${seq} for receipt numbering`);
            return seq;
        }
    } catch (e) {
        console.warn('database: could not claim till sequence:', e);
    }
    return 0;
}

function sequenceFromTillName(name: string | null): number | null {
    const match = (name || '').trim().match(/^till\s*(\d+)$/i);
    if (!match) return null;
    const parsed = parseInt(match[1], 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Repair cloned/copy-pasted till databases where the human till name says
 * "Till 1" but the cached receipt block is still "2" from another machine.
 * This is local-only and affects future receipts, never historical receipts.
 */
export async function ensureTillReceiptSequence(): Promise<number> {
    const tillName = await getSettingValue('till_name');
    const sequenceFromName = sequenceFromTillName(tillName);
    const cached = await getSettingValue('till_seq');
    const cachedSeq = cached ? parseInt(cached, 10) : 0;

    if (sequenceFromName && sequenceFromName !== cachedSeq) {
        const tillId = await getSettingValue('till_id');
        let remoteConflict = false;
        if (isMultiMode() && tillId) {
            try {
                const remote = await getMysqlDb();
                if (remote) {
                    const blockStart = sequenceFromName * RECEIPT_BLOCK;
                    const rows: any[] = await remote.select(
                        `SELECT COUNT(*) AS count
                         FROM orders
                         WHERE orderNumber >= ? AND orderNumber < ?
                           AND tillNumber <> ?`,
                        [blockStart, blockStart + RECEIPT_BLOCK, tillId],
                    );
                    remoteConflict = Number(rows[0]?.count || 0) > 0;
                }
            } catch (e) {
                console.warn('database: could not check till sequence conflicts:', e);
            }
        }

        if (!remoteConflict) {
            await sqlite.upsert('settings', {
                key: 'till_seq',
                value: String(sequenceFromName),
                updatedAt: new Date().toISOString(),
            }, 'key');
            console.log(`database: repaired local till receipt sequence to #${sequenceFromName}`);
            return sequenceFromName;
        }

        console.warn(`database: did not switch to receipt sequence #${sequenceFromName}; that block is already used by another till`);
    }

    return getTillSequence();
}

export async function createLocalBackup(): Promise<string> {
    return invoke<string>('create_local_backup');
}

export async function getLatestLocalBackup(): Promise<string | null> {
    return invoke<string | null>('latest_local_backup');
}

export async function restoreLatestLocalBackup(): Promise<string> {
    stopBackgroundSync();
    const d = await sqlite.getDb();
    await d.close();
    return invoke<string>('restore_latest_local_backup');
}

export interface SchemaValidationResult {
    ok: boolean;
    issues: string[];
}

const CRITICAL_SCHEMA: Record<string, string[]> = {
    products: ['id', 'price', 'costPrice', 'stockLevel', 'trackStock', 'allowPriceOverride', 'updatedAt'],
    discounts: ['id', 'kind', 'groupId', 'bundleQuantity', 'bundlePrice', 'updatedAt'],
    promo_groups: ['id', 'name', 'isActive', 'updatedAt'],
    promo_group_items: ['id', 'groupId', 'productId', 'updatedAt'],
    orders: ['id', 'orderNumber', 'receiptKey', 'shiftId', 'employeeId', 'taxTotal', 'total', 'tillNumber', 'updatedAt'],
    order_lines: ['id', 'orderId', 'productId', 'costPrice', 'taxRate', 'taxAmount', 'lineTotal', 'updatedAt'],
    payments: ['id', 'orderId', 'amount', 'cashAmount', 'cardAmount', 'updatedAt'],
    customers: ['id', 'name', 'postcode', 'loyaltyCode', 'loyaltyPoints', 'updatedAt'],
    loyalty_logs: ['id', 'customerId', 'orderId', 'pointsChange', 'reason', 'updatedAt'],
    employees: ['id', 'pinHash', 'role', 'isActive', 'updatedAt'],
    inventory_logs: ['id', 'productId', 'quantityChange', 'referenceId', 'updatedAt'],
    audit_logs: ['id', 'employeeId', 'action', 'entityId', 'updatedAt'],
    shifts: ['id', 'registerId', 'employeeId', 'status', 'updatedAt'],
    tombstones: ['id', 'table_name', 'row_id', 'updatedAt'],
    app_identity: ['id', 'shopId', 'shopName', 'licenseId', 'updatedAt'],
};

export async function validateDatabaseSchemas(): Promise<SchemaValidationResult> {
    const issues: string[] = [];
    const local = await sqlite.getDb();
    for (const [table, expected] of Object.entries(CRITICAL_SCHEMA)) {
        const rows: any[] = await local.select(`PRAGMA table_info(${table})`);
        const columns = new Set(rows.map((r) => r.name));
        for (const column of expected) {
            if (!columns.has(column)) issues.push(`SQLite: ${table}.${column} is missing`);
        }
    }

    if (isMultiMode()) {
        const remote = await getMysqlDb();
        if (!remote) {
            issues.push('MariaDB: server is unavailable');
        } else {
            for (const [table, expected] of Object.entries(CRITICAL_SCHEMA)) {
                const rows: any[] = await remote.select(
                    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
                     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
                    [table]
                );
                const columns = new Set(rows.map((r) => r.COLUMN_NAME));
                for (const column of expected) {
                    if (!columns.has(column)) issues.push(`MariaDB: ${table}.${column} is missing`);
                }
            }
        }
    }
    return { ok: issues.length === 0, issues };
}

/** Explicit, guarded local-to-multi migration. Refuses to merge into a populated server. */
export async function migrateLocalDataToServer(): Promise<void> {
    if (!isMultiMode()) throw new Error('Connect to MariaDB multi-till mode first');
    const remote = await getMysqlDb();
    if (!remote) throw new Error('MariaDB is unavailable');
    await ensureDatabaseIdentityForSync();
    const counts: any[] = await remote.select(
        `SELECT (SELECT COUNT(*) FROM products) AS products,
                (SELECT COUNT(*) FROM orders) AS orders,
                (SELECT COUNT(*) FROM customers) AS customers`
    );
    const c = counts[0] || {};
    if (Number(c.products) > 0 || Number(c.orders) > 0 || Number(c.customers) > 0) {
        throw new Error('Migration stopped: MariaDB already contains shop data');
    }
    const validation = await validateDatabaseSchemas();
    if (!validation.ok) throw new Error(validation.issues.join('; '));
    await forcePushTables(await sqlite.getDb());
    await mysql.mysqlUpsert('settings', { key: 'bootstrap_done', value: '1' }, 'key');
    await sqlite.upsert('settings', {
        key: 'bootstrap_uploaded',
        value: '1',
        updatedAt: new Date().toISOString(),
    }, 'key');
    await forceFullSync();
}

/**
 * Compute the next receipt/order number. Offline-safe and collision-proof in
 * multi-till mode; falls back to the legacy global sequence in single mode (or
 * before this till has claimed its sequence).
 */
export async function getNextOrderNumber(): Promise<number> {
    const startStr = await getSettingValue('starting_receipt_number');
    const startNum = startStr ? (parseInt(startStr, 10) || 1) : 1;

    const tillSeq = await getTillSequence();

    // Single mode (or sequence not yet claimed) → legacy global sequence.
    if (!isMultiMode() || tillSeq <= 0) {
        const globalMax = await getGlobalMaxOrderNumber();
        return Math.max(globalMax + 1, startNum);
    }

    // Multi mode → next number inside THIS till's block, from local orders only.
    const blockStart = tillSeq * RECEIPT_BLOCK;
    const d = await sqlite.getDb();
    const rows: any[] = await d.select(
        `SELECT MAX(orderNumber) as maxNum FROM orders WHERE orderNumber >= ? AND orderNumber < ?`,
        [blockStart, blockStart + RECEIPT_BLOCK]
    );
    const localMax = rows[0]?.maxNum || 0;
    if (localMax >= blockStart) return localMax + 1;
    // First receipt in this block — honour the configured starting number as an offset.
    return blockStart + Math.max(startNum, 1);
}

export async function getTillPeriodReport(
    tillNumber: string, startTime: string, endTime: string
) {
    if (isMultiMode()) {
        try {
            await flushOfflineQueue();
            if (await pendingReportWriteCount() === 0) {
                const mysqlDb = await getMysqlDb();
                if (mysqlDb) return mysql.mysqlGetTillPeriodReport(tillNumber, startTime, endTime);
            }
        } catch (e) {
            console.warn('database: live till report failed, using local SQLite:', e);
        }
    }
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
export async function hydrateSvelteStores(tables?: Iterable<string>): Promise<void> {
    const requested = tables ? new Set(tables) : null;
    if (requested && PROMOTION_SYNC_TABLES.some(table => requested.has(table))) {
        for (const table of PROMOTION_SYNC_TABLES) requested.add(table);
    }
    if (requested && requested.size === 0) return;
    console.log(requested
        ? `database: hydrating Svelte stores for ${Array.from(requested).join(', ')}…`
        : 'database: hydrating Svelte stores…');

    const shouldHydrate = (table: string) => !requested || requested.has(table);

    // Repair tiles left behind by older builds when their product became unavailable.
    // This is only relevant when products or tile assignments have changed.
    if (!requested || requested.has('products') || requested.has('pos_tiles')) {
        const unavailableTileIds = await sqlite.getUnavailableProductTileIds();
        for (const tileId of unavailableTileIds) await deleteTile(tileId);
    }

    if (!requested) {
        const [
            cats, pages, tiles, prods, taxRates, emps, settings, customers,
            registers, discounts, promoGroups, promoGroupItems,
            orders, orderLines, payments, suppliers, productSuppliers,
            inventoryLog, loyaltyLog, auditLog, shifts, cashMovements
        ] = await Promise.all([
            sqlite.getAll('categories'),
            sqlite.getAll('pos_pages'),
            sqlite.getAll('pos_tiles'),
            sqlite.getAll('products'),
            sqlite.getAll('tax_rates'),
            sqlite.getAll('employees'),
            sqlite.getAll('settings'),
            sqlite.getAll('customers'),
            sqlite.getAll('registers'),
            sqlite.getAll('discounts'),
            sqlite.getAll('promo_groups'),
            sqlite.getAll('promo_group_items'),
            sqlite.getAll('orders'),
            sqlite.getAll('order_lines'),
            sqlite.getAll('payments'),
            sqlite.getAll('suppliers'),
            sqlite.getAll('product_suppliers'),
            sqlite.getAll('inventory_logs'),
            sqlite.getAll('loyalty_logs'),
            sqlite.getAll('audit_logs'),
            sqlite.getAll('shifts'),
            sqlite.getAll('cash_movements'),
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
        orderLinesDB.set(orderLines.map(line => sqlite.rehydrateBooleans(line, ['isPriceOverride'])));
        paymentsDB.set(payments);
        suppliersDB.set(suppliers);
        productSuppliersDB.set(productSuppliers);
        inventoryLogDB.set(inventoryLog);
        loyaltyLogDB.set(loyaltyLog);
        auditLogDB.set(auditLog);
        shiftsDB.set(shifts);
        cashMovementsDB.set(cashMovements);

        const storeInfo = settings.find((s: any) => s.key === 'store_info');
        if (storeInfo) {
            try { storeDB.set(JSON.parse(storeInfo.value)); } catch (e) { /* ignore */ }
        }

        console.log('database: Svelte stores hydrated ✅');
        return;
    }

    if (shouldHydrate('categories')) {
        const rows = await sqlite.getAll('categories');
        categoriesDB.set(rows.map(c => sqlite.rehydrateBooleans(c, ['isActive', 'showOnPos'])));
    }
    if (shouldHydrate('pos_pages')) posPagesDB.set(await sqlite.getAll('pos_pages'));
    if (shouldHydrate('pos_tiles')) tilesDB.set(await sqlite.getAll('pos_tiles'));
    if (shouldHydrate('products')) {
        const rows = await sqlite.getAll('products');
        productsDB.set(rows.map(p => sqlite.rehydrateBooleans(p, [
            'isActive', 'isWeighable', 'showInGoods', 'showInPos', 'trackStock'
        ])));
    }
    if (shouldHydrate('tax_rates')) {
        const rows = await sqlite.getAll('tax_rates');
        taxRatesDB.set(rows.map(t => sqlite.rehydrateBooleans(t, ['isDefault'])));
    }
    if (shouldHydrate('employees')) {
        const rows = await sqlite.getAll('employees');
        employeesDB.set(rows.map(e => sqlite.rehydrateBooleans(e, ['isActive'])));
    }
    if (shouldHydrate('settings')) {
        const rows = await sqlite.getAll('settings');
        settingsDB.set(rows);
        hydrateTheme(rows);
        const storeInfo = rows.find((s: any) => s.key === 'store_info');
        if (storeInfo) {
            try { storeDB.set(JSON.parse(storeInfo.value)); } catch (e) { /* ignore */ }
        }
    }
    if (shouldHydrate('customers')) customersDB.set(await sqlite.getAll('customers'));
    if (shouldHydrate('registers')) {
        const rows = await sqlite.getAll('registers');
        registersDB.set(rows.map(r => sqlite.rehydrateBooleans(r, ['isActive'])));
    }
    if (shouldHydrate('discounts')) {
        const rows = await sqlite.getAll('discounts');
        discountsDB.set(rows.map(d => sqlite.rehydrateBooleans(d, ['isActive', 'autoApply'])));
    }
    if (shouldHydrate('promo_groups')) {
        const rows = await sqlite.getAll('promo_groups');
        promoGroupsDB.set(rows.map(g => sqlite.rehydrateBooleans(g, ['isActive'])));
    }
    if (shouldHydrate('promo_group_items')) promoGroupItemsDB.set(await sqlite.getAll('promo_group_items'));
    if (shouldHydrate('orders')) ordersDB.set(await sqlite.getAll('orders'));
    if (shouldHydrate('order_lines')) {
        const rows = await sqlite.getAll('order_lines');
        orderLinesDB.set(rows.map(line => sqlite.rehydrateBooleans(line, ['isPriceOverride'])));
    }
    if (shouldHydrate('payments')) paymentsDB.set(await sqlite.getAll('payments'));
    if (shouldHydrate('suppliers')) suppliersDB.set(await sqlite.getAll('suppliers'));
    if (shouldHydrate('product_suppliers')) productSuppliersDB.set(await sqlite.getAll('product_suppliers'));
    if (shouldHydrate('inventory_logs')) inventoryLogDB.set(await sqlite.getAll('inventory_logs'));
    if (shouldHydrate('loyalty_logs')) loyaltyLogDB.set(await sqlite.getAll('loyalty_logs'));
    if (shouldHydrate('audit_logs')) auditLogDB.set(await sqlite.getAll('audit_logs'));
    if (shouldHydrate('shifts')) shiftsDB.set(await sqlite.getAll('shifts'));
    if (shouldHydrate('cash_movements')) cashMovementsDB.set(await sqlite.getAll('cash_movements'));

    console.log('database: partial Svelte store hydration complete ✅');
}

// ─── Background Sync (Multi Mode) ──────────────────────────────────────────

let syncInterval: any = null;
let fastSyncInterval: any = null;
let heartbeatInterval: any = null;

let isSyncRunning = false;
let isFastSyncRunning = false;

/**
 * Heartbeat: actively ping MariaDB to keep the online/offline indicator
 * accurate and to recover a dead connection. pingMysql() drops the cached
 * connection on failure so the next call reconnects (server restart, Wi-Fi
 * blip, IP change). When the link transitions back to online, replay the
 * offline queue and pull a fresh full sync so the till catches up.
 */
async function runHeartbeat(): Promise<void> {
    if (!isMultiMode()) return;
    const wasOnline = get(connectionState).mysqlOnline;
    const online = await pingMysql();
    if (online && !wasOnline) {
        console.log('database: connection restored — flushing offline queue and resyncing…');
        try { await flushOfflineQueue(); } catch (e) { console.warn('database: flush on reconnect failed:', e); }
        runSyncCycle().catch(console.error);
    }
}

/** Tables that should appear on other tills quickly (every 5s). */
const FAST_SYNC_TABLES = [
    'orders', 'order_lines', 'payments', 'inventory_logs', 'shifts', 'cash_movements',
    'products', 'pos_pages', 'pos_tiles', 'customers', 'loyalty_logs',
    'discounts', 'promo_groups', 'promo_group_items'
];
const TRANSACTION_SYNC_TABLES = new Set([
    'orders', 'order_lines', 'payments', 'inventory_logs',
    'loyalty_logs', 'audit_logs', 'shifts', 'cash_movements',
]);
const LOCAL_UPSERT_COMPARE_TABLES = new Set([
    ...TRANSACTION_SYNC_TABLES,
    ...PROMOTION_SYNC_TABLES,
]);
const TRANSACTION_SYNC_OVERLAP_MS = 2 * 60 * 60 * 1000;

/** All tables — synced every 10s so product and pricing changes appear quickly. */
const ALL_SYNC_TABLES = [
    'products', 'categories', 'pos_pages', 'pos_tiles',
    'tax_rates', 'discounts', 'promo_groups', 'promo_group_items',
    'employees', 'settings', 'customers', 'registers',
    'suppliers', 'product_suppliers', 'inventory_logs',
    'orders', 'order_lines', 'payments',
    'loyalty_logs', 'audit_logs', 'shifts', 'cash_movements'
];

function overlapWatermark(table: string, since: string | null): string | null {
    if (!since || !TRANSACTION_SYNC_TABLES.has(table)) return since;
    const time = new Date(since).getTime();
    if (!Number.isFinite(time)) return since;
    return new Date(Math.max(0, time - TRANSACTION_SYNC_OVERLAP_MS)).toISOString();
}

async function filterRowsNeedingLocalUpsert(table: string, rows: any[], idKey = 'id'): Promise<any[]> {
    if (rows.length === 0) return rows;
    if (!LOCAL_UPSERT_COMPARE_TABLES.has(table)) return rows;
    const d = await sqlite.getDb();
    const changed: any[] = [];
    for (const row of rows) {
        const rowId = row?.[idKey];
        if (!rowId) {
            changed.push(row);
            continue;
        }
        const localRows: any[] = await d.select(
            `SELECT updatedAt FROM ${table} WHERE ${idKey} = ? LIMIT 1`,
            [rowId],
        );
        if (localRows.length === 0 || String(localRows[0]?.updatedAt || '') !== String(row.updatedAt || '')) {
            changed.push(row);
        }
    }
    return changed;
}

async function filterPendingLocalDeletes(table: string, rows: any[], idKey = 'id'): Promise<any[]> {
    if (rows.length === 0 || idKey !== 'id') return rows;
    const d = await sqlite.getDb();
    const tombstones: any[] = await d.select(
        `SELECT row_id FROM tombstones WHERE table_name = ?`,
        [table],
    );
    if (tombstones.length === 0) return rows;
    const deletedIds = new Set(tombstones.map(row => String(row.row_id)));
    return rows.filter(row => !deletedIds.has(String(row?.[idKey])));
}

/**
 * Run a fast sync cycle that only pulls transaction-related tables
 * (orders, order_lines, payments, shifts, cash_movements) and rehydrates
 * the Svelte stores. This runs every 5 seconds for near-real-time updates.
 */
export async function runFastSyncCycle(): Promise<void> {
    if (!isMultiMode() || isFastSyncRunning || isSyncRunning) return;
    isFastSyncRunning = true;
    try {
        const wasOnline = get(connectionState).mysqlOnline;
        const mysqlDb = await getMysqlDb();
        if (!mysqlDb) return;
        await ensureDatabaseIdentityForSync();

        const pendingBeforeFlush = await pendingOfflineQueueCount();
        const flushed = pendingBeforeFlush > 0 ? await flushOfflineQueue() : 0;
        const shouldCatchUpEverything = !wasOnline || flushed > 0;
        const tablesToPull = shouldCatchUpEverything ? ALL_SYNC_TABLES : FAST_SYNC_TABLES;

        // Server clock is the authority for delta sync; read it once per cycle.
        const newSyncTime = await mysql.mysqlGetServerTime();

        let totalChanges = 0;
        const changedTables = new Set<string>();

        for (const table of tablesToPull) {
            // Per-table watermark: only advances when THIS table's pull succeeds,
            // so a transient error on one table never permanently skips its rows.
            const since = overlapWatermark(table, await getTableWatermark(table));
            try {
                let pulledRows: any[] = since && !PROMOTION_SYNC_TABLE_SET.has(table)
                    ? await mysql.mysqlGetUpdatedSince(table, since)
                    : await mysql.mysqlGetAll(table);
                if (table === 'settings') pulledRows = pulledRows.filter((r: any) => isSyncableSetting(r.key));
                const idKey = table === 'settings' ? 'key' : 'id';
                const visibleRows = await filterPendingLocalDeletes(table, pulledRows, idKey);
                const rows = await filterRowsNeedingLocalUpsert(table, visibleRows, idKey);

                if (rows.length > 0) {
                    await sqlite.bulkUpsert(table, rows, idKey);
                    totalChanges += rows.length;
                    changedTables.add(table);
                }
                await setTableWatermark(table, newSyncTime);
            } catch (e) {
                // Leave this table's watermark untouched so we retry its rows next cycle.
                console.warn(`database: fast sync failed for ${table}:`, e);
            }
        }

        const removed = await applyTombstones(newSyncTime);

        // Only rehydrate stores if there were actual changes (avoids unnecessary re-renders)
        if (totalChanges > 0 || removed > 0) {
            console.log(`database: fast sync found ${totalChanges} changes, rehydrating…`);
            await hydrateSvelteStores(removed > 0 ? undefined : changedTables);
        }

        connectionState.update(s => ({ ...s, mysqlOnline: true, syncError: null }));
    } catch (e: any) {
        console.warn('database: fast sync failed:', e);
        connectionState.update(s => ({ ...s, mysqlOnline: false, syncError: e.toString() }));
    } finally {
        isFastSyncRunning = false;
    }
}

/**
 * Run one full sync cycle: flush offline queue → pull MySQL → update
 * local SQLite cache → rehydrate Svelte stores.
 */
export async function runSyncCycle(): Promise<void> {
    if (!isMultiMode() || isSyncRunning || isFastSyncRunning) return;
    isSyncRunning = true;
    try {
        const mysqlDb = await getMysqlDb();
        if (!mysqlDb) return;
        await ensureDatabaseIdentityForSync();

        // Flush any queued offline operations first (replays writes made while offline).
        await flushOfflineQueue();

        // Server clock is the authority for delta sync; read it once per cycle.
        const newSyncTime = await mysql.mysqlGetServerTime();

        let totalChanges = 0;
        const changedTables = new Set<string>();
        for (const table of ALL_SYNC_TABLES) {
            // Per-table watermark: only advances when THIS table's pull succeeds.
            const since = overlapWatermark(table, await getTableWatermark(table));
            try {
                let pulledRows: any[] = since && !PROMOTION_SYNC_TABLE_SET.has(table)
                    ? await mysql.mysqlGetUpdatedSince(table, since)
                    : await mysql.mysqlGetAll(table);

                // Never let server settings overwrite device-local config (till_id, creds…).
                if (table === 'settings') pulledRows = pulledRows.filter((r: any) => isSyncableSetting(r.key));
                const idKey = table === 'settings' ? 'key' : 'id';
                const visibleRows = await filterPendingLocalDeletes(table, pulledRows, idKey);
                const rows = await filterRowsNeedingLocalUpsert(table, visibleRows, idKey);

                if (rows.length > 0) {
                    await sqlite.bulkUpsert(table, rows, idKey);
                    totalChanges += rows.length;
                    changedTables.add(table);
                    console.log(`database: synced ${rows.length} rows to local cache for ${table}`);
                }
                await setTableWatermark(table, newSyncTime);
            } catch (e) {
                // Leave this table's watermark untouched so we retry its rows next cycle.
                console.warn(`database: sync failed for ${table}:`, e);
            }
        }

        const transactionPurged = await applyTransactionPurgeMarker();

        // Apply deletions from other tills AFTER upserts so a delete can't be
        // resurrected by a stale insert in the same cycle.
        const removed = await applyTombstones(newSyncTime);
        if (removed > 0) console.log(`database: applied ${removed} tombstone deletions`);

        // Rehydrate Svelte stores so the UI reflects latest data
        if (totalChanges > 0 || removed > 0 || transactionPurged) {
            await hydrateSvelteStores((removed > 0 || transactionPurged) ? undefined : changedTables);
        }

        connectionState.update(s => ({ ...s, mysqlOnline: true, syncError: null }));
        console.log('database: full sync complete ✅');
        if (transactionPurged && typeof window !== 'undefined') {
            window.location.reload();
        }
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
 *  - Full sync (all tables) every 10 seconds
 */
export async function startBackgroundSync(intervalMs: number = 5000): Promise<void> {
    if (syncInterval) clearInterval(syncInterval);
    if (fastSyncInterval) clearInterval(fastSyncInterval);
    if (heartbeatInterval) clearInterval(heartbeatInterval);

    // Run an immediate full sync in the background so the UI is not blocked
    runSyncCycle().catch(console.error);
    runHeartbeat().catch(console.error);

    // Fast sync: pull transaction-related tables every 5 seconds
    fastSyncInterval = setInterval(() => runFastSyncCycle(), intervalMs);

    // Full sync: pull ALL tables every 10 seconds (products, categories, settings, etc.)
    syncInterval = setInterval(() => runSyncCycle(), 10000);

    // Heartbeat: keep online/offline state accurate and auto-recover the link.
    heartbeatInterval = setInterval(() => runHeartbeat(), 10000);
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
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
}

/**
 * Permanently remove transaction history while preserving shop configuration,
 * products, stock levels, customers, loyalty balances, employees, and tills.
 * In multi-till mode a synchronized marker makes every till clear its cache.
 */
export async function purgeAllTransactions(): Promise<void> {
    stopBackgroundSync();
    while (isSyncRunning || isFastSyncRunning) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    try {
        let marker = new Date().toISOString();
        if (isMultiMode()) {
            const server = await getMysqlDb();
            if (!server) throw new Error('MariaDB must be online before deleting shop-wide transactions.');
            marker = await mysql.mysqlGetServerTime();

            await server.execute(`DELETE FROM inventory_logs WHERE referenceId IN (SELECT id FROM orders)`);
            await server.execute(`DELETE FROM audit_logs WHERE entityId IN (SELECT id FROM orders) OR entityType = 'order' OR action IN ('sale_completed','refund_completed')`);
            await server.execute(`DELETE FROM payments`);
            await server.execute(`DELETE FROM order_lines`);
            await server.execute(`DELETE FROM cash_movements`);
            await server.execute(`DELETE FROM orders`);
            await server.execute(`DELETE FROM shifts`);
            await server.execute(`DELETE FROM daily_sales_summary`);
            await server.execute(`DELETE FROM till_report_markers`);
            await server.execute(`DELETE FROM tombstones WHERE table_name IN ('orders','order_lines','payments','shifts','cash_movements','inventory_logs','audit_logs')`);
            await mysql.mysqlUpsert('settings', { key: 'transaction_purge_at', value: marker }, 'key');
        }

        await sqlite.upsert('settings', { key: 'transaction_purge_at', value: marker, updatedAt: marker }, 'key');
        await purgeLocalTransactionsBefore(marker);
        await hydrateSvelteStores();
    } finally {
        startBackgroundSync();
    }
}

/**
 * Wipe local sync memory and force a full 100% download from MariaDB
 * to repair corrupted or outdated local schemas/data.
 */
export async function forceFullSync(): Promise<void> {
    if (!isMultiMode()) return;
    console.log('database: forcing FULL sync/repair...');
    stopBackgroundSync(); // Pause intervals during repair

    // Ensure we don't collide with an active sync
    while (isSyncRunning || isFastSyncRunning) {
        await new Promise(r => setTimeout(r, 100));
    }

    try {
        await ensureDatabaseIdentityForSync();
        const localDb = await sqlite.getDb();
        // Clear every per-table watermark so the next cycle re-pulls all tables.
        await localDb.execute(
            `DELETE FROM settings WHERE key LIKE 'sync_ts_%' OR key IN ('last_sync_time', 'last_fast_sync_time')`
        );

        // This will now download everything from scratch since there are no watermarks
        await runSyncCycle();

        console.log('database: full sync repair complete, rehydrating stores...');
        await hydrateSvelteStores();
    } catch (e) {
        console.error('database: full sync repair failed:', e);
        throw e;
    } finally {
        startBackgroundSync(); // Resume normal operations
    }
}

/**
 * Force push all local SQLite data to MariaDB, ignoring timestamps.
 * This is meant to repair a corrupted MariaDB instance that is missing columns.
 */
export async function forcePushToServer(): Promise<void> {
    if (!isMultiMode()) return;
    console.log('database: forcing FULL push to server...');
    stopBackgroundSync(); // Pause intervals during repair

    // Ensure we don't collide with an active sync
    while (isSyncRunning || isFastSyncRunning) {
        await new Promise(r => setTimeout(r, 100));
    }

    try {
        await ensureDatabaseIdentityForSync();
        const localDb = await sqlite.getDb();
        // Reuse the shared push helper (skips device-local settings keys).
        await forcePushTables(localDb);
        console.log('database: Force push complete.');
    } catch (e) {
        console.error('database: force push failed:', e);
        throw e;
    } finally {
        startBackgroundSync(); // Resume normal operations
    }
}

/**
 * Wipe all local SQLite tables (except connection settings) and force a full
 * clean download from MariaDB.
 */
export async function wipeAndPullFromServer(): Promise<void> {
    if (!isMultiMode()) return;
    console.log('database: wiping local DB and pulling from server...');
    stopBackgroundSync();

    while (isSyncRunning || isFastSyncRunning) {
        await new Promise(r => setTimeout(r, 100));
    }

    try {
        await ensureDatabaseIdentityForSync();
        const localDb = await sqlite.getDb();

        // Wipe local tables
        const tablesToWipe = [
            'categories', 'products', 'pos_pages', 'pos_tiles',
            'tax_rates', 'discounts', 'promo_groups', 'promo_group_items',
            'employees', 'customers', 'registers',
            'suppliers', 'product_suppliers', 'inventory_logs',
            'orders', 'order_lines', 'payments',
            'loyalty_logs', 'audit_logs', 'shifts', 'cash_movements'
        ];

        for (const table of tablesToWipe) {
            await localDb.execute(`DELETE FROM ${table}`);
        }
        // Also clear all per-table watermarks (incl. tombstones) so it pulls everything
        await localDb.execute(
            `DELETE FROM settings WHERE key LIKE 'sync_ts_%' OR key IN ('last_sync_time', 'last_fast_sync_time')`
        );
        console.log('database: local tables wiped. Running full sync cycle...');

        // This will now download everything from scratch into empty tables
        await runSyncCycle();

        console.log('database: wipe and pull complete, rehydrating stores...');
        await hydrateSvelteStores();
    } catch (e) {
        console.error('database: wipe and pull failed:', e);
        throw e;
    } finally {
        startBackgroundSync();
    }
}
