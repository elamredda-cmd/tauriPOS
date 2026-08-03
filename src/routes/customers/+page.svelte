<script lang="ts">
    import { onDestroy, onMount } from 'svelte';
    import { isTauri } from '@tauri-apps/api/core';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import Modal from '$lib/components/Modal.svelte';
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
        getCustomerAccount,
        getCustomerAccountEntries,
        getCustomerLoyaltyHistory,
        getCustomerById,
        getCustomersPage,
        getCustomerUsage,
        getOrCreateTillId,
        isCustomerLoyaltyCodeInUse,
        postCustomerAccountEntry,
        removeCustomerSafely,
        saveCustomerAccountConfig,
        saveCustomerProfile,
        type CustomerLoyaltyHistoryRow,
    } from '$lib/stores/database';
    import { toast } from '$lib/stores/toast';
    import { currentEmployee, currentShiftId } from '$lib/stores/session';
    import { hasPermission } from '$lib/permissions';
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

    const PAGE_SIZE = 40;
    const ACCOUNT_HISTORY_PAGE_SIZE = 50;
    let showForm = false;
    let editing = false;
    let saving = false;
    let deletingCustomerId = '';
    let cur: Partial<Customer> = {};
    let editingCustomer: Customer | null = null;
    let searchQuery = '';
    let appliedSearchQuery = '';
    let currentPage = 1;
    let pageCustomers: Customer[] = [];
    let totalCustomers = 0;
    let allCustomerCount = 0;
    let customersLoading = false;
    let customersLoadError = '';
    let customersMounted = false;
    let customersLoadToken = 0;
    let showLoyalty = false;
    let loyaltyCustomerId = '';
    let loyaltyCustomer: Customer | null = null;
    let loyaltyCustomerSnapshot: Customer | null = null;
    let loyaltyHistory: CustomerLoyaltyHistoryRow[] = [];
    let loyaltyHistoryLoading = false;
    let loyaltyHistoryRun = 0;
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
    let accountTerminalStatus = '';
    let accountPrintingEntryId = '';
    let accountCardConfigState: 'loading' | 'loaded' | 'error' = isTauri() ? 'loading' : 'loaded';
    let accountCardFlow: 'external' | 'sumup' | 'dojo' | 'unavailable' | '' = '';

    $: loyaltyConfig = getLoyaltyConfig($settingsDB);
    $: loyaltyCustomer = $customersDB.find((customer) => customer.id === loyaltyCustomerId)
        || pageCustomers.find((customer) => customer.id === loyaltyCustomerId)
        || loyaltyCustomerSnapshot;
    $: accountCustomer = $customersDB.find((customer) => customer.id === accountCustomerId)
        || pageCustomers.find((customer) => customer.id === accountCustomerId)
        || accountCustomerSnapshot;
    $: canTakeAccountPayment = hasPermission($currentEmployee, 'take_account_payment', $settingsDB);
    $: if (!showLoyalty && loyaltyHistoryLoading) {
        loyaltyHistoryRun += 1;
        loyaltyHistoryLoading = false;
    }
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

    onMount(() => {
        customersMounted = true;
        void loadCustomerPage();
        if (isTauri()) {
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
        accountLoadToken += 1;
        accountHistoryLoadRun += 1;
    });

    async function loadCustomerPage() {
        const token = ++customersLoadToken;
        customersLoading = true;
        customersLoadError = '';
        try {
            const result = await getCustomersPage({
                query: appliedSearchQuery,
                limit: PAGE_SIZE,
                offset: (currentPage - 1) * PAGE_SIZE,
            });
            if (!customersMounted || token !== customersLoadToken) return;
            totalCustomers = result.total;
            if (!appliedSearchQuery) allCustomerCount = result.total;
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
        cur = { ...customer };
        editing = true;
        editingCustomer = customer;
        showForm = true;
    }

    async function save() {
        const name = String(cur.name || '').trim();
        if (!name) {
            toast('Customer name is required', 'error');
            return;
        }

        saving = true;
        try {
            const id = String(cur.id || uuid());
            const loyaltyCode = normalizeLoyaltyCode(cur.loyaltyCode || createLoyaltyCode($customersDB));
            const validationError = loyaltyCodeValidationError(loyaltyCode);
            if (validationError) {
                toast(validationError, 'error');
                return;
            }
            if (await isCustomerLoyaltyCodeInUse(loyaltyCode, id)) {
                toast('Loyalty code is already used by another customer', 'error');
                return;
            }

            const existing = editingCustomer || $customersDB.find((customer) => customer.id === id);
            const stamp = now();
            const profile = {
                id,
                name,
                phone: String(cur.phone || '').trim(),
                email: String(cur.email || '').trim(),
                postcode: String(cur.postcode || '').trim().toUpperCase(),
                loyaltyCode,
                notes: String(cur.notes || '').trim(),
                createdAt: existing?.createdAt || cur.createdAt || stamp,
                updatedAt: stamp,
            };
            // Profile writes deliberately omit loyaltyPoints. Sales, refunds and
            // redemption transactions are the only owners of that balance.
            await saveCustomerProfile(profile);
            customersDB.update((list) => existing
                ? list.map((customer) => customer.id === id
                    ? { ...customer, ...profile, loyaltyPoints: customer.loyaltyPoints }
                    : customer)
                : [...list, { ...profile, loyaltyPoints: 0 }]);
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
            if (!confirm(`Delete ${customer.name}?`)) return;
            deletingCustomerId = customer.id;
            await removeCustomerSafely(customer.id);
            customersDB.update((list) => list.filter((item) => item.id !== customer.id));
            await loadCustomerPage();
            toast('Customer deleted', 'info');
        } catch (error) {
            const message = String(error).replace(/^Error:\s*/, '');
            toast(message.startsWith('Could not delete customer') ? message : `Could not delete customer: ${message}`, 'error');
        } finally {
            deletingCustomerId = '';
        }
    }

    async function openLoyalty(customer: Customer) {
        loyaltyCustomerId = customer.id;
        loyaltyCustomerSnapshot = customer;
        loyaltyHistory = [];
        showLoyalty = true;
        await refreshLoyaltyHistory();
    }

    async function refreshLoyaltyHistory() {
        const customerId = loyaltyCustomerId;
        if (!customerId) return;
        const run = ++loyaltyHistoryRun;
        loyaltyHistoryLoading = true;
        try {
            const [customer, history] = await Promise.all([
                getCustomerById(customerId),
                getCustomerLoyaltyHistory(customerId),
            ]);
            if (run !== loyaltyHistoryRun || customerId !== loyaltyCustomerId || !showLoyalty) return;
            if (customer) {
                loyaltyCustomerSnapshot = customer as Customer;
                pageCustomers = pageCustomers.map((item) => item.id === customer.id ? customer as Customer : item);
                customersDB.update((list) => list.map((item) => item.id === customer.id ? customer as Customer : item));
            }
            loyaltyHistory = history;
        } catch (error) {
            if (run === loyaltyHistoryRun && customerId === loyaltyCustomerId && showLoyalty) {
                toast(`Could not load loyalty history: ${error}`, 'error');
            }
        } finally {
            if (run === loyaltyHistoryRun) loyaltyHistoryLoading = false;
        }
    }

    function loyaltyReason(reason: string): string {
        if (reason === 'earned') return 'Points earned';
        if (reason === 'redeemed') return 'Loyalty value used';
        if (reason === 'refund_adjustment') return 'Refund adjustment';
        if (reason === 'manual_adjustment') return 'Manual adjustment';
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
            const deadline = Date.now() + 180_000;
            let nextLeaseRefresh = Date.now() + 25_000;
            let signatureHandled = false;
            while (Date.now() < deadline) {
                const session = await getDojoTerminalSessionStatus(terminalSessionId);
                if (session.status === 'SignatureVerificationRequired' && !signatureHandled) {
                    signatureHandled = true;
                    const accepted = confirm('Compare the customer signature, then press OK to accept it or Cancel to reject it.');
                    await respondToDojoSignature(terminalSessionId, accepted);
                }
                if (['Captured', 'SignatureVerificationAccepted'].includes(session.status)) {
                    const status = session.payment || await getDojoPaymentIntentStatus(paymentIntentId);
                    if (status.id !== paymentIntentId
                        || status.reference !== reference
                        || status.amount !== amountPence
                        || String(status.currency || '').toUpperCase() !== config.currency.toUpperCase()
                        || status.status !== 'Captured') {
                        throw new Error('Dojo captured a payment that does not match this account payment. Do not retry the card; check Dojo.');
                    }
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
                }
                if (['Canceled', 'Declined', 'SignatureVerificationRejected'].includes(session.status)) {
                    const finalStatus = session.status === 'Canceled' ? 'cancelled' : 'failed';
                    await updateDojoAttempt(reference, finalStatus, {
                        clientTransactionId: paymentIntentId,
                        terminalSessionId,
                        error: `Dojo status: ${session.status}`,
                    });
                    finalized = true;
                    throw new Error(session.status === 'Canceled' ? 'The Dojo payment was cancelled' : 'The card payment was not approved');
                }
                if (session.status === 'Expired' || session.status === 'Authorized') {
                    throw new Error(`Dojo returned ${session.status}. Check Dojo before retrying.`);
                }
                accountTerminalStatus = session.latestNotification === 'EnterPin'
                    ? 'Waiting for the customer to enter their PIN'
                    : 'Ask the customer to tap or insert their card';
                if (Date.now() >= nextLeaseRefresh) {
                    nextLeaseRefresh = Date.now() + 25_000;
                    if (!(await refreshDojoLock(config, tillNumber, reference))) {
                        await cancelDojoTerminalSession(terminalSessionId).catch(() => undefined);
                        throw new Error('This till lost the Dojo reservation. Check Dojo before retrying.');
                    }
                }
                await delay(1_200);
            }
            await cancelDojoTerminalSession(terminalSessionId).catch(() => undefined);
            throw new Error('Dojo did not return a final result. Check Dojo before retrying.');
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
            showAccountEntry = false;
            const paymentResultMessage = result.account.balancePence > 0
                ? `Payment recorded. ${formatMoney(result.account.balancePence)} remains owed.`
                : result.account.balancePence < 0
                    ? `Payment recorded. The customer now has ${formatMoney(Math.abs(result.account.balancePence))} credit.`
                    : 'Payment recorded. The customer account is clear.';
            toast(accountEntryMode === 'payment'
                ? paymentResultMessage
                : 'Customer account adjustment recorded');
            if (accountEntryMode === 'payment') {
                void printAccountPaymentAcknowledgement(result.entry, true);
            }
            if (accountEntryMode === 'payment' && accountPaymentMethod === 'cash' && isTauri()) {
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
            `Amount received: ${formatMoney(Math.abs(entry.amountPence))}`,
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

<MgmtPage title="Customers">
    <button slot="actions" class="btn btn-primary" on:click={add}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" aria-hidden="true">
            <path d="M12 5v14M5 12h14"></path>
        </svg>
        Add Customer
    </button>

    <div class="search-strip">
        <div class="search-strip-intro">
            <strong class="block text-sm font-black text-text-main">Find customers</strong>
            <span class="mt-1 block text-xs text-text-muted">View loyalty value, Pay Later balances, and customer details.</span>
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
            <span class="search-meta">{totalCustomers} / {allCustomerCount}</span>
        </div>
    </div>

    <div class="customer-table-wrap">
        <table class="tbl customer-table">
            <thead>
                <tr><th>Name</th><th>Postcode</th><th>Loyalty Code</th><th>Points</th><th>Loyalty Value</th><th>Amount Owed</th><th>Actions</th></tr>
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
                                    title={`View ${customer.name}'s loyalty history`}
                                    aria-label={`View ${customer.name}'s loyalty history`}
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
    <div class="form-grid">
        <div class="field span-2"><label for="customer-name">Name *</label><input id="customer-name" bind:value={cur.name} placeholder="Full name" /></div>
        <div class="field"><label for="customer-phone">Phone</label><input id="customer-phone" type="tel" bind:value={cur.phone} placeholder="07..." /></div>
        <div class="field"><label for="customer-email">Email</label><input id="customer-email" type="email" bind:value={cur.email} /></div>
        <div class="field"><label for="customer-postcode">Postcode</label><input id="customer-postcode" bind:value={cur.postcode} placeholder="Postcode" /></div>
        <div class="field"><label for="customer-loyalty-code">Loyalty Code</label><input id="customer-loyalty-code" maxlength={LOYALTY_CODE_MAX_LENGTH} spellcheck="false" bind:value={cur.loyaltyCode} /></div>
        <div class="field"><span class="field-label">Current Points</span><div class="flat-input readonly-value">{Number(cur.loyaltyPoints || 0).toLocaleString()}</div></div>
        <div class="field"><span class="field-label">Loyalty Value</span><div class="flat-input readonly-value money">{formatMoney(loyaltyCredit(cur.loyaltyPoints || 0, loyaltyConfig))}</div></div>
        <div class="field span-2"><span class="field-label">Loyalty Barcode</span><Code39Barcode value={cur.loyaltyCode || ''} /></div>
        <div class="field span-2"><label for="customer-notes">Notes</label><textarea id="customer-notes" bind:value={cur.notes}></textarea></div>
    </div>
    <svelte:fragment slot="footer">
        <button class="btn btn-secondary" disabled={saving} on:click={() => showForm = false}>Cancel</button>
        <button class="btn btn-primary" disabled={saving} on:click={save}>{saving ? 'Saving...' : 'Save Customer'}</button>
    </svelte:fragment>
</Modal>

<Modal bind:show={showLoyalty} title={loyaltyCustomer ? `Loyalty - ${loyaltyCustomer.name}` : 'Loyalty History'} width="620px">
    {#if loyaltyCustomer}
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
        {:else if loyaltyHistory.length === 0}
            <p class="loyalty-empty">
                {loyaltyCustomer.loyaltyPoints > 0
                    ? 'This balance was imported or created before detailed points history was available.'
                    : 'No points activity yet.'}
            </p>
        {:else}
            <div class="loyalty-history-list">
                {#each loyaltyHistory as entry (entry.id)}
                    <article>
                        <div>
                            <strong>{loyaltyReason(entry.reason)}</strong>
                            <span>{formatHistoryDate(entry.createdAt)}{entry.orderNumber ? ` - Receipt ${entry.orderNumber}` : ''}</span>
                        </div>
                        <b class:negative={entry.pointsChange < 0}>{entry.pointsChange > 0 ? '+' : ''}{entry.pointsChange.toLocaleString()}</b>
                    </article>
                {/each}
            </div>
        {/if}
    {/if}
    <svelte:fragment slot="footer">
        <button class="btn btn-secondary" disabled={loyaltyHistoryLoading} on:click={refreshLoyaltyHistory}>{loyaltyHistoryLoading ? 'Refreshing...' : 'Refresh'}</button>
        <button class="btn btn-primary" on:click={() => showLoyalty = false}>Close</button>
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
            <button
                class="btn btn-primary account-action"
                disabled={!canTakeAccountPayment || !$currentShiftId || accountBalance <= 0 || accountSaving}
                title={!$currentShiftId ? 'Open a till session to take payment' : ''}
                on:click={() => openAccountEntry('payment')}
            >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 7h18v10H3z"></path><path d="M3 10h18M7 14h3"></path></svg>
                Take Payment
            </button>
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

<style>
    .customer-table-wrap { min-width: 0; overflow-x: auto; }
    .customer-table { min-width: 1020px; }
    .customer-table tbody tr { height: 58px; }
    .customer-actions { flex-wrap: nowrap; }
    .customer-actions .btn-icon, .customer-pagination .btn-icon { width: 42px; height: 42px; min-width: 42px; }
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
    .loyalty-history-list article b { color: var(--success); font-size: 1rem; }
    .loyalty-history-list article b.negative { color: var(--danger); }
    .loyalty-empty { padding: 1.5rem .5rem; color: var(--text-muted); text-align: center; }
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
        .customer-actions .btn-icon { width: 38px; height: 38px; min-width: 38px; }
        .account-settings-grid { grid-template-columns: minmax(0, 1fr) minmax(160px, .65fr); }
        .account-save-settings { grid-column: 1 / -1; }
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
</style>
