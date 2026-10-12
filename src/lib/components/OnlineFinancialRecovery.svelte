<script lang="ts">
    import { onDestroy, onMount } from 'svelte';
    import { isTauri } from '@tauri-apps/api/core';
    import { currentEmployee } from '$lib/stores/session';
    import { customersDB, formatMoney, settingsDB } from '$lib/stores/db';
    import { connectionState } from '$lib/stores/connection';
    import { toast } from '$lib/stores/toast';
    import { modalFocusTrap } from '$lib/actions/modalFocusTrap';
    import {
        pendingOnlineFinancialIntent, pendingOnlineFinancialReadError,
        refreshPendingOnlineFinancialIntent, recoverOnlineFinancialIntent,
    } from '$lib/stores/database';
    import { canRecoverOnlineFinancialIntent } from '$lib/onlineFinancialRecovery';
    import { onlineFinancialReviewOpen } from '$lib/stores/onlineFinancialRecoveryUi';

    let busy = false;
    let error = '';
    $: pending = $pendingOnlineFinancialIntent;
    $: allowed = Boolean(pending && canRecoverOnlineFinancialIntent($currentEmployee, pending, $settingsDB));
    $: customerName = pending?.customerId
        ? $customersDB.find(customer => customer.id === pending?.customerId)?.name || pending.customerId
        : '';

    async function refresh() {
        try { await refreshPendingOnlineFinancialIntent(); }
        catch { /* The persistent read-error state must remain visible. */ }
    }
    async function recover() {
        if (!pending || busy || !allowed) return;
        const receipt = pending.receiptNumber;
        const orderId = pending.orderId;
        busy = true;
        error = '';
        try {
            const completed = await recoverOnlineFinancialIntent(undefined, orderId);
            if (completed) {
                $onlineFinancialReviewOpen = false;
                toast(`Reserved receipt ${receipt} completed and verified. No new transaction was created.`, 'success', false, undefined, { persistent: true });
            } else {
                error = 'The saved transaction changed. Refresh and review its outcome before taking another payment.';
            }
        } catch (failure) {
            error = `Recovery is not confirmed. Do not charge or refund again. ${String(failure).replace(/^Error:\s*/, '')}`;
        } finally { busy = false; }
    }
    onMount(() => {
        if (!isTauri()) return;
        void refresh();
        // Inspect only. Post-startup recovery needs the operator's explicit
        // review; it must not silently complete while the old trolley remains.
        const timer = setInterval(() => { if (!busy) void refresh(); }, 60_000);
        return () => clearInterval(timer);
    });
    onDestroy(() => { $onlineFinancialReviewOpen = false; });
</script>

{#if $currentEmployee && $currentEmployee.role !== 'attendance' && (pending || $pendingOnlineFinancialReadError)}
    <aside class="financial-pending" role="status" aria-live="polite">
        <div>
            <strong>{pending ? `Transaction pending verification · receipt ${pending.receiptNumber}` : 'Financial recovery status unavailable'}</strong>
            <p>{pending ? 'Not cancelled. Do not charge or refund again. The original receipt is saved for recovery.' : $pendingOnlineFinancialReadError}</p>
        </div>
        <button type="button" on:click={() => { $onlineFinancialReviewOpen = true; void refresh(); }}>Review / Recover</button>
    </aside>
{/if}

{#if $onlineFinancialReviewOpen && $currentEmployee}
    <div class="financial-recovery-overlay" role="presentation">
        <div class="financial-recovery-dialog" role="dialog" aria-modal="true" aria-labelledby="financial-recovery-title"
            tabindex="-1" use:modalFocusTrap={{ dismiss: () => { $onlineFinancialReviewOpen = false; }, dismissDisabled: busy }}>
            <h2 id="financial-recovery-title" tabindex="-1" data-modal-initial-focus>Review saved transaction</h2>
            {#if pending && allowed}
                <p><strong>Reserved receipt {pending.receiptNumber} · {formatMoney(pending.total)}</strong></p>
                <p>{pending.operation === 'customer_account_sale' ? 'Pay Later sale' : pending.operation === 'reversal' ? 'Refund / reversal' : 'Loyalty sale'}{customerName ? ` · ${customerName}` : ''}</p>
                <p>This transaction is pending verification, not cancelled. Recovery checks or completes only this saved receipt, with its original amount and customer. Do not enter the sale or refund again.</p>
                <ul>{#each pending.lines as line}<li>{line.quantity} × {line.productName} · {formatMoney(line.lineTotal)}</li>{/each}</ul>
                <p>Closing this review does not cancel the saved transaction. A restart may also recover it.</p>
                {#if pending.lastError}<details><summary>Last recovery detail</summary><p class="recovery-detail">{pending.lastError}</p></details>{/if}
                {#if $connectionState.mode !== 'multi'}<p class="recovery-error">Reconnect the original multi-till database before recovery.</p>{/if}
            {:else if pending}
                <p class="recovery-error">Sign in with permission for this transaction to review or recover it.</p>
                <p>The saved transaction is not cancelled. Do not charge or refund again.</p>
            {:else}
                <p>{$pendingOnlineFinancialReadError || 'No pending transaction remains. Check Orders before repeating any sale or refund.'}</p>
            {/if}
            {#if error}<p class="recovery-error" role="alert">{error}</p>{/if}
            <div class="financial-recovery-actions">
                <button type="button" disabled={busy} on:click={() => { $onlineFinancialReviewOpen = false; }}>Close review</button>
                <button type="button" disabled={busy} on:click={refresh}>Refresh status</button>
                {#if pending}<button type="button" disabled={busy || !allowed || $connectionState.mode !== 'multi'} on:click={recover}>{busy ? 'Verifying original receipt…' : 'Recover this receipt'}</button>{/if}
            </div>
        </div>
    </div>
{/if}

<style>
    .financial-pending { position: fixed; z-index: 1800; bottom: 12px; left: 12px; right: 12px; display: flex; gap: 20px; align-items: center; justify-content: space-between; padding: 16px 20px; border: 2px solid var(--warning, #d79d31); border-radius: 12px; background: var(--bg-panel); color: var(--text-main); box-shadow: 0 8px 30px #0005; }
    .financial-pending p { margin: 4px 0 0; }
    button { padding: 12px 16px; border: 1px solid var(--border-flat); border-radius: 8px; background: var(--bg-card); color: var(--text-main); font-weight: 700; }
    button:disabled { opacity: .5; }
    .financial-recovery-overlay { position: fixed; inset: 0; z-index: 1900; background: #0009; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .financial-recovery-dialog { max-width: 700px; width: 100%; max-height: 90vh; overflow-y: auto; border-radius: 16px; background: var(--bg-panel); color: var(--text-main); padding: 28px; }
    h2 { font-size: 24px; font-weight: 800; margin: 0 0 16px; }
    p, ul, details { margin: 12px 0; }
    ul { padding-left: 24px; }
    .financial-recovery-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 20px; }
    .recovery-error { color: var(--danger, #cc4545); }
    .recovery-detail { overflow-wrap: anywhere; font-size: 13px; }
</style>
