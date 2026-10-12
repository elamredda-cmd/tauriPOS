import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: native.load } }));
vi.mock('@tauri-apps/api/core', async original => ({
    ...await original<typeof import('@tauri-apps/api/core')>(), isTauri: () => true,
}));

let database: DatabaseSync;
let sqlite: typeof import('./sqlite');
let execute: ReturnType<typeof vi.fn>;

beforeEach(async () => {
    vi.resetModules();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    database = new DatabaseSync(':memory:');
    // Node's bundled SQLite does not necessarily include FTS5. This ordinary
    // mirror table exercises the app's exact SQLite search-trigger bodies
    // (DELETE/INSERT and rowid semantics), not the FTS tokenizer itself.
    database.exec('CREATE TABLE product_search_fts (id TEXT, name TEXT, sku TEXT, barcode TEXT, scalePlu TEXT)');
    execute = vi.fn(async (sql: string, params: any[] = []) => {
        const result = database.prepare(sql).run(...params);
        return { rowsAffected: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) };
    });
    native.load.mockReset().mockResolvedValue({
        path: ':memory:',
        select: async (sql: string, params: any[] = []) => database.prepare(sql).all(...params),
        execute,
        close: async () => database.close(),
    });
    sqlite = await import('./sqlite');
    // Exercise the actual app migration path and its real trigger definitions.
    await sqlite.initDb();
    database.exec(`
        CREATE TABLE identifier_repair_updates (productId TEXT);
        CREATE TRIGGER identifier_repair_update_probe AFTER UPDATE ON products BEGIN
            INSERT INTO identifier_repair_updates(productId) VALUES(new.id);
        END;
    `);
});

afterEach(async () => {
    await sqlite.closeDb();
    vi.restoreAllMocks();
});

function addProduct(id: string, barcode: string | null, scalePlu: string | null, sku: string | null) {
    database.prepare('INSERT INTO products (id, name, price, barcode, scalePlu, sku) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, `Test ${id}`, 175, barcode, scalePlu, sku);
}

function updates(): Record<string, unknown>[] {
    return database.prepare('SELECT productId, COUNT(*) AS count FROM identifier_repair_updates GROUP BY productId ORDER BY productId').all();
}

describe('startup identifier normalization avoids no-op FTS writes', () => {
    it('does not touch already-NULL or valid identifiers during repeated real startup', async () => {
        addProduct('already-null', null, null, null);
        addProduct('valid', '123456789', '00123', 'SKU-1');
        await sqlite.initDb();
        expect(updates()).toEqual([]);
        expect(database.prepare('SELECT id, barcode, scalePlu, sku FROM products ORDER BY id').all()).toEqual([
            { id: 'already-null', barcode: null, scalePlu: null, sku: null },
            { id: 'valid', barcode: '123456789', scalePlu: '00123', sku: 'SKU-1' },
        ]);
        expect(database.prepare('SELECT id FROM product_search_fts ORDER BY id').all()).toEqual([
            { id: 'already-null' }, { id: 'valid' },
        ]);
    });

    it('still repairs empty and space-only legacy identifiers, then performs no repairs on the next startup', async () => {
        addProduct('empty', '', '', '');
        addProduct('spaces', '   ', '   ', '   ');
        addProduct('already-null', null, null, null);
        await sqlite.initDb();
        expect(database.prepare('SELECT id, barcode, scalePlu, sku FROM products ORDER BY id').all()).toEqual([
            { id: 'already-null', barcode: null, scalePlu: null, sku: null },
            { id: 'empty', barcode: null, scalePlu: null, sku: null },
            { id: 'spaces', barcode: null, scalePlu: null, sku: null },
        ]);
        expect(updates()).toEqual([{ productId: 'empty', count: 3 }, { productId: 'spaces', count: 3 }]);
        expect(database.prepare("SELECT id, barcode, scalePlu, sku FROM product_search_fts WHERE id = 'spaces'").get())
            .toEqual({ id: 'spaces', barcode: null, scalePlu: null, sku: null });
        database.exec('DELETE FROM identifier_repair_updates');
        await sqlite.initDb();
        expect(updates()).toEqual([]);
    });

    it('runs all three normalization statements with zero affected rows for already-repaired products', async () => {
        addProduct('already-null', null, null, null);
        execute.mockClear();
        await sqlite.initDb();
        const repairs = execute.mock.calls
            .map((args: any[], index: number) => ({ sql: String(args[0]), result: execute.mock.results[index] }))
            .filter(({ sql }: { sql: string }) => /^UPDATE products SET (barcode|scalePlu|sku) = NULL WHERE/.test(sql));
        expect(repairs).toHaveLength(3);
        for (const { sql, result } of repairs) {
            expect(sql).toContain('IS NOT NULL AND TRIM(');
            await expect(result.value).resolves.toMatchObject({ rowsAffected: 0 });
        }
        expect(updates()).toEqual([]);
    });
});
