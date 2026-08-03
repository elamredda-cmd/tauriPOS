import { describe, expect, it } from 'vitest';
import { editDigitPadValue } from './digitPadEditing';

const numeric = { maxLength: 8, allowDecimal: true, allowPhoneSymbols: false, max: null };

describe('digit pad selection editing', () => {
    it('replaces the selected digits and moves the caret after the inserted digit', () => {
        expect(editDigitPadValue('1234', 1, 3, '9', numeric)).toEqual({
            value: '194', selectionStart: 2, selectionEnd: 2, applied: true,
        });
    });

    it('backspaces the selection or the digit immediately before the caret', () => {
        expect(editDigitPadValue('1234', 1, 3, 'backspace', numeric).value).toBe('14');
        expect(editDigitPadValue('1234', 2, 2, 'backspace', numeric)).toMatchObject({
            value: '134', selectionStart: 1, selectionEnd: 1,
        });
    });

    it('allows replacing an existing decimal point but refuses a second one', () => {
        expect(editDigitPadValue('12.3', 2, 3, '.', numeric)).toMatchObject({
            value: '12.3', selectionStart: 3, selectionEnd: 3, applied: true,
        });
        expect(editDigitPadValue('12.3', 4, 4, '.', numeric).applied).toBe(false);
        expect(editDigitPadValue('12.3', 1, 4, '5', numeric).value).toBe('15');
    });

    it('keeps a phone plus sign at the beginning', () => {
        const phone = { maxLength: 20, allowDecimal: false, allowPhoneSymbols: true, max: null };
        expect(editDigitPadValue('07123', 0, 5, '+', phone).value).toBe('+');
        expect(editDigitPadValue('07123', 2, 2, '+', phone).applied).toBe(false);
    });
});
