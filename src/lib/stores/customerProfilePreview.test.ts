import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
    getDb: vi.fn(),
    upsert: vi.fn(),
    getMysqlDb: vi.fn(),
    invoke: vi.fn(),
    load: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', async (original) => ({
    ...await original<typeof import('@tauri-apps/api/core')>(),
    isTauri: () => false,
    invoke: native.invoke,
}));
vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: native.load } }));
vi.mock('./sqlite', async (original) => ({
    ...await original<typeof import('./sqlite')>(),
    getDb: native.getDb,
    upsert: native.upsert,
}));
vi.mock('./connection', async (original) => ({
    ...await original<typeof import('./connection')>(),
    getMysqlDb: native.getMysqlDb,
}));

import { getCustomerAccount, isCustomerLoyaltyCodeInUse, saveCustomerProfile } from './database';
import { connectionState, type PosConnectionState } from './connection';
import { customerAccountsDB, customersDB, type Customer, type CustomerAccount } from './db';

const stamp = '2026-09-08T12:00:00.000Z';
const customer = (id: string, patch: Partial<Customer> = {}): Customer => ({
    id,
    name: 'Preview customer',
    phone: '0123456789',
    email: 'preview@example.invalid',
    postcode: 'SW1A 1AA',
    loyaltyCode: `CODE-${id.toUpperCase()}`,
    loyaltyPoints: 125,
    notes: 'Preview only',
    createdAt: stamp,
    updatedAt: stamp,
    ...patch,
});

