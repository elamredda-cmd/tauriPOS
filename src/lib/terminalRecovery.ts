import { invoke, isTauri } from '@tauri-apps/api/core';
import { get } from 'svelte/store';
import {
    assertMariaDbCommerceWritesAllowed,
    commitPreparedTerminalSale,
    hydrateSvelteStores,
    postCustomerAccountEntry,
    type SaleBundle,
} from '$lib/stores/database';
import { connectionState, buildMysqlUri, type MysqlConfig } from '$lib/stores/connection';
import { readDojoOperatorResolution } from '$lib/dojoExpiryReview';
import {
    acknowledgeApprovedPaymentTerminalAttempt,
    getRecoverablePaymentTerminalAttempts,
    isCustomerAccountPaymentPayload,
    persistVerifiedDojoPaymentAccounting,
    prunePaymentTerminalAttempts,
    refreshPaymentTerminalAttempt,
    updatePaymentTerminalAttempt,
    withTerminalPaymentExtras,
    terminalAttemptUsesSharedJournal,
    type TerminalPaymentAttempt,
    type TerminalProvider,
} from '$lib/terminalAttempts';
import {
    getSumupTransactionByReference,
    getSumupTransactionStatus,
    loadSumupConfig,
    type SumupTransactionStatus,
} from '$lib/sumup';
import {
    cancelExpiredSandboxDojoPaymentIntent,
    findDojoPaymentIntentByReference,
    getDojoPaymentIntentStatus,
    getDojoTerminalSessionStatus,
    loadDojoConfig,
    refundDojoPaymentIntent,
    type DojoPaymentIntentStatus,
    type DojoRecoveredPayment,
    type DojoTerminalSessionStatus,
} from '$lib/dojo';
import { getDojoPaymentBreakdown } from '$lib/dojoPaymentValidation';
import { TERMINAL_PAYMENT_EXTRA_FIELDS, type TerminalPaymentExtras } from '$lib/terminalAttemptState';
import {
    getDb as getSqliteDb,
    getOrCreateTillId,
    getTillName,
} from '$lib/stores/sqlite';
import {
    runWithTerminalRecoveryLease,
    acquireTerminalLock,
    refreshTerminalLock,
    releaseTerminalLock,
    type AssertTerminalRecoveryLease,
} from '$lib/terminalRecoveryLease';

export type ProviderReconciliation =
    | {
        outcome: 'approved';
        clientTransactionId: string;
        terminalSessionId?: string;
        providerReference: string;
        extras?: TerminalPaymentExtras;
    }
    | { outcome: 'failed' | 'cancelled'; error: string; finalityAlreadyConfirmed?: true }
    | { outcome: 'uncertain'; error: string };

export interface TerminalRecoveryResult {
    scanned: number;
    completed: number;
    finalizedWithoutLedger: number;
    stillUncertain: number;
    errors: string[];
    cashbackToReview: Array<{ attemptId: string; amount: number; currency: string }>;
}

let recoveryPromise: Promise<TerminalRecoveryResult> | null = null;
const recoveryOwnerToken = crypto.randomUUID();

function normalizedStatus(...values: Array<string | undefined>): string {
    return values.find(Boolean)?.trim().toUpperCase() || 'UNKNOWN';
}

const PROVIDER_MISSING_SETTLE_MS = 24 * 60 * 60 * 1000;
const PROVIDER_MISSING_PREFIX = 'PROVIDER_NOT_FOUND';
const PROVIDER_FINAL_SETTLE_MS = 30_000;
const PROVIDER_FINAL_PREFIX = 'PROVIDER_FINAL_CANDIDATE';

export function providerMissingReconciliation(
    attempt: Pick<TerminalPaymentAttempt, 'createdAt' | 'error'>,
    provider: TerminalProvider,
    nowMs = Date.now(),
    missingEffect = 'transaction',
): ProviderReconciliation {
    const previous = new RegExp(`^${PROVIDER_MISSING_PREFIX}:${provider}:([0-9]+):([0-9]+):`)
        .exec(attempt.error || '');
    const firstObservedAt = Number(previous?.[1] || nowMs);
    const observations = Number(previous?.[2] || 0) + 1;
    const created = Date.parse(attempt.createdAt);
    const settled = observations >= 3
        && Number.isFinite(created)
        && Number.isFinite(firstObservedAt)
        && nowMs - created >= PROVIDER_MISSING_SETTLE_MS
        && nowMs - firstObservedAt >= PROVIDER_MISSING_SETTLE_MS;
    const marker = `${PROVIDER_MISSING_PREFIX}:${provider}:${firstObservedAt}:${observations}:`;
    return settled
        ? {
            outcome: 'cancelled',
            error: `${marker} provider repeatedly confirmed no ${missingEffect} over 24 hours`,
            finalityAlreadyConfirmed: true,
        }
        : { outcome: 'uncertain', error: `${marker} provider has not confirmed the ${missingEffect}; automatic retry remains blocked` };
}

/**
 * A failed/cancelled observation made while recovering an ambiguous request is
 * not allowed to release the shared terminal immediately. Require the same
 * current provider result again after a settling interval; a captured result
 * observed in between therefore wins while the journal remains operational.
 */
export function settleProviderFinalReconciliation(
    attempt: Pick<TerminalPaymentAttempt, 'error'>,
    provider: TerminalProvider,
    outcome: 'failed' | 'cancelled',
    detail: string,
    nowMs = Date.now(),
): ProviderReconciliation {
    const previous = new RegExp(
        `^${PROVIDER_FINAL_PREFIX}:${provider}:${outcome}:([0-9]+):([0-9]+):`,
    ).exec(attempt.error || '');
    const firstObservedAt = Number(previous?.[1] || nowMs);
    const observations = Number(previous?.[2] || 0) + 1;
    const settled = observations >= 2
        && Number.isFinite(firstObservedAt)
        && nowMs - firstObservedAt >= PROVIDER_FINAL_SETTLE_MS;
    const marker = `${PROVIDER_FINAL_PREFIX}:${provider}:${outcome}:${firstObservedAt}:${observations}:`;
    return settled
        ? { outcome, error: `${marker} ${detail}` }
        : {
            outcome: 'uncertain',
            error: `${marker} ${detail}; awaiting a separated confirmation before releasing the terminal`,
        };
}

