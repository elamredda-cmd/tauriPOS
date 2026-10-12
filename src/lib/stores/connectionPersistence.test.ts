import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
const { commit, select } = vi.hoisted(() => ({ commit: vi.fn(), select: vi.fn() }));
vi.mock('./sqlite', () => ({ commitBatch: commit, getDb: async () => ({ select }) }));
import { captureConnectionSettings, connectionState, restoreConnectionSettings, saveMode } from './connection';
import { settingsDB } from './db';

describe('atomic connection configuration', () => {
    const previous = { mode: 'single' as const, mysqlConfig: null, mysqlOnline: false, mysqlReady: true, mysqlStatus: 'online' as const, syncError: null };
    const candidate = { host: 'test.invalid', port: 3306, user: 'fixture', password: 'fixture', database: 'fixture' };
    let database: DatabaseSync;
    beforeEach(() => {
        commit.mockReset(); select.mockReset(); connectionState.set(previous);
        settingsDB.set([{ key: 'pos_mode', value: 'single', updatedAt: 'original-stamp' }]);
        database = new DatabaseSync(':memory:');
        database.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updatedAt TEXT);
            CREATE TABLE audit_logs (id TEXT PRIMARY KEY, employeeId TEXT, action TEXT, entityType TEXT, entityId TEXT, oldData TEXT, newData TEXT, createdAt TEXT, updatedAt TEXT);
            INSERT INTO settings VALUES ('pos_mode', 'single', 'original-stamp');`);
        select.mockImplementation(async (sql: string) => database.prepare(sql).all());
        // Exercise real SQLite rollback with the production mutation batch.
        // The native local_batch tests separately prove the deployed boundary.
        commit.mockImplementation(async (mutations: any[]) => {
            database.exec('BEGIN IMMEDIATE');
            try {
                for (const mutation of mutations) {
                    if (mutation.kind === 'remove') {
                        database.prepare(`DELETE FROM ${mutation.table} WHERE ${mutation.idKey || 'id'}=?`)
                            .run(mutation.data[mutation.idKey || 'id']);
                    } else {
                        const fields = Object.keys(mutation.data);
                        database.prepare(`INSERT OR REPLACE INTO ${mutation.table} (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`)
                            .run(...fields.map(key => mutation.data[key]));
                    }
                }
                database.exec('COMMIT');
                return mutations.length;
            } catch (error) { database.exec('ROLLBACK'); throw error; }
        });
    });
    afterEach(() => database.close());
    it('commits mode and connection in one native atomic batch', async () => {
        await saveMode('multi', candidate);
        expect(commit).toHaveBeenCalledTimes(1);
        expect(commit.mock.calls[0][0]).toEqual([
            expect.objectContaining({ table: 'settings', idKey: 'key', data: expect.objectContaining({ key: 'pos_mode', value: 'multi' }) }),
            expect.objectContaining({ table: 'settings', idKey: 'key', data: expect.objectContaining({ key: 'mysql_config', value: JSON.stringify(candidate) }) }),
            expect.objectContaining({ table: 'audit_logs', data: expect.objectContaining({ action: 'connection_configuration_saved' }) }),
        ]);
        expect(get(connectionState).mysqlConfig).toEqual(candidate);
    });
    it('does not change working reactive state when the atomic write fails', async () => {
        commit.mockRejectedValueOnce(Error('disk full'));
        await expect(saveMode('multi', candidate)).rejects.toThrow('disk full');
        expect(get(connectionState)).toEqual(previous);
    });
    it('restores original single-mode rows and the absence of saved credentials after a candidate save', async () => {
        const snapshot = await captureConnectionSettings();
        await saveMode('multi', candidate);
        await restoreConnectionSettings(snapshot);
        expect(database.prepare('SELECT * FROM settings ORDER BY key').all()).toEqual(snapshot.rows);
        expect(database.prepare("SELECT * FROM settings WHERE key='mysql_config'").get()).toBeUndefined();
        const audits = database.prepare('SELECT action,oldData,newData FROM audit_logs ORDER BY rowid').all();
        expect(audits.map(row => row.action)).toEqual(['connection_configuration_saved', 'connection_configuration_restored']);
        expect(JSON.stringify(audits)).not.toContain(candidate.host);
        expect(JSON.stringify(audits)).not.toContain(candidate.password);
        expect(JSON.parse(String(audits[1].newData))).toMatchObject({ mode: 'single', mysqlConfigPresent: false, credentials: '[redacted]' });
        expect(get(settingsDB)).toEqual(snapshot.rows);
    });
    it('restores an existing raw configuration and timestamp exactly, even when single mode retained it', async () => {
        const oldValue = JSON.stringify({ ...candidate, host: 'previous.invalid' }, null, 2);
        database.prepare('INSERT INTO settings VALUES (?,?,?)').run('mysql_config', oldValue, 'old-configuration-stamp');
        const snapshot = await captureConnectionSettings();
        await saveMode('multi', candidate);
        await restoreConnectionSettings(snapshot);
        expect(database.prepare('SELECT * FROM settings ORDER BY key').all()).toEqual(snapshot.rows);
    });
    it('rolls back both configuration changes when the accompanying audit fails', async () => {
        const before = await captureConnectionSettings();
        database.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
        await expect(saveMode('multi', candidate)).rejects.toThrow('audit unavailable');
        expect(await captureConnectionSettings()).toEqual(before);
        expect(get(connectionState)).toEqual(previous);
        expect(get(settingsDB)).toEqual(before.rows);
    });
    it('never claims rollback when its settings-plus-audit transaction fails', async () => {
        const original = await captureConnectionSettings();
        await saveMode('multi', candidate);
        const candidateSnapshot = await captureConnectionSettings();
        const published = get(settingsDB);
        database.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'rollback audit unavailable'); END");
        await expect(restoreConnectionSettings(original)).rejects.toThrow('rollback audit unavailable');
        expect(await captureConnectionSettings()).toEqual(candidateSnapshot);
        expect(get(settingsDB)).toEqual(published);
    });
});
