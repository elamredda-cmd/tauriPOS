import { goto } from '$app/navigation';

export function goBack(fallback = '/') {
    if (typeof window === 'undefined') return;

    // Tauri's webview history contains this app's internal navigation. A directly
    // opened page normally has no previous entry and therefore uses the fallback.
    if (window.history.length > 1) {
        window.history.back();
        return;
    }

    goto(fallback);
}
