import { describe, expect, it } from 'vitest';
import { parsePromotionMoney, parsePromotionWhole, promotionDraft, promotionOverlapNames, promotionWindowsOverlap, validatePromotionDraft } from './promotionEditor';
import type { Discount, PromoGroup } from './stores/db';

const discount = (overrides: Partial<Discount> = {}): Discount => ({
    id: 'offer', name: 'Offer', kind: 'temporary_item', groupId: 'group', type: 'percentage', value: 10,
    isActive: true, autoApply: true, minQuantity: 1, secondPrice: 0, bundleQuantity: 0, bundlePrice: 0,
    maxApplications: null, startAt: '', endAt: '', priority: 0, createdAt: '', updatedAt: '', ...overrides,
});
const group = (overrides: Partial<PromoGroup> = {}): PromoGroup => ({
    id: 'group', name: 'Group', isActive: true, startAt: '', endAt: '', createdAt: '', updatedAt: '', ...overrides,
});

describe('promotion numeric inputs', () => {
    it.each(['2.5', '2.0', '-1', '+2', '2e2', '', '2147483648', '9007199254740993'])('rejects quantity %s without truncation', (text) => {
        expect(parsePromotionWhole(text, 2)).toBeNull();
    });
    it.each([['2', 2], ['0003', 3], [' 8 ', 8], ['2147483647', 2147483647]])('parses bounded whole input %s exactly', (text, expected) => {
        expect(parsePromotionWhole(String(text), 2)).toBe(expected);
    });
    it.each(['1.999', '1e3', '-0.01', '', 'NaN', 'Infinity', '90071992547409.92'])('rejects invalid money %s without rounding', (text) => {
        expect(parsePromotionMoney(text)).toBeNull();
    });
    it.each([['.29', 29], ['0', 0], ['1.9', 190], ['1.99', 199], ['90071992547409.91', Number.MAX_SAFE_INTEGER]])('parses exact pence from %s', (text, expected) => {
        expect(parsePromotionMoney(String(text))).toBe(expected);
    });
    it('keeps empty maximum uses unlimited after editing a previously limited offer', () => {
        const draft = promotionDraft('bogo', 'offer', 'group', discount({ maxApplications: 3 }));
        draft.name = 'BOGO'; draft.productIds = ['tea']; draft.maxUses = '';
        expect(validatePromotionDraft(draft)).toMatchObject({ valid: true, values: { maxApplications: null } });
    });
    it('accepts fractional percentage values but not exponential notation', () => {
        const draft = promotionDraft('percent', 'offer', ''); draft.name = 'Staff'; draft.value = '12.5';
        expect(validatePromotionDraft(draft)).toMatchObject({ valid: true, values: { value: 12.5 } });
        draft.value = '1e1';
        expect(validatePromotionDraft(draft).errors.value).toBeTruthy();
    });
    it('does not accept decimal bundle quantities or overprecise prices', () => {
        const draft = promotionDraft('bundle', 'offer', 'group'); draft.name = 'Bundle'; draft.productIds = ['tea']; draft.quantity = '2.5'; draft.price = '1.999';
        expect(validatePromotionDraft(draft)).toMatchObject({ valid: false, errors: { quantity: expect.any(String), price: expect.any(String) } });
    });
});

describe('promotion overlap windows', () => {
    const current = new Date('2026-09-09T12:00:00Z').getTime();
    const active = { active: true, startAt: '', endAt: '' };
    it('requires the draft, discount and group all to be active', () => {
        expect(promotionWindowsOverlap({ active: false }, discount(), group(), current)).toBe(false);
        expect(promotionWindowsOverlap(active, discount({ isActive: false }), group(), current)).toBe(false);
        expect(promotionWindowsOverlap(active, discount(), group({ isActive: false }), current)).toBe(false);
        expect(promotionWindowsOverlap(active, discount(), undefined, current)).toBe(false);
    });
    it('ignores expired and non-overlapping scheduled windows', () => {
        expect(promotionWindowsOverlap(active, discount({ endAt: '2026-09-08T00:00:00Z' }), group(), current)).toBe(false);
        expect(promotionWindowsOverlap({ active: true, endAt: '2026-09-10T00:00:00Z' }, discount({ startAt: '2026-09-11T00:00:00Z' }), group(), current)).toBe(false);
    });
    it('uses the intersection of discount and group dates', () => {
        expect(promotionWindowsOverlap(active, discount({ startAt: '2026-09-11T00:00:00Z' }), group({ endAt: '2026-09-10T00:00:00Z' }), current)).toBe(false);
    });
    it('matches inclusive engine endpoints and fails closed for invalid dates', () => {
        expect(promotionWindowsOverlap({ active: true, endAt: '2026-09-10T00:00:00Z' }, discount({ startAt: '2026-09-10T00:00:00Z' }), group(), current)).toBe(true);
        expect(promotionWindowsOverlap(active, discount({ startAt: 'bad date' }), group(), current)).toBe(false);
    });
    it('does not block unrelated products, the current offer or inactive temporary offers', () => {
        const draft = promotionDraft('temporary', 'current', 'current-group'); draft.productIds = ['tea'];
        const offers = [discount(), discount({ id: 'inactive', groupId: 'inactive', isActive: false }), discount({ id: 'current', groupId: 'current-group' })];
        const items = [{ id: '1', groupId: 'group', productId: 'coffee' }, { id: '2', groupId: 'inactive', productId: 'tea' }, { id: '3', groupId: 'current-group', productId: 'tea' }];
        expect(promotionOverlapNames(draft, offers, [group()], items, current, true)).toEqual([]);
    });
});
