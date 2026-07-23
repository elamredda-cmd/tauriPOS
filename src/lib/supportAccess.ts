import { isTauri } from '@tauri-apps/api/core';
import { invoke } from '@tauri-apps/api/core';

export interface SupportAccessRequest {
    code: string;
    requestId: string;
    shopId: string;
    shopCode: string;
    shopName: string;
    tillId: string;
    tillName: string;
    createdAt: string;
    expiresAt: string;
}

export interface SupportSessionGrant {
    sessionId: string;
    shopId: string;
    shopCode: string;
    actorName: string;
    issuedAt: string;
    expiresAt: string;
    minutesRemaining: number;
}

function browserPreviewRequest(): SupportAccessRequest {
    const created = new Date();
    const expires = new Date(created.getTime() + 10 * 60 * 1000);
    const payload = {
        v: 1,
        requestId: `supreq_preview_${crypto.randomUUID().replace(/-/g, '')}`,
        shopId: 'shop_browser_preview',
        shopName: 'My Shop',
        tillId: 'browser-preview-till',
        tillName: 'Browser Preview',
        createdAt: created.toISOString(),
        expiresAt: expires.toISOString(),
    };
    const encoded = btoa(JSON.stringify(payload))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
    return {
        code: `LBJSUPREQ1.${encoded}`,
        requestId: payload.requestId,
        shopId: payload.shopId,
        shopCode: 'BROWSERP',
        shopName: payload.shopName,
        tillId: payload.tillId,
        tillName: payload.tillName,
        createdAt: payload.createdAt,
        expiresAt: payload.expiresAt,
    };
}

export async function createSupportAccessRequest(): Promise<SupportAccessRequest> {
    if (!isTauri()) return browserPreviewRequest();
    return invoke<SupportAccessRequest>('create_support_access_request');
}

export async function activateSupportAccess(token: string): Promise<SupportSessionGrant> {
    if (!isTauri()) {
        throw new Error('A signed support code can only be activated in the installed POS app.');
    }
    return invoke<SupportSessionGrant>('activate_support_access', { token: token.trim() });
}
