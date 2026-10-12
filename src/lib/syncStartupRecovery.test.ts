import { get, writable } from 'svelte/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MysqlConfig, PosConnectionState } from './stores/connection';
import {
    createSyncStartupRecovery, isDeterministicSyncStartupError,
    isTransientSyncStartupError, SyncStartupStaleError,
    type SyncStartupRecoveryOperations,
} from './syncStartupRecovery';

const config: MysqlConfig = { host: 'test.invalid', port: 3306, user: 'test', password: 'test-only', database: 'pos_test_sync' };
function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
async function settle() { for (let pass = 0; pass < 32; pass += 1) await Promise.resolve(); }
const cleanups: (() => void)[] = [];
function fixture(initial: Partial<PosConnectionState> = {}) {
    const state = writable<PosConnectionState>({ mode: 'multi', mysqlConfig: { ...config },
        mysqlOnline: false, mysqlReady: false, mysqlStatus: 'pending', syncError: null, ...initial });
    const order: string[] = [];
    const gate = (name: string) => vi.fn(async () => { order.push(name); expect(get(state).mysqlReady).toBe(false); });
    const ops: SyncStartupRecoveryOperations = {
        identityPreflight: gate('preflight'), schema: gate('schema'), identity: gate('identity'),
        epoch: gate('epoch'), financial: gate('financial'), backgroundStart: gate('background'),
        backgroundStop: vi.fn(), onReady: vi.fn(), onError: vi.fn(),
    };
    const recovery = createSyncStartupRecovery({ state, ops });
    cleanups.push(() => recovery.stop());
    return { state, order, ops, recovery };
}
afterEach(() => {
    cleanups.splice(0).forEach(cleanup => cleanup());
    vi.useRealTimers();
});

describe('complete startup authority gates', () => {
    it('joins simultaneous starts and becomes ready only after every ordered gate', async () => {
        const { state, order, ops, recovery } = fixture({ syncError: 'MariaDB timeout' });
        await Promise.all([recovery.start(config), recovery.start({ ...config }), recovery.requestRetry()]);
        expect(order).toEqual(['preflight', 'schema', 'identity', 'epoch', 'financial', 'background']);
        expect(get(state)).toMatchObject({ mysqlOnline: true, mysqlReady: true, mysqlStatus: 'online', syncError: null });
        expect(ops.onReady).toHaveBeenCalledTimes(1);
    });

    it('does not treat SELECT 1 transport success as startup success', async () => {
        const { state, ops, recovery } = fixture({ mysqlOnline: true, syncError: 'Old timeout' });
        const pending = deferred();
        ops.financial = vi.fn(() => pending.promise);
        const running = recovery.start(config);
        await settle();
        expect(get(state)).toMatchObject({ mysqlOnline: true, mysqlReady: false, syncError: 'Old timeout' });
        expect(ops.backgroundStart).not.toHaveBeenCalled();
        expect(ops.onReady).not.toHaveBeenCalled();
        pending.resolve();
        await running;
        expect(get(state).mysqlReady).toBe(true);
    });

    it('does not repeat init or rebuild timers for an already-ready connection', async () => {
        const { state, ops, recovery } = fixture({ mysqlOnline: true, mysqlReady: true, mysqlStatus: 'online' });
        recovery.watch();
        await Promise.all([recovery.start(config), recovery.requestRetry()]);
        for (let pass = 0; pass < 3; pass += 1) state.update(value => ({ ...value, mysqlOnline: true }));
        await settle();
        expect(ops.identityPreflight).not.toHaveBeenCalled();
        expect(ops.schema).not.toHaveBeenCalled();
        expect(ops.backgroundStart).not.toHaveBeenCalled();
        expect(ops.backgroundStop).not.toHaveBeenCalled();
    });

    it('does not restart ready sync merely because one background table has a retry warning', async () => {
        const { state, ops, recovery } = fixture({ mysqlOnline: true, mysqlReady: true, mysqlStatus: 'online',
            syncError: 'Some changes could not be downloaded. The next cycle will retry.' });
        recovery.watch();
        await recovery.start(config);
        state.update(value => ({ ...value, syncError: 'Background verification will retry' }));
        await settle();
        expect(ops.identityPreflight).not.toHaveBeenCalled();
        expect(ops.backgroundStop).not.toHaveBeenCalled();
        expect(get(state).mysqlReady).toBe(true);
    });

    it('keeps a successful schema checkpoint after a later transport failure', async () => {
        const { order, ops, recovery } = fixture();
        const financial = vi.fn().mockRejectedValueOnce(new Error('MariaDB connection timed out')).mockResolvedValue(undefined);
        ops.financial = financial;
        await expect(recovery.start(config)).rejects.toThrow('timed out');
        await recovery.requestRetry();
        expect(ops.schema).toHaveBeenCalledTimes(1);
        expect(ops.identityPreflight).toHaveBeenCalledTimes(2);
        expect(ops.epoch).toHaveBeenCalledTimes(2);
        expect(financial).toHaveBeenCalledTimes(2);
        expect(order).toEqual(['preflight', 'schema', 'identity', 'epoch', 'preflight', 'identity', 'epoch', 'background']);
    });

    it.each(['identityPreflight', 'schema', 'identity', 'epoch', 'financial', 'backgroundStart'] as const)(
        'does not mark ready or run later gates after %s fails', async name => {
            const { state, ops, recovery } = fixture();
            ops[name] = vi.fn(async () => { throw new Error('DATABASE_IDENTITY_MISMATCH: test block'); });
            await expect(recovery.start(config)).rejects.toThrow('DATABASE_IDENTITY_MISMATCH');
            expect(get(state)).toMatchObject({ mysqlOnline: false, mysqlReady: false, mysqlStatus: 'blocked' });
            expect(ops.onReady).not.toHaveBeenCalled();
            const gates = ['identityPreflight', 'schema', 'identity', 'epoch', 'financial', 'backgroundStart'] as const;
            for (const later of gates.slice(gates.indexOf(name) + 1)) expect(ops[later]).not.toHaveBeenCalled();
        },
    );

    it('manual retry rechecks a hard block instead of overriding it', async () => {
        const { state, ops, recovery } = fixture();
        ops.identityPreflight = vi.fn(async () => { throw new Error('MARIADB_RESTORE_MAINTENANCE: test restore'); });
        await expect(recovery.start(config)).rejects.toThrow('RESTORE');
        state.update(value => ({ ...value, mysqlOnline: true }));
        await expect(recovery.requestRetry()).rejects.toThrow('RESTORE');
        expect(ops.identityPreflight).toHaveBeenCalledTimes(2);
        expect(ops.schema).not.toHaveBeenCalled();
        expect(get(state).mysqlReady).toBe(false);
    });
});

