import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isBlockingToast, isCashCompletion, isScanDismissibleToast, dismissSaleCompletionOnScan, removeToast, toast, toasts, type ToastItem } from './toast';

beforeEach(() => {
    vi.useFakeTimers();
    toasts.set([]);
});

afterEach(() => {
    toasts.set([]);
    vi.clearAllTimers();
    vi.useRealTimers();
});

describe('toast interaction policy', () => {
    it.each(['success', 'info'] as const)('%s notices do not block checkout or scanner input', (type) => {
        expect(isBlockingToast({ type })).toBe(false);
        expect(isBlockingToast({ type, showPrint: false })).toBe(false);
    });

    it.each([undefined, false, true])('errors block input with showPrint=%s', (showPrint) => {
        expect(isBlockingToast({ type: 'error', showPrint })).toBe(true);
    });

    it.each(['success', 'info', 'error'] as const)('%s receipt prompts block input', (type) => {
        expect(isBlockingToast({ type, showPrint: true })).toBe(true);
    });

    it('does not make an otherwise passive notice blocking just because a callback is supplied', () => {
        const notice: ToastItem = { id: 1, message: 'Saved', type: 'success', onPrint: vi.fn() };
        expect(isBlockingToast(notice)).toBe(false);
    });
});

describe('toast lifecycle', () => {
    it('keeps cashback/recovery instructions until acknowledged', () => {
        toast('Check whether cashback was already paid', 'error', false, undefined, { persistent: true });
        toast('Check whether cashback was already paid', 'error', false, undefined, { persistent: true });
        expect(get(toasts)).toHaveLength(1);
        vi.advanceTimersByTime(60_000);
        expect(get(toasts)).toHaveLength(1);
        removeToast(get(toasts)[0].id);
        expect(get(toasts)).toEqual([]);
    });
    it('expires passive notices after five seconds without removing active dialogs', () => {
        toast('Order saved', 'success');
        toast('Information', 'info');
        toast('Connection failed', 'error');
        toast('Print this receipt?', 'success', true, vi.fn());

        vi.advanceTimersByTime(4999);
        expect(get(toasts)).toHaveLength(4);

        vi.advanceTimersByTime(1);
        expect(get(toasts).map(item => item.message)).toEqual(['Connection failed', 'Print this receipt?']);
        expect(get(toasts).every(isBlockingToast)).toBe(true);

        vi.advanceTimersByTime(9999);
        expect(get(toasts)).toHaveLength(2);

        vi.advanceTimersByTime(1);
        expect(get(toasts)).toEqual([]);
    });

    it('deduplicates the same passive notice while preserving distinct notices', () => {
        toast('Order saved', 'success');
        toast('Order saved', 'success');
        toast('Order retrieved', 'success');
        expect(get(toasts).map(item => item.message)).toEqual(['Order saved', 'Order retrieved']);
    });

    it('keeps distinct receipt prompts and their print actions', () => {
        const firstPrint = vi.fn();
        const secondPrint = vi.fn();
        toast('Print this receipt?', 'success', true, firstPrint);
        toast('Print this receipt?', 'success', true, secondPrint);
        expect(get(toasts).map(item => item.onPrint)).toEqual([firstPrint, secondPrint]);
    });

    it('dismisses just the selected notice', () => {
        toast('Order saved');
        toast('Another order saved');
        removeToast(get(toasts)[0].id);
        expect(get(toasts).map(item => item.message)).toEqual(['Another order saved']);
    });
});

