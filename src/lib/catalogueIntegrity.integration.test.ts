import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { catalogueCategoryUsageSql, catalogueIntegrityCollationQuery, catalogueIntegritySchemaSql, catalogueIntegrityTriggerSql, catalogueTaxDefaultInitializationSql } from './catalogueIntegrity';

// Opt-in, socket-only disposable server; never read configured shop credentials.
const socket = process.env.POS_TEST_CATALOGUE_SOCKET;
let database = '';
const args = ['--no-defaults', `--socket=${socket}`, '-uroot', '--batch', '--raw', '--unbuffered', '--delimiter=//'];
let serial = 0;
const id = () => `fixture_${Date.now()}_${++serial}`;
const run = (sql: string) => execFileSync('mariadb', [...args, database, '-e', `${sql}//`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
const runAsync = (sql: string) => promisify(execFile)('mariadb', [...args, database, '-e', `${sql}//`], { timeout: 15000 });

function lockedSession(sql: string): Promise<(finishSql?: string) => Promise<void>> {
    const child = spawn('mariadb', [...args, database]);
    let error = '';
    child.stderr.on('data', value => { error += value; });
    const completed = new Promise<void>((resolve, reject) => child.on('exit', code => code === 0 ? resolve() : reject(new Error(error))));
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('Test session did not acquire its lock')); }, 10000);
        child.stdout.on('data', value => {
            if (!String(value).includes('LOCK_READY')) return;
            clearTimeout(timer);
            resolve(async (finishSql = '') => { child.stdin.end(`${finishSql ? `${finishSql}//\n` : ''}COMMIT//\n`); await completed; });
        });
        child.on('error', reject);
        child.stdin.write(`START TRANSACTION//\n${sql}//\nSELECT 'LOCK_READY'//\n`);
    });
}

async function expectBlockedThenRejected(sql: string, release: () => Promise<void>, message: string) {
    let settled = false;
    const result = runAsync(sql).then(
        () => { settled = true; return null; },
        error => { settled = true; return error as Error; },
    );
    try {
        await new Promise(resolve => setTimeout(resolve, 60));
        expect(settled, 'competing write must wait for the first transaction').toBe(false);
    } finally { await release(); }
    expect(String(await result)).toContain(message);
}

