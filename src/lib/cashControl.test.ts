import { describe, expect, it, vi } from 'vitest';
import { cashControlPeriod, cashControlSourceIdentity, cashCountPence, cashVarianceLabel, latestCashControlEntry, type CashControlEntry } from './cashControl';
import type { PosConnectionState } from './stores/connection';

vi.mock('@tauri-apps/plugin-sql', () => ({ default: {} }));

describe('private cash control input', () => {
    it('uses exact whole pence and permits a genuine zero cash count', () => {
        expect(cashCountPence('0')).toBe(0);
        expect(cashCountPence(' 590.10 ')).toBe(59_010);
        expect(cashCountPence('12.5')).toBe(1250);
        expect(cashCountPence('1000000')).toBe(100_000_000);
        for (const invalid of ['', ' ', '-1', '1.001', '1e3', 'Infinity', '£2', '10,00', '1000001']) {
            expect(cashCountPence(invalid)).toBeNull();
        }
    });

    it('validates actual dates and produces exclusive next-midnight boundaries', () => {
        const result = cashControlPeriod('till-1', '2026-09-23', new Date('2026-09-23T12:00:00Z'));
        expect(new Date(result.periodStart).getDate()).toBe(23);
        expect(new Date(result.periodEnd).getDate()).toBe(24);
        expect(new Date(result.periodStart).getHours()).toBe(0);
        expect(() => cashControlPeriod('till-1', '2026-02-30')).toThrow(/valid/);
        expect(() => cashControlPeriod('', '2026-09-23')).toThrow(/till/);
        expect(() => cashControlPeriod('till-1', '2030-01-01', new Date('2026-09-23T12:00:00Z'))).toThrow(/future/);
    });

    it('keeps UK daylight-saving dates to 23 or 25 hours with both local offsets', () => {
        vi.stubEnv('TZ', 'Europe/London');
        try {
            const now = new Date('2027-01-01T12:00:00Z');
            const spring = cashControlPeriod('till-1', '2026-03-29', now);
            const autumn = cashControlPeriod('till-1', '2026-10-25', now);
            expect(spring.periodStart).toBe('2026-03-29T00:00:00+00:00');
            expect(spring.periodEnd).toBe('2026-03-30T00:00:00+01:00');
            expect(new Date(spring.periodEnd).getTime() - new Date(spring.periodStart).getTime()).toBe(23 * 3600_000);
            expect(new Date(autumn.periodEnd).getTime() - new Date(autumn.periodStart).getTime()).toBe(25 * 3600_000);
        } finally { vi.unstubAllEnvs(); }
    });

    it('uses the newest revision without modifying the retained history', () => {
        const entries = [{ revision: 1, createdAt: '2026-09-23' }, { revision: 2, createdAt: '2026-09-23' }] as CashControlEntry[];
        expect(latestCashControlEntry(entries)?.revision).toBe(2);
        expect(entries[0].revision).toBe(1);
        expect(latestCashControlEntry([])).toBeNull();
    });

    it('labels the discrepancy separately from sales revenue', () => {
        expect(cashVarianceLabel(-1000)).toBe('Short');
        expect(cashVarianceLabel(1000)).toBe('Over');
        expect(cashVarianceLabel(0)).toBe('Balanced');
    });

    it('invalidates unlocked access when switching databases without exposing credentials', () => {
        const state: PosConnectionState = { mode: 'multi', mysqlConfig: { host: 'localhost', port: 3306, user: 'pos', password: 'private', database: 'shop-a' }, mysqlOnline: true, mysqlReady: true, syncError: null };
        const identity = cashControlSourceIdentity(state);
        expect(identity).not.toContain('private');
        expect(cashControlSourceIdentity({ ...state, mode: 'single' })).not.toBe(identity);
        expect(cashControlSourceIdentity({ ...state, mysqlConfig: { ...state.mysqlConfig!, database: 'shop-b' } })).not.toBe(identity);
    });
});
