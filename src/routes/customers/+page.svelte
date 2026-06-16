<script lang="ts">
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import Modal from '$lib/components/Modal.svelte';
    import { customersDB, settingsDB, type Customer, uuid, now, formatMoney } from '$lib/stores/db';
    import { toast } from '$lib/stores/toast';
    import { upsert, remove as removeSql } from '$lib/stores/database';
    import { createLoyaltyCode, getLoyaltyConfig, loyaltyCredit } from '$lib/loyalty';
    import Code39Barcode from '$lib/components/Code39Barcode.svelte';
    import { onMount } from 'svelte';
    let show = false; let editing = false;
    let cur: Partial<Customer> = {};
    let searchQuery = '';
    $: loyaltyConfig = getLoyaltyConfig($settingsDB);
    $: filteredCustomers = $customersDB.filter((customer) => {
        const q = searchQuery.trim().toLowerCase();
        if (!q) return true;
        return [
            customer.name,
            customer.postcode,
            customer.phone,
            customer.email,
            customer.loyaltyCode,
        ].some((value) => String(value || '').toLowerCase().includes(q));
    });
    onMount(async () => {
        const used = [...$customersDB];
        const updated = await Promise.all($customersDB.map(async (customer) => {
            if (customer.loyaltyCode) return customer;
            const patched = { ...customer, postcode: customer.postcode || '', loyaltyCode: createLoyaltyCode(used), updatedAt: now() };
            used.push(patched);
            await upsert('customers', patched);
            return patched;
        }));
        customersDB.set(updated);
    });
    function add() { const stamp = now(); cur = { id: uuid(), name:'', phone:'', email:'', postcode:'', loyaltyCode:createLoyaltyCode($customersDB), loyaltyPoints:0, notes:'', createdAt: stamp, updatedAt: stamp }; editing=false; show=true; }
    function edit(c: Customer) { cur = { ...c }; editing=true; show=true; }
    async function save() {
        if (!cur.name) { alert('Name is required'); return; }
        cur.loyaltyCode = (cur.loyaltyCode || createLoyaltyCode($customersDB)).trim().toUpperCase();
        if ($customersDB.some(customer => customer.id !== cur.id && customer.loyaltyCode === cur.loyaltyCode)) {
            toast('Loyalty code is already used by another customer', 'error'); return;
        }
        cur.updatedAt = now();
        await upsert('customers', cur);
        customersDB.update(list => {
            const updated = editing ? list.map(c => c.id===cur.id ? cur as Customer : c) : [...list, cur as Customer];
            return updated;
        });
        show=false;
        toast(editing ? 'Customer updated' : 'Customer added');
    }
    function del(id: string) { if(confirm('Delete?')) { customersDB.update(l => l.filter(c => c.id!==id)); removeSql('customers', id); toast('Customer deleted', 'info'); } }
</script>

<MgmtPage title="Customers">
    <button slot="actions" class="btn btn-primary" on:click={add}>+ Add Customer</button>
    <div class="p-4 border-b border-border-flat bg-bg-panel">
        <div class="flat-card p-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div class="min-w-0">
                <p class="text-xs uppercase tracking-[0.22em] text-accent-primary font-bold mb-1">Customer lookup</p>
                <h2 class="text-xl m-0">Find loyalty customers fast</h2>
                <p class="text-sm text-text-muted mt-1">Search by name, postcode, phone, email, or loyalty code.</p>
            </div>
            <div class="flex flex-col gap-3 sm:flex-row sm:items-center lg:min-w-[520px]">
                <div class="relative flex-1">
                    <svg class="absolute left-4 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20">
                        <circle cx="11" cy="11" r="8"></circle>
                        <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                    </svg>
                    <input
                        class="w-full min-h-[56px] rounded-md border border-border-flat bg-bg-base pl-12 pr-4 text-base font-semibold text-text-main outline-none transition focus:border-accent-primary focus:ring-2 focus:ring-accent-primary/25"
                        bind:value={searchQuery}
                        placeholder="Search customers..."
                    />
                </div>
                <div class="flex items-center gap-2">
                    <span class="rounded-full border border-border-flat bg-bg-base px-4 py-3 text-sm font-bold text-text-muted whitespace-nowrap">
                        {filteredCustomers.length} / {$customersDB.length}
                    </span>
                    {#if searchQuery}
                        <button class="btn btn-secondary !min-h-[56px]" on:click={() => searchQuery = ''}>Clear</button>
                    {/if}
                </div>
            </div>
        </div>
    </div>
    <table class="tbl">
        <thead><tr><th>Name</th><th>Postcode</th><th>Loyalty Code</th><th>Points</th><th>Credit</th><th>Actions</th></tr></thead>
        <tbody>
            {#each filteredCustomers as c}
            <tr>
                <td class="font-semibold">{c.name}</td>
                <td class="mono">{c.postcode || '-'}</td>
                <td class="mono">{c.loyaltyCode || '-'}</td>
                <td class="money">{c.loyaltyPoints}</td>
                <td class="money">{formatMoney(loyaltyCredit(c.loyaltyPoints, loyaltyConfig))}</td>
                <td><div class="act-row">
                    <button class="btn-icon act-btn" on:click={() => edit(c)}>✎</button>
                    <button class="btn-icon act-btn danger" on:click={() => del(c.id)}>✕</button>
                </div></td>
            </tr>
            {/each}
            {#if $customersDB.length===0}<tr class="empty-row"><td colspan="6">No customers yet.</td></tr>{/if}
            {#if $customersDB.length > 0 && filteredCustomers.length===0}<tr class="empty-row"><td colspan="6">No customers match your search.</td></tr>{/if}
        </tbody>
    </table>
</MgmtPage>

<Modal bind:show title={editing?'Edit Customer':'Add Customer'} width="520px">
    <div class="form-grid">
        <div class="field span-2"><label>Name *</label><input bind:value={cur.name} placeholder="Full name" /></div>
        <div class="field"><label>Phone</label><input bind:value={cur.phone} placeholder="07..." /></div>
        <div class="field"><label>Email</label><input type="email" bind:value={cur.email} /></div>
        <div class="field"><label>Postcode</label><input bind:value={cur.postcode} placeholder="Postcode" /></div>
        <div class="field"><label>Loyalty Code</label><input bind:value={cur.loyaltyCode} /></div>
        <div class="field"><label>Current Points</label><div class="flat-input">{cur.loyaltyPoints || 0}</div></div>
        <div class="field"><label>Available Loyalty Credit</label><div class="flat-input money">{formatMoney(loyaltyCredit(cur.loyaltyPoints || 0, loyaltyConfig))}</div></div>
        <div class="field span-2"><label>Loyalty Barcode</label><Code39Barcode value={cur.loyaltyCode || ''} /></div>
        <div class="field span-2"><label>Notes</label><textarea bind:value={cur.notes}></textarea></div>
    </div>
    <svelte:fragment slot="footer">
        <button class="btn btn-danger" on:click={() => show=false}>Cancel</button>
        <button class="btn btn-primary" on:click={save}>Save</button>
    </svelte:fragment>
</Modal>
