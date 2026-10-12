/**
 * An unfinished checkout is a device-local draft, never a sale or tender.
 * SQLite is the native durable journal. The synchronous WebView mirror covers
 * a reload that happens before the queued native transaction can complete.
 * Both copies retain revisioned tombstones, so an older save cannot revive a
 * trolley which has already been cleared, held or successfully sold.
 */
import { isTauri } from '@tauri-apps/api/core';
import { getDb } from './stores/sqlite';

export const CHECKOUT_DRAFT_SETTING = 'checkout_draft_v1';
export const CHECKOUT_DRAFT_KEY = 'pos.checkout-draft.v1';
export const MAX_CHECKOUT_DRAFT_LINES = 2000;
const MAX_PRICE_PENCE = 999_999_999;
const MAX_QUANTITY = 9999;
const MAX_SERIALIZED_LENGTH = 2_000_000;
const INVALID_JOURNAL = 'The saved trolley draft is invalid. Keep it for recovery; do not overwrite it.';

export interface CheckoutDraftLine {
    id: string;
    name: string;
    price: number;
    quantity: number;
    note: string;
    isPriceOverride?: boolean;
    originalPrice?: number;
    sourceBarcode?: string;
    quantityLocked?: boolean;
    skipStockAdjustment?: boolean;
}

export interface CheckoutDraft {
    version: 1;
    id: string;
    tillId: string;
    cart: CheckoutDraftLine[];
    customerId: string;
    discountId: string;
    selectedCartIndex: number;
    saleIds: string[];
    pendingHoldId: string;
}

export interface CheckoutDraftEnvelope {
    version: 1;
    revision: number;
    draft: CheckoutDraft | null;
}

/** The expected raw value makes validation and replacement a compare-and-swap. */
export const CHECKOUT_DRAFT_UPSERT_SQL = `
    INSERT INTO settings (key, value, updatedAt) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt
    WHERE settings.value = ? AND json_valid(settings.value)
        AND json_extract(settings.value, '$.version') = 1
        AND json_type(settings.value, '$.revision') = 'integer'
        AND json_extract(settings.value, '$.revision') < json_extract(excluded.value, '$.revision')
`;

function invalid(): never { throw new Error(INVALID_JOURNAL); }
function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid();
    return value as Record<string, unknown>;
}
function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): void {
    if (Object.keys(value).some(key => !keys.includes(key))) invalid();
}
function text(value: unknown, maximum: number, required = false): string {
    if (typeof value !== 'string' || value.length > maximum || (required && !value.trim())) invalid();
    return value;
}
function price(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_PRICE_PENCE) invalid();
    return value;
}

/** Strict allow-list: payment/session/account state must never enter this journal. */
export function validateCheckoutDraft(value: unknown): CheckoutDraft {
    const draft = record(value);
    onlyKeys(draft, ['version', 'id', 'tillId', 'cart', 'customerId', 'discountId', 'selectedCartIndex', 'saleIds', 'pendingHoldId']);
    if (draft.version !== 1 || !Array.isArray(draft.cart) || draft.cart.length < 1
        || draft.cart.length > MAX_CHECKOUT_DRAFT_LINES) invalid();
    const cart = draft.cart.map(value => {
        const line = record(value);
        onlyKeys(line, ['id', 'name', 'price', 'quantity', 'note', 'isPriceOverride', 'originalPrice', 'sourceBarcode', 'quantityLocked', 'skipStockAdjustment']);
        if (typeof line.quantity !== 'number' || !Number.isFinite(line.quantity)
            || line.quantity <= 0 || line.quantity > MAX_QUANTITY) invalid();
        const copy: CheckoutDraftLine = {
            id: text(line.id, 256, true), name: text(line.name, 2000, true),
            price: price(line.price), quantity: line.quantity, note: text(line.note, 10_000),
        };
        for (const flag of ['isPriceOverride', 'quantityLocked', 'skipStockAdjustment'] as const) {
            if (line[flag] !== undefined) {
                if (typeof line[flag] !== 'boolean') invalid();
                copy[flag] = line[flag];
            }
        }
        if (line.originalPrice !== undefined) copy.originalPrice = price(line.originalPrice);
        if (line.sourceBarcode !== undefined) copy.sourceBarcode = text(line.sourceBarcode, 1024);
        return copy;
    });
    if (typeof draft.selectedCartIndex !== 'number' || !Number.isInteger(draft.selectedCartIndex)
        || draft.selectedCartIndex < 0 || draft.selectedCartIndex >= cart.length) invalid();
    if (!Array.isArray(draft.saleIds) || draft.saleIds.length > 1000) invalid();
    const saleIds = draft.saleIds.map(id => text(id, 256, true));
    if (new Set(saleIds).size !== saleIds.length) invalid();
    return {
        version: 1, id: text(draft.id, 256, true), tillId: text(draft.tillId, 256), cart,
        customerId: text(draft.customerId, 256), discountId: text(draft.discountId, 256),
        selectedCartIndex: draft.selectedCartIndex, saleIds, pendingHoldId: text(draft.pendingHoldId, 256),
    };
}

