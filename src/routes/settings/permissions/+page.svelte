<script lang="ts">
    import MgmtPage from '$lib/components/MgmtPage.svelte';
    import { settingsDB, now, type Employee } from '$lib/stores/db';
    import { upsert } from '$lib/stores/database';
    import { toast } from '$lib/stores/toast';
    import {
        defaultRolePermissions,
        parseRolePermissions,
        permissionLabels,
        serializeRolePermissions,
        type PermissionKey,
        type RolePermissionMatrix,
    } from '$lib/permissions';

    const roles: Employee['role'][] = ['admin', 'manager', 'cashier'];
    const permissionKeys = Object.keys(permissionLabels) as PermissionKey[];
    $: matrix = parseRolePermissions($settingsDB);

    function updateSetting(value: string) {
        const setting = { key: 'role_permissions', value, updatedAt: now() };
        settingsDB.update((list) => {
            const index = list.findIndex((row) => row.key === setting.key);
            if (index >= 0) list[index] = setting;
            else list.push(setting);
            return [...list];
        });
        void upsert('settings', setting, 'key');
    }

    function toggle(role: Employee['role'], key: PermissionKey) {
        const next: RolePermissionMatrix = {
            admin: [...matrix.admin],
            manager: [...matrix.manager],
            cashier: [...matrix.cashier],
        };
        const set = new Set(next[role]);
        if (set.has(key)) set.delete(key);
        else set.add(key);
        next[role] = permissionKeys.filter((permission) => set.has(permission));
        updateSetting(serializeRolePermissions(next));
    }

    function resetDefaults() {
        updateSetting(serializeRolePermissions(defaultRolePermissions));
        toast('Role permissions reset');
    }
</script>

<MgmtPage title="Role Permissions" backFallback="/settings">
    <button slot="actions" class="btn btn-secondary" on:click={resetDefaults}>Reset Defaults</button>

    <div class="h-full overflow-y-auto p-5">
        <div class="mb-5 rounded-2xl border border-border-flat bg-bg-card p-5">
            <p class="m-0 text-sm text-text-muted">
                These permissions sync to every till. Admin keeps full access by default, managers can run the shop, and cashiers stay focused on checkout.
            </p>
        </div>

        <div class="grid gap-4 lg:grid-cols-3">
            {#each roles as role}
                <section class="rounded-2xl border border-border-flat bg-bg-card p-4 shadow-sm">
                    <div class="mb-4">
                        <span class="text-xs font-black uppercase tracking-[0.16em] text-accent-primary">{role}</span>
                        <h2 class="m-0 mt-1 text-2xl capitalize">{role} Access</h2>
                    </div>

                    <div class="flex flex-col gap-2">
                        {#each permissionKeys as key}
                            {@const enabled = matrix[role].includes(key)}
                            <button
                                type="button"
                                class="flex min-h-[54px] items-center justify-between gap-3 rounded-xl border p-3 text-left transition {enabled ? 'border-success bg-success/10' : 'border-border-flat bg-bg-panel hover:border-accent-primary'}"
                                on:click={() => toggle(role, key)}
                            >
                                <span class="font-bold">{permissionLabels[key]}</span>
                                <span class="rounded-full px-3 py-1 text-xs font-black uppercase tracking-[0.12em] {enabled ? 'bg-success text-white' : 'bg-bg-card text-text-muted'}">
                                    {enabled ? 'On' : 'Off'}
                                </span>
                            </button>
                        {/each}
                    </div>
                </section>
            {/each}
        </div>
    </div>
</MgmtPage>
