/** Cross-client catalogue integrity: the server, not a cached count, decides. */
export const CATALOGUE_INTEGRITY_MIGRATION = 'catalogue_integrity_v3';
export const CATALOGUE_INTEGRITY_CODE = 'CATALOGUE_INTEGRITY';

// MariaDB SUM(integer) returns DECIMAL, which the Tauri SQL JSON decoder
// does not support. Counts must be explicitly integral on the native path.
export const catalogueCategoryUsageSql = `SELECT
    CAST(categoryId AS CHAR CHARACTER SET utf8mb4) AS categoryId,
    CAST(COUNT(*) AS SIGNED) AS total,
    CAST(SUM(CASE WHEN isActive = 1 THEN 1 ELSE 0 END) AS SIGNED) AS active
    FROM products WHERE categoryId IS NOT NULL AND categoryId <> '' GROUP BY categoryId`;

const lock = `UPDATE pos_catalogue_mutex SET id = id WHERE id = 1;`;
// Existing controlled restore authority is connection-bound. It may rebuild
// tables in stages; ordinary clients, including other tills, cannot use it.
const guarded = `NOT EXISTS (SELECT 1 FROM pos_restore_gate WHERE id = 1 AND isActive = 1
    AND BINARY ownerTillId = BINARY COALESCE(@lbj_pos_restore_bypass, ''))`;
const reject = (message: string) => `SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${CATALOGUE_INTEGRITY_CODE}: ${message}';`;
export interface CatalogueIntegrityColumn {
    tableName: string;
    columnName: string;
    charset: string;
    collation: string;
}

export const catalogueIntegrityCollationQuery = `SELECT TABLE_NAME AS tableName,
    COLUMN_NAME AS columnName, CHARACTER_SET_NAME AS charset, COLLATION_NAME AS collation
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
    AND ((TABLE_NAME IN ('categories', 'tax_rates') AND COLUMN_NAME = 'id')
      OR (TABLE_NAME = 'products' AND COLUMN_NAME IN ('categoryId', 'taxRateId'))
      OR (TABLE_NAME = 'settings' AND COLUMN_NAME = 'value')
      OR (TABLE_NAME = 'pos_catalogue_presence' AND COLUMN_NAME IN ('tableName', 'rowId'))
      OR (TABLE_NAME = 'tombstones' AND COLUMN_NAME IN ('table_name', 'row_id')))`;

export const catalogueIntegritySchemaSql = [
    `CREATE TABLE IF NOT EXISTS pos_catalogue_mutex (id TINYINT PRIMARY KEY) ENGINE=InnoDB`,
    `INSERT IGNORE INTO pos_catalogue_mutex (id) VALUES (1)`,
    // The nested AFTER DELETE tombstone trigger cannot locking-read its own
    // outer categories/tax_rates table (MariaDB 1442). This transactionally
    // maintained presence row lets standalone and nested tombstones share the
    // same current-read guard without a bypass session variable.
    `CREATE TABLE IF NOT EXISTS pos_catalogue_presence (
       tableName VARCHAR(32) NOT NULL, rowId VARCHAR(191) NOT NULL,
       isPresent TINYINT NOT NULL, PRIMARY KEY (tableName, rowId)
     ) ENGINE=InnoDB`,
    // A tax row trigger cannot locking-read its own table. This singleton is
    // the transactional authority for default uniqueness, including old clients.
    `CREATE TABLE IF NOT EXISTS pos_tax_default_registry (
       id TINYINT PRIMARY KEY, rowId VARCHAR(191) NULL,
       CONSTRAINT chk_pos_tax_default_singleton CHECK (id = 1)
     ) ENGINE=InnoDB`,
    `INSERT INTO pos_catalogue_presence (tableName, rowId, isPresent)
     SELECT 'categories', id, 1 FROM categories ON DUPLICATE KEY UPDATE isPresent = 1`,
    `INSERT INTO pos_catalogue_presence (tableName, rowId, isPresent)
     SELECT 'tax_rates', id, 1 FROM tax_rates ON DUPLICATE KEY UPDATE isPresent = 1`,
    `CREATE INDEX IF NOT EXISTS idx_products_category_integrity ON products(categoryId)`,
    `CREATE INDEX IF NOT EXISTS idx_products_tax_integrity ON products(taxRateId)`,
];

