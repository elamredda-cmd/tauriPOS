<script lang="ts">
    import Modal from './Modal.svelte';
    import { createEventDispatcher } from 'svelte';

    export let value = ""; // ISO string format for datetime-local compatibility
    export let label = "Date & Time";

    let showModal = false;
    const dispatch = createEventDispatcher();

    // Internal state for editing
    let year = new Date().getFullYear();
    let month = new Date().getMonth(); // 0-11
    let day = new Date().getDate();
    let hour = new Date().getHours();
    let minute = new Date().getMinutes();

    $: {
        if (value) {
            const d = new Date(value);
            if (!isNaN(d.getTime())) {
                year = d.getFullYear();
                month = d.getMonth();
                day = d.getDate();
                hour = d.getHours();
                minute = d.getMinutes();
            }
        }
    }

    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    function formatDisplay(v: string) {
        if (!v) return "Not Set";
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) return "Not Set";
        const pad = (n: number) => n.toString().padStart(2, '0');
        return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function adjust(type: string, delta: number) {
        if (type === 'day') day += delta;
        if (type === 'month') month += delta;
        if (type === 'year') year += delta;
        if (type === 'hour') hour += delta;
        if (type === 'minute') minute += delta;

        // Validation / Normalization
        const d = new Date(year, month, day, hour, minute);
        year = d.getFullYear();
        month = d.getMonth();
        day = d.getDate();
        hour = d.getHours();
        minute = d.getMinutes();
    }

    function apply() {
        const d = new Date(year, month, day, hour, minute);
        // Format to YYYY-MM-DDTHH:mm
        const pad = (n: number) => n.toString().padStart(2, '0');
        value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        showModal = false;
        dispatch('change', value);
    }

    function clear() {
        value = "";
        showModal = false;
        dispatch('change', value);
    }

    function setNow() {
        const d = new Date();
        year = d.getFullYear();
        month = d.getMonth();
        day = d.getDate();
        hour = d.getHours();
        minute = d.getMinutes();
    }
</script>

<div class="flex flex-col gap-1.5 w-full">
    {#if label}<label class="text-[0.85rem] text-text-muted font-medium">{label}</label>{/if}
    <button
        class="w-full h-12 px-4 flex items-center justify-between bg-bg-panel border border-border-flat rounded-sm text-text-main text-[0.95rem] cursor-pointer text-left hover:border-accent-primary transition-colors"
        on:click={() => showModal = true}
    >
        <span class="flex-1">{formatDisplay(value)}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>
    </button>
</div>

<Modal bind:show={showModal} title="Set {label}" width="480px">
    <div class="flex items-start justify-center py-2.5 gap-6">
        <div class="flex flex-col items-center gap-3">
            <h4 class="m-0 text-text-muted text-[0.8rem] uppercase tracking-wider">Date</h4>
            <div class="flex items-center gap-3">
                {#each [
                    { type: 'day',   val: day.toString().padStart(2, '0'), label: 'Day' },
                    { type: 'month', val: monthNames[month],               label: 'Month' },
                    { type: 'year',  val: year,                            label: 'Year' }
                ] as w}
                    <div class="flex flex-col items-center gap-1 min-w-[50px]">
                        <button class="w-12 h-12 bg-bg-panel border border-border-flat rounded-sm text-accent-primary cursor-pointer text-[1.1rem] flex items-center justify-center active:bg-accent-primary active:text-white" on:click={() => adjust(w.type, 1)}>▲</button>
                        <span class="text-[1.4rem] font-bold text-text-main min-h-9 flex items-center">{w.val}</span>
                        <button class="w-12 h-12 bg-bg-panel border border-border-flat rounded-sm text-accent-primary cursor-pointer text-[1.1rem] flex items-center justify-center active:bg-accent-primary active:text-white" on:click={() => adjust(w.type, -1)}>▼</button>
                        <small class="text-[0.7rem] text-text-muted uppercase">{w.label}</small>
                    </div>
                {/each}
            </div>
        </div>

        <div class="w-px h-40 bg-border-flat self-center"></div>

        <div class="flex flex-col items-center gap-3">
            <h4 class="m-0 text-text-muted text-[0.8rem] uppercase tracking-wider">Time</h4>
            <div class="flex items-center gap-3">
                <div class="flex flex-col items-center gap-1 min-w-[50px]">
                    <button class="w-12 h-12 bg-bg-panel border border-border-flat rounded-sm text-accent-primary cursor-pointer text-[1.1rem] flex items-center justify-center active:bg-accent-primary active:text-white" on:click={() => adjust('hour', 1)}>▲</button>
                    <span class="text-[1.4rem] font-bold text-text-main min-h-9 flex items-center">{hour.toString().padStart(2, '0')}</span>
                    <button class="w-12 h-12 bg-bg-panel border border-border-flat rounded-sm text-accent-primary cursor-pointer text-[1.1rem] flex items-center justify-center active:bg-accent-primary active:text-white" on:click={() => adjust('hour', -1)}>▼</button>
                    <small class="text-[0.7rem] text-text-muted uppercase">Hr</small>
                </div>
                <div class="text-[2rem] font-bold pb-5 text-text-muted">:</div>
                <div class="flex flex-col items-center gap-1 min-w-[50px]">
                    <button class="w-12 h-12 bg-bg-panel border border-border-flat rounded-sm text-accent-primary cursor-pointer text-[1.1rem] flex items-center justify-center active:bg-accent-primary active:text-white" on:click={() => adjust('minute', 1)}>▲</button>
                    <span class="text-[1.4rem] font-bold text-text-main min-h-9 flex items-center">{minute.toString().padStart(2, '0')}</span>
                    <button class="w-12 h-12 bg-bg-panel border border-border-flat rounded-sm text-accent-primary cursor-pointer text-[1.1rem] flex items-center justify-center active:bg-accent-primary active:text-white" on:click={() => adjust('minute', -1)}>▼</button>
                    <small class="text-[0.7rem] text-text-muted uppercase">Min</small>
                </div>
            </div>
        </div>
    </div>

    <div slot="footer" class="flex gap-3 w-full">
        <button class="h-12 px-5 rounded-sm font-semibold cursor-pointer bg-bg-panel text-text-main border border-border-flat" on:click={clear}>Clear</button>
        <button class="h-12 px-5 rounded-sm font-semibold cursor-pointer bg-bg-panel text-text-main border border-border-flat" on:click={setNow}>Set Now</button>
        <div class="flex-1"></div>
        <button class="h-12 px-5 rounded-sm font-semibold cursor-pointer bg-accent-primary text-white border-0 hover:bg-accent-primary-hover" on:click={apply}>Apply</button>
    </div>
</Modal>
