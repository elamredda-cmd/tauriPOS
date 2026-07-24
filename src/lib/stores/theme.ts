import { writable } from 'svelte/store';
import { settingsDB, now } from './db';
import { upsert } from './sqlite';

export type Theme = 'midnight' | 'forest' | 'snow' | 'linen' | 'coffee' | 'sunset';

export const THEMES: Theme[] = ['midnight', 'forest', 'snow', 'linen', 'coffee', 'sunset'];
const THEME_KEY = 'active_theme';

export const activeTheme = writable<Theme>('midnight');

/**
 * Persist a theme choice. Updates the in-memory store, the settingsDB
 * cache, and the SQLite settings table so the choice survives reloads.
 */
export async function setTheme(id: Theme) {
    activeTheme.set(id);
    const row = { key: THEME_KEY, value: id, updatedAt: now() };
    settingsDB.update(list => {
        const idx = list.findIndex(s => s.key === THEME_KEY);
        if (idx >= 0) list[idx] = row;
        else list.push(row);
        return list;
    });
    try {
        await upsert('settings', row, 'key');
    } catch (e) {
        console.error('Failed to persist theme:', e);
    }
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
