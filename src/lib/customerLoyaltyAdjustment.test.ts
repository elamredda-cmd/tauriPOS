import { describe, expect, it } from 'vitest';
import {
    customerLoyaltyAdjustmentPreview,
    customerLoyaltyReasonError,
    manualLoyaltyReason,
    manualLoyaltyReasonNote,
    MAX_CUSTOMER_LOYALTY_POINTS,
    MIN_CUSTOMER_LOYALTY_POINTS,
    newestCustomerSnapshot,
} from './customerLoyaltyAdjustment';

describe('customer loyalty adjustment helpers', () => {
    it('previews adding, removing, and setting a balance as signed movements', () => {
        expect(customerLoyaltyAdjustmentPreview(150, 'add', '25')).toMatchObject({
            pointsChange: 25,
            nextPoints: 175,
            error: '',
        });
        expect(customerLoyaltyAdjustmentPreview(150, 'remove', '25')).toMatchObject({
            pointsChange: -25,
            nextPoints: 125,
            error: '',
        });
        expect(customerLoyaltyAdjustmentPreview(150, 'set', '425')).toMatchObject({
            pointsChange: 275,
            nextPoints: 425,
            error: '',
        });
        expect(customerLoyaltyAdjustmentPreview(150, 'set', '0')).toMatchObject({
            pointsChange: -150,
            nextPoints: 0,
            error: '',
        });
    });

    it('rejects partial, negative, excessive, and no-op values', () => {
        expect(customerLoyaltyAdjustmentPreview(100, 'add', '1.5').error).toMatch(/whole number/i);
        expect(customerLoyaltyAdjustmentPreview(100, 'remove', '101').error).toMatch(/more points/i);
        expect(customerLoyaltyAdjustmentPreview(100, 'set', '100').error).toMatch(/already/i);
        expect(customerLoyaltyAdjustmentPreview(100, 'add', String(MAX_CUSTOMER_LOYALTY_POINTS)).error)
            .toMatch(/too large/i);
        expect(customerLoyaltyAdjustmentPreview(100, 'add', '-5').error).toMatch(/whole number/i);
    });

    it('requires a useful bounded reason and round-trips manual history notes', () => {
        expect(customerLoyaltyReasonError('')).toMatch(/reason/i);
        expect(customerLoyaltyReasonError('ok')).toMatch(/3 characters/i);
        expect(customerLoyaltyReasonError('Balance restored after till reset')).toBe('');
        expect(customerLoyaltyReasonError('x'.repeat(241))).toMatch(/under 241/i);

        const stored = manualLoyaltyReason('  Balance restored after till reset  ');
        expect(stored).toBe('manual_adjustment: Balance restored after till reset');
        expect(manualLoyaltyReasonNote(stored)).toBe('Balance restored after till reset');
        expect(manualLoyaltyReasonNote('earned')).toBe('');
    });

    it('shows a negative refund balance honestly and corrects it with Add or Set', () => {
        expect(customerLoyaltyAdjustmentPreview(-25, 'add', '')).toMatchObject({ enteredPoints: null, nextPoints: -25, error: '' });
        expect(customerLoyaltyAdjustmentPreview(-25, 'add', '30')).toMatchObject({ pointsChange: 30, nextPoints: 5, error: '' });
        expect(customerLoyaltyAdjustmentPreview(-25, 'set', '0')).toMatchObject({ pointsChange: 25, nextPoints: 0, error: '' });
        expect(customerLoyaltyAdjustmentPreview(-25, 'set', '10')).toMatchObject({ pointsChange: 35, nextPoints: 10, error: '' });
        expect(customerLoyaltyAdjustmentPreview(-25, 'remove', '1').error).toMatch(/negative balance/i);
        expect(customerLoyaltyAdjustmentPreview(-25, 'add', '10').error).toMatch(/negative balance/i);
    });

    it('never truncates an invalid stored balance or overflows the signed movement range', () => {
        for (const points of [1.5, -1.5, NaN, Infinity, MAX_CUSTOMER_LOYALTY_POINTS + 1, MIN_CUSTOMER_LOYALTY_POINTS - 1]) {
            expect(customerLoyaltyAdjustmentPreview(points, 'set', '0').error).toMatch(/current points balance is invalid/i);
        }
        expect(customerLoyaltyAdjustmentPreview(-1, 'set', String(MAX_CUSTOMER_LOYALTY_POINTS)).error).toMatch(/correction is too large/i);
        expect(customerLoyaltyAdjustmentPreview(MIN_CUSTOMER_LOYALTY_POINTS, 'set', '0').error).toMatch(/correction is too large/i);
        expect(customerLoyaltyAdjustmentPreview(-MAX_CUSTOMER_LOYALTY_POINTS, 'set', '0')).toMatchObject({ pointsChange: MAX_CUSTOMER_LOYALTY_POINTS, nextPoints: 0, error: '' });
    });

    it.each(['-1', '+1', '1.5', '1e2', '1,000', 'Infinity'])('rejects non-integer point input %s even for a negative existing balance', (value) => {
        expect(customerLoyaltyAdjustmentPreview(-25, 'add', value).error).toMatch(/whole number/i);
    });

    it('never replaces a newer synced customer with an older loyalty read', () => {
        const older = { id: 'customer', updatedAt: '2026-09-09T10:00:00Z', loyaltyPoints: -10 };
        const newer = { id: 'customer', updatedAt: '2026-09-09T10:00:01Z', loyaltyPoints: 20 };
        expect(newestCustomerSnapshot(older, newer)).toBe(newer);
        expect(newestCustomerSnapshot(newer, older)).toBe(newer);
        expect(newestCustomerSnapshot(newer, null)).toBe(newer);
        expect(newestCustomerSnapshot(null, newer)).toBe(newer);
        expect(newestCustomerSnapshot(older, { ...newer, id: 'another' })).toBe(older);
        expect(newestCustomerSnapshot(newer, { ...newer, loyaltyPoints: 15 })).toBe(newer);
    });
});
