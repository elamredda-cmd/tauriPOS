import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

// This is a one-time, private, same-Mac mock-data clone. It never opens the
// original database writable and never copies provider/OS secret files.
const source = '/Users/elamreda/Library/Application Support/com.elamreda.tauri-app/pos.db';
const directory = '/Users/elamreda/Library/Application Support/com.elamreda.tauri-app.native-qa';
const destination = path.join(directory, 'pos.db');
if (process.argv[2] !== '--apply') {
  console.log(JSON.stringify({ action: 'dry-run', source: 'current mock POS SQLite', destination, copiesSecretFiles: false }));
  process.exit(0);
}
if (fs.existsSync(directory)) throw new Error('QA profile already exists; refuse to overwrite it.');
if (fs.lstatSync(source).isSymbolicLink()) throw new Error('Refuse an unexpected source symlink.');
fs.mkdirSync(directory, { mode: 0o700 });
execFileSync('sqlite3', ['-readonly', source, `.backup "${destination}"`], { stdio: 'pipe' });
fs.chmodSync(destination, 0o600);
if (fs.realpathSync(destination) === fs.realpathSync(source)
    || fs.statSync(destination).ino === fs.statSync(source).ino) {
  throw new Error('QA profile must be a distinct database.');
}
const db = new DatabaseSync(destination);
try {
  db.exec('BEGIN IMMEDIATE');
  // Remove connection/pairing settings without reading or printing their values.
  db.exec(`DELETE FROM settings WHERE key = 'mysql_config'
    OR key LIKE 'owner_cloud_%' OR key LIKE '%api_key%'
    OR key LIKE '%secret%' OR key LIKE '%password%'
    OR key LIKE '%token%' OR key LIKE '%pairing%'
    OR key LIKE 'cctv_pos_%' OR key LIKE 'receipt_printer_%'
    OR key LIKE 'label_printer_%' OR key LIKE 'cash_drawer_%'
    OR key LIKE 'scale_device_%' OR key LIKE 'scale_port%';`);
  const stamp = new Date().toISOString();
  const set = db.prepare(`INSERT INTO settings(key,value,updatedAt) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updatedAt=excluded.updatedAt`);
  for (const [key, value] of Object.entries({
    pos_mode: 'single',
    device_operating_mode: 'checkout',
    till_name: 'Native QA Till',
    owner_cloud_enabled: 'false',
    cctv_pos_enabled: 'false',
    automatic_setup_backup_enabled: 'false',
    backup_directory: path.join(directory, 'backups'),
    automatic_setup_backup_directory: path.join(directory, 'backups'),
    receipt_printer_enabled: 'false',
    receipt_printer_auto_print_after_payment: 'false',
    receipt_printer_open_drawer_after_payment: 'false',
    label_printer_enabled: 'false',
    cash_drawer_enabled: 'false'
  })) set.run(key, value, stamp);
  const pending = db.prepare(`SELECT
    (SELECT COUNT(*) FROM _offline_queue) +
    (SELECT COUNT(*) FROM _online_financial_intent) +
    (SELECT COUNT(*) FROM payment_terminal_attempts WHERE status IN
      ('prepared','started','uncertain','approved','commit_failed','completion_pending')) AS count`).get();
  if (Number(pending.count) !== 0) throw new Error('Source has unresolved work; do not launch this clone.');
  db.exec('COMMIT');
  console.log(JSON.stringify({ action: 'prepared', destination, standalone: true, networkSettingsRemoved: true, secretFilesCopied: false }));
} catch (error) {
  try { db.exec('ROLLBACK'); } catch { /* preserve the private failed clone */ }
  throw error;
} finally {
  db.close();
}
