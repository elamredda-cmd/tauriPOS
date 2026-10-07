import type { DojoPaymentIntentStatus, DojoTerminalSessionStatus } from './dojo';

export type DojoSessionResult =
    | { outcome: 'captured'; payment: DojoPaymentIntentStatus }
    | { outcome: 'failed' | 'cancelled'; status: string };

export interface DojoSessionFlowOptions {
    paymentIntentId: string;
    terminalSessionId: string;
    apiEnvironment?: string;
    getSession: () => Promise<DojoTerminalSessionStatus>;
    getPayment: () => Promise<DojoPaymentIntentStatus>;
    submitSignature: (accepted: boolean) => Promise<void>;
    cancel: () => Promise<void>;
    /** Native-guarded cleanup, called only while this monitor still owns its lease. */
    cancelExpiredSandboxPayment?: () => Promise<void>;
    retry?: () => Promise<string>;
    onDeclined?: (decide: (retry: boolean) => void) => void;
    onDeclineDismiss?: () => void;
    refreshLease: () => Promise<boolean>;
    onSignatureRequired: (decide: (accepted: boolean) => void) => void;
    onSignatureDismiss: () => void;
    onMessage: (message: string, cancelling: boolean) => void;
    shouldCancel?: () => boolean;
    isDisposed?: () => boolean;
    timeoutMs?: number;
    pollIntervalMs?: number;
    leaseIntervalMs?: number;
}

export function dojoSessionMessage(session: DojoTerminalSessionStatus): string {
    switch (session.status) {
        case 'SignatureVerificationRequired': return 'Check the customer signature and choose accept or reject';
        case 'SignatureVerificationAccepted': return 'Signature accepted by Dojo. Waiting for confirmed capture';
        case 'Authorized': return 'Card authorized. Waiting for Dojo to confirm capture';
        case 'CancelRequested': return 'Cancellation requested. Waiting for the Dojo result';
    }
    switch (session.latestNotification) {
        case 'PresentCard': return 'Ask the customer to tap or insert their card';
        case 'EnterPin': return 'Waiting for the customer to enter their PIN';
        case 'RemoveCard': return 'Ask the customer to remove their card';
        case 'PleaseWait': return 'Dojo is processing the card';
        case 'SignatureVerification': return 'Customer signature needs approval';
        default: return 'Waiting for the Dojo terminal';
    }
}

const paymentCheckStatuses = new Set([
    'Captured', 'Authorized', 'SignatureVerificationAccepted',
    'SignatureVerificationRejected', 'Canceled', 'Declined', 'Expired',
]);

/**
 * Observe one already-created session. Operator prompts and control requests do
 * not block either polling or lease renewal, and never decide the payment result.
 */
