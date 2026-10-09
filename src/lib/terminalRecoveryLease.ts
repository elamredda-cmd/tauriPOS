export interface TerminalRecoveryLeaseBackend {
    acquire(): Promise<boolean>;
    refresh(): Promise<boolean>;
    release(): Promise<void>;
}

export type AssertTerminalRecoveryLease = () => Promise<void>;

export interface TerminalRecoveryLeaseResult<T> {
    acquired: boolean;
    value?: T;
}

/**
 * Run one provider reconciliation while holding the same physical-terminal
 * lease used by live payments. A worker that loses the lease must stop before
 * publishing its provider observation.
 */
export async function runWithTerminalRecoveryLease<T>(
    backend: TerminalRecoveryLeaseBackend,
    work: (assertHeld: AssertTerminalRecoveryLease) => Promise<T>,
): Promise<TerminalRecoveryLeaseResult<T>> {
    if (!await backend.acquire()) return { acquired: false };
    const assertHeld: AssertTerminalRecoveryLease = async () => {
        if (!await backend.refresh()) {
            throw new Error('The terminal recovery lease was lost; the provider result was not published');
        }
    };
    try {
        return { acquired: true, value: await work(assertHeld) };
    } finally {
        // A failed release is fail-safe: the server lease remains until expiry,
        // preventing a new charge while this worker is disappearing.
        await backend.release().catch(() => undefined);
    }
}
import { invoke } from '@tauri-apps/api/core';
import {
    mysqlAcquirePaymentTerminalLock,
    mysqlRefreshPaymentTerminalLock,
    mysqlReleasePaymentTerminalLock,
    type MysqlPaymentTerminalLock,
} from '$lib/stores/mysql';

export type TerminalJournalScope = 'local' | 'shared';
export type TerminalOwnership = 'dedicated' | 'shared';
export type TerminalLock = Omit<MysqlPaymentTerminalLock, 'acquiredAt'> & {
    acquiredAt?: string;
    updatedAt?: string;
};
export interface TerminalLockResult { acquired: boolean; lock: TerminalLock | null }

/** Scope is persisted with each attempt; a database outage never changes it. */
export function acquireTerminalLock(
    scope: TerminalJournalScope, terminalKey: string, tillId: string,
    tillName: string, paymentReference: string, leaseSeconds = 180,
): Promise<TerminalLockResult> {
    return scope === 'local'
        ? invoke('terminal_acquire_local_lock', { terminalKey, tillId, tillName, paymentReference, leaseSeconds })
        : mysqlAcquirePaymentTerminalLock(terminalKey, tillId, tillName, paymentReference, leaseSeconds);
}

export function refreshTerminalLock(
    scope: TerminalJournalScope, terminalKey: string, tillId: string,
    paymentReference: string, leaseSeconds = 180,
): Promise<boolean> {
    return scope === 'local'
        ? invoke('terminal_refresh_local_lock', { terminalKey, tillId, paymentReference, leaseSeconds })
        : mysqlRefreshPaymentTerminalLock(terminalKey, tillId, paymentReference, leaseSeconds);
}

export function releaseTerminalLock(
    scope: TerminalJournalScope, terminalKey: string, tillId: string, paymentReference: string,
): Promise<void> {
    return scope === 'local'
        ? invoke('terminal_release_local_lock', { terminalKey, tillId, paymentReference })
        : mysqlReleasePaymentTerminalLock(terminalKey, tillId, paymentReference);
}
