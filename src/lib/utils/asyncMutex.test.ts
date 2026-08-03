import { describe, expect, it } from 'vitest';
import { AsyncMutex } from './asyncMutex';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

describe('whole-system close local readiness mutex', () => {
    it('makes prepared acknowledgement wait for an already-started local sale', async () => {
        const mutex = new AsyncMutex();
        const allowSaleCommit = deferred();
        const events: string[] = [];
        const sale = mutex.runExclusive(async () => {
            events.push('sale-started');
            await allowSaleCommit.promise;
            events.push('sale-outbox-durable');
        });
        const acknowledge = mutex.runExclusive(async () => {
            events.push('prepared-ack');
        });

        await Promise.resolve();
        expect(events).toEqual(['sale-started']);
        allowSaleCommit.resolve();
        await Promise.all([sale, acknowledge]);
        expect(events).toEqual(['sale-started', 'sale-outbox-durable', 'prepared-ack']);
    });

    it('makes a sale queued behind prepared acknowledgement fail before local commit', async () => {
        const mutex = new AsyncMutex();
        const allowAcknowledgement = deferred();
        let barrierState: 'idle' | 'preparing' = 'idle';
        let localSaleCommitted = false;
        const acknowledge = mutex.runExclusive(async () => {
            barrierState = 'preparing';
            await allowAcknowledgement.promise;
        });
        const sale = mutex.runExclusive(async () => {
            if (barrierState !== 'idle') throw new Error('WHOLE_SYSTEM_CLOSE_IN_PROGRESS');
            localSaleCommitted = true;
        });
        const rejectedSale = expect(sale).rejects.toThrow('WHOLE_SYSTEM_CLOSE_IN_PROGRESS');

        await Promise.resolve();
        allowAcknowledgement.resolve();
        await acknowledge;
        await rejectedSale;
        expect(localSaleCommitted).toBe(false);
    });
});
