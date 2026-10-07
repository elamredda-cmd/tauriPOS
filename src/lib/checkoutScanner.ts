/** A keyboard-wedge scanner sends a short burst followed by Enter. */
export class CheckoutScannerBuffer {
    private value = '';
    private lastKeyAt: number | null = null;
    private overflowed = false;

    get pending(): boolean {
        return this.lastKeyAt !== null;
    }

    clear() {
        this.value = '';
        this.lastKeyAt = null;
        this.overflowed = false;
    }

    push(key: string, now: number): { captured: boolean; barcode?: string } {
        if (key === 'Enter') {
            const barcode = this.lastKeyAt !== null && now - this.lastKeyAt <= 350 &&
                !this.overflowed && this.value.length >= 4 ? this.value : undefined;
            this.clear();
            return { captured: Boolean(barcode), barcode };
        }

        // Uppercase/alphanumeric scanners can emit Shift between characters.
        if (key === 'Shift') return { captured: false };
        if (key.length !== 1 || !/^[A-Za-z0-9._-]$/.test(key)) {
            this.clear();
            return { captured: false };
        }

        if (this.lastKeyAt !== null && now - this.lastKeyAt > 120) this.clear();
        this.lastKeyAt = now;
        if (this.value.length < 64) this.value += key;
        else this.overflowed = true;
        // Reject an overlong code as a whole; its suffix could be another item.
        return { captured: true };
    }
}
