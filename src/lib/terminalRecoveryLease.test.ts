import { describe, expect, it, vi } from 'vitest';
import {
    runWithTerminalRecoveryLease,
    type TerminalRecoveryLeaseBackend,
} from './terminalRecoveryLease';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

describe('shared terminal recovery lease', () => {
    it('allows only one worker to observe and publish a provider result', async () => {
        let owner = '';
        const backend = (worker: string): TerminalRecoveryLeaseBackend => ({
            acquire: async () => {
                if (owner) return false;
                owner = worker;
                return true;
            },
            refresh: async () => owner === worker,
            release: async () => {
                if (owner === worker) owner = '';
            },
        });
        const enteredProviderRead = deferred();
        const finishProviderRead = deferred();
        const events: string[] = [];

        const first = runWithTerminalRecoveryLease(backend('worker-a'), async (assertHeld) => {
            events.push('worker-a-provider-read');
            enteredProviderRead.resolve();
            await finishProviderRead.promise;
            await assertHeld();
            events.push('worker-a-published-final');
            return 'final';
        });
        await enteredProviderRead.promise;
        const second = await runWithTerminalRecoveryLease(backend('worker-b'), async () => {
            events.push('worker-b-provider-read');
            return 'approved';
        });

        expect(second.acquired).toBe(false);
        expect(events).toEqual(['worker-a-provider-read']);
        finishProviderRead.resolve();
        await expect(first).resolves.toEqual({ acquired: true, value: 'final' });
        expect(events).toEqual(['worker-a-provider-read', 'worker-a-published-final']);
        expect(owner).toBe('');
    });

    it('refuses to publish an observation after lease ownership is lost', async () => {
        const release = vi.fn(async () => undefined);
        const events: string[] = [];
        const run = runWithTerminalRecoveryLease(
            {
                acquire: async () => true,
                refresh: async () => false,
                release,
            },
            async (assertHeld) => {
                events.push('provider-read');
                await assertHeld();
                events.push('published');
            },
        );

        await expect(run).rejects.toThrow('lease was lost');
        expect(events).toEqual(['provider-read']);
        expect(release).toHaveBeenCalledOnce();
    });
});
