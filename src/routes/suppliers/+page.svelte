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
        if (!cur.name?.trim()) { toast('Company name is required', 'error'); return; }
        cur.name = cur.name.trim();
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
    <div class="supplier-table-wrap">
        <table class="tbl supplier-table">
            <thead><tr><th>Company</th><th>Contact</th><th class="supplier-phone-column">Phone</th><th class="supplier-email-column">Email</th><th class="supplier-actions-column">Actions</th></tr></thead>
            <tbody>
                {#each $suppliersDB as s}
                <tr>
                    <td class="supplier-text-cell font-semibold">
                        <span title={s.name}>{s.name}</span>
                        <small class="supplier-email-compact" title={s.email || 'No email address'}>{s.email || 'No email address'}</small>
                    </td>
                    <td class="supplier-text-cell"><span title={s.contactName || 'No contact person'}>{s.contactName || '-'}</span></td>
                    <td class="supplier-phone-column mono" title={s.phone || 'No phone number'}>{s.phone || '-'}</td>
                    <td class="supplier-email-column supplier-text-cell"><span title={s.email || 'No email address'}>{s.email || '-'}</span></td>
                    <td class="supplier-actions-column"><div class="supplier-action-row">
                        <button class="btn-icon act-btn" title={`Edit ${s.name}`} aria-label={`Edit ${s.name}`} on:click={() => edit(s)}><Pencil size={16} /></button>
                        <button class="btn-icon act-btn danger" title={`Delete ${s.name}`} aria-label={`Delete ${s.name}`} on:click={() => requestDelete(s)}><Trash2 size={16} /></button>
                    </div></td>
                </tr>
                {/each}
                {#if $suppliersDB.length===0}<tr class="empty-row"><td colspan="5">No suppliers yet.</td></tr>{/if}
            </tbody>
        </table>
    </div>
</MgmtPage>

<Modal bind:show title={editing?'Edit Supplier':'Add Supplier'} width="560px">
    <div class="form-grid">
        <div class="field span-2"><label for="supplier-name">Company Name *</label><input id="supplier-name" bind:value={cur.name} /></div>
        <div class="field"><label for="supplier-contact">Contact Person</label><input id="supplier-contact" bind:value={cur.contactName} /></div>
        <div class="field"><label for="supplier-phone">Phone</label><input id="supplier-phone" bind:value={cur.phone} /></div>
        <div class="field"><label for="supplier-email">Email</label><input id="supplier-email" type="email" bind:value={cur.email} /></div>
        <div class="field"><label for="supplier-address">Address</label><input id="supplier-address" bind:value={cur.address} /></div>
        <div class="field span-2"><label for="supplier-notes">Notes</label><textarea id="supplier-notes" bind:value={cur.notes}></textarea></div>
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

<style>
    .supplier-table-wrap {
        min-width: 0;
        width: 100%;
        height: 100%;
        overflow: auto;
        overscroll-behavior: contain;
    }

    .supplier-table {
        width: 100%;
        min-width: 680px;
        table-layout: fixed;
    }

    .supplier-table th:nth-child(1) { width: 25%; }
    .supplier-table th:nth-child(2) { width: 20%; }
    .supplier-phone-column { width: 130px; }
    .supplier-actions-column { width: 116px; }

    .supplier-text-cell > span,
    td.supplier-phone-column {
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .supplier-email-compact {
        display: none;
    }

    th.supplier-actions-column,
    td.supplier-actions-column {
        position: sticky;
        right: 0;
        padding-inline: .5rem !important;
        background: var(--bg-card);
        box-shadow: -1px 0 0 var(--border-flat);
    }

    th.supplier-actions-column {
        z-index: 8;
    }

    td.supplier-actions-column {
        z-index: 3;
    }

    .supplier-table tbody tr:hover td.supplier-actions-column {
        background: var(--bg-card-hover);
    }

    .supplier-action-row {
        display: grid;
        grid-template-columns: repeat(2, 44px);
        justify-content: end;
        gap: .35rem;
    }

    @media (max-width: 900px) {
        .supplier-table {
            min-width: 660px;
        }

        .supplier-table th:nth-child(1) { width: 24%; }
        .supplier-table th:nth-child(2) { width: 19%; }
        .supplier-phone-column { width: 118px; }
    }

    @media (max-width: 900px) {
        :global(.back-office-route) .supplier-table {
            min-width: 0;
        }

        :global(.back-office-route) .supplier-table th:nth-child(1) { width: auto; }
        :global(.back-office-route) .supplier-table th:nth-child(2) { width: 30%; }
        :global(.back-office-route) .supplier-phone-column { width: 116px; }
        :global(.back-office-route) .supplier-email-column { display: none; }
        :global(.back-office-route) .supplier-actions-column {
            width: 92px;
            padding-inline: .35rem !important;
        }

        :global(.back-office-route) .supplier-email-compact {
            display: block;
            margin-top: .15rem;
            overflow: hidden;
            color: var(--text-muted);
            font-size: .68rem;
            font-weight: 600;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        :global(.back-office-route) .supplier-action-row {
            grid-template-columns: repeat(2, 36px);
            gap: .25rem;
        }
    }
</style>
