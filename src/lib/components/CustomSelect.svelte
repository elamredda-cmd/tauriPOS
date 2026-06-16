<script lang="ts">
    import { createEventDispatcher } from 'svelte';
    import { clickOutside } from '$lib/utils/clickOutside';

    export let value: any;
    export let options: { label: string, value: any }[] = [];
    export let placeholder = "Select option...";
    export let label = "";

    let isOpen = false;
    const dispatch = createEventDispatcher();

    $: selectedLabel = options.find(o => o.value === value)?.label || placeholder;

    function select(val: any) {
        value = val;
        isOpen = false;
        dispatch('change', val);
    }
</script>

<div class="relative w-full flex flex-col gap-1.5" use:clickOutside={() => isOpen = false}>
    {#if label}<span class="text-[0.8rem] text-text-muted font-black uppercase tracking-[0.045em]">{label}</span>{/if}
    <button 
        class="w-full h-12 px-4 flex items-center justify-between gap-3 bg-bg-panel border rounded-lg text-text-main text-base cursor-pointer text-left transition-all duration-150 shadow-[0_8px_18px_color-mix(in_srgb,var(--shadow)_18%,transparent)] {isOpen ? 'border-accent-primary bg-bg-card' : 'border-border-flat hover:border-accent-primary hover:bg-bg-card'}" 
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        on:click={() => isOpen = !isOpen}
    >
        <span class="truncate">{selectedLabel}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" class="transition-transform duration-200 opacity-50 {isOpen ? 'rotate-180' : ''}"><polyline points="6 9 12 15 18 9"></polyline></svg>
    </button>

    {#if isOpen}
        <div role="listbox" class="absolute top-[calc(100%+6px)] left-0 right-0 z-[1000] max-h-60 overflow-y-auto border border-border-flat shadow-[0_18px_45px_var(--shadow)] rounded-lg bg-bg-panel p-1">
            {#each options as opt}
                <button 
                    role="option"
                    aria-selected={value === opt.value}
                    class="w-full p-3.5 flex items-center justify-between gap-3 rounded-md bg-transparent text-text-main text-base cursor-pointer text-left hover:bg-bg-card-hover transition-colors {value === opt.value ? 'bg-accent-primary/10 text-accent-primary font-bold' : ''}" 
                    on:click={() => select(opt.value)}
                >
                    <span class="truncate">{opt.label}</span>
                    {#if value === opt.value}
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" width="16" class="text-accent-primary"><polyline points="20 6 9 17 4 12"></polyline></svg>
                    {/if}
                </button>
            {/each}
        </div>
    {/if}
</div>
