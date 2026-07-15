<script lang="ts">
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import Modal from '$lib/components/Modal.svelte';
    import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
    import CustomSelect from '$lib/components/CustomSelect.svelte';
    import TouchToggle from '$lib/components/TouchToggle.svelte';
    import { employeesDB, type Employee, uuid, now } from '$lib/stores/db';
    import { toast } from '$lib/stores/toast';
    import { employeeHasLinkedHistory, remove, upsert } from '$lib/stores/database';
    import { currentEmployee, hashPin } from '$lib/stores/session';

    let show = false;
    let editing = false;
    let cur: Partial<Employee> = {};
    let originalEmployee: Employee | null = null;
    let employeeToDelete: Employee | null = null;
    let showDeleteConfirm = false;
    let saveBusy = false;
    let statusBusyId = '';
    let deleteCheckBusyId = '';

    const roles: Employee['role'][] = ['admin', 'manager', 'supervisor', 'cashier'];
    const roleOptions = roles.map((role) => ({
        label: role.charAt(0).toUpperCase() + role.slice(1),
        value: role,
    }));

    $: sortedEmployees = [...$employeesDB].sort((a, b) =>
        Number(b.isActive) - Number(a.isActive) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    );
    $: activeCount = $employeesDB.filter((employee) => employee.isActive).length;
    $: adminCount = $employeesDB.filter((employee) => employee.role === 'admin').length;
    $: managerCount = $employeesDB.filter((employee) => employee.role === 'manager').length;
    $: supervisorCount = $employeesDB.filter((employee) => employee.role === 'supervisor').length;
    $: cashierCount = $employeesDB.filter((employee) => employee.role === 'cashier').length;

    function initials(name: string): string {
        return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase() || '?';
    }

    function add() {
        const stamp = now();
        cur = {
            id: uuid(),
            storeId: '',
            name: '',
            role: 'cashier',
            pin: '',
            pinHash: '',
            email: '',
            isActive: true,
            createdAt: stamp,
            updatedAt: stamp,
        };
        originalEmployee = null;
        editing = false;
        show = true;
    }

    function edit(employee: Employee) {
        originalEmployee = employee;
        cur = { ...employee, pin: '' };
        editing = true;
        show = true;
    }

    function isLastActiveAdmin(employee: Employee): boolean {
        return employee.isActive && employee.role === 'admin' &&
            $employeesDB.filter((item) => item.isActive && item.role === 'admin').length <= 1;
    }

    async function save() {
        if (saveBusy) return;
        const name = String(cur.name || '').trim();
        const email = String(cur.email || '').trim();
        const pin = String(cur.pin || '').trim();
        const role = (cur.role || 'cashier') as Employee['role'];
        const isActive = cur.isActive !== false;

        if (!name) {
            toast('Staff name is required', 'error');
            return;
        }
        if (!editing && !pin) {
            toast('A PIN is required for a new staff member', 'error');
            return;
        }
        if (pin && !/^\d{4,8}$/.test(pin)) {
            toast('PIN must be 4 to 8 digits', 'error');
            return;
        }
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            toast('Enter a valid email address or leave it blank', 'error');
            return;
        }
        if (originalEmployee?.id === $currentEmployee?.id && !isActive) {
            toast('You cannot deactivate the account currently signed in', 'error');
            return;
        }
        if (
            originalEmployee &&
            isLastActiveAdmin(originalEmployee) &&
            (!isActive || role !== 'admin')
        ) {
            toast('Keep at least one active administrator', 'error');
            return;
        }

        saveBusy = true;
        try {
            const pinHash = pin
                ? await hashPin(pin)
                : originalEmployee?.pinHash || cur.pinHash || '';
            if (pin) {
                const duplicatePin = $employeesDB.some((employee) =>
                    employee.id !== cur.id &&
                    ((employee.pinHash && employee.pinHash === pinHash) ||
                        (!employee.pinHash && employee.pin === pin))
                );
                if (duplicatePin) {
                    toast('That PIN is already used by another staff member', 'error');
                    return;
                }
            }

            const employee: Employee = {
                id: String(cur.id),
                storeId: originalEmployee?.storeId || cur.storeId || '',
                name,
                pin: pin ? '' : originalEmployee?.pin || '',
                pinHash,
                role,
                email,
                isActive,
                createdAt: originalEmployee?.createdAt || cur.createdAt || now(),
                updatedAt: now(),
            };

            await upsert('employees', employee);
            employeesDB.update((list) => editing
                ? list.map((item) => item.id === employee.id ? employee : item)
                : [...list, employee]
            );
            if ($currentEmployee?.id === employee.id) currentEmployee.set(employee);
            show = false;
            toast(editing ? 'Staff member updated' : 'Staff member added');
        } catch (error) {
            console.error('Could not save staff member:', error);
            toast(`Could not save staff member: ${String(error).replace(/^Error:\s*/, '')}`, 'error');
        } finally {
            saveBusy = false;
        }
    }

    async function toggle(employee: Employee) {
        if (statusBusyId) return;
        if (employee.id === $currentEmployee?.id && employee.isActive) {
            toast('You cannot deactivate the account currently signed in', 'error');
            return;
        }
        if (isLastActiveAdmin(employee)) {
            toast('Keep at least one active administrator', 'error');
            return;
        }

        statusBusyId = employee.id;
        try {
            const updated: Employee = { ...employee, isActive: !employee.isActive, updatedAt: now() };
            await upsert('employees', updated);
            employeesDB.update((list) => list.map((item) => item.id === employee.id ? updated : item));
            toast(updated.isActive ? 'Staff member activated' : 'Staff member deactivated', 'info');
        } catch (error) {
            console.error('Could not update staff status:', error);
            toast(`Could not update status: ${String(error).replace(/^Error:\s*/, '')}`, 'error');
        } finally {
            statusBusyId = '';
        }
    }

    async function requestDelete(employee: Employee) {
        if (deleteCheckBusyId) return;
        if (employee.id === $currentEmployee?.id) {
            toast('You cannot delete the account currently signed in', 'error');
            return;
        }
        if (isLastActiveAdmin(employee)) {
            toast('Keep at least one active administrator', 'error');
            return;
        }

        deleteCheckBusyId = employee.id;
        try {
            if (await employeeHasLinkedHistory(employee.id)) {
                toast('This staff member has recorded activity. Deactivate them so reports and the audit trail stay correct.', 'error');
                return;
            }
            employeeToDelete = employee;
            showDeleteConfirm = true;
        } catch (error) {
            console.error('Could not verify staff history:', error);
            toast(`Could not safely verify staff history: ${String(error).replace(/^Error:\s*/, '')}`, 'error');
        } finally {
            deleteCheckBusyId = '';
        }
    }

    async function confirmDelete() {
        if (!employeeToDelete) return;
        const employeeId = employeeToDelete.id;
        try {
            await remove('employees', employeeId);
            employeesDB.update((list) => list.filter((employee) => employee.id !== employeeId));
            toast('Staff member deleted');
        } catch (error) {
            console.error('Could not delete staff member:', error);
            toast(`Could not delete staff member: ${String(error).replace(/^Error:\s*/, '')}`, 'error');
        } finally {
            employeeToDelete = null;
        }
    }
