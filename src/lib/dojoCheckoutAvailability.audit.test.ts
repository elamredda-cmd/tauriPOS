import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { get } from 'svelte/store';
import { describe, expect, it, vi } from 'vitest';
import { checkoutCardAvailability } from './checkoutCardAvailability';
import { createTerminalConfigStore } from './terminalConfigStore';

// Execute production checkout guards and dispatch/commit branches with isolated
// provider/ledger spies. No native database, key or network is accessed.
const routeText = readFileSync(new URL('../routes/+page.svelte', import.meta.url), 'utf8');
const source = ts.createSourceFile('checkout.ts', routeText.match(/<script[^>]*>([\s\S]*?)<\/script>/)![1], ts.ScriptTarget.Latest, true);
const reactiveNames = ['cardAvailability', 'activeManagedProvider', 'cardConfigurationBlocked', 'managedCardEnabled',
    'managedTerminalNeedsSharedDatabase', 'managedTerminalConnectionBlocked', 'paymentCompleteDisabled'];
const reactive = source.statements.filter(node => ts.isLabeledStatement(node) && node.label.text === '$'
    && ts.isExpressionStatement(node.statement) && ts.isBinaryExpression(node.statement.expression)
    && reactiveNames.includes(node.statement.expression.left.getText(source)))
    .map(node => (node as ts.LabeledStatement).statement.getText(source)).join('\n');
const declaration = (name: string) => source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name) as ts.FunctionDeclaration;
const complete = declaration('completeSale');
const saleTry = complete.body!.statements.filter(ts.isTryStatement).at(-1)!;
const hasVariable = (node: ts.Node, names: string[]) => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(value => names.includes(value.name.getText(source)));
const confirmed = complete.body!.statements.filter(node => hasVariable(node,
    ['confirmedDojoConfig', 'confirmedSumupConfig', 'confirmedCardProvider'])).map(node => node.getText(source)).join('\n');
const preparation = saleTry.tryBlock.statements.filter(node => hasVariable(node, ['activeSumupConfig', 'activeDojoConfig'])
    || (ts.isIfStatement(node) && node.thenStatement.getText(source).includes('await refreshCheckoutCardConfig()')))
    .map(node => node.getText(source)).join('\n');
const branchNames = ['selectedCardProvider', 'usesManagedSumup', 'usesManagedDojo', 'basePaymentMethod', 'recordedPaymentMethod', 'committedSale'];
const saleBranch = saleTry.tryBlock.statements.filter(node => hasVariable(node, branchNames)
    || (ts.isIfStatement(node) && (node.expression.getText(source) === 'usesManagedSumup'
        || node.thenStatement.getText(source).includes('assertCheckoutCardConfiguration(activeDojoConfig, activeSumupConfig, selectedCardProvider)'))))
    .map(node => node.getText(source)).join('\n');
