<script lang="ts">
    import { onDestroy, onMount } from 'svelte';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import Modal from '$lib/components/Modal.svelte';
    import CustomSelect from '$lib/components/CustomSelect.svelte';
    import {
        formatMoney,
        type Order,
        type OrderLine,
        type Payment,
    } from '$lib/stores/db';
    import { getOrdersPage } from '$lib/stores/database';
    import { getScaleSaleDisplay } from '$lib/scaleSale';

    type OrderPageRow = Order & {
        cashierName?: string;
        tillName?: string;
        customerName?: string;
    };

    const PAGE_SIZE = 25;
    const ORDER_SEARCH_DELAY_MS = 140;
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

    $: pageCount = Math.max(1, Math.ceil(sqlTotal / PAGE_SIZE));
    $: if (page >= pageCount) page = pageCount - 1;
    $: pagedOrders = sqlOrders;
    $: {
        const filterKey = `${searchQuery}|${statusFilter}`;
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
        previousFilterKey = `${searchQuery}|${statusFilter}`;
        previousQueryKey = `${previousFilterKey}|${page}`;
        void loadOrdersPage();
    });

    onDestroy(() => {
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

    function scheduleOrdersLoad(delay = ORDER_SEARCH_DELAY_MS) {
        if (ordersLoadTimer) clearTimeout(ordersLoadTimer);
        ordersLoadTimer = setTimeout(() => {
            ordersLoadTimer = null;
            void loadOrdersPage();
        }, delay);
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
                query: searchQuery,
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
            console.warn('orders: page lookup failed:', error);
            if (run !== queryRun) return;
            ordersLoadError = String(error).replace(/^Error:\s*/, '');
            sqlTotal = 0;
            ordersTotal = 0;
            sqlOrders = [];
            pageLinesByOrder = new Map();
            pagePaymentsByOrder = new Map();
        } finally {
            if (run === queryRun) ordersLoading = false;
        }
    }

    function paymentSummary(payment: Payment): string {
        if (payment.method === 'split') {
            const parts = [];
            if (payment.cashAmount) parts.push(`cash ${formatMoney(payment.cashAmount)}`);
            if (payment.cardAmount) parts.push(`card ${formatMoney(payment.cardAmount)}`);
            return parts.length ? parts.join(' + ') : formatMoney(payment.amount);
        }
        if (payment.method === 'cash' && payment.cashAmount) return formatMoney(payment.cashAmount);
        if (payment.method === 'card' && payment.cardAmount) return formatMoney(payment.cardAmount);
        return formatMoney(payment.amount);
    }
</script>

<MgmtPage title="Order History">
    <div slot="actions" class="flex min-w-0 flex-1 items-center justify-end gap-3">
        <div class="flex min-w-0 flex-1 max-w-[760px] items-center gap-3">
            <div class="relative min-w-[230px] flex-1">
                <div class="pointer-events-none absolute inset-y-0 left-0 flex w-10 items-center justify-center">
                    <svg class="text-text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18">
                        <circle cx="11" cy="11" r="8"></circle>
                        <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                    </svg>
                </div>
                <input
                    class="search-input !h-11 !min-h-11 !rounded-md !bg-bg-card !pl-10 !pr-16 !text-sm"
                    bind:value={searchQuery}
                    placeholder="Search receipt..."
                />
                {#if searchQuery}
                    <button
                        type="button"
                        class="absolute right-1.5 top-1/2 min-h-0 -translate-y-1/2 rounded-sm border border-border-flat bg-bg-base px-2 py-1 text-[0.7rem] font-bold text-text-muted transition hover:border-accent-primary hover:bg-bg-card-hover hover:text-text-main"
                        on:click={() => searchQuery = ''}
                    >
                        Clear
                    </button>
                {/if}
            </div>
            <div class="min-w-[190px] max-w-[220px]">
                <CustomSelect bind:value={statusFilter} options={statusFilterOptions} />
            </div>
        </div>
        <div class="flex shrink-0 items-center gap-2">
            <span class="rounded-full border border-border-flat bg-bg-card px-3 py-2 text-xs font-bold text-text-muted">
                {ordersLoading ? 'Searching...' : `${sqlTotal} / ${ordersTotal}`}
            </span>
            {#if searchQuery || statusFilter !== 'all'}
                <button class="btn btn-secondary !min-h-10 !px-3 !py-1.5 !text-xs" on:click={() => { searchQuery = ''; statusFilter = 'all'; }}>Clear</button>
            {/if}
        </div>
    </div>

    <table class="tbl">
        <thead>
            <tr>
                <th>#</th>
                <th>Date</th>
                <th>Status</th>
                <th>Cashier</th>
                <th>Till</th>
                <th>Lines</th>
                <th>Items</th>
                <th>Total</th>
            </tr>
        </thead>
        <tbody>
            {#each pagedOrders as o}
                <tr on:click={() => openOrder(o)} class="cursor-pointer">
                    <td class="mono">{o.orderNumber || '-'}</td>
                    <td>{formatDate(o.completedAt || o.createdAt)}</td>
                    <td><span class={`tag capitalize ${statusClass(o)}`}>{statusLabel(o)}</span></td>
                    <td>{cashierName(o)}</td>
                    <td>{tillName(o)}</td>
                    <td>{lineCount(o.id)}</td>
                    <td>{itemQuantity(o.id).toLocaleString('en-GB', { maximumFractionDigits: 3 })}</td>
                    <td class="money {o.total < 0 ? '!text-danger' : ''}">{formatMoney(o.total)}</td>
                </tr>
            {/each}
            {#if ordersLoading && pagedOrders.length === 0}<tr class="empty-row"><td colspan="8">Loading orders...</td></tr>{/if}
            {#if !ordersLoading && !ordersLoadError && ordersTotal === 0}<tr class="empty-row"><td colspan="8">No orders yet.</td></tr>{/if}
            {#if !ordersLoading && !ordersLoadError && ordersTotal > 0 && sqlTotal === 0}<tr class="empty-row"><td colspan="8">No orders match your filters.</td></tr>{/if}
            {#if !ordersLoading && ordersLoadError && pagedOrders.length === 0}<tr class="empty-row"><td colspan="8">Could not load orders: {ordersLoadError}</td></tr>{/if}
        </tbody>
    </table>

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
            <div class="grid grid-cols-1 gap-3 md:grid-cols-4">
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
                                    <td>{line.productName}{line.isPriceOverride ? ' ⚡' : ''}</td>
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
                <div class="flex flex-wrap gap-2">
                    {#each getPayments(selectedOrder.id) as p}
                        <div class="flat-card px-4 py-3">
                            <span class="tag capitalize">{p.method.replace('_', ' ')}</span>
                            <span class="money ml-2 {p.amount < 0 ? '!text-danger' : ''}">{paymentSummary(p)}</span>
                            {#if p.changeGiven > 0}<span class="text-text-muted ml-2">Change: {formatMoney(p.changeGiven)}</span>{/if}
                            {#if p.reference}<span class="mono ml-2">{p.reference}</span>{/if}
                        </div>
                    {/each}
                </div>
                {#if getPayments(selectedOrder.id).length === 0}<p class="text-text-muted">No payments recorded.</p>{/if}
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
    </svelte:fragment>
</Modal>
