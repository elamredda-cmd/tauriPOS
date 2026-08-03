type PreviewReceiptOrder = {
    id: string;
    status?: string;
    orderNumber?: number;
    employeeId?: string;
    tillNumber?: string;
    customerId?: string;
    completedAt?: string;
    createdAt?: string;
    updatedAt?: string;
};

type PreviewReceiptLine = {
    id: string;
    orderId: string;
    updatedAt?: string;
};

type PreviewReceiptPayment = {
    id: string;
    orderId: string;
    createdAt?: string;
};

type NamedPreviewRecord = {
    id: string;
    name?: string;
};

export interface PreviewRecentReceiptSources<
    TOrder extends PreviewReceiptOrder,
    TLine extends PreviewReceiptLine,
    TPayment extends PreviewReceiptPayment,
> {
    orders: readonly TOrder[];
    lines: readonly TLine[];
    payments: readonly TPayment[];
    employees?: readonly NamedPreviewRecord[];
    registers?: readonly NamedPreviewRecord[];
    customers?: readonly NamedPreviewRecord[];
}

export interface PreviewRecentReceiptsResult<
    TOrder extends PreviewReceiptOrder,
    TLine extends PreviewReceiptLine,
    TPayment extends PreviewReceiptPayment,
> {
    orders: Array<TOrder & {
        cashierName: string;
        tillName: string;
        customerName: string;
    }>;
    lines: TLine[];
    payments: TPayment[];
}

export interface PreviewOrderDetailsResult<
    TOrder extends PreviewReceiptOrder,
    TLine extends PreviewReceiptLine,
    TPayment extends PreviewReceiptPayment,
> {
    order: (TOrder & {
        cashierName: string;
        tillName: string;
        customerName: string;
    }) | null;
    lines: TLine[];
    payments: TPayment[];
}

function safeReceiptLimit(limit: number): number {
    const requested = Number(limit || 10);
    return Number.isFinite(requested)
        ? Math.max(1, Math.min(50, Math.trunc(requested)))
        : 10;
}

function receiptTimestamp(order: PreviewReceiptOrder): string {
    return String(order.completedAt || order.createdAt || order.updatedAt || '');
}

/**
 * Browser preview equivalent of SQLite's small recent-receipt query.
 *
 * Keep every payment row intact: the receipt renderer needs the explicit cash,
 * card, loyalty and account allocations, especially for Pay Later and split
 * payments. Filtering those rows by the selected order IDs is sufficient; no
 * payment allocation should be reconstructed from `orders.paymentMethod`.
 */
export function buildPreviewRecentReceipts<
    TOrder extends PreviewReceiptOrder,
    TLine extends PreviewReceiptLine,
    TPayment extends PreviewReceiptPayment,
>(
    sources: PreviewRecentReceiptSources<TOrder, TLine, TPayment>,
    limit = 10,
): PreviewRecentReceiptsResult<TOrder, TLine, TPayment> {
    const employeeNames = new Map(
        (sources.employees || []).map((employee) => [employee.id, String(employee.name || '')]),
    );
    const registerNames = new Map(
        (sources.registers || []).map((register) => [register.id, String(register.name || '')]),
    );
    const customerNames = new Map(
        (sources.customers || []).map((customer) => [customer.id, String(customer.name || '')]),
    );

    const orders = sources.orders
        .filter((order) => order.status !== 'hold' && order.status !== 'open')
        .slice()
        .sort((left, right) => {
            const timestampOrder = receiptTimestamp(right).localeCompare(receiptTimestamp(left));
            if (timestampOrder !== 0) return timestampOrder;
            return Number(right.orderNumber || 0) - Number(left.orderNumber || 0);
        })
        .slice(0, safeReceiptLimit(limit))
        .map((order) => ({
            ...order,
            cashierName: employeeNames.get(String(order.employeeId || '')) || '',
            tillName: registerNames.get(String(order.tillNumber || ''))
                || String(order.tillNumber || ''),
            customerName: customerNames.get(String(order.customerId || '')) || '',
        }));

    const selectedOrderIds = new Set(orders.map((order) => order.id));
    const lines = sources.lines
        .filter((line) => selectedOrderIds.has(line.orderId))
        .slice()
        .sort((left, right) => (
            left.orderId.localeCompare(right.orderId)
            || String(left.updatedAt || '').localeCompare(String(right.updatedAt || ''))
            || left.id.localeCompare(right.id)
        ));
    const payments = sources.payments
        .filter((payment) => selectedOrderIds.has(payment.orderId))
        .slice()
        .sort((left, right) => (
            left.orderId.localeCompare(right.orderId)
            || String(left.createdAt || '').localeCompare(String(right.createdAt || ''))
            || left.id.localeCompare(right.id)
        ));

    return { orders, lines, payments };
}

/** Return the newest printable preview receipt for one till. */
export function findLatestPreviewTillReceipt<
    TOrder extends PreviewReceiptOrder,
    TLine extends PreviewReceiptLine,
    TPayment extends PreviewReceiptPayment,
>(
    sources: PreviewRecentReceiptSources<TOrder, TLine, TPayment>,
    tillNumber: string,
): PreviewRecentReceiptsResult<TOrder, TLine, TPayment>['orders'][number] | null {
    const till = String(tillNumber || '').trim();
    if (!till) return null;
    const result = buildPreviewRecentReceipts({
        ...sources,
        orders: sources.orders.filter((order) => String(order.tillNumber || '').trim() === till),
    }, 1);
    return result.orders[0] || null;
}

/** Exact preview order detail lookup used by reprint and receipt actions. */
export function buildPreviewOrderDetails<
    TOrder extends PreviewReceiptOrder,
    TLine extends PreviewReceiptLine,
    TPayment extends PreviewReceiptPayment,
>(
    sources: PreviewRecentReceiptSources<TOrder, TLine, TPayment>,
    orderId: string,
): PreviewOrderDetailsResult<TOrder, TLine, TPayment> {
    const id = String(orderId || '').trim();
    const sourceOrder = sources.orders.find((order) => order.id === id);
    if (!sourceOrder) return { order: null, lines: [], payments: [] };

    const employeeName = sources.employees?.find((employee) => employee.id === sourceOrder.employeeId)?.name;
    const registerName = sources.registers?.find((register) => register.id === sourceOrder.tillNumber)?.name;
    const customerName = sources.customers?.find((customer) => customer.id === sourceOrder.customerId)?.name;
    const order = {
        ...sourceOrder,
        cashierName: String(employeeName || ''),
        tillName: String(registerName || sourceOrder.tillNumber || ''),
        customerName: String(customerName || ''),
    };
    const lines = sources.lines
        .filter((line) => line.orderId === id)
        .slice()
        .sort((left, right) => (
            String(left.updatedAt || '').localeCompare(String(right.updatedAt || ''))
            || left.id.localeCompare(right.id)
        ));
    const payments = sources.payments
        .filter((payment) => payment.orderId === id)
        .slice()
        .sort((left, right) => (
            String(left.createdAt || '').localeCompare(String(right.createdAt || ''))
            || left.id.localeCompare(right.id)
        ));
    return { order, lines, payments };
}
