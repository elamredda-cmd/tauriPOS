import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ active: false, invoke: vi.fn(), load: vi.fn(), getDb: vi.fn(), getMysqlDb: vi.fn(), commitBatch: vi.fn(), getAll: vi.fn() }));
vi.mock('@tauri-apps/api/core', async original => ({ ...await original<typeof import('@tauri-apps/api/core')>(), isTauri: () => native.active, invoke: native.invoke }));
vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: native.load } }));
vi.mock('./sqlite', async original => ({ ...await original<typeof import('./sqlite')>(), getDb: native.getDb, commitBatch: native.commitBatch, getAll: native.getAll }));
vi.mock('./connection', async original => ({ ...await original<typeof import('./connection')>(), getMysqlDb: native.getMysqlDb }));

import { deletePromotionBundle, getPromotionEditSnapshot, savePromotionBundle } from './database';
import { auditLogDB, discountsDB, promoGroupsDB, promoGroupItemsDB } from './db';
import { connectionState } from './connection';

const group = { id: 'test-group', name: 'Test offer', isActive: true, startAt: '', endAt: '', createdAt: '', updatedAt: '' };
const discount = { id: 'test-discount', groupId: group.id, name: 'Test offer', kind: 'bundle_fixed_price', type: 'fixed', value: 0, bundleQuantity: 2, bundlePrice: 500, isActive: true, autoApply: true } as any;
const item = { id: 'test-member', groupId: group.id, productId: 'test-product', updatedAt: '' };
const stores = [auditLogDB, discountsDB, promoGroupsDB, promoGroupItemsDB, connectionState] as const;
let saved: any[];

beforeEach(() => {
    saved = stores.map(store => get(store as any));
    vi.clearAllMocks();
    native.active = false;
    auditLogDB.set([]); discountsDB.set([]); promoGroupsDB.set([]); promoGroupItemsDB.set([]);
    connectionState.set({ mode: 'single', mysqlOnline: false, mysqlReady: false, mysqlConfig: null, syncError: null });
});
afterEach(() => {
    stores.forEach((store, index) => (store as any).set(saved[index]));
    vi.restoreAllMocks();
});

describe('promotion browser preview boundary', () => {
    afterEach(() => {
        for (const key of ['invoke', 'load', 'getDb', 'getMysqlDb', 'commitBatch', 'getAll'] as const) expect(native[key]).not.toHaveBeenCalled();
    });

    it('creates, edits and deletes only memory stores and audit', async () => {
        await savePromotionBundle(group, discount, [item], getPromotionEditSnapshot(discount.id, group.id));
        expect(get(discountsDB)[0].bundlePrice).toBe(500);
        expect(get(promoGroupItemsDB)).toEqual([item]);
        const before = getPromotionEditSnapshot(discount.id, group.id);
        await savePromotionBundle(group, { ...discount, bundlePrice: 400 }, [item], before);
        expect(get(discountsDB)[0].bundlePrice).toBe(400);
        await deletePromotionBundle(discount.id, group.id, getPromotionEditSnapshot(discount.id, group.id));
        expect(get(discountsDB)).toEqual([]);
        expect(get(promoGroupsDB)).toEqual([]);
        expect(get(promoGroupItemsDB)).toEqual([]);
        expect(get(auditLogDB).map(row => row.action)).toEqual(['promotion_deleted', 'promotion_updated', 'promotion_created']);
    });

    it('supports manual percentages without a group', async () => {
        const manual = { ...discount, groupId: '', kind: 'manual_percent', type: 'percentage', value: 10 };
        await savePromotionBundle(null, manual, []);
        expect(get(discountsDB)).toEqual([manual]);
        expect(get(promoGroupsDB)).toEqual([]);
        await deletePromotionBundle(manual.id);
        expect(get(discountsDB)).toEqual([]);
    });

    it('protects a form that was left open during another update', async () => {
        await savePromotionBundle(group, discount, [item]);
        const stale = getPromotionEditSnapshot(discount.id, group.id);
        await savePromotionBundle(group, { ...discount, bundlePrice: 350 }, [item]);
        await expect(savePromotionBundle(group, { ...discount, bundlePrice: 400 }, [item], stale)).rejects.toThrow('changed while it was open');
        await expect(deletePromotionBundle(discount.id, group.id, stale)).rejects.toThrow('changed while confirmation');
        expect(get(discountsDB)[0].bundlePrice).toBe(350);
    });

    it('uses deep snapshots and recognizes a retry without duplicate audit records', async () => {
        const empty = getPromotionEditSnapshot(discount.id, group.id);
        await savePromotionBundle(group, discount, [item], empty);
        const old = getPromotionEditSnapshot(discount.id, group.id);
        get(discountsDB)[0].name = 'changed outside captured snapshot';
        expect(old.discounts[0].name).toBe('Test offer');
        discountsDB.set([discount]);
        await savePromotionBundle(group, discount, [item], empty);
        expect(get(auditLogDB)).toHaveLength(1);
    });
});

describe('promotion native commit boundary (mocked, no real database)', () => {
    beforeEach(() => {
        native.active = true;
        native.getDb.mockResolvedValue({ select: vi.fn().mockResolvedValue([]) });
        native.commitBatch.mockReset().mockResolvedValue(1);
        native.getAll.mockReset().mockRejectedValue(new Error('display read unavailable'));
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    it('keeps a committed save successful when display refresh fails and includes audit atomically', async () => {
        await expect(savePromotionBundle(group, discount, [item])).resolves.toBeUndefined();
        expect(native.commitBatch).toHaveBeenCalledOnce();
        expect(native.commitBatch.mock.calls[0][0].map((row: any) => row.table)).toContain('audit_logs');
        expect(get(discountsDB)[0].id).toBe(discount.id);
        expect(native.invoke).not.toHaveBeenCalled();
    });

    it('does not alter stores or audit when the transaction fails', async () => {
        native.commitBatch.mockRejectedValue(new Error('transaction failed'));
        await expect(savePromotionBundle(group, discount, [item])).rejects.toThrow('transaction failed');
        expect(get(discountsDB)).toEqual([]);
        expect(get(auditLogDB)).toEqual([]);
        expect(native.getAll).not.toHaveBeenCalled();
    });

    it('rejects quantity overflow before touching SQLite or native commands', async () => {
        await expect(savePromotionBundle(group, { ...discount, bundleQuantity: 2_147_483_648 }, [item])).rejects.toThrow('quantity range');
        expect(native.getDb).not.toHaveBeenCalled();
        expect(native.commitBatch).not.toHaveBeenCalled();
        expect(native.invoke).not.toHaveBeenCalled();
    });

    it('does not claim deletion failed merely because refreshing its display failed', async () => {
        discountsDB.set([discount]); promoGroupsDB.set([group]); promoGroupItemsDB.set([item]);
        await expect(deletePromotionBundle(discount.id, group.id)).resolves.toBeUndefined();
        expect(get(discountsDB)).toEqual([]);
        expect(native.commitBatch.mock.calls[0][0].some((row: any) => row.table === 'audit_logs')).toBe(true);
    });
});
