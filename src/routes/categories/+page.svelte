<script lang="ts">
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import Modal from '$lib/components/Modal.svelte';
    import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
    import TouchToggle from '$lib/components/TouchToggle.svelte';
    import TouchColorPicker from '$lib/components/TouchColorPicker.svelte';
    import { categoriesDB, type Category, uuid, now } from '$lib/stores/db';
    import { toast } from '$lib/stores/toast';
    import { upsert, remove as removeSql } from '$lib/stores/sqlite';

    let show = false; 
    let editing = false;
    let showDelConfirm = false;
    let idToDelete = "";
    let cur: Partial<Category> = {};

    function add() { 
        cur = { id: uuid(), name:'', color:'#3b82f6', sortOrder: $categoriesDB.length + 1, isActive:true, showOnPos:true, createdAt: now() }; 
        editing=false; 
        show=true; 
    }
    function edit(c: Category) { 
        cur = {...c}; 
        editing=true; 
        show=true; 
    }
    async function save() {
        if (!cur.name) { toast('Name is required', 'error'); return; }
        const record = cur as Category;
        try {
            await upsert('categories', record);
        } catch (e) {
            console.error(e); toast('Failed to save category', 'error'); return;
        }
        categoriesDB.update(list => editing
            ? list.map(c => c.id === record.id ? record : c)
            : [...list, record]);
        show = false;
        toast(editing ? 'Category updated' : 'Category added');
    }

    function confirmDel(id: string) {
        idToDelete = id;
        showDelConfirm = true;
    }

    async function handleDel() {
        const id = idToDelete;
        try {
            await removeSql('categories', id);
        } catch (e) {
            console.error(e); toast('Failed to delete category', 'error'); return;
        }
        categoriesDB.update(l => l.filter(c => c.id !== id));
        toast('Category deleted', 'info');
        showDelConfirm = false;
    }
</script>

<MgmtPage title="Categories">
    <button slot="actions" class="btn btn-primary" on:click={add}>+ Add Category</button>
    <table class="tbl">
        <thead><tr><th>Color</th><th>Name</th><th>Sort Order</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>
            {#each $categoriesDB as cat}
            <tr>
                <td><div class="swatch" style="background:{cat.color}"></div></td>
                <td class="font-semibold">{cat.name}</td>
                <td>{cat.sortOrder}</td>
                <td>
                    <span class="tag">{cat.isActive ? 'Active' : 'Inactive'}</span>
                    {#if cat.showOnPos}<span class="tag !bg-accent-primary !text-white !border-0 ml-1">POS</span>{/if}
                </td>
                <td><div class="act-row">
                    <button class="btn-icon act-btn" on:click={() => edit(cat)}>✎</button>
                    <button class="btn-icon act-btn danger" on:click={() => confirmDel(cat.id)}>✕</button>
                </div></td>
            </tr>
            {/each}
            {#if $categoriesDB.length === 0}<tr class="empty-row"><td colspan="5">No categories yet.</td></tr>{/if}
        </tbody>
    </table>
</MgmtPage>

<Modal bind:show title={editing ? 'Edit Category' : 'Add Category'} width="420px">
    <div class="form-grid">
        <div class="field span-2"><label>Name *</label><input bind:value={cur.name} placeholder="e.g. Drinks" /></div>
        <div class="field span-2"><label>Sort Order</label><input type="number" bind:value={cur.sortOrder} /></div>
        
        <div class="span-2"><TouchColorPicker bind:value={cur.color} label="Category Color" /></div>
        
        <div class="span-2"><TouchToggle bind:checked={cur.isActive} label="Active Status" /></div>
        <div class="span-2"><TouchToggle bind:checked={cur.showOnPos} label="Show on POS" /></div>
    </div>
    <svelte:fragment slot="footer">
        <button class="btn btn-danger" on:click={() => show=false}>Cancel</button>
        <button class="btn btn-primary" on:click={save}>Save</button>
    </svelte:fragment>
</Modal>

<ConfirmDialog 
    bind:show={showDelConfirm} 
    title="Delete Category" 
    message="Are you sure you want to delete this category? This will not delete the products in it, but they will become uncategorized."
    variant="danger"
    on:confirm={handleDel}
/>


