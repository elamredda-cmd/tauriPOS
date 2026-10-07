import { describe, expect, it } from 'vitest';
import { planBanknotePayment } from './cashShortcuts';

const MAXIMUM_PENCE = 99_999_999;

describe('banknote payment planning', () => {
    it('adds successive notes and completes only once the total is covered', () => {
        const first = planBanknotePayment(0, 500, 1800, MAXIMUM_PENCE);
        expect(first).toEqual({ tenderedPence: 500, shouldComplete: false });

        const second = planBanknotePayment(first.tenderedPence, 1000, 1800, MAXIMUM_PENCE);
        expect(second).toEqual({ tenderedPence: 1500, shouldComplete: false });

        const third = planBanknotePayment(second.tenderedPence, 500, 1800, MAXIMUM_PENCE);
        expect(third).toEqual({ tenderedPence: 2000, shouldComplete: true });
        expect(third.tenderedPence - 1800).toBe(200);
    });

    it('completes on exact payment without requiring an additional note', () => {
        expect(planBanknotePayment(500, 500, 1000, MAXIMUM_PENCE))
            .toEqual({ tenderedPence: 1000, shouldComplete: true });
    });

    it('preserves all received cash so a £20 note against £6 returns £14', () => {
        const result = planBanknotePayment(0, 2000, 600, MAXIMUM_PENCE);
        expect(result).toEqual({ tenderedPence: 2000, shouldComplete: true });
        expect(result.tenderedPence - 600).toBe(1400);
    });

    it('keeps penny precision when notes top up manually entered cash', () => {
        expect(planBanknotePayment(149, 500, 650, MAXIMUM_PENCE))
            .toEqual({ tenderedPence: 649, shouldComplete: false });
        const result = planBanknotePayment(151, 500, 650, MAXIMUM_PENCE);
        expect(result).toEqual({ tenderedPence: 651, shouldComplete: true });
        expect(result.tenderedPence - 650).toBe(1);
    });

    it('allows received cash exactly at the configured maximum', () => {
        expect(planBanknotePayment(MAXIMUM_PENCE - 500, 500, MAXIMUM_PENCE, MAXIMUM_PENCE))
            .toEqual({ tenderedPence: MAXIMUM_PENCE, shouldComplete: true });
    });

    it('preserves tendered cash even if nothing is due, leaving that UI policy to checkout', () => {
        const result = planBanknotePayment(0, 500, 0, MAXIMUM_PENCE);
        expect(result).toEqual({ tenderedPence: 500, shouldComplete: true });
    });

    it.each([
        [-1, 500, 600, MAXIMUM_PENCE],
        [0, 0, 600, MAXIMUM_PENCE],
        [0, -500, 600, MAXIMUM_PENCE],
        [0, 500, -1, MAXIMUM_PENCE],
        [0, 500, 600, 0],
        [0, 500, 600, -1],
        [0, 500, 601, 600],
    ])('rejects invalid payment bounds (%s, %s, %s, %s)', (received, note, due, maximum) => {
        expect(() => planBanknotePayment(received, note, due, maximum))
            .toThrow('The cash amount is invalid');
    });

    it.each([0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
        'rejects non-integer or unsafe amounts in every argument (%s)', (invalid) => {
            const valid = [0, 500, 600, MAXIMUM_PENCE] as const;
            for (let index = 0; index < valid.length; index += 1) {
                const values: [number, number, number, number] = [...valid];
                values[index] = invalid;
                expect(() => planBanknotePayment(...values)).toThrow('The cash amount is invalid');
            }
        },
    );

    it('rejects notes that take received cash above the configured limit', () => {
        expect(() => planBanknotePayment(MAXIMUM_PENCE - 499, 500, 600, MAXIMUM_PENCE))
            .toThrow('Payment amount is too large');
    });

    it('rejects integer overflow when adding otherwise valid individual amounts', () => {
        expect(() => planBanknotePayment(Number.MAX_SAFE_INTEGER, 500, 600, Number.MAX_SAFE_INTEGER))
            .toThrow('Payment amount is too large');
    });
});
