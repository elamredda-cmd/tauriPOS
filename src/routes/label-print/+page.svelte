<script lang="ts">
    import { onDestroy, onMount, tick } from 'svelte';
    import { isTauri } from '@tauri-apps/api/core';
    import { clearSystemPrintSnapshot } from '$lib/systemPrint';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import ProductLabel from '$lib/components/ProductLabel.svelte';
    import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
    import SearchField from '$lib/components/SearchField.svelte';
    import { settingsDB, storeDB, formatMoney, type Product, type Store } from '$lib/stores/db';
    import { getProductsPage } from '$lib/stores/database';
    import { getLabelDesign, type LabelDesign } from '$lib/labels';
    import { toast } from '$lib/stores/toast';
    import { getLabelPrinterConfig, printProductLabels } from '$lib/printers';
    import { nativeQaEnabled, nativeQaCheckpoint } from '$lib/nativeQa';

    let search = '';
    let searchInput: HTMLInputElement | null = null;
    let selected = new Map<string, { product: Product; quantity: number }>();
    let matches: Product[] = [];
    let productsLoading = true;
    let productLoadError = '';
    let productSearchTimer: ReturnType<typeof setTimeout> | null = null;
    let productLoadToken = 0;
    const PRODUCT_PAGE_SIZE = 100;
    let productPage = 0;
    let productTotal = 0;
    let productTotalCapped = false;
    let searchSelectionToken = 0;
    $: productsHaveMore = productTotalCapped ? matches.length === PRODUCT_PAGE_SIZE : (productPage + 1) * PRODUCT_PAGE_SIZE < productTotal;
    let mounted = false;
    let printingLabels = false;
    let printCancellation: { cancelled: boolean } | null = null;
    let printSheetProducts: Product[] = [];
    let printSheetContext: { store: Store; design: LabelDesign } | null = null;
    let showLargePrintConfirm = false;
    const LARGE_PRINT_THRESHOLD = 50;
    $: design = getLabelDesign($settingsDB);
    $: labelPrinter = getLabelPrinterConfig($settingsDB);
    $: selectedProducts = Array.from(selected.values());
    $: systemPrintMode = labelPrinter.connection === 'system' || labelPrinter.protocol === 'system';
    $: totalLabels = selectedProducts.reduce((sum, item) => sum + item.quantity, 0);
    $: printPageWidth = Math.max(15, Math.min(210, Number((printSheetContext?.design || design).widthMm) || 50));
    $: printPageHeight = Math.max(15, Math.min(297, Number((printSheetContext?.design || design).heightMm) || 30));
    $: printerModeLabel = systemPrintMode
        ? 'System print dialog'
        : labelPrinter.connection === 'module'
            ? 'Installed printer module'
        : labelPrinter.protocol === 'star'
            ? 'Star Graphic'
            : labelPrinter.protocol === 'tspl'
                ? 'TSPL raster'
                : labelPrinter.protocol === 'zpl'
                    ? 'ZPL raster'
                    : 'ESC/POS raster';
    $: printerTargetLabel = systemPrintMode
        ? 'Choose the printer in the system dialog'
        : labelPrinter.connection === 'network_escpos'
            ? `${labelPrinter.host || 'No IP address'}:${labelPrinter.port}`
            : labelPrinter.connection === 'usb_raw'
                ? labelPrinter.printerName || 'No Windows printer selected'
                : labelPrinter.connection === 'module'
                    ? labelPrinter.moduleDeviceId || labelPrinter.moduleId || 'No printer module selected'
                : labelPrinter.devicePath || 'No printer port selected';
    $: printerReady = labelPrinter.enabled && (
        systemPrintMode
        || (labelPrinter.connection === 'network_escpos' && Boolean(labelPrinter.host.trim()))
        || (labelPrinter.connection === 'usb_raw' && Boolean(labelPrinter.printerName.trim()))
        || (labelPrinter.connection === 'module' && Boolean(labelPrinter.moduleId.trim()))
        || ((labelPrinter.connection === 'serial' || labelPrinter.connection === 'bluetooth') && Boolean(labelPrinter.devicePath.trim()))
    );

    onMount(() => {
        mounted = true;
        void loadProductMatches('');
        void tick().then(() => searchInput?.focus({ preventScroll: true }));
    });

    onDestroy(() => {
        mounted = false;
        productLoadToken += 1;
        searchSelectionToken += 1;
        if (productSearchTimer) clearTimeout(productSearchTimer);
    });

    function scheduleProductSearch(query: string, delay = 160) {
        productLoadToken += 1;
        productsLoading = true;
        if (productSearchTimer) clearTimeout(productSearchTimer);
        productSearchTimer = setTimeout(() => void loadProductMatches(query), delay);
    }

    async function loadProductMatches(query: string, page = productPage): Promise<Product[]> {
        const token = ++productLoadToken;
        productsLoading = true;
        productLoadError = '';
        try {
            const result = await getProductsPage({
                query: query.trim(),
                status: 'active',
                limit: PRODUCT_PAGE_SIZE,
                offset: page * PRODUCT_PAGE_SIZE,
            });
            if (nativeQaEnabled) await nativeQaCheckpoint('label.suggestions');
            const rows = result.rows as Product[];
            if (mounted && token === productLoadToken) {
                matches = rows;
                productTotal = result.total;
                productTotalCapped = Boolean(result.totalIsCapped);
            }
            return rows;
        } catch (error) {
            if (mounted && token === productLoadToken) {
                matches = [];
                productLoadError = `Could not load items: ${error}`;
            }
            return [];
        } finally {
            if (mounted && token === productLoadToken) productsLoading = false;
        }
    }

    function handleSearchInput(event: Event) {
        searchSelectionToken += 1;
        productPage = 0;
        search = (event.currentTarget as HTMLInputElement).value;
        scheduleProductSearch(search);
    }

    function clearProductSearch() {
        searchSelectionToken += 1;
        productPage = 0;
        search = '';
        scheduleProductSearch('', 0);
    }

    function selectProduct(product: Product) {
        if (printingLabels) return;
        searchSelectionToken += 1;
        const next = new Map(selected);
        const current = next.get(product.id);
        next.set(product.id, { product, quantity: Math.min(500, (current?.quantity || 0) + 1) });
        selected = next;
        search = '';
        productPage = 0;
        scheduleProductSearch('', 0);
        tick().then(() => searchInput?.focus({ preventScroll: true }));
    }

    function setQuantity(id: string, quantity: number) {
        const next = new Map(selected);
        const normalized = Number.isFinite(quantity) ? Math.floor(quantity) : 1;
        if (normalized <= 0) next.delete(id);
        else {
            const current = next.get(id);
            if (current) next.set(id, { ...current, quantity: Math.min(500, Math.max(1, normalized)) });
        }
        selected = next;
    }

    function clearSelected() {
        selected = new Map();
        printSheetProducts = [];
        printSheetContext = null;
        void tick().then(() => searchInput?.focus({ preventScroll: true }));
    }

    function deselectPrintedProduct(productId: string) {
        const next = new Map(selected);
        next.delete(productId);
        selected = next;
    }

    async function handleSearchKeydown(event: KeyboardEvent) {
        if (event.key !== 'Enter' || printingLabels || event.repeat) return;
        event.preventDefault();
        if (productSearchTimer) clearTimeout(productSearchTimer);
        const query = search.trim().toLowerCase();
        const token = ++searchSelectionToken;
        productPage = 0;
        const currentMatches = await loadProductMatches(query, 0);
        if (!mounted || token !== searchSelectionToken || printingLabels) return;
        const exact = currentMatches.find(product => product.isActive && [
            product.barcode, product.sku, product.scalePlu
        ].some(value => String(value || '').toLowerCase() === query));
        const chosen = exact || currentMatches[0];
        if (chosen) selectProduct(chosen);
        else toast('No matching item found', 'error');
    }

    function requestPrintLabels() {
        if (printingLabels) return;
        if (totalLabels > LARGE_PRINT_THRESHOLD) {
            showLargePrintConfirm = true;
            return;
        }
        void printLabels();
    }

    function stopPrintingLabels() {
        if (!printCancellation) return;
        printCancellation.cancelled = true;
        toast('Stopping after the current printer batch', 'info');
    }

    async function printLabels() {
        if (totalLabels === 0) { toast('Select at least one item', 'error'); return; }
        if (printingLabels) return;
        if (!labelPrinter.enabled) { toast('Label printing is disabled in Printer Setup', 'error'); return; }
        if (!printerReady) { toast('Finish the label printer setup before printing', 'error'); return; }

        const jobs = selectedProducts.map((item) => ({ ...item, product: { ...item.product } }));
        const requestedTotal = totalLabels;
        if (systemPrintMode) {
            printingLabels = true;
            const retainNativeSnapshot = isTauri();
            try {
                clearSystemPrintSnapshot();
                printSheetContext = structuredClone({ store: $storeDB, design });
                printSheetProducts = jobs.flatMap(item =>
                    Array.from({ length: item.quantity }, () => item.product)
                );
                await tick();
                await Promise.resolve(window.print());
                // Browser/system printing reports no printed/cancelled result.
                // Keep the complete job until the operator explicitly clears it.
                toast('Print dialog requested. Selected labels were kept; use Clear after printing.', 'info');
            } catch (error) {
                printSheetProducts = [];
                printSheetContext = null;
                toast(`Could not open the label print dialog: ${error}`, 'error');
            } finally {
                // Native invocation does not report sheet dismissal. Retain
                // this bounded immutable print sheet until Clear/next print.
                if (!retainNativeSnapshot) { printSheetProducts = []; printSheetContext = null; }
                printingLabels = false;
            }
            return;
        }
        printingLabels = true;
        const cancellation = { cancelled: false };
        printCancellation = cancellation;
        let printedCount = 0;
        try {
            for (const item of jobs) {
                let itemPrinted = 0;
                try {
                    await printProductLabels({
                        product: item.product,
                        store: $storeDB,
                        design,
                        quantity: item.quantity,
                    }, labelPrinter, {
                        signal: cancellation,
                        onCopiesSent: (copies) => {
                            itemPrinted += copies;
                            printedCount += copies;
                        },
                    });
                } finally {
                    const remaining = Math.max(0, item.quantity - itemPrinted);
                    if (remaining === 0) deselectPrintedProduct(item.product.id);
                    else if (itemPrinted > 0) setQuantity(item.product.id, remaining);
                }
            }
            toast(`${requestedTotal} label${requestedTotal === 1 ? '' : 's'} sent to printer`, 'success');
        } catch (error) {
            const prefix = printedCount > 0 ? `${printedCount} printed. Remaining labels were kept selected. ` : '';
            toast(`${prefix}Labels did not finish printing: ${error}`, 'error');
        } finally {
            printingLabels = false;
            printCancellation = null;
            void tick().then(() => searchInput?.focus({ preventScroll: true }));
        }
    }

    function changeProductPage(direction: number) {
        if (productsLoading || printingLabels) return;
        searchSelectionToken += 1;
        productPage = Math.max(0, productPage + direction);
        void loadProductMatches(search);
    }
