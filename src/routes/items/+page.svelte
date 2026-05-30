<script lang="ts">
    import {
        productsDB,
        categoriesDB,
        taxRatesDB,
        type Product,
        uuid,
        now,
        toPence,
        toPounds,
        formatMoney,
    } from "$lib/stores/db";
    import { toast } from "$lib/stores/toast";
    import {
        addProduct,
        updateProduct,
        deleteProduct,
        batchUpdateGoodsMenu,
    } from "$lib/stores/database";
    import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
    import CustomSelect from "$lib/components/CustomSelect.svelte";
    import TouchToggle from "$lib/components/TouchToggle.svelte";
    import TouchColorPicker from "$lib/components/TouchColorPicker.svelte";

    let showModal = false;
    let isEditing = false;
    let showGoodsMenu = false;
    let goodsMenuDraft: Product[] = [];
    let goodsMenuSearch = "";

    $: goodsMenuCount = $productsDB.filter((p) => p.showInGoods).length;
    $: availableGoodsDraft = goodsMenuDraft
        .filter((p) => !p.showInGoods)
        .filter((p) => p.name.toLowerCase().includes(goodsMenuSearch.toLowerCase()))
        .slice(0, 100);



    let currentItem: Partial<Product> = {};
    let searchQuery = "";
    let selectedCategoryId = "all";

    // Numpad for Price Input
    let showPricePad = false;
    let priceString = "";

    $: filteredItems = $productsDB.filter((p) => {
        const matchesActive = p.isActive;
        const matchesSearch =
            p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            p.sku.toLowerCase().includes(searchQuery.toLowerCase()) ||
            (p.barcode &&
                p.barcode.toLowerCase().includes(searchQuery.toLowerCase()));
        const matchesCategory =
            selectedCategoryId === "all" || p.categoryId === selectedCategoryId;
        return matchesActive && matchesSearch && matchesCategory;
    });

    function openAddModal() {
        const cats = $categoriesDB;
        const taxes = $taxRatesDB;
        currentItem = {
            id: uuid(),
            name: "",
            price: 0,
            costPrice: 0,
            sku: "",
            barcode: "",
            categoryId: cats.length > 0 ? cats[0].id : "",
            taxRateId:
                taxes.find((t) => t.isDefault)?.id ||
                (taxes.length > 0 ? taxes[0].id : ""),
            trackStock: true,
            showInGoods: false,
            goodsSortOrder: 0,
            isWeighable: false,
            color: "#3b82f6",
            image: "",
            isActive: true,
            createdAt: now(),
            updatedAt: now(),
        };
        priceString = "0";
        isEditing = false;
        showModal = true;
    }

    function openEditModal(item: Product) {
        currentItem = { ...item };
        priceString = item.price.toString();
        isEditing = true;
        showModal = true;
    }

    const PALETTE = [
        "#ef4444", "#f97316", "#f59e0b", "#22c55e",
        "#0ea5e9", "#6366f1", "#a855f7", "#ec4899",
    ];

    function randomColor() {
        return PALETTE[Math.floor(Math.random() * PALETTE.length)];
    }

    function saveItem() {
        const missing: string[] = [];
        if (!currentItem.name?.trim()) missing.push("Item Name");
        if ((currentItem.price || 0) <= 0) missing.push("Selling Price");
        if (!currentItem.categoryId) missing.push("Category");
        if (missing.length > 0) {
            toast(`Required: ${missing.join(", ")}`, "error");
            return;
        }

        if (!isEditing) {
            currentItem.color = randomColor();
        }
        currentItem.updatedAt = now();

        productsDB.update((items) => {
            if (isEditing) {
                updateProduct(currentItem);
                return items.map((i) =>
                    i.id === currentItem.id ? (currentItem as Product) : i,
                );
            } else {
                addProduct(currentItem);
                return [...items, currentItem as Product];
            }
        });
        showModal = false;
        toast(isEditing ? "Item updated" : "Item added");
    }

    let showDelConfirm = false;
    let idToDelete = "";
    function deleteItem(id: string) {
        idToDelete = id;
        showDelConfirm = true;
    }
    function confirmDeactivate() {
        const id = idToDelete;
        productsDB.update((items) =>
            items.map((i) =>
                i.id === id
                    ? { ...i, isActive: false, updatedAt: now() }
                    : i,
            ),
        );
        deleteProduct(id);
        toast("Item deactivated", "info");
        showDelConfirm = false;
    }

    function handlePricePadKey(key: string) {
        if (key === "C") {
            priceString = "0";
        } else if (key === "ENTER") {
            currentItem.price = parseInt(priceString) || 0;
            showPricePad = false;
        } else if (key === "00") {
            if (priceString !== "0") priceString += "00";
        } else {
            if (priceString === "0") priceString = key;
            else priceString += key;
        }
        currentItem.price = parseInt(priceString) || 0;
    }

    function getCategoryName(id: string): string {
        return $categoriesDB.find((c) => c.id === id)?.name || "Unknown";
    }

    function getTaxName(id: string): string {
        return $taxRatesDB.find((t) => t.id === id)?.name || "-";
    }

    function openGoodsMenu() {
        goodsMenuDraft = $productsDB
            .filter((p) => p.isActive)
            .map((p) => ({ ...p }))
            .sort((a, b) => a.name.localeCompare(b.name));
        goodsMenuSearch = "";
        showGoodsMenu = true;
    }

    function toggleGoodsMenuItem(item: Product) {
        if (item.showInGoods) {
            item.showInGoods = false;
            item.goodsSortOrder = 0;
        } else {
            const selected = goodsMenuDraft.filter((p) => p.showInGoods);
            if (selected.length >= 10) {
                toast("Maximum 10 items allowed in Goods Menu", "error");
                return;
            }
            item.showInGoods = true;
            item.goodsSortOrder = selected.length + 1;
        }
        goodsMenuDraft = [...goodsMenuDraft];
    }

    function moveGoodsMenuItem(idx: number, dir: number) {
        const selected = goodsMenuDraft.filter((p) => p.showInGoods).sort((a, b) => (a.goodsSortOrder || 0) - (b.goodsSortOrder || 0));
        const j = idx + dir;
        if (j < 0 || j >= selected.length) return;
        const next = [...selected];
        [next[idx], next[j]] = [next[j], next[idx]];
        next.forEach((p, i) => {
            const draft = goodsMenuDraft.find((d) => d.id === p.id);
            if (draft) draft.goodsSortOrder = i + 1;
        });
        goodsMenuDraft = [...goodsMenuDraft];
    }

    function saveGoodsMenu() {
        // Build a lookup map once — O(n) instead of O(n²)
        const originalMap = new Map($productsDB.map((p) => [p.id, p]));

        const changes = goodsMenuDraft
            .filter((draft) => {
                const orig = originalMap.get(draft.id);
                return orig && (orig.showInGoods !== draft.showInGoods || orig.goodsSortOrder !== draft.goodsSortOrder);
            })
            .map((draft) => ({
                id: draft.id,
                showInGoods: draft.showInGoods,
                goodsSortOrder: draft.goodsSortOrder,
                updatedAt: now(),
            }));

        if (changes.length === 0) {
            showGoodsMenu = false;
            toast("No changes to save");
            return;
        }

        // Single SQLite transaction for all changes
        batchUpdateGoodsMenu(changes);

        // Single-pass store update
        const changeMap = new Map(changes.map((c) => [c.id, c]));
        productsDB.update((items) =>
            items.map((i) => {
                const ch = changeMap.get(i.id);
                if (!ch) return i;
                return { ...i, showInGoods: ch.showInGoods, goodsSortOrder: ch.goodsSortOrder, updatedAt: ch.updatedAt };
            }),
        );

        showGoodsMenu = false;
        toast(`Goods Menu updated (${changes.length} items)`);
    }
