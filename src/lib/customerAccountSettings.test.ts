import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const route = readFileSync(new URL('../routes/customers/+page.svelte', import.meta.url), 'utf8');
const source = ts.createSourceFile('customers.ts', route.match(/<script[^>]*>([\s\S]*?)<\/script>/)![1], ts.ScriptTarget.Latest, true);
const functionText = (name: string) => {
    const node = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (!node) throw new Error(`Missing production ${name}`);
    return node.getText(source);
};

function setup(enabled = false) {
    const account = { id: 'new', customerId: 'new', isEnabled: enabled, creditLimitPence: 0, balancePence: 0, createdAt: '' };
    const context = vm.createContext({
        accountCustomerId: 'previous', accountCustomerSnapshot: { id: 'previous' },
        customerAccount: { id: 'previous', isEnabled: true }, accountEnabledDraft: true, accountLimitDraft: '50.00',
        accountEntries: [], accountEntryTotal: 0, accountHistoryLoadRun: 0, accountHistoryLoadingMore: false,
        accountLoadToken: 0, accountLoading: false, accountSaving: false, showAccount: false,
        ACCOUNT_HISTORY_PAGE_SIZE: 25, $currentEmployee: { id: 'manager' }, canAdjustCustomerAccount: true,
        getCustomerAccount: vi.fn(async () => account),
        getCustomerAccountEntries: vi.fn(async () => ({ entries: [], total: 0 })),
        updateCustomerAccountSummary: vi.fn(), toast: vi.fn(), poundsToPence: () => 0,
        saveCustomerAccountConfig: vi.fn(async (value: any) => ({ ...account, ...value })),
    });
    vm.runInContext(ts.transpileModule(['openCustomerAccount', 'refreshCustomerAccount', 'saveAccountConfig']
        .map(functionText).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    return { account, context, open: () => context.openCustomerAccount({ id: 'new', name: 'New customer' }) as Promise<void> };
}

describe('customer account enablement settings match held defaults', () => {
    it('initializes the production draft disabled, not enabled', () => {
        const declaration = source.statements.find(node => ts.isVariableStatement(node)
            && node.declarationList.declarations.some(value => value.name.getText(source) === 'accountEnabledDraft'));
        expect(declaration).toBeDefined();
        const context = vm.createContext({ result: undefined });
        vm.runInContext(`${declaration!.getText(source)}\nresult = accountEnabledDraft;`, context);
        expect(context.result).toBe(false);
    });

    it('resets an earlier enabled account draft before loading a held new account, without saving configuration', async () => {
        const { account, context, open } = setup();
        let finish!: (value: typeof account) => void;
        context.getCustomerAccount.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
        const pending = open();
        expect(context.accountEnabledDraft).toBe(false);
        expect(context.accountLimitDraft).toBe('');
        expect(context.customerAccount).toBeNull();
        expect(context.accountLoading).toBe(true);
        finish(account);
        await pending;
        expect(context.customerAccount.isEnabled).toBe(false);
        expect(context.accountEnabledDraft).toBe(false);
        expect(context.accountLoading).toBe(false);
        expect(context.saveCustomerAccountConfig).not.toHaveBeenCalled();
    });

    it('does not retain enabled settings from a previous account when the new account read fails', async () => {
        const { context, open } = setup();
        context.getCustomerAccount.mockRejectedValue(new Error('Mock read failed'));
        await open();
        expect(context.accountEnabledDraft).toBe(false);
        expect(context.accountLimitDraft).toBe('');
        expect(context.customerAccount).toBeNull();
        expect(context.saveCustomerAccountConfig).not.toHaveBeenCalled();
        expect(context.toast).toHaveBeenCalledWith(expect.stringContaining('Could not load'), 'error');
    });

    it.each([false, true])('preserves the authoritative enabled=%s checkbox value and sends that same value only on explicit Save Settings', async enabled => {
        const { context, open } = setup(enabled);
        await open();
        expect(context.accountEnabledDraft).toBe(enabled);
        expect(context.saveCustomerAccountConfig).not.toHaveBeenCalled();
        await context.saveAccountConfig();
        expect(context.saveCustomerAccountConfig).toHaveBeenCalledExactlyOnceWith({
            customerId: 'new', isEnabled: enabled, creditLimitPence: 0, employeeId: 'manager',
        });
    });

    it('uses a stable positive checkbox name and separate held/active description', () => {
        expect(route).toMatch(/<input type="checkbox" bind:checked=\{accountEnabledDraft\} aria-labelledby="customer-account-pay-later-label" aria-describedby="customer-account-pay-later-help"/);
        expect(route).toContain('<b id="customer-account-pay-later-label">Allow Pay Later purchases</b>');
        expect(route).toContain("'Account on hold. Existing activity is kept, but new charges are blocked.'");
        expect(route).not.toContain("<b>{accountEnabledDraft ? 'Pay Later active' : 'Account on hold'}</b>");
    });
});
