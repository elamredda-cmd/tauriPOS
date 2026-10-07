//! Private owner cash declarations. These rows NEVER change a sale, payment,
//! cash movement, shift or report. Corrections append a new immutable revision.
//! Deliberately absent from general sync, transaction purge and report tables.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{DateTime, NaiveDate, SecondsFormat, Timelike, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{
    mysql::MySqlRow,
    sqlite::{SqliteConnectOptions, SqliteRow},
    Connection, MySqlConnection, Row, SqliteConnection,
};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::AppHandle;

const AUTH_ERROR: &str = "Cash Control requires an active administrator and a correct fresh PIN.";
const MAX_MONEY: i64 = 9_000_000_000_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CountRequest {
    id: String,
    till_id: String,
    business_date: String,
    period_start: String,
    period_end: String,
    opening_float_amount: i64,
    counted_amount: i64,
    reason: String,
    previous_entry_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CashControlEntry {
    id: String,
    root_id: String,
    previous_entry_id: Option<String>,
    revision: i64,
    till_id: String,
    business_date: String,
    period_start: String,
    period_end: String,
    snapshot_at: String,
    opening_float_amount: i64,
    counted_amount: i64,
    expected_amount: i64,
    variance_amount: i64,
    cash_sales_amount: i64,
    account_cash_amount: i64,
    cash_movement_amount: i64,
    cashback_amount: i64,
    net_cash_amount: i64,
    reason: String,
    employee_id: String,
    employee_name: String,
    created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CashControlContext {
    source: String,
    till_id: String,
    business_date: String,
    period_start: String,
    period_end: String,
    snapshot_at: String,
    cash_sales_amount: i64,
    account_cash_amount: i64,
    cash_movement_amount: i64,
    cashback_amount: i64,
    net_cash_amount: i64,
    can_create: bool,
    blocked_reason: Option<String>,
    entries: Vec<CashControlEntry>,
}

#[derive(Debug, Default, Clone)]
struct CashFlow {
    sales: i64,
    account: i64,
    movements: i64,
    cashback: i64,
}
impl CashFlow {
    fn net(&self) -> Result<i64, String> {
        self.sales
            .checked_add(self.account)
            .and_then(|v| v.checked_add(self.movements))
            .and_then(|v| v.checked_sub(self.cashback))
            .filter(|v| (-MAX_MONEY..=MAX_MONEY).contains(v))
            .ok_or_else(|| "Cash total exceeds the supported range.".into())
    }
}

struct Period {
    start: String,
    end: String,
}

fn till_readiness_issue(
    online: i64,
    protocol: i64,
    outbox: i64,
    terminals: i64,
    conflicts: i64,
) -> Option<String> {
    if online != 1 || protocol < 1 {
        Some("The selected till must be online with a current readiness heartbeat before a new cash snapshot. Open and synchronize that till first.".into())
    } else if outbox != 0 || terminals != 0 || conflicts != 0 {
        Some("The selected till has pending uploads, card recovery or sync conflicts. Resolve these on that till before recording expected cash.".into())
    } else {
        None
    }
}
fn validate_period(date: &str, start: &str, end: &str) -> Result<Period, String> {
    let bad = || {
        "Choose one complete business date with local-midnight bounds and explicit timezone offsets.".to_string()
    };
    let day = NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|_| bad())?;
    if day.to_string() != date {
        return Err(bad());
    }
    let start = DateTime::parse_from_rfc3339(start).map_err(|_| bad())?;
    let end = DateTime::parse_from_rfc3339(end).map_err(|_| bad())?;
    if start.date_naive() != day
        || Some(end.date_naive()) != day.succ_opt()
        || [start.time(), end.time()]
            .iter()
            .any(|time| time.num_seconds_from_midnight() != 0 || time.nanosecond() != 0)
        || !(23 * 3600..=25 * 3600).contains(&(end - start).num_seconds())
    {
        return Err(bad());
    }
    Ok(Period {
        start: start
            .with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Millis, true),
        end: end
            .with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Millis, true),
    })
}

fn equal_bytes(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |diff, (x, y)| diff | (x ^ y)) == 0
}
fn pin_matches(pin: &str, plaintext: &str, hash: &str) -> bool {
    if !(4..=12).contains(&pin.len()) || !pin.bytes().all(|c| c.is_ascii_digit()) {
        return false;
    }
    if hash.starts_with("pbkdf2-sha256$") {
        let parts: Vec<_> = hash.split('$').collect();
        if parts.len() != 4 {
            return false;
        }
        let Ok(iterations) = parts[1].parse::<u32>() else {
            return false;
        };
        if !(100_000..=2_000_000).contains(&iterations) {
            return false;
        }
        let (Ok(salt), Ok(expected)) = (STANDARD.decode(parts[2]), STANDARD.decode(parts[3]))
        else {
            return false;
        };
        if !(16..=64).contains(&salt.len()) || expected.len() != 32 {
            return false;
        }
        let mut actual = [0u8; 32];
        pbkdf2::pbkdf2_hmac::<Sha256>(pin.as_bytes(), &salt, iterations, &mut actual);
        equal_bytes(&actual, &expected)
    } else if hash.is_empty() {
        equal_bytes(pin.as_bytes(), plaintext.as_bytes())
    } else if hash.len() == 64 && hash.bytes().all(|c| c.is_ascii_hexdigit()) {
        let actual = format!("{:x}", Sha256::digest(format!("pos-pin-v1:{pin}")));
        equal_bytes(actual.as_bytes(), hash.to_ascii_lowercase().as_bytes())
    } else {
        false
    }
}

// Process-local native throttle is independent of the renderer's login state.
fn attempts() -> &'static Mutex<HashMap<String, (u8, Instant)>> {
    static STATE: OnceLock<Mutex<HashMap<String, (u8, Instant)>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(HashMap::new()))
}
fn reserve_auth(employee: &str) -> Result<(), String> {
    if employee.is_empty() || employee.len() > 128 {
        return Err(AUTH_ERROR.into());
    }
    let mut states = attempts().lock().map_err(|_| AUTH_ERROR)?;
    states.retain(|_, (_, at)| at.elapsed() < Duration::from_secs(60));
    if states.len() >= 256 && !states.contains_key(employee) {
        return Err("PIN verification is busy; wait one minute.".into());
    }
    let item = states.entry(employee.into()).or_insert((0, Instant::now()));
    if item.0 >= 5 {
        return Err("Too many PIN attempts. Wait one minute before trying again.".into());
    }
    item.0 += 1;
    Ok(())
}

enum Store {
    Local(SqliteConnection),
    Shared(MySqlConnection),
}

