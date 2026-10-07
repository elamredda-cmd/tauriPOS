import { describe, expect, it } from 'vitest';
import { accountPaymentAmountLines, cashbackRecoveryMessage, paymentExtraReportRows } from './paymentExtraPresentation';

describe('separate extras presentation for reports and account receipts', () => {
    it('does not mix shop account extras into sales collection totals', () => {
        const totals = {
            totalCard: 10_000, tipsTotal: 100, serviceChargeTotal: 200, cashbackTotal: 500,
            accountRepaymentsCard: 2_000, accountTipsTotal: 50, accountServiceChargeTotal: 75, accountCashbackTotal: 100,
        };
        expect(paymentExtraReportRows(totals)).toEqual([
            ['Tips', 100], ['Service charge', 200], ['Cashback paid out', 500], ['Total card charged', 10_800],
        ]);
        expect(paymentExtraReportRows(totals, true)).toEqual([
            ['Tips', 50], ['Service charge', 75], ['Cashback paid out', 100], ['Total card charged', 2_225],
        ]);
        expect(totals.totalCard).toBe(10_000);
        expect(totals.accountRepaymentsCard).toBe(2_000);
    });

    it('supports till summaries and older saved reports without extras', () => {
        expect(paymentExtraReportRows({ cardTotal: 450 })).toEqual([
            ['Tips', 0], ['Service charge', 0], ['Cashback paid out', 0], ['Total card charged', 450],
        ]);
    });

    it('prints the debt reduction independently from the full card collection and cashback payout', () => {
        const money = (pence: number) => `£${(pence / 100).toFixed(2)}`;
        expect(accountPaymentAmountLines({
            amountPence: -1_250, paymentMethod: 'card', tipsAmount: 100, serviceChargeAmount: 50, cashbackAmount: 500,
        }, money)).toEqual([
            'Account balance reduced: £12.50', 'Tips: £1.00', 'Service charge: £0.50', 'Cashback: £5.00',
            'Total card charged: £19.00', 'GIVE CASHBACK: £5.00', 'Cashback is not cash change.',
        ]);
    });

    it('does not label a cash debt repayment as a card collection', () => {
        expect(accountPaymentAmountLines({ amountPence: -1_250, paymentMethod: 'cash' }, String))
            .toEqual(['Account balance reduced: 1250']);
    });

    it('requires a payout check after recovery instead of instructing a second payout', () => {
        expect(cashbackRecoveryMessage({ attemptId: 'order-1', amount: 500, currency: 'GBP' }))
            .toBe('Recovered payment order-1: cashback £5.00 was recorded. Check whether it was already handed over before paying it out. Do not give cashback twice.');
    });
});
