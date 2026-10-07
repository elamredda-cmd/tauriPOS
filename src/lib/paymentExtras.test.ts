import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { readPaymentExtraTotalsByTill, reportPaymentExtraTotals, saleCardCollected, accountCardCollected } from './paymentExtras';

describe('separate terminal-extra accounting', () => {
    it('aggregates one time per payment, preserves extras after goods refunds, and scopes tills correctly', async () => {
        const d = new DatabaseSync(':memory:');
        try {
            d.exec(`CREATE TABLE orders (id TEXT, tillNumber TEXT, type TEXT, status TEXT, notes TEXT, completedAt TEXT);
                CREATE TABLE payments (orderId TEXT, tipsAmount INTEGER, serviceChargeAmount INTEGER, cashbackAmount INTEGER);
                CREATE TABLE customer_account_entries (tillNumber TEXT, entryType TEXT, paymentMethod TEXT, amountPence INTEGER, createdAt TEXT, tipsAmount INTEGER, serviceChargeAmount INTEGER, cashbackAmount INTEGER);
                INSERT INTO orders VALUES ('sale', 'till-1', 'sale', 'refunded', '', '2026-09-22T10:00:00Z'),
                    ('return', 'till-1', 'return', 'completed', '', '2026-09-22T11:00:00Z'),
                    ('sale2', 'till-2', 'sale', 'completed', '', '2026-09-22T10:00:00Z');
                INSERT INTO payments VALUES ('sale', 60, 40, 1000), ('return', 0, 0, 0), ('sale2', 100, 0, 0);
                INSERT INTO customer_account_entries VALUES ('till-2', 'payment', 'card', -500, '2026-09-22T10:00:00Z', 50, 0, 500);`);
            const db = { select: async <T>(sql: string, params: any[] = []) => d.prepare(sql).all(...params) as T };
            const map = await readPaymentExtraTotalsByTill(db, '2026-09-22T00:00:00Z', '2026-09-23T00:00:00Z');
            const firstTill = reportPaymentExtraTotals(map, 'till-1');
            expect(firstTill).toEqual({ tipsTotal: 60, serviceChargeTotal: 40, cashbackTotal: 1000,
                accountTipsTotal: 50, accountServiceChargeTotal: 0, accountCashbackTotal: 500 });
            expect(saleCardCollected({ ...firstTill, totalCard: 600 })).toBe(1700);
            expect(accountCardCollected({ ...firstTill, accountRepaymentsCard: 500 })).toBe(1050);
            expect(reportPaymentExtraTotals(map).tipsTotal).toBe(160);
            expect(map.get('till-1')?.accountCashbackTotal).toBe(0);
        } finally { d.close(); }
    });
});
