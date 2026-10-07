import { describe, expect, it } from 'vitest';
import { CheckoutScannerBuffer } from './checkoutScanner';

function scan(buffer: CheckoutScannerBuffer, barcode: string, start = 0, gap = 15) {
    for (const [index, character] of [...barcode].entries()) {
        expect(buffer.push(character, start + index * gap).captured).toBe(true);
    }
    return buffer.push('Enter', start + barcode.length * gap);
}

describe('checkout barcode capture over a sale-complete prompt', () => {
    it('retains the first digit and returns the whole barcode once', () => {
        const buffer = new CheckoutScannerBuffer();
        expect(scan(buffer, '0501234567890')).toEqual({ captured: true, barcode: '0501234567890' });
        expect(buffer.pending).toBe(false);
        expect(buffer.push('Enter', 210)).toEqual({ captured: false, barcode: undefined });
    });

    it('captures a following scan separately without duplicating the preceding code', () => {
        const buffer = new CheckoutScannerBuffer();
        expect(scan(buffer, '1234').barcode).toBe('1234');
        expect(scan(buffer, '5678', 80).barcode).toBe('5678');
    });

    it('stays pending while a dialog disappears or the input receives focus', () => {
        const buffer = new CheckoutScannerBuffer();
        expect(buffer.pending).toBe(false);
        buffer.push('0', 0);
        expect(buffer.pending).toBe(true);
        // Focus ownership belongs to the capture listener until the terminator.
        for (const [index, key] of [...'123'].entries()) buffer.push(key, 10 + index * 10);
        expect(buffer.push('Enter', 40).barcode).toBe('0123');
        expect(buffer.pending).toBe(false);
    });

    it('does not turn Enter alone or short accidental typing into a scan', () => {
        const buffer = new CheckoutScannerBuffer();
        expect(buffer.push('Enter', 0).captured).toBe(false);
        expect(scan(buffer, '12').barcode).toBeUndefined();
    });

    it('starts fresh after slow typing without appending it to a genuine scan', () => {
        const buffer = new CheckoutScannerBuffer();
        buffer.push('x', 0);
        buffer.push('y', 200);
        expect(scan(buffer, '1234', 400).barcode).toBe('1234');
    });

    it('ignores a stale Enter even if the expiry callback was delayed', () => {
        const buffer = new CheckoutScannerBuffer();
        for (const [index, key] of [...'1234'].entries()) buffer.push(key, index * 15);
        expect(buffer.push('Enter', 500)).toEqual({ captured: false, barcode: undefined });
    });

    it('supports upper-case codes and scanner-emitted Shift events', () => {
        const buffer = new CheckoutScannerBuffer();
        buffer.push('Shift', 0);
        buffer.push('A', 1);
        buffer.push('Shift', 2);
        buffer.push('B', 3);
        buffer.push('-', 4);
        buffer.push('1', 5);
        expect(buffer.push('Enter', 6).barcode).toBe('AB-1');
    });

    it.each(['Escape', 'Tab', 'Backspace', 'ArrowLeft'])('abandons a partial code on %s', (key) => {
        const buffer = new CheckoutScannerBuffer();
        buffer.push('1', 0);
        buffer.push('2', 15);
        expect(buffer.push(key, 20).captured).toBe(false);
        expect(buffer.pending).toBe(false);
        expect(buffer.push('Enter', 30).barcode).toBeUndefined();
    });

    it('rejects an oversized code instead of selling an item matching its suffix', () => {
        const buffer = new CheckoutScannerBuffer();
        expect(scan(buffer, '1'.repeat(65), 0, 1).barcode).toBeUndefined();
        expect(scan(buffer, '1234', 80).barcode).toBe('1234');
    });

    it('clears interrupted input when another dialog blocks checkout', () => {
        const buffer = new CheckoutScannerBuffer();
        buffer.push('1', 0);
        buffer.push('2', 10);
        buffer.clear();
        expect(buffer.pending).toBe(false);
        expect(buffer.push('Enter', 20).barcode).toBeUndefined();
    });
});
