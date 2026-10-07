<script lang="ts">
    import { onDestroy, onMount } from 'svelte';
    import { isTauri } from '@tauri-apps/api/core';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import Modal from '$lib/components/Modal.svelte';
    import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
    import Code39Barcode from '$lib/components/Code39Barcode.svelte';
    import SearchField from '$lib/components/SearchField.svelte';
    import {
        customersDB,
        settingsDB,
        storeDB,
        type Customer,
        type CustomerAccount,
        type CustomerAccountEntry,
        type CustomerAccountPaymentMethod,
        uuid,
        now,
        formatMoney,
        toPence,
    } from '$lib/stores/db';
    import {
        adjustCustomerLoyalty,
        getCustomerAccount,
        getCustomerAccountEntries,
        getCustomerLoyaltySnapshot,
        getCustomersPage,
        getCustomerUsage,
        getOrCreateTillId,
        isCustomerLoyaltyCodeInUse,
        postCustomerAccountEntry,
        removeCustomerSafely,
        saveCustomerAccountConfig,
        saveCustomerProfile,
        POS_CUSTOMERS_CHANGED_EVENT,
        type CustomerLoyaltyHistoryRow,
    } from '$lib/stores/database';
    import { toast } from '$lib/stores/toast';
    import { currentEmployee, currentShiftId } from '$lib/stores/session';
    import { hasPermission } from '$lib/permissions';
    import { deviceOperatingMode } from '$lib/deviceMode';
    import { createLoyaltyCode, getLoyaltyConfig, loyaltyCredit } from '$lib/loyalty';
    import { getCashDrawerConfig, openCashDrawer } from '$lib/cashDrawer';
    import { getReceiptPrinterConfig, printEscposTextReport } from '$lib/printers';
    import { requireManualSaleAccess } from '$lib/licensing';
    import {
        acquireSumupLock,
        createSumupCheckout,
        delay,
        getSumupReaderStatus,
        getSumupTransactionStatus,
        loadSumupConfig,
        refreshSumupLock,
        releaseSumupLock,
        saveSumupAttempt,
        sumupConfig as sumupConfigStore,
        sumupTerminalKey,
        terminateSumupCheckout,
        updateSumupAttempt,
        type SumupPaymentAttempt,
    } from '$lib/sumup';
    import {
        acquireDojoLock,
        cancelDojoTerminalSession,
        createDojoPayment,
        dojoConfig as dojoConfigStore,
        dojoTerminalKey,
        getDojoPaymentIntentStatus,
        getDojoTerminalSessionStatus,
        loadDojoConfig,
        refreshDojoLock,
        releaseDojoLock,
        respondToDojoSignature,
        saveDojoAttempt,
        updateDojoAttempt,
        type DojoPaymentAttempt,
    } from '$lib/dojo';
    import { monitorDojoSession } from '$lib/dojoSessionFlow';
    import { retryDojoPayment } from '$lib/dojo';
    import DojoRetryDialog from '$lib/components/DojoRetryDialog.svelte';
    let dojoRetryDecision: ((retry: boolean) => void) | null = null;
    import { getDojoPaymentBreakdown } from '$lib/dojoPaymentValidation';
    import { accountPaymentAmountLines } from '$lib/paymentExtraPresentation';
    import {
        assertPaymentTerminalAttemptReady,
        isCustomerAccountPaymentPayload,
        type CustomerAccountPaymentAttemptPayload,
        type TerminalProvider,
    } from '$lib/terminalAttempts';
    import {
        LOYALTY_CODE_MAX_LENGTH,
        loyaltyCodeValidationError,
        normalizeLoyaltyCode,
    } from '$lib/customerLoyaltyCode';
    import {
        customerLoyaltyAdjustmentPreview,
        customerLoyaltyReasonError,
        newestCustomerSnapshot,
        manualLoyaltyReasonNote,
        MAX_CUSTOMER_LOYALTY_REASON_LENGTH,
        type CustomerLoyaltyAdjustmentMode,
    } from '$lib/customerLoyaltyAdjustment';

    const PAGE_SIZE = 40;
    const ACCOUNT_HISTORY_PAGE_SIZE = 50;
    type CustomerAccountListView = 'all' | 'outstanding';
    let showForm = false;
    let editing = false;
    let saving = false;
    let deletingCustomerId = '';
    let showDeleteConfirm = false;
    let customerToDelete: Customer | null = null;
    let showDojoSignatureConfirm = false;
    let dojoSignatureDecision: ((accepted: boolean) => void) | null = null;
    let cur: Partial<Customer> = {};
    let editingCustomer: Customer | null = null;
    let searchQuery = '';
    let appliedSearchQuery = '';
    let currentPage = 1;
    let pageCustomers: Customer[] = [];
    let totalCustomers = 0;
    let allCustomerCount = 0;
    let outstandingCustomerCount = 0;
    let outstandingBalancePence = 0;
    let customerAccountListView: CustomerAccountListView = 'all';
    let customersLoading = false;
    let customersLoadError = '';
    let customersMounted = false;
    let customersLoadToken = 0;
    let customerRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    let customerListStoreState = new Map<string, unknown[]>();
    let showLoyalty = false;
    let loyaltyCustomerId = '';
    let loyaltyCustomer: Customer | null = null;
    let loyaltyCustomerSnapshot: Customer | null = null;
    let loyaltyHistory: CustomerLoyaltyHistoryRow[] = [];
    let loyaltyHistoryLoading = false;
    let loyaltyHistoryError = '';
    let loyaltyHistoryRun = 0;
    let loyaltyView: 'history' | 'adjust' = 'history';
    let loyaltyAdjustmentMode: CustomerLoyaltyAdjustmentMode = 'add';
    let loyaltyPointsDraft = '';
    let loyaltyReasonDraft = '';
    let loyaltyAdjustmentSaving = false;
    let loyaltyAdjustmentAttempted = false;
    let loyaltyAdjustmentIdempotencyKey = '';
    let showAccount = false;
    let accountCustomerId = '';
    let accountCustomer: Customer | null = null;
    let accountCustomerSnapshot: Customer | null = null;
    let customerAccount: CustomerAccount | null = null;
    let accountEntries: CustomerAccountEntry[] = [];
    let accountEntryTotal = 0;
    let accountLoading = false;
    let accountHistoryLoadingMore = false;
    let accountHistoryLoadRun = 0;
    let accountLoadToken = 0;
    let accountSaving = false;
    let accountEnabledDraft = false;
    let accountLimitDraft = '';
    let showAccountEntry = false;
    let accountEntryMode: 'payment' | 'opening' | 'increase' | 'reduce' = 'payment';
    let accountAmountDraft = '';
    let accountPaymentMethod: Exclude<CustomerAccountPaymentMethod, ''> = 'cash';
    let accountReferenceDraft = '';
    let accountReasonDraft = '';
    let accountEntryIdempotencyKey = '';
    let accountExternalCardConfirmed = false;
    let accountManagedCardApproved = false;
    let accountManagedAttemptProvider: TerminalProvider | '' = '';
    let accountManagedReportEpoch: string | undefined;
    let accountManagedServerDataEpoch: string | undefined;
    let accountManagedCardExtras = { tipsAmount: 0, serviceChargeAmount: 0, cashbackAmount: 0 };
    let accountTerminalStatus = '';
    let accountPrintingEntryId = '';
    let accountCardConfigState: 'loading' | 'loaded' | 'error' = isTauri() ? 'loading' : 'loaded';
    let accountCardFlow: 'external' | 'sumup' | 'dojo' | 'unavailable' | '' = '';

    $: loyaltyConfig = getLoyaltyConfig($settingsDB);
    $: loyaltyCustomer = newestCustomerSnapshot(
        loyaltyCustomerSnapshot,
        newestCustomerSnapshot(
            $customersDB.find((customer) => customer.id === loyaltyCustomerId),
            pageCustomers.find((customer) => customer.id === loyaltyCustomerId),
        ),
    );
    $: accountCustomer = $customersDB.find((customer) => customer.id === accountCustomerId)
        || pageCustomers.find((customer) => customer.id === accountCustomerId)
        || accountCustomerSnapshot;
    $: canTakeAccountPayment = $deviceOperatingMode === 'checkout'
        && hasPermission($currentEmployee, 'take_account_payment', $settingsDB);
    $: if (!showLoyalty && loyaltyHistoryLoading) {
        loyaltyHistoryRun += 1;
        loyaltyHistoryLoading = false;
    }
    $: canAdjustCustomerLoyalty = hasPermission($currentEmployee, 'adjust_customer_loyalty', $settingsDB);
    $: loyaltyCurrentPoints = Number(loyaltyCustomer?.loyaltyPoints ?? 0);
    $: loyaltyAdjustment = customerLoyaltyAdjustmentPreview(
        loyaltyCurrentPoints,
        loyaltyAdjustmentMode,
        loyaltyPointsDraft,
    );
    $: loyaltyAdjustmentReasonError = customerLoyaltyReasonError(loyaltyReasonDraft);
    $: loyaltyAdjustmentInputLabel = loyaltyAdjustmentMode === 'add'
        ? 'Points to add *'
        : loyaltyAdjustmentMode === 'remove'
            ? 'Points to remove *'
            : 'New points balance *';
    $: loyaltyAdjustmentSubmitLabel = loyaltyAdjustmentSaving
        ? 'Saving adjustment...'
        : loyaltyAdjustment.enteredPoints === null || loyaltyAdjustment.error
            ? 'Save Adjustment'
            : loyaltyAdjustmentMode === 'add'
                ? `Add ${loyaltyAdjustment.enteredPoints.toLocaleString()} Points`
                : loyaltyAdjustmentMode === 'remove'
                    ? `Remove ${loyaltyAdjustment.enteredPoints.toLocaleString()} Points`
                    : `Set Balance to ${loyaltyAdjustment.enteredPoints.toLocaleString()}`;
    $: loyaltyAdjustmentReady = canAdjustCustomerLoyalty
        && Boolean($currentEmployee)
        && loyaltyAdjustment.enteredPoints !== null
        && !loyaltyAdjustment.error
        && !loyaltyAdjustmentReasonError
        && !loyaltyHistoryLoading
        && !loyaltyHistoryError
        && !loyaltyAdjustmentSaving;
    $: canAdjustCustomerAccount = hasPermission($currentEmployee, 'adjust_customer_account', $settingsDB);
    $: accountBalance = Number(customerAccount?.balancePence || 0);
    $: accountLimit = Number(customerAccount?.creditLimitPence || 0);
    $: accountAvailable = accountLimit > 0 ? Math.max(0, accountLimit - accountBalance) : 0;
    $: accountManagedCardProvider = $dojoConfigStore.enabled
        ? ($dojoConfigStore.ready ? 'dojo' : 'unavailable')
        : $sumupConfigStore.enabled
            ? ($sumupConfigStore.ready ? 'sumup' : 'unavailable')
            : '';
    $: accountCardPaymentReady = accountManagedCardApproved
        || accountCardFlow === 'sumup'
        || accountCardFlow === 'dojo'
        || (accountCardFlow === 'external'
            && accountExternalCardConfirmed
            && accountReferenceDraft.trim().length > 0);
    $: accountOtherPaymentReady = accountPaymentMethod !== 'other'
        || accountReferenceDraft.trim().length > 0;
    $: pageCount = Math.max(1, Math.ceil(totalCustomers / PAGE_SIZE));
    $: if (currentPage > pageCount) currentPage = pageCount;
    $: pageStart = (currentPage - 1) * PAGE_SIZE;
    $: if (customersMounted) observeCustomerListChanges($customersDB);

    function customerListFields(customer: Customer): unknown[] {
        return [customer.name, customer.phone, customer.email, customer.postcode, customer.loyaltyCode,
            customer.loyaltyPoints, customer.notes, customer.accountId || '', Boolean(customer.accountEnabled),
            Number(customer.accountCreditLimitPence || 0), Number(customer.accountBalancePence || 0)];
    }

    function observeCustomerListChanges(customers: Customer[]) {
        const next = new Map<string, unknown[]>();
        let changed = customers.length !== customerListStoreState.size;
        for (const customer of customers) {
            const fields = customerListFields(customer), previous = customerListStoreState.get(customer.id);
            next.set(customer.id, fields);
            if (!previous || fields.some((value, index) => value !== previous[index])) changed = true;
        }
        customerListStoreState = next;
        if (!changed) return;
        scheduleCustomerListRefresh();
    }

    function scheduleCustomerListRefresh() {
        if (!customersMounted) return;
        // A burst of synced rows needs one bounded page query, not a full-table
        // reload for each event. getCustomersPage never writes customersDB.
        customersLoadToken++;
        if (!customerRefreshTimer) customerRefreshTimer = setTimeout(() => {
            customerRefreshTimer = null;
            if (customersMounted) void loadCustomerPage();
        }, 250);
    }

    onMount(() => {
        customerListStoreState = new Map($customersDB.map((customer) => [customer.id, customerListFields(customer)]));
        customersMounted = true;
        window.addEventListener(POS_CUSTOMERS_CHANGED_EVENT, scheduleCustomerListRefresh);
        void loadCustomerPage();
        if (isTauri() && $deviceOperatingMode === 'checkout') {
            accountCardConfigState = 'loading';
            void Promise.allSettled([loadDojoConfig(), loadSumupConfig()]).then((results) => {
                if (!customersMounted) return;
                accountCardConfigState = results.every((result) => result.status === 'fulfilled')
                    ? 'loaded'
                    : 'error';
            });
        }
    });

    onDestroy(() => {
        customersMounted = false;
        customersLoadToken += 1;
        loyaltyHistoryRun += 1;
        if (customerRefreshTimer) clearTimeout(customerRefreshTimer);
        if (typeof window !== 'undefined') window.removeEventListener(POS_CUSTOMERS_CHANGED_EVENT, scheduleCustomerListRefresh);
        accountLoadToken += 1;
        accountHistoryLoadRun += 1;
        dismissDojoSignatureDecision();
    });

    async function loadCustomerPage() {
        if (customerRefreshTimer) clearTimeout(customerRefreshTimer);
        customerRefreshTimer = null;
        const token = ++customersLoadToken;
        customersLoading = true;
        customersLoadError = '';
        try {
            const result = await getCustomersPage({
                query: appliedSearchQuery,
                accountFilter: customerAccountListView,
                limit: PAGE_SIZE,
                offset: (currentPage - 1) * PAGE_SIZE,
            });
            if (!customersMounted || token !== customersLoadToken) return;
            totalCustomers = result.total;
            allCustomerCount = result.summary.customerCount;
            outstandingCustomerCount = result.summary.outstandingCount;
            outstandingBalancePence = result.summary.outstandingBalancePence;
            const lastPage = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
            if (currentPage > lastPage) {
                currentPage = lastPage;
                await loadCustomerPage();
                return;
            }
            pageCustomers = result.rows as Customer[];
        } catch (error) {
            if (token !== customersLoadToken) return;
            customersLoadError = String(error).replace(/^Error:\s*/, '');
        } finally {
            if (token === customersLoadToken) customersLoading = false;
        }
    }

    function runCustomerSearch() {
        appliedSearchQuery = searchQuery.trim();
        currentPage = 1;
        void loadCustomerPage();
    }

    function clearCustomerSearch() {
        searchQuery = '';
        appliedSearchQuery = '';
        currentPage = 1;
        void loadCustomerPage();
    }

    function setCustomerAccountListView(view: CustomerAccountListView) {
        if (customerAccountListView === view) return;
        customerAccountListView = view;
        currentPage = 1;
        void loadCustomerPage();
    }

    function handleCustomerSearchKeydown(event: KeyboardEvent) {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        runCustomerSearch();
    }

    function goToCustomerPage(page: number) {
        const nextPage = Math.max(1, Math.min(pageCount, page));
        if (nextPage === currentPage) return;
        currentPage = nextPage;
        void loadCustomerPage();
    }

    function add() {
        if (saving) return;
        const stamp = now();
        cur = {
            id: uuid(),
            name: '',
            phone: '',
            email: '',
            postcode: '',
            loyaltyCode: createLoyaltyCode($customersDB),
            loyaltyPoints: 0,
            notes: '',
            createdAt: stamp,
            updatedAt: stamp,
        };
        editing = false;
        editingCustomer = null;
        showForm = true;
    }

    function edit(customer: Customer) {
        if (saving) return;
        const latest = newestCustomerSnapshot(customer, $customersDB.find((item) => item.id === customer.id))!;
        cur = { ...latest };
        editing = true;
        editingCustomer = { ...latest };
        showForm = true;
    }

    async function save() {
        if (saving) return;
        const submitted = { ...cur };
        const expectedProfile = editingCustomer ? { ...editingCustomer } : null;
        const name = String(submitted.name || '').trim();
        if (!name) {
            toast('Customer name is required', 'error');
            return;
        }

        saving = true;
        try {
            const id = String(submitted.id || uuid());
            const loyaltyCode = normalizeLoyaltyCode(submitted.loyaltyCode || createLoyaltyCode($customersDB));
            const validationError = loyaltyCodeValidationError(loyaltyCode);
            if (validationError) {
                toast(validationError, 'error');
                return;
            }
            if (await isCustomerLoyaltyCodeInUse(loyaltyCode, id)) {
                toast('Loyalty code is already used by another customer', 'error');
                return;
            }

            const existing = expectedProfile;
            const stamp = now();
            const profile = {
                id,
                name,
                phone: String(submitted.phone || '').trim(),
                email: String(submitted.email || '').trim(),
                postcode: String(submitted.postcode || '').trim().toUpperCase(),
                loyaltyCode,
                notes: String(submitted.notes || '').trim(),
                createdAt: existing?.createdAt || submitted.createdAt || stamp,
                updatedAt: stamp,
            };
            // Profile writes deliberately omit loyaltyPoints. Sales, refunds and
            // redemption transactions are the only owners of that balance.
            await saveCustomerProfile(profile, expectedProfile);
            showForm = false;
            editingCustomer = null;
            await loadCustomerPage();
            toast(existing ? 'Customer updated' : 'Customer added');
        } catch (error) {
            toast(`Could not save customer: ${error}`, 'error');
        } finally {
            saving = false;
        }
    }

    async function del(customer: Customer) {
        if (deletingCustomerId) return;
        try {
            const usage = await getCustomerUsage(customer.id);
            if (usage.loyaltyPoints !== 0) {
                toast(
                    `${customer.name} still has ${usage.loyaltyPoints.toLocaleString()} loyalty points and cannot be deleted.`,
                    'error',
                );
                return;
            }
            if (usage.accountBalancePence !== 0 || usage.accountEntries > 0) {
                toast(
                    usage.accountBalancePence !== 0
                        ? usage.accountBalancePence > 0
                            ? `${customer.name} still owes ${formatMoney(usage.accountBalancePence)} and cannot be deleted.`
                            : `${customer.name} still has ${formatMoney(Math.abs(usage.accountBalancePence))} customer credit and cannot be deleted.`
                        : `${customer.name} has customer-account history that must be retained. Keep the customer record so the statement remains accurate.`,
                    'error',
                );
                return;
            }
            if (usage.orders > 0 || usage.loyaltyEntries > 0) {
                toast(
                    `${customer.name} has linked sales or loyalty history and cannot be deleted. Keep the customer record so the history remains accurate.`,
                    'error',
                );
                return;
            }
            customerToDelete = customer;
            showDeleteConfirm = true;
        } catch (error) {
            const message = String(error).replace(/^Error:\s*/, '');
            toast(message.startsWith('Could not delete customer') ? message : `Could not delete customer: ${message}`, 'error');
        }
    }

    async function confirmCustomerDelete() {
        const customer = customerToDelete;
        if (!customer || deletingCustomerId) return;
        showDeleteConfirm = false;
        deletingCustomerId = customer.id;
        try {
            await removeCustomerSafely(customer.id);
            customersDB.update((list) => list.filter((item) => item.id !== customer.id));
            await loadCustomerPage();
            toast('Customer deleted', 'info');
        } catch (error) {
            const message = String(error).replace(/^Error:\s*/, '');
            toast(message.startsWith('Could not delete customer') ? message : `Could not delete customer: ${message}`, 'error');
        } finally {
            deletingCustomerId = '';
            customerToDelete = null;
        }
    }

    function cancelCustomerDelete() {
        customerToDelete = null;
    }

    function dismissDojoSignatureDecision() {
        dojoSignatureDecision = null;
        showDojoSignatureConfirm = false;
    }

    function finishDojoSignatureDecision(accepted: boolean) {
        const decide = dojoSignatureDecision;
        dismissDojoSignatureDecision();
        decide?.(accepted);
    }

    async function openLoyalty(customer: Customer) {
        loyaltyCustomerId = customer.id;
        loyaltyCustomerSnapshot = customer;
        loyaltyHistory = [];
        loyaltyHistoryError = '';
        loyaltyView = 'history';
        resetLoyaltyAdjustment();
        showLoyalty = true;
        await refreshLoyaltyHistory();
    }

    function resetLoyaltyAdjustment() {
        loyaltyAdjustmentMode = 'add';
        loyaltyPointsDraft = '';
        loyaltyReasonDraft = '';
        loyaltyAdjustmentAttempted = false;
        loyaltyAdjustmentIdempotencyKey = uuid();
    }

    function openLoyaltyAdjustment() {
        if (loyaltyHistoryLoading || loyaltyHistoryError) {
            toast('Refresh the customer’s live loyalty balance before adjusting points', 'error');
            return;
        }
        if (!canAdjustCustomerLoyalty) {
            toast('Your role cannot adjust customer loyalty points', 'error');
            return;
        }
        if (!$currentEmployee) {
            toast('Sign in before adjusting customer loyalty points', 'error');
            return;
        }
        resetLoyaltyAdjustment();
        if (loyaltyCurrentPoints < 0) loyaltyAdjustmentMode = 'set';
        loyaltyView = 'adjust';
    }

    function cancelLoyaltyAdjustment() {
        if (loyaltyAdjustmentSaving) return;
        loyaltyView = 'history';
        resetLoyaltyAdjustment();
    }

    function selectLoyaltyAdjustmentMode(mode: CustomerLoyaltyAdjustmentMode) {
        if (loyaltyAdjustmentSaving || loyaltyAdjustmentMode === mode) return;
        loyaltyAdjustmentMode = mode;
        loyaltyAdjustmentAttempted = false;
    }

    function formatSignedPoints(value: number): string {
        if (value > 0) return `+${value.toLocaleString()}`;
        if (value < 0) return `-${Math.abs(value).toLocaleString()}`;
        return '0';
    }

    async function saveLoyaltyAdjustment() {
        loyaltyAdjustmentAttempted = true;
        const customer = loyaltyCustomer;
        const actor = $currentEmployee;
        if (!customer || !actor || loyaltyAdjustmentSaving) return;
        if (!hasPermission(actor, 'adjust_customer_loyalty', $settingsDB)) {
            toast('Your role can no longer adjust customer loyalty points', 'error');
            return;
        }

        if (loyaltyHistoryLoading || loyaltyHistoryError) {
            toast('Refresh the customer’s live loyalty balance before adjusting points', 'error');
            return;
        }
        const expectedPoints = Number(customer.loyaltyPoints ?? 0);
        const preview = customerLoyaltyAdjustmentPreview(
            expectedPoints,
            loyaltyAdjustmentMode,
            loyaltyPointsDraft,
        );
        const reason = loyaltyReasonDraft.trim();
        const reasonError = customerLoyaltyReasonError(reason);
        if (preview.error || preview.enteredPoints === null) {
            toast(preview.error || 'Enter the points for this adjustment', 'error');
            return;
        }
        if (reasonError) {
            toast(reasonError, 'error');
            return;
        }

        const idempotencyKey = loyaltyAdjustmentIdempotencyKey || uuid();
        loyaltyAdjustmentIdempotencyKey = idempotencyKey;
        loyaltyAdjustmentSaving = true;
        try {
            const result = await adjustCustomerLoyalty({
                customerId: customer.id,
                expectedPoints,
                newPoints: preview.nextPoints,
                reason,
                employeeId: actor.id,
                actorExpectedUpdatedAt: actor.updatedAt || '',
                idempotencyKey,
            });
            // The database layer applies the result only when it is not older
            // than the customer already in memory. Reuse that guarded row so
            // a later shared-till update can never be overwritten here.
            const visibleCustomer = newestCustomerSnapshot({
                ...customer,
                loyaltyPoints: result.loyaltyPoints,
                updatedAt: result.customerUpdatedAt,
            }, $customersDB.find((item) => item.id === customer.id))!;
            loyaltyCustomerSnapshot = visibleCustomer;
            pageCustomers = pageCustomers.map((item) => item.id === customer.id
                ? { ...item, ...newestCustomerSnapshot(visibleCustomer, item)! }
                : item);
            loyaltyView = 'history';
            resetLoyaltyAdjustment();
            await refreshLoyaltyHistory();
            toast(`Loyalty correction saved for ${customer.name}`, 'success');
        } catch (error) {
            const message = String(error).replace(/^Error:\s*/, '');
            toast(`Could not adjust loyalty points: ${message}`, 'error');
            if (/balance changed|refresh/i.test(message)) await refreshLoyaltyHistory();
        } finally {
            loyaltyAdjustmentSaving = false;
        }
    }

    async function refreshLoyaltyHistory() {
        const customerId = loyaltyCustomerId;
        if (!customerId) return;
        const run = ++loyaltyHistoryRun;
        loyaltyHistoryLoading = true;
        loyaltyHistoryError = '';
        try {
            const { customer, history } = await getCustomerLoyaltySnapshot(customerId);
            if (run !== loyaltyHistoryRun || customerId !== loyaltyCustomerId || !showLoyalty) return;
            if (!customer) throw new Error('This customer is no longer available.');
            const visibleCustomer = newestCustomerSnapshot(customer, $customersDB.find((item) => item.id === customer.id))!;
            loyaltyCustomerSnapshot = visibleCustomer;
            // The authoritative snapshot is for this view only; do not write it
            // into the shared cache or overwrite a newer synced customer row.
            pageCustomers = pageCustomers.map((item) => item.id === customer.id
                ? { ...item, ...newestCustomerSnapshot(visibleCustomer, item)! }
                : item);
            loyaltyHistory = history;
        } catch (error) {
            if (run === loyaltyHistoryRun && customerId === loyaltyCustomerId && showLoyalty) {
                loyaltyHistoryError = `Could not load the live loyalty balance and history. ${String(error).replace(/^Error:\s*/, '')} Refresh before adjusting points.`;
            }
        } finally {
            if (run === loyaltyHistoryRun) loyaltyHistoryLoading = false;
        }
    }

    function loyaltyReason(reason: string): string {
        if (reason === 'earned') return 'Points earned';
        if (reason === 'redeemed') return 'Loyalty value used';
        if (reason === 'refund_adjustment') return 'Refund adjustment';
        if (reason === 'manual_adjustment' || reason.startsWith('manual_adjustment:')) return 'Manual adjustment';
        return 'Loyalty adjustment';
    }

    function customerAccountBalance(customer: Customer): number {
        return Number(customer.accountBalancePence || 0);
    }

    function updateCustomerAccountSummary(account: CustomerAccount) {
        const patch = {
            accountId: account.id,
            accountEnabled: account.isEnabled,
            accountCreditLimitPence: account.creditLimitPence,
            accountBalancePence: account.balancePence,
        };
        pageCustomers = pageCustomers.map((customer) => customer.id === account.customerId
            ? { ...customer, ...patch }
            : customer);
        customersDB.update((customers) => customers.map((customer) => customer.id === account.customerId
            ? { ...customer, ...patch }
            : customer));
        if (accountCustomerSnapshot?.id === account.customerId) {
            accountCustomerSnapshot = { ...accountCustomerSnapshot, ...patch };
        }
    }

    async function openCustomerAccount(customer: Customer) {
        accountCustomerId = customer.id;
        accountCustomerSnapshot = customer;
        customerAccount = null;
        accountEntries = [];
        accountEntryTotal = 0;
        accountHistoryLoadRun += 1;
        accountHistoryLoadingMore = false;
        showAccount = true;
        await refreshCustomerAccount();
    }

    async function refreshCustomerAccount() {
        const customerId = accountCustomerId;
        if (!customerId) return;
        const token = ++accountLoadToken;
        accountLoading = true;
        try {
            const [account, history] = await Promise.all([
                getCustomerAccount(customerId),
                getCustomerAccountEntries(customerId, { limit: ACCOUNT_HISTORY_PAGE_SIZE, offset: 0 }),
            ]);
            if (customerId !== accountCustomerId || token !== accountLoadToken || !showAccount) return;
            accountHistoryLoadRun += 1;
            accountHistoryLoadingMore = false;
            customerAccount = account;
            accountEntries = history.entries;
            accountEntryTotal = history.total;
            accountEnabledDraft = account.isEnabled;
            accountLimitDraft = account.creditLimitPence > 0
                ? (account.creditLimitPence / 100).toFixed(2)
                : '';
            updateCustomerAccountSummary(account);
        } catch (error) {
            if (token !== accountLoadToken) return;
            toast(`Could not load customer account: ${String(error).replace(/^Error:\s*/, '')}`, 'error');
        } finally {
            if (token === accountLoadToken) accountLoading = false;
        }
    }

    async function loadMoreCustomerAccountEntries() {
        const customerId = accountCustomerId;
        if (!customerId || accountHistoryLoadingMore || accountEntries.length >= accountEntryTotal) return;
        const offset = accountEntries.length;
        const accountToken = accountLoadToken;
        const run = ++accountHistoryLoadRun;
        accountHistoryLoadingMore = true;
        try {
            const page = await getCustomerAccountEntries(customerId, {
                limit: ACCOUNT_HISTORY_PAGE_SIZE,
                offset,
            });
            if (!showAccount
                || customerId !== accountCustomerId
                || accountToken !== accountLoadToken
                || run !== accountHistoryLoadRun
                || offset !== accountEntries.length) return;
            const known = new Set(accountEntries.map((entry) => entry.id));
            accountEntries = [...accountEntries, ...page.entries.filter((entry) => !known.has(entry.id))];
            accountEntryTotal = page.total;
        } catch (error) {
            if (run === accountHistoryLoadRun && customerId === accountCustomerId) {
                toast(`Could not load more account activity: ${String(error).replace(/^Error:\s*/, '')}`, 'error');
            }
        } finally {
            if (run === accountHistoryLoadRun) accountHistoryLoadingMore = false;
        }
    }

    function poundsToPence(value: string, label: string, allowZero = false): number | null {
        const normalized = value.trim().replace(/[£,\s]/g, '');
        if (!normalized && allowZero) return 0;
        if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
            toast(`${label} must be a valid amount with no more than 2 decimal places`, 'error');
            return null;
        }
        const amount = toPence(Number(normalized));
        if (!Number.isSafeInteger(amount) || amount < 0 || (!allowZero && amount === 0)) {
            toast(`${label} must be greater than zero`, 'error');
            return null;
        }
        return amount;
    }

    async function saveAccountConfig() {
        if (!customerAccount || !$currentEmployee || accountSaving || !canAdjustCustomerAccount) return;
        const limitPence = poundsToPence(accountLimitDraft, 'Account limit', true);
        if (limitPence === null) return;
        accountSaving = true;
        try {
            const account = await saveCustomerAccountConfig({
                customerId: customerAccount.customerId,
                isEnabled: accountEnabledDraft,
                creditLimitPence: limitPence,
                employeeId: $currentEmployee.id,
            });
            customerAccount = account;
            updateCustomerAccountSummary(account);
            toast(account.isEnabled ? 'Customer account enabled' : 'Customer account placed on hold');
        } catch (error) {
            toast(`Could not save account settings: ${String(error).replace(/^Error:\s*/, '')}`, 'error');
        } finally {
            accountSaving = false;
        }
    }

    function openAccountEntry(mode: typeof accountEntryMode) {
        if (!customerAccount || !$currentEmployee) {
            toast('Sign in before changing a customer account', 'error');
            return;
        }
        if (mode === 'payment') {
            if ($deviceOperatingMode === 'back_office') {
                toast('Customer payments must be taken on a Checkout Till', 'error');
                return;
            }
            if (!canTakeAccountPayment) {
                toast('Your role cannot take customer account payments', 'error');
                return;
            }
            if (!$currentShiftId) {
                toast('Open a till session before taking an account payment', 'error');
                return;
            }
            if (accountBalance <= 0) {
                toast('This customer has no outstanding balance', 'info');
                return;
            }
        } else {
            if (!canAdjustCustomerAccount) {
                toast('A manager with account-adjustment permission is required', 'error');
                return;
            }
            if (mode === 'opening' && accountEntryTotal > 0) {
                toast('An opening balance can only be posted before any account activity', 'error');
                return;
            }
        }

        accountEntryMode = mode;
        accountAmountDraft = mode === 'payment' || (mode === 'reduce' && accountBalance > 0)
            ? (accountBalance / 100).toFixed(2)
            : '';
        accountPaymentMethod = 'cash';
        accountReferenceDraft = '';
        accountReasonDraft = '';
        accountEntryIdempotencyKey = uuid();
        accountExternalCardConfirmed = false;
        accountManagedCardApproved = false;
        accountManagedAttemptProvider = '';
        accountManagedReportEpoch = undefined;
        accountManagedServerDataEpoch = undefined;
        accountManagedCardExtras = { tipsAmount: 0, serviceChargeAmount: 0, cashbackAmount: 0 };
        accountCardFlow = '';
        accountTerminalStatus = '';
        showAccountEntry = true;
    }

    function selectAccountPaymentMethod(method: Exclude<CustomerAccountPaymentMethod, ''>) {
        if (accountSaving) return;
        if (method === 'card' && accountCardConfigState !== 'loaded') {
            toast(
                accountCardConfigState === 'loading'
                    ? 'Card-terminal settings are still loading. Please wait a moment.'
                    : 'Card-terminal settings could not be loaded. Reload this screen before taking a card payment.',
                'error',
            );
            return;
        }
        accountPaymentMethod = method;
        accountCardFlow = method === 'card'
            ? accountManagedCardProvider === 'dojo' || accountManagedCardProvider === 'sumup'
                ? accountManagedCardProvider
                : accountManagedCardProvider === 'unavailable'
                    ? 'unavailable'
                    : 'external'
            : '';
        accountReferenceDraft = '';
        accountExternalCardConfirmed = false;
        accountManagedCardApproved = false;
        accountManagedAttemptProvider = '';
        accountManagedReportEpoch = undefined;
        accountManagedServerDataEpoch = undefined;
        accountManagedCardExtras = { tipsAmount: 0, serviceChargeAmount: 0, cashbackAmount: 0 };
        accountTerminalStatus = '';
    }

    function sumupAccountTerminalMessage(state: string): string {
        if (state === 'WAITING_FOR_CARD') return 'Ask the customer to tap or insert their card';
        if (state === 'WAITING_FOR_PIN') return 'Waiting for the customer to enter their PIN';
        if (state === 'UPDATING_FIRMWARE') return 'The SumUp Solo is updating';
        return 'Waiting for the SumUp Solo';
    }

    async function takeSumupAccountPayment(
        amountPence: number,
        reference: string,
        tillNumber: string,
        payload: CustomerAccountPaymentAttemptPayload,
    ): Promise<string> {
        const config = $sumupConfigStore;
        const attempt: SumupPaymentAttempt = {
            id: reference,
            provider: 'sumup',
            terminalKey: sumupTerminalKey(config),
            clientTransactionId: '',
            terminalSessionId: '',
            operationKind: 'customer_account_payment',
            amount: amountPence,
            expectedProviderAmount: amountPence,
            currency: config.currency,
            status: 'prepared',
            saleBundle: payload,
            providerReference: '',
            error: '',
            tillId: tillNumber,
            createdAt: now(),
            updatedAt: now(),
        };
        const preparedAttempt = await saveSumupAttempt(attempt);
        if (!isCustomerAccountPaymentPayload(preparedAttempt.saleBundle)) {
            throw new Error('The prepared SumUp journal does not contain an account payment');
        }
        payload.reportEpoch = preparedAttempt.saleBundle.reportEpoch;
        payload.serverDataEpoch = preparedAttempt.saleBundle.serverDataEpoch;

        let lockHeld = false;
        let approved = false;
        let finalized = false;
        let networkStarted = false;
        let clientTransactionId = '';
        try {
            const lock = await acquireSumupLock(
                config,
                tillNumber,
                `${$storeDB.name || 'POS'} customer accounts`,
                reference,
            );
            if (!lock.acquired) {
                throw new Error(`The SumUp Solo is being used by ${lock.lock?.tillName || 'another till'}`);
            }
            lockHeld = true;
            accountTerminalStatus = `Sending ${formatMoney(amountPence)} to ${config.readerName || 'SumUp Solo'}`;
            await updateSumupAttempt(reference, 'started');
            await assertPaymentTerminalAttemptReady('sumup', reference);
            networkStarted = true;
            const checkout = await createSumupCheckout(
                amountPence,
                reference,
                `Customer account payment for ${accountCustomer?.name || 'customer'}`,
            );
            clientTransactionId = checkout.clientTransactionId;
            await updateSumupAttempt(reference, 'started', { clientTransactionId });
            const deadline = Date.now() + 180_000;
            let nextLeaseRefresh = Date.now() + 25_000;
            let nextReaderCheck = 0;
            while (Date.now() < deadline) {
                const status = await getSumupTransactionStatus(clientTransactionId);
                const outcome = String(status.simpleStatus || status.status).toUpperCase();
                if (outcome === 'SUCCESSFUL' || outcome === 'PAID_OUT') {
                    if (status.foreignTransactionId !== reference
                        || status.amount === undefined
                        || Math.round(status.amount * 100) !== amountPence
                        || String(status.currency || '').toUpperCase() !== config.currency.toUpperCase()
                        || !status.transactionId) {
                        throw new Error('SumUp approved a transaction that does not match this account payment. Do not retry the card; check SumUp.');
                    }
                    const providerReference = `SumUp ${status.transactionCode || status.transactionId} [id:${status.transactionId}]`;
                    payload.reference = providerReference;
                    approved = true;
                    await updateSumupAttempt(reference, 'approved', {
                        clientTransactionId,
                        providerReference,
                        saleBundle: payload,
                    }).catch(() => undefined);
                    return providerReference;
                }
                if (['FAILED', 'CANCELLED', 'NON_COLLECTION'].includes(outcome)) {
                    const finalStatus = outcome === 'CANCELLED' ? 'cancelled' : 'failed';
                    await updateSumupAttempt(reference, finalStatus, {
                        clientTransactionId,
                        error: `SumUp status: ${outcome}`,
                    });
                    finalized = true;
                    throw new Error(outcome === 'CANCELLED' ? 'The SumUp payment was cancelled' : 'The card payment was not approved');
                }
                if (Date.now() >= nextReaderCheck) {
                    nextReaderCheck = Date.now() + 4_000;
                    const reader = await getSumupReaderStatus().catch(() => null);
                    if (reader) accountTerminalStatus = sumupAccountTerminalMessage(reader.state);
                }
                if (Date.now() >= nextLeaseRefresh) {
                    nextLeaseRefresh = Date.now() + 25_000;
                    if (!(await refreshSumupLock(config, tillNumber, reference))) {
                        await terminateSumupCheckout().catch(() => undefined);
                        throw new Error('This till lost the SumUp reservation. Check SumUp before retrying.');
                    }
                }
                await delay(1_200);
            }
            await terminateSumupCheckout().catch(() => undefined);
            throw new Error('SumUp did not return a final result. Check SumUp before retrying.');
        } catch (error) {
            if (!approved && !finalized) {
                await updateSumupAttempt(reference, networkStarted ? 'uncertain' : 'cancelled', {
                    clientTransactionId,
                    error: String(error),
                    saleBundle: payload,
                }).catch(() => undefined);
            }
            throw error;
        } finally {
            if (lockHeld) {
                await releaseSumupLock(config, tillNumber, reference).catch((error) => {
                    console.warn('Could not release SumUp account-payment lock:', error);
                });
            }
        }
    }

    async function takeDojoAccountPayment(
        amountPence: number,
        reference: string,
        tillNumber: string,
        payload: CustomerAccountPaymentAttemptPayload,
    ): Promise<string> {
        const config = $dojoConfigStore;
        const attempt: DojoPaymentAttempt = {
            id: reference,
            provider: 'dojo',
            terminalKey: dojoTerminalKey(config),
            clientTransactionId: '',
            terminalSessionId: '',
            operationKind: 'customer_account_payment',
            amount: amountPence,
            expectedProviderAmount: amountPence,
            currency: config.currency,
            status: 'prepared',
            saleBundle: payload,
            providerReference: '',
            error: '',
            tillId: tillNumber,
            createdAt: now(),
            updatedAt: now(),
        };
        const preparedAttempt = await saveDojoAttempt(attempt);
        if (!isCustomerAccountPaymentPayload(preparedAttempt.saleBundle)) {
            throw new Error('The prepared Dojo journal does not contain an account payment');
        }
        payload.reportEpoch = preparedAttempt.saleBundle.reportEpoch;
        payload.serverDataEpoch = preparedAttempt.saleBundle.serverDataEpoch;

        let lockHeld = false;
        let approved = false;
        let finalized = false;
        let networkStarted = false;
        let paymentIntentId = '';
        let terminalSessionId = '';
        try {
            const lock = await acquireDojoLock(
                config,
                tillNumber,
                `${$storeDB.name || 'POS'} customer accounts`,
                reference,
            );
            if (!lock.acquired) {
                throw new Error(`The Dojo terminal is being used by ${lock.lock?.tillName || 'another till'}`);
            }
            lockHeld = true;
            accountTerminalStatus = `Sending ${formatMoney(amountPence)} to ${config.terminalName || 'Dojo terminal'}`;
            await updateDojoAttempt(reference, 'started');
            await assertPaymentTerminalAttemptReady('dojo', reference);
            networkStarted = true;
            const payment = await createDojoPayment(
                amountPence,
                reference,
                `Customer account payment for ${accountCustomer?.name || 'customer'}`,
            );
            paymentIntentId = payment.paymentIntentId;
            terminalSessionId = payment.terminalSessionId;
            await updateDojoAttempt(reference, 'started', {
                clientTransactionId: paymentIntentId,
                terminalSessionId,
            });
            const result = await monitorDojoSession({
                paymentIntentId,
                terminalSessionId,
                apiEnvironment: config.apiEnvironment,
                retry: async () => {
                    const retried = await retryDojoPayment(reference, terminalSessionId);
                    terminalSessionId = retried.terminalSessionId;
                    return terminalSessionId;
                },
                onDeclined: (decide) => { dojoRetryDecision = decide; },
                onDeclineDismiss: () => { dojoRetryDecision = null; },
                getSession: () => getDojoTerminalSessionStatus(terminalSessionId),
                getPayment: () => getDojoPaymentIntentStatus(paymentIntentId),
                submitSignature: (accepted) => respondToDojoSignature(terminalSessionId, accepted),
                cancel: () => cancelDojoTerminalSession(terminalSessionId),
                refreshLease: () => refreshDojoLock(config, tillNumber, reference),
                isDisposed: () => !customersMounted,
                onSignatureRequired: (decide) => {
                    dojoSignatureDecision = decide;
                    showDojoSignatureConfirm = true;
                },
                onSignatureDismiss: dismissDojoSignatureDecision,
                onMessage: (message) => { accountTerminalStatus = message; },
            });
            if (result.outcome !== 'captured') {
                await updateDojoAttempt(reference, result.outcome, {
                    clientTransactionId: paymentIntentId,
                    terminalSessionId,
                    error: `Dojo status: ${result.status}`,
                });
                finalized = true;
                throw new Error(result.outcome === 'cancelled' ? 'The Dojo payment was cancelled' : 'The card payment was not approved');
            }
            const status = result.payment;
            if (status.id !== paymentIntentId
                || status.reference !== reference
                || status.status !== 'Captured') {
                throw new Error('Dojo captured a payment that does not match this account payment. Do not retry the card; check Dojo.');
            }
            const breakdown = getDojoPaymentBreakdown(status, amountPence, config.currency);
            payload.tipsAmount = breakdown.tipsAmount;
            payload.serviceChargeAmount = breakdown.serviceChargeAmount;
            payload.cashbackAmount = breakdown.cashbackAmount;
            const providerReference = `Dojo ${status.transactionId || paymentIntentId} [id:${paymentIntentId}]`;
            payload.reference = providerReference;
            approved = true;
            await updateDojoAttempt(reference, 'approved', {
                clientTransactionId: paymentIntentId,
                terminalSessionId,
                providerReference,
                saleBundle: payload,
            }).catch(() => undefined);
            return providerReference;
        } catch (error) {
            if (!approved && !finalized) {
                await updateDojoAttempt(reference, networkStarted ? 'uncertain' : 'cancelled', {
                    clientTransactionId: paymentIntentId,
                    terminalSessionId,
                    error: String(error),
                    saleBundle: payload,
                }).catch(() => undefined);
            }
            throw error;
        } finally {
            dismissDojoSignatureDecision();
            if (lockHeld) {
                await releaseDojoLock(config, tillNumber, reference).catch((error) => {
                    console.warn('Could not release Dojo account-payment lock:', error);
                });
            }
        }
    }

    async function takeManagedAccountCardPayment(
        provider: 'dojo' | 'sumup',
        amountPence: number,
        tillNumber: string,
        payload: CustomerAccountPaymentAttemptPayload,
    ): Promise<string> {
        await requireManualSaleAccess();
        accountTerminalStatus = 'Reserving the card terminal';
        if (provider === 'dojo') {
            return takeDojoAccountPayment(amountPence, accountEntryIdempotencyKey, tillNumber, payload);
        }
        return takeSumupAccountPayment(amountPence, accountEntryIdempotencyKey, tillNumber, payload);
    }

    async function saveAccountEntry() {
        if (!customerAccount || !$currentEmployee || accountSaving) return;
        if (accountEntryMode === 'payment' && $deviceOperatingMode === 'back_office') {
            toast('Customer payments must be taken on a Checkout Till', 'error');
            return;
        }
        if (accountEntryMode === 'payment' && !canTakeAccountPayment) {
            toast('Your role can no longer take customer account payments', 'error');
            return;
        }
        if (accountEntryMode !== 'payment' && !canAdjustCustomerAccount) {
            toast('Account-adjustment permission is required', 'error');
            return;
        }
        const amountPence = poundsToPence(accountAmountDraft, 'Amount');
        if (amountPence === null) return;
        if (accountEntryMode === 'payment' && amountPence > accountBalance && !accountManagedCardApproved) {
            toast(`Amount cannot be more than the outstanding ${formatMoney(accountBalance)}`, 'error');
            return;
        }
        const reason = accountReasonDraft.trim();
        if (accountEntryMode !== 'payment' && !reason) {
            toast('A reason is required for every account adjustment', 'error');
            return;
        }
        if (accountEntryMode === 'payment' && !$currentShiftId) {
            toast('Open a till session before taking an account payment', 'error');
            return;
        }
        const selectedCardFlow = accountPaymentMethod === 'card' ? accountCardFlow : '';
        if (accountEntryMode === 'payment' && accountPaymentMethod === 'card' && !accountCardPaymentReady) {
            toast(
                selectedCardFlow === 'unavailable'
                    ? 'The configured card provider is not ready. Fix its payment settings first.'
                    : selectedCardFlow === ''
                        ? 'Choose Card again after the terminal settings finish loading.'
                        : 'Confirm the external terminal approved this exact payment and enter its reference.',
                'error',
            );
            return;
        }
        if (accountEntryMode === 'payment' && accountPaymentMethod === 'other' && !accountOtherPaymentReady) {
            toast('Enter a bank, cheque, or other payment reference', 'error');
            return;
        }

        accountSaving = true;
        let managedAttemptProvider: TerminalProvider | '' = accountManagedAttemptProvider;
        let managedAttemptPayload: CustomerAccountPaymentAttemptPayload | null = null;
        try {
            const liveAccount = await getCustomerAccount(customerAccount.customerId);
            customerAccount = liveAccount;
            if (accountEntryMode === 'payment'
                && amountPence > liveAccount.balancePence
                && !accountManagedCardApproved) {
                throw new Error(`Amount cannot be more than the current outstanding ${formatMoney(liveAccount.balancePence)}`);
            }
            const tillNumber = isTauri() ? await getOrCreateTillId() : 'browser-preview-till';
            const isReduction = accountEntryMode === 'payment' || accountEntryMode === 'reduce';
            const entryDescription = accountEntryMode === 'payment'
                ? reason || `${accountPaymentMethod === 'cash' ? 'Cash' : accountPaymentMethod === 'card' ? 'Card' : 'Other'} account payment`
                : reason;
            const idempotencyKey = accountEntryIdempotencyKey || uuid();
            accountEntryIdempotencyKey = idempotencyKey;
            const durableManagedProvider: TerminalProvider | '' = accountManagedAttemptProvider
                || (selectedCardFlow === 'dojo' || selectedCardFlow === 'sumup'
                    ? selectedCardFlow
                    : '');
            if (!managedAttemptProvider) managedAttemptProvider = durableManagedProvider;
            if (accountEntryMode === 'payment'
                && accountPaymentMethod === 'card'
                && durableManagedProvider) {
                managedAttemptPayload = {
                    kind: 'customer_account_payment',
                    customerId: liveAccount.customerId,
                    amountPence: -amountPence,
                    paymentMethod: 'card',
                    reference: accountReferenceDraft.trim(),
                    description: entryDescription,
                    employeeId: $currentEmployee.id,
                    tillNumber,
                    shiftId: $currentShiftId || '',
                    idempotencyKey,
                    allowCreditBalance: true,
                    reportEpoch: accountManagedReportEpoch,
                    serverDataEpoch: accountManagedServerDataEpoch,
                    ...accountManagedCardExtras,
                };
            }
            if (accountEntryMode === 'payment'
                && accountPaymentMethod === 'card'
                && durableManagedProvider
                && !accountManagedCardApproved) {
                accountReferenceDraft = await takeManagedAccountCardPayment(
                    durableManagedProvider,
                    amountPence,
                    tillNumber,
                    managedAttemptPayload!,
                );
                accountManagedReportEpoch = managedAttemptPayload!.reportEpoch;
                accountManagedServerDataEpoch = managedAttemptPayload!.serverDataEpoch;
                accountManagedCardExtras = {
                    tipsAmount: managedAttemptPayload!.tipsAmount || 0,
                    serviceChargeAmount: managedAttemptPayload!.serviceChargeAmount || 0,
                    cashbackAmount: managedAttemptPayload!.cashbackAmount || 0,
                };
                accountManagedCardApproved = true;
                managedAttemptProvider = durableManagedProvider;
                accountManagedAttemptProvider = managedAttemptProvider;
                managedAttemptPayload!.reference = accountReferenceDraft;
                accountTerminalStatus = 'Card approved. Saving the customer account payment';
            }
            if (accountEntryMode === 'payment'
                && accountPaymentMethod === 'card'
                && selectedCardFlow === 'external'
                && !accountManagedCardApproved) {
                accountManagedCardApproved = true;
                accountTerminalStatus = 'External card approval confirmed. Saving the customer account payment';
            }
            const result = await postCustomerAccountEntry({
                customerId: liveAccount.customerId,
                entryType: accountEntryMode === 'opening' ? 'opening_balance'
                    : accountEntryMode === 'payment' ? 'payment'
                    : 'adjustment',
                amountPence: isReduction ? -amountPence : amountPence,
                paymentMethod: accountEntryMode === 'payment' ? accountPaymentMethod : '',
                reference: accountReferenceDraft.trim(),
                description: entryDescription,
                employeeId: $currentEmployee.id,
                tillNumber,
                shiftId: $currentShiftId || '',
                idempotencyKey,
                allowCreditBalance: accountEntryMode === 'payment'
                    && accountPaymentMethod === 'card'
                    && accountManagedCardApproved,
                reportEpoch: managedAttemptPayload?.reportEpoch,
                serverDataEpoch: managedAttemptPayload?.serverDataEpoch,
                tipsAmount: managedAttemptPayload?.tipsAmount || 0,
                serviceChargeAmount: managedAttemptPayload?.serviceChargeAmount || 0,
                cashbackAmount: managedAttemptPayload?.cashbackAmount || 0,
            });
            if (managedAttemptProvider && managedAttemptPayload) {
                managedAttemptPayload.reference = accountReferenceDraft.trim();
                const updateAttempt = managedAttemptProvider === 'dojo' ? updateDojoAttempt : updateSumupAttempt;
                await updateAttempt(idempotencyKey, 'completed', {
                    saleBundle: managedAttemptPayload,
                    providerReference: managedAttemptPayload.reference,
                    error: '',
                });
            }
            customerAccount = result.account;
            accountHistoryLoadRun += 1;
            accountHistoryLoadingMore = false;
            const entryAlreadyShown = accountEntries.some((entry) =>
                entry.id === result.entry.id || entry.idempotencyKey === result.entry.idempotencyKey);
            accountEntries = [
                result.entry,
                ...accountEntries.filter((entry) =>
                    entry.id !== result.entry.id && entry.idempotencyKey !== result.entry.idempotencyKey),
            ];
            if (!entryAlreadyShown) accountEntryTotal += 1;
            updateCustomerAccountSummary(result.account);
            void loadCustomerPage();
            showAccountEntry = false;
            const paymentResultMessage = result.account.balancePence > 0
                ? `Payment recorded. ${formatMoney(result.account.balancePence)} remains owed.`
                : result.account.balancePence < 0
                    ? `Payment recorded. The customer now has ${formatMoney(Math.abs(result.account.balancePence))} credit.`
                    : 'Payment recorded. The customer account is clear.';
            const cashbackToGive = managedAttemptPayload?.cashbackAmount || 0;
            toast(accountEntryMode === 'payment'
                ? `${cashbackToGive > 0 ? `Give cashback ${formatMoney(cashbackToGive)}. This is cashback, not change. ` : ''}${paymentResultMessage}`
                : 'Customer account adjustment recorded',
                'success',
                cashbackToGive > 0,
                cashbackToGive > 0 ? () => { void printAccountPaymentAcknowledgement(result.entry); } : undefined,
                { persistent: cashbackToGive > 0 },
            );
            if (accountEntryMode === 'payment') {
                void printAccountPaymentAcknowledgement(result.entry, true);
            }
            if (accountEntryMode === 'payment' && (accountPaymentMethod === 'cash' || cashbackToGive > 0) && isTauri()) {
                const printerConfig = getReceiptPrinterConfig($settingsDB);
                if (printerConfig.openDrawerAfterPayment) {
                    void openCashDrawer(getCashDrawerConfig($settingsDB)).catch((drawerError) => {
                        console.warn('Drawer failed after customer account payment:', drawerError);
                        toast(`Payment was recorded, but the cash drawer did not open: ${String(drawerError).replace(/^Error:\s*/, '')}`, 'error');
                    });
                }
            }
        } catch (error) {
            const message = String(error).replace(/^Error:\s*/, '');
            if (managedAttemptProvider && managedAttemptPayload && accountManagedCardApproved) {
                managedAttemptPayload.reference = accountReferenceDraft.trim();
                const updateAttempt = managedAttemptProvider === 'dojo' ? updateDojoAttempt : updateSumupAttempt;
                await updateAttempt(accountEntryIdempotencyKey, 'commit_failed', {
                    saleBundle: managedAttemptPayload,
                    providerReference: managedAttemptPayload.reference,
                    error: String(error),
                }).catch(() => undefined);
            }
            if (accountEntryMode === 'payment'
                && accountPaymentMethod === 'card'
                && accountManagedCardApproved) {
                accountTerminalStatus = 'Card approved, but the account entry still needs saving';
                toast(`The card was approved, but the account payment was not saved: ${message}. Press Record Payment again; the card will not be charged again.`, 'error');
            } else {
                toast(`Could not update customer account: ${message}`, 'error');
            }
        } finally {
            accountSaving = false;
        }
    }

    function accountEntryLabel(entry: CustomerAccountEntry): string {
        if (entry.entryType === 'charge') return 'Pay Later purchase';
        if (entry.entryType === 'payment') return `${entry.paymentMethod === 'card' ? 'Card' : entry.paymentMethod === 'cash' ? 'Cash' : 'Other'} payment`;
        if (entry.entryType === 'opening_balance') return 'Opening balance';
        if (entry.entryType === 'refund') return 'Refund credited';
        if (entry.entryType === 'reversal') return 'Reversal';
        return entry.amountPence >= 0 ? 'Balance increased' : 'Balance reduced';
    }

    function accountEntryReference(entry: CustomerAccountEntry): string {
        const parts = [formatHistoryDate(entry.createdAt)];
        if (entry.receiptNumber) parts.push(`Receipt ${entry.receiptNumber}`);
        if (entry.reference) parts.push(entry.reference);
        return parts.join(' · ');
    }

    function accountPaymentAcknowledgementText(entry: CustomerAccountEntry): string {
        const customerName = accountCustomer?.name || accountCustomerSnapshot?.name || entry.customerId;
        const divider = ''.padEnd(32, '-');
        return [
            $storeDB.name || 'Customer account',
            $storeDB.address || '',
            $storeDB.phone || '',
            divider,
            'ACCOUNT PAYMENT ACKNOWLEDGEMENT',
            `No: ${entry.receiptNumber}`,
            `Date: ${formatHistoryDate(entry.createdAt)}`,
            `Customer: ${customerName}`,
            `Method: ${entry.paymentMethod === 'card' ? 'Card' : entry.paymentMethod === 'cash' ? 'Cash' : 'Other'}`,
            ...accountPaymentAmountLines(entry, formatMoney),
            `Balance after: ${formatAccountBalance(entry.balanceAfterPence)}`,
            entry.reference ? `Reference: ${entry.reference}` : '',
            entry.tillNumber ? `Till: ${entry.tillNumber}` : '',
            entry.employeeId ? `Employee: ${entry.employeeId}` : '',
            divider,
            'Customer account payment only.',
            'This is not a sales receipt.',
        ].filter(Boolean).join('\n');
    }

    async function printAccountPaymentAcknowledgement(entry: CustomerAccountEntry, automatic = false) {
        if (entry.entryType !== 'payment') return;
        const config = getReceiptPrinterConfig($settingsDB);
        if (!config.enabled) {
            if (!automatic) toast('The receipt printer is disabled', 'error');
            return;
        }
        if (automatic && !config.autoPrintAfterPayment) return;
        if (accountPrintingEntryId) {
            if (!automatic) toast('Please wait for the current acknowledgement to finish printing', 'info');
            return;
        }
        accountPrintingEntryId = entry.id;
        try {
            await printEscposTextReport(
                accountPaymentAcknowledgementText(entry),
                `Account payment ${entry.receiptNumber}`,
                config,
            );
            if (!automatic) toast(`Acknowledgement ${entry.receiptNumber} sent to the printer`, 'success');
        } catch (error) {
            toast(`${automatic ? 'Payment was recorded, but the acknowledgement did not print' : 'Acknowledgement did not print'}: ${String(error).replace(/^Error:\s*/, '')}`, 'error');
        } finally {
            accountPrintingEntryId = '';
        }
    }

    function formatSignedMoney(value: number): string {
        const prefix = value > 0 ? '+' : value < 0 ? '-' : '';
        return `${prefix}${formatMoney(Math.abs(value))}`;
    }

    function formatAccountBalance(value: number): string {
        if (value > 0) return `Owes ${formatMoney(value)}`;
        if (value < 0) return `Credit ${formatMoney(Math.abs(value))}`;
        return 'Clear';
    }

    function formatHistoryDate(value: string): string {
        if (!value) return 'Date unavailable';
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? value : date.toLocaleString('en-GB');
    }
