/**
 * connection.ts — POS connection mode & state manager
 *
 * Manages whether the app runs in "single" (SQLite-only) or "multi"
 * (MySQL/MariaDB primary + SQLite cache) mode.
 *
 * All persistent config is saved to the local SQLite `settings` table so the
 * chosen mode survives restarts.  MySQL connections are created on demand via
 * `getMysqlDb()` and cached for the lifetime of the process.
 */

import type Database from '@tauri-apps/plugin-sql';
import { writable, get } from 'svelte/store';
import type { Writable } from 'svelte/store';
import {
    getMysqlConnectionGeneration,
    getSharedMysqlConnection,
    isCurrentMysqlConnection,
    probeMysqlConnection,
    resetSharedMysqlConnection,
} from './mysqlPool';

// ─── Types ───────────────────────────────────────────────────────────────────

export type PosMode = 'single' | 'multi';
export type MysqlConnectionStatus = 'pending' | 'online' | 'offline' | 'blocked';

export interface MysqlConfig {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
}

type ConnectionSettingRow = { key: 'pos_mode' | 'mysql_config'; value: string; updatedAt?: string | null };
export interface ConnectionSettingsSnapshot { rows: ConnectionSettingRow[] }

export interface PosConnectionState {
    mode: PosMode | null; // null = not selected yet
    mysqlConfig: MysqlConfig | null;
    mysqlOnline: boolean;
    /** True only after schema setup, identity checks and startup recovery finish. */
    mysqlReady: boolean;
    /** Distinguishes first-start checking from a confirmed offline/blocked outcome. */
    mysqlStatus?: MysqlConnectionStatus;
    syncError: string | null;
}

// ─── Reactive Store ──────────────────────────────────────────────────────────

export const connectionState = writable<PosConnectionState>({
    mode: null,
    mysqlConfig: null,
    mysqlOnline: false,
    mysqlReady: false,
    mysqlStatus: 'pending',
    syncError: null
});

// ─── Internal State ──────────────────────────────────────────────────────────

const HEARTBEAT_TIMEOUT_MS = 3000;

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('MariaDB connection timed out')), timeoutMs);
    });
    try {
        return await Promise.race([operation, timeout]);
    } finally {
        clearTimeout(timeoutId!);
    }
}

// ─── Helpers (access local SQLite via the existing getDb) ────────────────────

/**
 * Import getDb lazily to avoid circular-dependency issues (sqlite.ts is loaded
 * first, and connection.ts may be imported from database.ts which also imports
 * sqlite).
 */
