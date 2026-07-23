<script lang="ts">
    import { onMount } from 'svelte';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import CustomSelect from '$lib/components/CustomSelect.svelte';
    import { now, settingsDB, type Setting } from '$lib/stores/db';
    import { upsert } from '$lib/stores/database';
    import { toast } from '$lib/stores/toast';
    import {
        cctvConnectionState,
        formatCctvItemText,
        getCctvPosConfig,
        resetCctvAutomaticQueue,
        sendCctvPosText,
        suggestedCctvPort,
    } from '$lib/cctvPos';

    let statusClock = Date.now();

    $: cctvConfig = getCctvPosConfig($settingsDB);
    $: suggestedPort = suggestedCctvPort($settingsDB);
    $: tillName = settingValue($settingsDB, 'till_name', 'This till');
    $: cctvPreview = formatCctvItemText({
        name: 'Example scanned product',
        price: 249,
        quantity: 2,
        tillName,
        cashierName: 'Cashier',
    }, cctvConfig);
    $: retrySeconds = Math.max(0, Math.ceil(($cctvConnectionState.retryAt - statusClock) / 1000));

    const cctvFramingOptions = [
        { label: 'Hikvision Universal TCP', value: 'hikvision' },
        { label: 'Custom TCP text', value: 'custom' },
    ];

    const cctvLineWidthOptions = [
        { label: '24 characters - narrow', value: '24' },
        { label: '28 characters - standard', value: '28' },
        { label: '32 characters - wide', value: '32' },
    ];

    $: cctvEncodingOptions = cctvConfig.framingPreset === 'hikvision'
        ? [{ label: 'Latin-1 (required by Hikvision)', value: 'latin1' }]
        : [
            { label: 'Latin-1 / ISO-8859-1', value: 'latin1' },
            { label: 'UTF-8', value: 'utf8' },
        ];

    onMount(() => {
        const timer = setInterval(() => {
            statusClock = Date.now();
        }, 1_000);
        return () => clearInterval(timer);
    });

    function settingValue(settings: Setting[], key: string, fallback = ''): string {
        return settings.find((setting) => setting.key === key)?.value || fallback;
    }

    function switchCardClass(active: boolean): string {
        return [
            'cctv-switch relative min-h-[78px] rounded-md border p-3 pr-14 text-left',
            active
                ? 'border-success bg-success/10 text-text-main'
                : 'border-border-flat bg-bg-panel text-text-main hover:border-accent-primary hover:bg-bg-card-hover',
        ].join(' ');
    }

    async function updateSetting(key: string, value: string, restartTransport = false): Promise<boolean> {
        const previous = $settingsDB.find((setting) => setting.key === key);
        const row = { key, value, updatedAt: now() };
        settingsDB.update((settings) => {
            const index = settings.findIndex((setting) => setting.key === key);
            if (index >= 0) return settings.map((setting, itemIndex) => itemIndex === index ? row : setting);
            return [...settings, row];
        });
        try {
            await upsert('settings', row, 'key');
            if (restartTransport) {
                resetCctvAutomaticQueue('CCTV connection changed. Run a TCP test before enabling automatic output.');
            }
            return true;
        } catch (error) {
            settingsDB.update((settings) => {
                if (previous) {
                    return settings.map((setting) => setting.key === key ? previous : setting);
                }
                return settings.filter((setting) => setting.key !== key);
            });
            toast(`Could not save CCTV setting: ${String(error).replace(/^Error:\s*/, '')}`, 'error');
            return false;
        }
    }

    async function toggleCctvOverlay() {
        const enabled = !cctvConfig.enabled;
        if (enabled && !cctvConfig.host.trim()) {
            toast('Enter the DVR/NVR IP address before enabling automatic output', 'error');
            return;
        }
        if (!await updateSetting('cctv_pos_enabled', enabled ? 'true' : 'false')) return;
        if (!enabled) resetCctvAutomaticQueue();
    }

    async function saveCctvPort(input: HTMLInputElement) {
        const port = Number(input.value);
        if (!Number.isInteger(port) || port < 1 || port > 65_535) {
            input.value = String(cctvConfig.port);
            toast('CCTV port must be between 1 and 65535', 'error');
            return;
        }
        await updateSetting('cctv_pos_port', String(port), true);
    }

    async function selectFraming(value: string) {
        const preset = value === 'custom' ? 'custom' : 'hikvision';
        if (!await updateSetting('cctv_pos_framing', preset, true)) return;
        if (preset === 'hikvision' && cctvConfig.encoding !== 'latin1') {
            await updateSetting('cctv_pos_encoding', 'latin1', true);
        }
    }

    async function testCctvPosOverlay() {
        const config = getCctvPosConfig($settingsDB);
        if (!config.host.trim()) {
            toast('Enter the DVR/NVR IP address first', 'error');
            return;
        }
        try {
            const testTime = new Date().toLocaleTimeString('en-GB', {
                hour: 'numeric',
                minute: '2-digit',
                second: '2-digit',
                hour12: true,
            });
            const result = await sendCctvPosText(formatCctvItemText({
                name: `CCTV TEST ${testTime}`,
                price: 123,
                quantity: 1,
                tillName,
                cashierName: 'Test',
            }, config), config);
            toast(`TCP test sent from ${result.localAddress}. Check the camera overlay.`, 'success');
        } catch (error) {
            toast(`CCTV TCP test failed: ${String(error).replace(/^Error:\s*/, '')}`, 'error');
        }
    }

    function formatLastSent(timestamp: number): string {
        if (!timestamp) return 'Not sent yet';
        return new Date(timestamp).toLocaleTimeString('en-GB', {
            hour: 'numeric',
            minute: '2-digit',
            second: '2-digit',
            hour12: true,
        });
    }

    function addressHost(address: string): string {
        if (!address) return '';
        if (address.startsWith('[')) return address.slice(1, address.indexOf(']'));
        const separator = address.lastIndexOf(':');
        return separator > 0 ? address.slice(0, separator) : address;
    }
