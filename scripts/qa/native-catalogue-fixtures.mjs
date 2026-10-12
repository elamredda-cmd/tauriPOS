/**
 * Labeled native-UI fixtures for an isolated, disconnected Tauri QA profile.
 * This does not copy credentials, submit receipts or replay an outbox. It seeds
 * historical read fixtures into real SQLite so the production IPC/read paths
 * and rendered controls can be exercised. Never use it against the shop DB.
 *
 * node scripts/qa/native-catalogue-fixtures.mjs --database /.../com.elamreda.tauri-app.native-qa/pos.db
 * Add --apply only after the isolated profile has been prepared and closed.
 */
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const databaseIndex = args.indexOf('--database');
if (databaseIndex < 0 || !args[databaseIndex + 1]) throw new Error('An explicit --database path is required.');
const requested = path.resolve(args[databaseIndex + 1]);
if (!existsSync(requested)) throw new Error('Prepare the isolated QA schema before seeding.');
const resolved = realpathSync(requested);
if (path.basename(resolved) !== 'pos.db' || path.basename(path.dirname(resolved)) !== 'com.elamreda.tauri-app.native-qa') {
    throw new Error('Refusing a non-isolated database. Expected com.elamreda.tauri-app.native-qa/pos.db.');
}
const original = '/Users/elamreda/Library/Application Support/com.elamreda.tauri-app/pos.db';
if (existsSync(original)) {
    const sourceMetadata = statSync(original);
    const isolatedMetadata = statSync(resolved);
    if (sourceMetadata.dev === isolatedMetadata.dev && sourceMetadata.ino === isolatedMetadata.ino) {
        throw new Error('Refusing an isolated path hard-linked to the shop database. Use an independent SQLite backup.');
    }
}
const apply = args.includes('--apply');
const prefix = 'qa-native17-20261012';
const marker = 'native_qa_catalogue_fixture_v1';
// Apple's SQLite includes FTS5, while some bundled Node SQLite builds do not.
// Use Node only for guarded reads and the FTS5-capable CLI for the one native
// fixture transaction; never drop the copied production search index/triggers.
const database = new DatabaseSync(resolved, { readOnly: true });
const literal = value => typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
const insert = (table, columns, values) => `INSERT INTO ${table} (${columns.join(',')}) VALUES (${values.map(literal).join(',')});`;