/** Apply the final-result policy once; never discard settled missing history. */
export function settleRecoveredProviderOutcome(
    attempt: Pick<TerminalPaymentAttempt, 'error'>,
    provider: TerminalProvider,
    result: ProviderReconciliation,
    nowMs = Date.now(),
): ProviderReconciliation {
    if ((result.outcome === 'failed' || result.outcome === 'cancelled')
        && !result.finalityAlreadyConfirmed) {
        return settleProviderFinalReconciliation(attempt, provider, result.outcome, result.error, nowMs);
    }
    return result;
}

export function classifySumupPaymentStatus(status: string): 'approved' | 'failed' | 'cancelled' | 'missing' | 'uncertain' {
    const outcome = status.trim().toUpperCase();
    if (outcome === 'SUCCESSFUL' || outcome === 'PAID_OUT') return 'approved';
    if (outcome === 'CANCELLED') return 'cancelled';
    if (outcome === 'FAILED' || outcome === 'NON_COLLECTION') return 'failed';
    if (outcome === 'NOT_FOUND') return 'missing';
    // In particular, CANCEL_FAILED is not a final result: cancellation may
    // have lost a race with card approval.
    return 'uncertain';
}

export function classifyDojoPaymentStatus(
    paymentStatus: string,
    terminalStatus = '',
): 'approved' | 'failed' | 'cancelled' | 'uncertain' {
    const payment = paymentStatus.trim().toUpperCase();
    const terminal = terminalStatus.trim().toUpperCase();
    if (payment === 'CAPTURED') return 'approved';
    if (payment === 'CANCELED' || payment === 'REVERSED') return 'cancelled';
    if (payment === 'CREATED' && ['DECLINED', 'SIGNATUREVERIFICATIONREJECTED'].includes(terminal)) return 'failed';
    if (terminal === 'CANCELED' && (!payment || payment === 'CREATED' || payment === 'CANCELED')) {
        return 'cancelled';
    }
    return 'uncertain';
}

function sumupReference(status: SumupTransactionStatus): string {
    const transaction = status.transactionCode || status.transactionId || status.clientTransactionId;
    return transaction ? `SumUp ${transaction}${status.transactionId ? ` [id:${status.transactionId}]` : ''}` : '';
}

function dojoReference(status: DojoPaymentIntentStatus): string {
    return `Dojo ${status.transactionId || status.id} [id:${status.id}]`;
}

function verifySumupPayment(
    attempt: TerminalPaymentAttempt,
    status: SumupTransactionStatus,
): ProviderReconciliation {
    const classification = classifySumupPaymentStatus(normalizedStatus(status.simpleStatus, status.status));
    if (classification === 'missing') {
        return providerMissingReconciliation(attempt, 'sumup');
    }
    if (classification === 'failed' || classification === 'cancelled') {
        return { outcome: classification, error: `SumUp final status: ${normalizedStatus(status.simpleStatus, status.status)}` };
    }
    if (classification !== 'approved') {
        return { outcome: 'uncertain', error: `SumUp is not final (${normalizedStatus(status.simpleStatus, status.status)})` };
    }
    if (status.foreignTransactionId && status.foreignTransactionId !== attempt.id) {
        return { outcome: 'uncertain', error: 'SumUp returned a captured transaction with a different durable reference' };
    }
    if (status.amount === undefined || Math.round(status.amount * 100) !== attempt.amount) {
        return { outcome: 'uncertain', error: 'SumUp returned a captured transaction with a different amount' };
    }
    if ((status.currency || '').toUpperCase() !== attempt.currency.toUpperCase()) {
        return { outcome: 'uncertain', error: 'SumUp returned a captured transaction with a different currency' };
    }
    if (!status.transactionId) {
        return { outcome: 'uncertain', error: 'SumUp captured the payment without returning a transaction ID' };
    }
    return {
        outcome: 'approved',
        clientTransactionId: status.clientTransactionId || attempt.clientTransactionId,
        providerReference: sumupReference(status),
    };
}

async function reconcileSumupRefund(attempt: TerminalPaymentAttempt): Promise<ProviderReconciliation> {
    const bundle = attempt.saleBundle as SaleBundle;
    const originalReference = String(bundle.order?.originalOrderId || '').trim();
    if (!originalReference) {
        return { outcome: 'uncertain', error: 'The SumUp refund journal has no original sale reference' };
    }
    let latest: SumupTransactionStatus | null = null;
    for (let check = 0; check < 3; check++) {
        latest = await getSumupTransactionByReference(originalReference);
        const refunded = latest.refundedAmount === undefined ? -1 : Math.round(latest.refundedAmount * 100);
        if (refunded === attempt.expectedProviderAmount) break;
        if (check < 2) await new Promise((resolve) => setTimeout(resolve, 800));
    }
    if (!latest?.transactionId || latest.refundedAmount === undefined) {
        return { outcome: 'uncertain', error: 'SumUp did not return an authoritative refund total' };
    }
    if (attempt.clientTransactionId && latest.transactionId !== attempt.clientTransactionId) {
        return { outcome: 'uncertain', error: 'SumUp refund recovery found a different original transaction' };
    }
    const refunded = Math.round(latest.refundedAmount * 100);
    const before = attempt.expectedProviderAmount - attempt.amount;
    if (refunded === attempt.expectedProviderAmount) {
        return {
            outcome: 'approved',
            clientTransactionId: latest.transactionId,
            providerReference: `SumUp refund ${latest.transactionCode || latest.transactionId} [id:${latest.transactionId}]`,
        };
    }
    if (refunded === before) {
        return providerMissingReconciliation(attempt, 'sumup', Date.now(), 'refund');
    }
    return {
        outcome: 'uncertain',
        error: `SumUp refund total (${refunded}) does not match the before or expected amount`,
    };
}

