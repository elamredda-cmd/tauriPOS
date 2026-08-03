<script lang="ts">
    import Modal from './Modal.svelte';
    import { createEventDispatcher } from 'svelte';

    export let show = false;
    export let title = "Confirm Action";
    export let message = "Are you sure you want to proceed?";
    export let confirmText = "Confirm";
    export let cancelText = "Cancel";
    export let variant: 'danger' | 'primary' = 'primary';

    const dispatch = createEventDispatcher();

    function onConfirm() {
        dispatch('confirm');
        show = false;
    }
    function onCancel() {
        dispatch('cancel');
        show = false;
    }
</script>

<Modal bind:show {title} width="400px">
    <div class="py-2">
        <p class="text-text-muted leading-relaxed text-lg">{message}</p>
    </div>
    <div slot="footer" class="flex gap-3 w-full justify-end">
        <button class="btn btn-secondary min-w-[112px]" on:click={onCancel}>{cancelText}</button>
        <button
            class="btn min-w-[112px] {variant === 'danger' ? 'btn-danger' : 'btn-primary'}"
            on:click={onConfirm}
        >
            {confirmText}
        </button>
    </div>
</Modal>
