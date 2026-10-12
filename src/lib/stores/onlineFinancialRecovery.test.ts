import { get } from 'svelte/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ invoke: vi.fn(), select: vi.fn() }));
vi.mock('@tauri-apps/api/core', async original => ({ ...await original<typeof import('@tauri-apps/api/core')>(), isTauri: () => true, invoke: native.invoke }));
vi.mock('./sqlite', async original => ({ ...await original<typeof import('./sqlite')>(), getDb: async () => ({ select: native.select }) }));

import { commitSale, pendingOnlineFinancialIntent, pendingOnlineFinancialReadError, recoverOnlineFinancialIntent, refreshPendingOnlineFinancialIntent, type SaleBundle } from './database';
import { currentEmployee } from './session';
import { settingsDB, type Employee } from './db';
import { connectionState } from './connection';

const row = { operation: 'customer_account_sale', orderId: 'saved-order', createdAt: '2026-10-12', lastError: 'pool timed out',
    bundleJson: JSON.stringify({ order: { id: 'saved-order', total: 169, orderNumber: 1000083, customerId: 'saved-customer', employeeId: 'cashier' }, lines: [] }) };

beforeEach(() => {
    vi.resetAllMocks();
    settingsDB.set([]);
    pendingOnlineFinancialIntent.set(null);
    pendingOnlineFinancialReadError.set('');
    currentEmployee.set({ id: 'cashier', role: 'cashier', isActive: true, updatedAt: 'auth-version' } as Employee);
    connectionState.set({ mode: 'multi', mysqlOnline: true, mysqlReady: true, syncError: null, mysqlConfig: { host: 'invalid.test', port: 3306, database: 'isolated', user: 'test', password: '' } });
    native.select.mockResolvedValue([row]);
});

describe('durable online intent review and recovery routing', () => {
    it('rebuilds review after navigation/restart without writing or calling a terminal', async () => {
        await refreshPendingOnlineFinancialIntent();
        expect(get(pendingOnlineFinancialIntent)?.receiptNumber).toBe(1000083);
        expect(native.invoke).not.toHaveBeenCalled();
        expect(native.select.mock.calls[0][0]).toMatch(/^SELECT .*_online_financial_intent/);
    });
    it('blocks a different financial or cash transaction before native commit', async () => {
        await expect(commitSale({ order: { id: 'new-sale', type: 'sale' } } as SaleBundle)).rejects.toThrow('not cancelled');
        expect(native.invoke).not.toHaveBeenCalled();
    });
    it('blocks a stale review and a staff member without authority before native recovery', async () => {
        await expect(recoverOnlineFinancialIntent(undefined, 'different')).rejects.toThrow('changed');
        currentEmployee.set({ id: 'staff', role: 'attendance', isActive: true } as Employee);
        await expect(recoverOnlineFinancialIntent(undefined, 'saved-order')).rejects.toThrow('permission');
        expect(native.invoke).not.toHaveBeenCalled();
    });
    it('passes exact receipt identity plus actor version, never a new sale bundle', async () => {
        native.invoke.mockRejectedValue('FINANCIAL_STAGE[connect-mariadb]: pool timed out');
        await expect(recoverOnlineFinancialIntent(undefined, 'saved-order')).rejects.toContain('pool timed out');
        expect(native.invoke).toHaveBeenCalledWith('recover_online_financial_intent', {
            mysqlUri: expect.any(String), recovery: { expectedOrderId: 'saved-order', employeeId: 'cashier', employeeUpdatedAt: 'auth-version' },
        });
        expect(get(pendingOnlineFinancialIntent)?.orderId).toBe('saved-order');
    });
    it('keeps an already known receipt visible if local review fails', async () => {
        await refreshPendingOnlineFinancialIntent();
        native.select.mockRejectedValue(new Error('local read unavailable'));
        await expect(refreshPendingOnlineFinancialIntent()).rejects.toThrow('local read unavailable');
        expect(get(pendingOnlineFinancialIntent)?.orderId).toBe('saved-order');
        expect(get(pendingOnlineFinancialReadError)).toContain('Do not repeat');
    });
    it('preserves automatic startup replay but never submits a replacement order', async () => {
        native.invoke.mockImplementation(async () => { native.select.mockResolvedValue([]); return null; });
        await recoverOnlineFinancialIntent();
        expect(native.invoke).toHaveBeenCalledWith('recover_online_financial_intent', { mysqlUri: expect.any(String), recovery: null });
        expect(get(pendingOnlineFinancialIntent)).toBeNull();
    });
});
