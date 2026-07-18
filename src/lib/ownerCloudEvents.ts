export const OWNER_CLOUD_DATA_CHANGED_EVENT = 'owner-cloud-data-changed';
export const OWNER_CLOUD_STATUS_EVENT = 'owner-cloud-status';

export function notifyOwnerCloudDataChanged(): void {
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event(OWNER_CLOUD_DATA_CHANGED_EVENT));
    }
}
