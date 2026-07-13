import { invoke } from '@tauri-apps/api/core';
import { get, writable } from 'svelte/store';
import { settingsDB, type Setting } from '$lib/stores/db';

export interface CctvPosConfig {
    enabled: boolean;
    host: string;
    port: number;
    posNumber: string;
    posName: string;
    sourceIp: string;
    encoding: 'latin1' | 'utf8';
    lineWidth: number;
    sendItems: boolean;
    sendReceipts: boolean;
}

export interface CctvConnectionState {
    status: 'idle' | 'sending' | 'online' | 'offline';
    message: string;
    retryAt: number;
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

export interface CctvItemPayload {
    name: string;
    price: number;
    quantity?: number;
    tillName: string;
    cashierName: string;
}

export const cctvConnectionState = writable<CctvConnectionState>({
    status: 'idle',
    message: 'No connection test has been run yet.',
    retryAt: 0,
});

const MAX_AUTOMATIC_QUEUE = 5;
const OFFLINE_COOLDOWN_MS = 15_000;

type CctvMessageKind = 'item' | 'receipt';

interface QueuedCctvMessage {
    text: string;
    config: CctvPosConfig;
    kind: CctvMessageKind;
}

let automaticQueue: QueuedCctvMessage[] = [];
let automaticWorkerRunning = false;
let unavailableUntil = 0;

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
        lineWidth: normaliseLineWidth(Number(setting(settings, 'cctv_pos_line_width', '40'))),
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

function normaliseLineWidth(value: number): number {
    if (!Number.isFinite(value)) return 40;
    return Math.max(24, Math.min(64, Math.round(value)));
}

function formatQuantity(value: number | undefined): string {
    const quantity = Number.isFinite(value) && Number(value) > 0 ? Number(value) : 1;
    return Number.isInteger(quantity) ? String(quantity) : quantity.toFixed(3).replace(/\.?0+$/, '');
}

function alignedLine(label: string, value: string, width: number): string {
    const safeWidth = normaliseLineWidth(width);
    const cleanValue = cleanText(value).slice(0, safeWidth - 2);
    const labelWidth = Math.max(1, safeWidth - cleanValue.length - 1);
    const cleanLabel = cleanText(label).slice(0, labelWidth);
    return `${cleanLabel.padEnd(labelWidth, ' ')} ${cleanValue}`;
}

function compactProductLine(
    name: string,
    quantity: number,
    unitPrice: number,
    lineTotal: number,
    width: number,
): string {
    const safeWidth = normaliseLineWidth(width);
    const suffix = ` x${formatQuantity(quantity)} @${money(unitPrice)} =${money(lineTotal)}`;
    const nameWidth = Math.max(1, safeWidth - suffix.length);
    const productName = cleanText(name).slice(0, nameWidth).trimEnd();
    return `${productName}${suffix}`.slice(0, safeWidth);
}

function withEnding(text: string): string {
    const normalised = text.replace(/\r?\n/g, '\r\n');
    return normalised.endsWith('\r\n\r\n') ? normalised : `${normalised}\r\n\r\n`;
}

async function transmitCctvPosText(text: string, config: CctvPosConfig): Promise<void> {
    if (!config.enabled || !config.host.trim()) return;
    await invoke('send_cctv_pos_text', {
        host: config.host.trim(),
        port: config.port,
        text: withEnding(text),
        timeoutMs: 500,
        encoding: config.encoding,
    });
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function markOnline(): void {
    unavailableUntil = 0;
    cctvConnectionState.set({
        status: 'online',
        message: 'Recorder accepted the latest POS text.',
        retryAt: 0,
    });
}

function markOffline(error: unknown): void {
    unavailableUntil = Date.now() + OFFLINE_COOLDOWN_MS;
    cctvConnectionState.set({
        status: 'offline',
        message: `Recorder unavailable: ${errorMessage(error)}`,
        retryAt: unavailableUntil,
    });
}

export async function sendCctvPosText(text: string, config = getCctvPosConfig()): Promise<void> {
    if (!config.enabled || !config.host.trim()) return;
    cctvConnectionState.set({ status: 'sending', message: 'Contacting the recorder...', retryAt: 0 });
    try {
        await transmitCctvPosText(text, config);
        markOnline();
    } catch (error) {
        markOffline(error);
        throw error;
    }
}

async function drainAutomaticQueue(): Promise<void> {
    if (automaticWorkerRunning) return;
    automaticWorkerRunning = true;
    try {
        while (automaticQueue.length > 0) {
            if (Date.now() < unavailableUntil || !getCctvPosConfig().enabled) {
                automaticQueue = [];
                break;
            }

            const message = automaticQueue.shift();
            if (!message) break;
            cctvConnectionState.set({ status: 'sending', message: 'Sending POS text...', retryAt: 0 });
            try {
                await transmitCctvPosText(message.text, message.config);
                markOnline();
            } catch (error) {
                automaticQueue = [];
                markOffline(error);
                console.warn(`CCTV POS ${message.kind} send paused for 15 seconds:`, error);
                break;
            }
        }
    } finally {
        automaticWorkerRunning = false;
    }
}

function queueAutomaticText(text: string, config: CctvPosConfig, kind: CctvMessageKind): void {
    if (!config.enabled || !config.host.trim() || Date.now() < unavailableUntil) return;

    if (automaticQueue.length >= MAX_AUTOMATIC_QUEUE) {
        const oldestItemIndex = automaticQueue.findIndex((message) => message.kind === 'item');
        if (oldestItemIndex >= 0) automaticQueue.splice(oldestItemIndex, 1);
        else automaticQueue.shift();
    }
    automaticQueue.push({ text, config, kind });
    void drainAutomaticQueue();
}

export function formatCctvItemText(payload: CctvItemPayload, config = getCctvPosConfig()): string {
    const quantity = Number.isFinite(payload.quantity) && Number(payload.quantity) > 0
        ? Number(payload.quantity)
        : 1;
    return compactProductLine(
        payload.name,
        quantity,
        payload.price,
        payload.price * quantity,
        config.lineWidth,
    );
}

export function formatCctvReceiptText(payload: CctvReceiptPayload, config = getCctvPosConfig()): string {
    const width = config.lineWidth;
    const rows = payload.lines.slice(0, 30).map((item) => compactProductLine(
        item.name,
        item.quantity,
        item.unitPrice,
        item.lineTotal,
        width,
    ));
    if (payload.discount > 0) rows.push(alignedLine('DISCOUNT', `-${money(payload.discount)}`, width));
    rows.push(alignedLine('TOTAL', money(payload.total), width));
    return rows.join('\r\n');
}

export function sendCctvItemAdded(payload: CctvItemPayload): void {
    const config = getCctvPosConfig();
    if (!config.enabled || !config.sendItems) return;
    queueAutomaticText(formatCctvItemText(payload, config), config, 'item');
}

export function sendCctvReceipt(payload: CctvReceiptPayload): void {
    const config = getCctvPosConfig();
    if (!config.enabled || !config.sendReceipts) return;

    queueAutomaticText(formatCctvReceiptText(payload, config), config, 'receipt');
}
