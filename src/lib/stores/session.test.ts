import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sessionMocks = vi.hoisted(() => ({
    isTauri: vi.fn(() => false),
    getAuthoritativeEmployeeForSession: vi.fn(),
    saveEmployeeProfile: vi.fn(),
    upgradeEmployeeLegacyPin: vi.fn(),
    recordAuditEvent: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({
    isTauri: sessionMocks.isTauri,
}));

vi.mock('./database', () => ({
    getAuthoritativeEmployeeForSession: sessionMocks.getAuthoritativeEmployeeForSession,
    saveEmployeeProfile: sessionMocks.saveEmployeeProfile,
    upgradeEmployeeLegacyPin: sessionMocks.upgradeEmployeeLegacyPin,
    recordAuditEvent: sessionMocks.recordAuditEvent,
}));

import { ATTENDANCE_ONLY_PIN_HASH_PREFIX, employeesDB, type Employee } from './db';
import { connectionState } from './connection';
import {
    authenticateEmployeePin,
    signInToAttendance,
    authorizeAttendanceAction,
    revokeAttendanceSignIn,
    currentShiftId,
    currentEmployeeAuthorizationVersion,
    currentEmployee,
    hashPin,
    isEmployeeAuthorityCheckPending,
    isPosShiftEligibleEmployee,
    logout,
    normalizeEmployeeForManagement,
    normalizeEmployeeForPersistence,
    normalizeEmployeeForRuntime,
    PinRateLimitError,
    revalidateCurrentEmployeeSession,
    REMEMBERED_EMPLOYEE_SESSION_KEY,
    restoreRememberedEmployeeSession,
} from './session';

function employee(id: string, pinHash: string, role: Employee['role'] = 'cashier'): Employee {
    return {
        id,
        storeId: 'store-main',
        name: 'Test Employee',
        pin: '',
        pinHash,
        role,
        email: '',
        isActive: true,
        createdAt: '2026-07-24T12:00:00.000Z',
        updatedAt: '2026-07-24T12:00:00.000Z',
    };
}

async function legacyHash(pin: string): Promise<string> {
    const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(`pos-pin-v1:${pin}`),
    );
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function installWebStorage(): Storage {
    const makeStorage = (): Storage => {
        const values = new Map<string, string>();
        return {
            get length() { return values.size; },
            clear: () => values.clear(),
            getItem: (key: string) => values.get(key) ?? null,
            key: (index: number) => [...values.keys()][index] ?? null,
            removeItem: (key: string) => { values.delete(key); },
            setItem: (key: string, value: string) => { values.set(key, String(value)); },
        } as Storage;
    };
    const session = makeStorage();
    vi.stubGlobal('sessionStorage', session);
    vi.stubGlobal('localStorage', makeStorage());
    return session;
}

beforeEach(() => {
    sessionMocks.isTauri.mockReturnValue(false);
    sessionMocks.getAuthoritativeEmployeeForSession.mockReset();
    sessionMocks.saveEmployeeProfile.mockReset();
    sessionMocks.upgradeEmployeeLegacyPin.mockReset();
    sessionMocks.recordAuditEvent.mockClear();
    connectionState.set({
        mode: 'single',
        mysqlConfig: null,
        mysqlOnline: false,
        mysqlReady: false,
        syncError: null,
    });
});

afterEach(() => {
    logout();
    employeesDB.set([]);
    vi.unstubAllGlobals();
});

describe('employee PIN security', () => {
    it('authenticates a salted PBKDF2 PIN', async () => {
        employeesDB.set([employee('employee-modern', await hashPin('1234'))]);
        const authenticated = await authenticateEmployeePin('employee-modern', '1234');
        expect(authenticated?.id).toBe('employee-modern');
        expect(get(currentEmployee)?.id).toBe('employee-modern');
    });

    it('upgrades a valid legacy hash after login', async () => {
        employeesDB.set([employee('employee-legacy', await legacyHash('2468'))]);
        await authenticateEmployeePin('employee-legacy', '2468');
        expect(get(employeesDB)[0].pinHash).toMatch(/^pbkdf2-sha256\$/);
    });

    it('uses the authoritative MariaDB employee and PIN while the shared database is ready', async () => {
        const cached = employee('employee-authoritative', await hashPin('1111'));
        const authoritative = employee(
            'employee-authoritative',
            `${ATTENDANCE_ONLY_PIN_HASH_PREFIX}${await hashPin('8642')}`,
            'attendance',
        );
        employeesDB.set([cached]);
        connectionState.set({
            mode: 'multi',
            mysqlConfig: null,
            mysqlOnline: true,
            mysqlReady: true,
            syncError: null,
        });
        sessionMocks.getAuthoritativeEmployeeForSession.mockResolvedValue(authoritative);

        const authenticated = await authenticateEmployeePin(cached.id, '8642');

        expect(sessionMocks.getAuthoritativeEmployeeForSession).toHaveBeenCalledWith(cached.id);
        expect(authenticated?.role).toBe('attendance');
        expect(isPosShiftEligibleEmployee(authenticated)).toBe(false);
    });

    it('does not fall back to a cached administrator when a ready MariaDB check fails', async () => {
        const cached = employee('employee-authority-error', await hashPin('1111'), 'admin');
        employeesDB.set([cached]);
        connectionState.set({
            mode: 'multi',
            mysqlConfig: null,
            mysqlOnline: true,
            mysqlReady: true,
            syncError: null,
        });
        sessionMocks.getAuthoritativeEmployeeForSession.mockRejectedValue(new Error('connection lost'));

        await expect(authenticateEmployeePin(cached.id, '1111')).rejects.toThrow('connection lost');
        expect(get(currentEmployee)).toBeNull();
    });

    it('defers cached login while the first MariaDB connection outcome is still pending', async () => {
        const cached = employee('employee-startup-pending', await hashPin('1111'), 'admin');
        employeesDB.set([cached]);
        const state = {
            mode: 'multi' as const,
            mysqlConfig: null,
            mysqlOnline: false,
            mysqlReady: false,
            mysqlStatus: 'pending' as const,
            syncError: null,
        };
        connectionState.set(state);

        expect(isEmployeeAuthorityCheckPending(state)).toBe(true);
        await expect(authenticateEmployeePin(cached.id, '1111')).rejects.toThrow(
            'still checking staff access',
        );
        expect(sessionMocks.getAuthoritativeEmployeeForSession).not.toHaveBeenCalled();
        expect(get(currentEmployee)).toBeNull();
    });

    it('preserves cached sign-in when a multi-till shop is genuinely offline', async () => {
        const cached = employee('employee-offline', await hashPin('1111'));
        employeesDB.set([cached]);
        connectionState.set({
            mode: 'multi',
            mysqlConfig: null,
            mysqlOnline: false,
            mysqlReady: true,
            mysqlStatus: 'offline',
            syncError: 'connection refused',
        });

        const authenticated = await authenticateEmployeePin(cached.id, '1111');

        expect(authenticated?.id).toBe(cached.id);
        expect(sessionMocks.getAuthoritativeEmployeeForSession).not.toHaveBeenCalled();
    });

    it('upgrades a legacy PIN through the narrow authoritative credential path', async () => {
        const authoritative = employee('employee-legacy-cas', await legacyHash('2468'));
        employeesDB.set([authoritative]);
        connectionState.set({
            mode: 'multi',
            mysqlConfig: null,
            mysqlOnline: true,
            mysqlReady: true,
            syncError: null,
        });
        sessionMocks.isTauri.mockReturnValue(true);
        sessionMocks.getAuthoritativeEmployeeForSession.mockResolvedValue(authoritative);
        sessionMocks.upgradeEmployeeLegacyPin.mockImplementation(async (
            saved: Employee,
            _oldPin: string,
            newPinHash: string,
        ) => ({
            ...saved,
            pin: '',
            pinHash: newPinHash,
            updatedAt: '2026-08-22T18:00:00.000000Z',
        }));

        const authenticated = await authenticateEmployeePin(authoritative.id, '2468');

        expect(sessionMocks.upgradeEmployeeLegacyPin).toHaveBeenCalledTimes(1);
        expect(sessionMocks.upgradeEmployeeLegacyPin.mock.calls[0]?.[0]).toBe(authoritative);
        expect(sessionMocks.upgradeEmployeeLegacyPin.mock.calls[0]?.[1]).toBe('2468');
        expect(sessionMocks.upgradeEmployeeLegacyPin.mock.calls[0]?.[2])
            .toMatch(/^pbkdf2-sha256\$/);
        expect(sessionMocks.saveEmployeeProfile).not.toHaveBeenCalled();
        expect(authenticated?.pinHash).toMatch(/^pbkdf2-sha256\$/);
        expect(authenticated?.updatedAt).toBe('2026-08-22T18:00:00.000000Z');
    });

    it('rejects login when a concurrent role change defeats the legacy PIN upgrade CAS', async () => {
        const authoritative = employee('employee-legacy-conflict', await legacyHash('2468'));
        employeesDB.set([authoritative]);
        connectionState.set({
            mode: 'multi',
            mysqlConfig: null,
            mysqlOnline: true,
            mysqlReady: true,
            syncError: null,
        });
        sessionMocks.isTauri.mockReturnValue(true);
        sessionMocks.getAuthoritativeEmployeeForSession.mockResolvedValue(authoritative);
        sessionMocks.upgradeEmployeeLegacyPin.mockRejectedValue(new Error('EMPLOYEE_PROFILE_CONFLICT'));

        await expect(authenticateEmployeePin(authoritative.id, '2468'))
            .rejects.toThrow('EMPLOYEE_PROFILE_CONFLICT');
        expect(get(currentEmployee)).toBeNull();
    });

    it('revokes an existing cached session when reconnect finds an inactive employee', async () => {
        const cached = employee('employee-reconnect', await hashPin('1111'), 'admin');
        currentEmployee.set(cached);
        employeesDB.set([cached]);
        connectionState.set({
            mode: 'multi',
            mysqlConfig: null,
            mysqlOnline: true,
            mysqlReady: true,
            syncError: null,
        });
        sessionMocks.getAuthoritativeEmployeeForSession.mockResolvedValue({
            ...cached,
            isActive: false,
        });

        await expect(revalidateCurrentEmployeeSession()).resolves.toBeNull();
        expect(get(currentEmployee)).toBeNull();
    });

    it('stores an immutable employee version and refuses to restore a changed profile', async () => {
        const storage = installWebStorage();
        const cached = employee('employee-remembered-version', await hashPin('1111'), 'admin');
        employeesDB.set([cached]);

        await authenticateEmployeePin(cached.id, '1111');
        const remembered = JSON.parse(String(storage.getItem(REMEMBERED_EMPLOYEE_SESSION_KEY)));
        expect(remembered).toMatchObject({
            employeeId: cached.id,
            employeeUpdatedAt: cached.updatedAt,
        });

        currentEmployee.set(null);
        employeesDB.set([{ ...cached, updatedAt: '2026-08-22T19:00:00.000Z' }]);

        await expect(restoreRememberedEmployeeSession()).resolves.toBeNull();
        expect(get(currentEmployee)).toBeNull();
        expect(storage.getItem(REMEMBERED_EMPLOYEE_SESSION_KEY)).toBeNull();
    });

    it('logs out on reconnect instead of silently accepting a newer staff profile version', async () => {
        const cached = employee('employee-version-reconnect', await hashPin('1111'), 'admin');
        employeesDB.set([cached]);
        currentEmployee.set(cached);

        connectionState.set({
            mode: 'multi',
            mysqlConfig: null,
            mysqlOnline: true,
            mysqlReady: true,
            mysqlStatus: 'online',
            syncError: null,
        });
        sessionMocks.getAuthoritativeEmployeeForSession.mockResolvedValue({
            ...cached,
            name: 'Changed Elsewhere',
            updatedAt: '2026-08-22T19:05:00.000Z',
        });

        await expect(revalidateCurrentEmployeeSession()).resolves.toBeNull();
        expect(get(currentEmployee)).toBeNull();
    });

    it('does not resurrect a session that signs out during an authoritative check', async () => {
        const cached = employee('employee-revalidation-race', await hashPin('1111'), 'admin');
        employeesDB.set([cached]);
        currentEmployee.set(cached);
        connectionState.set({
            mode: 'multi',
            mysqlConfig: null,
            mysqlOnline: true,
            mysqlReady: true,
            mysqlStatus: 'online',
            syncError: null,
        });
        let resolveAuthority!: (value: Employee) => void;
        sessionMocks.getAuthoritativeEmployeeForSession.mockReturnValue(new Promise((resolve) => {
            resolveAuthority = resolve;
        }));

        const revalidation = revalidateCurrentEmployeeSession();
        logout();
        resolveAuthority(cached);

        await expect(revalidation).resolves.toBeNull();
        expect(get(currentEmployee)).toBeNull();
    });

    it('locks an employee login after five incorrect attempts', async () => {
        employeesDB.set([employee('employee-lockout', await hashPin('1357'))]);
        for (let attempt = 0; attempt < 4; attempt++) {
            await expect(authenticateEmployeePin('employee-lockout', '0000')).resolves.toBeNull();
        }
        await expect(authenticateEmployeePin('employee-lockout', '0000'))
            .rejects.toBeInstanceOf(PinRateLimitError);
        await expect(authenticateEmployeePin('employee-lockout', '1357'))
            .rejects.toBeInstanceOf(PinRateLimitError);
    });

    it('authenticates an attendance-only PIN envelope on an updated till', async () => {
        const protectedHash = `${ATTENDANCE_ONLY_PIN_HASH_PREFIX}${await hashPin('8642')}`;
        employeesDB.set([employee('employee-attendance', protectedHash, 'attendance')]);

        const authenticated = await authenticateEmployeePin('employee-attendance', '8642');

        expect(authenticated?.role).toBe('attendance');
        expect(get(currentEmployee)?.id).toBe('employee-attendance');
        expect(isPosShiftEligibleEmployee(authenticated)).toBe(false);
    });

    it('rejects attendance identities whose PIN guard is missing', async () => {
        employeesDB.set([employee('employee-unguarded-attendance', await hashPin('8642'), 'attendance')]);

        await expect(authenticateEmployeePin('employee-unguarded-attendance', '8642')).resolves.toBeNull();
        expect(get(currentEmployee)).toBeNull();
    });

    it('fails closed for an unknown role even when the PIN is correct', async () => {
        const corrupt = employee('employee-corrupt-role', await hashPin('9753'));
        corrupt.role = 'owner' as Employee['role'];
        employeesDB.set([corrupt]);

        await expect(authenticateEmployeePin('employee-corrupt-role', '9753')).resolves.toBeNull();
        expect(get(currentEmployee)).toBeNull();
        expect(isPosShiftEligibleEmployee(corrupt)).toBe(false);
    });

    it('safely canonicalizes harmless role whitespace before authentication', async () => {
        const whitespaceRole = employee('employee-whitespace-role', await hashPin('7531'));
        whitespaceRole.role = '  cashier  ' as Employee['role'];
        employeesDB.set([whitespaceRole]);

        const authenticated = await authenticateEmployeePin('employee-whitespace-role', '7531');

        expect(authenticated?.role).toBe('cashier');
        expect(isPosShiftEligibleEmployee(authenticated)).toBe(true);
    });

    it('wraps attendance hashes and unwraps them when promoted to a POS role', async () => {
        const standardHash = await hashPin('6420');
        const attendance = normalizeEmployeeForPersistence(
            employee('employee-role-change', standardHash, 'attendance'),
        );
        expect(attendance.pinHash).toBe(`${ATTENDANCE_ONLY_PIN_HASH_PREFIX}${standardHash}`);
        expect(attendance.pin).toBe('');

        const promoted = normalizeEmployeeForPersistence({ ...attendance, role: 'cashier' });
        expect(promoted.pinHash).toBe(standardHash);
        expect(isPosShiftEligibleEmployee(promoted)).toBe(true);
    });

    it('preserves object identity for an already canonical runtime employee', async () => {
        const canonical = employee('employee-canonical-reference', await hashPin('6024'));

        expect(normalizeEmployeeForRuntime(canonical)).toBe(canonical);
    });

    it('keeps repair-marked staff out of authentication until a manager saves the repair', async () => {
        const repairRequired = {
            ...employee('employee-repair-required', await hashPin('2046')),
            pinNeedsReset: true,
        };
        employeesDB.set([repairRequired]);

        expect(normalizeEmployeeForRuntime(repairRequired)).toBeNull();
        await expect(authenticateEmployeePin('employee-repair-required', '2046')).resolves.toBeNull();

        const repaired = normalizeEmployeeForPersistence(repairRequired);
        expect(repaired.pinNeedsReset).toBeUndefined();
        expect(normalizeEmployeeForRuntime(repaired)).toBe(repaired);
    });

    it('keeps reset-required and unknown-role rows visible only for management repair', async () => {
        const resetRequired = employee(
            'employee-reset-required',
            `${ATTENDANCE_ONLY_PIN_HASH_PREFIX}reset-required`,
            'attendance',
        );
        const corruptRole = {
            ...employee('employee-role-repair', await hashPin('2460')),
            role: 'legacy-owner' as Employee['role'],
        };

        const managedReset = normalizeEmployeeForManagement(resetRequired);
        const managedRole = normalizeEmployeeForManagement(corruptRole);

        expect(managedReset).toMatchObject({ role: 'attendance', pinNeedsReset: true });
        expect(managedRole).toMatchObject({
            role: 'legacy-owner',
            roleNeedsRepair: true,
            pinNeedsReset: true,
        });
        expect(normalizeEmployeeForRuntime(managedReset)).toBeNull();
        expect(normalizeEmployeeForRuntime(managedRole)).toBeNull();
    });

    it('does not count an unwrapped reset-required or malformed hash as a usable POS administrator', async () => {
        const resetAdmin = employee('employee-reset-admin', 'reset-required', 'admin');
        const malformedAdmin = employee(
            'employee-malformed-admin',
            'pbkdf2-sha256$210000$not-valid-base64!$also-invalid!',
            'admin',
        );

        for (const unsafe of [resetAdmin, malformedAdmin]) {
            const managed = normalizeEmployeeForManagement(unsafe);
            expect(normalizeEmployeeForRuntime(unsafe)).toBeNull();
            expect(managed).toMatchObject({
                role: 'admin',
                pinNeedsReset: true,
            });
            expect(normalizeEmployeeForRuntime(managed)).toBeNull();
        }
    });

    it('rejects PBKDF2 records whose decoded digest is not SHA-256 length', async () => {
        const valid = await hashPin('2468');
        const [prefix, iterations, salt] = valid.split('$');
        const shortDigest = btoa(String.fromCharCode(...new Uint8Array(24)));
        const longDigest = btoa(String.fromCharCode(...new Uint8Array(40)));

        expect(normalizeEmployeeForRuntime(employee(
            'employee-short-digest',
            `${prefix}$${iterations}$${salt}$${shortDigest}`,
            'admin',
        ))).toBeNull();
        expect(normalizeEmployeeForRuntime(employee(
            'employee-long-digest',
            `${prefix}$${iterations}$${salt}$${longDigest}`,
            'admin',
        ))).toBeNull();
    });

    it('authenticates and upgrades uppercase legacy SHA-256 hashes', async () => {
        const legacy = (await legacyHash('2468')).toUpperCase();
        employeesDB.set([employee('employee-uppercase-legacy', legacy)]);

        const authenticated = await authenticateEmployeePin('employee-uppercase-legacy', '2468');

        expect(authenticated?.id).toBe('employee-uppercase-legacy');
        expect(get(employeesDB)[0]?.pinHash).toMatch(/^pbkdf2-sha256\$/);
    });

    it('keeps valid legacy plaintext staff visible so their PIN can be upgraded', () => {
        const plaintext = {
            ...employee('employee-plaintext-legacy', '', 'admin'),
            pin: '1234',
        };

        expect(normalizeEmployeeForRuntime(plaintext)).toBe(plaintext);
        expect(normalizeEmployeeForPersistence(plaintext)).toMatchObject({ pin: '1234', pinHash: '' });
    });

    it('rejects unknown roles and insecure attendance hashes at the write boundary', async () => {
        const standardHash = await hashPin('4206');
        const legacyAttendanceHash = await legacyHash('4206');
        expect(() => normalizeEmployeeForPersistence({
            ...employee('employee-invalid-write', standardHash),
            role: 'unknown',
        })).toThrow('Choose a valid staff role');
        expect(() => normalizeEmployeeForPersistence(
            employee('employee-legacy-attendance', legacyAttendanceHash, 'attendance'),
        )).toThrow('Attendance-only staff require a secure PIN');
        expect(() => normalizeEmployeeForPersistence(
            employee('employee-reset-required-admin', 'reset-required', 'admin'),
        )).toThrow('Staff PIN needs to be reset');
    });
});

describe('independent staff-clock sign-in', () => {
    it('keeps the cashier, shift and remembered session unchanged and grants one action only', async () => {
        const storage = installWebStorage();
        const cashier = employee('clock-cashier', await hashPin('1111'));
        const worker = employee('clock-worker', `${ATTENDANCE_ONLY_PIN_HASH_PREFIX}${await hashPin('8642')}`, 'attendance');
        employeesDB.set([cashier, worker]);
        await authenticateEmployeePin(cashier.id, '1111');
        currentShiftId.set('open-cashier-shift');
        const remembered = storage.getItem(REMEMBERED_EMPLOYEE_SESSION_KEY);
        const version = currentEmployeeAuthorizationVersion();
        expect(await signInToAttendance(worker.id, '0000')).toBeNull();
        const grant = await signInToAttendance(worker.id, '8642');
        expect(grant?.employee.id).toBe(worker.id);
        await authorizeAttendanceAction(grant!.token, worker.id, worker.id);
        await expect(authorizeAttendanceAction(grant!.token, worker.id, worker.id)).rejects.toThrow('sign in');
        expect(get(currentEmployee)?.id).toBe(cashier.id);
        expect(get(currentShiftId)).toBe('open-cashier-shift');
        expect(currentEmployeeAuthorizationVersion()).toBe(version);
        expect(storage.getItem(REMEMBERED_EMPLOYEE_SESSION_KEY)).toBe(remembered);
    });
    it('rejects revoked, expired and other-person attendance grants', async () => {
        const worker = employee('clock-grant-limits', await hashPin('8642'));
        employeesDB.set([worker]);
        const revoked = await signInToAttendance(worker.id, '8642');
        revokeAttendanceSignIn(revoked!.token);
        await expect(authorizeAttendanceAction(revoked!.token, worker.id, worker.id)).rejects.toThrow('sign in');
        const wrongPerson = await signInToAttendance(worker.id, '8642');
        await expect(authorizeAttendanceAction(wrongPerson!.token, 'another-worker', worker.id)).rejects.toThrow('sign in');
        const expired = await signInToAttendance(worker.id, '8642');
        const time = vi.spyOn(Date, 'now').mockReturnValue(expired!.expiresAt + 1);
        await expect(authorizeAttendanceAction(expired!.token, worker.id, worker.id)).rejects.toThrow('sign in');
        time.mockRestore();
    });
    it('checks authoritative staff again before the action and rejects profile changes', async () => {
        const worker = employee('clock-shared-authority', await hashPin('8642'));
        connectionState.set({ mode: 'multi', mysqlConfig: null, mysqlOnline: true, mysqlReady: true, syncError: null });
        sessionMocks.getAuthoritativeEmployeeForSession.mockResolvedValue(worker);
        const grant = await signInToAttendance(worker.id, '8642');
        sessionMocks.getAuthoritativeEmployeeForSession.mockResolvedValue({ ...worker, isActive: false, updatedAt: 'changed' });
        await expect(authorizeAttendanceAction(grant!.token, worker.id, worker.id)).rejects.toThrow('profile changed');
        expect(sessionMocks.getAuthoritativeEmployeeForSession).toHaveBeenCalledTimes(2);
    });
    it('does not permit cached offline attendance authentication or writes', async () => {
        const worker = employee('clock-offline', await hashPin('8642'));
        employeesDB.set([worker]);
        const grant = await signInToAttendance(worker.id, '8642');
        connectionState.set({ mode: 'multi', mysqlConfig: null, mysqlOnline: false, mysqlReady: false, syncError: null });
        await expect(signInToAttendance(worker.id, '8642')).rejects.toThrow('Connect');
        await expect(authorizeAttendanceAction(grant!.token, worker.id, worker.id)).rejects.toThrow('disconnected');
    });
    it('rate limits repeated incorrect attendance PINs without signing the cashier out', async () => {
        const worker = employee('clock-rate-limit', await hashPin('8642'));
        const cashier = employee('clock-rate-cashier', await hashPin('1111'));
        employeesDB.set([worker, cashier]);
        await authenticateEmployeePin(cashier.id, '1111');
        let limited = false;
        for (let i = 0; i < 10; i++) {
            try { await signInToAttendance(worker.id, '0000'); }
            catch (error) { expect(error).toBeInstanceOf(PinRateLimitError); limited = true; break; }
        }
        expect(limited).toBe(true);
        expect(get(currentEmployee)?.id).toBe(cashier.id);
    });
});
