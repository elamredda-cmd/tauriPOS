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

export interface SumupConfig {
    enabled: boolean;
    merchantCode: string;
    readerId: string;
    readerName: string;
    currency: string;
    affiliateAppId: string;
    apiKeyConfigured: boolean;
    affiliateKeyConfigured: boolean;
    ready: boolean;
}

export interface SumupConfigInput {
    enabled: boolean;
    merchantCode: string;
    readerId: string;
    readerName: string;
    currency: string;
    affiliateAppId: string;
    apiKey?: string;
    affiliateKey?: string;
}

export interface SumupReader {
    id: string;
    name: string;
    status: string;
    device?: { identifier?: string; model?: string };
}

export interface SumupReaderStatus {
    status: string;
    state: string;
    batteryLevel?: number;
    connectionType?: string;
    firmwareVersion?: string;
    lastActivity?: string;
}

export interface SumupCheckoutResult {
    clientTransactionId: string;
    foreignTransactionId: string;
}

export interface SumupTransactionStatus {
    status: string;
    simpleStatus: string;
    transactionId?: string;
    transactionCode?: string;
    clientTransactionId: string;
    foreignTransactionId?: string;
    amount?: number;
    currency?: string;
    refundedAmount?: number;
}

export interface SumupPaymentAttempt {
    id: string;
    provider: 'sumup';
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

export interface SumupLockResult {
    acquired: boolean;
    lock: MysqlPaymentTerminalLock | null;
}

export const defaultSumupConfig: SumupConfig = {
    enabled: false,
    merchantCode: '',
    readerId: '',
    readerName: '',
    currency: 'GBP',
    affiliateAppId: '',
    apiKeyConfigured: false,
    affiliateKeyConfigured: false,
    ready: false,
};

export const sumupConfig = writable<SumupConfig>(defaultSumupConfig);

export async function loadSumupConfig(): Promise<SumupConfig> {
    if (!isTauri()) return defaultSumupConfig;
    const config = await invoke<SumupConfig>('sumup_get_config');
    sumupConfig.set(config);
    return config;
}

export async function saveSumupConfig(config: SumupConfigInput): Promise<SumupConfig> {
    const saved = await invoke<SumupConfig>('sumup_save_config', { config });
    sumupConfig.set(saved);
    return saved;
}

export async function clearSumupSecrets(): Promise<SumupConfig> {
    const saved = await invoke<SumupConfig>('sumup_clear_secrets');
    sumupConfig.set(saved);
    return saved;
}

export function listSumupReaders(): Promise<SumupReader[]> {
    return invoke<SumupReader[]>('sumup_list_readers');
}

export function pairSumupReader(pairingCode: string, readerName: string): Promise<SumupReader> {
    return invoke<SumupReader>('sumup_pair_reader', { pairingCode, readerName });
}

export function getSumupReaderStatus(): Promise<SumupReaderStatus> {
    return invoke<SumupReaderStatus>('sumup_reader_status');
}

export function createSumupCheckout(
    amountPence: number,
    foreignTransactionId: string,
    description: string,
): Promise<SumupCheckoutResult> {
    return invoke<SumupCheckoutResult>('sumup_create_checkout', {
        amountPence,
        foreignTransactionId,
        description,
    });
}

export function getSumupTransactionStatus(clientTransactionId: string): Promise<SumupTransactionStatus> {
    return invoke<SumupTransactionStatus>('sumup_transaction_status', { clientTransactionId });
}

export function getSumupTransactionByReference(foreignTransactionId: string): Promise<SumupTransactionStatus> {
    return invoke<SumupTransactionStatus>('sumup_transaction_by_reference', { foreignTransactionId });
}

export function refundSumupTransaction(transactionId: string, amountPence: number): Promise<void> {
    return invoke<void>('sumup_refund_transaction', { transactionId, amountPence });
}

export function terminateSumupCheckout(): Promise<void> {
    return invoke<void>('sumup_terminate_checkout');
}

export function sumupTerminalKey(config: SumupConfig): string {
    return `sumup:${config.merchantCode}:${config.readerId}`;
}

export async function acquireSumupLock(
    config: SumupConfig,
    tillId: string,
    tillName: string,
    paymentReference: string,
): Promise<SumupLockResult> {
    const connection = get(connectionState);
    if (connection.mode !== 'multi' || !connection.mysqlOnline) {
        throw new Error('The shared SumUp reader requires MariaDB to be online so the tills cannot charge it together');
    }
    return mysqlAcquirePaymentTerminalLock(
        sumupTerminalKey(config),
        tillId,
        tillName,
        paymentReference,
    );
}

export function refreshSumupLock(
    config: SumupConfig,
    tillId: string,
    paymentReference: string,
): Promise<boolean> {
    return mysqlRefreshPaymentTerminalLock(sumupTerminalKey(config), tillId, paymentReference);
}

export function releaseSumupLock(
    config: SumupConfig,
    tillId: string,
    paymentReference: string,
): Promise<void> {
    return mysqlReleasePaymentTerminalLock(sumupTerminalKey(config), tillId, paymentReference);
}

export async function saveSumupAttempt(attempt: SumupPaymentAttempt): Promise<void> {
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

export async function updateSumupAttempt(
    id: string,
    status: SumupPaymentAttempt['status'],
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

export async function getRecoverableSumupAttempts(): Promise<SumupPaymentAttempt[]> {
    const db = await getSqliteDb();
    const rows = await db.select<any[]>(
        `SELECT * FROM payment_terminal_attempts
         WHERE provider = 'sumup' AND status IN ('approved', 'commit_failed')
         ORDER BY createdAt ASC`,
    );
    return rows.flatMap((row) => {
        try {
            return [{
                ...row,
                amount: Number(row.amount || 0),
                saleBundle: JSON.parse(row.saleBundle),
            } as SumupPaymentAttempt];
        } catch {
            return [];
        }
    });
}

export async function localOrderExists(orderId: string): Promise<boolean> {
    const db = await getSqliteDb();
    const rows = await db.select<{ id: string }[]>('SELECT id FROM orders WHERE id = ? LIMIT 1', [orderId]);
    return rows.length > 0;
}

export async function pruneSumupAttempts(): Promise<void> {
    const db = await getSqliteDb();
    await db.execute(
        `DELETE FROM payment_terminal_attempts
         WHERE status IN ('completed', 'failed', 'cancelled')
           AND julianday(updatedAt) < julianday('now', '-30 days')`,
    );
}

export function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
