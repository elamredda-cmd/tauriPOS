type QueueJob<T> = {
    value: T;
    resolve: () => void;
};

/** Runs jobs in insertion order and allows interactive UI gates between jobs. */
export class SequentialQueue<T> {
    private pending: QueueJob<T>[] = [];
    private running = false;
    private destroyed = false;

    constructor(
        private readonly process: (value: T) => Promise<void>,
        private readonly waitUntilReady: () => Promise<void> = () => Promise.resolve(),
    ) {}

    enqueue(value: T): Promise<void> {
        if (this.destroyed) return Promise.resolve();
        return new Promise((resolve) => {
            this.pending.push({ value, resolve });
            void this.drain();
        });
    }

    destroy() {
        this.destroyed = true;
        for (const job of this.pending.splice(0)) job.resolve();
    }

    private async drain() {
        if (this.running || this.destroyed) return;
        this.running = true;
        try {
            while (this.pending.length > 0 && !this.destroyed) {
                await this.waitUntilReady();
                if (this.destroyed) break;
                const job = this.pending.shift();
                if (!job) continue;
                await this.process(job.value);
                await this.waitUntilReady();
                job.resolve();
            }
        } finally {
            this.running = false;
            if (this.pending.length > 0 && !this.destroyed) void this.drain();
        }
    }
}
