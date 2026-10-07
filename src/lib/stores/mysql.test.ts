import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';

import {
    EMPLOYEE_PROFILE_CONFLICT_CODE,
    ensureAttendanceOnlyRoleGuards,
    ensureCustomerAccountLedgerGuards,
    ensureCustomerAntiResurrectionTriggers,
    hardenCustomerAccountTables,
    MYSQL_ATTENDANCE_ROW_PROJECTION,
    MYSQL_ATTENDANCE_SUMMARY_PROJECTION,
    mysqlApplicationReadProjection,
    mysqlInsertOpenEmployeeAttendanceOnDatabase,
    mysqlSaveEmployeeProfileCasOnDatabase,
    mysqlSaveClosedEmployeeAttendanceOnDatabase,
    normalizeMysqlIdentifierCollations,
    seedMysqlCloseBarrierFromLatestReportMarker,
} from './mysql';

function compactSql(sql: string): string {
    return sql.replace(/\s+/g, ' ').trim();
}

function mysqlCliTestDatabase() {
    const host = process.env.POS_TEST_MYSQL_HOST || '';
    const port = process.env.POS_TEST_MYSQL_PORT || '3306';
    const user = process.env.POS_TEST_MYSQL_USER || '';
    const database = process.env.POS_TEST_MYSQL_DATABASE || '';
    const password = process.env.POS_TEST_MYSQL_PASSWORD || '';
    const quote = (value: unknown): string => {
        if (value === null || value === undefined) return 'NULL';
        if (typeof value === 'number') return String(value);
        return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
    };
    const bind = (sql: string, params: unknown[] = []): string => {
        let index = 0;
        const bound = sql.replace(/\?/g, () => quote(params[index++]));
        if (index !== params.length) throw new Error('MariaDB live-test parameter mismatch');
        return bound;
    };
    const run = (sql: string, headings: boolean): string => execFileSync(
        process.env.POS_TEST_MYSQL_CLI || 'mariadb',
        [
            '--connect-timeout=5', '--batch', '--raw',
            ...(headings ? [] : ['--skip-column-names']),
            '--delimiter=//',
            '-h', host, '-P', port, '-u', user, database, '--execute', `${sql}//`,
        ],
        {
            encoding: 'utf8',
            env: { ...process.env, MYSQL_PWD: password },
            stdio: ['ignore', 'pipe', 'pipe'],
        },
    );
    return {
        execute: async (sql: string, params: unknown[] = []) => {
            run(bind(sql, params), false);
            return { rowsAffected: 0 };
        },
        select: async (sql: string, params: unknown[] = []) => {
            const output = run(bind(sql, params), true).trim();
            if (!output) return [];
            const [headingLine, ...lines] = output.split('\n');
            const headings = headingLine.split('\t');
            return lines.filter(Boolean).map((line) => Object.fromEntries(
                line.split('\t').map((value, index) => [headings[index], value]),
            ));
        },
    };
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

describe('MariaDB attendance-only role guards', () => {
    it('wraps legacy hashes and blocks legacy checkout or shift writes', async () => {
        const executedSql: string[] = [];
        const database = {
            select: vi.fn(async () => []),
            execute: vi.fn(async (sql: string) => {
                executedSql.push(compactSql(sql));
                return { rowsAffected: 0 };
            }),
        };

        await ensureAttendanceOnlyRoleGuards(database as never);

        const legacyWrap = executedSql.find((sql) =>
            sql.startsWith('UPDATE employees SET role = TRIM') && sql.includes('attendance-only-v1$'));
        const legacyUnwrap = legacyWrap;
        expect(legacyWrap).toContain("pin = CASE WHEN TRIM(COALESCE(role, '')) = 'attendance' THEN ''");
        expect(legacyUnwrap).toContain('attendance-only-v1$');

        const employeeInsert = executedSql.find((sql) =>
            sql.includes('pos_guard_attendance_employee_insert'));
        const employeeUpdate = executedSql.find((sql) =>
            sql.includes('pos_guard_attendance_employee_update'));
        const employeeDelete = executedSql.find((sql) =>
            sql.includes('pos_guard_attendance_employee_delete'));
        const shiftInsert = executedSql.find((sql) =>
            sql.includes('pos_guard_attendance_shift_insert'));
        const orderInsert = executedSql.find((sql) =>
            sql.includes('pos_guard_attendance_order_insert'));
        const terminalInsert = executedSql.find((sql) =>
            sql.includes('pos_guard_terminal_employee_insert'));
        const attendanceInsertAudit = executedSql.find((sql) =>
            sql.includes('pos_audit_employee_attendance_insert'));
        const attendanceUpdateAudit = executedSql.find((sql) =>
            sql.includes('pos_audit_employee_attendance_update'));
        const attendanceActiveInsert = executedSql.find((sql) =>
            sql.includes('pos_guard_attendance_active_insert'));
        const attendanceUpdateGuard = executedSql.find((sql) =>
            sql.includes('pos_guard_attendance_update'));
        const attendanceDeleteGuard = executedSql.find((sql) =>
            sql.includes('pos_guard_attendance_delete'));

        expect(employeeInsert).toContain('ATTENDANCE_ROLE_PIN_REQUIRED');
        expect(employeeUpdate).toContain('ATTENDANCE_ROLE_PIN_INVALID');
        expect(employeeUpdate).toContain('ATTENDANCE_STILL_OPEN');
        expect(employeeUpdate).toContain("status = 'open'");
        expect(employeeUpdate).toContain('TERMINAL_ATTEMPT_ACTIVE');
        expect(employeeUpdate).toContain("JSON_EXTRACT(saleBundle, '$.order.employeeId')");
        expect(employeeUpdate).toContain("JSON_EXTRACT(saleBundle, '$.employeeId')");
        expect(employeeUpdate).toContain('(BINARY NEW.id <=> BINARY OLD.id)');
        expect(employeeUpdate).toContain('(BINARY NEW.name <=> BINARY OLD.name)');
        expect(employeeUpdate).toContain('BINARY NEW.pinHash = BINARY (CASE');
        // The normal timestamp trigger may stamp NEW.updatedAt before this
        // guard. The exception is still one-shot because OLD must be genuinely
        // noncanonical and every user-controlled field is binary-exact.
        expect(employeeUpdate).not.toContain('NEW.updatedAt <=> OLD.updatedAt');
        expect(employeeDelete).toContain('pos_restore_gate');
        expect(employeeDelete).toContain("ownerTillId <> ''");
        expect(employeeDelete).toContain('@lbj_pos_restore_bypass');
        expect(employeeDelete).toContain('EMPLOYEE_DELETE_DISABLED');
        expect(shiftInsert).toContain('FOR UPDATE');
        expect(shiftInsert).toContain('@lbj_pos_restore_bypass');
        expect(shiftInsert).toContain('pos_restore_gate');
        expect(shiftInsert).toContain("'admin', 'manager', 'supervisor', 'cashier'");
        expect(shiftInsert).toContain('EMPLOYEE_ACCESS_DENIED');
        expect(orderInsert).toContain('FOR UPDATE');
        expect(orderInsert).toContain('@lbj_pos_restore_bypass');
        expect(orderInsert).toContain('pos_restore_gate');
        expect(orderInsert).toContain("'admin', 'manager', 'supervisor', 'cashier'");
        expect(orderInsert).toContain('EMPLOYEE_ACCESS_DENIED');
        expect(terminalInsert).toContain('FOR UPDATE');
        expect(terminalInsert).toContain("JSON_EXTRACT(NEW.saleBundle, '$.order.employeeId')");
        expect(terminalInsert).toContain("JSON_EXTRACT(NEW.saleBundle, '$.employeeId')");
        expect(terminalInsert).toContain('EMPLOYEE_ACCESS_DENIED');
        expect((terminalInsert?.match(/SELECT COALESCE\(isActive, 0\), COALESCE\(role, ''\)/g) || []))
            .toHaveLength(1);
        expect(attendanceActiveInsert).toContain('FOR UPDATE');
        expect(attendanceActiveInsert).toContain('ATTENDANCE_ACTOR_INVALID');
        expect(attendanceActiveInsert).toContain('ATTENDANCE_SELF_ONLY');
        expect(attendanceActiveInsert).toContain('manage_attendance');
        expect(attendanceActiveInsert).toContain("ELSEIF attendanceActorRole = 'attendance'");
        expect(attendanceActiveInsert).toContain("JSON_EXTRACT(attendanceRolePermissions, '$.roles') IS NOT NULL");
        expect(attendanceActiveInsert).toContain('pos_attendance_audit_import_sessions');
        expect(attendanceUpdateGuard).toContain('ATTENDANCE_IMMUTABLE_FIELDS');
        expect(attendanceUpdateGuard).toContain('ATTENDANCE_CLOCK_OUT_INVALID');
        expect(attendanceUpdateGuard).toContain('ATTENDANCE_MANAGER_REQUIRED');
        expect(attendanceUpdateGuard).toContain('FOR UPDATE');
        expect(attendanceDeleteGuard).toContain('ATTENDANCE_DELETE_DISABLED');
        expect(attendanceDeleteGuard).toContain('@lbj_pos_restore_bypass');
        expect(attendanceInsertAudit).toContain('attendance_clocked_in');
        expect(attendanceInsertAudit).toContain('attendance_manual_record_added');
        expect(attendanceUpdateAudit).toContain('attendance_clocked_out');
        expect(attendanceUpdateAudit).toContain('attendance_corrected');
        expect(attendanceUpdateAudit).toContain("JSON_OBJECT( 'id', OLD.id");

        const employeeGuardIndex = executedSql.findIndex((sql) =>
            sql.includes('pos_guard_attendance_employee_update'));
        const repairIndex = executedSql.findIndex((sql) =>
            sql.startsWith('UPDATE employees SET role = TRIM'));
        expect(employeeGuardIndex).toBeGreaterThanOrEqual(0);
        expect(repairIndex).toBeGreaterThan(employeeGuardIndex);
    });

    const liveTest = process.env.POS_TEST_MYSQL_HOST
        && process.env.POS_TEST_MYSQL_USER
        && process.env.POS_TEST_MYSQL_DATABASE
        ? it
        : it.skip;

    liveTest('installs the current attendance guards on a configured MariaDB', async () => {
        const database = mysqlCliTestDatabase();

        await ensureAttendanceOnlyRoleGuards(database as never);

        const rows = await database.select(
            `SELECT TRIGGER_NAME AS triggerName,
                    LOCATE('ATTENDANCE_SELF_ONLY', ACTION_STATEMENT) > 0 AS hasSelfGuard,
                    LOCATE('ATTENDANCE_MANAGER_REQUIRED', ACTION_STATEMENT) > 0 AS hasManagerGuard,
                    LOCATE('ATTENDANCE_DELETE_DISABLED', ACTION_STATEMENT) > 0 AS hasDeleteGuard
               FROM INFORMATION_SCHEMA.TRIGGERS
              WHERE TRIGGER_SCHEMA = DATABASE()
                AND TRIGGER_NAME IN (
                  'pos_guard_attendance_active_insert',
                  'pos_guard_attendance_update',
                  'pos_guard_attendance_delete'
                )`,
        ) as Array<{
            triggerName: string;
            hasSelfGuard: string;
            hasManagerGuard: string;
            hasDeleteGuard: string;
        }>;
        expect(rows).toHaveLength(3);
        const guards = new Map(rows.map((row) => [row.triggerName, row]));
        expect(guards.get('pos_guard_attendance_active_insert')?.hasSelfGuard).toBe('1');
        expect(guards.get('pos_guard_attendance_update')?.hasManagerGuard).toBe('1');
        expect(guards.get('pos_guard_attendance_delete')?.hasDeleteGuard).toBe('1');
    });
});

describe('MariaDB attendance clock-in', () => {
    const savedAttendance = {
        id: 'attendance-clock-in-1',
        employeeId: 'employee-1',
        employeeName: 'Cashier One',
        clockInAt: '2026-08-27T08:00:00.000Z',
        clockOutAt: '',
        clockInTillId: 'till-1',
        clockOutTillId: '',
        tillName: 'Till 1',
        status: 'open',
        notes: '',
        createdByEmployeeId: 'employee-1',
        updatedByEmployeeId: 'employee-1',
        createdAt: '2026-08-27T08:00:00.000Z',
        updatedAt: '2026-08-27T08:00:00.000Z',
    } as const;

    it('does not reuse employees as the INSERT source while its trigger locks that table', async () => {
        const execute = vi.fn(async () => ({ rowsAffected: 1 }));
        const select = vi.fn(async () => [savedAttendance]);

        const result = await mysqlInsertOpenEmployeeAttendanceOnDatabase(
            { execute, select } as never,
            savedAttendance.id,
            savedAttendance.employeeId,
            savedAttendance.clockInTillId,
            savedAttendance.updatedByEmployeeId,
        );

        const [sql, params] = execute.mock.calls[0] as unknown as [string, unknown[]];
        const compact = compactSql(sql);
        expect(compact).toMatch(/^INSERT INTO employee_attendance/);
        expect(compact).toContain('VALUES (?, ?');
        expect(compact).not.toContain('FROM employees');
        expect(params).toEqual([
            savedAttendance.id,
            savedAttendance.employeeId,
            savedAttendance.clockInTillId,
            '',
            savedAttendance.updatedByEmployeeId,
            savedAttendance.updatedByEmployeeId,
        ]);
        expect(result).toEqual(savedAttendance);
    });

    it('keeps the inactive-account error friendly when the trigger rejects the actor', async () => {
        const execute = vi.fn(async () => {
            throw new Error('ATTENDANCE_ACTOR_INVALID: sign in again before changing attendance');
        });
        const select = vi.fn(async () => []);

        await expect(mysqlInsertOpenEmployeeAttendanceOnDatabase(
            { execute, select } as never,
            savedAttendance.id,
            savedAttendance.employeeId,
            savedAttendance.clockInTillId,
            savedAttendance.updatedByEmployeeId,
        )).rejects.toThrow('ATTENDANCE_EMPLOYEE_INACTIVE');
        expect(select).not.toHaveBeenCalled();
    });
});

describe('MariaDB attendance correction compare-and-swap', () => {
    const expectedUpdatedAt = '2026-08-22T16:05:03.123Z';
    const correction = {
        id: 'attendance-1',
        employeeId: 'employee-1',
        clockInAt: '2026-08-22T08:00:00.000Z',
        clockOutAt: '2026-08-22T16:00:00.000Z',
        clockInTillId: 'till-1',
        clockOutTillId: 'till-1',
        status: 'closed',
        notes: 'Manager correction',
        createdByEmployeeId: 'employee-1',
        updatedByEmployeeId: 'manager-1',
        createdAt: '2026-08-22T08:00:00.000Z',
        updatedAt: expectedUpdatedAt,
    } as const;

    it('updates a closed row only when its authoritative updatedAt still matches', async () => {
        const saved = { ...correction, updatedAt: '2026-08-22T16:10:00.000Z' };
        const execute = vi.fn(async (_sql: string, _params: unknown[] = []) => ({ rowsAffected: 1 }));
        const select = vi.fn(async () => [saved]);

        const result = await mysqlSaveClosedEmployeeAttendanceOnDatabase(
            { execute, select } as never,
            correction as never,
            expectedUpdatedAt,
        );

        expect(result).toEqual(saved);
        expect(execute).toHaveBeenCalledTimes(1);
        const [sql, params] = execute.mock.calls[0] as unknown as [string, unknown[]];
        expect(compactSql(sql)).toContain("WHERE id = ? AND status = 'closed' AND updatedAt = ?");
        expect(params.at(-1)).toBe(expectedUpdatedAt);
        expect(select).toHaveBeenCalledTimes(1);
    });

    it('fails clearly and does not insert when another till won the correction race', async () => {
        const execute = vi.fn(async (_sql: string, _params: unknown[] = []) => ({ rowsAffected: 0 }));
        const select = vi.fn(async () => []);

        await expect(mysqlSaveClosedEmployeeAttendanceOnDatabase(
            { execute, select } as never,
            correction as never,
            expectedUpdatedAt,
        )).rejects.toThrow('ATTENDANCE_CORRECTION_CONFLICT');

        expect(execute).toHaveBeenCalledTimes(1);
        expect(compactSql(String(execute.mock.calls[0]?.[0] || ''))).toMatch(/^UPDATE employee_attendance/);
        expect(select).not.toHaveBeenCalled();
    });
});

describe('MariaDB employee profile compare-and-swap', () => {
    const originalUpdatedAt = '2026-08-22T16:05:03.123000Z';
    const profile = {
        id: 'employee-cas-1',
        storeId: 'store-main',
        name: 'Cashier One',
        pin: '',
        pinHash: 'pbkdf2-sha256$210000$salt$hash',
        role: 'cashier',
        email: '',
        isActive: true,
        createdAt: '2026-08-20T08:00:00.000Z',
        updatedAt: originalUpdatedAt,
    } as const;

    it('updates only the exact authoritative version and returns the server-stamped row', async () => {
        const saved = { ...profile, name: 'Cashier Renamed', updatedAt: '2026-08-22T16:10:00.456000Z' };
        const execute = vi.fn(async (_sql: string, _params: unknown[] = []) => ({ rowsAffected: 1 }));
        const select = vi.fn(async () => [{ ...saved, isActive: 1 }]);

        const result = await mysqlSaveEmployeeProfileCasOnDatabase(
            { execute, select } as never,
            saved as never,
            originalUpdatedAt,
        );

        expect(result).toEqual(saved);
        const [sql, params] = execute.mock.calls[0] as unknown as [string, unknown[]];
        const compact = compactSql(sql);
        expect(compact).toContain("BINARY COALESCE(e.updatedAt, '') = BINARY ?");
        expect(compact).toContain("attendance.status = 'open'");
        expect(compact).toContain("e.updatedAt = DATE_FORMAT(UTC_TIMESTAMP(3)");
        expect(params.at(-2)).toBe(originalUpdatedAt);
        expect(select).toHaveBeenCalledTimes(1);
    });

    it('rejects a stale edit instead of overwriting another till', async () => {
        const execute = vi.fn(async () => ({ rowsAffected: 0 }));
        const select = vi.fn(async () => []);

        await expect(mysqlSaveEmployeeProfileCasOnDatabase(
            { execute, select } as never,
            profile as never,
            originalUpdatedAt,
        )).rejects.toThrow(EMPLOYEE_PROFILE_CONFLICT_CODE);

        expect(execute).toHaveBeenCalledTimes(1);
        expect(select).not.toHaveBeenCalled();
    });

    it('uses insert-only semantics for a new employee', async () => {
        const serverSaved = { ...profile, id: 'employee-new', updatedAt: '2026-08-22T16:15:00.000000Z' };
        const execute = vi.fn(async (_sql: string, _params: unknown[] = []) => ({ rowsAffected: 1 }));
        const select = vi.fn(async () => [{ ...serverSaved, isActive: 1 }]);

        const result = await mysqlSaveEmployeeProfileCasOnDatabase(
            { execute, select } as never,
            serverSaved as never,
            null,
        );

        const sql = compactSql(String(execute.mock.calls[0]?.[0] || ''));
        expect(sql).toMatch(/^INSERT INTO employees/);
        expect(sql).not.toContain('ON DUPLICATE KEY UPDATE');
        expect(sql).toContain("DATE_FORMAT(UTC_TIMESTAMP(3)");
        expect(result.updatedAt).toBe(serverSaved.updatedAt);
    });

    it('reports a duplicate new employee as a profile conflict', async () => {
        const duplicate = Object.assign(new Error('Duplicate entry'), { code: 1062 });
        const execute = vi.fn(async () => { throw duplicate; });
        const select = vi.fn(async () => []);

        await expect(mysqlSaveEmployeeProfileCasOnDatabase(
            { execute, select } as never,
            profile as never,
            null,
        )).rejects.toThrow(EMPLOYEE_PROFILE_CONFLICT_CODE);

        expect(select).not.toHaveBeenCalled();
    });

    it('distinguishes an open attendance session from an ordinary stale deactivation', async () => {
        const execute = vi.fn(async () => ({ rowsAffected: 0 }));
        const select = vi.fn(async (sql: string) => compactSql(sql).includes('FROM employee_attendance a')
            ? [{ id: 'attendance-open' }]
            : []);

        await expect(mysqlSaveEmployeeProfileCasOnDatabase(
            { execute, select } as never,
            { ...profile, isActive: false } as never,
            originalUpdatedAt,
        )).rejects.toThrow('ATTENDANCE_OPEN_SESSION');
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
            ['employee_attendance', 'employeeId', 'employees', 'id'],
            ['employee_attendance', 'clockInTillId', 'registers', 'id'],
            ['employee_attendance', 'clockOutTillId', 'registers', 'id'],
            ['employee_attendance', 'createdByEmployeeId', 'employees', 'id'],
            ['employee_attendance', 'updatedByEmployeeId', 'employees', 'id'],
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
            ['employee_attendance', 'id'],
            ['employee_attendance', 'openEmployeeId'],
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
                && ['orderId', 'receiptKey', 'employeeId', 'tillNumber', 'shiftId', 'reversesEntryId'].includes(columnName)
                || tableName === 'employee_attendance'
                && ['clockInTillId', 'clockOutTillId', 'createdByEmployeeId', 'updatedByEmployeeId'].includes(columnName);
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
            ['employee_attendance', 'id', 'utf8mb4_general_ci'],
            ['employee_attendance', 'employeeId', 'utf8mb4_unicode_ci'],
            ['employee_attendance', 'clockInTillId', 'utf8mb4_unicode_ci'],
            ['employee_attendance', 'clockOutTillId', 'utf8mb4_unicode_ci'],
            ['employee_attendance', 'createdByEmployeeId', 'utf8mb4_unicode_ci'],
            ['employee_attendance', 'updatedByEmployeeId', 'utf8mb4_unicode_ci'],
            ['employee_attendance', 'openEmployeeId', 'utf8mb4_general_ci'],
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
                && ['orderId', 'receiptKey', 'employeeId', 'tillNumber', 'shiftId', 'reversesEntryId'].includes(columnName)
                || tableName === 'employee_attendance'
                && ['clockInTillId', 'clockOutTillId', 'createdByEmployeeId', 'updatedByEmployeeId'].includes(columnName);
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
        ['employee_attendance', 'id'],
        ['employee_attendance', 'openEmployeeId'],
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

    it('decodes attendance binary IDs without selecting the generated open-session key', () => {
        const projection = compactSql(MYSQL_ATTENDANCE_ROW_PROJECTION);
        expect(projection).toContain('CAST(a.id AS CHAR CHARACTER SET utf8mb4) AS id');
        expect(projection).not.toContain('openEmployeeId');
    });

    it('casts attendance sums to integer types supported by the Tauri SQL bridge', () => {
        const projection = compactSql(MYSQL_ATTENDANCE_SUMMARY_PROJECTION);
        expect(projection).toContain('AS SIGNED) AS workedSeconds');
        expect(projection).toContain('AS SIGNED) AS openCount');
    });
});