export function readCheckoutDraftEnvelope(raw: string | null): CheckoutDraftEnvelope | null {
    if (raw === null) return null;
    if (typeof raw !== 'string' || !raw || raw.length > MAX_SERIALIZED_LENGTH) invalid();
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { invalid(); }
    const envelope = record(parsed);
    onlyKeys(envelope, ['version', 'revision', 'draft']);
    if (envelope.version !== 1 || typeof envelope.revision !== 'number'
        || !Number.isSafeInteger(envelope.revision) || envelope.revision < 1) invalid();
    return { version: 1, revision: envelope.revision,
        draft: envelope.draft === null ? null : validateCheckoutDraft(envelope.draft) };
}

/** A tied revision with different contents is corruption, not a guessing game. */
export function selectCheckoutDraftEnvelope(
    mirror: CheckoutDraftEnvelope | null, durable: CheckoutDraftEnvelope | null,
): CheckoutDraftEnvelope | null {
    if (!mirror) return durable;
    if (!durable) return mirror;
    if (mirror.revision === durable.revision && JSON.stringify(mirror) !== JSON.stringify(durable)) invalid();
    return mirror.revision >= durable.revision ? mirror : durable;
}

function mirrorStorage(): Storage {
    if (typeof localStorage === 'undefined') {
        throw new Error('Trolley recovery storage is unavailable. Do not take payment until storage is restored.');
    }
    return localStorage;
}

type Waiter = { resolve: () => void; reject: (error: unknown) => void };
type PendingWrite = { serialized: string; native: boolean; waiters: Waiter[] };
let revision = 0;
let pending: PendingWrite | null = null;
let draining: Promise<void> | null = null;
let latestPersistence: Promise<void> = Promise.resolve();

async function readDurableEnvelope(db: Awaited<ReturnType<typeof getDb>>): Promise<{
    raw: string | null; envelope: CheckoutDraftEnvelope | null;
}> {
    const rows = await db.select<Array<{ value: string }>>(
        'SELECT value FROM settings WHERE key = ? LIMIT 1', [CHECKOUT_DRAFT_SETTING],
    );
    // A missing row is different from a present, malformed NULL/empty value.
    if (rows.length && typeof rows[0].value !== 'string') invalid();
    const raw = rows.length ? rows[0].value : null;
    return { raw, envelope: readCheckoutDraftEnvelope(raw) };
}