export async function monitorDojoSession(options: DojoSessionFlowOptions): Promise<DojoSessionResult> {
    let deadline = Date.now() + (options.timeoutMs ?? 180_000);
    let terminalSessionId = options.terminalSessionId;
    let declinePrompted = false;
    let declineDecision: boolean | null = null;
    const delay = () => new Promise<void>((resolve) => setTimeout(resolve, options.pollIntervalMs ?? 1_000));
    let active = true;
    let leaseRefreshing = false;
    let leaseFailure = '';
    let signaturePrompted = false;
    let signatureSubmitted = false;
    let signaturePromptActive = false;
    let signatureResponseUncertain = false;
    let cancelSent = false;
    let sandboxCleanupSent = false;
    let cancelling = false;
    let controlWarning = '';
    let lastReadError = '';

    const publish = (message: string) => {
        if (active && !options.isDisposed?.()) options.onMessage(message, cancelling);
    };
    const dismissSignature = () => {
        signaturePromptActive = false;
        options.onSignatureDismiss();
    };
    const assertObserving = () => {
        if (options.isDisposed?.()) {
            throw new Error('Dojo payment monitoring was interrupted. The result is uncertain; do not retry the card.');
        }
        if (leaseFailure) throw new Error(leaseFailure);
    };
    const requestCancellation = () => {
        if (cancelSent) return;
        cancelSent = true;
        cancelling = true;
        publish('Requesting cancellation on the Dojo terminal');
        void options.cancel().then(() => {
            if (sandboxCleanupSent) return;
            publish('Cancellation requested. Waiting for the Dojo result');
        }).catch((error) => {
            if (!active || sandboxCleanupSent) return;
            cancelling = false;
            controlWarning = `Dojo cancellation was not confirmed (${String(error)}). Continuing to check the payment; do not retry the card.`;
            publish(controlWarning);
        });
    };

    // This is independent of the read loop and signature dialog. Slow provider
    // requests must not allow an otherwise healthy till's reservation to lapse.
    const leaseTimer = setInterval(() => {
        if (!active || leaseRefreshing || options.isDisposed?.()) return;
        leaseRefreshing = true;
        void options.refreshLease().then((renewed) => {
            if (active && !renewed) {
                leaseFailure = 'This till lost the Dojo terminal reservation. The result is uncertain; check Dojo before retrying.';
            }
        }).catch(() => {
            if (active) leaseFailure = 'The Dojo terminal reservation could not be renewed. The result is uncertain; check Dojo before retrying.';
        }).finally(() => { leaseRefreshing = false; });
    }, options.leaseIntervalMs ?? 25_000);

    try {
        while (Date.now() < deadline) {
            assertObserving();
            if (options.shouldCancel?.()) requestCancellation();

            let session: DojoTerminalSessionStatus;
            try {
                session = await options.getSession();
            } catch (error) {
                lastReadError = String(error);
                publish('The Dojo result is not available yet. Still checking; do not retry the card.');
                await delay();
                continue;
            }
            assertObserving();
            if (session.id !== terminalSessionId
                || (session.paymentIntentId && session.paymentIntentId !== options.paymentIntentId)) {
                throw new Error('Dojo returned a different terminal session or payment. The result is uncertain; do not retry the card.');
            }

            if (session.status !== 'SignatureVerificationRequired') dismissSignature();
            if (session.status === 'SignatureVerificationRequired' && !signaturePrompted) {
                signaturePrompted = true;
                signaturePromptActive = true;
                options.onSignatureRequired((accepted) => {
                    if (!active || !signaturePromptActive || signatureSubmitted || options.isDisposed?.()) return;
                    signatureSubmitted = true;
                    dismissSignature();
                    publish('Sending signature decision. Waiting for the confirmed Dojo result');
                    void options.submitSignature(accepted).catch((error) => {
                        if (!active) return;
                        signatureResponseUncertain = true;
                        controlWarning = `The signature response was not confirmed (${String(error)}). Checking the final Dojo result; do not retry the card.`;
                        publish(controlWarning);
                    });
                });
            }

            let payment = session.payment;
            if (!payment && (paymentCheckStatuses.has(session.status) || signatureResponseUncertain)) {
                try {
                    payment = await options.getPayment();
                } catch (error) {
                    lastReadError = String(error);
                    publish('Checking the final Dojo payment result; do not retry the card.');
                    await delay();
                    continue;
                }
            }
            assertObserving();
            if (payment && payment.id !== options.paymentIntentId) {
                throw new Error('Dojo returned a different payment intent. The result is uncertain; do not retry the card.');
            }
            // The payment intent wins over late/stale terminal or control results.
            if (payment?.status === 'Captured') return { outcome: 'captured', payment };
            if (payment?.status === 'Canceled' || payment?.status === 'Reversed') {
                return { outcome: 'cancelled', status: payment.status };
            }
            if (payment?.status === 'Created') {
                if (session.status === 'Canceled') return { outcome: 'cancelled', status: session.status };
                if (session.status === 'Declined' || session.status === 'SignatureVerificationRejected') {
                    if (options.onDeclined && options.retry) {
                        if (!declinePrompted) {
                            declinePrompted = true;
                            options.onDeclined((retry) => {
                                if (active && declineDecision === null) declineDecision = retry;
                            });
                        }
                        if (declineDecision === true) {
                            options.onDeclineDismiss?.();
                            publish('Retrying the same payment. Ask the customer to use another card.');
                            terminalSessionId = await options.retry();
                            assertObserving();
                            deadline = Date.now() + (options.timeoutMs ?? 180_000);
                            declinePrompted = signaturePrompted = signatureSubmitted = signatureResponseUncertain = cancelSent = false;
                            declineDecision = null;
                            controlWarning = '';
                            cancelling = false;
                            continue;
                        }
                        if (declineDecision === null && !options.shouldCancel?.()) {
                            publish('Card declined. Choose Try another card or Return to payment.');
                            await delay();
                            continue;
                        }
                    }
                    return { outcome: 'failed', status: session.status };
                }
            }
            if (session.status === 'Expired') {
                if (options.apiEnvironment === 'Sandbox'
                    && payment?.status === 'Created'
                    && options.cancelExpiredSandboxPayment
                    && !sandboxCleanupSent) {
                    sandboxCleanupSent = true;
                    cancelling = true;
                    publish('Dojo test timed out. Confirming cancellation before another payment.');
                    // The native command independently checks the stored sandbox
                    // key, durable journal, and provider identity before cancelling.
                    // Keep the original lease alive throughout cleanup and proof.
                    let cleanupError = '';
                    try {
                        await options.cancelExpiredSandboxPayment();
                    } catch (error) {
                        cleanupError = String(error);
                    }
                    assertObserving();
                    let freshPayment: DojoPaymentIntentStatus | undefined;
                    try {
                        freshPayment = await options.getPayment();
                    } catch (error) {
                        cleanupError ||= String(error);
                    }
                    assertObserving();
                    if (freshPayment && freshPayment.id !== options.paymentIntentId) {
                        throw new Error('Dojo returned a different payment intent. The result is uncertain; do not retry the card.');
                    }
                    // A late capture wins even if the cancellation request failed.
                    if (freshPayment?.status === 'Captured') return { outcome: 'captured', payment: freshPayment };
                    if (freshPayment?.status === 'Canceled' || freshPayment?.status === 'Reversed') {
                        return { outcome: 'cancelled', status: freshPayment.status };
                    }
                    throw new Error(`The Dojo test timed out, but cancellation could not be confirmed. The result is uncertain; check Dojo before retrying.${cleanupError ? ` ${cleanupError}` : ''}`);
                }
                throw new Error('The Dojo session expired and payment could not be confirmed. Check the terminal screen or receipt, then ask an administrator to open Reports → Payment checks → Review expired payment to record the result. Do not retry until reviewed.');
            }
            publish(controlWarning || dojoSessionMessage(session));
            await delay();
        }
        requestCancellation();
        throw new Error(`Dojo did not return a final result in time. The result is uncertain; check the terminal and Dojo portal before retrying.${lastReadError ? ` Last check: ${lastReadError}` : ''}`);
    } finally {
        active = false;
        clearInterval(leaseTimer);
        dismissSignature();
        options.onDeclineDismiss?.();
    }
}
