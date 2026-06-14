<script lang="ts">
    import MgmtPage from "$lib/components/MgmtPage.svelte";
    import { activeProducts, formatMoney, now, settingsDB, uuid } from "$lib/stores/db";
    import { upsert } from "$lib/stores/database";
    import { toast } from "$lib/stores/toast";

    type ScaleTilePage = { id: string; name: string; color: string; productIds: string[] };

    const SETTING_KEY = "scale_tile_pages";
    const LEGACY_SETTING_KEY = "scale_tile_product_ids";
    let search = "";
    let activePageId = "";
    let showPageDialog = false;
    let pageDialogMode: "add" | "rename" = "add";
    let pageName = "";
    let pages: ScaleTilePage[] = [];
    let lastLoadedSettingValue: string | undefined | null = null;

    function readPages(): ScaleTilePage[] {
        try {
            const value = $settingsDB.find((setting) => setting.key === SETTING_KEY)?.value;
            if (value) return JSON.parse(value);
            const legacyValue = $settingsDB.find((setting) => setting.key === LEGACY_SETTING_KEY)?.value;
            return [{ id: "scale-default", name: "All Scale Items", color: "#10b981", productIds: legacyValue ? JSON.parse(legacyValue) : [] }];
        } catch {
            return [{ id: "scale-default", name: "All Scale Items", color: "#10b981", productIds: [] }];
        }
    }

    $: {
        const settingValue = $settingsDB.find((setting) => setting.key === SETTING_KEY)?.value;
        if (settingValue !== lastLoadedSettingValue) {
            lastLoadedSettingValue = settingValue;
            pages = readPages();
        }
    }
    $: if (!activePageId || !pages.some((page) => page.id === activePageId)) activePageId = pages[0]?.id || "";
    $: activePage = pages.find((page) => page.id === activePageId);
    $: selectedIds = activePage?.productIds || [];
    $: weighableProducts = $activeProducts.filter((product) => product.isWeighable);
    $: selectedProducts = selectedIds
        .map((id) => weighableProducts.find((product) => product.id === id))
        .filter(Boolean);
    $: availableProducts = weighableProducts.filter((product) =>
        !selectedIds.includes(product.id) &&
        (product.name.toLowerCase().includes(search.toLowerCase()) ||
            product.scalePlu?.includes(search)),
    );

    async function save(nextPages: ScaleTilePage[], message: string) {
        pages = nextPages;
        const setting = { key: SETTING_KEY, value: JSON.stringify(nextPages), updatedAt: now() };
        lastLoadedSettingValue = setting.value;
        settingsDB.update((list) => [...list.filter((item) => item.key !== SETTING_KEY), setting]);
        await upsert("settings", setting, "key");
        toast(message, "success");
    }

    function add(id: string) {
        save(pages.map((page) => page.id === activePageId ? { ...page, productIds: [...page.productIds, id] } : page), "Scale tile added");
    }

    function remove(id: string) {
        save(pages.map((page) => page.id === activePageId ? { ...page, productIds: page.productIds.filter((item) => item !== id) } : page), "Scale tile removed");
    }

    function move(index: number, direction: number) {
        const target = index + direction;
        if (target < 0 || target >= selectedIds.length) return;
        const next = [...selectedIds];
        [next[index], next[target]] = [next[target], next[index]];
        save(pages.map((page) => page.id === activePageId ? { ...page, productIds: next } : page), "Scale tile order saved");
    }

    function openAddPage() {
        pageDialogMode = "add";
        pageName = "";
        showPageDialog = true;
    }

    function openRenamePage() {
        if (!activePage) return;
        pageDialogMode = "rename";
        pageName = activePage.name;
        showPageDialog = true;
    }

    async function savePageDialog() {
        const name = pageName.trim();
        if (!name) {
            toast("Enter a page name", "error");
            return;
        }
        if (pageDialogMode === "add") {
            const page = { id: uuid(), name, color: "#10b981", productIds: [] };
            activePageId = page.id;
            await save([...pages, page], "Scale page added");
        } else {
            await save(pages.map((page) => page.id === activePageId ? { ...page, name } : page), "Scale page renamed");
        }
        showPageDialog = false;
    }

    function deletePage() {
        if (!activePage || pages.length <= 1) {
            toast("At least one Scale page is required", "error");
            return;
        }
        if (!window.confirm(`Delete the “${activePage.name}” Scale page? Products will not be deleted.`)) return;
        const next = pages.filter((page) => page.id !== activePageId);
        activePageId = next[0].id;
        save(next, "Scale page deleted");
    }
</script>

