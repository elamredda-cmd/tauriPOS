<script lang="ts">
    import { ListChecks, MessageSquareText, Printer, RotateCcw, Save, Settings2 } from '@lucide/svelte';
    import AdminPageHeader from '$lib/components/AdminPageHeader.svelte';
    import CustomSelect from '$lib/components/CustomSelect.svelte';
    import Receipt from '$lib/components/Receipt.svelte';
    import { now, settingsDB, storeDB, type Order, type OrderLine } from '$lib/stores/db';
    import { upsert } from '$lib/stores/database';
    import { toast } from '$lib/stores/toast';
    import { defaultReceiptDesign, getReceiptDesign, type ReceiptDesign } from '$lib/receipt';
    import { getReceiptPrinterConfig, printEscposReceipt } from '$lib/printers';

    type EditorTab = 'format' | 'messages' | 'content';

    let design: ReceiptDesign = getReceiptDesign($settingsDB);
    let activeTab: EditorTab = 'format';
    const paperWidthOptions: Array<{ label: string; value: ReceiptDesign['paperWidth'] }> = [
        { label: '58mm Thermal', value: '58mm' },
        { label: '80mm Thermal', value: '80mm' },
    ];
    const textSizeOptions = [
        { label: 'Small', value: 'small' },
        { label: 'Normal', value: 'normal' },
        { label: 'Large', value: 'large' },
    ];
    const densityOptions: Array<{ label: string; value: ReceiptDesign['density'] }> = [
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
    let savingDesign = false;

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
        if (savingDesign) return;
        savingDesign = true;
        const setting = { key: 'receipt_design', value: JSON.stringify(design), updatedAt: now() };
        try {
            await upsert('settings', setting, 'key');
            settingsDB.update((settings) => [...settings.filter((item) => item.key !== setting.key), setting]);
            toast('Receipt design saved', 'success');
        } catch (error) {
            toast(`Receipt design was not saved: ${error}`, 'error');
        } finally {
            savingDesign = false;
        }
    }

    function resetDesign() {
        design = { ...defaultReceiptDesign };
        toast('Receipt design reset. Save to keep it.', 'info');
    }

    async function testPrint() {
        if (testPrintBusy) return;
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

<svelte:head>
    <title>Receipt Designer - L&amp;Bj POS</title>
</svelte:head>

<div class="receipt-designer-page">
    <AdminPageHeader
        title="Receipt Designer"
        eyebrow="Design Studio"
        description={`${design.paperWidth} · ${design.density === 'compact' ? 'Compact' : 'Comfortable'}`}
        backFallback="/design"
        padded
    >
        <button type="button" class="btn btn-secondary" disabled={savingDesign || testPrintBusy} on:click={resetDesign}>
            <RotateCcw size={18} strokeWidth={2.35} aria-hidden="true" />
            Reset
        </button>
        <button type="button" class="btn btn-secondary" disabled={savingDesign || testPrintBusy} on:click={testPrint}>
            <Printer size={18} strokeWidth={2.35} aria-hidden="true" />
            {testPrintBusy ? 'Printing' : 'Test Print'}
        </button>
        <button type="button" class="btn btn-primary" disabled={savingDesign || testPrintBusy} on:click={saveDesign}>
            <Save size={18} strokeWidth={2.35} aria-hidden="true" />
            {savingDesign ? 'Saving' : 'Save'}
        </button>
    </AdminPageHeader>

    <main class="receipt-workspace">
        <section class="editor-panel">
            <div class="editor-tabs" role="tablist" aria-label="Receipt editor sections">
                <button type="button" role="tab" aria-selected={activeTab === 'format'} class:active={activeTab === 'format'} on:click={() => activeTab = 'format'}>
                    <Settings2 size={18} strokeWidth={2.3} aria-hidden="true" />
                    Format
                </button>
                <button type="button" role="tab" aria-selected={activeTab === 'messages'} class:active={activeTab === 'messages'} on:click={() => activeTab = 'messages'}>
                    <MessageSquareText size={18} strokeWidth={2.3} aria-hidden="true" />
                    Messages
                </button>
                <button type="button" role="tab" aria-selected={activeTab === 'content'} class:active={activeTab === 'content'} on:click={() => activeTab = 'content'}>
                    <ListChecks size={18} strokeWidth={2.3} aria-hidden="true" />
                    Content
                </button>
            </div>

            <div class="editor-body" role="tabpanel">
                {#if activeTab === 'format'}
                    <div class="section-heading"><div><span>Receipt format</span><h2>Paper and text</h2></div></div>
                    <div class="format-controls">
                        <div class="option-field span-two">
                            <span>Paper width</span>
                            <div class="segmented-control" aria-label="Paper width">
                                {#each paperWidthOptions as option}
                                    <button type="button" aria-pressed={design.paperWidth === option.value} class:active={design.paperWidth === option.value} on:click={() => design = { ...design, paperWidth: option.value }}>
                                        {option.label}
                                    </button>
                                {/each}
                            </div>
                        </div>
                        <CustomSelect label="Text size" bind:value={design.textSize} options={textSizeOptions} />
                        <CustomSelect label="Title size" bind:value={design.titleTextSize} options={textSizeOptions} />
                        <CustomSelect label="Font" bind:value={design.fontFamily} options={fontOptions} />
                        <div class="option-field">
                            <span>Spacing</span>
                            <div class="segmented-control" aria-label="Receipt spacing">
                                {#each densityOptions as option}
                                    <button type="button" aria-pressed={design.density === option.value} class:active={design.density === option.value} on:click={() => design = { ...design, density: option.value }}>
                                        {option.label}
                                    </button>
                                {/each}
                            </div>
                        </div>
                    </div>
                {:else if activeTab === 'messages'}
                    <div class="section-heading"><div><span>Receipt copy</span><h2>Messages</h2></div></div>
                    <div class="message-fields">
                        <label for="receipt-header-text">
                            <span>Header text</span>
                            <textarea id="receipt-header-text" bind:value={design.headerText} placeholder="Leave blank to use store name"></textarea>
                        </label>
                        <label for="receipt-store-message">
                            <span>Below store details</span>
                            <textarea id="receipt-store-message" bind:value={design.customMessage} placeholder="Optional message"></textarea>
                        </label>
                        <label for="receipt-footer-text">
                            <span>Footer text</span>
                            <textarea id="receipt-footer-text" bind:value={design.footerText} placeholder="Optional footer"></textarea>
                        </label>
                    </div>
                {:else}
                    <div class="section-heading"><div><span>Receipt content</span><h2>Information to show</h2></div></div>
                    <div class="visibility-grid">
                        {#each switches as item}
                            <button
                                type="button"
                                role="switch"
                                aria-checked={Boolean(design[item.key])}
                                class:active={Boolean(design[item.key])}
                                on:click={() => setBoolean(item.key, !design[item.key])}
                            >
                                <span>{item.label}</span>
                                <i aria-hidden="true"><b></b></i>
                            </button>
                        {/each}
                    </div>
                {/if}
            </div>
        </section>

        <aside class="preview-panel">
            <div class="preview-heading">
                <div><span>Live preview</span><h2>{design.paperWidth} receipt</h2></div>
                <b>{design.fontFamily === 'mono' ? 'Receipt font' : design.fontFamily}</b>
            </div>
            <div class="preview-stage">
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
            <div class="preview-footer">
                <span>{design.density === 'compact' ? 'Compact' : 'Comfortable'}</span>
                <span>{design.textSize} text</span>
            </div>
        </aside>
    </main>
</div>

<style>
    .receipt-designer-page { box-sizing: border-box; height: 100dvh; min-height: 580px; overflow: hidden; display: flex; flex-direction: column; background: var(--bg-base); color: var(--text-main); }
    .section-heading span, .preview-heading span { display: block; color: var(--accent-primary); font-size: .68rem; line-height: 1; font-weight: 900; text-transform: uppercase; }
    button:disabled { cursor: not-allowed; opacity: .42; }
    button:focus-visible, textarea:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 2px; }

    .receipt-workspace { flex: 1; min-height: 0; padding: 0 var(--app-page-gutter, 1.5rem) var(--app-page-gutter, 1.5rem); display: grid; grid-template-columns: minmax(430px, 1.08fr) minmax(320px, .92fr); gap: .65rem; }
    .editor-panel, .preview-panel { min-width: 0; min-height: 0; overflow: hidden; border: 1px solid var(--border-flat); border-radius: 8px; background: var(--bg-panel); }
    .editor-panel { display: flex; flex-direction: column; }
    .editor-tabs { flex: 0 0 52px; padding: .35rem; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .35rem; border-bottom: 1px solid var(--border-flat); }
    .editor-tabs button { min-width: 0; display: flex; align-items: center; justify-content: center; gap: .45rem; border: 1px solid transparent; border-radius: 5px; background: transparent; color: var(--text-muted); font-weight: 900; }
    .editor-tabs button.active { border-color: color-mix(in srgb, var(--accent-primary) 55%, var(--border-flat)); background: color-mix(in srgb, var(--accent-primary) 13%, var(--bg-card)); color: var(--accent-primary); }
    .editor-body { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
    .section-heading { min-height: 52px; padding: .6rem .7rem; display: flex; align-items: center; border-bottom: 1px solid var(--border-flat); }
    .section-heading h2, .preview-heading h2 { margin: .22rem 0 0; overflow: hidden; font-size: 1rem; line-height: 1.05; text-overflow: ellipsis; white-space: nowrap; }

    .format-controls { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: .7rem; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-content: start; gap: .7rem; scrollbar-color: var(--accent-primary) var(--bg-card); }
    .format-controls .span-two { grid-column: 1 / -1; }
    .format-controls :global(button) { border-radius: 5px; box-shadow: none; }
    .option-field { min-width: 0; display: flex; flex-direction: column; gap: .38rem; }
    .option-field > span, .message-fields label > span { color: var(--text-muted); font-size: .8rem; font-weight: 900; text-transform: uppercase; }
    .segmented-control { height: 48px; padding: 3px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 3px; border: 1px solid var(--border-flat); border-radius: 5px; background: var(--bg-base); }
    .segmented-control button { min-width: 0; overflow: hidden; border: 1px solid transparent; border-radius: 4px; background: transparent; color: var(--text-muted); font-size: .78rem; font-weight: 900; text-overflow: ellipsis; white-space: nowrap; }
    .segmented-control button.active { border-color: color-mix(in srgb, var(--accent-primary) 55%, var(--border-flat)); background: color-mix(in srgb, var(--accent-primary) 15%, var(--bg-card)); color: var(--accent-primary); }

    .message-fields { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: .7rem; display: grid; grid-template-columns: 1fr; align-content: start; gap: .65rem; scrollbar-color: var(--accent-primary) var(--bg-card); }
    .message-fields label { min-width: 0; display: flex; flex-direction: column; gap: .38rem; }
    .message-fields textarea { box-sizing: border-box; width: 100%; min-height: 92px; padding: .65rem .75rem; resize: vertical; border: 1px solid var(--border-flat); border-radius: 5px; outline: 0; background: var(--bg-base); color: var(--text-main); font: inherit; line-height: 1.35; }
    .message-fields textarea:hover, .message-fields textarea:focus { border-color: var(--accent-primary); background: var(--bg-card); }

    .visibility-grid { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: .7rem; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); grid-auto-rows: 52px; align-content: start; gap: .45rem; scrollbar-color: var(--accent-primary) var(--bg-card); }
    .visibility-grid button { min-width: 0; min-height: 46px; padding: .42rem .6rem; display: flex; align-items: center; justify-content: space-between; gap: .5rem; border: 1px solid var(--border-flat); border-radius: 5px; background: var(--bg-card); color: var(--text-main); font-size: .78rem; font-weight: 850; text-align: left; }
    .visibility-grid button.active { border-color: color-mix(in srgb, var(--success) 58%, var(--border-flat)); }
    .visibility-grid button > span { min-width: 0; line-height: 1.15; }
    .visibility-grid i { width: 36px; height: 21px; padding: 2px; flex: 0 0 auto; display: block; border-radius: 12px; background: var(--bg-card-hover); }
    .visibility-grid i b { width: 17px; height: 17px; display: block; border-radius: 50%; background: var(--text-muted); }
    .visibility-grid button.active i { background: var(--success); }
    .visibility-grid button.active i b { margin-left: 15px; background: #fff; }

    .preview-panel { display: flex; flex-direction: column; }
    .preview-heading { min-height: 56px; padding: .65rem .75rem; display: flex; align-items: center; justify-content: space-between; gap: .7rem; border-bottom: 1px solid var(--border-flat); }
    .preview-heading > div { min-width: 0; }
    .preview-heading > b { flex: 0 0 auto; color: var(--text-muted); font-size: .72rem; text-transform: capitalize; }
    .preview-stage { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: .75rem; display: flex; align-items: flex-start; justify-content: center; background-color: var(--bg-base); background-image: linear-gradient(var(--border-flat) 1px, transparent 1px), linear-gradient(90deg, var(--border-flat) 1px, transparent 1px); background-size: 24px 24px; scrollbar-color: var(--accent-primary) var(--bg-card); }
    .receipt-print-target { width: max-content; max-width: 100%; }
    .preview-footer { min-height: 40px; padding: 0 .75rem; display: flex; align-items: center; justify-content: space-between; gap: .7rem; border-top: 1px solid var(--border-flat); color: var(--text-muted); font-size: .72rem; font-weight: 800; text-transform: capitalize; }

    @media (max-width: 900px) and (min-width: 720px) {
        .receipt-workspace { grid-template-columns: minmax(390px, 1.18fr) minmax(290px, .82fr); gap: .6rem; }
        .preview-stage { padding: .55rem; }
    }
    @media (max-width: 719px) {
        .receipt-designer-page { min-height: 100dvh; height: auto; overflow: auto; }
        .receipt-workspace { grid-template-columns: 1fr; }
        .editor-panel { height: 600px; min-height: 520px; }
        .preview-panel { min-height: 480px; }
    }
    @media (max-width: 660px) {
        .format-controls { grid-template-columns: 1fr; }
        .format-controls .span-two { grid-column: auto; }
    }
</style>
