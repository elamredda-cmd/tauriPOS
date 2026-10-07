import { describe, expect, it } from 'vitest';
import type { Employee, Setting } from '$lib/stores/db';
import {
    canAccessPath,
    parseRolePermissions,
    permissionForPath,
    serializeRolePermissions,
} from '$lib/permissions';

const manager: Employee = {
    id: 'manager-1',
    storeId: 'store-1',
    name: 'Manager',
    email: '',
    pin: '',
    pinHash: '',
    role: 'manager',
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
};

const attendanceEmployee: Employee = {
    ...manager,
    id: 'attendance-1',
    name: 'Attendance Staff',
    role: 'attendance',
};

function roleSetting(value: string): Setting[] {
    return [{ key: 'role_permissions', value, updatedAt: '2026-01-01T00:00:00.000Z' }];
}

describe('role permission migrations', () => {
    it('preserves page access when loading a version 2 custom role', () => {
        const parsed = parseRolePermissions(roleSetting(JSON.stringify({
            version: 2,
            roles: {
                manager: ['open_items', 'open_reports'],
                supervisor: [],
                cashier: [],
            },
        })));

        expect(parsed.manager).toEqual(expect.arrayContaining([
            'open_items',
            'open_suppliers',
            'open_tax_rates',
            'open_reports',
            'open_orders',
        ]));
    });

    it('respects separately disabled permissions after saving version 3', () => {
        const value = serializeRolePermissions({
            admin: [],
            manager: ['open_items', 'open_reports'],
            supervisor: [],
            cashier: [],
            attendance: [],
        });
        const parsed = parseRolePermissions(roleSetting(value));

        expect(parsed.manager).toContain('open_items');
        expect(parsed.manager).toContain('open_reports');
        expect(parsed.manager).not.toContain('open_suppliers');
        expect(parsed.manager).not.toContain('open_tax_rates');
        expect(parsed.manager).not.toContain('open_orders');
    });

    it('adds the immutable attendance role when loading a legacy matrix', () => {
        const parsed = parseRolePermissions(roleSetting(JSON.stringify({
            version: 5,
            roles: {
                manager: [],
                supervisor: [],
                cashier: [],
            },
        })));

        expect(parsed.attendance).toEqual([]);
    });

    it('serializes version 7 and strips permissions from the attendance role', () => {
        const serialized = serializeRolePermissions({
            admin: [],
            manager: [],
            supervisor: [],
            cashier: [],
            attendance: ['open_settings', 'open_reports'],
        });
        const stored = JSON.parse(serialized);
        const parsed = parseRolePermissions(roleSetting(serialized));

        expect(stored.version).toBe(7);
        expect(stored.roles.attendance).toEqual([]);
        expect(parsed.attendance).toEqual([]);
    });

    it('grants new loyalty corrections only through defaults or an explicit custom permission', () => {
        expect(parseRolePermissions([]).manager).toContain('adjust_customer_loyalty');
        expect(parseRolePermissions([]).supervisor).not.toContain('adjust_customer_loyalty');

        const existingCustom = parseRolePermissions(roleSetting(JSON.stringify({
            version: 6,
            roles: {
                manager: ['open_customers'],
                supervisor: [],
                cashier: [],
            },
        })));
        expect(existingCustom.manager).not.toContain('adjust_customer_loyalty');

        const explicitCustom = parseRolePermissions(roleSetting(serializeRolePermissions({
            admin: [],
            manager: ['open_customers', 'adjust_customer_loyalty'],
            supervisor: [],
            cashier: [],
            attendance: [],
        })));
        expect(explicitCustom.manager).toContain('adjust_customer_loyalty');
    });
});

