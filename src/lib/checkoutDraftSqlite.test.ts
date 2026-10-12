import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckoutDraft } from './checkoutDraft';

const boundary = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));
vi.mock('./stores/sqlite', () => ({ getDb: boundary.getDb }));

let db: DatabaseSync;
let journal: typeof import('./checkoutDraft');
let mirror: Map<string, string>;
let beforeExecute: ((sql: string, params: string[]) => Promise<void>) | null;
let executeCount: number;

function draft(): CheckoutDraft {
    return { version: 1, id: 'draft-sqlite', tillId: 'till-1',
        cart: [{ id: 'item-1', name: 'Bread', price: 175, quantity: 2, note: '' }],
        customerId: 'customer-1', discountId: '', selectedCartIndex: 0, saleIds: [], pendingHoldId: '' };
}
function stored(): { version: 1; revision: number; draft: CheckoutDraft | null } | null {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(journal.CHECKOUT_DRAFT_SETTING);
    return row ? JSON.parse(String(row.value)) : null;
}
function seed(value: string | null): void {
    db.prepare('INSERT OR REPLACE INTO settings (key, value, updatedAt) VALUES (?, ?, ?)')
        .run(journal.CHECKOUT_DRAFT_SETTING, value, 'test');
}
function gate() {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
}

