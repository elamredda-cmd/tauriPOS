<script lang="ts">
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import { settingsDB, now, type Setting } from '$lib/stores/db';
    import { upsert } from '$lib/stores/database';
    import { toast } from '$lib/stores/toast';
    import {
        appFontFamily,
        appFontOptions,
        appFontSizeOptions,
        normalizeAppFontChoice,
        normalizeAppFontSizeChoice,
        type AppFontChoice,
        type AppFontSizeChoice,
    } from '$lib/typography';

    type SizeSection = {
        label: string;
        key: string;
        value: AppFontSizeChoice;
        note: string;
    };

    let pendingSettings: Record<string, string> = {};

    function settingValue(settings: Setting[], pending: Record<string, string>, key: string, fallback = ''): string {
        return pending[key] ?? settings.find((item) => item.key === key)?.value ?? fallback;
    }

    $: selectedAppFont = normalizeAppFontChoice(settingValue($settingsDB, pendingSettings, 'ui_font_family', 'inter'));
    $: selectedFontOption = appFontOptions.find((option) => option.value === selectedAppFont) || appFontOptions[0];
    $: fontSizeSections = [
        {
            label: 'POS selling screen',
            key: 'ui_font_size_pos',
            value: normalizeAppFontSizeChoice(settingValue($settingsDB, pendingSettings, 'ui_font_size_pos', 'normal')),
            note: 'Product tiles, cart, checkout controls.',
        },
        {
            label: 'Management pages',
            key: 'ui_font_size_management',
            value: normalizeAppFontSizeChoice(settingValue($settingsDB, pendingSettings, 'ui_font_size_management', 'normal')),
            note: 'Items, reports, customers, stock screens.',
        },
        {
            label: 'Settings pages',
            key: 'ui_font_size_settings',
            value: normalizeAppFontSizeChoice(settingValue($settingsDB, pendingSettings, 'ui_font_size_settings', 'normal')),
            note: 'Settings pages and setup controls.',
        },
        {
            label: 'Dialogs and popups',
            key: 'ui_font_size_modal',
            value: normalizeAppFontSizeChoice(settingValue($settingsDB, pendingSettings, 'ui_font_size_modal', 'normal')),
            note: 'Numpads, payment dialogs, edit popups.',
        },
    ] satisfies SizeSection[];

    function selectedSizeLabel(value: AppFontSizeChoice): string {
        return appFontSizeOptions.find((option) => option.value === value)?.label || 'Normal';
    }

    function fontPreviewStyle(value: AppFontChoice): string {
        return `font-family: ${appFontFamily(value)}`;
    }

    function fontCardClass(active: boolean): string {
        return [
            'relative min-h-[148px] rounded-xl border p-4 pr-12 text-left transition-all duration-150',
            active
                ? 'border-accent-primary bg-accent-primary text-white shadow-[0_14px_34px_var(--shadow)] ring-2 ring-accent-primary/35'
                : 'border-border-flat bg-bg-panel text-text-main hover:border-accent-primary hover:bg-bg-card-hover',
        ].join(' ');
    }

    function fontCardMutedClass(active: boolean): string {
        return active ? 'text-white/80' : 'text-text-muted';
    }

    function sizeButtonClass(current: AppFontSizeChoice, option: AppFontSizeChoice): string {
        return [
            'min-h-12 rounded-lg border px-3 py-2 text-sm font-black transition-all',
            current === option
                ? 'border-accent-primary bg-accent-primary text-white shadow-[0_10px_24px_var(--shadow)]'
                : 'border-border-flat bg-bg-panel text-text-main hover:border-accent-primary hover:bg-bg-card-hover',
        ].join(' ');
    }

    function markPending(key: string, value: string) {
        pendingSettings = { ...pendingSettings, [key]: value };
    }

    function clearPending(key: string) {
        const next = { ...pendingSettings };
        delete next[key];
        pendingSettings = next;
    }

    function restorePreviousSetting(key: string, previous: Setting | undefined) {
        settingsDB.update((settings) => {
            if (!previous) return settings.filter((item) => item.key !== key);
            const index = settings.findIndex((item) => item.key === key);
            if (index >= 0) return settings.map((item) => item.key === key ? previous : item);
            return [...settings, previous];
        });
    }

    async function updateSetting(key: string, value: string) {
        const previous = $settingsDB.find((item) => item.key === key);
        const row = { key, value, updatedAt: now() };
        markPending(key, value);
        settingsDB.update((settings) => {
            const index = settings.findIndex((item) => item.key === key);
            if (index >= 0) return settings.map((item) => item.key === key ? row : item);
            return [...settings, row];
        });

        try {
            await upsert('settings', row, 'key');
        } catch (error) {
            console.error(`Could not save ${key}:`, error);
            restorePreviousSetting(key, previous);
            toast('Could not save the font setting', 'error');
        } finally {
            clearPending(key);
        }
    }
