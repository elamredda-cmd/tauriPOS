-- L&Bj POS live SQLite schema
-- Generated read-only from ~/Library/Application Support/com.elamreda.tauri-app/pos.db
-- Contains structure only; no customer, staff, transaction, credential, or shop data.
-- This live database predates the foreign keys now declared for new databases.
CREATE TABLE products (id TEXT PRIMARY KEY, categoryId TEXT, taxRateId TEXT, name TEXT NOT NULL, sku TEXT, barcode TEXT, scalePlu TEXT, price INTEGER NOT NULL, costPrice INTEGER DEFAULT 0, stockLevel INTEGER DEFAULT 0, trackStock INTEGER DEFAULT 0, allowPriceOverride INTEGER DEFAULT 0, isWeighable INTEGER DEFAULT 0, showInGoods INTEGER DEFAULT 0, goodsSortOrder INTEGER DEFAULT 0, color TEXT, image TEXT, isActive INTEGER DEFAULT 1, createdAt TEXT, updatedAt TEXT, isAgeRestricted INTEGER DEFAULT 0);
CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT, sortOrder INTEGER DEFAULT 0, isActive INTEGER DEFAULT 1, createdAt TEXT, updatedAt TEXT);
CREATE TABLE pos_pages (id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER DEFAULT 0, color TEXT, updatedAt TEXT);
CREATE TABLE _offline_queue (id TEXT PRIMARY KEY, table_name TEXT, operation TEXT, data TEXT, id_key TEXT, created_at TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, last_error TEXT DEFAULT '', next_attempt_at TEXT DEFAULT '');
CREATE TABLE _sync_conflicts (id TEXT PRIMARY KEY, table_name TEXT NOT NULL, operation TEXT NOT NULL, data TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE app_identity (id TEXT PRIMARY KEY, shopId TEXT NOT NULL, shopName TEXT, licenseId TEXT, createdAt TEXT, updatedAt TEXT, identitySignature TEXT);
CREATE TABLE pos_tiles (id TEXT PRIMARY KEY, pageId TEXT NOT NULL, productId TEXT NOT NULL, position INTEGER DEFAULT 0, updatedAt TEXT);
CREATE TABLE tax_rates (id TEXT PRIMARY KEY, name TEXT NOT NULL, rate REAL NOT NULL, isDefault INTEGER DEFAULT 0, createdAt TEXT, updatedAt TEXT);
CREATE TABLE customers (id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT, email TEXT, postcode TEXT, loyaltyCode TEXT, loyaltyPoints INTEGER DEFAULT 0, notes TEXT, createdAt TEXT, updatedAt TEXT);
CREATE TABLE orders (id TEXT PRIMARY KEY, shiftId TEXT, customerId TEXT, employeeId TEXT, orderNumber INTEGER, receiptKey TEXT UNIQUE, type TEXT, status TEXT, originalOrderId TEXT, subtotal INTEGER DEFAULT 0, discountId TEXT, discountAmount INTEGER DEFAULT 0, taxTotal INTEGER DEFAULT 0, total INTEGER DEFAULT 0, tillNumber TEXT DEFAULT '', paymentMethod TEXT DEFAULT '', amountTendered INTEGER DEFAULT 0, notes TEXT, createdAt TEXT, updatedAt TEXT, completedAt TEXT);
CREATE TABLE order_lines (id TEXT PRIMARY KEY, orderId TEXT, productId TEXT, productName TEXT, quantity INTEGER DEFAULT 0, unitPrice INTEGER DEFAULT 0, costPrice INTEGER DEFAULT 0, discountId TEXT, discountAmount INTEGER DEFAULT 0, taxRate REAL DEFAULT 0, taxAmount INTEGER DEFAULT 0, lineTotal INTEGER DEFAULT 0, isPriceOverride INTEGER DEFAULT 0, originalPrice INTEGER DEFAULT 0, notes TEXT, updatedAt TEXT);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updatedAt TEXT);
CREATE TABLE employees (id TEXT PRIMARY KEY, storeId TEXT, name TEXT NOT NULL, pin TEXT, pinHash TEXT, role TEXT, email TEXT, isActive INTEGER DEFAULT 1, createdAt TEXT, updatedAt TEXT);
CREATE TABLE registers (id TEXT PRIMARY KEY, storeId TEXT, name TEXT NOT NULL, isActive INTEGER DEFAULT 1, createdAt TEXT, updatedAt TEXT);
CREATE TABLE suppliers (id TEXT PRIMARY KEY, name TEXT NOT NULL, contactName TEXT, phone TEXT, email TEXT, address TEXT, notes TEXT, createdAt TEXT, updatedAt TEXT);
CREATE TABLE discounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT, value REAL, isActive INTEGER DEFAULT 1, createdAt TEXT, kind TEXT DEFAULT 'manual_percent', autoApply INTEGER DEFAULT 0, groupId TEXT, minQuantity INTEGER DEFAULT 1, secondPrice INTEGER DEFAULT 0, bundleQuantity INTEGER DEFAULT 0, bundlePrice INTEGER DEFAULT 0, maxApplications INTEGER, startAt TEXT, endAt TEXT, priority INTEGER DEFAULT 0, updatedAt TEXT);
CREATE TABLE promo_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, startAt TEXT, endAt TEXT, isActive INTEGER DEFAULT 1, createdAt TEXT, updatedAt TEXT);
CREATE TABLE promo_group_items (id TEXT PRIMARY KEY, groupId TEXT NOT NULL, productId TEXT NOT NULL, updatedAt TEXT);
CREATE TABLE shifts (id TEXT PRIMARY KEY, registerId TEXT, employeeId TEXT, closedByEmployeeId TEXT, openedAt TEXT, closedAt TEXT, openingFloat INTEGER, expectedCash INTEGER, actualCash INTEGER, cashDifference INTEGER, expectedCard INTEGER, actualCard INTEGER, cardDifference INTEGER, status TEXT, notes TEXT, updatedAt TEXT);
CREATE TABLE cash_movements (id TEXT PRIMARY KEY, shiftId TEXT, employeeId TEXT, amount INTEGER, reason TEXT, createdAt TEXT, updatedAt TEXT);
CREATE TABLE loyalty_logs (id TEXT PRIMARY KEY, customerId TEXT, orderId TEXT, pointsChange INTEGER, reason TEXT, createdAt TEXT, updatedAt TEXT);
CREATE TABLE audit_logs (id TEXT PRIMARY KEY, employeeId TEXT, action TEXT, entityType TEXT, entityId TEXT, oldData TEXT, newData TEXT, createdAt TEXT, updatedAt TEXT);
CREATE TABLE payments (id TEXT PRIMARY KEY, orderId TEXT, method TEXT, amount INTEGER DEFAULT 0, cashAmount INTEGER DEFAULT 0, cardAmount INTEGER DEFAULT 0, reference TEXT, changeGiven INTEGER DEFAULT 0, createdAt TEXT, updatedAt TEXT, loyaltyAmount INTEGER DEFAULT 0, accountAmount INTEGER DEFAULT 0);
CREATE TABLE daily_sales_summary (date TEXT NOT NULL, tillNumber TEXT NOT NULL DEFAULT '', cashTotal INTEGER DEFAULT 0, cardTotal INTEGER DEFAULT 0, totalSales INTEGER DEFAULT 0, transactionCount INTEGER DEFAULT 0, updatedAt TEXT, accountTotal INTEGER DEFAULT 0, accountRepaymentsCash INTEGER DEFAULT 0, accountRepaymentsCard INTEGER DEFAULT 0, PRIMARY KEY(date, tillNumber));
CREATE TABLE till_report_markers (id TEXT PRIMARY KEY, tillNumber TEXT NOT NULL, type TEXT NOT NULL, markerTime TEXT NOT NULL, periodStart TEXT NOT NULL, periodEnd TEXT NOT NULL, employeeId TEXT, reportText TEXT, reportTotal INTEGER DEFAULT 0, createdAt TEXT, updatedAt TEXT);
CREATE TABLE manager_approvals (id TEXT PRIMARY KEY, requestedByEmployeeId TEXT, approvedByEmployeeId TEXT, action TEXT NOT NULL, entityType TEXT, entityId TEXT, notes TEXT, createdAt TEXT, updatedAt TEXT);
CREATE TABLE stock_receipts (id TEXT PRIMARY KEY, supplierId TEXT, employeeId TEXT, reference TEXT, notes TEXT, totalCost INTEGER DEFAULT 0, status TEXT DEFAULT 'received', createdAt TEXT, updatedAt TEXT);
CREATE TABLE stock_receipt_lines (id TEXT PRIMARY KEY, receiptId TEXT NOT NULL, productId TEXT NOT NULL, quantity INTEGER DEFAULT 0, unitCost INTEGER DEFAULT 0, createdAt TEXT, updatedAt TEXT);
CREATE TABLE product_suppliers (id TEXT PRIMARY KEY, productId TEXT, supplierId TEXT, supplierSku TEXT, costPrice INTEGER DEFAULT 0, isPreferred INTEGER DEFAULT 0, updatedAt TEXT);
CREATE TABLE inventory_logs (id TEXT PRIMARY KEY, productId TEXT, quantityChange INTEGER DEFAULT 0, type TEXT, referenceId TEXT, employeeId TEXT, notes TEXT, createdAt TEXT, updatedAt TEXT);
CREATE TABLE tombstones (id TEXT PRIMARY KEY, table_name TEXT NOT NULL, row_id TEXT NOT NULL, deletedAt TEXT, updatedAt TEXT);
CREATE INDEX idx_products_barcode ON products(barcode);
CREATE INDEX idx_products_sku ON products(sku);
CREATE INDEX idx_products_category ON products(categoryId);
CREATE INDEX idx_products_active ON products(isActive);
CREATE INDEX idx_tiles_page ON pos_tiles(pageId);
CREATE INDEX idx_order_lines_order ON order_lines(orderId);
CREATE INDEX idx_payments_order ON payments(orderId);
CREATE INDEX idx_inv_logs_product ON inventory_logs(productId);
CREATE INDEX idx_promo_group_items_group ON promo_group_items(groupId);
CREATE INDEX idx_promo_group_items_product ON promo_group_items(productId);
CREATE INDEX idx_orders_completed ON orders(completedAt);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_payments_method ON payments(method);
CREATE INDEX idx_daily_summary_date ON daily_sales_summary(date);
CREATE INDEX idx_till_markers_till ON till_report_markers(tillNumber);
CREATE INDEX idx_manager_approvals_action ON manager_approvals(action);
CREATE INDEX idx_stock_receipts_created ON stock_receipts(createdAt);
CREATE INDEX idx_stock_receipt_lines_receipt ON stock_receipt_lines(receiptId);
CREATE INDEX idx_orders_till ON orders(tillNumber);
CREATE UNIQUE INDEX uq_products_barcode ON products(barcode) WHERE barcode IS NOT NULL AND barcode <> '';
CREATE UNIQUE INDEX uq_products_scale_plu ON products(scalePlu) WHERE scalePlu IS NOT NULL AND scalePlu <> '';
CREATE UNIQUE INDEX uq_products_sku ON products(sku) WHERE sku IS NOT NULL AND sku <> '';
CREATE UNIQUE INDEX uq_promo_group_product ON promo_group_items(groupId, productId);
CREATE UNIQUE INDEX uq_open_shift_register ON shifts(registerId) WHERE status = 'open';
CREATE UNIQUE INDEX idx_orders_receipt_key ON orders(receiptKey);
CREATE INDEX idx_products_scale_plu ON products(scalePlu);
CREATE INDEX idx_products_barcode_active ON products(barcode, isActive);
CREATE INDEX idx_products_updated_at ON products(updatedAt);
CREATE INDEX idx_products_scale_plu_active ON products(scalePlu, isActive);
CREATE INDEX idx_categories_updated_at ON categories(updatedAt);
CREATE INDEX idx_pos_pages_updated_at ON pos_pages(updatedAt);
CREATE INDEX idx_pos_tiles_updated_at ON pos_tiles(updatedAt);
CREATE INDEX idx_tax_rates_updated_at ON tax_rates(updatedAt);
CREATE INDEX idx_discounts_updated_at ON discounts(updatedAt);
CREATE INDEX idx_promo_groups_updated_at ON promo_groups(updatedAt);
CREATE INDEX idx_promo_group_items_updated_at ON promo_group_items(updatedAt);
CREATE INDEX idx_employees_updated_at ON employees(updatedAt);
CREATE INDEX idx_settings_updated_at ON settings(updatedAt);
CREATE INDEX idx_customers_updated_at ON customers(updatedAt);
CREATE INDEX idx_registers_updated_at ON registers(updatedAt);
CREATE INDEX idx_suppliers_updated_at ON suppliers(updatedAt);
CREATE INDEX idx_product_suppliers_updated_at ON product_suppliers(updatedAt);
CREATE INDEX idx_inventory_logs_updated_at ON inventory_logs(updatedAt);
CREATE INDEX idx_orders_updated_at ON orders(updatedAt);
CREATE INDEX idx_order_lines_updated_at ON order_lines(updatedAt);
CREATE INDEX idx_payments_updated_at ON payments(updatedAt);
CREATE INDEX idx_loyalty_logs_updated_at ON loyalty_logs(updatedAt);
CREATE INDEX idx_audit_logs_updated_at ON audit_logs(updatedAt);
CREATE INDEX idx_shifts_updated_at ON shifts(updatedAt);
CREATE INDEX idx_cash_movements_updated_at ON cash_movements(updatedAt);
CREATE INDEX idx_till_report_markers_updated_at ON till_report_markers(updatedAt);
CREATE INDEX idx_manager_approvals_updated_at ON manager_approvals(updatedAt);
CREATE INDEX idx_stock_receipts_updated_at ON stock_receipts(updatedAt);
CREATE INDEX idx_stock_receipt_lines_updated_at ON stock_receipt_lines(updatedAt);
CREATE INDEX idx_products_active_name_nocase ON products(isActive, name COLLATE NOCASE, id);
CREATE INDEX idx_products_category_active_name_nocase ON products(categoryId, isActive, name COLLATE NOCASE, id);
CREATE INDEX idx_products_goods_active_name_nocase ON products(showInGoods, isActive, name COLLATE NOCASE, id);
CREATE INDEX idx_tiles_product ON pos_tiles(productId);
CREATE VIRTUAL TABLE product_search_fts
            USING fts5(id UNINDEXED, name, sku, barcode, scalePlu, tokenize = 'unicode61')
