import { writable, get } from 'svelte/store';
import { employeesDB, type Employee } from './db';

export const currentEmployee = writable<Employee | null>(null);
export const currentShiftId = writable<string>('');

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

async function finishAuthentication(employee: Employee | null, hash: string): Promise<Employee | null> {
    if (employee && !employee.pinHash) {
        employee = { ...employee, pinHash: hash, pin: '' };
        employeesDB.update((list) => list.map((e) => e.id === employee?.id ? employee! : e));
        const { upsert } = await import('./database');
        await upsert('employees', employee);
    }
    currentEmployee.set(employee);
    return employee;
}

export function logout(): void {
    currentEmployee.set(null);
    currentShiftId.set('');
}

export function canManage(employee: Employee | null): boolean {
    return employee?.role === 'admin' || employee?.role === 'manager';
}
