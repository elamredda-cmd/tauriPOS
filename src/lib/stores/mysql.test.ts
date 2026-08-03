import { describe, expect, it, vi } from 'vitest';

import {
    ensureCustomerAccountLedgerGuards,
    ensureCustomerAntiResurrectionTriggers,
    hardenCustomerAccountTables,
    mysqlApplicationReadProjection,
    normalizeMysqlIdentifierCollations,
    seedMysqlCloseBarrierFromLatestReportMarker,
} from './mysql';

function compactSql(sql: string): string {
    return sql.replace(/\s+/g, ' ').trim();
}

const COORDINATION_COLUMNS = [
    ['pos_restore_gate', 'id'],
    ['pos_restore_gate', 'ownerTillId'],
    ['pos_restore_gate', 'isActive'],
    ['pos_restore_gate', 'claimedAt'],
    ['pos_account_write_authority', 'connectionId'],
    ['pos_account_write_authority', 'authorityToken'],
    ['pos_account_write_authority', 'expiresAt'],
    ['pos_customer_write_locks', 'customerId'],
    ['till_presence', 'tillId'],
    ['till_presence', 'closeBarrierToken'],
    ['pos_close_barrier', 'id'],
    ['pos_close_barrier', 'token'],
    ['pos_close_barrier', 'ownerTillId'],
].map(([tableName, columnName]) => ({ tableName, columnName }));

function mockCoordinationSelect(sql: string): any[] {
    const compact = compactSql(sql);
    if (compact.includes('FROM INFORMATION_SCHEMA.COLUMNS')) return COORDINATION_COLUMNS;
    if (compact.includes("SELECT 'pos_restore_gate' AS tableName")) {
        return [{ tableName: 'pos_restore_gate' }, { tableName: 'pos_close_barrier' }];
    }
    return [];
}

describe('MariaDB report epoch migration', () => {
    it('seeds only an uninitialized barrier from the latest canonical period marker', async () => {
        const execute = vi.fn(async (_sql: string) => ({ rowsAffected: 1 }));
        const database = {
            select: vi.fn(async (sql: string) =>
                compactSql(sql).includes("TABLE_NAME = 'till_report_markers'")
                    ? [{ tableName: 'till_report_markers' }]
                    : []
            ),
            execute,
        };

        await seedMysqlCloseBarrierFromLatestReportMarker(database as never);

        expect(execute).toHaveBeenCalledTimes(1);
        const sql = compactSql(String(execute.mock.calls[0]?.[0] || ''));
        expect(sql).toContain('UPDATE pos_close_barrier');
        expect(sql).toContain('MAX(STR_TO_DATE(');
        expect(sql).toContain("WHERE tillNumber = '' AND type = 'period'");
        expect(sql).toContain('WHERE id = 1 AND lastClosedAt IS NULL');
    });

    it('does nothing when report markers have not been created yet', async () => {
        const execute = vi.fn(async () => ({ rowsAffected: 0 }));
        const database = {
            select: vi.fn(async () => []),
            execute,
        };

        await seedMysqlCloseBarrierFromLatestReportMarker(database as never);

        expect(execute).not.toHaveBeenCalled();
    });
});

