import { invoke } from '@tauri-apps/api/core';
import { get } from 'svelte/store';
import { formatMoney, settingsDB, type Order, type OrderLine, type Product, type Setting, type Store } from '$lib/stores/db';
import type { ReceiptDesign } from '$lib/receipt';
import { defaultLabelDesign, type LabelDesign, type LabelTextScale } from '$lib/labels';
import { getScaleSaleDisplay } from '$lib/scaleSale';

export type PrinterConnectionType = 'system' | 'network_escpos' | 'usb_raw' | 'serial' | 'bluetooth';
export type ReceiptPaperWidth = '58mm' | '80mm';
export type ReceiptPrinterModel = 'generic_escpos' | 'star_tsp100';
export type LabelPrinterProtocol = 'system' | 'escpos' | 'zpl' | 'tspl';

export interface ReceiptPrinterConfig {
    enabled: boolean;
    connection: PrinterConnectionType;
    host: string;
    port: number;
    printerName: string;
    devicePath: string;
    baudRate: number;
    paperWidth: ReceiptPaperWidth;
    model: ReceiptPrinterModel;
    autoPrintAfterPayment: boolean;
    cutPaper: boolean;
    cutFeedLines: number;
    openDrawerAfterPayment: boolean;
    encoding: 'latin1' | 'utf8';
}

export interface LabelPrinterConfig {
    enabled: boolean;
    connection: PrinterConnectionType;
    protocol: LabelPrinterProtocol;
    host: string;
    port: number;
    printerName: string;
    devicePath: string;
    baudRate: number;
    cutPaper: boolean;
    gapLines: number;
    dpi: number;
    paperWidth: ReceiptPaperWidth;
}

function setting(settings: Setting[], key: string, fallback = ''): string {
    return settings.find((item) => item.key === key)?.value || fallback;
}

function boolSetting(settings: Setting[], key: string, fallback: boolean): boolean {
    return setting(settings, key, fallback ? 'true' : 'false') !== 'false';
}

function portSetting(settings: Setting[], key: string, fallback: number): number {
    const value = Number(setting(settings, key, String(fallback)));
    return Number.isInteger(value) && value > 0 && value <= 65535 ? value : fallback;
}

function intSetting(settings: Setting[], key: string, fallback: number, min: number, max: number): number {
    const value = Number(setting(settings, key, String(fallback)));
    if (!Number.isInteger(value)) return fallback;
    return Math.min(max, Math.max(min, value));
}

const DIRECT_CONNECTIONS = new Set<PrinterConnectionType>(['network_escpos', 'usb_raw', 'serial', 'bluetooth']);
const ALL_CONNECTIONS = new Set<PrinterConnectionType>(['system', 'network_escpos', 'usb_raw', 'serial', 'bluetooth']);

function normalizePrinterConnection(value: string, fallback: PrinterConnectionType): PrinterConnectionType {
    if (ALL_CONNECTIONS.has(value as PrinterConnectionType)) return value as PrinterConnectionType;
    if (value === 'network' || value === 'tcp' || value === 'ethernet') return 'network_escpos';
    if (value === 'usb' || value === 'windows' || value === 'windows_raw') return 'usb_raw';
    if (value === 'com') return 'serial';
    return fallback;
}

function normalizeReceiptPrinterModel(value: string): ReceiptPrinterModel {
    return value === 'star_tsp100' ? 'star_tsp100' : 'generic_escpos';
}

export function getReceiptPrinterConfig(settings: Setting[] = get(settingsDB)): ReceiptPrinterConfig {
    const host = setting(settings, 'receipt_printer_host');
    const printerName = setting(settings, 'receipt_printer_name');
    const devicePath = setting(settings, 'receipt_printer_device_path');
    const fallbackConnection = host.trim()
        ? 'network_escpos'
        : printerName.trim()
            ? 'usb_raw'
            : devicePath.trim()
                ? 'serial'
                : 'system';
    const configuredConnection = setting(settings, 'receipt_printer_connection', fallbackConnection);
    const connection = normalizePrinterConnection(
        configuredConnection === 'system' && fallbackConnection !== 'system' ? fallbackConnection : configuredConnection,
        fallbackConnection
    );
    return {
        enabled: boolSetting(settings, 'receipt_printer_enabled', true),
        connection,
        host,
        port: portSetting(settings, 'receipt_printer_port', 9100),
        printerName,
        devicePath,
        baudRate: portSetting(settings, 'receipt_printer_baud_rate', 9600),
        paperWidth: setting(settings, 'receipt_printer_paper_width', '80mm') === '58mm' ? '58mm' : '80mm',
        model: normalizeReceiptPrinterModel(setting(settings, 'receipt_printer_model', 'generic_escpos')),
        autoPrintAfterPayment: boolSetting(settings, 'receipt_printer_auto_print_after_payment', false),
        cutPaper: boolSetting(settings, 'receipt_printer_cut_paper', true),
        cutFeedLines: intSetting(settings, 'receipt_printer_cut_feed_lines', 8, 0, 20),
        openDrawerAfterPayment: boolSetting(
            settings,
            'receipt_printer_open_drawer_after_payment',
            boolSetting(settings, 'receipt_printer_open_drawer_after_cash', false)
        ),
        encoding: setting(settings, 'receipt_printer_encoding', 'latin1') === 'utf8' ? 'utf8' : 'latin1',
    };
}

export function getLabelPrinterConfig(settings: Setting[] = get(settingsDB)): LabelPrinterConfig {
    const receipt = getReceiptPrinterConfig(settings);
    const labelHost = setting(settings, 'label_printer_host');
    const labelPrinterName = setting(settings, 'label_printer_name');
    const labelDevicePath = setting(settings, 'label_printer_device_path');
    const configuredConnection = setting(settings, 'label_printer_connection', '');
    const fallbackConnection = labelHost.trim()
        ? 'network_escpos'
        : labelPrinterName.trim()
            ? 'usb_raw'
            : labelDevicePath.trim()
                ? 'serial'
                : 'system';
    const connection = normalizePrinterConnection(
        configuredConnection || fallbackConnection,
        fallbackConnection
    );
    const protocolRaw = setting(settings, 'label_printer_protocol', '');
    const directProtocol = protocolRaw === 'escpos' || protocolRaw === 'zpl' || protocolRaw === 'tspl'
        ? protocolRaw
        : 'escpos';
    return {
        enabled: boolSetting(settings, 'label_printer_enabled', true),
        connection,
        protocol: DIRECT_CONNECTIONS.has(connection) ? directProtocol : 'system',
        host: labelHost,
        port: portSetting(settings, 'label_printer_port', receipt.port || 9100),
        printerName: labelPrinterName,
        devicePath: labelDevicePath,
        baudRate: portSetting(settings, 'label_printer_baud_rate', receipt.baudRate || 9600),
        cutPaper: boolSetting(settings, 'label_printer_cut_paper', false),
        gapLines: intSetting(settings, 'label_printer_gap_lines', directProtocol === 'tspl' ? 2 : 0, 0, 12),
        dpi: intSetting(settings, 'label_printer_dpi', 203, 100, 1200),
        paperWidth: receipt.paperWidth,
    };
}

function encodeText(text: string, encoding: 'latin1' | 'utf8'): number[] {
    if (encoding === 'utf8') return Array.from(new TextEncoder().encode(text));
    return Array.from(text).map((char) => {
        const code = char.charCodeAt(0);
        return code <= 0xff ? code : 63;
    });
}

function line(text = '', encoding: 'latin1' | 'utf8' = 'latin1'): number[] {
    return [...encodeText(text, encoding), 0x0a];
}

function feedLines(count: number): number[] {
    return Array(Math.max(0, Math.min(20, Math.floor(count || 0)))).fill(0x0a);
}

function receiptCut(config: ReceiptPrinterConfig): number[] {
    if (!config.cutPaper) return [];
    const escposCutCommand = [0x1d, 0x56, 0x00];
    const starCutFallback = config.model === 'star_tsp100'
        ? [0x1b, 0x64, 0x02]
        : [];
    return [...feedLines(config.cutFeedLines), ...escposCutCommand, ...starCutFallback];
}

function money(pence: number): string {
    return `${(Number(pence || 0) / 100).toFixed(2)}`;
}

