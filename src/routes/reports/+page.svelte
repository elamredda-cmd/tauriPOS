<script lang="ts">
    import { onMount } from 'svelte';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import { formatMoney } from '$lib/stores/db';
    import { toast } from '$lib/stores/toast';
    import {
        getSalesOverview,
        getPaymentBreakdown,
        getTopProducts,
        getAllTillNumbers,
        getLastReportMarker,
        saveReportMarker,
        getTillPeriodReport,
        getTillName,
        getOrCreateTillId,
        type SalesOverview,
        type PaymentBreakdown,
        type TopProduct,
    } from '$lib/stores/sqlite';

    // Date range defaults to current month
    const today = new Date();
    const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    let startDate = firstOfMonth.toISOString().split('T')[0];
    let endDate = today.toISOString().split('T')[0];

    let sortBy: 'quantity' | 'revenue' = 'quantity';
    let selectedTill = ''; // empty = all tills

    let overview: SalesOverview = { totalRevenue: 0, totalTransactions: 0, avgTransactionValue: 0, totalItemsSold: 0 };
    let breakdown: PaymentBreakdown = { totalCash: 0, totalCard: 0, cashTxCount: 0, cardTxCount: 0, splitTxCount: 0, totalAmount: 0, unrecordedAmount: 0, unrecordedTxCount: 0 };
    let topProducts: TopProduct[] = [];
    let allTills: string[] = [];
    let loading = true;
    let mounted = false;

    // Per-till report state
    let tillName = 'Till 1';
    let tillId = '';
    let showTillReport = false;
    let tillReportData: { overview: SalesOverview; breakdown: PaymentBreakdown; topProducts: TopProduct[] } | null = null;
    let tillReportPeriod = '';

    async function loadData() {
        loading = true;
        try {
            const till = selectedTill || undefined;
            [overview, breakdown, topProducts, allTills] = await Promise.all([
                getSalesOverview(startDate, endDate, till),
                getPaymentBreakdown(startDate, endDate, till),
                getTopProducts(startDate, endDate, sortBy, 10, till),
                getAllTillNumbers(),
            ]);
        } catch (e) {
            console.error('Failed to load report data:', e);
            toast('Failed to load report data', 'error');
        }
        loading = false;
    }

    async function runTillDayReport() {
        try {
            // Use tillId (the UUID stored on orders) for queries, tillName for display
            const lastMarker = await getLastReportMarker(tillId);
            const nowStr = new Date().toISOString();
            const periodStart = lastMarker || '2000-01-01T00:00:00.000Z';

            tillReportData = await getTillPeriodReport(tillId, periodStart, nowStr);
            tillReportPeriod = lastMarker
                ? `${new Date(lastMarker).toLocaleString('en-GB')} → ${new Date(nowStr).toLocaleString('en-GB')}`
                : `All time → ${new Date(nowStr).toLocaleString('en-GB')}`;

            // Save marker so next time picks up from here
            await saveReportMarker(tillId, periodStart, nowStr);

            showTillReport = true;
        } catch (e) {
            console.error(e);
            toast('Failed to generate till report', 'error');
        }
    }

    async function runTillFullReport() {
        try {
            const nowStr = new Date().toISOString();

            tillReportData = await getTillPeriodReport(tillId, '2000-01-01T00:00:00.000Z', nowStr);
            tillReportPeriod = `All time → ${new Date(nowStr).toLocaleString('en-GB')}`;

            showTillReport = true;
        } catch (e) {
            console.error(e);
            toast('Failed to generate full till report', 'error');
        }
    }

    onMount(async () => {
        tillName = await getTillName();
        tillId = await getOrCreateTillId();
        mounted = true;
    });

    // Reactive reload when any filter changes
    $: {
        selectedTill;
        sortBy;
        if (mounted && startDate && endDate) {
            loadData();
        }
    }

    $: cashPercent = breakdown.totalAmount > 0 ? Math.round((breakdown.totalCash / breakdown.totalAmount) * 100) : 0;
    $: cardPercent = breakdown.totalAmount > 0 ? Math.round((breakdown.totalCard / breakdown.totalAmount) * 100) : 0;
    $: unrecordedPercent = breakdown.totalAmount > 0 ? Math.round((breakdown.unrecordedAmount / breakdown.totalAmount) * 100) : 0;
    $: totalTx = breakdown.cashTxCount + breakdown.cardTxCount + breakdown.splitTxCount + breakdown.unrecordedTxCount;
