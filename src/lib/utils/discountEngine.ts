import type { Discount, PromoGroup, PromoGroupItem } from '$lib/stores/db';

// Input cart shape used by the POS (only the bits the engine needs).
export interface EngineCartLine {
    id: string;       // productId
    price: number;    // pence per unit
    quantity: number;
    basePrice?: number; // normal item/per-kg price; used for temporary sale prices on weighed lines
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

interface EngineUnit {
    key: string;
    lineIndex: number;
    price: number;
    basePrice: number;
}

interface UnitSaving {
    key: string;
    lineIndex: number;
    saving: number;
}

interface PromoApplication {
    promo: Discount;
    savings: number;
    perUnit: UnitSaving[];
    usedKeys: string[];
}

/**
 * Evaluate a cart against the active auto-apply promotions and return the savings each line earns.
 *
 * Honours promo group membership, time windows, "best for customer" tie-breaking,
 * and `maxApplications` per promo per cart. Promotions are selected globally:
 * once one physical cart unit is used by a bundle/BOGO/temporary offer, that
 * same unit cannot be reused by another offer even if the item is in two groups.
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
        if (d.kind !== 'bogo_fixed_price' && d.kind !== 'bundle_fixed_price' && d.kind !== 'temporary_item') continue;
        if (!withinWindow(d.startAt, d.endAt, nowIso)) continue;
        const group = groups.find(g => g.id === d.groupId);
        if (!group || !group.isActive || !withinWindow(group.startAt, group.endAt, nowIso)) continue;
        let arr = promosByGroup.get(d.groupId);
        if (!arr) { arr = []; promosByGroup.set(d.groupId, arr); }
        arr.push(d);
    }

    const applications: PromoApplication[] = [];

    // For each promo group, expand cart units and build all non-stacking promo applications.
    for (const [groupId, promos] of promosByGroup) {
        const productSet = productsByGroup.get(groupId);
        if (!productSet || productSet.size === 0) continue;

        // Expand cart lines into units that belong to this group.
        const units: EngineUnit[] = [];
        cart.forEach((line, i) => {
            if (!productSet.has(line.id)) return;
            for (let q = 0; q < line.quantity; q++) units.push({
                key: `${i}:${q}`,
                lineIndex: i,
                price: line.price,
                basePrice: line.basePrice || line.price,
            });
        });

        const groupApplications: PromoApplication[] = [];
        for (const promo of promos) {
            groupApplications.push(...simulateApplications(promo, units));
        }
        applications.push(...groupApplications);

        if (units.length > 0 && groupApplications.length === 0) {
            // No promo fires yet, but the line contains group items — flag as eligible.
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

    const selectedApplications = chooseNonStackingApplications(applications);
    for (const application of selectedApplications) {
        for (const u of application.perUnit) {
            lines[u.lineIndex].savings += u.saving;
            const existing = lines[u.lineIndex].applied.find(a => a.discountId === application.promo.id);
            if (existing) existing.savings += u.saving;
            else lines[u.lineIndex].applied.push({
                discountId: application.promo.id,
                discountName: application.promo.name,
                savings: u.saving,
            });
        }
    }

    const totalSavings = lines.reduce((acc, l) => acc + l.savings, 0);
    return { lines, totalSavings };
}

function withinWindow(start: string, end: string, nowIso: string): boolean {
    const n = new Date(nowIso).getTime();
    if (!Number.isFinite(n)) return false;
    if (start) {
        const startTime = new Date(start).getTime();
        if (!Number.isFinite(startTime) || n < startTime) return false;
    }
    if (end) {
        const endTime = new Date(end).getTime();
        if (!Number.isFinite(endTime) || n > endTime) return false;
    }
    return true;
}

/** Dispatch to the right simulator based on discount kind. */
function simulateApplications(promo: Discount, units: EngineUnit[]): PromoApplication[] {
    if (promo.kind === 'bogo_fixed_price') return simulateBogo(promo, units);
    if (promo.kind === 'bundle_fixed_price') return simulateBundle(promo, units);
    if (promo.kind === 'temporary_item') return simulateTemporaryItem(promo, units);
    return [];
}

function chooseNonStackingApplications(applications: PromoApplication[]): PromoApplication[] {
    const ordered = applications
        .filter(application => application.savings > 0 && application.usedKeys.length > 0)
        .sort((a, b) =>
            b.savings - a.savings ||
            (b.promo.priority || 0) - (a.promo.priority || 0) ||
            a.usedKeys.length - b.usedKeys.length ||
            a.promo.name.localeCompare(b.promo.name)
        );

    const used = new Set<string>();
    const selected: PromoApplication[] = [];
    for (const application of ordered) {
        if (application.usedKeys.some(key => used.has(key))) continue;
        selected.push(application);
        for (const key of application.usedKeys) used.add(key);
    }
    return selected;
}

/** Temporary item offer: apply a percentage saving or a fixed sale price to every eligible unit. */
function simulateTemporaryItem(promo: Discount, units: EngineUnit[]): PromoApplication[] {
    if (!Number.isFinite(promo.value) || promo.value <= 0) return [];
    if (promo.type === 'percentage' && promo.value > 100) return [];
    const applications: PromoApplication[] = [];
    for (const unit of units) {
        const temporaryPrice = unit.basePrice > 0
            ? Math.round(promo.value * (unit.price / unit.basePrice))
            : promo.value;
        const saving = promo.type === 'percentage'
            ? Math.round(unit.price * promo.value / 100)
            : Math.max(0, unit.price - temporaryPrice);
        const safeSaving = Math.min(unit.price, Math.max(0, saving));
        if (safeSaving > 0) {
            applications.push({
                promo,
                savings: safeSaving,
                perUnit: [{ key: unit.key, lineIndex: unit.lineIndex, saving: safeSaving }],
                usedKeys: [unit.key],
            });
        }
    }
    const cap = normaliseApplicationCap(promo.maxApplications);
    return applications
        .sort((a, b) => b.savings - a.savings)
        .slice(0, cap === Infinity ? applications.length : cap);
}

/**
 * BOGO: for every (minQuantity + 1) units, the cheapest pattern is N full-price + 1 at secondPrice.
 * Best-for-customer: discount the highest-priced units (largest gap to secondPrice).
 */
function simulateBogo(promo: Discount, units: EngineUnit[]): PromoApplication[] {
    if (!Number.isInteger(promo.minQuantity) || promo.minQuantity < 1) return [];
    if (!Number.isFinite(promo.secondPrice) || promo.secondPrice < 0) return [];
    const setSize = promo.minQuantity + 1;
    const sets = Math.floor(units.length / setSize);
    if (sets <= 0) return [];

    const cap = normaliseApplicationCap(promo.maxApplications);
    const applications = Math.min(sets, cap);
    if (applications <= 0) return [];

    const bySaving = units
        .map((u, idx) => ({ u, idx, saving: Math.max(0, u.price - promo.secondPrice) }))
        .sort((a, b) => b.saving - a.saving || b.u.price - a.u.price || a.idx - b.idx);
    const discountedUnits = bySaving.filter(item => item.saving > 0).slice(0, applications);
    const discountedKeys = new Set(discountedUnits.map(item => item.u.key));
    const supportPool = bySaving
        .filter(item => !discountedKeys.has(item.u.key))
        .sort((a, b) => a.u.price - b.u.price || a.idx - b.idx);

    const result: PromoApplication[] = [];
    for (const discounted of discountedUnits) {
        const support = supportPool.splice(0, promo.minQuantity);
        if (support.length < promo.minQuantity) break;
        const saving = discounted.saving;
        if (saving > 0) {
            result.push({
                promo,
                savings: saving,
                perUnit: [{ key: discounted.u.key, lineIndex: discounted.u.lineIndex, saving }],
                usedKeys: [discounted.u.key, ...support.map(item => item.u.key)],
            });
        }
    }
    return result;
}

/**
 * Bundle: every `bundleQuantity` units form one bundle priced at `bundlePrice`.
 * Best-for-customer: pick the highest-priced units for each bundle (max savings).
 * Discount is prorated across the units in each bundle.
 */
function simulateBundle(promo: Discount, units: EngineUnit[]): PromoApplication[] {
    const bq = promo.bundleQuantity;
    if (!Number.isInteger(bq) || bq < 2) return [];
    if (!Number.isFinite(promo.bundlePrice) || promo.bundlePrice <= 0) return [];
    const bundles = Math.floor(units.length / bq);
    if (bundles <= 0) return [];

    const cap = normaliseApplicationCap(promo.maxApplications);
    const applications = Math.min(bundles, cap);
    if (applications <= 0) return [];

    const sorted = units.map((u, idx) => ({ u, idx })).sort((a, b) => b.u.price - a.u.price);
    const result: PromoApplication[] = [];

    for (let b = 0; b < applications; b++) {
        const slice = sorted.slice(b * bq, b * bq + bq);
        const sum = slice.reduce((acc, s) => acc + s.u.price, 0);
        const bundleSaving = sum - promo.bundlePrice;
        if (bundleSaving <= 0) continue;
        // Prorate the savings across the units in this bundle.
        const perUnit: UnitSaving[] = [];
        let distributed = 0;
        for (let i = 0; i < slice.length; i++) {
            const s = slice[i];
            // Last unit absorbs rounding remainder so totals match exactly.
            const share = (i === slice.length - 1)
                ? bundleSaving - distributed
                : Math.floor(bundleSaving * (s.u.price / sum));
            distributed += share;
            if (share > 0) perUnit.push({ key: s.u.key, lineIndex: s.u.lineIndex, saving: share });
        }
        result.push({
            promo,
            savings: bundleSaving,
            perUnit,
            usedKeys: slice.map(item => item.u.key),
        });
    }
    return result;
}

function normaliseApplicationCap(maxApplications: number | null): number {
    if (maxApplications == null) return Infinity;
    if (!Number.isInteger(maxApplications) || maxApplications < 1) return 0;
    return maxApplications;
}
