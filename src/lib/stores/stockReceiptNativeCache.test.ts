import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ invoke: vi.fn(), stock: vi.fn(), ownerChanged: vi.fn() }));
vi.mock('@tauri-apps/api/core', async (original) => ({
    ...await original<typeof import('@tauri-apps/api/core')>(), isTauri: () => true, invoke: native.invoke,
}));
vi.mock('./sqlite', async (original) => ({
    ...await original<typeof import('./sqlite')>(), getProductStockLevels: native.stock,
}));
vi.mock('$lib/ownerCloudEvents', () => ({ notifyOwnerCloudDataChanged: native.ownerChanged }));

import { commitStockReceipt, type StockReceiptBundle } from './database';
import { productsDB, type Product } from './db';
import { connectionState, type PosConnectionState } from './connection';

const stamp = '2026-09-08T12:00:00.000Z';
function bundle(productId: string): StockReceiptBundle {
    return {
        receipt: { id: 'receipt-native', supplierId: '', employeeId: 'test-employee', reference: '', notes: '',
            totalCost: 150, status: 'received', createdAt: stamp, updatedAt: stamp },
        lines: [{ id: 'native-line', receiptId: 'receipt-native', productId, productName: 'Test product',
            quantity: 3, unitCost: 50, inventoryLogId: 'native-log', createdAt: stamp, updatedAt: stamp }],
        audit: { id: 'native-audit', employeeId: 'test-employee', action: 'stock_received', entityType: 'stock_receipt',
            entityId: 'receipt-native', oldData: '', newData: '{}', createdAt: stamp },
    };
}

describe('native stock receipt cache refresh', () => {
    let savedProducts: Product[];
    let savedConnection: PosConnectionState;
    beforeEach(() => {
        vi.clearAllMocks();
        savedProducts = get(productsDB);
        savedConnection = get(connectionState);
        connectionState.set({ mode: 'single', mysqlOnline: false, mysqlReady: false, mysqlConfig: null, syncError: null });
        native.invoke.mockReset().mockResolvedValue(undefined);
        native.stock.mockReset().mockResolvedValue([]);
    });
    afterEach(() => {
        productsDB.set(savedProducts);
        connectionState.set(savedConnection);
        vi.restoreAllMocks();
    });

    it('refreshes absolute committed stock without replacing product details or incrementing again on replay', async () => {
        const item = { ...savedProducts[0], stockLevel: 10, image: 'keep-image' };
        const unrelated = { ...savedProducts[1], stockLevel: 7 };
        productsDB.set([item, unrelated]);
        native.stock.mockResolvedValue([{ id: item.id, stockLevel: 13, updatedAt: stamp, name: 'Do not overwrite' }]);
        const receipt = bundle(item.id);
        await commitStockReceipt(receipt);
        await commitStockReceipt(receipt);
        expect(native.stock).toHaveBeenCalledWith([item.id]);
        expect(get(productsDB)).toEqual([{ ...item, stockLevel: 13, updatedAt: stamp }, unrelated]);
        expect(native.invoke).toHaveBeenCalledTimes(2);
        expect(native.invoke.mock.invocationCallOrder[0]).toBeLessThan(native.stock.mock.invocationCallOrder[0]);
    });

    it('does not refresh stock when the actual commit failed', async () => {
        native.invoke.mockRejectedValue(new Error('Transaction rolled back'));
        await expect(commitStockReceipt(bundle(savedProducts[0].id))).rejects.toThrow('Transaction rolled back');
        expect(native.stock).not.toHaveBeenCalled();
        expect(native.ownerChanged).not.toHaveBeenCalled();
        expect(get(productsDB)).toEqual(savedProducts);
    });

    it('does not report a committed receipt as failed if the display refresh fails', async () => {
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        native.stock.mockRejectedValue(new Error('Cache read unavailable'));
        await expect(commitStockReceipt(bundle(savedProducts[0].id))).resolves.toBeUndefined();
        expect(native.invoke).toHaveBeenCalledTimes(1);
        expect(native.ownerChanged).toHaveBeenCalledTimes(1);
        expect(get(productsDB)).toEqual(savedProducts);
        expect(warning).toHaveBeenCalledWith(expect.stringContaining('saved'), expect.any(Error));
    });

    it('does not read or grow the checkout cache for a product that is not displayed', async () => {
        await commitStockReceipt(bundle('product-not-in-cache'));
        expect(native.stock).not.toHaveBeenCalled();
        expect(get(productsDB)).toEqual(savedProducts);
        expect(native.ownerChanged).toHaveBeenCalledTimes(1);
    });
});
