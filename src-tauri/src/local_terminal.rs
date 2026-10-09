//! Dedicated terminals use this till's durable SQLite journal, never an
//! opportunistic MariaDB fallback. Legacy/shared attempts retain their scope.
use chrono::{Duration as ChronoDuration, SecondsFormat, Utc};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{sqlite::SqliteConnectOptions, Connection, Row, SqliteConnection};
use std::{
    fs::{File, OpenOptions},
    path::Path,
    time::Duration,
};
use tauri::{AppHandle, Manager};

const ACTIVE: &str =
    "'prepared','started','uncertain','approved','commit_failed','completion_pending'";
// Config writes and first local preparation share this native gate. A renderer
// cannot begin a payment between the unresolved-work check and secret mutation.
pub(crate) static REGISTRATION_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub(crate) struct RegistrationGuard {
    _file: File,
    _process: tokio::sync::MutexGuard<'static, ()>,
}

fn try_registration_file_lock(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options
        .open(path)
        .map_err(|_| "Could not open this till's terminal registration safety lock.")?;
    file.try_lock_exclusive().map_err(|_| "Another running POS process is preparing a payment or changing this till's registration/database. Close the other copy or wait for it to finish; no new payment was sent.")?;
    Ok(file)
}

pub(crate) async fn registration_guard(app: &AppHandle) -> Result<RegistrationGuard, String> {
    let process = REGISTRATION_GATE.lock().await;
    let directory = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&directory)
        .map_err(|_| "Could not open the terminal registration safety folder.")?;
    let file = try_registration_file_lock(&directory.join("payment-terminal-registration.lock"))?;
    Ok(RegistrationGuard {
        _file: file,
        _process: process,
    })
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TerminalOwnership {
    Dedicated,
    Shared,
}
impl Default for TerminalOwnership {
    fn default() -> Self {
        Self::Shared
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTerminalLock {
    terminal_key: String,
    till_id: String,
    till_name: String,
    payment_reference: String,
    acquired_at: String,
    expires_at: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTerminalLockResult {
    acquired: bool,
    lock: Option<LocalTerminalLock>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTerminalAttempt {
    pub id: String,
    pub provider: String,
    pub terminal_key: String,
    pub client_transaction_id: String,
    pub terminal_session_id: String,
    pub operation_kind: String,
    pub amount: i64,
    pub expected_provider_amount: i64,
    pub currency: String,
    pub status: String,
    pub sale_bundle: String,
    pub provider_reference: String,
    #[serde(default)]
    pub operator_resolution: String,
    pub error: String,
    pub till_id: String,
    pub created_at: String,
    pub updated_at: String,
    pub journal_scope: String,
}

pub(crate) async fn connect(app: &AppHandle) -> Result<SqliteConnection, String> {
    let options = SqliteConnectOptions::new()
        .filename(crate::commerce::local_db_path(app)?)
        .create_if_missing(false)
        .busy_timeout(Duration::from_secs(5));
    SqliteConnection::connect_with(&options)
        .await
        .map_err(|e| e.to_string())
}

async fn has_table(conn: &mut SqliteConnection, table: &str) -> Result<bool, String> {
    let found: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?")
            .bind(table)
            .fetch_one(conn)
            .await
            .map_err(|e| e.to_string())?;
    Ok(found != 0)
}

pub(crate) async fn ensure_schema(conn: &mut SqliteConnection) -> Result<(), String> {
    // The normal SQLite migration owns the attempt table. Never silently
    // manufacture an empty recovery journal over a missing/damaged database.
    if !has_table(conn, "payment_terminal_attempts").await? {
        return Err("Open the till database before configuring a payment terminal.".into());
    }
    let columns = sqlx::query("PRAGMA table_info(payment_terminal_attempts)")
        .fetch_all(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
    if !columns
        .iter()
        .any(|row| row.try_get::<String, _>("name").ok().as_deref() == Some("journalScope"))
    {
        sqlx::query("ALTER TABLE payment_terminal_attempts ADD COLUMN journalScope TEXT NOT NULL DEFAULT 'shared'")
            .execute(&mut *conn).await.map_err(|e| e.to_string())?;
    }
    sqlx::query("CREATE TABLE IF NOT EXISTS local_payment_terminal_locks (terminalKey TEXT PRIMARY KEY, tillId TEXT NOT NULL, tillName TEXT NOT NULL, paymentReference TEXT NOT NULL, acquiredAt TEXT NOT NULL, expiresAt TEXT NOT NULL)")
        .execute(&mut *conn).await.map_err(|e| e.to_string())?;
    // A consumed request remains consumed even if the provider response is lost
    // or the process dies. Recovery queries the original reference instead.
    sqlx::query("CREATE TABLE IF NOT EXISTS local_payment_terminal_dispatches (attemptId TEXT NOT NULL, requestKey TEXT NOT NULL, createdAt TEXT NOT NULL, PRIMARY KEY (attemptId, requestKey))")
        .execute(conn).await.map_err(|e| e.to_string())?;
    Ok(())
}

fn identity(value: &str, name: &str, max: usize) -> Result<(), String> {
    if value.is_empty()
        || value.len() > max
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        return Err(format!("Invalid {name}"));
    }
    Ok(())
}

pub(crate) async fn assert_local_write_allowed(conn: &mut SqliteConnection) -> Result<(), String> {
    if !has_table(conn, "settings").await? {
        return Err("The till settings are unavailable; no payment was sent.".into());
    }
    let rows = sqlx::query("SELECT key, value FROM settings WHERE key IN ('restore_pending_mariadb_replace','restore_maintenance_owner','local_terminal_close_barrier')")
        .fetch_all(&mut *conn).await.map_err(|e| e.to_string())?;
    for row in rows {
        let key: String = row.try_get("key").map_err(|e| e.to_string())?;
        let value: String = row.try_get("value").map_err(|e| e.to_string())?;
        if value.trim().is_empty() || value == "0" {
            continue;
        }
        if key == "local_terminal_close_barrier" {
            let state: Value = serde_json::from_str(&value).map_err(|_| {
                "The report-close safety state cannot be verified; reconnect before a new payment."
            })?;
            if state.get("state").and_then(Value::as_str) == Some("idle") {
                continue;
            }
            return Err("WHOLE_SYSTEM_CLOSE_IN_PROGRESS: finish or cancel the report close before sending a new payment.".into());
        }
        return Err(
            "Database restore or maintenance is pending; no new terminal payment was sent.".into(),
        );
    }
    Ok(())
}

async fn acquire_in_transaction(
    conn: &mut SqliteConnection,
    terminal_key: &str,
    till_id: &str,
    till_name: &str,
    reference: &str,
    seconds: i64,
) -> Result<LocalTerminalLockResult, String> {
    for (value, name, max) in [
        (terminal_key, "terminal identity", 512),
        (till_id, "till identity", 128),
        (reference, "payment reference", 255),
    ] {
        identity(value, name, max)?;
    }
    let now = Utc::now();
    let stamp = now.to_rfc3339_opts(SecondsFormat::Millis, true);
    let expires = (now + ChronoDuration::seconds(seconds.clamp(30, 600)))
        .to_rfc3339_opts(SecondsFormat::Millis, true);
    sqlx::query("INSERT INTO local_payment_terminal_locks (terminalKey,tillId,tillName,paymentReference,acquiredAt,expiresAt) VALUES (?,?,?,?,?,?) ON CONFLICT(terminalKey) DO UPDATE SET tillId=excluded.tillId,tillName=excluded.tillName,paymentReference=excluded.paymentReference,acquiredAt=excluded.acquiredAt,expiresAt=excluded.expiresAt WHERE local_payment_terminal_locks.expiresAt <= ? OR (local_payment_terminal_locks.tillId=excluded.tillId AND local_payment_terminal_locks.paymentReference=excluded.paymentReference)")
        .bind(terminal_key).bind(till_id).bind(till_name.chars().take(255).collect::<String>()).bind(reference).bind(&stamp).bind(&expires).bind(&stamp)
        .execute(&mut *conn).await.map_err(|e| e.to_string())?;
    let row = sqlx::query("SELECT * FROM local_payment_terminal_locks WHERE terminalKey=?")
        .bind(terminal_key)
        .fetch_one(conn)
        .await
        .map_err(|e| e.to_string())?;
    let lock = LocalTerminalLock {
        terminal_key: row.try_get("terminalKey").map_err(|e| e.to_string())?,
        till_id: row.try_get("tillId").map_err(|e| e.to_string())?,
        till_name: row.try_get("tillName").map_err(|e| e.to_string())?,
        payment_reference: row.try_get("paymentReference").map_err(|e| e.to_string())?,
        acquired_at: row.try_get("acquiredAt").map_err(|e| e.to_string())?,
        expires_at: row.try_get("expiresAt").map_err(|e| e.to_string())?,
    };
    Ok(LocalTerminalLockResult {
        acquired: lock.till_id == till_id && lock.payment_reference == reference,
        lock: Some(lock),
    })
}

#[tauri::command]
pub async fn terminal_acquire_local_lock(
    app: AppHandle,
    terminal_key: String,
    till_id: String,
    till_name: String,
    payment_reference: String,
    lease_seconds: Option<i64>,
) -> Result<LocalTerminalLockResult, String> {
    let mut conn = connect(&app).await?;
    ensure_schema(&mut conn).await?;
    let mut tx = conn
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|e| e.to_string())?;
    let result = acquire_in_transaction(
        &mut tx,
        &terminal_key,
        &till_id,
        &till_name,
        &payment_reference,
        lease_seconds.unwrap_or(180),
    )
    .await?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(result)
}

#[tauri::command]
pub async fn terminal_refresh_local_lock(
    app: AppHandle,
    terminal_key: String,
    till_id: String,
    payment_reference: String,
    lease_seconds: Option<i64>,
) -> Result<bool, String> {
    let mut conn = connect(&app).await?;
    ensure_schema(&mut conn).await?;
    let now = Utc::now();
    let expires = (now + ChronoDuration::seconds(lease_seconds.unwrap_or(180).clamp(30, 600)))
        .to_rfc3339_opts(SecondsFormat::Millis, true);
    let result = sqlx::query("UPDATE local_payment_terminal_locks SET expiresAt=? WHERE terminalKey=? AND tillId=? AND paymentReference=? AND expiresAt>?")
        .bind(expires).bind(terminal_key).bind(till_id).bind(payment_reference).bind(now.to_rfc3339_opts(SecondsFormat::Millis,true))
        .execute(&mut conn).await.map_err(|e| e.to_string())?;
    Ok(result.rows_affected() == 1)
}

#[tauri::command]
pub async fn terminal_release_local_lock(
    app: AppHandle,
    terminal_key: String,
    till_id: String,
    payment_reference: String,
) -> Result<(), String> {
    let mut conn = connect(&app).await?;
    ensure_schema(&mut conn).await?;
    sqlx::query("DELETE FROM local_payment_terminal_locks WHERE terminalKey=? AND tillId=? AND paymentReference=?")
        .bind(terminal_key).bind(till_id).bind(payment_reference).execute(&mut conn).await.map_err(|e| e.to_string())?;
    Ok(())
}

fn validate_attempt(attempt: &LocalTerminalAttempt) -> Result<(), String> {
    identity(&attempt.id, "attempt reference", 255)?;
    identity(&attempt.till_id, "till identity", 128)?;
    if attempt.journal_scope != "local"
        || attempt.status != "prepared"
        || !matches!(attempt.provider.as_str(), "dojo" | "sumup")
        || !attempt
            .terminal_key
            .starts_with(&format!("{}:", attempt.provider))
        || !(1..=99_999_999).contains(&attempt.amount)
        || attempt.expected_provider_amount < 0
        || attempt.currency.len() != 3
        || !attempt.currency.bytes().all(|c| c.is_ascii_uppercase())
        || !attempt.operator_resolution.is_empty()
        || !attempt.provider_reference.is_empty()
        || !attempt.terminal_session_id.is_empty()
    {
        return Err("Invalid dedicated-terminal recovery journal".into());
    }
    if attempt.operation_kind != "refund" && !attempt.client_transaction_id.is_empty() {
        return Err("A new terminal sale cannot already contain a provider payment".into());
    }
    let payload: Value = serde_json::from_str(&attempt.sale_bundle)
        .map_err(|_| "Invalid payment recovery payload")?;
    let kind = if payload.get("kind").and_then(Value::as_str) == Some("customer_account_payment") {
        "customer_account_payment"
    } else if payload.pointer("/order/type").and_then(Value::as_str) == Some("return") {
        "refund"
    } else if payload.pointer("/order/type").and_then(Value::as_str) == Some("sale") {
        "sale"
    } else {
        return Err("The terminal attempt has no valid sale or account payload".into());
    };
    if attempt.operation_kind != kind {
        return Err("The terminal operation does not match its recovery payload".into());
    }
    Ok(())
}

async fn prepare(
    conn: &mut SqliteConnection,
    mut attempt: LocalTerminalAttempt,
) -> Result<LocalTerminalAttempt, String> {
    validate_attempt(&attempt)?;
    ensure_schema(conn).await?;
    let mut tx = conn
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|e| e.to_string())?;
    assert_local_write_allowed(&mut tx).await?;
    require_this_till(&mut tx, &attempt.till_id).await?;
    let conflicts: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM payment_terminal_attempts WHERE terminalKey=? AND status IN ({ACTIVE})"))
        .bind(&attempt.terminal_key).fetch_one(&mut *tx).await.map_err(|e| e.to_string())?;
    if conflicts != 0 {
        return Err("This terminal has an earlier unresolved payment. Check payment recovery before trying again; no new payment was sent.".into());
    }
    let lock = acquire_in_transaction(
        &mut tx,
        &attempt.terminal_key,
        &attempt.till_id,
        "This till",
        &attempt.id,
        180,
    )
    .await?;
    if !lock.acquired {
        return Err("This terminal is already reserved by another operation on this till.".into());
    }
    let stamp = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    attempt.created_at = stamp.clone();
    attempt.updated_at = stamp;
    sqlx::query("INSERT INTO payment_terminal_attempts (id,provider,terminalKey,clientTransactionId,terminalSessionId,operationKind,amount,expectedProviderAmount,currency,status,saleBundle,providerReference,operatorResolution,error,tillId,createdAt,updatedAt,journalScope) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(&attempt.id).bind(&attempt.provider).bind(&attempt.terminal_key).bind(&attempt.client_transaction_id).bind(&attempt.terminal_session_id)
        .bind(&attempt.operation_kind).bind(attempt.amount).bind(attempt.expected_provider_amount).bind(&attempt.currency).bind(&attempt.status)
        .bind(&attempt.sale_bundle).bind(&attempt.provider_reference).bind(&attempt.operator_resolution).bind(&attempt.error).bind(&attempt.till_id)
        .bind(&attempt.created_at).bind(&attempt.updated_at).bind(&attempt.journal_scope)
        .execute(&mut *tx).await.map_err(|e| format!("Could not reserve the local payment journal: {e}"))?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(attempt)
}

#[tauri::command]
pub async fn terminal_prepare_local_attempt(
    app: AppHandle,
    attempt: LocalTerminalAttempt,
) -> Result<LocalTerminalAttempt, String> {
    let _registration = registration_guard(&app).await?;
    match attempt.provider.as_str() {
        "dojo" => crate::dojo::validate_local_registration(
            &app,
            &attempt.terminal_key,
            &attempt.currency,
        )?,
        "sumup" => crate::sumup::validate_local_registration(
            &app,
            &attempt.terminal_key,
            &attempt.currency,
        )?,
        _ => return Err("Unknown payment provider".into()),
    }
    prepare(&mut connect(&app).await?, attempt).await
}

async fn require_this_till(conn: &mut SqliteConnection, till_id: &str) -> Result<(), String> {
    let current: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key='till_id'")
            .fetch_optional(conn)
            .await
            .map_err(|e| e.to_string())?;
    if current.as_deref().filter(|id| !id.is_empty()) != Some(till_id) {
        return Err("The dedicated payment belongs to a different till or this till has not been registered. No new request was sent.".into());
    }
    Ok(())
}

pub(crate) async fn require_lease(
    conn: &mut SqliteConnection,
    terminal_key: &str,
    till_id: &str,
    reference: &str,
) -> Result<(), String> {
    require_this_till(conn, till_id).await?;
    let valid: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM local_payment_terminal_locks WHERE terminalKey=? AND tillId=? AND paymentReference=? AND expiresAt>?")
        .bind(terminal_key).bind(till_id).bind(reference).bind(Utc::now().to_rfc3339_opts(SecondsFormat::Millis,true))
        .fetch_one(conn).await.map_err(|e| e.to_string())?;
    if valid != 1 {
        return Err("The payment no longer owns this till's terminal reservation. Check the original payment before trying again.".into());
    }
    Ok(())
}

/// Consume a local provider request once, in the same transaction that checks
/// its durable journal and reservation. Recovery/status/cancel are not gated.
pub(crate) async fn reserve_dispatch(
    app: &AppHandle,
    provider: &str,
    attempt_id: &str,
    terminal_key: &str,
    amount: i64,
    currency: &str,
    ownership: TerminalOwnership,
    request_key: &str,
    original_provider_id: Option<&str>,
) -> Result<(), String> {
    let mut conn = connect(app).await?;
    ensure_schema(&mut conn).await?;
    let mut tx = conn
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|e| e.to_string())?;
    reserve_dispatch_in_transaction(
        &mut tx,
        provider,
        attempt_id,
        terminal_key,
        amount,
        currency,
        ownership,
        request_key,
        original_provider_id,
    )
    .await?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(())
}

async fn reserve_dispatch_in_transaction(
    conn: &mut SqliteConnection,
    provider: &str,
    attempt_id: &str,
    terminal_key: &str,
    amount: i64,
    currency: &str,
    ownership: TerminalOwnership,
    request_key: &str,
    original_provider_id: Option<&str>,
) -> Result<(), String> {
    let row = sqlx::query("SELECT terminalKey,amount,currency,status,tillId,journalScope,operationKind,clientTransactionId FROM payment_terminal_attempts WHERE id=? AND provider=?")
        .bind(attempt_id).bind(provider).fetch_optional(&mut *conn).await.map_err(|e| e.to_string())?
        .ok_or("The durable payment journal is missing; no card request was sent.")?;
    let scope: String = row.try_get("journalScope").map_err(|e| e.to_string())?;
    if scope == "shared" && ownership == TerminalOwnership::Shared {
        return Ok(());
    }
    if scope != "local" || ownership != TerminalOwnership::Dedicated {
        return Err("The payment's terminal ownership changed. Recover its original journal before starting a new payment.".into());
    }
    assert_local_write_allowed(conn).await?;
    let stored_key: String = row.try_get("terminalKey").map_err(|e| e.to_string())?;
    let stored_amount: i64 = row.try_get("amount").map_err(|e| e.to_string())?;
    let stored_currency: String = row.try_get("currency").map_err(|e| e.to_string())?;
    let status: String = row.try_get("status").map_err(|e| e.to_string())?;
    let till: String = row.try_get("tillId").map_err(|e| e.to_string())?;
    let operation: String = row.try_get("operationKind").map_err(|e| e.to_string())?;
    let original: String = row
        .try_get("clientTransactionId")
        .map_err(|e| e.to_string())?;
    let operation_matches = if request_key == "refund" {
        operation == "refund"
            && !original.is_empty()
            && original_provider_id == Some(original.as_str())
    } else if request_key.starts_with("retry:") {
        matches!(operation.as_str(), "sale" | "customer_account_payment")
            && !original.is_empty()
            && original_provider_id == Some(original.as_str())
    } else {
        request_key == "create"
            && matches!(operation.as_str(), "sale" | "customer_account_payment")
            && original.is_empty()
            && original_provider_id.is_none()
    };
    if !operation_matches {
        return Err("The provider operation or original payment does not match its durable journal; no request was sent.".into());
    }
    if stored_key != terminal_key
        || stored_amount != amount
        || stored_currency != currency
        || !matches!(status.as_str(), "prepared" | "started")
    {
        return Err(
            "The terminal request does not match its prepared payment. No new payment was sent."
                .into(),
        );
    }
    require_lease(conn, terminal_key, &till, attempt_id).await?;
    sqlx::query("INSERT INTO local_payment_terminal_dispatches(attemptId,requestKey,createdAt) VALUES(?,?,?)")
        .bind(attempt_id).bind(request_key).bind(Utc::now().to_rfc3339_opts(SecondsFormat::Millis,true))
        .execute(conn).await.map_err(|_| "This payment request was already sent or its outcome is uncertain. Use Check payment results; do not charge again.".to_string())?;
    Ok(())
}

pub(crate) async fn attempt_scope(app: &AppHandle, attempt_id: &str) -> Result<String, String> {
    let mut conn = connect(app).await?;
    ensure_schema(&mut conn).await?;
    sqlx::query_scalar("SELECT journalScope FROM payment_terminal_attempts WHERE id=?")
        .bind(attempt_id)
        .fetch_one(&mut conn)
        .await
        .map_err(|e| e.to_string())
}

/// Configuration changes must never discard the credentials/identity required
/// to resolve an earlier payment. Shared -> dedicated is a one-time handover,
/// not an automatic response to a MariaDB outage.
pub(crate) async fn guard_configuration_change(
    app: &AppHandle,
    provider: &str,
    old_terminal_key: &str,
    old_ownership: TerminalOwnership,
    mysql_uri: Option<&str>,
) -> Result<(), String> {
    let mut conn = connect(app).await?;
    if has_table(&mut conn, "payment_terminal_attempts").await? {
        let active: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM payment_terminal_attempts WHERE provider=? AND status IN ({ACTIVE})"))
            .bind(provider).fetch_one(&mut conn).await.map_err(|e| e.to_string())?;
        if active != 0 {
            return Err("Resolve this provider's outstanding payments before changing or removing its terminal, credentials, or ownership.".into());
        }
    }
    if old_ownership == TerminalOwnership::Shared && !old_terminal_key.is_empty() {
        let uri = mysql_uri.filter(|value| !value.trim().is_empty())
            .ok_or("This previously shared terminal needs a one-time MariaDB connection to check that no other till has an unresolved payment before its registration changes. New dedicated terminals do not need MariaDB.")?;
        let options: sqlx::mysql::MySqlConnectOptions = uri
            .parse()
            .map_err(|_| "Invalid shared journal connection")?;
        let mut remote = tokio::time::timeout(Duration::from_secs(8), sqlx::MySqlConnection::connect_with(&options)).await
            .map_err(|_| "The old shared journal could not be checked. Reconnect once before switching ownership.")?
            .map_err(|_| "The old shared journal could not be checked. Reconnect once before switching ownership.")?;
        let active: i64 = sqlx::query_scalar(&format!("SELECT CAST(COUNT(*) AS SIGNED) FROM payment_terminal_attempts WHERE terminalKey=? AND status IN ({ACTIVE})"))
            .bind(old_terminal_key).fetch_one(&mut remote).await.map_err(|_| "Could not verify outstanding shared terminal payments; registration was not changed.")?;
        let reserved: i64 = sqlx::query_scalar("SELECT CAST(COUNT(*) AS SIGNED) FROM payment_terminal_locks WHERE terminalKey=? AND expiresAt>UTC_TIMESTAMP(3)")
            .bind(old_terminal_key).fetch_one(&mut remote).await.map_err(|_| "Could not verify the old shared terminal reservation; registration was not changed.")?;
        if active != 0 || reserved != 0 {
            return Err("The previously shared terminal still has an unresolved payment or active reservation. Resolve it on its original till before registering this terminal as dedicated.".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn registration_file_lock_excludes_another_handle_and_recovers_on_drop() {
        let path = std::env::temp_dir().join(format!(
            "lbj-terminal-lock-test-{:x}.lock",
            rand::random::<u64>()
        ));
        let first = try_registration_file_lock(&path).unwrap();
        assert!(try_registration_file_lock(&path)
            .unwrap_err()
            .contains("Another running POS"));
        drop(first);
        let next = try_registration_file_lock(&path).unwrap();
        drop(next);
        std::fs::remove_file(path).unwrap();
    }

    fn run(test: impl std::future::Future<Output = ()>) {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(test);
    }
    async fn schema(conn: &mut SqliteConnection) {
        sqlx::query("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)")
            .execute(&mut *conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO settings VALUES('till_id','till-a')")
            .execute(&mut *conn)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE payment_terminal_attempts(id TEXT PRIMARY KEY,provider TEXT NOT NULL,terminalKey TEXT NOT NULL,clientTransactionId TEXT NOT NULL DEFAULT '',terminalSessionId TEXT NOT NULL DEFAULT '',operationKind TEXT NOT NULL,amount INTEGER NOT NULL,expectedProviderAmount INTEGER NOT NULL,currency TEXT NOT NULL,status TEXT NOT NULL,saleBundle TEXT NOT NULL,providerReference TEXT NOT NULL DEFAULT '',operatorResolution TEXT NOT NULL DEFAULT '',error TEXT NOT NULL DEFAULT '',tillId TEXT NOT NULL,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL)").execute(conn).await.unwrap();
    }
    async fn db() -> SqliteConnection {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        schema(&mut conn).await;
        conn
    }
    fn attempt(id: &str) -> LocalTerminalAttempt {
        LocalTerminalAttempt {
            id: id.into(),
            provider: "dojo".into(),
            terminal_key: "dojo:fixture:terminal-a".into(),
            client_transaction_id: String::new(),
            terminal_session_id: String::new(),
            operation_kind: "sale".into(),
            amount: 1234,
            expected_provider_amount: 1234,
            currency: "GBP".into(),
            status: "prepared".into(),
            sale_bundle: json!({"order":{"id":id,"type":"sale"},"payment":{"cardAmount":1234}})
                .to_string(),
            provider_reference: String::new(),
            operator_resolution: String::new(),
            error: String::new(),
            till_id: "till-a".into(),
            created_at: "untrusted renderer time".into(),
            updated_at: "untrusted renderer time".into(),
            journal_scope: "local".into(),
        }
    }
    async fn dispatch(
        conn: &mut SqliteConnection,
        candidate: &LocalTerminalAttempt,
        key: &str,
    ) -> Result<(), String> {
        reserve_dispatch_in_transaction(
            conn,
            &candidate.provider,
            &candidate.id,
            &candidate.terminal_key,
            candidate.amount,
            &candidate.currency,
            TerminalOwnership::Dedicated,
            key,
            if key == "create" {
                None
            } else {
                Some("payment-one")
            },
        )
        .await
    }

    #[test]
    fn preparation_and_reservation_are_atomic_and_idempotent_acquire_is_safe() {
        run(async {
            let mut conn = db().await;
            let saved = prepare(&mut conn, attempt("one")).await.unwrap();
            assert_eq!(saved.journal_scope, "local");
            assert_ne!(saved.created_at, "untrusted renderer time");
            assert!(
                acquire_in_transaction(
                    &mut conn,
                    &saved.terminal_key,
                    "till-a",
                    "Till One",
                    "one",
                    180
                )
                .await
                .unwrap()
                .acquired
            );
            assert!(
                !acquire_in_transaction(
                    &mut conn,
                    &saved.terminal_key,
                    "till-a",
                    "Another operation",
                    "two",
                    180
                )
                .await
                .unwrap()
                .acquired
            );
            assert!(prepare(&mut conn, attempt("two"))
                .await
                .unwrap_err()
                .contains("unresolved"));
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM payment_terminal_attempts")
                .fetch_one(&mut conn)
                .await
                .unwrap();
            assert_eq!(count, 1);
        });
    }

    #[test]
    fn expired_lease_does_not_discard_an_unresolved_payment() {
        run(async {
            let mut conn = db().await;
            let saved = prepare(&mut conn, attempt("one")).await.unwrap();
            sqlx::query(
                "UPDATE local_payment_terminal_locks SET expiresAt='2000-01-01T00:00:00.000Z'",
            )
            .execute(&mut conn)
            .await
            .unwrap();
            assert!(prepare(&mut conn, attempt("two"))
                .await
                .unwrap_err()
                .contains("unresolved"));
            assert!(dispatch(&mut conn, &saved, "create")
                .await
                .unwrap_err()
                .contains("reservation"));
            assert!(
                acquire_in_transaction(
                    &mut conn,
                    &saved.terminal_key,
                    "till-a",
                    "Recovery",
                    "recovery-one",
                    600
                )
                .await
                .unwrap()
                .acquired
            );
            require_lease(&mut conn, &saved.terminal_key, "till-a", "recovery-one")
                .await
                .unwrap();
        });
    }

    #[test]
    fn provider_dispatch_is_once_per_create_and_once_per_retry_session() {
        run(async {
            let mut conn = db().await;
            let saved = prepare(&mut conn, attempt("one")).await.unwrap();
            dispatch(&mut conn, &saved, "create").await.unwrap();
            assert!(dispatch(&mut conn, &saved, "create")
                .await
                .unwrap_err()
                .contains("already sent"));
            sqlx::query("UPDATE payment_terminal_attempts SET clientTransactionId='payment-one'")
                .execute(&mut conn)
                .await
                .unwrap();
            dispatch(&mut conn, &saved, "retry:session-one")
                .await
                .unwrap();
            assert!(dispatch(&mut conn, &saved, "retry:session-one")
                .await
                .is_err());
            dispatch(&mut conn, &saved, "retry:session-two")
                .await
                .unwrap();
        });
    }

    #[test]
    fn incorrect_amount_currency_terminal_state_or_ownership_never_dispatches() {
        run(async {
            let mut conn = db().await;
            let saved = prepare(&mut conn, attempt("one")).await.unwrap();
            let mut wrong = saved.clone();
            wrong.amount += 1;
            assert!(dispatch(&mut conn, &wrong, "create").await.is_err());
            wrong = saved.clone();
            wrong.currency = "EUR".into();
            assert!(dispatch(&mut conn, &wrong, "create").await.is_err());
            wrong = saved.clone();
            wrong.terminal_key = "dojo:fixture:terminal-b".into();
            assert!(dispatch(&mut conn, &wrong, "create").await.is_err());
            assert!(reserve_dispatch_in_transaction(
                &mut conn,
                "dojo",
                "one",
                &saved.terminal_key,
                1234,
                "GBP",
                TerminalOwnership::Shared,
                "create",
                None
            )
            .await
            .is_err());
            sqlx::query("UPDATE payment_terminal_attempts SET status='approved'")
                .execute(&mut conn)
                .await
                .unwrap();
            assert!(dispatch(&mut conn, &saved, "create").await.is_err());
            let count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM local_payment_terminal_dispatches")
                    .fetch_one(&mut conn)
                    .await
                    .unwrap();
            assert_eq!(count, 0);
        });
    }

    #[test]
    fn legacy_shared_attempts_stay_shared_and_block_new_local_work() {
        run(async {
            let mut conn = db().await;
            let saved = prepare(&mut conn, attempt("one")).await.unwrap();
            sqlx::query("UPDATE payment_terminal_attempts SET journalScope='shared'")
                .execute(&mut conn)
                .await
                .unwrap();
            assert!(prepare(&mut conn, attempt("two")).await.is_err());
            assert!(dispatch(&mut conn, &saved, "create")
                .await
                .unwrap_err()
                .contains("ownership"));
            reserve_dispatch_in_transaction(
                &mut conn,
                "dojo",
                "one",
                &saved.terminal_key,
                1234,
                "GBP",
                TerminalOwnership::Shared,
                "create",
                None,
            )
            .await
            .unwrap();
            let count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM local_payment_terminal_dispatches")
                    .fetch_one(&mut conn)
                    .await
                    .unwrap();
            assert_eq!(count, 0);
        });
    }

    #[test]
    fn local_barrier_and_restore_fences_apply_before_prepare_and_dispatch() {
        run(async {
            for (key, value) in [
                (
                    "local_terminal_close_barrier",
                    r#"{"state":"preparing","token":"close-one"}"#,
                ),
                (
                    "local_terminal_close_barrier",
                    r#"{"state":"frozen","token":"close-one"}"#,
                ),
                ("local_terminal_close_barrier", "broken"),
                ("restore_pending_mariadb_replace", "1"),
                ("restore_maintenance_owner", "till-a"),
            ] {
                let mut conn = db().await;
                let saved = prepare(&mut conn, attempt("one")).await.unwrap();
                sqlx::query("INSERT INTO settings VALUES(?,?)")
                    .bind(key)
                    .bind(value)
                    .execute(&mut conn)
                    .await
                    .unwrap();
                assert!(
                    dispatch(&mut conn, &saved, "create").await.is_err(),
                    "{key}:{value}"
                );
                let mut other = attempt("two");
                other.terminal_key = "dojo:fixture:terminal-b".into();
                assert!(prepare(&mut conn, other).await.is_err(), "{key}:{value}");
                sqlx::query("DELETE FROM settings WHERE key<>'till_id'")
                    .execute(&mut conn)
                    .await
                    .unwrap();
                dispatch(&mut conn, &saved, "create").await.unwrap();
            }
        });
    }

    #[test]
    fn invalid_preparation_never_acquires_a_lease_or_inserts_a_journal() {
        run(async {
            let mut conn = db().await;
            ensure_schema(&mut conn).await.unwrap();
            for change in 0..6 {
                let mut candidate = attempt("one");
                match change {
                    0 => candidate.journal_scope = "shared".into(),
                    1 => candidate.amount = 0,
                    2 => candidate.status = "approved".into(),
                    3 => candidate.operator_resolution = "forged".into(),
                    4 => candidate.operation_kind = "refund".into(),
                    _ => candidate.client_transaction_id = "already-paid".into(),
                }
                assert!(prepare(&mut conn, candidate).await.is_err());
            }
            let count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM local_payment_terminal_locks")
                    .fetch_one(&mut conn)
                    .await
                    .unwrap();
            assert_eq!(count, 0);
        });
    }

    #[test]
    fn refunds_are_bound_to_the_original_provider_payment_and_operation() {
        run(async {
            let mut conn = db().await;
            let sale = prepare(&mut conn, attempt("one")).await.unwrap();
            assert!(dispatch(&mut conn, &sale, "refund")
                .await
                .unwrap_err()
                .contains("operation"));
            sqlx::query("UPDATE payment_terminal_attempts SET operationKind='refund',clientTransactionId='payment-one'").execute(&mut conn).await.unwrap();
            assert!(dispatch(&mut conn, &sale, "create")
                .await
                .unwrap_err()
                .contains("operation"));
            assert!(dispatch(&mut conn, &sale, "retry:session-one")
                .await
                .unwrap_err()
                .contains("operation"));
            assert!(reserve_dispatch_in_transaction(
                &mut conn,
                "dojo",
                "one",
                &sale.terminal_key,
                1234,
                "GBP",
                TerminalOwnership::Dedicated,
                "refund",
                Some("wrong-original")
            )
            .await
            .is_err());
            dispatch(&mut conn, &sale, "refund").await.unwrap();
            assert!(dispatch(&mut conn, &sale, "refund")
                .await
                .unwrap_err()
                .contains("already sent"));
        });
    }

    #[test]
    fn a_different_till_cannot_prepare_or_dispatch_a_local_payment() {
        run(async {
            let mut conn = db().await;
            let mut other = attempt("other");
            other.till_id = "till-b".into();
            assert!(prepare(&mut conn, other)
                .await
                .unwrap_err()
                .contains("different till"));
            let sale = prepare(&mut conn, attempt("one")).await.unwrap();
            sqlx::query("UPDATE settings SET value='till-b' WHERE key='till_id'")
                .execute(&mut conn)
                .await
                .unwrap();
            assert!(dispatch(&mut conn, &sale, "create")
                .await
                .unwrap_err()
                .contains("different till"));
        });
    }

    #[test]
    fn journal_and_dispatch_survive_connection_restart_without_any_mysql() {
        run(async {
            let path = std::env::temp_dir().join(format!(
                "lbj-terminal-test-{:x}.sqlite",
                rand::random::<u64>()
            ));
            let options = SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true);
            let mut first = SqliteConnection::connect_with(&options).await.unwrap();
            schema(&mut first).await;
            let saved = prepare(&mut first, attempt("one")).await.unwrap();
            dispatch(&mut first, &saved, "create").await.unwrap();
            first.close().await.unwrap();
            let mut second = SqliteConnection::connect_with(&options).await.unwrap();
            assert!(dispatch(&mut second, &saved, "create")
                .await
                .unwrap_err()
                .contains("already sent"));
            assert!(prepare(&mut second, attempt("two"))
                .await
                .unwrap_err()
                .contains("unresolved"));
            let scope: String = sqlx::query_scalar(
                "SELECT journalScope FROM payment_terminal_attempts WHERE id='one'",
            )
            .fetch_one(&mut second)
            .await
            .unwrap();
            assert_eq!(scope, "local");
            second.close().await.unwrap();
            std::fs::remove_file(path).unwrap();
        });
    }
}
