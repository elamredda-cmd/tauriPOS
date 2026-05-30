/**
 * mysql.ts — MariaDB/MySQL-specific database operations
 *
 * Mirrors every public helper in sqlite.ts but targets a remote MariaDB server
 * via the `@tauri-apps/plugin-sql` MySQL driver.
 *
 * Key differences from SQLite:
 *   • `ON DUPLICATE KEY UPDATE col = VALUES(col)` instead of `ON CONFLICT … DO UPDATE SET`
 *   • `INFORMATION_SCHEMA.COLUMNS` instead of `PRAGMA table_info()`
 *   • `VARCHAR(36)` for PRIMARY KEY TEXT columns (MariaDB requires a length)
 *   • `INT` ↔ `INTEGER`, `DOUBLE` ↔ `REAL`
 */

import Database from '@tauri-apps/plugin-sql';
import { connectionState, type MysqlConfig } from './connection';
import { get } from 'svelte/store';

// ─── Connection ──────────────────────────────────────────────────────────────

let db: Database | null = null;
let currentDatabase: string = '';

function buildMysqlUri(config: MysqlConfig): string {
    const { user, password, host, port, database } = config;
    return `mysql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}

export async function getDb(config?: MysqlConfig): Promise<Database> {
    const cfg = config || get(connectionState).mysqlConfig;
    
    if (db && cfg && cfg.database === currentDatabase) return db;
    
    if (!cfg) {
        if (!db) throw new Error('MySQL no config provided and no cached connection');
        return db;
    }

    db = await Database.load(buildMysqlUri(cfg));
    currentDatabase = cfg.database;
    return db;
}

// ─── Schema Initialisation ──────────────────────────────────────────────────

/**
 * Create every table that the POS app needs, mirroring the SQLite schema
 * exactly (same column names, compatible types).
 *
 * MariaDB fully supports `CREATE TABLE IF NOT EXISTS`, so this is safe
 * to call on every startup.
 */
export async function initMysqlDb(config: MysqlConfig): Promise<void> {
    const d = await getDb(config);
    currentDatabase = config.database;

    console.log('Initializing MySQL/MariaDB Database…');

    // 1. Products
    await d.execute(`
        CREATE TABLE IF NOT EXISTS products (
            id VARCHAR(36) PRIMARY KEY,
            categoryId VARCHAR(36),
            taxRateId VARCHAR(36),
            name TEXT NOT NULL,
            sku TEXT,
            barcode TEXT,
            price INT NOT NULL,
            costPrice INT DEFAULT 0,
            stockLevel INT DEFAULT 0,
            trackStock INT DEFAULT 0,
            isWeighable INT DEFAULT 0,
            showInGoods INT DEFAULT 0,
            goodsSortOrder INT DEFAULT 0,
            showInPos INT DEFAULT 1,
            color TEXT,
            image TEXT,
            isActive INT DEFAULT 1,
            createdAt TEXT,
            updatedAt TEXT
        )
    `);

    // 2. Categories
    await d.execute(`
        CREATE TABLE IF NOT EXISTS categories (
            id VARCHAR(36) PRIMARY KEY,
            name TEXT NOT NULL,
            color TEXT,
            sortOrder INT DEFAULT 0,
            isActive INT DEFAULT 1,
            showOnPos INT DEFAULT 1,
            createdAt TEXT
        )
    `);

    // 3. POS Pages
    await d.execute(`
        CREATE TABLE IF NOT EXISTS pos_pages (
            id VARCHAR(36) PRIMARY KEY,
            name TEXT NOT NULL,
            position INT DEFAULT 0,
            color TEXT
        )
    `);

    // 4. Tiles
    await d.execute(`
        CREATE TABLE IF NOT EXISTS pos_tiles (
            id VARCHAR(36) PRIMARY KEY,
            pageId VARCHAR(36) NOT NULL,
            productId VARCHAR(36) NOT NULL,
            position INT DEFAULT 0,
            FOREIGN KEY(pageId) REFERENCES pos_pages(id) ON DELETE CASCADE,
            FOREIGN KEY(productId) REFERENCES products(id) ON DELETE CASCADE
        )
    `);

    // 5. Tax Rates
    await d.execute(`
        CREATE TABLE IF NOT EXISTS tax_rates (
            id VARCHAR(36) PRIMARY KEY,
            name TEXT NOT NULL,
            rate DOUBLE NOT NULL,
            isDefault INT DEFAULT 0,
            createdAt TEXT
        )
    `);

    // 6. Customers
    await d.execute(`
        CREATE TABLE IF NOT EXISTS customers (
            id VARCHAR(36) PRIMARY KEY,
            name TEXT NOT NULL,
            phone TEXT,
            email TEXT,
            loyaltyPoints INT DEFAULT 0,
            notes TEXT,
            createdAt TEXT
        )
    `);

    // 7. Orders
    await d.execute(`
        CREATE TABLE IF NOT EXISTS orders (
            id VARCHAR(36) PRIMARY KEY,
            shiftId VARCHAR(36),
            customerId VARCHAR(36),
            employeeId VARCHAR(36),
            orderNumber INT,
            type TEXT,
            status TEXT,
            originalOrderId VARCHAR(36),
            subtotal INT DEFAULT 0,
            discountId VARCHAR(36),
            discountAmount INT DEFAULT 0,
            taxTotal INT DEFAULT 0,
            total INT DEFAULT 0,
            notes TEXT,
            tillNumber TEXT DEFAULT '',
            paymentMethod TEXT DEFAULT '',
            amountTendered INT DEFAULT 0,
            updatedAt TEXT,
            createdAt TEXT,
            completedAt TEXT
        )
    `);

    // 8. Order Lines
    await d.execute(`
        CREATE TABLE IF NOT EXISTS order_lines (
            id VARCHAR(36) PRIMARY KEY,
            orderId VARCHAR(36),
            productId VARCHAR(36),
            productName TEXT,
            quantity INT DEFAULT 0,
            unitPrice INT DEFAULT 0,
            costPrice INT DEFAULT 0,
            discountId VARCHAR(36),
            discountAmount INT DEFAULT 0,
            taxRate DOUBLE DEFAULT 0,
            taxAmount INT DEFAULT 0,
            lineTotal INT DEFAULT 0,
            isPriceOverride INT DEFAULT 0,
            originalPrice INT DEFAULT 0,
            notes TEXT,
            updatedAt TEXT,
            FOREIGN KEY(orderId) REFERENCES orders(id) ON DELETE CASCADE
        )
    `);

    // 9. Settings
    await d.execute(`
        CREATE TABLE IF NOT EXISTS settings (
            \`key\` VARCHAR(36) PRIMARY KEY,
            value TEXT,
            updatedAt TEXT
        )
    `);

    // 10. Employees
    await d.execute(`
        CREATE TABLE IF NOT EXISTS employees (
            id VARCHAR(36) PRIMARY KEY,
            name TEXT NOT NULL,
            pin TEXT,
            role TEXT,
            isActive INT DEFAULT 1,
            createdAt TEXT
        )
    `);

    // 11. Registers
    await d.execute(`
        CREATE TABLE IF NOT EXISTS registers (
            id VARCHAR(36) PRIMARY KEY,
            storeId VARCHAR(36),
            name TEXT NOT NULL,
            isActive INT DEFAULT 1,
            createdAt TEXT
        )
    `);

    // 12. Suppliers
    await d.execute(`
        CREATE TABLE IF NOT EXISTS suppliers (
            id VARCHAR(36) PRIMARY KEY,
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
            id VARCHAR(36) PRIMARY KEY,
            name TEXT NOT NULL,
            type TEXT,
            value DOUBLE,
            isActive INT DEFAULT 1,
            createdAt TEXT,
            kind TEXT DEFAULT 'manual_percent',
            autoApply INT DEFAULT 0,
            groupId VARCHAR(36),
            minQuantity INT DEFAULT 1,
            secondPrice INT DEFAULT 0,
            bundleQuantity INT DEFAULT 0,
            bundlePrice INT DEFAULT 0,
            maxApplications INT,
            startAt TEXT,
            endAt TEXT,
            priority INT DEFAULT 0
        )
    `);

    // 14. Promo Groups
    await d.execute(`
        CREATE TABLE IF NOT EXISTS promo_groups (
            id VARCHAR(36) PRIMARY KEY,
            name TEXT NOT NULL,
            startAt TEXT,
            endAt TEXT,
            isActive INT DEFAULT 1,
            createdAt TEXT
        )
    `);

    // 15. Promo Group Items
    await d.execute(`
        CREATE TABLE IF NOT EXISTS promo_group_items (
            id VARCHAR(36) PRIMARY KEY,
            groupId VARCHAR(36) NOT NULL,
            productId VARCHAR(36) NOT NULL,
            FOREIGN KEY(groupId) REFERENCES promo_groups(id) ON DELETE CASCADE,
            FOREIGN KEY(productId) REFERENCES products(id) ON DELETE CASCADE
        )
    `);

    // 16. Shifts
    await d.execute(`
        CREATE TABLE IF NOT EXISTS shifts (
            id VARCHAR(36) PRIMARY KEY,
            registerId VARCHAR(36),
            employeeId VARCHAR(36),
            openedAt TEXT,
            closedAt TEXT,
            openingFloat INT,
            expectedCash INT,
            actualCash INT,
            cashDifference INT,
            status TEXT,
            notes TEXT
        )
    `);

    // 17. Cash Movements
    await d.execute(`
        CREATE TABLE IF NOT EXISTS cash_movements (
            id VARCHAR(36) PRIMARY KEY,
            shiftId VARCHAR(36),
            employeeId VARCHAR(36),
            amount INT,
            reason TEXT,
            createdAt TEXT
        )
    `);

    // 18. Loyalty Logs
    await d.execute(`
        CREATE TABLE IF NOT EXISTS loyalty_logs (
            id VARCHAR(36) PRIMARY KEY,
            customerId VARCHAR(36),
            orderId VARCHAR(36),
            pointsChange INT,
            reason TEXT,
            createdAt TEXT
        )
    `);

    // 19. Audit Logs
    await d.execute(`
        CREATE TABLE IF NOT EXISTS audit_logs (
            id VARCHAR(36) PRIMARY KEY,
            employeeId VARCHAR(36),
            action TEXT,
            entityType TEXT,
            entityId VARCHAR(36),
            oldData TEXT,
            newData TEXT,
            createdAt TEXT
        )
    `);

    // 20. Payments
    await d.execute(`
        CREATE TABLE IF NOT EXISTS payments (
            id VARCHAR(36) PRIMARY KEY,
            orderId VARCHAR(36),
            method TEXT,
            amount INT DEFAULT 0,
            cashAmount INT DEFAULT 0,
            cardAmount INT DEFAULT 0,
            reference TEXT,
            changeGiven INT DEFAULT 0,
            createdAt TEXT,
            updatedAt TEXT,
            FOREIGN KEY(orderId) REFERENCES orders(id) ON DELETE CASCADE
        )
    `);

    // 21. Daily Sales Summary (composite PK)
    await d.execute(`
        CREATE TABLE IF NOT EXISTS daily_sales_summary (
            date VARCHAR(36) NOT NULL,
            tillNumber VARCHAR(36) NOT NULL DEFAULT '',
            cashTotal INT DEFAULT 0,
            cardTotal INT DEFAULT 0,
            totalSales INT DEFAULT 0,
            transactionCount INT DEFAULT 0,
            updatedAt TEXT,
            PRIMARY KEY(date, tillNumber)
        )
    `);

    // 22. Till Report Markers
    await d.execute(`
        CREATE TABLE IF NOT EXISTS till_report_markers (
            id VARCHAR(36) PRIMARY KEY,
            tillNumber VARCHAR(36) NOT NULL,
            type TEXT NOT NULL,
            markerTime TEXT NOT NULL,
            periodStart TEXT NOT NULL,
            periodEnd TEXT NOT NULL,
            createdAt TEXT
        )
    `);

    // 23. Product Suppliers
    await d.execute(`
        CREATE TABLE IF NOT EXISTS product_suppliers (
            id VARCHAR(36) PRIMARY KEY,
            productId VARCHAR(36),
            supplierId VARCHAR(36),
            supplierSku TEXT,
            costPrice INT DEFAULT 0,
            isPreferred INT DEFAULT 0
        )
    `);

    // 24. Inventory Logs
    await d.execute(`
        CREATE TABLE IF NOT EXISTS inventory_logs (
            id VARCHAR(36) PRIMARY KEY,
            productId VARCHAR(36),
            quantityChange INT DEFAULT 0,
            type TEXT,
            referenceId VARCHAR(36),
            employeeId VARCHAR(36),
            notes TEXT,
            createdAt TEXT
        )
    `);

    // ─── Migrations for existing databases ─────────────────────────────────
    const migrations = [
        `ALTER TABLE orders ADD COLUMN IF NOT EXISTS amountTendered INT DEFAULT 0`,
        `ALTER TABLE orders ADD COLUMN IF NOT EXISTS updatedAt TEXT`,
        `ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS updatedAt TEXT`,
        `ALTER TABLE payments ADD COLUMN IF NOT EXISTS updatedAt TEXT`,
    ];
    for (const sql of migrations) {
        try { await d.execute(sql); } catch { /* column may already exist */ }
    }
    // Bust column cache after migrations
    delete tableColumnsCache['orders'];
    delete tableColumnsCache['order_lines'];
    delete tableColumnsCache['payments'];

    // ─── Indexes ─────────────────────────────────────────────────────────────
    // MariaDB supports CREATE INDEX IF NOT EXISTS from 10.5+.  We wrap each
    // in a try/catch so older versions silently skip duplicates.
    const indexes = [
        `CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode(255))`,
        `CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku(255))`,
        `CREATE INDEX IF NOT EXISTS idx_products_category ON products(categoryId)`,
        `CREATE INDEX IF NOT EXISTS idx_products_active ON products(isActive)`,
        `CREATE INDEX IF NOT EXISTS idx_tiles_page ON pos_tiles(pageId)`,
        `CREATE INDEX IF NOT EXISTS idx_order_lines_order ON order_lines(orderId)`,
        `CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(orderId)`,
        `CREATE INDEX IF NOT EXISTS idx_inv_logs_product ON inventory_logs(productId)`,
        `CREATE INDEX IF NOT EXISTS idx_promo_group_items_group ON promo_group_items(groupId)`,
        `CREATE INDEX IF NOT EXISTS idx_promo_group_items_product ON promo_group_items(productId)`,
        `CREATE INDEX IF NOT EXISTS idx_orders_completed ON orders(completedAt(255))`,
        `CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status(255))`,
        `CREATE INDEX IF NOT EXISTS idx_payments_method ON payments(method(255))`,
        `CREATE INDEX IF NOT EXISTS idx_daily_summary_date ON daily_sales_summary(date)`,
        `CREATE INDEX IF NOT EXISTS idx_till_markers_till ON till_report_markers(tillNumber)`,
        `CREATE INDEX IF NOT EXISTS idx_orders_till ON orders(tillNumber(255))`,
    ];

    for (const sql of indexes) {
        try { await d.execute(sql); } catch { /* index may already exist */ }
    }

    console.log('MySQL/MariaDB database initialized successfully!');
}

