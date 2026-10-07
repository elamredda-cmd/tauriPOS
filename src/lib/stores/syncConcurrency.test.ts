import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock('./sqlite', async original => ({ ...await original<typeof import('./sqlite')>(), getDb: async () => ({ select: mocks.select }) }));
import { runChangeSyncCycle, runFastSyncCycle, runSyncCycle, stopBackgroundSync } from './database';
import { connectionState } from './connection';
afterEach(() => stopBackgroundSync());
describe('shared sync entry guard', () => {
    it.each([runChangeSyncCycle, runFastSyncCycle, runSyncCycle])('claims the guard before the restore check and releases it on pause', async first => {
        connectionState.set({ mode: 'multi', mysqlConfig: null, mysqlOnline: true, mysqlReady: true, syncError: null });
        let release!: (rows: any[]) => void;
        mocks.select.mockReset().mockImplementation(() => new Promise(resolve => { release = resolve; }));
        const running = first();
        await Promise.resolve();
        await Promise.all([runChangeSyncCycle(), runFastSyncCycle(), runSyncCycle()]);
        expect(mocks.select).toHaveBeenCalledTimes(1);
        release([{ value: '1' }]);
        await running;
        connectionState.update(state => ({ ...state, mysqlOnline: true }));
        mocks.select.mockResolvedValue([{ value: '1' }]);
        await runChangeSyncCycle();
        expect(mocks.select).toHaveBeenCalledTimes(2);
    });
});
