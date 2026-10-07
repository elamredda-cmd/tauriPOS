/** Pure classification shared by upload/recovery checks. */
export function heldUploadOrderId(row: { table_name?: string; operation?: string; data?: unknown }): string {
    try {
        const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data as any;
        if (row.operation === 'heldOrderBundle') return String(data?.order?.id || '');
        if (row.operation !== 'upsert') return '';
        if (row.table_name === 'orders') return String(data?.id || '');
        if (row.table_name === 'order_lines') return String(data?.orderId || '');
    } catch { /* Malformed unrelated rows must not be mistaken for this hold. */ }
    return '';
}

export function heldUploadBlockReason(orderId: string, pending: any[], conflicts: any[]): string | null {
    if (conflicts.some(row => heldUploadOrderId(row) === orderId)) {
        return 'This trolley has an upload issue. Its items are kept on this till; resolve the sync issue before retrieving it.';
    }
    if (pending.some(row => heldUploadOrderId(row) === orderId)) {
        return 'This trolley is still waiting to upload. Its items are kept on this till; retry when sync finishes.';
    }
    return null;
}

export function isNullReceiptHoldConflict(row: any): boolean {
    if (row.table_name !== 'orders' || row.operation !== 'upsert'
        || !String(row.reason).includes('Invalid held order: invalid type: null, expected a string')) return false;
    try {
        const order = JSON.parse(row.data);
        return !!order.id && order.status === 'hold' && order.type === 'sale'
            && order.receiptKey == null && !order.completedAt && !order.paymentMethod
            && Number(order.orderNumber) === 0 && Number(order.amountTendered) === 0;
    } catch { return false; }
}
