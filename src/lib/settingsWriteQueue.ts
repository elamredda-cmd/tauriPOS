/** Serialize saved settings so an older completion can never undo a newer one. */
export function createSettingsWriteQueue() {
    const pending = new Map<string, Promise<unknown>>();
    return function run<T>(key: string, operation: () => Promise<T>): Promise<T> {
        const before = pending.get(key) ?? Promise.resolve();
        const next = before.catch(() => undefined).then(operation);
        pending.set(key, next);
        void next.finally(() => {
            if (pending.get(key) === next) pending.delete(key);
        }).catch(() => undefined);
        return next;
    };
}

/** Validate/enable the new provider before touching the working provider. */
export async function switchCardProvider<T>(options: {
    enableTarget: () => Promise<T>;
    disablePrevious: () => Promise<unknown>;
    getPreviousEnabled: () => Promise<boolean>;
    restoreTarget: () => Promise<unknown>;
}): Promise<T> {
    let target: T;
    try {
        target = await options.enableTarget();
    } catch (error) {
        throw new Error(`The new provider save was not confirmed. The previous provider was not changed. Reload both provider settings before taking a card payment. ${String(error)}`);
    }
    try {
        await options.disablePrevious();
        return target;
    } catch (error) {
        // A native file replacement may succeed before its final fsync rejects.
        // Do not disable the target until we have proved the old provider is on.
        let previousEnabled: boolean;
        try {
            previousEnabled = await options.getPreviousEnabled();
        } catch {
            throw new Error('The previous provider state could not be confirmed. The new provider remains enabled; no rollback was attempted. Reload both provider settings and confirm one is enabled before taking a card payment.');
        }
        if (!previousEnabled) return target;
        try {
            await options.restoreTarget();
        } catch {
            throw new Error('Card-provider switch could not finish or roll back. The previous provider was confirmed enabled before rollback. Reload both provider settings and confirm which is enabled before taking a card payment.');
        }
        throw new Error(`Card-provider switch did not finish. The new provider was restored to its previous state; the previous provider is retained. ${String(error)}`);
    }
}
