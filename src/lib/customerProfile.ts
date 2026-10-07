import type { Customer } from './stores/db';
import { normalizeLoyaltyCode } from './customerLoyaltyCode';

export const CUSTOMER_PROFILE_FIELDS = ['name', 'phone', 'email', 'postcode', 'loyaltyCode', 'notes'] as const;
export const CUSTOMER_PROFILE_CONFLICT = 'CUSTOMER_PROFILE_CONFLICT: This customer was changed on another screen or till. Close the editor, refresh and reopen the customer before saving.';

/** Financial balances and sync timestamps are not editable profile fields. */
export function customerProfileFields(customer: Partial<Customer>): Pick<Customer, typeof CUSTOMER_PROFILE_FIELDS[number]> {
    return {
        name: String(customer.name ?? '').trim(),
        phone: String(customer.phone ?? '').trim(),
        email: String(customer.email ?? '').trim(),
        postcode: String(customer.postcode ?? '').trim().toUpperCase(),
        loyaltyCode: normalizeLoyaltyCode(customer.loyaltyCode),
        notes: String(customer.notes ?? '').trim(),
    };
}

export function customerProfilesMatch(left: Partial<Customer> | null, right: Partial<Customer> | null): boolean {
    if (!left || !right) return left === right;
    if (left.id !== right.id) return false;
    return JSON.stringify(customerProfileFields(left)) === JSON.stringify(customerProfileFields(right));
}

/** An identical retry is safe; a new profile can never silently replace an existing one. */
export function assertCustomerProfileBase(current: Customer | null, before: Customer | null, desired: Partial<Customer>): void {
    if (customerProfilesMatch(current, desired) || customerProfilesMatch(current, before)) return;
    throw new Error(CUSTOMER_PROFILE_CONFLICT);
}
