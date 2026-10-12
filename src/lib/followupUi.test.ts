import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasActualPriceOverride } from './scaleSale';
import { editPriceDigits } from './pricePad';
import { isLiveTouchInputTarget } from './touchInputTarget';
import { taxRateSnapshotsMatch, updatedTaxRateSnapshot } from './taxRateSnapshot';
import { readFileSync } from 'node:fs';

afterEach(() => vi.unstubAllGlobals());
describe('audit follow-up UI logic', () => {
    it('lets desktop scale tile rows grow with their two text lines', () => {
        const source = readFileSync('src/routes/design/scale/+page.svelte', 'utf8');
        expect(source).toContain('.current-product { min-height: calc(3.2em + .9rem); flex-shrink: 0; }');
        expect(source).toContain('.available-list { grid-auto-rows: minmax(calc(3.2em + .9rem), auto); }');
    });
    const weighed = { notes: 'Manual scale: 1250 g', quantity: 1, originalPrice: 249, unitPrice: 311, isPriceOverride: true };
    it('does not call an unchanged weighted line a cashier price change', () => {
        expect(hasActualPriceOverride(weighed)).toBe(false);
        expect(hasActualPriceOverride({ ...weighed, quantity: -1 })).toBe(false);
    });
    it('retains genuine weighted and ordinary price-change disclosure', () => {
        expect(hasActualPriceOverride({ ...weighed, unitPrice: 400 })).toBe(true);
        expect(hasActualPriceOverride({ ...weighed, notes: '' })).toBe(true);
        expect(hasActualPriceOverride({ ...weighed, isPriceOverride: false })).toBe(false);
    });
    it('can correct price digits without clearing the whole amount', () => {
        expect(editPriceDigits('169', false, '⌫')).toEqual({ value: '16', started: true });
        expect(editPriceDigits('0', true, '⌫')).toEqual({ value: '0', started: true });
        expect(editPriceDigits('169', false, '5')).toEqual({ value: '5', started: true });
        expect(editPriceDigits('169', true, '00').value).toBe('16900');
        expect(editPriceDigits('123456789', true, '0').value).toBe('123456789');
    });
    function target(patch: Record<string, unknown> = {}) {
        return { isConnected: true, disabled: false, readOnly: false, dataset: {}, closest: () => null,
            getClientRects: () => [{}], ...patch } as unknown as HTMLInputElement;
    }
    it('rejects detached, disabled, hidden and ineligible keyboard targets', () => {
        vi.stubGlobal('getComputedStyle', () => ({ display: 'block', visibility: 'visible' }));
        expect(isLiveTouchInputTarget(target())).toBe(true);
        for (const patch of [{ isConnected: false }, { disabled: true }, { readOnly: true },
            { dataset: { touchKeyboard: 'off' } }, { closest: () => ({}) }, { getClientRects: () => [] }]) {
            expect(isLiveTouchInputTarget(target(patch))).toBe(false);
        }
        vi.stubGlobal('getComputedStyle', () => ({ display: 'block', visibility: 'hidden' }));
        expect(isLiveTouchInputTarget(target())).toBe(false);
    });
    const tax = { id: 'old', name: 'Standard', rate: 0.2, isDefault: true, createdAt: '2026-10-12' };
    it('compares tax baselines independent of row order and native boolean representation', () => {
        const other = { ...tax, id: 'other', isDefault: false };
        expect(taxRateSnapshotsMatch([tax, other], [other, { ...tax, isDefault: 1 as unknown as boolean }])).toBe(true);
        expect(taxRateSnapshotsMatch([tax], [{ ...tax, name: 'Changed' }])).toBe(false);
    });
    it('constructs one complete default-tax snapshot without mutating the editor base', () => {
        const before = [tax];
        const saved = { ...tax, id: 'new', name: 'Zero', rate: 0 };
        expect(updatedTaxRateSnapshot(saved, before).filter(row => row.isDefault).map(row => row.id)).toEqual(['new']);
        expect(before[0].isDefault).toBe(true);
        expect(() => updatedTaxRateSnapshot({ ...saved, rate: -1 }, before)).toThrow();
    });
});
