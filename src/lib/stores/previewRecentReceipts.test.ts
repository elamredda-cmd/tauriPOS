import { describe, expect, it } from 'vitest';

import {
    buildPreviewOrderDetails,
    buildPreviewRecentReceipts,
    findLatestPreviewTillReceipt,
} from './previewRecentReceipts';

describe('browser preview recent receipts', () => {
    it('returns completed preview sales with every explicit payment allocation intact', () => {
        const newest = {
            id: 'order-pay-later',
            status: 'completed',
            orderNumber: 12,
            employeeId: 'employee-1',
            tillNumber: 'till-1',
            customerId: 'customer-1',
            total: 250,
            paymentMethod: 'account',
            completedAt: '2026-07-29T12:00:00.000Z',
            createdAt: '2026-07-29T11:59:00.000Z',
            updatedAt: '2026-07-29T12:00:00.000Z',
        };
        const older = {
            ...newest,
            id: 'order-split',
            orderNumber: 11,
            total: 600,
            paymentMethod: 'split',
            completedAt: '2026-07-29T10:00:00.000Z',
        };
        const held = {
            ...newest,
            id: 'order-held',
            orderNumber: 13,
            status: 'hold',
            completedAt: '',
        };
        const accountPayment = {
            id: 'payment-account',
            orderId: newest.id,
            method: 'account',
            amount: 250,
            cashAmount: 0,
            cardAmount: 0,
            loyaltyAmount: 0,
            accountAmount: 250,
            reference: '',
            changeGiven: 0,
            createdAt: newest.completedAt,
        };
        const splitPayment = {
            id: 'payment-split',
            orderId: older.id,
            method: 'split',
            amount: 600,
            cashAmount: 100,
            cardAmount: 200,
            loyaltyAmount: 100,
            accountAmount: 200,
            reference: 'mixed-tender',
            changeGiven: 0,
            createdAt: older.completedAt,
        };

        const result = buildPreviewRecentReceipts({
            orders: [older, held, newest],
            lines: [
                { id: 'line-held', orderId: held.id, productName: 'Hidden item', updatedAt: held.createdAt },
                { id: 'line-newest', orderId: newest.id, productName: 'Cola', updatedAt: newest.completedAt },
                { id: 'line-older', orderId: older.id, productName: 'Snacks', updatedAt: older.completedAt },
            ],
            payments: [
                splitPayment,
                { ...accountPayment, id: 'payment-held', orderId: held.id },
                accountPayment,
            ],
            employees: [{ id: 'employee-1', name: 'Preview Cashier' }],
            registers: [{ id: 'till-1', name: 'Browser Preview' }],
            customers: [{ id: 'customer-1', name: 'Preview Customer' }],
        }, 10);

        expect(result.orders.map((order) => order.id)).toEqual([newest.id, older.id]);
        expect(result.orders[0]).toMatchObject({
            cashierName: 'Preview Cashier',
            tillName: 'Browser Preview',
            customerName: 'Preview Customer',
        });
        expect(result.lines.map((line) => line.id)).toEqual(['line-newest', 'line-older']);
        expect(result.payments).toEqual([accountPayment, splitPayment]);
        expect(result.payments[0]).toMatchObject({
            cashAmount: 0,
            cardAmount: 0,
            loyaltyAmount: 0,
            accountAmount: 250,
        });
        expect(result.payments[1]).toMatchObject({
            cashAmount: 100,
            cardAmount: 200,
            loyaltyAmount: 100,
            accountAmount: 200,
        });
    });

    it('uses receipt timestamp and order number ordering, clamps the limit, and leaves inputs unchanged', () => {
        const orders = [
            { id: 'order-1', status: 'completed', orderNumber: 1, createdAt: '2026-07-29T08:00:00.000Z' },
            { id: 'order-3', status: 'completed', orderNumber: 3, createdAt: '2026-07-29T09:00:00.000Z' },
            { id: 'order-2', status: 'refunded', orderNumber: 2, createdAt: '2026-07-29T09:00:00.000Z' },
        ];
        const originalOrderIds = orders.map((order) => order.id);

        const result = buildPreviewRecentReceipts({
            orders,
            lines: [],
            payments: [],
        }, 2);

        expect(result.orders.map((order) => order.id)).toEqual(['order-3', 'order-2']);
        expect(orders.map((order) => order.id)).toEqual(originalOrderIds);
        expect(buildPreviewRecentReceipts({ orders, lines: [], payments: [] }, -5).orders)
            .toHaveLength(1);
        expect(buildPreviewRecentReceipts({ orders, lines: [], payments: [] }, Number.NaN).orders)
            .toHaveLength(3);
    });

    it('selects the newest printable receipt for the requested preview till', () => {
        const orders = [
            {
                id: 'till-one-newest',
                status: 'completed',
                orderNumber: 3,
                tillNumber: 'till-1',
                completedAt: '2026-07-29T12:00:00.000Z',
            },
            {
                id: 'till-two-newest',
                status: 'completed',
                orderNumber: 4,
                tillNumber: 'till-2',
                completedAt: '2026-07-29T13:00:00.000Z',
            },
            {
                id: 'till-one-held',
                status: 'hold',
                orderNumber: 5,
                tillNumber: 'till-1',
                completedAt: '2026-07-29T14:00:00.000Z',
            },
            {
                id: 'till-one-older',
                status: 'completed',
                orderNumber: 2,
                tillNumber: 'till-1',
                completedAt: '2026-07-29T11:00:00.000Z',
            },
        ];

        expect(findLatestPreviewTillReceipt({ orders, lines: [], payments: [] }, 'till-1')?.id)
            .toBe('till-one-newest');
        expect(findLatestPreviewTillReceipt({ orders, lines: [], payments: [] }, 'missing'))
            .toBeNull();
        expect(findLatestPreviewTillReceipt({ orders, lines: [], payments: [] }, ''))
            .toBeNull();
    });

    it('returns exact preview reprint details without collapsing Pay Later allocation', () => {
        const order = {
            id: 'order-pay-later',
            status: 'completed',
            orderNumber: 22,
            tillNumber: 'till-1',
            employeeId: 'employee-1',
            customerId: 'customer-1',
            completedAt: '2026-07-29T15:00:00.000Z',
        };
        const line = {
            id: 'line-1',
            orderId: order.id,
            productName: 'Cola',
            updatedAt: order.completedAt,
        };
        const payment = {
            id: 'payment-1',
            orderId: order.id,
            method: 'account',
            amount: 250,
            cashAmount: 0,
            cardAmount: 0,
            loyaltyAmount: 0,
            accountAmount: 250,
            createdAt: order.completedAt,
        };

        const result = buildPreviewOrderDetails({
            orders: [order],
            lines: [line],
            payments: [payment],
            employees: [{ id: 'employee-1', name: 'Preview Cashier' }],
            registers: [{ id: 'till-1', name: 'Browser Preview' }],
            customers: [{ id: 'customer-1', name: 'Preview Customer' }],
        }, order.id);

        expect(result.order).toMatchObject({
            id: order.id,
            cashierName: 'Preview Cashier',
            tillName: 'Browser Preview',
            customerName: 'Preview Customer',
        });
        expect(result.lines).toEqual([line]);
        expect(result.payments).toEqual([payment]);
        expect(result.payments[0].accountAmount).toBe(250);
        expect(buildPreviewOrderDetails({ orders: [order], lines: [line], payments: [payment] }, 'missing'))
            .toEqual({ order: null, lines: [], payments: [] });
    });
});
