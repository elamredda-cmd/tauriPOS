/** Low-latency synthesized POS sounds. No files or decoding are required. */

import { get } from "svelte/store";
import { settingsDB } from "$lib/stores/db";

let audioContext: AudioContext | null = null;
let enginePrimed = false;
let audioSuspendTimer: ReturnType<typeof setTimeout> | null = null;
const AUDIO_IDLE_SUSPEND_MS = 3_000;

function settingEnabled(key: string, defaultValue = true): boolean {
    const value = get(settingsDB).find((setting) => setting.key === key)?.value;
    return value === undefined ? defaultValue : value !== "false";
}

function vibrate(pattern: number | number[]) {
    if (!settingEnabled("feedback_haptics_enabled")) return;
    if (supportsHapticFeedback()) {
        navigator.vibrate(pattern);
    }
}

export function supportsHapticFeedback(): boolean {
    return typeof navigator !== "undefined" && typeof navigator.vibrate === "function";
}

export function playHapticFeedback() {
    vibrate(35);
}

function createAudioContext(): AudioContext | null {
    if (typeof window === "undefined") return null;
    audioContext = new AudioContext({ latencyHint: "interactive" });
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

function resetSoundEngine() {
    const oldContext = audioContext;
    audioContext = null;
    if (audioSuspendTimer) clearTimeout(audioSuspendTimer);
    audioSuspendTimer = null;
    if (oldContext && oldContext.state !== "closed") void oldContext.close().catch(() => {});
}

function scheduleAudioSuspend(context: AudioContext) {
    if (audioSuspendTimer) clearTimeout(audioSuspendTimer);
    audioSuspendTimer = setTimeout(() => {
        audioSuspendTimer = null;
        if (audioContext === context && context.state === "running") {
            void context.suspend().catch(() => resetSoundEngine());
        }
    }, AUDIO_IDLE_SUSPEND_MS);
}

async function wakeSoundEngine(): Promise<AudioContext | null> {
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
        scheduleAudioSuspend(context);
    });
}

/** Initialize lightweight lifecycle handling without keeping WebAudio running at idle. */
export function primeSoundEngine() {
    if (typeof window === "undefined" || enginePrimed) return;
    enginePrimed = true;
    document.addEventListener("visibilitychange", () => {
        if (document.hidden && audioContext?.state === "running") {
            void audioContext.suspend().catch(() => resetSoundEngine());
        }
    });
}

/** Very short, tactile confirmation for every successful cart addition. */
export function playItemAddedSound() {
    // A sine tone stays clean on the small, low-quality speakers commonly
    // fitted to older tills. The previous square wave could sound like a buzz.
    if (settingEnabled("feedback_item_sound_enabled")) tone(1040, 42, 0.085, "sine");
    vibrate(8);
}

/** Short confirmation used only after a barcode successfully resolves. */
export function playScanSuccessSound() {
    if (settingEnabled("feedback_scan_sound_enabled")) tone(1120, 38, 0.08, "sine");
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
