import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SaleBundle } from '$lib/stores/database';
import type {
    CustomerAccountPaymentAttemptPayload,
    TerminalAttemptPayload,
    TerminalPaymentAttempt,
} from '$lib/terminalAttempts';

const mocks = vi.hoisted(() => ({
    assertWritesAllowed: vi.fn(),
    withCurrentReportEpoch: vi.fn(),
    mysqlPrepare: vi.fn(),
    mysqlGetOperational: vi.fn(),
    mysqlGetAttempt: vi.fn(),
    mysqlPrune: vi.fn(),
    mysqlUpdate: vi.fn(),
    mysqlEnrich: vi.fn(),
    localExecute: vi.fn(),
    localSelect: vi.fn(),
}));

vi.mock('$lib/stores/connection', () => ({
    connectionState: {
        subscribe(run: (value: { mode: string; mysqlOnline: boolean }) => void) {
            run({ mode: 'multi', mysqlOnline: true });
            return () => undefined;
        },
    },
}));

vi.mock('$lib/stores/database', () => ({
    assertMariaDbCommerceWritesAllowed: mocks.assertWritesAllowed,
    withCurrentReportEpoch: mocks.withCurrentReportEpoch,
}));

vi.mock('$lib/stores/mysql', () => ({
    mysqlEnrichDojoTerminalAccounting: mocks.mysqlEnrich,
    mysqlGetOperationalPaymentTerminalAttempts: mocks.mysqlGetOperational,
    mysqlGetPaymentTerminalAttempt: mocks.mysqlGetAttempt,
    mysqlPreparePaymentTerminalAttempt: mocks.mysqlPrepare,
    mysqlPrunePaymentTerminalAttempts: mocks.mysqlPrune,
    mysqlUpdatePaymentTerminalAttempt: mocks.mysqlUpdate,
}));

vi.mock('$lib/stores/sqlite', () => ({
    getDb: vi.fn(async () => ({
        execute: mocks.localExecute,
        select: mocks.localSelect,
    })),
}));

import {
    acknowledgeApprovedPaymentTerminalAttempt,
    preparePaymentTerminalAttempt,
    persistVerifiedDojoPaymentAccounting,
    requirePreparedSaleBundle,
    updatePaymentTerminalAttempt,
} from '$lib/terminalAttempts';
import {
    assertTerminalAccountingEnrichment,
    isTerminalAttemptTransitionAllowed,
    terminalAttemptStateStrength,
} from '$lib/terminalAttemptState';
import type { MysqlPaymentTerminalAttempt } from '$lib/stores/mysql';

function saleBundle(): SaleBundle {
    return {
        order: { id: 'sale-1', type: 'sale' },
        payment: { id: 'payment-1', orderId: 'sale-1', reference: '' },
        lines: [],
        stockChanges: [],
        audit: { id: 'audit-1' },
    } as unknown as SaleBundle;
}

function terminalAttempt(bundle: TerminalAttemptPayload): TerminalPaymentAttempt {
    return {
        id: 'order' in bundle ? bundle.order.id : bundle.idempotencyKey,
        provider: 'sumup',
        terminalKey: 'sumup:merchant:reader',
        clientTransactionId: '',
        terminalSessionId: '',
        operationKind: 'kind' in bundle ? 'customer_account_payment' : 'sale',
        amount: 1_250,
        expectedProviderAmount: 1_250,
        currency: 'GBP',
        status: 'prepared',
        saleBundle: bundle,
        providerReference: '',
        error: '',
        tillId: 'till-1',
        createdAt: '2026-07-29T10:00:00.000Z',
        updatedAt: '2026-07-29T10:00:00.000Z',
    };
}

