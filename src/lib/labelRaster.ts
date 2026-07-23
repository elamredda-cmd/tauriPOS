export interface MonoRaster {
    bytesPerRow: number;
    height: number;
    data: Uint8Array;
}

type PendingRaster = {
    resolve: (value: MonoRaster) => void;
    reject: (reason: unknown) => void;
};

let worker: Worker | null = null;
let nextRequestId = 1;
const pending = new Map<number, PendingRaster>();

function getRasterWorker(): Worker | null {
    if (typeof Worker === 'undefined') return null;
    if (worker) return worker;

    worker = new Worker(new URL('./labelRaster.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<{ id: number; bytesPerRow: number; height: number; data: ArrayBuffer }>) => {
        const request = pending.get(event.data.id);
        if (!request) return;
        pending.delete(event.data.id);
        request.resolve({
            bytesPerRow: event.data.bytesPerRow,
            height: event.data.height,
            data: new Uint8Array(event.data.data),
        });
    };
    worker.onerror = (event) => {
        const error = new Error(event.message || 'The label raster worker stopped');
        for (const request of pending.values()) request.reject(error);
        pending.clear();
        worker?.terminate();
        worker = null;
    };
    return worker;
}

async function rasterizeWithoutWorker(image: ImageData): Promise<MonoRaster> {
    const { width, height, data } = image;
    const bytesPerRow = Math.ceil(width / 8);
    const raster = new Uint8Array(bytesPerRow * height);
    for (let y = 0; y < height; y += 1) {
        for (let byteIndex = 0; byteIndex < bytesPerRow; byteIndex += 1) {
            let byte = 0;
            for (let bit = 0; bit < 8; bit += 1) {
                const x = byteIndex * 8 + bit;
                if (x >= width) continue;
                const offset = (y * width + x) * 4;
                const alpha = data[offset + 3] / 255;
                const luminance = (
                    data[offset] * 0.299
                    + data[offset + 1] * 0.587
                    + data[offset + 2] * 0.114
                ) * alpha + 255 * (1 - alpha);
                if (luminance < 180) byte |= 0x80 >> bit;
            }
            raster[y * bytesPerRow + byteIndex] = byte;
        }
        if (y > 0 && y % 32 === 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
    }
    return { bytesPerRow, height, data: raster };
}

export function rasterizeMonochrome(image: ImageData): Promise<MonoRaster> {
    const rasterWorker = getRasterWorker();
    if (!rasterWorker) return rasterizeWithoutWorker(image);

    const id = nextRequestId++;
    return new Promise<MonoRaster>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        const pixels = image.data.buffer.slice(0) as ArrayBuffer;
        rasterWorker.postMessage(
            { id, width: image.width, height: image.height, pixels },
            [pixels],
        );
    });
}
