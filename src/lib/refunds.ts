export interface RefundAllocation {
    lineTotal: number;
    discountAmount: number;
    taxAmount: number;
}

function allocateProportionally(total: number, weights: number[]): number[] {
    if (total <= 0 || weights.length === 0) return weights.map(() => 0);
    const positiveWeights = weights.map((weight) => Math.max(0, weight));
    const weightTotal = positiveWeights.reduce((sum, weight) => sum + weight, 0);
    if (weightTotal <= 0) {
        return positiveWeights.map((_, index) => index === 0 ? total : 0);
    }

    const exact = positiveWeights.map((weight) => total * weight / weightTotal);
    const allocated = exact.map(Math.floor);
    let remaining = total - allocated.reduce((sum, amount) => sum + amount, 0);
    const priority = exact
        .map((amount, index) => ({ index, remainder: amount - allocated[index] }))
        .sort((a, b) => b.remainder - a.remainder || a.index - b.index);

    for (let i = 0; i < remaining; i++) {
        allocated[priority[i % priority.length].index]++;
    }
    return allocated;
}

export function allocateRefundLines(
    refundAmount: number,
    targetDiscount: number,
    targetTax: number,
    lines: Array<{ lineTotal: number; discountAmount: number; taxAmount: number }>,
): RefundAllocation[] {
    const lineTotals = allocateProportionally(refundAmount, lines.map((line) => line.lineTotal));
    const discounts = allocateProportionally(targetDiscount, lines.map((line) => line.discountAmount));
    const taxes = allocateProportionally(targetTax, lines.map((line) => line.taxAmount));
    return lines.map((_, index) => ({
        lineTotal: lineTotals[index],
        discountAmount: discounts[index],
        taxAmount: taxes[index],
    }));
}

export function getRemainingRefundAmount(
    originalTotal: number,
    reversals: Array<{ total: number }>,
): number {
    const refunded = reversals.reduce((sum, reversal) => sum + Math.abs(Math.min(0, reversal.total)), 0);
    return Math.max(0, originalTotal - refunded);
}

export function allocateRefundPayment(
    refundAmount: number,
    payments: Array<{ method?: string; amount: number; cashAmount: number; cardAmount: number }>,
    previousReversalPayments: Array<{ method?: string; amount: number; cashAmount: number; cardAmount: number }> = [],
) {
    const paymentParts = (payment: { method?: string; amount: number; cashAmount: number; cardAmount: number }) => {
        const amount = Math.abs(payment.amount || 0);
        let cashAmount = Math.abs(payment.cashAmount || 0);
        let cardAmount = Math.abs(payment.cardAmount || 0);
        // Older receipts can predate the split columns. Recover their component
        // from the recorded payment method instead of treating it as loyalty.
        if (cashAmount === 0 && cardAmount === 0) {
            if (payment.method === 'cash') cashAmount = amount;
            if (payment.method === 'card') cardAmount = amount;
        }
        return {
            amount,
            cashAmount,
            cardAmount,
            loyaltyAmount: Math.max(0, amount - cashAmount - cardAmount),
        };
    };
    const originalParts = payments.map(paymentParts);
    const previousParts = previousReversalPayments.map(paymentParts);
    const cash = originalParts.reduce((sum, payment) => sum + payment.cashAmount, 0);
    const card = originalParts.reduce((sum, payment) => sum + payment.cardAmount, 0);
    const loyalty = originalParts.reduce((sum, payment) => sum + payment.loyaltyAmount, 0);
    const previouslyRefunded = previousParts.reduce((sum, payment) => sum + payment.amount, 0);
    const [targetCash, targetCard, targetLoyalty] = allocateProportionally(
        refundAmount + previouslyRefunded,
        [cash, card, loyalty],
    );
    const cashAmount = Math.max(0, targetCash - previousParts.reduce((sum, payment) => sum + payment.cashAmount, 0));
    const cardAmount = Math.max(0, targetCard - previousParts.reduce((sum, payment) => sum + payment.cardAmount, 0));
    const loyaltyAmount = Math.max(0, targetLoyalty - previousParts.reduce((sum, payment) => sum + payment.loyaltyAmount, 0));
    const method = cashAmount > 0 && cardAmount > 0
        ? 'split'
        : cashAmount > 0
            ? 'cash'
            : cardAmount > 0
                ? 'card'
                : 'loyalty';
    return { method, cashAmount, cardAmount, loyaltyAmount };
}
