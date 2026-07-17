<script lang="ts">
    import { onMount } from 'svelte';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import { connectionState } from '$lib/stores/connection';
    import { currentEmployee } from '$lib/stores/session';
    import { storeDB, settingsDB, type Store, now, formatMoney } from '$lib/stores/db';
    import { upsert, getTillName, setTillName as setTillNameDb, getOrCreateTillId } from '$lib/stores/database';
    import { toast } from '$lib/stores/toast';
    import { appFontOptions, appFontSizeOptions, normalizeAppFontChoice } from '$lib/typography';

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

    onMount(async () => {
        editTillName = await getTillName();
        tillId = await getOrCreateTillId();
    });

    function switchCardClass(active: boolean): string {
        return [
            'relative min-h-[88px] rounded-xl border p-4 pr-16 text-left transition-all duration-150',
            'disabled:cursor-not-allowed disabled:opacity-45',
            active
                ? 'border-success bg-success/10 text-text-main shadow-[0_12px_30px_var(--shadow)]'
                : 'border-border-flat bg-bg-panel text-text-main hover:border-accent-primary hover:bg-bg-card-hover',
        ].join(' ');
    }

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

<MgmtPage title="Settings">
    <button slot="actions" class="btn btn-primary" on:click={saveStore}>Save Store Information</button>

    <div class="settings-page-shell">
        <section class="settings-hero">
            <div class="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                <div>
                    <p class="settings-hero-kicker">Shop control centre</p>
                    <h2 class="settings-hero-title">Make L&amp;Bj POS work your way</h2>
                    <p class="settings-hero-copy">
                        Daily shop behaviour stays here. Hardware, backups, CCTV, and deeper tools now live in their own pages.
                    </p>
                </div>
                <div class="grid gap-3 sm:grid-cols-2 xl:min-w-[430px]">
                    <div class="rounded-xl border border-border-flat bg-bg-panel p-4">
                        <div class="flex items-center gap-3">
                            <span class="h-3 w-3 rounded-full {$connectionState.mysqlOnline ? 'bg-success shadow-[0_0_12px_var(--success)]' : 'bg-warning shadow-[0_0_12px_var(--warning)]'}"></span>
                            <div>
                                <strong class="block text-text-main">{$connectionState.mysqlOnline ? 'Multi-till online' : 'Local mode'}</strong>
                                <small class="text-text-muted">{$connectionState.mode === 'multi' ? ($connectionState.mysqlConfig?.host || 'MariaDB configured') : 'SQLite only'}</small>
                            </div>
                        </div>
                    </div>
                    <div class="rounded-xl border border-border-flat bg-bg-panel p-4">
                        <strong class="block text-text-main">{stockTrackingEnabled ? 'Stock tracking active' : 'Stock tracking off'}</strong>
                        <small class="text-text-muted">Till: {editTillName || 'Loading...'}</small>
                    </div>
                </div>
            </div>
            {#if $connectionState.syncError}
                <p class="mt-4 rounded-xl border border-danger/50 bg-danger/10 p-3 text-sm text-danger">{$connectionState.syncError}</p>
            {/if}
        </section>

        <nav class="settings-card-grid" aria-label="Settings shortcuts">
            <a href="/settings/themes" class="group rounded-2xl border border-border-flat bg-bg-card p-5 text-text-main no-underline transition hover:-translate-y-0.5 hover:border-accent-primary hover:bg-bg-card-hover">
                <span class="text-xs font-black uppercase tracking-[0.16em] text-accent-primary">Appearance</span>
                <b class="mt-2 block text-xl">Colour Theme</b>
                <p class="mt-2 text-sm text-text-muted">Choose the visual style used across the app.</p>
                <strong class="mt-4 block text-sm text-accent-primary">Change theme &rarr;</strong>
            </a>
            <a href="/settings/fonts" class="group rounded-2xl border border-border-flat bg-bg-card p-5 text-text-main no-underline transition hover:-translate-y-0.5 hover:border-accent-primary hover:bg-bg-card-hover">
                <span class="text-xs font-black uppercase tracking-[0.16em] text-accent-primary">Appearance</span>
                <b class="mt-2 block text-xl">Fonts &amp; Text Size</b>
                <p class="mt-2 text-sm text-text-muted">{selectedFontOption.label}. POS {selectedSizeLabel(selectedPosFontSize)}, settings {selectedSizeLabel(selectedSettingsFontSize)}.</p>
                <strong class="mt-4 block text-sm text-accent-primary">Set writing &rarr;</strong>
            </a>
            <a href="/settings/layout" class="group rounded-2xl border border-border-flat bg-bg-card p-5 text-text-main no-underline transition hover:-translate-y-0.5 hover:border-accent-primary hover:bg-bg-card-hover">
                <span class="text-xs font-black uppercase tracking-[0.16em] text-accent-primary">POS screen</span>
                <b class="mt-2 block text-xl">Layout</b>
                <p class="mt-2 text-sm text-text-muted">Tune cart placement, toolbar controls, and the main selling screen.</p>
                <strong class="mt-4 block text-sm text-accent-primary">Open layout &rarr;</strong>
            </a>
            <a href="/settings/printers" class="group rounded-2xl border border-border-flat bg-bg-card p-5 text-text-main no-underline transition hover:-translate-y-0.5 hover:border-success hover:bg-bg-card-hover">
                <span class="text-xs font-black uppercase tracking-[0.16em] text-success">Hardware</span>
                <b class="mt-2 block text-xl">Printer Setup</b>
                <p class="mt-2 text-sm text-text-muted">Receipt printers, label printers, and cash drawer pulse.</p>
                <strong class="mt-4 block text-sm text-success">Set printers &rarr;</strong>
            </a>
            <a href="/settings/scale" class="group rounded-2xl border border-border-flat bg-bg-card p-5 text-text-main no-underline transition hover:-translate-y-0.5 hover:border-success hover:bg-bg-card-hover">
                <span class="text-xs font-black uppercase tracking-[0.16em] text-success">Hardware</span>
                <b class="mt-2 block text-xl">Scale Setup</b>
                <p class="mt-2 text-sm text-text-muted">Find the scale port and connect the live weighing scale.</p>
                <strong class="mt-4 block text-sm text-success">Connect scale &rarr;</strong>
            </a>
            <a href="/settings/receipt" class="group rounded-2xl border border-border-flat bg-bg-card p-5 text-text-main no-underline transition hover:-translate-y-0.5 hover:border-warning hover:bg-bg-card-hover">
                <span class="text-xs font-black uppercase tracking-[0.16em] text-warning">Printing</span>
                <b class="mt-2 block text-xl">Receipt Designer</b>
                <p class="mt-2 text-sm text-text-muted">Control receipt size, content, and footer messages.</p>
                <strong class="mt-4 block text-sm text-warning">Design receipt &rarr;</strong>
            </a>
            <a href="/settings/labels" class="group rounded-2xl border border-border-flat bg-bg-card p-5 text-text-main no-underline transition hover:-translate-y-0.5 hover:border-warning hover:bg-bg-card-hover">
                <span class="text-xs font-black uppercase tracking-[0.16em] text-warning">Labels</span>
                <b class="mt-2 block text-xl">Label Designer</b>
                <p class="mt-2 text-sm text-text-muted">Create shelf labels and barcode label layouts.</p>
                <strong class="mt-4 block text-sm text-warning">Design labels &rarr;</strong>
            </a>
            <a href="/settings/barcodes" class="group rounded-2xl border border-border-flat bg-bg-card p-5 text-text-main no-underline transition hover:-translate-y-0.5 hover:border-success hover:bg-bg-card-hover">
                <span class="text-xs font-black uppercase tracking-[0.16em] text-success">Scales</span>
                <b class="mt-2 block text-xl">Scale Barcode Rules</b>
                <p class="mt-2 text-sm text-text-muted">Show the POS how your scale builds embedded-price barcodes.</p>
                <strong class="mt-4 block text-sm text-success">Configure rules &rarr;</strong>
            </a>
            <a href="/settings/customer-display" class="group rounded-2xl border border-border-flat bg-bg-card p-5 text-text-main no-underline transition hover:-translate-y-0.5 hover:border-accent-primary hover:bg-bg-card-hover">
                <span class="text-xs font-black uppercase tracking-[0.16em] text-accent-primary">Checkout</span>
                <b class="mt-2 block text-xl">Customer Screen</b>
                <p class="mt-2 text-sm text-text-muted">Open the live basket and total on a second monitor.</p>
                <strong class="mt-4 block text-sm text-accent-primary">Configure display &rarr;</strong>
            </a>
            <a href="/settings/payments" class="group rounded-2xl border border-border-flat bg-bg-card p-5 text-text-main no-underline transition hover:-translate-y-0.5 hover:border-success hover:bg-bg-card-hover">
                <span class="text-xs font-black uppercase tracking-[0.16em] text-success">Checkout</span>
                <b class="mt-2 block text-xl">Card Payments</b>
                <p class="mt-2 text-sm text-text-muted">Connect and manage card terminal providers separately for this till.</p>
                <strong class="mt-4 block text-sm text-success">Choose provider &rarr;</strong>
            </a>
            <a href="/settings/feedback" class="group rounded-2xl border border-border-flat bg-bg-card p-5 text-text-main no-underline transition hover:-translate-y-0.5 hover:border-accent-primary hover:bg-bg-card-hover">
                <span class="text-xs font-black uppercase tracking-[0.16em] text-accent-primary">Operator feedback</span>
                <b class="mt-2 block text-xl">Sound &amp; Haptics</b>
                <p class="mt-2 text-sm text-text-muted">Button clicks, item sounds, vibration, and barcode alerts.</p>
                <strong class="mt-4 block text-sm text-accent-primary">Open feedback &rarr;</strong>
            </a>
            <a href="/settings/integrations" class="group rounded-2xl border border-border-flat bg-bg-card p-5 text-text-main no-underline transition hover:-translate-y-0.5 hover:border-success hover:bg-bg-card-hover">
                <span class="text-xs font-black uppercase tracking-[0.16em] text-success">Integrations</span>
                <b class="mt-2 block text-xl">CCTV POS Overlay</b>
                <p class="mt-2 text-sm text-text-muted">Send product and receipt text to supported DVR/NVR systems.</p>
                <strong class="mt-4 block text-sm text-success">Open integrations &rarr;</strong>
            </a>
            {#if $currentEmployee?.role === 'admin'}
                <a href="/settings/advanced" class="group rounded-2xl border border-danger/60 bg-danger/10 p-5 text-text-main no-underline transition hover:-translate-y-0.5 hover:border-danger hover:bg-danger/15">
                    <span class="text-xs font-black uppercase tracking-[0.16em] text-danger">Admin only</span>
                    <b class="mt-2 block text-xl">Advanced Maintenance</b>
                    <p class="mt-2 text-sm text-text-muted">Backups, database repair, migration, restore, and risky shop controls.</p>
                    <strong class="mt-4 block text-sm text-danger">Open carefully &rarr;</strong>
                </a>
            {/if}
        </nav>

        <section class="settings-section">
            <h3 class="settings-section-title">Store Information</h3>
            <div class="form-grid">
                <div class="field span-2"><label>Store Name</label><input bind:value={store.name} /></div>
                <div class="field span-2"><label>Address</label><input bind:value={store.address} /></div>
                <div class="field"><label>Phone</label><input bind:value={store.phone} /></div>
                <div class="field"><label>Email</label><input type="email" bind:value={store.email} /></div>
            </div>
        </section>

        <section class="settings-section">
            <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div>
                    <h3 class="settings-section-title">Loyalty Program</h3>
                    <p class="mb-4 text-sm text-text-muted">Choose how customers earn points and how those points become spendable credit.</p>
                </div>
                <button class="btn {loyaltyEnabled ? 'btn-success' : 'btn-secondary'}" on:click={() => updateSetting('loyalty_enabled', loyaltyEnabled ? 'false' : 'true')}>
                    Loyalty: {loyaltyEnabled ? 'Enabled' : 'Disabled'}
                </button>
            </div>
            <div class="form-grid">
                <div class="field"><label for="loyalty-points-per-pound">Points per £1 spent</label>
                    <input id="loyalty-points-per-pound" type="number" inputmode="numeric" min="0" step="1" value={loyaltyPointsPerPound} on:change={(e) => updateLoyaltyNumber('loyalty_points_per_pound', e.currentTarget.value, 0, 1)} />
                </div>
                <div class="field"><label for="loyalty-points-required">Points required for credit</label>
                    <input id="loyalty-points-required" type="number" inputmode="numeric" min="1" step="1" value={loyaltyPointsRequired} on:change={(e) => updateLoyaltyNumber('loyalty_points_to_redeem', e.currentTarget.value, 1, 100)} />
                </div>
                <div class="field"><label for="loyalty-credit-value">Credit value (pence)</label>
                    <input id="loyalty-credit-value" type="number" inputmode="numeric" min="1" step="1" value={loyaltyCreditValue} on:change={(e) => updateLoyaltyNumber('loyalty_redemption_value', e.currentTarget.value, 1, 100)} />
                </div>
                <div class="field justify-end">
                    <div class="rounded-xl border border-border-flat bg-bg-panel p-3 text-sm text-text-muted">
                        Example: {loyaltyPointsRequired.toLocaleString()} points = {formatMoney(loyaltyCreditValue)} credit
                    </div>
                </div>
            </div>
        </section>

        <section class="settings-section">
            <h3 class="settings-section-title">Stock Tracking</h3>
            <p class="mb-4 text-sm text-text-muted">
                This shop-wide setting synchronizes to every till. Turning it off hides stock controls and stops sales and refunds from changing stock quantities.
            </p>
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <button class={switchCardClass(stockTrackingEnabled)} on:click={() => setStockTracking(true)}>
                    <span class="font-extrabold">Track product stock</span>
                    <small class="mt-1 block text-text-muted">Use stock levels and update them after transactions.</small>
                    <b class="absolute right-4 top-1/2 -translate-y-1/2 text-xs uppercase tracking-[0.12em] {stockTrackingEnabled ? 'text-success' : 'text-text-muted'}">{stockTrackingEnabled ? 'On' : 'Off'}</b>
                </button>
                <button class={switchCardClass(!stockTrackingEnabled)} on:click={() => setStockTracking(false)}>
                    <span class="font-extrabold">Do not track stock</span>
                    <small class="mt-1 block text-text-muted">Disable stock tracking everywhere without deleting saved levels.</small>
                    <b class="absolute right-4 top-1/2 -translate-y-1/2 text-xs uppercase tracking-[0.12em] {!stockTrackingEnabled ? 'text-success' : 'text-text-muted'}">{!stockTrackingEnabled ? 'On' : 'Off'}</b>
                </button>
            </div>
        </section>

        <section class="settings-section">
            <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div>
                    <h3 class="settings-section-title">Training Mode</h3>
                    <p class="mb-4 text-sm text-text-muted">Use this till for practice without saving sales, changing stock, loyalty points, reports, or CCTV/receipt output.</p>
                </div>
                <button class="btn {trainingModeEnabled ? 'btn-danger' : 'btn-secondary'}" on:click={() => updateSetting('training_mode_enabled', trainingModeEnabled ? 'false' : 'true')}>
                    Training: {trainingModeEnabled ? 'On' : 'Off'}
                </button>
            </div>
            <div class="rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm text-text-main">
                This setting is saved only on this machine. It is useful for staff practice, but it should stay off during real trading.
            </div>
        </section>

        <section class="settings-section">
            <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div>
                    <h3 class="settings-section-title">Till Cash-Up</h3>
                    <p class="mb-4 text-sm text-text-muted">Optionally require each cashier to open and reconcile their shift on each till.</p>
                </div>
                <button class="btn {cashUpEnabled ? 'btn-success' : 'btn-secondary'}" on:click={() => setCashUpEnabled(!cashUpEnabled)}>
                    Cash-Up: {cashUpEnabled ? 'Enabled' : 'Disabled'}
                </button>
            </div>
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <button class={switchCardClass(openingFloatRequired)} disabled={!cashUpEnabled} on:click={() => updateSetting('cash_up_require_opening_float', openingFloatRequired ? 'false' : 'true')}>
                    <span class="font-extrabold">Opening float</span>
                    <small class="mt-1 block text-text-muted">Ask how much cash is in the drawer when opening a new shift.</small>
                    <b class="absolute right-4 top-1/2 -translate-y-1/2 text-xs uppercase tracking-[0.12em] {openingFloatRequired ? 'text-success' : 'text-text-muted'}">{openingFloatRequired ? 'On' : 'Off'}</b>
                </button>
                <button class={switchCardClass(cardReconciliationEnabled)} disabled={!cashUpEnabled} on:click={() => updateSetting('cash_up_reconcile_card', cardReconciliationEnabled ? 'false' : 'true')}>
                    <span class="font-extrabold">Card-machine total</span>
                    <small class="mt-1 block text-text-muted">Ask for the card terminal total and show any difference when closing.</small>
                    <b class="absolute right-4 top-1/2 -translate-y-1/2 text-xs uppercase tracking-[0.12em] {cardReconciliationEnabled ? 'text-success' : 'text-text-muted'}">{cardReconciliationEnabled ? 'On' : 'Off'}</b>
                </button>
            </div>
            <p class="mt-3 text-sm text-text-muted">This is a shop-wide setting and synchronizes to every till.</p>
        </section>

        <section class="settings-section">
            <h3 class="settings-section-title">Till Configuration</h3>
            <p class="mb-4 text-sm text-text-muted">Each machine auto-generates a unique identity. Set a display name below.</p>
            <div class="form-grid">
                <div class="field">
                    <label>Till Display Name</label>
                    <div class="flex gap-3">
                        <input bind:value={editTillName} placeholder="e.g. Till 1" />
                        <button class="btn btn-primary" on:click={saveTillName}>Save</button>
                    </div>
                </div>
                <div class="field">
                    <label>Till ID (auto-generated)</label>
                    <input value={tillId} disabled class="!opacity-60" />
                </div>
            </div>
        </section>

        <section class="settings-section">
            <div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                    <h3 class="settings-section-title">Database Status</h3>
                    <p class="mb-0 text-sm text-text-muted">
                        {$connectionState.mysqlOnline ? 'Connected to the central MariaDB server.' : 'Working from the local SQLite database.'}
                    </p>
                </div>
                {#if $currentEmployee?.role === 'admin'}
                    <a href="/settings/advanced" class="btn btn-secondary">Advanced Maintenance</a>
                {/if}
            </div>
        </section>
    </div>
</MgmtPage>
