import type { Employee, Setting } from '$lib/stores/db';

export const employeeRoles: Employee['role'][] = ['admin', 'manager', 'supervisor', 'cashier'];

export const roleLabels: Record<Employee['role'], string> = {
    admin: 'Administrator',
    manager: 'Manager',
    supervisor: 'Supervisor',
    cashier: 'Cashier',
};

export const roleDescriptions: Record<Employee['role'], string> = {
    admin: 'Full access to every page and action. Administrator access cannot be reduced.',
    manager: 'Runs catalogue, reports, settings, promotions, stock, and daily operations.',
    supervisor: 'Handles daily approvals, reports, stock receiving, refunds, and end-of-day tasks.',
    cashier: 'Focused on checkout with only the extra actions granted here.',
};

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
    supervisor: [
        'open_reports', 'open_stock_receiving',
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
            // Administrators are the recovery role and must never be locked out.
            admin: [...defaultRolePermissions.admin],
            manager: normalizeRole(parsed.manager, defaultRolePermissions.manager),
            supervisor: normalizeRole(parsed.supervisor, defaultRolePermissions.supervisor),
            cashier: normalizeRole(parsed.cashier, defaultRolePermissions.cashier),
        };
    } catch {
        return defaultRolePermissions;
    }
}

function normalizeRole(value: unknown, fallback: PermissionKey[]): PermissionKey[] {
    if (!Array.isArray(value)) return [...fallback];
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

const routePermissions: Array<{ path: string; permission: PermissionKey }> = [
    { path: '/design', permission: 'open_design' },
    { path: '/tiles', permission: 'open_design' },
    { path: '/items', permission: 'open_items' },
    { path: '/categories', permission: 'open_items' },
    { path: '/customers', permission: 'open_items' },
    { path: '/suppliers', permission: 'open_items' },
    { path: '/tax-rates', permission: 'open_items' },
    { path: '/employees', permission: 'open_employees' },
    { path: '/discounts', permission: 'open_discounts' },
    { path: '/orders', permission: 'open_reports' },
    { path: '/reports', permission: 'open_reports' },
    { path: '/stock-receiving', permission: 'open_stock_receiving' },
    { path: '/sync', permission: 'open_sync' },
    { path: '/audit', permission: 'open_audit' },
    { path: '/settings', permission: 'open_settings' },
];

const adminOnlyPaths = ['/settings/permissions', '/settings/advanced'];
const signedInOperationalPaths = ['/shifts', '/label-print', '/about'];
const publicPaths = ['/', '/customer-display'];

function matchesPath(pathname: string, route: string): boolean {
    return pathname === route || pathname.startsWith(`${route}/`);
}

export function permissionForPath(pathname: string): PermissionKey | null {
    return routePermissions.find((route) => matchesPath(pathname, route.path))?.permission || null;
}

export function isAdminOnlyPath(pathname: string): boolean {
    return adminOnlyPaths.some((path) => matchesPath(pathname, path));
}

export function canAccessPath(
    employee: Employee | null | undefined,
    pathname: string,
    settings: Setting[],
): boolean {
    if (publicPaths.includes(pathname)) return true;
    if (!employee?.isActive) return false;
    if (pathname === '/setup') return employee.role === 'admin';
    if (isAdminOnlyPath(pathname)) return employee.role === 'admin';
    if (signedInOperationalPaths.some((path) => matchesPath(pathname, path))) return true;

    if (matchesPath(pathname, '/admin')) {
        const matrix = parseRolePermissions(settings);
        return (Object.keys(permissionLabels) as PermissionKey[])
            .filter((key) => key.startsWith('open_'))
            .some((key) => matrix[employee.role]?.includes(key));
    }

    const permission = permissionForPath(pathname);
    return permission ? hasPermission(employee, permission, settings) : false;
}
