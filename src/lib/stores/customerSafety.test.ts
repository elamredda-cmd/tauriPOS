import { DatabaseSync } from 'node:sqlite';
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
    getDb: vi.fn(), getMysqlDb: vi.fn(), invoke: vi.fn(), upsert: vi.fn(),
    getCustomerById: vi.fn(), commitBatch: vi.fn(), getAccount: vi.fn(), ping: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', async original => ({
    ...await original<typeof import('@tauri-apps/api/core')>(), isTauri: () => true, invoke: native.invoke,
}));
vi.mock('./sqlite', async original => ({
    ...await original<typeof import('./sqlite')>(), getDb: native.getDb, upsert: native.upsert,
    getCustomerById: native.getCustomerById, commitBatch: native.commitBatch,
}));
vi.mock('./mysql', async original => ({
    ...await original<typeof import('./mysql')>(), mysqlGetCustomerAccount: native.getAccount,
}));
vi.mock('./connection', async original => ({
    ...await original<typeof import('./connection')>(), getMysqlDb: native.getMysqlDb, pingMysql: native.ping,
}));

import { getCustomerLoyaltySnapshot, saveCustomerAccountConfig, saveCustomerProfile, upsert } from './database';
import { connectionState, type PosConnectionState } from './connection';
import { customersDB, customerAccountsDB, type Customer, type CustomerAccount } from './db';

const stamp = '2026-09-09T12:00:00.000Z';
const profile: Customer = {
    id: 'customer', name: 'Customer', phone: '123', email: '', postcode: '',
    loyaltyCode: 'CUSTOMER-1', notes: '', loyaltyPoints: 150, createdAt: stamp, updatedAt: stamp,
};

