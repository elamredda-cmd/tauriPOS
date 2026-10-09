import { get } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';
import type { SaleBundle } from '$lib/stores/database';
import {
    assertMariaDbCommerceWritesAllowed,
    withCurrentReportEpoch,
    withLocalTerminalPreparation,
} from '$lib/stores/database';
import { connectionState } from '$lib/stores/connection';
import {
    mysqlEnrichDojoTerminalAccounting,
    mysqlGetOperationalPaymentTerminalAttempts,
    mysqlGetPaymentTerminalAttempt,
    mysqlPreparePaymentTerminalAttempt,
    mysqlPrunePaymentTerminalAttempts,
    mysqlUpdatePaymentTerminalAttempt,
    type MysqlPaymentTerminalAttempt,
    type MysqlPaymentTerminalAttemptUpdate,
} from '$lib/stores/mysql';
import { getDb as getSqliteDb } from '$lib/stores/sqlite';
import {
    assertTerminalAccountingEnrichment,
    isTerminalAttemptTransitionAllowed,
    TERMINAL_PAYMENT_EXTRA_FIELDS,
    terminalAttemptStateStrength,
    terminalAttemptUpdatePredecessors,
    type TerminalPaymentExtras,
    type TerminalAttemptState,
} from '$lib/terminalAttemptState';
import type { TerminalJournalScope } from '$lib/terminalRecoveryLease';

export type TerminalProvider = 'sumup' | 'dojo';

export type TerminalAttemptStatus = TerminalAttemptState;

export type TerminalOperationKind = 'sale' | 'refund' | 'customer_account_payment';

export interface CustomerAccountPaymentAttemptPayload {
    kind: 'customer_account_payment';
    customerId: string;
    /** Append-only ledger movement. A payment is negative. */
    amountPence: number;
    paymentMethod: 'card';
    reference: string;
    description: string;
    employeeId: string;
    tillNumber: string;
    shiftId: string;
    idempotencyKey: string;
    allowCreditBalance: true;
    reportEpoch?: string;
    serverDataEpoch?: string;
    tipsAmount?: number;
    serviceChargeAmount?: number;
    cashbackAmount?: number;
}

export type TerminalAttemptPayload = SaleBundle | CustomerAccountPaymentAttemptPayload;

export interface TerminalPaymentAttempt {
    /** Missing legacy values are shared; connectivity must never reclassify a payment. */
    journalScope?: TerminalJournalScope;
    id: string;
    provider: TerminalProvider;
    terminalKey: string;
    clientTransactionId: string;
    terminalSessionId: string;
    operationKind: TerminalOperationKind;
    /** Positive amount sent to (or refunded by) the provider, in pence. */
    amount: number;
    /** Sale/account amount, or cumulative provider refund total expected. */
    expectedProviderAmount: number;
    currency: string;
    status: TerminalAttemptStatus;
    saleBundle: TerminalAttemptPayload;
    providerReference: string;
    /** Set only by the native, PIN-verified expiry review. Never part of an ordinary update. */
    operatorResolution?: string;
    error: string;
    tillId: string;
    createdAt: string;
    updatedAt: string;
}

export type TerminalAttemptUpdate = Partial<Pick<
    TerminalPaymentAttempt,
    | 'clientTransactionId'
    | 'terminalSessionId'
    | 'saleBundle'
    | 'providerReference'
    | 'error'
>>;

export const OPERATIONAL_TERMINAL_ATTEMPT_STATUSES: readonly TerminalAttemptStatus[] = [
    'prepared',
    'started',
    'uncertain',
    'approved',
    'commit_failed',
    'completion_pending',
];

const OPERATIONAL_STATUS_SQL = OPERATIONAL_TERMINAL_ATTEMPT_STATUSES
    .map((status) => `'${status}'`)
    .join(', ');

export function isOperationalTerminalAttemptStatus(status: string): status is TerminalAttemptStatus {
    return OPERATIONAL_TERMINAL_ATTEMPT_STATUSES.includes(status as TerminalAttemptStatus);
}

export function isCustomerAccountPaymentPayload(
    payload: TerminalAttemptPayload,
): payload is CustomerAccountPaymentAttemptPayload {
    return Boolean(payload && (payload as CustomerAccountPaymentAttemptPayload).kind === 'customer_account_payment');
}

export function inferTerminalOperationKind(payload: TerminalAttemptPayload): TerminalOperationKind {
    if (isCustomerAccountPaymentPayload(payload)) return 'customer_account_payment';
    return payload.order?.type === 'return' ? 'refund' : 'sale';
}

function isMultiMode(): boolean {
    return get(connectionState).mode === 'multi';
}

export function terminalAttemptUsesSharedJournal(attempt: Pick<TerminalPaymentAttempt, 'journalScope'>): boolean {
    return attempt.journalScope !== 'local';
}

