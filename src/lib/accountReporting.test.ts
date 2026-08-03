import { describe, expect, it } from 'vitest';
import {
    reconciledClosingAccountOwed,
    summarizeAccountActivity,
} from './accountReporting';

describe('customer account reporting', () => {
    it('reports cash, card, and Other collections separately and reconciles the balance', () => {
        const summary = summarizeAccountActivity([
            { entryType: 'opening_balance', amountPence: 1_000, createdAt: '2026-07-27T12:00:00.000Z' },
            { entryType: 'charge', amountPence: 2_000, createdAt: '2026-07-28T09:00:00.000Z' },
            { entryType: 'payment', paymentMethod: 'cash', amountPence: -400, createdAt: '2026-07-28T10:00:00.000Z' },
            { entryType: 'payment', paymentMethod: 'card', amountPence: -500, createdAt: '2026-07-28T11:00:00.000Z' },
            { entryType: 'payment', paymentMethod: 'other', amountPence: -600, createdAt: '2026-07-28T12:00:00.000Z' },
            { entryType: 'reversal', amountPence: 100, createdAt: '2026-07-28T13:00:00.000Z' },
        ], Date.parse('2026-07-28T00:00:00.000Z'), Date.parse('2026-07-29T00:00:00.000Z'));

        expect(summary).toEqual({
            openingAccountOwed: 1_000,
            accountCharges: 2_000,
            accountRepaymentsCash: 400,
            accountRepaymentsCard: 500,
            accountRepaymentsOther: 600,
            accountAdjustments: 100,
            closingAccountOwed: 1_600,
        });
        expect(reconciledClosingAccountOwed(summary)).toBe(summary.closingAccountOwed);
    });

    it('does not silently classify blank or unknown payment methods as Other', () => {
        const summary = summarizeAccountActivity([
            { entryType: 'payment', paymentMethod: '', amountPence: -250, createdAt: '2026-07-28T10:00:00.000Z' },
            { entryType: 'payment', paymentMethod: 'voucher', amountPence: -350, createdAt: '2026-07-28T11:00:00.000Z' },
        ], Date.parse('2026-07-28T00:00:00.000Z'), Date.parse('2026-07-29T00:00:00.000Z'));

        expect(summary.accountRepaymentsCash).toBe(0);
        expect(summary.accountRepaymentsCard).toBe(0);
        expect(summary.accountRepaymentsOther).toBe(0);
        expect(summary.closingAccountOwed).toBe(-600);
    });
});
