import { get } from 'svelte/store';
import { describe, expect, it, vi } from 'vitest';
import { createTerminalConfigStore } from './terminalConfigStore';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

describe('terminal configuration read/write safety', () => {
    it('coalesces overlapping reads and keeps an error until a successful reread', async () => {
        const store = createTerminalConfigStore({ enabled: false });
        const pending = deferred<{ enabled: boolean }>();
        const read = vi.fn(() => pending.promise);
        const first = store.read(read);
        expect(store.read(read)).toBe(first);
        expect(get(store.readState)).toBe('loading');
        const failure = expect(first).rejects.toThrow('Unreadable');
        pending.reject(new Error('Unreadable'));
        await failure;
        expect(read).toHaveBeenCalledOnce();
        expect(get(store.readState)).toBe('error');
        expect(get(store.config)).toEqual({ enabled: false });
        await store.read(async () => ({ enabled: true }));
        expect(get(store.readState)).toBe('loaded');
    });

    it('an older successful read cannot clear a queued save failure', async () => {
        const store = createTerminalConfigStore('initial');
        const old = deferred<string>();
        const first = store.read(() => old.promise);
        const write = vi.fn(async () => { throw new Error('Save failed'); });
        const saving = store.write(write);
        const failure = expect(saving).rejects.toThrow('Save failed');
        expect(write).not.toHaveBeenCalled();
        old.resolve('old read');
        await first;
        await failure;
        expect(get(store.readState)).toBe('error');
        await store.write(async () => 'saved');
        expect(get(store.config)).toBe('saved');
        expect(get(store.readState)).toBe('loaded');
    });

    it('reads requested after a save wait and cannot reuse pre-save results', async () => {
        const store = createTerminalConfigStore('initial');
        const old = deferred<string>();
        const saved = deferred<string>();
        const current = deferred<string>();
        const first = store.read(() => old.promise);
        const saving = store.write(() => saved.promise);
        const reread = vi.fn(() => current.promise);
        const afterSave = store.read(reread);
        expect(afterSave).not.toBe(first);
        old.resolve('old');
        await first;
        expect(get(store.readState)).toBe('loading');
        expect(reread).not.toHaveBeenCalled();
        saved.resolve('new');
        await saving;
        expect(get(store.readState)).toBe('loading');
        current.resolve('fresh new');
        await afterSave;
        expect(get(store.config)).toBe('fresh new');
        expect(get(store.readState)).toBe('loaded');
    });
});
