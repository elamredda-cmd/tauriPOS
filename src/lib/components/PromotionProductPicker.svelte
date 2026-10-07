<script lang="ts">
    import { createEventDispatcher, onDestroy, tick } from 'svelte';
    import { Check, ChevronLeft, ChevronRight, Search } from '@lucide/svelte';
    import Modal from './Modal.svelte';
    import SearchField from './SearchField.svelte';
    import { getProductsPage } from '$lib/stores/database';
    import { formatMoney, type Product } from '$lib/stores/db';

    export let show = false;
    export let disabled = false;
    export let single = false;
    export let selectedIds: string[] = [];
    export let productsById: ReadonlyMap<string, Product> = new Map();
    const dispatch = createEventDispatcher<{ toggle: string; loaded: Product[] }>();
    const PAGE_SIZE = 8;
    let wasOpen = false, selectedView = false, loading = false, capped = false;
    let query = '', loadedQuery = '', error = '';
    let rows: Product[] = [];
    let offset = 0, total = 0, token = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let input: HTMLInputElement | null = null, list: HTMLDivElement | null = null;
    $: nextPage = capped ? rows.length === PAGE_SIZE : offset + rows.length < total;
    $: selected = new Set(selectedIds);
    $: if (show !== wasOpen) {
        wasOpen = show;
        reset(); selectedView = false;
        if (show) void focusSearch();
    }
    function invalidate() { if (timer) clearTimeout(timer); timer = null; token++; }
    function reset() { invalidate(); query = ''; loadedQuery = ''; rows = []; offset = 0; total = 0; error = ''; loading = false; }
    async function focusSearch() {
        await tick();
        if (!show || disabled || selectedView || !input) return;
        input.dataset.modalInitialFocus = 'true'; input.focus({ preventScroll: true });
    }
    async function search() {
        invalidate();
        const request = token, text = query.trim();
        rows = []; error = ''; loadedQuery = '';
        if (!text || !show || disabled || selectedView) { loading = false; return; }
        loading = true;
        try {
            const result = await getProductsPage({ query: text, status: 'active', limit: PAGE_SIZE, offset, compact: true });
            if (request !== token || !show || disabled || selectedView) return;
            rows = result.rows as Product[]; total = result.total; capped = Boolean(result.totalIsCapped); loadedQuery = text;
            dispatch('loaded', rows);
        } catch (cause) { if (request === token) error = `Could not search products. ${String(cause)}`; }
        finally { if (request === token) loading = false; }
    }
    function schedule() {
        invalidate(); rows = []; loadedQuery = ''; error = ''; offset = 0; total = 0;
        loading = Boolean(show && !disabled && query.trim());
        if (loading) timer = setTimeout(() => { void search(); }, 180);
    }
    function changePage(direction: number) {
        if (disabled || loading || (direction > 0 && !nextPage)) return;
        offset = Math.max(0, offset + direction * PAGE_SIZE); void search();
    }
    function toggle(id: string) {
        if (disabled || !show || (!selectedView && (loading || loadedQuery !== query.trim()))) return;
        // Choosing the same single product confirms it; removal is explicit in
        // the Selected list. Multi-product offers still toggle each result.
        if (!(single && !selectedView && selected.has(id))) dispatch('toggle', id);
        if (single) show = false;
    }
    function setView(value: boolean) { invalidate(); loading = false; selectedView = value; if (!value) { reset(); void focusSearch(); } }
    function keydown(event: KeyboardEvent) {
        if (disabled || event.isComposing) return;
        if (event.key === 'ArrowDown' && !loading) { event.preventDefault(); list?.querySelector<HTMLButtonElement>('.promotion-picker-row')?.focus(); }
        if (event.key === 'Enter') { event.preventDefault(); if (!loading && !error && rows.length === 1 && loadedQuery === query.trim()) toggle(rows[0].id); else { offset = 0; void search(); } }
    }
    onDestroy(invalidate);
</script>

