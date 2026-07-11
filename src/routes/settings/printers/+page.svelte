<script lang="ts">
    import { onMount } from 'svelte';
    import { invoke } from '@tauri-apps/api/core';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import CustomSelect from '$lib/components/CustomSelect.svelte';
    import { now, settingsDB } from '$lib/stores/db';
    import { upsert } from '$lib/stores/database';
    import { toast } from '$lib/stores/toast';
    import {
        getLabelPrinterConfig,
        getReceiptPrinterConfig,
        sendLabelPrinterTest,
        sendReceiptPrinterTest,
        type LabelPrinterProtocol,
        type PrinterConnectionType,
        type ReceiptPrinterModel,
    } from '$lib/printers';
    import { cashDrawerTargetLabel, getCashDrawerConfig, openCashDrawer } from '$lib/cashDrawer';

    $: receipt = getReceiptPrinterConfig($settingsDB);
    $: label = getLabelPrinterConfig($settingsDB);
    $: drawer = getCashDrawerConfig($settingsDB);
    $: drawerTarget = cashDrawerTargetLabel(drawer);
    $: explicitDrawerHost = settingValue('cash_drawer_printer_host');
    $: explicitDrawerPrinterName = settingValue('cash_drawer_printer_name');
    $: explicitDrawerDevicePath = settingValue('cash_drawer_printer_device_path');
    $: drawerUsesReceiptPrinter = !explicitDrawerHost.trim() && !explicitDrawerPrinterName.trim() && !explicitDrawerDevicePath.trim();
    $: drawerManualEnabled = ($settingsDB.find((item) => item.key === 'cash_drawer_enabled')?.value ?? (drawerTarget ? 'true' : 'false')) !== 'false';
    $: receiptMode = receiptConnections.find((option) => option.value === receipt.connection);
    $: labelMode = labelConnections.find((option) => option.value === label.connection);
    $: receiptPrinterOptions = printerOptionsFor(receipt.printerName);
    $: labelPrinterOptions = printerOptionsFor(label.printerName);
    $: drawerPrinterOptions = printerOptionsFor(
        explicitDrawerPrinterName,
        { label: 'Use receipt printer', value: '' },
    );
    let receiptTestStatus = '';
    let labelTestStatus = '';
    let drawerTestStatus = '';
    let findingPrinters = false;
    let foundPrinters: SystemPrinterInfo[] = [];

    type SystemPrinterInfo = {
        name: string;
        driverName?: string;
        portName?: string;
    };

    onMount(() => {
        void findSystemPrinters({ quiet: true });
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

    function settingValue(key: string, fallback = '') {
        return $settingsDB.find((item) => item.key === key)?.value ?? fallback;
    }

    async function useReceiptPrinterForDrawer() {
        await updateSetting('cash_drawer_printer_host', '');
        await updateSetting('cash_drawer_printer_name', '');
        await updateSetting('cash_drawer_printer_device_path', '');
        drawerTestStatus = 'Drawer will use the configured receipt printer.';
        toast('Drawer set to receipt printer', 'success');
    }

    async function toggleStarTsp100Preset() {
        if (receipt.model === 'star_tsp100') {
            await updateSetting('receipt_printer_model', 'generic_escpos');
            receiptTestStatus = 'Star TSP100 preset removed. Receipt printer is now set to Generic ESC/POS.';
            toast('Star TSP100 preset removed', 'success');
            return;
        }
        await updateSetting('receipt_printer_model', 'star_tsp100');
        await updateSetting('receipt_printer_connection', 'usb_raw');
        await updateSetting('receipt_printer_paper_width', '80mm');
        await updateSetting('receipt_printer_encoding', 'latin1');
        await updateSetting('receipt_printer_cut_paper', 'true');
        await updateSetting('receipt_printer_cut_feed_lines', '0');
        await updateSetting('receipt_printer_open_drawer_after_payment', 'false');
        void findSystemPrinters({ quiet: true });
        receiptTestStatus = 'Star TSP100 preset applied.';
        toast('Star TSP100 preset applied', 'success');
    }

    async function selectReceiptConnection(connection: PrinterConnectionType) {
        await updateSetting('receipt_printer_connection', connection);
        if (connection === 'usb_raw') void findSystemPrinters({ quiet: true });
    }

    async function selectLabelConnection(connection: PrinterConnectionType) {
        await updateSetting('label_printer_connection', connection);
        if (connection === 'system') {
            await updateSetting('label_printer_protocol', 'system');
        } else if (label.protocol === 'system') {
            await updateSetting('label_printer_protocol', 'escpos');
        }
        if (connection === 'usb_raw') void findSystemPrinters({ quiet: true });
    }

    async function selectLabelProtocol(protocol: LabelPrinterProtocol) {
        await updateSetting('label_printer_protocol', protocol);
        if (protocol === 'system') {
            await updateSetting('label_printer_connection', 'system');
        } else if (label.connection === 'system') {
            await updateSetting('label_printer_connection', 'usb_raw');
            void findSystemPrinters({ quiet: true });
        }
    }

    async function handleDrawerPrinterSelect(value: string) {
        if (!value.trim()) {
            await useReceiptPrinterForDrawer();
            return;
        }
        await setSeparateDrawerTarget('printer', value);
    }

    async function setSeparateDrawerTarget(kind: 'network' | 'printer' | 'device', value: string) {
        const trimmed = value.trim();
        if (kind === 'network') {
            await updateSetting('cash_drawer_printer_host', trimmed);
            if (trimmed) {
                await updateSetting('cash_drawer_printer_name', '');
                await updateSetting('cash_drawer_printer_device_path', '');
            }
            return;
        }
        if (kind === 'printer') {
            await updateSetting('cash_drawer_printer_name', trimmed);
            if (trimmed) {
                await updateSetting('cash_drawer_printer_host', '');
                await updateSetting('cash_drawer_printer_device_path', '');
            }
            return;
        }
        await updateSetting('cash_drawer_printer_device_path', trimmed);
        if (trimmed) {
            await updateSetting('cash_drawer_printer_host', '');
            await updateSetting('cash_drawer_printer_name', '');
        }
    }

    async function testReceiptPrinter() {
        receiptTestStatus = 'Sending test receipt...';
        try {
            await sendReceiptPrinterTest(receipt);
            receiptTestStatus = 'Test sent. Check the receipt printer.';
            toast('Printer test sent', 'success');
        } catch (error) {
            receiptTestStatus = `Test failed: ${error}`;
            toast(`Printer test failed: ${error}`, 'error');
        }
    }

    async function testLabelPrinter() {
        labelTestStatus = 'Sending test label...';
        try {
            await sendLabelPrinterTest(label);
            labelTestStatus = 'Test sent. Check the label printer.';
            toast('Label printer test sent', 'success');
        } catch (error) {
            labelTestStatus = `Test failed: ${error}`;
            toast(`Label printer test failed: ${error}`, 'error');
        }
    }

    async function testDrawer() {
        drawerTestStatus = 'Opening drawer...';
        try {
            await openCashDrawer(drawer);
            drawerTestStatus = 'Drawer pulse sent.';
            toast('Drawer opened', 'success');
        } catch (error) {
            drawerTestStatus = `Drawer failed: ${error}`;
            toast(`Drawer failed: ${error}`, 'error');
        }
    }

    function isLikelyThermalPrinter(printer: SystemPrinterInfo): boolean {
        return /xprinter|receipt|thermal|pos|epson|star|tsp100|tsp143|futureprnt|bixolon|citizen|tm-|zebra|tsc/i.test(
            `${printer.name} ${printer.driverName || ''} ${printer.portName || ''}`
        );
    }

    function printerLabel(printer: SystemPrinterInfo): string {
        const details = [printer.driverName, printer.portName].filter(Boolean).join(' / ');
        const suggested = isLikelyThermalPrinter(printer) ? ' (suggested)' : '';
        return `${printer.name}${suggested}${details ? ` - ${details}` : ''}`;
    }

    function sortSystemPrinters(printers: SystemPrinterInfo[]): SystemPrinterInfo[] {
        return [...printers].sort((a, b) => {
            const aSuggested = isLikelyThermalPrinter(a) ? 0 : 1;
            const bSuggested = isLikelyThermalPrinter(b) ? 0 : 1;
            if (aSuggested !== bSuggested) return aSuggested - bSuggested;
            return a.name.localeCompare(b.name);
        });
    }

    function printerOptionsFor(currentName: string, firstOption?: { label: string; value: string }) {
        const options = [
            ...(firstOption ? [firstOption] : []),
            ...foundPrinters.map((printer) => ({
                label: printerLabel(printer),
                value: printer.name,
            })),
        ];
        if (currentName.trim() && !options.some((option) => option.value === currentName.trim())) {
            options.splice(firstOption ? 1 : 0, 0, { label: `${currentName.trim()} (current, not detected)`, value: currentName.trim() });
        }
        return options;
    }

    async function findSystemPrinters(options: { quiet?: boolean } = {}) {
        findingPrinters = true;
        try {
            const printers = await invoke<SystemPrinterInfo[]>('list_system_printers');
            foundPrinters = sortSystemPrinters(printers);
        } catch (error) {
            if (!options.quiet) toast(`Could not find printers: ${error}`, 'error');
        } finally {
            findingPrinters = false;
        }
    }

    function modeCardClass(active: boolean, enabled: boolean) {
        return [
            'group min-h-[92px] rounded-xl border p-3 text-left transition-all duration-150',
            'flex flex-col gap-2 bg-bg-panel hover:-translate-y-0.5 hover:border-accent-primary hover:bg-bg-card',
            'focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-accent-primary',
            active ? 'border-accent-primary bg-bg-card shadow-[0_16px_40px_var(--shadow)]' : 'border-border-flat',
            enabled ? '' : 'cursor-not-allowed opacity-45 grayscale',
        ].join(' ');
    }

    function switchCardClass(active: boolean) {
        return [
            'min-h-[88px] rounded-xl border p-3 text-left transition-all duration-150',
            'flex flex-col gap-2 bg-bg-panel hover:border-accent-primary hover:bg-bg-card',
            active ? 'border-success bg-success/10' : 'border-border-flat',
        ].join(' ');
    }

    function compactInfoCardClass(tone: 'accent' | 'success' | 'neutral' = 'neutral') {
        const toneClass = tone === 'accent'
            ? 'border-accent-primary bg-accent-primary/10'
            : tone === 'success'
                ? 'border-success bg-success/10'
                : 'border-border-flat bg-bg-panel';
        return `min-h-[88px] rounded-xl border p-3 ${toneClass}`;
    }

    const receiptConnections: Array<{ value: PrinterConnectionType; label: string; enabled: boolean }> = [
        { value: 'system', label: 'System / driver print', enabled: true },
        { value: 'network_escpos', label: 'ESC/POS network', enabled: true },
        { value: 'usb_raw', label: 'Windows USB raw', enabled: true },
        { value: 'serial', label: 'Serial / COM', enabled: true },
        { value: 'bluetooth', label: 'Bluetooth', enabled: true },
    ];

    const labelConnections: Array<{ value: PrinterConnectionType; label: string; enabled: boolean }> = [
        { value: 'system', label: 'System / driver print', enabled: true },
        { value: 'network_escpos', label: 'Network label printer', enabled: true },
        { value: 'usb_raw', label: 'Windows USB raw', enabled: true },
        { value: 'serial', label: 'Serial / COM', enabled: true },
        { value: 'bluetooth', label: 'Bluetooth', enabled: true },
    ];

    const paperWidthOptions = [
        { label: '80mm receipt paper', value: '80mm' },
        { label: '58mm receipt paper', value: '58mm' },
    ];

    const encodingOptions = [
        { label: 'Latin-1 / common ESC/POS', value: 'latin1' },
        { label: 'UTF-8', value: 'utf8' },
    ];

    const receiptModelOptions: Array<{ label: string; value: ReceiptPrinterModel }> = [
        { label: 'Generic ESC/POS thermal printer', value: 'generic_escpos' },
        { label: 'Star TSP100 / TSP143 (Star Line)', value: 'star_tsp100' },
    ];

    const drawerPinOptions = [
        { label: 'Pin 2 / drawer 1', value: '0' },
        { label: 'Pin 5 / drawer 2', value: '1' },
    ];

    const labelProtocolOptions = [
        { label: 'System printer / driver', value: 'system' },
        { label: 'ESC/POS / Xprinter USB', value: 'escpos' },
        { label: 'ZPL / Zebra style', value: 'zpl' },
        { label: 'TSPL / TSC style', value: 'tspl' },
    ];

    const labelDpiOptions = [
        { label: '203 DPI (8 dots/mm)', value: '203' },
        { label: '300 DPI (12 dots/mm)', value: '300' },
        { label: '600 DPI (24 dots/mm)', value: '600' },
    ];
</script>

<MgmtPage title="Printer Setup" backFallback="/settings">
    <div slot="actions" class="flex flex-wrap gap-3">
        <a class="btn btn-secondary" href="/settings/receipt">Receipt Design</a>
        <a class="btn btn-secondary" href="/settings/labels">Label Design</a>
        <a class="btn btn-secondary" href="/settings/scale">Scale Setup</a>
    </div>

    <div class="settings-page-shell">
        <section class="settings-hero">
            <div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div>
                    <p class="settings-hero-kicker !text-text-muted">Hardware setup</p>
                    <h2 class="settings-hero-title">Printers, labels, and cash drawer</h2>
                </div>
                <div class="flex flex-wrap gap-2">
                    <button class="btn btn-secondary" on:click={testReceiptPrinter} disabled={receipt.connection === 'system'}>
                        Test Receipt
                    </button>
                    <button class="btn btn-secondary" on:click={testLabelPrinter} disabled={label.connection === 'system' || label.protocol === 'system'}>
                        Test Label
                    </button>
                    <button class="btn btn-primary" on:click={testDrawer}>Test Drawer</button>
                </div>
            </div>
            {#if receiptTestStatus || labelTestStatus || drawerTestStatus}
                <div class="mt-4 grid gap-2 md:grid-cols-3">
                    {#if receiptTestStatus}<p class="m-0 rounded-lg border border-border-flat bg-bg-panel px-3 py-2 text-sm text-text-muted">{receiptTestStatus}</p>{/if}
                    {#if labelTestStatus}<p class="m-0 rounded-lg border border-border-flat bg-bg-panel px-3 py-2 text-sm text-text-muted">{labelTestStatus}</p>{/if}
                    {#if drawerTestStatus}<p class="m-0 rounded-lg border border-border-flat bg-bg-panel px-3 py-2 text-sm text-text-muted">{drawerTestStatus}</p>{/if}
                </div>
            {/if}
        </section>

        <div class="grid grid-cols-1 gap-5">
            <div class="flex flex-col gap-5">
                <section class="settings-section">
                    <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                        <div>
                            <p class="settings-hero-kicker">Receipt printer</p>
                            <h3 class="settings-section-title !mb-2">Customer receipts</h3>
                        </div>
                        <div class="flex flex-wrap gap-2">
                            <button
                                class="rounded-full border px-4 py-2 text-sm font-black transition-all {receipt.model === 'star_tsp100' ? 'border-warning bg-warning/10 text-warning' : 'border-border-flat bg-bg-panel text-text-muted hover:border-warning hover:text-warning'}"
                                aria-pressed={receipt.model === 'star_tsp100'}
                                on:click={toggleStarTsp100Preset}
                            >
                                {receipt.model === 'star_tsp100' ? 'Cancel Star preset' : 'Star TSP100 preset'}
                            </button>
                            <button
                                class="rounded-full border px-4 py-2 text-sm font-black transition-all {receipt.enabled ? 'border-success bg-success/10 text-success' : 'border-border-flat bg-bg-panel text-text-muted'}"
                                on:click={() => updateSetting('receipt_printer_enabled', receipt.enabled ? 'false' : 'true')}
                            >
                                Receipt {receipt.enabled ? 'Enabled' : 'Disabled'}
                            </button>
                        </div>
                    </div>

                    <div class="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
                        {#each receiptConnections as option}
                            <button
                                class={modeCardClass(receipt.connection === option.value, option.enabled)}
                                aria-pressed={receipt.connection === option.value}
                                disabled={!option.enabled}
                                on:click={() => selectReceiptConnection(option.value)}
                            >
                                <span class="text-sm font-black leading-tight text-text-main">{option.label}</span>
                                {#if receipt.connection === option.value}
                                    <span class="mt-auto w-max rounded-full bg-success/10 px-2 py-0.5 text-[0.68rem] font-black uppercase tracking-[0.06em] text-success">Selected</span>
                                {/if}
                            </button>
                        {/each}
                    </div>

                    <div class="mt-5 grid grid-cols-1 gap-3 xl:grid-cols-[220px_minmax(0,1fr)]">
                        <div class={compactInfoCardClass('accent')}>
                            <span class="text-xs font-black uppercase tracking-[0.12em] text-text-muted">Selected mode</span>
                            <strong class="mt-2 block text-base leading-tight text-text-main">{receiptMode?.label || receipt.connection}</strong>
                        </div>

                        <div class="rounded-xl border border-border-flat bg-bg-panel p-4">
                            <div class="mb-4 flex items-center justify-between gap-3">
                                <div>
                                    <h4 class="m-0 text-base font-black">Connection details</h4>
                                </div>
                            </div>
                            <div class="form-grid">
                                {#if receipt.connection === 'system'}
                                    <div class="span-2 rounded-xl border border-dashed border-border-flat bg-bg-card p-4">
                                        <b class="text-text-main">System printer mode</b>
                                    </div>
                                {:else if receipt.connection === 'network_escpos'}
                                    <div class="field">
                                        <label>Receipt Printer IP</label>
                                        <input
                                            value={receipt.host}
                                            placeholder="e.g. 192.168.1.50"
                                            on:change={(event) => updateSetting('receipt_printer_host', event.currentTarget.value.trim())}
                                        />
                                    </div>
                                    <div class="field">
                                        <label>Port</label>
                                        <input
                                            type="number"
                                            min="1"
                                            max="65535"
                                            value={receipt.port}
                                            on:change={(event) => updateSetting('receipt_printer_port', event.currentTarget.value || '9100')}
                                        />
                                    </div>
                                {:else if receipt.connection === 'usb_raw'}
                                    <div class="field span-2">
                                        <CustomSelect
                                            label="Installed Windows Printer"
                                            value={receipt.printerName}
                                            options={receiptPrinterOptions}
                                            placeholder={findingPrinters ? 'Loading installed printers...' : 'Choose installed printer...'}
                                            emptyText="No installed printers found."
                                            on:change={(event) => updateSetting('receipt_printer_name', String(event.detail))}
                                        />
                                    </div>
                                {:else}
                                    <div class="field span-2">
                                        <label>{receipt.connection === 'bluetooth' ? 'Bluetooth COM Port' : 'Serial / COM Port'}</label>
                                        <input
                                            value={receipt.devicePath}
                                            placeholder="e.g. COM3 or /dev/tty.usbserial"
                                            on:change={(event) => updateSetting('receipt_printer_device_path', event.currentTarget.value.trim())}
                                        />
                                    </div>
                                {/if}
                                <CustomSelect
                                    label="Printer Model"
                                    value={receipt.model}
                                    options={receiptModelOptions}
                                    on:change={(event) => updateSetting('receipt_printer_model', String(event.detail))}
                                />
                                <CustomSelect
                                    label="Paper Width"
                                    value={receipt.paperWidth}
                                    options={paperWidthOptions}
                                    on:change={(event) => updateSetting('receipt_printer_paper_width', String(event.detail))}
                                />
                                <CustomSelect
                                    label="Character Encoding"
                                    value={receipt.encoding}
                                    options={encodingOptions}
                                    on:change={(event) => updateSetting('receipt_printer_encoding', String(event.detail))}
                                />
                            </div>
                        </div>
                    </div>

                    <div class="mt-5 rounded-xl border border-success bg-success/10 p-4">
                        <div class="flex flex-col gap-1">
                            <h4 class="m-0 text-base font-black text-text-main">After payment</h4>
                        </div>
                        <div class="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
                            <button class={switchCardClass(receipt.autoPrintAfterPayment)} on:click={() => updateSetting('receipt_printer_auto_print_after_payment', receipt.autoPrintAfterPayment ? 'false' : 'true')}>
                                <span class="text-sm font-black leading-tight text-text-main">Auto print</span>
                                <b class="mt-auto text-xs text-success">{receipt.autoPrintAfterPayment ? 'On' : 'Off'}</b>
                            </button>
                            <button class={switchCardClass(receipt.cutPaper)} on:click={() => updateSetting('receipt_printer_cut_paper', receipt.cutPaper ? 'false' : 'true')}>
                                <span class="text-sm font-black leading-tight text-text-main">Cut paper</span>
                                <b class="mt-auto text-xs text-success">{receipt.cutPaper ? 'On' : 'Off'}</b>
                            </button>
                            <div class={compactInfoCardClass()}>
                                <label class="text-sm font-black leading-tight text-text-main" for="receipt-cut-feed-lines">Feed before cut</label>
                                <input
                                    id="receipt-cut-feed-lines"
                                    class="mt-2 h-11"
                                    type="number"
                                    min="0"
                                    max="20"
                                    value={receipt.cutFeedLines}
                                    on:change={(event) => updateSetting('receipt_printer_cut_feed_lines', event.currentTarget.value || '8')}
                                />
                            </div>
                            <button class={switchCardClass(receipt.openDrawerAfterPayment)} on:click={() => updateSetting('receipt_printer_open_drawer_after_payment', receipt.openDrawerAfterPayment ? 'false' : 'true')}>
                                <span class="text-sm font-black leading-tight text-text-main">Open drawer</span>
                                <b class="mt-auto text-xs text-success">{receipt.openDrawerAfterPayment ? 'On' : 'Off'}</b>
                            </button>
                        </div>
                    </div>

                    <div class="mt-5 rounded-xl border border-border-flat bg-bg-panel p-4">
                        <div class="mb-4 flex flex-col gap-1">
                            <h4 class="m-0 text-base font-black text-text-main">Cash drawer pulse</h4>
                        </div>
                        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                            <button
                                class={switchCardClass(drawerManualEnabled)}
                                on:click={() => updateSetting('cash_drawer_enabled', drawerManualEnabled ? 'false' : 'true')}
                            >
                                <span class="text-sm font-black leading-tight text-text-main">Drawer pulse</span>
                                <b class="mt-auto text-xs text-success">{drawerManualEnabled ? 'Enabled' : 'Disabled'}</b>
                            </button>
                            <button class={switchCardClass(false)} on:click={testDrawer}>
                                <span class="text-sm font-black leading-tight text-text-main">Test drawer</span>
                                <b class="mt-auto text-xs text-accent-primary">Open now</b>
                            </button>
                            <div class={compactInfoCardClass()}>
                                <span class="text-xs font-black uppercase tracking-[0.12em] text-text-muted">Target</span>
                                <strong class="mt-2 block text-sm leading-tight text-text-main">
                                    {drawerUsesReceiptPrinter ? `Receipt printer: ${drawerTarget || 'set receipt printer first'}` : drawerTarget}
                                </strong>
                            </div>
                            <div class={compactInfoCardClass()}>
                                <CustomSelect
                                    label="Drawer Pin"
                                    value={String(drawer.pin)}
                                    options={drawerPinOptions}
                                    on:change={(event) => updateSetting('cash_drawer_pin', String(event.detail))}
                                />
                            </div>
                            <div class="rounded-xl border border-border-flat bg-bg-card p-3 sm:col-span-2 xl:col-span-2">
                                <label class="text-sm font-black leading-tight text-text-main">Pulse timing</label>
                                <div class="mt-2 grid grid-cols-2 gap-2">
                                    <input
                                        type="number"
                                        min="2"
                                        max="510"
                                        value={drawer.pulseOnMs}
                                        on:change={(event) => updateSetting('cash_drawer_pulse_on_ms', event.currentTarget.value || '50')}
                                        title="Pulse on milliseconds"
                                    />
                                    <input
                                        type="number"
                                        min="2"
                                        max="510"
                                        value={drawer.pulseOffMs}
                                        on:change={(event) => updateSetting('cash_drawer_pulse_off_ms', event.currentTarget.value || '250')}
                                        title="Pulse off milliseconds"
                                    />
                                </div>
                            </div>
                            <div class="rounded-xl border border-border-flat bg-bg-card p-3 sm:col-span-2 xl:col-span-4">
                                <div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                                    <div>
                                        <label class="text-sm font-black leading-tight text-text-main">Separate drawer target</label>
                                    </div>
                                    <button type="button" class="btn btn-secondary" on:click={useReceiptPrinterForDrawer} disabled={drawerUsesReceiptPrinter}>
                                        Use Receipt Printer
                                    </button>
                                </div>
                                <div class="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-3">
                                    <div class="field">
                                        <CustomSelect
                                            label="Separate Windows Printer"
                                            value={explicitDrawerPrinterName}
                                            options={drawerPrinterOptions}
                                            placeholder="Use receipt printer"
                                            on:change={(event) => handleDrawerPrinterSelect(String(event.detail))}
                                        />
                                    </div>
                                    <div class="field">
                                        <label>Separate Network IP</label>
                                        <input
                                            value={explicitDrawerHost}
                                            placeholder="Leave empty to use receipt printer"
                                            on:change={(event) => setSeparateDrawerTarget('network', event.currentTarget.value)}
                                        />
                                    </div>
                                    <div class="field">
                                        <label>Separate COM / Device Path</label>
                                        <input
                                            value={explicitDrawerDevicePath}
                                            placeholder="e.g. COM3 or /dev/tty.usbserial"
                                            on:change={(event) => setSeparateDrawerTarget('device', event.currentTarget.value)}
                                        />
                                    </div>
                                    <div class="field">
                                        <label>Network Port</label>
                                        <input
                                            type="number"
                                            min="1"
                                            max="65535"
                                            value={settingValue('cash_drawer_printer_port', '9100') || '9100'}
                                            on:change={(event) => updateSetting('cash_drawer_printer_port', event.currentTarget.value || '9100')}
                                        />
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </section>

                <section class="settings-section">
                    <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                        <div>
                            <p class="settings-hero-kicker">Label printer</p>
                            <h3 class="settings-section-title !mb-2">Shelf labels and barcode labels</h3>
                        </div>
                        <button
                            class="rounded-full border px-4 py-2 text-sm font-black transition-all {label.enabled ? 'border-success bg-success/10 text-success' : 'border-border-flat bg-bg-panel text-text-muted'}"
                            on:click={() => updateSetting('label_printer_enabled', label.enabled ? 'false' : 'true')}
                        >
                            Label {label.enabled ? 'Enabled' : 'Disabled'}
                        </button>
                    </div>

                    <div class="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
                        {#each labelConnections as option}
                            <button
                                class={modeCardClass(label.connection === option.value, option.enabled)}
                                aria-pressed={label.connection === option.value}
                                disabled={!option.enabled}
                                on:click={() => selectLabelConnection(option.value)}
                            >
                                <span class="text-sm font-black leading-tight text-text-main">{option.label}</span>
                                {#if label.connection === option.value}
                                    <span class="mt-auto w-max rounded-full bg-success/10 px-2 py-0.5 text-[0.68rem] font-black uppercase tracking-[0.06em] text-success">Selected</span>
                                {/if}
                            </button>
                        {/each}
                    </div>

                    <div class="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
                        <div class={compactInfoCardClass('accent')}>
                            <span class="text-xs font-black uppercase tracking-[0.12em] text-text-muted">Selected mode</span>
                            <strong class="mt-2 block text-sm leading-tight text-text-main">{labelMode?.label || label.connection}</strong>
                        </div>
                        <button class={switchCardClass(label.cutPaper)} on:click={() => updateSetting('label_printer_cut_paper', label.cutPaper ? 'false' : 'true')}>
                            <span class="text-sm font-black leading-tight text-text-main">Cut after label</span>
                            <b class="mt-auto text-xs uppercase tracking-[0.12em] {label.cutPaper ? 'text-success' : 'text-text-muted'}">{label.cutPaper ? 'On' : 'Off'}</b>
                        </button>
                        <div class={compactInfoCardClass()}>
                            <label class="text-sm font-black leading-tight text-text-main" for="label-gap-lines">Label gap / feed</label>
                            <input
                                id="label-gap-lines"
                                class="mt-2 h-11"
                                type="number"
                                min="0"
                                max="12"
                                value={label.gapLines}
                                on:change={(event) => updateSetting('label_printer_gap_lines', event.currentTarget.value || '0')}
                            />
                        </div>
                    </div>

                    <div class="mt-5 rounded-xl border border-border-flat bg-bg-panel p-4">
                        <div class="mb-4">
                            <h4 class="m-0 text-base font-black">Label connection details</h4>
                        </div>
                        <div class="form-grid">
                            <CustomSelect
                                label="Direct Label Protocol"
                                value={label.protocol}
                                options={labelProtocolOptions}
                                on:change={(event) => selectLabelProtocol(String(event.detail) as LabelPrinterProtocol)}
                            />
                            {#if label.connection !== 'system'}
                                <CustomSelect
                                    label="Print Resolution (DPI)"
                                    value={String(label.dpi)}
                                    options={labelDpiOptions}
                                    on:change={(event) => updateSetting('label_printer_dpi', String(event.detail))}
                                />
                            {/if}
                            {#if label.connection === 'system'}
                                <div class="rounded-xl border border-dashed border-border-flat bg-bg-card p-4">
                                    <b class="text-text-main">System printer mode</b>
                                </div>
                            {:else if label.connection === 'network_escpos'}
                                <div class="field">
                                    <label>Label Printer IP</label>
                                    <input
                                        value={label.host}
                                        placeholder="e.g. 192.168.1.51"
                                        on:change={(event) => updateSetting('label_printer_host', event.currentTarget.value.trim())}
                                    />
                                </div>
                                <div class="field">
                                    <label>Network Label Port</label>
                                    <input
                                        type="number"
                                        min="1"
                                        max="65535"
                                        value={label.port}
                                        on:change={(event) => updateSetting('label_printer_port', event.currentTarget.value || '9100')}
                                    />
                                </div>
                            {:else if label.connection === 'usb_raw'}
                                <div class="field">
                                    <CustomSelect
                                        label="Installed Windows Printer"
                                        value={label.printerName}
                                        options={labelPrinterOptions}
                                        placeholder={findingPrinters ? 'Loading installed printers...' : 'Choose installed printer...'}
                                        emptyText="No installed printers found."
                                        on:change={(event) => updateSetting('label_printer_name', String(event.detail))}
                                    />
                                </div>
                            {:else}
                                <div class="field">
                                    <label>{label.connection === 'bluetooth' ? 'Bluetooth COM Port' : 'Serial / COM Port'}</label>
                                    <input
                                        value={label.devicePath}
                                        placeholder="e.g. COM4 or /dev/tty.Bluetooth-Serial"
                                        on:change={(event) => updateSetting('label_printer_device_path', event.currentTarget.value.trim())}
                                    />
                                </div>
                            {/if}
                        </div>
                    </div>
                </section>
            </div>
        </div>
    </div>
</MgmtPage>