async function reconcileSumup(attempt: TerminalPaymentAttempt): Promise<ProviderReconciliation> {
    if (attempt.operationKind === 'refund') return reconcileSumupRefund(attempt);
    let status: SumupTransactionStatus | null = null;
    for (let check = 0; check < 3; check++) {
        status = attempt.clientTransactionId
            ? await getSumupTransactionStatus(attempt.clientTransactionId)
            : await getSumupTransactionByReference(attempt.id);
        if (classifySumupPaymentStatus(normalizedStatus(status.simpleStatus, status.status)) === 'missing'
            && attempt.clientTransactionId) {
            status = await getSumupTransactionByReference(attempt.id);
        }
        if (classifySumupPaymentStatus(normalizedStatus(status.simpleStatus, status.status)) !== 'missing') break;
        if (check < 2) await new Promise((resolve) => setTimeout(resolve, 800));
    }
    return verifySumupPayment(attempt, status!);
}

export function verifyDojoPayment(
    attempt: TerminalPaymentAttempt,
    payment: DojoPaymentIntentStatus,
    terminalSessionId = '',
    terminalStatus = '',
): ProviderReconciliation {
    // Identity is required for negative results too: a different canceled
    // intent must never release this terminal's durable active journal.
    if (!payment.id || (attempt.clientTransactionId && payment.id !== attempt.clientTransactionId) || payment.reference !== attempt.id) {
        return { outcome: 'uncertain', error: 'Dojo returned a payment with a different durable identity or reference' };
    }
    try {
        const reviewed = readDojoOperatorResolution(attempt, payment);
        if (reviewed && payment.status !== 'Captured') {
            if (reviewed.decision === 'paid' && payment.status === 'Created') {
                return { outcome: 'approved', clientTransactionId: payment.id,
                    terminalSessionId: attempt.terminalSessionId,
                    providerReference: `Dojo receipt confirmed by ${reviewed.employeeName}: ${reviewed.receiptReference} [id:${payment.id}]`,
                    extras: { tipsAmount: reviewed.tipsAmount, serviceChargeAmount: reviewed.serviceChargeAmount, cashbackAmount: reviewed.cashbackAmount } };
            }
            if (reviewed.decision === 'not_paid' && payment.status === 'Canceled') {
                return { outcome: 'cancelled', error: `Administrator checked the failed payment; Dojo confirmed cancellation. Receipt: ${reviewed.receiptReference}`, finalityAlreadyConfirmed: true };
            }
            return { outcome: 'uncertain', error: 'Dojo now disagrees with the recorded receipt decision. Administrator review is required.' };
        }
    } catch (error) { return { outcome: 'uncertain', error: String(error) }; }
    const detail = `terminal ${terminalStatus || 'unknown'}, payment intent ${payment.status || 'Unknown'}`;
    const classification = classifyDojoPaymentStatus(payment.status, terminalStatus);
    if (classification === 'failed' || classification === 'cancelled') {
        return {
            outcome: classification,
            error: `Dojo final status: ${detail}`,
        };
    }
    if (classification !== 'approved') {
        return { outcome: 'uncertain', error: `Dojo is not final (${detail})` };
    }
    let extras: TerminalPaymentExtras;
    try {
        const { tipsAmount, serviceChargeAmount, cashbackAmount } = getDojoPaymentBreakdown(payment, attempt.amount, attempt.currency);
        extras = { tipsAmount, serviceChargeAmount, cashbackAmount };
    } catch (error) {
        return { outcome: 'uncertain', error: String(error) };
    }
    return {
        outcome: 'approved',
        clientTransactionId: payment.id,
        terminalSessionId,
        providerReference: dojoReference(payment),
        extras,
    };
}

