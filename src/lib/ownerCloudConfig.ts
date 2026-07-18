import { getAll } from '$lib/stores/database';

export const OWNER_CLOUD_SETTING_KEYS = {
    enabled: 'owner_cloud_enabled',
    reporterEmail: 'owner_cloud_reporter_email',
    reporterPassword: 'owner_cloud_reporter_password',
    pairingCode: 'owner_cloud_pairing_code',
} as const;

export interface OwnerCloudConfig {
    enabled: boolean;
    reporterEmail: string;
    reporterPassword: string;
    pairingCode: string;
}

export async function getOwnerCloudConfig(): Promise<OwnerCloudConfig> {
    const keys = Object.values(OWNER_CLOUD_SETTING_KEYS);
    const keySet = new Set<string>(keys);
    const rows = (await getAll('settings')).filter(row => keySet.has(String(row.key)));
    const values = new Map(rows.map(row => [String(row.key), String(row.value || '')]));
    return {
        enabled: values.get(OWNER_CLOUD_SETTING_KEYS.enabled) === '1',
        reporterEmail: values.get(OWNER_CLOUD_SETTING_KEYS.reporterEmail)?.trim() || '',
        reporterPassword: values.get(OWNER_CLOUD_SETTING_KEYS.reporterPassword) || '',
        pairingCode: values.get(OWNER_CLOUD_SETTING_KEYS.pairingCode)?.trim() || '',
    };
}

export function isOwnerCloudConfigured(config: OwnerCloudConfig): boolean {
    return Boolean(config.enabled && config.reporterEmail && config.reporterPassword && config.pairingCode);
}