/// Reuse the native administrator PIN verification and throttle for payment
/// recovery. The caller supplies its transaction so staff state stays locked.
pub(crate) async fn authenticate_payment_administrator(
    connection: MySqlConnection,
    employee_id: &str,
    pin: &str,
) -> Result<(MySqlConnection, String), String> {
    let mut store = Store::Shared(connection);
    let name = store.authenticate(employee_id, pin).await
        .map_err(|_| "Payment review requires an active administrator and the correct PIN.".to_string())?;
    match store {
        Store::Shared(connection) => Ok((connection, name)),
        _ => unreachable!(),
    }
}
enum DataRow {
    Local(SqliteRow),
    Shared(MySqlRow),
}
impl DataRow {
    fn text(&self, key: &str) -> Result<String, String> {
        match self {
            Self::Local(row) => row.try_get(key).map_err(|e| e.to_string()),
            Self::Shared(row) => match row.try_get::<String, _>(key) {
                Ok(value) => Ok(value),
                // Current MariaDB identifier columns use utf8mb4_bin. SQLx
                // reports VARBINARY/BLOB metadata although their bytes are
                // UTF-8. Preserve exact bytes and reject invalid UTF-8 rather
                // than losing case-sensitive identity or using a lossy decode.
                Err(error) => match row.try_get::<Vec<u8>, _>(key) {
                    Ok(bytes) => String::from_utf8(bytes)
                        .map_err(|_| format!("Cash Control column {key} is not valid UTF-8")),
                    Err(_) => Err(error.to_string()),
                },
            },
        }
    }
    fn int(&self, key: &str) -> Result<i64, String> {
        match self {
            Self::Local(row) => row.try_get(key),
            Self::Shared(row) => row.try_get(key),
        }
        .map_err(|e| e.to_string())
    }
}
impl Store {
    fn source(&self) -> &'static str {
        if matches!(self, Self::Shared(_)) {
            "shared"
        } else {
            "local"
        }
    }
    async fn rows(&mut self, sql: &str, values: &[&str]) -> Result<Vec<DataRow>, String> {
        match self {
            Self::Local(conn) => {
                let mut q = sqlx::query(sql);
                for value in values {
                    q = q.bind(*value);
                }
                q.fetch_all(conn)
                    .await
                    .map(|rows| rows.into_iter().map(DataRow::Local).collect())
            }
            Self::Shared(conn) => {
                let mut q = sqlx::query(sql);
                for value in values {
                    q = q.bind(*value);
                }
                q.fetch_all(conn)
                    .await
                    .map(|rows| rows.into_iter().map(DataRow::Shared).collect())
            }
        }
        .map_err(|e| e.to_string())
    }
    async fn execute(&mut self, sql: &str, values: &[&str]) -> Result<(), String> {
        match self {
            Self::Local(conn) => {
                let mut q = sqlx::query(sql);
                for value in values {
                    q = q.bind(*value);
                }
                q.execute(conn).await.map(|_| ())
            }
            Self::Shared(conn) => {
                let mut q = sqlx::query(sql);
                for value in values {
                    q = q.bind(*value);
                }
                q.execute(conn).await.map(|_| ())
            }
        }
        .map_err(|e| e.to_string())
    }
    async fn scalar(&mut self, sql: &str, values: &[&str]) -> Result<i64, String> {
        self.rows(sql, values)
            .await?
            .first()
            .ok_or("Cash query returned no row")?
            .int("value")
    }
    async fn setting(&mut self, key: &str) -> Result<String, String> {
        self.rows(
            "SELECT COALESCE(value, '') AS value FROM settings WHERE `key` = ?",
            &[key],
        )
        .await?
        .first()
        .map(|row| row.text("value"))
        .transpose()
        .map(|v| v.unwrap_or_default())
    }
    async fn now(&mut self) -> Result<String, String> {
        if matches!(self, Self::Shared(_)) {
            let rows = self
                .rows(
                    "SELECT DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ') AS value",
                    &[],
                )
                .await?;
            let raw = rows[0].text("value")?;
            Ok(DateTime::parse_from_rfc3339(&raw)
                .map_err(|_| "Invalid server time")?
                .with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Millis, true))
        } else {
            Ok(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true))
        }
    }
    async fn ensure_schema(&mut self) -> Result<(), String> {
        if matches!(self, Self::Shared(_)) {
            self.execute("CREATE TABLE IF NOT EXISTS private_cash_control_entries (id VARCHAR(128) COLLATE utf8mb4_bin PRIMARY KEY, tillId VARCHAR(128) COLLATE utf8mb4_bin NOT NULL, businessDate VARCHAR(10) NOT NULL, revision BIGINT NOT NULL, payload LONGTEXT NOT NULL, UNIQUE KEY uq_private_cash_revision (tillId, businessDate, revision)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin", &[]).await?;
            self.execute("CREATE TABLE IF NOT EXISTS private_cash_control_lock (id INT PRIMARY KEY) ENGINE=InnoDB", &[]).await?;
            self.execute(
                "INSERT IGNORE INTO private_cash_control_lock (id) VALUES (1)",
                &[],
            )
            .await?;
            for (name, action) in [
                ("private_cash_no_update", "UPDATE"),
                ("private_cash_no_delete", "DELETE"),
            ] {
                self.execute(&format!("CREATE TRIGGER IF NOT EXISTS {name} BEFORE {action} ON private_cash_control_entries FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Private cash counts are append-only'"), &[]).await?;
            }
        } else {
            self.execute("CREATE TABLE IF NOT EXISTS private_cash_control_entries (id TEXT PRIMARY KEY, tillId TEXT NOT NULL, businessDate TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, UNIQUE(tillId, businessDate, revision))", &[]).await?;
            for (name, action) in [
                ("private_cash_no_update", "UPDATE"),
                ("private_cash_no_delete", "DELETE"),
            ] {
                self.execute(&format!("CREATE TRIGGER IF NOT EXISTS {name} BEFORE {action} ON private_cash_control_entries BEGIN SELECT RAISE(ABORT, 'Private cash counts are append-only'); END"), &[]).await?;
            }
        }
        Ok(())
    }
    async fn begin(&mut self) -> Result<(), String> {
        if matches!(self, Self::Shared(_)) {
            self.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ", &[])
                .await?;
            self.execute("START TRANSACTION", &[]).await?;
            // Same serialization point as financial writes, purge and restore.
            // Lock it before taking the repeatable-read snapshot or employee lock.
            let rows = self
                .rows(
                    "SELECT state FROM pos_close_barrier WHERE id = 1 FOR UPDATE",
                    &[],
                )
                .await?;
            if rows
                .first()
                .map(|r| r.text("state"))
                .transpose()?
                .as_deref()
                != Some("idle")
            {
                return Err("A report close or database maintenance is running. Open Cash Control again afterwards.".into());
            }
            let restoring = self.scalar("SELECT CAST(isActive AS SIGNED) AS value FROM pos_restore_gate WHERE id = 1 FOR UPDATE", &[]).await?;
            if restoring != 0 {
                return Err("Database maintenance is running; Cash Control is unavailable.".into());
            }
            let maintenance = self.setting("restore_maintenance_owner").await?;
            if !maintenance.is_empty() {
                return Err("Database restore is running; Cash Control is unavailable.".into());
            }
            // All private writes serialize before selecting their latest revision.
            // Reads use FOR UPDATE below so this snapshot cannot append to a stale head.
            self.execute(
                "UPDATE private_cash_control_lock SET id = id WHERE id = 1",
                &[],
            )
            .await
        } else {
            self.execute("BEGIN IMMEDIATE", &[]).await
        }
    }
    async fn authenticate(&mut self, employee_id: &str, pin: &str) -> Result<String, String> {
        reserve_auth(employee_id)?;
        let lock = if matches!(self, Self::Shared(_)) {
            " FOR UPDATE"
        } else {
            ""
        };
        let rows = self.rows(&format!("SELECT id, name, COALESCE(pin, '') AS pin, COALESCE(pinHash, '') AS pinHash, role, CAST(COALESCE(isActive, 0) AS SIGNED) AS active FROM employees WHERE id = ?{lock}"), &[employee_id]).await?;
        let Some(row) = rows.first() else {
            return Err(AUTH_ERROR.into());
        };
        if row.text("id")? != employee_id || row.text("role")? != "admin" || row.int("active")? != 1
        {
            return Err(AUTH_ERROR.into());
        }
        let name = row.text("name")?;
        let plain = row.text("pin")?;
        let hash = row.text("pinHash")?;
        let candidate = pin.to_string();
        let valid =
            tauri::async_runtime::spawn_blocking(move || pin_matches(&candidate, &plain, &hash))
                .await
                .map_err(|_| AUTH_ERROR)?;
        if !valid {
            return Err(AUTH_ERROR.into());
        }
        attempts()
            .lock()
            .map_err(|_| AUTH_ERROR)?
            .remove(employee_id);
        Ok(name)
    }
    async fn entries(&mut self, till: &str, date: &str) -> Result<Vec<CashControlEntry>, String> {
        let lock = if matches!(self, Self::Shared(_)) {
            " FOR UPDATE"
        } else {
            ""
        };
        // The table's binary collation makes MariaDB expose LONGTEXT as BLOB
        // metadata. Decode JSON through an explicit UTF-8 character projection.
        let payload = if matches!(self, Self::Shared(_)) {
            "CAST(payload AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci AS payload"
        } else {
            "payload"
        };
        self.rows(&format!("SELECT {payload} FROM private_cash_control_entries WHERE tillId = ? AND businessDate = ? ORDER BY revision DESC{lock}"), &[till,date]).await?.iter().map(|row| serde_json::from_str(&row.text("payload")?).map_err(|_| "Private cash history failed validation; do not overwrite it.".into())).collect()
    }
    async fn validate_till(&mut self, till: &str) -> Result<(), String> {
        if till.trim().is_empty() || till.len() > 128 {
            return Err("Choose a registered till.".into());
        }
        let rows = self
            .rows("SELECT id FROM registers WHERE id = ?", &[till])
            .await?;
        if rows
            .first()
            .map(|row| row.text("id"))
            .transpose()?
            .as_deref()
            != Some(till)
        {
            return Err("This till is not registered in the authoritative database.".into());
        }
        Ok(())
    }
    async fn blocked(
        &mut self,
        till: &str,
        period: &Period,
        now: &str,
    ) -> Result<Option<String>, String> {
        if period.start.as_str() >= now {
            return Ok(Some("Future cash counts cannot be recorded.".into()));
        }
        let purge = self.setting("transaction_purge_at").await?;
        if !purge.is_empty() {
            let stamp = DateTime::parse_from_rfc3339(&purge).map_err(|_| "The transaction-purge marker is invalid; review the database before counting cash.")?.with_timezone(&Utc).to_rfc3339_opts(SecondsFormat::Millis, true);
            if stamp >= period.start {
                return Ok(Some("This day's transaction history was deleted. A new expected-cash snapshot cannot be reconstructed; existing counts can still be corrected.".into()));
            }
        }
        if self.scalar("SELECT CAST(COUNT(*) AS SIGNED) AS value FROM payment_terminal_attempts WHERE (tillId = ? OR COALESCE(TRIM(tillId), '') = '') AND status IN ('prepared','started','uncertain','approved','commit_failed','completion_pending')", &[till]).await? > 0 {
            return Ok(Some("Complete or recover this till's active card payment before recording its cash count.".into()));
        }
        if matches!(self, Self::Shared(_)) {
            let rows = self.rows("SELECT CAST(CASE WHEN lastSeenAt >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 45 SECOND) AND lastSeenAt <= DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 5 SECOND) THEN 1 ELSE 0 END AS SIGNED) AS online, CAST(closeProtocolVersion AS SIGNED) AS protocol, CAST(outboxCount AS SIGNED) AS outbox, CAST(localTerminalAttemptCount AS SIGNED) AS terminals, CAST(syncConflictCount AS SIGNED) AS conflicts FROM till_presence WHERE tillId = ? FOR UPDATE", &[till]).await?;
            let Some(row) = rows.first() else {
                return Ok(till_readiness_issue(0, 0, 0, 0, 0));
            };
            if let Some(issue) = till_readiness_issue(
                row.int("online")?,
                row.int("protocol")?,
                row.int("outbox")?,
                row.int("terminals")?,
                row.int("conflicts")?,
            ) {
                return Ok(Some(issue));
            }
        }
        Ok(None)
    }
    async fn flow(&mut self, till: &str, start: &str, end: &str) -> Result<CashFlow, String> {
        let scope = "o.status IN ('completed','refunded','partially_refunded') AND NOT (o.type = 'return' AND COALESCE(o.notes, '') LIKE 'Void of receipt %') AND o.tillNumber = ? AND o.completedAt >= ? AND o.completedAt < ?";
        if self.scalar(&format!("SELECT CAST(COUNT(*) AS SIGNED) AS value FROM orders o WHERE {scope} AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.orderId = o.id)"), &[till,start,end]).await? > 0 {
            return Err("Some completed sales have no payment allocation. Review those sales before recording expected cash.".into());
        }
        let rows = self.rows(&format!("SELECT CAST(COALESCE(SUM(CASE WHEN COALESCE(p.cashAmount, 0) != 0 THEN p.cashAmount WHEN p.method = 'cash' THEN p.amount ELSE 0 END), 0) AS SIGNED) AS cash, CAST(COALESCE(SUM(COALESCE(p.cashbackAmount, 0)), 0) AS SIGNED) AS cashback FROM payments p JOIN orders o ON o.id = p.orderId WHERE {scope}"), &[till,start,end]).await?;
        let account = self.rows("SELECT CAST(COALESCE(SUM(CASE WHEN paymentMethod = 'cash' THEN -amountPence ELSE 0 END), 0) AS SIGNED) AS cash, CAST(COALESCE(SUM(COALESCE(cashbackAmount, 0)), 0) AS SIGNED) AS cashback FROM customer_account_entries WHERE entryType = 'payment' AND tillNumber = ? AND createdAt >= ? AND createdAt < ?", &[till,start,end]).await?;
        let movements = self.scalar("SELECT CAST(COALESCE(SUM(m.amount), 0) AS SIGNED) AS value FROM cash_movements m JOIN shifts s ON s.id = m.shiftId WHERE s.registerId = ? AND m.createdAt >= ? AND m.createdAt < ?", &[till,start,end]).await?;
        let flow = CashFlow {
            sales: rows[0].int("cash")?,
            account: account[0].int("cash")?,
            movements,
            cashback: rows[0]
                .int("cashback")?
                .checked_add(account[0].int("cashback")?)
                .ok_or("Cashback total overflow")?,
        };
        flow.net()?;
        Ok(flow)
    }
}

