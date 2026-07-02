<script lang="ts">
    export let value = "";
    export let maxLength = 8;
    export let masked = false;
    export let submitLabel = "Enter";
    export let submitDisabled = false;
    export let allowDecimal = false;
    export let placeholder = "Enter number";
    export let max: number | null = null;
    export let onSubmit: () => void = () => {};

    function press(key: string) {
        if (key === "clear") {
            value = "";
        } else if (key === "backspace") {
            value = value.slice(0, -1);
        } else if (key === "." && (!allowDecimal || value.includes("."))) {
            return;
        } else if (value.length < maxLength) {
            append(key);
        }
    }

    function append(key: string) {
        const next = `${value}${key}`;
        if (!isWithinBounds(next)) return;
        value = next;
    }

    function isWithinBounds(next: string): boolean {
        if (!next || next === ".") return true;
        const numeric = Number(next);
        if (!Number.isFinite(numeric)) return false;
        if (max !== null && numeric > max) return false;
        return true;
    }
</script>

<div class="digit-pad flex flex-col gap-[.55rem]">
    <div
        class="digit-display flex h-[58px] min-h-[58px] items-center justify-center overflow-hidden whitespace-nowrap rounded-[.65rem] border border-border-flat bg-bg-panel px-4 py-[.7rem] text-[1.65rem] font-black leading-none tracking-[.35em] text-text-main [@media(max-height:700px)]:h-[46px] [@media(max-height:700px)]:min-h-[46px] [@media(max-height:700px)]:text-[1.3rem]"
        aria-label="Entered digits"
    >
        {#if value}
            {masked ? "●".repeat(value.length) : value}
        {:else}
            <span class="flex h-full items-center text-[.85rem] font-bold leading-none tracking-normal text-text-muted">{placeholder}</span>
        {/if}
    </div>
    <div class="grid gap-[.45rem] {allowDecimal ? 'grid-cols-4' : 'grid-cols-3'}">
        {#each ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as key}
            <button
                type="button"
                class="min-h-[62px] rounded-[.65rem] border border-border-flat bg-bg-panel text-[1.35rem] font-black text-text-main shadow-[0_2px_0_var(--border-flat)] active:translate-y-px active:shadow-none [@media(max-height:700px)]:min-h-12"
                on:click={() => press(key)}
            >{key}</button>
        {/each}
        <button
            type="button"
            class="min-h-[62px] rounded-[.65rem] border border-border-flat bg-bg-panel text-[.8rem] font-black text-danger shadow-[0_2px_0_var(--border-flat)] active:translate-y-px active:shadow-none [@media(max-height:700px)]:min-h-12"
            on:click={() => press("clear")}
        >Clear</button>
        <button
            type="button"
            class="min-h-[62px] rounded-[.65rem] border border-border-flat bg-bg-panel text-[1.35rem] font-black text-text-main shadow-[0_2px_0_var(--border-flat)] active:translate-y-px active:shadow-none [@media(max-height:700px)]:min-h-12"
            on:click={() => press("0")}
        >0</button>
        {#if allowDecimal}
            <button
                type="button"
                class="min-h-[62px] rounded-[.65rem] border border-border-flat bg-bg-panel text-[1.35rem] font-black text-text-main shadow-[0_2px_0_var(--border-flat)] active:translate-y-px active:shadow-none [@media(max-height:700px)]:min-h-12"
                on:click={() => press(".")}
            >.</button>
            <button
                type="button"
                class="min-h-[62px] rounded-[.65rem] border border-border-flat bg-bg-panel text-[1.35rem] font-black text-text-main shadow-[0_2px_0_var(--border-flat)] active:translate-y-px active:shadow-none [@media(max-height:700px)]:min-h-12"
                on:click={() => press("backspace")}
            >⌫</button>
        {:else}
            <button
                type="button"
                class="min-h-[62px] rounded-[.65rem] border border-border-flat bg-bg-panel text-[1.35rem] font-black text-text-main shadow-[0_2px_0_var(--border-flat)] active:translate-y-px active:shadow-none [@media(max-height:700px)]:min-h-12"
                on:click={() => press("backspace")}
            >⌫</button>
        {/if}
    </div>
    <button
        type="button"
        class="min-h-[54px] rounded-[.65rem] border-0 bg-accent-primary text-base font-black text-white disabled:opacity-35 [@media(max-height:700px)]:min-h-[46px]"
        disabled={submitDisabled}
        on:click={onSubmit}
    >{submitLabel}</button>
</div>
