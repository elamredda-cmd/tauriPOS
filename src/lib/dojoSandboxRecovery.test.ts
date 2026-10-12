import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    recoverSandboxWithConfirmation,
    type DojoSandboxRecoveryResult,
} from './dojoSandboxRecovery';

function outcome(overrides: Partial<DojoSandboxRecoveryResult> = {}): DojoSandboxRecoveryResult {
    return {
        resolved: 0,
        remaining: 1,
        switchedToDedicated: false,
        issues: [],
        waitingForConfirmation: true,
        ...overrides,
    };
}

function recovery() {
    const controller = new AbortController();
    return {
        controller,
        options: {
            signal: controller.signal,
            canContinue: vi.fn(() => true),
            recover: vi.fn<() => Promise<DojoSandboxRecoveryResult>>().mockResolvedValue(outcome()),
            onWaiting: vi.fn(),
        },
    };
}

describe('legacy Dojo sandbox recovery confirmation', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('waits a full 31 seconds before checking the provider cancellation again', async () => {
        const { options } = recovery();
        const confirmed = outcome({ resolved: 1, remaining: 0, switchedToDedicated: true, waitingForConfirmation: false });
        options.recover.mockResolvedValueOnce(outcome()).mockResolvedValueOnce(confirmed);
        const pending = recoverSandboxWithConfirmation(options);

        await vi.advanceTimersByTimeAsync(0);
        expect(options.recover).toHaveBeenCalledOnce();
        expect(options.onWaiting).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(30_999);
        expect(options.recover).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(1);

        await expect(pending).resolves.toEqual(confirmed);
        expect(options.recover).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('stops at three checks and keeps the final native pending result unchanged', async () => {
        const { options } = recovery();
        const stillPending = outcome({ remaining: 2, issues: ['Two payments still need confirmation.'] });
        options.recover.mockResolvedValue(stillPending);
        const pending = recoverSandboxWithConfirmation(options);

        await vi.advanceTimersByTimeAsync(31_000 * 5);

        await expect(pending).resolves.toEqual(stillPending);
        expect(options.recover).toHaveBeenCalledTimes(3);
        expect(options.onWaiting).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('accumulates newly resolved records while retaining only the latest remaining count and issues', async () => {
        const { options } = recovery();
        const final = outcome({ resolved: 3, remaining: 1, issues: ['An approved test payment needs accounting review.'], waitingForConfirmation: false });
        options.recover
            .mockResolvedValueOnce(outcome({ resolved: 1, remaining: 6, issues: ['Waiting for confirmation.'] }))
            .mockResolvedValueOnce(outcome({ resolved: 2, remaining: 4 }))
            .mockResolvedValueOnce(final);
        const pending = recoverSandboxWithConfirmation(options);

        await vi.advanceTimersByTimeAsync(62_000);

        await expect(pending).resolves.toEqual({ ...final, resolved: 6 });
        expect(options.recover).toHaveBeenCalledTimes(3);
    });

    it.each([
        outcome({ resolved: 2, remaining: 0, switchedToDedicated: true, waitingForConfirmation: false }),
        outcome({ remaining: 1, issues: ['Payment evidence is incomplete.'], waitingForConfirmation: false }),
    ])('does not wait when the native result needs no separated confirmation: %j', async (final) => {
        const { options } = recovery();
        const wait = vi.fn(async () => undefined);
        options.recover.mockResolvedValue(final);

        await expect(recoverSandboxWithConfirmation({ ...options, wait })).resolves.toEqual(final);

        expect(options.recover).toHaveBeenCalledOnce();
        expect(options.onWaiting).not.toHaveBeenCalled();
        expect(wait).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not call native recovery when the page was already aborted', async () => {
        const { controller, options } = recovery();
        controller.abort();

        await expect(recoverSandboxWithConfirmation(options)).rejects.toThrow('page closed');

        expect(options.recover).not.toHaveBeenCalled();
        expect(options.onWaiting).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not call native recovery when the original administrator is no longer active', async () => {
        const { options } = recovery();
        options.canContinue.mockReturnValue(false);

        await expect(recoverSandboxWithConfirmation(options)).rejects.toThrow('staff session changed');

        expect(options.recover).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('aborts an active confirmation timer immediately without starting another native check', async () => {
        const { controller, options } = recovery();
        const pending = recoverSandboxWithConfirmation(options);
        const rejected = expect(pending).rejects.toThrow('Sandbox recovery was stopped');
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(1);

        controller.abort();
        await rejected;
        await vi.advanceTimersByTimeAsync(62_000);

        expect(options.recover).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('rechecks the staff session before making a later native call', async () => {
        const { options } = recovery();
        const pending = recoverSandboxWithConfirmation(options);
        const rejected = expect(pending).rejects.toThrow('staff session changed');
        await vi.advanceTimersByTimeAsync(0);

        options.canContinue.mockReturnValue(false);
        await vi.advanceTimersByTimeAsync(31_000);
        await rejected;

        expect(options.recover).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('checks an aborted signal again even if a supplied wait completes normally', async () => {
        const { controller, options } = recovery();
        const wait = vi.fn(async () => { controller.abort(); });

        await expect(recoverSandboxWithConfirmation({ ...options, wait })).rejects.toThrow('page closed');

        expect(wait).toHaveBeenCalledExactlyOnceWith(31_000, controller.signal);
        expect(options.recover).toHaveBeenCalledOnce();
    });

    it.each([
        ['abort', false],
        ['abort', true],
        ['staff change', false],
        ['staff change', true],
    ] as const)('ignores an in-flight native result after %s, with further confirmation=%s', async (stop, waitingForConfirmation) => {
        const { controller, options } = recovery();
        let finish!: (value: DojoSandboxRecoveryResult) => void;
        options.recover.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const pending = recoverSandboxWithConfirmation(options);
        const rejected = expect(pending).rejects.toThrow('staff session changed or this page closed');
        expect(options.recover).toHaveBeenCalledOnce();

        if (stop === 'abort') controller.abort();
        else options.canContinue.mockReturnValue(false);
        finish(outcome({ resolved: 1, remaining: 0, switchedToDedicated: true, waitingForConfirmation }));
        await rejected;
        await vi.advanceTimersByTimeAsync(62_000);

        expect(options.recover).toHaveBeenCalledOnce();
        expect(options.onWaiting).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('propagates a provider error without retrying or waiting', async () => {
        const { options } = recovery();
        const problem = new Error('Dojo payment identity does not match the journal.');
        options.recover.mockRejectedValue(problem);

        await expect(recoverSandboxWithConfirmation(options)).rejects.toBe(problem);

        expect(options.recover).toHaveBeenCalledOnce();
        expect(options.onWaiting).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('stops if the second provider check fails instead of running the third check', async () => {
        const { options } = recovery();
        const problem = new Error('Dojo could not be reached; keep the payment unresolved.');
        options.recover.mockResolvedValueOnce(outcome()).mockRejectedValueOnce(problem);
        const pending = recoverSandboxWithConfirmation(options);
        const rejected = expect(pending).rejects.toBe(problem);

        await vi.advanceTimersByTimeAsync(31_000);
        await rejected;
        await vi.advanceTimersByTimeAsync(62_000);

        expect(options.recover).toHaveBeenCalledTimes(2);
        expect(options.onWaiting).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });
});
