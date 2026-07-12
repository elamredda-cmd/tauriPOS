<script lang="ts">
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import CustomSelect from '$lib/components/CustomSelect.svelte';
    import { now, settingsDB } from '$lib/stores/db';
    import { upsert } from '$lib/stores/database';
    import { toast } from '$lib/stores/toast';
    import {
        cctvConnectionState,
        formatCctvItemText,
        getCctvPosConfig,
        sendCctvPosText,
    } from '$lib/cctvPos';

    $: cctvConfig = getCctvPosConfig($settingsDB);
    $: cctvPreview = formatCctvItemText({
        name: 'Example scanned product',
        price: 249,
        quantity: 2,
        tillName: cctvConfig.posName,
        cashierName: 'Cashier',
    }, cctvConfig);

    const cctvEncodingOptions = [
        { label: 'Latin-1 / ISO-8859-1', value: 'latin1' },
        { label: 'UTF-8', value: 'utf8' },
    ];

    const cctvLineWidthOptions = [
        { label: '32 characters - compact', value: '32' },
        { label: '40 characters - standard', value: '40' },
        { label: '48 characters - wide', value: '48' },
    ];

    function switchCardClass(active: boolean): string {
        return [
            'relative min-h-[96px] rounded-md border p-4 pr-16 text-left',
            active
                ? 'border-success bg-success/10 text-text-main shadow-[0_12px_30px_var(--shadow)]'
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

    async function testCctvPosOverlay() {
        const config = getCctvPosConfig($settingsDB);
        if (!config.host.trim()) {
            toast('Enter the DVR/NVR IP address first', 'error');
            return;
        }
        if (!config.enabled) {
            toast('Turn CCTV Overlay on before testing automatic sends', 'error');
            return;
        }
        try {
            await sendCctvPosText(formatCctvItemText({
                name: 'CCTV test product',
                price: 123,
                quantity: 1,
                tillName: config.posName,
                cashierName: 'Test',
            }, config), config);
            toast('CCTV POS test sent');
        } catch (error) {
            toast(`CCTV POS test failed: ${error}`, 'error');
        }
    }
</script>

<MgmtPage title="Hardware Integrations" backFallback="/settings">
    <div slot="actions" class="flex flex-wrap gap-3">
        <a class="btn btn-secondary" href="/settings/printers">Printer Setup</a>
        <button
            class="btn btn-primary"
            disabled={$cctvConnectionState.status === 'sending'}
            on:click={testCctvPosOverlay}
        >
            {$cctvConnectionState.status === 'sending' ? 'Testing...' : 'Send CCTV Test'}
        </button>
    </div>

    <div class="settings-page-shell">
        <section class="settings-hero">
            <p class="settings-hero-kicker !text-success">Integrations</p>
            <h2 class="settings-hero-title">CCTV POS overlay</h2>
            <p class="settings-hero-copy">
                Send product names and final receipt lines to a supported DVR/NVR POS input. These settings are saved on this till only.
            </p>
        </section>

        <section class="settings-section">
            <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div>
                    <h3 class="settings-section-title">CCTV POS Overlay</h3>
                    <p class="mb-4 text-sm text-text-muted">Use this when the recorder has a POS text input such as Hikvision Universal Protocol over TCP.</p>
                </div>
                <button
                    class="btn {cctvConfig.enabled ? 'btn-success' : 'btn-secondary'}"
                    on:click={() => updateSetting('cctv_pos_enabled', cctvConfig.enabled ? 'false' : 'true')}
                >
                    CCTV Overlay: {cctvConfig.enabled ? 'Enabled' : 'Disabled'}
                </button>
            </div>

            <div class="form-grid">
                <div class="field">
                    <label for="cctv-host">DVR / NVR IP Address</label>
                    <input
                        id="cctv-host"
                        value={cctvConfig.host}
                        placeholder="e.g. 192.168.1.104"
                        on:change={(e) => updateSetting('cctv_pos_host', e.currentTarget.value.trim())}
                    />
                </div>
                <div class="field">
                    <label for="cctv-port">DVR / NVR POS Port</label>
                    <input
                        id="cctv-port"
                        type="number"
                        min="1"
                        max="65535"
                        value={cctvConfig.port}
                        on:change={(e) => updateSetting('cctv_pos_port', e.currentTarget.value || '10010')}
                    />
                </div>
                <div class="field">
                    <label for="cctv-pos-number">POS Number on DVR</label>
                    <input
                        id="cctv-pos-number"
                        value={cctvConfig.posNumber}
                        placeholder="e.g. 1"
                        on:change={(e) => updateSetting('cctv_pos_number', e.currentTarget.value.trim() || '1')}
                    />
                </div>
                <div class="field">
                    <label for="cctv-pos-name">POS Name on DVR</label>
                    <input
                        id="cctv-pos-name"
                        value={cctvConfig.posName}
                        placeholder="e.g. POS 1 / Till 1"
                        on:change={(e) => updateSetting('cctv_pos_name', e.currentTarget.value.trim() || 'POS 1')}
                    />
                </div>
                <div class="field">
                    <label for="cctv-source-ip">This Till IP Address</label>
                    <input
                        id="cctv-source-ip"
                        value={cctvConfig.sourceIp}
                        placeholder="e.g. 192.168.1.186"
                        on:change={(e) => updateSetting('cctv_pos_source_ip', e.currentTarget.value.trim())}
                    />
                    <small class="text-text-muted">Put this same IP in the recorder "Allowed Remote IP" field.</small>
                </div>
                <div class="field">
                    <CustomSelect
                        label="Character Encoding"
                        value={cctvConfig.encoding}
                        options={cctvEncodingOptions}
                        on:change={(event) => updateSetting('cctv_pos_encoding', event.detail)}
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
            </div>

            <div class="mt-5 grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(240px,0.6fr)]">
                <div class="rounded-md border border-border-flat bg-bg-panel p-4">
                    <span class="mb-2 block text-xs font-extrabold uppercase text-text-muted">Camera text preview</span>
                    <pre class="m-0 overflow-x-auto whitespace-pre rounded-sm bg-black px-3 py-3 font-mono text-sm font-bold text-white">{cctvPreview}</pre>
                </div>
                <div class="rounded-md border p-4 {$cctvConnectionState.status === 'online'
                    ? 'border-success/50 bg-success/10'
                    : $cctvConnectionState.status === 'offline'
                        ? 'border-danger/50 bg-danger/10'
                        : 'border-border-flat bg-bg-panel'}">
                    <span class="mb-2 block text-xs font-extrabold uppercase text-text-muted">Connection status</span>
                    <strong class="block text-base text-text-main">
                        {$cctvConnectionState.status === 'online'
                            ? 'Recorder online'
                            : $cctvConnectionState.status === 'offline'
                                ? 'Recorder offline'
                                : $cctvConnectionState.status === 'sending'
                                    ? 'Testing connection'
                                    : 'Not tested'}
                    </strong>
                    <small class="mt-1 block text-text-muted">{$cctvConnectionState.message}</small>
                    {#if $cctvConnectionState.status === 'offline'}
                        <small class="mt-2 block font-semibold text-text-main">Automatic sends pause briefly after a failure, so an offline recorder cannot slow the till.</small>
                    {/if}
                </div>
            </div>

            <div class="mt-5 grid grid-cols-1 gap-3 md:grid-cols-2">
                <button class={switchCardClass(cctvConfig.sendItems)} on:click={() => updateSetting('cctv_pos_send_items', cctvConfig.sendItems ? 'false' : 'true')}>
                    <span class="font-extrabold">Send item scans</span>
                    <small class="mt-1 block text-text-muted">Show each product name as it is added to the cart.</small>
                    <b class="absolute right-4 top-1/2 -translate-y-1/2 text-xs uppercase tracking-[0.12em] {cctvConfig.sendItems ? 'text-success' : 'text-text-muted'}">{cctvConfig.sendItems ? 'On' : 'Off'}</b>
                </button>
                <button class={switchCardClass(cctvConfig.sendReceipts)} on:click={() => updateSetting('cctv_pos_send_receipts', cctvConfig.sendReceipts ? 'false' : 'true')}>
                    <span class="font-extrabold">Send final receipt</span>
                    <small class="mt-1 block text-text-muted">Show quantity, item name, line total, and sale total after payment.</small>
                    <b class="absolute right-4 top-1/2 -translate-y-1/2 text-xs uppercase tracking-[0.12em] {cctvConfig.sendReceipts ? 'text-success' : 'text-text-muted'}">{cctvConfig.sendReceipts ? 'On' : 'Off'}</b>
                </button>
            </div>
        </section>
    </div>
</MgmtPage>
