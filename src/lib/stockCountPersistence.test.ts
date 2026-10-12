import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Run the actual count orchestration with IPC/session boundaries mocked. Native
// SQLite tests exercise the atomic batch; the opt-in scratch suite executes the
// production SQL captured here against MariaDB, never configured shop data.
const source = ts.createSourceFile('database.ts', readFileSync(new URL('./stores/database.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'setStockLevel');
if (!declaration) throw new Error('Missing production setStockLevel');
const production = ts.transpileModule(declaration.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
type Query = { sql: string; values: unknown[] };
function setup(options: {
    native?: boolean; multi?: boolean; online?: boolean; epoch?: string; remoteEpoch?: string;
    stock?: number; localStock?: number; missing?: boolean; desired?: number; expected?: number;
    queued?: number; conflicts?: number; intents?: number; barrier?: string; restore?: number;
    failAudit?: boolean; failCommit?: boolean; failCache?: boolean; failLocalRead?: boolean; acceptedStock?: number;
} = {}) {
    const queries: Query[] = [];
    const events: string[] = [];
    const before = { id: 'p', name: 'Preserve metadata', price: 100, stockLevel: options.localStock ?? 10, updatedAt: 'local-before' };
    const server = { ...before, stockLevel: options.stock ?? 10, updatedAt: 'server-before' };
    let readCount = 0;
    let serverChanged = false;
    const query = (sql: string, values: unknown[] = []) => { queries.push({ sql, values }); events.push(sql); };
    const database = {
        select: vi.fn(async (sql: string, values: unknown[] = []) => {
            query(sql, values);
            if (sql.includes('FROM pos_close_barrier')) return [{ state: options.barrier ?? 'idle' }];
            if (sql.includes('FROM pos_restore_gate')) return [{ isActive: options.restore ?? 0 }];
            if (sql.includes("'server_data_epoch'")) return [{ value: options.remoteEpoch ?? 'epoch' }];
            if (sql.includes('FROM products')) return options.missing ? [] : [serverChanged
                ? { ...server, stockLevel: options.desired ?? 12, updatedAt: 'server-after' } : clone(server)];
            throw new Error(`Unexpected SQL: ${sql}`);
        }),
        execute: vi.fn(async (sql: string, values: unknown[] = []) => {
            query(sql, values);
            if (sql.startsWith('UPDATE products')) serverChanged = true;
            if (sql.startsWith('INSERT INTO audit_logs') && options.failAudit) throw new Error('audit failed');
            if (sql === 'COMMIT' && options.failCommit) throw new Error('transport lost');
            return { rowsAffected: 0 }; // no-op counts must not fail on changedRows=0
        }),
    };
    const sqlite = {
        getDb: vi.fn(async () => ({ select: vi.fn(async (sql: string) => [{ count: sql.includes('_sync_conflicts') ? options.conflicts ?? 0 : options.queued ?? 0 }]) })),
        commitBatch: vi.fn(async (_mutations: any[]) => { events.push('cache'); if (options.failCache) throw new Error('cache failed'); }),
    };
    const patches: any[] = [];
    const audits: any[] = [];
    const context = vm.createContext({ exports: {}, Date, Number, Error,
        crypto: { randomUUID: () => 'count-audit' }, currentAuditEmployeeId: () => 'manager', auditJson: JSON.stringify,
        wholeSystemCloseLocalMutex: { runExclusive: (fn: () => Promise<void>) => fn() },
        isTauri: () => options.native ?? true, isMultiMode: () => options.multi ?? true,
        productsDB: { value: [before] }, auditLogDB: { update: (fn: (rows: any[]) => any[]) => audits.push(...fn([])) },
        get: (store: { value: unknown }) => store.value,
        getLocalRow: vi.fn(async () => { readCount++; if (options.failLocalRead && readCount > 1) throw new Error('cache read failed'); return { ...before, stockLevel: readCount >= 3 ? options.acceptedStock ?? 12 : before.stockLevel }; }),
        patchProductInStore: (row: any) => patches.push(row),
        captureServerDataEpochForMutation: vi.fn(async () => options.epoch ?? 'epoch'),
        connectionState: { value: { mysqlOnline: options.online ?? true, mysqlConfig: { database: 'mock-only' } } },
        assertMariaDbCommerceWritesAllowed: vi.fn(async () => undefined),
        flushOfflineQueue: vi.fn(async () => { events.push('flush'); }),
        pendingOnlineFinancialIntentCount: vi.fn(async () => options.intents ?? 0),
        withMysqlSession: vi.fn(async (_uri: string, _purpose: string, fn: (db: typeof database) => Promise<unknown>) => fn(database)),
        buildMysqlUri: () => 'mock://not-a-database', sqlite, console: { warn: vi.fn() },
    });
    vm.runInContext(production, context);
    return { queries, events, sqlite, database, context, patches, audits,
        run: () => context.exports.setStockLevel('p', options.desired ?? 12, options.expected ?? 10) as Promise<void> };
}

describe('production counted-stock persistence', () => {
    it('uses pinned authority CAS and atomic audit, then publishes only accepted cache stock fields', async () => {
        const f = setup({ acceptedStock: 11 }); await f.run();
        const index = (text: string) => f.events.findIndex(event => event.includes(text));
        const order = ['flush','START TRANSACTION','FROM pos_close_barrier','CAST(isActive AS SIGNED)',"'server_data_epoch'",'FROM products','UPDATE products','INSERT INTO audit_logs','COMMIT','cache'].map(index);
        expect(order.every(value => value >= 0)).toBe(true); expect(order).toEqual([...order].sort((a,b) => a-b));
        expect(f.database.execute).toHaveBeenCalledWith('UPDATE products SET stockLevel = ?, updatedAt = ? WHERE id = ? AND COALESCE(stockLevel, 0) = ?', [12, expect.any(String), 'p', 10]);
        const batch = f.sqlite.commitBatch.mock.calls[0][0];
        expect(batch).toEqual([{ table: 'products', kind: 'setStock', protectPending: true, serverDataEpoch: 'epoch', data: {
            id: 'p', stockLevel: 12, expectedStockLevel: 10, expectedUpdatedAt: 'local-before', updatedAt: 'server-after',
        } }]);
        expect(batch[0]).not.toHaveProperty('queueId'); expect(batch[0].data).not.toHaveProperty('name');
        expect(f.patches).toEqual([{ id: 'p', stockLevel: 11, updatedAt: 'local-before' }]);
    });
    it('rejects a sale after editor opened, refreshes observed stock, and never writes count or audit', async () => {
        const f = setup({ stock: 9, acceptedStock: 9 });
        await expect(f.run()).rejects.toThrow('STOCK_COUNT_CONFLICT');
        expect(f.queries.some(row => row.sql.startsWith('UPDATE products') || row.sql.startsWith('INSERT INTO audit_logs'))).toBe(false);
        expect(f.database.execute).toHaveBeenCalledWith('ROLLBACK');
        expect(f.sqlite.commitBatch.mock.calls[0][0][0].data.stockLevel).toBe(9);
        expect(f.patches[0].stockLevel).toBe(9);
    });
    it.each([
        [{ online: false }, 'cannot be queued offline'], [{ epoch: '' }, 'cannot be queued offline'],
        [{ queued: 1 }, 'pending stock synchronization'], [{ intents: 1 }, 'payment recovery'],
        [{ conflicts: 1 }, 'resolve stock sync conflicts'],
        [{ remoteEpoch: 'replaced' }, 'database was replaced'], [{ barrier: 'frozen' }, 'report close'],
        [{ restore: 1 }, 'database restore'], [{ missing: true }, 'no longer exists'],
    ] as const)('fails closed for %j', async (options, message) => {
        const f = setup(options); await expect(f.run()).rejects.toThrow(message);
        expect(f.queries.some(row => row.sql.startsWith('UPDATE products') || row.sql.startsWith('INSERT INTO audit_logs'))).toBe(false);
        expect(f.sqlite.commitBatch).not.toHaveBeenCalled(); expect(f.patches).toEqual([]);
    });
    it('audit failure rolls back before any cache write', async () => {
        const f = setup({ failAudit: true }); await expect(f.run()).rejects.toThrow('audit failed');
        expect(f.database.execute).toHaveBeenCalledWith('ROLLBACK'); expect(f.database.execute).not.toHaveBeenCalledWith('COMMIT');
        expect(f.sqlite.commitBatch).not.toHaveBeenCalled();
    });
    it('COMMIT uncertainty explicitly prevents repeating the count and cannot queue a retry', async () => {
        const f = setup({ failCommit: true }); await expect(f.run()).rejects.toThrow('Do not repeat it');
        expect(f.sqlite.commitBatch).not.toHaveBeenCalled(); expect(f.patches).toEqual([]);
    });
    it('cache failure after confirmed server commit does not falsely report count failure', async () => {
        const f = setup({ failCache: true }); await expect(f.run()).resolves.toBeUndefined();
        expect(f.database.execute).toHaveBeenCalledWith('COMMIT'); expect(f.patches).toEqual([]);
    });
    it('standalone count and audit use the same native CAS batch without queueing', async () => {
        const f = setup({ multi: false }); await f.run();
        expect(f.queries).toEqual([]); expect(f.sqlite.commitBatch).toHaveBeenCalledOnce();
        const batch = f.sqlite.commitBatch.mock.calls[0][0];
        expect(batch.map(row => [row.table, row.kind])).toEqual([['products','setStock'], ['audit_logs',undefined]]);
        expect(batch.every(row => row.queueId === undefined)).toBe(true);
        expect(JSON.parse(batch[1].data.oldData).stockLevel).toBe(10);
        expect(JSON.parse(batch[1].data.newData).stockLevel).toBe(12);
    });
    it('standalone post-commit display-read failure cannot report a failed count or invite repetition', async () => {
        const f = setup({ multi: false, failLocalRead: true }); await expect(f.run()).resolves.toBeUndefined();
        expect(f.sqlite.commitBatch).toHaveBeenCalledOnce(); expect(f.patches).toEqual([]);
        expect(f.context.console.warn).toHaveBeenCalledWith(expect.stringContaining('committed locally'), expect.anything());
    });
    it('browser preview uses a local CAS without SQL or native IPC', async () => {
        const f = setup({ native: false }); await f.run();
        expect(f.queries).toEqual([]); expect(f.sqlite.commitBatch).not.toHaveBeenCalled(); expect(f.audits).toHaveLength(1);
        await expect(setup({ native: false, localStock: 9 }).run()).rejects.toThrow('STOCK_COUNT_CONFLICT');
    });
    it.each([12.5, 2147483648, -2147483649, Number.NaN, Number.POSITIVE_INFINITY])('rejects unsupported count %s before writes', async desired => {
        const f = setup({ desired }); await expect(f.run()).rejects.toThrow('whole numbers');
        expect(f.queries).toEqual([]); expect(f.sqlite.commitBatch).not.toHaveBeenCalled();
    });
    it('accepts an unchanged count even if SQL reports zero changed rows', async () => {
        const f = setup({ desired: 10 }); await f.run();
        expect(f.queries.some(row => row.sql.startsWith('INSERT INTO audit_logs'))).toBe(true);
        expect(f.database.execute).toHaveBeenCalledWith('COMMIT');
    });
});

const socket = process.env.POS_TEST_CATALOGUE_SOCKET;
(socket ? describe : describe.skip)('count production SQL on isolated MariaDB', () => {
    const schema = `pos_test_count_${process.pid}`;
    const args = ['--no-defaults', `--socket=${socket}`, '-uroot', '--batch', '--raw'];
    const run = (sql: string) => execFileSync('mariadb', [...args, schema, '-e', sql], { encoding: 'utf8', timeout: 15000 });
    const literal = (value: unknown) => value == null ? 'NULL' : typeof value === 'number' ? String(value)
        : `CONVERT(0x${Buffer.from(String(value)).toString('hex')} USING utf8mb4)`;
    const render = ({ sql, values }: Query) => { let index=0; return sql.replace(/\?/g, () => literal(values[index++])) + ';'; };
    beforeAll(() => {
        if (!socket?.startsWith('/tmp/pos-')) throw new Error('A disposable test socket must be explicitly supplied');
        execFileSync('mariadb', [...args, '-e', `CREATE DATABASE ${schema}`]);
        run(`CREATE TABLE products (id VARCHAR(36) PRIMARY KEY, name TEXT, price INT, stockLevel INT, updatedAt TEXT) ENGINE=InnoDB;
            CREATE TABLE audit_logs (id VARCHAR(36) PRIMARY KEY, employeeId TEXT, action TEXT, entityType TEXT, entityId TEXT, oldData TEXT, newData TEXT, createdAt TEXT, updatedAt TEXT) ENGINE=InnoDB;
            CREATE TABLE settings (\`key\` VARCHAR(191) PRIMARY KEY, value TEXT) ENGINE=InnoDB;
            CREATE TABLE pos_close_barrier (id INT PRIMARY KEY, state TEXT) ENGINE=InnoDB;
            CREATE TABLE pos_restore_gate (id INT PRIMARY KEY, isActive TINYINT UNSIGNED) ENGINE=InnoDB;
            INSERT INTO pos_close_barrier VALUES (1,'idle'); INSERT INTO pos_restore_gate VALUES (1,0);
            INSERT INTO settings VALUES ('server_data_epoch','epoch');`);
    });
    afterAll(() => { execFileSync('mariadb', [...args, '-e', `DROP DATABASE ${schema}`]); });
    it('commits stock-only count and audit using the exact production transaction SQL', async () => {
        run("DELETE FROM audit_logs; DELETE FROM products; INSERT INTO products VALUES ('p','Preserve metadata',100,10,'server-before')");
        const f = setup(); await f.run(); run(f.queries.map(render).join('\n'));
        expect(run("SELECT stockLevel,name,price FROM products WHERE id='p'").trim()).toBe('stockLevel\tname\tprice\n12\tPreserve metadata\t100');
        expect(run('SELECT COUNT(*) AS count FROM audit_logs').trim()).toBe('count\n1');
    });
    it('leaves stock and audit untouched after the observed stale-count branch', async () => {
        run("DELETE FROM audit_logs; UPDATE products SET stockLevel=9");
        const f = setup({ stock: 9 }); await expect(f.run()).rejects.toThrow('STOCK_COUNT_CONFLICT'); run(f.queries.map(render).join('\n'));
        expect(run('SELECT stockLevel FROM products').trim()).toBe('stockLevel\n9');
        expect(run('SELECT COUNT(*) AS count FROM audit_logs').trim()).toBe('count\n0');
    });
    it('rolls back counted stock when the production audit insert fails', async () => {
        run("DELETE FROM audit_logs; UPDATE products SET stockLevel=10; INSERT INTO audit_logs (id) VALUES ('count-audit')");
        const f = setup(); await f.run();
        expect(() => run(f.queries.map(render).join('\n'))).toThrow('Duplicate entry');
        expect(run('SELECT stockLevel FROM products').trim()).toBe('stockLevel\n10');
        expect(run('SELECT COUNT(*) AS count FROM audit_logs').trim()).toBe('count\n1');
    });
});
