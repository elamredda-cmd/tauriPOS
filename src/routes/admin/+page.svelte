<script lang="ts">
    import ConnectionStatusPill from "$lib/components/ConnectionStatusPill.svelte";
    import { goto } from '$app/navigation';
    import { getCurrentWindow } from '@tauri-apps/api/window';
    import { onMount } from 'svelte';
    import { settingsDB } from '$lib/stores/db';
    import { currentEmployee, logout } from '$lib/stores/session';
    import { toast } from '$lib/stores/toast';
    import { parseRolePermissions, permissionLabels, type PermissionKey } from '$lib/permissions';
    import PageBackButton from '$lib/components/PageBackButton.svelte';
    import { deviceOperatingMode } from '$lib/deviceMode';
    import {
        BadgePercent,
        CalendarClock,
        ChartNoAxesCombined,
        ChevronRight,
        ClipboardList,
        Clock3,
        ContactRound,
        Info,
        LayoutGrid,
        LockKeyhole,
        LogOut,
        Maximize2,
        Minimize2,
        PackagePlus,
        PackageSearch,
        PanelsTopLeft,
        Percent,
        ReceiptText,
        RefreshCcw,
        Settings as SettingsIcon,
        Truck,
        UsersRound,
    } from '@lucide/svelte';

    type AdminSectionKey = 'sales' | 'stock' | 'people' | 'system';

    type AdminEntry = {
        title: string;
        section: AdminSectionKey;
        description: string;
        path: string;
        permission?: PermissionKey;
        alternativePermission?: PermissionKey;
        accent: string;
        icon: typeof PanelsTopLeft;
    };

    type AdminViewEntry = AdminEntry & {
        allowed: boolean;
        lockedLabel: string;
    };

    type AdminSection = {
        key: AdminSectionKey;
        eyebrow: string;
        title: string;
        description: string;
        accent: string;
        labelAccent: string;
    };

    const adminSections: AdminSection[] = [
        { key: 'stock', eyebrow: 'Catalogue', title: 'Products & stock', description: 'Products, categories, deliveries and suppliers.', accent: '#16a34a', labelAccent: '#4ade80' },
        { key: 'sales', eyebrow: 'Trade', title: 'Sales & finance', description: 'Sales history, cash-up, promotions and tax.', accent: '#2563eb', labelAccent: '#60a5fa' },
        { key: 'people', eyebrow: 'People', title: 'Customers & team', description: 'Customer accounts, staff and attendance.', accent: '#7c3aed', labelAccent: '#a78bfa' },
        { key: 'system', eyebrow: 'Control', title: 'POS & system', description: 'Till design, settings, sync and security.', accent: '#0f766e', labelAccent: '#5eead4' },
    ];

    const adminEntries: AdminEntry[] = [
        { title: 'Orders', section: 'sales', description: 'Receipts, payments, returns and reprints.', path: '/orders', permission: 'open_orders', accent: '#2563eb', icon: ReceiptText },
        { title: 'Reports', section: 'sales', description: 'Sales performance, close and till totals.', path: '/reports', permission: 'open_reports', alternativePermission: 'end_day_close', accent: '#2563eb', icon: ChartNoAxesCombined },
        { title: 'Cash-up Sessions', section: 'sales', description: 'Open sessions and cash-up history.', path: '/shifts', permission: 'open_reports', alternativePermission: 'end_day_close', accent: '#2563eb', icon: CalendarClock },
        { title: 'Discounts', section: 'sales', description: 'Offers, bundles and manual discounts.', path: '/discounts', permission: 'open_discounts', accent: '#db2777', icon: BadgePercent },
        { title: 'Tax Rates', section: 'sales', description: 'VAT rates and tax configuration.', path: '/tax-rates', permission: 'open_tax_rates', accent: '#ca8a04', icon: Percent },
        { title: 'Items', section: 'stock', description: 'Products, barcodes, prices and stock.', path: '/items', permission: 'open_items', accent: '#16a34a', icon: PackageSearch },
        { title: 'Categories', section: 'stock', description: 'Organise products for faster selling.', path: '/categories', permission: 'open_items', accent: '#16a34a', icon: LayoutGrid },
        { title: 'Stock Receiving', section: 'stock', description: 'Receive deliveries and update quantities.', path: '/stock-receiving', permission: 'open_stock_receiving', accent: '#d97706', icon: PackagePlus },
        { title: 'Suppliers', section: 'stock', description: 'Supplier details for stock receiving.', path: '/suppliers', permission: 'open_suppliers', accent: '#d97706', icon: Truck },
        { title: 'Customers', section: 'people', description: 'Loyalty balances and contact details.', path: '/customers', permission: 'open_customers', accent: '#4f46e5', icon: ContactRound },
        { title: 'Staff', section: 'people', description: 'Staff, PINs, roles and permissions.', path: '/employees', permission: 'open_employees', accent: '#7c3aed', icon: UsersRound },
        { title: 'Attendance', section: 'people', description: 'Clock in, clock out and review staff hours.', path: '/attendance', permission: 'view_attendance', accent: '#7c3aed', icon: Clock3 },
        { title: 'Design Studio', section: 'system', description: 'Design till tiles, controls, labels and receipts.', path: '/design', permission: 'open_design', accent: '#0891b2', icon: PanelsTopLeft },
        { title: 'Sync Dashboard', section: 'system', description: 'Till connections and database sync.', path: '/sync', permission: 'open_sync', accent: '#0f766e', icon: RefreshCcw },
        { title: 'Audit Log', section: 'system', description: 'Review important staff and data changes.', path: '/audit', permission: 'open_audit', accent: '#0f766e', icon: ClipboardList },
        { title: 'Settings', section: 'system', description: 'Printers, payments, devices and appearance.', path: '/settings', permission: 'open_settings', accent: '#0f766e', icon: SettingsIcon },
    ];

    let isFullscreen = false;
    let fullscreenBusy = false;

    $: employeeName = $currentEmployee?.name || 'Signed out';
    $: employeeRole = $currentEmployee?.isSupportSession ? 'Support access' : $currentEmployee?.role || '';
    $: employeeInitials = employeeName
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase())
        .join('') || 'AD';
    $: rolePermissions = parseRolePermissions($settingsDB);
    $: adminViewEntries = adminEntries.map((entry): AdminViewEntry => {
        const employeePermissions = $currentEmployee?.isActive
            ? rolePermissions[$currentEmployee.role] || []
            : [];
        const allowed = !entry.permission
            || employeePermissions.includes(entry.permission)
            || Boolean(entry.alternativePermission && employeePermissions.includes(entry.alternativePermission));
        const closeOnly = entry.path === '/reports'
            && employeePermissions.includes('end_day_close')
            && !employeePermissions.includes('open_reports');
        return {
            ...entry,
            title: closeOnly ? 'End Day / Z Report' : entry.title,
            description: closeOnly ? 'Close this till or the whole reporting period.' : entry.description,
            allowed,
            lockedLabel: entry.alternativePermission
                ? `${permissionLabels[entry.permission!]} or ${permissionLabels[entry.alternativePermission]}`
                : entry.permission ? permissionLabels[entry.permission] : entry.title,
        };
    });
    $: adminViewSections = adminSections.map((section) => ({
        ...section,
        entries: adminViewEntries.filter((entry) => entry.section === section.key),
    }));

    function openEntry(entry: AdminViewEntry) {
        if (!entry.allowed) {
            toast(`You do not have permission: ${entry.lockedLabel}`, 'error');
            return;
        }
        goto(entry.path);
    }

    async function refreshFullscreenState() {
        try {
            isFullscreen = await getCurrentWindow().isFullscreen();
        } catch {
            isFullscreen = false;
        }
    }

    async function toggleFullscreen() {
        if (fullscreenBusy) return;
        fullscreenBusy = true;
        try {
            const appWindow = getCurrentWindow();
            const next = !(await appWindow.isFullscreen());
            await appWindow.setFullscreen(next);
            isFullscreen = next;
        } catch (error) {
            console.error('Could not change fullscreen mode:', error);
            toast('Could not change full screen mode', 'error');
        } finally {
            fullscreenBusy = false;
        }
    }

    function signOut() {
        logout();
        goto('/');
    }

    onMount(() => {
        if (!$currentEmployee) {
            goto('/');
            return;
        }
        void refreshFullscreenState();
    });
