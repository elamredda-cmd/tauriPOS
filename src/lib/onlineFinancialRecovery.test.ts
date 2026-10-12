import { describe, expect, it } from 'vitest';
import type { Employee, Setting } from '$lib/stores/db';
import { canRecoverOnlineFinancialIntent, OnlineFinancialPendingError, parsePendingOnlineFinancialIntent, shouldDetachPendingTrolley } from './onlineFinancialRecovery';

const row = {
    operation: 'customer_account_sale', orderId: 'original-sale', createdAt: '2026-10-12T12:00:00Z',
    lastError: 'FINANCIAL_STAGE[connect-mariadb] after 5000ms: pool timed out',
    bundleJson: JSON.stringify({ order: { id: 'original-sale', orderNumber: 1000083, receiptKey: 'till:1000083', total: 169, customerId: 'original-customer', employeeId: 'cashier' },
        lines: [{ productName: 'Eggs', quantity: 1, lineTotal: 169 }] }),
};
const intent = parsePendingOnlineFinancialIntent(row);
const employee = (role: Employee['role'], overrides = {}) => ({ id: 'cashier', role, isActive: true, ...overrides }) as Employee;

describe('pending online financial review', () => {
    it('uses the exact saved receipt, amount, customer and goods', () => {
        expect(intent).toMatchObject({ orderId: 'original-sale', receiptNumber: 1000083, total: 169, customerId: 'original-customer', lines: [{ productName: 'Eggs', quantity: 1, lineTotal: 169 }] });
        const error = new OnlineFinancialPendingError(intent);
        expect(error.message).toContain('pending verification');
        expect(error.message).toContain('1000083');
        expect(error.message).toContain('not cancelled');
        expect(error.message).toContain('Do not charge or refund again');
    });
    it('rejects corrupted/mismatched review data without inventing cancellation', () => {
        expect(() => parsePendingOnlineFinancialIntent({ ...row, orderId: 'another-order' })).toThrow('Do not charge or refund again');
        expect(() => parsePendingOnlineFinancialIntent({ ...row, operation: 'unexpected' })).toThrow();
        expect(() => parsePendingOnlineFinancialIntent({ ...row, bundleJson: '{}' })).toThrow();
    });
    it('detaches only the exact submitted trolley for the same durable receipt', () => {
        const cart = [{ productId: 'eggs', quantity: 1 }];
        const snapshot = JSON.stringify(cart);
        expect(shouldDetachPendingTrolley(intent, 'original-sale', snapshot, cart)).toBe(true);
        expect(shouldDetachPendingTrolley(intent, 'different-sale', snapshot, cart)).toBe(false);
        expect(shouldDetachPendingTrolley(intent, 'original-sale', snapshot, [{ productId: 'eggs', quantity: 2 }])).toBe(false);
        expect(shouldDetachPendingTrolley(intent, 'original-sale', '', cart)).toBe(false);
    });
    it('enforces operation-specific permissions and custom denials', () => {
        expect(canRecoverOnlineFinancialIntent(employee('cashier'), intent, [])).toBe(true);
        expect(canRecoverOnlineFinancialIntent(employee('cashier'), { ...intent, operation: 'reversal' }, [])).toBe(false);
        expect(canRecoverOnlineFinancialIntent(employee('supervisor'), { ...intent, operation: 'reversal' }, [])).toBe(true);
        const settings = [{ key: 'role_permissions', value: JSON.stringify({ version: 7, roles: { cashier: [] } }) }] as Setting[];
        expect(canRecoverOnlineFinancialIntent(employee('cashier'), intent, settings)).toBe(false);
        expect(canRecoverOnlineFinancialIntent(employee('admin'), intent, settings)).toBe(true);
    });
    it('restricts loyalty recovery to the original employee or management', () => {
        const loyalty = { ...intent, operation: 'loyalty_sale' as const };
        expect(canRecoverOnlineFinancialIntent(employee('cashier'), loyalty, [])).toBe(true);
        expect(canRecoverOnlineFinancialIntent(employee('cashier', { id: 'different' }), loyalty, [])).toBe(false);
        expect(canRecoverOnlineFinancialIntent(employee('manager', { id: 'different' }), loyalty, [])).toBe(true);
    });
    it.each([null, employee('attendance'), employee('admin', { isActive: false }), employee('admin', { roleNeedsRepair: true }), employee('admin', { pinNeedsReset: true }), employee('admin', { isSupportSession: true }), employee('admin', { id: 'lbj-support-test' })])('denies missing, invalid or support staff %#', actor => {
        expect(canRecoverOnlineFinancialIntent(actor, intent, [])).toBe(false);
    });
});
