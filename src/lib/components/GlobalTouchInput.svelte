<script lang="ts">
    import { onMount } from "svelte";
    import TouchKeyboard from "./TouchKeyboard.svelte";
    import TouchDigitPad from "./TouchDigitPad.svelte";

    let target: HTMLInputElement | HTMLTextAreaElement | null = null;
    let value = "";
    let visible = false;
    let numeric = false;
    let decimal = false;
    let masked = false;
    let title = "Enter text";
    let lastAppliedValue = "";
    let lastPointerTarget: Element | null = null;

    const ignoredTypes = new Set([
        "checkbox", "radio", "color", "date", "datetime-local", "time",
        "file", "range", "hidden", "button", "submit", "reset",
    ]);

    function fieldTitle(element: HTMLInputElement | HTMLTextAreaElement): string {
        if (element.id) {
            const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
            if (label?.textContent?.trim()) return label.textContent.trim().replace(/\s*\*$/, "");
        }
        const field = element.closest(".field, .input-group, label");
        const label = field?.querySelector("label, span");
        return label?.textContent?.trim().replace(/\s*\*$/, "") || element.placeholder || "Enter value";
    }

    function canUseTouchInput(element: Element | null): element is HTMLInputElement | HTMLTextAreaElement {
        if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return false;
        if (element.disabled || element.readOnly || element.dataset.touchKeyboard === "off") return false;
        if (element.closest(".touch-input-panel, .touch-keyboard, .digit-pad")) return false;
        return !(element instanceof HTMLInputElement && ignoredTypes.has(element.type));
    }

    function openFor(element: HTMLInputElement | HTMLTextAreaElement) {
        target = element;
        value = element.value || "";
        lastAppliedValue = value;
        numeric = element instanceof HTMLInputElement &&
            (element.type === "number" || element.type === "tel" || element.inputMode === "numeric" || element.inputMode === "decimal");
        decimal = element instanceof HTMLInputElement &&
            (element.inputMode === "decimal" || element.type === "number" && (element.step === "any" || element.step.includes(".")));
        masked = element instanceof HTMLInputElement && element.type === "password";
        title = fieldTitle(element);
        visible = true;
    }

    function handleFocus(event: FocusEvent) {
        const element = event.target as Element | null;
        if (element instanceof HTMLElement && element.dataset.touchKeyboard === "manual" && element !== lastPointerTarget) return;
        if (canUseTouchInput(element)) openFor(element);
    }

    function applyValue() {
        if (!visible || !target || value === lastAppliedValue) return;
        target.value = value;
        lastAppliedValue = value;
        target.dispatchEvent(new Event("input", { bubbles: true }));
    }

    function done() {
        applyValue();
        target?.dispatchEvent(new Event("change", { bubbles: true }));
        visible = false;
        target = null;
    }

    $: if (visible && target && value !== lastAppliedValue) {
        applyValue();
    }

    onMount(() => {
        const handlePointer = (event: PointerEvent) => { lastPointerTarget = event.target as Element | null; };
        const handleClose = () => done();
        document.addEventListener("pointerdown", handlePointer, true);
        document.addEventListener("focusin", handleFocus, true);
        document.addEventListener("close-touch-keyboard", handleClose);
        return () => {
            document.removeEventListener("pointerdown", handlePointer, true);
            document.removeEventListener("focusin", handleFocus, true);
            document.removeEventListener("close-touch-keyboard", handleClose);
        };
    });
</script>

{#if visible}
    <div class="touch-input-backdrop" on:click={done}>
        <div class="touch-input-panel" on:click|stopPropagation>
            {#if numeric}
                <div class="digit-panel-heading">
                    <div><span>Touch digit pad</span><strong>{title}</strong></div>
                    <button type="button" on:click={done}>Close</button>
                </div>
                <TouchDigitPad
                    bind:value
                    {masked}
                    allowDecimal={decimal}
                    maxLength={target?.maxLength && target.maxLength > 0 ? target.maxLength : 32}
                    placeholder={title}
                    submitLabel="Done"
                    onSubmit={done}
                />
            {:else}
                <TouchKeyboard
                    bind:value
                    bind:visible
                    {masked}
                    {title}
                    placeholder={target?.placeholder || "Touch the keys to enter text"}
                    onDone={done}
                />
            {/if}
        </div>
    </div>
{/if}

<style>
    .touch-input-backdrop { position: fixed; inset: 0; z-index: 1900; display: flex; align-items: flex-end; justify-content: center; padding: .5rem; background: color-mix(in srgb, var(--overlay) 55%, transparent); }
    .touch-input-panel { width: min(980px, 100%); overflow: hidden; border: 1px solid var(--border-flat); border-radius: .9rem; background: var(--bg-panel); box-shadow: 0 -15px 55px var(--shadow); }
    .touch-input-panel :global(.touch-keyboard) { border-top: 0; }
    .touch-input-panel :global(.digit-pad) { width: min(420px, 100%); margin: 0 auto; padding: .65rem; }
    .digit-panel-heading { padding: .7rem .8rem 0; display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
    .digit-panel-heading div { display: flex; flex-direction: column; }
    .digit-panel-heading span { color: var(--accent-primary); font-size: .65rem; font-weight: 900; letter-spacing: .1em; text-transform: uppercase; }
    .digit-panel-heading button { padding: .55rem .8rem; color: var(--text-main); border: 1px solid var(--border-flat); border-radius: .45rem; background: var(--bg-card); }
</style>