describe('page permission routing', () => {
    it('keeps private cash control restricted to active administrators, not support sessions', () => {
        const route = '/settings/cash-control';
        expect(canAccessPath({ ...manager, role: 'admin' }, route, [])).toBe(true);
        for (const role of ['manager', 'supervisor', 'cashier', 'attendance'] as const) {
            expect(canAccessPath({ ...manager, role }, route, [])).toBe(false);
        }
        expect(canAccessPath(null, route, [])).toBe(false);
        expect(canAccessPath({ ...manager, role: 'admin', isActive: false }, route, [])).toBe(false);
        expect(canAccessPath({ ...manager, role: 'admin', isSupportSession: true }, route, [])).toBe(false);
    });
    it('assigns design access to every Design Studio route', () => {
        expect(permissionForPath('/settings/layout')).toBe('open_design');
        expect(permissionForPath('/settings/labels')).toBe('open_design');
        expect(permissionForPath('/settings/receipt')).toBe('open_design');
    });

    it('keeps Orders independent from Reports', () => {
        const settings = roleSetting(serializeRolePermissions({
            admin: [],
            manager: ['open_orders'],
            supervisor: [],
            cashier: [],
            attendance: [],
        }));

        expect(canAccessPath(manager, '/orders', settings)).toBe(true);
        expect(canAccessPath(manager, '/reports', settings)).toBe(false);
    });

    it('protects Cash-up Sessions with report or end-day permission', () => {
        const reportSettings = roleSetting(serializeRolePermissions({
            admin: [],
            manager: ['open_reports'],
            supervisor: [],
            cashier: [],
            attendance: [],
        }));
        const closeSettings = roleSetting(serializeRolePermissions({
            admin: [],
            manager: ['end_day_close'],
            supervisor: [],
            cashier: [],
            attendance: [],
        }));
        const deniedSettings = roleSetting(serializeRolePermissions({
            admin: [],
            manager: [],
            supervisor: [],
            cashier: [],
            attendance: [],
        }));

        expect(permissionForPath('/shifts')).toBe('open_reports');
        expect(canAccessPath(manager, '/shifts', reportSettings)).toBe(true);
        expect(canAccessPath(manager, '/shifts', closeSettings)).toBe(true);
        expect(canAccessPath(manager, '/shifts', deniedSettings)).toBe(false);
    });

    it('restricts Shop Licence to administrators', () => {
        expect(canAccessPath(manager, '/settings/licence', [])).toBe(false);
    });

    it('keeps personal attendance available to every signed-in staff member', () => {
        const noExtraPermissions = roleSetting(serializeRolePermissions({
            admin: [],
            manager: [],
            supervisor: [],
            cashier: [],
            attendance: [],
        }));

        expect(permissionForPath('/attendance')).toBe(null);
        expect(canAccessPath(manager, '/attendance', noExtraPermissions)).toBe(true);
    });

    it('limits attendance-only staff to their personal attendance route', () => {
        const tamperedSettings = roleSetting(JSON.stringify({
            version: 6,
            roles: {
                admin: [],
                manager: [],
                supervisor: [],
                cashier: [],
                attendance: ['open_settings', 'open_reports', 'end_day_close'],
            },
        }));

        expect(canAccessPath(attendanceEmployee, '/attendance', tamperedSettings)).toBe(true);
        expect(canAccessPath(attendanceEmployee, '/attendance/history', tamperedSettings)).toBe(true);
        expect(canAccessPath(attendanceEmployee, '/admin', tamperedSettings)).toBe(false);
        expect(canAccessPath(attendanceEmployee, '/settings', tamperedSettings)).toBe(false);
        expect(canAccessPath(attendanceEmployee, '/reports', tamperedSettings)).toBe(false);
        expect(canAccessPath(attendanceEmployee, '/items', tamperedSettings)).toBe(false);
        expect(canAccessPath(attendanceEmployee, '/label-print', tamperedSettings)).toBe(false);
        expect(canAccessPath(attendanceEmployee, '/about', tamperedSettings)).toBe(false);
    });

    it('keeps the shared root available as the public staff login entry', () => {
        expect(canAccessPath(null, '/', [])).toBe(true);
        expect(canAccessPath(attendanceEmployee, '/', [])).toBe(true);
    });

    it('fails closed on protected routes for an unknown runtime role', () => {
        const corruptEmployee = { ...manager, role: 'owner' as Employee['role'] };

        expect(canAccessPath(corruptEmployee, '/admin', [])).toBe(false);
        expect(canAccessPath(corruptEmployee, '/items', [])).toBe(false);
        expect(canAccessPath(corruptEmployee, '/attendance', [])).toBe(false);
        // The root itself remains public so a different valid employee can sign in.
        expect(canAccessPath(corruptEmployee, '/', [])).toBe(true);
    });

    it('canonicalizes surrounding whitespace on a known runtime role', () => {
        const whitespaceManager = { ...manager, role: '  manager  ' as Employee['role'] };

        expect(canAccessPath(whitespaceManager, '/admin', [])).toBe(true);
        expect(canAccessPath(whitespaceManager, '/settings', [])).toBe(true);
    });

    it('keeps management-visible repair rows out of protected routes', () => {
        const resetRequiredAdmin = { ...manager, role: 'admin' as const, pinNeedsReset: true };

        expect(canAccessPath(resetRequiredAdmin, '/admin', [])).toBe(false);
        expect(canAccessPath(resetRequiredAdmin, '/settings', [])).toBe(false);
        expect(canAccessPath(resetRequiredAdmin, '/', [])).toBe(true);
    });
});
