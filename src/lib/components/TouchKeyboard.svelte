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
    <section class="touch-keyboard" aria-label={title}>
        <header class="keyboard-toolbar">
            <div class="keyboard-context">
                <span class="keyboard-kicker"><span class="keyboard-kicker-dot" aria-hidden="true"></span>Touch keyboard</span>
                <strong>{title}</strong>
            </div>
            <div class="cursor-toolbar" aria-label="Cursor controls">
                <button type="button" class="cursor-key" title="Move to start" aria-label="Move cursor to start" disabled={selectionStart === 0 && selectionEnd === 0} on:click={() => setSelection(0)}>↤</button>
                <button type="button" class="cursor-key" title="Move left" aria-label="Move cursor left" disabled={selectionStart === 0 && selectionEnd === 0} on:click={() => moveCursor(-1)}>←</button>
                <button type="button" class="cursor-key select-control" title="Select all text" aria-label="Select all text" disabled={!value} on:click={() => setSelection(0, value.length)}>Select all</button>
                <button type="button" class="cursor-key" title="Move right" aria-label="Move cursor right" disabled={selectionStart === value.length && selectionEnd === value.length} on:click={() => moveCursor(1)}>→</button>
                <button type="button" class="cursor-key" title="Move to end" aria-label="Move cursor to end" disabled={selectionStart === value.length && selectionEnd === value.length} on:click={() => setSelection(value.length)}>↦</button>
            </div>
        </header>

        <div
            class="keyboard-editor"
            role="textbox"
            aria-label={`${title} text editor`}
            aria-readonly="true"
        >
            {#if value}
                <span class="keyboard-editor-text">{beforeSelection}</span>
                {#if selectionFrom === selectionTo}
                    <span class="keyboard-caret" aria-hidden="true"></span>
                {:else}
                    <span class="keyboard-selection">{selectedText}</span>
                {/if}
                <span class="keyboard-editor-text">{afterSelection}</span>
            {:else}
                <span class="keyboard-caret" aria-hidden="true"></span>
                <span class="keyboard-placeholder">{placeholder}</span>
            {/if}
        </div>

        <div class="keyboard-rows">
            {#each rows as row, rowIndex}
                <div class="keyboard-row">
                    {#if rowIndex === 2 && !symbols}
                        <button
                            type="button"
                            class="keyboard-key wide-function {shift ? 'is-active' : ''}"
                            aria-pressed={shift}
                            on:click={() => press("shift")}
                        >⇧ Shift</button>
                    {/if}
                    {#each row as key}
                        <button
                            type="button"
                            class="keyboard-key"
                            on:click={() => press(key)}
                        >{!symbols && shift ? key.toUpperCase() : key}</button>
                    {/each}
                    {#if rowIndex === rows.length - 1}
                        <button
                            type="button"
                            class="keyboard-key wide-function"
                            aria-label="Backspace"
                            on:click={() => press("backspace")}
                        >⌫</button>
                    {/if}
                </div>
            {/each}
            <div class="keyboard-row keyboard-bottom-row">
                <button
                    type="button"
                    class="keyboard-key mode-key"
                    aria-pressed={symbols}
                    on:click={() => symbols = !symbols}
                >{symbols ? "ABC" : "123 · #+="}</button>
                <button
                    type="button"
                    class="keyboard-key clear-key"
                    on:click={() => press("clear")}
                >Clear</button>
                <button
                    type="button"
                    class="keyboard-key space-key"
                    on:click={() => press("space")}
                >Space</button>
                <button
                    type="button"
                    class="keyboard-key done-key"
                    on:click={finish}
                >Done</button>
            </div>
        </div>
    </section>
{/if}

<style>
    .touch-keyboard {
        padding: .8rem;
        background: var(--bg-panel);
        color: var(--text-main);
    }

    .keyboard-toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: .75rem;
        margin-bottom: .55rem;
    }

    .keyboard-context {
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: .08rem;
    }

    .keyboard-context strong {
        overflow: hidden;
        font-size: 1rem;
        line-height: 1.2;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .keyboard-kicker {
        display: inline-flex;
        align-items: center;
        gap: .38rem;
        color: var(--accent-primary);
        font-size: .64rem;
        font-weight: 900;
        letter-spacing: .12em;
        line-height: 1.2;
        text-transform: uppercase;
    }

    .keyboard-kicker-dot {
        width: .42rem;
        height: .42rem;
        border-radius: 999px;
        background: var(--accent-primary);
        box-shadow: 0 0 0 4px rgba(var(--accent-primary-rgb), .15);
    }

    .cursor-toolbar {
        display: grid;
        flex: 0 0 auto;
        grid-template-columns: 44px 44px minmax(72px, auto) 44px 44px;
        gap: .35rem;
    }

    .cursor-key,
    .keyboard-key {
        appearance: none;
        min-width: 0;
        border: 1px solid var(--border-flat);
        border-radius: .65rem;
        background: var(--bg-card);
        color: var(--text-main);
        font-family: inherit;
        font-weight: 800;
        cursor: pointer;
        box-shadow: 0 3px 0 var(--border-flat), inset 0 1px 0 rgba(255, 255, 255, .045);
        transition: border-color 120ms ease, background 120ms ease, color 120ms ease, transform 80ms ease, box-shadow 80ms ease;
    }

    .cursor-key {
        display: grid;
        min-height: 42px;
        place-items: center;
        padding: 0 .4rem;
        font-size: 1.12rem;
    }

    .select-control {
        color: var(--accent-primary);
        font-size: .65rem;
        letter-spacing: .04em;
        text-transform: uppercase;
    }

    .cursor-key:hover:not(:disabled),
    .keyboard-key:hover:not(:disabled) {
        border-color: var(--accent-primary);
        background: var(--bg-card-hover);
    }

    .cursor-key:active:not(:disabled),
    .keyboard-key:active:not(:disabled) {
        transform: translateY(2px);
        box-shadow: 0 1px 0 var(--border-flat);
    }

    .cursor-key:focus-visible,
    .keyboard-key:focus-visible {
        outline: 3px solid var(--border-focus);
        outline-offset: 2px;
    }

    .cursor-key:disabled,
    .keyboard-key:disabled {
        cursor: not-allowed;
        opacity: .38;
        box-shadow: 0 2px 0 var(--border-flat);
    }

    .keyboard-editor {
        display: flex;
        height: 52px;
        min-width: 0;
        align-items: center;
        margin-bottom: .7rem;
        overflow-x: auto;
        border: 2px solid var(--accent-primary);
        border-radius: .75rem;
        background: var(--bg-base);
        padding: 0 .9rem;
        color: var(--text-main);
        font-size: 1.05rem;
        font-weight: 750;
        box-shadow: inset 0 2px 7px rgba(0, 0, 0, .22), 0 0 0 4px rgba(var(--accent-primary-rgb), .12);
        scrollbar-width: thin;
    }

    .keyboard-editor-text,
    .keyboard-selection {
        white-space: pre;
    }

    .keyboard-selection {
        border-radius: .2rem;
        background: var(--accent-primary);
        padding: 0 2px;
        color: #fff;
    }

    .keyboard-caret {
        width: 0;
        height: 1.42em;
        flex: 0 0 auto;
        border-left: 2px solid var(--accent-primary);
        animation: keyboard-caret-blink 1s steps(1, end) infinite;
    }

    .keyboard-placeholder {
        overflow: hidden;
        padding-left: .3rem;
        color: var(--text-muted);
        font-size: .92rem;
        font-weight: 650;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .keyboard-rows {
        display: flex;
        flex-direction: column;
        gap: .42rem;
    }

    .keyboard-row {
        display: flex;
        justify-content: center;
        gap: .42rem;
    }

    .keyboard-key {
        display: grid;
        height: 48px;
        flex: 1 1 0;
        place-items: center;
        padding: 0 .35rem;
        font-size: 1rem;
    }

    .wide-function {
        flex: 1.65 1 0;
        font-size: .76rem;
    }

    .keyboard-key.is-active,
    .mode-key[aria-pressed="true"] {
        border-color: var(--accent-primary);
        background: var(--accent-primary);
        color: #fff;
    }

    .mode-key,
    .clear-key {
        max-width: 118px;
        flex: 1.2 1 0;
    }

    .mode-key {
        color: var(--accent-primary);
        font-size: .82rem;
    }

    .clear-key {
        color: var(--danger);
    }

    .space-key {
        flex: 5 1 0;
    }

    .done-key {
        min-width: 112px;
        flex: 1.25 1 0;
        border-color: var(--success);
        background: var(--success);
        color: #fff;
    }

    .done-key:hover:not(:disabled) {
        border-color: var(--success);
        background: var(--success);
        filter: brightness(1.08);
    }

    @keyframes keyboard-caret-blink {
        0%, 48% { opacity: 1; }
        49%, 100% { opacity: 0; }
    }

    @media (max-width: 620px) {
        .keyboard-toolbar {
            align-items: stretch;
            flex-direction: column;
        }

        .cursor-toolbar {
            width: 100%;
            grid-template-columns: 1fr 1fr 1.45fr 1fr 1fr;
        }

        .keyboard-row,
        .keyboard-rows {
            gap: .28rem;
        }

        .keyboard-key {
            padding-inline: .15rem;
        }

        .done-key {
            min-width: 76px;
        }
    }

    @media (max-height: 640px) {
        .touch-keyboard {
            padding: .55rem;
        }

        .keyboard-toolbar {
            margin-bottom: .35rem;
        }

        .keyboard-editor {
            height: 44px;
            margin-bottom: .45rem;
        }

        .keyboard-key {
            height: 40px;
        }

        .keyboard-row,
        .keyboard-rows {
            gap: .3rem;
        }
    }
</style>
