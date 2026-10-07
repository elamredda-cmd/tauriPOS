import { describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { PROMOTION_QUEUE_HEAD_PREDICATE, promotionDeletionTargets, promotionSaveMutations, promotionSnapshotAfterSave, promotionSnapshotsMatch, refreshAfterPromotionCommit, validatePromotionForPersistence, type PromotionSnapshot } from './promotionPersistence';

const snapshot = (): PromotionSnapshot => ({
    group: { id: 'g', name: 'Offer', isActive: true, updatedAt: '2026-09-01' },
    discounts: [{ id: 'd', groupId: 'g', kind: 'bundle_fixed_price', bundleQuantity: 2, bundlePrice: 500, isActive: true, autoApply: true }],
    items: [{ id: 'i', productId: 'p', groupId: 'g' }],
});

describe('promotion snapshot concurrency', () => {
    it('ignores timestamps, ordering and database boolean/null encoding differences', () => {
        const before = snapshot();
        const remote = snapshot();
        remote.group = { ...remote.group, isActive: 1, updatedAt: '2026-09-09', startAt: null, endAt: '' };
        remote.discounts[0] = { ...remote.discounts[0], isActive: 1, autoApply: '1', maxApplications: null, bundlePrice: '500', createdAt: 'server' };
        expect(promotionSnapshotsMatch(before, remote)).toBe(true);
    });

    it.each(['name', 'startAt', 'endAt', 'isActive'])('detects a changed group %s', field => {
        const remote = snapshot();
        remote.group![field] = field === 'isActive' ? false : 'changed';
        expect(promotionSnapshotsMatch(snapshot(), remote)).toBe(false);
    });

    it('detects changed prices and membership even when timestamps are identical', () => {
        const remote = snapshot();
        remote.discounts[0].bundlePrice = 400;
        expect(promotionSnapshotsMatch(snapshot(), remote)).toBe(false);
        remote.discounts[0].bundlePrice = 500;
        remote.items = [];
        expect(promotionSnapshotsMatch(snapshot(), remote)).toBe(false);
    });

    it('retains unrelated rules within a group when constructing the after-state', () => {
        const before = snapshot();
        before.discounts.push({ id: 'other', groupId: 'g' });
        const after = promotionSnapshotAfterSave(before, before.group, { ...before.discounts[0], bundlePrice: 450 }, before.items);
        expect(after.discounts.map(row => row.id)).toEqual(['other', 'd']);
        expect(before.discounts[0].bundlePrice).toBe(500);
    });
});

describe('atomic promotion persistence', () => {
    it.each([
        ['bundleQuantity', 2_147_483_648], ['minQuantity', 1.5], ['maxApplications', 0],
        ['bundlePrice', Number.MAX_SAFE_INTEGER + 1], ['secondPrice', -1],
    ])('rejects invalid %s before local persistence', (field, value) => {
        const before = snapshot();
        expect(() => validatePromotionForPersistence(before.group, { ...before.discounts[0], name: 'Offer', [field]: value }, before.items)).toThrow();
    });

    it('commits audit and a before-state outbox package alongside all local edits', () => {
        const before = snapshot();
        let id = 0;
        const batch = promotionSaveMutations({
            before, group: before.group, discount: before.discounts[0], items: [], products: [],
            audit: { id: 'audit' }, queue: true, serverDataEpoch: 'epoch', uuid: () => `q${++id}`,
        });
        expect(batch.find(row => row.table === 'audit_logs')).toMatchObject({ queueId: 'q1', serverDataEpoch: 'epoch' });
        expect(batch.find(row => row.kind === 'remove')).toMatchObject({ table: 'promo_group_items', data: { id: 'i' } });
        expect(batch.at(-1)).toMatchObject({ table: 'promotion_bundle', kind: 'queue', queueId: 'q2', data: { baseSnapshot: before } });
    });

    it('supports manual percentages without a fake product group or native queue in single mode', () => {
        const batch = promotionSaveMutations({ before: { group: null, discounts: [], items: [] },
            group: null, discount: { id: 'manual' }, items: [], products: [], audit: { id: 'audit' },
            queue: false, serverDataEpoch: '', uuid: () => 'unused',
        });
        expect(batch.map(row => row.table)).toEqual(['discounts', 'audit_logs']);
        expect(batch.every(row => !row.queueId)).toBe(true);
    });

    it('never reports a failed save after only its display refresh failed', async () => {
        const warn = vi.fn();
        await expect(refreshAfterPromotionCommit(async () => { throw new Error('read failed'); }, warn)).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledOnce();
    });
});

describe('promotion deletion tombstones', () => {
    it('does not interpret removed membership as a deleted offer', () => {
        expect(promotionDeletionTargets({ groupId: 'g', discountIds: ['d'], itemIds: ['removed-member'] }))
            .toEqual([['promo_groups', 'g'], ['discounts', 'd']]);
    });

    it('still recognizes manual-discount deletion and orphan membership deletion', () => {
        expect(promotionDeletionTargets({ groupId: '', discountIds: ['d'], itemIds: [] })).toEqual([['discounts', 'd']]);
        expect(promotionDeletionTargets({ groupId: '', discountIds: [], itemIds: ['i'] })).toEqual([['promo_group_items', 'i']]);
    });
});

describe('promotion queue causal ordering (in-memory SQLite)', () => {
    function fixture() {
        const db = new DatabaseSync(':memory:');
        db.exec('CREATE TABLE _offline_queue (id TEXT PRIMARY KEY, operation TEXT, data TEXT, next_attempt_at TEXT)');
        const insert = (id: string, operation: string, data: any, retry = '') => db.prepare('INSERT INTO _offline_queue VALUES (?, ?, ?, ?)').run(id, operation, JSON.stringify(data), retry);
        const ready = () => db.prepare(`SELECT id FROM _offline_queue WHERE (next_attempt_at = '' OR next_attempt_at <= '10:00') AND ${PROMOTION_QUEUE_HEAD_PREDICATE} ORDER BY rowid LIMIT 10`).all().map(row => row.id);
        return { db, insert, ready };
    }

    it('holds a later edit behind the previous edit even during retry backoff', () => {
        const { db, insert, ready } = fixture();
        try {
            insert('z-first', 'promotionBundle', { group: { id: 'g' }, discount: { id: 'd' } }, '10:02');
            insert('a-second', 'promotionBundle', { group: { id: 'g' }, discount: { id: 'd' } });
            insert('unrelated', 'promotionBundle', { group: { id: 'other' }, discount: { id: 'other-d' } });
            expect(ready()).toEqual(['unrelated']);
            db.prepare("UPDATE _offline_queue SET next_attempt_at = '' WHERE id = 'z-first'").run();
            expect(ready()).toEqual(['z-first', 'unrelated']);
            db.prepare("DELETE FROM _offline_queue WHERE id = 'z-first'").run();
            expect(ready()).toEqual(['a-second', 'unrelated']);
        } finally { db.close(); }
    });

    it('orders save/delete and manual discounts without blocking unrelated work', () => {
        const { db, insert, ready } = fixture();
        try {
            insert('manual-save', 'promotionBundle', { group: null, discount: { id: 'd', groupId: '' } }, '10:02');
            insert('manual-delete', 'promotionDelete', { groupId: '', discountIds: ['d'] });
            insert('other-manual', 'promotionBundle', { group: null, discount: { id: 'other', groupId: '' } });
            insert('sale', 'saleBundle', {});
            expect(ready()).toEqual(['other-manual', 'sale']);
            db.prepare("DELETE FROM _offline_queue WHERE id = 'manual-save'").run();
            expect(ready()).toEqual(['manual-delete', 'other-manual', 'sale']);
        } finally { db.close(); }
    });
});
