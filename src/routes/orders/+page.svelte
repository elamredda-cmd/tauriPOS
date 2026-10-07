<script lang="ts">
    import { isTauri } from '@tauri-apps/api/core';
    import { onDestroy, onMount, tick } from 'svelte';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import Modal from '$lib/components/Modal.svelte';
    import CustomSelect from '$lib/components/CustomSelect.svelte';
    import SearchField from '$lib/components/SearchField.svelte';
    import {
        formatMoney,
        settingsDB,
        storeDB,
        type Order,
        type OrderLine,
        type Payment,
    } from '$lib/stores/db';
    import { getOrdersPage, getProductsByIds } from '$lib/stores/database';
    import { getScaleSaleDisplay } from '$lib/scaleSale';
    import { getReceiptDesign } from '$lib/receipt';
    import { paymentAllocationLabels, receiptTenderBreakdown } from '$lib/receiptPayments';
    import { getReceiptPrinterConfig, printEscposReceipt } from '$lib/printers';
    import { toast } from '$lib/stores/toast';

    type OrderPageRow = Order & {
        cashierName?: string;
        tillName?: string;
        customerName?: string;
    };

    const PAGE_SIZE = 25;
    const statusFilterOptions = [
        { value: 'all', label: 'All receipts' },
        { value: 'completed', label: 'Completed sales' },
        { value: 'partially_refunded', label: 'Part refunded' },
        { value: 'refunded', label: 'Fully refunded' },
        { value: 'refunds', label: 'Refunds / voids' },
        { value: 'hold', label: 'Held orders' },
        { value: 'voided', label: 'Voided sales' },
    ];

    let selectedOrderId = '';
    let showOrderDialog = false;
    let searchQuery = '';
    let appliedSearchQuery = '';
    let statusFilter = 'all';
    let page = 0;
    let previousFilterKey = '';
    let previousQueryKey = '';
    let sqlOrders: OrderPageRow[] = [];
    let sqlTotal = 0;
    let ordersTotal = 0;
    let ordersLoading = false;
    let ordersLoadError = '';
    let queryRun = 0;
    let ordersMounted = false;
    let ordersLoadTimer: ReturnType<typeof setTimeout> | null = null;
    let pageLinesByOrder = new Map<string, OrderLine[]>();
    let pagePaymentsByOrder = new Map<string, Payment[]>();
    let receiptPrinting = false;
    let ordersResultsElement: HTMLDivElement | null = null;

    $: receiptDesign = getReceiptDesign($settingsDB);
    $: receiptPrinterConfig = getReceiptPrinterConfig($settingsDB);

    $: pageCount = Math.max(1, Math.ceil(sqlTotal / PAGE_SIZE));
    $: if (page >= pageCount) page = pageCount - 1;
    $: pagedOrders = sqlOrders;
    $: {
        const filterKey = `${appliedSearchQuery}|${statusFilter}`;
        if (filterKey !== previousFilterKey) {
            previousFilterKey = filterKey;
            page = 0;
            selectedOrderId = '';
            showOrderDialog = false;
        }
    }
    $: {
        const queryKey = `${previousFilterKey}|${page}`;
        if (ordersMounted && queryKey !== previousQueryKey) {
            previousQueryKey = queryKey;
            scheduleOrdersLoad();
        }
    }

    onMount(() => {
        ordersMounted = true;
        previousFilterKey = `${appliedSearchQuery}|${statusFilter}`;
        previousQueryKey = `${previousFilterKey}|${page}`;
        void loadOrdersPage();
    });

    onDestroy(() => {
        ordersMounted = false;
        queryRun += 1;
        if (ordersLoadTimer) clearTimeout(ordersLoadTimer);
    });

    function groupByOrderId<T extends { orderId: string }>(rows: T[]): Map<string, T[]> {
        const grouped = new Map<string, T[]>();
        for (const row of rows) {
            const existing = grouped.get(row.orderId) || [];
            existing.push(row);
            grouped.set(row.orderId, existing);
        }
        return grouped;
    }

    $: selectedOrder = sqlOrders.find((order) => order.id === selectedOrderId) || null;

    function scheduleOrdersLoad(delay = 0) {
        if (ordersLoadTimer) clearTimeout(ordersLoadTimer);
        ordersLoadTimer = setTimeout(() => {
            ordersLoadTimer = null;
            void loadOrdersPage();
        }, delay);
    }

    function handleOrderSearchInput(event: Event) {
        searchQuery = (event.currentTarget as HTMLInputElement).value;
    }

    function runOrderSearch() {
        const nextQuery = searchQuery.trim();
        if (nextQuery === appliedSearchQuery && page === 0) {
            scheduleOrdersLoad();
            return;
        }
        appliedSearchQuery = nextQuery;
        page = 0;
    }

    function handleOrderSearchKeydown(event: KeyboardEvent) {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        runOrderSearch();
    }

    function clearOrderSearch() {
        searchQuery = '';
        if (!appliedSearchQuery && page === 0) return;
        appliedSearchQuery = '';
        page = 0;
    }

    function clearOrderFilters() {
        searchQuery = '';
        appliedSearchQuery = '';
        statusFilter = 'all';
        page = 0;
    }

    async function changePage(nextPage: number): Promise<void> {
        if (ordersLoading) return;
        const boundedPage = Math.max(0, Math.min(pageCount - 1, nextPage));
        if (boundedPage === page) return;
        page = boundedPage;
        selectedOrderId = '';
        showOrderDialog = false;
        await tick();
        ordersResultsElement?.scrollTo({ top: 0, behavior: 'smooth' });
        const managementContent = ordersResultsElement?.closest('.management-content');
        if (managementContent instanceof HTMLElement) {
            managementContent.scrollTo({ top: 0, behavior: 'smooth' });
        }
    }

    function openOrder(order: Order) {
        selectedOrderId = order.id;
        showOrderDialog = true;
    }

    function getLines(orderId: string): OrderLine[] {
        return pageLinesByOrder.get(orderId) || [];
    }

    function getPayments(orderId: string): Payment[] {
        return pagePaymentsByOrder.get(orderId) || [];
    }

    function formatDate(value: string): string {
        if (!value) return '-';
        const date = new Date(value);
        if (!Number.isFinite(date.getTime())) return '-';
        return date.toLocaleString('en-GB', {
            day: '2-digit',
            month: 'short',
            year: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        });
    }

    function cashierName(order: OrderPageRow): string {
        return order.cashierName || 'Unknown';
    }

    function tillName(order: OrderPageRow): string {
        return order.tillName || order.tillNumber || 'Unknown';
    }

    function customerName(order: OrderPageRow): string {
        return order.customerName || '';
    }

    function lineCount(orderId: string): number {
        return getLines(orderId).length;
    }

    function itemQuantity(orderId: string): number {
        return getLines(orderId).reduce((sum, line) => sum + Math.abs(Number(line.quantity || 0)), 0);
    }

    function statusLabel(order: Order): string {
        if (order.type === 'return' && order.notes?.startsWith('Void of receipt')) return 'void reversal';
        if (order.type === 'return') return 'refund';
        return String(order.status || 'unknown').replace(/_/g, ' ');
    }

    function statusClass(order: Order): string {
        if (order.type === 'return' && order.notes?.startsWith('Void of receipt')) return 'text-warning border-warning/50 bg-warning/10';
        if (order.type === 'return' || order.status === 'refunded' || order.status === 'partially_refunded' || order.status === 'returned') {
            return 'text-danger border-danger/50 bg-danger/10';
        }
        if (order.status === 'completed') return 'text-success border-success/50 bg-success/10';
        if (order.status === 'hold' || order.status === 'open') return 'text-warning border-warning/50 bg-warning/10';
        if (order.status === 'voided') return 'text-danger border-danger/50 bg-danger/10';
        return 'text-text-muted';
    }

    async function loadOrdersPage(): Promise<void> {
        const run = ++queryRun;
        ordersLoading = true;
        ordersLoadError = '';
        try {
            const result = await getOrdersPage({
                query: appliedSearchQuery,
                status: statusFilter,
                limit: PAGE_SIZE,
                offset: page * PAGE_SIZE,
            });
            if (run !== queryRun) return;
            sqlTotal = result.total;
            ordersTotal = result.overallTotal;
            sqlOrders = result.rows as OrderPageRow[];
            pageLinesByOrder = groupByOrderId<OrderLine>(result.lines as OrderLine[]);
            pagePaymentsByOrder = groupByOrderId<Payment>(result.payments as Payment[]);
        } catch (error) {
            if (run !== queryRun) return;
            if (isTauri()) {
                console.warn('orders: page lookup failed:', error);
                ordersLoadError = 'Order history is temporarily unavailable.';
            }
            sqlTotal = 0;
            ordersTotal = 0;
            sqlOrders = [];
            pageLinesByOrder = new Map();
            pagePaymentsByOrder = new Map();
        } finally {
            if (run === queryRun) ordersLoading = false;
        }
    }

    function paymentMethodName(method: string): string {
        return String(method || 'not recorded')
            .replace(/_/g, ' ')
            .replace(/\b\w/g, (character) => character.toUpperCase());
    }

    function paymentMethods(order: Order): string[] {
        const methods = paymentAllocationLabels(getPayments(order.id));
        if (methods.length === 0 && order.paymentMethod) {
            methods.push(paymentMethodName(order.paymentMethod));
        }
        return [...new Set(methods)];
    }

    function paymentRecordMethods(payment: Payment): string[] {
        const methods = paymentAllocationLabels([payment]);
        return methods.length > 0 ? methods : [paymentMethodName(payment.method)];
    }

    function paymentMethodSummary(order: Order): string {
        const methods = paymentMethods(order);
        return methods.length ? methods.join(' + ') : 'Not recorded';
    }

    function paymentBadgeTone(order: Order): string {
        return paymentBadgeToneForMethods(paymentMethods(order));
    }

    function paymentBadgeToneForMethods(methodNames: string[]): string {
        const methods = methodNames.map((method) => method.toLowerCase());
        if (methods.length > 1) return 'split';
        if (methods.includes('card')) return 'card';
        if (methods.includes('cash')) return 'cash';
        if (methods.includes('loyalty')) return 'loyalty';
        if (methods.includes('pay later')) return 'account';
        return 'other';
    }

    function canPrintOrder(order: Order | null): boolean {
        return Boolean(
            order &&
            order.status !== 'hold' &&
            order.status !== 'open' &&
            getLines(order.id).length > 0,
        );
    }

    async function printSelectedOrder(): Promise<void> {
        const order = selectedOrder;
        if (!order || !canPrintOrder(order) || receiptPrinting) return;
        receiptPrinting = true;
        try {
            const lines = getLines(order.id);
            const productIds = [...new Set(lines.map((line) => line.productId).filter(Boolean))];
            let products: any[] = [];
            try {
                products = await getProductsByIds(productIds, false, true);
            } catch (error) {
                console.warn('orders: product metadata unavailable while printing stored receipt:', error);
            }
            const skuByProductId = new Map(products.map((product: any) => [product.id, product.sku || '']));
            await printEscposReceipt({
                store: $storeDB,
                order,
                lines: lines.map((line) => ({
                    ...line,
                    sku: skuByProductId.get(line.productId) || '',
                })),
                payments: getPayments(order.id),
                cashierName: cashierName(order),
                tillName: tillName(order),
                design: receiptDesign,
            }, receiptPrinterConfig);
            toast(`Receipt #${order.orderNumber || '-'} sent to printer`, 'success');
        } catch (error) {
            toast(`Receipt did not print: ${String(error).replace(/^Error:\s*/, '')}`, 'error');
        } finally {
            receiptPrinting = false;
        }
    }
