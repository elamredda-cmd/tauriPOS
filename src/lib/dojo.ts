import { invoke, isTauri } from '@tauri-apps/api/core';
import { get, writable } from 'svelte/store';
import { connectionState, buildMysqlUri } from '$lib/stores/connection';
import { acquireTerminalLock, refreshTerminalLock, releaseTerminalLock,
    type TerminalOwnership, type TerminalLockResult } from '$lib/terminalRecoveryLease';
import {
    getRecoverablePaymentTerminalAttempts,
    assertPaymentTerminalAttemptReady,
    preparePaymentTerminalAttempt,
    prunePaymentTerminalAttempts,
    updatePaymentTerminalAttempt,
    type TerminalAttemptUpdate,
    type TerminalPaymentAttempt,
} from '$lib/terminalAttempts';

export interface DojoConfig {
    terminalOwnership?: TerminalOwnership;
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
    terminalOwnership?: TerminalOwnership;
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

export interface DojoMoney {
    value: number;
    currencyCode: string;
}

export interface DojoPaymentIntentStatus {
    id: string;
    status: string;
    reference: string;
    amount?: number;
    currency?: string;
    totalAmount?: DojoMoney | null;
    tipsAmount?: DojoMoney | null;
    cashbackAmount?: DojoMoney | null;
    serviceChargeAmount?: DojoMoney | null;
    moneyValidationError?: string | null;
    refundedAmount?: number;
    transactionId?: string;
    latestTerminalSessionId?: string | null;
    terminalHistoryError?: string | null;
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
    rejected?: boolean;
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

export type DojoLockResult = TerminalLockResult;

export const defaultDojoConfig: DojoConfig = {
    terminalOwnership: 'dedicated',
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
    const state = get(connectionState);
    const saved = await invoke<DojoConfig>('dojo_save_config', {
        config, mysqlUri: state.mysqlConfig && state.mysqlOnline ? buildMysqlUri(state.mysqlConfig) : null,
    });
    dojoConfig.set(saved);
    return saved;
}

export async function clearDojoSecret(): Promise<DojoConfig> {
    const state = get(connectionState);
    const saved = await invoke<DojoConfig>('dojo_clear_secret', {
        mysqlUri: state.mysqlConfig && state.mysqlOnline ? buildMysqlUri(state.mysqlConfig) : null,
    });
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

export async function retryDojoPayment(attemptId: string, terminalSessionId: string): Promise<DojoPaymentResult> {
    // Persist the retry boundary before sending it. Recovery must never use
    // the earlier decline to release a payment whose new session is unknown.
    await updateDojoAttempt(attemptId, 'started', { error: `DOJO_RETRY_PENDING:${terminalSessionId}` });
    await assertPaymentTerminalAttemptReady('dojo', attemptId);
    try {
        return await invoke<DojoPaymentResult>('dojo_retry_payment', { attemptId, terminalSessionId });
    } catch (error) {
        throw new Error(`DOJO_RETRY_PENDING:${terminalSessionId} ${String(error)}`);
    }
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

/** Native sandbox guard + journal/provider proof. Hold the matching terminal lease throughout. */
export function cancelExpiredSandboxDojoPaymentIntent(attemptId: string): Promise<void> {
    return invoke<void>('dojo_cancel_expired_sandbox_payment', { attemptId });
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
    const scope = config.terminalOwnership === 'dedicated' ? 'local' : 'shared';
    if (scope === 'shared' && (connection.mode !== 'multi' || !connection.mysqlOnline)) {
        throw new Error('The shared Dojo terminal requires MariaDB to be online so the tills cannot charge it together');
    }
    return acquireTerminalLock(scope,
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
    return refreshTerminalLock(config.terminalOwnership === 'dedicated' ? 'local' : 'shared', dojoTerminalKey(config), tillId, paymentReference);
}

export function releaseDojoLock(
    config: DojoConfig,
    tillId: string,
    paymentReference: string,
): Promise<void> {
    return releaseTerminalLock(config.terminalOwnership === 'dedicated' ? 'local' : 'shared', dojoTerminalKey(config), tillId, paymentReference);
}

export async function saveDojoAttempt(attempt: DojoPaymentAttempt): Promise<DojoPaymentAttempt> {
    return preparePaymentTerminalAttempt({ ...attempt,
        journalScope: attempt.journalScope ?? (get(dojoConfig).terminalOwnership === 'dedicated' ? 'local' : 'shared') });
}

export async function updateDojoAttempt(
    id: string,
    status: DojoPaymentAttempt['status'],
    values: TerminalAttemptUpdate = {},
): Promise<void> {
    await updatePaymentTerminalAttempt('dojo', id, status, values);
}

export async function getRecoverableDojoAttempts(): Promise<DojoPaymentAttempt[]> {
    return getRecoverablePaymentTerminalAttempts('dojo', {
        includeShared: get(dojoConfig).terminalOwnership !== 'dedicated',
    }) as Promise<DojoPaymentAttempt[]>;
}

export async function pruneDojoAttempts(): Promise<void> {
    await prunePaymentTerminalAttempts('dojo', { includeShared: get(dojoConfig).terminalOwnership !== 'dedicated' });
}
