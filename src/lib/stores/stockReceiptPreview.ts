import type { AuditLog, InventoryLog, Product, StockReceipt } from './db';
import type { StockReceiptBundle } from './database';

// MariaDB stores both receipt quantities and current stock in signed INT columns.
export const MAX_STOCK_QUANTITY = 2_147_483_647;

export function validateStockReceiptBundle(bundle: StockReceiptBundle): void {
    const receipt = bundle.receipt;
    if (!receipt.id.trim() || !receipt.employeeId.trim() || receipt.status !== 'received' || !bundle.lines.length) {
        throw new Error('Add at least one product and sign in before receiving stock.');
    }
    const products = new Set<string>();
    const lineIds = new Set<string>();
    const logIds = new Set<string>();
    let total = 0;
    for (const line of bundle.lines) {
        if (!line.id.trim() || !line.productId.trim() || !line.inventoryLogId.trim()
            || line.receiptId !== receipt.id || products.has(line.productId)
            || lineIds.has(line.id) || logIds.has(line.inventoryLogId)) {
            throw new Error('The stock receipt contains an invalid or duplicate product line.');
        }
        if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0 || line.quantity > MAX_STOCK_QUANTITY) {
            throw new Error(`Enter a whole quantity between 1 and ${MAX_STOCK_QUANTITY.toLocaleString('en-GB')}.`);
        }
        if (!Number.isSafeInteger(line.unitCost) || line.unitCost < 0) {
            throw new Error('Enter a valid unit cost in pounds and pence.');
        }
        const lineTotal = line.quantity * line.unitCost;
        total += lineTotal;
        if (!Number.isSafeInteger(lineTotal) || !Number.isSafeInteger(total)) {
            throw new Error('The stock receipt total is too large.');
        }
        products.add(line.productId);
        lineIds.add(line.id);
        logIds.add(line.inventoryLogId);
    }
    if (!Number.isSafeInteger(receipt.totalCost) || receipt.totalCost !== total) {
        throw new Error('The stock receipt total does not match its lines.');
    }
    if (!bundle.audit.id.trim() || bundle.audit.employeeId !== receipt.employeeId
        || bundle.audit.entityId !== receipt.id || bundle.audit.entityType !== 'stock_receipt'
        || bundle.audit.action !== 'stock_received') {
        throw new Error('The stock receipt audit is invalid.');
    }
}

/** An in-memory-only receipt ledger for browser simulations; never connects to a database. */
export function createStockReceiptPreview() {
    const receipts = new Map<string, StockReceipt>();
    const lineIds = new Set<string>();
    const logIds = new Set<string>();
    const auditIds = new Set<string>();

    return {
        recent(limit = 20): StockReceipt[] {
            const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)));
            return [...receipts.values()]
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
                .slice(0, safeLimit)
                .map((receipt) => ({ ...receipt }));
        },
        commit(bundle: StockReceiptBundle, products: Product[]): {
            products: Product[];
            logs: InventoryLog[];
            audit: AuditLog;
        } | null {
            validateStockReceiptBundle(bundle);
            if (receipts.has(bundle.receipt.id)) return null;
            if (bundle.lines.some((line) => lineIds.has(line.id) || logIds.has(line.inventoryLogId))
                || auditIds.has(bundle.audit.id)) {
                throw new Error('A stock receipt record already uses this identifier.');
            }
            const byId = new Map(products.map((product) => [product.id, product]));
            const updated = new Map<string, Product>();
            for (const line of bundle.lines) {
                const product = byId.get(line.productId);
                if (!product) throw new Error(`Product ${line.productName} is no longer available.`);
                const stockLevel = Number(product.stockLevel ?? 0) + line.quantity;
                if (!Number.isSafeInteger(stockLevel) || stockLevel > MAX_STOCK_QUANTITY
                    || stockLevel < -MAX_STOCK_QUANTITY - 1) {
                    throw new Error(`Stock for ${line.productName} would exceed the supported range.`);
                }
                updated.set(product.id, { ...product, stockLevel, updatedAt: bundle.receipt.updatedAt });
            }
            const reference = bundle.receipt.reference.trim();
            const logs: InventoryLog[] = bundle.lines.map((line) => ({
                id: line.inventoryLogId,
                productId: line.productId,
                quantityChange: line.quantity,
                type: 'restock',
                referenceId: bundle.receipt.id,
                employeeId: bundle.receipt.employeeId,
                notes: reference ? `Stock receipt ${reference}` : 'Stock receipt',
                createdAt: line.createdAt,
            }));
            // Prepare and validate every change before advancing the preview ledger.
            const result = {
                products: products.map((product) => updated.get(product.id) || product),
                logs,
                audit: { ...bundle.audit },
            };
            receipts.set(bundle.receipt.id, { ...bundle.receipt });
            bundle.lines.forEach((line) => { lineIds.add(line.id); logIds.add(line.inventoryLogId); });
            auditIds.add(bundle.audit.id);
            return result;
        },
    };
}
