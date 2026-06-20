import { writable } from 'svelte/store';

export interface ToastItem {
    id: number;
    message: string;
    type: 'success' | 'error' | 'info';
    showPrint?: boolean;
    onPrint?: () => void | Promise<void>;
}

export const toasts = writable<ToastItem[]>([]);
let counter = 0;

export function toast(
    message: string,
    type: 'success' | 'error' | 'info' = 'success',
    showPrint: boolean = false,
    onPrint?: ToastItem['onPrint'],
) {
    const id = ++counter;
    toasts.update(t => [...t, { id, message, type, showPrint, onPrint }]);
    setTimeout(() => removeToast(id), 15000);
}

export function removeToast(id: number) {
    toasts.update(t => t.filter(x => x.id !== id));
}