describe('native customer safety boundaries', () => {
    let db: DatabaseSync;
    let savedConnection: PosConnectionState;
    let savedCustomers: Customer[];
    let savedAccounts: CustomerAccount[];
    let local: { select: ReturnType<typeof vi.fn>; execute: ReturnType<typeof vi.fn> };
    let remote: { select: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        vi.clearAllMocks();
        savedConnection = get(connectionState);
        savedCustomers = get(customersDB);
        savedAccounts = get(customerAccountsDB);
        customersDB.set([profile]);
        db = new DatabaseSync(':memory:');
        db.exec(`CREATE TABLE customers (id TEXT PRIMARY KEY, name TEXT, phone TEXT, email TEXT, postcode TEXT,
            loyaltyCode TEXT, notes TEXT, loyaltyPoints INTEGER DEFAULT 0, createdAt TEXT, updatedAt TEXT);
            CREATE TABLE loyalty_logs (id TEXT PRIMARY KEY, customerId TEXT, orderId TEXT, pointsChange INTEGER, reason TEXT, createdAt TEXT);
            CREATE TABLE orders (id TEXT PRIMARY KEY, orderNumber INTEGER);`);
        db.prepare('INSERT INTO customers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(profile.id, profile.name, profile.phone, profile.email, profile.postcode, profile.loyaltyCode,
                profile.notes, profile.loyaltyPoints, profile.createdAt, profile.updatedAt);
        local = {
            select: vi.fn(async (sql: string, params: any[] = []) => {
                if (sql.includes('FROM settings')) return [{ value: 'dataset-current' }];
                if (sql.includes('FROM customers')) return db.prepare(sql).all(...params);
                return [];
            }),
            execute: vi.fn(async (sql: string, params: any[] = []) => {
                if (sql.includes('customers')) return { rowsAffected: Number(db.prepare(sql).run(...params).changes) };
                return { rowsAffected: 1 };
            }),
        };
        remote = { select: vi.fn(async (sql: string, params: any[] = []) => db.prepare(sql).all(...params)) };
        native.getDb.mockResolvedValue(local);
        native.getMysqlDb.mockResolvedValue(remote);
        native.upsert.mockResolvedValue(undefined);
        native.commitBatch.mockResolvedValue(1);
        native.getCustomerById.mockImplementation(async id => db.prepare('SELECT * FROM customers WHERE id = ?').get(id) ?? null);
        native.getAccount.mockResolvedValue({ id: 'customer', customerId: 'customer', isEnabled: false,
            creditLimitPence: 0, balancePence: 700, createdAt: stamp, updatedAt: stamp });
        native.invoke.mockResolvedValue({ id: 'customer', customerId: 'customer', isEnabled: true,
            creditLimitPence: 5000, balancePence: 700, createdAt: stamp, updatedAt: stamp });
        connectionState.set({ mode: 'multi', mysqlOnline: true, mysqlReady: true, syncError: null,
            mysqlConfig: { host: 'test.invalid', port: 3306, user: 'test', password: '', database: 'isolated' } });
    });
    afterEach(() => {
        db.close();
        connectionState.set(savedConnection);
        customersDB.set(savedCustomers);
        customerAccountsDB.set(savedAccounts);
        vi.restoreAllMocks();
    });

    it('passes the cached dataset epoch when saving live Pay Later settings', async () => {
        const result = await saveCustomerAccountConfig({ customerId: 'customer', isEnabled: true, creditLimitPence: 5000, employeeId: 'admin' });
        expect(native.invoke).toHaveBeenCalledWith('save_online_customer_account_config', expect.objectContaining({
            input: { customerId: 'customer', isEnabled: true, creditLimitPence: 5000, employeeId: 'admin', serverDataEpoch: 'dataset-current' },
        }));
        expect(result.balancePence).toBe(700);
    });

    it('does not cache or report success when the native epoch guard rejects a setting change', async () => {
        native.getAccount.mockResolvedValue({ id: 'customer', customerId: 'customer', createdAt: '', balancePence: 0 });
        native.invoke.mockRejectedValue(new Error('SERVER_DATA_EPOCH_MISMATCH'));
        await expect(saveCustomerAccountConfig({ customerId: 'customer', isEnabled: true, creditLimitPence: 5000 }))
            .rejects.toThrow('SERVER_DATA_EPOCH_MISMATCH');
        expect(native.upsert).not.toHaveBeenCalled();
        expect(native.commitBatch).not.toHaveBeenCalled();
    });

    it('keeps a successful account save successful if the audit cache fails afterwards', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        native.commitBatch.mockRejectedValueOnce(new Error('Audit disk unavailable'));
        await expect(saveCustomerAccountConfig({ customerId: 'customer', isEnabled: true, creditLimitPence: 5000 }))
            .resolves.toMatchObject({ isEnabled: true, balancePence: 700 });
        expect(native.invoke).toHaveBeenCalledTimes(1);
        // Only the existing account read may cache; the committed result is
        // already cached natively and must not be redundantly replayed here.
        expect(native.upsert).toHaveBeenCalledTimes(1);
    });

    it('sends the original profile to native CAS and does not retry after a failed display refresh', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        remote.select.mockRejectedValueOnce(new Error('Display refresh unavailable'));
        await expect(saveCustomerProfile({ ...profile, notes: 'Changed', loyaltyPoints: 0 }, profile))
            .resolves.toBeUndefined();
        expect(native.invoke).toHaveBeenCalledWith('commit_mysql_outbox_operation', expect.objectContaining({
            tableName: 'customers', operation: 'customerProfile', serverDataEpoch: 'dataset-current',
            data: { id: 'customer', before: profile, customer: {
                id: 'customer', name: profile.name, phone: profile.phone, email: '', postcode: '',
                loyaltyCode: profile.loyaltyCode, notes: 'Changed', createdAt: stamp, updatedAt: stamp,
            } },
        }));
        expect(native.invoke).toHaveBeenCalledTimes(1);
        expect(get(customersDB)[0].loyaltyPoints).toBe(150);
    });

    it('reads live points and bounded history together, even when receipts were deleted', async () => {
        db.exec(`INSERT INTO loyalty_logs VALUES ('earned', 'customer', 'deleted-receipt', 50, 'earned', '2026-09-09T11:00:00Z');`);
        customersDB.set([{ ...profile, loyaltyPoints: 100 }]);
        const result = await getCustomerLoyaltySnapshot('customer');
        expect(result.source).toBe('server');
        expect(result.customer?.loyaltyPoints).toBe(150);
        expect(result.history).toMatchObject([{ id: 'earned', orderNumber: null, pointsChange: 50 }]);
        expect(remote.select).toHaveBeenCalledTimes(1);
        expect(local.select).not.toHaveBeenCalled();
        expect(native.upsert).not.toHaveBeenCalled();
        expect(get(customersDB)[0].loyaltyPoints).toBe(100);
    });

    it('does not fall back to cached points after a failed live query', async () => {
        remote.select.mockRejectedValue(new Error('Connection lost'));
        await expect(getCustomerLoyaltySnapshot('customer')).rejects.toThrow('Connection lost');
        expect(local.select).not.toHaveBeenCalled();
    });

    it('distinguishes a customer without history from a deleted customer', async () => {
        expect(await getCustomerLoyaltySnapshot('customer')).toMatchObject({ customer: { id: 'customer' }, history: [] });
        expect(await getCustomerLoyaltySnapshot('missing')).toEqual({ customer: null, history: [], source: 'server' });
    });

    it('updates a local profile without touching concurrently earned points', async () => {
        connectionState.update(state => ({ ...state, mode: 'single' }));
        db.exec("UPDATE customers SET loyaltyPoints = 175 WHERE id = 'customer'");
        await saveCustomerProfile({ ...profile, notes: 'New notes', loyaltyPoints: 0 }, profile);
        expect(db.prepare('SELECT notes, loyaltyPoints FROM customers').get())
            .toMatchObject({ notes: 'New notes', loyaltyPoints: 175 });
    });

    it('rejects local simultaneous profile changes inside the UPDATE, not only before it', async () => {
        connectionState.update(state => ({ ...state, mode: 'single' }));
        const execute = local.execute.getMockImplementation() as (...args: any[]) => Promise<{ rowsAffected: number }>;
        local.execute.mockImplementationOnce(async (...args: any[]) => {
            db.exec("UPDATE customers SET phone = 'other-screen' WHERE id = 'customer'");
            return execute(...args);
        });
        await expect(saveCustomerProfile({ ...profile, notes: 'New notes' }, profile))
            .rejects.toThrow('CUSTOMER_PROFILE_CONFLICT');
        expect(db.prepare('SELECT phone, notes, loyaltyPoints FROM customers').get())
            .toMatchObject({ phone: 'other-screen', notes: '', loyaltyPoints: 150 });
    });

    it('rejects generic customer writes that could bypass the profile/loyalty commands', async () => {
        connectionState.update(state => ({ ...state, mode: 'single' }));
        await expect(upsert('customers', { ...profile, loyaltyPoints: 0 })).rejects.toThrow('Use saveCustomerProfile');
        expect(native.commitBatch).not.toHaveBeenCalled();
    });
});
