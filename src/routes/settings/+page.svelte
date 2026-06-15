<script lang="ts">
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import { storeDB, settingsDB, type Store, now } from '$lib/stores/db';
    import { toast } from '$lib/stores/toast';
    import {
        upsert, getTillName, setTillName as setTillNameDb, getOrCreateTillId,
        createLocalBackup
    } from '$lib/stores/database';
    import { connectionState } from '$lib/stores/connection';
    import { currentEmployee } from '$lib/stores/session';
    import { playCartButtonFeedback, playErrorSound, playItemAddedSound, playSuccessSound } from '$lib/sounds';
    import { getCctvPosConfig, sendCctvPosText } from '$lib/cctvPos';
    import { getCashDrawerConfig, openCashDrawer } from '$lib/cashDrawer';

    let store = { ...$storeDB };
    $: stockTrackingEnabled = ($settingsDB.find(s => s.key === 'stock_tracking_enabled')?.value ?? 'true') !== 'false';
    $: buttonSoundEnabled = ($settingsDB.find(s => s.key === 'feedback_button_sound_enabled')?.value ?? 'true') !== 'false';
    $: itemSoundEnabled = ($settingsDB.find(s => s.key === 'feedback_item_sound_enabled')?.value ?? 'true') !== 'false';
    $: hapticsEnabled = ($settingsDB.find(s => s.key === 'feedback_haptics_enabled')?.value ?? 'true') !== 'false';
    $: saleSoundEnabled = ($settingsDB.find(s => s.key === 'feedback_sale_sound_enabled')?.value ?? 'true') !== 'false';
    $: barcodeErrorSound = $settingsDB.find(s => s.key === 'barcode_error_sound')?.value || 'vintage';
    $: loyaltyEnabled = ($settingsDB.find(s => s.key === 'loyalty_enabled')?.value ?? 'true') !== 'false';
    $: cashUpEnabled = ($settingsDB.find(s => s.key === 'cash_up_enabled')?.value ?? 'false') === 'true';
    $: openingFloatRequired = ($settingsDB.find(s => s.key === 'cash_up_require_opening_float')?.value ?? 'true') !== 'false';
    $: cardReconciliationEnabled = ($settingsDB.find(s => s.key === 'cash_up_reconcile_card')?.value ?? 'true') !== 'false';
    $: cctvConfig = getCctvPosConfig($settingsDB);
    $: cashDrawerConfig = getCashDrawerConfig($settingsDB);

    function setStockTracking(enabled: boolean) {
        updateSetting('stock_tracking_enabled', enabled ? 'true' : 'false');
        toast(enabled ? 'Stock tracking enabled' : 'Stock tracking disabled across the shop');
    }

    function setCashUpEnabled(enabled: boolean) {
        updateSetting('cash_up_enabled', enabled ? 'true' : 'false');
        if (enabled) updateSetting('cash_up_activation_time', now());
        toast(enabled ? 'Till cash-up enabled across the shop' : 'Till cash-up disabled across the shop');
    }

    function setFeedbackSetting(key: string, enabled: boolean) {
        updateSetting(key, enabled ? 'true' : 'false');
    }

    function selectBarcodeErrorSound(style: string) {
        updateSetting('barcode_error_sound', style);
        if (style !== 'silent') setTimeout(playErrorSound, 0);
    }

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

    let editTillName = '';
    let tillId = '';
    let backupStatus = '';
    let cctvTestStatus = '';
    let drawerTestStatus = '';

    import { onMount } from 'svelte';
    onMount(async () => {
        editTillName = await getTillName();
        tillId = await getOrCreateTillId();
    });

    async function saveTillName() {
        await setTillNameDb(editTillName);
        toast('Till name saved');
    }

    async function handleBackup() {
        try {
            backupStatus = 'Creating backup...';
            backupStatus = `Backup saved: ${await createLocalBackup()}`;
        } catch (e) {
            backupStatus = `Backup failed: ${e}`;
        }
    }

    async function testCctvPosOverlay() {
        const config = getCctvPosConfig($settingsDB);
        if (!config.host.trim()) {
            toast('Enter the DVR/NVR IP address first', 'error');
            return;
        }
        if (!config.enabled) {
            toast('Turn CCTV Overlay on before testing automatic sends', 'error');
            return;
        }
        cctvTestStatus = 'Sending test text...';
        try {
            await sendCctvPosText([
                config.posName || 'L&Bj POS',
                `POS ${config.posNumber || '1'} TEST`,
                'Item: TEST PRODUCT  1.00',
                'Total: 1.00',
            ].join('\r\n'), config);
            cctvTestStatus = 'Test sent. Check the linked camera live view.';
            toast('CCTV POS test sent');
        } catch (error) {
            cctvTestStatus = `Test failed: ${error}`;
            toast(`CCTV POS test failed: ${error}`, 'error');
        }
    }

    async function testCashDrawer() {
        const config = getCashDrawerConfig($settingsDB);
        if (!config.host.trim()) {
            toast('Enter the receipt printer IP address first', 'error');
            return;
        }
        if (!config.enabled) {
            toast('Turn Cash Drawer on before testing', 'error');
            return;
        }
        drawerTestStatus = 'Opening drawer...';
        try {
            await openCashDrawer(config);
            drawerTestStatus = 'Drawer pulse sent.';
            toast('Drawer opened');
        } catch (error) {
            drawerTestStatus = `Drawer failed: ${error}`;
            toast(`Drawer failed: ${error}`, 'error');
        }
    }