const js = (text: string) => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture() {
    const disabled = { enabled: false, ready: false, terminalOwnership: 'dedicated' };
    const dojo = createTerminalConfigStore({ ...disabled });
    const sumup = createTerminalConfigStore({ ...disabled });
    const state: Record<string, any> = {
        dojoConfigStore: dojo.config, sumupConfigStore: sumup.config,
        dojoConfigReadState: dojo.readState, sumupConfigReadState: sumup.readState,
        $connectionState: { mode: 'single', mysqlOnline: false },
        checkoutDraftBlocked: false, $pendingOnlineFinancialIntent: null, $pendingOnlineFinancialReadError: null,
        cashShortcutBusy: false, loyaltyCreditBusy: false, showNewPaymentCustomer: false, newPaymentCustomerSaving: false,
        isCompletingSale: false, completingCardProvider: null, paymentMethod: 'card', paymentInputAmount: 0, paymentDue: 100,
        cardCashPartInvalid: false, accountSaleAvailable: false, customerAccountBusy: false, trainingModeEnabled: false,
        cardAmount: 100, method: 'card', loyaltyCreditUsed: 0,
        saleBundle: { order: { id: 'isolated-audit-sale' }, payment: { amount: 100, cardAmount: 100 } },
        approvedManagedBundle: null, approvedManagedProvider: null,
        processManagedDojoPayment: vi.fn(async (_config, bundle) => bundle),
        processManagedSumupPayment: vi.fn(async (_config, bundle) => bundle),
        commitPreparedTerminalSale: vi.fn(async bundle => bundle), commitSale: vi.fn(async bundle => bundle),
        refreshPaymentTerminalAttempt: vi.fn(async () => ({ journalScope: 'local' })),
        formatMoney: () => '£1.00', console: { warn: vi.fn() }, isTauri: () => true, get, checkoutCardAvailability,
        readDojo: vi.fn(async () => get(dojo.config)), readSumup: vi.fn(async () => get(sumup.config)),
    };
    state.loadSumupConfig = vi.fn(() => sumup.read(state.readSumup));
    state.loadDojoConfig = vi.fn(() => dojo.read(state.readDojo));
    dojo.config.subscribe(value => state.$dojoConfigStore = value);
    sumup.config.subscribe(value => state.$sumupConfigStore = value);
    dojo.readState.subscribe(value => state.$dojoConfigReadState = value);
    sumup.readState.subscribe(value => state.$sumupConfigReadState = value);
    vm.createContext(state);
    vm.runInContext(js([declaration('refreshCheckoutCardConfig'), declaration('assertCheckoutCardConfiguration')].map(node => node.getText(source)).join('\n')), state);
    return {
        state, dojo, sumup,
        evaluate: () => {
            vm.runInContext(js(reactive), state);
            return { provider: state.activeManagedProvider, disabled: state.paymentCompleteDisabled };
        },
        startup: () => state.refreshCheckoutCardConfig(),
        commitBranch: () => vm.runInContext(js(`(async () => { ${confirmed}\n${preparation}\n${saleBranch}\n return { recordedPaymentMethod, committedSale }; })()`), state),
    };
}

