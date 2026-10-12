<script lang="ts">
    import { onDestroy } from 'svelte';
    import { invoke } from '@tauri-apps/api/core';
    import Modal from './Modal.svelte';
    import { currentEmployee, isSupportEmployee } from '$lib/stores/session';
    import { recoverSandboxWithConfirmation, type DojoSandboxRecoveryResult } from '$lib/dojoSandboxRecovery';

    export let show = false;
    export let onFinished: (() => Promise<void>) | undefined = undefined;
    let pin = '', error = '', message = '';
    let busy = false;
    let result: DojoSandboxRecoveryResult | null = null;
    let controller: AbortController | null = null;
    let activeEmployeeId = '';
    let activeEmployeeVersion: string | undefined = '';
    let destroyed = false;
    $: administrator = $currentEmployee?.role === 'admin' && $currentEmployee.isActive
        && !isSupportEmployee($currentEmployee) && !$currentEmployee.roleNeedsRepair && !$currentEmployee.pinNeedsReset;
    $: if (busy && controller && (!show || !administrator
        || $currentEmployee?.id !== activeEmployeeId || $currentEmployee?.updatedAt !== activeEmployeeVersion)) {
        controller.abort();
        pin = ''; error = ''; message = ''; result = null; show = false;
    }
    $: if (!show && !busy) { pin = ''; error = ''; message = ''; result = null; }
    onDestroy(() => { destroyed = true; controller?.abort(); pin = ''; });

    async function recover() {
        if (!administrator || busy || !$currentEmployee) return;
        const employeeId = $currentEmployee.id;
        const employeeVersion = $currentEmployee.updatedAt;
        activeEmployeeId = employeeId;
        activeEmployeeVersion = employeeVersion;
        const recoveryController = new AbortController();
        controller = recoveryController;
        const signal = recoveryController.signal;
        const canContinue = () => !destroyed && !signal.aborted && controller === recoveryController
            && show && Boolean(administrator) && $currentEmployee?.id === employeeId
            && $currentEmployee?.updatedAt === employeeVersion;
        busy = true; error = ''; result = null;
        message = 'Checking the saved sandbox payments with Dojo…';
        try {
            const recovered = await recoverSandboxWithConfirmation({
                signal,
                canContinue,
                recover: () => invoke<DojoSandboxRecoveryResult>('dojo_recover_legacy_sandbox_payments', { employeeId, pin }),
                onWaiting: () => { message = 'Dojo confirmed cancellation. Checking again in 31 seconds before resolving the records. Keep this page open.'; },
            });
            if (!canContinue()) return;
            result = recovered;
            message = result.switchedToDedicated
                ? 'Old sandbox payments are resolved. This terminal is now Dedicated. You can close this window and remove the saved API key.'
                : result.remaining > 0
                    ? `${result.resolved} resolved; ${result.remaining} still need attention. See the details below.`
                    : 'The payment check finished. Review the details below before changing settings.';
            await onFinished?.();
        } catch (cause) {
            if (!canContinue()) return;
            error = String(cause);
            message = '';
            await onFinished?.().catch(() => undefined);
        } finally {
            if (controller === recoveryController) {
                busy = false; pin = ''; controller = null;
                activeEmployeeId = ''; activeEmployeeVersion = '';
            }
        }
    }
</script>

<Modal bind:show title="Resolve old sandbox payments" width="620px" dismissDisabled={busy}>
    <form id="dojo-sandbox-recovery" class="flex flex-col gap-4" on:submit|preventDefault={recover}>
        <p class="m-0 text-text-muted">Check this computer’s old test payments directly with Dojo, without MariaDB. Confirmed cancellations stay in the payment history. When all records are resolved, this terminal switches to Dedicated mode.</p>
        <p class="m-0 text-sm text-text-muted">An approved payment or an unclear result stays available for review. This action does not start a new payment.</p>
        {#if !administrator}<p class="m-0 text-warning">Sign in as an administrator to recover old sandbox payments.</p>{/if}
        {#if !result?.switchedToDedicated}
            <div class="field">
                <label for="dojo-sandbox-admin-pin">Administrator PIN</label>
                <input id="dojo-sandbox-admin-pin" type="password" inputmode="numeric" autocomplete="off" minlength="4" maxlength="12" bind:value={pin} required disabled={busy || !administrator} />
            </div>
        {/if}
        {#if message}<p class="m-0 rounded-lg border border-border-flat bg-bg-panel p-3 text-sm" role="status">{message}</p>{/if}
        {#if result?.issues.length}
            <ul class="m-0 list-disc space-y-2 pl-5 text-sm text-warning">
                {#each result.issues as issue}<li class="break-words">{issue}</li>{/each}
            </ul>
        {/if}
        {#if error}<p class="m-0 break-words text-sm text-danger" role="alert">{error}</p>{/if}
    </form>
    <div slot="footer" class="flex w-full flex-wrap justify-end gap-3">
        <button class="btn btn-secondary" disabled={busy} on:click={() => show = false}>Close</button>
        {#if !result?.switchedToDedicated}
            <button form="dojo-sandbox-recovery" type="submit" class="btn btn-primary" disabled={busy || !administrator || pin.length < 4}>
                {busy ? 'Verifying with Dojo…' : 'Resolve old sandbox payments'}
            </button>
        {/if}
    </div>
</Modal>
