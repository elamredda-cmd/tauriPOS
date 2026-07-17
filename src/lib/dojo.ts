import { invoke, isTauri } from '@tauri-apps/api/core';
import { get, writable } from 'svelte/store';
import type { SaleBundle } from '$lib/stores/database';
import { connectionState } from '$lib/stores/connection';
import {
    mysqlAcquirePaymentTerminalLock,
    mysqlRefreshPaymentTerminalLock,
    mysqlReleasePaymentTerminalLock,
    type MysqlPaymentTerminalLock,
} from '$lib/stores/mysql';
import { getDb as getSqliteDb } from '$lib/stores/sqlite';

export interface DojoConfig {
    enabled: boolean;
    terminalId: string;
    terminalName: string;
    currency: string;
    softwareHouseId: string;
    resellerId: string;
    apiKeyConfigured: boolean;
    apiEnvironment: string;
    apiVersion: string;
    ready: boolean;
}

export interface DojoConfigInput {
    enabled: boolean;
    terminalId: string;
    terminalName: string;
    currency: string;
    softwareHouseId: string;
    resellerId: string;
    apiKey?: string;
}

export interface DojoTerminal {
    id: string;
    properties: { tid?: string };
    status: 'Available' | 'Offline' | 'InUse' | string;
    updatedAt: string;
}

export interface DojoPaymentResult {
    paymentIntentId: string;
    terminalSessionId: string;
    reference: string;
}

export interface DojoPaymentIntentStatus {
    id: string;
    status: string;
    reference: string;
    amount?: number;
    currency?: string;
    refundedAmount?: number;
    transactionId?: string;
}

export interface DojoTerminalSessionStatus {
    id: string;
    terminalId: string;
    paymentIntentId: string;
    status: string;
    latestNotification?: string;
    payment?: DojoPaymentIntentStatus;
}

export interface DojoRefundResult {
    refundId: string;
    paymentIntentId: string;
}

export interface DojoPaymentAttempt {
    id: string;
    provider: 'dojo';
    terminalKey: string;
    clientTransactionId: string;
    amount: number;
    currency: string;
    status: 'prepared' | 'started' | 'approved' | 'commit_failed' | 'completed' | 'failed' | 'cancelled';
    saleBundle: SaleBundle;
    error: string;
    createdAt: string;
    updatedAt: string;
}

export interface DojoLockResult {
    acquired: boolean;
    lock: MysqlPaymentTerminalLock | null;
}

export const defaultDojoConfig: DojoConfig = {
    enabled: false,
    terminalId: '',
    terminalName: '',
    currency: 'GBP',
    softwareHouseId: 'softwareHouse1',
    resellerId: 'reseller1',
    apiKeyConfigured: false,
    apiEnvironment: 'Unknown',
    apiVersion: '2026-02-27',
    ready: false,
};

export const dojoConfig = writable<DojoConfig>(defaultDojoConfig);

export async function loadDojoConfig(): Promise<DojoConfig> {
    if (!isTauri()) return defaultDojoConfig;
    const config = await invoke<DojoConfig>('dojo_get_config');
    dojoConfig.set(config);
    return config;
}

export async function saveDojoConfig(config: DojoConfigInput): Promise<DojoConfig> {
    const saved = await invoke<DojoConfig>('dojo_save_config', { config });
    dojoConfig.set(saved);
    return saved;
}

export async function clearDojoSecret(): Promise<DojoConfig> {
    const saved = await invoke<DojoConfig>('dojo_clear_secret');
    dojoConfig.set(saved);
    return saved;
}

export function listDojoTerminals(): Promise<DojoTerminal[]> {
    return invoke<DojoTerminal[]>('dojo_list_terminals');
}

export function getDojoTerminalStatus(): Promise<DojoTerminal> {
    return invoke<DojoTerminal>('dojo_terminal_status');
}

export function createDojoPayment(
    amountPence: number,
    reference: string,
    description: string,
): Promise<DojoPaymentResult> {
    return invoke<DojoPaymentResult>('dojo_create_payment', { amountPence, reference, description });
}

export function getDojoTerminalSessionStatus(terminalSessionId: string): Promise<DojoTerminalSessionStatus> {
    return invoke<DojoTerminalSessionStatus>('dojo_terminal_session_status', { terminalSessionId });
}

export function getDojoPaymentIntentStatus(paymentIntentId: string): Promise<DojoPaymentIntentStatus> {
    return invoke<DojoPaymentIntentStatus>('dojo_payment_intent_status', { paymentIntentId });
}