async function reconcileDojoRefund(attempt: TerminalPaymentAttempt): Promise<ProviderReconciliation> {
    if (!attempt.clientTransactionId) {
        return { outcome: 'uncertain', error: 'The Dojo refund journal has no original payment-intent ID' };
    }
    let latest: DojoPaymentIntentStatus | null = null;
    for (let check = 0; check < 3; check++) {
        latest = await getDojoPaymentIntentStatus(attempt.clientTransactionId);
        if (latest.refundedAmount === attempt.expectedProviderAmount) break;
        if (check < 2) await new Promise((resolve) => setTimeout(resolve, 800));
    }
    if (!latest || latest.refundedAmount === undefined) {
        return { outcome: 'uncertain', error: 'Dojo did not return an authoritative refund total' };
    }
    if (isCustomerAccountPaymentPayload(attempt.saleBundle) || !attempt.saleBundle.order.originalOrderId
        || latest.id !== attempt.clientTransactionId
        || latest.reference !== attempt.saleBundle.order.originalOrderId
        || !['Captured', 'Refunded'].includes(latest.status)) {
        return { outcome: 'uncertain', error: 'Dojo did not confirm the original refund identity and final payment state' };
    }
    const db = await getSqliteDb();
    const originals = await db.select<Array<{ cardAmount: number; amount: number; reference: string }>>(
        'SELECT cardAmount, amount, reference FROM payments WHERE orderId = ? LIMIT 1',
        [attempt.saleBundle.order.originalOrderId],
    );
    const original = originals[0];
    if (!original || !original.reference.includes(`[id:${attempt.clientTransactionId}]`)) {
        return { outcome: 'uncertain', error: 'The original Dojo sale is not available for refund verification; synchronize and review it' };
    }
    try {
        getDojoPaymentBreakdown(latest, Number(original.cardAmount || original.amount), attempt.currency);
    } catch (error) {
        return { outcome: 'uncertain', error: String(error) };
    }
    const refundPayment = attempt.saleBundle.payment;
    if (TERMINAL_PAYMENT_EXTRA_FIELDS.some((field) => Number(refundPayment[field] || 0) !== 0)) {
        return { outcome: 'uncertain', error: 'A goods refund cannot also post the original tips, service charge or cashback' };
    }
    const before = attempt.expectedProviderAmount - attempt.amount;
    if (latest.refundedAmount === attempt.expectedProviderAmount) {
        return {
            outcome: 'approved',
            clientTransactionId: latest.id,
            providerReference: `Dojo refund ${latest.transactionId || latest.id} [id:${latest.id}]`,
        };
    }
    if (latest.refundedAmount === before) {
        // Recover an interrupted/refused refund using Dojo's documented retry
        // contract: the exact original body and idempotency key, never a new key.
        // Only recent, unapproved work is replayed; older work stays protected.
        const age = Date.now() - Date.parse(attempt.createdAt);
        if (['started', 'uncertain'].includes(attempt.status) && age >= 0 && age < PROVIDER_MISSING_SETTLE_MS) {
            const result = await refundDojoPaymentIntent(attempt.clientTransactionId, attempt.amount, attempt.id);
            const checked = await getDojoPaymentIntentStatus(attempt.clientTransactionId);
            if (checked.id !== latest.id || checked.reference !== latest.reference || !['Captured', 'Refunded'].includes(checked.status)) {
                return { outcome: 'uncertain', error: 'Dojo refund recheck returned a different identity or state' };
            }
            getDojoPaymentBreakdown(checked, Number(original.cardAmount || original.amount), attempt.currency);
            if (checked.refundedAmount === attempt.expectedProviderAmount) {
                return { outcome: 'approved', clientTransactionId: checked.id,
                    providerReference: `Dojo refund ${checked.transactionId || checked.id} [id:${checked.id}]` };
            }
            if (result.paymentIntentId === latest.id && result.rejected === true && checked.refundedAmount === before) {
                return { outcome: 'failed', error: 'Dojo explicitly rejected the original refund; its refunded total is unchanged. No refund recorded.', finalityAlreadyConfirmed: true };
            }
            return { outcome: 'uncertain', error: 'Dojo refund recheck did not confirm success or rejection; do not refund again' };
        }
        return providerMissingReconciliation(attempt, 'dojo', Date.now(), 'refund');
    }
    return {
        outcome: 'uncertain',
        error: `Dojo refund total (${latest.refundedAmount}) does not match the before or expected amount`,
    };
}

async function reconcileDojo(attempt: TerminalPaymentAttempt): Promise<ProviderReconciliation> {
    if (attempt.operationKind === 'refund') return reconcileDojoRefund(attempt);

    let session: DojoTerminalSessionStatus | null = null;
    let recovered: DojoRecoveredPayment | null = null;
    if (attempt.clientTransactionId) {
        const payment = await getDojoPaymentIntentStatus(attempt.clientTransactionId);
        if (payment.terminalHistoryError) return { outcome: 'uncertain', error: payment.terminalHistoryError };
        recovered = { payment, terminalSessionId: payment.latestTerminalSessionId || attempt.terminalSessionId };
        if (recovered.terminalSessionId) session = await getDojoTerminalSessionStatus(recovered.terminalSessionId);
    } else if (attempt.terminalSessionId) {
        session = await getDojoTerminalSessionStatus(attempt.terminalSessionId);
    } else {
        recovered = await findDojoPaymentIntentByReference(attempt.id, attempt.createdAt);
        if (!recovered) {
            return providerMissingReconciliation(attempt, 'dojo');
        }
        if (recovered.terminalSessionId) {
            session = await getDojoTerminalSessionStatus(recovered.terminalSessionId);
        }
    }

    const paymentIntentId = attempt.clientTransactionId
        || session?.paymentIntentId
        || recovered?.payment.id
        || '';
    const terminalSessionId = recovered?.terminalSessionId
        || attempt.terminalSessionId
        || '';
    if (session && (session.id !== terminalSessionId
        || !session.paymentIntentId
        || session.paymentIntentId !== paymentIntentId
        || !session.terminalId
        || session.terminalId !== attempt.terminalKey.slice(attempt.terminalKey.lastIndexOf(':') + 1))) {
        return { outcome: 'uncertain', error: 'Dojo returned a different terminal session, terminal or linked payment intent' };
    }
    // A search result's history label is not enough to assert terminal finality.
    const terminalStatus = session?.status || '';
    // Read after the terminal, so a late capture always wins over its label.
    const payment = paymentIntentId ? await getDojoPaymentIntentStatus(paymentIntentId) : recovered?.payment;
    if (!payment) {
        return { outcome: 'uncertain', error: 'Dojo found terminal work but no payment intent to reconcile' };
    }
    if (payment.id !== paymentIntentId) {
        return { outcome: 'uncertain', error: 'Dojo payment intent does not match the verified terminal session' };
    }
    const pendingRetry = /DOJO_RETRY_PENDING:([^\s]+)/.exec(attempt.error || '')?.[1];
    if (pendingRetry && terminalSessionId === pendingRetry && payment.status === 'Created') {
        return { outcome: 'uncertain', error: `${attempt.error} The retry session is not yet confirmed. Check Dojo.` };
    }
    if (payment.latestTerminalSessionId && payment.latestTerminalSessionId !== terminalSessionId) {
        return { outcome: 'uncertain', error: 'Dojo session history changed while checking; check the latest result again.' };
    }
    return verifyDojoPayment(attempt, payment, terminalSessionId, terminalStatus);
}

