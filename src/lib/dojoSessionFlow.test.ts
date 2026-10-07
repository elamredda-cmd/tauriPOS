import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DojoPaymentIntentStatus, DojoTerminalSessionStatus } from './dojo';
import { dojoSessionMessage, monitorDojoSession, type DojoSessionFlowOptions } from './dojoSessionFlow';

function payment(status = 'Captured'): DojoPaymentIntentStatus {
    return { id: 'pi_test', reference: 'order-test', amount: 1250, currency: 'GBP', status };
}

function session(status: string, details?: DojoPaymentIntentStatus): DojoTerminalSessionStatus {
    return { id: 'ts_test', terminalId: 'tm_test', paymentIntentId: 'pi_test', status, payment: details };
}

function setup(overrides: Partial<Pick<DojoSessionFlowOptions,
    'shouldCancel' | 'isDisposed' | 'timeoutMs' | 'pollIntervalMs' | 'leaseIntervalMs' | 'apiEnvironment'>> = {}) {
    return {
        paymentIntentId: 'pi_test',
        terminalSessionId: 'ts_test',
        getSession: vi.fn<() => Promise<DojoTerminalSessionStatus>>().mockResolvedValue(session('Captured', payment())),
        getPayment: vi.fn<() => Promise<DojoPaymentIntentStatus>>().mockResolvedValue(payment()),
        submitSignature: vi.fn<(accepted: boolean) => Promise<void>>().mockResolvedValue(undefined),
        cancel: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
        cancelExpiredSandboxPayment: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
        refreshLease: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
        onSignatureRequired: vi.fn<(decide: (accepted: boolean) => void) => void>(),
        onSignatureDismiss: vi.fn<() => void>(),
        onMessage: vi.fn<(message: string, cancelling: boolean) => void>(),
        ...overrides,
    };
}

