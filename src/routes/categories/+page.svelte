<script lang="ts">
    import { Pencil, Plus, Star, Trash2 } from '@lucide/svelte';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import Modal from '$lib/components/Modal.svelte';
    import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
    import TouchToggle from '$lib/components/TouchToggle.svelte';
    import TouchColorPicker from '$lib/components/TouchColorPicker.svelte';
    import { categoriesDB, settingsDB, type Category, uuid, now } from '$lib/stores/db';
    import { toast } from '$lib/stores/toast';
    import { getCategoryUsageSummary, upsert, remove as removeSql } from '$lib/stores/database';
    import { randomTileColor } from '$lib/tileColors';
    import { DEFAULT_PRODUCT_CATEGORY_SETTING_KEY } from '$lib/categoryDefaults';
    import { onMount } from 'svelte';

    type CategoryUsage = { total: number; active: number; deactivated: number };

    let show = false; 
    let editing = false;
    let showDelConfirm = false;
    let idToDelete = "";
    let cur: Partial<Category> & { updatedAt?: string } = {};
    let searchQuery = "";
    let categoryUsageById = new Map<string, CategoryUsage>();
    let usageLoading = true;
    let saving = false;
    let deleting = false;
    let defaultSavingId = '';

    $: defaultCategoryId = $settingsDB.find(
        (setting) => setting.key === DEFAULT_PRODUCT_CATEGORY_SETTING_KEY,
    )?.value || '';

    $: filteredCategories = $categoriesDB.filter((category) => {
        const q = searchQuery.trim().toLowerCase();
        if (!q) return true;
        const usage = categoryUsage(category.id);
        return [
            category.name,
            category.isActive ? 'active' : 'inactive',
            usage.total,
            usage.active,
            usage.deactivated,
        ].some((value) => String(value || '').toLowerCase().includes(q));
    });

    function add() { 
        cur = { id: uuid(), name:'', color: randomTileColor(), sortOrder: $categoriesDB.length + 1, isActive:true, createdAt: now() };
        editing=false; 
        show=true; 
    }
    function edit(c: Category) { 
        cur = {...c}; 
        editing=true; 
        show=true; 
    }

    function categoryUsage(categoryId: string): CategoryUsage {
        return categoryUsageById.get(categoryId) || { total: 0, active: 0, deactivated: 0 };
    }

    async function loadCategoryUsage() {
        usageLoading = true;
        try {
            const rows = await getCategoryUsageSummary();
            categoryUsageById = new Map(rows.map(row => [row.categoryId, row]));
        } catch (error) {
            console.warn('Could not load category usage:', error);
        } finally {
            usageLoading = false;
        }
    }

    async function save() {
        if (saving) return;
        if (!cur.name?.trim()) { toast('Name is required', 'error'); return; }
        const sortOrder = Number(cur.sortOrder || 0);
        if (!Number.isInteger(sortOrder) || sortOrder < 0) {
            toast('Sort order must be 0 or higher', 'error');
            return;
        }
        if (editing && cur.id === defaultCategoryId && cur.isActive === false) {
            toast('Choose another default category before making this one inactive', 'error');
            return;
        }
        const record = {
            ...cur,
            name: cur.name.trim(),
            color: cur.color || '#3b82f6',
            sortOrder,
            isActive: cur.isActive !== false,
            updatedAt: now(),
        } as Category & { updatedAt: string };
        saving = true;
        try {
            await upsert('categories', record);
        } catch (e) {
            console.error(e); toast('Failed to save category', 'error'); return;
        } finally {
            saving = false;
        }
        categoriesDB.update(list => editing
            ? list.map(c => c.id === record.id ? record : c)
            : [...list, record]);
        show = false;
        toast(editing ? 'Category updated' : 'Category added');
    }

    async function setDefaultCategory(category: Category) {
        if (!category.isActive || defaultSavingId) return;
        if (category.id === defaultCategoryId) return;
        defaultSavingId = category.id;
        const setting = {
            key: DEFAULT_PRODUCT_CATEGORY_SETTING_KEY,
            value: category.id,
            updatedAt: now(),
        };
        try {
            await upsert('settings', setting, 'key');
            settingsDB.update((list) => [
                ...list.filter((item) => item.key !== setting.key),
                setting,
            ]);
            toast(`${category.name} is now the default category`, 'success');
        } catch (error) {
            console.error(error);
            toast('Default category was not saved', 'error');
        } finally {
            defaultSavingId = '';
        }
    }

    async function confirmDel(id: string) {
        await loadCategoryUsage();
        const usage = categoryUsage(id);
        if (usage.total > 0) {
            toast(`This category is used by ${usage.total} item${usage.total === 1 ? '' : 's'} (${usage.active} active, ${usage.deactivated} deactivated). Move those items first.`, 'error');
            return;
        }
        idToDelete = id;
        showDelConfirm = true;
    }

    async function handleDel() {
        if (deleting) return;
        const id = idToDelete;
        deleting = true;
        try {
            await removeSql('categories', id);
        } catch (e) {
            console.error(e); toast('Failed to delete category', 'error'); return;
        } finally {
            deleting = false;
        }
        categoriesDB.update(l => l.filter(c => c.id !== id));
        if (id === defaultCategoryId) {
            const setting = { key: DEFAULT_PRODUCT_CATEGORY_SETTING_KEY, value: '', updatedAt: now() };
            try {
                await upsert('settings', setting, 'key');
                settingsDB.update((list) => [
                    ...list.filter((item) => item.key !== setting.key),
                    setting,
                ]);
            } catch (error) {
                console.warn('Could not clear the deleted default category:', error);
            }
        }
        toast('Category deleted', 'info');
        showDelConfirm = false;
    }

    onMount(loadCategoryUsage);