export async function reviewExpiredDojoPayment(
    attemptId: string, employeeId: string, pin: string,
    review: { decision: 'paid' | 'not_paid'; receiptReference: string; note: string; tipsAmount: number; serviceChargeAmount: number; cashbackAmount: number },
): Promise<void> {
    const state = get(connectionState);
    if (!isTauri()) throw new Error('Card-payment review requires the native POS app.');
    const attempt = await refreshPaymentTerminalAttempt('dojo', attemptId);
    const shared = terminalAttemptUsesSharedJournal(attempt);
    if (shared && (!state.mysqlConfig || !state.mysqlOnline || !state.mysqlReady || state.mode !== 'multi')) {
        throw new Error('Reconnect MariaDB in the native POS before reviewing a card payment.');
    }
    if (shared) await assertMariaDbCommerceWritesAllowed();
    const scope = shared ? 'shared' : 'local';
    const tillId = await getOrCreateTillId();
    const leaseReference = `review:${attemptId}:${crypto.randomUUID()}`;
    const result = await runWithTerminalRecoveryLease({
        acquire: async () => (await acquireTerminalLock(scope, attempt.terminalKey, tillId, 'Administrator payment review', leaseReference, 600)).acquired,
        refresh: () => refreshTerminalLock(scope, attempt.terminalKey, tillId, leaseReference, 600),
        release: () => releaseTerminalLock(scope, attempt.terminalKey, tillId, leaseReference),
    }, async assertHeld => {
        await assertHeld();
        await refreshPaymentTerminalAttempt('dojo', attemptId);
        await invoke('dojo_review_expired_payment', { mysqlUri: shared ? buildMysqlUri(state.mysqlConfig!) : null,
            employeeId, pin, tillId, leaseReference, review: { attemptId, ...review } });
        await assertHeld();
        await refreshPaymentTerminalAttempt('dojo', attemptId);
    });
    if (!result.acquired) throw new Error('This terminal is being used or checked on another till. Wait for it to finish.');
}

/** Explicit operator action for an expired SANDBOX collection, never a retry. */
export async function cancelExpiredSandboxDojoPayment(attemptId: string): Promise<void> {
    if (!isTauri()) throw new Error('Sandbox payment recovery requires the native POS app');
    const state = get(connectionState);
    const config = await loadDojoConfig();
    if (!config.apiKeyConfigured || config.apiEnvironment !== 'Sandbox') {
        throw new Error('This action requires a saved Dojo sandbox key; live payments are not supported');
    }
    const validate = (attempt: TerminalPaymentAttempt) => {
        if (attempt.id !== attemptId || attempt.provider !== 'dojo'
            || !['sale', 'customer_account_payment'].includes(attempt.operationKind)
            || !['prepared', 'started', 'uncertain'].includes(attempt.status)
            || !attempt.clientTransactionId || !attempt.terminalSessionId) {
            throw new Error('Only an unresolved, unapproved sandbox collection with durable provider IDs can be canceled');
        }
    };
    const initial = await refreshPaymentTerminalAttempt('dojo', attemptId);
    validate(initial);
    const shared = terminalAttemptUsesSharedJournal(initial);
    if (shared && (state.mode !== 'multi' || !state.mysqlOnline)) {
        throw new Error('Reconnect the shared database before canceling this legacy shared sandbox payment');
    }
    if (shared) await assertMariaDbCommerceWritesAllowed();
    const scope = shared ? 'shared' : 'local';
    const tillId = await getOrCreateTillId();
    const reference = `sandbox-cancel:${attemptId}:${crypto.randomUUID()}`;
    const leased = await runWithTerminalRecoveryLease({
        acquire: async () => (await acquireTerminalLock(scope, initial.terminalKey, tillId, `${await getTillName()} sandbox recovery`.slice(0, 255), reference, 600)).acquired,
        refresh: () => refreshTerminalLock(scope, initial.terminalKey, tillId, reference, 600),
        release: () => releaseTerminalLock(scope, initial.terminalKey, tillId, reference),
    }, async (assertHeld) => {
        await assertHeld();
        const current = await refreshPaymentTerminalAttempt('dojo', attemptId);
        validate(current);
        if (current.terminalKey !== initial.terminalKey) throw new Error('The terminal journal changed; refresh before continuing');
        if (shared) await assertMariaDbCommerceWritesAllowed();
        await assertHeld();
        // Native code reads this refreshed journal itself, verifies the actual
        // saved key/session/payment, sends one DELETE, then requires Canceled.
        // Four bounded HTTP requests fit within this freshly renewed 10m lease.
        await cancelExpiredSandboxDojoPaymentIntent(attemptId);
        await assertHeld();
        // Deliberately no journal status write. Normal recovery still requires
        // separated final observations and is free to recover a racing capture.
    });
    if (!leased.acquired) throw new Error('The Dojo terminal is currently being checked by another till; try again after it finishes');
}

function withProviderReference(attempt: TerminalPaymentAttempt, reference: string): TerminalPaymentAttempt['saleBundle'] {
    const payload = structuredClone(attempt.saleBundle);
    if (isCustomerAccountPaymentPayload(payload)) {
        payload.reference = reference;
    } else {
        const existingReference = payload.payment.reference
            && !payload.payment.reference.startsWith('SumUp ')
            && !payload.payment.reference.startsWith('Dojo ')
            ? ` · ${payload.payment.reference}`
            : '';
        payload.payment.reference = `${reference}${existingReference}`;
    }
    return payload;
}

async function loadCommittedLocalBundle(bundle: SaleBundle): Promise<SaleBundle | null> {
    const db = await getSqliteDb();
    const [orders, payments, lines, accountEntries] = await Promise.all([
        db.select<any[]>('SELECT * FROM orders WHERE id = ? LIMIT 1', [bundle.order.id]),
        db.select<any[]>('SELECT * FROM payments WHERE orderId = ? LIMIT 1', [bundle.order.id]),
        db.select<any[]>('SELECT * FROM order_lines WHERE orderId = ? ORDER BY id', [bundle.order.id]),
        db.select<any[]>('SELECT * FROM customer_account_entries WHERE orderId = ? ORDER BY createdAt, id', [bundle.order.id]),
    ]);
    if (!orders[0]) return null;
    const committedAccounts = (bundle.accountChanges || []).map((change) => {
        const saved = accountEntries.find((entry) => entry.id === change.id
            || entry.idempotencyKey === change.idempotencyKey);
        return saved ? { ...change, ...saved } : change;
    });
    return {
        ...bundle,
        order: { ...bundle.order, ...orders[0] },
        payment: payments[0] ? { ...bundle.payment, ...payments[0] } : bundle.payment,
        lines: lines.length > 0
            ? lines.map((line) => ({ ...line, isPriceOverride: Boolean(line.isPriceOverride) }))
            : bundle.lines,
        accountChanges: committedAccounts,
    };
}