async function localDb(): Promise<Database> {
    const { getDb } = await import('./sqlite');
    return getDb();
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Read the saved POS mode from the local SQLite `settings` table.
 * Returns `null` if no mode has been persisted yet (first launch).
 */
export async function loadSavedMode(): Promise<PosMode | null> {
    try {
        const d = await localDb();
        const rows: any[] = await d.select(
            `SELECT value FROM settings WHERE key = 'pos_mode'`
        );
        if (rows.length > 0 && rows[0].value) {
            const mode = rows[0].value as PosMode;

            // Also restore the MySQL config if available
            let mysqlConfig: MysqlConfig | null = null;
            const cfgRows: any[] = await d.select(
                `SELECT value FROM settings WHERE key = 'mysql_config'`
            );
            if (cfgRows.length > 0 && cfgRows[0].value) {
                try {
                    mysqlConfig = JSON.parse(cfgRows[0].value) as MysqlConfig;
                } catch { /* ignore corrupt JSON */ }
            }

            connectionState.set({
                mode,
                mysqlConfig,
                mysqlOnline: false,
                mysqlReady: false,
                mysqlStatus: mode === 'multi' ? 'pending' : 'online',
                syncError: null,
            });
            return mode;
        }
    } catch (e) {
        console.warn('connection: failed to load saved mode:', e);
    }
    return null;
}

/** Capture the durable rows, including absence and their original timestamps. */
export async function captureConnectionSettings(): Promise<ConnectionSettingsSnapshot> {
    const database = await localDb();
    const rows = await database.select<ConnectionSettingRow[]>(
        "SELECT key, value, updatedAt FROM settings WHERE key IN ('pos_mode', 'mysql_config') ORDER BY key",
    );
    return { rows: rows.map(row => ({ ...row })) };
}

async function persistConnectionSettings(
    before: ConnectionSettingsSnapshot,
    after: ConnectionSettingsSnapshot,
    action: 'connection_configuration_saved' | 'connection_configuration_restored',
): Promise<void> {
    const { commitBatch } = await import('./sqlite');
    const { currentEmployee } = await import('./session');
    const { settingsDB } = await import('./db');
    const keys = ['pos_mode', 'mysql_config'] as const;
    if (after.rows.some(row => !keys.includes(row.key)) || new Set(after.rows.map(row => row.key)).size !== after.rows.length) {
        throw new Error('Invalid saved connection snapshot');
    }
    const stamp = new Date().toISOString();
    // Never duplicate connection strings, credentials, hostnames or users into
    // audit records. Presence and mode are sufficient to explain this action.
    const auditValue = (snapshot: ConnectionSettingsSnapshot) => {
        const mode = snapshot.rows.find(row => row.key === 'pos_mode')?.value;
        return JSON.stringify({
            mode: mode === undefined ? null : mode === 'single' || mode === 'multi' ? mode : '[invalid saved mode]',
            mysqlConfigPresent: snapshot.rows.some(row => row.key === 'mysql_config'),
            credentials: '[redacted]',
        });
    };
    await commitBatch([
        ...keys.map(key => {
            const row = after.rows.find(value => value.key === key);
            return row
                ? { table: 'settings', idKey: 'key', data: { ...row } }
                : { table: 'settings', idKey: 'key', kind: 'remove' as const, data: { key } };
        }),
        { table: 'audit_logs', data: { id: crypto.randomUUID(), employeeId: get(currentEmployee)?.id || '',
            action, entityType: 'connection', entityId: 'local_connection', oldData: auditValue(before),
            newData: auditValue(after), createdAt: stamp, updatedAt: stamp } },
    ]);
    settingsDB.update(rows => [
        ...rows.filter(row => row.key !== 'pos_mode' && row.key !== 'mysql_config'),
        ...after.rows.map(row => ({ ...row, updatedAt: row.updatedAt ?? '' })),
    ]);
}

/** Restore exactly what was durable before a failed reconnect, atomically. */
export async function restoreConnectionSettings(snapshot: ConnectionSettingsSnapshot): Promise<void> {
    const frozen = { rows: snapshot.rows.map(row => ({ ...row })) };
    await persistConnectionSettings(await captureConnectionSettings(), frozen, 'connection_configuration_restored');
    resetMysqlConnection();
}

/**
 * Persist the POS mode (and optional MySQL config) to the local SQLite
 * `settings` table, then update the reactive store.
 */
export async function saveMode(mode: PosMode, config?: MysqlConfig): Promise<void> {
    const before = await captureConnectionSettings();
    const now = new Date().toISOString();
    // Mode and credentials form one configuration; never persist half of it.
    await persistConnectionSettings(before, { rows: [
        { key: 'pos_mode', value: mode, updatedAt: now },
        ...(config ? [{ key: 'mysql_config' as const, value: JSON.stringify(config), updatedAt: now }]
            : before.rows.filter(row => row.key === 'mysql_config')),
    ] }, 'connection_configuration_saved');

    // Always reconnect after saving setup choices so a changed host, database,
    // or credential set can never reuse the previous cached connection.
    resetMysqlConnection();

    connectionState.set({
        mode,
        mysqlConfig: config ?? get(connectionState).mysqlConfig,
        mysqlOnline: false,
        mysqlReady: false,
        mysqlStatus: mode === 'multi' ? 'pending' : 'online',
        syncError: null,
    });
}

/**
 * Build a `mysql://` connection string from a MysqlConfig object.
 */
export function buildMysqlUri(config: MysqlConfig): string {
    const { user, password, host, port, database } = config;
    return `mysql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}

/** Exact local comparison for stale async results; never include credentials in diagnostics. */
export function sameMysqlConnectionConfig(left: MysqlConfig | null, right: MysqlConfig | null): boolean {
    return left === right || Boolean(left && right
        && left.host === right.host && left.port === right.port
        && left.user === right.user && left.password === right.password
        && left.database === right.database);
}

/**
 * Attempt to connect to a MySQL/MariaDB server with the given config.
 * Returns `true` if the connection succeeds, `false` otherwise.
 * Reuses the live pool for its URI; other candidate connections are not cached.
 */
export async function testMysqlConnection(config: MysqlConfig): Promise<boolean> {
    try {
        return await probeMysqlConnection(buildMysqlUri(config));
    } catch (e) {
        console.warn('connection: MySQL test failed:', e);
        return false;
    }
}

/**
 * Return (and lazily create) a MySQL Database instance using the config
 * stored in the reactive state.  Returns `null` if no config is available
 * or if the connection fails.
 */
export async function getMysqlDb(): Promise<Database | null> {
    const { mysqlConfig, mode } = get(connectionState);
    if (!mysqlConfig) return null;
    const uri = buildMysqlUri(mysqlConfig);
    const opening = getSharedMysqlConnection(uri);
    const openingGeneration = getMysqlConnectionGeneration();

    try {
        const database = await opening;
        if (currentMysqlUri() !== uri || get(connectionState).mode !== mode
            || openingGeneration !== getMysqlConnectionGeneration()
            || !isCurrentMysqlConnection(database)) return null;
        connectionState.update(s => ({ ...s, mysqlOnline: true, mysqlStatus: s.mysqlReady ? 'online' : 'pending' }));
        return database;
    } catch (error) {
        console.warn('connection: could not open MySQL connection:', error);
        if (currentMysqlUri() === uri && get(connectionState).mode === mode
            && openingGeneration === getMysqlConnectionGeneration()) {
            connectionState.update(s => ({ ...s, mysqlOnline: false, mysqlReady: false, mysqlStatus: 'offline' }));
        }
        return null;
    }
}

/**
 * Drop the cached MySQL connection so the next getMysqlDb() reconnects.
 * Called by the heartbeat when a liveness check fails, so a dropped link
 * (server restart, Wi-Fi blip, IP change) can recover automatically.
 */
export function resetMysqlConnection(): void {
    resetSharedMysqlConnection();
}

/**
 * Active liveness check against the cached connection. Returns true if the
 * server answered, false otherwise. On failure the cached connection is
 * dropped so the next call can reconnect.
 */
export async function pingMysql(): Promise<boolean> {
    if (!isMultiMode()) return false;
    const config = get(connectionState).mysqlConfig;
    const originalConfig = config ? { ...config } : null;
    const opening = getMysqlDb();
    const pingGeneration = getMysqlConnectionGeneration();
    const isCurrent = () => isMultiMode()
        && sameMysqlConnectionConfig(originalConfig, get(connectionState).mysqlConfig)
        && pingGeneration === getMysqlConnectionGeneration();
    try {
        const db = await opening;
        if (!isCurrent()) return false;
        if (!db) {
            connectionState.update(s => ({ ...s, mysqlOnline: false, mysqlReady: false, mysqlStatus: 'offline' }));
            return false;
        }
        await withTimeout(db.select('SELECT 1'), HEARTBEAT_TIMEOUT_MS);
        if (!isCurrent() || !isCurrentMysqlConnection(db)) return false;
        connectionState.update(s => ({ ...s, mysqlOnline: true, mysqlStatus: s.mysqlReady ? 'online' : 'pending' }));
        return true;
    } catch (e) {
        console.warn('connection: heartbeat ping failed:', e);
        if (!isCurrent()) return false;
        resetMysqlConnection();
        connectionState.update(s => ({ ...s, mysqlOnline: false, mysqlReady: false, mysqlStatus: 'offline' }));
        return false;
    }
}

function currentMysqlUri(): string | null {
    const config = get(connectionState).mysqlConfig;
    return config ? buildMysqlUri(config) : null;
}

/**
 * Quick synchronous check: is the app currently in multi-till mode?
 */
export function isMultiMode(): boolean {
    return get(connectionState).mode === 'multi';
}
