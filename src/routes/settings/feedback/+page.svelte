<script lang="ts">
    import { onMount } from 'svelte';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import { now, settingsDB } from '$lib/stores/db';
    import { upsert } from '$lib/stores/database';
    import {
        playCartButtonFeedback,
        playErrorSound,
        playHapticFeedback,
        playItemAddedSound,
        playScanSuccessSound,
        playSuccessSound,
        supportsHapticFeedback,
    } from '$lib/sounds';

    $: buttonSoundEnabled = ($settingsDB.find(s => s.key === 'feedback_button_sound_enabled')?.value ?? 'true') !== 'false';
    $: itemSoundEnabled = ($settingsDB.find(s => s.key === 'feedback_item_sound_enabled')?.value ?? 'true') !== 'false';
    $: scanSoundEnabled = ($settingsDB.find(s => s.key === 'feedback_scan_sound_enabled')?.value ?? 'true') !== 'false';
    $: hapticsEnabled = ($settingsDB.find(s => s.key === 'feedback_haptics_enabled')?.value ?? 'true') !== 'false';
    $: saleSoundEnabled = ($settingsDB.find(s => s.key === 'feedback_sale_sound_enabled')?.value ?? 'true') !== 'false';
    $: barcodeErrorSound = $settingsDB.find(s => s.key === 'barcode_error_sound')?.value || 'vintage';
    let hapticsSupported = false;

    onMount(() => {
        hapticsSupported = supportsHapticFeedback();
    });

    const barcodeAlertOptions = [
        { id: 'vintage', name: 'Vintage Ring', detail: 'Mechanical telephone bell' },
        { id: 'busy', name: 'Busy Line', detail: 'Three telephone pulses' },
        { id: 'beep', name: 'Warning Beep', detail: 'Short two-tone warning' },
        { id: 'silent', name: 'Silent', detail: 'Visual warning only' },
    ];

    function switchCardClass(active: boolean): string {
        return [
            'relative min-h-[96px] rounded-lg border p-4 pr-16 text-left transition-colors duration-150',
            active
                ? 'border-success bg-success/10 text-text-main shadow-[0_12px_30px_var(--shadow)]'
                : 'border-border-flat bg-bg-panel text-text-main hover:border-accent-primary hover:bg-bg-card-hover',
        ].join(' ');
    }

    function alertCardClass(active: boolean): string {
        return [
            'min-h-[86px] rounded-lg border p-4 text-left transition-colors duration-150',
            active
                ? 'border-accent-primary bg-accent-primary/10 text-accent-primary shadow-[0_12px_30px_var(--shadow)]'
                : 'border-border-flat bg-bg-panel text-text-main hover:border-accent-primary hover:bg-bg-card-hover',
        ].join(' ');
    }

    async function updateSetting(key: string, value: string) {
        const row = { key, value, updatedAt: now() };
        settingsDB.update(settings => {
            const index = settings.findIndex(item => item.key === key);
            if (index >= 0) return settings.map((item, itemIndex) => itemIndex === index ? row : item);
            return [...settings, row];
        });
        await upsert('settings', row, 'key');
    }

    function setFeedbackSetting(key: string, enabled: boolean) {
        updateSetting(key, enabled ? 'true' : 'false');
    }

    function selectBarcodeErrorSound(style: string) {
        updateSetting('barcode_error_sound', style);
        if (style !== 'silent') setTimeout(playErrorSound, 0);
    }
</script>

