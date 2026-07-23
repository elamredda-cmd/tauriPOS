<script lang="ts">
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import CustomSelect from '$lib/components/CustomSelect.svelte';
    import Receipt from '$lib/components/Receipt.svelte';
    import { now, settingsDB, storeDB, type Order, type OrderLine } from '$lib/stores/db';
    import { upsert } from '$lib/stores/database';
    import { toast } from '$lib/stores/toast';
    import { defaultReceiptDesign, getReceiptDesign, type ReceiptDesign } from '$lib/receipt';
    import { getReceiptPrinterConfig, printEscposReceipt } from '$lib/printers';

    let design: ReceiptDesign = getReceiptDesign($settingsDB);
    const paperWidthOptions = [
        { label: '58mm Thermal', value: '58mm' },
        { label: '80mm Thermal', value: '80mm' },
    ];
    const textSizeOptions = [
        { label: 'Small', value: 'small' },
        { label: 'Normal', value: 'normal' },
        { label: 'Large', value: 'large' },
    ];
    const densityOptions = [
        { label: 'Compact', value: 'compact' },
        { label: 'Comfortable', value: 'comfortable' },
    ];
    const fontOptions = [
        { label: 'Mono / receipt style', value: 'mono' },
        { label: 'Standard', value: 'standard' },
        { label: 'Condensed', value: 'condensed' },
    ];

    const previewOrder: Order = {
        id: 'preview-order',
        shiftId: '',
        customerId: '',
        employeeId: 'preview-employee',
        orderNumber: 10042,
        receiptKey: 'preview:10042',
        type: 'sale',
        status: 'completed',
        originalOrderId: '',
        subtotal: 1350,
        discountId: '',
        discountAmount: 100,
        taxTotal: 208,
        total: 1250,
        tillNumber: 'preview-till',
        notes: '',
        paymentMethod: 'cash',
        amountTendered: 1500,
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };

    let testPrintBusy = false;

    const previewLines: OrderLine[] = [
        {
            id: 'preview-line-1',
            orderId: previewOrder.id,
            productId: 'DRINK-COFFEE',
            productName: 'Coffee',
            quantity: 2,
            unitPrice: 350,
            costPrice: 0,
            discountId: '',
            discountAmount: 0,
            taxRate: 0,
            taxAmount: 0,
            lineTotal: 700,
            isPriceOverride: false,
            originalPrice: 350,
            notes: '',
            updatedAt: new Date().toISOString(),
        },
        {
            id: 'preview-line-2',
            orderId: previewOrder.id,
            productId: 'FOOD-SANDWICH',
            productName: 'Sandwich',
            quantity: 1,
            unitPrice: 650,
            costPrice: 0,
            discountId: '',
            discountAmount: 0,
            taxRate: 0,
            taxAmount: 0,
            lineTotal: 650,
            isPriceOverride: false,
            originalPrice: 650,
            notes: '',
            updatedAt: new Date().toISOString(),
        },
    ];

    function setBoolean(key: keyof ReceiptDesign, checked: boolean) {
        design = { ...design, [key]: checked };
    }

    async function saveDesign() {
        const setting = { key: 'receipt_design', value: JSON.stringify(design), updatedAt: now() };
        settingsDB.update((settings) => {
            const index = settings.findIndex((item) => item.key === setting.key);
            if (index >= 0) settings[index] = setting;
            else settings.push(setting);
            return settings;
        });
        await upsert('settings', setting, 'key');
        toast('Receipt design saved', 'success');
    }

    function resetDesign() {
        design = { ...defaultReceiptDesign };
        toast('Receipt design reset. Save to keep it.', 'info');
    }

    async function testPrint() {
        const config = getReceiptPrinterConfig($settingsDB);
        testPrintBusy = true;
        try {
            await printEscposReceipt({
                store: $storeDB,
                order: previewOrder,
                lines: previewLines,
                cashierName: 'Alex',
                tillName: 'Till 1',
                design,
            }, config);
            toast('Receipt test sent to thermal printer', 'success');
        } catch (error) {
            toast(`Receipt test did not print: ${error}`, 'error');
        } finally {
            testPrintBusy = false;
        }
    }

    const switches: Array<{ key: keyof ReceiptDesign; label: string }> = [
        { key: 'showAddress', label: 'Store address' },
        { key: 'showPhone', label: 'Store phone' },
        { key: 'showEmail', label: 'Store email' },
        { key: 'showReceiptNumber', label: 'Receipt number' },
        { key: 'showDateTime', label: 'Date and time' },
        { key: 'showCashier', label: 'Cashier name' },
        { key: 'showTill', label: 'Till name' },
        { key: 'showSku', label: 'Product SKU' },
        { key: 'showPayment', label: 'Payment and change' },
        { key: 'showBarcode', label: 'Receipt number barcode' },
    ];