<Modal bind:show title={single ? 'Choose a product' : 'Choose promotion products'} width="680px" height="min(650px, calc(100dvh - 24px))" dismissDisabled={disabled}>
    <div class="promotion-picker">
        <div class="promotion-picker-tabs"><button disabled={disabled} aria-pressed={!selectedView} class:active={!selectedView} on:click={() => setView(false)}>Find products</button><button disabled={disabled} aria-pressed={selectedView} class:active={selectedView} on:click={() => setView(true)}>Selected ({selectedIds.length})</button></div>
        {#if !selectedView}<SearchField id="promotion-product-search" bind:value={query} bind:inputElement={input} ariaLabel="Search promotion products" placeholder="Search name, SKU, barcode or PLU" clearLabel="Clear product search" {disabled} onInput={schedule} onClear={reset} onKeydown={keydown} />{/if}
        <div class="promotion-picker-list" bind:this={list} aria-busy={loading}>
            {#if selectedView}
                {#each selectedIds as id (id)}
                    {@const product = productsById.get(id)}
                    <button class="promotion-picker-row" {disabled} aria-pressed="true" aria-label={`Remove ${product?.name || 'unavailable product'}`} on:click={() => toggle(id)}><span class="selection-mark selected"><Check size={18} /></span><span class="product-copy"><strong>{product?.name || `Unavailable product (${id})`}</strong><small>{product?.isActive === false ? 'Inactive product — remove before saving' : 'Selected for this promotion'}</small></span><span class="product-action">Remove</span></button>
                {:else}<p class="picker-empty">No products selected. Choose Find products to search.</p>{/each}
            {:else if !query.trim()}<div class="picker-empty"><Search size={28} /><h3>Search for the products you need</h3><p>No catalogue suggestions are loaded automatically.</p></div>
            {:else if loading}<p class="picker-empty" role="status">Searching products…</p>
            {:else if error}<div class="picker-empty"><p role="alert">{error}</p><button class="btn btn-secondary" {disabled} on:click={search}>Retry search</button></div>
            {:else}{#each rows as product (product.id)}
                <button class="promotion-picker-row" {disabled} aria-pressed={selected.has(product.id)} aria-label={`${selected.has(product.id) ? single ? 'Keep' : 'Remove' : 'Select'} ${product.name}`} on:click={() => toggle(product.id)}><span class="selection-mark" class:selected={selected.has(product.id)}>{#if selected.has(product.id)}<Check size={18} />{/if}</span><span class="product-copy"><strong>{product.name}</strong><small>{product.sku || product.barcode || product.scalePlu || 'No product code'}</small></span><span class="product-price">{formatMoney(product.price)}</span></button>
            {:else}<p class="picker-empty">No matching products. Try another name or barcode.</p>{/each}{/if}
        </div>
        {#if !selectedView && query.trim()}<div class="picker-pagination"><span role="status">{loading ? 'Searching…' : error ? 'Search unavailable' : rows.length ? `${offset + 1}–${offset + rows.length} of ${Math.max(total, offset + rows.length)}${capped ? '+' : ''}` : 'No matches'}</span><button aria-label="Previous products" disabled={disabled || loading || offset === 0} on:click={() => changePage(-1)}><ChevronLeft size={18} /></button><button aria-label="Next products" disabled={disabled || loading || !!error || !nextPage} on:click={() => changePage(1)}><ChevronRight size={18} /></button></div>{/if}
    </div>
    <svelte:fragment slot="footer"><button class="btn btn-primary" {disabled} on:click={() => show = false}>Done</button></svelte:fragment>
</Modal>

<style>
    .promotion-picker { display:flex; flex-direction:column; height:100%; min-height:0; min-width:0; gap:12px; }
    .promotion-picker-tabs { display:flex; gap:6px; flex:none; }
    .promotion-picker-tabs button { min-height:38px; padding:7px 12px; border:1px solid var(--border-flat); border-radius:6px; background:var(--bg-panel); color:var(--text-muted); font-weight:700; font-size:.85rem; }
    .promotion-picker-tabs button.active { color:var(--accent-primary); border-color:var(--accent-primary); }
    .promotion-picker-list { flex:1; min-height:0; overflow-y:auto; border:1px solid var(--border-flat); border-radius:8px; overscroll-behavior:contain; }
    .promotion-picker-row { display:flex; align-items:center; gap:12px; width:100%; min-height:62px; padding:11px 12px; border:0; border-bottom:1px solid var(--border-flat); background:var(--bg-panel); color:var(--text-main); text-align:left; }
    .promotion-picker-row:last-child { border-bottom:0; }
    .promotion-picker-row:hover { background:var(--bg-card-hover); }
    .selection-mark { width:24px; height:24px; flex:none; display:grid; place-items:center; border:1px solid var(--border-flat); border-radius:5px; }
    .selection-mark.selected { background:var(--accent-primary); border-color:var(--accent-primary); color:white; }
    .product-copy { flex:1; min-width:0; display:grid; gap:4px; overflow-wrap:anywhere; }
    .product-copy strong { font-size:.88rem; line-height:1.3; }
    .product-copy small { color:var(--text-muted); font-size:.72rem; }
    .product-price, .product-action { flex:none; max-width:27%; font-size:.8rem; overflow-wrap:anywhere; font-variant-numeric:tabular-nums; }
    .product-action { color:var(--danger); }
    .picker-empty { padding:24px 16px; text-align:center; color:var(--text-muted); font-size:.85rem; overflow-wrap:anywhere; }
    .picker-empty :global(svg) { margin:0 auto 12px; }
    .picker-empty h3 { font-size:1rem; color:var(--text-main); }
    .picker-pagination { display:flex; align-items:center; gap:6px; flex:none; }
    .picker-pagination span { flex:1; font-size:.75rem; color:var(--text-muted); }
    .picker-pagination button { display:grid; place-items:center; width:36px; min-height:36px; color:var(--text-main); border:1px solid var(--border-flat); border-radius:6px; background:var(--bg-panel); }
    .promotion-picker button:focus-visible { outline:2px solid var(--accent-primary); outline-offset:-2px; }
    .promotion-picker button:disabled { opacity:.45; cursor:not-allowed; }
</style>
