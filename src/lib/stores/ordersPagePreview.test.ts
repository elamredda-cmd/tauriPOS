import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';

import { getOrdersPage } from './database';
import {
    customersDB,
    employeesDB,
    orderLinesDB,
    ordersDB,
    paymentsDB,
    registersDB,
    type Customer,
    type Employee,
    type Order,
    type OrderLine,
    type Payment,
    type Register,
} from './db';

type PreviewStoreSnapshot = {
    customers: Customer[];
    employees: Employee[];
    lines: OrderLine[];
    orders: Order[];
    payments: Payment[];
    registers: Register[];
};

const employee = (id: string, name: string): Employee => ({
    id,
    storeId: 'store-preview',
    name,
    pin: '',
    role: 'cashier',
    email: '',
    isActive: true,
    createdAt: '2026-09-01T08:00:00.000Z',
});

const order = ({ id, orderNumber, ...patch }: Partial<Order> & Pick<Order, 'id' | 'orderNumber'>): Order => ({
    id,
    shiftId: 'shift-preview',
    customerId: '',
    employeeId: 'employee-alex',
    orderNumber,
    receiptKey: `PREVIEW-${orderNumber}`,
    type: 'sale',
    status: 'completed',
    originalOrderId: '',
    subtotal: 1_000,
    discountId: '',
    discountAmount: 0,
    taxTotal: 0,
    total: 1_000,
    tillNumber: 'register-front',
    notes: '',
    paymentMethod: 'card',
    amountTendered: 1_000,
    createdAt: '2026-09-04T09:00:00.000Z',
    completedAt: '2026-09-04T09:00:00.000Z',
    updatedAt: '2026-09-04T09:00:00.000Z',
    ...patch,
});

const line = (id: string, orderId: string, productName: string, notes = ''): OrderLine => ({
    id,
    orderId,
    productId: `product-${id}`,
    productName,
    quantity: 1,
    unitPrice: 1_000,
    costPrice: 400,
    discountId: '',
    discountAmount: 0,
    taxRate: 0,
    taxAmount: 0,
    lineTotal: 1_000,
    isPriceOverride: false,
    originalPrice: 1_000,
    notes,
    updatedAt: '2026-09-04T09:00:00.000Z',
});

const payment = (id: string, orderId: string, reference: string): Payment => ({
    id,
    orderId,
    method: 'card',
    amount: 1_000,
    cashAmount: 0,
    cardAmount: 1_000,
    loyaltyAmount: 0,
    accountAmount: 0,
    reference,
    changeGiven: 0,
    createdAt: '2026-09-04T09:00:00.000Z',
    updatedAt: '2026-09-04T09:00:00.000Z',
});

function seedPreviewOrders(): void {
    employeesDB.set([
        employee('employee-alex', 'Alex Preview'),
        employee('employee-beth', 'Beth Returns'),
    ]);
    registersDB.set([{
        id: 'register-front',
        storeId: 'store-preview',
        name: 'Front Counter',
        isActive: true,
        createdAt: '2026-09-01T08:00:00.000Z',
    }]);
    customersDB.set([{
        id: 'customer-alice',
        name: 'Alice Cooper',
        phone: '',
        email: '',
        postcode: '',
        loyaltyCode: '',
        loyaltyPoints: 0,
        notes: '',
        createdAt: '2026-09-01T08:00:00.000Z',
        updatedAt: '2026-09-01T08:00:00.000Z',
    }]);

    ordersDB.set([
        order({
            id: 'order-void-sale',
            orderNumber: 99,
            status: 'voided',
            createdAt: '2026-09-04T09:00:00.000Z',
            completedAt: '2026-09-04T09:00:00.000Z',
        }),
        order({
            id: 'order-sale',
            orderNumber: 104,
            customerId: 'customer-alice',
            createdAt: '2026-09-04T13:00:00.000Z',
            completedAt: '2026-09-04T13:00:00.000Z',
        }),
        order({
            id: 'order-hold',
            orderNumber: 105,
            status: 'hold',
            employeeId: 'employee-beth',
            createdAt: '2026-09-04T14:00:00.000Z',
            completedAt: '',
            updatedAt: '2026-09-04T14:00:00.000Z',
        }),
        order({
            id: 'order-return',
            orderNumber: 103,
            type: 'return',
            employeeId: 'employee-beth',
            tillNumber: 'browser-preview-till',
            createdAt: '2026-09-04T12:00:00.000Z',
            completedAt: '2026-09-04T12:00:00.000Z',
        }),
        order({
            id: 'order-refunded',
            orderNumber: 102,
            status: 'refunded',
            createdAt: '2026-09-04T11:00:00.000Z',
            completedAt: '2026-09-04T11:00:00.000Z',
        }),
        order({
            id: 'order-void-return',
            orderNumber: 101,
            type: 'return',
            notes: 'Void of receipt PREVIEW-100',
            createdAt: '2026-09-04T10:00:00.000Z',
            completedAt: '2026-09-04T10:00:00.000Z',
        }),
    ]);

    orderLinesDB.set([
        line('line-sale', 'order-sale', 'Organic Almond Milk', 'Keep refrigerated'),
        line('line-return', 'order-return', 'Returned coffee'),
        line('line-hold', 'order-hold', 'Held basket'),
        line('line-refunded', 'order-refunded', 'Refunded bread'),
        line('line-void-return', 'order-void-return', 'Voided cheese'),
        line('line-void-sale', 'order-void-sale', 'Voided crisps'),
    ]);
    paymentsDB.set([
        payment('payment-sale', 'order-sale', 'DOJO-Z9-REFERENCE'),
        payment('payment-return', 'order-return', 'RETURN-REFERENCE'),
        payment('payment-refunded', 'order-refunded', 'REFUND-REFERENCE'),
        payment('payment-void-return', 'order-void-return', 'VOID-RETURN-REFERENCE'),
        payment('payment-void-sale', 'order-void-sale', 'VOID-SALE-REFERENCE'),
    ]);
}