</script>

<MgmtPage title="Categories">
    <button slot="actions" class="btn btn-primary" on:click={add}><Plus size={19} strokeWidth={2.5} />Add Category</button>
    <div class="p-4 border-b border-border-flat bg-bg-panel">
        <div class="flex items-center gap-3">
            <div class="relative min-w-0 flex-1">
                <svg class="absolute left-4 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20">
                    <circle cx="11" cy="11" r="8"></circle>
                    <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                </svg>
                <input class="search-input !pl-12" bind:value={searchQuery} placeholder="Search categories..." />
            </div>
            <span class="min-w-[92px] text-center text-sm font-bold text-text-muted">
                {filteredCategories.length} / {$categoriesDB.length}
            </span>
            {#if searchQuery}
                <button class="btn btn-secondary" on:click={() => searchQuery = ''}>Clear</button>
            {/if}
        </div>
    </div>
    <table class="tbl">
        <thead><tr><th>Color</th><th>Name</th><th>Sort Order</th><th>Items</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>
            {#each filteredCategories as cat}
            {@const usage = categoryUsage(cat.id)}
            <tr>
                <td><div class="swatch" style="background:{cat.color}"></div></td>
                <td class="font-semibold">
                    <div class="flex items-center gap-2">
                        <span>{cat.name}</span>
                        {#if cat.id === defaultCategoryId}<span class="tag !text-accent-primary">Default</span>{/if}
                    </div>
                </td>
                <td>{cat.sortOrder}</td>
                <td>
                    {#if usageLoading}
                        <span class="text-text-muted">...</span>
                    {:else}
                        <span class="font-semibold">{usage.total}</span>
                        <span class="text-text-muted text-xs">({usage.active} active, {usage.deactivated} deactivated)</span>
                    {/if}
                </td>
                <td>
                    <span class="tag">{cat.isActive ? 'Active' : 'Inactive'}</span>
                </td>
                <td><div class="act-row">
                    <button
                        class="btn-icon act-btn {cat.id === defaultCategoryId ? '!text-warning' : ''}"
                        title={cat.id === defaultCategoryId ? 'Default category for new items' : `Make ${cat.name} the default category`}
                        aria-label={cat.id === defaultCategoryId ? `${cat.name} is the default category` : `Make ${cat.name} the default category`}
                        disabled={!cat.isActive || defaultSavingId !== ''}
                        on:click={() => setDefaultCategory(cat)}
                    ><Star size={16} fill={cat.id === defaultCategoryId ? 'currentColor' : 'none'} /></button>
                    <button class="btn-icon act-btn" title="Edit category" aria-label={`Edit ${cat.name}`} on:click={() => edit(cat)}><Pencil size={16} /></button>
                    <button class="btn-icon act-btn danger" title="Delete category" aria-label={`Delete ${cat.name}`} on:click={() => confirmDel(cat.id)}><Trash2 size={16} /></button>
                </div></td>
            </tr>
            {/each}
            {#if $categoriesDB.length === 0}<tr class="empty-row"><td colspan="6">No categories yet.</td></tr>{/if}
            {#if $categoriesDB.length > 0 && filteredCategories.length === 0}<tr class="empty-row"><td colspan="6">No categories match your search.</td></tr>{/if}
        </tbody>
    </table>
</MgmtPage>

<Modal bind:show title={editing ? 'Edit Category' : 'Add Category'} width="420px">
    <div class="form-grid">
        <div class="field span-2"><label for="category-name">Name *</label><input id="category-name" bind:value={cur.name} placeholder="e.g. Drinks" /></div>
        <div class="field span-2"><label for="category-sort-order">Sort Order</label><input id="category-sort-order" type="number" bind:value={cur.sortOrder} /></div>
        
        <div class="span-2"><TouchColorPicker bind:value={cur.color} label="Category Color" /></div>
        
        <div class="span-2"><TouchToggle bind:checked={cur.isActive} label="Active Status" /></div>
    </div>
    <svelte:fragment slot="footer">
        <button class="btn btn-secondary" disabled={saving} on:click={() => show=false}>Cancel</button>
        <button class="btn btn-primary" disabled={saving} on:click={save}>{saving ? 'Saving...' : 'Save'}</button>
    </svelte:fragment>
</Modal>

<ConfirmDialog 
    bind:show={showDelConfirm} 
    title="Delete Category" 
    message="Delete this category? This is only allowed when no items are using it."
    variant="danger"
    on:confirm={handleDel}
/>
