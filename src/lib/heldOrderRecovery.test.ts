import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ commit: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));
vi.mock('./stores/sqlite', () => ({ commitBatch: mocks.commit, getDb: vi.fn() }));
import { HELD_RECOVERY_KEY, persistHeldRecovery, readHeldRecovery, writeHeldRecovery, type HeldRecovery } from './heldOrderRecovery';
describe('interrupted trolley journal', () => {
    const draft: HeldRecovery = { orderId: 'hold', claimId: 'stable-token', serverDataEpoch: 'epoch', cart: [{ id: 'p', name: 'Bread', price: 100, quantity: 1, note: '' }], customerId: 'c', discountId: '', saleIds: ['receipt'] };
    it('preserves claim identity, customer, items and attempted receipts across restarts', () => {
        const store = new Map<string, string>();
        const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } };
        writeHeldRecovery(storage, draft);
        expect(readHeldRecovery(storage)).toEqual(draft);
        expect(store.has(HELD_RECOVERY_KEY)).toBe(true);
    });
    it('fails closed if the journal cannot be saved or decoded', () => {
        expect(() => writeHeldRecovery({ setItem: () => { throw new Error('storage full'); } }, draft)).toThrow('storage full');
        expect(() => readHeldRecovery({ getItem: () => '{"orderId":"missing-data"}' })).toThrow('invalid');
    });
    it('serializes a save and clear so an older write cannot resurrect a trolley', async () => {
        let release!: () => void;
        mocks.commit.mockReset().mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; })).mockResolvedValue(undefined);
        const save = persistHeldRecovery(draft);
        const clear = persistHeldRecovery(null);
        await vi.waitFor(() => expect(mocks.commit).toHaveBeenCalledTimes(1));
        expect(mocks.commit.mock.calls[0][0][0].kind).toBe('upsert');
        release();
        await Promise.all([save, clear]);
        expect(mocks.commit.mock.calls[1][0][0].kind).toBe('remove');
    });
    it('reports a failed durable save but still allows the next retry', async () => {
        mocks.commit.mockReset().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined);
        await expect(persistHeldRecovery(draft)).rejects.toThrow('disk full');
        await expect(persistHeldRecovery(draft)).resolves.toBeUndefined();
    });
});
