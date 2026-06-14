<script lang="ts">
    export let show = false;
    export let title = '';
    export let width = '600px';
    export let height = 'auto';

    function handleBackdropClick(event: MouseEvent) {
        if (event.target === event.currentTarget) show = false;
    }

    function handleKeydown(event: KeyboardEvent) {
        if (event.key === 'Escape') show = false;
    }
</script>

{#if show}
<div
    class="fixed inset-0 bg-[var(--overlay)] flex items-center justify-center z-[100] p-5"
    role="presentation"
    on:click={handleBackdropClick}
    on:keydown={handleKeydown}
>
    <div
        class="app-modal-panel w-full max-h-full rounded-md bg-bg-card flex flex-col overflow-hidden shadow-[var(--shadow)]"
        style="max-width:{width};height:{height}"
        role="dialog"
        aria-modal="true"
        aria-label={title}
    >
        <div class="app-modal-header flex justify-between items-center border-b border-border-flat px-6 py-4">
            <h2 class="m-0 text-xl font-semibold">{title}</h2>
            <button aria-label="Close dialog" class="bg-transparent text-text-muted text-xl border-none cursor-pointer" on:click={() => show = false}>✕</button>
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