describe('MariaDB customer account migration', () => {
    it('reconstructs a missing balance from a uniquely owned ledger after trimming legacy IDs', async () => {
        const selectedSql: string[] = [];
        const executedSql: string[] = [];
        const database = {
            select: vi.fn(async (sql: string, params: unknown[] = []) => {
                const compact = compactSql(sql);
                selectedSql.push(compact);

                if (compact.includes('FROM pos_schema_migrations')) return [];
                if (compact.includes('FROM INFORMATION_SCHEMA.STATISTICS')) {
                    const table = String(params[0] || '');
                    return table === 'customer_accounts'
                        ? [
                            { indexName: 'PRIMARY', nonUnique: 0, sequenceNumber: 1, columnName: 'id' },
                            { indexName: 'uq_customer_accounts_customer_id', nonUnique: 0, sequenceNumber: 1, columnName: 'customerId' },
                        ]
                        : [
                            { indexName: 'PRIMARY', nonUnique: 0, sequenceNumber: 1, columnName: 'id' },
                            { indexName: 'uq_customer_account_entries_idempotency_key', nonUnique: 0, sequenceNumber: 1, columnName: 'idempotencyKey' },
                        ];
                }
                if (compact.includes('SELECT 1 AS missingBalance')) return [{ missingBalance: 1 }];
                if (compact.includes('SELECT 1 AS missingLedger FROM')) {
                    const matchesTrimmedOwnership = compact.includes(
                        'CONVERT(TRIM(ledger_entry.accountId) USING utf8mb4) COLLATE utf8mb4_unicode_ci',
                    ) && compact.includes(
                        'CONVERT(TRIM(ledger_entry.customerId) USING utf8mb4) COLLATE utf8mb4_unicode_ci',
                    );
                    return matchesTrimmedOwnership ? [] : [{ missingLedger: 1 }];
                }
                return [];
            }),
            execute: vi.fn(async (sql: string) => {
                executedSql.push(compactSql(sql));
                return { rowsAffected: 0 };
            }),
        };

        await expect(hardenCustomerAccountTables(database as never)).resolves.toBeUndefined();

        const ledgerGuard = selectedSql.find((sql) => sql.includes('SELECT 1 AS missingLedger FROM'));
        expect(ledgerGuard).toContain(
            'CONVERT(TRIM(ledger_entry.accountId) USING utf8mb4) COLLATE utf8mb4_unicode_ci',
        );
        expect(ledgerGuard).toContain(
            'CONVERT(account.id USING utf8mb4) COLLATE utf8mb4_unicode_ci',
        );

        const reconstruction = executedSql.find((sql) => sql.includes('SUM(amountPence) AS reconstructedBalance'));
        expect(reconstruction).toContain('SELECT TRIM(accountId) AS accountId, TRIM(customerId) AS customerId');
        expect(reconstruction).toContain('GROUP BY TRIM(accountId), TRIM(customerId)');
        expect(reconstruction).toContain(
            'CONVERT(ledger.accountId USING utf8mb4) COLLATE utf8mb4_unicode_ci',
        );
        expect(reconstruction).toContain(
            'CONVERT(account.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci',
        );
    });

    it('aligns each relation to its own installed parent without rewriting parent or polymorphic IDs', async () => {
        const relations = [
            ['customer_accounts', 'customerId', 'customers', 'id'],
            ['customer_account_entries', 'accountId', 'customer_accounts', 'id'],
            ['customer_account_entries', 'customerId', 'customers', 'id'],
            ['orders', 'customerId', 'customers', 'id'],
            ['loyalty_logs', 'customerId', 'customers', 'id'],
            ['pos_customer_write_locks', 'customerId', 'customers', 'id'],
            ['product_images', 'id', 'products', 'id'],
            ['customer_account_entries', 'orderId', 'orders', 'id'],
            ['customer_account_entries', 'receiptKey', 'orders', 'receiptKey'],
            ['customer_account_entries', 'employeeId', 'employees', 'id'],
            ['customer_account_entries', 'tillNumber', 'registers', 'id'],
            ['customer_account_entries', 'shiftId', 'shifts', 'id'],
            ['customer_account_entries', 'reversesEntryId', 'customer_account_entries', 'id'],
        ];
        const binaryCoordination = [
            ['pos_restore_gate', 'ownerTillId'],
            ['pos_account_write_authority', 'authorityToken'],
            ['till_presence', 'tillId'],
            ['till_presence', 'closeBarrierToken'],
            ['pos_close_barrier', 'token'],
            ['pos_close_barrier', 'ownerTillId'],
            ['payment_terminal_locks', 'terminalKey'],
            ['payment_terminal_locks', 'tillId'],
            ['payment_terminal_locks', 'paymentReference'],
            ['payment_terminal_attempts', 'id'],
            ['payment_terminal_attempts', 'terminalKey'],
            ['payment_terminal_attempts', 'clientTransactionId'],
            ['payment_terminal_attempts', 'terminalSessionId'],
            ['payment_terminal_attempts', 'tillId'],
            ['payment_terminal_attempts', 'activeTerminalKey'],
        ];
        const columnState = new Map<string, {
            tableName: string;
            columnName: string;
            columnType: string;
            isNullable: string;
            columnDefault: string | null;
            extra: string;
            characterSetName: string;
            collationName: string;
        }>();
        const seed = (tableName: string, columnName: string, collationName: string) => {
            const nullable = (tableName === 'orders' || tableName === 'loyalty_logs')
                && columnName === 'customerId';
            const emptyDefault = tableName === 'customer_account_entries'
                && ['orderId', 'receiptKey', 'employeeId', 'tillNumber', 'shiftId', 'reversesEntryId'].includes(columnName);
            const width = columnName === 'receiptKey'
                ? 100
                : (tableName === 'pos_customer_write_locks'
                    || (tableName === 'product_images' && columnName === 'id'))
                    ? 64
                    : 36;
            columnState.set(`${tableName}.${columnName}`, {
                tableName,
                columnName,
                columnType: `varchar(${width})`,
                isNullable: nullable ? 'YES' : 'NO',
                columnDefault: nullable ? 'NULL' : emptyDefault ? "''" : null,
                extra: '',
                characterSetName: 'utf8mb4',
                collationName,
            });
        };
        seed('customers', 'id', 'utf8mb4_general_ci');
        seed('customer_accounts', 'id', 'utf8mb4_unicode_ci');
        seed('products', 'id', 'utf8mb4_general_ci');
        seed('orders', 'id', 'utf8mb4_general_ci');
        seed('orders', 'receiptKey', 'utf8mb4_general_ci');
        seed('employees', 'id', 'utf8mb4_general_ci');
        seed('registers', 'id', 'utf8mb4_general_ci');
        seed('shifts', 'id', 'utf8mb4_general_ci');
        seed('customer_account_entries', 'id', 'utf8mb4_unicode_ci');
        for (const [table, column] of relations) {
            if (!columnState.has(`${table}.${column}`)) {
                seed(table, column, 'utf8mb4_unicode_ci');
            }
        }
        // Prove accountId and reversal IDs follow their own unicode parents,
        // rather than being forced into the legacy customer collation bucket.
        seed('customer_account_entries', 'accountId', 'utf8mb4_general_ci');
        seed('customer_account_entries', 'reversesEntryId', 'utf8mb4_general_ci');
        seed('tombstones', 'row_id', 'utf8mb4_bin');
        for (const [table, column] of binaryCoordination) seed(table, column, 'utf8mb4_general_ci');

        const executed: Array<{ sql: string; params: unknown[] }> = [];
        const operations: string[] = [];
        const database = {
            select: vi.fn(async (sql: string) => {
                const compact = compactSql(sql);
                if (compact.includes('FROM INFORMATION_SCHEMA.COLUMNS')) {
                    return [...columnState.values()];
                }
                if (compact.includes('duplicateTargetIdentifier')) {
                    operations.push(`preflight:${compact}`);
                    return [];
                }
                throw new Error(`unexpected select: ${compact}`);
            }),
            execute: vi.fn(async (sql: string, params: unknown[] = []) => {
                const compact = compactSql(sql);
                operations.push(compact.startsWith('ALTER TABLE') ? `alter:${compact}` : compact);
                executed.push({ sql: compact, params });
                const altered = /ALTER TABLE `([^`]+)` MODIFY COLUMN `([^`]+)` .* CHARACTER SET ([A-Za-z0-9_]+) COLLATE ([A-Za-z0-9_]+)/i.exec(compact);
                if (altered) {
                    const [, table, column, characterSetName, collationName] = altered;
                    const row = columnState.get(`${table}.${column}`);
                    if (!row) throw new Error(`unexpected column ${table}.${column}`);
                    row.characterSetName = characterSetName.toLowerCase();
                    row.collationName = collationName.toLowerCase();
                }
                return { rowsAffected: 0 };
            }),
        };

        await normalizeMysqlIdentifierCollations(database as never);

        expect(executed.some(({ sql }) => sql.includes('MODIFY COLUMN `id`') && sql.includes('`customers`'))).toBe(false);
        expect(columnState.get('customer_accounts.id')?.collationName).toBe('utf8mb4_unicode_ci');
        expect(columnState.get('tombstones.row_id')?.collationName).toBe('utf8mb4_bin');
        for (const [table, column, parentTable, parentColumn] of relations) {
            expect(columnState.get(`${table}.${column}`)?.collationName).toBe(
                columnState.get(`${parentTable}.${parentColumn}`)?.collationName,
            );
        }
        for (const [table, column] of binaryCoordination) {
            expect(columnState.get(`${table}.${column}`)?.collationName).toBe('utf8mb4_bin');
        }
        const lastPreflight = operations.findLastIndex((operation) => operation.startsWith('preflight:'));
        const firstAlter = operations.findIndex((operation) => operation.startsWith('alter:'));
        expect(lastPreflight).toBeGreaterThanOrEqual(0);
        expect(lastPreflight).toBeLessThan(firstAlter);
        expect(executed.find(({ sql }) => sql.includes('ALTER TABLE `product_images`'))?.sql)
            .toContain('MODIFY COLUMN `id` VARCHAR(64)');
        expect(executed.find(({ sql }) => sql.includes('MODIFY COLUMN `receiptKey`'))?.sql)
            .toContain("VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL DEFAULT ''");
        expect(executed.find(({ sql }) => sql.includes('ALTER TABLE `orders`'))?.sql)
            .toContain('MODIFY COLUMN `customerId` VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL DEFAULT NULL');
        expect(executed.at(-1)?.params).toEqual(['2026-07-relational-identifier-collation-v2']);
    });

    it('blocks target-collation PK collisions before executing any migration DDL', async () => {
        const rows = [
            ['customers', 'id', 'utf8mb4_general_ci'],
            ['customer_accounts', 'id', 'utf8mb4_unicode_ci'],
            ['customer_accounts', 'customerId', 'utf8mb4_unicode_ci'],
            ['customer_account_entries', 'id', 'utf8mb4_unicode_ci'],
            ['customer_account_entries', 'accountId', 'utf8mb4_unicode_ci'],
            ['customer_account_entries', 'customerId', 'utf8mb4_unicode_ci'],
            ['customer_account_entries', 'orderId', 'utf8mb4_unicode_ci'],
            ['customer_account_entries', 'receiptKey', 'utf8mb4_unicode_ci'],
            ['customer_account_entries', 'employeeId', 'utf8mb4_unicode_ci'],
            ['customer_account_entries', 'tillNumber', 'utf8mb4_unicode_ci'],
            ['customer_account_entries', 'shiftId', 'utf8mb4_unicode_ci'],
            ['customer_account_entries', 'reversesEntryId', 'utf8mb4_unicode_ci'],
            ['orders', 'id', 'utf8mb4_general_ci'],
            ['orders', 'receiptKey', 'utf8mb4_general_ci'],
            ['orders', 'customerId', 'utf8mb4_unicode_ci'],
            ['loyalty_logs', 'customerId', 'utf8mb4_unicode_ci'],
            ['pos_customer_write_locks', 'customerId', 'utf8mb4_unicode_ci'],
            ['products', 'id', 'utf8mb4_general_ci'],
            ['product_images', 'id', 'utf8mb4_unicode_ci'],
            ['employees', 'id', 'utf8mb4_general_ci'],
            ['registers', 'id', 'utf8mb4_general_ci'],
            ['shifts', 'id', 'utf8mb4_general_ci'],
            ...[
                ['pos_restore_gate', 'ownerTillId'],
                ['pos_account_write_authority', 'authorityToken'],
                ['till_presence', 'tillId'],
                ['till_presence', 'closeBarrierToken'],
                ['pos_close_barrier', 'token'],
                ['pos_close_barrier', 'ownerTillId'],
                ['payment_terminal_locks', 'terminalKey'],
                ['payment_terminal_locks', 'tillId'],
                ['payment_terminal_locks', 'paymentReference'],
                ['payment_terminal_attempts', 'id'],
                ['payment_terminal_attempts', 'terminalKey'],
                ['payment_terminal_attempts', 'clientTransactionId'],
                ['payment_terminal_attempts', 'terminalSessionId'],
                ['payment_terminal_attempts', 'tillId'],
                ['payment_terminal_attempts', 'activeTerminalKey'],
            ].map(([table, column]) => [table, column, 'utf8mb4_general_ci']),
        ].map(([tableName, columnName, collationName]) => {
            const nullable = (tableName === 'orders' || tableName === 'loyalty_logs')
                && columnName === 'customerId';
            const emptyDefault = tableName === 'customer_account_entries'
                && ['orderId', 'receiptKey', 'employeeId', 'tillNumber', 'shiftId', 'reversesEntryId'].includes(columnName);
            const width = columnName === 'receiptKey'
                ? 100
                : tableName === 'pos_customer_write_locks'
                    ? 64
                    : 36;
            return {
                tableName,
                columnName,
                columnType: `varchar(${width})`,
                isNullable: nullable ? 'YES' : 'NO',
                columnDefault: nullable ? 'NULL' : emptyDefault ? "''" : null,
                extra: '',
                characterSetName: 'utf8mb4',
                collationName,
            };
        });
        const execute = vi.fn(async () => ({ rowsAffected: 0 }));
        const database = {
            select: vi.fn(async (sql: string) => {
                const compact = compactSql(sql);
                if (compact.includes('FROM INFORMATION_SCHEMA.COLUMNS')) return rows;
                if (compact.includes('duplicateTargetIdentifier')
                    && compact.includes('FROM `product_images`')) {
                    return [{ duplicateTargetIdentifier: 1 }];
                }
                if (compact.includes('duplicateTargetIdentifier')) return [];
                throw new Error(`unexpected select: ${compact}`);
            }),
            execute,
        };

        await expect(normalizeMysqlIdentifierCollations(database as never)).rejects.toThrow(
            'product_images.id contains identifiers that collide',
        );
        expect(execute).not.toHaveBeenCalled();
    });

    it('blocks duplicate prospective accounts before mutating account or ledger ownership', async () => {
        const executedSql: string[] = [];
        const selectedSql: string[] = [];
        const database = {
            select: vi.fn(async (sql: string) => {
                const compact = compactSql(sql);
                selectedSql.push(compact);
                if (compact.includes('SELECT 1 AS duplicateAccountId')) {
                    return [{ duplicateAccountId: 1 }];
                }
                return [];
            }),
            execute: vi.fn(async (sql: string) => {
                executedSql.push(compactSql(sql));
                return { rowsAffected: 0 };
            }),
        };

        await expect(hardenCustomerAccountTables(database as never)).rejects.toThrow(
            'MARIADB_ACCOUNT_MIGRATION_BLOCKED: duplicate customer account ids',
        );

        expect(selectedSql).toContainEqual(expect.stringContaining('invalidAccountOwnership'));
        expect(selectedSql).toContainEqual(expect.stringContaining('duplicateAccountId'));
        expect(executedSql).toEqual([]);
    });

    it('blocks legacy idempotency-key fill collisions before any ledger repair', async () => {
        const executedSql: string[] = [];
        const database = {
            select: vi.fn(async (sql: string) => {
                if (compactSql(sql).includes('SELECT 1 AS duplicateLedgerIdempotencyKey')) {
                    return [{ duplicateLedgerIdempotencyKey: 1 }];
                }
                return [];
            }),
            execute: vi.fn(async (sql: string) => {
                executedSql.push(compactSql(sql));
                return { rowsAffected: 0 };
            }),
        };

        await expect(hardenCustomerAccountTables(database as never)).rejects.toThrow(
            'MARIADB_ACCOUNT_MIGRATION_BLOCKED: duplicate prospective ledger idempotency keys',
        );
        expect(executedSql).toEqual([]);
    });

    it.each([
        [
            'missingLedgerEntryId',
            'a ledger entry has no immutable id',
        ],
        [
            'duplicateLedgerEntryId',
            'duplicate ledger entry ids',
        ],
    ])('blocks unsafe ledger identity state (%s) before repair writes', async (selectedAlias, message) => {
        const execute = vi.fn(async () => ({ rowsAffected: 0 }));
        const database = {
            select: vi.fn(async (sql: string) =>
                compactSql(sql).includes(`SELECT 1 AS ${selectedAlias}`) ? [{ invalid: 1 }] : []
            ),
            execute,
        };

        await expect(hardenCustomerAccountTables(database as never)).rejects.toThrow(message);
        expect(execute).not.toHaveBeenCalled();
    });
});

