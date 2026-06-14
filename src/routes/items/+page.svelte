<script lang="ts">
    import {
        productsDB,
        tilesDB,
        categoriesDB,
        taxRatesDB,
        settingsDB,
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
        updateProductFields,
        setStockLevel,
        removeProductTiles,
        deleteProduct,
        batchUpdateGoodsMenu,
    } from "$lib/stores/database";
    import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
    import CustomSelect from "$lib/components/CustomSelect.svelte";
    import TouchToggle from "$lib/components/TouchToggle.svelte";
    import TouchColorPicker from "$lib/components/TouchColorPicker.svelte";
    import { getBarcodeRules } from "$lib/barcodeRules";
    import { goBack } from "$lib/navigation";

    let showModal = false;
    let isEditing = false;
    let showGoodsMenu = false;
    let goodsMenuDraft: Product[] = [];
    let goodsMenuSearch = "";
    $: stockTrackingEnabled = ($settingsDB.find((setting) => setting.key === "stock_tracking_enabled")?.value ?? "true") !== "false";

    $: goodsMenuCount = $productsDB.filter((p) => p.isActive && p.showInPos !== false && p.showInGoods).length;
    $: availableGoodsDraft = goodsMenuDraft
        .filter((p) => !p.showInGoods)
        .filter((p) => p.name.toLowerCase().includes(goodsMenuSearch.toLowerCase()))
        .slice(0, 100);



    let currentItem: Partial<Product> = {};
    let originalItem: Product | null = null;
    let searchQuery = "";
    let selectedCategoryId = "all";
    let selectedStatus: "active" | "deactivated" | "all" = "active";
    const ITEMS_PER_PAGE = 50;
    let itemPage = 0;
    let previousFilterKey = "";
    let selectedPluLength = 5;
    $: configuredPluLengths = [...new Set(getBarcodeRules($settingsDB)
        .filter((rule) => rule.enabled)
        .map((rule) => rule.productLength))].sort((a, b) => a - b);
    $: itemCategoryOptions = [
        ...(!$categoriesDB.some(c => c.isActive && c.id === currentItem.categoryId) && currentItem.categoryId
            ? [{ label: `${getCategoryName(currentItem.categoryId)} (Inactive)`, value: currentItem.categoryId }]
            : []),
        ...$categoriesDB.filter(c => c.isActive).map(c => ({ label: c.name, value: c.id })),
    ];

    // Numpad for Price Input
    let showPricePad = false;
    let priceString = "";

    $: filteredItems = $productsDB.filter((p) => {
        const matchesStatus = selectedStatus === "all"
            || (selectedStatus === "active" && p.isActive)
            || (selectedStatus === "deactivated" && !p.isActive);
        const matchesSearch =
            p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            (p.sku || "").toLowerCase().includes(searchQuery.toLowerCase()) ||
            (p.scalePlu &&
                p.scalePlu.toLowerCase().includes(searchQuery.toLowerCase())) ||
            (p.barcode &&
                p.barcode.toLowerCase().includes(searchQuery.toLowerCase()));
        const matchesCategory =
            selectedCategoryId === "all" || p.categoryId === selectedCategoryId;
        return matchesStatus && matchesSearch && matchesCategory;
    });
    $: itemPageCount = Math.max(1, Math.ceil(filteredItems.length / ITEMS_PER_PAGE));
    $: if (itemPage >= itemPageCount) itemPage = itemPageCount - 1;
    $: pagedItems = filteredItems.slice(
        itemPage * ITEMS_PER_PAGE,
        (itemPage + 1) * ITEMS_PER_PAGE,
    );
    $: {
        const filterKey = `${searchQuery}|${selectedCategoryId}|${selectedStatus}`;
        if (filterKey !== previousFilterKey) {
            previousFilterKey = filterKey;
            itemPage = 0;
        }
    }

    function openAddModal() {
        const cats = $categoriesDB.filter((category) => category.isActive);
        const taxes = $taxRatesDB;
        currentItem = {
            id: uuid(),
            name: "",
            price: 0,
            costPrice: 0,
            stockLevel: 0,
            sku: "",
            barcode: "",
            scalePlu: "",
            categoryId: cats.length > 0 ? cats[0].id : "",
            taxRateId:
                taxes.find((t) => t.isDefault)?.id ||
                (taxes.length > 0 ? taxes[0].id : ""),
            trackStock: stockTrackingEnabled,
            allowPriceOverride: false,
            showInGoods: false,
            goodsSortOrder: 0,
            showInPos: true,
            isWeighable: false,
            color: "#3b82f6",
            image: "",
            isActive: true,
            createdAt: now(),
            updatedAt: now(),
        };
        priceString = "0";
        selectedPluLength = configuredPluLengths[0] || 5;
        isEditing = false;
        originalItem = null;
        showModal = true;
    }

    function openEditModal(item: Product) {
        currentItem = { ...item };
        originalItem = { ...item };
        priceString = item.price.toString();
        selectedPluLength = item.scalePlu?.length || configuredPluLengths[0] || 5;
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

    function generateScalePlu() {
        const length = selectedPluLength || configuredPluLengths[0] || 5;
        const maximum = 10 ** length - 1;
        const used = new Set(
            $productsDB
                .filter((item) => item.id !== currentItem.id && item.scalePlu)
                .map((item) => item.scalePlu!),
        );
        for (let number = 1; number <= maximum; number++) {
            const candidate = String(number).padStart(length, "0");
            if (!used.has(candidate)) {
                currentItem.scalePlu = candidate;
                currentItem = { ...currentItem };
                toast(`Generated unique PLU ${candidate}`, "success");
                return;
            }
        }
        toast(`No unused ${length}-digit PLU is available`, "error");
    }

    async function saveItem() {
        const missing: string[] = [];
        if (!currentItem.name?.trim()) missing.push("Item Name");
        if ((currentItem.price || 0) <= 0) missing.push("Selling Price");
        if (!currentItem.categoryId) missing.push("Category");
        if (missing.length > 0) {
            toast(`Required: ${missing.join(", ")}`, "error");
            return;
        }
        currentItem.name = currentItem.name?.trim();
        currentItem.sku = currentItem.sku?.trim() || "";
        currentItem.barcode = currentItem.barcode?.trim() || "";
        currentItem.scalePlu = currentItem.scalePlu?.trim() || "";
        if ((currentItem.costPrice || 0) < 0) {
            toast("Cost Price cannot be negative", "error");
            return;
        }
        const duplicateSku = $productsDB.find(
            (item) => item.id !== currentItem.id && currentItem.sku && item.sku?.trim() === currentItem.sku,
        );
        if (duplicateSku) {
            toast(`SKU is already used by ${duplicateSku.name}`, "error");
            return;
        }
        const duplicateBarcode = $productsDB.find(
            (item) => item.id !== currentItem.id && item.barcode === currentItem.barcode,
        );
        if (currentItem.barcode && duplicateBarcode) {
            toast(`Barcode is already used by ${duplicateBarcode.name}`, "error");
            return;
        }
        if (currentItem.scalePlu && !/^\d+$/.test(currentItem.scalePlu)) {
            toast("Scale PLU must contain digits only", "error");
            return;
        }
        if (currentItem.scalePlu && configuredPluLengths.length > 0 && !configuredPluLengths.includes(currentItem.scalePlu.length)) {
            toast(`Scale PLU must contain ${configuredPluLengths.join(" or ")} digits to match the enabled barcode rules`, "error");
            return;
        }
        const duplicateScalePlu = $productsDB.find(
            (item) => item.id !== currentItem.id && item.isActive && item.scalePlu === currentItem.scalePlu,
        );
        if (currentItem.scalePlu && duplicateScalePlu) {
            toast(`Scale PLU is already used by ${duplicateScalePlu.name}`, "error");
            return;
        }
        const wasInGoods = originalItem?.showInGoods ?? false;
        if (currentItem.showInPos === false) currentItem.showInGoods = false;
        if (currentItem.showInGoods && !wasInGoods && goodsMenuCount >= 10) {
            toast("Goods Menu already contains the maximum 10 items", "error");
            return;
        }
        if (currentItem.showInGoods && !wasInGoods) {
            currentItem.goodsSortOrder = Math.max(
                0,
                ...$productsDB.filter((item) => item.isActive && item.showInGoods).map((item) => item.goodsSortOrder || 0),
            ) + 1;
        } else if (!currentItem.showInGoods) {
            currentItem.goodsSortOrder = 0;
        }

        if (!isEditing) {
            currentItem.color = randomColor();
        }
        currentItem.updatedAt = now();

        try {
            if (isEditing) {
                const desiredStock = currentItem.stockLevel ?? originalItem?.stockLevel ?? 0;
                const { stockLevel: _stockLevel, createdAt: _createdAt, ...productPatch } = currentItem;
                const { stockLevel: _originalStock, createdAt: _originalCreatedAt, ...expectedProduct } = originalItem || {};
                await updateProductFields(productPatch, expectedProduct);
                if (desiredStock !== originalItem?.stockLevel && currentItem.id) {
                    await setStockLevel(currentItem.id, desiredStock, originalItem?.stockLevel ?? desiredStock);
                }
                if (originalItem?.showInPos !== false && currentItem.showInPos === false && currentItem.id) {
                    await removeProductTiles(currentItem.id);
                    tilesDB.update((tiles) => tiles.filter((tile) => tile.productId !== currentItem.id));
                }
                productsDB.update((items) => items.map((item) =>
                    item.id === currentItem.id
                        ? { ...item, ...productPatch, stockLevel: desiredStock } as Product
                        : item,
                ));
            } else {
                await addProduct(currentItem);
                productsDB.update((items) => [...items, currentItem as Product]);
            }
            showModal = false;
            toast(isEditing ? "Item updated" : "Item added");
        } catch (error) {
            toast(String(error).replace(/^Error:\s*/, ""), "error");
        }
    }

    let showDelConfirm = false;
    let idToDelete = "";
    function deleteItem(id: string) {
        idToDelete = id;
        showDelConfirm = true;
    }
    async function confirmDeactivate() {
        const id = idToDelete;
        try {
            await deleteProduct(id);
            productsDB.update((items) =>
                items.map((i) =>
                    i.id === id
                        ? { ...i, isActive: false, showInGoods: false, goodsSortOrder: 0, updatedAt: now() }
                        : i,
                ),
            );
            tilesDB.update((tiles) => tiles.filter((tile) => tile.productId !== id));
            toast("Item deactivated", "info");
            showDelConfirm = false;
        } catch (error) {
            toast(`Could not deactivate item: ${String(error).replace(/^Error:\s*/, "")}`, "error");
        }
    }

    async function reactivateItem(item: Product) {
        try {
            const stamp = now();
            await updateProductFields(
                { id: item.id, isActive: true, updatedAt: stamp },
                { isActive: item.isActive },
            );
            productsDB.update((items) => items.map((existing) =>
                existing.id === item.id ? { ...existing, isActive: true, updatedAt: stamp } : existing
            ));
            toast(`${item.name} reactivated`, "success");
        } catch (error) {
            toast(`Could not reactivate item: ${String(error).replace(/^Error:\s*/, "")}`, "error");
        }
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
            .filter((p) => p.isActive && p.showInPos !== false)
            .map((p) => ({ ...p }))
            .sort((a, b) => a.name.localeCompare(b.name));
        normalizeGoodsMenuOrder();
        goodsMenuSearch = "";
        showGoodsMenu = true;
    }

    function normalizeGoodsMenuOrder() {
        const selected = goodsMenuDraft
            .filter((p) => p.showInGoods)
            .sort((a, b) => {
                const aOrder = a.goodsSortOrder || Number.MAX_SAFE_INTEGER;
                const bOrder = b.goodsSortOrder || Number.MAX_SAFE_INTEGER;
                return aOrder - bOrder || a.name.localeCompare(b.name);
            });
        selected.forEach((item, index) => (item.goodsSortOrder = index + 1));
        goodsMenuDraft
            .filter((p) => !p.showInGoods)
            .forEach((item) => (item.goodsSortOrder = 0));
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
        normalizeGoodsMenuOrder();
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

    async function saveGoodsMenu() {
        normalizeGoodsMenuOrder();
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

        try {
            await batchUpdateGoodsMenu(changes);
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
        } catch (error) {
            toast(`Could not save Goods Menu: ${String(error).replace(/^Error:\s*/, "")}`, "error");
        }
    }
</script>

<div class="items-management-page p-6 h-screen flex flex-col overflow-hidden">
    <header class="items-management-header flex justify-between items-center mb-6 gap-5">
        <div class="flex items-center gap-4">
            <button type="button" class="btn-icon" aria-label="Go back" on:click={() => goBack('/')}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20"
                    ><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
            </button>
            <h1 class="text-[1.8rem] m-0">Item Management</h1>
        </div>
        <div class="flex items-center gap-4 flex-1 justify-end">
            <div class="flex gap-3 flex-1 max-w-[820px]">
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
                <div class="min-w-[170px]">
                    <CustomSelect
                        bind:value={selectedStatus}
                        options={[
                            { label: 'Active Items', value: 'active' },
                            { label: 'Deactivated Items', value: 'deactivated' },
                            { label: 'All Items', value: 'all' },
                        ]}
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
                    <th>Status</th>
                    <th>SKU</th>
                    <th>Barcode</th>
                    <th>PLU</th>
                    <th>Category</th>
                    <th>Tax</th>
                    {#if stockTrackingEnabled}<th>Stock</th>{/if}
                    <th>Cost</th>
                    <th>Price</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody>
                {#each pagedItems as item}
                    <tr>
                        <td>
                            <div class="swatch" style="background-color: {item.color || '#3b82f6'}"></div>
                        </td>
                        <td class="font-semibold">{item.name}</td>
                        <td>
                            <span class="tag {item.isActive ? '!text-success' : '!text-danger'}">
                                {item.isActive ? "Active" : "Deactivated"}
                            </span>
                        </td>
                        <td class="mono">{item.sku}</td>
                        <td class="mono">{item.barcode || "-"}</td>
                        <td class="mono">{item.scalePlu || "-"}</td>
                        <td><span class="tag">{getCategoryName(item.categoryId)}</span></td>
                        <td class="text-[0.8rem] text-text-muted">{getTaxName(item.taxRateId)}</td>
                        {#if stockTrackingEnabled}<td>{item.trackStock ? item.stockLevel : "Not tracked"}</td>{/if}
                        <td>{item.costPrice > 0 ? formatMoney(item.costPrice) : "-"}</td>
                        <td class="money">{formatMoney(item.price)}</td>
                        <td>
                            <div class="act-row">
                                <button class="btn-icon act-btn" on:click={() => openEditModal(item)}>
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16"
                                        ><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                                </button>
                                {#if item.isActive}
                                    <button class="btn-icon act-btn danger" title="Deactivate item" on:click={() => deleteItem(item.id)}>
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16"
                                            ><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                                    </button>
                                {:else}
                                    <button class="btn-icon act-btn !text-success" title="Reactivate item" on:click={() => reactivateItem(item)}>
                                        ↻
                                    </button>
                                {/if}
                            </div>
                        </td>
                    </tr>
                {/each}
                {#if filteredItems.length === 0}
                    <tr class="empty-row">
                        <td colspan={stockTrackingEnabled ? 12 : 11}>
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
    {#if filteredItems.length > 0}
        <div class="flex items-center justify-between gap-3 pt-3 shrink-0">
            <span class="text-sm text-text-muted">
                Showing {itemPage * ITEMS_PER_PAGE + 1}-{Math.min((itemPage + 1) * ITEMS_PER_PAGE, filteredItems.length)} of {filteredItems.length}
            </span>
            <div class="flex items-center gap-2">
                <button class="btn btn-secondary" disabled={itemPage === 0} on:click={() => (itemPage -= 1)}>Previous</button>
                <span class="min-w-[110px] text-center text-sm font-semibold">Page {itemPage + 1} of {itemPageCount}</span>
                <button class="btn btn-secondary" disabled={itemPage >= itemPageCount - 1} on:click={() => (itemPage += 1)}>Next</button>
            </div>
        </div>
    {/if}
</div>

{#if showModal}
    <div
        class="modal-overlay"
        on:click={() => {
            showModal = false;
            showPricePad = false;
        }}
    >
        <div class="flat-panel w-full max-w-[900px] rounded-md flex flex-col gap-0 bg-bg-card max-h-[98vh] overflow-hidden" on:click|stopPropagation>
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
                    <input
                        type="text"
                        id="name"
                        bind:value={currentItem.name}
                        placeholder="e.g. Coca Cola"
                    />
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
                    <label for="scalePlu">PLU / Scale Product Code</label>
                    <div class="flex gap-2">
                        <input class="flex-1 min-w-0" type="text" id="scalePlu" bind:value={currentItem.scalePlu} inputmode="numeric" placeholder="Enter manually or generate" />
                        <button type="button" class="btn btn-secondary shrink-0" on:click={generateScalePlu}>Generate</button>
                    </div>
                    <small class="text-text-muted">You can keep the generated PLU or type your own unique number.</small>
                </div>
                {#if configuredPluLengths.length > 1}
                    <div class="field">
                        <CustomSelect
                            label="Generated PLU Digits"
                            bind:value={selectedPluLength}
                            options={configuredPluLengths.map(length => ({ label: `${length} digits`, value: length }))}
                        />
                    </div>
                {/if}

                <div class="field">
                    <label for="price">{currentItem.isWeighable ? 'Price per kg (£) *' : 'Selling Price (£) *'}</label>
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
                        options={itemCategoryOptions}
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

                {#if stockTrackingEnabled}
                    <div class="field">
                        <label for="stock" class="{currentItem.trackStock ? '' : 'opacity-40'}">Stock Level</label>
                        <input type="number" id="stock" bind:value={currentItem.stockLevel} placeholder="0" disabled={!currentItem.trackStock} class={!currentItem.trackStock ? 'opacity-40 cursor-not-allowed' : ''} />
                    </div>
                    <div class="field"><TouchToggle bind:checked={currentItem.trackStock} label="Track This Item" /></div>
                {:else}
                    <div class="field span-2 p-3 rounded-sm border border-border-flat bg-bg-panel text-text-muted text-sm">
                        Shop-wide stock tracking is disabled. It can be enabled from Settings.
                    </div>
                {/if}
                <div class="field"><TouchToggle bind:checked={currentItem.showInGoods} label="Show in Goods Menu" /></div>
                <div class="field"><TouchToggle bind:checked={currentItem.showInPos} label="Show on POS" /></div>
                <div class="field"><TouchToggle bind:checked={currentItem.allowPriceOverride} label="Allow Cashier Price Override" /></div>
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
