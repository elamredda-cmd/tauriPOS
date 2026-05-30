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

import Database from '@tauri-apps/plugin-sql';
import { writable, get } from 'svelte/store';
import type { Writable } from 'svelte/store';

// ─── Types ───────────────────────────────────────────────────────────────────

export type PosMode = 'single' | 'multi';

export interface MysqlConfig {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
}

export interface PosConnectionState {
    mode: PosMode | null; // null = not selected yet
    mysqlConfig: MysqlConfig | null;
    mysqlOnline: boolean;
    syncError: string | null;
}

// ─── Reactive Store ──────────────────────────────────────────────────────────

export const connectionState = writable<PosConnectionState>({
    mode: null,
    mysqlConfig: null,
    mysqlOnline: false,
    syncError: null
});

// ─── Internal State ──────────────────────────────────────────────────────────

/** Cached MySQL Database instance — reused across calls. */
let mysqlDbInstance: Database | null = null;

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
                    mysqlConfig = JSON.parse(cfgRows[0].value);
                } catch { /* ignore corrupt JSON */ }
            }

            connectionState.set({ mode, mysqlConfig, mysqlOnline: false, syncError: null });
            return mode;
        }
    } catch (e) {
        console.warn('connection: failed to load saved mode:', e);
    }
    return null;
}

/**
 * Persist the POS mode (and optional MySQL config) to the local SQLite
 * `settings` table, then update the reactive store.
 */
export async function saveMode(mode: PosMode, config?: MysqlConfig): Promise<void> {
    const d = await localDb();
    const now = new Date().toISOString();

    await d.execute(
        `INSERT INTO settings (key, value, updatedAt) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
        ['pos_mode', mode, now]
    );

    if (config) {
        await d.execute(
            `INSERT INTO settings (key, value, updatedAt) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
            ['mysql_config', JSON.stringify(config), now]
        );
    }

    // Drop any cached MySQL connection when switching away from multi mode
    if (mode === 'single') {
        mysqlDbInstance = null;
    }

    connectionState.set({
        mode,
        mysqlConfig: config ?? get(connectionState).mysqlConfig,
        mysqlOnline: false,
        syncError: null,
    });
}

/**
 * Build a `mysql://` connection string from a MysqlConfig object.
 */
function buildMysqlUri(config: MysqlConfig): string {
    const { user, password, host, port, database } = config;
    return `mysql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}

/**
 * Attempt to connect to a MySQL/MariaDB server with the given config.
 * Returns `true` if the connection succeeds, `false` otherwise.
 * Does **not** cache the connection — this is a one-shot probe.
 */
export async function testMysqlConnection(config: MysqlConfig): Promise<boolean> {
    try {
        const testDb = await Database.load(buildMysqlUri(config));
        // Run a trivial query to confirm the connection is alive
        await testDb.select('SELECT 1');
        return true;
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
    if (mysqlDbInstance) return mysqlDbInstance;

    const { mysqlConfig } = get(connectionState);
    if (!mysqlConfig) return null;

    try {
        mysqlDbInstance = await Database.load(buildMysqlUri(mysqlConfig));
        // Confirm liveness
        await mysqlDbInstance.select('SELECT 1');
        connectionState.update(s => ({ ...s, mysqlOnline: true }));
        return mysqlDbInstance;
    } catch (e) {
        console.warn('connection: could not open MySQL connection:', e);
        mysqlDbInstance = null;
        connectionState.update(s => ({ ...s, mysqlOnline: false }));
        return null;
    }
}

/**
 * Quick synchronous check: is the app currently in multi-till mode?
 */
export function isMultiMode(): boolean {
    return get(connectionState).mode === 'multi';
}
