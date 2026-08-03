import { describe, expect, it } from 'vitest';
import {
    paymentAllocationLabels,
    receiptTenderBreakdown,
    receiptTenderRows,
} from './receiptPayments';

const sale = {
    type: 'sale' as const,
    total: 1_000,
    paymentMethod: 'account+loyalty',
    amountTendered: 1_000,
};

describe('receipt payment disclosure', () => {
    it('shows the exact loyalty and Pay Later parts of a mixed receipt', () => {
        const payment = {
            method: 'account' as const,
            amount: 1_000,
            cashAmount: 0,
            cardAmount: 0,
            loyaltyAmount: 200,
            accountAmount: 800,
        };
        const rows = receiptTenderRows(sale, [payment]);
        expect(rows).toEqual([
            { label: 'LOYALTY', amount: 200 },
            { label: 'PAY LATER', amount: 800 },
        ]);
        expect(paymentAllocationLabels([payment])).toEqual(['Loyalty', 'Pay Later']);
    });

    it('shows the cash handed over while keeping change as a separate receipt row', () => {
        const rows = receiptTenderRows({
            ...sale,
            total: 1_000,
            paymentMethod: 'cash',
            amountTendered: 1_200,
        }, [{
            method: 'cash',
            amount: 1_000,
            cashAmount: 1_000,
            cardAmount: 0,
            loyaltyAmount: 0,
            accountAmount: 0,
            changeGiven: 200,
        }]);

        expect(rows).toEqual([{ label: 'CASH', amount: 1_200 }]);
    });

    it('recovers all-zero legacy allocation columns from the method', () => {
        expect(receiptTenderBreakdown([{
            method: 'card',
            amount: 1_000,
            cashAmount: 0,
            cardAmount: 0,
            loyaltyAmount: 0,
            accountAmount: 0,
        }])).toEqual({ cash: 0, card: 1_000, loyalty: 0, account: 0, other: 0 });
    });

    it('labels mixed refund components separately', () => {
        const rows = receiptTenderRows({ ...sale, type: 'return', total: -1_000 }, [{
            method: 'split',
            amount: -1_000,
            cashAmount: -300,
            cardAmount: 0,
            loyaltyAmount: -200,
            accountAmount: -500,
        }]);
        expect(rows).toEqual([
            { label: 'CASH REFUND', amount: -300 },
            { label: 'LOYALTY CREDIT', amount: -200 },
            { label: 'ACCOUNT CREDIT', amount: -500 },
        ]);
    });
});
