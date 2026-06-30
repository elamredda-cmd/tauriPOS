<script lang="ts">
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
        type PrinterConnectionType,
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
    $: drawerPrinterOptions = printerOptionsFor(explicitDrawerPrinterName);
    let receiptTestStatus = '';
    let labelTestStatus = '';
    let drawerTestStatus = '';
    let printerFinderStatus = '';
    let findingPrinters = false;
    let foundPrinters: SystemPrinterInfo[] = [];

    type SystemPrinterInfo = {
        name: string;
        driverName?: string;
        portName?: string;
    };

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
        return /xprinter|receipt|thermal|pos|epson|star|bixolon|citizen|tm-|zebra|tsc/i.test(
            `${printer.name} ${printer.driverName || ''} ${printer.portName || ''}`
        );
    }

    function printerLabel(printer: SystemPrinterInfo): string {
        const details = [printer.driverName, printer.portName].filter(Boolean).join(' / ');
        const suggested = isLikelyThermalPrinter(printer) ? ' (suggested)' : '';
        return `${printer.name}${suggested}${details ? ` - ${details}` : ''}`;
    }

    function printerOptionsFor(currentName: string) {
        const options = foundPrinters.map((printer) => ({
            label: printerLabel(printer),
            value: printer.name,
        }));
        if (currentName.trim() && !options.some((option) => option.value === currentName.trim())) {
            options.unshift({ label: `${currentName.trim()} (current)`, value: currentName.trim() });
        }
        return options;
    }

    async function findSystemPrinters() {
        findingPrinters = true;
        printerFinderStatus = 'Finding installed printers...';
        try {
            const printers = await invoke<SystemPrinterInfo[]>('list_system_printers');
            foundPrinters = printers;
            if (printers.length === 0) {
                printerFinderStatus = 'No installed printers were found on this machine.';
                return;
            }
            const suggested = printers.find(isLikelyThermalPrinter);
            printerFinderStatus = suggested
                ? `Found ${printers.length} printer${printers.length === 1 ? '' : 's'}. Suggested: ${suggested.name}.`
                : `Found ${printers.length} printer${printers.length === 1 ? '' : 's'}. Choose the one that matches your printer.`;
        } catch (error) {
            printerFinderStatus = `Could not find printers: ${error}`;
            toast(`Could not find printers: ${error}`, 'error');
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

    const receiptConnections: Array<{ value: PrinterConnectionType; label: string; note: string; enabled: boolean }> = [
        { value: 'system', label: 'System / driver print', note: 'Uses the normal Windows/macOS printer driver. Best for manual printing.', enabled: true },
        { value: 'network_escpos', label: 'ESC/POS network', note: 'Direct thermal receipt printing by IP address, normally port 9100.', enabled: true },
        { value: 'usb_raw', label: 'Windows USB raw', note: 'Silent Windows USB printing by exact installed printer name.', enabled: true },
        { value: 'serial', label: 'Serial / COM', note: 'Direct serial/COM device path such as COM3 or /dev/tty.usbserial.', enabled: true },
        { value: 'bluetooth', label: 'Bluetooth', note: 'Bluetooth SPP printers usually appear as a COM port/device path.', enabled: true },
    ];

    const labelConnections: Array<{ value: PrinterConnectionType; label: string; note: string; enabled: boolean }> = [
        { value: 'system', label: 'System / driver print', note: 'Uses the normal Windows/macOS print dialog.', enabled: true },
        { value: 'network_escpos', label: 'Network label printer', note: 'Direct ZPL/TSPL label printing by IP address.', enabled: true },
        { value: 'usb_raw', label: 'Windows USB raw', note: 'Silent Windows USB label printing by exact installed printer name.', enabled: true },
        { value: 'serial', label: 'Serial / COM', note: 'Direct serial/COM device path.', enabled: true },
        { value: 'bluetooth', label: 'Bluetooth', note: 'Bluetooth SPP printers usually appear as a COM port/device path.', enabled: true },
    ];

    const paperWidthOptions = [
        { label: '80mm receipt paper', value: '80mm' },
        { label: '58mm receipt paper', value: '58mm' },
    ];

    const encodingOptions = [
        { label: 'Latin-1 / common ESC/POS', value: 'latin1' },
        { label: 'UTF-8', value: 'utf8' },
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
                    <p class="settings-hero-copy">
                        Choose the connection type first. The page then only shows the fields needed for that printer mode.
                    </p>
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

        <div class="grid grid-cols-1 gap-5 2xl:grid-cols-[minmax(0,1fr)_380px]">
            <div class="flex flex-col gap-5">
                <section class="settings-section">
                    <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                        <div>
                            <p class="settings-hero-kicker">Receipt printer</p>
                            <h3 class="settings-section-title !mb-2">Customer receipts</h3>
                            <p class="mt-2 max-w-2xl text-sm text-text-muted">
                                Network ESC/POS is fastest for Ethernet printers. USB raw is best for silent Windows USB printing.
                            </p>
                        </div>
                        <button
                            class="rounded-full border px-4 py-2 text-sm font-black transition-all {receipt.enabled ? 'border-success bg-success/10 text-success' : 'border-border-flat bg-bg-panel text-text-muted'}"
                            on:click={() => updateSetting('receipt_printer_enabled', receipt.enabled ? 'false' : 'true')}
                        >
                            Receipt {receipt.enabled ? 'Enabled' : 'Disabled'}
                        </button>
                    </div>

                    <div class="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
                        {#each receiptConnections as option}
                            <button
                                class={modeCardClass(receipt.connection === option.value, option.enabled)}
                                aria-pressed={receipt.connection === option.value}
                                disabled={!option.enabled}
                                on:click={() => updateSetting('receipt_printer_connection', option.value)}
                            >
                                <span class="text-sm font-black leading-tight text-text-main">{option.label}</span>
                                <span class="line-clamp-3 text-xs leading-snug text-text-muted">{option.note}</span>
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
                            <p class="m-0 mt-2 line-clamp-4 text-xs leading-snug text-text-muted">{receiptMode?.note}</p>
                        </div>

                        <div class="rounded-xl border border-border-flat bg-bg-panel p-4">
                            <div class="mb-4 flex items-center justify-between gap-3">
                                <div>
                                    <h4 class="m-0 text-base font-black">Connection details</h4>
                                    <p class="m-0 mt-1 text-sm text-text-muted">Only the useful fields for the selected mode are shown.</p>
                                </div>
                            </div>
                            <div class="form-grid">
                                {#if receipt.connection === 'system'}
                                    <div class="span-2 rounded-xl border border-dashed border-border-flat bg-bg-card p-4">
                                        <b class="text-text-main">System printer mode</b>
                                        <p class="m-0 mt-1 text-sm text-text-muted">
                                            This uses the normal Windows/macOS print dialog. It is good for manual receipt printing, but it cannot silently auto-print after payment.
                                        </p>
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
                                        <small class="text-text-muted">Most network thermal printers use port 9100.</small>
                                    </div>
                                {:else if receipt.connection === 'usb_raw'}
                                    <div class="field span-2">
                                        <div class="flex flex-wrap items-center justify-between gap-2">
                                            <label>Windows Printer Name</label>
                                            <button type="button" class="btn btn-secondary" on:click={findSystemPrinters} disabled={findingPrinters}>
                                                {findingPrinters ? 'Finding...' : 'Find printers'}
                                            </button>
                                        </div>
                                        {#if receiptPrinterOptions.length > 0}
                                            <CustomSelect
                                                value={receipt.printerName}
                                                options={receiptPrinterOptions}
                                                placeholder="Choose printer..."
                                                on:change={(event) => updateSetting('receipt_printer_name', String(event.detail))}
                                            />
                                        {:else}
                                            <input
                                                value={receipt.printerName}
                                                placeholder="e.g. Xprinter USB"
                                                on:change={(event) => updateSetting('receipt_printer_name', event.currentTarget.value.trim())}
                                            />
                                        {/if}
                                        <small class="text-text-muted">Use the exact installed Windows printer name. This is the best mode for silent USB printing on Windows.</small>
                                        {#if printerFinderStatus}<small class="text-text-muted">{printerFinderStatus}</small>{/if}
                                    </div>
                                {:else}
                                    <div class="field span-2">
                                        <label>{receipt.connection === 'bluetooth' ? 'Bluetooth COM Port' : 'Serial / COM Port'}</label>
                                        <input
                                            value={receipt.devicePath}
                                            placeholder="e.g. COM3 or /dev/tty.usbserial"
                                            on:change={(event) => updateSetting('receipt_printer_device_path', event.currentTarget.value.trim())}
                                        />
                                        <small class="text-text-muted">Bluetooth SPP printers normally appear as a COM port. Set baud/port options in Windows device settings if needed.</small>
                                    </div>
                                {/if}
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
                            <p class="m-0 text-sm text-text-muted">Small controls for what happens after the sale is saved.</p>
                        </div>
                        <div class="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
                            <button class={switchCardClass(receipt.autoPrintAfterPayment)} on:click={() => updateSetting('receipt_printer_auto_print_after_payment', receipt.autoPrintAfterPayment ? 'false' : 'true')}>
                                <span class="text-sm font-black leading-tight text-text-main">Auto print</span>
                                <small class="line-clamp-3 text-xs leading-snug text-text-muted">Print receipt automatically after payment.</small>
                                <b class="mt-auto text-xs text-success">{receipt.autoPrintAfterPayment ? 'On' : 'Off'}</b>
                            </button>
                            <button class={switchCardClass(receipt.cutPaper)} on:click={() => updateSetting('receipt_printer_cut_paper', receipt.cutPaper ? 'false' : 'true')}>
                                <span class="text-sm font-black leading-tight text-text-main">Cut paper</span>
                                <small class="line-clamp-3 text-xs leading-snug text-text-muted">Send cutter command after receipt.</small>
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
                                <small class="mt-2 block line-clamp-2 text-xs text-text-muted">Keeps footer above cutter.</small>
                            </div>
                            <button class={switchCardClass(receipt.openDrawerAfterPayment)} on:click={() => updateSetting('receipt_printer_open_drawer_after_payment', receipt.openDrawerAfterPayment ? 'false' : 'true')}>
                                <span class="text-sm font-black leading-tight text-text-main">Open drawer</span>
                                <small class="line-clamp-3 text-xs leading-snug text-text-muted">Open drawer after every payment.</small>
                                <b class="mt-auto text-xs text-success">{receipt.openDrawerAfterPayment ? 'On' : 'Off'}</b>
                            </button>
                        </div>
                    </div>

                    <div class="mt-5 rounded-xl border border-border-flat bg-bg-panel p-4">
                        <div class="mb-4 flex flex-col gap-1">
                            <h4 class="m-0 text-base font-black text-text-main">Cash drawer pulse</h4>
                            <p class="m-0 text-sm text-text-muted">The drawer normally plugs into the receipt printer. Leave the separate target fields empty for that setup.</p>
                        </div>
                        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                            <button
                                class={switchCardClass(drawerManualEnabled)}
                                on:click={() => updateSetting('cash_drawer_enabled', drawerManualEnabled ? 'false' : 'true')}
                            >
                                <span class="text-sm font-black leading-tight text-text-main">Drawer pulse</span>
                                <small class="text-xs leading-snug text-text-muted">Allow the printer to open the cash drawer.</small>
                                <b class="mt-auto text-xs text-success">{drawerManualEnabled ? 'Enabled' : 'Disabled'}</b>
                            </button>
                            <button class={switchCardClass(false)} on:click={testDrawer}>
                                <span class="text-sm font-black leading-tight text-text-main">Test drawer</span>
                                <small class="text-xs leading-snug text-text-muted">Send one kick pulse now.</small>
                                <b class="mt-auto text-xs text-accent-primary">Open now</b>
                            </button>
                            <div class={compactInfoCardClass()}>
                                <span class="text-xs font-black uppercase tracking-[0.12em] text-text-muted">Target</span>
                                <strong class="mt-2 block text-sm leading-tight text-text-main">
                                    {drawerUsesReceiptPrinter ? `Receipt printer: ${drawerTarget || 'set receipt printer first'}` : drawerTarget}
                                </strong>
                                <small class="mt-2 block text-xs text-text-muted">
                                    {drawerUsesReceiptPrinter ? 'Connected through the configured receipt printer.' : 'Using separate drawer target below.'}
                                </small>
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
                                <small class="mt-2 block text-xs text-text-muted">50 / 250 works for most Epson-compatible printers.</small>
                            </div>
                            <div class="rounded-xl border border-border-flat bg-bg-card p-3 sm:col-span-2 xl:col-span-4">
                                <div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                                    <div>
                                        <label class="text-sm font-black leading-tight text-text-main">Separate drawer target</label>
                                        <p class="m-0 mt-1 text-xs text-text-muted">Only fill these if the drawer is not connected to the receipt printer.</p>
                                    </div>
                                    <button type="button" class="btn btn-secondary" on:click={useReceiptPrinterForDrawer} disabled={drawerUsesReceiptPrinter}>
                                        Use Receipt Printer
                                    </button>
                                </div>
                                <div class="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-3">
                                    <div class="field">
                                        <div class="flex flex-wrap items-center justify-between gap-2">
                                            <label>Separate Windows Printer</label>
                                            <button type="button" class="btn btn-secondary" on:click={findSystemPrinters} disabled={findingPrinters}>
                                                {findingPrinters ? 'Finding...' : 'Find printers'}
                                            </button>
                                        </div>
                                        {#if drawerPrinterOptions.length > 0}
                                            <CustomSelect
                                                value={explicitDrawerPrinterName}
                                                options={drawerPrinterOptions}
                                                placeholder="Use receipt printer"
                                                on:change={(event) => setSeparateDrawerTarget('printer', String(event.detail))}
                                            />
                                        {:else}
                                            <input
                                                value={explicitDrawerPrinterName}
                                                placeholder="Leave empty to use receipt printer"
                                                on:change={(event) => setSeparateDrawerTarget('printer', event.currentTarget.value)}
                                            />
                                        {/if}
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
                                        <small class="text-text-muted">Used only when a separate drawer IP is entered.</small>
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
                            <p class="mt-2 max-w-2xl text-sm text-text-muted">
                                Use ESC/POS for your Xprinter USB setup. Use TSPL only if the printer understands TSPL and does not print command text.
                            </p>
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
                                on:click={() => updateSetting('label_printer_connection', option.value)}
                            >
                                <span class="text-sm font-black leading-tight text-text-main">{option.label}</span>
                                <span class="line-clamp-3 text-xs leading-snug text-text-muted">{option.note}</span>
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
                            <p class="m-0 mt-2 line-clamp-3 text-xs leading-snug text-text-muted">{labelMode?.note}</p>
                        </div>
                        <button class={switchCardClass(label.cutPaper)} on:click={() => updateSetting('label_printer_cut_paper', label.cutPaper ? 'false' : 'true')}>
                            <span class="text-sm font-black leading-tight text-text-main">Cut after label</span>
                            <span class="line-clamp-3 text-xs leading-snug text-text-muted">Send cutter command after label.</span>
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
                            <small class="mt-2 block line-clamp-2 text-xs text-text-muted">Use 0 for ESC/POS. Use 2 or 3mm only when TSPL works correctly.</small>
                        </div>
                    </div>

                    <div class="mt-5 rounded-xl border border-border-flat bg-bg-panel p-4">
                        <div class="mb-4">
                            <h4 class="m-0 text-base font-black">Label connection details</h4>
                            <p class="m-0 mt-1 text-sm text-text-muted">Use TSPL for Xprinter sticker label printers. Use ESC/POS for receipt printers.</p>
                        </div>
                        <div class="form-grid">
                            <CustomSelect
                                label="Direct Label Protocol"
                                value={label.protocol}
                                options={labelProtocolOptions}
                                on:change={(event) => updateSetting('label_printer_protocol', String(event.detail))}
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
                                    <p class="m-0 mt-1 text-sm text-text-muted">This opens the normal print dialog. For thermal printing without A4, choose USB raw, Network, Serial, or Bluetooth.</p>
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
                                    <div class="flex flex-wrap items-center justify-between gap-2">
                                        <label>Windows Printer Name</label>
                                        <button type="button" class="btn btn-secondary" on:click={findSystemPrinters} disabled={findingPrinters}>
                                            {findingPrinters ? 'Finding...' : 'Find printers'}
                                        </button>
                                    </div>
                                    {#if labelPrinterOptions.length > 0}
                                        <CustomSelect
                                            value={label.printerName}
                                            options={labelPrinterOptions}
                                            placeholder="Choose printer..."
                                            on:change={(event) => updateSetting('label_printer_name', String(event.detail))}
                                        />
                                    {:else}
                                        <input
                                            value={label.printerName}
                                            placeholder="e.g. Xprinter USB"
                                            on:change={(event) => updateSetting('label_printer_name', event.currentTarget.value.trim())}
                                        />
                                    {/if}
                                    <small class="text-text-muted">For USB raw mode, use the exact Windows printer name.</small>
                                    {#if printerFinderStatus}<small class="text-text-muted">{printerFinderStatus}</small>{/if}
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

            <aside class="settings-section self-start 2xl:sticky 2xl:top-4">
                <p class="settings-hero-kicker">Quick guide</p>
                <h3 class="settings-section-title !mb-3">What to choose</h3>
                <div class="mt-5 flex flex-col gap-3">
                    <div class="settings-mini-card">
                        <b class="text-text-main">USB receipt printer</b>
                        <p class="m-0 mt-1 text-sm text-text-muted">Install the Windows printer driver, then use USB raw with the exact Windows printer name for silent printing.</p>
                    </div>
                    <div class="settings-mini-card">
                        <b class="text-text-main">Network receipt printer</b>
                        <p class="m-0 mt-1 text-sm text-text-muted">Give the printer a fixed IP, use ESC/POS network, port 9100, then test print.</p>
                    </div>
                    <div class="settings-mini-card">
                        <b class="text-text-main">Serial / Bluetooth</b>
                        <p class="m-0 mt-1 text-sm text-text-muted">Pair or install the printer so it appears as a COM/device path, then use Serial or Bluetooth mode.</p>
                    </div>
                    <div class="settings-mini-card">
                        <b class="text-text-main">Cash drawer</b>
                        <p class="m-0 mt-1 text-sm text-text-muted">The drawer normally plugs into the receipt printer, not the computer. Turn on Drawer after payment if needed.</p>
                    </div>
                    <div class="settings-mini-card">
                        <b class="text-text-main">Label printer</b>
                        <p class="m-0 mt-1 text-sm text-text-muted">Use ZPL for Zebra-style printers or TSPL for TSC-style printers when using direct printing.</p>
                    </div>
                </div>
            </aside>
        </div>
    </div>
</MgmtPage>
