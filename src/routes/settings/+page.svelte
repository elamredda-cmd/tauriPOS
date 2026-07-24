<script lang="ts">
    import { onMount } from 'svelte';
    import { isTauri } from '@tauri-apps/api/core';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import { connectionState } from '$lib/stores/connection';
    import { currentEmployee } from '$lib/stores/session';
    import { storeDB, settingsDB, type Store, now, formatMoney } from '$lib/stores/db';
    import { upsert, getTillName, setTillName as setTillNameDb, getOrCreateTillId } from '$lib/stores/database';
    import { toast } from '$lib/stores/toast';
    import { appFontOptions, appFontSizeOptions, normalizeAppFontChoice } from '$lib/typography';
    import {
        BadgePercent,
        Banknote,
        Barcode,
        Cctv,
        ChevronRight,
        CreditCard,
        Database,
        GraduationCap,
        HardDrive,
        KeyRound,
        Monitor,
        MonitorCog,
        PackageCheck,
        Palette,
        Printer,
        Save,
        Scale,
        Smartphone,
        Store as StoreIcon,
        Type,
        Volume2,
        Wrench,
    } from '@lucide/svelte';

    type SettingsShortcut = {
        title: string;
        group: string;
        description: string;
        path: string;
        accent: string;
        icon: typeof Palette;
        adminOnly?: boolean;
    };

    const settingsShortcuts: SettingsShortcut[] = [
        { title: 'Colour theme', group: 'Appearance', description: 'Colours and contrast', path: '/settings/themes', accent: '#2563eb', icon: Palette },
        { title: 'Fonts & text', group: 'Appearance', description: 'Writing style and sizes', path: '/settings/fonts', accent: '#db2777', icon: Type },
        { title: 'Printers & drawer', group: 'Hardware', description: 'Receipts, labels and drawer', path: '/settings/printers', accent: '#16a34a', icon: Printer },
        { title: 'Scale', group: 'Hardware', description: 'Port and weighing setup', path: '/settings/scale', accent: '#0f766e', icon: Scale },
        { title: 'Scale barcodes', group: 'Barcodes', description: 'Embedded price rules', path: '/settings/barcodes', accent: '#16a34a', icon: Barcode },
        { title: 'Customer display', group: 'Checkout', description: 'Second-screen basket', path: '/settings/customer-display', accent: '#2563eb', icon: Monitor },
        { title: 'Card terminals', group: 'Checkout', description: 'SumUp, Dojo and providers', path: '/settings/payments', accent: '#059669', icon: CreditCard },
        { title: 'Sound & haptics', group: 'Till feedback', description: 'Scan and button feedback', path: '/settings/feedback', accent: '#7c3aed', icon: Volume2 },
        { title: 'CCTV overlay', group: 'Integrations', description: 'DVR and NVR sale text', path: '/settings/integrations', accent: '#0f766e', icon: Cctv },
        { title: 'Shop licence', group: 'Administration', description: 'Activation and till seats', path: '/settings/licence', accent: '#16a34a', icon: KeyRound, adminOnly: true },
        { title: 'Owner app', group: 'Administration', description: 'Pair the live dashboard', path: '/settings/owner-app', accent: '#2563eb', icon: Smartphone, adminOnly: true },
        { title: 'Maintenance', group: 'Administration', description: 'Backup, restore and repair', path: '/settings/advanced', accent: '#dc2626', icon: Wrench, adminOnly: true },
    ];

    let store = { ...$storeDB };
    let editTillName = '';
    let tillId = '';

    $: stockTrackingEnabled = ($settingsDB.find(s => s.key === 'stock_tracking_enabled')?.value ?? 'true') !== 'false';
    $: loyaltyEnabled = ($settingsDB.find(s => s.key === 'loyalty_enabled')?.value ?? 'true') !== 'false';
    $: cashUpEnabled = ($settingsDB.find(s => s.key === 'cash_up_enabled')?.value ?? 'false') === 'true';
    $: openingFloatRequired = ($settingsDB.find(s => s.key === 'cash_up_require_opening_float')?.value ?? 'true') !== 'false';
    $: cardReconciliationEnabled = ($settingsDB.find(s => s.key === 'cash_up_reconcile_card')?.value ?? 'true') !== 'false';
    $: trainingModeEnabled = ($settingsDB.find(s => s.key === 'training_mode_enabled')?.value ?? 'false') === 'true';
    $: selectedAppFont = normalizeAppFontChoice($settingsDB.find(s => s.key === 'ui_font_family')?.value || 'inter');
    $: selectedPosFontSize = $settingsDB.find(s => s.key === 'ui_font_size_pos')?.value || 'normal';
    $: selectedSettingsFontSize = $settingsDB.find(s => s.key === 'ui_font_size_settings')?.value || 'normal';
    $: selectedFontOption = appFontOptions.find((option) => option.value === selectedAppFont) || appFontOptions[0];
    $: loyaltyPointsPerPound = loyaltyNumber('loyalty_points_per_pound', 0, 1);
    $: loyaltyPointsRequired = loyaltyNumber('loyalty_points_to_redeem', 1, 100);
    $: loyaltyCreditValue = loyaltyNumber('loyalty_redemption_value', 1, 100);
    $: visibleSettingsShortcuts = settingsShortcuts.filter((entry) => !entry.adminOnly || $currentEmployee?.role === 'admin');

    onMount(async () => {
        if (!isTauri()) {
            editTillName = 'Preview Till';
            tillId = 'preview-till';
            return;
        }
        editTillName = await getTillName();
        tillId = await getOrCreateTillId();
    });

    async function updateSetting(key: string, value: string) {
        const row = { key, value, updatedAt: now() };
        settingsDB.update(settings => {
            const index = settings.findIndex(item => item.key === key);
            if (index >= 0) return settings.map((item, itemIndex) => itemIndex === index ? row : item);
            return [...settings, row];
        });
        await upsert('settings', row, 'key');
    }

    function getSettingValue(key: string): string {
        return $settingsDB.find(s => s.key === key)?.value || '';
    }

    function loyaltyNumber(key: string, minimum: number, fallback: number): number {
        const parsed = Math.floor(Number(getSettingValue(key)));
        return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
    }

    async function updateLoyaltyNumber(key: string, rawValue: string, minimum: number, fallback: number) {
        const parsed = Math.floor(Number(rawValue));
        const value = Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
        await updateSetting(key, String(value));
        if (rawValue.trim() !== String(value)) {
            toast(`Loyalty value adjusted to ${value}`, 'info');
        }
    }

    function saveStore() {
        storeDB.set(store as Store);
        upsert('settings', { key: 'store_info', value: JSON.stringify(store), updatedAt: now() }, 'key');
        toast('Store settings saved');
    }

    function setStockTracking(enabled: boolean) {
        updateSetting('stock_tracking_enabled', enabled ? 'true' : 'false');
        toast(enabled ? 'Stock tracking enabled' : 'Stock tracking disabled across the shop');
    }

    function setCashUpEnabled(enabled: boolean) {
        updateSetting('cash_up_enabled', enabled ? 'true' : 'false');
        if (enabled) updateSetting('cash_up_activation_time', now());
        toast(enabled ? 'Till cash-up enabled across the shop' : 'Till cash-up disabled across the shop');
    }

    async function saveTillName() {
        await setTillNameDb(editTillName);
        toast('Till name saved');
    }

    function selectedSizeLabel(value: string): string {
        return appFontSizeOptions.find((option) => option.value === value)?.label || 'Normal';
    }
