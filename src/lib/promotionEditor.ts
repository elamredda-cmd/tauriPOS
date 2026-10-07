import type { Discount, PromoGroup, PromoGroupItem } from './stores/db';

export type PromotionEditorKind = 'bundle' | 'bogo' | 'temporary' | 'percent';
export type PromotionDraft = {
    kind: PromotionEditorKind;
    id: string;
    groupId: string;
    name: string;
    active: boolean;
    startAt: string;
    endAt: string;
    quantity: string;
    price: string;
    value: string;
    maxUses: string;
    temporaryType: 'percentage' | 'fixed';
    productIds: string[];
};
export type PromotionValues = { quantity: number; price: number; value: number; maxApplications: number | null };
export type PromotionWindow = { active: boolean; startAt?: string; endAt?: string };

export function promotionDraft(kind: PromotionEditorKind, id: string, groupId: string, discount?: Discount, group?: PromoGroup, items: PromoGroupItem[] = []): PromotionDraft {
    return {
        kind, id, groupId,
        name: discount?.name || '', active: discount ? discount.isActive && group?.isActive !== false : true,
        startAt: group?.startAt || discount?.startAt || '', endAt: group?.endAt || discount?.endAt || '',
        quantity: String(discount ? kind === 'bundle' ? discount.bundleQuantity : discount.minQuantity : kind === 'bundle' ? 2 : 1),
        price: discount ? ((kind === 'bundle' ? discount.bundlePrice : discount.secondPrice) / 100).toFixed(2) : '0.00',
        value: discount ? discount.type === 'fixed' ? (discount.value / 100).toFixed(2) : String(discount.value) : '10',
        maxUses: discount?.maxApplications == null ? '' : String(discount.maxApplications),
        temporaryType: discount?.type || 'percentage',
        productIds: [...new Set(items.filter((item) => item.groupId === groupId).map((item) => item.productId))],
    };
}

export function parsePromotionWhole(value: string, minimum: number): number | null {
    const text = value.trim();
    if (!/^\d+$/.test(text)) return null;
    const number = Number(text);
    return Number.isSafeInteger(number) && number >= minimum && number <= 2_147_483_647 ? number : null;
}

export function parsePromotionMoney(value: string): number | null {
    const text = value.trim();
    if (!/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(text)) return null;
    const [whole = '', fraction = ''] = text.split('.');
    const cents = BigInt(whole || '0') * 100n + BigInt(fraction.padEnd(2, '0'));
    return cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null;
}

export function validatePromotionDraft(draft: PromotionDraft): { valid: boolean; errors: Record<string, string>; values: PromotionValues } {
    const errors: Record<string, string> = {};
    const values: PromotionValues = { quantity: 1, price: 0, value: 0, maxApplications: null };
    if (!draft.name.trim()) errors.name = 'Enter a promotion name.';
    if (draft.name.trim().length > 255) errors.name = 'Use a name of 255 characters or fewer.';
    if (draft.kind !== 'percent' && !draft.productIds.length) errors.products = 'Choose at least one product.';
    if (draft.kind === 'temporary' && draft.productIds.length !== 1) errors.products = 'Choose one product for this offer.';
    if (draft.kind === 'bundle' || draft.kind === 'bogo') {
        const minimum = draft.kind === 'bundle' ? 2 : 1;
        const quantity = parsePromotionWhole(draft.quantity, minimum);
        if (quantity === null) errors.quantity = `Enter a whole quantity from ${minimum} to 2,147,483,647.`;
        else values.quantity = quantity;
        const price = parsePromotionMoney(draft.price);
        if (price === null || (draft.kind === 'bundle' && price === 0)) errors.price = `Enter ${draft.kind === 'bundle' ? 'a positive' : 'a non-negative'} price with no more than 2 decimal places.`;
        else values.price = price;
    }
    if (draft.kind === 'bogo' && draft.maxUses.trim()) {
        const maximum = parsePromotionWhole(draft.maxUses, 1);
        if (maximum === null) errors.maxUses = 'Enter a whole limit of 1 or more, or leave blank for unlimited.';
        else values.maxApplications = maximum;
    }
    if (draft.kind === 'percent' || draft.kind === 'temporary') {
        if (draft.kind === 'percent' || draft.temporaryType === 'percentage') {
            const text = draft.value.trim();
            const percentage = /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(text) ? Number(text) : NaN;
            if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) errors.value = 'Enter a percentage greater than 0 and no more than 100.';
            else values.value = percentage;
        } else {
            const price = parsePromotionMoney(draft.value);
            if (price === null || price <= 0) errors.value = 'Enter a positive sale price with no more than 2 decimal places.';
            else values.value = price;
        }
    }
    const start = draft.startAt ? new Date(draft.startAt).getTime() : -Infinity;
    const end = draft.endAt ? new Date(draft.endAt).getTime() : Infinity;
    if (Number.isNaN(start)) errors.startAt = 'Enter a valid start date and time.';
    if (Number.isNaN(end)) errors.endAt = 'Enter a valid end date and time.';
    if (start >= end) errors.endAt = 'End time must be after the start time.';
    return { valid: !Object.keys(errors).length, errors, values };
}

function windowBounds(window: PromotionWindow): [number, number] | null {
    if (!window.active) return null;
    const start = window.startAt ? new Date(window.startAt).getTime() : -Infinity;
    const end = window.endAt ? new Date(window.endAt).getTime() : Infinity;
    return Number.isNaN(start) || Number.isNaN(end) || start > end ? null : [start, end];
}

/** Runtime requires both discount and group windows, with inclusive endpoints. */
export function promotionWindowsOverlap(draft: PromotionWindow, discount: Discount, group: PromoGroup | undefined, currentTime: number): boolean {
    if (discount.groupId && !group) return false;
    const proposed = windowBounds(draft);
    const stored = windowBounds({ active: discount.isActive, startAt: discount.startAt, endAt: discount.endAt });
    const grouped = group ? windowBounds({ active: group.isActive, startAt: group.startAt, endAt: group.endAt }) : [-Infinity, Infinity];
    if (!proposed || !stored || !grouped) return false;
    return Math.max(currentTime, proposed[0], stored[0], grouped[0]) <= Math.min(proposed[1], stored[1], grouped[1]);
}

export function promotionOverlapNames(draft: PromotionDraft, discounts: Discount[], groups: PromoGroup[], items: PromoGroupItem[], currentTime: number, onlyTemporary = false): string[] {
    const selected = new Set(draft.productIds);
    const sharedGroups = new Set(items.filter((item) => selected.has(item.productId)).map((item) => item.groupId));
    const groupMap = new Map(groups.map((group) => [group.id, group]));
    return [...new Set(discounts.filter((discount) =>
        discount.id !== draft.id && discount.groupId !== draft.groupId && sharedGroups.has(discount.groupId)
        && (onlyTemporary ? discount.kind === 'temporary_item' : ['bundle_fixed_price', 'bogo_fixed_price', 'temporary_item'].includes(discount.kind))
        && promotionWindowsOverlap({ active: draft.active, startAt: draft.startAt, endAt: draft.endAt }, discount, groupMap.get(discount.groupId), currentTime)
    ).map((discount) => discount.name))];
}
