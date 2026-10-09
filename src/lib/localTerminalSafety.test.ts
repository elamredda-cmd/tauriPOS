import { DatabaseSync } from 'node:sqlite';
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({
    invoke: vi.fn(), getDb: vi.fn(), getMysqlDb: vi.fn(), ping: vi.fn(),
    marker: vi.fn(), barrier: vi.fn(), notify: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', async original => ({
    ...await original<typeof import('@tauri-apps/api/core')>(),
    isTauri: () => true, invoke: boundary.invoke,
}));
vi.mock('$lib/stores/sqlite', async original => ({
    ...await original<typeof import('$lib/stores/sqlite')>(),
    getDb: boundary.getDb, getLastReportMarker: boundary.marker,
}));
vi.mock('$lib/stores/connection', async original => ({
    ...await original<typeof import('$lib/stores/connection')>(),
    getMysqlDb: boundary.getMysqlDb, pingMysql: boundary.ping,
}));
vi.mock('$lib/stores/mysql', async original => ({
    ...await original<typeof import('$lib/stores/mysql')>(),
    mysqlGetWholeSystemCloseBarrier: boundary.barrier,
}));
vi.mock('$lib/ownerCloudEvents', () => ({ notifyOwnerCloudDataChanged: boundary.notify }));

import {
    commitPreparedTerminalSale, saveReportMarker, withCurrentReportEpoch, withLocalTerminalPreparation,
    type SaleBundle,
} from '$lib/stores/database';
import { connectionState, type PosConnectionState } from '$lib/stores/connection';

const epoch = '2026-10-01T12:00:00.000Z';
function sale(overrides: Partial<SaleBundle> = {}): SaleBundle {
    return {
        order: { id: 'local-card-sale', type: 'sale', tillNumber: 'till-one' },
        payment: { id: 'card-payment', orderId: 'local-card-sale', method: 'card', amount: 100, cardAmount: 100 },
        lines: [], stockChanges: [], audit: { id: 'card-sale-audit' },
        reportEpoch: epoch, serverDataEpoch: 'dataset-fixture', ...overrides,
    } as unknown as SaleBundle;
}

