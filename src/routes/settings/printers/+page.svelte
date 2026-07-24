<script lang="ts">
    import { onMount } from 'svelte';
    import { invoke, isTauri } from '@tauri-apps/api/core';
    import { open } from '@tauri-apps/plugin-dialog';
    import {
        Archive,
        Blocks,
        Bluetooth,
        Cable,
        Check,
        Monitor,
        Network,
        PackagePlus,
        Play,
        Power,
        Printer,
        ReceiptText,
        RefreshCw,
        ShieldCheck,
        Stethoscope,
        Tags,
        Trash2,
        Usb,
    } from '@lucide/svelte';
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
    import {
        executePrinterModule,
        installPrinterModule,
        listPrinterModules,
        setPrinterModuleEnabled,
        uninstallPrinterModule,
        type PrinterModuleInfo,
    } from '$lib/printerModules';

    $: receipt = getReceiptPrinterConfig($settingsDB);
    $: label = getLabelPrinterConfig($settingsDB);
    $: drawer = getCashDrawerConfig($settingsDB);
    $: drawerTarget = cashDrawerTargetLabel(drawer);
    $: explicitDrawerHost = settingValue('cash_drawer_printer_host');
    $: explicitDrawerPrinterName = settingValue('cash_drawer_printer_name');
    $: explicitDrawerDevicePath = settingValue('cash_drawer_printer_device_path');
    $: explicitDrawerModuleId = settingValue('cash_drawer_module_id');
    $: explicitDrawerModuleDeviceId = settingValue('cash_drawer_module_device_id');
    $: drawerUsesReceiptPrinter = !explicitDrawerHost.trim()
        && !explicitDrawerPrinterName.trim()
        && !explicitDrawerDevicePath.trim()
        && !explicitDrawerModuleId.trim();
    $: drawerManualEnabled = ($settingsDB.find((item) => item.key === 'cash_drawer_enabled')?.value ?? (drawerTarget ? 'true' : 'false')) !== 'false';
    $: receiptMode = receiptConnections.find((option) => option.value === receipt.connection);
    $: labelMode = labelConnections.find((option) => option.value === label.connection);
    $: receiptEncodingOptions = receipt.model === 'star_tsp100'
        ? [{ label: 'Windows-1252 / UK (required by Star)', value: 'latin1' }]
        : encodingOptions;
    $: receiptPrinterOptions = printerOptionsFor(receipt.printerName);
    $: labelPrinterOptions = printerOptionsFor(label.printerName);
    $: drawerPrinterOptions = printerOptionsFor(
        explicitDrawerPrinterName,
        { label: 'Use receipt printer', value: '' },
    );
    $: activeModules = printerModules.filter((module) => module.enabled && module.compatible && module.trusted);
    $: moduleOptions = activeModules.map((module) => ({
        label: `${module.name} - ${module.vendor} v${module.version}`,
        value: module.id,
    }));
    let receiptTestStatus = '';
    let labelTestStatus = '';
    let drawerTestStatus = '';
    let findingPrinters = false;
    let foundPrinters: SystemPrinterInfo[] = [];
    let printerModules: PrinterModuleInfo[] = [];
    let modulesLoading = false;
    let moduleBusyId = '';
    let activeSection: PrinterSection = 'receipt';
    let drawerTargetEditorOpen = false;
    let drawerTargetEditorMode: DrawerTargetEditorMode = 'printer';

    type PrinterSection = 'receipt' | 'label' | 'drawer' | 'modules';
    type DrawerTargetEditorMode = 'printer' | 'network' | 'device' | 'module';

    type SystemPrinterInfo = {
        name: string;
        driverName?: string;
        portName?: string;
    };

    onMount(() => {
        void findSystemPrinters({ quiet: true });
        void refreshPrinterModules(true);
    });

    $: if (explicitDrawerModuleId.trim()) {
        drawerTargetEditorMode = 'module';
        drawerTargetEditorOpen = true;
    } else if (explicitDrawerHost.trim()) {
        drawerTargetEditorMode = 'network';
        drawerTargetEditorOpen = true;
    } else if (explicitDrawerDevicePath.trim()) {
        drawerTargetEditorMode = 'device';
        drawerTargetEditorOpen = true;
    } else if (explicitDrawerPrinterName.trim()) {
        drawerTargetEditorMode = 'printer';
        drawerTargetEditorOpen = true;
    }

    async function refreshPrinterModules(quiet = false) {
        modulesLoading = true;
        try {
            printerModules = await listPrinterModules();
        } catch (error) {
            printerModules = [];
            if (!quiet) toast(`Could not load printer modules: ${error}`, 'error');
        } finally {
            modulesLoading = false;
        }
    }

    async function installModule() {
        if (!isTauri()) {
            toast('Printer modules can be installed from the desktop POS app', 'info');
            return;
        }
        moduleBusyId = 'install';
        try {
            const selected = await open({
                title: 'Install signed printer module',
                multiple: false,
                filters: [{ name: 'L&Bj printer module', extensions: ['lbjprinter'] }],
            });
            if (!selected || Array.isArray(selected)) return;
            const installed = await installPrinterModule(selected);
            await refreshPrinterModules(true);
            toast(`${installed.name} installed`, 'success');
        } catch (error) {
            toast(`Printer module was not installed: ${error}`, 'error');
        } finally {
            moduleBusyId = '';
        }
    }

    async function toggleModule(module: PrinterModuleInfo) {
        moduleBusyId = module.id;
        try {
            await setPrinterModuleEnabled(module.id, !module.enabled);
            await refreshPrinterModules(true);
            toast(`${module.name} ${module.enabled ? 'disabled' : 'enabled'}`, 'success');
        } catch (error) {
            toast(`Could not change printer module: ${error}`, 'error');
        } finally {
            moduleBusyId = '';
        }
    }

    function moduleInUse(moduleId: string): boolean {
        return receipt.moduleId === moduleId || label.moduleId === moduleId || drawer.moduleId === moduleId;
    }

    async function removeModule(module: PrinterModuleInfo) {
        if (moduleInUse(module.id)) {
            toast('Switch the receipt and label printers away from this module first', 'error');
            return;
        }
        if (!window.confirm(`Uninstall ${module.name}?`)) return;
        moduleBusyId = module.id;
        try {
            await uninstallPrinterModule(module.id);
            await refreshPrinterModules(true);
            toast(`${module.name} uninstalled`, 'success');
        } catch (error) {
            toast(`Could not uninstall printer module: ${error}`, 'error');
        } finally {
            moduleBusyId = '';
        }
    }

    async function testModule(module: PrinterModuleInfo) {
        moduleBusyId = module.id;
        try {
            const result = await executePrinterModule(module.id, 'healthCheck');
            toast(result.message || `${module.name} is ready`, 'success');
        } catch (error) {
            toast(`${module.name} check failed: ${error}`, 'error');
        } finally {
            moduleBusyId = '';
        }
    }

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
        await updateSetting('cash_drawer_module_id', '');
        await updateSetting('cash_drawer_module_device_id', '');
        drawerTargetEditorOpen = false;
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
        if (connection === 'module' && !receipt.moduleId && activeModules[0]) {
            await updateSetting('receipt_printer_module_id', activeModules[0].id);
        }
    }

    async function selectLabelConnection(connection: PrinterConnectionType) {
        await updateSetting('label_printer_connection', connection);
        if (connection === 'system') {
            await updateSetting('label_printer_protocol', 'system');
        } else if (label.protocol === 'system') {
            await updateSetting('label_printer_protocol', 'escpos');
        }
        if (connection === 'usb_raw') void findSystemPrinters({ quiet: true });
        if (connection === 'module' && !label.moduleId && activeModules[0]) {
            await updateSetting('label_printer_module_id', activeModules[0].id);
        }
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
        await updateSetting('cash_drawer_module_id', '');
        await updateSetting('cash_drawer_module_device_id', '');
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

    async function setSeparateDrawerModule(moduleId: string) {
        await updateSetting('cash_drawer_module_id', moduleId.trim());
        await updateSetting('cash_drawer_printer_host', '');
        await updateSetting('cash_drawer_printer_name', '');
        await updateSetting('cash_drawer_printer_device_path', '');
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

    const sections: Array<{ value: PrinterSection; label: string; icon: typeof Printer; status: () => string }> = [
        { value: 'receipt', label: 'Receipt', icon: ReceiptText, status: () => receipt.enabled ? 'On' : 'Off' },
        { value: 'label', label: 'Labels', icon: Tags, status: () => label.enabled ? 'On' : 'Off' },
        { value: 'drawer', label: 'Drawer', icon: Archive, status: () => drawerManualEnabled ? 'On' : 'Off' },
        { value: 'modules', label: 'Modules', icon: Blocks, status: () => String(printerModules.length) },
    ];

    const receiptConnections: Array<{ value: PrinterConnectionType; label: string; enabled: boolean; icon: typeof Printer }> = [
        { value: 'system', label: 'System driver', enabled: true, icon: Monitor },
        { value: 'network_escpos', label: 'ESC/POS network', enabled: true, icon: Network },
        { value: 'usb_raw', label: 'Windows USB', enabled: true, icon: Usb },
        { value: 'serial', label: 'Serial / COM', enabled: true, icon: Cable },
        { value: 'bluetooth', label: 'Bluetooth', enabled: true, icon: Bluetooth },
        { value: 'module', label: 'SDK module', enabled: true, icon: Blocks },
    ];

    const labelConnections: Array<{ value: PrinterConnectionType; label: string; enabled: boolean; icon: typeof Printer }> = [
        { value: 'system', label: 'System driver', enabled: true, icon: Monitor },
        { value: 'network_escpos', label: 'Network printer', enabled: true, icon: Network },
        { value: 'usb_raw', label: 'Windows USB', enabled: true, icon: Usb },
        { value: 'serial', label: 'Serial / COM', enabled: true, icon: Cable },
        { value: 'bluetooth', label: 'Bluetooth', enabled: true, icon: Bluetooth },
        { value: 'module', label: 'SDK module', enabled: true, icon: Blocks },
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

    const drawerTargetTypeOptions = [
        { label: 'Windows printer', value: 'printer' },
        { label: 'Network printer', value: 'network' },
        { label: 'Serial / COM device', value: 'device' },
        { label: 'Installed SDK module', value: 'module' },
    ];

    const labelProtocolOptions = [
        { label: 'System printer / driver', value: 'system' },
        { label: 'ESC/POS / Xprinter USB', value: 'escpos' },
        { label: 'Star TSP100 / Star Graphic', value: 'star' },
        { label: 'ZPL / Zebra style', value: 'zpl' },
        { label: 'TSPL / TSC style', value: 'tspl' },
    ];

    const labelDpiOptions = [
        { label: '203 DPI (8 dots/mm)', value: '203' },
        { label: '300 DPI (12 dots/mm)', value: '300' },
        { label: '600 DPI (24 dots/mm)', value: '600' },
    ];

    const baudRateOptions = [
        { label: '9,600 baud', value: '9600' },
        { label: '19,200 baud', value: '19200' },
        { label: '38,400 baud', value: '38400' },
        { label: '57,600 baud', value: '57600' },
        { label: '115,200 baud', value: '115200' },
    ];
</script>

<MgmtPage title="Printer Setup" backFallback="/settings">
    <div class="settings-page-shell printer-page-shell">
        <section class="printer-overview" aria-label="Printer hardware status">
            <div class="printer-overview-title">
                <span class="printer-overview-icon"><Printer size={25} /></span>
                <div>
                    <span>Hardware setup</span>
                    <h2>Printer hardware</h2>
                </div>
            </div>
            <div class="printer-status-strip">
                <span class:online={receipt.enabled}><i></i>Receipt</span>
                <span class:online={label.enabled}><i></i>Labels</span>
                <span class:online={drawerManualEnabled}><i></i>Drawer</span>
            </div>
        </section>

        <div class="printer-tabs" role="tablist" aria-label="Printer settings sections">
            {#each sections as section}
                <button
                    id={`${section.value}-tab`}
                    type="button"
                    role="tab"
                    aria-selected={activeSection === section.value}
                    aria-controls={`${section.value}-panel`}
                    class:active={activeSection === section.value}
                    on:click={() => activeSection = section.value}
                >
                    <svelte:component this={section.icon} size={21} />
                    <strong>{section.label}</strong>
                    <span>{section.status()}</span>
                </button>
            {/each}
        </div>

        {#if activeSection === 'receipt'}
            <div id="receipt-panel" class="printer-panel" role="tabpanel" aria-labelledby="receipt-tab">
                <header class="printer-panel-header">
                    <div>
                        <span>Receipt printer</span>
                        <h3>Customer receipts</h3>
                        <p>{receiptMode?.label || receipt.connection}</p>
                    </div>
                    <div class="printer-panel-actions">
                        <button
                            class="btn btn-secondary preset-button"
                            class:active={receipt.model === 'star_tsp100'}
                            aria-pressed={receipt.model === 'star_tsp100'}
                            on:click={toggleStarTsp100Preset}
                        >
                            {receipt.model === 'star_tsp100' ? 'Cancel Star preset' : 'Star TSP100 preset'}
                        </button>
                        <button class="btn btn-secondary" on:click={testReceiptPrinter} disabled={!receipt.enabled}>
                            <Play size={17} /> Test Receipt
                        </button>
                        <button
                            class="compact-switch"
                            class:enabled={receipt.enabled}
                            role="switch"
                            aria-checked={receipt.enabled}
                            on:click={() => updateSetting('receipt_printer_enabled', receipt.enabled ? 'false' : 'true')}
                        >
                            <span>Receipt</span><i><b></b></i>
                        </button>
                    </div>
                </header>

                {#if receiptTestStatus}<p class="printer-result" role="status">{receiptTestStatus}</p>{/if}

                <div class="printer-group">
                    <div class="printer-group-title"><h4>Connection</h4><span>{receiptMode?.label || receipt.connection}</span></div>
                    <div class="connection-grid">
                        {#each receiptConnections as option}
                            <button
                                class:active={receipt.connection === option.value}
                                aria-pressed={receipt.connection === option.value}
                                disabled={!option.enabled}
                                on:click={() => selectReceiptConnection(option.value)}
                            >
                                <svelte:component this={option.icon} size={22} />
                                <strong>{option.label}</strong>
                                {#if receipt.connection === option.value}<span class="connection-check"><Check size={17} /></span>{/if}
                            </button>
                        {/each}
                    </div>
                </div>

                <div class="printer-group">
                    <div class="printer-group-title"><h4>Printer details</h4></div>
                    <div class="printer-form-grid">
                        {#if receipt.connection === 'system'}
                            <div class="printer-readout span-all"><Monitor size={20} /><span><small>Connection</small><strong>System printer dialog</strong></span></div>
                        {:else if receipt.connection === 'network_escpos'}
                            <div class="field">
                                <label for="receipt-host">Printer IP</label>
                                <input id="receipt-host" value={receipt.host} placeholder="e.g. 192.168.1.50" on:change={(event) => updateSetting('receipt_printer_host', event.currentTarget.value.trim())} />
                            </div>
                            <div class="field">
                                <label for="receipt-port">Port</label>
                                <input id="receipt-port" type="number" min="1" max="65535" value={receipt.port} on:change={(event) => updateSetting('receipt_printer_port', event.currentTarget.value || '9100')} />
                            </div>
                        {:else if receipt.connection === 'usb_raw'}
                            <div class="span-all">
                                <CustomSelect label="Installed Windows Printer" value={receipt.printerName} options={receiptPrinterOptions} placeholder={findingPrinters ? 'Loading installed printers...' : 'Choose installed printer...'} emptyText="No installed printers found." on:change={(event) => updateSetting('receipt_printer_name', String(event.detail))} />
                            </div>
                        {:else if receipt.connection === 'module'}
                            <CustomSelect label="Printer SDK Module" value={receipt.moduleId} options={moduleOptions} placeholder={modulesLoading ? 'Loading modules...' : 'Choose installed module...'} emptyText="No enabled printer modules installed." on:change={(event) => updateSetting('receipt_printer_module_id', String(event.detail))} />
                            <div class="field">
                                <label for="receipt-module-device">Module Device ID</label>
                                <input id="receipt-module-device" value={receipt.moduleDeviceId} placeholder="Module default" on:change={(event) => updateSetting('receipt_printer_module_device_id', event.currentTarget.value.trim())} />
                            </div>
                            {#if moduleOptions.length === 0}<button class="inline-action span-all" on:click={() => activeSection = 'modules'}><Blocks size={17} /> Open SDK Modules</button>{/if}
                        {:else}
                            <div class="field">
                                <label for="receipt-device-path">{receipt.connection === 'bluetooth' ? 'Bluetooth COM Port' : 'Serial / COM Port'}</label>
                                <input id="receipt-device-path" value={receipt.devicePath} placeholder="e.g. COM3" on:change={(event) => updateSetting('receipt_printer_device_path', event.currentTarget.value.trim())} />
                            </div>
                            <CustomSelect label="Baud Rate" value={String(receipt.baudRate)} options={baudRateOptions} on:change={(event) => updateSetting('receipt_printer_baud_rate', String(event.detail))} />
                        {/if}
                        <CustomSelect label="Printer Model" value={receipt.model} options={receiptModelOptions} on:change={(event) => updateSetting('receipt_printer_model', String(event.detail))} />
                        <CustomSelect label="Paper Width" value={receipt.paperWidth} options={paperWidthOptions} on:change={(event) => updateSetting('receipt_printer_paper_width', String(event.detail))} />
                        <CustomSelect label="Character Encoding" value={receipt.encoding} options={receiptEncodingOptions} on:change={(event) => updateSetting('receipt_printer_encoding', String(event.detail))} />
                    </div>
                </div>

                <div class="printer-group">
                    <div class="printer-group-title"><h4>After payment</h4></div>
                    <div class="setting-toggle-grid">
                        <button class:active={receipt.autoPrintAfterPayment} role="switch" aria-checked={receipt.autoPrintAfterPayment} on:click={() => updateSetting('receipt_printer_auto_print_after_payment', receipt.autoPrintAfterPayment ? 'false' : 'true')}><span>Auto print</span><i><b></b></i></button>
                        <button class:active={receipt.cutPaper} role="switch" aria-checked={receipt.cutPaper} on:click={() => updateSetting('receipt_printer_cut_paper', receipt.cutPaper ? 'false' : 'true')}><span>Cut paper</span><i><b></b></i></button>
                        <div class="field compact-number"><label for="receipt-cut-feed-lines">Feed before cut</label><input id="receipt-cut-feed-lines" type="number" min="0" max="20" value={receipt.cutFeedLines} on:change={(event) => updateSetting('receipt_printer_cut_feed_lines', event.currentTarget.value || '8')} /></div>
                        <button class:active={receipt.openDrawerAfterPayment} role="switch" aria-checked={receipt.openDrawerAfterPayment} on:click={() => updateSetting('receipt_printer_open_drawer_after_payment', receipt.openDrawerAfterPayment ? 'false' : 'true')}><span>Open drawer</span><i><b></b></i></button>
                    </div>
                </div>
            </div>
        {:else if activeSection === 'label'}
            <div id="label-panel" class="printer-panel" role="tabpanel" aria-labelledby="label-tab">
                <header class="printer-panel-header">
                    <div>
                        <span>Label printer</span>
                        <h3>Shelf and barcode labels</h3>
                        <p>{labelMode?.label || label.connection}</p>
                    </div>
                    <div class="printer-panel-actions">
                        <button class="btn btn-secondary" on:click={testLabelPrinter} disabled={!label.enabled || label.connection === 'system' || label.protocol === 'system'}><Play size={17} /> Test Label</button>
                        <button class="compact-switch" class:enabled={label.enabled} role="switch" aria-checked={label.enabled} on:click={() => updateSetting('label_printer_enabled', label.enabled ? 'false' : 'true')}><span>Labels</span><i><b></b></i></button>
                    </div>
                </header>

                {#if labelTestStatus}<p class="printer-result" role="status">{labelTestStatus}</p>{/if}

                <div class="printer-group">
                    <div class="printer-group-title"><h4>Connection</h4><span>{labelMode?.label || label.connection}</span></div>
                    <div class="connection-grid">
                        {#each labelConnections as option}
                            <button class:active={label.connection === option.value} aria-pressed={label.connection === option.value} disabled={!option.enabled} on:click={() => selectLabelConnection(option.value)}>
                                <svelte:component this={option.icon} size={22} />
                                <strong>{option.label}</strong>
                                {#if label.connection === option.value}<span class="connection-check"><Check size={17} /></span>{/if}
                            </button>
                        {/each}
                    </div>
                </div>

                <div class="printer-group">
                    <div class="printer-group-title"><h4>Label details</h4>{#if label.protocol === 'star'}<span class="success">Star Graphic</span>{/if}</div>
                    <div class="printer-form-grid">
                        <CustomSelect label="Label Protocol" value={label.protocol} options={labelProtocolOptions} on:change={(event) => selectLabelProtocol(String(event.detail) as LabelPrinterProtocol)} />
                        {#if label.connection !== 'system'}<CustomSelect label="Print Resolution" value={String(label.dpi)} options={labelDpiOptions} on:change={(event) => updateSetting('label_printer_dpi', String(event.detail))} />{/if}
                        {#if label.connection === 'system'}
                            <div class="printer-readout"><Monitor size={20} /><span><small>Connection</small><strong>System printer dialog</strong></span></div>
                        {:else if label.connection === 'network_escpos'}
                            <div class="field"><label for="label-host">Printer IP</label><input id="label-host" value={label.host} placeholder="e.g. 192.168.1.51" on:change={(event) => updateSetting('label_printer_host', event.currentTarget.value.trim())} /></div>
                            <div class="field"><label for="label-port">Port</label><input id="label-port" type="number" min="1" max="65535" value={label.port} on:change={(event) => updateSetting('label_printer_port', event.currentTarget.value || '9100')} /></div>
                        {:else if label.connection === 'usb_raw'}
                            <div class="span-all"><CustomSelect label="Installed Windows Printer" value={label.printerName} options={labelPrinterOptions} placeholder={findingPrinters ? 'Loading installed printers...' : 'Choose installed printer...'} emptyText="No installed printers found." on:change={(event) => updateSetting('label_printer_name', String(event.detail))} /></div>
                        {:else if label.connection === 'module'}
                            <CustomSelect label="Printer SDK Module" value={label.moduleId} options={moduleOptions} placeholder={modulesLoading ? 'Loading modules...' : 'Choose installed module...'} emptyText="No enabled printer modules installed." on:change={(event) => updateSetting('label_printer_module_id', String(event.detail))} />
                            <div class="field"><label for="label-module-device">Module Device ID</label><input id="label-module-device" value={label.moduleDeviceId} placeholder="Module default" on:change={(event) => updateSetting('label_printer_module_device_id', event.currentTarget.value.trim())} /></div>
                            {#if moduleOptions.length === 0}<button class="inline-action span-all" on:click={() => activeSection = 'modules'}><Blocks size={17} /> Open SDK Modules</button>{/if}
                        {:else}
                            <div class="field"><label for="label-device-path">{label.connection === 'bluetooth' ? 'Bluetooth COM Port' : 'Serial / COM Port'}</label><input id="label-device-path" value={label.devicePath} placeholder="e.g. COM4" on:change={(event) => updateSetting('label_printer_device_path', event.currentTarget.value.trim())} /></div>
                            <CustomSelect label="Baud Rate" value={String(label.baudRate)} options={baudRateOptions} on:change={(event) => updateSetting('label_printer_baud_rate', String(event.detail))} />
                        {/if}
                    </div>
                </div>

                <div class="printer-group">
                    <div class="printer-group-title"><h4>Finish</h4></div>
                    <div class="setting-toggle-grid label-finish-grid">
                        <button class:active={label.cutPaper} role="switch" aria-checked={label.cutPaper} on:click={() => updateSetting('label_printer_cut_paper', label.cutPaper ? 'false' : 'true')}><span>Cut after label</span><i><b></b></i></button>
                        <div class="field compact-number"><label for="label-gap-lines">Label gap / feed</label><input id="label-gap-lines" type="number" min="0" max="12" value={label.gapLines} on:change={(event) => updateSetting('label_printer_gap_lines', event.currentTarget.value || '0')} /></div>
                    </div>
                </div>
            </div>
        {:else if activeSection === 'drawer'}
            <div id="drawer-panel" class="printer-panel" role="tabpanel" aria-labelledby="drawer-tab">
                <header class="printer-panel-header">
                    <div>
                        <span>Cash drawer</span>
                        <h3>Drawer connection</h3>
                        <p>{drawerUsesReceiptPrinter ? 'Receipt printer' : drawerTarget || 'No target selected'}</p>
                    </div>
                    <div class="printer-panel-actions">
                        <button class="btn btn-secondary" on:click={testDrawer} disabled={!drawerManualEnabled || !drawerTarget}><Play size={17} /> Open Drawer</button>
                        <button class="compact-switch" class:enabled={drawerManualEnabled} role="switch" aria-checked={drawerManualEnabled} on:click={() => updateSetting('cash_drawer_enabled', drawerManualEnabled ? 'false' : 'true')}><span>Drawer</span><i><b></b></i></button>
                    </div>
                </header>

                {#if drawerTestStatus}<p class="printer-result" role="status">{drawerTestStatus}</p>{/if}

                <div class="printer-target-summary">
                    <span><Archive size={22} /></span>
                    <div><small>Current target</small><strong>{drawerUsesReceiptPrinter ? `Receipt printer: ${drawerTarget || 'not configured'}` : drawerTarget || 'Not configured'}</strong></div>
                </div>

                <div class="printer-group">
                    <div class="printer-group-title"><h4>Pulse settings</h4></div>
                    <div class="printer-form-grid drawer-pulse-grid">
                        <CustomSelect label="Drawer Pin" value={String(drawer.pin)} options={drawerPinOptions} on:change={(event) => updateSetting('cash_drawer_pin', String(event.detail))} />
                        <div class="field"><label for="drawer-pulse-on">Pulse on (ms)</label><input id="drawer-pulse-on" type="number" min="2" max="510" value={drawer.pulseOnMs} on:change={(event) => updateSetting('cash_drawer_pulse_on_ms', event.currentTarget.value || '50')} /></div>
                        <div class="field"><label for="drawer-pulse-off">Pulse off (ms)</label><input id="drawer-pulse-off" type="number" min="2" max="510" value={drawer.pulseOffMs} on:change={(event) => updateSetting('cash_drawer_pulse_off_ms', event.currentTarget.value || '250')} /></div>
                    </div>
                </div>

                <div class="printer-group">
                    <div class="printer-group-title"><h4>Printer target</h4></div>
                    <div class="target-segment" role="group" aria-label="Cash drawer printer target">
                        <button class:active={!drawerTargetEditorOpen} on:click={useReceiptPrinterForDrawer}><ReceiptText size={18} /> Receipt printer</button>
                        <button class:active={drawerTargetEditorOpen} on:click={() => drawerTargetEditorOpen = true}><Printer size={18} /> Separate target</button>
                    </div>

                    {#if drawerTargetEditorOpen}
                        <div class="printer-form-grid drawer-target-editor">
                            <CustomSelect label="Target Type" value={drawerTargetEditorMode} options={drawerTargetTypeOptions} on:change={(event) => drawerTargetEditorMode = String(event.detail) as DrawerTargetEditorMode} />
                            {#if drawerTargetEditorMode === 'printer'}
                                <CustomSelect label="Windows Printer" value={explicitDrawerPrinterName} options={drawerPrinterOptions} placeholder="Choose installed printer..." on:change={(event) => handleDrawerPrinterSelect(String(event.detail))} />
                            {:else if drawerTargetEditorMode === 'network'}
                                <div class="field"><label for="drawer-host">Printer IP</label><input id="drawer-host" value={explicitDrawerHost} placeholder="e.g. 192.168.1.50" on:change={(event) => setSeparateDrawerTarget('network', event.currentTarget.value)} /></div>
                                <div class="field"><label for="drawer-port">Port</label><input id="drawer-port" type="number" min="1" max="65535" value={settingValue('cash_drawer_printer_port', '9100') || '9100'} on:change={(event) => updateSetting('cash_drawer_printer_port', event.currentTarget.value || '9100')} /></div>
                            {:else if drawerTargetEditorMode === 'device'}
                                <div class="field"><label for="drawer-device">Serial / COM Port</label><input id="drawer-device" value={explicitDrawerDevicePath} placeholder="e.g. COM3" on:change={(event) => setSeparateDrawerTarget('device', event.currentTarget.value)} /></div>
                                <CustomSelect label="Baud Rate" value={String(drawer.baudRate)} options={baudRateOptions} on:change={(event) => updateSetting('cash_drawer_baud_rate', String(event.detail))} />
                            {:else}
                                <CustomSelect label="Printer SDK Module" value={explicitDrawerModuleId} options={moduleOptions} placeholder={modulesLoading ? 'Loading modules...' : 'Choose installed module...'} emptyText="No enabled printer modules installed." on:change={(event) => setSeparateDrawerModule(String(event.detail))} />
                                <div class="field"><label for="drawer-module-device">Module Device ID</label><input id="drawer-module-device" value={explicitDrawerModuleDeviceId} placeholder="Module default" on:change={(event) => updateSetting('cash_drawer_module_device_id', event.currentTarget.value.trim())} /></div>
                                {#if moduleOptions.length === 0}<button class="inline-action span-all" on:click={() => activeSection = 'modules'}><Blocks size={17} /> Open SDK Modules</button>{/if}
                            {/if}
                        </div>
                    {/if}
                </div>
            </div>
        {:else}
            <div id="modules-panel" class="printer-panel" role="tabpanel" aria-labelledby="modules-tab">
                <header class="printer-panel-header">
                    <div>
                        <span>Local extensions</span>
                        <h3>Printer SDK Modules</h3>
                        <p>{printerModules.length} installed on this till</p>
                    </div>
                    <div class="printer-panel-actions">
                        <button class="btn btn-secondary icon-only" title="Refresh printer modules" aria-label="Refresh printer modules" disabled={modulesLoading || Boolean(moduleBusyId)} on:click={() => refreshPrinterModules()}><RefreshCw size={19} class={modulesLoading ? 'animate-spin' : ''} /></button>
                        <button class="btn btn-primary" disabled={Boolean(moduleBusyId)} on:click={installModule}><PackagePlus size={19} /> Install Module</button>
                    </div>
                </header>

                <div class="module-grid">
                    {#each printerModules as module}
                        <article class="module-row">
                            <div class:trusted={module.trusted} class="module-icon"><ShieldCheck size={23} /></div>
                            <div class="module-details">
                                <div><strong>{module.name}</strong><span>v{module.version}</span></div>
                                <p>{module.vendor} · {module.id}</p>
                                <small class:ready={module.enabled}>{module.status}</small>
                            </div>
                            <div class="module-actions">
                                <button title="Check module" aria-label={`Check ${module.name}`} disabled={!module.enabled || moduleBusyId === module.id} on:click={() => testModule(module)}><Stethoscope size={18} /></button>
                                <button title={module.enabled ? 'Disable module' : 'Enable module'} aria-label={`${module.enabled ? 'Disable' : 'Enable'} ${module.name}`} disabled={!module.trusted || moduleBusyId === module.id} on:click={() => toggleModule(module)}><Power size={18} class={module.enabled ? 'text-success' : 'text-text-muted'} /></button>
                                <button class="danger" title={moduleInUse(module.id) ? 'Switch printers away from this module first' : 'Uninstall module'} aria-label={`Uninstall ${module.name}`} disabled={moduleInUse(module.id) || moduleBusyId === module.id} on:click={() => removeModule(module)}><Trash2 size={18} /></button>
                            </div>
                        </article>
                    {/each}
                    {#if !modulesLoading && printerModules.length === 0}
                        <div class="module-empty"><Blocks size={28} /><strong>No printer SDK modules installed</strong><span>Built-in printer modes remain available.</span></div>
                    {/if}
                </div>
            </div>
        {/if}
    </div>
</MgmtPage>

<style>
    .printer-page-shell {
        gap: 0.9rem;
        padding: 1rem;
    }

    .printer-overview {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        min-height: 72px;
        padding: 0.85rem 1rem;
        border: 1px solid var(--border-flat);
        border-radius: 8px;
        background: var(--bg-card);
    }

    .printer-overview-title {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        min-width: 0;
    }

    .printer-overview-icon {
        display: grid;
        width: 44px;
        height: 44px;
        flex: 0 0 44px;
        place-items: center;
        border: 1px solid color-mix(in srgb, var(--accent-primary) 55%, var(--border-flat));
        border-radius: 8px;
        background: color-mix(in srgb, var(--accent-primary) 12%, var(--bg-panel));
        color: var(--accent-primary);
    }

    .printer-overview-title span:not(.printer-overview-icon) {
        display: block;
        color: var(--text-muted);
        font-size: 0.7rem;
        font-weight: 900;
        letter-spacing: 0.1em;
        text-transform: uppercase;
    }

    .printer-overview-title h2 {
        margin: 0.15rem 0 0;
        font-size: 1.35rem;
        line-height: 1.15;
    }

    .printer-status-strip {
        display: flex;
        gap: 0.45rem;
        flex-wrap: wrap;
        justify-content: flex-end;
    }

    .printer-status-strip span {
        display: inline-flex;
        align-items: center;
        gap: 0.45rem;
        min-height: 34px;
        padding: 0.35rem 0.65rem;
        border: 1px solid var(--border-flat);
        border-radius: 7px;
        background: var(--bg-panel);
        color: var(--text-muted);
        font-size: 0.78rem;
        font-weight: 800;
    }

    .printer-status-strip i {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--text-muted);
    }

    .printer-status-strip span.online {
        color: var(--success);
    }

    .printer-status-strip span.online i {
        background: var(--success);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--success) 15%, transparent);
    }

    .printer-tabs {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 0.55rem;
        padding: 0.45rem;
        border: 1px solid var(--border-flat);
        border-radius: 8px;
        background: var(--bg-panel);
    }

    .printer-tabs button {
        position: relative;
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        align-items: center;
        gap: 0.55rem;
        min-width: 0;
        min-height: 52px;
        padding: 0.55rem 0.7rem;
        border: 1px solid transparent;
        border-radius: 6px;
        background: transparent;
        color: var(--text-muted);
        text-align: left;
    }

    .printer-tabs button:hover {
        border-color: var(--border-flat);
        background: var(--bg-card);
        color: var(--text-main);
    }

    .printer-tabs button.active {
        border-color: var(--accent-primary);
        background: var(--accent-primary);
        color: white;
    }

    .printer-tabs button strong {
        min-width: 0;
        overflow: hidden;
        font-size: 0.9rem;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .printer-tabs button span {
        min-width: 29px;
        padding: 0.15rem 0.4rem;
        border-radius: 5px;
        background: color-mix(in srgb, currentColor 10%, transparent);
        font-size: 0.7rem;
        font-weight: 900;
        text-align: center;
    }

    .printer-panel {
        overflow: hidden;
        border: 1px solid var(--border-flat);
        border-radius: 8px;
        background: var(--bg-card);
        box-shadow: 0 10px 26px var(--shadow);
    }

    .printer-panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        min-height: 82px;
        padding: 1rem 1.15rem;
        border-bottom: 1px solid var(--border-flat);
        background: var(--bg-panel);
    }

    .printer-panel-header > div:first-child {
        min-width: 0;
    }

    .printer-panel-header > div:first-child > span {
        color: var(--accent-primary);
        font-size: 0.7rem;
        font-weight: 900;
        letter-spacing: 0.1em;
        text-transform: uppercase;
    }

    .printer-panel-header h3 {
        margin: 0.15rem 0 0;
        font-size: 1.3rem;
        line-height: 1.15;
    }

    .printer-panel-header p {
        margin: 0.25rem 0 0;
        color: var(--text-muted);
        font-size: 0.8rem;
        font-weight: 700;
    }

    .printer-panel-actions {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 0.55rem;
        flex-wrap: wrap;
    }

    .printer-panel-actions :global(.btn) {
        min-height: 44px;
        padding: 0.6rem 0.9rem;
        font-size: 0.85rem;
        box-shadow: none;
    }

    .preset-button.active {
        border-color: var(--warning) !important;
        background: color-mix(in srgb, var(--warning) 12%, var(--bg-card)) !important;
        color: var(--warning) !important;
    }

    .compact-switch {
        display: flex;
        align-items: center;
        gap: 0.65rem;
        min-height: 44px;
        padding: 0.5rem 0.7rem;
        border: 1px solid var(--border-flat);
        border-radius: 7px;
        background: var(--bg-card);
        color: var(--text-muted);
        font-size: 0.82rem;
        font-weight: 850;
    }

    .compact-switch.enabled {
        border-color: color-mix(in srgb, var(--success) 65%, var(--border-flat));
        color: var(--success);
    }

    .compact-switch i,
    .setting-toggle-grid button i {
        position: relative;
        width: 38px;
        height: 22px;
        flex: 0 0 38px;
        border-radius: 999px;
        background: var(--bg-card-hover);
        box-shadow: inset 0 0 0 1px var(--border-flat);
    }

    .compact-switch i b,
    .setting-toggle-grid button i b {
        position: absolute;
        top: 3px;
        left: 3px;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: var(--text-muted);
        transition: transform 160ms ease, background 160ms ease;
    }

    .compact-switch.enabled i,
    .setting-toggle-grid button.active i {
        background: var(--success);
        box-shadow: none;
    }

    .compact-switch.enabled i b,
    .setting-toggle-grid button.active i b {
        transform: translateX(16px);
        background: white;
    }

    .printer-result {
        margin: 0;
        padding: 0.65rem 1.15rem;
        border-bottom: 1px solid var(--border-flat);
        background: color-mix(in srgb, var(--accent-primary) 8%, var(--bg-card));
        color: var(--text-main) !important;
        font-size: 0.82rem;
        font-weight: 700;
    }

    .printer-group {
        padding: 1rem 1.15rem;
    }

    .printer-group + .printer-group {
        border-top: 1px solid var(--border-flat);
    }

    .printer-group-title {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.75rem;
        margin-bottom: 0.75rem;
    }

    .printer-group-title h4 {
        margin: 0;
        font-size: 0.95rem;
    }

    .printer-group-title > span {
        padding: 0.25rem 0.5rem;
        border-radius: 5px;
        background: color-mix(in srgb, var(--accent-primary) 10%, var(--bg-panel));
        color: var(--accent-primary);
        font-size: 0.7rem;
        font-weight: 900;
    }

    .printer-group-title > span.success {
        background: color-mix(in srgb, var(--success) 10%, var(--bg-panel));
        color: var(--success);
    }

    .connection-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 0.55rem;
    }

    .connection-grid button {
        position: relative;
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        align-items: center;
        gap: 0.65rem;
        min-width: 0;
        min-height: 62px;
        padding: 0.65rem 0.75rem;
        border: 1px solid var(--border-flat);
        border-radius: 7px;
        background: var(--bg-panel);
        color: var(--text-muted);
        text-align: left;
    }

    .connection-grid button:hover {
        border-color: var(--accent-primary);
        color: var(--text-main);
    }

    .connection-grid button.active {
        border-color: var(--accent-primary);
        background: color-mix(in srgb, var(--accent-primary) 10%, var(--bg-panel));
        color: var(--accent-primary);
    }

    .connection-grid strong {
        min-width: 0;
        overflow: hidden;
        color: var(--text-main);
        font-size: 0.82rem;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .connection-check {
        display: grid;
        place-items: center;
        color: var(--success);
    }

    .printer-form-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 0.75rem;
        align-items: end;
    }

    .span-all {
        grid-column: 1 / -1;
    }

    .printer-readout {
        display: flex;
        align-items: center;
        gap: 0.7rem;
        min-height: 55px;
        padding: 0.6rem 0.75rem;
        border: 1px dashed var(--border-flat);
        border-radius: 7px;
        background: var(--bg-panel);
        color: var(--accent-primary);
    }

    .printer-readout span {
        display: flex;
        min-width: 0;
        flex-direction: column;
    }

    .printer-readout small {
        color: var(--text-muted);
        font-size: 0.68rem;
        font-weight: 850;
        text-transform: uppercase;
    }

    .printer-readout strong {
        color: var(--text-main);
        font-size: 0.84rem;
    }

    .setting-toggle-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 0.6rem;
    }

    .setting-toggle-grid > button {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.65rem;
        min-height: 61px;
        padding: 0.65rem 0.75rem;
        border: 1px solid var(--border-flat);
        border-radius: 7px;
        background: var(--bg-panel);
        color: var(--text-muted);
        font-size: 0.82rem;
        font-weight: 850;
        text-align: left;
    }

    .setting-toggle-grid > button.active {
        border-color: color-mix(in srgb, var(--success) 65%, var(--border-flat));
        color: var(--text-main);
    }

    .compact-number {
        min-height: 61px;
        padding: 0.45rem 0.65rem;
        border: 1px solid var(--border-flat);
        border-radius: 7px;
        background: var(--bg-panel);
    }

    .compact-number input {
        height: 33px !important;
        min-height: 33px !important;
        margin-top: 0.15rem;
        padding-block: 0.25rem !important;
    }

    .label-finish-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .inline-action {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.45rem;
        min-height: 44px;
        border: 1px dashed var(--accent-primary);
        border-radius: 7px;
        background: color-mix(in srgb, var(--accent-primary) 8%, var(--bg-panel));
        color: var(--accent-primary);
        font-size: 0.82rem;
        font-weight: 850;
    }

    .printer-target-summary {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        align-items: center;
        gap: 0.75rem;
        margin: 1rem 1.15rem 0;
        padding: 0.75rem;
        border: 1px solid color-mix(in srgb, var(--accent-primary) 45%, var(--border-flat));
        border-radius: 7px;
        background: color-mix(in srgb, var(--accent-primary) 8%, var(--bg-panel));
    }

    .printer-target-summary > span {
        display: grid;
        width: 40px;
        height: 40px;
        place-items: center;
        border-radius: 7px;
        background: var(--accent-primary);
        color: white;
    }

    .printer-target-summary div {
        display: flex;
        min-width: 0;
        flex-direction: column;
    }

    .printer-target-summary small {
        color: var(--text-muted);
        font-size: 0.68rem;
        font-weight: 850;
        text-transform: uppercase;
    }

    .printer-target-summary strong {
        overflow: hidden;
        font-size: 0.86rem;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .drawer-pulse-grid {
        grid-template-columns: repeat(3, minmax(0, 1fr));
    }

    .target-segment {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 0.35rem;
        max-width: 520px;
        padding: 0.35rem;
        border: 1px solid var(--border-flat);
        border-radius: 8px;
        background: var(--bg-panel);
    }

    .target-segment button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.45rem;
        min-height: 44px;
        border: 1px solid transparent;
        border-radius: 6px;
        background: transparent;
        color: var(--text-muted);
        font-size: 0.82rem;
        font-weight: 850;
    }

    .target-segment button.active {
        border-color: var(--accent-primary);
        background: var(--accent-primary);
        color: white;
    }

    .drawer-target-editor {
        margin-top: 0.8rem;
        padding-top: 0.8rem;
        border-top: 1px solid var(--border-flat);
    }

    .module-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 0.7rem;
        padding: 1rem 1.15rem;
    }

    .module-row {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        align-items: center;
        gap: 0.7rem;
        min-width: 0;
        min-height: 94px;
        padding: 0.75rem;
        border: 1px solid var(--border-flat);
        border-radius: 7px;
        background: var(--bg-panel);
    }

    .module-icon {
        display: grid;
        width: 42px;
        height: 42px;
        place-items: center;
        border: 1px solid color-mix(in srgb, var(--danger) 55%, var(--border-flat));
        border-radius: 7px;
        color: var(--danger);
    }

    .module-icon.trusted {
        border-color: color-mix(in srgb, var(--success) 55%, var(--border-flat));
        background: color-mix(in srgb, var(--success) 9%, var(--bg-panel));
        color: var(--success);
    }

    .module-details {
        min-width: 0;
    }

    .module-details > div {
        display: flex;
        align-items: center;
        gap: 0.45rem;
        min-width: 0;
    }

    .module-details strong {
        overflow: hidden;
        font-size: 0.9rem;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .module-details > div span {
        padding: 0.15rem 0.35rem;
        border-radius: 4px;
        background: var(--bg-card);
        color: var(--text-muted);
        font-size: 0.68rem;
        font-weight: 800;
    }

    .module-details p {
        overflow: hidden;
        margin: 0.2rem 0 0;
        color: var(--text-muted) !important;
        font-size: 0.72rem;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .module-details small {
        display: block;
        margin-top: 0.25rem;
        color: var(--warning);
        font-size: 0.68rem;
        font-weight: 850;
    }

    .module-details small.ready {
        color: var(--success);
    }

    .module-actions {
        display: flex;
        gap: 0.3rem;
    }

    .module-actions button,
    .icon-only {
        display: grid;
        width: 40px;
        min-width: 40px;
        height: 40px;
        min-height: 40px !important;
        padding: 0 !important;
        place-items: center;
        border: 1px solid var(--border-flat);
        border-radius: 7px;
        background: var(--bg-card);
        color: var(--text-main);
    }

    .module-actions button:hover {
        border-color: var(--accent-primary);
    }

    .module-actions button.danger {
        color: var(--danger);
    }

    .module-empty {
        grid-column: 1 / -1;
        display: grid;
        min-height: 132px;
        place-items: center;
        align-content: center;
        gap: 0.35rem;
        border: 1px dashed var(--border-flat);
        border-radius: 7px;
        background: var(--bg-panel);
        color: var(--text-muted);
        text-align: center;
    }

    .module-empty strong {
        color: var(--text-main);
        font-size: 0.9rem;
    }

    .module-empty span {
        font-size: 0.75rem;
    }

    .printer-panel button:disabled {
        cursor: not-allowed;
        filter: saturate(0.4);
        opacity: 0.38;
    }

    .printer-tabs button:focus-visible,
    .printer-panel button:focus-visible {
        outline: 3px solid var(--accent-primary);
        outline-offset: 2px;
    }

    @media (min-width: 1280px) {
        .connection-grid {
            grid-template-columns: repeat(6, minmax(0, 1fr));
        }
    }

    @media (max-width: 1050px) {
        .module-grid {
            grid-template-columns: minmax(0, 1fr);
        }
    }

    @media (max-width: 900px) {
        .printer-page-shell {
            padding: 0.75rem;
        }

        .printer-panel-header {
            align-items: flex-start;
            flex-direction: column;
        }

        .printer-panel-actions {
            width: 100%;
            justify-content: flex-start;
        }

        .setting-toggle-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
        }
    }

    @media (max-width: 680px) {
        .printer-overview {
            align-items: flex-start;
            flex-direction: column;
        }

        .printer-status-strip {
            width: 100%;
            justify-content: flex-start;
        }

        .printer-tabs {
            grid-template-columns: repeat(2, minmax(0, 1fr));
        }

        .connection-grid,
        .printer-form-grid,
        .drawer-pulse-grid {
            grid-template-columns: minmax(0, 1fr);
        }

        .span-all {
            grid-column: 1;
        }

        .module-row {
            grid-template-columns: auto minmax(0, 1fr);
        }

        .module-actions {
            grid-column: 1 / -1;
            justify-content: flex-end;
        }
    }

    @media (max-width: 480px) {
        .setting-toggle-grid,
        .target-segment {
            grid-template-columns: minmax(0, 1fr);
        }
    }
</style>
