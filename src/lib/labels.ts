import type { Setting } from '$lib/stores/db';

export type LabelTemplate = 'compact' | 'standard' | 'barcode' | 'shelf';
export type LabelFontFamily = 'standard' | 'condensed' | 'serif';
export type LabelTextScale = 'small' | 'normal' | 'large';

export interface LabelDesign {
    widthMm: number;
    heightMm: number;
    template: LabelTemplate;
    fontFamily: LabelFontFamily;
    textScale: LabelTextScale;
    nameTextScale: LabelTextScale;
    priceTextScale: LabelTextScale;
    showBarcode: boolean;
    showStore: boolean;
    showName: boolean;
    showPrice: boolean;
    showBarcodeText: boolean;
    showSku: boolean;
    showPlu: boolean;
}

export const labelSizePresets = [
    { label: '25 x 25 mm', width: 25, height: 25 },
    { label: '32 x 25 mm', width: 32, height: 25 },
    { label: '40 x 30 mm', width: 40, height: 30 },
    { label: '50 x 25 mm', width: 50, height: 25 },
    { label: '50 x 30 mm', width: 50, height: 30 },
    { label: '57 x 32 mm', width: 57, height: 32 },
    { label: '62 x 29 mm', width: 62, height: 29 },
    { label: '80 x 30 mm', width: 80, height: 30 },
    { label: '80 x 40 mm', width: 80, height: 40 },
    { label: '80 x 50 mm', width: 80, height: 50 },
    { label: '80 x 60 mm', width: 80, height: 60 },
    { label: '80 x 100 mm', width: 80, height: 100 },
    { label: '100 x 50 mm', width: 100, height: 50 },
    { label: '100 x 150 mm', width: 100, height: 150 },
];

export const defaultLabelDesign: LabelDesign = {
    widthMm: 50,
    heightMm: 30,
    template: 'standard',
    fontFamily: 'standard',
    textScale: 'normal',
    nameTextScale: 'normal',
    priceTextScale: 'normal',
    showBarcode: true,
    showStore: false,
    showName: true,
    showPrice: true,
    showBarcodeText: true,
    showSku: false,
    showPlu: false,
};

export function getLabelDesign(settings: Setting[]): LabelDesign {
    const raw = settings.find((setting) => setting.key === 'label_design')?.value;
    if (!raw) return { ...defaultLabelDesign };
    try {
        const parsed = JSON.parse(raw);
        const legacyTextScale = parsed.textScale || defaultLabelDesign.textScale;
        return {
            ...defaultLabelDesign,
            ...parsed,
            nameTextScale: parsed.nameTextScale || legacyTextScale,
            priceTextScale: parsed.priceTextScale || legacyTextScale,
        };
    } catch {
        return { ...defaultLabelDesign };
    }
}
