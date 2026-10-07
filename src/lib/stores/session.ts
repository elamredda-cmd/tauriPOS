import { writable, get } from 'svelte/store';
import { isTauri } from '@tauri-apps/api/core';
import {
    ATTENDANCE_ONLY_PIN_HASH_PREFIX,
    employeesDB,
    normalizeEmployeeRole,
    type Employee,
    type EmployeeRole,
} from './db';
import { connectionState, type PosConnectionState } from './connection';
import { toast } from './toast';
import type { SupportSessionGrant } from '$lib/supportAccess';

export const currentEmployee = writable<Employee | null>(null);
export const currentShiftId = writable<string>('');

export const REMEMBERED_EMPLOYEE_SESSION_KEY = 'pos_remembered_employee_session_v1';
const REMEMBERED_EMPLOYEE_SESSION_MS = 12 * 60 * 60 * 1000;
const SUPPORT_EMPLOYEE_PREFIX = 'lbj-support-';
let supportExpiryTimer: ReturnType<typeof setTimeout> | null = null;
let authenticatedEmployeeUpdatedAt = '';

// A staff-clock sign-in authorizes one self-service action, never a till session.
const attendanceGrants = new Map<string, { employeeId: string; updatedAt: string; expiresAt: number }>();
export async function signInToAttendance(employeeId: string, pin: string) {
    const state = get(connectionState);
    if (state.mode === 'multi' && (!state.mysqlOnline || !state.mysqlReady)) {
        throw new Error('Connect to the shared database before signing in to attendance.');
    }
    const employee = await verifyEmployeePin(employeeId, pin);
    if (!employee || isSupportEmployee(employee)) return null;
    const now = Date.now();
    for (const [token, grant] of attendanceGrants) {
        if (grant.expiresAt <= now) attendanceGrants.delete(token);
    }
    const token = crypto.randomUUID();
    const expiresAt = now + 2 * 60_000;
    attendanceGrants.set(token, { employeeId: employee.id, updatedAt: String(employee.updatedAt || ''), expiresAt });
    return { token, employee, expiresAt };
}

export function revokeAttendanceSignIn(token: string): void {
    attendanceGrants.delete(token);
}

/** Consume before awaiting so two clicks cannot reuse the same PIN verification. */
export async function authorizeAttendanceAction(token: string, employeeId: string, actorId: string): Promise<void> {
    const grant = attendanceGrants.get(token);
    attendanceGrants.delete(token);
    if (!grant || grant.expiresAt <= Date.now() || grant.employeeId !== employeeId || actorId !== employeeId) {
        throw new Error('Please sign in to the staff clock again.');
    }
    const state = get(connectionState);
    if (state.mode === 'multi' && (!state.mysqlOnline || !state.mysqlReady)) {
        throw new Error('Attendance cannot be saved while the shared database is disconnected. Sign in again when connected.');
    }
    const employee = await resolveEmployeeForAuthentication(employeeId);
    if (!employee?.isActive || isSupportEmployee(employee) || String(employee.updatedAt || '') !== grant.updatedAt) {
        throw new Error('Your staff profile changed. Sign in again before changing attendance.');
    }
}

/** Immutable MariaDB profile version proven when this employee authenticated. */
export function currentEmployeeAuthorizationVersion(): string {
    return authenticatedEmployeeUpdatedAt;
}

type RememberedEmployeeSession = {
    employeeId: string;
    employeeUpdatedAt: string;
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
        if (
            !saved.employeeId
            || !saved.employeeUpdatedAt
            || typeof saved.employeeUpdatedAt !== 'string'
            || typeof saved.expiresAt !== 'number'
        ) {
            clearRememberedEmployeeSession();
            return null;
        }
        if (Date.now() > saved.expiresAt) {
            clearRememberedEmployeeSession();
            return null;
        }
        return {
            employeeId: saved.employeeId,
            employeeUpdatedAt: saved.employeeUpdatedAt,
            expiresAt: saved.expiresAt,
        };
    } catch {
        clearRememberedEmployeeSession();
        return null;
    }
}

