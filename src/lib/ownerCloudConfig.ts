import { invoke, isTauri } from '@tauri-apps/api/core';
import { ensureSharedSettingValue, getAll, remove } from '$lib/stores/database';
import { settingsDB } from '$lib/stores/db';

export const OWNER_CLOUD_SETTING_KEYS = {
    enabled: 'owner_cloud_enabled',
    reporterEmail: 'owner_cloud_reporter_email',
    reporterPassword: 'owner_cloud_reporter_password',
    pairingCode: 'owner_cloud_pairing_code',
} as const;
export const OWNER_CLOUD_ACTIVATION_EVENT = 'owner-cloud-activation-requested';

export interface OwnerCloudConfig {
    enabled: boolean;
    reporterEmail: string;
    reporterPassword: string;
    pairingCode: string;
}

async function protectedReporterPassword(legacyPassword: string): Promise<string> {
    if (!isTauri()) return legacyPassword;
    try {
        let protectedPassword = await invoke<string>('owner_cloud_get_reporter_secret');
        if (!protectedPassword && legacyPassword) {
            await invoke('owner_cloud_store_reporter_secret', { secret: legacyPassword });
            protectedPassword = legacyPassword;
        }
        if (legacyPassword && protectedPassword) {
            await remove('settings', OWNER_CLOUD_SETTING_KEYS.reporterPassword, 'key');
            settingsDB.update(rows => rows.filter(row => row.key !== OWNER_CLOUD_SETTING_KEYS.reporterPassword));
        }
        return protectedPassword;
    } catch (error) {
        console.warn('owner cloud: system credential store is unavailable', error);
        return legacyPassword;
    }
}

export async function getOwnerCloudConfig(): Promise<OwnerCloudConfig> {
    const keys = Object.values(OWNER_CLOUD_SETTING_KEYS);
    const keySet = new Set<string>(keys);
    const rows = (await getAll('settings')).filter(row => keySet.has(String(row.key)));
    const values = new Map(rows.map(row => [String(row.key), String(row.value || '')]));
    const legacyPassword = values.get(OWNER_CLOUD_SETTING_KEYS.reporterPassword) || '';
    return {
        enabled: values.get(OWNER_CLOUD_SETTING_KEYS.enabled) === '1',
        reporterEmail: values.get(OWNER_CLOUD_SETTING_KEYS.reporterEmail)?.trim() || '',
        reporterPassword: await protectedReporterPassword(legacyPassword),
        pairingCode: values.get(OWNER_CLOUD_SETTING_KEYS.pairingCode)?.trim() || '',
    };
}

export async function shouldStartOwnerCloudReporter(): Promise<boolean> {
    const keys = new Set<string>([
        OWNER_CLOUD_SETTING_KEYS.enabled,
        OWNER_CLOUD_SETTING_KEYS.pairingCode,
        OWNER_CLOUD_SETTING_KEYS.reporterPassword,
    ]);
    const rows = (await getAll('settings')).filter(row => keys.has(String(row.key)));
    const legacyPassword = rows.find(row => row.key === OWNER_CLOUD_SETTING_KEYS.reporterPassword)?.value || '';
    if (legacyPassword) await protectedReporterPassword(String(legacyPassword));
    return rows.some(row => (
        (row.key === OWNER_CLOUD_SETTING_KEYS.enabled && String(row.value) === '1')
        || (row.key === OWNER_CLOUD_SETTING_KEYS.pairingCode && Boolean(String(row.value || '').trim()))
    ));
}

export function isOwnerCloudConfigured(config: OwnerCloudConfig): boolean {
    return Boolean(config.enabled && config.reporterEmail && config.reporterPassword && config.pairingCode);
}

function createPairingCode(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

export async function getOrCreateOwnerAppPairingCode(): Promise<string> {
    const config = await getOwnerCloudConfig();
    if (config.pairingCode) {
        if (typeof window !== 'undefined') window.dispatchEvent(new Event(OWNER_CLOUD_ACTIVATION_EVENT));
        return config.pairingCode;
    }
    const pairingCode = await ensureSharedSettingValue(
        OWNER_CLOUD_SETTING_KEYS.pairingCode,
        createPairingCode(),
    );
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(OWNER_CLOUD_ACTIVATION_EVENT));
    return pairingCode;
}
