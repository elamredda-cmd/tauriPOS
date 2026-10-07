import { describe, expect, it } from 'vitest';
import { allocateRefundPayment, refundCardInstructions } from './refunds';

describe('refundCardInstructions', () => {
    it.each(['dojo', 'split+dojo', 'sumup', 'split+sumup'])('never asks for a second external refund for %s', (method) => {
        expect(refundCardInstructions([{ method, cardAmount: 100 }])).toContain('automatically');
        expect(refundCardInstructions([{ method, cardAmount: 100 }])).toContain('Do not refund it separately');
    });
    it('recognizes legacy provider references', () => {
        expect(refundCardInstructions([{ method: 'card', cardAmount: 100, reference: 'Dojo TX [id:pi_test]' }])).toContain('automatically');
    });
    it('distinguishes standalone cards and non-card refunds', () => {
        expect(refundCardInstructions([{ method: 'card', cardAmount: 100 }])).toContain('external terminal before confirming');
        expect(refundCardInstructions([{ method: 'cash', cardAmount: 0 }])).toBe('');
    });
});

describe('allocateRefundPayment', () => {
    it('keeps an on-account refund out of loyalty', () => {
        const allocation = allocateRefundPayment(10_000, [{
            method: 'account',
            amount: 10_000,
            cashAmount: 0,
            cardAmount: 0,
            loyaltyAmount: 0,
            accountAmount: 10_000,
        }]);

        expect(allocation).toEqual({
            method: 'account',
            cashAmount: 0,
            cardAmount: 0,
            loyaltyAmount: 0,
            accountAmount: 10_000,
        });
    });

    it('allocates a mixed refund across every explicit tender', () => {
        const allocation = allocateRefundPayment(5_000, [{
            method: 'split',
            amount: 10_000,
            cashAmount: 2_000,
            cardAmount: 3_000,
            loyaltyAmount: 1_000,
            accountAmount: 4_000,
        }]);

        expect(allocation).toEqual({
            method: 'split',
            cashAmount: 1_000,
            cardAmount: 1_500,
            loyaltyAmount: 500,
            accountAmount: 2_000,
        });
    });

    it('subtracts previous account refunds from the next allocation', () => {
        const allocation = allocateRefundPayment(
            4_000,
            [{
                method: 'account',
                amount: 10_000,
                cashAmount: 0,
                cardAmount: 0,
                loyaltyAmount: 0,
                accountAmount: 10_000,
            }],
            [{
                method: 'account',
                amount: -3_000,
                cashAmount: 0,
                cardAmount: 0,
                loyaltyAmount: 0,
                accountAmount: -3_000,
            }],
        );

        expect(allocation.accountAmount).toBe(4_000);
        expect(allocation.loyaltyAmount).toBe(0);
    });

    it.each([
        ['cash', 'cashAmount'],
        ['card', 'cardAmount'],
        ['loyalty', 'loyaltyAmount'],
        ['account', 'accountAmount'],
        ['pay_later', 'accountAmount'],
        ['customer_account', 'accountAmount'],
    ] as const)('recovers a DB-shaped legacy %s row with zero split columns', (method, component) => {
        const allocation = allocateRefundPayment(2_500, [{
            method,
            amount: 2_500,
            cashAmount: 0,
            cardAmount: 0,
            loyaltyAmount: 0,
            accountAmount: 0,
        }]);

        expect(allocation).toEqual({
            method: component === 'accountAmount' ? 'account' : method,
            cashAmount: component === 'cashAmount' ? 2_500 : 0,
            cardAmount: component === 'cardAmount' ? 2_500 : 0,
            loyaltyAmount: component === 'loyaltyAmount' ? 2_500 : 0,
            accountAmount: component === 'accountAmount' ? 2_500 : 0,
        });
    });

    it('continues to recover legacy cash rows whose split columns are absent', () => {
        const allocation = allocateRefundPayment(2_500, [{
            method: 'cash',
            amount: 2_500,
            cashAmount: 0,
            cardAmount: 0,
        }]);

        expect(allocation.cashAmount).toBe(2_500);
        expect(allocation.loyaltyAmount).toBe(0);
        expect(allocation.accountAmount).toBe(0);
    });
});
