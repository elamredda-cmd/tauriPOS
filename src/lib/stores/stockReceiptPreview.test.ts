import { describe, expect, it } from 'vitest';
import type { Product } from './db';
import type { StockReceiptBundle } from './database';
import { createStockReceiptPreview, MAX_STOCK_QUANTITY, validateStockReceiptBundle } from './stockReceiptPreview';

function bundle(id = 'receipt-1'): StockReceiptBundle {
    const stamp = '2026-09-08T12:00:00.000Z';
    return {
        receipt: { id, supplierId: '', employeeId: 'employee-1', reference: 'INV-1', notes: '',
            totalCost: 120, status: 'received', createdAt: stamp, updatedAt: stamp },
        lines: [{ id: `${id}-line`, receiptId: id, productId: 'product-1', productName: 'Test product',
            quantity: 3, unitCost: 40, inventoryLogId: `${id}-log`, createdAt: stamp, updatedAt: stamp }],
        audit: { id: `${id}-audit`, employeeId: 'employee-1', action: 'stock_received', entityType: 'stock_receipt',
            entityId: id, oldData: '', newData: '{}', createdAt: stamp },
    };
}

const product = (stockLevel: number | null = 10): Product => ({
    id: 'product-1', name: 'Test product', stockLevel,
} as Product);

describe('stock receipt validation', () => {
    it('accepts correct totals including free stock', () => {
        expect(() => validateStockReceiptBundle(bundle())).not.toThrow();
        const free = bundle();
        free.lines[0].unitCost = 0;
        free.receipt.totalCost = 0;
        expect(() => validateStockReceiptBundle(free)).not.toThrow();
    });

    it.each([0, -1, 1.5, NaN, Infinity, MAX_STOCK_QUANTITY + 1])('rejects invalid quantity %s', (quantity) => {
        const invalid = bundle();
        invalid.lines[0].quantity = quantity;
        invalid.receipt.totalCost = quantity * 40;
        expect(() => validateStockReceiptBundle(invalid)).toThrow('whole quantity');
    });

    it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid unit cost %s', (cost) => {
        const invalid = bundle();
        invalid.lines[0].unitCost = cost;
        invalid.receipt.totalCost = cost * 3;
        expect(() => validateStockReceiptBundle(invalid)).toThrow('valid unit cost');
    });

    it('rejects safe operands whose product is not safe', () => {
        const invalid = bundle();
        invalid.lines[0].unitCost = Number.MAX_SAFE_INTEGER;
        invalid.receipt.totalCost = Number.MAX_SAFE_INTEGER * 3;
        expect(() => validateStockReceiptBundle(invalid)).toThrow('total is too large');
    });

    it('rejects safe line totals whose aggregate is not safe', () => {
        const invalid = bundle();
        invalid.lines[0].quantity = 1;
        invalid.lines[0].unitCost = Number.MAX_SAFE_INTEGER;
        invalid.lines.push({ ...invalid.lines[0], id: 'second-line', productId: 'second-product',
            inventoryLogId: 'second-log', unitCost: 1 });
        invalid.receipt.totalCost = Number.MAX_SAFE_INTEGER + 1;
        expect(() => validateStockReceiptBundle(invalid)).toThrow('total is too large');
    });

    it('rejects mismatched totals and audit employees', () => {
        const invalid = bundle();
        invalid.receipt.totalCost++;
        expect(() => validateStockReceiptBundle(invalid)).toThrow('does not match');
        invalid.receipt.totalCost--;
        invalid.audit.employeeId = 'different-employee';
        expect(() => validateStockReceiptBundle(invalid)).toThrow('audit is invalid');
    });

    it.each(['productId', 'id', 'inventoryLogId'] as const)('rejects duplicate %s', (field) => {
        const invalid = bundle();
        invalid.lines.push({ ...invalid.lines[0], id: 'line-2', productId: 'product-2', inventoryLogId: 'log-2',
            [field]: invalid.lines[0][field] });
        invalid.receipt.totalCost *= 2;
        expect(() => validateStockReceiptBundle(invalid)).toThrow('duplicate product line');
    });
});

describe('isolated stock receipt preview', () => {
    it('increments stock and returns matching inventory/audit records only once', () => {
        const preview = createStockReceiptPreview();
        const original = [product()];
        const receipt = bundle();
        const result = preview.commit(receipt, original)!;
        expect(original[0].stockLevel).toBe(10);
        expect(result.products[0].stockLevel).toBe(13);
        expect(result.logs).toEqual([expect.objectContaining({ type: 'restock', quantityChange: 3,
            referenceId: 'receipt-1', notes: 'Stock receipt INV-1' })]);
        expect(result.audit).toEqual(receipt.audit);
        expect(preview.recent()).toEqual([receipt.receipt]);
        expect(preview.commit(receipt, result.products)).toBeNull();
        expect(preview.recent()).toHaveLength(1);
    });

    it('never retains partial data when a product no longer exists, and permits retry', () => {
        const preview = createStockReceiptPreview();
        const receipt = bundle();
        receipt.lines.push({ ...receipt.lines[0], id: 'line-2', productId: 'product-2', inventoryLogId: 'log-2' });
        receipt.receipt.totalCost *= 2;
        const products = [product()];
        expect(() => preview.commit(receipt, products)).toThrow('no longer available');
        expect(products[0].stockLevel).toBe(10);
        expect(preview.recent()).toEqual([]);
        const result = preview.commit(receipt, [...products, { ...product(), id: 'product-2' }])!;
        expect(result.products.map((item) => item.stockLevel)).toEqual([13, 13]);
    });

    it('normalizes legacy NULL stock and permits existing negative stock', () => {
        const preview = createStockReceiptPreview();
        expect(preview.commit(bundle(), [product(null)])!.products[0].stockLevel).toBe(3);
        expect(preview.commit(bundle('receipt-2'), [product(-5)])!.products[0].stockLevel).toBe(-2);
    });

    it('rejects resulting stock overflow before recording a receipt', () => {
        const preview = createStockReceiptPreview();
        expect(() => preview.commit(bundle(), [product(MAX_STOCK_QUANTITY - 1)]))
            .toThrow('exceed the supported range');
        expect(preview.recent()).toEqual([]);
        expect(preview.commit(bundle(), [product(MAX_STOCK_QUANTITY - 3)])!.products[0].stockLevel)
            .toBe(MAX_STOCK_QUANTITY);
    });

    it('keeps a snapshot of submitted history and returns independent copies newest first', () => {
        const preview = createStockReceiptPreview();
        const first = bundle();
        preview.commit(first, [product()]);
        first.receipt.reference = 'changed after saving';
        const second = bundle('receipt-2');
        second.receipt.createdAt = '2026-09-09T12:00:00.000Z';
        preview.commit(second, [product()]);
        expect(preview.recent(1.9).map((receipt) => receipt.id)).toEqual(['receipt-2']);
        const history = preview.recent();
        expect(history[1].reference).toBe('INV-1');
        history[0].reference = 'changed history';
        expect(preview.recent()[0].reference).toBe('INV-1');
    });

    it('rejects reused record IDs without committing a second receipt', () => {
        const preview = createStockReceiptPreview();
        preview.commit(bundle(), [product()]);
        const collision = bundle('receipt-2');
        collision.lines[0].inventoryLogId = 'receipt-1-log';
        expect(() => preview.commit(collision, [product()])).toThrow('already uses this identifier');
        expect(preview.recent()).toHaveLength(1);
    });
});
