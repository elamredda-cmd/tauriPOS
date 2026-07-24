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
        });
        const parsed = parseRolePermissions(roleSetting(value));

        expect(parsed.manager).toContain('open_items');
        expect(parsed.manager).toContain('open_reports');
        expect(parsed.manager).not.toContain('open_suppliers');
        expect(parsed.manager).not.toContain('open_tax_rates');
        expect(parsed.manager).not.toContain('open_orders');
    });
});

describe('page permission routing', () => {
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
        }));

        expect(canAccessPath(manager, '/orders', settings)).toBe(true);
        expect(canAccessPath(manager, '/reports', settings)).toBe(false);
    });

    it('restricts Shop Licence to administrators', () => {
        expect(canAccessPath(manager, '/settings/licence', [])).toBe(false);
    });
});
