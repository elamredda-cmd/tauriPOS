<script lang="ts">
    export let checked = false;
    export let label = "";
</script>

<button
    type="button"
    class="w-full min-h-[58px] flex items-center justify-between gap-4 p-3.5 bg-bg-panel border border-border-flat rounded-lg cursor-pointer select-none hover:bg-bg-card-hover hover:border-accent-primary transition-all duration-150"
    role="switch"
    aria-checked={checked}
    on:click={() => checked = !checked}
>
    <span class="font-bold text-base text-text-main text-left">{label}</span>
    <div class="w-[54px] h-8 rounded-full relative transition-colors duration-200 border border-border-flat shrink-0 {checked ? 'bg-success' : 'bg-bg-card-hover'}">
        <div class="w-6 h-6 rounded-full absolute top-[3px] left-[3px] transition-transform duration-200 shadow-md {checked ? 'translate-x-[22px] bg-white' : 'translate-x-0 bg-text-muted'}"></div>
    </div>
</button>