async fn connect(
    app: &AppHandle,
    mysql_uri: Option<&str>,
) -> Result<(Store, Option<String>), String> {
    let options = SqliteConnectOptions::new()
        .filename(crate::commerce::local_db_path(app)?)
        .create_if_missing(false)
        .busy_timeout(Duration::from_secs(5));
    let mut local = Store::Local(
        SqliteConnection::connect_with(&options)
            .await
            .map_err(|e| e.to_string())?,
    );
    let mode = local.setting("pos_mode").await?;
    if !matches!(mode.as_str(), "single" | "multi") {
        return Err("Configure a standalone or shared POS before using Cash Control.".into());
    }
    let pending = local.scalar("SELECT CAST(COUNT(*) AS SIGNED) AS value FROM _offline_queue WHERE table_name IN ('orders','order_lines','payments','shifts','cash_movements','customer_account_entries') OR operation = 'saleBundle'", &[]).await?;
    let intents = local
        .scalar(
            "SELECT CAST(COUNT(*) AS SIGNED) AS value FROM _online_financial_intent",
            &[],
        )
        .await?;
    let conflicts = local.scalar("SELECT CAST(COUNT(*) AS SIGNED) AS value FROM _sync_conflicts WHERE table_name IN ('orders','order_lines','payments','shifts','cash_movements','customer_account_entries') OR operation = 'saleBundle'", &[]).await?;
    let terminals = local.scalar("SELECT CAST(COUNT(*) AS SIGNED) AS value FROM payment_terminal_attempts WHERE status IN ('prepared','started','uncertain','approved','commit_failed','completion_pending')", &[]).await?;
    let local_block = if pending > 0 || intents > 0 || conflicts > 0 || terminals > 0 {
        Some("Synchronize or recover pending local financial work before taking a new cash snapshot.".into())
    } else {
        None
    };
    if mode == "single" {
        if mysql_uri.is_some_and(|v| !v.is_empty()) {
            return Err("Standalone Cash Control cannot use a shared database override.".into());
        }
        return Ok((local, local_block));
    }
    let uri = mysql_uri.filter(|v| !v.trim().is_empty()).ok_or(
        "Shared Cash Control requires an online MariaDB connection; offline edits are not allowed.",
    )?;
    let conn = tokio::time::timeout(Duration::from_secs(5), MySqlConnection::connect(uri))
        .await
        .map_err(|_| "Shared Cash Control is offline; no count was saved.")?
        .map_err(|_| "Shared Cash Control could not connect; no count was saved.")?;
    let mut shared = Store::Shared(conn);
    let local_identity = local
        .rows("SELECT shopId FROM app_identity WHERE id = 'main'", &[])
        .await?;
    let remote_identity = shared
        .rows("SELECT shopId FROM app_identity WHERE id = 'main'", &[])
        .await?;
    if local_identity.is_empty()
        || remote_identity.is_empty()
        || local_identity[0].text("shopId")?.is_empty()
        || local_identity[0].text("shopId")? != remote_identity[0].text("shopId")?
    {
        return Err("Shared Cash Control shop identity does not match this POS.".into());
    }
    shared
        .execute("SET SESSION innodb_lock_wait_timeout = 5", &[])
        .await?;
    shared
        .execute("SET SESSION max_statement_time = 8", &[])
        .await?;
    Ok((shared, local_block))
}

