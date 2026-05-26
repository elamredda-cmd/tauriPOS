import Database from '@tauri-apps/plugin-sql';

let db: Database | null = null;

export async function getDb(): Promise<Database> {
    if (!db) {
        db = await Database.load('sqlite:pos.db');
    }
    return db;
}

export async function initDb() {
    const d = await getDb();

    console.log("Initializing SQLite Database...");

    // 1. Products Table
    await d.execute(`
        CREATE TABLE IF NOT EXISTS products (
            id TEXT PRIMARY KEY,
            categoryId TEXT,
            taxRateId TEXT,
            name TEXT NOT NULL,
            sku TEXT,
            barcode TEXT,
            price INTEGER NOT NULL,
            costPrice INTEGER DEFAULT 0,
            stockLevel INTEGER DEFAULT 0,
            trackStock INTEGER DEFAULT 0,
            allowPriceOverride INTEGER DEFAULT 0,
            isWeighable INTEGER DEFAULT 0,
            showInGoods INTEGER DEFAULT 0,
            goodsSortOrder INTEGER DEFAULT 0,
            showInPos INTEGER DEFAULT 1,
            color TEXT,
            image TEXT,
            isActive INTEGER DEFAULT 1,
            createdAt TEXT,
            updatedAt TEXT
        )
    `);

    // 2. Categories Table
    await d.execute(`
        CREATE TABLE IF NOT EXISTS categories (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            color TEXT,
            sortOrder INTEGER DEFAULT 0,
            isActive INTEGER DEFAULT 1,
            showOnPos INTEGER DEFAULT 1,
            createdAt TEXT
        )
    `);

    // 3. POS Pages Table
    await d.execute(`
        CREATE TABLE IF NOT EXISTS pos_pages (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            position INTEGER DEFAULT 0,
            color TEXT
        )
    `);

    // 4. Tiles Table
    await d.execute(`
        CREATE TABLE IF NOT EXISTS pos_tiles (
            id TEXT PRIMARY KEY,
            pageId TEXT NOT NULL,
            productId TEXT NOT NULL,
            position INTEGER DEFAULT 0,
            FOREIGN KEY(pageId) REFERENCES pos_pages(id) ON DELETE CASCADE,
            FOREIGN KEY(productId) REFERENCES products(id) ON DELETE CASCADE
        )
    `);

    // 5. Tax Rates
    await d.execute(`
        CREATE TABLE IF NOT EXISTS tax_rates (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            rate REAL NOT NULL,
            isDefault INTEGER DEFAULT 0,
            createdAt TEXT
        )
    `);

    // 6. Customers
    await d.execute(`
        CREATE TABLE IF NOT EXISTS customers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            phone TEXT,
            email TEXT,
            loyaltyPoints INTEGER DEFAULT 0,
            notes TEXT,
            createdAt TEXT
        )
    `);

    // 7. Orders
    await d.execute(`
        CREATE TABLE IF NOT EXISTS orders (
            id TEXT PRIMARY KEY,
            shiftId TEXT,
            customerId TEXT,
            employeeId TEXT,
            orderNumber INTEGER,
            type TEXT,
            status TEXT,
            originalOrderId TEXT,
            subtotal INTEGER DEFAULT 0,
            discountId TEXT,
            discountAmount INTEGER DEFAULT 0,
            taxTotal INTEGER DEFAULT 0,
            total INTEGER DEFAULT 0,
            notes TEXT,
            createdAt TEXT,
            completedAt TEXT
        )
    `);

    // 8. Order Lines
    await d.execute(`
        CREATE TABLE IF NOT EXISTS order_lines (
            id TEXT PRIMARY KEY,
            orderId TEXT,
            productId TEXT,
            productName TEXT,
            quantity INTEGER DEFAULT 0,
            unitPrice INTEGER DEFAULT 0,
            costPrice INTEGER DEFAULT 0,
            discountId TEXT,
            discountAmount INTEGER DEFAULT 0,
            taxRate REAL DEFAULT 0,
            taxAmount INTEGER DEFAULT 0,
            lineTotal INTEGER DEFAULT 0,
            isPriceOverride INTEGER DEFAULT 0,
            originalPrice INTEGER DEFAULT 0,
            notes TEXT,
            FOREIGN KEY(orderId) REFERENCES orders(id) ON DELETE CASCADE
        )
    `);

    // 9. Settings
    await d.execute(`
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT,
            updatedAt TEXT
        )
    `);

    // 10. Employees
    await d.execute(`
        CREATE TABLE IF NOT EXISTS employees (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            pin TEXT,
            role TEXT,
            isActive INTEGER DEFAULT 1,
            createdAt TEXT
        )
    `);

    // 11. Registers
    await d.execute(`
        CREATE TABLE IF NOT EXISTS registers (
            id TEXT PRIMARY KEY,
            storeId TEXT,
            name TEXT NOT NULL,
            isActive INTEGER DEFAULT 1,
            createdAt TEXT
        )
    `);

    // 12. Suppliers
    await d.execute(`
        CREATE TABLE IF NOT EXISTS suppliers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            contactName TEXT,
            phone TEXT,
            email TEXT,
            address TEXT,
            notes TEXT,
            createdAt TEXT
        )
    `);

    // 13. Discounts
    await d.execute(`
        CREATE TABLE IF NOT EXISTS discounts (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            type TEXT,
            value REAL,
            isActive INTEGER DEFAULT 1,
            createdAt TEXT,
            kind TEXT DEFAULT 'manual_percent',
            autoApply INTEGER DEFAULT 0,
            groupId TEXT,
            minQuantity INTEGER DEFAULT 1,
            secondPrice INTEGER DEFAULT 0,
            bundleQuantity INTEGER DEFAULT 0,
            bundlePrice INTEGER DEFAULT 0,
            maxApplications INTEGER,
            startAt TEXT,
            endAt TEXT,
            priority INTEGER DEFAULT 0
        )
    `);

    // 21. Promo Groups (named pools of products that can trigger BOGO/bundle promos)
    await d.execute(`
        CREATE TABLE IF NOT EXISTS promo_groups (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            startAt TEXT,
            endAt TEXT,
            isActive INTEGER DEFAULT 1,
            createdAt TEXT
        )
    `);

    // 22. Promo Group Items (which products belong to which group)
    await d.execute(`
        CREATE TABLE IF NOT EXISTS promo_group_items (
            id TEXT PRIMARY KEY,
            groupId TEXT NOT NULL,
            productId TEXT NOT NULL,
            FOREIGN KEY(groupId) REFERENCES promo_groups(id) ON DELETE CASCADE,
            FOREIGN KEY(productId) REFERENCES products(id) ON DELETE CASCADE
        )
    `);

    // 14. Shifts
    await d.execute(`
        CREATE TABLE IF NOT EXISTS shifts (
            id TEXT PRIMARY KEY,
            registerId TEXT,
            employeeId TEXT,
            openedAt TEXT,
            closedAt TEXT,
            openingFloat INTEGER,
            expectedCash INTEGER,
            actualCash INTEGER,
            cashDifference INTEGER,
            status TEXT,
            notes TEXT
        )
    `);

    // 15. Cash Movements
    await d.execute(`
        CREATE TABLE IF NOT EXISTS cash_movements (
            id TEXT PRIMARY KEY,
            shiftId TEXT,
            employeeId TEXT,
            amount INTEGER,
            reason TEXT,
            createdAt TEXT
        )
    `);

    // 16. Loyalty Logs
    await d.execute(`
        CREATE TABLE IF NOT EXISTS loyalty_logs (
            id TEXT PRIMARY KEY,
            customerId TEXT,
            orderId TEXT,
            pointsChange INTEGER,
            reason TEXT,
            createdAt TEXT
        )
    `);

    // 17. Audit Logs
    await d.execute(`
        CREATE TABLE IF NOT EXISTS audit_logs (
            id TEXT PRIMARY KEY,
            employeeId TEXT,
            action TEXT,
            entityType TEXT,
            entityId TEXT,
            oldData TEXT,
            newData TEXT,
            createdAt TEXT
        )
    `);

    // 18. Payments
    await d.execute(`
        CREATE TABLE IF NOT EXISTS payments (
            id TEXT PRIMARY KEY,
            orderId TEXT,
            method TEXT,
            amount INTEGER DEFAULT 0,
            cashAmount INTEGER DEFAULT 0,
            cardAmount INTEGER DEFAULT 0,
            reference TEXT,
            changeGiven INTEGER DEFAULT 0,
            createdAt TEXT,
            FOREIGN KEY(orderId) REFERENCES orders(id) ON DELETE CASCADE
        )
    `);

    // 23. Daily Sales Summary (aggregated per day per till)
    await d.execute(`
        CREATE TABLE IF NOT EXISTS daily_sales_summary (
            date TEXT NOT NULL,
            tillNumber TEXT NOT NULL DEFAULT '',
            cashTotal INTEGER DEFAULT 0,
            cardTotal INTEGER DEFAULT 0,
            totalSales INTEGER DEFAULT 0,
            transactionCount INTEGER DEFAULT 0,
            updatedAt TEXT,
            PRIMARY KEY(date, tillNumber)
        )
    `);

    // 24. Till Report Markers (tracks when each till last pulled a report)
    await d.execute(`
        CREATE TABLE IF NOT EXISTS till_report_markers (
            id TEXT PRIMARY KEY,
            tillNumber TEXT NOT NULL,
            type TEXT NOT NULL,
            markerTime TEXT NOT NULL,
            periodStart TEXT NOT NULL,
            periodEnd TEXT NOT NULL,
            createdAt TEXT
        )
    `);

    // 19. Product Suppliers (bridge table)
    await d.execute(`
        CREATE TABLE IF NOT EXISTS product_suppliers (
            id TEXT PRIMARY KEY,
            productId TEXT,
            supplierId TEXT,
            supplierSku TEXT,
            costPrice INTEGER DEFAULT 0,
            isPreferred INTEGER DEFAULT 0
        )
    `);

    // 20. Inventory Logs
    await d.execute(`
        CREATE TABLE IF NOT EXISTS inventory_logs (
            id TEXT PRIMARY KEY,
            productId TEXT,
            quantityChange INTEGER DEFAULT 0,
            type TEXT,
            referenceId TEXT,
            employeeId TEXT,
            notes TEXT,
            createdAt TEXT
        )
    `);

    // Create performance indexes
    await d.execute(`CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode)`);
    await d.execute(`CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku)`);
    await d.execute(`CREATE INDEX IF NOT EXISTS idx_products_category ON products(categoryId)`);
    await d.execute(`CREATE INDEX IF NOT EXISTS idx_products_active ON products(isActive)`);
    await d.execute(`CREATE INDEX IF NOT EXISTS idx_tiles_page ON pos_tiles(pageId)`);
    await d.execute(`CREATE INDEX IF NOT EXISTS idx_order_lines_order ON order_lines(orderId)`);
    await d.execute(`CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(orderId)`);
    await d.execute(`CREATE INDEX IF NOT EXISTS idx_inv_logs_product ON inventory_logs(productId)`);
    await d.execute(`CREATE INDEX IF NOT EXISTS idx_promo_group_items_group ON promo_group_items(groupId)`);
    await d.execute(`CREATE INDEX IF NOT EXISTS idx_promo_group_items_product ON promo_group_items(productId)`);
    await d.execute(`CREATE INDEX IF NOT EXISTS idx_orders_completed ON orders(completedAt)`);
    await d.execute(`CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)`);
    await d.execute(`CREATE INDEX IF NOT EXISTS idx_payments_method ON payments(method)`);
    await d.execute(`CREATE INDEX IF NOT EXISTS idx_daily_summary_date ON daily_sales_summary(date)`);
    await d.execute(`CREATE INDEX IF NOT EXISTS idx_till_markers_till ON till_report_markers(tillNumber)`);

    // Apply incremental migrations to existing tables (safe to re-run).
    await runMigrations();
    await addColumnIfMissing('products', 'goodsSortOrder', 'INTEGER DEFAULT 0');
    await dropColumnIfExists('products', 'allowPriceOverride');
    await runDataMigrations();

    // Indexes on migration-added columns must run AFTER runMigrations().
    await d.execute(`CREATE INDEX IF NOT EXISTS idx_orders_till ON orders(tillNumber)`);

    console.log("Database initialized successfully!");
}

