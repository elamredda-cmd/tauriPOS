<script lang="ts">
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import Modal from '$lib/components/Modal.svelte';
    import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
    import CustomSelect from '$lib/components/CustomSelect.svelte';
    import TouchToggle from '$lib/components/TouchToggle.svelte';
    import { employeesDB, ordersDB, shiftsDB, type Employee, uuid, now } from '$lib/stores/db';
    import { toast } from '$lib/stores/toast';
    import { remove, upsert } from '$lib/stores/database';
    import { hashPin } from '$lib/stores/session';

    let show = false; 
    let editing = false;
    let cur: Partial<Employee> = {};
    let employeeToDelete: Employee | null = null;
    let showDeleteConfirm = false;
    const roles: Employee['role'][] = ['admin', 'manager', 'cashier'];
    const roleOptions = roles.map(r => ({ label: r.charAt(0).toUpperCase() + r.slice(1), value: r }));

    function add() { cur = { id: uuid(), name:'', role:'cashier', pin:'', isActive:true, createdAt: now() }; editing=false; show=true; }
    function edit(e: Employee) { cur = { ...e }; editing=true; show=true; }
    async function save() {
        if (!cur.name || !cur.pin) { toast('Name and PIN required', 'error'); return; }
        if (!/^\d{4,8}$/.test(cur.pin)) { toast('PIN must be 4 to 8 digits', 'error'); return; }
        cur.pinHash = await hashPin(cur.pin);
        cur.pin = '';
        employeesDB.update(list => {
            const updated = editing ? list.map(e => e.id===cur.id ? cur as Employee : e) : [...list, cur as Employee];
            upsert('employees', cur);
            return updated;
        });
        show=false;
        toast(editing ? 'Employee updated' : 'Employee added');
    }
    function toggle(id: string) { employeesDB.update(l => {
        const item = l.find(e => e.id === id);
        if (item) {
            const updated = { ...item, isActive: !item.isActive };
            upsert('employees', updated);
            return l.map(e => e.id === id ? updated : e);
        }
        return l;
    }); toast('Status updated', 'info'); }

    function requestDelete(employee: Employee) {
        const hasHistory =
            $ordersDB.some(order => order.employeeId === employee.id) ||
            $shiftsDB.some(shift => shift.employeeId === employee.id || shift.closedByEmployeeId === employee.id);
        if (hasHistory) {
            toast('This employee has sales or shift history. Deactivate them instead so reports stay correct.', 'error');
            return;
        }
        employeeToDelete = employee;
        showDeleteConfirm = true;
    }

    async function confirmDelete() {
        if (!employeeToDelete) return;
        try {
            await remove('employees', employeeToDelete.id);
            employeesDB.update(list => list.filter(employee => employee.id !== employeeToDelete?.id));
            toast('Employee deleted');
        } catch (error) {
            console.error('Could not delete employee:', error);
            toast('Could not delete employee', 'error');
        } finally {
            employeeToDelete = null;
        }
    }
</script>

<MgmtPage title="Employees">
    <button slot="actions" class="btn btn-primary" on:click={add}>+ Add Employee</button>
    <table class="tbl">
        <thead><tr><th>Name</th><th>Role</th><th>PIN</th><th>Email</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>
            {#each $employeesDB as e}
            <tr>
                <td style="font-weight:600">{e.name}</td>
                <td><span class="tag">{e.role}</span></td>
                <td class="mono">****</td>
                <td>{e.email || '-'}</td>
                <td><span class="tag" style="color:{e.isActive?'var(--success)':'var(--danger)'}">{e.isActive?'Active':'Inactive'}</span></td>
                <td><div class="act-row">
                    <button class="btn-icon act-btn" on:click={() => edit(e)}>✎</button>
                    <button class="btn-icon act-btn danger" on:click={() => toggle(e.id)}>{e.isActive?'⏸':'▶'}</button>
                    <button class="btn-icon act-btn danger" title="Delete employee" on:click={() => requestDelete(e)}>🗑</button>
                </div></td>
            </tr>
            {/each}
            {#if $employeesDB.length===0}<tr class="empty-row"><td colspan="6">No employees.</td></tr>{/if}
        </tbody>
    </table>
</MgmtPage>

<Modal bind:show title={editing?'Edit Employee':'Add Employee'} width="480px">
    <div class="form-grid">
        <div class="field span-2"><label>Name *</label><input bind:value={cur.name} /></div>
        <div class="field"><label>PIN (4 digits) *</label><input bind:value={cur.pin} maxlength="4" placeholder="1234" /></div>
        <div class="field">
            <CustomSelect label="Role" bind:value={cur.role} options={roleOptions} />
        </div>
        <div class="field span-2"><label>Email</label><input type="email" bind:value={cur.email} /></div>
        <div class="span-2"><TouchToggle bind:checked={cur.isActive} label="Active Status" /></div>
    </div>
    <svelte:fragment slot="footer">
        <button class="btn btn-danger" on:click={() => show=false}>Cancel</button>
        <button class="btn btn-primary" on:click={save}>Save</button>
    </svelte:fragment>
</Modal>

<ConfirmDialog
    bind:show={showDeleteConfirm}
    title="Delete Employee?"
    message={`Delete ${employeeToDelete?.name || 'this employee'}? This is only allowed when they have no sales or shift history.`}
    confirmText="Delete"
    variant="danger"
    on:confirm={confirmDelete}
    on:cancel={() => (employeeToDelete = null)}
/>
