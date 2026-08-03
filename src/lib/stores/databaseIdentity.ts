export interface ReadOnlySqlDatabase {
    select<T = any[]>(sql: string, params?: unknown[]): Promise<T>;
}

export type LegacySharedDataProof = 'registered_till' | 'shared_completed_order' | null;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMPLETED_ORDER_STATUSES = new Set([
    'completed',
    'refunded',
    'partially_refunded',
    'voided',
]);

function normalizedUuid(value: unknown): string {
    const candidate = String(value || '').trim().toLowerCase();
    return UUID_PATTERN.test(candidate) ? candidate : '';
}

async function remoteTableColumns(
    remote: ReadOnlySqlDatabase,
    table: string,
): Promise<Set<string>> {
    const rows = await remote.select<Array<{ columnName?: string; COLUMN_NAME?: string }>>(
        `SELECT COLUMN_NAME AS columnName
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
        [table],
    );
    return new Set(rows.map((row) => String(row.columnName || row.COLUMN_NAME || '')).filter(Boolean));
}

function completedOrderFingerprint(row: any, includeReceiptKey: boolean): string {
    const id = normalizedUuid(row?.id);
    const status = String(row?.status || '').trim().toLowerCase();
    const completedAt = String(row?.completedAt || '').trim();
    const orderNumber = Number(row?.orderNumber);
    const total = Number(row?.total);
    if (!id || !COMPLETED_ORDER_STATUSES.has(status) || completedAt.length < 10
        || !Number.isSafeInteger(orderNumber) || orderNumber <= 0
        || !Number.isSafeInteger(total)) return '';
    const values: Array<string | number> = [id, status, orderNumber, total, completedAt];
    if (includeReceiptKey) values.push(String(row?.receiptKey || '').trim());
    return JSON.stringify(values);
}

/**
 * Read-only proof for installations that predate app_identity. Display names
 * are deliberately excluded: adoption requires either this till's random UUID
 * already registered on the server or an exact shared completed transaction.
 */
export async function findStrongLegacySharedDataProof(
    local: ReadOnlySqlDatabase,
    remote: ReadOnlySqlDatabase,
): Promise<LegacySharedDataProof> {
    const tillRows = await local.select<Array<{ value?: string }>>(
        `SELECT value FROM settings WHERE key = 'till_id' LIMIT 1`,
    );
    const tillId = normalizedUuid(tillRows[0]?.value);
    if (tillId) {
        const registerColumns = await remoteTableColumns(remote, 'registers');
        if (registerColumns.has('id')) {
            const [localRegisterCounts, localRegisterRows, remoteRegisterRows] = await Promise.all([
                local.select<Array<{ count: number }>>(`SELECT COUNT(*) AS count FROM registers`),
                local.select<Array<{ id: string }>>(
                    `SELECT id FROM registers WHERE LOWER(TRIM(id)) = ? LIMIT 1`,
                    [tillId],
                ),
                remote.select<Array<{ id: string }>>(
                    `SELECT id FROM registers WHERE LOWER(TRIM(id)) = ? LIMIT 1`,
                    [tillId],
                ),
            ]);
            const localRegistersPresent = Number(localRegisterCounts[0]?.count || 0) > 0;
            const localRegisterMatches = !localRegistersPresent
                || normalizedUuid(localRegisterRows[0]?.id) === tillId;
            const remoteRegisterMatches = normalizedUuid(remoteRegisterRows[0]?.id) === tillId;
            if (localRegisterMatches && remoteRegisterMatches) return 'registered_till';
        }
    }

    const orderColumns = await remoteTableColumns(remote, 'orders');
    const requiredOrderColumns = ['id', 'status', 'orderNumber', 'total', 'completedAt'];
    if (!requiredOrderColumns.every((column) => orderColumns.has(column))) return null;

    const localOrders = await local.select<any[]>(`
        SELECT id, status, orderNumber, total, completedAt, receiptKey
        FROM orders
        WHERE status IN ('completed', 'refunded', 'partially_refunded', 'voided')
          AND TRIM(COALESCE(completedAt, '')) <> ''
        ORDER BY completedAt DESC, id DESC
        LIMIT 25
    `);
    const candidateOrders = localOrders.filter((row) => completedOrderFingerprint(row, false));
    if (candidateOrders.length === 0) return null;

    const includeReceiptKey = orderColumns.has('receiptKey');
    const candidateIds = candidateOrders.map((row) => normalizedUuid(row.id));
    const placeholders = candidateIds.map(() => '?').join(', ');
    const remoteOrders = await remote.select<any[]>(`
        SELECT id, status, orderNumber, total, completedAt${includeReceiptKey ? ', receiptKey' : ''}
        FROM orders
        WHERE id IN (${placeholders})
    `, candidateIds);
    const remoteFingerprints = new Set(
        remoteOrders.map((row) => completedOrderFingerprint(row, includeReceiptKey)).filter(Boolean),
    );
    return candidateOrders.some((row) =>
        remoteFingerprints.has(completedOrderFingerprint(row, includeReceiptKey))
    ) ? 'shared_completed_order' : null;
}
