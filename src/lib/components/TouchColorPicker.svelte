<script lang="ts">
    export let value = "#3b82f6";
    export let label = "Color";

    const colors = [
        "#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6", 
        "#ec4899", "#06b6d4", "#f97316", "#64748b", "#22c55e",
        "#000000", "#475569", "#7c3aed", "#db2777", "#ea580c"
    ];

    function select(c: string) {
        value = c;
    }
</script>

<fieldset class="flex flex-col gap-2 border-0 p-0 m-0">
    <legend class="text-sm text-text-muted font-medium mb-2">{label}</legend>
    <div class="grid grid-cols-[repeat(auto-fill,minmax(40px,1fr))] gap-2">
        {#each colors as c}
            <button
                type="button"
                class="w-10 h-10 rounded-sm border-2 flex items-center justify-center {value === c ? 'border-text-main ring-2 ring-accent-primary' : 'border-transparent'}"
                style="background: {c}" 
                aria-label={`Use colour ${c}`}
                aria-pressed={value === c}
                on:click={() => select(c)}
            >
                {#if value === c}
                    <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="4" width="16"><polyline points="20 6 9 17 4 12"></polyline></svg>
                {/if}
            </button>
        {/each}
        <div class="relative w-10 h-10">
            <input type="color" bind:value aria-label="Choose a custom colour" class="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
            <div class="w-full h-full flex items-center justify-center bg-bg-panel border border-border-flat rounded-sm text-text-muted pointer-events-none">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true">
                    <path d="M12 22a10 10 0 1 1 10-10c0 2.2-1.8 4-4 4h-1.8a1.5 1.5 0 0 0-1.2 2.4l.3.4A2 2 0 0 1 13.7 22H12z"></path>
                    <circle cx="7.5" cy="10.5" r="1"></circle>
                    <circle cx="10.5" cy="6.5" r="1"></circle>
                    <circle cx="15" cy="7.5" r="1"></circle>
                    <circle cx="17" cy="12" r="1"></circle>
                </svg>
            </div>
        </div>
    </div>
</fieldset>
