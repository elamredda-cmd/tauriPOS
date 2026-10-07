<script lang="ts">
    import { createEventDispatcher, onDestroy, tick } from 'svelte';
    import { ChevronLeft, ChevronRight, Plus, Search } from '@lucide/svelte';
    import Modal from '$lib/components/Modal.svelte';
    import SearchField from '$lib/components/SearchField.svelte';
    import { formatMoney, type Product } from '$lib/stores/db';
    import { getProductsPage } from '$lib/stores/database';
    import { STOCK_RECEIVING_PRODUCT_PAGE_SIZE, stockReceivingProductPageInfo, stockReceivingSearchQuery } from '$lib/stockReceivingProductSearch';

    export let show = false;
    export let disabled = false;
    export let quantities: Record<string, string> = {};
    export let message = '';

    const dispatch = createEventDispatcher<{ add: Product }>();
    let wasOpen = false;
    let search = '', loadedQuery = '', error = '';
    let products: Product[] = [];
    let loading = false, totalIsCapped = false;
    let total = 0, offset = 0, searchToken = 0;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let searchInput: HTMLInputElement | null = null;
    let resultList: HTMLDivElement | null = null;

    $: query = stockReceivingSearchQuery(search);
    $: page = stockReceivingProductPageInfo({ offset, count: products.length, total, totalIsCapped });
    $: if (show !== wasOpen) {
        wasOpen = show;
        resetSearch();
        if (show) void focusSearch();
    }

    function cancelPendingSearch() {
        if (debounce) clearTimeout(debounce);
        debounce = null;
        searchToken++;
    }

    function clearResults() {
        products = []; loadedQuery = ''; error = ''; total = 0; totalIsCapped = false;
        loading = false;
    }

    function resetSearch() {
        cancelPendingSearch();
        search = ''; offset = 0;
        clearResults();
    }

    async function focusSearch(selectText = false) {
        await tick();
        if (!show || disabled || !searchInput) return;
        // Modal's initial-focus timer must choose the search, not its Close button.
        searchInput.dataset.modalInitialFocus = 'true';
        searchInput.focus({ preventScroll: true });
        if (selectText) searchInput.select();
    }

    async function loadProducts() {
        cancelPendingSearch();
        const token = searchToken;
        const requestedQuery = stockReceivingSearchQuery(search);
        if (!show || disabled || !requestedQuery) { clearResults(); return; }
        loading = true; error = ''; products = []; loadedQuery = '';
        try {
            const result = await getProductsPage({ query: requestedQuery, status: 'active', limit: STOCK_RECEIVING_PRODUCT_PAGE_SIZE, offset });
            if (token !== searchToken || !show || disabled) return;
            products = result.rows as Product[];
            total = result.total;
            totalIsCapped = Boolean(result.totalIsCapped);
            loadedQuery = requestedQuery;
        } catch (cause) {
            if (token !== searchToken || !show || disabled) return;
            error = `Could not search products. ${String(cause)}`;
        } finally {
            if (token === searchToken) loading = false;
        }
    }

    function scheduleSearch() {
        // Clear immediately so an old request/result can never be added for new text.
        cancelPendingSearch();
        offset = 0;
        clearResults();
        if (!show || disabled || !stockReceivingSearchQuery(search)) return;
        loading = true;
        debounce = setTimeout(() => { void loadProducts(); }, 180);
    }

    function changePage(direction: number) {
        if (disabled || loading || !show || !query || (direction > 0 && !page.hasNext)) return;
        offset = Math.max(0, offset + direction * STOCK_RECEIVING_PRODUCT_PAGE_SIZE);
        void loadProducts();
        void focusSearch();
    }

    function addProduct(product: Product) {
        if (!show || disabled || loading || loadedQuery !== stockReceivingSearchQuery(search)) return;
        if (!products.some((row) => row.id === product.id)) return;
        dispatch('add', product);
        // Keep results available for repeated additions and select text for the next scan.
        void focusSearch(true);
    }

    function resultButtons() {
        return resultList ? Array.from(resultList.querySelectorAll<HTMLButtonElement>('.picker-product:not(:disabled)')) : [];
    }

    function handleSearchKeydown(event: KeyboardEvent) {
        if (disabled || event.isComposing) return;
        if (event.key === 'ArrowDown' && !loading) {
            const first = resultButtons()[0];
            if (first) { event.preventDefault(); first.focus(); }
            return;
        }
        if (event.key !== 'Enter') return;
        event.preventDefault();
        if (!loading && !error && products.length === 1 && loadedQuery === stockReceivingSearchQuery(search)) {
            addProduct(products[0]);
        } else {
            offset = 0;
            void loadProducts();
        }
    }

    function handleResultKeydown(event: KeyboardEvent, index: number) {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        if (event.key === 'ArrowUp' && index === 0) { void focusSearch(); return; }
        const buttons = resultButtons();
        buttons[Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    }

    onDestroy(cancelPendingSearch);
</script>

<Modal bind:show title="Add products to delivery" width="680px" height="min(660px, calc(100dvh - 24px))">
    <div class="product-picker">
        <div class="picker-search">
            <SearchField id="receiving-product-picker-search" bind:value={search} bind:inputElement={searchInput} ariaLabel="Search products to add" placeholder="Search name, SKU or barcode" keyboardLabel="Open product search keyboard" clearLabel="Clear product search" {disabled} onInput={scheduleSearch} onKeydown={handleSearchKeydown} onClear={resetSearch} />
            <p>Search only for what arrived. Add products, then edit quantities in your delivery.</p>
        </div>
        {#if message}<p class="picker-message" role="alert">{message} Close this window to edit the delivery.</p>{/if}
        <div class="picker-results" bind:this={resultList} aria-busy={loading} aria-label="Product search results">
            {#if !query}
                <div class="picker-empty"><Search size={28} strokeWidth={1.6} /><h3>Find a product to add</h3><p>Type a name, SKU or barcode.<br />Products appear only when you search.</p></div>
            {:else if loading}
                <p class="picker-empty" role="status">Searching products…</p>
            {:else if error}
                <div class="picker-empty"><p role="alert">{error}</p><button class="btn btn-secondary" {disabled} on:click={loadProducts}>Retry search</button></div>
            {:else if !products.length}
                <div class="picker-empty"><h3>{offset ? 'No more matches' : 'No matching products'}</h3><p>{offset ? 'Go back to the previous page or change your search.' : 'Try a different name, SKU or barcode.'}</p></div>
            {:else}
                {#each products as product, index (product.id)}
                    <button class="picker-product" {disabled} on:click={() => addProduct(product)} on:keydown={(event) => handleResultKeydown(event, index)} aria-label={`Add ${product.name}`}>
                        <span class="picker-product-copy"><strong>{product.name}</strong><span>Stock {product.stockLevel ?? 0} · {formatMoney(product.costPrice ?? 0)} each{product.sku ? ` · ${product.sku}` : ''}</span>{#if quantities[product.id] !== undefined}<small>In delivery: {quantities[product.id] || 'quantity needed'}</small>{/if}</span>
                        <span class="picker-add" aria-hidden="true"><Plus size={18} /><span>Add</span></span>
                    </button>
                {/each}
            {/if}
        </div>
        {#if query}
            <div class="picker-pagination"><span role="status">{loading ? 'Searching…' : error ? 'Search unavailable' : page.range}</span><button class="picker-page" aria-label="Previous products" disabled={disabled || loading || offset === 0} on:click={() => changePage(-1)}><ChevronLeft size={18} /></button><button class="picker-page" aria-label="Next products" disabled={disabled || loading || !!error || !page.hasNext} on:click={() => changePage(1)}><ChevronRight size={18} /></button></div>
        {/if}
    </div>
    <svelte:fragment slot="footer"><button class="btn btn-primary picker-done" on:click={() => show = false}>Done</button></svelte:fragment>
</Modal>

<style>
    .product-picker { min-width:0; min-height:0; height:100%; display:flex; flex-direction:column; gap:12px; }
    .picker-search { flex:none; min-width:0; }
    .picker-search p { color:var(--text-muted); font-size:.78rem; line-height:1.45; margin:9px 0 0; }
    .picker-message { flex:none; max-height:90px; overflow-y:auto; overflow-wrap:anywhere; margin:0; padding:8px 10px; border:1px solid var(--border-flat); border-radius:6px; color:var(--danger); font-size:.8rem; line-height:1.4; }
    .picker-results { flex:1; min-height:0; overflow-y:auto; overscroll-behavior:contain; border:1px solid var(--border-flat); border-radius:8px; background:var(--bg-panel); }
    .picker-empty { color:var(--text-muted); text-align:center; padding:26px 16px; margin:0; font-size:.85rem; overflow-wrap:anywhere; }
    .picker-empty :global(svg) { margin:5px auto 12px; opacity:.65; }
    .picker-empty h3 { color:var(--text-main); font-size:1rem; margin:0 0 8px; }
    .picker-empty p { line-height:1.5; margin:8px 0; }
    .picker-empty .btn { margin-top:8px; }
    .picker-product { width:100%; min-height:64px; display:flex; align-items:center; gap:12px; text-align:left; padding:12px; background:transparent; color:var(--text-main); border:0; border-bottom:1px solid var(--border-flat); }
    .picker-product:last-child { border-bottom:0; }
    .picker-product:hover:not(:disabled), .picker-product:focus-visible { background:var(--bg-card-hover); }
    .picker-product-copy { min-width:0; flex:1; display:grid; gap:4px; overflow-wrap:anywhere; }
    .picker-product-copy > strong { font-size:.9rem; line-height:1.3; }
    .picker-product-copy > span { color:var(--text-muted); font-size:.75rem; line-height:1.35; }
    .picker-product-copy > small { font-size:.75rem; font-weight:700; color:var(--accent-primary); }
    .picker-add { display:flex; align-items:center; gap:4px; color:var(--accent-primary); font-size:.8rem; font-weight:700; flex:none; }
    .picker-pagination { flex:none; display:flex; gap:6px; align-items:center; }
    .picker-pagination > span { flex:1; min-width:0; color:var(--text-muted); font-size:.75rem; }
    .picker-page { flex:none; display:grid; place-items:center; width:36px; min-height:36px; color:var(--text-main); background:var(--bg-panel); border:1px solid var(--border-flat); border-radius:6px; }
    .product-picker button:disabled { opacity:.45; cursor:not-allowed; }
    .product-picker button:focus-visible { outline:2px solid var(--accent-primary); outline-offset:-2px; }
    .picker-done { min-width:104px; }
    @media (max-width:480px), (max-height:660px) {
        .product-picker { gap:9px; }
        .picker-product { padding:10px; min-height:58px; }
        .picker-search p { margin-top:7px; font-size:.72rem; }
        .picker-empty { padding:18px 12px; }
    }
</style>
