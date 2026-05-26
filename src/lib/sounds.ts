/** Sound engine – generates WAV data-URIs locally so everything works offline. */

function encodeWav(samples: number[], sampleRate: number): string {
    const len = 44 + samples.length;
    const buf = new ArrayBuffer(len);
    const view = new DataView(buf);

    const writeStr = (off: number, str: string) => {
        for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
    };

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + samples.length, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);        // PCM
    view.setUint16(22, 1, true);        // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate, true); // byte rate for 8-bit mono
    view.setUint16(32, 1, true);        // block align
    view.setUint16(34, 8, true);        // bits per sample
    writeStr(36, 'data');
    view.setUint32(40, samples.length, true);

    for (let i = 0; i < samples.length; i++) {
        view.setUint8(44 + i, Math.max(0, Math.min(255, Math.round(samples[i]))));
    }

    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return 'data:audio/wav;base64,' + btoa(binary);
}

function generateRingTone(): string {
    const sr = 22050;
    const dur = 0.7;
    const samples: number[] = [];
    for (let i = 0; i < sr * dur; i++) {
        const t = i / sr;
        let amp = 0;
        // two rings: 0-0.25s, gap 0.1s, 0.35-0.6s
        if (t < 0.25 || (t >= 0.35 && t < 0.6)) {
            const ringT = t < 0.25 ? t : t - 0.35;
            const env = Math.max(0, 1 - ringT / 0.25);
            amp = (Math.sin(2 * Math.PI * 480 * t) + Math.sin(2 * Math.PI * 620 * t)) * 0.5 * env;
        }
        samples.push(128 + amp * 64);
    }
    return encodeWav(samples, sr);
}

function generateChime(): string {
    const sr = 22050;
    const dur = 0.3;
    const samples: number[] = [];
    for (let i = 0; i < sr * dur; i++) {
        const t = i / sr;
        const freq = 523 + (784 - 523) * (t / dur);
        const env = Math.max(0, 1 - t / 0.3);
        const amp = Math.sin(2 * Math.PI * freq * t) * env;
        samples.push(128 + amp * 64);
    }
    return encodeWav(samples, sr);
}

const errorUri = generateRingTone();
const successUri = generateChime();

export function playErrorSound() {
    const a = new Audio(errorUri);
    a.volume = 0.6;
    a.play().catch(() => {});
}

export function playSuccessSound() {
    const a = new Audio(successUri);
    a.volume = 0.5;
    a.play().catch(() => {});
}
