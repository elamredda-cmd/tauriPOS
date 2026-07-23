<script lang="ts">
    import AdminPageHeader from '$lib/components/AdminPageHeader.svelte';
    import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
    import TouchColorPicker from '$lib/components/TouchColorPicker.svelte';
    import TouchKeyboardButton from '$lib/components/TouchKeyboardButton.svelte';
    import {
        posPagesDB,
        activePosPages,
        tilesDB,
        type PosPage,
        type Product,
        type Tile,
        uuid,
        formatMoney,
    } from '$lib/stores/db';
    import { toast } from '$lib/stores/toast';
    import {
        savePosPage,
        deletePosPage,
        addTile,
        deleteTile,
        getProductsByIds,
        getProductsPage,
    } from '$lib/stores/database';

    const POS_TILES_PER_PAGE = 16;
    let activePageId = '';
    let currentPageIndex = 0;
    let tileProducts: Product[] = [];
    let tileProductsLoading = false;
    let loadedTileProductSignature = '';
    let tileProductLoadVersion = 0;

    let showPageModal = false;
    let pageModalMode: 'add' | 'edit' = 'add';
    let editPageId = '';
    let editPageName = '';
    let editPageColor = '#3b82f6';
    let pageSaving = false;
    let showPageDelConfirm = false;

    let showTileSearchModal = false;
    let pendingTilePosition = 1;
    let searchTerm = '';
    let appliedSearchTerm = '';
    let hasProductSearchRun = false;
    let availableProducts: Product[] = [];
    let productSearchLoading = false;
    let productSearchError = '';
    let productSearchTotal = 0;
    let productSearchTotalCapped = false;
    let productSearchVersion = 0;

    let showEditTileModal = false;
    let editTileObj: Tile | null = null;
    let tileSaving = false;

    $: {
        if ($activePosPages.length > 0 && !$activePosPages.some((page) => page.id === activePageId)) {
            activePageId = $activePosPages[0].id;
            currentPageIndex = 0;
        } else if ($activePosPages.length === 0) {
            activePageId = '';
        }
    }

    $: activePageTiles = $tilesDB
        .filter((tile) => tile.pageId === activePageId)
        .sort((a, b) => a.position - b.position);
    $: visiblePositionStart = currentPageIndex * POS_TILES_PER_PAGE + 1;
    $: visiblePositionEnd = visiblePositionStart + POS_TILES_PER_PAGE - 1;
    $: visibleTileProductIds = [...new Set(activePageTiles
        .filter((tile) => tile.position >= visiblePositionStart && tile.position <= visiblePositionEnd)
        .map((tile) => tile.productId)
        .filter(Boolean))];
    $: {
        const signature = `${activePageId}:${currentPageIndex}:${visibleTileProductIds.slice().sort().join('|')}`;
        if (signature !== loadedTileProductSignature) {
            loadedTileProductSignature = signature;
            void loadTileProducts(visibleTileProductIds);
        }
    }

    $: activePageTileProductIds = new Set(activePageTiles.map((tile) => tile.productId));
    $: activeProductById = new Map(tileProducts.map((product) => [product.id, product]));
    $: tileByPosition = new Map(activePageTiles.map((tile) => [tile.position, tile]));
    $: totalPages = Math.max(
        1,
        Math.ceil((activePageTiles.length ? Math.max(...activePageTiles.map((tile) => tile.position)) : 0) / POS_TILES_PER_PAGE),
    );
    $: displayTiles = Array.from({ length: POS_TILES_PER_PAGE }, (_, index) => {
        const absolutePos = currentPageIndex * POS_TILES_PER_PAGE + index + 1;
        const tile = tileByPosition.get(absolutePos);
        return tile ? { tile, product: activeProductById.get(tile.productId), absolutePos } : null;
    });
    $: editTileProduct = editTileObj ? activeProductById.get(editTileObj.productId) : null;

    async function loadTileProducts(ids: string[]) {
        const version = ++tileProductLoadVersion;
        if (ids.length === 0) {
            tileProducts = [];
            tileProductsLoading = false;
            return;
        }
        tileProductsLoading = true;
        try {
            const rows = await getProductsByIds(ids, false, false) as Product[];
            if (version === tileProductLoadVersion) tileProducts = rows;
        } catch (error) {
            console.error('Tile products were not loaded:', error);
            if (version === tileProductLoadVersion) tileProducts = [];
        } finally {
            if (version === tileProductLoadVersion) tileProductsLoading = false;
        }
    }

    function openAddPage() {
        if ($activePosPages.length >= 8) {
            toast('Maximum 8 POS pages allowed', 'error');
            return;
        }
        pageModalMode = 'add';
        editPageId = '';
        editPageName = 'New Page';
        editPageColor = '#3b82f6';
        showPageModal = true;
    }

    function openEditPage(page: PosPage) {
        pageModalMode = 'edit';
        editPageId = page.id;
        editPageName = page.name;
        editPageColor = page.color;
        showPageModal = true;
    }

    async function savePage() {
        const name = editPageName.trim();
        if (!name) {
            toast('Enter a page name', 'error');
            return;
        }
        if (pageSaving) return;
        pageSaving = true;
        try {
            if (pageModalMode === 'add') {
                const maxPos = $posPagesDB.reduce((maximum, page) => Math.max(maximum, page.position), 0);
                const newPage: PosPage = {
                    id: uuid(),
                    name,
                    position: maxPos + 1,
                    color: editPageColor,
                };
                await savePosPage(newPage);
                posPagesDB.update((pages) => [...pages, newPage]);
                activePageId = newPage.id;
                currentPageIndex = 0;
                toast('POS page added', 'success');
            } else {
                const existing = $posPagesDB.find((page) => page.id === editPageId);
                if (!existing) throw new Error('Page no longer exists');
                const updated = { ...existing, name, color: editPageColor };
                await savePosPage(updated);
                posPagesDB.update((pages) => pages.map((page) => page.id === editPageId ? updated : page));
                toast('POS page updated', 'success');
            }
            showPageModal = false;
        } catch (error) {
            toast(`Page was not saved: ${error}`, 'error');
        } finally {
            pageSaving = false;
        }
    }

    async function handlePageDelete() {
        if (pageSaving) return;
        pageSaving = true;
        try {
            await deletePosPage(editPageId);
            posPagesDB.update((pages) => pages.filter((page) => page.id !== editPageId));
            tilesDB.update((tiles) => tiles.filter((tile) => tile.pageId !== editPageId));
            activePageId = '';
            currentPageIndex = 0;
            showPageModal = false;
            showPageDelConfirm = false;
            toast('POS page deleted', 'info');
        } catch (error) {
            toast(`Page was not deleted: ${error}`, 'error');
        } finally {
            pageSaving = false;
        }
    }

    function handleEmptyTileClick(absolutePos: number) {
        pendingTilePosition = absolutePos;
        searchTerm = '';
        appliedSearchTerm = '';
        hasProductSearchRun = false;
        availableProducts = [];
        productSearchError = '';
        showTileSearchModal = true;
    }

    function runProductSearch() {
        appliedSearchTerm = searchTerm.trim();
        hasProductSearchRun = true;
        void loadAvailableProducts();
    }

    function handleProductSearchKeydown(event: KeyboardEvent) {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        runProductSearch();
    }

    async function loadAvailableProducts() {
        const version = ++productSearchVersion;
        productSearchLoading = true;
        productSearchError = '';
        try {
            const result = await getProductsPage({
                query: appliedSearchTerm,
                status: 'active',
                limit: 50,
                offset: 0,
                compact: true,
            });
            if (version !== productSearchVersion) return;
            availableProducts = (result.rows as Product[])
                .filter((product) => !activePageTileProductIds.has(product.id))
                .slice(0, 50);
            productSearchTotal = result.total;
            productSearchTotalCapped = Boolean(result.totalIsCapped);
        } catch (error) {
            if (version !== productSearchVersion) return;
            productSearchError = String(error);
            availableProducts = [];
        } finally {
            if (version === productSearchVersion) productSearchLoading = false;
        }
    }

    async function assignProductToTile(product: Product) {
        if (tileSaving || !activePageId) return;
        tileSaving = true;
        try {
            const existing = $tilesDB.find((tile) => tile.pageId === activePageId && tile.position === pendingTilePosition);
            if (existing) await deleteTile(existing.id);

            const newTile: Tile = {
                id: uuid(),
                pageId: activePageId,
                productId: product.id,
                position: pendingTilePosition,
            };
            await addTile(newTile);
            tilesDB.update((tiles) => [...tiles.filter((tile) => tile.id !== existing?.id), newTile]);
            if (!tileProducts.some((item) => item.id === product.id)) tileProducts = [...tileProducts, product];
            showTileSearchModal = false;
            toast('Product tile added', 'success');
        } catch (error) {
            toast(`Tile was not saved: ${error}`, 'error');
        } finally {
            tileSaving = false;
        }
    }

    function handleAssignedTileClick(tile: Tile) {
        editTileObj = tile;
        showEditTileModal = true;
    }

    async function removeTile() {
        if (!editTileObj || tileSaving) return;
        tileSaving = true;
        try {
            await deleteTile(editTileObj.id);
            tilesDB.update((tiles) => tiles.filter((tile) => tile.id !== editTileObj?.id));
            showEditTileModal = false;
            editTileObj = null;
            toast('Product tile removed', 'info');
        } catch (error) {
            toast(`Tile was not removed: ${error}`, 'error');
        } finally {
            tileSaving = false;
        }
    }

    function closeTopModal() {
        if (showPageDelConfirm || pageSaving || tileSaving) return;
        if (showTileSearchModal) showTileSearchModal = false;
        else if (showEditTileModal) showEditTileModal = false;
        else if (showPageModal) showPageModal = false;
    }