<MgmtPage title="Scale Tile Designer" backFallback="/design">
    <a slot="actions" href="/design" class="btn btn-secondary">Design Studio</a>

    <div class="scale-designer">
        <section class="designer-intro">
            <div>
                <span>Manual scale screen</span>
                <h2>Choose the weighable products cashiers see</h2>
                <p>Mark an item as “Weighable (Scale)” in Items first, then add and arrange it here.</p>
            </div>
            <strong>{selectedProducts.length} tiles</strong>
        </section>

        <section class="designer-panel">
            <div class="page-tabs">
                {#each pages as page}
                    <button class:active={page.id === activePageId} style="--page-color: {page.color}" on:click={() => activePageId = page.id}>
                        <i></i>{page.name}<small>{page.productIds.length}</small>
                    </button>
                {/each}
                <button class="add-page" on:click={openAddPage}>+ Add Page</button>
            </div>
            <div class="page-tools">
                <p>Classify products into pages such as Vegetables, Fruit, Meat, or Deli.</p>
                <div>
                    <button class="btn btn-secondary" on:click={openRenamePage}>Rename Page</button>
                    <button class="btn btn-danger" on:click={deletePage} disabled={pages.length <= 1}>Delete Page</button>
                </div>
            </div>
        </section>

        <section class="designer-panel">
            <div class="section-heading">
                <div><span>Current layout</span><h3>{activePage?.name || "Scale Tiles"}</h3></div>
                <small>Use the arrows to change their order.</small>
            </div>
            {#if selectedProducts.length}
                <div class="selected-grid">
                    {#each selectedProducts as product, index}
                        {#if product}
                            <article class="product-card" style="--product-color: {product.color || '#3b82f6'}">
                                <div class="product-position">{index + 1}</div>
                                <div class="product-body">
                                    <strong>{product.name}</strong>
                                    <span>{formatMoney(product.price)} / kg {product.scalePlu ? `· PLU ${product.scalePlu}` : ""}</span>
                                </div>
                                <div class="card-actions">
                                    <button on:click={() => move(index, -1)} disabled={index === 0} aria-label="Move earlier">&larr;</button>
                                    <button on:click={() => move(index, 1)} disabled={index === selectedProducts.length - 1} aria-label="Move later">&rarr;</button>
                                    <button class="remove" on:click={() => remove(product.id)}>Remove</button>
                                </div>
                            </article>
                        {/if}
                    {/each}
                </div>
            {:else}
                <div class="empty-state">This Scale page has no products yet. Add weighable products below.</div>
            {/if}
        </section>

        <section class="designer-panel">
            <div class="section-heading">
                <div><span>Available products</span><h3>Add a Scale Tile</h3></div>
                <input bind:value={search} placeholder="Search by name or PLU..." />
            </div>
            {#if availableProducts.length}
                <div class="available-grid">
                    {#each availableProducts as product}
                        <button class="available-card" on:click={() => add(product.id)}>
                            <i style="background: {product.color || '#3b82f6'}"></i>
                            <strong>{product.name}</strong>
                            <span>{formatMoney(product.price)} / kg</span>
                            <b>+ Add tile</b>
                        </button>
                    {/each}
                </div>
            {:else}
                <div class="empty-state">No other weighable products match this search.</div>
            {/if}
        </section>
    </div>
</MgmtPage>

{#if showPageDialog}
    <div class="modal-overlay" on:click={() => showPageDialog = false}>
        <form class="page-dialog" on:click|stopPropagation on:submit|preventDefault={savePageDialog}>
            <div class="modal-header">
                <div>
                    <span>{pageDialogMode === "add" ? "New classification" : "Edit classification"}</span>
                    <h3>{pageDialogMode === "add" ? "Add Scale Page" : "Rename Scale Page"}</h3>
                </div>
                <button type="button" class="modal-close" on:click={() => showPageDialog = false}>✕</button>
            </div>
            <label for="scale-page-name">Page name</label>
            <input id="scale-page-name" bind:value={pageName} placeholder="For example: Vegetables" autofocus />
            <p>Cashiers will use this tab to find the products assigned to it.</p>
            <div class="dialog-actions">
                <button type="button" class="btn btn-secondary" on:click={() => showPageDialog = false}>Cancel</button>
                <button type="submit" class="btn btn-primary">{pageDialogMode === "add" ? "Add Page" : "Save Name"}</button>
            </div>
        </form>
    </div>
{/if}

<style>
    .scale-designer { padding: 1rem; display: flex; flex-direction: column; gap: 1rem; background: radial-gradient(circle at top right, color-mix(in srgb, var(--success) 12%, transparent), transparent 32%); }
    .designer-intro, .designer-panel { border: 1px solid var(--border-flat); border-radius: 1rem; background: color-mix(in srgb, var(--bg-card) 94%, transparent); }
    .designer-intro { padding: 1.5rem; display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
    .designer-intro span, .section-heading span { color: var(--success); text-transform: uppercase; letter-spacing: .12em; font-size: .7rem; font-weight: 900; }
    .designer-intro h2 { margin: .25rem 0 .35rem; }
    .designer-intro p, .section-heading small { color: var(--text-muted); margin: 0; }
    .designer-intro strong { padding: .7rem 1rem; border-radius: 2rem; color: var(--success); background: color-mix(in srgb, var(--success) 14%, var(--bg-panel)); white-space: nowrap; }
    .designer-panel { padding: 1.25rem; }
    .page-tabs { display: flex; gap: .55rem; overflow-x: auto; padding-bottom: .35rem; }
    .page-tabs button { min-height: 46px; padding: 0 1rem; display: flex; align-items: center; gap: .5rem; white-space: nowrap; color: var(--text-main); font-weight: 800; border: 1px solid var(--border-flat); border-radius: .65rem; background: var(--bg-panel); }
    .page-tabs button i { width: .65rem; height: .65rem; border-radius: 50%; background: var(--page-color); }
    .page-tabs button small { min-width: 1.35rem; padding: .1rem .35rem; border-radius: 1rem; color: var(--text-muted); background: var(--bg-card); }
    .page-tabs button.active { border-color: var(--page-color); background: color-mix(in srgb, var(--page-color) 12%, var(--bg-panel)); }
    .page-tabs .add-page { color: var(--success); border-style: dashed; }
    .page-tools { margin-top: .8rem; display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
    .page-tools p { margin: 0; color: var(--text-muted); font-size: .85rem; }
    .page-tools div { display: flex; gap: .5rem; }
    .section-heading { display: flex; align-items: end; justify-content: space-between; gap: 1rem; margin-bottom: 1rem; }
    .section-heading h3 { margin: .2rem 0 0; }
    .section-heading input { max-width: 300px; }
    .selected-grid, .available-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: .8rem; }
    .product-card, .available-card { position: relative; overflow: hidden; border: 1px solid var(--border-flat); border-radius: .8rem; background: var(--bg-panel); color: var(--text-main); }
    .product-card { padding: 1rem; display: flex; flex-direction: column; gap: .8rem; }
    .product-card::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 5px; background: var(--product-color); }
    .product-position { color: var(--text-muted); font-weight: 900; }
    .product-body { display: flex; flex-direction: column; gap: .25rem; }
    .product-body span, .available-card span { color: var(--text-muted); font-size: .8rem; }
    .card-actions { display: flex; gap: .4rem; margin-top: auto; }
    .card-actions button { min-height: 34px; padding: 0 .7rem; border: 1px solid var(--border-flat); border-radius: .45rem; background: var(--bg-card); color: var(--text-main); }
    .card-actions button:disabled { opacity: .3; }
    .card-actions .remove { margin-left: auto; color: var(--danger); }
    .available-card { min-height: 145px; padding: 1rem; display: flex; flex-direction: column; align-items: flex-start; gap: .25rem; text-align: left; }
    .available-card:hover { border-color: var(--success); }
    .available-card i { width: 2rem; height: .3rem; border-radius: 1rem; margin-bottom: .6rem; }
    .available-card b { color: var(--success); margin-top: auto; }
    .empty-state { padding: 2rem; text-align: center; color: var(--text-muted); border: 1px dashed var(--border-flat); border-radius: .8rem; }
    .page-dialog { width: min(440px, 95vw); padding: 1.25rem; display: flex; flex-direction: column; gap: .8rem; border: 1px solid var(--border-flat); border-radius: 1rem; background: var(--bg-panel); box-shadow: 0 24px 70px var(--shadow); }
    .page-dialog .modal-header span { color: var(--success); font-size: .68rem; font-weight: 900; letter-spacing: .12em; text-transform: uppercase; }
    .page-dialog .modal-header h3 { margin-top: .2rem; }
    .page-dialog label { color: var(--text-muted); font-size: .8rem; font-weight: 800; }
    .page-dialog input { padding: .85rem 1rem; font-size: 1rem; }
    .page-dialog p { margin: 0; color: var(--text-muted); font-size: .8rem; }
    .dialog-actions { margin-top: .5rem; display: flex; justify-content: flex-end; gap: .5rem; }
    @media (max-width: 700px) { .designer-intro, .section-heading, .page-tools { align-items: stretch; flex-direction: column; } .section-heading input { max-width: none; } }
</style>
