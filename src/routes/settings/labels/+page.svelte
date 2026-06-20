<script lang="ts">
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import ProductLabel from '$lib/components/ProductLabel.svelte';
    import CustomSelect from '$lib/components/CustomSelect.svelte';
    import { now, productsDB, settingsDB, storeDB, type Product } from '$lib/stores/db';
    import { upsert } from '$lib/stores/database';
    import { toast } from '$lib/stores/toast';
    import { defaultLabelDesign, getLabelDesign, labelSizePresets, type LabelDesign, type LabelTemplate } from '$lib/labels';
    import { getLabelPrinterConfig, printProductLabels } from '$lib/printers';

    let design: LabelDesign = getLabelDesign($settingsDB);
    let search = '';
    let selectedProductId = '';
    let quantity = 1;
    let printingLabels = false;
    $: labelPrinter = getLabelPrinterConfig($settingsDB);
    $: filteredProducts = $productsDB.filter(product => product.isActive && (
        !search.trim() ||
        product.name.toLowerCase().includes(search.toLowerCase()) ||
        (product.sku || '').toLowerCase().includes(search.toLowerCase()) ||
        (product.barcode || '').toLowerCase().includes(search.toLowerCase()) ||
        (product.scalePlu || '').toLowerCase().includes(search.toLowerCase())
    )).slice(0, 100);
    $: selectedProduct = $productsDB.find(product => product.id === selectedProductId) || filteredProducts[0] || null;
    $: copies = Array.from({ length: Math.max(1, Math.min(500, Math.floor(quantity || 1))) });

    const templates: Array<{ id: LabelTemplate; name: string; description: string }> = [
        { id: 'compact', name: 'Compact Price', description: 'Small price label with a compact barcode.' },
        { id: 'standard', name: 'Standard Product', description: 'Balanced name, price, and barcode.' },
        { id: 'barcode', name: 'Barcode Focus', description: 'Large barcode for fast scanning.' },
        { id: 'shelf', name: 'Shelf Label', description: 'Large price and product name.' },
    ];
    const fontOptions = [
        { label: 'Standard', value: 'standard' },
        { label: 'Condensed', value: 'condensed' },
        { label: 'Serif', value: 'serif' },
    ];
    const textScaleOptions = [
        { label: 'Small', value: 'small' },
        { label: 'Normal', value: 'normal' },
        { label: 'Large', value: 'large' },
    ];

    function usePreset(width: number, height: number) {
        design = { ...design, widthMm: width, heightMm: height };
    }

    function setBoolean(key: keyof LabelDesign, value: boolean) {
        design = { ...design, [key]: value };
    }

    async function saveDesign() {
        const setting = { key: 'label_design', value: JSON.stringify(design), updatedAt: now() };
        settingsDB.update(list => {
            const index = list.findIndex(item => item.key === setting.key);
            if (index >= 0) list[index] = setting;
            else list.push(setting);
            return list;
        });
        await upsert('settings', setting, 'key');
        toast('Label design saved', 'success');
    }

    async function printLabels() {
        if (!selectedProduct) { toast('Select an item to print', 'error'); return; }
        if (printingLabels) return;
        if (labelPrinter.connection === 'system' || labelPrinter.protocol === 'system') {
            toast('Set Label Printer to USB raw, Network, Serial, or Bluetooth first', 'error');
            return;
        }
        printingLabels = true;
        try {
            await printProductLabels({
                product: selectedProduct,
                store: $storeDB,
                design,
                quantity,
            }, labelPrinter);
            toast('Label sent to printer', 'success');
        } catch (error) {
            toast(`Label did not print: ${error}`, 'error');
        } finally {
            printingLabels = false;
        }
    }
</script>

