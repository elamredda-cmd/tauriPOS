import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from '@tauri-apps/plugin-sql';
import { readFileSync } from 'node:fs';

const runtime = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: runtime.load } }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn() }));

import { closeDb, getSuppliersPage, getStockReceiptHistory, getStockReceiptLines } from './sqlite';

describe('bounded supplier and receipt queries (actual SQLite SQL)', () => {
    let sqlite: DatabaseSync;
    let adapter: Database;

    beforeEach(() => {
        sqlite = new DatabaseSync(':memory:');
        sqlite.exec(`
            CREATE TABLE suppliers (id TEXT PRIMARY KEY, name TEXT NOT NULL, contactName TEXT, phone TEXT, email TEXT, address TEXT, notes TEXT, createdAt TEXT, updatedAt TEXT);
            CREATE TABLE stock_receipts (id TEXT PRIMARY KEY, supplierId TEXT, employeeId TEXT, reference TEXT, notes TEXT, totalCost INTEGER, status TEXT, createdAt TEXT, updatedAt TEXT);
            CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT NOT NULL);
            CREATE TABLE stock_receipt_lines (id TEXT PRIMARY KEY, receiptId TEXT NOT NULL, productId TEXT NOT NULL, quantity INTEGER NOT NULL, unitCost INTEGER NOT NULL, createdAt TEXT, updatedAt TEXT);
            CREATE INDEX stock_receipt_order ON stock_receipts(createdAt, id);
            CREATE INDEX supplier_order ON suppliers(name COLLATE NOCASE, id);
            CREATE INDEX stock_line_receipt ON stock_receipt_lines(receiptId, id);
        `);
        adapter = {
            path: 'sqlite::memory:',
            async select<T>(query: string, values: any[] = []) { return sqlite.prepare(query).all(...values) as T; },
            async execute(query: string, values: any[] = []) { return { rowsAffected: Number(sqlite.prepare(query).run(...values).changes) }; },
            async close() { /* Per-test owner closes SQLite after the app cache resets. */ return true; },
        } as Database;
        runtime.load.mockReset().mockResolvedValue(adapter);
    });

    afterEach(async () => { await closeDb(); sqlite.close(); });

    function supplier(id: string, name: string, contact = '', phone = '', email = '') {
        sqlite.prepare('INSERT INTO suppliers (id,name,contactName,phone,email) VALUES (?,?,?,?,?)').run(id, name, contact, phone, email);
    }

    function receipt(index: number, patch: { reference?: string; notes?: string; supplierId?: string; createdAt?: string } = {}) {
        const id = `receipt-${String(index).padStart(3, '0')}`;
        // Ties intentionally exercise the stable id DESC secondary order.
        const date = patch.createdAt || `2026-10-${String(1 + Math.floor(index / 3)).padStart(2, '0')}T12:00:00.000Z`;
        sqlite.prepare('INSERT INTO stock_receipts (id,supplierId,employeeId,reference,notes,totalCost,status,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)')
            .run(id, patch.supplierId || (index % 2 ? 'supplier-a' : 'supplier-b'), 'worker', patch.reference || `INV-${index}`, patch.notes || '', index * 100, 'received', date, date);
        return id;
    }

    it('loads the actual cached database adapter once, not a mocked query function', async () => {
        supplier('one', 'Company');
        await getSuppliersPage();
        await getStockReceiptHistory();
        expect(runtime.load).toHaveBeenCalledTimes(1);
        expect(runtime.load).toHaveBeenCalledWith('sqlite:pos.db');
    });

    it('reaches all 125 suppliers with deterministic no-overlap 25-row pages', async () => {
        for (let index = 0; index < 125; index++) {
            supplier(`supplier-${String(index).padStart(3, '0')}`, `${index % 2 ? 'Company' : 'company'} ${String(Math.floor(index / 3)).padStart(3, '0')}`);
        }
        const pageIds: string[] = [];
        for (let offset = 0; offset < 125; offset += 25) {
            const result = await getSuppliersPage({ limit: 25, offset });
            expect(result.total).toBe(125);
            expect(result.rows).toHaveLength(25);
            pageIds.push(...result.rows.map(row => row.id));
        }
        expect(new Set(pageIds).size).toBe(125);
        const canonical = sqlite.prepare('SELECT id FROM suppliers ORDER BY name COLLATE NOCASE, id').all().map(row => row.id);
        expect(pageIds).toEqual(canonical);
        expect((await getSuppliersPage({ offset: 125 })).rows).toEqual([]);
    });

    it.each([
        ['%', 'percent'], ['_', 'underscore'], ["O'Neil", 'quote'], ['\\', 'backslash'],
        ['contactmatch', 'contact'], ['01234', 'phone'], ['special@example', 'email'],
    ])('matches supplier search literally across fields: %s', async (query, expected) => {
        supplier('percent', '50% supplier');
        supplier('underscore', 'Company_with underscore');
        supplier('quote', "O'Neil Supplies");
        supplier('backslash', 'Path\\part');
        supplier('contact', 'Other company', 'contactmatch');
        supplier('phone', 'Phone company', '', '01234 555');
        supplier('email', 'Email company', '', '', 'special@example.test');
        supplier('plain', 'Ordinary plain supplier');
        const result = await getSuppliersPage({ query });
        expect(result.total).toBe(1);
        expect(result.rows.map(row => row.id)).toEqual([expected]);
    });

    it('binds quoted supplier queries safely and leaves tables intact', async () => {
        const query = "'; DROP TABLE suppliers;--";
        supplier('literal', query);
        supplier('ordinary', 'Ordinary');
        expect((await getSuppliersPage({ query })).rows.map(row => row.id)).toEqual(['literal']);
        expect(sqlite.prepare('SELECT COUNT(*) AS count FROM suppliers').get()?.count).toBe(2);
    });

    it('bounds and floors supplier page sizes/offsets without loading the full list', async () => {
        for (let index = 0; index < 125; index++) supplier(String(index).padStart(3, '0'), String(index).padStart(3, '0'));
        expect((await getSuppliersPage({ limit: 999 })).rows).toHaveLength(100);
        const result = await getSuppliersPage({ limit: 2.9, offset: 3.9 });
        expect(result.rows.map(row => row.id)).toEqual(['003', '004']);
        expect((await getSuppliersPage({ limit: -2, offset: -3 })).rows.map(row => row.id)).toEqual(['000']);
    });

    it('reaches all 65 stock receipts, including older-than-50 entries, without overlaps', async () => {
        for (let index = 0; index < 65; index++) receipt(index);
        const ids: string[] = [];
        for (const offset of [0, 20, 40, 60]) {
            const result = await getStockReceiptHistory({ limit: 20, offset });
            expect(result.total).toBe(65);
            expect(result.rows).toHaveLength(offset === 60 ? 5 : 20);
            ids.push(...result.rows.map(row => row.id));
        }
        expect(new Set(ids).size).toBe(65);
        expect(ids).toEqual(sqlite.prepare('SELECT id FROM stock_receipts ORDER BY createdAt DESC, id DESC').all().map(row => row.id));
        expect(ids.at(-1)).toBe('receipt-000');
    });

    it('combines supplier and reference/notes filters with correct total and pagination', async () => {
        for (let index = 0; index < 65; index++) receipt(index, { notes: 'Wholesale delivery' });
        const result = await getStockReceiptHistory({ query: 'Wholesale', supplierId: 'supplier-a', limit: 10, offset: 10 });
        expect(result.total).toBe(32);
        expect(result.rows).toHaveLength(10);
        expect(result.rows.every(row => row.supplierId === 'supplier-a')).toBe(true);
        const first = await getStockReceiptHistory({ query: 'Wholesale', supplierId: 'supplier-a', limit: 10 });
        expect(result.rows.some(row => first.rows.some(previous => previous.id === row.id))).toBe(false);
        expect((await getStockReceiptHistory({ query: 'Wholesale', supplierId: 'missing' })).total).toBe(0);
    });

    it.each([
        ['%', 1], ['_', 2], ["O'Neil", 3], ['\\', 4], ["'; DROP TABLE receipts;--", 5],
    ])('treats receipt search as literal bound text: %s', async (query, index) => {
        receipt(0, { reference: 'Plain reference', notes: 'Ordinary delivery' });
        receipt(1, { reference: '50% purchase' });
        receipt(2, { notes: 'Literal_underscore' });
        receipt(3, { reference: "O'Neil invoice" });
        receipt(4, { notes: 'Path\\part' });
        receipt(5, { reference: "'; DROP TABLE receipts;--" });
        const result = await getStockReceiptHistory({ query });
        expect(result.total).toBe(1);
        expect(result.rows.map(row => row.id)).toEqual([`receipt-${String(index).padStart(3, '0')}`]);
        expect(sqlite.prepare('SELECT COUNT(*) AS count FROM stock_receipts').get()?.count).toBe(6);
    });

    it('returns exact line quantities/costs with current name join and missing-item fallback', async () => {
        receipt(1);
        receipt(2);
        sqlite.prepare('INSERT INTO products (id,name) VALUES (?,?)').run('product-live', 'Renamed current product');
        const insert = sqlite.prepare('INSERT INTO stock_receipt_lines (id,receiptId,productId,quantity,unitCost) VALUES (?,?,?,?,?)');
        insert.run('line-b', 'receipt-001', 'product-missing', 2, 0);
        insert.run('line-a', 'receipt-001', 'product-live', 3, 175);
        insert.run('line-other-receipt', 'receipt-002', 'product-live', 99, 900);
        const lines = await getStockReceiptLines('receipt-001');
        expect(lines).toEqual([
            expect.objectContaining({ id: 'line-a', quantity: 3, unitCost: 175, productName: 'Renamed current product' }),
            expect.objectContaining({ id: 'line-b', quantity: 2, unitCost: 0, productName: 'Unavailable product' }),
        ]);
        expect(lines.reduce((sum, row) => sum + row.quantity * row.unitCost, 0)).toBe(525);
        expect(await getStockReceiptLines('missing-receipt')).toEqual([]);
        expect(await getStockReceiptLines("'; DROP TABLE products;--")).toEqual([]);
        expect(sqlite.prepare('SELECT COUNT(*) AS count FROM products').get()?.count).toBe(1);
    });

    it('returns empty counts/rows safely for empty supplier and stock history tables', async () => {
        expect(await getSuppliersPage()).toEqual({ rows: [], total: 0 });
        expect(await getStockReceiptHistory()).toEqual({ rows: [], total: 0 });
    });
});

describe('stock history UI wiring (not native UI execution)', () => {
    it('disables zero-result and loading paging controls and exposes detail loading/empty states', () => {
        const source = readFileSync(new URL('../../routes/stock-receiving/+page.svelte', import.meta.url), 'utf8');
        expect(source).toContain('disabled={historyLoading || historyOffset === 0}');
        expect(source).toContain('disabled={historyLoading || historyOffset + PAGE_SIZE >= historyTotal}');
        expect(source).toContain("'0 receipts'");
        expect(source).toContain('Loading delivery lines…');
        expect(source).toContain('No lines available for this receipt.');
        expect(source).toContain('if (historyLoading) return;');
    });
});
