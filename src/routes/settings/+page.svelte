<script lang="ts">
    import { onMount, tick } from 'svelte';
    import { goto } from '$app/navigation';
    import { page } from '$app/stores';
    import { isTauri } from '@tauri-apps/api/core';
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import Modal from '$lib/components/Modal.svelte';
    import CustomSelect from '$lib/components/CustomSelect.svelte';
    import TouchDigitPad from '$lib/components/TouchDigitPad.svelte';
    import { canAccessPath } from '$lib/permissions';
    import { connectionState } from '$lib/stores/connection';
    import {
        currentEmployee,
        currentShiftId,
        isSupportEmployee,
        logout,
        normalizeEmployeeForRuntime,
        PinRateLimitError,
        verifyEmployeePin,
    } from '$lib/stores/session';
    import { employeesDB, storeDB, settingsDB, type Employee, type Store, now, formatMoney } from '$lib/stores/db';
    import { upsert, getTillName, setTillName as setTillNameDb, getOrCreateTillId, recordAuditEvent } from '$lib/stores/database';
    import { toast } from '$lib/stores/toast';
    import {
        deviceOperatingMode,
        deviceOperatingModeLabel,
        saveDeviceOperatingMode,
        type DeviceOperatingMode,
    } from '$lib/deviceMode';
    import { closeCustomerDisplay } from '$lib/customerDisplay';
    import { AGE_RESTRICTION_SETTING_KEY, isAgeRestrictionEnabled } from '$lib/ageRestriction';
    import { appFontOptions, appFontSizeOptions, normalizeAppFontChoice } from '$lib/typography';
    import {
        BadgePercent,
        Banknote,
        Barcode,
        Building2,
        Cctv,
        Clock,
        ChevronRight,
        CreditCard,
        Database,
        GraduationCap,
        HardDrive,
        KeyRound,
        LayoutGrid,
        ReceiptText,
        Tags,
        Monitor,
        MonitorCog,
        PackageCheck,
        Palette,
        Printer,
        Save,
        Scale,
        ShoppingCart,
        ShieldCheck,
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
        { title: 'Button layout', group: 'Appearance', description: 'Arrange checkout shortcuts', path: '/settings/layout', accent: '#2563eb', icon: LayoutGrid },
        { title: 'Receipt design', group: 'Checkout', description: 'Receipt content and layout', path: '/settings/receipt', accent: '#2563eb', icon: ReceiptText },
        { title: 'Product labels', group: 'Hardware', description: 'Label sizes and templates', path: '/settings/labels', accent: '#2563eb', icon: Tags },
        { title: 'Colour theme', group: 'Appearance', description: 'Colours and contrast', path: '/settings/themes', accent: '#2563eb', icon: Palette },
        { title: 'Fonts & text', group: 'Appearance', description: 'Writing style and sizes', path: '/settings/fonts', accent: '#db2777', icon: Type },
        { title: 'Printers & drawer', group: 'Hardware', description: 'Receipts, labels and drawer', path: '/settings/printers', accent: '#16a34a', icon: Printer },
        { title: 'Scale', group: 'Hardware', description: 'Port and weighing setup', path: '/settings/scale', accent: '#0f766e', icon: Scale },
        { title: 'Scale barcodes', group: 'Hardware', description: 'Embedded price rules', path: '/settings/barcodes', accent: '#16a34a', icon: Barcode },
        { title: 'Customer display', group: 'Checkout', description: 'Second-screen basket', path: '/settings/customer-display', accent: '#2563eb', icon: Monitor },
        { title: 'Card terminals', group: 'Checkout', description: 'SumUp, Dojo and providers', path: '/settings/payments', accent: '#059669', icon: CreditCard },
        { title: 'Sound & haptics', group: 'Checkout', description: 'Scan and button feedback', path: '/settings/feedback', accent: '#7c3aed', icon: Volume2 },
        { title: 'CCTV overlay', group: 'Administration', description: 'DVR and NVR sale text', path: '/settings/integrations', accent: '#0f766e', icon: Cctv },
        { title: 'Shop licence', group: 'Administration', description: 'Activation and till seats', path: '/settings/licence', accent: '#16a34a', icon: KeyRound, adminOnly: true },
        { title: 'Owner app', group: 'Administration', description: 'Pair the live dashboard', path: '/settings/owner-app', accent: '#2563eb', icon: Smartphone, adminOnly: true },
        { title: 'Cash Control', group: 'Administration', description: 'Private counts · administrator PIN', path: '/settings/cash-control', accent: '#0f766e', icon: Banknote, adminOnly: true },
        { title: 'Maintenance', group: 'Administration', description: 'Backup, restore and repair', path: '/settings/advanced', accent: '#dc2626', icon: Wrench, adminOnly: true },
    ];

    const settingsCategories = [
        { id: 'general', label: 'Shop & till', icon: StoreIcon, description: 'Shop details, loyalty and daily operation.' },
        { id: 'Appearance', label: 'Appearance', icon: Palette, description: 'Make the workspace comfortable for your team.' },
        { id: 'Hardware', label: 'Hardware', icon: Printer, description: 'Connect and configure the devices around your till.' },
        { id: 'Checkout', label: 'Checkout', icon: ShoppingCart, description: 'Payments, receipts and the customer experience.' },
        { id: 'Administration', label: 'Administration', icon: ShieldCheck, description: 'Manage services, access and shop maintenance.' },
    ];
    $: availableCategories = settingsCategories.filter((item) => item.id === 'general' || visibleSettingsShortcuts.some((entry) => entry.group === item.id));
    $: activeCategory = availableCategories.some((item) => item.id === $page.url.searchParams.get('section'))
        ? $page.url.searchParams.get('section')!
        : 'general';
    $: category = settingsCategories.find((item) => item.id === activeCategory) || settingsCategories[0];
    $: categoryShortcuts = visibleSettingsShortcuts.filter((entry) => entry.group === activeCategory);

    let store = { ...$storeDB };
    let editTillName = '';
    let tillId = '';
    let storeSaving = false;
    let tillNameSaving = false;
    let showDeviceModeDialog = false;
    let requestedDeviceMode: DeviceOperatingMode | null = null;
    let deviceModeApproverId = '';
    let deviceModePin = '';
    let previousDeviceModePin = '';
    let deviceModeError = '';
    let deviceModeSaving = false;
    let deviceModePinInput: HTMLInputElement | null = null;

    $: if (deviceModePin !== previousDeviceModePin) {
        previousDeviceModePin = deviceModePin;
        if (deviceModePin) deviceModeError = '';
    }

    $: stockTrackingEnabled = ($settingsDB.find(s => s.key === 'stock_tracking_enabled')?.value ?? 'true') !== 'false';
    $: ageRestrictionEnabled = isAgeRestrictionEnabled($settingsDB);
    $: loyaltyEnabled = ($settingsDB.find(s => s.key === 'loyalty_enabled')?.value ?? 'true') !== 'false';
    $: attendanceEnabled = ($settingsDB.find(s => s.key === 'time_attendance_enabled')?.value ?? 'false') === 'true';
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
    $: currentDeviceMode = $deviceOperatingMode || 'checkout';
    $: connectionOnline = $connectionState.mode === 'single'
        || ($connectionState.mode === 'multi'
            && $connectionState.mysqlOnline
            && $connectionState.mysqlReady
            && !$connectionState.syncError);
    $: visibleSettingsShortcuts = settingsShortcuts
        .filter((entry) => canAccessPath($currentEmployee, entry.path, $settingsDB))
        .filter((entry) => !entry.adminOnly || $currentEmployee?.role === 'admin')
        .filter((entry) => currentDeviceMode !== 'back_office'
            || !['/settings/customer-display', '/settings/payments'].includes(entry.path));
    $: deviceModeApprovers = $employeesDB
        .map(normalizeEmployeeForRuntime)
        .filter((employee): employee is Employee => Boolean(
            employee?.isActive
            && employee.role === 'admin'
            && !isSupportEmployee(employee),
        ))
        .sort((a, b) => a.name.localeCompare(b.name));
    $: if (
        showDeviceModeDialog
        && (!deviceModeApproverId || !deviceModeApprovers.some((employee) => employee.id === deviceModeApproverId))
    ) {
        const signedInAdmin = deviceModeApprovers.find((employee) => employee.id === $currentEmployee?.id);
        deviceModeApproverId = signedInAdmin?.id || deviceModeApprovers[0]?.id || '';
    }
    $: deviceModeBlockedReason = requestedDeviceMode === 'back_office'
        && cashUpEnabled
        && Boolean($currentShiftId)
        ? 'Close the current till cash-up session before changing this device to Back Office.'
        : '';

    onMount(async () => {
        if (!isTauri()) {
            editTillName = 'Preview Till';
            tillId = 'preview-till';
            return;
        }
        editTillName = await getTillName();
        tillId = await getOrCreateTillId();
    });

    async function updateSetting(key: string, value: string): Promise<boolean> {
        const row = { key, value, updatedAt: now() };
        try {
            if (isTauri()) await upsert('settings', row, 'key');
            settingsDB.update(settings => {
                const index = settings.findIndex(item => item.key === key);
                if (index >= 0) return settings.map((item, itemIndex) => itemIndex === index ? row : item);
                return [...settings, row];
            });
            return true;
        } catch (error) {
            console.error(`Could not save setting ${key}:`, error);
            toast(`Could not save ${key.replace(/_/g, ' ')}. Try again.`, 'error');
            return false;
        }
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
        if (!await updateSetting(key, String(value))) return;
        if (rawValue.trim() !== String(value)) {
            toast(`Loyalty value adjusted to ${value}`, 'info');
        }
    }

    async function saveStore() {
        if (storeSaving) return;
        const nextStore = { ...store } as Store;
        const row = { key: 'store_info', value: JSON.stringify(nextStore), updatedAt: now() };
        storeSaving = true;
        try {
            if (isTauri()) await upsert('settings', row, 'key');
            storeDB.set(nextStore);
            settingsDB.update(settings => {
                const index = settings.findIndex(item => item.key === row.key);
                if (index >= 0) return settings.map((item, itemIndex) => itemIndex === index ? row : item);
                return [...settings, row];
            });
            toast('Store settings saved');
        } catch (error) {
            console.error('Could not save store settings:', error);
            toast('Could not save store settings. Try again.', 'error');
        } finally {
            storeSaving = false;
        }
    }

    async function setStockTracking(enabled: boolean) {
        if (!await updateSetting('stock_tracking_enabled', enabled ? 'true' : 'false')) return;
        toast(enabled ? 'Stock tracking enabled' : 'Stock tracking disabled across the shop');
    }

    async function setAgeRestrictionEnabled(enabled: boolean) {
        if (!await updateSetting(AGE_RESTRICTION_SETTING_KEY, enabled ? 'true' : 'false')) return;
        toast(enabled
            ? '18+ item alerts enabled across the shop'
            : '18+ item alerts disabled across the shop');
    }

    async function setCashUpEnabled(enabled: boolean) {
        if (enabled && !await updateSetting('cash_up_activation_time', now())) return;
        if (!await updateSetting('cash_up_enabled', enabled ? 'true' : 'false')) return;
        toast(enabled ? 'Till cash-up enabled across the shop' : 'Till cash-up disabled across the shop');
    }

    async function saveTillName() {
        if (tillNameSaving) return;
        tillNameSaving = true;
        try {
            if (isTauri()) await setTillNameDb(editTillName);
            toast('Till name saved');
        } catch (error) {
            console.error('Could not save till name:', error);
            toast('Could not save till name. Try again.', 'error');
        } finally {
            tillNameSaving = false;
        }
    }

    function requestDeviceModeChange(mode: DeviceOperatingMode) {
        if (deviceModeSaving || mode === currentDeviceMode) return;
        if (mode === 'back_office' && cashUpEnabled && Boolean($currentShiftId)) {
            toast('Close the current till cash-up session before switching this computer to Back Office.', 'error');
            return;
        }
        requestedDeviceMode = mode;
        deviceModePin = '';
        deviceModeError = '';
        showDeviceModeDialog = true;
        if ($deviceOperatingMode === 'back_office') {
            void tick().then(() => deviceModePinInput?.focus({ preventScroll: true }));
        }
    }

    function cancelDeviceModeChange() {
        if (deviceModeSaving) return;
        showDeviceModeDialog = false;
        requestedDeviceMode = null;
        deviceModePin = '';
        deviceModeError = '';
    }

    async function confirmDeviceModeChange() {
        const nextMode = requestedDeviceMode;
        const approverName = deviceModeApprovers.find((employee) => employee.id === deviceModeApproverId)?.name || 'administrator';
        if (!nextMode || deviceModeSaving) return;
        if (deviceModeBlockedReason) {
            deviceModeError = deviceModeBlockedReason;
            return;
        }
        if (!deviceModeApproverId) {
            deviceModeError = 'No active administrator with a usable PIN is available. Repair administrator access first.';
            return;
        }
        if (!/^\d{4,8}$/.test(deviceModePin)) {
            deviceModeError = 'Enter the administrator’s 4 to 8 digit PIN.';
            return;
        }

        deviceModeSaving = true;
        deviceModeError = '';
        try {
            const approver = await verifyEmployeePin(deviceModeApproverId, deviceModePin);
            if (!approver || approver.role !== 'admin' || isSupportEmployee(approver)) {
                deviceModePin = '';
                deviceModeError = `Incorrect PIN for ${approverName}.`;
                return;
            }

            const previousMode = currentDeviceMode;
            if (nextMode === 'back_office' && isTauri()) {
                await closeCustomerDisplay();
            }
            await saveDeviceOperatingMode(nextMode);
            await recordAuditEvent(
                'device_operating_mode_changed',
                'device',
                tillId || 'this-device',
                { operatingMode: previousMode },
                { operatingMode: nextMode },
                approver.id,
            ).catch((error) => console.warn('Could not record device-mode audit event:', error));

            showDeviceModeDialog = false;
            requestedDeviceMode = null;
            deviceModePin = '';
            logout();
            toast(`${deviceOperatingModeLabel(nextMode)} is now active on this computer. Sign in to continue.`, 'success');
            await goto('/', { replaceState: true });
        } catch (error) {
            console.error('Could not change device operating mode:', error);
            deviceModePin = '';
            deviceModeError = error instanceof PinRateLimitError
                ? error.message
                : 'Mode was not changed. Could not save this device setting.';
        } finally {
            deviceModeSaving = false;
        }
    }

    function handleDeviceModePinKeydown(event: KeyboardEvent) {
        if (
            !showDeviceModeDialog
            || deviceModeSaving
            || Boolean(deviceModeBlockedReason)
            || deviceModeApprovers.length === 0
            || event.defaultPrevented
        ) return;
        if (
            $deviceOperatingMode === 'back_office'
            && (event.target as HTMLElement | null)?.matches('.device-mode-desktop-pin-input')
        ) return;
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        if (/^\d$/.test(event.key)) {
            event.preventDefault();
            if (deviceModePin.length < 8) deviceModePin += event.key;
            deviceModeError = '';
            return;
        }
        if (event.key === 'Backspace') {
            event.preventDefault();
            deviceModePin = deviceModePin.slice(0, -1);
            deviceModeError = '';
            return;
        }
        if (event.key === 'Enter' && deviceModePin.length >= 4) {
            event.preventDefault();
            void confirmDeviceModeChange();
        }
    }

    function handleDeviceModeDesktopPinInput(event: Event & { currentTarget: HTMLInputElement }) {
        const sanitized = event.currentTarget.value.replace(/\D/g, '').slice(0, 8);
        event.currentTarget.value = sanitized;
        deviceModePin = sanitized;
        if (deviceModeError) deviceModeError = '';
    }

    function handleDeviceModeDesktopPinKeydown(event: KeyboardEvent) {
        if (event.key === 'Enter' && deviceModePin.length >= 4) {
            event.preventDefault();
            void confirmDeviceModeChange();
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            cancelDeviceModeChange();
        }
    }

    function selectedSizeLabel(value: string): string {
        return appFontSizeOptions.find((option) => option.value === value)?.label || 'Normal';
    }
