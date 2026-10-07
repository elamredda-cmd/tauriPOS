import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    canCancelExpiredTestPayment, isReportPaymentBlocker, readableReportPaymentBlocker,
    reportPaymentAmount, reportPaymentRecoveryReason, reportPaymentStatus,
    REPORT_PAYMENT_FINALITY_WAIT_MS, verifyCancelledReportPayment,
} from './reportPaymentRecovery';

const pending = {
    provider: 'dojo' as const, operationKind: 'sale' as const, status: 'uncertain' as const,
    error: 'Dojo is not final (Expired)', clientTransactionId: 'pi_sandbox_example',
};
const sandbox = { apiKeyConfigured: true, apiEnvironment: 'Sandbox' };

describe('report payment recovery guidance', () => {
    it('explains pending payments without calling them an open terminal window', () => {
        expect(isReportPaymentBlocker('MariaDB has 1 terminal payment attempt(s) to recover')).toBe(true);
        expect(readableReportPaymentBlocker('MariaDB has 1 terminal payment attempt(s) to recover'))
            .toBe('MariaDB has 1 unresolved card payment to recover');
        expect(readableReportPaymentBlocker('This till has 2 card payment attempts to complete'))
            .toBe('This till has 2 unresolved card payments to complete');
        expect(isReportPaymentBlocker('Till 1 is offline')).toBe(false);
    });

    it('formats the exact amount and identifies final shared confirmation as still pending', () => {
        expect(reportPaymentAmount({ amount: 1055, currency: 'GBP' })).toBe('£10.55');
        expect(reportPaymentAmount({ amount: 0, currency: 'GBP' })).toBe('Amount needs review');
        expect(reportPaymentStatus('completed')).toBe('Shared confirmation pending');
    });

    it('does not display raw secret/database/provider error text', () => {
        const raw = 'mysql://owner:secret@host/db error api-key=secret pi_sandbox_private';
        const output = reportPaymentRecoveryReason({ status: 'uncertain', error: raw });
        expect(output).not.toContain('secret');
        expect(output).not.toContain('pi_sandbox');
        expect(reportPaymentRecoveryReason(pending)).toContain('does not prove payment failure');
        expect(reportPaymentRecoveryReason({ status: 'uncertain', error: 'PROVIDER_FINAL_CANDIDATE:CANCELED:123' }))
            .toContain('at least 30 seconds');
    });

    it('offers test cancellation only for an admin and an expired sandbox sale', () => {
        expect(canCancelExpiredTestPayment(pending, sandbox, true)).toBe(true);
        expect(canCancelExpiredTestPayment(pending, sandbox, false)).toBe(false);
        expect(canCancelExpiredTestPayment(pending, { ...sandbox, apiEnvironment: 'Live' }, true)).toBe(false);
        expect(canCancelExpiredTestPayment(pending, { ...sandbox, apiKeyConfigured: false }, true)).toBe(false);
        expect(canCancelExpiredTestPayment({ ...pending, operationKind: 'refund' }, sandbox, true)).toBe(false);
        expect(canCancelExpiredTestPayment({ ...pending, status: 'approved' }, sandbox, true)).toBe(false);
        expect(canCancelExpiredTestPayment({ ...pending, clientTransactionId: 'pi_live_example' }, sandbox, true)).toBe(false);
        expect(canCancelExpiredTestPayment({ ...pending, error: 'Not final (Authorized)' }, sandbox, true)).toBe(false);
        expect(canCancelExpiredTestPayment({ ...pending, error: 'PROVIDER_FINAL_CANDIDATE Canceled; terminal Expired' }, sandbox, true)).toBe(false);
        expect(canCancelExpiredTestPayment({ ...pending, error: 'Terminal Expired; payment Captured' }, sandbox, true)).toBe(false);
        expect(canCancelExpiredTestPayment({ ...pending, error: 'Terminal Expired; payment Authorized' }, sandbox, true)).toBe(false);
    });
});

