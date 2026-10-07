import { describe, expect, it } from 'vitest';
import { getLastReportMarker, getTillPeriodReport, saveReportMarker } from './database';
import { ordersDB, orderLinesDB, paymentsDB, customerAccountEntriesDB, type Order } from './db';

const origin = '2000-01-01T00:00:00.000Z';
const day = (date: number, hour = 12) => `2026-09-${date}T${hour}:00:00.000Z`;

function sale(id: string, tillNumber: string, total: number, completedAt: string): Order {
    return {
        id, tillNumber, total, completedAt, createdAt: completedAt, updatedAt: completedAt,
        shiftId: '', customerId: '', employeeId: '', orderNumber: 1, receiptKey: id,
        type: 'sale', status: 'completed', originalOrderId: '', subtotal: total,
        discountId: '', discountAmount: 0, taxTotal: 0, notes: '',
        paymentMethod: 'cash', amountTendered: total,
    };
}

describe('whole-system and individual till reporting periods', () => {
    it('does not repeat pre-system sales in a later till Z or lose till-closed sales from the shop Z', async () => {
        orderLinesDB.set([]);
        paymentsDB.set([]);
        customerAccountEntriesDB.set([]);
        ordersDB.set([
            sale('before-a', 'period-test-a', 1_000, day(20)),
            sale('before-b', 'period-test-b', 2_000, day(20)),
            sale('after-a', 'period-test-a', 400, day(22)),
            sale('after-b', 'period-test-b', 300, day(22)),
            // A transaction exactly at a cutoff belongs to the next period.
            sale('cutoff-a', 'period-test-a', 500, day(23)),
        ]);
        const systemClose = await saveReportMarker('', origin, day(21), { reportTotal: 3_000 });
        const tillStart = await getLastReportMarker('period-test-a');
        expect(tillStart).toBe(day(21));
        const tillX = await getTillPeriodReport('period-test-a', tillStart!, day(23));
        expect(tillX.overview.totalRevenue).toBe(400);
        // Preview/X reads do not advance any reporting scope.
        expect(await getLastReportMarker('period-test-a')).toBe(day(21));
        await saveReportMarker('period-test-a', tillStart!, day(23), { reportTotal: 400 });
        expect(await getLastReportMarker('period-test-a')).toBe(day(23));
        expect(await getLastReportMarker('period-test-b')).toBe(day(21));
        expect(await getLastReportMarker('')).toBe(day(21));
        const whole = await getTillPeriodReport('', (await getLastReportMarker(''))!, day(24));
        expect(whole.overview.totalRevenue).toBe(1_200);
        expect(systemClose.reportTotal).toBe(3_000);
        expect(systemClose.markerTime).toBe(day(21));
        const nextTill = await getTillPeriodReport('period-test-a', (await getLastReportMarker('period-test-a'))!, day(24));
        expect(nextTill.overview.totalRevenue).toBe(500);
        await expect(saveReportMarker('period-test-a', tillStart!, day(24)))
            .rejects.toThrow('REPORT_PERIOD_CHANGED');
        expect(await getLastReportMarker('period-test-a')).toBe(day(23));
    });
});