try {
    const required = ['products', 'suppliers', 'stock_receipts', 'stock_receipt_lines', 'categories', 'tax_rates', 'settings'];
    for (const table of required) {
        if (!database.prepare('SELECT 1 FROM sqlite_master WHERE type=? AND name=?').get('table', table)) {
            throw new Error(`Missing expected production table: ${table}`);
        }
    }
    const mode = database.prepare('SELECT value FROM settings WHERE key=?').get('pos_mode')?.value;
    if (mode !== 'single') throw new Error('Isolated fixture profile must explicitly use single/disconnected mode.');
    if (database.prepare('SELECT 1 FROM settings WHERE key=?').get('mysql_config')) {
        throw new Error('Remove shared MariaDB credentials from the isolated QA profile before fixture seeding.');
    }
    const category = database.prepare('SELECT id FROM categories ORDER BY name COLLATE NOCASE, id LIMIT 1').get()?.id;
    const tax = database.prepare('SELECT id FROM tax_rates WHERE isDefault=1 ORDER BY id LIMIT 1').get()?.id;
    if (!category || !tax) throw new Error('One existing category and default tax rate are required.');

    const productId = index => `${prefix}-product-${String(index).padStart(4, '0')}`;
    const supplierId = index => `${prefix}-supplier-${String(index).padStart(3, '0')}`;
    const pageA = {
        id: `${prefix}-page-a`, name: 'QA Native17 Page A', color: '#0f766e',
        productIds: [...Array.from({ length: 100 }, (_, index) => productId(index + 1)), `${prefix}-unavailable-product`],
    };
    const pageB = {
        id: `${prefix}-page-b`, name: 'QA Native17 Page B', color: '#2563eb',
        productIds: [productId(101), productId(102), productId(103)],
    };
    const summary = {
        isolatedDatabase: resolved, apply, label: prefix,
        products: 1105, suppliers: 125, receipts: 65, receiptLines: 130,
        scalePages: [pageA.name, pageB.name],
        search: 'QA Native17', searchCapExpected: '1000+',
        notes: 'Historical UI fixtures only; not evidence of receipt-write or sync execution.',
    };
    if (!apply) {
        console.log(JSON.stringify(summary, null, 2));
    } else {
        if (database.prepare('SELECT 1 FROM settings WHERE key=?').get(marker)) {
            throw new Error('This isolated profile already contains the fixture marker; do not overwrite a native test run.');
        }
        if (database.prepare('SELECT 1 FROM products WHERE id LIKE ? LIMIT 1').get(`${prefix}-%`)) {
            throw new Error('Fixture IDs already exist without a marker; inspect rather than overwrite.');
        }
        const statements = [
            '.bail on', '.timeout 5000', 'PRAGMA foreign_keys=ON;', 'BEGIN IMMEDIATE;',
            'CREATE TEMP TABLE fixture_precondition (ok INTEGER NOT NULL CHECK(ok=1));',
            `INSERT INTO fixture_precondition SELECT CASE WHEN
                (SELECT value FROM settings WHERE key='pos_mode')='single'
                AND NOT EXISTS (SELECT 1 FROM settings WHERE key='mysql_config')
                AND NOT EXISTS (SELECT 1 FROM settings WHERE key=${literal(marker)})
                AND NOT EXISTS (SELECT 1 FROM products WHERE id LIKE ${literal(`${prefix}-%`)})
                AND EXISTS (SELECT 1 FROM categories WHERE id=${literal(category)})
                AND EXISTS (SELECT 1 FROM tax_rates WHERE id=${literal(tax)} AND isDefault=1)
                THEN 1 ELSE 0 END;`,
        ];
            const stamp = '2026-10-12T00:00:00.000Z';
            const productColumns = ['id','categoryId','taxRateId','name','sku','barcode','scalePlu','price','costPrice','stockLevel',
                'trackStock','allowPriceOverride','isWeighable','showInGoods','goodsSortOrder','color','image',
                'isActive','createdAt','updatedAt','isAgeRestricted'];
            for (let index = 1; index <= 1105; index++) {
                const label = String(index).padStart(4, '0');
                statements.push(insert('products', productColumns, [productId(index), category, tax, `QA Native17 Weighable ${label}`,
                    `QA-NATIVE-${label}`, `29001012${label}`, '', 249, 175, 100,
                    1, 1, 1, 0, 0, '#0f766e', '', 1, stamp, stamp, 0]));
            }
            const supplierColumns = ['id','name','contactName','phone','email','address','notes','createdAt','updatedAt'];
            for (let index = 0; index < 125; index++) {
                const label = String(index).padStart(3, '0');
                statements.push(insert('suppliers', supplierColumns, [supplierId(index), `QA Native17 Supplier ${label}`, `QA Native17 Contact ${label}`,
                    `01234 56${label}`, `supplier-${label}@example.invalid`, 'Isolated QA only',
                    'Native pagination fixture; no external supplier contact', stamp, stamp]));
            }
            const receiptColumns = ['id','supplierId','employeeId','reference','notes','totalCost','status','createdAt','updatedAt'];
            const lineColumns = ['id','receiptId','productId','quantity','unitCost','createdAt','updatedAt'];
            for (let index = 0; index < 65; index++) {
                const label = String(index).padStart(3, '0');
                const id = `${prefix}-receipt-${label}`;
                const date = new Date(Date.UTC(2026, 9, 10, 12, index)).toISOString();
                statements.push(insert('stock_receipts', receiptColumns, [id, supplierId(index % 2), '', `QA Native17 INV-${label}`,
                    'QA Native17 historical receipt pagination fixture', 525, 'received', date, date]));
                statements.push(insert('stock_receipt_lines', lineColumns, [`${id}-line-a`, id, productId(1), 3, 175, date, date]));
                statements.push(insert('stock_receipt_lines', lineColumns, [`${id}-line-b`, id, `${prefix}-unavailable-product`, 2, 0, date, date]));
            }
            statements.push(`INSERT OR REPLACE INTO settings (key,value,updatedAt) VALUES (${literal('scale_tile_pages')},${literal(JSON.stringify([pageA,pageB]))},${literal(stamp)});`);
            statements.push(insert('settings', ['key','value','updatedAt'], [marker,JSON.stringify(summary),stamp]));
            statements.push('COMMIT;');
            execFileSync('sqlite3', [resolved], { input: statements.join('\n'), encoding:'utf8', stdio:['pipe','pipe','pipe'] });
            console.log(JSON.stringify({ ...summary, committed: true }, null, 2));
    }
} finally {
    database.close();
}
