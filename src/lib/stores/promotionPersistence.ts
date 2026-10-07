import type { LocalMutation } from './sqlite';

function queueJson(alias: string): string {
    return `(CASE WHEN json_valid(${alias}.data) THEN ${alias}.data ELSE '{}' END)`;
}
function queuedGroup(alias: string): string {
    const data = queueJson(alias);
    return `COALESCE(NULLIF(json_extract(${data}, '$.group.id'), ''), NULLIF(json_extract(${data}, '$.discount.groupId'), ''), NULLIF(json_extract(${data}, '$.groupId'), ''), '')`;
}
function queuedDiscountIds(alias: string): string {
    const data = queueJson(alias);
    return `(CASE WHEN ${alias}.operation = 'promotionBundle' THEN json_array(json_extract(${data}, '$.discount.id'))
        ELSE COALESCE(json_extract(${data}, '$.discountIds'), json_array(json_extract(${data}, '$.discountId'))) END)`;
}

/** Retried uploads remain causal predecessors even while their backoff is active.
 * SQLite rowid is commit order; UUID or wall-clock ordering is not causal order.
 * This predicate runs before LIMIT, so unrelated offers/sales are not starved.
 */
export const PROMOTION_QUEUE_HEAD_PREDICATE = `(_offline_queue.operation NOT IN ('promotionBundle', 'promotionDelete') OR NOT EXISTS (
    SELECT 1 FROM _offline_queue AS earlier_promotion
    WHERE earlier_promotion.rowid < _offline_queue.rowid
      AND earlier_promotion.operation IN ('promotionBundle', 'promotionDelete')
      AND ((${queuedGroup('_offline_queue')} <> '' AND ${queuedGroup('_offline_queue')} = ${queuedGroup('earlier_promotion')})
        OR EXISTS (SELECT 1 FROM json_each(${queuedDiscountIds('_offline_queue')}) AS incoming_id
          JOIN json_each(${queuedDiscountIds('earlier_promotion')}) AS previous_id ON incoming_id.value = previous_id.value
          WHERE COALESCE(incoming_id.value, '') <> ''))
))`;

export interface PromotionSnapshot {
    group: Record<string, any> | null;
    discounts: Record<string, any>[];
    items: Record<string, any>[];
}

/** Protect local storage too: otherwise an invalid SQLite value can sit in the
 * outbox until MariaDB rejects it much later. All monetary values here are pence.
 */
export function validatePromotionForPersistence(group: Record<string, any> | null, discount: Record<string, any>, items: Record<string, any>[]): void {
    if (!discount?.id || !String(discount.name || '').trim()) throw new Error('Promotion name and identity are required');
    if (group ? !group.id || discount.groupId !== group.id : discount.groupId || items.length) {
        throw new Error('Promotion does not match its product group');
    }
    const ids = new Set<string>(), products = new Set<string>();
    for (const item of items) {
        if (!item.id || !item.productId || item.groupId !== group?.id || ids.has(item.id) || products.has(item.productId)) {
            throw new Error('Promotion products must be unique and belong to this offer');
        }
        ids.add(item.id); products.add(item.productId);
    }
    for (const field of ['minQuantity', 'bundleQuantity', 'maxApplications']) {
        const value = discount[field];
        if (value == null) continue;
        if (!Number.isInteger(value) || value < (field === 'maxApplications' ? 1 : 0) || value > 2_147_483_647) {
            throw new Error(`Promotion ${field} is outside the supported quantity range`);
        }
    }
    for (const field of ['secondPrice', 'bundlePrice']) {
        const value = discount[field];
        if (value != null && (!Number.isSafeInteger(value) || value < 0)) throw new Error(`Promotion ${field} must be a safe, nonnegative penny amount`);
    }
    if (discount.kind === 'bundle_fixed_price' && (!(discount.bundleQuantity >= 2) || !(discount.bundlePrice > 0))) {
        throw new Error('A bundle needs at least two items and a positive price');
    }
    if (discount.kind === 'bogo_fixed_price' && !(discount.minQuantity >= 1)) throw new Error('BOGO buy quantity must be positive');
    if (discount.kind === 'temporary_item' || discount.kind === 'manual_percent') {
        const value = discount.value;
        const percentage = discount.type === 'percentage';
        if (!Number.isFinite(value) || value <= 0 || (percentage ? value > 100 : !Number.isSafeInteger(value))) {
            throw new Error('Promotion discount value is invalid');
        }
    }
}

