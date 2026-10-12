import { describe, expect, it, vi } from 'vitest';
import { createSettingsWriteQueue, switchCardProvider } from './settingsWriteQueue';

describe('settings write ordering', () => {
    it('serializes writes to the same setting even when the first rejects', async () => {
        const run = createSettingsWriteQueue();
        let rejectA!: (reason: Error) => void;
        const calls: string[] = [];
        const a = run('font', async () => { calls.push('A'); await new Promise((_, reject) => { rejectA = reject; }); });
        const handledA = a.catch(() => undefined);
        const b = run('font', async () => { calls.push('B'); return 'latest'; });
        await Promise.resolve();
        await Promise.resolve();
        expect(calls).toEqual(['A']);
        rejectA(new Error('blocked'));
        await handledA;
        expect(await b).toBe('latest');
        expect(calls).toEqual(['A', 'B']);
    });
    it('allows unrelated keys to save independently', async () => {
        const run = createSettingsWriteQueue();
        let finish!: () => void;
        const a = run('font', () => new Promise<void>(resolve => { finish = resolve; }));
        expect(await run('sound', async () => 'saved')).toBe('saved');
        finish();
        await a;
    });
});

describe('recoverable provider switch', () => {
    it('does not disable a working provider when the target save fails', async () => {
        const disablePrevious = vi.fn();
        await expect(switchCardProvider({ enableTarget: async () => { throw Error('validation'); }, disablePrevious, getPreviousEnabled: async () => true, restoreTarget: vi.fn() })).rejects.toThrow('validation');
        expect(disablePrevious).not.toHaveBeenCalled();
    });
    it('enables the target before disabling the previous provider', async () => {
        const calls: string[] = [];
        expect(await switchCardProvider({ enableTarget: async () => { calls.push('target'); return 'ready'; }, disablePrevious: async () => { calls.push('previous'); }, getPreviousEnabled: async () => false, restoreTarget: vi.fn() })).toBe('ready');
        expect(calls).toEqual(['target', 'previous']);
    });
    it('restores the target when disabling the previous provider fails', async () => {
        const restoreTarget = vi.fn(async () => undefined);
        await expect(switchCardProvider({ enableTarget: async () => true, disablePrevious: async () => { throw Error('write'); }, getPreviousEnabled: async () => true, restoreTarget })).rejects.toThrow('previous provider is retained');
        expect(restoreTarget).toHaveBeenCalledTimes(1);
    });
    it('reports recovery instructions if rollback fails', async () => {
        await expect(switchCardProvider({ enableTarget: async () => true, disablePrevious: async () => { throw Error('write'); }, getPreviousEnabled: async () => true, restoreTarget: async () => { throw Error('rollback'); } })).rejects.toThrow('Reload both provider settings');
    });
    it('retains the enabled target if the previous disable committed before reporting a failure', async () => {
        let previousEnabled = true;
        let targetEnabled = false;
        const restoreTarget = vi.fn(async () => { targetEnabled = false; });
        expect(await switchCardProvider({
            enableTarget: async () => { targetEnabled = true; return 'ready'; },
            disablePrevious: async () => { previousEnabled = false; throw Error('directory fsync after replacement'); },
            getPreviousEnabled: async () => previousEnabled,
            restoreTarget,
        })).toBe('ready');
        expect(restoreTarget).not.toHaveBeenCalled();
        expect(targetEnabled).toBe(true);
        expect(previousEnabled).toBe(false);
    });
    it('never rolls back the target if the previous state cannot be re-read', async () => {
        const restoreTarget = vi.fn();
        await expect(switchCardProvider({
            enableTarget: async () => true,
            disablePrevious: async () => { throw Error('ambiguous write'); },
            getPreviousEnabled: async () => { throw Error('read error'); },
            restoreTarget,
        })).rejects.toThrow('no rollback was attempted');
        expect(restoreTarget).not.toHaveBeenCalled();
    });
    it('does not disable the previous provider after an ambiguous target save failure', async () => {
        let targetEnabled = false;
        const disablePrevious = vi.fn();
        await expect(switchCardProvider({
            enableTarget: async () => { targetEnabled = true; throw Error('post-write fsync'); },
            disablePrevious,
            getPreviousEnabled: async () => true,
            restoreTarget: vi.fn(),
        })).rejects.toThrow('Reload both provider settings');
        expect(targetEnabled).toBe(true);
        expect(disablePrevious).not.toHaveBeenCalled();
    });
});