describe('browser preview customer profile writes', () => {
    let savedCustomers: Customer[];
    let savedAccounts: CustomerAccount[];
    let savedConnection: PosConnectionState;

    beforeEach(() => {
        vi.clearAllMocks();
        savedCustomers = get(customersDB);
        savedAccounts = get(customerAccountsDB);
        savedConnection = get(connectionState);
        customersDB.set([]);
        customerAccountsDB.set([]);
        // Even a configured shared till must use only the browser preview stores.
        connectionState.set({
            mode: 'multi', mysqlOnline: true, mysqlReady: true,
            mysqlConfig: null, syncError: null,
        });
    });

    afterEach(() => {
        customersDB.set(savedCustomers);
        customerAccountsDB.set(savedAccounts);
        connectionState.set(savedConnection);
        for (const call of Object.values(native)) expect(call).not.toHaveBeenCalled();
    });

    it('adds a normalized profile without trusting incoming points or enabling credit', async () => {
        const input = customer('new', {
            name: '  New customer  ',
            phone: ' 0123456789 ',
            email: ' preview@example.invalid ',
            postcode: ' sw1a 1aa ',
            loyaltyCode: '  card-new  ',
            notes: ' Preview only ',
            loyaltyPoints: 900,
            accountId: 'injected-account',
            accountEnabled: true,
            accountCreditLimitPence: 50_000,
            accountBalancePence: 10_000,
        });
        await saveCustomerProfile(input);

        expect(get(customersDB)).toEqual([customer('new', {
            name: 'New customer', loyaltyCode: 'CARD-NEW', loyaltyPoints: 0,
        })]);
        expect(get(customerAccountsDB)).toEqual([]);
        expect(await getCustomerAccount('new')).toMatchObject({
            isEnabled: false, creditLimitPence: 0, balancePence: 0,
        });
        expect(input.loyaltyCode).toBe('  card-new  ');
        expect(await isCustomerLoyaltyCodeInUse(' card-new ')).toBe(true);
    });

    it('updates only profile fields and preserves existing points, balances, and account settings', async () => {
        const before = customer('existing', {
            accountId: 'account-existing', accountEnabled: true,
            accountCreditLimitPence: 5_000, accountBalancePence: 1_200,
        });
        const account: CustomerAccount = {
            id: 'account-existing', customerId: before.id,
            isEnabled: true, creditLimitPence: 5_000, balancePence: 1_200,
            createdAt: stamp, updatedAt: stamp,
        };
        customersDB.set([before, customer('unrelated')]);
        customerAccountsDB.set([account]);

        await saveCustomerProfile({
            id: before.id, name: ' Edited customer ', loyaltyCode: ' card-edited ',
            loyaltyPoints: 0, accountId: 'wrong', accountEnabled: false,
            accountCreditLimitPence: 0, accountBalancePence: 0,
            createdAt: 'changed', updatedAt: '2026-09-08T12:01:00.000Z',
        }, before);

        expect(get(customersDB)).toEqual([
            { ...before, name: 'Edited customer', loyaltyCode: 'CARD-EDITED', updatedAt: '2026-09-08T12:01:00.000Z' },
            customer('unrelated'),
        ]);
        expect(get(customerAccountsDB)).toEqual([account]);
        expect(await getCustomerAccount(before.id)).toEqual(account);
    });

    it('does not enable an existing disabled credit account through a profile edit', async () => {
        const before = customer('disabled', {
            accountEnabled: false, accountCreditLimitPence: 0, accountBalancePence: 400,
        });
        customersDB.set([before]);
        await saveCustomerProfile({ ...before, accountEnabled: true, accountCreditLimitPence: 90_000 }, before);
        expect(get(customersDB)[0]).toMatchObject({
            accountEnabled: false, accountCreditLimitPence: 0, accountBalancePence: 400,
        });
    });

    it('matches existing codes case-insensitively and allows the current customer to retain a code', async () => {
        customersDB.set([customer('existing', { loyaltyCode: ' mixed-case ' })]);
        expect(await isCustomerLoyaltyCodeInUse(' MIXED-CASE ')).toBe(true);
        expect(await isCustomerLoyaltyCodeInUse('mixed-case', 'existing')).toBe(false);
        expect(await isCustomerLoyaltyCodeInUse('mixed-case', ' existing ')).toBe(false);
        expect(await isCustomerLoyaltyCodeInUse('unused')).toBe(false);

        await saveCustomerProfile({ id: 'existing', name: 'Renamed' }, get(customersDB)[0]);
        expect(get(customersDB)).toHaveLength(1);
        expect(get(customersDB)[0].loyaltyCode).toBe('MIXED-CASE');
    });

    it('rejects duplicate codes on creation and update without changing either profile', async () => {
        const initial = [customer('one', { loyaltyCode: 'CARD-ONE' }), customer('two')];
        customersDB.set(initial);

        await expect(saveCustomerProfile(customer('new', { loyaltyCode: ' card-one ' })))
            .rejects.toThrow('already used');
        await expect(saveCustomerProfile({ id: 'two', loyaltyCode: 'card-one', name: 'Do not save' }, initial[1]))
            .rejects.toThrow('already used');
        expect(get(customersDB)).toEqual(initial);
    });

    it('checks uniqueness during each store update so concurrent saves cannot claim the same code', async () => {
        const results = await Promise.allSettled([
            saveCustomerProfile(customer('one', { loyaltyCode: 'same-code' })),
            saveCustomerProfile(customer('two', { loyaltyCode: 'SAME-CODE' })),
        ]);
        expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
        expect(get(customersDB).map((record) => record.id)).toEqual(['one']);
    });

    it('allows blank legacy codes without treating them as duplicates', async () => {
        customersDB.set([customer('legacy', { loyaltyCode: '' })]);
        expect(await isCustomerLoyaltyCodeInUse('   ')).toBe(false);
        await saveCustomerProfile(customer('another', { loyaltyCode: '  ' }));
        expect(get(customersDB)).toHaveLength(2);
        expect(get(customersDB)[1].loyaltyCode).toBe('');
    });

    it('rejects missing IDs and malformed codes before changing the preview store', async () => {
        await expect(saveCustomerProfile({ name: 'No ID' })).rejects.toThrow('Customer ID is required');
        await expect(saveCustomerProfile({ id: '  ' })).rejects.toThrow('Customer ID is required');
        await expect(saveCustomerProfile(customer('invalid', { loyaltyCode: 'bad@code' })))
            .rejects.toThrow('Loyalty code can only use');
        expect(get(customersDB)).toEqual([]);
    });

    it('rejects an old editor without overwriting the other till phone or points', async () => {
        const before = customer('existing');
        const current = { ...before, phone: 'new phone', loyaltyPoints: 150 };
        customersDB.set([current]);
        await expect(saveCustomerProfile({ ...before, notes: 'New notes' }, before))
            .rejects.toThrow('CUSTOMER_PROFILE_CONFLICT');
        expect(get(customersDB)).toEqual([current]);
    });

    it('allows a profile edit after points changed and safely retries the same edit', async () => {
        const before = customer('existing');
        customersDB.set([{ ...before, loyaltyPoints: 150, updatedAt: 'newer-loyalty' }]);
        await saveCustomerProfile({ ...before, notes: 'New notes' }, before);
        await saveCustomerProfile({ ...before, notes: 'New notes' }, before);
        expect(get(customersDB)[0]).toMatchObject({ notes: 'New notes', loyaltyPoints: 150 });
    });

    it('does not allow a create to overwrite an existing customer or resurrect a deleted edit', async () => {
        const before = customer('existing');
        customersDB.set([before]);
        await expect(saveCustomerProfile({ ...before, name: 'Overwrite' }))
            .rejects.toThrow('CUSTOMER_PROFILE_CONFLICT');
        customersDB.set([]);
        await expect(saveCustomerProfile({ ...before, name: 'Resurrect' }, before))
            .rejects.toThrow('CUSTOMER_PROFILE_CONFLICT');
        expect(get(customersDB)).toEqual([]);
    });
});
