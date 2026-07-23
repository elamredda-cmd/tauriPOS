<script lang="ts">
    import { onDestroy, onMount, tick } from 'svelte';
    import { Printer, RotateCcw, Save } from '@lucide/svelte';
    import AdminPageHeader from '$lib/components/AdminPageHeader.svelte';
    import ProductLabel from '$lib/components/ProductLabel.svelte';
    import CustomSelect from '$lib/components/CustomSelect.svelte';
    import { formatMoney, now, settingsDB, storeDB, type Product } from '$lib/stores/db';
    import { getProductsPage, upsert } from '$lib/stores/database';
    import { toast } from '$lib/stores/toast';
    import {
        clampLabelSizePercent,
        clampLabelNameCharacterLimit,
        defaultLabelDesign,
        getLabelDesign,
        labelSizePresets,
        type LabelDatePosition,
        type LabelDesign,
        type LabelTemplate,
    } from '$lib/labels';
    import { getLabelPrinterConfig, printProductLabels } from '$lib/printers';

    type EditorTab = 'item' | 'size' | 'design';

    let design: LabelDesign = getLabelDesign($settingsDB);
    let activeTab: EditorTab = 'item';
    let search = '';
    let productResults: Product[] = [];
    let productTotal = 0;
    let productTotalCapped = false;
    let productLoading = false;
    let productError = '';
    let productLoadVersion = 0;
    let productSearchTimer: ReturnType<typeof setTimeout> | undefined;
    let selectedProduct: Product | null = null;
    let quantity = 1;
    let savingDesign = false;
    let printingLabels = false;

    $: labelPrinter = getLabelPrinterConfig($settingsDB);
    $: copies = Array.from({ length: Math.max(1, Math.min(500, Math.floor(quantity || 1))) });
    $: renderSystemPrintSheet = printingLabels && (labelPrinter.connection === 'system' || labelPrinter.protocol === 'system');

    const templates: Array<{ id: LabelTemplate; name: string; description: string }> = [
        { id: 'compact', name: 'Compact', description: 'Price-led' },
        { id: 'standard', name: 'Standard', description: 'Balanced' },
        { id: 'barcode', name: 'Barcode', description: 'Scan-led' },
        { id: 'shelf', name: 'Shelf', description: 'Large price' },
    ];
    const visibilityOptions: Array<{ key: keyof LabelDesign; label: string }> = [
        { key: 'showStore', label: 'Store name' },
        { key: 'showName', label: 'Item name' },
        { key: 'showPrice', label: 'Price' },
        { key: 'showBarcode', label: 'Barcode' },
        { key: 'showBarcodeText', label: 'Barcode number' },
        { key: 'showSku', label: 'SKU' },
        { key: 'showPlu', label: 'PLU' },
    ];
    const fontOptions = [
        { label: 'Standard', value: 'standard' },
        { label: 'Condensed', value: 'condensed' },
        { label: 'Serif', value: 'serif' },
    ];
    const datePositionOptions: Array<{ value: LabelDatePosition; label: string }> = [
        { value: 'top-left', label: 'Top left' },
        { value: 'top-center', label: 'Top centre' },
        { value: 'top-right', label: 'Top right' },
        { value: 'bottom-left', label: 'Bottom left' },
        { value: 'bottom-center', label: 'Bottom centre' },
        { value: 'bottom-right', label: 'Bottom right' },
    ];

    function scheduleProductSearch(delay = 180) {
        if (productSearchTimer) clearTimeout(productSearchTimer);
        productSearchTimer = setTimeout(() => void loadProducts(), delay);
    }

    async function loadProducts() {
        const version = ++productLoadVersion;
        productLoading = true;
        productError = '';
        try {
            const result = await getProductsPage({
                query: search,
                status: 'active',
                limit: 60,
                offset: 0,
                compact: false,
            });
            if (version !== productLoadVersion) return;
            productResults = result.rows as Product[];
            productTotal = result.total;
            productTotalCapped = Boolean(result.totalIsCapped);
            if (!selectedProduct && productResults.length) selectedProduct = productResults[0];
        } catch (error) {
            if (version !== productLoadVersion) return;
            productResults = [];
            productTotal = 0;
            productError = String(error);
        } finally {
            if (version === productLoadVersion) productLoading = false;
        }
    }

    function handleSearchInput(event: Event) {
        search = (event.currentTarget as HTMLInputElement).value;
        scheduleProductSearch();
    }

    function usePreset(width: number, height: number) {
        design = { ...design, widthMm: width, heightMm: height };
    }

    function setBoolean(key: keyof LabelDesign, value: boolean) {
        design = { ...design, [key]: value };
    }

    function setSizePercent(
        key: 'textSizePercent' | 'nameSizePercent' | 'priceSizePercent' | 'barcodeSizePercent',
        value: string,
    ) {
        const limits = key === 'barcodeSizePercent'
            ? [50, 170]
            : key === 'priceSizePercent'
                ? [60, 200]
                : [60, 180];
        design = {
            ...design,
            [key]: clampLabelSizePercent(value, limits[0], limits[1]),
        };
    }

    function setNameCharacterLimit(value: string) {
        design = { ...design, nameCharacterLimit: clampLabelNameCharacterLimit(value) };
    }

    function resetDesign() {
        design = { ...defaultLabelDesign };
    }

    async function saveDesign() {
        if (savingDesign) return;
        savingDesign = true;
        const setting = { key: 'label_design', value: JSON.stringify(design), updatedAt: now() };
        try {
            await upsert('settings', setting, 'key');
            settingsDB.update((list) => [...list.filter((item) => item.key !== setting.key), setting]);
            toast('Label design saved', 'success');
        } catch (error) {
            toast(`Label design was not saved: ${error}`, 'error');
        } finally {
            savingDesign = false;
        }
    }

    async function printLabels() {
        if (!selectedProduct) {
            toast('Select an item to print', 'error');
            activeTab = 'item';
            return;
        }
        if (printingLabels) return;
        if (labelPrinter.connection === 'system' || labelPrinter.protocol === 'system') {
            printingLabels = true;
            try {
                await tick();
                window.print();
                toast('Print dialog opened for labels', 'success');
            } finally {
                printingLabels = false;
            }
            return;
        }
        printingLabels = true;
        try {
            await printProductLabels({ product: selectedProduct, store: $storeDB, design, quantity }, labelPrinter);
            toast('Label sent to printer', 'success');
        } catch (error) {
            toast(`Label did not print: ${error}`, 'error');
        } finally {
            printingLabels = false;
        }
    }

    onMount(() => void loadProducts());
    onDestroy(() => {
        if (productSearchTimer) clearTimeout(productSearchTimer);
    });
