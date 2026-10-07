import { describe, expect, it } from 'vitest';
import { getDojoPaymentBreakdown, getDojoPaymentAmountIssue } from './dojoPaymentValidation';
import type { DojoPaymentIntentStatus } from './dojo';

const money = (value: number, currencyCode = 'GBP') => ({ value, currencyCode });
const payment = (changes: Partial<DojoPaymentIntentStatus> = {}): DojoPaymentIntentStatus => ({
    id: 'pi_test', reference: 'sale-1', status: 'Captured', amount: 600, currency: 'GBP', ...changes,
});

describe('Dojo monetary proof', () => {
    it('supports legacy omitted/null optional amounts', () => {
        expect(getDojoPaymentBreakdown(payment({ totalAmount: null, tipsAmount: null }), 600, 'GBP').cardChargedAmount).toBe(600);
    });
    it('keeps tips, service and cashback separate from merchandise', () => {
        expect(getDojoPaymentBreakdown(payment({ tipsAmount: money(60), serviceChargeAmount: money(40),
            cashbackAmount: money(1000), totalAmount: money(1700) }), 600, 'GBP')).toEqual({
            baseAmount: 600, tipsAmount: 60, serviceChargeAmount: 40, cashbackAmount: 1000,
            cardChargedAmount: 1700, currency: 'GBP',
        });
    });
    it.each(['tipsAmount', 'serviceChargeAmount', 'cashbackAmount'] as const)('requires total proof for %s', (field) => {
        expect(getDojoPaymentAmountIssue(payment({ [field]: money(60) }), 600, 'GBP')).toContain('do not charge');
        expect(getDojoPaymentAmountIssue(payment({ [field]: money(60), totalAmount: money(600) }), 600, 'GBP')).not.toBeNull();
    });
    it.each([
        { amount: 601 }, { currency: 'EUR' }, { totalAmount: money(599) },
        { totalAmount: money(600, 'EUR') }, { tipsAmount: money(-1) },
        { tipsAmount: money(1.5) }, { cashbackAmount: money(Number.MAX_SAFE_INTEGER + 1) },
        { serviceChargeAmount: { value: 0 } }, { tipsAmount: '60' },
        { moneyValidationError: 'Dojo returned invalid tipsAmount' },
        { refundedAmount: 601 }, { refundedAmount: -1 },
    ])('rejects invalid money without claiming no charge: %j', (changes) => {
        expect(getDojoPaymentAmountIssue(payment(changes as any), 600, 'GBP')).toContain('do not charge');
    });
});