/* product_search_fts(id,name,sku,barcode,scalePlu) */;
CREATE TABLE IF NOT EXISTS 'product_search_fts_data'(id INTEGER PRIMARY KEY, block BLOB);
CREATE TABLE IF NOT EXISTS 'product_search_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS 'product_search_fts_content'(id INTEGER PRIMARY KEY, c0, c1, c2, c3, c4);
CREATE TABLE IF NOT EXISTS 'product_search_fts_docsize'(id INTEGER PRIMARY KEY, sz BLOB);
CREATE TABLE IF NOT EXISTS 'product_search_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID;
CREATE TRIGGER products_search_ai AFTER INSERT ON products BEGIN
                INSERT INTO product_search_fts(rowid, id, name, sku, barcode, scalePlu)
                VALUES (new.rowid, new.id, new.name, new.sku, new.barcode, new.scalePlu);
            END;
CREATE TRIGGER products_search_ad AFTER DELETE ON products BEGIN
                DELETE FROM product_search_fts WHERE rowid = old.rowid;
            END;
CREATE TRIGGER products_search_au AFTER UPDATE ON products BEGIN
                DELETE FROM product_search_fts WHERE rowid = old.rowid;
                INSERT INTO product_search_fts(rowid, id, name, sku, barcode, scalePlu)
                VALUES (new.rowid, new.id, new.name, new.sku, new.barcode, new.scalePlu);
            END;
