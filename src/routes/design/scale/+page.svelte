<script lang="ts">
    import { onDestroy } from 'svelte';
    import AdminPageHeader from '$lib/components/AdminPageHeader.svelte';
    import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
    import TouchColorPicker from '$lib/components/TouchColorPicker.svelte';
    import { formatMoney, now, settingsDB, type Product, uuid } from '$lib/stores/db';
    import { getProductsByIds, getProductsPage, upsert } from '$lib/stores/database';
    import { toast } from '$lib/stores/toast';

    type ScaleTilePage = { id: string; name: string; color: string; productIds: string[] };

    const SETTING_KEY = 'scale_tile_pages';
    const LEGACY_SETTING_KEY = 'scale_tile_product_ids';
    const DEFAULT_PAGE: ScaleTilePage = {
        id: 'scale-default',
        name: 'All Scale Items',
        color: '#10b981',
        productIds: [],
    };

    let pages: ScaleTilePage[] = [];
    let activePageId = '';
    let lastLoadedSettingValue: string | undefined | null = null;
    let saveBusy = false;

    let selectedProducts: Product[] = [];
    let selectedLoading = false;
    let selectedLoadSignature = '';
    let selectedLoadVersion = 0;

    let search = '';
    let availableProducts: Product[] = [];
    let availableLoading = false;
    let availableError = '';
    let availableSearchTimer: ReturnType<typeof setTimeout> | undefined;
    let availableLoadVersion = 0;

    let showPageDialog = false;
    let pageDialogMode: 'add' | 'rename' = 'add';
    let pageName = '';
    let pageColor = '#10b981';
    let showDeletePageConfirm = false;

    function normalizePages(value: unknown): ScaleTilePage[] {
        if (!Array.isArray(value)) return [];
        const assignedProductIds = new Set<string>();
        return value
            .filter((page) => page && typeof page === 'object')
            .map((page: any, index) => {
                const productIds = [...new Set<string>(
                    (Array.isArray(page.productIds) ? page.productIds : [])
                        .map((id: unknown) => String(id || '').trim())
                        .filter((id: string) => id.length > 0),
                )].filter((id) => {
                    if (assignedProductIds.has(id)) return false;
                    assignedProductIds.add(id);
                    return true;
                });
                return {
                    id: String(page.id || `scale-page-${index + 1}`),
                    name: String(page.name || `Scale Page ${index + 1}`).trim(),
                    color: String(page.color || '#10b981'),
                    productIds,
                };
            });
    }

    function readPages(): ScaleTilePage[] {
        try {
            const value = $settingsDB.find((setting) => setting.key === SETTING_KEY)?.value;
            if (value) {
                const parsed = normalizePages(JSON.parse(value));
                if (parsed.length) return parsed;
            }
            const legacyValue = $settingsDB.find((setting) => setting.key === LEGACY_SETTING_KEY)?.value;
            const legacyIds = legacyValue ? JSON.parse(legacyValue) : [];
            return [{ ...DEFAULT_PAGE, productIds: Array.isArray(legacyIds) ? legacyIds.map(String) : [] }];
        } catch {
            return [{ ...DEFAULT_PAGE }];
        }
    }

    $: {
        const settingValue = $settingsDB.find((setting) => setting.key === SETTING_KEY)?.value;
        if (settingValue !== lastLoadedSettingValue) {
            lastLoadedSettingValue = settingValue;
            pages = readPages();
        }
    }
    $: if (!activePageId || !pages.some((page) => page.id === activePageId)) activePageId = pages[0]?.id || '';
    $: activePage = pages.find((page) => page.id === activePageId);
    $: selectedIds = activePage?.productIds || [];
    $: assignedProductIds = new Set(pages.flatMap((page) => page.productIds));
    $: {
        const signature = `${activePageId}:${selectedIds.join('|')}:all:${[...assignedProductIds].sort().join('|')}`;
        if (signature !== selectedLoadSignature) {
            selectedLoadSignature = signature;
            void loadSelectedProducts(selectedIds);
            scheduleAvailableSearch(0);
        }
    }

    async function loadSelectedProducts(ids: string[]) {
        const version = ++selectedLoadVersion;
        selectedLoading = true;
        try {
            const rows = await getProductsByIds(ids, false, false) as Product[];
            if (version !== selectedLoadVersion) return;
            const byId = new Map(rows.map((product) => [product.id, product]));
            selectedProducts = ids.map((id) => byId.get(id)).filter((product): product is Product => Boolean(product));
        } catch (error) {
            console.error('Scale tile products were not loaded:', error);
            if (version === selectedLoadVersion) selectedProducts = [];
        } finally {
            if (version === selectedLoadVersion) selectedLoading = false;
        }
    }

    function scheduleAvailableSearch(delay = 180) {
        if (availableSearchTimer) clearTimeout(availableSearchTimer);
        availableSearchTimer = setTimeout(() => void loadAvailableProducts(), delay);
    }

    async function loadAvailableProducts() {
        const version = ++availableLoadVersion;
        availableLoading = true;
        availableError = '';
        try {
            const result = await getProductsPage({
                query: search,
                status: 'active',
                weighableOnly: true,
                limit: 100,
                offset: 0,
            });
            if (version !== availableLoadVersion) return;
            availableProducts = (result.rows as Product[])
                .filter((product) => !assignedProductIds.has(product.id))
                .slice(0, 60);
        } catch (error) {
            if (version !== availableLoadVersion) return;
            availableProducts = [];
            availableError = String(error);
        } finally {
            if (version === availableLoadVersion) availableLoading = false;
        }
    }

    async function save(nextPages: ScaleTilePage[], message: string): Promise<boolean> {
        if (saveBusy) return false;
        saveBusy = true;
        const setting = { key: SETTING_KEY, value: JSON.stringify(nextPages), updatedAt: now() };
        try {
            await upsert('settings', setting, 'key');
            pages = nextPages;
            lastLoadedSettingValue = setting.value;
            settingsDB.update((list) => [...list.filter((item) => item.key !== SETTING_KEY), setting]);
            toast(message, 'success');
            return true;
        } catch (error) {
            toast(`Scale layout was not saved: ${error}`, 'error');
            return false;
        } finally {
            saveBusy = false;
        }
    }

    async function add(product: Product) {
        if (pages.some((page) => page.productIds.includes(product.id))) {
            toast('This product is already assigned to another Scale page', 'info');
            scheduleAvailableSearch(0);
            return;
        }
        await save(
            pages.map((page) => page.id === activePageId ? { ...page, productIds: [...page.productIds, product.id] } : page),
            'Scale tile added',
        );
    }

    async function remove(id: string) {
        await save(
            pages.map((page) => page.id === activePageId ? { ...page, productIds: page.productIds.filter((item) => item !== id) } : page),
            'Scale tile removed',
        );
    }

    async function move(index: number, direction: number) {
        const target = index + direction;
        if (target < 0 || target >= selectedIds.length) return;
        const next = [...selectedIds];
        [next[index], next[target]] = [next[target], next[index]];
        await save(
            pages.map((page) => page.id === activePageId ? { ...page, productIds: next } : page),
            'Scale tile order saved',
        );
    }

    function openAddPage() {
        if (pages.length >= 8) {
            toast('Maximum 8 Scale pages allowed', 'error');
            return;
        }
        pageDialogMode = 'add';
        pageName = '';
        pageColor = '#10b981';
        showPageDialog = true;
    }

    function openRenamePage() {
        if (!activePage) return;
        pageDialogMode = 'rename';
        pageName = activePage.name;
        pageColor = activePage.color;
        showPageDialog = true;
    }

    async function savePageDialog() {
        const name = pageName.trim();
        if (!name) {
            toast('Enter a page name', 'error');
            return;
        }
        if (pageDialogMode === 'add') {
            const page: ScaleTilePage = { id: uuid(), name, color: pageColor, productIds: [] };
            if (await save([...pages, page], 'Scale page added')) {
                activePageId = page.id;
                showPageDialog = false;
            }
        } else if (await save(
            pages.map((page) => page.id === activePageId ? { ...page, name, color: pageColor } : page),
            'Scale page updated',
        )) {
            showPageDialog = false;
        }
    }

    function requestDeletePage() {
        if (pages.length <= 1) {
            toast('At least one Scale page is required', 'error');
            return;
        }
        showDeletePageConfirm = true;
    }

    async function deletePage() {
        if (!activePage || pages.length <= 1) return;
        const next = pages.filter((page) => page.id !== activePageId);
        if (await save(next, 'Scale page deleted')) {
            activePageId = next[0].id;
            showDeletePageConfirm = false;
        }
    }

    function closePageDialog() {
        if (!saveBusy && !showDeletePageConfirm) showPageDialog = false;
    }

    onDestroy(() => {
        if (availableSearchTimer) clearTimeout(availableSearchTimer);
    });
