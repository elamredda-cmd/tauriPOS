import { writable } from 'svelte/store';

// Layout-owned recovery is outside the checkout component. Its scanner capture
// listener must respect this dialog just like checkout-owned payment/age gates.
export const onlineFinancialReviewOpen = writable(false);
