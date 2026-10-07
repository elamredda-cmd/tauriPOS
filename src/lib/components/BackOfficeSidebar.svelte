<script lang="ts">
    import { goto } from '$app/navigation';
    import { page } from '$app/stores';
    import {
        ChartNoAxesCombined,
        ClipboardList,
        Clock3,
        ContactRound,
        LayoutDashboard,
        LogOut,
        PackagePlus,
        PackageSearch,
        ReceiptText,
        Settings,
        UsersRound,
    } from '@lucide/svelte';
    import { canAccessPath } from '$lib/permissions';
    import ConnectionStatusPill from '$lib/components/ConnectionStatusPill.svelte';
    import { settingsDB } from '$lib/stores/db';
    import { currentEmployee, logout } from '$lib/stores/session';

    type SidebarLink = {
        label: string;
        path: string;
        icon: typeof LayoutDashboard;
    };

    type SidebarGroup = {
        label: string;
        links: SidebarLink[];
    };

    const groups: SidebarGroup[] = [
        {
            label: 'Workspace',
            links: [
                { label: 'Overview', path: '/admin', icon: LayoutDashboard },
                { label: 'Items', path: '/items', icon: PackageSearch },
                { label: 'Customers', path: '/customers', icon: ContactRound },
                { label: 'Orders', path: '/orders', icon: ReceiptText },
                { label: 'Reports', path: '/reports', icon: ChartNoAxesCombined },
            ],
        },
        {
            label: 'Operations',
            links: [
                { label: 'Stock receiving', path: '/stock-receiving', icon: PackagePlus },
                { label: 'Staff', path: '/employees', icon: UsersRound },
                { label: 'Attendance', path: '/attendance', icon: Clock3 },
                { label: 'Audit log', path: '/audit', icon: ClipboardList },
                { label: 'Settings', path: '/settings', icon: Settings },
            ],
        },
    ];

    $: employeeName = $currentEmployee?.name || 'Signed out';
    $: employeeRole = $currentEmployee?.isSupportSession ? 'Support access' : $currentEmployee?.role || '';
    $: employeeInitials = employeeName
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase())
        .join('') || 'BO';
    $: visibleGroups = groups
        .map((group) => ({
            ...group,
            links: group.links.filter((link) => canAccessPath($currentEmployee, link.path, $settingsDB)),
        }))
        .filter((group) => group.links.length > 0);

    function isActive(path: string): boolean {
        const pathname = $page.url.pathname;
        if (path === '/admin') return pathname === path;
        return pathname === path || pathname.startsWith(`${path}/`);
    }

    async function signOut() {
        logout();
        await goto('/');
    }
</script>

