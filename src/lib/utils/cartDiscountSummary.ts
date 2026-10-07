import type { AppliedPromo, CartEvaluation } from './discountEngine';

/** Present each applied discount once without changing the engine's calculations. */
export function summarizeCartDiscounts(lines: CartEvaluation['lines']): AppliedPromo[] {
    const discounts = new Map<string, AppliedPromo>();

    for (const line of lines) {
        for (const applied of line.applied) {
            if (!Number.isFinite(applied.savings) || applied.savings <= 0) continue;

            const existing = discounts.get(applied.discountId);
            if (existing) {
                existing.savings += applied.savings;
            } else {
                discounts.set(applied.discountId, {
                    discountId: applied.discountId,
                    discountName: applied.discountName.trim() || 'Discount',
                    savings: applied.savings,
                });
            }
        }
    }

    return [...discounts.values()];
}
