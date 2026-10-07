/** Plan a banknote tap in integer pence without changing card/account payments. */
export function planBanknotePayment(
    tenderedPence: number,
    banknotePence: number,
    duePence: number,
    maximumPence: number,
): { tenderedPence: number; shouldComplete: boolean } {
    if (![tenderedPence, banknotePence, duePence, maximumPence].every(Number.isSafeInteger)
        || tenderedPence < 0 || banknotePence <= 0 || duePence < 0 || maximumPence <= 0
        || duePence > maximumPence) {
        throw new Error('The cash amount is invalid. Check the amount received.');
    }
    const next = tenderedPence + banknotePence;
    if (!Number.isSafeInteger(next) || next > maximumPence) {
        throw new Error('Payment amount is too large');
    }
    return { tenderedPence: next, shouldComplete: next >= duePence };
}
