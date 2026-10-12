import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { monitorDojoSession } from './dojoSessionFlow';

const customerSource = readFileSync(new URL('../routes/customers/+page.svelte', import.meta.url), 'utf8');

function script(source: string) {
    return ts.createSourceFile('route.ts', source.match(/<script[^>]*>([\s\S]*?)<\/script>/)![1], ts.ScriptTarget.Latest, true);
}

function functionText(name: string) {
    const source = script(customerSource);
    const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (!declaration) throw new Error(`Missing production function ${name}`);
    return declaration.getText(source);
}

function setup(environment = 'Sandbox') {
    const payment = { id: 'pi-account', reference: 'account-entry', amount: 200, currency: 'GBP', status: 'Created' };
    const context = vm.createContext({
        $dojoConfigStore: { apiEnvironment: environment, currency: 'GBP', terminalName: 'Mock terminal' },
        $storeDB: { name: 'Mock shop' }, accountCustomer: { name: 'Mock customer' },
        accountSaving: true, accountDojoMonitoring: false, accountTerminalCancelRequested: false,
        accountTerminalUncertain: false,
        accountTerminalStatus: '', customersMounted: true, dojoRetryDecision: null,
        dojoSignatureDecision: null, showDojoSignatureConfirm: false,
        now: () => '2026-10-12T12:00:00Z', dojoTerminalKey: () => 'mock-terminal',
        saveDojoAttempt: vi.fn(async value => value), isCustomerAccountPaymentPayload: () => true,
        acquireDojoLock: vi.fn(async () => ({ acquired: true })),
        refreshDojoLock: vi.fn(async () => true), releaseDojoLock: vi.fn(async () => undefined),
        updateDojoAttempt: vi.fn(async () => undefined), assertPaymentTerminalAttemptReady: vi.fn(async () => undefined),
        createDojoPayment: vi.fn(async () => ({ paymentIntentId: payment.id, terminalSessionId: 'ts-account' })),
        retryDojoPayment: vi.fn(), respondToDojoSignature: vi.fn(),
        cancelDojoTerminalSession: vi.fn(async () => undefined),
        cancelExpiredSandboxDojoPaymentIntent: vi.fn(async () => undefined),
        getDojoTerminalSessionStatus: vi.fn(async () => ({ id: 'ts-account', paymentIntentId: payment.id, status: 'Expired', payment })),
        getDojoPaymentIntentStatus: vi.fn(async () => ({ ...payment, status: 'Canceled' })),
        getDojoPaymentBreakdown: () => ({ tipsAmount: 0, serviceChargeAmount: 0, cashbackAmount: 0 }),
        dismissDojoSignatureDecision: vi.fn(), formatMoney: (value: number) => `£${value / 100}`,
        monitorDojoSession, console,
    });
    vm.runInContext(ts.transpileModule([
        functionText('takeDojoAccountPayment'), functionText('requestAccountTerminalCancellation'),
    ].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    return { context, payment, run: () => context.takeDojoAccountPayment(200, 'account-entry', 'till-mock', { kind: 'customer_account_payment' }) };
}

describe('production customer Dojo collection integration (mock provider, no charges)', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('wires the original journal ID to guarded sandbox cleanup and records cancellation only after fresh proof', async () => {
        const { context, run } = setup();
        await expect(run()).rejects.toThrow('payment was cancelled');
        expect(context.cancelExpiredSandboxDojoPaymentIntent).toHaveBeenCalledExactlyOnceWith('account-entry');
        expect(context.getDojoPaymentIntentStatus).toHaveBeenCalledExactlyOnceWith('pi-account');
        expect(context.updateDojoAttempt).toHaveBeenCalledWith('account-entry', 'cancelled', expect.anything());
        expect(context.updateDojoAttempt).not.toHaveBeenCalledWith('account-entry', 'approved', expect.anything());
        expect(context.accountDojoMonitoring).toBe(false);
        expect(context.accountTerminalStatus).toBe('Dojo cancelled. No account payment was recorded.');
        expect(context.accountTerminalUncertain).toBe(false);
        expect(context.releaseDojoLock).toHaveBeenCalledOnce();
    });

    it('replaces the decline decision prompt with the final not-approved result when returning to payment', async () => {
        const { context, payment, run } = setup();
        context.getDojoTerminalSessionStatus.mockResolvedValue({
            id: 'ts-account', paymentIntentId: payment.id, status: 'Declined', payment,
        });
        const result = expect(run()).rejects.toThrow('card payment was not approved');
        await vi.advanceTimersByTimeAsync(0);
        expect(context.accountTerminalStatus).toContain('Choose Try another card');
        context.dojoRetryDecision(false);
        await vi.advanceTimersByTimeAsync(1000);
        await result;
        expect(context.updateDojoAttempt).toHaveBeenCalledWith('account-entry', 'failed', expect.anything());
        expect(context.accountTerminalStatus).toBe('Dojo did not approve the card payment. No account payment was recorded.');
        expect(context.accountTerminalUncertain).toBe(false);
        expect(context.accountDojoMonitoring).toBe(false);
        expect(context.retryDojoPayment).not.toHaveBeenCalled();
        expect(context.cancelExpiredSandboxDojoPaymentIntent).not.toHaveBeenCalled();
    });

    it('keeps a cleanup acknowledgement without final provider proof uncertain', async () => {
        const { context, payment, run } = setup();
        context.getDojoPaymentIntentStatus.mockResolvedValue(payment);
        await expect(run()).rejects.toThrow('result is uncertain');
        expect(context.updateDojoAttempt).toHaveBeenCalledWith('account-entry', 'uncertain', expect.anything());
        expect(context.updateDojoAttempt).not.toHaveBeenCalledWith('account-entry', 'cancelled', expect.anything());
        expect(context.accountTerminalUncertain).toBe(true);
        expect(context.accountTerminalStatus).toContain('Do not take this payment again');
    });

    it('lets late capture win even when the native cleanup rejects cancellation', async () => {
        const { context, payment, run } = setup();
        context.cancelExpiredSandboxDojoPaymentIntent.mockRejectedValue(new Error('Already captured'));
        context.getDojoPaymentIntentStatus.mockResolvedValue({ ...payment, status: 'Captured' });
        await expect(run()).resolves.toContain('Dojo pi-account');
        expect(context.updateDojoAttempt).toHaveBeenCalledWith('account-entry', 'approved', expect.anything());
        expect(context.updateDojoAttempt).not.toHaveBeenCalledWith('account-entry', 'cancelled', expect.anything());
    });

    it.each(['Live', 'Unknown'])('never invokes sandbox cleanup for %s', async environment => {
        const { context, run } = setup(environment);
        await expect(run()).rejects.toThrow('could not be confirmed');
        expect(context.cancelExpiredSandboxDojoPaymentIntent).not.toHaveBeenCalled();
        expect(context.updateDojoAttempt).toHaveBeenCalledWith('account-entry', 'uncertain', expect.anything());
    });

    it('exposes cancellation while waiting, sends once, and continues to reconcile a late capture', async () => {
        const { context, payment, run } = setup();
        context.getDojoTerminalSessionStatus
            .mockResolvedValueOnce({ id: 'ts-account', paymentIntentId: payment.id, status: 'Initiated' })
            .mockResolvedValue({ id: 'ts-account', paymentIntentId: payment.id, status: 'Captured', payment: { ...payment, status: 'Captured' } });
        const result = run();
        await vi.advanceTimersByTimeAsync(0);
        expect(context.accountDojoMonitoring).toBe(true);
        context.requestAccountTerminalCancellation();
        context.requestAccountTerminalCancellation();
        expect(context.accountTerminalCancelRequested).toBe(true);
        expect(context.updateDojoAttempt).not.toHaveBeenCalledWith('account-entry', 'cancelled', expect.anything());
        await vi.advanceTimersByTimeAsync(1000);
        await expect(result).resolves.toContain('Dojo pi-account');
        expect(context.cancelDojoTerminalSession).toHaveBeenCalledExactlyOnceWith('ts-account');
        expect(context.accountDojoMonitoring).toBe(false);
        expect(customerSource).toMatch(/\{#if accountSaving && accountDojoMonitoring && !accountManagedCardApproved\}[\s\S]*?on:click=\{requestAccountTerminalCancellation\}[\s\S]*?'Cancel Terminal'/);
    });
});

describe('both production Dojo callers provide sandbox-expiry cleanup', () => {
    it.each(['../routes/+page.svelte', '../routes/customers/+page.svelte'])('%s binds the durable original attempt ID', async route => {
        const source = script(readFileSync(new URL(route, import.meta.url), 'utf8'));
        let options: ts.ObjectLiteralExpression | undefined;
        const visit = (node: ts.Node) => {
            if (ts.isCallExpression(node) && node.expression.getText(source) === 'monitorDojoSession'
                && ts.isObjectLiteralExpression(node.arguments[0])) options = node.arguments[0];
            ts.forEachChild(node, visit);
        };
        visit(source);
        const property = options?.properties.find(node => ts.isPropertyAssignment(node)
            && node.name.getText(source) === 'cancelExpiredSandboxPayment');
        expect(property, 'Missing production expiry-cleanup integration').toBeDefined();
        const initializer = (property as ts.PropertyAssignment).initializer.getText(source);
        const cancel = vi.fn(async () => undefined);
        const callback = vm.runInNewContext(`(${initializer})`, {
            reference: 'durable-original-attempt', cancelExpiredSandboxDojoPaymentIntent: cancel,
        });
        await callback();
        expect(cancel).toHaveBeenCalledExactlyOnceWith('durable-original-attempt');
    });
});