function rememberEmployeeSession(employee: Employee): void {
    if (typeof sessionStorage === 'undefined') return;
    const employeeUpdatedAt = String(employee.updatedAt || '');
    if (!employeeUpdatedAt) {
        clearRememberedEmployeeSession();
        return;
    }
    try {
        sessionStorage.setItem(REMEMBERED_EMPLOYEE_SESSION_KEY, JSON.stringify({
            employeeId: employee.id,
            employeeUpdatedAt,
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
    authenticatedEmployeeUpdatedAt = String(employee.updatedAt || '');
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

function cachedRuntimeEmployee(employeeId: string): Employee | null {
    return normalizeEmployeeForRuntime(
        get(employeesDB).find((employee) => employee.id === employeeId),
    );
}

/**
 * MariaDB is authoritative whenever this till says it is online and ready.
 * A failed live check never falls back to a cached administrator. When the
 * till is genuinely offline, the existing cached-login policy is preserved.
 */
async function resolveEmployeeForAuthentication(employeeId: string): Promise<Employee | null> {
    const state = get(connectionState);
    if (state.mode !== 'multi') {
        return cachedRuntimeEmployee(employeeId);
    }
    const status = state.mysqlStatus
        ?? (state.mysqlOnline ? 'online' : state.syncError ? 'offline' : 'pending');
    if (status === 'pending') {
        throw new Error('MariaDB is still checking staff access. Wait for the connection result, then try again.');
    }
    if (status === 'blocked') {
        throw new Error('MariaDB staff access is blocked until the database setup issue is fixed.');
    }
    if (!state.mysqlOnline) {
        if (status !== 'offline') {
            throw new Error('MariaDB has not confirmed that offline staff access is safe yet.');
        }
        return cachedRuntimeEmployee(employeeId);
    }
    if (!state.mysqlReady) {
        throw new Error('MariaDB is still preparing staff access. Wait for sync, then try again.');
    }
    const { getAuthoritativeEmployeeForSession } = await import('./database');
    return getAuthoritativeEmployeeForSession(employeeId);
}

export function isEmployeeAuthorityCheckPending(
    state: PosConnectionState = get(connectionState),
): boolean {
    if (state.mode !== 'multi') return false;
    const status = state.mysqlStatus
        ?? (state.mysqlOnline ? 'online' : state.syncError ? 'offline' : 'pending');
    return status === 'pending' || (state.mysqlOnline && !state.mysqlReady);
}

export function currentEmployeeSessionVersionMatches(employee: Employee): boolean {
    const sessionEmployee = get(currentEmployee);
    if (!sessionEmployee || sessionEmployee.id !== employee.id) return false;
    if (isSupportEmployee(sessionEmployee) || get(connectionState).mode !== 'multi') return true;
    const expectedVersion = authenticatedEmployeeUpdatedAt || String(sessionEmployee.updatedAt || '');
    return Boolean(expectedVersion && String(employee.updatedAt || '') === expectedVersion);
}

export async function restoreRememberedEmployeeSession(): Promise<Employee | null> {
    clearSupportExpiryTimer();
    const saved = readRememberedEmployeeSession();
    if (!saved) return null;
    const employee = await resolveEmployeeForAuthentication(saved.employeeId);
    if (
        !employee?.isActive
        || String(employee.updatedAt || '') !== saved.employeeUpdatedAt
    ) {
        clearRememberedEmployeeSession();
        return null;
    }
    authenticatedEmployeeUpdatedAt = saved.employeeUpdatedAt;
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

function isNormalPbkdf2PinHash(value: string): boolean {
    const parts = value.split('$');
    const iterations = Number(parts[1]);
    const base64 = /^[A-Za-z0-9+/]+={0,2}$/;
    const decodedLength = (encoded: string): number => {
        if (!encoded || encoded.length % 4 !== 0 || !base64.test(encoded)) return -1;
        const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
        return (encoded.length / 4) * 3 - padding;
    };
    return parts.length === 4
        && parts[0] === PIN_HASH_PREFIX
        && Number.isInteger(iterations)
        && iterations >= 100_000
        && iterations <= 1_000_000
        && decodedLength(parts[2]) >= 16
        && decodedLength(parts[2]) <= 64
        && decodedLength(parts[3]) === 32;
}

function isLegacySha256PinHash(value: string): boolean {
    return /^[a-f0-9]{64}$/i.test(value);
}

function hasValidStoredEmployeePin(employee: Pick<Employee, 'pin' | 'pinHash'>): boolean {
    const storedHash = String(employee.pinHash || '');
    if (storedHash) {
        return isNormalPbkdf2PinHash(storedHash) || isLegacySha256PinHash(storedHash);
    }
    return /^\d{4,8}$/.test(String(employee.pin || ''));
}

export function isAttendanceOnlyPinHash(value: unknown): boolean {
    return typeof value === 'string'
        && value.startsWith(ATTENDANCE_ONLY_PIN_HASH_PREFIX)
        && isNormalPbkdf2PinHash(value.slice(ATTENDANCE_ONLY_PIN_HASH_PREFIX.length));
}

/**
 * Canonicalize a staff record before it crosses a database write boundary.
 * Attendance identities receive a PIN envelope that legacy POS builds cannot
 * validate. Promoting one back to a POS role removes that envelope.
 */
export function normalizeEmployeeForPersistence<
    T extends { role: unknown; pinHash?: string; pin?: string },
>(employee: T): T & { role: EmployeeRole; pinHash: string } {
    const role = normalizeEmployeeRole(employee.role);
    if (!role) throw new Error('Choose a valid staff role');

    const storedHash = String(employee.pinHash || '');
    const unwrappedHash = storedHash.startsWith(ATTENDANCE_ONLY_PIN_HASH_PREFIX)
        ? storedHash.slice(ATTENDANCE_ONLY_PIN_HASH_PREFIX.length)
        : storedHash;

    if (role === 'attendance') {
        if (!isNormalPbkdf2PinHash(unwrappedHash)) {
            throw new Error('Attendance-only staff require a secure PIN to be set');
        }
        return {
            ...employee,
            role,
            pin: '',
            pinHash: `${ATTENDANCE_ONLY_PIN_HASH_PREFIX}${unwrappedHash}`,
            roleNeedsRepair: undefined,
            pinNeedsReset: undefined,
        };
    }

    if (!hasValidStoredEmployeePin({
        pin: String(employee.pin || ''),
        pinHash: unwrappedHash,
    })) {
        throw new Error('Staff PIN needs to be reset before this profile can be saved');
    }

    return {
        ...employee,
        role,
        pinHash: unwrappedHash,
        roleNeedsRepair: undefined,
        pinNeedsReset: undefined,
    };
}

/**
 * Validate a hydrated/runtime employee. Unknown roles and broken attendance
 * envelopes are omitted so they cannot become an authenticated session.
 */
export function normalizeEmployeeForRuntime(employee: unknown): Employee | null {
    if (!employee || typeof employee !== 'object') return null;
    const candidate = employee as Employee;
    if (candidate.roleNeedsRepair || candidate.pinNeedsReset) return null;
    const role = normalizeEmployeeRole(candidate.role);
    if (!role) return null;
    const storedHash = String(candidate.pinHash || '');
    if (role === 'attendance') {
        if (!isAttendanceOnlyPinHash(storedHash)) return null;
    } else {
        if (storedHash.startsWith(ATTENDANCE_ONLY_PIN_HASH_PREFIX)) return null;
        if (!hasValidStoredEmployeePin(candidate)) return null;
    }
    return candidate.role === role ? candidate : { ...candidate, role };
}

/**
 * Keep an unsafe staff row visible to administrators for repair without ever
 * making it eligible for login. The repair markers are stripped only by the
 * validated persistence helper after a role/PIN is corrected.
 */
export function normalizeEmployeeForManagement(employee: unknown): Employee | null {
    if (!employee || typeof employee !== 'object') return null;
    const runtimeEmployee = normalizeEmployeeForRuntime(employee);
    if (runtimeEmployee) return runtimeEmployee;
    const candidate = employee as Employee;
    const role = normalizeEmployeeRole(candidate.role);
    return {
        ...candidate,
        role: (role || String(candidate.role || '')) as EmployeeRole,
        roleNeedsRepair: !role,
        // Any row that failed runtime validation receives a fresh PIN during
        // repair. This prevents an unknown role with a legacy/plaintext or
        // reset-required hash from becoming usable merely by changing role.
        pinNeedsReset: true,
    };
}

export function isPosShiftEligibleEmployee(employee: unknown): boolean {
    const normalized = normalizeEmployeeForRuntime(employee);
    return Boolean(normalized?.isActive && normalized.role !== 'attendance');
}

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
    const normalizedEmployee = normalizeEmployeeForRuntime(employee);
    if (!normalizedEmployee) return { valid: false, upgrade: false };
    const protectedHash = String(normalizedEmployee.pinHash || '');
    const stored = normalizedEmployee.role === 'attendance'
        ? protectedHash.slice(ATTENDANCE_ONLY_PIN_HASH_PREFIX.length)
        : protectedHash;
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
        return { valid: stored.toLowerCase() === await legacyPinHash(pin), upgrade: true };
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
    const candidates = get(employeesDB)
        .map(normalizeEmployeeForRuntime)
        .filter((employee): employee is Employee => Boolean(employee?.isActive));
    for (const candidate of candidates) {
        const match = await matchesEmployeePin(candidate, pin);
        if (match.valid) {
            const authoritative = await resolveEmployeeForAuthentication(candidate.id);
            const authoritativeMatch = authoritative
                ? await matchesEmployeePin(authoritative, pin)
                : { valid: false, upgrade: false };
            if (!authoritative?.isActive || !authoritativeMatch.valid) continue;
            pinAttempts.delete(attemptKey);
            return finishAuthentication(authoritative, pin, authoritativeMatch.upgrade);
        }
    }
    const retryAfter = recordFailedPinAttempt(attemptKey);
    if (retryAfter) throw new PinRateLimitError(retryAfter);
    return finishAuthentication(null, pin, false);
}

export async function authenticateEmployeePin(employeeId: string, pin: string): Promise<Employee | null> {
    const attemptKey = `employee:${employeeId}`;
    assertPinAttemptAllowed(attemptKey);
    const employee = await resolveEmployeeForAuthentication(employeeId);
    const match = employee ? await matchesEmployeePin(employee, pin) : { valid: false, upgrade: false };
    if (!employee?.isActive || !match.valid) {
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
    const employee = await resolveEmployeeForAuthentication(employeeId);
    if (employee?.isActive && (await matchesEmployeePin(employee, pin)).valid) {
        pinAttempts.delete(attemptKey);
        return employee;
    }
    const retryAfter = recordFailedPinAttempt(attemptKey);
    if (retryAfter) throw new PinRateLimitError(retryAfter);
    return null;
}

async function finishAuthentication(employee: Employee | null, pin: string, upgradeHash: boolean): Promise<Employee | null> {
    clearSupportExpiryTimer();
    employee = normalizeEmployeeForRuntime(employee);
    if (employee && upgradeHash) {
        const upgradedEmployee = normalizeEmployeeForPersistence({
            ...employee,
            pinHash: await hashPin(pin),
            pin: '',
            updatedAt: new Date().toISOString(),
        });
        if (isTauri()) {
            const state = get(connectionState);
            // Never queue authorization data while a shared server is offline.
            // The valid legacy PIN can still open this intentionally offline
            // till, and it will be upgraded on a later connected login.
            if (state.mode !== 'multi' || state.mysqlOnline) {
                const database = await import('./database');
                employee = state.mode === 'multi'
                    ? await database.upgradeEmployeeLegacyPin(
                        employee,
                        pin,
                        upgradedEmployee.pinHash,
                    )
                    : await database.saveEmployeeProfile(upgradedEmployee, {
                        expectedUpdatedAt: String(employee.updatedAt || ''),
                        previousIsActive: employee.isActive,
                    });
            }
        } else {
            employee = upgradedEmployee;
            employeesDB.update((list) => list.map((candidate) =>
                candidate.id === employee?.id ? employee! : candidate
            ));
        }
    }
    authenticatedEmployeeUpdatedAt = String(employee?.updatedAt || '');
    currentEmployee.set(employee);
    if (employee) rememberEmployeeSession(employee);
    writeSessionAudit('employee_login', employee);
    return employee;
}

/** Re-check an existing session after MariaDB reconnects. */
export async function revalidateCurrentEmployeeSession(): Promise<Employee | null> {
    const sessionEmployee = get(currentEmployee);
    if (!sessionEmployee || isSupportEmployee(sessionEmployee)) return sessionEmployee;
    try {
        const authoritative = await resolveEmployeeForAuthentication(sessionEmployee.id);
        // Signing out or switching user while the live query is in flight must
        // never let its late result resurrect/overwrite the former session.
        if (get(currentEmployee) !== sessionEmployee) return get(currentEmployee);
        if (!authoritative?.isActive) {
            logout();
            return null;
        }
        const expectedVersion = authenticatedEmployeeUpdatedAt
            || String(sessionEmployee.updatedAt || '');
        if (!expectedVersion || String(authoritative.updatedAt || '') !== expectedVersion) {
            logout();
            return null;
        }
        if (authoritative.role === 'attendance') currentShiftId.set('');
        currentEmployee.set(authoritative);
        return authoritative;
    } catch (error) {
        // A till which claims MariaDB is ready must never retain stale admin or
        // checkout rights after the authoritative verification itself fails.
        if (get(currentEmployee) === sessionEmployee) logout();
        throw error;
    }
}

export function logout(): void {
    attendanceGrants.clear();
    const employee = get(currentEmployee);
    writeSessionAudit('employee_logout', employee);
    clearSupportExpiryTimer();
    clearRememberedEmployeeSession();
    authenticatedEmployeeUpdatedAt = '';
    currentEmployee.set(null);
    currentShiftId.set('');
}

export function canManage(employee: Employee | null): boolean {
    const role = normalizeEmployeeRole(employee?.role);
    return role === 'admin' || role === 'manager' || role === 'supervisor';
}
