<script lang="ts">
    import ConfirmDialog from './ConfirmDialog.svelte';
    export let decide: ((retry: boolean) => void) | null = null;
    $: show = decide !== null;
    function choose(retry: boolean) {
        const callback = decide;
        decide = null;
        callback?.(retry);
    }
</script>

<ConfirmDialog bind:show title="Card not approved"
    message="The card payment was declined. Try another card for this same payment, or return to choose another payment method."
    confirmText="Try another card" cancelText="Return to payment" dismissDisabled
    on:confirm={() => choose(true)} on:cancel={() => choose(false)} />
