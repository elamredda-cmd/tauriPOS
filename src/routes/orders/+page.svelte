<script lang="ts">
    import { isTauri } from '@tauri-apps/api/core';
    import { onDestroy, onMount } from 'svelte';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import Modal from '$lib/components/Modal.svelte';
    import CustomSelect from '$lib/components/CustomSelect.svelte';
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
        const methods: string[] = [];
        for (const payment of getPayments(order.id)) {
            if (payment.method === 'split') {
                if (payment.cashAmount) methods.push('Cash');
                if (payment.cardAmount) methods.push('Card');
            } else {
                methods.push(paymentMethodName(payment.method));
            }
        }
        if (methods.length === 0 && order.paymentMethod) {
            methods.push(paymentMethodName(order.paymentMethod));
        }
        return [...new Set(methods)];
    }

    function paymentMethodSummary(order: Order): string {
        const methods = paymentMethods(order);
        return methods.length ? methods.join(' + ') : 'Not recorded';
    }

    function paymentBadgeTone(order: Order): string {
        const methods = paymentMethods(order).map((method) => method.toLowerCase());
        if (methods.includes('cash') && methods.includes('card')) return 'split';
        if (methods.includes('card')) return 'card';
        if (methods.includes('cash')) return 'cash';
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
        if (receiptPrinterConfig.connection === 'system') {
            toast('Set Receipt Printer to USB raw, Network, Serial, or Bluetooth first', 'error');
            return;
        }

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
    <div class="orders-toolbar">
            <div class="order-search-control">
                <div class="pointer-events-none absolute inset-y-0 left-0 flex w-10 items-center justify-center">
                    <svg class="text-text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18">
                        <circle cx="11" cy="11" r="8"></circle>
                        <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                    </svg>
                </div>
                <input
                    class="search-input !h-11 !min-h-11 !rounded-md !bg-bg-card !pl-10 !pr-10 !text-sm"
                    value={searchQuery}
                    on:input={handleOrderSearchInput}
                    on:keydown={handleOrderSearchKeydown}
                    placeholder="Receipt, item, cashier, customer..."
                />
                {#if searchQuery || appliedSearchQuery}
                    <button
                        type="button"
                        class="order-search-clear"
                        aria-label="Clear receipt search"
                        title="Clear search"
                        on:click={clearOrderSearch}
                    >
                        ×
                    </button>
                {/if}
            </div>
            <button class="btn btn-secondary order-find" on:click={runOrderSearch}>Find</button>
            <div class="order-filter">
                <CustomSelect bind:value={statusFilter} options={statusFilterOptions} />
            </div>
            <span class="order-count">
                {ordersLoading ? 'Searching...' : `${sqlTotal} / ${ordersTotal}`}
            </span>
            {#if statusFilter !== 'all'}
                <button class="btn btn-secondary order-reset" on:click={clearOrderFilters}>Reset</button>
            {/if}
    </div>

    <div class="orders-table-wrap">
    <table class="tbl orders-table">
        <thead>
            <tr>
                <th>#</th>
                <th>Date</th>
                <th>Status</th>
                <th>Staff / Till</th>
                <th>Items</th>
                <th>Payment</th>
                <th>Total</th>
            </tr>
        </thead>
        <tbody>
            {#each pagedOrders as o}
                <tr>
                    <td>
                        <button class="receipt-button mono" aria-label={`Open receipt ${o.orderNumber || '-'}`} on:click={() => openOrder(o)}>
                            #{o.orderNumber || '-'}
                        </button>
                    </td>
                    <td>{formatDate(o.completedAt || o.createdAt)}</td>
                    <td><span class={`tag capitalize ${statusClass(o)}`}>{statusLabel(o)}</span></td>
                    <td class="staff-cell"><strong>{cashierName(o)}</strong><small>{tillName(o)}</small></td>
                    <td class="items-cell"><strong>{itemQuantity(o.id).toLocaleString('en-GB', { maximumFractionDigits: 3 })}</strong><small>{lineCount(o.id)} {lineCount(o.id) === 1 ? 'line' : 'lines'}</small></td>
                    <td><span class="payment-badge {paymentBadgeTone(o)}">{paymentMethodSummary(o)}</span></td>
                    <td class="money {o.total < 0 ? '!text-danger' : ''}">{formatMoney(o.total)}</td>
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
        <div class="flex items-center justify-between gap-3 p-4 border-t border-border-flat bg-bg-panel">
            <button class="btn btn-secondary" disabled={page === 0} on:click={() => { page--; selectedOrderId = ''; showOrderDialog = false; }}>Newer</button>
            <span class="text-sm text-text-muted font-semibold">
                Page {page + 1} of {pageCount} · {page * PAGE_SIZE + 1}-{Math.min((page + 1) * PAGE_SIZE, sqlTotal)} of {sqlTotal}
            </span>
            <button class="btn btn-secondary" disabled={page >= pageCount - 1} on:click={() => { page++; selectedOrderId = ''; showOrderDialog = false; }}>Older</button>
        </div>
    {/if}
</MgmtPage>

<Modal
    bind:show={showOrderDialog}
    title={selectedOrder ? `Receipt #${selectedOrder.orderNumber || '-'}` : 'Receipt Details'}
    width="1100px"
    height="min(88vh, 780px)"
>
    {#if selectedOrder}
        <div class="flex flex-col gap-5">
            <div class="order-overview-grid">
                <div class="flat-card p-4">
                    <p class="text-xs text-text-muted uppercase tracking-wide">Receipt</p>
                    <strong class="text-lg">#{selectedOrder.orderNumber || '-'}</strong>
                    {#if selectedOrder.receiptKey}<p class="mono mt-1 break-all">{selectedOrder.receiptKey}</p>{/if}
                </div>
                <div class="flat-card p-4">
                    <p class="text-xs text-text-muted uppercase tracking-wide">Status</p>
                    <span class={`tag capitalize mt-2 ${statusClass(selectedOrder)}`}>{statusLabel(selectedOrder)}</span>
                    <p class="text-sm text-text-muted mt-2">{formatDate(selectedOrder.completedAt || selectedOrder.createdAt)}</p>
                </div>
                <div class="flat-card p-4">
                    <p class="text-xs text-text-muted uppercase tracking-wide">Till / Cashier</p>
                    <strong>{tillName(selectedOrder)}</strong>
                    <p class="text-sm text-text-muted mt-1">{cashierName(selectedOrder)}</p>
                </div>
                <div class="flat-card p-4">
                    <p class="text-xs text-text-muted uppercase tracking-wide">Customer</p>
                    <strong>{customerName(selectedOrder) || 'Walk-in customer'}</strong>
                    <p class="text-sm text-text-muted mt-1">{lineCount(selectedOrder.id)} lines · {itemQuantity(selectedOrder.id).toLocaleString('en-GB', { maximumFractionDigits: 3 })} items</p>
                </div>
                <div class="flat-card p-4 payment-overview">
                    <p class="text-xs text-text-muted uppercase tracking-wide">Payment</p>
                    <span class="payment-badge {paymentBadgeTone(selectedOrder)}">{paymentMethodSummary(selectedOrder)}</span>
                    <p class="text-sm text-text-muted mt-2">
                        {getPayments(selectedOrder.id).length
                            ? `${getPayments(selectedOrder.id).length} ${getPayments(selectedOrder.id).length === 1 ? 'payment record' : 'payment records'}`
                            : 'No payment record'}
                    </p>
                </div>
            </div>

            <div class="grid grid-cols-1 gap-3 md:grid-cols-4">
                <div class="flat-card p-4">
                    <p class="text-xs text-text-muted uppercase tracking-wide">Subtotal</p>
                    <strong>{formatMoney(selectedOrder.subtotal || 0)}</strong>
                </div>
                <div class="flat-card p-4">
                    <p class="text-xs text-text-muted uppercase tracking-wide">Discount</p>
                    <strong>{formatMoney(selectedOrder.discountAmount || 0)}</strong>
                </div>
                <div class="flat-card p-4">
                    <p class="text-xs text-text-muted uppercase tracking-wide">Tax</p>
                    <strong>{formatMoney(selectedOrder.taxTotal || 0)}</strong>
                </div>
                <div class="flat-card p-4">
                    <p class="text-xs text-text-muted uppercase tracking-wide">Total</p>
                    <strong class="text-xl {selectedOrder.total < 0 ? 'text-danger' : 'text-success'}">{formatMoney(selectedOrder.total)}</strong>
                </div>
            </div>

            <section>
                <h4 class="text-[0.9rem] text-accent-primary mb-2">Line Items</h4>
                <div class="overflow-auto rounded-md border border-border-flat">
                    <table class="tbl">
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
                                        <strong>{line.productName}{line.isPriceOverride ? ' · Price changed' : ''}</strong>
                                        {#if line.notes}<small>{line.notes}</small>{/if}
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
                                <th>Cash Received</th>
                                <th>Card Charged</th>
                                <th>Change</th>
                                <th>Reference</th>
                                <th>Time</th>
                            </tr>
                        </thead>
                        <tbody>
                            {#each getPayments(selectedOrder.id) as payment}
                                <tr>
                                    <td><span class="payment-badge {payment.method}">{paymentMethodName(payment.method)}</span></td>
                                    <td class="money {payment.amount < 0 ? '!text-danger' : ''}">{formatMoney(payment.amount)}</td>
                                    <td>{payment.cashAmount ? formatMoney(payment.cashAmount) : '-'}</td>
                                    <td>{payment.cardAmount ? formatMoney(payment.cardAmount) : '-'}</td>
                                    <td>{payment.changeGiven ? formatMoney(payment.changeGiven) : '-'}</td>
                                    <td class="mono">{payment.reference || '-'}</td>
                                    <td>{formatDate(payment.createdAt)}</td>
                                </tr>
                            {/each}
                            {#if getPayments(selectedOrder.id).length === 0}
                                <tr class="empty-row"><td colspan="7">No payments were recorded for this order.</td></tr>
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
                    <div><dt>Order ID</dt><dd class="mono">{selectedOrder.id}</dd></div>
                    {#if selectedOrder.originalOrderId}
                        <div class="transaction-original"><dt>Original order</dt><dd class="mono">{selectedOrder.originalOrderId}</dd></div>
                    {/if}
                </dl>
            </section>

            {#if selectedOrder.notes}
                <section>
                    <h4 class="text-[0.9rem] text-accent-primary mb-2">Notes</h4>
                    <div class="flat-card p-4">{selectedOrder.notes}</div>
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
    .orders-toolbar { min-width: 0; padding: .75rem 1rem; display: flex; align-items: center; gap: .6rem; border-bottom: 1px solid var(--border-flat); background: var(--bg-panel); }
    .order-search-control { position: relative; min-width: 220px; max-width: 520px; flex: 1; }
    .order-search-clear { position: absolute; right: .4rem; top: 50%; width: 1.9rem; height: 1.9rem; display: grid; place-items: center; transform: translateY(-50%); color: var(--text-muted); font-size: 1.2rem; border: 1px solid var(--border-flat); border-radius: .35rem; background: var(--bg-base); }
    .order-search-clear:hover { color: var(--text-main); border-color: var(--accent-primary); }
    .order-find { height: 44px; min-height: 44px; padding-inline: 1rem; }
    .order-filter { width: 190px; flex: 0 0 190px; }
    .order-count { min-width: 76px; padding: .55rem .65rem; color: var(--text-muted); font-size: .72rem; font-weight: 800; text-align: center; border: 1px solid var(--border-flat); border-radius: .45rem; background: var(--bg-card); }
    .order-reset { min-height: 40px; padding: .45rem .7rem; font-size: .75rem; }
    .orders-table-wrap { overflow: auto; }
    .orders-table { min-width: 900px; }
    .receipt-button { min-width: 4.25rem; min-height: 2.1rem; padding: .35rem .55rem; color: var(--accent-primary); font-weight: 900; text-align: left; border: 1px solid var(--border-flat); border-radius: .35rem; background: var(--bg-card); }
    .receipt-button:hover { color: white; border-color: var(--accent-primary); background: var(--accent-primary); }
    .staff-cell strong, .staff-cell small, .items-cell strong, .items-cell small { display: block; }
    .staff-cell small, .items-cell small { margin-top: .15rem; color: var(--text-muted); font-size: .7rem; }
    .payment-badge { width: fit-content; max-width: 100%; min-height: 1.75rem; padding: .25rem .55rem; display: inline-flex; align-items: center; overflow: hidden; color: var(--text-main); font-size: .7rem; font-weight: 900; line-height: 1.1; white-space: nowrap; text-overflow: ellipsis; border: 1px solid var(--border-flat); border-radius: .35rem; background: var(--bg-panel); }
    .payment-badge.cash { color: var(--success); border-color: color-mix(in srgb, var(--success) 45%, var(--border-flat)); background: color-mix(in srgb, var(--success) 10%, var(--bg-card)); }
    .payment-badge.card { color: var(--accent-primary); border-color: color-mix(in srgb, var(--accent-primary) 45%, var(--border-flat)); background: color-mix(in srgb, var(--accent-primary) 10%, var(--bg-card)); }
    .payment-badge.split { color: var(--warning); border-color: color-mix(in srgb, var(--warning) 50%, var(--border-flat)); background: color-mix(in srgb, var(--warning) 10%, var(--bg-card)); }
    .order-overview-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: .65rem; }
    .payment-overview .payment-badge { margin-top: .45rem; }
    .order-line-product strong, .order-line-product small { display: block; }
    .order-line-product small { max-width: 320px; margin-top: .18rem; overflow: hidden; color: var(--text-muted); font-size: .68rem; line-height: 1.25; text-overflow: ellipsis; white-space: nowrap; }
    .payment-table-wrap { overflow: auto; border: 1px solid var(--border-flat); border-radius: .4rem; }
    .payment-detail-table { min-width: 900px; }
    .payment-detail-table th { background: var(--bg-panel); }
    .transaction-record { margin: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border: 1px solid var(--border-flat); border-radius: .4rem; overflow: hidden; }
    .transaction-record > div { min-width: 0; padding: .7rem .8rem; border-right: 1px solid var(--border-flat); background: var(--bg-card); }
    .transaction-record > div:nth-child(4) { border-right: 0; }
    .transaction-record > div:last-child { border-right: 0; }
    .transaction-record > .transaction-original { grid-column: 1 / -1; border-top: 1px solid var(--border-flat); }
    .transaction-record dt { color: var(--text-muted); font-size: .68rem; font-weight: 850; text-transform: uppercase; }
    .transaction-record dd { margin: .2rem 0 0; overflow: hidden; font-size: .8rem; font-weight: 750; text-overflow: ellipsis; white-space: nowrap; }
    .order-print-button { display: inline-flex; align-items: center; gap: .45rem; }
    .order-print-button svg { width: 18px; height: 18px; }
    @media (max-width: 900px) {
        .orders-toolbar { flex-wrap: wrap; }
        .order-search-control { max-width: none; }
        .order-filter { width: 160px; flex-basis: 160px; }
        .order-overview-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
        .transaction-record { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .transaction-record > div:nth-child(2n) { border-right: 0; }
        .transaction-record > div:nth-child(n+3) { border-top: 1px solid var(--border-flat); }
    }
    @media (max-width: 680px) {
        .order-search-control { min-width: 100%; flex-basis: 100%; }
        .order-filter { flex: 1; }
        .order-overview-grid { grid-template-columns: 1fr 1fr; }
    }
</style>
