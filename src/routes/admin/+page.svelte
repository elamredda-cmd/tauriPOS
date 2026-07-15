<script lang="ts">
    import { goto } from '$app/navigation';
    import { getCurrentWindow } from '@tauri-apps/api/window';
    import { onMount } from 'svelte';
    import { settingsDB } from '$lib/stores/db';
    import { currentEmployee, logout } from '$lib/stores/session';
    import { toast } from '$lib/stores/toast';
    import { parseRolePermissions, permissionLabels, type PermissionKey } from '$lib/permissions';
    import PageBackButton from '$lib/components/PageBackButton.svelte';

    type AdminEntry = {
        title: string;
        group: string;
        description: string;
        path: string;
        permission?: PermissionKey;
        alternativePermission?: PermissionKey;
        accent: string;
        icon:
            | 'design'
            | 'items'
            | 'categories'
            | 'customers'
            | 'employees'
            | 'suppliers'
            | 'discounts'
            | 'tax'
            | 'orders'
            | 'shifts'
            | 'stock'
            | 'reports'
            | 'sync'
            | 'audit'
            | 'settings'
            | 'about';
    };

    type AdminViewEntry = AdminEntry & {
        allowed: boolean;
        lockedLabel: string;
    };

    const adminEntries: AdminEntry[] = [
        { title: 'Design Studio', group: 'POS layout', description: 'Edit till pages and selling layout.', path: '/design', permission: 'open_design', accent: '#0ea5e9', icon: 'design' },
        { title: 'Items', group: 'Catalogue', description: 'Products, PLU, barcode, stock setup.', path: '/items', permission: 'open_items', accent: '#22c55e', icon: 'items' },
        { title: 'Categories', group: 'Catalogue', description: 'Group products for faster selling.', path: '/categories', permission: 'open_items', accent: '#14b8a6', icon: 'categories' },
        { title: 'Customers', group: 'Catalogue', description: 'Loyalty customers and contact details.', path: '/customers', permission: 'open_items', accent: '#6366f1', icon: 'customers' },
        { title: 'Employees', group: 'Staff', description: 'Staff, PINs, roles, and access.', path: '/employees', permission: 'open_employees', accent: '#a855f7', icon: 'employees' },
        { title: 'Suppliers', group: 'Stock', description: 'Supplier records for receiving stock.', path: '/suppliers', permission: 'open_items', accent: '#f59e0b', icon: 'suppliers' },
        { title: 'Discounts', group: 'Promotions', description: 'Offers, bundles, and manual discounts.', path: '/discounts', permission: 'open_discounts', accent: '#ec4899', icon: 'discounts' },
        { title: 'Tax Rates', group: 'Catalogue', description: 'VAT and tax configuration.', path: '/tax-rates', permission: 'open_items', accent: '#64748b', icon: 'tax' },
        { title: 'Orders', group: 'Sales', description: 'Receipts, returns, and past orders.', path: '/orders', permission: 'open_reports', accent: '#3b82f6', icon: 'orders' },
        { title: 'Till Sessions', group: 'Till', description: 'Open sessions and cash-up history.', path: '/shifts', permission: 'open_reports', accent: '#10b981', icon: 'shifts' },
        { title: 'Stock Receiving', group: 'Stock', description: 'Receive stock and update quantities.', path: '/stock-receiving', permission: 'open_stock_receiving', accent: '#f97316', icon: 'stock' },
        { title: 'Reports', group: 'Sales', description: 'Sales, close reports, and totals.', path: '/reports', permission: 'open_reports', alternativePermission: 'end_day_close', accent: '#06b6d4', icon: 'reports' },
        { title: 'Sync Dashboard', group: 'System', description: 'Database sync and connection status.', path: '/sync', permission: 'open_sync', accent: '#8b5cf6', icon: 'sync' },
        { title: 'Audit Log', group: 'System', description: 'Review key changes and staff actions.', path: '/audit', permission: 'open_audit', accent: '#ef4444', icon: 'audit' },
        { title: 'Settings', group: 'System', description: 'Printers, receipt, labels, and devices.', path: '/settings', permission: 'open_settings', accent: '#0f766e', icon: 'settings' },
        { title: 'About', group: 'L&Bj POS', description: 'Application details and contact information.', path: '/about', accent: '#2563eb', icon: 'about' },
    ];

    let isFullscreen = false;
    let fullscreenBusy = false;

    $: employeeName = $currentEmployee?.name || 'Signed out';
    $: employeeRole = $currentEmployee?.role || '';
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
            <button type="button" class="admin-header-btn" disabled={fullscreenBusy} on:click={toggleFullscreen}>
                {isFullscreen ? 'Exit Full Screen' : 'Full Screen'}
            </button>
            <button type="button" class="admin-header-btn danger" on:click={signOut}>Logout</button>
        </div>
    </header>

    <main class="admin-grid" aria-label="Admin navigation">
        {#each adminViewEntries as entry}
            <button
                type="button"
                class="admin-tile"
                class:locked={!entry.allowed}
                style="--tile-accent: {entry.accent}"
                disabled={!entry.allowed}
                title={entry.description}
                aria-label={`${entry.title}. ${entry.description}`}
                on:click={() => openEntry(entry)}
            >
                <span class="admin-tile-mark" aria-hidden="true"></span>
                <span class="admin-tile-icon" aria-hidden="true">
                    <svg class="admin-tile-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.35" stroke-linecap="round" stroke-linejoin="round">
                        {#if entry.icon === 'design'}
                            <rect x="3" y="4" width="18" height="13" rx="2"></rect>
                            <path d="M8 21h8"></path>
                            <path d="M12 17v4"></path>
                            <path d="M7 12l3-3 3 3 4-5"></path>
                        {:else if entry.icon === 'items'}
                            <path d="M20 12l-8 8-8-8V4h8l8 8z"></path>
                            <circle cx="8" cy="8" r="1.3"></circle>
                            <path d="M10.5 13.5h5"></path>
                        {:else if entry.icon === 'categories'}
                            <rect x="4" y="4" width="7" height="7" rx="1.4"></rect>
                            <rect x="13" y="4" width="7" height="7" rx="1.4"></rect>
                            <rect x="4" y="13" width="7" height="7" rx="1.4"></rect>
                            <path d="M15 16.5h4"></path>
                            <path d="M17 14.5v4"></path>
                        {:else if entry.icon === 'customers'}
                            <rect x="3" y="5" width="18" height="14" rx="2"></rect>
                            <circle cx="9" cy="11" r="2.5"></circle>
                            <path d="M6 17c.7-2 2-3 3-3s2.3 1 3 3"></path>
                            <path d="M14 10h4"></path>
                            <path d="M14 14h3"></path>
                        {:else if entry.icon === 'employees'}
                            <path d="M12 3l7 3v5c0 4.5-2.8 8-7 10-4.2-2-7-5.5-7-10V6l7-3z"></path>
                            <circle cx="12" cy="10" r="2.3"></circle>
                            <path d="M8.8 16c.8-1.7 2-2.5 3.2-2.5s2.4.8 3.2 2.5"></path>
                        {:else if entry.icon === 'suppliers'}
                            <path d="M3 8h10v8H3z"></path>
                            <path d="M13 11h4l4 4v1h-8"></path>
                            <path d="M5 19a2 2 0 1 0 4 0"></path>
                            <path d="M16 19a2 2 0 1 0 4 0"></path>
                            <path d="M6 5h4"></path>
                        {:else if entry.icon === 'discounts'}
                            <path d="M4 7h16v10H4z"></path>
                            <path d="M8 9.5h.01"></path>
                            <path d="M16 14.5h.01"></path>
                            <path d="M9 15l6-6"></path>
                            <path d="M4 11a2 2 0 0 0 0 4"></path>
                            <path d="M20 11a2 2 0 0 1 0 4"></path>
                        {:else if entry.icon === 'tax'}
                            <circle cx="12" cy="12" r="8"></circle>
                            <path d="M8.5 15.5l7-7"></path>
                            <circle cx="9" cy="9" r="1.2"></circle>
                            <circle cx="15" cy="15" r="1.2"></circle>
                        {:else if entry.icon === 'orders'}
                            <path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3z"></path>
                            <path d="M9 8h6"></path>
                            <path d="M9 12h6"></path>
                            <path d="M9 16h3"></path>
                        {:else if entry.icon === 'shifts'}
                            <rect x="4" y="5" width="16" height="15" rx="2"></rect>
                            <path d="M8 3v4"></path>
                            <path d="M16 3v4"></path>
                            <path d="M4 10h16"></path>
                            <path d="M12 13v3l2 1"></path>
                        {:else if entry.icon === 'stock'}
                            <path d="M4 9l8-5 8 5-8 5-8-5z"></path>
                            <path d="M6 12v5l6 3 6-3v-5"></path>
                            <path d="M12 14v6"></path>
                            <path d="M9 7l8 5"></path>
                        {:else if entry.icon === 'reports'}
                            <path d="M4 19V5"></path>
                            <path d="M4 19h16"></path>
                            <path d="M8 16v-4"></path>
                            <path d="M12 16V8"></path>
                            <path d="M16 16v-7"></path>
                            <path d="M7 7l3 2 3-4 4 2"></path>
                        {:else if entry.icon === 'sync'}
                            <path d="M7 18h10a4 4 0 0 0 .5-8 5.5 5.5 0 0 0-10.7-1.7A4.5 4.5 0 0 0 7 18z"></path>
                            <path d="M9 13l3-3 3 3"></path>
                            <path d="M12 10v7"></path>
                        {:else if entry.icon === 'audit'}
                            <path d="M8 4h8l2 3v13H6V7l2-3z"></path>
                            <path d="M9 4v4h6V4"></path>
                            <path d="M9 13h6"></path>
                            <path d="M9 17h4"></path>
                            <path d="M16 6h2"></path>
                        {:else if entry.icon === 'settings'}
                            <path d="M5 6h14"></path>
                            <path d="M5 12h14"></path>
                            <path d="M5 18h14"></path>
                            <circle cx="9" cy="6" r="2"></circle>
                            <circle cx="15" cy="12" r="2"></circle>
                            <circle cx="11" cy="18" r="2"></circle>
                        {:else if entry.icon === 'about'}
                            <circle cx="12" cy="12" r="9"></circle>
                            <path d="M12 11v6"></path>
                            <path d="M12 7h.01"></path>
                        {/if}
                    </svg>
                </span>
                <span class="admin-tile-text">
                    <strong>{entry.title}</strong>
                    <span class="admin-tile-group">{entry.group}</span>
                </span>
            </button>
        {/each}
    </main>
</div>

<style>
    .admin-page {
        height: 100vh;
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
        grid-template-columns: auto minmax(0, 1fr) auto auto;
        align-items: center;
        gap: 0.5rem;
        min-height: 56px;
    }

    .admin-header-btn {
        height: 46px;
        border-radius: 0.45rem;
        border: 1px solid var(--border-flat);
        background: var(--bg-card);
        color: var(--text-main);
        font-weight: 900;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
        padding: 0 0.9rem;
        transition: none;
    }

    .admin-header-btn:hover {
        background: var(--bg-card-hover);
        border-color: var(--accent-primary);
        transform: none;
    }

    .admin-title {
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 0.6rem;
    }

    .admin-brand-logo {
        width: 46px;
        height: 46px;
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
        letter-spacing: 0.12em;
        text-transform: uppercase;
    }

    .admin-title h1 {
        margin: 0;
        font-size: 1.85rem;
        line-height: 1;
        letter-spacing: 0;
    }

    .admin-header-actions {
        display: grid;
        grid-template-columns: repeat(2, minmax(132px, 1fr));
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
        min-height: 46px;
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
        letter-spacing: 0.08em;
    }

    .admin-grid {
        flex: 1;
        min-height: 0;
        display: grid;
        grid-template-columns: repeat(5, minmax(0, 1fr));
        grid-template-rows: repeat(4, minmax(0, 1fr));
        gap: 0.5rem;
        align-content: stretch;
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
        padding: 0.55rem;
        text-align: center;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 0.28rem;
        transition: none;
    }

    .admin-tile:hover:not(:disabled) {
        background: var(--bg-card-hover);
        border-color: var(--tile-accent);
        transform: none;
    }

    .admin-tile:disabled {
        cursor: not-allowed;
        opacity: 0.48;
    }

    .admin-tile-mark {
        position: absolute;
        inset: 0 auto 0 0;
        width: 0.28rem;
        background: var(--tile-accent);
    }

    .admin-tile-icon {
        width: 44px;
        height: 44px;
        border-radius: 0.45rem;
        background: var(--bg-panel);
        border: 1px solid var(--border-flat);
        color: var(--tile-accent);
        display: flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 auto;
    }

    .admin-tile-svg {
        width: 26px;
        height: 26px;
    }

    .admin-tile-text {
        min-width: 0;
        width: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.18rem;
    }

    .admin-tile strong {
        display: -webkit-box;
        min-width: 0;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        font-size: 1.05rem;
        line-height: 1.08;
        letter-spacing: 0;
        overflow-wrap: anywhere;
    }

    .admin-tile-group {
        font-size: 0.78rem;
        line-height: 1;
    }

    @media (max-width: 1100px) {
        .admin-page {
            gap: 0.5rem;
        }

        .admin-grid {
            grid-template-columns: repeat(5, minmax(0, 1fr));
            grid-template-rows: repeat(4, minmax(0, 1fr));
            gap: 0.5rem;
        }

        .admin-tile {
            gap: 0.25rem;
            padding: 0.4rem;
        }

        .admin-tile-icon {
            width: 40px;
            height: 40px;
        }

        .admin-tile-svg {
            width: 24px;
            height: 24px;
        }

        .admin-tile strong {
            font-size: 0.98rem;
        }

        .admin-tile-group {
            font-size: 0.72rem;
        }
    }

    @media (min-width: 821px) and (max-height: 680px) {
        .admin-header {
            min-height: 48px;
        }

        .admin-header-btn {
            height: 42px;
            padding: 0 0.7rem;
        }

        .admin-title span,
        .admin-user span,
        .admin-tile-group {
            font-size: 0.64rem;
        }

        .admin-title h1 {
            font-size: 1.55rem;
        }

        .admin-brand-logo {
            width: 40px;
            height: 40px;
        }

        .admin-header-actions {
            grid-template-columns: repeat(2, minmax(112px, 1fr));
            gap: 0.5rem;
        }

        .admin-user {
            min-height: 42px;
            padding: 0.25rem 0.55rem;
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
            padding: 0.35rem;
            gap: 0.18rem;
        }

        .admin-tile-icon {
            width: 34px;
            height: 34px;
        }

        .admin-tile-svg {
            width: 20px;
            height: 20px;
        }

        .admin-tile strong {
            font-size: 0.9rem;
        }

        .admin-tile-group {
            font-size: 0.64rem;
        }
    }

    @media (max-width: 820px) {
        .admin-page {
            overflow-y: auto;
        }

        .admin-header {
            grid-template-columns: minmax(0, 1fr);
        }

        .admin-header-actions {
            grid-template-columns: repeat(2, minmax(0, 1fr));
        }

        .admin-grid {
            grid-template-columns: repeat(auto-fill, minmax(94px, 1fr));
            grid-template-rows: none;
            grid-auto-rows: auto;
            gap: 0.5rem;
            overflow: visible;
        }

        .admin-tile {
            aspect-ratio: 1 / 1;
        }

    }
</style>
