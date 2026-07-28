import type { Product, Setting } from '$lib/stores/db';

export const AGE_RESTRICTION_SETTING_KEY = 'age_restriction_enabled';

export function isAgeRestrictionEnabled(settings: readonly Pick<Setting, 'key' | 'value'>[]): boolean {
    return settings.find((setting) => setting.key === AGE_RESTRICTION_SETTING_KEY)?.value !== 'false';
}

export function requiresAgeVerification(
    product: Pick<Product, 'isAgeRestricted'> | null | undefined,
    settings: readonly Pick<Setting, 'key' | 'value'>[],
): boolean {
    return isAgeRestrictionEnabled(settings) && product?.isAgeRestricted === true;
}
