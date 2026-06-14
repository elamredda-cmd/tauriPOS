import type { Setting } from '$lib/stores/db';

export interface ReceiptDesign {
    paperWidth: '58mm' | '80mm';
    textSize: 'small' | 'normal' | 'large';
    density: 'compact' | 'comfortable';
    headerText: string;
    footerText: string;
    customMessage: string;
    showAddress: boolean;
    showPhone: boolean;
    showEmail: boolean;
    showReceiptNumber: boolean;
    showDateTime: boolean;
    showCashier: boolean;
    showTill: boolean;
    showSku: boolean;
    showTax: boolean;
    showPayment: boolean;
    showBarcode: boolean;
}

export const defaultReceiptDesign: ReceiptDesign = {
    paperWidth: '80mm',
    textSize: 'normal',
    density: 'comfortable',
    headerText: '',
    footerText: 'Thank you for your visit!',
    customMessage: '',
    showAddress: true,
    showPhone: true,
    showEmail: false,
    showReceiptNumber: true,
    showDateTime: true,
    showCashier: true,
    showTill: true,
    showSku: false,
    showTax: true,
    showPayment: true,
    showBarcode: true,
};

export function getReceiptDesign(settings: Setting[]): ReceiptDesign {
    const raw = settings.find((setting) => setting.key === 'receipt_design')?.value;
    if (!raw) return { ...defaultReceiptDesign };
    try {
        return { ...defaultReceiptDesign, ...JSON.parse(raw) };
    } catch {
        return { ...defaultReceiptDesign };
    }
}
