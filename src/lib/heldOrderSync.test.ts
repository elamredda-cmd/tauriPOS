import { describe, expect, it } from 'vitest';
import { heldUploadBlockReason, isNullReceiptHoldConflict } from './heldOrderSync';

describe('held trolley upload state', () => {
    it('does not report shared success when a drain leaves an order or line pending', () => {
        expect(heldUploadBlockReason('h', [{ table_name: 'orders', operation: 'heldOrderBundle', data: JSON.stringify({ order: { id: 'h' } }) }], [])).toContain('waiting to upload');
        expect(heldUploadBlockReason('h', [{ table_name: 'order_lines', operation: 'upsert', data: JSON.stringify({ orderId: 'h' }) }], [])).toContain('waiting to upload');
    });
    it('keeps failed uploads distinct from a claim by another till', () => {
        expect(heldUploadBlockReason('h', [], [{ table_name: 'orders', operation: 'upsert', data: '{"id":"h"}' }])).toContain('upload issue');
        expect(heldUploadBlockReason('other', [{ table_name: 'orders', operation: 'upsert', data: '{"id":"h"}' }], [])).toBeNull();
    });
    it('only automatically retries the exact unpaid null-receipt regression', () => {
        const order = { id: 'h', type: 'sale', status: 'hold', orderNumber: 0, receiptKey: null, amountTendered: 0 };
        const conflict = { table_name: 'orders', operation: 'upsert', reason: 'Invalid held order: invalid type: null, expected a string', data: JSON.stringify(order) };
        expect(isNullReceiptHoldConflict(conflict)).toBe(true);
        expect(isNullReceiptHoldConflict({ ...conflict, data: JSON.stringify({ ...order, status: 'completed' }) })).toBe(false);
        expect(isNullReceiptHoldConflict({ ...conflict, reason: 'SERVER_DATA_EPOCH_MISMATCH' })).toBe(false);
    });
});
