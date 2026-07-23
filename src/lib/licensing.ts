import { invoke, isTauri } from '@tauri-apps/api/core';
import { writable } from 'svelte/store';
import { syncManualLicenseIdentity } from '$lib/stores/database';

export type ManualLicenseState =
    | 'active'
    | 'expiring'
    | 'trial'
    | 'trial_expired'
    | 'expired'
    | 'invalid'
    | 'shop_mismatch'
    | 'till_limit'
    | 'not_activated'
    | 'preview';

export interface ManualLicenseStatus {
    state: ManualLicenseState;
    message: string;
    accessAllowed: boolean;
    enforcementEnabled: boolean;
    signatureValid: boolean;
    isTrial: boolean;
    trialStartedAt: string;
    shopId: string;
    shopCode: string;
    shopName: string;
    licenseId: string;
    customerName: string;
    issuedAt: string;
    expiresOn: string;
    daysRemaining: number | null;
    maxTills: number;
    activeTills: number;
    features: string[];
}

export interface ManualLicenseRequest {
    code: string;
    requestId: string;
    shopId: string;
    shopCode: string;
    shopName: string;
    activeTills: number;
    createdAt: string;
}

export const manualLicenseStatus = writable<ManualLicenseStatus | null>(null);

function browserPreviewStatus(): ManualLicenseStatus {
    return {
        state: 'preview',
        message: 'Licence controls are available in the Tauri application',
        accessAllowed: true,
        enforcementEnabled: false,
        signatureValid: false,
        isTrial: false,
        trialStartedAt: '',
        shopId: 'shop_browser_preview',
        shopCode: 'PREVIEW',
        shopName: 'Browser Preview',
        licenseId: '',
        customerName: '',
        issuedAt: '',
        expiresOn: '',
        daysRemaining: null,
        maxTills: 0,
        activeTills: 1,
        features: [],
    };
}

export async function refreshManualLicenseStatus(): Promise<ManualLicenseStatus> {
    const status = isTauri()
        ? await invoke<ManualLicenseStatus>('manual_license_status')
        : browserPreviewStatus();
    manualLicenseStatus.set(status);
    return status;
}

export async function requireManualSaleAccess(): Promise<ManualLicenseStatus> {
    const status = await refreshManualLicenseStatus();
    if (!status.accessAllowed) {
        throw new Error(`SALE_LICENSE_REQUIRED: ${status.message}. Open Settings > Licence.`);
    }
    return status;
}

export async function createManualLicenseRequest(): Promise<ManualLicenseRequest> {
    if (!isTauri()) {
        return {
            code: 'LBJREQ1.browser-preview',
            requestId: 'req_preview',
            shopId: 'shop_browser_preview',
            shopCode: 'PREVIEW',
            shopName: 'Browser Preview',
            activeTills: 1,
            createdAt: new Date().toISOString(),
        };
    }
    return invoke<ManualLicenseRequest>('create_manual_license_request');
}

async function finishActivation(status: ManualLicenseStatus): Promise<ManualLicenseStatus> {
    manualLicenseStatus.set(status);
    await syncManualLicenseIdentity();
    return status;
}

export async function activateManualLicense(token: string): Promise<ManualLicenseStatus> {
    const status = await invoke<ManualLicenseStatus>('activate_manual_license', { token });
    return finishActivation(status);
}

export async function activateManualLicenseFile(path: string): Promise<ManualLicenseStatus> {
    const status = await invoke<ManualLicenseStatus>('activate_manual_license_file', { path });
    return finishActivation(status);
}
