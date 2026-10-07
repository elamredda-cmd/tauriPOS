import type { DojoConfig } from './dojo';
import type { TerminalPaymentAttempt } from './terminalAttempts';

export function isReportPaymentBlocker(value: string): boolean {
    return /TERMINAL_RECOVERY_PENDING|terminal payment attempt|card payment attempt|unresolved card payment/i.test(value);
}

export function readableReportPaymentBlocker(value: string): string {
    return value.replace(/(\d+) (?:terminal|card) payment attempt(?:\(s\)|s)?/gi,
        (_, count: string) => `${count} unresolved card payment${Number(count) === 1 ? '' : 's'}`)
        .replace(/^TERMINAL_RECOVERY_PENDING:\s*/i, '');
}

export function reportPaymentStatus(status: TerminalPaymentAttempt['status']): string {
    const labels: Record<TerminalPaymentAttempt['status'], string> = {
        prepared: 'Prepared — result pending', started: 'Payment started', uncertain: 'Result unconfirmed',
        approved: 'Approved — saving pending', commit_failed: 'Approved — recovery needed',
        completion_pending: 'Final save pending', completed: 'Shared confirmation pending',
        failed: 'Failure confirmation pending', cancelled: 'Cancellation confirmation pending',
    };
    return labels[status] || 'Review required';
}

/** Never display raw journal errors: they may contain DB details or provider identifiers. */
export function reportPaymentRecoveryReason(attempt: Pick<TerminalPaymentAttempt, 'status' | 'error'>): string {
    if (/PROVIDER_FINAL_CANDIDATE/i.test(attempt.error)) {
        return 'A final provider result was received. Two matching checks at least 30 seconds apart are required to confirm it.';
    }
    if (['approved', 'commit_failed', 'completion_pending', 'completed'].includes(attempt.status)) {
        return 'The payment may already be approved. Its sale or shared confirmation must be recovered; do not charge again.';
    }
    if (/\bExpired\b/i.test(attempt.error)) {
        return 'The terminal session expired, but that alone does not prove payment failure or cancellation. The provider result still needs confirmation.';
    }
    if (/PROVIDER_NOT_FOUND|not found/i.test(attempt.error)) {
        return 'The provider payment could not yet be found. Verification is still required before the close can proceed.';
    }
    if (/credential|api.?key|unauthori[sz]ed|forbidden|401|403/i.test(attempt.error)) {
        return 'The payment provider connection could not be verified. Check the saved payment configuration.';
    }
    if (['failed', 'cancelled'].includes(attempt.status)) {
        return 'The outcome is saved on this device, but the shared payment journal still needs confirmation.';
    }
    return 'A final payment result is not confirmed yet. Check the result; do not retry the card or delete this payment record.';
}

export function reportPaymentAmount(attempt: Pick<TerminalPaymentAttempt, 'amount' | 'currency'>): string {
    if (!Number.isSafeInteger(attempt.amount) || attempt.amount <= 0 || !/^[A-Z]{3}$/.test(attempt.currency)) {
        return 'Amount needs review';
    }
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: attempt.currency }).format(attempt.amount / 100);
}

/** Presentation gate only. Native code re-checks the actual saved key and provider state. */
export function canCancelExpiredTestPayment(
    attempt: Pick<TerminalPaymentAttempt, 'provider' | 'operationKind' | 'status' | 'error' | 'clientTransactionId'>,
    config: Pick<DojoConfig, 'apiKeyConfigured' | 'apiEnvironment'> | null,
    activeAdministrator: boolean,
): boolean {
    return activeAdministrator && Boolean(config?.apiKeyConfigured)
        && config?.apiEnvironment.toLowerCase() === 'sandbox'
        && attempt.provider === 'dojo' && attempt.operationKind === 'sale'
        && attempt.status === 'uncertain' && /\bExpired\b/i.test(attempt.error)
        && !/PROVIDER_FINAL_CANDIDATE|\b(?:cancelled|canceled|reversed|captured|authorized|authorised)\b/i.test(attempt.error)
        && attempt.clientTransactionId.startsWith('pi_sandbox_');
}

// Keep this beyond recovery's 30-second separated-observation requirement.
// The finality decision still belongs exclusively to terminalRecovery.
export const REPORT_PAYMENT_FINALITY_WAIT_MS = 31_000;

function waitForReportPaymentSettlement(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal.aborted) return resolve();
        const finish = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', finish);
            resolve();
        };
        const timer = setTimeout(finish, REPORT_PAYMENT_FINALITY_WAIT_MS);
        signal.addEventListener('abort', finish, { once: true });
    });
}

/**
 * Verify an explicitly cancelled sandbox payment, with one bounded follow-up.
 * This helper never cancels, retries, or changes a journal's finality itself.
 */
export async function verifyCancelledReportPayment(options: {
    signal: AbortSignal;
    canContinue: () => boolean;
    assertSafe: () => Promise<void>;
    recover: () => Promise<void>;
    refreshResolved: () => Promise<boolean>;
    onSettling: () => void;
    waitForSettlement?: (signal: AbortSignal) => Promise<void>;
}): Promise<'resolved' | 'pending' | 'stopped'> {
    const canContinue = () => !options.signal.aborted && options.canContinue();
    for (let pass = 0; pass < 2; pass++) {
        if (!canContinue()) return 'stopped';
        // Re-check the shared close barrier on both passes, and authorization
        // after that asynchronous check, before any recovery ledger write.
        await options.assertSafe();
        if (!canContinue()) return 'stopped';
        await options.recover();
        if (!canContinue()) return 'stopped';
        const resolved = await options.refreshResolved();
        if (!canContinue()) return 'stopped';
        if (resolved) return 'resolved';
        if (pass === 0) {
            options.onSettling();
            await (options.waitForSettlement ?? waitForReportPaymentSettlement)(options.signal);
        }
    }
    return 'pending';
}
