import { describe, expect, it } from 'vitest';
import { verifyDojoPayment, classifyDojoPaymentStatus } from './terminalRecovery';
import type { TerminalPaymentAttempt } from './terminalAttempts';

const resolution = { version: 1, attemptId: 'sale-1', paymentIntentId: 'pi-1', terminalSessionId: 'ts-1',
    decision: 'paid', amount: 600, currency: 'GBP', receiptReference: 'receipt-123', note: 'Checked merchant receipt',
    tipsAmount: 60, serviceChargeAmount: 0, cashbackAmount: 200,
    employeeId: 'admin-1', employeeName: 'Manager', createdAt: '2026-09-28T10:00:00Z' };
const attempt = { id: 'sale-1', provider: 'dojo', clientTransactionId: 'pi-1', terminalSessionId: 'ts-1',
    amount: 600, currency: 'GBP', operatorResolution: JSON.stringify(resolution) } as TerminalPaymentAttempt;
const payment = { id: 'pi-1', reference: 'sale-1', status: 'Created', amount: 600, currency: 'GBP', latestTerminalSessionId: 'ts-1' };

describe('receipt-checked Dojo expiry decisions', () => {
    it('recovers a recorded success once, with its original amount and separately entered extras', () => {
        expect(verifyDojoPayment(attempt, payment, 'ts-1', 'Expired')).toMatchObject({ outcome: 'approved',
            extras: { tipsAmount: 60, serviceChargeAmount: 0, cashbackAmount: 200 },
            providerReference: expect.stringContaining('receipt confirmed by Manager') });
    });
    it('never invents success for an unreviewed expired payment', () => {
        expect(verifyDojoPayment({ ...attempt, operatorResolution: '' }, payment, 'ts-1', 'Expired').outcome).toBe('uncertain');
    });
    it.each([{ amount: 601 }, { paymentIntentId: 'pi-other' }, { terminalSessionId: 'ts-other' },
        { employeeId: '' }, { tipsAmount: -1 }, { createdAt: 'bad' }])('rejects a mismatched or malformed review %j', patch => {
        expect(verifyDojoPayment({ ...attempt, operatorResolution: JSON.stringify({ ...resolution, ...patch }) }, payment).outcome).toBe('uncertain');
    });
    it('requires canceled provider proof for a not-paid review', () => {
        const failed = { ...attempt, operatorResolution: JSON.stringify({ ...resolution, decision: 'not_paid', tipsAmount: 0, cashbackAmount: 0 }) };
        expect(verifyDojoPayment(failed, payment).outcome).toBe('uncertain');
        expect(verifyDojoPayment(failed, { ...payment, status: 'Canceled' })).toMatchObject({ outcome: 'cancelled', finalityAlreadyConfirmed: true });
        expect(verifyDojoPayment(failed, { ...payment, status: 'Captured' }).outcome).toBe('approved');
    });
    it('keeps a contradicting provider outcome unresolved', () => {
        expect(verifyDojoPayment(attempt, { ...payment, status: 'Canceled' }).outcome).toBe('uncertain');
        expect(verifyDojoPayment(attempt, { ...payment, latestTerminalSessionId: 'ts-new' }).outcome).toBe('uncertain');
        expect(classifyDojoPaymentStatus('Authorized', 'Declined')).toBe('uncertain');
    });
});
