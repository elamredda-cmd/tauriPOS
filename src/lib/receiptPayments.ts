import type { Order, Payment } from '$lib/stores/db';

export type ReceiptPayment = Pick<
    Payment,
    'method' | 'amount' | 'cashAmount' | 'cardAmount' | 'loyaltyAmount' | 'accountAmount' | 'changeGiven'
>;

export interface ReceiptTenderBreakdown {
    cash: number;
    card: number;
    loyalty: number;
    account: number;
    other: number;
}

export interface ReceiptTenderRow {
    label: string;
    amount: number;
}

function normalizedMethod(value: unknown): string {
    return String(value || '').trim().toLowerCase().replace(/[ -]+/g, '_');
}

function paymentBreakdown(payment: Partial<ReceiptPayment>): ReceiptTenderBreakdown {
    const amount = Number(payment.amount || 0);
    let cash = Number(payment.cashAmount || 0);
    let card = Number(payment.cardAmount || 0);
    let loyalty = Number(payment.loyaltyAmount || 0);
    let account = Number(payment.accountAmount || 0);
    let other = 0;
    const method = normalizedMethod(payment.method);

    // Upgraded legacy rows contain all four allocation columns as zero. In
    // that shape, recover the tender from the original method.
    if (cash === 0 && card === 0 && loyalty === 0 && account === 0) {
        if (method === 'cash') cash = amount;
        else if (['card', 'sumup', 'dojo', 'mobile'].includes(method)) card = amount;
        else if (['account', 'pay_later', 'customer_account'].includes(method)) account = amount;
        else if (['loyalty', 'store_credit', 'gift_card'].includes(method)) loyalty = amount;
        else other = amount;
    } else {
        // Keep the receipt reconcilable if an older split row only populated
        // some allocation columns.
        other = amount - cash - card - loyalty - account;
    }
    return { cash, card, loyalty, account, other };
}

export function receiptTenderBreakdown(payments: Array<Partial<ReceiptPayment>> = []): ReceiptTenderBreakdown {
    return payments.reduce<ReceiptTenderBreakdown>((sum, payment) => {
        const part = paymentBreakdown(payment);
        return {
            cash: sum.cash + part.cash,
            card: sum.card + part.card,
            loyalty: sum.loyalty + part.loyalty,
            account: sum.account + part.account,
            other: sum.other + part.other,
        };
    }, { cash: 0, card: 0, loyalty: 0, account: 0, other: 0 });
}

export function paymentAllocationLabels(
    payments: Array<Partial<ReceiptPayment>> = [],
): string[] {
    const breakdown = receiptTenderBreakdown(payments);
    return [
        { label: 'Cash', amount: breakdown.cash },
        { label: 'Card', amount: breakdown.card },
        { label: 'Loyalty', amount: breakdown.loyalty },
        { label: 'Pay Later', amount: breakdown.account },
        { label: 'Other', amount: breakdown.other },
    ].filter((part) => part.amount !== 0).map((part) => part.label);
}

export function receiptTenderRows(
    order: Pick<Order, 'type' | 'total' | 'paymentMethod' | 'amountTendered'>,
    payments: Array<Partial<ReceiptPayment>> = [],
): ReceiptTenderRow[] {
    if (payments.length === 0) {
        return [{
            label: String(order.paymentMethod || 'cash').toUpperCase(),
            amount: Number(order.amountTendered || order.total || 0),
        }];
    }
    const refund = order.type === 'return';
    const breakdown = receiptTenderBreakdown(payments);
    const cashTendered = refund
        ? breakdown.cash
        : payments.reduce((total, payment) => {
            const cashAllocation = paymentBreakdown(payment).cash;
            const change = cashAllocation > 0 ? Math.max(0, Number(payment.changeGiven || 0)) : 0;
            return total + cashAllocation + change;
        }, 0);
    return [
        { label: refund ? 'CASH REFUND' : 'CASH', amount: cashTendered },
        { label: refund ? 'CARD REFUND' : 'CARD', amount: breakdown.card },
        { label: refund ? 'LOYALTY CREDIT' : 'LOYALTY', amount: breakdown.loyalty },
        { label: refund ? 'ACCOUNT CREDIT' : 'PAY LATER', amount: breakdown.account },
        { label: refund ? 'OTHER REFUND' : 'OTHER', amount: breakdown.other },
    ].filter((row) => row.amount !== 0);
}
