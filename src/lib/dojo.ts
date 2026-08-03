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

export interface DojoRecoveredPayment {
    payment: DojoPaymentIntentStatus;
    terminalSessionId?: string | null;
    terminalSessionStatus?: string | null;
}

export type DojoPaymentAttempt = TerminalPaymentAttempt & {
    provider: 'dojo';
};

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

export function findDojoPaymentIntentByReference(
    reference: string,
    createdAt: string,
): Promise<DojoRecoveredPayment | null> {
    return invoke<DojoRecoveredPayment | null>('dojo_payment_intent_by_reference', { reference, createdAt });
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

export async function saveDojoAttempt(attempt: DojoPaymentAttempt): Promise<DojoPaymentAttempt> {
    return preparePaymentTerminalAttempt(attempt);
}

export async function updateDojoAttempt(
    id: string,
    status: DojoPaymentAttempt['status'],
    values: TerminalAttemptUpdate = {},
): Promise<void> {
    await updatePaymentTerminalAttempt('dojo', id, status, values);
}

export async function getRecoverableDojoAttempts(): Promise<DojoPaymentAttempt[]> {
    return getRecoverablePaymentTerminalAttempts('dojo') as Promise<DojoPaymentAttempt[]>;
}

export async function pruneDojoAttempts(): Promise<void> {
    await prunePaymentTerminalAttempts('dojo');
}
