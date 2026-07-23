import type { Setting } from '$lib/stores/db';

export type LabelTemplate = 'compact' | 'standard' | 'barcode' | 'shelf';
export type LabelFontFamily = 'standard' | 'condensed' | 'serif';
export type LabelTextScale = 'small' | 'normal' | 'large';
export type LabelDatePosition =
    | 'top-left'
    | 'top-center'
    | 'top-right'
    | 'bottom-left'
    | 'bottom-center'
    | 'bottom-right';

export interface LabelDesign {
    widthMm: number;
    heightMm: number;
    template: LabelTemplate;
    fontFamily: LabelFontFamily;
    textScale: LabelTextScale;
    nameTextScale: LabelTextScale;
    priceTextScale: LabelTextScale;
    textSizePercent: number;
    nameSizePercent: number;
    priceSizePercent: number;
    barcodeSizePercent: number;
    nameCharacterLimit: number;
    showBarcode: boolean;
    showStore: boolean;
    showName: boolean;
    showPrice: boolean;
    showBarcodeText: boolean;
    showSku: boolean;
    showPlu: boolean;
    showPrintDate: boolean;
    printDatePosition: LabelDatePosition;
}

const defaultLabelNameCharacterLimit = 30;

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
    textSizePercent: 100,
    nameSizePercent: 100,
    priceSizePercent: 100,
    barcodeSizePercent: 100,
    nameCharacterLimit: defaultLabelNameCharacterLimit,
    showBarcode: true,
    showStore: false,
    showName: true,
    showPrice: true,
    showBarcodeText: true,
    showSku: false,
    showPlu: false,
    showPrintDate: false,
    printDatePosition: 'bottom-right',
};

const labelDatePositions = new Set<LabelDatePosition>([
    'top-left',
    'top-center',
    'top-right',
    'bottom-left',
    'bottom-center',
    'bottom-right',
]);

function legacyScalePercent(scale: unknown): number {
    return scale === 'small' ? 68 : scale === 'large' ? 132 : 100;
}

export function clampLabelSizePercent(value: unknown, minimum = 50, maximum = 200): number {
    const number = Number(value);
    return Number.isFinite(number)
        ? Math.max(minimum, Math.min(maximum, Math.round(number)))
        : 100;
}

export function labelSizeScale(value: unknown): number {
    return clampLabelSizePercent(value) / 100;
}

export function clampLabelNameCharacterLimit(value: unknown): number {
    const number = Number(value);
    return Number.isFinite(number)
        ? Math.max(5, Math.min(80, Math.round(number)))
        : defaultLabelNameCharacterLimit;
}

export function formatLabelProductName(value: unknown, characterLimit: unknown): string {
    const name = String(value || '').replace(/\s+/g, ' ').trim();
    return Array.from(name).slice(0, clampLabelNameCharacterLimit(characterLimit)).join('').trimEnd();
}

export function formatLabelPrintDate(date = new Date()): string {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `${day}/${month}/${date.getFullYear()}`;
}

export function getLabelDesign(settings: Setting[]): LabelDesign {
    const raw = settings.find((setting) => setting.key === 'label_design')?.value;
    if (!raw) return { ...defaultLabelDesign };
    try {
        const parsed = JSON.parse(raw);
        const legacyTextScale = parsed.textScale || defaultLabelDesign.textScale;
        return {
            ...defaultLabelDesign,
            ...parsed,
            // Convert old three-step sizes once while preserving their appearance.
            textScale: 'normal',
            nameTextScale: 'normal',
            priceTextScale: 'normal',
            textSizePercent: clampLabelSizePercent(
                parsed.textSizePercent ?? legacyScalePercent(legacyTextScale),
                60,
                180,
            ),
            nameSizePercent: clampLabelSizePercent(
                parsed.nameSizePercent ?? legacyScalePercent(parsed.nameTextScale || legacyTextScale),
                60,
                180,
            ),
            priceSizePercent: clampLabelSizePercent(
                parsed.priceSizePercent ?? legacyScalePercent(parsed.priceTextScale || legacyTextScale),
                60,
                200,
            ),
            barcodeSizePercent: clampLabelSizePercent(parsed.barcodeSizePercent, 50, 170),
            nameCharacterLimit: clampLabelNameCharacterLimit(parsed.nameCharacterLimit),
            showPrintDate: parsed.showPrintDate === true,
            printDatePosition: labelDatePositions.has(parsed.printDatePosition)
                ? parsed.printDatePosition
                : defaultLabelDesign.printDatePosition,
        };
    } catch {
        return { ...defaultLabelDesign };
    }
}
