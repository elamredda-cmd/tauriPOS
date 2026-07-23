import { tick } from 'svelte';
import { writable } from 'svelte/store';
import type { Order, OrderLine, Store } from '$lib/stores/db';
import type { ReceiptDesign } from '$lib/receipt';

export interface SystemReceiptPayload {
    store: Store;
    order: Order;
    lines: OrderLine[];
    cashierName: string;
    tillName: string;
    design: ReceiptDesign;
}

export type SystemPrintJob =
    | { kind: 'receipt'; payload: SystemReceiptPayload }
    | { kind: 'text'; title: string; text: string; paperWidth: '58mm' | '80mm' };

export const systemPrintJob = writable<SystemPrintJob | null>(null);

let printQueue: Promise<void> = Promise.resolve();

function nextPaint(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function runSystemPrint(job: SystemPrintJob): Promise<void> {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
        throw new Error('System printing is only available in the app window');
    }

    systemPrintJob.set(job);
    document.body.classList.add('system-printing');
    try {
        await tick();
        await nextPaint();
        window.print();
    } finally {
        document.body.classList.remove('system-printing');
        systemPrintJob.set(null);
    }
}

function enqueueSystemPrint(job: SystemPrintJob): Promise<void> {
    const queued = printQueue.then(() => runSystemPrint(job));
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