async fn context_in(
    store: &mut Store,
    employee: &str,
    pin: &str,
    till: &str,
    date: &str,
    period: &Period,
    local_block: Option<String>,
) -> Result<CashControlContext, String> {
    store.authenticate(employee, pin).await?;
    store.validate_till(till).await?;
    let now = store.now().await?;
    let entries = store.entries(till, date).await?;
    if let Some(latest) = entries.first() {
        return Ok(CashControlContext { source: store.source().into(), till_id: till.into(), business_date: date.into(), period_start: latest.period_start.clone(), period_end: latest.period_end.clone(), snapshot_at: latest.snapshot_at.clone(), cash_sales_amount: latest.cash_sales_amount, account_cash_amount: latest.account_cash_amount, cash_movement_amount: latest.cash_movement_amount, cashback_amount: latest.cashback_amount, net_cash_amount: latest.net_cash_amount, can_create: false, blocked_reason: Some("A count already exists for this till/day. Append a correction to its latest revision.".into()), entries });
    }
    let end = period.end.clone().min(now.clone());
    let blocked = local_block.or(store.blocked(till, period, &now).await?);
    let flow = if blocked.is_none() {
        store.flow(till, &period.start, &end).await?
    } else {
        CashFlow::default()
    };
    Ok(CashControlContext {
        source: store.source().into(),
        till_id: till.into(),
        business_date: date.into(),
        period_start: period.start.clone(),
        period_end: end,
        snapshot_at: now,
        cash_sales_amount: flow.sales,
        account_cash_amount: flow.account,
        cash_movement_amount: flow.movements,
        cashback_amount: flow.cashback,
        net_cash_amount: flow.net()?,
        can_create: blocked.is_none(),
        blocked_reason: blocked,
        entries,
    })
}

fn validate_request(request: &CountRequest) -> Result<Period, String> {
    if request.id.is_empty()
        || request.id.len() > 128
        || !request
            .id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err("A unique cash-count request ID is required.".into());
    }
    if !(0..=MAX_MONEY).contains(&request.opening_float_amount)
        || !(0..=MAX_MONEY).contains(&request.counted_amount)
    {
        return Err(
            "Opening float and counted cash must be non-negative whole minor units.".into(),
        );
    }
    if request.reason.trim().chars().count() < 3 || request.reason.len() > 2000 {
        return Err("A reason between 3 and 2000 characters is required.".into());
    }
    validate_period(
        &request.business_date,
        &request.period_start,
        &request.period_end,
    )
}

fn build_entry(
    request: &CountRequest,
    employee: &str,
    name: &str,
    previous: Option<&CashControlEntry>,
    period: &Period,
    flow: CashFlow,
    now: &str,
) -> Result<CashControlEntry, String> {
    if previous.map(|p| p.id.as_str()) != request.previous_entry_id.as_deref() {
        return Err("Cash count changed. Reload and correct the latest revision.".into());
    }
    if previous.is_some_and(|p| {
        p.period_start != period.start
            || p.business_date != request.business_date
            || p.till_id != request.till_id
    }) {
        return Err(
            "A correction must retain the original till, business date and timezone boundary."
                .into(),
        );
    }
    let (flow, start, end, snapshot) = if let Some(prior) = previous {
        (
            CashFlow {
                sales: prior.cash_sales_amount,
                account: prior.account_cash_amount,
                movements: prior.cash_movement_amount,
                cashback: prior.cashback_amount,
            },
            prior.period_start.clone(),
            prior.period_end.clone(),
            prior.snapshot_at.clone(),
        )
    } else {
        (
            flow,
            period.start.clone(),
            period.end.clone().min(now.to_string()),
            now.into(),
        )
    };
    let net = flow.net()?;
    let expected = request
        .opening_float_amount
        .checked_add(net)
        .filter(|v| (-MAX_MONEY..=MAX_MONEY).contains(v))
        .ok_or("Expected cash exceeds the supported range")?;
    let variance = request
        .counted_amount
        .checked_sub(expected)
        .filter(|v| (-MAX_MONEY..=MAX_MONEY).contains(v))
        .ok_or("Cash variance exceeds the supported range")?;
    Ok(CashControlEntry {
        id: request.id.clone(),
        root_id: previous
            .map(|p| p.root_id.clone())
            .unwrap_or_else(|| request.id.clone()),
        previous_entry_id: request.previous_entry_id.clone(),
        revision: previous
            .map(|p| {
                p.revision
                    .checked_add(1)
                    .ok_or("Cash revision limit reached")
            })
            .transpose()?
            .unwrap_or(1),
        till_id: request.till_id.clone(),
        business_date: request.business_date.clone(),
        period_start: start,
        period_end: end,
        snapshot_at: snapshot,
        opening_float_amount: request.opening_float_amount,
        counted_amount: request.counted_amount,
        expected_amount: expected,
        variance_amount: variance,
        cash_sales_amount: flow.sales,
        account_cash_amount: flow.account,
        cash_movement_amount: flow.movements,
        cashback_amount: flow.cashback,
        net_cash_amount: net,
        reason: request.reason.trim().into(),
        employee_id: employee.into(),
        employee_name: name.into(),
        created_at: now.into(),
    })
}

async fn save_in(
    store: &mut Store,
    employee: &str,
    pin: &str,
    request: &CountRequest,
    local_block: Option<String>,
) -> Result<CashControlEntry, String> {
    let period = validate_request(request)?;
    let name = store.authenticate(employee, pin).await?;
    store.validate_till(&request.till_id).await?;
    let entries = store
        .entries(&request.till_id, &request.business_date)
        .await?;
    // Retry after a lost reply is idempotent, but changed intent is never accepted.
    if let Some(prior) = entries.iter().find(|entry| entry.id == request.id) {
        if prior.employee_id == employee
            && prior.period_start == period.start
            && prior.previous_entry_id == request.previous_entry_id
            && prior.opening_float_amount == request.opening_float_amount
            && prior.counted_amount == request.counted_amount
            && prior.reason == request.reason.trim()
        {
            return Ok(prior.clone());
        }
        return Err("This cash-count request ID was already used for different data.".into());
    }
    let now = store.now().await?;
    let flow = if entries.is_empty() {
        if let Some(reason) = local_block.or(store.blocked(&request.till_id, &period, &now).await?)
        {
            return Err(reason);
        }
        store
            .flow(
                &request.till_id,
                &period.start,
                &period.end.clone().min(now.clone()),
            )
            .await?
    } else {
        CashFlow::default()
    };
    let entry = build_entry(
        request,
        employee,
        &name,
        entries.first(),
        &period,
        flow,
        &now,
    )?;
    let payload = serde_json::to_string(&entry).map_err(|e| e.to_string())?;
    store.execute("INSERT INTO private_cash_control_entries (id,tillId,businessDate,revision,payload) VALUES (?,?,?,?,?)", &[&entry.id,&entry.till_id,&entry.business_date,&entry.revision.to_string(),&payload]).await?;
    Ok(entry)
}

#[tauri::command]
pub async fn cash_control_context(
    app: AppHandle,
    mysql_uri: Option<String>,
    employee_id: String,
    pin: String,
    till_id: String,
    business_date: String,
    period_start: String,
    period_end: String,
) -> Result<CashControlContext, String> {
    let period = validate_period(&business_date, &period_start, &period_end)?;
    let (mut store, blocked) = connect(&app, mysql_uri.as_deref()).await?;
    store.ensure_schema().await?;
    store.begin().await?;
    let result = context_in(
        &mut store,
        &employee_id,
        &pin,
        &till_id,
        &business_date,
        &period,
        blocked,
    )
    .await;
    store
        .execute(if result.is_ok() { "COMMIT" } else { "ROLLBACK" }, &[])
        .await?;
    result
}