describe('terminal attempt report-epoch propagation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.assertWritesAllowed.mockResolvedValue(undefined);
        mocks.localExecute.mockResolvedValue({ rowsAffected: 1 });
        mocks.withCurrentReportEpoch.mockImplementation(async (bundle: SaleBundle) => ({
            ...bundle,
            reportEpoch: '2026-07-29T09:00:00.000Z',
            serverDataEpoch: 'server-epoch-7',
        }));
        mocks.mysqlPrepare.mockImplementation(async (attempt: Record<string, unknown>) => ({
            ...attempt,
            createdAt: '2026-07-29T10:00:01.000Z',
            updatedAt: '2026-07-29T10:00:01.000Z',
        }));
    });

    it('returns and locally journals the exact server-prepared stamped bundle', async () => {
        const originalBundle = saleBundle();
        const submitted = terminalAttempt(originalBundle);

        const prepared = await preparePaymentTerminalAttempt(submitted);
        const durableBundle = requirePreparedSaleBundle(prepared);

        expect(originalBundle.reportEpoch).toBeUndefined();
        expect(() => requirePreparedSaleBundle(submitted)).toThrow(/prepared report epoch/i);
        expect(durableBundle.reportEpoch).toBe('2026-07-29T09:00:00.000Z');
        expect(durableBundle.serverDataEpoch).toBe('server-epoch-7');
        expect(prepared.createdAt).toBe('2026-07-29T10:00:01.000Z');

        expect(mocks.withCurrentReportEpoch).toHaveBeenCalledWith(originalBundle, {
            requireLiveServerDataEpoch: true,
        });

        const sharedWrite = mocks.mysqlPrepare.mock.calls[0][0] as { saleBundle: string };
        expect(JSON.parse(sharedWrite.saleBundle).reportEpoch).toBe('2026-07-29T09:00:00.000Z');
        expect(JSON.parse(sharedWrite.saleBundle).serverDataEpoch).toBe('server-epoch-7');

        const localParameters = mocks.localExecute.mock.calls[0][1] as unknown[];
        expect(JSON.parse(String(localParameters[10])).reportEpoch)
            .toBe('2026-07-29T09:00:00.000Z');
        expect(JSON.parse(String(localParameters[10])).serverDataEpoch)
            .toBe('server-epoch-7');
    });

    it('refreshes previously stamped epochs before a provider can be called', async () => {
        const previouslyStamped = {
            ...saleBundle(),
            reportEpoch: '2026-07-28T09:00:00.000Z',
            serverDataEpoch: 'server-epoch-old',
        };

        const prepared = await preparePaymentTerminalAttempt(terminalAttempt(previouslyStamped));
        const durableBundle = requirePreparedSaleBundle(prepared);

        expect(mocks.withCurrentReportEpoch).toHaveBeenCalledWith(previouslyStamped, {
            requireLiveServerDataEpoch: true,
        });
        expect(durableBundle.reportEpoch).toBe('2026-07-29T09:00:00.000Z');
        expect(durableBundle.serverDataEpoch).toBe('server-epoch-7');
    });

    it('durably stamps a customer-account card payment before provider approval', async () => {
        const payload: CustomerAccountPaymentAttemptPayload = {
            kind: 'customer_account_payment',
            customerId: 'customer-1',
            amountPence: -1_250,
            paymentMethod: 'card',
            reference: '',
            description: 'Card account payment',
            employeeId: 'employee-1',
            tillNumber: 'till-1',
            shiftId: 'shift-1',
            idempotencyKey: 'account-payment-1',
            allowCreditBalance: true,
        };

        const prepared = await preparePaymentTerminalAttempt(terminalAttempt(payload));
        const durablePayload = prepared.saleBundle as CustomerAccountPaymentAttemptPayload;

        expect(durablePayload.reportEpoch).toBe('2026-07-29T09:00:00.000Z');
        expect(durablePayload.serverDataEpoch).toBe('server-epoch-7');
        expect(mocks.withCurrentReportEpoch).toHaveBeenCalledWith(payload, {
            requireLiveServerDataEpoch: true,
        });

        const sharedWrite = mocks.mysqlPrepare.mock.calls[0][0] as { saleBundle: string };
        expect(JSON.parse(sharedWrite.saleBundle)).toMatchObject({
            kind: 'customer_account_payment',
            reportEpoch: '2026-07-29T09:00:00.000Z',
            serverDataEpoch: 'server-epoch-7',
        });
        const localParameters = mocks.localExecute.mock.calls[0][1] as unknown[];
        expect(JSON.parse(String(localParameters[10]))).toMatchObject({
            kind: 'customer_account_payment',
            reportEpoch: '2026-07-29T09:00:00.000Z',
            serverDataEpoch: 'server-epoch-7',
        });
    });

    it('explains an active-terminal collision without preparing a local retry', async () => {
        const attempt = { ...terminalAttempt(saleBundle()), provider: 'dojo' as const, terminalKey: 'dojo:shop:terminal' };
        mocks.mysqlPrepare.mockRejectedValueOnce(new Error("1062 Duplicate entry for key 'uq_payment_terminal_active'"));
        mocks.mysqlGetOperational.mockResolvedValueOnce([{ ...attempt, status: 'completion_pending' }]);

        await expect(preparePaymentTerminalAttempt(attempt)).rejects.toThrow(
            'Dojo terminal busy. An earlier payment was approved and its sale is still being saved.',
        );
        expect(mocks.localExecute).not.toHaveBeenCalled();
        expect(mocks.mysqlUpdate).not.toHaveBeenCalled();
    });

    it('keeps a readable active-terminal error when its diagnostic lookup fails', async () => {
        mocks.mysqlPrepare.mockRejectedValueOnce(new Error("1062 Duplicate entry for key 'uq_payment_terminal_active'"));
        mocks.mysqlGetOperational.mockRejectedValueOnce(new Error('connection lost'));

        await expect(preparePaymentTerminalAttempt(terminalAttempt(saleBundle()))).rejects.toThrow('No new payment was sent');
        expect(mocks.localExecute).not.toHaveBeenCalled();
    });

    it('does not relabel unrelated journal errors as a terminal collision', async () => {
        mocks.mysqlPrepare.mockRejectedValueOnce(new Error('MariaDB is offline'));
        await expect(preparePaymentTerminalAttempt(terminalAttempt(saleBundle()))).rejects.toThrow('MariaDB is offline');
        expect(mocks.mysqlGetOperational).not.toHaveBeenCalled();
    });
});

