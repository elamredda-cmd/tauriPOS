<script lang="ts">
    export let value = "";
    export let maxLength = 8;
    export let masked = false;
    export let submitLabel = "Enter";
    export let submitDisabled = false;
    export let allowDecimal = false;
    export let placeholder = "Enter number";
    export let onSubmit: () => void = () => {};

    function press(key: string) {
        if (key === "clear") {
            value = "";
        } else if (key === "backspace") {
            value = value.slice(0, -1);
        } else if (value.length < maxLength) {
            value += key;
        }
    }
</script>

<div class="digit-pad">
    <div class="digit-display" aria-label="Entered digits">
        {#if value}
            {masked ? "●".repeat(value.length) : value}
        {:else}
            <span>{placeholder}</span>
        {/if}
    </div>
    <div class="digit-grid" class:decimal-grid={allowDecimal}>
        {#each ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as key}
            <button type="button" on:click={() => press(key)}>{key}</button>
        {/each}
        <button type="button" class="clear" on:click={() => press("clear")}>Clear</button>
        <button type="button" on:click={() => press("0")}>0</button>
        {#if allowDecimal}
            <button type="button" on:click={() => !value.includes(".") && press(".")}>.</button>
            <button type="button" on:click={() => press("backspace")}>⌫</button>
        {:else}
            <button type="button" on:click={() => press("backspace")}>⌫</button>
        {/if}
    </div>
    <button type="button" class="submit" disabled={submitDisabled} on:click={onSubmit}>{submitLabel}</button>
</div>

<style>
    .digit-pad { display: flex; flex-direction: column; gap: .55rem; }
    .digit-display { height: 58px; min-height: 58px; padding: .7rem 1rem; display: flex; align-items: center; justify-content: center; overflow: hidden; color: var(--text-main); font-size: 1.65rem; font-weight: 900; line-height: 1; letter-spacing: .35em; white-space: nowrap; border: 1px solid var(--border-flat); border-radius: .65rem; background: var(--bg-panel); }
    .digit-display span { display: flex; align-items: center; height: 100%; color: var(--text-muted); font-size: .85rem; font-weight: 700; line-height: 1; letter-spacing: normal; }
    .digit-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: .45rem; }
    .digit-grid.decimal-grid { grid-template-columns: repeat(4, 1fr); }
    .digit-grid button { min-height: 62px; color: var(--text-main); font-size: 1.35rem; font-weight: 900; border: 1px solid var(--border-flat); border-radius: .65rem; background: var(--bg-panel); box-shadow: 0 2px 0 color-mix(in srgb, var(--border-flat) 75%, transparent); }
    .digit-grid button:active { transform: translateY(1px); box-shadow: none; }
    .digit-grid .clear { color: var(--danger); font-size: .8rem; }
    .submit { min-height: 54px; color: white; font-size: 1rem; font-weight: 900; border: 0; border-radius: .65rem; background: var(--accent-primary); }
    .submit:disabled { opacity: .35; }
    @media (max-height: 700px) {
        .digit-grid button { min-height: 48px; }
        .digit-display { height: 46px; min-height: 46px; font-size: 1.3rem; }
        .submit { min-height: 46px; }
    }
</style>
