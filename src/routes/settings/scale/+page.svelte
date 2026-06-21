<script lang="ts">
    import { onMount } from 'svelte';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import CustomSelect from '$lib/components/CustomSelect.svelte';
    import { now, settingsDB } from '$lib/stores/db';
    import { upsert } from '$lib/stores/database';
    import { toast } from '$lib/stores/toast';
    import {
        formatScaleReading,
        getScaleHardwareConfig,
        listScalePorts,
        readScaleWeight,
        type SerialPortInfo,
    } from '$lib/scaleHardware';

    $: scale = getScaleHardwareConfig($settingsDB);
    $: portOptions = portOptionsFor(scale.devicePath);

    let findingPorts = false;
    let foundPorts: SerialPortInfo[] = [];
    let portFinderStatus = '';
    let scaleTestStatus = '';
    let testingScale = false;

    const baudOptions = [
        { label: '9600 (most common)', value: '9600' },
        { label: '4800', value: '4800' },
        { label: '2400', value: '2400' },
        { label: '19200', value: '19200' },
        { label: '38400', value: '38400' },
    ];

    onMount(() => {
        void findScalePorts(true);
    });

    async function updateSetting(key: string, value: string) {
        const row = { key, value, updatedAt: now() };
        settingsDB.update((settings) => {
            const index = settings.findIndex((item) => item.key === key);
            if (index >= 0) return settings.map((item, itemIndex) => itemIndex === index ? row : item);
            return [...settings, row];
        });
        await upsert('settings', row, 'key');
    }

    function portOptionsFor(currentPath: string) {
        const options = foundPorts.map((port) => ({
            label: port.label,
            value: port.path,
        }));
        const current = currentPath.trim();
        if (current && !options.some((option) => option.value === current)) {
            options.unshift({ label: `${current} (current)`, value: current });
        }
        return options;
    }

    async function findScalePorts(quiet = false) {
        findingPorts = true;
        if (!quiet) portFinderStatus = 'Finding serial ports...';
        try {
            const ports = await listScalePorts();
            foundPorts = ports;
            if (ports.length === 0) {
                portFinderStatus = 'No serial ports found. Plug in the USB-to-RS232 adapter, install its driver if needed, then try again.';
                return;
            }
            portFinderStatus = `Found ${ports.length} port${ports.length === 1 ? '' : 's'}. Choose the one that appeared after plugging in the scale adapter.`;
            if (!scale.devicePath.trim() && ports.length === 1) {
                await updateSetting('scale_hardware_device_path', ports[0].path);
            }
        } catch (error) {
            portFinderStatus = `Could not find serial ports: ${error}`;
            if (!quiet) toast(`Could not find serial ports: ${error}`, 'error');
        } finally {
            findingPorts = false;
        }
    }

    async function testScale() {
        scaleTestStatus = 'Reading scale...';
        testingScale = true;
        try {
            const reading = await readScaleWeight(scale);
            scaleTestStatus = `Scale read ${formatScaleReading(reading)}${reading.raw ? ` (${reading.raw})` : ''}`;
            toast('Scale read successfully', 'success');
        } catch (error) {
            scaleTestStatus = `Scale failed: ${error}`;
            toast(`Scale failed: ${error}`, 'error');
        } finally {
            testingScale = false;
        }
    }
</script>

