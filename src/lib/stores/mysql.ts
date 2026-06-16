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
            scalePlu TEXT,
            price INT NOT NULL,
            costPrice INT DEFAULT 0,
            stockLevel INT DEFAULT 0,
            trackStock INT DEFAULT 0,
            allowPriceOverride INT DEFAULT 0,
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
            postcode TEXT,
            loyaltyCode VARCHAR(32),
            loyaltyPoints INT DEFAULT 0,
            notes TEXT,
            createdAt TEXT,
            updatedAt TEXT
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
            receiptKey VARCHAR(100) UNIQUE,
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
            pinHash TEXT,
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
            priority INT DEFAULT 0,
            updatedAt TEXT
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
            createdAt TEXT,
            updatedAt TEXT
        )
    `);

    // 15. Promo Group Items
    await d.execute(`
        CREATE TABLE IF NOT EXISTS promo_group_items (
            id VARCHAR(36) PRIMARY KEY,
            groupId VARCHAR(36) NOT NULL,
            productId VARCHAR(36) NOT NULL,
            updatedAt TEXT,
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
            closedByEmployeeId VARCHAR(36),
            openedAt TEXT,
            closedAt TEXT,
            openingFloat INT,
            expectedCash INT,
            actualCash INT,
            cashDifference INT,
            expectedCard INT,
            actualCard INT,
            cardDifference INT,
            status TEXT,
            notes TEXT,
            updatedAt TEXT
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
            createdAt TEXT,
            updatedAt TEXT
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

    // 25. Tombstones — records deleted rows so deletions propagate to other tills
    await d.execute(`
        CREATE TABLE IF NOT EXISTS tombstones (
            id VARCHAR(150) PRIMARY KEY,
            table_name VARCHAR(64) NOT NULL,
            row_id VARCHAR(64) NOT NULL,
            deletedAt TEXT,
            updatedAt TEXT
        )
    `);

    // 26. App / shop identity — never merge data between different shops
    await d.execute(`
        CREATE TABLE IF NOT EXISTS app_identity (
            id VARCHAR(36) PRIMARY KEY,
            shopId VARCHAR(64) NOT NULL,
            shopName TEXT,
            licenseId VARCHAR(64),
            createdAt TEXT,
            updatedAt TEXT,
            identitySignature TEXT
        )
    `);

    // ─── Migrations for existing databases ─────────────────────────────────
    const migrations = [
        // Orders
        `ALTER TABLE orders ADD COLUMN IF NOT EXISTS amountTendered INT DEFAULT 0`,
        `ALTER TABLE orders ADD COLUMN IF NOT EXISTS updatedAt TEXT`,
        `ALTER TABLE orders ADD COLUMN IF NOT EXISTS tillNumber TEXT DEFAULT ''`,
        `ALTER TABLE orders ADD COLUMN IF NOT EXISTS paymentMethod TEXT DEFAULT ''`,
        `ALTER TABLE orders ADD COLUMN IF NOT EXISTS receiptKey VARCHAR(100)`,
        `ALTER TABLE orders ADD COLUMN IF NOT EXISTS originalOrderId VARCHAR(36)`,
        `ALTER TABLE orders ADD COLUMN IF NOT EXISTS discountId VARCHAR(36)`,

        // Order Lines
        `ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS costPrice INT DEFAULT 0`,
        `ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS discountId VARCHAR(36)`,
        `ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS discountAmount INT DEFAULT 0`,
        `ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS taxRate DOUBLE DEFAULT 0`,
        `ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS taxAmount INT DEFAULT 0`,
        `ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS isPriceOverride INT DEFAULT 0`,
        `ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS originalPrice INT DEFAULT 0`,
        `ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS notes TEXT`,
        `ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS updatedAt TEXT`,

        // Payments
        `ALTER TABLE payments ADD COLUMN IF NOT EXISTS updatedAt TEXT`,
        `ALTER TABLE payments ADD COLUMN IF NOT EXISTS cashAmount INT DEFAULT 0`,
        `ALTER TABLE payments ADD COLUMN IF NOT EXISTS cardAmount INT DEFAULT 0`,

        // Products
        `ALTER TABLE products ADD COLUMN IF NOT EXISTS barcode TEXT`,
        `ALTER TABLE products ADD COLUMN IF NOT EXISTS sku TEXT`,
        `ALTER TABLE products ADD COLUMN IF NOT EXISTS scalePlu TEXT`,
        `ALTER TABLE products ADD COLUMN IF NOT EXISTS color TEXT`,
        `ALTER TABLE products ADD COLUMN IF NOT EXISTS image TEXT`,
        `ALTER TABLE products ADD COLUMN IF NOT EXISTS isWeighable INT DEFAULT 0`,
        `ALTER TABLE products ADD COLUMN IF NOT EXISTS showInPos INT DEFAULT 1`,
        `ALTER TABLE products ADD COLUMN IF NOT EXISTS showInGoods INT DEFAULT 0`,
        `ALTER TABLE products ADD COLUMN IF NOT EXISTS goodsSortOrder INT DEFAULT 0`,
        `ALTER TABLE products ADD COLUMN IF NOT EXISTS costPrice INT DEFAULT 0`,
        `ALTER TABLE products ADD COLUMN IF NOT EXISTS stockLevel INT DEFAULT 0`,
        `ALTER TABLE products ADD COLUMN IF NOT EXISTS trackStock INT DEFAULT 0`,
        `ALTER TABLE products ADD COLUMN IF NOT EXISTS allowPriceOverride INT DEFAULT 0`,
        `ALTER TABLE products ADD COLUMN IF NOT EXISTS updatedAt TEXT`,
        `ALTER TABLE products MODIFY COLUMN barcode VARCHAR(255) NULL`,
        `ALTER TABLE products MODIFY COLUMN scalePlu VARCHAR(255) NULL`,
        `ALTER TABLE products MODIFY COLUMN sku VARCHAR(255) NULL`,

        // Discounts
        `ALTER TABLE discounts ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT 'manual_percent'`,
        `ALTER TABLE discounts ADD COLUMN IF NOT EXISTS autoApply INT DEFAULT 0`,
        `ALTER TABLE discounts ADD COLUMN IF NOT EXISTS groupId VARCHAR(36)`,
        `ALTER TABLE discounts ADD COLUMN IF NOT EXISTS minQuantity INT DEFAULT 1`,
        `ALTER TABLE discounts ADD COLUMN IF NOT EXISTS secondPrice INT DEFAULT 0`,
        `ALTER TABLE discounts ADD COLUMN IF NOT EXISTS bundleQuantity INT DEFAULT 0`,
        `ALTER TABLE discounts ADD COLUMN IF NOT EXISTS bundlePrice INT DEFAULT 0`,
        `ALTER TABLE discounts ADD COLUMN IF NOT EXISTS maxApplications INT`,
        `ALTER TABLE discounts ADD COLUMN IF NOT EXISTS startAt TEXT`,
        `ALTER TABLE discounts ADD COLUMN IF NOT EXISTS endAt TEXT`,
        `ALTER TABLE discounts ADD COLUMN IF NOT EXISTS priority INT DEFAULT 0`,
        `ALTER TABLE discounts ADD COLUMN IF NOT EXISTS updatedAt TEXT`,

        // updatedAt on every remaining synced table so delta sync works for all
        `ALTER TABLE categories ADD COLUMN IF NOT EXISTS updatedAt TEXT`,
        `ALTER TABLE pos_pages ADD COLUMN IF NOT EXISTS updatedAt TEXT`,
        `ALTER TABLE pos_tiles ADD COLUMN IF NOT EXISTS updatedAt TEXT`,
        `ALTER TABLE tax_rates ADD COLUMN IF NOT EXISTS updatedAt TEXT`,
        `ALTER TABLE customers ADD COLUMN IF NOT EXISTS updatedAt TEXT`,
        `ALTER TABLE customers ADD COLUMN IF NOT EXISTS postcode TEXT`,
        `ALTER TABLE customers ADD COLUMN IF NOT EXISTS loyaltyCode VARCHAR(32)`,
        `ALTER TABLE loyalty_logs ADD COLUMN IF NOT EXISTS updatedAt TEXT`,
        `ALTER TABLE employees ADD COLUMN IF NOT EXISTS updatedAt TEXT`,
        `ALTER TABLE employees ADD COLUMN IF NOT EXISTS pinHash TEXT`,
        `ALTER TABLE registers ADD COLUMN IF NOT EXISTS updatedAt TEXT`,
        `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS updatedAt TEXT`,
        `ALTER TABLE product_suppliers ADD COLUMN IF NOT EXISTS updatedAt TEXT`,
        `ALTER TABLE inventory_logs ADD COLUMN IF NOT EXISTS updatedAt TEXT`,
        `ALTER TABLE promo_groups ADD COLUMN IF NOT EXISTS updatedAt TEXT`,
        `ALTER TABLE promo_group_items ADD COLUMN IF NOT EXISTS updatedAt TEXT`,
        `ALTER TABLE shifts ADD COLUMN IF NOT EXISTS updatedAt TEXT`,
        `ALTER TABLE shifts ADD COLUMN IF NOT EXISTS closedByEmployeeId VARCHAR(36) DEFAULT ''`,
        `ALTER TABLE shifts ADD COLUMN IF NOT EXISTS expectedCard INT DEFAULT 0`,
        `ALTER TABLE shifts ADD COLUMN IF NOT EXISTS actualCard INT DEFAULT 0`,
        `ALTER TABLE shifts ADD COLUMN IF NOT EXISTS cardDifference INT DEFAULT 0`,
        `ALTER TABLE shifts ADD COLUMN IF NOT EXISTS openRegisterId VARCHAR(36)
            AS (CASE WHEN status = 'open' THEN registerId ELSE NULL END) PERSISTENT`,
        `ALTER TABLE cash_movements ADD COLUMN IF NOT EXISTS updatedAt TEXT`,
        `ALTER TABLE loyalty_logs ADD COLUMN IF NOT EXISTS updatedAt TEXT`,
        `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS updatedAt TEXT`
    ];
    const migrationFailures: string[] = [];
    for (const sql of migrations) {
        try {
            await d.execute(sql);
        } catch (e) {
            migrationFailures.push(`${sql}: ${e}`);
        }
    }
    if (migrationFailures.length > 0) {
        throw new Error(`MariaDB schema migration failed:\n${migrationFailures.join('\n')}`);
    }
    // Bust the entire column cache after migrations so new columns are seen
    for (const k of Object.keys(tableColumnsCache)) delete tableColumnsCache[k];

    await ensureSyncTimestampTriggers(d);
    await cleanupDuplicateProductIdentifiers(d);
    await cleanupDuplicatePromotionMemberships(d);
    await cleanupDuplicateOpenShifts(d);
    await ensureDeleteTombstoneTriggers(d);

    // ─── Indexes ─────────────────────────────────────────────────────────────
    // MariaDB supports CREATE INDEX IF NOT EXISTS from 10.5+.  We wrap each
    // in a try/catch so older versions silently skip duplicates.
    const indexes = [
        `CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode(255))`,
        `CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku(255))`,
        `CREATE INDEX IF NOT EXISTS idx_products_scale_plu ON products(scalePlu(255))`,
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_products_barcode ON products(barcode)`,
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_products_scale_plu ON products(scalePlu)`,
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_products_sku ON products(sku)`,
        `CREATE INDEX IF NOT EXISTS idx_products_category ON products(categoryId)`,
        `CREATE INDEX IF NOT EXISTS idx_products_active ON products(isActive)`,
        `CREATE INDEX IF NOT EXISTS idx_tiles_page ON pos_tiles(pageId)`,
        `CREATE INDEX IF NOT EXISTS idx_order_lines_order ON order_lines(orderId)`,
        `CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(orderId)`,
        `CREATE INDEX IF NOT EXISTS idx_inv_logs_product ON inventory_logs(productId)`,
        `CREATE INDEX IF NOT EXISTS idx_promo_group_items_group ON promo_group_items(groupId)`,
        `CREATE INDEX IF NOT EXISTS idx_promo_group_items_product ON promo_group_items(productId)`,
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_promo_group_product ON promo_group_items(groupId, productId)`,
        `CREATE INDEX IF NOT EXISTS idx_orders_completed ON orders(completedAt(255))`,
        `CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status(255))`,
        `CREATE INDEX IF NOT EXISTS idx_payments_method ON payments(method(255))`,
        `CREATE INDEX IF NOT EXISTS idx_daily_summary_date ON daily_sales_summary(date)`,
        `CREATE INDEX IF NOT EXISTS idx_till_markers_till ON till_report_markers(tillNumber)`,
        `CREATE INDEX IF NOT EXISTS idx_orders_till ON orders(tillNumber(255))`,
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_receipt_key ON orders(receiptKey)`,
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_open_shift_register ON shifts(openRegisterId)`,
    ];

    for (const sql of indexes) {
        try { await d.execute(sql); } catch { /* index may already exist */ }
    }

    console.log('MySQL/MariaDB database initialized successfully!');
}

