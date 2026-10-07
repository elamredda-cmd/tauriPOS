import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    newCheckoutCustomerDraft,
    registerCheckoutCustomer,
    type CheckoutCustomerDraft,
} from './checkoutCustomer';

function customerDraft(overrides: Partial<CheckoutCustomerDraft> = {}): CheckoutCustomerDraft {
    return {
        id: 'checkout-customer-1',
        name: '  Alex Example  ',
        phone: '  07123 456789  ',
        email: '  alex@example.com  ',
        postcode: '  sw1a 1aa  ',
        loyaltyCode: '  lb12345678  ',
        notes: '  Customer requested a receipt  ',
        createdAt: '2026-09-08T09:00:00.000Z',
        updatedAt: '2026-09-08T09:00:00.000Z',
        ...overrides,
    };
}

function dependencies(overrides: { multi?: boolean; online?: boolean } = {}) {
    return {
        multi: false,
        online: true,
        codeInUse: vi.fn(async (_code: string, _id: string): Promise<boolean> => false),
        persist: vi.fn(async (_profile: CheckoutCustomerDraft): Promise<void> => {}),
        ...overrides,
    };
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('checkout customer registration', () => {
    it('creates a blank profile with a generated ID and loyalty code, but no financial fields', () => {
        const draft = newCheckoutCustomerDraft([]);

        expect(draft.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
        expect(draft.loyaltyCode).toMatch(/^LB\d{8}$/);
        expect(draft).toMatchObject({ name: '', phone: '', email: '', postcode: '', notes: '' });
        expect(draft.createdAt).toBe(draft.updatedAt);
        expect(Number.isNaN(Date.parse(draft.createdAt))).toBe(false);
        expect(draft).not.toHaveProperty('loyaltyPoints');
        expect(draft).not.toHaveProperty('accountEnabled');
    });

    it('normalizes a successful profile, persists only profile fields, and returns zero points', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-08T10:00:00.000Z'));
        const draft = {
            ...customerDraft(),
            loyaltyPoints: 900,
            accountEnabled: true,
            accountBalancePence: 12345,
            accountCreditLimitPence: 20000,
            balancePence: 12345,
            isEnabled: true,
        };
        const original = { ...draft };
        const deps = dependencies();
        const profile = {
            id: 'checkout-customer-1',
            name: 'Alex Example',
            phone: '07123 456789',
            email: 'alex@example.com',
            postcode: 'SW1A 1AA',
            loyaltyCode: 'LB12345678',
            notes: 'Customer requested a receipt',
            createdAt: '2026-09-08T09:00:00.000Z',
            updatedAt: '2026-09-08T10:00:00.000Z',
        };

        await expect(registerCheckoutCustomer(draft, deps)).resolves.toEqual({ ...profile, loyaltyPoints: 0 });

        expect(deps.codeInUse).toHaveBeenCalledExactlyOnceWith('LB12345678', 'checkout-customer-1');
        expect(deps.persist).toHaveBeenCalledExactlyOnceWith(profile);
        expect(draft).toEqual(original);
    });

    it('preserves the same ID, creation time and loyalty code when retrying a failed save', async () => {
        vi.useFakeTimers();
        const draft = customerDraft();
        const deps = dependencies();
        deps.persist.mockRejectedValueOnce(new Error('Local cache write failed'));
        vi.setSystemTime(new Date('2026-09-08T10:00:00.000Z'));

        await expect(registerCheckoutCustomer(draft, deps)).rejects.toThrow('Local cache write failed');
        vi.setSystemTime(new Date('2026-09-08T10:01:00.000Z'));
        await expect(registerCheckoutCustomer(draft, deps)).resolves.toMatchObject({
            id: draft.id,
            createdAt: draft.createdAt,
            loyaltyCode: 'LB12345678',
            loyaltyPoints: 0,
        });

        const profiles = deps.persist.mock.calls.map(([profile]) => profile);
        expect(profiles).toHaveLength(2);
        expect(profiles.map(({ id }) => id)).toEqual([draft.id, draft.id]);
        expect(profiles.map(({ createdAt }) => createdAt)).toEqual([draft.createdAt, draft.createdAt]);
        expect(profiles.map(({ loyaltyCode }) => loyaltyCode)).toEqual(['LB12345678', 'LB12345678']);
        expect(profiles.map(({ updatedAt }) => updatedAt)).toEqual([
            '2026-09-08T10:00:00.000Z',
            '2026-09-08T10:01:00.000Z',
        ]);
        expect(deps.codeInUse.mock.calls).toEqual([
            ['LB12345678', draft.id],
            ['LB12345678', draft.id],
        ]);
    });

    it('rejects a duplicate loyalty code before persistence', async () => {
        const deps = dependencies();
        deps.codeInUse.mockResolvedValue(true);

        await expect(registerCheckoutCustomer(customerDraft(), deps)).rejects.toThrow(/already used/i);

        expect(deps.codeInUse).toHaveBeenCalledExactlyOnceWith('LB12345678', 'checkout-customer-1');
        expect(deps.persist).not.toHaveBeenCalled();
    });

    it.each(['', '  \t\n  '])('rejects a missing name %j before any database access', async (name) => {
        const deps = dependencies();

        await expect(registerCheckoutCustomer(customerDraft({ name }), deps)).rejects.toThrow(/name is required/i);

        expect(deps.codeInUse).not.toHaveBeenCalled();
        expect(deps.persist).not.toHaveBeenCalled();
    });

    it.each([
        ['', /loyalty code is required/i],
        ['  ', /loyalty code is required/i],
        ['INVALID@CODE', /only use/i],
        ['X'.repeat(33), /32 characters/i],
    ])('rejects invalid loyalty code %j before any database access', async (loyaltyCode, error) => {
        const deps = dependencies();

        await expect(registerCheckoutCustomer(customerDraft({ loyaltyCode: loyaltyCode as string }), deps))
            .rejects.toThrow(error as RegExp);

        expect(deps.codeInUse).not.toHaveBeenCalled();
        expect(deps.persist).not.toHaveBeenCalled();
    });

    it('rejects offline multi-till creation before any database access', async () => {
        const deps = dependencies({ multi: true, online: false });

        await expect(registerCheckoutCustomer(customerDraft(), deps)).rejects.toThrow(/reconnect to the main database/i);

        expect(deps.codeInUse).not.toHaveBeenCalled();
        expect(deps.persist).not.toHaveBeenCalled();
    });

    it.each([
        { multi: false, online: false },
        { multi: true, online: true },
    ])('allows persistence when connectivity is sufficient: %j', async (connection) => {
        const deps = dependencies(connection);

        await expect(registerCheckoutCustomer(customerDraft(), deps)).resolves.toHaveProperty('loyaltyPoints', 0);

        expect(deps.persist).toHaveBeenCalledTimes(1);
    });

    it('does not persist when loyalty-code verification fails', async () => {
        const deps = dependencies();
        deps.codeInUse.mockRejectedValue(new Error('Could not verify against MariaDB'));

        await expect(registerCheckoutCustomer(customerDraft(), deps)).rejects.toThrow('Could not verify against MariaDB');

        expect(deps.persist).not.toHaveBeenCalled();
    });
});
