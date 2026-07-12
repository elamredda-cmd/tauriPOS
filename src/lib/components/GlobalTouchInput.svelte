<script lang="ts">
    import { onMount, tick } from "svelte";
    import TouchKeyboard from "./TouchKeyboard.svelte";
    import TouchDigitPad from "./TouchDigitPad.svelte";

    let target: HTMLInputElement | HTMLTextAreaElement | null = null;
    let value = "";
    let visible = false;
    let numeric = false;
    let decimal = false;
    let masked = false;
    let title = "Enter text";
    let maxLength = 120;
    let maxValue: number | null = null;
    let selectionStart = 0;
    let selectionEnd = 0;
    let lastAppliedValue = "";
    let lastPointerTarget: Element | null = null;
    let focusTimer: number | undefined;
    let targetRectStyle = "";
    let liftedText = "";
    let liftedIsPlaceholder = true;
    const activeInputClasses = [
        "!border-accent-primary",
        "!bg-bg-card",
        "!outline-2",
        "!outline-accent-primary",
        "!outline-offset-1",
    ];

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
        if (target && target !== element) target.classList.remove(...activeInputClasses);
        target = element;
        target.classList.add(...activeInputClasses);
        value = element.value || "";
        lastAppliedValue = value;
        selectionStart = element.selectionStart ?? value.length;
        selectionEnd = element.selectionEnd ?? selectionStart;
        numeric = element instanceof HTMLInputElement &&
            (element.type === "number" || element.type === "tel" || element.inputMode === "numeric" || element.inputMode === "decimal");
        decimal = element instanceof HTMLInputElement &&
            (element.inputMode === "decimal" || element.type === "number" && (element.step === "any" || element.step.includes(".")));
        masked = element instanceof HTMLInputElement && element.type === "password";
        maxLength = element.maxLength && element.maxLength > 0 ? element.maxLength : 120;
        maxValue = element instanceof HTMLInputElement && element.max !== "" && Number.isFinite(Number(element.max)) ? Number(element.max) : null;
        title = fieldTitle(element);
        visible = true;
        updateTargetRect();
        refocusTarget();
    }

    function handleFocus(event: FocusEvent) {
        const element = event.target as Element | null;
        if (element instanceof HTMLElement && element.dataset.touchKeyboard === "button") return;
        if (element instanceof HTMLElement && element.dataset.touchKeyboard === "manual" && element !== lastPointerTarget) return;
        if (canUseTouchInput(element)) openFor(element);
    }

    function handleOpenRequest(event: Event) {
        const element = (event as CustomEvent<{ target?: Element }>).detail?.target ?? null;
        if (canUseTouchInput(element)) openFor(element);
    }

    function applyValue() {
        if (!visible || !target || value === lastAppliedValue) return;
        target.value = value;
        lastAppliedValue = value;
        applySelection();
        target.dispatchEvent(new Event("input", { bubbles: true }));
        updateTargetRect();
        refocusTarget();
    }

    function done() {
        const finishedTarget = target;
        if (finishedTarget?.isConnected) applyValue();
        finishedTarget?.dispatchEvent(new Event("change", { bubbles: true }));
        visible = false;
        finishedTarget?.classList.remove(...activeInputClasses);
        target = null;
        targetRectStyle = "";
        if (focusTimer) window.clearTimeout(focusTimer);
    }

    function keepTargetFocused(event: PointerEvent) {
        const element = event.target as Element | null;
        if (element?.closest("button, .digit-display")) {
            event.preventDefault();
            refocusTarget();
        }
    }

    function refocusTarget() {
        if (!target?.isConnected) return;
        const element = target;
        if (focusTimer) window.clearTimeout(focusTimer);
        focusTimer = window.setTimeout(async () => {
            await tick();
            if (!element.isConnected || target !== element) return;
            updateTargetRect();
            element.focus({ preventScroll: true });
            applySelection();
        }, 0);
    }

    function applySelection() {
        if (!target?.isConnected) return;
        selectionStart = Math.max(0, Math.min(selectionStart, target.value.length));
        selectionEnd = Math.max(0, Math.min(selectionEnd, target.value.length));
        try {
            target.setSelectionRange(selectionStart, selectionEnd);
        } catch {
            // Some input types do not support text selection.
        }
    }

    function syncSelectionFromTarget() {
        if (!target?.isConnected) return;
        selectionStart = target.selectionStart ?? target.value.length;
        selectionEnd = target.selectionEnd ?? selectionStart;
    }

    function handleKeyboardSelectionChange(start: number, end: number) {
        selectionStart = start;
        selectionEnd = end;
        refocusTarget();
    }

    function updateTargetRect() {
        if (!target?.isConnected) {
            if (visible) done();
            targetRectStyle = "";
            return;
        }
        const rect = target.getBoundingClientRect();
        targetRectStyle = [
            `left:${Math.max(8, rect.left)}px`,
            `top:${Math.max(8, rect.top)}px`,
            `width:${rect.width}px`,
            `height:${rect.height}px`,
        ].join(";");
    }

    $: if (visible && target && value !== lastAppliedValue) {
        applyValue();
    }

    $: {
        const rawText = value || target?.value || "";
        liftedIsPlaceholder = !rawText;
        liftedText = rawText
            ? (masked ? "●".repeat(rawText.length) : rawText)
            : (target?.placeholder || title);
    }

    onMount(() => {
        const handlePointer = (event: PointerEvent) => { lastPointerTarget = event.target as Element | null; };
        const handleClose = () => done();
        const handleInput = (event: Event) => {
            const activeTarget = target;
            if (!activeTarget || event.target !== activeTarget) return;
            value = activeTarget.value;
            lastAppliedValue = value;
            syncSelectionFromTarget();
        };
        const handleSelectionChange = () => {
            if (document.activeElement === target) syncSelectionFromTarget();
        };
        const handleKeydown = (event: KeyboardEvent) => {
            if (event.key === "Escape" && visible) {
                event.preventDefault();
                done();
            }
        };
        document.addEventListener("pointerdown", handlePointer, true);
        document.addEventListener("focusin", handleFocus, true);
        document.addEventListener("close-touch-keyboard", handleClose);
        document.addEventListener("open-touch-keyboard", handleOpenRequest);
        document.addEventListener("input", handleInput, true);
        document.addEventListener("selectionchange", handleSelectionChange);
        document.addEventListener("keydown", handleKeydown, true);
        window.addEventListener("resize", updateTargetRect);
        window.addEventListener("scroll", updateTargetRect, true);
        return () => {
            document.removeEventListener("pointerdown", handlePointer, true);
            document.removeEventListener("focusin", handleFocus, true);
            document.removeEventListener("close-touch-keyboard", handleClose);
            document.removeEventListener("open-touch-keyboard", handleOpenRequest);
            document.removeEventListener("input", handleInput, true);
            document.removeEventListener("selectionchange", handleSelectionChange);
            document.removeEventListener("keydown", handleKeydown, true);
            window.removeEventListener("resize", updateTargetRect);
            window.removeEventListener("scroll", updateTargetRect, true);
            target?.classList.remove(...activeInputClasses);
            if (focusTimer) window.clearTimeout(focusTimer);
        };
    });
