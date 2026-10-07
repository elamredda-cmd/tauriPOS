import { describe, expect, it, vi } from 'vitest';
import { readReconciliationCheckpoint, reconcileVersionPage, type ReconciliationCheckpoint } from './reconciliation';

describe('bounded sync verification', () => {
    it('finds late-committed rows regardless of their old timestamps', async () => {
        let checkpoint: ReconciliationCheckpoint = { table: 0, after: null };
        let committed = false;
        const repair = vi.fn(async (_table, rows) => rows.length);
        const deps = {
            versions: vi.fn(async () => committed ? [{ rowId: 'old-id', updatedAt: '2000-01-01T00:00:00Z' }] : []),
            repair,
            checkpoint: async (next: ReconciliationCheckpoint) => { checkpoint = next; },
        };
        await reconcileVersionPage(checkpoint, ['products'], deps);
        committed = true;
        expect(await reconcileVersionPage(checkpoint, ['products'], deps)).toBe(1);
        expect(repair.mock.calls[1][1][0].rowId).toBe('old-id');
    });
    it('keeps a failed page retryable and advances only after repair', async () => {
        const save = vi.fn();
        await expect(reconcileVersionPage({ table: 0, after: null }, ['products'], {
            versions: async () => [{ rowId: 'a', updatedAt: 'old' }],
            repair: async () => { throw new Error('disk full'); }, checkpoint: save,
        })).rejects.toThrow('disk full');
        expect(save).not.toHaveBeenCalled();
    });
    it('bounds each pass and progresses through tables', async () => {
        const save = vi.fn();
        const versions = vi.fn(async () => [{ rowId: 'a', updatedAt: 'x' }]);
        await reconcileVersionPage({ table: 0, after: null }, ['products','customers'], { versions, repair: async () => 0, checkpoint: save }, 1);
        expect(save).toHaveBeenCalledWith({ table: 0, after: 'a' });
        await reconcileVersionPage({ table: 0, after: 'a' }, ['products','customers'], { versions: async () => [], repair: async () => 0, checkpoint: save }, 1);
        expect(save).toHaveBeenLastCalledWith({ table: 1, after: null });
    });
    it('rejects corrupt checkpoints', () => {
        expect(readReconciliationCheckpoint('{bad', 2)).toEqual({ table: 0, after: null });
        expect(readReconciliationCheckpoint('{"table":20,"after":null}', 2)).toEqual({ table: 0, after: null });
    });
});
