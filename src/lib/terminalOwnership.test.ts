import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    invoke: vi.fn(), acquire: vi.fn(), refresh: vi.fn(), release: vi.fn(), prepare: vi.fn(),
    list: vi.fn(), connection: { mode: 'multi', mysqlOnline: false, mysqlConfig: null as any },
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, isTauri: () => true }));
vi.mock('$lib/stores/connection', () => ({
    connectionState: { subscribe(run: (state: unknown) => void) { run(mocks.connection); return () => undefined; } },
    buildMysqlUri: () => 'mysql://fixture.invalid/example',
}));
vi.mock('$lib/stores/mysql', () => ({
    mysqlAcquirePaymentTerminalLock: mocks.acquire,
    mysqlRefreshPaymentTerminalLock: mocks.refresh,
    mysqlReleasePaymentTerminalLock: mocks.release,
}));
vi.mock('$lib/terminalAttempts', () => ({
    getRecoverablePaymentTerminalAttempts: mocks.list,
    assertPaymentTerminalAttemptReady: vi.fn(),
    preparePaymentTerminalAttempt: mocks.prepare,
    prunePaymentTerminalAttempts: vi.fn(), updatePaymentTerminalAttempt: vi.fn(),
}));

import { acquireDojoLock, refreshDojoLock, releaseDojoLock, dojoConfig, defaultDojoConfig,
    saveDojoAttempt, getRecoverableDojoAttempts, saveDojoConfig, clearDojoSecret } from './dojo';
import { acquireSumupLock, refreshSumupLock, releaseSumupLock, sumupConfig, defaultSumupConfig,
    saveSumupAttempt, getRecoverableSumupAttempts, saveSumupConfig, clearSumupSecrets } from './sumup';
import type { TerminalPaymentAttempt } from './terminalAttempts';

describe('explicit per-till payment-terminal ownership', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        mocks.connection.mode = 'multi'; mocks.connection.mysqlOnline = false; mocks.connection.mysqlConfig = null;
        mocks.prepare.mockImplementation(async (attempt) => attempt);
        mocks.invoke.mockResolvedValue({ acquired: true, lock: null });
        dojoConfig.set({ ...defaultDojoConfig }); sumupConfig.set({ ...defaultSumupConfig });
    });

    const providers = [
        { name: 'dojo', acquire: acquireDojoLock, refresh: refreshDojoLock, release: releaseDojoLock,
            config: { ...defaultDojoConfig, softwareHouseId: 'fixture', terminalId: 'terminal' },
            key: 'dojo:fixture:terminal', save: saveDojoAttempt, recover: getRecoverableDojoAttempts },
        { name: 'sumup', acquire: acquireSumupLock, refresh: refreshSumupLock, release: releaseSumupLock,
            config: { ...defaultSumupConfig, merchantCode: 'fixture', readerId: 'reader' },
            key: 'sumup:fixture:reader', save: saveSumupAttempt, recover: getRecoverableSumupAttempts },
    ];

    for (const provider of providers) {
        it(`${provider.name} always uses native local leases for dedicated registration, even offline`, async () => {
            await provider.acquire(provider.config as any, 'till', 'Till name', 'payment');
            await provider.refresh(provider.config as any, 'till', 'payment');
            await provider.release(provider.config as any, 'till', 'payment');
            expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual([
                'terminal_acquire_local_lock', 'terminal_refresh_local_lock', 'terminal_release_local_lock',
            ]);
            expect(mocks.invoke.mock.calls[0][1]).toMatchObject({ terminalKey: provider.key, tillId: 'till', paymentReference: 'payment' });
            expect(mocks.acquire).not.toHaveBeenCalled(); expect(mocks.refresh).not.toHaveBeenCalled(); expect(mocks.release).not.toHaveBeenCalled();
        });

        it(`${provider.name} does not fall back to local for an offline legacy shared registration`, async () => {
            const legacy = { ...provider.config, terminalOwnership: undefined };
            await expect(provider.acquire(legacy as any, 'till', 'Till name', 'payment')).rejects.toThrow('MariaDB');
            expect(mocks.invoke).not.toHaveBeenCalled();
        });

        it(`${provider.name} retains shared leases when explicitly configured`, async () => {
            mocks.connection.mysqlOnline = true;
            await provider.acquire({ ...provider.config, terminalOwnership: 'shared' } as any, 'till', 'Till name', 'payment');
            expect(mocks.acquire).toHaveBeenCalledWith(provider.key, 'till', 'Till name', 'payment', 180);
            expect(mocks.invoke).not.toHaveBeenCalled();
        });

        it(`${provider.name} journals new dedicated attempts locally and never reclassifies explicit legacy attempts`, async () => {
            const attempt = { provider: provider.name } as TerminalPaymentAttempt;
            await provider.save(attempt as any);
            expect(mocks.prepare).toHaveBeenLastCalledWith({ ...attempt, journalScope: 'local' });
            await provider.save({ ...attempt, journalScope: 'shared' } as any);
            expect(mocks.prepare).toHaveBeenLastCalledWith({ ...attempt, journalScope: 'shared' });
            await provider.recover();
            expect(mocks.list).toHaveBeenCalledWith(provider.name, { includeShared: false });
        });
    }

    it('passes optional server context only for the native legacy registration handover check', async () => {
        mocks.connection.mysqlOnline = true; mocks.connection.mysqlConfig = {};
        mocks.invoke.mockImplementation(async (_command, args) => args.config || {});
        await saveDojoConfig({ ...defaultDojoConfig });
        await saveSumupConfig({ ...defaultSumupConfig });
        await clearDojoSecret(); await clearSumupSecrets();
        expect(mocks.invoke.mock.calls.every(([, args]) => args.mysqlUri === 'mysql://fixture.invalid/example')).toBe(true);
    });
});
