<script lang="ts">
    import { onMount } from 'svelte';
    import { isTauri } from '@tauri-apps/api/core';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import CustomSelect from '$lib/components/CustomSelect.svelte';
    import { formatMoney, settingsDB, storeDB } from '$lib/stores/db';
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

    // Reports open on today's trading date by default.
    const today = new Date();
    let startDate = localDateValue(today);
    let endDate = localDateValue(today);

    type DatePreset = 'today' | 'week' | 'month' | 'year';
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
    let previewMode = false;
    let appliedStartDate = startDate;
    let appliedEndDate = endDate;
    let appliedTill = '';
    let appliedSortBy: 'quantity' | 'revenue' = 'quantity';
    const REPORT_LOAD_TIMEOUT_MS = 16_000;

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
    let periodReportBusy = false;
    $: canOpenReports = hasPermission($currentEmployee, 'open_reports', $settingsDB);
    $: canEndDay = hasPermission($currentEmployee, 'end_day_close', $settingsDB);

    async function withReportTimeout<T>(operation: Promise<T>): Promise<T> {
        let timeoutId: ReturnType<typeof setTimeout>;
        const timeout = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(
                () => reject(new Error('Report loading timed out. Check the database connection and try again.')),
                REPORT_LOAD_TIMEOUT_MS,
            );
        });
        try {
            return await Promise.race([operation, timeout]);
        } finally {
            clearTimeout(timeoutId!);
        }
    }

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
        if (previewMode) {
            clearReportResults();
            appliedStartDate = startDate;
            appliedEndDate = endDate;
            appliedTill = selectedTill;
            appliedSortBy = sortBy;
            reportSource = 'Browser Preview';
            loadedReportKey = `${startDate}|${endDate}|${selectedTill}|${sortBy}`;
            lastRefreshed = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            loading = false;
            return;
        }
        try {
            const snapshot = await withReportTimeout(
                getReportSnapshot(startDate, endDate, sortBy, 10, till),
            );
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
            appliedStartDate = startDate;
            appliedEndDate = endDate;
            appliedTill = selectedTill;
            appliedSortBy = sortBy;
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

    function datePresetRange(preset: DatePreset): [string, string] {
        const end = new Date();
        const start = new Date(end);
        if (preset === 'week') start.setDate(end.getDate() - 6);
        if (preset === 'month') start.setDate(1);
        if (preset === 'year') {
            start.setMonth(0);
            start.setDate(1);
        }
        return [localDateValue(start), localDateValue(end)];
    }

    function setDatePreset(preset: DatePreset) {
        [startDate, endDate] = datePresetRange(preset);
        if (mounted) void loadData();
    }

    function selectedDatePreset(currentStart: string, currentEnd: string): DatePreset | '' {
        for (const preset of ['today', 'week', 'month', 'year'] as DatePreset[]) {
            const [presetStart, presetEnd] = datePresetRange(preset);
            if (currentStart === presetStart && currentEnd === presetEnd) return preset;
        }
        return '';
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
            ['Till', 'Net Sales', 'Gross Sales', 'Refunds', 'Tax', 'Sales', 'Refund Transactions', 'Items', 'Cash', 'Card', 'Loyalty Credit'],
            ...visibleTillSummaries.map(till => [till.name, pounds(till.netSales), pounds(till.grossSales), pounds(till.refunds), pounds(till.taxTotal), till.transactions, till.refundTransactions, till.itemsSold, pounds(till.cashTotal), pounds(till.cardTotal), pounds(till.loyaltyTotal)]),
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
        const shopName = $storeDB.name?.trim() || 'Shop';
        await printThermalReport(closeReportText, `${shopName} end-of-day report`, 'close');
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

    function formatDateShort(value: string) {
        if (!value) return '';
        return new Date(`${value}T00:00:00`).toLocaleDateString('en-GB', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
        });
    }

    function buildCloseReportText(
        title: string,
        period: string,
        data: { overview: SalesOverview; breakdown: PaymentBreakdown; topProducts: TopProduct[] },
    ) {
        const shopName = $storeDB.name?.trim() || 'Shop';
        const lines = [
            shopName,
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
        if (data.breakdown.unrecordedAmount !== 0) {
            lines.push(`Unrecorded: ${formatMoney(data.breakdown.unrecordedAmount)}`);
        }
        if (data.topProducts.length > 0) {
            lines.push(''.padEnd(32, '-'), 'Top products');
            for (const product of data.topProducts.slice(0, 5)) {
                lines.push(`${product.qtySold} x ${product.name}`, `  ${formatMoney(product.totalRevenue)}`);
            }
        }
        lines.push(''.padEnd(32, '-'), `Generated: ${new Date().toLocaleString('en-GB')}`);
        return lines.join('\n');
    }

    async function previewPeriodReport(scope: 'till' | 'system', closePeriod: boolean) {
        if (periodReportBusy) return;
        periodReportBusy = true;
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
        } finally {
            periodReportBusy = false;
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
        previewMode = !isTauri();
        if (previewMode) {
            tillName = 'Browser Preview';
            tillId = 'browser-preview-till';
        } else {
            try {
                [tillName, tillId] = await Promise.all([getTillName(), getOrCreateTillId()]);
            } catch (error) {
                reportError = `Could not identify this till: ${error}`;
            }
        }
        mounted = true;
        if (canOpenReports) await loadData();
        else loading = false;
    });

    $: paymentMagnitude = Math.abs(breakdown.totalCash)
        + Math.abs(breakdown.totalCard)
        + Math.abs(breakdown.totalLoyalty)
        + Math.abs(breakdown.unrecordedAmount);
    $: cashPercent = paymentMagnitude > 0 ? Math.round((Math.abs(breakdown.totalCash) / paymentMagnitude) * 100) : 0;
    $: cardPercent = paymentMagnitude > 0 ? Math.round((Math.abs(breakdown.totalCard) / paymentMagnitude) * 100) : 0;
    $: loyaltyPercent = paymentMagnitude > 0 ? Math.round((Math.abs(breakdown.totalLoyalty) / paymentMagnitude) * 100) : 0;
    $: unrecordedPercent = paymentMagnitude > 0 ? Math.round((Math.abs(breakdown.unrecordedAmount) / paymentMagnitude) * 100) : 0;
    $: visibleTillSummaries = appliedTill ? tillSummaries.filter((till) => till.id === appliedTill) : tillSummaries;
    $: tillTotals = [...visibleTillSummaries].sort((a, b) => Math.abs(b.netSales) - Math.abs(a.netSales));
    $: selectedTillLabel = allTills.find((till) => till.id === appliedTill)?.name || 'All Tills';
    $: reportPeriodLabel = appliedStartDate === appliedEndDate ? formatDateShort(appliedStartDate) : `${formatDateShort(appliedStartDate)} to ${formatDateShort(appliedEndDate)}`;
    $: tillNetTotal = tillTotals.reduce((sum, till) => sum + till.netSales, 0);
    $: tillGrossTotal = tillTotals.reduce((sum, till) => sum + till.grossSales, 0);
    $: tillRefundTotal = tillTotals.reduce((sum, till) => sum + till.refunds, 0);
    $: tillTaxTotal = tillTotals.reduce((sum, till) => sum + till.taxTotal, 0);
    $: tillTransactionTotal = tillTotals.reduce((sum, till) => sum + till.transactions, 0);
    $: tillRefundTransactionTotal = tillTotals.reduce((sum, till) => sum + till.refundTransactions, 0);
    $: tillItemTotal = tillTotals.reduce((sum, till) => sum + till.itemsSold, 0);
    $: tillCashTotal = tillTotals.reduce((sum, till) => sum + till.cashTotal, 0);
    $: tillCardTotal = tillTotals.reduce((sum, till) => sum + till.cardTotal, 0);
    $: tillLoyaltyTotal = tillTotals.reduce((sum, till) => sum + till.loyaltyTotal, 0);
    $: maxTillNetSales = Math.max(1, ...tillTotals.map((till) => Math.abs(till.netSales)));
    $: summaryCards = [
        { label: 'Net Sales', value: formatMoney(business.netSales), detail: 'After refunds and discounts', tone: 'text-success' },
        { label: 'Gross Sales', value: formatMoney(business.grossSales), detail: 'Before refunds and discounts', tone: 'text-text-main' },
        { label: 'Sales Transactions', value: String(overview.totalTransactions), detail: `${overview.refundTransactions} refund transactions`, tone: 'text-accent-primary' },
        { label: 'Average Sale', value: formatMoney(overview.avgTransactionValue), detail: `${overview.totalItemsSold} items sold`, tone: 'text-warning' },
        { label: 'Refunds', value: formatMoney(business.refunds), detail: `${business.voidTransactions} void transactions`, tone: 'text-danger' },
        { label: 'Discounts', value: formatMoney(business.discountTotal), detail: `Tax collected ${formatMoney(business.taxTotal)}`, tone: 'text-warning' },
        { label: 'Cost of Goods', value: formatMoney(business.costTotal), detail: 'Product cost total', tone: 'text-text-main' },
        { label: 'Gross Profit', value: formatMoney(business.grossProfit), detail: 'After cost of goods', tone: business.grossProfit >= 0 ? 'text-success' : 'text-danger' },
    ];
    $: displayDailyTrend = filledDailyTrend(appliedStartDate, appliedEndDate, dailyTrend);
    $: maxDailySales = Math.max(1, ...displayDailyTrend.map((day) => Math.abs(day.netSales)));
    $: currentReportKey = `${startDate}|${endDate}|${selectedTill}|${sortBy}`;
    $: reportReady = !loading && loadedReportKey === currentReportKey;
    $: filtersDirty = Boolean(loadedReportKey && loadedReportKey !== currentReportKey);
    $: activeDatePreset = selectedDatePreset(startDate, endDate);
    $: reconciliationDifference = business.grossSales - business.discountTotal - business.refunds - business.netSales;
    $: closeReportStartDay = closeReportStart ? localDateValue(new Date(closeReportStart)) : '';
    $: closeReportIncludesPreviousDays = Boolean(closeReportStartDay && closeReportStartDay < localDateValue(new Date()));
</script>

<MgmtPage title={canOpenReports ? 'Sales Reports' : 'End Day / Z Report'}>
    <div class="report-page h-full overflow-y-auto p-3 md:p-5 xl:p-6 flex flex-col gap-4 md:gap-5">
        {#if canOpenReports}
        <section class="report-controls bg-bg-card border border-border-flat rounded-lg p-4 md:p-5">
            <div class="flex flex-col gap-4">
                <div class="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
                    <div class="min-w-0">
                        <div class="text-xs font-black uppercase tracking-[0.16em] text-text-muted">Sales Report</div>
                        <h2 class="m-0 mt-1 text-2xl md:text-3xl leading-tight">{reportPeriodLabel}</h2>
                        <div class="mt-3 flex flex-wrap items-center gap-2 text-xs">
                            <span class="rounded-full border border-border-flat bg-bg-panel px-3 py-1 font-bold text-text-main">{selectedTillLabel}</span>
                            <span class="rounded-full px-3 py-1 font-bold {reportSource === 'Live MariaDB' ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'}">{reportSource}</span>
                            {#if lastRefreshed}
                                <span class="rounded-full border border-border-flat bg-bg-panel px-3 py-1 text-text-muted">Updated {lastRefreshed}</span>
                            {/if}
                        </div>
                    </div>
                    <div class="grid grid-cols-2 sm:flex gap-2">
                        <button class="btn {activeDatePreset === 'today' ? 'btn-primary' : 'btn-secondary'} !px-4 !py-2 !text-sm" disabled={loading} on:click={() => setDatePreset('today')}>Today</button>
                        <button class="btn {activeDatePreset === 'week' ? 'btn-primary' : 'btn-secondary'} !px-4 !py-2 !text-sm" disabled={loading} on:click={() => setDatePreset('week')}>7 Days</button>
                        <button class="btn {activeDatePreset === 'month' ? 'btn-primary' : 'btn-secondary'} !px-4 !py-2 !text-sm" disabled={loading} on:click={() => setDatePreset('month')}>This Month</button>
                        <button class="btn {activeDatePreset === 'year' ? 'btn-primary' : 'btn-secondary'} !px-4 !py-2 !text-sm" disabled={loading} on:click={() => setDatePreset('year')}>This Year</button>
                    </div>
                </div>

                <div class="report-filter-bar">
                    <div class="report-filter-grid">
                        <div class="field">
                            <label for="report-start-date">Start Date</label>
                            <input id="report-start-date" type="date" bind:value={startDate} />
                        </div>
                        <div class="field">
                            <label for="report-end-date">End Date</label>
                            <input id="report-end-date" type="date" bind:value={endDate} />
                        </div>
                        <div class="min-w-0">
                            <CustomSelect label="Till" bind:value={selectedTill} options={tillOptions} />
                        </div>
                        <div class="min-w-0">
                            <CustomSelect label="Top Products" bind:value={sortBy} options={sortOptions} />
                        </div>
                    </div>
                    <div class="report-filter-actions">
                        <button class="btn btn-primary" disabled={loading} on:click={loadData}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66L20 8"></path><path d="M20 3v5h-5"></path></svg>
                            {loading ? 'Loading...' : 'Apply Filters'}
                        </button>
                        <button class="btn btn-secondary" disabled={!reportReady} on:click={exportCsv}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"></path></svg>
                            Export CSV
                        </button>
                        <button class="btn btn-secondary" disabled={!reportReady || reportPrintBusy} on:click={printReport}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v7H6z"></path></svg>
                            {reportPrintBusy ? 'Printing...' : 'Print'}
                        </button>
                    </div>
                </div>
                {#if loading}
                    <div class="report-load-state">Updating report totals...</div>
                {:else if filtersDirty}
                    <div class="report-filter-pending">Filters changed. Press Apply Filters to update the report.</div>
                {/if}
            </div>
        </section>

        {#if reportError}
            <div class="bg-warning/10 border border-warning/40 text-warning rounded-lg p-4">
                <strong>Report warning:</strong> {reportError}
            </div>
        {/if}
        {#if reportReady && Math.abs(reconciliationDifference) > 1}
            <div class="bg-danger/10 border border-danger/40 text-danger rounded-lg p-4">
                <strong>Totals do not reconcile:</strong>
                Gross sales minus discounts issued and customer refunds differs from net sales by {formatMoney(reconciliationDifference)}.
            </div>
        {/if}

        <section class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
            {#each summaryCards as card}
                <article class="bg-bg-card border border-border-flat rounded-lg p-4 min-w-0">
                    <div class="text-[0.72rem] font-black uppercase tracking-[0.12em] text-text-muted">{card.label}</div>
                    <div class="mt-2 text-[1.55rem] md:text-[1.8rem] font-extrabold font-serif leading-tight {card.tone}">{card.value}</div>
                    <div class="mt-1 text-xs text-text-muted truncate">{card.detail}</div>
                </article>
            {/each}
        </section>

        <section class="bg-bg-card border border-border-flat rounded-lg p-4 md:p-5">
            <div class="flex flex-col xl:flex-row xl:items-start xl:justify-between gap-4">
                <div class="min-w-0">
                    <div class="text-xs font-black uppercase tracking-[0.16em] text-accent-primary">Till Totals</div>
                    <h3 class="m-0 mt-1 text-xl leading-tight">Total sales by each till</h3>
                    <p class="m-0 mt-1 text-sm text-text-muted">Compare every till for the selected period, with exact totals below.</p>
                </div>
                <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
                    <div class="rounded-lg border border-border-flat bg-bg-panel px-3 py-2">
                        <div class="text-[0.68rem] font-black uppercase tracking-[0.1em] text-text-muted">Net Total</div>
                        <div class="font-extrabold text-success">{formatMoney(tillNetTotal)}</div>
                    </div>
                    <div class="rounded-lg border border-border-flat bg-bg-panel px-3 py-2">
                        <div class="text-[0.68rem] font-black uppercase tracking-[0.1em] text-text-muted">Gross</div>
                        <div class="font-extrabold">{formatMoney(tillGrossTotal)}</div>
                    </div>
                    <div class="rounded-lg border border-border-flat bg-bg-panel px-3 py-2">
                        <div class="text-[0.68rem] font-black uppercase tracking-[0.1em] text-text-muted">Transactions</div>
                        <div class="font-extrabold text-accent-primary">{tillTransactionTotal}</div>
                    </div>
                    <div class="rounded-lg border border-border-flat bg-bg-panel px-3 py-2">
                        <div class="text-[0.68rem] font-black uppercase tracking-[0.1em] text-text-muted">Items</div>
                        <div class="font-extrabold">{tillItemTotal}</div>
                    </div>
                </div>
            </div>

            {#if tillTotals.length === 0}
                <div class="mt-4 rounded-lg border border-dashed border-border-flat p-8 text-center text-text-muted">No till sales for the selected period.</div>
            {:else}
                <div class="mt-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                    {#each tillTotals as till}
                        <article class="rounded-lg border border-border-flat bg-bg-panel p-4 min-w-0">
                            <div class="flex items-start justify-between gap-3">
                                <div class="min-w-0">
                                    <div class="text-xs font-black uppercase tracking-[0.12em] text-text-muted">Till</div>
                                    <div class="mt-1 truncate text-lg font-extrabold">{till.name}</div>
                                </div>
                                <div class="text-right">
                                    <div class="text-xs text-text-muted">Net</div>
                                    <div class="font-serif text-xl font-extrabold {till.netSales >= 0 ? 'text-success' : 'text-danger'}">{formatMoney(till.netSales)}</div>
                                </div>
                            </div>

                            <div class="mt-4 h-2 overflow-hidden rounded-full bg-bg-card border border-border-flat">
                                <div
                                    class="h-full rounded-full {till.netSales < 0 ? 'bg-danger' : 'bg-accent-primary'}"
                                    style="width: {till.netSales === 0 ? 0 : Math.max(6, (Math.abs(till.netSales) / maxTillNetSales) * 100)}%"
                                ></div>
                            </div>

                            <div class="mt-4 grid grid-cols-3 gap-2 text-sm">
                                <div>
                                    <div class="text-[0.7rem] text-text-muted">Sales</div>
                                    <div class="font-bold">{till.transactions}</div>
                                </div>
                                <div>
                                    <div class="text-[0.7rem] text-text-muted">Refunds</div>
                                    <div class="font-bold text-danger">{formatMoney(till.refunds)}</div>
                                </div>
                                <div>
                                    <div class="text-[0.7rem] text-text-muted">Items</div>
                                    <div class="font-bold">{till.itemsSold}</div>
                                </div>
                            </div>

                            <div class="mt-3 grid grid-cols-3 gap-2 text-xs text-text-muted">
                                <div class="rounded-md bg-bg-card px-2 py-1.5">
                                    <span class="block">Cash</span>
                                    <strong class="text-success">{formatMoney(till.cashTotal)}</strong>
                                </div>
                                <div class="rounded-md bg-bg-card px-2 py-1.5">
                                    <span class="block">Card</span>
                                    <strong class="text-accent-primary">{formatMoney(till.cardTotal)}</strong>
                                </div>
                                <div class="rounded-md bg-bg-card px-2 py-1.5">
                                    <span class="block">Loyalty</span>
                                    <strong class="text-text-main">{formatMoney(till.loyaltyTotal)}</strong>
                                </div>
                            </div>
                        </article>
                    {/each}
                </div>

                <div class="mt-4 overflow-x-auto rounded-lg border border-border-flat">
                    <table class="tbl">
                        <thead>
                            <tr>
                                <th>Till</th>
                                <th>Net Sales</th>
                                <th>Gross</th>
                                <th>Refunds</th>
                                <th>Tax</th>
                                <th>Sales Tx</th>
                                <th>Refund Tx</th>
                                <th>Items</th>
                                <th>Cash</th>
                                <th>Card</th>
                                <th>Loyalty</th>
                            </tr>
                        </thead>
                        <tbody>
                            {#each tillTotals as till}
                                <tr>
                                    <td class="font-bold">{till.name}</td>
                                    <td class="font-bold text-success">{formatMoney(till.netSales)}</td>
                                    <td>{formatMoney(till.grossSales)}</td>
                                    <td class="text-danger">{formatMoney(till.refunds)}</td>
                                    <td>{formatMoney(till.taxTotal)}</td>
                                    <td>{till.transactions}</td>
                                    <td>{till.refundTransactions}</td>
                                    <td>{till.itemsSold}</td>
                                    <td>{formatMoney(till.cashTotal)}</td>
                                    <td>{formatMoney(till.cardTotal)}</td>
                                    <td>{formatMoney(till.loyaltyTotal)}</td>
                                </tr>
                            {/each}
                            <tr class="bg-bg-panel font-extrabold">
                                <td>Total</td>
                                <td class="text-success">{formatMoney(tillNetTotal)}</td>
                                <td>{formatMoney(tillGrossTotal)}</td>
                                <td class="text-danger">{formatMoney(tillRefundTotal)}</td>
                                <td>{formatMoney(tillTaxTotal)}</td>
                                <td>{tillTransactionTotal}</td>
                                <td>{tillRefundTransactionTotal}</td>
                                <td>{tillItemTotal}</td>
                                <td>{formatMoney(tillCashTotal)}</td>
                                <td>{formatMoney(tillCardTotal)}</td>
                                <td>{formatMoney(tillLoyaltyTotal)}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            {/if}
        </section>

        <div class="grid grid-cols-1 lg:grid-cols-[1.15fr_0.85fr] gap-4 md:gap-5">
            <section class="bg-bg-card border border-border-flat rounded-lg p-4 md:p-5">
                <div class="flex items-start justify-between gap-3">
                    <div>
                        <div class="text-xs font-black uppercase tracking-[0.16em] text-accent-primary">Trend</div>
                        <h3 class="m-0 mt-1 text-xl">Daily sales</h3>
                    </div>
                    <span class="rounded-full bg-bg-panel border border-border-flat px-3 py-1 text-xs text-text-muted">{displayDailyTrend.length} days</span>
                </div>
                {#if dailyTrend.length === 0}
                    <div class="mt-4 rounded-lg border border-dashed border-border-flat p-8 text-center text-text-muted">No daily sales for the selected period.</div>
                {:else}
                    <div class="mt-4 flex items-end gap-2 h-48 2xl:h-56 overflow-x-auto pb-2">
                        {#each displayDailyTrend as day}
                            <div class="min-w-[58px] flex-1 h-full flex flex-col justify-end items-center gap-2" title={`${day.date}: ${formatMoney(day.netSales)} · ${day.transactions} transactions`}>
                                <span class="text-[10px] font-bold text-text-muted">{formatMoney(day.netSales)}</span>
                                <div class="w-full max-w-12 min-h-[3px] rounded-t {day.netSales < 0 ? 'bg-danger' : day.netSales === 0 ? 'bg-border-flat' : 'bg-accent-primary'}" style="height: {Math.max(2, (Math.abs(day.netSales) / maxDailySales) * 150)}px"></div>
                                <span class="text-[10px] text-text-muted">{new Date(`${day.date}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}</span>
                            </div>
                        {/each}
                    </div>
                {/if}
            </section>

            <section class="bg-bg-card border border-border-flat rounded-lg p-4 md:p-5">
                <div class="text-xs font-black uppercase tracking-[0.16em] text-accent-primary">Payments</div>
                <h3 class="m-0 mt-1 text-xl">Payment mix</h3>
                <div class="mt-4 flex flex-col gap-3">
                    <div class="grid grid-cols-[72px_1fr_44px] items-center gap-3">
                        <span class="text-sm font-bold text-text-muted">Cash</span>
                        <div class="h-8 bg-bg-panel rounded-md overflow-hidden border border-border-flat">
                                <div class="h-full rounded-md min-w-[2px] bg-success" style="width: {cashPercent}%"></div>
                        </div>
                        <span class="text-right text-sm font-bold">{cashPercent}%</span>
                    </div>
                    <div class="grid grid-cols-[72px_1fr_44px] items-center gap-3">
                        <span class="text-sm font-bold text-text-muted">Card</span>
                        <div class="h-8 bg-bg-panel rounded-md overflow-hidden border border-border-flat">
                                <div class="h-full rounded-md min-w-[2px] bg-accent-primary" style="width: {cardPercent}%"></div>
                        </div>
                        <span class="text-right text-sm font-bold">{cardPercent}%</span>
                    </div>
                    {#if breakdown.totalLoyalty !== 0}
                        <div class="grid grid-cols-[72px_1fr_44px] items-center gap-3">
                            <span class="text-sm font-bold text-text-muted">Loyalty</span>
                            <div class="h-8 bg-bg-panel rounded-md overflow-hidden border border-border-flat">
                                <div class="h-full rounded-md min-w-[2px] bg-warning" style="width: {Math.max(0, loyaltyPercent)}%"></div>
                            </div>
                            <span class="text-right text-sm font-bold">{loyaltyPercent}%</span>
                        </div>
                    {/if}
                    {#if breakdown.unrecordedAmount !== 0}
                        <div class="grid grid-cols-[72px_1fr_44px] items-center gap-3">
                            <span class="text-sm font-bold text-text-muted">Missing</span>
                            <div class="h-8 bg-bg-panel rounded-md overflow-hidden border border-border-flat">
                                <div class="h-full rounded-md min-w-[2px] bg-border-flat" style="width: {unrecordedPercent}%"></div>
                            </div>
                            <span class="text-right text-sm font-bold">{unrecordedPercent}%</span>
                        </div>
                    {/if}
                </div>

                <div class="mt-5 grid grid-cols-2 gap-3">
                    <div class="rounded-lg border border-border-flat bg-bg-panel p-3">
                        <div class="text-xs font-bold text-text-muted">Cash Sales</div>
                        <div class="mt-1 font-serif text-xl font-extrabold text-success">{formatMoney(breakdown.totalCash)}</div>
                        <div class="text-xs text-text-muted">{breakdown.cashTxCount} transactions</div>
                    </div>
                    <div class="rounded-lg border border-border-flat bg-bg-panel p-3">
                        <div class="text-xs font-bold text-text-muted">Card Sales</div>
                        <div class="mt-1 font-serif text-xl font-extrabold text-accent-primary">{formatMoney(breakdown.totalCard)}</div>
                        <div class="text-xs text-text-muted">{breakdown.cardTxCount} transactions</div>
                    </div>
                    {#if breakdown.totalLoyalty !== 0}
                        <div class="rounded-lg border border-border-flat bg-bg-panel p-3">
                            <div class="text-xs font-bold text-text-muted">Loyalty Credit</div>
                            <div class="mt-1 font-serif text-xl font-extrabold">{formatMoney(breakdown.totalLoyalty)}</div>
                            <div class="text-xs text-text-muted">{breakdown.loyaltyTxCount} transactions</div>
                        </div>
                    {/if}
                    {#if breakdown.splitTxCount > 0}
                        <div class="rounded-lg border border-border-flat bg-bg-panel p-3">
                            <div class="text-xs font-bold text-text-muted">Split Payments</div>
                            <div class="mt-1 font-bold">{breakdown.splitTxCount}</div>
                            <div class="text-xs text-text-muted">cash and card combined</div>
                        </div>
                    {/if}
                    {#if breakdown.unrecordedAmount !== 0}
                        <div class="rounded-lg border border-border-flat bg-bg-panel p-3 col-span-2">
                            <div class="text-xs font-bold text-text-muted">Missing Payment Records</div>
                            <div class="mt-1 font-serif text-xl font-extrabold text-text-muted">{formatMoney(breakdown.unrecordedAmount)}</div>
                            <div class="text-xs text-text-muted">{breakdown.unrecordedTxCount} transactions need payment records</div>
                        </div>
                    {/if}
                </div>
            </section>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 md:gap-5">
            <section class="bg-bg-card border border-border-flat rounded-lg p-4 md:p-5">
                <div class="text-xs font-black uppercase tracking-[0.16em] text-accent-primary">Products</div>
                <h3 class="m-0 mt-1 text-xl">Top products by {appliedSortBy === 'revenue' ? 'revenue' : 'quantity'}</h3>
                {#if topProducts.length === 0}
                    <div class="mt-4 rounded-lg border border-dashed border-border-flat p-8 text-center text-text-muted">No sales data for the selected period.</div>
                {:else}
                    <div class="mt-4 overflow-x-auto rounded-lg border border-border-flat">
                        <table class="tbl">
                            <thead>
                                <tr>
                                    <th>#</th>
                                    <th>Product</th>
                                    <th>SKU</th>
                                    <th>Qty</th>
                                    <th>Revenue</th>
                                    <th>Avg Price</th>
                                </tr>
                            </thead>
                            <tbody>
                                {#each topProducts as product, i}
                                    <tr>
                                        <td class="font-bold text-accent-primary">{i + 1}</td>
                                        <td class="font-semibold">{product.name}</td>
                                        <td class="font-mono text-text-muted">{product.sku || '-'}</td>
                                        <td class="font-bold">{product.qtySold}</td>
                                        <td class="font-bold text-success">{formatMoney(product.totalRevenue)}</td>
                                        <td>{formatMoney(product.avgPrice)}</td>
                                    </tr>
                                {/each}
                            </tbody>
                        </table>
                    </div>
                {/if}
            </section>

            <section class="bg-bg-card border border-border-flat rounded-lg p-4 md:p-5">
                <div class="text-xs font-black uppercase tracking-[0.16em] text-accent-primary">Staff</div>
                <h3 class="m-0 mt-1 text-xl">Sales by employee</h3>
                {#if employeeSales.length === 0}
                    <div class="mt-4 rounded-lg border border-dashed border-border-flat p-8 text-center text-text-muted">No employee sales for the selected period.</div>
                {:else}
                    <div class="mt-4 overflow-x-auto rounded-lg border border-border-flat">
                        <table class="tbl">
                            <thead>
                                <tr>
                                    <th>Employee</th>
                                    <th>Net Sales</th>
                                    <th>Gross Sales</th>
                                    <th>Refunds</th>
                                    <th>Sales Tx</th>
                                    <th>Refund Tx</th>
                                    <th>Average</th>
                                </tr>
                            </thead>
                            <tbody>
                                {#each employeeSales as employee}
                                    <tr>
                                        <td class="font-bold">{employee.employeeName}</td>
                                        <td class="text-success font-bold">{formatMoney(employee.netSales)}</td>
                                        <td>{formatMoney(employee.grossSales)}</td>
                                        <td class="text-danger">{formatMoney(employee.refunds)}</td>
                                        <td>{employee.transactions}</td>
                                        <td>{employee.refundTransactions}</td>
                                        <td>{formatMoney(employee.avgTransaction)}</td>
                                    </tr>
                                {/each}
                            </tbody>
                        </table>
                    </div>
                {/if}
            </section>
        </div>
        {:else}
            <section class="bg-bg-card border border-border-flat rounded-lg p-4 md:p-5">
                <div class="text-xs font-black uppercase tracking-[0.16em] text-accent-primary">Restricted Access</div>
                <h2 class="m-0 mt-1 text-2xl leading-tight">End Day / Z Report</h2>
                <p class="m-0 mt-2 text-sm text-text-muted">
                    This role can close a reporting period, but cannot browse sales reports, staff totals, products, or previous report ranges.
                </p>
            </section>
        {/if}

        {#if canOpenReports || canEndDay}
        <section class="report-no-print bg-bg-card border border-border-flat rounded-lg p-4 md:p-5">
            <div class="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
                <div>
                    <div class="text-xs font-black uppercase tracking-[0.16em] text-accent-primary">Close Reports</div>
                    <h3 class="m-0 mt-1 text-xl">Period close / Z reports</h3>
                    <p class="m-0 mt-1 text-sm text-text-muted">Close uses the time from the last close to now, not automatically today's calendar sales.</p>
                </div>
                <div class="flex flex-wrap gap-3">
                    <button class="btn btn-primary" disabled={!tillId || periodReportBusy} on:click={runTillDayReport}>
                        {periodReportBusy ? 'Generating...' : 'Close This Till'}
                    </button>
                    <button class="btn btn-primary" disabled={periodReportBusy} on:click={runSystemDayReport}>
                        {periodReportBusy ? 'Generating...' : 'Close Whole System'}
                    </button>
                    <button class="btn btn-secondary" disabled={!tillId || periodReportBusy} on:click={runTillFullReport}>
                        {periodReportBusy ? 'Generating...' : 'Preview This Till'}
                    </button>
                </div>
            </div>
        </section>
        {/if}
    </div>
</MgmtPage>

<!-- Till Report Modal -->
{#if showTillReport && tillReportData}
    <div class="fixed inset-0 flex items-center justify-center z-[100] bg-[var(--overlay)] p-2">
        <button type="button" class="absolute inset-0 cursor-default" aria-label="Close till report" on:click={() => showTillReport = false}></button>
        <div class="relative z-10 w-[760px] max-w-[calc(100vw-1rem)] max-h-[calc(100vh-1rem)] overflow-y-auto rounded-md bg-bg-card border border-border-flat flex flex-col">
            <div class="sticky top-0 z-10 flex justify-between items-center gap-3 border-b border-border-flat bg-bg-card p-3 md:p-4">
                <div class="min-w-0">
                    <h3 class="m-0 truncate text-lg">{tillReportTitle || `Till Report: ${tillName}`}</h3>
                    <div class="mt-1 text-xs text-text-muted">{tillReportPeriod}</div>
                </div>
                <button class="btn-icon shrink-0" aria-label="Close report preview" title="Close report preview" on:click={() => showTillReport = false}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"></path></svg>
                </button>
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
    .report-filter-bar { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: .75rem; }
    .report-filter-grid { min-width: 0; display: grid; grid-template-columns: repeat(4, minmax(150px, 1fr)); align-items: end; gap: .75rem; }
    .report-filter-grid .field { min-width: 0; }
    .report-filter-grid input { width: 100%; }
    .report-filter-actions { display: grid; grid-template-columns: repeat(3, max-content); align-items: stretch; gap: .65rem; }
    .report-filter-actions .btn { min-height: 48px; padding-inline: 1rem; }
    .report-filter-actions svg { width: 18px; height: 18px; flex: 0 0 auto; }
    .report-load-state,
    .report-filter-pending { padding: .65rem .8rem; border-left: 3px solid var(--accent-primary); background: var(--bg-panel); color: var(--text-muted); font-size: .82rem; font-weight: 750; }
    .report-filter-pending { border-left-color: var(--warning); color: var(--warning); }
    @media (max-width: 1100px) {
        .report-filter-bar { grid-template-columns: minmax(0, 1fr); }
        .report-filter-actions { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    }
    @media (max-width: 850px) {
        .report-filter-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 700px) {
        .report-filter-actions { grid-template-columns: 1fr; }
    }
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