/**
 * Extract the exact sale bundle returned by durable terminal preparation.
 * In multi-till mode that payload must already contain the close/report epoch;
 * callers must never fall back to the earlier unstamped object they submitted.
 */
export function requirePreparedSaleBundle(attempt: TerminalPaymentAttempt): SaleBundle {
    if (isCustomerAccountPaymentPayload(attempt.saleBundle)) {
        throw new Error('This terminal attempt contains a customer-account payment, not a sale bundle');
    }
    if (isMultiMode() && attempt.saleBundle.reportEpoch === undefined) {
        throw new Error('The terminal recovery journal did not return a prepared report epoch');
    }
    if (isMultiMode() && attempt.saleBundle.serverDataEpoch === undefined) {
        throw new Error('The terminal recovery journal did not return a prepared server data epoch');
    }
    return attempt.saleBundle;
}

function validateAttempt(attempt: TerminalPaymentAttempt): void {
    if (!attempt.id.trim()) throw new Error('Terminal recovery reference is required');
    if (!attempt.terminalKey.trim()) throw new Error('Terminal recovery key is required');
    if (!Number.isSafeInteger(attempt.amount) || attempt.amount <= 0) {
        throw new Error('Terminal recovery amount must be a positive whole number of pence');
    }
    if (!Number.isSafeInteger(attempt.expectedProviderAmount) || attempt.expectedProviderAmount < 0) {
        throw new Error('Terminal recovery expected amount is invalid');
    }
    if (!attempt.currency.trim()) throw new Error('Terminal recovery currency is required');
    if (attempt.status !== 'prepared') throw new Error('A new terminal attempt must start as prepared');
    if (attempt.operationKind !== inferTerminalOperationKind(attempt.saleBundle)) {
        throw new Error('Terminal recovery operation does not match its durable payload');
    }
}

function serializeAttempt(attempt: TerminalPaymentAttempt): MysqlPaymentTerminalAttempt {
    return {
        ...attempt,
        saleBundle: JSON.stringify(attempt.saleBundle),
    };
}

function normalizeAttempt(row: any): TerminalPaymentAttempt {
    const payload = typeof row.saleBundle === 'string'
        ? JSON.parse(row.saleBundle) as TerminalAttemptPayload
        : row.saleBundle as TerminalAttemptPayload;
    const inferredKind = inferTerminalOperationKind(payload);
    const storedKind = String(row.operationKind || '') as TerminalOperationKind;
    const amount = Number(row.amount || 0);
    return {
        journalScope: row.journalScope === 'local' ? 'local' : 'shared',
        id: String(row.id || ''),
        provider: String(row.provider || '') as TerminalProvider,
        terminalKey: String(row.terminalKey || ''),
        clientTransactionId: String(row.clientTransactionId || ''),
        terminalSessionId: String(row.terminalSessionId || ''),
        operationKind: !storedKind
            || !['sale', 'refund', 'customer_account_payment'].includes(storedKind)
            || (storedKind === 'sale' && inferredKind !== 'sale')
            ? inferredKind
            : storedKind,
        amount,
        expectedProviderAmount: Number(row.expectedProviderAmount || amount),
        currency: String(row.currency || ''),
        status: String(row.status || '') as TerminalAttemptStatus,
        saleBundle: payload,
        providerReference: String(row.providerReference || ''),
        operatorResolution: String(row.operatorResolution || ''),
        error: String(row.error || ''),
        tillId: String(row.tillId || ''),
        createdAt: String(row.createdAt || ''),
        updatedAt: String(row.updatedAt || ''),
    };
}

