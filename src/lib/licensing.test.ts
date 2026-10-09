import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), sync: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, isTauri: () => true }));
vi.mock('$lib/stores/database', () => ({ syncManualLicenseIdentity: mocks.sync }));

import {
    activateManualLicense,
    activateManualLicenseFile,
    manualLicenseStatus,
    manualLicenseSyncWarning,
    requireManualSaleAccess,
    retryManualLicenseSync,
    type ManualLicenseStatus,
} from './licensing';

const active = {
    state: 'active', accessAllowed: true, signatureValid: true, message: 'Licence is active',
} as ManualLicenseStatus;

describe('manual licence activation', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        manualLicenseStatus.set(null);
        manualLicenseSyncWarning.set('');
        mocks.invoke.mockResolvedValue(active);
        mocks.sync.mockResolvedValue(undefined);
    });

    it('publishes a verified activation to the shop', async () => {
        await expect(activateManualLicense('signed-code')).resolves.toBe(active);
        expect(mocks.invoke).toHaveBeenCalledWith('activate_manual_license', { token: 'signed-code' });
        expect(mocks.sync).toHaveBeenCalledOnce();
        expect(get(manualLicenseStatus)).toBe(active);
        expect(get(manualLicenseSyncWarning)).toBe('');
    });

    it.each(['code', 'file'])('keeps a durable %s activation when shop sharing fails', async (source) => {
        mocks.sync.mockRejectedValue(new Error('Database unavailable'));
        const result = source === 'code'
            ? await activateManualLicense('signed-code')
            : await activateManualLicenseFile('/fixture/test.lbjlic');
        expect(result).toBe(active);
        expect(get(manualLicenseStatus)).toBe(active);
        expect(get(manualLicenseSyncWarning)).toContain('installed on this till');
    });

    it('clears the sharing warning only after a successful retry', async () => {
        mocks.sync.mockRejectedValueOnce(new Error('Offline'));
        await expect(retryManualLicenseSync()).resolves.toBe(false);
        expect(get(manualLicenseSyncWarning)).not.toBe('');
        await expect(retryManualLicenseSync()).resolves.toBe(true);
        expect(get(manualLicenseSyncWarning)).toBe('');
        expect(mocks.invoke).not.toHaveBeenCalled();
    });

    it('does not publish a code that native validation rejected', async () => {
        mocks.invoke.mockRejectedValue(new Error('This licence belongs to a different shop'));
        await expect(activateManualLicense('wrong-shop-code')).rejects.toThrow('different shop');
        expect(mocks.sync).not.toHaveBeenCalled();
        expect(get(manualLicenseStatus)).toBeNull();
    });

    it('never treats a sharing warning as permission to sell on an expired licence', async () => {
        mocks.invoke.mockResolvedValue({ ...active, state: 'expired', accessAllowed: false, message: 'Licence has expired' });
        manualLicenseSyncWarning.set('Earlier licence sharing failed');
        await expect(requireManualSaleAccess()).rejects.toThrow('SALE_LICENSE_REQUIRED');
    });
});