</script>

<svelte:head>
    <title>Scale Tile Designer - L&amp;Bj POS</title>
</svelte:head>

<svelte:window on:keydown={(event) => event.key === 'Escape' && closePageDialog()} />

<div class="scale-page">
    <AdminPageHeader
        title="Scale Tile Designer"
        eyebrow="Design Studio"
        description="Choose and arrange the weighed products shown to cashiers."
        backFallback="/design"
        padded
    />

    <main class="scale-main">
        <section class="scale-page-bar">
            <div class="scale-tabs" aria-label="Scale pages">
                {#each pages as page}
                    <button
                        type="button"
                        class:active={page.id === activePageId}
                        style="--page-colour: {page.color}"
                        on:click={() => activePageId = page.id}
                    >
                        <i></i><span>{page.name}</span>
                    </button>
                {/each}
                {#if pages.length < 8}
                    <button type="button" class="add-scale-page" on:click={openAddPage}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14"></path><path d="M5 12h14"></path></svg>
                        Add Page
                    </button>
                {/if}
            </div>
            <div class="scale-page-actions">
                <button type="button" disabled={saveBusy || !activePage} on:click={openRenamePage}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z"></path></svg>
                    Edit Page
                </button>
                <button type="button" class="danger" disabled={saveBusy || pages.length <= 1} on:click={requestDeletePage}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path></svg>
                    Delete
                </button>
            </div>
        </section>

        <div class="scale-columns">
            <section class="scale-column current-column">
                <header class="column-header">
                    <div><span>Current layout</span><h2>{activePage?.name || 'Scale Tiles'}</h2></div>
                    <b>{selectedProducts.length} tiles</b>
                </header>
                <div class="current-list">
                    {#if selectedLoading}
                        <div class="column-empty">Loading assigned products...</div>
                    {:else if selectedProducts.length}
                        {#each selectedProducts as product, index}
                            <article class="current-product" style="--product-colour: {product.color || '#3b82f6'}">
                                <span class="product-position">{index + 1}</span>
                                <div class="product-copy">
                                    <strong>{product.name}</strong>
                                    <small>{formatMoney(product.price)} / kg{product.scalePlu ? ` | PLU ${product.scalePlu}` : ''}</small>
                                </div>
                                <div class="product-actions">
                                    <button type="button" disabled={saveBusy || index === 0} aria-label={`Move ${product.name} earlier`} title="Move earlier" on:click={() => move(index, -1)}>
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="m6 15 6-6 6 6"></path></svg>
                                    </button>
                                    <button type="button" disabled={saveBusy || index === selectedProducts.length - 1} aria-label={`Move ${product.name} later`} title="Move later" on:click={() => move(index, 1)}>
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>
                                    </button>
                                    <button type="button" class="remove" disabled={saveBusy} aria-label={`Remove ${product.name}`} title="Remove tile" on:click={() => remove(product.id)}>
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path></svg>
                                    </button>
                                </div>
                            </article>
                        {/each}
                    {:else}
                        <div class="column-empty">No products are assigned to this Scale page.</div>
                    {/if}
                </div>
            </section>

            <section class="scale-column available-column">
                <header class="column-header available-heading">
                    <div><span>Available products</span><h2>Add Scale Tiles</h2></div>
                    <small>{availableLoading ? 'Searching' : `${availableProducts.length} available`}</small>
                </header>
                <div class="scale-search">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-4-4"></path></svg>
                    <input bind:value={search} on:input={() => scheduleAvailableSearch()} placeholder="Search name, SKU, barcode, or PLU" data-touch-keyboard="button" aria-label="Search weighable products" />
                </div>
                <div class="available-list">
                    {#if availableLoading}
                        <div class="column-empty">Searching weighable products...</div>
                    {:else if availableError}
                        <div class="column-empty error-state"><span>Product search failed.</span><button type="button" on:click={loadAvailableProducts}>Try Again</button></div>
                    {:else if availableProducts.length}
                        {#each availableProducts as product}
                            <button type="button" class="available-product" disabled={saveBusy} style="--product-colour: {product.color || '#3b82f6'}" on:click={() => add(product)}>
                                <i></i>
                                <span><strong>{product.name}</strong><small>{formatMoney(product.price)} / kg{product.scalePlu ? ` | PLU ${product.scalePlu}` : ''}</small></span>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14"></path><path d="M5 12h14"></path></svg>
                            </button>
                        {/each}
                    {:else}
                        <div class="column-empty">No other weighable products match this search.</div>
                    {/if}
                </div>
            </section>
        </div>
    </main>
</div>

{#if showPageDialog}
    <div class="modal-overlay">
        <form class="scale-dialog" aria-labelledby="scale-dialog-title" on:submit|preventDefault={savePageDialog}>
            <header>
                <div>
                    <span>{pageDialogMode === 'add' ? 'New classification' : 'Page settings'}</span>
                    <h2 id="scale-dialog-title">{pageDialogMode === 'add' ? 'Add Scale Page' : 'Edit Scale Page'}</h2>
                </div>
                <button type="button" class="dialog-close" aria-label="Close Scale page editor" on:click={closePageDialog}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12"></path><path d="M18 6 6 18"></path></svg>
                </button>
            </header>
            <label for="scale-page-name">Page name</label>
            <input id="scale-page-name" bind:value={pageName} maxlength="24" placeholder="For example: Vegetables" data-touch-keyboard="button" />
            <TouchColorPicker bind:value={pageColor} label="Page colour" />
            <footer>
                <button type="button" class="btn btn-secondary" disabled={saveBusy} on:click={closePageDialog}>Cancel</button>
                <button type="submit" class="btn btn-primary" disabled={saveBusy}>{saveBusy ? 'Saving...' : pageDialogMode === 'add' ? 'Add Page' : 'Save Page'}</button>
            </footer>
        </form>
    </div>
{/if}

<ConfirmDialog
    bind:show={showDeletePageConfirm}
    title="Delete Scale Page"
    message={`Delete “${activePage?.name || 'this page'}”? Products will remain in Items.`}
    variant="danger"
    on:confirm={deletePage}
/>

<style>
    .scale-page { width: 100vw; height: 100vh; overflow: hidden; display: flex; flex-direction: column; background: var(--bg-base); color: var(--text-main); font-size: var(--font-size-management); }
    .column-header span, .scale-dialog header span { display: block; color: var(--success); font-size: .68rem; font-weight: 900; letter-spacing: .12em; text-transform: uppercase; }
    .scale-main { flex: 1; min-height: 0; padding: 0 var(--app-page-gutter, 1.5rem) var(--app-page-gutter, 1.5rem); display: grid; grid-template-rows: 58px minmax(0,1fr); gap: .65rem; }
    .scale-page-bar { min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: .65rem; border-bottom: 1px solid var(--border-flat); }
    .scale-tabs { min-width: 0; flex: 1; display: flex; gap: .45rem; overflow-x: auto; padding-bottom: .35rem; }
    .scale-tabs button { min-height: 44px; padding: 0 .7rem; display: flex; align-items: center; gap: .45rem; border: 1px solid var(--border-flat); border-radius: .45rem; background: var(--bg-card); color: var(--text-muted); font-weight: 850; white-space: nowrap; }
    .scale-tabs button.active { border-color: var(--page-colour); color: var(--text-main); background: color-mix(in srgb, var(--page-colour) 10%, var(--bg-card)); }
    .scale-tabs i { width: .7rem; height: .7rem; border-radius: 50%; background: var(--page-colour); }
    .scale-tabs span { max-width: 150px; overflow: hidden; text-overflow: ellipsis; }
    .scale-tabs .add-scale-page { border-style: dashed; color: var(--success); }
    .add-scale-page svg { width: 18px; height: 18px; }
    .scale-page-actions { flex: 0 0 auto; display: flex; gap: .4rem; padding-bottom: .35rem; }
    .scale-page-actions button { min-height: 44px; padding: 0 .7rem; display: flex; align-items: center; gap: .4rem; border: 1px solid var(--border-flat); border-radius: .45rem; background: var(--bg-card); color: var(--text-main); font-weight: 850; }
    .scale-page-actions button.danger { color: var(--danger); }
    .scale-page-actions button:disabled { opacity: .35; cursor: not-allowed; }
    .scale-page-actions svg { width: 18px; height: 18px; }
    .scale-columns { min-height: 0; display: grid; grid-template-columns: minmax(0,.95fr) minmax(0,1.05fr); border: 1px solid var(--border-flat); border-radius: .5rem; overflow: hidden; background: var(--bg-panel); }
    .scale-column { min-width: 0; min-height: 0; padding: .85rem; display: grid; grid-template-rows: auto minmax(0,1fr); gap: .65rem; }
    .scale-column + .scale-column { border-left: 1px solid var(--border-flat); }
    .available-column { grid-template-rows: auto 48px minmax(0,1fr); }
    .column-header { min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: .75rem; }
    .column-header h2 { margin: .12rem 0 0; font-size: 1.15rem; letter-spacing: 0; }
    .column-header b { padding: .3rem .5rem; border-radius: .35rem; background: color-mix(in srgb, var(--success) 12%, var(--bg-card)); color: var(--success); font-size: .75rem; white-space: nowrap; }
    .column-header small { color: var(--text-muted); white-space: nowrap; }
    .current-list, .available-list { min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: .4rem; padding-right: .2rem; }
    .current-product { position: relative; min-height: 64px; padding: .45rem .5rem .45rem .65rem; overflow: hidden; display: grid; grid-template-columns: 34px minmax(0,1fr) auto; align-items: center; gap: .55rem; border: 1px solid var(--border-flat); border-radius: .4rem; background: var(--bg-card); }
    .current-product::before { content: ''; position: absolute; inset: 0 auto 0 0; width: 4px; background: var(--product-colour); }
    .product-position { width: 31px; height: 31px; display: grid; place-items: center; border-radius: .35rem; background: var(--bg-panel); color: var(--text-muted); font-weight: 900; }
    .product-copy { min-width: 0; display: flex; flex-direction: column; gap: .1rem; }
    .product-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .product-copy small { color: var(--text-muted); }
    .product-actions { display: flex; gap: .25rem; }
    .product-actions button { width: 36px; height: 36px; display: grid; place-items: center; border: 1px solid var(--border-flat); border-radius: .35rem; background: var(--bg-panel); color: var(--text-main); }
    .product-actions button:disabled { opacity: .28; cursor: not-allowed; }
    .product-actions button.remove { color: var(--danger); }
    .product-actions svg { width: 18px; height: 18px; }
    .scale-search { min-height: 48px; display: flex; align-items: center; gap: .55rem; padding: 0 .7rem; border: 1px solid var(--border-flat); border-radius: .4rem; background: var(--bg-card); }
    .scale-search svg { width: 20px; height: 20px; color: var(--text-muted); }
    .scale-search input { min-width: 0; flex: 1; border: 0; outline: 0; background: transparent; color: var(--text-main); }
    .available-list { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); grid-auto-rows: 64px; align-content: start; }
    .available-product { position: relative; min-width: 0; padding: .45rem .55rem; overflow: hidden; display: grid; grid-template-columns: 5px minmax(0,1fr) 22px; align-items: center; gap: .55rem; border: 1px solid var(--border-flat); border-radius: .4rem; background: var(--bg-card); color: var(--text-main); text-align: left; }
    .available-product:hover { border-color: var(--success); background: var(--bg-card-hover); }
    .available-product:disabled { opacity: .5; }
    .available-product i { width: 5px; height: 35px; border-radius: 2px; background: var(--product-colour); }
    .available-product span, .available-product strong, .available-product small { min-width: 0; display: block; }
    .available-product strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .available-product small { margin-top: .1rem; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .available-product svg { width: 21px; height: 21px; color: var(--success); }
    .column-empty { grid-column: 1 / -1; min-height: 100%; display: flex; align-items: center; justify-content: center; padding: 1rem; border: 1px dashed var(--border-flat); border-radius: .4rem; color: var(--text-muted); text-align: center; }
    .error-state { flex-direction: column; gap: .7rem; color: var(--danger); }
    .error-state button { min-height: 40px; padding: 0 .8rem; border-radius: .4rem; background: var(--accent-primary); color: white; font-weight: 850; }
    .scale-dialog { width: min(470px,94vw); max-height: 90vh; overflow-y: auto; padding: 1.1rem; display: flex; flex-direction: column; gap: .8rem; border: 1px solid var(--border-flat); border-radius: .5rem; background: var(--bg-panel); color: var(--text-main); box-shadow: 0 24px 70px var(--shadow); }
    .scale-dialog header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
    .scale-dialog h2 { margin: .12rem 0 0; font-size: 1.3rem; letter-spacing: 0; }
    .scale-dialog label { color: var(--text-muted); font-size: .78rem; font-weight: 850; }
    .scale-dialog > input { min-height: 48px; padding: 0 .8rem; border: 1px solid var(--border-flat); border-radius: .4rem; background: var(--bg-card); color: var(--text-main); }
    .scale-dialog footer { display: flex; justify-content: flex-end; gap: .5rem; margin-top: .25rem; }
    .dialog-close { width: 40px; height: 40px; display: grid; place-items: center; border: 1px solid var(--border-flat); border-radius: .4rem; background: var(--bg-card); color: var(--text-muted); }
    .dialog-close svg { width: 20px; height: 20px; }
    @media (max-height: 680px) and (min-width: 761px) { .scale-main { grid-template-rows: 52px minmax(0,1fr); } .scale-page-actions button, .scale-tabs button { min-height: 40px; } .current-product { min-height: 58px; } .available-list { grid-auto-rows: 58px; } }
    @media (max-width: 760px) { .scale-page { overflow-y: auto; } .scale-main { display: flex; flex-direction: column; } .scale-page-bar { align-items: stretch; flex-direction: column; } .scale-columns { display: flex; flex-direction: column; overflow: visible; } .scale-column { min-height: 430px; } .scale-column + .scale-column { border-top: 1px solid var(--border-flat); border-left: 0; } }
</style>
