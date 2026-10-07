import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ isTauri: vi.fn(() => true), local: vi.fn(), remote: vi.fn() }));
vi.mock('@tauri-apps/api/core', async original => ({ ...await original<typeof import('@tauri-apps/api/core')>(), isTauri: mocks.isTauri }));
vi.mock('./sqlite', async original => ({ ...await original<typeof import('./sqlite')>(), getBusinessSummary: mocks.local }));
vi.mock('./mysql', async original => ({ ...await original<typeof import('./mysql')>(), mysqlGetBusinessSummary: mocks.remote }));
import { getReportComparisonTotals } from './database';
import { connectionState } from './connection';
const totals = { netSales: 20000, grossProfit: 8000 };
beforeEach(() => {
    mocks.isTauri.mockReturnValue(true); mocks.local.mockReset(); mocks.remote.mockReset();
    mocks.local.mockResolvedValue(totals); mocks.remote.mockResolvedValue(totals);
    connectionState.set({ mode: 'multi', mysqlConfig: null, mysqlOnline: true, mysqlReady: true, syncError: null });
});
describe('comparison source consistency', () => {
    it('uses one summary query against the displayed local source even while the server is online', async () => {
        expect(await getReportComparisonTotals('2026-08-23', '2026-08-29', 'sqlite', 'till-2')).toEqual(totals);
        expect(mocks.local).toHaveBeenCalledExactlyOnceWith('2026-08-23', '2026-08-29', 'till-2');
        expect(mocks.remote).not.toHaveBeenCalled();
    });
    it('uses the same till and remote source as the displayed live report', async () => {
        expect(await getReportComparisonTotals('2026-08-23', '2026-08-29', 'mariadb', 'till-2')).toEqual(totals);
        expect(mocks.remote).toHaveBeenCalledExactlyOnceWith('2026-08-23', '2026-08-29', 'till-2');
        expect(mocks.local).not.toHaveBeenCalled();
    });
    it('does not silently replace a failed live comparison with cached values', async () => {
        mocks.remote.mockRejectedValue(new Error('Connection lost'));
        await expect(getReportComparisonTotals('2026-08-23', '2026-08-29', 'mariadb')).rejects.toThrow('Connection lost');
        expect(mocks.local).not.toHaveBeenCalled();
    });
    it('rejects malformed totals instead of displaying an invalid percentage', async () => {
        mocks.remote.mockResolvedValue({ netSales: 'invalid', grossProfit: 100 });
        await expect(getReportComparisonTotals('2026-08-23', '2026-08-29', 'mariadb')).rejects.toThrow('could not be verified');
        expect(mocks.local).not.toHaveBeenCalled();
    });
    it('reports a disconnected or unready server before attempting the comparison', async () => {
        connectionState.update(s => ({ ...s, mysqlOnline: false }));
        await expect(getReportComparisonTotals('2026-08-23', '2026-08-29', 'mariadb')).rejects.toThrow('Reconnect');
        connectionState.update(s => ({ ...s, mysqlOnline: true, mysqlReady: false }));
        await expect(getReportComparisonTotals('2026-08-23', '2026-08-29', 'mariadb')).rejects.toThrow('Reconnect');
        expect(mocks.remote).not.toHaveBeenCalled();
        expect(mocks.local).not.toHaveBeenCalled();
    });
});
