import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), load: vi.fn(), select: vi.fn(), execute: vi.fn(), close: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, isTauri: () => true }));
vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: mocks.load } }));

import { connectionState } from './connection';
import { mysqlSafeOfflineUpsert, mysqlUpsert, resetCachedConnection } from './mysql';
import { upsert } from './sqlite';

const identity = {
    id: 'main', shopId: 'shop_fixture', shopName: 'Fixture',
    licenseId: 'lic_fixture', identitySignature: 'opaque-signed-token',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
};

describe('protected licence sync routing', () => {
    beforeEach(() => {
        resetCachedConnection();
        vi.clearAllMocks();
        mocks.invoke.mockResolvedValue(1);
        mocks.load.mockResolvedValue({ select: mocks.select, execute: mocks.execute, close: mocks.close });
        mocks.select.mockResolvedValue([{ value: 'fixture-epoch' }]);
        connectionState.set({ mode: 'multi', mysqlConfig: {
            host: 'fixture.invalid', port: 3306, user: 'fixture', password: '', database: 'fixture',
        }, mysqlOnline: true, mysqlReady: true, syncError: null });
    });

    it('sends ordinary local identity writes through the atomic native merge', async () => {
        await upsert('app_identity', identity);
        expect(mocks.invoke).toHaveBeenCalledWith('commit_local_batch', {
            mutations: [{ table: 'app_identity', data: identity, idKey: 'id' }],
        });
        expect(mocks.execute).not.toHaveBeenCalled();
        expect(mocks.load).not.toHaveBeenCalled();
    });

    it.each([mysqlUpsert, mysqlSafeOfflineUpsert])('does not use mutable timestamps for licence uploads', async (upload) => {
        await upload('app_identity', identity);
        expect(mocks.invoke).toHaveBeenCalledWith('commit_mysql_outbox_operation', expect.objectContaining({
            tableName: 'app_identity', operation: 'upsert', data: identity, idKey: 'id', serverDataEpoch: 'fixture-epoch',
        }));
        expect(mocks.select).toHaveBeenCalledOnce();
        expect(mocks.select.mock.calls[0][0]).toContain('server_data_epoch');
        expect(mocks.execute).not.toHaveBeenCalled();
    });

    it('does not fall back to an unsafe SQL overwrite when the native merge fails', async () => {
        mocks.invoke.mockRejectedValue(new Error('DATABASE_IDENTITY_MISMATCH'));
        await expect(mysqlUpsert('app_identity', identity)).rejects.toThrow('DATABASE_IDENTITY_MISMATCH');
        expect(mocks.execute).not.toHaveBeenCalled();
    });
});
