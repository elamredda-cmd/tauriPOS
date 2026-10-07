import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ getMysqlDb: vi.fn(), select: vi.fn(async () => []) }));
vi.mock('./connection', async importOriginal => ({
    ...await importOriginal<typeof import('./connection')>(), getMysqlDb: mocks.getMysqlDb,
}));
vi.mock('./sqlite', async importOriginal => ({
    ...await importOriginal<typeof import('./sqlite')>(), getDb: async () => ({ select: mocks.select }),
}));
import { flushOfflineQueue } from './database';
import { connectionState } from './connection';
afterEach(() => vi.useRealTimers());
describe('failed outbox connections', () => {
    it('joins concurrent drains and never recursively retries a failed connection', async () => {
        vi.useFakeTimers();
        connectionState.set({ mode: 'multi', mysqlConfig: null, mysqlOnline: false, mysqlReady: false, syncError: null });
        mocks.getMysqlDb.mockImplementation(() => new Promise((_, reject) => setTimeout(() => reject(new Error('unavailable')), 50)));
        const first = flushOfflineQueue(), joined = flushOfflineQueue();
        expect(joined).toBe(first);
        const failed = expect(first).rejects.toThrow('unavailable');
        await vi.advanceTimersByTimeAsync(50);
        await failed;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(mocks.getMysqlDb).toHaveBeenCalledTimes(1);
        const explicitRetry = expect(flushOfflineQueue()).rejects.toThrow('unavailable');
        await vi.advanceTimersByTimeAsync(50);
        await explicitRetry;
        expect(mocks.getMysqlDb).toHaveBeenCalledTimes(2);
    });
});
