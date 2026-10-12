import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import type { TaxRate } from './stores/db';
import { taxRateSnapshotsMatch, updatedTaxRateSnapshot } from './taxRateSnapshot';

// Execute the production orchestration without importing the app's startup
// side effects. SQL and IPC are mocked here; native/real-MariaDB suites exercise
// their atomic implementation independently.
const source = ts.createSourceFile('database.ts',
    readFileSync(new URL('./stores/database.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const functionNames = ['isSensitiveAuditKey', 'sanitizeAuditValue', 'auditJson', 'comparableAuditValue',
    'auditComparable', 'currentAuditEmployeeId', 'taxSnapshotAuditRows', 'saveTaxRateSnapshot'];
const declarations = functionNames.map(name => {
    const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (!declaration) throw new Error(`Missing production ${name}`);
    return declaration.getText(source);
});
const auditBooleans = source.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(declaration => declaration.name.getText(source) === 'AUDIT_BOOLEAN_FIELDS'));
if (!auditBooleans) throw new Error('Missing production AUDIT_BOOLEAN_FIELDS');
const production = ts.transpileModule([auditBooleans.getText(source), ...declarations].join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

const before: TaxRate[] = [
    { id: 'standard', name: 'Standard', rate: 0.2, isDefault: true, createdAt: 'created' },
    { id: 'zero', name: 'Zero', rate: 0, isDefault: false, createdAt: 'created' },
];
const saved: TaxRate = { ...before[1], name: 'Zero updated', isDefault: true };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function setup(options: {
    tauri?: boolean; multi?: boolean; permission?: boolean; epoch?: string;
    barriers?: { state: string }[]; gates?: { isActive: number }[];
    currentRows?: TaxRate[]; finalRows?: any[]; cachedRows?: any[]; queued?: number;
    saved?: TaxRate; baseline?: TaxRate[]; failAuditInsert?: number;
} = {}) {
    const trace: string[] = [];
    const inputSaved = options.saved ?? saved;
    const inputBefore = options.baseline ?? before;
    const finalRows = options.finalRows ?? updatedTaxRateSnapshot(inputSaved, inputBefore)
        .map(row => ({ ...row, isDefault: row.isDefault ? 1 : 0, updatedAt: '2026-10-12T12:00:00.000Z' }));
    const taxRatesDB = {
        value: clone(inputBefore),
        set: vi.fn((rows: TaxRate[]) => { trace.push('publish'); taxRatesDB.value = rows; }),
    };
    const auditLogDB = {
        value: [] as any[],
        update: vi.fn((fn: (rows: any[]) => any[]) => { trace.push('publish-audits'); auditLogDB.value = fn(auditLogDB.value); }),
    };
    let auditInsertCount = 0;
    const database = {
        execute: vi.fn(async (query: string, _values?: unknown[]) => {
            trace.push(query);
            if (query.startsWith('INSERT INTO audit_logs') && ++auditInsertCount === options.failAuditInsert) {
                throw new Error('Mock audit insert failed');
            }
        }),
        select: vi.fn(async (query: string) => {
            trace.push(query);
            if (query.includes('FROM pos_close_barrier')) return options.barriers ?? [{ state: 'idle' }];
            if (query.includes('FROM pos_restore_gate')) return options.gates ?? [{ isActive: 0 }];
            if (query.includes("'server_data_epoch'")) return [{ value: options.epoch ?? 'epoch-before' }];
            if (query.startsWith('SELECT id, name, rate,')) return clone(options.currentRows ?? inputBefore);
            if (query === 'SELECT * FROM tax_rates ORDER BY id') return clone(finalRows);
            throw new Error(`Unexpected SQL in focused test: ${query}`);
        }),
    };
    const sqlite = {
        getDb: vi.fn(async () => ({ select: vi.fn(async () => [{ count: options.queued ?? 0 }]) })),
        commitBatch: vi.fn(async (_rows: unknown[]) => { trace.push('cache-commit'); }),
        getAll: vi.fn(async (_table: string) => { trace.push('cache-read'); return clone(options.cachedRows ?? finalRows); }),
        rehydrateBooleans: (row: any, keys: string[]) => Object.fromEntries(Object.entries(row)
            .map(([key, value]) => [key, keys.includes(key) ? Boolean(Number(value)) : value])),
    };
    let nextAuditId = 0;
    const context = vm.createContext({
        exports: {}, Date, taxRateSnapshotsMatch, updatedTaxRateSnapshot,
        crypto: { randomUUID: () => `mock-audit-${++nextAuditId}` }, auditLogDB,
        taxSnapshotMutex: { runExclusive: (fn: () => Promise<void>) => fn() },
        hasPermission: vi.fn(() => options.permission ?? true),
        currentEmployee: { value: { id: 'manager' } }, settingsDB: { value: [] }, taxRatesDB,
        get: (store: { value: unknown }) => store.value,
        isTauri: () => options.tauri ?? true, isMultiMode: () => options.multi ?? true,
        captureServerDataEpochForMutation: vi.fn(async () => 'epoch-before'),
        assertMariaDbCommerceWritesAllowed: vi.fn(async () => undefined),
        flushOfflineQueue: vi.fn(async () => undefined), sqlite,
        connectionState: { value: { mysqlConfig: { database: 'mock-only' } } },
        buildMysqlUri: () => 'mock://no-connection',
        withMysqlSession: vi.fn(async (_uri: string, _purpose: string, fn: (db: typeof database) => Promise<unknown>) => fn(database)),
        console: { warn: vi.fn() },
    });
    vm.runInContext(production, context);
    return {
        context, trace, database, sqlite, taxRatesDB, auditLogDB, finalRows,
        run: () => context.exports.saveTaxRateSnapshot(clone(inputSaved), clone(inputBefore)) as Promise<void>,
    };
}

function sharedAudits(fixture: ReturnType<typeof setup>) {
    const fields = ['id', 'employeeId', 'action', 'entityType', 'entityId', 'oldData', 'newData', 'createdAt', 'updatedAt'];
    return fixture.database.execute.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO audit_logs'))
        .map(([, values]) => Object.fromEntries(fields.map((field, index) => [field, values?.[index]])) as Record<string, any>);
}

function localMutations(fixture: ReturnType<typeof setup>) {
    return fixture.sqlite.commitBatch.mock.calls[0]?.[0] as { table: string; data: any; protectPending?: boolean; expectedTaxRates?: TaxRate[] }[];
}

describe('production tax snapshot transaction and cache publication', () => {
    it('locks close, signed restore gate, epoch and catalogue before comparing and writing, then reads cache before publishing', async () => {
        const fixture = setup();
        await fixture.run();
        const { trace, database, sqlite, taxRatesDB } = fixture;
        const index = (part: string) => trace.findIndex(query => query.includes(part));
        const ordered = ['START TRANSACTION', 'FROM pos_close_barrier', 'CAST(isActive AS SIGNED)',
            "'server_data_epoch'", 'UPDATE pos_catalogue_mutex', 'ORDER BY id FOR UPDATE',
            'UPDATE tax_rates SET isDefault = 0', 'INSERT INTO tax_rates', 'SELECT * FROM tax_rates',
            'INSERT INTO audit_logs', 'COMMIT', 'cache-commit', 'cache-read', 'publish'].map(index);
        expect(ordered.every(value => value >= 0)).toBe(true);
        expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
        expect(database.execute).not.toHaveBeenCalledWith('ROLLBACK');
        expect(sqlite.commitBatch).toHaveBeenCalledOnce();
        expect(localMutations(fixture).filter(row => row.table === 'tax_rates')).toEqual(fixture.finalRows.map(data => ({
            table: 'tax_rates', data, protectPending: true,
        })));
        expect(localMutations(fixture).filter(row => row.table === 'audit_logs')).toEqual(sharedAudits(fixture)
            .map(data => ({ table: 'audit_logs', data, protectPending: true })));
        expect(sqlite.getAll).toHaveBeenCalledExactlyOnceWith('tax_rates');
        expect(taxRatesDB.value.find(row => row.id === 'zero')?.isDefault).toBe(true);
        expect(taxRatesDB.value.find(row => row.id === 'standard')?.isDefault).toBe(false);
    });

    it.each([
        ['dataset replacement', { epoch: 'epoch-after' }, 'database was replaced'],
        ['active close', { barriers: [{ state: 'closing' }] }, 'report close'],
        ['missing close barrier', { barriers: [] }, 'report close'],
        ['active restore', { gates: [{ isActive: 1 }] }, 'database restore'],
        ['missing restore gate', { gates: [] }, 'database restore'],
        ['changed tax baseline', { currentRows: before.map(row => ({ ...row, name: `${row.name} changed` })) }, 'another till'],
    ] as const)('rolls back %s without tax writes or cache publication', async (_label, options, error) => {
        const fixture = setup(options as Parameters<typeof setup>[0]);
        await expect(fixture.run()).rejects.toThrow(error);
        expect(fixture.database.execute).toHaveBeenCalledWith('ROLLBACK');
        expect(fixture.database.execute).not.toHaveBeenCalledWith('COMMIT');
        expect(fixture.trace.some(query => /^(INSERT INTO|UPDATE) tax_rates/.test(query))).toBe(false);
        expect(fixture.sqlite.commitBatch).not.toHaveBeenCalled();
        expect(fixture.taxRatesDB.set).not.toHaveBeenCalled();
    });

    it.each([0, 2])('requires exactly one final default: %i defaults cause rollback before COMMIT', async defaults => {
        const fixture = setup({ finalRows: before.map(row => ({ ...row, isDefault: defaults === 2 ? 1 : 0 })) });
        await expect(fixture.run()).rejects.toThrow('exactly one default');
        expect(fixture.trace.some(query => query.startsWith('INSERT INTO tax_rates'))).toBe(true);
        expect(fixture.database.execute).toHaveBeenCalledWith('ROLLBACK');
        expect(fixture.database.execute).not.toHaveBeenCalledWith('COMMIT');
        expect(fixture.sqlite.commitBatch).not.toHaveBeenCalled();
        expect(fixture.taxRatesDB.set).not.toHaveBeenCalled();
    });

    it('does not publish an older committed snapshot when the native cache accepts newer rows', async () => {
        const cachedRows = before.map(row => ({ ...row, name: `${row.name} newer download`,
            isDefault: row.id === 'standard' ? 1 : 0, updatedAt: '2026-10-12T12:01:00.000Z' }));
        const fixture = setup({ cachedRows });
        await fixture.run();
        expect(fixture.taxRatesDB.value).toEqual(cachedRows.map(row => ({ ...row, isDefault: Boolean(row.isDefault) })));
        expect(fixture.taxRatesDB.value.some(row => row.name === saved.name)).toBe(false);
    });

    it.each(['commitBatch', 'getAll'] as const)('leaves the published store unchanged when post-commit cache %s fails, without reporting a failed server save', async operation => {
        const fixture = setup();
        fixture.sqlite[operation].mockRejectedValue(new Error('Mock cache unavailable'));
        await expect(fixture.run()).resolves.toBeUndefined();
        expect(fixture.database.execute).toHaveBeenCalledWith('COMMIT');
        expect(fixture.database.execute).not.toHaveBeenCalledWith('ROLLBACK');
        expect(fixture.taxRatesDB.set).not.toHaveBeenCalled();
        expect(fixture.context.console.warn).toHaveBeenCalledOnce();
        if (operation === 'commitBatch') expect(fixture.sqlite.getAll).not.toHaveBeenCalled();
    });

    it('does not start a shared transaction while tax edits remain in the local outbox', async () => {
        const fixture = setup({ queued: 1 });
        await expect(fixture.run()).rejects.toThrow('existing tax-rate edits');
        expect(fixture.context.withMysqlSession).not.toHaveBeenCalled();
        expect(fixture.taxRatesDB.set).not.toHaveBeenCalled();
    });

    it('rejects an unauthorized save before shared or local persistence', async () => {
        const fixture = setup({ permission: false });
        await expect(fixture.run()).rejects.toThrow('permission is required');
        expect(fixture.context.captureServerDataEpochForMutation).not.toHaveBeenCalled();
        expect(fixture.sqlite.commitBatch).not.toHaveBeenCalled();
        expect(fixture.taxRatesDB.set).not.toHaveBeenCalled();
    });

    it('passes the frozen complete editor baseline to the first local atomic mutation and publishes after success', async () => {
        const fixture = setup({ multi: false });
        await fixture.run();
        const after = updatedTaxRateSnapshot(saved, before);
        expect(fixture.sqlite.commitBatch).toHaveBeenCalledOnce();
        expect(localMutations(fixture).filter(row => row.table === 'tax_rates')).toEqual(after.map((data, index) => ({
            table: 'tax_rates', data, ...(index === 0 ? { expectedTaxRates: before } : {}),
        })));
        expect(localMutations(fixture).filter(row => row.table === 'audit_logs')).toHaveLength(2);
        expect(fixture.trace).toEqual(['cache-commit', 'publish']);
        expect(fixture.taxRatesDB.value).toEqual(after);
        expect(fixture.context.withMysqlSession).not.toHaveBeenCalled();
    });

    it('does not publish local drafts when the native CAS or atomic batch rejects', async () => {
        const fixture = setup({ multi: false });
        fixture.sqlite.commitBatch.mockRejectedValue(new Error('Tax rates changed. Reload before saving.'));
        await expect(fixture.run()).rejects.toThrow('Reload');
        expect(fixture.taxRatesDB.value).toEqual(before);
        expect(fixture.taxRatesDB.set).not.toHaveBeenCalled();
    });
});

describe('tax audit parity stays atomic with the tax snapshot', () => {
    it('audits the old default and edited new default from authoritative snapshots, not the temporary clear', async () => {
        const unchanged: TaxRate = { id: 'reduced', name: 'Reduced', rate: 0.05, isDefault: false, createdAt: 'created' };
        const baseline = [...before, unchanged];
        const fixture = setup({ baseline, currentRows: baseline.map(row => ({ ...row, isDefault: row.isDefault ? 1 : 0 })) as any });
        await fixture.run();
        const audits = sharedAudits(fixture);
        expect(audits).toHaveLength(2);
        expect(audits.map(row => row.entityId)).toEqual(['standard', 'zero']);
        for (const row of audits) {
            expect(row).toMatchObject({ action: 'tax_rate_updated', entityType: 'tax_rate', employeeId: 'manager' });
            expect(JSON.parse(row.newData)).not.toHaveProperty('updatedAt');
        }
        expect(JSON.parse(audits[0].oldData)).toMatchObject({ id: 'standard', isDefault: 1 });
        expect(JSON.parse(audits[0].newData)).toMatchObject({ id: 'standard', isDefault: 0 });
        expect(JSON.parse(audits[1].oldData)).toMatchObject({ id: 'zero', name: 'Zero', isDefault: 0 });
        expect(JSON.parse(audits[1].newData)).toMatchObject({ id: 'zero', name: 'Zero updated', isDefault: 1 });
        const commit = fixture.trace.indexOf('COMMIT');
        expect(fixture.trace.map((sql, index) => sql.startsWith('INSERT INTO audit_logs') ? index : -1)
            .filter(index => index >= 0).every(index => index < commit)).toBe(true);
    });

    it.each([true, false])('does not invent changed-tax audit rows for a boolean/timestamp-only no-op (shared=%s)', async multi => {
        const fixture = setup({ multi, saved: { ...before[0] } });
        await fixture.run();
        expect(sharedAudits(fixture)).toEqual([]);
        expect(localMutations(fixture).filter(row => row.table === 'audit_logs')).toEqual([]);
    });

    it('records a newly added nondefault rate as tax_rate_created with no prior data', async () => {
        const created: TaxRate = { id: 'reduced', name: 'Reduced', rate: 0.05, isDefault: false, createdAt: 'new-created' };
        const fixture = setup({ saved: created });
        await fixture.run();
        expect(sharedAudits(fixture)).toHaveLength(1);
        const audit = sharedAudits(fixture)[0];
        expect(audit).toMatchObject({ action: 'tax_rate_created', entityType: 'tax_rate', entityId: 'reduced', oldData: '' });
        expect(JSON.parse(audit.newData)).toMatchObject({ ...created, isDefault: 0 });
    });

    it('rolls back the entire shared save if the second audit insertion fails, without publishing tax or cache changes', async () => {
        const fixture = setup({ failAuditInsert: 2 });
        await expect(fixture.run()).rejects.toThrow('audit insert failed');
        expect(sharedAudits(fixture)).toHaveLength(2);
        expect(fixture.trace.some(sql => sql.startsWith('INSERT INTO tax_rates'))).toBe(true);
        expect(fixture.database.execute).toHaveBeenCalledWith('ROLLBACK');
        expect(fixture.database.execute).not.toHaveBeenCalledWith('COMMIT');
        expect(fixture.sqlite.commitBatch).not.toHaveBeenCalled();
        expect(fixture.taxRatesDB.set).not.toHaveBeenCalled();
        expect(fixture.auditLogDB.update).not.toHaveBeenCalled();
    });

    it('keeps the permission-checked employee attribution when the signed-in employee changes during preflight', async () => {
        const fixture = setup();
        fixture.context.captureServerDataEpochForMutation.mockImplementation(async () => {
            fixture.context.currentEmployee.value = { id: 'different-employee' };
            return 'epoch-before';
        });
        await fixture.run();
        expect(sharedAudits(fixture).map(row => row.employeeId)).toEqual(['manager', 'manager']);
    });

    it('places local old/new-default audits in the same batch as the CAS-protected tax rows', async () => {
        const fixture = setup({ multi: false });
        await fixture.run();
        const batch = localMutations(fixture);
        expect(fixture.sqlite.commitBatch).toHaveBeenCalledOnce();
        expect(batch[0]).toHaveProperty('expectedTaxRates', before);
        const audits = batch.filter(row => row.table === 'audit_logs');
        expect(audits).toHaveLength(2);
        expect(audits.map(row => row.data)).toEqual(expect.arrayContaining([
            expect.objectContaining({ entityId: 'standard', action: 'tax_rate_updated', employeeId: 'manager' }),
            expect.objectContaining({ entityId: 'zero', action: 'tax_rate_updated', employeeId: 'manager' }),
        ]));
        expect(batch.every(row => !Object.hasOwn(row, 'queueId'))).toBe(true);
        expect(fixture.auditLogDB.update).not.toHaveBeenCalled();
    });

    it('preserves browser preview audit parity without SQL/IPC or durable writes', async () => {
        const fixture = setup({ tauri: false });
        await fixture.run();
        expect(fixture.auditLogDB.value).toHaveLength(2);
        expect(fixture.auditLogDB.value.map(row => row.entityId)).toEqual(['standard', 'zero']);
        expect(fixture.taxRatesDB.value).toEqual(updatedTaxRateSnapshot(saved, before));
        expect(fixture.sqlite.commitBatch).not.toHaveBeenCalled();
        expect(fixture.context.withMysqlSession).not.toHaveBeenCalled();
    });
});
