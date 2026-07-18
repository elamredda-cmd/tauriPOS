export const OWNER_APP_PAIRING_VERSION = '2';
export const OWNER_APP_PAIRING_SCHEME = 'lbjpos';
export const OWNER_APP_PAIRING_HOST = 'owner';
export const OWNER_APP_PAIRING_PATH = '/add';

const SHOP_ID_PATTERN = /^shop_[A-Za-z0-9_-]{8,128}$/;
const PAIRING_CODE_PATTERN = /^[A-Za-z0-9_-]{20,160}$/;

export function isValidOwnerAppShopId(shopId: string): boolean {
    return SHOP_ID_PATTERN.test(shopId.trim());
}

export function createOwnerAppPairingUri(shopId: string, pairingCode = ''): string {
    const normalized = shopId.trim();
    if (!isValidOwnerAppShopId(normalized)) {
        throw new Error('The shop identity is not ready for owner-app pairing');
    }
    const normalizedCode = pairingCode.trim();
    if (!normalizedCode) {
        const query = new URLSearchParams({
            v: '1',
            shop: normalized,
        });
        return `${OWNER_APP_PAIRING_SCHEME}://${OWNER_APP_PAIRING_HOST}${OWNER_APP_PAIRING_PATH}?${query.toString()}`;
    }
    if (!PAIRING_CODE_PATTERN.test(normalizedCode)) {
        throw new Error('Secure owner-app pairing is not configured for this shop');
    }
    const query = new URLSearchParams({
        v: OWNER_APP_PAIRING_VERSION,
        shop: normalized,
        code: normalizedCode,
    });
    return `${OWNER_APP_PAIRING_SCHEME}://${OWNER_APP_PAIRING_HOST}${OWNER_APP_PAIRING_PATH}?${query.toString()}`;
}

export function formatOwnerAppShopCode(shopId: string): string {
    const compact = shopId.trim().replace(/^shop_/, '').replace(/[^A-Za-z0-9]/g, '');
    return compact.slice(0, 8).toUpperCase();
}
