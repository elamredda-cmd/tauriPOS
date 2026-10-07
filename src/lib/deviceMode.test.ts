import { afterEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import {
    assertCheckoutDeviceMode,
    deviceOperatingMode,
    deviceOperatingModeLabel,
    isBackOfficeBlockedPath,
    normalizeDeviceOperatingMode,
} from './deviceMode';

afterEach(() => {
    deviceOperatingMode.set(null);
});

describe('device operating mode', () => {
    it('defaults missing, legacy and corrupt values to checkout', () => {
        expect(normalizeDeviceOperatingMode(undefined)).toBe('checkout');
        expect(normalizeDeviceOperatingMode('')).toBe('checkout');
        expect(normalizeDeviceOperatingMode('something-else')).toBe('checkout');
    });

    it('normalizes the local Back Office value', () => {
        expect(normalizeDeviceOperatingMode(' back_OFFICE ')).toBe('back_office');
        expect(deviceOperatingModeLabel('back_office')).toBe('Back Office');
        expect(deviceOperatingModeLabel('checkout')).toBe('Checkout Till');
    });

    it('keeps checkout hardware routes out of Back Office', () => {
        expect(isBackOfficeBlockedPath('/customer-display')).toBe(true);
        expect(isBackOfficeBlockedPath('/settings/customer-display')).toBe(true);
        expect(isBackOfficeBlockedPath('/settings/payments')).toBe(true);
        expect(isBackOfficeBlockedPath('/settings/payments/dojo')).toBe(true);
        expect(isBackOfficeBlockedPath('/customers')).toBe(false);
        expect(isBackOfficeBlockedPath('/reports')).toBe(false);
        expect(isBackOfficeBlockedPath('/attendance')).toBe(false);
    });

    it('prevents a till shift from being opened in Back Office', () => {
        deviceOperatingMode.set('back_office');
        expect(() => assertCheckoutDeviceMode('Opening a till shift'))
            .toThrow('Opening a till shift is unavailable while this computer is in Back Office mode');

        deviceOperatingMode.set('checkout');
        expect(() => assertCheckoutDeviceMode('Opening a till shift')).not.toThrow();
        expect(get(deviceOperatingMode)).toBe('checkout');
    });
});