</script>
<DojoRetryDialog bind:decide={dojoRetryDecision} />

<MgmtPage title="Customers">
    <button slot="actions" class="btn btn-primary" on:click={add}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" aria-hidden="true">
            <path d="M12 5v14M5 12h14"></path>
        </svg>
        Add Customer
    </button>

    <div class="search-strip">
        <div class="search-strip-intro customer-search-intro">
            <div class="customer-search-copy">
                <strong class="block text-sm font-black text-text-main">Find customers</strong>
                <span class="mt-1 block text-xs text-text-muted">View loyalty value, Pay Later balances, and customer details.</span>
            </div>
            <div class="customer-account-views" role="group" aria-label="Customer account view">
                <button
                    type="button"
                    class="customer-account-view all"
                    class:active={customerAccountListView === 'all'}
                    aria-pressed={customerAccountListView === 'all'}
                    on:click={() => setCustomerAccountListView('all')}
                >
                    <span>
                        <b>All customers</b>
                        <small>Complete customer list</small>
                    </span>
                    <strong>{allCustomerCount}</strong>
                </button>
                <button
                    type="button"
                    class="customer-account-view outstanding"
                    class:active={customerAccountListView === 'outstanding'}
                    aria-pressed={customerAccountListView === 'outstanding'}
                    title="Show customers who owe money"
                    on:click={() => setCustomerAccountListView('outstanding')}
                >
                    <span>
                        <b>Outstanding credit</b>
                        <small>{outstandingCustomerCount} {outstandingCustomerCount === 1 ? 'customer' : 'customers'} owing</small>
                    </span>
                    <strong>{formatMoney(outstandingBalancePence)}</strong>
                </button>
            </div>
        </div>
        <div class="search-controls">
            <div class="search-primary">
                <SearchField
                    id="customer-search"
                    bind:value={searchQuery}
                    placeholder="Search customers..."
                    ariaLabel="Search customers"
                    keyboardLabel="Open customer search keyboard"
                    clearLabel="Clear customer search"
                    clearVisible={Boolean(searchQuery || appliedSearchQuery)}
                    onKeydown={handleCustomerSearchKeydown}
                    onClear={clearCustomerSearch}
                />
            </div>
            <button class="btn btn-primary search-toolbar-action" disabled={customersLoading} on:click={runCustomerSearch}>Find</button>
            <span class="search-meta">
                {#if customerAccountListView === 'outstanding'}
                    {totalCustomers} / {outstandingCustomerCount} owing
                {:else}
                    {totalCustomers} / {allCustomerCount}
                {/if}
            </span>
        </div>
    </div>

    <div class="customer-table-wrap">
        <table class="tbl customer-table">
            <thead>
                <tr><th>Name</th><th>Postcode</th><th>Loyalty Code</th><th>Points</th><th><span class="customer-value-label-full">Loyalty Value</span><span class="customer-value-label-short">Value</span></th><th>Amount Owed</th><th>Actions</th></tr>
            </thead>
            <tbody>
                {#each pageCustomers as customer (customer.id)}
                    <tr>
                        <td class="font-semibold">{customer.name}</td>
                        <td class="mono">{customer.postcode || '-'}</td>
                        <td class="mono">{customer.loyaltyCode || '-'}</td>
                        <td class="money">{Number(customer.loyaltyPoints || 0).toLocaleString()}</td>
                        <td class="money">{formatMoney(loyaltyCredit(customer.loyaltyPoints, loyaltyConfig))}</td>
                        <td class="money">
                            <span
                                class="balance-badge"
                                class:owes={customerAccountBalance(customer) > 0}
                                class:clear={customerAccountBalance(customer) === 0}
                                class:credit={customerAccountBalance(customer) < 0}
                            >
                                {formatAccountBalance(customerAccountBalance(customer))}
                            </span>
                        </td>
                        <td>
                            <div class="act-row customer-actions">
                                <button
                                    class="btn-icon act-btn account"
                                    class:has-balance={customerAccountBalance(customer) > 0}
                                    title={`Open ${customer.name}'s customer account`}
                                    aria-label={`Open ${customer.name}'s customer account`}
                                    on:click={() => openCustomerAccount(customer)}
                                >
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                                        <path d="M4 7h16v12H4z"></path><path d="M7 7V5h10v2M4 11h16"></path><circle cx="16" cy="15" r="1"></circle>
                                    </svg>
                                </button>
                                <button
                                    class="btn-icon act-btn points"
                                    title={`Open ${customer.name}'s loyalty points and history`}
                                    aria-label={`Open ${customer.name}'s loyalty points and history`}
                                    on:click={() => openLoyalty(customer)}
                                >
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                                        <circle cx="12" cy="8" r="5"></circle>
                                        <path d="m8.5 12-1 9 4.5-2 4.5 2-1-9"></path>
                                    </svg>
                                </button>
                                <button
                                    class="btn-icon act-btn"
                                    title={`Edit ${customer.name}`}
                                    aria-label={`Edit ${customer.name}`}
                                    on:click={() => edit(customer)}
                                >
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                                        <path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path>
                                    </svg>
                                </button>
                                <button
                                    class="btn-icon act-btn danger"
                                    disabled={Boolean(deletingCustomerId)}
                                    title={`Delete ${customer.name}`}
                                    aria-label={`Delete ${customer.name}`}
                                    on:click={() => del(customer)}
                                >
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                                        <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 10v6M14 10v6"></path>
                                    </svg>
                                </button>
                            </div>
                        </td>
                    </tr>
                {/each}
                {#if customersLoading && pageCustomers.length === 0}
                    <tr class="empty-row"><td colspan="7">Loading customers...</td></tr>
                {:else if customersLoadError}
                    <tr class="empty-row"><td colspan="7">Could not load customers: {customersLoadError}</td></tr>
                {:else if allCustomerCount === 0}
                    <tr class="empty-row"><td colspan="7">No customers yet.</td></tr>
                {:else if totalCustomers === 0 && customerAccountListView === 'outstanding' && !appliedSearchQuery}
                    <tr class="empty-row"><td colspan="7">No customers currently have an outstanding balance.</td></tr>
                {:else if totalCustomers === 0 && customerAccountListView === 'outstanding'}
                    <tr class="empty-row"><td colspan="7">No outstanding customer accounts match your search.</td></tr>
                {:else if totalCustomers === 0}
                    <tr class="empty-row"><td colspan="7">No customers match your search.</td></tr>
                {/if}
            </tbody>
        </table>
    </div>

    {#if totalCustomers > PAGE_SIZE}
        <nav class="customer-pagination" aria-label="Customer pages">
            <button
                class="btn-icon"
                disabled={currentPage === 1}
                title="Previous customer page"
                aria-label="Previous customer page"
                on:click={() => goToCustomerPage(currentPage - 1)}
            >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m15 18-6-6 6-6"></path></svg>
            </button>
            <div>
                <strong>Page {currentPage} of {pageCount}</strong>
                <span>{pageStart + 1}-{Math.min(pageStart + PAGE_SIZE, totalCustomers)} of {totalCustomers}</span>
            </div>
            <button
                class="btn-icon"
                disabled={currentPage === pageCount}
                title="Next customer page"
                aria-label="Next customer page"
                on:click={() => goToCustomerPage(currentPage + 1)}
            >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg>
            </button>
        </nav>
    {/if}
</MgmtPage>

<Modal bind:show={showForm} title={editing ? 'Edit Customer' : 'Add Customer'} width="560px" dismissDisabled={saving}>
    <fieldset class="form-grid customer-profile-fields" disabled={saving}>
        <div class="field span-2"><label for="customer-name">Name *</label><input id="customer-name" bind:value={cur.name} placeholder="Full name" /></div>
        <div class="field"><label for="customer-phone">Phone</label><input id="customer-phone" type="tel" bind:value={cur.phone} placeholder="07..." /></div>
        <div class="field"><label for="customer-email">Email</label><input id="customer-email" type="email" bind:value={cur.email} /></div>
        <div class="field"><label for="customer-postcode">Postcode</label><input id="customer-postcode" bind:value={cur.postcode} placeholder="Postcode" /></div>
        <div class="field"><label for="customer-loyalty-code">Loyalty Code</label><input id="customer-loyalty-code" maxlength={LOYALTY_CODE_MAX_LENGTH} spellcheck="false" bind:value={cur.loyaltyCode} /></div>
        <div class="field"><span class="field-label">Current Points</span><div class="flat-input readonly-value">{Number(cur.loyaltyPoints || 0).toLocaleString()}</div></div>
        <div class="field"><span class="field-label">Loyalty Value</span><div class="flat-input readonly-value money">{formatMoney(loyaltyCredit(cur.loyaltyPoints || 0, loyaltyConfig))}</div></div>
        <div class="field span-2"><span class="field-label">Loyalty Barcode</span><Code39Barcode value={cur.loyaltyCode || ''} /></div>
        <div class="field span-2"><label for="customer-notes">Notes</label><textarea id="customer-notes" bind:value={cur.notes}></textarea></div>
    </fieldset>
    <svelte:fragment slot="footer">
        <button class="btn btn-secondary" disabled={saving} on:click={() => showForm = false}>Cancel</button>
        <button class="btn btn-primary" disabled={saving} on:click={save}>{saving ? 'Saving...' : 'Save Customer'}</button>
    </svelte:fragment>
</Modal>

<Modal
    bind:show={showLoyalty}
    title={loyaltyCustomer
        ? loyaltyView === 'adjust' ? `Adjust Points - ${loyaltyCustomer.name}` : `Loyalty - ${loyaltyCustomer.name}`
        : 'Loyalty History'}
    width="620px"
    dismissDisabled={loyaltyAdjustmentSaving}
>
    {#if loyaltyHistoryError}<p class="loyalty-live-error" role="alert">{loyaltyHistoryError}</p>{/if}
    {#if loyaltyCustomer}
        {#if loyaltyCurrentPoints < 0}<p class="loyalty-negative-note">This customer has a negative points balance, which can happen after a refund. It is shown as recorded. Use Add or Set balance to correct it to zero or more if needed.</p>{/if}
        {#if loyaltyView === 'history'}
            <div class="loyalty-summary">
                <div><span>Current points</span><strong>{Number(loyaltyCustomer.loyaltyPoints || 0).toLocaleString()}</strong></div>
                <div><span>Loyalty value</span><strong>{formatMoney(loyaltyCredit(loyaltyCustomer.loyaltyPoints, loyaltyConfig))}</strong></div>
                <div><span>Loyalty code</span><strong class="mono">{loyaltyCustomer.loyaltyCode || '-'}</strong></div>
            </div>
            <div class="loyalty-history-heading">
                <h3>Recent points activity</h3>
                <span>Newest first</span>
            </div>
            {#if loyaltyHistoryLoading}
                <p class="loyalty-empty">Loading loyalty history...</p>
            {:else if loyaltyHistory.length === 0 && !loyaltyHistoryError}
                <p class="loyalty-empty">
                    {loyaltyCustomer.loyaltyPoints !== 0
                        ? 'This balance was imported or created before detailed points history was available.'
                        : 'No points activity yet.'}
                </p>
            {:else}
                <div class="loyalty-history-list">
                    {#each loyaltyHistory as entry (entry.id)}
                        <article>
                            <div>
                                <strong>{loyaltyReason(entry.reason)}</strong>
                                {#if manualLoyaltyReasonNote(entry.reason)}
                                    <small class="loyalty-history-note">{manualLoyaltyReasonNote(entry.reason)}</small>
                                {/if}
                                <span>{formatHistoryDate(entry.createdAt)}{entry.orderNumber ? ` - Receipt ${entry.orderNumber}` : ''}</span>
                            </div>
                            <b class:negative={entry.pointsChange < 0}>{entry.pointsChange > 0 ? '+' : ''}{entry.pointsChange.toLocaleString()}</b>
                        </article>
                    {/each}
                </div>
            {/if}
        {:else}
            <div class="loyalty-adjustment-form">
                <section class="loyalty-adjustment-current" aria-label="Current loyalty balance">
                    <div>
                        <span>Customer</span>
                        <strong>{loyaltyCustomer.name}</strong>
                        <small class="mono">{loyaltyCustomer.loyaltyCode || 'No loyalty code'}</small>
                    </div>
                    <div>
                        <span>Current balance</span>
                        <strong>{loyaltyCurrentPoints.toLocaleString()} points</strong>
                        <small>{formatMoney(loyaltyCredit(loyaltyCurrentPoints, loyaltyConfig))} loyalty value</small>
                    </div>
                </section>

                <fieldset class="loyalty-adjustment-fieldset">
                    <legend>Adjustment type</legend>
                    <div class="loyalty-adjustment-modes">
                        <button
                            type="button"
                            class:active={loyaltyAdjustmentMode === 'add'}
                            aria-pressed={loyaltyAdjustmentMode === 'add'}
                            disabled={loyaltyAdjustmentSaving}
                            on:click={() => selectLoyaltyAdjustmentMode('add')}
                        >
                            <strong>Add</strong>
                            <small>Missing or goodwill points</small>
                        </button>
                        <button
                            type="button"
                            class:active={loyaltyAdjustmentMode === 'remove'}
                            aria-pressed={loyaltyAdjustmentMode === 'remove'}
                            disabled={loyaltyAdjustmentSaving || loyaltyCurrentPoints < 0}
                            on:click={() => selectLoyaltyAdjustmentMode('remove')}
                        >
                            <strong>Remove</strong>
                            <small>Correct points added by mistake</small>
                        </button>
                        <button
                            type="button"
                            class:active={loyaltyAdjustmentMode === 'set'}
                            aria-pressed={loyaltyAdjustmentMode === 'set'}
                            disabled={loyaltyAdjustmentSaving}
                            on:click={() => selectLoyaltyAdjustmentMode('set')}
                        >
                            <strong>Set balance</strong>
                            <small>Restore an exact balance</small>
                        </button>
                    </div>
                </fieldset>

                <div class="field loyalty-points-field">
                    <label for="loyalty-adjustment-points">{loyaltyAdjustmentInputLabel}</label>
                    <input
                        id="loyalty-adjustment-points"
                        type="text"
                        inputmode="numeric"
                        pattern="[0-9]*"
                        autocomplete="off"
                        placeholder={loyaltyAdjustmentMode === 'set' ? 'Enter the correct total' : 'Enter whole points'}
                        bind:value={loyaltyPointsDraft}
                        disabled={loyaltyAdjustmentSaving}
                        aria-describedby="loyalty-adjustment-points-help"
                    />
                    <small
                        id="loyalty-adjustment-points-help"
                        class:error={Boolean(loyaltyAdjustment.error) || (loyaltyAdjustmentAttempted && loyaltyAdjustment.enteredPoints === null)}
                    >
                        {loyaltyAdjustment.error
                            || (loyaltyAdjustmentAttempted && loyaltyAdjustment.enteredPoints === null
                                ? 'Enter the points for this adjustment'
                                : 'Use whole points only.')}
                    </small>
                </div>

                <div class="field loyalty-reason-field">
                    <label for="loyalty-adjustment-reason">Reason *</label>
                    <input
                        id="loyalty-adjustment-reason"
                        type="text"
                        maxlength={MAX_CUSTOMER_LOYALTY_REASON_LENGTH}
                        placeholder="For example: Restored after till reset"
                        bind:value={loyaltyReasonDraft}
                        disabled={loyaltyAdjustmentSaving}
                        aria-describedby="loyalty-adjustment-reason-help"
                    />
                    <div class="loyalty-field-help" id="loyalty-adjustment-reason-help">
                        <small class:error={Boolean(loyaltyReasonDraft) && Boolean(loyaltyAdjustmentReasonError)}>
                            {loyaltyReasonDraft && loyaltyAdjustmentReasonError
                                ? loyaltyAdjustmentReasonError
                                : 'Required. This explanation will stay in the loyalty history.'}
                        </small>
                        <small>{loyaltyReasonDraft.length}/{MAX_CUSTOMER_LOYALTY_REASON_LENGTH}</small>
                    </div>
                </div>

                <section
                    class="loyalty-adjustment-preview"
                    class:increase={loyaltyAdjustment.pointsChange > 0}
                    class:decrease={loyaltyAdjustment.pointsChange < 0}
                    aria-label="Loyalty adjustment preview"
                    aria-live="polite"
                >
                    <div>
                        <span>Current</span>
                        <strong>{loyaltyCurrentPoints.toLocaleString()}</strong>
                        <small>{formatMoney(loyaltyCredit(loyaltyCurrentPoints, loyaltyConfig))}</small>
                    </div>
                    <div class="loyalty-adjustment-change">
                        <span>Change</span>
                        <strong>{loyaltyAdjustment.enteredPoints === null ? '—' : formatSignedPoints(loyaltyAdjustment.pointsChange)}</strong>
                        <small>points</small>
                    </div>
                    <div>
                        <span>New balance</span>
                        <strong>{loyaltyAdjustment.nextPoints.toLocaleString()}</strong>
                        <small>{formatMoney(loyaltyCredit(loyaltyAdjustment.nextPoints, loyaltyConfig))}</small>
                    </div>
                </section>

                <div class="loyalty-append-only-note">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3 4 7v5c0 5 3.4 8 8 9 4.6-1 8-4 8-9V7l-8-4Z"></path><path d="m9 12 2 2 4-4"></path></svg>
                    <span>This will add a permanent correction to the loyalty history. Previous sales and points activity will not be edited.</span>
                </div>
            </div>
        {/if}
    {/if}
    <svelte:fragment slot="footer">
        <div class="loyalty-modal-actions">
            {#if loyaltyView === 'history'}
                {#if canAdjustCustomerLoyalty}
                    <button class="btn btn-primary" disabled={loyaltyHistoryLoading || !!loyaltyHistoryError} on:click={openLoyaltyAdjustment}>Adjust Points</button>
                {/if}
                <button class="btn btn-secondary" disabled={loyaltyHistoryLoading} on:click={refreshLoyaltyHistory}>{loyaltyHistoryLoading ? 'Refreshing...' : 'Refresh'}</button>
                <button class="btn btn-secondary" on:click={() => showLoyalty = false}>Close</button>
            {:else}
                <button class="btn btn-secondary" disabled={loyaltyAdjustmentSaving} on:click={cancelLoyaltyAdjustment}>Back</button>
                <button class="btn btn-primary" disabled={!loyaltyAdjustmentReady} on:click={saveLoyaltyAdjustment}>{loyaltyAdjustmentSubmitLabel}</button>
            {/if}
        </div>
    </svelte:fragment>
</Modal>

<Modal
    bind:show={showAccount}
    title={accountCustomer ? `Customer Account - ${accountCustomer.name}` : 'Customer Account'}
    width="860px"
    height="min(780px, calc(100vh - 40px))"
    dismissDisabled={accountSaving}
>
    {#if accountLoading && !customerAccount}
        <div class="account-loading">Loading customer account...</div>
    {:else if accountCustomer && customerAccount}
        <section class="account-hero">
            <div>
                <span class="account-eyebrow">{accountBalance > 0 ? 'Amount currently owed' : accountBalance < 0 ? 'Customer credit' : 'Account balance'}</span>
                <strong class:zero={accountBalance === 0} class:credit={accountBalance < 0}>{formatMoney(Math.abs(accountBalance))}</strong>
                <small>Independent of receipt history</small>
            </div>
            <div class="account-facts">
                <article>
                    <span>Status</span>
                    <b class:active={customerAccount.isEnabled}>{customerAccount.isEnabled ? 'Active' : 'On hold'}</b>
                </article>
                <article>
                    <span>Account limit</span>
                    <b>{accountLimit > 0 ? formatMoney(accountLimit) : 'No limit'}</b>
                </article>
                <article>
                    <span>Available</span>
                    <b>{customerAccount.isEnabled ? (accountLimit > 0 ? formatMoney(accountAvailable) : 'No limit') : 'Pay Later blocked'}</b>
                </article>
            </div>
        </section>

        <div class="account-safety-note">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3 4 7v5c0 5 3.4 8 8 9 4.6-1 8-4 8-9V7l-8-4Z"></path><path d="m9 12 2 2 4-4"></path></svg>
            <span>Deleting sales history does not delete this balance or account activity.</span>
        </div>

        <div class="account-actions">
            {#if $deviceOperatingMode !== 'back_office'}
                <button
                    class="btn btn-primary account-action"
                    disabled={!canTakeAccountPayment || !$currentShiftId || accountBalance <= 0 || accountSaving}
                    title={!$currentShiftId ? 'Open a till session to take payment' : ''}
                    on:click={() => openAccountEntry('payment')}
                >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 7h18v10H3z"></path><path d="M3 10h18M7 14h3"></path></svg>
                    Take Payment
                </button>
            {/if}
            {#if canAdjustCustomerAccount}
                {#if accountEntryTotal === 0 && accountBalance === 0}
                    <button class="btn btn-secondary account-action" disabled={accountSaving} on:click={() => openAccountEntry('opening')}>Opening Balance</button>
                {/if}
                <button class="btn btn-secondary account-action" disabled={accountSaving} on:click={() => openAccountEntry('increase')}>Increase Owed</button>
                <button class="btn btn-secondary account-action" disabled={accountSaving} on:click={() => openAccountEntry('reduce')}>Reduce / Add Credit</button>
            {/if}
        </div>

        <section class="account-settings">
            <div class="account-section-heading">
                <div><h3>Pay Later settings</h3><p>Control new account charges without changing the existing balance.</p></div>
                {#if !canAdjustCustomerAccount}<span>Manager access required</span>{/if}
            </div>
            <div class="account-settings-grid">
                <label class="account-status-control" class:checked={accountEnabledDraft}>
                    <input type="checkbox" bind:checked={accountEnabledDraft} disabled={!canAdjustCustomerAccount || accountSaving} />
                    <span class="account-switch" aria-hidden="true"><i></i></span>
                    <span><b>{accountEnabledDraft ? 'Pay Later active' : 'Account on hold'}</b><small>{accountEnabledDraft ? 'New purchases can be charged to this account.' : 'Existing activity is kept, but new charges are blocked.'}</small></span>
                </label>
                <div class="field account-limit-field">
                    <label for="customer-account-limit">Account limit (£)</label>
                    <input
                        id="customer-account-limit"
                        type="text"
                        inputmode="decimal"
                        placeholder="No limit"
                        bind:value={accountLimitDraft}
                        disabled={!canAdjustCustomerAccount || accountSaving}
                    />
                    <small>Leave blank or enter 0 for no limit.</small>
                </div>
                {#if canAdjustCustomerAccount}
                    <button class="btn btn-secondary account-save-settings" disabled={accountSaving} on:click={saveAccountConfig}>
                        {accountSaving ? 'Saving...' : 'Save Settings'}
                    </button>
                {/if}
            </div>
        </section>

        <section class="account-history">
            <div class="account-section-heading">
                <div><h3>Account activity</h3><p>Append-only statement · newest first</p></div>
                <span>{accountEntryTotal} {accountEntryTotal === 1 ? 'entry' : 'entries'}</span>
            </div>
            {#if accountLoading}
                <div class="account-empty">Refreshing activity...</div>
            {:else if accountEntries.length === 0}
                <div class="account-empty"><strong>No account activity yet</strong><span>Enable Pay Later or add an opening balance to begin.</span></div>
            {:else}
                <div class="account-entry-list">
                    {#each accountEntries as entry (entry.id)}
                        <article>
                            <div class="account-entry-copy">
                                <strong>{accountEntryLabel(entry)}</strong>
                                <span>{accountEntryReference(entry)}</span>
                                {#if entry.description}<small>{entry.description}</small>{/if}
                            </div>
                            <div class="account-entry-side">
                                <div class="account-entry-amount" class:increase={entry.amountPence > 0} class:decrease={entry.amountPence < 0}>
                                    <b>{formatSignedMoney(entry.amountPence)}</b>
                                    <span>{formatAccountBalance(entry.balanceAfterPence)}</span>
                                </div>
                                {#if entry.entryType === 'payment'}
                                    <button
                                        type="button"
                                        class="account-print-button"
                                        disabled={Boolean(accountPrintingEntryId)}
                                        title={`Print acknowledgement ${entry.receiptNumber}`}
                                        on:click={() => printAccountPaymentAcknowledgement(entry)}
                                    >
                                        {accountPrintingEntryId === entry.id ? 'Printing...' : 'Print acknowledgement'}
                                    </button>
                                {/if}
                            </div>
                        </article>
                    {/each}
                </div>
                {#if accountEntryTotal > accountEntries.length}
                    <div class="account-history-limit">
                        <span>Showing {accountEntries.length} of {accountEntryTotal} entries.</span>
                        <button
                            type="button"
                            class="btn btn-secondary"
                            disabled={accountHistoryLoadingMore}
                            on:click={loadMoreCustomerAccountEntries}
                        >
                            {accountHistoryLoadingMore ? 'Loading...' : 'Load older activity'}
                        </button>
                    </div>
                {/if}
            {/if}
        </section>
    {:else}
        <div class="account-loading">Customer account unavailable.</div>
    {/if}
    <svelte:fragment slot="footer">
        <button class="btn btn-secondary" disabled={accountLoading || accountSaving} on:click={refreshCustomerAccount}>{accountLoading ? 'Refreshing...' : 'Refresh'}</button>
        <button class="btn btn-primary" disabled={accountSaving} on:click={() => showAccount = false}>Close</button>
    </svelte:fragment>
</Modal>

<Modal
    bind:show={showAccountEntry}
    title={accountEntryMode === 'payment' ? 'Take Account Payment'
        : accountEntryMode === 'opening' ? 'Add Opening Balance'
        : accountEntryMode === 'increase' ? 'Increase Amount Owed'
        : 'Reduce Owed / Add Credit'}
    width="560px"
    dismissDisabled={accountSaving || accountManagedCardApproved}
>
    {#if customerAccount && accountCustomer}
        <div class="entry-balance-strip">
            <span>{accountCustomer.name}</span>
            <div><small>Current account</small><strong class:credit={accountBalance < 0} class:clear={accountBalance === 0}>{formatAccountBalance(accountBalance)}</strong></div>
        </div>

        <div class="account-entry-form">
            <div class="field">
                <label for="account-entry-amount">Amount (£) *</label>
                <div class="money-input"><span>£</span><input id="account-entry-amount" type="text" inputmode="decimal" placeholder="0.00" bind:value={accountAmountDraft} disabled={accountSaving || accountManagedCardApproved || (accountPaymentMethod === 'card' && accountExternalCardConfirmed)} /></div>
            </div>

            {#if accountEntryMode === 'payment'}
                <fieldset class="payment-method-field">
                    <legend>Payment method *</legend>
                    <div class="payment-method-options">
                        <button type="button" disabled={accountSaving || accountManagedCardApproved} class:active={accountPaymentMethod === 'cash'} aria-pressed={accountPaymentMethod === 'cash'} on:click={() => selectAccountPaymentMethod('cash')}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2"></rect><circle cx="12" cy="12" r="2"></circle><path d="M7 9h.01M17 15h.01"></path></svg>
                            Cash
                        </button>
                        <button
                            type="button"
                            disabled={accountSaving || accountManagedCardApproved || accountCardConfigState !== 'loaded'}
                            title={accountCardConfigState === 'loading'
                                ? 'Loading card-terminal settings'
                                : accountCardConfigState === 'error'
                                    ? 'Reload this screen to load card-terminal settings'
                                    : undefined}
                            class:active={accountPaymentMethod === 'card'}
                            aria-pressed={accountPaymentMethod === 'card'}
                            on:click={() => selectAccountPaymentMethod('card')}
                        >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M3 10h18M7 15h3"></path></svg>
                            Card
                        </button>
                        <button type="button" disabled={accountSaving || accountManagedCardApproved} class:active={accountPaymentMethod === 'other'} aria-pressed={accountPaymentMethod === 'other'} on:click={() => selectAccountPaymentMethod('other')}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 7h16M6 3h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"></path><path d="M8 12h8M8 16h5"></path></svg>
                            Other
                        </button>
                    </div>
                </fieldset>
                {#if accountCardConfigState !== 'loaded'}
                    <div class="account-terminal-status" role="status">
                        {accountCardConfigState === 'loading'
                            ? 'Loading card-terminal settings… Card payments will unlock when this check finishes.'
                            : 'Card-terminal settings could not be loaded. Reload this screen before taking a card payment.'}
                    </div>
                {/if}
                <div class="account-payment-note">
                    {#if accountPaymentMethod === 'cash'}
                        This payment will be added to the active till's expected cash.
                    {:else if accountPaymentMethod === 'other'}
                        Use this for a bank transfer, cheque, or another non-cash/card payment. It is reported separately and does not change expected cash or card totals. A reference is required.
                    {:else if accountManagedCardApproved}
                        <strong>Card approved.</strong> Press Record Payment to retry saving the same account entry. The terminal will not be charged again.
                    {:else if accountCardFlow === 'dojo'}
                        The exact amount will be sent to Dojo. The account payment is recorded only after Dojo confirms the matching captured transaction.
                    {:else if accountCardFlow === 'sumup'}
                        The exact amount will be sent to SumUp. The account payment is recorded only after SumUp confirms the matching successful transaction.
                    {:else if accountCardFlow === 'unavailable'}
                        <strong>The configured card provider is not ready.</strong> Fix its payment settings before taking this payment.
                    {:else}
                        Use this only after an external card terminal approves the exact amount. A confirmation and terminal reference are required.
                    {/if}
                </div>
                {#if accountPaymentMethod === 'card' && accountCardFlow === 'external'}
                    <label class="external-card-confirmation">
                        <input type="checkbox" bind:checked={accountExternalCardConfirmed} disabled={accountSaving} />
                        <span>
                            <b>I confirm the external terminal approved this exact payment</b>
                            <small>The account record does not charge the card. Keep the terminal slip for reconciliation.</small>
                        </span>
                    </label>
                {/if}
                {#if accountPaymentMethod === 'card' && accountTerminalStatus}
                    <div class="account-terminal-status" aria-live="polite">{accountTerminalStatus}</div>
                {/if}
            {/if}

            <div class="field">
                <label for="account-entry-reason">{accountEntryMode === 'payment' ? 'Note' : 'Reason *'}</label>
                <textarea
                    id="account-entry-reason"
                    rows="3"
                    placeholder={accountEntryMode === 'payment' ? 'Optional payment note' : 'Explain why this balance is changing'}
                    bind:value={accountReasonDraft}
                    disabled={accountSaving || accountManagedCardApproved}
                ></textarea>
            </div>
            <div class="field">
                <label for="account-entry-reference">
                    {accountEntryMode === 'payment' && accountPaymentMethod === 'card' && accountCardFlow === 'external'
                        ? 'External terminal reference *'
                        : accountEntryMode === 'payment' && accountPaymentMethod === 'other'
                            ? 'Payment reference *'
                            : 'Reference'}
                </label>
                <input
                    id="account-entry-reference"
                    placeholder={accountEntryMode === 'payment' && accountPaymentMethod === 'card'
                        ? accountCardFlow === 'sumup' || accountCardFlow === 'dojo'
                            ? 'Added automatically after approval'
                            : 'Enter the approval or terminal reference'
                        : accountEntryMode === 'payment' && accountPaymentMethod === 'other'
                            ? 'Bank transfer, cheque, or other reference'
                        : 'Optional internal reference'}
                    bind:value={accountReferenceDraft}
                    disabled={accountSaving || accountManagedCardApproved || (accountEntryMode === 'payment'
                        && accountPaymentMethod === 'card'
                        && (accountCardFlow === 'sumup' || accountCardFlow === 'dojo' || accountCardFlow === 'unavailable'))}
                />
            </div>

            {#if accountEntryMode !== 'payment'}
                <div class="append-only-note">
                    This does not edit previous entries. A new, permanent adjustment will be added to the statement.
                    {accountEntryMode === 'reduce' ? ' Any amount beyond what is owed becomes customer credit.' : ''}
                </div>
            {/if}
        </div>
    {/if}
    <svelte:fragment slot="footer">
        <button class="btn btn-secondary" disabled={accountSaving || accountManagedCardApproved} on:click={() => showAccountEntry = false}>Cancel</button>
        <button
            class="btn btn-primary"
            disabled={accountSaving
                || (accountEntryMode === 'payment'
                    ? !canTakeAccountPayment
                        || !$currentShiftId
                        || (accountPaymentMethod === 'card' && !accountCardPaymentReady)
                        || !accountOtherPaymentReady
                    : !canAdjustCustomerAccount)}
            on:click={saveAccountEntry}
        >
            {accountSaving
                ? accountTerminalStatus || 'Recording...'
                : accountEntryMode === 'payment'
                    && accountPaymentMethod === 'card'
                    && (accountCardFlow === 'sumup' || accountCardFlow === 'dojo')
                    && !accountManagedCardApproved
                    ? 'Take Card Payment'
                    : accountEntryMode === 'payment' ? 'Record Payment' : 'Post Adjustment'}
        </button>
    </svelte:fragment>
</Modal>

<ConfirmDialog
    bind:show={showDeleteConfirm}
    title="Delete Customer"
    message={`Delete ${customerToDelete?.name || 'this customer'}? This cannot be undone.`}
    confirmText="Delete Customer"
    variant="danger"
    on:confirm={confirmCustomerDelete}
    on:cancel={cancelCustomerDelete}
/>

<ConfirmDialog
    bind:show={showDojoSignatureConfirm}
    title="Verify Customer Signature"
    message="Compare the customer's signature with the card or merchant receipt, then accept or reject it. Dojo is still checking the payment while this dialog is open."
    confirmText="Accept Signature"
    cancelText="Reject Signature"
    dismissDisabled={true}
    on:confirm={() => finishDojoSignatureDecision(true)}
    on:cancel={() => finishDojoSignatureDecision(false)}
/>

<style>
    .customer-profile-fields { border:0; padding:0; margin:0; min-width:0; }
    .loyalty-live-error { padding:10px 12px; border:1px solid var(--danger); border-radius:7px; color:var(--danger); font-size:.82rem; line-height:1.45; overflow-wrap:anywhere; }
    .loyalty-negative-note { padding:10px 12px; border:1px solid var(--border-flat); border-radius:7px; color:var(--warning); font-size:.8rem; line-height:1.45; }
    .customer-search-intro { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
    .customer-search-copy { min-width: 0; }
    .customer-account-views { flex: 0 0 auto; display: grid; grid-template-columns: minmax(160px, .8fr) minmax(244px, 1.2fr); gap: .45rem; }
    .customer-account-view { min-height: 48px; padding: .4rem .65rem; display: flex; align-items: center; justify-content: space-between; gap: .65rem; color: var(--text-muted); border: 1px solid var(--border-flat); border-radius: .5rem; background: var(--bg-card); text-align: left; }
    .customer-account-view:hover { border-color: var(--accent-primary); background: var(--bg-card-hover); }
    .customer-account-view > span { min-width: 0; display: flex; flex-direction: column; gap: .08rem; line-height: 1.15; }
    .customer-account-view b { color: inherit; font-size: .75rem; font-weight: 850; white-space: nowrap; }
    .customer-account-view small { overflow: hidden; color: var(--text-muted); font-size: .62rem; font-weight: 750; text-overflow: ellipsis; white-space: nowrap; }
    .customer-account-view > strong { flex: 0 0 auto; color: var(--text-main); font-size: .9rem; font-variant-numeric: tabular-nums; }
    .customer-account-view.active { color: var(--accent-primary); border-color: var(--accent-primary); background: color-mix(in srgb, var(--accent-primary) 9%, var(--bg-card)); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent-primary) 40%, transparent); }
    .customer-account-view.outstanding { color: var(--danger); }
    .customer-account-view.outstanding > strong { color: var(--danger); }
    .customer-account-view.outstanding.active { border-color: var(--danger); background: color-mix(in srgb, var(--danger) 9%, var(--bg-card)); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--danger) 36%, transparent); }
    .customer-table-wrap { min-width: 0; overflow-x: auto; }
    .customer-table { min-width: 1020px; }
    .customer-value-label-short { display: none; }
    .customer-table tbody tr { height: 58px; }
    .customer-actions { flex-wrap: nowrap; }
    .customer-actions .btn-icon, .customer-pagination .btn-icon { width: 44px; height: 44px; min-width: 44px; }
    .customer-actions svg, .customer-pagination svg { width: 19px; height: 19px; }
    .customer-actions .points { color: var(--warning); }
    .customer-actions .account { color: var(--success); }
    .customer-actions .account.has-balance { color: var(--danger); background: color-mix(in srgb, var(--danger) 9%, var(--bg-card)); }
    .balance-badge { min-width: 64px; padding: .36rem .56rem; display: inline-flex; justify-content: center; border: 1px solid var(--border-flat); border-radius: 999px; font-size: .76rem; font-weight: 900; white-space: nowrap; }
    .balance-badge.clear { color: var(--success); background: color-mix(in srgb, var(--success) 9%, var(--bg-card)); }
    .balance-badge.owes { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, var(--border-flat)); background: color-mix(in srgb, var(--danger) 10%, var(--bg-card)); }
    .balance-badge.credit { color: var(--accent-primary); border-color: color-mix(in srgb, var(--accent-primary) 40%, var(--border-flat)); background: color-mix(in srgb, var(--accent-primary) 9%, var(--bg-card)); }
    .customer-pagination { margin: auto 1rem 1rem; padding-top: .8rem; display: flex; align-items: center; justify-content: center; gap: .8rem; border-top: 1px solid var(--border-flat); }
    .customer-pagination div { min-width: 150px; display: flex; flex-direction: column; align-items: center; color: var(--text-main); }
    .customer-pagination span { margin-top: .1rem; color: var(--text-muted); font-size: .75rem; }
    .field-label { color: var(--text-muted); font-size: .75rem; font-weight: 800; text-transform: uppercase; }
    .readonly-value { display: flex; align-items: center; color: var(--text-main); font-weight: 800; }
    .loyalty-summary { display: grid; grid-template-columns: repeat(3, 1fr); border-block: 1px solid var(--border-flat); }
    .loyalty-summary div { min-width: 0; padding: .8rem; display: flex; flex-direction: column; gap: .25rem; }
    .loyalty-summary div + div { border-left: 1px solid var(--border-flat); }
    .loyalty-summary span { color: var(--text-muted); font-size: .74rem; font-weight: 800; text-transform: uppercase; }
    .loyalty-summary strong { overflow-wrap: anywhere; color: var(--text-main); font-size: 1.05rem; }
    .loyalty-history-heading { margin: 1rem 0 .55rem; display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
    .loyalty-history-heading h3 { margin: 0; color: var(--text-main); font-size: 1rem; }
    .loyalty-history-heading span { color: var(--text-muted); font-size: .76rem; }
    .loyalty-history-list { display: grid; border-top: 1px solid var(--border-flat); }
    .loyalty-history-list article { padding: .75rem .25rem; display: flex; align-items: center; justify-content: space-between; gap: 1rem; border-bottom: 1px solid var(--border-flat); }
    .loyalty-history-list article div { min-width: 0; display: flex; flex-direction: column; gap: .15rem; }
    .loyalty-history-list article span { color: var(--text-muted); font-size: .76rem; }
    .loyalty-history-list .loyalty-history-note { color: var(--text-main); font-size: .78rem; line-height: 1.35; overflow-wrap: anywhere; }
    .loyalty-history-list article b { color: var(--success); font-size: 1rem; }
    .loyalty-history-list article b.negative { color: var(--danger); }
    .loyalty-empty { padding: 1.5rem .5rem; color: var(--text-muted); text-align: center; }
    .loyalty-modal-actions { width: 100%; display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: .65rem; }
    .loyalty-adjustment-form { display: grid; gap: .9rem; }
    .loyalty-adjustment-current { overflow: hidden; display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(190px, .9fr); border: 1px solid var(--border-flat); border-radius: .65rem; background: var(--bg-panel); }
    .loyalty-adjustment-current > div { min-width: 0; padding: .8rem .9rem; display: flex; flex-direction: column; justify-content: center; gap: .16rem; }
    .loyalty-adjustment-current > div + div { align-items: flex-end; border-left: 1px solid var(--border-flat); text-align: right; }
    .loyalty-adjustment-current span, .loyalty-adjustment-preview span { color: var(--text-muted); font-size: .68rem; font-weight: 850; letter-spacing: .025em; text-transform: uppercase; }
    .loyalty-adjustment-current strong { overflow: hidden; color: var(--text-main); font-size: .98rem; text-overflow: ellipsis; white-space: nowrap; }
    .loyalty-adjustment-current small { overflow: hidden; color: var(--text-muted); font-size: .72rem; text-overflow: ellipsis; white-space: nowrap; }
    .loyalty-adjustment-fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
    .loyalty-adjustment-fieldset legend { margin-bottom: .45rem; color: var(--text-muted); font-size: .75rem; font-weight: 800; text-transform: uppercase; }
    .loyalty-adjustment-modes { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .55rem; }
    .loyalty-adjustment-modes button { min-width: 0; min-height: 62px; padding: .55rem .65rem; display: flex; flex-direction: column; align-items: flex-start; justify-content: center; gap: .12rem; color: var(--text-main); border: 1px solid var(--border-flat); border-radius: .5rem; background: var(--bg-panel); text-align: left; cursor: pointer; }
    .loyalty-adjustment-modes button:hover:not(:disabled) { border-color: var(--accent-primary); background: var(--bg-card-hover); }
    .loyalty-adjustment-modes button.active { color: var(--accent-primary); border-color: var(--accent-primary); background: color-mix(in srgb, var(--accent-primary) 8%, var(--bg-card)); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent-primary) 45%, transparent); }
    .loyalty-adjustment-modes button:focus-visible { outline: 3px solid color-mix(in srgb, var(--accent-primary) 45%, transparent); outline-offset: 2px; }
    .loyalty-adjustment-modes button:disabled { opacity: .65; cursor: default; }
    .loyalty-adjustment-modes strong { font-size: .82rem; }
    .loyalty-adjustment-modes small { color: var(--text-muted); font-size: .65rem; line-height: 1.25; }
    .loyalty-points-field, .loyalty-reason-field { margin: 0; }
    .loyalty-points-field input { min-height: 50px; font-size: 1.15rem; font-weight: 850; font-variant-numeric: tabular-nums; }
    .loyalty-points-field > small { color: var(--text-muted); font-size: .68rem; }
    .loyalty-points-field > small.error, .loyalty-field-help small.error { color: var(--danger); }
    .loyalty-field-help { display: flex; align-items: flex-start; justify-content: space-between; gap: .75rem; color: var(--text-muted); }
    .loyalty-field-help small { font-size: .68rem; line-height: 1.35; }
    .loyalty-field-help small:first-child { min-width: 0; }
    .loyalty-field-help small:last-child { flex: 0 0 auto; font-variant-numeric: tabular-nums; }
    .loyalty-adjustment-preview { overflow: hidden; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border: 1px solid var(--border-flat); border-radius: .6rem; background: var(--bg-panel); }
    .loyalty-adjustment-preview > div { min-width: 0; padding: .7rem .75rem; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .15rem; text-align: center; }
    .loyalty-adjustment-preview > div + div { border-left: 1px solid var(--border-flat); }
    .loyalty-adjustment-preview strong { color: var(--text-main); font-size: 1.05rem; font-variant-numeric: tabular-nums; }
    .loyalty-adjustment-preview small { color: var(--text-muted); font-size: .7rem; }
    .loyalty-adjustment-preview.increase .loyalty-adjustment-change strong { color: var(--success); }
    .loyalty-adjustment-preview.decrease .loyalty-adjustment-change strong { color: var(--danger); }
    .loyalty-append-only-note { padding: .65rem .75rem; display: flex; align-items: flex-start; gap: .55rem; color: var(--text-muted); font-size: .72rem; line-height: 1.4; border: 1px solid color-mix(in srgb, var(--warning) 40%, var(--border-flat)); border-radius: .45rem; background: color-mix(in srgb, var(--warning) 7%, var(--bg-card)); }
    .loyalty-append-only-note svg { width: 19px; height: 19px; flex: 0 0 19px; color: var(--warning); }
    :global(.back-office-route) .loyalty-adjustment-form { gap: .65rem; }
    :global(.back-office-route) .loyalty-adjustment-current > div { padding: .58rem .7rem; }
    :global(.back-office-route) .loyalty-adjustment-modes button { min-height: 48px; padding: .4rem .55rem; }
    :global(.back-office-route) .loyalty-points-field input { min-height: 40px; }
    :global(.back-office-route) .loyalty-adjustment-preview > div { padding: .52rem .6rem; }
    :global(.back-office-route) .loyalty-append-only-note { padding: .5rem .65rem; }
    .account-loading { min-height: 220px; display: grid; place-items: center; color: var(--text-muted); font-weight: 800; }
    .account-hero { overflow: hidden; display: grid; grid-template-columns: minmax(210px, .72fr) minmax(0, 1.28fr); border: 1px solid var(--border-flat); border-radius: .7rem; background: var(--bg-panel); }
    .account-hero > div:first-child { padding: 1.05rem 1.15rem; display: flex; flex-direction: column; justify-content: center; border-right: 1px solid var(--border-flat); }
    .account-eyebrow { color: var(--text-muted); font-size: .7rem; font-weight: 900; letter-spacing: .03em; text-transform: uppercase; }
    .account-hero > div:first-child strong { margin: .15rem 0; color: var(--danger); font-size: clamp(1.75rem, 4vw, 2.5rem); line-height: 1.1; }
    .account-hero > div:first-child strong.zero { color: var(--success); }
    .account-hero > div:first-child strong.credit { color: var(--accent-primary); }
    .account-hero > div:first-child small { color: var(--text-muted); font-size: .72rem; }
    .account-facts { min-width: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .account-facts article { min-width: 0; padding: .9rem; display: flex; flex-direction: column; justify-content: center; gap: .3rem; }
    .account-facts article + article { border-left: 1px solid var(--border-flat); }
    .account-facts span { color: var(--text-muted); font-size: .68rem; font-weight: 850; text-transform: uppercase; }
    .account-facts b { overflow-wrap: anywhere; color: var(--text-main); font-size: .88rem; }
    .account-facts b.active { color: var(--success); }
    .account-safety-note { margin-top: .7rem; padding: .65rem .75rem; display: flex; align-items: center; gap: .55rem; color: var(--text-muted); font-size: .76rem; font-weight: 750; border: 1px solid color-mix(in srgb, var(--success) 35%, var(--border-flat)); border-radius: .45rem; background: color-mix(in srgb, var(--success) 7%, var(--bg-card)); }
    .account-safety-note svg { width: 20px; height: 20px; flex: 0 0 20px; color: var(--success); }
    .account-actions { margin-top: .8rem; display: flex; flex-wrap: wrap; gap: .55rem; }
    .account-action { min-height: 46px; }
    .account-action svg { width: 19px; height: 19px; }
    .account-settings, .account-history { margin-top: 1rem; border-top: 1px solid var(--border-flat); }
    .account-section-heading { padding: .9rem 0 .65rem; display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
    .account-section-heading h3 { margin: 0; color: var(--text-main); font-size: 1rem; }
    .account-section-heading p { margin: .2rem 0 0; color: var(--text-muted); font-size: .74rem; }
    .account-section-heading > span { color: var(--text-muted); font-size: .72rem; font-weight: 800; }
    .account-settings-grid { padding: .7rem; display: grid; grid-template-columns: minmax(250px, 1fr) minmax(180px, .55fr) auto; align-items: end; gap: .75rem; border: 1px solid var(--border-flat); border-radius: .55rem; background: var(--bg-panel); }
    .account-status-control { min-height: 58px; display: flex; align-items: center; gap: .7rem; cursor: pointer; }
    .account-status-control > input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
    .account-status-control > span:last-child { min-width: 0; display: flex; flex-direction: column; gap: .12rem; }
    .account-status-control b { color: var(--text-main); font-size: .82rem; }
    .account-status-control small { color: var(--text-muted); font-size: .68rem; line-height: 1.3; }
    .account-switch { width: 48px; height: 28px; flex: 0 0 48px; padding: 4px; border: 1px solid var(--border-flat); border-radius: 999px; background: var(--bg-card-hover); transition: .14s ease; }
    .account-switch i { width: 18px; height: 18px; display: block; border-radius: 50%; background: var(--text-muted); transition: .14s ease; }
    .account-status-control.checked .account-switch { border-color: var(--success); background: var(--success); }
    .account-status-control.checked .account-switch i { background: white; transform: translateX(20px); }
    .account-status-control:has(input:disabled) { cursor: default; opacity: .8; }
    .account-limit-field { margin: 0; }
    .account-limit-field input { min-height: 46px; }
    .account-limit-field small { margin-top: .25rem; color: var(--text-muted); font-size: .64rem; }
    .account-save-settings { min-height: 46px; white-space: nowrap; }
    .account-entry-list { display: grid; border: 1px solid var(--border-flat); border-radius: .55rem; overflow: hidden; }
    .account-entry-list article { min-height: 70px; padding: .72rem .85rem; display: flex; align-items: center; justify-content: space-between; gap: 1rem; background: var(--bg-card); }
    .account-entry-list article + article { border-top: 1px solid var(--border-flat); }
    .account-entry-copy { min-width: 0; display: flex; flex-direction: column; gap: .14rem; }
    .account-entry-copy strong { color: var(--text-main); font-size: .82rem; }
    .account-entry-copy span, .account-entry-copy small { overflow-wrap: anywhere; color: var(--text-muted); font-size: .69rem; }
    .account-entry-copy small { color: var(--text-main); }
    .account-entry-side { flex: 0 0 auto; display: flex; align-items: center; gap: .75rem; }
    .account-entry-amount { flex: 0 0 auto; display: flex; flex-direction: column; align-items: flex-end; gap: .1rem; }
    .account-entry-amount b { color: var(--text-main); font-size: .96rem; }
    .account-entry-amount.increase b { color: var(--danger); }
    .account-entry-amount.decrease b { color: var(--success); }
    .account-entry-amount span { color: var(--text-muted); font-size: .66rem; }
    .account-print-button { min-height: 34px; padding: .38rem .55rem; color: var(--accent-primary); font-size: .67rem; font-weight: 850; border: 1px solid color-mix(in srgb, var(--accent-primary) 35%, var(--border-flat)); border-radius: .38rem; background: color-mix(in srgb, var(--accent-primary) 7%, var(--bg-card)); cursor: pointer; }
    .account-print-button:hover:not(:disabled) { background: color-mix(in srgb, var(--accent-primary) 13%, var(--bg-card)); }
    .account-print-button:disabled { opacity: .6; cursor: default; }
    .account-empty { min-height: 110px; padding: 1rem; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .25rem; color: var(--text-muted); text-align: center; border: 1px dashed var(--border-flat); border-radius: .55rem; }
    .account-empty strong { color: var(--text-main); font-size: .88rem; }
    .account-empty span { font-size: .72rem; }
    .account-history-limit { margin: .65rem 0 0; display: flex; align-items: center; justify-content: center; gap: .7rem; color: var(--text-muted); font-size: .7rem; text-align: center; }
    .account-history-limit .btn { min-height: 38px; }
    .entry-balance-strip { padding: .8rem .9rem; display: flex; align-items: center; justify-content: space-between; gap: 1rem; border: 1px solid var(--border-flat); border-radius: .55rem; background: var(--bg-panel); }
    .entry-balance-strip > span { min-width: 0; overflow: hidden; color: var(--text-main); font-weight: 850; text-overflow: ellipsis; white-space: nowrap; }
    .entry-balance-strip > div { display: flex; flex: 0 0 auto; flex-direction: column; align-items: flex-end; }
    .entry-balance-strip small { color: var(--text-muted); font-size: .65rem; font-weight: 800; text-transform: uppercase; }
    .entry-balance-strip strong { color: var(--danger); font-size: 1.15rem; }
    .entry-balance-strip strong.credit { color: var(--accent-primary); }
    .entry-balance-strip strong.clear { color: var(--success); }
    .account-entry-form { margin-top: 1rem; display: grid; gap: .9rem; }
    .money-input { position: relative; }
    .money-input > span { position: absolute; top: 50%; left: .85rem; color: var(--text-muted); font-weight: 850; transform: translateY(-50%); pointer-events: none; }
    .money-input input { width: 100%; min-height: 54px; padding-left: 2rem; font-size: 1.2rem; font-weight: 850; }
    .payment-method-field { margin: 0; padding: 0; border: 0; }
    .payment-method-field legend { margin-bottom: .45rem; color: var(--text-muted); font-size: .75rem; font-weight: 800; text-transform: uppercase; }
    .payment-method-options { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .6rem; }
    .payment-method-options button { min-height: 58px; padding: .7rem; display: flex; align-items: center; justify-content: center; gap: .55rem; color: var(--text-main); font-weight: 850; border: 1px solid var(--border-flat); border-radius: .5rem; background: var(--bg-panel); cursor: pointer; }
    .payment-method-options button:hover { background: var(--bg-card-hover); }
    .payment-method-options button.active { color: var(--accent-primary); border-color: var(--accent-primary); box-shadow: inset 0 0 0 1px var(--accent-primary); background: color-mix(in srgb, var(--accent-primary) 8%, var(--bg-card)); }
    .payment-method-options button:disabled { opacity: .65; cursor: default; }
    .payment-method-options svg { width: 22px; height: 22px; }
    .account-payment-note, .append-only-note { padding: .65rem .75rem; color: var(--text-muted); font-size: .72rem; line-height: 1.4; border: 1px solid var(--border-flat); border-radius: .4rem; background: var(--bg-panel); }
    .account-payment-note strong { color: var(--text-main); }
    .external-card-confirmation { min-height: 58px; padding: .7rem .75rem; display: flex; align-items: flex-start; gap: .65rem; border: 1px solid color-mix(in srgb, var(--warning) 42%, var(--border-flat)); border-radius: .45rem; background: color-mix(in srgb, var(--warning) 7%, var(--bg-card)); cursor: pointer; }
    .external-card-confirmation input { width: 20px; height: 20px; flex: 0 0 20px; margin-top: .05rem; accent-color: var(--accent-primary); }
    .external-card-confirmation span { min-width: 0; display: flex; flex-direction: column; gap: .18rem; }
    .external-card-confirmation b { color: var(--text-main); font-size: .75rem; }
    .external-card-confirmation small { color: var(--text-muted); font-size: .68rem; line-height: 1.4; }
    .account-terminal-status { padding: .65rem .75rem; color: var(--accent-primary); font-size: .75rem; font-weight: 850; border: 1px solid color-mix(in srgb, var(--accent-primary) 38%, var(--border-flat)); border-radius: .4rem; background: color-mix(in srgb, var(--accent-primary) 8%, var(--bg-card)); }
    .append-only-note { border-color: color-mix(in srgb, var(--warning) 40%, var(--border-flat)); background: color-mix(in srgb, var(--warning) 7%, var(--bg-card)); }
    @media (max-width: 1100px) {
        .customer-table { min-width: 680px; }
        .customer-table th:nth-child(2),
        .customer-table td:nth-child(2),
        .customer-table th:nth-child(3),
        .customer-table td:nth-child(3) { display: none; }
        .customer-table th,
        .customer-table td { padding-left: .5rem; padding-right: .5rem; }
        .customer-actions { gap: .3rem; }
        .customer-actions .btn-icon { width: 44px; height: 44px; min-width: 44px; }
        .account-settings-grid { grid-template-columns: minmax(0, 1fr) minmax(160px, .65fr); }
        .account-save-settings { grid-column: 1 / -1; }
    }
    @media (max-width: 760px) {
        .customer-search-intro { align-items: stretch; flex-direction: column; }
        .customer-account-views { width: 100%; grid-template-columns: minmax(104px, .7fr) minmax(0, 1.3fr); }
    }
    @media (max-width: 480px) {
        .customer-account-views { grid-template-columns: 1fr; }
    }
    @media (max-width: 600px) {
        .loyalty-summary { grid-template-columns: 1fr; }
        .loyalty-summary div + div { border-top: 1px solid var(--border-flat); border-left: 0; }
        .account-hero { grid-template-columns: 1fr; }
        .account-hero > div:first-child { border-right: 0; border-bottom: 1px solid var(--border-flat); }
        .account-facts { grid-template-columns: 1fr; }
        .account-facts article + article { border-top: 1px solid var(--border-flat); border-left: 0; }
        .account-actions .btn { flex: 1 1 calc(50% - .3rem); }
        .account-settings-grid { grid-template-columns: 1fr; }
        .account-save-settings { grid-column: auto; }
        .account-entry-list article { align-items: flex-start; }
        .account-entry-side { flex-direction: column; align-items: flex-end; }
        .account-history-limit { flex-direction: column; }
    }
    @media (max-width: 480px) {
        .loyalty-adjustment-current { grid-template-columns: 1fr; }
        .loyalty-adjustment-current > div + div { align-items: flex-start; border-top: 1px solid var(--border-flat); border-left: 0; text-align: left; }
        .loyalty-adjustment-modes { grid-template-columns: 1fr; }
        .loyalty-adjustment-modes button { min-height: 48px; }
        .loyalty-adjustment-preview > div { padding-inline: .4rem; }
        .loyalty-adjustment-preview strong { font-size: .9rem; }
        .loyalty-modal-actions .btn { flex: 1 1 auto; }
    }
</style>
