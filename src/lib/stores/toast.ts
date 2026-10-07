import { writable } from 'svelte/store';

export interface ToastItem {
    id: number;
    message: string;
    type: 'success' | 'error' | 'info';
    showPrint?: boolean;
    onPrint?: () => void | Promise<void>;
    cashChangePence?: number;
    /** Financial instructions must remain until explicitly acknowledged. */
    persistent?: boolean;
    /** Only a completed checkout sale may hand the scanner to the next customer. */
    dismissOnScan?: boolean;
}

export function isCashCompletion(item: Pick<ToastItem, 'type' | 'cashChangePence'>): boolean {
    return item.type === 'success' && Number.isSafeInteger(item.cashChangePence) && item.cashChangePence! >= 0;
}

export function isBlockingToast(item: Pick<ToastItem, 'type' | 'showPrint' | 'cashChangePence'>): boolean {
    return item.type === 'error' || item.showPrint === true || isCashCompletion(item);
}

export function isScanDismissibleToast(item: Pick<ToastItem, 'type' | 'dismissOnScan' | 'persistent'>): boolean {
    return item.type === 'success' && item.dismissOnScan === true && item.persistent !== true;
}

export const toasts = writable<ToastItem[]>([]);
let counter = 0;

export function toast(
    message: string,
    type: 'success' | 'error' | 'info' = 'success',
    showPrint: boolean = false,
    onPrint?: ToastItem['onPrint'],
    details: Pick<ToastItem, 'cashChangePence' | 'persistent' | 'dismissOnScan'> = {},
) {
    const cashChangePence = isCashCompletion({ type, cashChangePence: details.cashChangePence })
        ? details.cashChangePence : undefined;
    const cashCompletion = isCashCompletion({ type, cashChangePence });
    let id: number | null = null;
    toasts.update((current) => {
        const isDuplicate = !cashCompletion && !showPrint && !onPrint && current.some((item) =>
            !isCashCompletion(item) &&
            !item.showPrint && !item.onPrint && item.type === type && item.message === message
        );
        if (isDuplicate) return current;

        id = ++counter;
        return [...current, { id, message, type, showPrint, onPrint, cashChangePence, persistent: details.persistent,
            dismissOnScan: isScanDismissibleToast({ type, ...details }) }];
    });
    // Keep cash change visible until acknowledged (or the next scan on checkout).
    if (id !== null && !cashCompletion && !details.persistent) setTimeout(() => removeToast(id!), isBlockingToast({ type, showPrint }) ? 15000 : 5000);
}

export function removeToast(id: number) {
    toasts.update(t => t.filter(x => x.id !== id));
}

/** Never dismiss an error, refund confirmation, or unacknowledged cashback payout. */
export function dismissSaleCompletionOnScan() {
    toasts.update(current => current.filter(item => !isScanDismissibleToast(item)));
}
