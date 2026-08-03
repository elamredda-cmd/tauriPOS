import { describe, expect, it, vi } from 'vitest';
import type { Setting } from '$lib/stores/db';
import { formatLabelProductName, getLabelDesign } from '$lib/labels';
import { defaultReceiptDesign } from '$lib/receipt';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import {
    buildEscposReceipt,
    buildEscposTextReport,
    buildEscposTestReceipt,
    encodeEscposRaster,
    getLabelPrinterConfig,
    getReceiptPrinterConfig,
} from '$lib/printers';

function settings(values: Record<string, string>): Setting[] {
    return Object.entries(values).map(([key, value]) => ({ key, value, updatedAt: '2026-01-01T00:00:00.000Z' }));
}

function includesSequence(bytes: number[], sequence: number[]): boolean {
    return bytes.some((_, index) => sequence.every((value, offset) => bytes[index + offset] === value));
}

function countSequence(bytes: number[], sequence: number[]): number {
    return bytes.reduce(
        (count, _, index) => count + (sequence.every((value, offset) => bytes[index + offset] === value) ? 1 : 0),
        0,
    );
}

describe('printer configuration', () => {
    it('keeps an explicitly selected system receipt connection even when old direct targets remain', () => {
        const config = getReceiptPrinterConfig(settings({
            receipt_printer_connection: 'system',
            receipt_printer_name: 'Old Star Printer',
            receipt_printer_host: '192.168.1.90',
        }));
        expect(config.connection).toBe('system');
    });

    it('infers the legacy USB target when no connection setting exists', () => {
        const config = getReceiptPrinterConfig(settings({ receipt_printer_name: 'Star TSP100' }));
        expect(config.connection).toBe('usb_raw');
        expect(config.printerName).toBe('Star TSP100');
    });

    it('keeps SDK module selection and device IDs local in printer settings', () => {
        const config = getLabelPrinterConfig(settings({
            label_printer_connection: 'module',
            label_printer_module_id: 'star-prnt',
            label_printer_module_device_id: 'USB:TSP100',
            label_printer_protocol: 'star',
        }));
        expect(config.connection).toBe('module');
        expect(config.moduleId).toBe('star-prnt');
        expect(config.moduleDeviceId).toBe('USB:TSP100');
        expect(config.protocol).toBe('star');
    });
});

