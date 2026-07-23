import { invoke } from '@tauri-apps/api/core';
import { get, writable } from 'svelte/store';
import { settingsDB, type Setting } from '$lib/stores/db';

export type CctvFramingPreset = 'hikvision' | 'custom';

export interface CctvPosConfig {
    enabled: boolean;
    host: string;
    port: number;
    encoding: 'latin1' | 'utf8';
    lineWidth: number;
    sendItems: boolean;
    sendReceipts: boolean;
    framingPreset: CctvFramingPreset;
    startMarker: string;
    lineSeparator: string;
    endMarker: string;
}

export interface CctvSendResult {
    localAddress: string;
    remoteAddress: string;
    bytesSent: number;
}

export interface CctvConnectionState {
    status: 'idle' | 'sending' | 'online' | 'offline';
    message: string;
    retryAt: number;
    pending: number;
    dropped: number;
    localAddress: string;
    remoteAddress: string;
    lastSentAt: number;
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

export interface CctvActionPayload {
    action: string;
    name?: string;
    quantity?: number;
    amount?: number;
}

export const cctvConnectionState = writable<CctvConnectionState>({
    status: 'idle',
    message: 'No connection test has been run yet.',
    retryAt: 0,
    pending: 0,
    dropped: 0,
    localAddress: '',
    remoteAddress: '',
    lastSentAt: 0,
});

const MAX_AUTOMATIC_QUEUE = 250;
const OFFLINE_COOLDOWN_MS = 15_000;
const RECEIPT_LINES_PER_MESSAGE = 80;

type CctvMessageKind = 'item' | 'receipt' | 'event';

interface QueuedCctvMessage {
    text: string;
    kind: CctvMessageKind;
}

let automaticQueue: QueuedCctvMessage[] = [];
let automaticWorkerRunning = false;
let unavailableUntil = 0;
let droppedMessageCount = 0;
let consecutiveFailures = 0;
let transportGeneration = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

function setting(settings: Setting[], key: string, fallback = ''): string {
    return settings.find((item) => item.key === key)?.value ?? fallback;
}

function boolSetting(settings: Setting[], key: string, fallback: boolean): boolean {
    const value = setting(settings, key, fallback ? 'true' : 'false');
    return value !== 'false';
}

export function suggestedCctvPort(settings: Setting[] = get(settingsDB)): number {
    const sequence = Number(setting(settings, 'till_seq', '1'));
    const safeSequence = Number.isInteger(sequence) && sequence > 0 ? Math.min(sequence, 5_000) : 1;
    return Math.min(65_535, 10_009 + safeSequence);
}

export function getCctvPosConfig(settings: Setting[] = get(settingsDB)): CctvPosConfig {
    const host = setting(settings, 'cctv_pos_host');
    const suggestedPort = suggestedCctvPort(settings);
    const port = Number(setting(settings, 'cctv_pos_port', String(suggestedPort)));
    const framingPreset = setting(settings, 'cctv_pos_framing', 'hikvision') === 'custom'
        ? 'custom'
        : 'hikvision';
    const requestedEncoding = setting(settings, 'cctv_pos_encoding', 'latin1') === 'utf8'
        ? 'utf8'
        : 'latin1';
    return {
        enabled: boolSetting(settings, 'cctv_pos_enabled', false),
        host,
        port: Number.isInteger(port) && port > 0 && port <= 65_535 ? port : suggestedPort,
        encoding: framingPreset === 'hikvision' ? 'latin1' : requestedEncoding,
        lineWidth: normaliseLineWidth(Number(setting(settings, 'cctv_pos_line_width', '32'))),
        sendItems: boolSetting(settings, 'cctv_pos_send_items', true),
        sendReceipts: boolSetting(settings, 'cctv_pos_send_receipts', true),
        framingPreset,
        startMarker: setting(settings, 'cctv_pos_start_marker', ''),
        lineSeparator: setting(settings, 'cctv_pos_line_separator', '\\r\\n'),
        endMarker: setting(settings, 'cctv_pos_end_marker', '\\r\\n\\r\\n'),
    };
}

function money(pence: number): string {
    const amount = Number(pence || 0);
    const sign = amount < 0 ? '-' : '';
    return `${sign}£${(Math.abs(amount) / 100).toFixed(2)}`;
}

function cleanText(value: string): string {
    return String(value || '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normaliseLineWidth(value: number): number {
    if (!Number.isFinite(value)) return 32;
    return Math.max(24, Math.min(32, Math.round(value)));
}

function formatQuantity(value: number | undefined): string {
    const quantity = Number.isFinite(value) && Number(value) > 0 ? Number(value) : 1;
    return Number.isInteger(quantity) ? String(quantity) : quantity.toFixed(3).replace(/\.?0+$/, '');
}

function fitPrefixAndSuffix(prefix: string, suffix: string, width: number): string {
    const safeWidth = normaliseLineWidth(width);
    const cleanSuffix = cleanText(suffix);
    if (cleanSuffix.length >= safeWidth) return cleanSuffix.slice(-safeWidth);
    const prefixWidth = safeWidth - cleanSuffix.length - 1;
    const cleanPrefix = cleanText(prefix).slice(0, Math.max(1, prefixWidth)).trimEnd();
    return `${cleanPrefix} ${cleanSuffix}`.slice(0, safeWidth);
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
    return fitPrefixAndSuffix(
        name,
        `x${formatQuantity(quantity)} @${money(unitPrice)} =${money(lineTotal)}`,
        width,
    );
}

function compactScannedItemLine(
    name: string,
    quantity: number,
    lineTotal: number,
    width: number,
): string {
    return fitPrefixAndSuffix(name, `x${formatQuantity(quantity)} ${money(lineTotal)}`, width);
}

function decodeControlMarkers(value: string): string {
    return String(value || '').replace(/\\x([0-9a-fA-F]{2})|\\r|\\n|\\t|\\\\/g, (match, hex) => {
        if (hex) return String.fromCharCode(Number.parseInt(hex, 16));
        if (match === '\\r') return '\r';
        if (match === '\\n') return '\n';
        if (match === '\\t') return '\t';
        return '\\';
    });
}

export function frameCctvPosText(text: string, config = getCctvPosConfig()): string {
    const logicalText = String(text || '').replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '');
    const lineSeparator = config.framingPreset === 'hikvision'
        ? '\r\n'
        : decodeControlMarkers(config.lineSeparator) || '\n';
    const startMarker = config.framingPreset === 'hikvision'
        ? ''
        : decodeControlMarkers(config.startMarker);
    const endMarker = config.framingPreset === 'hikvision'
        ? '\r\n\r\n'
        : decodeControlMarkers(config.endMarker);
    return `${startMarker}${logicalText.split('\n').join(lineSeparator)}${endMarker}`;
}

async function transmitCctvPosText(text: string, config: CctvPosConfig): Promise<CctvSendResult> {
    if (!config.host.trim()) throw new Error('CCTV host is required');
    return invoke<CctvSendResult>('send_cctv_pos_text', {
        host: config.host.trim(),
        port: config.port,
        text: frameCctvPosText(text, config),
        timeoutMs: 500,
        encoding: config.encoding,
    });
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function updateConnectionState(patch: Partial<CctvConnectionState>): void {
    cctvConnectionState.update((state) => ({
        ...state,
        ...patch,
        pending: automaticQueue.length,
        dropped: droppedMessageCount,
    }));
}

function markOnline(result: CctvSendResult): void {
    unavailableUntil = 0;
    consecutiveFailures = 0;
    updateConnectionState({
        status: 'online',
        message: 'TCP text sent. Check the linked camera to confirm the overlay is visible.',
        retryAt: 0,
        localAddress: result.localAddress,
        remoteAddress: result.remoteAddress,
        lastSentAt: Date.now(),
    });
}

function markOffline(error: unknown): void {
    consecutiveFailures += 1;
    const retryDelay = Math.min(60_000, OFFLINE_COOLDOWN_MS * (2 ** Math.min(2, consecutiveFailures - 1)));
    unavailableUntil = Date.now() + retryDelay;
    updateConnectionState({
        status: 'offline',
        message: `Recorder unavailable: ${errorMessage(error)}`,
        retryAt: unavailableUntil,
    });
}

function clearRetryTimer(): void {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
}

function scheduleAutomaticRetry(): void {
    if (retryTimer || automaticQueue.length === 0) return;
    const delay = Math.max(250, unavailableUntil - Date.now());
    retryTimer = setTimeout(() => {
        retryTimer = undefined;
        void drainAutomaticQueue();
    }, delay);
}

export function resetCctvAutomaticQueue(message = 'CCTV automatic sending is disabled.'): void {
    transportGeneration += 1;
    automaticQueue = [];
    droppedMessageCount = 0;
    unavailableUntil = 0;
    consecutiveFailures = 0;
    clearRetryTimer();
    updateConnectionState({ status: 'idle', message, retryAt: 0 });
}

export async function sendCctvPosText(
    text: string,
    config = getCctvPosConfig(),
): Promise<CctvSendResult> {
    if (!config.host.trim()) throw new Error('CCTV host is required');
    const generation = transportGeneration;
    updateConnectionState({ status: 'sending', message: 'Sending a TCP test...', retryAt: 0 });
    try {
        const result = await transmitCctvPosText(text, config);
        if (generation === transportGeneration) markOnline(result);
        if (automaticQueue.length > 0) void drainAutomaticQueue();
        return result;
    } catch (error) {
        if (generation === transportGeneration) markOffline(error);
        throw error;
    }
}

async function transmitDroppedMessageNotice(config: CctvPosConfig): Promise<boolean> {
    if (droppedMessageCount <= 0) return true;
    const count = droppedMessageCount;
    const generation = transportGeneration;
    try {
        const result = await transmitCctvPosText(
            formatCctvActionText({ action: 'CCTV GAP', name: `${count} older events condensed` }, config),
            config,
        );
        if (generation !== transportGeneration) return true;
        droppedMessageCount = Math.max(0, droppedMessageCount - count);
        markOnline(result);
        return true;
    } catch (error) {
        if (generation !== transportGeneration) return true;
        markOffline(error);
        return false;
    }
}

async function drainAutomaticQueue(): Promise<void> {
    if (automaticWorkerRunning) return;
    automaticWorkerRunning = true;
    clearRetryTimer();
    try {
        while (automaticQueue.length > 0) {
            const cycleGeneration = transportGeneration;
            const config = getCctvPosConfig();
            if (!config.enabled || !config.host.trim()) {
                resetCctvAutomaticQueue();
                break;
            }
            if (Date.now() < unavailableUntil) {
                scheduleAutomaticRetry();
                break;
            }
            if (!await transmitDroppedMessageNotice(config)) {
                scheduleAutomaticRetry();
                break;
            }
            if (cycleGeneration !== transportGeneration) continue;

            const message = automaticQueue[0];
            if (!message) break;
            const generation = transportGeneration;
            updateConnectionState({ status: 'sending', message: `Sending CCTV ${message.kind} text...`, retryAt: 0 });
            try {
                const result = await transmitCctvPosText(message.text, config);
                if (generation !== transportGeneration) continue;
                if (automaticQueue[0] === message) automaticQueue.shift();
                markOnline(result);
            } catch (error) {
                if (generation !== transportGeneration) continue;
                markOffline(error);
                console.warn(`CCTV POS ${message.kind} send will retry:`, error);
                scheduleAutomaticRetry();
                break;
            }
        }
    } finally {
        automaticWorkerRunning = false;
    }
}

function queueAutomaticText(text: string, kind: CctvMessageKind): void {
    const config = getCctvPosConfig();
    if (!config.enabled || !config.host.trim()) return;

    if (automaticQueue.length >= MAX_AUTOMATIC_QUEUE) {
        const oldestItemIndex = automaticQueue.findIndex((message) => message.kind === 'item');
        if (oldestItemIndex >= 0) automaticQueue.splice(oldestItemIndex, 1);
        else automaticQueue.shift();
        droppedMessageCount += 1;
    }
    automaticQueue.push({ text, kind });
    updateConnectionState({});
    if (Date.now() < unavailableUntil) scheduleAutomaticRetry();
    else void drainAutomaticQueue();
}

export function formatCctvItemText(payload: CctvItemPayload, config = getCctvPosConfig()): string {
    const quantity = Number.isFinite(payload.quantity) && Number(payload.quantity) > 0
        ? Number(payload.quantity)
        : 1;
    return compactScannedItemLine(
        payload.name,
        quantity,
        payload.price * quantity,
        config.lineWidth,
    );
}

export function formatCctvActionText(payload: CctvActionPayload, config = getCctvPosConfig()): string {
    const prefix = [cleanText(payload.action).toUpperCase(), cleanText(payload.name || '')]
        .filter(Boolean)
        .join(' ');
    const suffix = [
        Number.isFinite(payload.quantity) && Number(payload.quantity) > 0
            ? `x${formatQuantity(payload.quantity)}`
            : '',
        Number.isFinite(payload.amount) ? money(Number(payload.amount)) : '',
    ].filter(Boolean).join(' ');
    if (!suffix) return cleanText(prefix).slice(0, config.lineWidth);
    return fitPrefixAndSuffix(prefix, suffix, config.lineWidth);
}

function formatReceiptRows(payload: CctvReceiptPayload, config: CctvPosConfig): string[] {
    return payload.lines.map((item) => compactProductLine(
        item.name,
        item.quantity,
        item.unitPrice,
        item.lineTotal,
        config.lineWidth,
    ));
}

export function formatCctvReceiptText(payload: CctvReceiptPayload, config = getCctvPosConfig()): string {
    const rows = formatReceiptRows(payload, config);
    if (payload.discount > 0) rows.push(alignedLine('DISCOUNT', money(-payload.discount), config.lineWidth));
    rows.push(alignedLine('TOTAL', money(payload.total), config.lineWidth));
    return rows.join('\n');
}

export function sendCctvItemAdded(payload: CctvItemPayload): void {
    const config = getCctvPosConfig();
    if (!config.enabled || !config.sendItems) return;
    queueAutomaticText(formatCctvItemText(payload, config), 'item');
}

export function sendCctvAction(
    payload: CctvActionPayload,
    channel: 'item' | 'receipt' = 'item',
): void {
    const config = getCctvPosConfig();
    if (!config.enabled) return;
    if (channel === 'item' && !config.sendItems) return;
    if (channel === 'receipt' && !config.sendReceipts) return;
    queueAutomaticText(formatCctvActionText(payload, config), 'event');
}

export function sendCctvReceipt(payload: CctvReceiptPayload): void {
    const config = getCctvPosConfig();
    if (!config.enabled || !config.sendReceipts) return;

    for (const message of formatCctvReceiptMessages(payload, config)) {
        queueAutomaticText(message, 'receipt');
    }
}

export function formatCctvReceiptMessages(
    payload: CctvReceiptPayload,
    config = getCctvPosConfig(),
): string[] {
    const rows = formatReceiptRows(payload, config);
    const chunkCount = Math.max(1, Math.ceil(rows.length / RECEIPT_LINES_PER_MESSAGE));
    const messages: string[] = [];
    for (let index = 0; index < chunkCount; index += 1) {
        const chunkRows = rows.slice(
            index * RECEIPT_LINES_PER_MESSAGE,
            (index + 1) * RECEIPT_LINES_PER_MESSAGE,
        );
        if (chunkCount > 1) {
            chunkRows.unshift(alignedLine('RECEIPT', `${index + 1}/${chunkCount}`, config.lineWidth));
        }
        if (index === chunkCount - 1) {
            if (payload.discount > 0) {
                chunkRows.push(alignedLine('DISCOUNT', money(-payload.discount), config.lineWidth));
            }
            chunkRows.push(alignedLine('TOTAL', money(payload.total), config.lineWidth));
        }
        messages.push(chunkRows.join('\n'));
    }
    return messages;
}
