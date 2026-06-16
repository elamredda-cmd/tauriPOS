<script lang="ts">
    import { onMount, tick } from 'svelte';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import ProductLabel from '$lib/components/ProductLabel.svelte';
    import { productsDB, settingsDB, storeDB, formatMoney, type Product } from '$lib/stores/db';
    import { getLabelDesign } from '$lib/labels';
    import { toast } from '$lib/stores/toast';

    let search = '';
    let searchInput: HTMLInputElement;
    let selected = new Map<string, number>();
    $: design = getLabelDesign($settingsDB);
    $: matches = search.trim()
        ? $productsDB.filter(product => product.isActive && (
            product.name.toLowerCase().includes(search.toLowerCase()) ||
            (product.sku || '').toLowerCase().includes(search.toLowerCase()) ||
            (product.barcode || '').toLowerCase().includes(search.toLowerCase()) ||
            (product.scalePlu || '').toLowerCase().includes(search.toLowerCase())
        )).slice(0, 100)
        : $productsDB.filter(product => product.isActive).slice(0, 100);
    $: selectedProducts = Array.from(selected.entries()).flatMap(([id, quantity]) => {
        const product = $productsDB.find(item => item.id === id);
        return product ? [{ product, quantity }] : [];
    });
    $: printProducts = selectedProducts.flatMap(item =>
        Array.from({ length: item.quantity }, () => item.product)
    );
    $: totalLabels = selectedProducts.reduce((sum, item) => sum + item.quantity, 0);

    onMount(() => tick().then(() => searchInput?.focus({ preventScroll: true })));

    function selectProduct(product: Product) {
        const next = new Map(selected);
        next.set(product.id, (next.get(product.id) || 0) + 1);
        selected = next;
        search = '';
        tick().then(() => searchInput?.focus({ preventScroll: true }));
    }

    function setQuantity(id: string, quantity: number) {
        const next = new Map(selected);
        if (quantity <= 0) next.delete(id);
        else next.set(id, Math.min(500, quantity));
        selected = next;
    }

    function handleSearchKeydown(event: KeyboardEvent) {
        if (event.key !== 'Enter') return;
        const query = search.trim().toLowerCase();
        const exact = $productsDB.find(product => product.isActive && [
            product.barcode, product.sku, product.scalePlu
        ].some(value => String(value || '').toLowerCase() === query));
        const chosen = exact || matches[0];
        if (chosen) selectProduct(chosen);
        else toast('No matching item found', 'error');
    }

    function printLabels() {
        if (totalLabels === 0) { toast('Select at least one item', 'error'); return; }
        window.print();
    }
</script>

