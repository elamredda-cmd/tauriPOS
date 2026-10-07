import { describe, expect, it } from 'vitest';
import { evaluateCart } from './discountEngine';
import type { Discount, PromoGroup, PromoGroupItem } from '$lib/stores/db';
import { calculateCartTotals, calculateTaxLine } from './commerceMath';

const clock = '2026-09-09T12:00:00.000Z';

function evaluateOffers(
    prices: number[],
    offers: Array<{ products: number[]; discount: Partial<Discount> }>,
) {
    const cart = prices.map((price, index) => ({ id: String(index), price, quantity: 1 }));
    const discounts = offers.map((offer, index) => ({
        id: String(index), name: `Offer ${index}`, groupId: String(index),
        kind: 'bundle_fixed_price', type: 'fixed', isActive: true, autoApply: true,
        startAt: '', endAt: '', maxApplications: null,
        ...offer.discount,
    })) as Discount[];
    const groups = offers.map((_, index) => ({
        id: String(index), isActive: true, startAt: '', endAt: '',
    })) as PromoGroup[];
    const memberships = offers.flatMap((offer, index) => offer.products.map(product => ({
        groupId: String(index), productId: String(product),
    }))) as PromoGroupItem[];
    return { cart, discounts, groups, memberships,
        result: evaluateCart(cart, discounts, groups, memberships, clock) };
}

function fixtures() {
    const offers = [['AB', ['A','B'], 200], ['AC', ['A','C'], 500], ['BD', ['B','D'], 500]] as const;
    return {
        cart: ['A','B','C','D'].map(id => ({ id, price: 500, quantity: 1 })),
        discounts: offers.map(([id, _, price]) => ({ id, name: id, groupId: id, isActive: true, autoApply: true,
            startAt: '', endAt: '', kind: 'bundle_fixed_price', bundleQuantity: 2, bundlePrice: price, maxApplications: null })) as Discount[],
        groups: offers.map(([id]) => ({ id, isActive: true, startAt: '', endAt: '' })) as PromoGroup[],
        memberships: offers.flatMap(([groupId, ids]) => ids.map(productId => ({ groupId, productId }))) as PromoGroupItem[],
    };
}
describe('promotion combinations', () => {
    it('chooses two compatible £5 savings instead of one £8 saving', () => {
        const f = fixtures();
        const result = evaluateCart(f.cart, f.discounts, f.groups, f.memberships);
        expect(result.totalSavings).toBe(1000);
        expect(result.optimizationLimited).toBe(false);
        expect(result.lines.every(line => line.savings <= 500)).toBe(true);
    });
    it('does not reuse units or exceed offer application limits', () => {
        const f = fixtures();
        const result = evaluateCart(f.cart, f.discounts.slice(0, 1), f.groups, f.memberships);
        expect(result.totalSavings).toBe(800);
        expect(result.lines.reduce((sum, line) => sum + line.savings, 0)).toBe(800);
    });
    it('bounds work and flags unexplored alternatives for thousands of overlapping units', () => {
        const f = fixtures();
        const result = evaluateCart(f.cart.map(line => ({ ...line, quantity: 2000 })), f.discounts, f.groups, f.memberships);
        // Each bundle allows any two units from its group (including two A's).
        expect(result.totalSavings).toBe(2_600_000);
        expect(result.optimizationLimited).toBe(true);
    });

    it('reserves the highest-price item for its sale price and bundles the other two', () => {
        const { result } = evaluateOffers([1000, 900, 800], [
            { products: [0, 1, 2], discount: { bundleQuantity: 2, bundlePrice: 1000 } },
            { products: [0], discount: { kind: 'temporary_item', value: 500 } },
        ]);
        expect(result.totalSavings).toBe(1200);
        expect(result.lines[0].savings).toBe(500);
        expect(result.optimizationLimited).toBe(false);
    });

    it('considers alternative full-price support units for a BOGO offer', () => {
        const { result } = evaluateOffers([1000, 900, 800], [
            { products: [0, 1, 2], discount: { kind: 'bogo_fixed_price', minQuantity: 1, secondPrice: 0 } },
            { products: [2], discount: { kind: 'temporary_item', value: 400 } },
        ]);
        expect(result.totalSavings).toBe(1400);
        expect(result.optimizationLimited).toBe(false);
    });

    it('can move a capped temporary offer to another unit to preserve a compatible bundle', () => {
        const { result } = evaluateOffers([1000, 900, 100], [
            { products: [0, 1], discount: { kind: 'temporary_item', type: 'percentage', value: 50, maxApplications: 1 } },
            { products: [0, 2], discount: { bundleQuantity: 2, bundlePrice: 1000 } },
        ]);
        expect(result.totalSavings).toBe(550);
        expect(result.lines[1].savings).toBe(450);
        expect(result.optimizationLimited).toBe(false);
    });

    it('enforces one cart-wide temporary-offer cap across disjoint candidate units', () => {
        const { result } = evaluateOffers([1000, 900, 800], [
            { products: [0, 1, 2], discount: { kind: 'temporary_item', type: 'percentage', value: 50, maxApplications: 1 } },
            { products: [0], discount: { kind: 'temporary_item', type: 'percentage', value: 60 } },
        ]);
        expect(result.totalSavings).toBe(1050);
        expect(result.lines[2].savings).toBe(0);
    });

    it('enforces a bundle use cap even when many alternative bundles do not share units', () => {
        const { result } = evaluateOffers([500, 500, 500, 500, 500], [
            { products: [0, 1, 2, 3, 4], discount: { bundleQuantity: 2, bundlePrice: 100, maxApplications: 1 } },
            { products: [0], discount: { kind: 'temporary_item', type: 'percentage', value: 50 } },
        ]);
        expect(result.totalSavings).toBe(1150);
        expect(result.optimizationLimited).toBe(false);
    });

    it('keeps large standalone offers fast and exact without an overlap warning', () => {
        const f = fixtures();
        const result = evaluateCart(f.cart.map(line => ({ ...line, quantity: 2000 })),
            [{ ...f.discounts[0], maxApplications: 2000 }], f.groups, f.memberships);
        expect(result.totalSavings).toBe(1_600_000);
        expect(result.optimizationLimited).toBe(false);
    });
});

