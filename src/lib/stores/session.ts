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

const PIN_HASH_PREFIX = 'pbkdf2-sha256';
const PIN_HASH_ITERATIONS = 210_000;
const PIN_ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const PIN_LOCKOUT_MS = 60 * 1000;
const MAX_PIN_ATTEMPTS = 5;

type PinAttemptState = {
    failures: number;
    firstFailureAt: number;
    lockedUntil: number;
};

const pinAttempts = new Map<string, PinAttemptState>();

export class PinRateLimitError extends Error {
    retryAfterSeconds: number;

    constructor(retryAfterSeconds: number) {
        super(`Too many incorrect attempts. Try again in ${retryAfterSeconds} seconds.`);
        this.name = 'PinRateLimitError';
        this.retryAfterSeconds = retryAfterSeconds;
    }
}

function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function derivePin(pin: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
    const material = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(pin),
        'PBKDF2',
        false,
        ['deriveBits'],
    );
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
        material,
        256,
    );
    return new Uint8Array(bits);
}

async function legacyPinHash(pin: string): Promise<string> {
    const bytes = new TextEncoder().encode(`pos-pin-v1:${pin}`);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    if (left.length !== right.length) return false;
    let difference = 0;
    for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
    return difference === 0;
}

export async function hashPin(pin: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const digest = await derivePin(pin, salt, PIN_HASH_ITERATIONS);
    return `${PIN_HASH_PREFIX}$${PIN_HASH_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(digest)}`;
}

async function matchesEmployeePin(employee: Employee, pin: string): Promise<{ valid: boolean; upgrade: boolean }> {
    const stored = String(employee.pinHash || '');
    if (stored.startsWith(`${PIN_HASH_PREFIX}$`)) {
        const parts = stored.split('$');
        const iterations = Number(parts[1]);
        if (parts.length !== 4 || !Number.isInteger(iterations) || iterations < 100_000) {
            return { valid: false, upgrade: false };
        }
        try {
            const actual = await derivePin(pin, base64ToBytes(parts[2]), iterations);
            return { valid: equalBytes(actual, base64ToBytes(parts[3])), upgrade: false };
        } catch {
            return { valid: false, upgrade: false };
        }
    }
    if (stored) {
        return { valid: stored === await legacyPinHash(pin), upgrade: true };
    }
    return { valid: employee.pin === pin, upgrade: true };
}

function assertPinAttemptAllowed(key: string): void {
    const state = pinAttempts.get(key);
    if (!state?.lockedUntil) return;
    const remaining = state.lockedUntil - Date.now();
    if (remaining <= 0) {
        pinAttempts.delete(key);
        return;
    }
    throw new PinRateLimitError(Math.ceil(remaining / 1000));
}

function recordFailedPinAttempt(key: string): number {
    const timestamp = Date.now();
    const previous = pinAttempts.get(key);
    const state = !previous || timestamp - previous.firstFailureAt > PIN_ATTEMPT_WINDOW_MS
        ? { failures: 0, firstFailureAt: timestamp, lockedUntil: 0 }
        : previous;
    state.failures += 1;
    if (state.failures >= MAX_PIN_ATTEMPTS) state.lockedUntil = timestamp + PIN_LOCKOUT_MS;
    pinAttempts.set(key, state);
    return state.lockedUntil > timestamp ? Math.ceil((state.lockedUntil - timestamp) / 1000) : 0;
}

export async function authenticatePin(pin: string): Promise<Employee | null> {
    const attemptKey = 'all-employees';
    assertPinAttemptAllowed(attemptKey);
    for (const candidate of get(employeesDB).filter((employee) => employee.isActive)) {
        const match = await matchesEmployeePin(candidate, pin);
        if (match.valid) {
            pinAttempts.delete(attemptKey);
            return finishAuthentication(candidate, pin, match.upgrade);
        }
    }
    const retryAfter = recordFailedPinAttempt(attemptKey);
    if (retryAfter) throw new PinRateLimitError(retryAfter);
    return finishAuthentication(null, pin, false);
}

export async function authenticateEmployeePin(employeeId: string, pin: string): Promise<Employee | null> {
    const attemptKey = `employee:${employeeId}`;
    assertPinAttemptAllowed(attemptKey);
    const employee = get(employeesDB).find((candidate) => candidate.id === employeeId && candidate.isActive) || null;
    const match = employee ? await matchesEmployeePin(employee, pin) : { valid: false, upgrade: false };
    if (!employee || !match.valid) {
        const retryAfter = recordFailedPinAttempt(attemptKey);
        if (retryAfter) throw new PinRateLimitError(retryAfter);
        return finishAuthentication(null, pin, false);
    }
    pinAttempts.delete(attemptKey);
    return finishAuthentication(employee, pin, match.upgrade);
}

export async function verifyEmployeePin(employeeId: string, pin: string): Promise<Employee | null> {
    const attemptKey = `approval:${employeeId}`;
    assertPinAttemptAllowed(attemptKey);
    const employee = get(employeesDB).find((candidate) => candidate.id === employeeId && candidate.isActive) || null;
    if (employee && (await matchesEmployeePin(employee, pin)).valid) {
        pinAttempts.delete(attemptKey);
        return employee;
    }
    const retryAfter = recordFailedPinAttempt(attemptKey);
    if (retryAfter) throw new PinRateLimitError(retryAfter);
    return null;
}

async function finishAuthentication(employee: Employee | null, pin: string, upgradeHash: boolean): Promise<Employee | null> {
    clearSupportExpiryTimer();
    if (employee && upgradeHash) {
        employee = { ...employee, pinHash: await hashPin(pin), pin: '' };
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
