<script lang="ts">
    import type { CheckoutCustomerDraft } from '$lib/checkoutCustomer';
    import { LOYALTY_CODE_MAX_LENGTH } from '$lib/customerLoyaltyCode';
    export let draft: CheckoutCustomerDraft;
    export let saving = false;
    export let error = '';
    export let offline = false;
    export let onSave: () => void | Promise<void>;
    export let onCancel: () => void;
</script>

<form id="checkout-new-customer-form" class="checkout-customer-form" on:submit|preventDefault|stopPropagation={onSave}>
    <div class="checkout-customer-scroll">
    <p class="checkout-customer-intro">Save this customer and select them for the current sale.</p>
    {#if error}<p class="checkout-customer-error" role="alert">{error}</p>{/if}
    {#if offline}<p class="checkout-customer-error" role="status">Reconnect to the main database to save. Your details will stay here.</p>{/if}
    <fieldset disabled={saving}>
        <div class="checkout-customer-fields">
            <div class="field span-all"><label for="checkout-new-customer-name">Customer name <span aria-hidden="true">*</span></label><input id="checkout-new-customer-name" data-modal-initial-focus autocomplete="name" maxlength="120" required bind:value={draft.name} /></div>
            <div class="field"><label for="checkout-new-customer-phone">Phone <small>(optional)</small></label><input id="checkout-new-customer-phone" type="tel" autocomplete="tel" maxlength="40" bind:value={draft.phone} /></div>
            <div class="field"><label for="checkout-new-customer-postcode">Postcode <small>(optional)</small></label><input id="checkout-new-customer-postcode" autocomplete="postal-code" maxlength="20" bind:value={draft.postcode} /></div>
            <div class="field span-all"><label for="checkout-new-customer-email">Email <small>(optional)</small></label><input id="checkout-new-customer-email" type="email" autocomplete="email" maxlength="254" bind:value={draft.email} /></div>
            <div class="field span-all"><label for="checkout-new-customer-code">Loyalty code</label><input id="checkout-new-customer-code" maxlength={LOYALTY_CODE_MAX_LENGTH} spellcheck={false} autocapitalize="characters" required bind:value={draft.loyaltyCode} /><small>A code is generated for you. You can enter an existing loyalty card code.</small></div>
        </div>
    </fieldset>
    <p class="checkout-customer-note">Starts with 0 points. Pay later is not enabled automatically.</p>
    </div>
    <div class="checkout-customer-form-actions">
        <button type="button" class="btn btn-secondary" disabled={saving} on:click={onCancel}>Back to payment</button>
        <button type="submit" class="btn btn-primary" disabled={saving || offline}>{saving ? 'Saving…' : 'Save & select customer'}</button>
    </div>
</form>

<style>
    .checkout-customer-form { display: flex; flex-direction: column; flex: 1; gap: .85rem; min-width: 0; min-height: 0; }
    .checkout-customer-scroll { display: flex; flex-direction: column; gap: .85rem; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 4px; }
    fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
    .checkout-customer-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .85rem; }
    .span-all { grid-column: 1 / -1; }
    .field { min-width: 0; margin: 0; }
    .field input { box-sizing: border-box; min-width: 0; width: 100%; min-height: 44px; }
    .field small { color: var(--text-muted); font-size: .78rem; font-weight: 400; }
    .checkout-customer-intro, .checkout-customer-note { margin: 0; color: var(--text-muted); font-size: .85rem; line-height: 1.45; }
    .checkout-customer-error { margin: 0; border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent); border-radius: .5rem; padding: .7rem; color: var(--danger); background: color-mix(in srgb, var(--danger) 7%, var(--bg-panel)); overflow-wrap: anywhere; }
    .checkout-customer-form-actions { display: flex; flex-shrink: 0; gap: .65rem; border-top: 1px solid var(--border-flat); padding-top: .85rem; }
    .checkout-customer-form-actions > button { flex: 1; min-width: 0; white-space: normal; min-height: 44px; }
    @media (max-width: 430px) { .checkout-customer-fields { grid-template-columns: minmax(0,1fr); } .checkout-customer-form-actions { flex-direction: column-reverse; } }
</style>
