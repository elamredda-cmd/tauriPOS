/** Extra card collections, deliberately excluded from product revenue/debt. */
export interface PaymentExtras {
    tipsAmount?: number;
    serviceChargeAmount?: number;
    cashbackAmount?: number;
}

export interface PaymentExtraTotals {
    tipsTotal?: number;
    serviceChargeTotal?: number;
    cashbackTotal?: number;
    accountTipsTotal?: number;
    accountServiceChargeTotal?: number;
    accountCashbackTotal?: number;
}

export function sumPaymentExtras(sales: PaymentExtras[], accounts: PaymentExtras[] = []): Required<PaymentExtraTotals> {
    const sum = (rows: PaymentExtras[], field: keyof PaymentExtras) => rows.reduce((total, row) => total + Number(row[field] || 0), 0);
    return {
        tipsTotal: sum(sales, 'tipsAmount'), serviceChargeTotal: sum(sales, 'serviceChargeAmount'), cashbackTotal: sum(sales, 'cashbackAmount'),
        accountTipsTotal: sum(accounts, 'tipsAmount'), accountServiceChargeTotal: sum(accounts, 'serviceChargeAmount'), accountCashbackTotal: sum(accounts, 'cashbackAmount'),
    };
}

/** One grouped read for both database engines, avoiding a query per till. */
export async function readPaymentExtraTotalsByTill(
    db: { select<T>(sql: string, params?: any[]): Promise<T> }, start: string, end: string,
): Promise<Map<string, Required<PaymentExtraTotals>>> {
    const rows = await db.select<any[]>(`SELECT tillNumber, kind,
        CAST(SUM(tipsAmount) AS SIGNED) AS tipsAmount,
        CAST(SUM(serviceChargeAmount) AS SIGNED) AS serviceChargeAmount,
        CAST(SUM(cashbackAmount) AS SIGNED) AS cashbackAmount
        FROM (
            SELECT COALESCE(o.tillNumber, '') AS tillNumber, 'sale' AS kind,
                COALESCE(p.tipsAmount, 0) AS tipsAmount, COALESCE(p.serviceChargeAmount, 0) AS serviceChargeAmount, COALESCE(p.cashbackAmount, 0) AS cashbackAmount
            FROM payments p JOIN orders o ON o.id = p.orderId
            WHERE o.status IN ('completed', 'refunded', 'partially_refunded')
                AND NOT (o.type = 'return' AND COALESCE(o.notes, '') LIKE 'Void of receipt %')
                AND o.completedAt >= ? AND o.completedAt < ?
            UNION ALL
            SELECT COALESCE(tillNumber, ''), 'account', COALESCE(tipsAmount, 0), COALESCE(serviceChargeAmount, 0), COALESCE(cashbackAmount, 0)
            FROM customer_account_entries WHERE entryType = 'payment' AND paymentMethod = 'card' AND amountPence < 0
                AND createdAt >= ? AND createdAt < ?
        ) extraCollections GROUP BY tillNumber, kind`, [start, end, start, end]);
    const totals = new Map<string, Required<PaymentExtraTotals>>();
    for (const row of rows || []) {
        const id = String(row.tillNumber || '');
        const value = totals.get(id) || sumPaymentExtras([]);
        const part = row.kind === 'account' ? sumPaymentExtras([], [row]) : sumPaymentExtras([row]);
        for (const key of Object.keys(value) as Array<keyof PaymentExtraTotals>) value[key] += part[key];
        totals.set(id, value);
    }
    return totals;
}

/** Account totals intentionally keep the existing shop-wide report scope. */
export function reportPaymentExtraTotals(byTill: Map<string, Required<PaymentExtraTotals>>, till?: string): Required<PaymentExtraTotals> {
    const result = sumPaymentExtras([]);
    for (const [id, part] of byTill) {
        if (!till || id === till) {
            result.tipsTotal += part.tipsTotal;
            result.serviceChargeTotal += part.serviceChargeTotal;
            result.cashbackTotal += part.cashbackTotal;
        }
        result.accountTipsTotal += part.accountTipsTotal;
        result.accountServiceChargeTotal += part.accountServiceChargeTotal;
        result.accountCashbackTotal += part.accountCashbackTotal;
    }
    return result;
}

export function saleCardCollected(totals: PaymentExtraTotals & { totalCard?: number; cardTotal?: number }): number {
    return Number(totals.totalCard ?? totals.cardTotal ?? 0) + Number(totals.tipsTotal || 0)
        + Number(totals.serviceChargeTotal || 0) + Number(totals.cashbackTotal || 0);
}

export function accountCardCollected(totals: PaymentExtraTotals & { accountRepaymentsCard?: number }): number {
    return Number(totals.accountRepaymentsCard || 0) + Number(totals.accountTipsTotal || 0)
        + Number(totals.accountServiceChargeTotal || 0) + Number(totals.accountCashbackTotal || 0);
}
