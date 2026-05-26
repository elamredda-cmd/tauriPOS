<script lang="ts">
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import Modal from '$lib/components/Modal.svelte';
    import { customersDB, type Customer, uuid, now } from '$lib/stores/db';
    import { toast } from '$lib/stores/toast';
    import { upsert, remove as removeSql } from '$lib/stores/sqlite';
    let show = false; let editing = false;
    let cur: Partial<Customer> = {};
    function add() { cur = { id: uuid(), name:'', phone:'', email:'', loyaltyPoints:0, notes:'', createdAt: now() }; editing=false; show=true; }
    function edit(c: Customer) { cur = { ...c }; editing=true; show=true; }
    function save() {
        if (!cur.name) { alert('Name is required'); return; }
        customersDB.update(list => {
            const updated = editing ? list.map(c => c.id===cur.id ? cur as Customer : c) : [...list, cur as Customer];
            upsert('customers', cur);
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
        <thead><tr><th>Name</th><th>Phone</th><th>Email</th><th>Loyalty Pts</th><th>Notes</th><th>Actions</th></tr></thead>
        <tbody>
            {#each $customersDB as c}
            <tr>
                <td style="font-weight:600">{c.name}</td>
                <td class="mono">{c.phone || '-'}</td>
                <td>{c.email || '-'}</td>
                <td class="money">{c.loyaltyPoints}</td>
                <td>{c.notes || '-'}</td>
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
        <div class="field"><label>Loyalty Points</label><input type="number" bind:value={cur.loyaltyPoints} /></div>
        <div class="field span-2"><label>Notes</label><textarea bind:value={cur.notes}></textarea></div>
    </div>
    <svelte:fragment slot="footer">
        <button class="btn btn-danger" on:click={() => show=false}>Cancel</button>
        <button class="btn btn-primary" on:click={save}>Save</button>
    </svelte:fragment>
</Modal>
