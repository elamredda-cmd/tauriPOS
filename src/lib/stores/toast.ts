import { writable } from 'svelte/store';

interface ToastItem { id: number; message: string; type: 'success' | 'error' | 'info'; showPrint?: boolean; }

export const toasts = writable<ToastItem[]>([]);
let counter = 0;

export function toast(message: string, type: 'success' | 'error' | 'info' = 'success', showPrint: boolean = false) {
    const id = ++counter;
    toasts.update(t => [...t, { id, message, type, showPrint }]);
    setTimeout(() => removeToast(id), 15000);
}

export function removeToast(id: number) {
    toasts.update(t => t.filter(x => x.id !== id));
}
