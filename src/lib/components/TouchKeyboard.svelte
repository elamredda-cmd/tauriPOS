<script lang="ts">
    export let value = "";
    export let visible = false;
    export let title = "Touch Keyboard";
    export let placeholder = "";
    export let masked = false;
    export let onDone: () => void = () => {};

    let shift = true;
    let symbols = false;
    const letterRows = [
        ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
        ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
        ["z", "x", "c", "v", "b", "n", "m"],
    ];
    const symbolRows = [
        ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
        ["-", "/", ":", ";", "(", ")", "£", "&", "@", "\""],
        [".", ",", "?", "!", "'", "#", "%", "+", "="],
    ];
    $: rows = symbols ? symbolRows : letterRows;

    function press(key: string) {
        if (key === "shift") {
            shift = !shift;
        } else if (key === "backspace") {
            value = value.slice(0, -1);
        } else if (key === "clear") {
            value = "";
        } else if (key === "space") {
            value += " ";
        } else {
            value += !symbols && shift ? key.toUpperCase() : key;
            if (!symbols && shift) shift = false;
        }
    }

    function finish() {
        visible = false;
        onDone();
    }
</script>

{#if visible}
    <section class="touch-keyboard shrink-0 border-t border-border-flat bg-[color-mix(in_srgb,var(--bg-panel)_94%,var(--accent-primary)_6%)] p-[.65rem]" aria-label={title}>
        <div class="mb-2 flex items-center justify-between gap-[.7rem] [@media(max-height:720px)]:mb-[.3rem]">
            <div class="flex min-w-0 flex-col gap-[.1rem]">
                <span class="text-[.65rem] font-black uppercase tracking-[.1em] text-accent-primary">{title}</span>
                <strong class="min-h-[1.3rem] overflow-hidden text-ellipsis whitespace-nowrap text-text-main">{value ? (masked ? "●".repeat(value.length) : value) : placeholder}</strong>
            </div>
            <button
                type="button"
                class="!min-w-[90px] rounded-[.45rem] border border-success bg-success text-white h-[43px] px-4 font-extrabold shadow-[0_2px_0_color-mix(in_srgb,var(--border-flat)_75%,transparent)] active:translate-y-px active:shadow-none [@media(max-height:720px)]:h-9"
                on:click={finish}
            >Done</button>
        </div>

        <div class="flex flex-col gap-[.3rem]">
            {#each rows as row, rowIndex}
                <div class="flex justify-center gap-[.3rem]">
                    {#if rowIndex === 2 && !symbols}
                        <button
                            type="button"
                            class="grid h-[43px] min-w-0 flex-[1.7_1_0] place-items-center rounded-[.45rem] border border-border-flat bg-bg-card text-[.72rem] font-extrabold text-text-main shadow-[0_2px_0_color-mix(in_srgb,var(--border-flat)_75%,transparent)] active:translate-y-px active:shadow-none [@media(max-height:720px)]:h-9 {shift ? 'border-accent-primary bg-accent-primary text-white' : ''}"
                            on:click={() => press("shift")}
                        >Shift</button>
                    {/if}
                    {#each row as key}
                        <button
                            type="button"
                            class="grid h-[43px] min-w-0 flex-1 place-items-center rounded-[.45rem] border border-border-flat bg-bg-card text-[.95rem] font-extrabold text-text-main shadow-[0_2px_0_color-mix(in_srgb,var(--border-flat)_75%,transparent)] active:translate-y-px active:shadow-none [@media(max-height:720px)]:h-9"
                            on:click={() => press(key)}
                        >{!symbols && shift ? key.toUpperCase() : key}</button>
                    {/each}
                    {#if rowIndex === 2}
                        <button
                            type="button"
                            class="grid h-[43px] min-w-0 flex-[1.7_1_0] place-items-center rounded-[.45rem] border border-border-flat bg-bg-card text-[.72rem] font-extrabold text-text-main shadow-[0_2px_0_color-mix(in_srgb,var(--border-flat)_75%,transparent)] active:translate-y-px active:shadow-none [@media(max-height:720px)]:h-9"
                            on:click={() => press("backspace")}
                        >⌫</button>
                    {/if}
                </div>
            {/each}
            <div class="flex justify-center gap-[.3rem]">
                <button
                    type="button"
                    class="grid h-[43px] max-w-[100px] min-w-0 flex-1 place-items-center rounded-[.45rem] border border-border-flat bg-bg-card text-[.95rem] font-extrabold text-accent-primary shadow-[0_2px_0_color-mix(in_srgb,var(--border-flat)_75%,transparent)] active:translate-y-px active:shadow-none [@media(max-height:720px)]:h-9"
                    on:click={() => symbols = !symbols}
                >{symbols ? "ABC" : "123 &"}</button>
                <button
                    type="button"
                    class="grid h-[43px] max-w-[100px] min-w-0 flex-1 place-items-center rounded-[.45rem] border border-border-flat bg-bg-card text-[.95rem] font-extrabold text-danger shadow-[0_2px_0_color-mix(in_srgb,var(--border-flat)_75%,transparent)] active:translate-y-px active:shadow-none [@media(max-height:720px)]:h-9"
                    on:click={() => press("clear")}
                >Clear</button>
                <button
                    type="button"
                    class="grid h-[43px] min-w-0 flex-[5_1_0] place-items-center rounded-[.45rem] border border-border-flat bg-bg-card text-[.95rem] font-extrabold text-text-main shadow-[0_2px_0_color-mix(in_srgb,var(--border-flat)_75%,transparent)] active:translate-y-px active:shadow-none [@media(max-height:720px)]:h-9"
                    on:click={() => press("space")}
                >Space</button>
                <button
                    type="button"
                    class="!min-w-[90px] rounded-[.45rem] border border-success bg-success text-white h-[43px] px-4 font-extrabold shadow-[0_2px_0_color-mix(in_srgb,var(--border-flat)_75%,transparent)] active:translate-y-px active:shadow-none [@media(max-height:720px)]:h-9"
                    on:click={finish}
                >Done</button>
            </div>
        </div>
    </section>
{/if}
