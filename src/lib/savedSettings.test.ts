import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
const { persist, notify } = vi.hoisted(() => ({ persist: vi.fn(), notify: vi.fn() }));
vi.mock('$lib/stores/database', () => ({ saveSettingsBatch: persist }));
vi.mock('$lib/stores/toast', () => ({ toast: notify }));
vi.mock('$app/environment', () => ({ browser: false }));
import { settingsDB } from '$lib/stores/db';
import { saveSetting, saveSettingsValues } from './savedSettings';

describe('confirmed-only settings UI', () => {
    beforeEach(() => { persist.mockReset(); notify.mockReset(); settingsDB.set([{ key: 'font', value: 'old', updatedAt: 'before' }]); });
    it('retains saved state and presents an error when persistence rejects', async () => {
        persist.mockRejectedValueOnce(Error('blocked'));
        expect(await saveSetting('font', 'new')).toBe(false);
        expect(get(settingsDB)[0].value).toBe('old');
        expect(notify).toHaveBeenCalledWith(expect.stringContaining('previous saved value is kept'), 'error');
    });
    it('submits coherent printer values as a single batch', async () => {
        persist.mockResolvedValueOnce(undefined);
        expect(await saveSettingsValues({ connection: 'usb_raw', protocol: 'escpos' })).toBe(true);
        expect(persist).toHaveBeenCalledTimes(1);
        expect(persist.mock.calls[0][0]).toEqual([
            expect.objectContaining({ key: 'connection', value: 'usb_raw' }),
            expect.objectContaining({ key: 'protocol', value: 'escpos' }),
        ]);
        expect(notify).not.toHaveBeenCalled();
    });
    it('does not publish an optimistic font while a save is pending', async () => {
        let finish!: () => void;
        persist.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
        const pending = saveSetting('font', 'new');
        await Promise.resolve(); await Promise.resolve();
        expect(get(settingsDB)[0].value).toBe('old');
        finish(); await pending;
    });
});
