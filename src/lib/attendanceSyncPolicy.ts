export type AttendanceBulkPushPolicy = 'controlled-import' | 'preserve-remote';
export type BulkPushTableAction = 'generic' | 'paired-staff-attendance-audit' | 'skip';

/**
 * Controlled imports own the destination (empty bootstrap/explicit migration).
 * Ordinary repair pushes must never roll an authoritative employee or
 * attendance row back to an older local cache version.
 */
export function bulkPushTableAction(
    table: string,
    policy: AttendanceBulkPushPolicy,
): BulkPushTableAction {
    if (policy === 'controlled-import') {
        if (table === 'employees') return 'paired-staff-attendance-audit';
        if (table === 'employee_attendance' || table === 'audit_logs') return 'skip';
        return 'generic';
    }
    if (['employees', 'employee_attendance', 'audit_logs',
        'customers', 'customer_accounts', 'customer_account_entries', 'loyalty_logs'].includes(table)) {
        // A repair upload is not a financial restore. Even a complete local
        // customer row or ledger can be older than another till's changes.
        return 'skip';
    }
    return 'generic';
}

export function bulkPushSettingAllowed(
    key: string,
    policy: AttendanceBulkPushPolicy,
): boolean {
    // Role permissions are authorization state, not repairable presentation
    // data. An ordinary Force Push must not restore a stale privilege set.
    return policy !== 'preserve-remote' || key.trim().toLowerCase() !== 'role_permissions';
}

/**
 * Resume a same-owner controlled import before migration preflight. A completed
 * retry must run the identical local bookkeeping path and then stop; recounting
 * the now-populated server would incorrectly report the successful retry as a
 * conflicting migration.
 */
export async function completeRecoveredControlledImport(
    recover: () => Promise<boolean>,
    completeLocalBookkeeping: () => Promise<void>,
): Promise<boolean> {
    if (!await recover()) return false;
    await completeLocalBookkeeping();
    return true;
}

export const LEGACY_STAFF_QUEUE_CONFLICT_REASON =
    'LEGACY_STAFF_QUEUE_QUARANTINED: this pre-upgrade staff or attendance write was not replayed because MariaDB authorization and attendance are authoritative';

function sqliteJsonTextIdIsResolvable(jsonSql: string): string {
    const id = `JSON_EXTRACT(${jsonSql}, '$.id')`;
    // SQLite does not promise boolean short-circuiting. CASE is required so
    // JSON_TYPE/JSON_EXTRACT never evaluate a malformed legacy payload.
    return `CASE WHEN COALESCE(JSON_VALID(${jsonSql}), 0) = 1 THEN
              CASE WHEN COALESCE(JSON_TYPE(${jsonSql}, '$.id'), '') = 'text'
                         AND TRIM(COALESCE(${id}, '')) <> ''
                         AND ${id} = TRIM(${id})
                   THEN 1 ELSE 0 END
            ELSE 0 END = 1`;
}

function sqliteJsonTextIdIsUnresolvable(jsonSql: string): string {
    return `NOT (${sqliteJsonTextIdIsResolvable(jsonSql)})`;
}

/**
 * Permanent SQLite guards prevent a legacy generic attendance outbox row from
 * ever reaching MariaDB. The final no-op UPDATE atomically routes all existing
 * rows through the UPDATE trigger during upgrade.
 */
