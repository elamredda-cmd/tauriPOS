export interface ReportMarkerCandidate {
    tillNumber: string;
    markerTime: string;
    type?: string;
}

/** Local outbox tables whose rows can change a Z-report total or cutoff. */
export const REPORT_CONTRIBUTING_QUEUE_TABLES = Object.freeze([
    'orders',
    'order_lines',
    'payments',
    'customer_account_entries',
    'till_report_markers',
] as const);

/** Retained conflicts which can hide a financial row from authoritative Z totals. */
export const REPORT_CONTRIBUTING_CONFLICT_TABLES = Object.freeze([
    ...REPORT_CONTRIBUTING_QUEUE_TABLES,
    'sale_bundle',
    '_online_financial_intent',
] as const);

export function requiresCoordinatedSystemCloseSession(
    multiTillMode: boolean,
    tillNumber: string,
): boolean {
    return multiTillMode && tillNumber === '';
}

export function isValidReportPeriod(periodStart: string, periodEnd: string): boolean {
    const start = Date.parse(periodStart);
    const end = Date.parse(periodEnd);
    return Number.isFinite(start) && Number.isFinite(end) && start < end;
}

/**
 * A system marker closes every till. A till report therefore starts after the
 * newest marker belonging either to that till or to the whole system.
 */
export function effectiveReportMarkerScopes(tillNumber: string): string[] {
    return tillNumber ? [tillNumber, ''] : [''];
}

/** Compare timestamps as instants, not strings (MariaDB also returns microseconds). */
export function newestReportMarker(...markers: Array<string | null | undefined>): string | null {
    let newest: string | null = null;
    let newestTime = -Infinity;
    for (const marker of markers) {
        if (marker == null) continue;
        const time = Date.parse(marker);
        if (!Number.isFinite(time)) {
            throw new Error('The last report close has an invalid timestamp. Review the saved close before continuing.');
        }
        if (time > newestTime) {
            newest = marker;
            newestTime = time;
        }
    }
    return newest;
}

/** Reject an old preview after another till or system close advanced its scope. */
export function assertCurrentReportPeriod(
    latestMarker: string | null,
    periodStart: string,
    periodEnd: string,
): void {
    if (!isValidReportPeriod(periodStart, periodEnd)) {
        throw new Error('The report period is empty or invalid. Generate a fresh report.');
    }
    const expectedStart = latestMarker ?? '2000-01-01T00:00:00.000Z';
    if (!Number.isFinite(Date.parse(expectedStart)) || Date.parse(periodStart) !== Date.parse(expectedStart)) {
        throw new Error('REPORT_PERIOD_CHANGED: another close advanced this reporting period. Generate a fresh report.');
    }
}

export function latestEffectiveReportMarker(
    tillNumber: string,
    markers: Iterable<ReportMarkerCandidate>,
): string | null {
    const scopes = new Set(effectiveReportMarkerScopes(tillNumber));
    let latest: string | null = null;
    for (const marker of markers) {
        if ((marker.type ?? 'period') !== 'period' || !scopes.has(marker.tillNumber)) continue;
        latest = newestReportMarker(latest, marker.markerTime);
    }
    return latest;
}
