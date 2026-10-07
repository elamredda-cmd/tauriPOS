export const STOCK_RECEIVING_PRODUCT_PAGE_SIZE = 8;

/** A receiving delivery starts empty; never browse the whole catalogue implicitly. */
export function stockReceivingSearchQuery(value: string): string | null {
    return value.trim() || null;
}

export function stockReceivingProductPageInfo(options: {
    offset: number;
    count: number;
    total: number;
    totalIsCapped: boolean;
}): { hasNext: boolean; range: string } {
    const { offset, count, total, totalIsCapped } = options;
    if (count === 0) return { hasNext: false, range: offset ? 'No more matches' : 'No matches' };
    const end = offset + count;
    return {
        // A capped count is not the end of the catalogue. An incomplete page is.
        hasNext: totalIsCapped
            ? count === STOCK_RECEIVING_PRODUCT_PAGE_SIZE
            : end < total,
        range: totalIsCapped
            ? `${offset + 1}–${end} · ${Math.max(total, end)}+ matches`
            : `${offset + 1}–${end} of ${total}`,
    };
}