describe('dedicated terminal database and close safety (isolated SQLite, mocked native boundary)', () => {
    let db: DatabaseSync;
    let originalConnection: PosConnectionState;

    beforeEach(() => {
        vi.clearAllMocks();
        originalConnection = get(connectionState);
        db = new DatabaseSync(':memory:');
        db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updatedAt TEXT);
            CREATE TABLE _offline_queue (id TEXT PRIMARY KEY, table_name TEXT, operation TEXT, data TEXT,
                created_at TEXT, attempt_count INTEGER DEFAULT 0, next_attempt_at TEXT DEFAULT '', last_error TEXT DEFAULT '');
            CREATE TABLE _sync_conflicts (id TEXT PRIMARY KEY, table_name TEXT, operation TEXT);
            CREATE TABLE _online_financial_intent (id TEXT PRIMARY KEY);
            CREATE TABLE payment_terminal_attempts (id TEXT PRIMARY KEY, tillId TEXT, status TEXT);`);
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('report_epoch_cache', epoch);
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('server_data_epoch_seen', 'dataset-fixture');
        boundary.getDb.mockResolvedValue({
            select: async (sql: string, params: any[] = []) => db.prepare(sql).all(...params),
            execute: async (sql: string, params: any[] = []) => ({ rowsAffected: Number(db.prepare(sql).run(...params).changes) }),
        });
        boundary.marker.mockResolvedValue(epoch);
        boundary.getMysqlDb.mockRejectedValue(new Error('Test has no MariaDB connection'));
        boundary.ping.mockResolvedValue(false);
        boundary.barrier.mockRejectedValue(new Error('Test has no shared close barrier'));
        boundary.invoke.mockImplementation(async (command: string, input: any) => {
            if (command === 'commit_local_sale') return { bundle: input.bundle };
            throw new Error(`Unexpected native command in isolated test: ${command}`);
        });
        connectionState.set({ mode: 'multi', mysqlOnline: false, mysqlReady: false,
            mysqlConfig: null, syncError: null });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(async () => {
        // Drain rejected background-sync microtasks before closing the test DB.
        await new Promise(resolve => setTimeout(resolve, 0));
        db.close();
        connectionState.set(originalConnection);
        vi.restoreAllMocks();
    });

    it.each([false, true])('stamps local epochs without querying MariaDB when mysqlOnline=%s', async mysqlOnline => {
        connectionState.update(state => ({ ...state, mysqlOnline }));
        const original: Partial<SaleBundle> = { order: { id: 'test' } as any };
        const prepared = await withCurrentReportEpoch(original, { localOnly: true });
        expect(prepared).toMatchObject({ reportEpoch: epoch, serverDataEpoch: 'dataset-fixture' });
        expect(original).toEqual({ order: { id: 'test' } });
        expect(boundary.getMysqlDb).not.toHaveBeenCalled();
        expect(boundary.barrier).not.toHaveBeenCalled();
    });

    it('does not relabel an already prepared card payment with a newer dataset or report period', async () => {
        const prepared = sale({ reportEpoch: '2026-09-01T12:00:00.000Z', serverDataEpoch: 'original-dataset' });
        expect(await withCurrentReportEpoch(prepared, { localOnly: true })).toEqual(prepared);
        expect(boundary.getMysqlDb).not.toHaveBeenCalled();
    });

    it('does not invent a dataset identity for an uninitialized shared shop while offline', async () => {
        db.prepare('DELETE FROM settings WHERE key = ?').run('server_data_epoch_seen');
        await expect(withCurrentReportEpoch({}, { localOnly: true })).rejects.toThrow(/epoch|dataset|sync/i);
        expect(boundary.getMysqlDb).not.toHaveBeenCalled();
    });

    it('rejects conflicting local-only and live-server epoch requirements', async () => {
        await expect(withCurrentReportEpoch({}, { localOnly: true, requireLiveServerDataEpoch: true }))
            .rejects.toThrow(/local|server|epoch/i);
        expect(boundary.getMysqlDb).not.toHaveBeenCalled();
    });

    it('rejects a pre-stamped local payment with a blank shared dataset identity before native commit', async () => {
        const prepared = sale({ serverDataEpoch: '  ' });
        await expect(withCurrentReportEpoch(prepared, { localOnly: true }))
            .rejects.toThrow(/database identity/i);
        await expect(commitPreparedTerminalSale(prepared, { journalScope: 'local' }))
            .rejects.toThrow(/database identity/i);
        expect(boundary.invoke).not.toHaveBeenCalled();
        expect(boundary.getMysqlDb).not.toHaveBeenCalled();
    });

    it('allows standalone preparation with no shared database configuration', async () => {
        connectionState.update(state => ({ ...state, mode: 'single' }));
        const persist = vi.fn(async () => 'durable-local-attempt');
        await expect(withLocalTerminalPreparation(persist)).resolves.toBe('durable-local-attempt');
        expect(persist).toHaveBeenCalledOnce();
        expect(boundary.getMysqlDb).not.toHaveBeenCalled();
        expect(boundary.barrier).not.toHaveBeenCalled();
    });

    it('allows dedicated-terminal preparation while a shared shop database is offline', async () => {
        const persist = vi.fn(async () => 'durable-local-attempt');
        await expect(withLocalTerminalPreparation(persist)).resolves.toBe('durable-local-attempt');
        expect(persist).toHaveBeenCalledOnce();
        expect(boundary.getMysqlDb).not.toHaveBeenCalled();
        expect(boundary.barrier).not.toHaveBeenCalled();
    });

    it.each(['preparing', 'frozen'])('does not start a new card request after observing a %s close, even offline', async state => {
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
            'local_terminal_close_barrier', JSON.stringify({ state, token: 'close-fixture' }),
        );
        const persist = vi.fn();
        await expect(withLocalTerminalPreparation(persist)).rejects.toThrow(/close|closing|paused/i);
        expect(persist).not.toHaveBeenCalled();
        expect(boundary.getMysqlDb).not.toHaveBeenCalled();
    });

    it('does not bypass a pending database restore to prepare a new card request', async () => {
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('restore_pending_mariadb_replace', '1');
        const persist = vi.fn();
        await expect(withLocalTerminalPreparation(persist)).rejects.toThrow(/restore/i);
        expect(persist).not.toHaveBeenCalled();
    });

    it('treats an explicitly cleared restore flag as cleared, matching native recovery', async () => {
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('restore_pending_mariadb_replace', '0');
        const persist = vi.fn(async () => 'prepared');
        await expect(withLocalTerminalPreparation(persist)).resolves.toBe('prepared');
        expect(persist).toHaveBeenCalledOnce();
    });

    it('fails closed when a saved close fence is malformed', async () => {
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('local_terminal_close_barrier', '{broken');
        const persist = vi.fn();
        await expect(withLocalTerminalPreparation(persist)).rejects.toThrow(/close|barrier|invalid|verify/i);
        expect(persist).not.toHaveBeenCalled();
    });

    it('serializes terminal preparation so a readiness check cannot overtake durable preparation', async () => {
        let release!: () => void;
        const firstGate = new Promise<void>(resolve => { release = resolve; });
        const events: string[] = [];
        const first = withLocalTerminalPreparation(async () => {
            events.push('first-entered');
            await firstGate;
            events.push('first-durable');
        });
        const second = withLocalTerminalPreparation(async () => { events.push('second-entered'); });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(events).toEqual(['first-entered']);
        release();
        await Promise.all([first, second]);
        expect(events).toEqual(['first-entered', 'first-durable', 'second-entered']);
    });

    it('recovers a standalone card sale locally without an unnecessary sync queue', async () => {
        connectionState.update(state => ({ ...state, mode: 'single' }));
        const prepared = sale();
        await expect(commitPreparedTerminalSale(prepared, { journalScope: 'local' })).resolves.toEqual(prepared);
        expect(boundary.invoke).toHaveBeenCalledExactlyOnceWith('commit_local_sale', { bundle: prepared, outboxId: null });
        expect(boundary.getMysqlDb).not.toHaveBeenCalled();
    });

    it('finishes an ordinary offline multi-till card sale through the atomic local sale-and-outbox command', async () => {
        const prepared = sale();
        await expect(commitPreparedTerminalSale(prepared, { journalScope: 'local' })).resolves.toEqual(prepared);
        expect(boundary.invoke).toHaveBeenCalledExactlyOnceWith('commit_local_sale', {
            bundle: prepared, outboxId: expect.any(String),
        });
        expect(boundary.invoke.mock.calls[0][1].outboxId).not.toBe('');
        expect(boundary.barrier).not.toHaveBeenCalled();
    });

    it('reuses one stable sale outbox identity when recovery retries the same approved payment', async () => {
        const prepared = sale();
        await commitPreparedTerminalSale(prepared, { journalScope: 'local' });
        await commitPreparedTerminalSale(prepared, { journalScope: 'local' });
        expect(boundary.invoke.mock.calls.map(call => call[1].outboxId))
            .toEqual(['terminal-sale:local-card-sale', 'terminal-sale:local-card-sale']);
    });

    it('does not report a failed native atomic commit as a completed local sale', async () => {
        boundary.invoke.mockRejectedValue(new Error('disk transaction rolled back'));
        await expect(commitPreparedTerminalSale(sale(), { journalScope: 'local' }))
            .rejects.toThrow('disk transaction rolled back');
        expect(boundary.notify).not.toHaveBeenCalled();
    });

    it('keeps a legacy shared attempt blocked when its authoritative database cannot be checked', async () => {
        await expect(commitPreparedTerminalSale(sale(), { journalScope: 'shared' })).rejects.toThrow(/MariaDB|shared/i);
        expect(boundary.invoke).not.toHaveBeenCalled();
    });

    it('does not downgrade a legacy shared approval after switching the POS to standalone mode', async () => {
        connectionState.update(state => ({ ...state, mode: 'single' }));
        await expect(commitPreparedTerminalSale(sale(), { journalScope: 'shared' })).rejects.toThrow(/MariaDB|shared/i);
        expect(boundary.invoke).not.toHaveBeenCalled();
    });

    it('keeps an approved local payment recoverable while the reporting period is frozen', async () => {
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
            'local_terminal_close_barrier', JSON.stringify({ state: 'frozen', token: 'close-fixture' }),
        );
        await expect(commitPreparedTerminalSale(sale(), { journalScope: 'local' })).rejects.toThrow(/close|closing|paused/i);
        expect(boundary.invoke).not.toHaveBeenCalled();
    });

    it('can finish a pre-existing local approval during preparing, so the close can drain it', async () => {
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
            'local_terminal_close_barrier', JSON.stringify({ state: 'preparing', token: 'close-fixture' }),
        );
        const prepared = sale();
        await expect(commitPreparedTerminalSale(prepared, { journalScope: 'local' })).resolves.toEqual(prepared);
        expect(boundary.invoke).toHaveBeenCalledExactlyOnceWith('commit_local_sale', {
            bundle: prepared, outboxId: expect.any(String),
        });
    });

    it.each(['prepared', 'started', 'uncertain', 'approved', 'commit_failed', 'completion_pending'])(
        'does not close a standalone Z reporting period while a %s local card payment remains', async status => {
            connectionState.update(state => ({ ...state, mode: 'single' }));
            db.prepare('INSERT INTO payment_terminal_attempts VALUES (?, ?, ?)').run('unresolved', 'till-one', status);
            await expect(saveReportMarker('till-one', epoch, '2026-10-02T12:00:00.000Z'))
                .rejects.toThrow(/card|terminal|recover/i);
            expect(boundary.invoke).not.toHaveBeenCalled();
        },
    );

    it('does not let an old attempt with an unknown till escape the local Z-close protection', async () => {
        connectionState.update(state => ({ ...state, mode: 'single' }));
        db.prepare('INSERT INTO payment_terminal_attempts VALUES (?, ?, ?)').run('legacy', '', 'uncertain');
        await expect(saveReportMarker('till-one', epoch, '2026-10-02T12:00:00.000Z'))
            .rejects.toThrow(/card|terminal|recover/i);
        expect(boundary.invoke).not.toHaveBeenCalled();
    });

    it.each([
        { name: 'refund', input: () => sale({ order: { id: 'local-card-sale', type: 'return' } as any }) },
        { name: 'customer-account sale', input: () => sale({ accountChanges: [{ id: 'account-change' }] as any }) },
        { name: 'loyalty redemption', input: () => sale({ loyaltyChanges: [{ reason: 'redeemed', pointsChange: -100 }] as any }) },
    ])('does not weaken shared financial authority for an offline $name', async ({ input }) => {
        await expect(commitPreparedTerminalSale(input(), { journalScope: 'local' })).rejects.toThrow(/MariaDB|online/i);
        expect(boundary.invoke).not.toHaveBeenCalled();
    });
});
