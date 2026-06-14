/** Low-latency synthesized POS sounds. No files or decoding are required. */

import { get } from "svelte/store";
import { settingsDB } from "$lib/stores/db";

let audioContext: AudioContext | null = null;
let enginePrimed = false;
let keepAliveOscillator: OscillatorNode | null = null;
let keepAliveGain: GainNode | null = null;
let soundWatchdog: ReturnType<typeof setInterval> | null = null;
let lastSoundAt = 0;
const STALE_AFTER_MS = 2 * 60 * 1000;

function settingEnabled(key: string, defaultValue = true): boolean {
    const value = get(settingsDB).find((setting) => setting.key === key)?.value;
    return value === undefined ? defaultValue : value !== "false";
}

function vibrate(pattern: number | number[]) {
    if (!settingEnabled("feedback_haptics_enabled")) return;
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
        navigator.vibrate(pattern);
    }
}

function createAudioContext(): AudioContext | null {
    if (typeof window === "undefined") return null;
    audioContext = new AudioContext({ latencyHint: "interactive" });
    keepAliveOscillator = null;
    keepAliveGain = null;
    return audioContext;
}

function getAudioContext(): AudioContext | null {
    if (typeof window === "undefined") return null;
    const state = audioContext?.state as string | undefined;
    if (!audioContext || state === "closed" || state === "interrupted") {
        return createAudioContext();
    }
    return audioContext;
}

function startSilentKeepAlive(context: AudioContext) {
    if (keepAliveOscillator || context.state !== "running") return;
    try {
        keepAliveOscillator = context.createOscillator();
        keepAliveGain = context.createGain();
        keepAliveOscillator.frequency.value = 20;
        keepAliveGain.gain.value = 0.000001;
        keepAliveOscillator.connect(keepAliveGain).connect(context.destination);
        keepAliveOscillator.start();
    } catch {
        keepAliveOscillator = null;
        keepAliveGain = null;
    }
}

function resetSoundEngine() {
    const oldContext = audioContext;
    audioContext = null;
    keepAliveOscillator = null;
    keepAliveGain = null;
    lastSoundAt = 0;
    if (oldContext && oldContext.state !== "closed") void oldContext.close().catch(() => {});
}

async function wakeSoundEngine(): Promise<AudioContext | null> {
    if (audioContext && lastSoundAt > 0 && Date.now() - lastSoundAt > STALE_AFTER_MS) {
        resetSoundEngine();
    }
    let context = getAudioContext();
    if (!context) return null;
    if (context.state !== "running") {
        try {
            await context.resume();
        } catch {
            resetSoundEngine();
            context = getAudioContext();
            if (!context) return null;
            try { await context.resume(); } catch { return null; }
        }
    }
    if (!context) return null;
    if ((context.state as string) !== "running") {
        resetSoundEngine();
        context = getAudioContext();
        if (!context) return null;
        try { await context?.resume(); } catch { return null; }
    }
    if (!context) return null;
    if ((context.state as string) !== "running") return null;
    startSilentKeepAlive(context);
    return context;
}

function tone(
    frequency: number,
    durationMs: number,
    volume: number,
    type: OscillatorType = "sine",
    delayMs = 0,
) {
    void wakeSoundEngine().then((context) => {
        if (!context || context.state !== "running") return;
        const start = context.currentTime + delayMs / 1000;
        const end = start + durationMs / 1000;
        const oscillator = context.createOscillator();
        const gain = context.createGain();

        oscillator.type = type;
        oscillator.frequency.setValueAtTime(frequency, start);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(volume, start + 0.003);
        gain.gain.exponentialRampToValueAtTime(0.0001, end);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start(start);
        oscillator.stop(end + 0.005);
        lastSoundAt = Date.now();
    });
}

/** Keep audio ready after OS inactivity, sleep, focus changes, or WebView suspension. */
export function primeSoundEngine() {
    if (typeof window === "undefined" || enginePrimed) return;
    enginePrimed = true;
    const wake = () => { void wakeSoundEngine(); };
    const wakeWhenVisible = () => { if (!document.hidden) wake(); };
    window.addEventListener("pointerdown", wake, { capture: true });
    window.addEventListener("keydown", wake, { capture: true });
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wakeWhenVisible);
    soundWatchdog ??= setInterval(() => {
        if (!document.hidden && audioContext && (audioContext.state as string) !== "running") {
            resetSoundEngine();
        }
    }, 15000);
}

/** Very short, tactile confirmation for every successful cart addition. */
export function playItemAddedSound() {
    if (settingEnabled("feedback_item_sound_enabled")) tone(1350, 34, 0.14, "square");
    vibrate(8);
}

/** Softer tactile feedback for cart controls, distinct from adding an item. */
export function playCartButtonFeedback() {
    if (settingEnabled("feedback_button_sound_enabled")) tone(980, 22, 0.055, "triangle");
    vibrate(6);
}

export function playErrorSound() {
    const style = get(settingsDB).find((setting) => setting.key === "barcode_error_sound")?.value || "vintage";
    if (style === "silent") return;

    if (style === "busy") {
        for (const delay of [0, 230, 460]) {
            tone(480, 150, 0.19, "square", delay);
            tone(620, 150, 0.14, "sine", delay);
        }
    } else if (style === "beep") {
        tone(980, 110, 0.22, "square");
        tone(780, 150, 0.2, "square", 125);
    } else {
        // Attention-grabbing vintage mechanical telephone bell: two quick rings.
        for (const ringStart of [0, 430]) {
            for (let strike = 0; strike < 6; strike++) {
                const delay = ringStart + strike * 48;
                tone(strike % 2 === 0 ? 720 : 610, 70, 0.24, "square", delay);
                tone(strike % 2 === 0 ? 1440 : 1220, 55, 0.105, "sine", delay + 2);
            }
        }
    }
    vibrate([55, 35, 55, 190, 55, 35, 55]);
}

export function playSuccessSound() {
    if (!settingEnabled("feedback_sale_sound_enabled")) return;
    tone(660, 70, 0.16, "sine");
    tone(990, 100, 0.15, "sine", 65);
}
