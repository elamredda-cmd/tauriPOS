<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { Pencil, Plus, Trash2 } from '@lucide/svelte';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import Modal from '$lib/components/Modal.svelte';
    import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
    import SearchField from '$lib/components/SearchField.svelte';
    import { suppliersDB, type Supplier, uuid, now } from '$lib/stores/db';
    import { toast } from '$lib/stores/toast';
    import { upsert, remove as removeSql, getSuppliersPage } from '$lib/stores/database';
    import { nativeQaEnabled, nativeQaCheckpoint } from '$lib/nativeQa';
    let show = false; let editing = false;
    let showDeleteConfirm = false;
    let supplierToDelete: Supplier | null = null;
    let cur: Partial<Supplier> = {};
    let saving = false;
    let deleting = false;
    let search = '';
    let appliedSearch = '';
    let page = 0;
    const PAGE_SIZE = 25;
    let rows: Supplier[] = [];
    let total = 0;
    let loading = false;
    let loadError = '';
    let loadVersion = 0;
    let mounted = false;
    $: pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
    onMount(() => { mounted = true; void loadPage(); });
    onDestroy(() => { mounted = false; loadVersion += 1; });
    async function loadPage() {
        const version = ++loadVersion;
        loading = true;
        loadError = '';
        try {
            const result = await getSuppliersPage({ query: appliedSearch, limit: PAGE_SIZE, offset: page * PAGE_SIZE });
            if (nativeQaEnabled) await nativeQaCheckpoint('suppliers.load');
            if (!mounted || version !== loadVersion) return;
            total = result.total;
            rows = result.rows;
            const last = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
            if (page > last) { page = last; void loadPage(); }
        } catch (error) {
            if (mounted && version === loadVersion) loadError = `Could not load suppliers: ${String(error).replace(/^Error:\s*/, '')}`;
        } finally { if (mounted && version === loadVersion) loading = false; }
    }
    function find() { appliedSearch = search.trim(); page = 0; void loadPage(); }
    function clearSearch() { search = ''; find(); }
    function changePage(direction: number) { page = Math.max(0, Math.min(pageCount - 1, page + direction)); void loadPage(); }
    function add() { if (saving || deleting) return; cur = { id:uuid(), name:'', contactName:'', phone:'', email:'', address:'', notes:'', createdAt:now() }; editing=false; show=true; }
    function edit(s: Supplier) { if (saving || deleting) return; cur={...s}; editing=true; show=true; }
    async function save() {
        if (saving) return;
        if (!cur.name?.trim()) { toast('Company name is required', 'error'); return; }
        const record = { ...cur, name: cur.name.trim(), updatedAt: now() } as Supplier;
        const wasEditing = editing;
        saving = true;
        try {
            if (nativeQaEnabled) await nativeQaCheckpoint('suppliers.save');
            await upsert('suppliers', record);
            suppliersDB.update(l => [...l.filter(s => s.id !== record.id), record]);
            show=false;
            toast(wasEditing ? 'Supplier updated' : 'Supplier added');
            await loadPage();
        } catch (e) { console.error(e); toast('Failed to save supplier', 'error'); }
        finally { saving = false; }
    }
    function requestDelete(supplier: Supplier) {
        if (saving || deleting) return;
        supplierToDelete = supplier;
        showDeleteConfirm = true;
    }
    async function del() {
        if (!supplierToDelete || deleting) return;
        const id = supplierToDelete.id;
        deleting = true;
        try {
            await removeSql('suppliers', id);
            suppliersDB.update(l => l.filter(s => s.id!==id));
            toast('Supplier deleted', 'info');
            showDeleteConfirm = false;
            supplierToDelete = null;
            await loadPage();
        } catch (e) { console.error(e); toast('Failed to delete supplier', 'error'); }
        finally { deleting = false; }
    }
</script>

