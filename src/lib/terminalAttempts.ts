import { get } from 'svelte/store';
import type { SaleBundle } from '$lib/stores/database';
import {
    assertMariaDbCommerceWritesAllowed,
    withCurrentReportEpoch,
} from '$lib/stores/database';
import { connectionState } from '$lib/stores/connection';
import {
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
    terminalAttemptUpdatePredecessors,
    type TerminalAttemptState,
} from '$lib/terminalAttemptState';

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
}

export type TerminalAttemptPayload = SaleBundle | CustomerAccountPaymentAttemptPayload;

export interface TerminalPaymentAttempt {
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
             saleBundle, providerReference, error, tillId, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    let remotePrepared = false;
    let localAttempt: TerminalPaymentAttempt = attempt;
    if (isMultiMode()) {
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
        const prepared = await mysqlPreparePaymentTerminalAttempt(serializeAttempt(durableAttempt));
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
        `SELECT id, terminalKey, amount, status FROM payment_terminal_attempts
         WHERE id = ? AND provider = ? LIMIT 1`,
        [id, provider],
    );
    const local = rows[0];
    if (!local || !['prepared', 'started'].includes(String(local.status || ''))) {
        throw new Error(`The ${provider} request is not in a safe prepared state`);
    }
    if (!isMultiMode()) return;
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
    const remoteValues: MysqlPaymentTerminalAttemptUpdate = {
        ...(values.clientTransactionId !== undefined ? { clientTransactionId: values.clientTransactionId } : {}),
        ...(values.terminalSessionId !== undefined ? { terminalSessionId: values.terminalSessionId } : {}),
        ...(values.providerReference !== undefined ? { providerReference: values.providerReference } : {}),
        ...(values.error !== undefined ? { error: values.error } : {}),
        ...(values.saleBundle !== undefined ? { saleBundle: JSON.stringify(values.saleBundle) } : {}),
    };
    if (status === 'completed' && isMultiMode()) {
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
                return pending.attempt;
            }
            return (await updateLocalAttempt(provider, id, 'completed', values)).attempt;
        } catch (error) {
            return (await updateLocalAttempt(provider, id, 'completion_pending', {
                ...values,
                error: `Ledger committed; shared completion is pending: ${String(error)}`,
            })).attempt;
        }
    }

    const local = await updateLocalAttempt(provider, id, status, values);
    if (!isMultiMode()) return local.attempt;
    const remote = await mysqlUpdatePaymentTerminalAttempt(
        id,
        provider,
        status,
        remoteValues,
    );
    return cacheRemoteAttempt(remote.attempt);
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
    const currentStrength = sqliteTerminalAttemptStrength('payment_terminal_attempts.status');
    const remoteStrength = sqliteTerminalAttemptStrength('excluded.status');
    const preferRemote = `${remoteStrength} > ${currentStrength}`;
    await db.execute(
        `INSERT INTO payment_terminal_attempts
            (id, provider, terminalKey, clientTransactionId, terminalSessionId,
             operationKind, amount, expectedProviderAmount, currency, status,
             saleBundle, providerReference, error, tillId, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            tillId = CASE WHEN payment_terminal_attempts.tillId = '' THEN excluded.tillId
                          ELSE payment_terminal_attempts.tillId END,
            -- Remote timestamps are generated by MariaDB and deliberately win
            -- even when a till's local wall clock is far in the future.
            createdAt = excluded.createdAt,
            updatedAt = excluded.updatedAt`,
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
        ],
    );
    const rows = await db.select<any[]>(
        `SELECT * FROM payment_terminal_attempts WHERE id = ? AND provider = ? LIMIT 1`,
        [remote.id, remote.provider],
    );
    if (!rows[0]) throw new Error(`Local ${remote.provider} recovery attempt ${remote.id} is missing after merge`);
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
    if (!isMultiMode()) return normalizeAttempt(rows[0]);
    if (!get(connectionState).mysqlOnline) {
        throw new Error('MariaDB must be online to coordinate shared terminal recovery');
    }
    const remote = await mysqlGetPaymentTerminalAttempt(id, provider);
    if (!remote) throw new Error(`Shared ${provider} recovery attempt ${id} is missing`);
    return cacheRemoteAttempt(remote);
}

export async function getRecoverablePaymentTerminalAttempts(
    provider: TerminalProvider,
): Promise<TerminalPaymentAttempt[]> {
    const db = await getSqliteDb();
    let remoteIds = new Set<string>();
    if (isMultiMode() && get(connectionState).mysqlOnline) {
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

export async function prunePaymentTerminalAttempts(provider?: TerminalProvider): Promise<void> {
    const db = await getSqliteDb();
    await db.execute(
        `DELETE FROM payment_terminal_attempts
         WHERE status IN ('completed', 'failed', 'cancelled')
           ${provider ? 'AND provider = ?' : ''}
           AND julianday(updatedAt) < julianday('now', '-30 days')`,
        provider ? [provider] : [],
    );
    if (isMultiMode() && get(connectionState).mysqlOnline) {
        await mysqlPrunePaymentTerminalAttempts();
    }
}