// ─── Column Introspection ────────────────────────────────────────────────────

const tableColumnsCache: Record<string, string[]> = {};

/**
 * Fetch column names via INFORMATION_SCHEMA instead of PRAGMA table_info.
 */
async function getTableColumns(table: string): Promise<string[]> {
    if (tableColumnsCache[table]) return tableColumnsCache[table];
    const d = await getDb();
    const rows: any[] = await d.select(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
        [currentDatabase, table]
    );
    const cols = rows.map(r => r.COLUMN_NAME);
    tableColumnsCache[table] = cols;
    return cols;
}

// ─── Value helpers ───────────────────────────────────────────────────────────

/** Coerce JS values into MySQL-compatible primitives. */
function normalizeValue(v: any): any {
    if (v === undefined) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v;
}

// ─── Generic CRUD ────────────────────────────────────────────────────────────

/**
 * Generic upsert using MariaDB's `INSERT … ON DUPLICATE KEY UPDATE` syntax.
 */
export async function mysqlUpsert(table: string, obj: any, idKey: string = 'id'): Promise<void> {
    const d = await getDb();
    const validCols = await getTableColumns(table);

    // Settings table uses `key` as the column name which is a reserved word
    const keys = Object.keys(obj).filter(k => validCols.includes(k));
    if (keys.length === 0) {
        throw new Error(`mysqlUpsert: no valid columns for table ${table}`);
    }
    const values = keys.map(k => normalizeValue(obj[k]));

    // Quote column names to handle reserved words like `key`
    const columns = keys.map(k => `\`${k}\``).join(', ');
    const placeholders = keys.map(() => '?').join(', ');
    const updates = keys
        .filter(k => k !== idKey)
        .map(k => `\`${k}\` = VALUES(\`${k}\`)`)
        .join(', ');

    const sql = updates
        ? `INSERT INTO ${table} (${columns}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updates}`
        : `INSERT IGNORE INTO ${table} (${columns}) VALUES (${placeholders})`;

    await d.execute(sql, values);
}