<MgmtPage title="Scale Setup" backFallback="/settings">
    <div slot="actions" class="flex flex-wrap gap-3">
        <a class="btn btn-secondary" href="/settings/barcodes">Scale Barcode Rules</a>
        <a class="btn btn-secondary" href="/settings/printers">Printer Setup</a>
    </div>

    <div class="settings-page-shell">
        <section class="settings-hero">
            <div class="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                    <p class="settings-hero-kicker !text-success">Scale connection</p>
                    <h2 class="settings-hero-title">Connect the weighing scale</h2>
                    <p class="settings-hero-copy">
                        Your Adam scale uses a serial cable. Choose the serial port from this page, then the Scale button on the till will fill the weight automatically.
                    </p>
                </div>
                <button
                    class="rounded-full border px-4 py-2 text-sm font-black transition-all {scale.enabled ? 'border-success bg-success/10 text-success' : 'border-border-flat bg-bg-panel text-text-muted'}"
                    on:click={() => updateSetting('scale_hardware_enabled', scale.enabled ? 'false' : 'true')}
                >
                    Scale {scale.enabled ? 'Enabled' : 'Disabled'}
                </button>
            </div>
        </section>

        <div class="grid grid-cols-1 gap-5 2xl:grid-cols-[minmax(0,1fr)_380px]">
            <div class="flex flex-col gap-5">
                <section class="settings-section">
                    <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                            <p class="settings-hero-kicker">Port finder</p>
                            <h3 class="settings-section-title !mb-2">Choose scale port</h3>
                            <p class="mt-2 max-w-2xl text-sm text-text-muted">
                                Plug in the USB-to-RS232 adapter, then use Find ports. On Windows it will look like COM3. On Mac it is normally a /dev/cu.usbserial port.
                            </p>
                        </div>
                        <button type="button" class="btn btn-secondary" on:click={() => findScalePorts(false)} disabled={findingPorts}>
                            {findingPorts ? 'Finding...' : 'Find ports'}
                        </button>
                    </div>

                    <div class="settings-mini-card mt-5">
                        <div class="form-grid">
                            <div class="field span-2">
                                <label>Scale Port</label>
                                {#if portOptions.length > 0}
                                    <CustomSelect
                                        value={scale.devicePath}
                                        options={portOptions}
                                        placeholder="Choose the scale port..."
                                        on:change={(event) => updateSetting('scale_hardware_device_path', String(event.detail))}
                                    />
                                {:else}
                                    <input
                                        value={scale.devicePath}
                                        placeholder="e.g. COM3 or /dev/cu.usbserial-0001"
                                        on:change={(event) => updateSetting('scale_hardware_device_path', event.currentTarget.value.trim())}
                                    />
                                {/if}
                                <small class="text-text-muted">If there are many choices, unplug the adapter, click Find ports, plug it back in, and click Find ports again. The new one is usually the scale.</small>
                            </div>
                            <div class="field span-2">
                                <label>Manual Port</label>
                                <input
                                    value={scale.devicePath}
                                    placeholder="Type only if the finder cannot see it"
                                    on:change={(event) => updateSetting('scale_hardware_device_path', event.currentTarget.value.trim())}
                                />
                            </div>
                        </div>
                        {#if portFinderStatus}
                            <p class="m-0 mt-4 rounded-lg border border-border-flat bg-bg-card px-3 py-2 text-sm text-text-muted">{portFinderStatus}</p>
                        {/if}
                    </div>
                </section>

                <section class="settings-section">
                    <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                            <p class="settings-hero-kicker">Reading settings</p>
                            <h3 class="settings-section-title !mb-2">Speed and test</h3>
                            <p class="mt-2 max-w-2xl text-sm text-text-muted">
                                Start with 9600. If the test says no data, press PRINT on the scale, or try 4800 and 2400.
                            </p>
                        </div>
                        <button class="btn btn-primary" on:click={testScale} disabled={!scale.enabled || !scale.devicePath.trim() || testingScale}>
                            {testingScale ? 'Reading...' : 'Test Scale'}
                        </button>
                    </div>

                    <div class="settings-mini-card mt-5">
                        <div class="form-grid">
                            <CustomSelect
                                label="Baud Rate"
                                value={String(scale.baudRate)}
                                options={baudOptions}
                                on:change={(event) => updateSetting('scale_hardware_baud_rate', String(event.detail))}
                            />
                            <div class="field">
                                <label>Read Interval</label>
                                <input
                                    type="number"
                                    min="500"
                                    max="5000"
                                    step="100"
                                    value={scale.pollMs}
                                    on:change={(event) => updateSetting('scale_hardware_poll_ms', event.currentTarget.value || '1200')}
                                />
                                <small class="text-text-muted">Milliseconds between live reads in the till Scale dialog.</small>
                            </div>
                        </div>
                        {#if scaleTestStatus}
                            <p class="m-0 mt-4 rounded-lg border border-border-flat bg-bg-card px-3 py-2 text-sm text-text-muted">{scaleTestStatus}</p>
                        {/if}
                    </div>
                </section>
            </div>

            <aside class="settings-section self-start 2xl:sticky 2xl:top-4">
                <p class="settings-hero-kicker">What to choose</p>
                <h3 class="settings-section-title !mb-3">Port help</h3>
                <div class="mt-5 flex flex-col gap-3">
                    <div class="settings-mini-card">
                        <b class="text-text-main">Windows</b>
                        <p class="m-0 mt-1 text-sm text-text-muted">Choose the COM port for the USB-to-RS232 adapter, for example COM3.</p>
                    </div>
                    <div class="settings-mini-card">
                        <b class="text-text-main">Mac</b>
                        <p class="m-0 mt-1 text-sm text-text-muted">Choose a /dev/cu.usbserial or /dev/tty.usbserial port. /dev/cu is usually best for adapters.</p>
                    </div>
                    <div class="settings-mini-card">
                        <b class="text-text-main">No weight yet</b>
                        <p class="m-0 mt-1 text-sm text-text-muted">Some scales only send after pressing PRINT. Others need continuous RS-232 output enabled from the scale menu.</p>
                    </div>
                </div>
            </aside>
        </div>
    </div>
</MgmtPage>