async function insertLocalAttempt(attempt: TerminalPaymentAttempt): Promise<void> {
    const db = await getSqliteDb();
    await db.execute(
        `INSERT INTO payment_terminal_attempts
            (id, provider, terminalKey, clientTransactionId, terminalSessionId,
             operationKind, amount, expectedProviderAmount, currency, status,
             saleBundle, providerReference, error, tillId, createdAt, updatedAt, journalScope)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            attempt.id,
            attempt.provider,
            attempt.terminalKey,
            attempt.clientTransactionId,
            attempt.terminalSessionId,
            attempt.operationKind,
            attempt.amount,
            attempt.expectedProviderAmount,
            attempt.currency,
            attempt.status,
            JSON.stringify(attempt.saleBundle),
            attempt.providerReference,
            attempt.error,
            attempt.tillId,
            attempt.createdAt,
            attempt.updatedAt,
            attempt.journalScope ?? 'shared',
        ],
    );
}

async function updateLocalAttempt(
    provider: TerminalProvider,
    id: string,
    status: TerminalAttemptStatus,
    values: TerminalAttemptUpdate = {},
): Promise<{ applied: boolean; attempt: TerminalPaymentAttempt }> {
    const db = await getSqliteDb();
    const predecessors = terminalAttemptUpdatePredecessors(status);
    if (predecessors.length === 0) throw new Error(`Invalid terminal recovery status: ${status}`);
    const updates = ['status = ?', 'updatedAt = ?'];
    const parameters: unknown[] = [status, new Date().toISOString()];
    const columns: Array<keyof TerminalAttemptUpdate> = [
        'clientTransactionId',
        'terminalSessionId',
        'providerReference',
        'error',
    ];
    for (const column of columns) {
        if (values[column] === undefined) continue;
        if (column === 'clientTransactionId'
            || column === 'terminalSessionId'
            || column === 'providerReference') {
            updates.push(`${column} = CASE WHEN ${column} = '' THEN ? ELSE ${column} END`);
        } else {
            updates.push(`${column} = ?`);
        }
        parameters.push(values[column]);
    }
    if (values.saleBundle !== undefined) {
        updates.push('saleBundle = CASE WHEN status <> ? THEN ? ELSE saleBundle END');
        parameters.push(status, JSON.stringify(values.saleBundle));
    }
    parameters.push(id, provider, ...predecessors);
    const result = await db.execute(
        `UPDATE payment_terminal_attempts
         SET ${updates.join(', ')}
         WHERE id = ? AND provider = ?
           AND status IN (${predecessors.map(() => '?').join(', ')})`,
        parameters,
    );
    const rows = await db.select<any[]>(
        `SELECT * FROM payment_terminal_attempts WHERE id = ? AND provider = ? LIMIT 1`,
        [id, provider],
    );
    if (!rows[0]) throw new Error(`Local ${provider} recovery attempt ${id} is missing`);
    return {
        applied: Number(result.rowsAffected || 0) === 1,
        attempt: normalizeAttempt(rows[0]),
    };
}

/**
 * Durably prepare MariaDB first in multi-till mode. No provider API may be
 * called if either journal write fails.
 */
export async function preparePaymentTerminalAttempt<T extends TerminalPaymentAttempt>(
    attempt: T,
): Promise<T> {
    validateAttempt(attempt);
    if (!terminalAttemptUsesSharedJournal(attempt)) {
        return withLocalTerminalPreparation(async () => {
            // Shared customer balances and refund ceilings still need a live
            // financial preflight before a terminal can collect/refund money.
            const needsSharedFinancialState = isMultiMode()
                && (attempt.operationKind !== 'sale'
                    || (!isCustomerAccountPaymentPayload(attempt.saleBundle)
                        && (Boolean(attempt.saleBundle.accountChanges?.length)
                            || Boolean(attempt.saleBundle.loyaltyChanges?.some(
                                (change) => change.reason === 'redeemed' && change.pointsChange < 0,
                            )))));
            if (needsSharedFinancialState) await assertMariaDbCommerceWritesAllowed();
            const durableAttempt = {
                ...attempt,
                journalScope: 'local' as const,
                saleBundle: await withCurrentReportEpoch(attempt.saleBundle,
                    needsSharedFinancialState ? { requireLiveServerDataEpoch: true } : { localOnly: true }),
            };
            const prepared = await invoke<MysqlPaymentTerminalAttempt>('terminal_prepare_local_attempt', {
                attempt: serializeAttempt(durableAttempt),
            });
            return normalizeAttempt(prepared) as T;
        });
    }
    let remotePrepared = false;
    let localAttempt: TerminalPaymentAttempt = attempt;
    if (terminalAttemptUsesSharedJournal(attempt)) {
        if (!isMultiMode()) throw new Error('This shared terminal requires MariaDB. Register it as dedicated to this till to use local payments.');
        await assertMariaDbCommerceWritesAllowed();
        // Persist both the report cutoff and MariaDB dataset identity before
        // any irreversible provider call. Recovery must commit this exact
        // prepared payload, never re-label it after a close or restore.
        const durableAttempt: TerminalPaymentAttempt = {
            ...attempt,
            saleBundle: await withCurrentReportEpoch(attempt.saleBundle, {
                requireLiveServerDataEpoch: true,
            }),
        };
        let prepared: MysqlPaymentTerminalAttempt;
        try {
            prepared = await mysqlPreparePaymentTerminalAttempt(serializeAttempt(durableAttempt));
        } catch (error) {
            if (/uq_payment_terminal_active/i.test(String(error))) {
                // The unique active key is an intentional financial safety
                // barrier. Explain the existing work instead of showing SQL
                // internals or suggesting another charge.
                const active = await mysqlGetOperationalPaymentTerminalAttempts(attempt.provider)
                    .then((rows) => rows.find((row) => row.terminalKey === attempt.terminalKey))
                    .catch(() => undefined);
                const providerName = attempt.provider === 'dojo' ? 'Dojo' : 'SumUp';
                const progress = active && ['approved', 'commit_failed', 'completion_pending'].includes(active.status)
                    ? 'An earlier payment was approved and its sale is still being saved.'
                    : 'An earlier payment is still being processed or its result is being checked.';
                throw new Error(`${providerName} terminal busy. ${progress} Wait for recovery to finish and check the original payment before trying again. No new payment was sent.`);
            }
            throw error;
        }
        // The shared server's timestamps are the only safe basis for takeover
        // across tills whose Windows clocks may disagree.
        localAttempt = normalizeAttempt(prepared);
        remotePrepared = true;
    }
    try {
        await insertLocalAttempt(localAttempt);
    } catch (error) {
        if (remotePrepared) {
            await mysqlUpdatePaymentTerminalAttempt(
                attempt.id,
                attempt.provider,
                'cancelled',
                { error: `Local journal preparation failed before provider call: ${String(error)}` },
            ).catch(() => undefined);
        }
        throw new Error(`The terminal recovery journal could not be prepared: ${String(error)}`);
    }
    return localAttempt as T;
}

/**
 * Re-check both the maintenance barrier and shared prepared row immediately
 * before an irreversible provider request.
 */
export async function assertPaymentTerminalAttemptReady(
    provider: TerminalProvider,
    id: string,
): Promise<void> {
    const db = await getSqliteDb();
    const rows = await db.select<any[]>(
        `SELECT * FROM payment_terminal_attempts
         WHERE id = ? AND provider = ? LIMIT 1`,
        [id, provider],
    );
    const local = rows[0];
    if (!local || !['prepared', 'started'].includes(String(local.status || ''))) {
        throw new Error(`The ${provider} request is not in a safe prepared state`);
    }
    if (!terminalAttemptUsesSharedJournal(local)) {
        await withLocalTerminalPreparation(async () => undefined);
        return;
    }
    await assertMariaDbCommerceWritesAllowed();
    const remote = await mysqlGetPaymentTerminalAttempt(id, provider);
    if (!remote
        || !['prepared', 'started'].includes(remote.status)
        || remote.terminalKey !== String(local.terminalKey || '')
        || remote.amount !== Number(local.amount || 0)) {
        throw new Error(`The shared ${provider} recovery journal is missing or does not match; no card request was sent`);
    }
}

export async function updatePaymentTerminalAttempt(
    provider: TerminalProvider,
    id: string,
    status: TerminalAttemptStatus,
    values: TerminalAttemptUpdate = {},
): Promise<TerminalPaymentAttempt> {
    const db = await getSqliteDb();
    const rows = await db.select<any[]>(
        `SELECT * FROM payment_terminal_attempts WHERE id = ? AND provider = ? LIMIT 1`, [id, provider],
    );
    if (!rows[0]) throw new Error(`Local ${provider} recovery attempt ${id} is missing`);
    const shared = terminalAttemptUsesSharedJournal(rows[0]);
    const remoteValues: MysqlPaymentTerminalAttemptUpdate = {
        ...(values.clientTransactionId !== undefined ? { clientTransactionId: values.clientTransactionId } : {}),
        ...(values.terminalSessionId !== undefined ? { terminalSessionId: values.terminalSessionId } : {}),
        ...(values.providerReference !== undefined ? { providerReference: values.providerReference } : {}),
        ...(values.error !== undefined ? { error: values.error } : {}),
        ...(values.saleBundle !== undefined ? { saleBundle: JSON.stringify(values.saleBundle) } : {}),
    };
    if (status === 'completed' && shared) {
        // The ledger has already committed. Keep the local row operational
        // until MariaDB acknowledges completion so a crash cannot strand an
        // invisible shared blocker.
        await updateLocalAttempt(provider, id, 'completion_pending', values);
        try {
            const remote = await mysqlUpdatePaymentTerminalAttempt(
                id,
                provider,
                'completed',
                remoteValues,
            );
            await cacheRemoteAttempt(remote.attempt);
            if (remote.attempt.status !== 'completed') {
                const pending = await updateLocalAttempt(provider, id, 'completion_pending', {
                    ...values,
                    error: `Ledger committed, but the shared journal rejected completion from ${remote.attempt.status}`,
                });
                if (pending.attempt.status === 'completed') {
                    throw new Error('The sale is saved locally, but shared terminal completion has not been acknowledged');
                }
                return pending.attempt;
            }
            return (await updateLocalAttempt(provider, id, 'completed', values)).attempt;
        } catch (error) {
            const pending = await updateLocalAttempt(provider, id, 'completion_pending', {
                ...values,
                error: `Ledger committed; shared completion is pending: ${String(error)}`,
            });
            // A final local row cannot be downgraded. Returning that row here
            // would falsely tell recovery that MariaDB released its active key.
            if (pending.attempt.status === 'completed') throw error;
            return pending.attempt;
        }
    }

    const local = await updateLocalAttempt(provider, id, status, values);
    if (!shared) return local.attempt;
    const remote = await mysqlUpdatePaymentTerminalAttempt(
        id,
        provider,
        status,
        remoteValues,
    );
    return cacheRemoteAttempt(remote.attempt);
}

function assertSameTerminalAttemptProof(
    local: TerminalPaymentAttempt,
    remote: MysqlPaymentTerminalAttempt,
): void {
    if (remote.id !== local.id
        || remote.provider !== local.provider
        || remote.terminalKey !== local.terminalKey
        || remote.operationKind !== local.operationKind
        || remote.amount !== local.amount
        || Number(remote.expectedProviderAmount || remote.amount) !== local.expectedProviderAmount
        || remote.currency.toUpperCase() !== local.currency.toUpperCase()) {
        throw new Error('The shared terminal recovery journal does not match the approved payment; administrator review is required');
    }
    for (const key of ['clientTransactionId', 'terminalSessionId', 'providerReference'] as const) {
        if (remote[key] && local[key] && remote[key] !== local[key]) {
            throw new Error('The shared terminal recovery journal has different provider evidence; administrator review is required');
        }
    }
    if (remote.status === 'failed' || remote.status === 'cancelled') {
        throw new Error('The shared terminal journal has a final failure conflicting with local approval; administrator review is required');
    }
    if (['approved', 'commit_failed', 'completion_pending', 'completed'].includes(remote.status)) {
        const remotePayload = JSON.parse(remote.saleBundle) as TerminalAttemptPayload;
        const remotePayment = isCustomerAccountPaymentPayload(remotePayload) ? remotePayload : remotePayload.payment;
        const localPayment = isCustomerAccountPaymentPayload(local.saleBundle) ? local.saleBundle : local.saleBundle.payment;
        for (const field of TERMINAL_PAYMENT_EXTRA_FIELDS) {
            // Missing legacy fields carry no recorded amount. Once shared
            // approval explicitly records an amount (including zero), stronger
            // local state must not replace it with conflicting financial proof.
            if (!Object.prototype.hasOwnProperty.call(remotePayment, field)) continue;
            const recorded = remotePayment[field];
            const proposed = Object.prototype.hasOwnProperty.call(localPayment, field) ? localPayment[field] : 0;
            if (!Number.isSafeInteger(recorded) || Number(recorded) < 0 || proposed !== recorded) {
                throw new Error('The shared approved terminal payment has conflicting extra amounts; administrator review is required');
            }
        }
    }
}

/**
 * Repair a lost shared approval acknowledgement without weakening normal
 * state transitions. Only a recovery worker holding the terminal lease may
 * replay durable local approval through the missing intermediate state.
 */
export async function acknowledgeApprovedPaymentTerminalAttempt(
    attempt: TerminalPaymentAttempt,
    assertLeaseHeld: () => Promise<void>,
): Promise<TerminalPaymentAttempt> {
    if (!['approved', 'commit_failed', 'completion_pending', 'completed'].includes(attempt.status)) {
        throw new Error('Only durable approved terminal work can acknowledge shared approval');
    }
    if (!terminalAttemptUsesSharedJournal(attempt)) return attempt;
    await assertLeaseHeld();
    let remote = await mysqlGetPaymentTerminalAttempt(attempt.id, attempt.provider);
    if (!remote) throw new Error(`Shared ${attempt.provider} recovery attempt ${attempt.id} is missing`);
    assertSameTerminalAttemptProof(attempt, remote);
    const requestedStrength = terminalAttemptStateStrength(attempt.status);
    const sharedPayload = structuredClone(attempt.saleBundle);
    if (['approved', 'commit_failed', 'completion_pending', 'completed'].includes(remote.status)) {
        const remotePayload = JSON.parse(remote.saleBundle) as TerminalAttemptPayload;
        const remotePayment = isCustomerAccountPaymentPayload(remotePayload) ? remotePayload : remotePayload.payment;
        const sharedPayment = isCustomerAccountPaymentPayload(sharedPayload) ? sharedPayload : sharedPayload.payment;
        for (const field of TERMINAL_PAYMENT_EXTRA_FIELDS) {
            // A missing local legacy field may match a recorded zero, but keep
            // that explicit shared zero instead of erasing its proof metadata.
            if (!Object.prototype.hasOwnProperty.call(sharedPayment, field)
                && Object.prototype.hasOwnProperty.call(remotePayment, field)) {
                sharedPayment[field] = remotePayment[field];
            }
        }
    }
    const values: MysqlPaymentTerminalAttemptUpdate = {
        clientTransactionId: attempt.clientTransactionId,
        terminalSessionId: attempt.terminalSessionId,
        providerReference: attempt.providerReference,
        saleBundle: JSON.stringify(sharedPayload),
        error: attempt.error,
    };
    if (terminalAttemptStateStrength(remote.status) < requestedStrength) {
        if (!attempt.clientTransactionId || !attempt.providerReference) {
            throw new Error('Local approved terminal work has no complete provider evidence; administrator review is required');
        }
        const stages: TerminalAttemptStatus[] = isTerminalAttemptTransitionAllowed(remote.status, attempt.status)
            ? [attempt.status]
            : ['approved', attempt.status];
        for (const status of stages) {
            if (terminalAttemptStateStrength(remote.status) >= requestedStrength) break;
            if (!isTerminalAttemptTransitionAllowed(remote.status, status)) {
                throw new Error(`Shared terminal approval cannot advance from ${remote.status}; administrator review is required`);
            }
            await assertLeaseHeld();
            const acknowledged = await mysqlUpdatePaymentTerminalAttempt(attempt.id, attempt.provider, status, values);
            remote = acknowledged.attempt;
            assertSameTerminalAttemptProof(attempt, remote);
            if (terminalAttemptStateStrength(remote.status) < terminalAttemptStateStrength(status)) {
                throw new Error(`The shared terminal journal did not acknowledge ${status}; recovery remains pending`);
            }
        }
    }
    // Inspect the actual shared result before the monotonic local merge: a
    // stronger local completed row is not proof of a successful server ACK.
    if (terminalAttemptStateStrength(remote.status) < requestedStrength) {
        throw new Error('Shared terminal completion has not been acknowledged; recovery remains pending');
    }
    return cacheRemoteAttempt(remote);
}

export function withTerminalPaymentExtras(
    payload: TerminalAttemptPayload,
    extras: TerminalPaymentExtras,
): TerminalAttemptPayload {
    return isCustomerAccountPaymentPayload(payload)
        ? { ...payload, ...extras }
        : { ...payload, payment: { ...payload.payment, ...extras } };
}

/** Persist newly verified legacy extras before any ledger write, using exact-payload CAS. */
export async function persistVerifiedDojoPaymentAccounting(
    attempt: TerminalPaymentAttempt,
    extras: TerminalPaymentExtras,
    assertLeaseHeld: () => Promise<void>,
): Promise<TerminalPaymentAttempt> {
    if (attempt.provider !== 'dojo' || attempt.operationKind === 'refund'
        || !['approved', 'commit_failed', 'completion_pending'].includes(attempt.status)) {
        throw new Error('Only pending approved Dojo sales can reconcile terminal accounting');
    }
    const enriched = withTerminalPaymentExtras(attempt.saleBundle, extras);
    const enrichedJson = JSON.stringify(enriched);
    assertTerminalAccountingEnrichment(JSON.stringify(attempt.saleBundle), enrichedJson);
    if (enrichedJson === JSON.stringify(attempt.saleBundle)) return attempt;
    const db = await getSqliteDb();
    const localRows = await db.select<any[]>(
        `SELECT * FROM payment_terminal_attempts WHERE id = ? AND provider = 'dojo' LIMIT 1`, [attempt.id],
    );
    const local = localRows[0];
    if (!local || !['approved', 'commit_failed', 'completion_pending'].includes(local.status)) {
        throw new Error('Local terminal accounting changed during reconciliation; recovery remains pending');
    }
    assertTerminalAccountingEnrichment(String(local.saleBundle), enrichedJson);
    if (terminalAttemptUsesSharedJournal(attempt)) {
        await assertLeaseHeld();
        const remote = await mysqlGetPaymentTerminalAttempt(attempt.id, 'dojo');
        if (!remote) throw new Error('The shared Dojo recovery journal is missing');
        assertSameTerminalAttemptProof({ ...attempt, saleBundle: enriched }, remote);
        if (remote.status === 'completed') {
            // Completed ledgers must not be retroactively rewritten. Missing
            // zero fields are harmless, but unrecorded collections need review.
            const payload = JSON.parse(remote.saleBundle) as TerminalAttemptPayload;
            const payment = isCustomerAccountPaymentPayload(payload) ? payload : payload.payment;
            if (Object.entries(extras).some(([field, amount]) => Number((payment as any)[field] || 0) !== amount)) {
                throw new Error('The completed shared payment has different extra amounts; administrator review is required');
            }
            return cacheRemoteAttempt(remote);
        }
        const remoteEnriched = JSON.stringify(withTerminalPaymentExtras(JSON.parse(remote.saleBundle), extras));
        await assertLeaseHeld();
        await mysqlEnrichDojoTerminalAccounting(remote, remoteEnriched);
    }
    await assertLeaseHeld();
    await db.execute(
        `UPDATE payment_terminal_attempts SET saleBundle = ?
         WHERE id = ? AND provider = 'dojo' AND status = ? AND saleBundle = ?`,
        [enrichedJson, attempt.id, local.status, local.saleBundle],
    );
    const rows = await db.select<any[]>(
        `SELECT * FROM payment_terminal_attempts WHERE id = ? AND provider = 'dojo' LIMIT 1`, [attempt.id],
    );
    if (!rows[0] || rows[0].saleBundle !== enrichedJson || rows[0].status !== local.status) {
        throw new Error('Local terminal accounting was not acknowledged; recovery remains pending');
    }
    return normalizeAttempt(rows[0]);
}

function sqliteTerminalAttemptStrength(column: string): string {
    return `CASE ${column}
        WHEN 'prepared' THEN 0
        WHEN 'started' THEN 10
        WHEN 'uncertain' THEN 20
        WHEN 'failed' THEN 30
        WHEN 'cancelled' THEN 30
        WHEN 'approved' THEN 40
        WHEN 'commit_failed' THEN 50
        WHEN 'completion_pending' THEN 60
        WHEN 'completed' THEN 70
        ELSE -1 END`;
}

async function cacheRemoteAttempt(remote: MysqlPaymentTerminalAttempt): Promise<TerminalPaymentAttempt> {
    const db = await getSqliteDb();
    const assertMergeIdentity = (row: any) => {
        const local = normalizeAttempt(row);
        if (!terminalAttemptUsesSharedJournal(local)) {
            throw new Error('A shared terminal record conflicts with a dedicated local payment. Administrator review is required; neither payment was cleared.');
        }
        const incoming = normalizeAttempt(remote);
        if (local.provider !== incoming.provider || local.terminalKey !== incoming.terminalKey
            || local.operationKind !== incoming.operationKind || local.amount !== incoming.amount
            || local.expectedProviderAmount !== incoming.expectedProviderAmount
            || local.currency.toUpperCase() !== incoming.currency.toUpperCase()
            || (['clientTransactionId', 'terminalSessionId', 'providerReference'] as const).some(
                (key) => local[key] && incoming[key] && local[key] !== incoming[key],
            )) {
            throw new Error('The shared terminal record has conflicting payment identity. Administrator review is required; neither payment was cleared.');
        }
    };
    const existing = await db.select<any[]>('SELECT * FROM payment_terminal_attempts WHERE id = ? LIMIT 1', [remote.id]);
    if (existing[0]) assertMergeIdentity(existing[0]);
    const currentStrength = sqliteTerminalAttemptStrength('payment_terminal_attempts.status');
    const remoteStrength = sqliteTerminalAttemptStrength('excluded.status');
    const preferRemote = `${remoteStrength} > ${currentStrength}`;
    const merged = await db.execute(
        `INSERT INTO payment_terminal_attempts
            (id, provider, terminalKey, clientTransactionId, terminalSessionId,
             operationKind, amount, expectedProviderAmount, currency, status,
             saleBundle, providerReference, error, tillId, createdAt, updatedAt, operatorResolution, journalScope)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'shared')
         ON CONFLICT(id) DO UPDATE SET
            clientTransactionId = CASE
                WHEN ${preferRemote} AND excluded.clientTransactionId <> '' THEN excluded.clientTransactionId
                WHEN payment_terminal_attempts.clientTransactionId <> '' THEN payment_terminal_attempts.clientTransactionId
                ELSE excluded.clientTransactionId END,
            terminalSessionId = CASE
                WHEN ${preferRemote} AND excluded.terminalSessionId <> '' THEN excluded.terminalSessionId
                WHEN payment_terminal_attempts.terminalSessionId <> '' THEN payment_terminal_attempts.terminalSessionId
                ELSE excluded.terminalSessionId END,
            status = CASE WHEN ${preferRemote} THEN excluded.status ELSE payment_terminal_attempts.status END,
            saleBundle = CASE WHEN ${preferRemote} THEN excluded.saleBundle ELSE payment_terminal_attempts.saleBundle END,
            providerReference = CASE
                WHEN ${preferRemote} AND excluded.providerReference <> '' THEN excluded.providerReference
                WHEN payment_terminal_attempts.providerReference <> '' THEN payment_terminal_attempts.providerReference
                ELSE excluded.providerReference END,
            error = CASE WHEN ${remoteStrength} >= ${currentStrength}
                         THEN excluded.error ELSE payment_terminal_attempts.error END,
            operatorResolution = CASE WHEN excluded.operatorResolution <> '' THEN excluded.operatorResolution
                                      ELSE payment_terminal_attempts.operatorResolution END,
            tillId = CASE WHEN payment_terminal_attempts.tillId = '' THEN excluded.tillId
                          ELSE payment_terminal_attempts.tillId END,
            -- Remote timestamps are generated by MariaDB and deliberately win
            -- even when a till's local wall clock is far in the future.
            createdAt = excluded.createdAt,
            updatedAt = excluded.updatedAt
         WHERE COALESCE(payment_terminal_attempts.journalScope, 'shared') = 'shared'
           AND payment_terminal_attempts.provider = excluded.provider
           AND payment_terminal_attempts.terminalKey = excluded.terminalKey
           AND payment_terminal_attempts.operationKind = excluded.operationKind
           AND payment_terminal_attempts.amount = excluded.amount
           AND COALESCE(NULLIF(payment_terminal_attempts.expectedProviderAmount, 0), payment_terminal_attempts.amount)
               = COALESCE(NULLIF(excluded.expectedProviderAmount, 0), excluded.amount)
           AND UPPER(payment_terminal_attempts.currency) = UPPER(excluded.currency)
           AND (payment_terminal_attempts.clientTransactionId = '' OR excluded.clientTransactionId = '' OR payment_terminal_attempts.clientTransactionId = excluded.clientTransactionId)
           AND (payment_terminal_attempts.terminalSessionId = '' OR excluded.terminalSessionId = '' OR payment_terminal_attempts.terminalSessionId = excluded.terminalSessionId)
           AND (payment_terminal_attempts.providerReference = '' OR excluded.providerReference = '' OR payment_terminal_attempts.providerReference = excluded.providerReference)`,
        [
            remote.id,
            remote.provider,
            remote.terminalKey,
            remote.clientTransactionId,
            remote.terminalSessionId,
            remote.operationKind,
            remote.amount,
            remote.expectedProviderAmount,
            remote.currency,
            remote.status,
            remote.saleBundle,
            remote.providerReference,
            remote.error,
            remote.tillId,
            remote.createdAt,
            remote.updatedAt,
            remote.operatorResolution || '',
        ],
    );
    if (Number(merged.rowsAffected) !== 1) {
        throw new Error('The local terminal record changed while merging shared evidence. Administrator review is required.');
    }
    const rows = await db.select<any[]>(
        `SELECT * FROM payment_terminal_attempts WHERE id = ? AND provider = ? LIMIT 1`,
        [remote.id, remote.provider],
    );
    if (!rows[0]) throw new Error(`Local ${remote.provider} recovery attempt ${remote.id} is missing after merge`);
    assertMergeIdentity(rows[0]);
    return normalizeAttempt(rows[0]);
}

/**
 * Re-read the journal after acquiring the physical-terminal recovery lease.
 * MariaDB is authoritative for shared state; the monotonic cache merge keeps
 * stronger local provider evidence when a previous remote write was lost.
 */
export async function refreshPaymentTerminalAttempt(
    provider: TerminalProvider,
    id: string,
): Promise<TerminalPaymentAttempt> {
    const db = await getSqliteDb();
    const rows = await db.select<any[]>(
        `SELECT * FROM payment_terminal_attempts WHERE id = ? AND provider = ? LIMIT 1`,
        [id, provider],
    );
    if (!rows[0]) throw new Error(`Local ${provider} recovery attempt ${id} is missing`);
    if (!terminalAttemptUsesSharedJournal(rows[0])) return normalizeAttempt(rows[0]);
    if (!get(connectionState).mysqlOnline) {
        throw new Error('MariaDB must be online to coordinate shared terminal recovery');
    }
    const remote = await mysqlGetPaymentTerminalAttempt(id, provider);
    if (!remote) throw new Error(`Shared ${provider} recovery attempt ${id} is missing`);
    return cacheRemoteAttempt(remote);
}

export async function getRecoverablePaymentTerminalAttempts(
    provider: TerminalProvider,
    options: { includeShared?: boolean } = {},
): Promise<TerminalPaymentAttempt[]> {
    const db = await getSqliteDb();
    let remoteIds = new Set<string>();
    if (options.includeShared !== false && isMultiMode() && get(connectionState).mysqlOnline) {
        const remotes = await mysqlGetOperationalPaymentTerminalAttempts(provider);
        remoteIds = new Set(remotes.map((attempt) => attempt.id));
        for (const remote of remotes) await cacheRemoteAttempt(remote);
    }
    const rows = await db.select<any[]>(
        `SELECT * FROM payment_terminal_attempts
         WHERE provider = ?
           AND (status IN (${OPERATIONAL_STATUS_SQL})
                ${remoteIds.size > 0 ? `OR id IN (${[...remoteIds].map(() => '?').join(', ')})` : ''})
         ORDER BY createdAt ASC`,
        [provider, ...remoteIds],
    );
    return rows.map((row) => normalizeAttempt(row));
}

export async function prunePaymentTerminalAttempts(provider?: TerminalProvider, options: { includeShared?: boolean } = {}): Promise<void> {
    const db = await getSqliteDb();
    await db.execute(
        `DELETE FROM payment_terminal_attempts
         WHERE status IN ('completed', 'failed', 'cancelled')
           ${provider ? 'AND provider = ?' : ''}
           AND julianday(updatedAt) < julianday('now', '-30 days')`,
        provider ? [provider] : [],
    );
    if (options.includeShared !== false && isMultiMode() && get(connectionState).mysqlOnline) {
        await mysqlPrunePaymentTerminalAttempts();
    }
}
