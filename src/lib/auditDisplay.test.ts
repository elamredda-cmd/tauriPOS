import { describe, expect, it } from 'vitest';
import { auditActionLabel, auditEntityLabel, buildAuditChanges } from './auditDisplay';

describe('Dojo receipt-review audit display', () => {
    it('labels the review clearly and formats extra amounts as money', () => {
        expect(auditActionLabel('dojo_expired_payment_review')).toBe('Dojo receipt result reviewed');
        expect(auditEntityLabel('payment_terminal_attempt')).toBe('Terminal payment');
        const changes = buildAuditChanges({ action: 'dojo_expired_payment_review',
            entityType: 'payment_terminal_attempt', entityId: 'test', oldData: '{}',
            newData: JSON.stringify({ tipsAmount: 50, serviceChargeAmount: 10, cashbackAmount: 200, receiptReference: 'UAT', pin: 'never-display' }) });
        expect(changes.find(change => change.key === 'tipsAmount')?.after).toBe('£0.50');
        expect(changes.find(change => change.key === 'serviceChargeAmount')?.after).toBe('£0.10');
        expect(changes.find(change => change.key === 'cashbackAmount')?.after).toBe('£2.00');
        expect(changes.some(change => change.key === 'pin')).toBe(false);
    });
});
