<script lang="ts">
    import { tick } from "svelte";
    import { Keyboard, Search, X } from "@lucide/svelte";
    import { deviceOperatingMode } from "$lib/deviceMode";

    export let id: string;
    export let value = "";
    export let placeholder = "Search...";
    export let ariaLabel = "Search";
    export let keyboardLabel = "Open search keyboard";
    export let clearLabel = "Clear search";
    export let disabled = false;
    export let showKeyboard = true;
    export let showClear = true;
    export let clearVisible: boolean | null = null;
    export let touchKeyboard: "button" | "off" | "auto" = "button";
    export let inputElement: HTMLInputElement | null = null;
    export let onInput: (event: Event & { currentTarget: HTMLInputElement }) => void = () => {};
    export let onKeydown: (event: KeyboardEvent & { currentTarget: HTMLInputElement }) => void = () => {};
    export let onClear: () => void = () => {};

    $: hasClear = showClear && (clearVisible ?? value.length > 0);
    $: keyboardVisible = showKeyboard && $deviceOperatingMode !== "back_office";
    $: touchKeyboardMode = $deviceOperatingMode === "back_office"
        ? "off"
        : showKeyboard ? touchKeyboard : touchKeyboard === "button" ? "auto" : touchKeyboard;

    function handleInput(event: Event & { currentTarget: HTMLInputElement }) {
        value = event.currentTarget.value;
        onInput(event);
    }

    async function clearSearch() {
        value = "";
        onClear();
        await tick();
        inputElement?.focus({ preventScroll: true });
    }

    function openKeyboard() {
        if (!inputElement || disabled || $deviceOperatingMode === "back_office") return;
        inputElement.focus({ preventScroll: true });
        document.dispatchEvent(new CustomEvent("open-touch-keyboard", { detail: { target: inputElement } }));
    }
</script>

<div
    class="app-search-field"
    class:has-keyboard={keyboardVisible}
    class:has-clear={hasClear}
    class:is-disabled={disabled}
>
    <span class="app-search-icon" aria-hidden="true">
        <Search size={20} strokeWidth={2.35} />
    </span>
    <input
        bind:this={inputElement}
        bind:value
        {id}
        type="text"
        class="search-input app-search-input"
        {placeholder}
        aria-label={ariaLabel}
        autocomplete="off"
        spellcheck="false"
        enterkeyhint="search"
        data-touch-keyboard={touchKeyboardMode === "auto" ? undefined : touchKeyboardMode}
        {disabled}
        on:input={handleInput}
        on:keydown={onKeydown}
    />

    {#if hasClear}
        <button
            type="button"
            class="app-search-action app-search-clear"
            aria-label={clearLabel}
            title={clearLabel}
            {disabled}
            on:click={clearSearch}
        >
            <X size={19} strokeWidth={2.5} aria-hidden="true" />
        </button>
    {/if}

    {#if keyboardVisible}
        <button
            type="button"
            class="app-search-action app-search-keyboard"
            aria-label={keyboardLabel}
            title={keyboardLabel}
            {disabled}
            on:click={openKeyboard}
        >
            <Keyboard size={20} strokeWidth={2.2} aria-hidden="true" />
        </button>
    {/if}
</div>

<style>
    .app-search-field {
        position: relative;
        min-width: 0;
        width: 100%;
    }

    .app-search-input {
        width: 100%;
        height: 48px;
        min-height: 48px;
        padding: .65rem 3rem .65rem 3rem !important;
        border-radius: .65rem !important;
        border-color: color-mix(in srgb, var(--border-flat) 82%, var(--text-muted)) !important;
        background: var(--bg-card) !important;
        font-size: .95rem !important;
        font-weight: 700 !important;
        line-height: 1.2;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, .045), 0 8px 20px var(--shadow) !important;
    }

    .app-search-field.has-keyboard.has-clear .app-search-input {
        padding-right: 6.25rem !important;
    }

    .app-search-field:not(.has-keyboard).has-clear .app-search-input {
        padding-right: 3rem !important;
    }

    .app-search-input:hover:not(:disabled) {
        border-color: color-mix(in srgb, var(--accent-primary) 72%, var(--border-flat)) !important;
    }

    .app-search-input:focus,
    .app-search-input:focus-visible {
        border-color: var(--accent-primary) !important;
        outline: 3px solid color-mix(in srgb, var(--accent-primary) 28%, transparent) !important;
        outline-offset: 2px;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, .055), 0 0 0 1px color-mix(in srgb, var(--accent-primary) 30%, transparent), 0 10px 24px var(--shadow) !important;
    }

    .app-search-icon {
        position: absolute;
        z-index: 2;
        top: 50%;
        left: .9rem;
        translate: 0 -50%;
        pointer-events: none;
        color: var(--text-muted);
        transition: color 140ms ease;
    }

    .app-search-field:focus-within .app-search-icon {
        color: var(--accent-primary);
    }

    .app-search-action {
        position: absolute;
        z-index: 3;
        top: 50%;
        width: 44px;
        height: 44px;
        display: grid;
        place-items: center;
        translate: 0 -50%;
        cursor: pointer;
        color: var(--text-muted);
        border: 1px solid transparent;
        border-radius: .5rem;
        background: transparent;
        touch-action: manipulation;
        transition: color 120ms ease, border-color 120ms ease, background-color 120ms ease, translate 80ms ease;
    }

    .app-search-keyboard {
        right: .125rem;
    }

    .app-search-clear {
        right: .125rem;
    }

    .app-search-field.has-keyboard .app-search-clear {
        right: 3rem;
    }

    .app-search-action:hover:not(:disabled),
    .app-search-action:focus-visible {
        color: var(--accent-primary);
        border-color: color-mix(in srgb, var(--accent-primary) 40%, var(--border-flat));
        background: color-mix(in srgb, var(--accent-primary) 11%, var(--bg-card));
    }

    .app-search-clear:hover:not(:disabled),
    .app-search-clear:focus-visible {
        color: var(--danger);
        border-color: color-mix(in srgb, var(--danger) 42%, var(--border-flat));
        background: color-mix(in srgb, var(--danger) 9%, var(--bg-card));
    }

    .app-search-action:focus-visible {
        outline: 3px solid color-mix(in srgb, var(--accent-primary) 30%, transparent);
        outline-offset: 1px;
    }

    .app-search-clear:focus-visible {
        outline-color: color-mix(in srgb, var(--danger) 30%, transparent);
    }

    .app-search-action:active:not(:disabled) {
        translate: 0 calc(-50% + 1px);
    }

    .app-search-field.is-disabled {
        opacity: .55;
    }

    .app-search-input:disabled,
    .app-search-action:disabled {
        cursor: not-allowed;
    }

</style>
