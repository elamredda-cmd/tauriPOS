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
    optimizationLimited?: boolean;  // unusually complex overlap: cashier review advised
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

interface PromoInput {
    promo: Discount;
    units: EngineUnit[];
    applications: PromoApplication[];
}

// Exact overlap allocation is a set-packing problem. Keep both candidate
// generation and search bounded so an unusually large promotion setup cannot
// freeze a low-powered till. A limited result always requests cashier review.
const MAX_ALTERNATIVE_APPLICATIONS = 256;
const MAX_ALTERNATIVE_UNIT_REFERENCES = 20_000;
const MAX_SEARCH_NODES = 50_000;

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
    const groupsById = new Map(groups.map(group => [group.id, group]));
    for (const d of discounts) {
        if (!d.isActive || !d.autoApply || !d.groupId) continue;
        if (d.kind !== 'bogo_fixed_price' && d.kind !== 'bundle_fixed_price' && d.kind !== 'temporary_item') continue;
        if (!withinWindow(d.startAt, d.endAt, nowIso)) continue;
        const group = groupsById.get(d.groupId);
        if (!group || !group.isActive || !withinWindow(group.startAt, group.endAt, nowIso)) continue;
        let arr = promosByGroup.get(d.groupId);
        if (!arr) { arr = []; promosByGroup.set(d.groupId, arr); }
        arr.push(d);
    }

    const inputs: PromoInput[] = [];

    // For each promo group, expand cart units and build all non-stacking promo applications.
    for (const [groupId, promos] of promosByGroup) {
        const productSet = productsByGroup.get(groupId);
        if (!productSet || productSet.size === 0) continue;

        // Expand cart lines into units that belong to this group.
        const units: EngineUnit[] = [];
        cart.forEach((line, i) => {
            if (!productSet.has(line.id)) return;
            if (!Number.isSafeInteger(line.quantity) || line.quantity < 1
                || !Number.isSafeInteger(line.price) || line.price < 0) return;
            for (let q = 0; q < line.quantity; q++) units.push({
                key: `${i}:${q}`,
                lineIndex: i,
                price: line.price,
                basePrice: line.basePrice || line.price,
            });
        });

        const groupApplications: PromoApplication[] = [];
        for (const promo of promos) {
            const applications = simulateApplications(promo, units);
            if (applications.length > 0) inputs.push({ promo, units, applications });
            groupApplications.push(...applications);
        }

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

    const candidates = buildCompetingApplications(inputs);
    const originalApplications = inputs.flatMap(input => input.applications);
    const searchBudget = { remaining: MAX_SEARCH_NODES };
    const fallback = candidates.applications.length > originalApplications.length
        ? chooseNonStackingApplications(originalApplications, searchBudget) : null;
    let selection = chooseNonStackingApplications(candidates.applications, searchBudget);
    if (fallback && applicationSavings(fallback.applications) > applicationSavings(selection.applications)) {
        // A limited search must never make the initial valid allocation worse.
        selection = { applications: fallback.applications, limited: true };
    }
    for (const application of selection.applications) {
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
    return { lines, totalSavings, optimizationLimited: candidates.limited || selection.limited };
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

/**
 * A standalone offer can use its cheapest/highest-saving allocation directly.
 * Competing offers must also consider other units: reserving A for its own sale
 * price can make a B+C bundle better than the individually cheapest A+B bundle.
 */
function buildCompetingApplications(inputs: PromoInput[]): { applications: PromoApplication[]; limited: boolean } {
    const applications = inputs.flatMap(input => input.applications);
    const firstOwner = new Map<string, string>();
    const competing = new Set<string>();
    for (const input of inputs) {
        for (const unit of input.units) {
            const previous = firstOwner.get(unit.key);
            if (previous === undefined) firstOwner.set(unit.key, input.promo.id);
            else if (previous !== input.promo.id) {
                competing.add(previous);
                competing.add(input.promo.id);
            }
        }
    }

    let remainingApplications = MAX_ALTERNATIVE_APPLICATIONS;
    let remainingReferences = MAX_ALTERNATIVE_UNIT_REFERENCES;
    let limited = false;
    for (const input of inputs) {
        if (!competing.has(input.promo.id)) continue;
        const size = input.promo.kind === 'bundle_fixed_price' ? input.promo.bundleQuantity
            : input.promo.kind === 'bogo_fixed_price' ? input.promo.minQuantity + 1 : 1;
        const count = boundedCombinationCount(input.units.length, size, remainingApplications);
        if (count > remainingApplications || count * size > remainingReferences) {
            // Keep the valid fast allocation, but do not claim that unexplored
            // alternatives could not produce a better price.
            limited = true;
            continue;
        }
        remainingApplications -= count;
        remainingReferences -= count * size;
        const known = new Set(input.applications.map(application => application.usedKeys.slice().sort().join(',')));
        for (const units of combinations(input.units, size)) {
            const key = units.map(unit => unit.key).sort().join(',');
            if (known.has(key)) continue;
            // Exactly one bundle/BOGO set (or temporary-price unit) is simulated
            // here. The selector enforces the promotion's cart-wide use cap.
            for (const application of simulateApplications(input.promo, units)) {
                applications.push(application);
                known.add(key);
            }
        }
    }
    return { applications, limited };
}

function boundedCombinationCount(n: number, size: number, limit: number): number {
    if (size < 1 || size > n) return 0;
    const k = Math.min(size, n - size);
    let count = 1;
    for (let i = 1; i <= k; i++) {
        count = count * (n - k + i) / i;
        if (count > limit) return limit + 1;
    }
    return Math.round(count);
}

// Iterative rather than recursive: even a large "all these units" bundle uses
// bounded stack space when there is only one possible combination.
function* combinations(units: EngineUnit[], size: number): Generator<EngineUnit[]> {
    if (size < 1 || size > units.length) return;
    const indices = Array.from({ length: size }, (_, index) => index);
    while (true) {
        yield indices.map(index => units[index]);
        let index = size - 1;
        while (index >= 0 && indices[index] === units.length - size + index) index--;
        if (index < 0) return;
        indices[index]++;
        for (let next = index + 1; next < size; next++) indices[next] = indices[next - 1] + 1;
    }
}

function applicationSavings(applications: PromoApplication[]): number {
    return applications.reduce((sum, application) => sum + application.savings, 0);
}

function chooseNonStackingApplications(
    applications: PromoApplication[],
    budget: { remaining: number },
): { applications: PromoApplication[]; limited: boolean } {
    const ordered = applications
        .filter(application => application.savings > 0 && application.usedKeys.length > 0)
        .sort((a, b) =>
            b.savings - a.savings ||
            (b.promo.priority || 0) - (a.promo.priority || 0) ||
            a.usedKeys.length - b.usedKeys.length ||
            a.promo.name.localeCompare(b.promo.name)
        );

    // Split independent offers before searching. Thousands of ordinary items
    // should remain linear work, not one exponential cart-wide search.
    const parent = ordered.map((_, i) => i);
    const root = (i: number): number => {
        while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
        return i;
    };
    const owner = new Map<string, number>();
    const cappedPromoOwner = new Map<string, number>();
    const candidateCounts = new Map<string, number>();
    for (const application of ordered) {
        candidateCounts.set(application.promo.id, (candidateCounts.get(application.promo.id) || 0) + 1);
    }
    ordered.forEach((application, i) => {
        for (const key of application.usedKeys) {
            const previous = owner.get(key);
            if (previous === undefined) owner.set(key, i);
            else parent[root(i)] = root(previous);
        }
        // Alternative allocations of a capped offer also compete when their
        // units are disjoint; otherwise separate components could each use the
        // entire per-sale allowance.
        if ((candidateCounts.get(application.promo.id) || 0) > normaliseApplicationCap(application.promo.maxApplications)) {
            const previous = cappedPromoOwner.get(application.promo.id);
            if (previous === undefined) cappedPromoOwner.set(application.promo.id, i);
            else parent[root(i)] = root(previous);
        }
    });
    const components = new Map<number, PromoApplication[]>();
    ordered.forEach((application, i) => {
        const key = root(i);
        const component = components.get(key) || [];
        component.push(application);
        components.set(key, component);
    });
    const selected: PromoApplication[] = [];
    let limited = false;
    for (const component of components.values()) {
        if (component.length === 1) { selected.push(component[0]); continue; }
        const used = new Set<string>();
        const uses = new Map<string, number>();
        let best = component.filter(application => {
            if (application.usedKeys.some(key => used.has(key))) return false;
            const count = uses.get(application.promo.id) || 0;
            if (count >= normaliseApplicationCap(application.promo.maxApplications)) return false;
            application.usedKeys.forEach(key => used.add(key));
            uses.set(application.promo.id, count + 1);
            return true;
        });
        let bestSaving = best.reduce((sum, application) => sum + application.savings, 0);
        if (component.length > MAX_ALTERNATIVE_APPLICATIONS || budget.remaining <= 0) {
            limited = true;
            selected.push(...best);
            continue;
        }
        const unitIndex = new Map<string, number>();
        const masks = component.map(application => application.usedKeys.reduce((mask, key) => {
            if (!unitIndex.has(key)) unitIndex.set(key, unitIndex.size);
            return mask | (1n << BigInt(unitIndex.get(key)!));
        }, 0n));
        const suffixSavings = Array(component.length + 1).fill(0);
        for (let i = component.length - 1; i >= 0; i--) suffixSavings[i] = suffixSavings[i + 1] + component[i].savings;
        const chosen: PromoApplication[] = [];
        const chosenUses = new Map<string, number>();
        function search(index: number, mask: bigint, saving: number): void {
            if (saving > bestSaving) { bestSaving = saving; best = [...chosen]; }
            if (index === component.length || saving + suffixSavings[index] <= bestSaving) return;
            if (--budget.remaining < 0) { limited = true; return; }
            const application = component[index];
            const count = chosenUses.get(application.promo.id) || 0;
            if ((mask & masks[index]) === 0n && count < normaliseApplicationCap(application.promo.maxApplications)) {
                chosen.push(application);
                chosenUses.set(application.promo.id, count + 1);
                search(index + 1, mask | masks[index], saving + application.savings);
                chosenUses.set(application.promo.id, count);
                chosen.pop();
            }
            search(index + 1, mask, saving);
        }
        search(0, 0n, 0);
        selected.push(...best);
    }
    return { applications: selected, limited };
}

/** Temporary item offer: apply a percentage saving or a fixed sale price to every eligible unit. */
function simulateTemporaryItem(promo: Discount, units: EngineUnit[]): PromoApplication[] {
    if (!Number.isFinite(promo.value) || promo.value <= 0) return [];
    if (promo.type === 'percentage' && promo.value > 100) return [];
    if (promo.type !== 'percentage' && !Number.isSafeInteger(promo.value)) return [];
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
    if (!Number.isSafeInteger(promo.secondPrice) || promo.secondPrice < 0) return [];
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
    let supportOffset = 0;
    for (const discounted of discountedUnits) {
        const support = supportPool.slice(supportOffset, supportOffset + promo.minQuantity);
        supportOffset += promo.minQuantity;
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
    if (!Number.isSafeInteger(promo.bundlePrice) || promo.bundlePrice <= 0) return [];
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
        if (!Number.isSafeInteger(sum)) continue;
        const bundleSaving = sum - promo.bundlePrice;
        if (bundleSaving <= 0) continue;
        const perUnit = allocateBundleSaving(slice.map(item => item.u), bundleSaving, sum);
        result.push({
            promo,
            savings: bundleSaving,
            perUnit,
            usedKeys: slice.map(item => item.u.key),
        });
    }
    return result;
}

/** Largest-remainder apportionment in integer pence, never more than a unit's price. */
function allocateBundleSaving(units: EngineUnit[], saving: number, gross: number): UnitSaving[] {
    // BigInt avoids precision loss in the price × saving multiplication, even
    // though each input and output is an ordinary safe integer amount.
    const denominator = BigInt(gross);
    const shares = units.map((unit, index) => {
        const weighted = BigInt(saving) * BigInt(unit.price);
        return { unit, index, saving: Number(weighted / denominator), remainder: weighted % denominator };
    });
    let remaining = saving - shares.reduce((sum, share) => sum + share.saving, 0);
    const byRemainder = shares.slice().sort((a, b) =>
        a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
    for (const share of byRemainder) {
        if (remaining === 0) break;
        if (share.saving < share.unit.price) { share.saving++; remaining--; }
    }
    return shares.filter(share => share.saving > 0).map(share => ({
        key: share.unit.key, lineIndex: share.unit.lineIndex, saving: share.saving,
    }));
}

function normaliseApplicationCap(maxApplications: number | null): number {
    if (maxApplications == null) return Infinity;
    if (!Number.isInteger(maxApplications) || maxApplications < 1) return 0;
    return maxApplications;
}
