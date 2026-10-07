import { describe, expect, it } from 'vitest';
import {
    REPORT_CONTRIBUTING_QUEUE_TABLES,
    REPORT_CONTRIBUTING_CONFLICT_TABLES,
    effectiveReportMarkerScopes,
    isValidReportPeriod,
    latestEffectiveReportMarker,
    newestReportMarker,
    assertCurrentReportPeriod,
    requiresCoordinatedSystemCloseSession,
} from './reportMarkers';

describe('effective Z-report marker', () => {
    const markers = [
        { tillNumber: 'till-1', markerTime: '2026-07-18T10:00:00.000Z', type: 'period' },
        { tillNumber: '', markerTime: '2026-07-18T13:42:21.323Z', type: 'period' },
        { tillNumber: 'till-2', markerTime: '2026-07-19T10:00:00.000Z', type: 'period' },
    ];

    it('lets a whole-system close advance every per-till report', () => {
        expect(effectiveReportMarkerScopes('till-1')).toEqual(['till-1', '']);
        expect(latestEffectiveReportMarker('till-1', markers))
            .toBe('2026-07-18T13:42:21.323Z');
    });

    it('does not let another till marker advance this till', () => {
        expect(latestEffectiveReportMarker('till-1', [
            ...markers,
            { tillNumber: 'till-1', markerTime: '2026-07-20T09:00:00.000Z', type: 'period' },
        ])).toBe('2026-07-20T09:00:00.000Z');
    });

    it('uses only canonical system markers for a whole-system close', () => {
        expect(effectiveReportMarkerScopes('')).toEqual(['']);
        expect(latestEffectiveReportMarker('', markers))
            .toBe('2026-07-18T13:42:21.323Z');
    });

    it('compares mixed timestamp representations by instant rather than alphabetically', () => {
        expect(newestReportMarker(
            '2026-09-23T12:30:00.000+01:00',
            '2026-09-23T12:00:00.000000Z',
        )).toBe('2026-09-23T12:00:00.000000Z');
        expect(() => newestReportMarker('invalid')).toThrow('invalid timestamp');
    });

    it('rejects an old till preview after a newer system close, without changing history', () => {
        const latest = latestEffectiveReportMarker('till-1', markers);
        expect(() => assertCurrentReportPeriod(
            latest, '2026-07-18T10:00:00.000Z', '2026-07-19T10:00:00.000Z',
        )).toThrow('REPORT_PERIOD_CHANGED');
        expect(() => assertCurrentReportPeriod(
            latest, '2026-07-18T13:42:21.323000Z', '2026-07-19T10:00:00.000Z',
        )).not.toThrow();
    });

    it('rejects empty or deliberately shortened closes, including the initial period', () => {
        expect(() => assertCurrentReportPeriod(null,
            '2026-07-18T10:00:00.000Z', '2026-07-19T10:00:00.000Z',
        )).toThrow('REPORT_PERIOD_CHANGED');
        expect(() => assertCurrentReportPeriod(null,
            '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z',
        )).toThrow('period is empty');
    });

    it('requires a coordinated session before multi-till code can save a system marker', () => {
        expect(requiresCoordinatedSystemCloseSession(true, '')).toBe(true);
        expect(requiresCoordinatedSystemCloseSession(true, 'till-1')).toBe(false);
        expect(requiresCoordinatedSystemCloseSession(false, '')).toBe(false);
    });

    it('treats customer-account ledger movements as report-contributing queued writes', () => {
        expect(REPORT_CONTRIBUTING_QUEUE_TABLES).toEqual([
            'orders',
            'order_lines',
            'payments',
            'customer_account_entries',
            'till_report_markers',
        ]);
    });

    it('blocks closes for retained financial sync conflicts', () => {
        expect(REPORT_CONTRIBUTING_CONFLICT_TABLES).toEqual([
            'orders',
            'order_lines',
            'payments',
            'customer_account_entries',
            'till_report_markers',
            'sale_bundle',
            '_online_financial_intent',
        ]);
    });

    it('requires a non-empty report interval before a close can be offered', () => {
        expect(isValidReportPeriod(
            '2026-07-18T13:42:21.323Z',
            '2026-07-18T13:42:21.324Z',
        )).toBe(true);
        expect(isValidReportPeriod(
            '2026-07-18T13:42:21.323Z',
            '2026-07-18T13:42:21.323Z',
        )).toBe(false);
        expect(isValidReportPeriod(
            '2026-07-18T13:42:21.324Z',
            '2026-07-18T13:42:21.323Z',
        )).toBe(false);
        expect(isValidReportPeriod('invalid', '2026-07-18T13:42:21.323Z')).toBe(false);
    });
});
