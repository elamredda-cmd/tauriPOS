import { invoke, isTauri } from '@tauri-apps/api/core';
import { get, writable } from 'svelte/store';
import { connectionState } from '$lib/stores/connection';
import {
    mysqlAcquirePaymentTerminalLock,
    mysqlRefreshPaymentTerminalLock,
    mysqlReleasePaymentTerminalLock,
    type MysqlPaymentTerminalLock,
} from '$lib/stores/mysql';
import {
    getRecoverablePaymentTerminalAttempts,
    preparePaymentTerminalAttempt,
    prunePaymentTerminalAttempts,
    updatePaymentTerminalAttempt,
    type TerminalAttemptUpdate,
    type TerminalPaymentAttempt,
} from '$lib/terminalAttempts';

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

export type SumupPaymentAttempt = TerminalPaymentAttempt & {
    provider: 'sumup';
};

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

export async function saveSumupAttempt(attempt: SumupPaymentAttempt): Promise<SumupPaymentAttempt> {
    return preparePaymentTerminalAttempt(attempt);
}

export async function updateSumupAttempt(
    id: string,
    status: SumupPaymentAttempt['status'],
    values: TerminalAttemptUpdate = {},
): Promise<void> {
    await updatePaymentTerminalAttempt('sumup', id, status, values);
}

export async function getRecoverableSumupAttempts(): Promise<SumupPaymentAttempt[]> {
    return getRecoverablePaymentTerminalAttempts('sumup') as Promise<SumupPaymentAttempt[]>;
}

export async function pruneSumupAttempts(): Promise<void> {
    await prunePaymentTerminalAttempts('sumup');
}

export function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