/**
 * Delete a row by its primary key.
 */
export async function mysqlRemove(table: string, id: string, idKey: string = 'id'): Promise<void> {
    const d = await getDb();
    await d.execute(`DELETE FROM ${table} WHERE \`${idKey}\` = ?`, [id]);
}

/**
 * Fetch all rows from a table.
 */
export async function mysqlGetAll(table: string): Promise<any[]> {
    const d = await getDb();
    return await d.select(`SELECT * FROM ${table}`);
}

/**
 * Fetch rows updated since a specific date (Delta Sync).
 */
export async function mysqlGetUpdatedSince(table: string, sinceDate: string): Promise<any[]> {
    const d = await getDb();
    const validCols = await getTableColumns(table);
    if (validCols.includes('updatedAt')) {
        return await d.select(`SELECT * FROM ${table} WHERE updatedAt > ?`, [sinceDate]);
    } else {
        return await d.select(`SELECT * FROM ${table}`);
    }
}

/**
 * Search products by barcode, SKU, or name (same priority as SQLite).
 */
export async function mysqlSearchProduct(query: string): Promise<any | null> {
    const d = await getDb();
    const q = query.trim();
    if (!q) return null;

    // 1. Exact barcode
    let rows: any[] = await d.select('SELECT * FROM products WHERE barcode = ? LIMIT 1', [q]);
    if (rows.length > 0) return rows[0];

    // 2. Exact SKU
    rows = await d.select('SELECT * FROM products WHERE sku = ? LIMIT 1', [q]);
    if (rows.length > 0) return rows[0];

    // 3. Partial name
    rows = await d.select('SELECT * FROM products WHERE name LIKE ? LIMIT 1', [`%${q}%`]);
    if (rows.length > 0) return rows[0];

    return null;
}