CREATE INDEX idx_orders_number ON orders(orderNumber);
CREATE INDEX idx_orders_history_sort ON orders(
        COALESCE(NULLIF(completedAt, ''), NULLIF(createdAt, ''), NULLIF(updatedAt, '')) DESC,
        orderNumber DESC
    );
CREATE INDEX idx_orders_status_history_sort ON orders(
        status,
        COALESCE(NULLIF(completedAt, ''), NULLIF(createdAt, ''), NULLIF(updatedAt, '')) DESC,
        orderNumber DESC
    );
CREATE INDEX idx_offline_queue_due ON _offline_queue(next_attempt_at, created_at);
CREATE INDEX idx_products_tax_rate ON products(taxRateId);
CREATE INDEX idx_product_suppliers_supplier ON product_suppliers(supplierId);
CREATE INDEX idx_orders_employee ON orders(employeeId);
CREATE INDEX idx_shifts_employee ON shifts(employeeId);
CREATE INDEX idx_shifts_closed_by_employee ON shifts(closedByEmployeeId);
CREATE INDEX idx_orders_shift_status ON orders(shiftId, status);
CREATE INDEX idx_cash_movements_shift ON cash_movements(shiftId);
CREATE INDEX idx_shifts_opened_at ON shifts(openedAt DESC, id);
CREATE INDEX idx_orders_customer ON orders(customerId);
CREATE INDEX idx_loyalty_logs_customer ON loyalty_logs(customerId, createdAt DESC);
CREATE INDEX idx_manager_approvals_created ON manager_approvals(createdAt DESC, id);
CREATE INDEX idx_audit_logs_created ON audit_logs(createdAt DESC, id);
CREATE INDEX idx_audit_logs_action_created ON audit_logs(action, createdAt DESC, id);
CREATE INDEX idx_audit_logs_entity_created ON audit_logs(entityType, createdAt DESC, id);
CREATE TABLE product_images (
            id TEXT PRIMARY KEY,
            image TEXT NOT NULL DEFAULT '',
            updatedAt TEXT NOT NULL
        );
