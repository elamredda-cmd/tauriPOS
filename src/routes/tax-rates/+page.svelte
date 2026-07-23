<script lang="ts">
    import { Pencil, Plus, Trash2 } from '@lucide/svelte';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import Modal from '$lib/components/Modal.svelte';
    import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
    import TouchToggle from '$lib/components/TouchToggle.svelte';
    import { productsDB, taxRatesDB, type TaxRate, uuid, now } from '$lib/stores/db';
    import { toast } from '$lib/stores/toast';
    import { upsert, remove as removeSql } from '$lib/stores/database';

    let show = false; 
    let editing = false;
    let showDelConfirm = false;
    let idToDelete = "";
    let cur: Partial<TaxRate> & { updatedAt?: string } = {};
    let ratePercent = 0;

    function add() { cur = { id:uuid(), name:'', rate:0, isDefault:false, createdAt:now() }; ratePercent=0; editing=false; show=true; }
    function edit(t: TaxRate) { cur={...t}; ratePercent=t.rate*100; editing=true; show=true; }
    async function save() {
        if (!cur.name?.trim()) { toast('Name is required', 'error'); return; }
        if (!Number.isFinite(Number(ratePercent)) || ratePercent < 0 || ratePercent > 100) {
            toast('Rate must be between 0% and 100%', 'error');
            return;
        }
        const stamp = now();
        cur.rate = ratePercent / 100;
        cur.name = cur.name.trim();
        cur.updatedAt = stamp;
        const hasAnotherDefault = $taxRatesDB.some(t => t.id !== cur.id && t.isDefault);
        const shouldBeDefault = Boolean(cur.isDefault) || $taxRatesDB.length === 0 || !hasAnotherDefault;
        cur.isDefault = shouldBeDefault;
        const saved = cur as TaxRate;
        const updated = editing
            ? $taxRatesDB.map(t => t.id === saved.id ? saved : shouldBeDefault ? { ...t, isDefault: false, updatedAt: stamp } as TaxRate : t)
            : [...(shouldBeDefault ? $taxRatesDB.map(t => ({ ...t, isDefault: false, updatedAt: stamp } as TaxRate)) : $taxRatesDB), saved];
        try {
            for (const rate of updated.filter(t => t.id === saved.id || (shouldBeDefault && t.isDefault === false))) {
                await upsert('tax_rates', rate);
            }
            taxRatesDB.set(updated);
            show=false;
            toast(editing ? 'Tax rate updated' : 'Tax rate added');
        } catch (error) {
            console.error('Could not save tax rate:', error);
            toast('Could not save tax rate', 'error');
        }
    }

    function confirmDel(id: string) {
        const tax = $taxRatesDB.find(t => t.id === id);
        const usedCount = $productsDB.filter(product => product.taxRateId === id).length;
        if (usedCount > 0) {
            toast(`This tax rate is used by ${usedCount} item${usedCount === 1 ? '' : 's'}. Change those items first.`, 'error');
            return;
        }
        if (tax?.isDefault) {
            toast('Set another tax rate as default before deleting this one.', 'error');
            return;
        }
        idToDelete = id;
        showDelConfirm = true;
    }

    async function handleDel() {
        const id = idToDelete;
        try {
            await removeSql('tax_rates', id);
            taxRatesDB.update(l => l.filter(t => t.id!==id));
            toast('Tax rate deleted', 'info');
        } catch (error) {
            console.error('Could not delete tax rate:', error);
            toast('Could not delete tax rate', 'error');
        } finally {
            idToDelete = "";
            showDelConfirm = false;
        }
    }
</script>

<MgmtPage title="Tax Rates">
    <button slot="actions" class="btn btn-primary" on:click={add}><Plus size={19} strokeWidth={2.5} />Add Tax Rate</button>
    <table class="tbl">
        <thead><tr><th>Name</th><th>Rate</th><th>Default</th><th>Actions</th></tr></thead>
        <tbody>
            {#each $taxRatesDB as t}
            <tr>
                <td class="font-semibold">{t.name}</td>
                <td>{(t.rate * 100).toFixed(1)}%</td>
                <td>{t.isDefault ? '✓ Yes' : '-'}</td>
                <td><div class="act-row">
                    <button class="btn-icon act-btn" title={`Edit ${t.name}`} aria-label={`Edit ${t.name}`} on:click={() => edit(t)}><Pencil size={16} /></button>
                    <button class="btn-icon act-btn danger" title={`Delete ${t.name}`} aria-label={`Delete ${t.name}`} on:click={() => confirmDel(t.id)}><Trash2 size={16} /></button>
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
        <button class="btn btn-secondary" on:click={() => show=false}>Cancel</button>
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
