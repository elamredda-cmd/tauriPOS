<script lang="ts">
    import { onDestroy, onMount, tick } from 'svelte';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import ProductLabel from '$lib/components/ProductLabel.svelte';
    import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
    import { settingsDB, storeDB, formatMoney, type Product } from '$lib/stores/db';
    import { getProductsPage } from '$lib/stores/database';
    import { getLabelDesign } from '$lib/labels';
    import { toast } from '$lib/stores/toast';
    import { getLabelPrinterConfig, printProductLabels } from '$lib/printers';

    let search = '';
    let searchInput: HTMLInputElement;
    let selected = new Map<string, { product: Product; quantity: number }>();
    let matches: Product[] = [];
    let productsLoading = true;
    let productLoadError = '';
    let productSearchTimer: ReturnType<typeof setTimeout> | null = null;
    let productLoadToken = 0;
    let mounted = false;
    let printingLabels = false;
    let printSheetProducts: Product[] = [];
    let showLargePrintConfirm = false;
    const LARGE_PRINT_THRESHOLD = 50;
    $: design = getLabelDesign($settingsDB);
    $: labelPrinter = getLabelPrinterConfig($settingsDB);
    $: selectedProducts = Array.from(selected.values());
    $: systemPrintMode = labelPrinter.connection === 'system' || labelPrinter.protocol === 'system';
    $: totalLabels = selectedProducts.reduce((sum, item) => sum + item.quantity, 0);
    $: printPageWidth = Math.max(15, Math.min(210, Number(design.widthMm) || 50));
    $: printPageHeight = Math.max(15, Math.min(297, Number(design.heightMm) || 30));
    $: printerModeLabel = systemPrintMode
        ? 'System print dialog'
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
                : labelPrinter.devicePath || 'No printer port selected';
    $: printerReady = labelPrinter.enabled && (
        systemPrintMode
        || (labelPrinter.connection === 'network_escpos' && Boolean(labelPrinter.host.trim()))
        || (labelPrinter.connection === 'usb_raw' && Boolean(labelPrinter.printerName.trim()))
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
        if (productSearchTimer) clearTimeout(productSearchTimer);
    });

    function scheduleProductSearch(query: string, delay = 160) {
        if (productSearchTimer) clearTimeout(productSearchTimer);
        productSearchTimer = setTimeout(() => void loadProductMatches(query), delay);
    }

    async function loadProductMatches(query: string): Promise<Product[]> {
        const token = ++productLoadToken;
        productsLoading = true;
        productLoadError = '';
        try {
            const result = await getProductsPage({
                query: query.trim(),
                status: 'active',
                limit: 100,
                offset: 0,
            });
            const rows = result.rows as Product[];
            if (mounted && token === productLoadToken) matches = rows;
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
        search = (event.currentTarget as HTMLInputElement).value;
        scheduleProductSearch(search);
    }

    function selectProduct(product: Product) {
        const next = new Map(selected);
        const current = next.get(product.id);
        next.set(product.id, { product, quantity: Math.min(500, (current?.quantity || 0) + 1) });
        selected = next;
        search = '';
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
        void tick().then(() => searchInput?.focus({ preventScroll: true }));
    }

    function deselectPrintedProduct(productId: string) {
        const next = new Map(selected);
        next.delete(productId);
        selected = next;
    }

    async function handleSearchKeydown(event: KeyboardEvent) {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        if (productSearchTimer) clearTimeout(productSearchTimer);
        const query = search.trim().toLowerCase();
        const currentMatches = await loadProductMatches(query);
        const exact = currentMatches.find(product => product.isActive && [
            product.barcode, product.sku, product.scalePlu
        ].some(value => String(value || '').toLowerCase() === query));
        const chosen = exact || currentMatches[0];
        if (chosen) selectProduct(chosen);
        else toast('No matching item found', 'error');
    }

    function requestPrintLabels() {
        if (totalLabels > LARGE_PRINT_THRESHOLD) {
            showLargePrintConfirm = true;
            return;
        }
        void printLabels();
    }

    async function printLabels() {
        if (totalLabels === 0) { toast('Select at least one item', 'error'); return; }
        if (printingLabels) return;
        if (!labelPrinter.enabled) { toast('Label printing is disabled in Printer Setup', 'error'); return; }
        if (!printerReady) { toast('Finish the label printer setup before printing', 'error'); return; }

        const jobs = selectedProducts.map((item) => ({ ...item }));
        const requestedTotal = totalLabels;
        if (systemPrintMode) {
            printingLabels = true;
            printSheetProducts = jobs.flatMap(item =>
                Array.from({ length: item.quantity }, () => item.product)
            );
            try {
                await tick();
                window.print();
                clearSelected();
                toast('Label print dialog closed and selection cleared', 'success');
            } catch (error) {
                toast(`Could not open the label print dialog: ${error}`, 'error');
            } finally {
                printSheetProducts = [];
                printingLabels = false;
            }
            return;
        }
        printingLabels = true;
        let printedCount = 0;
        try {
            for (const item of jobs) {
                await printProductLabels({
                    product: item.product,
                    store: $storeDB,
                    design,
                    quantity: item.quantity,
                }, labelPrinter);
                printedCount += item.quantity;
                deselectPrintedProduct(item.product.id);
            }
            toast(`${requestedTotal} label${requestedTotal === 1 ? '' : 's'} sent to printer`, 'success');
        } catch (error) {
            const prefix = printedCount > 0 ? `${printedCount} printed. Remaining labels were kept selected. ` : '';
            toast(`${prefix}Labels did not finish printing: ${error}`, 'error');
        } finally {
            printingLabels = false;
            void tick().then(() => searchInput?.focus({ preventScroll: true }));
        }
    }
</script>

<svelte:head>
    <style>{`@media print { @page { size: ${printPageWidth}mm ${printPageHeight}mm; margin: 0; } }`}</style>
</svelte:head>

<MgmtPage title="Quick Label Print">
    <div slot="actions" class="flex gap-3">
        <button class="btn btn-danger" disabled={selected.size === 0 || printingLabels} on:click={clearSelected}>Clear</button>
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
            <div class="flex shrink-0 items-center gap-3">
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
            <div class="relative mt-4">
                <svg class="absolute left-4 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                <input
                    class="search-input !min-h-[56px] !pl-12 !pr-4"
                    bind:this={searchInput}
                    value={search}
                    data-touch-keyboard="off"
                    disabled={printingLabels}
                    on:input={handleSearchInput}
                    on:keydown={handleSearchKeydown}
                    placeholder="Scan or type, then press Enter..."
                />
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
    {#each printSheetProducts as product}<ProductLabel {product} store={$storeDB} {design} />{/each}
</div>

<style>
    .quick-label-print-sheet { display: none; }
    @media print {
        :global(.management-page), :global(.fullscreen-toggle), :global(.toast-pop), :global(.touch-input-backdrop) { display: none !important; }
        .quick-label-print-sheet { display: block !important; }
        @page { margin: 0; }
    }
</style>