</script>

<MgmtPage title="Receipt Designer" backFallback="/settings">
    <div slot="actions" class="flex gap-3">
        <button class="btn btn-secondary" on:click={resetDesign}>Reset</button>
        <button class="btn btn-secondary" on:click={testPrint} disabled={testPrintBusy}>{testPrintBusy ? 'Printing...' : 'Test Print'}</button>
        <button class="btn btn-primary" on:click={saveDesign}>Save Design</button>
    </div>

    <div class="grid grid-cols-1 xl:grid-cols-[minmax(480px,1fr)_minmax(340px,0.8fr)] gap-6 p-6">
        <div class="flex flex-col gap-6">
            <section class="settings-section">
                <h3 class="settings-section-title">Paper and Text</h3>
                <div class="form-grid">
                    <div class="field">
                        <CustomSelect label="Paper Width" bind:value={design.paperWidth} options={paperWidthOptions} />
                    </div>
                    <div class="field">
                        <CustomSelect label="Text Size" bind:value={design.textSize} options={textSizeOptions} />
                    </div>
                    <div class="field">
                        <CustomSelect label="Title Size" bind:value={design.titleTextSize} options={textSizeOptions} />
                    </div>
                    <div class="field">
                        <CustomSelect label="Font" bind:value={design.fontFamily} options={fontOptions} />
                    </div>
                    <div class="field">
                        <CustomSelect label="Spacing" bind:value={design.density} options={densityOptions} />
                    </div>
                </div>
            </section>

            <section class="settings-section">
                <h3 class="settings-section-title">Receipt Messages</h3>
                <div class="form-grid">
                    <div class="field span-2">
                        <label>Header Text</label>
                        <textarea bind:value={design.headerText} placeholder="Leave blank to use store name"></textarea>
                    </div>
                    <div class="field span-2">
                        <label>Message Below Store Details</label>
                        <textarea bind:value={design.customMessage} placeholder="Optional message"></textarea>
                    </div>
                    <div class="field span-2">
                        <label>Footer Text</label>
                        <textarea bind:value={design.footerText}></textarea>
                    </div>
                </div>
            </section>

            <section class="settings-section">
                <h3 class="settings-section-title">Information to Show</h3>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {#each switches as item}
                        <button
                            type="button"
                            class="min-h-[58px] rounded-lg border p-3 text-left font-bold transition-all {design[item.key] ? 'border-accent-primary bg-accent-primary/15 text-accent-primary' : 'border-border-flat bg-bg-root text-text-main hover:border-accent-primary hover:bg-bg-card-hover'}"
                            role="switch"
                            aria-checked={Boolean(design[item.key])}
                            on:click={() => setBoolean(item.key, !design[item.key])}
                        >
                            <span class="flex items-center justify-between gap-3">
                                <span>{item.label}</span>
                                <b class="text-xs uppercase tracking-[0.12em]">{design[item.key] ? 'On' : 'Off'}</b>
                            </span>
                        </button>
                    {/each}
                </div>
            </section>
        </div>

        <aside class="settings-section flex flex-col items-center gap-4 xl:sticky xl:top-0 self-start">
            <div class="w-full flex justify-between items-center">
                <h3 class="settings-section-title !mb-0">Live Preview</h3>
                <span class="text-xs text-text-muted">{design.paperWidth}</span>
            </div>
            <div class="w-full overflow-auto p-4 bg-bg-root rounded-md flex justify-center">
                <div class="receipt-print-target">
                    <Receipt
                        store={$storeDB}
                        order={previewOrder}
                        lines={previewLines}
                        cashierName="Alex"
                        tillName="Till 1"
                        {design}
                        preview
                    />
                </div>
            </div>
            <p class="text-xs text-text-muted text-center">
                Test Print uses the thermal receipt printer selected in Printer Setup.
            </p>
        </aside>
    </div>
</MgmtPage>