<MgmtPage title="Quick Label Print">
    <div slot="actions" class="flex gap-3">
        <button class="btn btn-danger" disabled={selected.size === 0} on:click={() => selected = new Map()}>Clear</button>
        <button class="btn btn-primary" disabled={totalLabels === 0} on:click={printLabels}>Print {totalLabels} Label{totalLabels === 1 ? '' : 's'}</button>
    </div>
    <div class="grid h-full min-h-0 grid-cols-[minmax(300px,0.9fr)_minmax(380px,1.1fr)] gap-4 p-4 max-[850px]:grid-cols-1 max-[850px]:overflow-y-auto">
        <section class="settings-section flex min-h-0 flex-col max-[850px]:min-h-[420px]">
            <div class="flex flex-col gap-1">
                <p class="text-xs uppercase tracking-[0.22em] text-accent-primary font-bold">Item lookup</p>
                <h3 class="settings-section-title !mb-0">Scan or Find Items</h3>
                <p class="text-sm text-text-muted">Search by name, SKU, barcode, or PLU. Press Enter to add the first match.</p>
            </div>
            <div class="relative mt-4">
                <svg class="absolute left-4 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                <input
                    class="w-full min-h-[56px] rounded-lg border border-border-flat bg-bg-base pl-12 pr-4 text-base font-semibold text-text-main outline-none transition focus:border-accent-primary focus:ring-2 focus:ring-accent-primary/25"
                    bind:this={searchInput}
                    bind:value={search}
                    data-touch-keyboard="off"
                    on:keydown={handleSearchKeydown}
                    placeholder="Scan or type, then press Enter..."
                />
            </div>
            <div class="mt-3 min-h-0 flex-1 overflow-y-auto rounded-lg border border-border-flat">
                {#each matches as product}
                    <button
                        class="flex min-h-[58px] w-full items-center justify-between gap-4 border-b border-border-flat bg-bg-panel px-3 py-2 text-left transition hover:bg-bg-card-hover"
                        on:click={() => selectProduct(product)}
                    >
                        <span class="min-w-0">
                            <strong class="block truncate">{product.name}</strong>
                            <small class="block text-text-muted">{product.sku || product.barcode || product.scalePlu || ''}</small>
                        </span>
                        <b class="shrink-0">{formatMoney(product.price)}</b>
                    </button>
                {/each}
                {#if matches.length === 0}<p class="p-6 text-center text-text-muted">No matching items.</p>{/if}
            </div>
        </section>

        <section class="settings-section flex min-h-0 flex-col max-[850px]:min-h-[420px]">
            <div class="flex items-center justify-between gap-4">
                <h3 class="settings-section-title !mb-0">Selected Labels</h3>
                <strong>{totalLabels} total</strong>
            </div>
            <div class="mt-3 min-h-0 flex-1 overflow-y-auto rounded-lg border border-border-flat">
                {#each selectedProducts as item}
                    <article class="grid min-h-[68px] grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-border-flat bg-bg-panel p-3">
                        <div class="min-w-0">
                            <strong class="block truncate">{item.product.name}</strong>
                            <small class="block text-text-muted">{formatMoney(item.product.price)}</small>
                        </div>
                        <div class="grid grid-cols-[44px_68px_44px] gap-1">
                            <button class="h-11 rounded-md border border-border-flat bg-bg-card text-lg font-black transition hover:bg-bg-card-hover" on:click={() => setQuantity(item.product.id, item.quantity - 1)}>−</button>
                            <input class="h-11 w-[68px] rounded-md border border-border-flat bg-bg-card text-center font-bold" type="number" min="1" max="500" value={item.quantity} on:change={(event) => setQuantity(item.product.id, Number(event.currentTarget.value))} />
                            <button class="h-11 rounded-md border border-border-flat bg-bg-card text-lg font-black transition hover:bg-bg-card-hover" on:click={() => setQuantity(item.product.id, item.quantity + 1)}>+</button>
                        </div>
                        <button class="h-11 rounded-md border border-border-flat bg-bg-card px-3 font-bold text-danger transition hover:border-danger hover:bg-danger/10" on:click={() => setQuantity(item.product.id, 0)}>Remove</button>
                    </article>
                {/each}
                {#if selectedProducts.length === 0}
                    <div class="grid h-full place-content-center p-6 text-center">
                        <h3>No labels selected</h3>
                        <p class="text-text-muted">Scan an item or choose it from the list.</p>
                    </div>
                {/if}
            </div>
            <p class="mt-3 text-xs text-text-muted capitalize">Uses the saved label design: {design.widthMm} × {design.heightMm} mm · {design.template}</p>
        </section>
    </div>
</MgmtPage>

<div class="quick-label-print-sheet">
    {#each printProducts as product}<ProductLabel {product} store={$storeDB} {design} />{/each}
</div>

<style>
    .quick-label-print-sheet { display: none; }
    @media print {
        :global(.management-page), :global(.fullscreen-toggle), :global(.toast-pop), :global(.touch-input-backdrop) { display: none !important; }
        .quick-label-print-sheet { display: block !important; }
        @page { margin: 0; }
    }
</style>