function cleanReceiptText(value: string, max = 42): string {
    return String(value || '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

function textRow(left: string, right: string, width: number): string {
    const cleanLeft = cleanReceiptText(left, width);
    const cleanRight = cleanReceiptText(right, width);
    const space = Math.max(1, width - cleanLeft.length - cleanRight.length);
    return `${cleanLeft}${' '.repeat(space)}${cleanRight}`;
}

function thermalReportLines(text: string, width: number): string[] {
    const output: string[] = [];
    const source = String(text || '')
        .replace(/\r/g, '')
        .replace(/\u2192/g, '->')
        .replace(/[\u2013\u2014]/g, '-')
        .replace(/\t/g, '    ');
    for (const rawLine of source.split('\n')) {
        let lineText = rawLine.replace(/\s+$/g, '');
        if (!lineText) {
            output.push('');
            continue;
        }
        while (lineText.length > width) {
            let splitAt = lineText.lastIndexOf(' ', width);
            if (splitAt < Math.floor(width * 0.45)) splitAt = width;
            output.push(lineText.slice(0, splitAt).trimEnd());
            lineText = lineText.slice(splitAt).trimStart();
        }
        output.push(lineText);
    }
    return output;
}

export function buildEscposTestReceipt(config = getReceiptPrinterConfig()): number[] {
    const width = config.paperWidth === '58mm' ? 32 : 42;
    const divider = '-'.repeat(width);
    const centerOn = [0x1b, 0x61, 0x01];
    const leftOn = [0x1b, 0x61, 0x00];
    const boldOn = [0x1b, 0x45, 0x01];
    const boldOff = [0x1b, 0x45, 0x00];
    const receiptFontSelect = [0x1b, 0x4d, 0x00];
    const bytes = [
        0x1b, 0x40,
        ...receiptFontSelect,
        ...centerOn,
        ...boldOn,
        ...line('L&Bj POS', config.encoding),
        ...boldOff,
        ...line('Printer setup test', config.encoding),
        ...line(new Date().toLocaleString('en-GB'), config.encoding),
        ...leftOn,
        ...line(divider, config.encoding),
        ...line(`Connection: ${config.connection}`, config.encoding),
        ...line(`Model: ${config.model === 'star_tsp100' ? 'Star TSP100' : 'Generic ESC/POS'}`, config.encoding),
        ...line(`Paper: ${config.paperWidth}`, config.encoding),
        ...line('If you can read this, printing works.', config.encoding),
        ...line(divider, config.encoding),
        ...line('Item              Qty     Total', config.encoding),
        ...line('Test Product       1       1.00', config.encoding),
        ...line(divider, config.encoding),
        ...boldOn,
        ...line('TOTAL                      1.00', config.encoding),
        ...boldOff,
        ...line('', config.encoding),
        ...line('', config.encoding),
    ];
    bytes.push(...receiptCut(config));
    return bytes;
}

export function buildEscposTextReport(text: string, config = getReceiptPrinterConfig()): number[] {
    const width = config.paperWidth === '58mm' ? 32 : 42;
    const bytes = [
        0x1b, 0x40,
        0x1b, 0x4d, 0x00,
        0x1b, 0x61, 0x00,
    ];
    for (const reportLine of thermalReportLines(text, width)) {
        bytes.push(...line(reportLine, config.encoding));
    }
    bytes.push(...receiptCut(config));
    return bytes;
}

function isDirectConnection(connection: PrinterConnectionType): boolean {
    return DIRECT_CONNECTIONS.has(connection);
}

async function sendDirectPrinterData(args: {
    connection: PrinterConnectionType;
    data: number[];
    host?: string;
    port?: number;
    printerName?: string;
    devicePath?: string;
    documentName?: string;
}) {
    if (args.connection === 'network_escpos') {
        if (!args.host?.trim()) throw new Error('Enter the printer IP address');
        await invoke('send_raw_printer_data', {
            host: args.host.trim(),
            port: args.port || 9100,
            data: args.data,
            timeoutMs: 1500,
        });
        return;
    }
    if (args.connection === 'usb_raw') {
        if (!args.printerName?.trim()) throw new Error('Enter the Windows printer name');
        await invoke('send_system_printer_data', {
            printerName: args.printerName.trim(),
            data: args.data,
            documentName: args.documentName || 'L&Bj POS print job',
        });
        return;
    }
    if (args.connection === 'serial' || args.connection === 'bluetooth') {
        if (!args.devicePath?.trim()) throw new Error('Enter the printer port/device path');
        await invoke('send_device_printer_data', {
            devicePath: args.devicePath.trim(),
            data: args.data,
        });
        return;
    }
    throw new Error('Direct printing is not available for System printer mode');
}

type ReceiptPayload = {
    store: Store;
    order: Order;
    lines: OrderLine[];
    cashierName: string;
    tillName: string;
    design: ReceiptDesign;
};

export function buildEscposReceipt(payload: ReceiptPayload, config = getReceiptPrinterConfig()): number[] {
    const width = config.paperWidth === '58mm' ? 32 : 42;
    const divider = '-'.repeat(width);
    const centerOn = [0x1b, 0x61, 0x01];
    const leftOn = [0x1b, 0x61, 0x00];
    const boldOn = [0x1b, 0x45, 0x01];
    const boldOff = [0x1b, 0x45, 0x00];
    const normalSize = [0x1d, 0x21, 0x00];
    const receiptFontSelect = [0x1b, 0x4d, payload.design.fontFamily === 'condensed' ? 0x01 : 0x00];
    const titleSize = payload.design.titleTextSize === 'large' ? [0x1d, 0x21, 0x11] : normalSize;
    const titleFontSelect = payload.design.titleTextSize === 'small' ? [0x1b, 0x4d, 0x01] : receiptFontSelect;
    const receiptBarcode = String(payload.order.orderNumber || payload.order.receiptKey || payload.order.id || '')
        .toUpperCase()
        .replace(/[^0-9A-Z. $/+%-]/g, '')
        .slice(0, 32);
    const bytes = [
        0x1b, 0x40,
        ...receiptFontSelect,
        ...centerOn,
        ...titleFontSelect,
        ...titleSize,
        ...boldOn,
        ...line(payload.design.headerText || payload.store.name || 'L&Bj POS', config.encoding),
        ...boldOff,
        ...normalSize,
        ...receiptFontSelect,
    ];

    if (payload.design.showAddress && payload.store.address) bytes.push(...line(payload.store.address, config.encoding));
    if (payload.design.showPhone && payload.store.phone) bytes.push(...line(payload.store.phone, config.encoding));
    if (payload.design.showEmail && payload.store.email) bytes.push(...line(payload.store.email, config.encoding));
    if (payload.design.customMessage) bytes.push(...line(payload.design.customMessage, config.encoding));

    bytes.push(...leftOn, ...line(divider, config.encoding));
    if (payload.design.showReceiptNumber) bytes.push(...line(textRow('Receipt', `#${payload.order.orderNumber || '-'}`, width), config.encoding));
    if (payload.design.showDateTime) bytes.push(...line(textRow('Date', new Date(payload.order.completedAt || Date.now()).toLocaleString('en-GB'), width), config.encoding));
    if (payload.design.showCashier) bytes.push(...line(textRow('Cashier', payload.cashierName || payload.order.employeeId || '-', width), config.encoding));
    if (payload.design.showTill) bytes.push(...line(textRow('Till', payload.tillName || payload.order.tillNumber || '-', width), config.encoding));

    bytes.push(...line(divider, config.encoding));
    for (const item of payload.lines) {
        const scaleDisplay = getScaleSaleDisplay(item.notes, item.quantity, item.unitPrice, item.originalPrice);
        const lineTotal = item.lineTotal ?? item.unitPrice * item.quantity;
        bytes.push(...line(cleanReceiptText(item.productName, width), config.encoding));
        bytes.push(...line(textRow(scaleDisplay.label, money(lineTotal), width), config.encoding));
        if (payload.design.showSku && item.productId) bytes.push(...line(`ID: ${cleanReceiptText(item.productId, width - 4)}`, config.encoding));
    }

    bytes.push(...line(divider, config.encoding));
    if ((payload.order.discountAmount || 0) !== 0) {
        bytes.push(...line(textRow('Subtotal', money(payload.order.subtotal), width), config.encoding));
        bytes.push(...line(textRow('Discount', `-${money(payload.order.discountAmount)}`, width), config.encoding));
    }
    bytes.push(...boldOn, ...line(textRow('TOTAL', money(payload.order.total), width), config.encoding), ...boldOff);
    if (payload.design.showPayment) {
        bytes.push(...line(textRow((payload.order.paymentMethod || 'cash').toUpperCase(), money(payload.order.amountTendered || payload.order.total), width), config.encoding));
        if ((payload.order.amountTendered || 0) > payload.order.total) {
            bytes.push(...line(textRow('Change', money((payload.order.amountTendered || 0) - payload.order.total), width), config.encoding));
        }
    }

    bytes.push(...line(divider, config.encoding), ...centerOn);
    bytes.push(...line(payload.design.footerText || payload.store.receiptFooter || 'Thank you', config.encoding));
    if (payload.design.showBarcode && receiptBarcode) {
        bytes.push(...escposCode39(receiptBarcode), ...line('', config.encoding));
    }
    bytes.push(...receiptCut(config));
    return bytes;
}

export async function sendEscposNetworkTest(config = getReceiptPrinterConfig()): Promise<void> {
    return sendReceiptPrinterTest(config);
}

export async function sendReceiptPrinterTest(config = getReceiptPrinterConfig()): Promise<void> {
    if (!config.enabled) throw new Error('Receipt printer is disabled');
    if (!isDirectConnection(config.connection)) throw new Error('Choose Network, USB raw, Serial, or Bluetooth for direct test printing');
    await sendDirectPrinterData({
        connection: config.connection,
        host: config.host,
        port: config.port,
        printerName: config.printerName,
        devicePath: config.devicePath,
        data: buildEscposTestReceipt(config),
        documentName: 'L&Bj POS receipt test',
    });
}

async function printReceiptPayload(payload: ReceiptPayload, config: ReceiptPrinterConfig): Promise<void> {
    if (!isDirectConnection(config.connection)) throw new Error('Printing needs Network, USB raw, Serial, or Bluetooth direct mode');
    await sendDirectPrinterData({
        connection: config.connection,
        host: config.host,
        port: config.port,
        printerName: config.printerName,
        devicePath: config.devicePath,
        data: buildEscposReceipt(payload, config),
        documentName: `Receipt ${payload.order.orderNumber || ''}`.trim(),
    });
}

export async function printEscposReceipt(payload: ReceiptPayload, config = getReceiptPrinterConfig()): Promise<void> {
    if (!config.enabled) throw new Error('Receipt printer is disabled');
    await printReceiptPayload(payload, config);
}

export async function sendEscposReceipt(payload: ReceiptPayload, config = getReceiptPrinterConfig()): Promise<void> {
    if (!config.enabled) throw new Error('Receipt printer is disabled');
    if (!config.autoPrintAfterPayment) return;
    await printReceiptPayload(payload, config);
}

export async function printEscposTextReport(
    text: string,
    documentName = 'L&Bj POS report',
    config = getReceiptPrinterConfig()
): Promise<void> {
    if (!config.enabled) throw new Error('Receipt printer is disabled');
    if (!isDirectConnection(config.connection)) throw new Error('Set Receipt Printer to USB raw, Network, Serial, or Bluetooth first');
    await sendDirectPrinterData({
        connection: config.connection,
        host: config.host,
        port: config.port,
        printerName: config.printerName,
        devicePath: config.devicePath,
        data: buildEscposTextReport(text, config),
        documentName,
    });
}

type ProductLabelPayload = {
    product: Product;
    store: Store;
    design: LabelDesign;
    quantity: number;
};

function labelCopies(quantity: number): number {
    return Math.max(1, Math.min(500, Math.floor(Number(quantity) || 1)));
}

function labelBarcodeValue(product: Product): string {
    return cleanReceiptText(product.barcode || product.sku || product.scalePlu || product.id.slice(0, 12), 48);
}

function labelText(value: string, max = 36): string {
    return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function labelWidthMm(design: LabelDesign): number {
    return Math.max(15, Math.min(210, Number(design.widthMm) || 50));
}

function labelHeightMm(design: LabelDesign): number {
    return Math.max(15, Math.min(297, Number(design.heightMm) || 30));
}

function labelTextColumns(design: LabelDesign, kind: 'normal' | 'name' | 'price' = 'normal'): number {
    const width = labelWidthMm(design);
    const base = width >= 76
        ? 42
        : width >= 62
            ? 36
            : width >= 50
                ? 30
                : width >= 40
                    ? 24
                    : 18;
    if (kind === 'price') return Math.max(8, Math.floor(base * 0.7));
    if (kind === 'name') return Math.max(10, Math.floor(base * (labelNameScale(design) > 1 ? 0.78 : 0.9)));
    return base;
}

function wrapLabelText(value: string, maxChars: number, maxLines: number): string[] {
    const words = labelText(value, Math.max(maxChars * maxLines * 2, maxChars)).split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    const lines: string[] = [];
    let current = '';
    for (const word of words) {
        const next = current ? `${current} ${word}` : word;
        if (next.length <= maxChars) {
            current = next;
            continue;
        }
        if (current) lines.push(current);
        current = word.slice(0, maxChars);
        if (lines.length >= maxLines) break;
    }
    if (current && lines.length < maxLines) lines.push(current);
    if (lines.length > 0 && words.join(' ').length > lines.join(' ').length) {
        const lastIndex = lines.length - 1;
        lines[lastIndex] = lines[lastIndex].length > Math.max(3, maxChars - 1)
            ? `${lines[lastIndex].slice(0, Math.max(0, maxChars - 3))}...`
            : lines[lastIndex];
    }
    return lines;
}

function labelPrice(product: Product): string {
    return `GBP ${money(product.price)}`;
}

function labelScaleValue(scale: LabelTextScale | undefined): number {
    return scale === 'small' ? 0.68 : scale === 'large' ? 1.32 : 1;
}

function labelScale(design: LabelDesign): number {
    return labelScaleValue(design.textScale);
}

function labelNameScale(design: LabelDesign): number {
    return labelScaleValue(design.nameTextScale || design.textScale);
}

function labelPriceScale(design: LabelDesign): number {
    return labelScaleValue(design.priceTextScale || design.textScale);
}

function labelShowsBarcode(design: LabelDesign): boolean {
    return design.showBarcode !== false;
}

function zplFont(size: number, design: LabelDesign, scale = labelScale(design)): string {
    const scaled = Math.max(12, Math.round(size * scale));
    return `^A0N,${scaled},${Math.max(10, Math.round(scaled * 0.86))}`;
}

function tsplScale(design: LabelDesign): number {
    return design.textScale === 'large' ? 2 : 1;
}

function tsplSizeScale(scale: LabelTextScale | undefined): number {
    return scale === 'large' ? 2 : 1;
}

function tsplNameFont(design: LabelDesign): string {
    return design.nameTextScale === 'small' ? '2' : design.nameTextScale === 'large' ? '4' : '3';
}

function tsplPriceFont(design: LabelDesign): string {
    return design.priceTextScale === 'small' ? '3' : '4';
}

function tsplFontWidth(font: string): number {
    if (font === '4') return 24;
    if (font === '3') return 16;
    if (font === '2') return 12;
    return 8;
}

function centeredX(width: number, margin: number, contentWidth: number): number {
    const printableWidth = Math.max(1, width - margin * 2);
    return Math.max(margin, Math.round((width - Math.min(contentWidth, printableWidth)) / 2));
}

function estimatedBarcodeWidth(value: string, moduleWidth: number): number {
    return Math.max(40, Math.round((value.length * 11 + 35) * moduleWidth));
}

function tsplCenteredText(width: number, margin: number, y: number, font: string, scale: number, value: string): string {
    const escaped = tsplEscape(value);
    const x = centeredX(width, margin, escaped.length * tsplFontWidth(font) * scale);
    return `TEXT ${x},${y},"${font}",0,${scale},${scale},"${escaped}"`;
}

function escposFontSelect(design: LabelDesign): number[] {
    return [0x1b, 0x4d, design.fontFamily === 'condensed' ? 0x01 : 0x00];
}

function escposTextSize(design: LabelDesign, kind: 'normal' | 'name' | 'price'): number[] {
    const scale = kind === 'price'
        ? design.priceTextScale || design.textScale
        : kind === 'name'
            ? design.nameTextScale || design.textScale
            : design.textScale;
    if (kind === 'price') {
        return [0x1d, 0x21, scale === 'small' ? 0x10 : scale === 'large' ? 0x22 : 0x11];
    }
    return [0x1d, 0x21, scale === 'large' ? 0x01 : 0x00];
}

function escposCut(cutPaper: boolean): number[] {
    return cutPaper ? [0x1d, 0x56, 0x00] : [];
}

function zplEscape(value: string): string {
    return labelText(value, 80).replace(/[\^~]/g, ' ');
}

function tsplEscape(value: string): string {
    return labelText(value, 80).replace(/"/g, "'");
}

function labelDotsPerMm(dpi: number): number {
    return Math.max(4, (Number(dpi) || 203) / 25.4);
}

function mmToDots(mm: number, dotsPerMm = 8): number {
    return Math.max(80, Math.round((Number(mm) || 1) * dotsPerMm));
}

function escposPrintableWidthDots(paperWidth: ReceiptPaperWidth, dotsPerMm: number): number {
    const printableMm = paperWidth === '58mm' ? 48 : 72;
    return Math.max(80, Math.round(printableMm * dotsPerMm));
}

function labelMarginDots(widthDots: number): number {
    return Math.max(10, Math.min(30, Math.round(widthDots * 0.045)));
}

function zplBarcodeModuleWidth(widthDots: number, barcode: string): number {
    if (widthDots >= 620 && barcode.length <= 18) return 3;
    if (widthDots >= 300) return 2;
    return 1;
}

function tsplBarcodeWidth(widthDots: number, barcode: string): { narrow: number; wide: number } {
    const narrow = widthDots >= 620 && barcode.length <= 18 ? 3 : 2;
    return { narrow, wide: Math.max(narrow, narrow * 2) };
}

function buildZplProductLabel(payload: ProductLabelPayload, dotsPerMm: number, cutPaper = false): number[] {
    const { product, store, design } = payload;
    const widthMm = labelWidthMm(design);
    const heightMm = labelHeightMm(design);
    const width = mmToDots(widthMm, dotsPerMm);
    const height = mmToDots(heightMm, dotsPerMm);
    const margin = labelMarginDots(width);
    let y = 10;
    const lines = ['^XA', '^CI28', `^PW${width}`, `^LL${height}`, '^LH0,0', '^LT0'];
    if (cutPaper) lines.push('^MMC');
    if (design.showStore && store.name) {
        lines.push(`^FO${margin},${y}${zplFont(18, design)}^FB${width - margin * 2},1,0,C^FD${zplEscape(store.name)}^FS`);
        y += Math.round(24 * labelScale(design));
    }
    if (design.showName) {
        const nameLines = widthMm >= 70 && heightMm >= 45 ? 2 : 1;
        const nameFont = widthMm >= 70 ? 30 : 26;
        lines.push(`^FO${margin},${y}${zplFont(nameFont, design, labelNameScale(design))}^FB${width - margin * 2},${nameLines},2,C^FD${zplEscape(product.name)}^FS`);
        y += Math.round((nameLines === 2 ? 62 : 38) * labelNameScale(design));
    }
    if (design.showPrice) {
        const priceFont = widthMm >= 70 ? 52 : 44;
        lines.push(`^FO${margin},${y}${zplFont(priceFont, design, labelPriceScale(design))}^FB${width - margin * 2},1,0,C^FD${zplEscape(labelPrice(product))}^FS`);
        y += Math.round((widthMm >= 70 ? 58 : 48) * labelPriceScale(design));
    }
    const barcode = labelBarcodeValue(product);
    const hasBarcode = labelShowsBarcode(design);
    const footer: string[] = [];
    if (design.showSku && product.sku) footer.push(`SKU ${product.sku}`);
    if (design.showPlu && product.scalePlu) footer.push(`PLU ${product.scalePlu}`);
    const footerReserve = footer.length > 0 ? 28 : 8;
    const barcodeSpace = Math.max(0, height - y - footerReserve - 8);
    const barcodeHeight = Math.min(Math.round(height * (heightMm >= 60 ? 0.34 : 0.3)), barcodeSpace);
    if (hasBarcode && barcode && barcodeHeight >= 28) {
        const moduleWidth = zplBarcodeModuleWidth(width, barcode);
        const barcodeX = centeredX(width, margin, estimatedBarcodeWidth(barcode, moduleWidth));
        lines.push(`^BY${moduleWidth},2,${barcodeHeight}`);
        lines.push(`^FO${barcodeX},${Math.max(y, height - barcodeHeight - 34)}^BCN,${barcodeHeight},${design.showBarcodeText ? 'Y' : 'N'},N,N^FD${zplEscape(barcode)}^FS`);
    }
    if (footer.length > 0) {
        lines.push(`^FO${margin},${height - 24}${zplFont(18, design)}^FB${width - margin * 2},1,0,C^FD${zplEscape(footer.join('  '))}^FS`);
    }
    lines.push(`^PQ${labelCopies(payload.quantity)},0,1,N`, '^XZ', '');
    return Array.from(new TextEncoder().encode(lines.join('\n')));
}

function buildTsplProductLabel(payload: ProductLabelPayload, gapLines: number, dotsPerMm: number, cutPaper = false): number[] {
    const { product, store, design } = payload;
    const widthMm = labelWidthMm(design);
    const heightMm = labelHeightMm(design);
    const width = mmToDots(widthMm, dotsPerMm);
    const height = mmToDots(heightMm, dotsPerMm);
    const margin = labelMarginDots(width);
    const scale = tsplScale(design);
    let y = 10;
    const lines = [
        `SIZE ${widthMm} mm,${heightMm} mm`,
        `GAP ${Math.max(0, Math.min(12, gapLines))} mm,0`,
        'DIRECTION 1',
        'REFERENCE 0,0',
        'OFFSET 0 mm',
        ...(cutPaper ? ['SET CUTTER ON'] : []),
        'CLS',
    ];
    if (design.showStore && store.name) {
        lines.push(tsplCenteredText(width, margin, y, '2', scale, store.name));
        y += 26 * scale;
    }
    if (design.showName) {
        const nameScale = tsplSizeScale(design.nameTextScale || design.textScale);
        const nameFont = tsplNameFont(design);
        const maxLines = widthMm >= 70 && heightMm >= 45 ? 2 : 1;
        const nameLines = wrapLabelText(product.name, labelTextColumns(design, 'name'), maxLines);
        for (const nameLine of nameLines) {
            lines.push(tsplCenteredText(width, margin, y, nameFont, nameScale, nameLine));
            y += Math.round((nameScale > 1 ? 32 : 24) * labelNameScale(design));
        }
        y += 4;
    }
    if (design.showPrice) {
        const priceScale = tsplSizeScale(design.priceTextScale || design.textScale);
        lines.push(tsplCenteredText(width, margin, y, tsplPriceFont(design), priceScale, labelPrice(product)));
        y += Math.round((widthMm >= 70 ? 58 : 50) * labelPriceScale(design));
    }
    const barcode = labelBarcodeValue(product);
    const hasBarcode = labelShowsBarcode(design);
    const footer: string[] = [];
    if (design.showSku && product.sku) footer.push(`SKU ${product.sku}`);
    if (design.showPlu && product.scalePlu) footer.push(`PLU ${product.scalePlu}`);
    const footerReserve = footer.length > 0 ? 28 : 8;
    const barcodeSpace = Math.max(0, height - y - footerReserve - 8);
    const barcodeHeight = Math.min(Math.round(height * (heightMm >= 60 ? 0.34 : 0.3)), barcodeSpace);
    if (hasBarcode && barcode && barcodeHeight >= 28) {
        const barcodeWidth = tsplBarcodeWidth(width, barcode);
        const barcodeX = centeredX(width, margin, estimatedBarcodeWidth(barcode, barcodeWidth.narrow));
        lines.push(`BARCODE ${barcodeX},${Math.max(y, height - barcodeHeight - 28)},"128",${barcodeHeight},${design.showBarcodeText ? 1 : 0},0,${barcodeWidth.narrow},${barcodeWidth.wide},"${tsplEscape(barcode)}"`);
    }
    if (footer.length > 0) lines.push(tsplCenteredText(width, margin, height - 24, '1', scale, footer.join('  ')));
    lines.push(`PRINT ${labelCopies(payload.quantity)}`, '');
    return Array.from(new TextEncoder().encode(lines.join('\r\n')));
}

function escposCode39(value: string, options: { height?: number; moduleWidth?: number; showText?: boolean } = {}): number[] {
    const safe = value.toUpperCase().replace(/[^0-9A-Z $%+\-.\/:]/g, '').slice(0, 48);
    if (!safe) return [];
    const height = Math.max(24, Math.min(180, Math.round(options.height ?? 0x45)));
    const moduleWidth = Math.max(2, Math.min(6, Math.round(options.moduleWidth ?? 2)));
    const hriPosition = options.showText === false ? 0x00 : 0x02;
    return [
        0x1d, 0x48, hriPosition,
        0x1d, 0x68, height,
        0x1d, 0x77, moduleWidth,
        0x1d, 0x6b, 0x45,
        safe.length,
        ...encodeText(safe, 'latin1'),
    ];
}

const CODE39_PATTERNS: Record<string, string> = {
    '0': 'nnnwwnwnn',
    '1': 'wnnwnnnnw',
    '2': 'nnwwnnnnw',
    '3': 'wnwwnnnnn',
    '4': 'nnnwwnnnw',
    '5': 'wnnwwnnnn',
    '6': 'nnwwwnnnn',
    '7': 'nnnwnnwnw',
    '8': 'wnnwnnwnn',
    '9': 'nnwwnnwnn',
    A: 'wnnnnwnnw',
    B: 'nnwnnwnnw',
    C: 'wnwnnwnnn',
    D: 'nnnnwwnnw',
    E: 'wnnnwwnnn',
    F: 'nnwnwwnnn',
    G: 'nnnnnwwnw',
    H: 'wnnnnwwnn',
    I: 'nnwnnwwnn',
    J: 'nnnnwwwnn',
    K: 'wnnnnnnww',
    L: 'nnwnnnnww',
    M: 'wnwnnnnwn',
    N: 'nnnnwnnww',
    O: 'wnnnwnnwn',
    P: 'nnwnwnnwn',
    Q: 'nnnnnnwww',
    R: 'wnnnnnwwn',
    S: 'nnwnnnwwn',
    T: 'nnnnwnwwn',
    U: 'wwnnnnnnw',
    V: 'nwwnnnnnw',
    W: 'wwwnnnnnn',
    X: 'nwnnwnnnw',
    Y: 'wwnnwnnnn',
    Z: 'nwwnwnnnn',
    '-': 'nwnnnnwnw',
    '.': 'wwnnnnwnn',
    ' ': 'nwwnnnwnn',
    '*': 'nwnnwnwnn',
    '$': 'nwnwnwnnn',
    '/': 'nwnwnnnwn',
    '+': 'nwnnnwnwn',
    '%': 'nnnwnwnwn',
};

function labelDisplayPrice(product: Product): string {
    return formatMoney(product.price);
}

function labelCanvasFont(design: LabelDesign): string {
    if (design.fontFamily === 'serif') return 'Georgia, "Times New Roman", serif';
    if (design.fontFamily === 'condensed') return '"Arial Narrow", "Helvetica Condensed", Arial, sans-serif';
    return 'Arial, Helvetica, sans-serif';
}

function labelPaddingDots(widthMm: number, dotsPerMm = 8): number {
    const paddingMm = widthMm >= 70 ? 1.5 : widthMm <= 32 ? 0.8 : 1;
    return Math.max(4, Math.round(paddingMm * dotsPerMm));
}

function labelTopPaddingDots(widthMm: number, dotsPerMm = 8): number {
    const paddingMm = widthMm >= 70 ? 0.25 : widthMm <= 32 ? 0 : 0.05;
    return Math.max(0, Math.round(paddingMm * dotsPerMm));
}

function setCanvasFont(ctx: CanvasRenderingContext2D, design: LabelDesign, size: number, weight = 700) {
    ctx.font = `${weight} ${Math.max(8, Math.round(size))}px ${labelCanvasFont(design)}`;
}

function canvasLineHeight(size: number, ratio = 1.12): number {
    return Math.max(10, Math.ceil(size * ratio));
}

type FittedWrappedText = {
    lines: string[];
    fontSize: number;
    lineHeight: number;
};

function labelBarcodeHeightDots(heightMm: number, availableHeight: number, dotsPerMm = 8): number {
    if (availableHeight <= 0) return 0;
    const targetMm = heightMm >= 60 ? 14 : heightMm >= 40 ? 10 : heightMm >= 30 ? 7 : 5.5;
    const minMm = heightMm >= 30 ? 5 : 4;
    const target = Math.round(targetMm * dotsPerMm);
    const minimum = Math.round(minMm * dotsPerMm);
    if (availableHeight < minimum) return 0;
    return Math.min(target, availableHeight);
}

function clipCanvasArea(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number) {
    ctx.beginPath();
    ctx.rect(x, y, Math.max(1, width), Math.max(1, height));
    ctx.clip();
}

function wrapCanvasText(ctx: CanvasRenderingContext2D, value: string, maxWidth: number, maxLines: number): string[] {
    const words = labelText(value, 160).split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    const lines: string[] = [];
    let current = '';
    for (const word of words) {
        const next = current ? `${current} ${word}` : word;
        if (ctx.measureText(next).width <= maxWidth) {
            current = next;
            continue;
        }
        if (current) lines.push(current);
        current = word;
        while (ctx.measureText(current).width > maxWidth && current.length > 1) {
            current = current.slice(0, -1);
        }
        if (lines.length >= maxLines) break;
    }
    if (current && lines.length < maxLines) lines.push(current);
    if (lines.length > 0 && words.join(' ').length > lines.join(' ').length) {
        const lastIndex = lines.length - 1;
        let last = lines[lastIndex];
        while (last.length > 1 && ctx.measureText(`${last}...`).width > maxWidth) {
            last = last.slice(0, -1);
        }
        lines[lastIndex] = `${last}...`;
    }
    return lines;
}

function ellipsizeCanvasText(ctx: CanvasRenderingContext2D, value: string, maxWidth: number): string {
    let text = labelText(value, 160);
    if (ctx.measureText(text).width <= maxWidth) return text;
    while (text.length > 1 && ctx.measureText(`${text}...`).width > maxWidth) {
        text = text.slice(0, -1);
    }
    return `${text}...`;
}

function wrapCanvasTextStrict(ctx: CanvasRenderingContext2D, value: string, maxWidth: number, maxLines: number) {
    const words = labelText(value, 160).split(/\s+/).filter(Boolean);
    if (words.length === 0) return { lines: [], fits: true };
    const lines: string[] = [];
    let current = '';
    for (const word of words) {
        const next = current ? `${current} ${word}` : word;
        if (ctx.measureText(next).width <= maxWidth) {
            current = next;
            continue;
        }
        if (!current || ctx.measureText(word).width > maxWidth) {
            return { lines: [], fits: false };
        }
        lines.push(current);
        current = word;
        if (lines.length >= maxLines) return { lines, fits: false };
    }
    if (current) lines.push(current);
    return { lines, fits: lines.length <= maxLines };
}

function fitWrappedCanvasText(
    ctx: CanvasRenderingContext2D,
    design: LabelDesign,
    value: string,
    maxWidth: number,
    maxLines: number,
    minSize: number,
    maxSize: number,
    weight = 800,
    ratio = 1.06
): FittedWrappedText {
    const minimum = Math.max(8, Math.round(minSize));
    for (let size = Math.max(minimum, Math.round(maxSize)); size >= minimum; size -= 1) {
        setCanvasFont(ctx, design, size, weight);
        const wrapped = wrapCanvasTextStrict(ctx, value, maxWidth, maxLines);
        if (wrapped.fits) {
            return { lines: wrapped.lines, fontSize: size, lineHeight: canvasLineHeight(size, ratio) };
        }
    }
    setCanvasFont(ctx, design, minimum, weight);
    return {
        lines: wrapCanvasText(ctx, value, maxWidth, maxLines),
        fontSize: minimum,
        lineHeight: canvasLineHeight(minimum, ratio),
    };
}

function fitSingleLineCanvasText(
    ctx: CanvasRenderingContext2D,
    design: LabelDesign,
    value: string,
    maxWidth: number,
    minSize: number,
    maxSize: number,
    weight = 800
): number {
    const minimum = Math.max(8, Math.round(minSize));
    for (let size = Math.max(minimum, Math.round(maxSize)); size >= minimum; size -= 1) {
        setCanvasFont(ctx, design, size, weight);
        if (ctx.measureText(value).width <= maxWidth) return size;
    }
    return minimum;
}

function drawCanvasLine(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    align: CanvasTextAlign = 'center'
) {
    ctx.textAlign = align;
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#000';
    ctx.fillText(text, x, y);
}

function code39Safe(value: string): string {
    return value.toUpperCase().replace(/[^0-9A-Z. $/+%-]/g, '').slice(0, 48);
}

function code39Units(value: string): number {
    const encoded = `*${code39Safe(value)}*`;
    let total = 0;
    for (const character of encoded) {
        const pattern = CODE39_PATTERNS[character] || CODE39_PATTERNS['-'];
        for (const width of pattern) total += width === 'w' ? 3 : 1;
        total += 1;
    }
    return Math.max(1, total);
}

function drawCode39Barcode(ctx: CanvasRenderingContext2D, value: string, x: number, y: number, width: number, height: number) {
    const safe = code39Safe(value);
    if (!safe || width <= 0 || height <= 0) return;
    const encoded = `*${safe}*`;
    const narrow = Math.max(1, width / code39Units(value));
    const barcodeWidth = code39Units(value) * narrow;
    let cursor = Math.round(x + Math.max(0, (width - barcodeWidth) / 2));
    const top = Math.round(y);
    const barHeight = Math.max(12, Math.round(height));
    ctx.fillStyle = '#000';
    for (const character of encoded) {
        const pattern = CODE39_PATTERNS[character] || CODE39_PATTERNS['-'];
        for (let index = 0; index < pattern.length; index += 1) {
            const barWidth = (pattern[index] === 'w' ? 3 : 1) * narrow;
            const nextCursor = cursor + barWidth;
            if (index % 2 === 0) {
                const start = Math.round(cursor);
                const end = Math.round(nextCursor);
                ctx.fillRect(start, top, Math.max(1, end - start), barHeight);
            }
            cursor = nextCursor;
        }
        cursor += narrow;
    }
}

function drawLabelBarcode(
    ctx: CanvasRenderingContext2D,
    barcode: string,
    padding: number,
    barcodeTop: number,
    printableWidth: number,
    barcodeHeight: number
) {
    if (barcodeHeight <= 0) return;
    drawCode39Barcode(ctx, barcode, padding, barcodeTop, printableWidth, barcodeHeight);
}

function renderEscposLabelCanvas(payload: ProductLabelPayload, dotsPerMm: number, maxWidthDots = 0): HTMLCanvasElement {
    if (typeof document === 'undefined') {
        throw new Error('Label image printing is only available inside the app window');
    }

    const { product, store, design } = payload;
    const widthMm = labelWidthMm(design);
    const heightMm = labelHeightMm(design);
    let width = mmToDots(widthMm, dotsPerMm);
    const height = mmToDots(heightMm, dotsPerMm);
    if (maxWidthDots > 0 && width > maxWidthDots) width = Math.max(80, maxWidthDots);
    const padding = labelPaddingDots(widthMm, dotsPerMm);
    const topPadding = labelTopPaddingDots(widthMm, dotsPerMm);
    const bottomPadding = Math.max(1, Math.round(0.25 * dotsPerMm));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not prepare label image');
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);

    const printableWidth = Math.max(1, width - padding * 2);
    const centerX = width / 2;
    const smallSize = Math.round(2.3 * dotsPerMm * labelScale(design));
    const nameSize = Math.round((widthMm >= 70 ? 3.8 : 3.3) * dotsPerMm * labelNameScale(design));
    const standardPriceSize = Math.round((widthMm >= 70 ? 6.2 : 4.6) * dotsPerMm * labelPriceScale(design));
    const shelfPriceSize = Math.round(6.8 * dotsPerMm * labelPriceScale(design));
    const footerParts: string[] = [];
    const barcode = labelBarcodeValue(product);
    const hasBarcode = labelShowsBarcode(design) && Boolean(code39Safe(barcode));
    const hasSidePrice = design.template === 'compact' || design.template === 'shelf';
    if (hasBarcode && design.showBarcodeText) footerParts.push(barcode);
    if (design.showSku && product.sku) footerParts.push(`SKU ${product.sku}`);
    if (design.showPlu && product.scalePlu) footerParts.push(`PLU ${product.scalePlu}`);
    const gap = Math.max(1, Math.round(0.2 * dotsPerMm));
    const footerText = footerParts.join('  ');
    const footerSize = footerParts.length > 0
        ? fitSingleLineCanvasText(ctx, design, footerText, printableWidth, 8, smallSize, 700)
        : 0;
    const footerHeight = footerParts.length > 0 ? canvasLineHeight(footerSize, 1.0) : 0;
    const maxBottom = Math.max(topPadding, height - bottomPadding);
    const reservedFooter = footerHeight > 0 ? footerHeight + gap : 0;
    const barcodeHeight = hasBarcode
        ? labelBarcodeHeightDots(heightMm, maxBottom - topPadding - reservedFooter, dotsPerMm)
        : 0;
    const reservedBarcode = barcodeHeight > 0 ? barcodeHeight + gap : 0;
    const textAreaHeight = Math.max(12, maxBottom - topPadding - reservedFooter - reservedBarcode);
    const priceText = labelDisplayPrice(product);
    let y = topPadding;

    ctx.save();
    clipCanvasArea(ctx, padding, topPadding, printableWidth, Math.max(1, maxBottom - topPadding));
    if (hasSidePrice) {
        const rightSafety = Math.max(18, Math.round(3.2 * dotsPerMm));
        const priceFitInset = Math.max(2, Math.round(0.6 * dotsPerMm));
        const priceWidth = design.showPrice ? Math.min(Math.round(printableWidth * 0.38), Math.max(1, Math.round(width * 0.3))) : 0;
        const leftWidth = Math.max(1, printableWidth - priceWidth - (priceWidth ? gap : 0));
        const leftCenterX = padding + leftWidth / 2;
        const priceCenterX = width - padding - rightSafety - priceWidth / 2;
        let leftY = topPadding;
        if (design.showStore && store.name) {
            const storeSize = fitSingleLineCanvasText(ctx, design, store.name.toUpperCase(), leftWidth, 8, smallSize, 800);
            setCanvasFont(ctx, design, storeSize, 800);
            drawCanvasLine(ctx, ellipsizeCanvasText(ctx, store.name.toUpperCase(), leftWidth), leftCenterX, leftY);
            leftY += canvasLineHeight(storeSize, 1.05);
        }
        if (design.showName) {
            const maxLines = heightMm >= 28 ? 2 : 1;
            const nameMaxHeight = Math.max(10, textAreaHeight - (leftY - topPadding));
            const fittedName = fitWrappedCanvasText(
                ctx,
                design,
                product.name,
                leftWidth,
                maxLines,
                9,
                Math.min(Math.round(nameSize * 1.45), Math.floor(nameMaxHeight / Math.max(1, maxLines) / 1.02)),
                800,
                1.05
            );
            setCanvasFont(ctx, design, fittedName.fontSize, 800);
            for (const lineTextValue of fittedName.lines) {
                if (leftY + fittedName.lineHeight > topPadding + textAreaHeight + 2) break;
                drawCanvasLine(ctx, lineTextValue, leftCenterX, leftY);
                leftY += fittedName.lineHeight;
            }
        }
        if (design.showPrice && priceWidth > 0) {
            const basePriceSize = design.template === 'shelf' ? shelfPriceSize : standardPriceSize;
            const priceSize = fitSingleLineCanvasText(
                ctx,
                design,
                priceText,
                Math.max(1, priceWidth - priceFitInset),
                12,
                Math.min(Math.round(basePriceSize * 1.1), Math.floor(textAreaHeight / 1.02)),
                900
            );
            setCanvasFont(ctx, design, priceSize, 900);
            drawCanvasLine(ctx, priceText, priceCenterX, topPadding);
        }
        y = Math.max(leftY, topPadding + Math.min(textAreaHeight, canvasLineHeight(design.showPrice ? standardPriceSize : smallSize, 1.0)));
    } else {
        if (design.showStore && store.name) {
            const storeSize = fitSingleLineCanvasText(ctx, design, store.name.toUpperCase(), printableWidth, 8, smallSize, 800);
            setCanvasFont(ctx, design, storeSize, 800);
            drawCanvasLine(ctx, ellipsizeCanvasText(ctx, store.name.toUpperCase(), printableWidth), centerX, y);
            y += canvasLineHeight(storeSize, 1.05);
        }
        const priceBaseSize = design.template === 'barcode'
            ? Math.round(3.2 * dotsPerMm * labelPriceScale(design))
            : standardPriceSize;
        const priceReserve = design.showPrice ? canvasLineHeight(Math.min(priceBaseSize, Math.round(textAreaHeight * 0.45)), 1.0) : 0;
        if (design.showName) {
            const maxLines = heightMm >= 28 ? 2 : 1;
            const nameMaxHeight = Math.max(10, textAreaHeight - (y - topPadding) - priceReserve - (design.showPrice ? gap : 0));
            const fittedName = fitWrappedCanvasText(
                ctx,
                design,
                product.name,
                printableWidth,
                maxLines,
                9,
                Math.min(Math.round(nameSize * 1.45), Math.floor(nameMaxHeight / Math.max(1, maxLines) / 1.02)),
                800,
                1.05
            );
            setCanvasFont(ctx, design, fittedName.fontSize, 800);
            for (const lineTextValue of fittedName.lines) {
                if (y + fittedName.lineHeight > topPadding + textAreaHeight + 2) break;
                drawCanvasLine(ctx, lineTextValue, centerX, y);
                y += fittedName.lineHeight;
            }
        }
        if (design.showPrice && y < topPadding + textAreaHeight) {
            const priceSize = fitSingleLineCanvasText(
                ctx,
                design,
                priceText,
                Math.max(1, printableWidth - 4),
                12,
                Math.min(Math.round(priceBaseSize * 1.08), Math.floor((topPadding + textAreaHeight - y) / 1.02)),
                900
            );
            setCanvasFont(ctx, design, priceSize, 900);
            drawCanvasLine(ctx, priceText, centerX, y);
            y += canvasLineHeight(priceSize, 1.0);
        }
    }
    ctx.restore();

    if (hasBarcode && barcodeHeight > 0) {
        const latestBarcodeTop = Math.max(topPadding, maxBottom - reservedFooter - barcodeHeight);
        const barcodeTop = Math.min(Math.max(y + gap, topPadding), latestBarcodeTop);
        drawLabelBarcode(ctx, barcode, padding, barcodeTop, printableWidth, barcodeHeight);
        y = barcodeTop + barcodeHeight;
    }

    if (footerParts.length > 0) {
        const footerY = Math.min(Math.max(y + gap, topPadding), maxBottom - footerHeight);
        setCanvasFont(ctx, design, footerSize, 700);
        drawCanvasLine(ctx, footerText, centerX, footerY);
    }

    return canvas;
}

function canvasToMonoRaster(canvas: HTMLCanvasElement): { bytesPerRow: number; height: number; data: number[] } {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not read label image');
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    const bytesPerRow = Math.ceil(width / 8);
    const raster: number[] = [];
    for (let y = 0; y < height; y += 1) {
        for (let byteIndex = 0; byteIndex < bytesPerRow; byteIndex += 1) {
            let byte = 0;
            for (let bit = 0; bit < 8; bit += 1) {
                const x = byteIndex * 8 + bit;
                if (x >= width) continue;
                const offset = (y * width + x) * 4;
                const red = data[offset];
                const green = data[offset + 1];
                const blue = data[offset + 2];
                const alpha = data[offset + 3];
                const luminance = (red * 0.299 + green * 0.587 + blue * 0.114) * (alpha / 255) + 255 * (1 - alpha / 255);
                if (luminance < 180) byte |= 0x80 >> bit;
            }
            raster.push(byte);
        }
    }
    return { bytesPerRow, height, data: raster };
}

function canvasToEscposRaster(canvas: HTMLCanvasElement): number[] {
    const raster = canvasToMonoRaster(canvas);
    const { bytesPerRow, height, data } = raster;
    // Split into horizontal bands so a tall label fits the printer's small raster
    // buffer. Each GS v 0 command prints contiguously below the previous one, so a
    // single big bitmap that would otherwise be truncated mid-label prints in full.
    const maxBandBytes = 4000;
    const bandHeight = Math.max(1, Math.min(height, Math.floor(maxBandBytes / Math.max(1, bytesPerRow)) || 1));
    const bytes: number[] = [];
    for (let top = 0; top < height; top += bandHeight) {
        const rows = Math.min(bandHeight, height - top);
        const start = top * bytesPerRow;
        const end = start + rows * bytesPerRow;
        bytes.push(
            0x1d, 0x76, 0x30, 0x00,
            bytesPerRow & 0xff,
            (bytesPerRow >> 8) & 0xff,
            rows & 0xff,
            (rows >> 8) & 0xff,
            ...data.slice(start, end),
        );
    }
    return bytes;
}

function bytesToHex(bytes: number[]): string {
    return bytes.map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join('');
}

function buildEscposRasterProductLabels(
    payload: ProductLabelPayload,
    cutPaper: boolean,
    gapLines: number,
    dotsPerMm: number,
    maxWidthDots: number
): number[] {
    const canvas = renderEscposLabelCanvas(payload, dotsPerMm, maxWidthDots);
    const image = canvasToEscposRaster(canvas);
    const bytes: number[] = [
        0x1b, 0x40,
        0x1d, 0x4c, 0x00, 0x00,
        0x1b, 0x24, 0x00, 0x00,
        0x1b, 0x61, 0x00,
    ];
    const copies = labelCopies(payload.quantity);
    for (let copy = 0; copy < copies; copy += 1) {
        bytes.push(...image);
        if (copy < copies - 1) bytes.push(...feedLines(gapLines));
    }
    bytes.push(0x1b, 0x61, 0x00, ...escposCut(cutPaper));
    return bytes;
}

function buildZplRasterProductLabel(payload: ProductLabelPayload, dotsPerMm: number, cutPaper = false): number[] {
    const canvas = renderEscposLabelCanvas(payload, dotsPerMm);
    const raster = canvasToMonoRaster(canvas);
    const totalBytes = raster.data.length;
    const lines = [
        '^XA',
        `^PW${canvas.width}`,
        `^LL${canvas.height}`,
        '^LH0,0',
        '^LT0',
        ...(cutPaper ? ['^MMC'] : []),
        `^FO0,0^GFA,${totalBytes},${totalBytes},${raster.bytesPerRow},${bytesToHex(raster.data)}^FS`,
        `^PQ${labelCopies(payload.quantity)},0,1,N`,
        '^XZ',
        '',
    ];
    return Array.from(new TextEncoder().encode(lines.join('\n')));
}

function buildTsplRasterProductLabel(payload: ProductLabelPayload, gapLines: number, dotsPerMm: number, cutPaper = false): number[] {
    const canvas = renderEscposLabelCanvas(payload, dotsPerMm);
    const raster = canvasToMonoRaster(canvas);
    const widthMm = labelWidthMm(payload.design);
    const heightMm = labelHeightMm(payload.design);
    const prefix = [
        `SIZE ${widthMm} mm,${heightMm} mm`,
        `GAP ${Math.max(0, Math.min(12, gapLines))} mm,0`,
        'DIRECTION 1',
        'REFERENCE 0,0',
        'OFFSET 0 mm',
        ...(cutPaper ? ['SET CUTTER ON'] : []),
        'CLS',
        `BITMAP 0,0,${raster.bytesPerRow},${raster.height},0,`,
    ].join('\r\n');
    const suffix = `\r\nPRINT ${labelCopies(payload.quantity)}\r\n`;
    return [
        ...Array.from(new TextEncoder().encode(prefix)),
        ...raster.data,
        ...Array.from(new TextEncoder().encode(suffix)),
    ];
}

function buildRasterProductLabel(payload: ProductLabelPayload, config: LabelPrinterConfig): number[] {
    const dotsPerMm = labelDotsPerMm(config.dpi);
    if (config.protocol === 'zpl') return buildZplRasterProductLabel(payload, dotsPerMm, config.cutPaper);
    if (config.protocol === 'tspl') return buildTsplRasterProductLabel(payload, config.gapLines, dotsPerMm, config.cutPaper);
    return buildEscposRasterProductLabels(
        payload,
        config.cutPaper,
        config.gapLines,
        dotsPerMm,
        escposPrintableWidthDots(config.paperWidth, dotsPerMm)
    );
}

function buildEscposProductLabels(payload: ProductLabelPayload, cutPaper: boolean, gapLines: number): number[] {
    const { product, store, design } = payload;
    const centerOn = [0x1b, 0x61, 0x01];
    const leftOn = [0x1b, 0x61, 0x00];
    const boldOn = [0x1b, 0x45, 0x01];
    const boldOff = [0x1b, 0x45, 0x00];
    const normalSize = [0x1d, 0x21, 0x00];
    const barcode = labelBarcodeValue(product);
    const hasBarcode = labelShowsBarcode(design);
    const widthMm = labelWidthMm(design);
    const heightMm = labelHeightMm(design);
    const columns = labelTextColumns(design);
    const nameColumns = labelTextColumns(design, 'name');
    const nameLines = widthMm >= 70 && heightMm >= 45 ? 2 : 1;
    const barcodeHeight = heightMm >= 60 ? 92 : heightMm >= 40 ? 76 : 58;
    const barcodeModuleWidth = widthMm >= 76 && barcode.length <= 18 ? 3 : 2;
    const bytes: number[] = [];
    for (let copy = 0; copy < labelCopies(payload.quantity); copy += 1) {
        bytes.push(0x1b, 0x40, ...centerOn, ...escposFontSelect(design), ...escposTextSize(design, 'normal'));
        if (design.showStore && store.name) bytes.push(...boldOn, ...line(labelText(store.name, columns), 'latin1'), ...boldOff);
        if (design.showName) {
            bytes.push(...escposTextSize(design, 'name'));
            const wrappedName = wrapLabelText(product.name, nameColumns, nameLines);
            for (const nameLine of wrappedName) bytes.push(...line(nameLine, 'latin1'));
            bytes.push(...normalSize, ...escposTextSize(design, 'normal'));
        }
        if (design.showPrice) bytes.push(...escposTextSize(design, 'price'), ...boldOn, ...line(labelText(labelPrice(product), columns), 'latin1'), ...boldOff, ...normalSize, ...escposTextSize(design, 'normal'));
        if (hasBarcode && barcode) {
            bytes.push(
                ...escposCode39(barcode, {
                    height: barcodeHeight,
                    moduleWidth: barcodeModuleWidth,
                    showText: design.showBarcodeText,
                }),
                ...line('', 'latin1')
            );
        }
        const footer: string[] = [];
        if (design.showSku && product.sku) footer.push(`SKU ${product.sku}`);
        if (design.showPlu && product.scalePlu) footer.push(`PLU ${product.scalePlu}`);
        if (footer.length > 0) bytes.push(...line(labelText(footer.join('  '), columns), 'latin1'));
        bytes.push(...leftOn, ...feedLines(gapLines));
    }
    bytes.push(...escposCut(cutPaper));
    return bytes;
}

export function buildProductLabel(payload: ProductLabelPayload, config = getLabelPrinterConfig()): number[] {
    const dotsPerMm = labelDotsPerMm(config.dpi);
    if (config.protocol === 'tspl') return buildTsplProductLabel(payload, config.gapLines, dotsPerMm, config.cutPaper);
    if (config.protocol === 'zpl') return buildZplProductLabel(payload, dotsPerMm, config.cutPaper);
    return buildEscposProductLabels(payload, config.cutPaper, config.gapLines);
}

async function sendProductLabelsJob(payload: ProductLabelPayload, config: LabelPrinterConfig): Promise<void> {
    const data = typeof document !== 'undefined'
        ? buildRasterProductLabel(payload, config)
        : buildProductLabel(payload, config);
    await sendDirectPrinterData({
        connection: config.connection,
        host: config.host,
        port: config.port,
        printerName: config.printerName,
        devicePath: config.devicePath,
        data,
        documentName: `Label ${labelText(payload.product.name, 24)}`.trim(),
    });
}

export async function printProductLabels(payload: ProductLabelPayload, config = getLabelPrinterConfig()): Promise<void> {
    if (!config.enabled) throw new Error('Label printer is disabled');
    if (!isDirectConnection(config.connection)) throw new Error('Choose USB raw, Network, Serial, or Bluetooth for thermal label printing');
    if (config.protocol === 'system') throw new Error('Choose ESC/POS, TSPL, or ZPL for direct label printing');
    const copies = labelCopies(payload.quantity);
    if (config.cutPaper && copies > 1) {
        for (let copy = 0; copy < copies; copy += 1) {
            await sendProductLabelsJob({ ...payload, quantity: 1 }, config);
        }
        return;
    }
    await sendProductLabelsJob({ ...payload, quantity: copies }, config);
}

function labelTestPayload(): ProductLabelPayload {
    return {
        product: {
            id: 'LABELTEST123',
            categoryId: '',
            taxRateId: '',
            name: 'Label printer test',
            sku: 'TEST-SKU',
            barcode: '123456789012',
            scalePlu: '',
            price: 100,
            costPrice: 0,
            stockLevel: 0,
            trackStock: false,
            isWeighable: false,
            showInGoods: false,
            goodsSortOrder: 0,
            color: '#ffffff',
            image: '',
            isActive: true,
            createdAt: '',
            updatedAt: '',
        },
        store: {
            id: 'store',
            name: 'L&Bj POS',
            address: '',
            phone: '',
            email: '',
            currency: 'GBP',
            taxIncludedInPrice: true,
            receiptHeader: '',
            receiptFooter: '',
            createdAt: '',
        },
        design: {
            ...defaultLabelDesign,
            widthMm: 50,
            heightMm: 30,
            showBarcode: true,
            showBarcodeText: true,
        },
        quantity: 1,
    };
}

export function buildLabelTest(config = getLabelPrinterConfig()): number[] {
    if (config.protocol === 'escpos') {
        return [
            0x1b, 0x40,
            0x1b, 0x61, 0x01,
            0x1b, 0x45, 0x01,
            ...line('L&Bj POS', 'latin1'),
            0x1b, 0x45, 0x00,
            ...line('Label printer test', 'latin1'),
            0x1d, 0x21, 0x11,
            ...line('GBP 1.00', 'latin1'),
            0x1d, 0x21, 0x00,
            ...escposCode39('123456789012'),
            ...line('123456789012', 'latin1'),
            ...feedLines(config.gapLines),
            ...escposCut(config.cutPaper),
        ];
    }
    const protocol = config.protocol === 'tspl' ? 'tspl' : 'zpl';
    const body = protocol === 'tspl'
        ? [
            'SIZE 50 mm,30 mm',
            `GAP ${Math.max(0, Math.min(12, config.gapLines))} mm,0`,
            'DIRECTION 1',
            'REFERENCE 0,0',
            'OFFSET 0 mm',
            'CLS',
            'TEXT 20,20,"3",0,1,1,"L&Bj POS"',
            'TEXT 20,55,"2",0,1,1,"Label printer test"',
            'BARCODE 20,95,"128",80,1,0,2,2,"123456789012"',
            'PRINT 1',
            '',
        ].join('\r\n')
        : [
            '^XA',
            '^LH0,0',
            '^LT0',
            '^CF0,35',
            '^FO40,35^FDL&Bj POS^FS',
            '^CF0,25',
            '^FO40,85^FDLabel printer test^FS',
            '^BY2,2,70',
            '^FO40,130^BCN,70,Y,N,N^FD123456789012^FS',
            '^XZ',
            '',
        ].join('\n');
    return Array.from(new TextEncoder().encode(body));
}

export async function sendLabelPrinterTest(config = getLabelPrinterConfig()): Promise<void> {
    if (!config.enabled) throw new Error('Label printer is disabled');
    if (!isDirectConnection(config.connection)) throw new Error('Choose Network, USB raw, Serial, or Bluetooth for direct label test printing');
    if (config.protocol === 'system') throw new Error('Choose ESC/POS, ZPL, or TSPL for direct label test printing');
    const data = typeof document !== 'undefined'
        ? buildRasterProductLabel(labelTestPayload(), config)
        : buildLabelTest(config);
    await sendDirectPrinterData({
        connection: config.connection,
        host: config.host,
        port: config.port,
        printerName: config.printerName,
        devicePath: config.devicePath,
        data,
        documentName: 'L&Bj POS label test',
    });
}
