<script lang="ts">
    import { onDestroy, onMount } from 'svelte';
    import { get } from 'svelte/store';
    import { isTauri } from '@tauri-apps/api/core';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import Modal from '$lib/components/Modal.svelte';
    import PromotionEditor from '$lib/components/PromotionEditor.svelte';
    import { discountsDB, promoGroupsDB, promoGroupItemsDB, productsDB, uuid, now, formatMoney, type Discount, type Product, type PromoGroup, type PromoGroupItem } from '$lib/stores/db';
    import { savePromotionBundle, deletePromotionBundle, getPromotionEditSnapshot, getProductsByIds, type PromotionSnapshot } from '$lib/stores/database';
    import { promotionDraft, promotionOverlapNames, validatePromotionDraft, type PromotionDraft, type PromotionEditorKind, type PromotionValues } from '$lib/promotionEditor';

    type Tab = PromotionEditorKind;
    let tab: Tab = 'bundle';
    let promotionClock = Date.now();
    let promotionClockTimer: ReturnType<typeof setInterval> | null = null;
    let productCacheById = new Map<string, Product>();
    let loadedProductKey = '', productLoadToken = 0;
    let showEditor = false, editing = false;
    let draft = promotionDraft('bundle', uuid(), uuid());
    let editSnapshot: PromotionSnapshot | undefined;
    let draftItemsByProduct = new Map<string, PromoGroupItem>();
    let showDeleteConfirm = false;
    let bundleToDelete: Discount | null = null;
    let deleteSnapshot: PromotionSnapshot | undefined;
    let mutation: 'save' | 'delete' | null = null;
    let saveError = '', deleteError = '', feedback = '';
    const kindNames: Record<Tab, Discount['kind']> = { bundle: 'bundle_fixed_price', bogo: 'bogo_fixed_price', temporary: 'temporary_item', percent: 'manual_percent' };
    $: busy = mutation !== null;
    $: allDiscounts = [...new Map($discountsDB.filter(Boolean).map((discount) => [discount.id, discount])).values()];
    $: bundles = allDiscounts.filter((discount) => discountKind(discount) === kindNames.bundle);
    $: bogos = allDiscounts.filter((discount) => discountKind(discount) === kindNames.bogo);
    $: temporaryItems = allDiscounts.filter((discount) => discountKind(discount) === kindNames.temporary);
    $: percentages = allDiscounts.filter((discount) => discountKind(discount) === kindNames.percent);
    $: promoGroupById = new Map($promoGroupsDB.map((group) => [group.id, group]));
    $: promoItemCountsByGroup = $promoGroupItemsDB.reduce((counts, item) => counts.set(item.groupId, (counts.get(item.groupId) || 0) + 1), new Map<string, number>());
    $: firstPromoProductIdByGroup = $promoGroupItemsDB.reduce((map, item) => { if (!map.has(item.groupId)) map.set(item.groupId, item.productId); return map; }, new Map<string, string>());
    $: productNameById = new Map([...productCacheById].map(([id, product]) => [id, product.name]));
    $: referencedProducts = [...new Set($promoGroupItemsDB.map((item) => item.productId).filter(Boolean))];
    $: referencedProductKey = [...referencedProducts].sort().join('|');
    $: if (referencedProductKey !== loadedProductKey) { loadedProductKey = referencedProductKey; void loadProductNames(referencedProducts); }

    function numeric(value: unknown, fallback = 0) { const number = Number(value); return Number.isFinite(number) ? number : fallback; }
    function discountKind(discount: Discount) { return discount.kind || (discount.type === 'percentage' ? 'manual_percent' : 'manual_fixed'); }
    function cacheProducts(products: Product[]) { productCacheById = new Map([...productCacheById, ...products.map((product) => [product.id, product] as const)]); }
    async function fetchProducts(ids: string[]): Promise<Product[]> {
        if (!ids.length) return [];
        const wanted = new Set(ids);
        return isTauri() ? await getProductsByIds(ids, false, true) as Product[] : get(productsDB).filter((product) => wanted.has(product.id));
    }
    async function loadProductNames(ids: string[]) {
        const token = ++productLoadToken;
        try { const products = await fetchProducts(ids); if (token === productLoadToken) cacheProducts(products); }
        catch (error) { console.warn('Could not load promotion product names:', error); }
    }
    function openEditor(kind: Tab, discount?: Discount) {
        if (busy) return;
        const id = discount?.id || uuid(), groupId = kind === 'percent' ? '' : discount?.groupId || uuid();
        editing = Boolean(discount);
        draft = promotionDraft(kind, id, groupId, discount, promoGroupById.get(groupId), $promoGroupItemsDB);
        editSnapshot = getPromotionEditSnapshot(id, groupId);
        draftItemsByProduct = new Map((editSnapshot.items || []).map((item) => [item.productId, item as PromoGroupItem]));
        saveError = ''; feedback = ''; showEditor = true;
        void loadProductNames(draft.productIds);
    }
    const addBundle = () => openEditor('bundle');
    const addBogo = () => openEditor('bogo');
    const addTemporary = () => openEditor('temporary');
    const addPercent = () => openEditor('percent');
    const editBundle = (discount: Discount) => openEditor('bundle', discount);
    const editBogo = (discount: Discount) => openEditor('bogo', discount);
    const editTemporary = (discount: Discount) => openEditor('temporary', discount);
    const editPercent = (discount: Discount) => openEditor('percent', discount);
    function buildItems(groupId: string, productIds: string[]): PromoGroupItem[] {
        return [...new Set(productIds)].map((productId) => {
            let item = draftItemsByProduct.get(productId);
            if (!item) {
                item = { id: uuid(), groupId, productId, updatedAt: now() };
                draftItemsByProduct.set(productId, item);
            }
            return item;
        });
    }
    async function saveEditor(event: { draft: PromotionDraft; values: PromotionValues }) {
        if (busy) return;
        const submitted = event.draft;
        const checked = validatePromotionDraft(submitted);
        if (!checked.valid) { saveError = 'Check the promotion fields before saving.'; return; }
        mutation = 'save'; saveError = '';
        try {
            const freshProducts = await fetchProducts(submitted.productIds);
            cacheProducts(freshProducts);
            const products = new Map(freshProducts.map((product) => [product.id, product]));
            if (submitted.kind !== 'percent' && submitted.productIds.some((id) => !products.get(id)?.isActive)) throw new Error('Some selected products are unavailable or inactive. Remove them before saving.');
            const values = checked.values;
            if (submitted.kind === 'bogo' && freshProducts.some((product) => values.price >= product.price)) throw new Error('Next-item price must be below the normal price of every selected product.');
            if (submitted.kind === 'temporary' && submitted.temporaryType === 'fixed' && values.value >= freshProducts[0].price) throw new Error('The sale price must be below the normal item price.');
            const conflicts = submitted.kind === 'temporary' ? promotionOverlapNames(submitted, $discountsDB, $promoGroupsDB, $promoGroupItemsDB, Date.now(), true) : [];
            if (conflicts.length) throw new Error('This product already has an active offer in the same time window: ' + conflicts.join(', ') + '.');
            const timestamp = now(), oldDiscount = editSnapshot?.discounts.find((discount) => discount.id === submitted.id), oldGroup = editSnapshot?.group;
            const group: PromoGroup | null = submitted.kind === 'percent' ? null : {
                id: submitted.groupId, name: submitted.name, isActive: submitted.active,
                startAt: submitted.startAt, endAt: submitted.endAt,
                createdAt: oldGroup?.createdAt || timestamp, updatedAt: timestamp,
            };
            const discount: Discount = {
                id: submitted.id, name: submitted.name, isActive: submitted.active,
                type: submitted.kind === 'percent' ? 'percentage' : submitted.kind === 'temporary' ? submitted.temporaryType : 'fixed',
                value: submitted.kind === 'percent' || submitted.kind === 'temporary' ? values.value : 0,
                kind: kindNames[submitted.kind], autoApply: submitted.kind !== 'percent',
                groupId: group?.id || '', minQuantity: submitted.kind === 'bogo' ? values.quantity : submitted.kind === 'bundle' ? 0 : 1,
                secondPrice: submitted.kind === 'bogo' ? values.price : 0,
                bundleQuantity: submitted.kind === 'bundle' ? values.quantity : 0,
                bundlePrice: submitted.kind === 'bundle' ? values.price : 0,
                maxApplications: submitted.kind === 'bogo' ? values.maxApplications : null,
                startAt: submitted.kind === 'percent' ? '' : submitted.startAt, endAt: submitted.kind === 'percent' ? '' : submitted.endAt,
                priority: oldDiscount?.priority || 0, createdAt: oldDiscount?.createdAt || timestamp, updatedAt: timestamp,
            };
            await savePromotionBundle(group, discount, group ? buildItems(group.id, submitted.productIds) : [], editSnapshot);
            showEditor = false;
            feedback = (editing ? 'Updated ' : 'Added ') + submitted.name + '.';
        } catch (error) { saveError = 'Could not save this promotion. ' + String(error).replace(/^Error:\s*/, '') + ' Your draft is still open.'; }
        finally { mutation = null; }
    }
    function openDelete(discount: Discount) {
        if (busy) return;
        bundleToDelete = discount; deleteSnapshot = getPromotionEditSnapshot(discount.id, discount.groupId || '');
        deleteError = ''; feedback = ''; showDeleteConfirm = true;
    }
    const delBundle = openDelete, delBogo = openDelete, delTemporary = openDelete, delPercent = openDelete;
    async function confirmDelete() {
        if (busy || !bundleToDelete) return;
        const target = bundleToDelete;
        mutation = 'delete'; deleteError = '';
        try {
            await deletePromotionBundle(target.id, target.groupId || '', deleteSnapshot);
            showDeleteConfirm = false; bundleToDelete = null; feedback = 'Deleted ' + target.name + '.';
        } catch (error) { deleteError = 'Could not delete this promotion. ' + String(error).replace(/^Error:\s*/, ''); }
        finally { mutation = null; }
    }
    function temporaryDeal(discount: Discount) { return discount.type === 'percentage' ? discount.value + '% off' : formatMoney(discount.value) + ' sale price'; }
    function promotionStatus(discount: Discount, group: PromoGroup | undefined, clock: number) {
        if (!discount.isActive || group?.isActive === false) return 'Inactive';
        const starts = [discount.startAt, group?.startAt].filter(Boolean).map((value) => new Date(value!).getTime());
        const ends = [discount.endAt, group?.endAt].filter(Boolean).map((value) => new Date(value!).getTime());
        if ([...starts, ...ends].some(Number.isNaN)) return 'Invalid dates';
        const start = Math.max(-Infinity, ...starts), end = Math.min(Infinity, ...ends);
        if (start > end) return 'Invalid dates';
        if (clock > end) return 'Expired';
        if (clock < start) return 'Scheduled';
        return 'Active';
    }
    function promotionStatusClass(discount: Discount, group: PromoGroup | undefined, clock: number) {
        const status = promotionStatus(discount, group, clock);
        return status === 'Active' ? 'text-success' : status === 'Scheduled' ? 'text-warning' : 'text-danger';
    }
    function displayDate(value: string) {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? 'Invalid date' : date.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });
    }
    function bundleWindow(discount: Discount, group: PromoGroup | undefined) {
        const start = group?.startAt || discount.startAt, end = group?.endAt || discount.endAt;
        if (!start && !end) return 'Always';
        return [start ? 'From ' + displayDate(start) : '', end ? 'Until ' + displayDate(end) : ''].filter(Boolean).join(' · ');
    }
    onMount(() => { promotionClockTimer = setInterval(() => promotionClock = Date.now(), 30_000); });
    onDestroy(() => { if (promotionClockTimer) clearInterval(promotionClockTimer); productLoadToken++; });
