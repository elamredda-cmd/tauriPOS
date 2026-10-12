import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckoutDraft, CheckoutDraftEnvelope } from './checkoutDraft';

const mocks = vi.hoisted(() => ({ native: true, commit: vi.fn(), select: vi.fn(), getDb: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => mocks.native }));
vi.mock('./stores/sqlite', () => ({ getDb: mocks.getDb }));

let journal: typeof import('./checkoutDraft');
let values: Map<string, string>;
let storage: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn> };

function draft(overrides: Partial<CheckoutDraft> = {}): CheckoutDraft {
    return {
        version: 1, id: 'stable-checkout-id', tillId: 'Till 1',
        cart: [{ id: 'product-1', name: 'Beef', price: 175, quantity: 0.825, note: 'Keep chilled',
            isPriceOverride: true, originalPrice: 200, sourceBarcode: '0012345678905',
            quantityLocked: true, skipStockAdjustment: false }],
        customerId: 'customer-1', discountId: 'discount-1', selectedCartIndex: 0,
        saleIds: ['attempt-1'], pendingHoldId: '', ...overrides,
    };
}
function raw(revision: number, value: CheckoutDraft | null): string {
    return JSON.stringify({ version: 1, revision, draft: value });
}
function committedEnvelope(call: number): CheckoutDraftEnvelope {
    return JSON.parse(mocks.commit.mock.calls[call][0][0].data.value);
}
function deferred() {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

beforeEach(async () => {
    vi.resetModules();
    mocks.native = true;
    mocks.commit.mockReset().mockResolvedValue(1);
    mocks.select.mockReset().mockResolvedValue([]);
    mocks.getDb.mockReset().mockResolvedValue({ select: mocks.select,
        execute: async (_sql: string, params: string[]) => {
            // Capture the exact persisted value; SQL semantics are separately
            // exercised by checkoutDraftSqlite.test.ts against real SQLite.
            await mocks.commit([{ table: 'settings', idKey: 'key', kind: 'upsert',
                data: { key: params[0], value: params[1], updatedAt: params[2] } }]);
            return { rowsAffected: 1 };
        } });
    values = new Map();
    storage = {
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    };
    vi.stubGlobal('localStorage', storage);
    journal = await import('./checkoutDraft');
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('device-local checkout draft', () => {
    it('round-trips exact customer, discount, weighted quantity, manual flags and recovery IDs', async () => {
        const original = draft({ pendingHoldId: 'hold-1' });
        await journal.persistCheckoutDraft(original);
        expect(await journal.loadCheckoutDraft()).toEqual(original);
        expect(committedEnvelope(0).draft).toEqual(original);
        expect(mocks.commit.mock.calls[0][0]).toEqual([expect.objectContaining({
            table: 'settings', idKey: 'key', kind: 'upsert',
            data: expect.objectContaining({ key: 'checkout_draft_v1' }),
        })]);
    });

    it('writes a synchronous immutable mirror before its native transaction starts', async () => {
        const waiting = deferred();
        mocks.commit.mockImplementationOnce(() => waiting.promise);
        const original = draft();
        const saved = journal.persistCheckoutDraft(original);
        original.cart[0].price = 999;
        original.cart[0].note = 'mutated';
        original.saleIds.push('mutated');
        expect(mocks.commit).not.toHaveBeenCalled();
        const mirror = journal.readCheckoutDraftEnvelope(values.get(journal.CHECKOUT_DRAFT_KEY)!)!;
        expect(mirror.draft!.cart[0].price).toBe(175);
        expect(mirror.draft!.cart[0].note).toBe('Keep chilled');
        expect(mirror.draft!.saleIds).toEqual(['attempt-1']);
        await vi.waitFor(() => expect(mocks.commit).toHaveBeenCalledTimes(1));
        expect(committedEnvelope(0)).toEqual(mirror);
        waiting.resolve();
        await saved;
    });

    it('coalesces queued edits and resolves their callers only after the latest commit', async () => {
        const waiting = deferred();
        mocks.commit.mockImplementationOnce(() => waiting.promise);
        const first = journal.persistCheckoutDraft(draft());
        const second = journal.persistCheckoutDraft(draft({ customerId: 'customer-2' }));
        const third = journal.persistCheckoutDraft(draft({ customerId: 'customer-3' }));
        const settled = vi.fn();
        first.then(settled); second.then(settled); third.then(settled);
        await vi.waitFor(() => expect(mocks.commit).toHaveBeenCalledTimes(1));
        expect(committedEnvelope(0).draft!.customerId).toBe('customer-3');
        expect(settled).not.toHaveBeenCalled();
        waiting.resolve();
        await Promise.all([first, second, third, journal.flushCheckoutDraft()]);
        expect(settled).toHaveBeenCalledTimes(3);
        expect(mocks.commit).toHaveBeenCalledTimes(1);
    });

    it('orders an entered save before a clear and keeps a newer tombstone in both copies', async () => {
        const waiting = deferred();
        mocks.commit.mockImplementationOnce(() => waiting.promise);
        const save = journal.persistCheckoutDraft(draft());
        await vi.waitFor(() => expect(mocks.commit).toHaveBeenCalledTimes(1));
        const clear = journal.persistCheckoutDraft(null);
        const mirror = journal.readCheckoutDraftEnvelope(values.get(journal.CHECKOUT_DRAFT_KEY)!)!;
        expect(mirror.draft).toBeNull();
        expect(mirror.revision).toBeGreaterThan(committedEnvelope(0).revision);
        waiting.resolve();
        await Promise.all([save, clear]);
        expect(mocks.commit).toHaveBeenCalledTimes(2);
        expect(committedEnvelope(1)).toEqual(mirror);
        expect(mocks.commit.mock.calls[1][0][0].kind).toBe('upsert');
        expect(await journal.loadCheckoutDraft()).toBeNull();
    });

    it('coalesces a not-entered save and clear directly to a tombstone', async () => {
        const save = journal.persistCheckoutDraft(draft());
        const clear = journal.persistCheckoutDraft(null);
        await Promise.all([save, clear]);
        expect(mocks.commit).toHaveBeenCalledTimes(1);
        expect(committedEnvelope(0).draft).toBeNull();
    });

    it('starts a later save enqueued by an earlier save completion', async () => {
        await journal.persistCheckoutDraft(draft()).then(() => journal.persistCheckoutDraft(draft({ customerId: 'later' })));
        expect(mocks.commit).toHaveBeenCalledTimes(2);
        expect(committedEnvelope(1).draft!.customerId).toBe('later');
    });

    it('reports a native failure, retains the latest mirror and permits a healthy retry', async () => {
        mocks.commit.mockRejectedValueOnce(new Error('disk full'));
        await expect(journal.persistCheckoutDraft(draft())).rejects.toThrow('disk full');
        await expect(journal.flushCheckoutDraft()).rejects.toThrow('disk full');
        expect(journal.readCheckoutDraftEnvelope(values.get(journal.CHECKOUT_DRAFT_KEY)!)!.draft).toEqual(draft());
        await expect(journal.persistCheckoutDraft(draft())).resolves.toBeUndefined();
        await expect(journal.flushCheckoutDraft()).resolves.toBeUndefined();
        expect(mocks.commit).toHaveBeenCalledTimes(2);
        expect(committedEnvelope(1).revision).toBeGreaterThan(committedEnvelope(0).revision);
    });

    it('allows a clear queued behind a rejected save to commit without resurrecting the draft', async () => {
        const waiting = deferred();
        mocks.commit.mockImplementationOnce(() => waiting.promise);
        const save = journal.persistCheckoutDraft(draft());
        const rejected = expect(save).rejects.toThrow('disk full');
        await vi.waitFor(() => expect(mocks.commit).toHaveBeenCalledTimes(1));
        const clear = journal.persistCheckoutDraft(null);
        waiting.reject(new Error('disk full'));
        await rejected;
        await clear;
        expect(committedEnvelope(1).draft).toBeNull();
        expect(await journal.loadCheckoutDraft()).toBeNull();
    });

    it.each([
        [raw(100, draft()), raw(99, null), 'mirror'],
        [raw(99, draft()), raw(100, null), 'tombstone'],
        [raw(99, null), raw(100, draft()), 'durable'],
    ])('chooses the newest validated mirror/durable revision (%s / %s)', async (mirror, durable, expected) => {
        values.set(journal.CHECKOUT_DRAFT_KEY, mirror);
        mocks.select.mockResolvedValue([{ value: durable }]);
        expect(await journal.loadCheckoutDraft()).toEqual(expected === 'tombstone' ? null : draft());
        if (expected !== 'mirror') expect(JSON.parse(values.get(journal.CHECKOUT_DRAFT_KEY)!)).toEqual(JSON.parse(durable));
    });

    it('recovers a SQLite-only draft and immediately refreshes the mirror', async () => {
        const durable = raw(Date.now() * 1000 + 100_000, draft());
        mocks.select.mockResolvedValue([{ value: durable }]);
        expect(await journal.loadCheckoutDraft()).toEqual(draft());
        expect(JSON.parse(values.get(journal.CHECKOUT_DRAFT_KEY)!)).toEqual(JSON.parse(durable));
        await journal.persistCheckoutDraft(draft({ customerId: 'next' }));
        expect(committedEnvelope(0).revision).toBeGreaterThan(JSON.parse(durable).revision);
    });

    it('rejects conflicting tied revisions instead of guessing or overwriting', async () => {
        const mirror = raw(100, draft());
        values.set(journal.CHECKOUT_DRAFT_KEY, mirror);
        mocks.select.mockResolvedValue([{ value: raw(100, null) }]);
        await expect(journal.loadCheckoutDraft()).rejects.toThrow('invalid');
        expect(values.get(journal.CHECKOUT_DRAFT_KEY)).toBe(mirror);
        expect(mocks.commit).not.toHaveBeenCalled();
    });

    it.each(['not-json', '{}', raw(0, draft()), raw(2.5, draft())])('preserves and rejects corrupt mirror %s', async (corrupt) => {
        values.set(journal.CHECKOUT_DRAFT_KEY, corrupt);
        mocks.select.mockResolvedValue([{ value: raw(1, draft()) }]);
        await expect(journal.loadCheckoutDraft()).rejects.toThrow('invalid');
        await expect(journal.persistCheckoutDraft(null)).rejects.toThrow('invalid');
        expect(values.get(journal.CHECKOUT_DRAFT_KEY)).toBe(corrupt);
        expect(mocks.commit).not.toHaveBeenCalled();
    });

    it('preserves and rejects corrupt SQLite even with a healthy newer mirror', async () => {
        const mirror = raw(100, draft());
        values.set(journal.CHECKOUT_DRAFT_KEY, mirror);
        mocks.select.mockResolvedValue([{ value: '{broken' }]);
        await expect(journal.loadCheckoutDraft()).rejects.toThrow('invalid');
        expect(values.get(journal.CHECKOUT_DRAFT_KEY)).toBe(mirror);
        expect(mocks.commit).not.toHaveBeenCalled();
    });

    it('fails closed when the synchronous mirror is missing or full', async () => {
        vi.stubGlobal('localStorage', undefined);
        await expect(journal.persistCheckoutDraft(draft())).rejects.toThrow('unavailable');
        vi.stubGlobal('localStorage', storage);
        storage.setItem.mockImplementationOnce(() => { throw new Error('quota exceeded'); });
        await expect(journal.persistCheckoutDraft(draft())).rejects.toThrow('quota exceeded');
        expect(mocks.commit).not.toHaveBeenCalled();
        await expect(journal.persistCheckoutDraft(draft())).resolves.toBeUndefined();
    });

    it('uses only the localStorage journal in browser simulation', async () => {
        mocks.native = false;
        await journal.persistCheckoutDraft(draft());
        expect(await journal.loadCheckoutDraft()).toEqual(draft());
        await journal.persistCheckoutDraft(null);
        expect(await journal.loadCheckoutDraft()).toBeNull();
        expect(values.has(journal.CHECKOUT_DRAFT_KEY)).toBe(true);
        expect(mocks.commit).not.toHaveBeenCalled();
        expect(mocks.getDb).not.toHaveBeenCalled();
    });

    it.each([
        { version: 2 }, { id: '' }, { tillId: 'x'.repeat(257) }, { cart: [] },
        { selectedCartIndex: -1 }, { selectedCartIndex: 1 }, { selectedCartIndex: 0.5 },
        { saleIds: ['repeat', 'repeat'] }, { saleIds: Array(1001).fill('sale') },
        { cart: Array(2001).fill(draft().cart[0]) },
        { paymentMethod: 'card' }, { amountTendered: 500 }, { employee: { id: 'staff' } },
        { loyaltyPoints: 999 }, { accountBalancePence: 100 },
    ])('rejects invalid or financial/session draft fields without overwriting: %j', async (overrides) => {
        await journal.persistCheckoutDraft(draft());
        const previous = values.get(journal.CHECKOUT_DRAFT_KEY);
        await expect(journal.persistCheckoutDraft({ ...draft(), ...overrides } as CheckoutDraft)).rejects.toThrow('invalid');
        expect(values.get(journal.CHECKOUT_DRAFT_KEY)).toBe(previous);
        expect(mocks.commit).toHaveBeenCalledTimes(1);
    });

    it.each([
        { price: -1 }, { price: 1.5 }, { price: 1_000_000_000 }, { price: NaN },
        { quantity: 0 }, { quantity: -1 }, { quantity: Infinity }, { quantity: 10_000 },
        { isPriceOverride: 'yes' }, { originalPrice: 0.5 }, { quantityLocked: 1 },
        { skipStockAdjustment: null }, { sourceBarcode: 'x'.repeat(1025) },
        { note: 'x'.repeat(10_001) }, { name: '' }, { id: '' }, { tender: 100 },
    ])('rejects invalid cart-line fields: %j', (overrides) => {
        expect(() => journal.validateCheckoutDraft(draft({ cart: [{ ...draft().cart[0], ...overrides } as never] }))).toThrow('invalid');
    });

    it('allows duplicate product IDs as separate edited lines and preserves false optional flags', () => {
        const line = { ...draft().cart[0], isPriceOverride: false, quantityLocked: false, skipStockAdjustment: false };
        const original = draft({ cart: [line, { ...line, note: 'Separate line' }], selectedCartIndex: 1 });
        expect(journal.validateCheckoutDraft(original)).toEqual(original);
    });
});
