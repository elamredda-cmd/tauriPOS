import { describe, expect, it } from 'vitest';
import { allocateRefundPayment } from './refunds';

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

    it('continues to recover legacy cash rows without split columns', () => {
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