</script>

<MgmtPage title="Sales Reports">
    <div class="p-6 flex flex-col gap-6">
        <!-- Filters -->
        <div class="flex flex-wrap gap-4 items-end">
            <div class="field">
                <label>Start Date</label>
                <input type="date" bind:value={startDate} />
            </div>
            <div class="field">
                <label>End Date</label>
                <input type="date" bind:value={endDate} />
            </div>
            <div class="field">
                <label>Till</label>
                <select bind:value={selectedTill}>
                    <option value="">All Tills</option>
                    {#each allTills as t}
                        <option value={t}>{t}</option>
                    {/each}
                </select>
            </div>
            <div class="field">
                <label>Sort Products By</label>
                <select bind:value={sortBy}>
                    <option value="quantity">Quantity Sold</option>
                    <option value="revenue">Revenue</option>
                </select>
            </div>
        </div>

        <!-- Section C: Overview Cards -->
        <div class="grid grid-cols-4 gap-4">
            <div class="bg-bg-card border border-border-flat rounded-lg p-5 px-6 flex flex-col gap-1">
                <div class="text-xs font-semibold text-text-muted uppercase tracking-wider">Total Revenue</div>
                <div class="text-[1.8rem] font-extrabold font-serif leading-tight text-success">{formatMoney(overview.totalRevenue)}</div>
            </div>
            <div class="bg-bg-card border border-border-flat rounded-lg p-5 px-6 flex flex-col gap-1">
                <div class="text-xs font-semibold text-text-muted uppercase tracking-wider">Total Transactions</div>
                <div class="text-[1.8rem] font-extrabold font-serif leading-tight text-accent-primary">{overview.totalTransactions}</div>
            </div>
            <div class="bg-bg-card border border-border-flat rounded-lg p-5 px-6 flex flex-col gap-1">
                <div class="text-xs font-semibold text-text-muted uppercase tracking-wider">Avg Transaction</div>
                <div class="text-[1.8rem] font-extrabold font-serif leading-tight text-warning">{formatMoney(overview.avgTransactionValue)}</div>
            </div>
            <div class="bg-bg-card border border-border-flat rounded-lg p-5 px-6 flex flex-col gap-1">
                <div class="text-xs font-semibold text-text-muted uppercase tracking-wider">Items Sold</div>
                <div class="text-[1.8rem] font-extrabold font-serif leading-tight text-text-main">{overview.totalItemsSold}</div>
            </div>
        </div>

        <!-- Section A: Payment Method Breakdown -->
        <section class="bg-bg-card border border-border-flat rounded-lg p-6">
            <h3 class="text-[1.15rem] mb-4 text-accent-primary">💳 Payment Breakdown</h3>
            <div class="flex gap-8 items-start">
                <!-- Bar Chart -->
                <div class="flex-1 flex flex-col gap-3">
                    <div class="flex items-center gap-3">
                        <span class="w-20 text-[0.9rem] font-semibold text-text-muted">💵 Cash</span>
                        <div class="flex-1 h-7 bg-bg-panel rounded-md overflow-hidden border border-border-flat">
                            <div class="h-full rounded-md transition-[width] duration-500 min-w-[2px] bg-[linear-gradient(90deg,#10b981,#34d399)]" style="width: {cashPercent}%"></div>
                        </div>
                        <span class="w-12 text-right text-[0.9rem] font-bold text-text-main">{cashPercent}%</span>
                    </div>
                    <div class="flex items-center gap-3">
                        <span class="w-20 text-[0.9rem] font-semibold text-text-muted">💳 Card</span>
                        <div class="flex-1 h-7 bg-bg-panel rounded-md overflow-hidden border border-border-flat">
                            <div class="h-full rounded-md transition-[width] duration-500 min-w-[2px] bg-[linear-gradient(90deg,#3b82f6,#60a5fa)]" style="width: {cardPercent}%"></div>
                        </div>
                        <span class="w-12 text-right text-[0.9rem] font-bold text-text-main">{cardPercent}%</span>
                    </div>
                    {#if breakdown.unrecordedAmount > 0}
                        <div class="flex items-center gap-3">
                            <span class="w-20 text-[0.9rem] font-semibold text-text-muted">❓ Unrec.</span>
                            <div class="flex-1 h-7 bg-bg-panel rounded-md overflow-hidden border border-border-flat">
                                <div class="h-full rounded-md transition-[width] duration-500 min-w-[2px] bg-[linear-gradient(90deg,#9ca3af,#d1d5db)]" style="width: {unrecordedPercent}%"></div>
                            </div>
                            <span class="w-12 text-right text-[0.9rem] font-bold text-text-main">{unrecordedPercent}%</span>
                        </div>
                    {/if}
                </div>
                <!-- Stats -->
                <div class="grid grid-cols-2 gap-4 w-[340px]">
                    <div class="bg-bg-panel border border-border-flat rounded-lg p-4 flex flex-col gap-0.5">
                        <div class="text-xs font-semibold text-text-muted">Cash Sales</div>
                        <div class="text-[1.3rem] font-extrabold font-serif text-success">{formatMoney(breakdown.totalCash)}</div>
                        <div class="text-[0.75rem] text-text-muted">{breakdown.cashTxCount} transactions</div>
                    </div>
                    <div class="bg-bg-panel border border-border-flat rounded-lg p-4 flex flex-col gap-0.5">
                        <div class="text-xs font-semibold text-text-muted">Card Sales</div>
                        <div class="text-[1.3rem] font-extrabold font-serif text-accent-primary">{formatMoney(breakdown.totalCard)}</div>
                        <div class="text-[0.75rem] text-text-muted">{breakdown.cardTxCount} transactions</div>
                    </div>
                    {#if breakdown.splitTxCount > 0}
                        <div class="bg-bg-panel border border-border-flat rounded-lg p-4 flex flex-col gap-0.5">
                            <div class="text-xs font-semibold text-text-muted">Split Payments</div>
                            <div class="text-[0.75rem] text-text-muted">{breakdown.splitTxCount} transactions (cash+card combined)</div>
                        </div>
                    {/if}
                    {#if breakdown.unrecordedAmount > 0}
                        <div class="bg-bg-panel border border-border-flat rounded-lg p-4 flex flex-col gap-0.5 {breakdown.splitTxCount > 0 ? '' : 'col-span-2'}">
                            <div class="text-xs font-semibold text-text-muted">Unrecorded</div>
                            <div class="text-[1.3rem] font-extrabold font-serif text-text-muted">{formatMoney(breakdown.unrecordedAmount)}</div>
                            <div class="text-[0.75rem] text-text-muted">{breakdown.unrecordedTxCount} transactions (missing payment records)</div>
                        </div>
                    {/if}
                </div>
            </div>
        </section>

        <!-- Section B: Top Products -->
        <section class="bg-bg-card border border-border-flat rounded-lg p-6">
            <h3 class="text-[1.15rem] mb-4 text-accent-primary">🏆 Top 10 Products</h3>
            {#if topProducts.length === 0}
                <div class="p-12 text-center text-text-muted text-base">No sales data for the selected period.</div>
            {:else}
                <div class="overflow-x-auto">
                    <table class="w-full border-collapse text-left">
                        <thead>
                            <tr>
                                <th class="px-3 py-3.5 text-text-muted font-medium text-[0.85rem] border-b border-border-flat bg-bg-card sticky top-0 z-[5]">#</th>
                                <th class="px-3 py-3.5 text-text-muted font-medium text-[0.85rem] border-b border-border-flat bg-bg-card sticky top-0 z-[5]">Product Name</th>
                                <th class="px-3 py-3.5 text-text-muted font-medium text-[0.85rem] border-b border-border-flat bg-bg-card sticky top-0 z-[5]">SKU</th>
                                <th class="px-3 py-3.5 text-text-muted font-medium text-[0.85rem] border-b border-border-flat bg-bg-card sticky top-0 z-[5]">Qty Sold</th>
                                <th class="px-3 py-3.5 text-text-muted font-medium text-[0.85rem] border-b border-border-flat bg-bg-card sticky top-0 z-[5]">Total Revenue</th>
                                <th class="px-3 py-3.5 text-text-muted font-medium text-[0.85rem] border-b border-border-flat bg-bg-card sticky top-0 z-[5]">Avg Price</th>
                            </tr>
                        </thead>
                        <tbody>
                            {#each topProducts as product, i}
                                <tr class="hover:bg-bg-card-hover">
                                    <td class="px-3 py-3 border-b border-border-flat text-[0.9rem] font-bold text-accent-primary">{i + 1}</td>
                                    <td class="px-3 py-3 border-b border-border-flat text-[0.9rem] font-semibold">{product.name}</td>
                                    <td class="px-3 py-3 border-b border-border-flat text-[0.9rem] font-mono text-[0.85rem] text-text-muted">{product.sku || '—'}</td>
                                    <td class="px-3 py-3 border-b border-border-flat text-[0.9rem] font-bold">{product.qtySold}</td>
                                    <td class="px-3 py-3 border-b border-border-flat text-[0.9rem] font-bold text-success">{formatMoney(product.totalRevenue)}</td>
                                    <td class="px-3 py-3 border-b border-border-flat text-[0.9rem]">{formatMoney(product.avgPrice)}</td>
                                </tr>
                            {/each}
                        </tbody>
                    </table>
                </div>
            {/if}
        </section>

        <!-- Per-Till Reports -->
        <section class="bg-bg-card border border-border-flat rounded-lg p-6">
            <h3 class="text-[1.15rem] mb-4 text-accent-primary">🖥️ This Till: {tillName}</h3>
            <div class="flex gap-4">
                <button class="btn btn-primary" on:click={runTillDayReport}>
                    📋 Report of the Day
                </button>
                <button class="btn btn-secondary" on:click={runTillFullReport}>
                    📊 Full Till Report
                </button>
            </div>
            <p class="text-text-muted text-sm mt-2">
                "Report of the Day" shows data from the last time this button was pressed until now.
                First use shows all-time data.
            </p>
        </section>
    </div>
</MgmtPage>

<!-- Till Report Modal -->
{#if showTillReport && tillReportData}
    <div class="fixed inset-0 flex items-center justify-center z-[100] bg-[var(--overlay)]" on:click={() => showTillReport = false}>
        <div class="w-[700px] max-h-[85vh] overflow-y-auto p-6 rounded-md bg-bg-card border border-border-flat flex flex-col gap-5" on:click|stopPropagation>
            <div class="flex justify-between items-center">
                <h3>Till Report: {tillName}</h3>
                <button class="bg-transparent text-text-muted text-[1.2rem]" on:click={() => showTillReport = false}>✕</button>
            </div>
            <div class="text-sm text-text-muted">{tillReportPeriod}</div>

            <!-- Mini overview cards -->
            <div class="grid grid-cols-4 gap-3">
                <div class="bg-bg-card border border-border-flat rounded-lg p-3 px-4 flex flex-col gap-1">
                    <div class="text-xs font-semibold text-text-muted uppercase tracking-wider">Revenue</div>
                    <div class="text-lg font-extrabold font-serif leading-tight text-success">{formatMoney(tillReportData.overview.totalRevenue)}</div>
                </div>
                <div class="bg-bg-card border border-border-flat rounded-lg p-3 px-4 flex flex-col gap-1">
                    <div class="text-xs font-semibold text-text-muted uppercase tracking-wider">Transactions</div>
                    <div class="text-lg font-extrabold font-serif leading-tight text-accent-primary">{tillReportData.overview.totalTransactions}</div>
                </div>
                <div class="bg-bg-card border border-border-flat rounded-lg p-3 px-4 flex flex-col gap-1">
                    <div class="text-xs font-semibold text-text-muted uppercase tracking-wider">Avg Value</div>
                    <div class="text-lg font-extrabold font-serif leading-tight text-warning">{formatMoney(tillReportData.overview.avgTransactionValue)}</div>
                </div>
                <div class="bg-bg-card border border-border-flat rounded-lg p-3 px-4 flex flex-col gap-1">
                    <div class="text-xs font-semibold text-text-muted uppercase tracking-wider">Items</div>
                    <div class="text-lg font-extrabold font-serif leading-tight text-text-main">{tillReportData.overview.totalItemsSold}</div>
                </div>
            </div>

            <!-- Payment breakdown -->
            <div class="grid grid-cols-2 gap-3">
                <div class="bg-bg-panel border border-border-flat rounded-lg p-4 flex flex-col gap-0.5">
                    <div class="text-xs font-semibold text-text-muted">💵 Cash</div>
                    <div class="text-[1.3rem] font-extrabold font-serif text-success">{formatMoney(tillReportData.breakdown.totalCash)}</div>
                    <div class="text-[0.75rem] text-text-muted">{tillReportData.breakdown.cashTxCount} tx</div>
                </div>
                <div class="bg-bg-panel border border-border-flat rounded-lg p-4 flex flex-col gap-0.5">
                    <div class="text-xs font-semibold text-text-muted">💳 Card</div>
                    <div class="text-[1.3rem] font-extrabold font-serif text-accent-primary">{formatMoney(tillReportData.breakdown.totalCard)}</div>
                    <div class="text-[0.75rem] text-text-muted">{tillReportData.breakdown.cardTxCount} tx</div>
                </div>
                {#if tillReportData.breakdown.unrecordedAmount > 0}
                    <div class="bg-bg-panel border border-border-flat rounded-lg p-4 flex flex-col gap-0.5 col-span-2">
                        <div class="text-xs font-semibold text-text-muted">❓ Unrecorded</div>
                        <div class="text-[1.3rem] font-extrabold font-serif text-text-muted">{formatMoney(tillReportData.breakdown.unrecordedAmount)}</div>
                        <div class="text-[0.75rem] text-text-muted">{tillReportData.breakdown.unrecordedTxCount} tx (missing payment records)</div>
                    </div>
                {/if}
            </div>

            <!-- Top products mini table -->
            {#if tillReportData.topProducts.length > 0}
                <h4 class="text-text-muted font-semibold mt-2 mb-0">Top Products</h4>
                <table class="w-full border-collapse text-left">
                    <thead>
                        <tr>
                            <th class="px-3 py-3.5 text-text-muted font-medium text-[0.85rem] border-b border-border-flat bg-bg-card sticky top-0 z-[5]">#</th>
                            <th class="px-3 py-3.5 text-text-muted font-medium text-[0.85rem] border-b border-border-flat bg-bg-card sticky top-0 z-[5]">Product</th>
                            <th class="px-3 py-3.5 text-text-muted font-medium text-[0.85rem] border-b border-border-flat bg-bg-card sticky top-0 z-[5]">Qty</th>
                            <th class="px-3 py-3.5 text-text-muted font-medium text-[0.85rem] border-b border-border-flat bg-bg-card sticky top-0 z-[5]">Revenue</th>
                        </tr>
                    </thead>
                    <tbody>
                        {#each tillReportData.topProducts as p, i}
                            <tr class="hover:bg-bg-card-hover">
                                <td class="px-3 py-3 border-b border-border-flat text-[0.9rem] font-bold text-accent-primary">{i + 1}</td>
                                <td class="px-3 py-3 border-b border-border-flat text-[0.9rem]">{p.name}</td>
                                <td class="px-3 py-3 border-b border-border-flat text-[0.9rem] font-bold">{p.qtySold}</td>
                                <td class="px-3 py-3 border-b border-border-flat text-[0.9rem] font-bold text-success">{formatMoney(p.totalRevenue)}</td>
                            </tr>
                        {/each}
                    </tbody>
                </table>
            {:else}
                <div class="p-12 text-center text-text-muted text-base">No sales in this period.</div>
            {/if}

            <div class="flex justify-end gap-3 mt-2.5">
                <button class="btn btn-primary" on:click={() => showTillReport = false}>Close</button>
            </div>
        </div>
    </div>
{/if}

{#if loading}
    <div class="fixed inset-0 bg-black/30 flex items-center justify-center z-50 pointer-events-none">
        <div class="bg-bg-card p-4 rounded-md text-text-main font-semibold shadow-lg">Loading reports…</div>
    </div>
{/if}