const TIMESTAMP_SYNC_TABLES = [
    'products', 'categories', 'pos_pages', 'pos_tiles',
    'tax_rates', 'discounts', 'promo_groups', 'promo_group_items',
    'employees', 'settings', 'customers', 'registers',
    'suppliers', 'product_suppliers', 'inventory_logs',
    'orders', 'order_lines', 'payments',
    'loyalty_logs', 'audit_logs', 'shifts', 'cash_movements',
    'tombstones',
];

/**
 * MariaDB is shared by the tills and external apps. Stamp writes at the
 * database boundary so every client participates in delta sync consistently.
 */
async function ensureSyncTimestampTriggers(d: Database): Promise<void> {
    const stamp = `DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ')`;
    for (const table of TIMESTAMP_SYNC_TABLES) {
        await d.execute(
            `UPDATE ${table} SET updatedAt = ${stamp} WHERE updatedAt IS NULL OR updatedAt = ''`
        );
        await d.execute(
            `CREATE TRIGGER IF NOT EXISTS pos_stamp_${table}_insert
             BEFORE INSERT ON ${table} FOR EACH ROW SET NEW.updatedAt = ${stamp}`
        );
        await d.execute(
            `CREATE TRIGGER IF NOT EXISTS pos_stamp_${table}_update
             BEFORE UPDATE ON ${table} FOR EACH ROW SET NEW.updatedAt = ${stamp}`
        );
    }
}

const DELETE_SYNC_TABLES = [
    'products', 'categories', 'pos_pages', 'pos_tiles',
    'tax_rates', 'discounts', 'promo_groups', 'promo_group_items',
    'employees', 'customers', 'registers', 'suppliers', 'product_suppliers',
    'inventory_logs', 'orders', 'order_lines', 'payments',
    'loyalty_logs', 'audit_logs', 'shifts', 'cash_movements',
];