describe('MariaDB customer deletion guards', () => {
    it('serializes legacy upserts and rejects tombstoned customer identities', async () => {
        const executedSql: string[] = [];
        const database = {
            select: vi.fn(async (sql: string) => mockCoordinationSelect(sql)),
            execute: vi.fn(async (sql: string) => {
                executedSql.push(compactSql(sql));
                return { rowsAffected: 0 };
            }),
        };

        await ensureCustomerAntiResurrectionTriggers(database as never);

        expect(executedSql).toContainEqual(expect.stringContaining(
            'CREATE TABLE IF NOT EXISTS pos_customer_write_locks',
        ));
        const customerInsert = executedSql.find((sql) =>
            sql.includes('pos_guard_customer_resurrection_insert'));
        expect(customerInsert).toContain('pos_customer_write_locks');
        expect(customerInsert).toContain('ON DUPLICATE KEY UPDATE');
        expect(customerInsert).not.toContain('INSERT IGNORE');
        expect(customerInsert).toContain('FOR UPDATE');
        expect(customerInsert).toContain("BINARY ownerTillId = BINARY COALESCE(@lbj_pos_restore_bypass, '')");
        expect(customerInsert).toContain('CONVERT(row_id USING utf8mb4) COLLATE utf8mb4_unicode_ci');
        expect(customerInsert).toContain('CREATE OR REPLACE TRIGGER');
        expect(customerInsert).toContain('CUSTOMER_DELETED');

        const accountInsert = executedSql.find((sql) =>
            sql.includes('pos_guard_customer_account_resurrection_insert'));
        expect(accountInsert).toContain('NEW.customerId');
        expect(accountInsert).toContain("table_name = 'customer_accounts'");
        expect(accountInsert).toContain('CONVERT(row_id USING utf8mb4) COLLATE utf8mb4_unicode_ci');
        expect(accountInsert).toContain('NOT EXISTS ( SELECT 1 FROM customers');
        expect(accountInsert).toContain('CUSTOMER_DELETED');

        for (const trigger of [
            'pos_guard_customer_order_insert',
            'pos_guard_customer_order_update',
            'pos_guard_customer_loyalty_log_insert',
            'pos_guard_customer_loyalty_log_update',
            'pos_guard_customer_account_entry_insert',
            'pos_guard_customer_account_entry_update',
        ]) {
            const sql = executedSql.find((statement) => statement.includes(trigger));
            expect(sql, `${trigger} was not installed`).toContain('pos_customer_write_locks');
            expect(sql).toContain('FOR UPDATE');
            expect(sql).toContain('CUSTOMER_DELETED');
            expect(sql).toContain("BINARY ownerTillId = BINARY COALESCE(@lbj_pos_restore_bypass, '')");
        }

        const accountEntryInsert = executedSql.find((sql) =>
            sql.includes('pos_guard_customer_account_entry_insert'));
        expect(accountEntryInsert).toContain("table_name = 'customer_accounts'");
        expect(accountEntryInsert).toContain('CONVERT(id USING utf8mb4) COLLATE utf8mb4_unicode_ci');
        expect(accountEntryInsert).toContain('CONVERT(NEW.accountId USING utf8mb4) COLLATE utf8mb4_unicode_ci');

        for (const [trigger, oldId] of [
            ['pos_guard_customer_resurrection_delete', 'OLD.id'],
            ['pos_guard_customer_account_resurrection_delete', 'OLD.customerId'],
        ]) {
            const sql = executedSql.find((statement) => statement.includes(trigger));
            expect(sql, `${trigger} was not installed`).toContain('BEFORE DELETE');
            expect(sql).toContain('pos_customer_write_locks');
            expect(sql).toContain('ON DUPLICATE KEY UPDATE');
            expect(sql).toContain('FOR UPDATE');
            expect(sql).toContain(
                `CONVERT(${oldId} USING utf8mb4) COLLATE utf8mb4_unicode_ci`,
            );
            expect(sql).toContain(
                "BINARY ownerTillId = BINARY COALESCE(@lbj_pos_restore_bypass, '')",
            );
        }
    });
});

