<script lang="ts">
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import Modal from '$lib/components/Modal.svelte';
    import {
        discountsDB, promoGroupsDB, promoGroupItemsDB, productsDB,
        type Discount, type PromoGroup, type PromoGroupItem,
        uuid, now, formatMoney
    } from '$lib/stores/db';
    import { toast } from '$lib/stores/toast';
    import { upsert, remove as removeSql } from '$lib/stores/database';
    import TouchToggle from '$lib/components/TouchToggle.svelte';
    import TouchDateTimePicker from '$lib/components/TouchDateTimePicker.svelte';

    type Tab = 'bundle' | 'bogo' | 'percent';
    let tab: Tab = 'bundle';

    // ───── Bundle (group + discount as one entity in the UI) ─────
    let showBundle = false;
    let editingBundle = false;
    let curName = '';
    let curQty = 2;
    let curPrice = 0;
    let curStartAt = '';
    let curEndAt = '';
    let curActive = true;
    let curDiscountId = '';
    let curGroupId = '';
    let curProductIds: Set<string> = new Set();
    let productSearch = '';

    // Numpad for Bundle Price
    let showPricePad = false;
    let priceString = '0';

    // Numpad for Quantity
    let showQtyPad = false;
    let qtyString = '2';

    $: bundles = $discountsDB.filter(d => d.kind === 'bundle_fixed_price');

    function addBundle() {
        curDiscountId = uuid();
        curGroupId = uuid();
        curName = '';
        curQty = 2;
        curPrice = 0;
        curStartAt = '';
        curEndAt = '';
        curActive = true;
        curProductIds = new Set();
        productSearch = '';
        priceString = '0';
        qtyString = '2';
        editingBundle = false;
        showBundle = true;
    }

    function editBundle(d: Discount) {
        curDiscountId = d.id;
        curGroupId = d.groupId;
        curName = d.name;
        curQty = d.bundleQuantity || 2;
        curPrice = d.bundlePrice || 0;
        const g = $promoGroupsDB.find(g => g.id === d.groupId);
        curStartAt = g?.startAt || d.startAt || '';
        curEndAt = g?.endAt || d.endAt || '';
        curActive = d.isActive && (g?.isActive ?? true);
        curProductIds = new Set($promoGroupItemsDB.filter(i => i.groupId === d.groupId).map(i => i.productId));
        productSearch = '';
        priceString = d.bundlePrice.toString();
        qtyString = d.bundleQuantity.toString();
        editingBundle = true;
        showBundle = true;
    }

    async function saveBundle() {
        if (!curName.trim()) { toast('Name is required', 'error'); return; }
        if (curQty < 2) { toast('Quantity must be at least 2', 'error'); return; }
        if (curPrice <= 0) { toast('Bundle price must be greater than 0', 'error'); return; }
        if (curProductIds.size === 0) { toast('Pick at least one product', 'error'); return; }

        const group: PromoGroup = {
            id: curGroupId, name: curName, startAt: curStartAt, endAt: curEndAt,
            isActive: curActive, createdAt: now()
        };
        const discount: Discount = {
            id: curDiscountId, name: curName, type: 'fixed', value: 0,
            isActive: curActive, createdAt: now(), kind: 'bundle_fixed_price',
            autoApply: true, groupId: curGroupId,
            minQuantity: 0, secondPrice: 0,
            bundleQuantity: curQty, bundlePrice: curPrice,
            maxApplications: null, startAt: curStartAt, endAt: curEndAt, priority: 0
        };

        promoGroupsDB.update(list => editingBundle
            ? list.map(g => g.id === group.id ? group : g)
            : [...list, group]);
        discountsDB.update(list => editingBundle
            ? list.map(d => d.id === discount.id ? discount : d)
            : [...list, discount]);
        try { await upsert('promo_groups', group); } catch (e) { console.error(e); }
        try { await upsert('discounts', discount); } catch (e) { console.error(e); }

        // Reconcile group items.
        const oldItems = $promoGroupItemsDB.filter(i => i.groupId === curGroupId);
        for (const oi of oldItems) { try { await removeSql('promo_group_items', oi.id); } catch {} }
        const newItems: PromoGroupItem[] = Array.from(curProductIds).map(pid => ({
            id: uuid(), groupId: curGroupId, productId: pid
        }));
        for (const ni of newItems) { try { await upsert('promo_group_items', ni); } catch (e) { console.error(e); } }
        promoGroupItemsDB.update(list => [...list.filter(i => i.groupId !== curGroupId), ...newItems]);

        showBundle = false;
        toast(editingBundle ? 'Bundle updated' : 'Bundle added');
    }

    let showDeleteConfirm = false;
    let bundleToDelete: Discount | null = null;
    function delBundle(d: Discount) {
        bundleToDelete = d;
        showDeleteConfirm = true;
    }
    async function confirmDelete() {
        const d = bundleToDelete;
        if (!d) { showDeleteConfirm = false; return; }
        try {
            const items = $promoGroupItemsDB.filter(i => i.groupId === d.groupId);
            for (const it of items) await removeSql('promo_group_items', it.id);
            await removeSql('discounts', d.id);
            if (d.groupId) await removeSql('promo_groups', d.groupId);
            discountsDB.update(l => l.filter(x => x.id !== d.id));
            promoGroupsDB.update(l => l.filter(g => g.id !== d.groupId));
            promoGroupItemsDB.update(l => l.filter(i => i.groupId !== d.groupId));
            toast('Bundle deleted', 'info');
        } catch (e) {
            console.error('Delete bundle failed:', e);
            toast(`Delete failed: ${(e as Error)?.message || e}`, 'error');
        } finally {
            showDeleteConfirm = false;
            bundleToDelete = null;
        }
    }

    function toggleProduct(pid: string) {
        if (curProductIds.has(pid)) curProductIds.delete(pid);
        else curProductIds.add(pid);
        curProductIds = new Set(curProductIds);
    }

    $: filteredProducts = (() => {
        const q = productSearch.trim().toLowerCase();
        const all = $productsDB.filter(p => p.isActive);
        if (!q) return all.slice(0, 200);
        return all.filter(p =>
            p.name.toLowerCase().includes(q) ||
            (p.sku || '').toLowerCase().includes(q) ||
            (p.barcode || '').toLowerCase().includes(q)
        ).slice(0, 200);
    })();

    function bundleItemCount(d: Discount): number {
        return $promoGroupItemsDB.filter(i => i.groupId === d.groupId).length;
    }
    function bundleWindow(d: Discount): string {
        const g = $promoGroupsDB.find(g => g.id === d.groupId);
        const s = g?.startAt || d.startAt;
        const e = g?.endAt || d.endAt;
        if (!s && !e) return 'Always';
        return `${s || '—'} → ${e || '—'}`;
    }

    function handlePricePadKey(key: string) {
        if (key === 'C') {
            priceString = '0';
        } else if (key === 'DEL') {
            priceString = priceString.length > 1 ? priceString.slice(0, -1) : '0';
        } else if (key === 'ENTER') {
            showPricePad = false;
        } else if (key === '00') {
            if (priceString !== '0') priceString += '00';
        } else {
            if (priceString === '0') priceString = key;
            else priceString += key;
        }
        curPrice = parseInt(priceString) || 0;
    }

    function handleQtyPadKey(key: string) {
        if (key === 'C') {
            qtyString = '0';
        } else if (key === 'DEL') {
            qtyString = qtyString.length > 1 ? qtyString.slice(0, -1) : '0';
        } else if (key === 'ENTER') {
            showQtyPad = false;
        } else {
            if (qtyString === '0') qtyString = key;
            else qtyString += key;
        }
        curQty = parseInt(qtyString) || 2;
    }
