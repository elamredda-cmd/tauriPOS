<script lang="ts">
    import { Pencil, Plus, Trash2 } from '@lucide/svelte';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import Modal from '$lib/components/Modal.svelte';
    import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
    import TouchToggle from '$lib/components/TouchToggle.svelte';
    import { taxRatesDB, type TaxRate, uuid, now } from '$lib/stores/db';
    import { toast } from '$lib/stores/toast';
    import { getTaxRateProductUsageCount, saveTaxRateSnapshot, remove as removeSql } from '$lib/stores/database';
    import { catalogueDeletionError } from '$lib/catalogueIntegrity';

    let show = false; 
    let editing = false;
    let showDelConfirm = false;
    let idToDelete = "";
    let checkingUsageId = "";
    let deleting = false;
    let cur: Partial<TaxRate> & { updatedAt?: string } = {};
    let ratePercent = 0;
    let saving = false;
    let expectedRates: TaxRate[] = [];

    function add() { if (saving) return; expectedRates = $taxRatesDB.map(rate => ({ ...rate })); cur = { id:uuid(), name:'', rate:0, isDefault:false, createdAt:now() }; ratePercent=0; editing=false; show=true; }
    function edit(t: TaxRate) { if (saving) return; expectedRates = $taxRatesDB.map(rate => ({ ...rate })); cur={...t}; ratePercent=t.rate*100; editing=true; show=true; }
    async function save() {
        if (saving) return;
        if (!cur.name?.trim()) { toast('Name is required', 'error'); return; }
        if (!Number.isFinite(Number(ratePercent)) || ratePercent < 0 || ratePercent > 100) {
            toast('Rate must be between 0% and 100%', 'error');
            return;
        }
        const stamp = now();
        const hasAnotherDefault = expectedRates.some(t => t.id !== cur.id && t.isDefault);
        const saved = { ...cur, name: cur.name.trim(), rate: ratePercent / 100,
            updatedAt: stamp, isDefault: Boolean(cur.isDefault) || expectedRates.length === 0 || !hasAnotherDefault } as TaxRate;
        const snapshot = expectedRates.map(rate => ({ ...rate }));
        const wasEditing = editing;
        saving = true;
        try {
            await saveTaxRateSnapshot(saved, snapshot);
            show=false;
            toast(wasEditing ? 'Tax rate updated' : 'Tax rate added');
        } catch (error) {
            console.error('Could not save tax rate:', error);
            toast(`Tax rate was not saved: ${String(error).replace(/^Error:\s*/, '')}`, 'error');
        } finally {
            saving = false;
        }
    }

    async function confirmDel(id: string) {
        if (saving || checkingUsageId || deleting) return;
        checkingUsageId = id;
        const tax = $taxRatesDB.find(t => t.id === id);
        try {
            const usedCount = await getTaxRateProductUsageCount(id);
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
        } catch (error) {
            console.error('Could not check tax rate usage:', error);
            toast('Could not check whether this tax rate is in use', 'error');
        } finally {
            checkingUsageId = "";
        }
    }

    async function handleDel() {
        if (saving || deleting) return;
        const id = idToDelete;
        deleting = true;
        try {
            await removeSql('tax_rates', id);
            taxRatesDB.update(l => l.filter(t => t.id!==id));
            toast('Tax rate deleted', 'info');
        } catch (error) {
            console.error('Could not delete tax rate:', error);
            toast(catalogueDeletionError(error, 'Tax rate was not deleted. Reconnect and refresh usage before trying again.'), 'error');
        } finally {
            deleting = false;
            idToDelete = "";
            showDelConfirm = false;
        }
    }
</script>

<MgmtPage title="Tax Rates">
    <button slot="actions" class="btn btn-primary" disabled={saving || deleting} on:click={add}><Plus size={19} strokeWidth={2.5} />Add Tax Rate</button>
    <table class="tbl">
        <thead><tr><th>Name</th><th>Rate</th><th>Default</th><th>Actions</th></tr></thead>
        <tbody>
            {#each $taxRatesDB as t}
            <tr>
                <td class="font-semibold">{t.name}</td>
                <td>{(t.rate * 100).toFixed(1)}%</td>
                <td>{t.isDefault ? '✓ Yes' : '-'}</td>
                <td><div class="act-row">
                    <button class="btn-icon act-btn" disabled={saving || deleting} title={`Edit ${t.name}`} aria-label={`Edit ${t.name}`} on:click={() => edit(t)}><Pencil size={16} /></button>
                    <button class="btn-icon act-btn danger" disabled={saving || checkingUsageId !== '' || deleting} title={`Delete ${t.name}`} aria-label={`Delete ${t.name}`} on:click={() => confirmDel(t.id)}><Trash2 size={16} /></button>
                </div></td>
            </tr>
            {/each}
            {#if $taxRatesDB.length===0}<tr class="empty-row"><td colspan="4">No tax rates.</td></tr>{/if}
        </tbody>
    </table>
</MgmtPage>

<Modal bind:show title={editing?'Edit Tax Rate':'Add Tax Rate'} width="400px" dismissDisabled={saving}>
    <fieldset class="form-grid" disabled={saving} style="margin:0;padding:0;border:0;min-width:0">
        <div class="field span-2"><label for="tax-rate-name">Name *</label><input id="tax-rate-name" bind:value={cur.name} placeholder="e.g. Standard VAT" /></div>
        <div class="field span-2"><label for="tax-rate-value">Rate (%)</label><input id="tax-rate-value" type="number" bind:value={ratePercent} step="0.1" min="0" max="100" /></div>
        <div class="span-2"><TouchToggle bind:checked={cur.isDefault} label="Default Rate" /></div>
    </fieldset>
    <svelte:fragment slot="footer">
        <button class="btn btn-secondary" disabled={saving} on:click={() => show=false}>Cancel</button>
        <button class="btn btn-primary" disabled={saving} on:click={save}>{saving ? 'Saving...' : 'Save'}</button>
    </svelte:fragment>
</Modal>

<ConfirmDialog 
    bind:show={showDelConfirm} 
    title="Delete Tax Rate" 
    message="Are you sure you want to delete this tax rate?"
    variant="danger"
    on:confirm={handleDel}
/>
