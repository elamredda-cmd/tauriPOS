<script lang="ts">
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import { storeDB, settingsDB, type Store, now } from '$lib/stores/db';
    import { toast } from '$lib/stores/toast';
    import { upsert, getTillName, setTillName as setTillNameDb, getOrCreateTillId, runSyncCycle, forceFullSync } from '$lib/stores/database';
    import { connectionState } from '$lib/stores/connection';

    let store = { ...$storeDB };

    function saveStore() {
        storeDB.set(store as Store);
        upsert('settings', { key: 'store_info', value: JSON.stringify(store), updatedAt: now() }, 'key');
        toast('Store settings saved');
    }

    function updateSetting(key: string, value: string) {
        const s = { key, value, updatedAt: now() };
        settingsDB.update(list => {
            const idx = list.findIndex(x => x.key === key);
            if (idx >= 0) { list[idx] = s; }
            else { list.push(s); }
            return list;
        });
        upsert('settings', s, 'key');
    }

    function getSettingValue(key: string): string {
        return $settingsDB.find(s => s.key === key)?.value || '';
    }

    let showResetModal = false;
    let editTillName = '';
    let tillId = '';

    import { onMount } from 'svelte';
    onMount(async () => {
        editTillName = await getTillName();
        tillId = await getOrCreateTillId();
    });

    async function saveTillName() {
        await setTillNameDb(editTillName);
        toast('Till name saved');
    }

    function confirmReset() {
        localStorage.clear();
        window.location.href = '/'; // Using href to ensure it triggers a full reload in Tauri
    }

    let isSyncing = false;
    async function handleForceSync() {
        if (isSyncing) return;
        isSyncing = true;
        try {
            await forceFullSync();
            toast('Sync completed successfully!', 'success');
        } catch (e) {
            toast('Sync failed.', 'error');
        } finally {
            isSyncing = false;
        }
    }
</script>

