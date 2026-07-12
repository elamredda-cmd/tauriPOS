import type { Setting } from '$lib/stores/db';

export type AppFontChoice = 'inter' | 'windows' | 'system' | 'readable' | 'legacy';
export type AppFontSizeChoice = 'compact' | 'normal' | 'large' | 'extra';
export type TileFontWeightChoice = 'medium' | 'strong' | 'heavy';

const FONT_STACKS: Record<AppFontChoice, string> = {
    inter: '"Segoe UI", Tahoma, Arial, sans-serif',
    windows: '"Segoe UI", Tahoma, Arial, sans-serif',
    system: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    readable: 'Verdana, Arial, "Segoe UI", sans-serif',
    legacy: 'Tahoma, Verdana, "Segoe UI", Arial, sans-serif',
};

const MONO_FONT_STACK = '"Cascadia Mono", Consolas, "Courier New", monospace';

export const appFontOptions: Array<{ value: AppFontChoice; label: string; note: string }> = [
    {
        value: 'inter',
        label: 'L&Bj default',
        note: 'Stable Windows fonts without missing-font substitution.',
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
        note: 'Verdana with wider letters for easier reading at a distance.',
    },
    {
        value: 'legacy',
        label: 'Legacy POS crisp',
        note: 'Tahoma/Verdana for low-resolution and older Windows tills.',
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
const TILE_NAME_SIZE_BY_VALUE: Record<AppFontSizeChoice, number> = {
    compact: 11,
    normal: 13,
    large: 15,
    extra: 17,
};
const TILE_PRICE_SIZE_BY_VALUE: Record<AppFontSizeChoice, number> = {
    compact: 10,
    normal: 12,
    large: 14,
    extra: 16,
};
const TILE_WEIGHT_BY_VALUE: Record<TileFontWeightChoice, number> = {
    medium: 600,
    strong: 700,
    heavy: 800,
};

export const tileFontWeightOptions: Array<{ value: TileFontWeightChoice; label: string; weight: number }> = [
    { value: 'medium', label: 'Medium', weight: 600 },
    { value: 'strong', label: 'Strong', weight: 700 },
    { value: 'heavy', label: 'Heavy', weight: 800 },
];

function setting(settings: Setting[], key: string, fallback = ''): string {
    return settings.find((item) => item.key === key)?.value || fallback;
}

export function normalizeAppFontChoice(value: string): AppFontChoice {
    return appFontOptions.some((option) => option.value === value)
        ? value as AppFontChoice
        : 'inter';
}

export function appFontFamily(value: string): string {
    return FONT_STACKS[normalizeAppFontChoice(value)];
}

export function normalizeAppFontSizeChoice(value: string, fallback: AppFontSizeChoice = 'normal'): AppFontSizeChoice {
    return appFontSizeOptions.some((option) => option.value === value)
        ? value as AppFontSizeChoice
        : fallback;
}

export function normalizeTileFontWeight(value: string): TileFontWeightChoice {
    return tileFontWeightOptions.some((option) => option.value === value)
        ? value as TileFontWeightChoice
        : 'strong';
}

function sizePx(settings: Setting[], key: string, fallback: AppFontSizeChoice): number {
    const value = normalizeAppFontSizeChoice(setting(settings, key, fallback), fallback);
    return SIZE_BY_VALUE.get(value) || SIZE_BY_VALUE.get(fallback) || 16;
}

export function applyTypography(settings: Setting[]): void {
    if (typeof document === 'undefined') return;

    const fontChoice = normalizeAppFontChoice(setting(settings, 'ui_font_family', 'inter'));
    const fontFamily = appFontFamily(fontChoice);
    const root = document.documentElement;
    const body = document.body;
    for (const target of [root, body]) {
        target?.classList.remove(...FONT_CLASSES);
        target?.classList.add(`font-ui-${fontChoice}`);
    }
    root.dataset.appFont = fontChoice;
    if (body) body.dataset.appFont = fontChoice;
    root.style.setProperty('--app-font-main', fontFamily);
    root.style.setProperty('--app-font-heading', fontFamily);
    root.style.setProperty('--app-font-mono', MONO_FONT_STACK);
    root.style.setProperty('--font-size-pos', `${sizePx(settings, 'ui_font_size_pos', 'normal')}px`);
    root.style.setProperty('--font-size-management', `${sizePx(settings, 'ui_font_size_management', 'normal')}px`);
    root.style.setProperty('--font-size-settings', `${sizePx(settings, 'ui_font_size_settings', 'normal')}px`);
    root.style.setProperty('--font-size-modal', `${sizePx(settings, 'ui_font_size_modal', 'normal')}px`);
    const tileNameSize = normalizeAppFontSizeChoice(setting(settings, 'ui_font_size_tile_name', 'normal'));
    const tilePriceSize = normalizeAppFontSizeChoice(setting(settings, 'ui_font_size_tile_price', 'normal'));
    const tileWeight = normalizeTileFontWeight(setting(settings, 'ui_font_weight_tiles', 'strong'));
    root.style.setProperty('--font-size-pos-tile-name', `${TILE_NAME_SIZE_BY_VALUE[tileNameSize]}px`);
    root.style.setProperty('--font-size-pos-tile-price', `${TILE_PRICE_SIZE_BY_VALUE[tilePriceSize]}px`);
    root.style.setProperty('--font-weight-pos-tile', String(TILE_WEIGHT_BY_VALUE[tileWeight]));
}
