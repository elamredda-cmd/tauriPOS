<script lang="ts">
    import { onDestroy, onMount } from "svelte";
    import {
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
        deleteProduct,
        batchUpdateGoodsMenu,
        findNextAvailableScalePlu,
        getGoodsMenuCount,
        getGoodsMenuEditorProducts,
        getProductsPage,
    } from "$lib/stores/database";
    import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
    import CustomSelect from "$lib/components/CustomSelect.svelte";
    import TouchToggle from "$lib/components/TouchToggle.svelte";
    import TouchKeyboardButton from "$lib/components/TouchKeyboardButton.svelte";
    import PageBackButton from "$lib/components/PageBackButton.svelte";
    import { getBarcodeRules } from "$lib/barcodeRules";

    let showModal = false;
    let isEditing = false;
    let showGoodsMenu = false;
    let goodsMenuSelected: Product[] = [];
    let availableGoodsDraft: Product[] = [];
    let goodsMenuOriginal = new Map<string, { showInGoods: boolean; goodsSortOrder: number }>();
    let goodsMenuSearch = "";
    let goodsMenuCount = 0;
    let goodsMenuAvailableTotal = 0;
    let goodsMenuLoading = false;
    let goodsMenuSearchTimer: ReturnType<typeof setTimeout> | null = null;
    let goodsMenuLoadToken = 0;
    let previousGoodsMenuSearch = "";
    $: stockTrackingEnabled = ($settingsDB.find((setting) => setting.key === "stock_tracking_enabled")?.value ?? "true") !== "false";

    let currentItem: Partial<Product> = {};
    let originalItem: Product | null = null;
    let searchQuery = "";
    let appliedSearchQuery = "";
    let selectedCategoryId = "all";
    let selectedStatus: "active" | "deactivated" | "all" = "active";
    const ITEMS_PER_PAGE = 50;
    let itemPage = 0;
    let previousFilterKey = "";
    let previousPageKey = "";
    let pageItems: Product[] = [];
    let totalItems = 0;
    let totalItemsCapped = false;
    let itemsLoading = false;
    let itemsLoadError = "";
    let itemsMounted = false;
    let itemsSearchTimer: ReturnType<typeof setTimeout> | null = null;
    let itemsLoadToken = 0;
    let selectedPluLength = 5;
    $: configuredPluLengths = [...new Set(getBarcodeRules($settingsDB)
        .filter((rule) => rule.enabled)
        .map((rule) => rule.productLength))].sort((a, b) => a - b);
    $: categoryNameById = new Map($categoriesDB.map((category) => [category.id, category.name]));
    $: taxNameById = new Map($taxRatesDB.map((taxRate) => [taxRate.id, taxRate.name]));
    $: itemCategoryOptions = [
        ...(!$categoriesDB.some(c => c.isActive && c.id === currentItem.categoryId) && currentItem.categoryId
            ? [{ label: `${getCategoryName(currentItem.categoryId)} (Inactive)`, value: currentItem.categoryId }]
            : []),
        ...$categoriesDB.filter(c => c.isActive).map(c => ({ label: c.name, value: c.id })),
    ];

    // Numpad for Price Input
    let showPricePad = false;
    let priceString = "";
    let productImageInput: HTMLInputElement | null = null;
    let imageUploadError = "";

    $: itemPageCount = Math.max(1, Math.ceil(totalItems / ITEMS_PER_PAGE));
    $: {
        const filterKey = `${appliedSearchQuery}|${selectedCategoryId}|${selectedStatus}`;
        if (filterKey !== previousFilterKey) {
            previousFilterKey = filterKey;
            itemPage = 0;
        }
    }
    $: {
        const pageKey = `${previousFilterKey}|${itemPage}`;
        if (itemsMounted && pageKey !== previousPageKey) {
            previousPageKey = pageKey;
            scheduleItemsLoad();
        }
    }
    $: if (showGoodsMenu && goodsMenuSearch !== previousGoodsMenuSearch) {
        previousGoodsMenuSearch = goodsMenuSearch;
        scheduleGoodsMenuSearchLoad(goodsMenuSearch);
    }

    onMount(() => {
        itemsMounted = true;
        previousFilterKey = `${appliedSearchQuery}|${selectedCategoryId}|${selectedStatus}`;
        previousPageKey = `${previousFilterKey}|${itemPage}`;
        void loadItemsPage();
        void refreshGoodsMenuCount();
    });

    onDestroy(() => {
        itemsMounted = false;
        itemsLoadToken += 1;
        goodsMenuLoadToken += 1;
        if (itemsSearchTimer) clearTimeout(itemsSearchTimer);
        if (goodsMenuSearchTimer) clearTimeout(goodsMenuSearchTimer);
    });

    function scheduleItemsLoad(delay = 0) {
        if (itemsSearchTimer) clearTimeout(itemsSearchTimer);
        itemsSearchTimer = setTimeout(() => {
            void loadItemsPage();
        }, delay);
    }

    function handleItemsSearchInput(event: Event) {
        searchQuery = (event.currentTarget as HTMLInputElement).value;
    }

    function runItemsSearch() {
        const nextQuery = searchQuery.trim();
        if (nextQuery === appliedSearchQuery && itemPage === 0) {
            scheduleItemsLoad();
            return;
        }
        appliedSearchQuery = nextQuery;
        itemPage = 0;
        previousFilterKey = `${appliedSearchQuery}|${selectedCategoryId}|${selectedStatus}`;
        previousPageKey = `${previousFilterKey}|${itemPage}`;
        scheduleItemsLoad();
    }

    function clearItemsSearch() {
        searchQuery = "";
        if (!appliedSearchQuery && itemPage === 0) return;
        appliedSearchQuery = "";
        itemPage = 0;
        previousFilterKey = `${appliedSearchQuery}|${selectedCategoryId}|${selectedStatus}`;
        previousPageKey = `${previousFilterKey}|${itemPage}`;
        scheduleItemsLoad();
    }

    function handleItemsSearchKeydown(event: KeyboardEvent) {
        if (event.key !== "Enter") return;
        event.preventDefault();
        runItemsSearch();
    }

    async function loadItemsPage() {
        const token = ++itemsLoadToken;
        itemsLoading = true;
        itemsLoadError = "";
        try {
            const result = await getProductsPage({
                query: appliedSearchQuery,
                categoryId: selectedCategoryId,
                status: selectedStatus,
                limit: ITEMS_PER_PAGE,
                offset: itemPage * ITEMS_PER_PAGE,
            });
            if (token !== itemsLoadToken) return;
            pageItems = result.rows as Product[];
            totalItems = result.total;
            totalItemsCapped = Boolean(result.totalIsCapped);
            const lastPage = Math.max(0, Math.ceil(result.total / ITEMS_PER_PAGE) - 1);
            if (itemPage > lastPage) {
                itemPage = lastPage;
                return;
            }
        } catch (error) {
            if (token !== itemsLoadToken) return;
            itemsLoadError = String(error).replace(/^Error:\s*/, "");
            toast(`Could not load items: ${itemsLoadError}`, "error");
        } finally {
            if (token === itemsLoadToken) itemsLoading = false;
        }
    }

    async function refreshGoodsMenuCount() {
        try {
            goodsMenuCount = await getGoodsMenuCount();
        } catch (error) {
            console.warn("Could not refresh Goods Menu count:", error);
        }
    }

    function productMatchesSearch(product: Product, rawQuery: string): boolean {
        const q = rawQuery.trim().toLowerCase();
        if (!q) return true;
        return [
            product.name,
            product.sku,
            product.barcode,
            product.scalePlu,
        ].some((value) => String(value || "").toLowerCase().includes(q));
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
        imageUploadError = "";
        showModal = true;
    }

    function openEditModal(item: Product) {
        currentItem = { ...item };
        originalItem = { ...item };
        priceString = item.price.toString();
        selectedPluLength = item.scalePlu?.length || configuredPluLengths[0] || 5;
        isEditing = true;
        imageUploadError = "";
        showModal = true;
    }

    const PALETTE = [
        "#ef4444", "#f97316", "#f59e0b", "#22c55e",
        "#0ea5e9", "#6366f1", "#a855f7", "#ec4899",
    ];

    function randomColor() {
        return PALETTE[Math.floor(Math.random() * PALETTE.length)];
    }

    async function generateScalePlu() {
        const length = selectedPluLength || configuredPluLengths[0] || 5;
        try {
            const candidate = await findNextAvailableScalePlu(length, currentItem.id || "");
            if (!candidate) {
                toast(`No unused ${length}-digit PLU is available`, "error");
                return;
            }
            currentItem.scalePlu = candidate;
            currentItem = { ...currentItem };
            toast(`Generated unique PLU ${candidate}`, "success");
        } catch (error) {
            toast(`Could not generate PLU: ${String(error).replace(/^Error:\s*/, "")}`, "error");
        }
    }

    function blobToDataUrl(blob: Blob): Promise<string> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ""));
            reader.onerror = () => reject(reader.error || new Error("Could not read image"));
            reader.readAsDataURL(blob);
        });
    }

    async function compressProductImage(file: File): Promise<string> {
        if (!file.type.startsWith("image/")) throw new Error("Please choose an image file");
        if (file.size > 8 * 1024 * 1024) throw new Error("Image is too large. Please choose one below 8MB.");

        const objectUrl = URL.createObjectURL(file);
        try {
            const image = new Image();
            image.decoding = "async";
            await new Promise<void>((resolve, reject) => {
                image.onload = () => resolve();
                image.onerror = () => reject(new Error("Could not load image"));
                image.src = objectUrl;
            });

            const maxSide = 360;
            const ratio = Math.min(1, maxSide / Math.max(image.width, image.height));
            const width = Math.max(1, Math.round(image.width * ratio));
            const height = Math.max(1, Math.round(image.height * ratio));
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext("2d");
            if (!ctx) throw new Error("Image tools are not available on this device");
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";
            ctx.drawImage(image, 0, 0, width, height);

            const blob = await new Promise<Blob | null>((resolve) => {
                canvas.toBlob(resolve, "image/jpeg", 0.72);
            });
            if (!blob) throw new Error("Could not prepare image");
            return blobToDataUrl(blob);
        } finally {
            URL.revokeObjectURL(objectUrl);
        }
    }

    async function handleProductImageChange(event: Event) {
        const input = event.currentTarget as HTMLInputElement;
        const file = input.files?.[0];
        if (!file) return;
        imageUploadError = "";
        try {
            currentItem.image = await compressProductImage(file);
            currentItem = { ...currentItem };
            toast("Image added to item", "success");
        } catch (error) {
            imageUploadError = String(error).replace(/^Error:\s*/, "");
            toast(imageUploadError, "error");
        } finally {
            input.value = "";
        }
    }

    function removeProductImage() {
        currentItem.image = "";
        currentItem = { ...currentItem };
        imageUploadError = "";
        toast("Image removed from item", "info");
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
        if (currentItem.scalePlu && !/^\d+$/.test(currentItem.scalePlu)) {
            toast("Scale PLU must contain digits only", "error");
            return;
        }
        if (currentItem.scalePlu && configuredPluLengths.length > 0 && !configuredPluLengths.includes(currentItem.scalePlu.length)) {
            toast(`Scale PLU must contain ${configuredPluLengths.join(" or ")} digits to match the enabled barcode rules`, "error");
            return;
        }
        const wasInGoods = originalItem?.showInGoods ?? false;
        if (currentItem.showInGoods && !wasInGoods && goodsMenuCount >= 10) {
            toast("Goods Menu already contains the maximum 10 items", "error");
            return;
        }
        if (currentItem.showInGoods && !wasInGoods) {
            currentItem.goodsSortOrder = 0;
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
            } else {
                await addProduct(currentItem);
            }
            showModal = false;
            toast(isEditing ? "Item updated" : "Item added");
            await Promise.all([loadItemsPage(), refreshGoodsMenuCount()]);
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
            toast("Item deactivated", "info");
            showDelConfirm = false;
            await Promise.all([loadItemsPage(), refreshGoodsMenuCount()]);
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
            toast(`${item.name} reactivated`, "success");
            await Promise.all([loadItemsPage(), refreshGoodsMenuCount()]);
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
        return categoryNameById.get(id) || "Unknown";
    }

    function getTaxName(id: string): string {
        return taxNameById.get(id) || "-";
    }

    function formatResultCount(count: number, capped = false): string {
        return `${count.toLocaleString()}${capped ? "+" : ""}`;
    }

    async function openGoodsMenu() {
        goodsMenuSearch = "";
        previousGoodsMenuSearch = "";
        showGoodsMenu = true;
        goodsMenuOriginal = new Map();
        await loadGoodsMenuLists(false);
    }

    function scheduleGoodsMenuSearchLoad(query: string) {
        if (!showGoodsMenu) return;
        if (goodsMenuSearchTimer) clearTimeout(goodsMenuSearchTimer);
        goodsMenuSearchTimer = setTimeout(() => {
            void loadGoodsMenuLists(true, query);
        }, 160);
    }

    async function loadGoodsMenuLists(preserveSelected = true, query = goodsMenuSearch) {
        const token = ++goodsMenuLoadToken;
        goodsMenuLoading = true;
        try {
            const result = await getGoodsMenuEditorProducts(query, 100);
            if (token !== goodsMenuLoadToken) return;
            if (!preserveSelected) {
                goodsMenuSelected = result.selected.map((item) => ({ ...item, showInGoods: true }));
                goodsMenuOriginal = new Map();
                for (const item of goodsMenuSelected) {
                    goodsMenuOriginal.set(item.id, {
                        showInGoods: true,
                        goodsSortOrder: item.goodsSortOrder || 0,
                    });
                }
            }

            const selectedIds = new Set(goodsMenuSelected.map((item) => item.id));
            for (const item of result.available) {
                if (!goodsMenuOriginal.has(item.id)) {
                    goodsMenuOriginal.set(item.id, { showInGoods: false, goodsSortOrder: 0 });
                }
            }
            availableGoodsDraft = result.available
                .filter((item) => !selectedIds.has(item.id))
                .map((item) => ({ ...item, showInGoods: false, goodsSortOrder: 0 }));
            goodsMenuAvailableTotal = result.totalAvailable;
            normalizeGoodsMenuOrder();
        } catch (error) {
            if (token !== goodsMenuLoadToken) return;
            toast(`Could not load Goods Menu items: ${String(error).replace(/^Error:\s*/, "")}`, "error");
        } finally {
            if (token === goodsMenuLoadToken) goodsMenuLoading = false;
        }
    }

    function normalizeGoodsMenuOrder() {
        goodsMenuSelected = goodsMenuSelected
            .sort((a, b) => {
                const aOrder = a.goodsSortOrder || Number.MAX_SAFE_INTEGER;
                const bOrder = b.goodsSortOrder || Number.MAX_SAFE_INTEGER;
                return aOrder - bOrder || a.name.localeCompare(b.name);
            })
            .map((item, index) => ({ ...item, showInGoods: true, goodsSortOrder: index + 1 }));
        availableGoodsDraft = availableGoodsDraft.map((item) => ({ ...item, showInGoods: false, goodsSortOrder: 0 }));
    }

    function availableMatchesSearch(item: Product): boolean {
        return productMatchesSearch(item, goodsMenuSearch);
    }

    function toggleGoodsMenuItem(item: Product) {
        if (item.showInGoods) {
            goodsMenuSelected = goodsMenuSelected.filter((selected) => selected.id !== item.id);
            const availableItem = { ...item, showInGoods: false, goodsSortOrder: 0 };
            if (availableMatchesSearch(availableItem) && !availableGoodsDraft.some((available) => available.id === item.id)) {
                availableGoodsDraft = [...availableGoodsDraft, availableItem].sort((a, b) => a.name.localeCompare(b.name));
            }
        } else {
            if (goodsMenuSelected.length >= 10) {
                toast("Maximum 10 items allowed in Goods Menu", "error");
                return;
            }
            availableGoodsDraft = availableGoodsDraft.filter((available) => available.id !== item.id);
            goodsMenuSelected = [
                ...goodsMenuSelected,
                { ...item, showInGoods: true, goodsSortOrder: goodsMenuSelected.length + 1 },
            ];
        }
        normalizeGoodsMenuOrder();
    }

    function moveGoodsMenuItem(idx: number, dir: number) {
        const j = idx + dir;
        if (j < 0 || j >= goodsMenuSelected.length) return;
        const next = [...goodsMenuSelected];
        [next[idx], next[j]] = [next[j], next[idx]];
        goodsMenuSelected = next.map((item, index) => ({ ...item, goodsSortOrder: index + 1 }));
    }

    async function saveGoodsMenu() {
        normalizeGoodsMenuOrder();
        const selectedMap = new Map(goodsMenuSelected.map((item) => [item.id, item]));
        const changes = Array.from(goodsMenuOriginal.entries())
            .map(([id, original]) => {
                const selected = selectedMap.get(id);
                const showInGoods = !!selected;
                const goodsSortOrder = selected?.goodsSortOrder || 0;
                if (original.showInGoods === showInGoods && original.goodsSortOrder === goodsSortOrder) return null;
                return { id, showInGoods, goodsSortOrder, updatedAt: now() };
            })
            .filter((change): change is { id: string; showInGoods: boolean; goodsSortOrder: number; updatedAt: string } => !!change);

        if (changes.length === 0) {
            showGoodsMenu = false;
            toast("No changes to save");
            return;
        }

        try {
            await batchUpdateGoodsMenu(changes);
            showGoodsMenu = false;
            toast(`Goods Menu updated (${changes.length} items)`);
            await Promise.all([loadItemsPage(), refreshGoodsMenuCount()]);
        } catch (error) {
            toast(`Could not save Goods Menu: ${String(error).replace(/^Error:\s*/, "")}`, "error");
        }
    }