</script>

<MgmtPage title="Settings">
    <button slot="actions" class="btn btn-primary" on:click={saveStore}>Save Store Information</button>

    <div class="settings-canvas">
        <section class="settings-hero">
            <div>
                <span>Shop control centre</span>
                <h2>Make L&amp;Bj POS work your way</h2>
                <p>Design the till, control shop-wide behaviour, and keep every device connected.</p>
            </div>
            <div class="hero-status {$connectionState.mysqlOnline ? 'online' : ''}">
                <i></i>
                <div><strong>{$connectionState.mysqlOnline ? 'Multi-till online' : 'Local mode'}</strong><small>{stockTrackingEnabled ? 'Stock tracking active' : 'Stock tracking off'}</small></div>
            </div>
        </section>

        <nav class="settings-tile-grid" aria-label="Settings shortcuts">
            <a href="/settings/themes" class="settings-tile tile-purple">
                <span>Appearance</span><b>Colour Theme</b><p>Choose the visual style used across the app.</p><strong>Change theme &rarr;</strong>
            </a>
            <a href="/settings/receipt" class="settings-tile tile-amber">
                <span>Printing</span><b>Receipt Designer</b><p>Control receipt size, content, and messages.</p><strong>Design receipt &rarr;</strong>
            </a>
            <a href="/settings/customer-display" class="settings-tile tile-purple">
                <span>Checkout</span><b>Customer Screen</b><p>Open the live basket and total on a second monitor.</p><strong>Configure display &rarr;</strong>
            </a>
            <a href="/settings/barcodes" class="settings-tile tile-green">
                <span>Scales</span><b>Scale Barcode Rules</b><p>Show the POS how your scale builds its barcodes.</p><strong>Configure rules &rarr;</strong>
            </a>
            {#if $currentEmployee?.role === 'admin'}
                <a href="/settings/advanced" class="settings-tile tile-red">
                    <span>Admin only</span><b>Advanced Maintenance</b><p>Database repair, migration, restore, and risky shop controls.</p><strong>Open carefully &rarr;</strong>
                </a>
            {/if}
        </nav>

        <!-- Store Info -->
        <section class="settings-section">
            <h3 class="settings-section-title">Store Information</h3>
            <div class="form-grid">
                <div class="field span-2"><label>Store Name</label><input bind:value={store.name} /></div>
                <div class="field span-2"><label>Address</label><input bind:value={store.address} /></div>
                <div class="field"><label>Phone</label><input bind:value={store.phone} /></div>
                <div class="field"><label>Email</label><input type="email" bind:value={store.email} /></div>
            </div>
        </section>

        <!-- Loyalty -->
        <section class="settings-section">
            <h3 class="settings-section-title">Loyalty Program</h3>
            <p class="text-text-muted text-[0.9rem] mb-4">Choose how customers earn points and how those points become spendable credit.</p>
            <div class="form-grid">
                <div class="field span-2">
                    <button class="btn {loyaltyEnabled ? 'btn-success' : 'btn-secondary'}" on:click={() => updateSetting('loyalty_enabled', loyaltyEnabled ? 'false' : 'true')}>
                        Loyalty Program: {loyaltyEnabled ? 'Enabled' : 'Disabled'}
                    </button>
                </div>
                <div class="field"><label>Points per £1 spent</label>
                    <input type="number" min="0" step="1" value={getSettingValue('loyalty_points_per_pound') || '1'} on:change={(e) => updateSetting('loyalty_points_per_pound', e.currentTarget.value)} />
                </div>
                <div class="field"><label>Points required for credit</label>
                    <input type="number" min="1" step="1" value={getSettingValue('loyalty_points_to_redeem') || '100'} on:change={(e) => updateSetting('loyalty_points_to_redeem', e.currentTarget.value)} />
                </div>
                <div class="field"><label>Credit value (pence)</label>
                    <input type="number" min="1" step="1" value={getSettingValue('loyalty_redemption_value') || '100'} on:change={(e) => updateSetting('loyalty_redemption_value', e.currentTarget.value)} />
                </div>
                <div class="field justify-end">
                    <div class="flat-card p-3 text-text-muted">
                        Example: {getSettingValue('loyalty_points_to_redeem') || '100'} points = {Number(getSettingValue('loyalty_redemption_value') || '100') / 100} GBP credit
                    </div>
                </div>
            </div>
        </section>

        <section class="settings-section">
            <h3 class="settings-section-title">Stock Tracking</h3>
            <p class="text-text-muted text-[0.9rem] mb-4">
                This shop-wide setting synchronizes to every till. Turning it off hides stock controls and stops sales and refunds from changing stock quantities.
            </p>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-2xl">
                <button
                    class="p-4 rounded-md border-2 text-left transition-colors {stockTrackingEnabled ? 'border-accent-primary bg-accent-primary/10' : 'border-border-flat bg-bg-panel'}"
                    on:click={() => setStockTracking(true)}
                >
                    <strong class="block">Track product stock</strong>
                    <span class="text-xs text-text-muted">Use stock levels and update them after transactions.</span>
                </button>
                <button
                    class="p-4 rounded-md border-2 text-left transition-colors {!stockTrackingEnabled ? 'border-accent-primary bg-accent-primary/10' : 'border-border-flat bg-bg-panel'}"
                    on:click={() => setStockTracking(false)}
                >
                    <strong class="block">Do not track stock</strong>
                    <span class="text-xs text-text-muted">Disable stock tracking everywhere without deleting saved levels.</span>
                </button>
            </div>
        </section>

        <section class="settings-section">
            <div class="section-topline">
                <div>
                    <h3 class="settings-section-title">Till Cash-Up</h3>
                    <p>Optionally require each cashier to open and reconcile their shift on each till.</p>
                </div>
                <button
                    class="btn {cashUpEnabled ? 'btn-success' : 'btn-secondary'}"
                    on:click={() => setCashUpEnabled(!cashUpEnabled)}
                >
                    Cash-Up: {cashUpEnabled ? 'Enabled' : 'Disabled'}
                </button>
            </div>
            <div class="feedback-switches">
                <button
                    class:active={openingFloatRequired}
                    disabled={!cashUpEnabled}
                    on:click={() => updateSetting('cash_up_require_opening_float', openingFloatRequired ? 'false' : 'true')}
                >
                    <span>Opening float</span>
                    <small>Ask the cashier how much cash is in the drawer when opening a new shift.</small>
                    <b>{openingFloatRequired ? 'On' : 'Off'}</b>
                </button>
                <button
                    class:active={cardReconciliationEnabled}
                    disabled={!cashUpEnabled}
                    on:click={() => updateSetting('cash_up_reconcile_card', cardReconciliationEnabled ? 'false' : 'true')}
                >
                    <span>Card-machine total</span>
                    <small>Ask for the card terminal total and show any difference when closing.</small>
                    <b>{cardReconciliationEnabled ? 'On' : 'Off'}</b>
                </button>
            </div>
            <p class="text-text-muted text-[0.82rem] mt-3">
                This is a shop-wide setting and synchronizes to every till. Each shift remains tied to its cashier and unique till ID.
            </p>
        </section>

        <section class="settings-section feedback-section">
            <div class="section-topline">
                <div>
                    <h3 class="settings-section-title">Sound &amp; Haptics</h3>
                    <p>Control operator feedback across every till. Changes apply immediately.</p>
                </div>
                <button class="btn btn-secondary" on:click={playCartButtonFeedback}>Test Button Click</button>
            </div>

            <div class="feedback-switches">
                <button class:active={buttonSoundEnabled} on:click={() => setFeedbackSetting('feedback_button_sound_enabled', !buttonSoundEnabled)}>
                    <span>Button click sound</span><small>Short click on enabled buttons and links.</small><b>{buttonSoundEnabled ? 'On' : 'Off'}</b>
                </button>
                <button class:active={itemSoundEnabled} on:click={() => setFeedbackSetting('feedback_item_sound_enabled', !itemSoundEnabled)}>
                    <span>Item-added sound</span><small>Fast confirmation after adding an item.</small><b>{itemSoundEnabled ? 'On' : 'Off'}</b>
                </button>
                <button class:active={hapticsEnabled} on:click={() => setFeedbackSetting('feedback_haptics_enabled', !hapticsEnabled)}>
                    <span>Haptic vibration</span><small>Vibration on supported phones and tablets.</small><b>{hapticsEnabled ? 'On' : 'Off'}</b>
                </button>
                <button class:active={saleSoundEnabled} on:click={() => setFeedbackSetting('feedback_sale_sound_enabled', !saleSoundEnabled)}>
                    <span>Sale-completed sound</span><small>Confirmation chime when payment finishes.</small><b>{saleSoundEnabled ? 'On' : 'Off'}</b>
                </button>
            </div>

            <div class="barcode-alerts">
                <div>
                    <span>Failed barcode alert</span>
                    <small>Choose the sound that gets the operator’s attention.</small>
                </div>
                <div class="alert-options">
                    {#each [
                        { id: 'vintage', name: 'Vintage Ring', detail: 'Mechanical telephone bell' },
                        { id: 'busy', name: 'Busy Line', detail: 'Three telephone pulses' },
                        { id: 'beep', name: 'Warning Beep', detail: 'Short two-tone warning' },
                        { id: 'silent', name: 'Silent', detail: 'Visual warning only' },
                    ] as option}
                        <button class:active={barcodeErrorSound === option.id} on:click={() => selectBarcodeErrorSound(option.id)}>
                            <strong>{option.name}</strong><small>{option.detail}</small>
                        </button>
                    {/each}
                </div>
                <div class="feedback-tests">
                    <button class="btn btn-secondary" on:click={playItemAddedSound}>Test Item Added</button>
                    <button class="btn btn-secondary" on:click={playSuccessSound}>Test Sale Complete</button>
                    <button class="btn btn-secondary" on:click={playErrorSound} disabled={barcodeErrorSound === 'silent'}>Test Barcode Alert</button>
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
                    <label>Till ID (auto-generated)</label>
                    <input value={tillId} disabled class="!opacity-60" />
                </div>
            </div>
        </section>

        <section class="settings-section">
            <div class="section-topline">
                <div>
                    <h3 class="settings-section-title">Cash Drawer</h3>
                    <p>Open the drawer through the receipt/thermal printer cash-drawer port.</p>
                </div>
                <button
                    class="btn {cashDrawerConfig.enabled ? 'btn-success' : 'btn-secondary'}"
                    on:click={() => updateSetting('cash_drawer_enabled', cashDrawerConfig.enabled ? 'false' : 'true')}
                >
                    Drawer: {cashDrawerConfig.enabled ? 'Enabled' : 'Disabled'}
                </button>
            </div>
            <p class="text-text-muted text-[0.9rem] mb-4">
                Most cash drawers plug into the receipt printer with an RJ11/RJ12 cable. The POS sends the standard ESC/POS pulse to the printer, and the printer kicks the drawer open.
            </p>
            <div class="form-grid">
                <div class="field">
                    <label>Receipt Printer IP Address</label>
                    <input
                        value={cashDrawerConfig.host}
                        placeholder="e.g. 192.168.1.50"
                        on:change={(e) => updateSetting('cash_drawer_printer_host', e.currentTarget.value.trim())}
                    />
                </div>
                <div class="field">
                    <label>Printer Port</label>
                    <input
                        type="number"
                        min="1"
                        max="65535"
                        value={cashDrawerConfig.port}
                        on:change={(e) => updateSetting('cash_drawer_printer_port', e.currentTarget.value || '9100')}
                    />
                    <small class="text-text-muted">Network thermal printers normally use port 9100.</small>
                </div>
                <div class="field">
                    <label>Drawer Pin</label>
                    <select
                        value={cashDrawerConfig.pin}
                        on:change={(e) => updateSetting('cash_drawer_pin', e.currentTarget.value)}
                    >
                        <option value="0">Pin 2 / drawer 1</option>
                        <option value="1">Pin 5 / drawer 2</option>
                    </select>
                </div>
                <div class="field">
                    <label>Pulse Timing</label>
                    <div class="grid grid-cols-2 gap-2">
                        <input
                            type="number"
                            min="2"
                            max="510"
                            value={cashDrawerConfig.pulseOnMs}
                            on:change={(e) => updateSetting('cash_drawer_pulse_on_ms', e.currentTarget.value || '50')}
                            title="Pulse on milliseconds"
                        />
                        <input
                            type="number"
                            min="2"
                            max="510"
                            value={cashDrawerConfig.pulseOffMs}
                            on:change={(e) => updateSetting('cash_drawer_pulse_off_ms', e.currentTarget.value || '250')}
                            title="Pulse off milliseconds"
                        />
                    </div>
                    <small class="text-text-muted">50 / 250 works for most Epson-compatible printers.</small>
                </div>
            </div>
            <div class="flex flex-wrap gap-3 items-center mt-4">
                <button class="btn btn-secondary" on:click={testCashDrawer}>Test Drawer</button>
                <span class="text-sm text-text-muted">{drawerTestStatus}</span>
            </div>
        </section>

        <section class="settings-section">
            <div class="section-topline">
                <div>
                    <h3 class="settings-section-title">CCTV POS Overlay</h3>
                    <p>Send transaction text to a Hikvision DVR/NVR POS input. These settings are saved on this till only.</p>
                </div>
                <button
                    class="btn {cctvConfig.enabled ? 'btn-success' : 'btn-secondary'}"
                    on:click={() => updateSetting('cctv_pos_enabled', cctvConfig.enabled ? 'false' : 'true')}
                >
                    CCTV Overlay: {cctvConfig.enabled ? 'Enabled' : 'Disabled'}
                </button>
            </div>
            <div class="form-grid">
                <div class="field">
                    <label>DVR / NVR IP Address</label>
                    <input
                        value={cctvConfig.host}
                        placeholder="e.g. 192.168.1.104"
                        on:change={(e) => updateSetting('cctv_pos_host', e.currentTarget.value.trim())}
                    />
                </div>
                <div class="field">
                    <label>DVR / NVR POS Port</label>
                    <input
                        type="number"
                        min="1"
                        max="65535"
                        value={cctvConfig.port}
                        on:change={(e) => updateSetting('cctv_pos_port', e.currentTarget.value || '10010')}
                    />
                </div>
                <div class="field">
                    <label>POS Number on DVR</label>
                    <input
                        value={cctvConfig.posNumber}
                        placeholder="e.g. 1"
                        on:change={(e) => updateSetting('cctv_pos_number', e.currentTarget.value.trim() || '1')}
                    />
                </div>
                <div class="field">
                    <label>POS Name Sent to CCTV</label>
                    <input
                        value={cctvConfig.posName}
                        placeholder="e.g. POS 1 / Till 1"
                        on:change={(e) => updateSetting('cctv_pos_name', e.currentTarget.value.trim() || 'POS 1')}
                    />
                </div>
                <div class="field">
                    <label>This Till IP Address</label>
                    <input
                        value={cctvConfig.sourceIp}
                        placeholder="e.g. 192.168.1.186"
                        on:change={(e) => updateSetting('cctv_pos_source_ip', e.currentTarget.value.trim())}
                    />
                    <small class="text-text-muted">Put this same IP in the DVR “Allowed Remote IP” field.</small>
                </div>
                <div class="field">
                    <label>Character Encoding</label>
                    <select
                        value={cctvConfig.encoding}
                        on:change={(e) => updateSetting('cctv_pos_encoding', e.currentTarget.value)}
                    >
                        <option value="latin1">Latin-1 / ISO-8859-1</option>
                        <option value="utf8">UTF-8</option>
                    </select>
                </div>
            </div>
            <div class="feedback-switches mt-4">
                <button class:active={cctvConfig.sendItems} on:click={() => updateSetting('cctv_pos_send_items', cctvConfig.sendItems ? 'false' : 'true')}>
                    <span>Send item scans</span><small>Show each item as it is added to the cart.</small><b>{cctvConfig.sendItems ? 'On' : 'Off'}</b>
                </button>
                <button class:active={cctvConfig.sendReceipts} on:click={() => updateSetting('cctv_pos_send_receipts', cctvConfig.sendReceipts ? 'false' : 'true')}>
                    <span>Send final receipt</span><small>Show the sale total after payment is completed.</small><b>{cctvConfig.sendReceipts ? 'On' : 'Off'}</b>
                </button>
            </div>
            <div class="flex flex-wrap gap-3 items-center mt-4">
                <button class="btn btn-secondary" on:click={testCctvPosOverlay}>Send CCTV Test</button>
                <span class="text-sm text-text-muted">{cctvTestStatus}</span>
            </div>
        </section>

        <!-- Database Connection -->
        <section class="settings-section" id="database">
            <h3 class="settings-section-title">Database Connection</h3>
            <p class="text-text-muted text-[0.9rem] mb-4">Monitor the connection to the central MariaDB server.</p>
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
            </div>
            {#if $currentEmployee?.role === 'admin'}
                <div class="flex justify-end mt-2">
                    <a href="/settings/advanced" class="btn btn-secondary">Advanced Maintenance</a>
                </div>
            {/if}
        </section>

        <section class="settings-section">
            <h3 class="settings-section-title">Create Backup</h3>
            <p class="text-text-muted text-[0.9rem] mb-4">Create a safe local database backup before upgrades or important changes. Restoring is available in Advanced Maintenance.</p>
            <div class="flex flex-wrap gap-3">
                <button class="btn btn-primary" on:click={handleBackup}>Create Backup</button>
            </div>
            {#if backupStatus}<p class="text-sm text-text-muted mt-3 break-all">{backupStatus}</p>{/if}
        </section>
    </div>
</MgmtPage>

<style>
    :global(.settings-canvas .settings-section) {
        border-radius: 1rem;
        background:
            linear-gradient(145deg, color-mix(in srgb, var(--bg-card) 95%, var(--accent-primary) 5%), var(--bg-card));
        box-shadow: 0 14px 38px color-mix(in srgb, var(--shadow) 24%, transparent);
    }
    .settings-canvas { padding: 1.25rem; display: flex; flex-direction: column; gap: 1.25rem; background: radial-gradient(circle at 95% 0%, color-mix(in srgb, var(--accent-primary) 12%, transparent), transparent 26%); }
    .settings-hero { padding: 1.5rem; display: flex; align-items: center; justify-content: space-between; gap: 1rem; border: 1px solid var(--border-flat); border-radius: 1.1rem; background: linear-gradient(120deg, color-mix(in srgb, var(--accent-primary) 20%, var(--bg-panel)), var(--bg-card)); }
    .settings-hero span, .settings-tile span { color: var(--accent-primary); font-size: .68rem; font-weight: 900; letter-spacing: .14em; text-transform: uppercase; }
    .settings-hero h2 { margin: .25rem 0 .35rem; font-size: clamp(1.5rem, 3vw, 2.3rem); }
    .settings-hero p { margin: 0; color: var(--text-muted); }
    .hero-status { min-width: 180px; padding: .8rem 1rem; display: flex; align-items: center; gap: .65rem; border: 1px solid var(--border-flat); border-radius: .8rem; background: color-mix(in srgb, var(--bg-card) 85%, transparent); }
    .hero-status i { width: .7rem; height: .7rem; border-radius: 100%; background: var(--warning); box-shadow: 0 0 12px var(--warning); }
    .hero-status.online i { background: var(--success); box-shadow: 0 0 12px var(--success); }
    .hero-status div { display: flex; flex-direction: column; }
    .hero-status small { color: var(--text-muted); }
    .settings-tile-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); grid-auto-rows: minmax(150px, auto); gap: .8rem; }
    .settings-tile { position: relative; overflow: hidden; padding: 1.15rem; display: flex; flex-direction: column; gap: .35rem; color: var(--text-main); text-decoration: none; border: 1px solid var(--border-flat); border-radius: 1rem; background: var(--bg-card); transition: transform .16s ease, border-color .16s ease; }
    .settings-tile::after { content: ""; position: absolute; width: 120px; height: 120px; right: -45px; top: -48px; border-radius: 100%; background: color-mix(in srgb, var(--tile-accent) 20%, transparent); }
    .settings-tile:hover { transform: translateY(-3px); border-color: var(--tile-accent); }
    .settings-tile b { font-size: 1.2rem; }
    .settings-tile p { margin: 0; max-width: 420px; color: var(--text-muted); font-size: .85rem; }
    .settings-tile strong { margin-top: auto; color: var(--tile-accent); font-size: .8rem; }
    .settings-tile span { color: var(--tile-accent); }
    .tile-large { grid-column: span 2; grid-row: span 2; min-height: 250px; }
    .tile-large b { font-size: 1.7rem; }
    .tile-wide { grid-column: span 2; }
    .tile-blue { --tile-accent: var(--accent-primary); }
    .tile-purple { --tile-accent: #a78bfa; }
    .tile-amber { --tile-accent: var(--warning); }
    .tile-green { --tile-accent: var(--success); }
    .tile-red { --tile-accent: var(--danger); }
    .section-topline { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
    .section-topline p { margin: -.6rem 0 1rem; color: var(--text-muted); font-size: .85rem; }
    .feedback-switches { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .7rem; }
    .feedback-switches button { position: relative; padding: 1rem 4rem 1rem 1rem; display: flex; flex-direction: column; gap: .2rem; text-align: left; color: var(--text-main); border: 1px solid var(--border-flat); border-radius: .75rem; background: var(--bg-panel); }
    .feedback-switches button.active { border-color: var(--success); background: color-mix(in srgb, var(--success) 9%, var(--bg-panel)); }
    .feedback-switches span { font-weight: 800; }
    .feedback-switches small, .barcode-alerts small { color: var(--text-muted); }
    .feedback-switches b { position: absolute; right: 1rem; top: 50%; transform: translateY(-50%); color: var(--text-muted); }
    .feedback-switches button.active b { color: var(--success); }
    .barcode-alerts { margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--border-flat); }
    .barcode-alerts > div:first-child { display: flex; flex-direction: column; gap: .15rem; }
    .barcode-alerts > div:first-child span { font-weight: 800; }
    .alert-options { margin-top: .7rem; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: .6rem; }
    .alert-options button { min-height: 78px; padding: .75rem; display: flex; flex-direction: column; gap: .2rem; text-align: left; color: var(--text-main); border: 1px solid var(--border-flat); border-radius: .7rem; background: var(--bg-panel); }
    .alert-options button.active { color: var(--accent-primary); border-color: var(--accent-primary); background: color-mix(in srgb, var(--accent-primary) 10%, var(--bg-panel)); }
    .feedback-tests { margin-top: .8rem; display: flex; flex-wrap: wrap; gap: .5rem; }
    @media (max-width: 850px) {
        .settings-hero { align-items: stretch; flex-direction: column; }
        .settings-tile-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .tile-large, .tile-wide { grid-column: span 2; }
        .alert-options { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
</style>
