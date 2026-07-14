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
