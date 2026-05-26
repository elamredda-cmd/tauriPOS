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

<div class="flex flex-col gap-2">
    <label class="text-sm text-text-muted font-medium">{label}</label>
    <div class="grid grid-cols-[repeat(auto-fill,minmax(40px,1fr))] gap-2">
        {#each colors as c}
            <button 
                class="w-10 h-10 rounded-sm border-2 flex items-center justify-center transition-transform hover:scale-105 {value === c ? 'border-text-main ring-2 ring-accent-primary' : 'border-transparent'}"
                style="background: {c}" 
                on:click={() => select(c)}
            >
                {#if value === c}
                    <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="4" width="16"><polyline points="20 6 9 17 4 12"></polyline></svg>
                {/if}
            </button>
        {/each}
        <div class="relative w-10 h-10">
            <input type="color" bind:value class="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
            <div class="w-full h-full flex items-center justify-center bg-bg-panel border border-border-flat rounded-sm text-lg pointer-events-none">
                🎨
            </div>
        </div>
    </div>
</div>