function mysqlUri(config: MysqlConfig): string {
    return `mysql://${encodeURIComponent(config.user)}:${encodeURIComponent(config.password)}`
        + `@${config.host}:${config.port}/${config.database}`;
}

async function ensureSaleBundleOnMariaDb(bundle: SaleBundle): Promise<void> {
    const state = get(connectionState);
    if (state.mode !== 'multi') return;
    if (!state.mysqlOnline || !state.mysqlConfig) {
        throw new Error('MariaDB must be online to finish terminal recovery');
    }
    await assertMariaDbCommerceWritesAllowed({
        allowPreparing: bundle.reportEpoch !== undefined,
    });
    await invoke<void>('commit_mysql_sale', {
        mysqlUri: mysqlUri(state.mysqlConfig),
        bundle,
    });
}

async function commitAttemptLedger(
    attempt: TerminalPaymentAttempt,
    assertLeaseHeld: AssertTerminalRecoveryLease,
): Promise<TerminalPaymentAttempt> {
    if (isCustomerAccountPaymentPayload(attempt.saleBundle)) {
        const payload = attempt.saleBundle;
        if (!payload.reference.trim()) {
            throw new Error('Approved customer-account card payment has no provider reference');
        }
        if (get(connectionState).mode === 'multi'
            && (payload.reportEpoch === undefined || payload.serverDataEpoch === undefined)) {
            throw new Error(
                'This legacy approved account payment has no MariaDB epoch fence and requires administrator review',
            );
        }
        await postCustomerAccountEntry({
            customerId: payload.customerId,
            entryType: 'payment',
            amountPence: payload.amountPence,
            paymentMethod: payload.paymentMethod,
            reference: payload.reference,
            description: payload.description,
            employeeId: payload.employeeId,
            tillNumber: payload.tillNumber,
            shiftId: payload.shiftId,
            idempotencyKey: payload.idempotencyKey,
            allowCreditBalance: payload.allowCreditBalance,
            reportEpoch: payload.reportEpoch,
            serverDataEpoch: payload.serverDataEpoch,
            tipsAmount: payload.tipsAmount,
            serviceChargeAmount: payload.serviceChargeAmount,
            cashbackAmount: payload.cashbackAmount,
        });
    } else if (!terminalAttemptUsesSharedJournal(attempt)) {
        // The native local transaction commits the sale and its sync outbox
        // atomically, including when recovering an already committed receipt.
        attempt.saleBundle = await commitPreparedTerminalSale(attempt.saleBundle, { journalScope: 'local' });
    } else {
        const locallyCommitted = await loadCommittedLocalBundle(attempt.saleBundle);
        if (locallyCommitted) {
            const preparedPayment = attempt.saleBundle.payment;
            if (TERMINAL_PAYMENT_EXTRA_FIELDS.some((field) =>
                Number(locallyCommitted.payment[field] || 0) !== Number(preparedPayment[field] || 0))) {
                throw new Error('The existing local sale has different terminal extra amounts; administrator review is required');
            }
            // A crash can occur after SQLite commits but before its outbox is
            // created. Replay the locally allocated receipt identity directly
            // to MariaDB before declaring terminal recovery complete.
            attempt.saleBundle = locallyCommitted;
            await ensureSaleBundleOnMariaDb(locallyCommitted);
        } else {
            const committed = await commitPreparedTerminalSale(attempt.saleBundle);
            attempt.saleBundle = committed;
            // Ordinary card sales commit locally first and queue MariaDB. Make
            // the recovery path authoritative instead of trusting that an
            // outbox write survived the same crash.
            await ensureSaleBundleOnMariaDb(committed);
        }
    }
    // The ledger writes above are idempotent. If this worker lost ownership,
    // leave the shared journal operational for the current owner to complete.
    await assertLeaseHeld();
    return updatePaymentTerminalAttempt(attempt.provider, attempt.id, 'completed', {
        saleBundle: attempt.saleBundle,
        error: '',
    });
}

async function verifyCompletedDojoAccounting(
    attempt: TerminalPaymentAttempt,
    extras: TerminalPaymentExtras,
): Promise<void> {
    const db = await getSqliteDb();
    const payload = attempt.saleBundle;
    const accountPayment = isCustomerAccountPaymentPayload(payload);
    const rows = accountPayment
        ? await db.select<any[]>('SELECT * FROM customer_account_entries WHERE idempotencyKey = ? AND customerId = ? LIMIT 1', [payload.idempotencyKey, payload.customerId])
        : await db.select<any[]>('SELECT * FROM payments WHERE id = ? AND orderId = ? LIMIT 1', [payload.payment.id, payload.order.id]);
    const stored = rows[0];
    const expectedBase = attempt.operationKind === 'refund' ? -attempt.amount : attempt.amount;
    const actualBase = accountPayment ? -Number(stored?.amountPence) : Number(stored?.cardAmount || stored?.amount);
    if (!stored || actualBase !== expectedBase || !String(stored.reference || '').includes(`[id:${attempt.clientTransactionId}]`)) {
        throw new Error('The completed Dojo journal does not match its saved financial payment; administrator review is required');
    }
    const journalPayment = accountPayment ? payload : payload.payment;
    if (TERMINAL_PAYMENT_EXTRA_FIELDS.some((field) => Number(stored[field] || 0) !== extras[field]
        || Number(journalPayment[field] || 0) !== extras[field])) {
        throw new Error('A completed Dojo payment has unrecorded or conflicting extra amounts; administrator review is required');
    }
}