/** Make deletes performed by Android or another MariaDB client visible to tills. */
async function ensureDeleteTombstoneTriggers(d: Database): Promise<void> {
    const stamp = `DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ')`;
    for (const table of DELETE_SYNC_TABLES) {
        await d.execute(
            `CREATE TRIGGER IF NOT EXISTS pos_delete_${table}
             AFTER DELETE ON ${table} FOR EACH ROW
             INSERT INTO tombstones (id, table_name, row_id, deletedAt, updatedAt)
             VALUES (CONCAT('${table}:', OLD.id), '${table}', OLD.id, ${stamp}, ${stamp})
             ON DUPLICATE KEY UPDATE deletedAt = ${stamp}, updatedAt = ${stamp}`
        );
    }
}

async function cleanupDuplicatePromotionMemberships(d: Database): Promise<void> {
    await d.execute(`
        DELETE duplicate FROM promo_group_items duplicate
        INNER JOIN promo_group_items keeper
            ON duplicate.groupId = keeper.groupId
            AND duplicate.productId = keeper.productId
            AND duplicate.id < keeper.id
    `);
}

async function cleanupDuplicateOpenShifts(d: Database): Promise<void> {
    const stamp = `DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ')`;
    await d.execute(`
        UPDATE shifts duplicate
        INNER JOIN shifts keeper
            ON duplicate.registerId = keeper.registerId
            AND duplicate.status = 'open'
            AND keeper.status = 'open'
            AND duplicate.id < keeper.id
        SET duplicate.status = 'closed',
            duplicate.closedAt = COALESCE(NULLIF(duplicate.closedAt, ''), ${stamp}),
            duplicate.notes = CASE
                WHEN COALESCE(duplicate.notes, '') = '' THEN 'Automatically closed duplicate open till shift'
                ELSE duplicate.notes
            END,
            duplicate.updatedAt = ${stamp}
    `);
}

async function cleanupDuplicateProductIdentifiers(d: Database): Promise<void> {
    await d.execute(`UPDATE products SET barcode = NULL WHERE barcode IS NOT NULL AND TRIM(barcode) = ''`);
    await d.execute(`UPDATE products SET scalePlu = NULL WHERE scalePlu IS NOT NULL AND TRIM(scalePlu) = ''`);
    await d.execute(`UPDATE products SET sku = NULL WHERE sku IS NOT NULL AND TRIM(sku) = ''`);
    for (const column of ['barcode', 'scalePlu', 'sku']) {
        const duplicates: any[] = await d.select(
            `SELECT \`${column}\` AS value FROM products
             WHERE \`${column}\` IS NOT NULL AND \`${column}\` <> ''
             GROUP BY \`${column}\` HAVING COUNT(*) > 1`,
        );
        for (const duplicate of duplicates) {
            const rows: any[] = await d.select(
                `SELECT id FROM products WHERE \`${column}\` = ?
                 ORDER BY COALESCE(updatedAt, createdAt, '') DESC, id DESC`,
                [duplicate.value],
            );
            for (const row of rows.slice(1)) {
                await d.execute(`UPDATE products SET \`${column}\` = NULL WHERE id = ?`, [row.id]);
            }
        }
    }
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
    if (table === 'products') obj = normalizeProductIdentifiers(obj);
    const validCols = await getTableColumns(table);

    // Settings table uses `key` as the column name which is a reserved word
    const keys = Object.keys(obj).filter(k => validCols.includes(k) && k !== 'updatedAt');
    if (keys.length === 0 && !validCols.includes('updatedAt')) {
        throw new Error(`mysqlUpsert: no valid columns for table ${table}`);
    }
    const values = keys.map(k => normalizeValue(obj[k]));

    const columns = keys.map(k => `\`${k}\``);
    const placeholders = keys.map(() => '?');
    const updates = keys
        .filter(k => k !== idKey)
        .map(k => `\`${k}\` = VALUES(\`${k}\`)`);

    // Let MariaDB assign the absolute source of truth timestamp
    if (validCols.includes('updatedAt')) {
        const timeExpr = `DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ')`;
        columns.push('`updatedAt`');
        placeholders.push(timeExpr);
        updates.push(`\`updatedAt\` = ${timeExpr}`);
    }

    const columnsStr = columns.join(', ');
    const placeholdersStr = placeholders.join(', ');
    const updatesStr = updates.join(', ');

    const sql = updatesStr
        ? `INSERT INTO ${table} (${columnsStr}) VALUES (${placeholdersStr}) ON DUPLICATE KEY UPDATE ${updatesStr}`
        : `INSERT IGNORE INTO ${table} (${columnsStr}) VALUES (${placeholdersStr})`;

    await d.execute(sql, values);
}

/** Refuse to replay an offline row over a newer server edit. */
export async function mysqlSafeOfflineUpsert(table: string, obj: any, idKey: string = 'id'): Promise<void> {
    const d = await getDb();
    const validCols = await getTableColumns(table);
    if (obj.updatedAt && validCols.includes('updatedAt')) {
        const rows: any[] = await d.select(
            `SELECT updatedAt FROM ${table} WHERE \`${idKey}\` = ? LIMIT 1`,
            [obj[idKey]]
        );
        const serverStamp = rows[0]?.updatedAt;
        if (serverStamp && String(serverStamp) > String(obj.updatedAt)) {
            throw new Error(`SYNC_CONFLICT: server ${table}/${obj[idKey]} is newer`);
        }
    }
    if (table === 'products') {
        try {
            await mysqlSaveProductStrict(obj);
        } catch (error) {
            if (isProductIdentifierConflict(error)) {
                throw new Error(`SYNC_CONFLICT: ${String(error)}`);
            }
            throw error;
        }
    } else {
        try {
            await mysqlUpsert(table, obj, idKey);
        } catch (error) {
            const message = String(error).toLowerCase();
            if (table === 'promo_group_items' && message.includes('duplicate entry')) {
                // Another till already saved the same group/product membership.
                // Delta sync will replace this till's stale random row ID.
                return;
            }
            if (message.includes('duplicate entry')) {
                throw new Error(`SYNC_CONFLICT: ${String(error)}`);
            }
            throw error;
        }
    }
}

function isProductIdentifierConflict(error: unknown): boolean {
    const message = String(error).toLowerCase();
    return message.includes('duplicate entry')
        || message.includes('uq_products_barcode')
        || message.includes('uq_products_scale_plu')
        || message.includes('uq_products_sku');
}

/**
 * Get the exact current time from MariaDB to use as the sync baseline
 */
export async function mysqlGetServerTime(): Promise<string> {
    const d = await getDb();
    const res: any[] = await d.select(`SELECT DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ') as t`);
    return res[0].t;
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

    // Main POS scanner lookup: only a 100% barcode match should add an item.
    const rows: any[] = await d.select(
        'SELECT * FROM products WHERE isActive = 1 AND showInPos = 1 AND barcode = ? LIMIT 1',
        [q],
    );
    return rows[0] || null;
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
    await mysqlSaveProductStrict(p);
}

export async function mysqlUpdateProduct(p: any): Promise<void> {
    await mysqlSaveProductStrict(p);
}

