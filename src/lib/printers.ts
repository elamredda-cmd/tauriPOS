import { invoke } from '@tauri-apps/api/core';
import { get } from 'svelte/store';
import { settingsDB, type Order, type OrderLine, type Setting, type Store } from '$lib/stores/db';
import type { ReceiptDesign } from '$lib/receipt';
import { getScaleSaleDisplay } from '$lib/scaleSale';

export type PrinterConnectionType = 'system' | 'network_escpos' | 'usb_raw' | 'serial' | 'bluetooth';
export type ReceiptPaperWidth = '58mm' | '80mm';
export type LabelPrinterProtocol = 'system' | 'zpl' | 'tspl';

export interface ReceiptPrinterConfig {
    enabled: boolean;
    connection: PrinterConnectionType;
    host: string;
    port: number;
    printerName: string;
    devicePath: string;
    baudRate: number;
    paperWidth: ReceiptPaperWidth;
    autoPrintAfterPayment: boolean;
    cutPaper: boolean;
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

const DIRECT_CONNECTIONS = new Set<PrinterConnectionType>(['network_escpos', 'usb_raw', 'serial', 'bluetooth']);
const ALL_CONNECTIONS = new Set<PrinterConnectionType>(['system', 'network_escpos', 'usb_raw', 'serial', 'bluetooth']);

function normalizePrinterConnection(value: string, fallback: PrinterConnectionType): PrinterConnectionType {
    if (ALL_CONNECTIONS.has(value as PrinterConnectionType)) return value as PrinterConnectionType;
    if (value === 'network' || value === 'tcp' || value === 'ethernet') return 'network_escpos';
    if (value === 'usb' || value === 'windows' || value === 'windows_raw') return 'usb_raw';
    if (value === 'com') return 'serial';
    return fallback;
}

export function getReceiptPrinterConfig(settings: Setting[] = get(settingsDB)): ReceiptPrinterConfig {
    const host = setting(settings, 'receipt_printer_host');
    const connection = normalizePrinterConnection(
        setting(settings, 'receipt_printer_connection', host.trim() ? 'network_escpos' : 'system'),
        host.trim() ? 'network_escpos' : 'system'
    );
    return {
        enabled: boolSetting(settings, 'receipt_printer_enabled', true),
        connection,
        host,
        port: portSetting(settings, 'receipt_printer_port', 9100),
        printerName: setting(settings, 'receipt_printer_name'),
        devicePath: setting(settings, 'receipt_printer_device_path'),
        baudRate: portSetting(settings, 'receipt_printer_baud_rate', 9600),
        paperWidth: setting(settings, 'receipt_printer_paper_width', '80mm') === '58mm' ? '58mm' : '80mm',
        autoPrintAfterPayment: boolSetting(settings, 'receipt_printer_auto_print_after_payment', false),
        cutPaper: boolSetting(settings, 'receipt_printer_cut_paper', true),
        openDrawerAfterPayment: boolSetting(
            settings,
            'receipt_printer_open_drawer_after_payment',
            boolSetting(settings, 'receipt_printer_open_drawer_after_cash', false)
        ),
        encoding: setting(settings, 'receipt_printer_encoding', 'latin1') === 'utf8' ? 'utf8' : 'latin1',
    };
}

export function getLabelPrinterConfig(settings: Setting[] = get(settingsDB)): LabelPrinterConfig {
    const host = setting(settings, 'label_printer_host');
    const connection = normalizePrinterConnection(setting(settings, 'label_printer_connection', 'system'), 'system');
    const protocolRaw = setting(settings, 'label_printer_protocol', 'system');
    const directProtocol = protocolRaw === 'zpl' || protocolRaw === 'tspl' ? protocolRaw : 'zpl';
    return {
        enabled: boolSetting(settings, 'label_printer_enabled', true),
        connection,
        protocol: DIRECT_CONNECTIONS.has(connection) ? directProtocol : 'system',
        host,
        port: portSetting(settings, 'label_printer_port', 9100),
        printerName: setting(settings, 'label_printer_name'),
        devicePath: setting(settings, 'label_printer_device_path'),
        baudRate: portSetting(settings, 'label_printer_baud_rate', 9600),
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

export function buildEscposTestReceipt(config = getReceiptPrinterConfig()): number[] {
    const width = config.paperWidth === '58mm' ? 32 : 42;
    const divider = '-'.repeat(width);
    const centerOn = [0x1b, 0x61, 0x01];
    const leftOn = [0x1b, 0x61, 0x00];
    const boldOn = [0x1b, 0x45, 0x01];
    const boldOff = [0x1b, 0x45, 0x00];
    const bytes = [
        0x1b, 0x40,
        ...centerOn,
        ...boldOn,
        ...line('L&Bj POS', config.encoding),
        ...boldOff,
        ...line('Printer setup test', config.encoding),
        ...line(new Date().toLocaleString('en-GB'), config.encoding),
        ...leftOn,
        ...line(divider, config.encoding),
        ...line('Connection: ESC/POS network', config.encoding),
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
    if (config.cutPaper) bytes.push(0x1d, 0x56, 0x00);
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

export function buildEscposReceipt(payload: {
    store: Store;
    order: Order;
    lines: OrderLine[];
    cashierName: string;
    tillName: string;
    design: ReceiptDesign;
}, config = getReceiptPrinterConfig()): number[] {
    const width = config.paperWidth === '58mm' ? 32 : 42;
    const divider = '-'.repeat(width);
    const centerOn = [0x1b, 0x61, 0x01];
    const leftOn = [0x1b, 0x61, 0x00];
    const boldOn = [0x1b, 0x45, 0x01];
    const boldOff = [0x1b, 0x45, 0x00];
    const bytes = [
        0x1b, 0x40,
        ...centerOn,
        ...boldOn,
        ...line(payload.design.headerText || payload.store.name || 'L&Bj POS', config.encoding),
        ...boldOff,
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
    if (payload.design.showTax) bytes.push(...line(textRow('Tax', money(payload.order.taxTotal), width), config.encoding));
    bytes.push(...boldOn, ...line(textRow('TOTAL', money(payload.order.total), width), config.encoding), ...boldOff);
    if (payload.design.showPayment) {
        bytes.push(...line(textRow((payload.order.paymentMethod || 'cash').toUpperCase(), money(payload.order.amountTendered || payload.order.total), width), config.encoding));
        if ((payload.order.amountTendered || 0) > payload.order.total) {
            bytes.push(...line(textRow('Change', money((payload.order.amountTendered || 0) - payload.order.total), width), config.encoding));
        }
    }

    bytes.push(...line(divider, config.encoding), ...centerOn);
    bytes.push(...line(payload.design.footerText || payload.store.receiptFooter || 'Thank you', config.encoding));
    bytes.push(...line('', config.encoding), ...line('', config.encoding));
    if (config.cutPaper) bytes.push(0x1d, 0x56, 0x00);
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

export async function sendEscposReceipt(payload: Parameters<typeof buildEscposReceipt>[0], config = getReceiptPrinterConfig()): Promise<void> {
    if (!config.enabled) throw new Error('Receipt printer is disabled');
    if (!config.autoPrintAfterPayment) return;
    if (!isDirectConnection(config.connection)) throw new Error('Automatic silent printing needs Network, USB raw, Serial, or Bluetooth direct mode');
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

export function buildLabelTest(config = getLabelPrinterConfig()): number[] {
    const protocol = config.protocol === 'tspl' ? 'tspl' : 'zpl';
    const body = protocol === 'tspl'
        ? [
            'SIZE 50 mm,30 mm',
            'GAP 2 mm,0',
            'CLS',
            'TEXT 20,20,"3",0,1,1,"L&Bj POS"',
            'TEXT 20,55,"2",0,1,1,"Label printer test"',
            'BARCODE 20,95,"128",80,1,0,2,2,"123456789012"',
            'PRINT 1',
            '',
        ].join('\r\n')
        : [
            '^XA',
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
    if (config.protocol === 'system') throw new Error('Choose ZPL or TSPL for direct label test printing');
    await sendDirectPrinterData({
        connection: config.connection,
        host: config.host,
        port: config.port,
        printerName: config.printerName,
        devicePath: config.devicePath,
        data: buildLabelTest(config),
        documentName: 'L&Bj POS label test',
    });
}