</script>

<svelte:head>
    <style>{`@media print { @page { size: ${printPageWidth}mm ${printPageHeight}mm; margin: 0; } }`}</style>
</svelte:head>

<MgmtPage title="Quick Label Print">
    <div slot="actions" class="flex flex-wrap gap-3">
        <button class="btn btn-danger" disabled={selected.size === 0 || printingLabels} on:click={clearSelected}>Clear</button>
        {#if printingLabels && !systemPrintMode}
            <button class="btn btn-danger" on:click={stopPrintingLabels}>Stop Printing</button>
        {/if}
        <button class="btn btn-primary" disabled={totalLabels === 0 || printingLabels || !printerReady} on:click={requestPrintLabels}>{printingLabels ? 'Printing...' : `Print ${totalLabels} Label${totalLabels === 1 ? '' : 's'}`}</button>
    </div>
    <div class="flex h-full min-h-0 flex-col">
        <div class="flex min-h-[58px] shrink-0 flex-wrap items-center justify-between gap-4 border-b border-border-flat px-4 py-2.5">
            <div class="flex min-w-0 items-center gap-3">
                <span class="h-2.5 w-2.5 shrink-0 rounded-full {printerReady ? 'bg-success' : 'bg-danger'}"></span>
                <div class="min-w-0">
                    <strong class="block truncate">{labelPrinter.enabled ? printerModeLabel : 'Label printer disabled'}</strong>
                    <small class="block truncate text-text-muted">{printerTargetLabel}</small>
                </div>
            </div>
            <div class="flex min-w-0 max-w-full flex-wrap items-center gap-3">
                <span class="text-xs font-bold text-text-muted">{design.widthMm} x {design.heightMm} mm</span>
                <a class="btn btn-secondary !min-h-10 !px-3" href="/settings/labels">Label Design</a>
                <a class="btn btn-secondary !min-h-10 !px-3" href="/settings/printers">Printer Setup</a>
            </div>
        </div>
        <div class="grid min-h-0 flex-1 grid-cols-[minmax(300px,0.9fr)_minmax(380px,1.1fr)] gap-4 p-4 max-[850px]:grid-cols-1 max-[850px]:overflow-y-auto">
        <section class="settings-section flex min-h-0 flex-col max-[850px]:min-h-[420px]">
            <div class="flex flex-col gap-1">
                <p class="text-xs uppercase tracking-[0.22em] text-accent-primary font-bold">Item lookup</p>
                <h3 class="settings-section-title !mb-0">Scan or Find Items</h3>
                <p class="text-sm text-text-muted">Search by name, SKU, barcode, or PLU. Press Enter to add the first match.</p>
            </div>
            <div class="mt-4 search-controls search-controls-fill">
                <div class="search-primary">
                    <SearchField
                        id="label-print-search"
                        bind:value={search}
                        bind:inputElement={searchInput}
                        placeholder="Scan or type, then press Enter..."
                        ariaLabel="Scan or find an item to print"
                        clearLabel="Clear item search"
                        showKeyboard={false}
                        touchKeyboard="off"
                        disabled={printingLabels}
                        onInput={handleSearchInput}
                        onKeydown={handleSearchKeydown}
                        onClear={clearProductSearch}
                    />
                </div>
            </div>
            <div class="mt-3 min-h-0 flex-1 overflow-y-auto rounded-lg border border-border-flat">
                {#if productsLoading}
                    <p class="p-6 text-center text-text-muted">Loading items...</p>
                {:else if productLoadError}
                    <p class="p-6 text-center text-danger">{productLoadError}</p>
                {:else}
                {#each matches as product}
                    <button
                        class="flex min-h-[58px] w-full items-center justify-between gap-4 border-b border-border-flat bg-bg-panel px-3 py-2 text-left transition hover:bg-bg-card-hover"
                        disabled={printingLabels}
                        on:click={() => selectProduct(product)}
                    >
                        <span class="min-w-0">
                            <strong class="block truncate">{product.name}</strong>
                            <small class="block text-text-muted">{product.sku || product.barcode || product.scalePlu || ''}</small>
                            {#if design.showBarcode && !product.barcode}<small class="block font-bold text-warning">No barcode - text and price only</small>{/if}
                        </span>
                        <b class="shrink-0">{formatMoney(product.price)}</b>
                    </button>
                {/each}
                {#if matches.length === 0}<p class="p-6 text-center text-text-muted">No matching items.</p>{/if}
                {/if}
            </div>
            <div class="label-search-pagination">
                <small>Showing {matches.length ? productPage * PRODUCT_PAGE_SIZE + 1 : 0}–{matches.length ? productPage * PRODUCT_PAGE_SIZE + matches.length : 0} of {productTotal}{productTotalCapped ? '+' : ''} matches. Search or use Next for more.</small>
                <div><button class="btn btn-secondary" disabled={productsLoading || printingLabels || productPage === 0} on:click={() => changeProductPage(-1)}>Previous</button><button class="btn btn-secondary" disabled={productsLoading || printingLabels || !productsHaveMore} on:click={() => changeProductPage(1)}>Next</button></div>
            </div>
        </section>

        <section class="settings-section flex min-h-0 flex-col max-[850px]:min-h-[420px]">
            <div class="flex items-center justify-between gap-4">
                <h3 class="settings-section-title !mb-0">Selected Labels</h3>
                <strong>{selectedProducts.length} item{selectedProducts.length === 1 ? '' : 's'} · {totalLabels} label{totalLabels === 1 ? '' : 's'}</strong>
            </div>
            <div class="mt-3 min-h-0 flex-1 overflow-y-auto rounded-lg border border-border-flat">
                {#each selectedProducts as item}
                    <article class="grid min-h-[68px] grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-border-flat bg-bg-panel p-3">
                        <div class="min-w-0">
                            <strong class="block truncate">{item.product.name}</strong>
                            <small class="block text-text-muted">{formatMoney(item.product.price)}</small>
                            {#if design.showBarcode && !item.product.barcode}<small class="block font-bold text-warning">No barcode</small>{/if}
                        </div>
                        <div class="grid grid-cols-[44px_68px_44px] gap-1">
                            <button class="h-11 rounded-md border border-border-flat bg-bg-card text-lg font-black transition hover:bg-bg-card-hover" aria-label={`Decrease ${item.product.name} label quantity`} disabled={printingLabels} on:click={() => setQuantity(item.product.id, item.quantity - 1)}>-</button>
                            <input class="h-11 w-[68px] rounded-md border border-border-flat bg-bg-card text-center font-bold" aria-label={`${item.product.name} label quantity`} disabled={printingLabels} type="number" min="1" max="500" value={item.quantity} on:change={(event) => setQuantity(item.product.id, Number(event.currentTarget.value))} />
                            <button class="h-11 rounded-md border border-border-flat bg-bg-card text-lg font-black transition hover:bg-bg-card-hover" aria-label={`Increase ${item.product.name} label quantity`} disabled={printingLabels} on:click={() => setQuantity(item.product.id, item.quantity + 1)}>+</button>
                        </div>
                        <button class="h-11 rounded-md border border-border-flat bg-bg-card px-3 font-bold text-danger transition hover:border-danger hover:bg-danger/10" disabled={printingLabels} on:click={() => setQuantity(item.product.id, 0)}>Remove</button>
                    </article>
                {/each}
                {#if selectedProducts.length === 0}
                    <div class="grid h-full place-content-center p-6 text-center">
                        <h3>No labels selected</h3>
                        <p class="text-text-muted">Scan an item or choose it from the list.</p>
                    </div>
                {/if}
            </div>
            <p class="mt-3 text-xs text-text-muted capitalize">Uses the saved label design: {design.widthMm} x {design.heightMm} mm - {design.template}</p>
        </section>
        </div>
    </div>
</MgmtPage>

<ConfirmDialog
    bind:show={showLargePrintConfirm}
    title={`Print ${totalLabels} labels?`}
    message="This is a large label job. Confirm the quantity and loaded label roll before continuing."
    confirmText={`Print ${totalLabels} Labels`}
    on:confirm={() => {
        showLargePrintConfirm = false;
        void printLabels();
    }}
/>

<div class="quick-label-print-sheet">
    {#if printSheetContext}{#each printSheetProducts as product}<ProductLabel {product} store={printSheetContext.store} design={printSheetContext.design} />{/each}{/if}
</div>

<style>
    .label-search-pagination { flex:0 0 auto; display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:.5rem; padding-top:.5rem; }
    .label-search-pagination small { color:var(--text-muted); font-size:.75rem; }
    .label-search-pagination > div { display:flex; gap:.4rem; }
    .quick-label-print-sheet { display: none; }
    @media print {
        :global(.management-page), :global(.fullscreen-toggle), :global(.toast-pop), :global(.touch-input-backdrop) { display: none !important; }
        .quick-label-print-sheet { display: block !important; }
        @page { margin: 0; }
    }
</style>