describe('cash completion confirmation', () => {
    it.each([0, 1, 1400, Number.MAX_SAFE_INTEGER])('recognises a successful cash sale with %s pence change', (cashChangePence) => {
        const completion = { type: 'success' as const, cashChangePence };
        expect(isCashCompletion(completion)).toBe(true);
        expect(isBlockingToast(completion)).toBe(true);
    });

    it.each([undefined, -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
        'does not turn invalid change metadata (%s) into a cash dialog', (cashChangePence) => {
            expect(isCashCompletion({ type: 'success', cashChangePence })).toBe(false);
            expect(isBlockingToast({ type: 'success', cashChangePence })).toBe(false);
            toast('Saved', 'success', false, undefined, { cashChangePence });
            expect(get(toasts)[0].cashChangePence).toBeUndefined();
            vi.advanceTimersByTime(5000);
            expect(get(toasts)).toEqual([]);
        },
    );

    it.each(['error', 'info'] as const)('ignores cash metadata attached to a %s message', (type) => {
        expect(isCashCompletion({ type, cashChangePence: 1400 })).toBe(false);
        toast('Not a completed sale', type, false, undefined, { cashChangePence: 1400 });
        expect(get(toasts)[0].cashChangePence).toBeUndefined();
        expect(isBlockingToast(get(toasts)[0])).toBe(type === 'error');
        vi.advanceTimersByTime(15000);
        expect(get(toasts)).toEqual([]);
    });

    it('keeps the change amount visible until the cashier explicitly acknowledges it', () => {
        toast('Cash payment saved', 'success', false, undefined, { cashChangePence: 1400 });
        const completion = get(toasts)[0];
        expect(completion.cashChangePence).toBe(1400);
        expect(vi.getTimerCount()).toBe(0);
        vi.advanceTimersByTime(24 * 60 * 60 * 1000);
        expect(get(toasts)).toEqual([completion]);
        removeToast(completion.id);
        expect(get(toasts)).toEqual([]);
    });

    it('also keeps exact-cash confirmations visible without treating zero as missing', () => {
        toast('Cash payment saved', 'success', false, undefined, { cashChangePence: 0 });
        vi.advanceTimersByTime(15000);
        expect(get(toasts)).toHaveLength(1);
        expect(get(toasts)[0].cashChangePence).toBe(0);
    });

    it('preserves the print action and persistent change amount on native receipt prompts', () => {
        const onPrint = vi.fn();
        toast('Cash payment saved', 'success', true, onPrint, { cashChangePence: 1400 });
        vi.advanceTimersByTime(15000);
        expect(get(toasts)).toHaveLength(1);
        expect(get(toasts)[0]).toMatchObject({ showPrint: true, onPrint, cashChangePence: 1400 });
    });

    it('does not deduplicate cash confirmations or merge them with passive success notices', () => {
        toast('Saved');
        toast('Saved', 'success', false, undefined, { cashChangePence: 1400 });
        toast('Saved', 'success', false, undefined, { cashChangePence: 1400 });
        toast('Saved');
        expect(get(toasts)).toHaveLength(3);
        expect(new Set(get(toasts).map(item => item.id)).size).toBe(3);
        vi.advanceTimersByTime(15000);
        expect(get(toasts)).toHaveLength(2);
        expect(get(toasts).every(isCashCompletion)).toBe(true);
    });

    it('does not suppress a passive notice that follows an identically worded cash confirmation', () => {
        toast('Saved', 'success', false, undefined, { cashChangePence: 1400 });
        toast('Saved');
        expect(get(toasts)).toHaveLength(2);
        expect(get(toasts).map(isBlockingToast)).toEqual([true, false]);
    });
});

describe('next-customer scan dismissal', () => {
    it.each([0, 1400])('dismisses an explicitly marked completed cash sale with %s pence change', (cashChangePence) => {
        toast('Sale completed', 'success', true, vi.fn(), { cashChangePence, dismissOnScan: true });
        expect(isScanDismissibleToast(get(toasts)[0])).toBe(true);
        dismissSaleCompletionOnScan();
        expect(get(toasts)).toEqual([]);
    });

    it('dismisses ordinary card completion without automatically printing its receipt', () => {
        const onPrint = vi.fn();
        toast('Sale completed', 'success', true, onPrint, { dismissOnScan: true });
        dismissSaleCompletionOnScan();
        expect(get(toasts)).toEqual([]);
        expect(onPrint).not.toHaveBeenCalled();
    });

    it('leaves an unrelated print/refund prompt and passive notification alone', () => {
        toast('Refund completed', 'success', true, vi.fn());
        toast('Sync finished');
        toast('Sale completed', 'success', true, vi.fn(), { dismissOnScan: true });
        dismissSaleCompletionOnScan();
        expect(get(toasts).map(item => item.message)).toEqual(['Refund completed', 'Sync finished']);
    });

    it.each(['error', 'info'] as const)('cannot opt a %s prompt into scan dismissal', (type) => {
        toast('Needs attention', type, true, undefined, { dismissOnScan: true });
        expect(isScanDismissibleToast(get(toasts)[0])).toBe(false);
        dismissSaleCompletionOnScan();
        expect(get(toasts)).toHaveLength(1);
    });

    it('never silently dismisses a persistent cashback payout or recovery warning', () => {
        toast('Give cashback £10', 'success', true, vi.fn(), { persistent: true, dismissOnScan: true });
        toast('Check whether cashback was already paid', 'error', false, undefined, { persistent: true });
        expect(get(toasts).some(isScanDismissibleToast)).toBe(false);
        dismissSaleCompletionOnScan();
        expect(get(toasts)).toHaveLength(2);
        vi.advanceTimersByTime(60_000);
        expect(get(toasts)).toHaveLength(2);
    });
});
