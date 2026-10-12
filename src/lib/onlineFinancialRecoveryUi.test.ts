import { readFileSync } from 'node:fs';
import { get } from 'svelte/store';
import { afterEach, describe, expect, it } from 'vitest';
import { onlineFinancialReviewOpen } from './stores/onlineFinancialRecoveryUi';
import { CheckoutScannerBuffer } from './checkoutScanner';

afterEach(() => onlineFinancialReviewOpen.set(false));

describe('layout financial recovery / checkout scanner integration', () => {
    const checkout = readFileSync(new URL('../routes/+page.svelte', import.meta.url), 'utf8');
    const recovery = readFileSync(new URL('./components/OnlineFinancialRecovery.svelte', import.meta.url), 'utf8');
    it('wires the shared review state into the capture listener and focus guard', () => {
        expect(checkout).toMatch(/function scannerFocusBlocked[\s\S]*?return !\$currentEmployee \|\|\s*checkoutDraftBlocked \|\|\s*\$onlineFinancialReviewOpen \|\|/);
        expect(checkout).toMatch(/if \(scannerFocusBlocked\(true\)[\s\S]*?clearScannerBuffer\(\);\s*return;/);
        expect(checkout).toContain('if (!scanInput || scannerFocusBlocked()) return;');
        expect(checkout).toMatch(/\$: scannerOverlayOpen =\s*checkoutDraftBlocked \|\|\s*\$onlineFinancialReviewOpen \|\|/);
        expect(recovery).toContain('$onlineFinancialReviewOpen = true');
        expect(recovery).toMatch(/<h2 id="financial-recovery-title" tabindex="-1" data-modal-initial-focus>/);
        expect(recovery).toContain('onDestroy(() => { $onlineFinancialReviewOpen = false; });');
    });
    it('discards partial and complete scanner bursts during review, then accepts a fresh scan after close', () => {
        const buffer = new CheckoutScannerBuffer();
        const received: string[] = [];
        const capture = (key: string, now: number) => {
            if (get(onlineFinancialReviewOpen)) { buffer.clear(); return; }
            const result = buffer.push(key, now);
            if (result.barcode) received.push(result.barcode);
        };
        capture('1', 0);
        capture('2', 10);
        onlineFinancialReviewOpen.set(true);
        for (const [index, key] of ['3', '4', 'Enter', '5', '6', '7', '8', 'Enter'].entries()) capture(key, 20 + index * 10);
        expect(received).toEqual([]);
        expect(buffer.pending).toBe(false);
        onlineFinancialReviewOpen.set(false);
        for (const [index, key] of ['9', '0', '1', '2', 'Enter'].entries()) capture(key, 200 + index * 10);
        expect(received).toEqual(['9012']);
    });
});
