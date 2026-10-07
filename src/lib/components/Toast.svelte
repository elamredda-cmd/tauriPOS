<script lang="ts">
    import { modalFocusTrap } from '$lib/actions/modalFocusTrap';
    import { toasts, removeToast, isBlockingToast, isCashCompletion, isScanDismissibleToast, type ToastItem } from '$lib/stores/toast';
    import { formatMoney } from '$lib/stores/db';
    import { deviceOperatingMode } from '$lib/deviceMode';
    $: items = $toasts;
    $: notices = items.filter((item) => !isBlockingToast(item));
    $: prompts = items.filter(isBlockingToast);

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

{#if notices.length > 0}
    <div class="notification-stack" class:desktop={$deviceOperatingMode === 'back_office'} aria-label="Notifications" aria-live="polite" aria-relevant="additions">
        {#each notices as notice (notice.id)}
            <section class="notification-card" role="status">
                <span class="notification-status" aria-hidden="true">{notice.type === 'success' ? '✓' : 'i'}</span>
                <p>{notice.message}</p>
                <button type="button" aria-label="Dismiss notification" on:click={() => removeToast(notice.id)}>✕</button>
            </section>
        {/each}
    </div>
{/if}

{#if prompts.length > 0}
    <div
        class="fixed inset-0 z-[9999] flex flex-col items-center justify-center gap-3 overflow-y-auto bg-[var(--overlay)] p-4 pointer-events-auto sm:p-6"
        aria-label="Notifications"
    >
        {#each prompts as t (t.id)}
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
                            {isCashCompletion(t) ? 'Sale complete' : headingFor(t.type)}
                        </h2>
                    </div>
                    <button
                        type="button"
                        class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-transparent bg-transparent text-xl text-text-muted transition-colors hover:border-border-flat hover:bg-bg-card hover:text-text-main"
                        aria-label="Dismiss notification"
                        on:click={() => removeToast(t.id)}
                    >✕</button>
                </div>

                {#if isCashCompletion(t)}
                    <div class="cash-change-result" role="status" aria-live="assertive" aria-atomic="true">
                        <span>{t.cashChangePence === 0 ? 'No change due' : 'Change to give'}</span>
                        <strong>{formatMoney(t.cashChangePence!)}</strong>
                    </div>
                {/if}

                <p id={`toast-message-${t.id}`} class="mb-0 mt-4 break-words text-[0.98rem] font-semibold leading-relaxed text-text-main">
                    {t.message}
                </p>
                {#if isScanDismissibleToast(t)}
                    <p class="mb-0 mt-2 text-sm text-text-muted">Scan the next item to start a new sale.</p>
                {/if}

                <div class="mt-5 flex w-full flex-col gap-2.5 sm:flex-row">
                    <button
                        type="button"
                        data-modal-initial-focus
                        class="btn btn-secondary flex-1"
                        on:click={() => removeToast(t.id)}
                    >{isCashCompletion(t) ? 'Done · next customer' : 'OK'}</button>
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
    .cash-change-result { display: flex; flex-direction: column; align-items: center; gap: .35rem; margin-top: 1.1rem; padding: 1.2rem .75rem; border: 2px solid var(--success); border-radius: .85rem; background: rgba(var(--success-rgb), .12); text-align: center; }
    .cash-change-result > span { color: var(--text-main); font-size: 1rem; font-weight: 700; }
    .cash-change-result > strong { color: var(--text-main); font-family: var(--app-font-mono); font-size: clamp(2.75rem, 8vw, 4.5rem); font-weight: 900; line-height: 1.1; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; max-width: 100%; }
    .notification-stack { position: fixed; right: 1rem; top: max(1rem, env(safe-area-inset-top)); z-index: 9998; display: flex; flex-direction: column; gap: .6rem; width: min(420px, calc(100vw - 2rem)); max-height: min(40dvh, 400px); overflow-y: auto; pointer-events: none; }
    .notification-card { display: grid; grid-template-columns: 28px minmax(0,1fr) 44px; align-items: center; gap: .65rem; padding: .65rem .75rem; border: 1px solid var(--border-flat); border-radius: .65rem; background: var(--bg-card); color: var(--text-main); box-shadow: 0 6px 24px var(--shadow); pointer-events: none; }
    .notification-status { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; color: var(--accent-primary); background: color-mix(in srgb, var(--accent-primary) 12%, var(--bg-panel)); font-weight: 700; }
    .notification-card p { margin: 0; font-size: .86rem; line-height: 1.45; overflow-wrap: anywhere; }
    .notification-card button { width: 44px; height: 44px; display: grid; place-items: center; color: var(--text-muted); background: transparent; border: 0; border-radius: .4rem; cursor: pointer; pointer-events: auto; }
    .notification-card button:hover { color: var(--text-main); background: var(--bg-card-hover); }
    .notification-card button:focus-visible { outline: 2px solid var(--accent-primary); }
    .notification-stack.desktop .notification-card { grid-template-columns: 28px minmax(0,1fr) 32px; }
    .notification-stack.desktop button { width: 32px; height: 32px; }
    @media print { .notification-stack { display: none; } }
    .toast-pop { animation: toast-pop-in 0.18s ease-out; }
    @keyframes toast-pop-in {
        from { transform: translateY(8px) scale(0.98); opacity: 0; }
        to   { transform: scale(1);   opacity: 1; }
    }

    @media (prefers-reduced-motion: reduce) {
        .toast-pop { animation: none; }
    }
</style>