#[tauri::command]
pub async fn cash_control_save(
    app: AppHandle,
    mysql_uri: Option<String>,
    employee_id: String,
    pin: String,
    request: CountRequest,
) -> Result<CashControlEntry, String> {
    validate_request(&request)?;
    let (mut store, blocked) = connect(&app, mysql_uri.as_deref()).await?;
    store.ensure_schema().await?;
    store.begin().await?;
    let result = save_in(&mut store, &employee_id, &pin, &request, blocked).await;
    store
        .execute(if result.is_ok() { "COMMIT" } else { "ROLLBACK" }, &[])
        .await?;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(id: &str) -> CountRequest {
        CountRequest {
            id: id.into(),
            till_id: "till-a".into(),
            business_date: "2026-06-01".into(),
            period_start: "2026-06-01T00:00:00+01:00".into(),
            period_end: "2026-06-02T00:00:00+01:00".into(),
            opening_float_amount: 5000,
            counted_amount: 6800,
            reason: "End of day count".into(),
            previous_entry_id: None,
        }
    }

    async fn fixture(actor: &str) -> Store {
        let mut store = Store::Local(SqliteConnection::connect("sqlite::memory:").await.unwrap());
        for sql in [
            "CREATE TABLE employees (id TEXT PRIMARY KEY, name TEXT, pin TEXT, pinHash TEXT, role TEXT, isActive INTEGER)",
            "CREATE TABLE registers (id TEXT PRIMARY KEY)",
            "CREATE TABLE settings (`key` TEXT PRIMARY KEY, value TEXT)",
            "CREATE TABLE payment_terminal_attempts (tillId TEXT, status TEXT)",
            "CREATE TABLE orders (id TEXT PRIMARY KEY, status TEXT, type TEXT, notes TEXT, tillNumber TEXT, completedAt TEXT)",
            "CREATE TABLE payments (id TEXT PRIMARY KEY, orderId TEXT, cashAmount INTEGER, amount INTEGER, method TEXT, cashbackAmount INTEGER)",
            "ALTER TABLE payments ADD COLUMN changeGiven INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE payments ADD COLUMN tipsAmount INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE payments ADD COLUMN serviceChargeAmount INTEGER NOT NULL DEFAULT 0",
            "CREATE TABLE customer_account_entries (tillNumber TEXT, entryType TEXT, paymentMethod TEXT, amountPence INTEGER, cashbackAmount INTEGER, createdAt TEXT)",
            "CREATE TABLE shifts (id TEXT PRIMARY KEY, registerId TEXT)",
            "CREATE TABLE cash_movements (shiftId TEXT, amount INTEGER, createdAt TEXT)",
            "INSERT INTO registers VALUES ('till-a'), ('till-b')",
            "INSERT INTO shifts VALUES ('shift-a', 'till-a'), ('shift-b', 'till-b')",
            "INSERT INTO orders VALUES ('cash', 'completed', 'sale', '', 'till-a', '2026-06-01T09:00:00.000Z'), ('split', 'completed', 'sale', '', 'till-a', '2026-06-01T10:00:00.000Z'), ('return', 'completed', 'return', '', 'till-a', '2026-06-01T11:00:00.000Z'), ('voided', 'voided', 'sale', '', 'till-a', '2026-06-01T12:00:00.000Z'), ('void-return', 'completed', 'return', 'Void of receipt 1', 'till-a', '2026-06-01T12:00:00.000Z'), ('other-till', 'completed', 'sale', '', 'till-b', '2026-06-01T12:00:00.000Z'), ('next-day', 'completed', 'sale', '', 'till-a', '2026-06-01T23:00:00.000Z')",
            "INSERT INTO payments (id,orderId,cashAmount,amount,method,cashbackAmount) VALUES ('p1','cash',0,1000,'cash',0), ('p2','split',600,2000,'split',200), ('p3','return',-100,-100,'cash',0), ('p4','voided',10000,10000,'cash',0), ('p5','void-return',-10000,-10000,'cash',0), ('p6','other-till',9000,9000,'cash',0), ('p7','next-day',8000,8000,'cash',0)",
            "UPDATE payments SET changeGiven = 500 WHERE id = 'p1'",
            "UPDATE payments SET tipsAmount = 300, serviceChargeAmount = 100 WHERE id = 'p2'",
            "INSERT INTO customer_account_entries VALUES ('till-a','payment','cash',-700,0,'2026-06-01T13:00:00.000Z'), ('till-a','payment','card',-900,100,'2026-06-01T13:00:00.000Z'), ('till-a','charge','cash',8000,0,'2026-06-01T13:00:00.000Z'), ('till-b','payment','cash',-9000,0,'2026-06-01T13:00:00.000Z')",
            "INSERT INTO cash_movements VALUES ('shift-a',-200,'2026-06-01T13:00:00.000Z'), ('shift-a',50,'2026-06-01T13:00:00.000Z'), ('shift-b',9000,'2026-06-01T13:00:00.000Z')",
        ] { store.execute(sql, &[]).await.unwrap(); }
        store
            .execute(
                "INSERT INTO employees VALUES (?, 'Owner', '2468', '', 'admin', 1)",
                &[actor],
            )
            .await
            .unwrap();
        store.ensure_schema().await.unwrap();
        store
    }

    #[test]
    fn cash_pin_verification_matches_browser_pbkdf2_and_legacy_formats() {
        let hash = "pbkdf2-sha256$210000$BwcHBwcHBwcHBwcHBwcHBw==$u7N+O27p5PEkTYlp/l0IFfhEJTgKl94S7MnRtJglOx8=";
        assert!(pin_matches("2468", "", hash));
        assert!(!pin_matches("2469", "", hash));
        assert!(pin_matches("2468", "2468", ""));
        let legacy = format!("{:x}", Sha256::digest("pos-pin-v1:2468"));
        assert!(pin_matches("2468", "", &legacy));
        assert!(!pin_matches("", "", ""));
        assert!(!pin_matches("2468", "2468", "reset-required"));
        assert!(!pin_matches(
            "2468",
            "",
            "pbkdf2-sha256$999999999$AA==$AA=="
        ));
        assert!(!pin_matches("2468", "", "attendance-only:reset-required"));
    }

    #[test]
    fn cash_period_requires_midnights_and_supports_dst() {
        let summer = validate_period(
            "2026-06-01",
            "2026-06-01T00:00:00+01:00",
            "2026-06-02T00:00:00+01:00",
        )
        .unwrap();
        assert_eq!(summer.start, "2026-05-31T23:00:00.000Z");
        assert!(validate_period(
            "2026-03-29",
            "2026-03-29T00:00:00+00:00",
            "2026-03-30T00:00:00+01:00"
        )
        .is_ok());
        assert!(validate_period(
            "2026-10-25",
            "2026-10-25T00:00:00+01:00",
            "2026-10-26T00:00:00+00:00"
        )
        .is_ok());
        assert!(validate_period(
            "2026-06-01",
            "2026-06-01T01:00:00+01:00",
            "2026-06-02T00:00:00+01:00"
        )
        .is_err());
        assert!(validate_period(
            "2026-06-01",
            "2026-06-01T00:00:00+01:00",
            "2026-06-03T00:00:00+01:00"
        )
        .is_err());
    }

    #[test]
    fn cash_count_snapshot_includes_split_refund_accounts_movements_and_cashback_only_once() {
        tauri::async_runtime::block_on(async {
            let mut store = fixture("owner-components").await;
            store.begin().await.unwrap();
            let entry = save_in(
                &mut store,
                "owner-components",
                "2468",
                &request("one"),
                None,
            )
            .await
            .unwrap();
            assert_eq!(
                (
                    entry.cash_sales_amount,
                    entry.account_cash_amount,
                    entry.cash_movement_amount,
                    entry.cashback_amount
                ),
                (1500, 700, -150, 300)
            );
            assert_eq!(
                (
                    entry.net_cash_amount,
                    entry.expected_amount,
                    entry.variance_amount
                ),
                (1750, 6750, 50)
            );
            store.execute("COMMIT", &[]).await.unwrap();
            assert_eq!(
                store
                    .scalar("SELECT COUNT(*) AS value FROM orders", &[])
                    .await
                    .unwrap(),
                7
            );
            assert_eq!(
                store
                    .scalar("SELECT SUM(amount) AS value FROM payments", &[])
                    .await
                    .unwrap(),
                19900
            );
            assert_eq!(
                store
                    .scalar("SELECT COUNT(*) AS value FROM cash_movements", &[])
                    .await
                    .unwrap(),
                3
            );
        });
    }

    #[test]
    fn cash_revisions_preserve_snapshot_after_purge_and_reject_stale_head() {
        tauri::async_runtime::block_on(async {
            let mut store = fixture("owner-revision").await;
            let initial = save_in(&mut store, "owner-revision", "2468", &request("one"), None)
                .await
                .unwrap();
            store.execute("DELETE FROM payments", &[]).await.unwrap();
            store.execute("DELETE FROM orders", &[]).await.unwrap();
            store
            .execute(
                "INSERT INTO settings VALUES ('transaction_purge_at', '2026-06-02T12:00:00.000Z')",
                &[],
            )
            .await
            .unwrap();
            let mut correction = request("two");
            correction.previous_entry_id = Some(initial.id.clone());
            correction.counted_amount = 6850;
            correction.opening_float_amount = 5100;
            correction.reason = "Second sealed bag was counted".into();
            let revised = save_in(&mut store, "owner-revision", "2468", &correction, None)
                .await
                .unwrap();
            assert_eq!(revised.snapshot_at, initial.snapshot_at);
            assert_eq!(revised.net_cash_amount, 1750);
            assert_eq!(revised.expected_amount, 6850);
            assert_eq!(revised.variance_amount, 0);
            assert_eq!(revised.revision, 2);
            assert_eq!(revised.root_id, "one");
            let mut stale = correction.clone();
            stale.id = "three".into();
            assert!(save_in(&mut store, "owner-revision", "2468", &stale, None)
                .await
                .unwrap_err()
                .contains("latest revision"));
            assert_eq!(
                store.entries("till-a", "2026-06-01").await.unwrap()[1],
                initial
            );
            let context = context_in(
                &mut store,
                "owner-revision",
                "2468",
                "till-a",
                "2026-06-01",
                &validate_request(&request("read")).unwrap(),
                None,
            )
            .await
            .unwrap();
            assert_eq!(context.entries.len(), 2);
            assert_eq!(context.net_cash_amount, 1750);
        });
    }

    #[test]
    fn cash_pin_and_admin_role_are_checked_natively_on_reads_and_writes() {
        tauri::async_runtime::block_on(async {
            let mut store = fixture("owner-auth").await;
            let period = validate_request(&request("one")).unwrap();
            assert_eq!(
                context_in(
                    &mut store,
                    "owner-auth",
                    "9999",
                    "till-a",
                    "2026-06-01",
                    &period,
                    None
                )
                .await
                .unwrap_err(),
                AUTH_ERROR
            );
            store
                .execute(
                    "UPDATE employees SET role = 'manager' WHERE id = 'owner-auth'",
                    &[],
                )
                .await
                .unwrap();
            assert_eq!(
                save_in(&mut store, "owner-auth", "2468", &request("one"), None)
                    .await
                    .unwrap_err(),
                AUTH_ERROR
            );
            store
                .execute(
                    "UPDATE employees SET role = 'admin', isActive = 0 WHERE id = 'owner-auth'",
                    &[],
                )
                .await
                .unwrap();
            assert_eq!(
                save_in(&mut store, "owner-auth", "2468", &request("one"), None)
                    .await
                    .unwrap_err(),
                AUTH_ERROR
            );
            assert_eq!(
                store
                    .scalar(
                        "SELECT COUNT(*) AS value FROM private_cash_control_entries",
                        &[]
                    )
                    .await
                    .unwrap(),
                0
            );
        });
    }

    #[test]
    fn cash_unknown_till_purge_and_pending_payment_fail_closed() {
        tauri::async_runtime::block_on(async {
            let mut store = fixture("owner-guards").await;
            let mut input = request("one");
            input.till_id = "unknown".into();
            assert!(save_in(&mut store, "owner-guards", "2468", &input, None)
                .await
                .unwrap_err()
                .contains("not registered"));
            input.till_id = "till-a".into();
            store
                .execute(
                    "INSERT INTO payment_terminal_attempts VALUES ('till-a','approved')",
                    &[],
                )
                .await
                .unwrap();
            assert!(save_in(&mut store, "owner-guards", "2468", &input, None)
                .await
                .unwrap_err()
                .contains("recover"));
            store
                .execute("DELETE FROM payment_terminal_attempts", &[])
                .await
                .unwrap();
            store
            .execute(
                "INSERT INTO settings VALUES ('transaction_purge_at', '2026-06-01T12:00:00.000Z')",
                &[],
            )
            .await
            .unwrap();
            assert!(save_in(&mut store, "owner-guards", "2468", &input, None)
                .await
                .unwrap_err()
                .contains("deleted"));
            store.execute("DELETE FROM settings", &[]).await.unwrap();
            assert_eq!(
                save_in(
                    &mut store,
                    "owner-guards",
                    "2468",
                    &input,
                    Some("Pending financial sync".into())
                )
                .await
                .unwrap_err(),
                "Pending financial sync"
            );
        });
    }

    #[test]
    fn cash_new_count_rejects_missing_payment_and_duplicate_day() {
        tauri::async_runtime::block_on(async {
            let mut store = fixture("owner-missing").await;
            store
                .execute("DELETE FROM payments WHERE orderId = 'cash'", &[])
                .await
                .unwrap();
            assert!(
                save_in(&mut store, "owner-missing", "2468", &request("one"), None)
                    .await
                    .unwrap_err()
                    .contains("no payment allocation")
            );
            store
                .execute("DELETE FROM orders WHERE id = 'cash'", &[])
                .await
                .unwrap();
            save_in(&mut store, "owner-missing", "2468", &request("one"), None)
                .await
                .unwrap();
            assert!(
                save_in(&mut store, "owner-missing", "2468", &request("two"), None)
                    .await
                    .unwrap_err()
                    .contains("latest revision")
            );
        });
    }

    #[test]
    fn cash_retry_is_idempotent_but_changes_to_same_request_are_rejected() {
        tauri::async_runtime::block_on(async {
            let mut store = fixture("owner-idempotence").await;
            let input = request("one");
            let first = save_in(&mut store, "owner-idempotence", "2468", &input, None)
                .await
                .unwrap();
            assert_eq!(
                save_in(&mut store, "owner-idempotence", "2468", &input, None)
                    .await
                    .unwrap(),
                first
            );
            let mut changed = input;
            changed.counted_amount += 1;
            assert!(
                save_in(&mut store, "owner-idempotence", "2468", &changed, None)
                    .await
                    .unwrap_err()
                    .contains("different data")
            );
            assert_eq!(
                store.entries("till-a", "2026-06-01").await.unwrap().len(),
                1
            );
        });
    }

    #[test]
    fn cash_ledger_has_database_append_only_guards() {
        tauri::async_runtime::block_on(async {
            let mut store = fixture("owner-immutable").await;
            save_in(&mut store, "owner-immutable", "2468", &request("one"), None)
                .await
                .unwrap();
            assert!(store
                .execute(
                    "UPDATE private_cash_control_entries SET payload = '{}'",
                    &[]
                )
                .await
                .unwrap_err()
                .contains("append-only"));
            assert!(store
                .execute("DELETE FROM private_cash_control_entries", &[])
                .await
                .unwrap_err()
                .contains("append-only"));
            assert_eq!(
                store.entries("till-a", "2026-06-01").await.unwrap().len(),
                1
            );
        });
    }

    #[test]
    fn cash_validation_rejects_negative_counts_empty_reason_and_overflow() {
        let mut input = request("one");
        input.counted_amount = -1;
        assert!(validate_request(&input).is_err());
        input.counted_amount = 0;
        input.reason = "  ".into();
        assert!(validate_request(&input).is_err());
        input.reason = "Count".into();
        input.opening_float_amount = MAX_MONEY;
        let period = validate_request(&input).unwrap();
        assert!(build_entry(
            &input,
            "owner",
            "Owner",
            None,
            &period,
            CashFlow {
                sales: 1,
                ..Default::default()
            },
            "2026-06-02T00:00:00.000Z"
        )
        .is_err());
        assert!(CashFlow {
            sales: i64::MIN,
            ..Default::default()
        }
        .net()
        .is_err());
    }

    #[test]
    fn cash_native_rate_limit_cannot_be_bypassed_by_renderer_login() {
        for _ in 0..5 {
            reserve_auth("cash-throttle-fixture").unwrap();
        }
        assert!(reserve_auth("cash-throttle-fixture")
            .unwrap_err()
            .contains("Too many"));
    }

    #[test]
    fn cash_shared_snapshot_requires_selected_till_readiness() {
        assert!(till_readiness_issue(1, 1, 0, 0, 0).is_none());
        assert!(till_readiness_issue(0, 1, 0, 0, 0).is_some());
        assert!(till_readiness_issue(1, 0, 0, 0, 0).is_some());
        assert!(till_readiness_issue(1, 1, 1, 0, 0).is_some());
        assert!(till_readiness_issue(1, 1, 0, 1, 0).is_some());
        assert!(till_readiness_issue(1, 1, 0, 0, 1).is_some());
        assert!(till_readiness_issue(1, 1, -1, 0, 0).is_some());
    }

    /// Opt-in integration test: the caller creates an EMPTY, disposable local
    /// database and drops that exact database afterwards. No live POS URI is
    /// accepted, and no application config, secrets or real database is opened.
    #[test]
    fn real_mariadb_cash_control_when_configured() {
        let Ok(uri) = std::env::var("POS_TEST_MYSQL_URI") else {
            return;
        };
        let url = reqwest::Url::parse(&uri).expect("Invalid disposable test URI");
        assert!(
            matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")),
            "Cash Control integration test requires a local disposable server"
        );
        let database = url.path().trim_start_matches('/');
        assert!(
            database.starts_with("pos_cash_control_test_")
                && database.len() <= 64
                && database
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_'),
            "Refusing a non-disposable Cash Control database name"
        );
        tauri::async_runtime::block_on(async {
            let mut store = Store::Shared(
                MySqlConnection::connect(&uri)
                    .await
                    .expect("Disposable test connection failed"),
            );
            let actual = store.rows("SELECT DATABASE() AS value", &[]).await.unwrap()[0]
                .text("value")
                .unwrap();
            assert_eq!(actual, database, "Unexpected database selected");
            assert_eq!(store.scalar("SELECT CAST(COUNT(*) AS SIGNED) AS value FROM information_schema.tables WHERE table_schema = DATABASE()", &[]).await.unwrap(),0,"Fixture requires a newly created EMPTY database");
            for sql in [
                "CREATE TABLE employees (id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin PRIMARY KEY, name TEXT, pin TEXT, pinHash TEXT, role VARCHAR(32), isActive TINYINT) ENGINE=InnoDB",
                "CREATE TABLE registers (id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin PRIMARY KEY) ENGINE=InnoDB",
                "CREATE TABLE settings (`key` VARCHAR(128) PRIMARY KEY, value TEXT) ENGINE=InnoDB",
                "CREATE TABLE pos_close_barrier (id TINYINT PRIMARY KEY, state VARCHAR(16)) ENGINE=InnoDB",
                "CREATE TABLE pos_restore_gate (id TINYINT PRIMARY KEY, isActive TINYINT) ENGINE=InnoDB",
                "CREATE TABLE till_presence (tillId VARCHAR(64) PRIMARY KEY, closeProtocolVersion INT, outboxCount BIGINT, localTerminalAttemptCount BIGINT, syncConflictCount BIGINT, lastSeenAt DATETIME(3)) ENGINE=InnoDB",
                "CREATE TABLE payment_terminal_attempts (tillId VARCHAR(64), status VARCHAR(32)) ENGINE=InnoDB",
                "CREATE TABLE orders (id VARCHAR(64) PRIMARY KEY, status VARCHAR(32), type VARCHAR(32), notes TEXT, tillNumber VARCHAR(64), completedAt TEXT) ENGINE=InnoDB",
                "CREATE TABLE payments (id VARCHAR(64) PRIMARY KEY, orderId VARCHAR(64), method VARCHAR(32), amount BIGINT, cashAmount BIGINT, cashbackAmount BIGINT, tipsAmount BIGINT DEFAULT 0, serviceChargeAmount BIGINT DEFAULT 0, changeGiven BIGINT DEFAULT 0) ENGINE=InnoDB",
                "CREATE TABLE customer_account_entries (tillNumber VARCHAR(64), entryType VARCHAR(32), paymentMethod VARCHAR(32), amountPence BIGINT, cashbackAmount BIGINT, createdAt TEXT) ENGINE=InnoDB",
                "CREATE TABLE shifts (id VARCHAR(64) PRIMARY KEY, registerId VARCHAR(64)) ENGINE=InnoDB",
                "CREATE TABLE cash_movements (shiftId VARCHAR(64), amount BIGINT, createdAt TEXT) ENGINE=InnoDB",
                "INSERT INTO employees VALUES ('mysql-cash-owner','Owner','2468','','admin',1)",
                "INSERT INTO registers VALUES ('till-a'),('till-b')",
                "INSERT INTO pos_close_barrier VALUES (1,'idle')",
                "INSERT INTO pos_restore_gate VALUES (1,0)",
                "INSERT INTO till_presence VALUES ('till-a',1,0,0,0,UTC_TIMESTAMP(3)),('till-b',1,0,0,0,UTC_TIMESTAMP(3))",
                "INSERT INTO shifts VALUES ('shift-a','till-a')",
                "INSERT INTO orders VALUES ('cash','completed','sale','','till-a','2026-06-01T09:00:00.000Z'),('split','completed','sale','','till-a','2026-06-01T10:00:00.000Z'),('refund','completed','return','','till-a','2026-06-01T11:00:00.000Z'),('other','completed','sale','','till-b','2026-06-01T11:00:00.000Z')",
                "INSERT INTO payments (id,orderId,method,amount,cashAmount,cashbackAmount,tipsAmount,serviceChargeAmount,changeGiven) VALUES ('p1','cash','cash',1000,0,0,0,0,500),('p2','split','split',2000,600,200,300,100,0),('p3','refund','cash',-100,-100,0,0,0,0),('p4','other','cash',9000,9000,0,0,0,0)",
                "INSERT INTO customer_account_entries VALUES ('till-a','payment','cash',-700,0,'2026-06-01T12:00:00.000Z'),('till-a','payment','cash',50,0,'2026-06-01T12:00:00.000Z'),('till-a','payment','card',-900,100,'2026-06-01T12:00:00.000Z')",
                "INSERT INTO cash_movements VALUES ('shift-a',-200,'2026-06-01T12:00:00.000Z'),('shift-a',50,'2026-06-01T12:00:00.000Z')",
            ] { store.execute(sql,&[]).await.unwrap(); }
            store.ensure_schema().await.unwrap();
            store.ensure_schema().await.unwrap();
            assert_eq!(store.scalar("SELECT CAST(COUNT(*) AS SIGNED) AS value FROM information_schema.triggers WHERE trigger_schema = DATABASE() AND event_object_table = 'private_cash_control_entries'", &[]).await.unwrap(),2);
            let input = request("mysql-first");
            let period = validate_request(&input).unwrap();
            store.begin().await.unwrap();
            assert_eq!(
                context_in(
                    &mut store,
                    "mysql-cash-owner",
                    "0000",
                    "till-a",
                    "2026-06-01",
                    &period,
                    None
                )
                .await
                .unwrap_err(),
                AUTH_ERROR
            );
            store.execute("ROLLBACK", &[]).await.unwrap();
            store.begin().await.unwrap();
            let context = context_in(
                &mut store,
                "mysql-cash-owner",
                "2468",
                "till-a",
                "2026-06-01",
                &period,
                None,
            )
            .await
            .unwrap();
            assert_eq!(context.source, "shared");
            assert_eq!(
                (
                    context.cash_sales_amount,
                    context.account_cash_amount,
                    context.cash_movement_amount,
                    context.cashback_amount,
                    context.net_cash_amount
                ),
                (1500, 650, -150, 300, 1700)
            );
            assert!(context.can_create);
            store.execute("COMMIT", &[]).await.unwrap();

            // An offline or pending selected till cannot freeze an incomplete
            // server-only snapshot, even if the requesting till is healthy.
            for change in [
                "UPDATE till_presence SET lastSeenAt = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 2 MINUTE) WHERE tillId = 'till-a'",
                "UPDATE till_presence SET lastSeenAt = UTC_TIMESTAMP(3), outboxCount = 1 WHERE tillId = 'till-a'",
                "UPDATE till_presence SET outboxCount = 0, localTerminalAttemptCount = 1 WHERE tillId = 'till-a'",
                "UPDATE till_presence SET localTerminalAttemptCount = 0, syncConflictCount = 1 WHERE tillId = 'till-a'",
            ] {
                store.execute(change,&[]).await.unwrap();
                store.begin().await.unwrap();
                assert!(save_in(&mut store,"mysql-cash-owner","2468",&input,None).await.is_err());
                store.execute("ROLLBACK",&[]).await.unwrap();
            }
            store.execute("UPDATE till_presence SET syncConflictCount = 0, lastSeenAt = UTC_TIMESTAMP(3) WHERE tillId = 'till-a'",&[]).await.unwrap();
            store.begin().await.unwrap();
            let initial = save_in(&mut store, "mysql-cash-owner", "2468", &input, None)
                .await
                .unwrap();
            assert_eq!(
                (initial.expected_amount, initial.variance_amount),
                (6700, 100)
            );
            store.execute("COMMIT", &[]).await.unwrap();
            store.begin().await.unwrap();
            assert_eq!(
                save_in(&mut store, "mysql-cash-owner", "2468", &input, None)
                    .await
                    .unwrap(),
                initial
            );
            let mut changed = input.clone();
            changed.counted_amount += 1;
            assert!(
                save_in(&mut store, "mysql-cash-owner", "2468", &changed, None)
                    .await
                    .unwrap_err()
                    .contains("different data")
            );
            store.execute("ROLLBACK", &[]).await.unwrap();

            let mut correction = request("mysql-second");
            correction.previous_entry_id = Some(initial.id.clone());
            correction.counted_amount = 6700;
            correction.reason = "Owner's second \"sealed\" bag — recounted".into();
            // A concurrent stale correction waits for the close-barrier lock,
            // then observes the committed head (not its former snapshot).
            store.begin().await.unwrap();
            let mut stale = correction.clone();
            stale.id = "mysql-stale".into();
            let waiter_uri = uri.clone();
            let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
            let (acquired_tx, mut acquired_rx) = tokio::sync::oneshot::channel();
            let waiter = tauri::async_runtime::spawn(async move {
                let mut other = Store::Shared(MySqlConnection::connect(&waiter_uri).await.unwrap());
                ready_tx.send(()).unwrap();
                other.begin().await.unwrap();
                acquired_tx.send(()).unwrap();
                let result = save_in(&mut other, "mysql-cash-owner", "2468", &stale, None).await;
                other.execute("ROLLBACK", &[]).await.unwrap();
                result
            });
            ready_rx.await.unwrap();
            assert!(
                tokio::time::timeout(Duration::from_millis(100), &mut acquired_rx)
                    .await
                    .is_err(),
                "Second writer bypassed the barrier lock"
            );
            let revised = save_in(&mut store, "mysql-cash-owner", "2468", &correction, None)
                .await
                .unwrap();
            store.execute("COMMIT", &[]).await.unwrap();
            acquired_rx.await.unwrap();
            assert!(waiter
                .await
                .unwrap()
                .unwrap_err()
                .contains("latest revision"));
            assert_eq!(revised.revision, 2);
            assert_eq!(revised.snapshot_at, initial.snapshot_at);
            assert_eq!(revised.net_cash_amount, initial.net_cash_amount);
            assert_eq!(revised.variance_amount, 0);
            assert_eq!(
                store.entries("till-a", "2026-06-01").await.unwrap(),
                vec![revised.clone(), initial.clone()]
            );

            // Database guards enforce immutability, not just the command API.
            assert!(store
                .execute(
                    "UPDATE private_cash_control_entries SET payload = '{}'",
                    &[]
                )
                .await
                .unwrap_err()
                .contains("append-only"));
            assert!(store
                .execute("DELETE FROM private_cash_control_entries", &[])
                .await
                .unwrap_err()
                .contains("append-only"));
            assert_eq!(
                store
                    .scalar(
                        "SELECT CAST(SUM(amount) AS SIGNED) AS value FROM payments",
                        &[]
                    )
                    .await
                    .unwrap(),
                11900
            );
            assert_eq!(store.scalar("SELECT CAST(SUM(tipsAmount + serviceChargeAmount) AS SIGNED) AS value FROM payments",&[]).await.unwrap(),400);
            assert_eq!(
                store
                    .scalar(
                        "SELECT CAST(SUM(amount) AS SIGNED) AS value FROM cash_movements",
                        &[]
                    )
                    .await
                    .unwrap(),
                -150
            );

            // Purge cannot reconstruct a NEW day; an existing saved snapshot
            // remains correctable even after its financial source is gone.
            store.execute("DELETE FROM payments", &[]).await.unwrap();
            store.execute("DELETE FROM orders", &[]).await.unwrap();
            store.execute("INSERT INTO settings VALUES ('transaction_purge_at','2026-06-02T12:00:00.000Z')",&[]).await.unwrap();
            store.execute("UPDATE till_presence SET lastSeenAt = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 2 MINUTE)",&[]).await.unwrap();
            let mut after_purge = correction.clone();
            after_purge.id = "mysql-third".into();
            after_purge.previous_entry_id = Some(revised.id.clone());
            store.begin().await.unwrap();
            let retained = save_in(&mut store, "mysql-cash-owner", "2468", &after_purge, None)
                .await
                .unwrap();
            assert_eq!(retained.net_cash_amount, 1700);
            assert_eq!(retained.snapshot_at, initial.snapshot_at);
            store.execute("COMMIT", &[]).await.unwrap();
            let mut new_purged = input;
            new_purged.id = "mysql-other-till".into();
            new_purged.till_id = "till-b".into();
            store.begin().await.unwrap();
            assert!(
                save_in(&mut store, "mysql-cash-owner", "2468", &new_purged, None)
                    .await
                    .unwrap_err()
                    .contains("deleted")
            );
            store.execute("ROLLBACK", &[]).await.unwrap();
            store
                .execute(
                    "UPDATE pos_close_barrier SET state = 'frozen' WHERE id = 1",
                    &[],
                )
                .await
                .unwrap();
            assert!(store.begin().await.unwrap_err().contains("report close"));
            store.execute("ROLLBACK", &[]).await.unwrap();
            store
                .execute(
                    "UPDATE pos_close_barrier SET state = 'idle' WHERE id = 1",
                    &[],
                )
                .await
                .unwrap();
            store
                .execute("UPDATE pos_restore_gate SET isActive = 1 WHERE id = 1", &[])
                .await
                .unwrap();
            assert!(store.begin().await.unwrap_err().contains("maintenance"));
            store.execute("ROLLBACK", &[]).await.unwrap();
        });
    }
}
