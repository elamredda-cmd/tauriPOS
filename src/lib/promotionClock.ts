type PromotionWindow = { isActive: boolean; startAt?: string; endAt?: string };

/** Wake at offer boundaries, without evaluating every second on low-powered tills. */
export function nextPromotionRefreshDelay(windows: readonly PromotionWindow[], nowMs: number): number {
    let delay = 60_000;
    for (const window of windows) {
        if (!window.isActive) continue;
        // The pricing engine includes the end instant, so expiry is the next millisecond.
        for (const boundary of [Date.parse(window.startAt || ''), Date.parse(window.endAt || '') + 1]) {
            if (Number.isFinite(boundary) && boundary > nowMs) {
                delay = Math.min(delay, boundary - nowMs);
            }
        }
    }
    return Math.max(1, delay);
}

/** A timer is only a wake-up signal; scans/edits must use their actual evaluation time. */
export function promotionEvaluationTime(_clockSignal: string): string {
    return new Date().toISOString();
}
