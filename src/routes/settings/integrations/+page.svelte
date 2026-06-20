<script lang="ts">
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import CustomSelect from '$lib/components/CustomSelect.svelte';
    import { now, settingsDB } from '$lib/stores/db';
    import { upsert } from '$lib/stores/database';
    import { toast } from '$lib/stores/toast';
    import { getCctvPosConfig, sendCctvPosText } from '$lib/cctvPos';

    $: cctvConfig = getCctvPosConfig($settingsDB);

    let cctvTestStatus = '';

    const cctvEncodingOptions = [
        { label: 'Latin-1 / ISO-8859-1', value: 'latin1' },
        { label: 'UTF-8', value: 'utf8' },
    ];

    function switchCardClass(active: boolean): string {
        return [
            'relative min-h-[96px] rounded-xl border p-4 pr-16 text-left transition-all duration-150',
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
        cctvTestStatus = 'Sending test text...';
        try {
            await sendCctvPosText('TEST PRODUCT', config);
            cctvTestStatus = 'Test sent. Check the linked camera live view.';
            toast('CCTV POS test sent');
        } catch (error) {
            cctvTestStatus = `Test failed: ${error}`;
            toast(`CCTV POS test failed: ${error}`, 'error');
        }
    }
</script>

<MgmtPage title="Hardware Integrations" backFallback="/settings">
    <div slot="actions" class="flex flex-wrap gap-3">
        <a class="btn btn-secondary" href="/settings/printers">Printer Setup</a>
        <button class="btn btn-primary" on:click={testCctvPosOverlay}>Send CCTV Test</button>
    </div>

    <div class="flex flex-col gap-5 p-4 lg:p-6">
        <section class="rounded-2xl border border-border-flat bg-gradient-to-br from-bg-card to-bg-panel p-5 shadow-[0_18px_45px_var(--shadow)]">
            <p class="mb-1 text-xs font-black uppercase tracking-[0.18em] text-success">Integrations</p>
            <h2 class="m-0 text-2xl font-black text-text-main">CCTV POS overlay</h2>
            <p class="mt-2 max-w-3xl text-sm text-text-muted">
                Send product names and final receipt lines to a supported DVR/NVR POS input. These settings are saved on this till only.
            </p>
            {#if cctvTestStatus}
                <p class="mt-4 rounded-xl border border-border-flat bg-bg-panel p-3 text-sm text-text-muted">{cctvTestStatus}</p>
            {/if}
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
                    <label>DVR / NVR IP Address</label>
                    <input
                        value={cctvConfig.host}
                        placeholder="e.g. 192.168.1.104"
                        on:change={(e) => updateSetting('cctv_pos_host', e.currentTarget.value.trim())}
                    />
                </div>
                <div class="field">
                    <label>DVR / NVR POS Port</label>
                    <input
                        type="number"
                        min="1"
                        max="65535"
                        value={cctvConfig.port}
                        on:change={(e) => updateSetting('cctv_pos_port', e.currentTarget.value || '10010')}
                    />
                </div>
                <div class="field">
                    <label>POS Number on DVR</label>
                    <input
                        value={cctvConfig.posNumber}
                        placeholder="e.g. 1"
                        on:change={(e) => updateSetting('cctv_pos_number', e.currentTarget.value.trim() || '1')}
                    />
                </div>
                <div class="field">
                    <label>POS Name on DVR</label>
                    <input
                        value={cctvConfig.posName}
                        placeholder="e.g. POS 1 / Till 1"
                        on:change={(e) => updateSetting('cctv_pos_name', e.currentTarget.value.trim() || 'POS 1')}
                    />
                </div>
                <div class="field">
                    <label>This Till IP Address</label>
                    <input
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
