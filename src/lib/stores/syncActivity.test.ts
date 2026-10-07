import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get, writable } from 'svelte/store';
import { beginSyncActivity, createSyncStatus, describeSync, recordSyncResult, syncActivity, type SyncActivity } from './syncActivity';
import type { PosConnectionState } from './connection';
const connected: PosConnectionState = { mode: 'multi', mysqlConfig: null, mysqlOnline: true, mysqlReady: true, mysqlStatus: 'online', syncError: null };
const idle: SyncActivity = { running: 0, lastSuccessAt: null, pending: 0, conflicts: 0, error: null };
describe('operator sync indication', () => {
    beforeEach(() => syncActivity.set({ ...idle }));
    it('does not claim local-only devices are syncing', () => expect(describeSync({ ...connected, mode: 'single' }, { ...idle, running: 1 }).label).toBe('Local mode'));
    it('distinguishes connecting, unavailable and ready connections', () => {
        expect(describeSync({ ...connected, mysqlStatus: 'pending' }, idle).label).toBe('Connecting');
        expect(describeSync({ ...connected, mysqlOnline: false }, idle).label).toBe('Offline');
        expect(describeSync({ ...connected, mysqlOnline: false, mysqlStatus: 'blocked' }, idle).label).toBe('Sync blocked');
        expect(describeSync({ ...connected, mysqlReady: false }, idle).label).toBe('Not ready');
        expect(describeSync(connected, idle).label).toBe('Connected');
    });
    it('only reports synced following success with a checked empty queue', () => {
        expect(describeSync(connected, { ...idle, lastSuccessAt: 100, pending: null }).label).toBe('Connected');
        expect(describeSync(connected, { ...idle, lastSuccessAt: 100 }).label).toBe('Synced');
        expect(describeSync(connected, { ...idle, lastSuccessAt: 100, pending: 3 }).label).toBe('3 pending');
    });
    it('keeps conflicts and partial failures visible', () => {
        expect(describeSync(connected, { ...idle, conflicts: 1 }).label).toBe('Sync issue');
        expect(describeSync(connected, { ...idle, error: 'Partial pull' }).label).toBe('Sync issue');
    });
    it('tracks overlapping uploads and downloads until both finish', () => {
        const a = beginSyncActivity(), b = beginSyncActivity();
        expect(get(syncActivity).running).toBe(2);
        a(); a();
        expect(get(syncActivity).running).toBe(1);
        expect(describeSync(connected, get(syncActivity)).label).toBe('Syncing');
        b('Download failed');
        expect(get(syncActivity).running).toBe(0);
        expect(describeSync(connected, get(syncActivity)).label).toBe('Sync issue');
    });
});

describe('calm sync presentation', () => {
    afterEach(() => vi.useRealTimers());
    it('does not flash for brief transfers and uses the same green for longer transfers', () => {
        vi.useFakeTimers();
        const connection = writable(connected);
        const progress = writable({ ...idle, lastSuccessAt: 100 });
        const statuses: ReturnType<typeof describeSync>[] = [];
        const stop = createSyncStatus(connection, progress).subscribe(s => statuses.push(s));
        progress.update(s => ({ ...s, running: 1 }));
        vi.advanceTimersByTime(500);
        progress.update(s => ({ ...s, running: 0 }));
        expect(statuses.map(s => s.label)).toEqual(['Synced']);
        expect(vi.getTimerCount()).toBe(0);
        progress.update(s => ({ ...s, running: 1 }));
        vi.advanceTimersByTime(1_000);
        expect(statuses.at(-1)?.label).toBe('Syncing');
        expect(statuses.at(-1)?.tone).toBe(statuses[0].tone);
        progress.update(s => ({ ...s, running: 0 }));
        expect(statuses.at(-1)?.label).toBe('Synced');
        stop();
        expect(vi.getTimerCount()).toBe(0);
    });
    it('shows errors and disconnection immediately, even during a transfer', () => {
        vi.useFakeTimers();
        const connection = writable(connected);
        const progress = writable({ ...idle, lastSuccessAt: 100, running: 1 });
        let label = '';
        const stop = createSyncStatus(connection, progress).subscribe(s => { label = s.label; });
        progress.update(s => ({ ...s, conflicts: 1 }));
        expect(label).toBe('Sync issue');
        vi.advanceTimersByTime(1_000);
        expect(label).toBe('Sync issue');
        connection.update(s => ({ ...s, mysqlOnline: false }));
        expect(label).toBe('Offline');
        stop();
    });
    it('shares one timer between indicators and cleans it up on unmount', () => {
        vi.useFakeTimers();
        const progress = writable({ ...idle, running: 1 });
        const status = createSyncStatus(writable(connected), progress);
        const a = status.subscribe(() => {}), b = status.subscribe(() => {});
        expect(vi.getTimerCount()).toBe(1);
        a();
        expect(vi.getTimerCount()).toBe(1);
        b();
        expect(vi.getTimerCount()).toBe(0);
    });
    it('records no-change checks without reporting a running transfer', () => {
        syncActivity.set({ ...idle });
        const running: number[] = [];
        const stop = syncActivity.subscribe(s => running.push(s.running));
        recordSyncResult('change', null, true);
        expect(running.every(n => n === 0)).toBe(true);
        expect(get(syncActivity).lastSuccessAt).toBeTruthy();
        stop();
    });
});
