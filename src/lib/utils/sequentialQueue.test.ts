import { describe, expect, it } from 'vitest';
import { SequentialQueue } from './sequentialQueue';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

async function flushMicrotasks() {
    await Promise.resolve();
    await Promise.resolve();
}

describe('SequentialQueue', () => {
    it('keeps async jobs in insertion order', async () => {
        const firstLookup = deferred();
        const started: string[] = [];
        const queue = new SequentialQueue<string>(async (value) => {
            started.push(value);
            if (value === 'first') await firstLookup.promise;
        });

        const first = queue.enqueue('first');
        const second = queue.enqueue('second');
        await flushMicrotasks();
        expect(started).toEqual(['first']);

        firstLookup.resolve();
        await Promise.all([first, second]);
        expect(started).toEqual(['first', 'second']);
    });

    it('waits for an interactive gate before starting the next job', async () => {
        const ageDecision = deferred();
        const started: string[] = [];
        let readinessChecks = 0;
        const queue = new SequentialQueue<string>(
            async (value) => { started.push(value); },
            () => {
                readinessChecks += 1;
                return readinessChecks === 2 ? ageDecision.promise : Promise.resolve();
            },
        );

        const first = queue.enqueue('restricted-item');
        const second = queue.enqueue('next-item');
        await flushMicrotasks();
        expect(started).toEqual(['restricted-item']);

        ageDecision.resolve();
        await Promise.all([first, second]);
        expect(started).toEqual(['restricted-item', 'next-item']);
    });
});
