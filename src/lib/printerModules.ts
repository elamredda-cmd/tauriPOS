import { invoke } from '@tauri-apps/api/core';

export interface PrinterModuleInfo {
    id: string;
    name: string;
    vendor: string;
    version: string;
    apiVersion: number;
    capabilities: string[];
    enabled: boolean;
    compatible: boolean;
    trusted: boolean;
    status: string;
}

export interface PrinterModuleResponse {
    ok: true;
    message?: string;
    jobId?: string;
    status?: string;
    devices?: Array<{ id: string; name: string; model?: string; transport?: string }>;
    [key: string]: unknown;
}

export function listPrinterModules(): Promise<PrinterModuleInfo[]> {
    return invoke<PrinterModuleInfo[]>('list_printer_modules');
}

export function installPrinterModule(packagePath: string): Promise<PrinterModuleInfo> {
    return invoke<PrinterModuleInfo>('install_printer_module', { packagePath });
}

export function setPrinterModuleEnabled(moduleId: string, enabled: boolean): Promise<PrinterModuleInfo> {
    return invoke<PrinterModuleInfo>('set_printer_module_enabled', { moduleId, enabled });
}

export function uninstallPrinterModule(moduleId: string): Promise<void> {
    return invoke('uninstall_printer_module', { moduleId });
}

export function executePrinterModule(
    moduleId: string,
    operation: string,
    payload: Record<string, unknown> = {},
    timeoutMs = 15_000,
): Promise<PrinterModuleResponse> {
    return invoke<PrinterModuleResponse>('execute_printer_module', {
        moduleId,
        operation,
        payload,
        timeoutMs,
    });
}

function bytesToBase64(data: ArrayLike<number>): string {
    const chunkSize = 32_768;
    let binary = '';
    for (let offset = 0; offset < data.length; offset += chunkSize) {
        const chunkLength = Math.min(chunkSize, data.length - offset);
        const chunk = Array.from({ length: chunkLength }, (_, index) => data[offset + index] & 0xff);
        binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
}

export function executePrinterModuleRaw(args: {
    moduleId: string;
    deviceId?: string;
    data: ArrayLike<number>;
    documentName: string;
    protocol?: string;
    timeoutMs?: number;
}): Promise<PrinterModuleResponse> {
    return executePrinterModule(
        args.moduleId,
        'printRaw',
        {
            deviceId: args.deviceId || '',
            documentName: args.documentName,
            protocol: args.protocol || 'raw',
            dataBase64: bytesToBase64(args.data),
        },
        args.timeoutMs || 30_000,
    );
}