export function attendanceQueueQuarantineSql(): string[] {
    const newId = `JSON_EXTRACT(NEW.data, '$.id')`;
    const resolvableNewId = sqliteJsonTextIdIsResolvable('NEW.data');
    const unresolvableNewId = sqliteJsonTextIdIsUnresolvable('NEW.data');
    const conflictId = `JSON_EXTRACT(data, '$.id')`;
    const resolvableConflictId = sqliteJsonTextIdIsResolvable('data');
    const unresolvableConflictId = sqliteJsonTextIdIsUnresolvable('data');
    const body = `
        INSERT OR REPLACE INTO _sync_conflicts
            (id, table_name, operation, data, reason, created_at)
        VALUES (
            NEW.id, NEW.table_name, NEW.operation,
            CASE
              WHEN NEW.table_name = 'employees' THEN
                CASE WHEN ${resolvableNewId}
                     THEN JSON_OBJECT('id', ${newId})
                     ELSE '{}' END
              ELSE NEW.data
            END,
            '${LEGACY_STAFF_QUEUE_CONFLICT_REASON}',
            COALESCE(NULLIF(NEW.created_at, ''), CURRENT_TIMESTAMP)
        );
        DELETE FROM employee_attendance
         WHERE NEW.table_name = 'employee_attendance'
           AND (${unresolvableNewId} OR id = ${newId});
        UPDATE employees
           SET isActive = 0, pin = '', pinHash = 'reset-required', updatedAt = ''
         WHERE NEW.table_name = 'employees'
           AND (${unresolvableNewId} OR id = ${newId});
        DELETE FROM settings
         WHERE (NEW.table_name = 'employee_attendance' AND key = 'sync_ts_employee_attendance')
            OR (NEW.table_name = 'employees' AND key = 'sync_ts_employees');
        DELETE FROM _offline_queue WHERE id = NEW.id;`;
    return [
        `DROP TRIGGER IF EXISTS quarantine_attendance_queue_insert_v1`,
        `DROP TRIGGER IF EXISTS quarantine_attendance_queue_update_v1`,
        `DROP TRIGGER IF EXISTS quarantine_attendance_queue_upgrade_v1`,
        `DROP TRIGGER IF EXISTS quarantine_attendance_queue_insert_v2`,
        `DROP TRIGGER IF EXISTS quarantine_attendance_queue_update_v2`,
        `DROP TRIGGER IF EXISTS quarantine_attendance_queue_upgrade_v2`,
        `DROP TRIGGER IF EXISTS quarantine_attendance_queue_insert_v3`,
        `DROP TRIGGER IF EXISTS quarantine_attendance_queue_update_v3`,
        `DROP TRIGGER IF EXISTS quarantine_attendance_queue_upgrade_v3`,
        `DROP TRIGGER IF EXISTS quarantine_attendance_queue_insert_v4`,
        `DROP TRIGGER IF EXISTS quarantine_attendance_queue_update_v4`,
        `DROP TRIGGER IF EXISTS quarantine_attendance_queue_upgrade_v4`,
        `CREATE TRIGGER IF NOT EXISTS quarantine_attendance_queue_insert_v5
         AFTER INSERT ON _offline_queue
         WHEN NEW.table_name IN ('employees', 'employee_attendance')
         BEGIN ${body} END`,
        `CREATE TRIGGER IF NOT EXISTS quarantine_attendance_queue_update_v5
         AFTER UPDATE ON _offline_queue
         WHEN NEW.table_name IN ('employees', 'employee_attendance')
         BEGIN ${body} END`,
        `CREATE TRIGGER IF NOT EXISTS quarantine_attendance_queue_upgrade_v5
         AFTER INSERT ON settings
         WHEN NEW.key = 'migration_legacy_staff_queue_quarantine_v5'
         BEGIN
           DELETE FROM employee_attendance
            WHERE EXISTS (
              SELECT 1 FROM _sync_conflicts
               WHERE table_name = 'employee_attendance'
                 AND reason LIKE 'LEGACY_STAFF_QUEUE_QUARANTINED:%'
                 AND ${unresolvableConflictId}
            ) OR id IN (
              SELECT ${conflictId}
                FROM _sync_conflicts
               WHERE table_name = 'employee_attendance'
                 AND reason LIKE 'LEGACY_STAFF_QUEUE_QUARANTINED:%'
                 AND ${resolvableConflictId}
            );
           UPDATE employees
              SET isActive = 0, pin = '', pinHash = 'reset-required', updatedAt = ''
            WHERE EXISTS (
              SELECT 1 FROM _sync_conflicts
               WHERE table_name = 'employees'
                 AND reason LIKE 'LEGACY_STAFF_QUEUE_QUARANTINED:%'
                 AND ${unresolvableConflictId}
            ) OR id IN (
              SELECT ${conflictId}
                FROM _sync_conflicts
               WHERE table_name = 'employees'
                 AND reason LIKE 'LEGACY_STAFF_QUEUE_QUARANTINED:%'
                 AND ${resolvableConflictId}
            );
           UPDATE _sync_conflicts
              SET data = CASE WHEN ${resolvableConflictId}
                              THEN JSON_OBJECT('id', ${conflictId})
                              ELSE '{}' END
            WHERE table_name = 'employees'
              AND reason LIKE 'LEGACY_STAFF_QUEUE_QUARANTINED:%';
           UPDATE _offline_queue
              SET table_name = table_name
            WHERE table_name IN ('employees', 'employee_attendance');
           DELETE FROM settings
            WHERE key IN ('sync_ts_employee_attendance', 'sync_ts_employees');
         END`,
        `INSERT OR IGNORE INTO settings (key, value, updatedAt)
         VALUES ('migration_legacy_staff_queue_quarantine_v5', '1', CURRENT_TIMESTAMP)`,
        `DROP TRIGGER IF EXISTS quarantine_attendance_queue_upgrade_v5`,
    ];
}