</script>

<div class="items-management-page p-6 h-screen flex flex-col overflow-hidden">
    <header class="items-management-header flex justify-between items-center mb-6 gap-5">
        <div class="items-title flex min-w-0 items-center gap-4">
            <PageBackButton fallback="/" />
            <h1 class="m-0 truncate text-[1.8rem]">Item Management</h1>
        </div>
        <div class="items-header-controls flex min-w-0 flex-1 items-center justify-end gap-4">
            <div class="items-filter-row flex min-w-0 flex-1 gap-3 max-w-[820px]">
                <div class="items-search relative min-w-0 flex-1">
                    <svg class="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18"
                        ><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                    <input
                        id="items-search"
                        class="search-input !pl-10 !pr-12"
                        type="text"
                        data-touch-keyboard="button"
                        value={searchQuery}
                        on:input={handleItemsSearchInput}
                        on:keydown={handleItemsSearchKeydown}
                        placeholder="Search name, SKU, barcode, PLU..."
                    />
                    <TouchKeyboardButton targetId="items-search" label="Open item search keyboard" embedded />
                </div>
                <button class="btn btn-secondary items-command-btn" on:click={runItemsSearch}>Find</button>
                <button class="btn btn-secondary items-command-btn" disabled={!searchQuery && !appliedSearchQuery} on:click={clearItemsSearch}>Clear</button>
                <div class="items-category-filter min-w-[200px]">
                    <CustomSelect
                        bind:value={selectedCategoryId}
                        options={[{label: 'All Categories', value: 'all'}, ...$categoriesDB.filter(c => c.isActive).map(c => ({label: c.name, value: c.id}))]}
                    />
                </div>
                <div class="items-status-filter min-w-[170px]">
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
            <div class="items-header-actions flex items-center gap-3">
                <button class="btn btn-primary items-command-btn" on:click={openAddModal}>+ Add Item</button>
                <button class="btn btn-secondary items-command-btn goods-menu-command" on:click={openGoodsMenu}>
                    <span>Goods Menu</span>
                    <span class="goods-menu-count">({goodsMenuCount}/10)</span>
                </button>
            </div>
        </div>
    </header>

    <div class="items-table-panel flat-panel flex-1 overflow-auto rounded-md p-px">
        <table class="items-table tbl">
            <thead>
                <tr>
                    <th class="items-col-actions">Actions</th>
                    <th class="items-col-tile">Tile</th>
                    <th class="items-col-name">Name</th>
                    <th class="items-col-status">Status</th>
                    <th class="items-col-sku">SKU</th>
                    <th class="items-col-barcode">Barcode</th>
                    <th class="items-col-plu">PLU</th>
                    <th class="items-col-category">Category</th>
                    <th class="items-col-tax">Tax</th>
                    {#if stockTrackingEnabled}<th class="items-col-stock">Stock</th>{/if}
                    <th class="items-col-cost">Cost</th>
                    <th class="items-col-price">Price</th>
                </tr>
            </thead>
            <tbody>
                {#each pageItems as item}
                    <tr>
                        <td class="items-col-actions">
                            <div class="act-row">
                                <button class="btn-icon act-btn" title="Edit item" aria-label="Edit item" on:click={() => openEditModal(item)}>
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16"
                                        ><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                                </button>
                                {#if item.isActive}
                                    <button class="btn-icon act-btn danger" title="Deactivate item" aria-label="Deactivate item" on:click={() => deleteItem(item.id)}>
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16"
                                            ><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                                    </button>
                                {:else}
                                    <button class="btn-icon act-btn !text-success" title="Reactivate item" aria-label="Reactivate item" on:click={() => reactivateItem(item)}>
                                        ↻
                                    </button>
                                {/if}
                            </div>
                        </td>
                        <td class="items-col-tile">
                            <div
                                class="h-11 w-11 overflow-hidden rounded-lg border border-border-flat shadow-sm"
                                style="background-color: {item.color || '#3b82f6'}"
                            >
                                {#if item.image}
                                    <img class="h-full w-full object-cover" src={item.image} alt={item.name} />
                                {/if}
                            </div>
                        </td>
                        <td class="item-name-cell items-col-name font-semibold" title={item.name}>{item.name}</td>
                        <td class="items-col-status">
                            <span class="tag {item.isActive ? '!text-success' : '!text-danger'}">
                                {item.isActive ? "Active" : "Deactivated"}
                            </span>
                        </td>
                        <td class="items-col-sku mono" title={item.sku}>{item.sku}</td>
                        <td class="items-col-barcode mono" title={item.barcode || "-"}>{item.barcode || "-"}</td>
                        <td class="items-col-plu mono" title={item.scalePlu || "-"}>{item.scalePlu || "-"}</td>
                        <td class="items-col-category"><span class="tag" title={getCategoryName(item.categoryId)}>{getCategoryName(item.categoryId)}</span></td>
                        <td class="items-col-tax text-[0.8rem] text-text-muted" title={getTaxName(item.taxRateId)}>{getTaxName(item.taxRateId)}</td>
                        {#if stockTrackingEnabled}<td class="items-col-stock">{item.trackStock ? item.stockLevel : "Not tracked"}</td>{/if}
                        <td class="items-col-cost">{item.costPrice > 0 ? formatMoney(item.costPrice) : "-"}</td>
                        <td class="items-col-price money">{formatMoney(item.price)}</td>
                    </tr>
                {/each}
                {#if pageItems.length === 0}
                    <tr class="empty-row">
                        <td colspan={stockTrackingEnabled ? 12 : 11}>
                            {#if itemsLoading}
                                Loading items...
                            {:else if itemsLoadError}
                                {itemsLoadError}
                            {:else if appliedSearchQuery || selectedCategoryId !== "all" || selectedStatus !== "active"}
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
    {#if totalItems > 0}
        <div class="items-pagination flex items-center justify-between gap-3 pt-3 shrink-0">
            <span class="text-sm text-text-muted">
                Showing {itemPage * ITEMS_PER_PAGE + 1}-{Math.min((itemPage + 1) * ITEMS_PER_PAGE, totalItems)} of {formatResultCount(totalItems, totalItemsCapped)}
            </span>
            <div class="items-pagination-nav flex items-center gap-2">
                <button class="btn btn-secondary items-command-btn" disabled={itemPage === 0} on:click={() => (itemPage -= 1)}>Previous</button>
                <span class="min-w-[110px] text-center text-sm font-semibold">Page {itemPage + 1} of {itemPageCount}</span>
                <button class="btn btn-secondary items-command-btn" disabled={itemPage >= itemPageCount - 1} on:click={() => (itemPage += 1)}>Next</button>
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
        <div class="item-editor-panel flat-panel w-full max-w-[900px] rounded-md flex flex-col gap-0 bg-bg-card max-h-[98vh] overflow-hidden" on:click|stopPropagation>
            <div class="item-modal-header flex justify-between items-center border-b border-border-flat p-4 shrink-0">
                <h2>{isEditing ? "Edit Item" : "Add New Item"}</h2>
                <button
                    class="btn-icon"
                    on:click={() => {
                        showModal = false;
                        showPricePad = false;
                    }}>✕</button
                >
            </div>

            <div class="item-form-grid form-grid overflow-y-auto p-4">
                <div class="field span-2">
                    <label for="name">Item Name *</label>
                    <div class="relative">
                        <input
                            class="min-w-0 !pr-12"
                            type="text"
                            id="name"
                            data-touch-keyboard="button"
                            bind:value={currentItem.name}
                            placeholder="e.g. Coca Cola"
                        />
                        <TouchKeyboardButton targetId="name" label="Open item name keyboard" embedded />
                    </div>
                </div>

                <div class="field span-2">
                    <span class="text-sm font-medium text-text-muted">Tile Image</span>
                    <div class="item-image-editor grid gap-4 rounded-xl border border-border-flat bg-bg-panel p-4 md:grid-cols-[150px_1fr]">
                        <div
                            class="item-image-preview relative h-[150px] overflow-hidden rounded-xl border border-border-flat shadow-sm"
                            style="background-color: {currentItem.color || '#3b82f6'}"
                        >
                            {#if currentItem.image}
                                <img class="h-full w-full object-cover" src={currentItem.image} alt={currentItem.name || 'Item image'} />
                            {:else}
                                <div class="flex h-full w-full items-center justify-center px-4 text-center text-sm font-bold text-white/85">
                                    {currentItem.name || "No image yet"}
                                </div>
                            {/if}
                            <div class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-2 text-right text-sm font-black text-white">
                                {formatMoney(currentItem.price || 0)}
                            </div>
                        </div>
                        <div class="flex min-w-0 flex-col justify-center gap-3">
                            <div>
                                <p class="m-0 font-bold text-text-main">Add a small image for this product tile</p>
                                <p class="m-0 mt-1 text-sm text-text-muted">
                                    The app resizes it to a small JPEG before saving, then syncs it through the product record.
                                </p>
                            </div>
                            <div class="item-image-actions flex flex-wrap gap-2">
                                <input
                                    class="hidden"
                                    bind:this={productImageInput}
                                    type="file"
                                    accept="image/*"
                                    on:change={handleProductImageChange}
                                />
                                <button type="button" class="btn btn-secondary" on:click={() => productImageInput?.click()}>
                                    {currentItem.image ? "Change Image" : "Upload Image"}
                                </button>
                                {#if currentItem.image}
                                    <button type="button" class="btn btn-danger" on:click={removeProductImage}>Remove Image</button>
                                {/if}
                            </div>
                            {#if imageUploadError}
                                <p class="m-0 rounded-lg border border-danger/35 bg-danger/10 px-3 py-2 text-sm font-bold text-danger">
                                    {imageUploadError}
                                </p>
                            {/if}
                            <p class="m-0 text-xs text-text-muted">
                                Best result: square product photo. Large photos are reduced to a tile-friendly size.
                            </p>
                        </div>
                    </div>
                </div>

                <div class="field">
                    <label for="sku">SKU</label>
                    <div class="relative">
                        <input class="min-w-0 !pr-12" type="text" id="sku" data-touch-keyboard="button" bind:value={currentItem.sku} placeholder="Stock Keeping Unit" />
                        <TouchKeyboardButton targetId="sku" label="Open SKU keyboard" embedded />
                    </div>
                </div>

                <div class="field">
                    <label for="barcode">Barcode</label>
                    <div class="relative">
                        <input class="min-w-0 !pr-12" type="text" id="barcode" data-touch-keyboard="button" bind:value={currentItem.barcode} placeholder="Scan or type barcode" />
                        <TouchKeyboardButton targetId="barcode" label="Open barcode keyboard" embedded />
                    </div>
                </div>

                <div class="field span-2">
                    <label for="scalePlu">PLU / Scale Product Code</label>
                    <div class="plu-entry-row flex gap-2">
                        <div class="relative min-w-0 flex-1">
                            <input class="min-w-0 !pr-12" type="text" id="scalePlu" data-touch-keyboard="button" bind:value={currentItem.scalePlu} inputmode="numeric" placeholder="Enter manually or generate" />
                            <TouchKeyboardButton targetId="scalePlu" label="Open PLU keyboard" embedded />
                        </div>
                        <button type="button" class="btn btn-secondary shrink-0" on:click={generateScalePlu}>Generate</button>
                    </div>
                    <small class="text-text-muted">You can keep the generated PLU or type your own unique number.</small>
                </div>
                {#if configuredPluLengths.length > 1}
                    <div class="field span-2">
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

                {#if stockTrackingEnabled}
                    <section class="item-inventory-section span-2">
                        <div class="field">
                            <label for="stock" class="{currentItem.trackStock ? '' : 'opacity-40'}">Stock Level</label>
                            <input type="number" id="stock" bind:value={currentItem.stockLevel} placeholder="0" disabled={!currentItem.trackStock} class={!currentItem.trackStock ? 'opacity-40 cursor-not-allowed' : ''} />
                        </div>
                        <div class="field item-toggle-field"><TouchToggle bind:checked={currentItem.trackStock} label="Track This Item" /></div>
                    </section>
                {:else}
                    <div class="field span-2 p-3 rounded-sm border border-border-flat bg-bg-panel text-text-muted text-sm">
                        Shop-wide stock tracking is disabled. It can be enabled from Settings.
                    </div>
                {/if}
                <section class="item-options-section span-2">
                    <h3>Item Options</h3>
                    <div class="item-options-grid">
                        <TouchToggle bind:checked={currentItem.showInGoods} label="Show in Goods Menu" />
                        <TouchToggle bind:checked={currentItem.allowPriceOverride} label="Allow Cashier Price Override" />
                        <TouchToggle bind:checked={currentItem.isWeighable} label="Weighable (Scale)" />
                    </div>
                </section>
            </div>

            <div class="item-modal-actions flex justify-end gap-3 p-4 border-t border-border-flat shrink-0 bg-bg-card">
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
            class="goods-menu-panel flat-panel w-full max-w-[800px] p-6 rounded-md flex flex-col gap-4 bg-bg-card max-h-[90vh] overflow-hidden"
            on:click|stopPropagation
        >
            <div class="flex justify-between items-center border-b border-border-flat pb-4 shrink-0">
                <h2>Goods Menu Manager</h2>
                <button class="btn-icon" on:click={() => (showGoodsMenu = false)}>✕</button>
            </div>
            <p class="text-text-muted shrink-0">
                Select up to 10 active items to appear in the Goods menu.
                <strong class="text-text-main">Selected: {goodsMenuSelected.length}/10</strong>
            </p>
            <div class="goods-menu-columns grid grid-cols-2 gap-4 flex-1 min-h-0 overflow-hidden">
                <div class="flex flex-col gap-2 h-full">
                    <h3 class="font-semibold text-sm uppercase tracking-wider text-text-muted shrink-0">Available Items</h3>
                    <div class="relative shrink-0">
                        <input
                            id="goods-menu-search"
                            type="text"
                            data-touch-keyboard="button"
                            class="search-input !min-h-10 min-w-0 !pr-12"
                            placeholder="Search name, SKU, barcode, PLU..."
                            bind:value={goodsMenuSearch}
                        />
                        <TouchKeyboardButton targetId="goods-menu-search" label="Open Goods Menu search keyboard" embedded />
                    </div>
                    <div class="flex-1 overflow-y-auto flex flex-col gap-1 min-h-0">
                        {#if goodsMenuLoading && availableGoodsDraft.length === 0}
                            <p class="text-center text-text-muted p-4 text-sm shrink-0">Loading items...</p>
                        {/if}
                        {#each availableGoodsDraft as item}
                            <button
                                class="flex items-center gap-3 p-3 bg-bg-card border border-border-flat rounded-sm text-left hover:bg-bg-card-hover transition-colors disabled:opacity-50 shrink-0"
                                disabled={goodsMenuSelected.length >= 10}
                                on:click={() => toggleGoodsMenuItem(item)}
                            >
                                <div class="w-4 h-4 rounded border border-border-flat shrink-0 {goodsMenuSelected.length >= 10 ? '' : 'hover:border-accent-primary'}"></div>
                                <span class="flex-1 font-medium">{item.name}</span>
                                <span class="text-text-muted text-xs">{getCategoryName(item.categoryId)}</span>
                            </button>
                        {/each}
                        {#if !goodsMenuLoading && availableGoodsDraft.length === 0}
                            <p class="text-center text-text-muted p-4 text-sm shrink-0">No available items match this search.</p>
                        {/if}
                        {#if goodsMenuAvailableTotal > availableGoodsDraft.length}
                            <p class="text-center text-text-muted p-2 text-xs shrink-0">Showing first 100 matches. Use search to narrow results.</p>
                        {/if}
                    </div>
                </div>
                <div class="flex flex-col gap-2 h-full">
                    <h3 class="font-semibold text-sm uppercase tracking-wider text-text-muted shrink-0">Selected Order</h3>
                    <div class="flex-1 overflow-y-auto flex flex-col gap-1 min-h-0">
                        {#each goodsMenuSelected as item, i}
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
                                    disabled={i === goodsMenuSelected.length - 1}
                                    on:click={() => moveGoodsMenuItem(i, 1)}>↓</button
                                >
                                <button
                                    class="w-8 h-8 rounded-md bg-danger/10 border border-danger/30 text-danger hover:bg-danger hover:text-white transition-colors flex items-center justify-center"
                                    on:click={() => toggleGoodsMenuItem(item)}>✕</button
                                >
                            </div>
                        {/each}
                        {#if goodsMenuSelected.length === 0}
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

<style>
    .items-management-page {
        min-width: 0;
        background: var(--bg-base);
        color: var(--text-main);
    }

    .items-management-header,
    .items-title,
    .items-header-controls,
    .items-filter-row,
    .items-table-panel {
        min-width: 0;
    }

    .items-table-panel {
        overscroll-behavior: contain;
    }

    .items-header-actions {
        display: contents;
    }

    .items-header-controls {
        display: grid;
        grid-template-columns: minmax(240px, 1.7fr) repeat(6, minmax(96px, .68fr));
        align-items: stretch;
        gap: 0.65rem;
    }

    .items-filter-row {
        display: contents;
        max-width: none;
    }

    .items-search,
    .items-category-filter,
    .items-status-filter,
    .items-header-actions .btn,
    .items-pagination-nav .btn {
        min-width: 0;
    }

    .items-search .search-input,
    .items-filter-row :global(button[aria-haspopup="listbox"]),
    .items-command-btn {
        width: 100%;
        height: 50px;
        min-height: 50px;
        border-radius: 0.4rem;
        font-size: 0.96rem;
        letter-spacing: 0;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, .08), 0 8px 18px var(--shadow);
    }

    .items-search .search-input {
        background: var(--bg-card);
        padding-block: 0.65rem;
        font-weight: 700;
    }

    .items-filter-row :global(button[aria-haspopup="listbox"]) {
        background: var(--bg-card);
        padding-block: 0.65rem;
        font-weight: 900;
    }

    .items-command-btn {
        padding: 0.65rem 1.1rem;
        font-weight: 900;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .items-header-actions .items-command-btn {
        justify-content: center;
    }

    .goods-menu-command {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 0;
        line-height: 1.05;
        padding: 0.45rem 0.5rem;
        text-align: center;
        white-space: normal;
    }

    .goods-menu-command span {
        display: block;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .goods-menu-count {
        font-size: 0.82em;
        opacity: 0.85;
    }

    .items-pagination-nav {
        display: grid;
        grid-template-columns: minmax(150px, 1fr) auto minmax(150px, 1fr);
        align-items: center;
        gap: 0.6rem;
    }

    .items-pagination-nav .items-command-btn {
        height: 50px;
        min-height: 50px;
    }

    .items-table {
        min-width: 1180px;
    }

    .items-table th,
    .items-table td {
        vertical-align: middle;
    }

    td.items-col-name,
    td.items-col-sku,
    td.items-col-barcode,
    td.items-col-plu,
    td.items-col-category,
    td.items-col-tax,
    td.items-col-stock {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    td.items-col-name {
        min-width: 190px;
        max-width: 260px;
    }

    td.items-col-sku,
    td.items-col-tax {
        max-width: 130px;
    }

    td.items-col-barcode {
        max-width: 150px;
    }

    td.items-col-plu,
    td.items-col-stock {
        max-width: 110px;
    }

    td.items-col-category {
        max-width: 160px;
    }

    .items-col-actions {
        width: 106px;
        min-width: 106px;
        text-align: left;
    }

    th.items-col-actions,
    td.items-col-actions {
        position: sticky;
        left: 0;
        background: var(--bg-card);
        box-shadow: 1px 0 0 var(--border-flat);
    }

    th.items-col-actions {
        z-index: 8;
    }

    td.items-col-actions {
        z-index: 4;
    }

    .items-col-actions .act-row {
        display: grid;
        grid-template-columns: repeat(2, 40px);
        justify-content: start;
        gap: 0.4rem;
    }

    .items-col-actions .act-btn {
        width: 40px !important;
        height: 40px !important;
        min-width: 40px !important;
        min-height: 40px !important;
        padding: 0 !important;
        border-radius: 0.45rem;
    }

    .items-col-category .tag {
        max-width: 150px;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .items-pagination {
        min-width: 0;
    }

    .item-editor-panel,
    .goods-menu-panel {
        max-width: min(900px, calc(100vw - 1.5rem));
    }

    .goods-menu-panel {
        max-width: min(800px, calc(100vw - 1.5rem));
    }

    .item-inventory-section {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        align-items: end;
        gap: 0.75rem;
        padding-top: 0.25rem;
    }

    .item-toggle-field {
        justify-content: end;
    }

    .item-options-section {
        border-top: 1px solid var(--border-flat);
        padding-top: 0.85rem;
    }

    .item-options-section h3 {
        margin: 0 0 0.55rem;
        color: var(--text-muted);
        font-size: 0.72rem;
        font-weight: 900;
        text-transform: uppercase;
        letter-spacing: 0;
    }

    .item-options-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 0.75rem;
    }

    @media (max-width: 760px) {
        .item-inventory-section,
        .item-options-grid {
            grid-template-columns: minmax(0, 1fr);
        }
    }

    @media (min-width: 900px) and (max-width: 1180px) and (min-height: 680px) and (max-height: 900px) {
        .items-management-page {
            padding: var(--app-page-gutter, 1.5rem) !important;
        }

        .items-management-header {
            display: grid;
            grid-template-columns: minmax(0, 1fr);
            align-items: stretch !important;
            gap: 0.75rem !important;
            margin-bottom: 0.75rem !important;
        }

        .items-title {
            min-height: 44px;
        }

        .items-title h1 {
            font-size: 1.35rem;
        }

        .items-header-controls {
            display: grid;
            grid-template-columns: minmax(0, 1.7fr) repeat(6, minmax(0, .68fr));
            align-items: stretch;
            gap: 0.6rem;
        }

        .items-filter-row {
            display: contents;
            max-width: none;
        }

        .items-category-filter,
        .items-status-filter {
            min-width: 0;
        }

        .items-filter-row :global(button[aria-haspopup="listbox"]),
        .items-filter-row .search-input {
            min-height: 48px !important;
            height: 48px;
            font-size: 0.9rem;
        }

        .items-header-actions {
            display: contents;
        }

        .items-header-actions .items-command-btn,
        .items-pagination-nav .items-command-btn {
            width: 100%;
            min-width: 0;
            min-height: 48px;
            padding: 0.6rem 0.9rem;
            font-size: 0.9rem;
        }

        .items-table {
            width: 100%;
            min-width: 0;
            table-layout: fixed;
        }

        .items-table th,
        .items-table td {
            height: 48px;
            padding: 0.55rem 0.6rem;
            font-size: 0.82rem;
        }

        .items-table th {
            height: 40px;
            padding-block: 0.45rem;
            font-size: 0.68rem;
        }

        .items-col-tile {
            width: 54px;
        }

        .items-col-name {
            width: auto;
            min-width: 0;
        }

        .items-col-status {
            width: 108px;
        }

        .items-col-barcode {
            width: 142px;
        }

        .items-col-category {
            width: 136px;
        }

        .items-col-stock {
            width: 92px;
        }

        .items-col-price {
            width: 90px;
        }

        .items-col-actions {
            width: 98px;
            min-width: 98px;
        }

        .items-col-sku,
        .items-col-plu,
        .items-col-tax,
        .items-col-cost {
            display: none;
        }

        .items-table .tag {
            max-width: 100%;
            min-width: 0;
            padding: 0.35rem 0.55rem;
            font-size: 0.7rem;
        }

        .items-table .h-11 {
            width: 38px;
            height: 38px;
            border-radius: 0.5rem;
        }

        .items-table .act-row {
            grid-template-columns: repeat(2, 38px);
            gap: 0.35rem;
        }

        .items-table .act-btn {
            width: 38px !important;
            height: 38px !important;
            min-width: 38px !important;
            min-height: 38px !important;
        }

        .items-pagination {
            padding-top: 0.5rem;
        }

        .items-pagination .btn {
            min-height: 42px;
            padding: 0.5rem 0.85rem;
        }

        .item-editor-panel {
            max-width: calc(100vw - 1rem);
            max-height: calc(100vh - 0.75rem);
        }

        .item-modal-header,
        .item-modal-actions {
            padding: 0.75rem !important;
        }

        .item-modal-header h2 {
            margin: 0;
            font-size: 1.15rem;
        }

        .item-form-grid {
            gap: 0.75rem;
            padding: 0.75rem !important;
        }

        .item-image-editor {
            grid-template-columns: 118px minmax(0, 1fr);
            gap: 0.75rem;
            padding: 0.75rem !important;
        }

        .item-image-preview {
            height: 118px;
            border-radius: 0.6rem;
        }

        .item-image-editor p {
            line-height: 1.25;
        }

        .item-modal-actions .btn,
        .plu-entry-row .btn {
            min-height: 42px;
            padding: 0.5rem 0.85rem;
        }

        .goods-menu-panel {
            max-width: calc(100vw - 1rem);
            max-height: calc(100vh - 1rem);
            gap: 0.75rem;
            padding: 0.9rem !important;
        }
    }

    @media (max-width: 900px), (max-height: 679px) {
        .items-management-page {
            padding: var(--app-page-gutter, 1.5rem) !important;
        }

        .items-management-header {
            flex-direction: column;
            align-items: stretch !important;
            gap: 0.65rem !important;
            margin-bottom: 0.75rem !important;
        }

        .items-title h1 {
            font-size: 1.25rem;
        }

        .items-header-controls {
            display: grid;
            grid-template-columns: minmax(0, 1fr);
            align-items: stretch;
            gap: 0.55rem;
        }

        .items-filter-row,
        .items-header-actions {
            display: contents;
            max-width: none;
        }

        .items-category-filter,
        .items-status-filter {
            min-width: 0;
        }

        .items-filter-row :global(button[aria-haspopup="listbox"]),
        .items-filter-row .search-input {
            min-height: 46px !important;
            height: 46px;
            font-size: 0.9rem;
        }

        .items-header-actions .items-command-btn,
        .items-pagination-nav .items-command-btn {
            width: 100%;
            min-width: 0;
            min-height: 46px;
            padding: 0.55rem 0.75rem;
            font-size: 0.9rem;
        }

        .items-table {
            min-width: 620px;
            table-layout: fixed;
        }

        .items-table th,
        .items-table td {
            height: 46px;
            padding: 0.5rem;
            font-size: 0.8rem;
        }

        .items-table th {
            height: 38px;
            font-size: 0.66rem;
        }

        .items-col-tile,
        .items-col-status,
        .items-col-sku,
        .items-col-plu,
        .items-col-tax,
        .items-col-cost {
            display: none;
        }

        .items-col-name {
            width: auto;
            min-width: 0;
        }

        .items-col-barcode {
            width: 138px;
        }

        .items-col-category {
            width: 124px;
        }

        .items-col-stock {
            width: 82px;
        }

        .items-col-price {
            width: 82px;
        }

        .items-col-actions {
            width: 90px;
            min-width: 90px;
        }

        .items-table .tag {
            max-width: 100%;
            min-width: 0;
            padding-inline: 0.45rem;
            font-size: 0.68rem;
        }

        .items-table .act-row {
            grid-template-columns: repeat(2, 36px);
            gap: 0.3rem;
        }

        .items-table .act-btn {
            width: 36px !important;
            height: 36px !important;
            min-width: 36px !important;
            min-height: 36px !important;
        }

        .items-pagination {
            align-items: stretch;
            flex-direction: column;
        }

        .items-pagination > div {
            display: grid;
            grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
        }

        .items-pagination-nav {
            grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
        }

        .items-pagination .items-command-btn {
            min-height: 46px;
            padding: 0.55rem 0.75rem;
        }

        .item-editor-panel,
        .goods-menu-panel {
            max-width: calc(100vw - 0.75rem);
            max-height: calc(100vh - 0.75rem);
        }

        .item-modal-header,
        .item-modal-actions {
            padding: 0.75rem !important;
        }

        .item-form-grid {
            padding: 0.75rem !important;
        }

        .item-image-editor,
        .goods-menu-columns {
            grid-template-columns: minmax(0, 1fr);
        }

        .item-image-preview {
            height: 120px;
        }

        .item-modal-actions,
        .item-image-actions,
        .plu-entry-row {
            display: grid;
            grid-template-columns: minmax(0, 1fr);
        }

        .item-modal-actions .btn,
        .item-image-actions .btn,
        .plu-entry-row .btn {
            width: 100%;
            min-height: 42px;
        }

        .goods-menu-panel {
            gap: 0.75rem;
            padding: 0.85rem !important;
        }
    }
</style>
