<script lang="ts">
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
    import { settingsDB, now, type Employee } from '$lib/stores/db';
    import { upsert } from '$lib/stores/database';
    import { toast } from '$lib/stores/toast';
    import {
        defaultRolePermissions,
        employeeRoles,
        parseRolePermissions,
        permissionLabels,
        roleDescriptions,
        roleLabels,
        serializeRolePermissions,
        type PermissionKey,
        type RolePermissionMatrix,
    } from '$lib/permissions';

    const pagePermissions: PermissionKey[] = [
        'open_items', 'open_customers', 'open_discounts', 'open_reports', 'open_settings',
        'open_employees', 'open_design', 'open_sync', 'open_audit', 'open_stock_receiving',
    ];
    const actionPermissions: PermissionKey[] = [
        'price_override', 'refund_void', 'manual_discount', 'open_cash_drawer', 'end_day_close',
    ];
    const permissionKeys = [...pagePermissions, ...actionPermissions];
    const permissionDescriptions: Record<PermissionKey, string> = {
        open_items: 'Products, categories, suppliers, and tax rates',
        open_customers: 'Customer profiles, contact details, and loyalty balances',
        open_discounts: 'Promotions, bundles, offers, and discounts',
        open_reports: 'Orders, sales reports, and previous till sessions',
        open_settings: 'Till appearance, printers, labels, scale, and integrations',
        open_employees: 'Staff accounts, PINs, status, and assigned roles',
        open_design: 'POS tile layout, pages, and scale button design',
        open_sync: 'MariaDB connection, till status, and synchronization tools',
        open_audit: 'Recorded staff and system activity',
        open_stock_receiving: 'Supplier deliveries and stock quantity updates',
        price_override: 'Change a selling price during checkout',
        refund_void: 'Refund an order or void a completed sale',
        manual_discount: 'Apply a non-automatic discount at checkout',
        open_cash_drawer: 'Open the cash drawer manually from the checkout screen',
        end_day_close: 'Open the restricted close-period screen and create a Z report without access to detailed sales reports',
    };

    let selectedRole: Employee['role'] = 'manager';
    let saving = false;
    let showResetConfirm = false;

    $: matrix = parseRolePermissions($settingsDB);
    $: selectedPermissions = matrix[selectedRole] || [];
    $: enabledCount = selectedPermissions.length;

    async function persistMatrix(next: RolePermissionMatrix, successMessage = '') {
        if (saving) return;
        saving = true;
        const setting = {
            key: 'role_permissions',
            value: serializeRolePermissions(next),
            updatedAt: now(),
        };

        try {
            await upsert('settings', setting, 'key');
            settingsDB.update((list) => {
                const index = list.findIndex((row) => row.key === setting.key);
                if (index < 0) return [...list, setting];
                return list.map((row, rowIndex) => rowIndex === index ? setting : row);
            });
            if (successMessage) toast(successMessage);
        } catch (error) {
            console.error('Could not save role permissions:', error);
            toast(`Could not save role permissions: ${String(error).replace(/^Error:\s*/, '')}`, 'error');
        } finally {
            saving = false;
        }
    }

    function toggle(role: Employee['role'], key: PermissionKey) {
        if (role === 'admin' || saving) return;
        const next: RolePermissionMatrix = {
            admin: [...matrix.admin],
            manager: [...matrix.manager],
            supervisor: [...matrix.supervisor],
            cashier: [...matrix.cashier],
        };
        const enabled = new Set(next[role]);
        if (enabled.has(key)) enabled.delete(key);
        else enabled.add(key);
        next[role] = permissionKeys.filter((permission) => enabled.has(permission));
        void persistMatrix(next);
    }

    function resetDefaults() {
        void persistMatrix({
            admin: [...defaultRolePermissions.admin],
            manager: [...defaultRolePermissions.manager],
            supervisor: [...defaultRolePermissions.supervisor],
            cashier: [...defaultRolePermissions.cashier],
        }, 'Role permissions reset to defaults');
    }
</script>

