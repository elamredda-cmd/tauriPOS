import { invoke } from '@tauri-apps/api/core';
import { get } from 'svelte/store';
import { settingsDB, type Setting } from '$lib/stores/db';
import { getReceiptPrinterConfig } from '$lib/printers';

export interface CashDrawerConfig {
    enabled: boolean;
    host: string;
    port: number;
    pin: 0 | 1;
    pulseOnMs: number;
    pulseOffMs: number;
}

function setting(settings: Setting[], key: string, fallback = ''): string {
    return settings.find((item) => item.key === key)?.value || fallback;
}

function boolSetting(settings: Setting[], key: string, fallback: boolean): boolean {
    const value = setting(settings, key, fallback ? 'true' : 'false');
    return value !== 'false';
}

function numberSetting(settings: Setting[], key: string, fallback: number): number {
    const value = Number(setting(settings, key, String(fallback)));
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function getCashDrawerConfig(settings: Setting[] = get(settingsDB)): CashDrawerConfig {
    const drawerHost = setting(settings, 'cash_drawer_printer_host');
    const receiptPrinter = getReceiptPrinterConfig(settings);
    const receiptHost = receiptPrinter.connection === 'network_escpos' ? receiptPrinter.host : '';
    const host = drawerHost.trim() ? drawerHost : receiptHost;
    const port = drawerHost.trim()
        ? numberSetting(settings, 'cash_drawer_printer_port', 9100)
        : receiptPrinter.port;
    const pin = Number(setting(settings, 'cash_drawer_pin', '0')) === 1 ? 1 : 0;
    const drawerAfterPayment = setting(settings, 'receipt_printer_open_drawer_after_payment') === 'true';
    return {
        enabled: drawerAfterPayment || boolSetting(settings, 'cash_drawer_enabled', Boolean(host.trim())),
        host,
        port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 9100,
        pin,
        pulseOnMs: Math.min(510, Math.max(2, numberSetting(settings, 'cash_drawer_pulse_on_ms', 50))),
        pulseOffMs: Math.min(510, Math.max(2, numberSetting(settings, 'cash_drawer_pulse_off_ms', 250))),
    };
}

export async function openCashDrawer(config = getCashDrawerConfig()): Promise<void> {
    if (!config.enabled) {
        throw new Error('Cash drawer is disabled in settings');
    }
    if (!config.host.trim()) {
        throw new Error('Enter the receipt printer IP address in settings first');
    }
    await invoke('open_cash_drawer', {
        host: config.host.trim(),
        port: config.port,
        pin: config.pin,
        pulseOnMs: config.pulseOnMs,
        pulseOffMs: config.pulseOffMs,
        timeoutMs: 800,
    });
}