/** Update selected fields without overwriting fields changed by another device. */
export async function mysqlUpdateProductFields(
    patch: Record<string, any>,
    expected?: Record<string, any>,
): Promise<void> {
    const d = await getDb();
    const p = normalizeProductIdentifiers(patch);
    const validCols = await getTableColumns('products');
    const keys = Object.keys(p).filter((key) => key !== 'id' && key !== 'updatedAt' && validCols.includes(key));
    if (!p.id || keys.length === 0) throw new Error('mysqlUpdateProductFields: product id and fields are required');
    const timeExpr = `DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ')`;
    const assignments = keys.map((key) => `\`${key}\` = ?`);
    if (validCols.includes('updatedAt')) assignments.push(`\`updatedAt\` = ${timeExpr}`);
    const expectedProduct = expected ? normalizeProductIdentifiers(expected) : null;
    const expectedKeys = expectedProduct
        ? keys.filter((key) => Object.prototype.hasOwnProperty.call(expectedProduct, key))
        : [];
    const expectedClause = expectedKeys.map((key) => `\`${key}\` <=> ?`).join(' AND ');
    const result = await d.execute(
        `UPDATE products SET ${assignments.join(', ')} WHERE id = ?${expectedClause ? ` AND ${expectedClause}` : ''}`,
        [
            ...keys.map((key) => normalizeValue(p[key])),
            p.id,
            ...expectedKeys.map((key) => normalizeValue(expectedProduct![key])),
        ],
    );
    if (expectedClause && result.rowsAffected === 0) {
        throw new Error('PRODUCT_EDIT_CONFLICT: This item was changed on another device. Refresh the items list and try again.');
    }
}

async function mysqlSaveProductStrict(product: any): Promise<void> {
    const d = await getDb();
    const p = normalizeProductIdentifiers(product);
    const validCols = await getTableColumns('products');
    const keys = Object.keys(p).filter((key) => validCols.includes(key) && key !== 'updatedAt');
    const exists: any[] = await d.select('SELECT id FROM products WHERE id = ? LIMIT 1', [p.id]);
    const timeExpr = `DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ')`;

    if (exists.length > 0) {
        const updateKeys = keys.filter((key) => key !== 'id');
        const assignments = updateKeys.map((key) => `\`${key}\` = ?`);
        if (validCols.includes('updatedAt')) assignments.push(`\`updatedAt\` = ${timeExpr}`);
        await d.execute(
            `UPDATE products SET ${assignments.join(', ')} WHERE id = ?`,
            [...updateKeys.map((key) => normalizeValue(p[key])), p.id],
        );
        return;
    }

    const columns = keys.map((key) => `\`${key}\``);
    const placeholders = keys.map(() => '?');
    if (validCols.includes('updatedAt')) {
        columns.push('`updatedAt`');
        placeholders.push(timeExpr);
    }
    await d.execute(
        `INSERT INTO products (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
        keys.map((key) => normalizeValue(p[key])),
    );
}

function normalizeProductIdentifiers<T extends Record<string, any>>(product: T): T {
    return {
        ...product,
        ...(Object.prototype.hasOwnProperty.call(product, 'barcode')
            ? { barcode: String(product.barcode || '').trim() || null }
            : {}),
        ...(Object.prototype.hasOwnProperty.call(product, 'scalePlu')
            ? { scalePlu: String(product.scalePlu || '').trim() || null }
            : {}),
        ...(Object.prototype.hasOwnProperty.call(product, 'sku')
            ? { sku: String(product.sku || '').trim() || null }
            : {}),
    };
}

/**
 * Atomically change a product's stock level by `delta` (negative to decrement)
 * on the server. Deltas commute, so concurrent sales across tills accumulate
 * correctly. Bumps updatedAt (server clock) so the change propagates via delta sync.
 */
export async function mysqlAdjustStock(productId: string, delta: number): Promise<void> {
    if (!delta) return;
    const d = await getDb();
    await d.execute(
        `UPDATE products SET stockLevel = stockLevel + ?,
         updatedAt = DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ') WHERE id = ?`,
        [delta, productId]
    );
}

/** Set an item's counted stock only if no till changed it after counting began. */
export async function mysqlSetStockLevel(
    productId: string,
    stockLevel: number,
    expectedStockLevel: number,
): Promise<void> {
    const d = await getDb();
    const result = await d.execute(
        `UPDATE products SET stockLevel = ?,
         updatedAt = DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ')
         WHERE id = ? AND stockLevel = ?`,
        [stockLevel, productId, expectedStockLevel]
    );
    if (result.rowsAffected === 0) {
        throw new Error('STOCK_COUNT_CONFLICT: Stock changed on another till while this item was open.');
    }
}

export async function mysqlDeleteProduct(id: string): Promise<void> {
    const d = await getDb();
    // Bump updatedAt (server clock) so the soft-delete propagates via delta sync.
    await d.execute(
        `UPDATE products SET isActive = 0, showInGoods = 0, goodsSortOrder = 0,
         updatedAt = DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ') WHERE id = ?`,
        [id]
    );
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
        `INSERT INTO pos_pages (id, name, position, color, updatedAt)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            name = VALUES(name),
            position = VALUES(position),
            color = VALUES(color),
            updatedAt = VALUES(updatedAt)`,
        [p.id, p.name, p.position, p.color, p.updatedAt]
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
        'DELETE FROM pos_tiles WHERE pageId = ? AND position = ? AND id <> ?',
        [t.pageId, t.position, t.id],
    );
    await d.execute(
        `INSERT INTO pos_tiles (id, pageId, productId, position, updatedAt)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            pageId = VALUES(pageId),
            productId = VALUES(productId),
            position = VALUES(position),
            updatedAt = VALUES(updatedAt)`,
        [t.id, t.pageId, t.productId, t.position, t.updatedAt]
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
    const ids = changes.map(() => '?').join(', ');
    const boolCases = changes.map(() => 'WHEN ? THEN ?').join(' ');
    const orderCases = changes.map(() => 'WHEN ? THEN ?').join(' ');
    const stampCases = changes.map(() => 'WHEN ? THEN ?').join(' ');
    await d.execute(
        `UPDATE products SET
            showInGoods = CASE id ${boolCases} ELSE showInGoods END,
            goodsSortOrder = CASE id ${orderCases} ELSE goodsSortOrder END,
            updatedAt = CASE id ${stampCases} ELSE updatedAt END
         WHERE id IN (${ids})`,
        [
            ...changes.flatMap(c => [c.id, c.showInGoods ? 1 : 0]),
            ...changes.flatMap(c => [c.id, c.goodsSortOrder]),
            ...changes.flatMap(c => [c.id, c.updatedAt]),
            ...changes.map(c => c.id),
        ]
    );
}

// ─── Report Queries ──────────────────────────────────────────────────────────
// These are identical SQL to sqlite.ts — MariaDB supports the same date()
// function and COALESCE/CASE expressions.

import type {
    SalesOverview, PaymentBreakdown, TopProduct, TillReportOption,
    TillSalesSummary, DailySalesPoint, BusinessSummary, EmployeeSalesSummary
} from './sqlite';

function reportDateBounds(startDate: string, endDate: string): [string, string] {
    const start = new Date(`${startDate}T00:00:00`);
    const end = new Date(`${endDate}T00:00:00`);
    end.setDate(end.getDate() + 1);
    return [start.toISOString(), end.toISOString()];
}

