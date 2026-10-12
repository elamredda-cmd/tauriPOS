/** Keep a persistent keyboard attached only to a visible, editable live field. */
export function isLiveTouchInputTarget(element: HTMLInputElement | HTMLTextAreaElement | null): element is HTMLInputElement | HTMLTextAreaElement {
    if (!element?.isConnected || element.disabled || element.readOnly || element.dataset.touchKeyboard === 'off') return false;
    if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    if (!element.getClientRects().length) return false;
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.display !== 'none';
}