/**
 * Fetch all active products.
 */
export async function mysqlGetActiveProducts(): Promise<any[]> {
    const d = await getDb();
    return await d.select(`SELECT * FROM products WHERE isActive = 1`);
}

/**
 * Fetch products that sit on POS tiles.
 */
export async function mysqlGetTileProducts(): Promise<any[]> {
    const d = await getDb();
    return await d.select(`
        SELECT p.* FROM products p
        JOIN pos_tiles t ON p.id = t.productId
        WHERE p.isActive = 1
    `);
}

// ─── Product helpers ─────────────────────────────────────────────────────────

export async function mysqlAddProduct(p: any): Promise<void> {
    await mysqlUpsert('products', p);
}

export async function mysqlUpdateProduct(p: any): Promise<void> {
    await mysqlUpsert('products', p);
}

export async function mysqlDeleteProduct(id: string): Promise<void> {
    const d = await getDb();
    await d.execute('UPDATE products SET isActive = 0 WHERE id = ?', [id]);
}

export async function mysqlBulkAddProducts(products: any[]): Promise<void> {
    const d = await getDb();
    const validCols = await getTableColumns('products');

    // MariaDB supports START TRANSACTION / COMMIT
    await d.execute('START TRANSACTION');
    try {
        for (const p of products) {
            const keys = Object.keys(p).filter(k => validCols.includes(k));
            const values = keys.map(k => normalizeValue(p[k]));
            const columns = keys.map(k => `\`${k}\``).join(', ');
            const placeholders = keys.map(() => '?').join(', ');
            const sql = `INSERT IGNORE INTO products (${columns}) VALUES (${placeholders})`;
            await d.execute(sql, values);
        }
        await d.execute('COMMIT');
    } catch (e) {
        await d.execute('ROLLBACK');
        throw e;
    }
}

