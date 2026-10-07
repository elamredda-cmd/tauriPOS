import type { DojoPaymentIntentStatus } from './dojo';

export interface DojoPaymentBreakdown {
    baseAmount: number;
    tipsAmount: number;
    serviceChargeAmount: number;
    cashbackAmount: number;
    cardChargedAmount: number;
    currency: string;
}

/** Validate provider money before posting any sale, debt payment or refund. */
export function getDojoPaymentBreakdown(
    payment: DojoPaymentIntentStatus,
    expectedAmount: number,
    expectedCurrency: string,
): DojoPaymentBreakdown {
    const fail = (detail: string): never => {
        throw new Error(`${detail}. The payment needs reconciliation; do not charge the customer again.`);
    };
    if (payment.moneyValidationError) fail(payment.moneyValidationError);
    if (!Number.isSafeInteger(expectedAmount) || expectedAmount <= 0
        || !Number.isSafeInteger(payment.amount) || payment.amount !== expectedAmount) {
        fail('Dojo payment amount does not match the prepared payment');
    }
    const currency = expectedCurrency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency) || payment.currency !== currency) {
        fail('Dojo payment currency does not match the prepared payment');
    }
    const read = (field: 'tipsAmount' | 'serviceChargeAmount' | 'cashbackAmount' | 'totalAmount'): number | null => {
        const money = payment[field];
        if (money === null || money === undefined) return null;
        if (typeof money !== 'object' || !Number.isSafeInteger(money.value) || money.value < 0
            || money.currencyCode !== currency) {
            fail(`Dojo returned invalid ${field}`);
        }
        return money.value;
    };
    const tipsAmount = read('tipsAmount') ?? 0;
    const serviceChargeAmount = read('serviceChargeAmount') ?? 0;
    const cashbackAmount = read('cashbackAmount') ?? 0;
    const cardChargedAmount = expectedAmount + tipsAmount + serviceChargeAmount + cashbackAmount;
    if (!Number.isSafeInteger(cardChargedAmount)) fail('Dojo payment total is outside the supported range');
    const totalAmount = read('totalAmount');
    // Optional totals are allowed for legacy no-extra responses, but extra
    // collections need an authoritative total as well as the separate amounts.
    if ((totalAmount === null && cardChargedAmount !== expectedAmount)
        || (totalAmount !== null && totalAmount !== cardChargedAmount)) {
        fail('Dojo payment total does not match its itemised amounts');
    }
    if (payment.refundedAmount !== null && payment.refundedAmount !== undefined
        && (!Number.isSafeInteger(payment.refundedAmount) || payment.refundedAmount < 0
            || payment.refundedAmount > cardChargedAmount)) {
        fail('Dojo returned an invalid refunded amount');
    }
    return { baseAmount: expectedAmount, tipsAmount, serviceChargeAmount, cashbackAmount, cardChargedAmount, currency };
}

export function getDojoPaymentAmountIssue(
    payment: DojoPaymentIntentStatus,
    expectedAmount: number,
    expectedCurrency: string,
): string | null {
    try {
        getDojoPaymentBreakdown(payment, expectedAmount, expectedCurrency);
        return null;
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}
