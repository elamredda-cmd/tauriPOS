<script lang="ts">
    import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
    import { Plus, Trash2 } from '@lucide/svelte';
    import Modal from './Modal.svelte';
    import CustomSelect from './CustomSelect.svelte';
    import TouchKeyboardButton from './TouchKeyboardButton.svelte';
    import TouchDateTimePicker from './TouchDateTimePicker.svelte';
    import PromotionProductPicker from './PromotionProductPicker.svelte';
    import { discountsDB, promoGroupsDB, promoGroupItemsDB, formatMoney, type Product, type Discount, type PromoGroup, type PromoGroupItem } from '$lib/stores/db';
    import { deviceOperatingMode } from '$lib/deviceMode';
    import { promotionOverlapNames, validatePromotionDraft, type PromotionDraft, type PromotionValues } from '$lib/promotionEditor';

    export let show = false;
    export let editing = false;
    export let draft: PromotionDraft;
    export let busy = false;
    export let error = '';
    export let productsById: ReadonlyMap<string, Product> = new Map();
    const dispatch = createEventDispatcher<{ save: { draft: PromotionDraft; values: PromotionValues }; loaded: Product[] }>();
    let showPicker = false, attempted = false, previousId = '', wasOpen = false, submitting = false;
    let validationClock = Date.now();
    let clockTimer: ReturnType<typeof setInterval> | null = null;
    let localProducts = new Map<string, Product>();
    $: if (draft.id !== previousId || show !== wasOpen) { previousId = draft.id; wasOpen = show; attempted = false; showPicker = false; localProducts = new Map(); validationClock = Date.now(); }
    $: title = `${editing ? 'Edit' : 'Add'} ${draft.kind === 'bundle' ? 'Bundle' : draft.kind === 'bogo' ? 'BOGO Promotion' : draft.kind === 'temporary' ? 'Temporary Item Discount' : 'Percentage Discount'}`;
    $: keyboardMode = $deviceOperatingMode === 'back_office' ? 'off' : undefined;
    $: products = new Map([...localProducts, ...productsById]);
    $: validation = validatePromotionDraft(draft);
    $: overlapping = promotionOverlapNames(draft, $discountsDB, $promoGroupsDB, $promoGroupItemsDB, validationClock);
    $: errors = editorErrors(draft, products, $discountsDB, $promoGroupsDB, $promoGroupItemsDB, validationClock);

    function editorErrors(candidate: PromotionDraft, currentProducts: ReadonlyMap<string, Product>, discounts: Discount[], groups: PromoGroup[], items: PromoGroupItem[], clock: number) {
        const checked = validatePromotionDraft(candidate), issues = { ...checked.errors };
        if (candidate.kind !== 'percent' && candidate.productIds.some((id) => !currentProducts.get(id)?.isActive)) issues.products = 'Some selected products are unavailable or inactive. Remove them before saving.';
        const conflicts = candidate.kind === 'temporary' ? promotionOverlapNames(candidate, discounts, groups, items, clock, true) : [];
        if (conflicts.length) issues.products = `This product already has an active offer in the same time window: ${conflicts.join(', ')}.`;
        if (candidate.kind === 'bogo' && !checked.errors.price && candidate.productIds.some((id) => {
            const product = currentProducts.get(id); return product && checked.values.price >= product.price;
        })) issues.price = 'The next-item price must be below the normal price of every selected product.';
        const product = currentProducts.get(candidate.productIds[0]);
        if (candidate.kind === 'temporary' && candidate.temporaryType === 'fixed' && !checked.errors.value && product && checked.values.value >= product.price) issues.value = 'The sale price must be below the product’s normal price.';
        return issues;
    }

    function cache(rows: Product[]) { localProducts = new Map([...localProducts, ...rows.map((product) => [product.id, product] as const)]); dispatch('loaded', rows); }
    function toggleProduct(id: string) {
        if (busy) return;
        draft.productIds = draft.kind === 'temporary'
            ? draft.productIds.includes(id) ? [] : [id]
            : draft.productIds.includes(id) ? draft.productIds.filter((value) => value !== id) : [...draft.productIds, id];
    }
    async function submit() {
        if (busy || submitting) return;
        submitting = true; attempted = true; validationClock = Date.now();
        await tick();
        if (!busy && !Object.keys(errors).length) dispatch('save', { draft: { ...draft, name: draft.name.trim(), productIds: [...draft.productIds] }, values: { ...validation.values } });
        submitting = false;
    }
    onMount(() => { clockTimer = setInterval(() => validationClock = Date.now(), 30_000); });
    onDestroy(() => { if (clockTimer) clearInterval(clockTimer); });
</script>

