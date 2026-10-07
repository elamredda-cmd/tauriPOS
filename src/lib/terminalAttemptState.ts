export const TERMINAL_ATTEMPT_STATUSES = [
    'prepared',
    'started',
    'uncertain',
    'approved',
    'commit_failed',
    'completion_pending',
    'completed',
    'failed',
    'cancelled',
] as const;

export type TerminalAttemptState = typeof TERMINAL_ATTEMPT_STATUSES[number];

const TRANSITIONS: Readonly<Record<TerminalAttemptState, readonly TerminalAttemptState[]>> = {
    prepared: ['prepared', 'started', 'uncertain', 'approved', 'failed', 'cancelled'],
    started: ['started', 'uncertain', 'approved', 'failed', 'cancelled'],
    uncertain: ['uncertain', 'approved', 'failed', 'cancelled'],
    approved: ['approved', 'commit_failed', 'completion_pending', 'completed'],
    commit_failed: ['commit_failed', 'completion_pending', 'completed'],
    completion_pending: ['completion_pending', 'completed'],
    completed: ['completed'],
    failed: ['failed'],
    cancelled: ['cancelled'],
};

/**
 * Financial journal transitions are deliberately one-way. Once provider
 * approval has been observed, a stale poll may not turn that attempt back
 * into a retryable/final-failure state. Final rows are immutable.
 */
export function isTerminalAttemptTransitionAllowed(
    current: string,
    requested: string,
): boolean {
    return TERMINAL_ATTEMPT_STATUSES.includes(current as TerminalAttemptState)
        && TERMINAL_ATTEMPT_STATUSES.includes(requested as TerminalAttemptState)
        && TRANSITIONS[current as TerminalAttemptState].includes(requested as TerminalAttemptState);
}

/** Current states that one atomic UPDATE may move to `requested`. */
export function terminalAttemptUpdatePredecessors(requested: string): TerminalAttemptState[] {
    if (!TERMINAL_ATTEMPT_STATUSES.includes(requested as TerminalAttemptState)) return [];
    return TERMINAL_ATTEMPT_STATUSES.filter((current) => (
        isTerminalAttemptTransitionAllowed(current, requested)
        // Final rows may be read as an idempotent success, but never mutated.
        && !(current === requested && isFinalTerminalAttemptState(current))
    ));
}

export function isFinalTerminalAttemptState(status: string): boolean {
    return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/**
 * Strength is used only when merging a shared MariaDB snapshot into SQLite.
 * Explicit provider approval outranks a contradictory failure snapshot so
 * evidence of a possible charge remains operational for manual recovery.
 */
export function terminalAttemptStateStrength(status: string): number {
    switch (status) {
        case 'prepared': return 0;
        case 'started': return 10;
        case 'uncertain': return 20;
        case 'failed':
        case 'cancelled': return 30;
        case 'approved': return 40;
        case 'commit_failed': return 50;
        case 'completion_pending': return 60;
        case 'completed': return 70;
        default: return -1;
    }
}

export const TERMINAL_PAYMENT_EXTRA_FIELDS = ['tipsAmount', 'serviceChargeAmount', 'cashbackAmount'] as const;
export type TerminalPaymentExtras = Record<typeof TERMINAL_PAYMENT_EXTRA_FIELDS[number], number>;

/** Only fill absent legacy accounting fields; all existing financial data is immutable. */
export function assertTerminalAccountingEnrichment(previousJson: string, enrichedJson: string): void {
    const previous = JSON.parse(previousJson);
    const enriched = JSON.parse(enrichedJson);
    const paymentOf = (payload: any) => {
        if (payload?.kind === 'customer_account_payment') return payload;
        if (payload?.order?.type !== 'sale' || !payload.payment) {
            throw new Error('Only original sales and customer-account payments can enrich terminal accounting');
        }
        return payload.payment;
    };
    const before = paymentOf(previous);
    const after = paymentOf(enriched);
    for (const field of TERMINAL_PAYMENT_EXTRA_FIELDS) {
        if (!Number.isSafeInteger(after[field]) || after[field] < 0) {
            throw new Error('Verified terminal extra amounts must be nonnegative whole minor units');
        }
        if (Object.prototype.hasOwnProperty.call(before, field) && before[field] !== after[field]) {
            throw new Error('Previously recorded terminal extra amounts cannot be changed; administrator review is required');
        }
        delete before[field];
        delete after[field];
    }
    const canonical = (value: any): any => Array.isArray(value)
        ? value.map(canonical)
        : value && typeof value === 'object'
            ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
            : value;
    if (JSON.stringify(canonical(previous)) !== JSON.stringify(canonical(enriched))) {
        throw new Error('Terminal accounting enrichment cannot change the original financial payload');
    }
}

export interface MergeableTerminalAttemptSnapshot {
    status: string;
    clientTransactionId: string;
    terminalSessionId: string;
    providerReference: string;
    createdAt: string;
    updatedAt: string;
}

/**
 * Mirrors the SQLite UPSERT policy used for remote journal snapshots. It is
 * exported so the no-downgrade/reference-preservation invariant is testable
 * without a native database runtime.
 */
export function mergeTerminalAttemptSnapshots<T extends MergeableTerminalAttemptSnapshot>(
    local: T,
    remote: T,
): T {
    const remoteIsStronger = terminalAttemptStateStrength(remote.status)
        > terminalAttemptStateStrength(local.status);
    const stronger = remoteIsStronger ? remote : local;
    const weaker = remoteIsStronger ? local : remote;
    return {
        ...stronger,
        clientTransactionId: stronger.clientTransactionId || weaker.clientTransactionId,
        terminalSessionId: stronger.terminalSessionId || weaker.terminalSessionId,
        providerReference: stronger.providerReference || weaker.providerReference,
        // A shared row's clocks come from MariaDB, not a possibly skewed till.
        createdAt: remote.createdAt,
        updatedAt: remote.updatedAt,
    };
}
