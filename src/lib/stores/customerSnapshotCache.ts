import type { Customer } from './db';

export interface CustomerSnapshotCacheDatabase {
    select<T>(sql: string, values?: unknown[]): Promise<T>;
    execute(sql: string, values?: unknown[]): Promise<unknown>;
}

const PROFILE_FIELDS = ['name', 'phone', 'email', 'postcode', 'loyaltyCode', 'notes'] as const;
const SNAPSHOT_FIELDS = [...PROFILE_FIELDS, 'loyaltyPoints', 'createdAt', 'updatedAt'] as const;

function timestamp(value: unknown): number | null {
    const text = String(value ?? '').trim();
    if (!text) return null;
    // The database clock is UTC. Older rows may use a SQL-style UTC timestamp
    // without Z; do not accidentally interpret it in the till's local timezone.
    const utc = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)
        ? `${text.replace(' ', 'T')}Z` : text;
    const parsed = Date.parse(utc);
    return Number.isFinite(parsed) ? parsed : null;
}

/** SQL six-digit fractions and JavaScript three-digit fractions compare alike.
 * An unversioned incoming read must never replace an existing versioned row.
 */
export function isCustomerSnapshotOlder(candidate: Partial<Customer>, existing: Partial<Customer> | null | undefined): boolean {
    if (!existing) return false;
    const incomingTime = timestamp(candidate.updatedAt);
    const currentTime = timestamp(existing.updatedAt);
    if (incomingTime === null) return true;
    return currentTime !== null && incomingTime < currentTime;
}

/** Cache a read without letting its latency overwrite a newer local update.
 * Values in the WHERE are the exact raw row read, not normalized form values.
 * Equal-version disagreements are deliberately left alone: without a revision
 * counter they cannot safely be ordered. The dialog may still show its live read.
 */
export async function cacheCustomerSnapshot(
    db: CustomerSnapshotCacheDatabase,
    remote: Customer,
): Promise<Customer | null> {
    const id = String(remote.id ?? '').trim();
    if (!id || id !== remote.id) throw new Error('Customer snapshot ID is invalid');
    if (!Number.isSafeInteger(remote.loyaltyPoints)) throw new Error('Customer snapshot points are invalid');
    const incomingTime = timestamp(remote.updatedAt);
    const read = async () => (await db.select<Customer[]>('SELECT * FROM customers WHERE id = ? LIMIT 1', [id]))[0] ?? null;
    const current = await read();
    if (incomingTime === null || isCustomerSnapshotOlder(remote, current)) return read();
    if (current && timestamp(current.updatedAt) === incomingTime) return read();

    const values = SNAPSHOT_FIELDS.map(field => remote[field] ?? null);
    // A concurrent tombstone must not permit a late snapshot to recreate a
    // deleted customer, even when the original cache read found no row.
    const notDeleted = `NOT EXISTS (SELECT 1 FROM tombstones WHERE table_name = 'customers' AND row_id = ?)`;
    if (!current) {
        await db.execute(
            `INSERT OR IGNORE INTO customers (id, ${SNAPSHOT_FIELDS.join(', ')})
             SELECT ${['?', ...SNAPSHOT_FIELDS.map(() => '?')].join(', ')} WHERE ${notDeleted}`,
            [id, ...values, id],
        );
    } else {
        await db.execute(
            `UPDATE customers SET ${SNAPSHOT_FIELDS.map(field => `${field} = ?`).join(', ')}
             WHERE id = ? AND ${SNAPSHOT_FIELDS.map(field => `${field} IS ?`).join(' AND ')} AND ${notDeleted}`,
            [...values, id, ...SNAPSHOT_FIELDS.map(field => current[field] ?? null), id],
        );
    }
    // A failed CAS means another writer won. Return its actual row, never the
    // submitted snapshot or our earlier read. Missing rows remain missing.
    return read();
}