// ─── POS Page / Tile helpers ─────────────────────────────────────────────────

export async function mysqlSavePosPage(p: any): Promise<void> {
    const d = await getDb();
    await d.execute(
        `INSERT INTO pos_pages (id, name, position, color)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name = VALUES(name), position = VALUES(position), color = VALUES(color)`,
        [p.id, p.name, p.position, p.color]
    );
}

export async function mysqlDeletePosPage(id: string): Promise<void> {
    const d = await getDb();
    await d.execute('DELETE FROM pos_pages WHERE id = ?', [id]);
    await d.execute('DELETE FROM pos_tiles WHERE pageId = ?', [id]);
}

export async function mysqlAddTile(t: any): Promise<void> {
    const d = await getDb();
    await d.execute(
        'INSERT INTO pos_tiles (id, pageId, productId, position) VALUES (?, ?, ?, ?)',
        [t.id, t.pageId, t.productId, t.position]
    );
}

export async function mysqlDeleteTile(id: string): Promise<void> {
    const d = await getDb();
    await d.execute('DELETE FROM pos_tiles WHERE id = ?', [id]);
}

// ─── Goods Menu helpers ──────────────────────────────────────────────────────

export async function mysqlLimitGoodsMenuItems(): Promise<void> {
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
}

export async function mysqlBatchUpdateGoodsMenu(
    changes: { id: string; showInGoods: boolean; goodsSortOrder: number; updatedAt: string }[]
): Promise<void> {
    if (changes.length === 0) return;
    const d = await getDb();
    await d.execute('START TRANSACTION');
    try {
        for (const c of changes) {
            await d.execute(
                `UPDATE products SET showInGoods = ?, goodsSortOrder = ?, updatedAt = ? WHERE id = ?`,
                [c.showInGoods ? 1 : 0, c.goodsSortOrder, c.updatedAt, c.id]
            );
        }
        await d.execute('COMMIT');
    } catch (e) {
        await d.execute('ROLLBACK');
        throw e;
    }
}

