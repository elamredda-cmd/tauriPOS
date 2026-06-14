<script lang="ts">
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import ProductLabel from '$lib/components/ProductLabel.svelte';
    import { now, productsDB, settingsDB, storeDB, type Product } from '$lib/stores/db';
    import { upsert } from '$lib/stores/database';
    import { toast } from '$lib/stores/toast';
    import { defaultLabelDesign, getLabelDesign, labelSizePresets, type LabelDesign, type LabelTemplate } from '$lib/labels';

    let design: LabelDesign = getLabelDesign($settingsDB);
    let search = '';
    let selectedProductId = '';
    let quantity = 1;
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

    function printLabels() {
        if (!selectedProduct) { toast('Select an item to print', 'error'); return; }
        window.print();
    }
</script>

<MgmtPage title="Label Designer & Print" backFallback="/settings">
    <div slot="actions" class="flex gap-3">
        <button class="btn btn-secondary" on:click={() => design = { ...defaultLabelDesign }}>Reset</button>
        <button class="btn btn-secondary" on:click={saveDesign}>Save Design</button>
        <button class="btn btn-primary" on:click={printLabels}>Print Labels</button>
    </div>
    <div class="label-workspace">
        <section class="label-controls">
            <div class="settings-section">
                <h3 class="settings-section-title">Choose Item</h3>
                <div class="field"><label>Search name, SKU, barcode, or PLU</label><input bind:value={search} /></div>
                <div class="product-results">
                    {#each filteredProducts as product}
                        <button class:active={selectedProduct?.id === product.id} on:click={() => selectedProductId = product.id}>
                            <span><strong>{product.name}</strong><small>{product.sku || product.barcode || product.scalePlu || ''}</small></span>
                            <b>£{(product.price / 100).toFixed(2)}</b>
                        </button>
                    {/each}
                </div>
            </div>

            <div class="settings-section">
                <h3 class="settings-section-title">Label Size</h3>
                <div class="preset-grid">
                    {#each labelSizePresets as preset}<button class:active={design.widthMm === preset.width && design.heightMm === preset.height} on:click={() => usePreset(preset.width, preset.height)}>{preset.label}</button>{/each}
                </div>
                <div class="form-grid mt-4">
                    <div class="field"><label>Custom width (mm)</label><input type="number" min="15" max="210" bind:value={design.widthMm} /></div>
                    <div class="field"><label>Custom height (mm)</label><input type="number" min="15" max="297" bind:value={design.heightMm} /></div>
                    <div class="field span-2"><label>Number of labels</label><input type="number" min="1" max="500" bind:value={quantity} /></div>
                </div>
            </div>

            <div class="settings-section">
                <h3 class="settings-section-title">Design</h3>
                <div class="template-grid">
                    {#each templates as template}<button class:active={design.template === template.id} on:click={() => design = { ...design, template: template.id }}><strong>{template.name}</strong><small>{template.description}</small></button>{/each}
                </div>
                <div class="switch-grid">
                    {#each [['showStore','Store name'],['showName','Item name'],['showPrice','Price'],['showBarcodeText','Barcode text'],['showSku','SKU'],['showPlu','PLU']] as option}
                        <label><input type="checkbox" checked={Boolean(design[option[0] as keyof LabelDesign])} on:change={(event) => setBoolean(option[0] as keyof LabelDesign, event.currentTarget.checked)} />{option[1]}</label>
                    {/each}
                </div>
            </div>
        </section>

        <aside class="settings-section label-preview-area">
            <div><h3 class="settings-section-title !mb-0">Live Preview</h3><span>{design.widthMm} × {design.heightMm} mm</span></div>
            {#if selectedProduct}<ProductLabel product={selectedProduct as Product} store={$storeDB} {design} preview />{:else}<p>Select an item to preview its label.</p>{/if}
        </aside>
    </div>
</MgmtPage>

<div class="label-print-sheet">
    {#if selectedProduct}{#each copies as _}<ProductLabel product={selectedProduct as Product} store={$storeDB} {design} />{/each}{/if}
</div>

<style>
    .label-workspace { padding: 1.5rem; display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(340px, .8fr); gap: 1.5rem; }
    .label-controls { display: flex; flex-direction: column; gap: 1rem; }
    .product-results { margin-top: .75rem; max-height: 220px; overflow-y: auto; border: 1px solid var(--border-flat); border-radius: .5rem; }
    .product-results button { width: 100%; padding: .7rem; display: flex; justify-content: space-between; gap: 1rem; text-align: left; border-bottom: 1px solid var(--border-flat); background: var(--bg-panel); }
    .product-results button.active { background: color-mix(in srgb, var(--accent-primary) 16%, var(--bg-panel)); }
    .product-results span, .product-results small { display: block; }
    .product-results small { color: var(--text-muted); }
    .preset-grid { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: .5rem; }
    .preset-grid button, .template-grid button { padding: .75rem; border: 1px solid var(--border-flat); border-radius: .4rem; background: var(--bg-panel); }
    .preset-grid button.active, .template-grid button.active { border-color: var(--accent-primary); background: color-mix(in srgb, var(--accent-primary) 14%, var(--bg-panel)); }
    .template-grid { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: .6rem; }
    .template-grid button { text-align: left; }
    .template-grid small { display: block; margin-top: .25rem; color: var(--text-muted); }
    .switch-grid { margin-top: 1rem; display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: .5rem; }
    .switch-grid label { padding: .7rem; display: flex; align-items: center; gap: .6rem; border: 1px solid var(--border-flat); border-radius: .4rem; background: var(--bg-panel); }
    .label-preview-area { position: sticky; top: 0; align-self: start; min-height: 520px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2rem; overflow: auto; }
    .label-preview-area > div:first-child { width: 100%; display: flex; justify-content: space-between; }
    .label-print-sheet { display: none; }
    @media (max-width: 950px) { .label-workspace { grid-template-columns: 1fr; padding: .75rem; } .label-preview-area { position: static; min-height: 360px; } }
    @media print {
        :global(.management-page), :global(.fullscreen-toggle), :global(.toast-pop), :global(.touch-input-backdrop) { display: none !important; }
        .label-print-sheet { display: block !important; }
        @page { margin: 0; }
    }
</style>