async function recoverAttempt(
    attempt: TerminalPaymentAttempt,
    assertLeaseHeld: AssertTerminalRecoveryLease,
): Promise<'completed' | 'final' | 'uncertain'> {
    if (attempt.status === 'completed') {
        // Local completion can be newer than a stale operational MariaDB row.
        if (attempt.provider === 'dojo') {
            await assertLeaseHeld();
            const verified = attempt.operationKind === 'refund'
                ? await reconcileDojoRefund(attempt)
                : verifyDojoPayment(attempt, await getDojoPaymentIntentStatus(attempt.clientTransactionId), attempt.terminalSessionId);
            if (verified.outcome !== 'approved') {
                throw new Error(`Completed Dojo work needs review before shared acknowledgement: ${verified.error}`);
            }
            await verifyCompletedDojoAccounting(attempt, verified.extras ?? { tipsAmount: 0, serviceChargeAmount: 0, cashbackAmount: 0 });
        }
        const current = await acknowledgeApprovedPaymentTerminalAttempt(attempt, assertLeaseHeld);
        return current.status === 'completed' ? 'completed' : 'uncertain';
    }
    if (attempt.status === 'failed' || attempt.status === 'cancelled') {
        await assertLeaseHeld();
        const current = await updatePaymentTerminalAttempt(
            attempt.provider,
            attempt.id,
            attempt.status,
            { error: attempt.error },
        );
        if (current.status === 'completed') return 'completed';
        return current.status === 'failed' || current.status === 'cancelled' ? 'final' : 'uncertain';
    }
    if (['approved', 'commit_failed', 'completion_pending'].includes(attempt.status)) {
        try {
            if (attempt.provider === 'dojo') {
                // Legacy journals may predate accounting for terminal extras.
                // Revalidate actual capture before trusting or enriching them.
                await assertLeaseHeld();
                const verified = attempt.operationKind === 'refund'
                    ? await reconcileDojoRefund(attempt)
                    : verifyDojoPayment(attempt, await getDojoPaymentIntentStatus(attempt.clientTransactionId), attempt.terminalSessionId);
                if (verified.outcome !== 'approved') {
                    throw new Error(`Approved Dojo work needs review before ledger recovery: ${verified.error}`);
                }
                if (verified.extras) {
                    attempt = await persistVerifiedDojoPaymentAccounting(attempt, verified.extras, assertLeaseHeld);
                }
            }
            // A local provider result can be ahead of MariaDB after a network
            // loss. Compare-and-set it before touching the ledger, and adopt
            // any state another till has already moved farther forward.
            attempt = await acknowledgeApprovedPaymentTerminalAttempt(attempt, assertLeaseHeld);
            if (attempt.status === 'completed') return 'completed';
            if (!['approved', 'commit_failed', 'completion_pending'].includes(attempt.status)) {
                return 'uncertain';
            }
            const completed = await commitAttemptLedger(attempt, assertLeaseHeld);
            return completed.status === 'completed' ? 'completed' : 'uncertain';
        } catch (error) {
            await assertLeaseHeld()
                .then(() => updatePaymentTerminalAttempt(attempt.provider, attempt.id, 'commit_failed', {
                    saleBundle: attempt.saleBundle,
                    error: String(error),
                }))
                .catch(() => undefined);
            return 'uncertain';
        }
    }

    // Another till may currently be polling this terminal. The normal payment
    // window is three minutes; only take over a prepared/started attempt after
    // it has clearly outlived that owner.
    const lastUpdate = Date.parse(attempt.updatedAt);
    if ((attempt.status === 'prepared' || attempt.status === 'started')
        && Number.isFinite(lastUpdate)
        && Date.now() - lastUpdate < 4 * 60 * 1000) {
        return 'uncertain';
    }

    let reconciliation: ProviderReconciliation;
    try {
        reconciliation = attempt.provider === 'sumup'
            ? await reconcileSumup(attempt)
            : await reconcileDojo(attempt);
    } catch (error) {
        reconciliation = {
            outcome: 'uncertain',
            error: `Provider reconciliation could not complete: ${String(error)}`,
        };
    }
    reconciliation = settleRecoveredProviderOutcome(attempt, attempt.provider, reconciliation);
    // A provider response is only allowed to affect the journal while this
    // worker still exclusively owns the physical terminal. This closes the
    // failed-vs-captured race between two recovery workers.
    await assertLeaseHeld();
    if (reconciliation.outcome === 'uncertain') {
        const current = await updatePaymentTerminalAttempt(attempt.provider, attempt.id, 'uncertain', {
            error: reconciliation.error,
        }).catch(() => undefined);
        if (current?.status === 'completed') return 'completed';
        if (current?.status === 'failed' || current?.status === 'cancelled') return 'final';
        return 'uncertain';
    }
    if (reconciliation.outcome === 'failed' || reconciliation.outcome === 'cancelled') {
        const current = await updatePaymentTerminalAttempt(attempt.provider, attempt.id, reconciliation.outcome, {
            error: reconciliation.error,
        });
        if (current.status === 'completed') return 'completed';
        return current.status === 'failed' || current.status === 'cancelled' ? 'final' : 'uncertain';
    }
    if (reconciliation.outcome !== 'approved') return 'uncertain';

    attempt.clientTransactionId = reconciliation.clientTransactionId;
    // This is the immutable first-session anchor. Dojo's intent history,
    // verified above, identifies any later retry sessions.
    attempt.terminalSessionId ||= reconciliation.terminalSessionId || '';
    attempt.providerReference = reconciliation.providerReference;
    attempt.saleBundle = withProviderReference(attempt, reconciliation.providerReference);
    if (reconciliation.extras) {
        attempt.saleBundle = withTerminalPaymentExtras(attempt.saleBundle, reconciliation.extras);
    }
    attempt = await updatePaymentTerminalAttempt(attempt.provider, attempt.id, 'approved', {
        clientTransactionId: attempt.clientTransactionId,
        terminalSessionId: attempt.terminalSessionId,
        providerReference: attempt.providerReference,
        saleBundle: attempt.saleBundle,
        error: '',
    });
    if (attempt.status === 'completed') return 'completed';
    if (!['approved', 'commit_failed', 'completion_pending'].includes(attempt.status)) {
        return 'uncertain';
    }
    try {
        const completed = await commitAttemptLedger(attempt, assertLeaseHeld);
        return completed.status === 'completed' ? 'completed' : 'uncertain';
    } catch (error) {
        await assertLeaseHeld()
            .then(() => updatePaymentTerminalAttempt(attempt.provider, attempt.id, 'commit_failed', {
                saleBundle: attempt.saleBundle,
                error: String(error),
            }))
            .catch(() => undefined);
        return 'uncertain';
    }
}

