<script lang="ts">
    export let checked = false;
    export let label = "";
</script>

<div class="flex items-center justify-between p-3.5 bg-bg-panel border border-border-flat rounded-sm cursor-pointer select-none hover:bg-bg-card-hover transition-colors" on:click={() => checked = !checked}>
    <span class="font-semibold text-base text-text-main">{label}</span>
    <div class="w-12 h-[26px] rounded-full relative transition-colors duration-300 border border-border-flat {checked ? 'bg-success' : 'bg-bg-card-hover'}">
        <div class="w-5 h-5 rounded-full absolute top-[2px] left-[2px] transition-transform duration-300 shadow-md {checked ? 'translate-x-[22px] bg-text-inverse' : 'translate-x-0 bg-text-muted'}"></div>
    </div>
</div>
