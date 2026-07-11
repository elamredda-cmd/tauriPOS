<script lang="ts">
    export let value = "";
    export let visible = false;
    export let title = "Touch Keyboard";
    export let placeholder = "";
    export let masked = false;
    export let maxLength = 120;
    export let selectionStart = 0;
    export let selectionEnd = 0;
    export let onDone: () => void = () => {};
    export let onSelectionChange: (start: number, end: number) => void = () => {};

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
        ["_", "*", "[", "]", "{", "}", "\\", "|", "~"],
    ];
    $: rows = symbols ? symbolRows : letterRows;
    $: effectiveMaxLength = maxLength && maxLength > 0 ? maxLength : 120;
    $: selectionStart = clampPosition(selectionStart);
    $: selectionEnd = clampPosition(selectionEnd);
    $: selectionFrom = Math.min(selectionStart, selectionEnd);
    $: selectionTo = Math.max(selectionStart, selectionEnd);
    $: beforeSelection = display(value.slice(0, selectionFrom));
    $: selectedText = display(value.slice(selectionFrom, selectionTo));
    $: afterSelection = display(value.slice(selectionTo));

    function clampPosition(position: number): number {
        return Math.max(0, Math.min(Number.isFinite(position) ? position : value.length, value.length));
    }

    function display(text: string): string {
        return masked ? "●".repeat(text.length) : text;
    }

    function setSelection(start: number, end = start) {
        selectionStart = clampPosition(start);
        selectionEnd = clampPosition(end);
        onSelectionChange(selectionStart, selectionEnd);
    }

    function press(key: string) {
        if (key === "shift") {
            shift = !shift;
        } else if (key === "backspace") {
            backspace();
        } else if (key === "clear") {
            value = "";
            setSelection(0);
        } else if (key === "space") {
            insert(" ");
        } else {
            insert(!symbols && shift ? key.toUpperCase() : key);
            if (!symbols && shift) shift = false;
        }
    }

    function insert(text: string) {
        const from = Math.min(selectionStart, selectionEnd);
        const to = Math.max(selectionStart, selectionEnd);
        const available = effectiveMaxLength - (value.length - (to - from));
        const inserted = text.slice(0, Math.max(0, available));
        if (!inserted) return;
        value = `${value.slice(0, from)}${inserted}${value.slice(to)}`;
        setSelection(from + inserted.length);
    }

    function backspace() {
        const from = Math.min(selectionStart, selectionEnd);
        const to = Math.max(selectionStart, selectionEnd);
        if (from !== to) {
            value = `${value.slice(0, from)}${value.slice(to)}`;
            setSelection(from);
        } else if (from > 0) {
            value = `${value.slice(0, from - 1)}${value.slice(from)}`;
            setSelection(from - 1);
        }
    }

    function moveCursor(direction: -1 | 1) {
        if (selectionStart !== selectionEnd) {
            setSelection(direction < 0
                ? Math.min(selectionStart, selectionEnd)
                : Math.max(selectionStart, selectionEnd));
            return;
        }
        setSelection(selectionStart + direction);
    }

    function finish() {
        visible = false;
        onDone();
    }
</script>

