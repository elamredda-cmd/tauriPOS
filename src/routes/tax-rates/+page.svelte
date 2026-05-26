<script lang="ts">
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import Modal from '$lib/components/Modal.svelte';
    import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
    import TouchToggle from '$lib/components/TouchToggle.svelte';
    import { taxRatesDB, type TaxRate, uuid, now } from '$lib/stores/db';
    import { toast } from '$lib/stores/toast';
    import { upsert, remove as removeSql } from '$lib/stores/sqlite';

    let show = false; 
    let editing = false;
    let showDelConfirm = false;
    let idToDelete = "";
    let cur: Partial<TaxRate> = {};
    let ratePercent = 0;

    function add() { cur = { id:uuid(), name:'', rate:0, isDefault:false, createdAt:now() }; ratePercent=0; editing=false; show=true; }
    function edit(t: TaxRate) { cur={...t}; ratePercent=t.rate*100; editing=true; show=true; }
    function save() {
        if (!cur.name) { toast('Name is required', 'error'); return; }
        cur.rate = ratePercent / 100;
        taxRatesDB.update(list => {
            const updated = editing ? list.map(t => t.id===cur.id ? cur as TaxRate : t) : [...list, cur as TaxRate];
            upsert('tax_rates', cur);
            return updated;
        });        
        show=false;
        toast(editing ? 'Tax rate updated' : 'Tax rate added');
    }

    function confirmDel(id: string) {
        idToDelete = id;
        showDelConfirm = true;
    }

    function handleDel() {
        const id = idToDelete;
        taxRatesDB.update(l => l.filter(t => t.id!==id)); 
        removeSql('tax_rates', id); 
        toast('Tax rate deleted', 'info');
        showDelConfirm = false;
    }
</script>

<MgmtPage title="Tax Rates">
    <button slot="actions" class="btn btn-primary" on:click={add}>+ Add Tax Rate</button>
    <table class="tbl">
        <thead><tr><th>Name</th><th>Rate</th><th>Default</th><th>Actions</th></tr></thead>
        <tbody>
            {#each $taxRatesDB as t}
            <tr>
                <td style="font-weight:600">{t.name}</td>
                <td>{(t.rate * 100).toFixed(1)}%</td>
                <td>{t.isDefault ? '✓ Yes' : '-'}</td>
                <td><div class="act-row">
                    <button class="btn-icon act-btn" on:click={() => edit(t)}>✎</button>
                    <button class="btn-icon act-btn danger" on:click={() => confirmDel(t.id)}>✕</button>
                </div></td>
            </tr>
            {/each}
            {#if $taxRatesDB.length===0}<tr class="empty-row"><td colspan="4">No tax rates.</td></tr>{/if}
        </tbody>
    </table>
</MgmtPage>

<Modal bind:show title={editing?'Edit Tax Rate':'Add Tax Rate'} width="400px">
    <div class="form-grid">
        <div class="field span-2"><label>Name *</label><input bind:value={cur.name} placeholder="e.g. Standard VAT" /></div>
        <div class="field span-2"><label>Rate (%)</label><input type="number" bind:value={ratePercent} step="0.1" min="0" max="100" /></div>
        <div class="span-2"><TouchToggle bind:checked={cur.isDefault} label="Default Rate" /></div>
    </div>
    <svelte:fragment slot="footer">
        <button class="btn btn-danger" on:click={() => show=false}>Cancel</button>
        <button class="btn btn-primary" on:click={save}>Save</button>
    </svelte:fragment>
</Modal>

<ConfirmDialog 
    bind:show={showDelConfirm} 
    title="Delete Tax Rate" 
    message="Are you sure you want to delete this tax rate?"
    variant="danger"
    on:confirm={handleDel}
/>
