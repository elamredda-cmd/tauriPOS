import { describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
    attendanceQueueQuarantineSql,
    bulkPushSettingAllowed,
    bulkPushTableAction,
    completeRecoveredControlledImport,
    LEGACY_STAFF_QUEUE_CONFLICT_REASON,
} from './attendanceSyncPolicy';

function createQuarantineTestDb(): DatabaseSync {
    const db = new DatabaseSync(':memory:');
    db.exec(`
        CREATE TABLE _offline_queue (
            id TEXT PRIMARY KEY, table_name TEXT NOT NULL, operation TEXT NOT NULL,
            data TEXT, created_at TEXT
        );
        CREATE TABLE _sync_conflicts (
            id TEXT PRIMARY KEY, table_name TEXT NOT NULL, operation TEXT NOT NULL,
            data TEXT, reason TEXT NOT NULL, created_at TEXT
        );
        CREATE TABLE employees (
            id TEXT PRIMARY KEY, isActive INTEGER NOT NULL,
            pin TEXT NOT NULL, pinHash TEXT NOT NULL, updatedAt TEXT NOT NULL
        );
        CREATE TABLE employee_attendance (id TEXT PRIMARY KEY);
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updatedAt TEXT);
    `);
    return db;
}

function installQuarantineSql(db: DatabaseSync): void {
    for (const statement of attendanceQueueQuarantineSql()) db.exec(statement);
}

describe('attendance bulk-push policy', () => {
    it('imports staff and attendance only for a controlled empty/replace destination', () => {
        expect(bulkPushTableAction('employees', 'controlled-import'))
            .toBe('paired-staff-attendance-audit');
        expect(bulkPushTableAction('employee_attendance', 'controlled-import')).toBe('skip');
        expect(bulkPushTableAction('audit_logs', 'controlled-import')).toBe('skip');
    });

    it('preserves authoritative staff and attendance during ordinary Force Push', () => {
        expect(bulkPushTableAction('employees', 'preserve-remote')).toBe('skip');
        expect(bulkPushTableAction('employee_attendance', 'preserve-remote')).toBe('skip');
        expect(bulkPushTableAction('audit_logs', 'preserve-remote')).toBe('skip');
        expect(bulkPushTableAction('products', 'preserve-remote')).toBe('generic');
        expect(bulkPushSettingAllowed('role_permissions', 'preserve-remote')).toBe(false);
        expect(bulkPushSettingAllowed(' ROLE_PERMISSIONS ', 'preserve-remote')).toBe(false);
        expect(bulkPushSettingAllowed('store_info', 'preserve-remote')).toBe(true);
        expect(bulkPushSettingAllowed('role_permissions', 'controlled-import')).toBe(true);
    });

    it('finishes local bookkeeping and bypasses normal migration preflight after recovery', async () => {
        const events: string[] = [];
        const recovered = await completeRecoveredControlledImport(
            async () => {
                events.push('native-recovery');
                return true;
            },
            async () => {
                events.push('bootstrap-uploaded-and-full-sync');
            },
        );
        expect(recovered).toBe(true);
        expect(events).toEqual(['native-recovery', 'bootstrap-uploaded-and-full-sync']);

        const bookkeeping = vi.fn(async () => undefined);
        expect(await completeRecoveredControlledImport(async () => false, bookkeeping)).toBe(false);
        expect(bookkeeping).not.toHaveBeenCalled();
    });

    it('never repairs customer points or ledgers from a stale till snapshot', () => {
        for (const table of ['customers', 'customer_accounts', 'customer_account_entries', 'loyalty_logs']) {
            expect(bulkPushTableAction(table, 'preserve-remote')).toBe('skip');
            expect(bulkPushTableAction(table, 'controlled-import')).toBe('generic');
        }
    });
});

