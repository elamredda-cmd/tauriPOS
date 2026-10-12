import { get, type Writable } from 'svelte/store';
import type { MysqlConfig, PosConnectionState } from './stores/connection';

/** A superseded operation must never complete setup for the current target. */
export class SyncStartupStaleError extends Error {
    constructor() {
        super('The database connection changed while sync was starting. Retry the current connection.');
        this.name = 'SyncStartupStaleError';
    }
}

type Stage = 'identity-preflight' | 'schema' | 'identity' | 'epoch' | 'financial-recovery' | 'background-sync';

/** Keep authentication, identity and certificate failures out of retry loops. */
export function isDeterministicSyncStartupError(error: unknown): boolean {
    const message = String(error).toLowerCase();
    return [
        'database_identity_mismatch', 'database_identity_unverified',
        'mariadb_restore_maintenance', 'restore_pending_mariadb',
        'mariadb_schema_migration_failed', 'mariadb_account_migration_blocked',
        'mariadb_identifier_collation_migration_failed', 'mariadb_customer_collation_migration_failed',
        'mariadb schema migration failed', 'mariadb customer account migration stopped',
        'illegal mix of collations', 'unknown collation', 'collation is not valid',
        'duplicate values exist', 'duplicate entry', 'command denied', 'access denied',
        'authentication failed', 'permission denied', 'trigger already exists',
        'data too long', 'cannot be null', 'foreign key constraint',
        'certificate', 'unknown issuer', 'hostname mismatch', 'invalid peer',
        'tls alert', 'unsupported protocol',
    ].some(fragment => message.includes(fragment));
}

export function isTransientSyncStartupError(error: unknown): boolean {
    if (isDeterministicSyncStartupError(error)) return false;
    const message = String(error).toLowerCase();
    return [
        'timeout', 'timed out', 'connection refused', 'connection reset',
        'connection closed', 'connection was reset while opening',
        'server has gone away', 'lost connection', 'broken pipe',
        'network is unreachable', 'temporary failure', 'temporarily unavailable',
        'mariadb is unavailable', 'mariadb connection is unavailable',
        'too many connections', 'deadlock found', 'lock wait timeout',
        'try restarting transaction', 'database is locked',
        'error communicating with database', 'connection pool closed', 'pool closed',
        'dns', 'econnrefused', 'econnreset', 'etimedout',
    ].some(fragment => message.includes(fragment));
}

export interface SyncStartupRecoveryOperations {
    identityPreflight(): Promise<unknown>;
    schema(config: MysqlConfig): Promise<unknown>;
    identity(): Promise<unknown>;
    epoch(): Promise<unknown>;
    financial(config: MysqlConfig): Promise<unknown>;
    backgroundStart(): Promise<unknown> | void;
    backgroundStop(): void;
    onReady?(): void;
    onError?(error: unknown): void;
}

export interface SyncStartupRecovery {
    /** Explicit calls still run while automatic recovery is suspended. */
    start(config: MysqlConfig): Promise<void>;
    requestRetry(): Promise<void>;
    /** Drain a superseded gate before setup replaces global configuration. */
    waitForIdle(): Promise<void>;
    watch(): () => void;
    /** Pause automated starts during candidate setup; release in finally. */
    suspend(): () => void;
    stop(): void;
}

interface Job {
    key: string;
    generation: number;
    config: MysqlConfig;
    promise: Promise<void>;
}

// These private keys include passwords to distinguish credential changes, but
// are never returned, logged, added to errors, or persisted.
function configKey(config: MysqlConfig): string {
    return JSON.stringify([config.host, config.port, config.user, config.password, config.database]);
}

function stateKey(state: PosConnectionState): string {
    return state.mode === 'multi' && state.mysqlConfig ? configKey(state.mysqlConfig) : `mode:${state.mode}`;
}

