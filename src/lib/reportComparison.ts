const DAY_MS = 86_400_000;

export interface ReportPeriod { startDate: string; endDate: string; days: number }

function calendarDay(value: string): number {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Choose valid report dates.');
    const stamp = new Date(`${value}T00:00:00Z`).getTime();
    if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== value) {
        throw new Error('Choose valid report dates.');
    }
    return stamp;
}

/** Inclusive calendar-day ranges, unaffected by local daylight-saving changes. */
export function previousReportPeriod(startDate: string, endDate: string): ReportPeriod {
    const start = calendarDay(startDate), end = calendarDay(endDate);
    if (start > end) throw new Error('Start date must be before the end date.');
    const days = Math.round((end - start) / DAY_MS) + 1;
    const previousStart = new Date(start - days * DAY_MS).toISOString().slice(0, 10);
    const previousEnd = new Date(start - DAY_MS).toISOString().slice(0, 10);
    calendarDay(previousStart);
    return { startDate: previousStart, endDate: previousEnd, days };
}

/** Percentages from zero or negative baselines are misleading; use the amount instead. */
export function reportChange(current: number, previous: number) {
    if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
    const delta = current - previous;
    return {
        delta,
        direction: delta > 0 ? 'up' as const : delta < 0 ? 'down' as const : 'unchanged' as const,
        percent: previous > 0 ? (delta / previous) * 100 : null,
    };
}