<Modal bind:show {title} width="740px" dismissDisabled={busy}>
    <fieldset class="promotion-editor" disabled={busy} aria-busy={busy}>
        {#if error}<div class="editor-error" role="alert">{error}</div>{:else if attempted && Object.keys(errors).length}<div class="editor-error" role="alert">Check the highlighted fields. Nothing has been saved.</div>{/if}
        <div class="editor-top">
            <div class="field"><label for="promotion-name">Promotion name *</label><div class="relative"><input id="promotion-name" maxlength="255" data-touch-keyboard="button" bind:value={draft.name} placeholder="Give this offer a clear name" aria-invalid={attempted && !!errors.name} /><TouchKeyboardButton targetId="promotion-name" label="Open promotion name keyboard" embedded /></div>{#if attempted && errors.name}<small class="field-error">{errors.name}</small>{/if}</div>
            <button class="editor-active" role="switch" aria-checked={draft.active} on:click={() => draft.active = !draft.active}><span class:enabled={draft.active}></span>{draft.active ? 'Active' : 'Inactive'}</button>
        </div>
        <div class="editor-fields">
            {#if draft.kind === 'bundle' || draft.kind === 'bogo'}
                <div class="field"><label for="promotion-quantity">{draft.kind === 'bundle' ? 'Items in bundle *' : 'Full-price items to buy *'}</label><input id="promotion-quantity" type="text" inputmode="numeric" maxlength="10" data-touch-keyboard={keyboardMode} bind:value={draft.quantity} aria-invalid={attempted && !!errors.quantity} />{#if attempted && errors.quantity}<small class="field-error">{errors.quantity}</small>{/if}</div>
                <div class="field"><label for="promotion-price">{draft.kind === 'bundle' ? 'Bundle price (£) *' : 'Price of the next item (£) *'}</label><input id="promotion-price" type="text" inputmode="decimal" maxlength="20" data-touch-keyboard={keyboardMode} bind:value={draft.price} aria-invalid={attempted && !!errors.price} />{#if attempted && errors.price}<small class="field-error">{errors.price}</small>{/if}</div>
                {#if draft.kind === 'bogo'}<div class="field"><label for="promotion-max-uses">Maximum uses per sale</label><input id="promotion-max-uses" type="text" inputmode="numeric" maxlength="10" data-touch-keyboard={keyboardMode} bind:value={draft.maxUses} placeholder="Unlimited" aria-invalid={attempted && !!errors.maxUses} /><small class="field-hint">Leave empty for unlimited.</small>{#if attempted && errors.maxUses}<small class="field-error">{errors.maxUses}</small>{/if}</div>{/if}
            {:else}
                {#if draft.kind === 'temporary'}<div class="field"><CustomSelect label="Discount type" bind:value={draft.temporaryType} disabled={busy} options={[{ label: 'Percentage off', value: 'percentage' }, { label: 'Temporary sale price', value: 'fixed' }]} /></div>{/if}
                <div class="field"><label for="promotion-value">{draft.kind === 'percent' || draft.temporaryType === 'percentage' ? 'Percentage off *' : 'Sale price (£) *'}</label><input id="promotion-value" type="text" inputmode="decimal" maxlength="20" data-touch-keyboard={keyboardMode} bind:value={draft.value} aria-invalid={attempted && !!errors.value} />{#if attempted && errors.value}<small class="field-error">{errors.value}</small>{/if}</div>
            {/if}
        </div>
        {#if draft.kind !== 'percent'}
            <section class="editor-products">
                <div class="editor-section-heading"><div><h3>{draft.kind === 'temporary' ? 'Selected product' : `Selected products (${draft.productIds.length})`}</h3><p>Search only for products included in this offer.</p></div><button class="btn btn-secondary" on:click={() => showPicker = true}><Plus size={16} />{draft.productIds.length ? 'Manage products' : 'Choose products'}</button></div>
                {#if !draft.productIds.length}<p class="selection-empty">No products selected yet.</p>{:else}<div class="selected-products">{#each draft.productIds.slice(0, 3) as id (id)}{@const product = products.get(id)}<div class="selected-product"><span><strong>{product?.name || 'Unavailable product'}</strong>{#if product}<small>{formatMoney(product.price)} normal price{!product.isActive ? ' · Inactive' : ''}</small>{/if}</span><button aria-label={`Remove ${product?.name || 'unavailable product'}`} on:click={() => toggleProduct(id)}><Trash2 size={16} /></button></div>{/each}{#if draft.productIds.length > 3}<button class="selection-more" on:click={() => showPicker = true}>Manage all {draft.productIds.length} selected products</button>{/if}</div>{/if}
                {#if attempted && errors.products}<small class="field-error">{errors.products}</small>{/if}
            </section>
            <details class="editor-schedule" open={Boolean(draft.startAt || draft.endAt)}><summary>Schedule <span>{draft.startAt || draft.endAt ? 'Dates set' : 'Optional · always available when active'}</span></summary><div class="editor-fields"><div class="field"><TouchDateTimePicker label="Start time (optional)" bind:value={draft.startAt} />{#if attempted && errors.startAt}<small class="field-error">{errors.startAt}</small>{/if}</div><div class="field"><TouchDateTimePicker label="End time (optional)" bind:value={draft.endAt} />{#if attempted && errors.endAt}<small class="field-error">{errors.endAt}</small>{/if}</div></div></details>
            {#if overlapping.length}<details class="editor-overlap"><summary>Overlapping offers ({overlapping.length})</summary><p>These active offers share products during the same time window. Checkout avoids using the same item quantity twice.</p>{#each overlapping as name}<p>{name}</p>{/each}</details>{/if}
        {:else}<p class="editor-hint">The cashier selects this percentage discount manually at checkout.</p>{/if}
    </fieldset>
    <svelte:fragment slot="footer"><button class="btn btn-secondary" disabled={busy} on:click={() => show = false}>Cancel</button><button class="btn btn-primary" disabled={busy} on:click={submit}>{busy ? 'Saving…' : 'Save promotion'}</button></svelte:fragment>
</Modal>
<PromotionProductPicker bind:show={showPicker} disabled={busy} single={draft.kind === 'temporary'} selectedIds={draft.productIds} productsById={products} on:toggle={(event) => toggleProduct(event.detail)} on:loaded={(event) => cache(event.detail)} />

<style>
    .promotion-editor { border:0; padding:0; margin:0; min-width:0; display:flex; flex-direction:column; gap:16px; }
    .editor-top { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:14px; align-items:end; }
    .editor-top input { width:100%; padding-right:48px; }
    .editor-active { display:flex; align-items:center; justify-content:center; gap:8px; padding:10px 12px; min-height:44px; border:1px solid var(--border-flat); border-radius:7px; background:var(--bg-panel); color:var(--text-main); font-size:.85rem; font-weight:700; }
    .editor-active span { width:9px; height:9px; border-radius:50%; background:var(--text-muted); }
    .editor-active span.enabled { background:var(--success); }
    .editor-fields { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
    .editor-fields .field { min-width:0; margin:0; }
    .editor-fields input { width:100%; min-width:0; font-variant-numeric:tabular-nums; }
    .editor-fields input[aria-invalid="true"], .editor-top input[aria-invalid="true"] { border-color:var(--danger); }
    .editor-products { padding:12px; border:1px solid var(--border-flat); border-radius:8px; background:var(--bg-panel); }
    .editor-section-heading { display:flex; align-items:center; justify-content:space-between; gap:12px; }
    .editor-section-heading h3 { margin:0; font-size:.95rem; }
    .editor-section-heading p { margin:5px 0 0; font-size:.75rem; color:var(--text-muted); }
    .editor-section-heading .btn { white-space:nowrap; gap:6px; }
    .selection-empty { padding:12px 0 0; margin:0; font-size:.8rem; color:var(--text-muted); }
    .selected-products { margin-top:10px; }
    .selected-product { display:flex; align-items:center; gap:8px; padding:9px 0; border-top:1px solid var(--border-flat); }
    .selected-product > span { display:grid; gap:3px; flex:1; min-width:0; overflow-wrap:anywhere; }
    .selected-product strong { font-size:.82rem; }
    .selected-product small { font-size:.7rem; color:var(--text-muted); }
    .selected-product button { display:grid; place-items:center; width:32px; min-height:32px; flex:none; border:0; border-radius:5px; color:var(--danger); background:transparent; }
    .selection-more { border:0; padding:8px 0; background:transparent; color:var(--accent-primary); font-size:.8rem; font-weight:700; }
    .editor-schedule, .editor-overlap { border:1px solid var(--border-flat); border-radius:7px; padding:12px; }
    .editor-schedule summary, .editor-overlap summary { cursor:pointer; font-size:.85rem; font-weight:700; }
    .editor-schedule summary span { font-size:.75rem; font-weight:400; color:var(--text-muted); margin-left:8px; }
    .editor-schedule .editor-fields { margin-top:12px; }
    .editor-overlap { color:var(--warning); }
    .editor-overlap p { font-size:.78rem; line-height:1.45; margin:8px 0 0; overflow-wrap:anywhere; }
    .editor-error, .field-error { color:var(--danger); font-size:.78rem; line-height:1.45; overflow-wrap:anywhere; }
    .editor-error { padding:10px 12px; border:1px solid var(--danger); border-radius:7px; }
    .field-error { display:block; margin-top:5px; }
    .field-hint, .editor-hint { font-size:.75rem; color:var(--text-muted); }
    .promotion-editor button:focus-visible, .promotion-editor summary:focus-visible { outline:2px solid var(--accent-primary); outline-offset:2px; }
    .promotion-editor:disabled { opacity:.7; }
    :global(.back-office-route) .editor-active { min-height:38px; padding-block:8px; }
    :global(.back-office-route) .editor-fields :global(.custom-select-trigger) { height:38px; min-height:38px; }
    @media (max-width:560px) { .editor-top { grid-template-columns:minmax(0,1fr); gap:8px; } .editor-active { justify-self:start; } .editor-fields { grid-template-columns:minmax(0,1fr); } .editor-section-heading { align-items:flex-start; flex-direction:column; } }
    @media (max-height:660px) { .promotion-editor { gap:12px; } .editor-products, .editor-schedule, .editor-overlap { padding:10px; } }
</style>
