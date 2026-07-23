<script lang="ts">
    import { goto } from '$app/navigation';
    import { getCurrentWindow } from '@tauri-apps/api/window';
    import { onMount } from 'svelte';
    import { settingsDB } from '$lib/stores/db';
    import { currentEmployee, logout } from '$lib/stores/session';
    import { toast } from '$lib/stores/toast';
    import { parseRolePermissions, permissionLabels, type PermissionKey } from '$lib/permissions';
    import PageBackButton from '$lib/components/PageBackButton.svelte';
    import {
        BadgePercent,
        CalendarClock,
        ChartNoAxesCombined,
        ChevronRight,
        ClipboardList,
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

    type AdminEntry = {
        title: string;
        group: string;
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

    const adminEntries: AdminEntry[] = [
        { title: 'Items', group: 'Catalogue', description: 'Products, barcodes, prices and stock.', path: '/items', permission: 'open_items', accent: '#16a34a', icon: PackageSearch },
        { title: 'Categories', group: 'Catalogue', description: 'Organise products for faster selling.', path: '/categories', permission: 'open_items', accent: '#16a34a', icon: LayoutGrid },
        { title: 'Design Studio', group: 'POS layout', description: 'Arrange till pages and product tiles.', path: '/design', permission: 'open_design', accent: '#0891b2', icon: PanelsTopLeft },
        { title: 'Discounts', group: 'Promotions', description: 'Offers, bundles and manual discounts.', path: '/discounts', permission: 'open_discounts', accent: '#db2777', icon: BadgePercent },
        { title: 'Customers', group: 'Customers', description: 'Loyalty balances and contact details.', path: '/customers', permission: 'open_customers', accent: '#4f46e5', icon: ContactRound },
        { title: 'Orders', group: 'Sales', description: 'Receipts, payments, returns and reprints.', path: '/orders', permission: 'open_reports', accent: '#2563eb', icon: ReceiptText },
        { title: 'Reports', group: 'Sales', description: 'Sales performance, close and till totals.', path: '/reports', permission: 'open_reports', alternativePermission: 'end_day_close', accent: '#2563eb', icon: ChartNoAxesCombined },
        { title: 'Till Sessions', group: 'Sales', description: 'Open sessions and cash-up history.', path: '/shifts', permission: 'open_reports', accent: '#2563eb', icon: CalendarClock },
        { title: 'Stock Receiving', group: 'Stock', description: 'Receive deliveries and update quantities.', path: '/stock-receiving', permission: 'open_stock_receiving', accent: '#d97706', icon: PackagePlus },
        { title: 'Suppliers', group: 'Stock', description: 'Supplier details for stock receiving.', path: '/suppliers', permission: 'open_items', accent: '#d97706', icon: Truck },
        { title: 'Employees', group: 'Staff', description: 'Staff, PINs, roles and permissions.', path: '/employees', permission: 'open_employees', accent: '#7c3aed', icon: UsersRound },
        { title: 'Tax Rates', group: 'Business', description: 'VAT rates and tax configuration.', path: '/tax-rates', permission: 'open_items', accent: '#ca8a04', icon: Percent },
        { title: 'Sync Dashboard', group: 'System', description: 'Till connections and database sync.', path: '/sync', permission: 'open_sync', accent: '#0f766e', icon: RefreshCcw },
        { title: 'Audit Log', group: 'System', description: 'Review important staff and data changes.', path: '/audit', permission: 'open_audit', accent: '#0f766e', icon: ClipboardList },
        { title: 'Settings', group: 'System', description: 'Printers, payments, devices and appearance.', path: '/settings', permission: 'open_settings', accent: '#0f766e', icon: SettingsIcon },
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

<div class="admin-page">
    <header class="admin-header">
        <PageBackButton fallback="/" ariaLabel="Back to POS" title="Back to POS" />
        <div class="admin-title">
            <img class="admin-brand-logo" src="/lbj-pos-logo.png" alt="" />
            <div>
                <span>L&amp;Bj POS</span>
                <h1>Admin</h1>
            </div>
        </div>
        <div class="admin-user" aria-label="Signed in staff">
            <span class="admin-user-avatar" aria-hidden="true">{employeeInitials}</span>
            <div>
                <span>Signed in</span>
                <strong>{employeeName}</strong>
                <small>{employeeRole ? employeeRole.toUpperCase() : 'NO ROLE'}</small>
            </div>
        </div>
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
            <button
                type="button"
                class="admin-header-btn danger"
                title="Log out"
                aria-label="Log out"
                on:click={signOut}
            >
                <LogOut size={22} strokeWidth={2.35} />
            </button>
        </div>
    </header>

    <main class="admin-grid" aria-label="Admin navigation">
        {#each adminViewEntries as entry}
            <button
                type="button"
                class="admin-tile"
                class:locked={!entry.allowed}
                style="--tile-accent: {entry.accent}"
                aria-disabled={!entry.allowed}
                title={entry.allowed ? entry.description : `Permission required: ${entry.lockedLabel}`}
                aria-label={`${entry.title}. ${entry.description}`}
                on:click={() => openEntry(entry)}
            >
                <span class="admin-tile-mark" aria-hidden="true"></span>
                <span class="admin-tile-topline">
                    <span class="admin-tile-icon" aria-hidden="true">
                        <svelte:component this={entry.icon} size={28} strokeWidth={2.25} />
                    </span>
                    <span class="admin-tile-group">{entry.group}</span>
                </span>
                <span class="admin-tile-text">
                    <strong>{entry.title}</strong>
                    <span class="admin-tile-description">{entry.description}</span>
                </span>
                <span class="admin-tile-status" aria-hidden="true">
                    {#if entry.allowed}
                        <ChevronRight size={18} strokeWidth={2.5} />
                    {:else}
                        <LockKeyhole size={17} strokeWidth={2.5} />
                    {/if}
                </span>
            </button>
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
        gap: 0.75rem;
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

    .admin-header-btn:hover:not(:disabled) {
        background: var(--bg-card-hover);
        border-color: var(--accent-primary);
    }

    .admin-header-btn:focus-visible,
    .admin-tile:focus-visible {
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
    .admin-tile-group {
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

    .admin-grid {
        flex: 1;
        width: 100%;
        min-height: 0;
        align-self: center;
        display: grid;
        grid-template-columns: repeat(5, minmax(0, 1fr));
        grid-template-rows: repeat(3, clamp(132px, 23vh, 178px));
        gap: 0.65rem;
        align-content: center;
    }

    .admin-tile {
        position: relative;
        contain: layout paint;
        min-width: 0;
        min-height: 0;
        height: 100%;
        overflow: hidden;
        border: 1px solid var(--border-flat);
        border-radius: 0.45rem;
        background: var(--bg-card);
        color: var(--text-main);
        padding: 0.8rem;
        text-align: left;
        display: flex;
        flex-direction: column;
        align-items: stretch;
        justify-content: flex-start;
        gap: 0.65rem;
        transition: none;
    }

    .admin-tile:hover:not(.locked) {
        background: var(--bg-card-hover);
        border-color: var(--tile-accent);
    }

    .admin-tile.locked {
        cursor: not-allowed;
        opacity: 0.58;
    }

    .admin-tile-mark {
        position: absolute;
        inset: 0 0 auto;
        height: 0.26rem;
        background: var(--tile-accent);
    }

    .admin-tile-topline {
        min-width: 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.55rem;
    }

    .admin-tile-icon {
        width: 46px;
        height: 46px;
        border-radius: 0.45rem;
        background: var(--bg-panel);
        border: 1px solid var(--border-flat);
        color: var(--tile-accent);
        display: flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 auto;
    }

    .admin-tile-text {
        min-width: 0;
        width: 100%;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 0.35rem;
    }

    .admin-tile strong {
        display: -webkit-box;
        min-width: 0;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        line-clamp: 2;
        font-size: 1.08rem;
        line-height: 1.12;
        letter-spacing: 0;
        overflow-wrap: anywhere;
    }

    .admin-tile-group {
        min-width: 0;
        max-width: calc(100% - 54px);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 0.68rem;
        line-height: 1;
        color: var(--tile-accent);
    }

    .admin-tile-description {
        display: -webkit-box;
        overflow: hidden;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        line-clamp: 2;
        color: var(--text-muted);
        font-size: 0.76rem;
        font-weight: 650;
        line-height: 1.28;
        letter-spacing: 0;
        overflow-wrap: anywhere;
    }

    .admin-tile-status {
        position: absolute;
        right: 0.65rem;
        bottom: 0.55rem;
        display: flex;
        color: var(--tile-accent);
    }

    .admin-tile.locked .admin-tile-status {
        color: var(--text-muted);
    }

    @media (max-width: 1100px) {
        .admin-page,
        .admin-grid {
            gap: 0.5rem;
        }

        .admin-tile {
            padding: 0.65rem;
            gap: 0.45rem;
        }

        .admin-tile-icon {
            width: 42px;
            height: 42px;
        }

        .admin-tile strong {
            font-size: 0.98rem;
        }

        .admin-tile-description {
            font-size: 0.7rem;
        }
    }

    @media (min-width: 701px) and (max-height: 680px) {
        .admin-page {
            gap: 0.5rem;
        }

        .admin-header-btn {
            width: 42px;
            height: 42px;
        }

        .admin-title span,
        .admin-user span,
        .admin-tile-group {
            font-size: 0.62rem;
        }

        .admin-tile-group {
            font-size: 0.6rem;
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

        .admin-tile {
            padding: 0.55rem;
            gap: 0.38rem;
        }

        .admin-tile-icon {
            width: 38px;
            height: 38px;
        }

        .admin-tile strong {
            font-size: 0.92rem;
        }

        .admin-tile-description {
            font-size: 0.66rem;
            line-height: 1.2;
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

        .admin-user {
            display: none;
        }

        .admin-grid {
            flex: none;
            width: 100%;
            grid-template-columns: repeat(3, minmax(0, 1fr));
            grid-template-rows: none;
            grid-auto-rows: minmax(150px, auto);
            overflow: visible;
        }
    }

    @media (max-width: 440px) {
        .admin-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
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
</style>
