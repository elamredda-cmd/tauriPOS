import { describe, expect, it } from 'vitest';
import type { Discount, PromoGroup, PromoGroupItem } from '$lib/stores/db';
import { evaluateCart } from './discountEngine';

type Offer = { members: number[]; quantity: number; price: number; limit: number; temporary?: boolean };

// Independent, deliberately tiny exhaustive oracle: enumerate every eligible
// combination, then every compatible choice. Production must remain bounded.
function exhaustiveSavings(prices: number[], offers: Offer[]): number {
    const candidates: { mask: number; offer: number; savings: number }[] = [];
    for (let offer = 0; offer < offers.length; offer++) {
        const rule = offers[offer];
        for (let mask = 1; mask < (1 << prices.length); mask++) {
            const selected = prices.map((_, index) => index).filter(index => mask & (1 << index));
            if (selected.length !== rule.quantity || selected.some(index => !rule.members.includes(index))) continue;
            const savings = selected.reduce((sum, index) => sum + prices[index], 0) - rule.price;
            if (savings > 0) candidates.push({ mask, offer, savings });
        }
    }
    const memo = new Map<string, number>();
    function best(used: number, counts: number[]): number {
        const key = `${used}:${counts.join(',')}`;
        const cached = memo.get(key);
        if (cached !== undefined) return cached;
        let result = 0;
        for (const candidate of candidates) {
            if ((used & candidate.mask) || counts[candidate.offer] >= offers[candidate.offer].limit) continue;
            const nextCounts = counts.slice();
            nextCounts[candidate.offer]++;
            result = Math.max(result, candidate.savings + best(used | candidate.mask, nextCounts));
        }
        memo.set(key, result);
        return result;
    }
    return best(0, offers.map(() => 0));
}

function evaluate(prices: number[], offers: Offer[]) {
    const discounts: Discount[] = offers.map((offer, index) => ({
        id: `offer-${index}`, name: `Offer ${index}`, groupId: `group-${index}`,
        kind: offer.temporary ? 'temporary_item' : 'bundle_fixed_price',
        type: 'fixed', value: offer.price, bundleQuantity: offer.quantity,
        bundlePrice: offer.price, isActive: true, autoApply: true,
        createdAt: '', minQuantity: 1, secondPrice: 0, priority: 0,
        startAt: '', endAt: '', maxApplications: offer.temporary ? null : offer.limit,
    }));
    const groups = offers.map((_, index) => ({
        id: `group-${index}`, name: `Group ${index}`, isActive: true, startAt: '', endAt: '',
    })) as PromoGroup[];
    const memberships = offers.flatMap((offer, index) => offer.members.map(member => ({
        id: `${index}-${member}`, groupId: `group-${index}`, productId: `item-${member}`,
    }))) as PromoGroupItem[];
    return evaluateCart(prices.map((price, index) => ({ id: `item-${index}`, price, quantity: 1 })), discounts, groups, memberships);
}

describe('promotion allocation against an independent exhaustive oracle', () => {
    it('matches the true cheapest combination across 150 reproducible small baskets', () => {
        let seed = 47123;
        const random = (max: number) => {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            return seed % max;
        };
        for (let scenario = 0; scenario < 150; scenario++) {
            const prices = Array.from({ length: 3 + random(4) }, () => 1 + random(1200));
            const offers: Offer[] = Array.from({ length: 2 + random(3) }, () => {
                const temporary = random(4) === 0;
                const members = temporary
                    ? [random(prices.length)]
                    : prices.map((_, index) => index).filter(() => random(3) !== 0);
                return { members, quantity: temporary ? 1 : 2 + random(2), price: 1 + random(1500), limit: temporary ? 1 : 1 + random(2), temporary };
            });
            const result = evaluate(prices, offers);
            const context = JSON.stringify({ scenario, prices, offers });
            expect(result.optimizationLimited, context).toBe(false);
            expect(result.totalSavings, context).toBe(exhaustiveSavings(prices, offers));
            expect(result.lines.reduce((sum, line) => sum + line.savings, 0), context).toBe(result.totalSavings);
            for (let index = 0; index < prices.length; index++) {
                expect(Number.isSafeInteger(result.lines[index].savings), context).toBe(true);
                expect(result.lines[index].savings, context).toBeGreaterThanOrEqual(0);
                expect(result.lines[index].savings, context).toBeLessThanOrEqual(prices[index]);
            }
        }
    });
});