</script>

<MgmtPage title="Fonts & Text Size" backFallback="/settings">
    <div class="settings-page-shell">
        <section class="settings-section">
            <div class="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                <div>
                    <p class="settings-hero-kicker">Appearance</p>
                    <h3 class="settings-section-title !mb-2">Writing Style</h3>
                    <p class="m-0 max-w-[760px] text-sm text-text-muted">
                        Choose the font used across the POS, cart, management screens, buttons, inputs, and popups.
                    </p>
                </div>
                <div class="rounded-xl border border-accent-primary bg-accent-primary/10 px-4 py-3 text-sm">
                    <span class="block text-xs font-black uppercase tracking-[0.14em] text-accent-primary">Currently used</span>
                    <strong class="mt-1 block text-text-main">{selectedFontOption.label}</strong>
                    <span class="text-text-muted">The highlight follows this selected option.</span>
                </div>
            </div>
        </section>

        <section class="settings-section">
            <div class="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                    <h3 class="settings-section-title !mb-1">Font Family</h3>
                    <p class="m-0 text-sm text-text-muted">Tap one tile. The selected tile should move immediately.</p>
                </div>
                <div class="rounded-xl border border-border-flat bg-bg-panel px-4 py-3 text-right" style={fontPreviewStyle(selectedAppFont)}>
                    <span class="block text-xs font-black uppercase tracking-[0.14em] text-text-muted">Preview</span>
                    <strong class="block text-2xl">Aa 123</strong>
                </div>
            </div>

            <div class="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
                {#each appFontOptions as option}
                    {@const active = selectedAppFont === option.value}
                    <button
                        type="button"
                        class={fontCardClass(active)}
                        aria-pressed={active}
                        on:click={() => updateSetting('ui_font_family', option.value)}
                    >
                        <span class="block text-xs font-black uppercase tracking-[0.12em] {active ? 'text-white/85' : 'text-accent-primary'}">
                            {active ? 'In use' : 'Choose'}
                        </span>
                        <span class="mt-3 block text-2xl font-black" style={fontPreviewStyle(option.value)}>Aa 123</span>
                        <span class="mt-3 block text-lg font-extrabold">{option.label}</span>
                        <small class="mt-1 block {fontCardMutedClass(active)}">{option.note}</small>
                        {#if active}
                            <span class="absolute right-4 top-4 grid h-8 w-8 place-items-center rounded-full bg-white text-accent-primary">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" width="16" aria-hidden="true">
                                    <polyline points="20 6 9 17 4 12"></polyline>
                                </svg>
                            </span>
                        {/if}
                    </button>
                {/each}
            </div>
        </section>

        <section class="settings-section">
            <div class="mb-4 flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
                <div>
                    <h3 class="settings-section-title !mb-1">Section Text Sizes</h3>
                    <p class="m-0 text-sm text-text-muted">Each row has its own selected size. The active button should move as soon as you tap it.</p>
                </div>
            </div>

            <div class="grid grid-cols-1 gap-3 xl:grid-cols-2">
                {#each fontSizeSections as section}
                    <div class="rounded-xl border border-border-flat bg-bg-panel p-4">
                        <div class="mb-3 flex items-start justify-between gap-3">
                            <div>
                                <span class="block text-base font-black text-text-main">{section.label}</span>
                                <small class="text-text-muted">{section.note}</small>
                            </div>
                            <strong class="shrink-0 rounded-full bg-accent-primary/10 px-3 py-1 text-xs font-black uppercase tracking-[0.1em] text-accent-primary">
                                {selectedSizeLabel(section.value)}
                            </strong>
                        </div>
                        <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
                            {#each appFontSizeOptions as option}
                                <button
                                    type="button"
                                    class={sizeButtonClass(section.value, option.value)}
                                    aria-pressed={section.value === option.value}
                                    on:click={() => updateSetting(section.key, option.value)}
                                >
                                    {option.label}
                                </button>
                            {/each}
                        </div>
                    </div>
                {/each}
            </div>
        </section>
    </div>
</MgmtPage>
