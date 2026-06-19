import type { Employee, Setting } from '$lib/stores/db';

export type PermissionKey =
    | 'open_items'
    | 'open_discounts'
    | 'open_reports'
    | 'open_settings'
    | 'open_employees'
    | 'open_design'
    | 'open_sync'
    | 'open_audit'
    | 'open_stock_receiving'
    | 'price_override'
    | 'refund_void'
    | 'manual_discount'
    | 'end_day_close';

export const permissionLabels: Record<PermissionKey, string> = {
    open_items: 'Open Items',
    open_discounts: 'Open Discounts',
    open_reports: 'Open Reports',
    open_settings: 'Open Settings',
    open_employees: 'Open Employees',
    open_design: 'Open Design Studio',
    open_sync: 'Open Sync Dashboard',
    open_audit: 'Open Audit Log',
    open_stock_receiving: 'Open Stock Receiving',
    price_override: 'Override Prices',
    refund_void: 'Refund / Void Sales',
    manual_discount: 'Apply Manual Discounts',
    end_day_close: 'End Day / Z Report',
};

export type RolePermissionMatrix = Record<Employee['role'], PermissionKey[]>;

export const defaultRolePermissions: RolePermissionMatrix = {
    admin: Object.keys(permissionLabels) as PermissionKey[],
    manager: [
        'open_items', 'open_discounts', 'open_reports', 'open_settings',
        'open_design', 'open_sync', 'open_audit', 'open_stock_receiving',
        'price_override', 'refund_void', 'manual_discount', 'end_day_close',
    ],
    cashier: ['manual_discount'],
};

export function parseRolePermissions(settings: Setting[]): RolePermissionMatrix {
    const raw = settings.find((setting) => setting.key === 'role_permissions')?.value || '';
    if (!raw.trim()) return defaultRolePermissions;
    try {
        const parsed = JSON.parse(raw) as Partial<RolePermissionMatrix>;
        return {
            admin: normalizeRole(parsed.admin, defaultRolePermissions.admin),
            manager: normalizeRole(parsed.manager, defaultRolePermissions.manager),
            cashier: normalizeRole(parsed.cashier, defaultRolePermissions.cashier),
        };
    } catch {
        return defaultRolePermissions;
    }
}

function normalizeRole(value: unknown, fallback: PermissionKey[]): PermissionKey[] {
    if (!Array.isArray(value)) return fallback;
    const allowed = new Set(Object.keys(permissionLabels));
    return value.filter((key): key is PermissionKey => typeof key === 'string' && allowed.has(key));
}

export function hasPermission(
    employee: Employee | null | undefined,
    key: PermissionKey,
    settings: Setting[],
): boolean {
    if (!employee?.isActive) return false;
    const matrix = parseRolePermissions(settings);
    return matrix[employee.role]?.includes(key) || false;
}

export function serializeRolePermissions(matrix: RolePermissionMatrix): string {
    return JSON.stringify(matrix);
}
