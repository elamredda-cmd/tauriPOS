import { invoke, isTauri } from '@tauri-apps/api/core';
import { get } from 'svelte/store';
import {
    assertMariaDbCommerceWritesAllowed,
    commitPreparedTerminalSale,
    hydrateSvelteStores,
    postCustomerAccountEntry,
    type SaleBundle,
} from '$lib/stores/database';
import { connectionState, type MysqlConfig } from '$lib/stores/connection';
import {
    mysqlAcquirePaymentTerminalLock,
    mysqlRefreshPaymentTerminalLock,
    mysqlReleasePaymentTerminalLock,
} from '$lib/stores/mysql';
import {
    getRecoverablePaymentTerminalAttempts,
    isCustomerAccountPaymentPayload,
    prunePaymentTerminalAttempts,
    refreshPaymentTerminalAttempt,
    updatePaymentTerminalAttempt,
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
    findDojoPaymentIntentByReference,
    getDojoPaymentIntentStatus,
    getDojoTerminalSessionStatus,
    loadDojoConfig,
    type DojoPaymentIntentStatus,
    type DojoRecoveredPayment,
    type DojoTerminalSessionStatus,
} from '$lib/dojo';
import {
    getDb as getSqliteDb,
    getOrCreateTillId,
    getTillName,
} from '$lib/stores/sqlite';
import {
    runWithTerminalRecoveryLease,
    type AssertTerminalRecoveryLease,
} from '$lib/terminalRecoveryLease';

export type ProviderReconciliation =
    | {
        outcome: 'approved';
        clientTransactionId: string;
        terminalSessionId?: string;
        providerReference: string;
    }
    | { outcome: 'failed' | 'cancelled'; error: string }
    | { outcome: 'uncertain'; error: string };

