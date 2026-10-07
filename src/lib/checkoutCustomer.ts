import type { Customer } from '$lib/stores/db';
import { createLoyaltyCode } from '$lib/loyalty';
import { loyaltyCodeValidationError, normalizeLoyaltyCode } from '$lib/customerLoyaltyCode';

export type CheckoutCustomerDraft = Pick<Customer, 'id' | 'name' | 'phone' | 'email' | 'postcode' | 'loyaltyCode' | 'notes' | 'createdAt' | 'updatedAt'>;

export function newCheckoutCustomerDraft(customers: Customer[]): CheckoutCustomerDraft {
    const stamp = new Date().toISOString();
    return { id: crypto.randomUUID(), name: '', phone: '', email: '', postcode: '',
        loyaltyCode: createLoyaltyCode(customers), notes: '', createdAt: stamp, updatedAt: stamp };
}

/** Creates a profile only. Ledger/loyalty balances are deliberately not writable here. */
export async function registerCheckoutCustomer(draft: CheckoutCustomerDraft, dependencies: {
    multi: boolean;
    online: boolean;
    codeInUse: (code: string, id: string) => Promise<boolean>;
    persist: (profile: CheckoutCustomerDraft) => Promise<void>;
}): Promise<Customer> {
    if (dependencies.multi && !dependencies.online) throw new Error('Reconnect to the main database before adding a customer.');
    if (!draft.id || !draft.createdAt) throw new Error('Reopen the new customer form and try again.');
    const name = draft.name.trim();
    if (!name) throw new Error('Customer name is required.');
    const loyaltyCode = normalizeLoyaltyCode(draft.loyaltyCode);
    const codeError = loyaltyCodeValidationError(loyaltyCode);
    if (codeError) throw new Error(codeError);
    const profile: CheckoutCustomerDraft = {
        id: draft.id, name, phone: draft.phone.trim(), email: draft.email.trim(),
        postcode: draft.postcode.trim().toUpperCase(), loyaltyCode,
        notes: draft.notes.trim(), createdAt: draft.createdAt, updatedAt: new Date().toISOString(),
    };
    if (await dependencies.codeInUse(loyaltyCode, draft.id)) {
        throw new Error('That loyalty code is already used. Enter a different code.');
    }
    await dependencies.persist(profile);
    return { ...profile, loyaltyPoints: 0 };
}