// ─── Report Queries ──────────────────────────────────────────────────────────
// These are identical SQL to sqlite.ts — MariaDB supports the same date()
// function and COALESCE/CASE expressions.

import type { SalesOverview, PaymentBreakdown, TopProduct } from './sqlite';

export async function mysqlGetSalesOverview(
    startDate: string, endDate: string, tillNumber?: string
): Promise<SalesOverview> {
    const d = await getDb();
    const tillFilter = tillNumber ? ` AND o.tillNumber = ?` : '';
    const params: any[] = [startDate, endDate];
    if (tillNumber) params.push(tillNumber);

    const revRows: any[] = await d.select(
        `SELECT COALESCE(SUM(o.total), 0) as totalRevenue, COUNT(*) as totalTransactions
         FROM orders o
         WHERE o.status = 'completed' AND DATE(o.completedAt) >= ? AND DATE(o.completedAt) <= ?${tillFilter}`,
        params
    );

    const itemParams: any[] = [startDate, endDate];
    if (tillNumber) itemParams.push(tillNumber);
    const itemRows: any[] = await d.select(
        `SELECT COALESCE(SUM(ol.quantity), 0) as totalItems
         FROM order_lines ol
         JOIN orders o ON ol.orderId = o.id
         WHERE o.status = 'completed' AND DATE(o.completedAt) >= ? AND DATE(o.completedAt) <= ?${tillFilter}`,
        itemParams
    );

    const rev = revRows[0] || { totalRevenue: 0, totalTransactions: 0 };
    const items = itemRows[0] || { totalItems: 0 };
    return {
        totalRevenue: rev.totalRevenue || 0,
        totalTransactions: rev.totalTransactions || 0,
        avgTransactionValue: rev.totalTransactions > 0
            ? Math.round(rev.totalRevenue / rev.totalTransactions) : 0,
        totalItemsSold: items.totalItems || 0,
    };
}

