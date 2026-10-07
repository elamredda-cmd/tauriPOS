import { writable } from 'svelte/store';
import { isTauri } from '@tauri-apps/api/core';
import { settingsDB, now } from './db';

export type Theme = 'midnight' | 'forest' | 'snow' | 'linen' | 'sage' | 'daylight' | 'coffee' | 'sunset';

export const THEMES: Theme[] = ['midnight', 'forest', 'snow', 'linen', 'sage', 'daylight', 'coffee', 'sunset'];
const THEME_KEY = 'active_theme';

export const activeTheme = writable<Theme>('midnight');

/**
 * Save once through the normal settings/sync path before applying the choice.
 * Browser previews stay in memory and never attempt native database writes.
 */
export async function setTheme(id: Theme) {
    if (!THEMES.includes(id)) throw new Error('Choose a valid colour theme.');
    const row = { key: THEME_KEY, value: id, updatedAt: now() };
    if (isTauri()) {
        // database.ts hydrates themes: load the writer here to avoid a static cycle.
        const { upsert } = await import('./database');
        await upsert('settings', row, 'key');
    }
    settingsDB.update(list => list.some(setting => setting.key === THEME_KEY)
        ? list.map(setting => setting.key === THEME_KEY ? row : setting)
        : [...list, row]);
    activeTheme.set(id);
}

/**
 * Restore the saved theme from a hydrated settings array (called once
 * from +layout.svelte after the SQLite hydration completes).
 */
export function hydrateTheme(settings: Array<{ key: string; value: string }>) {
    const row = settings.find(s => s.key === THEME_KEY);
    if (row && THEMES.includes(row.value as Theme)) {
        activeTheme.set(row.value as Theme);
    }
}
