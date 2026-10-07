<script lang="ts">
    import Modal from './Modal.svelte';
    import type { TerminalPaymentAttempt } from '$lib/terminalAttempts';
    import { reviewExpiredDojoPayment } from '$lib/terminalRecovery';
    export let show = false;
    export let attempt: TerminalPaymentAttempt | null = null;
    export let employeeId = '';
    export let onSaved: (() => Promise<void>) | undefined = undefined;
    let decision: 'paid' | 'not_paid' | '' = '';
    let receiptReference = '', note = '', pin = '', error = '', lastId = '';
    let checked = false, busy = false;
    let tips = '0.00', service = '0.00', cashback = '0.00';
    $: if (show && attempt?.id !== lastId) {
        lastId = attempt?.id || '';
        decision = ''; receiptReference = note = pin = error = '';
        checked = false; tips = service = cashback = '0.00';
    }
    $: if (!show) { pin = ''; lastId = ''; }
    const money = (pence: number) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: attempt?.currency || 'GBP' }).format(pence / 100);
    function minor(value: string): number {
        if (!/^\d{1,6}(\.\d{1,2})?$/.test(value.trim())) throw new Error('Enter each extra amount with no more than two decimal places.');
        return Math.round(Number(value) * 100);
    }
    async function save() {
        if (!attempt || !employeeId || !decision || busy || !checked) return;
        busy = true; error = '';
        try {
            await reviewExpiredDojoPayment(attempt.id, employeeId, pin, {
                decision, receiptReference, note,
                tipsAmount: decision === 'paid' ? minor(tips) : 0,
                serviceChargeAmount: decision === 'paid' ? minor(service) : 0,
                cashbackAmount: decision === 'paid' ? minor(cashback) : 0,
            });
            // Keep the form locked until recovery updates the trolley/ledger.
            // Otherwise a scan during recovery could be cleared as an old item.
            await onSaved?.();
            show = false;
        } catch (cause) { error = String(cause); }
        finally { busy = false; pin = ''; }
    }
</script>

<Modal bind:show title="Review expired Dojo payment" width="640px" dismissDisabled={busy}>
    <form id="dojo-expiry-review" class="flex flex-col gap-4" on:submit|preventDefault={save}>
        <div class="rounded-lg border border-warning/40 bg-warning/10 p-3">
            <p class="m-0 font-bold">Payment to check: {money(attempt?.amount || 0)}</p>
            <p class="m-0 mt-1 text-sm">Read the card machine screen or merchant receipt first. An expired session alone does not tell us whether the card was charged.</p>
            <p class="m-0 mt-2 break-all text-xs text-text-muted">{attempt?.clientTransactionId}</p>
        </div>
        <fieldset class="flex flex-col gap-2"><legend class="mb-2 font-bold">Result on the terminal or receipt</legend>
            <label class="flex items-center gap-2"><input type="radio" bind:group={decision} value="paid" disabled={busy} /> Payment successful — record the payment</label>
            <label class="flex items-center gap-2"><input type="radio" bind:group={decision} value="not_paid" disabled={busy} /> Payment failed — confirm cancellation before retrying</label>
        </fieldset>
        <div class="field"><label for="dojo-review-reference">Receipt / transaction reference</label><input id="dojo-review-reference" bind:value={receiptReference} maxlength="120" minlength="3" required disabled={busy} /></div>
        <div class="field"><label for="dojo-review-note">What you checked</label><textarea id="dojo-review-note" bind:value={note} maxlength="500" minlength="5" rows="2" required disabled={busy} placeholder="For example: merchant receipt shows Approved; checked the amount and reference"></textarea></div>
        {#if decision === 'paid'}
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div class="field"><label for="dojo-review-tips">Tip ({attempt?.currency})</label><input id="dojo-review-tips" inputmode="decimal" bind:value={tips} disabled={busy} /></div>
                <div class="field"><label for="dojo-review-service">Service charge</label><input id="dojo-review-service" inputmode="decimal" bind:value={service} disabled={busy} /></div>
                <div class="field"><label for="dojo-review-cashback">Cashback</label><input id="dojo-review-cashback" inputmode="decimal" bind:value={cashback} disabled={busy} /></div>
            </div>
            <p class="m-0 text-sm text-text-muted">Copy extras from the receipt, or leave zero. Before handing over cashback, check whether it was already paid out.</p>
        {/if}
        <label class="flex items-start gap-2 text-sm"><input type="checkbox" bind:checked required disabled={busy} /><span>I checked the terminal or receipt, amount and result. Record this decision with my staff name.</span></label>
        <div class="field"><label for="dojo-review-pin">Administrator PIN</label><input id="dojo-review-pin" type="password" inputmode="numeric" autocomplete="off" bind:value={pin} minlength="4" maxlength="12" required disabled={busy} /></div>
        {#if error}<p class="m-0 text-sm text-danger" role="alert">{error}</p>{/if}
    </form>
    <div slot="footer" class="flex w-full flex-wrap justify-end gap-3">
        <button class="btn btn-secondary" disabled={busy} on:click={() => show = false}>Keep unresolved</button>
        <button type="submit" form="dojo-expiry-review" class="btn btn-primary" disabled={busy || !checked || !employeeId || !decision}>{busy ? 'Verifying and recording…' : 'Record checked result'}</button>
    </div>
</Modal>
