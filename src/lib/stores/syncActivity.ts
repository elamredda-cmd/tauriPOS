import { readable, writable, type Readable } from 'svelte/store';
import { connectionState, type PosConnectionState } from './connection';

export interface SyncActivity {
    running: number;
    lastSuccessAt: number | null;
    error: string | null;
    pending: number | null;
    conflicts: number;
}
export const syncActivity = writable<SyncActivity>({ running: 0, lastSuccessAt: null, error: null, pending: null, conflicts: 0 });
type SyncSource = 'change' | 'fast' | 'full' | 'upload' | 'default';
const errors = new Map<SyncSource, string>();

/** A cursor check can succeed without starting a visible transfer. */
export function recordSyncResult(source: SyncSource, error: string | null, success: boolean, completedActivity = false) {
    if (error) errors.set(source, error);
    else if (success) {
        errors.delete(source);
        if (source === 'full') { errors.delete('change'); errors.delete('fast'); }
    }
    syncActivity.update(s => ({ ...s,
        running: Math.max(0, s.running - (completedActivity ? 1 : 0)),
        error: [...errors.values()].join(' ') || null,
        lastSuccessAt: success && !error && source !== 'upload' ? Date.now() : s.lastSuccessAt,
    }));
}
export function beginSyncActivity(source: SyncSource = 'default') {
    syncActivity.update(s => ({ ...s, running: s.running + 1 }));
    let finished = false;
    return (error: string | null = null, success = true) => {
        if (finished) return;
        finished = true;
        recordSyncResult(source, error, success, true);
    };
}
export function describeSync(connection: PosConnectionState, activity: SyncActivity) {
    if (connection.mode === 'single') return { label: 'Local mode', tone: 'neutral', detail: 'This device uses its local database. Device syncing is off.' };
    if (!connection.mode || connection.mysqlStatus === 'pending') return { label: 'Connecting', tone: 'waiting', detail: 'Checking the shared database connection.' };
    if (connection.mysqlStatus === 'blocked') return { label: 'Sync blocked', tone: 'error', detail: 'Sync requires attention before it can continue. Review Sync in administration.' };
    if (!connection.mysqlOnline) return { label: 'Offline', tone: 'error', detail: 'Shared database disconnected. Changes will sync when the connection returns.' };
    if (!connection.mysqlReady) return { label: 'Not ready', tone: 'waiting', detail: connection.syncError || 'Preparing shared database sync.' };
    if (connection.syncError || activity.error || activity.conflicts) return { label: 'Sync issue', tone: 'error', detail: activity.conflicts ? `${activity.conflicts} sync conflict(s) need attention.` : 'Sync needs attention. Open Sync from administration for details.' };
    if (activity.running) return { label: 'Syncing', tone: 'success', detail: 'Exchanging changes with the shared database.' };
    if (activity.pending) return { label: `${activity.pending} pending`, tone: 'waiting', detail: `${activity.pending} local changes are waiting to sync.` };
    if (activity.lastSuccessAt && activity.pending === 0) return { label: 'Synced', tone: 'success', detail: `Last successful sync: ${new Date(activity.lastSuccessAt).toLocaleTimeString()}. No local changes pending.` };
    return { label: 'Connected', tone: 'neutral', detail: 'Shared database connected. Waiting for a completed sync check.' };
}

/** Shared presentation timer, only while a real transfer is running; no polling. */
export function createSyncStatus(connection: Readable<PosConnectionState>, activity: Readable<SyncActivity>) {
    return readable<ReturnType<typeof describeSync>>(undefined, set => {
        let state: PosConnectionState;
        let progress: SyncActivity;
        let busyVisible = false;
        let busyTimer: ReturnType<typeof setTimeout> | null = null;
        let last: ReturnType<typeof describeSync> | undefined;
        function publish() {
            if (!state || !progress) return;
            const status = describeSync(state, { ...progress, running: busyVisible ? progress.running : 0 });
            if (status.label !== last?.label || status.tone !== last?.tone || status.detail !== last?.detail) {
                last = status;
                set(status);
            }
        }
        const unsubscribeConnection = connection.subscribe(value => { state = value; publish(); });
        const unsubscribeActivity = activity.subscribe(value => {
            progress = value;
            if (value.running && !busyVisible && !busyTimer) {
                busyTimer = setTimeout(() => { busyTimer = null; busyVisible = true; publish(); }, 1_000);
            } else if (!value.running) {
                if (busyTimer) clearTimeout(busyTimer);
                busyTimer = null;
                busyVisible = false;
            }
            publish();
        });
        return () => {
            unsubscribeConnection();
            unsubscribeActivity();
            if (busyTimer) clearTimeout(busyTimer);
        };
    });
}
export const syncStatus = createSyncStatus(connectionState, syncActivity);
