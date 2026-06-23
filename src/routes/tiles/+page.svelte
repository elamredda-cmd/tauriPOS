<script lang="ts">
    import { goBack } from '$lib/navigation';
    import { onMount } from "svelte";
    import {
        posPagesDB,
        activePosPages,
        tilesDB,
        activeProducts,
        type PosPage,
        type Tile,
        uuid,
        formatMoney,
        now,
    } from "$lib/stores/db";
    import { toast } from "$lib/stores/toast";
    import {
        savePosPage,
        deletePosPage,
        addTile,
        deleteTile,
    } from "$lib/stores/database";
    import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
    import TouchColorPicker from "$lib/components/TouchColorPicker.svelte";

    let activePageId = "";
    let currentPageIndex = 0;
    const POS_TILES_PER_PAGE = 16;

    // Wait for DB to load
    $: {
        if ($activePosPages.length > 0 && !$activePosPages.some((page) => page.id === activePageId)) {
            activePageId = $activePosPages[0].id;
            currentPageIndex = 0;
        } else if ($activePosPages.length === 0) {
            activePageId = "";
        }
    }

    $: activePageTiles = $tilesDB
        .filter((t) => t.pageId === activePageId)
        .sort((a, b) => a.position - b.position);
    $: activeProductById = new Map($activeProducts.map((product) => [product.id, product]));

    $: totalPages = Math.max(
        1,
        Math.ceil(
            (activePageTiles.length > 0
                ? Math.max(...activePageTiles.map((t) => t.position))
                : 0) / POS_TILES_PER_PAGE,
        ),
    );

    $: displayTiles = Array.from({ length: POS_TILES_PER_PAGE }, (_, i) => {
        const absolutePos = currentPageIndex * POS_TILES_PER_PAGE + i + 1; // 1-indexed
        const tile = activePageTiles.find((t) => t.position === absolutePos);
        if (!tile) return null;
        return {
            tile,
            product: activeProductById.get(tile.productId),
            absolutePos,
        };
    });

    // Modal States
    let showPageModal = false;
    let pageModalMode: "add" | "edit" = "add";
    let editPageId = "";
    let editPageName = "";
    let editPageColor = "#3b82f6";

    let showTileSearchModal = false;
    let pendingTilePosition = 1;
    let searchTerm = "";

    let showEditTileModal = false;
    let editTileObj: Tile | null = null;
    let showPageDelConfirm = false;

    // Derived products for search
    $: tileProductIds = new Set(activePageTiles.map((t) => t.productId));
    $: availableProducts = $activeProducts
        .filter(
            (p) =>
                !tileProductIds.has(p.id) &&
                (searchTerm === "" ||
                    p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                    p.sku.toLowerCase().includes(searchTerm.toLowerCase())),
        )
        .slice(0, 50);

    function openAddPage() {
        if ($activePosPages.length >= 8) {
            toast("Maximum 8 pages allowed", "error");
            return;
        }
        pageModalMode = "add";
        editPageName = "New Page";
        editPageColor = "#3b82f6";
        showPageModal = true;
    }

    function openEditPage(page: PosPage) {
        pageModalMode = "edit";
        editPageId = page.id;
        editPageName = page.name;
        editPageColor = page.color;
        showPageModal = true;
    }

    async function savePage() {
        if (!editPageName.trim()) return;
        try {
            if (pageModalMode === "add") {
                const maxPos = $posPagesDB.reduce(
                    (m, p) => Math.max(m, p.position),
                    0,
                );
                const newPage = {
                    id: uuid(),
                    name: editPageName.trim(),
                    position: maxPos + 1,
                    color: editPageColor,
                };
                await savePosPage(newPage);
                posPagesDB.update((p) => [...p, newPage]);
                activePageId = newPage.id;
                toast("Page added", "success");
            } else {
                const existing = $posPagesDB.find((pg) => pg.id === editPageId);
                if (!existing) throw new Error("Page no longer exists");
                const updated = {
                    ...existing,
                    name: editPageName.trim(),
                    color: editPageColor,
                };
                await savePosPage(updated);
                posPagesDB.update((p) =>
                    p.map((pg) => pg.id === editPageId ? updated : pg),
                );
                toast("Page updated", "success");
            }
            showPageModal = false;
        } catch (e) {
            toast(`Page was not saved: ${e}`, "error");
        }
    }

    function confirmDeletePage() {
        showPageDelConfirm = true;
    }

    async function handlePageDelete() {
        try {
            await deletePosPage(editPageId);
            posPagesDB.update((p) => p.filter((pg) => pg.id !== editPageId));
            tilesDB.update((t) => t.filter((x) => x.pageId !== editPageId));
            activePageId = "";
            showPageModal = false;
            showPageDelConfirm = false;
            toast("Page deleted", "info");
        } catch (e) {
            toast(`Page was not deleted: ${e}`, "error");
        }
    }

    function handleEmptyTileClick(absolutePos: number) {
        pendingTilePosition = absolutePos;
        searchTerm = "";
        showTileSearchModal = true;
    }

    function handleAssignedTileClick(tile: Tile) {
        editTileObj = tile;
        showEditTileModal = true;
    }

    async function assignProductToTile(productId: string) {
        try {
            const existing = $tilesDB.find(t => t.pageId === activePageId && t.position === pendingTilePosition);
            if (existing) await deleteTile(existing.id);

            const newTile: Tile = {
                id: uuid(),
                pageId: activePageId,
                productId,
                position: pendingTilePosition,
            };
            await addTile(newTile);
            tilesDB.update((list) => [
                ...list.filter((t) => t.id !== existing?.id),
                newTile,
            ]);
            showTileSearchModal = false;
            toast("Tile added");
        } catch (e) {
            toast(`Tile was not saved: ${e}`, "error");
        }
    }

    async function removeTile() {
        if (!editTileObj) return;
        try {
            await deleteTile(editTileObj.id);
            tilesDB.update((t) => t.filter((x) => x.id !== editTileObj!.id));
            showEditTileModal = false;
            toast("Tile removed", "info");
        } catch (e) {
            toast(`Tile was not removed: ${e}`, "error");
        }
    }
