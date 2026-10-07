<script lang="ts">
    import { createEventDispatcher, tick } from 'svelte';
    import { clickOutside } from '$lib/utils/clickOutside';

    type SelectOption = { label: string, value: any, disabled?: boolean };

    export let value: any;
    export let options: SelectOption[] = [];
    export let placeholder = "Select option...";
    export let label = "";
    export let emptyText = "No options available";
    export let menuMinWidth = "100%";
    export let largeOptions = false;
    export let disabled = false;

    let isOpen = false;
    let triggerButton: HTMLButtonElement;
    let menuElement: HTMLDivElement;
    let openUpward = false;
    let menuMaxHeight = 240;
    let menuMaxWidth = 320;
    let menuOffset = 0;
    const dispatch = createEventDispatcher();

    $: selectedLabel = options.find(o => o.value === value)?.label || placeholder;
    $: if (disabled) isOpen = false;

    async function select(option: SelectOption) {
        if (option.disabled) return;
        const val = option.value;
        value = val;
        isOpen = false;
        dispatch('change', val);
        await tick();
        triggerButton?.focus({ preventScroll: true });
    }

    function enabledOptionButtons(): HTMLButtonElement[] {
        if (!menuElement) return [];
        return Array.from(menuElement.querySelectorAll<HTMLButtonElement>('.custom-select-option:not(:disabled)'));
    }

    function focusOption(option: HTMLButtonElement | undefined) {
        if (!option) return;
        option.focus({ preventScroll: true });
        option.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    function focusInitialOption(preferLast = false) {
        const enabled = enabledOptionButtons();
        if (enabled.length === 0) return;
        const selected = enabled.find((option) => option.getAttribute('aria-selected') === 'true');
        focusOption(selected || (preferLast ? enabled.at(-1) : enabled[0]));
    }

    async function open(preferLast = false) {
        if (disabled) return;

        const rect = triggerButton.getBoundingClientRect();
        // Menus must fit inside the visible part of a scrolling page or dialog.
        const bounds = { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };
        for (let ancestor = triggerButton.parentElement; ancestor; ancestor = ancestor.parentElement) {
            const style = getComputedStyle(ancestor);
            const box = ancestor.getBoundingClientRect();
            if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
                bounds.top = Math.max(bounds.top, box.top);
                bounds.bottom = Math.min(bounds.bottom, box.bottom);
            }
            if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
                bounds.left = Math.max(bounds.left, box.left);
                bounds.right = Math.min(bounds.right, box.right);
            }
            if (style.position === 'fixed') break;
        }
        const spaceBelow = bounds.bottom - rect.bottom - 12;
        const spaceAbove = rect.top - bounds.top - 12;
        openUpward = spaceBelow < 280 && spaceAbove > spaceBelow;
        const availableSpace = openUpward ? spaceAbove : spaceBelow;
        menuMaxHeight = Math.max(0, Math.min(360, availableSpace));
        menuMaxWidth = Math.max(0, bounds.right - bounds.left - 16);
        menuOffset = 0;
        isOpen = true;
        await tick();
        const menuRect = menuElement.getBoundingClientRect();
        menuOffset = Math.max(bounds.left + 8 - menuRect.left, Math.min(0, bounds.right - 8 - menuRect.right));
        await tick();
        focusInitialOption(preferLast);
    }

    function close(restoreTriggerFocus = false) {
        isOpen = false;
        if (restoreTriggerFocus) {
            void tick().then(() => triggerButton?.focus({ preventScroll: true }));
        }
    }

    function toggle() {
        if (disabled) return;
        if (isOpen) {
            close();
        } else {
            void open();
        }
    }

    function handleTriggerKeydown(event: KeyboardEvent) {
        if (disabled) return;
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (isOpen) {
                focusInitialOption(event.key === 'ArrowUp');
            } else {
                void open(event.key === 'ArrowUp');
            }
            return;
        }
        if (event.key === 'Escape' && isOpen) {
            event.preventDefault();
            close(true);
        }
    }

    function handleOptionKeydown(event: KeyboardEvent, option: SelectOption) {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            void select(option);
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close(true);
            return;
        }
        if (event.key === 'Tab') {
            close();
            return;
        }

        const enabled = enabledOptionButtons();
        if (enabled.length === 0) return;
        const current = event.currentTarget as HTMLButtonElement;
        const currentIndex = Math.max(0, enabled.indexOf(current));
        let next: HTMLButtonElement | undefined;
        if (event.key === 'ArrowDown') {
            next = enabled[(currentIndex + 1) % enabled.length];
        } else if (event.key === 'ArrowUp') {
            next = enabled[(currentIndex - 1 + enabled.length) % enabled.length];
        } else if (event.key === 'Home') {
            next = enabled[0];
        } else if (event.key === 'End') {
            next = enabled.at(-1);
        } else {
            return;
        }
        event.preventDefault();
        focusOption(next);
    }