async function recoverAttemptWithLease(
    staleAttempt: TerminalPaymentAttempt,
): Promise<'completed' | 'final' | 'uncertain'> {
    const state = get(connectionState);
    const scope = terminalAttemptUsesSharedJournal(staleAttempt) ? 'shared' : 'local';
    // Legacy shared attempts keep their original coordination requirement;
    // dedicated attempts always use their own persisted local lease.
    if (scope === 'shared' && (state.mode !== 'multi' || !state.mysqlOnline)) return 'uncertain';

    const tillId = await getOrCreateTillId();
    const tillName = await getTillName();
    const leaseTillName = `${tillName} recovery`.slice(0, 255);
    const paymentReference = `recovery:${staleAttempt.id}:${recoveryOwnerToken}`;
    const leased = await runWithTerminalRecoveryLease(
        {
            acquire: async () => (
                await acquireTerminalLock(scope,
                    staleAttempt.terminalKey,
                    tillId,
                    leaseTillName,
                    paymentReference,
                    600,
                )
            ).acquired,
            refresh: () => refreshTerminalLock(scope,
                staleAttempt.terminalKey,
                tillId,
                paymentReference,
                600,
            ),
            release: () => releaseTerminalLock(scope,
                staleAttempt.terminalKey,
                tillId,
                paymentReference,
            ),
        },
        async (assertHeld) => {
            await assertHeld();
            if (scope === 'shared') {
                // Keep the close/restore barrier on each legacy shared attempt,
                // rather than preventing unrelated dedicated work in the UI.
                await assertMariaDbCommerceWritesAllowed({ allowPreparing: true });
            }
            // Another worker may have completed/finalized this stale list item
            // before we acquired the lease. Re-read before any provider call.
            const current = await refreshPaymentTerminalAttempt(
                staleAttempt.provider,
                staleAttempt.id,
            );
            return recoverAttempt(current, assertHeld);
        },
    );
    return leased.acquired ? leased.value! : 'uncertain';
}

async function performTerminalRecovery(provider?: TerminalProvider): Promise<TerminalRecoveryResult> {
    const result: TerminalRecoveryResult = {
        scanned: 0,
        completed: 0,
        finalizedWithoutLedger: 0,
        stillUncertain: 0,
        errors: [],
        cashbackToReview: [],
    };
    if (!isTauri()) return result;

    const [sumupConfigResult, dojoConfigResult] = await Promise.allSettled([loadSumupConfig(), loadDojoConfig()]);
    const providers: TerminalProvider[] = provider ? [provider] : ['sumup', 'dojo'];
    for (const currentProvider of providers) {
        let attempts: TerminalPaymentAttempt[];
        try {
            const configResult = currentProvider === 'dojo' ? dojoConfigResult : sumupConfigResult;
            attempts = await getRecoverablePaymentTerminalAttempts(currentProvider, {
                includeShared: configResult.status !== 'fulfilled'
                    || configResult.value?.terminalOwnership !== 'dedicated',
            });
        } catch (error) {
            result.errors.push(`${currentProvider}: ${String(error)}`);
            continue;
        }
        for (const attempt of attempts) {
            result.scanned += 1;
            try {
                const outcome = await recoverAttemptWithLease(attempt);
                if (outcome === 'completed') {
                    result.completed += 1;
                    // Recovery cannot know whether cash was handed over before
                    // a crash. Report recorded cashback for operator review;
                    // never open a drawer or trigger a payout here.
                    try {
                        const completed = await refreshPaymentTerminalAttempt(attempt.provider, attempt.id);
                        const payload = completed.saleBundle;
                        const payment = isCustomerAccountPaymentPayload(payload) ? payload : payload.payment;
                        const cashback = Number(payment.cashbackAmount || 0);
                        if (completed.operationKind !== 'refund' && Number.isSafeInteger(cashback) && cashback > 0) {
                            result.cashbackToReview.push({ attemptId: completed.id, amount: cashback, currency: completed.currency });
                        }
                    } catch (error) {
                        result.errors.push(`Payment ${attempt.id} completed, but its cashback record could not be checked. Review the receipt before paying out any cash: ${String(error)}`);
                    }
                }
                else if (outcome === 'final') result.finalizedWithoutLedger += 1;
                else result.stillUncertain += 1;
            } catch (error) {
                result.stillUncertain += 1;
                result.errors.push(`${currentProvider} ${attempt.id}: ${String(error)}`);
            }
        }
    }
    // Local payment recovery must not wait for unrelated server maintenance.
    await prunePaymentTerminalAttempts(undefined, { includeShared: false }).catch(() => undefined);
    if (result.completed > 0) {
        await hydrateSvelteStores([
            'orders',
            'order_lines',
            'payments',
            'products',
            'inventory_logs',
            'loyalty_logs',
            'audit_logs',
            'customers',
            'customer_accounts',
            'customer_account_entries',
        ]).catch(() => undefined);
    }
    return result;
}

/** One global recovery run at a time, safe to call at startup and on the POS. */
export function runTerminalRecovery(provider?: TerminalProvider): Promise<TerminalRecoveryResult> {
    if (recoveryPromise) return recoveryPromise;
    recoveryPromise = performTerminalRecovery(provider).finally(() => {
        recoveryPromise = null;
    });
    return recoveryPromise;
}
