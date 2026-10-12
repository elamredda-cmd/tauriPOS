import Database from '@tauri-apps/plugin-sql';

/** Allow a cold LAN connection (including DNS/TLS) to finish before declaring it offline. */
export const MYSQL_CONNECTION_TIMEOUT_MS = 10_000;

type PendingConnection = {
    uri: string;
    generation: number;
    result: Promise<Database>;
    cancel: () => void;
};

let cachedDatabase: Database | null = null;
let cachedUri = '';
let requestedUri = '';
let generation = 0;
let pendingConnection: PendingConnection | null = null;
let lifecycle: Promise<void> = Promise.resolve();

const resetError = () => new Error('MariaDB connection was reset while opening');

/**
 * The SQL plugin owns pools by URI, not by JavaScript Database instance. A late
 * load replaces that URI's pool, and closing an old wrapper closes the current
 * pool. All native load/close work therefore goes through this single queue.
 *
 * The caller deadline does not cancel native work. Keep that work on the queue
 * until it settles and cleans up; a retry must never overtake a timed-out load.
 */
function enqueueConnection<T>(operation: (cancelled: () => boolean) => Promise<T>): {
    result: Promise<T>;
    cancel: () => void;
} {
    let cancelled = false;
    let settled = false;
    let resolveResult!: (value: T) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
    });
    const reject = (error: unknown) => {
        if (settled) return;
        settled = true;
        cancelled = true;
        clearTimeout(deadline);
        rejectResult(error);
    };
    const deadline = setTimeout(
        () => reject(new Error('MariaDB connection timed out')),
        MYSQL_CONNECTION_TIMEOUT_MS,
    );
    lifecycle = lifecycle.then(async () => {
        try {
            if (cancelled) return;
            const value = await operation(() => cancelled);
            if (!settled) {
                settled = true;
                resolveResult(value);
            }
        } catch (error) {
            reject(error);
        } finally {
            clearTimeout(deadline);
        }
    });
    return { result, cancel: () => reject(resetError()) };
}

async function closeDatabase(database: Database | null): Promise<void> {
    if (!database) return;
    try {
        await database.close(database.path);
    } catch (error) {
        console.warn('mysql: failed to close MariaDB connection:', error);
    }
}

export function getCachedMysqlConnection(): Database | null {
    return cachedDatabase;
}

export function getMysqlConnectionGeneration(): number {
    return generation;
}

export function isCurrentMysqlConnection(database: Database): boolean {
    return cachedDatabase === database;
}

/** Used by both public connection entry points; reachability flags are not pool ownership. */
export function getSharedMysqlConnection(uri: string): Promise<Database> {
    if (requestedUri !== uri) {
        resetSharedMysqlConnection();
        requestedUri = uri;
    }
    if (cachedDatabase && cachedUri === uri) return Promise.resolve(cachedDatabase);
    if (pendingConnection?.uri === uri && pendingConnection.generation === generation) {
        return pendingConnection.result;
    }

    const openingGeneration = generation;
    const operation = enqueueConnection(async cancelled => {
        let opened: Database | null = null;
        const obsolete = () => cancelled() || generation !== openingGeneration || requestedUri !== uri;
        try {
            if (obsolete()) throw resetError();
            opened = await Database.load(uri);
            if (obsolete()) throw resetError();
            await opened.select('SELECT 1');
            if (obsolete()) throw resetError();
            cachedDatabase = opened;
            cachedUri = uri;
            return opened;
        } catch (error) {
            // This close completes before the next queued load can replace it.
            await closeDatabase(opened);
            throw error;
        }
    });
    const pending = { uri, generation: openingGeneration, ...operation };
    pendingConnection = pending;
    const clearPending = () => {
        if (pendingConnection === pending) pendingConnection = null;
    };
    void operation.result.then(clearPending, clearPending);
    return operation.result;
}

/** Invalidates immediately, but serializes cleanup before any subsequent native load. */
export function resetSharedMysqlConnection(): void {
    generation += 1;
    requestedUri = '';
    const old = cachedDatabase;
    cachedDatabase = null;
    cachedUri = '';
    pendingConnection?.cancel();
    pendingConnection = null;
    if (old) lifecycle = lifecycle.then(() => closeDatabase(old));
}

/**
 * A setup probe must not replace/close the live pool when testing its URI.
 * A different candidate URI uses the same lifecycle queue and is never cached.
 */
export async function probeMysqlConnection(uri: string): Promise<boolean> {
    if (requestedUri === uri) {
        const opening = getSharedMysqlConnection(uri);
        const probeGeneration = generation;
        const database = await opening;
        const obsolete = () => generation !== probeGeneration || !isCurrentMysqlConnection(database);
        if (obsolete()) throw resetError();
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                database.select('SELECT 1'),
                new Promise<never>((_, reject) => {
                    timeoutId = setTimeout(() => reject(new Error('MariaDB connection timed out')),
                        MYSQL_CONNECTION_TIMEOUT_MS);
                }),
            ]);
            if (obsolete()) throw resetError();
            return true;
        } finally {
            clearTimeout(timeoutId);
        }
    }
    return enqueueConnection(async cancelled => {
        let opened: Database | null = null;
        try {
            opened = await Database.load(uri);
            if (cancelled()) throw resetError();
            await opened.select('SELECT 1');
            if (cancelled()) throw resetError();
            return true;
        } finally {
            await closeDatabase(opened);
        }
    }).result;
}