describe('promotion penny allocation', () => {
    it.each([
        { prices: [100, 100, 100, 1], bundlePrice: 100 },
        { prices: [1, 1, 1, 1], bundlePrice: 1 },
        { prices: [100, 100, 100, 0], bundlePrice: 100 },
        { prices: [199, 149, 99, 1, 0], bundlePrice: 201 },
    ])('reconciles bundle $bundlePrice pence without over-discounting a cheap or free line', ({ prices, bundlePrice }) => {
        const { cart, result } = evaluateOffers(prices, [{ products: prices.map((_, index) => index),
            discount: { bundleQuantity: prices.length, bundlePrice } }]);
        const gross = prices.reduce((sum, price) => sum + price, 0);
        expect(result.totalSavings).toBe(gross - bundlePrice);
        result.lines.forEach((line, index) => {
            expect(Number.isInteger(line.savings)).toBe(true);
            expect(line.savings).toBeGreaterThanOrEqual(0);
            expect(line.savings).toBeLessThanOrEqual(prices[index]);
        });
        const totals = calculateCartTotals(cart.map((line, index) => calculateTaxLine({
            unitPrice: line.price, quantity: 1, discountAmount: result.lines[index].savings,
            taxRate: 0, taxIncludedInPrice: true,
        })));
        expect(totals.total).toBe(bundlePrice);
    });

    it('allocates weighted pennies exactly even when price × saving exceeds Number safe multiplication', () => {
        const { result } = evaluateOffers([1_000_000_001, 999_999_999, 1], [{
            products: [0, 1, 2], discount: { bundleQuantity: 3, bundlePrice: 1_000_000_000 },
        }]);
        expect(result.totalSavings).toBe(1_000_000_001);
        expect(result.lines[2].savings).toBeLessThanOrEqual(1);
    });
});

describe('promotion eligibility and limits', () => {
    it('requires both the promotion and its group to be active and within their windows', () => {
        const f = evaluateOffers([500, 500], [{ products: [0, 1], discount: {
            bundleQuantity: 2, bundlePrice: 500,
            startAt: '2026-09-09T11:00:00.000Z', endAt: clock,
        } }]);
        expect(f.result.totalSavings).toBe(500); // Endpoints are inclusive.
        expect(evaluateCart(f.cart, f.discounts, f.groups, f.memberships, '2026-09-09T12:00:00.001Z').totalSavings).toBe(0);
        const laterGroup = [{ ...f.groups[0], startAt: '2026-09-09T12:00:00.001Z' }];
        expect(evaluateCart(f.cart, f.discounts, laterGroup, f.memberships, clock).totalSavings).toBe(0);
        expect(evaluateCart(f.cart, f.discounts, [{ ...f.groups[0], isActive: false }], f.memberships, clock).totalSavings).toBe(0);
        expect(evaluateCart(f.cart, [{ ...f.discounts[0], isActive: false }], f.groups, f.memberships, clock).totalSavings).toBe(0);
    });

    it.each(['invalid', '2026-09-10T00:00:00.000Z'])('does not apply a promotion with a future or invalid start: %s', startAt => {
        const { result } = evaluateOffers([500, 500], [{ products: [0, 1], discount: {
            bundleQuantity: 2, bundlePrice: 500, startAt,
        } }]);
        expect(result.totalSavings).toBe(0);
    });

    it.each([0, -1, 0.5, Number.NaN])('does not apply an invalid per-sale cap: %s', maxApplications => {
        const { result } = evaluateOffers([500, 500], [{ products: [0, 1], discount: {
            bundleQuantity: 2, bundlePrice: 500, maxApplications,
        } }]);
        expect(result.totalSavings).toBe(0);
    });

    it('does not apply manual discounts automatically or turn fractional stored pennies into discounts', () => {
        const { result } = evaluateOffers([500, 500], [
            { products: [0], discount: { kind: 'manual_percent', type: 'percentage', value: 50 } },
            { products: [0, 1], discount: { bundleQuantity: 2, bundlePrice: 0.5 } },
            { products: [1], discount: { kind: 'temporary_item', value: 0.5 } },
        ]);
        expect(result.totalSavings).toBe(0);
    });

    it('keeps fractional percentage offers in whole pennies', () => {
        const { result } = evaluateOffers([199], [{ products: [0], discount: {
            kind: 'temporary_item', type: 'percentage', value: 12.5,
        } }]);
        expect(result.totalSavings).toBe(25);
    });
});
