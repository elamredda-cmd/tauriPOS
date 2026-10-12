import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
    localSelect: vi.fn(), localExecute: vi.fn(),
    barrier: vi.fn(), touch: vi.fn(), list: vi.fn(),
}));
vi.mock('./sqlite', async original => ({
    ...await original<typeof import('./sqlite')>(),
    getOrCreateTillId: async () => 'presence-current',
    getTillName: async () => 'Current till',
    getDb: async () => ({ select: native.localSelect, execute: native.localExecute }),
}));
vi.mock('./mysql', async original => ({
    ...await original<typeof import('./mysql')>(),
    mysqlGetWholeSystemCloseBarrier: native.barrier,
    mysqlTouchTillPresence: native.touch,
    mysqlGetConnectedTills: native.list,
}));

import { getConnectedTills } from './database';
import { connectionState, type PosConnectionState } from './connection';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(yes => { resolve = yes; });
    return { promise, resolve };
}

const config = { host: 'presence.invalid', port: 3306, user: 'fixture', password: '', database: 'presence_fixture' };
const idleBarrier = { state: 'idle', token: '' };
const remoteRows = [
    { tillId: 'presence-current', tillName: 'Current till', lastSeenAt: '2026-10-12T12:00:00Z', secondsAgo: 0, isCurrent: false },
    { tillId: 'presence-peer', tillName: 'Peer till', lastSeenAt: '2026-10-12T11:59:55Z', secondsAgo: 5, isCurrent: true },
];

describe('connected till presence readiness and connection stability', () => {
    let previousConnection: PosConnectionState;

    beforeEach(() => {
        previousConnection = get(connectionState);
        vi.resetAllMocks();
        connectionState.set({ mode: 'multi', mysqlConfig: { ...config }, mysqlOnline: true,
            mysqlReady: true, mysqlStatus: 'online', syncError: null });
        native.localSelect.mockImplementation(async (sql: string) => sql.includes('FROM registers')
            ? [{ id: 'presence-current', name: 'Current till', isActive: 1 }]
            : [{ count: 0 }]);
        native.localExecute.mockResolvedValue({ rowsAffected: 1 });
        native.barrier.mockResolvedValue(idleBarrier);
        native.touch.mockResolvedValue(undefined);
        native.list.mockResolvedValue(remoteRows);
    });

    afterEach(() => {
        connectionState.set(previousConnection);
        vi.restoreAllMocks();
    });

    it('never publishes or reads remote presence when reachable but startup is not ready', async () => {
        connectionState.update(state => ({ ...state, mysqlReady: false,
            syncError: 'MariaDB connection timed out' }));
        await expect(getConnectedTills()).rejects.toThrow('SYNC_NOT_READY');
        expect(native.barrier).not.toHaveBeenCalled();
        expect(native.touch).not.toHaveBeenCalled();
        expect(native.list).not.toHaveBeenCalled();
    });

    it('never publishes or reads remote presence while the ready connection is offline', async () => {
        connectionState.update(state => ({ ...state, mysqlOnline: false }));
        await expect(getConnectedTills()).rejects.toThrow('SYNC_NOT_READY');
        expect(native.barrier).not.toHaveBeenCalled();
        expect(native.touch).not.toHaveBeenCalled();
        expect(native.list).not.toHaveBeenCalled();
    });

    it('refreshes a ready till and marks current and peer rows from the actual local identity', async () => {
        await expect(getConnectedTills()).resolves.toEqual([
            { ...remoteRows[0], isCurrent: true },
            { ...remoteRows[1], isCurrent: false },
        ]);
        expect(native.touch).toHaveBeenCalledExactlyOnceWith('presence-current', 'Current till', {
            protocolVersion: 1, barrierToken: '', barrierPhase: '', outboxCount: 0,
            localTerminalAttemptCount: 0, syncConflictCount: 0,
        });
        expect(native.list).toHaveBeenCalledExactlyOnceWith(45);
    });

    it('does not hide already-ready tills because of a harmless background retry warning', async () => {
        connectionState.update(state => ({ ...state, syncError: 'A queued retry will run later' }));
        await expect(getConnectedTills()).resolves.toHaveLength(2);
        expect(native.touch).toHaveBeenCalledOnce();
        expect(native.list).toHaveBeenCalledOnce();
    });

    it.each(['config', 'mode', 'readiness'] as const)(
        'does not publish or list a new target after %s changes during the close-barrier read', async change => {
            const barrier = deferred<typeof idleBarrier>();
            const started = deferred<void>();
            native.barrier.mockImplementationOnce(() => { started.resolve(); return barrier.promise; });
            const operation = getConnectedTills();
            const outcome = expect(operation).rejects.toThrow('SYNC_NOT_READY');
            await started.promise;
            connectionState.update(state => change === 'config'
                ? { ...state, mysqlConfig: { ...config, database: 'different_fixture' } }
                : change === 'mode' ? { ...state, mode: 'single' }
                    : { ...state, mysqlReady: false });
            barrier.resolve(idleBarrier);
            await outcome;
            expect(native.barrier).toHaveBeenCalledOnce();
            expect(native.touch).not.toHaveBeenCalled();
            expect(native.list).not.toHaveBeenCalled();
            expect(native.localExecute).not.toHaveBeenCalled();
        },
    );

    it('rechecks connection stability after local readiness counts and before the presence write', async () => {
        native.barrier.mockImplementationOnce(async () => idleBarrier).mockImplementationOnce(async () => {
            connectionState.update(state => ({ ...state, mysqlConfig: { ...config, host: 'changed.invalid' } }));
            return idleBarrier;
        });
        await expect(getConnectedTills()).rejects.toThrow('SYNC_NOT_READY');
        expect(native.barrier).toHaveBeenCalledTimes(2);
        expect(native.touch).not.toHaveBeenCalled();
        expect(native.list).not.toHaveBeenCalled();
    });

    it.each(['config', 'mode', 'readiness'] as const)(
        'does not return stale connected rows after %s changes during the list query', async change => {
            const rows = deferred<typeof remoteRows>();
            const started = deferred<void>();
            native.list.mockImplementationOnce(() => { started.resolve(); return rows.promise; });
            const operation = getConnectedTills();
            const outcome = expect(operation).rejects.toThrow('SYNC_NOT_READY');
            await started.promise;
            connectionState.update(state => change === 'config'
                ? { ...state, mysqlConfig: { ...config, user: 'different_fixture' } }
                : change === 'mode' ? { ...state, mode: 'single' }
                    : { ...state, mysqlReady: false });
            rows.resolve(remoteRows);
            await outcome;
            expect(native.touch).toHaveBeenCalledOnce();
            expect(native.list).toHaveBeenCalledOnce();
        },
    );

    it('keeps local-only till visibility independent of MariaDB readiness', async () => {
        connectionState.update(state => ({ ...state, mode: 'single', mysqlOnline: false, mysqlReady: false }));
        await expect(getConnectedTills()).resolves.toEqual([{
            tillId: 'presence-current', tillName: 'Current till', lastSeenAt: expect.any(String),
            secondsAgo: 0, isCurrent: true,
        }]);
        expect(native.barrier).not.toHaveBeenCalled();
        expect(native.touch).not.toHaveBeenCalled();
        expect(native.list).not.toHaveBeenCalled();
    });
});
