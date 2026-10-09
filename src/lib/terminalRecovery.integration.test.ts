import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalPaymentAttempt } from './terminalAttempts';
import type { DojoPaymentIntentStatus } from './dojo';

const mocks = vi.hoisted(() => ({
    connection: { mode: 'multi', mysqlOnline: true },
    invoke: vi.fn(), list: vi.fn(), refresh: vi.fn(), update: vi.fn(), acknowledge: vi.fn(), enrich: vi.fn(),
    commit: vi.fn(), postAccount: vi.fn(), hydrate: vi.fn(), assertWrites: vi.fn(),
    acquire: vi.fn(), refreshLease: vi.fn(), release: vi.fn(), prune: vi.fn(),
    getPayment: vi.fn(), getSession: vi.fn(), findPayment: vi.fn(), select: vi.fn(),
    loadDojo: vi.fn(), loadSumup: vi.fn(), cancelNative: vi.fn(), refund: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: mocks.invoke }));
vi.mock('$lib/stores/connection', () => ({
    connectionState: { subscribe(run: (value: unknown) => void) {
        run({ ...mocks.connection, mysqlConfig: { host: 'test.invalid', port: 3306, user: 'fixture', password: '', database: 'fixture' } });
        return () => undefined;
    } },
}));
vi.mock('$lib/stores/database', () => ({
    assertMariaDbCommerceWritesAllowed: mocks.assertWrites,
    commitPreparedTerminalSale: mocks.commit,
    postCustomerAccountEntry: mocks.postAccount,
    hydrateSvelteStores: mocks.hydrate,
}));
vi.mock('$lib/stores/mysql', () => ({
    mysqlAcquirePaymentTerminalLock: mocks.acquire,
    mysqlRefreshPaymentTerminalLock: mocks.refreshLease,
    mysqlReleasePaymentTerminalLock: mocks.release,
}));
vi.mock('$lib/terminalAttempts', () => ({
    terminalAttemptUsesSharedJournal: (attempt: TerminalPaymentAttempt) => attempt.journalScope !== 'local',
    acknowledgeApprovedPaymentTerminalAttempt: mocks.acknowledge,
    getRecoverablePaymentTerminalAttempts: mocks.list,
    refreshPaymentTerminalAttempt: mocks.refresh,
    updatePaymentTerminalAttempt: mocks.update,
    persistVerifiedDojoPaymentAccounting: mocks.enrich,
    prunePaymentTerminalAttempts: mocks.prune,
    isCustomerAccountPaymentPayload: (payload: any) => payload.kind === 'customer_account_payment',
    withTerminalPaymentExtras: (payload: any, extras: any) => payload.kind === 'customer_account_payment'
        ? { ...payload, ...extras } : { ...payload, payment: { ...payload.payment, ...extras } },
}));
vi.mock('$lib/dojo', () => ({
    cancelExpiredSandboxDojoPaymentIntent: mocks.cancelNative,
    getDojoPaymentIntentStatus: mocks.getPayment,
    getDojoTerminalSessionStatus: mocks.getSession,
    findDojoPaymentIntentByReference: mocks.findPayment,
    loadDojoConfig: mocks.loadDojo,
    refundDojoPaymentIntent: mocks.refund,
}));
vi.mock('$lib/sumup', () => ({
    getSumupTransactionByReference: vi.fn(), getSumupTransactionStatus: vi.fn(), loadSumupConfig: mocks.loadSumup,
}));
vi.mock('$lib/stores/sqlite', () => ({
    getDb: async () => ({ select: mocks.select }),
    getOrCreateTillId: async () => 'test-till',
    getTillName: async () => 'Test till',
}));

import { cancelExpiredSandboxDojoPayment, runTerminalRecovery } from './terminalRecovery';

