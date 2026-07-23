import { goto } from '$app/navigation';

const CURRENT_APP_PATH_KEY = 'lbj_pos_current_app_path';
const HAS_APP_HISTORY_KEY = 'lbj_pos_has_app_history';

export function markAppNavigation(pathname: string) {
    if (typeof window === 'undefined' || !pathname) return;
    const previousPath = sessionStorage.getItem(CURRENT_APP_PATH_KEY);
    if (previousPath && previousPath !== pathname) {
        sessionStorage.setItem(HAS_APP_HISTORY_KEY, '1');
    }
    sessionStorage.setItem(CURRENT_APP_PATH_KEY, pathname);
}

export function goBack(fallback = '/') {
    if (typeof window === 'undefined') return;

    // Browser/WebView history may contain an external bootstrap entry such as
    // about:blank. Only trust SvelteKit's index after this tab has observed an
    // actual route change inside the POS.
    const appHistoryIndex = Number(window.history.state?.['sveltekit:history']);
    const hasAppHistory = sessionStorage.getItem(HAS_APP_HISTORY_KEY) === '1';
    if (hasAppHistory && Number.isFinite(appHistoryIndex) && appHistoryIndex > 0) {
        window.history.back();
        return;
    }

    goto(fallback);
}
