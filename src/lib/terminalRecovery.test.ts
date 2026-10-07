import { describe, expect, it } from 'vitest';
import {
    classifyDojoPaymentStatus,
    classifySumupPaymentStatus,
    providerMissingReconciliation,
    settleRecoveredProviderOutcome,
    settleProviderFinalReconciliation,
    verifyDojoPayment,
} from './terminalRecovery';
import {
    inferTerminalOperationKind,
    isOperationalTerminalAttemptStatus,
    type CustomerAccountPaymentAttemptPayload,
    type TerminalPaymentAttempt,
} from './terminalAttempts';
import {
    isTerminalAttemptTransitionAllowed,
    mergeTerminalAttemptSnapshots,
    terminalAttemptUpdatePredecessors,
} from './terminalAttemptState';

describe('managed terminal recovery safety', () => {
    it('requires exact Dojo payment identity before every negative final result', () => {
        const attempt = { id: 'sale-1', clientTransactionId: 'pi-1', amount: 1250, currency: 'GBP' } as TerminalPaymentAttempt;
        for (const [status, terminal] of [['Canceled', 'Expired'], ['Reversed', 'Captured'], ['Created', 'Declined'], ['Created', 'SignatureVerificationRejected']]) {
            const payment = { id: 'pi-1', reference: 'sale-1', status, amount: 1250, currency: 'GBP' };
            expect(verifyDojoPayment(attempt, { ...payment, id: 'wrong' }, 'ts-1', terminal).outcome).toBe('uncertain');
            expect(verifyDojoPayment(attempt, { ...payment, reference: 'wrong' }, 'ts-1', terminal).outcome).toBe('uncertain');
        }
        expect(verifyDojoPayment(attempt, { id: 'pi-1', reference: 'sale-1', status: 'Created' }, 'ts-1', 'Expired'))
            .toMatchObject({ outcome: 'uncertain', error: expect.stringContaining('terminal Expired, payment intent Created') });
    });

    it('returns captured Dojo extras separately from the prepared base payment', () => {
        const attempt = { id: 'sale-1', clientTransactionId: 'pi-1', amount: 1250, currency: 'GBP' } as TerminalPaymentAttempt;
        const result = verifyDojoPayment(attempt, {
            id: 'pi-1', reference: 'sale-1', status: 'Captured', amount: 1250, currency: 'GBP',
            totalAmount: { value: 1900, currencyCode: 'GBP' },
            tipsAmount: { value: 120, currencyCode: 'GBP' },
            serviceChargeAmount: { value: 30, currencyCode: 'GBP' },
            cashbackAmount: { value: 500, currencyCode: 'GBP' },
        });
        expect(result).toMatchObject({ outcome: 'approved', extras: { tipsAmount: 120, serviceChargeAmount: 30, cashbackAmount: 500 } });
        expect(attempt.amount).toBe(1250);
    });

    it('does not approve recovery with a conflicting intent or extra total', () => {
        const attempt = { id: 'sale-1', clientTransactionId: 'pi-1', amount: 1250, currency: 'GBP' } as TerminalPaymentAttempt;
        const payment = { id: 'pi-1', reference: 'sale-1', status: 'Captured', amount: 1250, currency: 'GBP' };
        expect(verifyDojoPayment(attempt, { ...payment, id: 'pi-other' }).outcome).toBe('uncertain');
        expect(verifyDojoPayment(attempt, {
            ...payment, totalAmount: { value: 1250, currencyCode: 'GBP' }, tipsAmount: { value: 120, currencyCode: 'GBP' },
        }).outcome).toBe('uncertain');
    });

    it('keeps every unresolved journal state operational', () => {
        for (const status of [
            'prepared',
            'started',
            'uncertain',
            'approved',
            'commit_failed',
            'completion_pending',
        ]) {
            expect(isOperationalTerminalAttemptStatus(status)).toBe(true);
        }
        for (const status of ['completed', 'failed', 'cancelled']) {
            expect(isOperationalTerminalAttemptStatus(status)).toBe(false);
        }
    });

    it('never treats ambiguous provider states as a safe retry', () => {
        expect(classifySumupPaymentStatus('CANCEL_FAILED')).toBe('uncertain');
        expect(classifySumupPaymentStatus('PENDING')).toBe('uncertain');
        expect(classifyDojoPaymentStatus('Authorized', 'Expired')).toBe('uncertain');
        expect(classifyDojoPaymentStatus('Created', 'Expired')).toBe('uncertain');
        expect(classifyDojoPaymentStatus('Created', 'Initiated')).toBe('uncertain');
    });

    it('only finalizes explicit authoritative decline or cancellation', () => {
        expect(classifySumupPaymentStatus('FAILED')).toBe('failed');
        expect(classifySumupPaymentStatus('CANCELLED')).toBe('cancelled');
        expect(classifyDojoPaymentStatus('Created', 'Declined')).toBe('failed');
        expect(classifyDojoPaymentStatus('Canceled', 'Canceled')).toBe('cancelled');
        expect(classifyDojoPaymentStatus('Captured', 'Expired')).toBe('approved');
    });

    it('does not clear one fresh or one old provider-not-found observation', () => {
        const now = Date.parse('2026-07-29T12:00:00.000Z');
        const fresh = providerMissingReconciliation({
            createdAt: '2026-07-29T11:59:00.000Z',
            error: '',
        }, 'sumup', now);
        const oldButFirstObservation = providerMissingReconciliation({
            createdAt: '2026-07-27T12:00:00.000Z',
            error: '',
        }, 'sumup', now);
        expect(fresh.outcome).toBe('uncertain');
        expect(oldButFirstObservation.outcome).toBe('uncertain');
    });

    it('requires three durable missing observations spanning 24 hours', () => {
        const firstAt = Date.parse('2026-07-28T08:00:00.000Z');
        const createdAt = '2026-07-27T08:00:00.000Z';
        const first = providerMissingReconciliation({ createdAt, error: '' }, 'dojo', firstAt);
        expect(first.outcome).toBe('uncertain');
        const second = providerMissingReconciliation(
            { createdAt, error: 'error' in first ? first.error : '' },
            'dojo',
            firstAt + 25 * 60 * 60 * 1000,
        );
        expect(second.outcome).toBe('uncertain');
        const third = providerMissingReconciliation(
            { createdAt, error: 'error' in second ? second.error : '' },
            'dojo',
            firstAt + 25 * 60 * 60 * 1000 + 60_000,
        );
        expect(third.outcome).toBe('cancelled');
    });

    it('completes missing-provider recovery without restarting its settled evidence', () => {
        const firstAt = Date.parse('2026-07-28T08:00:00.000Z');
        const attempt = { createdAt: '2026-07-27T08:00:00.000Z', error: '' };
        const results = [firstAt, firstAt + 25 * 60 * 60 * 1000, firstAt + 25 * 60 * 60 * 1000 + 60_000]
            .map((now) => {
                const result = settleRecoveredProviderOutcome(
                    attempt, 'dojo', providerMissingReconciliation(attempt, 'dojo', now), now,
                );
                if ('error' in result) attempt.error = result.error;
                return result;
            });

        expect(results.map((result) => result.outcome)).toEqual(['uncertain', 'uncertain', 'cancelled']);
        expect(attempt.error).toMatch(/^PROVIDER_NOT_FOUND:dojo:/);
        expect(results[2]).toMatchObject({ finalityAlreadyConfirmed: true });
    });

    it('still settles ordinary provider finals and immediately preserves capture evidence', () => {
        const now = Date.parse('2026-07-29T12:00:00.000Z');
        expect(settleRecoveredProviderOutcome({ error: '' }, 'dojo', {
            outcome: 'failed', error: 'Dojo final status: Declined',
        }, now).outcome).toBe('uncertain');
        const captured = { outcome: 'approved' as const, clientTransactionId: 'pi-original', providerReference: 'Dojo captured' };
        expect(settleRecoveredProviderOutcome({ error: '' }, 'dojo', captured, now)).toBe(captured);
    });

    it('keeps an explicit failure operational until a separated confirmation', () => {
        const firstAt = Date.parse('2026-07-29T12:00:00.000Z');
        const first = settleProviderFinalReconciliation(
            { error: '' },
            'sumup',
            'failed',
            'SumUp final status: FAILED',
            firstAt,
        );
        expect(first.outcome).toBe('uncertain');

        const tooSoon = settleProviderFinalReconciliation(
            { error: 'error' in first ? first.error : '' },
            'sumup',
            'failed',
            'SumUp final status: FAILED',
            firstAt + 5_000,
        );
        expect(tooSoon.outcome).toBe('uncertain');

        const confirmed = settleProviderFinalReconciliation(
            { error: 'error' in first ? first.error : '' },
            'sumup',
            'failed',
            'SumUp final status: FAILED',
            firstAt + 31_000,
        );
        expect(confirmed.outcome).toBe('failed');
    });

    it('resets final confirmation when the provider outcome changes', () => {
        const firstAt = Date.parse('2026-07-29T12:00:00.000Z');
        const failed = settleProviderFinalReconciliation(
            { error: '' }, 'dojo', 'failed', 'Dojo final status: Declined', firstAt,
        );
        const cancelled = settleProviderFinalReconciliation(
            { error: 'error' in failed ? failed.error : '' },
            'dojo',
            'cancelled',
            'Dojo final status: Canceled',
            firstAt + 60_000,
        );
        expect(cancelled.outcome).toBe('uncertain');
    });

    it('recognizes customer-account payloads as a separate ledger operation', () => {
        const payload: CustomerAccountPaymentAttemptPayload = {
            kind: 'customer_account_payment',
            customerId: 'customer-1',
            amountPence: -1250,
            paymentMethod: 'card',
            reference: '',
            description: 'Card account payment',
            employeeId: 'employee-1',
            tillNumber: 'till-1',
            shiftId: 'shift-1',
            idempotencyKey: 'payment-1',
            allowCreditBalance: true,
        };
        expect(inferTerminalOperationKind(payload)).toBe('customer_account_payment');
    });

    it('makes terminal journal transitions monotonic', () => {
        expect(isTerminalAttemptTransitionAllowed('started', 'uncertain')).toBe(true);
        expect(isTerminalAttemptTransitionAllowed('uncertain', 'approved')).toBe(true);
        expect(isTerminalAttemptTransitionAllowed('approved', 'commit_failed')).toBe(true);
        expect(isTerminalAttemptTransitionAllowed('commit_failed', 'completion_pending')).toBe(true);
        expect(isTerminalAttemptTransitionAllowed('completion_pending', 'completed')).toBe(true);

        expect(isTerminalAttemptTransitionAllowed('approved', 'uncertain')).toBe(false);
        expect(isTerminalAttemptTransitionAllowed('commit_failed', 'failed')).toBe(false);
        expect(isTerminalAttemptTransitionAllowed('completion_pending', 'cancelled')).toBe(false);
        expect(isTerminalAttemptTransitionAllowed('completed', 'approved')).toBe(false);
        expect(isTerminalAttemptTransitionAllowed('failed', 'started')).toBe(false);
        expect(isTerminalAttemptTransitionAllowed('cancelled', 'prepared')).toBe(false);

        // A final same-state request is idempotent but must not run UPDATE and
        // mutate its payload/reference fields.
        expect(terminalAttemptUpdatePredecessors('completed')).not.toContain('completed');
        expect(terminalAttemptUpdatePredecessors('failed')).not.toContain('failed');
        expect(terminalAttemptUpdatePredecessors('cancelled')).not.toContain('cancelled');
    });

    it('merges clock-skewed shared rows without downgrading or replacing provider proof', () => {
        const local = {
            status: 'completed',
            clientTransactionId: 'txn-new',
            terminalSessionId: 'session-new',
            providerReference: 'provider-new',
            createdAt: '2099-01-01T00:00:00.000Z',
            updatedAt: '2099-01-01T00:01:00.000Z',
            payloadMarker: 'newer-local-payload',
        };
        const staleRemote = {
            status: 'uncertain',
            clientTransactionId: 'txn-old',
            terminalSessionId: 'session-old',
            providerReference: 'provider-old',
            createdAt: '2026-07-29T12:00:00.000Z',
            updatedAt: '2026-07-29T12:01:00.000Z',
            payloadMarker: 'stale-remote-payload',
        };
        const merged = mergeTerminalAttemptSnapshots(local, staleRemote);
        expect(merged.status).toBe('completed');
        expect(merged.clientTransactionId).toBe('txn-new');
        expect(merged.terminalSessionId).toBe('session-new');
        expect(merged.providerReference).toBe('provider-new');
        expect(merged.payloadMarker).toBe('newer-local-payload');
        // Timestamps still move onto MariaDB's clock domain.
        expect(merged.createdAt).toBe(staleRemote.createdAt);
        expect(merged.updatedAt).toBe(staleRemote.updatedAt);

        const sharedApproval = mergeTerminalAttemptSnapshots(
            { ...staleRemote, status: 'started', providerReference: '', payloadMarker: 'local' },
            { ...staleRemote, status: 'approved', providerReference: 'provider-approved', payloadMarker: 'remote' },
        );
        expect(sharedApproval.status).toBe('approved');
        expect(sharedApproval.providerReference).toBe('provider-approved');
        expect(sharedApproval.payloadMarker).toBe('remote');
    });
});
