<script lang="ts">
    import { Pencil, Plus, Trash2 } from '@lucide/svelte';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import Modal from '$lib/components/Modal.svelte';
    import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
    import { suppliersDB, type Supplier, uuid, now } from '$lib/stores/db';
    import { toast } from '$lib/stores/toast';
    import { upsert, remove as removeSql } from '$lib/stores/database';
    let show = false; let editing = false;
    let showDeleteConfirm = false;
    let supplierToDelete: Supplier | null = null;
    let cur: Partial<Supplier> = {};
    function add() { cur = { id:uuid(), name:'', contactName:'', phone:'', email:'', address:'', notes:'', createdAt:now() }; editing=false; show=true; }
    function edit(s: Supplier) { cur={...s}; editing=true; show=true; }
    async function save() {
        if (!cur.name) { alert('Name is required'); return; }
        const record = cur as Supplier;
        try { await upsert('suppliers', record); }
        catch (e) { console.error(e); toast('Failed to save supplier', 'error'); return; }
        suppliersDB.update(l => editing ? l.map(s => s.id===record.id ? record : s) : [...l, record]);
        show=false;
        toast(editing ? 'Supplier updated' : 'Supplier added');
    }
    function requestDelete(supplier: Supplier) {
        supplierToDelete = supplier;
        showDeleteConfirm = true;
    }
    async function del() {
        if (!supplierToDelete) return;
        const id = supplierToDelete.id;
        try { await removeSql('suppliers', id); }
        catch (e) { console.error(e); toast('Failed to delete supplier', 'error'); return; }
        suppliersDB.update(l => l.filter(s => s.id!==id));
        toast('Supplier deleted', 'info');
        showDeleteConfirm = false;
        supplierToDelete = null;
    }
</script>

<MgmtPage title="Suppliers">
    <button slot="actions" class="btn btn-primary" on:click={add}><Plus size={19} strokeWidth={2.5} />Add Supplier</button>
    <table class="tbl">
        <thead><tr><th>Company</th><th>Contact</th><th>Phone</th><th>Email</th><th>Actions</th></tr></thead>
        <tbody>
            {#each $suppliersDB as s}
            <tr>
                <td class="font-semibold">{s.name}</td>
                <td>{s.contactName || '-'}</td>
                <td class="mono">{s.phone || '-'}</td>
                <td>{s.email || '-'}</td>
                <td><div class="act-row">
                    <button class="btn-icon act-btn" title={`Edit ${s.name}`} aria-label={`Edit ${s.name}`} on:click={() => edit(s)}><Pencil size={16} /></button>
                    <button class="btn-icon act-btn danger" title={`Delete ${s.name}`} aria-label={`Delete ${s.name}`} on:click={() => requestDelete(s)}><Trash2 size={16} /></button>
                </div></td>
            </tr>
            {/each}
            {#if $suppliersDB.length===0}<tr class="empty-row"><td colspan="5">No suppliers yet.</td></tr>{/if}
        </tbody>
    </table>
</MgmtPage>

<Modal bind:show title={editing?'Edit Supplier':'Add Supplier'} width="560px">
    <div class="form-grid">
        <div class="field span-2"><label>Company Name *</label><input bind:value={cur.name} /></div>
        <div class="field"><label>Contact Person</label><input bind:value={cur.contactName} /></div>
        <div class="field"><label>Phone</label><input bind:value={cur.phone} /></div>
        <div class="field"><label>Email</label><input type="email" bind:value={cur.email} /></div>
        <div class="field"><label>Address</label><input bind:value={cur.address} /></div>
        <div class="field span-2"><label>Notes</label><textarea bind:value={cur.notes}></textarea></div>
    </div>
    <svelte:fragment slot="footer">
        <button class="btn btn-secondary" on:click={() => show=false}>Cancel</button>
        <button class="btn btn-primary" on:click={save}>Save</button>
    </svelte:fragment>
</Modal>

<ConfirmDialog
    bind:show={showDeleteConfirm}
    title="Delete Supplier"
    message={`Delete ${supplierToDelete?.name || 'this supplier'}?`}
    confirmText="Delete Supplier"
    variant="danger"
    on:confirm={del}
    on:cancel={() => supplierToDelete = null}
/>