const isolated = socket ? describe : describe.skip;
isolated.each([false, true])('catalogue guards on isolated MariaDB (legacy collations: %s)', legacy => {
    beforeAll(() => {
        if (!socket?.startsWith('/tmp/pos-')) throw new Error('Use the explicitly supplied disposable test socket');
        database = `pos_test_catalogue_${process.pid}_${legacy ? 'legacy' : 'current'}`;
        execFileSync('mariadb', [...args, '-e', `CREATE DATABASE ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci//`]);
        const core = legacy ? ' COLLATE utf8mb4_general_ci' : '';
        run(`CREATE TABLE IF NOT EXISTS categories (id VARCHAR(36)${core} PRIMARY KEY, isActive INT DEFAULT 1) ENGINE=InnoDB`);
        run(`CREATE TABLE IF NOT EXISTS tax_rates (id VARCHAR(36)${core} PRIMARY KEY, isDefault INT DEFAULT 0) ENGINE=InnoDB`);
        run(`CREATE TABLE IF NOT EXISTS products (id VARCHAR(36) PRIMARY KEY, categoryId VARCHAR(36)${core}, taxRateId VARCHAR(36)${core}, isActive INT DEFAULT 1) ENGINE=InnoDB`);
        run(`CREATE TABLE IF NOT EXISTS settings (\`key\` VARCHAR(191) PRIMARY KEY, value TEXT) ENGINE=InnoDB`);
        run(`CREATE TABLE IF NOT EXISTS tombstones (id VARCHAR(191) PRIMARY KEY, table_name VARCHAR(32)${core}, row_id VARCHAR(36)${core}, deletedAt TEXT, updatedAt TEXT) ENGINE=InnoDB`);
        run(`CREATE TABLE IF NOT EXISTS pos_restore_gate (id INT PRIMARY KEY, ownerTillId VARCHAR(191), isActive INT) ENGINE=InnoDB`);
        run(`INSERT IGNORE INTO pos_restore_gate VALUES (1, '', 0)`);
        for (const table of ['categories', 'tax_rates']) run(`CREATE OR REPLACE TRIGGER pos_delete_${table} AFTER DELETE ON ${table} FOR EACH ROW
            INSERT INTO tombstones (id, table_name, row_id) VALUES (CONCAT('${table}:', OLD.id), '${table}', OLD.id)
            ON DUPLICATE KEY UPDATE row_id = VALUES(row_id)`);
        for (const sql of catalogueIntegritySchemaSql) run(sql);
        const columns = run(catalogueIntegrityCollationQuery).trim().split('\n').slice(1).map(line => {
            const [tableName, columnName, charset, collation] = line.split('\t');
            return { tableName, columnName, charset, collation };
        });
        for (const sql of catalogueIntegrityTriggerSql(columns)) run(sql);
        run(catalogueTaxDefaultInitializationSql);
    });
    afterAll(() => {
        // Generated databases on this socket-only scratch server, never app data.
        if (database) execFileSync('mariadb', [...args, '-e', `DROP DATABASE ${database}//`]);
    });

    it('preserves case-insensitive legacy identities across differently collated columns', () => {
        const category = id();
        run(`INSERT INTO categories (id) VALUES ('${category}')`);
        run(`INSERT INTO products (id, categoryId) VALUES ('${id()}', '${category.toUpperCase()}')`);
        expect(() => run(`DELETE FROM categories WHERE id = '${category}'`)).toThrow('used by items');
    });

    it('reports exact integral active and inactive usage totals', () => {
        const category = id();
        run(`INSERT INTO categories (id) VALUES ('${category}')`);
        run(`INSERT INTO products (id, categoryId, isActive) VALUES ('${id()}', '${category}', 1), ('${id()}', '${category}', 0)`);
        expect(run(catalogueCategoryUsageSql).trim().split('\n')).toContain(`${category}\t2\t1`);
    });

    it.each(['categories', 'tax_rates'])('rejects used %s including inactive products, leaving no tombstone', table => {
        const parent = id();
        run(`INSERT INTO ${table} (id) VALUES ('${parent}')`);
        run(`INSERT INTO products (id, ${table === 'categories' ? 'categoryId' : 'taxRateId'}, isActive) VALUES ('${id()}', '${parent}', 0)`);
        expect(() => run(`DELETE FROM ${table} WHERE id = '${parent}'`)).toThrow('used by items');
        expect(run(`SELECT COUNT(*) AS count FROM ${table} WHERE id = '${parent}'`).trim()).toBe('count\n1');
        expect(run(`SELECT COUNT(*) AS count FROM tombstones WHERE row_id = '${parent}'`).trim()).toBe('count\n0');
    });

    it('rejects default category deletion/deactivation and default tax deletion', () => {
        const category = id(), tax = id();
        run(`INSERT INTO categories (id) VALUES ('${category}')`);
        run(`INSERT INTO settings (\`key\`, value) VALUES ('default_product_category_id', '${category}') ON DUPLICATE KEY UPDATE value = VALUES(value)`);
        expect(() => run(`DELETE FROM categories WHERE id = '${category}'`)).toThrow('default category');
        expect(() => run(`UPDATE categories SET isActive = 0 WHERE id = '${category}'`)).toThrow('default category');
        run(`INSERT INTO tax_rates (id, isDefault) VALUES ('${tax}', 1)`);
        expect(() => run(`DELETE FROM tax_rates WHERE id = '${tax}'`)).toThrow('default tax rate');
    });

    it.each(['categories', 'tax_rates'])('deletes unused %s and creates exactly one nested tombstone without error 1442', table => {
        const parent = id();
        run(`INSERT INTO ${table} (id) VALUES ('${parent}')`);
        run(`DELETE FROM ${table} WHERE id = '${parent}'`);
        expect(run(`SELECT COUNT(*) AS count FROM tombstones WHERE row_id = '${parent}'`).trim()).toBe('count\n1');
        expect(() => run(`INSERT INTO ${table} (id) VALUES ('${parent}')`)).toThrow('was deleted');
        expect(() => run(`INSERT INTO products (id, ${table === 'categories' ? 'categoryId' : 'taxRateId'}) VALUES ('${id()}', '${parent}')`)).toThrow('no longer exists');
    });

    it('rejects an independent stale tombstone while its category still exists', () => {
        const category = id();
        run(`INSERT INTO categories (id) VALUES ('${category}')`);
        expect(() => run(`INSERT INTO tombstones (id, table_name, row_id) VALUES ('categories:${category}', 'categories', '${category}')`)).toThrow('still exists');
    });

    it.each(['categories', 'tax_rates'])('serializes concurrent product assignment before %s deletion', async table => {
        const category = id();
        run(`INSERT INTO ${table} (id) VALUES ('${category}')`);
        const field = table === 'categories' ? 'categoryId' : 'taxRateId';
        const release = await lockedSession(`INSERT INTO products (id, ${field}) VALUES ('${id()}', '${category}')`);
        await expectBlockedThenRejected(`DELETE FROM ${table} WHERE id = '${category}'`, release, 'used by items');
        expect(run(`SELECT COUNT(*) AS count FROM tombstones WHERE row_id = '${category}'`).trim()).toBe('count\n0');
    });

    it.each(['categories', 'tax_rates'])('serializes %s deletion before a concurrent product assignment', async table => {
        const category = id();
        run(`INSERT INTO ${table} (id) VALUES ('${category}')`);
        const field = table === 'categories' ? 'categoryId' : 'taxRateId';
        const release = await lockedSession(`DELETE FROM ${table} WHERE id = '${category}'`);
        await expectBlockedThenRejected(`INSERT INTO products (id, ${field}) VALUES ('${id()}', '${category}')`, release, 'no longer exists');
        expect(run(`SELECT COUNT(*) AS count FROM tombstones WHERE row_id = '${category}'`).trim()).toBe('count\n1');
    });

    it('serializes default assignment before category deletion', async () => {
        const category = id();
        run(`INSERT INTO categories (id) VALUES ('${category}')`);
        const release = await lockedSession(`UPDATE settings SET value = '${category}' WHERE \`key\` = 'default_product_category_id'`);
        await expectBlockedThenRejected(`DELETE FROM categories WHERE id = '${category}'`, release, 'default category');
    });

    it('does not trust a stale repeatable-read snapshot when publishing a tombstone', async () => {
        const category = id();
        const finish = await lockedSession(`SELECT COUNT(*) FROM categories WHERE id = '${category}'`);
        run(`INSERT INTO categories (id) VALUES ('${category}')`);
        // MariaDB 12 may reject an obsolete consistent-read view with 1020
        // before the trigger's own diagnostic. Both paths must roll back.
        await expect(finish(`INSERT INTO tombstones (id, table_name, row_id) VALUES ('categories:${category}', 'categories', '${category}')`)).rejects.toThrow(/still exists|Record has changed/);
        expect(run(`SELECT COUNT(*) AS count FROM categories WHERE id = '${category}'`).trim()).toBe('count\n1');
        expect(run(`SELECT COUNT(*) AS count FROM tombstones WHERE row_id = '${category}'`).trim()).toBe('count\n0');
    });

    it('preserves only the existing connection-bound controlled restore bypass', () => {
        const category = id(), product = id();
        run(`INSERT INTO categories (id) VALUES ('${category}')`);
        run(`INSERT INTO products (id, categoryId) VALUES ('${product}', '${category}')`);
        run(`UPDATE pos_restore_gate SET ownerTillId = 'isolated-restore', isActive = 1 WHERE id = 1`);
        try {
            expect(() => run(`DELETE FROM categories WHERE id = '${category}'`)).toThrow('used by items');
            run(`SET @lbj_pos_restore_bypass = 'isolated-restore'// DELETE FROM categories WHERE id = '${category}'// INSERT INTO categories (id) VALUES ('${category}')`);
        } finally {
            run(`UPDATE pos_restore_gate SET ownerTillId = '', isActive = 0 WHERE id = 1`);
        }
        expect(run(`SELECT isPresent FROM pos_catalogue_presence WHERE tableName = 'categories' AND rowId = '${category}'`).trim()).toBe('isPresent\n1');
    });

    function taxFixture() {
        const first = id(), second = id(), third = id();
        run(`START TRANSACTION// UPDATE pos_catalogue_mutex SET id = id WHERE id = 1//
            UPDATE tax_rates SET isDefault = 0 WHERE isDefault = 1//
            INSERT INTO tax_rates (id, isDefault) VALUES ('${first}', 1), ('${second}', 0), ('${third}', 0)// COMMIT`);
        return { first, second, third };
    }

    function expectOnlyDefault(tax: string) {
        expect(run('SELECT id FROM tax_rates WHERE isDefault = 1').trim()).toBe(`id\n${tax}`);
        expect(run('SELECT rowId FROM pos_tax_default_registry WHERE id = 1').trim()).toBe(`rowId\n${tax}`);
    }

    it('rejects an older queued default write after a different default was committed', () => {
        const { first, second, third } = taxFixture();
        run(`START TRANSACTION// UPDATE tax_rates SET isDefault = 0 WHERE isDefault = 1//
            UPDATE tax_rates SET isDefault = 1 WHERE id = '${third}'// COMMIT`);
        // A stale outbox's first=false may be skipped by timestamp conflict;
        // second=true previously still applied because its own row was older.
        expect(() => run(`UPDATE tax_rates SET isDefault = 1 WHERE id = '${second}'`)).toThrow('already default');
        // Even an old unset of first cannot clear third's registry authority.
        run(`UPDATE tax_rates SET isDefault = 0 WHERE id = '${first}'`);
        expectOnlyDefault(third);
        expect(() => run(`INSERT INTO tax_rates (id, isDefault) VALUES ('${id()}', 1)`)).toThrow('already default');
    });

    it('allows an atomic clear-and-select and an idempotent upsert of the current default', () => {
        const { second } = taxFixture();
        run(`START TRANSACTION// UPDATE pos_catalogue_mutex SET id = id WHERE id = 1//
            UPDATE tax_rates SET isDefault = 0 WHERE isDefault = 1//
            INSERT INTO tax_rates (id, isDefault) VALUES ('${second}', 1)
              ON DUPLICATE KEY UPDATE isDefault = VALUES(isDefault)// COMMIT`);
        run(`INSERT INTO tax_rates (id, isDefault) VALUES ('${second}', 1)
              ON DUPLICATE KEY UPDATE isDefault = VALUES(isDefault)`);
        expectOnlyDefault(second);
    });

    it('rolls the registry back with a failed complete default-selection transaction', () => {
        const { first, second } = taxFixture();
        expect(() => run(`START TRANSACTION// UPDATE tax_rates SET isDefault = 0 WHERE isDefault = 1//
            UPDATE tax_rates SET isDefault = 1 WHERE id = '${second}'//
            INSERT INTO tax_rates (id, isDefault) VALUES ('${first}', 0)// COMMIT`)).toThrow('Duplicate entry');
        expectOnlyDefault(first);
    });

    it('serializes competing default changes without locking-reading its own tax table', async () => {
        const { second, third } = taxFixture();
        const release = await lockedSession(`UPDATE tax_rates SET isDefault = 0 WHERE isDefault = 1//
            UPDATE tax_rates SET isDefault = 1 WHERE id = '${second}'`);
        await expectBlockedThenRejected(`UPDATE tax_rates SET isDefault = 1 WHERE id = '${third}'`, release, 'already default');
        expectOnlyDefault(second);
    });

    it('maintains default authority through the legitimate restore delete/reinsert sequence', () => {
        const { first, second } = taxFixture();
        run(`UPDATE pos_restore_gate SET ownerTillId = 'isolated-tax-restore', isActive = 1 WHERE id = 1`);
        try {
            expect(() => run(`DELETE FROM tax_rates WHERE id = '${first}'`)).toThrow('default tax rate');
            run(`SET @lbj_pos_restore_bypass = 'isolated-tax-restore'// START TRANSACTION//
                DELETE FROM tax_rates WHERE id = '${first}'//
                INSERT INTO tax_rates (id, isDefault) VALUES ('${first}', 1)// COMMIT`);
            expectOnlyDefault(first);
            // Restore authority rebuilds rows but does not authorize corrupt
            // two-default backups or erase the surviving default on old unsets.
            expect(() => run(`SET @lbj_pos_restore_bypass = 'isolated-tax-restore'//
                UPDATE tax_rates SET isDefault = 1 WHERE id = '${second}'`)).toThrow('already default');
        } finally {
            run(`UPDATE pos_restore_gate SET ownerTillId = '', isActive = 0 WHERE id = 1`);
        }
        expectOnlyDefault(first);
    });

    it('seeds from one historical default and rejects existing multi-default corruption', () => {
        const temporary = `CREATE TEMPORARY TABLE tax_rates (id VARCHAR(36), isDefault INT)//
            CREATE TEMPORARY TABLE pos_tax_default_registry (id TINYINT PRIMARY KEY, rowId VARCHAR(191))//`;
        expect(run(`${temporary} INSERT INTO tax_rates VALUES ('historical', 1)//
            ${catalogueTaxDefaultInitializationSql}// SELECT rowId FROM pos_tax_default_registry`).trim()).toBe('rowId\nhistorical');
        expect(() => run(`${temporary} INSERT INTO tax_rates VALUES ('one', 1), ('two', 1)//
            ${catalogueTaxDefaultInitializationSql}`)).toThrow('Subquery returns more than 1 row');
    });
});
