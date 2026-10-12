import type { TaxRate } from '$lib/stores/db';

export function taxRateSnapshotsMatch(a: TaxRate[], b: TaxRate[]): boolean {
    const normalized = (rates: TaxRate[]) => rates.map(rate => ({
        id: String(rate.id), name: String(rate.name), rate: Number(rate.rate),
        isDefault: Boolean(Number(rate.isDefault)), createdAt: String(rate.createdAt),
    })).sort((x, y) => x.id.localeCompare(y.id));
    return JSON.stringify(normalized(a)) === JSON.stringify(normalized(b));
}

export function updatedTaxRateSnapshot(saved: TaxRate, before: TaxRate[]): TaxRate[] {
    if (!saved.id || !saved.name.trim() || !Number.isFinite(saved.rate) || saved.rate < 0 || saved.rate > 1) {
        throw new Error('Enter a tax name and a rate between 0% and 100%.');
    }
    const rest = before.filter(rate => rate.id !== saved.id)
        .map(rate => saved.isDefault ? { ...rate, isDefault: false } : { ...rate });
    return [...rest, { ...saved }];
}
