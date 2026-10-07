import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Customer } from './db';
import { cacheCustomerSnapshot, isCustomerSnapshotOlder, type CustomerSnapshotCacheDatabase } from './customerSnapshotCache';

const first = '2026-09-09T12:00:00.100Z';
const second = '2026-09-09T12:00:00.200Z';
const third = '2026-09-09T12:00:00.300Z';
function customer(patch: Partial<Customer> = {}): Customer {
    return { id: 'customer-1', name: 'Customer', phone: '', email: '', postcode: '', loyaltyCode: '', notes: '',
        loyaltyPoints: 10, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: first, ...patch };
}

describe('customer snapshot timestamp comparison', () => {
    it('compares UTC instants, not fractional-string lengths or timezone spellings', () => {
        const current = customer();
        expect(isCustomerSnapshotOlder(customer({ updatedAt: '2026-09-09T12:00:00.100000Z' }), current)).toBe(false);
        expect(isCustomerSnapshotOlder(customer({ updatedAt: '2026-09-09T13:00:00.100+01:00' }), current)).toBe(false);
        expect(isCustomerSnapshotOlder(customer({ updatedAt: '2026-09-09 12:00:00.099' }), current)).toBe(true);
        expect(isCustomerSnapshotOlder(customer({ updatedAt: second }), current)).toBe(false);
    });

    it('does not let an unknown incoming version replace an existing row', () => {
        expect(isCustomerSnapshotOlder(customer({ updatedAt: '' }), customer())).toBe(true);
        expect(isCustomerSnapshotOlder(customer({ updatedAt: 'invalid' }), customer())).toBe(true);
        expect(isCustomerSnapshotOlder(customer(), null)).toBe(false);
    });
});

describe('customer cache atomic compare-and-swap (in-memory SQLite)', () => {
    let sqlite: DatabaseSync;
    let db: CustomerSnapshotCacheDatabase;
    let race: (() => void) | null;
    let writes: string[];
    function insert(value: Customer) {
        const fields = ['id', 'name', 'phone', 'email', 'postcode', 'loyaltyCode', 'notes', 'loyaltyPoints', 'createdAt', 'updatedAt'] as const;
        sqlite.prepare(`INSERT INTO customers (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`)
            .run(...fields.map(field => value[field] ?? null));
    }
    beforeEach(() => {
        sqlite = new DatabaseSync(':memory:');
        sqlite.exec(`CREATE TABLE customers (id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT, email TEXT, postcode TEXT,
            loyaltyCode TEXT, notes TEXT, loyaltyPoints INTEGER DEFAULT 0, createdAt TEXT, updatedAt TEXT);
            CREATE TABLE tombstones (table_name TEXT, row_id TEXT);`);
        writes = []; race = null;
        db = {
            async select<T>(sql: string, values: unknown[] = []) { return sqlite.prepare(sql).all(...values as any[]) as T; },
            async execute(sql: string, values: unknown[] = []) {
                const beforeWrite = race; race = null; beforeWrite?.();
                writes.push(sql);
                return sqlite.prepare(sql).run(...values as any[]);
            },
        };
    });
    afterEach(() => sqlite.close());

    it('inserts a missing versioned customer without importing account summary fields', async () => {
        const result = await cacheCustomerSnapshot(db, customer({ accountBalancePence: 12345 }));
        expect(result).toEqual(customer());
        expect(writes[0]).toContain('INSERT OR IGNORE');
        expect(writes[0]).not.toContain('accountBalancePence');
    });

    it('applies a strictly newer absolute balance and profile', async () => {
        insert(customer());
        const remote = customer({ loyaltyPoints: -5, name: 'Updated', updatedAt: second });
        expect(await cacheCustomerSnapshot(db, remote)).toEqual(remote);
        expect(writes[0]).toContain('UPDATE customers');
    });

    it('preserves newer local data and equal-millisecond conflicting values', async () => {
        insert(customer({ loyaltyPoints: 30, updatedAt: second }));
        expect((await cacheCustomerSnapshot(db, customer()))?.loyaltyPoints).toBe(30);
        expect((await cacheCustomerSnapshot(db, customer({ loyaltyPoints: 20, updatedAt: '2026-09-09T12:00:00.200000Z' })))?.loyaltyPoints).toBe(30);
        expect(writes).toEqual([]);
    });

    it('never overwrites a newer balance arriving after the initial read', async () => {
        insert(customer());
        race = () => { sqlite.prepare('UPDATE customers SET loyaltyPoints = 30, updatedAt = ?').run(third); };
        expect((await cacheCustomerSnapshot(db, customer({ loyaltyPoints: 20, updatedAt: second })))?.loyaltyPoints).toBe(30);
    });

    it('protects a points change even if the racing writer leaves the timestamp unchanged', async () => {
        insert(customer());
        race = () => { sqlite.exec('UPDATE customers SET loyaltyPoints = 35'); };
        const result = await cacheCustomerSnapshot(db, customer({ loyaltyPoints: 20, updatedAt: second }));
        expect(result?.loyaltyPoints).toBe(35);
        expect(result?.updatedAt).toBe(first);
    });

    it('protects a same-timestamp profile edit using exact raw field values', async () => {
        insert(customer());
        race = () => { sqlite.exec("UPDATE customers SET phone = ' 12345 '"); };
        expect((await cacheCustomerSnapshot(db, customer({ phone: '67890', updatedAt: second })))?.phone).toBe(' 12345 ');
    });

    it('does not replace a customer inserted concurrently', async () => {
        race = () => insert(customer({ name: 'Concurrent creation', loyaltyPoints: 90, updatedAt: third }));
        expect((await cacheCustomerSnapshot(db, customer({ updatedAt: second })))?.loyaltyPoints).toBe(90);
    });

    it('does not reinsert a customer deleted between read and conditional update', async () => {
        insert(customer());
        race = () => { sqlite.exec('DELETE FROM customers'); };
        expect(await cacheCustomerSnapshot(db, customer({ updatedAt: second }))).toBeNull();
    });

    it('does not resurrect a missing customer when its tombstone arrives during the request', async () => {
        race = () => { sqlite.prepare('INSERT INTO tombstones VALUES (?, ?)').run('customers', 'customer-1'); };
        expect(await cacheCustomerSnapshot(db, customer())).toBeNull();
    });

    it('handles legacy nullable profile fields without changing the CAS comparison', async () => {
        insert(customer());
        sqlite.exec('UPDATE customers SET phone = NULL, notes = NULL');
        const remote = customer({ phone: '123', updatedAt: second });
        expect(await cacheCustomerSnapshot(db, remote)).toEqual(remote);
    });
});