/** Match MariaDB's harmless null/boolean encodings, excluding arrival metadata. */
export function promotionSnapshotsMatch(left: PromotionSnapshot, right: PromotionSnapshot): boolean {
    function row(value: Record<string, any>, text: string[], numbers: string[] = [], booleans: string[] = []) {
        const result: Record<string, any> = {};
        for (const field of text) result[field] = typeof value[field] === 'string' ? value[field] : '';
        for (const field of numbers) {
            const v = value[field];
            if (field === 'maxApplications' && (v == null || v === '')) { result[field] = null; continue; }
            const parsed = v == null || v === '' ? NaN : Number(v);
            result[field] = Number.isFinite(parsed) ? parsed : field === 'minQuantity' ? 1 : 0;
        }
        for (const field of booleans) {
            const v = value[field];
            result[field] = v == null ? field === 'isActive' : v === true || v === 1 || v === '1' || v === 'true';
        }
        return result;
    }
    function normalize(snapshot: PromotionSnapshot) {
        return {
            group: snapshot.group ? row(snapshot.group, ['id', 'name', 'startAt', 'endAt'], [], ['isActive']) : null,
            discounts: snapshot.discounts.map(value => row(value,
                ['id', 'name', 'type', 'kind', 'groupId', 'startAt', 'endAt'],
                ['value', 'minQuantity', 'secondPrice', 'bundleQuantity', 'bundlePrice', 'priority', 'maxApplications'],
                ['isActive', 'autoApply'],
            )).sort((a, b) => a.id.localeCompare(b.id)),
            items: snapshot.items.map(value => row(value, ['id', 'groupId', 'productId'])).sort((a, b) => a.id.localeCompare(b.id)),
        };
    }
    return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

export function promotionSnapshotAfterSave(
    before: PromotionSnapshot,
    group: Record<string, any> | null,
    discount: Record<string, any>,
    items: Record<string, any>[],
): PromotionSnapshot {
    return {
        group,
        discounts: [...before.discounts.filter(row => row.id !== discount.id), discount],
        items: group ? items : [],
    };
}

/** Audit, local rows, and upload intent share one SQLite commit. */
export function promotionSaveMutations(input: {
    before: PromotionSnapshot;
    group: Record<string, any> | null;
    discount: Record<string, any>;
    items: Record<string, any>[];
    products: Record<string, any>[];
    audit: Record<string, any>;
    queue: boolean;
    serverDataEpoch: string;
    uuid: () => string;
}): LocalMutation[] {
    const { before, group, discount, items, products, audit, queue, serverDataEpoch, uuid } = input;
    const retained = new Set(items.map(item => item.id));
    return [
        ...(group ? [{ table: 'promo_groups', data: group }] : []),
        { table: 'discounts', data: discount },
        ...before.items.filter(item => !retained.has(item.id)).map(item => ({
            table: 'promo_group_items', kind: 'remove' as const, data: { id: item.id },
        })),
        ...items.map(data => ({ table: 'promo_group_items', data })),
        { table: 'audit_logs', data: audit, ...(queue ? { queueId: uuid(), serverDataEpoch } : {}) },
        ...(queue ? [{
            table: 'promotion_bundle', kind: 'queue' as const,
            data: { group, discount, items, products, baseSnapshot: before },
            queueId: uuid(), serverDataEpoch,
        }] : []),
    ];
}

/** A removed member does not mean its still-active offer was deleted. */
export function promotionDeletionTargets(refs: {
    groupId: string; discountIds: string[]; itemIds: string[];
}): Array<[string, string]> {
    return [
        ...(refs.groupId ? [['promo_groups', refs.groupId] as [string, string]] : []),
        ...refs.discountIds.map(id => ['discounts', id] as [string, string]),
        ...(!refs.groupId && !refs.discountIds.length
            ? refs.itemIds.map(id => ['promo_group_items', id] as [string, string]) : []),
    ];
}

export async function refreshAfterPromotionCommit(refresh: () => Promise<void>, warn: (error: unknown) => void): Promise<void> {
    try { await refresh(); }
    catch (error) { warn(error); }
}
