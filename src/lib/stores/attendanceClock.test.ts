import { afterEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { employeesDB, type Employee, ATTENDANCE_ONLY_PIN_HASH_PREFIX } from './db';
import { connectionState } from './connection';
import { authenticateEmployeePin, currentEmployee, currentShiftId, hashPin, logout, signInToAttendance } from './session';
import { clockInEmployeeAttendance, clockOutEmployeeAttendance, getOpenEmployeeAttendance } from './database';

const profile = (id: string, pinHash: string, role: Employee['role'] = 'cashier'): Employee => ({
    id, pinHash, role, name: id, storeId: 'store-main', pin: '', email: '', isActive: true,
    createdAt: '2026-09-05T09:00:00Z', updatedAt: '2026-09-05T09:00:00Z',
});
afterEach(() => { logout(); employeesDB.set([]); });
describe('staff-clock attendance writes', () => {
    it('records the authenticated worker for clock-in and clock-out without changing the operator', async () => {
        connectionState.set({ mode: 'single', mysqlConfig: null, mysqlOnline: false, mysqlReady: false, syncError: null });
        const cashier = profile('clock-write-cashier', await hashPin('1234'));
        const worker = profile('clock-write-worker', `${ATTENDANCE_ONLY_PIN_HASH_PREFIX}${await hashPin('2468')}`, 'attendance');
        employeesDB.set([cashier, worker]);
        await authenticateEmployeePin(cashier.id, '1234');
        currentShiftId.set('cashier-shift');
        const grant = (await signInToAttendance(worker.id, '2468'))!;
        const attempts = await Promise.allSettled([
            clockInEmployeeAttendance(worker.id, 'till-1', worker.id, '', grant.token),
            clockInEmployeeAttendance(worker.id, 'till-1', worker.id, '', grant.token),
        ]);
        expect(attempts.filter(a => a.status === 'fulfilled')).toHaveLength(1);
        expect(attempts.filter(a => a.status === 'rejected')).toHaveLength(1);
        const open = (await getOpenEmployeeAttendance(worker.id))!;
        expect(open.employeeId).toBe(worker.id);
        expect(open.createdByEmployeeId).toBe(worker.id);
        expect(await getOpenEmployeeAttendance(cashier.id)).toBeNull();
        await expect(clockOutEmployeeAttendance(worker.id, 'till-1', worker.id, open.id, grant.token)).rejects.toThrow('sign in');
        const out = (await signInToAttendance(worker.id, '2468'))!;
        const closed = await clockOutEmployeeAttendance(worker.id, 'till-2', worker.id, open.id, out.token);
        expect(closed.status).toBe('closed');
        expect(closed.updatedByEmployeeId).toBe(worker.id);
        expect(closed.clockOutTillId).toBe('till-2');
        expect(await getOpenEmployeeAttendance(worker.id)).toBeNull();
        expect(get(currentEmployee)?.id).toBe(cashier.id);
        expect(get(currentShiftId)).toBe('cashier-shift');
    });
});