</script>

<MgmtPage title="Discounts & Promotions">
    <div slot="actions" class="hdr-actions">
        <div class="tabs">
            <button class="tab-btn {tab==='bundle'?'active':''}" on:click={() => tab='bundle'}>Bundle Deals</button>
            <button class="tab-btn {tab==='bogo'?'active':''}" on:click={() => tab='bogo'}>BOGO</button>
            <button class="tab-btn {tab==='percent'?'active':''}" on:click={() => tab='percent'}>Percentage</button>
        </div>
        {#if tab==='bundle'}
            <button class="btn btn-primary" on:click={addBundle}>+ Add Bundle</button>
        {/if}
    </div>

    {#if tab==='bundle'}
        <table class="tbl">
            <thead><tr><th>Name</th><th>Deal</th><th>Items</th><th>Window</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
                {#each bundles as d}
                    <tr>
                        <td style="font-weight:600">{d.name}</td>
                        <td>Any {d.bundleQuantity} for {formatMoney(d.bundlePrice)}</td>
                        <td>{bundleItemCount(d)}</td>
                        <td>{bundleWindow(d)}</td>
                        <td><span class="tag" style="color:{d.isActive?'var(--success)':'var(--danger)'}">{d.isActive?'Active':'Inactive'}</span></td>
                        <td><div class="act-row">
                            <button class="btn-icon act-btn" on:click={() => editBundle(d)}>✎</button>
                            <button class="btn-icon act-btn danger" on:click={() => delBundle(d)}>✕</button>
                        </div></td>
                    </tr>
                {/each}
                {#if bundles.length===0}<tr class="empty-row"><td colspan="6">No bundle deals yet.</td></tr>{/if}
            </tbody>
        </table>
    {:else if tab==='bogo'}
        <div class="placeholder">BOGO promotions — coming soon.</div>
    {:else}
        <div class="placeholder">Percentage discounts — coming soon.</div>
    {/if}
</MgmtPage>

<Modal bind:show={showBundle} title={editingBundle ? 'Edit Bundle' : 'Add Bundle'} width="720px">
    <div class="form-grid">
        <div class="field span-2"><label>Bundle Name *</label><input bind:value={curName} placeholder="e.g. Any 3 Croissants for £4" /></div>
        <div class="field">
            <label>Quantity *</label>
            <div class="flex justify-between items-center px-3 py-2.5 bg-bg-panel border border-border-flat rounded-sm cursor-pointer transition-colors hover:border-accent-primary" on:click={() => showQtyPad = true}>
                <span class="text-text-main font-semibold">{curQty} items</span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="16"></line><line x1="8" y1="12" x2="16" y2="12"></line></svg>
            </div>
        </div>
        <div class="field">
            <label>Bundle Price (£) *</label>
            <div class="flex justify-between items-center px-3 py-2.5 bg-bg-panel border border-border-flat rounded-sm cursor-pointer transition-colors hover:border-accent-primary" on:click={() => showPricePad = true}>
                <span class="font-semibold text-success">{formatMoney(curPrice)}</span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line></svg>
            </div>
        </div>
        <div class="field"><TouchDateTimePicker label="Start Time (optional)" bind:value={curStartAt} /></div>
        <div class="field"><TouchDateTimePicker label="End Time (optional)" bind:value={curEndAt} /></div>
        <div class="span-2"><TouchToggle bind:checked={curActive} label="Active Status" /></div>

        <div class="field span-2 mt-2">
            <label>Products in this bundle ({curProductIds.size} selected)</label>
            <div class="relative">
                <input bind:value={productSearch} placeholder="Search products..." class="pr-10" />
                {#if productSearch}
                    <button class="absolute right-2 top-1/2 -translate-y-1/2 bg-transparent border-0 text-text-muted p-2 cursor-pointer" on:click={() => productSearch=''}>✕</button>
                {/if}
            </div>
        </div>
        <div class="span-2 max-h-[220px] overflow-y-auto border border-border-flat rounded-sm bg-bg-panel">
            {#each filteredProducts as p (p.id)}
                <label
                    class="grid grid-cols-[auto_1fr_auto_auto] gap-3 items-center px-2.5 py-1.5 border-b border-border-flat last:border-b-0 cursor-pointer text-[0.85rem] hover:bg-bg-card {curProductIds.has(p.id) ? 'bg-accent-primary/10' : ''}"
                >
                    <div class="flex w-6 h-6 items-center justify-center rounded-md border-2 transition-colors shrink-0 {curProductIds.has(p.id) ? 'bg-accent-primary border-accent-primary text-white' : 'bg-bg-panel border-border-flat'}">
                        {#if curProductIds.has(p.id)}
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" width="14"><polyline points="20 6 9 17 4 12"></polyline></svg>
                        {/if}
                    </div>
                    <input type="checkbox" class="hidden" checked={curProductIds.has(p.id)} on:change={() => toggleProduct(p.id)} />
                    <span class="text-text-main font-medium">{p.name}</span>
                    <span class="text-text-muted text-[0.8rem] font-mono">{p.sku || p.barcode || ''}</span>
                    <span class="text-text-main font-semibold min-w-[60px] text-right">{formatMoney(p.price)}</span>
                </label>
            {/each}
            {#if filteredProducts.length === 0}<div class="p-4 text-center text-text-muted text-[0.9rem]">No matches.</div>{/if}
            {#if filteredProducts.length === 200}<div class="p-4 text-center text-text-muted text-[0.9rem]">Showing first 200 — refine your search.</div>{/if}
        </div>
    </div>
    <svelte:fragment slot="footer">
        <button class="btn btn-danger" on:click={() => showBundle=false}>Cancel</button>
        <button class="btn btn-primary" on:click={saveBundle}>Save</button>
    </svelte:fragment>
</Modal>

<Modal bind:show={showDeleteConfirm} title="Delete Bundle?" width="420px">
    <p class="m-0 text-text-main">
        Delete bundle <strong>“{bundleToDelete?.name}”</strong>? This removes the deal and its product list.
    </p>
    <svelte:fragment slot="footer">
        <button class="btn btn-danger" on:click={() => { showDeleteConfirm = false; bundleToDelete = null; }}>Cancel</button>
        <button class="btn btn-primary" on:click={confirmDelete}>Delete</button>
    </svelte:fragment>
</Modal>


{#if showPricePad}
    <div class="modal-overlay !z-[1100]" on:click={() => showPricePad = false}>
        <div class="w-80 p-5 rounded-md flat-panel shadow-2xl" on:click|stopPropagation>
            <div class="flex justify-between items-center mb-4">
                <h3 class="m-0 text-base text-text-muted">Enter Bundle Price</h3>
                <button class="bg-transparent border-0 text-text-muted text-xl cursor-pointer" on:click={() => showPricePad = false}>✕</button>
            </div>
            <div class="p-5 text-3xl font-bold text-center text-success mb-4 flat-card">
                {formatMoney(parseInt(priceString || '0'))}
            </div>
            <div class="grid grid-cols-3 gap-2.5">
                {#each ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', 'DEL', 'C', 'ENTER'] as key}
                    <button
                        class="flat-card p-5 text-lg font-semibold text-center cursor-pointer transition-colors hover:!bg-bg-card-hover hover:border-accent-primary
                            {key === 'ENTER' ? '!bg-accent-primary !text-white !border-0 col-span-2 hover:!bg-accent-primary-hover' : ''}
                            {key === 'C' ? '!text-danger' : ''}
                            {key === 'DEL' ? '!text-accent-primary' : ''}"
                        on:click={() => handlePricePadKey(key)}
                    >
                        {key === 'DEL' ? '⌫' : key}
                    </button>
                {/each}
            </div>
        </div>
    </div>
{/if}

{#if showQtyPad}
    <div class="modal-overlay !z-[1100]" on:click={() => showQtyPad = false}>
        <div class="w-80 p-5 rounded-md flat-panel shadow-2xl" on:click|stopPropagation>
            <div class="flex justify-between items-center mb-4">
                <h3 class="m-0 text-base text-text-muted">Enter Quantity</h3>
                <button class="bg-transparent border-0 text-text-muted text-xl cursor-pointer" on:click={() => showQtyPad = false}>✕</button>
            </div>
            <div class="p-5 text-3xl font-bold text-center text-text-main mb-4 flat-card">
                {qtyString}
            </div>
            <div class="grid grid-cols-3 gap-2.5">
                {#each ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'DEL', 'C', 'ENTER'] as key}
                    <button
                        class="flat-card p-5 text-lg font-semibold text-center cursor-pointer transition-colors hover:!bg-bg-card-hover hover:border-accent-primary
                            {key === 'ENTER' ? '!bg-accent-primary !text-white !border-0 col-span-3 hover:!bg-accent-primary-hover' : ''}
                            {key === 'C' ? '!text-danger' : ''}
                            {key === 'DEL' ? '!text-accent-primary' : ''}"
                        on:click={() => handleQtyPadKey(key)}
                    >
                        {key === 'DEL' ? '⌫' : key}
                    </button>
                {/each}
            </div>
        </div>
    </div>
{/if}



