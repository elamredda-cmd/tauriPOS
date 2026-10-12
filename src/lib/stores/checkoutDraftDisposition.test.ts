import { DatabaseSync } from 'node:sqlite';
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ local: vi.fn(), remote: vi.fn() }));
vi.mock('./sqlite', async original => ({
    ...await original<typeof import('./sqlite')>(), getDb: native.local,
}));
vi.mock('./mysql', async original => ({
    ...await original<typeof import('./mysql')>(), getDb: native.remote,
}));

import { checkoutDraftDisposition, heldRecoverySaleCompleted } from './database';
import { connectionState, type PosConnectionState } from './connection';

function fixture() {
    const db = new DatabaseSync(':memory:');
    db.exec(`
        CREATE TABLE orders (id TEXT PRIMARY KEY, status TEXT);
        CREATE TABLE tombstones (table_name TEXT, row_id TEXT);
        CREATE TABLE _online_financial_intent (orderId TEXT);
        CREATE TABLE payment_terminal_attempts (
            id TEXT PRIMARY KEY, provider TEXT, status TEXT, journalScope TEXT,
            error TEXT, operationKind TEXT, terminalKey TEXT,
            clientTransactionId TEXT, terminalSessionId TEXT, amount INTEGER, currency TEXT
        );
    `);
    const select = vi.fn(async (sql: string, parameters: any[] = []) => db.prepare(sql).all(...parameters));
    return { db, select };
}

type Fixture = ReturnType<typeof fixture>;
let local: Fixture;
let remote: Fixture;
let previousConnection: PosConnectionState;