<MgmtPage title="Sound & Haptics" backFallback="/settings">
    <div slot="actions" class="flex flex-wrap gap-3">
        <button class="btn btn-secondary" data-feedback-silent="true" on:click={playCartButtonFeedback}>Test Button Click</button>
        <button class="btn btn-secondary" data-feedback-silent="true" on:click={playItemAddedSound}>Test Item Added</button>
        <button class="btn btn-secondary" data-feedback-silent="true" on:click={playScanSuccessSound}>Test Scan</button>
        <button class="btn btn-secondary" data-feedback-silent="true" on:click={playSuccessSound}>Test Sale Complete</button>
        <button class="btn btn-secondary" data-feedback-silent="true" disabled={!hapticsSupported || !hapticsEnabled} on:click={playHapticFeedback}>Test Vibration</button>
    </div>

    <div class="settings-page-shell">
        <section class="settings-hero">
            <p class="settings-hero-kicker">Operator feedback</p>
            <h2 class="settings-hero-title">Fast feedback without slowing the till</h2>
            <p class="settings-hero-copy">
                These controls decide what the cashier hears or feels when buttons are pressed, items are added, barcodes are scanned, sales complete, or a barcode fails.
            </p>
        </section>

        <section class="settings-section">
            <h3 class="settings-section-title">Button and Sale Feedback</h3>
            <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
                <button class={switchCardClass(buttonSoundEnabled)} on:click={() => setFeedbackSetting('feedback_button_sound_enabled', !buttonSoundEnabled)}>
                    <span class="font-extrabold">Button click sound</span>
                    <small class="mt-1 block text-text-muted">Short click on enabled buttons and links.</small>
                    <b class="absolute right-4 top-1/2 -translate-y-1/2 text-xs uppercase tracking-[0.12em] {buttonSoundEnabled ? 'text-success' : 'text-text-muted'}">{buttonSoundEnabled ? 'On' : 'Off'}</b>
                </button>
                <button class={switchCardClass(itemSoundEnabled)} on:click={() => setFeedbackSetting('feedback_item_sound_enabled', !itemSoundEnabled)}>
                    <span class="font-extrabold">Item-added sound</span>
                    <small class="mt-1 block text-text-muted">Confirmation when an item is added using a tile, goods, or scale control.</small>
                    <b class="absolute right-4 top-1/2 -translate-y-1/2 text-xs uppercase tracking-[0.12em] {itemSoundEnabled ? 'text-success' : 'text-text-muted'}">{itemSoundEnabled ? 'On' : 'Off'}</b>
                </button>
                <button class={switchCardClass(scanSoundEnabled)} on:click={() => setFeedbackSetting('feedback_scan_sound_enabled', !scanSoundEnabled)}>
                    <span class="font-extrabold">Successful barcode scan sound</span>
                    <small class="mt-1 block text-text-muted">One short confirmation after a barcode successfully adds an item.</small>
                    <b class="absolute right-4 top-1/2 -translate-y-1/2 text-xs uppercase tracking-[0.12em] {scanSoundEnabled ? 'text-success' : 'text-text-muted'}">{scanSoundEnabled ? 'On' : 'Off'}</b>
                </button>
                <button class={switchCardClass(hapticsSupported && hapticsEnabled)} disabled={!hapticsSupported} on:click={() => setFeedbackSetting('feedback_haptics_enabled', !hapticsEnabled)}>
                    <span class="font-extrabold">Haptic vibration</span>
                    <small class="mt-1 block text-text-muted">{hapticsSupported ? 'Vibration on this supported device.' : 'This till does not expose vibration hardware to the app.'}</small>
                    <b class="absolute right-4 top-1/2 -translate-y-1/2 text-xs uppercase tracking-[0.12em] {hapticsSupported && hapticsEnabled ? 'text-success' : 'text-text-muted'}">{hapticsSupported ? (hapticsEnabled ? 'On' : 'Off') : 'Unavailable'}</b>
                </button>
                <button class={switchCardClass(saleSoundEnabled)} on:click={() => setFeedbackSetting('feedback_sale_sound_enabled', !saleSoundEnabled)}>
                    <span class="font-extrabold">Sale-completed sound</span>
                    <small class="mt-1 block text-text-muted">Confirmation chime when payment finishes.</small>
                    <b class="absolute right-4 top-1/2 -translate-y-1/2 text-xs uppercase tracking-[0.12em] {saleSoundEnabled ? 'text-success' : 'text-text-muted'}">{saleSoundEnabled ? 'On' : 'Off'}</b>
                </button>
            </div>
        </section>

        <section class="settings-section">
            <div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div>
                    <h3 class="settings-section-title">Failed Barcode Alert</h3>
                    <p class="mb-4 text-sm text-text-muted">Choose the sound that gets the operator's attention when the barcode is not found.</p>
                </div>
                <button class="btn btn-secondary" data-feedback-silent="true" on:click={playErrorSound} disabled={barcodeErrorSound === 'silent'}>Test Barcode Alert</button>
            </div>
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {#each barcodeAlertOptions as option}
                    <button class={alertCardClass(barcodeErrorSound === option.id)} data-feedback-silent="true" on:click={() => selectBarcodeErrorSound(option.id)}>
                        <strong class="block">{option.name}</strong>
                        <small class="mt-1 block text-text-muted">{option.detail}</small>
                    </button>
                {/each}
            </div>
        </section>
    </div>
</MgmtPage>
