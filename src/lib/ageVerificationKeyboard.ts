type ActivationKeyEvent = Pick<KeyboardEvent, 'key' | 'repeat'> &
    Partial<Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'isComposing'>>;

function isActivationKey(key: string): boolean {
    return key === 'Enter' || key === ' ';
}

/**
 * An age check must not inherit the key that opened it, even when a cached
 * lookup renders it before the scanner's Enter has been released. Track keys
 * before the dialog opens, and consume their release as well as repeats.
 */
export class AgeVerificationKeyboardGuard {
    private heldActivationKeys = new Set<string>();
    private openingActivationKeys = new Set<string>();
    private open = false;
    private scannerTyping = false;

    begin() {
        this.open = true;
        this.openingActivationKeys = new Set(this.heldActivationKeys);
        this.scannerTyping = false;
    }

    end() {
        this.open = false;
        this.openingActivationKeys.clear();
        this.scannerTyping = false;
    }

    keydown(event: ActivationKeyEvent): boolean {
        const activation = isActivationKey(event.key);
        const alreadyHeld = this.heldActivationKeys.has(event.key);
        if (activation) this.heldActivationKeys.add(event.key);
        if (!this.open || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return false;

        if (activation && (event.repeat || alreadyHeld || this.openingActivationKeys.has(event.key))) {
            return true;
        }

        // This dialog has no text fields. A second scanner burst must not
        // activate whichever decision button the cashier last focused.
        if (event.key.length === 1 && event.key !== ' ') {
            this.scannerTyping = true;
            return true;
        }
        if (activation && this.scannerTyping) return true;

        // Deliberate keyboard navigation or a pointer gesture ends a discarded
        // scan; its terminator alone never counts as an approval gesture.
        if (event.key === 'Tab' || event.key.startsWith('Arrow')) this.scannerTyping = false;
        return false;
    }

    keyup(key: string): boolean {
        this.heldActivationKeys.delete(key);
        const openingKey = this.openingActivationKeys.delete(key);
        return this.open && (openingKey || (isActivationKey(key) && this.scannerTyping));
    }

    pointerdown() {
        this.scannerTyping = false;
    }

    releaseKeys() {
        // A key released while another application has focus emits no keyup
        // here. Do not mistake the next deliberate press for a held key.
        this.heldActivationKeys.clear();
        this.openingActivationKeys.clear();
    }
}
