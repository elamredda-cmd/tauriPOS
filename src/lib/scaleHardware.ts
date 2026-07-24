import { invoke, isTauri } from '@tauri-apps/api/core';
import { get } from 'svelte/store';
import { settingsDB, type Setting } from '$lib/stores/db';

export type ScaleWeightUnit = 'kg' | 'g';
export type ScaleRequestMode = 'auto' | 'listen' | 'adam_print';

export interface ScaleHardwareConfig {
    enabled: boolean;
    devicePath: string;
    baudRate: number;
    pollMs: number;
    requestMode: ScaleRequestMode;
}

export interface ScaleWeightReading {
    weight: number;
    unit: ScaleWeightUnit;
    raw: string;
}

export interface SerialPortInfo {
    path: string;
    label: string;
    kind: string;
}

function setting(settings: Setting[], key: string, fallback = ''): string {
    return settings.find((item) => item.key === key)?.value || fallback;
}

function boolSetting(settings: Setting[], key: string, fallback: boolean): boolean {
    return setting(settings, key, fallback ? 'true' : 'false') !== 'false';
}

function intSetting(settings: Setting[], key: string, fallback: number, min: number, max: number): number {
    const value = Number(setting(settings, key, String(fallback)));
    if (!Number.isInteger(value)) return fallback;
    return Math.min(max, Math.max(min, value));
}

export function getScaleHardwareConfig(settings: Setting[] = get(settingsDB)): ScaleHardwareConfig {
    return {
        enabled: boolSetting(settings, 'scale_hardware_enabled', false),
        devicePath: setting(settings, 'scale_hardware_device_path'),
        baudRate: intSetting(settings, 'scale_hardware_baud_rate', 9600, 1200, 115200),
        pollMs: intSetting(settings, 'scale_hardware_poll_ms', 1200, 500, 5000),
        requestMode: setting(settings, 'scale_hardware_request_mode', 'auto') === 'listen'
            ? 'listen'
            : setting(settings, 'scale_hardware_request_mode', 'auto') === 'adam_print'
                ? 'adam_print'
                : 'auto',
    };
}

export function formatScaleReading(reading: ScaleWeightReading): string {
    if (reading.unit === 'g') return `${Math.round(reading.weight)} g`;
    return `${reading.weight.toFixed(3).replace(/\.?0+$/, '') || '0'} kg`;
}

export async function readScaleWeight(config = getScaleHardwareConfig()): Promise<ScaleWeightReading> {
    if (!isTauri()) throw new Error('Scale hardware is available in the installed POS app');
    if (!config.enabled) throw new Error('Scale is disabled');
    const devicePath = config.devicePath.trim();
    if (!devicePath) throw new Error('Enter the scale port first');

    const reading = await invoke<ScaleWeightReading>('read_scale_weight', {
        devicePath,
        baudRate: config.baudRate,
        timeoutMs: config.pollMs,
        requestMode: config.requestMode,
    });
    const unit: ScaleWeightUnit = reading.unit === 'g' ? 'g' : 'kg';
    return {
        weight: Number(reading.weight),
        unit,
        raw: reading.raw || '',
    };
}

export async function listScalePorts(): Promise<SerialPortInfo[]> {
    if (!isTauri()) return [];
    const ports = await invoke<SerialPortInfo[]>('list_serial_ports');
    return ports.map((port) => ({
        path: port.path,
        label: port.label || port.path,
        kind: port.kind || 'serial',
    }));
}
