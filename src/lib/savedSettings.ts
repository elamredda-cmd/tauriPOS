import { settingsDB, now } from '$lib/stores/db';
import { saveSettingsBatch } from '$lib/stores/database';
import { toast } from '$lib/stores/toast';
import { createSettingsWriteQueue } from '$lib/settingsWriteQueue';

const run = createSettingsWriteQueue();

/** Publish only confirmed local persistence; failures never display a false saved value. */
export function saveSetting(key: string, value: string): Promise<boolean> {
    return saveSettingsValues({ [key]: value });
}

export function saveSettingsValues(values: Record<string, string>): Promise<boolean> {
    const submitted = { ...values };
    return run('settings', async () => {
        const rows = Object.entries(submitted).map(([key, value]) => ({ key, value, updatedAt: now() }));
        try {
            await saveSettingsBatch(rows);
            return true;
        } catch (error) {
            settingsDB.update(settings => [...settings]);
            toast(`Setting was not saved. Your previous saved value is kept. ${String(error)}`, 'error');
            return false;
        }
    });
}
