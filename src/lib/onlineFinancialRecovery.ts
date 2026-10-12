import type { Employee, Setting } from '$lib/stores/db';
import { hasPermission } from '$lib/permissions';

export interface PendingOnlineFinancialIntent {
    operation: 'customer_account_sale' | 'loyalty_sale' | 'reversal';
    orderId: string;
    receiptNumber: number;
    receiptKey: string;
    total: number;
    customerId: string;
    employeeId: string;
    createdAt: string;
    lastError: string;
    lines: Array<{ productName: string; quantity: number; lineTotal: number }>;
}

export function canRecoverOnlineFinancialIntent(
    actor: Employee | null | undefined,
    intent: PendingOnlineFinancialIntent,
    settings: Setting[],
): boolean {
    if (!actor?.isActive || actor.roleNeedsRepair || actor.pinNeedsReset
        || actor.isSupportSession || actor.id.startsWith('lbj-support-')
        || !['admin', 'manager', 'supervisor', 'cashier'].includes(actor.role)) return false;
    if (intent.operation === 'customer_account_sale') return hasPermission(actor, 'charge_customer_account', settings);
    if (intent.operation === 'reversal') return hasPermission(actor, 'refund_void', settings);
    return intent.operation === 'loyalty_sale'
        && (actor.id === intent.employeeId || actor.role === 'admin' || actor.role === 'manager');
}

export function pendingOnlineFinancialMessage(intent: PendingOnlineFinancialIntent): string {
    return `Transaction pending verification — reserved receipt ${intent.receiptNumber || intent.receiptKey || intent.orderId}. It is not cancelled. Do not charge or refund again; review and recover this saved transaction.`;
}

export class OnlineFinancialPendingError extends Error {
    constructor(public readonly intent: PendingOnlineFinancialIntent) {
        super(pendingOnlineFinancialMessage(intent));
        this.name = 'OnlineFinancialPendingError';
    }
}

/** Never remove a different receipt's trolley or edits made after submission. */
export function shouldDetachPendingTrolley(
    intent: PendingOnlineFinancialIntent,
    submittedOrderId: string,
    submittedCartSnapshot: string,
    currentCart: unknown,
): boolean {
    return intent.orderId === submittedOrderId
        && submittedCartSnapshot !== ''
        && JSON.stringify(currentCart) === submittedCartSnapshot;
}

export function parsePendingOnlineFinancialIntent(row: Record<string, unknown>): PendingOnlineFinancialIntent {
    const bundle = JSON.parse(String(row.bundleJson || ''));
    const operation = String(row.operation || '');
    if (!['customer_account_sale', 'loyalty_sale', 'reversal'].includes(operation)
        || !bundle?.order?.id || bundle.order.id !== row.orderId
        || !Number.isSafeInteger(bundle.order.total) || !Array.isArray(bundle.lines)) {
        throw new Error('The saved financial transaction needs support review. Do not charge or refund again.');
    }
    return {
        operation: operation as PendingOnlineFinancialIntent['operation'],
        orderId: bundle.order.id,
        receiptNumber: Number(bundle.order.orderNumber || 0),
        receiptKey: String(bundle.order.receiptKey || ''),
        total: bundle.order.total,
        customerId: String(bundle.order.customerId || ''),
        employeeId: String(bundle.order.employeeId || ''),
        createdAt: String(row.createdAt || ''),
        lastError: String(row.lastError || ''),
        lines: bundle.lines.map((line: Record<string, unknown>) => ({
            productName: String(line.productName || ''),
            quantity: Number(line.quantity || 0),
            lineTotal: Number(line.lineTotal || 0),
        })),
    };
}
