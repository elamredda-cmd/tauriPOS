import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync(new URL('../routes/+page.svelte', import.meta.url), 'utf8');
const layout = readFileSync(new URL('../routes/+layout.svelte', import.meta.url), 'utf8');

describe('checkout draft lifecycle source wiring', () => {
    it('does not erase the synchronous recovery mirror during native startup', () => {
        expect(layout).not.toMatch(/localStorage\s*\.\s*clear\s*\(/);
    });
    it('loads/checks the draft before enabling autosave', () => {
        const restore = page.slice(page.indexOf('async function restoreCheckoutDraft()'), page.indexOf('function checkpointCheckoutOnExit()'));
        expect(restore.indexOf('await checkoutDraftDisposition')).toBeLessThan(restore.indexOf('checkoutDraftReady = true'));
        expect(page).toContain("if (checkoutDraftReady && !posDestroyed && $deviceOperatingMode !== 'back_office')");
    });
    it('resets empty checkout identities before the null-signature dedupe', () => {
        const save = page.slice(page.indexOf('function saveCurrentCheckoutDraft('), page.indexOf('async function saveCheckoutBoundary()'));
        expect(save.indexOf('if (!args[0].length)')).toBeLessThan(save.indexOf('signature === lastScheduledCheckoutDraft'));
        expect(save).toContain('if (checkoutDraftHoldId) checkoutDraftHoldId');
    });
    it('records hold identity even when re-holding a retrieved trolley', () => {
        const hold = page.slice(page.indexOf('async function holdOrder()'), page.indexOf('async function retrieveOrder('));
        expect(hold.indexOf('checkoutDraftHoldId = orderId')).toBeLessThan(hold.indexOf('if (!activeHeldRecovery)'));
        expect(hold.indexOf('await saveCheckoutBoundary()')).toBeLessThan(hold.indexOf('await saveHeldOrderBundle'));
    });
    it('does not manufacture a consumed tombstone after a failed atomic hold', () => {
        const hold = page.slice(page.indexOf('async function holdOrder()'), page.indexOf('async function retrieveOrder('));
        expect(hold).not.toContain('await removeSql("orders", orderId)');
        expect(hold).toContain('if (!holdBundleStarted)');
        expect(hold.indexOf('holdBundleStarted = true')).toBeLessThan(hold.indexOf('await saveHeldOrderBundle'));
    });
    it('records the submitted receipt before provider charge and receipt commit', () => {
        const sale = page.slice(page.indexOf('async function completeSale()'));
        expect(sale.indexOf('checkoutDraftSaleIds = [...checkoutDraftSaleIds, orderId]')).toBeLessThan(sale.indexOf('await processManagedDojoPayment'));
        expect(sale.indexOf('await saveCheckoutBoundary()')).toBeLessThan(sale.indexOf('await commitSale(saleBundle)'));
        expect(sale.indexOf("await nativeQaCheckpoint('checkout.after-sale-commit')")).toBeLessThan(sale.indexOf('applyCompletedSaleToStores(committedSale)'));
    });
    it('does not restore cash tender, loyalty redemption or payment UI', () => {
        const restore = page.slice(page.indexOf('async function restoreCheckoutDraft()'), page.indexOf('function checkpointCheckoutOnExit()'));
        expect(restore).toContain('useLoyaltyCredit = false');
        expect(restore).toContain("amountTenderedString = '0'");
        expect(restore).toContain('showPaymentModal = false');
        expect(restore).not.toMatch(/currentEmployee\.set|currentShiftId\.set|paymentMethod\s*=\s*draft/);
    });
    it('blocks new trolley entry while still permitting a pending held recovery', () => {
        expect(page).toContain('|| Boolean(pendingHeldRecovery && !activeHeldRecovery)');
        const recover = page.slice(page.indexOf('async function recoverInterruptedTrolley()'), page.indexOf('async function holdOrder()'));
        expect(recover).not.toContain('if (checkoutDraftBlocked) return');
        expect(recover).toContain('if (!checkoutDraftReady || checkoutDraftLoading || checkoutDraftRecoveryError) return');
        expect(page).toContain('Recover saved trolley');
    });
});