</script>

<MgmtPage title="Discounts & Promotions">
    <div slot="actions">
        {#if tab==='bundle'}
            <button disabled={busy} class="btn btn-primary add-promotion-button" on:click={addBundle}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>Add Bundle</button>
        {:else if tab==='bogo'}
            <button disabled={busy} class="btn btn-primary add-promotion-button" on:click={addBogo}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>Add BOGO</button>
        {:else if tab==='temporary'}
            <button disabled={busy} class="btn btn-primary add-promotion-button" on:click={addTemporary}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>Add Temporary</button>
        {:else}
            <button disabled={busy} class="btn btn-primary add-promotion-button" on:click={addPercent}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>Add Percentage</button>
        {/if}
    </div>

    <div class="discount-page">
        {#if feedback}<div class="promotion-feedback" role="status">{feedback}</div>{/if}
        <nav class="promotion-tabs" aria-label="Promotion types">
            <button disabled={busy} class:active={tab === 'bundle'} aria-pressed={tab === 'bundle'} on:click={() => tab='bundle'}><span>Bundle Deals</span><small>{bundles.length}</small></button>
            <button disabled={busy} class:active={tab === 'bogo'} aria-pressed={tab === 'bogo'} on:click={() => tab='bogo'}><span>BOGO</span><small>{bogos.length}</small></button>
            <button disabled={busy} class:active={tab === 'temporary'} aria-pressed={tab === 'temporary'} on:click={() => tab='temporary'}><span>Temporary Item</span><small>{temporaryItems.length}</small></button>
            <button disabled={busy} class:active={tab === 'percent'} aria-pressed={tab === 'percent'} on:click={() => tab='percent'}><span>Percentage</span><small>{percentages.length}</small></button>
        </nav>

        <div class="promotion-table-wrap">
            {#if tab==='bundle'}
                <table class="tbl promotion-table">
                    <thead><tr><th>Name</th><th>Deal</th><th>Items</th><th>Window</th><th>Status</th><th class="actions-heading">Actions</th></tr></thead>
                    <tbody>
                        {#each bundles as d (d.id)}
                            {@const group = promoGroupById.get(d.groupId)}
                            <tr>
                                <td class="font-semibold">{d.name}</td>
                                <td>Any {numeric(d.bundleQuantity)} for {formatMoney(numeric(d.bundlePrice))}</td>
                                <td>{promoItemCountsByGroup.get(d.groupId) || 0}</td>
                                <td class="window-cell">{bundleWindow(d, group)}</td>
                                <td><span class="tag {promotionStatusClass(d, group, promotionClock)}">{promotionStatus(d, group, promotionClock)}</span></td>
                                <td class="action-cell"><div class="act-row">
                                    <button disabled={busy} class="btn-icon act-btn" title={`Edit ${d.name}`} aria-label={`Edit ${d.name}`} on:click={() => editBundle(d)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg></button>
                                    <button disabled={busy} class="btn-icon act-btn danger" title={`Delete ${d.name}`} aria-label={`Delete ${d.name}`} on:click={() => delBundle(d)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5"></path></svg></button>
                                </div></td>
                            </tr>
                        {/each}
                        {#if bundles.length===0}<tr class="empty-row"><td colspan="6">No bundle deals yet.</td></tr>{/if}
                    </tbody>
                </table>
            {:else if tab==='bogo'}
                <table class="tbl promotion-table promotion-table-wide">
                    <thead><tr><th>Name</th><th>Deal</th><th>Items</th><th>Window</th><th>Limit</th><th>Status</th><th class="actions-heading">Actions</th></tr></thead>
                    <tbody>
                        {#each bogos as d (d.id)}
                            {@const group = promoGroupById.get(d.groupId)}
                            <tr>
                                <td class="font-semibold">{d.name}</td>
                                <td>Buy {numeric(d.minQuantity, 1)}, next for {formatMoney(numeric(d.secondPrice))}</td>
                                <td>{promoItemCountsByGroup.get(d.groupId) || 0}</td>
                                <td class="window-cell">{bundleWindow(d, group)}</td>
                                <td>{d.maxApplications == null ? 'Unlimited' : `${numeric(d.maxApplications)} per sale`}</td>
                                <td><span class="tag {promotionStatusClass(d, group, promotionClock)}">{promotionStatus(d, group, promotionClock)}</span></td>
                                <td class="action-cell"><div class="act-row">
                                    <button disabled={busy} class="btn-icon act-btn" title={`Edit ${d.name}`} aria-label={`Edit ${d.name}`} on:click={() => editBogo(d)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg></button>
                                    <button disabled={busy} class="btn-icon act-btn danger" title={`Delete ${d.name}`} aria-label={`Delete ${d.name}`} on:click={() => delBogo(d)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5"></path></svg></button>
                                </div></td>
                            </tr>
                        {/each}
                        {#if bogos.length===0}<tr class="empty-row"><td colspan="7">No BOGO promotions yet.</td></tr>{/if}
                    </tbody>
                </table>
            {:else if tab==='temporary'}
                <table class="tbl promotion-table">
                    <thead><tr><th>Name</th><th>Item</th><th>Temporary Deal</th><th>Window</th><th>Status</th><th class="actions-heading">Actions</th></tr></thead>
                    <tbody>
                        {#each temporaryItems as d (d.id)}
                            {@const group = promoGroupById.get(d.groupId)}
                            {@const productId = firstPromoProductIdByGroup.get(d.groupId) || ''}
                            <tr>
                                <td class="font-semibold">{d.name}</td>
                                <td>{productNameById.get(productId) || 'Unknown item'}</td>
                                <td>{temporaryDeal(d)}</td>
                                <td class="window-cell">{bundleWindow(d, group)}</td>
                                <td><span class="tag {promotionStatusClass(d, group, promotionClock)}">{promotionStatus(d, group, promotionClock)}</span></td>
                                <td class="action-cell"><div class="act-row">
                                    <button disabled={busy} class="btn-icon act-btn" title={`Edit ${d.name}`} aria-label={`Edit ${d.name}`} on:click={() => editTemporary(d)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg></button>
                                    <button disabled={busy} class="btn-icon act-btn danger" title={`Delete ${d.name}`} aria-label={`Delete ${d.name}`} on:click={() => delTemporary(d)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5"></path></svg></button>
                                </div></td>
                            </tr>
                        {/each}
                        {#if temporaryItems.length===0}<tr class="empty-row"><td colspan="6">No temporary item discounts yet.</td></tr>{/if}
                    </tbody>
                </table>
            {:else}
                <table class="tbl promotion-table">
                    <thead><tr><th>Name</th><th>Discount</th><th>Applied By</th><th>Status</th><th class="actions-heading">Actions</th></tr></thead>
                    <tbody>
                        {#each percentages as d (d.id)}
                            <tr>
                                <td class="font-semibold">{d.name}</td>
                                <td>{numeric(d.value)}% off</td>
                                <td>Manual at checkout</td>
                                <td><span class="tag {d.isActive ? 'text-success' : 'text-danger'}">{d.isActive?'Active':'Inactive'}</span></td>
                                <td class="action-cell"><div class="act-row">
                                    <button disabled={busy} class="btn-icon act-btn" title={`Edit ${d.name}`} aria-label={`Edit ${d.name}`} on:click={() => editPercent(d)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg></button>
                                    <button disabled={busy} class="btn-icon act-btn danger" title={`Delete ${d.name}`} aria-label={`Delete ${d.name}`} on:click={() => delPercent(d)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5"></path></svg></button>
                                </div></td>
                            </tr>
                        {/each}
                        {#if percentages.length===0}<tr class="empty-row"><td colspan="5">No percentage discounts yet.</td></tr>{/if}
                    </tbody>
                </table>
            {/if}
        </div>
    </div>
</MgmtPage>

{#if showEditor}<PromotionEditor bind:show={showEditor} {editing} {draft} {busy} error={saveError} productsById={productCacheById} on:save={(event) => saveEditor(event.detail)} on:loaded={(event) => cacheProducts(event.detail)} />{/if}
<Modal bind:show={showDeleteConfirm} title="Delete Promotion?" width="440px" dismissDisabled={busy}>
    {#if deleteError}<p class="delete-promotion-error" role="alert">{deleteError}</p>{/if}
    <p class="delete-promotion-copy">Delete <strong>“{bundleToDelete?.name}”</strong>? This removes the promotion and its product list.</p>
    <svelte:fragment slot="footer"><button class="btn btn-secondary" disabled={busy} on:click={() => showDeleteConfirm = false}>Cancel</button><button class="btn btn-danger" disabled={busy} on:click={confirmDelete}>{mutation === 'delete' ? 'Deleting…' : 'Delete'}</button></svelte:fragment>
</Modal>

<style>
    .promotion-feedback { flex:none; padding:10px 16px; color:var(--success); font-size:.82rem; border-bottom:1px solid var(--border-flat); overflow-wrap:anywhere; }
    .delete-promotion-error { color:var(--danger); font-size:.82rem; overflow-wrap:anywhere; }
    .delete-promotion-copy { overflow-wrap:anywhere; }
    .discount-page button:disabled { opacity:.45; cursor:not-allowed; }

    .add-promotion-button { min-width: 168px; display: inline-flex; align-items: center; justify-content: center; gap: .5rem; }
    .add-promotion-button svg { width: 19px; height: 19px; flex: 0 0 19px; }
    .discount-page { height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
    .promotion-tabs { padding: .7rem 1rem; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: .55rem; border-bottom: 1px solid var(--border-flat); background: var(--bg-panel); }
    .promotion-tabs button { min-width: 0; min-height: 50px; padding: .55rem .75rem; display: flex; align-items: center; justify-content: space-between; gap: .55rem; color: var(--text-muted); border: 1px solid var(--border-flat); border-radius: .4rem; background: var(--bg-card); cursor: pointer; }
    .promotion-tabs button:hover { color: var(--text-main); border-color: var(--accent-primary); background: var(--bg-card-hover); }
    .promotion-tabs button.active { color: white; border-color: var(--accent-primary); background: var(--accent-primary); }
    .promotion-tabs span { min-width: 0; overflow: hidden; font-size: .82rem; font-weight: 900; text-overflow: ellipsis; white-space: nowrap; }
    .promotion-tabs small { min-width: 25px; height: 25px; padding: 0 .35rem; display: grid; place-items: center; flex: 0 0 auto; font-size: .68rem; font-weight: 900; border-radius: 50%; background: var(--bg-panel); }
    .promotion-tabs button.active small { color: var(--accent-primary); background: white; }
    .promotion-table-wrap { min-height: 0; flex: 1; overflow: auto; overscroll-behavior: contain; }
    .promotion-table { width: 100%; min-width: 760px; }
    .promotion-table-wide { min-width: 890px; }
    .promotion-table th { position: sticky; top: 0; z-index: 2; }
    .promotion-table td { vertical-align: middle; }
    .promotion-table .empty-row td { height: 96px; }
    .window-cell { min-width: 180px; max-width: 260px; color: var(--text-muted); font-size: .78rem; line-height: 1.4; }
    .actions-heading { width: 118px; text-align: right; }
    .action-cell { width: 118px; }
    .act-row { display: grid; grid-template-columns: repeat(2, 42px); justify-content: end; gap: .45rem; }
    .act-row .act-btn { width: 42px !important; height: 42px !important; min-width: 42px !important; min-height: 42px !important; border-radius: .4rem; }
    .act-row svg { width: 18px; height: 18px; }
    :global(.back-office-route) .promotion-tabs { padding: .45rem .55rem; gap: .35rem; }
    :global(.back-office-route) .promotion-tabs button { min-height: 40px; padding: .4rem .55rem; }
    :global(.back-office-route) .promotion-table { min-width: 560px; table-layout: fixed; }
    :global(.back-office-route) .promotion-table-wide { min-width: 620px; }
    :global(.back-office-route) .window-cell { min-width: 0; max-width: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    :global(.back-office-route) .discount-page .promotion-table :where(.actions-heading, .action-cell) { width: 92px !important; }
    :global(.back-office-route) .discount-page .promotion-table .act-row { grid-template-columns: repeat(2, 32px) !important; gap: .25rem !important; }
    :global(.back-office-route) .discount-page .promotion-table .act-row .act-btn { width: 32px !important; height: 32px !important; min-width: 32px !important; min-height: 32px !important; }
    @media (min-width: 701px) and (max-width: 900px) {
        .promotion-tabs { padding: .55rem .7rem; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .45rem; }
        .promotion-tabs button { min-height: 44px; padding: .45rem .65rem; }
        .promotion-tabs span { overflow: visible; text-overflow: clip; }
        .promotion-table { width: 100%; min-width: 700px; table-layout: fixed; }
        .promotion-table-wide { min-width: 700px; }
        .promotion-table :global(th), .promotion-table :global(td) { padding-inline: .5rem; overflow: hidden; text-overflow: ellipsis; }
        .window-cell { min-width: 0; max-width: none; white-space: nowrap; }
        .actions-heading, .action-cell { width: 118px; }
    }
    @media (max-width: 700px) {
        .add-promotion-button { min-width: 142px; }
        .promotion-tabs { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
</style>
