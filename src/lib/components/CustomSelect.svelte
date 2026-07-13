<script lang="ts">
    import { createEventDispatcher } from 'svelte';
    import { clickOutside } from '$lib/utils/clickOutside';

    type SelectOption = { label: string, value: any, disabled?: boolean };

    export let value: any;
    export let options: SelectOption[] = [];
    export let placeholder = "Select option...";
    export let label = "";
    export let emptyText = "No options available";
    export let menuMinWidth = "100%";
    export let largeOptions = false;

    let isOpen = false;
    let triggerButton: HTMLButtonElement;
    let openUpward = false;
    let menuMaxHeight = 240;
    const dispatch = createEventDispatcher();

    $: selectedLabel = options.find(o => o.value === value)?.label || placeholder;

    function select(option: SelectOption) {
        if (option.disabled) return;
        const val = option.value;
        value = val;
        isOpen = false;
        dispatch('change', val);
    }

    function toggle() {
        if (isOpen) {
            isOpen = false;
            return;
        }

        const rect = triggerButton.getBoundingClientRect();
        const viewportHeight = window.innerHeight;
        const spaceBelow = viewportHeight - rect.bottom - 12;
        const spaceAbove = rect.top - 12;
        openUpward = spaceBelow < 280 && spaceAbove > spaceBelow;
        const availableSpace = openUpward ? spaceAbove : spaceBelow;
        menuMaxHeight = Math.max(160, Math.min(360, availableSpace - 8));
        isOpen = true;
    }
</script>

<div class="relative w-full flex flex-col gap-1.5" use:clickOutside={() => isOpen = false}>
    {#if label}<span class="text-[0.8rem] text-text-muted font-black uppercase tracking-[0.045em]">{label}</span>{/if}
    <button 
        bind:this={triggerButton}
        class="w-full h-12 px-4 flex items-center justify-between gap-3 bg-bg-panel border rounded-lg text-text-main text-base cursor-pointer text-left transition-all duration-150 shadow-[0_8px_18px_var(--shadow)] {isOpen ? 'border-accent-primary bg-bg-card' : 'border-border-flat hover:border-accent-primary hover:bg-bg-card'}" 
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        on:click={toggle}
    >
        <span class="truncate">{selectedLabel}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" class="transition-transform duration-200 opacity-50 {isOpen ? 'rotate-180' : ''}"><polyline points="6 9 12 15 18 9"></polyline></svg>
    </button>

    {#if isOpen}
        <div
            role="listbox"
            class="custom-select-menu absolute left-0 z-[1000] overflow-y-auto border border-border-flat shadow-[0_18px_45px_var(--shadow)] rounded-lg bg-bg-panel p-1.5 {openUpward ? 'bottom-[calc(100%+6px)]' : 'top-[calc(100%+6px)]'}"
            style="min-width: {menuMinWidth}; max-width: calc(100vw - 1rem); max-height: {menuMaxHeight}px;"
        >
            {#if options.length === 0}
                <div class="rounded-md px-3.5 py-3 text-sm font-semibold text-text-muted">{emptyText}</div>
            {:else}
                {#each options as opt}
                    <button
                        role="option"
                        aria-selected={value === opt.value}
                        disabled={opt.disabled}
                        class="w-full flex items-center justify-between gap-3 rounded-md bg-transparent text-text-main cursor-pointer text-left hover:bg-bg-card-hover transition-colors disabled:cursor-not-allowed disabled:opacity-55 {largeOptions ? 'min-h-14 px-4 py-3.5 text-[1.05rem]' : 'p-3.5 text-base'} {value === opt.value ? 'bg-accent-primary/10 text-accent-primary font-bold' : ''}"
                        on:click={() => select(opt)}
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
