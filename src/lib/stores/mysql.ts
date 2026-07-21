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
let currentUri: string = '';
let openingPromise: Promise<Database> | null = null;
let openingUri = '';
let connectionGeneration = 0;
const MYSQL_OPEN_TIMEOUT_MS = 1200;

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('MariaDB connection timed out')), timeoutMs);
    });
    try {
        return await Promise.race([operation, timeout]);
    } finally {
        clearTimeout(timeoutId!);
    }
}

function buildMysqlUri(config: MysqlConfig): string {
    const { user, password, host, port, database } = config;
    return `mysql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}

export async function getDb(config?: MysqlConfig): Promise<Database> {
    const cfg = config || get(connectionState).mysqlConfig;

    if (db && cfg && buildMysqlUri(cfg) === currentUri) {
        if (get(connectionState).mysqlOnline) return db;
        resetCachedConnection();
    }

    if (!cfg) {
        if (!db) throw new Error('MySQL no config provided and no cached connection');
        return db;
    }

    const uri = buildMysqlUri(cfg);
    if (db && uri !== currentUri) resetCachedConnection();
    if (openingPromise && openingUri === uri) return openingPromise;
    if (openingPromise && openingUri !== uri) resetCachedConnection();

    const generation = connectionGeneration;
    openingUri = uri;
    openingPromise = openConnection(uri, cfg.database, generation);
    return openingPromise;
}

export function resetCachedConnection(): void {
    connectionGeneration += 1;
    const old = db;
    db = null;
    currentDatabase = '';
    currentUri = '';
    openingPromise = null;
    openingUri = '';
    void closeDatabase(old);
}

async function openConnection(uri: string, database: string, generation: number): Promise<Database> {
    let opened: Database | null = null;
    try {
        opened = await withTimeout(Database.load(uri), MYSQL_OPEN_TIMEOUT_MS);
        if (generation !== connectionGeneration || openingUri !== uri) {
            await closeDatabase(opened);
            throw new Error('MariaDB connection was reset while opening');
        }
        db = opened;
        currentDatabase = database;
        currentUri = uri;
        return opened;
    } catch (error) {
        await closeDatabase(opened);
        throw error;
    } finally {
        if (generation === connectionGeneration) {
            openingPromise = null;
            openingUri = '';
        }
    }
}

async function closeDatabase(database: Database | null): Promise<void> {
    if (!database) return;
    try {
        await database.close(database.path);
    } catch (error) {
        console.warn('mysql: failed to close cached MariaDB connection:', error);
    }
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

    await d.execute(`
        CREATE TABLE IF NOT EXISTS sync_change_log (
            seq BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
            table_name VARCHAR(64) NOT NULL,
            changedAt VARCHAR(40) NOT NULL,
            INDEX idx_sync_change_table_seq (table_name, seq),
            INDEX idx_sync_change_time (changedAt)
        )
    `);

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
            price BIGINT NOT NULL,
            costPrice BIGINT DEFAULT 0,
            stockLevel INT DEFAULT 0,
            trackStock INT DEFAULT 0,
            allowPriceOverride INT DEFAULT 0,
            isWeighable INT DEFAULT 0,
            showInGoods INT DEFAULT 0,
            goodsSortOrder INT DEFAULT 0,
            color TEXT,
            image MEDIUMTEXT,
            isActive INT DEFAULT 1,
            createdAt TEXT,
            updatedAt TEXT
        )
    `);
    await d.execute(`
        CREATE TABLE IF NOT EXISTS product_images (
            id VARCHAR(36) PRIMARY KEY,
            image MEDIUMTEXT NOT NULL,
            updatedAt VARCHAR(40) NOT NULL
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
            subtotal BIGINT DEFAULT 0,
            discountId VARCHAR(36),
            discountAmount BIGINT DEFAULT 0,
            taxTotal BIGINT DEFAULT 0,
            total BIGINT DEFAULT 0,
            notes TEXT,
            tillNumber TEXT DEFAULT '',
            paymentMethod TEXT DEFAULT '',
            amountTendered BIGINT DEFAULT 0,
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
            unitPrice BIGINT DEFAULT 0,
            costPrice BIGINT DEFAULT 0,
            discountId VARCHAR(36),
            discountAmount BIGINT DEFAULT 0,
            taxRate DOUBLE DEFAULT 0,
            taxAmount BIGINT DEFAULT 0,
            lineTotal BIGINT DEFAULT 0,
            isPriceOverride INT DEFAULT 0,
            originalPrice BIGINT DEFAULT 0,
            notes TEXT,
            updatedAt TEXT,
            FOREIGN KEY(orderId) REFERENCES orders(id) ON DELETE CASCADE
        )
    `);

    // 9. Settings
    await d.execute(`
        CREATE TABLE IF NOT EXISTS settings (
            \`key\` VARCHAR(191) PRIMARY KEY,
            value TEXT,
            updatedAt TEXT
        )
    `);

    // 10. Employees
    await d.execute(`
        CREATE TABLE IF NOT EXISTS employees (
            id VARCHAR(36) PRIMARY KEY,
            storeId VARCHAR(36),
            name TEXT NOT NULL,
            pin TEXT,
            pinHash TEXT,
            role TEXT,
            email TEXT,
            isActive INT DEFAULT 1,
            createdAt TEXT,
            updatedAt TEXT
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
            secondPrice BIGINT DEFAULT 0,
            bundleQuantity INT DEFAULT 0,
            bundlePrice BIGINT DEFAULT 0,
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
            openingFloat BIGINT,
            expectedCash BIGINT,
            actualCash BIGINT,
            cashDifference BIGINT,
            expectedCard BIGINT,
            actualCard BIGINT,
            cardDifference BIGINT,
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
            amount BIGINT,
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
            entityId VARCHAR(191),
            oldData MEDIUMTEXT,
            newData MEDIUMTEXT,
            createdAt TEXT
        )
    `);

    // 20. Payments
    await d.execute(`
        CREATE TABLE IF NOT EXISTS payments (
            id VARCHAR(36) PRIMARY KEY,
            orderId VARCHAR(36),
            method TEXT,
            amount BIGINT DEFAULT 0,
            cashAmount BIGINT DEFAULT 0,
            cardAmount BIGINT DEFAULT 0,
            reference TEXT,
            changeGiven BIGINT DEFAULT 0,
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
            cashTotal BIGINT DEFAULT 0,
            cardTotal BIGINT DEFAULT 0,
            totalSales BIGINT DEFAULT 0,
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
            employeeId VARCHAR(36),
            reportText TEXT,
            reportTotal BIGINT DEFAULT 0,
            createdAt TEXT,
            updatedAt TEXT
        )
    `);

    // 23. Manager Approvals
    await d.execute(`
        CREATE TABLE IF NOT EXISTS manager_approvals (
            id VARCHAR(36) PRIMARY KEY,
            requestedByEmployeeId VARCHAR(36),
            approvedByEmployeeId VARCHAR(36),
            action TEXT NOT NULL,
            entityType TEXT,
            entityId VARCHAR(36),
            notes TEXT,
            createdAt TEXT,
            updatedAt TEXT
        )
    `);

    // 24. Stock Receipts
    await d.execute(`
        CREATE TABLE IF NOT EXISTS stock_receipts (
            id VARCHAR(36) PRIMARY KEY,
            supplierId VARCHAR(36),
            employeeId VARCHAR(36),
            reference TEXT,
            notes TEXT,
            totalCost BIGINT DEFAULT 0,
            status TEXT DEFAULT 'received',
            createdAt TEXT,
            updatedAt TEXT
        )
    `);

    // 25. Stock Receipt Lines
    await d.execute(`
        CREATE TABLE IF NOT EXISTS stock_receipt_lines (
            id VARCHAR(36) PRIMARY KEY,
            receiptId VARCHAR(36) NOT NULL,
            productId VARCHAR(36) NOT NULL,
            quantity INT DEFAULT 0,
            unitCost BIGINT DEFAULT 0,
            createdAt TEXT,
            updatedAt TEXT,
            FOREIGN KEY(receiptId) REFERENCES stock_receipts(id) ON DELETE CASCADE,
            FOREIGN KEY(productId) REFERENCES products(id) ON DELETE CASCADE
        )
    `);

    // 26. Product Suppliers
    await d.execute(`
        CREATE TABLE IF NOT EXISTS product_suppliers (
            id VARCHAR(36) PRIMARY KEY,
            productId VARCHAR(36),
            supplierId VARCHAR(36),
            supplierSku TEXT,
            costPrice BIGINT DEFAULT 0,
            isPreferred INT DEFAULT 0
        )
    `);

    // 27. Inventory Logs
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

    // 28. Tombstones — records deleted rows so deletions propagate to other tills
    await d.execute(`
        CREATE TABLE IF NOT EXISTS tombstones (
            id VARCHAR(150) PRIMARY KEY,
            table_name VARCHAR(64) NOT NULL,
            row_id VARCHAR(64) NOT NULL,
            deletedAt TEXT,
            updatedAt TEXT
        )
    `);

    // 29. App / shop identity — never merge data between different shops
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

    // Live device presence is intentionally not part of normal table sync.
    // Rows expire by lastSeenAt and only describe tills currently using MariaDB.
    await d.execute(`
        CREATE TABLE IF NOT EXISTS till_presence (
            tillId VARCHAR(64) PRIMARY KEY,
            tillName VARCHAR(255) NOT NULL,
            lastSeenAt DATETIME(3) NOT NULL,
            INDEX idx_till_presence_last_seen (lastSeenAt)
        )
    `);

    // Operational lease for card readers shared by more than one till. This is
    // intentionally excluded from normal data sync and setup backups.
    await d.execute(`
        CREATE TABLE IF NOT EXISTS payment_terminal_locks (
            terminalKey VARCHAR(191) PRIMARY KEY,
            tillId VARCHAR(64) NOT NULL,
            tillName VARCHAR(255) NOT NULL,
            paymentReference VARCHAR(255) NOT NULL,
            acquiredAt DATETIME(3) NOT NULL,
            expiresAt DATETIME(3) NOT NULL,
            INDEX idx_payment_terminal_locks_expiry (expiresAt)
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
        `ALTER TABLE orders MODIFY COLUMN subtotal BIGINT DEFAULT 0`,
        `ALTER TABLE orders MODIFY COLUMN discountAmount BIGINT DEFAULT 0`,
        `ALTER TABLE orders MODIFY COLUMN taxTotal BIGINT DEFAULT 0`,
        `ALTER TABLE orders MODIFY COLUMN total BIGINT DEFAULT 0`,
        `ALTER TABLE orders MODIFY COLUMN amountTendered BIGINT DEFAULT 0`,

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
        `ALTER TABLE order_lines MODIFY COLUMN unitPrice BIGINT DEFAULT 0`,
        `ALTER TABLE order_lines MODIFY COLUMN costPrice BIGINT DEFAULT 0`,
        `ALTER TABLE order_lines MODIFY COLUMN discountAmount BIGINT DEFAULT 0`,
        `ALTER TABLE order_lines MODIFY COLUMN taxAmount BIGINT DEFAULT 0`,
        `ALTER TABLE order_lines MODIFY COLUMN lineTotal BIGINT DEFAULT 0`,
        `ALTER TABLE order_lines MODIFY COLUMN originalPrice BIGINT DEFAULT 0`,

        // Payments
        `ALTER TABLE payments ADD COLUMN IF NOT EXISTS updatedAt TEXT`,
        `ALTER TABLE payments ADD COLUMN IF NOT EXISTS cashAmount INT DEFAULT 0`,
        `ALTER TABLE payments ADD COLUMN IF NOT EXISTS cardAmount INT DEFAULT 0`,
        `ALTER TABLE payments MODIFY COLUMN amount BIGINT DEFAULT 0`,
        `ALTER TABLE payments MODIFY COLUMN cashAmount BIGINT DEFAULT 0`,
        `ALTER TABLE payments MODIFY COLUMN cardAmount BIGINT DEFAULT 0`,
        `ALTER TABLE payments MODIFY COLUMN changeGiven BIGINT DEFAULT 0`,

        // Products
        `ALTER TABLE products ADD COLUMN IF NOT EXISTS barcode TEXT`,
        `ALTER TABLE products ADD COLUMN IF NOT EXISTS sku TEXT`,
        `ALTER TABLE products ADD COLUMN IF NOT EXISTS scalePlu TEXT`,
        `ALTER TABLE products ADD COLUMN IF NOT EXISTS color TEXT`,
        `ALTER TABLE products ADD COLUMN IF NOT EXISTS image MEDIUMTEXT`,
        `ALTER TABLE products MODIFY COLUMN image MEDIUMTEXT`,
        `ALTER TABLE products ADD COLUMN IF NOT EXISTS isWeighable INT DEFAULT 0`,
        `ALTER TABLE products ADD COLUMN IF NOT EXISTS showInGoods INT DEFAULT 0`,
        `ALTER TABLE products ADD COLUMN IF NOT EXISTS goodsSortOrder INT DEFAULT 0`,
        `ALTER TABLE products ADD COLUMN IF NOT EXISTS costPrice INT DEFAULT 0`,
        `ALTER TABLE products ADD COLUMN IF NOT EXISTS stockLevel INT DEFAULT 0`,
        `ALTER TABLE products ADD COLUMN IF NOT EXISTS trackStock INT DEFAULT 0`,
        `ALTER TABLE products ADD COLUMN IF NOT EXISTS allowPriceOverride INT DEFAULT 0`,
        `ALTER TABLE products ADD COLUMN IF NOT EXISTS updatedAt TEXT`,
        `ALTER TABLE products MODIFY COLUMN price BIGINT NOT NULL`,
        `ALTER TABLE products MODIFY COLUMN costPrice BIGINT DEFAULT 0`,
        `ALTER TABLE products MODIFY COLUMN barcode VARCHAR(255) NULL`,
        `ALTER TABLE products MODIFY COLUMN scalePlu VARCHAR(255) NULL`,
        `ALTER TABLE products MODIFY COLUMN sku VARCHAR(255) NULL`,
        `ALTER TABLE products DROP COLUMN IF EXISTS showInPos`,
        `ALTER TABLE categories DROP COLUMN IF EXISTS showOnPos`,

        // Settings keys grew as more device/receipt/printer options were added.
        // 191 keeps the primary key safe on older utf8mb4 InnoDB limits.
        `ALTER TABLE settings MODIFY COLUMN \`key\` VARCHAR(191)`,

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
        `ALTER TABLE discounts MODIFY COLUMN secondPrice BIGINT DEFAULT 0`,
        `ALTER TABLE discounts MODIFY COLUMN bundlePrice BIGINT DEFAULT 0`,

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
        `ALTER TABLE employees ADD COLUMN IF NOT EXISTS storeId VARCHAR(36)`,
        `ALTER TABLE employees ADD COLUMN IF NOT EXISTS email TEXT`,
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
        `ALTER TABLE shifts MODIFY COLUMN openingFloat BIGINT`,
        `ALTER TABLE shifts MODIFY COLUMN expectedCash BIGINT`,
        `ALTER TABLE shifts MODIFY COLUMN actualCash BIGINT`,
        `ALTER TABLE shifts MODIFY COLUMN cashDifference BIGINT`,
        `ALTER TABLE shifts MODIFY COLUMN expectedCard BIGINT DEFAULT 0`,
        `ALTER TABLE shifts MODIFY COLUMN actualCard BIGINT DEFAULT 0`,
        `ALTER TABLE shifts MODIFY COLUMN cardDifference BIGINT DEFAULT 0`,
        `ALTER TABLE shifts ADD COLUMN IF NOT EXISTS openRegisterId VARCHAR(36)
            AS (CASE WHEN status = 'open' THEN registerId ELSE NULL END) PERSISTENT`,
        `ALTER TABLE till_report_markers ADD COLUMN IF NOT EXISTS periodStart TEXT`,
        `ALTER TABLE till_report_markers ADD COLUMN IF NOT EXISTS periodEnd TEXT`,
        `ALTER TABLE till_report_markers ADD COLUMN IF NOT EXISTS employeeId VARCHAR(36)`,
        `ALTER TABLE till_report_markers ADD COLUMN IF NOT EXISTS reportText TEXT`,
        `ALTER TABLE till_report_markers ADD COLUMN IF NOT EXISTS reportTotal INT DEFAULT 0`,
        `ALTER TABLE till_report_markers ADD COLUMN IF NOT EXISTS updatedAt TEXT`,
        `ALTER TABLE till_report_markers MODIFY COLUMN reportTotal BIGINT DEFAULT 0`,
        `ALTER TABLE cash_movements ADD COLUMN IF NOT EXISTS updatedAt TEXT`,
        `ALTER TABLE cash_movements MODIFY COLUMN amount BIGINT`,
        `ALTER TABLE loyalty_logs ADD COLUMN IF NOT EXISTS updatedAt TEXT`,
        `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS updatedAt TEXT`,
        `ALTER TABLE audit_logs MODIFY COLUMN entityId VARCHAR(191)`,
        `ALTER TABLE audit_logs MODIFY COLUMN oldData MEDIUMTEXT`,
        `ALTER TABLE audit_logs MODIFY COLUMN newData MEDIUMTEXT`,
        `ALTER TABLE manager_approvals ADD COLUMN IF NOT EXISTS updatedAt TEXT`,
        `ALTER TABLE stock_receipts ADD COLUMN IF NOT EXISTS updatedAt TEXT`,
        `ALTER TABLE stock_receipts MODIFY COLUMN totalCost BIGINT DEFAULT 0`,
        `ALTER TABLE stock_receipt_lines ADD COLUMN IF NOT EXISTS updatedAt TEXT`,
        `ALTER TABLE stock_receipt_lines MODIFY COLUMN unitCost BIGINT DEFAULT 0`,
        `ALTER TABLE product_suppliers MODIFY COLUMN costPrice BIGINT DEFAULT 0`,
        `ALTER TABLE daily_sales_summary MODIFY COLUMN cashTotal BIGINT DEFAULT 0`,
        `ALTER TABLE daily_sales_summary MODIFY COLUMN cardTotal BIGINT DEFAULT 0`,
        `ALTER TABLE daily_sales_summary MODIFY COLUMN totalSales BIGINT DEFAULT 0`
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

    // One-time-compatible migration from the legacy products.image column.
    // INSERT IGNORE protects a newer independently-synced image row.
    const imageMigrationResult: any = await d.execute(`
        INSERT IGNORE INTO product_images (id, image, updatedAt)
        SELECT id, image,
               COALESCE(NULLIF(updatedAt, ''), NULLIF(createdAt, ''), DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ'))
        FROM products
        WHERE image IS NOT NULL AND image <> ''
    `);

    await ensureSyncTimestampTriggers(d);
    await cleanupDuplicateProductIdentifiers(d);
    await cleanupDuplicatePromotionMemberships(d);
    await cleanupDuplicateOpenShifts(d);
    await ensureDeleteTombstoneTriggers(d);
    await ensureSyncChangeTriggers(d);
    if (Number(imageMigrationResult?.rowsAffected || 0) > 0) {
        await d.execute(
            `INSERT INTO sync_change_log (table_name, changedAt)
             VALUES ('product_images', DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ'))`,
        );
    }
    await cleanupDeletedOrOrphanedPromotionRows(d);

    // ─── Indexes ─────────────────────────────────────────────────────────────
    // MariaDB supports CREATE INDEX IF NOT EXISTS from 10.5+.  We wrap each
    // in a try/catch so older versions silently skip duplicates.
    const indexes = [
        `CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode(255))`,
        `CREATE INDEX IF NOT EXISTS idx_products_barcode_active ON products(barcode(255), isActive)`,
        `CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku(255))`,
        `CREATE INDEX IF NOT EXISTS idx_products_scale_plu ON products(scalePlu(255))`,
        `CREATE INDEX IF NOT EXISTS idx_products_scale_plu_active ON products(scalePlu(255), isActive)`,
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
        `CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customerId(255))`,
        `CREATE INDEX IF NOT EXISTS idx_loyalty_logs_customer ON loyalty_logs(customerId(255), createdAt(255))`,
        `CREATE INDEX IF NOT EXISTS idx_customers_loyalty_code ON customers(loyaltyCode)`,
        `CREATE INDEX IF NOT EXISTS idx_payments_method ON payments(method(255))`,
        `CREATE INDEX IF NOT EXISTS idx_daily_summary_date ON daily_sales_summary(date)`,
        `CREATE INDEX IF NOT EXISTS idx_till_markers_till ON till_report_markers(tillNumber)`,
        `CREATE INDEX IF NOT EXISTS idx_manager_approvals_action ON manager_approvals(action(255))`,
        `CREATE INDEX IF NOT EXISTS idx_manager_approvals_created ON manager_approvals(createdAt(255), id)`,
        `CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(createdAt(255), id)`,
        `CREATE INDEX IF NOT EXISTS idx_audit_logs_action_created ON audit_logs(action(255), createdAt(255), id)`,
        `CREATE INDEX IF NOT EXISTS idx_audit_logs_entity_created ON audit_logs(entityType(255), createdAt(255), id)`,
        `CREATE INDEX IF NOT EXISTS idx_stock_receipts_created ON stock_receipts(createdAt(255))`,
        `CREATE INDEX IF NOT EXISTS idx_stock_receipt_lines_receipt ON stock_receipt_lines(receiptId)`,
        `CREATE INDEX IF NOT EXISTS idx_orders_till ON orders(tillNumber(255))`,
        `CREATE INDEX IF NOT EXISTS idx_orders_shift_status ON orders(shiftId, status(255))`,
        `CREATE INDEX IF NOT EXISTS idx_cash_movements_shift ON cash_movements(shiftId)`,
        `CREATE INDEX IF NOT EXISTS idx_shifts_opened_at ON shifts(openedAt(255), id)`,
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_receipt_key ON orders(receiptKey)`,
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_open_shift_register ON shifts(openRegisterId)`,
        ...TIMESTAMP_SYNC_TABLES.map((table) =>
            `CREATE INDEX IF NOT EXISTS idx_${table}_updated_at ON ${table}(updatedAt(255))`
        ),
    ];

    for (const sql of indexes) {
        try { await d.execute(sql); } catch { /* index may already exist */ }
    }

    console.log('MySQL/MariaDB database initialized successfully!');
}

