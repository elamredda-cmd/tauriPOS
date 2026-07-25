import { get } from 'svelte/store';
import { afterEach, describe, expect, it } from 'vitest';

import { employeesDB, type Employee } from './db';
import {
    authenticateEmployeePin,
    currentEmployee,
    hashPin,
    PinRateLimitError,
} from './session';

function employee(id: string, pinHash: string): Employee {
    return {
        id,
        storeId: 'store-main',
        name: 'Test Employee',
        pin: '',
        pinHash,
        role: 'cashier',
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

afterEach(() => {
    currentEmployee.set(null);
    employeesDB.set([]);
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
});