</script>

{#if visible}
    <div
        class="touch-input-backdrop fixed inset-0 z-[1900]"
        role="button"
        tabindex="0"
        aria-label="Close touch keyboard"
        on:click={done}
        on:keydown={(event) => (event.key === "Enter" || event.key === " ") && done()}
    ></div>
    {#if targetRectStyle}
        <div
            class="touch-input-lifted pointer-events-none fixed z-[1901] flex items-center overflow-hidden rounded-xl border-2 border-accent-primary bg-bg-card px-4 font-bold text-text-main shadow-[0_18px_45px_var(--shadow)]"
            style={targetRectStyle}
            aria-hidden="true"
        >
            <span class="overflow-hidden text-ellipsis whitespace-nowrap {liftedIsPlaceholder ? 'text-text-muted font-bold' : ''}">
                {liftedText}
            </span>
        </div>
    {/if}
    <div
        class="touch-input-panel fixed bottom-2 left-1/2 z-[1902] w-[min(980px,calc(100%_-_1rem))] -translate-x-1/2 overflow-hidden rounded-xl border border-border-flat bg-bg-panel shadow-[0_-15px_55px_var(--shadow)]"
        role="dialog"
        tabindex="-1"
        aria-modal="true"
        aria-label={title}
        on:pointerdown={keepTargetFocused}
        on:click|stopPropagation
        on:keydown={(event) => event.key === "Escape" && done()}
    >
        {#if numeric}
            <div class="flex items-center justify-between gap-2 px-[.8rem] pb-0 pt-[.7rem]">
                <div class="flex flex-col">
                    <span class="text-[.65rem] font-black uppercase tracking-[.1em] text-accent-primary">Touch digit pad</span>
                    <strong>{title}</strong>
                </div>
                <button type="button" class="rounded-[.45rem] border border-border-flat bg-bg-card px-[.8rem] py-[.55rem] text-text-main" on:click={done}>Close</button>
            </div>
            <div class="mx-auto w-[min(420px,100%)] p-[.65rem]">
                <TouchDigitPad
                    bind:value
                    {masked}
                    allowDecimal={decimal}
                    maxLength={target?.maxLength && target.maxLength > 0 ? target.maxLength : 32}
                    max={maxValue}
                    placeholder={title}
                    submitLabel="Done"
                    onSubmit={done}
                />
            </div>
        {:else}
            <TouchKeyboard
                bind:value
                bind:visible
                {masked}
                {title}
                {maxLength}
                bind:selectionStart
                bind:selectionEnd
                placeholder={target?.placeholder || "Touch the keys to enter text"}
                onDone={done}
                onSelectionChange={handleKeyboardSelectionChange}
            />
        {/if}
    </div>
{/if}