export async function mysqlGetSalesOverview(
    startDate: string, endDate: string, tillNumber?: string
): Promise<SalesOverview> {
    const d = await getDb();
    const tillFilter = tillNumber ? ` AND o.tillNumber = ?` : '';
    const params: any[] = [...reportDateBounds(startDate, endDate)];
    if (tillNumber) params.push(tillNumber);

    const revRows: any[] = await d.select(
        `SELECT CAST(COALESCE(SUM(o.total), 0) AS SIGNED) as totalRevenue,
            CAST(COALESCE(SUM(CASE WHEN o.type != 'return' THEN o.total ELSE 0 END), 0) AS SIGNED) as saleRevenue,
            CAST(COALESCE(SUM(CASE WHEN o.type != 'return' THEN 1 ELSE 0 END), 0) AS SIGNED) as totalTransactions,
            CAST(COALESCE(SUM(CASE WHEN o.type = 'return' THEN 1 ELSE 0 END), 0) AS SIGNED) as refundTransactions
         FROM orders o
         WHERE o.status IN ('completed','refunded','partially_refunded','voided')
           AND o.status != 'voided'
           AND NOT (o.type = 'return' AND COALESCE(o.notes, '') LIKE 'Void of receipt %')
           AND o.completedAt >= ? AND o.completedAt < ?${tillFilter}`,
        params
    );

    const itemParams: any[] = [...reportDateBounds(startDate, endDate)];
    if (tillNumber) itemParams.push(tillNumber);
    const itemRows: any[] = await d.select(
        `SELECT CAST(COALESCE(SUM(ol.quantity), 0) AS SIGNED) as totalItems
         FROM order_lines ol
         JOIN orders o ON ol.orderId = o.id
         WHERE o.status IN ('completed','refunded','partially_refunded','voided')
           AND o.status != 'voided'
           AND NOT (o.type = 'return' AND COALESCE(o.notes, '') LIKE 'Void of receipt %')
           AND o.completedAt >= ? AND o.completedAt < ?${tillFilter}`,
        itemParams
    );

    const rev = revRows[0] || { totalRevenue: 0, totalTransactions: 0 };
    const items = itemRows[0] || { totalItems: 0 };
    return {
        totalRevenue: rev.totalRevenue || 0,
        totalTransactions: rev.totalTransactions || 0,
        refundTransactions: rev.refundTransactions || 0,
        avgTransactionValue: rev.totalTransactions > 0
            ? Math.round((rev.saleRevenue || 0) / rev.totalTransactions) : 0,
        totalItemsSold: items.totalItems || 0,
    };
}