<MgmtPage title="Settings">
    <button slot="actions" class="btn btn-primary" on:click={saveStore}>Save All</button>

    <div class="p-6 flex flex-col gap-8">
        <!-- Appearance -->
        <section class="settings-section">
            <div class="flex justify-between items-center">
                <div>
                    <h3 class="settings-section-title">App Appearance</h3>
                    <p class="text-text-muted text-[0.9rem] -mt-3">Choose your color theme and visual style.</p>
                </div>
                <a href="/settings/themes" class="btn btn-secondary">Change Theme</a>
            </div>
        </section>

        <!-- Button Layout -->
        <section class="settings-section">
            <div class="flex justify-between items-center">
                <div>
                    <h3 class="settings-section-title">Button Layout</h3>
                    <p class="text-text-muted text-[0.9rem] -mt-3">Reorder the action buttons on the POS screen.</p>
                </div>
                <a href="/settings/layout" class="btn btn-secondary">Edit Layout</a>
            </div>
        </section>

        <!-- Store Info -->
        <section class="settings-section">
            <h3 class="settings-section-title">Store Information</h3>
            <div class="form-grid">
                <div class="field span-2"><label>Store Name</label><input bind:value={store.name} /></div>
                <div class="field span-2"><label>Address</label><input bind:value={store.address} /></div>
                <div class="field"><label>Phone</label><input bind:value={store.phone} /></div>
                <div class="field"><label>Email</label><input type="email" bind:value={store.email} /></div>
                <div class="field"><label>Currency</label><input bind:value={store.currency} /></div>
                <div class="field justify-end">
                    <label class="field-row"><input type="checkbox" bind:checked={store.taxIncludedInPrice} /> Tax Included in Price</label>
                </div>
            </div>
        </section>

        <!-- Receipt -->
        <section class="settings-section">
            <h3 class="settings-section-title">Receipt</h3>
            <div class="form-grid">
                <div class="field span-2"><label>Header Text</label><textarea bind:value={store.receiptHeader}></textarea></div>
                <div class="field span-2"><label>Footer Text</label><textarea bind:value={store.receiptFooter}></textarea></div>
            </div>
        </section>

        <!-- Loyalty -->
        <section class="settings-section">
            <h3 class="settings-section-title">Loyalty Program</h3>
            <div class="form-grid">
                <div class="field"><label>Points per £1 spent</label>
                    <input type="number" value={getSettingValue('loyalty_points_per_pound')} on:change={(e) => updateSetting('loyalty_points_per_pound', e.currentTarget.value)} />
                </div>
                <div class="field"><label>Points to redeem</label>
                    <input type="number" value={getSettingValue('loyalty_points_to_redeem')} on:change={(e) => updateSetting('loyalty_points_to_redeem', e.currentTarget.value)} />
                </div>
                <div class="field"><label>Redemption value (pence)</label>
                    <input type="number" value={getSettingValue('loyalty_redemption_value')} on:change={(e) => updateSetting('loyalty_redemption_value', e.currentTarget.value)} />
                </div>
            </div>
        </section>

        <!-- Till Configuration -->
        <section class="settings-section">
            <h3 class="settings-section-title">Till Configuration</h3>
            <p class="text-text-muted text-[0.9rem] mb-4">Each machine auto-generates a unique identity. Set a display name below.</p>
            <div class="form-grid">
                <div class="field">
                    <label>Till Display Name</label>
                    <div class="flex gap-3">
                        <input bind:value={editTillName} placeholder="e.g. Till 1" />
                        <button class="btn btn-primary" on:click={saveTillName}>Save</button>
                    </div>
                </div>
                <div class="field">
                    <label>Starting Receipt Number</label>
                    <input type="number" value={getSettingValue('starting_receipt_number')} on:change={(e) => updateSetting('starting_receipt_number', e.currentTarget.value)} placeholder="e.g. 10000" />
                </div>
                <div class="field">
                    <label>Till ID (auto-generated)</label>
                    <input value={tillId} disabled class="!opacity-60" />
                </div>
            </div>
        </section>

        <!-- Database Connection -->
        <section class="settings-section">
            <h3 class="settings-section-title">Database Connection</h3>
            <p class="text-text-muted text-[0.9rem] mb-4">Monitor and manage the connection to the central MariaDB server.</p>
            <div class="p-4 bg-bg-root rounded-md border border-border-flat flex items-center justify-between mb-4">
                <div class="flex items-center gap-3">
                    <div class="w-3 h-3 rounded-full {$connectionState.mysqlOnline ? 'bg-success' : 'bg-danger'} shadow-[0_0_8px_currentColor]"></div>
                    <div>
                        <div class="font-bold text-[1.1rem]">{$connectionState.mysqlOnline ? 'Connected to MariaDB' : 'Offline / Single Mode'}</div>
                        {#if $connectionState.mode === 'multi'}
                            <div class="text-[0.9rem] text-text-muted mt-1">Host: {$connectionState.mysqlConfig?.host || 'Unknown'}</div>
                            {#if $connectionState.syncError}
                                <div class="text-[0.8rem] text-danger mt-1 p-2 bg-danger/10 rounded font-mono">{$connectionState.syncError}</div>
                            {/if}
                        {:else}
                            <div class="text-[0.9rem] text-text-muted mt-1">Operating entirely on local SQLite database.</div>
                        {/if}
                    </div>
                </div>
                {#if $connectionState.mode === 'multi'}
                    <button class="btn btn-secondary flex gap-2 items-center" on:click={handleForceSync} disabled={isSyncing}>
                        {#if isSyncing}
                            <div class="w-4 h-4 border-2 border-text-muted border-t-text-main rounded-full animate-spin"></div>
                            Syncing...
                        {:else}
                            Force Sync Now
                        {/if}
                    </button>
                {/if}
            </div>
            <div class="flex justify-end mt-2">
                <a href="/setup" class="btn btn-secondary">Change Setup / Database Mode</a>
            </div>
        </section>

        <!-- Danger Zone -->
        <section class="settings-section !border-danger">
            <h3 class="settings-section-title !text-danger">Danger Zone</h3>
            <p class="text-text-muted text-[0.9rem] mb-4">Clear all local data and reset the application to factory defaults.</p>
            <button class="btn btn-danger" on:click={() => showResetModal = true}>Reset All Data</button>
        </section>
    </div>
</MgmtPage>

{#if showResetModal}
<div class="modal-overlay !z-[999]">
    <div class="bg-bg-panel p-6 rounded-md max-w-[400px] text-center flex flex-col gap-4 border border-danger shadow-2xl">
        <h2 class="!text-danger">⚠️ Reset All Data?</h2>
        <p>This will delete all products, categories, orders, and settings. <strong>This action cannot be undone.</strong></p>
        <div class="flex gap-3 mt-5 justify-end">
            <button class="btn btn-primary" on:click={() => showResetModal = false}>Cancel</button>
            <button class="btn btn-danger" on:click={confirmReset}>Yes, Reset Everything</button>
        </div>
    </div>
</div>
{/if}