describe('legacy attendance outbox quarantine', () => {
    it('atomically diverts new, updated, and already queued rows into conflicts', () => {
        const statements = attendanceQueueQuarantineSql();
        const insertGuard = statements.find(statement =>
            statement.includes('CREATE TRIGGER IF NOT EXISTS quarantine_attendance_queue_insert_v5'))!;
        const updateGuard = statements.find(statement =>
            statement.includes('CREATE TRIGGER IF NOT EXISTS quarantine_attendance_queue_update_v5'))!;
        const cleanup = statements.find(statement =>
            statement.includes('CREATE TRIGGER IF NOT EXISTS quarantine_attendance_queue_upgrade_v5'))!;
        const marker = statements.find(statement =>
            statement.includes("VALUES ('migration_legacy_staff_queue_quarantine_v5'"))!;
        expect(statements).toContain('DROP TRIGGER IF EXISTS quarantine_attendance_queue_insert_v3');
        expect(statements).toContain('DROP TRIGGER IF EXISTS quarantine_attendance_queue_update_v3');
        expect(statements).toContain('DROP TRIGGER IF EXISTS quarantine_attendance_queue_upgrade_v3');
        expect(statements).toContain('DROP TRIGGER IF EXISTS quarantine_attendance_queue_upgrade_v2');
        expect(statements).toContain('DROP TRIGGER IF EXISTS quarantine_attendance_queue_insert_v4');
        expect(statements).toContain('DROP TRIGGER IF EXISTS quarantine_attendance_queue_update_v4');
        expect(statements).toContain('DROP TRIGGER IF EXISTS quarantine_attendance_queue_upgrade_v4');
        expect(insertGuard).toContain('AFTER INSERT ON _offline_queue');
        expect(updateGuard).toContain('AFTER UPDATE ON _offline_queue');
        expect(cleanup).toContain('DELETE FROM employee_attendance');
        expect(cleanup).toContain('UPDATE employees');
        expect(cleanup).toContain("WHERE table_name = 'employees'");
        expect(cleanup).toContain("THEN JSON_OBJECT('id'");
        expect(cleanup).toContain('SET table_name = table_name');
        expect(cleanup).toContain("'sync_ts_employee_attendance', 'sync_ts_employees'");
        expect(marker).toContain('INSERT OR IGNORE INTO settings');
        expect(statements).toContain('DROP TRIGGER IF EXISTS quarantine_attendance_queue_upgrade_v5');
        for (const statement of [insertGuard, updateGuard]) {
            expect(statement).toContain("NEW.table_name IN ('employees', 'employee_attendance')");
            expect(statement).toContain('INSERT OR REPLACE INTO _sync_conflicts');
            expect(statement).toContain('DELETE FROM _offline_queue');
            expect(statement).toContain('DELETE FROM employee_attendance');
            expect(statement).toContain('UPDATE employees');
            expect(statement).toContain("pinHash = 'reset-required'");
            expect(statement).toContain("key = 'sync_ts_employees'");
            expect(statement).toContain(LEGACY_STAFF_QUEUE_CONFLICT_REASON);
            expect(statement).toContain("THEN JSON_OBJECT('id'");
            const employeeConflictPayload = statement
                .split("WHEN NEW.table_name = 'employees' THEN")[1]
                ?.split('ELSE NEW.data')[0] || '';
            expect(employeeConflictPayload).toContain("JSON_OBJECT('id'");
            expect(employeeConflictPayload).not.toContain('pinHash');
            expect(employeeConflictPayload).not.toContain("'$.pin'");
        }
    });

    it('does not delete a rehydrated authoritative row again on the next startup', () => {
        const statements = attendanceQueueQuarantineSql();
        const cleanup = statements.find(statement =>
            statement.includes('CREATE TRIGGER IF NOT EXISTS quarantine_attendance_queue_upgrade_v5'))!;
        const marker = statements.find(statement =>
            statement.includes("VALUES ('migration_legacy_staff_queue_quarantine_v5'"))!;
        expect(cleanup).toContain("AFTER INSERT ON settings");
        expect(marker).toContain('INSERT OR IGNORE');
        // Once the marker exists, INSERT OR IGNORE emits no INSERT event, so
        // the one-shot cleanup cannot run again against retained conflicts.
        expect(marker).not.toContain('REPLACE');
    });

    it('drops the installed v2 upgrade trigger before inserting the v5 marker', () => {
        const db = createQuarantineTestDb();
        try {
            // This is the exact kind of legacy trigger found on an upgraded till.
            // SQLite resolves its unknown function when any settings INSERT is
            // compiled, even when the trigger WHEN clause would be false.
            db.exec(`
                CREATE TRIGGER quarantine_attendance_queue_upgrade_v2
                AFTER INSERT ON settings
                WHEN NEW.key = 'migration_legacy_staff_queue_quarantine_v2'
                BEGIN
                  UPDATE _sync_conflicts
                     SET data = JSON_UNQUOTE(JSON_EXTRACT(data, '$.id'));
                END;
            `);

            expect(() => installQuarantineSql(db)).not.toThrow();
            expect(db.prepare(
                `SELECT COUNT(*) AS count FROM sqlite_master
                  WHERE type = 'trigger' AND name = 'quarantine_attendance_queue_upgrade_v2'`,
            ).get()).toMatchObject({ count: 0 });
            expect(db.prepare(
                `SELECT value FROM settings
                  WHERE key = 'migration_legacy_staff_queue_quarantine_v5'`,
            ).get()).toMatchObject({ value: '1' });
        } finally {
            db.close();
        }
    });

    it('executes fail-closed for every valid JSON payload without a usable text id', () => {
        const db = createQuarantineTestDb();
        try {
            installQuarantineSql(db);
            db.exec(`
                INSERT INTO employees VALUES ('employee-a', 1, '1234', '', 'old-a');
                INSERT INTO employees VALUES ('employee-b', 1, '5678', '', 'old-b');
            `);
            const insertQueue = db.prepare(
                `INSERT INTO _offline_queue
                    (id, table_name, operation, data, created_at)
                 VALUES (?, 'employees', 'upsert', ?, '2026-08-22T10:00:00.000Z')`,
            );

            // A resolvable id quarantines only its matching cache row.
            insertQueue.run('queue-targeted', JSON.stringify({ id: 'employee-a', pin: '9999' }));
            let rows = db.prepare('SELECT id, isActive, pinHash FROM employees ORDER BY id').all() as any[];
            expect(rows.map(row => [row.id, Number(row.isActive)])).toEqual([
                ['employee-a', 0],
                ['employee-b', 1],
            ]);

            for (const [index, payload] of [
                'not-json',
                null,
                '{}',
                JSON.stringify({ name: 'missing id' }),
                JSON.stringify({ id: '' }),
                JSON.stringify({ id: '   ' }),
                JSON.stringify({ id: ['employee-a'] }),
                JSON.stringify({ id: 123 }),
            ].entries()) {
                db.exec(`UPDATE employees
                         SET isActive = 1, pin = '1234', pinHash = '', updatedAt = 'old'`);
                db.exec(`INSERT OR REPLACE INTO settings
                         VALUES ('sync_ts_employees', 'future-watermark', 'now')`);
                insertQueue.run(`queue-unresolvable-${index}`, payload);
                rows = db.prepare('SELECT isActive, pin, pinHash FROM employees').all() as any[];
                expect(rows.every(row => Number(row.isActive) === 0)).toBe(true);
                expect(rows.every(row => row.pin === '' && row.pinHash === 'reset-required')).toBe(true);
                expect(db.prepare('SELECT COUNT(*) AS count FROM _offline_queue').get()).toMatchObject({ count: 0 });
                expect(db.prepare("SELECT COUNT(*) AS count FROM settings WHERE key = 'sync_ts_employees'").get())
                    .toMatchObject({ count: 0 });
                const conflict = db.prepare('SELECT data FROM _sync_conflicts WHERE id = ?')
                    .get(`queue-unresolvable-${index}`) as { data: string };
                expect(conflict.data).toBe('{}');
            }

            db.exec(`
                INSERT INTO employee_attendance VALUES ('attendance-a');
                INSERT INTO employee_attendance VALUES ('attendance-b');
                INSERT INTO settings VALUES ('sync_ts_employee_attendance', 'future-watermark', 'now');
                INSERT INTO _offline_queue
                    (id, table_name, operation, data, created_at)
                VALUES ('queue-attendance-missing-id', 'employee_attendance', 'upsert', '{}', 'now');
            `);
            expect(db.prepare('SELECT COUNT(*) AS count FROM employee_attendance').get())
                .toMatchObject({ count: 0 });
            expect(db.prepare("SELECT COUNT(*) AS count FROM settings WHERE key = 'sync_ts_employee_attendance'").get())
                .toMatchObject({ count: 0 });
        } finally {
            db.close();
        }
    });

    it('one-shot upgrade scrubs and fails closed for pre-v5 conflicts without ids', () => {
        const db = createQuarantineTestDb();
        try {
            db.prepare(`INSERT INTO employees VALUES ('employee-a', 1, '1234', '', 'old')`).run();
            db.prepare(`INSERT INTO _sync_conflicts VALUES
                ('old-conflict', 'employees', 'upsert', ?, ?, 'old')`)
                .run(JSON.stringify({ name: 'legacy', pin: '1234', pinHash: 'secret' }), LEGACY_STAFF_QUEUE_CONFLICT_REASON);
            db.exec(`INSERT INTO settings VALUES ('sync_ts_employees', 'future-watermark', 'now')`);
            installQuarantineSql(db);

            expect(db.prepare("SELECT isActive, pin, pinHash FROM employees WHERE id = 'employee-a'").get())
                .toMatchObject({ isActive: 0, pin: '', pinHash: 'reset-required' });
            expect(db.prepare("SELECT data FROM _sync_conflicts WHERE id = 'old-conflict'").get())
                .toMatchObject({ data: '{}' });
            expect(db.prepare("SELECT COUNT(*) AS count FROM settings WHERE key = 'sync_ts_employees'").get())
                .toMatchObject({ count: 0 });
        } finally {
            db.close();
        }
    });
});