<aside class="back-office-sidebar" aria-label="Back Office navigation">
    <a class="back-office-brand" href="/admin" aria-label="Back Office overview">
        <img src="/lbj-pos-logo.png" alt="" />
        <span>
            <small>L&amp;Bj POS</small>
            <strong>Back Office</strong>
        </span>
    </a>

    <nav class="back-office-nav" aria-label="Management tools">
        {#each visibleGroups as group (group.label)}
            <section class="back-office-nav-group" aria-labelledby={`back-office-nav-${group.label.toLowerCase().replace(/\s+/g, '-')}`}>
                <h2 id={`back-office-nav-${group.label.toLowerCase().replace(/\s+/g, '-')}`}>{group.label}</h2>
                <div>
                    {#each group.links as link (link.path)}
                        <a
                            href={link.path}
                            class="back-office-nav-link"
                            class:active={isActive(link.path)}
                            aria-current={isActive(link.path) ? 'page' : undefined}
                            title={link.label}
                        >
                            <svelte:component this={link.icon} size={19} strokeWidth={2.2} aria-hidden="true" />
                            <span>{link.label}</span>
                        </a>
                    {/each}
                </div>
            </section>
        {/each}
    </nav>

    <footer class="back-office-footer">
        <div class="back-office-status">
            <ConnectionStatusPill placement="sidebar" />
        </div>
        <div class="back-office-user">
            <span class="back-office-user-avatar" aria-hidden="true">{employeeInitials}</span>
            <span class="back-office-user-copy">
                <strong title={employeeName}>{employeeName}</strong>
                <small>{employeeRole || 'Staff'}</small>
            </span>
            <button type="button" on:click={signOut} aria-label="Sign out" title="Sign out">
                <LogOut size={18} strokeWidth={2.3} aria-hidden="true" />
            </button>
        </div>
    </footer>
</aside>

<style>
    .back-office-sidebar {
        width: 196px;
        min-width: 0;
        height: 100dvh;
        overflow: hidden;
        display: grid;
        grid-template-rows: 72px minmax(0, 1fr) auto;
        border-right: 1px solid var(--border-flat);
        background: var(--bg-panel);
        color: var(--text-main);
    }

    .back-office-brand {
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 0.65rem;
        padding: 0.75rem;
        border-bottom: 1px solid var(--border-flat);
        color: var(--text-main);
        text-decoration: none;
    }

    .back-office-brand img {
        width: 42px;
        height: 42px;
        flex: 0 0 auto;
        border-radius: 0.4rem;
        object-fit: contain;
    }

    .back-office-brand span,
    .back-office-user-copy {
        min-width: 0;
        display: flex;
        flex-direction: column;
    }

    .back-office-brand small,
    .back-office-nav-group h2,
    .back-office-user-copy small {
        color: var(--text-muted);
        font-size: 0.64rem;
        font-weight: 850;
        line-height: 1.15;
        text-transform: uppercase;
    }

    .back-office-brand strong {
        margin-top: 0.12rem;
        overflow: hidden;
        font-size: 0.93rem;
        line-height: 1.1;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .back-office-nav {
        min-height: 0;
        overflow-x: hidden;
        overflow-y: auto;
        padding: 0.75rem 0.6rem;
        scrollbar-width: thin;
    }

    .back-office-nav-group + .back-office-nav-group {
        margin-top: 0.85rem;
    }

    .back-office-nav-group h2 {
        margin: 0 0 0.35rem;
        padding: 0 0.55rem;
    }

    .back-office-nav-group > div {
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
    }

    .back-office-nav-link {
        min-width: 0;
        min-height: 38px;
        display: grid;
        grid-template-columns: 22px minmax(0, 1fr);
        align-items: center;
        gap: 0.45rem;
        padding: 0.42rem 0.55rem;
        border: 1px solid transparent;
        border-radius: 0.38rem;
        color: var(--text-muted);
        font-size: 0.8rem;
        font-weight: 750;
        line-height: 1.1;
        text-decoration: none;
    }

    .back-office-nav-link span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .back-office-nav-link:hover {
        border-color: var(--border-flat);
        background: var(--bg-card-hover);
        color: var(--text-main);
    }

    .back-office-nav-link.active {
        border-color: color-mix(in srgb, var(--accent-primary) 45%, var(--border-flat));
        background: color-mix(in srgb, var(--accent-primary) 12%, var(--bg-card));
        color: var(--accent-primary);
    }

    .back-office-nav-link:focus-visible,
    .back-office-brand:focus-visible,
    .back-office-user button:focus-visible {
        outline: 3px solid var(--accent-primary);
        outline-offset: -3px;
    }

    .back-office-user {
        min-width: 0;
        display: grid;
        grid-template-columns: 32px minmax(0, 1fr) 34px;
        align-items: center;
        gap: 0.5rem;
        padding: 0.65rem;
        border-top: 1px solid var(--border-flat);
        background: var(--bg-card);
    }

    .back-office-footer {
        min-width: 0;
    }

    .back-office-status {
        min-width: 0;
        display: flex;
        justify-content: center;
        padding: .5rem .65rem;
        border-top: 1px solid var(--border-flat);
    }

    .back-office-user-avatar {
        width: 32px;
        height: 32px;
        display: grid;
        place-items: center;
        border-radius: 0.38rem;
        background: var(--accent-primary);
        color: white;
        font-size: 0.72rem;
        font-weight: 900;
    }

    .back-office-user-copy strong {
        overflow: hidden;
        font-size: 0.76rem;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .back-office-user-copy small {
        margin-top: 0.14rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .back-office-user button {
        width: 34px;
        height: 34px;
        padding: 0;
        display: grid;
        place-items: center;
        border: 1px solid var(--border-flat);
        border-radius: 0.38rem;
        background: var(--bg-panel);
        color: var(--danger);
    }

    .back-office-user button:hover {
        border-color: var(--danger);
        background: var(--danger);
        color: white;
    }

    @media (max-width: 900px) {
        .back-office-sidebar {
            width: 176px;
            grid-template-rows: 64px minmax(0, 1fr) auto;
        }

        .back-office-brand {
            padding: 0.6rem;
            gap: 0.5rem;
        }

        .back-office-brand img {
            width: 38px;
            height: 38px;
        }

        .back-office-nav {
            padding: 0.55rem 0.5rem;
        }

        .back-office-nav-group + .back-office-nav-group {
            margin-top: 0.65rem;
        }

        .back-office-nav-link {
            min-height: 36px;
            padding: 0.35rem 0.45rem;
        }

        .back-office-user {
            grid-template-columns: 30px minmax(0, 1fr) 32px;
            gap: 0.4rem;
            padding: 0.5rem;
        }

        .back-office-user button {
            width: 32px;
            height: 32px;
        }
    }
    @media (max-width: 1100px) and (min-width: 601px) {
        .back-office-sidebar { width: 88px; grid-template-rows: 64px minmax(0, 1fr) auto; }
        .back-office-brand { justify-content: center; padding: .5rem; }
        .back-office-brand span, .back-office-nav-group h2, .back-office-user-avatar { display: none; }
        .back-office-nav { padding: .4rem; }
        .back-office-nav-group + .back-office-nav-group { margin-top: .4rem; padding-top: .4rem; border-top: 1px solid var(--border-flat); }
        .back-office-nav-link { min-height: 62px; display: flex; flex-direction: column; justify-content: center; gap: .35rem; padding: .45rem .2rem; font-size: .66rem; line-height: 1.2; text-align: center; }
        .back-office-nav-link span { white-space: normal; overflow: visible; }
        .back-office-status { padding: .4rem; }
        .back-office-user { grid-template-columns: minmax(0, 1fr) 32px; gap: .25rem; padding: .4rem .3rem; }
        .back-office-user-copy strong { font-size: .7rem; }
        .back-office-user-copy small { display: none; }
        .back-office-user button { width: 32px; height: 32px; }
    }
    @media (max-width: 600px) {
        .back-office-sidebar { width: 100%; height: 76px; display: flex; border-right: 0; border-bottom: 1px solid var(--border-flat); }
        .back-office-brand, .back-office-nav-group h2, .back-office-user-avatar { display: none; }
        .back-office-nav { min-width: 0; flex: 1; display: flex; overflow-x: auto; padding: .3rem; gap: .3rem; }
        .back-office-nav-group, .back-office-nav-group > div { display: contents; }
        .back-office-nav-link { min-width: 80px; min-height: 60px; display: flex; flex-direction: column; justify-content: center; gap: .3rem; padding: .35rem; font-size: .66rem; line-height: 1.2; text-align: center; }
        .back-office-nav-link span { white-space: normal; }
        .back-office-footer { flex: 0 0 116px; display: flex; flex-direction: column; justify-content: center; border-left: 1px solid var(--border-flat); }
        .back-office-status { padding: .2rem .3rem; border-top: 0; }
        .back-office-user { grid-template-columns: minmax(0, 1fr) 32px; gap: .25rem; padding: .2rem .3rem; border-top: 0; }
        .back-office-user-copy strong { font-size: .7rem; }
        .back-office-user-copy small { display: none; }
        .back-office-user button { width: 32px; height: 32px; }
    }
</style>