</script>

<MgmtPage title="Order History">
    <div class="orders-page-body">
    <div class="search-strip">
        <div class="search-strip-intro">
            <strong class="block text-sm font-black text-text-main">Find order history</strong>
            <span class="mt-1 block text-xs text-text-muted">Search receipts, items, cashiers, or customers, then narrow the list by status.</span>
        </div>
        <div class="search-controls orders-search-controls">
            <div class="search-primary">
                <SearchField
                    id="order-search"
                    bind:value={searchQuery}
                    placeholder="Receipt, item, cashier, customer..."
                    ariaLabel="Search order history"
                    keyboardLabel="Open order search keyboard"
                    clearLabel="Clear order search"
                    clearVisible={Boolean(searchQuery || appliedSearchQuery)}
                    onInput={handleOrderSearchInput}
                    onKeydown={handleOrderSearchKeydown}
                    onClear={clearOrderSearch}
                />
            </div>
            <button class="btn btn-primary search-toolbar-action order-search-submit" on:click={runOrderSearch}>Find</button>
            <div class="search-control search-filter">
                <CustomSelect bind:value={statusFilter} options={statusFilterOptions} />
            </div>
            {#if statusFilter !== 'all'}
                <button class="btn btn-secondary search-toolbar-action order-filter-reset" on:click={clearOrderFilters}>Reset</button>
            {/if}
            <span class="search-meta">
                {ordersLoading ? 'Searching...' : `${sqlTotal} / ${ordersTotal}`}
            </span>
        </div>
    </div>

    <div class="orders-table-wrap" bind:this={ordersResultsElement}>
    <table class="tbl orders-table">
        <thead>
            <tr>
                <th>#</th>
                <th>Date</th>
                <th>Status</th>
                <th>Staff / Customer</th>
                <th>Items</th>
                <th>Payment</th>
                <th>Total</th>
            </tr>
        </thead>
        <tbody>
            {#each pagedOrders as o}
                <tr>
                    <td data-label="Receipt">
                        <button class="receipt-button mono" title={o.receiptKey || `Receipt ${o.orderNumber || '-'}`} aria-label={`Open receipt ${o.orderNumber || '-'}`} on:click={() => openOrder(o)}>
                            #{o.orderNumber || '-'}
                        </button>
                    </td>
                    <td data-label="Date" title={formatDate(o.completedAt || o.createdAt)}>{formatDate(o.completedAt || o.createdAt)}</td>
                    <td data-label="Status"><span class={`tag capitalize ${statusClass(o)}`} title={statusLabel(o)}>{statusLabel(o)}</span></td>
                    <td
                        data-label="Staff / Till / Customer"
                        class="staff-cell"
                        title={`${cashierName(o)} · ${tillName(o)} · ${customerName(o) || 'Walk-in customer'}`}
                    >
                        <strong>{cashierName(o)}</strong>
                        <small>{tillName(o)} · {customerName(o) || 'Walk-in'}</small>
                    </td>
                    <td data-label="Items" class="items-cell" title={`${itemQuantity(o.id).toLocaleString('en-GB', { maximumFractionDigits: 3 })} items across ${lineCount(o.id)} lines`}><strong>{itemQuantity(o.id).toLocaleString('en-GB', { maximumFractionDigits: 3 })}</strong><small>{lineCount(o.id)} {lineCount(o.id) === 1 ? 'line' : 'lines'}</small></td>
                    <td data-label="Payment"><span class="payment-badge {paymentBadgeTone(o)}" title={paymentMethodSummary(o)}>{paymentMethodSummary(o)}</span></td>
                    <td data-label="Total" title={formatMoney(o.total)} class="money {o.total < 0 ? '!text-danger' : ''}">{formatMoney(o.total)}</td>
                </tr>
            {/each}
            {#if ordersLoading && pagedOrders.length === 0}<tr class="empty-row"><td colspan="7">Loading orders...</td></tr>{/if}
            {#if !ordersLoading && !ordersLoadError && ordersTotal === 0}<tr class="empty-row"><td colspan="7">No orders yet.</td></tr>{/if}
            {#if !ordersLoading && !ordersLoadError && ordersTotal > 0 && sqlTotal === 0}<tr class="empty-row"><td colspan="7">No orders match your filters.</td></tr>{/if}
            {#if !ordersLoading && ordersLoadError && pagedOrders.length === 0}
                <tr class="empty-row"><td colspan="7"><span>Could not load orders: {ordersLoadError}</span><button class="btn btn-secondary ml-3" on:click={loadOrdersPage}>Retry</button></td></tr>
            {/if}
        </tbody>
    </table>
    </div>

    {#if sqlTotal > PAGE_SIZE}
        <nav class="orders-pagination" aria-label="Order history pages">
            <button class="btn btn-secondary" disabled={ordersLoading || page === 0} on:click={() => changePage(page - 1)}>Newer</button>
            <span class="orders-pagination-summary" aria-live="polite">
                <strong>Page {page + 1} of {pageCount}</strong>
                <small>{page * PAGE_SIZE + 1}-{Math.min((page + 1) * PAGE_SIZE, sqlTotal)} of {sqlTotal}</small>
            </span>
            <button class="btn btn-secondary" disabled={ordersLoading || page >= pageCount - 1} on:click={() => changePage(page + 1)}>Older</button>
        </nav>
    {/if}
    </div>
</MgmtPage>

<Modal
    bind:show={showOrderDialog}
    title={selectedOrder ? `Receipt #${selectedOrder.orderNumber || '-'}` : 'Receipt Details'}
    width="1100px"
    height="min(92dvh, 820px)"
>
    {#if selectedOrder}
        <div class="order-detail-body">
            <div class="order-overview-grid">
                <div class="flat-card p-4 order-overview-card">
                    <p class="text-xs text-text-muted uppercase tracking-wide">Receipt</p>
                    <strong class="text-lg">#{selectedOrder.orderNumber || '-'}</strong>
                    {#if selectedOrder.receiptKey}<p class="mono order-overview-secondary" title={selectedOrder.receiptKey}>{selectedOrder.receiptKey}</p>{/if}
                </div>
                <div class="flat-card p-4 order-overview-card">
                    <p class="text-xs text-text-muted uppercase tracking-wide">Status</p>
                    <span class={`tag capitalize mt-2 ${statusClass(selectedOrder)}`}>{statusLabel(selectedOrder)}</span>
                    <p class="order-overview-secondary" title={formatDate(selectedOrder.completedAt || selectedOrder.createdAt)}>{formatDate(selectedOrder.completedAt || selectedOrder.createdAt)}</p>
                </div>
                <div class="flat-card p-4 order-overview-card">
                    <p class="text-xs text-text-muted uppercase tracking-wide">Till / Cashier</p>
                    <strong title={tillName(selectedOrder)}>{tillName(selectedOrder)}</strong>
                    <p class="order-overview-secondary" title={cashierName(selectedOrder)}>{cashierName(selectedOrder)}</p>
                </div>
                <div class="flat-card p-4 order-overview-card">
                    <p class="text-xs text-text-muted uppercase tracking-wide">Customer</p>
                    <strong title={customerName(selectedOrder) || 'Walk-in customer'}>{customerName(selectedOrder) || 'Walk-in customer'}</strong>
                    <p class="order-overview-secondary">{lineCount(selectedOrder.id)} lines · {itemQuantity(selectedOrder.id).toLocaleString('en-GB', { maximumFractionDigits: 3 })} items</p>
                </div>
                <div class="flat-card p-4 order-overview-card payment-overview">
                    <p class="text-xs text-text-muted uppercase tracking-wide">Payment</p>
                    <span class="payment-badge {paymentBadgeTone(selectedOrder)}" title={paymentMethodSummary(selectedOrder)}>{paymentMethodSummary(selectedOrder)}</span>
                    <p class="order-overview-secondary">
                        {getPayments(selectedOrder.id).length
                            ? `${getPayments(selectedOrder.id).length} ${getPayments(selectedOrder.id).length === 1 ? 'payment record' : 'payment records'}`
                            : 'No payment record'}
                    </p>
                </div>
            </div>

            <div class="order-money-grid">
                <div class="flat-card p-4 order-money-card">
                    <p class="text-xs text-text-muted uppercase tracking-wide">Subtotal</p>
                    <strong>{formatMoney(selectedOrder.subtotal || 0)}</strong>
                </div>
                <div class="flat-card p-4 order-money-card">
                    <p class="text-xs text-text-muted uppercase tracking-wide">Discount</p>
                    <strong>{formatMoney(selectedOrder.discountAmount || 0)}</strong>
                </div>
                <div class="flat-card p-4 order-money-card">
                    <p class="text-xs text-text-muted uppercase tracking-wide">Tax</p>
                    <strong>{formatMoney(selectedOrder.taxTotal || 0)}</strong>
                </div>
                <div class="flat-card p-4 order-money-card">
                    <p class="text-xs text-text-muted uppercase tracking-wide">Total</p>
                    <strong class="text-xl {selectedOrder.total < 0 ? 'text-danger' : 'text-success'}">{formatMoney(selectedOrder.total)}</strong>
                </div>
            </div>

            <section>
                <h4 class="text-[0.9rem] text-accent-primary mb-2">Line Items</h4>
                <div class="overflow-auto rounded-md border border-border-flat">
                    <table class="tbl order-line-table">
                        <thead>
                            <tr>
                                <th class="!bg-bg-panel">Product</th>
                                <th class="!bg-bg-panel">Qty</th>
                                <th class="!bg-bg-panel">Unit</th>
                                <th class="!bg-bg-panel">Discount</th>
                                <th class="!bg-bg-panel">Tax</th>
                                <th class="!bg-bg-panel">Line Total</th>
                            </tr>
                        </thead>
                        <tbody>
                            {#each getLines(selectedOrder.id) as line}
                                {@const scaleDisplay = getScaleSaleDisplay(line.notes, line.quantity, line.unitPrice, line.originalPrice)}
                                <tr>
                                    <td class="order-line-product">
                                        <strong title={`${line.productName}${line.isPriceOverride ? ' · Price changed' : ''}`}>{line.productName}{line.isPriceOverride ? ' · Price changed' : ''}</strong>
                                        {#if line.notes}<small title={line.notes}>{line.notes}</small>{/if}
                                    </td>
                                    <td>{scaleDisplay.label}</td>
                                    <td>{scaleDisplay.kind === 'weight' ? `${formatMoney(line.originalPrice)}/kg` : formatMoney(line.unitPrice)}</td>
                                    <td>{line.discountAmount > 0 ? formatMoney(line.discountAmount) : '-'}</td>
                                    <td>{formatMoney(line.taxAmount)}</td>
                                    <td class="money {line.lineTotal < 0 ? '!text-danger' : ''}">{formatMoney(line.lineTotal)}</td>
                                </tr>
                            {/each}
                            {#if getLines(selectedOrder.id).length === 0}<tr class="empty-row"><td colspan="6">No lines recorded for this order.</td></tr>{/if}
                        </tbody>
                    </table>
                </div>
            </section>

            <section>
                <h4 class="text-[0.9rem] text-accent-primary mb-2">Payments</h4>
                <div class="payment-table-wrap">
                    <table class="tbl payment-detail-table">
                        <thead>
                            <tr>
                                <th>Method</th>
                                <th>Paid</th>
                                <th>Breakdown</th>
                                <th>Reference / Time</th>
                            </tr>
                        </thead>
                        <tbody>
                            {#each getPayments(selectedOrder.id) as payment}
                                {@const allocation = receiptTenderBreakdown([payment])}
                                {@const methods = paymentRecordMethods(payment)}
                                <tr>
                                    <td><span class="payment-badge {paymentBadgeToneForMethods(methods)}" title={methods.join(' + ')}>{methods.join(' + ')}</span></td>
                                    <td class="money {payment.amount < 0 ? '!text-danger' : ''}">{formatMoney(payment.amount)}</td>
                                    <td>
                                        <div class="payment-allocation-list">
                                            {#if allocation.cash}<span><small>Cash</small><strong>{formatMoney(allocation.cash)}</strong></span>{/if}
                                            {#if allocation.card}<span><small>Card</small><strong>{formatMoney(allocation.card)}</strong></span>{/if}
                                            {#if payment.tipsAmount}<span><small>Tip</small><strong>{formatMoney(payment.tipsAmount)}</strong></span>{/if}
                                            {#if payment.serviceChargeAmount}<span><small>Service charge</small><strong>{formatMoney(payment.serviceChargeAmount)}</strong></span>{/if}
                                            {#if payment.cashbackAmount}<span><small>Cashback paid out</small><strong>{formatMoney(payment.cashbackAmount)}</strong></span>{/if}
                                            {#if payment.tipsAmount || payment.serviceChargeAmount || payment.cashbackAmount}
                                                <span><small>Total card charged</small><strong>{formatMoney(allocation.card + (payment.tipsAmount || 0) + (payment.serviceChargeAmount || 0) + (payment.cashbackAmount || 0))}</strong></span>
                                            {/if}
                                            {#if allocation.loyalty}<span><small>Loyalty</small><strong>{formatMoney(allocation.loyalty)}</strong></span>{/if}
                                            {#if allocation.account}<span><small>Pay Later</small><strong>{formatMoney(allocation.account)}</strong></span>{/if}
                                            {#if payment.changeGiven}<span><small>Change</small><strong>{formatMoney(payment.changeGiven)}</strong></span>{/if}
                                            {#if !allocation.cash && !allocation.card && !allocation.loyalty && !allocation.account && !payment.changeGiven}
                                                <span class="payment-allocation-empty">No allocation recorded</span>
                                            {/if}
                                        </div>
                                    </td>
                                    <td class="payment-reference-cell"><strong class="mono" title={payment.reference || 'No reference'}>{payment.reference || 'No reference'}</strong><small title={formatDate(payment.createdAt)}>{formatDate(payment.createdAt)}</small></td>
                                </tr>
                            {/each}
                            {#if getPayments(selectedOrder.id).length === 0}
                                <tr class="empty-row"><td colspan="4">No payments were recorded for this order.</td></tr>
                            {/if}
                        </tbody>
                    </table>
                </div>
            </section>

            <section>
                <h4 class="text-[0.9rem] text-accent-primary mb-2">Transaction Record</h4>
                <dl class="transaction-record">
                    <div><dt>Order type</dt><dd>{selectedOrder.type.replace(/_/g, ' ')}</dd></div>
                    <div><dt>Created</dt><dd>{formatDate(selectedOrder.createdAt)}</dd></div>
                    <div><dt>Completed</dt><dd>{formatDate(selectedOrder.completedAt)}</dd></div>
                    <div><dt>Order ID</dt><dd class="mono" title={selectedOrder.id}>{selectedOrder.id}</dd></div>
                    {#if selectedOrder.originalOrderId}
                        <div class="transaction-original"><dt>Original order</dt><dd class="mono" title={selectedOrder.originalOrderId}>{selectedOrder.originalOrderId}</dd></div>
                    {/if}
                </dl>
            </section>

            {#if selectedOrder.notes}
                <section>
                    <h4 class="text-[0.9rem] text-accent-primary mb-2">Notes</h4>
                    <div class="flat-card p-4 order-notes">{selectedOrder.notes}</div>
                </section>
            {/if}
        </div>
    {/if}

    <svelte:fragment slot="footer">
        <button class="btn btn-secondary" on:click={() => showOrderDialog = false}>Close</button>
        <button
            class="btn btn-primary order-print-button"
            disabled={!canPrintOrder(selectedOrder) || receiptPrinting}
            title={canPrintOrder(selectedOrder) ? 'Print this receipt using this till printer' : 'Only completed receipt records can be printed'}
            on:click={printSelectedOrder}
        >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M6 9V2h12v7"></path><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><rect x="6" y="14" width="12" height="8"></rect>
            </svg>
            {receiptPrinting ? 'Printing...' : 'Print Receipt'}
        </button>
    </svelte:fragment>
</Modal>

<style>
    .orders-page-body { width: 100%; height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
    .orders-page-body > .search-strip { flex: 0 0 auto; }
    .orders-table-wrap { min-height: 0; flex: 1 1 auto; overflow: auto; }
    .orders-table { min-width: 900px; }
    .receipt-button { min-width: 4.25rem; min-height: 2.1rem; padding: .35rem .55rem; color: var(--accent-primary); font-weight: 900; text-align: left; border: 1px solid var(--border-flat); border-radius: .35rem; background: var(--bg-card); }
    .receipt-button:hover { color: white; border-color: var(--accent-primary); background: var(--accent-primary); }
    .staff-cell strong, .staff-cell small, .items-cell strong, .items-cell small { max-width: 100%; min-width: 0; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .staff-cell small, .items-cell small { margin-top: .15rem; color: var(--text-muted); font-size: .7rem; }
    .payment-badge { width: fit-content; max-width: 100%; min-height: 1.75rem; padding: .25rem .55rem; display: inline-flex; align-items: center; overflow: hidden; color: var(--text-main); font-size: .7rem; font-weight: 900; line-height: 1.1; white-space: nowrap; text-overflow: ellipsis; border: 1px solid var(--border-flat); border-radius: .35rem; background: var(--bg-panel); }
    .payment-badge.cash { color: var(--success); border-color: color-mix(in srgb, var(--success) 45%, var(--border-flat)); background: color-mix(in srgb, var(--success) 10%, var(--bg-card)); }
    .payment-badge.card { color: var(--accent-primary); border-color: color-mix(in srgb, var(--accent-primary) 45%, var(--border-flat)); background: color-mix(in srgb, var(--accent-primary) 10%, var(--bg-card)); }
    .payment-badge.loyalty { color: var(--accent-primary); border-color: color-mix(in srgb, var(--accent-primary) 45%, var(--border-flat)); background: color-mix(in srgb, var(--accent-primary) 10%, var(--bg-card)); }
    .payment-badge.account { color: var(--warning); border-color: color-mix(in srgb, var(--warning) 45%, var(--border-flat)); background: color-mix(in srgb, var(--warning) 10%, var(--bg-card)); }
    .payment-badge.split { color: var(--warning); border-color: color-mix(in srgb, var(--warning) 50%, var(--border-flat)); background: color-mix(in srgb, var(--warning) 10%, var(--bg-card)); }
    .orders-pagination { min-height: 4.3rem; padding: .65rem .85rem; flex: 0 0 auto; z-index: 4; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: .7rem; border-top: 1px solid var(--border-flat); background: var(--bg-panel); }
    .orders-pagination-summary { min-width: 0; display: flex; flex-wrap: wrap; justify-content: center; align-items: baseline; gap: .25rem .55rem; color: var(--text-muted); text-align: center; }
    .orders-pagination-summary strong { color: var(--text-main); font-size: .78rem; }
    .orders-pagination-summary small { font-size: .72rem; font-weight: 750; }
    .order-detail-body { display: flex; flex-direction: column; gap: 1.25rem; }
    .order-overview-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: .65rem; }
    .order-overview-card { min-width: 0; overflow: hidden; }
    .order-overview-card > strong, .order-overview-card > .tag { max-width: 100%; }
    .order-overview-card > strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .order-overview-secondary { max-width: 100%; margin-top: .35rem; overflow: hidden; color: var(--text-muted); font-size: .75rem; line-height: 1.25; text-overflow: ellipsis; white-space: nowrap; }
    .payment-overview .payment-badge { margin-top: .45rem; }
    .order-money-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: .75rem; }
    .order-money-card { min-width: 0; }
    .order-money-card strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .order-line-product strong, .order-line-product small { display: block; }
    .order-line-product strong { max-width: 100%; overflow: hidden; line-height: 1.25; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; }
    .order-line-product small { max-width: 320px; margin-top: .18rem; overflow: hidden; color: var(--text-muted); font-size: .68rem; line-height: 1.25; text-overflow: ellipsis; white-space: nowrap; }
    .payment-table-wrap { overflow: auto; border: 1px solid var(--border-flat); border-radius: .4rem; }
    .payment-detail-table { min-width: 660px; table-layout: fixed; }
    .payment-detail-table th:nth-child(1) { width: 20%; }
    .payment-detail-table th:nth-child(2) { width: 14%; }
    .payment-detail-table th:nth-child(3) { width: 41%; }
    .payment-detail-table th:nth-child(4) { width: 25%; }
    .payment-detail-table th { background: var(--bg-panel); }
    .payment-allocation-list { display: flex; flex-wrap: wrap; gap: .3rem; }
    .payment-allocation-list > span { min-width: 72px; padding: .28rem .42rem; display: flex; flex-direction: column; gap: .08rem; border: 1px solid var(--border-flat); border-radius: .3rem; background: var(--bg-panel); }
    .payment-allocation-list small { color: var(--text-muted); font-size: .6rem; font-weight: 850; text-transform: uppercase; }
    .payment-allocation-list strong { font-size: .73rem; }
    .payment-allocation-list .payment-allocation-empty { color: var(--text-muted); font-size: .72rem; }
    .payment-reference-cell strong, .payment-reference-cell small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .payment-reference-cell small { margin-top: .25rem; color: var(--text-muted); font-size: .68rem; }
    .transaction-record { margin: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border: 1px solid var(--border-flat); border-radius: .4rem; overflow: hidden; }
    .transaction-record > div { min-width: 0; padding: .7rem .8rem; border-right: 1px solid var(--border-flat); background: var(--bg-card); }
    .transaction-record > div:nth-child(4) { border-right: 0; }
    .transaction-record > div:last-child { border-right: 0; }
    .transaction-record > .transaction-original { grid-column: 1 / -1; border-top: 1px solid var(--border-flat); }
    .transaction-record dt { color: var(--text-muted); font-size: .68rem; font-weight: 850; text-transform: uppercase; }
    .transaction-record dd { margin: .2rem 0 0; overflow: hidden; font-size: .8rem; font-weight: 750; text-overflow: ellipsis; white-space: nowrap; }
    .order-notes { overflow-wrap: anywhere; white-space: pre-wrap; }
    .order-print-button { display: inline-flex; align-items: center; gap: .45rem; }
    .order-print-button svg { width: 18px; height: 18px; }
    @media (max-width: 900px) {
        .orders-search-controls { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: end; gap: .5rem; }
        .orders-search-controls .search-primary { width: auto; min-width: 0; max-width: none; grid-column: 1 / 3; }
        .orders-search-controls .order-search-submit { grid-column: 3; }
        .orders-search-controls .search-filter { width: auto; min-width: 0; grid-column: 1; }
        .orders-search-controls .order-filter-reset { grid-column: 2; }
        .orders-search-controls .search-meta { grid-column: 3; }

        .orders-table-wrap { padding: .45rem; overflow-x: hidden; background: var(--bg-base); }
        .orders-table { width: 100%; min-width: 0; display: block; }
        .orders-table thead { width: 1px; height: 1px; margin: -1px; padding: 0; position: absolute; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
        .orders-table tbody { display: grid; gap: .4rem; }
        .orders-table tr:not(.empty-row) { min-width: 0; display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); border: 1px solid var(--border-flat); border-radius: .45rem; overflow: hidden; background: var(--bg-panel); }
        .orders-table tr:not(.empty-row):hover { border-color: color-mix(in srgb, var(--accent-primary) 52%, var(--border-flat)); }
        .orders-table tr:not(.empty-row) td { width: auto; height: auto; min-height: 49px; padding: .34rem .48rem; display: flex; flex-direction: column; justify-content: center; overflow: hidden; border: 0; }
        .orders-table tr:not(.empty-row) td::before { margin-bottom: .12rem; display: block; color: var(--text-muted); content: attr(data-label); font-size: .56rem; font-weight: 900; letter-spacing: .04em; line-height: 1; text-transform: uppercase; }
        .orders-table tr:not(.empty-row) td:nth-child(1) { grid-column: 1 / 3; grid-row: 1; }
        .orders-table tr:not(.empty-row) td:nth-child(2) { grid-column: 3 / 7; grid-row: 1; }
        .orders-table tr:not(.empty-row) td:nth-child(3) { grid-column: 7 / 10; grid-row: 1; }
        .orders-table tr:not(.empty-row) td:nth-child(7) { grid-column: 10 / 13; grid-row: 1; }
        .orders-table tr:not(.empty-row) td:nth-child(4) { grid-column: 1 / 6; grid-row: 2; border-top: 1px solid var(--border-flat); }
        .orders-table tr:not(.empty-row) td:nth-child(5) { grid-column: 6 / 8; grid-row: 2; border-top: 1px solid var(--border-flat); }
        .orders-table tr:not(.empty-row) td:nth-child(6) { grid-column: 8 / 13; grid-row: 2; border-top: 1px solid var(--border-flat); }
        .orders-table tr:not(.empty-row) td:not(:nth-child(4)) { border-left: 1px solid var(--border-flat); }
        .orders-table tr:not(.empty-row) td:nth-child(1),
        .orders-table tr:not(.empty-row) td:nth-child(4) { border-left: 0; }
        .orders-table .receipt-button { width: fit-content; max-width: 100%; min-width: 0; }
        .orders-table .tag, .orders-table .payment-badge { width: fit-content; max-width: 100%; min-width: 0; }
        .orders-table .empty-row { display: block; }
        .orders-table .empty-row td { width: 100%; min-height: 128px; display: grid; place-items: center; border: 1px dashed var(--border-flat); border-radius: .45rem; background: var(--bg-panel); }

        .order-detail-body { gap: .75rem; }
        .order-overview-grid { grid-template-columns: repeat(5, minmax(0, 1fr)); gap: .4rem; }
        .order-overview-card { min-height: 74px; padding: .55rem !important; }
        .order-overview-card > p:first-child { font-size: .58rem !important; line-height: 1; }
        .order-overview-card > .text-lg { font-size: .9rem !important; }
        .order-overview-card > strong { margin-top: .25rem; font-size: .78rem; }
        .order-overview-card > .tag { margin-top: .3rem !important; font-size: .62rem; }
        .order-overview-card .payment-badge { min-height: 1.45rem; margin-top: .28rem; padding: .18rem .35rem; font-size: .62rem; }
        .order-overview-secondary { margin-top: .25rem; font-size: .62rem; }
        .order-money-grid { gap: .4rem; }
        .order-money-card { padding: .55rem !important; }
        .order-money-card p { font-size: .58rem !important; }
        .order-money-card strong { margin-top: .12rem; font-size: .82rem; }
        .order-money-card strong.text-xl { font-size: 1rem !important; }
        .payment-allocation-list > span { min-width: 60px; padding: .22rem .34rem; }
        .transaction-record > div { padding: .55rem .6rem; }
        .order-line-table { min-width: 660px; table-layout: fixed; }
        .order-line-table th:first-child { width: 32%; }
        .order-line-table th:not(:first-child) { width: 13.6%; }
        .transaction-record { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .transaction-record > div:nth-child(2n) { border-right: 0; }
        .transaction-record > div:nth-child(n+3) { border-top: 1px solid var(--border-flat); }
    }
    :global(.back-office-route) .orders-table .receipt-button { width: 100%; min-width: 0; padding-inline: .35rem; }
    @media (max-width: 900px) {
        :global(.back-office-route) .orders-table { min-width: 0 !important; }
        :global(.back-office-route) .orders-table-wrap { overflow-x: hidden !important; }
        :global(.back-office-route) .orders-table tr:not(.empty-row) td { width: auto !important; }
    }
    @media (max-width: 680px) {
        .order-overview-grid { grid-template-columns: 1fr 1fr; }
        .order-overview-grid .payment-overview { grid-column: 1 / -1; }
        .order-money-grid { grid-template-columns: 1fr 1fr; }
        .order-line-table, .payment-detail-table { min-width: 620px; }
        .orders-pagination { padding-inline: .4rem; }
        .orders-pagination .btn { min-width: 0; padding-inline: .55rem; }
        .orders-pagination-summary { flex-direction: column; align-items: center; gap: .05rem; }
    }
    @media (min-width: 681px) and (max-width: 900px) {
        .order-line-table, .payment-detail-table { width: 100%; min-width: 0; }
        .order-line-table th, .order-line-table td,
        .payment-detail-table th, .payment-detail-table td { padding-inline: .55rem; }
    }

    /* Back Office is a keyboard-and-mouse workspace. Its permanent sidebar
       makes viewport media queries treat this list like a touch screen, so
       restore a compact desktop table based on the actual available width. */
    :global(.back-office-route) .orders-search-controls {
        display: grid !important;
        grid-template-columns: minmax(125px, 1fr) auto minmax(155px, .72fr) auto auto !important;
        align-items: end;
        gap: .4rem !important;
    }
    :global(.back-office-route) .orders-search-controls .search-primary,
    :global(.back-office-route) .orders-search-controls .order-search-submit,
    :global(.back-office-route) .orders-search-controls .search-filter,
    :global(.back-office-route) .orders-search-controls .order-filter-reset,
    :global(.back-office-route) .orders-search-controls .search-meta {
        width: auto;
        min-width: 0;
        grid-column: auto !important;
    }
    :global(.back-office-route) .orders-table-wrap {
        padding: 0 !important;
        overflow: auto !important;
        background: var(--bg-panel) !important;
    }
    :global(.back-office-route) .orders-table {
        width: 100% !important;
        min-width: 560px !important;
        display: table !important;
        table-layout: fixed;
    }
    :global(.back-office-route) .orders-table thead {
        width: auto;
        height: auto;
        margin: 0;
        padding: 0;
        position: static;
        display: table-header-group;
        overflow: visible;
        clip: auto;
        white-space: normal;
        border: 0;
    }
    :global(.back-office-route) .orders-table tbody { display: table-row-group; }
    :global(.back-office-route) .orders-table tr,
    :global(.back-office-route) .orders-table tr:not(.empty-row) {
        display: table-row !important;
        border: 0;
        border-radius: 0;
        overflow: visible;
        background: transparent;
    }
    :global(.back-office-route) .orders-table tr:not(.empty-row) td {
        width: auto !important;
        height: 48px !important;
        min-height: 0;
        padding: .3rem .38rem !important;
        display: table-cell !important;
        overflow: hidden;
        vertical-align: middle;
        border: 0 !important;
        border-bottom: 1px solid var(--border-flat) !important;
        font-size: .76rem;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    :global(.back-office-route) .orders-table tr:not(.empty-row) td::before {
        display: none !important;
        content: none;
    }
    :global(.back-office-route) .orders-table th {
        padding-inline: .38rem !important;
        overflow: hidden;
        font-size: .6rem !important;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    :global(.back-office-route) .orders-table :is(th, td):nth-child(1) { width: 8%; }
    :global(.back-office-route) .orders-table :is(th, td):nth-child(2) { width: 18%; }
    :global(.back-office-route) .orders-table :is(th, td):nth-child(3) { width: 14%; }
    :global(.back-office-route) .orders-table :is(th, td):nth-child(4) { width: 26%; }
    :global(.back-office-route) .orders-table :is(th, td):nth-child(5) { width: 9%; }
    :global(.back-office-route) .orders-table :is(th, td):nth-child(6) { width: 14%; }
    :global(.back-office-route) .orders-table :is(th, td):nth-child(7) { width: 11%; }
    :global(.back-office-route) .orders-table .receipt-button {
        width: auto !important;
        min-width: 0;
        min-height: 30px;
        padding: .22rem .38rem;
        font-size: .72rem;
        text-align: center;
    }
    :global(.back-office-route) .orders-table .staff-cell small,
    :global(.back-office-route) .orders-table .items-cell small { font-size: .62rem; }
    :global(.back-office-route) .orders-table .tag,
    :global(.back-office-route) .orders-table .payment-badge {
        max-width: 100%;
        min-height: 26px;
        padding: .18rem .36rem;
        font-size: .62rem;
    }
    :global(.back-office-route) .orders-table .empty-row { display: table-row !important; }
    :global(.back-office-route) .orders-table .empty-row td {
        width: auto !important;
        height: 128px;
        display: table-cell !important;
        border: 0;
        border-bottom: 1px dashed var(--border-flat);
        border-radius: 0;
    }
    @container management (max-width: 620px) {
        :global(.back-office-route) .orders-search-controls { grid-template-columns: minmax(0,1fr) auto !important; }
        :global(.back-office-route) .orders-search-controls .search-meta { grid-column: 1 / -1 !important; }
    }
</style>
