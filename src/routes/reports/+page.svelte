<script lang="ts">
    import { onMount } from 'svelte';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import CustomSelect from '$lib/components/CustomSelect.svelte';
    import { formatMoney, settingsDB } from '$lib/stores/db';
    import { toast } from '$lib/stores/toast';
    import { currentEmployee } from '$lib/stores/session';
    import { hasPermission } from '$lib/permissions';
    import { getReceiptPrinterConfig, printEscposTextReport } from '$lib/printers';
    import {
        getReportSnapshot,
        getLastReportMarker,
        getLiveLastReportMarker,
        saveReportMarker,
        saveLiveReportMarker,
        getTillPeriodReport,
        getLiveTillPeriodReport,
        getTillName,
        getOrCreateTillId,
        type SalesOverview,
        type PaymentBreakdown,
        type TopProduct,
        type TillReportOption,
        type TillSalesSummary,
        type DailySalesPoint,
        type BusinessSummary,
        type EmployeeSalesSummary,
    } from '$lib/stores/database';

    function localDateValue(date: Date) {
        const offset = date.getTimezoneOffset() * 60_000;
        return new Date(date.getTime() - offset).toISOString().split('T')[0];
    }

    // Date range defaults to current month
    const today = new Date();
    const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    let startDate = localDateValue(firstOfMonth);
    let endDate = localDateValue(today);

    let sortBy: 'quantity' | 'revenue' = 'quantity';
    let selectedTill = ''; // empty = all tills
    $: tillOptions = [
        { label: 'All Tills', value: '' },
        ...allTills.map((till) => ({ label: till.name, value: till.id })),
    ];
    const sortOptions = [
        { label: 'Quantity Sold', value: 'quantity' },
        { label: 'Revenue', value: 'revenue' },
    ];

    let overview: SalesOverview = { totalRevenue: 0, totalTransactions: 0, refundTransactions: 0, avgTransactionValue: 0, totalItemsSold: 0 };
    let breakdown: PaymentBreakdown = { totalCash: 0, totalCard: 0, totalLoyalty: 0, cashTxCount: 0, cardTxCount: 0, splitTxCount: 0, loyaltyTxCount: 0, totalAmount: 0, unrecordedAmount: 0, unrecordedTxCount: 0 };
    let topProducts: TopProduct[] = [];
    let allTills: TillReportOption[] = [];
    let tillSummaries: TillSalesSummary[] = [];
    let dailyTrend: DailySalesPoint[] = [];
    let business: BusinessSummary = { grossSales: 0, refunds: 0, voids: 0, voidTransactions: 0, netSales: 0, taxTotal: 0, discountTotal: 0, costTotal: 0, grossProfit: 0 };
    let employeeSales: EmployeeSalesSummary[] = [];
    let loading = true;
    let mounted = false;
    let reportError = '';
    let lastRefreshed = '';
    let loadSequence = 0;
    let reportSource = 'Local SQLite';
    let loadedReportKey = '';

    function clearReportResults() {
        overview = { totalRevenue: 0, totalTransactions: 0, refundTransactions: 0, avgTransactionValue: 0, totalItemsSold: 0 };
        breakdown = { totalCash: 0, totalCard: 0, totalLoyalty: 0, cashTxCount: 0, cardTxCount: 0, splitTxCount: 0, loyaltyTxCount: 0, totalAmount: 0, unrecordedAmount: 0, unrecordedTxCount: 0 };
        topProducts = [];
        tillSummaries = [];
        dailyTrend = [];
        business = { grossSales: 0, refunds: 0, voids: 0, voidTransactions: 0, netSales: 0, taxTotal: 0, discountTotal: 0, costTotal: 0, grossProfit: 0 };
        employeeSales = [];
    }

    // Per-till report state
    let tillName = 'Till 1';
    let tillId = '';
    let showTillReport = false;
    let tillReportData: { overview: SalesOverview; breakdown: PaymentBreakdown; topProducts: TopProduct[] } | null = null;
    let tillReportPeriod = '';
    let tillReportTitle = '';
    let closeReportTillNumber = '';
    let closeReportStart = '';
    let closeReportEnd = '';
    let closeReportText = '';
    let closeReportCanEnd = false;
    let closeReportConfirming = false;
    let closeReportSaving = false;
    let reportPrintBusy = false;
    let closeReportPrintBusy = false;

    async function loadData() {
        const sequence = ++loadSequence;
        if (startDate > endDate) {
            reportError = 'Start date must be before the end date.';
            loadedReportKey = '';
            clearReportResults();
            loading = false;
            return;
        }
        loading = true;
        reportError = '';
        const till = selectedTill || undefined;
        try {
            const snapshot = await getReportSnapshot(startDate, endDate, sortBy, 10, till);
            if (sequence !== loadSequence) return;
            overview = snapshot.overview;
            breakdown = snapshot.breakdown;
            topProducts = snapshot.topProducts;
            allTills = snapshot.tillOptions;
            tillSummaries = snapshot.tillSummaries;
            dailyTrend = snapshot.dailyTrend;
            business = snapshot.business;
            employeeSales = snapshot.employeeSales;
            reportSource = snapshot.source === 'mariadb' ? 'Live MariaDB' : 'Local SQLite';
            reportError = snapshot.warning || '';
            loadedReportKey = `${startDate}|${endDate}|${selectedTill}|${sortBy}`;
        } catch (error) {
            if (sequence !== loadSequence) return;
            console.error('Failed to load report:', error);
            reportError = `The report could not load: ${String(error)}`;
            loadedReportKey = '';
            clearReportResults();
        }
        lastRefreshed = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        loading = false;
    }

    function setDatePreset(preset: 'today' | 'week' | 'month' | 'year') {
        const end = new Date();
        const start = new Date(end);
        if (preset === 'week') start.setDate(end.getDate() - 6);
        if (preset === 'month') start.setDate(1);
        if (preset === 'year') {
            start.setMonth(0);
            start.setDate(1);
        }
        startDate = localDateValue(start);
        endDate = localDateValue(end);
    }

    function csvCell(value: string | number) {
        return `"${String(value).replaceAll('"', '""')}"`;
    }

    function exportCsv() {
        if (!reportReady) {
            toast('Wait for the current report to finish loading', 'info');
            return;
        }
        const selectedTillName = allTills.find(till => till.id === selectedTill)?.name || 'All Tills';
        const pounds = (pence: number) => (pence / 100).toFixed(2);
        const rows: Array<Array<string | number>> = [
            ['L&Bj POS Sales Report'],
            ['Period', startDate, endDate],
            ['Till', selectedTillName],
            [],
            ['Summary', 'Amount (GBP)'],
            ['Gross Sales', pounds(business.grossSales)],
            ['Customer Refunds', pounds(business.refunds)],
            ['Voids', pounds(business.voids)],
            ['Net Sales', pounds(business.netSales)],
            ['Discounts Issued', pounds(business.discountTotal)],
            ['Tax', pounds(business.taxTotal)],
            ['Cost', pounds(business.costTotal)],
            ['Gross Profit', pounds(business.grossProfit)],
            ['Sales Transactions', overview.totalTransactions],
            ['Refund Transactions', overview.refundTransactions],
            ['Void Transactions', business.voidTransactions],
            [],
            ['Payment Method', 'Amount (GBP)', 'Transactions'],
            ['Cash', pounds(breakdown.totalCash), breakdown.cashTxCount],
            ['Card', pounds(breakdown.totalCard), breakdown.cardTxCount],
            ['Loyalty Credit', pounds(breakdown.totalLoyalty), breakdown.loyaltyTxCount],
            ['Unrecorded', pounds(breakdown.unrecordedAmount), breakdown.unrecordedTxCount],
            [],
            ['Till', 'Net Sales', 'Gross Sales', 'Refunds', 'Sales', 'Refund Transactions', 'Items', 'Cash', 'Card', 'Loyalty Credit'],
            ...visibleTillSummaries.map(till => [till.name, pounds(till.netSales), pounds(till.grossSales), pounds(till.refunds), till.transactions, till.refundTransactions, till.itemsSold, pounds(till.cashTotal), pounds(till.cardTotal), pounds(till.loyaltyTotal)]),
            [],
            ['Employee', 'Net Sales', 'Gross Sales', 'Refunds', 'Sales', 'Refund Transactions', 'Average Transaction'],
            ...employeeSales.map(employee => [employee.employeeName, pounds(employee.netSales), pounds(employee.grossSales), pounds(employee.refunds), employee.transactions, employee.refundTransactions, pounds(employee.avgTransaction)]),
            [],
            ['Product', 'SKU', 'Quantity', 'Revenue', 'Average Price'],
            ...topProducts.map(product => [product.name, product.sku, product.qtySold, pounds(product.totalRevenue), pounds(product.avgPrice)]),
        ];
        const csv = rows.map(row => row.map(csvCell).join(',')).join('\r\n');
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `sales-report-${startDate}-to-${endDate}.csv`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
        toast('Report exported', 'success');
    }

    function buildSalesReportText() {
        const selectedTillName = allTills.find(till => till.id === selectedTill)?.name || 'All Tills';
        const lines = [
            'L&Bj POS',
            'Sales Report',
            `Period: ${startDate} to ${endDate}`,
            `Till: ${selectedTillName}`,
            ''.padEnd(32, '-'),
            `Net sales: ${formatMoney(business.netSales)}`,
            `Gross sales: ${formatMoney(business.grossSales)}`,
            `Refunds: ${formatMoney(business.refunds)}`,
            `Voids: ${formatMoney(business.voids)}`,
            `Discounts: ${formatMoney(business.discountTotal)}`,
            `Gross profit: ${formatMoney(business.grossProfit)}`,
            ''.padEnd(32, '-'),
            `Transactions: ${overview.totalTransactions}`,
            `Refund tx: ${overview.refundTransactions}`,
            `Void tx: ${business.voidTransactions}`,
            `Items sold: ${overview.totalItemsSold}`,
            ''.padEnd(32, '-'),
            `Cash: ${formatMoney(breakdown.totalCash)}`,
            `Card: ${formatMoney(breakdown.totalCard)}`,
            `Loyalty: ${formatMoney(breakdown.totalLoyalty)}`,
        ];
        if (topProducts.length > 0) {
            lines.push(''.padEnd(32, '-'), 'Top products');
            for (const product of topProducts.slice(0, 8)) {
                lines.push(`${product.qtySold} x ${product.name}`, `  ${formatMoney(product.totalRevenue)}`);
            }
        }
        lines.push(''.padEnd(32, '-'), `Printed: ${new Date().toLocaleString('en-GB')}`);
        return lines.join('\n');
    }

    async function printThermalReport(text: string, documentName: string, busyTarget: 'main' | 'close') {
        if ((busyTarget === 'main' && reportPrintBusy) || (busyTarget === 'close' && closeReportPrintBusy)) return;
        const config = getReceiptPrinterConfig($settingsDB);
        if (config.connection === 'system') {
            toast('Set Receipt Printer to USB raw, Network, Serial, or Bluetooth first', 'error');
            return;
        }
        if (busyTarget === 'main') reportPrintBusy = true;
        else closeReportPrintBusy = true;
        try {
            await printEscposTextReport(text, documentName, config);
            toast('Report sent to thermal printer', 'success');
        } catch (error) {
            toast(`Report did not print: ${error}`, 'error');
        } finally {
            if (busyTarget === 'main') reportPrintBusy = false;
            else closeReportPrintBusy = false;
        }
    }

    async function printReport() {
        if (!reportReady) {
            toast('Wait for the current report to finish loading', 'info');
            return;
        }
        await printThermalReport(buildSalesReportText(), 'L&Bj POS sales report', 'main');
    }

    async function printCloseReport() {
        if (!closeReportText) {
            toast('Open a report first', 'info');
            return;
        }
        await printThermalReport(closeReportText, 'L&Bj POS end-of-day report', 'close');
    }

    function filledDailyTrend(start: string, end: string, points: DailySalesPoint[]) {
        const byDate = new Map(points.map(point => [point.date, point]));
        const result: DailySalesPoint[] = [];
        const cursor = new Date(`${start}T00:00:00`);
        const last = new Date(`${end}T00:00:00`);
        if ((last.getTime() - cursor.getTime()) / 86_400_000 > 370) return points;
        while (cursor <= last) {
            const date = localDateValue(cursor);
            result.push(byDate.get(date) || { date, netSales: 0, transactions: 0 });
            cursor.setDate(cursor.getDate() + 1);
        }
        return result;
    }

    function buildCloseReportText(
        title: string,
        period: string,
        data: { overview: SalesOverview; breakdown: PaymentBreakdown; topProducts: TopProduct[] },
    ) {
        const lines = [
            'L&Bj POS',
            title,
            period,
            ''.padEnd(32, '-'),
            `Net sales: ${formatMoney(data.overview.totalRevenue)}`,
            `Transactions: ${data.overview.totalTransactions}`,
            `Refunds: ${data.overview.refundTransactions}`,
            `Items sold: ${data.overview.totalItemsSold}`,
            `Avg sale: ${formatMoney(data.overview.avgTransactionValue)}`,
            ''.padEnd(32, '-'),
            `Cash: ${formatMoney(data.breakdown.totalCash)}`,
            `Card: ${formatMoney(data.breakdown.totalCard)}`,
            `Loyalty: ${formatMoney(data.breakdown.totalLoyalty)}`,
        ];
        lines.push(''.padEnd(32, '-'), `Printed: ${new Date().toLocaleString('en-GB')}`);
        return lines.join('\n');
    }

    async function previewPeriodReport(scope: 'till' | 'system', closePeriod: boolean) {
        try {
            const markerTill = scope === 'system' ? '' : tillId;
            const title = scope === 'system' ? 'Whole System Period Close Report' : `${tillName} Period Close Report`;
            const strictWholeSystemClose = scope === 'system' && closePeriod;
            const lastMarker = strictWholeSystemClose
                ? await getLiveLastReportMarker(markerTill)
                : await getLastReportMarker(markerTill);
            const nowStr = new Date().toISOString();
            const periodStart = lastMarker || '2000-01-01T00:00:00.000Z';

            const data = strictWholeSystemClose
                ? await getLiveTillPeriodReport(markerTill, periodStart, nowStr)
                : await getTillPeriodReport(markerTill, periodStart, nowStr);
            const period = lastMarker
                ? `${new Date(lastMarker).toLocaleString('en-GB')} → ${new Date(nowStr).toLocaleString('en-GB')}`
                : `All time → ${new Date(nowStr).toLocaleString('en-GB')}`;
            tillReportData = data;
            tillReportTitle = title;
            tillReportPeriod = period;
            closeReportTillNumber = markerTill;
            closeReportStart = periodStart;
            closeReportEnd = nowStr;
            closeReportText = buildCloseReportText(title, period, data);
            closeReportCanEnd = closePeriod;
            closeReportConfirming = false;
            showTillReport = true;
        } catch (e) {
            console.error(e);
            toast(`Failed to generate report: ${e}`, 'error');
        }
    }

    async function runTillDayReport() {
        await previewPeriodReport('till', true);
    }

    async function runSystemDayReport() {
        await previewPeriodReport('system', true);
    }

    async function runTillFullReport() {
        await previewPeriodReport('till', false);
    }

    function requestEndReportPeriod() {
        if (!tillReportData || !closeReportCanEnd || closeReportSaving) return;
        if (!hasPermission($currentEmployee, 'end_day_close', $settingsDB)) {
            toast('Manager permission required to end the reporting period', 'error');
            return;
        }
        closeReportConfirming = true;
    }

    async function confirmEndReportPeriod() {
        if (!tillReportData || !closeReportCanEnd || closeReportSaving) return;
        if (!hasPermission($currentEmployee, 'end_day_close', $settingsDB)) {
            toast('Manager permission required to end the reporting period', 'error');
            return;
        }
        closeReportSaving = true;
        try {
            const saveMarker = closeReportTillNumber ? saveReportMarker : saveLiveReportMarker;
            await saveMarker(closeReportTillNumber, closeReportStart, closeReportEnd, {
                employeeId: $currentEmployee?.id || '',
                reportText: closeReportText,
                reportTotal: tillReportData.overview.totalRevenue,
            });
            closeReportCanEnd = false;
            closeReportConfirming = false;
            toast('Report period ended', 'success');
        } catch (error) {
            toast(`Could not end report period: ${error}`, 'error');
        } finally {
            closeReportSaving = false;
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

    $: paymentMagnitude = Math.abs(breakdown.totalCash)
        + Math.abs(breakdown.totalCard)
        + Math.abs(breakdown.totalLoyalty)
        + Math.abs(breakdown.unrecordedAmount);
    $: cashPercent = paymentMagnitude > 0 ? Math.round((Math.abs(breakdown.totalCash) / paymentMagnitude) * 100) : 0;
    $: cardPercent = paymentMagnitude > 0 ? Math.round((Math.abs(breakdown.totalCard) / paymentMagnitude) * 100) : 0;
    $: loyaltyPercent = paymentMagnitude > 0 ? Math.round((Math.abs(breakdown.totalLoyalty) / paymentMagnitude) * 100) : 0;
    $: unrecordedPercent = paymentMagnitude > 0 ? Math.round((Math.abs(breakdown.unrecordedAmount) / paymentMagnitude) * 100) : 0;
    $: visibleTillSummaries = selectedTill ? tillSummaries.filter((till) => till.id === selectedTill) : tillSummaries;
    $: displayDailyTrend = filledDailyTrend(startDate, endDate, dailyTrend);
    $: maxDailySales = Math.max(1, ...displayDailyTrend.map((day) => Math.abs(day.netSales)));
    $: currentReportKey = `${startDate}|${endDate}|${selectedTill}|${sortBy}`;
    $: reportReady = !loading && loadedReportKey === currentReportKey;
    $: reconciliationDifference = business.grossSales - business.discountTotal - business.refunds - business.netSales;
    $: closeReportStartDay = closeReportStart ? localDateValue(new Date(closeReportStart)) : '';
    $: closeReportIncludesPreviousDays = Boolean(closeReportStartDay && closeReportStartDay < localDateValue(new Date()));
</script>

<MgmtPage title="Sales Reports">
    <div class="report-page p-3 md:p-6 flex flex-col gap-6">
        <!-- Filters -->
        <div class="report-controls bg-bg-card border border-border-flat rounded-lg p-4 flex flex-wrap gap-4 items-end">
            <div class="flex gap-2 self-end">
                <button class="btn btn-secondary" on:click={() => setDatePreset('today')}>Today</button>
                <button class="btn btn-secondary" on:click={() => setDatePreset('week')}>7 Days</button>
                <button class="btn btn-secondary" on:click={() => setDatePreset('month')}>This Month</button>
                <button class="btn btn-secondary" on:click={() => setDatePreset('year')}>This Year</button>
            </div>
            <div class="field">
                <label>Start Date</label>
                <input type="date" bind:value={startDate} />
            </div>
            <div class="field">
                <label>End Date</label>
                <input type="date" bind:value={endDate} />
            </div>
            <div class="field min-w-[190px]">
                <CustomSelect label="Till" bind:value={selectedTill} options={tillOptions} />
            </div>
            <div class="field min-w-[190px]">
                <CustomSelect label="Sort Products By" bind:value={sortBy} options={sortOptions} />
            </div>
            <button class="btn btn-primary" disabled={loading} on:click={loadData}>
                {loading ? 'Loading…' : 'Refresh'}
            </button>
            <button class="btn btn-secondary" disabled={!reportReady} on:click={exportCsv}>Export CSV</button>
            <button class="btn btn-secondary" disabled={!reportReady || reportPrintBusy} on:click={printReport}>
                {reportPrintBusy ? 'Printing...' : 'Print'}
            </button>
            <div class="ml-auto flex flex-col items-end text-xs">
                <span class="font-bold {reportSource === 'Live MariaDB' ? 'text-success' : 'text-warning'}">{reportSource}</span>
                {#if lastRefreshed}<span class="text-text-muted">Updated {lastRefreshed}</span>{/if}
            </div>
        </div>

        {#if reportError}
            <div class="bg-danger/10 border border-danger/40 text-danger rounded-lg p-4">
                <strong>Report warning:</strong> {reportError}
            </div>
        {/if}
        {#if reportReady && Math.abs(reconciliationDifference) > 1}
            <div class="bg-danger/10 border border-danger/40 text-danger rounded-lg p-4">
                <strong>Totals do not reconcile:</strong>
                Gross sales minus discounts issued and customer refunds differs from net sales by {formatMoney(reconciliationDifference)}.
            </div>
        {/if}

        <!-- Overview Cards -->
        <div class="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
            <div class="bg-bg-card border border-border-flat rounded-lg p-5 px-6 flex flex-col gap-1">
                <div class="text-xs font-semibold text-text-muted uppercase tracking-wider">Net Sales</div>
                <div class="text-[1.8rem] font-extrabold font-serif leading-tight text-success">{formatMoney(business.netSales)}</div>
            </div>
            <div class="bg-bg-card border border-border-flat rounded-lg p-5 px-6 flex flex-col gap-1">
                <div class="text-xs font-semibold text-text-muted uppercase tracking-wider">Gross Sales</div>
                <div class="text-[1.8rem] font-extrabold font-serif leading-tight text-text-main">{formatMoney(business.grossSales)}</div>
            </div>
            <div class="bg-bg-card border border-border-flat rounded-lg p-5 px-6 flex flex-col gap-1">
                <div class="text-xs font-semibold text-text-muted uppercase tracking-wider">Customer Refunds</div>
                <div class="text-[1.8rem] font-extrabold font-serif leading-tight text-danger">{formatMoney(business.refunds)}</div>
            </div>
            <div class="bg-bg-card border border-border-flat rounded-lg p-5 px-6 flex flex-col gap-1">
                <div class="text-xs font-semibold text-text-muted uppercase tracking-wider">Voids</div>
                <div class="text-[1.8rem] font-extrabold font-serif leading-tight text-warning">{formatMoney(business.voids)}</div>
            </div>
            <div class="bg-bg-card border border-border-flat rounded-lg p-5 px-6 flex flex-col gap-1">
                <div class="text-xs font-semibold text-text-muted uppercase tracking-wider">Sales Transactions</div>
                <div class="text-[1.8rem] font-extrabold font-serif leading-tight text-accent-primary">{overview.totalTransactions}</div>
            </div>
            <div class="bg-bg-card border border-border-flat rounded-lg p-5 px-6 flex flex-col gap-1">
                <div class="text-xs font-semibold text-text-muted uppercase tracking-wider">Refund Transactions</div>
                <div class="text-[1.8rem] font-extrabold font-serif leading-tight text-danger">{overview.refundTransactions}</div>
            </div>
            <div class="bg-bg-card border border-border-flat rounded-lg p-5 px-6 flex flex-col gap-1">
                <div class="text-xs font-semibold text-text-muted uppercase tracking-wider">Void Transactions</div>
                <div class="text-[1.8rem] font-extrabold font-serif leading-tight text-warning">{business.voidTransactions}</div>
            </div>
            <div class="bg-bg-card border border-border-flat rounded-lg p-5 px-6 flex flex-col gap-1">
                <div class="text-xs font-semibold text-text-muted uppercase tracking-wider">Avg Transaction</div>
                <div class="text-[1.8rem] font-extrabold font-serif leading-tight text-warning">{formatMoney(overview.avgTransactionValue)}</div>
            </div>
            <div class="bg-bg-card border border-border-flat rounded-lg p-5 px-6 flex flex-col gap-1">
                <div class="text-xs font-semibold text-text-muted uppercase tracking-wider">Items Sold</div>
                <div class="text-[1.8rem] font-extrabold font-serif leading-tight text-text-main">{overview.totalItemsSold}</div>
            </div>
            <div class="bg-bg-card border border-border-flat rounded-lg p-5 px-6 flex flex-col gap-1">
                <div class="text-xs font-semibold text-text-muted uppercase tracking-wider">Tax Total</div>
                <div class="text-[1.8rem] font-extrabold font-serif leading-tight text-warning">{formatMoney(business.taxTotal)}</div>
            </div>
            <div class="bg-bg-card border border-border-flat rounded-lg p-5 px-6 flex flex-col gap-1">
                <div class="text-xs font-semibold text-text-muted uppercase tracking-wider">Discounts Issued</div>
                <div class="text-[1.8rem] font-extrabold font-serif leading-tight text-warning">{formatMoney(business.discountTotal)}</div>
            </div>
            <div class="bg-bg-card border border-border-flat rounded-lg p-5 px-6 flex flex-col gap-1">
                <div class="text-xs font-semibold text-text-muted uppercase tracking-wider">Cost of Goods</div>
                <div class="text-[1.8rem] font-extrabold font-serif leading-tight text-text-main">{formatMoney(business.costTotal)}</div>
            </div>
            <div class="bg-bg-card border border-border-flat rounded-lg p-5 px-6 flex flex-col gap-1">
                <div class="text-xs font-semibold text-text-muted uppercase tracking-wider">Gross Profit After Tax</div>
                <div class="text-[1.8rem] font-extrabold font-serif leading-tight {business.grossProfit >= 0 ? 'text-success' : 'text-danger'}">{formatMoney(business.grossProfit)}</div>
            </div>
        </div>

        <!-- Sales by Till -->
        <section class="bg-bg-card border border-border-flat rounded-lg p-6">
            <h3 class="text-[1.15rem] mb-4 text-accent-primary">Sales by Till</h3>
            {#if visibleTillSummaries.length === 0}
                <div class="p-8 text-center text-text-muted">No till sales for the selected period.</div>
            {:else}
                <div class="overflow-x-auto">
                    <table class="w-full border-collapse text-left">
                        <thead>
                            <tr class="text-text-muted text-sm">
                                <th class="px-3 py-3 border-b border-border-flat">Till Name</th>
                                <th class="px-3 py-3 border-b border-border-flat">Net Sales</th>
                                <th class="px-3 py-3 border-b border-border-flat">Gross</th>
                                <th class="px-3 py-3 border-b border-border-flat">Refunds</th>
                                <th class="px-3 py-3 border-b border-border-flat">Transactions</th>
                                <th class="px-3 py-3 border-b border-border-flat">Refund Tx</th>
                                <th class="px-3 py-3 border-b border-border-flat">Items</th>
                                <th class="px-3 py-3 border-b border-border-flat">Cash</th>
                                <th class="px-3 py-3 border-b border-border-flat">Card</th>
                                <th class="px-3 py-3 border-b border-border-flat">Loyalty</th>
                            </tr>
                        </thead>
                        <tbody>
                            {#each visibleTillSummaries as till}
                                <tr class="hover:bg-bg-card-hover">
                                    <td class="px-3 py-3 border-b border-border-flat font-bold">{till.name}</td>
                                    <td class="px-3 py-3 border-b border-border-flat font-bold text-success">{formatMoney(till.netSales)}</td>
                                    <td class="px-3 py-3 border-b border-border-flat">{formatMoney(till.grossSales)}</td>
                                    <td class="px-3 py-3 border-b border-border-flat text-danger">{formatMoney(till.refunds)}</td>
                                    <td class="px-3 py-3 border-b border-border-flat">{till.transactions}</td>
                                    <td class="px-3 py-3 border-b border-border-flat">{till.refundTransactions}</td>
                                    <td class="px-3 py-3 border-b border-border-flat">{till.itemsSold}</td>
                                    <td class="px-3 py-3 border-b border-border-flat">{formatMoney(till.cashTotal)}</td>
                                    <td class="px-3 py-3 border-b border-border-flat">{formatMoney(till.cardTotal)}</td>
                                    <td class="px-3 py-3 border-b border-border-flat">{formatMoney(till.loyaltyTotal)}</td>
                                </tr>
                            {/each}
                        </tbody>
                    </table>
                </div>
            {/if}
        </section>

        <!-- Sales by Employee -->
        <section class="bg-bg-card border border-border-flat rounded-lg p-6">
            <h3 class="text-[1.15rem] mb-4 text-accent-primary">Sales by Employee</h3>
            {#if employeeSales.length === 0}
                <div class="p-8 text-center text-text-muted">No employee sales for the selected period.</div>
            {:else}
                <div class="overflow-x-auto">
                    <table class="w-full border-collapse text-left">
                        <thead>
                            <tr class="text-text-muted text-sm">
                                <th class="px-3 py-3 border-b border-border-flat">Employee</th>
                                <th class="px-3 py-3 border-b border-border-flat">Net Sales</th>
                                <th class="px-3 py-3 border-b border-border-flat">Gross Sales</th>
                                <th class="px-3 py-3 border-b border-border-flat">Refunds</th>
                                <th class="px-3 py-3 border-b border-border-flat">Transactions</th>
                                <th class="px-3 py-3 border-b border-border-flat">Refund Tx</th>
                                <th class="px-3 py-3 border-b border-border-flat">Average</th>
                            </tr>
                        </thead>
                        <tbody>
                            {#each employeeSales as employee}
                                <tr class="hover:bg-bg-card-hover">
                                    <td class="px-3 py-3 border-b border-border-flat font-bold">{employee.employeeName}</td>
                                    <td class="px-3 py-3 border-b border-border-flat text-success font-bold">{formatMoney(employee.netSales)}</td>
                                    <td class="px-3 py-3 border-b border-border-flat">{formatMoney(employee.grossSales)}</td>
                                    <td class="px-3 py-3 border-b border-border-flat text-danger">{formatMoney(employee.refunds)}</td>
                                    <td class="px-3 py-3 border-b border-border-flat">{employee.transactions}</td>
                                    <td class="px-3 py-3 border-b border-border-flat">{employee.refundTransactions}</td>
                                    <td class="px-3 py-3 border-b border-border-flat">{formatMoney(employee.avgTransaction)}</td>
                                </tr>
                            {/each}
                        </tbody>
                    </table>
                </div>
            {/if}
        </section>

        <!-- Daily Sales Trend -->
        <section class="bg-bg-card border border-border-flat rounded-lg p-6">
            <h3 class="text-[1.15rem] mb-4 text-accent-primary">Daily Sales Trend</h3>
            {#if dailyTrend.length === 0}
                <div class="p-8 text-center text-text-muted">No daily sales for the selected period.</div>
            {:else}
                <div class="flex items-end gap-2 h-48 overflow-x-auto pb-2">
                    {#each displayDailyTrend as day}
                        <div class="min-w-[54px] flex-1 h-full flex flex-col justify-end items-center gap-2" title={`${day.date}: ${formatMoney(day.netSales)} · ${day.transactions} transactions`}>
                            <span class="text-[10px] font-bold text-text-muted">{formatMoney(day.netSales)}</span>
                            <div class="w-full max-w-12 min-h-[3px] rounded-t {day.netSales < 0 ? 'bg-danger' : day.netSales === 0 ? 'bg-border-flat' : 'bg-accent-primary'}" style="height: {Math.max(2, (Math.abs(day.netSales) / maxDailySales) * 130)}px"></div>
                            <span class="text-[10px] text-text-muted">{new Date(`${day.date}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}</span>
                        </div>
                    {/each}
                </div>
            {/if}
        </section>

        <!-- Payment Method Breakdown -->
        <section class="bg-bg-card border border-border-flat rounded-lg p-6">
            <h3 class="text-[1.15rem] mb-4 text-accent-primary">💳 Payment Breakdown</h3>
            <div class="flex flex-col xl:flex-row gap-8 items-stretch xl:items-start">
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
                    {#if breakdown.totalLoyalty !== 0}
                        <div class="flex items-center gap-3">
                            <span class="w-20 text-[0.9rem] font-semibold text-text-muted">Loyalty</span>
                            <div class="flex-1 h-7 bg-bg-panel rounded-md overflow-hidden border border-border-flat">
                                <div class="h-full rounded-md transition-[width] duration-500 min-w-[2px] bg-[linear-gradient(90deg,#8b5cf6,#a78bfa)]" style="width: {Math.max(0, loyaltyPercent)}%"></div>
                            </div>
                            <span class="w-12 text-right text-[0.9rem] font-bold text-text-main">{loyaltyPercent}%</span>
                        </div>
                    {/if}
                    {#if breakdown.unrecordedAmount !== 0}
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
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full xl:w-[340px]">
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
                    {#if breakdown.totalLoyalty !== 0}
                        <div class="bg-bg-panel border border-border-flat rounded-lg p-4 flex flex-col gap-0.5">
                            <div class="text-xs font-semibold text-text-muted">Loyalty Credit</div>
                            <div class="text-[1.3rem] font-extrabold font-serif text-accent-primary">{formatMoney(breakdown.totalLoyalty)}</div>
                            <div class="text-[0.75rem] text-text-muted">{breakdown.loyaltyTxCount} transactions</div>
                        </div>
                    {/if}
                    {#if breakdown.splitTxCount > 0}
                        <div class="bg-bg-panel border border-border-flat rounded-lg p-4 flex flex-col gap-0.5">
                            <div class="text-xs font-semibold text-text-muted">Split Payments</div>
                            <div class="text-[0.75rem] text-text-muted">{breakdown.splitTxCount} transactions (cash+card combined)</div>
                        </div>
                    {/if}
                    {#if breakdown.unrecordedAmount !== 0}
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

        <!-- Close Reports -->
        <section class="report-no-print bg-bg-card border border-border-flat rounded-lg p-6">
            <h3 class="text-[1.15rem] mb-4 text-accent-primary">Period Close / Z Reports</h3>
            <div class="flex flex-wrap gap-4">
                <button class="btn btn-primary" disabled={!tillId} on:click={runTillDayReport}>
                    Close Period: This Till
                </button>
                <button class="btn btn-primary" on:click={runSystemDayReport}>
                    Close Period: Whole System
                </button>
                <button class="btn btn-secondary" disabled={!tillId} on:click={runTillFullReport}>
                    Preview This Till All-Time
                </button>
            </div>
            <p class="text-text-muted text-sm mt-2">
                Close Period uses the time from the last close to now. It is not automatically today's calendar sales.
                Use the whole-system close when the shop day is finished for every till.
            </p>
        </section>
    </div>
</MgmtPage>

<!-- Till Report Modal -->
{#if showTillReport && tillReportData}
    <div class="fixed inset-0 flex items-center justify-center z-[100] bg-[var(--overlay)] p-2" on:click={() => showTillReport = false}>
        <div class="w-[760px] max-w-[calc(100vw-1rem)] max-h-[calc(100vh-1rem)] overflow-y-auto rounded-md bg-bg-card border border-border-flat flex flex-col" on:click|stopPropagation>
            <div class="sticky top-0 z-10 flex justify-between items-center gap-3 border-b border-border-flat bg-bg-card p-3 md:p-4">
                <div class="min-w-0">
                    <h3 class="m-0 truncate text-lg">{tillReportTitle || `Till Report: ${tillName}`}</h3>
                    <div class="mt-1 text-xs text-text-muted">{tillReportPeriod}</div>
                </div>
                <button class="shrink-0 bg-transparent text-text-muted text-[1.2rem]" on:click={() => showTillReport = false}>✕</button>
            </div>
            <div class="flex flex-col gap-3 p-3 md:p-4">
            {#if closeReportIncludesPreviousDays}
                <div class="rounded-xl border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
                    This period started before today, so the total can include previous days.
                </div>
            {/if}
            {#if closeReportCanEnd}
                <div class="rounded-xl border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
                    This is only a preview. Press <strong>Close Period</strong> to close this report period and make the next report start from now.
                </div>
                {#if !hasPermission($currentEmployee, 'end_day_close', $settingsDB)}
                    <div class="rounded-xl border border-danger/40 bg-danger/10 p-3 text-xs text-danger">
                        Your current role can preview this report, but manager permission is required to close the period.
                    </div>
                {/if}
            {/if}

            <!-- Mini overview cards -->
            <div class="grid grid-cols-2 md:grid-cols-5 gap-2">
                <div class="bg-bg-card border border-border-flat rounded-lg p-3 flex flex-col gap-1">
                    <div class="text-[0.65rem] font-semibold text-text-muted uppercase tracking-wider">Net Sales</div>
                    <div class="text-lg font-extrabold font-serif leading-tight text-success">{formatMoney(tillReportData.overview.totalRevenue)}</div>
                </div>
                <div class="bg-bg-card border border-border-flat rounded-lg p-3 flex flex-col gap-1">
                    <div class="text-[0.65rem] font-semibold text-text-muted uppercase tracking-wider">Transactions</div>
                    <div class="text-lg font-extrabold font-serif leading-tight text-accent-primary">{tillReportData.overview.totalTransactions}</div>
                </div>
                <div class="bg-bg-card border border-border-flat rounded-lg p-3 flex flex-col gap-1">
                    <div class="text-[0.65rem] font-semibold text-text-muted uppercase tracking-wider">Refunds</div>
                    <div class="text-lg font-extrabold font-serif leading-tight text-danger">{tillReportData.overview.refundTransactions}</div>
                </div>
                <div class="bg-bg-card border border-border-flat rounded-lg p-3 flex flex-col gap-1">
                    <div class="text-[0.65rem] font-semibold text-text-muted uppercase tracking-wider">Avg Sale</div>
                    <div class="text-lg font-extrabold font-serif leading-tight text-warning">{formatMoney(tillReportData.overview.avgTransactionValue)}</div>
                </div>
                <div class="bg-bg-card border border-border-flat rounded-lg p-3 flex flex-col gap-1">
                    <div class="text-[0.65rem] font-semibold text-text-muted uppercase tracking-wider">Items Sold</div>
                    <div class="text-lg font-extrabold font-serif leading-tight text-text-main">{tillReportData.overview.totalItemsSold}</div>
                </div>
            </div>

            <!-- Payment breakdown -->
            <div class="grid grid-cols-3 gap-2">
                <div class="bg-bg-panel border border-border-flat rounded-lg p-3 flex flex-col gap-0.5">
                    <div class="text-xs font-semibold text-text-muted">Cash</div>
                    <div class="text-lg font-extrabold font-serif text-success">{formatMoney(tillReportData.breakdown.totalCash)}</div>
                    <div class="text-[0.7rem] text-text-muted">{tillReportData.breakdown.cashTxCount} tx</div>
                </div>
                <div class="bg-bg-panel border border-border-flat rounded-lg p-3 flex flex-col gap-0.5">
                    <div class="text-xs font-semibold text-text-muted">Card</div>
                    <div class="text-lg font-extrabold font-serif text-accent-primary">{formatMoney(tillReportData.breakdown.totalCard)}</div>
                    <div class="text-[0.7rem] text-text-muted">{tillReportData.breakdown.cardTxCount} tx</div>
                </div>
                <div class="bg-bg-panel border border-border-flat rounded-lg p-3 flex flex-col gap-0.5">
                    <div class="text-xs font-semibold text-text-muted">Loyalty</div>
                    <div class="text-lg font-extrabold font-serif text-accent-primary">{formatMoney(tillReportData.breakdown.totalLoyalty)}</div>
                    <div class="text-[0.7rem] text-text-muted">{tillReportData.breakdown.loyaltyTxCount} tx</div>
                </div>
                {#if tillReportData.breakdown.unrecordedAmount !== 0}
                    <div class="bg-bg-panel border border-border-flat rounded-lg p-3 flex flex-col gap-0.5 col-span-3">
                        <div class="text-xs font-semibold text-text-muted">Unrecorded</div>
                        <div class="text-lg font-extrabold font-serif text-text-muted">{formatMoney(tillReportData.breakdown.unrecordedAmount)}</div>
                        <div class="text-[0.7rem] text-text-muted">{tillReportData.breakdown.unrecordedTxCount} tx (missing payment records)</div>
                    </div>
                {/if}
            </div>

            <div class="rounded-xl border border-border-flat bg-bg-panel p-3">
                <div class="mb-1.5 text-[0.65rem] font-black uppercase tracking-[0.14em] text-text-muted">Receipt report text</div>
                <pre class="whitespace-pre-wrap rounded-lg bg-bg-card p-2 font-mono text-xs leading-relaxed">{closeReportText}</pre>
            </div>

            {#if closeReportConfirming}
                <div class="rounded-xl border border-danger/50 bg-danger/10 p-3">
                    <div class="font-bold text-danger">Confirm end of period</div>
                    <p class="mt-1 text-sm text-text-muted">
                        This will close the current report period for {closeReportTillNumber ? tillName : 'the whole system'}.
                        The next end report will start from this close time.
                    </p>
                </div>
            {/if}
            </div>

            <div class="sticky bottom-0 z-10 flex flex-wrap justify-end gap-3 border-t border-border-flat bg-bg-card p-3 md:p-4">
                {#if closeReportConfirming}
                    <button class="btn btn-secondary" disabled={closeReportSaving} on:click={() => closeReportConfirming = false}>
                        Cancel
                    </button>
                    <button class="btn btn-danger" disabled={closeReportSaving} on:click={confirmEndReportPeriod}>
                        {closeReportSaving ? 'Closing...' : 'Yes, Close Period'}
                    </button>
                {:else if closeReportCanEnd}
                    <button class="btn btn-danger" disabled={closeReportSaving} on:click={requestEndReportPeriod}>
                        {closeReportSaving ? 'Closing...' : 'Close Period'}
                    </button>
                {/if}
                <button class="btn btn-secondary" disabled={closeReportPrintBusy} on:click={printCloseReport}>
                    {closeReportPrintBusy ? 'Printing...' : 'Print'}
                </button>
                <button class="btn btn-primary" on:click={() => showTillReport = false}>Close</button>
            </div>
        </div>
    </div>
{/if}

<style>
    @media print {
        :global(.management-header),
        :global(.fullscreen-toggle),
        .report-controls,
        .report-no-print,
        :global(.toast-container) {
            display: none !important;
        }

        :global(.management-page),
        :global(.management-content),
        .report-page {
            height: auto !important;
            max-height: none !important;
            overflow: visible !important;
            border: 0 !important;
            padding: 0 !important;
            background: white !important;
            color: black !important;
        }

        .report-page {
            gap: 12px !important;
        }

        section,
        table,
        tr {
            break-inside: avoid;
        }
    }
</style>

{#if loading}
    <div class="fixed inset-0 bg-black/30 flex items-center justify-center z-50 pointer-events-none">
        <div class="bg-bg-card p-4 rounded-md text-text-main font-semibold shadow-lg">Loading reports…</div>
    </div>
{/if}
