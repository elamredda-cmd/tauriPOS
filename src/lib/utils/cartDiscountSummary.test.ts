import { describe, expect, it } from 'vitest';
import type { AppliedPromo, LineEvaluation } from './discountEngine';
import { summarizeCartDiscounts } from './cartDiscountSummary';

function applied(discountId: string, discountName: string, savings: number): AppliedPromo {
    return { discountId, discountName, savings };
}

function line(...discounts: AppliedPromo[]): LineEvaluation {
    return {
        savings: discounts.reduce((total, discount) => total + discount.savings, 0),
        applied: discounts,
        eligibleFor: [],
    };
}

describe('cart discount summary', () => {
    it('shows all applied names in full, including automatic and manual discounts on one line', () => {
        const discounts = [
            applied('bundle', 'Any three premium bakery items for four pounds', 125),
            applied('manual', 'Regular customer ten percent loyalty discount', 88),
        ];

        expect(summarizeCartDiscounts([line(...discounts)])).toEqual(discounts);
    });

    it('groups the same discount across all trolley lines and sums its allocated savings', () => {
        expect(summarizeCartDiscounts([
            line(applied('bundle', 'Bakery offer', 125), applied('manual', 'Ten percent', 88)),
            line(applied('bundle', 'Bakery offer', 75), applied('manual', 'Ten percent', 42)),
        ])).toEqual([
            applied('bundle', 'Bakery offer', 200),
            applied('manual', 'Ten percent', 130),
        ]);
    });

    it('does not merge different discount IDs that happen to share a name', () => {
        expect(summarizeCartDiscounts([
            line(applied('a', 'Special offer', 40)),
            line(applied('b', 'Special offer', 60)),
        ])).toEqual([
            applied('a', 'Special offer', 40),
            applied('b', 'Special offer', 60),
        ]);
    });

    it('never lists eligible offers as discounts that have already applied', () => {
        expect(summarizeCartDiscounts([{
            savings: 0,
            applied: [],
            eligibleFor: [{ discountId: 'next-item', discountName: 'Buy two for five pounds' }],
        }])).toEqual([]);
    });

    it('preserves the first applied order across trolley lines', () => {
        expect(summarizeCartDiscounts([
            line(applied('b', 'B', 40)),
            line(applied('a', 'A', 60), applied('b', 'B', 20)),
        ]).map(discount => discount.discountId)).toEqual(['b', 'a']);
    });

    it('does not mutate the engine evaluation or share its applied objects', () => {
        const lines = [line(applied('a', 'A', 40)), line(applied('a', 'A', 60))];
        const original = structuredClone(lines);
        const summary = summarizeCartDiscounts(lines);

        expect(lines).toEqual(original);
        expect(summary[0]).not.toBe(lines[0].applied[0]);
        summary[0].savings = 1;
        expect(lines).toEqual(original);
    });

    it('does not display zero, negative or invalid savings as applied discounts', () => {
        expect(summarizeCartDiscounts([line(
            applied('zero', 'Zero', 0),
            applied('negative', 'Negative', -25),
            applied('nan', 'Invalid', Number.NaN),
            applied('infinite', 'Invalid', Number.POSITIVE_INFINITY),
            applied('valid', 'Applied', 75),
        )])).toEqual([applied('valid', 'Applied', 75)]);
    });

    it('uses a readable fallback when an applied discount name is blank', () => {
        expect(summarizeCartDiscounts([line(applied('a', '   ', 25))]))
            .toEqual([applied('a', 'Discount', 25)]);
    });

    it('shows no summary for an empty trolley', () => {
        expect(summarizeCartDiscounts([])).toEqual([]);
    });
});
