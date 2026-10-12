import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const installer = fileURLToPath(new URL('../../scripts/qa/native-catalogue-fixtures.mjs', import.meta.url));
const label = 'qa-native17-20261012';

describe('isolated native catalogue fixture installer safety', () => {
    let temporary: string;
    let databasePath: string;
    let db: DatabaseSync;

    beforeEach(() => {
        temporary = mkdtempSync(path.join(os.tmpdir(), 'pos-native-fixture-test-'));
        const directory = path.join(temporary, 'com.elamreda.tauri-app.native-qa');
        mkdirSync(directory);
        databasePath = path.join(directory, 'pos.db');
        db = new DatabaseSync(databasePath);
        db.exec(`
            CREATE TABLE products (id TEXT PRIMARY KEY, categoryId TEXT, taxRateId TEXT, name TEXT NOT NULL, sku TEXT, barcode TEXT, scalePlu TEXT, price INTEGER NOT NULL, costPrice INTEGER, stockLevel INTEGER, trackStock INTEGER, allowPriceOverride INTEGER, isWeighable INTEGER, showInGoods INTEGER, goodsSortOrder INTEGER, color TEXT, image TEXT, isActive INTEGER, createdAt TEXT, updatedAt TEXT, isAgeRestricted INTEGER);
            CREATE TABLE suppliers (id TEXT PRIMARY KEY, name TEXT NOT NULL, contactName TEXT, phone TEXT, email TEXT, address TEXT, notes TEXT, createdAt TEXT, updatedAt TEXT);
            CREATE TABLE stock_receipts (id TEXT PRIMARY KEY, supplierId TEXT, employeeId TEXT, reference TEXT, notes TEXT, totalCost INTEGER, status TEXT, createdAt TEXT, updatedAt TEXT);
            CREATE TABLE stock_receipt_lines (id TEXT PRIMARY KEY, receiptId TEXT, productId TEXT, quantity INTEGER, unitCost INTEGER, createdAt TEXT, updatedAt TEXT);
            CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT);
            CREATE TABLE tax_rates (id TEXT PRIMARY KEY, isDefault INTEGER);
            CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updatedAt TEXT);
            INSERT INTO categories VALUES ('category','Ordinary category');
            INSERT INTO tax_rates VALUES ('tax',1);
            INSERT INTO settings VALUES ('pos_mode','single','original');
        `);
    });

    afterEach(() => {
        db.close();
        // This explicit path is always the directory created by this test.
        rmSync(temporary, { recursive: true, force: true });
    });

    function run(...extra: string[]) {
        return execFileSync(process.execPath, [installer, '--database', databasePath, ...extra], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        });
    }

    it('is read-only by default and states the native-only scope', () => {
        const planned = JSON.parse(run());
        expect(planned).toMatchObject({ apply: false, products: 1105, suppliers: 125, receipts: 65, receiptLines: 130 });
        expect(planned.notes).toContain('not evidence of receipt-write or sync');
        expect(db.prepare('SELECT COUNT(*) AS count FROM products').get()?.count).toBe(0);
        expect(db.prepare('SELECT COUNT(*) AS count FROM settings').get()?.count).toBe(1);
    });

    it('seeds actual SQLite rows, canonical pages and exact receipt detail only when explicitly applied', () => {
        expect(JSON.parse(run('--apply')).committed).toBe(true);
        for (const [table, expected] of [['products',1105], ['suppliers',125], ['stock_receipts',65], ['stock_receipt_lines',130]] as const) {
            expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count).toBe(expected);
        }
        const pages = JSON.parse(String(db.prepare('SELECT value FROM settings WHERE key=?').get('scale_tile_pages')?.value));
        expect(pages[0].productIds).toHaveLength(101);
        expect(pages[0].productIds.at(-1)).toBe(`${label}-unavailable-product`);
        expect(pages[1].productIds).toEqual([101,102,103].map(index => `${label}-product-${String(index).padStart(4,'0')}`));
        expect(new Set(pages.flatMap((page: any) => page.productIds)).size).toBe(104);
        const oldest = db.prepare('SELECT * FROM stock_receipts ORDER BY createdAt,id LIMIT 1').get();
        expect(oldest).toMatchObject({ reference: 'QA Native17 INV-000', totalCost: 525, status: 'received' });
        const lines = db.prepare('SELECT quantity,unitCost FROM stock_receipt_lines WHERE receiptId=? ORDER BY id').all(String(oldest?.id));
        expect(lines.map(row => [row.quantity,row.unitCost])).toEqual([[3,175],[2,0]]);
        expect(db.prepare('SELECT COUNT(*) AS count FROM products WHERE isAgeRestricted<>0 OR isActive<>1 OR isWeighable<>1').get()?.count).toBe(0);
        expect(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name IN ('orders','payments','customer_account_entries')").get()?.count).toBe(0);
    });

    it('rejects repeated application instead of replacing test outcomes', () => {
        run('--apply');
        expect(() => run('--apply')).toThrow();
        expect(db.prepare('SELECT COUNT(*) AS count FROM products').get()?.count).toBe(1105);
    });

    it('retains and populates production-style FTS5 triggers using the native SQLite CLI', () => {
        execFileSync('sqlite3', [databasePath], { input: `
            CREATE VIRTUAL TABLE product_search_fts USING fts5(id UNINDEXED,name,sku,barcode,scalePlu);
            CREATE TRIGGER products_search_ai AFTER INSERT ON products BEGIN
                INSERT INTO product_search_fts(rowid,id,name,sku,barcode,scalePlu)
                VALUES (new.rowid,new.id,new.name,new.sku,new.barcode,new.scalePlu);
            END;
        `, encoding:'utf8', stdio:['pipe','pipe','pipe'] });
        run('--apply');
        expect(execFileSync('sqlite3', [databasePath, 'SELECT COUNT(*) FROM product_search_fts;'], { encoding:'utf8' }).trim()).toBe('1105');
        expect(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='trigger' AND name='products_search_ai'").get()?.count).toBe(1);
    });

    it('refuses multi-terminal mode before creating any fixture', () => {
        db.prepare('UPDATE settings SET value=? WHERE key=?').run('multi','pos_mode');
        expect(() => run('--apply')).toThrow();
        expect(db.prepare('SELECT COUNT(*) AS count FROM products').get()?.count).toBe(0);
    });

    it('refuses a profile retaining MariaDB configuration', () => {
        db.prepare('INSERT INTO settings VALUES (?,?,?)').run('mysql_config','dummy-config','original');
        expect(() => run('--apply')).toThrow();
        expect(db.prepare('SELECT COUNT(*) AS count FROM products').get()?.count).toBe(0);
    });

    it('refuses a non-isolated path before opening it for writes', () => {
        const ordinaryPath = path.join(temporary,'pos.db');
        copyFileSync(databasePath, ordinaryPath);
        expect(() => execFileSync(process.execPath, [installer, '--database', ordinaryPath, '--apply'], {
            encoding:'utf8', stdio:['ignore','pipe','pipe'],
        })).toThrow();
    });
});