const TIMESTAMP_SYNC_TABLES = [
    'app_identity',
    'products', 'product_images', 'categories', 'pos_pages', 'pos_tiles',
    'tax_rates', 'discounts', 'promo_groups', 'promo_group_items',
    'employees', 'settings', 'customers', 'registers',
    'suppliers', 'product_suppliers', 'inventory_logs',
    'orders', 'order_lines', 'payments',
    'loyalty_logs', 'audit_logs', 'shifts', 'cash_movements',
    'till_report_markers', 'manager_approvals',
    'stock_receipts', 'stock_receipt_lines',
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

async function ensureSyncChangeTriggers(d: Database): Promise<void> {
    const stamp = `DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ')`;
    const triggerRows: any[] = await d.select(
        `SELECT TRIGGER_NAME
         FROM INFORMATION_SCHEMA.TRIGGERS
         WHERE TRIGGER_SCHEMA = DATABASE()
           AND TRIGGER_NAME LIKE 'pos_change_%'`,
    );
    const existing = new Set(triggerRows.map(row => String(row.TRIGGER_NAME || row.trigger_name || '')));
    for (const table of TIMESTAMP_SYNC_TABLES) {
        for (const operation of ['insert', 'update', 'delete'] as const) {
            const triggerName = `pos_change_${table}_${operation}`;
            if (existing.has(triggerName)) continue;
            await d.execute(
                `CREATE TRIGGER IF NOT EXISTS ${triggerName}
                 AFTER ${operation.toUpperCase()} ON ${table} FOR EACH ROW
                 INSERT INTO sync_change_log (table_name, changedAt)
                 VALUES ('${table}', ${stamp})`,
            );
        }
    }
}

const DELETE_SYNC_TABLES = [
    'products', 'product_images', 'categories', 'pos_pages', 'pos_tiles',
    'tax_rates', 'discounts', 'promo_groups', 'promo_group_items',
    'employees', 'customers', 'registers', 'suppliers', 'product_suppliers',
    'inventory_logs', 'orders', 'order_lines', 'payments',
    'loyalty_logs', 'audit_logs', 'shifts', 'cash_movements',
    'till_report_markers', 'manager_approvals',
    'stock_receipts', 'stock_receipt_lines',
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

async function deleteRowsByIds(d: Database, table: string, ids: string[]): Promise<void> {
    const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
    const batchSize = 200;
    for (let i = 0; i < uniqueIds.length; i += batchSize) {
        const batch = uniqueIds.slice(i, i + batchSize);
        const placeholders = batch.map(() => '?').join(', ');
        await d.execute(`DELETE FROM ${table} WHERE id IN (${placeholders})`, batch);
    }
}

async function cleanupDeletedOrOrphanedPromotionRows(d: Database): Promise<void> {
    const deletedItemRows: any[] = await d.select(`
        SELECT row_id AS id FROM tombstones WHERE table_name = 'promo_group_items'
        UNION
        SELECT item.id
        FROM promo_group_items item
        INNER JOIN tombstones tombstone
            ON tombstone.table_name = 'promo_groups'
            AND tombstone.row_id = item.groupId
    `);

    const deletedDiscountRows: any[] = await d.select(`
        SELECT row_id AS id FROM tombstones WHERE table_name = 'discounts'
        UNION
        SELECT discount.id
        FROM discounts discount
        INNER JOIN tombstones tombstone
            ON tombstone.table_name = 'promo_groups'
            AND tombstone.row_id = discount.groupId
        UNION
        SELECT discount.id
        FROM discounts discount
        LEFT JOIN promo_groups promo_group ON promo_group.id = discount.groupId
        WHERE COALESCE(discount.groupId, '') <> ''
          AND promo_group.id IS NULL
    `);

    const deletedGroupRows: any[] = await d.select(`
        SELECT row_id AS id FROM tombstones WHERE table_name = 'promo_groups'
    `);

    await deleteRowsByIds(d, 'promo_group_items', deletedItemRows.map(row => row.id));
    await deleteRowsByIds(d, 'discounts', deletedDiscountRows.map(row => row.id));
    await deleteRowsByIds(d, 'promo_groups', deletedGroupRows.map(row => row.id));
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
    if (table === 'products') {
        await mysqlSaveProductStrict(obj);
        return;
    }
    const d = await getDb();
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

async function mysqlProductExists(productId: string): Promise<boolean> {
    const d = await getDb();
    const rows: any[] = await d.select(`SELECT id FROM products WHERE id = ? LIMIT 1`, [productId]);
    return rows.length > 0;
}

async function mysqlInsertProductSnapshot(product: any): Promise<void> {
    if (!product?.id) return;
    const d = await getDb();
    if (await mysqlProductExists(product.id)) return;

    try {
        await mysqlUpsert('products', product);
    } catch (error) {
        console.warn('mysql: full product snapshot insert failed, trying minimal promotion product:', error);
    }

    if (await mysqlProductExists(product.id)) return;

    const stamp = `DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ')`;
    await d.execute(
        `INSERT INTO products (
            id, name, price, costPrice, stockLevel, trackStock,
            isActive, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, 0, 0, 1, ${stamp}, ${stamp})
        ON DUPLICATE KEY UPDATE id = id`,
        [
            product.id,
            String(product.name || 'Synced promotion item'),
            Number(product.price || 0),
            Number(product.costPrice || 0),
        ],
    );
}

export async function mysqlEnsureProductSnapshots(products: any[]): Promise<void> {
    for (const product of products) {
        await mysqlInsertProductSnapshot(product);
    }
}

export async function mysqlSavePromotionBundle(
    group: any,
    discount: any,
    items: any[],
    products: any[] = [],
): Promise<void> {
    const d = await getDb();

    // Membership rows have product foreign keys. Insert missing product
    // snapshots first without overwriting newer product edits on MariaDB.
    const productSnapshots = [...products];
    const knownProductIds = new Set(productSnapshots.map(product => product?.id).filter(Boolean));
    for (const item of items) {
        if (item?.productId && !knownProductIds.has(item.productId)) {
            productSnapshots.push({
                id: item.productId,
                name: 'Synced promotion item',
                price: 0,
                costPrice: 0,
            });
            knownProductIds.add(item.productId);
        }
    }
    await mysqlEnsureProductSnapshots(productSnapshots);

    await mysqlUpsert('promo_groups', group);
    await mysqlUpsert('discounts', discount);

    for (const item of items) {
        if (!item?.id || !item?.groupId || !item?.productId) continue;
        await d.execute(
            `DELETE FROM promo_group_items WHERE groupId = ? AND productId = ? AND id <> ?`,
            [item.groupId, item.productId, item.id],
        );
        await mysqlUpsert('promo_group_items', item);
    }

    const itemIds = items.map(item => item.id).filter(Boolean);
    if (itemIds.length > 0) {
        const placeholders = itemIds.map(() => '?').join(', ');
        await d.execute(
            `DELETE FROM promo_group_items WHERE groupId = ? AND id NOT IN (${placeholders})`,
            [group.id, ...itemIds],
        );
    } else {
        await d.execute(`DELETE FROM promo_group_items WHERE groupId = ?`, [group.id]);
    }

    const [discountRows, itemRows] = await Promise.all([
        d.select(`SELECT id FROM discounts WHERE id = ? LIMIT 1`, [discount.id]) as Promise<any[]>,
        d.select(`SELECT id FROM promo_group_items WHERE groupId = ?`, [group.id]) as Promise<any[]>,
    ]);
    if (discountRows.length === 0) {
        throw new Error(`Promotion sync failed: discount ${discount.id} was not saved`);
    }
    if (itemRows.length !== itemIds.length) {
        throw new Error(`Promotion sync failed: saved ${itemRows.length} of ${itemIds.length} item(s) for ${group.id}`);
    }
}

export async function mysqlDeletePromotionBundle(discountIds: string[], groupId = ''): Promise<void> {
    const d = await getDb();
    const ids = Array.from(new Set(discountIds.filter(Boolean)));
    await d.execute('START TRANSACTION');
    try {
        if (groupId) {
            await d.execute(`DELETE FROM promo_group_items WHERE groupId = ?`, [groupId]);
        }
        if (ids.length > 0 && groupId) {
            const placeholders = ids.map(() => '?').join(', ');
            await d.execute(
                `DELETE FROM discounts WHERE groupId = ? OR id IN (${placeholders})`,
                [groupId, ...ids],
            );
        } else if (ids.length > 0) {
            const placeholders = ids.map(() => '?').join(', ');
            await d.execute(`DELETE FROM discounts WHERE id IN (${placeholders})`, ids);
        } else if (groupId) {
            await d.execute(`DELETE FROM discounts WHERE groupId = ?`, [groupId]);
        }
        if (groupId) {
            await d.execute(`DELETE FROM promo_groups WHERE id = ?`, [groupId]);
        }
        await d.execute('COMMIT');
    } catch (error) {
        await d.execute('ROLLBACK');
        throw error;
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

export interface MysqlConnectedTill {
    tillId: string;
    tillName: string;
    lastSeenAt: string;
    secondsAgo: number;
}

export interface MysqlPaymentTerminalLock {
    terminalKey: string;
    tillId: string;
    tillName: string;
    paymentReference: string;
    acquiredAt: string;
    expiresAt: string;
}

export interface MysqlPaymentTerminalLockResult {
    acquired: boolean;
    lock: MysqlPaymentTerminalLock | null;
}

export async function mysqlAcquirePaymentTerminalLock(
    terminalKey: string,
    tillId: string,
    tillName: string,
    paymentReference: string,
    leaseSeconds = 180,
): Promise<MysqlPaymentTerminalLockResult> {
    const d = await getDb();
    const lease = Math.max(30, Math.min(600, Math.floor(leaseSeconds)));
    await d.execute(
        `INSERT IGNORE INTO payment_terminal_locks
            (terminalKey, tillId, tillName, paymentReference, acquiredAt, expiresAt)
         VALUES (?, ?, ?, ?, UTC_TIMESTAMP(3), TIMESTAMPADD(SECOND, ?, UTC_TIMESTAMP(3)))`,
        [terminalKey, tillId, tillName || 'Till', paymentReference, lease],
    );
    await d.execute(
        `UPDATE payment_terminal_locks
         SET tillId = ?, tillName = ?, paymentReference = ?,
             acquiredAt = UTC_TIMESTAMP(3),
             expiresAt = TIMESTAMPADD(SECOND, ?, UTC_TIMESTAMP(3))
         WHERE terminalKey = ?
           AND (expiresAt <= UTC_TIMESTAMP(3) OR (tillId = ? AND paymentReference = ?))`,
        [tillId, tillName || 'Till', paymentReference, lease, terminalKey, tillId, paymentReference],
    );
    const rows = await d.select<MysqlPaymentTerminalLock[]>(
        `SELECT CAST(terminalKey AS CHAR) AS terminalKey,
                CAST(tillId AS CHAR) AS tillId,
                CAST(tillName AS CHAR) AS tillName,
                CAST(paymentReference AS CHAR) AS paymentReference,
                CAST(acquiredAt AS CHAR) AS acquiredAt,
                CAST(expiresAt AS CHAR) AS expiresAt
         FROM payment_terminal_locks WHERE terminalKey = ? LIMIT 1`,
        [terminalKey],
    );
    const lock = rows[0] || null;
    return {
        acquired: Boolean(lock && lock.tillId === tillId && lock.paymentReference === paymentReference),
        lock,
    };
}

export async function mysqlRefreshPaymentTerminalLock(
    terminalKey: string,
    tillId: string,
    paymentReference: string,
    leaseSeconds = 180,
): Promise<boolean> {
    const d = await getDb();
    const lease = Math.max(30, Math.min(600, Math.floor(leaseSeconds)));
    const result = await d.execute(
        `UPDATE payment_terminal_locks
         SET expiresAt = TIMESTAMPADD(SECOND, ?, UTC_TIMESTAMP(3))
         WHERE terminalKey = ? AND tillId = ? AND paymentReference = ?`,
        [lease, terminalKey, tillId, paymentReference],
    );
    return Number(result.rowsAffected || 0) === 1;
}

export async function mysqlReleasePaymentTerminalLock(
    terminalKey: string,
    tillId: string,
    paymentReference: string,
): Promise<void> {
    const d = await getDb();
    await d.execute(
        `DELETE FROM payment_terminal_locks
         WHERE terminalKey = ? AND tillId = ? AND paymentReference = ?`,
        [terminalKey, tillId, paymentReference],
    );
}

export async function mysqlTouchTillPresence(tillId: string, tillName: string): Promise<void> {
    const d = await getDb();
    await d.execute(
        `INSERT INTO till_presence (tillId, tillName, lastSeenAt)
         VALUES (?, ?, UTC_TIMESTAMP(3))
         ON DUPLICATE KEY UPDATE
            tillName = VALUES(tillName),
            lastSeenAt = UTC_TIMESTAMP(3)`,
        [tillId, tillName],
    );
}

export async function mysqlGetConnectedTills(onlineWithinSeconds = 45): Promise<MysqlConnectedTill[]> {
    const d = await getDb();
    const windowSeconds = Math.min(300, Math.max(15, Math.trunc(onlineWithinSeconds || 45)));
    const rows: any[] = await d.select(
        `SELECT
            tillId,
            CAST(tillName AS CHAR) AS tillName,
            DATE_FORMAT(lastSeenAt, '%Y-%m-%dT%H:%i:%s.%fZ') AS lastSeenAt,
            CAST(GREATEST(0, TIMESTAMPDIFF(SECOND, lastSeenAt, UTC_TIMESTAMP(3))) AS SIGNED) AS secondsAgo
         FROM till_presence
         WHERE lastSeenAt >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ${windowSeconds} SECOND)
         ORDER BY tillName ASC, tillId ASC`,
    );
    return rows.map((row) => ({
        tillId: String(row.tillId || ''),
        tillName: String(row.tillName || 'Till'),
        lastSeenAt: String(row.lastSeenAt || ''),
        secondsAgo: Math.max(0, Number(row.secondsAgo || 0)),
    }));
}

/**
 * Delete a row by its primary key.
 */
export async function mysqlRemove(table: string, id: string, idKey: string = 'id'): Promise<void> {
    const d = await getDb();
    await d.execute(`DELETE FROM ${table} WHERE \`${idKey}\` = ?`, [id]);
}

/** Atomically consume a held order so two tills cannot retrieve it together. */
export async function mysqlClaimHeldOrder(orderId: string): Promise<boolean> {
    const d = await getDb();
    const result = await d.execute(
        `DELETE FROM orders WHERE id = ? AND status = 'hold'`,
        [orderId],
    );
    return Number(result?.rowsAffected || 0) === 1;
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

export interface MysqlSyncPageCursor {
    updatedAt: string;
    rowId: string;
}

export interface MysqlSyncPage {
    rows: any[];
    nextCursor: MysqlSyncPageCursor | null;
}

export interface MysqlSyncChange {
    seq: number;
    tableName: string;
}

export interface MysqlSyncChangeWindow {
    minSeq: number;
    maxSeq: number;
    changes: MysqlSyncChange[];
}

export async function mysqlGetSyncChangeWindow(
    afterSeq: number,
    _limit = 1000,
): Promise<MysqlSyncChangeWindow> {
    const d = await getDb();
    const bounds: any[] = await d.select(
        `SELECT COALESCE(MIN(seq), 0) AS minSeq, COALESCE(MAX(seq), 0) AS maxSeq
         FROM sync_change_log`,
    );
    const minSeq = Number(bounds[0]?.minSeq || 0);
    const maxSeq = Number(bounds[0]?.maxSeq || 0);
    if (maxSeq <= afterSeq) return { minSeq, maxSeq, changes: [] };

    const rows: any[] = await d.select(
        `SELECT MAX(seq) AS seq, table_name AS tableName
         FROM sync_change_log
         WHERE seq > ? AND seq <= ?
         GROUP BY table_name
         ORDER BY MAX(seq) ASC`,
        [afterSeq, maxSeq],
    );
    return {
        minSeq,
        maxSeq,
        changes: rows.map(row => ({
            seq: Number(row.seq || 0),
            tableName: String(row.tableName || ''),
        })),
    };
}

export async function mysqlPruneSyncChangeLog(retainRows = 200_000): Promise<void> {
    const d = await getDb();
    const keep = Math.max(10_000, Number(retainRows || 200_000));
    await d.execute(
        `DELETE FROM sync_change_log
         WHERE seq < (SELECT cutoff FROM (
            SELECT GREATEST(COALESCE(MAX(seq), 0) - ?, 0) AS cutoff
            FROM sync_change_log
         ) retained)`,
        [keep],
    );
}

/** Read a stable, bounded delta page without offset scans or large IPC payloads. */
export async function mysqlGetSyncPage(
    table: string,
    sinceDate: string | null,
    throughDate: string,
    idKey = 'id',
    cursor: MysqlSyncPageCursor | null = null,
    limit = 500,
): Promise<MysqlSyncPage> {
    const d = await getDb();
    const validCols = await getTableColumns(table);
    if (!validCols.includes('updatedAt') || !validCols.includes(idKey)) {
        throw new Error(`Sync paging requires ${table}.updatedAt and ${table}.${idKey}`);
    }

    const where: string[] = ['updatedAt <= ?'];
    const params: any[] = [throughDate];
    if (sinceDate) {
        where.push('updatedAt > ?');
        params.push(sinceDate);
    }
    if (cursor) {
        where.push(`(updatedAt > ? OR (updatedAt = ? AND CAST(\`${idKey}\` AS CHAR) > ?))`);
        params.push(cursor.updatedAt, cursor.updatedAt, cursor.rowId);
    }

    const safeLimit = Math.max(1, Math.min(1000, Number(limit || 500)));
    const selectColumns = table === 'products'
        ? validCols.filter((column) => column !== 'image').map((column) => `\`${column}\``).join(', ')
        : '*';
    const rows: any[] = await d.select(
        `SELECT ${selectColumns} FROM ${table}
         WHERE ${where.join(' AND ')}
         ORDER BY updatedAt ASC, CAST(\`${idKey}\` AS CHAR) ASC
         LIMIT ?`,
        [...params, safeLimit],
    );
    const last = rows[rows.length - 1];
    return {
        rows,
        nextCursor: rows.length === safeLimit && last
            ? { updatedAt: String(last.updatedAt || ''), rowId: String(last[idKey] || '') }
            : null,
    };
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
        'SELECT * FROM products WHERE barcode = ? AND isActive = 1 LIMIT 1',
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
    const allKeys = Object.keys(p).filter((key) => key !== 'id' && key !== 'updatedAt' && validCols.includes(key));
    const expectedProduct = expected ? normalizeProductIdentifiers(expected) : null;
    const keys = expectedProduct
        ? allKeys.filter((key) => !sameMysqlValue(p[key], expectedProduct[key]))
        : allKeys;
    if (!p.id || allKeys.length === 0) throw new Error('mysqlUpdateProductFields: product id and fields are required');
    if (keys.length === 0) return;
    const timeExpr = `DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ')`;
    const assignments = keys.map((key) => `\`${key}\` = ?`);
    if (validCols.includes('updatedAt')) assignments.push(`\`updatedAt\` = ${timeExpr}`);
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

function sameMysqlValue(a: any, b: any): boolean {
    const left = normalizeValue(a);
    const right = normalizeValue(b);
    return left === right || String(left ?? '') === String(right ?? '');
}

async function mysqlSaveProductStrict(product: any): Promise<void> {
    const d = await getDb();
    const validCols = await getTableColumns('products');
    await mysqlUpsertProductById(d, product, validCols);
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
    const failures: string[] = [];

    for (const p of products) {
        try {
            await mysqlUpsertProductById(d, p, validCols);
        } catch (error) {
            const label = `${p?.name || p?.id || 'unknown product'}${p?.id ? ` (${p.id})` : ''}`;
            failures.push(`${label}: ${error}`);
        }
    }

    if (failures.length > 0) {
        const preview = failures.slice(0, 8).join(' | ');
        const suffix = failures.length > 8 ? ` | and ${failures.length - 8} more` : '';
        throw new Error(`Product upload failed for ${failures.length} product(s): ${preview}${suffix}`);
    }
}

function isTransientMysqlWriteConflict(error: unknown): boolean {
    const message = String(error).toLowerCase();
    return message.includes('1020')
        || message.includes('record has been changed since the last read')
        || message.includes('1213')
        || message.includes('deadlock')
        || message.includes('1205')
        || message.includes('lock wait timeout');
}

function isPrimaryKeyDuplicate(error: unknown): boolean {
    const message = String(error).toLowerCase();
    return message.includes('duplicate entry') && message.includes('primary');
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mysqlUpsertProductById(d: Database, product: any, validCols: string[]): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 5; attempt++) {
        try {
            await mysqlUpsertProductByIdOnce(d, product, validCols);
            return;
        } catch (error) {
            lastError = error;
            if (attempt < 5 && (isTransientMysqlWriteConflict(error) || isPrimaryKeyDuplicate(error))) {
                await wait(75 * attempt);
                continue;
            }
            throw error;
        }
    }
    throw lastError;
}

async function mysqlUpsertProductByIdOnce(d: Database, product: any, validCols: string[]): Promise<void> {
    const p = normalizeProductIdentifiers(product);
    const keys = Object.keys(p).filter((key) => validCols.includes(key) && key !== 'updatedAt');
    if (!keys.includes('id')) {
        throw new Error(`missing product id for ${p?.name || 'unknown item'}`);
    }

    const writeKeys = keys.filter((key) => key !== 'id');
    const timeExpr = `DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ')`;
    const updateAssignments = writeKeys.map((key) => `\`${key}\` = ?`);
    if (validCols.includes('updatedAt')) updateAssignments.push(`\`updatedAt\` = ${timeExpr}`);
    if (updateAssignments.length > 0) {
        const result = await d.execute(
            `UPDATE products SET ${updateAssignments.join(', ')} WHERE id = ?`,
            [...writeKeys.map((key) => normalizeValue(p[key])), p.id],
        );
        if (result.rowsAffected > 0) return;
    }

    const columns = keys.map((key) => `\`${key}\``);
    const placeholders = keys.map(() => '?');
    const values = keys.map((key) => normalizeValue(p[key]));
    if (validCols.includes('updatedAt')) {
        columns.push('`updatedAt`');
        placeholders.push(timeExpr);
    }

    await d.execute(
        `INSERT INTO products (${columns.join(', ')})
         VALUES (${placeholders.join(', ')})`,
        values,
    );
}

export async function mysqlUploadProductsIndividually(products: any[]): Promise<void> {
    const failures: string[] = [];
    for (const product of products) {
        try {
            await mysqlSaveProductStrict(product);
        } catch (error) {
            const label = `${product?.name || product?.id || 'unknown product'}${product?.id ? ` (${product.id})` : ''}`;
            failures.push(`${label}: ${error}`);
        }
    }

    if (failures.length > 0) {
        const preview = failures.slice(0, 8).join(' | ');
        const suffix = failures.length > 8 ? ` | and ${failures.length - 8} more` : '';
        throw new Error(`Product upload failed for ${failures.length} product(s): ${preview}${suffix}`);
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
    tillNumber: string,
    periodStart: string,
    periodEnd: string,
    extra: { employeeId?: string; reportText?: string; reportTotal?: number } = {}
): Promise<any> {
    const d = await getDb();
    const stamp = new Date().toISOString();
    const row = {
        id: crypto.randomUUID(),
        tillNumber,
        type: 'period',
        markerTime: periodEnd,
        periodStart,
        periodEnd,
        employeeId: extra.employeeId || '',
        reportText: extra.reportText || '',
        reportTotal: extra.reportTotal || 0,
        createdAt: stamp,
        updatedAt: stamp,
    };
    await mysqlUpsert('till_report_markers', row, 'id');
    return row;
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
    const [orderRows, registerRows] = await Promise.all([
        d.select<any[]>(
        `SELECT CAST(o.tillNumber AS CHAR) as id, CAST(MAX(r.name) AS CHAR) as name, MIN(o.orderNumber) as minOrderNumber
         FROM orders o LEFT JOIN registers r ON r.id = o.tillNumber
         WHERE o.tillNumber IS NOT NULL AND o.tillNumber != ''
         GROUP BY o.tillNumber ORDER BY MIN(o.orderNumber), o.tillNumber`,
        ),
        d.select<any[]>(`SELECT CAST(id AS CHAR) as id, CAST(name AS CHAR) as name FROM registers WHERE isActive = 1 ORDER BY name, id`),
    ]);
    const byId = new Map<string, any>();
    for (const row of registerRows) {
        byId.set(String(row.id || ''), { ...row, minOrderNumber: 0 });
    }
    for (const row of orderRows) {
        byId.set(String(row.id || ''), { ...byId.get(String(row.id || '')), ...row });
    }
    const rows = [...byId.values()];
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
    const byId = new Map(rows.map((row) => [String(row.id || ''), row]));
    return options.map((option) => {
        const row = byId.get(option.id) || {};
        return {
            id: option.id,
            name: option.name,
            netSales: row.netSales || 0,
            grossSales: row.grossSales || 0,
            refunds: row.refunds || 0,
            taxTotal: row.taxTotal || 0,
            transactions: row.transactions || 0,
            refundTransactions: row.refundTransactions || 0,
            itemsSold: row.itemsSold || 0,
            cashTotal: row.cashTotal || 0,
            cardTotal: row.cardTotal || 0,
            loyaltyTotal: row.loyaltyTotal || 0,
        };
    });
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
    const tillFilter = tillNumber ? `AND o.tillNumber = ?` : '';
    const periodParams = tillNumber ? [tillNumber, startTime, endTime] : [startTime, endTime];

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
           ${tillFilter} AND o.completedAt >= ? AND o.completedAt < ?`,
        periodParams
    );
    const itemRows: any[] = await d.select(
        `SELECT CAST(COALESCE(SUM(ol.quantity), 0) AS SIGNED) as totalItems
         FROM order_lines ol JOIN orders o ON ol.orderId = o.id
         WHERE o.status IN ('completed','refunded','partially_refunded','voided')
           AND o.status != 'voided'
           AND NOT (o.type = 'return' AND COALESCE(o.notes, '') LIKE 'Void of receipt %')
           ${tillFilter} AND o.completedAt >= ? AND o.completedAt < ?`,
        periodParams
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
           ${tillFilter} AND o.completedAt >= ? AND o.completedAt < ?`,
        periodParams
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
           ${tillFilter} AND o.completedAt >= ? AND o.completedAt < ?
         GROUP BY ol.productId, ol.productName, pr.sku
         HAVING SUM(ol.quantity) != 0 OR SUM(ol.lineTotal) != 0
         ORDER BY qtySold DESC
         LIMIT 10`,
        periodParams
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
