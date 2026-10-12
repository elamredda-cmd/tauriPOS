export type ScaleSaleDisplay =
    | { kind: "weight"; label: string; kilograms: number; estimated: boolean }
    | { kind: "price"; label: "Price label" }
    | { kind: "each"; label: string };

export function getScaleSaleDisplay(
    notes = "",
    quantity = 1,
    linePrice = 0,
    pricePerKg = 0,
): ScaleSaleDisplay {
    const weightMatch = notes.match(/^(?:Manual scale|Scale weight barcode):\s*(\d+)\s*g\b/i);
    if (weightMatch) {
        const direction = quantity < 0 ? -1 : 1;
        const kilograms = direction * Number(weightMatch[1]) / 1000;
        return {
            kind: "weight",
            kilograms,
            label: `${formatKilograms(kilograms)} kg`,
            estimated: false,
        };
    }

    if (/^Scale price barcode:/i.test(notes)) {
        return { kind: "price", label: "Price label" };
    }

    return { kind: "each", label: `${quantity}x` };
}

export function formatKilograms(kilograms: number): string {
    return kilograms.toFixed(3).replace(/\.?0+$/, "");
}

/** A weighed line stores its calculated whole-line price in unitPrice. */
export function hasActualPriceOverride(line: {
    notes?: string; quantity: number; unitPrice: number; originalPrice: number; isPriceOverride?: boolean;
}): boolean {
    if (!line.isPriceOverride) return false;
    const display = getScaleSaleDisplay(line.notes, line.quantity, line.unitPrice, line.originalPrice);
    if (display.kind === 'weight') {
        return line.unitPrice !== Math.round(Math.abs(display.kilograms) * line.originalPrice);
    }
    // A price-encoded scale label is not a cashier edit of the per-kg catalogue rate.
    if (display.kind === 'price') return line.unitPrice !== line.originalPrice;
    return true;
}
