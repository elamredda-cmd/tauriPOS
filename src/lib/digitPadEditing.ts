export interface DigitPadEditOptions {
    maxLength: number;
    allowDecimal: boolean;
    allowPhoneSymbols: boolean;
    max: number | null;
}

export interface DigitPadEditResult {
    value: string;
    selectionStart: number;
    selectionEnd: number;
    applied: boolean;
}

function clampSelection(value: string, start: number, end: number): [number, number] {
    const fallback = value.length;
    const safeStart = start < 0 ? fallback : Math.min(value.length, Math.max(0, start));
    const safeEnd = end < 0 ? safeStart : Math.min(value.length, Math.max(0, end));
    return [Math.min(safeStart, safeEnd), Math.max(safeStart, safeEnd)];
}

function validCandidate(candidate: string, options: DigitPadEditOptions): boolean {
    if (candidate.length > options.maxLength) return false;
    if (options.allowPhoneSymbols) return /^\+?[\d ()-]*$/.test(candidate);
    if (!/^\d*(?:\.\d*)?$/.test(candidate)) return false;
    if (candidate.includes('.') && !options.allowDecimal) return false;
    if (!candidate || candidate === '.') return true;
    const numeric = Number(candidate);
    return Number.isFinite(numeric) && (options.max === null || numeric <= options.max);
}

/** Apply one touch-pad edit at the selected range, like a normal text field. */
export function editDigitPadValue(
    value: string,
    selectionStart: number,
    selectionEnd: number,
    key: string,
    options: DigitPadEditOptions,
): DigitPadEditResult {
    const [from, to] = clampSelection(value, selectionStart, selectionEnd);
    let next = value;
    let caret = from;

    if (key === 'clear') {
        next = '';
        caret = 0;
    } else if (key === 'backspace') {
        if (from !== to) {
            next = `${value.slice(0, from)}${value.slice(to)}`;
        } else if (from > 0) {
            next = `${value.slice(0, from - 1)}${value.slice(to)}`;
            caret = from - 1;
        } else {
            return { value, selectionStart: from, selectionEnd: to, applied: false };
        }
    } else {
        next = `${value.slice(0, from)}${key}${value.slice(to)}`;
        caret = from + key.length;
        if (!validCandidate(next, options)) {
            return { value, selectionStart: from, selectionEnd: to, applied: false };
        }
    }

    return {
        value: next,
        selectionStart: caret,
        selectionEnd: caret,
        applied: next !== value || from !== to,
    };
}

export function canInsertDigitPadKey(
    value: string,
    selectionStart: number,
    selectionEnd: number,
    key: string,
    options: DigitPadEditOptions,
): boolean {
    return editDigitPadValue(value, selectionStart, selectionEnd, key, options).applied;
}
