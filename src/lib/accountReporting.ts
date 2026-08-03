export interface AccountActivityEntryLike {
    entryType: string;
    amountPence: number;
    paymentMethod?: string;
    createdAt: string;
}

export interface AccountActivitySummary {
    accountCharges: number;
    accountRepaymentsCash: number;
    accountRepaymentsCard: number;
    accountRepaymentsOther: number;
    accountAdjustments: number;
    openingAccountOwed: number;
    closingAccountOwed: number;
}

/**
 * Summarise the append-only customer-account ledger for one reporting period.
 * Collections stay separate from sales tender and from one another so cash-up
 * can include only the method that physically reached each device or drawer.
 */
export function summarizeAccountActivity(
    entries: AccountActivityEntryLike[],
    startTime: number,
    endTime: number,
): AccountActivitySummary {
    const summary: AccountActivitySummary = {
        accountCharges: 0,
        accountRepaymentsCash: 0,
        accountRepaymentsCard: 0,
        accountRepaymentsOther: 0,
        accountAdjustments: 0,
        openingAccountOwed: 0,
        closingAccountOwed: 0,
    };

    for (const entry of entries) {
        const created = new Date(entry.createdAt).getTime();
        const amount = Number(entry.amountPence || 0);
        if (!Number.isFinite(created) || !Number.isFinite(amount)) continue;
        if (created < startTime) summary.openingAccountOwed += amount;
        if (created < endTime) summary.closingAccountOwed += amount;
        if (created < startTime || created >= endTime) continue;

        if (entry.entryType === 'charge') {
            summary.accountCharges += amount;
        } else if (entry.entryType === 'payment' && amount < 0) {
            if (entry.paymentMethod === 'cash') summary.accountRepaymentsCash += -amount;
            else if (entry.paymentMethod === 'card') summary.accountRepaymentsCard += -amount;
            else if (entry.paymentMethod === 'other') summary.accountRepaymentsOther += -amount;
        } else if (entry.entryType !== 'payment') {
            summary.accountAdjustments += amount;
        }
    }

    return summary;
}

export function reconciledClosingAccountOwed(summary: AccountActivitySummary): number {
    return summary.openingAccountOwed
        + summary.accountCharges
        - summary.accountRepaymentsCash
        - summary.accountRepaymentsCard
        - summary.accountRepaymentsOther
        + summary.accountAdjustments;
}