async function writeDurableEnvelope(serialized: string): Promise<void> {
    const incoming = readCheckoutDraftEnvelope(serialized)!;
    const db = await getDb();
    for (let attempt = 0; attempt < 8; attempt++) {
        const current = await readDurableEnvelope(db);
        if (current.envelope && current.envelope.revision >= incoming.revision) {
            // Equal revisions must have identical validated contents. A newer
            // clear/save wins even if an older WebView's command arrives last.
            selectCheckoutDraftEnvelope(incoming, current.envelope);
            return;
        }
        const result = await db.execute(CHECKOUT_DRAFT_UPSERT_SQL, [
            CHECKOUT_DRAFT_SETTING, serialized, new Date().toISOString(), current.raw,
        ]);
        if (Number(result.rowsAffected) === 1) return;
        // A different WebView updated the row between SELECT and UPSERT. Read
        // and validate it again; never overwrite unvalidated changed contents.
    }
    throw new Error('Trolley recovery changed repeatedly. Retry before taking payment.');
}

async function drainWrites(): Promise<void> {
    while (pending) {
        const write = pending;
        pending = null;
        try {
            if (write.native) await writeDurableEnvelope(write.serialized);
            write.waiters.forEach(waiter => waiter.resolve());
        } catch (error) {
            // The mirror intentionally survives failure. A later retry can
            // commit it; this failed durable save is never reported as success.
            write.waiters.forEach(waiter => waiter.reject(error));
        }
    }
}

function scheduleDrain(): void {
    if (draining || !pending) return;
    draining = Promise.resolve().then(drainWrites).finally(() => {
        draining = null;
        // A caller's resolved-promise continuation can enqueue an edit between
        // the last transaction and this finally continuation.
        scheduleDrain();
    });
}

/** Read before enabling checkout edits; malformed copies are never overwritten. */
export async function loadCheckoutDraft(): Promise<CheckoutDraft | null> {
    while (draining) await draining;
    const mirror = readCheckoutDraftEnvelope(mirrorStorage().getItem(CHECKOUT_DRAFT_KEY));
    let durable: CheckoutDraftEnvelope | null = null;
    if (isTauri()) {
        durable = (await readDurableEnvelope(await getDb())).envelope;
    }
    const latest = selectCheckoutDraftEnvelope(mirror, durable);
    revision = Math.max(revision, latest?.revision ?? 0);
    // Refresh a stale mirror immediately, including a durable tombstone.
    if (latest && (!mirror || latest.revision > mirror.revision)) {
        mirrorStorage().setItem(CHECKOUT_DRAFT_KEY, JSON.stringify(latest));
    }
    return latest?.draft ?? null;
}

/**
 * Snapshots/mirror writes happen synchronously, before this function returns.
 * The promise resolves only after the latest coalesced native write commits.
 * An unavailable/full mirror fails closed rather than giving a reload guarantee
 * which cannot be honoured. It never silently falls back to an older draft.
 */
export function persistCheckoutDraft(draft: CheckoutDraft | null): Promise<void> {
    try {
        const snapshot = draft === null ? null : validateCheckoutDraft(draft);
        const storage = mirrorStorage();
        const previous = readCheckoutDraftEnvelope(storage.getItem(CHECKOUT_DRAFT_KEY));
        const nextRevision = Math.max(revision + 1, (previous?.revision ?? 0) + 1, Date.now() * 1000);
        if (!Number.isSafeInteger(nextRevision)) invalid();
        const envelope: CheckoutDraftEnvelope = { version: 1, revision: nextRevision, draft: snapshot };
        const serialized = JSON.stringify(envelope);
        if (serialized.length > MAX_SERIALIZED_LENGTH) invalid();
        storage.setItem(CHECKOUT_DRAFT_KEY, serialized);
        revision = nextRevision;
        latestPersistence = new Promise<void>((resolve, reject) => {
            const waiters = [...(pending?.waiters ?? []), { resolve, reject }];
            pending = { serialized, native: isTauri(), waiters };
        });
        // One microtask batches successive edits without a timer or a write
        // per keystroke. Entered transactions stay strictly ordered.
        scheduleDrain();
        return latestPersistence;
    } catch (error) {
        latestPersistence = Promise.reject(error);
        return latestPersistence;
    }
}

/** A barrier for hold/sale/navigation actions; a failed latest save rejects. */
export function flushCheckoutDraft(): Promise<void> { return latestPersistence; }
