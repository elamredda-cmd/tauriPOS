export const LOYALTY_CODE_MAX_LENGTH = 32;
export const LOYALTY_CODE_ALLOWED_PATTERN = /^[0-9A-Z. $/+%-]+$/;

export interface CustomerLoyaltyCodeRow {
    id: string;
    loyaltyCode?: string | null;
}

export interface CustomerLoyaltyCodeRepair {
    id: string;
    loyaltyCode: string | null;
}

export function normalizeLoyaltyCode(value: unknown): string {
    return String(value || '').trim().toUpperCase();
}

export function loyaltyCodeValidationError(value: unknown): string {
    const code = normalizeLoyaltyCode(value);
    if (!code) return 'Loyalty code is required';
    if (code.length > LOYALTY_CODE_MAX_LENGTH) {
        return `Loyalty code must be ${LOYALTY_CODE_MAX_LENGTH} characters or fewer`;
    }
    if (!LOYALTY_CODE_ALLOWED_PATTERN.test(code)) {
        return 'Loyalty code can only use A-Z, 0-9, spaces, and . $ / + % -';
    }
    return '';
}

function stableHash(value: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36).toUpperCase().padStart(7, '0').slice(-7);
}

function replacementCode(id: string, used: Set<string>): string {
    const compactId = normalizeLoyaltyCode(id).replace(/[^0-9A-Z]/g, '') || 'CUSTOMER';
    for (let attempt = 0; attempt < 10_000; attempt++) {
        const hash = stableHash(`${id}:${attempt}`);
        const candidate = `LB${compactId.slice(0, 23)}${hash}`.slice(0, LOYALTY_CODE_MAX_LENGTH);
        if (!used.has(candidate)) return candidate;
    }
    throw new Error(`Could not allocate a unique loyalty code for customer ${id}`);
}

/**
 * Produce deterministic repairs before the database unique index is created.
 * Blank legacy values remain null; valid first owners keep their existing code.
 */
export function planCustomerLoyaltyCodeRepairs(
    rows: CustomerLoyaltyCodeRow[],
): CustomerLoyaltyCodeRepair[] {
    const ordered = [...rows].sort((left, right) => String(left.id).localeCompare(String(right.id)));
    const keeperByCode = new Map<string, string>();

    for (const row of ordered) {
        const code = normalizeLoyaltyCode(row.loyaltyCode);
        if (!code || loyaltyCodeValidationError(code)) continue;
        if (!keeperByCode.has(code)) keeperByCode.set(code, row.id);
    }

    const used = new Set(keeperByCode.keys());
    const repairs: CustomerLoyaltyCodeRepair[] = [];
    for (const row of ordered) {
        const original = row.loyaltyCode == null ? null : String(row.loyaltyCode);
        const normalized = normalizeLoyaltyCode(original);
        let target: string | null = null;

        if (normalized && !loyaltyCodeValidationError(normalized) && keeperByCode.get(normalized) === row.id) {
            target = normalized;
        } else if (normalized) {
            target = replacementCode(row.id, used);
            used.add(target);
        }

        if (original !== target) repairs.push({ id: row.id, loyaltyCode: target });
    }
    return repairs;
}