</script>

<MgmtPage title="Staff">
    <div slot="actions" class="staff-page-actions">
        {#if $currentEmployee?.role === 'admin'}
            <a class="btn btn-secondary role-permissions-button" href="/employees/permissions">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"></path>
                    <path d="m9 12 2 2 4-4"></path>
                </svg>
                <span>Role Permissions</span>
            </a>
        {/if}
        <button class="btn btn-primary add-staff-button" on:click={add}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" aria-hidden="true">
                <path d="M12 5v14M5 12h14"></path>
            </svg>
            <span>Add Staff Member</span>
        </button>
    </div>

    <div class="staff-shell">
        <div class="staff-summary" aria-label="Staff summary">
            <div><span>Active</span><strong>{activeCount}<small> / {$employeesDB.length}</small></strong></div>
            <div><span>Administrators</span><strong>{adminCount}</strong></div>
            <div><span>Managers</span><strong>{managerCount}</strong></div>
            <div><span>Supervisors</span><strong>{supervisorCount}</strong></div>
            <div><span>Cashiers</span><strong>{cashierCount}</strong></div>
        </div>

        <div class="staff-table-wrap">
            <table class="tbl staff-table">
                <thead>
                    <tr><th>Staff Member</th><th>Role</th><th>Status</th><th class="action-heading">Actions</th></tr>
                </thead>
                <tbody>
                    {#each sortedEmployees as employee}
                        <tr class:inactive-row={!employee.isActive}>
                            <td>
                                <div class="staff-person">
                                    <span class="staff-avatar" aria-hidden="true">{initials(employee.name)}</span>
                                    <div><strong>{employee.name}</strong><small>{employee.email || 'No email address'}</small></div>
                                </div>
                            </td>
                            <td><span class="role-badge role-{employee.role}">{employee.role}</span></td>
                            <td>
                                <span class="status-label {employee.isActive ? 'active' : 'inactive'}">
                                    <i></i>{employee.isActive ? 'Active' : 'Inactive'}
                                </span>
                            </td>
                            <td class="action-cell">
                                <div class="staff-actions">
                                    <button class="btn-icon act-btn" title={`Edit ${employee.name}`} aria-label={`Edit ${employee.name}`} on:click={() => edit(employee)}>
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>
                                    </button>
                                    <button
                                        class="btn-icon act-btn status-action"
                                        class:activate={!employee.isActive}
                                        disabled={statusBusyId === employee.id}
                                        title={employee.isActive ? `Deactivate ${employee.name}` : `Activate ${employee.name}`}
                                        aria-label={employee.isActive ? `Deactivate ${employee.name}` : `Activate ${employee.name}`}
                                        on:click={() => toggle(employee)}
                                    >
                                        {#if statusBusyId === employee.id}
                                            <span class="button-spinner"></span>
                                        {:else if employee.isActive}
                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round"><path d="M8 5v14M16 5v14"></path></svg>
                                        {:else}
                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linejoin="round"><path d="m7 4 13 8-13 8Z"></path></svg>
                                        {/if}
                                    </button>
                                    <button
                                        class="btn-icon act-btn danger"
                                        disabled={deleteCheckBusyId === employee.id}
                                        title={`Delete ${employee.name}`}
                                        aria-label={`Delete ${employee.name}`}
                                        on:click={() => requestDelete(employee)}
                                    >
                                        {#if deleteCheckBusyId === employee.id}
                                            <span class="button-spinner"></span>
                                        {:else}
                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5"></path></svg>
                                        {/if}
                                    </button>
                                </div>
                            </td>
                        </tr>
                    {/each}
                    {#if $employeesDB.length === 0}
                        <tr class="empty-row"><td colspan="4">No staff members have been added.</td></tr>
                    {/if}
                </tbody>
            </table>
        </div>
    </div>
</MgmtPage>

<Modal bind:show title={editing ? 'Edit Staff Member' : 'Add Staff Member'} width="560px">
    <div class="staff-form">
        <div class="field span-2">
            <label for="staff-name">Name *</label>
            <input id="staff-name" bind:value={cur.name} autocomplete="name" />
        </div>
        <div class="field">
            <label for="staff-pin">{editing ? 'New PIN' : 'PIN *'}</label>
            <input id="staff-pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" bind:value={cur.pin} autocomplete="new-password" placeholder={editing ? 'Leave unchanged' : '4 to 8 digits'} />
            <small>{editing ? 'Leave blank to keep the existing PIN.' : 'Use 4 to 8 numbers.'}</small>
        </div>
        <div class="field">
            <CustomSelect label="Role" bind:value={cur.role} options={roleOptions} largeOptions />
        </div>
        <div class="field span-2">
            <label for="staff-email">Email</label>
            <input id="staff-email" type="email" bind:value={cur.email} autocomplete="email" placeholder="Optional" />
        </div>
        <div class="staff-active-control span-2">
            <TouchToggle bind:checked={cur.isActive} label="Active account" />
            <small>Inactive staff cannot sign in or approve actions.</small>
        </div>
    </div>
    <svelte:fragment slot="footer">
        <button class="btn btn-secondary" disabled={saveBusy} on:click={() => show = false}>Cancel</button>
        <button class="btn btn-primary" disabled={saveBusy} on:click={save}>{saveBusy ? 'Saving...' : 'Save Staff Member'}</button>
    </svelte:fragment>
</Modal>

<ConfirmDialog
    bind:show={showDeleteConfirm}
    title="Delete Staff Member?"
    message={`Permanently delete ${employeeToDelete?.name || 'this staff member'}? Use deactivate instead if they may return.`}
    confirmText="Delete"
    variant="danger"
    on:confirm={confirmDelete}
    on:cancel={() => (employeeToDelete = null)}
/>

<style>
    .staff-page-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: .65rem; }
    .role-permissions-button, .add-staff-button { min-height: 48px; display: inline-flex; align-items: center; gap: .55rem; }
    .role-permissions-button svg, .add-staff-button svg { width: 20px; height: 20px; }
    .staff-shell { height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
    .staff-summary { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 1px; border-bottom: 1px solid var(--border-flat); background: var(--border-flat); }
    .staff-summary > div { min-width: 0; padding: .8rem 1rem; display: flex; align-items: center; justify-content: space-between; gap: .75rem; background: var(--bg-card); }
    .staff-summary span { overflow: hidden; color: var(--text-muted); font-size: .72rem; font-weight: 850; text-overflow: ellipsis; text-transform: uppercase; white-space: nowrap; }
    .staff-summary strong { color: var(--text-main); font-size: 1.3rem; }
    .staff-summary small { color: var(--text-muted); font-size: .7rem; font-weight: 700; }
    .staff-table-wrap { min-height: 0; flex: 1; overflow: auto; overscroll-behavior: contain; }
    .staff-table { width: 100%; min-width: 680px; }
    .staff-table th, .staff-table td { vertical-align: middle; }
    .staff-table th { position: sticky; top: 0; z-index: 2; }
    .staff-person { min-width: 0; display: flex; align-items: center; gap: .75rem; }
    .staff-person > div { min-width: 0; }
    .staff-person strong, .staff-person small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .staff-person strong { font-size: .96rem; }
    .staff-person small { margin-top: .15rem; color: var(--text-muted); font-size: .73rem; }
    .staff-avatar { width: 44px; height: 44px; flex: 0 0 44px; display: grid; place-items: center; color: white; font-size: .85rem; font-weight: 900; border-radius: .45rem; background: var(--accent-primary); }
    .role-badge { display: inline-flex; min-width: 88px; justify-content: center; padding: .4rem .65rem; font-size: .72rem; font-weight: 900; border: 1px solid var(--border-flat); border-radius: .35rem; text-transform: capitalize; background: var(--bg-panel); }
    .role-admin { color: var(--danger); }
    .role-manager { color: var(--warning); }
    .role-supervisor { color: var(--success); }
    .role-cashier { color: var(--accent-primary); }
    .status-label { display: inline-flex; align-items: center; gap: .45rem; font-size: .78rem; font-weight: 850; }
    .status-label i { width: .55rem; height: .55rem; border-radius: 50%; background: currentColor; }
    .status-label.active { color: var(--success); }
    .status-label.inactive { color: var(--danger); }
    .inactive-row .staff-person strong { color: var(--text-muted); }
    .action-heading { text-align: right; }
    .action-cell { width: 174px; }
    .staff-actions { display: grid; grid-template-columns: repeat(3, 44px); justify-content: end; gap: .45rem; }
    .staff-actions .act-btn { width: 44px !important; height: 44px !important; min-width: 44px !important; min-height: 44px !important; border-radius: .45rem; }
    .staff-actions svg { width: 19px; height: 19px; }
    .status-action { color: var(--warning); }
    .status-action.activate { color: var(--success); }
    .button-spinner { width: 17px; height: 17px; border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%; animation: staff-spin .7s linear infinite; }
    .staff-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
    .staff-form .field { min-width: 0; }
    .staff-form .field small, .staff-active-control small { color: var(--text-muted); font-size: .72rem; line-height: 1.35; }
    .staff-active-control { padding: .85rem; display: flex; flex-direction: column; gap: .45rem; border: 1px solid var(--border-flat); border-radius: .45rem; background: var(--bg-panel); }
    @keyframes staff-spin { to { transform: rotate(360deg); } }
    @media (max-width: 760px) {
        .staff-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .staff-form { grid-template-columns: minmax(0, 1fr); }
        .staff-form .span-2, .staff-active-control.span-2 { grid-column: span 1; }
    }
</style>