</script>

<svelte:head>
    <title>Settings</title>
</svelte:head>

<svelte:window on:keydown={handleDeviceModePinKeydown} />

<MgmtPage title="Settings" description="Manage your shop, devices and checkout.">

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
                        <span class="settings-status-dot" class:online={connectionOnline}></span>
                        <span>{connectionOnline ? 'Online' : 'Offline'}</span>
                    </strong>
                </span>
            </div>
            <div class="settings-summary-item">
                <span class="settings-summary-icon"><MonitorCog size={22} strokeWidth={2.25} /></span>
                <span class="settings-summary-copy">
                    <small>This device</small>
                    <strong>{editTillName || 'Loading...'}</strong>
                    <span class="settings-device-summary-mode">{deviceOperatingModeLabel(currentDeviceMode)}</span>
                </span>
            </div>
            <div class="settings-summary-item">
                <span class="settings-summary-icon"><PackageCheck size={22} strokeWidth={2.25} /></span>
                <span class="settings-summary-copy"><small>Stock</small><strong>{stockTrackingEnabled ? 'Tracking on' : 'Tracking off'}</strong></span>
            </div>
        </section>

        {#if $connectionState.syncError}
            <div class="settings-sync-error" role="alert">{$connectionState.syncError}</div>
        {/if}

        <div class="settings-workspace">
            <nav class="settings-category-nav" aria-label="Settings categories">
                {#each availableCategories as item}
                    <button
                        type="button"
                        class:active={activeCategory === item.id}
                        aria-pressed={activeCategory === item.id}
                        aria-controls="settings-category-content"
                        on:click={() => goto(`/settings?section=${item.id}`, { replaceState: true, noScroll: true, keepFocus: true })}
                    >
                        <svelte:component this={item.icon} size={20} strokeWidth={2} aria-hidden="true" />
                        <span>{item.label}</span>
                        <ChevronRight size={16} aria-hidden="true" />
                    </button>
                {/each}
            </nav>

            <section id="settings-category-content" class="settings-category-content" aria-labelledby="settings-category-title">
                <header class="settings-section-heading">
                    <div><h2 id="settings-category-title">{category.label}</h2><p>{category.description}</p></div>
                </header>
                {#if activeCategory !== 'general'}
                    <div class="settings-shortcut-grid">
                        {#each categoryShortcuts as entry (entry.path)}
                            <a href={entry.path} class="settings-shortcut">
                                <span class="settings-shortcut-icon" aria-hidden="true">
                                    <svelte:component this={entry.icon} size={23} strokeWidth={2} />
                                </span>
                                <span class="settings-shortcut-copy">
                                    <strong>{entry.title}</strong>
                                    <span>{entry.path === '/settings/fonts'
                                        ? `${selectedFontOption.label} · POS ${selectedSizeLabel(selectedPosFontSize)} · Settings ${selectedSizeLabel(selectedSettingsFontSize)}`
                                        : entry.description}</span>
                                    {#if entry.adminOnly}<small>Administrator</small>{/if}
                                </span>
                                <ChevronRight size={19} aria-hidden="true" />
                            </a>
                        {/each}
                    </div>
                {:else}
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
                    <footer class="settings-panel-footer">
                        <span>Save after editing shop details.</span>
                        <button class="btn btn-primary settings-save-button" disabled={storeSaving} on:click={saveStore}>
                            <Save size={18} aria-hidden="true" />
                            <span>{storeSaving ? 'Saving…' : 'Save shop'}</span>
                        </button>
                    </footer>
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
                                <button class="btn btn-primary" disabled={tillNameSaving} on:click={saveTillName}>{tillNameSaving ? 'Saving...' : 'Save name'}</button>
                            </div>
                        </div>
                        <div class="field">
                            <label for="settings-till-id">Till ID</label>
                            <input id="settings-till-id" value={tillId} readonly class="settings-readonly-input" />
                        </div>
                    </div>

                    <div class="settings-device-role-row" aria-labelledby="device-role-heading">
                        <span class="settings-device-role-icon" aria-hidden="true">
                            {#if currentDeviceMode === 'back_office'}
                                <Building2 size={22} strokeWidth={2.25} />
                            {:else}
                                <ShoppingCart size={22} strokeWidth={2.25} />
                            {/if}
                        </span>
                        <span class="settings-device-role-copy">
                            <small id="device-role-heading">Device role · this computer</small>
                            <strong>{deviceOperatingModeLabel(currentDeviceMode)}</strong>
                            <span>{currentDeviceMode === 'back_office'
                                ? 'Management tools without checkout or till shifts.'
                                : 'Sales, payments and connected till hardware.'}</span>
                        </span>
                        <button
                            type="button"
                            class="btn btn-secondary settings-device-role-action"
                            disabled={deviceModeSaving}
                            on:click={() => requestDeviceModeChange(currentDeviceMode === 'back_office' ? 'checkout' : 'back_office')}
                        >
                            <span>Use {currentDeviceMode === 'back_office' ? 'Checkout' : 'Back Office'}</span>
                            <ChevronRight size={17} strokeWidth={2.5} aria-hidden="true" />
                        </button>
                    </div>
                    <div class="settings-device-mode-note">
                        <ShieldCheck size={17} strokeWidth={2.4} aria-hidden="true" />
                        <span><strong>Admin PIN required.</strong> Switching changes only this computer and signs you out.</span>
                    </div>
                </section>

                <section class="settings-config-panel settings-database-panel">
                    <header class="settings-panel-header">
                        <span class="settings-panel-icon"><HardDrive size={22} strokeWidth={2.25} /></span>
                        <div>
                            <h3>Database</h3>
                            <p>{$connectionState.mode === 'single'
                                ? 'This till’s local database is available.'
                                : connectionOnline
                                    ? 'Connected to the central MariaDB server.'
                                    : 'Working from this till’s local cache while the central database is unavailable.'}</p>
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
                        <div><h3>Shop operation</h3><p>Daily selling and cash-up. Switches save immediately.</p></div>
                    </header>

                    <div class="settings-operation-list">
                        <div class="settings-operation-row">
                            <span class="settings-operation-icon"><Clock size={20} /></span>
                            <div><strong>Time attendance</strong><span>Enable clock-in and clock-out from the checkout clock. Shop-wide.</span></div>
                            <button type="button" class="settings-switch-control" class:enabled={attendanceEnabled}
                                role="switch" aria-checked={attendanceEnabled} aria-label="Time attendance"
                                on:click={() => updateSetting('time_attendance_enabled', attendanceEnabled ? 'false' : 'true')}
                            ><span>{attendanceEnabled ? 'On' : 'Off'}</span><span class="settings-switch-track"><span></span></span></button>
                        </div>

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
                            <span class="settings-operation-icon"><ShieldCheck size={20} /></span>
                            <div><strong>18+ item alerts</strong><span>Ask the cashier to check ID before adding marked items. Shop-wide.</span></div>
                            <button
                                type="button"
                                class="settings-switch-control"
                                class:enabled={ageRestrictionEnabled}
                                role="switch"
                                aria-checked={ageRestrictionEnabled}
                                aria-label="18+ item alerts"
                                on:click={() => setAgeRestrictionEnabled(!ageRestrictionEnabled)}
                            ><span>{ageRestrictionEnabled ? 'On' : 'Off'}</span><span class="settings-switch-track"><span></span></span></button>
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
                {/if}
            </section>
        </div>
    </div>
</MgmtPage>

<Modal
    bind:show={showDeviceModeDialog}
    title={requestedDeviceMode === 'back_office' ? 'Switch to Back Office?' : 'Switch to Checkout Till?'}
    width="680px"
    dismissDisabled={deviceModeSaving}
>
    <div
        class="device-mode-dialog"
        class:blocked={Boolean(deviceModeBlockedReason) || deviceModeApprovers.length === 0}
    >
        <section class="device-mode-dialog-copy">
            <div class="device-mode-dialog-intro">
                <span class="device-mode-dialog-icon" aria-hidden="true">
                    {#if requestedDeviceMode === 'back_office'}
                        <Building2 size={25} strokeWidth={2.25} />
                    {:else}
                        <ShoppingCart size={25} strokeWidth={2.25} />
                    {/if}
                </span>
                <div>
                    <strong>{editTillName || 'This computer'} will use {deviceOperatingModeLabel(requestedDeviceMode)}.</strong>
                    <p>{requestedDeviceMode === 'back_office'
                        ? 'Staff sign-in opens management without starting a till shift.'
                        : 'Staff sign-in opens Checkout with payments and till hardware.'}</p>
                </div>
            </div>
            <div class="device-mode-safety-note">
                <ShieldCheck size={18} strokeWidth={2.4} aria-hidden="true" />
                <span>Only this computer changes. Shop data and staff permissions stay unchanged.</span>
            </div>
            {#if deviceModeBlockedReason}
                <div class="device-mode-blocked" role="alert">{deviceModeBlockedReason}</div>
            {:else if deviceModeApprovers.length === 0}
                <div class="device-mode-blocked" role="alert">
                    No active administrator is available. Use L&amp;Bj Support to repair staff access first.
                </div>
            {:else}
                <CustomSelect
                    label="Approving administrator"
                    bind:value={deviceModeApproverId}
                    options={deviceModeApprovers.map((employee) => ({ label: employee.name, value: employee.id }))}
                    placeholder="Choose an administrator"
                    emptyText="No active administrators"
                    disabled={deviceModeSaving}
                    largeOptions
                />
            {/if}
        </section>

        {#if !deviceModeBlockedReason && deviceModeApprovers.length > 0}
            <section class="device-mode-dialog-pad" aria-label="Administrator PIN">
                {#if $deviceOperatingMode === 'back_office'}
                    <div class="device-mode-desktop-pin">
                        <span class="device-mode-desktop-pin-icon" aria-hidden="true"><KeyRound size={22} strokeWidth={2.3} /></span>
                        <div>
                            <label for="device-mode-admin-pin">Administrator PIN</label>
                            <p>Enter the PIN with your keyboard.</p>
                        </div>
                        <input
                            id="device-mode-admin-pin"
                            class="device-mode-desktop-pin-input"
                            bind:this={deviceModePinInput}
                            value={deviceModePin}
                            type="password"
                            autocomplete="off"
                            maxlength="8"
                            pattern={"[0-9]{4,8}"}
                            placeholder="4 to 8 digits"
                            disabled={deviceModeSaving}
                            data-touch-keyboard="off"
                            data-modal-initial-focus
                            on:input={handleDeviceModeDesktopPinInput}
                            on:keydown={handleDeviceModeDesktopPinKeydown}
                        />
                        <button
                            type="button"
                            class="btn btn-primary"
                            disabled={deviceModePin.length < 4 || deviceModeSaving}
                            on:click={confirmDeviceModeChange}
                        >{deviceModeSaving ? 'Switching…' : 'Confirm switch'}</button>
                        <small>Press Enter to confirm · Esc to cancel</small>
                    </div>
                {:else}
                    <TouchDigitPad
                        bind:value={deviceModePin}
                        masked
                        maxLength={8}
                        placeholder="Administrator PIN"
                        submitLabel={deviceModeSaving ? 'Switching…' : 'Confirm switch'}
                        submitDisabled={deviceModePin.length < 4}
                        disabled={deviceModeSaving}
                        onSubmit={confirmDeviceModeChange}
                    />
                {/if}
                {#if deviceModeError}
                    <p class="device-mode-error" aria-live="polite">{deviceModeError}</p>
                {/if}
            </section>
        {/if}
    </div>
    <svelte:fragment slot="footer">
        <button type="button" class="btn btn-secondary" disabled={deviceModeSaving} on:click={cancelDeviceModeChange}>
            Cancel
        </button>
    </svelte:fragment>
</Modal>

<style>
    .settings-overview {
        width: 100%; max-width: 1600px; margin: 0 auto; padding: clamp(.75rem, 2vw, 1.5rem);
        display: flex; flex-direction: column; gap: 1.5rem; color: var(--text-main);
        font-size: var(--font-size-settings); container: settings / inline-size;
    }
    .settings-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; border: 1px solid var(--border-flat); border-radius: .75rem; overflow: hidden; background: var(--border-flat); }
    .settings-summary-item { min-width: 0; min-height: 76px; padding: .85rem 1rem; display: flex; align-items: center; gap: .75rem; background: var(--bg-card); }
    .settings-summary-icon, .settings-panel-icon, .settings-operation-icon, .settings-device-role-icon { width: 40px; height: 40px; flex: 0 0 auto; display: grid; place-items: center; border-radius: .6rem; background: var(--bg-panel); color: var(--accent-primary); }
    .settings-summary-copy { min-width: 0; }
    .settings-summary-copy small { display: block; color: var(--text-muted); font-size: .75em; font-weight: 500; }
    .settings-summary-copy strong { display: block; margin-top: .2rem; font-size: .94em; font-weight: 650; line-height: 1.3; overflow-wrap: anywhere; }
    .settings-device-summary-mode { display: block; margin-top: .15rem; color: var(--text-muted); font-size: .72em; }
    .settings-summary-copy .settings-summary-state { display: flex; align-items: center; gap: .5rem; }
    .settings-status-dot { width: 8px; height: 8px; flex: 0 0 auto; border-radius: 50%; background: var(--warning); }
    .settings-status-dot.online { background: var(--success); }
    .settings-workspace { display: grid; grid-template-columns: 190px minmax(0, 1fr); gap: 1.5rem; align-items: start; }
    .settings-category-nav { display: flex; flex-direction: column; gap: .3rem; position: sticky; top: 0; }
    .settings-category-nav button { min-width: 0; min-height: 50px; display: grid; grid-template-columns: 20px minmax(0,1fr) 16px; gap: .65rem; align-items: center; padding: .7rem; border: 1px solid transparent; border-radius: .6rem; background: transparent; text-align: left; color: var(--text-muted); font-size: .88em; font-weight: 600; cursor: pointer; }
    .settings-category-nav button:hover { color: var(--text-main); background: var(--bg-card-hover); }
    .settings-category-nav button.active { background: color-mix(in srgb, var(--accent-primary) 12%, var(--bg-card)); color: var(--text-main); border-color: color-mix(in srgb, var(--accent-primary) 50%, var(--border-flat)); }
    .settings-category-nav button.active :global(svg) { color: var(--accent-primary); }
    .settings-category-content { min-width: 0; }
    .settings-section-heading { margin-bottom: 1.2rem; }
    .settings-section-heading h2 { margin: 0; font-size: 1.3em; line-height: 1.25; font-weight: 700; }
    .settings-section-heading p { margin: .35rem 0 0; color: var(--text-muted); font-size: .85em; line-height: 1.5; }
    .settings-shortcut-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 270px), 1fr)); gap: .85rem; }
    .settings-shortcut { min-width: 0; min-height: 112px; display: grid; grid-template-columns: 46px minmax(0, 1fr) 19px; align-items: center; gap: .85rem; padding: 1.1rem; border: 1px solid var(--border-flat); border-radius: .75rem; background: var(--bg-card); color: var(--text-main); text-decoration: none; }
    .settings-shortcut:hover { border-color: var(--accent-primary); background: var(--bg-card-hover); }
    .settings-shortcut-icon { width: 46px; height: 46px; display: grid; place-items: center; border-radius: .65rem; background: color-mix(in srgb, var(--accent-primary) 12%, var(--bg-panel)); color: var(--accent-primary); }
    .settings-shortcut-copy { min-width: 0; display: flex; flex-direction: column; gap: .35rem; }
    .settings-shortcut-copy strong { font-size: 1em; line-height: 1.3; font-weight: 650; overflow-wrap: anywhere; }
    .settings-shortcut-copy > span { font-size: .82em; line-height: 1.45; color: var(--text-muted); }
    .settings-shortcut-copy small { font-size: .7em; color: var(--text-muted); }
    .settings-shortcut > :global(svg) { color: var(--text-muted); }
    .settings-config-columns { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); align-items: start; gap: 1rem; }
    .settings-config-column { min-width: 0; display: flex; flex-direction: column; gap: 1rem; }
    .settings-config-panel { min-width: 0; padding: 1.2rem; border: 1px solid var(--border-flat); border-radius: .75rem; background: var(--bg-card); container: setting-panel / inline-size; }
    .settings-panel-header { display: grid; grid-template-columns: 40px minmax(0,1fr); align-items: center; gap: .75rem; margin-bottom: 1.1rem; }
    .settings-panel-header-action { grid-template-columns: 40px minmax(0,1fr) auto; }
    .settings-panel-header h3 { margin: 0; font-size: 1em; font-weight: 650; line-height: 1.35; }
    .settings-panel-header p { margin: .2rem 0 0; color: var(--text-muted); font-size: .78em; line-height: 1.45; }
    .settings-form-grid { gap: .9rem; }
    .settings-config-panel .field label { font-size: .78em; font-weight: 550; text-transform: none; letter-spacing: 0; color: var(--text-muted); }
    .settings-config-panel .field input { box-shadow: none; border-radius: .5rem; font-size: .9em; min-height: 46px; font-weight: 500; }
    .settings-panel-footer { display: flex; flex-wrap: wrap; gap: .75rem; align-items: center; justify-content: space-between; margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--border-flat); }
    .settings-panel-footer > span { font-size: .75em; line-height: 1.4; color: var(--text-muted); }
    .settings-config-panel .btn { min-height: 46px; font-size: .85em; padding: .65rem .9rem; box-shadow: none; font-weight: 600; }
    .settings-till-fields { display: grid; gap: .9rem; }
    .settings-inline-field { min-width: 0; display: grid; grid-template-columns: minmax(0,1fr) auto; gap: .5rem; }
    .settings-readonly-input { color: var(--text-muted) !important; font-family: var(--app-font-mono) !important; font-size: .75em !important; text-overflow: ellipsis; }
    .settings-device-role-row { min-width: 0; display: grid; grid-template-columns: 40px minmax(0,1fr); align-items: center; gap: .7rem; margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--border-flat); }
    .settings-device-role-copy { min-width: 0; }
    .settings-device-role-copy small, .settings-device-role-copy strong, .settings-device-role-copy > span { display: block; line-height: 1.4; }
    .settings-device-role-copy small { color: var(--text-muted); font-size: .72em; }
    .settings-device-role-copy strong { margin: .15rem 0; font-size: .9em; font-weight: 650; }
    .settings-device-role-copy > span { color: var(--text-muted); font-size: .78em; }
    .settings-device-role-action { grid-column: 1 / -1; justify-self: start; }
    .settings-device-mode-note { display: flex; align-items: flex-start; gap: .5rem; margin-top: .75rem; color: var(--text-muted); font-size: .73em; line-height: 1.5; }
    .settings-device-mode-note :global(svg) { flex: 0 0 auto; margin-top: .1rem; }
    .settings-device-mode-note strong { font-weight: 600; color: var(--text-main); }
    .settings-database-panel .settings-panel-header { margin-bottom: 0; }
    .settings-loyalty-grid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: .7rem; }
    .disabled-settings { opacity: .55; }
    .settings-example { margin-top: 1rem; padding: .75rem; background: var(--bg-panel); border-radius: .5rem; color: var(--text-muted); font-size: .8em; line-height: 1.4; }
    .settings-operation-list { display: flex; flex-direction: column; }
    .settings-operation-row { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: .75rem; align-items: center; padding: 1rem 0; border-bottom: 1px solid var(--border-flat); }
    .settings-operation-row:first-child { padding-top: 0; }
    .settings-operation-row:last-child { padding-bottom: 0; border-bottom: 0; }
    .settings-operation-icon { display: none; }
    .settings-operation-row > div { min-width: 0; }
    .settings-operation-row strong, .settings-sub-options strong { display: block; font-size: .88em; font-weight: 600; line-height: 1.4; }
    .settings-operation-row div > span, .settings-sub-options small { display: block; margin-top: .3rem; font-size: .78em; color: var(--text-muted); line-height: 1.5; }
    .settings-switch-control { min-width: 88px; min-height: 46px; padding: .35rem; display: inline-flex; align-items: center; justify-content: flex-end; gap: .5rem; border: 0; background: transparent; color: var(--text-muted); font-size: .76em; font-weight: 600; cursor: pointer; border-radius: .5rem; }
    .settings-switch-control:hover { background: var(--bg-card-hover); }
    .settings-switch-track { position: relative; width: 44px; height: 26px; flex: 0 0 auto; border-radius: 999px; background: var(--text-muted); }
    .settings-switch-track > span { position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%; background: var(--bg-card); }
    .settings-switch-control.enabled .settings-switch-track { background: var(--accent-primary); }
    .settings-switch-control.enabled .settings-switch-track > span { transform: translateX(18px); background: white; }
    .settings-switch-control.danger-enabled .settings-switch-track { background: var(--danger); }
    .settings-sync-error, .settings-warning { border: 1px solid var(--danger); border-radius: .6rem; background: color-mix(in srgb, var(--danger) 8%, var(--bg-card)); padding: .85rem; color: var(--text-main); font-size: .82em; line-height: 1.5; overflow-wrap: anywhere; }
    .settings-warning { margin-top: .75rem; }
    .settings-sub-options { display: grid; gap: .5rem; margin-top: .75rem; }
    .settings-sub-options > div { min-width: 0; display: flex; justify-content: space-between; align-items: center; gap: .65rem; padding: .75rem; border-radius: .5rem; background: var(--bg-panel); }
    .settings-category-nav button:focus-visible, .settings-shortcut:focus-visible, .settings-switch-control:focus-visible { outline: 3px solid var(--accent-primary); outline-offset: 2px; }
    @container settings (max-width: 1120px) {
        .settings-workspace { grid-template-columns: minmax(0,1fr); gap: 1.2rem; }
        .settings-category-nav { position: static; display: grid; grid-template-columns: repeat(5,minmax(0,1fr)); gap: .4rem; padding-bottom: .75rem; border-bottom: 1px solid var(--border-flat); }
        .settings-category-nav button { display: flex; gap: .5rem; justify-content: center; padding: .65rem .45rem; font-size: .82em; }
        .settings-category-nav button > :global(svg:last-child) { display: none; }
    }
    @container settings (max-width: 850px) {
        .settings-summary { grid-template-columns: repeat(2,minmax(0,1fr)); }
        .settings-config-columns { grid-template-columns: minmax(0,1fr); }
    }
    @container settings (max-width: 740px) {
        .settings-category-nav { grid-template-columns: repeat(3,minmax(0,1fr)); }
        .settings-category-nav button { justify-content: flex-start; padding: .65rem; }
    }
    @container settings (max-width: 440px) {
        .settings-category-nav { grid-template-columns: repeat(2,minmax(0,1fr)); }
        .settings-summary-item { padding: .75rem; gap: .5rem; }
        .settings-summary-icon { display: none; }
    }
    @container setting-panel (max-width: 360px) {
        .settings-loyalty-grid { grid-template-columns: minmax(0,1fr); }
        .settings-panel-header-action { grid-template-columns: minmax(0,1fr) auto; }
        .settings-panel-header-action .settings-panel-icon { display: none; }
        .settings-form-grid { grid-template-columns: minmax(0,1fr); }
        .settings-form-grid > .span-2 { grid-column: 1; }
    }
    .device-mode-dialog {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(270px, 0.88fr);
        align-items: start;
        gap: 0.85rem;
    }

    .device-mode-dialog.blocked {
        grid-template-columns: 1fr;
    }

    .device-mode-dialog-copy {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 0.7rem;
    }

    .device-mode-dialog-intro {
        min-width: 0;
        display: flex;
        align-items: flex-start;
        gap: 0.7rem;
    }

    .device-mode-dialog-icon {
        width: 46px;
        height: 46px;
        flex: 0 0 46px;
        display: flex;
        align-items: center;
        justify-content: center;
        border: 1px solid color-mix(in srgb, var(--accent-primary) 45%, var(--border-flat));
        border-radius: 0.65rem;
        background: color-mix(in srgb, var(--accent-primary) 10%, var(--bg-panel));
        color: var(--accent-primary);
    }

    .device-mode-dialog-copy strong {
        font-size: 0.94rem;
        line-height: 1.3;
    }

    .device-mode-dialog-copy p {
        margin: 0.28rem 0 0;
        color: var(--text-muted);
        font-size: 0.8rem;
        line-height: 1.38;
    }

    .device-mode-safety-note,
    .device-mode-blocked {
        padding: 0.75rem;
        border: 1px solid var(--border-flat);
        border-radius: 0.5rem;
        background: var(--bg-panel);
        color: var(--text-muted);
        font-size: 0.78rem;
        font-weight: 700;
        line-height: 1.4;
    }

    .device-mode-safety-note {
        display: flex;
        align-items: flex-start;
        gap: 0.5rem;
    }

    .device-mode-safety-note :global(svg) {
        margin-top: 0.05rem;
        flex: 0 0 auto;
        color: var(--success);
    }

    .device-mode-blocked {
        border-color: color-mix(in srgb, var(--danger) 50%, var(--border-flat));
        background: color-mix(in srgb, var(--danger) 10%, var(--bg-panel));
        color: var(--danger);
    }

    .device-mode-dialog-pad {
        min-width: 0;
    }

    .device-mode-desktop-pin {
        min-width: 0;
        padding: 1rem;
        display: grid;
        grid-template-columns: 38px minmax(0, 1fr);
        align-items: center;
        gap: 0.7rem;
        border: 1px solid var(--border-flat);
        border-radius: 0.55rem;
        background: var(--bg-panel);
    }

    .device-mode-desktop-pin-icon {
        width: 38px;
        height: 38px;
        display: grid;
        place-items: center;
        color: var(--accent-primary);
        border: 1px solid color-mix(in srgb, var(--accent-primary) 38%, var(--border-flat));
        border-radius: 0.45rem;
        background: color-mix(in srgb, var(--accent-primary) 10%, var(--bg-card));
    }

    .device-mode-desktop-pin label {
        display: block;
        color: var(--text-main);
        font-size: 0.82rem;
        font-weight: 850;
    }

    .device-mode-desktop-pin p {
        margin: 0.12rem 0 0;
        color: var(--text-muted);
        font-size: 0.7rem;
    }

    .device-mode-desktop-pin-input,
    .device-mode-desktop-pin .btn,
    .device-mode-desktop-pin > small {
        grid-column: 1 / -1;
    }

    .device-mode-desktop-pin-input {
        width: 100%;
        height: 42px;
        padding: 0 0.75rem;
        border: 1px solid var(--border-flat);
        border-radius: 0.42rem;
        outline: none;
        background: var(--bg-card);
        color: var(--text-main);
        font-size: 1rem;
        font-weight: 850;
        letter-spacing: 0.15em;
    }

    .device-mode-desktop-pin-input:focus {
        border-color: var(--accent-primary);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-primary) 20%, transparent);
    }

    .device-mode-desktop-pin .btn {
        width: 100%;
        min-height: 40px;
    }

    .device-mode-desktop-pin > small {
        color: var(--text-muted);
        font-size: 0.67rem;
        text-align: center;
    }

    .device-mode-error {
        min-height: 1.25rem;
        margin: 0.55rem 0 0;
        color: var(--danger);
        font-size: 0.78rem;
        font-weight: 750;
        line-height: 1.3;
    }

    @media (max-width: 640px) { .device-mode-dialog { grid-template-columns: minmax(0,1fr); } }
    :global(.back-office-route) .settings-category-nav button { min-height: 42px; }
    :global(.back-office-route) .settings-config-panel .btn { min-height: 38px; padding: .45rem .75rem; }
    :global(.back-office-route) .settings-switch-control { min-height: 36px; }
</style>