{#if visible}
    <section class="touch-keyboard shrink-0 border-t border-border-flat bg-bg-panel p-[.65rem]" aria-label={title}>
        <div class="mb-2 flex items-end gap-[.55rem] [@media(max-height:720px)]:mb-[.3rem]">
            <div class="flex min-w-0 flex-1 flex-col gap-[.2rem]">
                <span class="text-[.65rem] font-black uppercase tracking-[.1em] text-accent-primary">{title}</span>
                <div
                    class="flex h-[43px] min-w-0 items-center overflow-x-auto rounded-[.45rem] border-2 border-accent-primary bg-bg-base px-3 text-base font-bold text-text-main shadow-inner"
                    role="textbox"
                    aria-label={`${title} text editor`}
                    aria-readonly="true"
                >
                    {#if value}
                        <span class="whitespace-pre">{beforeSelection}</span>
                        {#if selectionFrom === selectionTo}
                            <span class="h-[1.35em] w-0 shrink-0 border-l-2 border-accent-primary" aria-hidden="true"></span>
                        {:else}
                            <span class="whitespace-pre bg-accent-primary px-[1px] text-white">{selectedText}</span>
                        {/if}
                        <span class="whitespace-pre">{afterSelection}</span>
                    {:else}
                        <span class="h-[1.35em] w-0 shrink-0 border-l-2 border-accent-primary" aria-hidden="true"></span>
                        <span class="truncate pl-1 text-sm text-text-muted">{placeholder}</span>
                    {/if}
                </div>
            </div>
            <div class="grid shrink-0 grid-cols-5 gap-[.3rem]" aria-label="Cursor controls">
                <button type="button" class="grid h-[43px] w-[48px] place-items-center rounded-[.45rem] border border-border-flat bg-bg-card text-lg font-black text-text-main shadow-[0_2px_0_var(--border-flat)] active:translate-y-px active:shadow-none" title="Move to start" aria-label="Move cursor to start" on:click={() => setSelection(0)}>↤</button>
                <button type="button" class="grid h-[43px] w-[48px] place-items-center rounded-[.45rem] border border-border-flat bg-bg-card text-xl font-black text-text-main shadow-[0_2px_0_var(--border-flat)] active:translate-y-px active:shadow-none" title="Move left" aria-label="Move cursor left" disabled={selectionStart === 0 && selectionEnd === 0} on:click={() => moveCursor(-1)}>←</button>
                <button type="button" class="grid h-[43px] min-w-[64px] place-items-center rounded-[.45rem] border border-border-flat bg-bg-card px-2 text-[.68rem] font-black uppercase text-accent-primary shadow-[0_2px_0_var(--border-flat)] active:translate-y-px active:shadow-none" title="Select all text" on:click={() => setSelection(0, value.length)}>Select</button>
                <button type="button" class="grid h-[43px] w-[48px] place-items-center rounded-[.45rem] border border-border-flat bg-bg-card text-xl font-black text-text-main shadow-[0_2px_0_var(--border-flat)] active:translate-y-px active:shadow-none" title="Move right" aria-label="Move cursor right" disabled={selectionStart === value.length && selectionEnd === value.length} on:click={() => moveCursor(1)}>→</button>
                <button type="button" class="grid h-[43px] w-[48px] place-items-center rounded-[.45rem] border border-border-flat bg-bg-card text-lg font-black text-text-main shadow-[0_2px_0_var(--border-flat)] active:translate-y-px active:shadow-none" title="Move to end" aria-label="Move cursor to end" on:click={() => setSelection(value.length)}>↦</button>
            </div>
            <button
                type="button"
                class="!min-w-[90px] rounded-[.45rem] border border-success bg-success text-white h-[43px] px-4 font-extrabold shadow-[0_2px_0_var(--border-flat)] active:translate-y-px active:shadow-none [@media(max-height:720px)]:h-9"
                on:click={finish}
            >Done</button>
        </div>

        <div class="flex flex-col gap-[.3rem]">
            {#each rows as row, rowIndex}
                <div class="flex justify-center gap-[.3rem]">
                    {#if rowIndex === 2 && !symbols}
                        <button
                            type="button"
                            class="grid h-[43px] min-w-0 flex-[1.7_1_0] place-items-center rounded-[.45rem] border border-border-flat bg-bg-card text-[.72rem] font-extrabold text-text-main shadow-[0_2px_0_var(--border-flat)] active:translate-y-px active:shadow-none [@media(max-height:720px)]:h-9 {shift ? 'border-accent-primary bg-accent-primary text-white' : ''}"
                            on:click={() => press("shift")}
                        >Shift</button>
                    {/if}
                    {#each row as key}
                        <button
                            type="button"
                            class="grid h-[43px] min-w-0 flex-1 place-items-center rounded-[.45rem] border border-border-flat bg-bg-card text-[.95rem] font-extrabold text-text-main shadow-[0_2px_0_var(--border-flat)] active:translate-y-px active:shadow-none [@media(max-height:720px)]:h-9"
                            on:click={() => press(key)}
                        >{!symbols && shift ? key.toUpperCase() : key}</button>
                    {/each}
                    {#if rowIndex === rows.length - 1}
                        <button
                            type="button"
                            class="grid h-[43px] min-w-0 flex-[1.7_1_0] place-items-center rounded-[.45rem] border border-border-flat bg-bg-card text-[.72rem] font-extrabold text-text-main shadow-[0_2px_0_var(--border-flat)] active:translate-y-px active:shadow-none [@media(max-height:720px)]:h-9"
                            on:click={() => press("backspace")}
                        >⌫</button>
                    {/if}
                </div>
            {/each}
            <div class="flex justify-center gap-[.3rem]">
                <button
                    type="button"
                    class="grid h-[43px] max-w-[100px] min-w-0 flex-1 place-items-center rounded-[.45rem] border border-border-flat bg-bg-card text-[.95rem] font-extrabold text-accent-primary shadow-[0_2px_0_var(--border-flat)] active:translate-y-px active:shadow-none [@media(max-height:720px)]:h-9"
                    on:click={() => symbols = !symbols}
                >{symbols ? "ABC" : "123 &"}</button>
                <button
                    type="button"
                    class="grid h-[43px] max-w-[100px] min-w-0 flex-1 place-items-center rounded-[.45rem] border border-border-flat bg-bg-card text-[.95rem] font-extrabold text-danger shadow-[0_2px_0_var(--border-flat)] active:translate-y-px active:shadow-none [@media(max-height:720px)]:h-9"
                    on:click={() => press("clear")}
                >Clear</button>
                <button
                    type="button"
                    class="grid h-[43px] min-w-0 flex-[5_1_0] place-items-center rounded-[.45rem] border border-border-flat bg-bg-card text-[.95rem] font-extrabold text-text-main shadow-[0_2px_0_var(--border-flat)] active:translate-y-px active:shadow-none [@media(max-height:720px)]:h-9"
                    on:click={() => press("space")}
                >Space</button>
                <button
                    type="button"
                    class="!min-w-[90px] rounded-[.45rem] border border-success bg-success text-white h-[43px] px-4 font-extrabold shadow-[0_2px_0_var(--border-flat)] active:translate-y-px active:shadow-none [@media(max-height:720px)]:h-9"
                    on:click={finish}
                >Done</button>
            </div>
        </div>
    </section>
{/if}
