import { invoke } from '@tauri-apps/api/core';
import { get } from 'svelte/store';
import { settingsDB, type Setting } from '$lib/stores/db';
import { getReceiptPrinterConfig, type PrinterConnectionType, type ReceiptPrinterModel } from '$lib/printers';
import { executePrinterModule } from '$lib/printerModules';

export interface CashDrawerConfig {
    enabled: boolean;
    connection: PrinterConnectionType;
    host: string;
    port: number;
    printerName: string;
    devicePath: string;
    moduleId: string;
    moduleDeviceId: string;
    baudRate: number;
    model: ReceiptPrinterModel;
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
    const drawerPrinterName = setting(settings, 'cash_drawer_printer_name');
    const drawerDevicePath = setting(settings, 'cash_drawer_printer_device_path');
    const drawerModuleId = setting(settings, 'cash_drawer_module_id');
    const receiptPrinter = getReceiptPrinterConfig(settings);
    const connection: PrinterConnectionType = drawerModuleId.trim()
        ? 'module'
        : drawerHost.trim()
        ? 'network_escpos'
        : drawerPrinterName.trim()
            ? 'usb_raw'
            : drawerDevicePath.trim()
                ? receiptPrinter.connection === 'bluetooth' ? 'bluetooth' : 'serial'
                : receiptPrinter.connection;
    const receiptHost = receiptPrinter.connection === 'network_escpos' ? receiptPrinter.host : '';
    const host = drawerHost.trim() ? drawerHost : receiptHost;
    const port = drawerHost.trim()
        ? numberSetting(settings, 'cash_drawer_printer_port', 9100)
        : receiptPrinter.port;
    const pin = Number(setting(settings, 'cash_drawer_pin', '0')) === 1 ? 1 : 0;
    const moduleId = drawerModuleId.trim() || receiptPrinter.moduleId.trim();
    const hasDrawerTarget = Boolean(
        host.trim()
        || drawerPrinterName.trim()
        || drawerDevicePath.trim()
        || moduleId
        || receiptPrinter.printerName.trim()
        || receiptPrinter.devicePath.trim()
    );
    return {
        enabled: boolSetting(settings, 'cash_drawer_enabled', hasDrawerTarget),
        connection,
        host,
        port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 9100,
        printerName: drawerPrinterName.trim() || receiptPrinter.printerName,
        devicePath: drawerDevicePath.trim() || receiptPrinter.devicePath,
        moduleId,
        moduleDeviceId: setting(settings, 'cash_drawer_module_device_id').trim() || receiptPrinter.moduleDeviceId,
        baudRate: numberSetting(settings, 'cash_drawer_baud_rate', receiptPrinter.baudRate || 9600),
        model: receiptPrinter.model,
        pin,
        pulseOnMs: Math.min(510, Math.max(2, numberSetting(settings, 'cash_drawer_pulse_on_ms', 50))),
        pulseOffMs: Math.min(510, Math.max(2, numberSetting(settings, 'cash_drawer_pulse_off_ms', 250))),
    };
}

export function cashDrawerTargetLabel(config = getCashDrawerConfig()): string {
    if (config.connection === 'network_escpos' && config.host.trim()) return `${config.host.trim()}:${config.port}`;
    if (config.connection === 'usb_raw' && config.printerName.trim()) return config.printerName.trim();
    if ((config.connection === 'serial' || config.connection === 'bluetooth') && config.devicePath.trim()) return config.devicePath.trim();
    if (config.connection === 'module' && config.moduleId.trim()) return `Module: ${config.moduleId.trim()}`;
    return '';
}

function buildDrawerPulse(config: CashDrawerConfig): number[] {
    if (config.model === 'star_tsp100') {
        return [0x07];
    }
    const pin = config.pin === 1 ? 1 : 0;
    const onUnits = Math.min(255, Math.max(1, Math.round(config.pulseOnMs / 2)));
    const offUnits = Math.min(255, Math.max(1, Math.round(config.pulseOffMs / 2)));
    return [0x1b, 0x70, pin, onUnits, offUnits];
}

export async function openCashDrawer(config = getCashDrawerConfig()): Promise<void> {
    if (!config.enabled) {
        throw new Error('Cash drawer is disabled in settings');
    }
    const data = buildDrawerPulse(config);
    if (config.connection === 'network_escpos') {
        if (!config.host.trim()) throw new Error('Enter the receipt printer IP address in settings first');
        await invoke('send_raw_printer_data', {
            host: config.host.trim(),
            port: config.port,
            data,
            timeoutMs: 800,
        });
        return;
    }
    if (config.connection === 'usb_raw') {
        if (!config.printerName.trim()) throw new Error('Enter the Windows printer name in settings first');
        await invoke('send_system_printer_data', {
            printerName: config.printerName.trim(),
            data,
            documentName: 'Open cash drawer',
        });
        return;
    }
    if (config.connection === 'serial' || config.connection === 'bluetooth') {
        if (!config.devicePath.trim()) throw new Error('Enter the printer port/device path in settings first');
        await invoke('send_device_printer_data', {
            devicePath: config.devicePath.trim(),
            data,
            baudRate: config.baudRate,
            timeoutMs: 2000,
        });
        return;
    }
    if (config.connection === 'module') {
        if (!config.moduleId.trim()) throw new Error('Choose an installed printer module first');
        await executePrinterModule(config.moduleId.trim(), 'openDrawer', {
            deviceId: config.moduleDeviceId.trim(),
            model: config.model,
            pin: config.pin,
            pulseOnMs: config.pulseOnMs,
            pulseOffMs: config.pulseOffMs,
        });
        return;
    }
    throw new Error('Set the receipt printer to USB raw, Network, Serial, or Bluetooth before opening the drawer');
}
