import type { Discount, PromoGroup, PromoGroupItem } from '$lib/stores/db';

// Input cart shape used by the POS (only the bits the engine needs).
export interface EngineCartLine {
    id: string;       // productId
    price: number;    // pence per unit
    quantity: number;
}

// One promo applied to one specific line.
export interface AppliedPromo {
    discountId: string;
    discountName: string;
    savings: number;  // pence taken off this line's total
}

// Per-line evaluation result, indexed identically to the cart input.
export interface LineEvaluation {
    savings: number;                 // pence taken off this line's total
    applied: AppliedPromo[];         // promos that fired on this line
    eligibleFor: { discountId: string; discountName: string }[]; // promo names/IDs this line could trigger
}

export interface CartEvaluation {
    lines: LineEvaluation[];
    totalSavings: number;            // sum of all line savings
}

/**
 * Evaluate a cart against the active auto-apply promotions and return the savings each line earns.
 *
 * Honours promo group membership, time windows, "best for customer" tie-breaking
 * (when two promos qualify on the same group, pick the one giving higher savings),
 * and `maxApplications` per promo per cart.
 *
 * Manual discounts (`kind: manual_*`) are ignored here — they're applied via the cashier UI.
 *
 * @example BOGO "Buy 1 croissant, 2nd at £1": minQuantity=1, secondPrice=100.
 *   With 3 croissants priced [200, 150, 180] => 1 unit gets discounted to £1.
 *   Best-for-customer picks the most expensive (200) for the discount, saving 100p.
 *
 * @example Bundle "Any 3 croissants for £4": bundleQuantity=3, bundlePrice=400.
 *   With 4 croissants priced [200, 150, 180, 200] => 1 bundle of the top 3 (200+200+180=580),
 *   saving 580-400 = 180p prorated across those 3 lines.
 */
export function evaluateCart(
    cart: EngineCartLine[],
    discounts: Discount[],
    groups: PromoGroup[],
    groupItems: PromoGroupItem[],
    nowIso: string = new Date().toISOString()
): CartEvaluation {
    const lines: LineEvaluation[] = cart.map(() => ({ savings: 0, applied: [], eligibleFor: [] }));

    // Build groupId -> Set<productId>
    const productsByGroup = new Map<string, Set<string>>();
    for (const gi of groupItems) {
        let s = productsByGroup.get(gi.groupId);
        if (!s) { s = new Set(); productsByGroup.set(gi.groupId, s); }
        s.add(gi.productId);
    }

    // Filter to active, in-window auto-apply promos and bucket them by groupId.
    const promosByGroup = new Map<string, Discount[]>();
    for (const d of discounts) {
        if (!d.isActive || !d.autoApply || !d.groupId) continue;
        if (d.kind !== 'bogo_fixed_price' && d.kind !== 'bundle_fixed_price') continue;
        if (!withinWindow(d.startAt, d.endAt, nowIso)) continue;
        const group = groups.find(g => g.id === d.groupId);
        if (!group || !group.isActive || !withinWindow(group.startAt, group.endAt, nowIso)) continue;
        let arr = promosByGroup.get(d.groupId);
        if (!arr) { arr = []; promosByGroup.set(d.groupId, arr); }
        arr.push(d);
    }

    // For each promo group, expand cart units, pick best discount, apply savings.
    for (const [groupId, promos] of promosByGroup) {
        const productSet = productsByGroup.get(groupId);
        if (!productSet || productSet.size === 0) continue;

        // Expand cart lines into units that belong to this group.
        const units: { lineIndex: number; price: number }[] = [];
        cart.forEach((line, i) => {
            if (!productSet.has(line.id)) return;
            for (let q = 0; q < line.quantity; q++) units.push({ lineIndex: i, price: line.price });
        });

        // Track the best plan across all promos on this group.
        let bestPlan: { savings: number; perUnit: { lineIndex: number; saving: number }[]; promo: Discount } | null = null;

        for (const promo of promos) {
            const plan = simulate(promo, units);
            if (!bestPlan || plan.savings > bestPlan.savings ||
                (plan.savings === bestPlan.savings && promo.priority > bestPlan.promo.priority)) {
                bestPlan = { ...plan, promo };
            }
        }

        if (bestPlan && bestPlan.savings > 0) {
            for (const u of bestPlan.perUnit) {
                lines[u.lineIndex].savings += u.saving;
                // Avoid duplicate AppliedPromo entries on the same line.
                const existing = lines[u.lineIndex].applied.find(a => a.discountId === bestPlan!.promo.id);
                if (existing) existing.savings += u.saving;
                else lines[u.lineIndex].applied.push({
                    discountId: bestPlan.promo.id,
                    discountName: bestPlan.promo.name,
                    savings: u.saving,
                });
            }
        } else if (units.length > 0) {
            // No promo fires yet, but the line *contains* group items — flag as eligible.
            const eligiblePromos = promos.map(p => ({ discountId: p.id, discountName: p.name }));
            const seenLines = new Set<number>();
            for (const u of units) seenLines.add(u.lineIndex);
            for (const li of seenLines) {
                for (const p of eligiblePromos) {
                    if (!lines[li].eligibleFor.find(e => e.discountId === p.discountId)) {
                        lines[li].eligibleFor.push(p);
                    }
                }
            }
        }
    }

    const totalSavings = lines.reduce((acc, l) => acc + l.savings, 0);
    return { lines, totalSavings };
}

