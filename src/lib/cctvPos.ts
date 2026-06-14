import { invoke } from '@tauri-apps/api/core';
import { get } from 'svelte/store';
import { settingsDB, type Setting } from '$lib/stores/db';

export interface CctvPosConfig {
    enabled: boolean;
    host: string;
    port: number;
    posNumber: string;
    posName: string;
    sourceIp: string;
    encoding: 'latin1' | 'utf8';
    sendItems: boolean;
    sendReceipts: boolean;
}

export interface CctvReceiptLine {
    name: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
    discount?: number;
}

export interface CctvReceiptPayload {
    storeName: string;
    tillName: string;
    cashierName: string;
    paymentMethod: string;
    subtotal: number;
    discount: number;
    total: number;
    lines: CctvReceiptLine[];
}

function setting(settings: Setting[], key: string, fallback = ''): string {
    return settings.find((item) => item.key === key)?.value || fallback;
}

function boolSetting(settings: Setting[], key: string, fallback: boolean): boolean {
    const value = setting(settings, key, fallback ? 'true' : 'false');
    return value !== 'false';
}

export function getCctvPosConfig(settings: Setting[] = get(settingsDB)): CctvPosConfig {
    const host = setting(settings, 'cctv_pos_host');
    const port = Number(setting(settings, 'cctv_pos_port', '10010'));
    return {
        enabled: boolSetting(settings, 'cctv_pos_enabled', Boolean(host.trim())),
        host,
        port: Number.isInteger(port) && port > 0 ? port : 10010,
        posNumber: setting(settings, 'cctv_pos_number', '1'),
        posName: setting(settings, 'cctv_pos_name', 'POS 1'),
        sourceIp: setting(settings, 'cctv_pos_source_ip'),
        encoding: setting(settings, 'cctv_pos_encoding', 'latin1') === 'utf8' ? 'utf8' : 'latin1',
        sendItems: boolSetting(settings, 'cctv_pos_send_items', true),
        sendReceipts: boolSetting(settings, 'cctv_pos_send_receipts', true),
    };
}

function money(pence: number): string {
    return `${(Number(pence || 0) / 100).toFixed(2)}`;
}

function cleanText(value: string): string {
    return String(value || '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function receiptLine(quantity: number, name: string, amount: number): string {
    const qty = Number.isFinite(quantity) ? quantity : 1;
    const cleanName = cleanText(name).slice(0, 24);
    return `${qty} ${cleanName} ${money(amount)}`;
}

function withEnding(text: string): string {
    const normalised = text.replace(/\r?\n/g, '\r\n');
    return normalised.endsWith('\r\n\r\n') ? normalised : `${normalised}\r\n\r\n`;
}

export async function sendCctvPosText(text: string, config = getCctvPosConfig()): Promise<void> {
    if (!config.enabled || !config.host.trim()) return;
    await invoke('send_cctv_pos_text', {
        host: config.host.trim(),
        port: config.port,
        text: withEnding(text),
        timeoutMs: 800,
        encoding: config.encoding,
    });
}

export function sendCctvItemAdded(payload: {
    name: string;
    price: number;
    quantity?: number;
    tillName: string;
    cashierName: string;
}): void {
    const config = getCctvPosConfig();
    if (!config.enabled || !config.sendItems) return;
    const text = cleanText(payload.name);
    sendCctvPosText(text, config).catch((error) => {
        console.warn('CCTV POS item send failed:', error);
    });
}

export function sendCctvReceipt(payload: CctvReceiptPayload): void {
    const config = getCctvPosConfig();
    if (!config.enabled || !config.sendReceipts) return;

    const rows = payload.lines.slice(0, 40).map((item) =>
        receiptLine(item.quantity, item.name, item.lineTotal)
    );
    rows.push(`TOTAL ${money(payload.total)}`);

    sendCctvPosText(rows.join('\r\n'), config).catch((error) => {
        console.warn('CCTV POS receipt send failed:', error);
    });
}
