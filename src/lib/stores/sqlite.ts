import Database from '@tauri-apps/plugin-sql';
import { localDatabaseName } from './profile';

let db: Database | null = null;

export async function getDb(): Promise<Database> {
    if (!db) {
        db = await Database.load(`sqlite:${localDatabaseName}`);
    }
    return db;
}

export async function initDb() {
    const d = await getDb();

    console.log("Initializing SQLite Database...");
    // Tauri SQL uses a connection pool, so give concurrent readers/writers
    // time to finish instead of immediately returning SQLITE_BUSY.
    await d.execute('PRAGMA journal_mode = WAL');
    await d.execute('PRAGMA busy_timeout = 10000');
    await d.execute('PRAGMA foreign_keys = ON');

    // 1. Products Table
    await d.execute(`
        CREATE TABLE IF NOT EXISTS products (
            id TEXT PRIMARY KEY,
            categoryId TEXT,
            taxRateId TEXT,
            name TEXT NOT NULL,
            sku TEXT,
            barcode TEXT,
            scalePlu TEXT,
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

    // 1. Core tables
    await d.execute(`
        CREATE TABLE IF NOT EXISTS _offline_queue (
            id TEXT PRIMARY KEY,
            table_name TEXT,
            operation TEXT,
            data TEXT,
            id_key TEXT,
            created_at TEXT
        )
    `);
    await d.execute(`
        CREATE TABLE IF NOT EXISTS _sync_conflicts (
            id TEXT PRIMARY KEY,
            table_name TEXT NOT NULL,
            operation TEXT NOT NULL,
            data TEXT NOT NULL,
            reason TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
    `);
    await d.execute(`
        CREATE TABLE IF NOT EXISTS app_identity (
            id TEXT PRIMARY KEY,
            shopId TEXT NOT NULL,
            shopName TEXT,
            licenseId TEXT,
            createdAt TEXT,
            updatedAt TEXT,
            identitySignature TEXT
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
            postcode TEXT,
            loyaltyCode TEXT,
            loyaltyPoints INTEGER DEFAULT 0,
            notes TEXT,
            createdAt TEXT,
            updatedAt TEXT
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
            receiptKey TEXT UNIQUE,
            type TEXT,
            status TEXT,
            originalOrderId TEXT,
            subtotal INTEGER DEFAULT 0,
            discountId TEXT,
            discountAmount INTEGER DEFAULT 0,
            taxTotal INTEGER DEFAULT 0,
            total INTEGER DEFAULT 0,
            tillNumber TEXT DEFAULT '',
            paymentMethod TEXT DEFAULT '',
            amountTendered INTEGER DEFAULT 0,
            notes TEXT,
            createdAt TEXT,
            updatedAt TEXT,
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
            updatedAt TEXT,
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
            pinHash TEXT,
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
            priority INTEGER DEFAULT 0,
            updatedAt TEXT
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
            createdAt TEXT,
            updatedAt TEXT
        )
    `);

    // 22. Promo Group Items (which products belong to which group)
    await d.execute(`
        CREATE TABLE IF NOT EXISTS promo_group_items (
            id TEXT PRIMARY KEY,
            groupId TEXT NOT NULL,
            productId TEXT NOT NULL,
            updatedAt TEXT,
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
            closedByEmployeeId TEXT,
            openedAt TEXT,
            closedAt TEXT,
            openingFloat INTEGER,
            expectedCash INTEGER,
            actualCash INTEGER,
            cashDifference INTEGER,
            expectedCard INTEGER,
            actualCard INTEGER,
            cardDifference INTEGER,
            status TEXT,
            notes TEXT,
            updatedAt TEXT
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
            createdAt TEXT,
            updatedAt TEXT
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
            updatedAt TEXT,
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

    // 25. Tombstones — records deleted rows so deletions propagate to other tills
    await d.execute(`
        CREATE TABLE IF NOT EXISTS tombstones (
            id TEXT PRIMARY KEY,
            table_name TEXT NOT NULL,
            row_id TEXT NOT NULL,
            deletedAt TEXT,
            updatedAt TEXT
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
    await runDataMigrations();

    // Indexes on migration-added columns must run AFTER runMigrations().
    await d.execute(`CREATE INDEX IF NOT EXISTS idx_orders_till ON orders(tillNumber)`);
    await d.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_receipt_key ON orders(receiptKey)`);
    await d.execute(`CREATE INDEX IF NOT EXISTS idx_products_scale_plu ON products(scalePlu)`);
    await d.execute(`CREATE UNIQUE INDEX IF NOT EXISTS uq_products_barcode ON products(barcode) WHERE barcode IS NOT NULL AND barcode <> ''`);
    await d.execute(`CREATE UNIQUE INDEX IF NOT EXISTS uq_products_scale_plu ON products(scalePlu) WHERE scalePlu IS NOT NULL AND scalePlu <> ''`);
    await d.execute(`CREATE UNIQUE INDEX IF NOT EXISTS uq_products_sku ON products(sku) WHERE sku IS NOT NULL AND sku <> ''`);
    await d.execute(`CREATE UNIQUE INDEX IF NOT EXISTS uq_promo_group_product ON promo_group_items(groupId, productId)`);
    await d.execute(`CREATE UNIQUE INDEX IF NOT EXISTS uq_open_shift_register ON shifts(registerId) WHERE status = 'open'`);

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

/**
 * Idempotent migrations applied after CREATE TABLE IF NOT EXISTS.
 * Each entry uses addColumnIfMissing so it's safe to run on every startup.
 */
async function runMigrations() {
    const d = await getDb();
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
    await addColumnIfMissing('discounts', 'updatedAt', 'TEXT');

    // Payment split tracking columns (safe for existing rows — default 0).
    await addColumnIfMissing('payments', 'cashAmount', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('payments', 'cardAmount', 'INTEGER DEFAULT 0');

    // Multi-till support: track which till processed each order.
    await addColumnIfMissing('orders', 'tillNumber', "TEXT DEFAULT ''");

    // Track payment method on orders for fallback when payment records are missing.
    await addColumnIfMissing('orders', 'paymentMethod', "TEXT DEFAULT ''");

    // Orders: amountTendered + updatedAt for delta sync
    await addColumnIfMissing('orders', 'amountTendered', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('orders', 'updatedAt', 'TEXT');
    await addColumnIfMissing('orders', 'receiptKey', 'TEXT');
    await addColumnIfMissing('orders', 'originalOrderId', 'TEXT');
    await addColumnIfMissing('orders', 'discountId', 'TEXT');

    await addColumnIfMissing('customers', 'postcode', "TEXT DEFAULT ''");
    await addColumnIfMissing('customers', 'loyaltyCode', "TEXT DEFAULT ''");
    await addColumnIfMissing('customers', 'updatedAt', 'TEXT');
    await addColumnIfMissing('loyalty_logs', 'updatedAt', 'TEXT');

    // Order lines: sale snapshots and updatedAt for delta sync
    await addColumnIfMissing('order_lines', 'costPrice', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('order_lines', 'discountId', 'TEXT');
    await addColumnIfMissing('order_lines', 'discountAmount', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('order_lines', 'taxRate', 'REAL DEFAULT 0');
    await addColumnIfMissing('order_lines', 'taxAmount', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('order_lines', 'isPriceOverride', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('order_lines', 'originalPrice', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('order_lines', 'notes', 'TEXT');
    await addColumnIfMissing('order_lines', 'updatedAt', 'TEXT');

    // Payments: updatedAt for delta sync
    await addColumnIfMissing('payments', 'updatedAt', 'TEXT');

    // Products: Add all potentially missing fields for older SQLite DBs
    await addColumnIfMissing('products', 'barcode', 'TEXT');
    await addColumnIfMissing('products', 'sku', 'TEXT');
    await addColumnIfMissing('products', 'scalePlu', 'TEXT');
    await addColumnIfMissing('products', 'color', 'TEXT');
    await addColumnIfMissing('products', 'image', 'TEXT');
    await addColumnIfMissing('products', 'isWeighable', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('products', 'showInPos', 'INTEGER DEFAULT 1');
    await addColumnIfMissing('products', 'showInGoods', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('products', 'goodsSortOrder', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('products', 'costPrice', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('products', 'stockLevel', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('products', 'trackStock', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('products', 'allowPriceOverride', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('products', 'updatedAt', 'TEXT');
    await addColumnIfMissing('employees', 'pinHash', 'TEXT');

    // Till cash-up and card reconciliation fields.
    await addColumnIfMissing('shifts', 'closedByEmployeeId', "TEXT DEFAULT ''");
    await addColumnIfMissing('shifts', 'expectedCard', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('shifts', 'actualCard', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('shifts', 'cardDifference', 'INTEGER DEFAULT 0');

    // updatedAt on every remaining synced table so delta sync works for all.
    for (const t of [
        'categories', 'pos_pages', 'pos_tiles', 'tax_rates', 'customers',
        'employees', 'registers', 'suppliers', 'product_suppliers',
        'inventory_logs', 'promo_groups', 'promo_group_items',
        'shifts', 'cash_movements', 'loyalty_logs', 'audit_logs'
    ]) {
        await addColumnIfMissing(t, 'updatedAt', 'TEXT');
    }

    const stamp = new Date().toISOString();
    for (const t of ['discounts', 'promo_groups', 'promo_group_items']) {
        await d.execute(`UPDATE ${t} SET updatedAt = ? WHERE updatedAt IS NULL OR updatedAt = ''`, [stamp]);
    }
}

/** One-shot data migrations (tracked via settings table). */
async function runDataMigrations() {
    const d = await getDb();

    // Empty identifiers are not real identifiers. Convert them to NULL so
    // database-level unique indexes can allow many products without barcodes.
    await d.execute(`UPDATE products SET barcode = NULL WHERE TRIM(COALESCE(barcode, '')) = ''`);
    await d.execute(`UPDATE products SET scalePlu = NULL WHERE TRIM(COALESCE(scalePlu, '')) = ''`);
    await d.execute(`UPDATE products SET sku = NULL WHERE TRIM(COALESCE(sku, '')) = ''`);
    // Keep the newest membership and open shift before adding uniqueness rules.
    await d.execute(`
        DELETE FROM promo_group_items
        WHERE id NOT IN (
            SELECT keep_id FROM (
                SELECT MAX(id) AS keep_id FROM promo_group_items GROUP BY groupId, productId
            )
        )
    `);
    await d.execute(`
        UPDATE shifts SET status = 'closed',
            closedAt = COALESCE(NULLIF(closedAt, ''), updatedAt, openedAt),
            notes = CASE WHEN COALESCE(notes, '') = '' THEN 'Automatically closed duplicate open till shift' ELSE notes END
        WHERE status = 'open' AND id NOT IN (
            SELECT keep_id FROM (
                SELECT MAX(id) AS keep_id FROM shifts WHERE status = 'open' GROUP BY registerId
            )
        )
    `);
    for (const column of ['barcode', 'scalePlu', 'sku']) {
        const duplicates = await d.select(
            `SELECT ${column} AS value FROM products
             WHERE ${column} IS NOT NULL AND ${column} <> ''
             GROUP BY ${column} HAVING COUNT(*) > 1`,
        ) as any[];
        for (const duplicate of duplicates) {
            const rows = await d.select(
                `SELECT id FROM products WHERE ${column} = ?
                 ORDER BY COALESCE(updatedAt, createdAt, '') DESC, id DESC`,
                [duplicate.value],
            ) as any[];
            for (const row of rows.slice(1)) {
                await d.execute(`UPDATE products SET ${column} = NULL WHERE id = ?`, [row.id]);
            }
        }
    }

    // 1. Limit showInGoods to max 10 items and assign sort order.
    const alreadyDone = (await d.select(`SELECT 1 FROM settings WHERE key = 'migration_show_in_goods_limited'`)) as any[];
    if (alreadyDone.length === 0) {
        await limitGoodsMenuItems();
        await d.execute(`INSERT INTO settings (key, value, updatedAt) VALUES (?, ?, ?)`,
            ['migration_show_in_goods_limited', 'done', new Date().toISOString()]);
        console.log('Migration: limited showInGoods to 10 items with sort order');
    }

    // 2. Initialise default POS button layouts if missing.
    const layoutKeys = ['pos_cart_layout', 'pos_toolbar_layout'];
    for (const key of layoutKeys) {
        const exists = (await d.select(`SELECT 1 FROM settings WHERE key = ?`, [key])) as any[];
        if (exists.length === 0) {
            const defaults: Record<string, string> = {
                pos_cart_layout: JSON.stringify(['goods', 'recent_trans', 'change_price', 'hold']),
                pos_toolbar_layout: JSON.stringify(['scale', 'label_print', 'discount'])
            };
            await d.execute(`INSERT INTO settings (key, value, updatedAt) VALUES (?, ?, ?)`,
                [key, defaults[key], new Date().toISOString()]);
            console.log(`Migration: seeded default ${key}`);
        }
    }

    // 3. Drawer controls were removed; replace them with cashier-accessible label printing.
    const labelPrintMigration = (await d.select(`SELECT 1 FROM settings WHERE key = 'migration_drawer_to_label_print'`)) as any[];
    if (labelPrintMigration.length === 0) {
        for (const key of layoutKeys) {
            const rows = (await d.select(`SELECT value FROM settings WHERE key = ? LIMIT 1`, [key])) as any[];
            if (!rows[0]?.value) continue;
            try {
                const layout = JSON.parse(rows[0].value) as string[];
                const updated = layout.map((button) => button === 'drawer' ? 'label_print' : button);
                await d.execute(`UPDATE settings SET value = ?, updatedAt = ? WHERE key = ?`, [
                    JSON.stringify(updated), new Date().toISOString(), key
                ]);
            } catch {
                // Leave malformed legacy settings untouched so startup can continue.
            }
        }
        await d.execute(`INSERT INTO settings (key, value, updatedAt) VALUES (?, ?, ?)`, [
            'migration_drawer_to_label_print', 'done', new Date().toISOString()
        ]);
        console.log('Migration: replaced Drawer buttons with Label Print');
    }

    const holdButtonMigration = (await d.select(`SELECT 1 FROM settings WHERE key = 'migration_cart_label_print_to_hold'`)) as any[];
    if (holdButtonMigration.length === 0) {
        const rows = (await d.select(`SELECT value FROM settings WHERE key = 'pos_cart_layout' LIMIT 1`)) as any[];
        if (rows[0]?.value) {
            try {
                const layout = JSON.parse(rows[0].value) as string[];
                const updated = layout.map((button) =>
                    button === 'drawer' || button === 'label_print' ? 'hold' : button
                );
                if (!updated.includes('hold')) updated.push('hold');
                await d.execute(`UPDATE settings SET value = ?, updatedAt = ? WHERE key = 'pos_cart_layout'`, [
                    JSON.stringify([...new Set(updated)]),
                    new Date().toISOString(),
                ]);
            } catch {
                await d.execute(`UPDATE settings SET value = ?, updatedAt = ? WHERE key = 'pos_cart_layout'`, [
                    JSON.stringify(['goods', 'recent_trans', 'change_price', 'hold']),
                    new Date().toISOString(),
                ]);
            }
        }
        await d.execute(`INSERT INTO settings (key, value, updatedAt) VALUES (?, ?, ?)`, [
            'migration_cart_label_print_to_hold', 'done', new Date().toISOString()
        ]);
        console.log('Migration: replaced cart Label Print with Hold');
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
    if (table === 'products') obj = normalizeProductIdentifiers(obj);
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

export async function bulkUpsert(table: string, rows: any[], idKey: string = 'id') {
    if (rows.length === 0) return;
    if (table === 'products') rows = rows.map(normalizeProductIdentifiers);
    const d = await getDb();
    const validCols = await getTableColumns(table);

    // Filter properties to only those that exist as columns
    const columns = Object.keys(rows[0]).filter(k => validCols.includes(k));
    if (columns.length === 0) throw new Error(`bulkUpsert: no valid columns for table ${table}`);

    const placeholders = columns.map(() => '?').join(', ');
    const updates = columns.filter(k => k !== idKey).map(k => `${k}=excluded.${k}`).join(', ');
    
    const sql = updates
        ? `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT(${idKey}) DO UPDATE SET ${updates}`
        : `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT(${idKey}) DO NOTHING`;

    // Do not manage BEGIN/COMMIT through the pooled plugin connection. A later
    // execute may use a different connection and leave SQLite permanently locked.
    for (const row of rows) {
        // Membership identity historically used random IDs. If another client
        // created the same group/product pair, replace the stale local identity
        // before applying the authoritative MariaDB row.
        if (table === 'promo_group_items' && row.groupId && row.productId && row.id) {
            await d.execute(
                `DELETE FROM promo_group_items WHERE groupId = ? AND productId = ? AND id <> ?`,
                [row.groupId, row.productId, row.id]
            );
        }
        const values = columns.map(k => normalizeValue(row[k]));
        await d.execute(sql, values);
    }
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

    // Historical builds seeded demo shop data here. New installations now stay
    // empty until the setup wizard creates the real shop and administrator.
    // Existing databases are left untouched.
    void seed;
    const result: any[] = await d.select('SELECT id FROM products LIMIT 1');
    console.log(result.length > 0 ? "SQLite contains existing shop data." : "SQLite is ready for shop setup.");
}

/** 
 * Fast search in SQLite for barcode, sku, or name
 */
export async function searchProduct(query: string) {
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

export async function searchProductByScalePlu(scalePlu: string) {
    const d = await getDb();
    const rows: any[] = await d.select(
        'SELECT * FROM products WHERE scalePlu = ? AND isActive = 1 AND showInPos = 1 LIMIT 1',
        [scalePlu],
    );
    return rows[0] || null;
}

export async function assertProductIdentifiersUnique(product: any): Promise<void> {
    const d = await getDb();
    const p = normalizeProductIdentifiers(product);
    for (const column of ['barcode', 'scalePlu', 'sku']) {
        if (!p[column]) continue;
        const rows: any[] = await d.select(
            `SELECT name FROM products WHERE ${column} = ? AND id <> ? LIMIT 1`,
            [p[column], p.id],
        );
        if (rows.length > 0) {
            const label = column === 'barcode' ? 'Barcode' : column === 'scalePlu' ? 'Scale PLU' : 'SKU';
            throw new Error(`${label} is already used by ${rows[0].name}`);
        }
    }
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

    for (const p of products) {
        const keys = Object.keys(p).filter((k) => validCols.includes(k));
        const values = keys.map((k) => normalizeValue(p[k]));
        const columns = keys.join(", ");
        const placeholders = keys.map(() => "?").join(", ");

        const sql = `INSERT INTO products (${columns}) VALUES (${placeholders}) ON CONFLICT(id) DO NOTHING`;
        await d.execute(sql, values);
    }
}

/** Update an existing product in SQLite (schema-aware). */
export async function updateProduct(p: any) {
    await upsert('products', p);
}

/** Update selected fields on an existing product without replacing unrelated values. */
export async function updateProductFields(patch: Record<string, any>) {
    const d = await getDb();
    const p = normalizeProductIdentifiers(patch);
    const validCols = await getTableColumns('products');
    const keys = Object.keys(p).filter((key) => key !== 'id' && validCols.includes(key));
    if (!p.id || keys.length === 0) throw new Error('updateProductFields: product id and fields are required');
    await d.execute(
        `UPDATE products SET ${keys.map((key) => `${key} = ?`).join(', ')} WHERE id = ?`,
        [...keys.map((key) => normalizeValue(p[key])), p.id],
    );
}

/**
 * Atomically change a product's stock level by `delta` (negative to decrement).
 * Uses `stockLevel = stockLevel + ?` so concurrent adjustments can't clobber
 * each other (avoids the read-10-write-9 race). Bumps updatedAt so the change
 * propagates via delta sync.
 */
export async function adjustStock(productId: string, delta: number): Promise<void> {
    if (!delta) return;
    const d = await getDb();
    await d.execute(
        `UPDATE products SET stockLevel = stockLevel + ?, updatedAt = ? WHERE id = ?`,
        [delta, new Date().toISOString(), productId]
    );
}

/** Set an item's counted stock to an exact value. */
export async function setStockLevel(productId: string, stockLevel: number): Promise<void> {
    const d = await getDb();
    await d.execute(
        `UPDATE products SET stockLevel = ?, updatedAt = ? WHERE id = ?`,
        [stockLevel, new Date().toISOString(), productId]
    );
}

/** Batch-update only showInGoods + goodsSortOrder for many products. */
export async function batchUpdateGoodsMenu(changes: { id: string; showInGoods: boolean; goodsSortOrder: number; updatedAt: string }[]) {
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

/** 
 * Soft delete (deactivate) a product in SQLite
 */
export async function deleteProduct(id: string) {
    const d = await getDb();
    // Bump updatedAt so the soft-delete propagates to other tills via delta sync.
    await d.execute('UPDATE products SET isActive = 0, showInGoods = 0, goodsSortOrder = 0, updatedAt = ? WHERE id = ?',
        [new Date().toISOString(), id]);
}

export async function getProductTileIds(productId: string): Promise<string[]> {
    const d = await getDb();
    const rows: any[] = await d.select('SELECT id FROM pos_tiles WHERE productId = ?', [productId]);
    return rows.map((row) => row.id);
}

export async function getUnavailableProductTileIds(): Promise<string[]> {
    const d = await getDb();
    const rows: any[] = await d.select(
        `SELECT tile.id
         FROM pos_tiles tile
         JOIN products product ON product.id = tile.productId
         WHERE product.isActive = 0 OR product.showInPos = 0`,
    );
    return rows.map((row) => row.id);
}

/** 
 * Save or Update a POS Page
 */
export async function savePosPage(p: any) {
    const d = await getDb();
    await d.execute(
        `INSERT INTO pos_pages (id, name, position, color, updatedAt)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
            name=excluded.name,
            position=excluded.position,
            color=excluded.color,
            updatedAt=excluded.updatedAt`,
        [p.id, p.name, p.position, p.color, p.updatedAt]
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
        'DELETE FROM pos_tiles WHERE pageId = ? AND position = ? AND id <> ?',
        [t.pageId, t.position, t.id],
    );
    await d.execute(
        `INSERT INTO pos_tiles (id, pageId, productId, position, updatedAt)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
            pageId=excluded.pageId,
            productId=excluded.productId,
            position=excluded.position,
            updatedAt=excluded.updatedAt`,
        [t.id, t.pageId, t.productId, t.position, t.updatedAt]
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
    refundTransactions: number;
    avgTransactionValue: number;
    totalItemsSold: number;
}

export interface PaymentBreakdown {
    totalCash: number;
    totalCard: number;
    totalLoyalty: number;
    cashTxCount: number;
    cardTxCount: number;
    splitTxCount: number;
    loyaltyTxCount: number;
    totalAmount: number;
    unrecordedAmount: number;
    unrecordedTxCount: number;
}

function reportDateBounds(startDate: string, endDate: string): [string, string] {
    const start = new Date(`${startDate}T00:00:00`);
    const end = new Date(`${endDate}T00:00:00`);
    end.setDate(end.getDate() + 1);
    return [start.toISOString(), end.toISOString()];
}

export interface TopProduct {
    name: string;
    sku: string;
    qtySold: number;
    totalRevenue: number;
    avgPrice: number;
}

export interface TillReportOption {
    id: string;
    name: string;
}

export interface TillSalesSummary extends TillReportOption {
    netSales: number;
    grossSales: number;
    refunds: number;
    taxTotal: number;
    transactions: number;
    refundTransactions: number;
    itemsSold: number;
    cashTotal: number;
    cardTotal: number;
    loyaltyTotal: number;
}

export interface DailySalesPoint {
    date: string;
    netSales: number;
    transactions: number;
}

export interface BusinessSummary {
    grossSales: number;
    refunds: number;
    voids: number;
    voidTransactions: number;
    netSales: number;
    taxTotal: number;
    discountTotal: number;
    costTotal: number;
    grossProfit: number;
}

export interface EmployeeSalesSummary {
    employeeId: string;
    employeeName: string;
    netSales: number;
    grossSales: number;
    refunds: number;
    transactions: number;
    refundTransactions: number;
    avgTransaction: number;
}

/** Fetch sales overview for a date range, optionally filtered by till. */
export async function getSalesOverview(startDate: string, endDate: string, tillNumber?: string): Promise<SalesOverview> {
    const d = await getDb();
    const tillFilter = tillNumber ? ` AND o.tillNumber = ?` : '';
    const params: any[] = [...reportDateBounds(startDate, endDate)];
    if (tillNumber) params.push(tillNumber);

    const revRows: any[] = await d.select(
        `SELECT COALESCE(SUM(o.total), 0) as totalRevenue,
            COALESCE(SUM(CASE WHEN o.type != 'return' THEN o.total ELSE 0 END), 0) as saleRevenue,
            COALESCE(SUM(CASE WHEN o.type != 'return' THEN 1 ELSE 0 END), 0) as totalTransactions,
            COALESCE(SUM(CASE WHEN o.type = 'return' THEN 1 ELSE 0 END), 0) as refundTransactions
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
        `SELECT COALESCE(SUM(ol.quantity), 0) as totalItems
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
        avgTransactionValue: rev.totalTransactions > 0 ? Math.round((rev.saleRevenue || 0) / rev.totalTransactions) : 0,
        totalItemsSold: items.totalItems || 0,
    };
}

/** Fetch payment method breakdown for a date range, optionally filtered by till. */
export async function getPaymentBreakdown(startDate: string, endDate: string, tillNumber?: string): Promise<PaymentBreakdown> {
    const d = await getDb();
    const tillFilter = tillNumber ? ` AND o.tillNumber = ?` : '';
    const params: any[] = [...reportDateBounds(startDate, endDate)];
    if (tillNumber) params.push(tillNumber);

    const rows: any[] = await d.select(
        `SELECT
            COALESCE(SUM(p.totalCash), 0) as totalCash,
            COALESCE(SUM(p.totalCard), 0) as totalCard,
            COALESCE(SUM(p.totalLoyalty), 0) as totalLoyalty,
            COALESCE(SUM(CASE WHEN p.orderId IS NULL THEN o.total ELSE 0 END), 0) as unrecordedAmount,
            COALESCE(SUM(o.total), 0) as totalAmount,
            COALESCE(SUM(CASE WHEN p.hasCash = 1 AND p.hasCard = 0 THEN 1 ELSE 0 END), 0) as cashTxCount,
            COALESCE(SUM(CASE WHEN p.hasCard = 1 AND p.hasCash = 0 THEN 1 ELSE 0 END), 0) as cardTxCount,
            COALESCE(SUM(CASE WHEN p.hasCash = 1 AND p.hasCard = 1 THEN 1 ELSE 0 END), 0) as splitTxCount,
            COALESCE(SUM(CASE WHEN p.hasLoyalty = 1 THEN 1 ELSE 0 END), 0) as loyaltyTxCount,
            COALESCE(SUM(CASE WHEN p.orderId IS NULL THEN 1 ELSE 0 END), 0) as unrecordedTxCount
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
    const params: any[] = [...reportDateBounds(startDate, endDate)];
    if (tillNumber) params.push(tillNumber);
    params.push(limit);

    const rows: any[] = await d.select(
        `SELECT
            ol.productName as name,
            COALESCE(p.sku, '') as sku,
            SUM(ol.quantity) as qtySold,
            SUM(ol.lineTotal) as totalRevenue,
            ROUND(SUM(ol.lineTotal) / NULLIF(SUM(ol.quantity), 0)) as avgPrice
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

/** Aggregate daily summary for a specific date (or all dates if not specified). */
export async function aggregateDailySummary(date?: string): Promise<void> {
    const d = await getDb();
    const nowStr = new Date().toISOString();
    const dateFilter = date ? ` AND date(o.completedAt, 'localtime') = ?` : '';
    const params: any[] = date ? [date] : [];

    // Aggregate per-till and also an overall row (tillNumber = '')
    const rows: any[] = await d.select(
        `SELECT
            date(o.completedAt, 'localtime') as day,
            COALESCE(o.tillNumber, '') as till,
            COALESCE(SUM((SELECT SUM(CASE
                WHEN p.method = 'cash' THEN COALESCE(NULLIF(p.cashAmount, 0), p.amount)
                WHEN p.method = 'split' THEN p.cashAmount ELSE 0 END)
                FROM payments p WHERE p.orderId = o.id)), 0) as cashTotal,
            COALESCE(SUM((SELECT SUM(CASE
                WHEN p.method = 'card' THEN COALESCE(NULLIF(p.cardAmount, 0), p.amount)
                WHEN p.method = 'split' THEN p.cardAmount ELSE 0 END)
                FROM payments p WHERE p.orderId = o.id)), 0) as cardTotal,
            COALESCE(SUM(o.total), 0) as totalSales,
            COALESCE(SUM(CASE WHEN o.type != 'return' THEN 1 ELSE 0 END), 0) as txCount
         FROM orders o
         WHERE o.status IN ('completed','refunded','partially_refunded','voided')
           AND o.status != 'voided'
           AND NOT (o.type = 'return' AND COALESCE(o.notes, '') LIKE 'Void of receipt %')${dateFilter}
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
    await d.execute(
        `INSERT INTO till_report_markers (id, tillNumber, type, markerTime, periodStart, periodEnd, createdAt)
         VALUES (?, ?, 'period', ?, ?, ?, ?)`,
        [id, tillNumber, periodEnd, periodStart, periodEnd, new Date().toISOString()]
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

function friendlyTillName(id: string, name: string | null, minOrderNumber: number, index: number): string {
    if (name?.trim()) return name.trim();
    const sequence = Math.floor((minOrderNumber || 0) / 1_000_000);
    return sequence > 0 ? `Till ${sequence}` : `Till ${index + 1}`;
}

/** Return every till used by sales with a human-friendly display name. */
export async function getTillReportOptions(): Promise<TillReportOption[]> {
    const d = await getDb();
    const rows: any[] = await d.select(
        `SELECT o.tillNumber as id, MAX(r.name) as name, MIN(o.orderNumber) as minOrderNumber
         FROM orders o
         LEFT JOIN registers r ON r.id = o.tillNumber
         WHERE o.tillNumber IS NOT NULL AND o.tillNumber != ''
         GROUP BY o.tillNumber
         ORDER BY MIN(o.orderNumber), o.tillNumber`
    );
    const usedNames = new Map<string, number>();
    return rows.map((row, index) => {
        const baseName = friendlyTillName(row.id, row.name, row.minOrderNumber || 0, index);
        const occurrence = (usedNames.get(baseName) || 0) + 1;
        usedNames.set(baseName, occurrence);
        return {
            id: row.id,
            name: occurrence === 1 ? baseName : `${baseName} (${occurrence})`,
        };
    });
}

/** Aggregate sales by till without multiplying totals across payment/line joins. */
export async function getTillSalesSummaries(startDate: string, endDate: string): Promise<TillSalesSummary[]> {
    const d = await getDb();
    const options = await getTillReportOptions();
    const bounds = reportDateBounds(startDate, endDate);
    const rows: any[] = await d.select(
        `SELECT
            o.tillNumber as id,
            COALESCE(SUM(o.total), 0) as netSales,
            COALESCE(SUM(CASE WHEN o.type != 'return' THEN o.total ELSE 0 END), 0) as saleRevenue,
            COALESCE(SUM(CASE WHEN o.type != 'return' THEN o.total + o.discountAmount ELSE 0 END), 0) as grossSales,
            ABS(COALESCE(SUM(CASE WHEN o.total < 0 THEN o.total ELSE 0 END), 0)) as refunds,
            COALESCE(SUM(o.taxTotal), 0) as taxTotal,
            COALESCE(SUM(CASE WHEN o.type != 'return' THEN 1 ELSE 0 END), 0) as transactions,
            COALESCE(SUM(CASE WHEN o.type = 'return' THEN 1 ELSE 0 END), 0) as refundTransactions,
            COALESCE(SUM((SELECT SUM(ol.quantity) FROM order_lines ol WHERE ol.orderId = o.id)), 0) as itemsSold,
            COALESCE(SUM((SELECT SUM(CASE WHEN p.method = 'cash' THEN COALESCE(NULLIF(p.cashAmount, 0), p.amount) WHEN p.method = 'split' THEN p.cashAmount ELSE 0 END) FROM payments p WHERE p.orderId = o.id)), 0) as cashTotal,
            COALESCE(SUM((SELECT SUM(CASE WHEN p.method = 'card' THEN COALESCE(NULLIF(p.cardAmount, 0), p.amount) WHEN p.method = 'split' THEN p.cardAmount ELSE 0 END) FROM payments p WHERE p.orderId = o.id)), 0) as cardTotal,
            COALESCE(SUM((SELECT SUM(p.amount
                - CASE WHEN p.method = 'cash' THEN COALESCE(NULLIF(p.cashAmount, 0), p.amount) WHEN p.method = 'split' THEN p.cashAmount ELSE 0 END
                - CASE WHEN p.method = 'card' THEN COALESCE(NULLIF(p.cardAmount, 0), p.amount) WHEN p.method = 'split' THEN p.cardAmount ELSE 0 END
            ) FROM payments p WHERE p.orderId = o.id)), 0) as loyaltyTotal
         FROM orders o
         WHERE o.status IN ('completed','refunded','partially_refunded','voided')
           AND o.status != 'voided'
           AND NOT (o.type = 'return' AND COALESCE(o.notes, '') LIKE 'Void of receipt %')
           AND o.completedAt >= ? AND o.completedAt < ?
         GROUP BY o.tillNumber
         ORDER BY netSales DESC`,
        bounds
    );
    return rows.map((row, index) => ({
        id: row.id || '',
        name: options.find((option) => option.id === row.id)?.name || `Till ${index + 1}`,
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
    }));
}

/** Daily net-sales trend for the selected period and optional till. */
export async function getDailySalesTrend(startDate: string, endDate: string, tillNumber?: string): Promise<DailySalesPoint[]> {
    const d = await getDb();
    const tillFilter = tillNumber ? ` AND tillNumber = ?` : '';
    const params: any[] = [...reportDateBounds(startDate, endDate)];
    if (tillNumber) params.push(tillNumber);
    const rows: any[] = await d.select(
        `SELECT date(completedAt, 'localtime') as date, COALESCE(SUM(total), 0) as netSales,
            COALESCE(SUM(CASE WHEN type != 'return' THEN 1 ELSE 0 END), 0) as transactions
         FROM orders
         WHERE status IN ('completed','refunded','partially_refunded','voided')
           AND status != 'voided'
           AND NOT (type = 'return' AND COALESCE(notes, '') LIKE 'Void of receipt %')
           AND completedAt >= ? AND completedAt < ?${tillFilter}
         GROUP BY date(completedAt, 'localtime')
         ORDER BY date(completedAt, 'localtime')`,
        params
    );
    return rows.map(row => ({
        date: row.date,
        netSales: row.netSales || 0,
        transactions: row.transactions || 0,
    }));
}

export async function getBusinessSummary(startDate: string, endDate: string, tillNumber?: string): Promise<BusinessSummary> {
    const d = await getDb();
    const tillFilter = tillNumber ? ` AND o.tillNumber = ?` : '';
    const params: any[] = [...reportDateBounds(startDate, endDate)];
    if (tillNumber) params.push(tillNumber);
    const rows: any[] = await d.select(
        `SELECT
            COALESCE(SUM(CASE WHEN o.type != 'return' AND o.status != 'voided' THEN o.total + o.discountAmount ELSE 0 END), 0) as grossSales,
            ABS(COALESCE(SUM(CASE WHEN o.type = 'return' AND COALESCE(o.notes, '') NOT LIKE 'Void of receipt %' THEN o.total ELSE 0 END), 0)) as refunds,
            ABS(COALESCE(SUM(CASE WHEN o.type = 'return' AND COALESCE(o.notes, '') LIKE 'Void of receipt %' THEN o.total ELSE 0 END), 0)) as voids,
            COALESCE(SUM(CASE WHEN o.type = 'return' AND COALESCE(o.notes, '') LIKE 'Void of receipt %' THEN 1 ELSE 0 END), 0) as voidTransactions,
            COALESCE(SUM(CASE WHEN o.status != 'voided' AND NOT (o.type = 'return' AND COALESCE(o.notes, '') LIKE 'Void of receipt %') THEN o.total ELSE 0 END), 0) as netSales,
            COALESCE(SUM(CASE WHEN o.status != 'voided' AND NOT (o.type = 'return' AND COALESCE(o.notes, '') LIKE 'Void of receipt %') THEN o.taxTotal ELSE 0 END), 0) as taxTotal,
            COALESCE(SUM(CASE WHEN o.type != 'return' AND o.status != 'voided' THEN o.discountAmount ELSE 0 END), 0) as discountTotal,
            COALESCE(SUM(CASE WHEN o.status != 'voided' AND NOT (o.type = 'return' AND COALESCE(o.notes, '') LIKE 'Void of receipt %')
                THEN (SELECT SUM(ol.quantity * ol.costPrice) FROM order_lines ol WHERE ol.orderId = o.id) ELSE 0 END), 0) as costTotal
         FROM orders o
         WHERE o.status IN ('completed','refunded','partially_refunded','voided')
           AND o.completedAt >= ? AND o.completedAt < ?${tillFilter}`,
        params
    );
    const row = rows[0] || {};
    const netSales = row.netSales || 0;
    const costTotal = row.costTotal || 0;
    return {
        grossSales: row.grossSales || 0,
        refunds: row.refunds || 0,
        voids: row.voids || 0,
        voidTransactions: row.voidTransactions || 0,
        netSales,
        taxTotal: row.taxTotal || 0,
        discountTotal: row.discountTotal || 0,
        costTotal,
        grossProfit: netSales - (row.taxTotal || 0) - costTotal,
    };
}

export async function getEmployeeSalesSummaries(startDate: string, endDate: string, tillNumber?: string): Promise<EmployeeSalesSummary[]> {
    const d = await getDb();
    const tillFilter = tillNumber ? ` AND o.tillNumber = ?` : '';
    const params: any[] = [...reportDateBounds(startDate, endDate)];
    if (tillNumber) params.push(tillNumber);
    const rows: any[] = await d.select(
        `SELECT o.employeeId,
            COALESCE(MAX(e.name), 'Unknown employee') as employeeName,
            COALESCE(SUM(o.total), 0) as netSales,
            COALESCE(SUM(CASE WHEN o.type != 'return' THEN o.total ELSE 0 END), 0) as saleRevenue,
            COALESCE(SUM(CASE WHEN o.type != 'return' THEN o.total + o.discountAmount ELSE 0 END), 0) as grossSales,
            ABS(COALESCE(SUM(CASE WHEN o.total < 0 THEN o.total ELSE 0 END), 0)) as refunds,
            COALESCE(SUM(CASE WHEN o.type != 'return' THEN 1 ELSE 0 END), 0) as transactions,
            COALESCE(SUM(CASE WHEN o.type = 'return' THEN 1 ELSE 0 END), 0) as refundTransactions
         FROM orders o
         LEFT JOIN employees e ON e.id = o.employeeId
         WHERE o.status IN ('completed','refunded','partially_refunded','voided')
           AND o.status != 'voided'
           AND NOT (o.type = 'return' AND COALESCE(o.notes, '') LIKE 'Void of receipt %')
           AND o.completedAt >= ? AND o.completedAt < ?${tillFilter}
         GROUP BY o.employeeId
         ORDER BY netSales DESC`,
        params
    );
    return rows.map(row => ({
        employeeId: row.employeeId || '',
        employeeName: row.employeeName || 'Unknown employee',
        netSales: row.netSales || 0,
        grossSales: row.grossSales || 0,
        refunds: row.refunds || 0,
        transactions: row.transactions || 0,
        refundTransactions: row.refundTransactions || 0,
        avgTransaction: row.transactions > 0 ? Math.round((row.saleRevenue || 0) / row.transactions) : 0,
    }));
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
        `SELECT COALESCE(SUM(o.total), 0) as totalRevenue,
            COALESCE(SUM(CASE WHEN o.type != 'return' THEN o.total ELSE 0 END), 0) as saleRevenue,
            COALESCE(SUM(CASE WHEN o.type != 'return' THEN 1 ELSE 0 END), 0) as totalTransactions,
            COALESCE(SUM(CASE WHEN o.type = 'return' THEN 1 ELSE 0 END), 0) as refundTransactions
         FROM orders o
         WHERE o.status IN ('completed','refunded','partially_refunded','voided')
           AND o.status != 'voided'
           AND NOT (o.type = 'return' AND COALESCE(o.notes, '') LIKE 'Void of receipt %')
           AND o.tillNumber = ? AND o.completedAt >= ? AND o.completedAt < ?`,
        [tillNumber, startTime, endTime]
    );
    const itemRows: any[] = await d.select(
        `SELECT COALESCE(SUM(ol.quantity), 0) as totalItems
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
        avgTransactionValue: (rev.totalTransactions || 0) > 0 ? Math.round((rev.saleRevenue || 0) / rev.totalTransactions) : 0,
        totalItemsSold: items.totalItems || 0,
    };

    // Payment breakdown
    const bRows: any[] = await d.select(
        `SELECT
            COALESCE(SUM(p.totalCash), 0) as totalCash,
            COALESCE(SUM(p.totalCard), 0) as totalCard,
            COALESCE(SUM(p.totalLoyalty), 0) as totalLoyalty,
            COALESCE(SUM(CASE WHEN p.orderId IS NULL THEN o.total ELSE 0 END), 0) as unrecordedAmount,
            COALESCE(SUM(o.total), 0) as totalAmount,
            COALESCE(SUM(CASE WHEN p.hasCash = 1 AND p.hasCard = 0 THEN 1 ELSE 0 END), 0) as cashTxCount,
            COALESCE(SUM(CASE WHEN p.hasCard = 1 AND p.hasCash = 0 THEN 1 ELSE 0 END), 0) as cardTxCount,
            COALESCE(SUM(CASE WHEN p.hasCash = 1 AND p.hasCard = 1 THEN 1 ELSE 0 END), 0) as splitTxCount,
            COALESCE(SUM(CASE WHEN p.hasLoyalty = 1 THEN 1 ELSE 0 END), 0) as loyaltyTxCount,
            COALESCE(SUM(CASE WHEN p.orderId IS NULL THEN 1 ELSE 0 END), 0) as unrecordedTxCount
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
            ol.productName as name,
            COALESCE(pr.sku, '') as sku,
            SUM(ol.quantity) as qtySold,
            SUM(ol.lineTotal) as totalRevenue,
            ROUND(SUM(ol.lineTotal) / NULLIF(SUM(ol.quantity), 0)) as avgPrice
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
