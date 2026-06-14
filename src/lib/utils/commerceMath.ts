export interface TaxLineInput {
    quantity: number;
    unitPrice: number;
    discountAmount: number;
    taxRate: number;
    taxIncludedInPrice: boolean;
}

export interface TaxLineResult {
    netBeforeTax: number;
    taxAmount: number;
    lineTotal: number;
}

/** Calculate tax in integer pence so receipts and reports always reconcile. */
export function calculateTaxLine(input: TaxLineInput): TaxLineResult {
    const discounted = Math.max(0, input.unitPrice * input.quantity - input.discountAmount);
    if (input.taxRate <= 0) {
        return { netBeforeTax: discounted, taxAmount: 0, lineTotal: discounted };
    }

    if (input.taxIncludedInPrice) {
        const taxAmount = Math.round(discounted * input.taxRate / (1 + input.taxRate));
        return {
            netBeforeTax: discounted - taxAmount,
            taxAmount,
            lineTotal: discounted,
        };
    }

    const taxAmount = Math.round(discounted * input.taxRate);
    return {
        netBeforeTax: discounted,
        taxAmount,
        lineTotal: discounted + taxAmount,
    };
}

export function calculateCartTotals(lines: TaxLineResult[]) {
    return lines.reduce(
        (totals, line) => ({
            taxTotal: totals.taxTotal + line.taxAmount,
            total: totals.total + line.lineTotal,
        }),
        { taxTotal: 0, total: 0 },
    );
}
