import { describe, expect, it, vi } from 'vitest';

import {
    findStrongLegacySharedDataProof,
    type ReadOnlySqlDatabase,
} from './databaseIdentity';

const TILL_ID = 'ecf68d35-bb55-4c87-9749-d5cf20e1969c';
const ORDER_ID = 'f23086a1-a71c-4c4d-a6c8-d325aabbe210';

function database(
    handler: (sql: string, params: unknown[]) => any[],
): ReadOnlySqlDatabase & { select: ReturnType<typeof vi.fn> } {
    const select = vi.fn(async (sql: string, params: unknown[] = []) => handler(sql, params));
    return { select } as unknown as ReadOnlySqlDatabase & { select: typeof select };
}

function columns(...names: string[]) {
    return names.map((columnName) => ({ columnName }));
}

describe('legacy multi-till identity proof', () => {
    it('accepts a nontrivial local till UUID already registered on both sides', async () => {
        const local = database((sql) => {
            if (sql.includes("key = 'till_id'")) return [{ value: TILL_ID }];
            if (sql.includes('COUNT(*) AS count FROM registers')) return [{ count: 1 }];
            if (sql.includes('FROM registers')) return [{ id: TILL_ID }];
            return [];
        });
        const remote = database((sql) => {
            if (sql.includes('INFORMATION_SCHEMA.COLUMNS') && sql.includes('TABLE_NAME = ?')) {
                return columns('id');
            }
            if (sql.includes('FROM registers')) return [{ id: TILL_ID }];
            return [];
        });

        await expect(findStrongLegacySharedDataProof(local, remote))
            .resolves.toBe('registered_till');
        expect(local.select.mock.calls.some(([sql]) => String(sql).includes('FROM orders'))).toBe(false);
    });

    it('does not trust a trivial till name or a remote register alone', async () => {
        const local = database((sql) => {
            if (sql.includes("key = 'till_id'")) return [{ value: 'Till 1' }];
            return [];
        });
        const remote = database((sql, params) => {
            if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) {
                return params[0] === 'registers' ? columns('id') : [];
            }
            if (sql.includes('FROM registers')) return [{ id: 'Till 1' }];
            return [];
        });

        await expect(findStrongLegacySharedDataProof(local, remote)).resolves.toBeNull();
    });

    it('requires a populated local register list to contain the current till UUID', async () => {
        const local = database((sql) => {
            if (sql.includes("key = 'till_id'")) return [{ value: TILL_ID }];
            if (sql.includes('COUNT(*) AS count FROM registers')) return [{ count: 2 }];
            if (sql.includes('FROM registers')) return [];
            return [];
        });
        const remote = database((sql, params) => {
            if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) {
                return params[0] === 'registers' ? columns('id') : [];
            }
            if (sql.includes('FROM registers')) return [{ id: TILL_ID }];
            return [];
        });

        await expect(findStrongLegacySharedDataProof(local, remote)).resolves.toBeNull();
    });

    it('falls back to an exact shared completed-order fingerprint', async () => {
        const order = {
            id: ORDER_ID,
            status: 'completed',
            orderNumber: 1042,
            total: 1375,
            completedAt: '2026-07-20T12:34:56.000Z',
            receiptKey: 'receipt-1042',
        };
        const local = database((sql) => {
            if (sql.includes("key = 'till_id'")) return [];
            if (sql.includes('FROM orders')) return [order];
            return [];
        });
        const remote = database((sql, params) => {
            if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) {
                return params[0] === 'orders'
                    ? columns('id', 'status', 'orderNumber', 'total', 'completedAt', 'receiptKey')
                    : [];
            }
            if (sql.includes('FROM orders')) return [order];
            return [];
        });

        await expect(findStrongLegacySharedDataProof(local, remote))
            .resolves.toBe('shared_completed_order');
    });

    it('rejects a shared order ID when any financial fingerprint field differs', async () => {
        const localOrder = {
            id: ORDER_ID,
            status: 'completed',
            orderNumber: 1042,
            total: 1375,
            completedAt: '2026-07-20T12:34:56.000Z',
            receiptKey: 'receipt-1042',
        };
        const local = database((sql) => sql.includes('FROM orders') ? [localOrder] : []);
        const remote = database((sql, params) => {
            if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) {
                return params[0] === 'orders'
                    ? columns('id', 'status', 'orderNumber', 'total', 'completedAt', 'receiptKey')
                    : [];
            }
            if (sql.includes('FROM orders')) return [{ ...localOrder, total: 1376 }];
            return [];
        });

        await expect(findStrongLegacySharedDataProof(local, remote)).resolves.toBeNull();
    });
});
