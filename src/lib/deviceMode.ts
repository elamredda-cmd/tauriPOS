import { isTauri } from '@tauri-apps/api/core';
import { get, writable } from 'svelte/store';

export const DEVICE_OPERATING_MODE_SETTING_KEY = 'device_operating_mode';
export const BROWSER_PREVIEW_DEVICE_MODE_KEY = 'lbj_pos_device_operating_mode';

export type DeviceOperatingMode = 'checkout' | 'back_office';

export const deviceOperatingMode = writable<DeviceOperatingMode | null>(null);

export function normalizeDeviceOperatingMode(value: unknown): DeviceOperatingMode {
    return String(value || '').trim().toLowerCase() === 'back_office'
        ? 'back_office'
        : 'checkout';
}

export function deviceOperatingModeLabel(mode: DeviceOperatingMode | null | undefined): string {
    return mode === 'back_office' ? 'Back Office' : 'Checkout Till';
}

export function isBackOfficeBlockedPath(pathname: string): boolean {
    return pathname === '/customer-display'
        || pathname.startsWith('/customer-display/')
        || pathname === '/settings/customer-display'
        || pathname.startsWith('/settings/customer-display/')
        || pathname === '/settings/payments'
        || pathname.startsWith('/settings/payments/');
}

export function assertCheckoutDeviceMode(action = 'Checkout'): void {
    if (get(deviceOperatingMode) === 'back_office') {
        throw new Error(`${action} is unavailable while this computer is in Back Office mode`);
    }
}

export async function loadDeviceOperatingMode(): Promise<DeviceOperatingMode> {
    let storedValue = '';
    if (isTauri()) {
        const sqlite = await import('$lib/stores/sqlite');
        storedValue = await sqlite.getDeviceOperatingMode();
    } else if (typeof localStorage !== 'undefined') {
        storedValue = localStorage.getItem(BROWSER_PREVIEW_DEVICE_MODE_KEY) || '';
    }

    const mode = normalizeDeviceOperatingMode(storedValue);
    deviceOperatingMode.set(mode);
    return mode;
}

export async function saveDeviceOperatingMode(mode: DeviceOperatingMode): Promise<DeviceOperatingMode> {
    const normalized = normalizeDeviceOperatingMode(mode);
    if (isTauri()) {
        const sqlite = await import('$lib/stores/sqlite');
        await sqlite.setDeviceOperatingMode(normalized);
    } else if (typeof localStorage !== 'undefined') {
        localStorage.setItem(BROWSER_PREVIEW_DEVICE_MODE_KEY, normalized);
    }

    deviceOperatingMode.set(normalized);
    return normalized;
}