CREATE INDEX idx_product_images_updated_at ON product_images(updatedAt);
CREATE TABLE payment_terminal_attempts (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            terminalKey TEXT NOT NULL,
            clientTransactionId TEXT DEFAULT '',
            amount INTEGER NOT NULL,
            currency TEXT NOT NULL,
            status TEXT NOT NULL,
            saleBundle TEXT NOT NULL,
            error TEXT DEFAULT '',
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL
        );
CREATE INDEX idx_payment_terminal_attempt_status ON payment_terminal_attempts(status, updatedAt);
CREATE INDEX idx_customers_name_nocase ON customers(name COLLATE NOCASE, id);
CREATE UNIQUE INDEX uq_customers_loyalty_code ON customers(loyaltyCode COLLATE NOCASE) WHERE loyaltyCode IS NOT NULL AND TRIM(loyaltyCode) <> '';
CREATE TABLE customer_accounts (
            id TEXT PRIMARY KEY,
            customerId TEXT NOT NULL UNIQUE,
            isEnabled INTEGER NOT NULL DEFAULT 0,
            creditLimitPence INTEGER NOT NULL DEFAULT 0,
            balancePence INTEGER NOT NULL DEFAULT 0,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL
        );
CREATE TABLE customer_account_entries (
            id TEXT PRIMARY KEY,
            accountId TEXT NOT NULL,
            customerId TEXT NOT NULL,
            orderId TEXT NOT NULL DEFAULT '',
            entryType TEXT NOT NULL,
            amountPence INTEGER NOT NULL,
            paymentMethod TEXT NOT NULL DEFAULT '',
            reference TEXT NOT NULL DEFAULT '',
            description TEXT NOT NULL DEFAULT '',
            receiptNumber INTEGER NOT NULL DEFAULT 0,
            receiptKey TEXT NOT NULL DEFAULT '',
            employeeId TEXT NOT NULL DEFAULT '',
            tillNumber TEXT NOT NULL DEFAULT '',
            shiftId TEXT NOT NULL DEFAULT '',
            idempotencyKey TEXT NOT NULL UNIQUE,
            reversesEntryId TEXT NOT NULL DEFAULT '',
            balanceAfterPence INTEGER NOT NULL DEFAULT 0,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL
        );
CREATE INDEX idx_customer_accounts_customer ON customer_accounts(customerId);
CREATE INDEX idx_customer_accounts_balance ON customer_accounts(balancePence);
CREATE INDEX idx_customer_account_entries_customer_created ON customer_account_entries(customerId, createdAt DESC, id DESC);
CREATE INDEX idx_customer_account_entries_shift_created ON customer_account_entries(shiftId, createdAt);
CREATE INDEX idx_customer_account_entries_till_created ON customer_account_entries(tillNumber, createdAt);
CREATE INDEX idx_customer_account_entries_order ON customer_account_entries(orderId);
CREATE INDEX idx_customer_account_entries_reverses ON customer_account_entries(reversesEntryId);
CREATE INDEX idx_customer_accounts_updated_at ON customer_accounts(updatedAt);
CREATE INDEX idx_customer_account_entries_updated_at ON customer_account_entries(updatedAt);