</script>

<MgmtPage title="CCTV Overlay" backFallback="/settings">
    <div class="cctv-page settings-page-shell !gap-4 !p-3 md:!p-4">
        <section class="settings-section !rounded-none !border-0 !bg-transparent !p-4 !shadow-none">
            <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div class="min-w-0">
                    <p class="m-0 text-xs font-black uppercase tracking-[0.12em] text-success">{tillName}</p>
                    <h2 class="settings-section-title !mb-1">Recorder connection</h2>
                    <p class="m-0 text-sm">Each till uses its own recorder port and local settings.</p>
                </div>
                <div class="flex shrink-0 flex-wrap gap-2">
                    <button
                        class="btn btn-primary !min-h-11 !px-4 !py-2 !text-sm"
                        disabled={$cctvConnectionState.status === 'sending'}
                        on:click={testCctvPosOverlay}
                    >
                        {$cctvConnectionState.status === 'sending' ? 'Sending...' : 'Send TCP Test'}
                    </button>
                    <button
                        class="btn !min-h-11 !px-4 !py-2 !text-sm {cctvConfig.enabled ? 'btn-success' : 'btn-secondary'}"
                        on:click={toggleCctvOverlay}
                    >
                        Automatic: {cctvConfig.enabled ? 'On' : 'Off'}
                    </button>
                </div>
            </div>

            <div class="cctv-form-grid form-grid mt-4">
                <div class="field">
                    <label for="cctv-host">DVR / NVR IP Address</label>
                    <input
                        id="cctv-host"
                        value={cctvConfig.host}
                        placeholder="e.g. 192.168.1.104"
                        on:change={(event) => updateSetting('cctv_pos_host', event.currentTarget.value.trim(), true)}
                    />
                </div>
                <div class="field">
                    <label for="cctv-port">Unique POS Port for {tillName}</label>
                    <input
                        id="cctv-port"
                        type="number"
                        min="1"
                        max="65535"
                        value={cctvConfig.port}
                        on:change={(event) => saveCctvPort(event.currentTarget)}
                    />
                    <div class="flex min-h-7 items-center justify-between gap-2 text-xs text-text-muted">
                        <span>Suggested for this till: {suggestedPort}</span>
                        {#if cctvConfig.port !== suggestedPort}
                            <button
                                class="font-bold text-accent-primary"
                                on:click={() => updateSetting('cctv_pos_port', String(suggestedPort), true)}
                            >Use {suggestedPort}</button>
                        {/if}
                    </div>
                </div>
                <div class="field">
                    <CustomSelect
                        label="Recorder Protocol"
                        value={cctvConfig.framingPreset}
                        options={cctvFramingOptions}
                        on:change={(event) => selectFraming(event.detail)}
                    />
                </div>
                <div class="field">
                    <CustomSelect
                        label="Overlay Line Width"
                        value={String(cctvConfig.lineWidth)}
                        options={cctvLineWidthOptions}
                        on:change={(event) => updateSetting('cctv_pos_line_width', event.detail)}
                    />
                </div>
                <div class="field">
                    {#if cctvConfig.framingPreset === 'hikvision'}
                        <span class="text-[0.8rem] font-black uppercase tracking-[0.045em] text-text-muted">Character Encoding</span>
                        <div class="cctv-readonly-value font-sans">Latin-1 (required by Hikvision)</div>
                    {:else}
                        <CustomSelect
                            label="Character Encoding"
                            value={cctvConfig.encoding}
                            options={cctvEncodingOptions}
                            on:change={(event) => updateSetting('cctv_pos_encoding', event.detail, true)}
                        />
                    {/if}
                </div>
                <div class="field">
                    <span class="text-[0.8rem] font-black uppercase tracking-[0.045em] text-text-muted">Allowed Remote IP on Recorder</span>
                    <div class="cctv-readonly-value">
                        {addressHost($cctvConnectionState.localAddress) || 'Run TCP test to detect'}
                    </div>
                </div>
            </div>

            {#if cctvConfig.framingPreset === 'custom'}
                <div class="mt-4 border-t border-border-flat pt-4">
                    <h3 class="m-0 text-sm font-black uppercase text-text-muted">Custom message framing</h3>
                    <div class="cctv-marker-grid form-grid mt-3">
                        <div class="field">
                            <label for="cctv-start-marker">Start Marker</label>
                            <input
                                id="cctv-start-marker"
                                class="font-mono"
                                value={cctvConfig.startMarker}
                                placeholder="Optional, e.g. \\x02"
                                on:change={(event) => updateSetting('cctv_pos_start_marker', event.currentTarget.value, true)}
                            />
                        </div>
                        <div class="field">
                            <label for="cctv-line-separator">Line Separator</label>
                            <input
                                id="cctv-line-separator"
                                class="font-mono"
                                value={cctvConfig.lineSeparator}
                                placeholder="\\r\\n"
                                on:change={(event) => updateSetting('cctv_pos_line_separator', event.currentTarget.value, true)}
                            />
                        </div>
                        <div class="field">
                            <label for="cctv-end-marker">End Marker</label>
                            <input
                                id="cctv-end-marker"
                                class="font-mono"
                                value={cctvConfig.endMarker}
                                placeholder="\\r\\n\\r\\n"
                                on:change={(event) => updateSetting('cctv_pos_end_marker', event.currentTarget.value, true)}
                            />
                        </div>
                    </div>
                </div>
            {/if}

            <div class="cctv-diagnostics mt-4 border-t border-border-flat pt-4">
                <div class="min-w-0">
                    <span class="mb-2 block text-xs font-extrabold uppercase text-text-muted">Camera text preview</span>
                    <pre class="m-0 overflow-x-auto whitespace-pre rounded-sm bg-black px-3 py-3 font-mono text-sm font-bold text-white">{cctvPreview}</pre>
                </div>
                <div class="min-w-0 border-border-flat md:border-l md:pl-4">
                    <div class="flex items-start justify-between gap-3">
                        <div>
                            <span class="block text-xs font-extrabold uppercase text-text-muted">TCP status</span>
                            <strong class="mt-1 block text-base text-text-main">
                                {$cctvConnectionState.status === 'online'
                                    ? 'TCP text sent'
                                    : $cctvConnectionState.status === 'offline'
                                        ? retrySeconds > 0 ? `Retry in ${retrySeconds}s` : 'Waiting to retry'
                                        : $cctvConnectionState.status === 'sending'
                                            ? 'Sending now'
                                            : 'Not tested'}
                            </strong>
                        </div>
                        <span class="rounded-sm border border-border-flat bg-bg-panel px-2 py-1 text-xs font-black">
                            {$cctvConnectionState.pending} pending
                        </span>
                    </div>
                    <p class="mt-2 text-sm">{$cctvConnectionState.message}</p>
                    <div class="mt-3 grid grid-cols-2 gap-2 text-xs text-text-muted">
                        <span>Last send: {formatLastSent($cctvConnectionState.lastSentAt)}</span>
                        <span>Target: {$cctvConnectionState.remoteAddress || (cctvConfig.host ? `${cctvConfig.host}:${cctvConfig.port}` : 'Not configured')}</span>
                    </div>
                    {#if $cctvConnectionState.dropped > 0}
                        <p class="mt-2 font-bold text-warning">
                            {$cctvConnectionState.dropped} older events were condensed. A CCTV GAP marker will be sent first.
                        </p>
                    {/if}
                </div>
            </div>

            <div class="mt-4 grid grid-cols-2 gap-3 border-t border-border-flat pt-4">
                <button class={switchCardClass(cctvConfig.sendItems)} on:click={() => updateSetting('cctv_pos_send_items', cctvConfig.sendItems ? 'false' : 'true')}>
                    <span class="font-extrabold">Trolley activity</span>
                    <small class="mt-1 block text-text-muted">Items, quantities, removals, price changes, holds and clears.</small>
                    <b class="absolute right-3 top-1/2 -translate-y-1/2 text-xs uppercase {cctvConfig.sendItems ? 'text-success' : 'text-text-muted'}">{cctvConfig.sendItems ? 'On' : 'Off'}</b>
                </button>
                <button class={switchCardClass(cctvConfig.sendReceipts)} on:click={() => updateSetting('cctv_pos_send_receipts', cctvConfig.sendReceipts ? 'false' : 'true')}>
                    <span class="font-extrabold">Completed transactions</span>
                    <small class="mt-1 block text-text-muted">Sales, full receipts, refunds and voids.</small>
                    <b class="absolute right-3 top-1/2 -translate-y-1/2 text-xs uppercase {cctvConfig.sendReceipts ? 'text-success' : 'text-text-muted'}">{cctvConfig.sendReceipts ? 'On' : 'Off'}</b>
                </button>
            </div>
        </section>
    </div>
</MgmtPage>

<style>
    .cctv-form-grid.form-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .75rem; }
    .cctv-marker-grid.form-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .75rem; }
    .cctv-readonly-value { min-height: 44px; display: flex; align-items: center; padding: .65rem 1rem; overflow: hidden; color: var(--text-main); border: 1px solid var(--border-flat); border-radius: .5rem; background: var(--bg-panel); font-family: var(--app-font-mono); text-overflow: ellipsis; white-space: nowrap; }
    .cctv-diagnostics { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 1rem; }

    @media (max-width: 620px) {
        .cctv-form-grid.form-grid,
        .cctv-marker-grid.form-grid,
        .cctv-diagnostics { grid-template-columns: minmax(0, 1fr); }
    }
</style>
