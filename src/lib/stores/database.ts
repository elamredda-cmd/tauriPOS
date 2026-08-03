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
import type { MysqlConfig } from './connection';
import { get } from 'svelte/store';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { currentEmployee } from './session';
import { notifyOwnerCloudDataChanged } from '$lib/ownerCloudEvents';
import { findStrongLegacySharedDataProof, type LegacySharedDataProof } from './databaseIdentity';
import { AsyncMutex } from '$lib/utils/asyncMutex';
import { summarizeAccountActivity } from '$lib/accountReporting';
import {
    buildPreviewOrderDetails,
    buildPreviewRecentReceipts,
    findLatestPreviewTillReceipt,
} from './previewRecentReceipts';
import type {
    CustomerAccount,
    CustomerAccountEntry,
    CustomerAccountEntryType,
    CustomerAccountPaymentMethod,
} from './db';

const PROMOTION_SYNC_TABLES = ['discounts', 'promo_groups', 'promo_group_items'];
const PROMOTION_SYNC_TABLE_SET = new Set(PROMOTION_SYNC_TABLES);
const serverEpochResetMutex = new AsyncMutex();
// Serializes local financial commits with a close-barrier readiness ack. A
// prepared ack can never overtake an already-started local sale, and a sale
// queued behind that ack must re-read MariaDB state before touching SQLite.
const wholeSystemCloseLocalMutex = new AsyncMutex();
const WHOLE_SYSTEM_CLOSE_LOCAL_GUARDED_TABLES = new Set([
    'orders', 'order_lines', 'payments', 'products', 'inventory_logs', 'customers',
    'loyalty_logs', 'customer_accounts', 'customer_account_entries', 'shifts',
    'cash_movements', 'till_report_markers', 'manager_approvals', 'audit_logs',
    'stock_receipts', 'stock_receipt_lines', 'daily_sales_summary',
    'payment_terminal_attempts', 'tombstones',
]);
export const POS_HELD_ORDERS_CHANGED_EVENT = 'pos-held-orders-changed';
const RECEIPT_SEQUENCE_REMOTE_TIMEOUT_MS = 1200;
const RECEIPT_BLOCK = 1_000_000;
const RECEIPT_HIGH_WATER_KEY = 'receipt_number_high_water';
const LIGHT_STORE_ROUTES = new Set([
    '/', '/admin', '/orders', '/items', '/discounts', '/categories', '/customers', '/employees', '/employees/permissions', '/reports', '/shifts', '/audit', '/label-print', '/customer-display',
    '/design', '/design/scale', '/tiles', '/stock-receiving', '/suppliers', '/tax-rates', '/sync', '/about', '/setup',
    '/settings', '/settings/advanced', '/settings/barcodes', '/settings/customer-display',
    '/settings/feedback', '/settings/fonts', '/settings/integrations', '/settings/labels',
    '/settings/layout', '/settings/licence', '/settings/owner-app', '/settings/payments',
    '/settings/payments/dojo', '/settings/payments/sumup', '/settings/permissions', '/settings/printers',
    '/settings/receipt', '/settings/scale', '/settings/themes',
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
    'customer_accounts',
    'customer_account_entries',
    'registers',
    'discounts',
    'promo_groups',
    'promo_group_items',
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
const SETTINGS_LIGHT_ROUTE_TABLES = [
    'employees',
    'settings',
] as const;
const SUPPLIERS_LIGHT_ROUTE_TABLES = [
    'employees',
    'settings',
    'suppliers',
] as const;
const TAX_RATES_LIGHT_ROUTE_TABLES = [
    'employees',
    'settings',
    'tax_rates',
] as const;
const STOCK_RECEIVING_LIGHT_ROUTE_TABLES = [
    'employees',
    'settings',
    'suppliers',
] as const;
const LIGHT_ROUTE_SKIP_HYDRATION_TABLES = new Set([
    'orders',
    'order_lines',
    'payments',
    'inventory_logs',
    'loyalty_logs',
    'customer_account_entries',
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
    if (pathname === '/suppliers') return [...SUPPLIERS_LIGHT_ROUTE_TABLES];
    if (pathname === '/tax-rates') return [...TAX_RATES_LIGHT_ROUTE_TABLES];
    if (pathname === '/stock-receiving') return [...STOCK_RECEIVING_LIGHT_ROUTE_TABLES];
    if (
        pathname === '/sync'
        || pathname === '/about'
        || pathname === '/setup'
        || pathname === '/settings'
        || pathname.startsWith('/settings/')
    ) return [...SETTINGS_LIGHT_ROUTE_TABLES];
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
const MARIADB_RESTORE_MAINTENANCE_KEY = 'restore_maintenance_owner';
const MARIADB_RESTORE_MAINTENANCE_CODE = 'MARIADB_RESTORE_MAINTENANCE';
const SERVER_DATA_EPOCH_KEY = 'server_data_epoch';
const SERVER_DATA_EPOCH_SEEN_KEY = 'server_data_epoch_seen';
const SERVER_DATA_EPOCH_MISMATCH_CODE = 'ONLINE_FINANCIAL_INTENT_EPOCH_MISMATCH';
const REPORT_EPOCH_CACHE_KEY = 'report_epoch_cache';
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

export function isReportEpochStaleConflict(
    conflict: Pick<SyncConflict, 'reason'>,
): boolean {
    return String(conflict.reason || '').includes('REPORT_EPOCH_STALE');
}

export function isServerDataEpochMismatchConflict(
    conflict: Pick<SyncConflict, 'reason'>,
): boolean {
    const reason = String(conflict.reason || '');
    return reason.includes(SERVER_DATA_EPOCH_MISMATCH_CODE)
        || reason.includes('MariaDB was restored/replaced at');
}

export function isRetainedLocalSaleConflict(
    conflict: Pick<SyncConflict, 'reason'>,
): boolean {
    return isReportEpochStaleConflict(conflict)
        || isServerDataEpochMismatchConflict(conflict);
}

export function canRetrySyncConflict(
    conflict: Pick<SyncConflict, 'reason' | 'table_name'>,
): boolean {
    return !isRetainedLocalSaleConflict(conflict)
        && conflict.table_name !== '_online_financial_intent';
}

export function syncConflictSaleReference(
    conflict: Pick<SyncConflict, 'data'> & Partial<Pick<SyncConflict, 'table_name'>>,
): string {
    try {
        const data = JSON.parse(conflict.data);
        const order = data?.order;
        if (order?.orderNumber) return `receipt #${order.orderNumber}`;
        if (order?.receiptKey) return `receipt ${order.receiptKey}`;
        if (order?.id) return `sale ${order.id}`;
        if (data?.id) return `${conflict.table_name || 'local'} change ${data.id}`;
        if (data?.key) return `${conflict.table_name || 'setting'} change ${data.key}`;
    } catch {
        // The reason remains useful even when an older conflict has invalid data.
    }
    return 'this local sale';
}

export async function getSyncConflicts(): Promise<SyncConflict[]> {
    const d = await sqlite.getDb();
    return d.select(`SELECT * FROM _sync_conflicts ORDER BY created_at DESC`);
}

export async function dismissSyncConflict(
    id: string,
    options: { acknowledgeRetainedLocalSale?: boolean } = {},
): Promise<void> {
    const d = await sqlite.getDb();
    const rows: SyncConflict[] = await d.select(
        `SELECT * FROM _sync_conflicts WHERE id = ? LIMIT 1`,
        [id],
    );
    if (rows[0] && isRetainedLocalSaleConflict(rows[0]) && !options.acknowledgeRetainedLocalSale) {
        throw new Error(
            `${syncConflictSaleReference(rows[0])} remains stored on this till and will not be uploaded. ` +
            'Confirm that you only want to dismiss the warning.',
        );
    }
    await d.execute(`DELETE FROM _sync_conflicts WHERE id = ?`, [id]);
}

export async function retrySyncConflict(id: string): Promise<void> {
    const d = await sqlite.getDb();
    const rows: SyncConflict[] = await d.select(`SELECT * FROM _sync_conflicts WHERE id = ? LIMIT 1`, [id]);
    const conflict = rows[0];
    if (!conflict) return;
    if (isRetainedLocalSaleConflict(conflict)) {
        if (isServerDataEpochMismatchConflict(conflict)) {
            throw new Error(
                'A local change quarantined after a MariaDB restore cannot be retried automatically. ' +
                'Review the restored data, then dismiss the conflict.',
            );
        }
        throw new Error(
            'A sale rejected by a report or restored-database epoch fence cannot be retried automatically. ' +
            'It remains in this till for administrator review.',
        );
    }
    if (conflict.table_name === '_online_financial_intent') {
        throw new Error(
            'A financial transaction quarantined after a MariaDB restore cannot be retried. ' +
            'Review the conflict and the customer or sale balance, then dismiss it.',
        );
    }
    const data = JSON.parse(conflict.data);
    if (conflict.operation === 'saleBundle' && data?.order?.type === 'return') {
        throw new Error('A rejected refund or void cannot be retried. Review it, then dismiss this conflict.');
    }
    const idKey = conflict.table_name === 'settings' ? 'key' : 'id';
    await d.execute(
        `INSERT OR REPLACE INTO _offline_queue (id, table_name, operation, data, id_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
            conflict.id,
            conflict.table_name,
            conflict.operation,
            conflict.data,
            idKey,
            new Date().toISOString(),
        ],
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
async function captureServerDataEpochForMutation(): Promise<string> {
    if (!isMultiMode()) return '';
    const d = await sqlite.getDb();
    const rows: any[] = await d.select(
        'SELECT value FROM settings WHERE key = ? LIMIT 1',
        [SERVER_DATA_EPOCH_SEEN_KEY],
    );
    return String(rows[0]?.value || '').trim();
}

async function queueOffline(
    tableName: string,
    operation: 'upsert' | 'remove' | 'adjustStock' | 'saleBundle' | 'promotionBundle' | 'promotionDelete' | 'limitGoodsMenuItems',
    data: any,
    idKey: string = 'id',
    expectedServerDataEpoch?: string,
): Promise<string> {
    if (tableName === 'customer_accounts'
        || tableName === 'customer_account_entries'
        || (operation === 'saleBundle' && Array.isArray(data?.accountChanges) && data.accountChanges.length > 0)) {
        throw new Error('Customer-account balance changes are online-only and cannot be queued');
    }
    const d = await sqlite.getDb();
    const capturedEpoch = expectedServerDataEpoch === undefined
        ? await captureServerDataEpochForMutation()
        : expectedServerDataEpoch;
    const serverDataEpoch = String(
        expectedServerDataEpoch ?? data?.serverDataEpoch ?? capturedEpoch ?? '',
    ).trim();
    const queuedData = data && typeof data === 'object' && !Array.isArray(data)
        ? { ...data, serverDataEpoch }
        : data;
    const id = crypto.randomUUID();
    await d.execute(
        `INSERT INTO _offline_queue (id, table_name, operation, data, id_key, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [id, tableName, operation, JSON.stringify(queuedData), idKey, new Date().toISOString()]
    );
    offlineQueueFlushRequested = true;
    console.log(`database: queued offline ${operation} for ${tableName}`);
    return id;
}

async function commitMysqlOutboxOperation(
    tableName: string,
    operation: 'upsert' | 'remove' | 'adjustStock' | 'promotionBundle' | 'promotionDelete' | 'limitGoodsMenuItems',
    data: any,
    idKey: string,
    serverDataEpoch: string,
): Promise<void> {
    const config = get(connectionState).mysqlConfig;
    if (!config) throw new Error('MariaDB configuration is unavailable');
    await invoke('commit_mysql_outbox_operation', {
        mysqlUri: buildMysqlUri(config),
        tableName,
        operation,
        data,
        idKey,
        serverDataEpoch,
    });
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

const AUDIT_BOOLEAN_FIELDS = new Set([
    'autoApply',
    'isActive',
    'isDefault',
    'isAgeRestricted',
    'isPriceOverride',
    'isWeighable',
    'showInGoods',
    'trackStock',
]);

function comparableAuditValue(value: any, key = ''): any {
    // SQLite and form controls can represent the same empty/boolean value differently.
    if (value === undefined || value === null || value === '') return '';
    if (AUDIT_BOOLEAN_FIELDS.has(key)) {
        if (value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true') return true;
        if (value === false || value === 0 || value === '0' || String(value).toLowerCase() === 'false') return false;
    }
    if (Array.isArray(value)) return value.map(item => comparableAuditValue(item));
    if (typeof value === 'object') {
        const result: Record<string, any> = {};
        for (const [childKey, childValue] of Object.entries(value)) {
            if (childKey === 'updatedAt') continue;
            result[childKey] = comparableAuditValue(childValue, childKey);
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
    if (!isTauri()) {
        auditLogDB.update((logs) => [row, ...logs.filter((log) => log.id !== row.id)]);
        return;
    }
    const serverDataEpoch = await captureServerDataEpochForMutation();
    await sqlite.upsert('audit_logs', row, 'id');
    if (!isMultiMode()) return;
    await queueOffline('audit_logs', 'upsert', row, 'id', serverDataEpoch);
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
    const serverDataEpoch = String(data?.serverDataEpoch || '').trim();
    if (row.operation === 'upsert') {
        if (PROMOTION_SYNC_TABLE_SET.has(row.table_name)) {
            await flushQueuedPromotionUpsert(row, data, mysqlDb, d, serverDataEpoch);
        } else {
            await commitMysqlOutboxOperation(
                row.table_name,
                'upsert',
                data,
                row.id_key || 'id',
                serverDataEpoch,
            );
        }
    } else if (row.operation === 'remove') {
        await commitMysqlOutboxOperation(
            row.table_name,
            'remove',
            data,
            row.id_key || 'id',
            serverDataEpoch,
        );
    } else if (row.operation === 'adjustStock') {
        await commitMysqlOutboxOperation(
            row.table_name,
            'adjustStock',
            data,
            row.id_key || 'id',
            serverDataEpoch,
        );
    } else if (row.operation === 'saleBundle') {
        const config = get(connectionState).mysqlConfig;
        if (!config) throw new Error('MariaDB configuration is unavailable');
        await invoke('commit_mysql_sale', { mysqlUri: buildMysqlUri(config), bundle: data });
    } else if (row.operation === 'stockReceiptBundle') {
        const config = get(connectionState).mysqlConfig;
        if (!config) throw new Error('MariaDB configuration is unavailable');
        await invoke('commit_mysql_stock_receipt', { mysqlUri: buildMysqlUri(config), bundle: data });
    } else if (row.operation === 'promotionBundle') {
        const refs = await promotionRefsForQueuedRow(row, data);
        if (await remoteHasPromotionDelete(mysqlDb, refs)) {
            await applyRemotePromotionDeleteLocally(d, refs);
        } else {
            await commitMysqlOutboxOperation(
                row.table_name,
                'promotionBundle',
                data,
                row.id_key || 'id',
                serverDataEpoch,
            );
        }
    } else if (row.operation === 'promotionDelete') {
        await commitMysqlOutboxOperation(
            row.table_name,
            'promotionDelete',
            data,
            row.id_key || 'id',
            serverDataEpoch,
        );
    } else if (row.operation === 'limitGoodsMenuItems') {
        await commitMysqlOutboxOperation(
            row.table_name,
            'limitGoodsMenuItems',
            data,
            row.id_key || 'id',
            serverDataEpoch,
        );
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
             WHERE created_at <= ?
               AND operation <> 'saleBundle'
               AND table_name IN ('orders','order_lines','payments','shifts','cash_movements','inventory_logs','audit_logs')`,
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
                CASE WHEN operation IN ('saleBundle', 'stockReceiptBundle') THEN 0
                     WHEN table_name = 'orders' THEN 2
                     WHEN table_name = 'order_lines' THEN 3
                     WHEN table_name = 'audit_logs' THEN 4
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
                if (data && (
                    String(error).includes('SYNC_CONFLICT')
                    || String(error).includes('REPORT_EPOCH_STALE')
                    || String(error).includes(SERVER_DATA_EPOCH_MISMATCH_CODE)
                    || isReversalConflict(error, data)
                )) {
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
                const maxAttempts = row.operation === 'saleBundle' || row.operation === 'stockReceiptBundle'
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

async function flushQueuedPromotionUpsert(
    row: any,
    data: any,
    mysqlDb: any,
    d: any,
    serverDataEpoch: string,
): Promise<void> {
    const refs = await promotionRefsForQueuedRow(row, data);
    if (await remoteHasPromotionDelete(mysqlDb, refs)) {
        await applyRemotePromotionDeleteLocally(d, refs);
        return;
    }

    if (refs?.groupId) {
        const bundle = await getLocalPromotionBundleByGroupId(refs.groupId);
        if (bundle) {
            await commitMysqlOutboxOperation(
                'promotion_bundle',
                'promotionBundle',
                { ...bundle, serverDataEpoch },
                'id',
                serverDataEpoch,
            );
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
            for (const product of products) {
                await commitMysqlOutboxOperation(
                    'products',
                    'upsert',
                    { ...product, serverDataEpoch },
                    'id',
                    serverDataEpoch,
                );
            }
        }
    }

    if (row.table_name === 'discounts' && data?.groupId && !(await remotePromotionGroupExists(mysqlDb, data.groupId))) {
        await d.execute(`DELETE FROM discounts WHERE id = ?`, [data?.id]);
        return;
    }

    await commitMysqlOutboxOperation(
        row.table_name,
        'upsert',
        data,
        row.id_key || 'id',
        serverDataEpoch,
    );
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

async function queueLocalProductSnapshot(
    productId: string,
    fallback?: any,
    expectedServerDataEpoch?: string,
): Promise<string> {
    const d = await sqlite.getDb();
    const rows: any[] = await d.select('SELECT * FROM products WHERE id = ? LIMIT 1', [productId]);
    const product = rows[0] || fallback;
    if (!product) throw new Error(`Cannot queue product ${productId}; no local snapshot exists`);
    return queueOffline('products', 'upsert', product, 'id', expectedServerDataEpoch);
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
    'pos_mode', 'mysql_config', 'till_id', 'till_name', 'till_name_manual', 'till_seq',
    RECEIPT_HIGH_WATER_KEY,
    'automatic_setup_backup_enabled', 'automatic_setup_backup_time',
    'automatic_setup_backup_directory', 'backup_directory',
    'last_sync_time', 'last_fast_sync_time', 'bootstrap_uploaded',
    'transaction_purge_applied_at', 'sync_change_cursor', RESTORE_PENDING_MARIADB_REPLACE_KEY,
    REPORT_EPOCH_CACHE_KEY,
    'training_mode_enabled',
    'owner_cloud_reporter_password',
    'cctv_pos_enabled', 'cctv_pos_host', 'cctv_pos_port', 'cctv_pos_number',
    'cctv_pos_name', 'cctv_pos_source_ip', 'cctv_pos_encoding',
    'cctv_pos_line_width', 'cctv_pos_send_items', 'cctv_pos_send_receipts',
    'cctv_pos_framing', 'cctv_pos_start_marker', 'cctv_pos_line_separator',
    'cctv_pos_end_marker',
    'cash_drawer_enabled', 'cash_drawer_printer_host', 'cash_drawer_printer_port',
    'cash_drawer_printer_name', 'cash_drawer_printer_device_path',
    'cash_drawer_module_id', 'cash_drawer_module_device_id', 'cash_drawer_baud_rate',
    'cash_drawer_pin', 'cash_drawer_pulse_on_ms', 'cash_drawer_pulse_off_ms',
    'receipt_printer_enabled', 'receipt_printer_connection', 'receipt_printer_host',
    'receipt_printer_port', 'receipt_printer_name', 'receipt_printer_device_path',
    'receipt_printer_module_id', 'receipt_printer_module_device_id',
    'receipt_printer_baud_rate', 'receipt_printer_paper_width', 'receipt_printer_model',
    'receipt_printer_auto_print_after_payment', 'receipt_printer_cut_paper',
    'receipt_printer_cut_feed_lines',
    'receipt_printer_open_drawer_after_cash', 'receipt_printer_open_drawer_after_payment',
    'receipt_printer_encoding',
    'label_printer_enabled', 'label_printer_connection', 'label_printer_protocol',
    'label_printer_host', 'label_printer_port', 'label_printer_name',
    'label_printer_device_path', 'label_printer_module_id', 'label_printer_module_device_id',
    'label_printer_baud_rate', 'label_printer_cut_paper',
    'label_printer_gap_lines', 'label_printer_dpi',
    'scale_hardware_enabled', 'scale_hardware_device_path', 'scale_hardware_baud_rate',
    'scale_hardware_poll_ms', 'scale_hardware_request_mode',
    // Speaker and vibration support differs by till. Keep operator feedback
    // independent so changing a noisy till does not alter every other till.
    'feedback_button_sound_enabled', 'feedback_item_sound_enabled', 'feedback_scan_sound_enabled',
    'feedback_haptics_enabled', 'feedback_sale_sound_enabled', 'barcode_error_sound',
    // Server-side control rows — never copy between tills.
    'till_seq_counter', 'bootstrap_done', MARIADB_RESTORE_MAINTENANCE_KEY,
    SERVER_DATA_EPOCH_SEEN_KEY,
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
// Shop B's MariaDB database. The signed manual licence is bound to this same
// stable shop identity, independently of the individual till name or ID.

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

async function claimRemoteAppIdentity(remote: any, candidate: AppIdentity): Promise<AppIdentity> {
    // Two legacy tills may upgrade at the same time. INSERT-without-overwrite
    // makes the first verified claim authoritative; every other till adopts the
    // same row instead of racing to replace it with a different random shop ID.
    await remote.execute(
        `INSERT INTO app_identity
            (id, shopId, shopName, licenseId, createdAt, updatedAt, identitySignature)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE id = id`,
        [
            candidate.id,
            candidate.shopId,
            candidate.shopName,
            candidate.licenseId,
            candidate.createdAt,
            candidate.updatedAt,
            candidate.identitySignature,
        ],
    );
    const rows: any[] = await remote.select(
        `SELECT * FROM app_identity WHERE id = ? LIMIT 1`,
        [APP_IDENTITY_ID],
    );
    const claimed = normalizeIdentity(rows[0] || null);
    if (!claimed) throw new Error('MariaDB did not retain a valid shop identity after the legacy upgrade claim');
    return claimed;
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

function identityUnverifiedMessage(
    localIdentity: AppIdentity | null,
    remoteIdentity: AppIdentity | null,
    localName: string,
    remoteName: string,
): string {
    const comparableLocalName = localIdentity?.shopName || localName;
    const comparableRemoteName = remoteIdentity?.shopName || remoteName;
    return `DATABASE_IDENTITY_UNVERIFIED: This till and MariaDB both contain shop data, but one or both sides lack a stable shop identity. ` +
        `Matching shop names are not sufficient proof. Local shop: ${comparableLocalName || 'unknown'}. ` +
        `MariaDB shop: ${comparableRemoteName || 'unknown'}. ` +
        `Automatic legacy adoption requires this till's UUID to already exist in MariaDB or an exact completed receipt on both sides. ` +
        `Sync has been blocked without changing MariaDB.`;
}

async function remoteTableExistsReadOnly(remote: any, table: string): Promise<boolean> {
    const rows: any[] = await remote.select(
        `SELECT 1 AS present
         FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
         LIMIT 1`,
        [table],
    );
    return rows.length > 0;
}

async function remoteTableHasColumnReadOnly(remote: any, table: string, column: string): Promise<boolean> {
    const rows: any[] = await remote.select(
        `SELECT 1 AS present
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
         LIMIT 1`,
        [table, column],
    );
    return rows.length > 0;
}

async function getRemoteAppIdentityReadOnly(remote: any): Promise<AppIdentity | null> {
    if (!await remoteTableExistsReadOnly(remote, 'app_identity')
        || !await remoteTableHasColumnReadOnly(remote, 'app_identity', 'shopId')) return null;
    const rows: any[] = await remote.select(
        `SELECT * FROM app_identity WHERE id = ? LIMIT 1`,
        [APP_IDENTITY_ID],
    );
    return normalizeIdentity(rows[0] || null);
}

async function getRemoteStoreNameReadOnly(remote: any): Promise<string> {
    if (!await remoteTableExistsReadOnly(remote, 'settings')) return '';
    const rows: any[] = await remote.select(
        "SELECT value FROM settings WHERE `key` = 'store_info' LIMIT 1",
    );
    try {
        return rows[0]?.value ? String(JSON.parse(rows[0].value)?.name || '') : '';
    } catch {
        return '';
    }
}

async function countRemoteBusinessDataReadOnly(remote: any): Promise<BusinessDataCounts> {
    const counts = normalizeBusinessCounts({});
    for (const table of ['products', 'categories', 'orders', 'customers'] as const) {
        if (!await remoteTableExistsReadOnly(remote, table)) continue;
        const rows: any[] = await remote.select(`SELECT COUNT(*) AS count FROM ${table}`);
        counts[table] = Number(rows[0]?.count || 0);
    }
    return counts;
}

async function getStrongLegacySharedDataProof(remote: any): Promise<LegacySharedDataProof> {
    return findStrongLegacySharedDataProof(await sqlite.getDb(), remote);
}

async function readRemoteRestoreMaintenanceOwner(remote: any): Promise<string> {
    if (await remoteTableExistsReadOnly(remote, 'pos_restore_gate')) {
        const gateRows: any[] = await remote.select(
            `SELECT CAST(ownerTillId AS CHAR CHARACTER SET utf8mb4) AS ownerTillId
             FROM pos_restore_gate
             WHERE id = 1 AND isActive = 1 LIMIT 1`,
        );
        const gateOwner = String(gateRows[0]?.ownerTillId || '').trim();
        if (gateOwner) return gateOwner;
    }
    if (!await remoteTableExistsReadOnly(remote, 'settings')) return '';
    const rows: any[] = await remote.select(
        `SELECT value FROM settings WHERE \`key\` = ? LIMIT 1`,
        [MARIADB_RESTORE_MAINTENANCE_KEY],
    );
    return String(rows[0]?.value || '').trim();
}

/** Stop payment/provider work before it creates an irreversible external side effect. */
export async function assertMariaDbCommerceWritesAllowed(
    options: { allowPreparing?: boolean } = {},
): Promise<void> {
    if (!isMultiMode()) return;
    const remote = await getMysqlDb();
    if (!remote) throw new Error('MariaDB is unavailable');
    await assertMariaDbNotInRestoreMaintenance(remote);
    const closeBarrier = await mysql.mysqlGetWholeSystemCloseBarrier();
    if (closeBarrier.state === 'frozen'
        || (closeBarrier.state === 'preparing' && !options.allowPreparing)) {
        throw new Error(
            `WHOLE_SYSTEM_CLOSE_IN_PROGRESS: Financial activity is paused while the whole-system report is closing.`,
        );
    }
}

async function readLocalTillIdWithoutCreating(): Promise<string> {
    const local = await sqlite.getDb();
    const rows: any[] = await local.select(
        `SELECT value FROM settings WHERE key = 'till_id' LIMIT 1`,
    );
    return String(rows[0]?.value || '').trim();
}

async function assertMariaDbNotInRestoreMaintenance(
    remote: any,
    allowPendingRestoreOwner = false,
): Promise<void> {
    const owner = await readRemoteRestoreMaintenanceOwner(remote);
    if (!owner) return;
    if (allowPendingRestoreOwner
        && await hasRestorePendingMariaDbReplace()
        && owner === await readLocalTillIdWithoutCreating()) return;
    throw new Error(
        `${MARIADB_RESTORE_MAINTENANCE_CODE}: MariaDB is locked for a restore by till ${owner}. ` +
        `Normal setup and sync are blocked until that restore finishes.`,
    );
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

/**
 * Read-only guard which must run before initMysqlDb performs any DDL or data
 * repair. It permits an empty/new side, but two populated databases must both
 * carry the same stable shop ID; matching display names are not proof.
 */
export async function verifyDatabaseIdentityBeforeSchemaMutation(): Promise<void> {
    if (!isMultiMode()) return;
    const remote = await getMysqlDb();
    if (!remote) throw new Error('MariaDB is unavailable');
    await assertMariaDbNotInRestoreMaintenance(remote, true);

    const [localIdentity, remoteIdentity, localCounts, remoteCounts, localName, remoteName] =
        await Promise.all([
            getLocalAppIdentity(),
            getRemoteAppIdentityReadOnly(remote),
            countLocalBusinessData(),
            countRemoteBusinessDataReadOnly(remote),
            getLocalStoreName(),
            getRemoteStoreNameReadOnly(remote),
        ]);
    const localHasData = hasBusinessData(localCounts);
    const remoteHasData = hasBusinessData(remoteCounts);
    if (!localHasData || !remoteHasData) return;

    if (localIdentity && remoteIdentity) {
        if (localIdentity.shopId !== remoteIdentity.shopId) {
            throw new DatabaseIdentityMismatchError(identityMismatchMessage(localIdentity, remoteIdentity));
        }
        return;
    }

    if (await getStrongLegacySharedDataProof(remote)) return;
    throw new Error(identityUnverifiedMessage(localIdentity, remoteIdentity, localName, remoteName));
}

/**
 * Publish the locally verified manual licence to the shared shop identity.
 * The native command writes SQLite first; this mirrors the signed token to
 * MariaDB or leaves it in the durable outbox when the server is unavailable.
 */
export async function syncManualLicenseIdentity(): Promise<void> {
    if (!isMultiMode()) return;
    const serverDataEpoch = await captureServerDataEpochForMutation();
    const identity = await getLocalAppIdentity();
    if (!identity?.identitySignature) return;

    if (get(connectionState).mysqlOnline) {
        try {
            await commitMysqlOutboxOperation(
                'app_identity',
                'upsert',
                identity,
                'id',
                serverDataEpoch,
            );
            return;
        } catch (error) {
            console.warn('database: licence sync deferred:', error);
            connectionState.update((state) => ({
                ...state,
                mysqlOnline: false,
                syncError: String(error),
            }));
        }
    }
    await queueOffline('app_identity', 'upsert', identity, 'id', serverDataEpoch);
}

export async function ensureDatabaseIdentityForSync(): Promise<AppIdentity | null> {
    if (!isMultiMode()) return ensureLocalShopIdentity();

    const remoteDb = await getMysqlDb();
    if (!remoteDb) return getLocalAppIdentity();
    await assertMariaDbNotInRestoreMaintenance(remoteDb);

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

    const remoteHasBusinessData = await remoteHasShopData();
    let legacyProof: LegacySharedDataProof = null;
    if (localHasBusinessData && remoteHasBusinessData) {
        legacyProof = await getStrongLegacySharedDataProof(remoteDb);
        if (!legacyProof) {
            throw new Error(identityUnverifiedMessage(localIdentity, remoteIdentity, localName, remoteName));
        }
    }

    if (!localIdentity && remoteIdentity) {
        if (legacyProof) {
            await saveLocalAppIdentity(remoteIdentity);
            return remoteIdentity;
        }
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
        if (legacyProof) {
            const candidate = {
                ...localIdentity,
                shopName: localIdentity.shopName || localName || remoteName,
                updatedAt: new Date().toISOString(),
            };
            const identity = await claimRemoteAppIdentity(remoteDb, candidate);
            await saveLocalAppIdentity(identity);
            return identity;
        }
        if (remoteHasBusinessData) {
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

    if (legacyProof) {
        const identity = await claimRemoteAppIdentity(
            remoteDb,
            makeIdentity(remoteName || localName),
        );
        await saveLocalAppIdentity(identity);
        return identity;
    }

    if (namesConflict(localName, remoteName) && remoteHasBusinessData
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

interface TransactionPurgeResult {
    marker: string;
    tillNumbers: string[];
}

const RFC3339_REPORT_EPOCH =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function canonicalReportEpoch(value: unknown): string {
    const candidate = String(value || '').trim();
    if (!candidate || !RFC3339_REPORT_EPOCH.test(candidate)) return '';
    const millis = Date.parse(candidate);
    return Number.isFinite(millis) ? new Date(millis).toISOString() : '';
}

function newestCanonicalReportEpoch(...values: unknown[]): string {
    let newest = '';
    let newestMillis = Number.NEGATIVE_INFINITY;
    for (const value of values) {
        const canonical = canonicalReportEpoch(value);
        if (!canonical) continue;
        const millis = Date.parse(canonical);
        if (millis > newestMillis) {
            newest = canonical;
            newestMillis = millis;
        }
    }
    return newest;
}

async function writeLocalReportEpochCache(marker: unknown): Promise<string> {
    const canonical = canonicalReportEpoch(marker);
    if (!canonical) {
        if (String(marker || '').trim()) {
            throw new Error(`Invalid whole-system report marker: ${String(marker)}`);
        }
        return '';
    }
    const localDb = await sqlite.getDb();
    const stamp = new Date().toISOString();
    await localDb.execute(
        `INSERT INTO settings (key, value, updatedAt) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updatedAt = excluded.updatedAt`,
        [REPORT_EPOCH_CACHE_KEY, canonical, stamp],
    );
    return canonical;
}

async function purgeLocalTransactionsBefore(
    marker: string,
    remoteTillNumbers: string[] = [],
): Promise<TransactionPurgeResult> {
    if (!isTauri()) {
        throw new Error('Transaction history purge is only available in the installed app');
    }
    // Advance the local commit fence before native purge work yields. If the
    // local history cleanup later fails, new sales still cannot carry the old
    // report epoch into MariaDB.
    if (isMultiMode()) await writeLocalReportEpochCache(marker);
    return invoke<TransactionPurgeResult>('purge_local_transactions', {
        marker,
        remoteTillNumbers,
    });
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
async function recordTombstone(
    table: string,
    id: string,
    expectedServerDataEpoch?: string,
): Promise<void> {
    const serverDataEpoch = expectedServerDataEpoch
        ?? await captureServerDataEpochForMutation();
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
        () => queueOffline('tombstones', 'upsert', tomb, 'id', serverDataEpoch),
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
    'app_identity',
    'categories', 'products', 'product_images', 'pos_pages', 'pos_tiles',
    'tax_rates', 'discounts', 'promo_groups', 'promo_group_items',
    'employees', 'settings', 'customers', 'registers',
    'customer_accounts', 'customer_account_entries',
    'suppliers', 'product_suppliers', 'inventory_logs',
    'orders', 'order_lines', 'payments',
    'loyalty_logs', 'audit_logs', 'shifts', 'cash_movements',
    'till_report_markers', 'manager_approvals',
    'stock_receipts', 'stock_receipt_lines'
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
    'customer_accounts',
    'customer_account_entries',
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
        customer_accounts: Number(row.customer_accounts || 0),
        customer_account_entries: Number(row.customer_account_entries || 0),
        tax_rates: Number(row.tax_rates || 0),
        registers: Number(row.registers || 0),
    };
}

async function localCompletenessCounts(localDb: any): Promise<RemoteCompletenessCounts> {
    const rows: any[] = await localDb.select(
        `SELECT (SELECT COUNT(*) FROM products) AS products,
                (SELECT COUNT(*) FROM categories) AS categories,
                (SELECT COUNT(*) FROM customers) AS customers,
                (SELECT COUNT(*) FROM customer_accounts) AS customer_accounts,
                (SELECT COUNT(*) FROM customer_account_entries) AS customer_account_entries,
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
                (SELECT COUNT(*) FROM customer_accounts) AS customer_accounts,
                (SELECT COUNT(*) FROM customer_account_entries) AS customer_account_entries,
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
        {
            label: 'Customer accounts pointing to missing customers',
            tables: ['customer_accounts', 'customers'],
            sql: `SELECT COUNT(*) AS count
                  FROM customer_accounts a LEFT JOIN customers c ON c.id = a.customerId
                  WHERE c.id IS NULL`,
        },
        {
            label: 'Customer account entries pointing to missing accounts',
            tables: ['customer_account_entries', 'customer_accounts'],
            sql: `SELECT COUNT(*) AS count
                  FROM customer_account_entries e LEFT JOIN customer_accounts a ON a.id = e.accountId
                  WHERE a.id IS NULL`,
        },
    ];

    for (const check of orphanChecks) {
        const hasTables = await Promise.all(check.tables.map((table) => localTableExists(localDb, table)));
        if (hasTables.every(Boolean)) {
            await addRestoreIssueForCount(localDb, issues, check.label, check.sql);
        }
    }

    if (await localTableExists(localDb, 'customer_accounts')
        && await localTableExists(localDb, 'customer_account_entries')) {
        await addRestoreIssueForCount(
            localDb,
            issues,
            'Customer accounts with a balance that does not match their ledger',
            `SELECT COUNT(*) AS count FROM (
                SELECT a.id
                FROM customer_accounts a
                LEFT JOIN customer_account_entries e ON e.accountId = a.id
                GROUP BY a.id, a.balancePence
                HAVING a.balancePence <> COALESCE(SUM(e.amountPence), 0)
            ) mismatched_accounts`,
        );
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

async function upsertAfterClosePreflight(table: string, obj: any, idKey: string = 'id'): Promise<void> {
    if (table === 'customer_account_entries') {
        throw new Error('Customer-account entries are append-only; use postCustomerAccountEntry');
    }
    if (table === 'customer_accounts') {
        throw new Error('Use saveCustomerAccountConfig to change a customer account');
    }
    const serverDataEpoch = await captureServerDataEpochForMutation();
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
            () => queueOffline(table, 'upsert', obj, idKey, serverDataEpoch),
        );
        return;
    }

    await pushWriteInBackground(
        `upsert for ${table}`,
        () => mysql.mysqlUpsert(table, obj, idKey),
        () => queueOffline(table, 'upsert', obj, idKey, serverDataEpoch),
    );
}

export async function upsert(table: string, obj: any, idKey: string = 'id'): Promise<void> {
    if (!isMultiMode() || !WHOLE_SYSTEM_CLOSE_LOCAL_GUARDED_TABLES.has(table)) {
        return upsertAfterClosePreflight(table, obj, idKey);
    }
    return wholeSystemCloseLocalMutex.runExclusive(async () => {
        await assertMariaDbCommerceWritesAllowed();
        await upsertAfterClosePreflight(table, obj, idKey);
    });
}

/** Save customer profiles server-first so a duplicate loyalty code cannot win on two tills. */
export async function saveCustomerProfile(customer: any): Promise<void> {
    if (!customer?.id) throw new Error('Customer ID is required');
    const serverDataEpoch = await captureServerDataEpochForMutation();
    const auditBefore = await getAuditBefore('customers', customer, 'id');

    if (isMultiMode()) {
        const state = get(connectionState);
        if (!state.mysqlOnline) {
            throw new Error('Customer changes require the shared MariaDB database to be online');
        }
        await commitMysqlOutboxOperation(
            'customers',
            'upsert',
            customer,
            'id',
            serverDataEpoch,
        );
    }

    await sqlite.upsert('customers', customer, 'id');
    if (shouldAuditTableMutation('customers', customer)) {
        const auditAfter = await getLocalRow('customers', 'id', customer.id);
        await recordTableAudit(
            'customers',
            auditBefore ? 'updated' : 'created',
            'id',
            auditBefore,
            auditAfter || customer,
        );
    }
}

async function removeAfterClosePreflight(table: string, id: string, idKey: string = 'id'): Promise<void> {
    if (table === 'customer_account_entries' || table === 'customer_accounts') {
        throw new Error('Customer-account records cannot be deleted; post a reversing entry instead');
    }
    const serverDataEpoch = await captureServerDataEpochForMutation();
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
            () => queueOffline(table, 'remove', { id }, idKey, serverDataEpoch),
        );
    } else {
        await pushWriteInBackground(
            `remove for ${table}`,
            () => mysql.mysqlRemove(table, id, idKey),
            () => queueOffline(table, 'remove', { id }, idKey, serverDataEpoch),
        );
    }

    // Record a tombstone so other tills delete the same row on their next sync.
    // Only for id-keyed tables (tombstone apply removes by the `id` column).
    if (idKey === 'id' && table !== 'tombstones') {
        await recordTombstone(table, id, serverDataEpoch);
    }
}

export async function remove(table: string, id: string, idKey: string = 'id'): Promise<void> {
    if (!isMultiMode() || !WHOLE_SYSTEM_CLOSE_LOCAL_GUARDED_TABLES.has(table)) {
        return removeAfterClosePreflight(table, id, idKey);
    }
    return wholeSystemCloseLocalMutex.runExclusive(async () => {
        await assertMariaDbCommerceWritesAllowed();
        await removeAfterClosePreflight(table, id, idKey);
    });
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
    const serverDataEpoch = await captureServerDataEpochForMutation();
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
        () => queueOffline('promotion_bundle', 'promotionBundle', payload, 'id', serverDataEpoch),
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
    const serverDataEpoch = await captureServerDataEpochForMutation();
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

    for (const itemId of targets.itemIds) await recordTombstone('promo_group_items', itemId, serverDataEpoch);
    for (const id of discountIds) await recordTombstone('discounts', id, serverDataEpoch);
    if (groupId) await recordTombstone('promo_groups', groupId, serverDataEpoch);
    await hydrateSvelteStores(PROMOTION_SYNC_TABLES);

    await writeOrQueueImmediately(
        `promotion delete ${discountId || groupId}`,
        () => mysql.mysqlDeletePromotionBundle(discountIds, groupId),
        () => queueOffline(
            'promotion_delete',
            'promotionDelete',
            { discountIds, groupId },
            'id',
            serverDataEpoch,
        ),
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
    const serverDataEpoch = await captureServerDataEpochForMutation();

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
            await commitMysqlOutboxOperation(
                'promotion_bundle',
                'promotionBundle',
                { group, discount, items, products, serverDataEpoch },
                'id',
                serverDataEpoch,
            );
            pushed++;
        }
    }

    if (pushed > 0) console.log(`database: repaired ${pushed} local promotion package(s) to MariaDB`);
    return pushed;
}

// ─── Read Operations ────────────────────────────────────────────────────────

export async function searchProduct(query: string): Promise<any | null> {
    if (!isTauri()) {
        const barcode = String(query || '').trim();
        if (!barcode) return null;
        return get(productsDB).find((product) => product.isActive && product.barcode === barcode) || null;
    }
    // Always search local SQLite for speed (barcode scanning must be instant)
    return sqlite.searchProduct(query);
}

export async function searchProductByScalePlu(scalePlu: string): Promise<any | null> {
    if (!isTauri()) {
        const normalizedPlu = String(scalePlu || '').trim();
        if (!normalizedPlu) return null;
        return get(productsDB).find((product) => product.isActive && product.scalePlu === normalizedPlu) || null;
    }
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

export interface SaveCustomerAccountConfigInput {
    customerId: string;
    isEnabled: boolean;
    creditLimitPence: number;
    employeeId?: string;
}

export interface PostCustomerAccountEntryInput {
    customerId: string;
    entryType: CustomerAccountEntryType;
    amountPence: number;
    paymentMethod?: CustomerAccountPaymentMethod;
    reference?: string;
    description?: string;
    receiptNumber?: number;
    receiptKey?: string;
    orderId?: string;
    employeeId: string;
    tillNumber?: string;
    shiftId?: string;
    idempotencyKey?: string;
    reversesEntryId?: string;
    allowCreditBalance?: boolean;
    /** Captured before an irreversible managed-terminal request. */
    reportEpoch?: string;
    /** MariaDB dataset identity captured before an irreversible provider request. */
    serverDataEpoch?: string;
}

export interface CustomerAccountEntryPage {
    entries: CustomerAccountEntry[];
    total: number;
}

export interface CustomerAccountMutationResult {
    account: CustomerAccount;
    entry: CustomerAccountEntry;
}

function normalizeAccount(row: any, customerId = ''): CustomerAccount {
    return {
        id: String(row?.id || customerId),
        customerId: String(row?.customerId || customerId),
        isEnabled: Boolean(row?.isEnabled),
        creditLimitPence: Number(row?.creditLimitPence || 0),
        balancePence: Number(row?.balancePence || 0),
        createdAt: String(row?.createdAt || ''),
        updatedAt: String(row?.updatedAt || ''),
    };
}

function normalizeAccountEntry(row: any): CustomerAccountEntry {
    return {
        id: String(row?.id || ''),
        accountId: String(row?.accountId || row?.customerId || ''),
        customerId: String(row?.customerId || ''),
        orderId: String(row?.orderId || ''),
        entryType: row?.entryType,
        amountPence: Number(row?.amountPence || 0),
        paymentMethod: row?.paymentMethod || '',
        reference: String(row?.reference || ''),
        description: String(row?.description || ''),
        receiptNumber: Number(row?.receiptNumber || 0),
        receiptKey: String(row?.receiptKey || ''),
        employeeId: String(row?.employeeId || ''),
        tillNumber: String(row?.tillNumber || ''),
        shiftId: String(row?.shiftId || ''),
        idempotencyKey: String(row?.idempotencyKey || ''),
        reversesEntryId: String(row?.reversesEntryId || ''),
        balanceAfterPence: Number(row?.balanceAfterPence || 0),
        createdAt: String(row?.createdAt || ''),
        updatedAt: String(row?.updatedAt || ''),
    };
}

function cacheBrowserAccount(account: CustomerAccount): void {
    customerAccountsDB.update((accounts) => [
        account,
        ...accounts.filter((candidate) => candidate.customerId !== account.customerId),
    ]);
    customersDB.update((customers) => customers.map((customer) => customer.id === account.customerId
        ? {
            ...customer,
            accountId: account.id,
            accountEnabled: account.isEnabled,
            accountCreditLimitPence: account.creditLimitPence,
            accountBalancePence: account.balancePence,
        }
        : customer));
}

function cacheBrowserAccountEntry(entry: CustomerAccountEntry): void {
    customerAccountEntriesDB.update((entries) => [
        entry,
        ...entries.filter((candidate) => candidate.id !== entry.id),
    ]);
}

async function requireOnlineCustomerAccount(action: string): Promise<MysqlConfig> {
    let state = get(connectionState);
    if (!state.mysqlOnline) {
        await pingMysql();
        state = get(connectionState);
    }
    if (!state.mysqlOnline || !state.mysqlConfig) {
        throw new Error(`${action} requires the shared MariaDB database to be online`);
    }
    return state.mysqlConfig;
}

/** Side-effect-free; a customer without config reads as a disabled zero account. */
export async function getCustomerAccount(customerId: string): Promise<CustomerAccount> {
    const normalizedId = String(customerId || '').trim();
    if (!normalizedId) throw new Error('Customer ID is required');
    if (!isTauri()) {
        return get(customerAccountsDB).find((account) => account.customerId === normalizedId)
            || normalizeAccount(null, normalizedId);
    }
    if (isMultiMode() && get(connectionState).mysqlOnline) {
        try {
            const account = await mysql.mysqlGetCustomerAccount(normalizedId);
            if (account.createdAt) await sqlite.upsert('customer_accounts', account, 'id');
            return account;
        } catch (error) {
            console.warn('database: MariaDB customer account read failed, using local cache:', error);
        }
    }
    return sqlite.getCustomerAccount(normalizedId);
}

export async function getCustomerAccountEntries(
    customerId: string,
    options: { limit?: number; offset?: number } = {},
): Promise<CustomerAccountEntryPage> {
    const normalizedId = String(customerId || '').trim();
    if (!normalizedId) throw new Error('Customer ID is required');
    const limit = Math.max(1, Math.min(200, Math.floor(Number(options.limit || 50))));
    const offset = Math.max(0, Math.floor(Number(options.offset || 0)));
    if (!isTauri()) {
        const entries = get(customerAccountEntriesDB)
            .filter((entry) => entry.customerId === normalizedId)
            .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))
                || right.id.localeCompare(left.id));
        return { entries: entries.slice(offset, offset + limit), total: entries.length };
    }
    if (isMultiMode() && get(connectionState).mysqlOnline) {
        try {
            const page = await mysql.mysqlGetCustomerAccountEntries(normalizedId, { limit, offset });
            if (page.entries.length > 0) {
                await sqlite.bulkUpsert('customer_account_entries', page.entries, 'id');
            }
            return page;
        } catch (error) {
            console.warn('database: MariaDB customer account history read failed, using local cache:', error);
        }
    }
    return sqlite.getCustomerAccountEntries(normalizedId, { limit, offset });
}

export async function saveCustomerAccountConfig(
    input: SaveCustomerAccountConfigInput,
): Promise<CustomerAccount> {
    const customerId = String(input.customerId || '').trim();
    const creditLimitPence = Math.trunc(Number(input.creditLimitPence));
    if (!customerId) throw new Error('Customer ID is required');
    if (!Number.isSafeInteger(creditLimitPence) || creditLimitPence < 0) {
        throw new Error('Credit limit must be a valid non-negative amount');
    }
    const before = await getCustomerAccount(customerId);
    const normalizedInput = {
        customerId,
        isEnabled: Boolean(input.isEnabled),
        creditLimitPence,
        employeeId: String(input.employeeId || currentAuditEmployeeId()),
    };
    let account: CustomerAccount;
    if (!isTauri()) {
        const stamp = new Date().toISOString();
        account = {
            ...before,
            id: customerId,
            customerId,
            isEnabled: normalizedInput.isEnabled,
            creditLimitPence,
            createdAt: before.createdAt || stamp,
            updatedAt: stamp,
        };
        cacheBrowserAccount(account);
    } else if (isMultiMode()) {
        const config = await requireOnlineCustomerAccount('Customer-account changes');
        account = normalizeAccount(await invoke<CustomerAccount>('save_online_customer_account_config', {
            mysqlUri: buildMysqlUri(config),
            input: normalizedInput,
        }), customerId);
        await sqlite.upsert('customer_accounts', account, 'id');
    } else {
        account = normalizeAccount(await invoke<CustomerAccount>('save_local_customer_account_config', {
            input: normalizedInput,
        }), customerId);
    }
    cacheBrowserAccount(account);
    await recordAuditEvent(
        'customer_account_config_updated',
        'customer_account',
        customerId,
        before,
        account,
        normalizedInput.employeeId,
    );
    return account;
}

const ACCOUNT_ENTRY_AUDIT_ACTION: Record<CustomerAccountEntryType, string> = {
    charge: 'customer_account_charge_posted',
    payment: 'customer_account_payment_received',
    adjustment: 'customer_account_adjustment_posted',
    refund: 'customer_account_refund_posted',
    reversal: 'customer_account_reversal_posted',
    opening_balance: 'customer_account_opening_balance_posted',
};

function accountPaymentAcknowledgementNumber(idempotencyKey: string): number {
    let first = 0xdeadbeef ^ idempotencyKey.length;
    let second = 0x41c6ce57 ^ idempotencyKey.length;
    for (let index = 0; index < idempotencyKey.length; index++) {
        const code = idempotencyKey.charCodeAt(index);
        first = Math.imul(first ^ code, 2654435761);
        second = Math.imul(second ^ code, 1597334677);
    }
    first = Math.imul(first ^ (first >>> 16), 2246822507)
        ^ Math.imul(second ^ (second >>> 13), 3266489909);
    second = Math.imul(second ^ (second >>> 16), 2246822507)
        ^ Math.imul(first ^ (first >>> 13), 3266489909);
    return Math.max(1, 4294967296 * (second & 0x1fffff) + (first >>> 0));
}

export async function postCustomerAccountEntry(
    input: PostCustomerAccountEntryInput,
): Promise<CustomerAccountMutationResult> {
    const customerId = String(input.customerId || '').trim();
    const amountPence = Math.trunc(Number(input.amountPence));
    if (!customerId) throw new Error('Customer ID is required');
    if (!ACCOUNT_ENTRY_AUDIT_ACTION[input.entryType]) throw new Error('Unsupported customer-account entry type');
    if (!Number.isSafeInteger(amountPence) || amountPence === 0) {
        throw new Error('Account entry amount must be a non-zero whole number of pence');
    }
    if (input.entryType === 'charge' && amountPence < 0) {
        throw new Error('Account charges must increase the amount owed');
    }
    if ((input.entryType === 'payment' || input.entryType === 'refund') && amountPence > 0) {
        throw new Error('Payments and refunds must reduce the amount owed');
    }
    const paymentMethod = input.paymentMethod || '';
    if (input.entryType === 'payment' && !['cash', 'card', 'other'].includes(paymentMethod)) {
        throw new Error('Account payments require a cash, card, or other payment method');
    }
    const allowCreditBalance = Boolean(input.allowCreditBalance);
    if (allowCreditBalance
        && (input.entryType !== 'payment'
            || paymentMethod !== 'card'
            || !String(input.reference || '').trim())) {
        throw new Error('Only an approved card payment with a terminal reference may create customer credit');
    }
    const requestedIdempotencyKey = String(input.idempotencyKey || '').trim();
    if (!isTauri() && requestedIdempotencyKey) {
        const existingEntry = get(customerAccountEntriesDB)
            .find((entry) => entry.idempotencyKey === requestedIdempotencyKey);
        if (existingEntry) {
            return {
                account: await getCustomerAccount(existingEntry.customerId),
                entry: existingEntry,
            };
        }
    }
    const stamp = new Date().toISOString();
    const id = crypto.randomUUID();
    const idempotencyKey = requestedIdempotencyKey || `customer-account:${id}`;
    const acknowledgementNumber = input.entryType === 'payment'
        ? accountPaymentAcknowledgementNumber(idempotencyKey)
        : 0;
    const normalizedInput = {
        id,
        accountId: customerId,
        customerId,
        orderId: String(input.orderId || ''),
        entryType: input.entryType,
        amountPence,
        paymentMethod,
        reference: String(input.reference || ''),
        description: String(input.description || ''),
        receiptNumber: Math.max(0, Math.trunc(Number(input.receiptNumber || acknowledgementNumber))),
        receiptKey: String(input.receiptKey || (input.entryType === 'payment'
            ? `account-payment:${idempotencyKey}`
            : '')),
        employeeId: String(input.employeeId || currentAuditEmployeeId()),
        tillNumber: String(input.tillNumber || ''),
        shiftId: String(input.shiftId || ''),
        idempotencyKey,
        reversesEntryId: String(input.reversesEntryId || ''),
        allowCreditBalance,
        reportEpoch: input.reportEpoch,
        serverDataEpoch: input.serverDataEpoch,
        balanceAfterPence: 0,
        createdAt: stamp,
        updatedAt: stamp,
    };

    let result: CustomerAccountMutationResult;
    if (!isTauri()) {
        const before = await getCustomerAccount(customerId);
        if (input.entryType === 'opening_balance'
            && get(customerAccountEntriesDB).some((entry) => entry.customerId === customerId)) {
            throw new Error('An opening balance can only be posted before any account activity');
        }
        if (input.entryType === 'charge' && !before.isEnabled) {
            throw new Error('This customer account is on hold');
        }
        const balancePence = before.balancePence + amountPence;
        if (input.entryType === 'payment' && balancePence < 0 && !normalizedInput.allowCreditBalance) {
            throw new Error('The payment is greater than the amount owed');
        }
        if (input.entryType === 'charge'
            && before.creditLimitPence > 0
            && balancePence > before.creditLimitPence) {
            throw new Error('This charge would exceed the customer credit limit');
        }
        const account: CustomerAccount = {
            ...before,
            id: customerId,
            customerId,
            balancePence,
            createdAt: before.createdAt || stamp,
            updatedAt: stamp,
        };
        const entry = normalizeAccountEntry({ ...normalizedInput, balanceAfterPence: balancePence });
        result = { account, entry };
    } else if (isMultiMode()) {
        const config = await requireOnlineCustomerAccount('Customer-account balance changes');
        const epochStampedInput = normalizedInput.reportEpoch !== undefined
            && normalizedInput.serverDataEpoch !== undefined
            ? normalizedInput
            : await withCurrentReportEpoch(normalizedInput, {
                requireLiveServerDataEpoch: true,
            });
        result = await invoke<CustomerAccountMutationResult>('commit_online_customer_account_entry', {
            mysqlUri: buildMysqlUri(config),
            input: epochStampedInput,
        });
    } else {
        result = await invoke<CustomerAccountMutationResult>('commit_local_customer_account_entry', {
            input: normalizedInput,
        });
    }
    result = {
        account: normalizeAccount(result.account, customerId),
        entry: normalizeAccountEntry(result.entry),
    };
    if (isTauri()) {
        try {
            await sqlite.upsert('customer_accounts', result.account, 'id');
            await sqlite.upsert('customer_account_entries', result.entry, 'id');
        } catch (error) {
            console.warn('database: customer-account movement committed but local cache refresh failed:', error);
        }
    }
    cacheBrowserAccount(result.account);
    cacheBrowserAccountEntry(result.entry);
    try {
        await recordAuditEvent(
            ACCOUNT_ENTRY_AUDIT_ACTION[input.entryType],
            'customer_account_entry',
            result.entry.id,
            null,
            { ...result.entry, balancePence: result.account.balancePence },
            normalizedInput.employeeId,
        );
    } catch (error) {
        console.warn('database: customer-account movement committed but audit cache write failed:', error);
    }
    notifyOwnerCloudDataChanged();
    return result;
}

export interface CustomerUsage {
    orders: number;
    loyaltyEntries: number;
    loyaltyPoints: number;
    accountEntries: number;
    accountBalancePence: number;
    sharedVerified: boolean;
}

interface CustomerDeletionResult {
    customerId: string;
    accountIds: string[];
    alreadyDeleted: boolean;
    deletedAt: string;
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
    if (rows.length > 0) return true;
    if (!isMultiMode() || !get(connectionState).mysqlOnline) return false;
    const remote = await getMysqlDb();
    if (!remote) throw new Error('Could not verify the loyalty code against MariaDB');
    const remoteRows: any[] = await remote.select(
        `SELECT 1
         FROM customers
         WHERE loyaltyCode = ?
           AND id <> ?
         LIMIT 1`,
        [normalized, excludeCustomerId],
    );
    return remoteRows.length > 0;
}

export async function getCustomerUsage(customerId: string): Promise<CustomerUsage> {
    const d = await sqlite.getDb();
    const rows: any[] = await d.select(
        `SELECT
            (SELECT COUNT(*) FROM orders WHERE customerId = ?) AS orders,
            (SELECT COUNT(*) FROM loyalty_logs WHERE customerId = ?) AS loyaltyEntries,
            COALESCE((SELECT loyaltyPoints FROM customers WHERE id = ? LIMIT 1), 0) AS loyaltyPoints,
            (SELECT COUNT(*) FROM customer_account_entries WHERE customerId = ?) AS accountEntries,
            COALESCE((SELECT balancePence FROM customer_accounts WHERE customerId = ? LIMIT 1), 0) AS accountBalancePence`,
        [customerId, customerId, customerId, customerId, customerId],
    );
    const localUsage: CustomerUsage = {
        orders: Number(rows[0]?.orders || 0),
        loyaltyEntries: Number(rows[0]?.loyaltyEntries || 0),
        loyaltyPoints: Number(rows[0]?.loyaltyPoints || 0),
        accountEntries: Number(rows[0]?.accountEntries || 0),
        accountBalancePence: Number(rows[0]?.accountBalancePence || 0),
        sharedVerified: false,
    };

    if (!isMultiMode()) return localUsage;
    const state = get(connectionState);
    if (!state.mysqlOnline) {
        throw new Error('Customer deletion requires the shared MariaDB database to be online');
    }
    if (await pendingReportWriteCount() > 0) await flushOfflineQueue();
    if (await pendingReportWriteCount() > 0) {
        throw new Error('Pending sales must synchronize before a customer can be deleted');
    }
    const remote = await getMysqlDb();
    if (!remote) throw new Error('The shared MariaDB database is unavailable');
    const remoteRows: any[] = await remote.select(
        `SELECT
            (SELECT COUNT(*) FROM orders WHERE customerId = ?) AS orders,
            (SELECT COUNT(*) FROM loyalty_logs WHERE customerId = ?) AS loyaltyEntries,
            COALESCE((SELECT loyaltyPoints FROM customers WHERE id = ? LIMIT 1), 0) AS loyaltyPoints,
            (SELECT COUNT(*) FROM customer_account_entries WHERE customerId = ?) AS accountEntries,
            COALESCE((SELECT balancePence FROM customer_accounts WHERE customerId = ? LIMIT 1), 0) AS accountBalancePence`,
        [customerId, customerId, customerId, customerId, customerId],
    );
    const remotePoints = Number(remoteRows[0]?.loyaltyPoints || 0);
    return {
        orders: Math.max(localUsage.orders, Number(remoteRows[0]?.orders || 0)),
        loyaltyEntries: Math.max(localUsage.loyaltyEntries, Number(remoteRows[0]?.loyaltyEntries || 0)),
        loyaltyPoints: remotePoints !== 0 ? remotePoints : localUsage.loyaltyPoints,
        accountEntries: Math.max(localUsage.accountEntries, Number(remoteRows[0]?.accountEntries || 0)),
        accountBalancePence: Number(remoteRows[0]?.accountBalancePence ?? localUsage.accountBalancePence),
        sharedVerified: true,
    };
}

export async function removeCustomerSafely(customerId: string): Promise<void> {
    const usage = await getCustomerUsage(customerId);
    if (usage.loyaltyPoints !== 0) {
        throw new Error('This customer still has a loyalty-points balance and cannot be deleted');
    }
    if (usage.accountBalancePence !== 0) {
        throw new Error('This customer still has an account balance and cannot be deleted');
    }
    if (usage.accountEntries > 0) {
        throw new Error('This customer has account history that must be retained; archive the customer instead');
    }
    if (usage.orders > 0 || usage.loyaltyEntries > 0) {
        throw new Error('This customer has linked sales or loyalty history and cannot be deleted');
    }

    if (isMultiMode()) {
        const config = await requireOnlineCustomerAccount('Customer deletion');
        const result = await invoke<CustomerDeletionResult>('delete_online_customer', {
            mysqlUri: buildMysqlUri(config),
            customerId,
        });
        // The native command already attempts this cleanup after MariaDB
        // commits. Repeat the idempotent cache deletes here so a transient
        // SQLite lock is repaired before this screen reloads when possible.
        try {
            const localDb = await sqlite.getDb();
            await localDb.execute(`DELETE FROM customer_account_entries WHERE customerId = ?`, [customerId]);
            await localDb.execute(`DELETE FROM customer_accounts WHERE customerId = ?`, [customerId]);
            await localDb.execute(`DELETE FROM customers WHERE id = ?`, [customerId]);
        } catch (error) {
            console.warn(
                `database: MariaDB deleted customer ${result.customerId}, but local cache cleanup will need tombstone sync:`,
                error,
            );
        }
        customersDB.update((customers) => customers.filter((customer) => customer.id !== customerId));
        customerAccountsDB.update((accounts) => accounts.filter((account) => account.customerId !== customerId));
        customerAccountEntriesDB.update((entries) => entries.filter((entry) => entry.customerId !== customerId));
        notifyOwnerCloudDataChanged();
        return;
    }

    const localDb = await sqlite.getDb();
    await remove('customers', customerId);
    await localDb.execute(`DELETE FROM customer_accounts WHERE customerId = ?`, [customerId]);
    customersDB.update((customers) => customers.filter((customer) => customer.id !== customerId));
    customerAccountsDB.update((accounts) => accounts.filter((account) => account.customerId !== customerId));
    customerAccountEntriesDB.update((entries) => entries.filter((entry) => entry.customerId !== customerId));
    notifyOwnerCloudDataChanged();
}

export async function getCustomerLoyaltyHistory(
    customerId: string,
    limit = 50,
): Promise<CustomerLoyaltyHistoryRow[]> {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)));
    if (!isTauri()) {
        const orderNumbers = new Map(get(ordersDB).map((order) => [order.id, order.orderNumber]));
        return get(loyaltyLogDB)
            .filter((entry) => entry.customerId === customerId)
            .sort((left, right) =>
                String(right.createdAt || '').localeCompare(String(left.createdAt || ''))
                || String(right.id || '').localeCompare(String(left.id || ''))
            )
            .slice(0, safeLimit)
            .map((entry) => ({
                id: String(entry.id || ''),
                orderId: String(entry.orderId || ''),
                orderNumber: orderNumbers.get(entry.orderId) ?? null,
                pointsChange: Number(entry.pointsChange || 0),
                reason: String(entry.reason || ''),
                createdAt: String(entry.createdAt || ''),
            }));
    }
    const d = await sqlite.getDb();
    const rows: any[] = await d.select(
        `SELECT l.id, l.orderId, o.orderNumber, l.pointsChange, l.reason, l.createdAt
         FROM loyalty_logs l
         LEFT JOIN orders o ON o.id = l.orderId
         WHERE l.customerId = ?
         ORDER BY COALESCE(l.createdAt, '') DESC, l.id DESC
         LIMIT ?`,
        [customerId, safeLimit],
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
    const limit = Math.max(1, Math.min(100, Number(options.limit || 25)));
    const offset = Math.max(0, Number(options.offset || 0));
    const search = String(options.query || '').trim().toLowerCase();

    if (!isTauri()) {
        const employeeNames = new Map(get(employeesDB).map((employee) => [employee.id, employee.name]));
        const allRows = get(auditLogDB)
            .map((row) => ({ ...row, employeeName: employeeNames.get(row.employeeId) || '' }))
            .filter((row) => !options.action || row.action === options.action)
            .filter((row) => !options.entityType || row.entityType === options.entityType)
            .filter((row) => !search || [
                row.action,
                row.entityType,
                row.entityId,
                row.oldData,
                row.newData,
                row.employeeName,
            ].some((value) => String(value || '').toLowerCase().includes(search)))
            .sort((left, right) =>
                String(right.createdAt || '').localeCompare(String(left.createdAt || ''))
                || String(right.id || '').localeCompare(String(left.id || ''))
            );
        const sourceRows = get(auditLogDB);
        return {
            rows: allRows.slice(offset, offset + limit),
            total: allRows.length,
            actions: [...new Set(sourceRows.map((row) => row.action).filter(Boolean))].sort(),
            entities: [...new Set(sourceRows.map((row) => row.entityType).filter(Boolean))].sort(),
        };
    }

    const d = await sqlite.getDb();
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
    if (search) {
        where.push(`(
            LOWER(COALESCE(a.action, '')) LIKE ?
            OR LOWER(COALESCE(a.entityType, '')) LIKE ?
            OR LOWER(COALESCE(a.entityId, '')) LIKE ?
            OR LOWER(COALESCE(a.oldData, '')) LIKE ?
            OR LOWER(COALESCE(a.newData, '')) LIKE ?
            OR LOWER(COALESCE(e.name, '')) LIKE ?
            OR CAST(COALESCE(o.orderNumber, '') AS TEXT) LIKE ?
            OR LOWER(COALESCE(o.paymentMethod, '')) LIKE ?
            OR LOWER(COALESCE(order_till.name, '')) LIKE ?
            OR LOWER(COALESCE(order_customer.name, '')) LIKE ?
        )`);
        const like = `%${search}%`;
        params.push(like, like, like, like, like, like, like, like, like, like);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const joinsSql = `
         FROM audit_logs a
         LEFT JOIN employees e ON e.id = a.employeeId
         LEFT JOIN orders o ON a.entityType = 'order' AND o.id = a.entityId
         LEFT JOIN registers order_till ON order_till.id = o.tillNumber
         LEFT JOIN customers order_customer ON order_customer.id = o.customerId`;
    const rows: any[] = await d.select(
        `SELECT a.*,
                e.name AS employeeName,
                o.orderNumber AS relatedOrderNumber,
                o.total AS relatedOrderTotal,
                o.paymentMethod AS relatedPaymentMethod,
                order_till.name AS relatedTillName,
                order_customer.name AS relatedCustomerName
         ${joinsSql}
         ${whereSql}
         ORDER BY a.createdAt DESC, a.id DESC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset],
    );
    const countRows: any[] = await d.select(
        `SELECT COUNT(*) AS count
         ${joinsSql}
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
    if (!isTauri()) return [];
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

const PRODUCT_BOOL_KEYS = ['isActive', 'isAgeRestricted', 'isWeighable', 'showInGoods', 'trackStock'];

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

export async function getCustomersPage(options: sqlite.CustomerPageOptions = {}): Promise<sqlite.CustomerPageResult> {
    if (!isTauri()) {
        const query = String(options.query || '').trim().toLowerCase();
        const limit = Math.max(1, Math.min(100, Number(options.limit || 40)));
        const offset = Math.max(0, Number(options.offset || 0));
        const rows = get(customersDB)
            .filter((customer) => !query || [
                customer.name,
                customer.postcode,
                customer.phone,
                customer.email,
                customer.loyaltyCode,
            ].some((value) => String(value || '').toLowerCase().includes(query)))
            .map((customer) => {
                const account = get(customerAccountsDB).find((candidate) => candidate.customerId === customer.id);
                return {
                    ...customer,
                    accountId: account?.id || customer.id,
                    accountEnabled: account?.isEnabled || false,
                    accountCreditLimitPence: account?.creditLimitPence || 0,
                    accountBalancePence: account?.balancePence || 0,
                };
            })
            .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
        return { rows: rows.slice(offset, offset + limit), total: rows.length };
    }
    return sqlite.getCustomersPage(options);
}

export async function getCustomerById(customerId: string): Promise<any | null> {
    if (!isTauri()) {
        const customer = get(customersDB).find((candidate) => candidate.id === customerId);
        if (!customer) return null;
        const account = await getCustomerAccount(customerId);
        return {
            ...customer,
            accountId: account.id,
            accountEnabled: account.isEnabled,
            accountCreditLimitPence: account.creditLimitPence,
            accountBalancePence: account.balancePence,
        };
    }
    return sqlite.getCustomerById(customerId);
}

/** Refresh the balance used at checkout from the shared source of truth. */
export async function getPaymentCustomer(customerId: string): Promise<any | null> {
    if (!customerId) return null;
    if (!isMultiMode()) return getCustomerById(customerId);

    const remote = await getMysqlDb();
    if (!remote) throw new Error('The shared MariaDB database is unavailable');
    const rows: any[] = await remote.select(
        `SELECT c.*,
                COALESCE(a.id, c.id) AS accountId,
                COALESCE(a.isEnabled, 0) AS accountEnabled,
                COALESCE(a.creditLimitPence, 0) AS accountCreditLimitPence,
                COALESCE(a.balancePence, 0) AS accountBalancePence,
                a.createdAt AS accountCreatedAt,
                a.updatedAt AS accountUpdatedAt
         FROM customers c
         LEFT JOIN customer_accounts a ON a.customerId = c.id
         WHERE c.id = ? LIMIT 1`,
        [customerId],
    );
    connectionState.update((state) => ({ ...state, mysqlOnline: true, syncError: null }));
    if (rows.length === 0) return null;

    const customer = sqlite.rehydrateBooleans(rows[0], ['accountEnabled']);
    await sqlite.upsert('customers', customer, 'id');
    if (customer.accountCreatedAt) {
        await sqlite.upsert('customer_accounts', {
            id: customer.accountId,
            customerId,
            isEnabled: customer.accountEnabled,
            creditLimitPence: customer.accountCreditLimitPence,
            balancePence: customer.accountBalancePence,
            createdAt: customer.accountCreatedAt,
            updatedAt: customer.accountUpdatedAt,
        }, 'id');
    }
    return customer;
}

export async function getProductsByIds(ids: string[], activeOnly = true, compact = false): Promise<any[]> {
    if (!isTauri()) {
        const wanted = new Set(ids.map((id) => String(id || '').trim()).filter(Boolean));
        return get(productsDB).filter((product) => wanted.has(product.id) && (!activeOnly || product.isActive));
    }
    return hydrateProducts(await sqlite.getProductsByIds(ids, activeOnly, compact));
}

export const getCategoryUsageSummary = sqlite.getCategoryUsageSummary;

export async function getTaxRateProductUsageCount(taxRateId: string): Promise<number> {
    if (!isTauri()) {
        return get(productsDB).filter((product) => product.taxRateId === taxRateId).length;
    }
    return sqlite.getTaxRateProductUsageCount(taxRateId);
}

export async function getRecentStockReceipts(limit = 20): Promise<any[]> {
    if (!isTauri()) return [];
    return sqlite.getRecentStockReceipts(limit);
}

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
    const serverDataEpoch = await captureServerDataEpochForMutation();
    await flushOfflineQueue();
    const config = get(connectionState).mysqlConfig;
    if (!config) throw new Error('MariaDB configuration is unavailable');
    return invoke<boolean>('claim_mysql_held_order', {
        mysqlUri: buildMysqlUri(config),
        orderId,
        serverDataEpoch,
    });
}

export async function getPosRecentReceipts(limit = 10): Promise<sqlite.PosRecentReceiptsResult> {
    if (!isTauri()) {
        return buildPreviewRecentReceipts({
            orders: get(ordersDB),
            lines: get(orderLinesDB),
            payments: get(paymentsDB),
            employees: get(employeesDB),
            registers: get(registersDB),
            customers: get(customersDB),
        }, limit);
    }
    const result = await sqlite.getPosRecentReceipts(limit);
    return {
        ...result,
        lines: hydrateOrderLines(result.lines),
    };
}

export async function getLatestTillReceipt(tillNumber: string): Promise<any | null> {
    if (!isTauri()) {
        return findLatestPreviewTillReceipt({
            orders: get(ordersDB),
            lines: get(orderLinesDB),
            payments: get(paymentsDB),
            employees: get(employeesDB),
            registers: get(registersDB),
            customers: get(customersDB),
        }, tillNumber);
    }
    return sqlite.getLatestTillReceipt(tillNumber);
}

export async function getOrderDetails(orderId: string): Promise<sqlite.OrderDetailsResult> {
    if (!isTauri()) {
        return buildPreviewOrderDetails({
            orders: get(ordersDB),
            lines: get(orderLinesDB),
            payments: get(paymentsDB),
            employees: get(employeesDB),
            registers: get(registersDB),
            customers: get(customersDB),
        }, orderId);
    }
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
    const serverDataEpoch = await captureServerDataEpochForMutation();
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
        await queueLocalProductSnapshot(p.id, p, serverDataEpoch);
        if (hasImage) {
            await queueOffline('product_images', 'upsert', {
                id: p.id,
                image,
                updatedAt: p.updatedAt || new Date().toISOString(),
            }, 'id', serverDataEpoch);
        }
        void flushOfflineQueue().catch((e) => console.warn('database: product add outbox flush failed:', e));
    }
}

export async function updateProduct(p: any): Promise<void> {
    const serverDataEpoch = await captureServerDataEpochForMutation();
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
        await queueLocalProductSnapshot(p.id, p, serverDataEpoch);
        if (hasImage) {
            await queueOffline('product_images', 'upsert', {
                id: p.id,
                image,
                updatedAt: p.updatedAt || new Date().toISOString(),
            }, 'id', serverDataEpoch);
        }
        void flushOfflineQueue().catch((e) => console.warn('database: product update outbox flush failed:', e));
    }
}

export async function updateProductFields(
    patch: Record<string, any>,
    expected?: Record<string, any>,
): Promise<void> {
    const serverDataEpoch = await captureServerDataEpochForMutation();
    const hasImageField = Object.prototype.hasOwnProperty.call(patch, 'image');
    const image = hasImageField ? String(patch.image || '') : '';
    const hasImage = hasImageField && (!expected || image !== String(expected.image || ''));
    patch = { ...patch };
    delete patch.image;
    const stamped = await prepareProductGoodsMenuWrite(
        normalizeProductIdentifiers({ ...patch, updatedAt: new Date().toISOString() }),
    );
    if (!isTauri()) {
        const products = get(productsDB);
        for (const key of ['sku', 'barcode', 'scalePlu'] as const) {
            const value = String(stamped[key] || '').trim();
            if (!value) continue;
            const duplicate = products.find((product) => product.id !== stamped.id
                && String(product[key] || '').trim() === value);
            if (duplicate) {
                const label = key === 'barcode' ? 'Barcode' : key === 'scalePlu' ? 'Scale PLU' : 'SKU';
                throw new Error(`${label} is already used by ${duplicate.name}`);
            }
        }
        patchProductInStore({ ...stamped, ...(hasImage ? { image } : {}) });
        return;
    }
    await sqlite.assertProductIdentifiersUnique(stamped);
    try {
        await sqlite.updateProductFields(stamped);
        if (hasImage) await sqlite.upsertProductImage(stamped.id, image, stamped.updatedAt);
        patchProductInStore({ ...stamped, ...(hasImage ? { image } : {}) });
        if (isMultiMode()) {
            await queueLocalProductSnapshot(stamped.id, stamped, serverDataEpoch);
            if (hasImage) {
                await queueOffline('product_images', 'upsert', {
                    id: stamped.id,
                    image,
                    updatedAt: stamped.updatedAt,
                }, 'id', serverDataEpoch);
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
    const serverDataEpoch = await captureServerDataEpochForMutation();
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
        () => queueOffline('products', 'adjustStock', { id: productId, delta }, 'id', serverDataEpoch),
    );
}

/** Set an item's counted stock without overwriting sales made by another till. */
export async function setStockLevel(
    productId: string,
    stockLevel: number,
    expectedStockLevel: number,
): Promise<void> {
    const serverDataEpoch = await captureServerDataEpochForMutation();
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
        () => queueLocalProductSnapshot(productId, stamped, serverDataEpoch),
    );
}

export interface StockReceiptBundle {
    receipt: {
        id: string;
        supplierId: string;
        employeeId: string;
        reference: string;
        notes: string;
        totalCost: number;
        status: 'received';
        createdAt: string;
        updatedAt: string;
    };
    lines: Array<{
        id: string;
        receiptId: string;
        productId: string;
        productName: string;
        quantity: number;
        unitCost: number;
        inventoryLogId: string;
        createdAt: string;
        updatedAt: string;
    }>;
    audit: {
        id: string;
        employeeId: string;
        action: 'stock_received';
        entityType: 'stock_receipt';
        entityId: string;
        oldData: string;
        newData: string;
        createdAt: string;
    };
}

/** Commit stock receipt, lines, stock deltas, logs and its outbox row atomically. */
export async function commitStockReceipt(bundle: StockReceiptBundle): Promise<void> {
    const queueForSync = isMultiMode();
    const outboxId = queueForSync ? crypto.randomUUID() : null;
    await invoke('commit_local_stock_receipt', { bundle, outboxId });
    if (queueForSync) {
        offlineQueueFlushRequested = true;
        void flushOfflineQueue().catch((error) => {
            console.warn('database: stock receipt outbox flush failed:', error);
            connectionState.update((state) => ({
                ...state,
                mysqlOnline: false,
                syncError: String(error),
            }));
        });
    }
    notifyOwnerCloudDataChanged();
}

export interface SaleBundle {
    reportEpoch?: string;
    serverDataEpoch?: string;
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
    accountChanges?: CustomerAccountChange[];
    audit: any;
    originalOrderToUpdate?: string;
    originalStatusUpdate?: string;
}

export interface CustomerAccountChange {
    id: string;
    accountId?: string;
    customerId: string;
    orderId: string;
    entryType: CustomerAccountEntryType;
    amountPence: number;
    paymentMethod?: CustomerAccountPaymentMethod;
    reference?: string;
    description?: string;
    receiptNumber?: number;
    receiptKey?: string;
    employeeId: string;
    tillNumber?: string;
    shiftId?: string;
    idempotencyKey: string;
    reversesEntryId?: string;
    allowCreditBalance?: boolean;
    balanceAfterPence?: number;
    createdAt: string;
    updatedAt?: string;
}

interface CommitSaleResult {
    bundle: SaleBundle;
}

const ONLINE_FINANCIAL_RETRY_VOLATILE_KEYS = new Set([
    'audit',
    'id',
    'orderId',
    'logId',
    'entityId',
    'idempotencyKey',
    'receiptKey',
    'receiptNumber',
    'orderNumber',
    'createdAt',
    'completedAt',
    'updatedAt',
    'balanceAfterPence',
]);

let retryableOnlineFinancialBundle: { fingerprint: string; bundle: SaleBundle } | null = null;

function stableOnlineFinancialValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stableOnlineFinancialValue);
    if (!value || typeof value !== 'object') return value;
    return Object.keys(value as Record<string, unknown>)
        .filter((key) => !ONLINE_FINANCIAL_RETRY_VOLATILE_KEYS.has(key))
        .sort()
        .reduce<Record<string, unknown>>((normalized, key) => {
            normalized[key] = stableOnlineFinancialValue((value as Record<string, unknown>)[key]);
            return normalized;
        }, {});
}

function onlineFinancialBundleFingerprint(bundle: SaleBundle): string {
    return JSON.stringify(stableOnlineFinancialValue(bundle));
}

function cloneSaleBundle(bundle: SaleBundle): SaleBundle {
    return JSON.parse(JSON.stringify(bundle)) as SaleBundle;
}

async function bundleForOnlineFinancialRetry(bundle: SaleBundle): Promise<SaleBundle> {
    const fingerprint = onlineFinancialBundleFingerprint(bundle);
    if (retryableOnlineFinancialBundle?.fingerprint === fingerprint) {
        return retryableOnlineFinancialBundle.bundle;
    }

    // Keep the exact request that may own the native singleton journal. A
    // different checkout is still sent to native code so it receives the
    // authoritative ONLINE_FINANCIAL_INTENT_PENDING error, but it must not
    // overwrite the bundle needed to safely retry the unresolved checkout.
    if (retryableOnlineFinancialBundle && await pendingOnlineFinancialIntentCount() > 0) {
        return bundle;
    }

    const saved = cloneSaleBundle(bundle);
    retryableOnlineFinancialBundle = { fingerprint, bundle: saved };
    return saved;
}

export async function withCurrentReportEpoch<T extends {
    reportEpoch?: string;
    serverDataEpoch?: string;
}>(
    bundle: T,
    options: { requireLiveServerDataEpoch?: boolean } = {},
): Promise<T> {
    if (!isMultiMode()) return bundle;
    if (!options.requireLiveServerDataEpoch
        && bundle.reportEpoch !== undefined
        && bundle.serverDataEpoch !== undefined) return bundle;

    const local = await sqlite.getDb();
    const [cachedRows, localWholeSystemMarker] = await Promise.all([
        local.select(
            `SELECT key, value FROM settings WHERE key IN (?, ?)`,
            [REPORT_EPOCH_CACHE_KEY, SERVER_DATA_EPOCH_SEEN_KEY],
        ) as Promise<any[]>,
        sqlite.getLastReportMarker(''),
    ]);
    const cachedMarker = String(
        cachedRows.find((row) => row.key === REPORT_EPOCH_CACHE_KEY)?.value || '',
    );
    let serverDataEpoch = String(
        cachedRows.find((row) => row.key === SERVER_DATA_EPOCH_SEEN_KEY)?.value || '',
    ).trim();
    let marker = newestCanonicalReportEpoch(cachedMarker, localWholeSystemMarker);
    let liveEpochsRead = false;
    if (get(connectionState).mysqlOnline || options.requireLiveServerDataEpoch) {
        try {
            const remote = await getMysqlDb();
            if (remote) {
                const rows: any[] = await remote.select(
                    `SELECT
                        CAST(COALESCE((
                            SELECT DATE_FORMAT(lastClosedAt, '%Y-%m-%dT%H:%i:%s.%fZ')
                            FROM pos_close_barrier WHERE id = 1
                        ), '') AS CHAR CHARACTER SET utf8mb4) AS reportEpoch,
                        COALESCE((
                            SELECT CAST(value AS CHAR) FROM settings
                            WHERE \`key\` = ? LIMIT 1
                        ), '') AS serverDataEpoch`,
                    [SERVER_DATA_EPOCH_KEY],
                );
                if (rows[0]) {
                    liveEpochsRead = true;
                    marker = newestCanonicalReportEpoch(marker, rows[0].reportEpoch);
                    serverDataEpoch = String(rows[0].serverDataEpoch || '').trim();
                }
            }
        } catch (error) {
            if (options.requireLiveServerDataEpoch) {
                throw new Error(`Could not read the live MariaDB transaction epoch: ${String(error)}`);
            }
            console.warn('database: could not read the live report epoch; using the local marker:', error);
        }
    }
    if (options.requireLiveServerDataEpoch && !liveEpochsRead) {
        throw new Error('MariaDB did not return its current transaction epoch');
    }
    if (marker && marker !== canonicalReportEpoch(cachedMarker)) {
        try {
            await writeLocalReportEpochCache(marker);
        } catch (error) {
            console.warn('database: could not refresh the local report epoch cache:', error);
        }
    }
    return {
        ...bundle,
        reportEpoch: options.requireLiveServerDataEpoch
            ? marker
            : bundle.reportEpoch ?? marker,
        serverDataEpoch: options.requireLiveServerDataEpoch
            ? serverDataEpoch
            : bundle.serverDataEpoch ?? serverDataEpoch,
    };
}

/** Finish a MariaDB-authoritative financial commit left uncertain by a crash. */
export async function recoverOnlineFinancialIntent(config?: MysqlConfig): Promise<SaleBundle | null> {
    if (!isTauri() || !isMultiMode()) return null;
    const mysqlConfig = config || get(connectionState).mysqlConfig;
    if (!mysqlConfig) throw new Error('MariaDB configuration is unavailable');
    const committed = await invoke<CommitSaleResult | null>('recover_online_financial_intent', {
        mysqlUri: buildMysqlUri(mysqlConfig),
    });
    if (!committed) return null;

    retryableOnlineFinancialBundle = null;
    await hydrateSvelteStores();
    notifyOwnerCloudDataChanged();
    return committed.bundle;
}

function commitBrowserPreviewSale(bundle: SaleBundle): SaleBundle {
    const stamp = new Date().toISOString();
    const existingOrders = get(ordersDB);
    const existingOrder = existingOrders.find((candidate) => candidate.id === bundle.order?.id);
    if (existingOrder) {
        const existingPayment = get(paymentsDB).find((candidate) => candidate.orderId === existingOrder.id)
            || bundle.payment;
        const entries = get(customerAccountEntriesDB);
        return {
            ...bundle,
            order: existingOrder,
            payment: existingPayment,
            accountChanges: (bundle.accountChanges || []).map((change) => {
                const entry = entries.find((candidate) => candidate.idempotencyKey === change.idempotencyKey);
                return entry ? {
                    ...change,
                    orderId: entry.orderId,
                    receiptNumber: entry.receiptNumber,
                    receiptKey: entry.receiptKey,
                    balanceAfterPence: entry.balanceAfterPence,
                } : change;
            }),
        };
    }
    const orderNumber = Number(bundle.order?.orderNumber || 0)
        || Math.max(0, ...existingOrders.map((order) => Number(order.orderNumber || 0))) + 1;
    const order = {
        ...bundle.order,
        orderNumber,
        receiptKey: bundle.order?.receiptKey || `preview-${orderNumber}`,
        updatedAt: bundle.order?.updatedAt || stamp,
    };
    const payment = {
        ...bundle.payment,
        orderId: order.id,
        accountAmount: Number(bundle.payment?.accountAmount || 0),
        loyaltyAmount: Number(bundle.payment?.loyaltyAmount ?? (
            Number(bundle.payment?.amount || 0)
            - Number(bundle.payment?.cashAmount || 0)
            - Number(bundle.payment?.cardAmount || 0)
            - Number(bundle.payment?.accountAmount || 0)
        )),
        updatedAt: bundle.payment?.updatedAt || stamp,
    };

    // Validate and prepare every balance movement before mutating any store so
    // preview mode mirrors the native all-or-nothing transaction.
    const nextAccounts = get(customerAccountsDB).map((account) => ({ ...account }));
    const nextEntries = get(customerAccountEntriesDB).map((entry) => ({ ...entry }));
    const committedAccountChanges: CustomerAccountChange[] = [];
    for (const change of bundle.accountChanges || []) {
        const existingByKey = nextEntries.find((entry) => entry.idempotencyKey === change.idempotencyKey);
        if (existingByKey) {
            committedAccountChanges.push({
                ...change,
                orderId: existingByKey.orderId || order.id,
                receiptNumber: existingByKey.receiptNumber || orderNumber,
                receiptKey: existingByKey.receiptKey || order.receiptKey,
                balanceAfterPence: existingByKey.balanceAfterPence,
            });
            continue;
        }
        let accountIndex = nextAccounts.findIndex((account) => account.customerId === change.customerId);
        const account = accountIndex >= 0
            ? nextAccounts[accountIndex]
            : normalizeAccount(null, change.customerId);
        const amountPence = Math.trunc(Number(change.amountPence || 0));
        if (!Number.isSafeInteger(amountPence) || amountPence === 0) {
            throw new Error('Account entry amount must be a non-zero whole number of pence');
        }
        if (change.entryType === 'charge' && !account.isEnabled) {
            throw new Error('This customer account is on hold');
        }
        const balancePence = account.balancePence + amountPence;
        if (change.entryType === 'payment' && balancePence < 0) {
            throw new Error('The payment is greater than the amount owed');
        }
        if (change.entryType === 'charge'
            && account.creditLimitPence > 0
            && balancePence > account.creditLimitPence) {
            throw new Error('This charge would exceed the customer credit limit');
        }
        const nextAccount: CustomerAccount = {
            ...account,
            id: change.customerId,
            customerId: change.customerId,
            balancePence,
            createdAt: account.createdAt || change.createdAt || stamp,
            updatedAt: change.updatedAt || stamp,
        };
        if (accountIndex < 0) {
            accountIndex = nextAccounts.length;
            nextAccounts.push(nextAccount);
        } else {
            nextAccounts[accountIndex] = nextAccount;
        }
        const entry = normalizeAccountEntry({
            ...change,
            accountId: change.accountId || change.customerId,
            orderId: change.orderId || order.id,
            receiptNumber: change.receiptNumber || orderNumber,
            receiptKey: change.receiptKey || order.receiptKey,
            balanceAfterPence: balancePence,
            updatedAt: change.updatedAt || stamp,
        });
        nextEntries.unshift(entry);
        committedAccountChanges.push({
            ...change,
            orderId: change.orderId || order.id,
            receiptNumber: change.receiptNumber || orderNumber,
            receiptKey: change.receiptKey || order.receiptKey,
            balanceAfterPence: balancePence,
        });
    }

    ordersDB.update((orders) => [order, ...orders.filter((candidate) => candidate.id !== order.id)]);
    orderLinesDB.update((lines) => [
        ...bundle.lines,
        ...lines.filter((candidate) => !bundle.lines.some((line) => line.id === candidate.id)),
    ]);
    paymentsDB.update((payments) => [payment, ...payments.filter((candidate) => candidate.id !== payment.id)]);
    if (bundle.stockChanges.length > 0) {
        productsDB.update((products) => products.map((product) => {
            const delta = bundle.stockChanges
                .filter((change) => change.productId === product.id)
                .reduce((sum, change) => sum + Number(change.delta || 0), 0);
            return delta ? { ...product, stockLevel: product.stockLevel + delta, updatedAt: stamp } : product;
        }));
        inventoryLogDB.update((logs) => [
            ...bundle.stockChanges.map((change) => ({
                id: change.logId,
                productId: change.productId,
                quantityChange: change.delta,
                type: (change.movementType || 'sale') as any,
                referenceId: order.id,
                employeeId: change.employeeId,
                notes: change.notes,
                createdAt: stamp,
            })),
            ...logs,
        ]);
    }
    if (bundle.loyaltyChanges?.length) {
        loyaltyLogDB.update((entries) => [
            ...bundle.loyaltyChanges!.map((change) => ({
                ...change,
                reason: change.reason as any,
                updatedAt: change.createdAt || stamp,
            })),
            ...entries,
        ]);
        customersDB.update((customers) => customers.map((customer) => ({
            ...customer,
            loyaltyPoints: customer.loyaltyPoints + bundle.loyaltyChanges!
                .filter((change) => change.customerId === customer.id)
                .reduce((sum, change) => sum + Number(change.pointsChange || 0), 0),
        })));
    }
    if (bundle.audit) {
        auditLogDB.update((logs) => [bundle.audit, ...logs.filter((log) => log.id !== bundle.audit.id)]);
    }
    if (bundle.originalOrderToUpdate) {
        ordersDB.update((orders) => orders.map((candidate) => candidate.id === bundle.originalOrderToUpdate
            ? { ...candidate, status: (bundle.originalStatusUpdate || candidate.status) as any, updatedAt: stamp }
            : candidate));
    }
    customerAccountsDB.set(nextAccounts);
    customerAccountEntriesDB.set(nextEntries);
    for (const account of nextAccounts) cacheBrowserAccount(account);

    return {
        ...bundle,
        order,
        payment,
        accountChanges: committedAccountChanges,
    };
}

/**
 * Commit a completed sale as one local transaction. In multi mode the exact
 * same immutable bundle is committed to MariaDB as one transaction, or queued
 * as one unit if the server is unavailable. This prevents half-written sales.
 */
async function commitSaleAfterClosePreflight(
    bundle: SaleBundle,
    options: { allowPreparing?: boolean } = {},
): Promise<SaleBundle> {
    if (!isTauri()) {
        const committed = commitBrowserPreviewSale(bundle);
        notifyOwnerCloudDataChanged();
        return committed;
    }
    const requiresSharedLoyaltyBalance = bundle.order?.type === 'sale'
        && Boolean(bundle.loyaltyChanges?.some((change) => change.reason === 'redeemed' && change.pointsChange < 0));
    const requiresSharedAccountBalance = Boolean(bundle.accountChanges?.length);
    if (isMultiMode() && (bundle.order?.type === 'return' || requiresSharedLoyaltyBalance || requiresSharedAccountBalance)) {
        let state = get(connectionState);
        if (!state.mysqlOnline) {
            await pingMysql();
            state = get(connectionState);
        }
        if (!state.mysqlOnline) {
            throw new Error(requiresSharedAccountBalance
                ? 'Customer-account sales require the main MariaDB database to be online'
                : requiresSharedLoyaltyBalance
                    ? 'Loyalty credit requires the main MariaDB database to be online'
                    : 'Refunds and voids require the main MariaDB database to be online');
        }
        if (state.mysqlOnline) {
            if (!state.mysqlConfig) throw new Error('MariaDB configuration is unavailable');
            try {
                bundle = await withCurrentReportEpoch(bundle);
                await assertMariaDbCommerceWritesAllowed({ allowPreparing: options.allowPreparing });
                let pendingAuthoritativeWrites = await pendingQueuedReportWriteCount();
                if (pendingAuthoritativeWrites > 0) {
                    await flushOfflineQueue();
                    pendingAuthoritativeWrites = await pendingQueuedReportWriteCount();
                }
                if (pendingAuthoritativeWrites > 0) {
                    throw new Error(requiresSharedAccountBalance
                        ? 'Pending sales must synchronize before a customer account can be used'
                        : requiresSharedLoyaltyBalance
                            ? 'Pending sales must synchronize before loyalty credit can be used'
                            : 'Pending sales or report closes must synchronize before a refund or void');
                }
                const command = bundle.order?.type === 'return'
                    ? 'commit_online_reversal'
                    : requiresSharedAccountBalance
                        ? 'commit_online_customer_account_sale'
                        : 'commit_online_loyalty_sale';
                const retryableBundle = await bundleForOnlineFinancialRetry(bundle);
                // tauri-invoke: commit_online_loyalty_sale, commit_online_reversal
                const committed = await invoke<CommitSaleResult>(command, {
                    mysqlUri: buildMysqlUri(state.mysqlConfig),
                    bundle: retryableBundle,
                });
                retryableOnlineFinancialBundle = null;
                notifyOwnerCloudDataChanged();
                return committed.bundle;
            } catch (e) {
                if (isTransientSyncError(e)) {
                    connectionState.update((state) => ({
                        ...state,
                        mysqlOnline: false,
                        syncError: String(e),
                    }));
                }
                throw e;
            }
        }
    }

    bundle = await withCurrentReportEpoch(bundle);
    const multiMode = isMultiMode();
    const outboxId = multiMode ? crypto.randomUUID() : null;
    const committed = await invoke<CommitSaleResult>('commit_local_sale', { bundle, outboxId });
    bundle = committed.bundle;

    if (multiMode) {
        void flushOfflineQueue()
            .catch((e) => {
                console.warn('database: sale outbox flush failed:', e);
                connectionState.update(s => ({ ...s, mysqlOnline: false, syncError: String(e) }));
            });
    }
    notifyOwnerCloudDataChanged();
    return bundle;
}

export async function commitSale(bundle: SaleBundle): Promise<SaleBundle> {
    if (!isTauri() || !isMultiMode()) return commitSaleAfterClosePreflight(bundle);
    return wholeSystemCloseLocalMutex.runExclusive(async () => {
        const requiresOnlineFinancialAuthority = bundle.order?.type === 'return'
            || Boolean(bundle.accountChanges?.length)
            || (bundle.order?.type === 'sale' && Boolean(bundle.loyaltyChanges?.some(
                (change) => change.reason === 'redeemed' && change.pointsChange < 0,
            )));
        if (!requiresOnlineFinancialAuthority && get(connectionState).mysqlOnline) {
            try {
                await assertMariaDbCommerceWritesAllowed();
            } catch (error) {
                const message = String(error).toLowerCase();
                if (!isTransientSyncError(error) && !message.includes('mariadb is unavailable')) throw error;
                connectionState.update((state) => ({
                    ...state,
                    mysqlOnline: false,
                    syncError: String(error),
                }));
            }
        }
        return commitSaleAfterClosePreflight(bundle);
    });
}

/**
 * Finish a provider-approved sale whose durable terminal journal was prepared
 * before a whole-system close entered its preparing phase. Frozen remains a
 * hard stop, and legacy journals without a captured epoch wait until idle.
 */
export async function commitPreparedTerminalSale(bundle: SaleBundle): Promise<SaleBundle> {
    if (!isTauri() || !isMultiMode()) return commitSale(bundle);
    if (bundle.reportEpoch === undefined) {
        throw new Error(
            'This legacy terminal payment has no report epoch and must wait until the whole-system close finishes',
        );
    }
    if (bundle.serverDataEpoch === undefined) {
        throw new Error(
            'This legacy terminal payment has no server data epoch and cannot be assigned to the current MariaDB dataset',
        );
    }
    return wholeSystemCloseLocalMutex.runExclusive(async () => {
        await assertMariaDbCommerceWritesAllowed({ allowPreparing: true });
        return commitSaleAfterClosePreflight(bundle, { allowPreparing: true });
    });
}

export async function deleteProduct(id: string): Promise<void> {
    const serverDataEpoch = await captureServerDataEpochForMutation();
    const before = await getLocalRow('products', 'id', id);
    await sqlite.deleteProduct(id);
    const after = await getLocalRow('products', 'id', id);
    await recordAuditEvent('product_deactivated', 'product', id, before, after);
    await pushWriteInBackground(
        'product deactivation',
        () => mysql.mysqlDeleteProduct(id),
        () => queueLocalProductSnapshot(id, undefined, serverDataEpoch),
    );
    await removeProductTiles(id);
}

export async function removeProductTiles(productId: string): Promise<void> {
    const tileIds = await sqlite.getProductTileIds(productId);
    for (const tileId of tileIds) await deleteTile(tileId);
}

export async function bulkAddProducts(products: any[]): Promise<void> {
    const serverDataEpoch = await captureServerDataEpochForMutation();
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
            for (const p of products) {
                await queueOffline('products', 'upsert', p, 'id', serverDataEpoch);
            }
        },
    );
}

// ─── POS Page / Tile Helpers ────────────────────────────────────────────────

export async function savePosPage(p: any): Promise<void> {
    const serverDataEpoch = await captureServerDataEpochForMutation();
    const stamped = { ...p, updatedAt: new Date().toISOString() };
    const before = await getLocalRow('pos_pages', 'id', stamped.id);
    await sqlite.savePosPage(stamped);
    const after = await getLocalRow('pos_pages', 'id', stamped.id);
    await recordTableAudit('pos_pages', before ? 'updated' : 'created', 'id', before, after || stamped);
    await pushWriteInBackground(
        'POS page save',
        () => mysql.mysqlSavePosPage(stamped),
        () => queueOffline('pos_pages', 'upsert', stamped, 'id', serverDataEpoch),
    );
}

export async function deletePosPage(id: string): Promise<void> {
    const serverDataEpoch = await captureServerDataEpochForMutation();
    const before = await getLocalRow('pos_pages', 'id', id);
    await sqlite.deletePosPage(id);
    await recordTableAudit('pos_pages', 'deleted', 'id', before, null);
    await pushWriteInBackground(
        'POS page delete',
        () => mysql.mysqlDeletePosPage(id),
        () => queueOffline('pos_pages', 'remove', { id }, 'id', serverDataEpoch),
    );
    // Propagate the page deletion to other tills. (Child tiles are removed
    // locally on each till via deletePosPage's cascade.)
    await recordTombstone('pos_pages', id, serverDataEpoch);
}

export async function addTile(t: any): Promise<void> {
    const serverDataEpoch = await captureServerDataEpochForMutation();
    const stamped = { ...t, updatedAt: new Date().toISOString() };
    const before = await getLocalRow('pos_tiles', 'id', stamped.id);
    await sqlite.addTile(stamped);
    const after = await getLocalRow('pos_tiles', 'id', stamped.id);
    await recordTableAudit('pos_tiles', before ? 'updated' : 'created', 'id', before, after || stamped);
    await pushWriteInBackground(
        'POS tile save',
        () => mysql.mysqlAddTile(stamped),
        () => queueOffline('pos_tiles', 'upsert', stamped, 'id', serverDataEpoch),
    );
}

export async function deleteTile(id: string): Promise<void> {
    const serverDataEpoch = await captureServerDataEpochForMutation();
    const before = await getLocalRow('pos_tiles', 'id', id);
    await sqlite.deleteTile(id);
    await recordTableAudit('pos_tiles', 'deleted', 'id', before, null);
    await pushWriteInBackground(
        'POS tile delete',
        () => mysql.mysqlDeleteTile(id),
        () => queueOffline('pos_tiles', 'remove', { id }, 'id', serverDataEpoch),
    );
    await recordTombstone('pos_tiles', id, serverDataEpoch);
}

// ─── Goods Menu Helpers ─────────────────────────────────────────────────────

export async function limitGoodsMenuItems(): Promise<void> {
    const serverDataEpoch = await captureServerDataEpochForMutation();
    await sqlite.limitGoodsMenuItems();
    if (isMultiMode()) {
        await queueOffline('products', 'limitGoodsMenuItems', {}, 'id', serverDataEpoch);
        void flushOfflineQueue().catch((e) => console.warn('database: goods menu limit outbox flush failed:', e));
    }
}

export async function batchUpdateGoodsMenu(
    changes: { id: string; showInGoods: boolean; goodsSortOrder: number; updatedAt: string }[]
): Promise<void> {
    const serverDataEpoch = await captureServerDataEpochForMutation();
    await sqlite.batchUpdateGoodsMenu(changes);
    await pushWriteInBackground(
        'goods menu batch update',
        () => mysql.mysqlBatchUpdateGoodsMenu(changes),
        async () => {
            const d = await sqlite.getDb();
            for (const change of changes) {
                const rows: any[] = await d.select('SELECT * FROM products WHERE id = ? LIMIT 1', [change.id]);
                if (rows[0]) {
                    await queueOffline('products', 'upsert', rows[0], 'id', serverDataEpoch);
                }
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

function browserReportOrders(startTime: string, endTime: string, tillNumber?: string): any[] {
    const start = new Date(startTime).getTime();
    const end = new Date(endTime).getTime();
    return get(ordersDB).filter((order) => {
        const completed = new Date(order.completedAt || order.createdAt || '').getTime();
        return ['completed', 'refunded', 'partially_refunded', 'voided'].includes(order.status)
            && order.status !== 'voided'
            && !(order.type === 'return' && String(order.notes || '').startsWith('Void of receipt '))
            && Number.isFinite(completed)
            && completed >= start
            && completed < end
            && (!tillNumber || order.tillNumber === tillNumber);
    });
}

function browserPaymentAmounts(payment: any): { cash: number; card: number; loyalty: number; account: number } {
    const amount = Number(payment?.amount || 0);
    const rawCash = Number(payment?.cashAmount || 0);
    const rawCard = Number(payment?.cardAmount || 0);
    const cash = rawCash !== 0 ? rawCash : payment?.method === 'cash' ? amount : 0;
    const card = rawCard !== 0
        ? rawCard
        : ['card', 'sumup', 'dojo', 'mobile'].includes(payment?.method) ? amount : 0;
    const account = Number(payment?.accountAmount || 0);
    const loyalty = Number(payment?.loyaltyAmount ?? (amount - cash - card - account));
    return { cash, card, loyalty, account };
}

function browserAccountActivity(startTime: string, endTime: string): Pick<sqlite.PaymentBreakdown,
    'accountCharges' | 'accountRepaymentsCash' | 'accountRepaymentsCard' | 'accountRepaymentsOther' |
    'accountAdjustments' | 'openingAccountOwed' | 'closingAccountOwed' |
    'accountActivityScope'> {
    const summary = summarizeAccountActivity(
        get(customerAccountEntriesDB),
        new Date(startTime).getTime(),
        new Date(endTime).getTime(),
    );
    return {
        ...summary,
        accountActivityScope: 'shop',
    };
}

function browserBreakdown(
    orders: any[],
    startTime: string,
    endTime: string,
): sqlite.PaymentBreakdown {
    const payments = get(paymentsDB);
    let totalCash = 0;
    let totalCard = 0;
    let totalLoyalty = 0;
    let totalAccount = 0;
    let cashTxCount = 0;
    let cardTxCount = 0;
    let splitTxCount = 0;
    let loyaltyTxCount = 0;
    let accountTxCount = 0;
    let unrecordedAmount = 0;
    let unrecordedTxCount = 0;
    for (const order of orders) {
        const orderPayments = payments.filter((payment) => payment.orderId === order.id);
        if (orderPayments.length === 0) {
            unrecordedAmount += Number(order.total || 0);
            unrecordedTxCount++;
            continue;
        }
        const amounts = orderPayments.reduce((sum, payment) => {
            const value = browserPaymentAmounts(payment);
            return {
                cash: sum.cash + value.cash,
                card: sum.card + value.card,
                loyalty: sum.loyalty + value.loyalty,
                account: sum.account + value.account,
            };
        }, { cash: 0, card: 0, loyalty: 0, account: 0 });
        totalCash += amounts.cash;
        totalCard += amounts.card;
        totalLoyalty += amounts.loyalty;
        totalAccount += amounts.account;
        if (amounts.cash && amounts.card) splitTxCount++;
        else if (amounts.cash) cashTxCount++;
        else if (amounts.card) cardTxCount++;
        if (amounts.loyalty) loyaltyTxCount++;
        if (amounts.account) accountTxCount++;
    }
    return {
        totalCash,
        totalCard,
        totalLoyalty,
        totalAccount,
        cashTxCount,
        cardTxCount,
        splitTxCount,
        loyaltyTxCount,
        accountTxCount,
        ...browserAccountActivity(startTime, endTime),
        totalAmount: orders.reduce((sum, order) => sum + Number(order.total || 0), 0),
        unrecordedAmount,
        unrecordedTxCount,
    };
}

function getBrowserReportSnapshotForPeriod(
    startTime: string,
    endTime: string,
    sortBy: 'quantity' | 'revenue' = 'quantity',
    limit = 10,
    tillNumber?: string,
): ReportSnapshot {
    const orders = browserReportOrders(startTime, endTime, tillNumber);
    const orderIds = new Set(orders.map((order) => order.id));
    const lines = get(orderLinesDB).filter((line) => orderIds.has(line.orderId));
    const saleOrders = orders.filter((order) => order.type !== 'return');
    const overview: sqlite.SalesOverview = {
        totalRevenue: orders.reduce((sum, order) => sum + Number(order.total || 0), 0),
        totalTransactions: saleOrders.length,
        refundTransactions: orders.length - saleOrders.length,
        avgTransactionValue: saleOrders.length
            ? Math.round(saleOrders.reduce((sum, order) => sum + Number(order.total || 0), 0) / saleOrders.length)
            : 0,
        totalItemsSold: lines.reduce((sum, line) => sum + Number(line.quantity || 0), 0),
    };
    const breakdown = browserBreakdown(orders, startTime, endTime);

    const productGroups = new Map<string, sqlite.TopProduct>();
    const products = get(productsDB);
    for (const line of lines) {
        const key = String(line.productId || line.productName || 'unknown');
        const existing = productGroups.get(key) || {
            name: line.productName || 'Unknown',
            sku: products.find((product) => product.id === line.productId)?.sku || '',
            qtySold: 0,
            totalRevenue: 0,
            avgPrice: 0,
        };
        existing.qtySold += Number(line.quantity || 0);
        existing.totalRevenue += Number(line.lineTotal || 0);
        existing.avgPrice = existing.qtySold ? Math.round(existing.totalRevenue / existing.qtySold) : 0;
        productGroups.set(key, existing);
    }
    const topProducts = [...productGroups.values()]
        .sort((left, right) => sortBy === 'revenue'
            ? right.totalRevenue - left.totalRevenue
            : right.qtySold - left.qtySold)
        .slice(0, Math.max(1, limit));

    const entries = get(customerAccountEntriesDB);
    const registerNames = new Map(get(registersDB).map((register) => [register.id, register.name]));
    const tillIds = new Set([
        ...get(registersDB).filter((register) => register.isActive).map((register) => register.id),
        ...get(ordersDB).map((order) => order.tillNumber).filter(Boolean),
        ...entries.map((entry) => entry.tillNumber).filter(Boolean),
    ]);
    const tillOptions: sqlite.TillReportOption[] = [...tillIds].map((id, index) => ({
        id,
        name: registerNames.get(id)
            || (id === 'browser-preview-till' ? 'Browser Preview' : `Till ${index + 1}`),
    }));
    const periodStart = new Date(startTime).getTime();
    const periodEnd = new Date(endTime).getTime();
    const tillSummaries: sqlite.TillSalesSummary[] = tillOptions.map((option) => {
        const tillOrders = browserReportOrders(startTime, endTime, option.id);
        const ids = new Set(tillOrders.map((order) => order.id));
        const tillLines = get(orderLinesDB).filter((line) => ids.has(line.orderId));
        const tender = browserBreakdown(tillOrders, startTime, endTime);
        const collections = entries.filter((entry) => entry.tillNumber === option.id
            && entry.entryType === 'payment'
            && new Date(entry.createdAt).getTime() >= periodStart
            && new Date(entry.createdAt).getTime() < periodEnd);
        return {
            ...option,
            netSales: tillOrders.reduce((sum, order) => sum + Number(order.total || 0), 0),
            grossSales: tillOrders.filter((order) => order.type !== 'return')
                .reduce((sum, order) => sum + Number(order.total || 0) + Number(order.discountAmount || 0), 0),
            refunds: Math.abs(tillOrders.filter((order) => Number(order.total || 0) < 0)
                .reduce((sum, order) => sum + Number(order.total || 0), 0)),
            taxTotal: tillOrders.reduce((sum, order) => sum + Number(order.taxTotal || 0), 0),
            transactions: tillOrders.filter((order) => order.type !== 'return').length,
            refundTransactions: tillOrders.filter((order) => order.type === 'return').length,
            itemsSold: tillLines.reduce((sum, line) => sum + Number(line.quantity || 0), 0),
            cashTotal: tender.totalCash,
            cardTotal: tender.totalCard,
            loyaltyTotal: tender.totalLoyalty,
            accountTotal: tender.totalAccount,
            accountRepaymentsCash: collections.filter((entry) => entry.paymentMethod === 'cash')
                .reduce((sum, entry) => sum - Math.min(0, entry.amountPence), 0),
            accountRepaymentsCard: collections.filter((entry) => entry.paymentMethod === 'card')
                .reduce((sum, entry) => sum - Math.min(0, entry.amountPence), 0),
            accountRepaymentsOther: collections.filter((entry) => entry.paymentMethod === 'other')
                .reduce((sum, entry) => sum - Math.min(0, entry.amountPence), 0),
        };
    });

    const dayGroups = new Map<string, sqlite.DailySalesPoint>();
    for (const order of orders) {
        const date = new Date(order.completedAt || order.createdAt).toLocaleDateString('en-CA');
        const point = dayGroups.get(date) || { date, netSales: 0, transactions: 0 };
        point.netSales += Number(order.total || 0);
        if (order.type !== 'return') point.transactions++;
        dayGroups.set(date, point);
    }

    const voidOrders = get(ordersDB).filter((order) => {
        const created = new Date(order.completedAt || order.createdAt || '').getTime();
        return created >= periodStart && created < periodEnd
            && order.type === 'return' && String(order.notes || '').startsWith('Void of receipt ')
            && (!tillNumber || order.tillNumber === tillNumber);
    });
    const costTotal = lines.reduce((sum, line) => sum + Number(line.quantity || 0) * Number(line.costPrice || 0), 0);
    const netSales = overview.totalRevenue;
    const taxTotal = orders.reduce((sum, order) => sum + Number(order.taxTotal || 0), 0);
    const business: sqlite.BusinessSummary = {
        grossSales: saleOrders.reduce((sum, order) => sum + Number(order.total || 0) + Number(order.discountAmount || 0), 0),
        refunds: Math.abs(orders.filter((order) => order.type === 'return')
            .reduce((sum, order) => sum + Number(order.total || 0), 0)),
        voids: Math.abs(voidOrders.reduce((sum, order) => sum + Number(order.total || 0), 0)),
        voidTransactions: voidOrders.length,
        netSales,
        taxTotal,
        discountTotal: saleOrders.reduce((sum, order) => sum + Number(order.discountAmount || 0), 0),
        costTotal,
        grossProfit: netSales - taxTotal - costTotal,
    };

    const employeeNames = new Map(get(employeesDB).map((employee) => [employee.id, employee.name]));
    const employeeGroups = new Map<string, sqlite.EmployeeSalesSummary>();
    for (const order of orders) {
        const current = employeeGroups.get(order.employeeId) || {
            employeeId: order.employeeId || '',
            employeeName: employeeNames.get(order.employeeId) || 'Unknown employee',
            netSales: 0,
            grossSales: 0,
            refunds: 0,
            transactions: 0,
            refundTransactions: 0,
            avgTransaction: 0,
        };
        current.netSales += Number(order.total || 0);
        if (order.type === 'return') {
            current.refunds += Math.abs(Number(order.total || 0));
            current.refundTransactions++;
        } else {
            current.grossSales += Number(order.total || 0) + Number(order.discountAmount || 0);
            current.transactions++;
        }
        current.avgTransaction = current.transactions
            ? Math.round((current.netSales + current.refunds) / current.transactions)
            : 0;
        employeeGroups.set(current.employeeId, current);
    }

    return {
        overview,
        breakdown,
        topProducts,
        tillOptions,
        tillSummaries,
        dailyTrend: [...dayGroups.values()].sort((left, right) => left.date.localeCompare(right.date)),
        business,
        employeeSales: [...employeeGroups.values()].sort((left, right) => right.netSales - left.netSales),
        source: 'sqlite',
        warning: 'Browser preview data — the real shop database was not changed.',
    };
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

async function pendingQueuedReportWriteCount(): Promise<number> {
    const d = await sqlite.getDb();
    const rows: any[] = await d.select(
        `SELECT COUNT(*) AS count FROM _offline_queue
         WHERE operation = 'saleBundle'
            OR table_name IN ('orders','order_lines','payments','till_report_markers')`,
    );
    return Number(rows[0]?.count || 0);
}

async function pendingOnlineFinancialIntentCount(): Promise<number> {
    const d = await sqlite.getDb();
    const rows: any[] = await d.select(
        `SELECT COUNT(*) AS count FROM _online_financial_intent`,
    );
    return Number(rows[0]?.count || 0);
}

async function pendingReportWriteCount(): Promise<number> {
    const [queuedWrites, onlineIntent] = await Promise.all([
        pendingQueuedReportWriteCount(),
        pendingOnlineFinancialIntentCount(),
    ]);
    return queuedWrites + onlineIntent;
}

async function pendingTerminalRecoveryCount(): Promise<number> {
    const d = await sqlite.getDb();
    const rows: any[] = await d.select(
        `SELECT COUNT(*) AS count FROM payment_terminal_attempts
         WHERE status IN ('prepared', 'started', 'uncertain', 'approved',
                          'commit_failed', 'completion_pending')`,
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
    if (!isTauri()) {
        const [startTime, endTime] = reportDateBounds(startDate, endDate);
        return getBrowserReportSnapshotForPeriod(startTime, endTime, sortBy, limit, tillNumber);
    }
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

export interface WholeSystemCloseSession {
    token: string;
    ownerTillId: string;
    periodStart: string;
    cutoffAt: string;
    expectedLastMarker: string | null;
    report: {
        overview: sqlite.SalesOverview;
        breakdown: sqlite.PaymentBreakdown;
        topProducts: sqlite.TopProduct[];
    };
}

interface WholeSystemCloseBarrierResult {
    token: string;
    state: 'idle' | 'preparing' | 'frozen';
    ownerTillId: string;
    requestedAt: string;
    expiresAt: string;
    cutoffAt: string;
    latestMarker: string | null;
}

interface FrozenWholeSystemReportResult {
    token: string;
    cutoffAt: string;
    periodStart: string;
    expectedLastMarker: string | null;
    overview: sqlite.SalesOverview;
    breakdown: sqlite.PaymentBreakdown;
    topProducts: sqlite.TopProduct[];
}

const WHOLE_SYSTEM_CLOSE_WAIT_MS = 50_000;
const WHOLE_SYSTEM_CLOSE_POLL_MS = 1_000;

function waitForWholeSystemClosePoll(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, WHOLE_SYSTEM_CLOSE_POLL_MS));
}

function isWholeSystemCloseWaiting(error: unknown): boolean {
    return String(error).includes('WHOLE_SYSTEM_CLOSE_WAITING');
}

export async function abortWholeSystemClose(token: string): Promise<void> {
    if (!token || !isMultiMode()) return;
    const state = get(connectionState);
    if (!state.mysqlConfig) return;
    const ownerTillId = await sqlite.getOrCreateTillId();
    await invoke('abort_whole_system_close', {
        mysqlUri: buildMysqlUri(state.mysqlConfig),
        token,
        ownerTillId,
    });
    await publishTillPresence(true).catch(() => undefined);
}

export async function beginWholeSystemClose(): Promise<WholeSystemCloseSession> {
    if (!isMultiMode()) {
        throw new Error('Whole-system coordinated close requires MariaDB multi-till mode');
    }
    const state = get(connectionState);
    if (!state.mysqlOnline || !state.mysqlConfig || !(await pingMysql())) {
        throw new Error('MariaDB is offline. Whole-system end-of-day was not started.');
    }
    const mysqlUri = buildMysqlUri(state.mysqlConfig);
    const ownerTillId = await sqlite.getOrCreateTillId();
    let token = '';
    try {
        let barrier = await invoke<WholeSystemCloseBarrierResult>('begin_whole_system_close', {
            mysqlUri,
            ownerTillId,
        });
        token = barrier.token;
        if (!token) throw new Error('MariaDB did not issue a whole-system close token');

        const freezeDeadline = Date.now() + WHOLE_SYSTEM_CLOSE_WAIT_MS;
        let lastWaitingError = '';
        while (barrier.state !== 'frozen') {
            await publishTillPresence(true);
            try {
                barrier = await invoke<WholeSystemCloseBarrierResult>('freeze_whole_system_close', {
                    mysqlUri,
                    token,
                    ownerTillId,
                });
            } catch (error) {
                if (!isWholeSystemCloseWaiting(error)) throw error;
                lastWaitingError = String(error).replace(/^.*WHOLE_SYSTEM_CLOSE_WAITING:\s*/, '');
                if (Date.now() >= freezeDeadline) {
                    throw new Error(
                        `Tills were not ready for whole-system close: ${lastWaitingError || 'readiness timed out'}`,
                    );
                }
                await waitForWholeSystemClosePoll();
            }
        }

        const periodStart = barrier.latestMarker || '2000-01-01T00:00:00.000Z';
        const snapshotDeadline = Date.now() + WHOLE_SYSTEM_CLOSE_WAIT_MS;
        while (true) {
            await publishTillPresence(true);
            try {
                const frozen = await invoke<FrozenWholeSystemReportResult>(
                    'get_frozen_whole_system_report',
                    { mysqlUri, token, ownerTillId, periodStart },
                );
                return {
                    token,
                    ownerTillId,
                    periodStart: frozen.periodStart,
                    cutoffAt: frozen.cutoffAt,
                    expectedLastMarker: frozen.expectedLastMarker,
                    report: {
                        overview: frozen.overview,
                        breakdown: frozen.breakdown,
                        topProducts: frozen.topProducts,
                    },
                };
            } catch (error) {
                if (!isWholeSystemCloseWaiting(error)) throw error;
                if (Date.now() >= snapshotDeadline) {
                    throw new Error(
                        `Tills did not acknowledge the frozen close: ${String(error)}`,
                    );
                }
                await waitForWholeSystemClosePoll();
            }
        }
    } catch (error) {
        if (token) await abortWholeSystemClose(token).catch(() => undefined);
        throw error;
    }
}

export async function finishWholeSystemClose(
    session: WholeSystemCloseSession,
    extra: { employeeId?: string; reportText?: string; reportTotal?: number } = {},
): Promise<any> {
    const state = get(connectionState);
    if (!state.mysqlOnline || !state.mysqlConfig) {
        throw new Error('MariaDB is offline. The frozen whole-system period was not closed.');
    }
    const row = await invoke<any>('finish_whole_system_close', {
        mysqlUri: buildMysqlUri(state.mysqlConfig),
        input: {
            token: session.token,
            ownerTillId: session.ownerTillId,
            id: crypto.randomUUID(),
            expectedLastMarker: session.expectedLastMarker,
            periodStart: session.periodStart,
            employeeId: extra.employeeId || '',
            reportText: extra.reportText || '',
            reportTotal: extra.reportTotal || 0,
        },
    });
    try {
        await writeLocalReportEpochCache(row.markerTime || row.periodEnd || session.cutoffAt);
    } catch (error) {
        console.warn('database: whole-system report closed remotely but the local report epoch cache failed:', error);
    }
    try {
        await sqlite.upsert('till_report_markers', row, 'id');
    } catch (error) {
        console.warn('database: whole-system report closed remotely but local marker cache failed:', error);
    }
    try {
        await recordAuditEvent(
            'report_period_closed',
            'report',
            row.id,
            null,
            {
                scope: 'system',
                tillNumber: '',
                periodStart: session.periodStart,
                periodEnd: session.cutoffAt,
                reportTotal: extra.reportTotal || 0,
            },
            extra.employeeId || currentAuditEmployeeId(),
        );
    } catch (error) {
        console.warn('database: whole-system report closed remotely but local audit write failed:', error);
    }
    await publishTillPresence(true).catch(() => undefined);
    return row;
}

async function saveReportMarkerAfterClosePreflight(
    tillNumber: string,
    periodStart: string,
    periodEnd: string,
    extra: { employeeId?: string; reportText?: string; reportTotal?: number } = {}
): Promise<any> {
    const serverDataEpoch = await captureServerDataEpochForMutation();
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
        () => queueOffline('till_report_markers', 'upsert', row, 'id', serverDataEpoch),
    );
    return row;
}

export async function saveReportMarker(
    tillNumber: string,
    periodStart: string,
    periodEnd: string,
    extra: { employeeId?: string; reportText?: string; reportTotal?: number } = {},
): Promise<any> {
    if (!isMultiMode()) {
        return saveReportMarkerAfterClosePreflight(tillNumber, periodStart, periodEnd, extra);
    }
    return wholeSystemCloseLocalMutex.runExclusive(async () => {
        await assertMariaDbCommerceWritesAllowed();
        return saveReportMarkerAfterClosePreflight(tillNumber, periodStart, periodEnd, extra);
    });
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
    const existingIsActive = existing[0] && Number(existing[0].isActive ?? 1) !== 0;
    if (!existing[0] || existing[0].name !== name || !existingIsActive) {
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
    await sqlite.upsert('settings', {
        key: 'till_name_manual',
        value: 'true',
        updatedAt: new Date().toISOString(),
    }, 'key');
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
async function closeShiftLocalFirstAfterClosePreflight(shift: any): Promise<void> {
    const serverDataEpoch = await captureServerDataEpochForMutation();
    const stamped = { ...shift, updatedAt: shift.updatedAt || new Date().toISOString() };
    await sqlite.upsert('shifts', stamped);
    shiftsDB.update(list => list.map(existing => existing.id === stamped.id ? stamped : existing));

    if (!isMultiMode()) return;
    await queueOffline('shifts', 'upsert', stamped, 'id', serverDataEpoch);
    void flushOfflineQueue().catch((error) => {
        console.warn('database: shift close outbox flush failed:', error);
        connectionState.update(state => ({ ...state, mysqlOnline: false, syncError: String(error) }));
    });
}

export async function closeShiftLocalFirst(shift: any): Promise<void> {
    if (!isMultiMode()) return closeShiftLocalFirstAfterClosePreflight(shift);
    return wholeSystemCloseLocalMutex.runExclusive(async () => {
        await assertMariaDbCommerceWritesAllowed();
        await closeShiftLocalFirstAfterClosePreflight(shift);
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
        if (n > 0) {
            await ensureSequentialDefaultTillName(n);
            return n;
        }
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
            await ensureSequentialDefaultTillName(seq);
            console.log(`database: claimed till sequence #${seq} for receipt numbering`);
            return seq;
        }
    } catch (e) {
        console.warn('database: could not claim till sequence:', e);
    }
    return 0;
}

async function ensureSequentialDefaultTillName(sequence: number): Promise<void> {
    if (!isMultiMode() || sequence <= 0) return;
    const d = await sqlite.getDb();
    const rows: any[] = await d.select(
        `SELECT key, value FROM settings WHERE key IN ('till_name', 'till_name_manual')`,
    );
    const values = new Map(rows.map((row) => [String(row.key), String(row.value || '')]));
    if (values.get('till_name_manual') === 'true') return;

    const currentName = (values.get('till_name') || '').trim();
    if (currentName && !/^Till\s+\d+$/i.test(currentName)) return;

    const desiredName = `Till ${sequence}`;
    if (currentName === desiredName) return;

    await sqlite.setTillName(desiredName);
    await getTillName();
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

async function waitForDatabaseActivityToStop(timeoutMs = 30_000): Promise<void> {
    offlineQueueFlushRequested = false;
    const deadline = Date.now() + timeoutMs;
    while (isSyncRunning
        || isFastSyncRunning
        || isChangeSyncRunning
        || isHeartbeatRunning
        || isPresenceRunning
        || offlineQueueFlushPromise) {
        if (Date.now() >= deadline) {
            throw new Error(`Database synchronization did not become idle within ${Math.round(timeoutMs / 1000)} seconds`);
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

async function closeLocalDatabaseForRestore(): Promise<void> {
    stopBackgroundSync();
    try {
        await waitForDatabaseActivityToStop();
    } catch (error) {
        if (isMultiMode()) void startBackgroundSync();
        throw new Error(`Restore stopped: ${String(error)}`);
    }
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
    localAvailable: boolean;
    mariaDbAvailable: boolean | null;
}

export interface SyncRuntimeDiagnostics {
    browserPreview: boolean;
    syncApplicable: boolean;
    mariaDbReachable: boolean | null;
    syncReady: boolean;
    reachabilityError: string;
    syncBlockReason: string;
}

const CRITICAL_SCHEMA: Record<string, string[]> = {
    products: ['id', 'price', 'costPrice', 'stockLevel', 'trackStock', 'allowPriceOverride', 'isAgeRestricted', 'updatedAt'],
    product_images: ['id', 'image', 'updatedAt'],
    discounts: ['id', 'kind', 'groupId', 'bundleQuantity', 'bundlePrice', 'updatedAt'],
    promo_groups: ['id', 'name', 'isActive', 'updatedAt'],
    promo_group_items: ['id', 'groupId', 'productId', 'updatedAt'],
    orders: ['id', 'orderNumber', 'receiptKey', 'shiftId', 'employeeId', 'taxTotal', 'total', 'tillNumber', 'updatedAt'],
    order_lines: ['id', 'orderId', 'productId', 'costPrice', 'taxRate', 'taxAmount', 'lineTotal', 'updatedAt'],
    payments: ['id', 'orderId', 'amount', 'cashAmount', 'cardAmount', 'loyaltyAmount', 'accountAmount', 'updatedAt'],
    customers: ['id', 'name', 'postcode', 'loyaltyCode', 'loyaltyPoints', 'updatedAt'],
    customer_accounts: ['id', 'customerId', 'isEnabled', 'creditLimitPence', 'balancePence', 'createdAt', 'updatedAt'],
    customer_account_entries: [
        'id', 'accountId', 'customerId', 'orderId', 'entryType', 'amountPence',
        'paymentMethod', 'reference', 'description', 'receiptNumber', 'receiptKey',
        'employeeId', 'tillNumber', 'shiftId', 'idempotencyKey', 'reversesEntryId',
        'balanceAfterPence', 'createdAt', 'updatedAt',
    ],
    daily_sales_summary: [
        'date', 'tillNumber', 'cashTotal', 'cardTotal', 'accountTotal',
        'accountRepaymentsCash', 'accountRepaymentsCard', 'accountRepaymentsOther',
        'totalSales', 'transactionCount', 'updatedAt',
    ],
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
    app_identity: ['id', 'shopId', 'shopName', 'licenseId', 'identitySignature', 'updatedAt'],
};

const LOCAL_COORDINATION_SCHEMA: Record<string, string[]> = {
    _offline_queue: [
        'id', 'table_name', 'operation', 'data', 'id_key', 'created_at',
        'attempt_count', 'last_error', 'next_attempt_at',
    ],
    _sync_conflicts: ['id', 'table_name', 'operation', 'data', 'reason', 'created_at'],
    _online_financial_intent: [
        'id', 'operation', 'orderId', 'requestJson', 'bundleJson',
        'createdAt', 'updatedAt', 'lastError',
    ],
};

const MARIADB_COORDINATION_SCHEMA: Record<string, string[]> = {
    sync_change_log: ['seq', 'table_name', 'changedAt'],
    pos_schema_migrations: ['name', 'appliedAt'],
    till_presence: [
        'tillId', 'tillName', 'closeProtocolVersion', 'closeBarrierToken',
        'closeBarrierPhase', 'outboxCount', 'localTerminalAttemptCount',
        'syncConflictCount', 'barrierObservedAt', 'lastSeenAt',
    ],
    pos_close_barrier: [
        'id', 'token', 'state', 'ownerTillId', 'requestedAt', 'expiresAt',
        'cutoffAt', 'lastClosedAt',
    ],
    pos_restore_gate: ['id', 'ownerTillId', 'isActive', 'claimedAt'],
    pos_account_write_authority: ['connectionId', 'authorityToken', 'expiresAt'],
    pos_customer_write_locks: ['customerId'],
    payment_terminal_locks: [
        'terminalKey', 'tillId', 'tillName', 'paymentReference', 'acquiredAt', 'expiresAt',
    ],
    payment_terminal_attempts: [
        'id', 'provider', 'terminalKey', 'clientTransactionId', 'terminalSessionId',
        'operationKind', 'amount', 'expectedProviderAmount', 'currency', 'status',
        'saleBundle', 'providerReference', 'error', 'tillId', 'createdAt', 'updatedAt',
        'activeTerminalKey',
    ],
};

const REQUIRED_MARIADB_MIGRATION_MARKERS = [
    '2026-07-customer-account-schema-v4',
    mysql.MYSQL_IDENTIFIER_COLLATION_MIGRATION,
    '2026-07-account-ledger-guards-binary-v1',
    '2026-07-customer-anti-resurrection-guards-collation-v2',
    'daily_account_repayments_other_v1',
];

const TIMESTAMP_TRIGGER_TABLES = [
    'app_identity',
    'products', 'product_images', 'categories', 'pos_pages', 'pos_tiles',
    'tax_rates', 'discounts', 'promo_groups', 'promo_group_items',
    'employees', 'settings', 'customers', 'customer_accounts',
    'customer_account_entries', 'registers',
    'suppliers', 'product_suppliers', 'inventory_logs',
    'orders', 'order_lines', 'payments',
    'loyalty_logs', 'audit_logs', 'shifts', 'cash_movements',
    'till_report_markers', 'manager_approvals',
    'stock_receipts', 'stock_receipt_lines', 'tombstones',
];

const DELETE_TRIGGER_TABLES = [
    'products', 'product_images', 'categories', 'pos_pages', 'pos_tiles',
    'tax_rates', 'discounts', 'promo_groups', 'promo_group_items',
    'employees', 'customers', 'customer_accounts', 'customer_account_entries',
    'registers', 'suppliers', 'product_suppliers', 'inventory_logs',
    'orders', 'order_lines', 'payments', 'loyalty_logs', 'audit_logs',
    'shifts', 'cash_movements', 'till_report_markers', 'manager_approvals',
    'stock_receipts', 'stock_receipt_lines',
];

const REQUIRED_FINANCIAL_GUARD_TRIGGERS = [
    'pos_guard_account_balance_insert',
    'pos_guard_account_balance_update',
    'pos_guard_account_delete',
    'pos_guard_account_entry_insert',
    'pos_guard_account_entry_update',
    'pos_guard_account_entry_delete',
    'pos_guard_customer_resurrection_insert',
    'pos_guard_customer_resurrection_update',
    'pos_guard_customer_resurrection_delete',
    'pos_guard_customer_account_resurrection_insert',
    'pos_guard_customer_account_resurrection_update',
    'pos_guard_customer_account_resurrection_delete',
    'pos_guard_customer_order_insert',
    'pos_guard_customer_order_update',
    'pos_guard_customer_loyalty_log_insert',
    'pos_guard_customer_loyalty_log_update',
    'pos_guard_customer_account_entry_insert',
    'pos_guard_customer_account_entry_update',
];

const COLLATION_COMPATIBILITY_PAIRS: Array<[[string, string], [string, string]]> = [
    [['products', 'categoryId'], ['categories', 'id']],
    [['products', 'taxRateId'], ['tax_rates', 'id']],
    [['product_images', 'id'], ['products', 'id']],
    [['pos_tiles', 'pageId'], ['pos_pages', 'id']],
    [['promo_group_items', 'groupId'], ['promo_groups', 'id']],
    [['promo_group_items', 'productId'], ['products', 'id']],
    [['product_suppliers', 'productId'], ['products', 'id']],
    [['product_suppliers', 'supplierId'], ['suppliers', 'id']],
    [['inventory_logs', 'productId'], ['products', 'id']],
    [['order_lines', 'orderId'], ['orders', 'id']],
    [['order_lines', 'productId'], ['products', 'id']],
    [['payments', 'orderId'], ['orders', 'id']],
    [['orders', 'customerId'], ['customers', 'id']],
    [['loyalty_logs', 'customerId'], ['customers', 'id']],
    [['customer_accounts', 'customerId'], ['customers', 'id']],
    [['customer_account_entries', 'accountId'], ['customer_accounts', 'id']],
    [['customer_account_entries', 'customerId'], ['customers', 'id']],
    [['customer_account_entries', 'orderId'], ['orders', 'id']],
    [['customer_account_entries', 'receiptKey'], ['orders', 'receiptKey']],
    [['customer_account_entries', 'employeeId'], ['employees', 'id']],
    [['customer_account_entries', 'tillNumber'], ['registers', 'id']],
    [['customer_account_entries', 'shiftId'], ['shifts', 'id']],
    [['customer_account_entries', 'reversesEntryId'], ['customer_account_entries', 'id']],
    [['pos_customer_write_locks', 'customerId'], ['customers', 'id']],
    [['shifts', 'registerId'], ['registers', 'id']],
    [['orders', 'shiftId'], ['shifts', 'id']],
    [['stock_receipt_lines', 'receiptId'], ['stock_receipts', 'id']],
    [['stock_receipt_lines', 'productId'], ['products', 'id']],
];

const MARIADB_BINARY_COORDINATION_COLUMNS: Array<[string, string]> = [
    ['pos_restore_gate', 'ownerTillId'],
    ['pos_account_write_authority', 'authorityToken'],
    ['till_presence', 'tillId'],
    ['till_presence', 'closeBarrierToken'],
    ['pos_close_barrier', 'token'],
    ['pos_close_barrier', 'ownerTillId'],
    ['payment_terminal_locks', 'terminalKey'],
    ['payment_terminal_locks', 'tillId'],
    ['payment_terminal_locks', 'paymentReference'],
    ['payment_terminal_attempts', 'id'],
    ['payment_terminal_attempts', 'terminalKey'],
    ['payment_terminal_attempts', 'clientTransactionId'],
    ['payment_terminal_attempts', 'terminalSessionId'],
    ['payment_terminal_attempts', 'tillId'],
    ['payment_terminal_attempts', 'activeTerminalKey'],
];

function databaseErrorMessage(error: unknown): string {
    return String(error).replace(/^Error:\s*/, '').trim();
}

function metadataValue(row: any, upper: string, lower: string): string {
    return String(row?.[upper] ?? row?.[lower] ?? '');
}

export async function getSyncRuntimeDiagnostics(): Promise<SyncRuntimeDiagnostics> {
    if (!isTauri()) {
        return {
            browserPreview: true,
            syncApplicable: false,
            mariaDbReachable: null,
            syncReady: false,
            reachabilityError: 'MariaDB diagnostics are unavailable in browser preview.',
            syncBlockReason: 'Install and run the desktop app to use SQLite and MariaDB sync.',
        };
    }

    const state = get(connectionState);
    if (state.mode !== 'multi') {
        return {
            browserPreview: false,
            syncApplicable: false,
            mariaDbReachable: null,
            syncReady: false,
            reachabilityError: '',
            syncBlockReason: 'This till is configured for local-only mode.',
        };
    }
    if (!state.mysqlConfig) {
        return {
            browserPreview: false,
            syncApplicable: true,
            mariaDbReachable: false,
            syncReady: false,
            reachabilityError: 'MariaDB configuration is missing.',
            syncBlockReason: state.syncError || 'Sync cannot start without MariaDB configuration.',
        };
    }

    try {
        const remote = await getMysqlDb();
        if (!remote) throw new Error('MariaDB connection is unavailable');
        await remote.select('SELECT 1 AS reachable');
        const syncReady = state.mysqlOnline && !state.syncError;
        return {
            browserPreview: false,
            syncApplicable: true,
            mariaDbReachable: true,
            syncReady,
            reachabilityError: '',
            syncBlockReason: syncReady
                ? ''
                : state.syncError || 'MariaDB answered, but sync startup has not completed.',
        };
    } catch (error) {
        return {
            browserPreview: false,
            syncApplicable: true,
            mariaDbReachable: false,
            syncReady: false,
            reachabilityError: databaseErrorMessage(error),
            syncBlockReason: state.syncError || 'MariaDB is unreachable.',
        };
    }
}

export async function validateDatabaseSchemas(): Promise<SchemaValidationResult> {
    const issues: string[] = [];
    let localAvailable = true;
    let mariaDbAvailable: boolean | null = isMultiMode() ? false : null;

    try {
        const local = await sqlite.getDb();
        const versionRows: any[] = await local.select(`PRAGMA user_version`);
        const localSchemaVersion = Number(versionRows[0]?.user_version || 0);
        if (localSchemaVersion !== 1) {
            issues.push(`SQLite: schema version is ${localSchemaVersion}; expected 1`);
        }
        for (const [table, expected] of Object.entries({
            ...CRITICAL_SCHEMA,
            ...LOCAL_COORDINATION_SCHEMA,
        })) {
            const rows: any[] = await local.select(`PRAGMA table_info(${table})`);
            const columns = new Set(rows.map((row) => String(row.name || '')));
            for (const column of expected) {
                if (!columns.has(column)) issues.push(`SQLite: ${table}.${column} is missing`);
            }
        }
    } catch (error) {
        localAvailable = false;
        issues.push(`SQLite: schema check unavailable (${databaseErrorMessage(error)})`);
    }

    if (isMultiMode()) {
        let remote: any = null;
        try {
            remote = await getMysqlDb();
            if (!remote) throw new Error('server connection is unavailable');
            await remote.select('SELECT 1 AS reachable');
            mariaDbAvailable = true;
        } catch (error) {
            mariaDbAvailable = false;
            issues.push(`MariaDB: schema check unavailable (${databaseErrorMessage(error)})`);
        }

        if (remote && mariaDbAvailable) {
            try {
                for (const [table, expected] of Object.entries({
                    ...CRITICAL_SCHEMA,
                    ...MARIADB_COORDINATION_SCHEMA,
                })) {
                    const rows: any[] = await remote.select(
                        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
                         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
                        [table],
                    );
                    const columns = new Set(rows.map((row) =>
                        metadataValue(row, 'COLUMN_NAME', 'column_name')
                    ));
                    for (const column of expected) {
                        if (!columns.has(column)) issues.push(`MariaDB: ${table}.${column} is missing`);
                    }
                }
            } catch (error) {
                issues.push(`MariaDB: column metadata check failed (${databaseErrorMessage(error)})`);
            }

            try {
                const singletonRows: any[] = await remote.select(`
                    SELECT
                        EXISTS(SELECT 1 FROM pos_close_barrier WHERE id = 1) AS closeBarrierRow,
                        EXISTS(SELECT 1 FROM pos_restore_gate WHERE id = 1) AS restoreGateRow
                `);
                const row = singletonRows[0] || {};
                if (Number(row.closeBarrierRow ?? row.CLOSE_BARRIER_ROW ?? 0) !== 1) {
                    issues.push('MariaDB: pos_close_barrier singleton row id=1 is missing');
                }
                if (Number(row.restoreGateRow ?? row.RESTORE_GATE_ROW ?? 0) !== 1) {
                    issues.push('MariaDB: pos_restore_gate singleton row id=1 is missing');
                }
            } catch (error) {
                issues.push(`MariaDB: coordination singleton check failed (${databaseErrorMessage(error)})`);
            }

            try {
                const markerRows: any[] = await remote.select(
                    `SELECT name FROM pos_schema_migrations
                     WHERE name IN (${REQUIRED_MARIADB_MIGRATION_MARKERS.map(() => '?').join(', ')})`,
                    REQUIRED_MARIADB_MIGRATION_MARKERS,
                );
                const markers = new Set(markerRows.map((row) =>
                    metadataValue(row, 'NAME', 'name')
                ));
                for (const marker of REQUIRED_MARIADB_MIGRATION_MARKERS) {
                    if (!markers.has(marker)) {
                        issues.push(`MariaDB: required migration marker ${marker} is missing`);
                    }
                }
            } catch (error) {
                issues.push(`MariaDB: migration marker check failed (${databaseErrorMessage(error)})`);
            }

            try {
                const triggerRows: any[] = await remote.select(
                    `SELECT TRIGGER_NAME FROM INFORMATION_SCHEMA.TRIGGERS
                     WHERE TRIGGER_SCHEMA = DATABASE()`,
                );
                const triggers = new Set(triggerRows.map((row) =>
                    metadataValue(row, 'TRIGGER_NAME', 'trigger_name')
                ));
                const triggerGroups = [
                    {
                        label: 'timestamp',
                        names: TIMESTAMP_TRIGGER_TABLES.flatMap((table) => [
                            `pos_stamp_${table}_insert`,
                            `pos_stamp_${table}_update`,
                        ]),
                    },
                    {
                        label: 'change-log',
                        names: TIMESTAMP_TRIGGER_TABLES.flatMap((table) => [
                            `pos_change_${table}_insert`,
                            `pos_change_${table}_update`,
                            `pos_change_${table}_delete`,
                        ]),
                    },
                    {
                        label: 'delete tombstone',
                        names: DELETE_TRIGGER_TABLES.map((table) => `pos_delete_${table}`),
                    },
                    { label: 'financial/customer guard', names: REQUIRED_FINANCIAL_GUARD_TRIGGERS },
                ];
                for (const group of triggerGroups) {
                    const missing = group.names.filter((name) => !triggers.has(name));
                    if (missing.length > 0) {
                        const preview = missing.slice(0, 8).join(', ');
                        const remainder = missing.length > 8 ? `, +${missing.length - 8} more` : '';
                        issues.push(
                            `MariaDB: ${missing.length} required ${group.label} trigger(s) missing (${preview}${remainder})`,
                        );
                    }
                }
            } catch (error) {
                issues.push(`MariaDB: trigger check failed (${databaseErrorMessage(error)})`);
            }

            try {
                const indexRows: any[] = await remote.select(`
                    SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
                    FROM INFORMATION_SCHEMA.STATISTICS
                    WHERE TABLE_SCHEMA = DATABASE()
                      AND TABLE_NAME IN (
                          'customer_accounts', 'customer_account_entries',
                          'payment_terminal_attempts'
                      )
                    ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX
                `);
                const indexes = new Map<string, { unique: boolean; columns: string[] }>();
                for (const row of indexRows) {
                    const table = metadataValue(row, 'TABLE_NAME', 'table_name');
                    const name = metadataValue(row, 'INDEX_NAME', 'index_name');
                    const key = `${table}.${name}`;
                    const index = indexes.get(key) || { unique: true, columns: [] };
                    index.unique = index.unique && Number(row.NON_UNIQUE ?? row.non_unique ?? 1) === 0;
                    index.columns.push(metadataValue(row, 'COLUMN_NAME', 'column_name'));
                    indexes.set(key, index);
                }
                const requiredUniqueColumns: Array<[string, string]> = [
                    ['customer_accounts', 'id'],
                    ['customer_accounts', 'customerId'],
                    ['customer_account_entries', 'id'],
                    ['customer_account_entries', 'idempotencyKey'],
                    ['payment_terminal_attempts', 'activeTerminalKey'],
                ];
                for (const [table, column] of requiredUniqueColumns) {
                    const present = [...indexes.entries()].some(([key, index]) =>
                        key.startsWith(`${table}.`)
                        && index.unique
                        && index.columns.length === 1
                        && index.columns[0] === column
                    );
                    if (!present) {
                        issues.push(`MariaDB: ${table}.${column} is missing a single-column unique constraint`);
                    }
                }
            } catch (error) {
                issues.push(`MariaDB: uniqueness hardening check failed (${databaseErrorMessage(error)})`);
            }

            try {
                const collationTables = [...new Set([
                    ...COLLATION_COMPATIBILITY_PAIRS.flatMap((pair) => pair.map(([table]) => table)),
                    ...MARIADB_BINARY_COORDINATION_COLUMNS.map(([table]) => table),
                ])];
                const collationRows: any[] = await remote.select(
                    `SELECT TABLE_NAME, COLUMN_NAME, CHARACTER_SET_NAME, COLLATION_NAME
                     FROM INFORMATION_SCHEMA.COLUMNS
                     WHERE TABLE_SCHEMA = DATABASE()
                       AND TABLE_NAME IN (${collationTables.map(() => '?').join(', ')})
                       AND COLLATION_NAME IS NOT NULL`,
                    collationTables,
                );
                const collations = new Map<string, { charset: string; collation: string }>();
                for (const row of collationRows) {
                    const table = metadataValue(row, 'TABLE_NAME', 'table_name');
                    const column = metadataValue(row, 'COLUMN_NAME', 'column_name');
                    collations.set(`${table}.${column}`, {
                        charset: metadataValue(row, 'CHARACTER_SET_NAME', 'character_set_name').toLowerCase(),
                        collation: metadataValue(row, 'COLLATION_NAME', 'collation_name').toLowerCase(),
                    });
                }
                for (const [table, column] of MARIADB_BINARY_COORDINATION_COLUMNS) {
                    const key = `${table}.${column}`;
                    const actual = collations.get(key);
                    if (actual && (actual.charset !== 'utf8mb4' || actual.collation !== 'utf8mb4_bin')) {
                        issues.push(
                            `MariaDB: coordination identifier ${key} uses ${actual.collation || actual.charset || 'no text collation'}; expected utf8mb4_bin`,
                        );
                    }
                }
                for (const [[leftTable, leftColumn], [rightTable, rightColumn]] of COLLATION_COMPATIBILITY_PAIRS) {
                    const leftKey = `${leftTable}.${leftColumn}`;
                    const rightKey = `${rightTable}.${rightColumn}`;
                    const left = collations.get(leftKey);
                    const right = collations.get(rightKey);
                    if (left && right
                        && (left.charset !== right.charset || left.collation !== right.collation)) {
                        issues.push(
                            `MariaDB: incompatible identifier collations ${leftKey} (${left.charset}/${left.collation}) and ${rightKey} (${right.charset}/${right.collation})`,
                        );
                    }
                }
            } catch (error) {
                issues.push(`MariaDB: collation compatibility check failed (${databaseErrorMessage(error)})`);
            }
        }
    }
    return {
        ok: issues.length === 0,
        issues,
        localAvailable,
        mariaDbAvailable,
    };
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

async function ensureCurrentRegisterOnServer(remote: any, localDb: any): Promise<void> {
    const tillId = await sqlite.getOrCreateTillId();
    const tillName = await sqlite.getTillName();
    const [remoteRows, localRows] = await Promise.all([
        remote.select('SELECT * FROM registers WHERE id = ? LIMIT 1', [tillId]),
        localDb.select('SELECT * FROM registers WHERE id = ? LIMIT 1', [tillId]),
    ]);
    const existing = remoteRows[0] || localRows[0] || {};
    const stamp = new Date().toISOString();
    await mysql.mysqlUpsert('registers', {
        id: tillId,
        storeId: existing.storeId || 'store-main',
        name: tillName.trim() || 'Till',
        isActive: true,
        createdAt: existing.createdAt || stamp,
        updatedAt: stamp,
    });
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

const LOCAL_CACHE_RESET_TABLES = [
    'categories', 'products', 'product_images', 'pos_pages', 'pos_tiles',
    'tax_rates', 'discounts', 'promo_groups', 'promo_group_items',
    'employees', 'customers', 'customer_accounts', 'customer_account_entries', 'registers',
    'suppliers', 'product_suppliers', 'inventory_logs',
    'orders', 'order_lines', 'payments',
    'loyalty_logs', 'audit_logs', 'shifts', 'cash_movements',
    'till_report_markers', 'manager_approvals',
    'stock_receipts', 'stock_receipt_lines',
    'daily_sales_summary', 'tombstones',
    '_online_financial_intent',
];

const SERVER_EPOCH_RESET_REQUEST_TABLE = '_server_epoch_reset_request';
const SERVER_EPOCH_RESET_TRIGGER = 'apply_server_epoch_reset';

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

interface ServerEpochResetCounts {
    offlineQueueCount: number;
    onlineIntentCount: number;
}

function sqliteIdentifier(identifier: string): string {
    if (!/^[A-Za-z0-9_]+$/.test(identifier)) {
        throw new Error(`Unsafe SQLite identifier: ${identifier}`);
    }
    return `"${identifier}"`;
}

/**
 * Build a durable trigger so the reset itself is one SQLite statement. The SQL
 * plugin uses a pool, so a JavaScript BEGIN/COMMIT sequence could hop between
 * connections and is not a safe transaction boundary.
 */
async function ensureServerEpochResetTrigger(localDb: any): Promise<void> {
    await localDb.execute(`
        CREATE TABLE IF NOT EXISTS ${sqliteIdentifier(SERVER_EPOCH_RESET_REQUEST_TABLE)} (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            previousEpoch TEXT NOT NULL,
            nextEpoch TEXT NOT NULL,
            appliedAt TEXT NOT NULL,
            offlineQueueCount INTEGER NOT NULL DEFAULT 0,
            onlineIntentCount INTEGER NOT NULL DEFAULT 0
        )
    `);

    const existingResetTables: string[] = [];
    for (const table of LOCAL_CACHE_RESET_TABLES) {
        if (table !== '_online_financial_intent' && await localTableExists(localDb, table)) {
            existingResetTables.push(table);
        }
    }
    const cacheDeletes = existingResetTables
        .map((table) => `DELETE FROM ${sqliteIdentifier(table)};`)
        .join('\n                ');
    const intentColumns: any[] = await localDb.select(`PRAGMA table_info(_online_financial_intent)`);
    const intentEpochJsonField = intentColumns.some((column) => String(column.name) === 'serverDataEpoch')
        ? "'serverDataEpoch', serverDataEpoch,"
        : '';

    await localDb.execute(`DROP TRIGGER IF EXISTS ${sqliteIdentifier(SERVER_EPOCH_RESET_TRIGGER)}`);
    await localDb.execute(`
        CREATE TRIGGER ${sqliteIdentifier(SERVER_EPOCH_RESET_TRIGGER)}
        AFTER INSERT ON ${sqliteIdentifier(SERVER_EPOCH_RESET_REQUEST_TABLE)}
        BEGIN
            INSERT OR REPLACE INTO _sync_conflicts
                (id, table_name, operation, data, reason, created_at)
            SELECT
                'server-epoch:' || NEW.nextEpoch || ':' || id,
                table_name,
                operation,
                data,
                '${SERVER_DATA_EPOCH_MISMATCH_CODE}: MariaDB was restored/replaced at ' || NEW.nextEpoch ||
                    '; this offline change was not replayed automatically.',
                NEW.appliedAt
            FROM _offline_queue;

            INSERT OR REPLACE INTO _sync_conflicts
                (id, table_name, operation, data, reason, created_at)
            SELECT
                'server-epoch:' || NEW.nextEpoch || ':online-financial-intent:' || orderId,
                '_online_financial_intent',
                operation,
                json_object(
                    'id', id,
                    'operation', operation,
                    'orderId', orderId,
                    'requestJson', requestJson,
                    'bundleJson', bundleJson,
                    ${intentEpochJsonField}
                    'createdAt', createdAt,
                    'updatedAt', updatedAt,
                    'lastError', lastError
                ),
                '${SERVER_DATA_EPOCH_MISMATCH_CODE}: MariaDB was restored/replaced at ' || NEW.nextEpoch ||
                    '; this pending financial transaction was quarantined and must not be replayed automatically.',
                NEW.appliedAt
            FROM _online_financial_intent;

            DELETE FROM _offline_queue;
            DELETE FROM _online_financial_intent;
            ${cacheDeletes}
            DELETE FROM settings
            WHERE key LIKE 'sync_ts_%'
               OR key IN (
                    'last_sync_time',
                    'last_fast_sync_time',
                    '${SYNC_CHANGE_CURSOR_KEY}',
                    'bootstrap_uploaded',
                    'transaction_purge_applied_at',
                    '${REPORT_EPOCH_CACHE_KEY}'
               );
            INSERT INTO settings (key, value, updatedAt)
            VALUES ('${SERVER_DATA_EPOCH_KEY}', NEW.nextEpoch, NEW.appliedAt)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updatedAt = excluded.updatedAt;
            INSERT INTO settings (key, value, updatedAt)
            VALUES ('${SERVER_DATA_EPOCH_SEEN_KEY}', NEW.nextEpoch, NEW.appliedAt)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updatedAt = excluded.updatedAt;
        END
    `);
}

async function atomicallyResetLocalCacheForServerEpoch(
    localDb: any,
    seenEpoch: string,
    remoteEpoch: string,
): Promise<ServerEpochResetCounts> {
    await ensureServerEpochResetTrigger(localDb);
    const stamp = new Date().toISOString();
    await localDb.execute(
        `INSERT OR REPLACE INTO ${sqliteIdentifier(SERVER_EPOCH_RESET_REQUEST_TABLE)}
            (id, previousEpoch, nextEpoch, appliedAt, offlineQueueCount, onlineIntentCount)
         SELECT 1, ?, ?, ?,
                (SELECT COUNT(*) FROM _offline_queue),
                (SELECT COUNT(*) FROM _online_financial_intent)`,
        [seenEpoch, remoteEpoch, stamp],
    );
    const rows: any[] = await localDb.select(
        `SELECT offlineQueueCount, onlineIntentCount
         FROM ${sqliteIdentifier(SERVER_EPOCH_RESET_REQUEST_TABLE)} WHERE id = 1`,
    );
    return {
        offlineQueueCount: Number(rows[0]?.offlineQueueCount || 0),
        onlineIntentCount: Number(rows[0]?.onlineIntentCount || 0),
    };
}

async function resetLocalCacheIfServerEpochChanged(remote: any): Promise<boolean> {
    return serverEpochResetMutex.runExclusive(async () => {
        const remoteEpoch = await readRemoteServerDataEpoch(remote);
        if (!remoteEpoch) return false;

        const localDb = await sqlite.getDb();
        const rows: any[] = await localDb.select(
            `SELECT value FROM settings WHERE key = ? LIMIT 1`,
            [SERVER_DATA_EPOCH_SEEN_KEY],
        );
        const seenEpoch = String(rows[0]?.value || '').trim();
        if (seenEpoch === remoteEpoch) return false;

        const quarantined = await atomicallyResetLocalCacheForServerEpoch(localDb, seenEpoch, remoteEpoch);
        retryableOnlineFinancialBundle = null;
        const quarantineSummary = [
            quarantined.offlineQueueCount
                ? `${quarantined.offlineQueueCount} offline change(s)`
                : '',
            quarantined.onlineIntentCount
                ? `${quarantined.onlineIntentCount} pending financial intent(s)`
                : '',
        ].filter(Boolean).join(' and ');
        console.warn(
            `database: MariaDB data epoch changed (${seenEpoch || 'none'} -> ${remoteEpoch}); ` +
            `local cache reset atomically${quarantineSummary ? ` and ${quarantineSummary} quarantined` : ''}.`,
        );
        return true;
    });
}

/**
 * Reconcile restore identity before native code is allowed to replay its
 * durable financial intent. A stale pre-restore intent is quarantined with the
 * rest of the old epoch instead of being committed into the restored server.
 */
export async function reconcileServerDataEpochBeforeFinancialRecovery(): Promise<boolean> {
    if (!isMultiMode()) return false;
    const remote = await getMysqlDb();
    if (!remote) throw new Error('MariaDB is unavailable while checking its restore epoch');
    return resetLocalCacheIfServerEpochChanged(remote);
}

/**
 * Explicit full-backup restore to MariaDB. Keep registered till hardware,
 * replace shop data/staff/business settings, and hold every other till behind
 * a fail-closed maintenance marker until verification and epoch publication.
 */
export async function replaceMariaDbDataFromThisTill(): Promise<void> {
    if (!isMultiMode()) throw new Error('Connect this till to MariaDB first');
    if (!await hasRestorePendingMariaDbReplace()) {
        throw new Error('MariaDB replacement requires an explicit confirmed database-restore marker');
    }
    const remote = await getMysqlDb();
    if (!remote) throw new Error('MariaDB is unavailable');
    await verifyDatabaseIdentityBeforeSchemaMutation();

    stopBackgroundSync();

    try {
        await waitForDatabaseActivityToStop();
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

        const tillId = await sqlite.getOrCreateTillId();
        const state = get(connectionState);
        if (!state.mysqlConfig) throw new Error('MariaDB configuration is unavailable');
        const result = await invoke<{ serverDataEpoch: string }>(
            'replace_mariadb_from_local_restore',
            { mysqlUri: buildMysqlUri(state.mysqlConfig), tillId },
        );
        await ensureCurrentRegisterOnServer(remote, localDb);
        await rememberLocalServerDataEpoch(localDb, result.serverDataEpoch);
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
    if (!isTauri()) {
        const snapshot = getBrowserReportSnapshotForPeriod(startTime, endTime, 'quantity', 10, tillNumber);
        return {
            overview: snapshot.overview,
            breakdown: snapshot.breakdown,
            topProducts: snapshot.topProducts,
        };
    }
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

// ─── Svelte Store Hydration ─────────────────────────────────────────────────

import {
    productsDB, patchProductInStore, categoriesDB, posPagesDB, tilesDB, taxRatesDB, employeesDB,
    settingsDB, customersDB, customerAccountsDB, customerAccountEntriesDB,
    storeDB, registersDB, discountsDB,
    ordersDB, orderLinesDB, paymentsDB, suppliersDB, productSuppliersDB,
    inventoryLogDB, loyaltyLogDB, auditLogDB, shiftsDB, cashMovementsDB,
    promoGroupsDB, promoGroupItemsDB
} from './db';
import { hydrateTheme } from './theme';

function withCustomerAccountSummaries(customers: any[], accounts: CustomerAccount[]): any[] {
    const byCustomer = new Map(accounts.map((account) => [account.customerId, account]));
    return customers.map((customer) => {
        const account = byCustomer.get(customer.id);
        return {
            ...customer,
            accountId: account?.id || customer.id,
            accountEnabled: account?.isEnabled || false,
            accountCreditLimitPence: account?.creditLimitPence || 0,
            accountBalancePence: account?.balancePence || 0,
        };
    });
}

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
            customerAccounts, customerAccountEntries,
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
            sqlite.getAll('customer_accounts'),
            sqlite.getAll('customer_account_entries'),
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
            'isActive', 'isAgeRestricted', 'isWeighable', 'showInGoods', 'trackStock'
        ])));
        taxRatesDB.set(taxRates.map(t => sqlite.rehydrateBooleans(t, ['isDefault'])));
        employeesDB.set(emps.map(e => sqlite.rehydrateBooleans(e, ['isActive'])));
        settingsDB.set(settings);
        hydrateTheme(settings);
        const normalizedAccounts = customerAccounts.map((account) =>
            sqlite.rehydrateBooleans(account, ['isEnabled']) as CustomerAccount);
        customersDB.set(withCustomerAccountSummaries(customers, normalizedAccounts));
        customerAccountsDB.set(normalizedAccounts);
        customerAccountEntriesDB.set(customerAccountEntries as CustomerAccountEntry[]);
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
            'isActive', 'isAgeRestricted', 'isWeighable', 'showInGoods', 'trackStock'
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
    if (shouldHydrate('customers')) {
        customersDB.set(withCustomerAccountSummaries(
            await sqlite.getAll('customers'),
            get(customerAccountsDB),
        ));
    }
    if (shouldHydrate('customer_accounts')) {
        const rows = await sqlite.getAll('customer_accounts');
        customerAccountsDB.set(rows.map((account) =>
            sqlite.rehydrateBooleans(account, ['isEnabled']) as CustomerAccount));
        customersDB.update((customers) => withCustomerAccountSummaries(customers, get(customerAccountsDB)));
    }
    if (shouldHydrate('customer_account_entries')) {
        customerAccountEntriesDB.set(await sqlite.getAll('customer_account_entries'));
    }
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
let lastSyncUserActivityAt = Date.now();
let removeSyncActivityListeners: (() => void) | null = null;
let backgroundSyncGeneration = 0;
const OFFLINE_RECONNECT_CHECK_MS = 60 * 1000;
const ACTIVE_CHANGE_POLL_INTERVAL_MS = 5 * 1000;
const IDLE_CHANGE_POLL_INTERVAL_MS = 15 * 1000;
const SYNC_ACTIVITY_WINDOW_MS = 30 * 1000;
const FAST_SYNC_INTERVAL_MS = 60 * 1000;
const FULL_SYNC_INTERVAL_MS = 15 * 60 * 1000;
const TILL_PRESENCE_INTERVAL_MS = 15 * 1000;
const TILL_ONLINE_WINDOW_SECONDS = 45;
const WHOLE_SYSTEM_CLOSE_PROTOCOL_VERSION = 1;
const SYNC_CHANGE_CURSOR_KEY = 'sync_change_cursor';

export interface ConnectedTill {
    tillId: string;
    tillName: string;
    lastSeenAt: string;
    secondsAgo: number;
    isCurrent: boolean;
}

export interface RegisteredLicenseTill {
    id: string;
    name: string;
    isActive: boolean;
    isCurrent: boolean;
    isConnected: boolean;
    lastSeenAt: string;
    secondsAgo: number | null;
}

const LEGACY_LICENSE_REGISTER_IDS = new Set(['register-main', 'legacy-till']);

async function publishTillPresence(force = false): Promise<void> {
    if (!isMultiMode() || isPresenceRunning) return;
    if (!force && !get(connectionState).mysqlOnline) return;
    isPresenceRunning = true;
    try {
        await wholeSystemCloseLocalMutex.runExclusive(async () => {
            const tillId = await sqlite.getOrCreateTillId();
            const tillName = await getTillName();
            // State/token must be stable across flush + local counts. If a close
            // phase changes underneath this pass, repeat before acknowledging.
            for (let pass = 0; pass < 3; pass += 1) {
                const observed = await mysql.mysqlGetWholeSystemCloseBarrier();
                if (observed.state === 'preparing') {
                    try {
                        await flushOfflineQueue();
                    } catch (error) {
                        console.warn('database: close-barrier outbox flush did not complete:', error);
                    }
                }
                const [queuedOutboxCount, onlineIntentCount, localTerminalAttemptCount, stats] = await Promise.all([
                    pendingOfflineQueueCount(),
                    pendingOnlineFinancialIntentCount(),
                    pendingTerminalRecoveryCount(),
                    getOfflineQueueStats(),
                ]);
                const outboxCount = queuedOutboxCount + onlineIntentCount;
                const barrier = await mysql.mysqlGetWholeSystemCloseBarrier();
                if (barrier.state !== observed.state || barrier.token !== observed.token) continue;
                await mysql.mysqlTouchTillPresence(tillId, tillName, {
                    protocolVersion: WHOLE_SYSTEM_CLOSE_PROTOCOL_VERSION,
                    barrierToken: barrier.state === 'idle' ? '' : barrier.token,
                    barrierPhase: barrier.state === 'preparing'
                        ? 'prepared'
                        : barrier.state === 'frozen' ? 'frozen' : '',
                    outboxCount,
                    localTerminalAttemptCount,
                    syncConflictCount: stats.conflicts,
                });
                return;
            }
            throw new Error('Whole-system close state changed repeatedly while publishing till readiness');
        });
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
    const state = get(connectionState);
    if (!state.mysqlOnline || state.syncError) {
        throw new Error(
            'SYNC_NOT_READY: MariaDB presence is unavailable until sync startup completes',
        );
    }
    // A dashboard read may refresh an already-ready till, but it must never
    // bypass readiness and make an unready process appear live to other tills.
    await publishTillPresence();
    const tills = await mysql.mysqlGetConnectedTills(TILL_ONLINE_WINDOW_SECONDS);
    return tills.map((till) => ({ ...till, isCurrent: till.tillId === tillId }));
}

export async function getRegisteredLicenseTills(): Promise<RegisteredLicenseTill[]> {
    await getTillName();
    const currentTillId = await sqlite.getOrCreateTillId();
    const d = await sqlite.getDb();
    const rows: any[] = await d.select(
        `SELECT id, name, isActive, updatedAt
         FROM registers
         WHERE id NOT IN ('register-main', 'legacy-till')
         ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END,
                  CASE WHEN COALESCE(isActive, 1) <> 0 THEN 0 ELSE 1 END,
                  name COLLATE NOCASE`,
        [currentTillId],
    );

    let connected: ConnectedTill[] = [];
    if (!isMultiMode() || get(connectionState).mysqlOnline) {
        try {
            connected = await getConnectedTills();
        } catch (error) {
            console.warn('database: could not read live tills for the licence page:', error);
        }
    }
    const connectedById = new Map(connected.map((till) => [till.tillId, till]));

    return rows.map((row) => {
        const live = connectedById.get(String(row.id));
        return {
            id: String(row.id),
            name: String(row.name || 'Till'),
            isActive: Number(row.isActive ?? 1) !== 0,
            isCurrent: String(row.id) === currentTillId,
            isConnected: Boolean(live),
            lastSeenAt: live?.lastSeenAt || String(row.updatedAt || ''),
            secondsAgo: live ? Number(live.secondsAgo) : null,
        };
    });
}

export async function retireRegisteredLicenseTill(tillId: string): Promise<RegisteredLicenseTill[]> {
    const cleanTillId = tillId.trim();
    if (!cleanTillId || LEGACY_LICENSE_REGISTER_IDS.has(cleanTillId)) {
        throw new Error('This till cannot be retired');
    }
    const currentTillId = await sqlite.getOrCreateTillId();
    if (cleanTillId === currentTillId) {
        throw new Error('The till currently running this app cannot be retired');
    }

    const d = await sqlite.getDb();
    const rows: any[] = await d.select(`SELECT * FROM registers WHERE id = ? LIMIT 1`, [cleanTillId]);
    const existing = rows[0];
    if (!existing) throw new Error('That registered till no longer exists');
    if (Number(existing.isActive ?? 1) === 0) return getRegisteredLicenseTills();

    if (isMultiMode()) {
        if (!get(connectionState).mysqlOnline) {
            throw new Error('Connect to MariaDB before retiring a till');
        }
        let connected: ConnectedTill[];
        try {
            connected = await getConnectedTills();
        } catch {
            throw new Error('The app could not confirm which tills are online. Try again when sync is connected.');
        }
        if (connected.some((till) => till.tillId === cleanTillId)) {
            throw new Error('That till is currently connected. Close it before retiring it.');
        }
    }

    await upsert('registers', {
        ...existing,
        id: cleanTillId,
        isActive: false,
        updatedAt: new Date().toISOString(),
    });
    if (isMultiMode()) await flushOfflineQueue();
    await hydrateSvelteStores(['registers']);
    return getRegisteredLicenseTills();
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
    'app_identity',
    'orders', 'order_lines', 'payments', 'inventory_logs', 'shifts', 'cash_movements',
    'customers', 'loyalty_logs', 'customer_accounts', 'customer_account_entries',
    'till_report_markers', 'manager_approvals', 'stock_receipts', 'stock_receipt_lines'
];
// MariaDB stamps every synced write with its own UTC clock. A short overlap
// protects timestamp boundaries without repeatedly rescanning hours of sales.
const SYNC_OVERLAP_MS = 5 * 1000;
const SYNC_PULL_PAGE_SIZE = 500;

/** All tables — synced on the full cycle so product and pricing changes catch up without interrupting rapid scanning. */
const ALL_SYNC_TABLES = [
    'app_identity',
    'products', 'product_images', 'categories', 'pos_pages', 'pos_tiles',
    'tax_rates', 'discounts', 'promo_groups', 'promo_group_items',
    'employees', 'settings', 'customers', 'customer_accounts',
    'customer_account_entries', 'registers',
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
export async function runSyncCycle(options: { strict?: boolean } = {}): Promise<void> {
    const strict = Boolean(options.strict);
    if (!isMultiMode()) {
        if (strict) throw new Error('Full pull requires multi-till mode');
        return;
    }
    if (isSyncRunning || isFastSyncRunning || isChangeSyncRunning) {
        if (strict) throw new Error('Another synchronization cycle is still running');
        return;
    }
    if (!get(connectionState).mysqlOnline) {
        if (strict) throw new Error('MariaDB is offline');
        return;
    }
    if (await pauseSyncIfRestorePending()) {
        if (strict) throw new Error(RESTORE_PENDING_MARIADB_REPLACE_MESSAGE);
        return;
    }
    isSyncRunning = true;
    try {
        const mysqlDb = await getMysqlDb();
        if (!mysqlDb) {
            resetRemoteConnections();
            if (strict) throw new Error('MariaDB connection is unavailable');
            return;
        }
        await ensureDatabaseIdentityForSync();
        const serverEpochChanged = await resetLocalCacheIfServerEpochChanged(mysqlDb);
        if (!serverEpochChanged) await assertMariaDbSafeForPull(mysqlDb);

        // Pull deletes first so an offline till cannot resurrect an old
        // promotion that another till already removed.
        const preFlushSyncTime = await mysql.mysqlGetServerTime();
        const removedBeforeFlush = await applyTombstones(preFlushSyncTime, strict);

        // Flush any queued offline operations after applying remote deletions.
        await flushOfflineQueue();
        const repairedPromotions = await pushNewerLocalPromotionPackages();

        // Server clock is the authority for delta sync; read it once per cycle.
        const newSyncTime = await mysql.mysqlGetServerTime();

        let totalChanges = 0;
        const changedTables = new Set<string>();
        const successfulTables = new Set<string>();
        const pullFailures: string[] = [];
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
                pullFailures.push(`${table}: ${String(e)}`);
            }
        }
        await setTableWatermarks(successfulTables, newSyncTime);
        if (strict && pullFailures.length > 0) {
            throw new Error(`Full MariaDB pull failed for ${pullFailures.join('; ')}`);
        }

        const transactionPurged = await applyTransactionPurgeMarker();

        // Apply deletions from other tills AFTER upserts so a delete can't be
        // resurrected by a stale insert in the same cycle.
        const removed = removedBeforeFlush + await applyTombstones(newSyncTime, strict);
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
        if (strict) throw e;
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
    const syncGeneration = ++backgroundSyncGeneration;
    if (syncInterval) clearInterval(syncInterval);
    if (fastSyncInterval) clearInterval(fastSyncInterval);
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (changePollInterval) clearInterval(changePollInterval);
    if (presenceInterval) clearInterval(presenceInterval);
    if (presenceStartTimeout) clearTimeout(presenceStartTimeout);
    removeSyncActivityListeners?.();
    removeSyncActivityListeners = null;
    syncInterval = null;
    fastSyncInterval = null;
    heartbeatInterval = null;
    changePollInterval = null;
    presenceInterval = null;
    presenceStartTimeout = null;

    if (await pauseSyncIfRestorePending()) return;

    if (typeof window !== 'undefined') {
        const markActivity = () => { lastSyncUserActivityAt = Date.now(); };
        window.addEventListener('pointerdown', markActivity, { passive: true });
        window.addEventListener('keydown', markActivity);
        removeSyncActivityListeners = () => {
            window.removeEventListener('pointerdown', markActivity);
            window.removeEventListener('keydown', markActivity);
        };
    }

    // Do not block the POS. A heartbeat confirms the connection first; once
    // online it flushes queued writes and starts a full catch-up sync.
    runHeartbeat().catch(console.error);

    // Cheap cursor polling gives other tills near-real-time changes without
    // repeatedly scanning every transaction table.
    runChangeSyncCycle().catch(console.error);
    const scheduleChangePoll = () => {
        if (syncGeneration !== backgroundSyncGeneration) return;
        const recentlyActive = typeof document !== 'undefined'
            && !document.hidden
            && Date.now() - lastSyncUserActivityAt <= SYNC_ACTIVITY_WINDOW_MS;
        const delay = recentlyActive ? ACTIVE_CHANGE_POLL_INTERVAL_MS : IDLE_CHANGE_POLL_INTERVAL_MS;
        changePollInterval = setTimeout(async () => {
            await runChangeSyncCycle().catch(console.error);
            scheduleChangePoll();
        }, delay);
    };
    scheduleChangePoll();

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
    backgroundSyncGeneration++;
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
    removeSyncActivityListeners?.();
    removeSyncActivityListeners = null;
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

    let closeSession: WholeSystemCloseSession | null = null;
    try {
        if (isMultiMode()) {
            closeSession = await beginWholeSystemClose();
            const state = get(connectionState);
            if (!state.mysqlConfig) throw new Error('MariaDB configuration is unavailable');
            const session = closeSession;
            await wholeSystemCloseLocalMutex.runExclusive(async () => {
                const result = await invoke<TransactionPurgeResult>('purge_mysql_transactions', {
                    mysqlUri: buildMysqlUri(state.mysqlConfig!),
                    token: session.token,
                    ownerTillId: session.ownerTillId,
                });
                closeSession = null; // The native transaction released the frozen barrier.
                await purgeLocalTransactionsBefore(result.marker, result.tillNumbers);
            });
        } else {
            await wholeSystemCloseLocalMutex.runExclusive(async () => {
                if (await pendingTerminalRecoveryCount() > 0) {
                    throw new Error('Complete or recover the active card payment before deleting transaction history');
                }
                if (await pendingOnlineFinancialIntentCount() > 0) {
                    throw new Error('Finish the pending customer-account, loyalty, or refund transaction before deleting transaction history');
                }
                await purgeLocalTransactionsBefore(new Date().toISOString());
            });
        }
        await hydrateSvelteStores();
    } finally {
        if (closeSession) {
            await abortWholeSystemClose(closeSession.token).catch(() => undefined);
        }
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
        await runSyncCycle({ strict: true });

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
            'employees', 'customers', 'customer_accounts', 'customer_account_entries', 'registers',
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

        // This will now download everything from scratch into empty tables.
        // A partial table pull must fail visibly; reporting success here would
        // leave the till with a silently incomplete cache.
        await runSyncCycle({ strict: true });
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
