export type CustomerLoyaltyAdjustmentMode = 'add' | 'remove' | 'set';

// MariaDB stores loyalty balances and movements as signed INT values on
// existing installations. Keep manual corrections inside that portable range.
export const MAX_CUSTOMER_LOYALTY_POINTS = 2_147_483_647;
export const MIN_CUSTOMER_LOYALTY_POINTS = -2_147_483_648;
export const MAX_CUSTOMER_LOYALTY_REASON_LENGTH = 240;

export interface CustomerLoyaltyAdjustmentPreview {
    enteredPoints: number | null;
    pointsChange: number;
    nextPoints: number;
    error: string;
}

export function customerLoyaltyAdjustmentPreview(
    currentPoints: number,
    mode: CustomerLoyaltyAdjustmentMode,
    rawPoints: string,
): CustomerLoyaltyAdjustmentPreview {
    const current = Number(currentPoints);
    if (!Number.isSafeInteger(current) || current < MIN_CUSTOMER_LOYALTY_POINTS || current > MAX_CUSTOMER_LOYALTY_POINTS) {
        return { enteredPoints: null, pointsChange: 0, nextPoints: 0, error: 'The current points balance is invalid' };
    }

    const value = String(rawPoints || '').trim();
    if (!value) {
        return { enteredPoints: null, pointsChange: 0, nextPoints: current, error: '' };
    }
    if (!/^\d+$/.test(value)) {
        return { enteredPoints: null, pointsChange: 0, nextPoints: current, error: 'Enter a whole number of points' };
    }

    const enteredPoints = Number(value);
    if (!Number.isSafeInteger(enteredPoints) || enteredPoints > MAX_CUSTOMER_LOYALTY_POINTS) {
        return { enteredPoints: null, pointsChange: 0, nextPoints: current, error: 'The points value is too large' };
    }

    let pointsChange = 0;
    if (mode === 'add') {
        if (enteredPoints === 0) {
            return { enteredPoints, pointsChange: 0, nextPoints: current, error: 'Enter at least 1 point to add' };
        }
        pointsChange = enteredPoints;
    } else if (mode === 'remove') {
        if (enteredPoints === 0) {
            return { enteredPoints, pointsChange: 0, nextPoints: current, error: 'Enter at least 1 point to remove' };
        }
        pointsChange = -enteredPoints;
    } else {
        pointsChange = enteredPoints - current;
        if (pointsChange === 0) {
            return { enteredPoints, pointsChange, nextPoints: current, error: 'The balance is already at this value' };
        }
    }

    const nextPoints = current + pointsChange;
    if (nextPoints < 0) {
        return {
            enteredPoints, pointsChange, nextPoints: current,
            error: current < 0
                ? 'Use Add or Set balance to correct the negative balance to zero or more'
                : 'You cannot remove more points than the customer has',
        };
    }
    if (nextPoints > MAX_CUSTOMER_LOYALTY_POINTS) {
        return { enteredPoints, pointsChange, nextPoints: current, error: 'The resulting points balance is too large' };
    }
    if (!Number.isSafeInteger(pointsChange) || pointsChange < MIN_CUSTOMER_LOYALTY_POINTS || pointsChange > MAX_CUSTOMER_LOYALTY_POINTS) {
        return { enteredPoints, pointsChange: 0, nextPoints: current, error: 'The points correction is too large for one adjustment' };
    }
    return { enteredPoints, pointsChange, nextPoints, error: '' };
}

/** Prefer an authoritative read unless a cached row has advanced further. */
export function newestCustomerSnapshot<T extends { id: string; updatedAt?: string }>(snapshot: T | null | undefined, cached: T | null | undefined): T | null {
    if (!snapshot) return cached || null;
    if (!cached || cached.id !== snapshot.id) return snapshot;
    const snapshotTime = Date.parse(snapshot.updatedAt || '');
    const cachedTime = Date.parse(cached.updatedAt || '');
    if (Number.isFinite(cachedTime) && (!Number.isFinite(snapshotTime) || cachedTime > snapshotTime)) return cached;
    return snapshot;
}

export function customerLoyaltyReasonError(reason: string): string {
    const normalized = String(reason || '').trim();
    if (!normalized) return 'Enter a reason for this correction';
    if (normalized.length < 3) return 'The reason must be at least 3 characters';
    if (normalized.length > MAX_CUSTOMER_LOYALTY_REASON_LENGTH) {
        return `Keep the reason under ${MAX_CUSTOMER_LOYALTY_REASON_LENGTH + 1} characters`;
    }
    if (/\p{Cc}/u.test(normalized)) return 'The reason contains an invalid character';
    return '';
}

export function manualLoyaltyReason(note: string): string {
    return `manual_adjustment: ${String(note || '').trim()}`;
}

export function manualLoyaltyReasonNote(reason: string): string {
    const value = String(reason || '');
    if (!value.startsWith('manual_adjustment:')) return '';
    return value.slice('manual_adjustment:'.length).trim();
}
