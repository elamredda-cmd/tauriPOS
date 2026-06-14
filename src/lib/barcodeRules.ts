import type { Setting } from '$lib/stores/db';

export const BARCODE_RULES_SETTING_KEY = 'barcode_rules';

export type BarcodeRuleValueType = 'price' | 'weight';

export interface BarcodeRule {
    id: string;
    name: string;
    enabled: boolean;
    format: 'EAN-13';
    totalLength: number;
    prefix: string;
    productStart: number;
    productLength: number;
    valueStart: number;
    valueLength: number;
    valueType: BarcodeRuleValueType;
    decimalPlaces: number;
    validateCheckDigit: boolean;
}

export interface ParsedScaleBarcode {
    rule: BarcodeRule;
    rawBarcode: string;
    scalePlu: string;
    rawValue: number;
    value: number;
}

export const PRICE_RULE_PRESET: BarcodeRule = {
    id: '',
    name: 'Price barcode',
    enabled: true,
    format: 'EAN-13',
    totalLength: 13,
    prefix: '23',
    productStart: 3,
    productLength: 5,
    valueStart: 8,
    valueLength: 5,
    valueType: 'price',
    decimalPlaces: 2,
    validateCheckDigit: true,
};

export const WEIGHT_RULE_PRESET: BarcodeRule = {
    ...PRICE_RULE_PRESET,
    name: 'Weight barcode',
    prefix: '21',
    valueType: 'weight',
    decimalPlaces: 3,
};

export function getBarcodeRules(settings: Setting[]): BarcodeRule[] {
    const raw = settings.find((setting) => setting.key === BARCODE_RULES_SETTING_KEY)?.value;
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

export function isValidEan13(barcode: string): boolean {
    if (!/^\d{13}$/.test(barcode)) return false;
    const digits = barcode.split('').map(Number);
    const check = digits.pop()!;
    const sum = digits.reduce((total, digit, index) => {
        return total + digit * (index % 2 === 0 ? 1 : 3);
    }, 0);
    return (10 - (sum % 10)) % 10 === check;
}

export function addEan13CheckDigit(firstTwelveDigits: string): string {
    if (!/^\d{12}$/.test(firstTwelveDigits)) return firstTwelveDigits;
    const sum = firstTwelveDigits.split('').reduce((total, digit, index) => {
        return total + Number(digit) * (index % 2 === 0 ? 1 : 3);
    }, 0);
    return `${firstTwelveDigits}${(10 - (sum % 10)) % 10}`;
}

export function validateBarcodeRule(rule: BarcodeRule): string | null {
    if (!rule.name.trim()) return 'Rule name is required';
    if (rule.totalLength < 1) return 'Barcode length must be at least 1';
    if (!/^\d+$/.test(rule.prefix)) return 'Prefix must contain digits only';
    if (rule.productStart < 1 || rule.valueStart < 1) return 'Positions start from digit 1';
    if (rule.productLength < 1 || rule.valueLength < 1) return 'Field lengths must be at least 1';
    if (rule.productStart + rule.productLength - 1 > rule.totalLength) return 'Product code is outside the barcode length';
    if (rule.valueStart + rule.valueLength - 1 > rule.totalLength) return 'Value is outside the barcode length';
    const productEnd = rule.productStart + rule.productLength - 1;
    const valueEnd = rule.valueStart + rule.valueLength - 1;
    if (rule.productStart <= valueEnd && rule.valueStart <= productEnd) return 'Product code and value positions overlap';
    if (rule.productStart <= rule.prefix.length) return 'Product code overlaps the required prefix';
    if (rule.valueStart <= rule.prefix.length) return 'Value overlaps the required prefix';
    if (rule.validateCheckDigit && (productEnd === rule.totalLength || valueEnd === rule.totalLength)) {
        return 'Product code or value overlaps the check digit';
    }
    if (rule.decimalPlaces < 0 || rule.decimalPlaces > rule.valueLength) return 'Decimal places are invalid';
    if (rule.format === 'EAN-13' && rule.totalLength !== 13) return 'EAN-13 barcodes must contain 13 digits';
    return null;
}

export function parseScaleBarcode(barcode: string, rules: BarcodeRule[]): ParsedScaleBarcode | null {
    const rawBarcode = barcode.trim();
    if (!/^\d+$/.test(rawBarcode)) return null;

    for (const rule of rules) {
        if (!rule.enabled || validateBarcodeRule(rule)) continue;
        if (rawBarcode.length !== rule.totalLength || !rawBarcode.startsWith(rule.prefix)) continue;
        if (rule.validateCheckDigit && rule.format === 'EAN-13' && !isValidEan13(rawBarcode)) continue;

        const scalePlu = rawBarcode.slice(rule.productStart - 1, rule.productStart - 1 + rule.productLength);
        const valueDigits = rawBarcode.slice(rule.valueStart - 1, rule.valueStart - 1 + rule.valueLength);
        if (!scalePlu || !/^\d+$/.test(valueDigits)) continue;

        const rawValue = Number.parseInt(valueDigits, 10);
        if (!Number.isFinite(rawValue) || rawValue <= 0) continue;

        return {
            rule,
            rawBarcode,
            scalePlu,
            rawValue,
            value: rawValue / 10 ** rule.decimalPlaces,
        };
    }
    return null;
}
