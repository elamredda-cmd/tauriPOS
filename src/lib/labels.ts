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
    showStore: boolean;
    showName: boolean;
    showPrice: boolean;
    showBarcodeText: boolean;
    showSku: boolean;
    showPlu: boolean;
}

export const labelSizePresets = [
    { label: '25 × 25 mm', width: 25, height: 25 },
    { label: '32 × 25 mm', width: 32, height: 25 },
    { label: '40 × 30 mm', width: 40, height: 30 },
    { label: '50 × 25 mm', width: 50, height: 25 },
    { label: '50 × 30 mm', width: 50, height: 30 },
    { label: '57 × 32 mm', width: 57, height: 32 },
    { label: '62 × 29 mm', width: 62, height: 29 },
    { label: '80 × 30 mm', width: 80, height: 30 },
    { label: '80 × 40 mm', width: 80, height: 40 },
    { label: '80 × 50 mm', width: 80, height: 50 },
    { label: '80 × 60 mm', width: 80, height: 60 },
    { label: '80 × 100 mm', width: 80, height: 100 },
    { label: '100 × 50 mm', width: 100, height: 50 },
    { label: '100 × 150 mm', width: 100, height: 150 },
];

export const defaultLabelDesign: LabelDesign = {
    widthMm: 50,
    heightMm: 30,
    template: 'standard',
    fontFamily: 'standard',
    textScale: 'normal',
    nameTextScale: 'normal',
    priceTextScale: 'normal',
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
