import { afterEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({ invoke: vi.fn(), native: true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: boundary.invoke, isTauri: () => boundary.native }));

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); boundary.invoke.mockReset(); boundary.native = true; });

describe('explicit isolated native QA frontend gate', () => {
    it('does not issue QA commands in a normal native build', async () => {
        vi.stubEnv('VITE_NATIVE_QA', '');
        const qa = await import('./nativeQa');
        expect(qa.nativeQaEnabled).toBe(false);
        await qa.nativeQaCheckpoint('schema.validate');
        expect(boundary.invoke).not.toHaveBeenCalled();
    });
    it('does not issue QA commands in a browser preview even when requested', async () => {
        boundary.native = false;
        vi.stubEnv('VITE_NATIVE_QA', '1');
        const qa = await import('./nativeQa');
        expect(qa.nativeQaEnabled).toBe(false);
        await qa.nativeQaCheckpoint('schema.validate');
        expect(boundary.invoke).not.toHaveBeenCalled();
    });
    it('awaits the real native checkpoint without transmitting contextual data', async () => {
        vi.stubEnv('VITE_NATIVE_QA', '1');
        const qa = await import('./nativeQa');
        boundary.invoke.mockRejectedValueOnce(Error('Controlled native QA rejection'));
        await expect(qa.nativeQaCheckpoint('settings.before-commit', { key: 'not-transmitted' }))
            .rejects.toThrow('Controlled native QA rejection');
        expect(boundary.invoke).toHaveBeenCalledExactlyOnceWith('native_qa_checkpoint', { point: 'settings.before-commit' });
    });
});
