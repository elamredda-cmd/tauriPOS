<script lang="ts">
    export let show = false;
    export let title = '';
    export let width = '600px';
</script>

{#if show}
<div class="fixed inset-0 bg-[var(--overlay)] flex items-center justify-center z-[100] p-5" on:click={() => show = false}>
    <div class="w-full max-h-full rounded-md bg-bg-card flex flex-col overflow-hidden shadow-[var(--shadow)]" style="max-width:{width}" on:click|stopPropagation>
        <div class="flex justify-between items-center border-b border-border-flat px-6 py-4">
            <h2 class="m-0 text-xl font-semibold">{title}</h2>
            <button class="bg-transparent text-text-muted text-xl border-none cursor-pointer" on:click={() => show = false}>✕</button>
        </div>
        <div class="flex-1 overflow-y-auto p-6">
            <slot />
        </div>
        <div class="flex justify-end gap-3 px-6 py-4 border-t border-border-flat bg-bg-panel">
            <slot name="footer" />
        </div>
    </div>
</div>
{/if}