describe('Dojo session monitoring shared by checkout and account payments', () => {
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
    afterEach(() => { vi.useRealTimers(); });

    it('retries a decline on the same intent, keeps renewing while deciding, and follows the new session', async () => {
        const options = setup();
        options.getSession.mockResolvedValue(session('Declined'));
        options.getPayment.mockResolvedValue(payment('Created'));
        const onDeclined = vi.fn();
        const dismiss = vi.fn();
        const retry = vi.fn(async () => {
            options.getSession.mockResolvedValue({ ...session('Captured', payment()), id: 'ts_retry' });
            return 'ts_retry';
        });
        const result = monitorDojoSession({ ...options, onDeclined, retry, onDeclineDismiss: dismiss });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(onDeclined).toHaveBeenCalledOnce();
        expect(options.refreshLease).toHaveBeenCalled();
        onDeclined.mock.calls[0][0](true);
        onDeclined.mock.calls[0][0](false);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(await result).toEqual({ outcome: 'captured', payment: payment() });
        expect(retry).toHaveBeenCalledOnce();
        expect(dismiss).toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('returns a definitive failure when the cashier chooses another payment method', async () => {
        const options = setup();
        options.getSession.mockResolvedValue(session('Declined'));
        options.getPayment.mockResolvedValue(payment('Created'));
        const retry = vi.fn();
        const result = monitorDojoSession({ ...options, retry, onDeclined: decide => decide(false) });
        expect(await result).toEqual({ outcome: 'failed', status: 'Declined' });
        expect(retry).not.toHaveBeenCalled();
    });

    it('honours a late capture while the decline decision is open without sending a retry', async () => {
        const options = setup();
        options.getSession.mockResolvedValue(session('Declined'));
        options.getPayment.mockResolvedValueOnce(payment('Created')).mockResolvedValue(payment());
        const retry = vi.fn();
        const result = monitorDojoSession({ ...options, retry, onDeclined: vi.fn() });
        await vi.advanceTimersByTimeAsync(1_000);
        expect((await result).outcome).toBe('captured');
        expect(retry).not.toHaveBeenCalled();
    });

    it('waits through signature acceptance and authorization until the intent captures', async () => {
        const options = setup();
        options.getSession
            .mockResolvedValueOnce(session('SignatureVerificationAccepted', payment('Created')))
            .mockResolvedValueOnce(session('Authorized', payment('Authorized')))
            .mockResolvedValueOnce(session('Captured', payment()));
        const result = monitorDojoSession(options);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(await result).toEqual({ outcome: 'captured', payment: payment() });
        expect(options.getSession).toHaveBeenCalledTimes(3);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('continues polling and renewing for the 80-second provider auto-accept window without deciding', async () => {
        const options = setup();
        options.getSession.mockImplementation(async () => Date.now() < 81_000
            ? session('SignatureVerificationRequired') : session('Captured', payment()));
        const result = monitorDojoSession(options);
        await vi.advanceTimersByTimeAsync(81_000);
        expect((await result).outcome).toBe('captured');
        expect(options.onSignatureRequired).toHaveBeenCalledTimes(1);
        expect(options.submitSignature).not.toHaveBeenCalled();
        expect(options.refreshLease).toHaveBeenCalledTimes(3);
        expect(options.getSession.mock.calls.length).toBeGreaterThan(80);
        expect(options.onSignatureDismiss).toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([true, false])('submits only the operator decision %s and ignores duplicate clicks', async (accepted) => {
        const options = setup();
        options.getSession.mockResolvedValueOnce(session('SignatureVerificationRequired'));
        const result = monitorDojoSession(options);
        await vi.advanceTimersByTimeAsync(0);
        const decide = options.onSignatureRequired.mock.calls[0][0];
        decide(accepted);
        decide(!accepted);
        await vi.advanceTimersByTimeAsync(1_000);
        expect((await result).outcome).toBe('captured');
        expect(options.submitSignature).toHaveBeenCalledExactlyOnceWith(accepted);
    });

    it('reconciles a late rejected signature request against captured payment despite stale session state', async () => {
        const options = setup();
        options.getSession.mockResolvedValue(session('SignatureVerificationRequired'));
        options.submitSignature.mockRejectedValue(new Error('Dojo returned 422'));
        const result = monitorDojoSession(options);
        await vi.advanceTimersByTimeAsync(80_000);
        const decide = options.onSignatureRequired.mock.calls[0][0];
        decide(false);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(await result).toEqual({ outcome: 'captured', payment: payment() });
        expect(options.getPayment).toHaveBeenCalled();
        expect(options.submitSignature).toHaveBeenCalledExactlyOnceWith(false);
    });

    it('dismisses obsolete prompts and ignores a stale decision after provider capture', async () => {
        const options = setup();
        options.getSession.mockResolvedValueOnce(session('SignatureVerificationRequired'));
        const result = monitorDojoSession(options);
        await vi.advanceTimersByTimeAsync(0);
        const decide = options.onSignatureRequired.mock.calls[0][0];
        await vi.advanceTimersByTimeAsync(1_000);
        expect((await result).outcome).toBe('captured');
        decide(false);
        expect(options.submitSignature).not.toHaveBeenCalled();
        expect(options.onSignatureDismiss).toHaveBeenCalled();
    });

    it.each(['Dojo returned 422', 'network timeout'])('does not shorten monitoring after cancel error: %s', async (error) => {
        const options = setup({ shouldCancel: () => true });
        options.cancel.mockRejectedValue(new Error(error));
        options.getSession.mockImplementation(async () => Date.now() < 40_000
            ? session('Initiated') : session('Captured', payment()));
        const result = monitorDojoSession(options);
        await vi.advanceTimersByTimeAsync(40_000);
        expect((await result).outcome).toBe('captured');
        expect(options.cancel).toHaveBeenCalledTimes(1);
        expect(options.onMessage.mock.calls.some(([message, cancelling]) =>
            message.includes('cancellation was not confirmed') && !cancelling)).toBe(true);
    });

    it('accepts a later confirmed cancellation after the original cancel request failed', async () => {
        const options = setup({ shouldCancel: () => true });
        options.cancel.mockRejectedValue(new Error('Network timeout'));
        options.getSession
            .mockResolvedValueOnce(session('Initiated'))
            .mockResolvedValueOnce(session('Canceled', payment('Created')));
        const result = monitorDojoSession(options);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(await result).toEqual({ outcome: 'cancelled', status: 'Canceled' });
        expect(options.cancel).toHaveBeenCalledTimes(1);
        expect(options.onMessage.mock.calls.some(([message, cancelling]) =>
            message.includes('cancellation was not confirmed') && !cancelling)).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('renews the reservation independently while a provider read is still pending', async () => {
        const options = setup();
        let resolveSession!: (value: DojoTerminalSessionStatus) => void;
        options.getSession.mockImplementation(() => new Promise((resolve) => { resolveSession = resolve; }));
        const result = monitorDojoSession(options);
        await vi.advanceTimersByTimeAsync(55_000);
        expect(options.refreshLease).toHaveBeenCalledTimes(2);
        resolveSession(session('Captured', payment()));
        expect((await result).outcome).toBe('captured');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('lets authoritative capture win over a late rejected signature terminal status', async () => {
        const options = setup();
        options.getSession.mockResolvedValue(session('SignatureVerificationRejected'));
        expect(await monitorDojoSession(options)).toEqual({ outcome: 'captured', payment: payment() });
    });

    it.each(['Declined', 'SignatureVerificationRejected', 'Canceled'])('confirms %s against the payment intent', async (status) => {
        const options = setup();
        options.getSession.mockResolvedValue(session(status));
        options.getPayment.mockResolvedValue(payment('Created'));
        expect(await monitorDojoSession(options)).toEqual({
            outcome: status === 'Canceled' ? 'cancelled' : 'failed', status,
        });
        expect(options.getPayment).toHaveBeenCalledTimes(1);
    });

    it('accepts captured intent even when the session expired', async () => {
        const options = setup();
        options.getSession.mockResolvedValue(session('Expired'));
        expect((await monitorDojoSession(options)).outcome).toBe('captured');
    });

    it('leaves an unresolved expired session uncertain', async () => {
        const options = setup();
        options.getSession.mockResolvedValue(session('Expired'));
        options.getPayment.mockResolvedValue(payment('Created'));
        await expect(monitorDojoSession(options)).rejects.toThrow('could not be confirmed');
        expect(options.submitSignature).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['Live', 'Unknown', undefined])('never automatically cleans up an expired %s payment', async (apiEnvironment) => {
        const options = setup({ apiEnvironment });
        options.getSession.mockResolvedValue(session('Expired', payment('Created')));
        await expect(monitorDojoSession(options)).rejects.toThrow('could not be confirmed');
        expect(options.cancelExpiredSandboxPayment).not.toHaveBeenCalled();
        expect(options.cancel).not.toHaveBeenCalled();
    });

    it('confirms sandbox timeout cancellation with a fresh payment read after native cleanup', async () => {
        const options = setup({ apiEnvironment: 'Sandbox' });
        options.getSession.mockResolvedValue(session('Expired', payment('Created')));
        options.getPayment.mockResolvedValue(payment('Canceled'));
        expect(await monitorDojoSession(options)).toEqual({ outcome: 'cancelled', status: 'Canceled' });
        expect(options.cancelExpiredSandboxPayment).toHaveBeenCalledTimes(1);
        expect(options.getPayment).toHaveBeenCalledTimes(1);
        expect(options.cancelExpiredSandboxPayment.mock.invocationCallOrder[0])
            .toBeLessThan(options.getPayment.mock.invocationCallOrder[0]);
        expect(options.onMessage).toHaveBeenCalledWith(
            'Dojo test timed out. Confirming cancellation before another payment.', true,
        );
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([true, false])('keeps an unconfirmed sandbox cancellation uncertain when native cleanup succeeds: %s', async (succeeds) => {
        const options = setup({ apiEnvironment: 'Sandbox' });
        options.getSession.mockResolvedValue(session('Expired', payment('Created')));
        options.getPayment.mockResolvedValue(payment('Created'));
        if (!succeeds) options.cancelExpiredSandboxPayment.mockRejectedValue(new Error('Dojo unavailable'));
        await expect(monitorDojoSession(options)).rejects.toThrow('result is uncertain');
        expect(options.cancelExpiredSandboxPayment).toHaveBeenCalledTimes(1);
        expect(options.getPayment).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([true, false])('lets a fresh captured payment win a sandbox cancellation race when cleanup succeeds: %s', async (succeeds) => {
        const options = setup({ apiEnvironment: 'Sandbox' });
        options.getSession.mockResolvedValue(session('Expired', payment('Created')));
        if (!succeeds) options.cancelExpiredSandboxPayment.mockRejectedValue(new Error('Payment already captured'));
        expect(await monitorDojoSession(options)).toEqual({ outcome: 'captured', payment: payment() });
        expect(options.cancelExpiredSandboxPayment).toHaveBeenCalledTimes(1);
        expect(options.getPayment).toHaveBeenCalledTimes(1);
    });

    it('keeps the original reservation renewed while sandbox cleanup is pending', async () => {
        const options = setup({ apiEnvironment: 'Sandbox' });
        let resolveCleanup!: () => void;
        options.getSession.mockResolvedValue(session('Expired', payment('Created')));
        options.getPayment.mockResolvedValue(payment('Canceled'));
        options.cancelExpiredSandboxPayment.mockImplementation(() => new Promise((resolve) => { resolveCleanup = resolve; }));
        const result = monitorDojoSession(options);
        await vi.advanceTimersByTimeAsync(55_000);
        expect(options.refreshLease).toHaveBeenCalledTimes(2);
        expect(options.cancelExpiredSandboxPayment).toHaveBeenCalledTimes(1);
        expect(options.getPayment).not.toHaveBeenCalled();
        resolveCleanup();
        expect(await result).toEqual({ outcome: 'cancelled', status: 'Canceled' });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps sandbox cleanup uncertain if its fresh confirmation cannot be read', async () => {
        const options = setup({ apiEnvironment: 'Sandbox' });
        options.getSession.mockResolvedValue(session('Expired', payment('Created')));
        options.getPayment.mockRejectedValue(new Error('Network timeout'));
        await expect(monitorDojoSession(options)).rejects.toThrow('result is uncertain');
        expect(options.cancelExpiredSandboxPayment).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects an unrelated payment returned after sandbox cleanup', async () => {
        const options = setup({ apiEnvironment: 'Sandbox' });
        options.getSession.mockResolvedValue(session('Expired', payment('Created')));
        options.getPayment.mockResolvedValue({ ...payment('Canceled'), id: 'pi_other' });
        await expect(monitorDojoSession(options)).rejects.toThrow('different payment intent');
    });

    it('does not clean up a sandbox payment that has already progressed beyond Created', async () => {
        const options = setup({ apiEnvironment: 'Sandbox' });
        options.getSession.mockResolvedValue(session('Expired', payment('Authorized')));
        await expect(monitorDojoSession(options)).rejects.toThrow('could not be confirmed');
        expect(options.cancelExpiredSandboxPayment).not.toHaveBeenCalled();
    });

    it('does not clean up an expired sandbox session without matching provider identity', async () => {
        const options = setup({ apiEnvironment: 'Sandbox' });
        options.getSession.mockResolvedValue({ ...session('Expired', payment('Created')), id: 'ts_other' });
        await expect(monitorDojoSession(options)).rejects.toThrow('different terminal session or payment');
        expect(options.cancelExpiredSandboxPayment).not.toHaveBeenCalled();
    });

    it('fails closed if the reservation is lost during sandbox cleanup', async () => {
        const options = setup({ apiEnvironment: 'Sandbox' });
        let resolveCleanup!: () => void;
        options.getSession.mockResolvedValue(session('Expired', payment('Created')));
        options.cancelExpiredSandboxPayment.mockImplementation(() => new Promise((resolve) => { resolveCleanup = resolve; }));
        options.refreshLease.mockResolvedValue(false);
        const result = monitorDojoSession(options);
        const rejection = expect(result).rejects.toThrow('lost the Dojo terminal reservation');
        await vi.advanceTimersByTimeAsync(26_000);
        resolveCleanup();
        await rejection;
        expect(options.getPayment).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps timeouts uncertain and does not auto-reject a signature', async () => {
        const options = setup({ timeoutMs: 3_000 });
        options.getSession.mockResolvedValue(session('SignatureVerificationRequired'));
        const result = monitorDojoSession(options);
        const rejection = expect(result).rejects.toThrow('result is uncertain');
        await vi.advanceTimersByTimeAsync(3_000);
        await rejection;
        expect(options.cancel).toHaveBeenCalledTimes(1);
        expect(options.submitSignature).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not submit a decision when the owning page is disposed', async () => {
        let disposed = false;
        const options = setup({ isDisposed: () => disposed });
        options.getSession.mockResolvedValue(session('SignatureVerificationRequired'));
        const result = monitorDojoSession(options);
        const rejection = expect(result).rejects.toThrow('monitoring was interrupted');
        await vi.advanceTimersByTimeAsync(0);
        disposed = true;
        options.onSignatureRequired.mock.calls[0][0](false);
        await vi.advanceTimersByTimeAsync(1_000);
        await rejection;
        expect(options.submitSignature).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('fails closed if the shared terminal reservation is lost', async () => {
        const options = setup();
        options.getSession.mockResolvedValue(session('Initiated'));
        options.refreshLease.mockResolvedValue(false);
        const result = monitorDojoSession(options);
        const rejection = expect(result).rejects.toThrow('lost the Dojo terminal reservation');
        await vi.advanceTimersByTimeAsync(26_000);
        await rejection;
        expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects unrelated provider identity instead of applying it to this sale', async () => {
        const options = setup();
        options.getSession.mockResolvedValue({ ...session('Captured', payment()), paymentIntentId: 'pi_other' });
        await expect(monitorDojoSession(options)).rejects.toThrow('different terminal session or payment');
    });

    it('shows relevant terminal notifications without misreporting authorization as capture', () => {
        expect(dojoSessionMessage({ ...session('Initiated'), latestNotification: 'RemoveCard' })).toContain('remove');
        expect(dojoSessionMessage(session('Authorized'))).toContain('Waiting');
    });
});
