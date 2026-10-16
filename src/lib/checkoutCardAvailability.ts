import type { TerminalConfigReadState } from './terminalConfigStore';

type TerminalConfig = { enabled: boolean; ready: boolean };
export type CheckoutCardProvider = 'dojo' | 'sumup' | null;

export function checkoutCardAvailability(
    dojo: TerminalConfig,
    sumup: TerminalConfig,
    dojoRead: TerminalConfigReadState,
    sumupRead: TerminalConfigReadState,
    simulated = false,
): { provider: CheckoutCardProvider; blocked: boolean; message: string } {
    // An enabled provider retains priority even when its setup is incomplete.
    // Never silently fall through to another provider or manual card entry.
    const provider = dojo.enabled ? 'dojo' : sumup.enabled ? 'sumup' : null;
    if (simulated) return { provider, blocked: false, message: '' };
    if (dojoRead === 'error' || sumupRead === 'error') {
        return { provider, blocked: true, message: 'Card terminal settings could not be read. Retry settings before taking a card payment.' };
    }
    if (dojoRead !== 'loaded' || sumupRead !== 'loaded') {
        return { provider, blocked: true, message: 'Checking card terminal settings…' };
    }
    if (provider && !(provider === 'dojo' ? dojo : sumup).ready) {
        return { provider, blocked: true, message: `${provider === 'dojo' ? 'Dojo' : 'SumUp'} is enabled but its setup is incomplete. Check Settings → Card terminals.` };
    }
    return { provider, blocked: false, message: '' };
}
