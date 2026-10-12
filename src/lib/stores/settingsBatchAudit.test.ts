import { describe, expect, it, vi } from 'vitest';
import { get, writable } from 'svelte/store';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

/** Execute production batching/audit policy with isolated native transaction boundaries. */
function productionSettingsBatch(native = true) {
    const source = readFileSync('src/lib/stores/database.ts', 'utf8');
    const tree = ts.createSourceFile('database.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const functions = ['saveSettingsBatch', 'shouldAuditSettingKey', 'shouldAuditTableMutation', 'isSensitiveAuditKey',
        'sanitizeAuditValue', 'auditJson', 'comparableAuditValue', 'auditComparable'];
    const constants = ['AUDIT_ENTITY_BY_TABLE', 'AUDITED_TABLES', 'IGNORED_AUDIT_SETTING_KEYS', 'IGNORED_AUDIT_SETTING_PREFIXES', 'AUDIT_BOOLEAN_FIELDS'];
    const statements = tree.statements.filter(node => ts.isFunctionDeclaration(node)
        ? functions.includes(node.name?.text || '')
        : ts.isVariableStatement(node) && node.declarationList.declarations.some(decl => ts.isIdentifier(decl.name) && constants.includes(decl.name.text)));
    for (const name of functions) {
        if (!statements.some(node => ts.isFunctionDeclaration(node) && node.name?.text === name)) throw Error(`Production function missing: ${name}`);
    }
    const body = statements.map(node => node.getText(tree).replace(/^export\s+/, '')).join('\n');
    const js = ts.transpileModule(`${body}\nreturn saveSettingsBatch;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
    const settingsDB = writable<any[]>([{ key: 'sound', value: 'on', updatedAt: 'before' }]);
    const auditLogDB = writable<any[]>([]);
    const readBefore = vi.fn(async (_table: string, _idKey: string, key: string) => get(settingsDB).find(row => row.key === key) || null);
    const commit = vi.fn(async (_mutations: any[], _epoch: string) => undefined);
    const drain = vi.fn();
    let sequence = 0;
    const deps = { isTauri: () => native, getLocalRow: readBefore, get, settingsDB, auditLogDB,
        currentAuditEmployeeId: () => 'qa-actor', crypto: { randomUUID: () => `audit-${++sequence}` },
        captureServerDataEpochForMutation: vi.fn(async () => 'fixture-epoch'), persistLocalChanges: commit,
        drainLocalChanges: drain };
    const save = Function(...Object.keys(deps), js)(...Object.values(deps)) as (rows: any[]) => Promise<void>;
    return { save, settingsDB, auditLogDB, readBefore, commit, drain, deps };
}

describe('production atomic settings plus audit batching', () => {
    it('fails before any commit/publication if an audited before-read fails', async () => {
        const app = productionSettingsBatch();
        app.readBefore.mockRejectedValueOnce(Error('before snapshot unavailable'));
        await expect(app.save([{ key: 'sound', value: 'off', updatedAt: 'now' }])).rejects.toThrow('before snapshot unavailable');
        expect(app.commit).not.toHaveBeenCalled();
        expect(app.drain).not.toHaveBeenCalled();
        expect(get(app.settingsDB)[0].value).toBe('on');
        expect(get(app.auditLogDB)).toEqual([]);
    });
    it('submits setting edits and sanitized audit entries in one native batch', async () => {
        const app = productionSettingsBatch();
        await app.save([{ key: 'sound', value: 'off', updatedAt: 'now' }, { key: 'font', value: 'inter', updatedAt: 'now' }]);
        expect(app.commit).toHaveBeenCalledTimes(1);
        const [mutations, epoch] = app.commit.mock.calls[0] as unknown as [any[], string];
        expect(epoch).toBe('fixture-epoch');
        expect(mutations.filter(row => row.table === 'settings')).toHaveLength(2);
        const audits = mutations.filter(row => row.table === 'audit_logs').map(row => row.data);
        expect(audits).toHaveLength(2);
        expect(audits).toEqual([
            expect.objectContaining({ employeeId: 'qa-actor', action: 'setting_updated', entityId: 'sound' }),
            expect.objectContaining({ employeeId: 'qa-actor', action: 'setting_created', entityId: 'font' }),
        ]);
        expect(JSON.parse(audits[0].oldData)).toEqual({ key: 'sound', value: 'on' });
        expect(JSON.parse(audits[0].newData)).toEqual({ key: 'sound', value: 'off' });
        expect(get(app.settingsDB).find(row => row.key === 'sound').value).toBe('off');
        expect(app.drain).toHaveBeenCalledTimes(1);
    });
    it('omits unchanged and explicitly ignored setting audit records', async () => {
        const app = productionSettingsBatch();
        await app.save([{ key: 'sound', value: 'on', updatedAt: 'new timestamp only' },
            { key: 'last_sync_time', value: 'fixture', updatedAt: 'now' }, { key: 'sync_ts_products', value: 'fixture', updatedAt: 'now' }]);
        const mutations = app.commit.mock.calls[0][0] as unknown as any[];
        expect(mutations.map(row => row.table)).toEqual(['settings', 'settings', 'settings']);
        expect(app.readBefore).toHaveBeenCalledTimes(1);
    });
    it('does not publish either settings or audit logs when native commit rejects', async () => {
        const app = productionSettingsBatch();
        app.commit.mockRejectedValueOnce(Error('native transaction rolled back'));
        await expect(app.save([{ key: 'sound', value: 'off', updatedAt: 'now' }])).rejects.toThrow('native transaction rolled back');
        expect(get(app.settingsDB)).toEqual([{ key: 'sound', value: 'on', updatedAt: 'before' }]);
        expect(get(app.auditLogDB)).toEqual([]);
        expect(app.drain).not.toHaveBeenCalled();
    });
    it('records corresponding preview audit history without a native transaction', async () => {
        const app = productionSettingsBatch(false);
        await app.save([{ key: 'sound', value: 'off', updatedAt: 'now' }, { key: 'last_sync_time', value: 'fixture', updatedAt: 'now' }]);
        expect(app.commit).not.toHaveBeenCalled();
        expect(app.readBefore).not.toHaveBeenCalled();
        expect(get(app.auditLogDB)).toEqual([expect.objectContaining({ action: 'setting_updated', entityId: 'sound' })]);
        expect(get(app.settingsDB).find(row => row.key === 'sound').value).toBe('off');
    });
    it('redacts device credentials and secret-like setting values in audit data', async () => {
        const app = productionSettingsBatch();
        app.settingsDB.set([{ key: 'mysql_config', value: 'old-fixture-secret', updatedAt: 'before' }]);
        await app.save([{ key: 'mysql_config', value: 'new-fixture-secret', updatedAt: 'now' },
            { key: 'device_secret_token', value: 'other-fixture-secret', updatedAt: 'now' }]);
        const mutations = app.commit.mock.calls[0][0] as unknown as any[];
        const audits = mutations.filter(row => row.table === 'audit_logs').map(row => row.data);
        expect(audits).toHaveLength(2);
        expect(JSON.parse(audits[0].oldData).value).toBe('[redacted]');
        for (const audit of audits) expect(JSON.parse(audit.newData).value).toBe('[redacted]');
        expect(JSON.stringify(audits)).not.toContain('fixture-secret');
        expect(mutations.find(row => row.table === 'settings' && row.data.key === 'mysql_config').data.value).toBe('new-fixture-secret');
    });
    it('captures immutable submitted setting rows before an awaited before-read', async () => {
        const app = productionSettingsBatch();
        let finish!: (row: any) => void;
        app.readBefore.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const row = { key: 'sound', value: 'off', updatedAt: 'submitted' };
        const pending = app.save([row]);
        row.value = 'changed draft';
        finish({ key: 'sound', value: 'on', updatedAt: 'before' });
        await pending;
        const mutations = app.commit.mock.calls[0][0] as unknown as any[];
        expect(mutations.find(row => row.table === 'settings').data.value).toBe('off');
        expect(JSON.parse(mutations.find(row => row.table === 'audit_logs').data.newData).value).toBe('off');
    });
});
