<script lang="ts">
    export let targetId: string;
    export let label = "Open touch keyboard";
    export let className = "";
    export let embedded = false;

    function openKeyboard() {
        const target = document.getElementById(targetId);
        if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
        target.focus({ preventScroll: true });
        document.dispatchEvent(new CustomEvent("open-touch-keyboard", { detail: { target } }));
    }
</script>

<button
    type="button"
    class="grid h-11 w-11 shrink-0 place-items-center rounded-md border border-border-flat bg-bg-card text-text-main shadow-[0_2px_0_var(--border-flat)] hover:border-accent-primary hover:bg-bg-card-hover active:translate-y-px active:shadow-none {embedded ? '!absolute !right-1 !top-1/2 !h-9 !w-9 !-translate-y-1/2 !border-0 !bg-transparent !shadow-none hover:!bg-bg-card-hover' : ''} {className}"
    title={label}
    aria-label={label}
    on:click={openKeyboard}
>
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="2" y="6" width="20" height="12" rx="2"></rect>
        <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M10 14h4"></path>
    </svg>
</button>