describe('MariaDB customer account ledger guards', () => {
    it('requires transaction-bound native authority for balances and ledger history', async () => {
        const executedSql: string[] = [];
        const database = {
            select: vi.fn(async (sql: string) => mockCoordinationSelect(sql)),
            execute: vi.fn(async (sql: string) => {
                executedSql.push(compactSql(sql));
                return { rowsAffected: 0 };
            }),
        };

        await ensureCustomerAccountLedgerGuards(database as never);

        expect(executedSql).toContainEqual(expect.stringContaining(
            'CREATE TABLE IF NOT EXISTS pos_account_write_authority',
        ));
        for (const trigger of [
            'pos_guard_account_balance_insert',
            'pos_guard_account_balance_update',
            'pos_guard_account_delete',
            'pos_guard_account_entry_insert',
            'pos_guard_account_entry_update',
            'pos_guard_account_entry_delete',
        ]) {
            const sql = executedSql.find((statement) => statement.includes(trigger));
            expect(sql, `${trigger} was not installed`).toContain(
                'authority.connectionId = CONNECTION_ID()',
            );
            expect(sql).toContain(
                "BINARY authority.authorityToken = BINARY COALESCE(@lbj_pos_account_authority, '')",
            );
            expect(sql).toContain('authority.expiresAt > UTC_TIMESTAMP(3)');
            expect(sql).toContain("BINARY ownerTillId = BINARY COALESCE(@lbj_pos_restore_bypass, '')");
            expect(sql).toContain('CREATE OR REPLACE TRIGGER');
            expect(sql).toContain('ACCOUNT_LEDGER_AUTHORITY_REQUIRED');
        }

        const balanceInsert = executedSql.find((sql) =>
            sql.includes('pos_guard_account_balance_insert'));
        expect(balanceInsert).toContain('COALESCE(NEW.balancePence, 0) <> 0');
        const balanceUpdate = executedSql.find((sql) =>
            sql.includes('pos_guard_account_balance_update'));
        expect(balanceUpdate).toContain('NOT (NEW.balancePence <=> OLD.balancePence)');
    });
});

