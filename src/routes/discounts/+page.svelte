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
    import CustomSelect from '$lib/components/CustomSelect.svelte';

    type Tab = 'bundle' | 'bogo' | 'temporary' | 'percent';
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

    function discountKind(discount: Discount): string {
        if (discount.kind) return discount.kind;
        return discount.type === 'percentage' ? 'manual_percent' : 'manual_fixed';
    }

    function numeric(value: unknown, fallback = 0): number {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function safeDiscounts(kind: string): Discount[] {
        return $discountsDB.filter((discount) => discount && discountKind(discount) === kind);
    }

    $: bundles = safeDiscounts('bundle_fixed_price');
    $: bogos = safeDiscounts('bogo_fixed_price');
    $: temporaryItems = safeDiscounts('temporary_item');
    $: percentages = safeDiscounts('manual_percent');

    function validatePromotionWindow(startAt: string, endAt: string): boolean {
        if (startAt && Number.isNaN(new Date(startAt).getTime())) {
            toast('Start time is not valid', 'error');
            return false;
        }
        if (endAt && Number.isNaN(new Date(endAt).getTime())) {
            toast('End time is not valid', 'error');
            return false;
        }
        if (startAt && endAt && new Date(endAt).getTime() <= new Date(startAt).getTime()) {
            toast('End time must be after the start time', 'error');
            return false;
        }
        return true;
    }

    // ───── Temporary single-item offers ─────
    let showTemporary = false;
    let editingTemporary = false;
    let temporaryId = '';
    let temporaryGroupId = '';
    let temporaryName = '';
    let temporaryProductId = '';
    let temporaryType: 'percentage' | 'fixed' = 'percentage';
    let temporaryValue = 10;
    let temporaryStartAt = '';
    let temporaryEndAt = '';
    let temporaryActive = true;
    let temporaryProductSearch = '';

    function addTemporary() {
        temporaryId = uuid();
        temporaryGroupId = uuid();
        temporaryName = '';
        temporaryProductId = '';
        temporaryType = 'percentage';
        temporaryValue = 10;
        temporaryStartAt = '';
        temporaryEndAt = '';
        temporaryActive = true;
        temporaryProductSearch = '';
        editingTemporary = false;
        showTemporary = true;
    }

    function editTemporary(d: Discount) {
        const group = $promoGroupsDB.find(g => g.id === d.groupId);
        temporaryId = d.id;
        temporaryGroupId = d.groupId;
        temporaryName = d.name;
        temporaryProductId = $promoGroupItemsDB.find(item => item.groupId === d.groupId)?.productId || '';
        temporaryType = d.type;
        temporaryValue = d.type === 'fixed' ? d.value / 100 : d.value;
        temporaryStartAt = group?.startAt || d.startAt || '';
        temporaryEndAt = group?.endAt || d.endAt || '';
        temporaryActive = d.isActive && (group?.isActive ?? true);
        temporaryProductSearch = '';
        editingTemporary = true;
        showTemporary = true;
    }

    async function saveTemporary() {
        if (!temporaryName.trim()) { toast('Name is required', 'error'); return; }
        if (!temporaryProductId) { toast('Select an item', 'error'); return; }
        if (!isPromotionEligible(temporaryProductId)) { toast('Choose an active item that is shown on the POS', 'error'); return; }
        const inputValue = Number(temporaryValue);
        if (!Number.isFinite(inputValue) || inputValue <= 0) { toast('Discount value must be greater than zero', 'error'); return; }
        if (temporaryType === 'percentage' && inputValue > 100) { toast('Percentage cannot exceed 100', 'error'); return; }
        if (!validatePromotionWindow(temporaryStartAt, temporaryEndAt)) return;
        const conflicting = temporaryItems.find(discount =>
            discount.id !== temporaryId &&
            $promoGroupItemsDB.some(item => item.groupId === discount.groupId && item.productId === temporaryProductId)
        );
        if (conflicting) {
            toast(`This item already has the temporary discount "${conflicting.name}"`, 'error');
            return;
        }
        const product = $productsDB.find(p => p.id === temporaryProductId);
        const storedValue = temporaryType === 'fixed' ? Math.round(inputValue * 100) : inputValue;
        if (temporaryType === 'fixed' && product && storedValue >= product.price) {
            toast('Temporary sale price must be lower than the normal item price', 'error');
            return;
        }

        const timestamp = now();
        const existingGroup = $promoGroupsDB.find(g => g.id === temporaryGroupId);
        const existingDiscount = $discountsDB.find(d => d.id === temporaryId);
        const group: PromoGroup = {
            id: temporaryGroupId, name: temporaryName.trim(), startAt: temporaryStartAt,
            endAt: temporaryEndAt, isActive: temporaryActive,
            createdAt: existingGroup?.createdAt || timestamp, updatedAt: timestamp
        };
        const discount: Discount = {
            id: temporaryId, name: temporaryName.trim(), type: temporaryType, value: storedValue,
            isActive: temporaryActive, createdAt: existingDiscount?.createdAt || timestamp,
            updatedAt: timestamp, kind: 'temporary_item', autoApply: true,
            groupId: temporaryGroupId, minQuantity: 1, secondPrice: 0, bundleQuantity: 0,
            bundlePrice: 0, maxApplications: null, startAt: temporaryStartAt,
            endAt: temporaryEndAt, priority: 0
        };
        try {
            await upsert('promo_groups', group);
            await upsert('discounts', discount);
            const items = await replaceGroupItems(temporaryGroupId, new Set([temporaryProductId]));
            promoGroupsDB.update(list => editingTemporary ? list.map(g => g.id === group.id ? group : g) : [...list, group]);
            discountsDB.update(list => editingTemporary ? list.map(d => d.id === discount.id ? discount : d) : [...list, discount]);
            promoGroupItemsDB.update(list => [...list.filter(i => i.groupId !== temporaryGroupId), ...items]);
            showTemporary = false;
            toast(editingTemporary ? 'Temporary discount updated' : 'Temporary discount added');
        } catch (error) {
            toast(`Could not save temporary discount: ${error}`, 'error');
        }
    }

    function delTemporary(d: Discount) {
        bundleToDelete = d;
        showDeleteConfirm = true;
    }

    function temporaryProductName(d: Discount): string {
        const productId = $promoGroupItemsDB.find(item => item.groupId === d.groupId)?.productId;
        return $productsDB.find(product => product.id === productId)?.name || 'Unknown item';
    }

    function temporaryDeal(d: Discount): string {
        return d.type === 'percentage' ? `${numeric(d.value)}% off` : `${formatMoney(numeric(d.value))} sale price`;
    }

    function selectTemporaryProduct(productId: string) {
        temporaryProductId = productId;
    }

    function isPromotionEligible(productId: string): boolean {
        return $productsDB.some(p => p.id === productId && p.isActive && p.showInPos !== false);
    }

    $: filteredTemporaryProducts = (() => {
        const q = temporaryProductSearch.trim().toLowerCase();
        const all = $productsDB.filter(p => p.isActive && p.showInPos !== false);
        if (!q) return all.slice(0, 200);
        return all.filter(p =>
            p.name.toLowerCase().includes(q) ||
            (p.sku || '').toLowerCase().includes(q) ||
            (p.barcode || '').toLowerCase().includes(q) ||
            (p.scalePlu || '').toLowerCase().includes(q)
        ).slice(0, 200);
    })();

    $: selectedTemporaryProduct = $productsDB.find(p => p.id === temporaryProductId);

    function promotionStatus(d: Discount): string {
        const group = d.groupId ? $promoGroupsDB.find(g => g.id === d.groupId) : null;
        if (!d.isActive || group?.isActive === false) return 'Inactive';
        const startAt = group?.startAt || d.startAt;
        const endAt = group?.endAt || d.endAt;
        const current = Date.now();
        if (startAt && current < new Date(startAt).getTime()) return 'Scheduled';
        if (endAt && current > new Date(endAt).getTime()) return 'Expired';
        return 'Active';
    }

    function promotionStatusClass(d: Discount): string {
        const status = promotionStatus(d);
        if (status === 'Active') return 'text-success';
        if (status === 'Scheduled') return 'text-warning';
        return 'text-danger';
    }

    // ───── BOGO ─────
    let showBogo = false;
    let editingBogo = false;
    let bogoId = '';
    let bogoGroupId = '';
    let bogoName = '';
    let bogoBuyQty = 1;
    let bogoSecondPricePounds = 0;
    let bogoMaxApplications: number | null = null;
    let bogoStartAt = '';
    let bogoEndAt = '';
    let bogoActive = true;
    let bogoProductIds: Set<string> = new Set();
    let bogoProductSearch = '';

    function addBogo() {
        bogoId = uuid();
        bogoGroupId = uuid();
        bogoName = '';
        bogoBuyQty = 1;
        bogoSecondPricePounds = 0;
        bogoMaxApplications = null;
        bogoStartAt = '';
        bogoEndAt = '';
        bogoActive = true;
        bogoProductIds = new Set();
        bogoProductSearch = '';
        editingBogo = false;
        showBogo = true;
    }

    function editBogo(d: Discount) {
        const g = $promoGroupsDB.find(g => g.id === d.groupId);
        bogoId = d.id;
        bogoGroupId = d.groupId;
        bogoName = d.name;
        bogoBuyQty = d.minQuantity || 1;
        bogoSecondPricePounds = numeric(d.secondPrice) / 100;
        bogoMaxApplications = d.maxApplications ?? null;
        bogoStartAt = g?.startAt || d.startAt || '';
        bogoEndAt = g?.endAt || d.endAt || '';
        bogoActive = d.isActive && (g?.isActive ?? true);
        bogoProductIds = new Set($promoGroupItemsDB.filter(i => i.groupId === d.groupId).map(i => i.productId));
        bogoProductSearch = '';
        editingBogo = true;
        showBogo = true;
    }

    async function saveBogo() {
        if (!bogoName.trim()) { toast('Name is required', 'error'); return; }
        const buyQty = Number(bogoBuyQty);
        const secondPricePounds = Number(bogoSecondPricePounds);
        const maxApplications = bogoMaxApplications === null ? null : Number(bogoMaxApplications);
        if (!Number.isInteger(buyQty) || buyQty < 1) { toast('Buy quantity must be a whole number of at least 1', 'error'); return; }
        if (!Number.isFinite(secondPricePounds) || secondPricePounds < 0) { toast('Discounted price cannot be negative', 'error'); return; }
        if (maxApplications !== null && (!Number.isInteger(maxApplications) || maxApplications < 1)) { toast('Maximum uses must be a whole number of at least 1', 'error'); return; }
        if (!validatePromotionWindow(bogoStartAt, bogoEndAt)) return;
        if (bogoProductIds.size === 0) { toast('Pick at least one product', 'error'); return; }
        if (Array.from(bogoProductIds).some(id => !isPromotionEligible(id))) {
            toast('Remove deactivated or hidden items before saving this promotion', 'error');
            return;
        }

        const timestamp = now();
        const existingGroup = $promoGroupsDB.find(g => g.id === bogoGroupId);
        const existingDiscount = $discountsDB.find(d => d.id === bogoId);
        const group: PromoGroup = {
            id: bogoGroupId, name: bogoName.trim(), startAt: bogoStartAt, endAt: bogoEndAt,
            isActive: bogoActive, createdAt: existingGroup?.createdAt || timestamp, updatedAt: timestamp
        };
        const discount: Discount = {
            id: bogoId, name: bogoName.trim(), type: 'fixed', value: 0,
            isActive: bogoActive, createdAt: existingDiscount?.createdAt || timestamp,
            updatedAt: timestamp, kind: 'bogo_fixed_price',
            autoApply: true, groupId: bogoGroupId, minQuantity: buyQty,
            secondPrice: Math.round(secondPricePounds * 100), bundleQuantity: 0, bundlePrice: 0,
            maxApplications,
            startAt: bogoStartAt, endAt: bogoEndAt, priority: 0
        };

        try {
            await upsert('promo_groups', group);
            await upsert('discounts', discount);
            const items = await replaceGroupItems(bogoGroupId, bogoProductIds);
            promoGroupsDB.update(list => editingBogo ? list.map(g => g.id === group.id ? group : g) : [...list, group]);
            discountsDB.update(list => editingBogo ? list.map(d => d.id === discount.id ? discount : d) : [...list, discount]);
            promoGroupItemsDB.update(list => [...list.filter(i => i.groupId !== bogoGroupId), ...items]);
            showBogo = false;
            toast(editingBogo ? 'BOGO promotion updated' : 'BOGO promotion added');
        } catch (error) {
            toast(`Could not save BOGO promotion: ${error}`, 'error');
        }
    }

    // ───── Manual percentage discounts ─────
    let showPercent = false;
    let editingPercent = false;
    let percentId = '';
    let percentName = '';
    let percentValue = 10;
    let percentActive = true;

    function addPercent() {
        percentId = uuid();
        percentName = '';
        percentValue = 10;
        percentActive = true;
        editingPercent = false;
        showPercent = true;
    }

    function editPercent(d: Discount) {
        percentId = d.id;
        percentName = d.name;
        percentValue = numeric(d.value, 10);
        percentActive = d.isActive;
        editingPercent = true;
        showPercent = true;
    }

    async function savePercent() {
        if (!percentName.trim()) { toast('Name is required', 'error'); return; }
        const value = Number(percentValue);
        if (!Number.isFinite(value) || value <= 0 || value > 100) { toast('Percentage must be between 1 and 100', 'error'); return; }
        const timestamp = now();
        const existingDiscount = $discountsDB.find(d => d.id === percentId);
        const discount: Discount = {
            id: percentId, name: percentName.trim(), type: 'percentage', value,
            isActive: percentActive, createdAt: existingDiscount?.createdAt || timestamp,
            updatedAt: timestamp, kind: 'manual_percent', autoApply: false,
            groupId: '', minQuantity: 1, secondPrice: 0, bundleQuantity: 0, bundlePrice: 0,
            maxApplications: null, startAt: '', endAt: '', priority: 0
        };
        try {
            await upsert('discounts', discount);
            discountsDB.update(list => editingPercent ? list.map(d => d.id === discount.id ? discount : d) : [...list, discount]);
            showPercent = false;
            toast(editingPercent ? 'Percentage discount updated' : 'Percentage discount added');
        } catch (error) {
            toast(`Could not save percentage discount: ${error}`, 'error');
        }
    }

    async function replaceGroupItems(groupId: string, productIds: Set<string>): Promise<PromoGroupItem[]> {
        const oldItems = $promoGroupItemsDB.filter(i => i.groupId === groupId);
        const existingByProduct = new Map(oldItems.map(item => [item.productId, item]));
        const timestamp = now();
        for (const item of oldItems) {
            if (!productIds.has(item.productId)) await removeSql('promo_group_items', item.id);
        }
        const keptItems = oldItems.filter(item => productIds.has(item.productId));
        const newItems: PromoGroupItem[] = Array.from(productIds)
            .filter(productId => !existingByProduct.has(productId))
            .map(productId => ({ id: uuid(), groupId, productId, updatedAt: timestamp }));
        for (const item of newItems) await upsert('promo_group_items', item);
        return [...keptItems, ...newItems];
    }

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
        curQty = numeric(d.bundleQuantity, 2) || 2;
        curPrice = numeric(d.bundlePrice);
        const g = $promoGroupsDB.find(g => g.id === d.groupId);
        curStartAt = g?.startAt || d.startAt || '';
        curEndAt = g?.endAt || d.endAt || '';
        curActive = d.isActive && (g?.isActive ?? true);
        curProductIds = new Set($promoGroupItemsDB.filter(i => i.groupId === d.groupId).map(i => i.productId));
        productSearch = '';
        priceString = String(numeric(d.bundlePrice));
        qtyString = String(numeric(d.bundleQuantity, 2));
        editingBundle = true;
        showBundle = true;
    }

    async function saveBundle() {
        if (!curName.trim()) { toast('Name is required', 'error'); return; }
        const bundleQty = Number(curQty);
        const bundlePrice = Number(curPrice);
        if (!Number.isInteger(bundleQty) || bundleQty < 2) { toast('Quantity must be a whole number of at least 2', 'error'); return; }
        if (!Number.isInteger(bundlePrice) || bundlePrice <= 0) { toast('Bundle price must be greater than 0', 'error'); return; }
        if (!validatePromotionWindow(curStartAt, curEndAt)) return;
        if (curProductIds.size === 0) { toast('Pick at least one product', 'error'); return; }
        if (Array.from(curProductIds).some(id => !isPromotionEligible(id))) {
            toast('Remove deactivated or hidden items before saving this promotion', 'error');
            return;
        }

        const timestamp = now();
        const existingGroup = $promoGroupsDB.find(g => g.id === curGroupId);
        const existingDiscount = $discountsDB.find(d => d.id === curDiscountId);
        const group: PromoGroup = {
            id: curGroupId, name: curName, startAt: curStartAt, endAt: curEndAt,
            isActive: curActive, createdAt: existingGroup?.createdAt || timestamp, updatedAt: timestamp
        };
        const discount: Discount = {
            id: curDiscountId, name: curName, type: 'fixed', value: 0,
            isActive: curActive, createdAt: existingDiscount?.createdAt || timestamp,
            updatedAt: timestamp, kind: 'bundle_fixed_price',
            autoApply: true, groupId: curGroupId,
            minQuantity: 0, secondPrice: 0,
            bundleQuantity: bundleQty, bundlePrice,
            maxApplications: null, startAt: curStartAt, endAt: curEndAt, priority: 0
        };

        try {
            await upsert('promo_groups', group);
            await upsert('discounts', discount);
            const items = await replaceGroupItems(curGroupId, curProductIds);
            promoGroupsDB.update(list => editingBundle
                ? list.map(g => g.id === group.id ? group : g)
                : [...list, group]);
            discountsDB.update(list => editingBundle
                ? list.map(d => d.id === discount.id ? discount : d)
                : [...list, discount]);
            promoGroupItemsDB.update(list => [...list.filter(i => i.groupId !== curGroupId), ...items]);
            showBundle = false;
            toast(editingBundle ? 'Bundle updated' : 'Bundle added');
        } catch (error) {
            toast(`Could not save bundle: ${error}`, 'error');
        }
    }

    let showDeleteConfirm = false;
    let bundleToDelete: Discount | null = null;
    function delBundle(d: Discount) {
        bundleToDelete = d;
        showDeleteConfirm = true;
    }
    function delBogo(d: Discount) {
        bundleToDelete = d;
        showDeleteConfirm = true;
    }
    function delPercent(d: Discount) {
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
            toast('Promotion deleted', 'info');
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
        const all = $productsDB.filter(p => p.isActive && p.showInPos !== false);
        if (!q) return all.slice(0, 200);
        return all.filter(p =>
            p.name.toLowerCase().includes(q) ||
            (p.sku || '').toLowerCase().includes(q) ||
            (p.barcode || '').toLowerCase().includes(q)
        ).slice(0, 200);
    })();
    $: selectedBundleProducts = $productsDB.filter(p => curProductIds.has(p.id));

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

    function toggleBogoProduct(pid: string) {
        if (bogoProductIds.has(pid)) bogoProductIds.delete(pid);
        else bogoProductIds.add(pid);
        bogoProductIds = new Set(bogoProductIds);
    }

    $: filteredBogoProducts = (() => {
        const q = bogoProductSearch.trim().toLowerCase();
        const all = $productsDB.filter(p => p.isActive && p.showInPos !== false);
        if (!q) return all.slice(0, 200);
        return all.filter(p => p.name.toLowerCase().includes(q) ||
            (p.sku || '').toLowerCase().includes(q) ||
            (p.barcode || '').toLowerCase().includes(q)).slice(0, 200);
    })();
    $: selectedBogoProducts = $productsDB.filter(p => bogoProductIds.has(p.id));

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
            <button class="tab-btn {tab==='temporary'?'active':''}" on:click={() => tab='temporary'}>Temporary Item</button>
            <button class="tab-btn {tab==='percent'?'active':''}" on:click={() => tab='percent'}>Percentage</button>
        </div>
        {#if tab==='bundle'}
            <button class="btn btn-primary" on:click={addBundle}>+ Add Bundle</button>
        {:else if tab==='bogo'}
            <button class="btn btn-primary" on:click={addBogo}>+ Add BOGO</button>
        {:else if tab==='temporary'}
            <button class="btn btn-primary" on:click={addTemporary}>+ Add Temporary</button>
        {:else}
            <button class="btn btn-primary" on:click={addPercent}>+ Add Percentage</button>
        {/if}
    </div>

    {#if tab==='bundle'}
        <table class="tbl">
            <thead><tr><th>Name</th><th>Deal</th><th>Items</th><th>Window</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
                {#each bundles as d}
                    <tr>
                        <td class="font-semibold">{d.name}</td>
                        <td>Any {numeric(d.bundleQuantity)} for {formatMoney(numeric(d.bundlePrice))}</td>
                        <td>{bundleItemCount(d)}</td>
                        <td>{bundleWindow(d)}</td>
                        <td><span class="tag {promotionStatusClass(d)}">{promotionStatus(d)}</span></td>
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
        <table class="tbl">
            <thead><tr><th>Name</th><th>Deal</th><th>Items</th><th>Window</th><th>Limit</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
                {#each bogos as d}
                    <tr>
                        <td class="font-semibold">{d.name}</td>
                        <td>Buy {numeric(d.minQuantity, 1)}, next for {formatMoney(numeric(d.secondPrice))}</td>
                        <td>{bundleItemCount(d)}</td>
                        <td>{bundleWindow(d)}</td>
                        <td>{d.maxApplications == null ? 'Unlimited' : `${numeric(d.maxApplications)} per sale`}</td>
                        <td><span class="tag {promotionStatusClass(d)}">{promotionStatus(d)}</span></td>
                        <td><div class="act-row">
                            <button class="btn-icon act-btn" on:click={() => editBogo(d)}>✎</button>
                            <button class="btn-icon act-btn danger" on:click={() => delBogo(d)}>✕</button>
                        </div></td>
                    </tr>
                {/each}
                {#if bogos.length===0}<tr class="empty-row"><td colspan="7">No BOGO promotions yet.</td></tr>{/if}
            </tbody>
        </table>
    {:else if tab==='temporary'}
        <table class="tbl">
            <thead><tr><th>Name</th><th>Item</th><th>Temporary Deal</th><th>Window</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
                {#each temporaryItems as d}
                    <tr>
                        <td class="font-semibold">{d.name}</td>
                        <td>{temporaryProductName(d)}</td>
                        <td>{temporaryDeal(d)}</td>
                        <td>{bundleWindow(d)}</td>
                        <td><span class="tag {promotionStatusClass(d)}">{promotionStatus(d)}</span></td>
                        <td><div class="act-row">
                            <button class="btn-icon act-btn" on:click={() => editTemporary(d)}>✎</button>
                            <button class="btn-icon act-btn danger" on:click={() => delTemporary(d)}>✕</button>
                        </div></td>
                    </tr>
                {/each}
                {#if temporaryItems.length===0}<tr class="empty-row"><td colspan="6">No temporary item discounts yet.</td></tr>{/if}
            </tbody>
        </table>
    {:else}
        <table class="tbl">
            <thead><tr><th>Name</th><th>Discount</th><th>Applied By</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
                {#each percentages as d}
                    <tr>
                        <td class="font-semibold">{d.name}</td>
                        <td>{numeric(d.value)}% off</td>
                        <td>Cashier</td>
                        <td><span class="tag {d.isActive ? 'text-success' : 'text-danger'}">{d.isActive?'Active':'Inactive'}</span></td>
                        <td><div class="act-row">
                            <button class="btn-icon act-btn" on:click={() => editPercent(d)}>✎</button>
                            <button class="btn-icon act-btn danger" on:click={() => delPercent(d)}>✕</button>
                        </div></td>
                    </tr>
                {/each}
                {#if percentages.length===0}<tr class="empty-row"><td colspan="5">No percentage discounts yet.</td></tr>{/if}
            </tbody>
        </table>
    {/if}
</MgmtPage>

<Modal bind:show={showBundle} title={editingBundle ? 'Edit Bundle' : 'Add Bundle'} width="760px" height="min(86vh, 780px)">
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

        <div class="field span-2">
            <div class="flex items-center justify-between gap-3 mb-2">
                <label>Selected Items ({selectedBundleProducts.length})</label>
                <button class="btn btn-danger !py-1 !px-3 !text-xs !min-h-8" disabled={selectedBundleProducts.length === 0} on:click={() => curProductIds = new Set()}>Clear all</button>
            </div>
            <div class="flex flex-wrap content-start gap-2 h-[92px] overflow-y-auto p-2 border border-border-flat rounded-sm bg-bg-panel">
                {#if selectedBundleProducts.length === 0}
                    <span class="text-sm text-text-muted p-2">No items selected yet.</span>
                {:else}
                    {#each selectedBundleProducts as product (product.id)}
                        <button class="flat-card !py-1.5 !px-2.5 text-sm flex items-center gap-2 hover:!border-danger" on:click={() => toggleProduct(product.id)}>
                            <span>{product.name}</span><strong class="text-danger">✕</strong>
                        </button>
                    {/each}
                {/if}
            </div>
        </div>

        <div class="field span-2 mt-2">
            <label>Find Products</label>
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

<Modal bind:show={showBogo} title={editingBogo ? 'Edit BOGO Promotion' : 'Add BOGO Promotion'} width="760px" height="min(86vh, 780px)">
    <div class="form-grid">
        <div class="field span-2"><label>Promotion Name *</label><input bind:value={bogoName} placeholder="e.g. Buy 1, get the next for £1" /></div>
        <div class="field"><label>Full-price items to buy *</label><input type="number" min="1" step="1" bind:value={bogoBuyQty} /></div>
        <div class="field"><label>Price of the next item (£) *</label><input type="number" min="0" step="0.01" bind:value={bogoSecondPricePounds} /></div>
        <div class="field">
            <label>Maximum uses per sale</label>
            <input type="number" min="1" step="1" bind:value={bogoMaxApplications} placeholder="Leave empty for unlimited" />
        </div>
        <div class="field flex items-end"><TouchToggle bind:checked={bogoActive} label="Active Status" /></div>
        <div class="field"><TouchDateTimePicker label="Start Time (optional)" bind:value={bogoStartAt} /></div>
        <div class="field"><TouchDateTimePicker label="End Time (optional)" bind:value={bogoEndAt} /></div>
        <div class="field span-2">
            <div class="flex items-center justify-between gap-3 mb-2">
                <label>Selected Items ({selectedBogoProducts.length})</label>
                <button class="btn btn-danger !py-1 !px-3 !text-xs !min-h-8" disabled={selectedBogoProducts.length === 0} on:click={() => bogoProductIds = new Set()}>Clear all</button>
            </div>
            <div class="flex flex-wrap content-start gap-2 h-[92px] overflow-y-auto p-2 border border-border-flat rounded-sm bg-bg-panel">
                {#if selectedBogoProducts.length === 0}
                    <span class="text-sm text-text-muted p-2">No items selected yet.</span>
                {:else}
                    {#each selectedBogoProducts as product (product.id)}
                        <button class="flat-card !py-1.5 !px-2.5 text-sm flex items-center gap-2 hover:!border-danger" on:click={() => toggleBogoProduct(product.id)}>
                            <span>{product.name}</span><strong class="text-danger">✕</strong>
                        </button>
                    {/each}
                {/if}
            </div>
        </div>
        <div class="field span-2 mt-2">
            <label>Find Products</label>
            <input bind:value={bogoProductSearch} placeholder="Search products..." />
        </div>
        <div class="span-2 max-h-[240px] overflow-y-auto border border-border-flat rounded-sm bg-bg-panel">
            {#each filteredBogoProducts as p (p.id)}
                <label class="grid grid-cols-[auto_1fr_auto_auto] gap-3 items-center px-2.5 py-1.5 border-b border-border-flat last:border-b-0 cursor-pointer text-[0.85rem] hover:bg-bg-card {bogoProductIds.has(p.id) ? 'bg-accent-primary/10' : ''}">
                    <div class="flex w-6 h-6 items-center justify-center rounded-md border-2 transition-colors shrink-0 {bogoProductIds.has(p.id) ? 'bg-accent-primary border-accent-primary text-white' : 'bg-bg-panel border-border-flat'}">
                        {#if bogoProductIds.has(p.id)}✓{/if}
                    </div>
                    <input type="checkbox" class="hidden" checked={bogoProductIds.has(p.id)} on:change={() => toggleBogoProduct(p.id)} />
                    <span class="text-text-main font-medium">{p.name}</span>
                    <span class="text-text-muted text-[0.8rem] font-mono">{p.sku || p.barcode || ''}</span>
                    <span class="text-text-main font-semibold min-w-[60px] text-right">{formatMoney(p.price)}</span>
                </label>
            {/each}
            {#if filteredBogoProducts.length === 0}<div class="p-4 text-center text-text-muted">No matches.</div>{/if}
        </div>
    </div>
    <svelte:fragment slot="footer">
        <button class="btn btn-danger" on:click={() => showBogo=false}>Cancel</button>
        <button class="btn btn-primary" on:click={saveBogo}>Save</button>
    </svelte:fragment>
</Modal>

<Modal bind:show={showPercent} title={editingPercent ? 'Edit Percentage Discount' : 'Add Percentage Discount'} width="520px">
    <div class="form-grid">
        <div class="field span-2"><label>Discount Name *</label><input bind:value={percentName} placeholder="e.g. Staff Discount" /></div>
        <div class="field"><label>Percentage Off *</label><input type="number" min="1" max="100" step="1" bind:value={percentValue} /></div>
        <div class="field flex items-end"><TouchToggle bind:checked={percentActive} label="Active Status" /></div>
        <div class="span-2 p-3 flat-card text-sm text-text-muted">This discount is selected manually by the cashier from the POS discount button.</div>
    </div>
    <svelte:fragment slot="footer">
        <button class="btn btn-danger" on:click={() => showPercent=false}>Cancel</button>
        <button class="btn btn-primary" on:click={savePercent}>Save</button>
    </svelte:fragment>
</Modal>

<Modal bind:show={showTemporary} title={editingTemporary ? 'Edit Temporary Item Discount' : 'Add Temporary Item Discount'} width="760px" height="min(86vh, 780px)">
    <div class="form-grid">
        <div class="field span-2">
            <label>Discount Name *</label>
            <input bind:value={temporaryName} placeholder="e.g. Tomatoes weekend offer" />
        </div>
        <div class="field">
            <label>Discount Type *</label>
            <CustomSelect
                bind:value={temporaryType}
                options={[
                    { label: 'Percentage off', value: 'percentage' },
                    { label: 'Temporary sale price', value: 'fixed' }
                ]}
            />
        </div>
        <div class="field">
            <label>{temporaryType === 'percentage' ? 'Percentage Off *' : 'Temporary Sale Price (£) *'}</label>
            <input
                type="number"
                min={temporaryType === 'percentage' ? 1 : 0.01}
                max={temporaryType === 'percentage' ? 100 : undefined}
                step={temporaryType === 'percentage' ? 1 : 0.01}
                bind:value={temporaryValue}
            />
        </div>
        <div class="field"><TouchDateTimePicker label="Start Time (optional)" bind:value={temporaryStartAt} /></div>
        <div class="field"><TouchDateTimePicker label="End Time (optional)" bind:value={temporaryEndAt} /></div>
        <div class="span-2"><TouchToggle bind:checked={temporaryActive} label="Active Status" /></div>
        <div class="field span-2">
            <label>Selected Item</label>
            <div class="flat-card p-3 h-[68px] flex items-center gap-3 {selectedTemporaryProduct ? '!border-accent-primary' : ''}">
                {#if selectedTemporaryProduct}
                    <div class="w-4 h-10 rounded-sm" style="background:{selectedTemporaryProduct.color || '#3b82f6'}"></div>
                    <div class="flex-1 min-w-0">
                        <strong class="block truncate">{selectedTemporaryProduct.name}</strong>
                        <span class="text-xs text-text-muted font-mono">{selectedTemporaryProduct.sku || selectedTemporaryProduct.barcode || selectedTemporaryProduct.scalePlu || ''}</span>
                    </div>
                    <span class="font-bold">{formatMoney(selectedTemporaryProduct.price)}</span>
                    <button class="btn btn-danger !py-1.5 !px-3" on:click={() => temporaryProductId = ''}>Remove</button>
                {:else}
                    <span class="text-sm text-text-muted">No item selected yet.</span>
                {/if}
            </div>
        </div>
        <div class="field span-2">
            <label>Find Item *</label>
            <input bind:value={temporaryProductSearch} placeholder="Search by item name, SKU, barcode or PLU..." />
        </div>
        <div class="span-2 max-h-[240px] overflow-y-auto border border-border-flat rounded-sm bg-bg-panel">
            {#each filteredTemporaryProducts as product (product.id)}
                <button
                    class="w-full grid grid-cols-[auto_1fr_auto_auto] gap-3 items-center px-3 py-2 border-0 border-b border-border-flat last:border-b-0 text-left cursor-pointer hover:bg-bg-card {temporaryProductId === product.id ? 'bg-accent-primary/10' : 'bg-transparent'}"
                    on:click={() => selectTemporaryProduct(product.id)}
                >
                    <div class="flex w-6 h-6 items-center justify-center rounded-md border-2 {temporaryProductId === product.id ? 'bg-accent-primary border-accent-primary text-white' : 'border-border-flat'}">
                        {#if temporaryProductId === product.id}✓{/if}
                    </div>
                    <span class="text-text-main font-medium">{product.name}</span>
                    <span class="text-text-muted text-xs font-mono">{product.sku || product.barcode || product.scalePlu || ''}</span>
                    <span class="text-text-main font-semibold">{formatMoney(product.price)}</span>
                </button>
            {/each}
            {#if filteredTemporaryProducts.length === 0}<div class="p-4 text-center text-text-muted">No matches.</div>{/if}
            {#if filteredTemporaryProducts.length === 200}<div class="p-3 text-center text-text-muted text-xs">Showing first 200 results. Refine your search to find more.</div>{/if}
        </div>
        <div class="span-2 p-3 flat-card text-sm text-text-muted">
            The normal item price is kept unchanged. This discount applies automatically during the selected time window.
        </div>
    </div>
    <svelte:fragment slot="footer">
        <button class="btn btn-danger" on:click={() => showTemporary=false}>Cancel</button>
        <button class="btn btn-primary" on:click={saveTemporary}>Save</button>
    </svelte:fragment>
</Modal>

<Modal bind:show={showDeleteConfirm} title="Delete Promotion?" width="420px">
    <p class="m-0 text-text-main">
        Delete <strong>“{bundleToDelete?.name}”</strong>? This removes the promotion and its product list.
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
