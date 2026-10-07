export type ModalFocusTrapOptions = {
    dismiss?: () => void;
    dismissDisabled?: boolean;
};

const MODAL_SCOPE_SELECTOR = '[data-modal-focus-scope="true"]';
const FOCUSABLE_SELECTOR = [
    '[autofocus]',
    '[data-modal-initial-focus]',
    'button:not([disabled])',
    'a[href]',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

const inertReferences = new Map<HTMLElement, { count: number; original: boolean }>();

function acquireInert(element: HTMLElement) {
    const current = inertReferences.get(element);
    if (current) {
        current.count += 1;
        return;
    }
    inertReferences.set(element, { count: 1, original: element.inert });
    element.inert = true;
}

function releaseInert(element: HTMLElement) {
    const current = inertReferences.get(element);
    if (!current) return;
    current.count -= 1;
    if (current.count > 0) return;
    element.inert = current.original;
    inertReferences.delete(element);
}

function focusableElements(node: HTMLElement): HTMLElement[] {
    return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter((element) => !element.inert && element.getAttribute('aria-hidden') !== 'true');
}

function focusFirstInScope(node: HTMLElement) {
    const preferred = node.querySelector<HTMLElement>('[autofocus], [data-modal-initial-focus]');
    if (preferred && !preferred.inert && !preferred.matches(':disabled')) {
        preferred.focus({ preventScroll: true });
        return;
    }
    const focusable = focusableElements(node);
    (focusable[0] || node).focus({ preventScroll: true });
}

function topModalScope(): HTMLElement | null {
    const scopes = document.querySelectorAll<HTMLElement>(MODAL_SCOPE_SELECTOR);
    return scopes.length ? scopes[scopes.length - 1] : null;
}

function topAriaModal(): HTMLElement | null {
    const modals = document.querySelectorAll<HTMLElement>('[aria-modal="true"]');
    return modals.length ? modals[modals.length - 1] : null;
}

/**
 * Keeps keyboard and assistive-technology focus inside the top-most modal.
 * Background branches are made inert and the previously focused control is
 * restored when the modal is removed.
 */
export function modalFocusTrap(node: HTMLElement, initialOptions: ModalFocusTrapOptions = {}) {
    let options = initialOptions;
    const previouslyFocused = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const inerted = new Set<HTMLElement>();
    let focusTimer: ReturnType<typeof setTimeout> | undefined;
    let focusCheckTimer: ReturnType<typeof setTimeout> | undefined;

    node.dataset.modalFocusScope = 'true';
    if (!node.hasAttribute('tabindex')) node.tabIndex = -1;
    const activeTopScope = topModalScope();

    let branch: HTMLElement = node;
    while (branch.parentElement) {
        const parent = branch.parentElement;
        for (const sibling of Array.from(parent.children)) {
            if (sibling !== branch && sibling instanceof HTMLElement) {
                if (activeTopScope !== node && sibling.contains(activeTopScope)) continue;
                acquireInert(sibling);
                inerted.add(sibling);
            }
        }
        if (parent === document.body) break;
        branch = parent;
    }

    function isTopModal(): boolean {
        const top = topAriaModal();
        return topModalScope() === node && (top === node || Boolean(top && node.contains(top)));
    }

    function focusFirst() {
        if (!node.isConnected || !isTopModal()) return;
        focusFirstInScope(node);
    }

    function checkFocusAfterContentChange() {
        if (focusCheckTimer) clearTimeout(focusCheckTimer);
        focusCheckTimer = setTimeout(() => {
            focusCheckTimer = undefined;
            if (!node.contains(document.activeElement)) focusFirst();
        }, 0);
    }

    function handleFocusIn(event: FocusEvent) {
        if (!isTopModal() || node.contains(event.target as Node)) return;
        event.stopPropagation();
        focusFirst();
    }

    function handleKeydown(event: KeyboardEvent) {
        if (!isTopModal()) return;

        if (event.key === 'Escape') {
            // Let an open select close its own list before dismissing the dialog.
            const target = event.target instanceof HTMLElement ? event.target : null;
            if (target?.closest('[role="listbox"], .custom-select-trigger[aria-expanded="true"]')) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            if (!options.dismissDisabled) options.dismiss?.();
            return;
        }

        if (event.key !== 'Tab') {
            if (!node.contains(event.target as Node)) {
                event.preventDefault();
                event.stopImmediatePropagation();
                focusFirst();
            }
            return;
        }

        const focusable = focusableElements(node);
        if (focusable.length === 0) {
            event.preventDefault();
            node.focus({ preventScroll: true });
            return;
        }

        const active = document.activeElement as HTMLElement | null;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && (active === first || !node.contains(active))) {
            event.preventDefault();
            last.focus({ preventScroll: true });
        } else if (!event.shiftKey && (active === last || !node.contains(active))) {
            event.preventDefault();
            first.focus({ preventScroll: true });
        }
    }

    document.addEventListener('focusin', handleFocusIn, true);
    document.addEventListener('keydown', handleKeydown, true);
    const contentObserver = new MutationObserver(checkFocusAfterContentChange);
    contentObserver.observe(node, { childList: true, subtree: true });
    focusTimer = setTimeout(focusFirst, 0);

    return {
        update(nextOptions: ModalFocusTrapOptions = {}) {
            options = nextOptions;
        },
        destroy() {
            if (focusTimer) clearTimeout(focusTimer);
            if (focusCheckTimer) clearTimeout(focusCheckTimer);
            contentObserver.disconnect();
            document.removeEventListener('focusin', handleFocusIn, true);
            document.removeEventListener('keydown', handleKeydown, true);
            delete node.dataset.modalFocusScope;
            for (const element of inerted) releaseInert(element);

            setTimeout(() => {
                const remainingScope = topModalScope();
                const remainingModal = topAriaModal();
                if (
                    remainingScope &&
                    (remainingModal === remainingScope || Boolean(remainingModal && remainingScope.contains(remainingModal)))
                ) {
                    if (!remainingScope.contains(document.activeElement)) {
                        focusFirstInScope(remainingScope);
                    }
                    return;
                }
                if (remainingModal) return;
                if (previouslyFocused?.isConnected) {
                    previouslyFocused.focus({ preventScroll: true });
                }
            }, 0);
        },
    };
}
