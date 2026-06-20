import { invoke } from '@tauri-apps/api/core';
import { get } from 'svelte/store';
import { settingsDB, type Order, type OrderLine, type Product, type Setting, type Store } from '$lib/stores/db';
import type { ReceiptDesign } from '$lib/receipt';
import type { LabelDesign } from '$lib/labels';
import { getScaleSaleDisplay } from '$lib/scaleSale';

export type PrinterConnectionType = 'system' | 'network_escpos' | 'usb_raw' | 'serial' | 'bluetooth';
export type ReceiptPaperWidth = '58mm' | '80mm';
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
}

function setting(settings: Setting[], key: string, fallback = ''): string {
    return settings.find((item) => item.key === key)?.value || fallback;
}

function hasSetting(settings: Setting[], key: string): boolean {
    return settings.some((item) => item.key === key);
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
    const hasOwnConnection = hasSetting(settings, 'label_printer_connection');
    const labelHost = setting(settings, 'label_printer_host');
    const labelPrinterName = setting(settings, 'label_printer_name');
    const labelDevicePath = setting(settings, 'label_printer_device_path');
    const configuredConnection = setting(settings, 'label_printer_connection', '');
    const shouldInheritReceipt = isDirectConnection(receipt.connection)
        && (!hasOwnConnection || (configuredConnection === 'system' && !labelHost.trim() && !labelPrinterName.trim() && !labelDevicePath.trim()));
    const fallbackConnection = shouldInheritReceipt
        ? receipt.connection
        : labelHost.trim()
            ? 'network_escpos'
            : labelPrinterName.trim()
                ? 'usb_raw'
                : labelDevicePath.trim()
                    ? 'serial'
                    : 'system';
    const connection = normalizePrinterConnection(
        shouldInheritReceipt ? fallbackConnection : setting(settings, 'label_printer_connection', fallbackConnection),
        fallbackConnection
    );
    const canInheritReceiptDetails = isDirectConnection(receipt.connection) && connection === receipt.connection;
    const protocolRaw = setting(settings, 'label_printer_protocol', canInheritReceiptDetails ? 'escpos' : 'system');
    const directProtocol = protocolRaw === 'escpos' || protocolRaw === 'zpl' || protocolRaw === 'tspl'
        ? protocolRaw
        : canInheritReceiptDetails
            ? 'escpos'
            : 'zpl';
    return {
        enabled: boolSetting(settings, 'label_printer_enabled', true),
        connection,
        protocol: DIRECT_CONNECTIONS.has(connection) ? directProtocol : 'system',
        host: labelHost || (canInheritReceiptDetails ? receipt.host : ''),
        port: portSetting(settings, 'label_printer_port', receipt.port || 9100),
        printerName: labelPrinterName || (canInheritReceiptDetails ? receipt.printerName : ''),
        devicePath: labelDevicePath || (canInheritReceiptDetails ? receipt.devicePath : ''),
        baudRate: portSetting(settings, 'label_printer_baud_rate', receipt.baudRate || 9600),
        cutPaper: boolSetting(settings, 'label_printer_cut_paper', true),
        gapLines: intSetting(settings, 'label_printer_gap_lines', 1, 0, 12),
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
    return config.cutPaper ? [...feedLines(config.cutFeedLines), 0x1d, 0x56, 0x00] : [];
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
    const receiptFontSelect = [0x1b, 0x4d, payload.design.fontFamily === 'condensed' ? 0x01 : 0x00];
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
    bytes.push(...boldOn, ...line(textRow('TOTAL', money(payload.order.total), width), config.encoding), ...boldOff);
    if (payload.design.showPayment) {
        bytes.push(...line(textRow((payload.order.paymentMethod || 'cash').toUpperCase(), money(payload.order.amountTendered || payload.order.total), width), config.encoding));
        if ((payload.order.amountTendered || 0) > payload.order.total) {
            bytes.push(...line(textRow('Change', money((payload.order.amountTendered || 0) - payload.order.total), width), config.encoding));
        }
    }

    bytes.push(...line(divider, config.encoding), ...centerOn);
    bytes.push(...line(payload.design.footerText || payload.store.receiptFooter || 'Thank you', config.encoding));
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

function labelPrice(product: Product): string {
    return `GBP ${money(product.price)}`;
}

function labelScale(design: LabelDesign): number {
    return design.textScale === 'small' ? 0.86 : design.textScale === 'large' ? 1.18 : 1;
}

function zplFont(size: number, design: LabelDesign): string {
    const scaled = Math.max(12, Math.round(size * labelScale(design)));
    return `^A0N,${scaled},${Math.max(10, Math.round(scaled * 0.86))}`;
}

function tsplScale(design: LabelDesign): number {
    return design.textScale === 'large' ? 2 : 1;
}

function escposFontSelect(design: LabelDesign): number[] {
    return [0x1b, 0x4d, design.fontFamily === 'condensed' ? 0x01 : 0x00];
}

function escposTextSize(design: LabelDesign, kind: 'normal' | 'price'): number[] {
    if (kind === 'price') {
        return [0x1d, 0x21, design.textScale === 'small' ? 0x10 : design.textScale === 'large' ? 0x22 : 0x11];
    }
    return [0x1d, 0x21, design.textScale === 'large' ? 0x01 : 0x00];
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

function mmToDots(mm: number): number {
    return Math.max(80, Math.round(Number(mm || 1) * 8));
}

function buildZplProductLabel(payload: ProductLabelPayload): number[] {
    const { product, store, design } = payload;
    const width = mmToDots(design.widthMm);
    const height = mmToDots(design.heightMm);
    const margin = Math.max(12, Math.round(width * 0.05));
    let y = 10;
    const lines = ['^XA', '^CI28', `^PW${width}`, `^LL${height}`, '^LH0,0'];
    if (design.showStore && store.name) {
        lines.push(`^FO${margin},${y}${zplFont(18, design)}^FB${width - margin * 2},1,0,C^FD${zplEscape(store.name)}^FS`);
        y += Math.round(24 * labelScale(design));
    }
    if (design.showName) {
        lines.push(`^FO${margin},${y}${zplFont(28, design)}^FB${width - margin * 2},2,2,C^FD${zplEscape(product.name)}^FS`);
        y += Math.round((design.heightMm >= 40 ? 58 : 42) * labelScale(design));
    }
    if (design.showPrice) {
        lines.push(`^FO${margin},${y}${zplFont(44, design)}^FB${width - margin * 2},1,0,C^FD${zplEscape(labelPrice(product))}^FS`);
        y += Math.round(48 * labelScale(design));
    }
    const barcode = labelBarcodeValue(product);
    const barcodeHeight = Math.max(35, Math.min(90, height - y - 32));
    if (barcode && barcodeHeight >= 28) {
        lines.push(`^BY2,2,${barcodeHeight}`);
        lines.push(`^FO${margin},${Math.max(y, height - barcodeHeight - 34)}^BCN,${barcodeHeight},${design.showBarcodeText ? 'Y' : 'N'},N,N^FD${zplEscape(barcode)}^FS`);
    }
    const footer: string[] = [];
    if (design.showSku && product.sku) footer.push(`SKU ${product.sku}`);
    if (design.showPlu && product.scalePlu) footer.push(`PLU ${product.scalePlu}`);
    if (footer.length > 0) {
        lines.push(`^FO${margin},${height - 24}${zplFont(18, design)}^FB${width - margin * 2},1,0,C^FD${zplEscape(footer.join('  '))}^FS`);
    }
    lines.push(`^PQ${labelCopies(payload.quantity)},0,1,N`, '^XZ', '');
    return Array.from(new TextEncoder().encode(lines.join('\n')));
}

function buildTsplProductLabel(payload: ProductLabelPayload, gapLines: number): number[] {
    const { product, store, design } = payload;
    const width = mmToDots(design.widthMm);
    const height = mmToDots(design.heightMm);
    const margin = Math.max(12, Math.round(width * 0.05));
    const scale = tsplScale(design);
    let y = 10;
    const lines = [
        `SIZE ${Math.max(15, Number(design.widthMm) || 50)} mm,${Math.max(15, Number(design.heightMm) || 30)} mm`,
        `GAP ${Math.max(0, Math.min(12, gapLines))} mm,0`,
        'DIRECTION 1',
        'CLS',
    ];
    if (design.showStore && store.name) {
        lines.push(`TEXT ${margin},${y},"2",0,${scale},${scale},"${tsplEscape(store.name)}"`);
        y += 26 * scale;
    }
    if (design.showName) {
        lines.push(`TEXT ${margin},${y},"3",0,${scale},${scale},"${tsplEscape(product.name)}"`);
        y += (design.heightMm >= 40 ? 46 : 34) * scale;
    }
    if (design.showPrice) {
        lines.push(`TEXT ${margin},${y},"4",0,${scale},${scale},"${tsplEscape(labelPrice(product))}"`);
        y += 50 * scale;
    }
    const barcode = labelBarcodeValue(product);
    const barcodeHeight = Math.max(35, Math.min(90, height - y - 24));
    if (barcode && barcodeHeight >= 28) {
        lines.push(`BARCODE ${margin},${Math.max(y, height - barcodeHeight - 28)},"128",${barcodeHeight},${design.showBarcodeText ? 1 : 0},0,2,2,"${tsplEscape(barcode)}"`);
    }
    const footer: string[] = [];
    if (design.showSku && product.sku) footer.push(`SKU ${product.sku}`);
    if (design.showPlu && product.scalePlu) footer.push(`PLU ${product.scalePlu}`);
    if (footer.length > 0) lines.push(`TEXT ${margin},${height - 24},"1",0,${scale},${scale},"${tsplEscape(footer.join('  '))}"`);
    lines.push(`PRINT ${labelCopies(payload.quantity)}`, '');
    return Array.from(new TextEncoder().encode(lines.join('\r\n')));
}

function escposCode39(value: string): number[] {
    const safe = value.toUpperCase().replace(/[^0-9A-Z $%+\-.\/:]/g, '').slice(0, 48);
    if (!safe) return [];
    return [
        0x1d, 0x48, 0x02,
        0x1d, 0x68, 0x45,
        0x1d, 0x77, 0x02,
        0x1d, 0x6b, 0x45,
        safe.length,
        ...encodeText(safe, 'latin1'),
    ];
}

function buildEscposProductLabels(payload: ProductLabelPayload, cutPaper: boolean, gapLines: number): number[] {
    const { product, store, design } = payload;
    const centerOn = [0x1b, 0x61, 0x01];
    const leftOn = [0x1b, 0x61, 0x00];
    const boldOn = [0x1b, 0x45, 0x01];
    const boldOff = [0x1b, 0x45, 0x00];
    const normalSize = [0x1d, 0x21, 0x00];
    const barcode = labelBarcodeValue(product);
    const bytes: number[] = [];
    for (let copy = 0; copy < labelCopies(payload.quantity); copy += 1) {
        bytes.push(0x1b, 0x40, ...centerOn, ...escposFontSelect(design), ...escposTextSize(design, 'normal'));
        if (design.showStore && store.name) bytes.push(...boldOn, ...line(labelText(store.name, 32), 'latin1'), ...boldOff);
        if (design.showName) bytes.push(...line(labelText(product.name, 32), 'latin1'));
        if (design.showPrice) bytes.push(...escposTextSize(design, 'price'), ...boldOn, ...line(labelPrice(product), 'latin1'), ...boldOff, ...normalSize, ...escposTextSize(design, 'normal'));
        if (barcode) bytes.push(...escposCode39(barcode), ...line('', 'latin1'));
        if (design.showBarcodeText && barcode) bytes.push(...line(barcode, 'latin1'));
        const footer: string[] = [];
        if (design.showSku && product.sku) footer.push(`SKU ${product.sku}`);
        if (design.showPlu && product.scalePlu) footer.push(`PLU ${product.scalePlu}`);
        if (footer.length > 0) bytes.push(...line(labelText(footer.join('  '), 32), 'latin1'));
        bytes.push(...leftOn, ...feedLines(gapLines));
    }
    bytes.push(...escposCut(cutPaper));
    return bytes;
}

export function buildProductLabel(payload: ProductLabelPayload, config = getLabelPrinterConfig()): number[] {
    if (config.protocol === 'tspl') return buildTsplProductLabel(payload, config.gapLines);
    if (config.protocol === 'zpl') return buildZplProductLabel(payload);
    return buildEscposProductLabels(payload, config.cutPaper, config.gapLines);
}

export async function printProductLabels(payload: ProductLabelPayload, config = getLabelPrinterConfig()): Promise<void> {
    if (!config.enabled) throw new Error('Label printer is disabled');
    if (!isDirectConnection(config.connection)) throw new Error('Choose USB raw, Network, Serial, or Bluetooth for thermal label printing');
    if (config.protocol === 'system') throw new Error('Choose ESC/POS, TSPL, or ZPL for direct label printing');
    await sendDirectPrinterData({
        connection: config.connection,
        host: config.host,
        port: config.port,
        printerName: config.printerName,
        devicePath: config.devicePath,
        data: buildProductLabel(payload, config),
        documentName: `Label ${labelText(payload.product.name, 24)}`.trim(),
    });
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
    if (config.protocol === 'system') throw new Error('Choose ESC/POS, ZPL, or TSPL for direct label test printing');
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