</script>

<svelte:head>
    <title>Label Designer - L&amp;Bj POS</title>
</svelte:head>

<div class="label-designer-page">
    <AdminPageHeader
        title="Label Designer"
        eyebrow="Design Studio"
        description={`${design.widthMm} × ${design.heightMm} mm${selectedProduct ? ` · ${selectedProduct.name}` : ''}`}
        backFallback="/design"
        padded
    >
        <button type="button" class="btn btn-secondary" disabled={savingDesign || printingLabels} on:click={resetDesign}>
            <RotateCcw size={18} strokeWidth={2.35} aria-hidden="true" />
            Reset
        </button>
        <button type="button" class="btn btn-secondary" disabled={savingDesign || printingLabels} on:click={saveDesign}>
            <Save size={18} strokeWidth={2.35} aria-hidden="true" />
            {savingDesign ? 'Saving' : 'Save'}
        </button>
        <button type="button" class="btn btn-primary" disabled={printingLabels || !selectedProduct} on:click={printLabels}>
            <Printer size={18} strokeWidth={2.35} aria-hidden="true" />
            {printingLabels ? 'Printing' : 'Print'}
        </button>
    </AdminPageHeader>

    <main class="label-workspace">
        <section class="editor-panel">
            <div class="editor-tabs" role="tablist" aria-label="Label editor sections">
                <button type="button" role="tab" aria-selected={activeTab === 'item'} class:active={activeTab === 'item'} on:click={() => activeTab = 'item'}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 13V6a2 2 0 0 0-2-2h-5"></path><path d="M4 4h5v5H4z"></path><path d="M4 15h5v5H4z"></path><path d="M15 15h5v5h-5z"></path><path d="M6.5 9v6"></path><path d="M9 6.5h4"></path></svg>
                    Item
                </button>
                <button type="button" role="tab" aria-selected={activeTab === 'size'} class:active={activeTab === 'size'} on:click={() => activeTab = 'size'}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"></path><path d="M8 3v4"></path><path d="M12 3v2"></path><path d="M16 3v4"></path><path d="M4 9h4"></path><path d="M4 13h2"></path><path d="M4 17h4"></path></svg>
                    Size
                </button>
                <button type="button" role="tab" aria-selected={activeTab === 'design'} class:active={activeTab === 'design'} on:click={() => activeTab = 'design'}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z"></path></svg>
                    Design
                </button>
            </div>

            <div class="editor-body" role="tabpanel">
                {#if activeTab === 'item'}
                    <div class="item-tools">
                        <div class="search-box">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg>
                            <input value={search} on:input={handleSearchInput} placeholder="Name, SKU, barcode or PLU" aria-label="Find item" />
                            {#if search}<button type="button" aria-label="Clear item search" title="Clear search" on:click={() => { search = ''; scheduleProductSearch(0); }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12"></path><path d="m18 6-12 12"></path></svg></button>{/if}
                        </div>
                        <div class="result-count">{productLoading ? 'Searching' : `${productTotalCapped ? `${productTotal}+` : productTotal} items`}</div>
                    </div>
                    <div class="product-results" aria-live="polite">
                        {#if productError}
                            <div class="empty-state error">Item search failed.</div>
                        {:else if productLoading && productResults.length === 0}
                            <div class="empty-state">Searching…</div>
                        {:else if productResults.length === 0}
                            <div class="empty-state">No matching items.</div>
                        {:else}
                            {#each productResults as product}
                                <button type="button" class:selected={selectedProduct?.id === product.id} on:click={() => selectedProduct = product}>
                                    <span>
                                        <strong>{product.name}</strong>
                                        <small>{product.barcode || product.sku || product.scalePlu || 'No product code'}</small>
                                    </span>
                                    <b>{formatMoney(product.price)}</b>
                                    {#if selectedProduct?.id === product.id}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m20 6-11 11-5-5"></path></svg>{/if}
                                </button>
                            {/each}
                        {/if}
                    </div>
                {:else if activeTab === 'size'}
                    <div class="section-heading">
                        <div><span>Label size</span><h2>{design.widthMm} × {design.heightMm} mm</h2></div>
                    </div>
                    <div class="preset-grid">
                        {#each labelSizePresets as preset}
                            <button type="button" class:active={design.widthMm === preset.width && design.heightMm === preset.height} on:click={() => usePreset(preset.width, preset.height)}>{preset.label}</button>
                        {/each}
                    </div>
                    <div class="size-fields">
                        <label for="label-width">Width (mm)<input id="label-width" type="number" min="15" max="210" bind:value={design.widthMm} /></label>
                        <label for="label-height">Height (mm)<input id="label-height" type="number" min="15" max="297" bind:value={design.heightMm} /></label>
                        <label for="label-quantity">Copies<input id="label-quantity" type="number" min="1" max="500" bind:value={quantity} /></label>
                    </div>
                {:else}
                    <div class="design-scroll">
                        <div class="section-heading"><div><span>Template</span><h2>Label layout</h2></div></div>
                        <div class="template-grid">
                            {#each templates as template}
                                <button type="button" class:active={design.template === template.id} on:click={() => design = { ...design, template: template.id }}>
                                    <strong>{template.name}</strong><small>{template.description}</small>
                                </button>
                            {/each}
                        </div>

                        <div class="select-grid font-select-grid">
                            <CustomSelect label="Font" bind:value={design.fontFamily} options={fontOptions} />
                            <label class="character-limit-field" for="label-name-character-limit">
                                <span>Name characters</span>
                                <input
                                    id="label-name-character-limit"
                                    type="number"
                                    min="5"
                                    max="80"
                                    step="1"
                                    value={design.nameCharacterLimit}
                                    on:input={(event) => setNameCharacterLimit(event.currentTarget.value)}
                                />
                            </label>
                        </div>

                        <div class="size-control-grid">
                            <label>
                                <span><b>Item name</b><output>{design.nameSizePercent}%</output></span>
                                <input type="range" min="60" max="180" step="5" value={design.nameSizePercent} on:input={(event) => setSizePercent('nameSizePercent', event.currentTarget.value)} />
                            </label>
                            <label>
                                <span><b>Price</b><output>{design.priceSizePercent}%</output></span>
                                <input type="range" min="60" max="200" step="5" value={design.priceSizePercent} on:input={(event) => setSizePercent('priceSizePercent', event.currentTarget.value)} />
                            </label>
                            <label>
                                <span><b>Other writing</b><output>{design.textSizePercent}%</output></span>
                                <input type="range" min="60" max="180" step="5" value={design.textSizePercent} on:input={(event) => setSizePercent('textSizePercent', event.currentTarget.value)} />
                            </label>
                            <label>
                                <span><b>Barcode height</b><output>{design.barcodeSizePercent}%</output></span>
                                <input type="range" min="50" max="170" step="5" value={design.barcodeSizePercent} on:input={(event) => setSizePercent('barcodeSizePercent', event.currentTarget.value)} />
                            </label>
                        </div>

                        <div class="visibility-grid">
                            {#each visibilityOptions as option}
                                <button type="button" role="switch" aria-checked={Boolean(design[option.key])} class:active={Boolean(design[option.key])} on:click={() => setBoolean(option.key, !design[option.key])}>
                                    <span>{option.label}</span><i><b></b></i>
                                </button>
                            {/each}
                        </div>

                        <div class="date-editor">
                            <button type="button" role="switch" aria-checked={design.showPrintDate} class:active={design.showPrintDate} on:click={() => setBoolean('showPrintDate', !design.showPrintDate)}>
                                <span><strong>Print date</strong><small>Current day only, without a time</small></span>
                                <i><b></b></i>
                            </button>
                            {#if design.showPrintDate}
                                <div class="date-position-grid" aria-label="Print date position">
                                    {#each datePositionOptions as position}
                                        <button type="button" aria-pressed={design.printDatePosition === position.value} class:active={design.printDatePosition === position.value} on:click={() => design = { ...design, printDatePosition: position.value }}>
                                            <i class="position-icon {position.value}"><b></b></i>
                                            <span>{position.label}</span>
                                        </button>
                                    {/each}
                                </div>
                            {/if}
                        </div>
                    </div>
                {/if}
            </div>
        </section>

        <aside class="preview-panel">
            <div class="preview-heading">
                <div><span>Live preview</span><h2>{selectedProduct?.name || 'No item selected'}</h2></div>
                <b>{design.widthMm} × {design.heightMm} mm</b>
            </div>
            <div class="preview-stage">
                {#if selectedProduct}
                    <ProductLabel product={selectedProduct} store={$storeDB} {design} preview />
                {:else}
                    <div class="preview-empty">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.6 13.6 11 4l-7 7 9.6 9.6a2 2 0 0 0 2.8 0l4.2-4.2a2 2 0 0 0 0-2.8z"></path><circle cx="7.5" cy="10.5" r="1.2"></circle></svg>
                        <span>Select an item</span>
                    </div>
                {/if}
            </div>
            <div class="preview-footer">
                <span>{templates.find((template) => template.id === design.template)?.name}</span>
                <span>{Math.max(1, Math.min(500, Math.floor(quantity || 1)))} {quantity === 1 ? 'copy' : 'copies'}</span>
            </div>
        </aside>
    </main>
</div>

<div class="label-print-sheet">
    {#if renderSystemPrintSheet && selectedProduct}{#each copies as _}<ProductLabel product={selectedProduct} store={$storeDB} {design} />{/each}{/if}
</div>

<style>
    .label-designer-page { box-sizing: border-box; height: 100dvh; min-height: 580px; overflow: hidden; display: flex; flex-direction: column; background: var(--bg-base); color: var(--text-main); }
    .section-heading span, .preview-heading span { display: block; color: var(--accent-primary); font-size: .68rem; line-height: 1; font-weight: 900; text-transform: uppercase; }
    button:disabled { cursor: not-allowed; opacity: .42; }
    button:focus-visible, input:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 2px; }

    .label-workspace { flex: 1; min-height: 0; padding: 0 var(--app-page-gutter, 1.5rem) var(--app-page-gutter, 1.5rem); display: grid; grid-template-columns: minmax(430px, 1.08fr) minmax(320px, .92fr); gap: .65rem; }
    .editor-panel, .preview-panel { min-width: 0; min-height: 0; overflow: hidden; border: 1px solid var(--border-flat); border-radius: 8px; background: var(--bg-panel); }
    .editor-panel { display: flex; flex-direction: column; }
    .editor-tabs { flex: 0 0 52px; padding: .35rem; display: grid; grid-template-columns: repeat(3, 1fr); gap: .35rem; border-bottom: 1px solid var(--border-flat); }
    .editor-tabs button { min-width: 0; display: flex; align-items: center; justify-content: center; gap: .45rem; border: 1px solid transparent; border-radius: 5px; background: transparent; color: var(--text-muted); font-weight: 900; }
    .editor-tabs button svg { width: 18px; height: 18px; }
    .editor-tabs button.active { border-color: color-mix(in srgb, var(--accent-primary) 55%, var(--border-flat)); background: color-mix(in srgb, var(--accent-primary) 13%, var(--bg-card)); color: var(--accent-primary); }
    .editor-body { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }

    .item-tools { padding: .55rem; display: flex; align-items: center; gap: .55rem; border-bottom: 1px solid var(--border-flat); }
    .search-box { flex: 1; height: 42px; padding: 0 .65rem; display: flex; align-items: center; gap: .5rem; border: 1px solid var(--border-flat); border-radius: 6px; background: var(--bg-base); }
    .search-box:focus-within { border-color: var(--accent-primary); }
    .search-box > svg { width: 18px; height: 18px; flex: 0 0 auto; color: var(--text-muted); }
    .search-box input { min-width: 0; flex: 1; border: 0; outline: 0; background: transparent; color: var(--text-main); font: inherit; }
    .search-box button { width: 30px; height: 30px; display: grid; place-items: center; border: 0; background: transparent; color: var(--text-muted); }
    .search-box button svg { width: 16px; height: 16px; }
    .result-count { flex: 0 0 auto; color: var(--text-muted); font-size: .72rem; font-weight: 800; }
    .product-results { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: .45rem; scrollbar-color: var(--accent-primary) var(--bg-card); }
    .product-results > button { width: 100%; min-height: 52px; padding: .4rem .6rem; display: grid; grid-template-columns: minmax(0, 1fr) auto 21px; align-items: center; gap: .55rem; border: 0; border-bottom: 1px solid var(--border-flat); background: transparent; color: var(--text-main); text-align: left; }
    .product-results > button:first-of-type { border-top: 1px solid var(--border-flat); }
    .product-results > button:hover { background: color-mix(in srgb, var(--text-main) 5%, transparent); }
    .product-results > button.selected { box-shadow: inset 3px 0 0 var(--accent-primary); background: color-mix(in srgb, var(--accent-primary) 13%, transparent); color: var(--accent-primary); }
    .product-results > button span { min-width: 0; }
    .product-results strong, .product-results small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .product-results strong { font-size: .86rem; }
    .product-results small { margin-top: .14rem; color: var(--text-muted); font-size: .68rem; }
    .product-results > button > b { font-size: .86rem; }
    .product-results > button > svg { width: 18px; height: 18px; }
    .empty-state { height: 100%; min-height: 160px; display: grid; place-items: center; color: var(--text-muted); font-weight: 800; }
    .empty-state.error { color: var(--danger); }

    .section-heading { min-height: 52px; padding: .6rem .7rem; display: flex; align-items: center; border-bottom: 1px solid var(--border-flat); }
    .section-heading h2, .preview-heading h2 { margin: .22rem 0 0; overflow: hidden; font-size: 1rem; line-height: 1.05; text-overflow: ellipsis; white-space: nowrap; }
    .preset-grid { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: .55rem; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); grid-auto-rows: minmax(44px, 1fr); gap: .35rem; }
    .preset-grid button, .template-grid button { min-width: 0; border: 1px solid var(--border-flat); border-radius: 5px; background: var(--bg-card); color: var(--text-main); font-weight: 850; }
    .preset-grid button.active, .template-grid button.active { border-color: var(--accent-primary); background: color-mix(in srgb, var(--accent-primary) 14%, var(--bg-card)); color: var(--accent-primary); }
    .size-fields { padding: .55rem; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .5rem; border-top: 1px solid var(--border-flat); }
    .size-fields label { min-width: 0; color: var(--text-muted); font-size: .7rem; font-weight: 900; }
    .size-fields input { box-sizing: border-box; width: 100%; height: 40px; margin-top: .25rem; padding: 0 .6rem; border: 1px solid var(--border-flat); border-radius: 5px; outline: 0; background: var(--bg-base); color: var(--text-main); font: inherit; font-size: .88rem; }
    .size-fields input:focus { border-color: var(--accent-primary); }

    .design-scroll { height: 100%; overflow-y: auto; overscroll-behavior: contain; scrollbar-color: var(--accent-primary) var(--bg-card); }
    .template-grid { padding: .55rem; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: .35rem; }
    .template-grid button { min-height: 54px; padding: .4rem; text-align: left; }
    .template-grid strong, .template-grid small { display: block; }
    .template-grid strong { font-size: .82rem; }
    .template-grid small { margin-top: .16rem; color: var(--text-muted); font-size: .64rem; }
    .select-grid { padding: .55rem; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .5rem; border-top: 1px solid var(--border-flat); }
    .font-select-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: end; }
    .select-grid :global(button) { border-radius: 5px; box-shadow: none; }
    .character-limit-field { min-width: 0; display: flex; flex-direction: column; gap: .38rem; color: var(--text-muted); font-size: .8rem; font-weight: 900; text-transform: uppercase; }
    .character-limit-field input { box-sizing: border-box; width: 100%; height: 48px; padding: 0 .75rem; border: 1px solid var(--border-flat); border-radius: 5px; outline: 0; background: var(--bg-panel); color: var(--text-main); font: inherit; font-size: 1rem; text-transform: none; }
    .character-limit-field input:focus { border-color: var(--accent-primary); background: var(--bg-card); }
    .size-control-grid { padding: .55rem; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .45rem; border-top: 1px solid var(--border-flat); }
    .size-control-grid label { min-width: 0; min-height: 62px; padding: .45rem .55rem; display: flex; flex-direction: column; justify-content: center; gap: .35rem; border: 1px solid var(--border-flat); border-radius: 5px; background: var(--bg-card); }
    .size-control-grid label > span { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
    .size-control-grid b { overflow: hidden; font-size: .76rem; text-overflow: ellipsis; white-space: nowrap; }
    .size-control-grid output { color: var(--accent-primary); font-size: .72rem; font-weight: 900; }
    .size-control-grid input { width: 100%; height: 22px; margin: 0; accent-color: var(--accent-primary); cursor: pointer; }
    .visibility-grid { padding: .55rem; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .35rem; border-top: 1px solid var(--border-flat); }
    .visibility-grid button { min-height: 42px; padding: .38rem .5rem; display: flex; align-items: center; justify-content: space-between; gap: .4rem; border: 1px solid var(--border-flat); border-radius: 5px; background: var(--bg-card); color: var(--text-main); font-size: .76rem; font-weight: 800; text-align: left; }
    .visibility-grid button.active { border-color: color-mix(in srgb, var(--success) 58%, var(--border-flat)); }
    .visibility-grid i { width: 36px; height: 21px; padding: 2px; flex: 0 0 auto; display: block; border-radius: 12px; background: var(--bg-card-hover); }
    .visibility-grid i b { width: 17px; height: 17px; display: block; border-radius: 50%; background: var(--text-muted); }
    .visibility-grid button.active i { background: var(--success); }
    .visibility-grid button.active i b { margin-left: 15px; background: #fff; }
    .date-editor { padding: .55rem; border-top: 1px solid var(--border-flat); }
    .date-editor > button { width: 100%; min-height: 48px; padding: .45rem .55rem; display: flex; align-items: center; justify-content: space-between; gap: .65rem; border: 1px solid var(--border-flat); border-radius: 5px; background: var(--bg-card); color: var(--text-main); text-align: left; }
    .date-editor > button.active { border-color: color-mix(in srgb, var(--success) 58%, var(--border-flat)); }
    .date-editor > button span { min-width: 0; }
    .date-editor > button strong, .date-editor > button small { display: block; }
    .date-editor > button strong { font-size: .8rem; }
    .date-editor > button small { margin-top: .15rem; overflow: hidden; color: var(--text-muted); font-size: .66rem; text-overflow: ellipsis; white-space: nowrap; }
    .date-editor > button > i { width: 36px; height: 21px; padding: 2px; flex: 0 0 auto; display: block; border-radius: 12px; background: var(--bg-card-hover); }
    .date-editor > button > i b { width: 17px; height: 17px; display: block; border-radius: 50%; background: var(--text-muted); }
    .date-editor > button.active > i { background: var(--success); }
    .date-editor > button.active > i b { margin-left: 15px; background: #fff; }
    .date-position-grid { margin-top: .5rem; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .4rem; }
    .date-position-grid > button { min-width: 0; min-height: 50px; padding: .35rem; display: flex; align-items: center; justify-content: center; gap: .35rem; border: 1px solid var(--border-flat); border-radius: 5px; background: var(--bg-card); color: var(--text-main); font-size: .68rem; font-weight: 850; }
    .date-position-grid > button.active { border-color: var(--accent-primary); background: color-mix(in srgb, var(--accent-primary) 14%, var(--bg-card)); color: var(--accent-primary); }
    .position-icon { position: relative; width: 24px; height: 16px; flex: 0 0 auto; display: block; border: 1px solid currentColor; border-radius: 2px; opacity: .8; }
    .position-icon b { position: absolute; width: 4px; height: 4px; border-radius: 50%; background: currentColor; }
    .position-icon.top-left b { top: 2px; left: 2px; }
    .position-icon.top-center b { top: 2px; left: 50%; transform: translateX(-50%); }
    .position-icon.top-right b { top: 2px; right: 2px; }
    .position-icon.bottom-left b { bottom: 2px; left: 2px; }
    .position-icon.bottom-center b { bottom: 2px; left: 50%; transform: translateX(-50%); }
    .position-icon.bottom-right b { right: 2px; bottom: 2px; }

    .preview-panel { display: flex; flex-direction: column; }
    .preview-heading { min-height: 56px; padding: .65rem .75rem; display: flex; align-items: center; justify-content: space-between; gap: .7rem; border-bottom: 1px solid var(--border-flat); }
    .preview-heading > div { min-width: 0; }
    .preview-heading > b { flex: 0 0 auto; color: var(--text-muted); font-size: .72rem; }
    .preview-stage { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; display: grid; place-items: center; padding: .75rem; background-color: var(--bg-base); background-image: linear-gradient(var(--border-flat) 1px, transparent 1px), linear-gradient(90deg, var(--border-flat) 1px, transparent 1px); background-size: 24px 24px; }
    .preview-empty { display: flex; flex-direction: column; align-items: center; gap: .65rem; color: var(--text-muted); font-weight: 800; }
    .preview-empty svg { width: 48px; height: 48px; }
    .preview-footer { min-height: 40px; padding: 0 .75rem; display: flex; align-items: center; justify-content: space-between; gap: .7rem; border-top: 1px solid var(--border-flat); color: var(--text-muted); font-size: .72rem; font-weight: 800; }
    .label-print-sheet { display: none; }

    @media (max-width: 900px) and (min-width: 720px) {
        .label-workspace { grid-template-columns: minmax(390px, 1.18fr) minmax(290px, .82fr); gap: .6rem; }
        .template-grid, .visibility-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .preview-stage { padding: .55rem; }
    }
    @media (max-width: 719px) {
        .label-designer-page { min-height: 100dvh; height: auto; overflow: auto; }
        .label-workspace { grid-template-columns: 1fr; }
        .editor-panel { height: 600px; min-height: 520px; }
        .preview-panel { min-height: 380px; }
        .visibility-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 660px) {
        .template-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media print {
        .label-designer-page, :global(.fullscreen-toggle), :global(.toast-pop), :global(.touch-input-backdrop) { display: none !important; }
        .label-print-sheet { display: block !important; }
        @page { margin: 0; }
    }
</style>
