export interface DojoSandboxRecoveryResult {
    resolved: number;
    remaining: number;
    switchedToDedicated: boolean;
    issues: string[];
    waitingForConfirmation: boolean;
}

export interface SandboxRecoveryOptions {
    recover: () => Promise<DojoSandboxRecoveryResult>;
    canContinue: () => boolean;
    signal: AbortSignal;
    onWaiting: () => void;
    wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

function waitForConfirmation(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) { reject(new Error('Sandbox recovery was stopped.')); return; }
        const stop = () => {
            clearTimeout(timer);
            reject(new Error('Sandbox recovery was stopped.'));
        };
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', stop);
            resolve();
        }, milliseconds);
        signal.addEventListener('abort', stop, { once: true });
    });
}

/** Final status is decided by the native provider checks, never this timer. */
export async function recoverSandboxWithConfirmation(options: SandboxRecoveryOptions): Promise<DojoSandboxRecoveryResult> {
    let resolved = 0;
    const assertCanContinue = () => {
        if (options.signal.aborted || !options.canContinue()) {
            throw new Error('The staff session changed or this page closed. Reopen sandbox recovery to continue.');
        }
    };
    for (let check = 0; check < 3; check += 1) {
        assertCanContinue();
        const result = await options.recover();
        // An in-flight native check can finish after navigation or logout.
        // Its durable result remains saved, but this view must not use it.
        assertCanContinue();
        resolved += result.resolved;
        if (!result.waitingForConfirmation || check === 2) return { ...result, resolved };
        options.onWaiting();
        await (options.wait ?? waitForConfirmation)(31_000, options.signal);
    }
    throw new Error('Sandbox recovery needs another check.');
}
