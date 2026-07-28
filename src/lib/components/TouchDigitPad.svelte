<script lang="ts">
    import { Delete as DeleteIcon } from "@lucide/svelte";

    export let value = "";
    export let maxLength = 8;
    export let masked = false;
    export let submitLabel = "Enter";
    export let submitDisabled = false;
    export let disabled = false;
    export let allowDecimal = false;
    export let placeholder = "Enter number";
    export let max: number | null = null;
    export let onSubmit: () => void = () => {};

    const digits = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

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

    $: outputLabel = masked
        ? `${placeholder}: ${value.length ? `${value.length} digits entered` : "no digits entered"}`
        : `${placeholder}: ${value || "empty"}`;
</script>

<div
    class="digit-pad"
    role="group"
    aria-label={allowDecimal ? "Decimal number pad" : "Number pad"}
    aria-disabled={disabled}
>
    <div class="digit-display-row">
        <output
            class="digit-display"
            class:is-empty={!value}
            class:is-masked={masked && Boolean(value)}
            aria-label={outputLabel}
            aria-live="polite"
            aria-atomic="true"
        >
            {#if value}
                {masked ? "●".repeat(value.length) : value}
            {:else}
                <span>{placeholder}</span>
            {/if}
        </output>

        {#if allowDecimal}
            <button
                type="button"
                class="digit-action digit-clear"
                disabled={disabled || !value}
                aria-label="Clear entered number"
                on:click={() => press("clear")}
            >Clear</button>
        {/if}
    </div>

    <div class="digit-grid" role="group" aria-label="Digits and editing controls">
        {#each digits as key}
            <button
                type="button"
                class="digit-key"
                disabled={disabled}
                aria-label={`Enter ${key}`}
                on:click={() => press(key)}
            >{key}</button>
        {/each}

        {#if allowDecimal}
            <button
                type="button"
                class="digit-key digit-decimal"
                disabled={disabled || value.includes(".")}
                aria-label="Enter decimal point"
                on:click={() => press(".")}
            >.</button>
        {:else}
            <button
                type="button"
                class="digit-key digit-clear"
                disabled={disabled || !value}
                aria-label="Clear entered number"
                on:click={() => press("clear")}
            >Clear</button>
        {/if}

        <button
            type="button"
            class="digit-key"
            disabled={disabled}
            aria-label="Enter 0"
            on:click={() => press("0")}
        >0</button>

        <button
            type="button"
            class="digit-key digit-delete"
            disabled={disabled || !value}
            aria-label="Delete last digit"
            title="Delete last digit"
            on:click={() => press("backspace")}
        >
            <DeleteIcon size={25} strokeWidth={2.35} aria-hidden="true" />
        </button>
    </div>

    <button
        type="button"
        class="digit-submit"
        disabled={submitDisabled || disabled}
        on:click={onSubmit}
    >{submitLabel}</button>
</div>

<style>
    .digit-pad {
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: .6rem;
    }

    .digit-display-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: .55rem;
    }

    .digit-display {
        min-width: 0;
        min-height: 60px;
        display: flex;
        align-items: center;
        justify-content: flex-end;
        overflow: hidden;
        border: 1px solid color-mix(in srgb, var(--accent-primary) 45%, var(--border-flat));
        border-radius: .65rem;
        background: var(--bg-card);
        padding: .65rem 1rem;
        color: var(--text-main);
        font-family: var(--app-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
        font-size: 1.8rem;
        font-weight: 900;
        letter-spacing: .015em;
        line-height: 1;
        text-align: right;
        text-overflow: ellipsis;
        white-space: nowrap;
        box-shadow: inset 0 1px 0 color-mix(in srgb, white 4%, transparent);
    }

    .digit-display.is-masked {
        letter-spacing: .28em;
    }

    .digit-display.is-empty {
        justify-content: center;
        color: var(--text-muted);
        font-family: inherit;
        font-size: .82rem;
        font-weight: 800;
        letter-spacing: normal;
        text-align: center;
    }

    .digit-grid {
        min-height: 0;
        flex: 1;
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        grid-template-rows: repeat(4, minmax(52px, 1fr));
        gap: .55rem;
    }

    .digit-key,
    .digit-action,
    .digit-submit {
        appearance: none;
        min-width: 0;
        min-height: 52px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: .65rem;
        font-weight: 900;
        touch-action: manipulation;
        user-select: none;
        transition: border-color 120ms ease, background-color 120ms ease, color 120ms ease, box-shadow 120ms ease, translate 80ms ease;
    }

    .digit-key {
        border: 1px solid color-mix(in srgb, var(--border-flat) 80%, var(--text-muted));
        background: color-mix(in srgb, var(--bg-card) 76%, var(--bg-panel));
        color: var(--text-main);
        font-family: var(--app-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
        font-size: 1.45rem;
        box-shadow: inset 0 -2px 0 color-mix(in srgb, var(--border-flat) 72%, transparent);
    }

    .digit-action {
        width: 78px;
        border: 1px solid color-mix(in srgb, var(--danger) 45%, var(--border-flat));
        background: color-mix(in srgb, var(--danger) 7%, var(--bg-card));
        color: var(--danger);
        font-size: .76rem;
    }

    .digit-clear {
        color: var(--danger);
        border-color: color-mix(in srgb, var(--danger) 45%, var(--border-flat));
        background: color-mix(in srgb, var(--danger) 7%, var(--bg-card));
        font-family: inherit;
        font-size: .76rem;
        letter-spacing: .02em;
    }

    .digit-decimal {
        color: var(--accent-primary);
    }

    .digit-delete {
        color: var(--warning);
        border-color: color-mix(in srgb, var(--warning) 42%, var(--border-flat));
        background: color-mix(in srgb, var(--warning) 8%, var(--bg-card));
    }

    .digit-submit {
        border: 1px solid color-mix(in srgb, var(--accent-primary) 75%, white 12%);
        background: var(--accent-primary);
        color: white;
        font-size: 1rem;
        box-shadow: inset 0 -2px 0 color-mix(in srgb, black 20%, transparent);
    }

    .digit-key:hover:not(:disabled),
    .digit-key:focus-visible {
        border-color: var(--accent-primary);
        background: color-mix(in srgb, var(--accent-primary) 12%, var(--bg-card));
    }

    .digit-clear:hover:not(:disabled),
    .digit-clear:focus-visible {
        border-color: var(--danger);
        background: var(--danger);
        color: white;
    }

    .digit-delete:hover:not(:disabled),
    .digit-delete:focus-visible {
        border-color: var(--warning);
        background: color-mix(in srgb, var(--warning) 15%, var(--bg-card));
    }

    .digit-submit:hover:not(:disabled),
    .digit-submit:focus-visible {
        filter: brightness(1.08);
    }

    .digit-key:focus-visible,
    .digit-action:focus-visible,
    .digit-submit:focus-visible {
        outline: 3px solid color-mix(in srgb, var(--accent-primary) 35%, transparent);
        outline-offset: 2px;
    }

    .digit-clear:focus-visible {
        outline-color: color-mix(in srgb, var(--danger) 35%, transparent);
    }

    .digit-delete:focus-visible {
        outline-color: color-mix(in srgb, var(--warning) 35%, transparent);
    }

    .digit-key:active:not(:disabled),
    .digit-action:active:not(:disabled),
    .digit-submit:active:not(:disabled) {
        translate: 0 1px;
        box-shadow: inset 0 -1px 0 var(--border-flat);
    }

    .digit-key:disabled,
    .digit-action:disabled,
    .digit-submit:disabled {
        cursor: not-allowed;
        opacity: .38;
        box-shadow: none;
    }

    @media (max-height: 700px) {
        .digit-pad {
            gap: .4rem;
        }

        .digit-display-row,
        .digit-grid {
            gap: .4rem;
        }

        .digit-display {
            min-height: 48px;
            padding-block: .45rem;
            font-size: 1.4rem;
        }

        .digit-display.is-empty {
            font-size: .76rem;
        }

        .digit-grid {
            grid-template-rows: repeat(4, minmax(44px, 1fr));
        }

        .digit-key,
        .digit-action,
        .digit-submit {
            min-height: 44px;
        }

        .digit-key {
            font-size: 1.2rem;
        }
    }

    @media (max-width: 360px) {
        .digit-pad,
        .digit-display-row,
        .digit-grid {
            gap: .4rem;
        }

        .digit-action {
            width: 68px;
        }
    }
</style>
