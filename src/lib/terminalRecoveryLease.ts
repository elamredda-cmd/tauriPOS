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
