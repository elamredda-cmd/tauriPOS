import { describe, expect, it } from 'vitest';
import { previousReportPeriod, reportChange } from './reportComparison';

describe('previous report periods', () => {
    it('compares today with yesterday', () => {
        expect(previousReportPeriod('2026-09-05', '2026-09-05')).toEqual({ startDate: '2026-09-04', endDate: '2026-09-04', days: 1 });
    });
    it('uses the immediately preceding inclusive range of equal calendar days', () => {
        expect(previousReportPeriod('2026-08-30', '2026-09-05')).toEqual({ startDate: '2026-08-23', endDate: '2026-08-29', days: 7 });
        expect(previousReportPeriod('2026-01-01', '2026-01-07')).toEqual({ startDate: '2025-12-25', endDate: '2025-12-31', days: 7 });
    });
    it('handles leap days and daylight-saving boundaries without losing a day', () => {
        expect(previousReportPeriod('2024-03-01', '2024-03-31')).toEqual({ startDate: '2024-01-30', endDate: '2024-02-29', days: 31 });
        expect(previousReportPeriod('2026-03-29', '2026-04-04')).toEqual({ startDate: '2026-03-22', endDate: '2026-03-28', days: 7 });
        expect(previousReportPeriod('2026-10-25', '2026-10-31')).toEqual({ startDate: '2026-10-18', endDate: '2026-10-24', days: 7 });
    });
    it.each([['', '2026-09-05'], ['2026-02-30', '2026-03-01'], ['2026-09-06', '2026-09-05'], ['invalid', '2026-09-05']])('rejects invalid or reversed dates %s–%s', (start, end) => {
        expect(() => previousReportPeriod(start, end)).toThrow();
    });
});

describe('headline report comparisons', () => {
    it('calculates increases, declines and unchanged values', () => {
        expect(reportChange(10800, 10000)).toEqual({ delta: 800, percent: 8, direction: 'up' });
        expect(reportChange(8000, 10000)).toEqual({ delta: -2000, percent: -20, direction: 'down' });
        expect(reportChange(10000, 10000)).toEqual({ delta: 0, percent: 0, direction: 'unchanged' });
    });
    it('uses amounts instead of percentages when the previous total was zero or negative', () => {
        expect(reportChange(800, 0)).toEqual({ delta: 800, percent: null, direction: 'up' });
        expect(reportChange(0, 0)).toEqual({ delta: 0, percent: null, direction: 'unchanged' });
        expect(reportChange(10000, -5000)).toEqual({ delta: 15000, percent: null, direction: 'up' });
        expect(reportChange(-10000, -5000)).toEqual({ delta: -5000, percent: null, direction: 'down' });
    });
    it('does not turn invalid totals into a percentage', () => {
        expect(reportChange(NaN, 100)).toBeNull();
        expect(reportChange(100, Infinity)).toBeNull();
    });
});