export function createSyncStartupRecovery(options: {
    state: Writable<PosConnectionState>;
    ops: SyncStartupRecoveryOperations;
}): SyncStartupRecovery {
    const { state, ops } = options;
    let active: Job | null = null;
    let generation = 0;
    let currentKey: string | undefined;
    let schemaReadyKey = '';
    let autoBlockedKey = '';
    let retryCount = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;
    let watching = false;
    let suspensionCount = 0;
    let stopped = false;
    let previousTransportOnline = false;

    function clearRetry(): void {
        if (retryTimer !== null) clearTimeout(retryTimer);
        retryTimer = null;
    }

    function stopBackground(): void {
        try { ops.backgroundStop(); }
        catch (error) { ops.onError?.(error); }
    }

    function refreshConfiguration(): void {
        const snapshot = get(state);
        const key = stateKey(snapshot);
        if (key === currentKey) return;
        const replacing = currentKey !== undefined;
        currentKey = key;
        generation += 1;
        schemaReadyKey = snapshot.mysqlReady && !replacing ? key : '';
        autoBlockedKey = !replacing && snapshot.mysqlStatus === 'blocked'
            && !!snapshot.syncError && !isTransientSyncStartupError(snapshot.syncError) ? key : '';
        retryCount = 0;
        clearRetry();
        if (replacing) {
            stopBackground();
            if (snapshot.mode === 'multi' && snapshot.mysqlConfig) {
                state.update(latest => stateKey(latest) === key
                    ? { ...latest, mysqlReady: false, mysqlStatus: 'pending', syncError: null }
                    : latest);
            }
        }
    }

    function assertCurrent(job: Job): void {
        refreshConfiguration();
        if (stopped || job.generation !== generation || stateKey(get(state)) !== job.key) {
            throw new SyncStartupStaleError();
        }
    }

    function fullyReady(snapshot: PosConnectionState): boolean {
        // Background table warnings are not startup failures. Transport/safety
        // failures explicitly invalidate mysqlReady at their owning boundary.
        return snapshot.mode === 'multi' && snapshot.mysqlOnline && snapshot.mysqlReady;
    }

    function canAutoStart(): boolean {
        const snapshot = get(state);
        return watching && !stopped && suspensionCount === 0
            && snapshot.mode === 'multi' && !!snapshot.mysqlConfig
            && stateKey(snapshot) !== autoBlockedKey && !fullyReady(snapshot);
    }

    function reportAutomaticError(error: unknown): void {
        if (!(error instanceof SyncStartupStaleError)) ops.onError?.(error);
    }

    function launchAutomatic(): void {
        if (!canAutoStart()) return;
        const config = get(state).mysqlConfig;
        if (active && active.key === currentKey && active.generation === generation) return;
        if (config) void start(config, true).catch(reportAutomaticError);
    }

    function scheduleRetry(job: Job): void {
        if (!canAutoStart() || retryTimer !== null || currentKey !== job.key) return;
        const delay = Math.min(5_000 * 2 ** Math.min(retryCount, 4), 60_000);
        retryCount += 1;
        retryTimer = setTimeout(() => {
            retryTimer = null;
            launchAutomatic();
        }, delay);
    }

    async function run(job: Job): Promise<void> {
        const progress: { stage: Stage } = { stage: 'identity-preflight' };
        try {
            assertCurrent(job);
            stopBackground();
            state.update(latest => stateKey(latest) === job.key
                ? { ...latest, mysqlReady: false, mysqlStatus: 'pending' }
                : latest);

            async function gate(next: Stage, operation: () => Promise<unknown> | void): Promise<void> {
                assertCurrent(job);
                progress.stage = next;
                await operation();
                assertCurrent(job);
            }

            await gate('identity-preflight', ops.identityPreflight);
            if (schemaReadyKey !== job.key) {
                await gate('schema', () => ops.schema({ ...job.config }));
                schemaReadyKey = job.key;
            }
            await gate('identity', ops.identity);
            await gate('epoch', ops.epoch);
            await gate('financial-recovery', () => ops.financial({ ...job.config }));
            await gate('background-sync', ops.backgroundStart);
            assertCurrent(job);
            clearRetry();
            retryCount = 0;
            autoBlockedKey = '';
            state.update(latest => stateKey(latest) === job.key
                ? { ...latest, mysqlOnline: true, mysqlReady: true, mysqlStatus: 'online', syncError: null }
                : latest);
            assertCurrent(job);
            ops.onReady?.();
        } catch (error) {
            // Obsolete completions/errors cannot change the new target, start
            // its timers, report a current failure, or schedule an old retry.
            assertCurrent(job);
            stopBackground();
            const transient = isTransientSyncStartupError(error);
            const schemaFailure = progress.stage === 'schema' && !transient;
            autoBlockedKey = transient ? '' : job.key;
            const message = schemaFailure
                ? `MariaDB schema setup is blocked and automatic retries have stopped: ${String(error)}`
                : String(error);
            state.update(latest => stateKey(latest) === job.key
                ? { ...latest, mysqlOnline: false, mysqlReady: false,
                    mysqlStatus: transient ? 'offline' : 'blocked', syncError: message }
                : latest);
            if (transient) scheduleRetry(job);
            else clearRetry();
            throw error;
        }
    }

    async function start(config: MysqlConfig, automatic = false): Promise<void> {
        if (stopped) throw new SyncStartupStaleError();
        const frozen = { ...config };
        const requestedKey = configKey(frozen);
        refreshConfiguration();
        if (get(state).mode !== 'multi' || stateKey(get(state)) !== requestedKey) throw new SyncStartupStaleError();
        while (active) {
            if (active.key === requestedKey && active.generation === generation) return active.promise;
            await active.promise.catch(() => undefined);
            refreshConfiguration();
            if (stopped || stateKey(get(state)) !== requestedKey || get(state).mode !== 'multi') throw new SyncStartupStaleError();
            if (automatic && !canAutoStart()) throw new SyncStartupStaleError();
        }
        if (fullyReady(get(state))) {
            clearRetry();
            retryCount = 0;
            schemaReadyKey = requestedKey;
            return;
        }
        if (automatic && !canAutoStart()) throw new SyncStartupStaleError();
        clearRetry();
        const job: Job = { key: requestedKey, generation, config: frozen, promise: Promise.resolve() };
        active = job;
        // Install the single-flight identity before any state subscription or
        // injected operation can synchronously request another attempt.
        job.promise = Promise.resolve().then(() => run(job)).finally(() => {
            if (active === job) active = null;
        });
        return job.promise;
    }

    async function requestRetry(): Promise<void> {
        refreshConfiguration();
        const snapshot = get(state);
        if (snapshot.mode !== 'multi' || !snapshot.mysqlConfig) {
            throw new Error('MariaDB sync is not configured on this till.');
        }
        // Manual retry rechecks every gate. It does not declare a hard block
        // resolved or permit any upload merely because SELECT 1 succeeded.
        autoBlockedKey = '';
        return start(snapshot.mysqlConfig);
    }

    function watch(): () => void {
        if (stopped) return () => undefined;
        if (!watching) {
            watching = true;
            unsubscribe = state.subscribe(() => {
                const snapshot = get(state);
                const transportReconnected = snapshot.mysqlOnline && !previousTransportOnline;
                previousTransportOnline = snapshot.mysqlOnline;
                refreshConfiguration();
                if (transportReconnected && canAutoStart()) clearRetry();
                if (canAutoStart() && retryTimer === null) launchAutomatic();
            });
        }
        return () => {
            watching = false;
            unsubscribe?.();
            unsubscribe = null;
            clearRetry();
        };
    }

    function suspend(): () => void {
        suspensionCount += 1;
        clearRetry();
        if (suspensionCount === 1) {
            // Existing global-helper gates may still be settling. Invalidate
            // their completion, then let setup drain them with waitForIdle().
            generation += 1;
            stopBackground();
        }
        let released = false;
        return () => {
            if (released) return;
            released = true;
            suspensionCount = Math.max(0, suspensionCount - 1);
            if (suspensionCount === 0 && !stopped) {
                refreshConfiguration();
                launchAutomatic();
            }
        };
    }

    function stop(): void {
        stopped = true;
        generation += 1;
        watching = false;
        clearRetry();
        unsubscribe?.();
        unsubscribe = null;
        stopBackground();
    }

    async function waitForIdle(): Promise<void> {
        while (active) await active.promise.catch(() => undefined);
    }

    return { start, requestRetry, waitForIdle, watch, suspend, stop };
}
