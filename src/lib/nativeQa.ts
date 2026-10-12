import { invoke, isTauri } from '@tauri-apps/api/core';

/** Only the explicitly built, isolated native QA application renders controls. */
export const nativeQaEnabled = import.meta.env.VITE_NATIVE_QA === '1' && isTauri();

export type NativeQaMode = 'delay' | 'reject' | 'delay-reject';
export interface NativeQaStatus {
    armed: string[];
    pending: string[];
    events: string[];
    hits: Record<string, number>;
}

/**
 * Delay/reject a real native UI operation without inventing a successful result.
 * The native command exists only in a debug build with the native-qa feature,
 * and independently refuses the normal app identifier. No secret values cross
 * this boundary; detail is deliberately not sent to Rust or persisted.
 */
export async function nativeQaCheckpoint(point: string, _detail?: unknown): Promise<void> {
    if (!nativeQaEnabled) return;
    await invoke('native_qa_checkpoint', { point });
}

export async function armNativeQa(point: string, mode: NativeQaMode, delayMs = 15000): Promise<NativeQaStatus> {
    return invoke<NativeQaStatus>('native_qa_arm', { point, mode, delayMs });
}

export async function releaseNativeQa(): Promise<NativeQaStatus> {
    return invoke<NativeQaStatus>('native_qa_release');
}

export async function getNativeQaStatus(): Promise<NativeQaStatus> {
    return invoke<NativeQaStatus>('native_qa_status');
}
