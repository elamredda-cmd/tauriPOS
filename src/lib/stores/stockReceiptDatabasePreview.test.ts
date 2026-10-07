import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ invoke: vi.fn(), load: vi.fn(), getMysqlDb: vi.fn(), getDb: vi.fn() }));
vi.mock('@tauri-apps/api/core', async (original) => ({
    ...await original<typeof import('@tauri-apps/api/core')>(), isTauri: () => false, invoke: native.invoke,
}));
vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: native.load } }));
vi.mock('./sqlite', async (original) => ({
    ...await original<typeof import('./sqlite')>(), getDb: native.getDb,
}));
vi.mock('./connection', async (original) => ({
    ...await original<typeof import('./connection')>(), getMysqlDb: native.getMysqlDb,
}));

import { commitStockReceipt, getProductsPage, getRecentStockReceipts, type StockReceiptBundle } from './database';
import { auditLogDB, inventoryLogDB, productsDB, type AuditLog, type InventoryLog, type Product } from './db';
import { connectionState, type PosConnectionState } from './connection';

const stamp = '2026-09-08T12:00:00.000Z';
function bundle(id: string, productId: string): StockReceiptBundle {
    return {
        receipt: { id, supplierId: '', employeeId: 'preview-employee', reference: 'INV-TEST', notes: '',
            totalCost: 500, status: 'received', createdAt: stamp, updatedAt: stamp },
        lines: [{ id: `${id}-line`, receiptId: id, productId, productName: 'Preview product',
            quantity: 2, unitCost: 250, inventoryLogId: `${id}-log`, createdAt: stamp, updatedAt: stamp }],
        audit: { id: `${id}-audit`, employeeId: 'preview-employee', action: 'stock_received', entityType: 'stock_receipt',
            entityId: id, oldData: '', newData: '{}', createdAt: stamp },
    };
}

describe('stock receipt browser database boundary', () => {
    let savedProducts: Product[];
    let savedLogs: InventoryLog[];
    let savedAudit: AuditLog[];
    let savedConnection: PosConnectionState;

    beforeEach(() => {
        vi.clearAllMocks();
        savedProducts = get(productsDB);
        savedLogs = get(inventoryLogDB);
        savedAudit = get(auditLogDB);
        savedConnection = get(connectionState);
        inventoryLogDB.set([]);
        auditLogDB.set([]);
        connectionState.set({ mode: 'multi', mysqlOnline: true, mysqlReady: true, mysqlConfig: null, syncError: null });
    });

    afterEach(() => {
        productsDB.set(savedProducts);
        inventoryLogDB.set(savedLogs);
        auditLogDB.set(savedAudit);
        connectionState.set(savedConnection);
        Object.values(native).forEach((mock) => expect(mock).not.toHaveBeenCalled());
    });

    it('saves in memory, refreshes search stock/history and replays without duplicate increments', async () => {
        const item = { ...savedProducts[0], stockLevel: 10, isActive: true };
        productsDB.set([item]);
        const receipt = bundle('browser-stock-save', item.id);
        await commitStockReceipt(receipt);
        await commitStockReceipt(receipt);
        expect((await getProductsPage()).rows[0].stockLevel).toBe(12);
        expect((await getRecentStockReceipts()).find((row) => row.id === receipt.receipt.id)).toEqual(receipt.receipt);
        expect(get(inventoryLogDB)).toHaveLength(1);
        expect(get(auditLogDB)).toHaveLength(1);
    });

    it('leaves all stores unchanged if one product is missing', async () => {
        const receipt = bundle('browser-stock-missing', 'missing-product');
        await expect(commitStockReceipt(receipt)).rejects.toThrow('no longer available');
        expect(get(productsDB)).toEqual(savedProducts);
        expect(get(inventoryLogDB)).toEqual([]);
        expect(get(auditLogDB)).toEqual([]);
        expect((await getRecentStockReceipts()).some((row) => row.id === receipt.receipt.id)).toBe(false);
    });
});