describe('checkout card configuration safety regressions', () => {
    it.each(['Dojo', 'Sumup'])('blocks persistent %s read failure in UI and imperative sale dispatch', async provider => {
        const { state, startup, evaluate, commitBranch } = fixture();
        state[`read${provider}`].mockRejectedValue(new Error('Persistent synthetic settings failure'));
        await startup();
        expect(state.console.warn).toHaveBeenCalled();
        expect(evaluate().disabled).toBe(true);
        await expect(commitBranch()).rejects.toThrow('settings could not be read');
        expect(state.commitSale).not.toHaveBeenCalled();
        expect(state.processManagedDojoPayment).not.toHaveBeenCalled();
        expect(state.processManagedSumupPayment).not.toHaveBeenCalled();
    });

    it('does not fall back to healthy SumUp when enabled Dojo is not ready', async () => {
        const { state, dojo, sumup, startup, evaluate, commitBranch } = fixture();
        dojo.config.update(value => ({ ...value, enabled: true }));
        sumup.config.update(value => ({ ...value, enabled: true, ready: true }));
        await startup();
        expect(evaluate()).toEqual({ provider: 'dojo', disabled: true });
        await expect(commitBranch()).rejects.toThrow('Dojo is enabled but its setup is incomplete');
        expect(state.commitSale).not.toHaveBeenCalled();
        expect(state.processManagedSumupPayment).not.toHaveBeenCalled();
    });

    it('keeps card disabled until initial reads finish, then permits explicitly disabled manual card', async () => {
        const { state, startup, evaluate, commitBranch } = fixture();
        let finish!: (value: unknown) => void;
        state.readDojo.mockImplementation(() => new Promise(resolve => finish = resolve));
        const loading = startup();
        await Promise.resolve();
        expect(evaluate()).toEqual({ provider: null, disabled: true });
        finish(state.$dojoConfigStore);
        await loading;
        state.readDojo.mockImplementation(async () => state.$dojoConfigStore);
        expect(evaluate()).toEqual({ provider: null, disabled: false });
        expect((await commitBranch()).recordedPaymentMethod).toBe('card');
        expect(state.commitSale).toHaveBeenCalledOnce();
    });

    it.each(['dojo', 'sumup'] as const)('uses managed %s after verified healthy settings', async provider => {
        const setup = fixture();
        const { state, startup, evaluate, commitBranch } = setup;
        setup[provider].config.update(value => ({ ...value, enabled: true, ready: true }));
        await startup();
        expect(evaluate()).toEqual({ provider, disabled: false });
        expect((await commitBranch()).recordedPaymentMethod).toBe(provider);
        expect(state[provider === 'dojo' ? 'processManagedDojoPayment' : 'processManagedSumupPayment']).toHaveBeenCalledOnce();
        expect(state.commitPreparedTerminalSale).toHaveBeenCalledOnce();
        expect(state.commitSale).not.toHaveBeenCalled();
    });

    it('fresh submission blocks a new read error after a valid manual-card setup', async () => {
        const { state, startup, evaluate, commitBranch } = fixture();
        await startup();
        expect(evaluate().disabled).toBe(false);
        state.readDojo.mockRejectedValue(new Error('File became unreadable'));
        await expect(commitBranch()).rejects.toThrow('settings could not be read');
        expect(state.commitSale).not.toHaveBeenCalled();
        expect(evaluate().disabled).toBe(true);
    });

    it.each([true, false])('requires reconfirmation if submit refresh changes Dojo enabled from %s', async enabled => {
        const { state, dojo, startup, commitBranch } = fixture();
        dojo.config.update(value => ({ ...value, enabled, ready: true }));
        await startup();
        state.readDojo.mockResolvedValue({ ...get(dojo.config), enabled: !enabled });
        await expect(commitBranch()).rejects.toThrow('settings changed');
        expect(state.commitSale).not.toHaveBeenCalled();
        expect(state.processManagedDojoPayment).not.toHaveBeenCalled();
    });

    it('a successful retry restores Dojo after a failed read', async () => {
        const { state, dojo, startup, evaluate, commitBranch } = fixture();
        state.readDojo.mockRejectedValueOnce(new Error('Unreadable'));
        await startup();
        expect(evaluate().disabled).toBe(true);
        dojo.config.update(value => ({ ...value, enabled: true, ready: true }));
        await startup();
        expect(evaluate()).toEqual({ provider: 'dojo', disabled: false });
        await commitBranch();
        expect(state.processManagedDojoPayment).toHaveBeenCalledOnce();
    });

    it('rejects terminal changes after asynchronous receipt preparation', async () => {
        const { state, dojo, startup } = fixture();
        dojo.config.update(value => ({ ...value, enabled: true, ready: true }));
        await startup();
        const original = get(dojo.config);
        dojo.config.set({ ...original, terminalOwnership: 'shared' });
        expect(() => state.assertCheckoutCardConfiguration(original, state.$sumupConfigStore, 'dojo')).toThrow('settings changed');
        expect(state.commitSale).not.toHaveBeenCalled();
    });

    it.each(['cash', 'training', 'loyalty'])('does not block %s when settings cannot be read', async mode => {
        const { state, startup, evaluate } = fixture();
        state.readDojo.mockRejectedValue(new Error('Unreadable'));
        await startup();
        if (mode === 'cash') { state.paymentMethod = 'cash'; state.paymentInputAmount = 100; }
        if (mode === 'training') state.trainingModeEnabled = true;
        if (mode === 'loyalty') state.paymentDue = 0;
        expect(evaluate().disabled).toBe(false);
    });

    it('keeps the managed identity during background reads once dispatch has begun', async () => {
        const { state, startup, evaluate } = fixture();
        await startup();
        state.isCompletingSale = true;
        state.completingCardProvider = 'dojo';
        state.$dojoConfigReadState = 'loading';
        expect(evaluate()).toEqual({ provider: 'dojo', disabled: true });
    });
});

// Recovery overlap is covered by production-module orchestration regressions
// in terminalRecovery.integration.test.ts.
