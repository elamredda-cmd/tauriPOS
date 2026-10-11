import { DatabaseSync } from 'node:sqlite';
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ load: vi.fn(), getMysqlDb: vi.fn() }));
vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: native.load } }));
vi.mock('@tauri-apps/api/core', async original => ({
    ...await original<typeof import('@tauri-apps/api/core')>(), isTauri: () => true,
}));
vi.mock('./connection', async original => ({
    ...await original<typeof import('./connection')>(), getMysqlDb: native.getMysqlDb,
}));

import { getSyncRuntimeDiagnostics, validateDatabaseSchemas } from './database';
import { connectionState, type PosConnectionState } from './connection';
import { closeDb, initDb, LOCAL_SCHEMA_VERSION } from './sqlite';

let savedConnection: PosConnectionState;
beforeEach(() => {
    savedConnection = get(connectionState);
    vi.clearAllMocks();
    connectionState.set({
        mode: 'multi', mysqlOnline: true, mysqlReady: true, syncError: null,
        mysqlConfig: { host: 'test.invalid', port: 3306, user: 'test', password: '', database: 'isolated' },
    });
});
afterEach(() => {
    connectionState.set(savedConnection);
    vi.restoreAllMocks();
});

describe('local schema diagnostics', () => {
    let database: DatabaseSync;
    beforeEach(async () => {
        connectionState.update(state => ({ ...state, mode: 'single' }));
        vi.spyOn(console, 'log').mockImplementation(() => {});
        database = new DatabaseSync(':memory:');
        native.load.mockResolvedValue({
            path: ':memory:',
            select: async (sql: string, params: any[] = []) => database.prepare(sql).all(...params),
            execute: async (sql: string, params: any[] = []) => {
                const result = database.prepare(sql).run(...params);
                return { rowsAffected: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) };
            },
            close: async () => database.close(),
        });
        // Exercise the real schema migration so validation cannot drift from
        // the version and columns the running till actually installs.
        await initDb();
    });
    afterEach(async () => { await closeDb(); });

    it('accepts the current schema created by the app', async () => {
        expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: LOCAL_SCHEMA_VERSION });
        await expect(validateDatabaseSchemas()).resolves.toEqual({
            ok: true, issues: [], localAvailable: true, mariaDbAvailable: null,
        });
        expect(native.getMysqlDb).not.toHaveBeenCalled();
    });

    it.each([LOCAL_SCHEMA_VERSION - 1, LOCAL_SCHEMA_VERSION + 1])(
        'still warns about an incompatible schema version %s', async version => {
            database.exec(`PRAGMA user_version = ${version}`);
            await expect(validateDatabaseSchemas()).resolves.toEqual({
                ok: false,
                issues: [`SQLite: schema version is ${version}; expected ${LOCAL_SCHEMA_VERSION}`],
                localAvailable: true,
                mariaDbAvailable: null,
            });
        },
    );

    it('still reports a missing critical column on the current version', async () => {
        database.exec('ALTER TABLE employees DROP COLUMN email');
        await expect(validateDatabaseSchemas()).resolves.toEqual({
            ok: false, issues: ['SQLite: employees.email is missing'], localAvailable: true, mariaDbAvailable: null,
        });
    });
});

describe('sync runtime diagnostics', () => {
    it('does not call a reachable server sync-ready until startup recovery is complete', async () => {
        connectionState.update(state => ({ ...state, mysqlReady: false }));
        native.getMysqlDb.mockResolvedValue({ select: vi.fn().mockResolvedValue([{ reachable: 1 }]) });
        await expect(getSyncRuntimeDiagnostics()).resolves.toMatchObject({
            mariaDbReachable: true, syncReady: false,
            syncBlockReason: 'MariaDB answered, but sync startup has not completed.',
        });
    });

    it('reports the recovered state after the awaited probe rather than its offline snapshot', async () => {
        connectionState.update(state => ({ ...state, mysqlOnline: false, mysqlReady: false, syncError: 'Old connection failure' }));
        native.getMysqlDb.mockResolvedValue({
            select: vi.fn(async () => {
                connectionState.update(state => ({ ...state, mysqlOnline: true, mysqlReady: true, syncError: null }));
                return [{ reachable: 1 }];
            }),
        });
        await expect(getSyncRuntimeDiagnostics()).resolves.toMatchObject({
            mariaDbReachable: true, syncReady: true, syncBlockReason: '',
        });
    });

    it('reports a block discovered during the probe instead of the former ready state', async () => {
        native.getMysqlDb.mockResolvedValue({
            select: vi.fn(async () => {
                connectionState.update(state => ({ ...state, mysqlReady: false, syncError: 'Recovery is still pending' }));
                return [{ reachable: 1 }];
            }),
        });
        await expect(getSyncRuntimeDiagnostics()).resolves.toMatchObject({
            mariaDbReachable: true, syncReady: false, syncBlockReason: 'Recovery is still pending',
        });
    });

    it('reports the latest block reason if connection fails while the probe is in flight', async () => {
        native.getMysqlDb.mockImplementation(async () => {
            connectionState.update(state => ({ ...state, mysqlOnline: false, syncError: 'Connection was lost' }));
            throw new Error('Server refused connection');
        });
        await expect(getSyncRuntimeDiagnostics()).resolves.toMatchObject({
            mariaDbReachable: false, syncReady: false,
            reachabilityError: 'Server refused connection', syncBlockReason: 'Connection was lost',
        });
    });

    it('keeps local-only mode independent of server connectivity', async () => {
        connectionState.update(state => ({ ...state, mode: 'single' }));
        await expect(getSyncRuntimeDiagnostics()).resolves.toMatchObject({
            syncApplicable: false, mariaDbReachable: null, syncReady: false,
        });
        expect(native.getMysqlDb).not.toHaveBeenCalled();
    });
});
