type RasterRequest = {
    id: number;
    width: number;
    height: number;
    pixels: ArrayBuffer;
};

self.onmessage = (event: MessageEvent<RasterRequest>) => {
    const { id, width, height, pixels } = event.data;
    const rgba = new Uint8ClampedArray(pixels);
    const bytesPerRow = Math.ceil(width / 8);
    const raster = new Uint8Array(bytesPerRow * height);

    for (let y = 0; y < height; y += 1) {
        for (let byteIndex = 0; byteIndex < bytesPerRow; byteIndex += 1) {
            let byte = 0;
            for (let bit = 0; bit < 8; bit += 1) {
                const x = byteIndex * 8 + bit;
                if (x >= width) continue;
                const offset = (y * width + x) * 4;
                const alpha = rgba[offset + 3] / 255;
                const luminance = (
                    rgba[offset] * 0.299
                    + rgba[offset + 1] * 0.587
                    + rgba[offset + 2] * 0.114
                ) * alpha + 255 * (1 - alpha);
                if (luminance < 180) byte |= 0x80 >> bit;
            }
            raster[y * bytesPerRow + byteIndex] = byte;
        }
    }

    self.postMessage(
        { id, bytesPerRow, height, data: raster.buffer },
        { transfer: [raster.buffer] },
    );
};

export {};