</script>

<div class="tiles-management-page flex flex-col h-screen w-screen bg-bg-base">
    <div class="flat-panel flex justify-between items-center px-6 py-4 border-b border-border-flat">
        <div class="flex items-center gap-4">
            <button type="button" class="btn-icon shrink-0" aria-label="Go back" on:click={() => goBack('/design')}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20">
                    <line x1="19" y1="12" x2="5" y2="12"></line>
                    <polyline points="12 19 5 12 12 5"></polyline>
                </svg>
            </button>
            <div>
                <h2 class="m-0 text-[1.4rem]">POS Layout Designer</h2>
                <p class="m-0 text-text-muted text-[0.9rem]">
                    Design your grid. Changes reflect immediately on the POS screen.
                </p>
            </div>
        </div>
    </div>

    <main class="flex-1 flex flex-col p-6 overflow-y-auto">
        <!-- POS Pages -->
        <div class="flex gap-3 overflow-x-auto pb-3 mb-5">
            {#each $activePosPages as page}
                <div
                    class="flex bg-bg-card border rounded-sm overflow-hidden {activePageId === page.id ? 'border-accent-primary' : 'border-border-flat'}"
                >
                    <button
                        class="px-5 py-3 bg-transparent font-semibold text-[0.95rem] flex items-center gap-2 {activePageId === page.id ? 'text-text-main bg-accent-primary/10' : 'text-text-muted'}"
                        on:click={() => {
                            activePageId = page.id;
                            currentPageIndex = 0;
                        }}
                    >
                        <span class="w-3 h-3 rounded-full" style="background: {page.color};"></span>
                        {page.name}
                    </button>
                    {#if activePageId === page.id}
                        <button
                            class="px-3 bg-bg-card-hover border-l border-border-flat text-text-muted hover:bg-bg-card"
                            on:click={() => openEditPage(page)}>⚙️</button
                        >
                    {/if}
                </div>
            {/each}
            {#if $activePosPages.length < 8}
                <button
                    class="px-5 py-3 bg-transparent text-text-muted font-semibold text-[0.95rem] border border-dashed border-border-flat rounded-sm hover:border-accent-primary hover:text-text-main"
                    on:click={openAddPage}>+ Add Page</button
                >
            {/if}
        </div>

        <!-- Tile Grid Area -->
        {#if activePageId}
            <div class="flex flex-col gap-4 flex-1 min-h-0">
                <div class="grid grid-cols-4 grid-rows-4 gap-3 flex-1 min-h-0">
                    {#each displayTiles as slot, i}
                        {@const absolutePos = currentPageIndex * POS_TILES_PER_PAGE + i + 1}
                        {#if slot}
                            <div
                                class="flat-card relative h-full min-h-0 overflow-hidden cursor-pointer flex flex-col hover:!border-accent-primary {!slot.product ? '!border-danger bg-danger/5' : ''}"
                                on:click={() => handleAssignedTileClick(slot.tile)}
                            >
                                {#if slot.product}
                                    <div
                                        class="relative w-full h-[88px] shrink-0 overflow-hidden"
                                        style="background-color: {slot.product.color || '#3b82f6'}"
                                    >
                                        {#if slot.product.image}
                                            <img class="absolute inset-0 h-full w-full object-cover" src={slot.product.image} alt={slot.product.name} />
                                        {/if}
                                        <div class="absolute bottom-2 right-2 rounded-sm bg-[var(--price-bg)] px-2 py-1 text-[0.9rem] font-bold text-[var(--price-text)]">
                                            {formatMoney(slot.product.price)}
                                        </div>
                                    </div>
                                    <div class="p-2 flex-1 flex flex-col justify-between">
                                        <h3 class="m-0 text-[0.95rem] leading-tight line-clamp-2">{slot.product.name}</h3>
                                        <p class="text-[0.75rem] text-text-muted mt-1">Pos: {absolutePos}</p>
                                    </div>
                                {:else}
                                    <div class="relative w-full h-[88px] flex items-center justify-center bg-bg-panel text-danger">
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="32"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
                                    </div>
                                    <div class="p-2 flex-1 flex flex-col justify-between">
                                        <h3 class="m-0 text-[0.95rem] !text-danger">Item Deleted</h3>
                                        <p class="text-[0.75rem] text-text-muted mt-1">Pos: {absolutePos}</p>
                                    </div>
                                {/if}
                            </div>
                        {:else}
                            <div
                                class="bg-transparent border-2 border-dashed border-border-flat rounded-md flex flex-col items-center justify-center text-text-muted cursor-pointer gap-2 hover:border-accent-primary hover:text-accent-primary hover:bg-accent-primary/5"
                                on:click={() => handleEmptyTileClick(absolutePos)}
                            >
                                <span class="text-[2rem] font-light">+</span>
                                <span>Pos {absolutePos}</span>
                            </div>
                        {/if}
                    {/each}
                </div>

                <div class="flex justify-between items-center bg-bg-card px-4 py-2 rounded-sm border border-border-flat">
                    <button
                        class="btn-icon flat-card"
                        disabled={currentPageIndex === 0}
                        on:click={() => currentPageIndex--}>&larr;</button
                    >
                    <span class="font-semibold text-text-muted">
                        Page {currentPageIndex + 1}
                    </span>
                    <button
                        class="btn-icon flat-card"
                        on:click={() => currentPageIndex++}>&rarr;</button
                    >
                </div>
            </div>
        {:else}
            <div class="placeholder">
                <h3>No Pages Available</h3>
                <p>Add a new page to start designing your POS layout.</p>
            </div>
        {/if}
    </main>
</div>

<!-- Page Editor Modal -->
{#if showPageModal}
    <div class="modal-overlay" on:click={() => (showPageModal = false)}>
        <div class="flat-panel modal-box" on:click|stopPropagation>
            <div class="modal-header">
                <h3>
                    {pageModalMode === "add" ? "Add POS Page" : "Edit POS Page"}
                </h3>
                <button class="modal-close" on:click={() => (showPageModal = false)}>✕</button>
            </div>
            <div class="modal-body">
                <div class="input-group">
                    <label>Page Name</label>
                    <input
                        type="text"
                        bind:value={editPageName}
                        class="flat-input"
                        autofocus
                        maxlength="20"
                    />
                </div>
                <div class="input-group">
                    <TouchColorPicker bind:value={editPageColor} label="Page Color" />
                </div>
            </div>
            <div class="modal-footer">
                {#if pageModalMode === "edit"}
                    <button class="btn btn-danger mr-auto" on:click={confirmDeletePage}>Delete Page</button>
                {/if}
                <button class="btn btn-secondary" on:click={() => (showPageModal = false)}>Cancel</button>
                <button class="btn btn-primary" on:click={savePage}>Save</button>
            </div>
        </div>
    </div>
{/if}

<!-- Tile Search Modal -->
{#if showTileSearchModal}
    <div class="modal-overlay" on:click={() => (showTileSearchModal = false)}>
        <div class="flat-panel modal-box large" on:click|stopPropagation>
            <div class="modal-header">
                <h3>Assign Product to Position {pendingTilePosition}</h3>
                <button class="modal-close" on:click={() => (showTileSearchModal = false)}>✕</button>
            </div>
            <div class="modal-body">
                <input
                    type="text"
                    bind:value={searchTerm}
                    placeholder="Search by name or SKU..."
                    class="flat-input w-full mb-3"
                    autofocus
                />
                <div class="max-h-[400px] overflow-y-auto flex flex-col gap-2">
                    {#each availableProducts as p}
                        <div
                            class="flat-card flex items-center gap-3 p-3 cursor-pointer hover:!border-accent-primary"
                            on:click={() => assignProductToTile(p.id)}
                        >
                            <div class="w-6 h-6 rounded" style="background:{p.color};"></div>
                            <div class="flex-1">
                                <strong>{p.name}</strong><br />
                                <span class="text-[0.8rem] text-text-muted">{p.sku}</span>
                            </div>
                            <span class="font-bold text-success">{formatMoney(p.price)}</span>
                        </div>
                    {/each}
                    {#if availableProducts.length === 0}
                        <p class="text-center text-text-muted p-5">
                            No matching products available.
                        </p>
                    {/if}
                </div>
            </div>
        </div>
    </div>
{/if}

<!-- Edit Tile Modal -->
{#if showEditTileModal}
    <div class="modal-overlay" on:click={() => (showEditTileModal = false)}>
        <div class="flat-panel modal-box" on:click|stopPropagation>
            <div class="modal-header">
                <h3>Edit Tile</h3>
                <button class="modal-close" on:click={() => (showEditTileModal = false)}>✕</button>
            </div>
            <div class="modal-body text-center">
                <p class="mb-5 text-text-muted">
                    Would you like to remove this tile?
                </p>
                <button class="btn btn-danger w-full h-[50px]" on:click={removeTile}>Remove Tile</button>
            </div>
        </div>
    </div>
{/if}

<ConfirmDialog 
    bind:show={showPageDelConfirm} 
    title="Delete POS Page" 
    message="Are you sure you want to delete this page and all its tiles? This cannot be undone."
    variant="danger"
    on:confirm={handlePageDelete}
/>
