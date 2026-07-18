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
 *   - Writes: update SQLite, create a durable outbox row, then flush to MySQL
 *   - If MySQL is down: outbox rows stay in SQLite and flush later
 */

import * as sqlite from './sqlite';
import * as mysql from './mysql';
import { isMultiMode, getMysqlDb, connectionState, pingMysql, buildMysqlUri, resetMysqlConnection } from './connection';
import { get } from 'svelte/store';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { currentEmployee } from './session';
import { notifyOwnerCloudDataChanged } from '$lib/ownerCloudEvents';

const PROMOTION_SYNC_TABLES = ['discounts', 'promo_groups', 'promo_group_items'];
const PROMOTION_SYNC_TABLE_SET = new Set(PROMOTION_SYNC_TABLES);
export const POS_HELD_ORDERS_CHANGED_EVENT = 'pos-held-orders-changed';
const RECEIPT_SEQUENCE_REMOTE_TIMEOUT_MS = 1200;
const RECEIPT_BLOCK = 1_000_000;
const RECEIPT_HIGH_WATER_KEY = 'receipt_number_high_water';
const LIGHT_STORE_ROUTES = new Set([
    '/', '/admin', '/orders', '/items', '/discounts', '/categories', '/customers', '/employees', '/employees/permissions', '/reports', '/shifts', '/audit', '/label-print', '/customer-display',
    '/design', '/design/scale', '/tiles', '/settings/layout', '/settings/labels',
]);
const POS_LIGHT_ROUTE_TABLES = [
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
] as const;
const ITEM_LIGHT_ROUTE_TABLES = [
    'categories',
    'tax_rates',
    'employees',
    'settings',
] as const;
const ADMIN_LIGHT_ROUTE_TABLES = [
    'employees',
    'settings',
] as const;
const DESIGN_LIGHT_ROUTE_TABLES = [
    'employees',
    'settings',
] as const;
const TILE_DESIGNER_LIGHT_ROUTE_TABLES = [
    'pos_pages',
    'pos_tiles',
    'employees',
    'settings',
] as const;
const ORDERS_LIGHT_ROUTE_TABLES = [
    'employees',
    'settings',
    'registers',
] as const;
const DISCOUNTS_LIGHT_ROUTE_TABLES = [
    'employees',
    'settings',
    'discounts',
    'promo_groups',
    'promo_group_items',
] as const;
const CUSTOMER_DISPLAY_LIGHT_ROUTE_TABLES = [
    'employees',
    'settings',
] as const;
const CATEGORY_LIGHT_ROUTE_TABLES = [
    'categories',
    'employees',
    'settings',
] as const;
const CUSTOMER_LIGHT_ROUTE_TABLES = [
    'customers',
    'employees',
    'settings',
] as const;
const EMPLOYEE_LIGHT_ROUTE_TABLES = [
    'employees',
    'settings',
] as const;
const REPORTS_LIGHT_ROUTE_TABLES = [
    'employees',
    'settings',
] as const;
const LABEL_PRINT_LIGHT_ROUTE_TABLES = [
    'employees',
    'settings',
] as const;
const AUDIT_LIGHT_ROUTE_TABLES = [
    'employees',
    'settings',
] as const;
const SHIFTS_LIGHT_ROUTE_TABLES = [
    'employees',
    'settings',
] as const;
const LIGHT_ROUTE_SKIP_HYDRATION_TABLES = new Set([
    'orders',
    'order_lines',
    'payments',
    'inventory_logs',
    'loyalty_logs',
    'audit_logs',
]);

export function isLightStorePath(pathname: string): boolean {
    return LIGHT_STORE_ROUTES.has(pathname);
}

function isLightStoreRoute(): boolean {
    return typeof window !== 'undefined' && isLightStorePath(window.location.pathname);
}

export function getLightRouteHydrationTables(pathname = typeof window !== 'undefined' ? window.location.pathname : '/'): string[] {
    if (pathname === '/admin') return [...ADMIN_LIGHT_ROUTE_TABLES];
    if (pathname === '/tiles') return [...TILE_DESIGNER_LIGHT_ROUTE_TABLES];
    if (pathname === '/design' || pathname === '/design/scale' || pathname === '/settings/layout' || pathname === '/settings/labels') {
        return [...DESIGN_LIGHT_ROUTE_TABLES];
    }
    if (pathname === '/items') return [...ITEM_LIGHT_ROUTE_TABLES];
    if (pathname === '/orders') return [...ORDERS_LIGHT_ROUTE_TABLES];
    if (pathname === '/discounts') return [...DISCOUNTS_LIGHT_ROUTE_TABLES];
    if (pathname === '/categories') return [...CATEGORY_LIGHT_ROUTE_TABLES];
    if (pathname === '/customers') return [...CUSTOMER_LIGHT_ROUTE_TABLES];
    if (pathname === '/employees' || pathname === '/employees/permissions') return [...EMPLOYEE_LIGHT_ROUTE_TABLES];
    if (pathname === '/reports') return [...REPORTS_LIGHT_ROUTE_TABLES];
    if (pathname === '/shifts') return [...SHIFTS_LIGHT_ROUTE_TABLES];
    if (pathname === '/audit') return [...AUDIT_LIGHT_ROUTE_TABLES];
    if (pathname === '/label-print') return [...LABEL_PRINT_LIGHT_ROUTE_TABLES];
    if (pathname === '/customer-display') return [...CUSTOMER_DISPLAY_LIGHT_ROUTE_TABLES];
    return [...POS_LIGHT_ROUTE_TABLES];
}

function resetRemoteConnections(): void {
    resetMysqlConnection();
    mysql.resetCachedConnection();
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    try {
        return await Promise.race([operation, timeout]);
    } finally {
        clearTimeout(timeoutId!);
    }
}

const AUDIT_ENTITY_BY_TABLE: Record<string, string> = {
    products: 'product',
    categories: 'category',
    customers: 'customer',
    employees: 'employee',
    discounts: 'discount',
    promo_groups: 'promotion_group',
    promo_group_items: 'promotion_item',
    tax_rates: 'tax_rate',
    suppliers: 'supplier',
    product_suppliers: 'product_supplier',
    settings: 'setting',
    registers: 'till',
    pos_pages: 'pos_page',
    pos_tiles: 'pos_tile',
    shifts: 'shift',
    cash_movements: 'cash_movement',
    stock_receipts: 'stock_receipt',
    stock_receipt_lines: 'stock_receipt_line',
};

const AUDITED_TABLES = new Set(Object.keys(AUDIT_ENTITY_BY_TABLE));
const IGNORED_AUDIT_SETTING_KEYS = new Set([
    'bootstrap_uploaded',
    'last_fast_sync_time',
    'last_sync_time',
    'sync_change_cursor',
    'restore_pending_mariadb_replace',
    'transaction_purge_applied_at',
]);
const IGNORED_AUDIT_SETTING_PREFIXES = ['sync_ts_'];
const RESTORE_PENDING_MARIADB_REPLACE_KEY = 'restore_pending_mariadb_replace';
const SERVER_DATA_EPOCH_KEY = 'server_data_epoch';
const SERVER_DATA_EPOCH_SEEN_KEY = 'server_data_epoch_seen';
export const RESTORE_PENDING_MARIADB_REPLACE_MESSAGE =
    'Restore is waiting to replace MariaDB. Open Setup and finish the MariaDB connection before normal sync.';

export async function hasRestorePendingMariaDbReplace(): Promise<boolean> {
    try {
        const d = await sqlite.getDb();
        const rows: any[] = await d.select(
            'SELECT value FROM settings WHERE key = ? LIMIT 1',
            [RESTORE_PENDING_MARIADB_REPLACE_KEY],
        );
        return rows.length > 0 && rows[0]?.value !== '0';
    } catch {
        return false;
    }
}

async function pauseSyncIfRestorePending(): Promise<boolean> {
    if (!await hasRestorePendingMariaDbReplace()) return false;
    stopBackgroundSync();
    connectionState.update(s => ({
        ...s,
        mysqlOnline: false,
        syncError: RESTORE_PENDING_MARIADB_REPLACE_MESSAGE,
    }));
    return true;
}

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
    BusinessSummary, EmployeeSalesSummary,
    OrderPageOptions, OrderPageResult,
    PosHeldOrdersResult, PosRecentReceiptsResult,
    OrderDetailsResult, OrderReversalContext
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
            created_at TEXT NOT NULL,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            last_error TEXT DEFAULT '',
            next_attempt_at TEXT DEFAULT ''
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

