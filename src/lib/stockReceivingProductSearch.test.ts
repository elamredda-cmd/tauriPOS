import { describe, expect, it } from 'vitest';
import { stockReceivingProductPageInfo, stockReceivingSearchQuery, STOCK_RECEIVING_PRODUCT_PAGE_SIZE } from './stockReceivingProductSearch';

describe('stock receiving product search policy', () => {
    it.each(['', ' ', '\t\n'])('does not request suggestions for %j', (query) => {
        expect(stockReceivingSearchQuery(query)).toBeNull();
    });

    it.each(['Tea', '00001234', 'A'])('allows explicit names, barcodes and short queries: %s', (query) => {
        expect(stockReceivingSearchQuery(` ${query} `)).toBe(query);
    });

    it('keeps the result page small', () => {
        expect(STOCK_RECEIVING_PRODUCT_PAGE_SIZE).toBe(8);
    });

    it('offers the next page when exact totals include more products', () => {
        expect(stockReceivingProductPageInfo({ offset: 0, count: 8, total: 13, totalIsCapped: false }))
            .toEqual({ hasNext: true, range: '1–8 of 13' });
    });

    it('stops at the exact final page', () => {
        expect(stockReceivingProductPageInfo({ offset: 8, count: 5, total: 13, totalIsCapped: false }))
            .toEqual({ hasNext: false, range: '9–13 of 13' });
    });

    it('does not mistake a capped total for the last page', () => {
        expect(stockReceivingProductPageInfo({ offset: 16, count: 8, total: 20, totalIsCapped: true }))
            .toEqual({ hasNext: true, range: '17–24 · 24+ matches' });
    });

    it('stops capped paging after an incomplete page', () => {
        expect(stockReceivingProductPageInfo({ offset: 24, count: 2, total: 20, totalIsCapped: true }))
            .toEqual({ hasNext: false, range: '25–26 · 26+ matches' });
    });

    it.each([0, 8])('does not offer another page after an empty result at offset %i', (offset) => {
        expect(stockReceivingProductPageInfo({ offset, count: 0, total: 20, totalIsCapped: true }))
            .toEqual({ hasNext: false, range: offset ? 'No more matches' : 'No matches' });
    });
});