</script>

<div class="p-6 h-screen flex flex-col overflow-hidden">
    <header class="flex justify-between items-center mb-6 gap-5">
        <div class="flex items-center gap-4">
            <a href="/" class="btn-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20"
                    ><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
            </a>
            <h1 class="text-[1.8rem] m-0">Item Management</h1>
        </div>
        <div class="flex items-center gap-4 flex-1 justify-end">
            <div class="flex gap-3 flex-1 max-w-[600px]">
                <div class="relative flex-1">
                    <svg class="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18"
                        ><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                    <input
                        class="w-full py-2.5 pr-3 pl-10 bg-bg-card border border-border-flat rounded-sm text-text-main text-[0.9rem] outline-none focus:border-accent-primary"
                        type="text"
                        bind:value={searchQuery}
                        placeholder="Search items..."
                    />
                </div>
                <div class="min-w-[200px]">
                    <CustomSelect
                        bind:value={selectedCategoryId}
                        options={[{label: 'All Categories', value: 'all'}, ...$categoriesDB.filter(c => c.isActive).map(c => ({label: c.name, value: c.id}))]}
                    />
                </div>
            </div>
            <button class="btn btn-primary" on:click={openAddModal}>+ Add Item</button>
            <button class="btn btn-secondary" on:click={openGoodsMenu}>
                Goods Menu ({goodsMenuCount}/10)
            </button>
        </div>
    </header>

    <div class="flat-panel flex-1 overflow-y-auto rounded-md p-px">
        <table class="tbl">
            <thead>
                <tr>
                    <th>Color</th>
                    <th>Name</th>
                    <th>SKU</th>
                    <th>Barcode</th>
                    <th>Category</th>
                    <th>Tax</th>
                    <th>Stock</th>
                    <th>Cost</th>
                    <th>Price</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody>
                {#each filteredItems.slice(0, 100) as item}
                    <tr>
                        <td>
                            <div class="swatch" style="background-color: {item.color || '#3b82f6'}"></div>
                        </td>
                        <td class="font-semibold">{item.name}</td>
                        <td class="mono">{item.sku}</td>
                        <td class="mono">{item.barcode || "-"}</td>
                        <td><span class="tag">{getCategoryName(item.categoryId)}</span></td>
                        <td class="text-[0.8rem] text-text-muted">{getTaxName(item.taxRateId)}</td>
                        <td>{item.trackStock ? item.stockLevel : "∞"}</td>
                        <td>{item.costPrice > 0 ? formatMoney(item.costPrice) : "-"}</td>
                        <td class="money">{formatMoney(item.price)}</td>
                        <td>
                            <div class="act-row">
                                <button class="btn-icon act-btn" on:click={() => openEditModal(item)}>
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16"
                                        ><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                                </button>
                                <button class="btn-icon act-btn danger" on:click={() => deleteItem(item.id)}>
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16"
                                        ><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                                </button>
                            </div>
                        </td>
                    </tr>
                {/each}
                {#if filteredItems.length > 100}
                    <tr>
                        <td colspan="10" class="text-center !p-4 bg-bg-panel text-accent-primary font-semibold text-[0.9rem]">
                            Showing first 100 items. Use search to find specific items.
                        </td>
                    </tr>
                {/if}
                {#if filteredItems.length === 0}
                    <tr class="empty-row">
                        <td colspan="10">
                            {#if searchQuery || selectedCategoryId !== "all"}
                                No items match your search filters.
                            {:else}
                                No items found. Add your first item!
                            {/if}
                        </td>
                    </tr>
                {/if}
            </tbody>
        </table>
    </div>
</div>

{#if showModal}
    <div
        class="modal-overlay"
        on:click={() => {
            showModal = false;
            showPricePad = false;
        }}
    >
        <div class="flat-panel w-full max-w-[640px] rounded-md flex flex-col gap-0 bg-bg-card max-h-[90vh] overflow-hidden" on:click|stopPropagation>
            <div class="flex justify-between items-center border-b border-border-flat p-4 shrink-0">
                <h2>{isEditing ? "Edit Item" : "Add New Item"}</h2>
                <button
                    class="btn-icon"
                    on:click={() => {
                        showModal = false;
                        showPricePad = false;
                    }}>✕</button
                >
            </div>

            <div class="form-grid overflow-y-auto p-4">
                <div class="field span-2">
                    <label for="name">Item Name *</label>
                    <input type="text" id="name" bind:value={currentItem.name} placeholder="e.g. Coca Cola" />
                </div>

                <div class="field">
                    <label for="sku">SKU</label>
                    <input type="text" id="sku" bind:value={currentItem.sku} placeholder="Stock Keeping Unit" />
                </div>

                <div class="field">
                    <label for="barcode">Barcode</label>
                    <input type="text" id="barcode" bind:value={currentItem.barcode} placeholder="Scan or type barcode" />
                </div>

                <div class="field">
                    <label for="price">Selling Price (£) *</label>
                    <div
                        class="bg-bg-panel border border-border-flat rounded-sm px-3 py-2.5 flex justify-between items-center cursor-pointer text-[1.1rem] font-serif text-success hover:border-accent-primary"
                        on:click={() => (showPricePad = true)}
                    >
                        <span>{formatMoney(currentItem.price || 0)}</span>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16"
                            ><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line></svg>
                    </div>
                </div>

                <div class="field">
                    <CustomSelect
                        label="Category *"
                        bind:value={currentItem.categoryId}
                        options={$categoriesDB.filter(c => c.isActive).map(c => ({label: c.name, value: c.id}))}
                    />
                </div>

                <div class="field">
                    <CustomSelect
                        label="Tax Rate"
                        bind:value={currentItem.taxRateId}
                        options={$taxRatesDB.map(t => ({label: t.name, value: t.id}))}
                    />
                </div>

                <div class="field">
                    <label for="cost">Cost Price (£)</label>
                    <input
                        type="number"
                        id="cost"
                        value={toPounds(currentItem.costPrice || 0)}
                        on:change={(e) =>
                            (currentItem.costPrice = toPence(
                                parseFloat(e.currentTarget.value) || 0,
                            ))}
                        step="0.01"
                        min="0"
                        placeholder="0.00"
                    />
                </div>

                <div class="field">
                    <label for="stock" class="{currentItem.trackStock ? '' : 'opacity-40'}">Stock Level</label>
                    <input type="number" id="stock" bind:value={currentItem.stockLevel} placeholder="0" disabled={!currentItem.trackStock} class={!currentItem.trackStock ? 'opacity-40 cursor-not-allowed' : ''} />
                </div>

                <div class="field"><TouchToggle bind:checked={currentItem.trackStock} label="Track Stock" /></div>
                <div class="field"><TouchToggle bind:checked={currentItem.showInGoods} label="Show in Goods Menu" /></div>
                <div class="field"><TouchToggle bind:checked={currentItem.isWeighable} label="Weighable (Scale)" /></div>
            </div>

            <div class="flex justify-end gap-3 p-4 border-t border-border-flat shrink-0 bg-bg-card">
                <button class="btn btn-danger" on:click={() => (showModal = false)}>Cancel</button>
                <button class="btn btn-primary" on:click={saveItem}>Save Item</button>
            </div>
        </div>
    </div>

    {#if showPricePad}
        <div
            class="modal-overlay !z-[110]"
            on:click={() => (showPricePad = false)}
        >
            <div class="flat-panel w-[320px] p-6 rounded-md flex flex-col gap-4 bg-bg-card" on:click|stopPropagation>
                <div class="modal-header">
                    <h3>Enter Price</h3>
                    <button class="modal-close" on:click={() => (showPricePad = false)}>✕</button>
                </div>
                <div class="flat-card h-[60px] flex items-center justify-end px-4 text-[2rem] font-bold font-serif text-success">
                    {formatMoney(parseInt(priceString || "0"))}
                </div>
                <div class="grid grid-cols-3 gap-3">
                    {#each ["1", "2", "3", "4", "5", "6", "7", "8", "9", "00", "0", "C", "ENTER"] as key}
                        <button
                            class="flat-card h-[60px] text-[1.5rem] font-semibold cursor-pointer text-text-main {key === 'ENTER' ? '!bg-success !text-white col-span-3' : ''} {key === 'C' ? '!text-danger' : ''}"
                            on:click={() => handlePricePadKey(key)}
                        >
                            {key}
                        </button>
                    {/each}
                </div>
            </div>
        </div>
    {/if}
{/if}

{#if showGoodsMenu}
    <div class="modal-overlay" on:click={() => (showGoodsMenu = false)}>
        <div
            class="flat-panel w-full max-w-[800px] p-6 rounded-md flex flex-col gap-4 bg-bg-card max-h-[90vh] overflow-hidden"
            on:click|stopPropagation
        >
            <div class="flex justify-between items-center border-b border-border-flat pb-4 shrink-0">
                <h2>Goods Menu Manager</h2>
                <button class="btn-icon" on:click={() => (showGoodsMenu = false)}>✕</button>
            </div>
            <p class="text-text-muted shrink-0">
                Select up to 10 active items to appear in the Goods menu.
                <strong class="text-text-main">Selected: {goodsMenuDraft.filter((p) => p.showInGoods).length}/10</strong>
            </p>
            <div class="grid grid-cols-2 gap-4 flex-1 min-h-0 overflow-hidden">
                <div class="flex flex-col gap-2 h-full">
                    <h3 class="font-semibold text-sm uppercase tracking-wider text-text-muted shrink-0">Available Items</h3>
                    <input
                        type="text"
                        class="w-full h-10 px-3 bg-bg-panel border border-border-flat rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-accent-primary shrink-0"
                        placeholder="Search items..."
                        bind:value={goodsMenuSearch}
                    />
                    <div class="flex-1 overflow-y-auto flex flex-col gap-1 min-h-0">
                        {#each availableGoodsDraft as item}
                            <button
                                class="flex items-center gap-3 p-3 bg-bg-card border border-border-flat rounded-sm text-left hover:bg-bg-card-hover transition-colors disabled:opacity-50 shrink-0"
                                disabled={goodsMenuDraft.filter((p) => p.showInGoods).length >= 10}
                                on:click={() => toggleGoodsMenuItem(item)}
                            >
                                <div class="w-4 h-4 rounded border border-border-flat shrink-0 {goodsMenuDraft.filter((p) => p.showInGoods).length >= 10 ? '' : 'hover:border-accent-primary'}"></div>
                                <span class="flex-1 font-medium">{item.name}</span>
                                <span class="text-text-muted text-xs">{getCategoryName(item.categoryId)}</span>
                            </button>
                        {/each}
                        {#if goodsMenuDraft.filter((p) => !p.showInGoods && p.name.toLowerCase().includes(goodsMenuSearch.toLowerCase())).length > 100}
                            <p class="text-center text-text-muted p-2 text-xs shrink-0">Showing first 100 matches. Use search to narrow results.</p>
                        {/if}
                    </div>
                </div>
                <div class="flex flex-col gap-2 h-full">
                    <h3 class="font-semibold text-sm uppercase tracking-wider text-text-muted shrink-0">Selected Order</h3>
                    <div class="flex-1 overflow-y-auto flex flex-col gap-1 min-h-0">
                        {#each goodsMenuDraft.filter((p) => p.showInGoods).sort((a, b) => (a.goodsSortOrder || 0) - (b.goodsSortOrder || 0)) as item, i}
                            <div class="flex items-center gap-2 p-3 bg-bg-card border border-border-flat rounded-sm shrink-0">
                                <span class="text-text-muted font-mono w-6">{i + 1}</span>
                                <div class="w-3 h-3 rounded-full shrink-0" style="background-color: {item.color || '#6366f1'}"></div>
                                <span class="flex-1 font-medium">{item.name}</span>
                                <button
                                    class="w-8 h-8 rounded-md bg-bg-panel border border-border-flat hover:bg-bg-card-hover transition-colors flex items-center justify-center disabled:opacity-30"
                                    disabled={i === 0}
                                    on:click={() => moveGoodsMenuItem(i, -1)}>↑</button
                                >
                                <button
                                    class="w-8 h-8 rounded-md bg-bg-panel border border-border-flat hover:bg-bg-card-hover transition-colors flex items-center justify-center disabled:opacity-30"
                                    disabled={i === goodsMenuDraft.filter((p) => p.showInGoods).length - 1}
                                    on:click={() => moveGoodsMenuItem(i, 1)}>↓</button
                                >
                                <button
                                    class="w-8 h-8 rounded-md bg-danger/10 border border-danger/30 text-danger hover:bg-danger hover:text-white transition-colors flex items-center justify-center"
                                    on:click={() => toggleGoodsMenuItem(item)}>✕</button
                                >
                            </div>
                        {/each}
                        {#if goodsMenuDraft.filter((p) => p.showInGoods).length === 0}
                            <p class="text-center text-text-muted p-4 text-sm shrink-0">No items selected.</p>
                        {/if}
                    </div>
                </div>
            </div>
            <div class="flex justify-end gap-3 pt-4 border-t border-border-flat shrink-0">
                <button class="btn btn-danger" on:click={() => (showGoodsMenu = false)}>Cancel</button>
                <button class="btn btn-primary" on:click={saveGoodsMenu}>Save Goods Menu</button>
            </div>
        </div>
    </div>
{/if}

<ConfirmDialog
    bind:show={showDelConfirm} 
    title="Deactivate Item" 
    message="Are you sure you want to deactivate this item?"
    variant="danger"
    on:confirm={confirmDeactivate}
/>

