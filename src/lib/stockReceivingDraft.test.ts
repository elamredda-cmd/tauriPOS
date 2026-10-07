import { describe, expect, it } from 'vitest';
import { validateReceivingDraft, type ReceivingDraftLine } from './stockReceivingDraft';

function line(overrides: Partial<ReceivingDraftLine> = {}): ReceivingDraftLine {
    return {
        id: 'line-1',
        productId: 'product-1',
        productName: 'Tea',
        inventoryLogId: 'inventory-1',
        quantityInput: '3',
        unitCostInput: '1.13',
        ...overrides,
    };
}

describe('stock receiving draft validation', () => {
    it('returns every line, preserving identifiers and exact integer-pence totals', () => {
        const result = validateReceivingDraft([
            line(),
            line({ id: 'line-2', productId: 'product-2', inventoryLogId: 'inventory-2', quantityInput: '2', unitCostInput: '.50' }),
        ]);
        expect(result).toMatchObject({ valid: true, totalCost: 439, totalUnits: 5, message: '', errors: {} });
        expect(result.lines).toEqual([
            { id: 'line-1', productId: 'product-1', productName: 'Tea', inventoryLogId: 'inventory-1', quantity: 3, unitCost: 113 },
            { id: 'line-2', productId: 'product-2', productName: 'Tea', inventoryLogId: 'inventory-2', quantity: 2, unitCost: 50 },
        ]);
    });

    it.each([
        ['0', 0], ['0.00', 0], ['.0', 0], ['.00', 0], ['.5', 50], ['.50', 50],
        ['1', 100], ['1.1', 110], ['1.13', 113], ['8.03', 803], ['0.29', 29],
        ['00001.09', 109], [' 2.50 ', 250], ['90071992547409.91', Number.MAX_SAFE_INTEGER],
    ])('parses the accepted pound input %j as exactly %i pence', (unitCostInput, unitCost) => {
        const result = validateReceivingDraft([line({ quantityInput: '1', unitCostInput })]);
        expect(result.valid).toBe(true);
        expect(result.lines[0].unitCost).toBe(unitCost);
        expect(result.totalCost).toBe(unitCost);
    });

    it.each(['1', '0001', ' 1 ', '2147483647'])('accepts a bounded whole quantity %j', (quantityInput) => {
        const result = validateReceivingDraft([line({ quantityInput, unitCostInput: '0' })]);
        expect(result.valid).toBe(true);
        expect(result.totalUnits).toBe(Number(quantityInput));
    });

    it.each(['', ' ', '0', '000', '-1', '+1', '1.0', '1.5', '.5', '1e2', 'NaN', 'Infinity', '1,000', '1 000', '1x', '0x10', '2147483648', '9007199254740993'])
        ('rejects quantity %j without rounding or silently omitting it', (quantityInput) => {
            const result = validateReceivingDraft([line({ quantityInput })]);
            expect(result.valid).toBe(false);
            expect(result.errors['line-1'].quantity).toMatch(/whole quantity/i);
            expect(result.lines).toEqual([]);
            expect(result.totalCost).toBe(0);
            expect(result.totalUnits).toBe(0);
        });

    it.each(['', ' ', '.', '1.', '-1', '-0', '-0.01', '+1', '0.001', '1.234', '.001', '1e2', 'NaN', 'Infinity', '£1.00', '1,000', '1 000', '1x', '0x10', '90071992547409.92', '90071992547410', '9'.repeat(400)])
        ('rejects cost %j without rounding, clamping or non-finite totals', (unitCostInput) => {
            const result = validateReceivingDraft([line({ unitCostInput })]);
            expect(result.valid).toBe(false);
            expect(result.errors['line-1'].unitCost).toBeTruthy();
            expect(result.lines).toEqual([]);
            expect(result.totalCost).toBe(0);
            expect(Number.isSafeInteger(result.totalCost)).toBe(true);
        });

    it('checks all rows and both fields, never returning a partial delivery', () => {
        const result = validateReceivingDraft([
            line(),
            line({ id: 'line-2', productId: 'product-2', quantityInput: '1.1', unitCostInput: '-1' }),
            line({ id: 'line-3', productId: 'product-3', quantityInput: '', unitCostInput: '' }),
        ]);
        expect(result.valid).toBe(false);
        expect(result.errors['line-1']).toBeUndefined();
        expect(result.errors['line-2'].quantity).toBeTruthy();
        expect(result.errors['line-2'].unitCost).toBeTruthy();
        expect(result.errors['line-3'].quantity).toBeTruthy();
        expect(result.errors['line-3'].unitCost).toBeTruthy();
        expect(result.lines).toEqual([]);
        expect(result.totalCost).toBe(0);
    });

    it('rejects an empty delivery', () => {
        expect(validateReceivingDraft([])).toMatchObject({ valid: false, lines: [], totalCost: 0, totalUnits: 0, message: expect.stringMatching(/at least one/i) });
    });

    it('flags every duplicate product row even with different display names', () => {
        const result = validateReceivingDraft([
            line(),
            line({ id: 'line-2', productName: 'Renamed tea' }),
            line({ id: 'line-3', productId: 'product-3' }),
        ]);
        expect(result.valid).toBe(false);
        expect(result.errors['line-1'].quantity).toMatch(/more than once/i);
        expect(result.errors['line-2'].quantity).toMatch(/more than once/i);
        expect(result.errors['line-3']).toBeUndefined();
        expect(result.message).toMatch(/only once/i);
        expect(result.lines).toEqual([]);
    });

    it('preserves numeric errors when a duplicate also has invalid input', () => {
        const result = validateReceivingDraft([line(), line({ id: 'line-2', quantityInput: '0' })]);
        expect(result.errors['line-2'].quantity).toMatch(/whole quantity.*more than once/i);
    });

    it('allows different products with the same name', () => {
        const result = validateReceivingDraft([line(), line({ id: 'line-2', productId: 'product-2' })]);
        expect(result.valid).toBe(true);
        expect(result.lines).toHaveLength(2);
    });

    it('rejects a multiplied line total beyond safe integer precision', () => {
        const result = validateReceivingDraft([line({ quantityInput: '2', unitCostInput: '90071992547409.91' })]);
        expect(result).toMatchObject({ valid: false, totalCost: 0, lines: [] });
        expect(result.errors['line-1'].unitCost).toMatch(/total is too large/i);
    });

    it('rejects a combined total beyond safe integer precision', () => {
        const result = validateReceivingDraft([
            line({ quantityInput: '1', unitCostInput: '90071992547409.91' }),
            line({ id: 'line-2', productId: 'product-2', quantityInput: '1', unitCostInput: '.01' }),
        ]);
        expect(result).toMatchObject({ valid: false, totalCost: 0, lines: [] });
        expect(result.errors['line-2'].unitCost).toMatch(/total is too large/i);
    });

    it('accepts a combined total at the safe integer boundary', () => {
        const result = validateReceivingDraft([
            line({ quantityInput: '1', unitCostInput: '90071992547409.90' }),
            line({ id: 'line-2', productId: 'product-2', quantityInput: '1', unitCostInput: '.01' }),
        ]);
        expect(result.valid).toBe(true);
        expect(result.totalCost).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('allows aggregate unit counts above a single line INT limit', () => {
        const result = validateReceivingDraft([
            line({ quantityInput: '2147483647', unitCostInput: '0' }),
            line({ id: 'line-2', productId: 'product-2', quantityInput: '2147483647', unitCostInput: '0' }),
        ]);
        expect(result.valid).toBe(true);
        expect(result.totalUnits).toBe(4_294_967_294);
    });

    it('does not mutate the original draft or normalize the visible input while typing', () => {
        const draft = [Object.freeze(line({ quantityInput: '0001', unitCostInput: '.5' }))];
        const before = structuredClone(draft);
        validateReceivingDraft(draft);
        expect(draft).toEqual(before);
    });
});
