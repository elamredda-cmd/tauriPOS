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
    preparePaymentTerminalAttempt,
    requirePreparedSaleBundle,
} from '$lib/terminalAttempts';

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
});