<MgmtPage title="Suppliers">
    <button slot="actions" class="btn btn-primary" disabled={saving || deleting} on:click={add}><Plus size={19} strokeWidth={2.5} />Add Supplier</button>
    <div class="supplier-workspace">
    <div class="search-strip supplier-search-strip">
        <div class="search-controls search-controls-fill">
            <div class="search-primary"><SearchField id="supplier-search" bind:value={search} placeholder="Search company, contact, phone, or email" ariaLabel="Search suppliers" onClear={clearSearch} onKeydown={event => { if (event.key === 'Enter') { event.preventDefault(); find(); } }} /></div>
            <button class="btn btn-primary" disabled={loading} on:click={find}>Find</button>
            <span class="search-meta">{loading ? 'Loading...' : `${total} suppliers`}</span>
        </div>
    </div>
    <div class="supplier-table-wrap">
        <table class="tbl supplier-table">
            <thead><tr><th>Company</th><th>Contact</th><th class="supplier-phone-column">Phone</th><th class="supplier-email-column">Email</th><th class="supplier-actions-column">Actions</th></tr></thead>
            <tbody>
                {#each rows as s}
                <tr>
                    <td class="supplier-text-cell font-semibold">
                        <span title={s.name}>{s.name}</span>
                        <small class="supplier-email-compact" title={s.email || 'No email address'}>{s.email || 'No email address'}</small>
                    </td>
                    <td class="supplier-text-cell"><span title={s.contactName || 'No contact person'}>{s.contactName || '-'}</span></td>
                    <td class="supplier-phone-column mono" title={s.phone || 'No phone number'}>{s.phone || '-'}</td>
                    <td class="supplier-email-column supplier-text-cell"><span title={s.email || 'No email address'}>{s.email || '-'}</span></td>
                    <td class="supplier-actions-column"><div class="supplier-action-row">
                        <button class="btn-icon act-btn" disabled={saving || deleting} title={`Edit ${s.name}`} aria-label={`Edit ${s.name}`} on:click={() => edit(s)}><Pencil size={16} /></button>
                        <button class="btn-icon act-btn danger" disabled={saving || deleting} title={`Delete ${s.name}`} aria-label={`Delete ${s.name}`} on:click={() => requestDelete(s)}><Trash2 size={16} /></button>
                    </div></td>
                </tr>
                {/each}
                {#if loading}<tr class="empty-row"><td colspan="5">Loading suppliers...</td></tr>
                {:else if loadError}<tr class="empty-row"><td colspan="5">{loadError} <button class="btn btn-secondary" on:click={loadPage}>Try Again</button></td></tr>
                {:else if rows.length===0}<tr class="empty-row"><td colspan="5">{appliedSearch ? 'No suppliers match this search.' : 'No suppliers yet.'}</td></tr>{/if}
            </tbody>
        </table>
    </div>
    <div class="supplier-pagination">
        <span>{total === 0 ? '0' : `${page * PAGE_SIZE + 1}–${Math.min(total, (page + 1) * PAGE_SIZE)}`} of {total} suppliers</span>
        <div><button class="btn btn-secondary" disabled={loading || page === 0} on:click={() => changePage(-1)}>Previous</button><span>Page {page + 1} of {pageCount}</span><button class="btn btn-secondary" disabled={loading || page >= pageCount - 1} on:click={() => changePage(1)}>Next</button></div>
    </div>
    </div>
</MgmtPage>

<Modal bind:show title={editing?'Edit Supplier':'Add Supplier'} width="560px" dismissDisabled={saving}>
    <fieldset class="form-grid" disabled={saving} style="margin:0;padding:0;border:0;min-width:0">
        <div class="field span-2"><label for="supplier-name">Company Name *</label><input id="supplier-name" bind:value={cur.name} /></div>
        <div class="field"><label for="supplier-contact">Contact Person</label><input id="supplier-contact" bind:value={cur.contactName} /></div>
        <div class="field"><label for="supplier-phone">Phone</label><input id="supplier-phone" bind:value={cur.phone} /></div>
        <div class="field"><label for="supplier-email">Email</label><input id="supplier-email" type="email" bind:value={cur.email} /></div>
        <div class="field"><label for="supplier-address">Address</label><input id="supplier-address" bind:value={cur.address} /></div>
        <div class="field span-2"><label for="supplier-notes">Notes</label><textarea id="supplier-notes" bind:value={cur.notes}></textarea></div>
    </fieldset>
    <svelte:fragment slot="footer">
        <button class="btn btn-secondary" disabled={saving} on:click={() => show=false}>Cancel</button>
        <button class="btn btn-primary" disabled={saving} on:click={save}>{saving ? 'Saving...' : 'Save'}</button>
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
    .supplier-workspace { display:flex; flex-direction:column; height:100%; min-height:0; }
    .supplier-table-wrap {
        min-width: 0;
        width: 100%;
        flex: 1;
        min-height: 0;
        overflow: auto;
        overscroll-behavior: contain;
    }

    .supplier-search-strip { flex: 0 0 auto; }
    .supplier-pagination { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:.5rem; padding:.65rem; border-top:1px solid var(--border-flat); font-size:.85rem; }
    .supplier-pagination > div { display:flex; align-items:center; gap:.5rem; }

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