describe('receipt command safety', () => {
    it('prints quantity, product name, and amount on the same item row', () => {
        const config = getReceiptPrinterConfig(settings({
            receipt_printer_connection: 'usb_raw',
            receipt_printer_name: 'Receipt Printer',
            receipt_printer_cut_paper: 'false',
        }));
        const bytes = buildEscposReceipt({
            store: { name: 'Test Shop' },
            order: {
                id: 'order-1',
                orderNumber: 12,
                total: 500,
                subtotal: 500,
                discountAmount: 0,
                paymentMethod: 'cash',
                amountTendered: 500,
            },
            lines: [{
                id: 'line-1',
                orderId: 'order-1',
                productId: 'product-1',
                productName: 'Red Apples',
                quantity: 2,
                unitPrice: 250,
                lineTotal: 500,
            }],
            cashierName: 'Cashier',
            tillName: 'Till 1',
            design: {
                headerText: 'Test Shop',
                footerText: 'Thank you',
                paperWidth: '80mm',
                textSize: 'medium',
                titleTextSize: 'medium',
                fontFamily: 'standard',
                density: 'compact',
                showAddress: false,
                showPhone: false,
                showEmail: false,
                showReceiptNumber: false,
                showDateTime: false,
                showCashier: false,
                showTill: false,
                showPayment: false,
                showSku: false,
                showBarcode: false,
                customMessage: '',
            },
        } as any, config);

        const printableRows = bytes
            .reduce<number[][]>((rows, byte) => {
                if (byte === 0x0a) rows.push([]);
                else rows[rows.length - 1].push(byte);
                return rows;
            }, [[]])
            .map((row) => String.fromCharCode(...row.filter((byte) => byte >= 0x20 && byte <= 0x7e)));

        expect(printableRows.some((row) => (
            row.includes('2x Red Apples') && row.includes('5.00')
        ))).toBe(true);
    });

    it('prints an account refund as a credit instead of a new Pay Later charge', () => {
        const config = getReceiptPrinterConfig(settings({
            receipt_printer_connection: 'usb_raw',
            receipt_printer_name: 'Receipt Printer',
            receipt_printer_cut_paper: 'false',
        }));
        const bytes = buildEscposReceipt({
            store: { name: 'Test Shop' },
            order: {
                id: 'refund-1',
                orderNumber: 13,
                type: 'return',
                total: -500,
                subtotal: -500,
                discountAmount: 0,
                paymentMethod: 'account',
                amountTendered: -500,
            },
            lines: [],
            cashierName: 'Cashier',
            tillName: 'Till 1',
            design: { ...defaultReceiptDesign, showPayment: true },
        } as any, config);

        const printableText = String.fromCharCode(
            ...bytes.filter((byte) => byte === 0x0a || (byte >= 0x20 && byte <= 0x7e)),
        );
        expect(printableText).toContain('ACCOUNT CREDIT');
        expect(printableText).toContain('ACCOUNT CREDITED');
        expect(printableText).not.toContain('ACCOUNT DEBT ADDED');
    });

    it('labels a Pay Later sale as charged to the customer account', () => {
        const config = getReceiptPrinterConfig(settings({
            receipt_printer_connection: 'usb_raw',
            receipt_printer_name: 'Receipt Printer',
            receipt_printer_cut_paper: 'false',
        }));
        const bytes = buildEscposReceipt({
            store: { name: 'Test Shop' },
            order: {
                id: 'sale-account-1',
                orderNumber: 14,
                type: 'sale',
                total: 500,
                subtotal: 500,
                discountAmount: 0,
                paymentMethod: 'account',
                amountTendered: 500,
            },
            lines: [],
            cashierName: 'Cashier',
            tillName: 'Till 1',
            design: { ...defaultReceiptDesign, showPayment: true },
        } as any, config);

        const printableText = String.fromCharCode(
            ...bytes.filter((byte) => byte === 0x0a || (byte >= 0x20 && byte <= 0x7e)),
        );
        expect(printableText).toContain('PAY LATER');
        expect(printableText).toContain('ACCOUNT DEBT ADDED');
    });

    it('prints the exact loyalty and account portions of a mixed Pay Later sale', () => {
        const config = getReceiptPrinterConfig(settings({
            receipt_printer_connection: 'usb_raw',
            receipt_printer_name: 'Receipt Printer',
            receipt_printer_cut_paper: 'false',
        }));
        const bytes = buildEscposReceipt({
            store: { name: 'Test Shop' },
            order: {
                id: 'sale-account-loyalty-1',
                orderNumber: 15,
                type: 'sale',
                total: 1_000,
                subtotal: 1_000,
                discountAmount: 0,
                paymentMethod: 'account+loyalty',
                amountTendered: 1_000,
            },
            lines: [],
            payments: [{
                method: 'account',
                amount: 1_000,
                cashAmount: 0,
                cardAmount: 0,
                loyaltyAmount: 200,
                accountAmount: 800,
            }],
            cashierName: 'Cashier',
            tillName: 'Till 1',
            design: { ...defaultReceiptDesign, showPayment: true },
        } as any, config);

        const printableText = String.fromCharCode(
            ...bytes.filter((byte) => byte === 0x0a || (byte >= 0x20 && byte <= 0x7e)),
        );
        expect(printableText).toContain('LOYALTY');
        expect(printableText).toContain('2.00');
        expect(printableText).toContain('PAY LATER');
        expect(printableText).toContain('8.00');
        expect(printableText).toContain('ACCOUNT DEBT ADDED');
    });

    it('prints the cash actually tendered and keeps change separate', () => {
        const config = getReceiptPrinterConfig(settings({
            receipt_printer_connection: 'usb_raw',
            receipt_printer_name: 'Receipt Printer',
            receipt_printer_cut_paper: 'false',
        }));
        const bytes = buildEscposReceipt({
            store: { name: 'Test Shop' },
            order: {
                id: 'cash-with-change-1',
                orderNumber: 16,
                type: 'sale',
                total: 1_000,
                subtotal: 1_000,
                discountAmount: 0,
                paymentMethod: 'cash',
                amountTendered: 1_200,
            },
            lines: [],
            payments: [{
                method: 'cash',
                amount: 1_000,
                cashAmount: 1_000,
                cardAmount: 0,
                loyaltyAmount: 0,
                accountAmount: 0,
                changeGiven: 200,
            }],
            cashierName: 'Cashier',
            tillName: 'Till 1',
            design: { ...defaultReceiptDesign, showPayment: true },
        } as any, config);

        const printableText = String.fromCharCode(
            ...bytes.filter((byte) => byte === 0x0a || (byte >= 0x20 && byte <= 0x7e)),
        );
        expect(printableText).toContain('CASH');
        expect(printableText).toContain('12.00');
        expect(printableText).toContain('Change');
        expect(printableText).toContain('2.00');
    });

    it('cuts a generic receipt without emitting a drawer pulse', () => {
        const config = getReceiptPrinterConfig(settings({
            receipt_printer_connection: 'usb_raw',
            receipt_printer_name: 'Receipt Printer',
            receipt_printer_cut_paper: 'true',
            receipt_printer_cut_feed_lines: '0',
        }));
        const bytes = buildEscposTestReceipt(config);
        expect(includesSequence(bytes, [0x1d, 0x56, 0x00])).toBe(true);
        expect(includesSequence(bytes, [0x1b, 0x70])).toBe(false);
    });

    it('uses the Star feed-and-cut command for the Star preset', () => {
        const config = getReceiptPrinterConfig(settings({
            receipt_printer_connection: 'usb_raw',
            receipt_printer_name: 'Star TSP100',
            receipt_printer_model: 'star_tsp100',
            receipt_printer_cut_paper: 'true',
        }));
        const bytes = buildEscposTestReceipt(config);
        expect(bytes.slice(-3)).toEqual([0x1b, 0x64, 0x03]);
        expect(includesSequence(bytes, [0x1b, 0x70])).toBe(false);
    });

    it('emits the UK character-set sequence for pound values', () => {
        const config = getReceiptPrinterConfig(settings({
            receipt_printer_connection: 'usb_raw',
            receipt_printer_name: 'Receipt Printer',
            receipt_printer_cut_paper: 'false',
        }));
        const bytes = buildEscposTextReport('Net sales: £12.34', config);
        expect(includesSequence(bytes, [0x1b, 0x52, 0x03, 0x23, 0x1b, 0x52, 0x00])).toBe(true);
    });
});

