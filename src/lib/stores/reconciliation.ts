/** Timestamp deltas are a latency optimisation, not a proof of completeness.
 * Sweep primary keys in small resumable pages to recover late commits and gaps
 * in AUTO_INCREMENT change-log visibility without redownloading unchanged rows.
 */
export interface ReconciliationCheckpoint { table: number; after: string | null }
export interface VersionRow { rowId: string; updatedAt: string }
export function readReconciliationCheckpoint(value: string | undefined, tableCount: number): ReconciliationCheckpoint {
    try {
        const parsed = JSON.parse(value || '{}');
        if (Number.isInteger(parsed.table) && parsed.table >= 0 && parsed.table < tableCount
            && (parsed.after === null || typeof parsed.after === 'string')) return parsed;
    } catch { /* An older or interrupted checkpoint starts a safe fresh pass. */ }
    return { table: 0, after: null };
}
export async function reconcileVersionPage(
    checkpoint: ReconciliationCheckpoint,
    tables: readonly string[],
    dependencies: {
        versions(table: string, after: string | null, limit: number): Promise<VersionRow[]>;
        repair(table: string, versions: VersionRow[]): Promise<number>;
        checkpoint(next: ReconciliationCheckpoint): Promise<void>;
    },
    limit = 500,
): Promise<number> {
    const table = tables[checkpoint.table];
    if (!table) throw new Error('Invalid reconciliation table');
    const rows = await dependencies.versions(table, checkpoint.after, limit);
    const last = rows.at(-1)?.rowId;
    if (last && last === checkpoint.after) throw new Error('Reconciliation cursor did not advance');
    const changed = await dependencies.repair(table, rows);
    // Never move past an un-applied page. A lost checkpoint merely repeats it.
    await dependencies.checkpoint(rows.length < limit
        ? { table: (checkpoint.table + 1) % tables.length, after: null }
        : { table: checkpoint.table, after: last! });
    return changed;
}