export async function mysqlGetPaymentBreakdown(
    startDate: string, endDate: string, tillNumber?: string
): Promise<PaymentBreakdown> {
    const d = await getDb();
    const tillFilter = tillNumber ? ` AND o.tillNumber = ?` : '';
    const params: any[] = [...reportDateBounds(startDate, endDate)];
    if (tillNumber) params.push(tillNumber);

    const rows: any[] = await d.select(
        `SELECT
            CAST(COALESCE(SUM(p.totalCash), 0) AS SIGNED) as totalCash,
            CAST(COALESCE(SUM(p.totalCard), 0) AS SIGNED) as totalCard,
            CAST(COALESCE(SUM(p.totalLoyalty), 0) AS SIGNED) as totalLoyalty,
            CAST(COALESCE(SUM(CASE WHEN p.orderId IS NULL THEN o.total ELSE 0 END), 0) AS SIGNED) as unrecordedAmount,
            CAST(COALESCE(SUM(o.total), 0) AS SIGNED) as totalAmount,
            CAST(COALESCE(SUM(CASE WHEN p.hasCash = 1 AND p.hasCard = 0 THEN 1 ELSE 0 END), 0) AS SIGNED) as cashTxCount,
            CAST(COALESCE(SUM(CASE WHEN p.hasCard = 1 AND p.hasCash = 0 THEN 1 ELSE 0 END), 0) AS SIGNED) as cardTxCount,
            CAST(COALESCE(SUM(CASE WHEN p.hasCash = 1 AND p.hasCard = 1 THEN 1 ELSE 0 END), 0) AS SIGNED) as splitTxCount,
            CAST(COALESCE(SUM(CASE WHEN p.hasLoyalty = 1 THEN 1 ELSE 0 END), 0) AS SIGNED) as loyaltyTxCount,
            CAST(COALESCE(SUM(CASE WHEN p.orderId IS NULL THEN 1 ELSE 0 END), 0) AS SIGNED) as unrecordedTxCount
         FROM orders o
         LEFT JOIN (
            SELECT orderId,
                SUM(CASE WHEN method = 'cash' THEN COALESCE(NULLIF(cashAmount, 0), amount) WHEN method = 'split' THEN cashAmount ELSE 0 END) as totalCash,
                SUM(CASE WHEN method = 'card' THEN COALESCE(NULLIF(cardAmount, 0), amount) WHEN method = 'split' THEN cardAmount ELSE 0 END) as totalCard,
                SUM(amount
                    - CASE WHEN method = 'cash' THEN COALESCE(NULLIF(cashAmount, 0), amount) WHEN method = 'split' THEN cashAmount ELSE 0 END
                    - CASE WHEN method = 'card' THEN COALESCE(NULLIF(cardAmount, 0), amount) WHEN method = 'split' THEN cardAmount ELSE 0 END
                ) as totalLoyalty,
                MAX(CASE WHEN method IN ('cash', 'split') THEN 1 ELSE 0 END) as hasCash,
                MAX(CASE WHEN method IN ('card', 'split') THEN 1 ELSE 0 END) as hasCard,
                MAX(CASE WHEN amount
                    - CASE WHEN method = 'cash' THEN COALESCE(NULLIF(cashAmount, 0), amount) WHEN method = 'split' THEN cashAmount ELSE 0 END
                    - CASE WHEN method = 'card' THEN COALESCE(NULLIF(cardAmount, 0), amount) WHEN method = 'split' THEN cardAmount ELSE 0 END
                    != 0 THEN 1 ELSE 0 END) as hasLoyalty
            FROM payments GROUP BY orderId
         ) p ON o.id = p.orderId
         WHERE o.status IN ('completed','refunded','partially_refunded','voided')
           AND o.status != 'voided'
           AND NOT (o.type = 'return' AND COALESCE(o.notes, '') LIKE 'Void of receipt %')
           AND o.completedAt >= ? AND o.completedAt < ?${tillFilter}`,
        params
    );

    const r = rows[0] || {};
    return {
        totalCash: r.totalCash || 0,
        totalCard: r.totalCard || 0,
        totalLoyalty: r.totalLoyalty || 0,
        cashTxCount: r.cashTxCount || 0,
        cardTxCount: r.cardTxCount || 0,
        splitTxCount: r.splitTxCount || 0,
        loyaltyTxCount: r.loyaltyTxCount || 0,
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
    const params: any[] = [...reportDateBounds(startDate, endDate)];
    if (tillNumber) params.push(tillNumber);
    params.push(limit);

    const rows: any[] = await d.select(
        `SELECT
            CAST(ol.productName AS CHAR) as name,
            CAST(COALESCE(p.sku, '') AS CHAR) as sku,
            CAST(SUM(ol.quantity) AS SIGNED) as qtySold,
            CAST(SUM(ol.lineTotal) AS SIGNED) as totalRevenue,
            CAST(ROUND(SUM(ol.lineTotal) / NULLIF(SUM(ol.quantity), 0)) AS SIGNED) as avgPrice
         FROM order_lines ol
         JOIN orders o ON ol.orderId = o.id
         LEFT JOIN products p ON ol.productId = p.id
         WHERE o.status IN ('completed','refunded','partially_refunded','voided')
           AND o.status != 'voided'
           AND NOT (o.type = 'return' AND COALESCE(o.notes, '') LIKE 'Void of receipt %')
           AND o.completedAt >= ? AND o.completedAt < ?${tillFilter}
         GROUP BY ol.productId, ol.productName, p.sku
         HAVING SUM(ol.quantity) != 0 OR SUM(ol.lineTotal) != 0
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
    const rows: any[] = await d.select(
        `SELECT o.completedAt, COALESCE(o.tillNumber, '') as till, CAST(o.type AS CHAR) as type,
            CAST(COALESCE(SUM((SELECT SUM(CASE
                WHEN p.method = 'cash' THEN COALESCE(NULLIF(p.cashAmount, 0), p.amount)
                WHEN p.method = 'split' THEN p.cashAmount ELSE 0 END)
                FROM payments p WHERE p.orderId = o.id)), 0) AS SIGNED) as cashTotal,
            CAST(COALESCE(SUM((SELECT SUM(CASE
                WHEN p.method = 'card' THEN COALESCE(NULLIF(p.cardAmount, 0), p.amount)
                WHEN p.method = 'split' THEN p.cardAmount ELSE 0 END)
                FROM payments p WHERE p.orderId = o.id)), 0) AS SIGNED) as cardTotal,
            CAST(o.total AS SIGNED) as totalSales
         FROM orders o
         WHERE o.status IN ('completed','refunded','partially_refunded','voided')
           AND o.status != 'voided'
           AND NOT (o.type = 'return' AND COALESCE(o.notes, '') LIKE 'Void of receipt %')
         GROUP BY o.id, o.completedAt, o.tillNumber, o.total`
    );

    const grouped = new Map<string, { day: string; till: string; cashTotal: number; cardTotal: number; totalSales: number; txCount: number }>();
    for (const row of rows) {
        const completed = new Date(row.completedAt);
        const day = `${completed.getFullYear()}-${String(completed.getMonth() + 1).padStart(2, '0')}-${String(completed.getDate()).padStart(2, '0')}`;
        if (date && day !== date) continue;
        const key = `${day}\u0000${row.till || ''}`;
        const summary = grouped.get(key) || { day, till: row.till || '', cashTotal: 0, cardTotal: 0, totalSales: 0, txCount: 0 };
        summary.cashTotal += Number(row.cashTotal || 0);
        summary.cardTotal += Number(row.cardTotal || 0);
        summary.totalSales += Number(row.totalSales || 0);
        if (row.type !== 'return') summary.txCount++;
        grouped.set(key, summary);
    }

    for (const r of grouped.values()) {
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
    await d.execute(
        `INSERT INTO till_report_markers (id, tillNumber, type, markerTime, periodStart, periodEnd, createdAt)
         VALUES (?, ?, 'period', ?, ?, ?, ?)`,
        [id, tillNumber, periodEnd, periodStart, periodEnd, new Date().toISOString()]
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

export async function mysqlGetTillReportOptions(): Promise<TillReportOption[]> {
    const d = await getDb();
    const rows: any[] = await d.select(
        `SELECT CAST(o.tillNumber AS CHAR) as id, CAST(MAX(r.name) AS CHAR) as name, MIN(o.orderNumber) as minOrderNumber
         FROM orders o LEFT JOIN registers r ON r.id = o.tillNumber
         WHERE o.tillNumber IS NOT NULL AND o.tillNumber != ''
         GROUP BY o.tillNumber ORDER BY MIN(o.orderNumber), o.tillNumber`
    );
    const usedNames = new Map<string, number>();
    return rows.map((row, index) => {
        const sequence = Math.floor((row.minOrderNumber || 0) / 1_000_000);
        const baseName = row.name?.trim() || (sequence > 0 ? `Till ${sequence}` : `Till ${index + 1}`);
        const occurrence = (usedNames.get(baseName) || 0) + 1;
        usedNames.set(baseName, occurrence);
        return { id: row.id, name: occurrence === 1 ? baseName : `${baseName} (${occurrence})` };
    });
}

export async function mysqlGetTillSalesSummaries(startDate: string, endDate: string): Promise<TillSalesSummary[]> {
    const d = await getDb();
    const options = await mysqlGetTillReportOptions();
    const bounds = reportDateBounds(startDate, endDate);
    const rows: any[] = await d.select(
        `SELECT CAST(o.tillNumber AS CHAR) as id,
            CAST(COALESCE(SUM(o.total), 0) AS SIGNED) as netSales,
            CAST(COALESCE(SUM(CASE WHEN o.type != 'return' THEN o.total ELSE 0 END), 0) AS SIGNED) as saleRevenue,
            CAST(COALESCE(SUM(CASE WHEN o.type != 'return' THEN o.total + o.discountAmount ELSE 0 END), 0) AS SIGNED) as grossSales,
            CAST(ABS(COALESCE(SUM(CASE WHEN o.total < 0 THEN o.total ELSE 0 END), 0)) AS SIGNED) as refunds,
            CAST(COALESCE(SUM(o.taxTotal), 0) AS SIGNED) as taxTotal,
            CAST(COALESCE(SUM(CASE WHEN o.type != 'return' THEN 1 ELSE 0 END), 0) AS SIGNED) as transactions,
            CAST(COALESCE(SUM(CASE WHEN o.type = 'return' THEN 1 ELSE 0 END), 0) AS SIGNED) as refundTransactions,
            CAST(COALESCE(SUM((SELECT SUM(ol.quantity) FROM order_lines ol WHERE ol.orderId = o.id)), 0) AS SIGNED) as itemsSold,
            CAST(COALESCE(SUM((SELECT SUM(CASE WHEN p.method = 'cash' THEN COALESCE(NULLIF(p.cashAmount, 0), p.amount) WHEN p.method = 'split' THEN p.cashAmount ELSE 0 END) FROM payments p WHERE p.orderId = o.id)), 0) AS SIGNED) as cashTotal,
            CAST(COALESCE(SUM((SELECT SUM(CASE WHEN p.method = 'card' THEN COALESCE(NULLIF(p.cardAmount, 0), p.amount) WHEN p.method = 'split' THEN p.cardAmount ELSE 0 END) FROM payments p WHERE p.orderId = o.id)), 0) AS SIGNED) as cardTotal,
            CAST(COALESCE(SUM((SELECT SUM(p.amount
                - CASE WHEN p.method = 'cash' THEN COALESCE(NULLIF(p.cashAmount, 0), p.amount) WHEN p.method = 'split' THEN p.cashAmount ELSE 0 END
                - CASE WHEN p.method = 'card' THEN COALESCE(NULLIF(p.cardAmount, 0), p.amount) WHEN p.method = 'split' THEN p.cardAmount ELSE 0 END
            ) FROM payments p WHERE p.orderId = o.id)), 0) AS SIGNED) as loyaltyTotal
         FROM orders o
         WHERE o.status IN ('completed','refunded','partially_refunded','voided')
           AND o.status != 'voided'
           AND NOT (o.type = 'return' AND COALESCE(o.notes, '') LIKE 'Void of receipt %')
           AND o.completedAt >= ? AND o.completedAt < ?
         GROUP BY o.tillNumber ORDER BY netSales DESC`,
        bounds
    );
    return rows.map((row, index) => ({
        id: row.id || '',
        name: options.find(option => option.id === row.id)?.name || `Till ${index + 1}`,
        netSales: row.netSales || 0, grossSales: row.grossSales || 0, refunds: row.refunds || 0,
        taxTotal: row.taxTotal || 0, transactions: row.transactions || 0,
        refundTransactions: row.refundTransactions || 0, itemsSold: row.itemsSold || 0,
        cashTotal: row.cashTotal || 0, cardTotal: row.cardTotal || 0, loyaltyTotal: row.loyaltyTotal || 0,
    }));
}

export async function mysqlGetDailySalesTrend(startDate: string, endDate: string, tillNumber?: string): Promise<DailySalesPoint[]> {
    const d = await getDb();
    const tillFilter = tillNumber ? ` AND tillNumber = ?` : '';
    const params: any[] = [...reportDateBounds(startDate, endDate)];
    if (tillNumber) params.push(tillNumber);
    const rows: any[] = await d.select(
        `SELECT completedAt, CAST(total AS SIGNED) as total, CAST(type AS CHAR) as type
         FROM orders WHERE status IN ('completed','refunded','partially_refunded','voided')
           AND status != 'voided'
           AND NOT (type = 'return' AND COALESCE(notes, '') LIKE 'Void of receipt %')
           AND completedAt >= ? AND completedAt < ?${tillFilter}
         ORDER BY completedAt`,
        params
    );
    const grouped = new Map<string, DailySalesPoint>();
    for (const row of rows) {
        const completed = new Date(row.completedAt);
        const date = `${completed.getFullYear()}-${String(completed.getMonth() + 1).padStart(2, '0')}-${String(completed.getDate()).padStart(2, '0')}`;
        const point = grouped.get(date) || { date, netSales: 0, transactions: 0 };
        point.netSales += Number(row.total || 0);
        if (row.type !== 'return') point.transactions++;
        grouped.set(date, point);
    }
    return [...grouped.values()];
}

export async function mysqlGetBusinessSummary(startDate: string, endDate: string, tillNumber?: string): Promise<BusinessSummary> {
    const d = await getDb();
    const tillFilter = tillNumber ? ` AND o.tillNumber = ?` : '';
    const params: any[] = [...reportDateBounds(startDate, endDate)];
    if (tillNumber) params.push(tillNumber);
    const rows: any[] = await d.select(
        `SELECT
            CAST(COALESCE(SUM(CASE WHEN o.type != 'return' AND o.status != 'voided' THEN o.total + o.discountAmount ELSE 0 END), 0) AS SIGNED) as grossSales,
            CAST(ABS(COALESCE(SUM(CASE WHEN o.type = 'return' AND COALESCE(o.notes, '') NOT LIKE 'Void of receipt %' THEN o.total ELSE 0 END), 0)) AS SIGNED) as refunds,
            CAST(ABS(COALESCE(SUM(CASE WHEN o.type = 'return' AND COALESCE(o.notes, '') LIKE 'Void of receipt %' THEN o.total ELSE 0 END), 0)) AS SIGNED) as voids,
            CAST(COALESCE(SUM(CASE WHEN o.type = 'return' AND COALESCE(o.notes, '') LIKE 'Void of receipt %' THEN 1 ELSE 0 END), 0) AS SIGNED) as voidTransactions,
            CAST(COALESCE(SUM(CASE WHEN o.status != 'voided' AND NOT (o.type = 'return' AND COALESCE(o.notes, '') LIKE 'Void of receipt %') THEN o.total ELSE 0 END), 0) AS SIGNED) as netSales,
            CAST(COALESCE(SUM(CASE WHEN o.status != 'voided' AND NOT (o.type = 'return' AND COALESCE(o.notes, '') LIKE 'Void of receipt %') THEN o.taxTotal ELSE 0 END), 0) AS SIGNED) as taxTotal,
            CAST(COALESCE(SUM(CASE WHEN o.type != 'return' AND o.status != 'voided' THEN o.discountAmount ELSE 0 END), 0) AS SIGNED) as discountTotal,
            CAST(COALESCE(SUM(CASE WHEN o.status != 'voided' AND NOT (o.type = 'return' AND COALESCE(o.notes, '') LIKE 'Void of receipt %')
                THEN (SELECT SUM(ol.quantity * ol.costPrice) FROM order_lines ol WHERE ol.orderId = o.id) ELSE 0 END), 0) AS SIGNED) as costTotal
         FROM orders o
         WHERE o.status IN ('completed','refunded','partially_refunded','voided')
           AND o.completedAt >= ? AND o.completedAt < ?${tillFilter}`,
        params
    );
    const row = rows[0] || {};
    const netSales = row.netSales || 0;
    const costTotal = row.costTotal || 0;
    return {
        grossSales: row.grossSales || 0, refunds: row.refunds || 0,
        voids: row.voids || 0, voidTransactions: row.voidTransactions || 0, netSales,
        taxTotal: row.taxTotal || 0, discountTotal: row.discountTotal || 0,
        costTotal, grossProfit: netSales - (row.taxTotal || 0) - costTotal,
    };
}

export async function mysqlGetEmployeeSalesSummaries(startDate: string, endDate: string, tillNumber?: string): Promise<EmployeeSalesSummary[]> {
    const d = await getDb();
    const tillFilter = tillNumber ? ` AND o.tillNumber = ?` : '';
    const params: any[] = [...reportDateBounds(startDate, endDate)];
    if (tillNumber) params.push(tillNumber);
    const rows: any[] = await d.select(
        `SELECT o.employeeId, CAST(COALESCE(MAX(e.name), 'Unknown employee') AS CHAR) as employeeName,
            CAST(COALESCE(SUM(o.total), 0) AS SIGNED) as netSales,
            CAST(COALESCE(SUM(CASE WHEN o.type != 'return' THEN o.total ELSE 0 END), 0) AS SIGNED) as saleRevenue,
            CAST(COALESCE(SUM(CASE WHEN o.type != 'return' THEN o.total + o.discountAmount ELSE 0 END), 0) AS SIGNED) as grossSales,
            CAST(ABS(COALESCE(SUM(CASE WHEN o.total < 0 THEN o.total ELSE 0 END), 0)) AS SIGNED) as refunds,
            CAST(COALESCE(SUM(CASE WHEN o.type != 'return' THEN 1 ELSE 0 END), 0) AS SIGNED) as transactions,
            CAST(COALESCE(SUM(CASE WHEN o.type = 'return' THEN 1 ELSE 0 END), 0) AS SIGNED) as refundTransactions
         FROM orders o LEFT JOIN employees e ON e.id = o.employeeId
         WHERE o.status IN ('completed','refunded','partially_refunded','voided')
           AND o.status != 'voided'
           AND NOT (o.type = 'return' AND COALESCE(o.notes, '') LIKE 'Void of receipt %')
           AND o.completedAt >= ? AND o.completedAt < ?${tillFilter}
         GROUP BY o.employeeId ORDER BY netSales DESC`,
        params
    );
    return rows.map(row => ({
        employeeId: row.employeeId || '', employeeName: row.employeeName || 'Unknown employee',
        netSales: row.netSales || 0, grossSales: row.grossSales || 0, refunds: row.refunds || 0,
        transactions: row.transactions || 0,
        refundTransactions: row.refundTransactions || 0,
        avgTransaction: row.transactions > 0 ? Math.round((row.saleRevenue || 0) / row.transactions) : 0,
    }));
}

export async function mysqlGetTillPeriodReport(
    tillNumber: string,
    startTime: string,
    endTime: string
): Promise<{ overview: SalesOverview; breakdown: PaymentBreakdown; topProducts: TopProduct[] }> {
    const d = await getDb();

    // Overview
    const revRows: any[] = await d.select(
        `SELECT CAST(COALESCE(SUM(o.total), 0) AS SIGNED) as totalRevenue,
            CAST(COALESCE(SUM(CASE WHEN o.type != 'return' THEN o.total ELSE 0 END), 0) AS SIGNED) as saleRevenue,
            CAST(COALESCE(SUM(CASE WHEN o.type != 'return' THEN 1 ELSE 0 END), 0) AS SIGNED) as totalTransactions,
            CAST(COALESCE(SUM(CASE WHEN o.type = 'return' THEN 1 ELSE 0 END), 0) AS SIGNED) as refundTransactions
         FROM orders o
         WHERE o.status IN ('completed','refunded','partially_refunded','voided')
           AND o.status != 'voided'
           AND NOT (o.type = 'return' AND COALESCE(o.notes, '') LIKE 'Void of receipt %')
           AND o.tillNumber = ? AND o.completedAt >= ? AND o.completedAt < ?`,
        [tillNumber, startTime, endTime]
    );
    const itemRows: any[] = await d.select(
        `SELECT CAST(COALESCE(SUM(ol.quantity), 0) AS SIGNED) as totalItems
         FROM order_lines ol JOIN orders o ON ol.orderId = o.id
         WHERE o.status IN ('completed','refunded','partially_refunded','voided')
           AND o.status != 'voided'
           AND NOT (o.type = 'return' AND COALESCE(o.notes, '') LIKE 'Void of receipt %')
           AND o.tillNumber = ? AND o.completedAt >= ? AND o.completedAt < ?`,
        [tillNumber, startTime, endTime]
    );
    const rev = revRows[0] || {};
    const items = itemRows[0] || {};
    const overview: SalesOverview = {
        totalRevenue: rev.totalRevenue || 0,
        totalTransactions: rev.totalTransactions || 0,
        refundTransactions: rev.refundTransactions || 0,
        avgTransactionValue: (rev.totalTransactions || 0) > 0
            ? Math.round((rev.saleRevenue || 0) / rev.totalTransactions) : 0,
        totalItemsSold: items.totalItems || 0,
    };

    // Payment breakdown
    const bRows: any[] = await d.select(
        `SELECT
            CAST(COALESCE(SUM(p.totalCash), 0) AS SIGNED) as totalCash,
            CAST(COALESCE(SUM(p.totalCard), 0) AS SIGNED) as totalCard,
            CAST(COALESCE(SUM(p.totalLoyalty), 0) AS SIGNED) as totalLoyalty,
            CAST(COALESCE(SUM(CASE WHEN p.orderId IS NULL THEN o.total ELSE 0 END), 0) AS SIGNED) as unrecordedAmount,
            CAST(COALESCE(SUM(o.total), 0) AS SIGNED) as totalAmount,
            CAST(COALESCE(SUM(CASE WHEN p.hasCash = 1 AND p.hasCard = 0 THEN 1 ELSE 0 END), 0) AS SIGNED) as cashTxCount,
            CAST(COALESCE(SUM(CASE WHEN p.hasCard = 1 AND p.hasCash = 0 THEN 1 ELSE 0 END), 0) AS SIGNED) as cardTxCount,
            CAST(COALESCE(SUM(CASE WHEN p.hasCash = 1 AND p.hasCard = 1 THEN 1 ELSE 0 END), 0) AS SIGNED) as splitTxCount,
            CAST(COALESCE(SUM(CASE WHEN p.hasLoyalty = 1 THEN 1 ELSE 0 END), 0) AS SIGNED) as loyaltyTxCount,
            CAST(COALESCE(SUM(CASE WHEN p.orderId IS NULL THEN 1 ELSE 0 END), 0) AS SIGNED) as unrecordedTxCount
         FROM orders o
         LEFT JOIN (
            SELECT orderId,
                SUM(CASE WHEN method = 'cash' THEN COALESCE(NULLIF(cashAmount, 0), amount) WHEN method = 'split' THEN cashAmount ELSE 0 END) as totalCash,
                SUM(CASE WHEN method = 'card' THEN COALESCE(NULLIF(cardAmount, 0), amount) WHEN method = 'split' THEN cardAmount ELSE 0 END) as totalCard,
                SUM(amount
                    - CASE WHEN method = 'cash' THEN COALESCE(NULLIF(cashAmount, 0), amount) WHEN method = 'split' THEN cashAmount ELSE 0 END
                    - CASE WHEN method = 'card' THEN COALESCE(NULLIF(cardAmount, 0), amount) WHEN method = 'split' THEN cardAmount ELSE 0 END
                ) as totalLoyalty,
                MAX(CASE WHEN method IN ('cash', 'split') THEN 1 ELSE 0 END) as hasCash,
                MAX(CASE WHEN method IN ('card', 'split') THEN 1 ELSE 0 END) as hasCard,
                MAX(CASE WHEN amount
                    - CASE WHEN method = 'cash' THEN COALESCE(NULLIF(cashAmount, 0), amount) WHEN method = 'split' THEN cashAmount ELSE 0 END
                    - CASE WHEN method = 'card' THEN COALESCE(NULLIF(cardAmount, 0), amount) WHEN method = 'split' THEN cardAmount ELSE 0 END
                    != 0 THEN 1 ELSE 0 END) as hasLoyalty
            FROM payments GROUP BY orderId
         ) p ON o.id = p.orderId
         WHERE o.status IN ('completed','refunded','partially_refunded','voided')
           AND o.status != 'voided'
           AND NOT (o.type = 'return' AND COALESCE(o.notes, '') LIKE 'Void of receipt %')
           AND o.tillNumber = ? AND o.completedAt >= ? AND o.completedAt < ?`,
        [tillNumber, startTime, endTime]
    );
    const b = bRows[0] || {};
    const breakdown: PaymentBreakdown = {
        totalCash: b.totalCash || 0,
        totalCard: b.totalCard || 0,
        totalLoyalty: b.totalLoyalty || 0,
        cashTxCount: b.cashTxCount || 0,
        cardTxCount: b.cardTxCount || 0,
        splitTxCount: b.splitTxCount || 0,
        loyaltyTxCount: b.loyaltyTxCount || 0,
        totalAmount: b.totalAmount || 0,
        unrecordedAmount: b.unrecordedAmount || 0,
        unrecordedTxCount: b.unrecordedTxCount || 0,
    };

    // Top products
    const tpRows: any[] = await d.select(
        `SELECT
            CAST(ol.productName AS CHAR) as name,
            CAST(COALESCE(pr.sku, '') AS CHAR) as sku,
            CAST(SUM(ol.quantity) AS SIGNED) as qtySold,
            CAST(SUM(ol.lineTotal) AS SIGNED) as totalRevenue,
            CAST(ROUND(SUM(ol.lineTotal) / NULLIF(SUM(ol.quantity), 0)) AS SIGNED) as avgPrice
         FROM order_lines ol
         JOIN orders o ON ol.orderId = o.id
         LEFT JOIN products pr ON ol.productId = pr.id
         WHERE o.status IN ('completed','refunded','partially_refunded','voided')
           AND o.status != 'voided'
           AND NOT (o.type = 'return' AND COALESCE(o.notes, '') LIKE 'Void of receipt %')
           AND o.tillNumber = ? AND o.completedAt >= ? AND o.completedAt < ?
         GROUP BY ol.productId, ol.productName, pr.sku
         HAVING SUM(ol.quantity) != 0 OR SUM(ol.lineTotal) != 0
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
