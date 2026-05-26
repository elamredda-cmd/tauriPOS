<script lang="ts">
    import { toasts, removeToast } from '$lib/stores/toast';
    $: items = $toasts;
</script>

{#if items.length > 0}
<div
    class="fixed inset-0 z-[9999] flex flex-col items-center justify-center gap-4 pointer-events-auto"
    style="background: var(--overlay);"
>
    {#each items as t (t.id)}
        <div
            class="toast-pop p-10 rounded-sm font-bold text-[1.6rem] flex flex-col gap-8 min-w-[450px] min-h-[300px] justify-center items-center bg-bg-panel border border-border-flat text-text-main"
            style="box-shadow: 0 10px 40px var(--shadow);"
        >
            <div class="flex flex-col items-center gap-5 text-center flex-1 justify-center">
                <span
                    class="text-[3rem] {t.type === 'success' ? 'text-success' : t.type === 'error' ? 'text-danger' : 'text-accent-primary'}"
                >{t.type === 'success' ? '✓' : t.type === 'error' ? '✕' : 'ℹ'}</span>
                <span>{t.message}</span>
            </div>
            <div class="flex gap-3 w-full">
                <button
                    class="flex-1 p-4 text-[1.4rem] font-bold rounded-sm cursor-pointer border border-border-flat bg-bg-card text-text-main transition-colors hover:bg-bg-card-hover"
                    on:click={() => removeToast(t.id)}
                >OK</button>
                {#if t.showPrint}
                    <button
                        class="flex-1 p-4 text-[1.4rem] font-bold rounded-sm cursor-pointer border border-accent-primary bg-accent-primary text-white transition-colors hover:bg-accent-primary-hover"
                        on:click={() => { console.log('Print receipt'); removeToast(t.id); }}
                    >Print Receipt</button>
                {/if}
            </div>
        </div>
    {/each}
</div>
{/if}

<style>
    /* Tailwind has no first-class popIn animation; keep one tiny scoped keyframe. */
    .toast-pop { animation: toast-pop-in 0.2s ease-out; }
    @keyframes toast-pop-in {
        from { transform: scale(0.9); opacity: 0; }
        to   { transform: scale(1);   opacity: 1; }
    }
</style>