describe('bounded automatic recovery', () => {
    it('retries a cold timeout after five seconds and removes all retry timers when ready', async () => {
        vi.useFakeTimers();
        const { state, ops, recovery } = fixture();
        ops.identityPreflight = vi.fn().mockRejectedValueOnce(new Error('MariaDB connection is unavailable')).mockResolvedValue(undefined);
        recovery.watch();
        await settle();
        expect(get(state)).toMatchObject({ mysqlReady: false, mysqlStatus: 'offline' });
        expect(ops.identityPreflight).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(4_999);
        expect(ops.identityPreflight).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(get(state).mysqlReady).toBe(true);
        expect(ops.identityPreflight).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(ops.schema).toHaveBeenCalledTimes(1);
    });

    it('backs off through 5, 10, 20, 40 and at most 60 seconds', async () => {
        vi.useFakeTimers();
        const { ops, recovery } = fixture();
        ops.identityPreflight = vi.fn(async () => { throw new Error('MariaDB timeout'); });
        recovery.watch();
        await settle();
        for (const [index, delay] of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000].entries()) {
            await vi.advanceTimersByTimeAsync(delay - 1);
            expect(ops.identityPreflight).toHaveBeenCalledTimes(index + 1);
            await vi.advanceTimersByTimeAsync(1);
            expect(ops.identityPreflight).toHaveBeenCalledTimes(index + 2);
        }
        recovery.stop();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('a new successful transport probe retries gates immediately, not after backoff', async () => {
        vi.useFakeTimers();
        const { state, ops, recovery } = fixture();
        ops.identityPreflight = vi.fn().mockRejectedValueOnce(new Error('MariaDB timeout')).mockResolvedValue(undefined);
        recovery.watch();
        await settle();
        expect(vi.getTimerCount()).toBe(1);
        state.update(value => ({ ...value, mysqlOnline: true, mysqlStatus: 'online' }));
        await settle();
        expect(get(state).mysqlReady).toBe(true);
        expect(ops.identityPreflight).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
        'DATABASE_IDENTITY_MISMATCH', 'DATABASE_IDENTITY_UNVERIFIED',
        'MARIADB_RESTORE_MAINTENANCE', 'Access denied for user',
        'MARIADB_SCHEMA_MIGRATION_FAILED: lock wait timeout',
    ])('never loops automatically or advertises ready after %s', async message => {
        vi.useFakeTimers();
        const { state, ops, recovery } = fixture();
        ops.identityPreflight = vi.fn(async () => { throw new Error(message); });
        recovery.watch();
        await settle();
        state.update(value => ({ ...value, mysqlOnline: true }));
        await vi.advanceTimersByTimeAsync(300_000);
        expect(ops.identityPreflight).toHaveBeenCalledTimes(1);
        expect(ops.backgroundStart).not.toHaveBeenCalled();
        expect(get(state).mysqlReady).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not auto-retry an initially hard-blocked state, but permits explicit operator retry', async () => {
        const { ops, recovery } = fixture({ mysqlStatus: 'blocked', syncError: 'DATABASE_IDENTITY_MISMATCH' });
        recovery.watch();
        await settle();
        expect(ops.identityPreflight).not.toHaveBeenCalled();
        await recovery.requestRetry();
        expect(ops.identityPreflight).toHaveBeenCalledTimes(1);
    });

    it('a non-transport schema error stops retries until explicit operator retry', async () => {
        vi.useFakeTimers();
        const { state, ops, recovery } = fixture();
        ops.schema = vi.fn().mockRejectedValueOnce(new Error('Unknown migration failure')).mockResolvedValue(undefined);
        recovery.watch();
        await settle();
        expect(get(state).syncError).toContain('automatic retries have stopped');
        await vi.advanceTimersByTimeAsync(300_000);
        expect(ops.schema).toHaveBeenCalledTimes(1);
        await recovery.requestRetry();
        expect(get(state).mysqlReady).toBe(true);
        expect(ops.schema).toHaveBeenCalledTimes(2);
    });
});

describe('configuration and lifecycle isolation', () => {
    it.each(['identityPreflight', 'schema', 'identity', 'epoch', 'financial', 'backgroundStart'] as const)(
        'rejects stale %s completion and queues the latest target until it settles', async name => {
            const { state, ops, recovery } = fixture();
            const pending = deferred();
            ops[name] = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue(undefined);
            const first = recovery.start(config).then(() => undefined, error => error);
            await settle();
            const newer = { ...config, host: 'new-target.invalid' };
            state.update(value => ({ ...value, mysqlConfig: newer, mysqlReady: false }));
            const next = recovery.start(newer);
            await settle();
            expect(ops[name]).toHaveBeenCalledTimes(1);
            pending.resolve();
            expect(await first).toBeInstanceOf(SyncStartupStaleError);
            await next;
            expect(get(state)).toMatchObject({ mysqlConfig: newer, mysqlReady: true, syncError: null });
            expect(ops.onReady).toHaveBeenCalledTimes(1);
        },
    );

    it('a stale rejection cannot mark the new target blocked or leak its config in the error', async () => {
        const { state, ops, recovery } = fixture();
        const pending = deferred();
        ops.identityPreflight = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue(undefined);
        const old = recovery.start(config).then(() => undefined, error => error);
        await settle();
        const newer = { ...config, password: 'replacement-secret' };
        state.update(value => ({ ...value, mysqlConfig: newer }));
        const next = recovery.start(newer);
        pending.reject(new Error('Access denied for old target'));
        const stale = await old;
        expect(stale).toBeInstanceOf(SyncStartupStaleError);
        expect(String(stale)).not.toContain(config.password);
        expect(String(stale)).not.toContain(newer.password);
        await next;
        expect(get(state)).toMatchObject({ mysqlReady: true, syncError: null });
    });

    it.each(['host', 'port', 'user', 'password', 'database'] as const)(
        'recognizes an exact %s change and requires fresh gates/schema', async field => {
            const { state, ops, recovery } = fixture();
            await recovery.start(config);
            const newer = { ...config, [field]: field === 'port' ? 3307 : `${String(config[field])}-changed` } as MysqlConfig;
            state.update(value => ({ ...value, mysqlConfig: newer }));
            await recovery.start(newer);
            expect(ops.identityPreflight).toHaveBeenCalledTimes(2);
            expect(ops.schema).toHaveBeenCalledTimes(2);
            expect(ops.financial).toHaveBeenLastCalledWith(newer);
        },
    );

    it('suspends automated work, invalidates and drains an old same-config run, but permits explicit setup start', async () => {
        const { state, ops, recovery } = fixture();
        const pending = deferred();
        ops.identityPreflight = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue(undefined);
        recovery.watch();
        await settle();
        const resume = recovery.suspend();
        let drained = false;
        const idle = recovery.waitForIdle().then(() => { drained = true; });
        await settle();
        expect(drained).toBe(false);
        pending.resolve();
        await idle;
        expect(get(state).mysqlReady).toBe(false);
        expect(ops.onReady).not.toHaveBeenCalled();
        const newer = { ...config, database: 'pos_test_candidate' };
        state.update(value => ({ ...value, mysqlConfig: newer }));
        await settle();
        expect(ops.identityPreflight).toHaveBeenCalledTimes(1);
        await recovery.start(newer);
        resume();
        resume();
        await settle();
        expect(ops.identityPreflight).toHaveBeenCalledTimes(2);
        expect(ops.onReady).toHaveBeenCalledTimes(1);
    });

    it('resumes automatic recovery once after nested suspension releases', async () => {
        const { ops, recovery } = fixture();
        const first = recovery.suspend();
        const second = recovery.suspend();
        recovery.watch();
        await settle();
        first(); first();
        await settle();
        expect(ops.identityPreflight).not.toHaveBeenCalled();
        second();
        await settle();
        expect(ops.identityPreflight).toHaveBeenCalledTimes(1);
    });

    it('suspension also cancels an automatic new-target start already queued behind the old target', async () => {
        const { state, ops, recovery } = fixture();
        const pending = deferred();
        ops.identityPreflight = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue(undefined);
        recovery.watch();
        await settle();
        const newer = { ...config, host: 'candidate.invalid' };
        state.update(value => ({ ...value, mysqlConfig: newer }));
        const resume = recovery.suspend();
        pending.resolve();
        await recovery.waitForIdle();
        await settle();
        expect(ops.identityPreflight).toHaveBeenCalledTimes(1);
        resume();
        await settle();
        expect(ops.identityPreflight).toHaveBeenCalledTimes(2);
        expect(get(state).mysqlReady).toBe(true);
    });

    it('configuration changes while watching automatically start only the newest queued target', async () => {
        const { state, ops, recovery } = fixture();
        const pending = deferred();
        ops.identityPreflight = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue(undefined);
        recovery.watch();
        await settle();
        state.update(value => ({ ...value, mysqlConfig: { ...config, host: 'discarded.invalid' } }));
        const newest = { ...config, host: 'newest.invalid' };
        state.update(value => ({ ...value, mysqlConfig: newest }));
        pending.resolve();
        await settle();
        expect(ops.identityPreflight).toHaveBeenCalledTimes(2);
        expect(ops.schema).toHaveBeenCalledTimes(1);
        expect(ops.schema).toHaveBeenCalledWith(newest);
        expect(get(state).mysqlReady).toBe(true);
    });

    it('switching to local mode cancels retries and stale completions', async () => {
        vi.useFakeTimers();
        const { state, ops, recovery } = fixture();
        ops.identityPreflight = vi.fn(async () => { throw new Error('MariaDB timeout'); });
        recovery.watch();
        await settle();
        expect(vi.getTimerCount()).toBe(1);
        state.update(value => ({ ...value, mode: 'single', mysqlReady: false }));
        await vi.advanceTimersByTimeAsync(300_000);
        expect(ops.identityPreflight).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
        await expect(recovery.requestRetry()).rejects.toThrow('not configured');
    });

    it('stop prevents pending completion and removes subscriptions/timers', async () => {
        const { state, ops, recovery } = fixture();
        const pending = deferred();
        ops.identity = vi.fn(() => pending.promise);
        recovery.watch();
        await settle();
        recovery.stop();
        pending.resolve();
        await settle();
        expect(get(state).mysqlReady).toBe(false);
        expect(ops.epoch).not.toHaveBeenCalled();
        expect(ops.onReady).not.toHaveBeenCalled();
        state.update(value => ({ ...value, mysqlOnline: true }));
        await settle();
        expect(ops.identityPreflight).toHaveBeenCalledTimes(1);
        await expect(recovery.start(config)).rejects.toBeInstanceOf(SyncStartupStaleError);
    });
});

describe('transport versus safety classification', () => {
    it.each(['MariaDB timeout', 'MariaDB connection is unavailable', 'MariaDB is unavailable',
        'database is locked', 'error communicating with database', 'pool closed',
        'pool timed out while waiting for an open connection', 'connection refused'])('%s is transient', message => {
        expect(isTransientSyncStartupError(message)).toBe(true);
    });
    it.each(['Access denied: connection timeout', 'DATABASE_IDENTITY_MISMATCH: timeout',
        'certificate expired', 'TLS alert: certificate unknown',
        'error occurred while attempting to establish a TLS connection'])('%s is not blindly retried', message => {
        expect(isTransientSyncStartupError(message)).toBe(false);
    });
    it('marks certificate rejection deterministic without exposing or weakening TLS', () => {
        expect(isDeterministicSyncStartupError('certificate unknown issuer')).toBe(true);
    });
});
