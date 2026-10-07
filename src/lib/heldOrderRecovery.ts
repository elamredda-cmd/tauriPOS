/** Device-local recovery journal. Write BEFORE claiming/deleting a shared hold. */
import { isTauri } from '@tauri-apps/api/core';
import { commitBatch, getDb } from './stores/sqlite';
export const HELD_RECOVERY_KEY = 'pos.held-recovery.v1';
export const HELD_RECOVERY_SETTING = 'held_order_recovery_v1';
export interface HeldRecovery {
    orderId: string;
    claimId: string;
    serverDataEpoch: string;
    cart: Array<{ id: string; name: string; price: number; quantity: number; note: string; [key: string]: unknown }>;
    customerId: string;
    discountId: string;
    saleIds: string[];
}
export function readHeldRecovery(storage: Pick<Storage, 'getItem'>): HeldRecovery | null {
    const raw = storage.getItem(HELD_RECOVERY_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (!value?.orderId || !value.claimId || typeof value.serverDataEpoch !== 'string'
        || !Array.isArray(value.cart) || !Array.isArray(value.saleIds)
        || !value.cart.every((line: any) => line.id && Number.isFinite(line.price) && Number.isFinite(line.quantity))) {
        throw new Error('The interrupted trolley journal is invalid. Keep it for recovery; do not overwrite it.');
    }
    return value;
}
export function writeHeldRecovery(storage: Pick<Storage, 'setItem'>, recovery: HeldRecovery): void {
    storage.setItem(HELD_RECOVERY_KEY, JSON.stringify(recovery));
}

let journalWrites: Promise<unknown> = Promise.resolve();
export function withHeldRecoveryWrite<T>(operation: () => Promise<T>): Promise<T> {
    const write = journalWrites.catch(() => undefined).then(operation);
    journalWrites = write;
    return write;
}
export async function loadHeldRecovery(): Promise<HeldRecovery | null> {
    await journalWrites.catch(() => undefined);
    if (!isTauri()) return readHeldRecovery(localStorage);
    const rows: any[] = await (await getDb()).select('SELECT value FROM settings WHERE key = ?', [HELD_RECOVERY_SETTING]);
    return readHeldRecovery({ getItem: () => rows[0]?.value || null });
}
export function persistHeldRecovery(recovery: HeldRecovery | null): Promise<void> {
    // Capture now and serialize saves/clears so an older async save can never
    // resurrect a cleared trolley. Tauri commits to SQLite, not WebView storage.
    const serialized = recovery ? JSON.stringify(recovery) : null;
    return withHeldRecoveryWrite(async () => {
        if (!isTauri()) {
            if (serialized === null) localStorage.removeItem(HELD_RECOVERY_KEY);
            else localStorage.setItem(HELD_RECOVERY_KEY, serialized);
            return;
        }
        await commitBatch([{ table: 'settings', idKey: 'key', kind: serialized === null ? 'remove' : 'upsert',
            data: { key: HELD_RECOVERY_SETTING, ...(serialized === null ? {} : { value: serialized, updatedAt: new Date().toISOString() }) } }]);
    });
}
