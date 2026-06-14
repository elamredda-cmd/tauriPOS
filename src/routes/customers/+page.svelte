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
    $: loyaltyConfig = getLoyaltyConfig($settingsDB);
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
    <table class="tbl">
        <thead><tr><th>Name</th><th>Postcode</th><th>Loyalty Code</th><th>Points</th><th>Credit</th><th>Actions</th></tr></thead>
        <tbody>
            {#each $customersDB as c}
            <tr>
                <td style="font-weight:600">{c.name}</td>
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
