import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from '@tauri-apps/plugin-sql';
import type { EmployeeAttendance } from './db';
import { saveClosedEmployeeAttendanceOnDatabase } from './sqlite';

const stamp = '2026-09-01T18:00:00.000Z';
const columns = ['id', 'employeeId', 'clockInAt', 'clockOutAt', 'clockInTillId', 'clockOutTillId',
    'status', 'notes', 'createdByEmployeeId', 'updatedByEmployeeId', 'createdAt', 'updatedAt'] as const;
function record(patch: Partial<EmployeeAttendance> = {}): EmployeeAttendance {
    return { id: 'record', employeeId: 'worker', clockInAt: '2026-09-01T08:00:00.000Z',
        clockOutAt: '2026-09-01T16:00:00.000Z', clockInTillId: 'till', clockOutTillId: 'till',
        status: 'closed', notes: '', createdByEmployeeId: 'manager', updatedByEmployeeId: 'manager',
        createdAt: stamp, updatedAt: stamp, ...patch };
}

describe('atomic authoritative attendance writes (isolated SQLite)', () => {
    let sqlite: DatabaseSync;
    let db: Database;
    let beforeWrite: (() => void) | undefined;
    const seed = (row: EmployeeAttendance) => sqlite.prepare(
        `INSERT INTO employee_attendance (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
    ).run(...columns.map(column => row[column]));
    beforeEach(() => {
        sqlite = new DatabaseSync(':memory:');
        sqlite.exec(`CREATE TABLE employee_attendance (${columns.map(column => `${column} TEXT ${column === 'id' ? 'PRIMARY KEY' : 'NOT NULL'}`).join(',')});
            CREATE INDEX attendance_employee ON employee_attendance(employeeId);`);
        beforeWrite = undefined;
        db = {
            async select<T>(sql: string, values: any[] = []) { return sqlite.prepare(sql).all(...values) as T; },
            async execute(sql: string, values: any[] = []) {
                const race = beforeWrite; beforeWrite = undefined; race?.();
                return { rowsAffected: Number(sqlite.prepare(sql).run(...values).changes) };
            },
        } as Database;
    });
    afterEach(() => sqlite.close());

    it('rejects the audited completed shift inside an old, still-open session', async () => {
        seed(record({ id: 'open-from-august', clockInAt: '2026-08-05T08:00:00.000Z', clockOutAt: '', status: 'open' }));
        await expect(saveClosedEmployeeAttendanceOnDatabase(db, record())).rejects.toThrow(/open-from-august.*still clocked in/);
        expect(sqlite.prepare('SELECT COUNT(*) AS count FROM employee_attendance').get()?.count).toBe(1);
    });

    it.each([
        ['07:00', '09:00'], ['09:00', '10:00'], ['15:00', '17:00'], ['07:00', '17:00'], ['08:00', '16:00'],
    ])('rejects overlapping closed sessions %s–%s', async (start, end) => {
        seed(record({ id: 'existing', clockInAt: `2026-09-01T${start}:00Z`, clockOutAt: `2026-09-01T${end}:00Z` }));
        await expect(saveClosedEmployeeAttendanceOnDatabase(db, record())).rejects.toThrow('ATTENDANCE_OVERLAP');
    });

    it('allows adjacent boundaries, another employee, and correcting only the same record', async () => {
        seed(record({ id: 'before', clockInAt: '2026-09-01T06:00:00Z', clockOutAt: '2026-09-01T08:00:00Z' }));
        seed(record({ id: 'after', clockInAt: '2026-09-01T16:00:00Z', clockOutAt: '2026-09-01T18:00:00Z' }));
        seed(record({ id: 'different-worker', employeeId: 'other-worker' }));
        const saved = await saveClosedEmployeeAttendanceOnDatabase(db, record());
        expect(saved.id).toBe('record');
        expect((await saveClosedEmployeeAttendanceOnDatabase(db, record({ notes: 'Correction', updatedAt: '2026-09-01T18:01:00.000Z' }), stamp)).notes).toBe('Correction');
        await expect(saveClosedEmployeeAttendanceOnDatabase(db, record({ notes: 'Stale edit' }), stamp)).rejects.toThrow('ATTENDANCE_CORRECTION_CONFLICT');
    });

    it('checks the new employee when reassigning a corrected record', async () => {
        seed(record());
        seed(record({ id: 'other-session', employeeId: 'other-worker' }));
        await expect(saveClosedEmployeeAttendanceOnDatabase(db,
            record({ employeeId: 'other-worker' }), stamp)).rejects.toThrow('ATTENDANCE_OVERLAP');
        expect(sqlite.prepare("SELECT employeeId FROM employee_attendance WHERE id='record'").get()?.employeeId).toBe('worker');
    });

    it('rejects an overlap inserted after any application preflight but before the write', async () => {
        beforeWrite = () => seed(record({ id: 'concurrent-winner' }));
        await expect(saveClosedEmployeeAttendanceOnDatabase(db, record())).rejects.toThrow('concurrent-winner');
        expect(sqlite.prepare('SELECT COUNT(*) AS count FROM employee_attendance').get()?.count).toBe(1);
    });

    it('never converts a stale/new ID into an unversioned overwrite', async () => {
        seed(record());
        await expect(saveClosedEmployeeAttendanceOnDatabase(db, record({ notes: 'collision' }))).rejects.toThrow('ATTENDANCE_CORRECTION_CONFLICT');
        beforeWrite = () => sqlite.prepare("UPDATE employee_attendance SET updatedAt='new-version' WHERE id='record'").run();
        await expect(saveClosedEmployeeAttendanceOnDatabase(db, record({ notes: 'race' }), stamp)).rejects.toThrow('ATTENDANCE_CORRECTION_CONFLICT');
        expect(sqlite.prepare("SELECT notes FROM employee_attendance WHERE id='record'").get()?.notes).toBe('');
    });
});