</script>

<div class="relative w-full flex flex-col gap-1.5" use:clickOutside={() => close()}>
    {#if label}<span class="text-[0.8rem] text-text-muted font-black uppercase tracking-[0.045em]">{label}</span>{/if}
    <button 
        bind:this={triggerButton}
        class="custom-select-trigger w-full h-12 px-4 flex items-center justify-between gap-3 bg-bg-panel border rounded-lg text-text-main text-base cursor-pointer text-left transition-all duration-150 shadow-[0_8px_18px_var(--shadow)] {isOpen ? 'border-accent-primary bg-bg-card' : 'border-border-flat hover:border-accent-primary hover:bg-bg-card'}"
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        {disabled}
        on:click={toggle}
        on:keydown={handleTriggerKeydown}
    >
        <span class="truncate">{selectedLabel}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" class="transition-transform duration-200 opacity-50 {isOpen ? 'rotate-180' : ''}"><polyline points="6 9 12 15 18 9"></polyline></svg>
    </button>

    {#if isOpen}
        <div
            bind:this={menuElement}
            role="listbox"
            class="custom-select-menu absolute left-0 z-[1000] overflow-y-auto border border-border-flat shadow-[0_18px_45px_var(--shadow)] rounded-lg bg-bg-panel p-1.5 {openUpward ? 'bottom-[calc(100%+6px)]' : 'top-[calc(100%+6px)]'}"
            style="left: {menuOffset}px; min-width: min({menuMinWidth}, {menuMaxWidth}px); max-width: {menuMaxWidth}px; max-height: {menuMaxHeight}px;"
        >
            {#if options.length === 0}
                <div class="rounded-md px-3.5 py-3 text-sm font-semibold text-text-muted">{emptyText}</div>
            {:else}
                {#each options as opt}
                    <button
                        role="option"
                        aria-selected={value === opt.value}
                        tabindex="-1"
                        disabled={opt.disabled}
                        class="custom-select-option w-full flex items-center justify-between gap-3 rounded-md bg-transparent text-text-main cursor-pointer text-left hover:bg-bg-card-hover transition-colors disabled:cursor-not-allowed disabled:opacity-55 {largeOptions ? 'min-h-14 px-4 py-3.5 text-[1.05rem]' : 'p-3.5 text-base'} {value === opt.value ? 'bg-accent-primary/10 text-accent-primary font-bold' : ''}"
                        on:click={() => select(opt)}
                        on:keydown={(event) => handleOptionKeydown(event, opt)}
                    >
                        <span class="truncate">{opt.label}</span>
                        {#if value === opt.value}
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" width="16" class="text-accent-primary"><polyline points="20 6 9 17 4 12"></polyline></svg>
                        {/if}
                    </button>
                {/each}
            {/if}
        </div>
    {/if}
</div>

<style>
    .custom-select-trigger:focus-visible {
        border-color: var(--accent-primary);
        outline: 3px solid color-mix(in srgb, var(--accent-primary) 28%, transparent);
        outline-offset: 2px;
        box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent-primary) 22%, transparent), 0 8px 18px var(--shadow);
    }

    .custom-select-option:focus-visible {
        outline: 2px solid var(--accent-primary);
        outline-offset: -2px;
        background: color-mix(in srgb, var(--accent-primary) 13%, var(--bg-card));
    }

    .custom-select-menu {
        overscroll-behavior: contain;
        scrollbar-width: auto;
        scrollbar-color: var(--accent-primary) var(--bg-card);
    }

    .custom-select-menu::-webkit-scrollbar {
        width: 14px;
    }

    .custom-select-menu::-webkit-scrollbar-track {
        background: var(--bg-card);
        border-radius: 0.4rem;
    }

    .custom-select-menu::-webkit-scrollbar-thumb {
        background: var(--accent-primary);
        border: 3px solid var(--bg-card);
        border-radius: 0.4rem;
    }
</style>