export async function mysqlGetPaymentBreakdown(
    startDate: string, endDate: string, tillNumber?: string
): Promise<PaymentBreakdown> {
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
         WHERE o.status = 'completed' AND DATE(o.completedAt) >= ? AND DATE(o.completedAt) <= ?${tillFilter}`,
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

export async function mysqlGetTopProducts(
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
         WHERE o.status = 'completed' AND DATE(o.completedAt) >= ? AND DATE(o.completedAt) <= ?${tillFilter}
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

export async function mysqlAggregateDailySummary(date?: string): Promise<void> {
    const d = await getDb();
    const nowStr = new Date().toISOString();
    const dateFilter = date ? ` AND DATE(o.completedAt) = ?` : '';
    const params: any[] = date ? [date] : [];

    const rows: any[] = await d.select(
        `SELECT
            DATE(o.completedAt) as day,
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
             ON DUPLICATE KEY UPDATE
                cashTotal = VALUES(cashTotal),
                cardTotal = VALUES(cardTotal),
                totalSales = VALUES(totalSales),
                transactionCount = VALUES(transactionCount),
                updatedAt = VALUES(updatedAt)`,
            [r.day, r.till, r.cashTotal, r.cardTotal, r.totalSales, r.txCount, nowStr]
        );
    }
}

export async function mysqlGetLastReportMarker(tillNumber: string): Promise<string | null> {
    const d = await getDb();
    const rows: any[] = await d.select(
        `SELECT markerTime FROM till_report_markers
         WHERE tillNumber = ? AND type = 'period'
         ORDER BY markerTime DESC LIMIT 1`,
        [tillNumber]
    );
    return rows.length > 0 ? rows[0].markerTime : null;
}

export async function mysqlSaveReportMarker(
    tillNumber: string, periodStart: string, periodEnd: string
): Promise<void> {
    const d = await getDb();
    const id = crypto.randomUUID();
    const nowStr = new Date().toISOString();
    await d.execute(
        `INSERT INTO till_report_markers (id, tillNumber, type, markerTime, periodStart, periodEnd, createdAt)
         VALUES (?, ?, 'period', ?, ?, ?, ?)`,
        [id, tillNumber, nowStr, periodStart, periodEnd, nowStr]
    );
}

export async function mysqlGetOrCreateTillId(): Promise<string> {
    const d = await getDb();
    const rows: any[] = await d.select("SELECT value FROM settings WHERE `key` = 'till_id'");
    if (rows.length > 0 && rows[0].value) return rows[0].value;

    const tillId = crypto.randomUUID();
    await d.execute(
        "INSERT INTO settings (`key`, value, updatedAt) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value), updatedAt = VALUES(updatedAt)",
        ['till_id', tillId, new Date().toISOString()]
    );
    return tillId;
}

export async function mysqlGetTillName(): Promise<string> {
    const d = await getDb();
    const rows: any[] = await d.select("SELECT value FROM settings WHERE `key` = 'till_name'");
    if (rows.length > 0 && rows[0].value) return rows[0].value;
    return 'Till 1';
}

export async function mysqlSetTillName(name: string): Promise<void> {
    const d = await getDb();
    await d.execute(
        "INSERT INTO settings (`key`, value, updatedAt) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value), updatedAt = VALUES(updatedAt)",
        ['till_name', name, new Date().toISOString()]
    );
}

export async function mysqlGetAllTillNumbers(): Promise<string[]> {
    const d = await getDb();
    const rows: any[] = await d.select(
        `SELECT DISTINCT tillNumber FROM orders WHERE tillNumber IS NOT NULL AND tillNumber != '' ORDER BY tillNumber`
    );
    return rows.map(r => r.tillNumber);
}

export async function mysqlGetTillPeriodReport(
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
        avgTransactionValue: (rev.totalTransactions || 0) > 0
            ? Math.round((rev.totalRevenue || 0) / rev.totalTransactions) : 0,
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