describe('browser preview orders page', () => {
    let snapshot: PreviewStoreSnapshot;

    beforeEach(() => {
        snapshot = {
            customers: get(customersDB).slice(),
            employees: get(employeesDB).slice(),
            lines: get(orderLinesDB).slice(),
            orders: get(ordersDB).slice(),
            payments: get(paymentsDB).slice(),
            registers: get(registersDB).slice(),
        };
        seedPreviewOrders();
    });

    afterEach(() => {
        customersDB.set(snapshot.customers);
        employeesDB.set(snapshot.employees);
        orderLinesDB.set(snapshot.lines);
        ordersDB.set(snapshot.orders);
        paymentsDB.set(snapshot.payments);
        registersDB.set(snapshot.registers);
    });

    it('sorts and paginates records, enriches display names, and scopes detail rows to the page', async () => {
        const result = await getOrdersPage({ status: 'all', limit: 2, offset: 1 });

        expect(result.total).toBe(6);
        expect(result.overallTotal).toBe(6);
        expect(result.rows.map((record) => record.id)).toEqual(['order-sale', 'order-return']);
        expect(result.rows[0]).toMatchObject({
            cashierName: 'Alex Preview',
            tillName: 'Front Counter',
            customerName: 'Alice Cooper',
        });
        expect(result.rows[1]).toMatchObject({
            cashierName: 'Beth Returns',
            tillName: 'Browser Preview',
            customerName: '',
        });
        expect(new Set(result.lines.map((record) => record.orderId)))
            .toEqual(new Set(['order-sale', 'order-return']));
        expect(new Set(result.payments.map((record) => record.orderId)))
            .toEqual(new Set(['order-sale', 'order-return']));
    });

    it('searches joined display names, order lines, and payment references case-insensitively', async () => {
        await expect(getOrdersPage({ query: 'alice cooper' }))
            .resolves.toMatchObject({ rows: [expect.objectContaining({ id: 'order-sale' })], total: 1 });
        await expect(getOrdersPage({ query: 'organic almond' }))
            .resolves.toMatchObject({ rows: [expect.objectContaining({ id: 'order-sale' })], total: 1 });
        await expect(getOrdersPage({ query: 'dojo-z9' }))
            .resolves.toMatchObject({ rows: [expect.objectContaining({ id: 'order-sale' })], total: 1 });
        await expect(getOrdersPage({ query: 'BROWSER PREVIEW' }))
            .resolves.toMatchObject({ rows: [expect.objectContaining({ id: 'order-return' })], total: 1 });
        await expect(getOrdersPage({ query: 'beth returns' }))
            .resolves.toMatchObject({
                rows: [
                    expect.objectContaining({ id: 'order-hold' }),
                    expect.objectContaining({ id: 'order-return' }),
                ],
                total: 2,
            });
    });

    it('applies completed, refunds, voided, and ordinary status semantics', async () => {
        const completed = await getOrdersPage({ status: 'completed' });
        const refunds = await getOrdersPage({ status: 'refunds' });
        const voided = await getOrdersPage({ status: 'voided' });
        const held = await getOrdersPage({ status: 'hold' });

        expect(completed.rows.map((record) => record.id)).toEqual(['order-sale']);
        expect(refunds.rows.map((record) => record.id)).toEqual([
            'order-return',
            'order-refunded',
            'order-void-return',
            'order-void-sale',
        ]);
        expect(voided.rows.map((record) => record.id)).toEqual([
            'order-void-return',
            'order-void-sale',
        ]);
        expect(held.rows.map((record) => record.id)).toEqual(['order-hold']);
        expect(completed.overallTotal).toBe(6);
        expect(refunds.overallTotal).toBe(6);
    });
});