export interface TerminalRecoveryResult {
    scanned: number;
    completed: number;
    finalizedWithoutLedger: number;
    stillUncertain: number;
    errors: string[];
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
        ? { outcome: 'cancelled', error: `${marker} provider repeatedly confirmed no ${missingEffect} over 24 hours` }
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
    if (['DECLINED', 'SIGNATUREVERIFICATIONREJECTED'].includes(terminal)) return 'failed';
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

function verifyDojoPayment(
    attempt: TerminalPaymentAttempt,
    payment: DojoPaymentIntentStatus,
    terminalSessionId = '',
    terminalStatus = '',
): ProviderReconciliation {
    const classification = classifyDojoPaymentStatus(payment.status, terminalStatus);
    if (classification === 'failed' || classification === 'cancelled') {
        return {
            outcome: classification,
            error: `Dojo final status: ${terminalStatus || payment.status}`,
        };
    }
    if (classification !== 'approved') {
        return { outcome: 'uncertain', error: `Dojo is not final (${terminalStatus || payment.status || 'Unknown'})` };
    }
    if (payment.reference !== attempt.id) {
        return { outcome: 'uncertain', error: 'Dojo returned a captured payment with a different durable reference' };
    }
    if (payment.amount !== attempt.amount) {
        return { outcome: 'uncertain', error: 'Dojo returned a captured payment with a different amount' };
    }
    if ((payment.currency || '').toUpperCase() !== attempt.currency.toUpperCase()) {
        return { outcome: 'uncertain', error: 'Dojo returned a captured payment with a different currency' };
    }
    return {
        outcome: 'approved',
        clientTransactionId: payment.id,
        terminalSessionId,
        providerReference: dojoReference(payment),
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
    const before = attempt.expectedProviderAmount - attempt.amount;
    if (latest.refundedAmount === attempt.expectedProviderAmount) {
        return {
            outcome: 'approved',
            clientTransactionId: latest.id,
            providerReference: `Dojo refund ${latest.transactionId || latest.id} [id:${latest.id}]`,
        };
    }
    if (latest.refundedAmount === before) {
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
    if (attempt.terminalSessionId) {
        session = await getDojoTerminalSessionStatus(attempt.terminalSessionId);
    } else {
        recovered = await findDojoPaymentIntentByReference(attempt.id, attempt.createdAt);
        if (!recovered) {
            return providerMissingReconciliation(attempt, 'dojo');
        }
    }

    const paymentIntentId = attempt.clientTransactionId
        || session?.paymentIntentId
        || recovered?.payment.id
        || '';
    const terminalSessionId = attempt.terminalSessionId
        || recovered?.terminalSessionId
        || '';
    const terminalStatus = session?.status || recovered?.terminalSessionStatus || '';
    const payment = session?.payment
        || recovered?.payment
        || (paymentIntentId ? await getDojoPaymentIntentStatus(paymentIntentId) : null);
    if (!payment) {
        return { outcome: 'uncertain', error: 'Dojo found terminal work but no payment intent to reconcile' };
    }
    return verifyDojoPayment(attempt, payment, terminalSessionId, terminalStatus);
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
        });
    } else {
        const locallyCommitted = await loadCommittedLocalBundle(attempt.saleBundle);
        if (locallyCommitted) {
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

async function recoverAttempt(
    attempt: TerminalPaymentAttempt,
    assertLeaseHeld: AssertTerminalRecoveryLease,
): Promise<'completed' | 'final' | 'uncertain'> {
    if (attempt.status === 'completed') {
        // Local completion can be newer than a stale operational MariaDB row.
        await assertLeaseHeld();
        const current = await updatePaymentTerminalAttempt(attempt.provider, attempt.id, 'completed', {
            saleBundle: attempt.saleBundle,
            error: '',
        });
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
            // A local provider result can be ahead of MariaDB after a network
            // loss. Compare-and-set it before touching the ledger, and adopt
            // any state another till has already moved farther forward.
            await assertLeaseHeld();
            attempt = await updatePaymentTerminalAttempt(attempt.provider, attempt.id, attempt.status, {
                clientTransactionId: attempt.clientTransactionId,
                terminalSessionId: attempt.terminalSessionId,
                providerReference: attempt.providerReference,
                saleBundle: attempt.saleBundle,
                error: attempt.error,
            });
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
    if (reconciliation.outcome === 'failed' || reconciliation.outcome === 'cancelled') {
        reconciliation = settleProviderFinalReconciliation(
            attempt,
            attempt.provider,
            reconciliation.outcome,
            reconciliation.error,
        );
    }
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
    attempt.terminalSessionId = reconciliation.terminalSessionId || attempt.terminalSessionId;
    attempt.providerReference = reconciliation.providerReference;
    attempt.saleBundle = withProviderReference(attempt, reconciliation.providerReference);
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
    if (state.mode !== 'multi') {
        const current = await refreshPaymentTerminalAttempt(staleAttempt.provider, staleAttempt.id);
        return recoverAttempt(current, async () => undefined);
    }
    // Never perform provider reconciliation without the shared database: two
    // tills could otherwise publish contradictory observations independently.
    if (!state.mysqlOnline) return 'uncertain';

    const tillId = await getOrCreateTillId();
    const tillName = await getTillName();
    const leaseTillName = `${tillName} recovery`.slice(0, 255);
    const paymentReference = `recovery:${staleAttempt.id}:${recoveryOwnerToken}`;
    const leased = await runWithTerminalRecoveryLease(
        {
            acquire: async () => (
                await mysqlAcquirePaymentTerminalLock(
                    staleAttempt.terminalKey,
                    tillId,
                    leaseTillName,
                    paymentReference,
                    600,
                )
            ).acquired,
            refresh: () => mysqlRefreshPaymentTerminalLock(
                staleAttempt.terminalKey,
                tillId,
                paymentReference,
                600,
            ),
            release: () => mysqlReleasePaymentTerminalLock(
                staleAttempt.terminalKey,
                tillId,
                paymentReference,
            ),
        },
        async (assertHeld) => {
            await assertHeld();
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
    };
    if (!isTauri()) return result;

    await Promise.allSettled([loadSumupConfig(), loadDojoConfig()]);
    const providers: TerminalProvider[] = provider ? [provider] : ['sumup', 'dojo'];
    for (const currentProvider of providers) {
        let attempts: TerminalPaymentAttempt[];
        try {
            attempts = await getRecoverablePaymentTerminalAttempts(currentProvider);
        } catch (error) {
            result.errors.push(`${currentProvider}: ${String(error)}`);
            continue;
        }
        for (const attempt of attempts) {
            result.scanned += 1;
            try {
                const outcome = await recoverAttemptWithLease(attempt);
                if (outcome === 'completed') result.completed += 1;
                else if (outcome === 'final') result.finalizedWithoutLedger += 1;
                else result.stillUncertain += 1;
            } catch (error) {
                result.stillUncertain += 1;
                result.errors.push(`${currentProvider} ${attempt.id}: ${String(error)}`);
            }
        }
    }
    await prunePaymentTerminalAttempts().catch(() => undefined);
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