describe('shared terminal approval acknowledgement', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        mocks.localExecute.mockResolvedValue({ rowsAffected: 1 });
    });

    function approvedAttempt(status: TerminalPaymentAttempt['status'] = 'completion_pending'): TerminalPaymentAttempt {
        return {
            ...terminalAttempt(saleBundle()),
            provider: 'dojo',
            terminalKey: 'dojo:shop:terminal',
            status,
            clientTransactionId: 'pi-original',
            terminalSessionId: 'ts-original',
            providerReference: 'Dojo transaction [id:pi-original]',
        };
    }

    function installJournal(local: TerminalPaymentAttempt, status: TerminalPaymentAttempt['status']) {
        let remote: MysqlPaymentTerminalAttempt = { ...local, status, saleBundle: JSON.stringify(local.saleBundle) };
        mocks.mysqlGetAttempt.mockImplementation(async () => structuredClone(remote));
        mocks.mysqlUpdate.mockImplementation(async (_id, _provider, requested, values) => {
            const applied = isTerminalAttemptTransitionAllowed(remote.status, requested)
                && !['completed', 'failed', 'cancelled'].includes(remote.status);
            if (applied) remote = { ...remote, ...values, status: requested };
            return { applied, attempt: structuredClone(remote) };
        });
        mocks.localSelect.mockImplementation(async () => [{
            ...local,
            status: terminalAttemptStateStrength(remote.status) > terminalAttemptStateStrength(local.status)
                ? remote.status : local.status,
            saleBundle: JSON.stringify(local.saleBundle),
        }]);
        return { remote: () => remote, replaceRemote: (value: MysqlPaymentTerminalAttempt) => { remote = value; } };
    }

    it.each(['approved', 'commit_failed', 'completion_pending', 'completed'] as const)(
        'replays missing approval before acknowledging local %s', async (status) => {
            const local = approvedAttempt(status);
            const journal = installJournal(local, 'uncertain');
            const assertLease = vi.fn().mockResolvedValue(undefined);

            const result = await acknowledgeApprovedPaymentTerminalAttempt(local, assertLease);

            expect(result.status).toBe(status);
            expect(journal.remote().status).toBe(status);
            expect(mocks.mysqlUpdate.mock.calls.map((call) => call[2]))
                .toEqual(status === 'approved' ? ['approved'] : ['approved', status]);
            expect(assertLease).toHaveBeenCalledTimes(1 + mocks.mysqlUpdate.mock.calls.length);
        },
    );

    it('uses a directly permitted completion transition when shared approval exists', async () => {
        const local = approvedAttempt('completed');
        installJournal(local, 'approved');
        await acknowledgeApprovedPaymentTerminalAttempt(local, async () => undefined);
        expect(mocks.mysqlUpdate.mock.calls.map((call) => call[2])).toEqual(['completed']);
    });

    it('adopts an already acknowledged shared completion without another write', async () => {
        const local = approvedAttempt('approved');
        installJournal(local, 'completed');
        const result = await acknowledgeApprovedPaymentTerminalAttempt(local, async () => undefined);
        expect(result.status).toBe('completed');
        expect(mocks.mysqlUpdate).not.toHaveBeenCalled();
    });

    it.each(['failed', 'cancelled'] as const)('does not rewrite an immutable shared %s', async (status) => {
        const local = approvedAttempt();
        installJournal(local, status);
        await expect(acknowledgeApprovedPaymentTerminalAttempt(local, async () => undefined))
            .rejects.toThrow('final failure conflicting with local approval');
        expect(mocks.mysqlUpdate).not.toHaveBeenCalled();
    });

    it.each([
        ['clientTransactionId', 'pi-other'],
        ['terminalSessionId', 'ts-other'],
        ['providerReference', 'another transaction'],
        ['terminalKey', 'dojo:shop:other'],
        ['amount', 1500],
        ['expectedProviderAmount', 1500],
        ['currency', 'EUR'],
    ])('rejects conflicting %s before publishing local proof', async (field, value) => {
        const local = approvedAttempt();
        const journal = installJournal(local, 'uncertain');
        journal.replaceRemote({ ...journal.remote(), [field]: value });
        await expect(acknowledgeApprovedPaymentTerminalAttempt(local, async () => undefined)).rejects.toThrow('administrator review');
        expect(mocks.mysqlUpdate).not.toHaveBeenCalled();
    });

    it('does not replay approval without durable provider evidence', async () => {
        const local = { ...approvedAttempt(), clientTransactionId: '', providerReference: '' };
        installJournal(local, 'started');
        await expect(acknowledgeApprovedPaymentTerminalAttempt(local, async () => undefined)).rejects.toThrow('no complete provider evidence');
        expect(mocks.mysqlUpdate).not.toHaveBeenCalled();
    });

    it.each(['approved', 'commit_failed', 'completion_pending', 'completed'] as const)(
        'rejects conflicting captured extras in shared %s before any write', async (status) => {
            const local = approvedAttempt('completed');
            (local.saleBundle as SaleBundle).payment.tipsAmount = 200;
            const journal = installJournal(local, status);
            const remotePayload = JSON.parse(journal.remote().saleBundle);
            remotePayload.payment.tipsAmount = 100;
            journal.replaceRemote({ ...journal.remote(), saleBundle: JSON.stringify(remotePayload) });

            await expect(acknowledgeApprovedPaymentTerminalAttempt(local, async () => undefined))
                .rejects.toThrow('conflicting extra amounts');
            expect(mocks.mysqlUpdate).not.toHaveBeenCalled();
            expect(mocks.localExecute).not.toHaveBeenCalled();
        },
    );

    it.each(['tipsAmount', 'serviceChargeAmount', 'cashbackAmount'] as const)(
        'does not erase a shared nonzero %s missing from local legacy proof', async (field) => {
            const local = approvedAttempt('completed');
            const journal = installJournal(local, 'approved');
            const remotePayload = JSON.parse(journal.remote().saleBundle);
            remotePayload.payment[field] = 100;
            journal.replaceRemote({ ...journal.remote(), saleBundle: JSON.stringify(remotePayload) });

            await expect(acknowledgeApprovedPaymentTerminalAttempt(local, async () => undefined))
                .rejects.toThrow('conflicting extra amounts');
            expect(mocks.mysqlUpdate).not.toHaveBeenCalled();
        },
    );

    it('rejects replacing an explicitly approved zero with a nonzero extra', async () => {
        const local = approvedAttempt('completed');
        (local.saleBundle as SaleBundle).payment.cashbackAmount = 500;
        const journal = installJournal(local, 'approved');
        const remotePayload = JSON.parse(journal.remote().saleBundle);
        remotePayload.payment.cashbackAmount = 0;
        journal.replaceRemote({ ...journal.remote(), saleBundle: JSON.stringify(remotePayload) });

        await expect(acknowledgeApprovedPaymentTerminalAttempt(local, async () => undefined))
            .rejects.toThrow('conflicting extra amounts');
        expect(mocks.mysqlUpdate).not.toHaveBeenCalled();
    });

    it('preserves a shared explicit zero when the matching local legacy field is missing', async () => {
        const local = approvedAttempt('completed');
        const journal = installJournal(local, 'approved');
        const remotePayload = JSON.parse(journal.remote().saleBundle);
        remotePayload.payment.cashbackAmount = 0;
        journal.replaceRemote({ ...journal.remote(), saleBundle: JSON.stringify(remotePayload) });

        await acknowledgeApprovedPaymentTerminalAttempt(local, async () => undefined);
        expect(JSON.parse(journal.remote().saleBundle).payment.cashbackAmount).toBe(0);
    });

    it.each(['prepared', 'started', 'uncertain', 'approved'] as const)(
        'still acknowledges verified extras when shared %s has only missing legacy fields', async (status) => {
            const local = approvedAttempt('completed');
            (local.saleBundle as SaleBundle).payment.tipsAmount = 100;
            const journal = installJournal(local, status);
            const remotePayload = JSON.parse(journal.remote().saleBundle);
            delete remotePayload.payment.tipsAmount;
            journal.replaceRemote({ ...journal.remote(), saleBundle: JSON.stringify(remotePayload) });

            await acknowledgeApprovedPaymentTerminalAttempt(local, async () => undefined);
            expect(journal.remote().status).toBe('completed');
            expect(JSON.parse(journal.remote().saleBundle).payment.tipsAmount).toBe(100);
        },
    );

    it('keeps provisional pre-approval zeros replaceable by actual captured money', async () => {
        const local = approvedAttempt('completed');
        (local.saleBundle as SaleBundle).payment.tipsAmount = 100;
        const journal = installJournal(local, 'started');
        const remotePayload = JSON.parse(journal.remote().saleBundle);
        remotePayload.payment.tipsAmount = 0;
        journal.replaceRemote({ ...journal.remote(), saleBundle: JSON.stringify(remotePayload) });

        await acknowledgeApprovedPaymentTerminalAttempt(local, async () => undefined);
        expect(journal.remote().status).toBe('completed');
        expect(JSON.parse(journal.remote().saleBundle).payment.tipsAmount).toBe(100);
    });

    it('does not publish approval after losing the terminal lease', async () => {
        const local = approvedAttempt();
        installJournal(local, 'started');
        const assertLease = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('lease lost'));
        await expect(acknowledgeApprovedPaymentTerminalAttempt(local, assertLease)).rejects.toThrow('lease lost');
        expect(mocks.mysqlUpdate).not.toHaveBeenCalled();
    });

    it('never mistakes a stronger local final row for a rejected shared ACK', async () => {
        const local = approvedAttempt('completed');
        const journal = installJournal(local, 'uncertain');
        mocks.mysqlUpdate.mockResolvedValue({ applied: false, attempt: journal.remote() });

        await expect(acknowledgeApprovedPaymentTerminalAttempt(local, async () => undefined))
            .rejects.toThrow('did not acknowledge approved');
    });

    it('keeps completion pending after a lost shared approval response', async () => {
        const local = approvedAttempt();
        installJournal(local, 'started');
        mocks.mysqlUpdate.mockRejectedValueOnce(new Error('connection lost'));
        await expect(acknowledgeApprovedPaymentTerminalAttempt(local, async () => undefined)).rejects.toThrow('connection lost');
        expect(mocks.mysqlUpdate).toHaveBeenCalledTimes(1);
    });

    it.each(['rejected', 'lost'])('does not report a %s shared completion ACK as local completion success', async (failure) => {
        const local = approvedAttempt('completed');
        const journal = installJournal(local, 'started');
        if (failure === 'lost') mocks.mysqlUpdate.mockRejectedValueOnce(new Error('connection lost'));
        else mocks.mysqlUpdate.mockResolvedValueOnce({ applied: false, attempt: journal.remote() });

        await expect(updatePaymentTerminalAttempt('dojo', local.id, 'completed')).rejects.toThrow();
    });

    it('CAS-persists verified legacy extras to both journals without changing base accounting', async () => {
        const local = approvedAttempt('approved');
        const journal = installJournal(local, 'approved');
        let localJson = JSON.stringify(local.saleBundle);
        mocks.localSelect.mockImplementation(async () => [{ ...local, saleBundle: localJson }]);
        mocks.mysqlEnrich.mockImplementation(async (expected, enrichedJson) => {
            assertTerminalAccountingEnrichment(expected.saleBundle, enrichedJson);
            const enriched = { ...expected, saleBundle: enrichedJson };
            journal.replaceRemote(enriched);
            return enriched;
        });
        mocks.localExecute.mockImplementation(async (_sql, values) => {
            expect(values[3]).toBe(localJson);
            localJson = values[0];
            return { rowsAffected: 1 };
        });
        const extras = { tipsAmount: 120, serviceChargeAmount: 30, cashbackAmount: 500 };
        const assertLease = vi.fn().mockResolvedValue(undefined);

        const result = await persistVerifiedDojoPaymentAccounting(local, extras, assertLease);

        expect((result.saleBundle as SaleBundle).payment).toMatchObject({ id: 'payment-1', ...extras });
        expect(JSON.parse(journal.remote().saleBundle).payment).toMatchObject(extras);
        expect(result.status).toBe('approved');
        expect(mocks.mysqlUpdate).not.toHaveBeenCalled();
        expect(assertLease).toHaveBeenCalledTimes(3);
    });

    it('does not continue after a failed shared accounting CAS', async () => {
        const local = approvedAttempt('approved');
        installJournal(local, 'approved');
        mocks.mysqlEnrich.mockRejectedValueOnce(new Error('shared CAS changed'));

        await expect(persistVerifiedDojoPaymentAccounting(local, {
            tipsAmount: 120, serviceChargeAmount: 0, cashbackAmount: 0,
        }, async () => undefined)).rejects.toThrow('shared CAS changed');
        expect(mocks.localExecute).not.toHaveBeenCalled();
    });

    it('rejects an unacknowledged local accounting CAS', async () => {
        const local = approvedAttempt('approved');
        installJournal(local, 'approved');
        mocks.mysqlEnrich.mockResolvedValue(undefined);

        await expect(persistVerifiedDojoPaymentAccounting(local, {
            tipsAmount: 120, serviceChargeAmount: 0, cashbackAmount: 0,
        }, async () => undefined)).rejects.toThrow('Local terminal accounting was not acknowledged');
    });

    it('never rewrites extras on a completed shared financial payload', async () => {
        const local = approvedAttempt('approved');
        installJournal(local, 'completed');
        // Read the approved local snapshot, before the stronger remote merge.
        mocks.localSelect.mockResolvedValue([{ ...local, saleBundle: JSON.stringify(local.saleBundle) }]);
        await expect(persistVerifiedDojoPaymentAccounting(local, {
            tipsAmount: 120, serviceChargeAmount: 0, cashbackAmount: 0,
        }, async () => undefined)).rejects.toThrow('completed shared payment has different extra amounts');
        expect(mocks.mysqlEnrich).not.toHaveBeenCalled();
        expect(mocks.localExecute).not.toHaveBeenCalled();
    });
});

