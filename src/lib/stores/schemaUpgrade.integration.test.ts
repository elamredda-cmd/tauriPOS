import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import type Database from '@tauri-apps/plugin-sql';
import { ensureMysqlSchemaOnDatabase } from './mysql';

const schema = process.env.POS_TEST_MYSQL_DATABASE;
describe.skipIf(!schema)('isolated MariaDB upgrade', () => {
    it('initializes a fresh schema and skips DDL/repairs on the next startup', async () => {
        if (!schema?.startsWith('pos_audit_') && !schema?.startsWith('pos_test_')) throw new Error('Use a disposable database');
        const statements: string[] = [];
        const run = (sql: string, values: any[] = [], select = false) => {
            let index = 0;
            const bound = sql.replace(/\?/g, () => {
                const value = values[index++];
                if (value == null) return 'NULL';
                if (typeof value === 'number') return String(value);
                return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
            });
            statements.push(sql);
            const output = execFileSync('mariadb', ['--batch', '--raw', '--delimiter=//', schema!, '-e', `${bound}//`], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
            if (!select) return { rowsAffected: 0, lastInsertId: 0 };
            if (!output) return [];
            const [head, ...lines] = output.split('\n');
            const keys = head.split('\t');
            return lines.map(line => Object.fromEntries(line.split('\t').map((value, index) => [keys[index], value === 'NULL' ? null : value])));
        };
        const database = { execute: async (sql: string, values?: any[]) => run(sql, values), select: async (sql: string, values?: any[]) => run(sql, values, true) } as unknown as Database;
        await ensureMysqlSchemaOnDatabase(database);
        expect(statements.some(sql => sql.includes('ALTER TABLE products'))).toBe(true);
        statements.length = 0;
        await ensureMysqlSchemaOnDatabase(database);
        expect(statements).toHaveLength(2);
        expect(statements.every(sql => !sql.includes('ALTER TABLE'))).toBe(true);
        // Model an already-installed till at the previous fast-path marker.
        await database.execute('ALTER TABLE payment_terminal_attempts DROP COLUMN operatorResolution');
        await database.execute("UPDATE pos_schema_migrations SET name = 'pos_schema_2026_09_22_dojo_extras_v1' WHERE name = 'pos_schema_2026_09_28_dojo_review_v1'");
        statements.length = 0;
        await ensureMysqlSchemaOnDatabase(database);
        expect(statements.some(sql => sql.includes('ALTER TABLE payment_terminal_attempts') && sql.includes('operatorResolution'))).toBe(true);
        const columns = await database.select<any[]>("SHOW COLUMNS FROM payment_terminal_attempts LIKE 'operatorResolution'");
        expect(columns).toHaveLength(1);
        statements.length = 0;
        await ensureMysqlSchemaOnDatabase(database);
        expect(statements).toHaveLength(2);
    }, 120_000);
});