</script>

<svelte:head>
    <title>Settings</title>
</svelte:head>

<MgmtPage title="Settings">
    <button slot="actions" class="btn btn-primary settings-save-button" on:click={saveStore}>
        <Save size={19} strokeWidth={2.4} aria-hidden="true" />
        <span>Save shop</span>
    </button>

    <div class="settings-overview">
        <section class="settings-summary" aria-label="Current shop status">
            <div class="settings-summary-item settings-summary-shop">
                <span class="settings-summary-icon"><StoreIcon size={23} strokeWidth={2.25} /></span>
                <span class="settings-summary-copy"><small>Shop</small><strong>{store.name || 'Store information'}</strong></span>
            </div>
            <div class="settings-summary-item">
                <span class="settings-summary-icon"><Database size={22} strokeWidth={2.25} /></span>
                <span class="settings-summary-copy">
                    <small>Database</small>
                    <strong class="settings-summary-state">
                        <span class="settings-status-dot" class:online={$connectionState.mode !== 'multi' || $connectionState.mysqlOnline}></span>
                        <span>{$connectionState.mode === 'multi' ? ($connectionState.mysqlOnline ? 'MariaDB online' : 'MariaDB offline') : 'Standalone'}</span>
                    </strong>
                </span>
            </div>
            <div class="settings-summary-item">
                <span class="settings-summary-icon"><MonitorCog size={22} strokeWidth={2.25} /></span>
                <span class="settings-summary-copy"><small>This till</small><strong>{editTillName || 'Loading...'}</strong></span>
            </div>
            <div class="settings-summary-item">
                <span class="settings-summary-icon"><PackageCheck size={22} strokeWidth={2.25} /></span>
                <span class="settings-summary-copy"><small>Stock</small><strong>{stockTrackingEnabled ? 'Tracking on' : 'Tracking off'}</strong></span>
            </div>
        </section>

        {#if $connectionState.syncError}
            <div class="settings-sync-error" role="alert">{$connectionState.syncError}</div>
        {/if}

        <section class="settings-shortcuts-section">
            <div class="settings-section-heading">
                <div>
                    <span>Setup</span>
                    <h2>Appearance, hardware and services</h2>
                </div>
                <small>{visibleSettingsShortcuts.length} sections</small>
            </div>
            <nav class="settings-shortcut-grid" aria-label="Settings sections">
                {#each visibleSettingsShortcuts as entry (entry.path)}
                    <a
                        href={entry.path}
                        class="settings-shortcut"
                        class:admin-shortcut={entry.adminOnly}
                        style="--setting-accent: {entry.accent}"
                        aria-label={`${entry.title}. ${entry.description}`}
                    >
                        <span class="settings-shortcut-mark" aria-hidden="true"></span>
                        <span class="settings-shortcut-icon" aria-hidden="true">
                            <svelte:component this={entry.icon} size={23} strokeWidth={2.25} />
                        </span>
                        <span class="settings-shortcut-copy">
                            <small>{entry.group}</small>
                            <strong>{entry.title}</strong>
                            <span>
                                {entry.path === '/settings/fonts'
                                    ? `${selectedFontOption.label}; POS ${selectedSizeLabel(selectedPosFontSize)}, settings ${selectedSizeLabel(selectedSettingsFontSize)}`
                                    : entry.description}
                            </span>
                        </span>
                        <span class="settings-shortcut-arrow" aria-hidden="true"><ChevronRight size={19} strokeWidth={2.5} /></span>
                    </a>
                {/each}
            </nav>
        </section>

        <section class="settings-section-heading settings-controls-heading">
            <div>
                <span>Shop controls</span>
                <h2>Business and till settings</h2>
            </div>
        </section>

        <div class="settings-config-columns">
            <div class="settings-config-column">
                <section class="settings-config-panel">
                    <header class="settings-panel-header">
                        <span class="settings-panel-icon"><StoreIcon size={22} strokeWidth={2.25} /></span>
                        <div><h3>Store information</h3><p>Printed on receipts and customer documents.</p></div>
                    </header>
                    <div class="form-grid settings-form-grid">
                        <div class="field span-2"><label for="settings-store-name">Store name</label><input id="settings-store-name" bind:value={store.name} /></div>
                        <div class="field span-2"><label for="settings-store-address">Address</label><input id="settings-store-address" bind:value={store.address} /></div>
                        <div class="field"><label for="settings-store-phone">Phone</label><input id="settings-store-phone" bind:value={store.phone} /></div>
                        <div class="field"><label for="settings-store-email">Email</label><input id="settings-store-email" type="email" bind:value={store.email} /></div>
                    </div>
                </section>

                <section class="settings-config-panel">
                    <header class="settings-panel-header">
                        <span class="settings-panel-icon"><MonitorCog size={22} strokeWidth={2.25} /></span>
                        <div><h3>Till identity</h3><p>The ID stays fixed when the display name changes.</p></div>
                    </header>
                    <div class="settings-till-fields">
                        <div class="field">
                            <label for="settings-till-name">Till display name</label>
                            <div class="settings-inline-field">
                                <input id="settings-till-name" bind:value={editTillName} placeholder="e.g. Till 1" />
                                <button class="btn btn-primary" on:click={saveTillName}>Save name</button>
                            </div>
                        </div>
                        <div class="field">
                            <label for="settings-till-id">Till ID</label>
                            <input id="settings-till-id" value={tillId} readonly class="settings-readonly-input" />
                        </div>
                    </div>
                </section>

                <section class="settings-config-panel settings-database-panel">
                    <header class="settings-panel-header">
                        <span class="settings-panel-icon"><HardDrive size={22} strokeWidth={2.25} /></span>
                        <div>
                            <h3>Database</h3>
                            <p>{$connectionState.mysqlOnline ? 'Connected to the central MariaDB server.' : 'Working from this till’s local SQLite database.'}</p>
                        </div>
                    </header>
                </section>
            </div>

            <div class="settings-config-column">
                <section class="settings-config-panel">
                    <header class="settings-panel-header settings-panel-header-action">
                        <span class="settings-panel-icon"><BadgePercent size={22} strokeWidth={2.25} /></span>
                        <div><h3>Loyalty programme</h3><p>Points earned and their spendable value.</p></div>
                        <button
                            type="button"
                            class="settings-switch-control"
                            class:enabled={loyaltyEnabled}
                            role="switch"
                            aria-checked={loyaltyEnabled}
                            aria-label="Loyalty programme"
                            on:click={() => updateSetting('loyalty_enabled', loyaltyEnabled ? 'false' : 'true')}
                        ><span>{loyaltyEnabled ? 'On' : 'Off'}</span><span class="settings-switch-track"><span></span></span></button>
                    </header>
                    <div class="settings-loyalty-grid" class:disabled-settings={!loyaltyEnabled}>
                        <div class="field"><label for="loyalty-points-per-pound">Points per £1</label>
                            <input id="loyalty-points-per-pound" disabled={!loyaltyEnabled} type="number" inputmode="numeric" min="0" step="1" value={loyaltyPointsPerPound} on:change={(e) => updateLoyaltyNumber('loyalty_points_per_pound', e.currentTarget.value, 0, 1)} />
                        </div>
                        <div class="field"><label for="loyalty-points-required">Points for credit</label>
                            <input id="loyalty-points-required" disabled={!loyaltyEnabled} type="number" inputmode="numeric" min="1" step="1" value={loyaltyPointsRequired} on:change={(e) => updateLoyaltyNumber('loyalty_points_to_redeem', e.currentTarget.value, 1, 100)} />
                        </div>
                        <div class="field"><label for="loyalty-credit-value">Credit (pence)</label>
                            <input id="loyalty-credit-value" disabled={!loyaltyEnabled} type="number" inputmode="numeric" min="1" step="1" value={loyaltyCreditValue} on:change={(e) => updateLoyaltyNumber('loyalty_redemption_value', e.currentTarget.value, 1, 100)} />
                        </div>
                    </div>
                    <div class="settings-example">{loyaltyPointsRequired.toLocaleString()} points = {formatMoney(loyaltyCreditValue)} credit</div>
                </section>

                <section class="settings-config-panel">
                    <header class="settings-panel-header">
                        <span class="settings-panel-icon"><PackageCheck size={22} strokeWidth={2.25} /></span>
                        <div><h3>Shop operation</h3><p>Daily behaviour for selling and cash-up.</p></div>
                    </header>

                    <div class="settings-operation-list">
                        <div class="settings-operation-row">
                            <span class="settings-operation-icon"><PackageCheck size={20} /></span>
                            <div><strong>Stock tracking</strong><span>Updates quantities after sales and refunds. Shop-wide.</span></div>
                            <button
                                type="button"
                                class="settings-switch-control"
                                class:enabled={stockTrackingEnabled}
                                role="switch"
                                aria-checked={stockTrackingEnabled}
                                aria-label="Stock tracking"
                                on:click={() => setStockTracking(!stockTrackingEnabled)}
                            ><span>{stockTrackingEnabled ? 'On' : 'Off'}</span><span class="settings-switch-track"><span></span></span></button>
                        </div>

                        <div class="settings-operation-row">
                            <span class="settings-operation-icon training"><GraduationCap size={20} /></span>
                            <div><strong>Training mode</strong><span>Practice on this till without saving transactions.</span></div>
                            <button
                                type="button"
                                class="settings-switch-control"
                                class:enabled={trainingModeEnabled}
                                class:danger-enabled={trainingModeEnabled}
                                role="switch"
                                aria-checked={trainingModeEnabled}
                                aria-label="Training mode"
                                on:click={() => updateSetting('training_mode_enabled', trainingModeEnabled ? 'false' : 'true')}
                            ><span>{trainingModeEnabled ? 'On' : 'Off'}</span><span class="settings-switch-track"><span></span></span></button>
                        </div>
                        {#if trainingModeEnabled}
                            <div class="settings-warning">Training is active on this till. Real sales are not being saved.</div>
                        {/if}

                        <div class="settings-operation-row">
                            <span class="settings-operation-icon"><Banknote size={20} /></span>
                            <div><strong>Till cash-up</strong><span>Open and reconcile cashier shifts. Shop-wide.</span></div>
                            <button
                                type="button"
                                class="settings-switch-control"
                                class:enabled={cashUpEnabled}
                                role="switch"
                                aria-checked={cashUpEnabled}
                                aria-label="Till cash-up"
                                on:click={() => setCashUpEnabled(!cashUpEnabled)}
                            ><span>{cashUpEnabled ? 'On' : 'Off'}</span><span class="settings-switch-track"><span></span></span></button>
                        </div>

                        {#if cashUpEnabled}
                            <div class="settings-sub-options">
                                <div><span><strong>Opening float</strong><small>Ask for starting cash.</small></span>
                                    <button type="button" class="settings-switch-control" class:enabled={openingFloatRequired} role="switch" aria-checked={openingFloatRequired} aria-label="Require opening float" on:click={() => updateSetting('cash_up_require_opening_float', openingFloatRequired ? 'false' : 'true')}><span>{openingFloatRequired ? 'On' : 'Off'}</span><span class="settings-switch-track"><span></span></span></button>
                                </div>
                                <div><span><strong>Card-machine total</strong><small>Reconcile terminal totals.</small></span>
                                    <button type="button" class="settings-switch-control" class:enabled={cardReconciliationEnabled} role="switch" aria-checked={cardReconciliationEnabled} aria-label="Reconcile card-machine total" on:click={() => updateSetting('cash_up_reconcile_card', cardReconciliationEnabled ? 'false' : 'true')}><span>{cardReconciliationEnabled ? 'On' : 'Off'}</span><span class="settings-switch-track"><span></span></span></button>
                                </div>
                            </div>
                        {/if}
                    </div>
                </section>
            </div>
        </div>
    </div>
</MgmtPage>

<style>
    .settings-overview {
        width: 100%;
        max-width: 1540px;
        margin: 0 auto;
        padding: 1rem;
        display: flex;
        flex-direction: column;
        gap: 0.9rem;
        color: var(--text-main);
        font-size: var(--font-size-settings);
    }

    .settings-summary {
        display: grid;
        grid-template-columns: minmax(220px, 1.2fr) repeat(3, minmax(150px, 0.8fr));
        overflow: hidden;
        border: 1px solid var(--border-flat);
        border-radius: 0.5rem;
        background: var(--bg-card);
    }

    .settings-summary-item {
        min-width: 0;
        min-height: 72px;
        padding: 0.7rem 0.8rem;
        display: flex;
        align-items: center;
        gap: 0.65rem;
        border-left: 1px solid var(--border-flat);
    }

    .settings-summary-item:first-child {
        border-left: 0;
    }

    .settings-summary-icon,
    .settings-panel-icon,
    .settings-operation-icon {
        width: 42px;
        height: 42px;
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        justify-content: center;
        border: 1px solid var(--border-flat);
        border-radius: 0.45rem;
        background: var(--bg-panel);
        color: var(--accent-primary);
    }

    .settings-summary-copy {
        min-width: 0;
        display: block;
    }

    .settings-summary-copy small,
    .settings-section-heading span,
    .settings-shortcut-copy small {
        display: block;
        color: var(--text-muted);
        font-size: 0.68em;
        font-weight: 900;
        letter-spacing: 0;
        line-height: 1.1;
        text-transform: uppercase;
    }

    .settings-summary-copy strong {
        display: block;
        margin-top: 0.2rem;
        overflow: hidden;
        font-size: 0.92em;
        line-height: 1.15;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .settings-summary-copy .settings-summary-state {
        display: flex;
        align-items: center;
        gap: 0.42rem;
    }

    .settings-status-dot {
        width: 10px;
        height: 10px;
        margin-left: 0;
        flex: 0 0 auto;
        border-radius: 50%;
        background: var(--warning);
        box-shadow: 0 0 0 4px color-mix(in srgb, var(--warning) 15%, transparent);
    }

    .settings-status-dot.online {
        background: var(--success);
        box-shadow: 0 0 0 4px color-mix(in srgb, var(--success) 15%, transparent);
    }

    .settings-sync-error,
    .settings-warning {
        border: 1px solid color-mix(in srgb, var(--danger) 50%, var(--border-flat));
        border-radius: 0.45rem;
        background: color-mix(in srgb, var(--danger) 10%, var(--bg-card));
        color: var(--danger);
        padding: 0.7rem 0.85rem;
        font-size: 0.82em;
        font-weight: 700;
    }

    .settings-shortcuts-section {
        min-width: 0;
    }

    .settings-section-heading {
        min-height: 46px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        padding: 0 0.15rem 0.45rem;
    }

    .settings-section-heading h2 {
        margin: 0.2rem 0 0;
        color: var(--text-main);
        font-size: 1.16em;
        line-height: 1.1;
        letter-spacing: 0;
    }

    .settings-section-heading > small {
        color: var(--text-muted);
        font-size: 0.76em;
        font-weight: 800;
    }

    .settings-controls-heading {
        min-height: 40px;
        margin-top: 0.15rem;
        padding-bottom: 0;
    }

    .settings-shortcut-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 0.65rem;
    }

    .settings-shortcut {
        --setting-accent: var(--accent-primary);
        position: relative;
        contain: layout paint;
        min-width: 0;
        min-height: 108px;
        overflow: hidden;
        display: grid;
        grid-template-columns: 44px minmax(0, 1fr) 20px;
        align-items: center;
        gap: 0.65rem;
        padding: 0.75rem;
        border: 1px solid var(--border-flat);
        border-radius: 0.5rem;
        background: var(--bg-card);
        color: var(--text-main);
        text-decoration: none;
        transition: none;
    }

    .settings-shortcut:hover {
        border-color: var(--setting-accent);
        background: var(--bg-card-hover);
    }

    .settings-shortcut:focus-visible,
    .settings-switch-control:focus-visible {
        outline: 3px solid var(--accent-primary);
        outline-offset: -3px;
    }

    .settings-shortcut-mark {
        position: absolute;
        inset: 0 auto 0 0;
        width: 4px;
        background: var(--setting-accent);
    }

    .settings-shortcut-icon {
        width: 44px;
        height: 44px;
        display: flex;
        align-items: center;
        justify-content: center;
        border: 1px solid var(--border-flat);
        border-radius: 0.45rem;
        background: var(--bg-panel);
        color: var(--setting-accent);
    }

    .settings-shortcut-copy {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 0.18rem;
    }

    .settings-shortcut-copy small {
        color: var(--setting-accent);
        font-size: 0.64em;
    }

    .settings-shortcut-copy strong {
        min-width: 0;
        overflow: hidden;
        font-size: 0.98em;
        line-height: 1.12;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .settings-shortcut-copy > span {
        display: -webkit-box;
        overflow: hidden;
        color: var(--text-muted);
        font-size: 0.72em;
        font-weight: 650;
        line-height: 1.22;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        line-clamp: 2;
    }

    .settings-shortcut-arrow {
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--setting-accent);
    }

    .settings-shortcut.admin-shortcut {
        border-style: dashed;
    }

    .settings-config-columns {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        align-items: start;
        gap: 0.75rem;
    }

    .settings-config-column {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
    }

    .settings-config-panel {
        min-width: 0;
        padding: 1rem;
        border: 1px solid var(--border-flat);
        border-radius: 0.5rem;
        background: var(--bg-card);
    }

    .settings-panel-header {
        min-width: 0;
        display: grid;
        grid-template-columns: 42px minmax(0, 1fr);
        align-items: center;
        gap: 0.7rem;
        margin-bottom: 0.9rem;
    }

    .settings-panel-header-action {
        grid-template-columns: 42px minmax(0, 1fr) auto;
    }

    .settings-panel-header h3 {
        margin: 0;
        font-size: 1.04em;
        line-height: 1.1;
        letter-spacing: 0;
    }

    .settings-panel-header p {
        margin: 0.2rem 0 0;
        color: var(--text-muted);
        font-size: 0.74em;
        line-height: 1.25;
    }

    .settings-form-grid {
        gap: 0.7rem;
    }

    .settings-till-fields {
        display: grid;
        grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.85fr);
        gap: 0.7rem;
    }

    .settings-inline-field {
        min-width: 0;
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 0.5rem;
    }

    .settings-inline-field .btn {
        min-width: 116px;
        padding-inline: 1rem;
    }

    .settings-readonly-input {
        overflow: hidden;
        color: var(--text-muted) !important;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace !important;
        font-size: 0.72em !important;
        text-overflow: ellipsis;
    }

    .settings-database-panel {
        display: block;
    }

    .settings-database-panel .settings-panel-header {
        margin-bottom: 0;
    }

    .settings-loyalty-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 0.65rem;
        transition: opacity 0.15s;
    }

    .disabled-settings {
        opacity: 0.5;
    }

    .settings-example {
        margin-top: 0.75rem;
        padding-top: 0.65rem;
        border-top: 1px solid var(--border-flat);
        color: var(--text-muted);
        font-size: 0.76em;
        font-weight: 700;
        text-align: right;
    }

    .settings-operation-list {
        overflow: hidden;
        border: 1px solid var(--border-flat);
        border-radius: 0.5rem;
        background: var(--bg-panel);
    }

    .settings-operation-row {
        min-width: 0;
        min-height: 76px;
        display: grid;
        grid-template-columns: 40px minmax(0, 1fr) auto;
        align-items: center;
        gap: 0.65rem;
        padding: 0.65rem 0.75rem;
        border-bottom: 1px solid var(--border-flat);
    }

    .settings-operation-row:last-child {
        border-bottom: 0;
    }

    .settings-operation-icon {
        width: 40px;
        height: 40px;
        color: var(--success);
    }

    .settings-operation-icon.training {
        color: var(--warning);
    }

    .settings-operation-row > div {
        min-width: 0;
    }

    .settings-operation-row strong,
    .settings-sub-options strong {
        display: block;
        font-size: 0.86em;
        line-height: 1.15;
    }

    .settings-operation-row div > span,
    .settings-sub-options small {
        display: block;
        margin-top: 0.18rem;
        color: var(--text-muted);
        font-size: 0.69em;
        line-height: 1.25;
    }

    .settings-switch-control {
        min-width: 94px;
        min-height: 44px;
        padding: 0.35rem 0.4rem 0.35rem 0.65rem;
        display: inline-flex;
        align-items: center;
        justify-content: flex-end;
        gap: 0.5rem;
        border: 1px solid var(--border-flat);
        border-radius: 0.45rem;
        background: var(--bg-card);
        color: var(--text-muted);
        box-shadow: none;
        font-size: 0.72em;
        font-weight: 900;
    }

    .settings-switch-control:hover {
        border-color: var(--accent-primary);
        background: var(--bg-card-hover);
    }

    .settings-switch-track {
        position: relative;
        width: 46px;
        height: 26px;
        flex: 0 0 auto;
        border: 1px solid var(--border-flat);
        border-radius: 999px;
        background: var(--bg-panel);
        transition: background 0.15s;
    }

    .settings-switch-track > span {
        position: absolute;
        top: 2px;
        left: 2px;
        width: 20px;
        height: 20px;
        border-radius: 50%;
        background: var(--text-muted);
        transition: transform 0.15s, background 0.15s;
    }

    .settings-switch-control.enabled {
        color: var(--success);
    }

    .settings-switch-control.enabled .settings-switch-track {
        border-color: var(--success);
        background: var(--success);
    }

    .settings-switch-control.enabled .settings-switch-track > span {
        transform: translateX(20px);
        background: white;
    }

    .settings-switch-control.danger-enabled {
        color: var(--danger);
    }

    .settings-switch-control.danger-enabled .settings-switch-track {
        border-color: var(--danger);
        background: var(--danger);
    }

    .settings-warning {
        margin: 0.6rem 0.75rem;
        color: var(--text-main);
        font-size: 0.72em;
    }

    .settings-sub-options {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 0.5rem;
        padding: 0.65rem;
        border-bottom: 1px solid var(--border-flat);
        background: var(--bg-card);
    }

    .settings-sub-options > div {
        min-width: 0;
        min-height: 64px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.55rem;
        padding: 0.55rem;
        border: 1px solid var(--border-flat);
        border-radius: 0.45rem;
        background: var(--bg-panel);
    }

    @media (max-width: 1180px) {
        .settings-shortcut-grid {
            grid-template-columns: repeat(3, minmax(0, 1fr));
        }

        .settings-summary {
            grid-template-columns: repeat(2, minmax(0, 1fr));
        }

        .settings-summary-item:nth-child(3) {
            border-left: 0;
            border-top: 1px solid var(--border-flat);
        }

        .settings-summary-item:nth-child(4) {
            border-top: 1px solid var(--border-flat);
        }
    }

    @media (max-width: 940px) {
        .settings-config-columns {
            grid-template-columns: 1fr;
        }
    }

    @media (max-width: 760px) {
        .settings-overview {
            padding: 0.75rem;
        }

        .settings-shortcut-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
        }

        .settings-till-fields,
        .settings-loyalty-grid {
            grid-template-columns: 1fr;
        }
    }

    @media (max-width: 540px) {
        .settings-summary,
        .settings-shortcut-grid {
            grid-template-columns: 1fr;
        }

        .settings-summary-item,
        .settings-summary-item:nth-child(2),
        .settings-summary-item:nth-child(3),
        .settings-summary-item:nth-child(4) {
            border-top: 1px solid var(--border-flat);
            border-left: 0;
        }

        .settings-summary-item:first-child {
            border-top: 0;
        }

        .settings-save-button {
            width: 48px;
            padding-inline: 0;
        }

        .settings-save-button span {
            display: none;
        }

        .settings-panel-header-action {
            grid-template-columns: 42px minmax(0, 1fr);
        }

        .settings-panel-header-action .settings-switch-control {
            grid-column: 1 / -1;
            width: 100%;
        }

        .settings-inline-field,
        .settings-sub-options {
            grid-template-columns: 1fr;
        }

        .settings-operation-row {
            grid-template-columns: 40px minmax(0, 1fr);
        }

        .settings-operation-row .settings-switch-control {
            grid-column: 1 / -1;
            width: 100%;
        }
    }
</style>
