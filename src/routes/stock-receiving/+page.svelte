<script lang="ts">
    import { onMount } from 'svelte';
    import { beforeNavigate, goto } from '$app/navigation';
    import { PackagePlus, Plus, Trash2, RotateCw, ChevronLeft, ChevronRight, CheckCircle2 } from '@lucide/svelte';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import CustomSelect from '$lib/components/CustomSelect.svelte';
    import SearchField from '$lib/components/SearchField.svelte';
    import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
    import StockReceivingProductPicker from '$lib/components/StockReceivingProductPicker.svelte';
    import { deviceOperatingMode } from '$lib/deviceMode';
    import { suppliersDB, formatMoney, now, uuid, type Product, type StockReceipt } from '$lib/stores/db';
    import { commitStockReceipt, getProductsPage, getRecentStockReceipts, type StockReceiptBundle } from '$lib/stores/database';
    import { currentEmployee } from '$lib/stores/session';
    import { validateReceivingDraft, type ReceivingDraftLine } from '$lib/stockReceivingDraft';

    const PAGE_SIZE = 20;
    let view: 'delivery' | 'history' = 'delivery';
    let search = '', supplierId = '', reference = '', notes = '';
    let lines: ReceivingDraftLine[] = [];
    let saving = false;
    // Retries retain the same IDs and values so an uncertain response cannot double-receive stock.
    let pendingSubmission: StockReceiptBundle | null = null;
    let saveError = '', feedback = '';
    let feedbackIsSuccess = false;
    let showDiscard = false, showLeave = false, leaveUrl = '', allowNavigation = false;
    let history: StockReceipt[] = [];
    let historyLoading = false, historyError = '', historyToken = 0;
    let availableProducts: Product[] = [];
    let productsLoading = false, productsError = '', productTotal = 0, productTotalIsCapped = false, productOffset = 0;
    let productSearchTimer: ReturnType<typeof setTimeout> | null = null;
    let productSearchToken = 0;
    let showProductPicker = false;
    let showNotes = false;
    $: isBackOffice = $deviceOperatingMode === 'back_office';
    $: deliveryQuantities = Object.fromEntries(lines.map((line) => [line.productId, line.quantityInput]));
    $: locked = saving || pendingSubmission !== null;
    $: validation = validateReceivingDraft(lines);
    $: rowTotals = new Map(lines.flatMap((line) => {
        const row = validateReceivingDraft([line]);
        return row.valid ? [[line.id, row.totalCost] as const] : [];
    }));
    $: hasNextProducts = productTotalIsCapped ? availableProducts.length === PAGE_SIZE : productOffset + availableProducts.length < productTotal;
    $: productRange = productTotalIsCapped
        ? `${productOffset + 1}–${productOffset + availableProducts.length} · ${Math.max(productTotal, productOffset + availableProducts.length)}+ matches`
        : `${productOffset + 1}–${productOffset + availableProducts.length} of ${productTotal}`;
    $: supplierOptions = [{ label: 'No supplier', value: '' }, ...$suppliersDB.map((supplier) => ({ label: supplier.name, value: supplier.id }))];

    function cancelProductSearch() {
        if (productSearchTimer) clearTimeout(productSearchTimer);
        productSearchTimer = null;
    }
    async function loadAvailableProducts() {
        cancelProductSearch();
        const token = ++productSearchToken;
        if (isBackOffice) {
            availableProducts = [];
            productsLoading = false;
            return;
        }
        productsLoading = true;
        productsError = '';
        try {
            const result = await getProductsPage({ query: search.trim(), status: 'active', limit: PAGE_SIZE, offset: productOffset });
            if (token !== productSearchToken) return;
            availableProducts = result.rows as Product[];
            productTotal = result.total;
            productTotalIsCapped = Boolean(result.totalIsCapped);
        } catch (error) {
            if (token !== productSearchToken) return;
            availableProducts = [];
            productsError = `Could not load products. ${String(error)}`;
        } finally {
            if (token === productSearchToken) productsLoading = false;
        }
    }
    function scheduleProductSearch() {
        cancelProductSearch();
        // Invalidate immediately, not after the debounce: an old search must not win.
        productSearchToken++;
        productOffset = 0;
        productsLoading = true;
        productsError = '';
        productSearchTimer = setTimeout(() => { void loadAvailableProducts(); }, 180);
    }
    function handleProductSearchKeydown(event: KeyboardEvent) {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        productOffset = 0;
        void loadAvailableProducts();
    }
    function clearProductSearch() { search = ''; productOffset = 0; void loadAvailableProducts(); }
    function changeProductPage(direction: number) {
        if (productsLoading) return;
        productOffset = Math.max(0, productOffset + direction * PAGE_SIZE);
        void loadAvailableProducts();
    }
    function openProductPicker() {
        if (!locked) { feedback = ''; showProductPicker = true; }
    }
    function addProduct(product: Product) {
        if (locked || productsLoading) return;
        feedback = '';
        feedbackIsSuccess = false;
        const existing = lines.find((line) => line.productId === product.id);
        if (existing) {
            const parsed = validateReceivingDraft([existing]);
            if (!parsed.valid || parsed.totalUnits >= 2_147_483_647) {
                feedback = `Check the quantity and cost for ${product.name} before adding another unit.`;
                return;
            }
            updateLine(existing.id, { quantityInput: String(parsed.totalUnits + 1) });
        } else {
            lines = [...lines, { id: uuid(), productId: product.id, productName: product.name, quantityInput: '1', unitCostInput: ((product.costPrice ?? 0) / 100).toFixed(2), inventoryLogId: uuid() }];
        }
    }
    function updateLine(id: string, patch: Partial<ReceivingDraftLine>) {
        if (locked) return;
        feedback = '';
        lines = lines.map((line) => line.id === id ? { ...line, ...patch } : line);
    }
    function removeLine(id: string) {
        if (locked) return;
        feedback = '';
        lines = lines.filter((line) => line.id !== id);
    }
    function discardDraft() {
        if (saving) return;
        lines = []; reference = ''; notes = ''; pendingSubmission = null; saveError = ''; feedback = '';
        showNotes = false;
    }
    async function loadHistory() {
        const token = ++historyToken;
        historyLoading = true; historyError = '';
        try {
            const receipts = await getRecentStockReceipts(50);
            if (token === historyToken) history = receipts;
        } catch (error) {
            if (token === historyToken) historyError = `Could not load recent receipts. ${String(error)}`;
        } finally {
            if (token === historyToken) historyLoading = false;
        }
    }
    async function saveReceipt() {
        if (saving) return;
        if (!$currentEmployee) { saveError = 'Sign in before receiving stock.'; return; }
        if (!pendingSubmission) {
            if (!validation.valid) return;
            const receiptId = uuid(), stamp = now(), receiptReference = reference.trim();
            pendingSubmission = {
                receipt: { id: receiptId, supplierId, employeeId: $currentEmployee.id, reference: receiptReference, notes: notes.trim(), totalCost: validation.totalCost, status: 'received', createdAt: stamp, updatedAt: stamp },
                lines: validation.lines.map((line) => ({ ...line, receiptId, createdAt: stamp, updatedAt: stamp })),
                audit: { id: uuid(), employeeId: $currentEmployee.id, action: 'stock_received', entityType: 'stock_receipt', entityId: receiptId, oldData: '', newData: JSON.stringify({ reference: receiptReference, supplierId, lineCount: lines.length, totalCost: validation.totalCost }), createdAt: stamp },
            };
        }
        saving = true; saveError = ''; feedback = '';
        try {
            await commitStockReceipt(pendingSubmission);
        } catch (error) {
            saveError = `Receipt not confirmed. ${String(error)} Retry uses the same receipt to prevent duplicate stock.`;
            saving = false;
            return;
        }
        // A later refresh failure is not a failed receipt. Never invite a second save.
        saving = false;
        const receivedCount = lines.length;
        discardDraft();
        feedbackIsSuccess = true;
        feedback = `Stock received: ${receivedCount} product${receivedCount === 1 ? '' : 's'} added to inventory.`;
        void loadHistory(); void loadAvailableProducts();
    }
    function supplierName(id: string) { return $suppliersDB.find((supplier) => supplier.id === id)?.name || (id ? 'Supplier unavailable' : 'No supplier'); }
    function receiptDate(value: string) {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? 'Date unavailable' : date.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
    }
    beforeNavigate((navigation) => {
        if (allowNavigation || (!lines.length && !reference.trim() && !notes.trim())) return;
        navigation.cancel();
        if (saving || navigation.willUnload || !navigation.to) return;
        leaveUrl = navigation.to.url.href;
        showLeave = true;
    });
    function leavePage() { if (saving) return; allowNavigation = true; void goto(leaveUrl); }
    onMount(() => {
        void loadHistory(); void loadAvailableProducts();
        return () => { cancelProductSearch(); productSearchToken++; historyToken++; };
    });