describe('managed Dojo recovery orchestration (mocked native/provider boundaries)', () => {
    let current: TerminalPaymentAttempt;
    let steps: string[];

    beforeEach(() => {
        vi.restoreAllMocks();
        vi.resetAllMocks();
        steps = [];
        mocks.connection.mode = 'multi';
        mocks.connection.mysqlOnline = true;
        current = {
            id: 'sale-1', provider: 'dojo', terminalKey: 'dojo:fixture:terminal',
            clientTransactionId: 'pi-1', terminalSessionId: 'ts-1', operationKind: 'sale',
            amount: 600, expectedProviderAmount: 600, currency: 'GBP', status: 'uncertain',
            providerReference: '', error: '', tillId: 'test-till',
            createdAt: '2026-07-27T08:00:00.000Z', updatedAt: '2026-07-27T08:00:00.000Z',
            saleBundle: {
                order: { id: 'sale-1', type: 'sale' },
                payment: { id: 'payment-1', orderId: 'sale-1', amount: 600, cardAmount: 600, reference: '' },
                lines: [], stockChanges: [], audit: { id: 'audit-1' }, reportEpoch: 'report-1', serverDataEpoch: 'server-1',
            },
        } as unknown as TerminalPaymentAttempt;
        mocks.list.mockImplementation(async () => ['completed', 'failed', 'cancelled'].includes(current.status) ? [] : [structuredClone(current)]);
        mocks.refresh.mockImplementation(async () => structuredClone(current));
        mocks.update.mockImplementation(async (_provider, _id, status, values) => {
            current = { ...current, ...values, status };
            return structuredClone(current);
        });
        mocks.acknowledge.mockImplementation(async (attempt) => { steps.push('shared-ack'); return attempt; });
        mocks.enrich.mockImplementation(async (attempt, extras) => {
            steps.push('persist-extras');
            const payload: any = attempt.saleBundle;
            current = { ...attempt, saleBundle: payload.kind === 'customer_account_payment'
                ? { ...payload, ...extras } : { ...payload, payment: { ...payload.payment, ...extras } } };
            return structuredClone(current);
        });
        mocks.acquire.mockResolvedValue({ acquired: true });
        mocks.refreshLease.mockResolvedValue(true);
        mocks.release.mockResolvedValue(undefined);
        mocks.select.mockResolvedValue([]);
        mocks.commit.mockImplementation(async (bundle) => { steps.push('ledger'); return bundle; });
        mocks.postAccount.mockResolvedValue(undefined);
        mocks.invoke.mockResolvedValue(undefined);
        mocks.prune.mockResolvedValue(undefined);
        mocks.hydrate.mockResolvedValue(undefined);
        mocks.findPayment.mockResolvedValue(null);
        mocks.getPayment.mockImplementation(async () => { steps.push('provider-proof'); return captured(); });
        mocks.getSession.mockImplementation(async () => ({ id: 'ts-1', terminalId: 'terminal', status: 'Captured', paymentIntentId: 'pi-1', payment: captured() }));
        mocks.loadDojo.mockResolvedValue({ apiKeyConfigured: true, apiEnvironment: 'Sandbox' });
        mocks.cancelNative.mockResolvedValue(undefined);
    });

    function captured(): DojoPaymentIntentStatus {
        return { id: 'pi-1', reference: 'sale-1', status: 'Captured', amount: 600, currency: 'GBP',
            tipsAmount: { value: 100, currencyCode: 'GBP' }, totalAmount: { value: 700, currencyCode: 'GBP' } };
    }

    function installLocalLease() {
        current.journalScope = 'local';
        mocks.connection.mysqlOnline = false;
        mocks.loadDojo.mockResolvedValue({ apiKeyConfigured: true, apiEnvironment: 'Sandbox', terminalOwnership: 'dedicated' });
        mocks.invoke.mockImplementation(async (command) => {
            if (command === 'terminal_acquire_local_lock') return { acquired: true, lock: null };
            if (command === 'terminal_refresh_local_lock') return true;
        });
    }

    it.each(['single', 'multi'])('recovers a dedicated approved sale in %s mode with MariaDB offline', async (mode) => {
        installLocalLease();
        mocks.connection.mode = mode;
        expect((await runTerminalRecovery('dojo')).completed).toBe(1);
        expect(current.status).toBe('completed');
        expect(mocks.commit).toHaveBeenCalledWith(expect.objectContaining({
            payment: expect.objectContaining({ reference: expect.stringContaining('Dojo'), tipsAmount: 100 }),
        }), { journalScope: 'local' });
        expect(mocks.assertWrites).not.toHaveBeenCalled();
        expect(mocks.acquire).not.toHaveBeenCalled();
        expect(mocks.invoke.mock.calls.some(([command]) => command === 'commit_mysql_sale')).toBe(false);
        expect(mocks.list).toHaveBeenCalledWith('dojo', { includeShared: false });
        await runTerminalRecovery('dojo');
        expect(mocks.commit).toHaveBeenCalledOnce();
    });

    it('keeps a legacy shared attempt unresolved offline even after dedicated registration', async () => {
        installLocalLease();
        delete current.journalScope;
        expect((await runTerminalRecovery('dojo')).stillUncertain).toBe(1);
        expect(mocks.getPayment).not.toHaveBeenCalled();
        expect(mocks.commit).not.toHaveBeenCalled();
        expect(mocks.invoke).not.toHaveBeenCalled();
    });

    it('does not publish provider evidence or commit after losing its local recovery lease', async () => {
        installLocalLease();
        mocks.invoke.mockImplementation(async (command) => {
            if (command === 'terminal_acquire_local_lock') return { acquired: true, lock: null };
            if (command === 'terminal_refresh_local_lock') return false;
        });
        const result = await runTerminalRecovery('dojo');
        expect(result.stillUncertain).toBe(1);
        expect(result.errors.join(' ')).toContain('lease was lost');
        expect(mocks.getPayment).not.toHaveBeenCalled();
        expect(mocks.update).not.toHaveBeenCalled();
        expect(mocks.commit).not.toHaveBeenCalled();
    });

    it('allows local sandbox cancellation under a local lease without changing journal finality', async () => {
        installLocalLease();
        await cancelExpiredSandboxDojoPayment(current.id);
        expect(mocks.cancelNative).toHaveBeenCalledExactlyOnceWith(current.id);
        expect(mocks.assertWrites).not.toHaveBeenCalled();
        expect(mocks.acquire).not.toHaveBeenCalled();
        expect(mocks.update).not.toHaveBeenCalled();
        expect(current.status).toBe('uncertain');
    });

    it('follows the latest session after a declined retry, keeping the original journal reference', async () => {
        mocks.getPayment.mockResolvedValue({ ...captured(), latestTerminalSessionId: 'ts-retry' });
        mocks.getSession.mockResolvedValue({ id: 'ts-retry', terminalId: 'terminal', status: 'Captured', paymentIntentId: 'pi-1' });
        expect((await runTerminalRecovery('dojo')).completed).toBe(1);
        expect(mocks.getSession).toHaveBeenCalledWith('ts-retry');
        expect(mocks.commit).toHaveBeenCalledOnce();
        expect(current.terminalSessionId).toBe('ts-1');
    });

    it('does not finalize an earlier decline when a retry request has an uncertain reply', async () => {
        current.error = 'DOJO_RETRY_PENDING:ts-1 Network timeout';
        mocks.getPayment.mockResolvedValue({ ...captured(), status: 'Created', latestTerminalSessionId: 'ts-1' });
        mocks.getSession.mockResolvedValue({ id: 'ts-1', terminalId: 'terminal', status: 'Declined', paymentIntentId: 'pi-1' });
        expect((await runTerminalRecovery('dojo')).stillUncertain).toBe(1);
        expect(current.error).toContain('DOJO_RETRY_PENDING:ts-1');
        expect(mocks.commit).not.toHaveBeenCalled();
    });

    it('recovers an administrator receipt decision after a restart and does not commit it twice', async () => {
        const receipt = { version: 1, attemptId: current.id, paymentIntentId: 'pi-1', terminalSessionId: 'ts-1',
            decision: 'paid', amount: 600, currency: 'GBP', receiptReference: 'receipt-checked', note: 'Merchant receipt approved',
            tipsAmount: 50, serviceChargeAmount: 0, cashbackAmount: 0, employeeId: 'admin-1', employeeName: 'Manager', createdAt: '2026-09-28T10:00:00Z' };
        current.operatorResolution = JSON.stringify(receipt);
        mocks.getPayment.mockResolvedValue({ id: 'pi-1', reference: current.id, status: 'Created', amount: 600, currency: 'GBP', latestTerminalSessionId: 'ts-1' });
        mocks.getSession.mockResolvedValue({ id: 'ts-1', terminalId: 'terminal', status: 'Expired', paymentIntentId: 'pi-1' });
        expect((await runTerminalRecovery('dojo')).completed).toBe(1);
        expect(current.status).toBe('completed');
        expect(current.operatorResolution).toBe(JSON.stringify(receipt));
        expect(mocks.commit.mock.calls[0][0].payment).toMatchObject({ cardAmount: 600, tipsAmount: 50, reference: expect.stringContaining('receipt confirmed') });
        await runTerminalRecovery('dojo');
        expect(mocks.commit).toHaveBeenCalledOnce();
    });

    it('actually finalizes a repeatedly missing provider request after its full settling window', async () => {
        current.clientTransactionId = '';
        current.terminalSessionId = '';
        const first = Date.parse('2026-07-28T08:00:00.000Z');
        const now = vi.spyOn(Date, 'now');
        for (const elapsed of [0, 25 * 60 * 60 * 1000]) {
            now.mockReturnValue(first + elapsed);
            expect((await runTerminalRecovery('dojo')).stillUncertain).toBe(1);
        }
        now.mockReturnValue(first + 25 * 60 * 60 * 1000 + 60_000);
        const result = await runTerminalRecovery('dojo');
        expect(result.finalizedWithoutLedger).toBe(1);
        expect(current.status).toBe('cancelled');
        expect(current.error).toMatch(/^PROVIDER_NOT_FOUND:dojo:/);
        expect(mocks.commit).not.toHaveBeenCalled();
    });

    it('revalidates and journals extras before acknowledging and committing legacy approved work', async () => {
        current.status = 'approved';
        current.providerReference = 'Dojo pi-1 [id:pi-1]';
        const result = await runTerminalRecovery('dojo');
        expect(result.completed).toBe(1);
        expect(steps).toEqual(['provider-proof', 'persist-extras', 'shared-ack', 'ledger']);
        expect(mocks.commit.mock.calls[0][0].payment).toMatchObject({ amount: 600, cardAmount: 600, tipsAmount: 100, cashbackAmount: 0 });
    });

    it('does not commit already-approved work whose provider money no longer verifies', async () => {
        current.status = 'approved';
        mocks.getPayment.mockResolvedValue({ ...captured(), totalAmount: { value: 600, currencyCode: 'GBP' } });
        expect((await runTerminalRecovery('dojo')).stillUncertain).toBe(1);
        expect(mocks.enrich).not.toHaveBeenCalled();
        expect(mocks.acknowledge).not.toHaveBeenCalled();
        expect(mocks.commit).not.toHaveBeenCalled();
        expect(current.status).toBe('commit_failed');
    });

    it('does not commit after a failed shared approval acknowledgement', async () => {
        current.status = 'completion_pending';
        mocks.acknowledge.mockRejectedValueOnce(new Error('shared ACK rejected'));
        expect((await runTerminalRecovery('dojo')).stillUncertain).toBe(1);
        expect(mocks.commit).not.toHaveBeenCalled();
    });

    it('posts captured account extras separately without reducing extra customer debt', async () => {
        current.operationKind = 'customer_account_payment';
        current.saleBundle = {
            kind: 'customer_account_payment', customerId: 'customer-1', amountPence: -600, paymentMethod: 'card',
            reference: '', description: 'Test account payment', employeeId: 'employee-1', tillNumber: 'till-1',
            shiftId: 'shift-1', idempotencyKey: 'sale-1', allowCreditBalance: true, reportEpoch: 'report-1', serverDataEpoch: 'server-1',
        };
        expect((await runTerminalRecovery('dojo')).completed).toBe(1);
        expect(mocks.postAccount).toHaveBeenCalledWith(expect.objectContaining({ amountPence: -600, tipsAmount: 100, serviceChargeAmount: 0, cashbackAmount: 0 }));
        expect(mocks.commit).not.toHaveBeenCalled();
        const approval = mocks.update.mock.calls.find((call) => call[2] === 'approved');
        expect(approval?.[3].saleBundle).toMatchObject({ amountPence: -600, tipsAmount: 100 });
    });

    it('does not acknowledge a local completed row when provider extras were never recorded', async () => {
        current.status = 'completed';
        mocks.list.mockImplementation(async () => [structuredClone(current)]);
        mocks.select.mockResolvedValue([{ amount: 600, cardAmount: 600, reference: 'Dojo pi-1 [id:pi-1]' }]);
        const result = await runTerminalRecovery('dojo');
        expect(result.stillUncertain).toBe(1);
        expect(result.completed).toBe(0);
        expect(result.errors.join(' ')).toContain('unrecorded or conflicting extra amounts');
        expect(mocks.acknowledge).not.toHaveBeenCalled();
        expect(mocks.update).not.toHaveBeenCalled();
        expect(current.status).toBe('completed');
    });

    it('acknowledges a legacy completed row with verified zero extras without rewriting it', async () => {
        current.status = 'completed';
        mocks.list.mockImplementation(async () => [structuredClone(current)]);
        mocks.getPayment.mockResolvedValue({ id: 'pi-1', reference: 'sale-1', status: 'Captured', amount: 600, currency: 'GBP' });
        mocks.select.mockResolvedValue([{ amount: 600, cardAmount: 600, reference: 'Dojo pi-1 [id:pi-1]' }]);
        const result = await runTerminalRecovery('dojo');
        expect(result.completed).toBe(1);
        expect(mocks.acknowledge).toHaveBeenCalledOnce();
        expect(mocks.enrich).not.toHaveBeenCalled();
        expect(mocks.commit).not.toHaveBeenCalled();
    });

    it('returns recovered cashback for review without triggering another payout', async () => {
        mocks.getPayment.mockResolvedValue({ ...captured(), cashbackAmount: { value: 200, currencyCode: 'GBP' }, totalAmount: { value: 900, currencyCode: 'GBP' } });
        mocks.getSession.mockResolvedValue({ id: 'ts-1', terminalId: 'terminal', status: 'Captured', paymentIntentId: 'pi-1', payment: {
            ...captured(), cashbackAmount: { value: 200, currencyCode: 'GBP' }, totalAmount: { value: 900, currencyCode: 'GBP' },
        } });
        const result = await runTerminalRecovery('dojo');
        expect(result.completed).toBe(1);
        expect(result.cashbackToReview).toEqual([{ attemptId: 'sale-1', amount: 200, currency: 'GBP' }]);
        expect(mocks.invoke.mock.calls.every((call) => call[0] === 'commit_mysql_sale')).toBe(true);
    });

    it('verifies the original goods amount for refund recovery without copying its extras', async () => {
        current.id = 'refund-1';
        current.operationKind = 'refund';
        current.amount = 100;
        current.expectedProviderAmount = 100;
        const bundle: any = current.saleBundle;
        bundle.order = { id: 'refund-1', type: 'return', originalOrderId: 'sale-1' };
        bundle.payment = { id: 'refund-payment-1', orderId: 'refund-1', amount: -100, cardAmount: -100, reference: '' };
        mocks.getPayment.mockResolvedValue({ ...captured(), refundedAmount: 100 });
        mocks.select.mockImplementation(async (sql: string) => sql.startsWith('SELECT cardAmount')
            ? [{ amount: 600, cardAmount: 600, reference: 'Dojo pi-1 [id:pi-1]' }] : []);
        expect((await runTerminalRecovery('dojo')).completed).toBe(1);
        expect(mocks.commit.mock.calls[0][0].payment).toMatchObject({ amount: -100, cardAmount: -100 });
        expect(mocks.commit.mock.calls[0][0].payment.tipsAmount).toBeUndefined();
    });

    it('cancels through native sandbox verification under lease without finalizing any journal', async () => {
        await cancelExpiredSandboxDojoPayment('sale-1');
        expect(mocks.cancelNative).toHaveBeenCalledExactlyOnceWith('sale-1');
        expect(mocks.acquire).toHaveBeenCalledWith('dojo:fixture:terminal', 'test-till', expect.any(String), expect.stringMatching(/^sandbox-cancel:sale-1:/), 600);
        expect(mocks.refreshLease).toHaveBeenCalledTimes(3);
        expect(mocks.release).toHaveBeenCalledOnce();
        expect(mocks.update).not.toHaveBeenCalled();
        expect(mocks.commit).not.toHaveBeenCalled();
        expect(current.status).toBe('uncertain');
    });

    it.each(['rejected', 'captured', 'ambiguous', 'wrong identity'])('rechecks a recent interrupted refund with the same key: %s', async (scenario) => {
        current.id = 'refund-1';
        current.operationKind = 'refund';
        current.amount = 100;
        current.expectedProviderAmount = 100;
        current.error = 'Dojo returned HTTP 400 Bad Request';
        current.createdAt = new Date().toISOString();
        const bundle: any = current.saleBundle;
        bundle.order = { id: 'refund-1', type: 'return', originalOrderId: 'sale-1' };
        bundle.payment = { id: 'refund-payment-1', orderId: 'refund-1', amount: -100, cardAmount: -100 };
        mocks.select.mockImplementation(async (sql: string) => sql.startsWith('SELECT cardAmount')
            ? [{ amount: 600, cardAmount: 600, reference: 'Dojo [id:pi-1]' }] : []);
        mocks.getPayment.mockResolvedValue({ ...captured(), refundedAmount: 0 });
        mocks.refund.mockImplementation(async () => {
            mocks.getPayment.mockResolvedValue({ ...captured(), id: scenario === 'wrong identity' ? 'wrong' : 'pi-1',
                refundedAmount: scenario === 'captured' ? 100 : 0 });
            return { paymentIntentId: 'pi-1', rejected: scenario !== 'ambiguous', refundId: '' };
        });
        await runTerminalRecovery('dojo');
        expect(mocks.refund).toHaveBeenCalledExactlyOnceWith('pi-1', 100, 'refund-1');
        expect(current.status).toBe(scenario === 'rejected' ? 'failed' : scenario === 'captured' ? 'completed' : 'uncertain');
        if (scenario !== 'captured') expect(mocks.commit).not.toHaveBeenCalled();
    });

    it('rejects live settings, approved/refund work and a lost lease before provider mutation', async () => {
        mocks.loadDojo.mockResolvedValueOnce({ apiKeyConfigured: true, apiEnvironment: 'Production' });
        await expect(cancelExpiredSandboxDojoPayment('sale-1')).rejects.toThrow('sandbox key');
        current.status = 'approved';
        await expect(cancelExpiredSandboxDojoPayment('sale-1')).rejects.toThrow('unapproved');
        current.status = 'uncertain'; current.operationKind = 'refund';
        await expect(cancelExpiredSandboxDojoPayment('sale-1')).rejects.toThrow('unapproved');
        current.operationKind = 'sale';
        mocks.refreshLease.mockResolvedValueOnce(false);
        await expect(cancelExpiredSandboxDojoPayment('sale-1')).rejects.toThrow('lease was lost');
        expect(mocks.cancelNative).not.toHaveBeenCalled();
        expect(mocks.update).not.toHaveBeenCalled();
        expect(mocks.release).toHaveBeenCalledOnce();
    });

    it('rechecks the journal and report gate after obtaining the cancellation lease', async () => {
        mocks.refresh.mockResolvedValueOnce(structuredClone(current)).mockResolvedValueOnce({ ...current, status: 'approved' });
        await expect(cancelExpiredSandboxDojoPayment('sale-1')).rejects.toThrow('unapproved');
        expect(mocks.cancelNative).not.toHaveBeenCalled();
        mocks.refresh.mockImplementation(async () => structuredClone(current));
        mocks.assertWrites.mockRejectedValueOnce(new Error('report close in progress'));
        await expect(cancelExpiredSandboxDojoPayment('sale-1')).rejects.toThrow('report close');
        expect(mocks.cancelNative).not.toHaveBeenCalled();
    });

    it('keeps canceled provider confirmation subject to separated recovery finality', async () => {
        const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-29T08:00:00.000Z'));
        await cancelExpiredSandboxDojoPayment('sale-1');
        mocks.getSession.mockResolvedValue({ id: 'ts-1', terminalId: 'terminal', paymentIntentId: 'pi-1', status: 'Expired' });
        mocks.getPayment.mockResolvedValue({ ...captured(), status: 'Canceled' });
        expect((await runTerminalRecovery('dojo')).stillUncertain).toBe(1);
        expect(current.status).toBe('uncertain');
        now.mockReturnValue(Date.parse('2026-07-29T08:00:31.000Z'));
        expect((await runTerminalRecovery('dojo')).finalizedWithoutLedger).toBe(1);
        expect(current.status).toBe('cancelled');
        expect(mocks.commit).not.toHaveBeenCalled();
    });

    it.each(['Captured', 'Authorized', '404', 'network failure'])('does not clear journal when native final confirmation reports %s', async (detail) => {
        mocks.cancelNative.mockRejectedValueOnce(new Error(detail));
        await expect(cancelExpiredSandboxDojoPayment('sale-1')).rejects.toThrow(detail);
        expect(current.status).toBe('uncertain');
        expect(mocks.update).not.toHaveBeenCalled();
        expect(mocks.release).toHaveBeenCalledOnce();
        if (detail === 'Captured') {
            expect((await runTerminalRecovery('dojo')).completed).toBe(1);
            expect(mocks.commit).toHaveBeenCalledOnce();
        }
    });

    it.each([
        { id: 'wrong', terminalId: 'terminal', paymentIntentId: 'pi-1' },
        { id: 'ts-1', terminalId: 'wrong', paymentIntentId: 'pi-1' },
        { id: 'ts-1', terminalId: 'terminal', paymentIntentId: 'wrong' },
    ])('never finalizes the journal using a mismatched session $id / $terminalId / $paymentIntentId', async (identity) => {
        mocks.getSession.mockResolvedValue({ ...identity, status: 'Canceled', payment: { ...captured(), status: 'Canceled' } });
        current.error = 'PROVIDER_FINAL_CANDIDATE:dojo:cancelled:1:2: old proof';
        expect((await runTerminalRecovery('dojo')).stillUncertain).toBe(1);
        expect(current.status).toBe('uncertain');
        expect(mocks.commit).not.toHaveBeenCalled();
    });
});