export function cancelDojoTerminalSession(terminalSessionId: string): Promise<void> {
    return invoke<void>('dojo_cancel_terminal_session', { terminalSessionId });
}

export function respondToDojoSignature(terminalSessionId: string, accepted: boolean): Promise<void> {
    return invoke<void>('dojo_respond_signature', { terminalSessionId, accepted });
}

export function refundDojoPaymentIntent(
    paymentIntentId: string,
    amountPence: number,
    idempotencyKey: string,
): Promise<DojoRefundResult> {
    return invoke<DojoRefundResult>('dojo_refund_payment_intent', {
        paymentIntentId,
        amountPence,
        idempotencyKey,
    });
}

export function dojoTerminalKey(config: DojoConfig): string {
    return `dojo:${config.softwareHouseId}:${config.terminalId}`;
}

export async function acquireDojoLock(
    config: DojoConfig,
    tillId: string,
    tillName: string,
    paymentReference: string,
): Promise<DojoLockResult> {
    const connection = get(connectionState);
    if (connection.mode !== 'multi' || !connection.mysqlOnline) {
        throw new Error('The shared Dojo terminal requires MariaDB to be online so the tills cannot charge it together');
    }
    return mysqlAcquirePaymentTerminalLock(
        dojoTerminalKey(config),
        tillId,
        tillName,
        paymentReference,
    );
}

export function refreshDojoLock(
    config: DojoConfig,
    tillId: string,
    paymentReference: string,
): Promise<boolean> {
    return mysqlRefreshPaymentTerminalLock(dojoTerminalKey(config), tillId, paymentReference);
}

export function releaseDojoLock(
    config: DojoConfig,
    tillId: string,
    paymentReference: string,
): Promise<void> {
    return mysqlReleasePaymentTerminalLock(dojoTerminalKey(config), tillId, paymentReference);
}

export async function saveDojoAttempt(attempt: DojoPaymentAttempt): Promise<void> {
    const db = await getSqliteDb();
    await db.execute(
        `INSERT INTO payment_terminal_attempts
            (id, provider, terminalKey, clientTransactionId, amount, currency, status, saleBundle, error, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
            terminalKey = excluded.terminalKey,
            clientTransactionId = excluded.clientTransactionId,
            amount = excluded.amount,
            currency = excluded.currency,
            status = excluded.status,
            saleBundle = excluded.saleBundle,
            error = excluded.error,
            updatedAt = excluded.updatedAt`,
        [
            attempt.id,
            attempt.provider,
            attempt.terminalKey,
            attempt.clientTransactionId,
            attempt.amount,
            attempt.currency,
            attempt.status,
            JSON.stringify(attempt.saleBundle),
            attempt.error,
            attempt.createdAt,
            attempt.updatedAt,
        ],
    );
}

export async function updateDojoAttempt(
    id: string,
    status: DojoPaymentAttempt['status'],
    values: { clientTransactionId?: string; error?: string; saleBundle?: SaleBundle } = {},
): Promise<void> {
    const db = await getSqliteDb();
    const updates = ['status = ?', 'updatedAt = ?'];
    const parameters: unknown[] = [status, new Date().toISOString()];
    if (values.clientTransactionId !== undefined) {
        updates.push('clientTransactionId = ?');
        parameters.push(values.clientTransactionId);
    }
    if (values.error !== undefined) {
        updates.push('error = ?');
        parameters.push(values.error);
    }
    if (values.saleBundle !== undefined) {
        updates.push('saleBundle = ?');
        parameters.push(JSON.stringify(values.saleBundle));
    }
    parameters.push(id);
    await db.execute(`UPDATE payment_terminal_attempts SET ${updates.join(', ')} WHERE id = ?`, parameters);
}

export async function getRecoverableDojoAttempts(): Promise<DojoPaymentAttempt[]> {
    const db = await getSqliteDb();
    const rows = await db.select<any[]>(
        `SELECT * FROM payment_terminal_attempts
         WHERE provider = 'dojo' AND status IN ('approved', 'commit_failed')
         ORDER BY createdAt ASC`,
    );
    return rows.flatMap((row) => {
        try {
            return [{
                ...row,
                amount: Number(row.amount || 0),
                saleBundle: JSON.parse(row.saleBundle),
            } as DojoPaymentAttempt];
        } catch {
            return [];
        }
    });
}

export async function pruneDojoAttempts(): Promise<void> {
    const db = await getSqliteDb();
    await db.execute(
        `DELETE FROM payment_terminal_attempts
         WHERE provider = 'dojo'
           AND status IN ('completed', 'failed', 'cancelled')
           AND julianday(updatedAt) < julianday('now', '-30 days')`,
    );
}
