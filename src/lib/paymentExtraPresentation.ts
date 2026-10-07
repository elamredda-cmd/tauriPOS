import { accountCardCollected, saleCardCollected, type PaymentExtras, type PaymentExtraTotals } from './paymentExtras';

type CollectionTotals = PaymentExtraTotals & {
    totalCard?: number;
    cardTotal?: number;
    accountRepaymentsCard?: number;
};

/** Shared rows keep reports, saved close text and CSV accounting labels aligned. */
export function paymentExtraReportRows(totals: CollectionTotals, account = false): Array<[string, number]> {
    return [
        ['Tips', Number((account ? totals.accountTipsTotal : totals.tipsTotal) || 0)],
        ['Service charge', Number((account ? totals.accountServiceChargeTotal : totals.serviceChargeTotal) || 0)],
        ['Cashback paid out', Number((account ? totals.accountCashbackTotal : totals.cashbackTotal) || 0)],
        ['Total card charged', account ? accountCardCollected(totals) : saleCardCollected(totals)],
    ];
}

export function accountPaymentAmountLines(
    entry: PaymentExtras & { amountPence: number; paymentMethod: string },
    money: (amount: number) => string,
): string[] {
    const base = Math.abs(entry.amountPence);
    const lines = [`Account balance reduced: ${money(base)}`];
    if (entry.paymentMethod !== 'card') return lines;
    const tips = Number(entry.tipsAmount || 0);
    const service = Number(entry.serviceChargeAmount || 0);
    const cashback = Number(entry.cashbackAmount || 0);
    if (tips) lines.push(`Tips: ${money(tips)}`);
    if (service) lines.push(`Service charge: ${money(service)}`);
    if (cashback) lines.push(`Cashback: ${money(cashback)}`);
    lines.push(`Total card charged: ${money(base + tips + service + cashback)}`);
    if (cashback) lines.push(`GIVE CASHBACK: ${money(cashback)}`, 'Cashback is not cash change.');
    return lines;
}

export function cashbackRecoveryMessage(entry: { attemptId: string; amount: number; currency: string }): string {
    const amount = new Intl.NumberFormat('en-GB', { style: 'currency', currency: entry.currency }).format(entry.amount / 100);
    return `Recovered payment ${entry.attemptId}: cashback ${amount} was recorded. Check whether it was already handed over before paying it out. Do not give cashback twice.`;
}
