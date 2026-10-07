export type ReceivingDraftLine = {
    id: string;
    productId: string;
    productName: string;
    quantityInput: string;
    unitCostInput: string;
    inventoryLogId: string;
};

export type ValidatedReceivingLine = Omit<ReceivingDraftLine, 'quantityInput' | 'unitCostInput'> & {
    quantity: number;
    /** Unit cost in integer pence. */
    unitCost: number;
};

export type ReceivingDraftValidation = {
    valid: boolean;
    /** Integer pence; unavailable totals are zero and must be hidden when invalid. */
    totalCost: number;
    totalUnits: number;
    errors: Record<string, { quantity?: string; unitCost?: string }>;
    message: string;
    /** Empty when invalid; no partially validated delivery may be submitted. */
    lines: ValidatedReceivingLine[];
};

const MAX_QUANTITY = 2_147_483_647;
const MAX_SAFE_INTEGER_DIGITS = String(Number.MAX_SAFE_INTEGER);

function parseSafeDigits(digits: string): number | undefined {
    const canonical = digits.replace(/^0+/, '') || '0';
    if (canonical.length > MAX_SAFE_INTEGER_DIGITS.length
        || (canonical.length === MAX_SAFE_INTEGER_DIGITS.length
            && canonical > MAX_SAFE_INTEGER_DIGITS)) {
        return undefined;
    }
    return Number(canonical);
}

function parseQuantity(input: string): number | undefined {
    const text = input.trim();
    if (!/^\d+$/.test(text)) return undefined;
    const quantity = parseSafeDigits(text);
    return quantity !== undefined && quantity > 0 && quantity <= MAX_QUANTITY
        ? quantity
        : undefined;
}

function parseUnitCost(input: string): number | undefined {
    const text = input.trim();
    if (!/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(text)) return undefined;
    const [pounds, fraction = ''] = text.split('.');
    // Concatenation avoids floating-point rounding (for example £1.13 * 100).
    return parseSafeDigits(`${pounds || '0'}${fraction.padEnd(2, '0')}`);
}

/** Validate the entire draft before returning any lines suitable for saving. */
export function validateReceivingDraft(draft: ReceivingDraftLine[]): ReceivingDraftValidation {
    const errors: ReceivingDraftValidation['errors'] = Object.create(null);
    const lines: ValidatedReceivingLine[] = [];
    let totalCost = 0;
    let totalUnits = 0;
    let hasInvalidNumber = false;
    let hasDuplicate = false;
    let hasOverflow = false;
    const productCounts = new Map<string, number>();

    for (const line of draft) {
        productCounts.set(line.productId, (productCounts.get(line.productId) ?? 0) + 1);
    }

    for (const line of draft) {
        const rowErrors: { quantity?: string; unitCost?: string } = {};
        const quantity = parseQuantity(line.quantityInput);
        const unitCost = parseUnitCost(line.unitCostInput);

        if (quantity === undefined) {
            rowErrors.quantity = 'Enter a whole quantity from 1 to 2,147,483,647.';
            hasInvalidNumber = true;
        }
        if (unitCost === undefined) {
            rowErrors.unitCost = 'Enter a cost of £0 or more with no more than 2 decimal places.';
            hasInvalidNumber = true;
        }
        if ((productCounts.get(line.productId) ?? 0) > 1) {
            rowErrors.quantity = rowErrors.quantity
                ? `${rowErrors.quantity} This product is also listed more than once.`
                : 'This product is listed more than once. Keep one row and update its quantity.';
            hasDuplicate = true;
        }

        if (quantity !== undefined && unitCost !== undefined) {
            const lineCost = quantity * unitCost;
            const nextCost = totalCost + lineCost;
            const nextUnits = totalUnits + quantity;
            if (!Number.isSafeInteger(lineCost)
                || !Number.isSafeInteger(nextCost)
                || !Number.isSafeInteger(nextUnits)) {
                rowErrors.unitCost = 'The delivery total is too large. Reduce the quantity or unit cost.';
                hasOverflow = true;
            } else {
                totalCost = nextCost;
                totalUnits = nextUnits;
            }
            lines.push({
                id: line.id,
                productId: line.productId,
                productName: line.productName,
                inventoryLogId: line.inventoryLogId,
                quantity,
                unitCost,
            });
        }

        if (Object.keys(rowErrors).length > 0) errors[line.id] = rowErrors;
    }

    let message = '';
    if (draft.length === 0) message = 'Add at least one product to receive stock.';
    else if (hasInvalidNumber) message = 'Check the highlighted quantities and unit costs before receiving stock.';
    else if (hasDuplicate) message = 'Each product can appear only once. Remove duplicate rows and update the quantity.';
    else if (hasOverflow) message = 'The delivery total is too large. Reduce the quantities or unit costs.';

    const valid = message === '';
    return {
        valid,
        totalCost: valid ? totalCost : 0,
        totalUnits: valid ? totalUnits : 0,
        errors,
        message,
        lines: valid ? lines : [],
    };
}
