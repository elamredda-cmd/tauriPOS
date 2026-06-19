import { writable, get } from 'svelte/store';
import { employeesDB, type Employee } from './db';

export const currentEmployee = writable<Employee | null>(null);
export const currentShiftId = writable<string>('');

function writeSessionAudit(action: 'employee_login' | 'employee_logout', employee: Employee | null): void {
    if (!employee) return;
    void import('./database')
        .then(({ recordAuditEvent }) => recordAuditEvent(
            action,
            'employee',
            employee.id,
            null,
            { id: employee.id, name: employee.name, role: employee.role },
            employee.id,
        ))
        .catch((error) => console.warn(`session: could not audit ${action}:`, error));
}

export async function hashPin(pin: string): Promise<string> {
    const bytes = new TextEncoder().encode(`pos-pin-v1:${pin}`);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

export async function authenticatePin(pin: string): Promise<Employee | null> {
    const hash = await hashPin(pin);
    let employee = get(employeesDB).find((e) =>
        e.isActive && ((e.pinHash && e.pinHash === hash) || (!e.pinHash && e.pin === pin))
    ) || null;
    return finishAuthentication(employee, hash);
}

export async function authenticateEmployeePin(employeeId: string, pin: string): Promise<Employee | null> {
    const hash = await hashPin(pin);
    let employee = get(employeesDB).find((e) =>
        e.id === employeeId &&
        e.isActive &&
        ((e.pinHash && e.pinHash === hash) || (!e.pinHash && e.pin === pin))
    ) || null;
    return finishAuthentication(employee, hash);
}

export async function verifyEmployeePin(employeeId: string, pin: string): Promise<Employee | null> {
    const hash = await hashPin(pin);
    return get(employeesDB).find((e) =>
        e.id === employeeId &&
        e.isActive &&
        ((e.pinHash && e.pinHash === hash) || (!e.pinHash && e.pin === pin))
    ) || null;
}

async function finishAuthentication(employee: Employee | null, hash: string): Promise<Employee | null> {
    if (employee && !employee.pinHash) {
        employee = { ...employee, pinHash: hash, pin: '' };
        employeesDB.update((list) => list.map((e) => e.id === employee?.id ? employee! : e));
        const { upsert } = await import('./database');
        await upsert('employees', employee);
    }
    currentEmployee.set(employee);
    writeSessionAudit('employee_login', employee);
    return employee;
}

export function logout(): void {
    const employee = get(currentEmployee);
    writeSessionAudit('employee_logout', employee);
    currentEmployee.set(null);
    currentShiftId.set('');
}

export function canManage(employee: Employee | null): boolean {
    return employee?.role === 'admin' || employee?.role === 'manager';
}
