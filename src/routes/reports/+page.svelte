<script lang="ts">
    import { onDestroy, onMount } from 'svelte';
    import { isTauri } from '@tauri-apps/api/core';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import CustomSelect from '$lib/components/CustomSelect.svelte';
    import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
    import { formatMoney, settingsDB, storeDB } from '$lib/stores/db';
    import { toast } from '$lib/stores/toast';
    import { currentEmployee, isSupportEmployee } from '$lib/stores/session';
    import { hasPermission } from '$lib/permissions';
    import { isValidReportPeriod, requiresCoordinatedSystemCloseSession } from '$lib/reportMarkers';
    import { isMultiMode, connectionState } from '$lib/stores/connection';
    import { previousReportPeriod, reportChange, type ReportPeriod } from '$lib/reportComparison';
    import { getReceiptPrinterConfig, printEscposTextReport } from '$lib/printers';
    import { paymentExtraReportRows, cashbackRecoveryMessage } from '$lib/paymentExtraPresentation';
    import { loadDojoConfig, type DojoConfig } from '$lib/dojo';
    import { loadSumupConfig } from '$lib/sumup';
    import { getRecoverablePaymentTerminalAttempts, terminalAttemptUsesSharedJournal, type TerminalPaymentAttempt } from '$lib/terminalAttempts';
    import { runTerminalRecovery, cancelExpiredSandboxDojoPayment, type TerminalRecoveryResult } from '$lib/terminalRecovery';
    import DojoExpiryReview from '$lib/components/DojoExpiryReview.svelte';
    let showDojoExpiryReview = false;
    let dojoExpiryAttempt: TerminalPaymentAttempt | null = null;
    import {
        isReportPaymentBlocker, readableReportPaymentBlocker, reportPaymentAmount,
        reportPaymentStatus, reportPaymentRecoveryReason, canCancelExpiredTestPayment,
        verifyCancelledReportPayment, canCoordinateReportPayment, loadReportPaymentAttempts,
    } from '$lib/reportPaymentRecovery';
    import {
        getReportSnapshot,
        assertMariaDbCommerceWritesAllowed,
        withLocalTerminalPreparation,
        getReportComparisonTotals,
        type ReportComparisonTotals,
        type ReportSnapshot,
        getLastReportMarker,
        saveReportMarker,
        prepareTillReportClose,
        commitTillReportClose,
        beginWholeSystemClose,
        finishWholeSystemClose,
        abortWholeSystemClose,
        isWholeSystemCloseReleaseUnconfirmed,
        getTillPeriodReport,
        getTillName,
        getOrCreateTillId,
        type WholeSystemCloseSession,
        type SalesOverview,
        type PaymentBreakdown,
        type TopProduct,
        type TillReportOption,
        type TillSalesSummary,
        type TillPeriodReport,
        type DailySalesPoint,
        type BusinessSummary,
        type EmployeeSalesSummary,
    } from '$lib/stores/database';

    function localDateValue(date: Date) {
        const offset = date.getTimezoneOffset() * 60_000;
        return new Date(date.getTime() - offset).toISOString().split('T')[0];
    }

    function formatAccountPosition(pence: number) {
        if (pence > 0) return `Owed ${formatMoney(pence)}`;
        if (pence < 0) return `Customer credit ${formatMoney(Math.abs(pence))}`;
        return `Clear ${formatMoney(0)}`;
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
    const emptyPaymentBreakdown = (): PaymentBreakdown => ({
        totalCash: 0, totalCard: 0, totalLoyalty: 0, totalAccount: 0,
        cashTxCount: 0, cardTxCount: 0, splitTxCount: 0, loyaltyTxCount: 0, accountTxCount: 0,
        accountCharges: 0, accountRepaymentsCash: 0, accountRepaymentsCard: 0,
        accountRepaymentsOther: 0, accountAdjustments: 0,
        openingAccountOwed: 0, closingAccountOwed: 0,
        accountActivityScope: 'shop',
        totalAmount: 0, unrecordedAmount: 0, unrecordedTxCount: 0,
    });
    let breakdown: PaymentBreakdown = emptyPaymentBreakdown();
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

    let comparisonEnabled = false;
    let comparisonLoading = false;
    let comparisonError = '';
    let comparisonSequence = 0;
    let comparisonTotals: ReportComparisonTotals | null = null;
    let comparisonPeriod: ReportPeriod | null = null;
    let comparisonTarget: { startDate: string; endDate: string; till: string; source: ReportSnapshot['source'] } | null = null;

    function clearComparison() {
        comparisonSequence++;
        comparisonTotals = null;
        comparisonPeriod = null;
        comparisonLoading = false;
        comparisonError = '';
    }

    async function loadComparison() {
        const target = comparisonTarget;
        if (!comparisonEnabled || !target) return;
        clearComparison();
        const sequence = comparisonSequence;
        comparisonLoading = true;
        try {
            const period = previousReportPeriod(target.startDate, target.endDate);
            comparisonPeriod = period;
            const result = await getReportComparisonTotals(period.startDate, period.endDate, target.source, target.till || undefined);
            if (sequence !== comparisonSequence || !comparisonEnabled || comparisonTarget !== target) return;
            comparisonTotals = result;
        } catch (error) {
            if (sequence !== comparisonSequence) return;
            comparisonError = String(error).replace(/^Error:\s*/, '') || 'Could not load previous-period totals.';
        } finally {
            if (sequence === comparisonSequence) comparisonLoading = false;
        }
    }

    function toggleComparison() {
        comparisonEnabled = !comparisonEnabled;
        clearComparison();
        if (comparisonEnabled && reportReady) void loadComparison();
    }

    function comparisonLabel(current: number, previous: number): string {
        const change = reportChange(current, previous);
        if (!change) return 'Comparison unavailable';
        if (change.direction === 'unchanged') return 'No change';
        const amount = change.percent === null
            ? formatMoney(Math.abs(change.delta))
            : `${Math.abs(change.percent) < 0.1 ? '<0.1' : Math.abs(change.percent).toLocaleString('en-GB', { maximumFractionDigits: 1 })}%`;
        return `${change.direction === 'up' ? 'Up' : 'Down'} ${amount}`;
    }

    function clearReportResults() {
        overview = { totalRevenue: 0, totalTransactions: 0, refundTransactions: 0, avgTransactionValue: 0, totalItemsSold: 0 };
        breakdown = emptyPaymentBreakdown();
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
    let tillReportData: TillPeriodReport | null = null;
    let tillReportPeriod = '';
    let tillReportTitle = '';
    let closeReportTillNumber = '';
    let closeReportStart = '';
    let closeReportEnd = '';
    let closeReportExpectedMarker: string | null = null;
    let wholeSystemCloseSession: WholeSystemCloseSession | null = null;
    let closeReportText = '';
    let closeReportCanEnd = false;
    let closeReportConfirming = false;
    let closeReportSaving = false;
    let closeReportProblem = '';
    let closeReportWarning = '';
    let reportPrintBusy = false;
    let closeReportPrintBusy = false;
    let periodReportBusy = false;
    type PeriodReportAction = 'close-till' | 'close-system' | 'preview-till';
    let periodReportAction: PeriodReportAction | null = null;
    let periodReportStatus = '';
    let periodReportAbortController: AbortController | null = null;
    let periodReportCancelRequested = false;
    let periodReportFallbackRequested = false;
    let periodReportProblem = '';
    let periodReportProblemOffline = false;
    let pendingReportPayments: TerminalPaymentAttempt[] = [];
    let paymentRecoveryBusy = false;
    let paymentRecoveryLoading = false;
    let paymentRecoveryNotice = '';
    let paymentRecoveryLoadError = '';
    let paymentRecoveryVerifiedProviders = new Set<string>();
    let paymentRecoveryDisposed = false;
    let showPaymentRecovery = false;
    let paymentResultsCheckedAt = 0;
    let recoveryDojoConfig: DojoConfig | null = null;
    let showCancelTestPayment = false;
    let cancelTestPayment: TerminalPaymentAttempt | null = null;
    let paymentCancellationController: AbortController | null = null;
    let paymentCancellationEmployeeId = '';
    let activeCancellationAttempt: TerminalPaymentAttempt | null = null;
    $: canOpenReports = hasPermission($currentEmployee, 'open_reports', $settingsDB);
    $: canEndDay = hasPermission($currentEmployee, 'end_day_close', $settingsDB);
    $: periodReportWaitingOffline = periodReportAction === 'close-system'
        && /\boffline\b/i.test(periodReportStatus);
    $: activeRecoveryAdministrator = $currentEmployee?.role === 'admin' && $currentEmployee?.isActive === true
        && !isSupportEmployee($currentEmployee) && !$currentEmployee?.roleNeedsRepair && !$currentEmployee?.pinNeedsReset;
    $: sharedRecoveryConnectionReady = $connectionState.mode === 'multi'
        && $connectionState.mysqlOnline && $connectionState.mysqlReady;
    $: paymentRecoveryBlocked = periodReportBusy || showTillReport || closeReportSaving || Boolean(wholeSystemCloseSession)
        || paymentRecoveryBusy || paymentRecoveryLoading;
    $: if (!activeRecoveryAdministrator || !canCoordinateReportPayment(dojoExpiryAttempt, sharedRecoveryConnectionReady)
        || (dojoExpiryAttempt && !paymentRecoveryVerifiedProviders.has(dojoExpiryAttempt.provider))) showDojoExpiryReview = false;
    $: if (showCancelTestPayment && (!activeRecoveryAdministrator || !canCoordinateReportPayment(cancelTestPayment, sharedRecoveryConnectionReady))) {
        showCancelTestPayment = false;
        cancelTestPayment = null;
    }
    $: if (paymentCancellationController && (!activeRecoveryAdministrator || !canCoordinateReportPayment(activeCancellationAttempt, sharedRecoveryConnectionReady)
        || $currentEmployee?.id !== paymentCancellationEmployeeId
        || periodReportBusy || showTillReport || closeReportSaving || wholeSystemCloseSession)) {
        paymentCancellationController.abort();
    }

    async function refreshReportPayments(): Promise<void> {
        if (!isTauri() || paymentRecoveryDisposed || paymentRecoveryLoading) return;
        paymentRecoveryLoading = true;
        try {
            const [sumupConfig, config] = await Promise.all([
                loadSumupConfig().catch(() => null),
                loadDojoConfig().catch(() => null),
            ]);
            const [sumup, dojo] = await Promise.all([
                loadReportPaymentAttempts(includeShared => getRecoverablePaymentTerminalAttempts('sumup', { includeShared }), sumupConfig?.terminalOwnership !== 'dedicated'),
                loadReportPaymentAttempts(includeShared => getRecoverablePaymentTerminalAttempts('dojo', { includeShared }), config?.terminalOwnership !== 'dedicated'),
            ]);
            if (paymentRecoveryDisposed) return;
            pendingReportPayments = [
                ...(sumup.localVerified ? sumup.attempts : pendingReportPayments.filter(attempt => attempt.provider === 'sumup')),
                ...(dojo.localVerified ? dojo.attempts : pendingReportPayments.filter(attempt => attempt.provider === 'dojo')),
            ].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
            paymentRecoveryVerifiedProviders = new Set([
                ...(sumup.localVerified ? ['sumup'] : []), ...(dojo.localVerified ? ['dojo'] : []),
            ]);
            recoveryDojoConfig = config;
            paymentRecoveryLoadError = !sumup.localVerified || !dojo.localVerified
                ? 'Some local payment records could not be read. Other verified payments remain available below. Do not assume the missing list is empty or retry the card.'
                : sumup.sharedIncomplete || dojo.sharedIncomplete
                    ? 'Shared payment verification is incomplete because MariaDB could not be checked. Local payment records are shown below; dedicated payments can still be recovered. Reconnect before treating shared payments as resolved.'
                    : '';
        } catch {
            if (!paymentRecoveryDisposed) {
                paymentRecoveryLoadError = 'Pending payment records could not be verified. Check this till’s payment settings and connection; legacy shared payments also need MariaDB. Do not retry the card.';
                paymentResultsCheckedAt = 0;
                paymentRecoveryVerifiedProviders = new Set();
                recoveryDojoConfig = null;
            }
        } finally {
            if (!paymentRecoveryDisposed) paymentRecoveryLoading = false;
        }
    }

    function announceRecoveryCashback(result: TerminalRecoveryResult) {
        for (const cashback of result.cashbackToReview) {
            toast(cashbackRecoveryMessage(cashback), 'error', false, undefined, { persistent: true });
        }
    }

    async function checkReportPaymentResults() {
        if (paymentRecoveryBlocked || !(canEndDay || canOpenReports) || !isTauri()) return;
        paymentRecoveryBusy = true;
        paymentResultsCheckedAt = 0;
        paymentRecoveryNotice = 'Checking the saved payments with their providers…';
        showPaymentRecovery = true;
        try {
            // Each attempt retains its own lease and close-fence checks.
            // A dedicated till can recover while shop synchronization is offline.
            const result = await runTerminalRecovery();
            announceRecoveryCashback(result);
            if (paymentRecoveryDisposed) return;
            await refreshReportPayments();
            if (paymentRecoveryDisposed) return;
            if (paymentRecoveryVerifiedProviders.size > 0) paymentResultsCheckedAt = Date.now();
            paymentRecoveryNotice = result.errors.length > 0 || paymentRecoveryLoadError
                ? 'Some results could not be verified. Check the payment connection and try again. The Z-report safety check remains active.'
                : result.stillUncertain > 0 || pendingReportPayments.length > 0
                    ? 'Some payments still need confirmation. Review the entries below; do not charge the customer again.'
                    : 'No unresolved payments were found. Generate a fresh Z report to check every till and close the period.';
        } catch {
            if (!paymentRecoveryDisposed) paymentRecoveryNotice = 'Payment recovery could not run safely. Release any report close and check the payment connection. Legacy shared payments also require MariaDB. No payment record was cleared.';
        } finally {
            if (!paymentRecoveryDisposed) paymentRecoveryBusy = false;
        }
    }

    function requestCancelTestPayment(attempt: TerminalPaymentAttempt) {
        if (paymentRecoveryBlocked || !paymentRecoveryVerifiedProviders.has(attempt.provider)
            || !canCoordinateReportPayment(attempt, sharedRecoveryConnectionReady)
            || !canCancelExpiredTestPayment(attempt, recoveryDojoConfig, activeRecoveryAdministrator)) return;
        if (!paymentResultsCheckedAt || Date.now() - paymentResultsCheckedAt > 90_000) {
            paymentRecoveryNotice = 'Press Check payment results first, then review the refreshed test payment before cancelling it.';
            return;
        }
        cancelTestPayment = attempt;
        showCancelTestPayment = true;
    }

    async function confirmCancelTestPayment() {
        const attempt = cancelTestPayment;
        cancelTestPayment = null;
        if (!attempt || paymentRecoveryBlocked || !paymentRecoveryVerifiedProviders.has(attempt.provider)
            || !canCoordinateReportPayment(attempt, sharedRecoveryConnectionReady) || !activeRecoveryAdministrator || !isTauri()) return;
        if (!paymentResultsCheckedAt || Date.now() - paymentResultsCheckedAt > 90_000) {
            paymentRecoveryNotice = 'The result check is no longer fresh. Check payment results again before cancelling.';
            return;
        }
        paymentRecoveryBusy = true;
        paymentResultsCheckedAt = 0;
        showPaymentRecovery = true;
        paymentRecoveryNotice = 'Cancelling the expired sandbox payment, then automatically verifying the final result…';
        const controller = new AbortController();
        const employeeId = $currentEmployee?.id;
        const employeeVersion = $currentEmployee?.updatedAt;
        paymentCancellationEmployeeId = employeeId || '';
        activeCancellationAttempt = attempt;
        paymentCancellationController = controller;
        const canContinue = () => !paymentRecoveryDisposed && !controller.signal.aborted
            && $currentEmployee?.id === employeeId && $currentEmployee?.updatedAt === employeeVersion
            && activeRecoveryAdministrator && canCoordinateReportPayment(attempt, sharedRecoveryConnectionReady)
            && paymentRecoveryVerifiedProviders.has(attempt.provider)
            && !periodReportBusy && !showTillReport && !closeReportSaving && !wholeSystemCloseSession;
        const assertSafe = async () => {
            if (terminalAttemptUsesSharedJournal(attempt)) await assertMariaDbCommerceWritesAllowed();
            else await withLocalTerminalPreparation(async () => undefined);
            const config = await loadDojoConfig();
            if (!config.apiKeyConfigured || config.apiEnvironment.toLowerCase() !== 'sandbox') {
                throw new Error('Sandbox verification is no longer available');
            }
        };
        let cancellationConfirmed = false;
        try {
            await assertSafe();
            const config = await loadDojoConfig();
            if (!canContinue() || !canCancelExpiredTestPayment(attempt, config, activeRecoveryAdministrator)) {
                throw new Error('Sandbox cancellation is no longer available');
            }
            await cancelExpiredSandboxDojoPayment(attempt.id);
            cancellationConfirmed = true;
            const outcome = await verifyCancelledReportPayment({
                signal: controller.signal,
                canContinue,
                assertSafe,
                recover: async () => {
                    const result = await runTerminalRecovery('dojo');
                    if (canContinue()) announceRecoveryCashback(result);
                },
                refreshResolved: async () => {
                    await refreshReportPayments();
                    return paymentRecoveryVerifiedProviders.has('dojo')
                        && !pendingReportPayments.some(payment => payment.provider === 'dojo' && payment.id === attempt.id);
                },
                onSettling: () => {
                    paymentRecoveryNotice = 'Sandbox cancellation confirmed. Waiting 31 seconds for the required final confirmation, then checking automatically. Keep this page open; no second click is needed.';
                },
            });
            if (!paymentRecoveryDisposed) {
                if (outcome !== 'stopped' && paymentRecoveryVerifiedProviders.has('dojo')) paymentResultsCheckedAt = Date.now();
                paymentRecoveryNotice = outcome === 'resolved'
                    ? paymentRecoveryLoadError
                        ? 'This test payment is resolved. Other payment checks remain incomplete; review the warning below before closing the period.'
                        : pendingReportPayments.length > 0
                        ? 'This test payment is resolved. Other payments still need confirmation; review the remaining entries below.'
                        : 'Payment verification finished. No unresolved payments remain on this till. Generate a fresh Z report to check every till and close the period.'
                    : outcome === 'stopped'
                        ? 'Automatic verification stopped because the staff session, connection, or report-close state changed. The payment record stays protected. Check payment results when it is safe to continue.'
                        : 'The automatic checks finished, but this payment is still unresolved. Its record stays protected. Check the payment connection, then check payment results again; do not charge the customer again.';
            }
        } catch {
            // The provider may have captured while the dialog was open. Normal
            // reconciliation decides the outcome; cancellation never force-clears.
            if (!cancellationConfirmed && canContinue()) {
                try {
                    await assertSafe();
                    if (canContinue()) {
                        const result = await runTerminalRecovery('dojo');
                        if (canContinue()) announceRecoveryCashback(result);
                    }
                } catch { /* Keep the existing journal and offer a fresh check. */ }
            }
            if (!paymentRecoveryDisposed) {
                paymentRecoveryNotice = cancellationConfirmed
                    ? 'Sandbox cancellation was confirmed, but automatic verification could not finish safely. The payment record stays protected. Check the connection and payment results again.'
                    : 'Test cancellation could not be confirmed. The payment may have changed or the provider may be unavailable. Its record was not cleared; check payment results again.';
            }
        } finally {
            if (canContinue()) await refreshReportPayments();
            controller.abort();
            if (!paymentRecoveryDisposed) {
                paymentCancellationController = null;
                paymentCancellationEmployeeId = '';
                activeCancellationAttempt = null;
                paymentRecoveryBusy = false;
            }
        }
    }

    function paymentRecoveryTimestamp(value: string): string {
        const stamp = new Date(value);
        return Number.isFinite(stamp.getTime()) ? stamp.toLocaleString('en-GB') : 'Date needs review';
    }

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
        clearComparison();
        comparisonTarget = null;
        // Filters can still be edited while the query is running.
        const requested = { startDate, endDate, till: selectedTill, sort: sortBy };
        if (!startDate || !endDate || startDate > endDate) {
            reportError = 'Start date must be before the end date.';
            loadedReportKey = '';
            clearReportResults();
            loading = false;
            return;
        }
        loading = true;
        reportError = '';
        const till = requested.till || undefined;
        try {
            const snapshot = await withReportTimeout(
                getReportSnapshot(requested.startDate, requested.endDate, requested.sort, 10, till),
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
            reportSource = previewMode
                ? 'Browser Preview'
                : snapshot.source === 'mariadb' ? 'Live MariaDB' : 'Local SQLite';
            reportError = snapshot.warning || '';
            appliedStartDate = requested.startDate;
            appliedEndDate = requested.endDate;
            appliedTill = requested.till;
            appliedSortBy = requested.sort;
            loadedReportKey = `${requested.startDate}|${requested.endDate}|${requested.till}|${requested.sort}`;
            comparisonTarget = { ...requested, source: snapshot.source };
        } catch (error) {
            if (sequence !== loadSequence) return;
            console.error('Failed to load report:', error);
            reportError = `The report could not load: ${String(error)}`;
            loadedReportKey = '';
            clearReportResults();
        }
        lastRefreshed = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        loading = false;
        if (comparisonEnabled && loadedReportKey === `${startDate}|${endDate}|${selectedTill}|${sortBy}`) void loadComparison();
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
            ...paymentExtraReportRows(breakdown).map(([label, amount]) => [label, pounds(amount)]),
            ['Loyalty Value', pounds(breakdown.totalLoyalty), breakdown.loyaltyTxCount],
            ['Pay Later', pounds(breakdown.totalAccount), breakdown.accountTxCount],
            ['Unrecorded', pounds(breakdown.unrecordedAmount), breakdown.unrecordedTxCount],
            [],
            ['Shop Customer Accounts', 'Amount (GBP)'],
            ['Opening Account Balance', pounds(breakdown.openingAccountOwed)],
            ['New Pay Later Charges', pounds(breakdown.accountCharges)],
            ['Cash Payments Received', pounds(breakdown.accountRepaymentsCash)],
            ['Card Payments Received', pounds(breakdown.accountRepaymentsCard)],
            ...paymentExtraReportRows(breakdown, true).map(([label, amount]) => [label, pounds(amount)]),
            ['Other Payments Received', pounds(breakdown.accountRepaymentsOther)],
            ['Adjustments / Refunds', pounds(breakdown.accountAdjustments)],
            ['Closing Account Balance', pounds(breakdown.closingAccountOwed)],
            [],
            ['Till', 'Net Sales', 'Gross Sales', 'Refunds', 'Tax', 'Sales', 'Refund Transactions', 'Items', 'Cash Sales', 'Card Sales', 'Loyalty Value', 'Pay Later', 'Account Cash Collected', 'Account Card Collected', 'Account Other Collected'],
            ...visibleTillSummaries.map(till => [till.name, pounds(till.netSales), pounds(till.grossSales), pounds(till.refunds), pounds(till.taxTotal), till.transactions, till.refundTransactions, till.itemsSold, pounds(till.cashTotal), pounds(till.cardTotal), pounds(till.loyaltyTotal), pounds(till.accountTotal), pounds(till.accountRepaymentsCash), pounds(till.accountRepaymentsCard), pounds(till.accountRepaymentsOther)]),
            [],
            ['Till Card Collections', 'Scope', 'Component', 'Amount (GBP)'],
            ...visibleTillSummaries.flatMap(till => [
                ...paymentExtraReportRows(till).map(([label, amount]) => [till.name, 'Sales', label, pounds(amount)]),
                ...paymentExtraReportRows(till, true).map(([label, amount]) => [till.name, 'Account payments', label, pounds(amount)]),
            ]),
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
            ...paymentExtraReportRows(breakdown).map(([label, amount]) => `${label}: ${formatMoney(amount)}`),
            `Loyalty: ${formatMoney(breakdown.totalLoyalty)}`,
            `Pay later: ${formatMoney(breakdown.totalAccount)}`,
            ''.padEnd(32, '-'),
            'Shop customer accounts',
            `Opening account: ${formatAccountPosition(breakdown.openingAccountOwed)}`,
            `New charges: ${formatMoney(breakdown.accountCharges)}`,
            `Cash collected: ${formatMoney(breakdown.accountRepaymentsCash)}`,
            `Card collected: ${formatMoney(breakdown.accountRepaymentsCard)}`,
            ...paymentExtraReportRows(breakdown, true).map(([label, amount]) => `${label}: ${formatMoney(amount)}`),
            `Other collected: ${formatMoney(breakdown.accountRepaymentsOther)}`,
            `Adjustments: ${formatMoney(breakdown.accountAdjustments)}`,
            `Closing account: ${formatAccountPosition(breakdown.closingAccountOwed)}`,
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
        data: TillPeriodReport,
        includeTillBreakdown: boolean,
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
        ];
        if (includeTillBreakdown && data.tillSummaries.length > 0) {
            lines.push(''.padEnd(32, '-'), 'Sales by till');
            for (const till of data.tillSummaries) {
                lines.push(
                    till.name.slice(0, 32),
                    `  Net: ${formatMoney(till.netSales)}`,
                    `  Gross: ${formatMoney(till.grossSales)}`,
                    `  Sales: ${till.transactions}`,
                    `  Net items: ${till.itemsSold}`,
                    `  Card sales: ${formatMoney(till.cardTotal)}`,
                    ...paymentExtraReportRows(till).map(([label, amount]) => `  ${label}: ${formatMoney(amount)}`),
                    `  Account card (debt): ${formatMoney(till.accountRepaymentsCard)}`,
                    ...paymentExtraReportRows(till, true).map(([label, amount]) => `  Account ${label.toLowerCase()}: ${formatMoney(amount)}`),
                );
                if (till.refundTransactions > 0 || till.refunds > 0) {
                    lines.push(`  Refunds: ${formatMoney(till.refunds)} (${till.refundTransactions})`);
                }
            }
        }
        lines.push(
            ''.padEnd(32, '-'),
            `Cash: ${formatMoney(data.breakdown.totalCash)}`,
            `Card: ${formatMoney(data.breakdown.totalCard)}`,
            ...paymentExtraReportRows(data.breakdown).map(([label, amount]) => `${label}: ${formatMoney(amount)}`),
            `Loyalty: ${formatMoney(data.breakdown.totalLoyalty)}`,
            `Pay later: ${formatMoney(data.breakdown.totalAccount)}`,
            ''.padEnd(32, '-'),
            'Shop customer accounts',
            `Opening account: ${formatAccountPosition(data.breakdown.openingAccountOwed)}`,
            `New charges: ${formatMoney(data.breakdown.accountCharges)}`,
            `Cash collected: ${formatMoney(data.breakdown.accountRepaymentsCash)}`,
            `Card collected: ${formatMoney(data.breakdown.accountRepaymentsCard)}`,
            ...paymentExtraReportRows(data.breakdown, true).map(([label, amount]) => `${label}: ${formatMoney(amount)}`),
            `Other collected: ${formatMoney(data.breakdown.accountRepaymentsOther)}`,
            `Adjustments: ${formatMoney(data.breakdown.accountAdjustments)}`,
            `Closing account: ${formatAccountPosition(data.breakdown.closingAccountOwed)}`,
        );
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

    function readablePeriodReportError(error: unknown) {
        return readableReportPaymentBlocker(String(error)
            .replace(/^Error:\s*/i, '')
            .replace(/^WHOLE_SYSTEM_CLOSE_WAITING:\s*/i, '')
            .trim());
    }

    async function previewPeriodReport(scope: 'till' | 'system', closePeriod: boolean) {
        if (periodReportBusy || paymentRecoveryBusy) return;
        if (wholeSystemCloseSession) {
            periodReportProblem =
                'A previous whole-system close still owns the database lock. '
                + 'Release that close before generating another report.';
            periodReportProblemOffline = false;
            toast(periodReportProblem, 'error');
            return;
        }
        periodReportBusy = true;
        periodReportAction = scope === 'system'
            ? 'close-system'
            : closePeriod ? 'close-till' : 'preview-till';
        periodReportStatus = scope === 'system'
            ? 'Preparing the whole-system close…'
            : 'Generating the till report…';
        periodReportCancelRequested = false;
        periodReportFallbackRequested = false;
        periodReportProblem = '';
        periodReportProblemOffline = false;
        closeReportProblem = '';
        closeReportWarning = '';
        let closeAbortController: AbortController | null = null;
        let launchTillFallback = false;
        try {
            const markerTill = scope === 'system' ? '' : tillId;
            const title = scope === 'system' ? 'Whole System Period Close Report' : `${tillName} Period Close Report`;
            const strictWholeSystemClose = scope === 'system' && closePeriod;
            const coordinatedWholeSystemClose = strictWholeSystemClose && isMultiMode();
            if (coordinatedWholeSystemClose && !hasPermission($currentEmployee, 'end_day_close', $settingsDB)) {
                throw new Error('Manager permission is required to start a whole-system close');
            }

            if (coordinatedWholeSystemClose) {
                closeAbortController = new AbortController();
                periodReportAbortController = closeAbortController;
            }
            const session = coordinatedWholeSystemClose
                ? await beginWholeSystemClose({
                    signal: closeAbortController!.signal,
                    onProgress: ({ phase, message }) => {
                        if (!periodReportCancelRequested || phase === 'cancelling') {
                            periodReportStatus = message;
                        }
                    },
                })
                : null;
            // Never replace an unreleased frozen token with null. The guard at
            // the top also prevents a second preview while one is outstanding.
            if (session) wholeSystemCloseSession = session;
            periodReportStatus = 'Calculating report totals…';
            const preparedTillClose = !session && closePeriod && isMultiMode() && scope === 'till'
                ? await prepareTillReportClose(markerTill)
                : null;
            const readOptions = {
                requireAuthoritative: closePeriod && isMultiMode(),
            };
            const lastMarker = session
                ? session.expectedLastMarker
                : preparedTillClose
                    ? preparedTillClose.expectedLastMarker
                    : await getLastReportMarker(markerTill, readOptions);
            const nowStr = session?.cutoffAt
                ?? preparedTillClose?.cutoffAt
                ?? new Date().toISOString();
            const periodStart = session?.periodStart
                ?? preparedTillClose?.periodStart
                ?? lastMarker
                ?? '2000-01-01T00:00:00.000Z';
            if (!isValidReportPeriod(periodStart, nowStr)) {
                throw new Error(
                    'The report period is empty or its cutoff is not after the latest marker. '
                    + 'Check MariaDB server time and generate a fresh report.',
                );
            }
            const data = session?.report
                ?? preparedTillClose?.report
                ?? await getTillPeriodReport(markerTill, periodStart, nowStr, readOptions);
            const period = lastMarker
                ? `${new Date(lastMarker).toLocaleString('en-GB')} → ${new Date(nowStr).toLocaleString('en-GB')}`
                : `All time → ${new Date(nowStr).toLocaleString('en-GB')}`;
            tillReportData = data;
            tillReportTitle = title;
            tillReportPeriod = period;
            closeReportTillNumber = markerTill;
            closeReportStart = periodStart;
            closeReportEnd = nowStr;
            closeReportExpectedMarker = lastMarker;
            closeReportText = buildCloseReportText(title, period, data, scope === 'system');
            closeReportCanEnd = closePeriod;
            closeReportConfirming = false;
            closeReportProblem = '';
            closeReportWarning = data.warning || '';
            showTillReport = true;
        } catch (e) {
            const session = wholeSystemCloseSession;
            let sessionReleaseError: unknown = null;
            if (session) {
                try {
                    await abortWholeSystemClose(session.token);
                    if (wholeSystemCloseSession === session) wholeSystemCloseSession = null;
                } catch (releaseError) {
                    sessionReleaseError = releaseError;
                }
            }
            console.error(e);
            if (sessionReleaseError || isWholeSystemCloseReleaseUnconfirmed(e)) {
                periodReportProblem =
                    `The whole-system close lock could not be confirmed as released. `
                    + `Do not try another close until MariaDB reconnects or the lock expires. `
                    + readablePeriodReportError(sessionReleaseError || e);
                // A per-till close is safe only after coordinated cleanup was
                // confirmed. Do not offer the fallback while this lock may
                // still be active.
                periodReportProblemOffline = false;
                toast(
                    periodReportProblem,
                    'error',
                );
            } else if (periodReportCancelRequested || closeAbortController?.signal.aborted) {
                if (periodReportFallbackRequested) {
                    launchTillFallback = true;
                    toast('Whole-system close released. Opening this till’s Z report instead.', 'info');
                } else {
                    toast('Whole-system close cancelled. No reporting period was ended.', 'info');
                }
            } else {
                periodReportProblem = readablePeriodReportError(e);
                periodReportProblemOffline = /\boffline\b/i.test(periodReportProblem);
                if (isReportPaymentBlocker(periodReportProblem)) showPaymentRecovery = true;
                toast(`Failed to generate report: ${periodReportProblem}`, 'error');
            }
        } finally {
            periodReportBusy = false;
            periodReportAction = null;
            periodReportStatus = '';
            periodReportAbortController = null;
            periodReportCancelRequested = false;
            periodReportFallbackRequested = false;
            if (isReportPaymentBlocker(periodReportProblem)) void refreshReportPayments();
            if (launchTillFallback) {
                queueMicrotask(() => void runTillDayReport());
            }
        }
    }

    function cancelPeriodReportGeneration() {
        if (!periodReportBusy || periodReportAction !== 'close-system' || !periodReportAbortController) return;
        periodReportCancelRequested = true;
        periodReportStatus = 'Cancelling the whole-system close and releasing its lock…';
        periodReportAbortController.abort();
    }

    function closeThisTillInstead() {
        if (periodReportBusy) {
            if (periodReportAction !== 'close-system' || !periodReportAbortController) return;
            periodReportFallbackRequested = true;
            cancelPeriodReportGeneration();
            return;
        }
        void runTillDayReport();
    }

    function dismissPeriodReportProblem() {
        periodReportProblem = '';
        periodReportProblemOffline = false;
    }

    async function retryPendingWholeSystemCloseRelease() {
        if (periodReportBusy || closeReportSaving || !wholeSystemCloseSession) return;
        const session = wholeSystemCloseSession;
        periodReportBusy = true;
        periodReportAction = 'close-system';
        periodReportStatus = 'Releasing the previous whole-system close lock…';
        try {
            await abortWholeSystemClose(session.token);
            if (wholeSystemCloseSession === session) wholeSystemCloseSession = null;
            periodReportProblem = '';
            periodReportProblemOffline = false;
            closeReportProblem = '';
            closeReportWarning = '';
            toast('Whole-system close lock released. You can generate a new report.', 'success');
        } catch (error) {
            periodReportProblem =
                'The whole-system close lock could not be confirmed as released. '
                + readablePeriodReportError(error);
            periodReportProblemOffline = false;
            toast(periodReportProblem, 'error');
        } finally {
            periodReportBusy = false;
            periodReportAction = null;
            periodReportStatus = '';
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
        const coordinatedSession = wholeSystemCloseSession;
        if (requiresCoordinatedSystemCloseSession(isMultiMode(), closeReportTillNumber)
            && !coordinatedSession) {
            closeReportCanEnd = false;
            closeReportConfirming = false;
            closeReportProblem =
                'This whole-system snapshot no longer has a protected close session. '
                + 'Close it and generate a fresh whole-system report.';
            toast(closeReportProblem, 'error');
            return;
        }
        closeReportSaving = true;
        try {
            const markerDetails = {
                employeeId: $currentEmployee?.id || '',
                reportText: closeReportText,
                reportTotal: tillReportData.overview.totalRevenue,
            };
            let marker: any;
            if (coordinatedSession) {
                marker = await finishWholeSystemClose(coordinatedSession, markerDetails);
                if (wholeSystemCloseSession === coordinatedSession) wholeSystemCloseSession = null;
            } else if (isMultiMode() && closeReportTillNumber) {
                marker = await commitTillReportClose(
                    closeReportTillNumber,
                    closeReportExpectedMarker,
                    closeReportStart,
                    closeReportEnd,
                    markerDetails,
                );
            } else {
                marker = await saveReportMarker(closeReportTillNumber, closeReportStart, closeReportEnd, markerDetails);
            }
            let sentToOwnerApp = false;
            try {
                const { queueOwnerClosedReport } = await import('$lib/ownerCloudReporter');
                sentToOwnerApp = await queueOwnerClosedReport({
                    reportId: String(marker.id),
                    businessDate: localDateValue(new Date(closeReportEnd)),
                    periodStart: closeReportStart,
                    periodEnd: closeReportEnd,
                    scope: closeReportTillNumber ? 'till' : 'system',
                    tillId: closeReportTillNumber,
                    tillName: closeReportTillNumber ? tillName : 'Whole system',
                    closedById: $currentEmployee?.id || '',
                    closedByName: $currentEmployee?.name || 'Unknown employee',
                    reportText: closeReportText,
                    overview: tillReportData.overview,
                    breakdown: tillReportData.breakdown,
                    topProducts: tillReportData.topProducts,
                });
            } catch (error) {
                console.warn('Could not queue the owner-app end-of-day report:', error);
            }
            closeReportCanEnd = false;
            closeReportConfirming = false;
            closeReportProblem = '';
            closeReportWarning = '';
            closeReportExpectedMarker = String(marker.markerTime || closeReportEnd);
            toast(
                sentToOwnerApp
                    ? 'Report period ended and sent to the owner app'
                    : 'Report period ended. The owner-app report will send when cloud reporting reconnects.',
                sentToOwnerApp ? 'success' : 'info',
            );
        } catch (error) {
            if (coordinatedSession) {
                closeReportCanEnd = false;
                closeReportConfirming = false;
                try {
                    await abortWholeSystemClose(coordinatedSession.token);
                    if (wholeSystemCloseSession === coordinatedSession) wholeSystemCloseSession = null;
                    closeReportProblem =
                        'The app could not confirm that the whole-system period closed. '
                        + 'Its database lock was released; close this window and generate a fresh report '
                        + 'so the server’s latest marker is used.';
                } catch (abortError) {
                    console.warn('Could not immediately release the whole-system close barrier:', abortError);
                    closeReportProblem =
                        'The app could not confirm that the whole-system period closed or that its lock was released. '
                        + 'Press Close again to retry the lock release. Do not start another close yet.';
                }
            } else {
                if (isMultiMode() && closeReportTillNumber) {
                    closeReportCanEnd = false;
                    closeReportConfirming = false;
                    closeReportProblem =
                        `Could not end this till period: ${readablePeriodReportError(error)} `
                        + 'Close this window and generate a fresh till report before trying again.';
                } else {
                    closeReportProblem = `Could not end report period: ${readablePeriodReportError(error)}`;
                }
            }
            toast(closeReportProblem, 'error');
        } finally {
            closeReportSaving = false;
        }
    }

    async function closePeriodReportModal() {
        if (closeReportSaving) return;
        closeReportConfirming = false;
        if (!wholeSystemCloseSession) {
            showTillReport = false;
            closeReportProblem = '';
            closeReportWarning = '';
            return;
        }
        const session = wholeSystemCloseSession;
        closeReportSaving = true;
        try {
            await abortWholeSystemClose(session.token);
            if (wholeSystemCloseSession === session) wholeSystemCloseSession = null;
            closeReportProblem = '';
            closeReportWarning = '';
            showTillReport = false;
        } catch (error) {
            console.warn('Could not immediately release the whole-system close barrier:', error);
            closeReportCanEnd = false;
            closeReportProblem =
                'Could not confirm release of the whole-system close lock. '
                + 'Press Close again to retry. Do not generate another close until this succeeds or the lock expires.';
            toast(closeReportProblem, 'error');
        } finally {
            closeReportSaving = false;
        }
    }

    onDestroy(() => {
        paymentRecoveryDisposed = true;
        paymentCancellationController?.abort();
        loadSequence++;
        comparisonSequence++;
        periodReportAbortController?.abort();
        if (wholeSystemCloseSession) void abortWholeSystemClose(wholeSystemCloseSession.token).catch(() => undefined);
    });

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
        + Math.abs(breakdown.totalAccount)
        + Math.abs(breakdown.unrecordedAmount);
    $: cashPercent = paymentMagnitude > 0 ? Math.round((Math.abs(breakdown.totalCash) / paymentMagnitude) * 100) : 0;
    $: cardPercent = paymentMagnitude > 0 ? Math.round((Math.abs(breakdown.totalCard) / paymentMagnitude) * 100) : 0;
    $: loyaltyPercent = paymentMagnitude > 0 ? Math.round((Math.abs(breakdown.totalLoyalty) / paymentMagnitude) * 100) : 0;
    $: accountPercent = paymentMagnitude > 0 ? Math.round((Math.abs(breakdown.totalAccount) / paymentMagnitude) * 100) : 0;
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
    $: tillAccountTotal = tillTotals.reduce((sum, till) => sum + till.accountTotal, 0);
    $: tillAccountRepaymentsCash = tillTotals.reduce((sum, till) => sum + till.accountRepaymentsCash, 0);
    $: tillAccountRepaymentsCard = tillTotals.reduce((sum, till) => sum + till.accountRepaymentsCard, 0);
    $: tillAccountRepaymentsOther = tillTotals.reduce((sum, till) => sum + till.accountRepaymentsOther, 0);
    $: summaryCards = [
        { key: 'netSales', label: 'Net Sales', amount: business.netSales, value: formatMoney(business.netSales), detail: 'After refunds and discounts', featured: true },
        { key: 'grossProfit', label: 'Gross Profit', amount: business.grossProfit, value: formatMoney(business.grossProfit), detail: 'After tax and cost of goods', featured: true },
        { key: 'transactions', label: 'Sales Transactions', amount: overview.totalTransactions, value: String(overview.totalTransactions), detail: `${overview.refundTransactions} refund transactions`, featured: false },
        { key: 'average', label: 'Average Sale', amount: overview.avgTransactionValue, value: formatMoney(overview.avgTransactionValue), detail: `${overview.totalItemsSold} items sold`, featured: false },
        { key: 'grossSales', label: 'Gross Sales', amount: business.grossSales, value: formatMoney(business.grossSales), detail: 'Before refunds and discounts', featured: false },
        { key: 'refunds', label: 'Refunds', amount: business.refunds, value: formatMoney(business.refunds), detail: `${business.voidTransactions} void transactions`, featured: false },
        { key: 'discounts', label: 'Discounts', amount: business.discountTotal, value: formatMoney(business.discountTotal), detail: `Tax collected ${formatMoney(business.taxTotal)}`, featured: false },
        { key: 'cost', label: 'Cost of Goods', amount: business.costTotal, value: formatMoney(business.costTotal), detail: 'Product cost total', featured: false },
    ];
    $: displayDailyTrend = filledDailyTrend(appliedStartDate, appliedEndDate, dailyTrend);
    $: maxDailySales = Math.max(1, ...displayDailyTrend.map((day) => Math.abs(day.netSales)));
    $: currentReportKey = `${startDate}|${endDate}|${selectedTill}|${sortBy}`;
    $: reportReady = !loading && loadedReportKey === currentReportKey;
    $: filtersDirty = Boolean(loadedReportKey && loadedReportKey !== currentReportKey);
    // Restoring draft filters can make the displayed report current again.
    // Failed comparisons stay manual retries, without a reactive request loop.
    $: if (canOpenReports && comparisonEnabled && reportReady && comparisonTarget && !comparisonLoading && !comparisonTotals && !comparisonError) void loadComparison();
    $: activeDatePreset = selectedDatePreset(startDate, endDate);
    $: reconciliationDifference = business.grossSales - business.discountTotal - business.refunds - business.netSales;
    $: closeReportStartDay = closeReportStart ? localDateValue(new Date(closeReportStart)) : '';
    $: closeReportIncludesPreviousDays = Boolean(closeReportStartDay && closeReportStartDay < localDateValue(new Date()));
</script>

<DojoExpiryReview bind:show={showDojoExpiryReview} attempt={dojoExpiryAttempt} employeeId={activeRecoveryAdministrator ? $currentEmployee?.id || '' : ''}
    onSaved={checkReportPaymentResults} />
<MgmtPage title={canOpenReports ? 'Sales Reports' : 'End Day / Z Report'}>
    <div class="report-page">
        {#if canOpenReports}
        <section class="report-controls report-panel">
            <div class="report-controls-stack">
                <div class="report-controls-top">
                    <div class="min-w-0">
                        <h2 class="report-period">{reportPeriodLabel}</h2>
                        <div class="report-metadata">
                            <span class="rounded-full border border-border-flat bg-bg-panel px-3 py-1 font-bold text-text-main">{selectedTillLabel}</span>
                            <span class="rounded-full px-3 py-1 font-bold {reportSource === 'Live MariaDB' ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'}">{reportSource}</span>
                            {#if lastRefreshed}
                                <span class="rounded-full border border-border-flat bg-bg-panel px-3 py-1 text-text-muted">Updated {lastRefreshed}</span>
                            {/if}
                        </div>
                    </div>
                    <div class="report-date-presets" role="group" aria-label="Report date range">
                        <button class="btn {activeDatePreset === 'today' ? 'btn-primary' : 'btn-secondary'}" aria-pressed={activeDatePreset === 'today'} disabled={loading} on:click={() => setDatePreset('today')}>Today</button>
                        <button class="btn {activeDatePreset === 'week' ? 'btn-primary' : 'btn-secondary'}" aria-pressed={activeDatePreset === 'week'} disabled={loading} on:click={() => setDatePreset('week')}>7 Days</button>
                        <button class="btn {activeDatePreset === 'month' ? 'btn-primary' : 'btn-secondary'}" aria-pressed={activeDatePreset === 'month'} disabled={loading} on:click={() => setDatePreset('month')}>This Month</button>
                        <button class="btn {activeDatePreset === 'year' ? 'btn-primary' : 'btn-secondary'}" aria-pressed={activeDatePreset === 'year'} disabled={loading} on:click={() => setDatePreset('year')}>This Year</button>
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
            <div class="report-alert bg-warning/10 border border-warning/40 text-warning rounded-lg">
                <strong>Report warning:</strong> {reportError}
            </div>
        {/if}
        {#if reportReady && Math.abs(reconciliationDifference) > 1}
            <div class="report-alert bg-danger/10 border border-danger/40 text-danger rounded-lg">
                <strong>Totals do not reconcile:</strong>
                Gross sales minus discounts issued and customer refunds differs from net sales by {formatMoney(reconciliationDifference)}.
            </div>
        {/if}

        <section class="report-performance" aria-labelledby="performance-heading">
            <div class="report-performance-heading">
                <h2 id="performance-heading">Performance overview</h2>
                <label class="report-comparison-toggle">
                    <input type="checkbox" checked={comparisonEnabled} disabled={!comparisonEnabled && !reportReady} on:change={toggleComparison} />
                    <span>Compare previous period</span>
                </label>
            </div>
            {#if comparisonEnabled && reportReady}
                <div class="report-comparison-info" role="status">
                    {#if comparisonPeriod}
                        <span>Compared with <strong>{formatDateShort(comparisonPeriod.startDate)}{comparisonPeriod.startDate !== comparisonPeriod.endDate ? ` to ${formatDateShort(comparisonPeriod.endDate)}` : ''}</strong> · previous {comparisonPeriod.days} calendar {comparisonPeriod.days === 1 ? 'day' : 'days'} · {selectedTillLabel}</span>
                        {#if appliedStartDate > localDateValue(new Date())}<span>Selected period has not started.</span>
                        {:else if appliedEndDate >= localDateValue(new Date())}<span>Current period is still in progress.</span>{/if}
                    {/if}
                    {#if comparisonLoading}<span>Loading comparison…</span>{/if}
                    {#if comparisonError}
                        <span class="report-comparison-error">Comparison unavailable: {comparisonError}</span>
                        <button type="button" class="report-comparison-retry" on:click={loadComparison}>Retry comparison</button>
                    {/if}
                </div>
            {/if}
            <div class="report-summary">
                {#each summaryCards as card (card.key)}
                    <article class="report-metric" class:featured={card.featured} class:negative={card.amount < 0} aria-label={card.label} style={`--metric-characters: ${Math.max(1, card.value.length)}`}>
                        <div class="report-metric-label">{card.label}</div>
                        <div class="report-metric-value">{card.value}</div>
                        <div class="report-metric-detail">{card.detail}</div>
                        {#if card.featured && comparisonEnabled && reportReady && comparisonTotals}
                            {@const previous = card.key === 'netSales' ? comparisonTotals.netSales : comparisonTotals.grossProfit}
                            <div class="report-metric-comparison">
                                <span class:improved={card.amount > previous} class:declined={card.amount < previous}>{comparisonLabel(card.amount, previous)}</span>
                                <span class="report-previous-value">Previous {formatMoney(previous)}</span>
                            </div>
                        {/if}
                    </article>
                {/each}
            </div>
        </section>

        <section class="report-panel report-tills">
            <div class="report-section-heading">
                <div><h3>Sales by till</h3><p>Sales and returns for the selected period.</p></div>
                <div class="report-till-total"><span>Net total</span><strong class:negative={tillNetTotal < 0}>{formatMoney(tillNetTotal)}</strong></div>
            </div>
            {#if tillTotals.length === 0}
                <div class="report-empty">No till sales for the selected period.</div>
            {:else}
                <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users need to scroll this report region.) -->
                <div class="report-table-wrap" role="region" aria-label="Sales by till" tabindex="0">
                    <table class="tbl report-till-overview">
                        <thead><tr><th scope="col">Till</th><th scope="col">Net sales</th><th scope="col">Gross sales</th><th scope="col">Refunds</th><th scope="col">Sales</th><th scope="col">Items</th></tr></thead>
                        <tbody>
                            {#each tillTotals as till}
                                <tr><th scope="row">{till.name}</th><td class="font-bold {till.netSales < 0 ? 'text-danger' : ''}">{formatMoney(till.netSales)}</td><td>{formatMoney(till.grossSales)}</td><td>{formatMoney(till.refunds)}</td><td>{till.transactions}</td><td>{till.itemsSold}</td></tr>
                            {/each}
                        </tbody>
                        {#if tillTotals.length > 1}
                            <tfoot><tr><th scope="row">All tills</th><td class:text-danger={tillNetTotal < 0}>{formatMoney(tillNetTotal)}</td><td>{formatMoney(tillGrossTotal)}</td><td>{formatMoney(tillRefundTotal)}</td><td>{tillTransactionTotal}</td><td>{tillItemTotal}</td></tr></tfoot>
                        {/if}
                    </table>
                </div>
                <details class="report-till-details">
                    <summary>Full till breakdown <span>Payments, accounts, tax and transaction counts</span></summary>
                <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users need to scroll this report region.) -->
                <div class="report-table-wrap" role="region" aria-label="Full till breakdown" tabindex="0">
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
                                <th>Pay Later</th>
                                <th>Account Cash</th>
                                <th>Account Card</th>
                                <th>Account Other</th>
                            </tr>
                        </thead>
                        <tbody>
                            {#each tillTotals as till}
                                <tr>
                                    <td class="font-bold">{till.name}</td>
                                    <td class:text-danger={till.netSales < 0}>{formatMoney(till.netSales)}</td>
                                    <td>{formatMoney(till.grossSales)}</td>
                                    <td>{formatMoney(till.refunds)}</td>
                                    <td>{formatMoney(till.taxTotal)}</td>
                                    <td>{till.transactions}</td>
                                    <td>{till.refundTransactions}</td>
                                    <td>{till.itemsSold}</td>
                                    <td>{formatMoney(till.cashTotal)}</td>
                                    <td>{formatMoney(till.cardTotal)}</td>
                                    <td>{formatMoney(till.loyaltyTotal)}</td>
                                    <td>{formatMoney(till.accountTotal)}</td>
                                    <td>{formatMoney(till.accountRepaymentsCash)}</td>
                                    <td>{formatMoney(till.accountRepaymentsCard)}</td>
                                    <td>{formatMoney(till.accountRepaymentsOther)}</td>
                                </tr>
                                <tr>
                                    <td colspan="15" class="text-xs text-text-muted whitespace-normal">
                                        <div class="flex flex-wrap gap-x-4 gap-y-1"><strong>Sales card collections</strong>
                                            {#each paymentExtraReportRows(till) as [label, amount]}
                                                <span>{label}: <b>{formatMoney(amount)}</b></span>
                                            {/each}
                                        </div>
                                        <div class="mt-1 flex flex-wrap gap-x-4 gap-y-1"><strong>Account card collections</strong>
                                            {#each paymentExtraReportRows(till, true) as [label, amount]}
                                                <span>{label}: <b>{formatMoney(amount)}</b></span>
                                            {/each}
                                        </div>
                                    </td>
                                </tr>
                            {/each}
                            <tr class="bg-bg-panel font-extrabold">
                                <td>Total</td>
                                <td class:text-danger={tillNetTotal < 0}>{formatMoney(tillNetTotal)}</td>
                                <td>{formatMoney(tillGrossTotal)}</td>
                                <td>{formatMoney(tillRefundTotal)}</td>
                                <td>{formatMoney(tillTaxTotal)}</td>
                                <td>{tillTransactionTotal}</td>
                                <td>{tillRefundTransactionTotal}</td>
                                <td>{tillItemTotal}</td>
                                <td>{formatMoney(tillCashTotal)}</td>
                                <td>{formatMoney(tillCardTotal)}</td>
                                <td>{formatMoney(tillLoyaltyTotal)}</td>
                                <td>{formatMoney(tillAccountTotal)}</td>
                                <td>{formatMoney(tillAccountRepaymentsCash)}</td>
                                <td>{formatMoney(tillAccountRepaymentsCard)}</td>
                                <td>{formatMoney(tillAccountRepaymentsOther)}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                </details>
            {/if}
        </section>

        <div class="report-analysis-grid">
            <section class="report-panel">
                <div class="flex items-start justify-between gap-3">
                    <div>
                        <h3 class="m-0 mt-1 text-xl">Daily sales</h3>
                    </div>
                    <span class="rounded-full bg-bg-panel border border-border-flat px-3 py-1 text-xs text-text-muted">{displayDailyTrend.length} days</span>
                </div>
                {#if dailyTrend.length === 0}
                    <div class="report-empty">No daily sales for the selected period.</div>
                {:else}
                    <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users need to scroll this report region.) -->
                    <div class="report-trend-chart" role="region" aria-label="Daily sales chart" tabindex="0">
                        {#each displayDailyTrend as day}
                            <div class="report-trend-day" title={`${day.date}: ${formatMoney(day.netSales)} · ${day.transactions} transactions`}>
                                <span class="text-[10px] font-bold text-text-muted">{formatMoney(day.netSales)}</span>
                                <div class="w-full max-w-12 min-h-[3px] rounded-t {day.netSales < 0 ? 'bg-danger' : day.netSales === 0 ? 'bg-border-flat' : 'bg-accent-primary'}" style="height: {Math.max(2, (Math.abs(day.netSales) / maxDailySales) * 110)}px"></div>
                                <span class="text-[10px] text-text-muted">{new Date(`${day.date}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}</span>
                            </div>
                        {/each}
                    </div>
                {/if}
            </section>

            <section class="report-panel">
                <h3 class="m-0 mt-1 text-xl">Payment mix</h3>
                <div class="report-payment-bars">
                    <div class="grid grid-cols-[72px_1fr_44px] items-center gap-3">
                        <span class="text-sm font-bold text-text-muted">Cash</span>
                        <div class="report-payment-track bg-bg-panel rounded-md overflow-hidden border border-border-flat">
                                <div class="h-full rounded-md min-w-[2px] bg-success" style="width: {cashPercent}%"></div>
                        </div>
                        <span class="text-right text-sm font-bold">{cashPercent}%</span>
                    </div>
                    <div class="grid grid-cols-[72px_1fr_44px] items-center gap-3">
                        <span class="text-sm font-bold text-text-muted">Card</span>
                        <div class="report-payment-track bg-bg-panel rounded-md overflow-hidden border border-border-flat">
                                <div class="h-full rounded-md min-w-[2px] bg-accent-primary" style="width: {cardPercent}%"></div>
                        </div>
                        <span class="text-right text-sm font-bold">{cardPercent}%</span>
                    </div>
                    {#if breakdown.totalLoyalty !== 0}
                        <div class="grid grid-cols-[72px_1fr_44px] items-center gap-3">
                            <span class="text-sm font-bold text-text-muted">Loyalty</span>
                            <div class="report-payment-track bg-bg-panel rounded-md overflow-hidden border border-border-flat">
                                <div class="h-full rounded-md min-w-[2px] bg-warning" style="width: {Math.max(0, loyaltyPercent)}%"></div>
                            </div>
                            <span class="text-right text-sm font-bold">{loyaltyPercent}%</span>
                        </div>
                    {/if}
                    {#if breakdown.totalAccount !== 0}
                        <div class="grid grid-cols-[72px_1fr_44px] items-center gap-3">
                            <span class="text-sm font-bold text-text-muted">Pay later</span>
                            <div class="report-payment-track bg-bg-panel rounded-md overflow-hidden border border-border-flat">
                                <div class="h-full rounded-md min-w-[2px] bg-danger" style="width: {Math.max(0, accountPercent)}%"></div>
                            </div>
                            <span class="text-right text-sm font-bold">{accountPercent}%</span>
                        </div>
                    {/if}
                    {#if breakdown.unrecordedAmount !== 0}
                        <div class="grid grid-cols-[72px_1fr_44px] items-center gap-3">
                            <span class="text-sm font-bold text-text-muted">Missing</span>
                            <div class="report-payment-track bg-bg-panel rounded-md overflow-hidden border border-border-flat">
                                <div class="h-full rounded-md min-w-[2px] bg-border-flat" style="width: {unrecordedPercent}%"></div>
                            </div>
                            <span class="text-right text-sm font-bold">{unrecordedPercent}%</span>
                        </div>
                    {/if}
                </div>

                <div class="report-payment-totals">
                    <div class="rounded-lg border border-border-flat bg-bg-panel p-3">
                        <div class="text-xs font-bold text-text-muted">Cash Sales</div>
                        <div class="mt-1 font-serif text-xl font-extrabold">{formatMoney(breakdown.totalCash)}</div>
                        <div class="text-xs text-text-muted">{breakdown.cashTxCount} transactions</div>
                    </div>
                    <div class="rounded-lg border border-border-flat bg-bg-panel p-3">
                        <div class="text-xs font-bold text-text-muted">Card Sales</div>
                        <div class="mt-1 font-serif text-xl font-extrabold">{formatMoney(breakdown.totalCard)}</div>
                        <div class="text-xs text-text-muted">{breakdown.cardTxCount} transactions</div>
                    </div>
                    {#if breakdown.totalLoyalty !== 0}
                        <div class="rounded-lg border border-border-flat bg-bg-panel p-3">
                            <div class="text-xs font-bold text-text-muted">Loyalty Credit</div>
                            <div class="mt-1 font-serif text-xl font-extrabold">{formatMoney(breakdown.totalLoyalty)}</div>
                            <div class="text-xs text-text-muted">{breakdown.loyaltyTxCount} transactions</div>
                        </div>
                    {/if}
                    {#if breakdown.totalAccount !== 0}
                        <div class="rounded-lg border border-border-flat bg-bg-panel p-3">
                            <div class="text-xs font-bold text-text-muted">Pay Later Sales</div>
                            <div class="mt-1 font-serif text-xl font-extrabold">{formatMoney(breakdown.totalAccount)}</div>
                            <div class="text-xs text-text-muted">{breakdown.accountTxCount} transactions</div>
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

            <section class="report-panel">
                <h3 class="m-0 mt-1 text-xl">Sales card collections</h3>
                <p class="mt-1 text-sm text-text-muted">Card Sales above is the goods amount. Tips and service charge are recorded separately; cashback is collected on the card and paid out of the drawer, not sales revenue.</p>
                <div class="report-account-grid">
                    {#each paymentExtraReportRows(breakdown) as [label, amount]}
                        <div class="rounded-lg border border-border-flat bg-bg-panel p-3">
                            <div class="text-xs font-bold text-text-muted">{label}</div>
                            <div class="mt-1 font-serif text-xl font-extrabold">{formatMoney(amount)}</div>
                        </div>
                    {/each}
                </div>
            </section>

            <section class="report-panel report-accounts">
                <h3 class="m-0 mt-1 text-xl">Customer accounts</h3>
                <p class="mt-1 text-sm text-text-muted">This receivables statement covers the whole shop, even when a till is selected. Account payments are money collected, not new sales.</p>
                <div class="report-account-grid">
                    <div class="rounded-lg border border-border-flat bg-bg-panel p-3">
                        <div class="text-xs font-bold text-text-muted">Opening Account Position</div>
                        <div class="mt-1 font-serif text-xl font-extrabold">{formatAccountPosition(breakdown.openingAccountOwed)}</div>
                    </div>
                    <div class="rounded-lg border border-border-flat bg-bg-panel p-3">
                        <div class="text-xs font-bold text-text-muted">New Pay Later Charges</div>
                        <div class="mt-1 font-serif text-xl font-extrabold">{formatMoney(breakdown.accountCharges)}</div>
                    </div>
                    <div class="rounded-lg border border-border-flat bg-bg-panel p-3">
                        <div class="text-xs font-bold text-text-muted">Cash Collected</div>
                        <div class="mt-1 font-serif text-xl font-extrabold">{formatMoney(breakdown.accountRepaymentsCash)}</div>
                    </div>
                    <div class="rounded-lg border border-border-flat bg-bg-panel p-3">
                        <div class="text-xs font-bold text-text-muted">Card Applied to Account</div>
                        <div class="mt-1 font-serif text-xl font-extrabold">{formatMoney(breakdown.accountRepaymentsCard)}</div>
                    </div>
                    {#each paymentExtraReportRows(breakdown, true) as [label, amount]}
                        <div class="rounded-lg border border-border-flat bg-bg-panel p-3">
                            <div class="text-xs font-bold text-text-muted">{label}</div>
                            <div class="mt-1 font-serif text-xl font-extrabold">{formatMoney(amount)}</div>
                        </div>
                    {/each}
                    <div class="rounded-lg border border-border-flat bg-bg-panel p-3">
                        <div class="text-xs font-bold text-text-muted">Other Collected</div>
                        <div class="mt-1 font-serif text-xl font-extrabold">{formatMoney(breakdown.accountRepaymentsOther)}</div>
                    </div>
                    <div class="rounded-lg border border-border-flat bg-bg-panel p-3">
                        <div class="text-xs font-bold text-text-muted">Refunds / Adjustments</div>
                        <div class="mt-1 font-serif text-xl font-extrabold">{formatMoney(breakdown.accountAdjustments)}</div>
                    </div>
                    <div class="rounded-lg border border-border-flat bg-bg-panel p-3">
                        <div class="text-xs font-bold text-text-muted">Closing Account Position</div>
                        <div class="mt-1 font-serif text-xl font-extrabold">{formatAccountPosition(breakdown.closingAccountOwed)}</div>
                    </div>
                </div>
            </section>
        </div>

        <div class="report-detail-grid">
            <section class="report-panel report-products">
                <h3 class="m-0 mt-1 text-xl">Top products by {appliedSortBy === 'revenue' ? 'revenue' : 'quantity'}</h3>
                {#if topProducts.length === 0}
                    <div class="report-empty">No sales data for the selected period.</div>
                {:else}
                    <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users need to scroll this report region.) -->
                    <div class="report-table-wrap" role="region" aria-label="Top products" tabindex="0">
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

            <section class="report-panel">
                <h3 class="m-0 mt-1 text-xl">Sales by employee</h3>
                {#if employeeSales.length === 0}
                    <div class="report-empty">No employee sales for the selected period.</div>
                {:else}
                    <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users need to scroll this report region.) -->
                    <div class="report-table-wrap" role="region" aria-label="Sales by employee" tabindex="0">
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
                                        <td class:text-danger={employee.netSales < 0}>{formatMoney(employee.netSales)}</td>
                                        <td>{formatMoney(employee.grossSales)}</td>
                                        <td>{formatMoney(employee.refunds)}</td>
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
            <section class="report-panel">
                <div class="report-section-eyebrow">Restricted Access</div>
                <h2 class="m-0 mt-1 text-2xl leading-tight">End Day / Z Report</h2>
                <p class="m-0 mt-2 text-sm text-text-muted">
                    This role can close a reporting period, but cannot browse sales reports, staff totals, products, or previous report ranges.
                </p>
            </section>
        {/if}

        {#if canOpenReports || canEndDay}
        <section class="report-no-print report-panel report-close">
            <div class="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
                <div>
                    <h3 class="m-0 mt-1 text-xl">Period close / Z reports</h3>
                    <p class="m-0 mt-1 text-sm text-text-muted">Z reports close a trading period, not necessarily a calendar day. Preview (X) leaves the period open.</p>
                    <p class="m-0 mt-1 text-xs text-text-muted">Whole-system close requires every active registered till. If another till is unavailable, you can safely close only this till instead.</p>
                </div>
                <div class="flex flex-wrap gap-3">
                    <button class="btn btn-primary" disabled={!tillId || periodReportBusy || paymentRecoveryBusy} on:click={runTillDayReport}>
                        {periodReportBusy && periodReportAction === 'close-till' ? 'Generating…' : 'Close This Till'}
                    </button>
                    <button class="btn btn-primary" disabled={periodReportBusy || paymentRecoveryBusy} on:click={runSystemDayReport}>
                        {periodReportBusy && periodReportAction === 'close-system' ? 'Working…' : 'Close Whole System'}
                    </button>
                    <button class="btn btn-secondary" disabled={!tillId || periodReportBusy || paymentRecoveryBusy} on:click={runTillFullReport}>
                        {periodReportBusy && periodReportAction === 'preview-till' ? 'Generating…' : 'Preview This Till (X)'}
                    </button>
                </div>
            </div>
            <details class="mt-4 rounded-lg border border-border-flat bg-bg-card p-3 text-sm">
                <summary class="cursor-pointer font-bold">Which period does each report cover?</summary>
                <div class="mt-3 grid gap-2 text-text-muted">
                    <p class="m-0"><strong class="text-text-main">This till:</strong> starts after its last till Z close or the last whole-system Z close, whichever happened later. Closing it does not reset other tills.</p>
                    <p class="m-0"><strong class="text-text-main">Whole system:</strong> includes every till since the last whole-system Z close, including sales already shown on a till report. Confirming it sets a new starting point for every till.</p>
                    <p class="m-0">Do not add till Z reports to the whole-system total: they are different views of overlapping sales. The date filters above do not change a Z-report period. Canceling a close preview does not close anything.</p>
                </div>
            </details>
            {#if !previewMode}
                <details bind:open={showPaymentRecovery} class="mt-3 rounded-lg border border-warning/40 bg-warning/5 p-3">
                    <summary class="cursor-pointer text-sm font-bold">
                        Payment checks
                        {#if pendingReportPayments.length > 0}
                            — {pendingReportPayments.length} unresolved{pendingReportPayments.length === 1 ? ` · ${reportPaymentAmount(pendingReportPayments[0])}` : ''}
                        {/if}
                    </summary>
                    <div class="mt-3 flex flex-col gap-3">
                        <div class="flex flex-wrap items-start justify-between gap-3">
                            <p class="m-0 min-w-0 flex-1 text-xs leading-relaxed text-text-muted">
                                An unresolved payment is not an open terminal window. An expired session is not proof of failure. Check results before closing; do not charge the customer again.
                            </p>
                            <button type="button" class="btn btn-secondary shrink-0" disabled={paymentRecoveryBlocked} on:click={checkReportPaymentResults}>
                                {paymentRecoveryBusy ? 'Checking…' : 'Check payment results'}
                            </button>
                        </div>
                        {#if periodReportBusy || showTillReport || wholeSystemCloseSession || closeReportSaving}
                            <p class="m-0 text-xs text-warning">Cancel or close the report preview first. Payment recovery is unavailable until its database lock is released.</p>
                        {/if}
                        {#if paymentRecoveryNotice}
                            <p class="m-0 rounded-md bg-bg-card p-2 text-sm" role="status" aria-live="polite">{paymentRecoveryNotice}</p>
                        {/if}
                        {#if paymentRecoveryLoadError}
                            <p class="m-0 text-sm text-danger" role="alert">{paymentRecoveryLoadError}</p>
                        {/if}
                        {#each pendingReportPayments as attempt (`${attempt.provider}:${attempt.id}`)}
                            <article class="min-w-0 rounded-lg border border-border-flat bg-bg-card p-3">
                                <div class="flex flex-wrap items-center justify-between gap-2">
                                    <span class="text-base font-black">{attempt.provider === 'dojo' ? 'Dojo' : 'SumUp'} · {reportPaymentAmount(attempt)}</span>
                                    <span class="text-xs font-bold text-warning">{reportPaymentStatus(attempt.status)}</span>
                                </div>
                                <p class="m-0 mt-1 text-xs text-text-muted">
                                    {attempt.operationKind === 'refund' ? 'Refund' : attempt.operationKind === 'customer_account_payment' ? 'Customer account payment' : 'Sale'}
                                    · {paymentRecoveryTimestamp(attempt.createdAt)}
                                    · {allTills.find(till => till.id === attempt.tillId)?.name || (attempt.tillId === tillId ? tillName : 'Another / unassigned till')}
                                </p>
                                <p class="m-0 mt-2 text-xs leading-relaxed">{reportPaymentRecoveryReason(attempt)}</p>
                                {#if !canCoordinateReportPayment(attempt, sharedRecoveryConnectionReady)}
                                    <p class="m-0 mt-2 text-xs text-warning">This payment was started using shared-terminal coordination. Reconnect MariaDB to recover it; changing terminal registration does not change an existing payment.</p>
                                {/if}
                                {#if activeRecoveryAdministrator && canCoordinateReportPayment(attempt, sharedRecoveryConnectionReady) && attempt.provider === 'dojo'
                                    && ['started', 'uncertain'].includes(attempt.status) && attempt.clientTransactionId && attempt.terminalSessionId && attempt.operationKind !== 'refund' && !attempt.operatorResolution}
                                    <button type="button" class="btn btn-secondary mt-3" disabled={paymentRecoveryBlocked || !paymentResultsCheckedAt || !paymentRecoveryVerifiedProviders.has(attempt.provider)}
                                        on:click={() => { dojoExpiryAttempt = attempt; showDojoExpiryReview = true; }}>Review expired payment</button>
                                {/if}
                                {#if canCoordinateReportPayment(attempt, sharedRecoveryConnectionReady) && canCancelExpiredTestPayment(attempt, recoveryDojoConfig, activeRecoveryAdministrator)}
                                    <div class="mt-3 flex flex-wrap items-center gap-2">
                                        <button type="button" class="btn btn-secondary" disabled={paymentRecoveryBlocked || !paymentResultsCheckedAt || !paymentRecoveryVerifiedProviders.has(attempt.provider)} on:click={() => requestCancelTestPayment(attempt)}>
                                            Cancel expired test payment
                                        </button>
                                        <span class="text-xs text-text-muted">Sandbox only. Check results first.</span>
                                    </div>
                                {/if}
                            </article>
                        {/each}
                    </div>
                </details>
            {/if}
            {#if periodReportBusy && periodReportStatus}
                <div
                    class="mt-4 flex flex-col gap-3 rounded-lg border border-accent-primary/35 bg-accent-primary/10 p-3 sm:flex-row sm:items-center sm:justify-between"
                    role="status"
                    aria-live="polite"
                >
                    <div class="flex min-w-0 items-start gap-3">
                        <span class="mt-1 h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-accent-primary" aria-hidden="true"></span>
                        <div class="min-w-0">
                            <div class="text-xs font-black uppercase tracking-[0.14em] text-accent-primary">
                                {periodReportAction === 'close-system' ? 'Whole-system close' : 'Report'}
                            </div>
                            <p class="m-0 mt-1 text-sm text-text-main">{readableReportPaymentBlocker(periodReportStatus)}</p>
                            {#if isReportPaymentBlocker(periodReportStatus)}
                                <p class="m-0 mt-1 text-xs text-text-muted">A saved card payment needs a confirmed result. Cancel this close, then use Payment checks above.</p>
                            {/if}
                        </div>
                    </div>
                    {#if periodReportAction === 'close-system' && periodReportAbortController}
                        <div class="flex shrink-0 flex-wrap gap-2">
                            {#if periodReportWaitingOffline}
                                <button type="button" class="btn btn-primary" on:click={closeThisTillInstead}>
                                    Close this till instead
                                </button>
                                <a class="btn btn-secondary" href="/settings/licence">Manage tills</a>
                            {/if}
                            <button
                                type="button"
                                class="btn btn-secondary"
                                disabled={periodReportCancelRequested}
                                on:click={cancelPeriodReportGeneration}
                            >
                                {periodReportCancelRequested ? 'Cancelling…' : 'Cancel'}
                            </button>
                        </div>
                    {/if}
                </div>
            {/if}
            {#if !periodReportBusy && periodReportProblem}
                <div class="mt-4 flex flex-col gap-3 rounded-lg border border-danger/40 bg-danger/10 p-3 sm:flex-row sm:items-center sm:justify-between" role="alert">
                    <div class="min-w-0">
                        <div class="text-xs font-black uppercase tracking-[0.14em] text-danger">Z report was not closed</div>
                        <p class="m-0 mt-1 text-sm text-text-main">{periodReportProblem}</p>
                        {#if isReportPaymentBlocker(periodReportProblem)}
                            <p class="m-0 mt-1 text-xs text-text-muted">No reporting period was closed. Use Payment checks above to confirm the payment outcome safely.</p>
                        {/if}
                    </div>
                    <div class="flex shrink-0 flex-wrap gap-2">
                        {#if wholeSystemCloseSession}
                            <button type="button" class="btn btn-primary" on:click={retryPendingWholeSystemCloseRelease}>
                                Retry lock release
                            </button>
                        {:else if periodReportProblemOffline && tillId}
                            <button type="button" class="btn btn-primary" on:click={closeThisTillInstead}>
                                Close this till instead
                            </button>
                            <a class="btn btn-secondary" href="/settings/licence">Manage tills</a>
                        {/if}
                        {#if !wholeSystemCloseSession}
                            <button type="button" class="btn btn-secondary" on:click={dismissPeriodReportProblem}>Dismiss</button>
                        {/if}
                    </div>
                </div>
            {/if}
        </section>
        {/if}
    </div>
</MgmtPage>

<!-- Till Report Modal -->
{#if showTillReport && tillReportData}
    <div class="fixed inset-0 flex items-center justify-center z-[100] bg-[var(--overlay)] p-2">
        <button type="button" class="absolute inset-0 cursor-default" aria-label="Close till report" on:click={closePeriodReportModal}></button>
        <div class="relative z-10 w-[760px] max-w-[calc(100vw-1rem)] max-h-[calc(100vh-1rem)] overflow-y-auto rounded-md bg-bg-card border border-border-flat flex flex-col">
            <div class="sticky top-0 z-10 flex justify-between items-center gap-3 border-b border-border-flat bg-bg-card p-3 md:p-4">
                <div class="min-w-0">
                    <h3 class="m-0 truncate text-lg">{tillReportTitle || `Till Report: ${tillName}`}</h3>
                    <div class="mt-1 text-xs text-text-muted">{tillReportPeriod}</div>
                </div>
                <button class="btn-icon shrink-0" disabled={closeReportSaving} aria-label="Close report preview" title="Close report preview" on:click={closePeriodReportModal}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"></path></svg>
                </button>
            </div>
            <div class="flex flex-col gap-3 p-3 md:p-4">
            {#if closeReportProblem}
                <div class="rounded-lg border border-danger/50 bg-danger/10 p-3 text-sm text-danger" role="alert">
                    <div class="font-bold">This report cannot close</div>
                    <p class="m-0 mt-1">{closeReportProblem}</p>
                    {#if isReportPaymentBlocker(closeReportProblem)}
                        <p class="m-0 mt-1 text-xs">Close this preview, then use Payment checks on the reports page. An unresolved payment must be confirmed before its period can close.</p>
                    {/if}
                </div>
            {/if}
            {#if closeReportWarning}
                <div class="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning" role="status">
                    <div class="font-bold">Local preview</div>
                    <p class="m-0 mt-1">{closeReportWarning}</p>
                </div>
            {/if}
            {#if closeReportIncludesPreviousDays}
                <div class="rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
                    This period started before today, so the total can include previous days.
                </div>
            {/if}
            {#if closeReportCanEnd}
                <div class="rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
                    {#if wholeSystemCloseSession}
                        Whole-system financial writes are paused while this frozen snapshot is open. Press <strong>Close Period</strong> to save it, or close this window to release the pause. This is the consolidated store total; do not add separate till Z totals to it.
                    {:else}
                        This is only a preview. Press <strong>Close Period</strong> to close this report period and make the next report start from now.
                    {/if}
                </div>
                {#if !hasPermission($currentEmployee, 'end_day_close', $settingsDB)}
                    <div class="rounded-lg border border-danger/40 bg-danger/10 p-3 text-xs text-danger">
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

            {#if !closeReportTillNumber && tillReportData.tillSummaries.length > 0}
                <section class="rounded-lg border border-border-flat bg-bg-panel p-3" aria-labelledby="close-sales-by-till-heading">
                    <div class="flex items-start justify-between gap-3">
                        <div>
                            <div id="close-sales-by-till-heading" class="text-[0.65rem] font-black uppercase tracking-[0.14em] text-text-muted">Sales by till</div>
                            <p class="m-0 mt-1 text-xs text-text-muted">Net sales and net items include returns.</p>
                        </div>
                        <div class="shrink-0 rounded-full border border-border-flat bg-bg-card px-2 py-1 text-[0.65rem] font-bold text-text-muted">
                            {tillReportData.tillSummaries.length} {tillReportData.tillSummaries.length === 1 ? 'till' : 'tills'}
                        </div>
                    </div>
                    <div class="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
                        {#each tillReportData.tillSummaries as till}
                            <article class="min-w-0 rounded-lg border border-border-flat bg-bg-card p-3">
                                <div class="truncate text-sm font-extrabold text-text-main" title={till.name}>{till.name}</div>
                                <div class="mt-2 grid grid-cols-2 gap-x-3 gap-y-2">
                                    <div class="min-w-0">
                                        <div class="text-[0.62rem] font-semibold uppercase tracking-wide text-text-muted">Net sales</div>
                                        <div class="truncate text-base font-extrabold font-serif text-success">{formatMoney(till.netSales)}</div>
                                    </div>
                                    <div class="min-w-0">
                                        <div class="text-[0.62rem] font-semibold uppercase tracking-wide text-text-muted">Gross sales</div>
                                        <div class="truncate text-base font-extrabold font-serif text-text-main">{formatMoney(till.grossSales)}</div>
                                    </div>
                                    <div>
                                        <div class="text-[0.62rem] font-semibold uppercase tracking-wide text-text-muted">Sales</div>
                                        <div class="text-sm font-extrabold text-accent-primary">{till.transactions}</div>
                                    </div>
                                    <div>
                                        <div class="text-[0.62rem] font-semibold uppercase tracking-wide text-text-muted">Net items</div>
                                        <div class="text-sm font-extrabold text-text-main">{till.itemsSold}</div>
                                    </div>
                                </div>
                                {#if till.refundTransactions > 0 || till.refunds > 0}
                                    <div class="mt-2 border-t border-border-flat pt-2 text-xs text-danger">
                                        {till.refundTransactions} {till.refundTransactions === 1 ? 'refund' : 'refunds'} · {formatMoney(till.refunds)}
                                    </div>
                                {/if}
                                <details class="mt-2 border-t border-border-flat pt-2 text-xs">
                                    <summary>Card collections and cashback</summary>
                                    <div class="mt-2 font-bold">Sales</div>
                                    {#each paymentExtraReportRows(till) as [label, amount]}
                                        <div class="flex justify-between gap-2"><span>{label}</span><b>{formatMoney(amount)}</b></div>
                                    {/each}
                                    <div class="mt-2 font-bold">Account payments</div>
                                    {#each paymentExtraReportRows(till, true) as [label, amount]}
                                        <div class="flex justify-between gap-2"><span>{label}</span><b>{formatMoney(amount)}</b></div>
                                    {/each}
                                </details>
                            </article>
                        {/each}
                    </div>
                </section>
            {/if}

            <!-- Payment breakdown -->
            <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
                <div class="bg-bg-panel border border-border-flat rounded-lg p-3 flex flex-col gap-0.5">
                    <div class="text-xs font-semibold text-text-muted">Cash</div>
                    <div class="text-lg font-extrabold font-serif text-success">{formatMoney(tillReportData.breakdown.totalCash)}</div>
                    <div class="text-[0.7rem] text-text-muted">{tillReportData.breakdown.cashTxCount} tx</div>
                </div>
                <div class="bg-bg-panel border border-border-flat rounded-lg p-3 flex flex-col gap-0.5">
                    <div class="text-xs font-semibold text-text-muted">Pay Later</div>
                    <div class="text-lg font-extrabold font-serif text-warning">{formatMoney(tillReportData.breakdown.totalAccount)}</div>
                    <div class="text-[0.7rem] text-text-muted">{tillReportData.breakdown.accountTxCount} tx</div>
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

            <div class="rounded-lg border border-border-flat bg-bg-panel p-3">
                <div class="text-[0.65rem] font-black uppercase tracking-[0.14em] text-text-muted">Sales card collections</div>
                <div class="mt-2 grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
                    {#each paymentExtraReportRows(tillReportData.breakdown) as [label, amount]}
                        <span>{label} <b class="block">{formatMoney(amount)}</b></span>
                    {/each}
                </div>
                <p class="mt-2 mb-0 text-xs text-text-muted">Extras are separate from goods revenue. Cashback is a drawer payout, not change.</p>
            </div>

            <div class="rounded-lg border border-warning/40 bg-warning/10 p-3">
                <div class="text-[0.65rem] font-black uppercase tracking-[0.14em] text-warning">Shop Customer Accounts</div>
                <div class="mt-2 grid grid-cols-2 md:grid-cols-3 gap-2 text-sm">
                    <span>Opening account <b class="block">{formatAccountPosition(tillReportData.breakdown.openingAccountOwed)}</b></span>
                    <span>New charges <b class="block">{formatMoney(tillReportData.breakdown.accountCharges)}</b></span>
                    <span>Cash collected <b class="block text-success">{formatMoney(tillReportData.breakdown.accountRepaymentsCash)}</b></span>
                    <span>Card applied to account <b class="block text-accent-primary">{formatMoney(tillReportData.breakdown.accountRepaymentsCard)}</b></span>
                    {#each paymentExtraReportRows(tillReportData.breakdown, true) as [label, amount]}
                        <span>{label} <b class="block">{formatMoney(amount)}</b></span>
                    {/each}
                    <span>Other collected <b class="block">{formatMoney(tillReportData.breakdown.accountRepaymentsOther)}</b></span>
                    <span>Adjustments <b class="block">{formatMoney(tillReportData.breakdown.accountAdjustments)}</b></span>
                    <span>Closing account <b class="block text-warning">{formatAccountPosition(tillReportData.breakdown.closingAccountOwed)}</b></span>
                </div>
            </div>

            <div class="rounded-lg border border-border-flat bg-bg-panel p-3">
                <div class="mb-1.5 text-[0.65rem] font-black uppercase tracking-[0.14em] text-text-muted">Receipt report text</div>
                <pre class="whitespace-pre-wrap rounded-lg bg-bg-card p-2 font-mono text-xs leading-relaxed">{closeReportText}</pre>
            </div>

            {#if closeReportConfirming}
                <div class="rounded-lg border border-danger/50 bg-danger/10 p-3">
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
                <button class="btn btn-primary" disabled={closeReportSaving} on:click={closePeriodReportModal}>
                    {closeReportSaving && wholeSystemCloseSession ? 'Releasing…' : 'Close'}
                </button>
            </div>
        </div>
    </div>
{/if}

<ConfirmDialog
    bind:show={showCancelTestPayment}
    title="Cancel expired sandbox payment?"
    message={`This is only for the expired Dojo test payment ${cancelTestPayment ? reportPaymentAmount(cancelTestPayment) : ''}. The app will ask Dojo to cancel the uncaptured sandbox intent and verify the result. It will not force-clear the payment record, refund a captured payment, or override a live card payment. Continue?`}
    confirmText="Cancel test payment"
    cancelText="Keep payment"
    variant="danger"
    on:confirm={confirmCancelTestPayment}
    on:cancel={() => cancelTestPayment = null}
/>

<style>
    .report-page { --report-control-height: 44px; --report-surface: color-mix(in srgb, var(--bg-base) 55%, var(--bg-card)); --report-divider: color-mix(in srgb, var(--border-flat) 55%, transparent); height: 100%; min-width: 0; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 12px; font-variant-numeric: tabular-nums; }
    :global(.back-office-route) .report-page { --report-control-height: 36px; }
    .report-page > * { flex-shrink: 0; min-width: 0; }
    .report-panel { min-width: 0; padding: 14px; border: 1px solid var(--report-divider); border-radius: 8px; background: var(--report-surface); }
    .report-panel h3 { margin: 0; font-weight: 600; font-size: 1rem; line-height: 1.35; }
    .report-panel p { margin: 4px 0 0; font-size: .78rem; line-height: 1.5; color: var(--text-muted); }
    .report-controls-stack { display: flex; flex-direction: column; gap: 12px; }
    .report-controls-top { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px 16px; }
    .report-period { margin: 0; font-weight: 600; font-size: 1.25rem; line-height: 1.3; }
    .report-metadata { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; margin-top: 6px; font-size: .68rem; }
    .report-metadata > span { padding: 2px 7px; font-weight: 450; border-color: transparent; background: transparent; }
    .report-page :global(.btn) { min-width: 0; min-height: var(--report-control-height); padding: 6px 10px; gap: 6px; font-size: .78rem; font-weight: 550; border-radius: 5px; box-shadow: none; }
    .report-date-presets { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 3px; padding: 3px; border: 1px solid var(--border-flat); border-radius: 7px; background: var(--bg-panel); }
    .report-date-presets .btn { white-space: nowrap; border-color: transparent; }
    .report-date-presets .btn-secondary { background: transparent; }
    .report-filter-bar { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 10px; }
    .report-filter-grid { min-width: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); align-items: end; gap: 10px; }
    .report-filter-grid .field { min-width: 0; gap: 4px; }
    .report-filter-grid :global(.relative) { gap: 4px; }
    .report-filter-grid label, .report-filter-grid :global(.relative > span) { min-height: 17px; font-size: .68rem; line-height: 17px; font-weight: 500; letter-spacing: 0; text-transform: none; }
    .report-filter-grid input, .report-filter-grid :global(.custom-select-trigger) { width: 100%; min-width: 0; height: var(--report-control-height); min-height: var(--report-control-height); padding: 6px 9px; font-size: .8rem; border-radius: 5px; box-shadow: none; }
    .report-filter-actions { display: flex; align-items: stretch; gap: 6px; }
    .report-filter-actions .btn { white-space: nowrap; }
    .report-filter-actions svg { width: 15px; height: 15px; flex: 0 0 auto; }
    .report-alert { padding: 9px 12px; font-size: .8rem; line-height: 1.4; }
    .report-performance { min-width: 0; }
    .report-performance-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 4px 12px; margin-bottom: 5px; }
    .report-performance-heading h2 { margin: 0; font-size: .85rem; font-weight: 550; }
    .report-comparison-toggle { display: inline-flex; align-items: center; gap: 7px; min-height: var(--report-control-height); color: var(--text-muted); font-size: .75rem; font-weight: 450; cursor: pointer; }
    .report-comparison-toggle input { width: 15px; height: 15px; min-height: 15px; margin: 0; accent-color: var(--accent-primary); cursor: pointer; }
    .report-comparison-toggle:has(input:checked) { color: var(--text-main); }
    .report-comparison-toggle:has(input:disabled) { opacity: .55; cursor: not-allowed; }
    .report-comparison-info { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 12px; padding: 0 0 10px; color: var(--text-muted); font-size: .72rem; line-height: 1.5; }
    .report-comparison-info strong { font-weight: 550; color: var(--text-main); }
    .report-comparison-error { color: var(--warning); }
    .report-comparison-retry { padding: 4px 0; min-height: var(--report-control-height); border: 0; background: transparent; color: var(--accent-primary); text-decoration: underline; cursor: pointer; }
    .report-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; padding: 5px; background: var(--report-surface); border: 1px solid var(--report-divider); border-radius: 8px; }
    .report-metric { container-type: inline-size; min-width: 0; padding: 11px 13px; border: 1px solid transparent; border-radius: 5px; background: transparent; }
    .report-metric.featured { --metric-max-font: 1.5rem; border-left: 2px solid color-mix(in srgb, var(--success) 65%, transparent); background: color-mix(in srgb, var(--success) 6%, var(--report-surface)); }
    .report-metric-label { color: var(--text-muted); font-size: .73rem; font-weight: 450; letter-spacing: 0; }
    .report-metric-value { margin-top: 5px; font-size: min(var(--metric-max-font, 1.2rem), calc(100cqw / var(--metric-characters) * 1.45)); font-weight: 550; line-height: 1.25; white-space: nowrap; }
    .report-metric.featured .report-metric-value { color: var(--success); font-weight: 650; }
    .report-metric.featured .report-metric-label { color: var(--text-main); font-weight: 550; }
    .report-metric.negative .report-metric-value, .report-till-total strong.negative { color: var(--danger); }
    .report-metric.featured.negative { border-left-color: var(--danger); background: color-mix(in srgb, var(--danger) 5%, var(--report-surface)); }
    .report-metric-comparison { display: flex; flex-wrap: wrap; align-items: baseline; gap: 3px 9px; margin-top: 9px; font-size: .68rem; line-height: 1.5; }
    .report-metric-comparison .improved { color: var(--success); }
    .report-metric-comparison .declined { color: var(--danger); }
    .report-previous-value { color: var(--text-muted); overflow-wrap: anywhere; }
    .report-metric-detail { margin-top: 3px; font-size: .68rem; line-height: 1.35; color: var(--text-muted); }
    .report-section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .report-section-eyebrow { margin-bottom: 4px; color: var(--text-muted); font-size: .65rem; font-weight: 800; text-transform: uppercase; letter-spacing: .07em; }
    .report-till-total { flex-shrink: 0; display: flex; align-items: baseline; flex-wrap: wrap; justify-content: end; gap: 8px; }
    .report-till-total span { color: var(--text-muted); font-size: .7rem; }
    .report-till-total strong { font-weight: 600; font-size: 1.15rem; overflow-wrap: anywhere; }
    .report-table-wrap { max-width: 100%; overflow-x: auto; margin-top: 10px; border: 1px solid var(--report-divider); border-radius: 6px; }
    .report-table-wrap:focus-visible, .report-trend-chart:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 2px; }
    .report-table-wrap .tbl { width: 100%; font-size: .78rem; }
    .report-table-wrap :is(th, td) { height: auto; padding: 7px 10px; font-size: .78rem; font-weight: 400; border-color: var(--report-divider); line-height: 1.4; text-align: right; white-space: nowrap; }
    .report-table-wrap thead th { font-size: .7rem; font-weight: 500; letter-spacing: 0; text-transform: none; color: var(--text-muted); background: color-mix(in srgb, var(--bg-panel) 60%, transparent); }
    .report-table-wrap :is(th, td):first-child { text-align: left; }
    .report-table-wrap tbody th { text-transform: none; letter-spacing: normal; font-weight: 500; color: var(--text-main); background: transparent; }
    .report-table-wrap tfoot { background: color-mix(in srgb, var(--bg-panel) 60%, transparent); }
    .report-table-wrap tfoot :is(th, td) { font-weight: 550; }
    .report-till-overview { min-width: 570px; }
    .report-till-overview :is(th, td):first-child { white-space: normal; min-width: 130px; max-width: 260px; overflow-wrap: anywhere; }
    .report-products :is(th, td):nth-child(2), .report-products :is(th, td):nth-child(3) { text-align: left; }
    .report-till-details { margin-top: 8px; }
    .report-till-details summary { min-height: var(--report-control-height); padding: 6px 0; align-content: center; font-size: .76rem; font-weight: 500; cursor: pointer; color: var(--accent-primary); }
    .report-till-details summary span { margin-left: 8px; font-size: .7rem; font-weight: 400; color: var(--text-muted); }
    .report-till-details summary:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 2px; border-radius: 3px; }
    .report-till-details .report-table-wrap { margin-top: 0; }
    .report-analysis-grid, .report-detail-grid { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); align-items: start; gap: 12px; }
    .report-accounts { grid-column: 1 / -1; }
    .report-empty { margin-top: 10px; padding: 18px 10px; text-align: center; color: var(--text-muted); font-size: .8rem; border: 1px dashed var(--border-flat); border-radius: 5px; }
    .report-trend-chart { display: flex; align-items: end; gap: 8px; height: 158px; margin-top: 10px; overflow-x: auto; padding-bottom: 5px; }
    .report-trend-day { min-width: max-content; flex: 1 0 64px; padding-inline: 4px; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: end; gap: 6px; }
    .report-trend-day > div { flex-shrink: 0; }
    .report-payment-bars { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
    .report-payment-bars > div { gap: 8px; }
    .report-payment-bars span { font-size: .76rem; font-weight: 450; }
    .report-payment-track > div { opacity: .75; }
    .report-payment-track { height: 14px; }
    .report-payment-totals { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 12px; }
    .report-account-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-top: 12px; }
    .report-payment-totals > div, .report-account-grid > div { min-width: 0; padding: 9px 10px; border: 0; border-left: 1px solid var(--report-divider); border-radius: 0; background: transparent; }
    .report-payment-totals :global(.text-xl), .report-account-grid :global(.text-xl) { font-size: 1rem; font-weight: 500; line-height: 1.35; overflow-wrap: anywhere; }
    .report-payment-totals :global(.text-xs), .report-account-grid :global(.text-xs) { font-size: .7rem; font-weight: 450; }
    .report-close > div:first-child { gap: 12px; }
    .report-close > div:first-child > div:last-child { flex-shrink: 0; gap: 6px; }
    .report-load-state, .report-filter-pending { padding: 7px 10px; border-left: 3px solid var(--accent-primary); background: var(--bg-panel); color: var(--text-muted); font-size: .76rem; }
    .report-filter-pending { border-left-color: var(--warning); color: var(--warning); }
    @container management (max-width: 1000px) {
        .report-filter-bar { grid-template-columns: minmax(0, 1fr); }
        .report-filter-actions { justify-content: end; }
        .report-account-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    }
    @container management (max-width: 720px) {
        .report-page { padding: 10px; gap: 10px; }
        .report-filter-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .report-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .report-analysis-grid, .report-detail-grid { grid-template-columns: minmax(0, 1fr); }
        .report-account-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .report-accounts { grid-column: auto; }
    }
    @container management (max-width: 440px) {
        .report-panel { padding: 12px; }
        .report-period { font-size: 1.1rem; }
        .report-date-presets { width: 100%; }
        .report-date-presets .btn { padding-inline: 5px; font-size: .72rem; }
        .report-filter-actions { display: grid; grid-template-columns: 1fr 1fr; }
        .report-filter-actions .btn:first-child { grid-column: 1 / -1; }
        .report-metric { padding: 10px; }
        .report-metric { --metric-max-font: 1.1rem; }
        .report-metric.featured { --metric-max-font: 1.3rem; }
        .report-till-details summary span { display: block; margin: 3px 0 0; }
        .report-section-heading { align-items: start; flex-direction: column; gap: 5px; }
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
