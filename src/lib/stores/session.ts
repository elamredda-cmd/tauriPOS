import { writable, get } from 'svelte/store';
import { isTauri } from '@tauri-apps/api/core';
import { employeesDB, type Employee } from './db';
import { toast } from './toast';
import type { SupportSessionGrant } from '$lib/supportAccess';

export const currentEmployee = writable<Employee | null>(null);
export const currentShiftId = writable<string>('');

export const REMEMBERED_EMPLOYEE_SESSION_KEY = 'pos_remembered_employee_session_v1';
const REMEMBERED_EMPLOYEE_SESSION_MS = 12 * 60 * 60 * 1000;
const SUPPORT_EMPLOYEE_PREFIX = 'lbj-support-';
let supportExpiryTimer: ReturnType<typeof setTimeout> | null = null;

type RememberedEmployeeSession = {
    employeeId: string;
    expiresAt: number;
};

function readRememberedEmployeeSession(): RememberedEmployeeSession | null {
    if (typeof sessionStorage === 'undefined') return null;
    try {
        // Remove the former persistent login. Employee authentication should
        // survive a page reload, but never a full application restart.
        if (typeof localStorage !== 'undefined') {
            localStorage.removeItem(REMEMBERED_EMPLOYEE_SESSION_KEY);
        }
        const raw = sessionStorage.getItem(REMEMBERED_EMPLOYEE_SESSION_KEY);
        if (!raw) return null;
        const saved = JSON.parse(raw) as Partial<RememberedEmployeeSession>;
        if (!saved.employeeId || typeof saved.expiresAt !== 'number') return null;
        if (Date.now() > saved.expiresAt) {
            clearRememberedEmployeeSession();
            return null;
        }
        return { employeeId: saved.employeeId, expiresAt: saved.expiresAt };
    } catch {
        clearRememberedEmployeeSession();
        return null;
    }
}

function rememberEmployeeSession(employee: Employee): void {
    if (typeof sessionStorage === 'undefined') return;
    try {
        sessionStorage.setItem(REMEMBERED_EMPLOYEE_SESSION_KEY, JSON.stringify({
            employeeId: employee.id,
            expiresAt: Date.now() + REMEMBERED_EMPLOYEE_SESSION_MS,
        }));
    } catch {
        // If storage is unavailable, keep the normal in-memory session behavior.
    }
}

function clearSupportExpiryTimer(): void {
    if (!supportExpiryTimer) return;
    clearTimeout(supportExpiryTimer);
    supportExpiryTimer = null;
}

export function isSupportEmployee(employee: Employee | null | undefined): boolean {
    return Boolean(employee?.isSupportSession || employee?.id.startsWith(SUPPORT_EMPLOYEE_PREFIX));
}

export function startSupportSession(grant: SupportSessionGrant): Employee {
    const expiresAt = new Date(grant.expiresAt).getTime();
    const remaining = expiresAt - Date.now();
    if (!Number.isFinite(expiresAt) || remaining <= 0) {
        throw new Error('This support session has already expired');
    }
    clearRememberedEmployeeSession();
    clearSupportExpiryTimer();
    const employee: Employee = {
        id: `${SUPPORT_EMPLOYEE_PREFIX}${grant.sessionId}`,
        storeId: 'store-main',
        name: grant.actorName || 'L&Bj Support',
        pin: '',
        pinHash: '',
        role: 'admin',
        email: '',
        isActive: true,
        createdAt: grant.issuedAt,
        updatedAt: grant.issuedAt,
        isSupportSession: true,
        supportSessionId: grant.sessionId,
        supportExpiresAt: grant.expiresAt,
    };
    currentShiftId.set('');
    currentEmployee.set(employee);
    writeSessionAudit('employee_login', employee);
    supportExpiryTimer = setTimeout(() => {
        if (get(currentEmployee)?.id !== employee.id) return;
        logout();
        toast('L&Bj Support access expired. Create a new request to continue.', 'info');
    }, remaining);
    return employee;
}

export function clearRememberedEmployeeSession(): void {
    try {
        if (typeof sessionStorage !== 'undefined') {
            sessionStorage.removeItem(REMEMBERED_EMPLOYEE_SESSION_KEY);
        }
        if (typeof localStorage !== 'undefined') {
            localStorage.removeItem(REMEMBERED_EMPLOYEE_SESSION_KEY);
        }
    } catch {
        // Nothing else to do; the active in-memory session is still controlled below.
    }
}

export function restoreRememberedEmployeeSession(): Employee | null {
    clearSupportExpiryTimer();
    const saved = readRememberedEmployeeSession();
    if (!saved) return null;
    const employee = get(employeesDB).find((e) => e.id === saved.employeeId && e.isActive) || null;
    if (!employee) {
        clearRememberedEmployeeSession();
        return null;
    }
    currentEmployee.set(employee);
    return employee;
}

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
    clearSupportExpiryTimer();
    if (employee && !employee.pinHash) {
        employee = { ...employee, pinHash: hash, pin: '' };
        employeesDB.update((list) => list.map((e) => e.id === employee?.id ? employee! : e));
        if (isTauri()) {
            const { upsert } = await import('./database');
            await upsert('employees', employee);
        }
    }
    currentEmployee.set(employee);
    if (employee) rememberEmployeeSession(employee);
    writeSessionAudit('employee_login', employee);
    return employee;
}

export function logout(): void {
    const employee = get(currentEmployee);
    writeSessionAudit('employee_logout', employee);
    clearSupportExpiryTimer();
    clearRememberedEmployeeSession();
    currentEmployee.set(null);
    currentShiftId.set('');
}

export function canManage(employee: Employee | null): boolean {
    return employee?.role === 'admin' || employee?.role === 'manager' || employee?.role === 'supervisor';
}