<MgmtPage title="Role Permissions" backFallback="/employees">
    <button
        slot="actions"
        class="btn btn-secondary"
        disabled={saving}
        on:click={() => showResetConfirm = true}
    >Reset Defaults</button>

    <div class="permissions-shell">
        <header class="permissions-intro">
            <div>
                <span class="eyebrow">Shop-wide access</span>
                <h2>Choose what each role can do</h2>
                <p>Changes sync to every till. Printer, scale, and device choices remain local to each till.</p>
            </div>
            {#if saving}<span class="saving-status">Saving...</span>{/if}
        </header>

        <nav class="role-tabs" aria-label="Staff roles">
            {#each employeeRoles as role}
                <button
                    type="button"
                    class:active={selectedRole === role}
                    aria-pressed={selectedRole === role}
                    on:click={() => selectedRole = role}
                >
                    <span>{roleLabels[role]}</span>
                    <small>{matrix[role].length} / {permissionKeys.length}</small>
                </button>
            {/each}
        </nav>

        <section class="role-summary">
            <div>
                <span class="role-mark role-{selectedRole}" aria-hidden="true">{roleLabels[selectedRole].slice(0, 1)}</span>
                <div>
                    <h3>{roleLabels[selectedRole]}</h3>
                    <p>{roleDescriptions[selectedRole]}</p>
                </div>
            </div>
            <strong>{selectedRole === 'admin' ? 'Full access' : `${enabledCount} enabled`}</strong>
        </section>

        <div class="permission-groups">
            <section class="permission-group">
                <div class="group-heading"><span>Pages</span><small>What this role can open</small></div>
                <div class="permission-list">
                    {#each pagePermissions as key}
                        {@const enabled = selectedPermissions.includes(key)}
                        <button
                            type="button"
                            class="permission-row"
                            class:enabled
                            role="switch"
                            aria-checked={enabled}
                            disabled={saving || selectedRole === 'admin'}
                            on:click={() => toggle(selectedRole, key)}
                        >
                            <span class="permission-copy"><strong>{permissionLabels[key]}</strong><small>{permissionDescriptions[key]}</small></span>
                            <span class="switch" class:on={enabled} aria-hidden="true"><i></i></span>
                        </button>
                    {/each}
                </div>
            </section>

            <section class="permission-group">
                <div class="group-heading"><span>Checkout &amp; closing</span><small>Actions this role can approve</small></div>
                <div class="permission-list">
                    {#each actionPermissions as key}
                        {@const enabled = selectedPermissions.includes(key)}
                        <button
                            type="button"
                            class="permission-row"
                            class:enabled
                            role="switch"
                            aria-checked={enabled}
                            disabled={saving || selectedRole === 'admin'}
                            on:click={() => toggle(selectedRole, key)}
                        >
                            <span class="permission-copy"><strong>{permissionLabels[key]}</strong><small>{permissionDescriptions[key]}</small></span>
                            <span class="switch" class:on={enabled} aria-hidden="true"><i></i></span>
                        </button>
                    {/each}
                </div>
            </section>
        </div>

        {#if selectedRole === 'admin'}
            <div class="admin-note">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path></svg>
                Administrator permissions are locked so the shop always has a recovery account.
            </div>
        {/if}
    </div>
</MgmtPage>

<ConfirmDialog
    bind:show={showResetConfirm}
    title="Reset Role Permissions?"
    message="Restore the recommended access for managers, supervisors, and cashiers on every till?"
    confirmText="Reset Permissions"
    on:confirm={resetDefaults}
/>

<style>
    .permissions-shell { height: 100%; min-height: 0; padding: 1rem; overflow-y: auto; overscroll-behavior: contain; }
    .permissions-intro { min-height: 84px; padding: .85rem 1rem; display: flex; align-items: center; justify-content: space-between; gap: 1rem; border: 1px solid var(--border-flat); border-radius: .45rem; background: var(--bg-card); }
    .eyebrow { color: var(--accent-primary); font-size: .7rem; font-weight: 900; text-transform: uppercase; }
    .permissions-intro h2 { margin: .2rem 0 0; font-size: 1.15rem; }
    .permissions-intro p { margin: .3rem 0 0; color: var(--text-muted); font-size: .78rem; }
    .saving-status { flex: 0 0 auto; color: var(--accent-primary); font-size: .78rem; font-weight: 850; }
    .role-tabs { margin-top: .75rem; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: .55rem; }
    .role-tabs button { min-width: 0; min-height: 58px; padding: .65rem .8rem; display: flex; align-items: center; justify-content: space-between; gap: .5rem; color: var(--text-main); text-align: left; border: 1px solid var(--border-flat); border-radius: .4rem; background: var(--bg-panel); cursor: pointer; }
    .role-tabs button:hover { border-color: var(--accent-primary); }
    .role-tabs button.active { color: white; border-color: var(--accent-primary); background: var(--accent-primary); }
    .role-tabs span { min-width: 0; overflow: hidden; font-size: .84rem; font-weight: 900; text-overflow: ellipsis; white-space: nowrap; }
    .role-tabs small { flex: 0 0 auto; opacity: .78; font-size: .67rem; font-weight: 800; }
    .role-summary { margin-top: .75rem; padding: .8rem 1rem; display: flex; align-items: center; justify-content: space-between; gap: 1rem; border: 1px solid var(--border-flat); border-radius: .4rem; background: var(--bg-card); }
    .role-summary > div { min-width: 0; display: flex; align-items: center; gap: .8rem; }
    .role-mark { width: 42px; height: 42px; flex: 0 0 42px; display: grid; place-items: center; color: white; font-size: 1rem; font-weight: 950; border-radius: .35rem; background: var(--accent-primary); }
    .role-mark.role-admin { background: var(--danger); }
    .role-mark.role-manager { background: var(--warning); }
    .role-mark.role-supervisor { background: var(--success); }
    .role-summary h3 { margin: 0; font-size: .95rem; }
    .role-summary p { margin: .15rem 0 0; color: var(--text-muted); font-size: .73rem; line-height: 1.35; }
    .role-summary > strong { flex: 0 0 auto; color: var(--accent-primary); font-size: .78rem; }
    .permission-groups { margin-top: .75rem; display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(310px, .65fr); gap: .75rem; align-items: start; }
    .permission-group { min-width: 0; overflow: hidden; border: 1px solid var(--border-flat); border-radius: .45rem; background: var(--bg-card); }
    .group-heading { min-height: 54px; padding: .7rem .85rem; display: flex; align-items: center; justify-content: space-between; gap: 1rem; border-bottom: 1px solid var(--border-flat); background: var(--bg-panel); }
    .group-heading span { font-size: .82rem; font-weight: 900; text-transform: uppercase; }
    .group-heading small { color: var(--text-muted); font-size: .69rem; font-weight: 700; }
    .permission-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .permission-group:last-child .permission-list { grid-template-columns: minmax(0, 1fr); }
    .permission-row { min-width: 0; min-height: 68px; padding: .7rem .8rem; display: flex; align-items: center; justify-content: space-between; gap: .7rem; color: var(--text-main); text-align: left; border: 0; border-right: 1px solid var(--border-flat); border-bottom: 1px solid var(--border-flat); background: var(--bg-card); cursor: pointer; }
    .permission-row:nth-child(even) { border-right: 0; }
    .permission-group:last-child .permission-row { border-right: 0; }
    .permission-row:hover:not(:disabled) { background: var(--bg-card-hover); }
    .permission-row.enabled { box-shadow: inset 3px 0 var(--success); background: var(--bg-panel); }
    .permission-row:disabled { cursor: default; opacity: 1; }
    .permission-copy { min-width: 0; }
    .permission-copy strong, .permission-copy small { display: block; }
    .permission-copy strong { font-size: .8rem; }
    .permission-copy small { margin-top: .15rem; color: var(--text-muted); font-size: .66rem; line-height: 1.3; }
    .switch { width: 42px; height: 24px; flex: 0 0 42px; padding: 3px; border: 1px solid var(--border-flat); border-radius: 999px; background: var(--bg-card-hover); transition: background .12s ease; }
    .switch i { width: 16px; height: 16px; display: block; border-radius: 50%; background: var(--text-muted); transition: transform .12s ease; }
    .switch.on { border-color: var(--success); background: var(--success); }
    .switch.on i { background: white; transform: translateX(18px); }
    .admin-note { margin-top: .75rem; padding: .7rem .85rem; display: flex; align-items: center; gap: .6rem; color: var(--text-muted); font-size: .75rem; font-weight: 700; border: 1px solid var(--border-flat); border-radius: .4rem; background: var(--bg-panel); }
    .admin-note svg { width: 18px; height: 18px; flex: 0 0 18px; color: var(--accent-primary); }
    @media (max-width: 900px) {
        .permission-groups { grid-template-columns: minmax(0, 1fr); }
        .permission-group:last-child .permission-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .permission-group:last-child .permission-row { border-right: 1px solid var(--border-flat); }
        .permission-group:last-child .permission-row:nth-child(even) { border-right: 0; }
    }
    @media (max-width: 680px) {
        .role-tabs { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .permission-list, .permission-group:last-child .permission-list { grid-template-columns: minmax(0, 1fr); }
        .permission-row, .permission-group:last-child .permission-row { border-right: 0; }
        .role-summary { align-items: flex-start; }
        .role-summary > strong { display: none; }
    }
</style>