<MgmtPage title="Label Designer & Print" backFallback="/settings">
    <div slot="actions" class="flex gap-3">
        <button class="btn btn-secondary" on:click={() => design = { ...defaultLabelDesign }}>Reset</button>
        <button class="btn btn-secondary" on:click={saveDesign}>Save Design</button>
        <button class="btn btn-primary" on:click={printLabels} disabled={printingLabels}>{printingLabels ? 'Printing...' : 'Print Labels'}</button>
    </div>
    <div class="grid grid-cols-[minmax(0,1.2fr)_minmax(340px,0.8fr)] gap-6 p-6 max-[950px]:grid-cols-1 max-[950px]:p-3">
        <section class="flex flex-col gap-4">
            <div class="settings-section">
                <div class="flex flex-col gap-1">
                    <p class="text-xs uppercase tracking-[0.22em] text-accent-primary font-bold">Item lookup</p>
                    <h3 class="settings-section-title !mb-0">Choose Item</h3>
                    <p class="text-sm text-text-muted">Search by name, SKU, barcode, or PLU before previewing and printing.</p>
                </div>
                <div class="relative mt-4">
                    <svg class="absolute left-4 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                    <input
                        class="w-full min-h-[56px] rounded-lg border border-border-flat bg-bg-base pl-12 pr-4 text-base font-semibold text-text-main outline-none transition focus:border-accent-primary focus:ring-2 focus:ring-accent-primary/25"
                        bind:value={search}
                        placeholder="Search items..."
                    />
                </div>
                <div class="mt-3 max-h-[220px] overflow-y-auto rounded-lg border border-border-flat">
                    {#each filteredProducts as product}
                        <button
                            class="flex w-full items-center justify-between gap-4 border-b border-border-flat px-3 py-2 text-left transition {selectedProduct?.id === product.id ? 'bg-accent-primary/15 text-accent-primary' : 'bg-bg-panel hover:bg-bg-card-hover'}"
                            on:click={() => selectedProductId = product.id}
                        >
                            <span class="min-w-0">
                                <strong class="block truncate">{product.name}</strong>
                                <small class="block text-text-muted">{product.sku || product.barcode || product.scalePlu || ''}</small>
                            </span>
                            <b class="shrink-0">£{(product.price / 100).toFixed(2)}</b>
                        </button>
                    {/each}
                </div>
            </div>

            <div class="settings-section">
                <h3 class="settings-section-title">Label Size</h3>
                <div class="grid grid-cols-3 gap-2">
                    {#each labelSizePresets as preset}
                        <button
                            class="min-h-[54px] rounded-lg border p-3 font-bold transition {design.widthMm === preset.width && design.heightMm === preset.height ? 'border-accent-primary bg-accent-primary/15 text-accent-primary' : 'border-border-flat bg-bg-panel hover:border-accent-primary hover:bg-bg-card-hover'}"
                            on:click={() => usePreset(preset.width, preset.height)}
                        >{preset.label}</button>
                    {/each}
                </div>
                <div class="form-grid mt-4">
                    <div class="field"><label>Custom width (mm)</label><input type="number" min="15" max="210" bind:value={design.widthMm} /></div>
                    <div class="field"><label>Custom height (mm)</label><input type="number" min="15" max="297" bind:value={design.heightMm} /></div>
                    <div class="field span-2"><label>Number of labels</label><input type="number" min="1" max="500" bind:value={quantity} /></div>
                </div>
            </div>

            <div class="settings-section">
                <h3 class="settings-section-title">Design</h3>
                <div class="grid grid-cols-2 gap-2">
                    {#each templates as template}
                        <button
                            class="rounded-lg border p-3 text-left transition {design.template === template.id ? 'border-accent-primary bg-accent-primary/15 text-accent-primary' : 'border-border-flat bg-bg-panel hover:border-accent-primary hover:bg-bg-card-hover'}"
                            on:click={() => design = { ...design, template: template.id }}
                        >
                            <strong class="block">{template.name}</strong>
                            <small class="mt-1 block text-text-muted">{template.description}</small>
                        </button>
                    {/each}
                </div>
                <div class="mt-4 grid grid-cols-2 gap-2">
                    {#each [['showStore','Store name'],['showName','Item name'],['showPrice','Price'],['showBarcodeText','Barcode text'],['showSku','SKU'],['showPlu','PLU']] as option}
                        <button
                            type="button"
                            class="min-h-[54px] rounded-lg border p-3 text-left font-bold transition {design[option[0] as keyof LabelDesign] ? 'border-accent-primary bg-accent-primary/15 text-accent-primary' : 'border-border-flat bg-bg-panel hover:border-accent-primary hover:bg-bg-card-hover'}"
                            role="switch"
                            aria-checked={Boolean(design[option[0] as keyof LabelDesign])}
                            on:click={() => setBoolean(option[0] as keyof LabelDesign, !design[option[0] as keyof LabelDesign])}
                        >
                            <span class="flex items-center justify-between gap-3">
                                <span>{option[1]}</span>
                                <b class="text-xs uppercase tracking-[0.12em]">{design[option[0] as keyof LabelDesign] ? 'On' : 'Off'}</b>
                            </span>
                        </button>
                    {/each}
                </div>
                <div class="form-grid mt-4">
                    <CustomSelect
                        label="Font"
                        bind:value={design.fontFamily}
                        options={fontOptions}
                    />
                    <CustomSelect
                        label="Text Size"
                        bind:value={design.textScale}
                        options={textScaleOptions}
                    />
                </div>
            </div>
        </section>

        <aside class="settings-section sticky top-0 self-start min-h-[520px] flex flex-col items-center justify-center gap-8 overflow-auto max-[950px]:static max-[950px]:min-h-[360px]">
            <div class="flex w-full items-center justify-between gap-4">
                <h3 class="settings-section-title !mb-0">Live Preview</h3>
                <span class="text-sm text-text-muted">{design.widthMm} × {design.heightMm} mm</span>
            </div>
            {#if selectedProduct}<ProductLabel product={selectedProduct as Product} store={$storeDB} {design} preview />{:else}<p>Select an item to preview its label.</p>{/if}
        </aside>
    </div>
</MgmtPage>

<div class="label-print-sheet">
    {#if selectedProduct}{#each copies as _}<ProductLabel product={selectedProduct as Product} store={$storeDB} {design} />{/each}{/if}
</div>

<style>
    .label-print-sheet { display: none; }
    @media print {
        :global(.management-page), :global(.fullscreen-toggle), :global(.toast-pop), :global(.touch-input-backdrop) { display: none !important; }
        .label-print-sheet { display: block !important; }
        @page { margin: 0; }
    }
</style>
