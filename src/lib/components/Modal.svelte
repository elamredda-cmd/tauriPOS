<script lang="ts">
    import { modalFocusTrap } from '$lib/actions/modalFocusTrap';

    export let show = false;
    export let title = '';
    export let width = '600px';
    export let height = 'auto';
    export let dismissDisabled = false;

    function requestClose() {
        if (!dismissDisabled) show = false;
    }

    function handleBackdropClick(event: MouseEvent) {
        if (event.target === event.currentTarget) requestClose();
    }
</script>

{#if show}
<div
    class="app-modal-overlay fixed inset-0 bg-[var(--overlay)] flex items-center justify-center z-[100] p-5"
    role="presentation"
    on:click={handleBackdropClick}
>
    <div
        use:modalFocusTrap={{ dismiss: requestClose, dismissDisabled }}
        class="app-modal-panel w-full max-h-full rounded-xl bg-bg-card border border-border-flat flex flex-col overflow-hidden shadow-[0_20px_60px_var(--shadow)]"
        style="max-width:{width};height:{height}"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-busy={dismissDisabled}
    >
        <div class="app-modal-header flex justify-between items-center border-b border-border-flat px-6 py-4 bg-bg-panel">
            <h2 class="m-0 text-xl font-bold text-text-main">{title}</h2>
            <button aria-label="Close dialog" class="btn-icon !w-10 !h-10 !shadow-none" disabled={dismissDisabled} on:click={requestClose}>✕</button>
        </div>
        <div class="app-modal-content flex-1 overflow-y-auto p-6">
            <slot />
        </div>
        <div class="app-modal-footer flex justify-end gap-3 px-6 py-4 border-t border-border-flat bg-bg-panel">
            <slot name="footer" />
        </div>
    </div>
</div>
{/if}
