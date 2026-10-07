import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const themeMocks = vi.hoisted(() => ({
    isTauri: vi.fn(() => false),
    upsert: vi.fn(async (_table: string, _row: unknown, _key: string): Promise<void> => {}),
}));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: themeMocks.isTauri }));
vi.mock('./database', () => ({ upsert: themeMocks.upsert }));

import { settingsDB } from './db';
import { activeTheme, hydrateTheme, setTheme, THEMES, type Theme } from './theme';

const savedAt = '2026-09-08T10:00:00.000Z';
const originalThemeRow = { key: 'active_theme', value: 'sage', updatedAt: '2026-09-07T10:00:00.000Z' };
const otherSetting = { key: 'store_name', value: 'Test shop', updatedAt: savedAt };

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(savedAt));
    themeMocks.isTauri.mockReturnValue(false);
    themeMocks.upsert.mockReset().mockResolvedValue(undefined);
    activeTheme.set('sage');
    settingsDB.set([otherSetting, originalThemeRow]);
});

afterEach(() => {
    vi.useRealTimers();
    activeTheme.set('midnight');
    settingsDB.set([]);
});

describe('theme registry and hydration', () => {
    it('includes Daylight exactly once without duplicate theme IDs', () => {
        expect(THEMES.filter(id => id === 'daylight')).toHaveLength(1);
        expect(new Set(THEMES).size).toBe(THEMES.length);
    });

    it.each(THEMES)('restores the saved %s theme without writing to the database', (id) => {
        hydrateTheme([{ key: 'active_theme', value: id }]);
        expect(get(activeTheme)).toBe(id);
        expect(themeMocks.upsert).not.toHaveBeenCalled();
    });

    it.each(['unknown', 'Daylight', '', 'theme-daylight'])('ignores invalid saved ID %j', (id) => {
        hydrateTheme([{ key: 'active_theme', value: id }]);
        expect(get(activeTheme)).toBe('sage');
    });

    it('keeps the current theme when no active-theme setting exists', () => {
        hydrateTheme([{ key: 'other_setting', value: 'daylight' }]);
        expect(get(activeTheme)).toBe('sage');
    });

    it.each([true, false])('rejects an invalid selection before writes in native=%s mode', async (native) => {
        themeMocks.isTauri.mockReturnValue(native);
        await expect(setTheme('unknown' as Theme)).rejects.toThrow('Choose a valid colour theme');
        expect(themeMocks.upsert).not.toHaveBeenCalled();
        expect(get(activeTheme)).toBe('sage');
        expect(get(settingsDB)).toEqual([otherSetting, originalThemeRow]);
    });
});

describe('theme persistence', () => {
    it('persists one native settings write and then updates the active theme and cache', async () => {
        themeMocks.isTauri.mockReturnValue(true);
        themeMocks.upsert.mockImplementation(async () => {
            expect(get(activeTheme)).toBe('sage');
            expect(get(settingsDB)).toEqual([otherSetting, originalThemeRow]);
        });

        await setTheme('daylight');

        const row = { key: 'active_theme', value: 'daylight', updatedAt: savedAt };
        expect(themeMocks.upsert).toHaveBeenCalledExactlyOnceWith('settings', row, 'key');
        expect(get(activeTheme)).toBe('daylight');
        expect(get(settingsDB)).toEqual([otherSetting, row]);
    });

    it('preserves both active theme and cached settings when native persistence fails', async () => {
        themeMocks.isTauri.mockReturnValue(true);
        const failure = new Error('The settings write failed');
        themeMocks.upsert.mockRejectedValueOnce(failure);

        await expect(setTheme('daylight')).rejects.toBe(failure);

        expect(themeMocks.upsert).toHaveBeenCalledTimes(1);
        expect(get(activeTheme)).toBe('sage');
        expect(get(settingsDB)).toEqual([otherSetting, originalThemeRow]);
    });

    it('can retry a failed native write without duplicating the cached theme row', async () => {
        themeMocks.isTauri.mockReturnValue(true);
        themeMocks.upsert.mockRejectedValueOnce(new Error('Temporary error'));
        await expect(setTheme('daylight')).rejects.toThrow('Temporary error');
        await setTheme('daylight');

        expect(themeMocks.upsert).toHaveBeenCalledTimes(2);
        expect(get(settingsDB).filter(row => row.key === 'active_theme')).toEqual([
            { key: 'active_theme', value: 'daylight', updatedAt: savedAt },
        ]);
        expect(get(activeTheme)).toBe('daylight');
    });

    it('applies browser previews in memory without invoking native writes', async () => {
        await setTheme('daylight');

        expect(themeMocks.upsert).not.toHaveBeenCalled();
        expect(get(activeTheme)).toBe('daylight');
        expect(get(settingsDB)).toEqual([
            otherSetting,
            { key: 'active_theme', value: 'daylight', updatedAt: savedAt },
        ]);
    });

    it.each([true, false])('inserts one missing theme row and replaces it on subsequent choices in native=%s mode', async (native) => {
        themeMocks.isTauri.mockReturnValue(native);
        settingsDB.set([otherSetting]);
        await setTheme('daylight');
        await setTheme('linen');
        await setTheme('daylight');

        expect(get(settingsDB)).toEqual([
            otherSetting,
            { key: 'active_theme', value: 'daylight', updatedAt: savedAt },
        ]);
        expect(themeMocks.upsert).toHaveBeenCalledTimes(native ? 3 : 0);
    });
});
