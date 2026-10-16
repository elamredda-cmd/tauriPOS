import { writable } from 'svelte/store';

export type TerminalConfigReadState = 'loading' | 'loaded' | 'error';

/** Keep a failed/default configuration distinguishable from an explicitly disabled terminal. */
export function createTerminalConfigStore<T>(initial: T) {
    const config = writable(initial);
    const readState = writable<TerminalConfigReadState>('loading');
    let queue: Promise<void> = Promise.resolve();
    let pending = 0;
    let revision = 0;
    let pendingRead: { revision: number; promise: Promise<T> } | null = null;

    function schedule(operation: () => Promise<T>): Promise<T> {
        pending += 1;
        readState.set('loading');
        const result = queue.then(async () => {
            let outcome: TerminalConfigReadState = 'error';
            try {
                const value = await operation();
                config.set(value);
                outcome = 'loaded';
                return value;
            } finally {
                pending -= 1;
                // A queued save/read must finish before checkout trusts either
                // the old configuration or a briefly successful intermediate read.
                readState.set(pending ? 'loading' : outcome);
            }
        });
        queue = result.then(() => undefined, () => undefined);
        return result;
    }

    function read(operation: () => Promise<T>): Promise<T> {
        if (pendingRead?.revision === revision) return pendingRead.promise;
        const promise = schedule(operation);
        const current = { revision, promise };
        pendingRead = current;
        const clear = () => { if (pendingRead === current) pendingRead = null; };
        void promise.then(clear, clear);
        return promise;
    }

    function write(operation: () => Promise<T>): Promise<T> {
        // Reads requested after a save/clear must not join a pre-save read.
        revision += 1;
        return schedule(operation);
    }

    return { config, readState, read, write };
}