</script>

<MgmtPage title="Stock Receiving">
    <div class="receiving-workspace" class:is-back-office={isBackOffice}>
        <div class="receiving-tabs" aria-label="Stock receiving views">
            <button class:active={view === 'delivery'} aria-pressed={view === 'delivery'} on:click={() => view = 'delivery'}>Receive stock{lines.length ? ` (${lines.length})` : ''}</button>
            <button class:active={view === 'history'} aria-pressed={view === 'history'} on:click={() => { view = 'history'; void loadHistory(); }}>Recent receipts</button>
        </div>
        {#if view === 'delivery'}
            <div class="receiving-meta">
                <div class="field receiving-supplier"><CustomSelect label="Supplier" bind:value={supplierId} options={supplierOptions} disabled={locked} /></div>
                <div class="field"><label for="stock-reference">Delivery reference</label><input id="stock-reference" bind:value={reference} disabled={locked} maxlength="255" placeholder="Invoice or delivery note" /></div>
                {#if isBackOffice}<button class="receiving-note-toggle" aria-expanded={showNotes} aria-controls="delivery-note-field" on:click={() => showNotes = !showNotes}>{showNotes ? 'Hide note' : notes ? 'Edit note' : '+ Add note'}</button>{/if}
                {#if !isBackOffice || showNotes}<div class="field receiving-notes" id="delivery-note-field"><label for="stock-notes">Notes <span>(optional)</span></label><input id="stock-notes" bind:value={notes} disabled={locked} maxlength="2000" placeholder="Delivery notes" /></div>{/if}
            </div>
            {#if saveError}<div class="receiving-notice error" role="alert">{saveError}</div>
            {:else if feedback}<div class="receiving-notice" class:success={feedbackIsSuccess} role="status">{#if feedbackIsSuccess}<CheckCircle2 size={18} />{/if}<span>{feedback}</span></div>{/if}
            <div class="receiving-panels">
                {#if !isBackOffice}
                <section class="receiving-catalog" aria-label="Available products">
                    <div class="receiving-panel-heading"><h2>Find products</h2><SearchField id="stock-product-search" bind:value={search} placeholder="Name, SKU or barcode…" ariaLabel="Find product to receive" keyboardLabel="Open product search keyboard" clearLabel="Clear product search" onInput={scheduleProductSearch} onKeydown={handleProductSearchKeydown} onClear={clearProductSearch} disabled={locked} /></div>
                    <div class="receiving-product-list" aria-busy={productsLoading}>
                        {#if productsLoading}<p class="receiving-empty">Finding products…</p>
                        {:else if productsError}<div class="receiving-empty"><p role="alert">{productsError}</p><button class="btn btn-secondary" on:click={loadAvailableProducts}>Retry search</button></div>
                        {:else if !availableProducts.length}<p class="receiving-empty">No matching products. Try another name or barcode.</p>
                        {:else}{#each availableProducts as product (product.id)}
                            <button class="receiving-product" disabled={locked} on:click={() => addProduct(product)} aria-label={`Add ${product.name}`}><span class="receiving-product-copy"><strong>{product.name}</strong><span>Stock {product.stockLevel ?? 0} · {formatMoney(product.costPrice ?? 0)} each</span></span><Plus size={18} aria-hidden="true" /></button>
                        {/each}{/if}
                    </div>
                    <div class="receiving-pagination"><span>{productsLoading ? 'Loading…' : productsError ? 'Search unavailable' : availableProducts.length ? productRange : '0 products'}</span><button aria-label="Previous products" disabled={productsLoading || productOffset === 0 || locked} on:click={() => changeProductPage(-1)}><ChevronLeft size={19} /></button><button aria-label="Next products" disabled={productsLoading || !!productsError || locked || !hasNextProducts} on:click={() => changeProductPage(1)}><ChevronRight size={19} /></button></div>
                </section>
                {/if}
                <section class="receiving-delivery" aria-label="Current delivery">
                    <div class="receiving-delivery-heading"><div><h2>Delivery items{isBackOffice && lines.length ? ` (${lines.length})` : ''}</h2><p>{isBackOffice ? 'Only products in this delivery appear here.' : 'Enter received quantities and buying costs.'}</p></div><div class="receiving-delivery-actions"><button class="receiving-clear" disabled={saving || (!lines.length && !reference && !notes)} on:click={() => showDiscard = true}>Clear draft</button>{#if isBackOffice}<button class="btn btn-secondary receiving-add" disabled={locked} on:click={openProductPicker}><Plus size={18} />Add products</button>{/if}</div></div>
                    <div class="receiving-line-list">
                        {#if !lines.length}<div class="receiving-empty receiving-start"><PackagePlus size={32} strokeWidth={1.6} /><h3>{isBackOffice ? 'A clear space for your delivery' : 'Start your delivery'}</h3><p>{#if isBackOffice}Choose <strong>Add products</strong> to search by name, SKU or barcode.<br />Then enter the quantities and buying costs here.{:else}Select products from the list.<br />Adding a product again increases its quantity.{/if}</p></div>
                        {:else}{#each lines as line, index (line.id)}
                            <article class="receiving-line">
                                <div class="receiving-line-title"><span>{index + 1}</span><h3>{line.productName}</h3><button class="receiving-remove" disabled={locked} on:click={() => removeLine(line.id)} aria-label={`Remove ${line.productName}`} title="Remove product"><Trash2 size={18} /></button></div>
                                <div class="receiving-line-fields">
                                    <div class="field"><label for={`qty-${line.id}`}>Quantity</label><input id={`qty-${line.id}`} aria-label={`Quantity for ${line.productName}`} type="text" inputmode="numeric" value={line.quantityInput} disabled={locked} aria-invalid={!!validation.errors[line.id]?.quantity} aria-describedby={validation.errors[line.id]?.quantity ? `qty-error-${line.id}` : undefined} on:input={(event) => updateLine(line.id, { quantityInput: event.currentTarget.value })} />{#if validation.errors[line.id]?.quantity}<small class="receiving-field-error" id={`qty-error-${line.id}`}>{validation.errors[line.id].quantity}</small>{/if}</div>
                                    <div class="field"><label for={`cost-${line.id}`}>Unit cost (£)</label><input id={`cost-${line.id}`} aria-label={`Unit cost for ${line.productName}`} type="text" inputmode="decimal" value={line.unitCostInput} disabled={locked} aria-invalid={!!validation.errors[line.id]?.unitCost} aria-describedby={validation.errors[line.id]?.unitCost ? `cost-error-${line.id}` : undefined} on:input={(event) => updateLine(line.id, { unitCostInput: event.currentTarget.value })} />{#if validation.errors[line.id]?.unitCost}<small class="receiving-field-error" id={`cost-error-${line.id}`}>{validation.errors[line.id].unitCost}</small>{/if}</div>
                                    <div class="receiving-line-total"><span>Line cost</span><strong>{rowTotals.has(line.id) ? formatMoney(rowTotals.get(line.id)!) : '—'}</strong></div>
                                </div>
                            </article>
                        {/each}{/if}
                    </div>
                </section>
            </div>
            <footer class="receiving-footer">
                <div class="receiving-summary"><span>{lines.length} product{lines.length === 1 ? '' : 's'}{validation.valid ? ` · ${validation.totalUnits} unit${validation.totalUnits === 1 ? '' : 's'}` : ''}</span><small class:invalid={lines.length > 0 && !validation.valid}>{lines.length && !validation.valid ? validation.message : 'Stock updates only when you receive this delivery.'}</small></div>
                <div class="receiving-total"><span>Total cost</span><strong>{validation.valid || !lines.length ? formatMoney(validation.totalCost) : '—'}</strong></div>
                <button class="btn btn-primary receiving-submit" disabled={saving || (!pendingSubmission && !validation.valid)} on:click={saveReceipt}>{#if saving}<RotateCw size={18} />Saving…{:else if pendingSubmission}Retry receipt{:else}<PackagePlus size={18} />Receive stock{/if}</button>
            </footer>
        {:else}
            <section class="receiving-history" aria-label="Recent stock receipts">
                <div class="receiving-history-heading"><div><h2>Recent receipts</h2><p>Latest 50 deliveries received into inventory.</p></div><button class="btn btn-secondary" disabled={historyLoading} on:click={loadHistory}><RotateCw size={16} />Refresh</button></div>
                {#if historyError}<div class="receiving-notice error" role="alert">{historyError}</div>{/if}
                <div class="receiving-history-list" aria-busy={historyLoading}>
                    {#if historyLoading && !history.length}<p class="receiving-empty">Loading receipts…</p>
                    {:else if !history.length && !historyError}<div class="receiving-empty"><PackagePlus size={32} /><h3>No receipts yet</h3><p>Completed deliveries will appear here.</p></div>
                    {:else}{#each history as receipt (receipt.id)}
                        <article class="receiving-history-row"><div><h3>{receipt.reference || 'Stock receipt'}</h3><p>{supplierName(receipt.supplierId)} · {receiptDate(receipt.createdAt)}</p>{#if receipt.notes}<p class="receiving-history-note">{receipt.notes}</p>{/if}</div><div class="receiving-history-amount"><strong>{formatMoney(receipt.totalCost ?? 0)}</strong><span class:voided={receipt.status === 'voided'}>{receipt.status === 'voided' ? 'Voided' : 'Received'}</span></div></article>
                    {/each}{/if}
                </div>
            </section>
        {/if}
    </div>
    <svelte:fragment slot="modal">
        {#if isBackOffice}<StockReceivingProductPicker bind:show={showProductPicker} disabled={locked} quantities={deliveryQuantities} message={feedbackIsSuccess ? '' : feedback} on:add={(event) => addProduct(event.detail)} />{/if}
        <ConfirmDialog bind:show={showDiscard} title="Clear this delivery?" message={pendingSubmission ? 'Check Recent receipts before clearing an unconfirmed delivery. Clearing only removes this draft; it does not reverse any stock already received.' : 'Remove all products, the reference and notes from this unsaved delivery? Your stock will not change.'} confirmText="Clear draft" variant="danger" on:confirm={discardDraft} />
        <ConfirmDialog bind:show={showLeave} title="Leave this delivery?" message={pendingSubmission ? 'This receipt has not been confirmed. Retry it or check Recent receipts before leaving. Leaving loses the draft, but does not reverse any stock already received.' : 'Your delivery has not been received. Leave and discard the unsaved draft?'} confirmText="Leave page" cancelText="Keep editing" variant="danger" on:confirm={leavePage} />
    </svelte:fragment>
</MgmtPage>

<style>
    .receiving-workspace { height:100%; min-height:0; min-width:0; display:flex; flex-direction:column; gap:12px; padding:16px; overflow:hidden; }
    .receiving-tabs { display:flex; gap:4px; flex:none; border-bottom:1px solid var(--border-flat); }
    .receiving-tabs button { min-height:42px; padding:8px 16px; border:0; border-bottom:3px solid transparent; color:var(--text-muted); font-size:.9rem; font-weight:700; background:transparent; }
    .receiving-tabs button.active { color:var(--accent-primary); border-bottom-color:var(--accent-primary); }
    .receiving-meta { display:grid; grid-template-columns:1fr 1fr 1fr; gap:12px; flex:none; }
    .receiving-meta .field, .receiving-line-fields .field { min-width:0; margin:0; }
    .receiving-meta label span { font-size:.7rem; text-transform:none; letter-spacing:0; }
    .receiving-note-toggle { align-self:end; min-height:38px; padding:6px 10px; background:transparent; border:1px dashed var(--border-flat); border-radius:6px; color:var(--text-muted); font-size:.8rem; white-space:nowrap; }
    .receiving-note-toggle:hover { color:var(--accent-primary); border-color:var(--accent-primary); }
    .receiving-delivery-actions { display:flex; align-items:center; gap:8px; flex:none; }
    .receiving-add { gap:6px; white-space:nowrap; }
    .receiving-panels { flex:1; min-height:0; min-width:0; display:grid; grid-template-columns:minmax(230px,.75fr) minmax(0,1.25fr); gap:14px; }
    .receiving-catalog, .receiving-delivery { min-height:0; min-width:0; display:flex; flex-direction:column; background:var(--bg-card); border:1px solid var(--border-flat); border-radius:10px; overflow:hidden; }
    .receiving-panel-heading { padding:12px; flex:none; display:grid; gap:9px; border-bottom:1px solid var(--border-flat); }
    .receiving-workspace h2 { margin:0; font-size:1rem; font-weight:750; }
    .receiving-workspace h3 { margin:0; font-size:.95rem; font-weight:700; }
    .receiving-product-list { flex:1; min-height:0; overflow-y:auto; overscroll-behavior:contain; }
    .receiving-product { display:flex; align-items:center; gap:12px; padding:12px; width:100%; min-height:62px; text-align:left; background:transparent; border:0; border-bottom:1px solid var(--border-flat); color:var(--text-main); }
    .receiving-product:hover:not(:disabled) { background:var(--bg-card-hover); }
    .receiving-product-copy { flex:1; min-width:0; display:grid; gap:3px; }
    .receiving-product-copy strong { font-size:.9rem; line-height:1.3; overflow-wrap:anywhere; }
    .receiving-product-copy > span { color:var(--text-muted); font-size:.75rem; }
    .receiving-product :global(svg) { flex:none; color:var(--accent-primary); }
    .receiving-pagination { display:flex; align-items:center; gap:5px; padding:6px 10px; border-top:1px solid var(--border-flat); flex:none; }
    .receiving-pagination > span { flex:1; font-size:.75rem; color:var(--text-muted); }
    .receiving-pagination button, .receiving-remove { display:grid; place-items:center; width:36px; min-height:36px; flex:none; border:1px solid var(--border-flat); border-radius:7px; background:var(--bg-panel); color:var(--text-muted); }
    .receiving-delivery-heading, .receiving-history-heading { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:12px; flex:none; border-bottom:1px solid var(--border-flat); }
    .receiving-delivery-heading p, .receiving-history-heading p { color:var(--text-muted); font-size:.75rem; margin:4px 0 0; }
    .receiving-clear { padding:6px 8px; min-height:36px; border:0; border-radius:6px; background:transparent; color:var(--text-muted); font-size:.75rem; white-space:nowrap; }
    .receiving-clear:hover:not(:disabled) { background:var(--bg-card-hover); color:var(--text-main); }
    .receiving-line-list { flex:1; min-height:0; padding:10px; overflow-y:auto; overscroll-behavior:contain; }
    .receiving-line { border:1px solid var(--border-flat); border-radius:8px; padding:10px 12px; background:var(--bg-panel); margin-bottom:9px; }
    .receiving-line:last-child { margin-bottom:0; }
    .receiving-line-title { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
    .receiving-line-title > span { color:var(--text-muted); font-size:.7rem; }
    .receiving-line-title h3 { flex:1; min-width:0; overflow-wrap:anywhere; line-height:1.35; }
    .receiving-remove { border:0; background:transparent; width:32px; min-height:32px; }
    .receiving-remove:hover:not(:disabled) { color:var(--danger); background:var(--bg-card-hover); }
    .receiving-line-fields { display:grid; grid-template-columns:minmax(65px,.8fr) minmax(85px,1fr) minmax(70px,1fr); gap:12px; }
    .receiving-line-fields label, .receiving-line-total > span { font-size:.7rem; font-weight:700; color:var(--text-muted); letter-spacing:.02em; text-transform:none; }
    .receiving-line-fields input { width:100%; min-width:0; font-size:1rem; font-variant-numeric:tabular-nums; padding-inline:10px; }
    .receiving-line-fields input[aria-invalid="true"] { border-color:var(--danger); }
    .receiving-line-total { display:flex; flex-direction:column; align-items:flex-end; gap:13px; min-width:0; }
    .receiving-line-total strong { font-size:1rem; overflow-wrap:anywhere; font-variant-numeric:tabular-nums; }
    .receiving-field-error { display:block; margin-top:4px; color:var(--danger); font-size:.72rem; line-height:1.35; overflow-wrap:anywhere; }
    .receiving-empty { padding:24px 16px; text-align:center; color:var(--text-muted); font-size:.85rem; margin:0; overflow-wrap:anywhere; }
    .receiving-empty :global(svg) { margin:8px auto 12px; opacity:.65; }
    .receiving-empty p { margin:8px 0; line-height:1.6; }
    .receiving-start { display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:100%; }
    .receiving-start h3 { color:var(--text-main); }
    .receiving-footer { flex:none; display:flex; align-items:center; gap:18px; padding:12px 0 0; border-top:1px solid var(--border-flat); }
    .receiving-summary { flex:1; min-width:0; display:grid; gap:3px; }
    .receiving-summary > span { font-size:.85rem; font-weight:700; }
    .receiving-summary small { font-size:.72rem; color:var(--text-muted); }
    .receiving-summary small.invalid { color:var(--danger); }
    .receiving-total { text-align:right; display:grid; gap:2px; min-width:90px; max-width:30%; }
    .receiving-total > span { font-size:.72rem; color:var(--text-muted); }
    .receiving-total strong { font-size:1.4rem; line-height:1.2; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
    .receiving-submit { flex:none; min-height:46px; gap:8px; }
    .receiving-notice { flex:none; display:flex; align-items:center; gap:8px; padding:9px 12px; background:var(--bg-card); border:1px solid var(--border-flat); border-radius:7px; font-size:.8rem; color:var(--text-main); overflow-wrap:anywhere; max-height:100px; overflow-y:auto; }
    .receiving-notice.success { color:var(--success); }
    .receiving-notice :global(svg) { flex:none; }
    .receiving-notice.error { color:var(--danger); }
    .receiving-history { min-height:0; flex:1; display:flex; flex-direction:column; border:1px solid var(--border-flat); border-radius:10px; background:var(--bg-card); overflow:hidden; }
    .receiving-history-heading .btn { gap:7px; }
    .receiving-history-list { overflow-y:auto; min-height:0; flex:1; }
    .receiving-history-row { display:flex; align-items:center; justify-content:space-between; gap:20px; padding:16px; border-bottom:1px solid var(--border-flat); }
    .receiving-history-row > div:first-child { min-width:0; }
    .receiving-history-row h3, .receiving-history-row p { overflow-wrap:anywhere; }
    .receiving-history-row p { font-size:.8rem; color:var(--text-muted); margin:5px 0 0; }
    .receiving-history-row .receiving-history-note { font-size:.75rem; }
    .receiving-history-amount { display:grid; gap:5px; justify-items:end; flex:none; max-width:35%; overflow-wrap:anywhere; text-align:right; }
    .receiving-history-amount > strong { font-variant-numeric:tabular-nums; }
    .receiving-history-amount > span { font-size:.7rem; color:var(--success); }
    .receiving-history-amount > span.voided { color:var(--danger); }
    .receiving-workspace button:disabled { opacity:.45; cursor:not-allowed; }
    .receiving-workspace button:focus-visible { outline:2px solid var(--accent-primary); outline-offset:-2px; }
    /* Back Office is a document editor: the catalogue is only opened on demand. */
    .receiving-workspace.is-back-office { gap:14px; padding:16px; }
    .is-back-office .receiving-meta { grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto; align-items:end; }
    .is-back-office .receiving-meta .receiving-notes { grid-column:1 / -1; }
    .is-back-office .receiving-meta :global(.custom-select-trigger) { height:38px; min-height:38px; padding-block:6px; }
    .is-back-office .receiving-supplier :global(.relative > span) { font-size:.7rem; min-height:17px; line-height:17px; }
    .is-back-office .receiving-panels { grid-template-columns:minmax(0,1fr); }
    .is-back-office .receiving-delivery-heading { padding:14px 16px; }
    .is-back-office .receiving-line-list { padding:0 14px; }
    .is-back-office .receiving-line { display:grid; grid-template-columns:minmax(0,1fr) minmax(280px,.9fr); align-items:center; gap:20px; padding:12px 2px; margin:0; border:0; border-bottom:1px solid var(--border-flat); border-radius:0; background:transparent; }
    .is-back-office .receiving-line:last-child { border-bottom:0; }
    .is-back-office .receiving-line-title { margin:0; gap:10px; }
    .is-back-office .receiving-line-title h3 { font-size:.95rem; }
    .is-back-office .receiving-line-fields { grid-template-columns:minmax(70px,.85fr) minmax(90px,1fr) minmax(90px,1fr); gap:14px; }
    .is-back-office .receiving-line-fields input { font-size:.95rem; }
    .is-back-office .receiving-footer { min-height:66px; }
    @container management (max-width:760px) {
        .receiving-workspace { padding:10px; gap:10px; }
        .receiving-panels { grid-template-columns:minmax(210px,.7fr) minmax(0,1.3fr); gap:10px; }
        .receiving-meta { gap:8px; }
        .receiving-line { padding:8px; }
        .receiving-line-fields { gap:8px; }
        .receiving-footer { gap:10px; padding-top:10px; }
        .receiving-summary small { font-size:.68rem; }
        .receiving-submit { padding-inline:12px; }
        .receiving-workspace.is-back-office { padding:12px; gap:10px; }
        .is-back-office .receiving-line { gap:12px; }
        .is-back-office .receiving-line-fields { gap:8px; }
    }
    @container management (max-width:600px) {
        .receiving-workspace { overflow:visible; height:auto; min-height:100%; }
        .receiving-meta { grid-template-columns:1fr 1fr; }
        .receiving-meta > :last-child { grid-column:1 / -1; }
        .receiving-panels { display:flex; flex-direction:column; flex:none; }
        .receiving-catalog { height:280px; flex:none; }
        .receiving-delivery { min-height:220px; flex:none; }
        .receiving-line-list { max-height:400px; flex:auto; }
        .receiving-footer { flex-wrap:wrap; position:sticky; bottom:-10px; background:var(--bg-panel); padding-bottom:10px; }
        .receiving-summary { flex-basis:50%; }
        .receiving-total { margin-left:auto; }
        .receiving-submit { width:100%; }
        .receiving-history { min-height:300px; }
        .is-back-office .receiving-meta { grid-template-columns:minmax(0,1fr) minmax(0,1fr); }
        .is-back-office .receiving-meta > .receiving-note-toggle { grid-column:1 / -1; justify-self:start; }
        .is-back-office .receiving-meta > .field:nth-child(2) { grid-column:auto; }
        .is-back-office .receiving-line { grid-template-columns:minmax(0,1fr); gap:8px; padding:12px 0; }
        .is-back-office .receiving-delivery-heading { flex-wrap:wrap; padding:12px; }
        .is-back-office .receiving-delivery-actions { justify-content:flex-end; flex:1; }
    }
    @media (max-height:660px) and (min-width:701px) {
        .receiving-workspace { gap:8px; padding-block:10px; }
        .receiving-panel-heading, .receiving-delivery-heading { padding:9px 10px; }
        .receiving-tabs button { min-height:36px; padding-block:5px; }
    }
</style>
