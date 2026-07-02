import type { Setting } from '$lib/stores/db';

export type AppFontChoice = 'inter' | 'windows' | 'system' | 'readable';
export type AppFontSizeChoice = 'compact' | 'normal' | 'large' | 'extra';

export const appFontOptions: Array<{ value: AppFontChoice; label: string; note: string }> = [
    {
        value: 'inter',
        label: 'L&Bj default',
        note: 'Inter for the app and Outfit for headings.',
    },
    {
        value: 'windows',
        label: 'Windows native',
        note: 'Segoe UI, the native Windows POS font.',
    },
    {
        value: 'system',
        label: 'System default',
        note: 'Uses the best font from the operating system.',
    },
    {
        value: 'readable',
        label: 'Large readable',
        note: 'Arial/Helvetica with wider letters for older tills.',
    },
];

export const appFontSizeOptions: Array<{ value: AppFontSizeChoice; label: string; px: number }> = [
    { value: 'compact', label: 'Compact', px: 14 },
    { value: 'normal', label: 'Normal', px: 16 },
    { value: 'large', label: 'Large', px: 18 },
    { value: 'extra', label: 'Extra large', px: 20 },
];

const FONT_CLASSES = appFontOptions.map((option) => `font-ui-${option.value}`);
const SIZE_BY_VALUE = new Map(appFontSizeOptions.map((option) => [option.value, option.px]));

function setting(settings: Setting[], key: string, fallback = ''): string {
    return settings.find((item) => item.key === key)?.value || fallback;
}

function normalizeFont(value: string): AppFontChoice {
    return appFontOptions.some((option) => option.value === value)
        ? value as AppFontChoice
        : 'inter';
}

function normalizeSize(value: string, fallback: AppFontSizeChoice): AppFontSizeChoice {
    return appFontSizeOptions.some((option) => option.value === value)
        ? value as AppFontSizeChoice
        : fallback;
}

function sizePx(settings: Setting[], key: string, fallback: AppFontSizeChoice): number {
    const value = normalizeSize(setting(settings, key, fallback), fallback);
    return SIZE_BY_VALUE.get(value) || SIZE_BY_VALUE.get(fallback) || 16;
}

export function applyTypography(settings: Setting[]): void {
    if (typeof document === 'undefined') return;

    const fontChoice = normalizeFont(setting(settings, 'ui_font_family', 'inter'));
    document.body.classList.remove(...FONT_CLASSES);
    document.body.classList.add(`font-ui-${fontChoice}`);

    const root = document.documentElement;
    root.style.setProperty('--font-size-pos', `${sizePx(settings, 'ui_font_size_pos', 'normal')}px`);
    root.style.setProperty('--font-size-management', `${sizePx(settings, 'ui_font_size_management', 'normal')}px`);
    root.style.setProperty('--font-size-settings', `${sizePx(settings, 'ui_font_size_settings', 'normal')}px`);
    root.style.setProperty('--font-size-modal', `${sizePx(settings, 'ui_font_size_modal', 'normal')}px`);
}
