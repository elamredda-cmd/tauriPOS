<script lang="ts">
    import { modalFocusTrap } from '$lib/actions/modalFocusTrap';
    import { toasts, removeToast, type ToastItem } from '$lib/stores/toast';
    $: items = $toasts;

    function headingFor(type: ToastItem['type']): string {
        if (type === 'success') return 'Done';
        if (type === 'error') return 'Something needs attention';
        return 'Please note';
    }

    function statusFor(type: ToastItem['type']): string {
        if (type === 'success') return 'Success';
        if (type === 'error') return 'Action needed';
        return 'Information';
    }

    async function handlePrint(t: ToastItem) {
        try {
            await t.onPrint?.();
        } finally {
            removeToast(t.id);
        }
    }
</script>

{#if items.length > 0}
    <div
        class="fixed inset-0 z-[9999] flex flex-col items-center justify-center gap-3 overflow-y-auto bg-[var(--overlay)] p-4 pointer-events-auto sm:p-6"
        aria-label="Notifications"
    >
        {#each items as t (t.id)}
            <section
                use:modalFocusTrap={{ dismiss: () => removeToast(t.id) }}
                class="toast-pop w-full max-w-[460px] shrink-0 overflow-hidden rounded-2xl border border-border-flat bg-bg-panel p-5 text-text-main shadow-[0_24px_70px_var(--shadow)] sm:p-6"
                role={t.type === 'error' ? 'alertdialog' : 'dialog'}
                aria-modal="true"
                aria-labelledby={`toast-title-${t.id}`}
                aria-describedby={`toast-message-${t.id}`}
            >
                <div class="flex items-start gap-3.5">
                    <span
                        class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border {t.type === 'success' ? 'border-success/20 bg-success/10 text-success' : t.type === 'error' ? 'border-danger/20 bg-danger/10 text-danger' : 'border-accent-primary/20 bg-accent-primary/10 text-accent-primary'}"
                        aria-hidden="true"
                    >
                        {#if t.type === 'success'}
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" class="h-6 w-6">
                                <path d="M20 6 9 17l-5-5" />
                            </svg>
                        {:else if t.type === 'error'}
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="h-6 w-6">
                                <path d="M10.3 3.5 2.7 17a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 3.5a2 2 0 0 0-3.4 0Z" />
                                <path d="M12 9v4" />
                                <path d="M12 17h.01" />
                            </svg>
                        {:else}
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="h-6 w-6">
                                <circle cx="12" cy="12" r="9" />
                                <path d="M12 11v5" />
                                <path d="M12 8h.01" />
                            </svg>
                        {/if}
                    </span>
                    <div class="min-w-0 flex-1 pt-0.5">
                        <span class="text-[0.68rem] font-black uppercase tracking-[0.12em] {t.type === 'success' ? 'text-success' : t.type === 'error' ? 'text-danger' : 'text-accent-primary'}">
                            {statusFor(t.type)}
                        </span>
                        <h2 id={`toast-title-${t.id}`} class="m-0 mt-1 text-lg font-black leading-tight">
                            {headingFor(t.type)}
                        </h2>
                    </div>
                    <button
                        type="button"
                        class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-transparent bg-transparent text-xl text-text-muted transition-colors hover:border-border-flat hover:bg-bg-card hover:text-text-main"
                        aria-label="Dismiss notification"
                        on:click={() => removeToast(t.id)}
                    >✕</button>
                </div>

                <p id={`toast-message-${t.id}`} class="mb-0 mt-4 break-words text-[0.98rem] font-semibold leading-relaxed text-text-main">
                    {t.message}
                </p>

                <div class="mt-5 flex w-full flex-col gap-2.5 sm:flex-row">
                    <button
                        type="button"
                        data-modal-initial-focus
                        class="btn btn-secondary flex-1"
                        on:click={() => removeToast(t.id)}
                    >OK</button>
                    {#if t.showPrint && t.onPrint}
                        <button
                            type="button"
                            class="btn btn-primary flex-1"
                            on:click={() => handlePrint(t)}
                        >Print receipt</button>
                    {/if}
                </div>
            </section>
        {/each}
    </div>
{/if}

<style>
    .toast-pop { animation: toast-pop-in 0.18s ease-out; }
    @keyframes toast-pop-in {
        from { transform: translateY(8px) scale(0.98); opacity: 0; }
        to   { transform: scale(1);   opacity: 1; }
    }

    @media (prefers-reduced-motion: reduce) {
        .toast-pop { animation: none; }
    }
</style>