/**
 * Add a column to an existing table only if it isn't already there.
 * SQLite's ALTER TABLE has no IF NOT EXISTS, so we inspect PRAGMA table_info first.
 */
async function addColumnIfMissing(table: string, column: string, definition: string) {
    const d = await getDb();
    const rows: any[] = await d.select(`PRAGMA table_info(${table})`);
    if (rows.some(r => r.name === column)) return;
    await d.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    // Bust the column cache so subsequent upserts see the new column.
    delete tableColumnsCache[table];
    console.log(`Migration: added ${table}.${column}`);
}

async function dropColumnIfExists(table: string, column: string) {
    const d = await getDb();
    const rows: any[] = await d.select(`PRAGMA table_info(${table})`);
    if (!rows.some(r => r.name === column)) return;
    try {
        await d.execute(`ALTER TABLE ${table} DROP COLUMN ${column}`);
        delete tableColumnsCache[table];
        console.log(`Migration: dropped ${table}.${column}`);
    } catch (e: any) {
        console.warn(`Migration: could not drop ${table}.${column}:`, e.message);
    }
}

/**
 * Idempotent migrations applied after CREATE TABLE IF NOT EXISTS.
 * Each entry uses addColumnIfMissing so it's safe to run on every startup.
 */
async function runMigrations() {
    // Discounts gained promo-engine fields after the first release.
    await addColumnIfMissing('discounts', 'kind', "TEXT DEFAULT 'manual_percent'");
    await addColumnIfMissing('discounts', 'autoApply', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('discounts', 'groupId', 'TEXT');
    await addColumnIfMissing('discounts', 'minQuantity', 'INTEGER DEFAULT 1');
    await addColumnIfMissing('discounts', 'secondPrice', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('discounts', 'bundleQuantity', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('discounts', 'bundlePrice', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('discounts', 'maxApplications', 'INTEGER');
    await addColumnIfMissing('discounts', 'startAt', 'TEXT');
    await addColumnIfMissing('discounts', 'endAt', 'TEXT');
    await addColumnIfMissing('discounts', 'priority', 'INTEGER DEFAULT 0');

    // Payment split tracking columns (safe for existing rows — default 0).
    await addColumnIfMissing('payments', 'cashAmount', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('payments', 'cardAmount', 'INTEGER DEFAULT 0');

    // Multi-till support: track which till processed each order.
    await addColumnIfMissing('orders', 'tillNumber', "TEXT DEFAULT ''");

    // Track payment method on orders for fallback when payment records are missing.
    await addColumnIfMissing('orders', 'paymentMethod', "TEXT DEFAULT ''");
}

/** One-shot data migrations (tracked via settings table). */
async function runDataMigrations() {
    const d = await getDb();

    // 1. Limit showInGoods to max 10 items and assign sort order.
    const alreadyDone = await d.select(`SELECT 1 FROM settings WHERE key = 'migration_show_in_goods_limited'`);
    if (alreadyDone.length === 0) {
        await limitGoodsMenuItems();
        await d.execute(`INSERT INTO settings (key, value, updatedAt) VALUES (?, ?, ?)`,
            ['migration_show_in_goods_limited', 'done', new Date().toISOString()]);
        console.log('Migration: limited showInGoods to 10 items with sort order');
    }

    // 2. Initialise default POS button layouts if missing.
    const layoutKeys = ['pos_cart_layout', 'pos_toolbar_layout'];
    for (const key of layoutKeys) {
        const exists = await d.select(`SELECT 1 FROM settings WHERE key = ?`, [key]);
        if (exists.length === 0) {
            const defaults: Record<string, string> = {
                pos_cart_layout: JSON.stringify(['goods', 'recent_trans', 'change_price', 'drawer']),
                pos_toolbar_layout: JSON.stringify(['scale', 'drawer', 'discount'])
            };
            await d.execute(`INSERT INTO settings (key, value, updatedAt) VALUES (?, ?, ?)`,
                [key, defaults[key], new Date().toISOString()]);
            console.log(`Migration: seeded default ${key}`);
        }
    }
}

/**
 * Cache of column names per table, populated lazily via PRAGMA table_info.
 * Used by upsert() to filter out object properties that don't map to any column,
 * preventing "no such column" errors when interfaces have more fields than the schema.
 */
const tableColumnsCache: Record<string, string[]> = {};

async function getTableColumns(table: string): Promise<string[]> {
    if (tableColumnsCache[table]) return tableColumnsCache[table];
    const d = await getDb();
    const rows: any[] = await d.select(`PRAGMA table_info(${table})`);
    const cols = rows.map(r => r.name);
    tableColumnsCache[table] = cols;
    return cols;
}

/** Coerce JS values into SQLite-compatible primitives. */
function normalizeValue(v: any): any {
    if (v === undefined) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v;
}

/**
 * Generic Upsert Helper
 * Saves or updates an object in any table based on its 'id' (or 'key' for settings).
 * Filters incoming object keys to only those that exist as columns in the table,
 * and converts booleans to 0/1.
 */
export async function upsert(table: string, obj: any, idKey: string = 'id') {
    const d = await getDb();
    const validCols = await getTableColumns(table);
    const keys = Object.keys(obj).filter(k => validCols.includes(k));
    if (keys.length === 0) {
        throw new Error(`upsert: no valid columns for table ${table}`);
    }
    const values = keys.map(k => normalizeValue(obj[k]));

    const columns = keys.join(', ');
    const placeholders = keys.map(() => '?').join(', ');
    // Don't update the conflict key itself
    const updates = keys.filter(k => k !== idKey).map(k => `${k}=excluded.${k}`).join(', ');

    const sql = updates
        ? `INSERT INTO ${table} (${columns}) VALUES (${placeholders}) ON CONFLICT(${idKey}) DO UPDATE SET ${updates}`
        : `INSERT INTO ${table} (${columns}) VALUES (${placeholders}) ON CONFLICT(${idKey}) DO NOTHING`;

    await d.execute(sql, values);
}

export async function remove(table: string, id: string, idKey: string = 'id') {
    const d = await getDb();
    await d.execute(`DELETE FROM ${table} WHERE ${idKey} = ?`, [id]);
}

/** Reset all products to showInGoods=0, then enable only the first 10 alphabetically. */
export async function limitGoodsMenuItems() {
    const d = await getDb();
    await d.execute(`UPDATE products SET showInGoods = 0, goodsSortOrder = 0`);
    const top10: any[] = await d.select(
        `SELECT id FROM products WHERE isActive = 1 ORDER BY name ASC LIMIT 10`
    );
    for (let i = 0; i < top10.length; i++) {
        await d.execute(
            `UPDATE products SET showInGoods = 1, goodsSortOrder = ? WHERE id = ?`,
            [i + 1, top10[i].id]
        );
    }
    console.log(`Goods menu capped to ${top10.length} items`);
}

/**
 * Seed data into SQLite if the products table is empty.
 * Uses the schema-aware upsert(), so adding new fields to the seeds in db.ts
 * will work as long as the matching columns exist in the schema.
 */
export interface SeedPayload {
    products?: any[];
    categories?: any[];
    posPages?: any[];
    posTiles?: any[];
    taxRates?: any[];
    employees?: any[];
    settings?: any[];
    registers?: any[];
    discounts?: any[];
}

export async function migrateFromLocalStorage(seed: SeedPayload) {
    const d = await getDb();

    // Skip if products already exist
    const result: any[] = await d.select('SELECT id FROM products LIMIT 1');
    if (result.length > 0) {
        console.log("SQLite already contains data. Skipping seed.");
        return;
    }

    console.log("Seeding SQLite with initial data...");

    for (const p of (seed.products || [])) await upsert('products', p);
    for (const c of (seed.categories || [])) await upsert('categories', c);
    for (const pg of (seed.posPages || [])) await upsert('pos_pages', pg);
    for (const t of (seed.posTiles || [])) await upsert('pos_tiles', t);
    for (const tr of (seed.taxRates || [])) await upsert('tax_rates', tr);
    for (const emp of (seed.employees || [])) await upsert('employees', emp);
    for (const s of (seed.settings || [])) await upsert('settings', s, 'key');
    for (const r of (seed.registers || [])) await upsert('registers', r);
    for (const ds of (seed.discounts || [])) await upsert('discounts', ds);

    // After seeding, enforce the 10-item goods-menu cap on whatever got inserted.
    await limitGoodsMenuItems();

    console.log("Seed complete.");
}

/** 
 * Fast search in SQLite for barcode, sku, or name
 */
export async function searchProduct(query: string) {
    const d = await getDb();
    const q = query.trim();
    if (!q) return null;

    // 1. Exact match for Barcode (Highest priority, uses Index)
    let rows: any[] = await d.select('SELECT * FROM products WHERE barcode = ? LIMIT 1', [q]);
    if (rows.length > 0) return rows[0];

    // 2. Exact match for SKU (High priority, uses Index)
    rows = await d.select('SELECT * FROM products WHERE sku = ? LIMIT 1', [q]);
    if (rows.length > 0) return rows[0];

    // 3. Partial match for Name (Lowest priority)
    rows = await d.select('SELECT * FROM products WHERE name LIKE ? LIMIT 1', [`%${q}%`]);
    if (rows.length > 0) return rows[0];

    return null;
}

/** Insert or update a product in SQLite (schema-aware). */
export async function addProduct(p: any) {
    await upsert("products", p);
}

/**
 * Bulk insert products using a transaction for high performance.
 */
export async function bulkAddProducts(products: any[]) {
    const d = await getDb();
    const validCols = await getTableColumns("products");

    await d.execute("BEGIN TRANSACTION");
    try {
        for (const p of products) {
            const keys = Object.keys(p).filter((k) => validCols.includes(k));
            const values = keys.map((k) => normalizeValue(p[k]));
            const columns = keys.join(", ");
            const placeholders = keys.map(() => "?").join(", ");

            const sql = `INSERT INTO products (${columns}) VALUES (${placeholders}) ON CONFLICT(id) DO NOTHING`;
            await d.execute(sql, values);
        }
        await d.execute("COMMIT");
    } catch (e) {
        await d.execute("ROLLBACK");
        throw e;
    }
}

/** Update an existing product in SQLite (schema-aware). */
export async function updateProduct(p: any) {
    await upsert('products', p);
}

/** Batch-update only showInGoods + goodsSortOrder for many products in one transaction. */
export async function batchUpdateGoodsMenu(changes: { id: string; showInGoods: boolean; goodsSortOrder: number; updatedAt: string }[]) {
    if (changes.length === 0) return;
    const d = await getDb();
    await d.execute("BEGIN TRANSACTION");
    try {
        for (const c of changes) {
            await d.execute(
                `UPDATE products SET showInGoods = ?, goodsSortOrder = ?, updatedAt = ? WHERE id = ?`,
                [c.showInGoods ? 1 : 0, c.goodsSortOrder, c.updatedAt, c.id]
            );
        }
        await d.execute("COMMIT");
    } catch (e) {
        await d.execute("ROLLBACK");
        throw e;
    }
}

/** 
 * Soft delete (deactivate) a product in SQLite
 */
export async function deleteProduct(id: string) {
    const d = await getDb();
    await d.execute('UPDATE products SET isActive = 0 WHERE id = ?', [id]);
}

/** 
 * Save or Update a POS Page
 */
export async function savePosPage(p: any) {
    const d = await getDb();
    await d.execute(
        `INSERT INTO pos_pages (id, name, position, color) 
         VALUES (?, ?, ?, ?) 
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, position=excluded.position, color=excluded.color`,
        [p.id, p.name, p.position, p.color]
    );
}

/** 
 * Delete a POS Page and its tiles
 */
export async function deletePosPage(id: string) {
    const d = await getDb();
    await d.execute('DELETE FROM pos_pages WHERE id = ?', [id]);
    await d.execute('DELETE FROM pos_tiles WHERE pageId = ?', [id]);
}

/** 
 * Add a tile to a page
 */
export async function addTile(t: any) {
    const d = await getDb();
    await d.execute(
        'INSERT INTO pos_tiles (id, pageId, productId, position) VALUES (?, ?, ?, ?)',
        [t.id, t.pageId, t.productId, t.position]
    );
}

/** 
 * Remove a tile
 */
export async function deleteTile(id: string) {
    const d = await getDb();
    await d.execute('DELETE FROM pos_tiles WHERE id = ?', [id]);
}

/** 
 * Fetch all rows from a table
 */
export async function getAll(table: string): Promise<any[]> {
    const d = await getDb();
    return await d.select(`SELECT * FROM ${table}`);
}

/**
 * Fetch products only for currently assigned POS tiles.
 * Useful when the catalogue is huge and only tile-bound products are needed.
 */
export async function getTileProducts(): Promise<any[]> {
    const d = await getDb();
    return await d.select(`
        SELECT p.* FROM products p
        JOIN pos_tiles t ON p.id = t.productId
        WHERE p.isActive = 1
    `);
}

/** Fetch all active products (used for the goods management screens & search). */
export async function getActiveProducts(): Promise<any[]> {
    const d = await getDb();
    return await d.select(`SELECT * FROM products WHERE isActive = 1`);
}

/** Convert SQLite integer flags back into JS booleans for a given object. */
export function rehydrateBooleans<T extends Record<string, any>>(row: T, boolKeys: (keyof T)[]): T {
    const out: any = { ...row };
    for (const k of boolKeys) {
        if (out[k] !== undefined && out[k] !== null) out[k] = !!out[k];
    }
    return out;
}

// ─────────────────────────────────────────────
// REPORT & ANALYTICS QUERIES
// ─────────────────────────────────────────────

export interface SalesOverview {
    totalRevenue: number;
    totalTransactions: number;
    avgTransactionValue: number;
    totalItemsSold: number;
}

export interface PaymentBreakdown {
    totalCash: number;
    totalCard: number;
    cashTxCount: number;
    cardTxCount: number;
    splitTxCount: number;
    totalAmount: number;
    unrecordedAmount: number;
    unrecordedTxCount: number;
}

export interface TopProduct {
    name: string;
    sku: string;
    qtySold: number;
    totalRevenue: number;
    avgPrice: number;
}

/** Fetch sales overview for a date range, optionally filtered by till. */
export async function getSalesOverview(startDate: string, endDate: string, tillNumber?: string): Promise<SalesOverview> {
    const d = await getDb();
    const tillFilter = tillNumber ? ` AND o.tillNumber = ?` : '';
    const params: any[] = [startDate, endDate];
    if (tillNumber) params.push(tillNumber);

    const revRows: any[] = await d.select(
        `SELECT COALESCE(SUM(o.total), 0) as totalRevenue, COUNT(*) as totalTransactions
         FROM orders o
         WHERE o.status = 'completed' AND date(o.completedAt) >= ? AND date(o.completedAt) <= ?${tillFilter}`,
        params
    );

    const itemParams: any[] = [startDate, endDate];
    if (tillNumber) itemParams.push(tillNumber);
    const itemRows: any[] = await d.select(
        `SELECT COALESCE(SUM(ol.quantity), 0) as totalItems
         FROM order_lines ol
         JOIN orders o ON ol.orderId = o.id
         WHERE o.status = 'completed' AND date(o.completedAt) >= ? AND date(o.completedAt) <= ?${tillFilter}`,
        itemParams
    );

    const rev = revRows[0] || { totalRevenue: 0, totalTransactions: 0 };
    const items = itemRows[0] || { totalItems: 0 };
    return {
        totalRevenue: rev.totalRevenue || 0,
        totalTransactions: rev.totalTransactions || 0,
        avgTransactionValue: rev.totalTransactions > 0 ? Math.round(rev.totalRevenue / rev.totalTransactions) : 0,
        totalItemsSold: items.totalItems || 0,
    };
}

/** Fetch payment method breakdown for a date range, optionally filtered by till. */
export async function getPaymentBreakdown(startDate: string, endDate: string, tillNumber?: string): Promise<PaymentBreakdown> {
    const d = await getDb();
    const tillFilter = tillNumber ? ` AND o.tillNumber = ?` : '';
    const params: any[] = [startDate, endDate];
    if (tillNumber) params.push(tillNumber);

    const rows: any[] = await d.select(
        `SELECT
            COALESCE(SUM(CASE WHEN p.method = 'cash' THEN p.amount ELSE 0 END), 0) +
            COALESCE(SUM(CASE WHEN p.method = 'split' THEN p.cashAmount ELSE 0 END), 0) as totalCash,
            COALESCE(SUM(CASE WHEN p.method = 'card' THEN p.amount ELSE 0 END), 0) +
            COALESCE(SUM(CASE WHEN p.method = 'split' THEN p.cardAmount ELSE 0 END), 0) as totalCard,
            COALESCE(SUM(CASE WHEN p.id IS NULL THEN o.total ELSE 0 END), 0) as unrecordedAmount,
            COALESCE(SUM(o.total), 0) as totalAmount,
            COALESCE(SUM(CASE WHEN p.method = 'cash' THEN 1 ELSE 0 END), 0) as cashTxCount,
            COALESCE(SUM(CASE WHEN p.method = 'card' THEN 1 ELSE 0 END), 0) as cardTxCount,
            COALESCE(SUM(CASE WHEN p.method = 'split' THEN 1 ELSE 0 END), 0) as splitTxCount,
            COALESCE(SUM(CASE WHEN p.id IS NULL THEN 1 ELSE 0 END), 0) as unrecordedTxCount
         FROM orders o
         LEFT JOIN payments p ON o.id = p.orderId
         WHERE o.status = 'completed' AND date(o.completedAt) >= ? AND date(o.completedAt) <= ?${tillFilter}`,
        params
    );

    const r = rows[0] || {};
    return {
        totalCash: r.totalCash || 0,
        totalCard: r.totalCard || 0,
        cashTxCount: r.cashTxCount || 0,
        cardTxCount: r.cardTxCount || 0,
        splitTxCount: r.splitTxCount || 0,
        totalAmount: r.totalAmount || 0,
        unrecordedAmount: r.unrecordedAmount || 0,
        unrecordedTxCount: r.unrecordedTxCount || 0,
    };
}

/** Fetch top N products for a date range, optionally filtered by till. */
export async function getTopProducts(
    startDate: string,
    endDate: string,
    sortBy: 'quantity' | 'revenue' = 'quantity',
    limit: number = 10,
    tillNumber?: string
): Promise<TopProduct[]> {
    const d = await getDb();
    const tillFilter = tillNumber ? ` AND o.tillNumber = ?` : '';
    const orderClause = sortBy === 'revenue' ? 'totalRevenue DESC' : 'qtySold DESC';
    const params: any[] = [startDate, endDate];
    if (tillNumber) params.push(tillNumber);
    params.push(limit);

    const rows: any[] = await d.select(
        `SELECT
            ol.productName as name,
            COALESCE(p.sku, '') as sku,
            SUM(ol.quantity) as qtySold,
            SUM(ol.lineTotal) as totalRevenue,
            ROUND(AVG(ol.unitPrice)) as avgPrice
         FROM order_lines ol
         JOIN orders o ON ol.orderId = o.id
         LEFT JOIN products p ON ol.productId = p.id
         WHERE o.status = 'completed' AND date(o.completedAt) >= ? AND date(o.completedAt) <= ?${tillFilter}
         GROUP BY ol.productId
         ORDER BY ${orderClause}
         LIMIT ?`,
        params
    );

    return rows.map(r => ({
        name: r.name || 'Unknown',
        sku: r.sku || '',
        qtySold: r.qtySold || 0,
        totalRevenue: r.totalRevenue || 0,
        avgPrice: r.avgPrice || 0,
    }));
}

/** Aggregate daily summary for a specific date (or all dates if not specified). */
export async function aggregateDailySummary(date?: string): Promise<void> {
    const d = await getDb();
    const nowStr = new Date().toISOString();
    const dateFilter = date ? ` AND date(o.completedAt) = ?` : '';
    const params: any[] = date ? [date] : [];

    // Aggregate per-till and also an overall row (tillNumber = '')
    const rows: any[] = await d.select(
        `SELECT
            date(o.completedAt) as day,
            COALESCE(o.tillNumber, '') as till,
            COALESCE(SUM(CASE WHEN p.method = 'cash' THEN p.amount ELSE 0 END), 0) +
            COALESCE(SUM(CASE WHEN p.method = 'split' THEN p.cashAmount ELSE 0 END), 0) as cashTotal,
            COALESCE(SUM(CASE WHEN p.method = 'card' THEN p.amount ELSE 0 END), 0) +
            COALESCE(SUM(CASE WHEN p.method = 'split' THEN p.cardAmount ELSE 0 END), 0) as cardTotal,
            COALESCE(SUM(o.total), 0) as totalSales,
            COUNT(DISTINCT o.id) as txCount
         FROM orders o
         LEFT JOIN payments p ON o.id = p.orderId
         WHERE o.status = 'completed'${dateFilter}
         GROUP BY day, till`,
        params
    );

    for (const r of rows) {
        await d.execute(
            `INSERT INTO daily_sales_summary (date, tillNumber, cashTotal, cardTotal, totalSales, transactionCount, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(date, tillNumber) DO UPDATE SET
                cashTotal = excluded.cashTotal,
                cardTotal = excluded.cardTotal,
                totalSales = excluded.totalSales,
                transactionCount = excluded.transactionCount,
                updatedAt = excluded.updatedAt`,
            [r.day, r.till, r.cashTotal, r.cardTotal, r.totalSales, r.txCount, nowStr]
        );
    }
}

/** Get the last report marker time for a specific till. */
export async function getLastReportMarker(tillNumber: string): Promise<string | null> {
    const d = await getDb();
    const rows: any[] = await d.select(
        `SELECT markerTime FROM till_report_markers
         WHERE tillNumber = ? AND type = 'period'
         ORDER BY markerTime DESC LIMIT 1`,
        [tillNumber]
    );
    return rows.length > 0 ? rows[0].markerTime : null;
}

/** Save a report marker for a till. */
export async function saveReportMarker(tillNumber: string, periodStart: string, periodEnd: string): Promise<void> {
    const d = await getDb();
    const id = crypto.randomUUID();
    const nowStr = new Date().toISOString();
    await d.execute(
        `INSERT INTO till_report_markers (id, tillNumber, type, markerTime, periodStart, periodEnd, createdAt)
         VALUES (?, ?, 'period', ?, ?, ?, ?)`,
        [id, tillNumber, nowStr, periodStart, periodEnd, nowStr]
    );
}

/** Get a unique till identifier for this machine, auto-generating if needed. */
export async function getOrCreateTillId(): Promise<string> {
    const d = await getDb();
    const rows: any[] = await d.select(`SELECT value FROM settings WHERE key = 'till_id'`);
    if (rows.length > 0 && rows[0].value) return rows[0].value;

    // Generate a unique ID from crypto
    const tillId = crypto.randomUUID();
    await d.execute(
        `INSERT INTO settings (key, value, updatedAt) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
        ['till_id', tillId, new Date().toISOString()]
    );
    return tillId;
}

/** Get the till display name, defaulting to 'Till 1'. */
export async function getTillName(): Promise<string> {
    const d = await getDb();
    const rows: any[] = await d.select(`SELECT value FROM settings WHERE key = 'till_name'`);
    if (rows.length > 0 && rows[0].value) return rows[0].value;
    return 'Till 1';
}

/** Set the till display name. */
export async function setTillName(name: string): Promise<void> {
    const d = await getDb();
    await d.execute(
        `INSERT INTO settings (key, value, updatedAt) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
        ['till_name', name, new Date().toISOString()]
    );
}

/** Get all registered till names from orders for the till selector dropdown. */
export async function getAllTillNumbers(): Promise<string[]> {
    const d = await getDb();
    const rows: any[] = await d.select(
        `SELECT DISTINCT tillNumber FROM orders WHERE tillNumber IS NOT NULL AND tillNumber != '' ORDER BY tillNumber`
    );
    return rows.map(r => r.tillNumber);
}

/** Get per-till report data between two timestamps. */
export async function getTillPeriodReport(
    tillNumber: string,
    startTime: string,
    endTime: string
): Promise<{ overview: SalesOverview; breakdown: PaymentBreakdown; topProducts: TopProduct[] }> {
    const d = await getDb();

    // Overview
    const revRows: any[] = await d.select(
        `SELECT COALESCE(SUM(o.total), 0) as totalRevenue, COUNT(*) as totalTransactions
         FROM orders o
         WHERE o.status = 'completed' AND o.tillNumber = ? AND o.completedAt >= ? AND o.completedAt <= ?`,
        [tillNumber, startTime, endTime]
    );
    const itemRows: any[] = await d.select(
        `SELECT COALESCE(SUM(ol.quantity), 0) as totalItems
         FROM order_lines ol JOIN orders o ON ol.orderId = o.id
         WHERE o.status = 'completed' AND o.tillNumber = ? AND o.completedAt >= ? AND o.completedAt <= ?`,
        [tillNumber, startTime, endTime]
    );
    const rev = revRows[0] || {};
    const items = itemRows[0] || {};
    const overview: SalesOverview = {
        totalRevenue: rev.totalRevenue || 0,
        totalTransactions: rev.totalTransactions || 0,
        avgTransactionValue: (rev.totalTransactions || 0) > 0 ? Math.round((rev.totalRevenue || 0) / rev.totalTransactions) : 0,
        totalItemsSold: items.totalItems || 0,
    };

    // Payment breakdown
    const bRows: any[] = await d.select(
        `SELECT
            COALESCE(SUM(CASE WHEN p.method = 'cash' THEN p.amount ELSE 0 END), 0) +
            COALESCE(SUM(CASE WHEN p.method = 'split' THEN p.cashAmount ELSE 0 END), 0) as totalCash,
            COALESCE(SUM(CASE WHEN p.method = 'card' THEN p.amount ELSE 0 END), 0) +
            COALESCE(SUM(CASE WHEN p.method = 'split' THEN p.cardAmount ELSE 0 END), 0) as totalCard,
            COALESCE(SUM(CASE WHEN p.id IS NULL THEN o.total ELSE 0 END), 0) as unrecordedAmount,
            COALESCE(SUM(o.total), 0) as totalAmount,
            COALESCE(SUM(CASE WHEN p.method = 'cash' THEN 1 ELSE 0 END), 0) as cashTxCount,
            COALESCE(SUM(CASE WHEN p.method = 'card' THEN 1 ELSE 0 END), 0) as cardTxCount,
            COALESCE(SUM(CASE WHEN p.method = 'split' THEN 1 ELSE 0 END), 0) as splitTxCount,
            COALESCE(SUM(CASE WHEN p.id IS NULL THEN 1 ELSE 0 END), 0) as unrecordedTxCount
         FROM orders o
         LEFT JOIN payments p ON o.id = p.orderId
         WHERE o.status = 'completed' AND o.tillNumber = ? AND o.completedAt >= ? AND o.completedAt <= ?`,
        [tillNumber, startTime, endTime]
    );
    const b = bRows[0] || {};
    const breakdown: PaymentBreakdown = {
        totalCash: b.totalCash || 0,
        totalCard: b.totalCard || 0,
        cashTxCount: b.cashTxCount || 0,
        cardTxCount: b.cardTxCount || 0,
        splitTxCount: b.splitTxCount || 0,
        totalAmount: b.totalAmount || 0,
        unrecordedAmount: b.unrecordedAmount || 0,
        unrecordedTxCount: b.unrecordedTxCount || 0,
    };

    // Top products
    const tpRows: any[] = await d.select(
        `SELECT
            ol.productName as name,
            COALESCE(pr.sku, '') as sku,
            SUM(ol.quantity) as qtySold,
            SUM(ol.lineTotal) as totalRevenue,
            ROUND(AVG(ol.unitPrice)) as avgPrice
         FROM order_lines ol
         JOIN orders o ON ol.orderId = o.id
         LEFT JOIN products pr ON ol.productId = pr.id
         WHERE o.status = 'completed' AND o.tillNumber = ? AND o.completedAt >= ? AND o.completedAt <= ?
         GROUP BY ol.productId
         ORDER BY qtySold DESC
         LIMIT 10`,
        [tillNumber, startTime, endTime]
    );
    const topProducts: TopProduct[] = tpRows.map(r => ({
        name: r.name || 'Unknown',
        sku: r.sku || '',
        qtySold: r.qtySold || 0,
        totalRevenue: r.totalRevenue || 0,
        avgPrice: r.avgPrice || 0,
    }));

    return { overview, breakdown, topProducts };
}
