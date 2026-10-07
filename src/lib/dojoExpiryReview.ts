import type { DojoPaymentIntentStatus } from './dojo';
import type { TerminalPaymentAttempt } from './terminalAttempts';
import type { TerminalPaymentExtras } from './terminalAttemptState';

export interface DojoOperatorResolution extends TerminalPaymentExtras {
    version: 1;
    attemptId: string;
    paymentIntentId: string;
    terminalSessionId: string;
    decision: 'paid' | 'not_paid';
    amount: number;
    currency: string;
    receiptReference: string;
    note: string;
    employeeId: string;
    employeeName: string;
    createdAt: string;
}

export function readDojoOperatorResolution(attempt: TerminalPaymentAttempt, payment: DojoPaymentIntentStatus): DojoOperatorResolution | null {
    if (!attempt.operatorResolution) return null;
    const proof = JSON.parse(attempt.operatorResolution) as DojoOperatorResolution;
    if (proof.version !== 1 || proof.attemptId !== attempt.id
        || proof.paymentIntentId !== attempt.clientTransactionId || proof.paymentIntentId !== payment.id
        || payment.reference !== attempt.id || proof.amount !== attempt.amount || proof.currency !== attempt.currency
        || !proof.terminalSessionId || proof.terminalSessionId !== (payment.latestTerminalSessionId || attempt.terminalSessionId)
        || payment.terminalHistoryError || payment.moneyValidationError
        || payment.amount !== attempt.amount || payment.currency !== attempt.currency
        || !['paid', 'not_paid'].includes(proof.decision) || !proof.employeeId || !proof.employeeName
        || !proof.receiptReference || !proof.note || !Number.isFinite(Date.parse(proof.createdAt))
        || [proof.tipsAmount, proof.serviceChargeAmount, proof.cashbackAmount].some(value => !Number.isSafeInteger(value) || value < 0)) {
        throw new Error('The recorded administrator review does not match this Dojo payment. Keep it unresolved for review.');
    }
    return proof;
}