</script>

<svelte:head>
    <title>POS Tile Designer - L&amp;Bj POS</title>
</svelte:head>

<svelte:window on:keydown={(event) => event.key === 'Escape' && closeTopModal()} />

<div class="tile-designer-page">
    <AdminPageHeader
        title="POS Tile Designer"
        eyebrow="Design Studio"
        description="Arrange the product shortcuts shown on checkout."
        backFallback="/design"
        padded
    />

    <main class="tile-designer-main">
        <nav class="pos-page-tabs" aria-label="POS pages">
            {#each $activePosPages as page}
                <div class:active={activePageId === page.id} class="pos-page-tab">
                    <button
                        type="button"
                        class="page-select"
                        on:click={() => { activePageId = page.id; currentPageIndex = 0; }}
                    >
                        <i style="background: {page.color}"></i>
                        <span>{page.name}</span>
                    </button>
                    {#if activePageId === page.id}
                        <button type="button" class="page-edit" aria-label={`Edit ${page.name}`} title={`Edit ${page.name}`} on:click={() => openEditPage(page)}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                <path d="M12 20h9"></path>
                                <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z"></path>
                            </svg>
                        </button>
                    {/if}
                </div>
            {/each}
            {#if $activePosPages.length < 8}
                <button type="button" class="add-pos-page" on:click={openAddPage}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
                        <path d="M12 5v14"></path><path d="M5 12h14"></path>
                    </svg>
                    Add Page
                </button>
            {/if}
        </nav>

        {#if activePageId}
            <section class="tile-grid-workspace" aria-label="POS tile positions">
                <div class="tile-grid">
                    {#each displayTiles as slot, index}
                        {@const absolutePos = currentPageIndex * POS_TILES_PER_PAGE + index + 1}
                        {#if slot}
                            <button
                                type="button"
                                class="product-tile"
                                class:missing={!slot.product}
                                disabled={tileProductsLoading && !slot.product}
                                style="--product-color: {slot.product?.color || '#3b82f6'}"
                                aria-label={slot.product
                                    ? `Edit position ${absolutePos}, ${slot.product.name}`
                                    : tileProductsLoading
                                        ? `Loading item in position ${absolutePos}`
                                        : `Remove unavailable item from position ${absolutePos}`}
                                on:click={() => handleAssignedTileClick(slot.tile)}
                            >
                                {#if slot.product}
                                    {#if slot.product.image}
                                        <img src={slot.product.image} alt="" />
                                    {/if}
                                    <span class="tile-shade" aria-hidden="true"></span>
                                    <span class="tile-position">{absolutePos}</span>
                                    <span class="tile-caption">
                                        <strong>{slot.product.name}</strong>
                                        <b>{formatMoney(slot.product.price)}</b>
                                    </span>
                                {:else if tileProductsLoading}
                                    <span class="tile-loading-spinner" aria-hidden="true"></span>
                                    <strong>Loading item</strong>
                                    <span>Position {absolutePos}</span>
                                {:else}
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                        <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path>
                                        <path d="M12 9v4"></path><path d="M12 17h.01"></path>
                                    </svg>
                                    <strong>Item unavailable</strong>
                                    <span>Position {absolutePos}</span>
                                {/if}
                            </button>
                        {:else}
                            <button type="button" class="empty-tile" aria-label={`Add product to position ${absolutePos}`} on:click={() => handleEmptyTileClick(absolutePos)}>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                                    <path d="M12 5v14"></path><path d="M5 12h14"></path>
                                </svg>
                                <span>Position {absolutePos}</span>
                            </button>
                        {/if}
                    {/each}
                </div>

                <footer class="grid-pagination">
                    <button type="button" disabled={currentPageIndex === 0} aria-label="Previous tile grid" title="Previous tile grid" on:click={() => currentPageIndex--}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"></path></svg>
                    </button>
                    <span>
                        {#if currentPageIndex >= totalPages}
                            Empty grid {currentPageIndex + 1}
                        {:else}
                            Grid {currentPageIndex + 1} of {totalPages}
                        {/if}
                    </span>
                    <button type="button" disabled={currentPageIndex >= totalPages} aria-label="Next tile grid" title={currentPageIndex === totalPages - 1 ? 'Open one empty grid to add more tiles' : 'Next tile grid'} on:click={() => currentPageIndex++}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg>
                    </button>
                </footer>
            </section>
        {:else}
            <section class="no-pages">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"></rect><path d="M12 8v8"></path><path d="M8 12h8"></path></svg>
                <h2>No POS pages</h2>
                <p>Add a page to start arranging checkout tiles.</p>
                <button type="button" class="btn btn-primary" on:click={openAddPage}>Add POS Page</button>
            </section>
        {/if}
    </main>
</div>

{#if showPageModal}
    <div class="modal-overlay">
        <form class="designer-dialog" aria-labelledby="page-dialog-title" on:submit|preventDefault={savePage}>
            <header>
                <div>
                    <span>{pageModalMode === 'add' ? 'New checkout page' : 'Checkout page settings'}</span>
                    <h2 id="page-dialog-title">{pageModalMode === 'add' ? 'Add POS Page' : 'Edit POS Page'}</h2>
                </div>
                <button type="button" class="dialog-close" aria-label="Close page editor" on:click={() => showPageModal = false}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12"></path><path d="M18 6 6 18"></path></svg>
                </button>
            </header>
            <label for="pos-page-name">Page name</label>
            <input id="pos-page-name" type="text" bind:value={editPageName} maxlength="20" data-touch-keyboard="button" />
            <TouchColorPicker bind:value={editPageColor} label="Page colour" />
            <footer>
                {#if pageModalMode === 'edit'}
                    <button type="button" class="btn btn-danger delete-page-button" disabled={pageSaving} on:click={() => showPageDelConfirm = true}>Delete Page</button>
                {/if}
                <button type="button" class="btn btn-secondary" disabled={pageSaving} on:click={() => showPageModal = false}>Cancel</button>
                <button type="submit" class="btn btn-primary" disabled={pageSaving}>{pageSaving ? 'Saving...' : 'Save Page'}</button>
            </footer>
        </form>
    </div>
{/if}

{#if showTileSearchModal}
    <div class="modal-overlay">
        <section class="designer-dialog product-picker" aria-labelledby="product-picker-title">
            <header>
                <div>
                    <span>Position {pendingTilePosition}</span>
                    <h2 id="product-picker-title">Choose a Product</h2>
                </div>
                <button type="button" class="dialog-close" aria-label="Close product picker" on:click={() => showTileSearchModal = false}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12"></path><path d="M18 6 6 18"></path></svg>
                </button>
            </header>
            <div class="picker-search-row">
                <div class="picker-search">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-4-4"></path></svg>
                    <input id="tile-product-search" bind:value={searchTerm} on:keydown={handleProductSearchKeydown} placeholder="Search name, SKU, barcode, or PLU" data-touch-keyboard="button" aria-label="Search products" />
                    <TouchKeyboardButton targetId="tile-product-search" label="Open product search keyboard" embedded />
                </div>
                <button type="button" class="picker-find" disabled={productSearchLoading} on:click={runProductSearch}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-4-4"></path></svg>
                    {productSearchLoading ? 'Finding...' : 'Find'}
                </button>
            </div>
            <div class="picker-status">
                {#if !hasProductSearchRun}
                    Enter an item name or code, then press Find. Leave it empty to browse the first 50.
                {:else if productSearchLoading}
                    Searching products...
                {:else if productSearchError}
                    Product search failed
                {:else}
                    {availableProducts.length === 50 && (productSearchTotalCapped || productSearchTotal > 50)
                        ? 'Showing first 50 available products'
                        : `${availableProducts.length} available ${availableProducts.length === 1 ? 'product' : 'products'}`}
                {/if}
            </div>
            <div class="product-results">
                {#each availableProducts as product}
                    <button type="button" disabled={tileSaving} on:click={() => assignProductToTile(product)}>
                        <i style="background: {product.color || '#3b82f6'}"></i>
                        <span><strong>{product.name}</strong><small>{product.sku || product.barcode || product.scalePlu || 'No product code'}</small></span>
                        <b>{formatMoney(product.price)}</b>
                    </button>
                {/each}
                {#if hasProductSearchRun && !productSearchLoading && !productSearchError && availableProducts.length === 0}
                    <div class="picker-empty">No unassigned products match this search.</div>
                {/if}
                {#if productSearchError}
                    <button type="button" class="retry-search" on:click={loadAvailableProducts}>Try Again</button>
                {/if}
            </div>
        </section>
    </div>
{/if}

{#if showEditTileModal}
    <div class="modal-overlay">
        <section class="designer-dialog remove-dialog" aria-labelledby="remove-tile-title">
            <header>
                <div>
                    <span>Position {editTileObj?.position}</span>
                    <h2 id="remove-tile-title">Edit Product Tile</h2>
                </div>
                <button type="button" class="dialog-close" aria-label="Close tile editor" on:click={() => showEditTileModal = false}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12"></path><path d="M18 6 6 18"></path></svg>
                </button>
            </header>
            <div class="remove-product-summary">
                <i style="background: {editTileProduct?.color || '#64748b'}"></i>
                <div><strong>{editTileProduct?.name || 'Unavailable item'}</strong><span>{editTileProduct ? formatMoney(editTileProduct.price) : 'The product record is missing'}</span></div>
            </div>
            <p>Remove this shortcut from the checkout layout? The product itself will not be deleted.</p>
            <footer>
                <button type="button" class="btn btn-secondary" disabled={tileSaving} on:click={() => showEditTileModal = false}>Cancel</button>
                <button type="button" class="btn btn-danger" disabled={tileSaving} on:click={removeTile}>{tileSaving ? 'Removing...' : 'Remove Tile'}</button>
            </footer>
        </section>
    </div>
{/if}

<ConfirmDialog
    bind:show={showPageDelConfirm}
    title="Delete POS Page"
    message="Delete this page and all of its product shortcuts? Products will remain in Items."
    variant="danger"
    on:confirm={handlePageDelete}
/>

<style>
    .tile-designer-page { width: 100vw; height: 100vh; overflow: hidden; display: flex; flex-direction: column; background: var(--bg-base); color: var(--text-main); font-size: var(--font-size-management); }
    .designer-dialog header span { display: block; color: var(--accent-primary); font-size: .68rem; font-weight: 900; letter-spacing: .12em; text-transform: uppercase; }
    .tile-designer-main { flex: 1; min-height: 0; padding: 0 var(--app-page-gutter, 1.5rem) var(--app-page-gutter, 1.5rem); display: flex; flex-direction: column; gap: .65rem; }
    .pos-page-tabs { min-height: 48px; display: flex; gap: .5rem; overflow-x: auto; flex: 0 0 auto; }
    .pos-page-tab { min-width: 0; height: 46px; display: flex; border: 1px solid var(--border-flat); border-radius: .45rem; overflow: hidden; background: var(--bg-card); }
    .pos-page-tab.active { border-color: var(--accent-primary); }
    .page-select { min-width: 0; padding: 0 .8rem; display: flex; align-items: center; gap: .5rem; background: transparent; color: var(--text-muted); font-weight: 850; }
    .pos-page-tab.active .page-select { color: var(--text-main); background: color-mix(in srgb, var(--accent-primary) 10%, transparent); }
    .page-select i { width: .7rem; height: .7rem; flex: 0 0 auto; border-radius: 50%; }
    .page-select span { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .page-edit { width: 42px; display: grid; place-items: center; border-left: 1px solid var(--border-flat); background: var(--bg-panel); color: var(--text-muted); }
    .page-edit:hover { color: var(--accent-primary); background: var(--bg-card-hover); }
    .page-edit svg, .add-pos-page svg { width: 19px; height: 19px; }
    .add-pos-page { height: 46px; padding: 0 .85rem; display: flex; align-items: center; gap: .45rem; border: 1px dashed var(--border-flat); border-radius: .45rem; background: transparent; color: var(--accent-primary); font-weight: 850; white-space: nowrap; }
    .add-pos-page:hover { border-color: var(--accent-primary); background: var(--bg-card); }
    .tile-grid-workspace { flex: 1; min-height: 0; display: grid; grid-template-rows: minmax(0, 1fr) 48px; gap: .65rem; }
    .tile-grid { min-height: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); grid-template-rows: repeat(4, minmax(0, 1fr)); gap: .55rem; }
    .product-tile, .empty-tile { position: relative; min-width: 0; min-height: 0; overflow: hidden; border: 1px solid var(--border-flat); border-radius: .45rem; }
    .product-tile { background: var(--product-color); color: white; text-align: left; }
    .product-tile:hover { border-color: var(--accent-primary); }
    .product-tile img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; background: white; }
    .tile-shade { position: absolute; inset: 0; background: linear-gradient(to top, rgba(0,0,0,.88), rgba(0,0,0,.12) 68%); }
    .tile-position { position: absolute; top: .4rem; left: .4rem; min-width: 1.5rem; height: 1.5rem; padding: 0 .35rem; display: grid; place-items: center; border-radius: .3rem; background: rgba(0,0,0,.58); color: white; font-size: .68rem; font-weight: 900; }
    .tile-caption { position: absolute; left: .55rem; right: .55rem; bottom: .5rem; display: flex; align-items: end; justify-content: space-between; gap: .45rem; }
    .tile-caption strong { min-width: 0; overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; font-size: .92rem; line-height: 1.05; text-shadow: 0 1px 2px #000; }
    .tile-caption b { flex: 0 0 auto; padding: .25rem .4rem; border-radius: .25rem; background: var(--price-bg); color: var(--price-text); font-size: .78rem; }
    .product-tile.missing { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .3rem; background: color-mix(in srgb, var(--danger) 9%, var(--bg-card)); color: var(--danger); text-align: center; }
    .product-tile.missing svg { width: 28px; height: 28px; }
    .product-tile.missing span { color: var(--text-muted); font-size: .72rem; }
    .tile-loading-spinner { width: 24px; height: 24px; border: 3px solid var(--border-flat); border-top-color: var(--accent-primary); border-radius: 50%; animation: tile-spin .7s linear infinite; }
    @keyframes tile-spin { to { transform: rotate(360deg); } }
    .empty-tile { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .3rem; border-style: dashed; background: transparent; color: var(--text-muted); }
    .empty-tile:hover { border-color: var(--accent-primary); background: color-mix(in srgb, var(--accent-primary) 7%, transparent); color: var(--accent-primary); }
    .empty-tile svg { width: 27px; height: 27px; }
    .empty-tile span { font-size: .72rem; font-weight: 800; }
    .grid-pagination { min-height: 48px; padding: .25rem .4rem; display: grid; grid-template-columns: 42px minmax(0,1fr) 42px; align-items: center; border: 1px solid var(--border-flat); border-radius: .45rem; background: var(--bg-card); }
    .grid-pagination button { width: 38px; height: 38px; display: grid; place-items: center; border: 1px solid var(--border-flat); border-radius: .4rem; background: var(--bg-panel); color: var(--text-main); }
    .grid-pagination button:last-child { justify-self: end; }
    .grid-pagination button:disabled { opacity: .3; cursor: not-allowed; }
    .grid-pagination svg { width: 21px; height: 21px; }
    .grid-pagination span { text-align: center; color: var(--text-muted); font-size: .8rem; font-weight: 850; }
    .no-pages { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--text-muted); text-align: center; }
    .no-pages svg { width: 50px; height: 50px; color: var(--accent-primary); }
    .no-pages h2 { margin: .8rem 0 .2rem; color: var(--text-main); }
    .no-pages p { margin: 0 0 1rem; }
    .designer-dialog { width: min(470px, 94vw); max-height: 90vh; overflow-y: auto; padding: 1.1rem; display: flex; flex-direction: column; gap: .8rem; border: 1px solid var(--border-flat); border-radius: .5rem; background: var(--bg-panel); color: var(--text-main); box-shadow: 0 24px 70px var(--shadow); }
    .designer-dialog header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
    .designer-dialog h2 { margin: .12rem 0 0; font-size: 1.3rem; letter-spacing: 0; }
    .designer-dialog label { color: var(--text-muted); font-size: .78rem; font-weight: 850; }
    .designer-dialog > input { min-height: 48px; padding: 0 .8rem; border: 1px solid var(--border-flat); border-radius: .4rem; background: var(--bg-card); color: var(--text-main); }
    .designer-dialog footer { display: flex; justify-content: flex-end; gap: .5rem; margin-top: .25rem; }
    .delete-page-button { margin-right: auto; }
    .dialog-close { width: 40px; height: 40px; flex: 0 0 auto; display: grid; place-items: center; border: 1px solid var(--border-flat); border-radius: .4rem; background: var(--bg-card); color: var(--text-muted); }
    .dialog-close svg { width: 20px; height: 20px; }
    .product-picker { width: min(680px, 95vw); height: min(650px, 90vh); overflow: hidden; }
    .picker-search-row { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) 104px; gap: .55rem; }
    .picker-search { position: relative; min-height: 50px; display: flex; align-items: center; gap: .6rem; padding: 0 .8rem; border: 1px solid var(--border-flat); border-radius: .4rem; background: var(--bg-card); }
    .picker-search svg { width: 21px; height: 21px; flex: 0 0 auto; color: var(--text-muted); }
    .picker-search input { min-width: 0; flex: 1; padding-right: 2.5rem; border: 0; outline: 0; background: transparent; color: var(--text-main); }
    .picker-find { min-height: 50px; padding: 0 .8rem; display: flex; align-items: center; justify-content: center; gap: .4rem; border: 1px solid var(--accent-primary); border-radius: .4rem; background: var(--accent-primary); color: white; font-size: .8rem; font-weight: 900; }
    .picker-find:hover { filter: brightness(1.08); }
    .picker-find:disabled { opacity: .58; cursor: wait; }
    .picker-find svg { width: 18px; height: 18px; }
    .picker-status { min-height: 24px; color: var(--text-muted); font-size: .72rem; font-weight: 750; }
    .product-results { min-height: 0; flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: .35rem; }
    .product-results > button:not(.retry-search) { min-height: 58px; padding: .45rem .65rem; display: grid; grid-template-columns: 7px minmax(0,1fr) auto; align-items: center; gap: .7rem; border: 1px solid var(--border-flat); border-radius: .4rem; background: var(--bg-card); color: var(--text-main); text-align: left; }
    .product-results > button:hover { border-color: var(--accent-primary); background: var(--bg-card-hover); }
    .product-results i { width: 7px; height: 35px; border-radius: 2px; }
    .product-results span, .product-results strong, .product-results small { min-width: 0; display: block; }
    .product-results strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .product-results small { margin-top: .08rem; color: var(--text-muted); }
    .product-results b { color: var(--success); white-space: nowrap; }
    .picker-empty { margin: auto; color: var(--text-muted); text-align: center; }
    .retry-search { min-height: 46px; border-radius: .4rem; background: var(--accent-primary); color: white; font-weight: 850; }
    .remove-dialog p { margin: 0; color: var(--text-muted); }
    .remove-product-summary { min-height: 62px; padding: .6rem; display: flex; align-items: center; gap: .7rem; border: 1px solid var(--border-flat); border-radius: .4rem; background: var(--bg-card); }
    .remove-product-summary i { width: 8px; height: 40px; border-radius: 2px; }
    .remove-product-summary div { min-width: 0; display: flex; flex-direction: column; }
    .remove-product-summary span { color: var(--text-muted); font-size: .78rem; }
    @media (max-height: 680px) and (min-width: 721px) { .pos-page-tabs { min-height: 43px; } .pos-page-tab, .add-pos-page { height: 41px; } .tile-grid-workspace { grid-template-rows: minmax(0,1fr) 43px; } }
    @media (max-width: 720px) { .tile-designer-page { overflow-y: auto; } .tile-designer-main { min-height: 720px; } .tile-grid { grid-template-columns: repeat(2,minmax(0,1fr)); grid-template-rows: repeat(8,minmax(96px,1fr)); } .picker-search-row { grid-template-columns: minmax(0,1fr) 90px; } }
</style>
