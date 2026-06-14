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
    <section class="touch-keyboard" aria-label={title}>
        <div class="keyboard-top">
            <div>
                <span>{title}</span>
                <strong>{value ? (masked ? "●".repeat(value.length) : value) : placeholder}</strong>
            </div>
            <button type="button" class="keyboard-done" on:click={finish}>Done</button>
        </div>

        <div class="keyboard-keys">
            {#each rows as row, rowIndex}
                <div class="keyboard-row row-{rowIndex}">
                    {#if rowIndex === 2 && !symbols}
                        <button type="button" class:active={shift} class="wide" on:click={() => press("shift")}>Shift</button>
                    {/if}
                    {#each row as key}
                        <button type="button" on:click={() => press(key)}>{!symbols && shift ? key.toUpperCase() : key}</button>
                    {/each}
                    {#if rowIndex === 2}
                        <button type="button" class="wide" on:click={() => press("backspace")}>⌫</button>
                    {/if}
                </div>
            {/each}
            <div class="keyboard-row keyboard-bottom">
                <button type="button" class="mode" on:click={() => symbols = !symbols}>{symbols ? "ABC" : "123 &"}</button>
                <button type="button" class="clear" on:click={() => press("clear")}>Clear</button>
                <button type="button" class="space" on:click={() => press("space")}>Space</button>
                <button type="button" class="keyboard-done" on:click={finish}>Done</button>
            </div>
        </div>
    </section>
{/if}

<style>
    .touch-keyboard { padding: .65rem; flex-shrink: 0; border-top: 1px solid var(--border-flat); background: color-mix(in srgb, var(--bg-panel) 94%, var(--accent-primary) 6%); }
    .keyboard-top { margin-bottom: .5rem; display: flex; align-items: center; justify-content: space-between; gap: .7rem; }
    .keyboard-top div { min-width: 0; display: flex; flex-direction: column; gap: .1rem; }
    .keyboard-top span { color: var(--accent-primary); font-size: .65rem; font-weight: 900; letter-spacing: .1em; text-transform: uppercase; }
    .keyboard-top strong { min-height: 1.3rem; overflow: hidden; color: var(--text-main); text-overflow: ellipsis; white-space: nowrap; }
    .keyboard-keys { display: flex; flex-direction: column; gap: .3rem; }
    .keyboard-row { display: flex; justify-content: center; gap: .3rem; }
    .keyboard-row button { min-width: 0; height: 43px; flex: 1 1 0; display: grid; place-items: center; color: var(--text-main); font-size: .95rem; font-weight: 800; border: 1px solid var(--border-flat); border-radius: .45rem; background: var(--bg-card); box-shadow: 0 2px 0 color-mix(in srgb, var(--border-flat) 75%, transparent); }
    .keyboard-row button:active { transform: translateY(1px); box-shadow: none; }
    .keyboard-row .wide { flex: 1.7 1 0; font-size: .72rem; }
    .keyboard-row .active { color: white; border-color: var(--accent-primary); background: var(--accent-primary); }
    .keyboard-bottom .clear { max-width: 100px; color: var(--danger); }
    .keyboard-bottom .mode { max-width: 100px; color: var(--accent-primary); }
    .keyboard-bottom .space { flex: 5 1 0; }
    .keyboard-done { min-width: 90px !important; color: white !important; border-color: var(--success) !important; background: var(--success) !important; }
    @media (max-height: 720px) {
        .keyboard-row button { height: 36px; }
        .keyboard-top { margin-bottom: .3rem; }
    }
</style>
