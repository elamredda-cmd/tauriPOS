import { tick } from 'svelte';
import { writable } from 'svelte/store';
import { isTauri } from '@tauri-apps/api/core';
import type { Order, OrderLine, Store } from '$lib/stores/db';
import type { ReceiptDesign } from '$lib/receipt';
import type { ReceiptPayment } from '$lib/receiptPayments';

export interface SystemReceiptPayload {
    store: Store;
    order: Order;
    lines: OrderLine[];
    payments?: Array<Partial<ReceiptPayment>>;
    cashierName: string;
    tillName: string;
    design: ReceiptDesign;
}

export type SystemPrintJob =
    | { kind: 'receipt'; payload: SystemReceiptPayload }
    | { kind: 'text'; title: string; text: string; paperWidth: '58mm' | '80mm' };

export const systemPrintJob = writable<SystemPrintJob | null>(null);

let printQueue: Promise<void> = Promise.resolve();

/** Switch away from the retained receipt/report snapshot before a page-label print. */
export function clearSystemPrintSnapshot(): void {
    if (typeof document !== 'undefined') document.body.classList.remove('system-printing');
    systemPrintJob.set(null);
}

function nextPaint(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function runSystemPrint(job: SystemPrintJob): Promise<void> {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
        throw new Error('System printing is only available in the app window');
    }

    const retainNativeSnapshot = isTauri();
    // On macOS the native promise only confirms that the sheet was requested,
    // not that it closed. Keep one frozen document until the next print job.
    try {
        systemPrintJob.set(job);
        document.body.classList.add('system-printing');
        await tick();
        await nextPaint();
        await Promise.resolve(window.print());
    } catch (error) {
        clearSystemPrintSnapshot();
        throw error;
    } finally {
        // Browser printing is synchronous. Native printing may still be
        // preparing a preview after its invocation has resolved.
        if (!retainNativeSnapshot) clearSystemPrintSnapshot();
    }
}

function enqueueSystemPrint(job: SystemPrintJob): Promise<void> {
    // Freeze when submitted, not after an earlier queued document finishes.
    const submitted = structuredClone(job);
    const queued = printQueue.then(() => runSystemPrint(submitted));
    printQueue = queued.catch(() => undefined);
    return queued;
}

export function printSystemReceipt(payload: SystemReceiptPayload): Promise<void> {
    return enqueueSystemPrint({ kind: 'receipt', payload });
}

export function printSystemText(
    title: string,
    text: string,
    paperWidth: '58mm' | '80mm' = '80mm'
): Promise<void> {
    return enqueueSystemPrint({ kind: 'text', title, text, paperWidth });
}
