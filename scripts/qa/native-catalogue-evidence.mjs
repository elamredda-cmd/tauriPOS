/** Read-only assertions for the isolated native QA profile; never opens shop DB. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
function argument(name) {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
}
const requested = argument('--database');
if (!requested || !existsSync(requested)) throw new Error('An existing explicit --database path is required.');
const database = realpathSync(requested);
const directory = path.dirname(database);
if (path.basename(database) !== 'pos.db' || path.basename(directory) !== 'com.elamreda.tauri-app.native-qa') {
    throw new Error('Only the isolated com.elamreda.tauri-app.native-qa/pos.db is allowed.');
}
const prefix = 'qa-native17-20261012';
const sql = `BEGIN;
WITH setting AS (SELECT value FROM settings WHERE key='scale_tile_pages'),
a AS (SELECT entry.value AS productId FROM setting,json_each(setting.value,'$[0].productIds') AS entry),
b AS (SELECT entry.value AS productId FROM setting,json_each(setting.value,'$[1].productIds') AS entry)
SELECT json_object(
    'scale',json_object(
        'pageAId',(SELECT json_extract(value,'$[0].id') FROM setting),
        'pageACount',(SELECT COUNT(*) FROM a),
        'pageAUniqueCount',(SELECT COUNT(DISTINCT productId) FROM a),
        'pageAOriginalRangeCount',(SELECT COUNT(*) FROM a WHERE productId LIKE '${prefix}-product-%' AND CAST(substr(productId,-4) AS INTEGER) BETWEEN 1 AND 100),
        'pageAMissingAssignmentCount',(SELECT COUNT(*) FROM a WHERE productId='${prefix}-unavailable-product'),
        'pageAAdded0104Count',(SELECT COUNT(*) FROM a WHERE productId='${prefix}-product-0104'),
        'pageAForeignPageBCount',(SELECT COUNT(*) FROM a WHERE productId IN ('${prefix}-product-0101','${prefix}-product-0102','${prefix}-product-0103')),
        'pageBId',(SELECT json_extract(value,'$[1].id') FROM setting),
        'pageBCount',(SELECT COUNT(*) FROM b),
        'pageBExpectedUniqueCount',(SELECT COUNT(DISTINCT productId) FROM b WHERE productId IN ('${prefix}-product-0101','${prefix}-product-0102','${prefix}-product-0103'))
    ),
    'settings',json_object(
        'posMode',(SELECT value FROM settings WHERE key='pos_mode'),
        'mysqlConfigRows',(SELECT COUNT(*) FROM settings WHERE key='mysql_config'),
        'stockTrackingEnabled',(SELECT value FROM settings WHERE key='stock_tracking_enabled'),
        'fontFamily',(SELECT value FROM settings WHERE key='ui_font_family')
    ),
    'attendance',json_object(
        'recordCount',(SELECT COUNT(*) FROM employee_attendance),
        'correctionAuditRowsSince20Utc',(SELECT COUNT(*) FROM audit_logs WHERE createdAt>='2026-10-12T20:00:00.000Z' AND (entityType='employee_attendance' OR lower(action) LIKE '%attendance%'))
    ),
    'stock',json_object(
        'countAuditRowsSince20Utc',(SELECT COUNT(*) FROM audit_logs WHERE createdAt>='2026-10-12T20:00:00.000Z' AND action='stock_counted'),
        'fixtureProduct0001Stock',(SELECT stockLevel FROM products WHERE id='${prefix}-product-0001'),
        'fixtureProduct0001Tracking',(SELECT trackStock FROM products WHERE id='${prefix}-product-0001'),
        'fixtureProduct0001PricePence',(SELECT price FROM products WHERE id='${prefix}-product-0001'),
        'fixtureProduct0001PluEmpty',(SELECT CASE WHEN COALESCE(scalePlu,'')='' THEN 1 ELSE 0 END FROM products WHERE id='${prefix}-product-0001')
    ),
    'safety',json_object(
        'queuedMutations',(SELECT COUNT(*) FROM _offline_queue),
        'syncConflicts',(SELECT COUNT(*) FROM _sync_conflicts),
        'onlineFinancialIntents',(SELECT COUNT(*) FROM _online_financial_intent)
    )
) AS evidence;
COMMIT;`;
const rows = JSON.parse(execFileSync('sqlite3', ['-readonly','-json',database,sql], { encoding:'utf8', stdio:['ignore','pipe','pipe'] }));
const snapshot = JSON.parse(rows[0].evidence);
const a = snapshot.scale;
snapshot.scale.canonicalPageASaved = a.pageAId === `${prefix}-page-a` && a.pageACount === 102 && a.pageAUniqueCount === 102
    && a.pageAOriginalRangeCount === 100 && a.pageAMissingAssignmentCount === 1 && a.pageAAdded0104Count === 1 && a.pageAForeignPageBCount === 0;
snapshot.scale.pageBUnchanged = a.pageBId === `${prefix}-page-b` && a.pageBCount === 3 && a.pageBExpectedUniqueCount === 3;
snapshot.attendance.baselineRecordCountReportedByController = 8;
snapshot.attendance.baselineCountUnchanged = snapshot.attendance.recordCount === 8;
snapshot.capturedAtUtc = new Date().toISOString();
snapshot.reader = 'SQLite CLI -readonly, explicit BEGIN/COMMIT read snapshot; WAL-aware; no immutable mode';
snapshot.isolatedDatabase = database;

if (args.includes('--providers')) {
    // Root-authorized QA dummy fixtures only. Never serialize configuration or
    // inspect/print API keys: publish exactly the two provider enable flags.
    const readEnabled = filename => {
        const resolved = realpathSync(path.join(directory,filename));
        if (path.dirname(resolved) !== directory) throw new Error('Provider fixture cannot point outside the isolated QA profile.');
        const config = JSON.parse(readFileSync(resolved,'utf8'));
        if (typeof config.enabled !== 'boolean') throw new Error('Provider fixture has no explicit enabled flag.');
        return config.enabled;
    };
    snapshot.providerMetadataOnly = { dojoEnabled:readEnabled('dojo.json'), sumupEnabled:readEnabled('sumup.json') };
    snapshot.providerMetadataOnly.workingProviderPreserved = snapshot.providerMetadataOnly.dojoEnabled === true
        && snapshot.providerMetadataOnly.sumupEnabled === false;
}

const backupArgument = argument('--backup');
if (backupArgument) {
    const backup = realpathSync(backupArgument);
    if (!backup.startsWith(path.join(directory,'backups') + path.sep)) throw new Error('Backup must be inside this isolated profile protected backups folder.');
    const metadata = statSync(backup);
    const integrity = execFileSync('sqlite3',['-readonly',backup,'PRAGMA integrity_check;'], { encoding:'utf8', stdio:['ignore','pipe','pipe'] }).trim();
    const counts = JSON.parse(execFileSync('sqlite3',['-readonly','-json',backup,`SELECT
        (SELECT COUNT(*) FROM products) AS products,
        (SELECT COUNT(*) FROM suppliers) AS suppliers,
        (SELECT COUNT(*) FROM stock_receipts) AS stockReceipts,
        (SELECT COUNT(*) FROM employee_attendance) AS attendance,
        (SELECT value FROM settings WHERE key='ui_font_family') AS fontFamily,
        (SELECT value FROM settings WHERE key='stock_tracking_enabled') AS stockTrackingEnabled;`],
    { encoding:'utf8', stdio:['ignore','pipe','pipe'] }))[0];
    snapshot.backup = { path:backup, exists:true, bytes:metadata.size, modifiedAtUtc:metadata.mtime.toISOString(), integrityCheck:integrity, counts,
        independentFile:metadata.ino !== statSync(database).ino || metadata.dev !== statSync(database).dev };
}
console.log(JSON.stringify(snapshot,null,2));