describe('ESC/POS label raster encoding', () => {
    it('sends an XP-E200M 80 x 30 mm raster as one complete image command', () => {
        const bytesPerRow = 72;
        const height = 240;
        const bytes = encodeEscposRaster({
            bytesPerRow,
            height,
            data: new Uint8Array(bytesPerRow * height),
        });

        expect(bytes.slice(0, 8)).toEqual([0x1d, 0x76, 0x30, 0x00, 72, 0, 240, 0]);
        expect(countSequence(bytes, [0x1d, 0x76, 0x30, 0x00])).toBe(1);
        expect(bytes).toHaveLength(8 + bytesPerRow * height);
    });

    it('still splits a large raster into bounded image commands', () => {
        const bytesPerRow = 72;
        const height = 600;
        const bytes = encodeEscposRaster({
            bytesPerRow,
            height,
            data: new Uint8Array(bytesPerRow * height),
        });

        expect(countSequence(bytes, [0x1d, 0x76, 0x30, 0x00])).toBe(2);
    });
});

describe('label name character limit', () => {
    it('uses the saved character limit and clips the visible name exactly', () => {
        const design = getLabelDesign(settings({
            label_design: JSON.stringify({ nameCharacterLimit: 12 }),
        }));

        expect(design.nameCharacterLimit).toBe(12);
        expect(formatLabelProductName('Premium Chocolate Biscuits', design.nameCharacterLimit)).toBe('Premium Choc');
    });

    it('gives older saved designs the safe default limit', () => {
        const design = getLabelDesign(settings({ label_design: JSON.stringify({ template: 'standard' }) }));
        expect(design.nameCharacterLimit).toBe(30);
    });
});
