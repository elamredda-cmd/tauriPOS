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
    <div class="quick-label-layout">
        <section class="settings-section quick-picker">
            <h3 class="settings-section-title">Scan or Find Items</h3>
            <div class="field">
                <label>Scan barcode or search name, SKU, barcode, or PLU</label>
                <input bind:this={searchInput} bind:value={search} data-touch-keyboard="off" on:keydown={handleSearchKeydown} placeholder="Scan or type, then press Enter..." />
            </div>
            <div class="quick-results">
                {#each matches as product}
                    <button on:click={() => selectProduct(product)}>
                        <span><strong>{product.name}</strong><small>{product.sku || product.barcode || product.scalePlu || ''}</small></span>
                        <b>{formatMoney(product.price)}</b>
                    </button>
                {/each}
                {#if matches.length === 0}<p>No matching items.</p>{/if}
            </div>
        </section>

        <section class="settings-section selected-labels">
            <div class="selected-heading"><h3 class="settings-section-title !mb-0">Selected Labels</h3><strong>{totalLabels} total</strong></div>
            <div class="selected-list">
                {#each selectedProducts as item}
                    <article>
                        <div><strong>{item.product.name}</strong><small>{formatMoney(item.product.price)}</small></div>
                        <div class="quantity-control">
                            <button on:click={() => setQuantity(item.product.id, item.quantity - 1)}>−</button>
                            <input type="number" min="1" max="500" value={item.quantity} on:change={(event) => setQuantity(item.product.id, Number(event.currentTarget.value))} />
                            <button on:click={() => setQuantity(item.product.id, item.quantity + 1)}>+</button>
                        </div>
                        <button class="remove" on:click={() => setQuantity(item.product.id, 0)}>Remove</button>
                    </article>
                {/each}
                {#if selectedProducts.length === 0}<div class="empty-selection"><h3>No labels selected</h3><p>Scan an item or choose it from the list.</p></div>{/if}
            </div>
            <p class="design-note">Uses the saved label design: {design.widthMm} × {design.heightMm} mm · {design.template}</p>
        </section>
    </div>
</MgmtPage>

<div class="quick-label-print-sheet">
    {#each printProducts as product}<ProductLabel {product} store={$storeDB} {design} />{/each}
</div>

<style>
    .quick-label-layout { height: 100%; min-height: 0; padding: 1rem; display: grid; grid-template-columns: minmax(300px, .9fr) minmax(380px, 1.1fr); gap: 1rem; }
    .quick-picker, .selected-labels { min-height: 0; display: flex; flex-direction: column; }
    .quick-results, .selected-list { min-height: 0; flex: 1; margin-top: .75rem; overflow-y: auto; border: 1px solid var(--border-flat); border-radius: .5rem; }
    .quick-results button { width: 100%; min-height: 58px; padding: .65rem .8rem; display: flex; align-items: center; justify-content: space-between; gap: 1rem; text-align: left; border-bottom: 1px solid var(--border-flat); background: var(--bg-panel); }
    .quick-results button:hover { background: var(--bg-card-hover); }
    .quick-results span, .quick-results small, .selected-list article div:first-child small { display: block; min-width: 0; }
    .quick-results strong { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .quick-results small, .selected-list small, .design-note, .empty-selection p { color: var(--text-muted); }
    .selected-heading { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
    .selected-list article { min-height: 68px; padding: .6rem; display: grid; grid-template-columns: minmax(0,1fr) auto auto; align-items: center; gap: .7rem; border-bottom: 1px solid var(--border-flat); background: var(--bg-panel); }
    .selected-list article div:first-child { min-width: 0; }
    .selected-list article div:first-child strong { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .quantity-control { display: grid; grid-template-columns: 44px 68px 44px; gap: .25rem; }
    .quantity-control button, .quantity-control input, .remove { height: 44px; border: 1px solid var(--border-flat); border-radius: .35rem; text-align: center; background: var(--bg-card); }
    .quantity-control input { width: 68px; }
    .remove { padding: 0 .7rem; color: var(--danger); }
    .empty-selection { height: 100%; display: grid; place-content: center; text-align: center; }
    .design-note { margin: .75rem 0 0; font-size: .78rem; text-transform: capitalize; }
    .quick-label-print-sheet { display: none; }
    @media (max-width: 850px) { .quick-label-layout { grid-template-columns: 1fr; overflow-y: auto; } .quick-picker, .selected-labels { min-height: 420px; } }
    @media print {
        :global(.management-page), :global(.fullscreen-toggle), :global(.toast-pop), :global(.touch-input-backdrop) { display: none !important; }
        .quick-label-print-sheet { display: block !important; }
        @page { margin: 0; }
    }
</style>