function withinWindow(start: string, end: string, nowIso: string): boolean {
    const n = new Date(nowIso).getTime();
    if (start && n < new Date(start).getTime()) return false;
    if (end && n > new Date(end).getTime()) return false;
    return true;
}

interface SimPlan { savings: number; perUnit: { lineIndex: number; saving: number }[]; }

/** Dispatch to the right simulator based on discount kind. */
function simulate(promo: Discount, units: { lineIndex: number; price: number }[]): SimPlan {
    if (promo.kind === 'bogo_fixed_price') return simulateBogo(promo, units);
    if (promo.kind === 'bundle_fixed_price') return simulateBundle(promo, units);
    return { savings: 0, perUnit: [] };
}

/**
 * BOGO: for every (minQuantity + 1) units, the cheapest pattern is N full-price + 1 at secondPrice.
 * Best-for-customer: discount the highest-priced units (largest gap to secondPrice).
 */
function simulateBogo(promo: Discount, units: { lineIndex: number; price: number }[]): SimPlan {
    const setSize = promo.minQuantity + 1;
    const sets = Math.floor(units.length / setSize);
    if (sets <= 0) return { savings: 0, perUnit: [] };

    const cap = promo.maxApplications == null ? Infinity : promo.maxApplications;
    const applications = Math.min(sets, cap);
    if (applications <= 0) return { savings: 0, perUnit: [] };

    // Sort indexes by price desc; the first `applications` (highest-priced) get the discount price.
    const sorted = units.map((u, idx) => ({ u, idx })).sort((a, b) => b.u.price - a.u.price);
    const perUnit: { lineIndex: number; saving: number }[] = [];
    let total = 0;
    for (let i = 0; i < applications; i++) {
        const { u } = sorted[i];
        const saving = Math.max(0, u.price - promo.secondPrice);
        if (saving > 0) {
            total += saving;
            perUnit.push({ lineIndex: u.lineIndex, saving });
        }
    }
    return { savings: total, perUnit };
}

/**
 * Bundle: every `bundleQuantity` units form one bundle priced at `bundlePrice`.
 * Best-for-customer: pick the highest-priced units for each bundle (max savings).
 * Discount is prorated across the units in each bundle.
 */
function simulateBundle(promo: Discount, units: { lineIndex: number; price: number }[]): SimPlan {
    const bq = promo.bundleQuantity;
    if (bq <= 0) return { savings: 0, perUnit: [] };
    const bundles = Math.floor(units.length / bq);
    if (bundles <= 0) return { savings: 0, perUnit: [] };

    const cap = promo.maxApplications == null ? Infinity : promo.maxApplications;
    const applications = Math.min(bundles, cap);
    if (applications <= 0) return { savings: 0, perUnit: [] };

    const sorted = units.map((u, idx) => ({ u, idx })).sort((a, b) => b.u.price - a.u.price);
    const perUnit: { lineIndex: number; saving: number }[] = [];
    let total = 0;

    for (let b = 0; b < applications; b++) {
        const slice = sorted.slice(b * bq, b * bq + bq);
        const sum = slice.reduce((acc, s) => acc + s.u.price, 0);
        const bundleSaving = sum - promo.bundlePrice;
        if (bundleSaving <= 0) continue;
        // Prorate the savings across the units in this bundle.
        let distributed = 0;
        for (let i = 0; i < slice.length; i++) {
            const s = slice[i];
            // Last unit absorbs rounding remainder so totals match exactly.
            const share = (i === slice.length - 1)
                ? bundleSaving - distributed
                : Math.floor(bundleSaving * (s.u.price / sum));
            distributed += share;
            if (share > 0) perUnit.push({ lineIndex: s.u.lineIndex, saving: share });
        }
        total += bundleSaving;
    }
    return { savings: total, perUnit };
}