describe('immutable terminal accounting enrichment', () => {
    const extras = { tipsAmount: 120, serviceChargeAmount: 30, cashbackAmount: 500 };
    const original = { order: { id: 'sale-1', type: 'sale' }, payment: { amount: 1250, cardAmount: 1250, reference: 'Dojo original' } };
    const enriched = { ...original, payment: { ...original.payment, ...extras } };

    it('only adds missing itemised amounts while preserving goods/card allocations', () => {
        expect(() => assertTerminalAccountingEnrichment(JSON.stringify(original), JSON.stringify(enriched))).not.toThrow();
        expect(() => assertTerminalAccountingEnrichment(JSON.stringify(enriched), JSON.stringify(enriched))).not.toThrow();
    });

    it.each([0, 99, 120])('does not overwrite an explicitly recorded tip of %s', (tipsAmount) => {
        const existing = { ...original, payment: { ...original.payment, tipsAmount } };
        const changed = { ...enriched, payment: { ...enriched.payment, tipsAmount: tipsAmount + 1 } };
        expect(() => assertTerminalAccountingEnrichment(JSON.stringify(existing), JSON.stringify(changed))).toThrow('cannot be changed');
    });

    it.each(['amount', 'cardAmount', 'reference'])('cannot change original %s', (field) => {
        const changed = { ...enriched, payment: { ...enriched.payment, [field]: field === 'reference' ? 'different' : 1300 } };
        expect(() => assertTerminalAccountingEnrichment(JSON.stringify(original), JSON.stringify(changed))).toThrow('original financial payload');
    });

    it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects unsafe extra %s', (tipsAmount) => {
        const changed = { ...enriched, payment: { ...enriched.payment, tipsAmount } };
        expect(() => assertTerminalAccountingEnrichment(JSON.stringify(original), JSON.stringify(changed))).toThrow('nonnegative whole minor units');
    });

    it('enriches account payments without reducing additional customer debt', () => {
        const account = { kind: 'customer_account_payment', customerId: 'customer-1', amountPence: -1250, idempotencyKey: 'account-1' };
        expect(() => assertTerminalAccountingEnrichment(JSON.stringify(account), JSON.stringify({ ...account, ...extras }))).not.toThrow();
        expect(() => assertTerminalAccountingEnrichment(JSON.stringify(account), JSON.stringify({ ...account, ...extras, amountPence: -1900 })))
            .toThrow('original financial payload');
    });

    it('does not enrich goods refunds with original extras', () => {
        const refund = { ...original, order: { ...original.order, type: 'return' } };
        expect(() => assertTerminalAccountingEnrichment(JSON.stringify(refund), JSON.stringify({ ...refund, payment: enriched.payment })))
            .toThrow('Only original sales');
    });
});
