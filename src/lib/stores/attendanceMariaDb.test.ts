import { execFileSync, spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type Database from '@tauri-apps/plugin-sql';
import type { EmployeeAttendance } from './db';
import { validateClosedAttendance } from '../attendance';
import {
    ensureAttendanceOnlyRoleGuards,
    mysqlAttendanceTransactionOnDatabase,
    mysqlAuthorizeAttendanceIntervalOnDatabase,
    mysqlInsertOpenEmployeeAttendanceOnDatabase,
    mysqlSaveClosedEmployeeAttendanceOnDatabase,
} from './mysql';

// Opt-in only against a separately initialized, socket-only scratch server.
// Never read app configuration or reuse the developer's production DB URI.
const socket = process.env.POS_ATTENDANCE_TEST_SOCKET || '';
const live = socket.startsWith('/tmp/pos-') ? describe : describe.skip;
const databaseName = `pos_test_attendance_${process.pid}`;
const args = ['--no-defaults', `--socket=${socket}`, '-uroot', '--batch', '--raw', '--delimiter=//'];
function quote(value: unknown): string {
    if (value === undefined || value === null) return 'NULL';
    if (typeof value === 'number') return String(value);
    return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

/** One CLI process = one connection, including all transaction statements. */
function pinnedDatabase() {
    const child = spawn('mariadb', [...args, '--force', '--unbuffered', databaseName]);
    let sequence = 0;
    let queue = Promise.resolve();
    let output = '';
    let errors = '';
    let complete: (() => void) | undefined;
    child.stdout.on('data', value => { output += value.toString(); complete?.(); });
    child.stderr.on('data', value => { errors += value.toString(); });
    const run = (sql: string, values: unknown[] = []): Promise<Record<string, string>[]> => {
        const pending = queue.then(() => new Promise<Record<string, string>[]>((resolve, reject) => {
            let index = 0;
            const bound = sql.replace(/\?/g, () => quote(values[index++]));
            if (index !== values.length) return reject(new Error('SQL parameter mismatch'));
            const marker = `pos_attendance_done_${++sequence}`;
            const suffix = `pos_test_end\n${marker}\n`;
            output = ''; errors = '';
            const timer = setTimeout(() => { complete = undefined; reject(new Error('Scratch MariaDB query timed out')); }, 15_000);
            complete = () => {
                if (!output.includes(suffix)) return;
                complete = undefined;
                // Drain the sibling stderr pipe before resolving the marker.
                setImmediate(() => {
                    clearTimeout(timer);
                    if (errors.includes('ERROR')) return reject(new Error(errors.trim()));
                    const lines = output.slice(0, output.indexOf(suffix)).trimEnd().split('\n');
                    const headings = (lines.shift() || '').split('\t');
                    resolve(lines.filter(Boolean).map(line => Object.fromEntries(
                        line.split('\t').map((value, index) => [headings[index], value]),
                    )));
                });
            };
            child.stdin.write(`${bound}//\nSELECT '${marker}' AS pos_test_end//\n`);
        }));
        queue = pending.then(() => undefined, () => undefined);
        return pending;
    };
    return {
        database: {
            select: run,
            execute: async (sql: string, values: unknown[] = []) => {
                const rows = await run(`${sql}//\nSELECT ROW_COUNT() AS rowsAffected`, values);
                return { rowsAffected: Number(rows[0]?.rowsAffected || 0) };
            },
        } as unknown as Database,
        close: () => child.kill(),
    };
}

function record(id: string, employeeId: string, patch: Partial<EmployeeAttendance> = {}): EmployeeAttendance {
    return { id, employeeId, clockInAt: '2026-09-01T08:00:00.000Z', clockOutAt: '2026-09-01T16:00:00.000Z',
        clockInTillId: 'till', clockOutTillId: 'till', status: 'closed', notes: '',
        createdByEmployeeId: 'admin-a', updatedByEmployeeId: 'admin-a', createdAt: '', updatedAt: '', ...patch };
}
async function save(d: Database, row: EmployeeAttendance, expectedVersion = '') {
    return mysqlAttendanceTransactionOnDatabase(d, row.employeeId, row.updatedByEmployeeId, async (locked, stamp) => {
        validateClosedAttendance(row.clockInAt, row.clockOutAt, Date.parse(stamp));
        await mysqlAuthorizeAttendanceIntervalOnDatabase(locked, row);
        return mysqlSaveClosedEmployeeAttendanceOnDatabase(locked, row, expectedVersion);
    });
}

live('serialized authoritative attendance writes (isolated MariaDB)', () => {
    let first: ReturnType<typeof pinnedDatabase>;
    let second: ReturnType<typeof pinnedDatabase>;
    beforeAll(async () => {
        execFileSync('mariadb', [...args, '--execute', `CREATE DATABASE ${databaseName} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci//`], { stdio: 'pipe' });
        first = pinnedDatabase(); second = pinnedDatabase();
        const d = first.database;
        for (const sql of [
            // Legacy employee identifiers retain general_ci while newly added
            // tables/trigger variables inherit unicode_ci. Do not rewrite them.
            `CREATE TABLE employees (id VARCHAR(36) COLLATE utf8mb4_general_ci PRIMARY KEY, storeId TEXT, name TEXT, pin TEXT, pinHash TEXT,
                role VARCHAR(32), email TEXT, isActive INT, createdAt TEXT, updatedAt TEXT) ENGINE=InnoDB`,
            `CREATE TABLE employee_attendance (id VARCHAR(36) PRIMARY KEY, employeeId VARCHAR(36) COLLATE utf8mb4_general_ci,
                clockInAt VARCHAR(40), clockOutAt VARCHAR(40), clockInTillId VARCHAR(36), clockOutTillId VARCHAR(36),
                status VARCHAR(16), notes TEXT, createdByEmployeeId VARCHAR(36), updatedByEmployeeId VARCHAR(36),
                createdAt VARCHAR(40), updatedAt VARCHAR(40),
                openEmployeeId VARCHAR(36) AS (CASE WHEN status='open' THEN employeeId ELSE NULL END) STORED,
                UNIQUE KEY open_session(openEmployeeId), INDEX employee_intervals(employeeId, clockInAt, id)) ENGINE=InnoDB`,
            'CREATE TABLE registers (id VARCHAR(36) PRIMARY KEY, name TEXT)',
            'CREATE TABLE settings (`key` VARCHAR(100) PRIMARY KEY, value LONGTEXT) ENGINE=InnoDB',
            'CREATE TABLE pos_restore_gate (id INT PRIMARY KEY, isActive INT, ownerTillId VARCHAR(36)) ENGINE=InnoDB',
            "INSERT INTO pos_restore_gate VALUES (1,0,'')",
            'CREATE TABLE pos_schema_migrations (name VARCHAR(100) PRIMARY KEY, appliedAt TEXT)',
            'CREATE TABLE shifts (id VARCHAR(36) PRIMARY KEY, employeeId VARCHAR(36))',
            'CREATE TABLE orders (id VARCHAR(36) PRIMARY KEY, employeeId VARCHAR(36))',
            'CREATE TABLE payment_terminal_attempts (id VARCHAR(36) PRIMARY KEY, status VARCHAR(32), saleBundle LONGTEXT)',
            `CREATE TABLE audit_logs (id VARCHAR(36) PRIMARY KEY, employeeId VARCHAR(36), action TEXT, entityType TEXT,
                entityId VARCHAR(36), oldData LONGTEXT, newData LONGTEXT, createdAt TEXT, updatedAt TEXT) ENGINE=InnoDB`,
        ]) await d.execute(sql);
        for (const id of ['admin-a', 'admin-b', 'worker-open', 'worker-closed', 'worker-cas', 'worker-permission',
            ...[1, 2, 3, 4, 5].map(index => `worker-race-${index}`)]) {
            await d.execute("INSERT INTO employees VALUES (?, '', ?, '', '', ?, '', 1, '', '')",
                [id, id, id.startsWith('admin') ? 'admin' : 'cashier']);
        }
        await ensureAttendanceOnlyRoleGuards(d);
    }, 30_000);
    afterAll(() => {
        first?.close(); second?.close();
        // Only this test's generated database is removed, never application data.
        execFileSync('mariadb', [...args, '--execute', `DROP DATABASE ${databaseName}//`], { stdio: 'pipe' });
    });

    it('rejects a completed manual record overlapping an open interval and keeps its audit atomic', async () => {
        const d = first.database;
        await mysqlAttendanceTransactionOnDatabase(d, 'worker-open', 'worker-open', async (locked, stamp) => {
            const open = record('open-session', 'worker-open', { status: 'open', clockInAt: '2026-08-01T08:00:00.000Z', clockOutAt: '' });
            await mysqlAuthorizeAttendanceIntervalOnDatabase(locked, open);
            return mysqlInsertOpenEmployeeAttendanceOnDatabase(locked, open.id, open.employeeId, 'till', open.employeeId, '', open.clockInAt);
        });
        await expect(save(d, record('manual-overlap', 'worker-open'))).rejects.toThrow(/ATTENDANCE_OVERLAP.*open-session/);
        expect(await d.select('SELECT COUNT(*) AS total FROM employee_attendance WHERE employeeId=?', ['worker-open'])).toEqual([{ total: '1' }]);
        expect(await d.select("SELECT COUNT(*) AS total FROM audit_logs WHERE entityId='manual-overlap'")).toEqual([{ total: '0' }]);
        expect(await d.select('SELECT * FROM pos_attendance_write_authority')).toEqual([]);
    });

    it('allows adjacent sessions and exact self corrections, but preserves CAS and interval exclusion', async () => {
        const d = first.database;
        const original = await save(d, record('closed-session', 'worker-closed'));
        await save(d, record('adjacent-session', 'worker-closed', { clockInAt: '2026-09-01T16:00:00.000Z', clockOutAt: '2026-09-01T18:00:00.000Z' }));
        const changed = await save(d, { ...original, notes: 'Correction' }, original.updatedAt);
        expect(changed.notes).toBe('Correction');
        await expect(save(d, { ...changed, clockOutAt: '2026-09-01T17:00:00.000Z' }, changed.updatedAt)).rejects.toThrow('ATTENDANCE_OVERLAP');
        await expect(save(d, { ...changed, notes: 'Stale' }, 'old-version')).rejects.toThrow('ATTENDANCE_CORRECTION_CONFLICT');
    });

    it.each([1, 2, 3, 4, 5])('serializes different managers racing to insert the same worker interval (%i)', async index => {
        const worker = `worker-race-${index}`;
        const attempts = await Promise.allSettled([
            save(first.database, record(`race-a-${index}`, worker)),
            save(second.database, record(`race-b-${index}`, worker, { createdByEmployeeId: 'admin-b', updatedByEmployeeId: 'admin-b' })),
        ]);
        expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        const loser = attempts.find(result => result.status === 'rejected') as PromiseRejectedResult;
        expect(String(loser.reason)).toContain('ATTENDANCE_OVERLAP');
        expect(await first.database.select('SELECT COUNT(*) AS total FROM employee_attendance WHERE employeeId=?', [worker])).toEqual([{ total: '1' }]);
        expect(await first.database.select('SELECT * FROM pos_attendance_write_authority')).toEqual([]);
    });

    it('fails closed for legacy/unserialized writes and still enforces manager permission', async () => {
        await expect(mysqlSaveClosedEmployeeAttendanceOnDatabase(first.database, record('legacy-write', 'worker-permission')))
            .rejects.toThrow('ATTENDANCE_INTERVAL_AUTHORITY_REQUIRED');
        await expect(save(first.database, record('not-manager', 'worker-permission', {
            createdByEmployeeId: 'worker-permission', updatedByEmployeeId: 'worker-permission',
        }))).rejects.toThrow('ATTENDANCE_MANAGER_REQUIRED');
        expect(await first.database.select('SELECT COUNT(*) AS total FROM employee_attendance WHERE employeeId=?', ['worker-permission'])).toEqual([{ total: '0' }]);
    });

    it('validates future times using the locked server transaction clock', async () => {
        await expect(save(first.database, record('future-record', 'worker-cas', {
            clockInAt: '2099-01-01T08:00:00.000Z', clockOutAt: '2099-01-01T16:00:00.000Z',
        }))).rejects.toThrow('future');
        expect(await first.database.select('SELECT * FROM pos_attendance_write_authority')).toEqual([]);
    });
});