beforeEach(async () => {
    vi.resetModules();
    db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updatedAt TEXT)');
    mirror = new Map();
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => mirror.get(key) ?? null,
        setItem: (key: string, value: string) => { mirror.set(key, value); },
    });
    beforeExecute = null;
    executeCount = 0;
    boundary.getDb.mockReset().mockResolvedValue({
        select: async (sql: string, params: string[]) => db.prepare(sql).all(...params),
        execute: async (sql: string, params: string[]) => {
            executeCount++;
            await beforeExecute?.(sql, params);
            return { rowsAffected: Number(db.prepare(sql).run(...params).changes) };
        },
    });
    journal = await import('./checkoutDraft');
});
afterEach(() => { db.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('checkout draft atomic native SQLite ordering', () => {
    it('stores and reloads an ordinary draft and a durable clear tombstone', async () => {
        await journal.persistCheckoutDraft(draft());
        const saved = stored()!;
        expect(saved.draft).toEqual(draft());
        expect(await journal.loadCheckoutDraft()).toEqual(draft());
        await journal.persistCheckoutDraft(null);
        expect(stored()!.revision).toBeGreaterThan(saved.revision);
        expect(stored()!.draft).toBeNull();
        mirror.clear();
        vi.resetModules();
        const restarted = await import('./checkoutDraft');
        expect(await restarted.loadCheckoutDraft()).toBeNull();
        expect(JSON.parse(mirror.get(restarted.CHECKOUT_DRAFT_KEY)!).draft).toBeNull();
    });

    it('rejects an older WebView save arriving after a newer clear without resurrecting it', async () => {
        const waiting = gate();
        let firstEntered = false;
        beforeExecute = async () => {
            if (!firstEntered) { firstEntered = true; await waiting.promise; }
        };
        const oldWindow = journal;
        const oldSave = oldWindow.persistCheckoutDraft(draft());
        await vi.waitFor(() => expect(firstEntered).toBe(true));
        const oldRevision = JSON.parse(mirror.get(journal.CHECKOUT_DRAFT_KEY)!).revision;

        // Fresh module state models a reloaded/new WebView sharing this local
        // SQLite database and WebView mirror, not the old JS serialization queue.
        vi.resetModules();
        const newWindow = await import('./checkoutDraft');
        await newWindow.persistCheckoutDraft(null);
        const clear = stored()!;
        expect(clear.draft).toBeNull();
        expect(clear.revision).toBeGreaterThan(oldRevision);
        waiting.release();
        await oldSave;
        expect(stored()).toEqual(clear);
        expect(await newWindow.loadCheckoutDraft()).toBeNull();
        expect(JSON.parse(mirror.get(newWindow.CHECKOUT_DRAFT_KEY)!)).toEqual(clear);
    });

    it('keeps a newer draft when an older WebView command arrives last', async () => {
        const waiting = gate();
        let firstEntered = false;
        beforeExecute = async () => {
            if (!firstEntered) { firstEntered = true; await waiting.promise; }
        };
        const oldSave = journal.persistCheckoutDraft(draft());
        await vi.waitFor(() => expect(firstEntered).toBe(true));
        vi.resetModules();
        const newWindow = await import('./checkoutDraft');
        const latest = { ...draft(), customerId: 'new-customer', cart: [{ ...draft().cart[0], quantity: 5 }] };
        await newWindow.persistCheckoutDraft(latest);
        const saved = stored();
        waiting.release();
        await oldSave;
        expect(stored()).toEqual(saved);
        expect(await newWindow.loadCheckoutDraft()).toEqual(latest);
    });

    it.each([
        null, '', 'not-json', '{}',
        JSON.stringify({ version: 1, revision: 1, draft: { version: 1, cart: [] } }),
        JSON.stringify({ version: 1, revision: 1, draft: null, employeePin: 'not-a-real-pin' }),
    ])('does not replace an existing malformed durable value: %s', async (corrupt) => {
        seed(corrupt);
        await expect(journal.persistCheckoutDraft(draft())).rejects.toThrow('invalid');
        await expect(journal.flushCheckoutDraft()).rejects.toThrow('invalid');
        expect(db.prepare('SELECT value FROM settings').get()!.value).toBe(corrupt);
        expect(executeCount).toBe(0);
    });

    it('does not overwrite a corrupt row introduced after validation but before its SQL executes', async () => {
        beforeExecute = async () => { seed('{new-corrupt-value'); beforeExecute = null; };
        await expect(journal.persistCheckoutDraft(draft())).rejects.toThrow('invalid');
        expect(db.prepare('SELECT value FROM settings').get()!.value).toBe('{new-corrupt-value');
        expect(executeCount).toBe(1);
    });

    it('accepts a simultaneously committed identical revision as an idempotent success', async () => {
        beforeExecute = async (_sql, params) => { seed(params[1]); beforeExecute = null; };
        await expect(journal.persistCheckoutDraft(draft())).resolves.toBeUndefined();
        expect(stored()!.draft).toEqual(draft());
        expect(executeCount).toBe(1);
    });

    it('rejects a conflicting tied revision without overwriting it', async () => {
        beforeExecute = async (_sql, params) => {
            const incoming = JSON.parse(params[1]);
            seed(JSON.stringify({ ...incoming, draft: null }));
            beforeExecute = null;
        };
        await expect(journal.persistCheckoutDraft(draft())).rejects.toThrow('invalid');
        expect(stored()!.draft).toBeNull();
        expect(executeCount).toBe(1);
    });

    it('retries a valid changed baseline rather than losing a newer pending edit', async () => {
        beforeExecute = async () => {
            seed(JSON.stringify({ version: 1, revision: 1, draft: null }));
            beforeExecute = null;
        };
        await journal.persistCheckoutDraft(draft());
        expect(stored()!.draft).toEqual(draft());
        expect(executeCount).toBe(2);
    });

    it('bounds repeated CAS contention and retains its mirror for a healthy retry', async () => {
        beforeExecute = async () => { seed(JSON.stringify({ version: 1, revision: executeCount, draft: null })); };
        await expect(journal.persistCheckoutDraft(draft())).rejects.toThrow('changed repeatedly');
        expect(executeCount).toBe(8);
        expect(JSON.parse(mirror.get(journal.CHECKOUT_DRAFT_KEY)!).draft).toEqual(draft());
        beforeExecute = null;
        await expect(journal.persistCheckoutDraft(draft())).resolves.toBeUndefined();
        expect(stored()!.draft).toEqual(draft());
    });
});