function attempt(target: Fixture, values: Record<string, any> = {}) {
    const row = {
        id: 'sale-1', provider: 'dojo', status: 'failed', journalScope: 'local',
        error: 'Dojo status: Declined', operationKind: 'sale', terminalKey: 'dojo:test-terminal',
        clientTransactionId: 'pi_sandbox_test', terminalSessionId: 'session-1', amount: 175, currency: 'GBP',
        ...values,
    };
    target.db.prepare(`INSERT INTO payment_terminal_attempts
        (id, provider, status, journalScope, error, operationKind, terminalKey,
         clientTransactionId, terminalSessionId, amount, currency)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(...Object.values(row));
}

function multi(online = false) {
    connectionState.set({
        mode: 'multi', mysqlOnline: online, mysqlReady: online, syncError: null,
        mysqlConfig: { host: 'test.invalid', port: 3306, database: 'test', user: 'test', password: '' },
    });
}

beforeEach(() => {
    previousConnection = get(connectionState);
    local = fixture(); remote = fixture();
    native.local.mockReset().mockResolvedValue(local);
    native.remote.mockReset().mockResolvedValue(remote);
    connectionState.set({ mode: 'single', mysqlOnline: false, mysqlReady: false, mysqlConfig: null, syncError: null });
});
afterEach(() => {
    connectionState.set(previousConnection);
    local.db.close(); remote.db.close();
});

describe('held trolley recovery uses the same payment proof', () => {
    it('keeps the no-attempt shortcut independent of database availability', async () => {
        multi();
        await expect(heldRecoverySaleCompleted([])).resolves.toBe(false);
        expect(native.local).not.toHaveBeenCalled();
        expect(native.remote).not.toHaveBeenCalled();
    });

    it('permits a proven dedicated decline while MariaDB is offline', async () => {
        multi(); attempt(local);
        await expect(heldRecoverySaleCompleted(['sale-1'])).resolves.toBe(false);
        expect(native.remote).not.toHaveBeenCalled();
    });

    it.each(['', 'Dojo status: UNSUCCESSFUL', 'Cancelled by an unverified request'])('does not release a generic cancelled hold with evidence %s', async error => {
        attempt(local, { status: 'cancelled', error });
        await expect(heldRecoverySaleCompleted(['sale-1'])).rejects.toThrow('interrupted payment');
    });

    it('consumes a held trolley with a locally completed receipt while offline', async () => {
        multi();
        local.db.prepare('INSERT INTO orders VALUES (?, ?)').run('sale-1', 'completed');
        await expect(heldRecoverySaleCompleted(['sale-1'])).resolves.toBe(true);
        expect(native.remote).not.toHaveBeenCalled();
    });

    it('does not release a shared declined hold using only cached evidence', async () => {
        multi(); attempt(local, { journalScope: 'shared' });
        await expect(heldRecoverySaleCompleted(['sale-1'])).rejects.toThrow('original shared database');
    });
});

describe('ordinary trolley recovery result verification', () => {
    it('restores an unpaid draft without opening either database, even in offline multi mode', async () => {
        multi();
        await expect(checkoutDraftDisposition([], '')).resolves.toEqual({ state: 'restore' });
        expect(native.local).not.toHaveBeenCalled();
        expect(native.remote).not.toHaveBeenCalled();
    });

    it.each(['completed', 'voided', 'refunded'])('does not replay local receipt status %s while the shared server is offline', async status => {
        multi();
        local.db.prepare('INSERT INTO orders VALUES (?, ?)').run('sale-1', status);
        await expect(checkoutDraftDisposition(['sale-1'], '')).resolves.toEqual({ state: 'consumed' });
        expect(native.remote).not.toHaveBeenCalled();
    });

    it('does not replay a purged completed receipt with its retained tombstone', async () => {
        local.db.prepare('INSERT INTO tombstones VALUES (?, ?)').run('orders', 'sale-1');
        await expect(checkoutDraftDisposition(['sale-1'], '')).resolves.toEqual({ state: 'consumed' });
    });

    it.each(['hold', 'completed'])('does not duplicate an interrupted durable hold with status %s', async status => {
        local.db.prepare('INSERT INTO orders VALUES (?, ?)').run('hold-1', status);
        await expect(checkoutDraftDisposition([], 'hold-1')).resolves.toEqual({ state: 'consumed' });
    });

    it('keeps a missing interrupted hold for review instead of treating it as unpaid', async () => {
        await expect(checkoutDraftDisposition([], 'hold-1')).resolves.toMatchObject({ state: 'review', message: expect.stringContaining('hold') });
    });

    it('keeps missing attempted receipt history for review', async () => {
        await expect(checkoutDraftDisposition(['sale-1'], '')).resolves.toMatchObject({ state: 'review' });
    });

    it('does not depend on MariaDB for a proven dedicated decline', async () => {
        multi(); attempt(local);
        await expect(checkoutDraftDisposition(['sale-1'], '')).resolves.toEqual({ state: 'restore' });
        expect(native.remote).not.toHaveBeenCalled();
    });

    it.each(['Canceled', 'Cancelled', 'Reversed', 'SignatureVerificationRejected', 'TIMED_OUT'])('accepts an exact persisted no-charge Dojo outcome %s', async status => {
        attempt(local, { status: status === 'SignatureVerificationRejected' ? 'failed' : 'cancelled', error: `Dojo status: ${status}` });
        await expect(checkoutDraftDisposition(['sale-1'], '')).resolves.toEqual({ state: 'restore' });
    });

    it.each(['DECLINED', 'CANCELLED', 'TIMED_OUT'])('accepts a dedicated SumUp persisted no-charge outcome %s without a server', async status => {
        multi(); attempt(local, { provider: 'sumup', error: `SumUp status: ${status}` });
        await expect(checkoutDraftDisposition(['sale-1'], '')).resolves.toEqual({ state: 'restore' });
        expect(native.remote).not.toHaveBeenCalled();
    });

    it('does not interpret a generic SumUp FAILED outcome as a proven decline', async () => {
        attempt(local, { provider: 'sumup', error: 'SumUp status: FAILED' });
        await expect(checkoutDraftDisposition(['sale-1'], '')).resolves.toMatchObject({ state: 'review' });
    });

    it.each(['', 'Dojo status: UNSUCCESSFUL', 'Dojo status: Expired', 'Dojo status: Created', 'Timed out waiting for the terminal result', 'An unexpected failure occurred'])('keeps ambiguous failed outcome %s blocked', async error => {
        attempt(local, { error });
        await expect(checkoutDraftDisposition(['sale-1'], '')).resolves.toMatchObject({ state: 'review' });
    });

    it.each(['prepared', 'started', 'uncertain', 'approved', 'commit_failed', 'completion_pending'])('does not restore operational status %s even with negative wording', async status => {
        attempt(local, { status });
        await expect(checkoutDraftDisposition(['sale-1'], '')).resolves.toMatchObject({ state: 'review' });
    });

    it('recognizes final completion even if the receipt was purged and an old online intent remains', async () => {
        multi(); attempt(local, { status: 'completed', error: '' });
        local.db.prepare('INSERT INTO _online_financial_intent VALUES (?)').run('sale-1');
        await expect(checkoutDraftDisposition(['sale-1'], '')).resolves.toEqual({ state: 'consumed' });
        expect(native.remote).not.toHaveBeenCalled();
    });

    it('blocks matching online account/loyalty work but ignores unrelated intent', async () => {
        attempt(local);
        local.db.prepare('INSERT INTO _online_financial_intent VALUES (?)').run('other-sale');
        await expect(checkoutDraftDisposition(['sale-1'], '')).resolves.toEqual({ state: 'restore' });
        local.db.prepare('INSERT INTO _online_financial_intent VALUES (?)').run('sale-1');
        await expect(checkoutDraftDisposition(['sale-1'], '')).resolves.toMatchObject({ state: 'review', message: expect.stringContaining('online financial') });
    });

    it('requires the original shared server for a locally cached shared decline', async () => {
        multi(); attempt(local, { journalScope: 'shared' });
        await expect(checkoutDraftDisposition(['sale-1'], '')).resolves.toMatchObject({ state: 'review' });
        expect(native.remote).not.toHaveBeenCalled();
    });

    it('restores a shared decline only when both authoritative and local journals prove no charge', async () => {
        multi(true);
        attempt(local, { journalScope: 'shared' }); attempt(remote, { journalScope: 'shared' });
        await expect(checkoutDraftDisposition(['sale-1'], '')).resolves.toEqual({ state: 'restore' });
        expect(native.remote).toHaveBeenCalledOnce();
    });

    it.each(['missing', 'approved', 'wrong-identity', 'wrong-payment'])('keeps a shared journal %s disagreement for review', async variant => {
        multi(true); attempt(local, { journalScope: 'shared' });
        if (variant !== 'missing') attempt(remote, variant === 'approved'
            ? { status: 'approved', journalScope: 'shared' }
            : variant === 'wrong-payment'
                ? { clientTransactionId: 'different-payment', journalScope: 'shared' }
                : { terminalKey: 'different', journalScope: 'shared' });
        await expect(checkoutDraftDisposition(['sale-1'], '')).resolves.toMatchObject({ state: 'review' });
    });

    it('does not replay a shared receipt that completed before reaching the local cache', async () => {
        multi(true); attempt(local, { journalScope: 'shared' });
        remote.db.prepare('INSERT INTO orders VALUES (?, ?)').run('sale-1', 'completed');
        await expect(checkoutDraftDisposition(['sale-1'], '')).resolves.toEqual({ state: 'consumed' });
    });

    it('does not consume a draft using proof from a shared connection changed during the read', async () => {
        multi(true); attempt(local, { journalScope: 'shared' });
        remote.db.prepare('INSERT INTO orders VALUES (?, ?)').run('sale-1', 'completed');
        const originalSelect = remote.select.getMockImplementation()!;
        remote.select.mockImplementation(async (sql: string, parameters: any[] = []) => {
            const rows = await originalSelect(sql, parameters);
            connectionState.update(state => ({ ...state, mysqlOnline: false }));
            return rows;
        });
        await expect(checkoutDraftDisposition(['sale-1'], '')).resolves.toMatchObject({ state: 'review' });
    });

    it('requires every attempted ID to have proof, not merely one declined request', async () => {
        attempt(local);
        await expect(checkoutDraftDisposition(['sale-1', 'missing-sale'], '')).resolves.toMatchObject({ state: 'review' });
    });

    it('accepts a settled repeated provider decline but rejects its first or contradictory observation', async () => {
        attempt(local, { error: 'PROVIDER_FINAL_CANDIDATE:dojo:failed:123:2: Dojo final status: terminal Declined, payment intent Created' });
        await expect(checkoutDraftDisposition(['sale-1'], '')).resolves.toEqual({ state: 'restore' });
        local.db.prepare('UPDATE payment_terminal_attempts SET error = ?').run('PROVIDER_FINAL_CANDIDATE:dojo:failed:123:1: Dojo final status: terminal Declined, payment intent Created');
        await expect(checkoutDraftDisposition(['sale-1'], '')).resolves.toMatchObject({ state: 'review' });
        local.db.prepare('UPDATE payment_terminal_attempts SET error = ?').run('PROVIDER_FINAL_CANDIDATE:dojo:failed:123:2: Dojo final status: terminal Declined, payment intent Captured');
        await expect(checkoutDraftDisposition(['sale-1'], '')).resolves.toMatchObject({ state: 'review' });
    });

    it('checks native sandbox receipt identity before accepting a cancellation without textual proof', async () => {
        attempt(local, { status: 'cancelled', error: 'Native sandbox reconciliation completed' });
        local.db.exec(`CREATE TABLE dojo_sandbox_recovery_receipts (
            attemptId TEXT, terminalKey TEXT, paymentIntentId TEXT, terminalSessionId TEXT,
            amount INTEGER, currency TEXT, providerStatus TEXT, confirmedAt TEXT
        )`);
        local.db.prepare('INSERT INTO dojo_sandbox_recovery_receipts VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run('sale-1', 'dojo:test-terminal', 'pi_sandbox_test', 'session-1', 175, 'GBP', 'Canceled', '2026-10-12T12:00:00.000Z');
        await expect(checkoutDraftDisposition(['sale-1'], '')).resolves.toEqual({ state: 'restore' });
        local.db.exec('UPDATE dojo_sandbox_recovery_receipts SET amount = 176');
        await expect(checkoutDraftDisposition(['sale-1'], '')).resolves.toMatchObject({ state: 'review' });
    });

    it('keeps the draft when transaction verification cannot read its local tables', async () => {
        native.local.mockRejectedValueOnce(new Error('database locked'));
        await expect(checkoutDraftDisposition(['sale-1'], '')).resolves.toMatchObject({ state: 'review', message: expect.stringContaining('database locked') });
    });

    it('parameterizes receipt references rather than interpolating their contents', async () => {
        const id = "receipt' OR 1=1 --";
        local.db.prepare('INSERT INTO orders VALUES (?, ?)').run(id, 'completed');
        await expect(checkoutDraftDisposition([id], '')).resolves.toEqual({ state: 'consumed' });
        expect(local.select).toHaveBeenCalledWith(expect.stringContaining('IN (?)'), [id]);
    });
});