describe('automatic confirmation after explicit sandbox cancellation', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    function verification() {
        const controller = new AbortController();
        return {
            controller,
            options: {
                signal: controller.signal,
                canContinue: vi.fn(() => true),
                assertSafe: vi.fn(async () => undefined),
                recover: vi.fn(async () => undefined),
                refreshResolved: vi.fn(async () => false),
                onSettling: vi.fn(),
            },
        };
    }

    it('automatically rechecks once beyond the 30-second finality interval', async () => {
        const { options } = verification();
        options.refreshResolved.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        const result = verifyCancelledReportPayment(options);
        await vi.advanceTimersByTimeAsync(0);
        expect(options.recover).toHaveBeenCalledTimes(1);
        expect(options.onSettling).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(options.recover).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(REPORT_PAYMENT_FINALITY_WAIT_MS - 30_000);
        await expect(result).resolves.toBe('resolved');
        expect(options.recover).toHaveBeenCalledTimes(2);
        expect(options.assertSafe).toHaveBeenCalledTimes(2);
        expect(options.refreshResolved).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('skips the wait if recovery already resolved the target payment', async () => {
        const { options } = verification();
        options.refreshResolved.mockResolvedValue(true);
        await expect(verifyCancelledReportPayment(options)).resolves.toBe('resolved');
        expect(options.recover).toHaveBeenCalledOnce();
        expect(options.onSettling).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('stops after two checks if the provider or shared journal remains unresolved', async () => {
        const { options } = verification();
        const result = verifyCancelledReportPayment(options);
        await vi.advanceTimersByTimeAsync(REPORT_PAYMENT_FINALITY_WAIT_MS * 3);
        await expect(result).resolves.toBe('pending');
        expect(options.recover).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('disposes the waiting timer immediately when navigation or the staff session aborts it', async () => {
        const { controller, options } = verification();
        const result = verifyCancelledReportPayment(options);
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(1);
        controller.abort();
        await expect(result).resolves.toBe('stopped');
        expect(vi.getTimerCount()).toBe(0);
        expect(options.recover).toHaveBeenCalledOnce();
        expect(options.assertSafe).toHaveBeenCalledOnce();
    });

    it('does not start a recovery for an already disposed page', async () => {
        const { controller, options } = verification();
        controller.abort();
        await expect(verifyCancelledReportPayment(options)).resolves.toBe('stopped');
        expect(options.assertSafe).not.toHaveBeenCalled();
        expect(options.recover).not.toHaveBeenCalled();
    });

    it('does not recheck after connection, authorization, or close-state eligibility changes', async () => {
        const { options } = verification();
        const result = verifyCancelledReportPayment(options);
        await vi.advanceTimersByTimeAsync(0);
        options.canContinue.mockReturnValue(false);
        await vi.advanceTimersByTimeAsync(REPORT_PAYMENT_FINALITY_WAIT_MS);
        await expect(result).resolves.toBe('stopped');
        expect(options.recover).toHaveBeenCalledOnce();
        expect(options.assertSafe).toHaveBeenCalledOnce();
    });

    it('rechecks eligibility after awaiting the shared close barrier', async () => {
        const { options } = verification();
        options.assertSafe.mockImplementationOnce(async () => {
            options.canContinue.mockReturnValue(false);
        });
        await expect(verifyCancelledReportPayment(options)).resolves.toBe('stopped');
        expect(options.recover).not.toHaveBeenCalled();
        expect(options.refreshResolved).not.toHaveBeenCalled();
    });

    it('cannot write recovery results while the shared close barrier is held', async () => {
        const { options } = verification();
        options.assertSafe.mockRejectedValue(new Error('Report close is in progress'));
        await expect(verifyCancelledReportPayment(options)).rejects.toThrow('Report close is in progress');
        expect(options.recover).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('checks the barrier again before the delayed recovery', async () => {
        const { options } = verification();
        options.assertSafe.mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('Another till started closing'));
        const result = expect(verifyCancelledReportPayment(options)).rejects.toThrow('Another till started closing');
        await vi.advanceTimersByTimeAsync(REPORT_PAYMENT_FINALITY_WAIT_MS);
        await result;
        expect(options.assertSafe).toHaveBeenCalledTimes(2);
        expect(options.recover).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });
});