describe('MariaDB application read projections', () => {
    it.each([
        ['pos_restore_gate', 'ownerTillId'],
        ['pos_restore_gate', 'claimedAt'],
        ['pos_account_write_authority', 'authorityToken'],
        ['till_presence', 'tillId'],
        ['till_presence', 'tillName'],
        ['till_presence', 'closeBarrierToken'],
        ['till_presence', 'closeBarrierPhase'],
        ['pos_close_barrier', 'token'],
        ['pos_close_barrier', 'state'],
        ['pos_close_barrier', 'ownerTillId'],
        ['payment_terminal_locks', 'terminalKey'],
        ['payment_terminal_locks', 'tillId'],
        ['payment_terminal_locks', 'tillName'],
        ['payment_terminal_locks', 'paymentReference'],
        ['payment_terminal_attempts', 'id'],
        ['payment_terminal_attempts', 'provider'],
        ['payment_terminal_attempts', 'terminalKey'],
        ['payment_terminal_attempts', 'clientTransactionId'],
        ['payment_terminal_attempts', 'terminalSessionId'],
        ['payment_terminal_attempts', 'operationKind'],
        ['payment_terminal_attempts', 'currency'],
        ['payment_terminal_attempts', 'status'],
        ['payment_terminal_attempts', 'saleBundle'],
        ['payment_terminal_attempts', 'providerReference'],
        ['payment_terminal_attempts', 'error'],
        ['payment_terminal_attempts', 'tillId'],
        ['payment_terminal_attempts', 'createdAt'],
        ['payment_terminal_attempts', 'updatedAt'],
        ['payment_terminal_attempts', 'activeTerminalKey'],
    ])('casts %s.%s to utf8mb4 text for the Tauri SQL bridge', (table, column) => {
        expect(mysqlApplicationReadProjection(table, [column])).toBe(
            `CAST(\`${column}\` AS CHAR CHARACTER SET utf8mb4) AS \`${column}\``,
        );
    });

    it('leaves numeric and non-coordination application columns unchanged', () => {
        expect(mysqlApplicationReadProjection(
            'payment_terminal_attempts',
            ['id', 'amount'],
        )).toBe(
            'CAST(`id` AS CHAR CHARACTER SET utf8mb4) AS `id`, `amount`',
        );
        expect(mysqlApplicationReadProjection('orders', ['id', 'total'])).toBe('`id`, `total`');
    });
});