// Run only AFTER all v3 triggers have been installed. Until this row exists,
// every tax writer fails closed; an old trigger cannot race the initial seed.
// The scalar subquery deliberately rejects multiple existing defaults. Never
// choose one arbitrarily or silently change the historical catalogue.
export const catalogueTaxDefaultInitializationSql = `INSERT INTO pos_tax_default_registry (id, rowId)
    SELECT 1, (SELECT id FROM tax_rates WHERE isDefault = 1)
    WHERE NOT EXISTS (SELECT 1 FROM pos_tax_default_registry WHERE id = 1)`;

export function catalogueIntegrityTriggerSql(columns?: CatalogueIntegrityColumn[]): string[] {
    for (const column of columns || []) {
        if (!/^[a-zA-Z0-9_]+$/.test(column.charset) || !/^[a-zA-Z0-9_]+$/.test(column.collation)) {
            throw new Error(`Invalid catalogue collation: ${column.tableName}.${column.columnName}`);
        }
    }
    // Convert only the right-hand value to the indexed column's existing
    // collation. BINARY comparisons would lose legacy case-insensitive identity
    // semantics; converting the column instead would turn point locks into scans.
    const equal = (table: string, column: string, value: string) => {
        const metadata = columns?.find(row => row.tableName === table && row.columnName === column);
        if (columns && !metadata) throw new Error(`Missing catalogue collation: ${table}.${column}`);
        const charset = metadata?.charset || 'utf8mb4';
        const collation = metadata?.collation || 'utf8mb4_unicode_ci';
        if (!/^[a-zA-Z0-9_]+$/.test(charset) || !/^[a-zA-Z0-9_]+$/.test(collation)) {
            throw new Error(`Invalid catalogue collation: ${table}.${column}`);
        }
        return `${column} = CONVERT(${value} USING ${charset}) COLLATE ${collation}`;
    };
    const parent = (table: string, value: string, active = false) => `
        SET catalogueParent = NULL;
        SELECT id INTO catalogueParent FROM ${table} WHERE ${equal(table, 'id', value)}${active ? ' AND isActive = 1' : ''} LIMIT 1 FOR UPDATE;
        IF catalogueParent IS NULL THEN ${reject(active ? 'Choose an existing active default category' : `The selected ${table === 'categories' ? 'category' : 'tax rate'} no longer exists`)} END IF;`;
    const taxMetadata = columns?.find(row => row.tableName === 'tax_rates' && row.columnName === 'id');
    // Validate through the same identifier checks used by indexed comparisons.
    equal('tax_rates', 'id', 'NEW.id');
    const taxIdentity = (value: string) => `CONVERT(${value} USING ${taxMetadata?.charset || 'utf8mb4'}) COLLATE ${taxMetadata?.collation || 'utf8mb4_unicode_ci'}`;
    const sameTaxIdentity = (left: string, right: string) => `(${taxIdentity(left)} <=> ${taxIdentity(right)})`;
    const taxDeclarations = `DECLARE catalogueTaxDefault VARCHAR(191) DEFAULT NULL;
            DECLARE catalogueTaxRegistryReady TINYINT DEFAULT 0;`;
    const readTaxDefault = `SELECT 1, rowId INTO catalogueTaxRegistryReady, catalogueTaxDefault
              FROM pos_tax_default_registry WHERE id = 1 FOR UPDATE;
            IF catalogueTaxRegistryReady <> 1 THEN ${reject('Tax default guard is initializing; retry after database setup')} END IF;`;
    const setTaxDefault = `IF NEW.isDefault IS NULL OR NEW.isDefault NOT IN (0, 1) THEN
              ${reject('A tax default flag must be zero or one')}
            END IF;
            IF NEW.isDefault = 1 THEN
              IF catalogueTaxDefault IS NOT NULL AND NOT ${sameTaxIdentity('catalogueTaxDefault', 'NEW.id')} THEN
                ${reject('Another tax rate is already default; reload and save the complete tax selection')}
              END IF;
              UPDATE pos_tax_default_registry SET rowId = NEW.id WHERE id = 1;
            END IF;`;
    const clearTaxDefault = `IF ${sameTaxIdentity('catalogueTaxDefault', 'OLD.id')} THEN
              UPDATE pos_tax_default_registry SET rowId = NULL WHERE id = 1;
            END IF;`;
    const statements: string[] = [];
    for (const operation of ['INSERT', 'UPDATE'] as const) {
        const changed = (field: string) => operation === 'INSERT' ? 'TRUE' : `NOT (NEW.${field} <=> OLD.${field})`;
        statements.push(`CREATE OR REPLACE TRIGGER pos_catalogue_products_${operation.toLowerCase()}
          BEFORE ${operation} ON products FOR EACH ROW BEGIN
            DECLARE catalogueParent VARCHAR(191) DEFAULT NULL;
            IF (${changed('categoryId')} OR ${changed('taxRateId')}) AND ${guarded} THEN
              ${lock}
              IF ${changed('categoryId')} AND COALESCE(NEW.categoryId, '') <> '' THEN ${parent('categories', 'NEW.categoryId')} END IF;
              IF ${changed('taxRateId')} AND COALESCE(NEW.taxRateId, '') <> '' THEN ${parent('tax_rates', 'NEW.taxRateId')} END IF;
            END IF;
          END`);
        statements.push(`CREATE OR REPLACE TRIGGER pos_catalogue_default_${operation.toLowerCase()}
          BEFORE ${operation} ON settings FOR EACH ROW BEGIN
            DECLARE catalogueParent VARCHAR(191) DEFAULT NULL;
            IF NEW.\`key\` = 'default_product_category_id' AND ${guarded} THEN
              ${lock}
              IF COALESCE(NEW.value, '') <> '' THEN ${parent('categories', 'NEW.value', true)} END IF;
            END IF;
          END`);
        statements.push(`CREATE OR REPLACE TRIGGER pos_catalogue_tombstone_${operation.toLowerCase()}
          BEFORE ${operation} ON tombstones FOR EACH ROW BEGIN
            DECLARE cataloguePresent TINYINT DEFAULT 0;
            IF NEW.table_name IN ('categories', 'tax_rates') AND ${guarded} THEN
              ${lock}
              SELECT isPresent INTO cataloguePresent FROM pos_catalogue_presence
                WHERE ${equal('pos_catalogue_presence', 'tableName', 'NEW.table_name')} AND ${equal('pos_catalogue_presence', 'rowId', 'NEW.row_id')} LIMIT 1 FOR UPDATE;
              IF cataloguePresent = 1 THEN ${reject('Cannot publish a deletion while the catalogue row still exists')} END IF;
            END IF;
          END`);
    }
    statements.push(`CREATE OR REPLACE TRIGGER pos_catalogue_default_delete
      BEFORE DELETE ON settings FOR EACH ROW BEGIN
        IF OLD.\`key\` = 'default_product_category_id' THEN ${lock} END IF;
      END`);
    for (const table of ['categories', 'tax_rates'] as const) {
        const field = table === 'categories' ? 'categoryId' : 'taxRateId';
        const label = table === 'categories' ? 'category' : 'tax rate';
        const defaultCheck = table === 'categories' ? `
            SET catalogueReference = NULL;
            SELECT \`key\` INTO catalogueReference FROM settings
              WHERE \`key\` = 'default_product_category_id' AND ${equal('settings', 'value', 'OLD.id')} LIMIT 1 FOR UPDATE;
            IF catalogueReference IS NOT NULL THEN ${reject('Choose another default category before deleting or deactivating this one')} END IF;`
            : `IF OLD.isDefault = 1 THEN ${reject('Choose another default tax rate before deleting this one')} END IF;`;
        statements.push(`CREATE OR REPLACE TRIGGER pos_catalogue_${table}_delete
          BEFORE DELETE ON ${table} FOR EACH ROW BEGIN
            DECLARE catalogueReference VARCHAR(191) DEFAULT NULL;
            ${table === 'tax_rates' ? taxDeclarations : ''}
            ${lock}
            ${table === 'tax_rates' ? readTaxDefault : ''}
            IF ${guarded} THEN
              SELECT id INTO catalogueReference FROM products WHERE ${equal('products', field, 'OLD.id')} LIMIT 1 FOR UPDATE;
              IF catalogueReference IS NOT NULL THEN ${reject(`This ${label} is used by items. Move all active and deactivated items first`)} END IF;
              ${defaultCheck}
            END IF;
            ${table === 'tax_rates' ? clearTaxDefault : ''}
            INSERT INTO pos_catalogue_presence (tableName, rowId, isPresent) VALUES ('${table}', OLD.id, 0)
              ON DUPLICATE KEY UPDATE isPresent = 0;
          END`);
        statements.push(`CREATE OR REPLACE TRIGGER pos_catalogue_${table}_insert
          BEFORE INSERT ON ${table} FOR EACH ROW BEGIN
            DECLARE catalogueDeleted VARCHAR(191) DEFAULT NULL;
            ${table === 'tax_rates' ? taxDeclarations : ''}
            ${lock}
            ${table === 'tax_rates' ? `${readTaxDefault}\n${setTaxDefault}` : ''}
            IF ${guarded} THEN
              SELECT id INTO catalogueDeleted FROM tombstones
                WHERE ${equal('tombstones', 'table_name', `'${table}'`)} AND ${equal('tombstones', 'row_id', 'NEW.id')} LIMIT 1 FOR UPDATE;
              IF catalogueDeleted IS NOT NULL THEN ${reject(`This ${label} was deleted. Create a new record instead`)} END IF;
            END IF;
            INSERT INTO pos_catalogue_presence (tableName, rowId, isPresent) VALUES ('${table}', NEW.id, 1)
              ON DUPLICATE KEY UPDATE isPresent = 1;
          END`);
        statements.push(`CREATE OR REPLACE TRIGGER pos_catalogue_${table}_update
          BEFORE UPDATE ON ${table} FOR EACH ROW BEGIN
            DECLARE catalogueReference VARCHAR(191) DEFAULT NULL;
            ${table === 'tax_rates' ? taxDeclarations : ''}
            ${lock}
            IF NOT (NEW.id <=> OLD.id) THEN ${reject('Catalogue identities cannot be changed')} END IF;
            ${table === 'categories' ? `IF NEW.isActive = 0 AND ${guarded} THEN ${defaultCheck} END IF;`
                : `${readTaxDefault}\n${setTaxDefault}
                   IF NEW.isDefault = 0 THEN ${clearTaxDefault} END IF;`}
          END`);
    }
    return statements;
}

export function catalogueDeletionError(error: unknown, fallback: string): string {
    const message = String(error);
    const index = message.indexOf(`${CATALOGUE_INTEGRITY_CODE}: `);
    return index < 0 ? fallback : message.slice(index + CATALOGUE_INTEGRITY_CODE.length + 2).replace(/["'}]+$/, '');
}

/** Shared safety deletes are never optimistic or independently queued. */
export async function removeCatalogueWithAuthority(options: {
    shared: boolean;
    removeOnServer: () => Promise<void>;
    removeLocally: () => Promise<void>;
    mirrorFailed: (error: unknown) => void;
}): Promise<void> {
    if (options.shared) await options.removeOnServer();
    try { await options.removeLocally(); }
    catch (error) {
        if (!options.shared) throw error;
        // Server deletion is already committed. Do not claim it failed or
        // enqueue a second independent delete; ordinary sync repairs the cache.
        options.mirrorFailed(error);
    }
}