</script>

<svelte:head>
    <title>Admin</title>
</svelte:head>

<div class="admin-page" class:back-office-mode={$deviceOperatingMode === 'back_office'}>
    <header class="admin-header" class:back-office-mode={$deviceOperatingMode === 'back_office'}>
        {#if $deviceOperatingMode !== 'back_office'}
            <PageBackButton fallback="/" ariaLabel="Back to POS" title="Back to POS" />
        {/if}
        <div class="admin-title">
            {#if $deviceOperatingMode !== 'back_office'}
                <img class="admin-brand-logo" src="/lbj-pos-logo.png" alt="" />
            {/if}
            <div>
                <span>{$deviceOperatingMode === 'back_office' ? 'Back Office' : 'L&Bj POS'}</span>
                <h1>{$deviceOperatingMode === 'back_office' ? 'Overview' : 'Admin'}</h1>
                <ConnectionStatusPill />
            </div>
        </div>
        {#if $deviceOperatingMode !== 'back_office'}
            <div class="admin-user" aria-label="Signed in staff">
                <span class="admin-user-avatar" aria-hidden="true">{employeeInitials}</span>
                <div>
                    <span>Signed in</span>
                    <strong>{employeeName}</strong>
                    <small>{employeeRole ? employeeRole.toUpperCase() : 'NO ROLE'}</small>
                </div>
            </div>
        {/if}
        <div class="admin-header-actions">
            <button
                type="button"
                class="admin-header-btn"
                title="About L&Bj POS"
                aria-label="About L&Bj POS"
                on:click={() => goto('/about')}
            >
                <Info size={22} strokeWidth={2.35} />
            </button>
            <button
                type="button"
                class="admin-header-btn"
                disabled={fullscreenBusy}
                title={isFullscreen ? 'Exit full screen' : 'Enter full screen'}
                aria-label={isFullscreen ? 'Exit full screen' : 'Enter full screen'}
                on:click={toggleFullscreen}
            >
                {#if isFullscreen}
                    <Minimize2 size={22} strokeWidth={2.35} />
                {:else}
                    <Maximize2 size={22} strokeWidth={2.35} />
                {/if}
            </button>
            {#if $deviceOperatingMode !== 'back_office'}
                <button
                    type="button"
                    class="admin-header-btn danger"
                    title="Log out"
                    aria-label="Log out"
                    on:click={signOut}
                >
                    <LogOut size={22} strokeWidth={2.35} />
                </button>
            {/if}
        </div>
    </header>

    <main class="admin-sections" aria-label="Admin navigation">
        {#each adminViewSections as section (section.key)}
            <section class="admin-section" style="--section-accent: {section.accent}; --section-label-accent: {section.labelAccent}" aria-labelledby={`admin-section-${section.key}`}>
                <header class="admin-section-header">
                    <span class="admin-section-icon" aria-hidden="true"></span>
                    <span class="admin-section-copy">
                        <small>{section.eyebrow}</small>
                        <h2 id={`admin-section-${section.key}`}>{section.title}</h2>
                        <span>{section.description}</span>
                    </span>
                    <span class="admin-section-count">{section.entries.length} tools</span>
                </header>

                <div class="admin-section-grid">
                    {#each section.entries as entry (entry.path)}
                        <button
                            type="button"
                            class="admin-entry"
                            class:locked={!entry.allowed}
                            style="--tile-accent: {entry.accent}"
                            aria-disabled={!entry.allowed}
                            title={entry.allowed ? entry.description : `Permission required: ${entry.lockedLabel}`}
                            aria-label={entry.allowed
                                ? `${entry.title}. ${entry.description}`
                                : `${entry.title}. Locked. Permission required: ${entry.lockedLabel}`}
                            on:click={() => openEntry(entry)}
                        >
                            <span class="admin-entry-mark" aria-hidden="true"></span>
                            <span class="admin-entry-icon" aria-hidden="true">
                                <svelte:component this={entry.icon} size={26} strokeWidth={2.25} />
                            </span>
                            <span class="admin-entry-copy">
                                <strong>{entry.title}</strong>
                                <span>{entry.description}</span>
                            </span>
                            <span class="admin-entry-status" aria-hidden="true">
                                {#if entry.allowed}
                                    <ChevronRight size={16} strokeWidth={2.5} />
                                {:else}
                                    <LockKeyhole size={16} strokeWidth={2.5} />
                                {/if}
                            </span>
                        </button>
                    {/each}
                </div>
            </section>
        {/each}
    </main>
</div>

<style>
    .admin-page {
        height: 100dvh;
        width: 100vw;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        gap: 0.9rem;
        padding: var(--app-page-gutter, 1.5rem);
        background: var(--bg-base);
        color: var(--text-main);
        font-size: var(--font-size-management);
    }

    .admin-header {
        display: grid;
        grid-template-columns: auto minmax(150px, 1fr) minmax(160px, auto) auto;
        align-items: center;
        gap: 0.75rem;
        height: 72px;
        min-height: 72px;
    }

    .admin-header-btn {
        width: 44px;
        height: 44px;
        border-radius: 0.45rem;
        border: 1px solid var(--border-flat);
        background: var(--bg-card);
        color: var(--text-main);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        transition: none;
    }

    .admin-header.back-office-mode {
        grid-template-columns: minmax(150px, 1fr) auto;
    }

    .admin-header-btn:hover:not(:disabled) {
        background: var(--bg-card-hover);
        border-color: var(--accent-primary);
    }

    .admin-header-btn:focus-visible,
    .admin-entry:focus-visible {
        outline: 3px solid var(--accent-primary);
        outline-offset: -3px;
    }

    .admin-header-btn:disabled {
        cursor: wait;
        opacity: 0.55;
    }

    .admin-title {
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 0.6rem;
    }

    .admin-brand-logo {
        width: 44px;
        height: 44px;
        flex: 0 0 auto;
        border-radius: 0.42rem;
        object-fit: contain;
    }

    .admin-title span,
    .admin-user span,
    .admin-section-copy small {
        display: block;
        color: var(--text-muted);
        font-size: 0.72rem;
        font-weight: 900;
        letter-spacing: 0;
        text-transform: uppercase;
    }

    .admin-title h1 {
        margin: 0;
        font-size: 1.85rem;
        line-height: 1;
        letter-spacing: 0;
    }

    .admin-header-actions {
        display: flex;
        gap: 0.5rem;
    }

    .admin-header-btn.danger {
        color: var(--danger);
    }

    .admin-header-btn.danger:hover {
        background: var(--danger);
        border-color: var(--danger);
        color: white;
    }

    .admin-user {
        min-width: 0;
        min-height: 44px;
        display: flex;
        align-items: center;
        gap: 0.55rem;
        border: 1px solid var(--border-flat);
        border-radius: 0.45rem;
        background: var(--bg-panel);
        padding: 0.35rem 0.65rem;
    }

    .admin-user-avatar {
        width: 34px;
        height: 34px;
        border-radius: 0.45rem;
        background: var(--accent-primary);
        color: white;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 0.82rem;
        font-weight: 950;
        letter-spacing: 0;
        flex: 0 0 auto;
    }

    .admin-user .admin-user-avatar {
        display: flex;
        align-items: center;
        justify-content: center;
        color: white;
        letter-spacing: 0;
        text-transform: none;
    }

    .admin-user strong {
        display: block;
        max-width: 130px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 0.92rem;
        line-height: 1.05;
    }

    .admin-user small {
        display: block;
        margin-top: 0.1rem;
        color: var(--text-muted);
        font-weight: 900;
        font-size: 0.68rem;
        letter-spacing: 0;
    }

    .admin-sections {
        flex: 1;
        width: 100%;
        min-height: 0;
        overflow-y: auto;
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        grid-auto-rows: max-content;
        gap: 0.75rem;
        align-content: start;
    }

    .admin-section {
        min-width: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        gap: 0.65rem;
        padding: 0.75rem;
        border: 1px solid var(--border-flat);
        border-radius: 0.55rem;
        background: var(--bg-panel);
    }

    .admin-section-header {
        min-width: 0;
        min-height: 48px;
        display: grid;
        grid-template-columns: 4px minmax(0, 1fr) auto;
        align-items: center;
        gap: 0.65rem;
    }

    .admin-section-icon {
        width: 4px;
        height: 36px;
        border-radius: 99px;
        background: var(--section-accent);
    }

    .admin-section-copy {
        min-width: 0;
        display: block;
    }

    .admin-section-copy small {
        color: var(--section-label-accent);
        font-size: 0.64rem;
        line-height: 1;
    }

    .admin-section-copy h2 {
        margin: 0.12rem 0 0;
        font-size: 1.03rem;
        line-height: 1.08;
        letter-spacing: 0;
    }

    .admin-section-copy > span {
        display: block;
        margin-top: 0.2rem;
        overflow: hidden;
        color: var(--text-muted);
        font-size: 0.71rem;
        font-weight: 650;
        line-height: 1.15;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .admin-section-count {
        min-width: 28px;
        height: 28px;
        padding: 0 0.45rem;
        border: 1px solid var(--border-flat);
        border-radius: 0.4rem;
        background: var(--bg-card);
        color: var(--text-muted);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 0.68rem;
        font-weight: 900;
        white-space: nowrap;
    }

    .admin-section-grid {
        min-width: 0;
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        grid-auto-rows: minmax(72px, auto);
        gap: 0.5rem;
    }

    .admin-entry {
        position: relative;
        contain: layout paint;
        min-width: 0;
        min-height: 72px;
        overflow: hidden;
        display: grid;
        grid-template-columns: 52px minmax(0, 1fr) 16px;
        align-items: center;
        gap: 0.55rem;
        padding: 0.5rem 0.6rem 0.5rem 0.72rem;
        border: 1px solid var(--border-flat);
        border-radius: 0.45rem;
        background: var(--bg-card);
        color: var(--text-main);
        text-align: left;
        transition: none;
    }

    .admin-entry:hover:not(.locked) {
        background: var(--bg-card-hover);
        border-color: var(--tile-accent);
    }

    .admin-entry.locked {
        cursor: not-allowed;
        opacity: 0.58;
    }

    .admin-entry-mark {
        position: absolute;
        inset: 0 auto 0 0;
        width: 3px;
        background: var(--tile-accent);
    }

    .admin-entry-icon {
        width: 52px;
        height: 52px;
        border: 1px solid var(--border-flat);
        border-radius: 0.4rem;
        background: var(--bg-panel);
        color: var(--tile-accent);
        display: flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 auto;
    }

    .admin-entry-copy {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 0.18rem;
    }

    .admin-entry-copy strong {
        display: -webkit-box;
        min-width: 0;
        overflow: hidden;
        font-size: 0.93rem;
        line-height: 1.08;
        letter-spacing: 0;
        text-overflow: ellipsis;
        overflow-wrap: anywhere;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        line-clamp: 2;
    }

    .admin-entry-copy > span {
        display: -webkit-box;
        overflow: hidden;
        color: var(--text-muted);
        font-size: 0.69rem;
        font-weight: 650;
        line-height: 1.16;
        text-overflow: ellipsis;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 1;
        line-clamp: 1;
    }

    .admin-entry-status {
        display: flex;
        color: var(--tile-accent);
    }

    .admin-entry.locked .admin-entry-status {
        color: var(--text-muted);
    }

    @media (max-width: 1100px) {
        .admin-page {
            gap: 0.7rem;
        }

        .admin-sections {
            gap: 0.65rem;
        }

        .admin-section {
            gap: 0.55rem;
            padding: 0.65rem;
        }

        .admin-section-grid {
            grid-auto-rows: minmax(72px, auto);
            gap: 0.45rem;
        }

        .admin-entry {
            min-height: 72px;
            grid-template-columns: 52px minmax(0, 1fr) 16px;
            gap: 0.45rem;
            padding: 0.45rem 0.5rem 0.45rem 0.65rem;
        }

        .admin-entry-icon {
            width: 52px;
            height: 52px;
        }

        .admin-entry-copy strong {
            font-size: 0.88rem;
        }
    }

    @media (min-width: 701px) and (max-height: 680px) {
        .admin-page {
            gap: 8px;
            padding: 12px 16px;
        }

        .admin-header {
            height: 64px;
            min-height: 64px;
        }

        .admin-header-btn {
            width: 44px;
            height: 44px;
        }

        .admin-title span,
        .admin-user span {
            font-size: 0.62rem;
        }

        .admin-title h1 {
            font-size: 1.5rem;
        }

        .admin-brand-logo {
            width: 40px;
            height: 40px;
        }

        .admin-user {
            min-height: 42px;
            padding: 0.25rem 0.5rem;
        }

        .admin-user-avatar {
            width: 30px;
            height: 30px;
            font-size: 0.74rem;
        }

        .admin-user strong {
            font-size: 0.82rem;
        }

        .admin-user small {
            font-size: 0.6rem;
        }

        .admin-sections {
            gap: 8px;
        }

        .admin-section {
            gap: 6px;
            padding: 8px;
        }

        .admin-section-header {
            min-height: 36px;
            gap: 8px;
        }

        .admin-section-icon {
            height: 30px;
        }

        .admin-section-copy h2 {
            font-size: 0.9rem;
        }

        .admin-section-copy > span,
        .admin-entry-copy > span {
            display: none;
        }

        .admin-section-count {
            min-width: 24px;
            height: 24px;
            padding: 0 0.35rem;
            font-size: 0.66rem;
        }

        .admin-section-grid {
            grid-auto-rows: minmax(70px, auto);
            gap: 6px;
        }

        .admin-entry {
            min-height: 70px;
            grid-template-columns: 52px minmax(0, 1fr);
            gap: 7px;
            padding: 5px 7px 5px 10px;
        }

        .admin-entry-icon {
            width: 52px;
            height: 52px;
        }

        .admin-entry-copy strong {
            font-size: 0.9rem;
        }

        .admin-entry-status {
            display: none;
        }
    }

    @media (max-width: 700px) {
        .admin-page {
            height: auto;
            min-height: 100dvh;
            overflow-y: auto;
        }

        .admin-header {
            grid-template-columns: auto minmax(0, 1fr) auto;
        }

        .admin-header.back-office-mode {
            grid-template-columns: minmax(0, 1fr) auto;
        }

        .admin-user {
            display: none;
        }

        .admin-sections {
            flex: none;
            overflow: visible;
            grid-template-columns: 1fr;
            grid-auto-rows: max-content;
            align-content: start;
        }
    }

    @media (max-width: 440px) {
        .admin-section-grid {
            grid-template-columns: 1fr;
        }

        .admin-title span {
            display: none;
        }

        .admin-header-actions {
            gap: 0.3rem;
        }

        .admin-header-btn {
            width: 40px;
            height: 40px;
        }
    }

    .admin-page.back-office-mode {
        width: 100%;
        padding: 0.65rem;
        gap: 0.5rem;
    }

    .admin-page.back-office-mode .admin-header {
        height: 50px;
        min-height: 50px;
    }

    .admin-page.back-office-mode .admin-title h1 {
        font-size: 1.4rem;
    }

    .admin-page.back-office-mode .admin-header-btn {
        width: 36px;
        height: 36px;
    }

    .admin-page.back-office-mode .admin-sections {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 0.5rem;
    }

    .admin-page.back-office-mode .admin-section {
        gap: 0.35rem;
        padding: 0.45rem;
        border-radius: 0.45rem;
    }

    .admin-page.back-office-mode .admin-section-header {
        min-height: 36px;
        gap: 0.4rem;
    }

    .admin-page.back-office-mode .admin-section-icon {
        height: 27px;
    }

    .admin-page.back-office-mode .admin-section-copy h2 {
        font-size: 0.86rem;
    }

    .admin-page.back-office-mode .admin-section-copy > span,
    .admin-page.back-office-mode .admin-entry-copy > span {
        display: none;
    }

    .admin-page.back-office-mode .admin-section-count {
        height: 23px;
        padding-inline: 0.32rem;
        font-size: 0.6rem;
    }

    .admin-page.back-office-mode .admin-section-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        grid-auto-rows: minmax(58px, auto);
        gap: 0.35rem;
    }

    .admin-page.back-office-mode .admin-entry {
        min-height: 58px;
        grid-template-columns: 36px minmax(0, 1fr);
        gap: 0.45rem;
        padding: 0.35rem 0.45rem 0.35rem 0.58rem;
        border-radius: 0.38rem;
    }

    .admin-page.back-office-mode .admin-entry-icon {
        width: 36px;
        height: 36px;
    }

    .admin-page.back-office-mode .admin-entry-icon :global(svg) {
        width: 22px;
        height: 22px;
    }

    .admin-page.back-office-mode .admin-entry-copy strong {
        display: -webkit-box;
        overflow: hidden;
        font-size: 0.84rem;
        line-height: 1.1;
        text-overflow: ellipsis;
        overflow-wrap: anywhere;
        white-space: normal;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        line-clamp: 2;
    }

    .admin-page.back-office-mode .admin-entry-status {
        display: none;
    }

    @media (max-width: 760px) {
        .admin-page.back-office-mode .admin-sections {
            grid-template-columns: minmax(0, 1fr);
        }
    }
</style>
