<script lang="ts">
    import { onDestroy, onMount } from 'svelte';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import Modal from '$lib/components/Modal.svelte';
    import Code39Barcode from '$lib/components/Code39Barcode.svelte';
    import { customersDB, settingsDB, type Customer, uuid, now, formatMoney } from '$lib/stores/db';
    import {
        getCustomerLoyaltyHistory,
        getCustomerById,
        getCustomersPage,
        getCustomerUsage,
        isCustomerLoyaltyCodeInUse,
        removeCustomerSafely,
        saveCustomerProfile,
        type CustomerLoyaltyHistoryRow,
    } from '$lib/stores/database';
    import { toast } from '$lib/stores/toast';
    import { createLoyaltyCode, getLoyaltyConfig, loyaltyCredit } from '$lib/loyalty';
    import {
        LOYALTY_CODE_MAX_LENGTH,
        loyaltyCodeValidationError,
        normalizeLoyaltyCode,
    } from '$lib/customerLoyaltyCode';

    const PAGE_SIZE = 40;
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

    $: loyaltyConfig = getLoyaltyConfig($settingsDB);
    $: loyaltyCustomer = $customersDB.find((customer) => customer.id === loyaltyCustomerId)
        || pageCustomers.find((customer) => customer.id === loyaltyCustomerId)
        || loyaltyCustomerSnapshot;
    $: pageCount = Math.max(1, Math.ceil(totalCustomers / PAGE_SIZE));
    $: if (currentPage > pageCount) currentPage = pageCount;
    $: pageStart = (currentPage - 1) * PAGE_SIZE;

    onMount(() => {
        customersMounted = true;
        void loadCustomerPage();
    });

    onDestroy(() => {
        customersMounted = false;
        customersLoadToken += 1;
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
                    ? { ...profile, loyaltyPoints: customer.loyaltyPoints }
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
            toast(`Could not delete customer: ${error}`, 'error');
        } finally {
            deletingCustomerId = '';
        }
    }

    async function openLoyalty(customer: Customer) {
        loyaltyCustomerId = customer.id;
        loyaltyCustomerSnapshot = customer;
        showLoyalty = true;
        await refreshLoyaltyHistory();
    }

    async function refreshLoyaltyHistory() {
        if (!loyaltyCustomerId || loyaltyHistoryLoading) return;
        loyaltyHistoryLoading = true;
        try {
            const [customer, history] = await Promise.all([
                getCustomerById(loyaltyCustomerId),
                getCustomerLoyaltyHistory(loyaltyCustomerId),
            ]);
            if (customer) {
                loyaltyCustomerSnapshot = customer as Customer;
                pageCustomers = pageCustomers.map((item) => item.id === customer.id ? customer as Customer : item);
                customersDB.update((list) => list.map((item) => item.id === customer.id ? customer as Customer : item));
            }
            loyaltyHistory = history;
        } catch (error) {
            toast(`Could not load loyalty history: ${error}`, 'error');
        } finally {
            loyaltyHistoryLoading = false;
        }
    }

    function loyaltyReason(reason: string): string {
        if (reason === 'earned') return 'Points earned';
        if (reason === 'redeemed') return 'Credit used';
        if (reason === 'refund_adjustment') return 'Refund adjustment';
        if (reason === 'manual_adjustment') return 'Manual adjustment';
        return 'Loyalty adjustment';
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

    <div class="customer-toolbar">
        <div class="customer-toolbar-copy">
            <p>Customer lookup</p>
            <h2>Find loyalty customers</h2>
            <span>Search by name, postcode, phone, email, or loyalty code.</span>
        </div>
        <div class="customer-search-group">
            <div class="customer-search">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" aria-hidden="true">
                    <circle cx="11" cy="11" r="8"></circle>
                    <path d="m21 21-4.35-4.35"></path>
                </svg>
                <input
                    id="customer-search"
                    class="search-input"
                    bind:value={searchQuery}
                    on:keydown={handleCustomerSearchKeydown}
                    placeholder="Search customers..."
                    aria-label="Search customers"
                />
            </div>
            <button class="btn btn-secondary customer-find" disabled={customersLoading} on:click={runCustomerSearch}>Find</button>
            <span class="customer-count">{totalCustomers} / {allCustomerCount}</span>
            {#if searchQuery || appliedSearchQuery}
                <button class="btn btn-secondary customer-clear" on:click={clearCustomerSearch}>Clear</button>
            {/if}
        </div>
    </div>

    <div class="customer-table-wrap">
        <table class="tbl customer-table">
            <thead>
                <tr><th>Name</th><th>Postcode</th><th>Loyalty Code</th><th>Points</th><th>Credit</th><th>Actions</th></tr>
            </thead>
            <tbody>
                {#each pageCustomers as customer (customer.id)}
                    <tr>
                        <td class="font-semibold">{customer.name}</td>
                        <td class="mono">{customer.postcode || '-'}</td>
                        <td class="mono">{customer.loyaltyCode || '-'}</td>
                        <td class="money">{Number(customer.loyaltyPoints || 0).toLocaleString()}</td>
                        <td class="money">{formatMoney(loyaltyCredit(customer.loyaltyPoints, loyaltyConfig))}</td>
                        <td>
                            <div class="act-row customer-actions">
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
                    <tr class="empty-row"><td colspan="6">Loading customers...</td></tr>
                {:else if customersLoadError}
                    <tr class="empty-row"><td colspan="6">Could not load customers: {customersLoadError}</td></tr>
                {:else if allCustomerCount === 0}
                    <tr class="empty-row"><td colspan="6">No customers yet.</td></tr>
                {:else if totalCustomers === 0}
                    <tr class="empty-row"><td colspan="6">No customers match your search.</td></tr>
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

<Modal bind:show={showForm} title={editing ? 'Edit Customer' : 'Add Customer'} width="560px">
    <div class="form-grid">
        <div class="field span-2"><label for="customer-name">Name *</label><input id="customer-name" bind:value={cur.name} placeholder="Full name" /></div>
        <div class="field"><label for="customer-phone">Phone</label><input id="customer-phone" type="tel" bind:value={cur.phone} placeholder="07..." /></div>
        <div class="field"><label for="customer-email">Email</label><input id="customer-email" type="email" bind:value={cur.email} /></div>
        <div class="field"><label for="customer-postcode">Postcode</label><input id="customer-postcode" bind:value={cur.postcode} placeholder="Postcode" /></div>
        <div class="field"><label for="customer-loyalty-code">Loyalty Code</label><input id="customer-loyalty-code" maxlength={LOYALTY_CODE_MAX_LENGTH} spellcheck="false" bind:value={cur.loyaltyCode} /></div>
        <div class="field"><span class="field-label">Current Points</span><div class="flat-input readonly-value">{Number(cur.loyaltyPoints || 0).toLocaleString()}</div></div>
        <div class="field"><span class="field-label">Available Credit</span><div class="flat-input readonly-value money">{formatMoney(loyaltyCredit(cur.loyaltyPoints || 0, loyaltyConfig))}</div></div>
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
            <div><span>Available credit</span><strong>{formatMoney(loyaltyCredit(loyaltyCustomer.loyaltyPoints, loyaltyConfig))}</strong></div>
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

<style>
    .customer-toolbar { margin: 1rem; padding: 1rem; display: grid; grid-template-columns: minmax(240px, .9fr) minmax(420px, 1.1fr); align-items: center; gap: 1.25rem; border: 1px solid var(--border-flat); border-radius: .5rem; background: var(--bg-card); }
    .customer-toolbar-copy { min-width: 0; }
    .customer-toolbar-copy p { margin: 0 0 .25rem; color: var(--accent-primary); font-size: .72rem; font-weight: 850; text-transform: uppercase; }
    .customer-toolbar-copy h2 { margin: 0; color: var(--text-main); font-size: 1.15rem; }
    .customer-toolbar-copy span { display: block; margin-top: .3rem; color: var(--text-muted); font-size: .84rem; }
    .customer-search-group { min-width: 0; display: flex; align-items: center; gap: .65rem; }
    .customer-search { position: relative; min-width: 0; flex: 1; }
    .customer-search svg { position: absolute; z-index: 1; top: 50%; left: .9rem; color: var(--text-muted); transform: translateY(-50%); pointer-events: none; }
    .customer-search input { width: 100%; min-height: 52px; padding-left: 2.75rem; }
    .customer-count { flex: 0 0 auto; padding: .75rem .9rem; border: 1px solid var(--border-flat); border-radius: .4rem; background: var(--bg-base); color: var(--text-muted); font-weight: 800; white-space: nowrap; }
    .customer-find, .customer-clear { min-height: 52px; }
    .customer-table-wrap { min-width: 0; overflow-x: auto; }
    .customer-table { min-width: 760px; }
    .customer-table tbody tr { height: 58px; }
    .customer-actions { flex-wrap: nowrap; }
    .customer-actions .btn-icon, .customer-pagination .btn-icon { width: 42px; height: 42px; min-width: 42px; }
    .customer-actions svg, .customer-pagination svg { width: 19px; height: 19px; }
    .customer-actions .points { color: var(--warning); }
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
    @media (max-width: 900px) {
        .customer-toolbar { grid-template-columns: 1fr; }
        .customer-search-group { width: 100%; }
    }
    @media (max-width: 600px) {
        .customer-search-group { flex-wrap: wrap; }
        .customer-search { flex-basis: 100%; }
        .customer-clear { flex: 1; }
        .loyalty-summary { grid-template-columns: 1fr; }
        .loyalty-summary div + div { border-top: 1px solid var(--border-flat); border-left: 0; }
    }
</style>