/** Create a durable outbox row before attempting to sync a write to MySQL. */
async function queueOffline(
    tableName: string,
    operation: 'upsert' | 'remove' | 'adjustStock' | 'saleBundle' | 'promotionBundle' | 'promotionDelete' | 'limitGoodsMenuItems',
    data: any,
    idKey: string = 'id'
): Promise<string> {
    const d = await sqlite.getDb();
    const id = crypto.randomUUID();
    await d.execute(
        `INSERT INTO _offline_queue (id, table_name, operation, data, id_key, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [id, tableName, operation, JSON.stringify(data), idKey, new Date().toISOString()]
    );
    offlineQueueFlushRequested = true;
    console.log(`database: queued offline ${operation} for ${tableName}`);
    return id;
}

function safeSqlIdentifier(value: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
        throw new Error(`Unsafe SQL identifier: ${value}`);
    }
    return value;
}

async function getLocalRow(table: string, idKey: string, id: unknown): Promise<any | null> {
    if (id === undefined || id === null || id === '') return null;
    const d = await sqlite.getDb();
    const rows: any[] = await d.select(
        `SELECT * FROM ${safeSqlIdentifier(table)} WHERE ${safeSqlIdentifier(idKey)} = ? LIMIT 1`,
        [id],
    );
    return rows[0] || null;
}

function shouldAuditSettingKey(key: string): boolean {
    if (!key) return false;
    if (IGNORED_AUDIT_SETTING_KEYS.has(key)) return false;
    return !IGNORED_AUDIT_SETTING_PREFIXES.some(prefix => key.startsWith(prefix));
}

function shouldAuditTableMutation(table: string, row: any): boolean {
    if (!AUDITED_TABLES.has(table)) return false;
    if (table === 'settings') return shouldAuditSettingKey(String(row?.key || ''));
    return true;
}

function isSensitiveAuditKey(key: string, parent?: any): boolean {
    const lower = key.toLowerCase();
    if (key === 'value' && parent?.key) {
        const settingKey = String(parent.key).toLowerCase();
        return settingKey.includes('mysql')
            || settingKey.includes('database')
            || settingKey.includes('password')
            || settingKey.includes('secret')
            || settingKey.includes('token');
    }
    return lower.includes('pin')
        || lower.includes('password')
        || lower.includes('secret')
        || lower.includes('token')
        || lower.includes('hash');
}

function sanitizeAuditValue(value: any, key = '', parent?: any): any {
    if (isSensitiveAuditKey(key, parent)) return '[redacted]';
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (Array.isArray(value)) return value.map(item => sanitizeAuditValue(item));
    if (typeof value === 'object') {
        const result: Record<string, any> = {};
        for (const [childKey, childValue] of Object.entries(value)) {
            if (childKey === 'updatedAt') continue;
            result[childKey] = sanitizeAuditValue(childValue, childKey, value);
        }
        return result;
    }
    if (typeof value === 'string') {
        const lower = key.toLowerCase();
        if (lower === 'image' || lower.endsWith('image') || value.startsWith('data:image/')) {
            return value ? `[image data ${value.length} chars]` : value;
        }
        if (value.length > 1200) return `${value.slice(0, 1200)}... [truncated ${value.length} chars]`;
    }
    return value;
}

function auditJson(value: any): string {
    if (value === null || value === undefined) return '';
    return JSON.stringify(sanitizeAuditValue(value));
}

function comparableAuditValue(value: any): any {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (Array.isArray(value)) return value.map(item => comparableAuditValue(item));
    if (typeof value === 'object') {
        const result: Record<string, any> = {};
        for (const [key, childValue] of Object.entries(value)) {
            if (key === 'updatedAt') continue;
            result[key] = comparableAuditValue(childValue);
        }
        return result;
    }
    return value;
}

function auditComparable(value: any): string {
    return JSON.stringify(comparableAuditValue(value));
}

function currentAuditEmployeeId(): string {
    try { return get(currentEmployee)?.id || ''; }
    catch { return ''; }
}

async function persistAuditLog(row: any): Promise<void> {
    await sqlite.upsert('audit_logs', row, 'id');
    if (!isMultiMode()) return;
    await queueOffline('audit_logs', 'upsert', row, 'id');
    void flushOfflineQueue().catch((error) => {
        console.warn('database: audit outbox flush failed:', error);
        connectionState.update(s => ({ ...s, mysqlOnline: false, syncError: String(error) }));
    });
}

export async function recordAuditEvent(
    action: string,
    entityType: string,
    entityId: string,
    oldData: unknown = null,
    newData: unknown = null,
    employeeId: string = currentAuditEmployeeId(),
): Promise<void> {
    const stamp = new Date().toISOString();
    await persistAuditLog({
        id: crypto.randomUUID(),
        employeeId,
        action,
        entityType,
        entityId,
        oldData: auditJson(oldData),
        newData: auditJson(newData),
        createdAt: stamp,
        updatedAt: stamp,
    });
}

async function recordTableAudit(
    table: string,
    operation: 'created' | 'updated' | 'deleted',
    idKey: string,
    oldRow: any,
    newRow: any,
): Promise<void> {
    const entityType = AUDIT_ENTITY_BY_TABLE[table];
    if (!entityType) return;
    const source = newRow || oldRow;
    if (!shouldAuditTableMutation(table, source)) return;
    if (operation === 'updated' && auditComparable(oldRow) === auditComparable(newRow)) return;
    const entityId = String(table === 'settings' ? source?.key : source?.[idKey] || '');
    if (!entityId) return;
    await recordAuditEvent(
        `${entityType}_${operation}`,
        entityType,
        entityId,
        oldRow,
        newRow,
    );
}

async function getAuditBefore(table: string, obj: any, idKey: string): Promise<any | null> {
    if (!shouldAuditTableMutation(table, obj)) return null;
    return getLocalRow(table, idKey, obj?.[idKey]);
}

const OFFLINE_QUEUE_BATCH_SIZE = 100;
const OFFLINE_QUEUE_MAX_ATTEMPTS = 3;
const SALE_QUEUE_MAX_ATTEMPTS = 5;
let offlineQueueFlushPromise: Promise<number> | null = null;
let offlineQueueFlushRequested = false;

function syncRetryDelayMs(attempt: number): number {
    return Math.min(60_000, 2_000 * (2 ** Math.max(0, attempt - 1)));
}

function isTransientSyncError(error: unknown): boolean {
    const message = String(error).toLowerCase();
    return [
        'timed out', 'timeout', 'connection refused', 'connection reset',
        'server has gone away', 'broken pipe', 'network', 'transport',
        'error communicating', 'unable to connect', 'connection is closed',
        'configuration is unavailable', 'database is locked',
    ].some(part => message.includes(part));
}

async function moveQueuedRowToConflict(d: any, row: any, reason: string): Promise<void> {
    await d.execute(
        `INSERT OR REPLACE INTO _sync_conflicts (id, table_name, operation, data, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [row.id, row.table_name, row.operation, row.data, reason, new Date().toISOString()],
    );
    await d.execute(`DELETE FROM _offline_queue WHERE id = ?`, [row.id]);
}

async function recordQueueFailure(d: any, row: any, error: unknown): Promise<number> {
    const attempt = Number(row.attempt_count || 0) + 1;
    const nextAttemptAt = new Date(Date.now() + syncRetryDelayMs(attempt)).toISOString();
    await d.execute(
        `UPDATE _offline_queue
         SET attempt_count = ?, last_error = ?, next_attempt_at = ?
         WHERE id = ?`,
        [attempt, String(error).slice(0, 1500), nextAttemptAt, row.id],
    );
    return attempt;
}

async function executeQueuedOperation(row: any, data: any, mysqlDb: any, d: any): Promise<void> {
    // Settings can become device-local in newer releases while an older build
    // has already queued them. Treat those stale outbox rows as completed so
    // they are removed without ever reaching MariaDB.
    if (row.table_name === 'settings' && !isSyncableSetting(String(data?.key || ''))) {
        return;
    }
    if (row.operation === 'upsert') {
        if (PROMOTION_SYNC_TABLE_SET.has(row.table_name)) {
            await flushQueuedPromotionUpsert(row, data, mysqlDb, d);
        } else {
            await mysql.mysqlSafeOfflineUpsert(row.table_name, data, row.id_key);
        }
    } else if (row.operation === 'remove') {
        await mysql.mysqlRemove(row.table_name, data.id, row.id_key);
    } else if (row.operation === 'adjustStock') {
        await mysql.mysqlAdjustStock(data.id, data.delta);
    } else if (row.operation === 'saleBundle') {
        const config = get(connectionState).mysqlConfig;
        if (!config) throw new Error('MariaDB configuration is unavailable');
        await invoke('commit_mysql_sale', { mysqlUri: buildMysqlUri(config), bundle: data });
    } else if (row.operation === 'promotionBundle') {
        const refs = await promotionRefsForQueuedRow(row, data);
        if (await remoteHasPromotionDelete(mysqlDb, refs)) {
            await applyRemotePromotionDeleteLocally(d, refs);
        } else {
            await mysql.mysqlSavePromotionBundle(
                data.group,
                data.discount,
                Array.isArray(data.items) ? data.items : [],
                Array.isArray(data.products) ? data.products : [],
            );
        }
    } else if (row.operation === 'promotionDelete') {
        await mysql.mysqlDeletePromotionBundle(
            Array.isArray(data.discountIds) ? data.discountIds : [data.discountId].filter(Boolean),
            data.groupId || '',
        );
    } else if (row.operation === 'limitGoodsMenuItems') {
        await mysql.mysqlLimitGoodsMenuItems();
    } else {
        throw new Error(`Unsupported offline operation: ${row.operation}`);
    }
}

async function drainOfflineQueue(): Promise<number> {
    const mysqlDb = await getMysqlDb();
    if (!mysqlDb) throw new Error('MariaDB connection is unavailable');
    await ensureDatabaseIdentityForSync();

    const d = await sqlite.getDb();
    const purgeRows: any[] = await mysqlDb.select(
        `SELECT value FROM settings WHERE \`key\` = 'transaction_purge_at' LIMIT 1`,
    );
    if (purgeRows[0]?.value) {
        await d.execute(
            `DELETE FROM _offline_queue
             WHERE created_at <= ? AND (
                operation = 'saleBundle' OR
                table_name IN ('orders','order_lines','payments','shifts','cash_movements','inventory_logs','audit_logs')
             )`,
            [purgeRows[0].value],
        );
    }

    let flushed = await discardQueuedDeletedPromotionRows(mysqlDb, d);
    for (let pass = 0; pass < 100; pass++) {
        offlineQueueFlushRequested = false;
        const now = new Date().toISOString();
        const rows: any[] = await d.select(
            `SELECT * FROM _offline_queue
             WHERE COALESCE(next_attempt_at, '') = '' OR next_attempt_at <= ?
             ORDER BY
                CASE WHEN operation = 'saleBundle' THEN 0
                     WHEN table_name = 'audit_logs' THEN 2
                     ELSE 1 END,
                created_at ASC,
                id ASC
             LIMIT ?`,
            [now, OFFLINE_QUEUE_BATCH_SIZE],
        );
        if (rows.length === 0) {
            if (offlineQueueFlushRequested) continue;
            break;
        }

        for (const row of rows) {
            let data: any = null;
            try {
                data = JSON.parse(row.data);
                await executeQueuedOperation(row, data, mysqlDb, d);
                await d.execute(`DELETE FROM _offline_queue WHERE id = ?`, [row.id]);
                flushed++;
            } catch (error) {
                if (isDatabaseIdentityMismatch(error)) throw error;
                if (data && isPromotionForeignKeyFailure(error, row)) {
                    const refs = await promotionRefsForQueuedRow(row, data);
                    await applyRemotePromotionDeleteLocally(d, refs);
                    await d.execute(`DELETE FROM _offline_queue WHERE id = ?`, [row.id]);
                    flushed++;
                    continue;
                }
                if (data && (String(error).includes('SYNC_CONFLICT') || isReversalConflict(error, data))) {
                    if (row.table_name === 'products') {
                        const conflict = String(error).toLowerCase();
                        if (conflict.includes('uq_products_scale_plu')) {
                            await d.execute(`UPDATE products SET scalePlu = NULL WHERE id = ?`, [data.id]);
                        } else if (conflict.includes('uq_products_sku')) {
                            await d.execute(`UPDATE products SET sku = NULL WHERE id = ?`, [data.id]);
                        } else if (conflict.includes('uq_products_barcode') || conflict.includes('duplicate entry')) {
                            await d.execute(`UPDATE products SET barcode = NULL WHERE id = ?`, [data.id]);
                        }
                    }
                    if (isReversalConflict(error, data)) {
                        await discardLocalConflictingReversal(data, mysqlDb);
                    }
                    await moveQueuedRowToConflict(d, row, String(error));
                    continue;
                }

                const attempt = await recordQueueFailure(d, row, error);
                if (isTransientSyncError(error)) throw error;
                const maxAttempts = row.operation === 'saleBundle'
                    ? SALE_QUEUE_MAX_ATTEMPTS
                    : OFFLINE_QUEUE_MAX_ATTEMPTS;
                if (attempt >= maxAttempts) {
                    await moveQueuedRowToConflict(
                        d,
                        row,
                        `Upload failed after ${attempt} attempts: ${String(error)}`,
                    );
                }
                console.warn(`database: isolated failed queue item ${row.id} (attempt ${attempt}):`, error);
            }
        }

        if (rows.length < OFFLINE_QUEUE_BATCH_SIZE && !offlineQueueFlushRequested) break;
    }

    if (flushed > 0) console.log(`database: flushed ${flushed} offline operations to MariaDB`);
    return flushed;
}

/** Join concurrent callers to one drain and pick up rows queued while it is running. */
export function flushOfflineQueue(): Promise<number> {
    offlineQueueFlushRequested = true;
    if (offlineQueueFlushPromise) return offlineQueueFlushPromise;

    const run = drainOfflineQueue();
    offlineQueueFlushPromise = run;
    const finish = () => {
        if (offlineQueueFlushPromise !== run) return;
        offlineQueueFlushPromise = null;
        if (offlineQueueFlushRequested) {
            void flushOfflineQueue().catch((error) => {
                console.warn('database: follow-up outbox drain failed:', error);
            });
        }
    };
    void run.then(finish, finish);
    return run;
}

/** User-requested retry: clear automatic backoff, then join the normal drain. */
export async function retryOfflineQueueNow(): Promise<number> {
    const d = await sqlite.getDb();
    await d.execute(
        `UPDATE _offline_queue
         SET next_attempt_at = ''
         WHERE next_attempt_at <> ''`,
    );
    return flushOfflineQueue();
}

async function pendingOfflineQueueCount(): Promise<number> {
    const d = await sqlite.getDb();
    const rows: any[] = await d.select(`SELECT COUNT(*) AS count FROM _offline_queue`);
    return Number(rows[0]?.count || 0);
}

export interface OfflineQueueStats {
    pending: number;
    retrying: number;
    conflicts: number;
    oldestPendingAt: string;
    nextRetryAt: string;
    lastError: string;
}

export async function getOfflineQueueStats(): Promise<OfflineQueueStats> {
    const d = await sqlite.getDb();
    const [pendingRows, conflictRows] = await Promise.all([
        d.select(
            `SELECT COUNT(*) AS count,
                    SUM(CASE WHEN attempt_count > 0 THEN 1 ELSE 0 END) AS retrying,
                    MIN(created_at) AS oldest,
                    MIN(CASE WHEN next_attempt_at <> '' THEN next_attempt_at END) AS nextRetryAt
             FROM _offline_queue`,
        ) as Promise<any[]>,
        d.select(`SELECT COUNT(*) AS count FROM _sync_conflicts`) as Promise<any[]>,
    ]);
    const errorRows: any[] = await d.select(
        `SELECT last_error FROM _offline_queue
         WHERE last_error <> ''
         ORDER BY next_attempt_at DESC, created_at DESC
         LIMIT 1`,
    );
    return {
        pending: Number(pendingRows[0]?.count || 0),
        retrying: Number(pendingRows[0]?.retrying || 0),
        conflicts: Number(conflictRows[0]?.count || 0),
        oldestPendingAt: String(pendingRows[0]?.oldest || ''),
        nextRetryAt: String(pendingRows[0]?.nextRetryAt || ''),
        lastError: String(errorRows[0]?.last_error || ''),
    };
}

async function pendingPromotionQueueCount(): Promise<number> {
    const d = await sqlite.getDb();
    const rows: any[] = await d.select(
        `SELECT COUNT(*) AS count
         FROM _offline_queue
         WHERE operation IN ('promotionBundle', 'promotionDelete')
            OR table_name IN ('discounts', 'promo_groups', 'promo_group_items')`
    );
    return Number(rows[0]?.count || 0);
}

type PromotionDeleteRefs = {
    groupId: string;
    discountIds: string[];
    itemIds: string[];
};

function uniqueStrings(values: unknown[]): string[] {
    return Array.from(new Set(values.map(value => String(value || '')).filter(Boolean)));
}

async function selectLocalPromotionIds(groupId: string): Promise<{ discountIds: string[]; itemIds: string[] }> {
    if (!groupId) return { discountIds: [], itemIds: [] };
    const d = await sqlite.getDb();
    const [discountRows, itemRows] = await Promise.all([
        d.select(`SELECT id FROM discounts WHERE groupId = ?`, [groupId]) as Promise<any[]>,
        d.select(`SELECT id FROM promo_group_items WHERE groupId = ?`, [groupId]) as Promise<any[]>,
    ]);
    return {
        discountIds: discountRows.map(row => row.id).filter(Boolean),
        itemIds: itemRows.map(row => row.id).filter(Boolean),
    };
}

async function promotionRefsForQueuedRow(row: any, data: any): Promise<PromotionDeleteRefs | null> {
    let groupId = '';
    let discountIds: string[] = [];
    let itemIds: string[] = [];

    if (row.operation === 'promotionBundle') {
        groupId = String(data?.group?.id || data?.discount?.groupId || '');
        discountIds = uniqueStrings([data?.discount?.id]);
        itemIds = uniqueStrings(Array.isArray(data?.items) ? data.items.map((item: any) => item?.id) : []);
    } else if (row.table_name === 'promo_groups') {
        groupId = String(data?.id || '');
    } else if (row.table_name === 'discounts') {
        groupId = String(data?.groupId || '');
        discountIds = uniqueStrings([data?.id]);
    } else if (row.table_name === 'promo_group_items') {
        groupId = String(data?.groupId || '');
        itemIds = uniqueStrings([data?.id]);
    } else {
        return null;
    }

    const localIds = await selectLocalPromotionIds(groupId);
    return {
        groupId,
        discountIds: uniqueStrings([...discountIds, ...localIds.discountIds]),
        itemIds: uniqueStrings([...itemIds, ...localIds.itemIds]),
    };
}

async function remoteHasPromotionDelete(mysqlDb: any, refs: PromotionDeleteRefs | null): Promise<boolean> {
    if (!refs) return false;
    const pairs: Array<[string, string]> = [];
    if (refs.groupId) pairs.push(['promo_groups', refs.groupId]);
    for (const id of refs.discountIds) pairs.push(['discounts', id]);
    for (const id of refs.itemIds) pairs.push(['promo_group_items', id]);
    if (pairs.length === 0) return false;

    const where = pairs.map(() => `(table_name = ? AND row_id = ?)`).join(' OR ');
    const params = pairs.flatMap(pair => pair);
    const rows: any[] = await mysqlDb.select(
        `SELECT COUNT(*) AS count FROM tombstones WHERE ${where}`,
        params,
    );
    return Number(rows[0]?.count || 0) > 0;
}

async function remotePromotionGroupExists(mysqlDb: any, groupId: string): Promise<boolean> {
    if (!groupId) return false;
    const rows: any[] = await mysqlDb.select(`SELECT id FROM promo_groups WHERE id = ? LIMIT 1`, [groupId]);
    return rows.length > 0;
}

async function getLocalPromotionBundleByGroupId(groupId: string): Promise<{ group: any; discount: any; items: any[]; products: any[] } | null> {
    if (!groupId) return null;
    const d = await sqlite.getDb();
    const [groupRows, discountRows, items] = await Promise.all([
        d.select(`SELECT * FROM promo_groups WHERE id = ? LIMIT 1`, [groupId]) as Promise<any[]>,
        d.select(`SELECT * FROM discounts WHERE groupId = ? ORDER BY updatedAt DESC, id LIMIT 1`, [groupId]) as Promise<any[]>,
        d.select(`SELECT * FROM promo_group_items WHERE groupId = ? ORDER BY productId, id`, [groupId]) as Promise<any[]>,
    ]);
    const group = groupRows[0];
    const discount = discountRows[0];
    if (!group || !discount) return null;
    return {
        group,
        discount,
        items,
        products: await getLocalProductsForPromotionItems(items),
    };
}

async function applyRemotePromotionDeleteLocally(d: any, refs: PromotionDeleteRefs | null): Promise<void> {
    if (!refs) return;
    if (refs.groupId || refs.discountIds.length > 0) {
        await deleteLocalPromotionBundle(refs.discountIds, refs.groupId);
        return;
    }
    if (refs.itemIds.length > 0) {
        const placeholders = refs.itemIds.map(() => '?').join(', ');
        await d.execute(`DELETE FROM promo_group_items WHERE id IN (${placeholders})`, refs.itemIds);
    }
}

async function discardQueuedDeletedPromotionRows(mysqlDb: any, d: any): Promise<number> {
    const rows: any[] = await d.select(
        `SELECT * FROM _offline_queue
         WHERE operation = 'promotionBundle'
            OR (operation = 'upsert' AND table_name IN ('discounts', 'promo_groups', 'promo_group_items'))
         ORDER BY created_at ASC, id ASC`
    );
    let discarded = 0;
    for (const row of rows) {
        let data: any;
        try {
            data = JSON.parse(row.data);
        } catch {
            continue;
        }
        const refs = await promotionRefsForQueuedRow(row, data);
        if (await remoteHasPromotionDelete(mysqlDb, refs)) {
            await applyRemotePromotionDeleteLocally(d, refs);
            await d.execute(`DELETE FROM _offline_queue WHERE id = ?`, [row.id]);
            discarded++;
        }
    }
    if (discarded > 0) {
        console.log(`database: discarded ${discarded} stale queued promotion change(s) already deleted on MariaDB`);
    }
    return discarded;
}

async function flushQueuedPromotionUpsert(row: any, data: any, mysqlDb: any, d: any): Promise<void> {
    const refs = await promotionRefsForQueuedRow(row, data);
    if (await remoteHasPromotionDelete(mysqlDb, refs)) {
        await applyRemotePromotionDeleteLocally(d, refs);
        return;
    }

    if (refs?.groupId) {
        const bundle = await getLocalPromotionBundleByGroupId(refs.groupId);
        if (bundle) {
            await mysql.mysqlSavePromotionBundle(bundle.group, bundle.discount, bundle.items, bundle.products);
            return;
        }
    }

    if (row.table_name === 'promo_group_items') {
        if (!data?.groupId || !(await remotePromotionGroupExists(mysqlDb, data.groupId))) {
            await d.execute(`DELETE FROM promo_group_items WHERE id = ?`, [data?.id]);
            return;
        }
        if (data?.productId) {
            const products = await getLocalProductsForPromotionItems([data]);
            await mysql.mysqlEnsureProductSnapshots(products);
        }
    }

    if (row.table_name === 'discounts' && data?.groupId && !(await remotePromotionGroupExists(mysqlDb, data.groupId))) {
        await d.execute(`DELETE FROM discounts WHERE id = ?`, [data?.id]);
        return;
    }

    await mysql.mysqlSafeOfflineUpsert(row.table_name, data, row.id_key);
}

function isPromotionForeignKeyFailure(error: unknown, row: any): boolean {
    const message = String(error).toLowerCase();
    return (row.operation === 'promotionBundle' || PROMOTION_SYNC_TABLE_SET.has(row.table_name))
        && message.includes('foreign key constraint fails')
        && (message.includes('promo_group_items') || message.includes('promo_groups') || message.includes('discounts'));
}

async function pushWriteInBackground(
    label: string,
    _write: () => Promise<void>,
    queue: () => Promise<unknown>,
): Promise<void> {
    if (!isMultiMode()) return;
    await queue();
    void flushOfflineQueue().then((flushed) => {
        if (flushed > 0) connectionState.update(s => ({ ...s, mysqlOnline: true, syncError: null }));
    }).catch(async (e) => {
        console.warn(`database: background ${label} outbox flush failed:`, e);
        connectionState.update(s => ({ ...s, mysqlOnline: false, syncError: String(e) }));
    });
}

async function writeOrQueueImmediately(
    label: string,
    _write: () => Promise<void>,
    queue: () => Promise<unknown>,
): Promise<void> {
    if (!isMultiMode()) return;
    let queued = false;
    try {
        await queue();
        queued = true;
        const flushed = await flushOfflineQueue();
        if (flushed > 0) connectionState.update(s => ({ ...s, mysqlOnline: true, syncError: null }));
    } catch (e) {
        if (!queued) throw e;
        console.warn(`database: ${label} outbox flush failed:`, e);
        if (isDatabaseIdentityMismatch(e)) {
            connectionState.update(s => ({ ...s, mysqlOnline: false, syncError: String(e) }));
            throw e;
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

async function queueLocalProductSnapshot(productId: string, fallback?: any): Promise<string> {
    const d = await sqlite.getDb();
    const rows: any[] = await d.select('SELECT * FROM products WHERE id = ? LIMIT 1', [productId]);
    const product = rows[0] || fallback;
    if (!product) throw new Error(`Cannot queue product ${productId}; no local snapshot exists`);
    return queueOffline('products', 'upsert', product);
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
    RECEIPT_HIGH_WATER_KEY,
    'automatic_setup_backup_enabled', 'automatic_setup_backup_time',
    'automatic_setup_backup_directory', 'backup_directory',
    'last_sync_time', 'last_fast_sync_time', 'bootstrap_uploaded',
    'transaction_purge_applied_at', 'sync_change_cursor',
    'training_mode_enabled',
    'cctv_pos_enabled', 'cctv_pos_host', 'cctv_pos_port', 'cctv_pos_number',
    'cctv_pos_name', 'cctv_pos_source_ip', 'cctv_pos_encoding',
    'cctv_pos_line_width', 'cctv_pos_send_items', 'cctv_pos_send_receipts',
    'cash_drawer_enabled', 'cash_drawer_printer_host', 'cash_drawer_printer_port',
    'cash_drawer_printer_name', 'cash_drawer_printer_device_path',
    'cash_drawer_pin', 'cash_drawer_pulse_on_ms', 'cash_drawer_pulse_off_ms',
    'receipt_printer_enabled', 'receipt_printer_connection', 'receipt_printer_host',
    'receipt_printer_port', 'receipt_printer_name', 'receipt_printer_device_path',
    'receipt_printer_baud_rate', 'receipt_printer_paper_width', 'receipt_printer_model',
    'receipt_printer_auto_print_after_payment', 'receipt_printer_cut_paper',
    'receipt_printer_cut_feed_lines',
    'receipt_printer_open_drawer_after_cash', 'receipt_printer_open_drawer_after_payment',
    'receipt_printer_encoding',
    'label_printer_enabled', 'label_printer_connection', 'label_printer_protocol',
    'label_printer_host', 'label_printer_port', 'label_printer_name',
    'label_printer_device_path', 'label_printer_baud_rate', 'label_printer_cut_paper',
    'label_printer_gap_lines', 'label_printer_dpi',
    'scale_hardware_enabled', 'scale_hardware_device_path', 'scale_hardware_baud_rate',
    'scale_hardware_poll_ms', 'scale_hardware_request_mode',
    // Speaker and vibration support differs by till. Keep operator feedback
    // independent so changing a noisy till does not alter every other till.
    'feedback_button_sound_enabled', 'feedback_item_sound_enabled', 'feedback_scan_sound_enabled',
    'feedback_haptics_enabled', 'feedback_sale_sound_enabled', 'barcode_error_sound',
    // Server-side control rows — never copy between tills.
    'till_seq_counter', 'bootstrap_done', SERVER_DATA_EPOCH_SEEN_KEY,
]);

function isSyncableSetting(key: string): boolean {
    if (LOCAL_ONLY_SETTING_KEYS.has(key)) return false;
    if (key.startsWith('sync_ts_')) return false;
    if (key.startsWith('migration_')) return false;
    return true;
}

function isPushableSetting(key: string): boolean {
    // The epoch is authored by MariaDB replacement/bootstrap only. Other tills
    // may read it, but ordinary settings pushes must never move it backwards.
    if (key === SERVER_DATA_EPOCH_KEY) return false;
    return isSyncableSetting(key);
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
                (SELECT COUNT(*) FROM categories) AS categories,
                (SELECT COUNT(*) FROM orders) AS orders,
                (SELECT COUNT(*) FROM customers) AS customers`
    );
    const row = rows[0] || {};
    return ['products', 'categories', 'orders', 'customers']
        .some((key) => Number(row[key] || 0) > 0);
}

type BusinessDataCounts = {
    products: number;
    categories: number;
    orders: number;
    customers: number;
};

function normalizeBusinessCounts(row: any): BusinessDataCounts {
    return {
        products: Number(row.products || 0),
        categories: Number(row.categories || 0),
        orders: Number(row.orders || 0),
        customers: Number(row.customers || 0),
    };
}

function hasBusinessData(counts: BusinessDataCounts): boolean {
    return counts.products > 0 || counts.categories > 0 || counts.orders > 0 || counts.customers > 0;
}

async function countLocalBusinessData(): Promise<BusinessDataCounts> {
    const d = await sqlite.getDb();
    const rows: any[] = await d.select(
        `SELECT (SELECT COUNT(*) FROM products) AS products,
                (SELECT COUNT(*) FROM categories) AS categories,
                (SELECT COUNT(*) FROM orders) AS orders,
                (SELECT COUNT(*) FROM customers) AS customers`
    );
    return normalizeBusinessCounts(rows[0] || {});
}

async function countRemoteBusinessData(): Promise<BusinessDataCounts> {
    const d = await getMysqlDb();
    if (!d) return normalizeBusinessCounts({});
    const rows: any[] = await d.select(
        `SELECT (SELECT COUNT(*) FROM products) AS products,
                (SELECT COUNT(*) FROM categories) AS categories,
                (SELECT COUNT(*) FROM orders) AS orders,
                (SELECT COUNT(*) FROM customers) AS customers`
    );
    return normalizeBusinessCounts(rows[0] || {});
}

async function remoteLooksLikeIncompleteLocalUpload(): Promise<boolean> {
    const localCounts = await countLocalBusinessData();
    const remoteCounts = await countRemoteBusinessData();
    return remoteCounts.orders === 0
        && localCounts.products > 0
        && (
            localCounts.products > remoteCounts.products
            || localCounts.categories > remoteCounts.categories
            || localCounts.customers > remoteCounts.customers
        );
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
    const localHasBusinessData = hasBusinessData(await countLocalBusinessData());

    if (localIdentity && remoteIdentity) {
        if (localIdentity.shopId !== remoteIdentity.shopId) {
            if (!localHasBusinessData) {
                await saveLocalAppIdentity(remoteIdentity);
                return remoteIdentity;
            }
            if (!await remoteHasShopData() || await remoteLooksLikeIncompleteLocalUpload()) {
                const identity = {
                    ...localIdentity,
                    shopName: localIdentity.shopName || localName || remoteName,
                    updatedAt: new Date().toISOString(),
                };
                await saveRemoteAppIdentity(identity);
                if (identity.shopName !== localIdentity.shopName) await saveLocalAppIdentity(identity);
                return identity;
            }
            throw new DatabaseIdentityMismatchError(identityMismatchMessage(localIdentity, remoteIdentity));
        }
        return localIdentity;
    }

    if (!localIdentity && remoteIdentity) {
        if (!localHasBusinessData) {
            await saveLocalAppIdentity(remoteIdentity);
            return remoteIdentity;
        }
        if (!await remoteHasShopData() || await remoteLooksLikeIncompleteLocalUpload()) {
            const identity = makeIdentity(localName || remoteIdentity.shopName || remoteName);
            await saveLocalAppIdentity(identity);
            await saveRemoteAppIdentity(identity);
            return identity;
        }
        if (namesConflict(localName, remoteIdentity.shopName || remoteName)) {
            const preview = makeIdentity(localName);
            throw new DatabaseIdentityMismatchError(identityMismatchMessage(preview, remoteIdentity));
        }
        await saveLocalAppIdentity(remoteIdentity);
        return remoteIdentity;
    }

    if (localIdentity && !remoteIdentity) {
        if (await remoteHasShopData()) {
            if (namesConflict(localIdentity.shopName || localName, remoteName)
                && !await remoteLooksLikeIncompleteLocalUpload()) {
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

    if (namesConflict(localName, remoteName) && await remoteHasShopData()
        && !await remoteLooksLikeIncompleteLocalUpload()) {
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

async function setTableWatermarks(tables: Iterable<string>, value: string): Promise<void> {
    const keys = [...new Set(Array.from(tables, table => `sync_ts_${table}`))];
    if (keys.length === 0) return;
    const d = await sqlite.getDb();
    const placeholders = keys.map(() => '(?, ?, ?)').join(', ');
    const params = keys.flatMap(key => [key, value, value]);
    await d.execute(
        `INSERT INTO settings (key, value, updatedAt)
         VALUES ${placeholders}
         ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updatedAt = excluded.updatedAt`,
        params,
    );
}

async function purgeLocalTransactionsBefore(marker: string): Promise<void> {
    const d = await sqlite.getDb();
    const oldOrder = `(createdAt IS NULL OR createdAt = '' OR createdAt <= ?)`;
    const oldShift = `(openedAt IS NULL OR openedAt = '' OR openedAt <= ?)`;
    const salesAuditTypes = `'order','shift','cash_movement','report'`;
    const salesAuditActions = `'sale_completed','order_refunded','order_partially_refunded','order_voided','refund_completed','report_period_closed'`;

    await preserveLocalReceiptHighWater(d);
    await d.execute(`DELETE FROM inventory_logs WHERE referenceId IN (SELECT id FROM orders WHERE ${oldOrder})`, [marker]);
    await d.execute(
        `DELETE FROM audit_logs
         WHERE entityId IN (SELECT id FROM orders WHERE ${oldOrder})
            OR entityId IN (SELECT id FROM shifts WHERE ${oldShift})
            OR (
                (entityType IN (${salesAuditTypes}) OR action IN (${salesAuditActions}))
                AND (createdAt IS NULL OR createdAt = '' OR createdAt <= ?)
            )`,
        [marker, marker, marker],
    );
    await d.execute(
        `DELETE FROM manager_approvals
         WHERE entityId IN (SELECT id FROM orders WHERE ${oldOrder})
            OR ((entityType = 'order' OR action = 'refund_void')
                AND (createdAt IS NULL OR createdAt = '' OR createdAt <= ?))`,
        [marker, marker],
    );
    await d.execute(`DELETE FROM payments WHERE orderId IN (SELECT id FROM orders WHERE ${oldOrder})`, [marker]);
    await d.execute(
        `DELETE FROM payment_terminal_attempts
         WHERE status NOT IN ('approved', 'commit_failed')
           AND (createdAt IS NULL OR createdAt = '' OR createdAt <= ?)`,
        [marker],
    );
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
            table_name IN ('orders','order_lines','payments','shifts','cash_movements','inventory_logs','audit_logs','manager_approvals')
         )`,
        [marker]
    );
    await d.execute(
        `DELETE FROM tombstones WHERE table_name IN ('orders','order_lines','payments','shifts','cash_movements','inventory_logs','audit_logs','manager_approvals')`
    );
    await sqlite.upsert('settings', { key: 'transaction_purge_applied_at', value: marker, updatedAt: marker }, 'key');
}

async function preserveLocalReceiptHighWater(d: any): Promise<void> {
    const settingsRows: any[] = await d.select(
        `SELECT key, value FROM settings WHERE key IN (?, ?)`,
        ['till_seq', RECEIPT_HIGH_WATER_KEY],
    );
    const readSetting = (key: string) => String(settingsRows.find(row => row.key === key)?.value || '');
    const tillSeq = Math.max(0, parseInt(readSetting('till_seq'), 10) || 0);
    const savedHighWater = Math.max(0, parseInt(readSetting(RECEIPT_HIGH_WATER_KEY), 10) || 0);

    let maxIssued = 0;
    let applicableSavedHighWater = savedHighWater;
    if (tillSeq > 0) {
        const blockStart = tillSeq * RECEIPT_BLOCK;
        const blockEnd = blockStart + RECEIPT_BLOCK;
        const rows: any[] = await d.select(
            `SELECT MAX(orderNumber) AS maxNum FROM orders WHERE orderNumber >= ? AND orderNumber < ?`,
            [blockStart, blockEnd],
        );
        maxIssued = Number(rows[0]?.maxNum || 0);
        if (savedHighWater < blockStart || savedHighWater >= blockEnd) applicableSavedHighWater = 0;
    } else {
        const rows: any[] = await d.select(`SELECT MAX(orderNumber) AS maxNum FROM orders WHERE orderNumber > 0`);
        maxIssued = Number(rows[0]?.maxNum || 0);
    }

    const highWater = Math.max(maxIssued, applicableSavedHighWater);
    if (highWater <= 0) return;
    const stamp = new Date().toISOString();
    await sqlite.upsert('settings', {
        key: RECEIPT_HIGH_WATER_KEY,
        value: String(highWater),
        updatedAt: stamp,
    }, 'key');
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
    await pushWriteInBackground(
        `tombstone for ${table}/${id}`,
        () => mysql.mysqlUpsert('tombstones', tomb, 'id'),
        () => queueOffline('tombstones', 'upsert', tomb, 'id'),
    );
}

/**
 * Pull tombstones created since our last tombstone watermark and apply the
 * deletions to the local SQLite cache. Returns the number of rows removed.
 */
async function applyTombstones(newSyncTime: string, strict = false): Promise<number> {
    const since = overlapWatermark(await getTableWatermark('tombstones'));
    const d = await sqlite.getDb();
    const allowedTables = new Set([...ALL_SYNC_TABLES, 'tombstones']);
    let applied = 0;
    let failed = false;
    let cursor: mysql.MysqlSyncPageCursor | null = null;

    try {
        for (let page = 0; page < 10_000; page++) {
            const result = await mysql.mysqlGetSyncPage(
                'tombstones',
                since,
                newSyncTime,
                'id',
                cursor,
                SYNC_PULL_PAGE_SIZE,
            );
            for (const t of result.rows) {
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
                } catch (error) {
                    failed = true;
                    console.warn(`database: could not apply tombstone ${t.id}:`, error);
                    if (strict) throw error;
                }
            }
            if (!result.nextCursor) break;
            if (cursor
                && cursor.updatedAt === result.nextCursor.updatedAt
                && cursor.rowId === result.nextCursor.rowId) {
                throw new Error('Tombstone sync cursor did not advance');
            }
            cursor = result.nextCursor;
        }
    } catch (error) {
        // Keep the watermark untouched so the complete bounded window retries.
        if (strict) throw error;
        return applied;
    }
    // Never skip a failed deletion. Keep the old watermark and retry the batch.
    if (failed) return applied;
    await setTableWatermark('tombstones', newSyncTime);
    return applied;
}

// ─── Bulk push helpers (initial upload / repair) ────────────────────────────
const PUSH_TABLES = [
    'categories', 'products', 'product_images', 'pos_pages', 'pos_tiles',
    'tax_rates', 'discounts', 'promo_groups', 'promo_group_items',
    'employees', 'settings', 'customers', 'registers',
    'suppliers', 'product_suppliers', 'inventory_logs',
    'orders', 'order_lines', 'payments',
    'loyalty_logs', 'audit_logs', 'shifts', 'cash_movements',
    'till_report_markers', 'manager_approvals',
    'stock_receipts', 'stock_receipt_lines'
];

const PRESERVE_DURING_RESTORE_TABLES = new Set(['employees', 'settings', 'app_identity']);

const REMOTE_REPLACE_DELETE_TABLES = [
    'stock_receipt_lines', 'stock_receipts',
    'manager_approvals', 'till_report_markers',
    'cash_movements', 'shifts',
    'payments', 'order_lines', 'orders',
    'loyalty_logs', 'audit_logs', 'inventory_logs',
    'product_suppliers', 'suppliers',
    'promo_group_items', 'promo_groups', 'discounts',
    'pos_tiles', 'pos_pages',
    'product_images', 'products', 'categories', 'customers',
    'registers', 'tax_rates',
];

/** Push every local table to MariaDB (skips device-local settings keys). */
async function forcePushTables(
    localDb: any,
    options: { skipTables?: Set<string> } = {},
): Promise<void> {
    for (const table of PUSH_TABLES) {
        if (options.skipTables?.has(table)) continue;
        let rows: any[] = await localDb.select(`SELECT * FROM ${table}`);
        if (table === 'settings') rows = rows.filter((r: any) => isPushableSetting(r.key));
        if (rows.length === 0) continue;

        console.log(`database: uploading ${rows.length} rows to MariaDB ${table}…`);
        if (table === 'products') {
            const chunkSize = 500;
            const fullChunkEnd = Math.floor(rows.length / chunkSize) * chunkSize;
            for (let i = 0; i < fullChunkEnd; i += chunkSize) {
                await mysql.mysqlBulkAddProducts(rows.slice(i, i + chunkSize));
            }
            const tail = rows.slice(fullChunkEnd);
            if (tail.length > 0) {
                console.log(`database: uploading final ${tail.length} MariaDB products individually…`);
                await mysql.mysqlUploadProductsIndividually(tail);
            }
            await repairMissingProductsAfterUpload(rows);
        } else {
            const idKey = table === 'settings' ? 'key' : 'id';
            for (const row of rows) await mysql.mysqlUpsert(table, row, idKey);
        }
    }
}

async function repairMissingProductsAfterUpload(localProducts: any[]): Promise<void> {
    const remote = await getMysqlDb();
    if (!remote) throw new Error('MariaDB is unavailable after product upload');
    const remoteRows: any[] = await remote.select('SELECT id FROM products');
    const remoteIds = new Set(remoteRows.map((row) => String(row.id)));
    const missing = localProducts.filter((product) => product?.id && !remoteIds.has(String(product.id)));
    if (missing.length === 0) return;

    console.warn(`database: MariaDB missed ${missing.length} products after bulk upload; repairing individually…`);
    await mysql.mysqlUploadProductsIndividually(missing);
}

async function verifyProductUploadCount(localDb: any): Promise<void> {
    const remote = await getMysqlDb();
    if (!remote) throw new Error('MariaDB is unavailable after upload');
    const localRows: any[] = await localDb.select('SELECT COUNT(*) AS count FROM products');
    const remoteRows: any[] = await remote.select('SELECT COUNT(*) AS count FROM products');
    const localCount = Number(localRows[0]?.count || 0);
    const remoteCount = Number(remoteRows[0]?.count || 0);
    if (remoteCount < localCount) {
        throw new Error(
            `Upload incomplete: MariaDB has ${remoteCount.toLocaleString()} products, but this till has ${localCount.toLocaleString()}.`
        );
    }
}

const RESTORE_PRODUCT_PRICE_LIMIT = 1_000_000; // £10,000.00 in pennies
const COUNT_VERIFY_SKIP_TABLES = new Set(['settings']);
const REMOTE_COMPLETENESS_CORE_TABLES = [
    'products',
    'categories',
    'customers',
    'tax_rates',
    'registers',
] as const;

type RemoteCompletenessTable = typeof REMOTE_COMPLETENESS_CORE_TABLES[number];
type RemoteCompletenessCounts = Record<RemoteCompletenessTable, number>;

async function localTableExists(localDb: any, table: string): Promise<boolean> {
    const rows: any[] = await localDb.select(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
        [table],
    );
    return rows.length > 0;
}

async function localTableHasColumn(localDb: any, table: string, column: string): Promise<boolean> {
    const rows: any[] = await localDb.select(`PRAGMA table_info(${table})`);
    return rows.some((row) => row.name === column);
}

async function localCount(localDb: any, sql: string): Promise<number> {
    const rows: any[] = await localDb.select(sql);
    return Number(rows[0]?.count || 0);
}

function normalizeRemoteCompletenessCounts(row: any): RemoteCompletenessCounts {
    return {
        products: Number(row.products || 0),
        categories: Number(row.categories || 0),
        customers: Number(row.customers || 0),
        tax_rates: Number(row.tax_rates || 0),
        registers: Number(row.registers || 0),
    };
}

async function localCompletenessCounts(localDb: any): Promise<RemoteCompletenessCounts> {
    const rows: any[] = await localDb.select(
        `SELECT (SELECT COUNT(*) FROM products) AS products,
                (SELECT COUNT(*) FROM categories) AS categories,
                (SELECT COUNT(*) FROM customers) AS customers,
                (SELECT COUNT(*) FROM tax_rates) AS tax_rates,
                (SELECT COUNT(*) FROM registers) AS registers`
    );
    return normalizeRemoteCompletenessCounts(rows[0] || {});
}

async function remoteCompletenessCounts(remote: any): Promise<RemoteCompletenessCounts> {
    const rows: any[] = await remote.select(
        `SELECT (SELECT COUNT(*) FROM products) AS products,
                (SELECT COUNT(*) FROM categories) AS categories,
                (SELECT COUNT(*) FROM customers) AS customers,
                (SELECT COUNT(*) FROM tax_rates) AS tax_rates,
                (SELECT COUNT(*) FROM registers) AS registers`
    );
    return normalizeRemoteCompletenessCounts(rows[0] || {});
}

function formatCompletenessIssue(
    table: RemoteCompletenessTable,
    localCounts: RemoteCompletenessCounts,
    remoteCounts: RemoteCompletenessCounts,
): string {
    return `${table}: SQLite ${localCounts[table].toLocaleString()}, MariaDB ${remoteCounts[table].toLocaleString()}`;
}

async function assertMariaDbSafeForPull(remote: any): Promise<void> {
    if (!remote) throw new Error('MariaDB is unavailable');
    const localDb = await sqlite.getDb();
    const localCounts = await localCompletenessCounts(localDb);
    const remoteCounts = await remoteCompletenessCounts(remote);
    const localHasData = REMOTE_COMPLETENESS_CORE_TABLES.some(table => localCounts[table] > 0);
    const remoteHasData = REMOTE_COMPLETENESS_CORE_TABLES.some(table => remoteCounts[table] > 0);
    if (!localHasData || !remoteHasData) return;

    const missingCriticalTables = REMOTE_COMPLETENESS_CORE_TABLES.filter((table) =>
        localCounts[table] > 0 && remoteCounts[table] === 0
    );
    const remoteHasFewerProducts = localCounts.products > 0
        && remoteCounts.products > 0
        && remoteCounts.products < localCounts.products;
    const looksLikePartialUpload = localCounts.products > 0
        && remoteCounts.products > 0
        && missingCriticalTables.length > 0;

    if (!looksLikePartialUpload) return;

    const details = [
        ...(remoteHasFewerProducts ? [formatCompletenessIssue('products', localCounts, remoteCounts)] : []),
        ...missingCriticalTables.map(table => formatCompletenessIssue(table, localCounts, remoteCounts)),
    ];
    throw new Error(
        `MariaDB appears incomplete, so sync was stopped before downloading from it. ` +
        `${details.join('; ')}. Finish Restore to MariaDB or use Force Push from the complete till before syncing.`
    );
}

async function addRestoreIssueForCount(
    localDb: any,
    issues: string[],
    label: string,
    sql: string,
): Promise<void> {
    const count = await localCount(localDb, sql);
    if (count > 0) issues.push(`${label}: ${count.toLocaleString()} row${count === 1 ? '' : 's'}`);
}

async function validateLocalDataForRestore(localDb: any): Promise<void> {
    const issues: string[] = [];

    await addRestoreIssueForCount(
        localDb,
        issues,
        'Products with missing id or name',
        `SELECT COUNT(*) AS count FROM products
         WHERE id IS NULL OR TRIM(id) = '' OR name IS NULL OR TRIM(name) = ''`,
    );
    await addRestoreIssueForCount(
        localDb,
        issues,
        'Products with impossible prices',
        `SELECT COUNT(*) AS count FROM products
         WHERE price IS NULL
            OR price < 0
            OR COALESCE(costPrice, 0) < 0
            OR price > ${RESTORE_PRODUCT_PRICE_LIMIT}
            OR COALESCE(costPrice, 0) > ${RESTORE_PRODUCT_PRICE_LIMIT}`,
    );

    for (const column of ['barcode', 'sku', 'scalePlu']) {
        if (!await localTableHasColumn(localDb, 'products', column)) continue;
        await addRestoreIssueForCount(
            localDb,
            issues,
            `Duplicate product ${column} values`,
            `SELECT COUNT(*) AS count FROM (
                SELECT ${column}
                FROM products
                WHERE ${column} IS NOT NULL AND TRIM(${column}) <> ''
                GROUP BY ${column}
                HAVING COUNT(*) > 1
            ) duplicate_values`,
        );
    }

    const orphanChecks = [
        {
            label: 'POS tiles pointing to missing products',
            tables: ['pos_tiles', 'products'],
            sql: `SELECT COUNT(*) AS count
                  FROM pos_tiles t LEFT JOIN products p ON p.id = t.productId
                  WHERE p.id IS NULL`,
        },
        {
            label: 'POS tiles pointing to missing pages',
            tables: ['pos_tiles', 'pos_pages'],
            sql: `SELECT COUNT(*) AS count
                  FROM pos_tiles t LEFT JOIN pos_pages p ON p.id = t.pageId
                  WHERE p.id IS NULL`,
        },
        {
            label: 'Promotion items pointing to missing products',
            tables: ['promo_group_items', 'products'],
            sql: `SELECT COUNT(*) AS count
                  FROM promo_group_items i LEFT JOIN products p ON p.id = i.productId
                  WHERE p.id IS NULL`,
        },
        {
            label: 'Promotion items pointing to missing groups',
            tables: ['promo_group_items', 'promo_groups'],
            sql: `SELECT COUNT(*) AS count
                  FROM promo_group_items i LEFT JOIN promo_groups g ON g.id = i.groupId
                  WHERE g.id IS NULL`,
        },
        {
            label: 'Order lines pointing to missing orders',
            tables: ['order_lines', 'orders'],
            sql: `SELECT COUNT(*) AS count
                  FROM order_lines l LEFT JOIN orders o ON o.id = l.orderId
                  WHERE o.id IS NULL`,
        },
        {
            label: 'Payments pointing to missing orders',
            tables: ['payments', 'orders'],
            sql: `SELECT COUNT(*) AS count
                  FROM payments p LEFT JOIN orders o ON o.id = p.orderId
                  WHERE o.id IS NULL`,
        },
    ];

    for (const check of orphanChecks) {
        const hasTables = await Promise.all(check.tables.map((table) => localTableExists(localDb, table)));
        if (hasTables.every(Boolean)) {
            await addRestoreIssueForCount(localDb, issues, check.label, check.sql);
        }
    }

    if (issues.length > 0) {
        const preview = issues.slice(0, 10).join('; ');
        const suffix = issues.length > 10 ? `; and ${issues.length - 10} more issue(s)` : '';
        throw new Error(`Restore data check failed: ${preview}${suffix}`);
    }
}

async function verifyPushedTableCounts(
    localDb: any,
    options: { skipTables?: Set<string>; exact?: boolean; label?: string } = {},
): Promise<void> {
    const remote = await getMysqlDb();
    if (!remote) throw new Error('MariaDB is unavailable after upload');
    const mismatches: string[] = [];

    for (const table of PUSH_TABLES) {
        if (options.skipTables?.has(table) || COUNT_VERIFY_SKIP_TABLES.has(table)) continue;
        if (!await localTableExists(localDb, table)) continue;

        const localRows: any[] = await localDb.select(`SELECT COUNT(*) AS count FROM ${table}`);
        const remoteRows: any[] = await remote.select(`SELECT COUNT(*) AS count FROM ${table}`);
        const localRowsCount = Number(localRows[0]?.count || 0);
        const remoteRowsCount = Number(remoteRows[0]?.count || 0);
        const failed = options.exact
            ? remoteRowsCount !== localRowsCount
            : remoteRowsCount < localRowsCount;
        if (failed) {
            mismatches.push(`${table}: SQLite ${localRowsCount.toLocaleString()}, MariaDB ${remoteRowsCount.toLocaleString()}`);
        }
    }

    if (mismatches.length > 0) {
        const title = options.label || 'MariaDB upload verification';
        const preview = mismatches.slice(0, 12).join('; ');
        const suffix = mismatches.length > 12 ? `; and ${mismatches.length - 12} more table(s)` : '';
        throw new Error(`${title} failed: ${preview}${suffix}`);
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
        await validateLocalDataForRestore(localDb);
        await forcePushTables(localDb);
        await verifyProductUploadCount(localDb);
        await verifyPushedTableCounts(localDb, { exact: true, label: 'Initial MariaDB upload verification' });
        await publishServerDataEpoch(localDb);

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
    const auditBefore = await getAuditBefore(table, obj, idKey);
    // Always write to local SQLite (either primary or cache)
    await sqlite.upsert(table, obj, idKey);
    if (shouldAuditTableMutation(table, obj)) {
        const auditAfter = await getLocalRow(table, idKey, obj?.[idKey]);
        await recordTableAudit(table, auditBefore ? 'updated' : 'created', idKey, auditBefore, auditAfter || obj);
    }

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

    await pushWriteInBackground(
        `upsert for ${table}`,
        () => mysql.mysqlUpsert(table, obj, idKey),
        () => queueOffline(table, 'upsert', obj, idKey),
    );
}

export async function remove(table: string, id: string, idKey: string = 'id'): Promise<void> {
    const auditBefore = AUDITED_TABLES.has(table) ? await getLocalRow(table, idKey, id) : null;
    await sqlite.remove(table, id, idKey);
    if (auditBefore && shouldAuditTableMutation(table, auditBefore)) {
        await recordTableAudit(table, 'deleted', idKey, auditBefore, null);
    }

    if (PROMOTION_SYNC_TABLE_SET.has(table)) {
        await hydrateSvelteStores([table]);
        await writeOrQueueImmediately(
            `promotion remove for ${table}`,
            () => mysql.mysqlRemove(table, id, idKey),
            () => queueOffline(table, 'remove', { id }, idKey),
        );
    } else {
        await pushWriteInBackground(
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

const EMPLOYEE_HISTORY_SQL = `
    SELECT CASE WHEN
        EXISTS (SELECT 1 FROM orders WHERE employeeId = ? LIMIT 1)
        OR EXISTS (SELECT 1 FROM shifts WHERE employeeId = ? OR closedByEmployeeId = ? LIMIT 1)
        OR EXISTS (SELECT 1 FROM audit_logs WHERE employeeId = ? LIMIT 1)
        OR EXISTS (
            SELECT 1 FROM manager_approvals
            WHERE requestedByEmployeeId = ? OR approvedByEmployeeId = ? LIMIT 1
        )
        OR EXISTS (SELECT 1 FROM stock_receipts WHERE employeeId = ? LIMIT 1)
        OR EXISTS (SELECT 1 FROM till_report_markers WHERE employeeId = ? LIMIT 1)
    THEN 1 ELSE 0 END AS hasHistory
`;

/** Protect reports and audit trails before permanently removing a staff record. */
export async function employeeHasLinkedHistory(employeeId: string): Promise<boolean> {
    const params = Array(8).fill(employeeId);
    const localDb = await sqlite.getDb();
    const localRows: any[] = await localDb.select(EMPLOYEE_HISTORY_SQL, params);
    if (Number(localRows[0]?.hasHistory || 0) === 1) return true;
    if (!isMultiMode()) return false;

    const remoteDb = await withTimeout(
        getMysqlDb(),
        2_000,
        'Timed out while checking staff history on MariaDB',
    );
    if (!remoteDb) throw new Error('MariaDB is unavailable, so staff history cannot be verified');
    const remoteRows: any[] = await withTimeout(
        remoteDb.select(EMPLOYEE_HISTORY_SQL, params),
        2_000,
        'Timed out while checking staff history on MariaDB',
    );
    return Number(remoteRows[0]?.hasHistory || 0) === 1;
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

async function getPromotionAuditSnapshot(discountId = '', groupId = ''): Promise<any> {
    const d = await sqlite.getDb();
    const groupRows: any[] = groupId
        ? await d.select(`SELECT * FROM promo_groups WHERE id = ? LIMIT 1`, [groupId])
        : [];
    const discountRows: any[] = groupId
        ? await d.select(`SELECT * FROM discounts WHERE id = ? OR groupId = ? ORDER BY id`, [discountId, groupId])
        : discountId
            ? await d.select(`SELECT * FROM discounts WHERE id = ? ORDER BY id`, [discountId])
            : [];
    const itemRows: any[] = groupId
        ? await d.select(`SELECT * FROM promo_group_items WHERE groupId = ? ORDER BY productId, id`, [groupId])
        : [];
    return {
        group: groupRows[0] || null,
        discounts: discountRows,
        items: itemRows,
    };
}

export async function savePromotionBundle(group: any, discount: any, items: any[]): Promise<void> {
    const before = await getPromotionAuditSnapshot(discount?.id || '', group?.id || '');
    await saveLocalPromotionBundle(group, discount, items);
    const after = await getPromotionAuditSnapshot(discount?.id || '', group?.id || '');
    await recordAuditEvent(
        before.group || before.discounts.length ? 'promotion_updated' : 'promotion_created',
        'promotion',
        group?.id || discount?.id || '',
        before,
        after,
    );
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
    const before = await getPromotionAuditSnapshot(discountId, groupId);

    await deleteLocalPromotionBundle(discountIds, groupId);
    await recordAuditEvent(
        'promotion_deleted',
        'promotion',
        groupId || discountId,
        before,
        null,
    );

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

function promotionStamp(...values: unknown[]): string {
    return values
        .map(value => String(value || ''))
        .filter(Boolean)
        .sort()
        .at(-1) || '';
}

function productSetSignature(rows: any[]): string {
    return Array.from(new Set(rows.map(row => String(row?.productId || '')).filter(Boolean)))
        .sort()
        .join('|');
}

async function pushNewerLocalPromotionPackages(): Promise<number> {
    if (!isMultiMode()) return 0;
    if (await pendingPromotionQueueCount() > 0) return 0;

    const mysqlDb = await getMysqlDb();
    if (!mysqlDb) return 0;

    const local = await sqlite.getDb();
    const discounts: any[] = await local.select(
        `SELECT * FROM discounts
         WHERE kind IN ('bundle_fixed_price', 'bogo_fixed_price', 'temporary_item')
           AND COALESCE(groupId, '') <> ''`
    );

    let pushed = 0;
    for (const discount of discounts) {
        const groupId = discount.groupId;
        const groupRows: any[] = await local.select(`SELECT * FROM promo_groups WHERE id = ? LIMIT 1`, [groupId]);
        const group = groupRows[0];
        if (!group) continue;

        const items: any[] = await local.select(`SELECT * FROM promo_group_items WHERE groupId = ?`, [groupId]);
        const products = await getLocalProductsForPromotionItems(items);
        const refs: PromotionDeleteRefs = {
            groupId,
            discountIds: [discount.id].filter(Boolean),
            itemIds: items.map(item => item.id).filter(Boolean),
        };
        if (await remoteHasPromotionDelete(mysqlDb, refs)) {
            await deleteLocalPromotionBundle(refs.discountIds, groupId);
            pushed++;
            continue;
        }

        const [remoteDiscounts, remoteGroups, remoteItems] = await Promise.all([
            mysqlDb.select(`SELECT * FROM discounts WHERE id = ? OR groupId = ?`, [discount.id, groupId]) as Promise<any[]>,
            mysqlDb.select(`SELECT * FROM promo_groups WHERE id = ?`, [groupId]) as Promise<any[]>,
            mysqlDb.select(`SELECT * FROM promo_group_items WHERE groupId = ?`, [groupId]) as Promise<any[]>,
        ]);

        const localStamp = promotionStamp(
            discount.updatedAt,
            group.updatedAt,
            ...items.map(item => item.updatedAt),
        );
        const remoteStamp = promotionStamp(
            ...remoteDiscounts.map(row => row.updatedAt),
            ...remoteGroups.map(row => row.updatedAt),
            ...remoteItems.map(row => row.updatedAt),
        );
        const localProducts = productSetSignature(items);
        const remoteProducts = productSetSignature(remoteItems);
        const remoteMissingPackage = remoteDiscounts.length === 0 || remoteGroups.length === 0;
        const localLooksNewer = localStamp && (!remoteStamp || localStamp > remoteStamp);
        const sameOrNewerDifferentItems = localProducts !== remoteProducts && (!remoteStamp || !localStamp || localStamp >= remoteStamp);

        if (remoteMissingPackage || localLooksNewer || sameOrNewerDifferentItems) {
            await mysql.mysqlSavePromotionBundle(group, discount, items, products);
            pushed++;
        }
    }

    if (pushed > 0) console.log(`database: repaired ${pushed} local promotion package(s) to MariaDB`);
    return pushed;
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

/** Create a shop-wide setting once and return the shared MariaDB value. */
export async function ensureSharedSettingValue(key: string, candidate: string): Promise<string> {
    const stamp = new Date().toISOString();
    if (isMultiMode()) {
        try {
            const mysqlDb = await getMysqlDb();
            if (mysqlDb) {
                await mysqlDb.execute(
                    `INSERT INTO settings (\`key\`, value, updatedAt)
                     VALUES (?, ?, ?)
                     ON DUPLICATE KEY UPDATE \`key\` = VALUES(\`key\`)`,
                    [key, candidate, stamp],
                );
                const remoteRows: any[] = await mysqlDb.select(
                    'SELECT value, updatedAt FROM settings WHERE `key` = ? LIMIT 1',
                    [key],
                );
                const value = String(remoteRows[0]?.value || candidate);
                await sqlite.upsert('settings', {
                    key,
                    value,
                    updatedAt: String(remoteRows[0]?.updatedAt || stamp),
                }, 'key');
                return value;
            }
        } catch (error) {
            console.warn(`database: could not create shared setting ${key}, using local cache:`, error);
        }
    }

    const localDb = await sqlite.getDb();
    const existing: any[] = await localDb.select(
        'SELECT value FROM settings WHERE key = ? LIMIT 1',
        [key],
    );
    if (existing[0]?.value) return String(existing[0].value);
    await sqlite.upsert('settings', { key, value: candidate, updatedAt: stamp }, 'key');
    return candidate;
}

export interface CustomerUsage {
    orders: number;
    loyaltyEntries: number;
}

export interface CustomerLoyaltyHistoryRow {
    id: string;
    orderId: string;
    orderNumber: number | null;
    pointsChange: number;
    reason: string;
    createdAt: string;
}

export async function isCustomerLoyaltyCodeInUse(
    loyaltyCode: string,
    excludeCustomerId = '',
): Promise<boolean> {
    const normalized = loyaltyCode.trim().toUpperCase();
    if (!normalized) return false;
    const d = await sqlite.getDb();
    const rows: any[] = await d.select(
        `SELECT 1
         FROM customers
         WHERE loyaltyCode = ? COLLATE NOCASE
           AND id <> ?
         LIMIT 1`,
        [normalized, excludeCustomerId],
    );
    return rows.length > 0;
}

export async function getCustomerUsage(customerId: string): Promise<CustomerUsage> {
    const d = await sqlite.getDb();
    const rows: any[] = await d.select(
        `SELECT
            (SELECT COUNT(*) FROM orders WHERE customerId = ?) AS orders,
            (SELECT COUNT(*) FROM loyalty_logs WHERE customerId = ?) AS loyaltyEntries`,
        [customerId, customerId],
    );
    return {
        orders: Number(rows[0]?.orders || 0),
        loyaltyEntries: Number(rows[0]?.loyaltyEntries || 0),
    };
}

export async function getCustomerLoyaltyHistory(
    customerId: string,
    limit = 50,
): Promise<CustomerLoyaltyHistoryRow[]> {
    const d = await sqlite.getDb();
    const rows: any[] = await d.select(
        `SELECT l.id, l.orderId, o.orderNumber, l.pointsChange, l.reason, l.createdAt
         FROM loyalty_logs l
         LEFT JOIN orders o ON o.id = l.orderId
         WHERE l.customerId = ?
         ORDER BY COALESCE(l.createdAt, '') DESC, l.id DESC
         LIMIT ?`,
        [customerId, Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)))],
    );
    return rows.map((row) => ({
        id: String(row.id || ''),
        orderId: String(row.orderId || ''),
        orderNumber: row.orderNumber === null || row.orderNumber === undefined
            ? null
            : Number(row.orderNumber),
        pointsChange: Number(row.pointsChange || 0),
        reason: String(row.reason || ''),
        createdAt: String(row.createdAt || ''),
    }));
}

export interface AuditLogPage {
    rows: any[];
    total: number;
    actions: string[];
    entities: string[];
}

export async function getAuditLogPage(options: {
    query?: string;
    action?: string;
    entityType?: string;
    limit?: number;
    offset?: number;
} = {}): Promise<AuditLogPage> {
    const d = await sqlite.getDb();
    const limit = Math.max(1, Math.min(100, Number(options.limit || 25)));
    const offset = Math.max(0, Number(options.offset || 0));
    const where: string[] = [];
    const params: any[] = [];

    if (options.action) {
        where.push(`a.action = ?`);
        params.push(options.action);
    }
    if (options.entityType) {
        where.push(`a.entityType = ?`);
        params.push(options.entityType);
    }
    const search = String(options.query || '').trim().toLowerCase();
    if (search) {
        where.push(`(
            LOWER(COALESCE(a.action, '')) LIKE ?
            OR LOWER(COALESCE(a.entityType, '')) LIKE ?
            OR LOWER(COALESCE(a.entityId, '')) LIKE ?
            OR LOWER(COALESCE(a.oldData, '')) LIKE ?
            OR LOWER(COALESCE(a.newData, '')) LIKE ?
            OR LOWER(COALESCE(e.name, '')) LIKE ?
        )`);
        const like = `%${search}%`;
        params.push(like, like, like, like, like, like);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows: any[] = await d.select(
        `SELECT a.*
         FROM audit_logs a
         LEFT JOIN employees e ON e.id = a.employeeId
         ${whereSql}
         ORDER BY a.createdAt DESC, a.id ASC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset],
    );
    const countRows: any[] = await d.select(
        `SELECT COUNT(*) AS count
         FROM audit_logs a
         LEFT JOIN employees e ON e.id = a.employeeId
         ${whereSql}`,
        params,
    );
    const [actionRows, entityRows] = await Promise.all([
        d.select(`SELECT DISTINCT action FROM audit_logs WHERE action IS NOT NULL AND action != '' ORDER BY action`) as Promise<any[]>,
        d.select(`SELECT DISTINCT entityType FROM audit_logs WHERE entityType IS NOT NULL AND entityType != '' ORDER BY entityType`) as Promise<any[]>,
    ]);
    return {
        rows,
        total: Number(countRows[0]?.count || 0),
        actions: actionRows.map(row => String(row.action || '')).filter(Boolean),
        entities: entityRows.map(row => String(row.entityType || '')).filter(Boolean),
    };
}

export async function getRecentManagerApprovals(limit = 25): Promise<any[]> {
    const d = await sqlite.getDb();
    return d.select(
        `SELECT *
         FROM manager_approvals
         ORDER BY createdAt DESC, id ASC
         LIMIT ?`,
        [Math.max(1, Math.min(100, Number(limit || 25)))],
    );
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

const PRODUCT_BOOL_KEYS = ['isActive', 'isWeighable', 'showInGoods', 'trackStock'];

function hydrateProducts(rows: any[]): any[] {
    return rows.map((row) => sqlite.rehydrateBooleans(row, PRODUCT_BOOL_KEYS));
}

export async function getProductsPage(options: sqlite.ProductPageOptions = {}): Promise<sqlite.ProductPageResult> {
    if (!isTauri()) {
        const query = String(options.query || '').trim().toLowerCase();
        const status = options.status || 'active';
        const limit = Math.max(1, Math.min(100, Number(options.limit || 50)));
        const offset = Math.max(0, Number(options.offset || 0));
        const rows = get(productsDB)
            .filter((product) => status === 'all' || (status === 'active' ? product.isActive : !product.isActive))
            .filter((product) => !options.weighableOnly || product.isWeighable)
            .filter((product) => !options.categoryId || options.categoryId === 'all' || product.categoryId === options.categoryId)
            .filter((product) => !query || [product.name, product.sku, product.barcode, product.scalePlu]
                .some((value) => String(value || '').toLowerCase().includes(query)))
            .sort((a, b) => a.name.localeCompare(b.name));
        return {
            rows: rows.slice(offset, offset + limit),
            total: rows.length,
            totalIsCapped: false,
        };
    }
    const result = await sqlite.getProductsPage(options);
    return {
        rows: hydrateProducts(result.rows),
        total: result.total,
        totalIsCapped: result.totalIsCapped,
    };
}

export async function getProductsByIds(ids: string[], activeOnly = true, compact = false): Promise<any[]> {
    if (!isTauri()) {
        const wanted = new Set(ids.map((id) => String(id || '').trim()).filter(Boolean));
        return get(productsDB).filter((product) => wanted.has(product.id) && (!activeOnly || product.isActive));
    }
    return hydrateProducts(await sqlite.getProductsByIds(ids, activeOnly, compact));
}

export const getCategoryUsageSummary = sqlite.getCategoryUsageSummary;

export async function getOrdersPage(options: sqlite.OrderPageOptions = {}): Promise<sqlite.OrderPageResult> {
    const result = await sqlite.getOrdersPage(options);
    return {
        ...result,
        lines: result.lines.map((line) => sqlite.rehydrateBooleans(line, ['isPriceOverride'])),
    };
}

export const getShiftsPage = sqlite.getShiftsPage;
export const getShiftSummary = sqlite.getShiftSummary;

function hydrateOrderLines(rows: any[]): any[] {
    return rows.map((line) => sqlite.rehydrateBooleans(line, ['isPriceOverride']));
}

export async function getPosHeldOrders(tillNumber = '', limit = 100): Promise<sqlite.PosHeldOrdersResult> {
    const result = await sqlite.getPosHeldOrders(tillNumber, limit);
    return {
        ...result,
        lines: hydrateOrderLines(result.lines),
    };
}

/**
 * Claim a shared held order before restoring it into a trolley. MariaDB's
 * conditional delete is atomic and its delete trigger publishes a tombstone.
 */
export async function claimHeldOrder(orderId: string): Promise<boolean> {
    if (!isMultiMode()) return true;
    if (!get(connectionState).mysqlOnline) {
        throw new Error('The main database must be online to retrieve a shared held order');
    }
    await flushOfflineQueue();
    return mysql.mysqlClaimHeldOrder(orderId);
}

export async function getPosRecentReceipts(limit = 10): Promise<sqlite.PosRecentReceiptsResult> {
    const result = await sqlite.getPosRecentReceipts(limit);
    return {
        ...result,
        lines: hydrateOrderLines(result.lines),
    };
}

export async function getLatestTillReceipt(tillNumber: string): Promise<any | null> {
    return sqlite.getLatestTillReceipt(tillNumber);
}

export async function getOrderDetails(orderId: string): Promise<sqlite.OrderDetailsResult> {
    const result = await sqlite.getOrderDetails(orderId);
    return {
        ...result,
        lines: hydrateOrderLines(result.lines),
    };
}

export async function getOrderReversalContext(orderId: string): Promise<sqlite.OrderReversalContext> {
    const result = await sqlite.getOrderReversalContext(orderId);
    return {
        ...result,
        originalLines: hydrateOrderLines(result.originalLines),
    };
}

export async function getGoodsMenuCount(): Promise<number> {
    return sqlite.getGoodsMenuCount();
}

export async function getGoodsMenuEditorProducts(query = '', limit = 100): Promise<sqlite.GoodsMenuEditorResult> {
    const result = await sqlite.getGoodsMenuEditorProducts(query, limit);
    return {
        selected: hydrateProducts(result.selected),
        available: hydrateProducts(result.available),
        totalAvailable: result.totalAvailable,
    };
}

export async function findNextAvailableScalePlu(length: number, excludeId = ''): Promise<string | null> {
    return sqlite.findNextAvailableScalePlu(length, excludeId);
}

export async function getProductImage(productId: string): Promise<string> {
    return sqlite.getProductImage(productId);
}

// ─── Product Helpers ────────────────────────────────────────────────────────

export async function addProduct(p: any): Promise<void> {
    const hasImage = Object.prototype.hasOwnProperty.call(p, 'image');
    const image = hasImage ? String(p.image || '') : '';
    p = { ...p };
    delete p.image;
    p = await prepareProductGoodsMenuWrite(normalizeProductIdentifiers(p));
    await sqlite.assertProductIdentifiersUnique(p);
    try {
        await sqlite.addProduct(p);
        if (hasImage) await sqlite.upsertProductImage(p.id, image, p.updatedAt || new Date().toISOString());
    } catch (e) {
        if (isProductIdentifierConflict(e)) throw friendlyProductIdentifierError(e);
        throw e;
    }
    if (isMultiMode()) {
        await queueLocalProductSnapshot(p.id, p);
        if (hasImage) {
            await queueOffline('product_images', 'upsert', {
                id: p.id,
                image,
                updatedAt: p.updatedAt || new Date().toISOString(),
            });
        }
        void flushOfflineQueue().catch((e) => console.warn('database: product add outbox flush failed:', e));
    }
}

export async function updateProduct(p: any): Promise<void> {
    const hasImage = Object.prototype.hasOwnProperty.call(p, 'image');
    const image = hasImage ? String(p.image || '') : '';
    p = { ...p };
    delete p.image;
    p = await prepareProductGoodsMenuWrite(normalizeProductIdentifiers(p));
    await sqlite.assertProductIdentifiersUnique(p);
    try {
        await sqlite.updateProduct(p);
        if (hasImage) await sqlite.upsertProductImage(p.id, image, p.updatedAt || new Date().toISOString());
    } catch (e) {
        if (isProductIdentifierConflict(e)) throw friendlyProductIdentifierError(e);
        throw e;
    }
    if (isMultiMode()) {
        await queueLocalProductSnapshot(p.id, p);
        if (hasImage) {
            await queueOffline('product_images', 'upsert', {
                id: p.id,
                image,
                updatedAt: p.updatedAt || new Date().toISOString(),
            });
        }
        void flushOfflineQueue().catch((e) => console.warn('database: product update outbox flush failed:', e));
    }
}

export async function updateProductFields(
    patch: Record<string, any>,
    expected?: Record<string, any>,
): Promise<void> {
    const hasImageField = Object.prototype.hasOwnProperty.call(patch, 'image');
    const image = hasImageField ? String(patch.image || '') : '';
    const hasImage = hasImageField && (!expected || image !== String(expected.image || ''));
    patch = { ...patch };
    delete patch.image;
    const stamped = await prepareProductGoodsMenuWrite(
        normalizeProductIdentifiers({ ...patch, updatedAt: new Date().toISOString() }),
    );
    await sqlite.assertProductIdentifiersUnique(stamped);
    try {
        await sqlite.updateProductFields(stamped);
        if (hasImage) await sqlite.upsertProductImage(stamped.id, image, stamped.updatedAt);
        patchProductInStore({ ...stamped, ...(hasImage ? { image } : {}) });
        if (isMultiMode()) {
            await queueLocalProductSnapshot(stamped.id, stamped);
            if (hasImage) {
                await queueOffline('product_images', 'upsert', {
                    id: stamped.id,
                    image,
                    updatedAt: stamped.updatedAt,
                });
            }
            void flushOfflineQueue().catch((e) => console.warn('database: product field outbox flush failed:', e));
        }
    } catch (e) {
        if (isProductIdentifierConflict(e)) throw friendlyProductIdentifierError(e);
        throw e;
    }
}

async function prepareProductGoodsMenuWrite(product: any): Promise<any> {
    if (!Object.prototype.hasOwnProperty.call(product, 'showInGoods')) return product;
    if (!product.showInGoods || product.isActive === false || product.isActive === 0) {
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
    const before = await getLocalRow('products', 'id', productId);
    await sqlite.adjustStock(productId, delta);
    const after = await getLocalRow('products', 'id', productId);
    await recordAuditEvent(
        'stock_adjusted',
        'product',
        productId,
        before ? { id: before.id, name: before.name, stockLevel: before.stockLevel } : null,
        after ? { id: after.id, name: after.name, stockLevel: after.stockLevel, delta } : { delta },
    );
    await pushWriteInBackground(
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
    const before = await getLocalRow('products', 'id', productId);
    await sqlite.setStockLevel(productId, stockLevel);
    const after = await getLocalRow('products', 'id', productId);
    await recordAuditEvent(
        'stock_counted',
        'product',
        productId,
        before ? { id: before.id, name: before.name, stockLevel: before.stockLevel } : null,
        after ? { id: after.id, name: after.name, stockLevel: after.stockLevel, expectedStockLevel } : { stockLevel, expectedStockLevel },
    );
    await pushWriteInBackground(
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
        if (!state.mysqlOnline) {
            throw new Error('Refunds and voids require the main MariaDB database to be online');
        }
        if (state.mysqlOnline) {
            if (!state.mysqlConfig) throw new Error('MariaDB configuration is unavailable');
            try {
                const pendingBeforeReversal = await pendingReportWriteCount();
                if (pendingBeforeReversal > 0) await flushOfflineQueue();
                if (await pendingReportWriteCount() > 0) {
                    throw new Error('Pending sales or report closes must synchronize before a refund or void');
                }
                const committed = await invoke<CommitSaleResult>('commit_online_reversal', {
                    mysqlUri: buildMysqlUri(state.mysqlConfig),
                    bundle,
                });
                notifyOwnerCloudDataChanged();
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
        await queueOffline('sale_bundle', 'saleBundle', bundle);
        void flushOfflineQueue()
            .catch((e) => {
                console.warn('database: sale outbox flush failed:', e);
                connectionState.update(s => ({ ...s, mysqlOnline: false, syncError: String(e) }));
            });
    }
    notifyOwnerCloudDataChanged();
    return bundle;
}

export async function deleteProduct(id: string): Promise<void> {
    const before = await getLocalRow('products', 'id', id);
    await sqlite.deleteProduct(id);
    const after = await getLocalRow('products', 'id', id);
    await recordAuditEvent('product_deactivated', 'product', id, before, after);
    await pushWriteInBackground(
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
    await recordAuditEvent(
        'products_imported',
        'product',
        'bulk_import',
        null,
        {
            count: products.length,
            sample: products.slice(0, 10).map(product => ({
                id: product.id,
                name: product.name,
                barcode: product.barcode,
                sku: product.sku,
                price: product.price,
            })),
        },
    );
    await pushWriteInBackground(
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
    const before = await getLocalRow('pos_pages', 'id', stamped.id);
    await sqlite.savePosPage(stamped);
    const after = await getLocalRow('pos_pages', 'id', stamped.id);
    await recordTableAudit('pos_pages', before ? 'updated' : 'created', 'id', before, after || stamped);
    await pushWriteInBackground(
        'POS page save',
        () => mysql.mysqlSavePosPage(stamped),
        () => queueOffline('pos_pages', 'upsert', stamped),
    );
}

export async function deletePosPage(id: string): Promise<void> {
    const before = await getLocalRow('pos_pages', 'id', id);
    await sqlite.deletePosPage(id);
    await recordTableAudit('pos_pages', 'deleted', 'id', before, null);
    await pushWriteInBackground(
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
    const before = await getLocalRow('pos_tiles', 'id', stamped.id);
    await sqlite.addTile(stamped);
    const after = await getLocalRow('pos_tiles', 'id', stamped.id);
    await recordTableAudit('pos_tiles', before ? 'updated' : 'created', 'id', before, after || stamped);
    await pushWriteInBackground(
        'POS tile save',
        () => mysql.mysqlAddTile(stamped),
        () => queueOffline('pos_tiles', 'upsert', stamped),
    );
}

export async function deleteTile(id: string): Promise<void> {
    const before = await getLocalRow('pos_tiles', 'id', id);
    await sqlite.deleteTile(id);
    await recordTableAudit('pos_tiles', 'deleted', 'id', before, null);
    await pushWriteInBackground(
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
        await queueOffline('products', 'limitGoodsMenuItems', {});
        void flushOfflineQueue().catch((e) => console.warn('database: goods menu limit outbox flush failed:', e));
    }
}

export async function batchUpdateGoodsMenu(
    changes: { id: string; showInGoods: boolean; goodsSortOrder: number; updatedAt: string }[]
): Promise<void> {
    await sqlite.batchUpdateGoodsMenu(changes);
    await pushWriteInBackground(
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
        const [allTillsOverviewBefore, overviewBefore, breakdownBefore, businessBefore] = await Promise.all([
            tillNumber ? mysql.mysqlGetSalesOverview(startDate, endDate) : Promise.resolve(null),
            mysql.mysqlGetSalesOverview(startDate, endDate, tillNumber),
            mysql.mysqlGetPaymentBreakdown(startDate, endDate, tillNumber),
            mysql.mysqlGetBusinessSummary(startDate, endDate, tillNumber),
        ]);
        const [topProducts, tillOptions, tillSummaries, dailyTrend, employeeSales] = await Promise.all([
            mysql.mysqlGetTopProducts(startDate, endDate, sortBy, limit, tillNumber),
            mysql.mysqlGetTillReportOptions(),
            mysql.mysqlGetTillSalesSummaries(startDate, endDate),
            mysql.mysqlGetDailySalesTrend(startDate, endDate, tillNumber),
            mysql.mysqlGetEmployeeSalesSummaries(startDate, endDate, tillNumber),
        ]);
        const [overviewAfter, breakdownAfter, businessAfter, allTillsOverviewAfter] = await Promise.all([
            mysql.mysqlGetSalesOverview(startDate, endDate, tillNumber),
            mysql.mysqlGetPaymentBreakdown(startDate, endDate, tillNumber),
            mysql.mysqlGetBusinessSummary(startDate, endDate, tillNumber),
            tillNumber ? mysql.mysqlGetSalesOverview(startDate, endDate) : Promise.resolve(null),
        ]);
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
            OR table_name IN ('orders','order_lines','payments','till_report_markers')`,
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
            const pendingBeforeFlush = await pendingReportWriteCount();
            if (pendingBeforeFlush > 0) {
                await withTimeout(
                    flushOfflineQueue(),
                    2_500,
                    'Pending transaction sync did not finish in time',
                );
            }
            const pendingWrites = await pendingReportWriteCount();
            if (pendingWrites > 0) {
                const local = await getSqliteReportSnapshot(startDate, endDate, sortBy, limit, tillNumber);
                return {
                    ...local,
                    warning: `${pendingWrites} local transaction update${pendingWrites === 1 ? ' is' : 's are'} waiting to sync, so this report is showing the local SQLite cache.`,
                };
            }
            const mysqlDb = await withTimeout(
                getMysqlDb(),
                2_500,
                'MariaDB report connection timed out',
            );
            if (mysqlDb) {
                const remote = await withTimeout(
                    getMysqlReportSnapshot(startDate, endDate, sortBy, limit, tillNumber),
                    10_000,
                    'MariaDB report queries timed out',
                );
                const missingOrders = await withTimeout(
                    missingRemoteReportOrderCount(startDate, endDate, tillNumber),
                    3_000,
                    'MariaDB report consistency check timed out',
                );
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
    const localMarker = await sqlite.getLastReportMarker(tillNumber);
    if (isMultiMode()) {
        try {
            const pendingBeforeFlush = await pendingReportWriteCount();
            if (pendingBeforeFlush > 0) await flushOfflineQueue();
            const mysqlDb = await getMysqlDb();
            if (mysqlDb) {
                const remoteMarker = await mysql.mysqlGetLastReportMarker(tillNumber);
                if (!localMarker) return remoteMarker;
                if (!remoteMarker) return localMarker;
                return remoteMarker > localMarker ? remoteMarker : localMarker;
            }
        } catch (e) {
            console.warn('database: live report marker failed, using local SQLite:', e);
        }
    }
    return localMarker;
}

const LIVE_SYSTEM_REPORT_READY_CACHE_MS = 60_000;
let liveSystemReportReadyUntil = 0;

async function ensureLiveSystemReportReady(force = false): Promise<void> {
    if (!isMultiMode()) return;
    if (!force && Date.now() < liveSystemReportReadyUntil) return;
    if (!(await pingMysql())) {
        throw new Error('MariaDB is offline. Whole-system end-of-day needs live sync first.');
    }
    const pendingBeforeFlush = await pendingReportWriteCount();
    if (pendingBeforeFlush > 0) await flushOfflineQueue();
    const pendingSales = await pendingReportWriteCount();
    if (pendingSales > 0) {
        throw new Error(`${pendingSales} transaction update${pendingSales === 1 ? ' is' : 's are'} still waiting to sync. Sync first, then run whole-system end-of-day.`);
    }
    const stats = await getOfflineQueueStats();
    if (stats.conflicts > 0) {
        throw new Error(`${stats.conflicts} sync conflict${stats.conflicts === 1 ? '' : 's'} need review before whole-system end-of-day.`);
    }
    liveSystemReportReadyUntil = Date.now() + LIVE_SYSTEM_REPORT_READY_CACHE_MS;
}

export async function getLiveLastReportMarker(tillNumber: string): Promise<string | null> {
    if (!isMultiMode()) return sqlite.getLastReportMarker(tillNumber);
    await ensureLiveSystemReportReady();
    return mysql.mysqlGetLastReportMarker(tillNumber);
}

export async function saveReportMarker(
    tillNumber: string,
    periodStart: string,
    periodEnd: string,
    extra: { employeeId?: string; reportText?: string; reportTotal?: number } = {}
): Promise<any> {
    const row = await sqlite.saveReportMarker(tillNumber, periodStart, periodEnd, extra);
    await recordAuditEvent(
        'report_period_closed',
        'report',
        row.id,
        null,
        {
            scope: tillNumber ? 'till' : 'system',
            tillNumber,
            periodStart,
            periodEnd,
            reportTotal: extra.reportTotal || 0,
        },
        extra.employeeId || currentAuditEmployeeId(),
    );
    await pushWriteInBackground(
        `report marker for ${tillNumber || 'system'}`,
        () => mysql.mysqlUpsert('till_report_markers', row, 'id'),
        () => queueOffline('till_report_markers', 'upsert', row, 'id'),
    );
    return row;
}

export async function saveLiveReportMarker(
    tillNumber: string,
    periodStart: string,
    periodEnd: string,
    extra: { employeeId?: string; reportText?: string; reportTotal?: number } = {}
): Promise<any> {
    if (!isMultiMode()) return saveReportMarker(tillNumber, periodStart, periodEnd, extra);
    await ensureLiveSystemReportReady();
    const mysqlDb = await getMysqlDb();
    if (!mysqlDb) throw new Error('MariaDB is offline. Whole-system end-of-day was not closed.');
    const stamp = new Date().toISOString();
    const row = {
        id: crypto.randomUUID(),
        tillNumber,
        type: 'period',
        markerTime: periodEnd,
        periodStart,
        periodEnd,
        employeeId: extra.employeeId || '',
        reportText: extra.reportText || '',
        reportTotal: extra.reportTotal || 0,
        createdAt: stamp,
        updatedAt: stamp,
    };
    await mysql.mysqlUpsert('till_report_markers', row, 'id');
    await sqlite.upsert('till_report_markers', row, 'id');
    await recordAuditEvent(
        'report_period_closed',
        'report',
        row.id,
        null,
        {
            scope: tillNumber ? 'till' : 'system',
            tillNumber,
            periodStart,
            periodEnd,
            reportTotal: extra.reportTotal || 0,
        },
        extra.employeeId || currentAuditEmployeeId(),
    );
    return row;
}

export async function recordManagerApproval(approval: any): Promise<void> {
    const stamped = {
        ...approval,
        updatedAt: approval.updatedAt || new Date().toISOString(),
    };
    await upsert('manager_approvals', stamped, 'id');
    await recordAuditEvent(
        'manager_approval_granted',
        stamped.entityType || 'approval',
        stamped.entityId || stamped.id,
        null,
        stamped,
        stamped.approvedByEmployeeId || currentAuditEmployeeId(),
    );
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
    await queueOffline('shifts', 'upsert', stamped);
    void flushOfflineQueue().catch((error) => {
        console.warn('database: shift close outbox flush failed:', error);
        connectionState.update(state => ({ ...state, mysqlOnline: false, syncError: String(error) }));
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
    if (!get(connectionState).mysqlOnline) return 0;
    try {
        const config = get(connectionState).mysqlConfig;
        if (!config) return 0;
        const seq = await withTimeout(
            invoke<number>('allocate_mysql_till_sequence', {
                mysqlUri: buildMysqlUri(config),
            }),
            RECEIPT_SEQUENCE_REMOTE_TIMEOUT_MS,
            'MariaDB receipt sequence check timed out',
        );
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

/**
 * Ensure this device has a receipt sequence. The till name is deliberately not
 * considered here: it is a display label and must never change receipt numbers.
 */
export async function ensureTillReceiptSequence(): Promise<number> {
    return getTillSequence();
}

export async function createLocalBackup(backupDirectory?: string): Promise<string> {
    const directory = backupDirectory === undefined
        ? (await getAutomaticSetupBackupConfig()).directory
        : backupDirectory.trim();
    return invoke<string>('create_local_backup', { backupDirectory: directory || null });
}

export async function getLatestLocalBackup(backupDirectory?: string): Promise<string | null> {
    const directory = backupDirectory === undefined
        ? (await getAutomaticSetupBackupConfig()).directory
        : backupDirectory.trim();
    return invoke<string | null>('latest_local_backup', { backupDirectory: directory || null });
}

export interface AutomaticSetupBackupResult {
    path: string;
    created: boolean;
}

export interface AutomaticSetupBackupConfig {
    enabled: boolean;
    time: string;
    directory: string;
}

const DEFAULT_AUTOMATIC_SETUP_BACKUP_TIME = '03:00';

function normalizeAutomaticBackupTime(value: string | null): string {
    const match = String(value || '').match(/^(\d{2}):(\d{2})$/);
    if (!match) return DEFAULT_AUTOMATIC_SETUP_BACKUP_TIME;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    return hours >= 0 && hours < 24 && minutes >= 0 && minutes < 60
        ? `${match[1]}:${match[2]}`
        : DEFAULT_AUTOMATIC_SETUP_BACKUP_TIME;
}

export async function getAutomaticSetupBackupEnabled(): Promise<boolean> {
    const value = await getSettingValue('automatic_setup_backup_enabled');
    return value === null ? true : value === 'true';
}

export async function setAutomaticSetupBackupEnabled(enabled: boolean): Promise<void> {
    await sqlite.upsert('settings', {
        key: 'automatic_setup_backup_enabled',
        value: enabled ? 'true' : 'false',
        updatedAt: new Date().toISOString(),
    }, 'key');
}

export async function getAutomaticSetupBackupConfig(): Promise<AutomaticSetupBackupConfig> {
    const [enabled, time, directory, legacyDirectory] = await Promise.all([
        getAutomaticSetupBackupEnabled(),
        getSettingValue('automatic_setup_backup_time'),
        getSettingValue('backup_directory'),
        getSettingValue('automatic_setup_backup_directory'),
    ]);
    return {
        enabled,
        time: normalizeAutomaticBackupTime(time),
        directory: String(directory || legacyDirectory || '').trim(),
    };
}

export async function setAutomaticSetupBackupSchedule(time: string, directory: string): Promise<void> {
    const normalizedTime = normalizeAutomaticBackupTime(time);
    const stamp = new Date().toISOString();
    await sqlite.upsert('settings', {
        key: 'automatic_setup_backup_time',
        value: normalizedTime,
        updatedAt: stamp,
    }, 'key');
    await sqlite.upsert('settings', {
        key: 'backup_directory',
        value: directory.trim(),
        updatedAt: stamp,
    }, 'key');
}

export async function createAutomaticSetupBackup(
    backupDirectory?: string,
): Promise<AutomaticSetupBackupResult> {
    const directory = backupDirectory === undefined
        ? (await getAutomaticSetupBackupConfig()).directory
        : backupDirectory.trim();
    return invoke<AutomaticSetupBackupResult>('create_automatic_setup_backup', {
        backupDirectory: directory || null,
    });
}

export async function runAutomaticSetupBackupIfEnabled(): Promise<AutomaticSetupBackupResult | null> {
    const config = await getAutomaticSetupBackupConfig();
    if (!config.enabled) return null;
    const [hours, minutes] = config.time.split(':').map(Number);
    const current = new Date();
    if (current.getHours() * 60 + current.getMinutes() < hours * 60 + minutes) return null;
    return createAutomaticSetupBackup(config.directory);
}

export async function getLatestAutomaticSetupBackup(backupDirectory?: string): Promise<string | null> {
    const directory = backupDirectory === undefined
        ? (await getAutomaticSetupBackupConfig()).directory
        : backupDirectory.trim();
    return invoke<string | null>('latest_automatic_setup_backup', {
        backupDirectory: directory || null,
    });
}

export interface DatabaseRestoreResult {
    restoredFrom: string;
    replacedDatabase: string;
    safetyBackup: string | null;
    restartRequired?: boolean;
}

async function closeLocalDatabaseForRestore(): Promise<void> {
    stopBackgroundSync();
    await sqlite.closeDb();
}

export async function restoreLatestLocalBackup(): Promise<DatabaseRestoreResult> {
    const sourcePath = await getLatestLocalBackup();
    if (!sourcePath) throw new Error('No user-created local backup is available.');
    return restoreLocalDatabaseFromPath(sourcePath);
}

export async function restoreLocalDatabaseFromPath(sourcePath: string): Promise<DatabaseRestoreResult> {
    await invoke<void>('validate_local_database_backup', { sourcePath });
    await closeLocalDatabaseForRestore();
    try {
        return await invoke<DatabaseRestoreResult>('restore_local_database_from_path', { sourcePath });
    } catch (error) {
        // Validation happens before closing SQLite, but native replacement can
        // still fail. Reopen the original database so the app remains usable.
        try {
            await sqlite.getDb();
            if (isMultiMode()) void startBackgroundSync();
        } catch (reopenError) {
            console.error('database: could not reopen SQLite after restore failure:', reopenError);
        }
        throw error;
    }
}

export interface SchemaValidationResult {
    ok: boolean;
    issues: string[];
}

const CRITICAL_SCHEMA: Record<string, string[]> = {
    products: ['id', 'price', 'costPrice', 'stockLevel', 'trackStock', 'allowPriceOverride', 'updatedAt'],
    product_images: ['id', 'image', 'updatedAt'],
    discounts: ['id', 'kind', 'groupId', 'bundleQuantity', 'bundlePrice', 'updatedAt'],
    promo_groups: ['id', 'name', 'isActive', 'updatedAt'],
    promo_group_items: ['id', 'groupId', 'productId', 'updatedAt'],
    orders: ['id', 'orderNumber', 'receiptKey', 'shiftId', 'employeeId', 'taxTotal', 'total', 'tillNumber', 'updatedAt'],
    order_lines: ['id', 'orderId', 'productId', 'costPrice', 'taxRate', 'taxAmount', 'lineTotal', 'updatedAt'],
    payments: ['id', 'orderId', 'amount', 'cashAmount', 'cardAmount', 'updatedAt'],
    customers: ['id', 'name', 'postcode', 'loyaltyCode', 'loyaltyPoints', 'updatedAt'],
    loyalty_logs: ['id', 'customerId', 'orderId', 'pointsChange', 'reason', 'updatedAt'],
    employees: ['id', 'storeId', 'pinHash', 'role', 'email', 'isActive', 'updatedAt'],
    inventory_logs: ['id', 'productId', 'quantityChange', 'referenceId', 'updatedAt'],
    audit_logs: ['id', 'employeeId', 'action', 'entityId', 'updatedAt'],
    shifts: ['id', 'registerId', 'employeeId', 'status', 'updatedAt'],
    till_report_markers: ['id', 'tillNumber', 'periodStart', 'periodEnd', 'reportText', 'updatedAt'],
    manager_approvals: ['id', 'requestedByEmployeeId', 'approvedByEmployeeId', 'action', 'updatedAt'],
    stock_receipts: ['id', 'employeeId', 'totalCost', 'status', 'updatedAt'],
    stock_receipt_lines: ['id', 'receiptId', 'productId', 'quantity', 'unitCost', 'updatedAt'],
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
    const queueRows: any[] = await local.select(`PRAGMA table_info(_offline_queue)`);
    const queueColumns = new Set(queueRows.map((row) => row.name));
    for (const column of ['attempt_count', 'last_error', 'next_attempt_at']) {
        if (!queueColumns.has(column)) issues.push(`SQLite: _offline_queue.${column} is missing`);
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
            const changeLogRows: any[] = await remote.select(
                `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_change_log'`,
            );
            const changeLogColumns = new Set(changeLogRows.map((row) => row.COLUMN_NAME));
            for (const column of ['seq', 'table_name', 'changedAt']) {
                if (!changeLogColumns.has(column)) issues.push(`MariaDB: sync_change_log.${column} is missing`);
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
                (SELECT COUNT(*) FROM categories) AS categories,
                (SELECT COUNT(*) FROM orders) AS orders,
                (SELECT COUNT(*) FROM customers) AS customers`
    );
    const c = counts[0] || {};
    if (Number(c.products) > 0 || Number(c.categories) > 0 || Number(c.orders) > 0
        || Number(c.customers) > 0) {
        throw new Error('Migration stopped: MariaDB already contains shop data');
    }
    const validation = await validateDatabaseSchemas();
    if (!validation.ok) throw new Error(validation.issues.join('; '));
    const localDb = await sqlite.getDb();
    await validateLocalDataForRestore(localDb);
    await forcePushTables(localDb);
    await verifyProductUploadCount(localDb);
    await verifyPushedTableCounts(localDb, { exact: true, label: 'Migration upload verification' });
    await publishServerDataEpoch(localDb);
    await mysql.mysqlUpsert('settings', { key: 'bootstrap_done', value: '1' }, 'key');
    await sqlite.upsert('settings', {
        key: 'bootstrap_uploaded',
        value: '1',
        updatedAt: new Date().toISOString(),
    }, 'key');
    await forceFullSync();
}

async function replaceLocalEmployeesFromServer(remote: any, localDb: any): Promise<void> {
    const employees: any[] = await remote.select('SELECT * FROM employees');
    await localDb.execute('DELETE FROM employees');
    for (const employee of employees) {
        await sqlite.upsert('employees', employee, 'id');
    }
}

async function adoptRemoteIdentityLocally(remote: any): Promise<AppIdentity> {
    const rows: any[] = await remote.select(`SELECT * FROM app_identity WHERE id = ? LIMIT 1`, [APP_IDENTITY_ID]);
    const identity = normalizeIdentity(rows[0] || null);
    if (!identity) {
        const localIdentity = await ensureLocalShopIdentity();
        await saveRemoteAppIdentity(localIdentity);
        return localIdentity;
    }
    await saveLocalAppIdentity(identity);
    return identity;
}

async function clearLocalSyncMarkers(localDb: any): Promise<void> {
    await localDb.execute(
        `DELETE FROM settings WHERE key LIKE 'sync_ts_%'
            OR key IN (
                'last_sync_time',
                'last_fast_sync_time',
                '${SYNC_CHANGE_CURSOR_KEY}',
                'bootstrap_uploaded',
                'transaction_purge_applied_at',
                '${RESTORE_PENDING_MARIADB_REPLACE_KEY}'
            )`
    );
}

async function clearRemoteTombstones(remote: any): Promise<void> {
    await remote.execute('DELETE FROM tombstones');
}

const LOCAL_CACHE_RESET_TABLES = [
    'categories', 'products', 'product_images', 'pos_pages', 'pos_tiles',
    'tax_rates', 'discounts', 'promo_groups', 'promo_group_items',
    'employees', 'customers', 'registers',
    'suppliers', 'product_suppliers', 'inventory_logs',
    'orders', 'order_lines', 'payments',
    'loyalty_logs', 'audit_logs', 'shifts', 'cash_movements',
    'till_report_markers', 'manager_approvals',
    'stock_receipts', 'stock_receipt_lines',
    'daily_sales_summary', 'tombstones',
];

async function readRemoteServerDataEpoch(remote: any): Promise<string | null> {
    const rows: any[] = await remote.select(
        `SELECT value FROM settings WHERE \`key\` = ? LIMIT 1`,
        [SERVER_DATA_EPOCH_KEY],
    );
    const value = String(rows[0]?.value || '').trim();
    return value || null;
}

async function rememberLocalServerDataEpoch(localDb: any, epoch: string): Promise<void> {
    await sqlite.upsert('settings', {
        key: SERVER_DATA_EPOCH_KEY,
        value: epoch,
        updatedAt: epoch,
    }, 'key');
    await sqlite.upsert('settings', {
        key: SERVER_DATA_EPOCH_SEEN_KEY,
        value: epoch,
        updatedAt: epoch,
    }, 'key');
}

async function publishServerDataEpoch(localDb: any): Promise<string> {
    const epoch = await mysql.mysqlGetServerTime();
    await mysql.mysqlUpsert('settings', {
        key: SERVER_DATA_EPOCH_KEY,
        value: epoch,
        updatedAt: epoch,
    }, 'key');
    await rememberLocalServerDataEpoch(localDb, epoch);
    return epoch;
}

async function quarantineOfflineQueueForServerEpoch(localDb: any, epoch: string): Promise<number> {
    const rows: any[] = await localDb.select(`SELECT * FROM _offline_queue ORDER BY created_at ASC, id ASC`);
    if (rows.length === 0) return 0;
    const stamp = new Date().toISOString();
    for (const row of rows) {
        await localDb.execute(
            `INSERT OR REPLACE INTO _sync_conflicts (id, table_name, operation, data, reason, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                `server-epoch:${epoch}:${row.id}`,
                row.table_name,
                row.operation,
                row.data,
                `MariaDB was restored/replaced at ${epoch}; this offline change was not replayed automatically.`,
                stamp,
            ],
        );
    }
    await localDb.execute(`DELETE FROM _offline_queue`);
    return rows.length;
}

async function wipeLocalCacheForServerEpoch(localDb: any): Promise<void> {
    for (const table of LOCAL_CACHE_RESET_TABLES) {
        if (await localTableExists(localDb, table)) {
            await localDb.execute(`DELETE FROM ${table}`);
        }
    }
    await localDb.execute(
        `DELETE FROM settings WHERE key LIKE 'sync_ts_%'
            OR key IN ('last_sync_time', 'last_fast_sync_time', '${SYNC_CHANGE_CURSOR_KEY}', 'bootstrap_uploaded', 'transaction_purge_applied_at')`
    );
}

async function resetLocalCacheIfServerEpochChanged(remote: any): Promise<boolean> {
    const remoteEpoch = await readRemoteServerDataEpoch(remote);
    if (!remoteEpoch) return false;

    const localDb = await sqlite.getDb();
    const rows: any[] = await localDb.select(
        `SELECT value FROM settings WHERE key = ? LIMIT 1`,
        [SERVER_DATA_EPOCH_SEEN_KEY],
    );
    const seenEpoch = String(rows[0]?.value || '').trim();
    if (seenEpoch === remoteEpoch) return false;

    const quarantined = await quarantineOfflineQueueForServerEpoch(localDb, remoteEpoch);
    await wipeLocalCacheForServerEpoch(localDb);
    await rememberLocalServerDataEpoch(localDb, remoteEpoch);
    console.warn(
        `database: MariaDB data epoch changed (${seenEpoch || 'none'} -> ${remoteEpoch}); ` +
        `local cache reset${quarantined ? ` and ${quarantined} offline change(s) quarantined` : ''}.`,
    );
    return true;
}

/**
 * Destructive repair for old-till imports:
 * keep MariaDB employees/settings/shop identity, replace business data with
 * the restored local SQLite data, then make this till adopt the MariaDB identity.
 */
export async function replaceMariaDbDataFromThisTill(): Promise<void> {
    if (!isMultiMode()) throw new Error('Connect this till to MariaDB first');
    const remote = await getMysqlDb();
    if (!remote) throw new Error('MariaDB is unavailable');

    stopBackgroundSync();
    while (isSyncRunning || isFastSyncRunning || isChangeSyncRunning) {
        await new Promise(r => setTimeout(r, 100));
    }

    try {
        const validation = await validateDatabaseSchemas();
        if (!validation.ok) throw new Error(validation.issues.join('; '));

        const localDb = await sqlite.getDb();
        const localCounts: any[] = await localDb.select(
            `SELECT (SELECT COUNT(*) FROM products) AS products,
                    (SELECT COUNT(*) FROM categories) AS categories,
                    (SELECT COUNT(*) FROM customers) AS customers`
        );
        if (Number(localCounts[0]?.products || 0) === 0) {
            throw new Error('This till has no restored products to upload');
        }
        await validateLocalDataForRestore(localDb);

        await adoptRemoteIdentityLocally(remote);
        await replaceLocalEmployeesFromServer(remote, localDb);

        for (const table of REMOTE_REPLACE_DELETE_TABLES) {
            await remote.execute(`DELETE FROM ${table}`);
        }
        await clearRemoteTombstones(remote);

        await forcePushTables(localDb, { skipTables: PRESERVE_DURING_RESTORE_TABLES });
        await verifyProductUploadCount(localDb);
        await verifyPushedTableCounts(localDb, {
            skipTables: PRESERVE_DURING_RESTORE_TABLES,
            exact: true,
            label: 'MariaDB replace verification',
        });
        await clearRemoteTombstones(remote);
        await mysql.mysqlUpsert('settings', { key: 'bootstrap_done', value: '1' }, 'key');
        await publishServerDataEpoch(localDb);
        await clearLocalSyncMarkers(localDb);
        await hydrateSvelteStores();
        connectionState.update(s => ({ ...s, mysqlOnline: true, syncError: null }));
    } catch (error) {
        connectionState.update(s => ({ ...s, mysqlOnline: false, syncError: String(error) }));
        throw error;
    } finally {
        startBackgroundSync();
    }
}

/**
 * Compute the next receipt/order number. Offline-safe and collision-proof in
 * multi-till mode; falls back to the legacy global sequence in single mode (or
 * before this till has claimed its sequence).
 */
export async function getNextOrderNumber(): Promise<number> {
    const startStr = await getSettingValue('starting_receipt_number');
    const startNum = startStr ? (parseInt(startStr, 10) || 1) : 1;
    const highWaterStr = await getSettingValue(RECEIPT_HIGH_WATER_KEY);
    const highWater = highWaterStr ? Math.max(0, parseInt(highWaterStr, 10) || 0) : 0;

    const tillSeq = await getTillSequence();

    // Single mode (or sequence not yet claimed) → legacy global sequence.
    if (!isMultiMode() || tillSeq <= 0) {
        const globalMax = await getGlobalMaxOrderNumber();
        return Math.max(Math.max(globalMax, highWater) + 1, startNum);
    }

    // Multi mode → next number inside THIS till's block, from local orders only.
    const blockStart = tillSeq * RECEIPT_BLOCK;
    const d = await sqlite.getDb();
    const rows: any[] = await d.select(
        `SELECT MAX(orderNumber) as maxNum FROM orders WHERE orderNumber >= ? AND orderNumber < ?`,
        [blockStart, blockStart + RECEIPT_BLOCK]
    );
    const localMax = rows[0]?.maxNum || 0;
    const blockHighWater = highWater >= blockStart && highWater < blockStart + RECEIPT_BLOCK
        ? highWater
        : 0;
    const maxIssued = Math.max(localMax, blockHighWater);
    if (maxIssued >= blockStart) return maxIssued + 1;
    // First receipt in this block — honour the configured starting number as an offset.
    return blockStart + Math.max(startNum, 1);
}

export async function getTillPeriodReport(
    tillNumber: string, startTime: string, endTime: string
) {
    if (isMultiMode()) {
        try {
            const pendingBeforeFlush = await pendingReportWriteCount();
            if (pendingBeforeFlush > 0) await flushOfflineQueue();
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

export async function getLiveTillPeriodReport(
    tillNumber: string, startTime: string, endTime: string
) {
    if (!isMultiMode()) return sqlite.getTillPeriodReport(tillNumber, startTime, endTime);
    await ensureLiveSystemReportReady();
    return mysql.mysqlGetTillPeriodReport(tillNumber, startTime, endTime);
}

// ─── Svelte Store Hydration ─────────────────────────────────────────────────

import {
    productsDB, patchProductInStore, categoriesDB, posPagesDB, tilesDB, taxRatesDB, employeesDB,
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
    const lightRoute = isLightStoreRoute();
    let requested = tables ? new Set(tables) : null;
    if (!requested && lightRoute) requested = new Set(getLightRouteHydrationTables());
    if (requested && PROMOTION_SYNC_TABLES.some(table => requested.has(table))) {
        for (const table of PROMOTION_SYNC_TABLES) requested.add(table);
    }
    if (requested?.has('product_images')) requested.add('products');
    if (requested && lightRoute) {
        for (const table of LIGHT_ROUTE_SKIP_HYDRATION_TABLES) requested.delete(table);
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

        categoriesDB.set(cats.map(c => sqlite.rehydrateBooleans(c, ['isActive'])));
        posPagesDB.set(pages);
        tilesDB.set(tiles);
        const prodsWithImages = await sqlite.attachProductImages(prods);
        productsDB.set(prodsWithImages.map(p => sqlite.rehydrateBooleans(p, [
            'isActive', 'isWeighable', 'showInGoods', 'trackStock'
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
        categoriesDB.set(rows.map(c => sqlite.rehydrateBooleans(c, ['isActive'])));
    }
    if (shouldHydrate('pos_pages')) posPagesDB.set(await sqlite.getAll('pos_pages'));
    if (shouldHydrate('pos_tiles')) tilesDB.set(await sqlite.getAll('pos_tiles'));
    if (shouldHydrate('products')) {
        const rows = lightRoute
            ? await sqlite.getPosScreenProducts()
            : await sqlite.attachProductImages(await sqlite.getAll('products'));
        productsDB.set(rows.map(p => sqlite.rehydrateBooleans(p, [
            'isActive', 'isWeighable', 'showInGoods', 'trackStock'
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
let changePollInterval: any = null;
let presenceInterval: any = null;
let presenceStartTimeout: any = null;

let isSyncRunning = false;
let isFastSyncRunning = false;
let isHeartbeatRunning = false;
let isChangeSyncRunning = false;
let isPresenceRunning = false;
const OFFLINE_RECONNECT_CHECK_MS = 60 * 1000;
const CHANGE_POLL_INTERVAL_MS = 5 * 1000;
const FAST_SYNC_INTERVAL_MS = 60 * 1000;
const FULL_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const TILL_PRESENCE_INTERVAL_MS = 15 * 1000;
const TILL_ONLINE_WINDOW_SECONDS = 45;
const SYNC_CHANGE_CURSOR_KEY = 'sync_change_cursor';

export interface ConnectedTill {
    tillId: string;
    tillName: string;
    lastSeenAt: string;
    secondsAgo: number;
    isCurrent: boolean;
}

async function publishTillPresence(force = false): Promise<void> {
    if (!isMultiMode() || isPresenceRunning) return;
    if (!force && !get(connectionState).mysqlOnline) return;
    isPresenceRunning = true;
    try {
        const tillId = await sqlite.getOrCreateTillId();
        const tillName = await sqlite.getTillName();
        await mysql.mysqlTouchTillPresence(tillId, tillName);
    } finally {
        isPresenceRunning = false;
    }
}

export async function getConnectedTills(): Promise<ConnectedTill[]> {
    const tillId = await sqlite.getOrCreateTillId();
    const tillName = await sqlite.getTillName();
    if (!isMultiMode()) {
        return [{
            tillId,
            tillName,
            lastSeenAt: new Date().toISOString(),
            secondsAgo: 0,
            isCurrent: true,
        }];
    }
    await publishTillPresence(true);
    const tills = await mysql.mysqlGetConnectedTills(TILL_ONLINE_WINDOW_SECONDS);
    return tills.map((till) => ({ ...till, isCurrent: till.tillId === tillId }));
}

/**
 * Heartbeat: actively ping MariaDB to keep the online/offline indicator
 * accurate and to recover a dead connection. pingMysql() drops the cached
 * connection on failure so the next call reconnects (server restart, Wi-Fi
 * blip, IP change). When the link transitions back to online, replay the
 * offline queue and pull a fresh full sync so the till catches up.
 */
async function runHeartbeat(): Promise<void> {
    if (!isMultiMode() || isHeartbeatRunning) return;
    if (await pauseSyncIfRestorePending()) return;
    // Online fast/full sync already validates the connection. The heartbeat is
    // only needed to recover an offline till, avoiding a duplicate idle ping.
    if (get(connectionState).mysqlOnline) return;
    isHeartbeatRunning = true;
    try {
        const wasOnline = get(connectionState).mysqlOnline;
        const online = await pingMysql();
        if (!online) {
            resetRemoteConnections();
            return;
        }
        if (online && !wasOnline) {
            console.log('database: connection restored — resyncing before replaying offline changes…');
            runSyncCycle().catch(console.error);
        }
    } finally {
        isHeartbeatRunning = false;
    }
}

/** Tables that should appear on other tills quickly without keeping weak tills busy at idle. */
const FAST_SYNC_TABLES = [
    'orders', 'order_lines', 'payments', 'inventory_logs', 'shifts', 'cash_movements',
    'customers', 'loyalty_logs',
    'till_report_markers', 'manager_approvals', 'stock_receipts', 'stock_receipt_lines'
];
// MariaDB stamps every synced write with its own UTC clock. A short overlap
// protects timestamp boundaries without repeatedly rescanning hours of sales.
const SYNC_OVERLAP_MS = 5 * 1000;
const SYNC_PULL_PAGE_SIZE = 500;

/** All tables — synced on the full cycle so product and pricing changes catch up without interrupting rapid scanning. */
const ALL_SYNC_TABLES = [
    'products', 'product_images', 'categories', 'pos_pages', 'pos_tiles',
    'tax_rates', 'discounts', 'promo_groups', 'promo_group_items',
    'employees', 'settings', 'customers', 'registers',
    'suppliers', 'product_suppliers', 'inventory_logs',
    'orders', 'order_lines', 'payments',
    'loyalty_logs', 'audit_logs', 'shifts', 'cash_movements',
    'till_report_markers', 'manager_approvals',
    'stock_receipts', 'stock_receipt_lines'
];
const ALL_SYNC_TABLE_SET = new Set(ALL_SYNC_TABLES);

function notifyPosHeldOrdersChanged(changedTables: Set<string>, removed = 0): void {
    if (typeof window === 'undefined') return;
    if (removed > 0 || changedTables.has('orders') || changedTables.has('order_lines')) {
        window.dispatchEvent(new Event(POS_HELD_ORDERS_CHANGED_EVENT));
    }
}

function overlapWatermark(since: string | null): string | null {
    if (!since) return since;
    const time = new Date(since).getTime();
    if (!Number.isFinite(time)) return since;
    return new Date(Math.max(0, time - SYNC_OVERLAP_MS)).toISOString();
}

async function filterRowsNeedingLocalUpsert(table: string, rows: any[], idKey = 'id'): Promise<any[]> {
    if (rows.length === 0) return rows;
    const d = await sqlite.getDb();
    const localUpdatedAt = new Map<string, string>();
    const rowIds = [...new Set(rows.map(row => String(row?.[idKey] || '')).filter(Boolean))];

    // One query per chunk avoids an IPC + SQLite query for every row. This is
    // especially important when a fresh till compares a large product catalogue.
    for (let index = 0; index < rowIds.length; index += 400) {
        const chunk = rowIds.slice(index, index + 400);
        const placeholders = chunk.map(() => '?').join(', ');
        const localRows: any[] = await d.select(
            `SELECT ${idKey} AS rowId, updatedAt FROM ${table} WHERE ${idKey} IN (${placeholders})`,
            chunk,
        );
        for (const localRow of localRows) {
            localUpdatedAt.set(String(localRow.rowId), String(localRow.updatedAt || ''));
        }
    }

    return rows.filter((row) => {
        const rowId = String(row?.[idKey] || '');
        return !rowId || !localUpdatedAt.has(rowId)
            || localUpdatedAt.get(rowId) !== String(row.updatedAt || '');
    });
}

async function filterPendingLocalUpserts(table: string, rows: any[], idKey = 'id'): Promise<any[]> {
    if (rows.length === 0) return rows;
    const d = await sqlite.getDb();
    const pendingRows: any[] = await d.select(
        `SELECT data, id_key FROM _offline_queue
         WHERE table_name = ? AND operation = 'upsert'`,
        [table],
    );
    if (pendingRows.length === 0) return rows;

    const pendingIds = new Set<string>();
    for (const pendingRow of pendingRows) {
        try {
            const data = JSON.parse(pendingRow.data);
            const key = String(pendingRow.id_key || idKey);
            const value = String(data?.[key] || '');
            if (value) pendingIds.add(value);
        } catch {
            // Invalid queue JSON will be isolated by the outbox drain.
        }
    }
    return pendingIds.size > 0
        ? rows.filter(row => !pendingIds.has(String(row?.[idKey] || '')))
        : rows;
}

async function filterPendingLocalDeletes(table: string, rows: any[], idKey = 'id'): Promise<any[]> {
    if (rows.length === 0 || idKey !== 'id') return rows;
    const d = await sqlite.getDb();
    if (PROMOTION_SYNC_TABLE_SET.has(table) && await pendingPromotionQueueCount() === 0) {
        const rowIds = Array.from(new Set(rows.map(row => String(row?.[idKey] || '')).filter(Boolean)));
        if (rowIds.length > 0) {
            const placeholders = rowIds.map(() => '?').join(', ');
            await d.execute(
                `DELETE FROM tombstones WHERE table_name = ? AND row_id IN (${placeholders})`,
                [table, ...rowIds],
            );
        }
        return rows;
    }
    const tombstones: any[] = await d.select(
        `SELECT row_id FROM tombstones WHERE table_name = ?`,
        [table],
    );
    if (tombstones.length === 0) return rows;
    const deletedIds = new Set(tombstones.map(row => String(row.row_id)));
    return rows.filter(row => !deletedIds.has(String(row?.[idKey])));
}

async function pruneLocalPromotionMembershipsToRemote(remoteRows: any[]): Promise<number> {
    if (remoteRows.length === 0) return 0;
    if (await pendingPromotionQueueCount() > 0) return 0;

    const groupIds = Array.from(new Set(remoteRows.map(row => row.groupId).filter(Boolean)));
    const remoteIds = Array.from(new Set(remoteRows.map(row => row.id).filter(Boolean)));
    if (groupIds.length === 0 || remoteIds.length === 0) return 0;

    const d = await sqlite.getDb();
    const groupPlaceholders = groupIds.map(() => '?').join(', ');
    const idPlaceholders = remoteIds.map(() => '?').join(', ');
    const result: any = await d.execute(
        `DELETE FROM promo_group_items
         WHERE groupId IN (${groupPlaceholders})
           AND id NOT IN (${idPlaceholders})`,
        [...groupIds, ...remoteIds],
    );
    return Number(result?.rowsAffected || 0);
}

async function applyRemoteSyncRows(
    table: string,
    remoteRows: any[],
    idKey: string,
    allowPromotionPrune = false,
): Promise<number> {
    let visibleRows = table === 'settings'
        ? remoteRows.filter((row: any) => isSyncableSetting(row.key))
        : remoteRows;
    visibleRows = await filterPendingLocalDeletes(table, visibleRows, idKey);
    visibleRows = await filterPendingLocalUpserts(table, visibleRows, idKey);

    let changes = 0;
    if (allowPromotionPrune && table === 'promo_group_items') {
        changes += await pruneLocalPromotionMembershipsToRemote(visibleRows);
    }
    const rows = await filterRowsNeedingLocalUpsert(table, visibleRows, idKey);
    if (rows.length > 0) {
        await sqlite.bulkUpsert(table, rows, idKey);
        changes += rows.length;
    }
    return changes;
}

async function pullRemoteTableChanges(
    table: string,
    since: string | null,
    through: string,
): Promise<number> {
    const idKey = table === 'settings' ? 'key' : 'id';
    let cursor: mysql.MysqlSyncPageCursor | null = null;
    let totalChanges = 0;
    const promotionRows: any[] = [];

    for (let page = 0; page < 10_000; page++) {
        const result = await mysql.mysqlGetSyncPage(
            table,
            PROMOTION_SYNC_TABLE_SET.has(table) ? null : since,
            through,
            idKey,
            cursor,
            SYNC_PULL_PAGE_SIZE,
        );
        if (PROMOTION_SYNC_TABLE_SET.has(table)) {
            promotionRows.push(...result.rows);
        } else {
            totalChanges += await applyRemoteSyncRows(table, result.rows, idKey);
        }

        if (!result.nextCursor) break;
        if (cursor
            && cursor.updatedAt === result.nextCursor.updatedAt
            && cursor.rowId === result.nextCursor.rowId) {
            throw new Error(`Sync cursor did not advance for ${table}`);
        }
        cursor = result.nextCursor;
    }

    if (PROMOTION_SYNC_TABLE_SET.has(table)) {
        totalChanges += await applyRemoteSyncRows(table, promotionRows, idKey, true);
    }
    return totalChanges;
}

async function readLocalSyncChangeCursor(): Promise<number | null> {
    const d = await sqlite.getDb();
    const rows: any[] = await d.select(
        `SELECT value FROM settings WHERE key = ? LIMIT 1`,
        [SYNC_CHANGE_CURSOR_KEY],
    );
    if (!rows[0]?.value) return null;
    const value = Number(rows[0].value);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

async function writeLocalSyncChangeCursor(value: number): Promise<void> {
    const stamp = new Date().toISOString();
    await sqlite.upsert('settings', {
        key: SYNC_CHANGE_CURSOR_KEY,
        value: String(Math.max(0, Math.trunc(value))),
        updatedAt: stamp,
    }, 'key');
}

async function syncChangedTables(tableNames: Iterable<string>): Promise<{
    allSucceeded: boolean;
    transactionPurged: boolean;
}> {
    const requested = new Set(Array.from(tableNames, table => String(table || '')));
    const mysqlDb = await getMysqlDb();
    if (!mysqlDb) throw new Error('MariaDB connection is unavailable');
    await ensureDatabaseIdentityForSync();
    const through = await mysql.mysqlGetServerTime();
    const changedTables = new Set<string>();
    const successfulTables = new Set<string>();
    let totalChanges = 0;
    let removed = 0;
    let allSucceeded = true;

    if (requested.has('tombstones')) {
        try {
            removed = await applyTombstones(through, true);
        } catch (error) {
            allSucceeded = false;
            console.warn('database: change-cursor tombstone sync failed:', error);
        }
    }

    for (const table of requested) {
        if (!ALL_SYNC_TABLE_SET.has(table)) continue;
        try {
            const since = overlapWatermark(await getTableWatermark(table));
            const changes = await pullRemoteTableChanges(table, since, through);
            if (changes > 0) {
                totalChanges += changes;
                changedTables.add(table);
            }
            successfulTables.add(table);
        } catch (error) {
            allSucceeded = false;
            console.warn(`database: change-cursor sync failed for ${table}:`, error);
        }
    }
    await setTableWatermarks(successfulTables, through);

    // Settings can contain the shop-wide transaction purge marker. Apply it in
    // this lightweight path so connected tills clear SQLite within one change
    // poll instead of waiting for the five-minute full reconciliation.
    const transactionPurged = successfulTables.has('settings')
        ? await applyTransactionPurgeMarker()
        : false;

    if (totalChanges > 0 || removed > 0 || transactionPurged) {
        await hydrateSvelteStores((removed > 0 || transactionPurged) ? undefined : changedTables);
    }
    notifyPosHeldOrdersChanged(changedTables, removed);
    return { allSucceeded, transactionPurged };
}

/** Poll one tiny MariaDB cursor, then pull only tables which actually changed. */
export async function runChangeSyncCycle(): Promise<void> {
    if (!isMultiMode() || isChangeSyncRunning || isFastSyncRunning || isSyncRunning) return;
    if (await pauseSyncIfRestorePending()) return;
    isChangeSyncRunning = true;
    let reloadAfterPurge = false;
    try {
        // A previous poll may already have downloaded the marker before the
        // till lost connectivity or closed. Applying the local marker does not
        // require MariaDB to still be online.
        const pendingLocalPurge = await applyTransactionPurgeMarker();
        if (pendingLocalPurge) {
            await hydrateSvelteStores();
            reloadAfterPurge = true;
        } else if (get(connectionState).mysqlOnline) {
            const localCursor = await readLocalSyncChangeCursor();
            const syncWindow = await mysql.mysqlGetSyncChangeWindow(localCursor ?? 0);
            const cursorExpired = localCursor !== null
                && syncWindow.minSeq > 0
                && localCursor < syncWindow.minSeq - 1;
            const needsBaseline = localCursor === null || cursorExpired;

            if (needsBaseline) {
                const baselineTables = new Set<string>([...ALL_SYNC_TABLES, 'tombstones']);
                const result = await syncChangedTables(baselineTables);
                if (result.allSucceeded) {
                    await writeLocalSyncChangeCursor(syncWindow.maxSeq);
                }
                reloadAfterPurge = result.transactionPurged;
            } else if (syncWindow.changes.length > 0) {
                const tables = new Set(syncWindow.changes.map(change => change.tableName));
                const result = await syncChangedTables(tables);
                if (result.allSucceeded) {
                    await writeLocalSyncChangeCursor(syncWindow.maxSeq);
                    connectionState.update(state => ({ ...state, mysqlOnline: true, syncError: null }));
                }
                reloadAfterPurge = result.transactionPurged;
            }
        }
    } catch (error) {
        console.warn('database: change-cursor sync failed:', error);
        resetRemoteConnections();
        connectionState.update(state => ({ ...state, mysqlOnline: false, syncError: String(error) }));
    } finally {
        isChangeSyncRunning = false;
    }
    if (reloadAfterPurge && typeof window !== 'undefined') {
        window.location.reload();
    }
}

/**
 * Run a fast sync cycle that only pulls transaction-related tables
 * (orders, order_lines, payments, shifts, cash_movements) and rehydrates
 * the Svelte stores. Periodic idle sync is deliberately calmer for weak tills;
 * completed sales still call triggerSync() immediately.
 */
export async function runFastSyncCycle(): Promise<void> {
    if (!isMultiMode() || isFastSyncRunning || isSyncRunning || isChangeSyncRunning) return;
    if (!get(connectionState).mysqlOnline) return;
    if (await pauseSyncIfRestorePending()) return;
    isFastSyncRunning = true;
    try {
        const wasOnline = get(connectionState).mysqlOnline;
        const mysqlDb = await getMysqlDb();
        if (!mysqlDb) {
            resetRemoteConnections();
            return;
        }
        await ensureDatabaseIdentityForSync();
        const serverEpochChanged = await resetLocalCacheIfServerEpochChanged(mysqlDb);
        if (!serverEpochChanged) await assertMariaDbSafeForPull(mysqlDb);

        const preFlushSyncTime = await mysql.mysqlGetServerTime();
        const removedBeforeFlush = await applyTombstones(preFlushSyncTime);
        const pendingBeforeFlush = await pendingOfflineQueueCount();
        const flushed = pendingBeforeFlush > 0 ? await flushOfflineQueue() : 0;
        const repairedPromotions = await pushNewerLocalPromotionPackages();
        const shouldCatchUpEverything = serverEpochChanged || !wasOnline || flushed > 0 || removedBeforeFlush > 0;
        const tablesToPull = shouldCatchUpEverything ? ALL_SYNC_TABLES : FAST_SYNC_TABLES;

        // Server clock is the authority for delta sync; read it once per cycle.
        const newSyncTime = await mysql.mysqlGetServerTime();

        let totalChanges = 0;
        const changedTables = new Set<string>();
        const successfulTables = new Set<string>();

        for (const table of tablesToPull) {
            // Per-table watermark: only advances when THIS table's pull succeeds,
            // so a transient error on one table never permanently skips its rows.
            const since = overlapWatermark(await getTableWatermark(table));
            try {
                const changes = await pullRemoteTableChanges(table, since, newSyncTime);
                if (changes > 0) {
                    totalChanges += changes;
                    changedTables.add(table);
                }
                successfulTables.add(table);
            } catch (e) {
                // Leave this table's watermark untouched so we retry its rows next cycle.
                console.warn(`database: fast sync failed for ${table}:`, e);
            }
        }
        await setTableWatermarks(successfulTables, newSyncTime);

        const removed = removedBeforeFlush + await applyTombstones(newSyncTime);

        // Only rehydrate stores if there were actual changes (avoids unnecessary re-renders)
        if (totalChanges > 0 || removed > 0 || repairedPromotions > 0) {
            console.log(`database: fast sync found ${totalChanges} changes, rehydrating…`);
            await hydrateSvelteStores((removed > 0 || repairedPromotions > 0) ? undefined : changedTables);
        }
        notifyPosHeldOrdersChanged(changedTables, removed);

        connectionState.update(s => ({ ...s, mysqlOnline: true, syncError: null }));
    } catch (e: any) {
        console.warn('database: fast sync failed:', e);
        resetRemoteConnections();
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
    if (!isMultiMode() || isSyncRunning || isFastSyncRunning || isChangeSyncRunning) return;
    if (!get(connectionState).mysqlOnline) return;
    if (await pauseSyncIfRestorePending()) return;
    isSyncRunning = true;
    try {
        const mysqlDb = await getMysqlDb();
        if (!mysqlDb) {
            resetRemoteConnections();
            return;
        }
        await ensureDatabaseIdentityForSync();
        const serverEpochChanged = await resetLocalCacheIfServerEpochChanged(mysqlDb);
        if (!serverEpochChanged) await assertMariaDbSafeForPull(mysqlDb);

        // Pull deletes first so an offline till cannot resurrect an old
        // promotion that another till already removed.
        const preFlushSyncTime = await mysql.mysqlGetServerTime();
        const removedBeforeFlush = await applyTombstones(preFlushSyncTime);

        // Flush any queued offline operations after applying remote deletions.
        await flushOfflineQueue();
        const repairedPromotions = await pushNewerLocalPromotionPackages();

        // Server clock is the authority for delta sync; read it once per cycle.
        const newSyncTime = await mysql.mysqlGetServerTime();

        let totalChanges = 0;
        const changedTables = new Set<string>();
        const successfulTables = new Set<string>();
        for (const table of ALL_SYNC_TABLES) {
            // Per-table watermark: only advances when THIS table's pull succeeds.
            const since = overlapWatermark(await getTableWatermark(table));
            try {
                const changes = await pullRemoteTableChanges(table, since, newSyncTime);
                if (changes > 0) {
                    totalChanges += changes;
                    changedTables.add(table);
                    console.log(`database: synced ${changes} row change(s) to local cache for ${table}`);
                }
                successfulTables.add(table);
            } catch (e) {
                // Leave this table's watermark untouched so we retry its rows next cycle.
                console.warn(`database: sync failed for ${table}:`, e);
            }
        }
        await setTableWatermarks(successfulTables, newSyncTime);

        const transactionPurged = await applyTransactionPurgeMarker();

        // Apply deletions from other tills AFTER upserts so a delete can't be
        // resurrected by a stale insert in the same cycle.
        const removed = removedBeforeFlush + await applyTombstones(newSyncTime);
        if (removed > 0) console.log(`database: applied ${removed} tombstone deletions`);

        // Rehydrate Svelte stores so the UI reflects latest data
        if (totalChanges > 0 || removed > 0 || transactionPurged || repairedPromotions > 0) {
            await hydrateSvelteStores((removed > 0 || transactionPurged || repairedPromotions > 0) ? undefined : changedTables);
        }
        notifyPosHeldOrdersChanged(changedTables, removed);

        connectionState.update(s => ({ ...s, mysqlOnline: true, syncError: null }));
        console.log('database: full sync complete ✅');
        void mysql.mysqlPruneSyncChangeLog().catch(error => {
            console.warn('database: change-log pruning failed:', error);
        });
        if (transactionPurged && typeof window !== 'undefined') {
            window.location.reload();
        }
    } catch (e: any) {
        console.warn('database: background sync failed:', e);
        resetRemoteConnections();
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
    if (await pauseSyncIfRestorePending()) return;
    // Join any in-flight outbox drain so a completed sale is durably uploaded,
    // then pull the compact list of tables changed by other tills.
    await flushOfflineQueue();
    await runChangeSyncCycle();
}

/**
 * Start periodic background sync from MySQL → SQLite cache → Svelte stores.
 * Runs quietly in the background:
 *  - Online: tiny change cursor every 5 seconds, fallback transaction sync every
 *    minute, and full reconciliation every 5 minutes
 *  - Offline: no full/fast sync attempts; only a reconnect probe every 60 seconds
 */
export async function startBackgroundSync(intervalMs: number = FAST_SYNC_INTERVAL_MS): Promise<void> {
    if (syncInterval) clearInterval(syncInterval);
    if (fastSyncInterval) clearInterval(fastSyncInterval);
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (changePollInterval) clearInterval(changePollInterval);
    if (presenceInterval) clearInterval(presenceInterval);
    if (presenceStartTimeout) clearTimeout(presenceStartTimeout);
    syncInterval = null;
    fastSyncInterval = null;
    heartbeatInterval = null;
    changePollInterval = null;
    presenceInterval = null;
    presenceStartTimeout = null;

    if (await pauseSyncIfRestorePending()) return;

    // Do not block the POS. A heartbeat confirms the connection first; once
    // online it flushes queued writes and starts a full catch-up sync.
    runHeartbeat().catch(console.error);

    // Cheap cursor polling gives other tills near-real-time changes without
    // repeatedly scanning every transaction table.
    runChangeSyncCycle().catch(console.error);
    changePollInterval = setInterval(() => runChangeSyncCycle(), CHANGE_POLL_INTERVAL_MS);

    // Fallback reconciliation catches changes from servers installed before
    // change-log triggers were available.
    fastSyncInterval = setInterval(() => runFastSyncCycle(), intervalMs);

    // Full sync: pull ALL tables while online (products, categories, settings, etc.).
    syncInterval = setInterval(() => runSyncCycle(), FULL_SYNC_INTERVAL_MS);

    // Offline reconnect check: slow and short so the till never freezes.
    heartbeatInterval = setInterval(() => runHeartbeat(), OFFLINE_RECONNECT_CHECK_MS);

    // Yield once so layout startup can mark MariaDB online before the first
    // lightweight presence write.
    presenceStartTimeout = setTimeout(() => {
        presenceStartTimeout = null;
        publishTillPresence().catch(console.error);
    }, 0);
    presenceInterval = setInterval(
        () => publishTillPresence().catch(console.error),
        TILL_PRESENCE_INTERVAL_MS,
    );
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
    if (changePollInterval) {
        clearInterval(changePollInterval);
        changePollInterval = null;
    }
    if (presenceInterval) {
        clearInterval(presenceInterval);
        presenceInterval = null;
    }
    if (presenceStartTimeout) {
        clearTimeout(presenceStartTimeout);
        presenceStartTimeout = null;
    }
}

/**
 * Permanently remove transaction history while preserving shop configuration,
 * products, stock levels, customers, loyalty balances, employees, and tills.
 * In multi-till mode a synchronized marker makes every till clear its cache.
 */
export async function purgeAllTransactions(): Promise<void> {
    stopBackgroundSync();
    while (isSyncRunning || isFastSyncRunning || isChangeSyncRunning) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    try {
        const localDb = await sqlite.getDb();
        await preserveLocalReceiptHighWater(localDb);
        let marker = new Date().toISOString();
        if (isMultiMode()) {
            const server = await getMysqlDb();
            if (!server) throw new Error('MariaDB must be online before deleting shop-wide transactions.');
            marker = await mysql.mysqlGetServerTime();

            await server.execute(`DELETE FROM inventory_logs WHERE referenceId IN (SELECT id FROM orders)`);
            await server.execute(
                `DELETE FROM audit_logs
                 WHERE entityId IN (SELECT id FROM orders)
                    OR entityId IN (SELECT id FROM shifts)
                    OR entityType IN ('order','shift','cash_movement','report')
                    OR action IN ('sale_completed','order_refunded','order_partially_refunded','order_voided','refund_completed','report_period_closed')`
            );
            await server.execute(
                `DELETE FROM manager_approvals
                 WHERE entityId IN (SELECT id FROM orders)
                    OR entityType = 'order'
                    OR action = 'refund_void'`
            );
            await server.execute(`DELETE FROM payments`);
            await server.execute(`DELETE FROM order_lines`);
            await server.execute(`DELETE FROM cash_movements`);
            await server.execute(`DELETE FROM orders`);
            await server.execute(`DELETE FROM shifts`);
            await server.execute(`DELETE FROM daily_sales_summary`);
            await server.execute(`DELETE FROM till_report_markers`);
            await server.execute(`DELETE FROM tombstones WHERE table_name IN ('orders','order_lines','payments','shifts','cash_movements','inventory_logs','audit_logs','manager_approvals')`);
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
    while (isSyncRunning || isFastSyncRunning || isChangeSyncRunning) {
        await new Promise(r => setTimeout(r, 100));
    }

    try {
        await ensureDatabaseIdentityForSync();
        const mysqlDb = await getMysqlDb();
        if (!mysqlDb) throw new Error('MariaDB is unavailable');
        const serverEpochChanged = await resetLocalCacheIfServerEpochChanged(mysqlDb);
        if (!serverEpochChanged) await assertMariaDbSafeForPull(mysqlDb);
        const localDb = await sqlite.getDb();
        // Clear every per-table watermark so the next cycle re-pulls all tables.
        await localDb.execute(
            `DELETE FROM settings WHERE key LIKE 'sync_ts_%' OR key IN ('last_sync_time', 'last_fast_sync_time', '${SYNC_CHANGE_CURSOR_KEY}')`
        );

        // This will now download everything from scratch since there are no watermarks
        connectionState.update(s => ({ ...s, mysqlOnline: true, syncError: null }));
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
    while (isSyncRunning || isFastSyncRunning || isChangeSyncRunning) {
        await new Promise(r => setTimeout(r, 100));
    }

    try {
        await ensureDatabaseIdentityForSync();
        const localDb = await sqlite.getDb();
        await validateLocalDataForRestore(localDb);
        // Reuse the shared push helper (skips device-local settings keys).
        await forcePushTables(localDb);
        await verifyProductUploadCount(localDb);
        await verifyPushedTableCounts(localDb, { exact: false, label: 'Force push verification' });
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

    while (isSyncRunning || isFastSyncRunning || isChangeSyncRunning) {
        await new Promise(r => setTimeout(r, 100));
    }

    try {
        await ensureDatabaseIdentityForSync();
        const remote = await getMysqlDb();
        if (!remote) throw new Error('MariaDB is unavailable');
        const serverEpochChanged = await resetLocalCacheIfServerEpochChanged(remote);
        if (!serverEpochChanged) await assertMariaDbSafeForPull(remote);
        const localDb = await sqlite.getDb();

        // Wipe local tables
        const tablesToWipe = [
            'categories', 'products', 'product_images', 'pos_pages', 'pos_tiles',
            'tax_rates', 'discounts', 'promo_groups', 'promo_group_items',
            'employees', 'customers', 'registers',
            'suppliers', 'product_suppliers', 'inventory_logs',
            'orders', 'order_lines', 'payments',
            'loyalty_logs', 'audit_logs', 'shifts', 'cash_movements',
            'till_report_markers', 'manager_approvals',
            'stock_receipts', 'stock_receipt_lines'
        ];

        for (const table of tablesToWipe) {
            await localDb.execute(`DELETE FROM ${table}`);
        }
        // Also clear all per-table watermarks (incl. tombstones) so it pulls everything
        await localDb.execute(
            `DELETE FROM settings WHERE key LIKE 'sync_ts_%' OR key IN ('last_sync_time', 'last_fast_sync_time', '${SYNC_CHANGE_CURSOR_KEY}')`
        );
        console.log('database: local tables wiped. Running full sync cycle...');
        connectionState.update(s => ({ ...s, mysqlOnline: true, syncError: null }));

        // This will now download everything from scratch into empty tables
        await runSyncCycle();
        const state = get(connectionState);
        if (state.mode === 'multi' && state.mysqlConfig) {
            const stamp = new Date().toISOString();
            await localDb.execute(
                `INSERT INTO settings (key, value, updatedAt) VALUES (?, ?, ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
                ['pos_mode', 'multi', stamp]
            );
            await localDb.execute(
                `INSERT INTO settings (key, value, updatedAt) VALUES (?, ?, ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
                ['mysql_config', JSON.stringify(state.mysqlConfig), stamp]
            );
        }

        console.log('database: wipe and pull complete, rehydrating stores...');
        await hydrateSvelteStores();
    } catch (e) {
        console.error('database: wipe and pull failed:', e);
        throw e;
    } finally {
        startBackgroundSync();
    }
}
