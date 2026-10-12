import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
    actorVersion: '2026-09-01T18:00:00.000Z',
    actor: vi.fn(), open: vi.fn(), byId: vi.fn(), clockIn: vi.fn(), clockOut: vi.fn(), save: vi.fn(),
    localOpen: vi.fn(), upsert: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', async original => ({
    ...await original<typeof import('@tauri-apps/api/core')>(), isTauri: () => true,
}));
vi.mock('./mysql', async original => ({
    ...await original<typeof import('./mysql')>(),
    mysqlGetEmployeeProfileById: native.actor,
    mysqlGetOpenEmployeeAttendance: native.open,
    mysqlGetEmployeeAttendanceById: native.byId,
    mysqlInsertOpenEmployeeAttendance: native.clockIn,
    mysqlCloseOpenEmployeeAttendance: native.clockOut,
    mysqlSaveClosedEmployeeAttendance: native.save,
}));
vi.mock('./sqlite', async original => ({
    ...await original<typeof import('./sqlite')>(),
    getOpenEmployeeAttendance: native.localOpen, upsert: native.upsert,
}));
vi.mock('./session', async original => ({
    ...await original<typeof import('./session')>(),
    currentEmployeeAuthorizationVersion: () => native.actorVersion,
}));

import { clockInEmployeeAttendance, clockOutEmployeeAttendance, saveClosedEmployeeAttendance } from './database';
import { connectionState, type PosConnectionState } from './connection';
import { employeesDB, type Employee, type EmployeeAttendance } from './db';
import { currentEmployee } from './session';

const manager: Employee = { id: 'attendance-manager', name: 'Manager', storeId: 'test-store',
    role: 'admin', isActive: true, pin: '1234', pinHash: '', email: '',
    createdAt: native.actorVersion, updatedAt: native.actorVersion };
const saved: EmployeeAttendance = { id: 'stable-attendance-id', employeeId: manager.id,
    clockInAt: '2026-09-01T08:00:00.000Z', clockOutAt: '2026-09-01T16:00:00.000Z',
    clockInTillId: 'till', clockOutTillId: 'till', status: 'closed', notes: '',
    createdByEmployeeId: manager.id, updatedByEmployeeId: manager.id,
    createdAt: native.actorVersion, updatedAt: native.actorVersion };

describe('attendance mutations wait for authoritative transaction completion', () => {
    let previousConnection: PosConnectionState;
    let previousEmployee: Employee | null;
    let previousEmployees: Employee[];
    beforeEach(() => {
        vi.useFakeTimers(); vi.clearAllMocks();
        previousConnection = get(connectionState);
        previousEmployee = get(currentEmployee); previousEmployees = get(employeesDB);
        currentEmployee.set(manager); employeesDB.set([manager]);
        connectionState.set({ mode: 'multi', mysqlOnline: true, mysqlReady: true, syncError: null,
            mysqlConfig: { host: 'test.invalid', port: 3306, user: 'test', password: '', database: 'isolated' } });
        native.actor.mockResolvedValue(manager);
        native.open.mockResolvedValue(null); native.byId.mockResolvedValue(null);
        native.localOpen.mockResolvedValue(null); native.upsert.mockResolvedValue(undefined);
    });
    afterEach(() => {
        connectionState.set(previousConnection);
        currentEmployee.set(previousEmployee); employeesDB.set(previousEmployees);
        vi.useRealTimers();
    });

    it.each(['clock-in', 'clock-out', 'manual-save'] as const)(
        '%s stays pending beyond the former seven-second UI timeout and returns the single committed result',
        async action => {
            let commit!: (row: EmployeeAttendance) => void;
            const transaction = new Promise<EmployeeAttendance>(resolve => { commit = resolve; });
            const method = action === 'clock-in' ? native.clockIn : action === 'clock-out' ? native.clockOut : native.save;
            method.mockReturnValue(transaction);
            if (action === 'clock-out') native.open.mockResolvedValueOnce({ ...saved, status: 'open', clockOutAt: '' });
            const operation = action === 'clock-in'
                ? clockInEmployeeAttendance(manager.id, 'till', manager.id)
                : action === 'clock-out'
                    ? clockOutEmployeeAttendance(manager.id, 'till', manager.id, saved.id)
                    : saveClosedEmployeeAttendance({ ...saved, updatedAt: '' }, manager.id);
            let state = 'pending';
            void operation.then(() => { state = 'fulfilled'; }, error => { state = String(error); });
            await vi.advanceTimersByTimeAsync(0);
            expect(state).toBe('pending');
            expect(method).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(20_000);
            expect(state).toBe('pending');
            const committed = action === 'clock-in'
                ? { ...saved, id: method.mock.calls[0][0], status: 'open' as const, clockOutAt: '' }
                : saved;
            commit(committed);
            await expect(operation).resolves.toEqual(committed);
            expect(method).toHaveBeenCalledTimes(1);
            if (action === 'clock-out') expect(method).toHaveBeenCalledWith(saved.id, manager.id, 'till', manager.id);
            if (action === 'manual-save') expect(method.mock.calls[0][0].id).toBe(saved.id);
        },
    );

    it('reports a delayed transaction rejection only after rollback completes and never retries the save', async () => {
        let rollback!: (reason: Error) => void;
        native.save.mockReturnValue(new Promise<EmployeeAttendance>((_, reject) => { rollback = reject; }));
        const operation = saveClosedEmployeeAttendance({ ...saved, updatedAt: '' }, manager.id);
        let state = 'pending';
        void operation.then(() => { state = 'fulfilled'; }, () => { state = 'rejected'; });
        await vi.advanceTimersByTimeAsync(20_000);
        expect(state).toBe('pending');
        rollback(new Error('ATTENDANCE_OVERLAP: another record won'));
        await expect(operation).rejects.toThrow('ATTENDANCE_OVERLAP');
        expect(native.save).toHaveBeenCalledTimes(1);
        expect(native.upsert.mock.calls.filter(call => call[0] === 'employee_attendance')).toEqual([]);
    });
});
