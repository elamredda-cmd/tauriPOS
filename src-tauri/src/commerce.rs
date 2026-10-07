use base64::{engine::general_purpose::STANDARD as STANDARD_BASE64, Engine as _};
use rand::{rngs::OsRng, RngCore};
use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::mysql::{MySqlConnection, MySqlPoolOptions, MySqlRow};
use sqlx::sqlite::{SqliteConnection, SqlitePoolOptions, SqliteRow};
use sqlx::{MySql, MySqlPool, QueryBuilder, Row, SqlitePool, ValueRef};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::PathBuf,
    thread,
    time::Duration,
};
use tauri::{AppHandle, Manager};

fn deserialize_boolish<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Boolish {
        Bool(bool),
        Integer(i64),
    }

    match Boolish::deserialize(deserializer)? {
        Boolish::Bool(value) => Ok(value),
        Boolish::Integer(0) => Ok(false),
        Boolish::Integer(1) => Ok(true),
        Boolish::Integer(value) => Err(de::Error::custom(format!(
            "invalid boolean integer {value}; expected 0 or 1"
        ))),
    }
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OrderRecord {
    pub id: String,
    pub shift_id: String,
    pub customer_id: String,
    pub employee_id: String,
    pub order_number: i64,
    pub receipt_key: String,
    #[serde(rename = "type")]
    pub order_type: String,
    pub status: String,
    pub original_order_id: String,
    pub subtotal: i64,
    pub discount_id: String,
    pub discount_amount: i64,
    pub tax_total: i64,
    pub total: i64,
    pub till_number: String,
    pub notes: String,
    pub payment_method: String,
    pub amount_tendered: i64,
    pub created_at: String,
    pub completed_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OrderLineRecord {
    pub id: String,
    pub order_id: String,
    pub product_id: String,
    pub product_name: String,
    pub quantity: i64,
    pub unit_price: i64,
    pub cost_price: i64,
    pub discount_id: String,
    pub discount_amount: i64,
    pub tax_rate: f64,
    pub tax_amount: i64,
    pub line_total: i64,
    #[serde(deserialize_with = "deserialize_boolish")]
    pub is_price_override: bool,
    pub original_price: i64,
    pub notes: String,
    pub updated_at: String,
}

fn is_zero_terminal_amount(value: &i64) -> bool {
    *value == 0
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PaymentRecord {
    pub id: String,
    pub order_id: String,
    pub method: String,
    pub amount: i64,
    pub cash_amount: i64,
    pub card_amount: i64,
    /// Provider additions, separate from the product tender allocation.
    #[serde(default, skip_serializing_if = "is_zero_terminal_amount")]
    pub tips_amount: i64,
    #[serde(default, skip_serializing_if = "is_zero_terminal_amount")]
    pub service_charge_amount: i64,
    #[serde(default, skip_serializing_if = "is_zero_terminal_amount")]
    pub cashback_amount: i64,
    #[serde(default)]
    pub loyalty_amount: i64,
    #[serde(default)]
    pub account_amount: i64,
    pub reference: String,
    pub change_given: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CustomerAccountRecord {
    pub id: String,
    pub customer_id: String,
    pub is_enabled: bool,
    pub credit_limit_pence: i64,
    pub balance_pence: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CustomerAccountChange {
    pub id: String,
    pub customer_id: String,
    #[serde(default)]
    pub order_id: String,
    pub entry_type: String,
    pub amount_pence: i64,
    #[serde(default)]
    pub payment_method: String,
    #[serde(default, skip_serializing_if = "is_zero_terminal_amount")]
    pub tips_amount: i64,
    #[serde(default, skip_serializing_if = "is_zero_terminal_amount")]
    pub service_charge_amount: i64,
    #[serde(default, skip_serializing_if = "is_zero_terminal_amount")]
    pub cashback_amount: i64,
    #[serde(default)]
    pub reference: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub receipt_number: i64,
    #[serde(default)]
    pub receipt_key: String,
    #[serde(default)]
    pub employee_id: String,
    #[serde(default)]
    pub till_number: String,
    #[serde(default)]
    pub shift_id: String,
    pub idempotency_key: String,
    #[serde(default)]
    pub reverses_entry_id: String,
    #[serde(default)]
    pub allow_credit_balance: bool,
    #[serde(default)]
    pub balance_after_pence: i64,
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub report_epoch: String,
    #[serde(default)]
    pub server_data_epoch: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CustomerAccountEntryRecord {
    pub id: String,
    pub account_id: String,
    pub customer_id: String,
    pub order_id: String,
    pub entry_type: String,
    pub amount_pence: i64,
    pub payment_method: String,
    #[serde(default, skip_serializing_if = "is_zero_terminal_amount")]
    pub tips_amount: i64,
    #[serde(default, skip_serializing_if = "is_zero_terminal_amount")]
    pub service_charge_amount: i64,
    #[serde(default, skip_serializing_if = "is_zero_terminal_amount")]
    pub cashback_amount: i64,
    pub reference: String,
    pub description: String,
    pub receipt_number: i64,
    pub receipt_key: String,
    pub employee_id: String,
    pub till_number: String,
    pub shift_id: String,
    pub idempotency_key: String,
    pub reverses_entry_id: String,
    pub balance_after_pence: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SaveCustomerAccountConfigInput {
    pub customer_id: String,
    pub is_enabled: bool,
    pub credit_limit_pence: i64,
    #[serde(default)]
    pub employee_id: String,
    #[serde(default)]
    pub server_data_epoch: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CustomerAccountMutationResult {
    pub account: CustomerAccountRecord,
    pub entry: CustomerAccountEntryRecord,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CustomerDeletionResult {
    pub customer_id: String,
    pub account_ids: Vec<String>,
    pub already_deleted: bool,
    pub deleted_at: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReportMarkerRecord {
    pub id: String,
    pub till_number: String,
    #[serde(rename = "type")]
    pub marker_type: String,
    pub marker_time: String,
    pub period_start: String,
    pub period_end: String,
    pub employee_id: String,
    pub report_text: String,
    pub report_total: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FinishWholeSystemCloseInput {
    pub token: String,
    pub owner_till_id: String,
    pub id: String,
    pub expected_last_marker: Option<String>,
    pub period_start: String,
    #[serde(default)]
    pub employee_id: String,
    #[serde(default)]
    pub report_text: String,
    #[serde(default)]
    pub report_total: i64,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommitTillReportCloseInput {
    pub id: String,
    pub till_number: String,
    pub expected_last_marker: Option<String>,
    pub period_start: String,
    pub period_end: String,
    #[serde(default)]
    pub employee_id: String,
    #[serde(default)]
    pub report_text: String,
    #[serde(default)]
    pub report_total: i64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WholeSystemCloseBarrierResult {
    pub token: String,
    pub state: String,
    pub owner_till_id: String,
    pub requested_at: String,
    pub expires_at: String,
    pub cutoff_at: String,
    pub latest_marker: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FrozenSalesOverview {
    pub total_revenue: i64,
    pub total_transactions: i64,
    pub refund_transactions: i64,
    pub avg_transaction_value: i64,
    pub total_items_sold: i64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FrozenPaymentBreakdown {
    pub total_cash: i64,
    pub total_card: i64,
    pub tips_total: i64,
    pub service_charge_total: i64,
    pub cashback_total: i64,
    pub total_loyalty: i64,
    pub total_account: i64,
    pub cash_tx_count: i64,
    pub card_tx_count: i64,
    pub split_tx_count: i64,
    pub loyalty_tx_count: i64,
    pub account_tx_count: i64,
    pub account_charges: i64,
    pub account_repayments_cash: i64,
    pub account_repayments_card: i64,
    pub account_repayments_other: i64,
    pub account_tips_total: i64,
    pub account_service_charge_total: i64,
    pub account_cashback_total: i64,
    pub account_adjustments: i64,
    pub opening_account_owed: i64,
    pub closing_account_owed: i64,
    pub account_activity_scope: String,
    pub total_amount: i64,
    pub unrecorded_amount: i64,
    pub unrecorded_tx_count: i64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FrozenTopProduct {
    pub name: String,
    pub sku: String,
    pub qty_sold: i64,
    pub total_revenue: i64,
    pub avg_price: i64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FrozenTillSalesSummary {
    pub id: String,
    pub name: String,
    pub net_sales: i64,
    pub gross_sales: i64,
    pub refunds: i64,
    pub tax_total: i64,
    pub transactions: i64,
    pub refund_transactions: i64,
    pub items_sold: i64,
    pub cash_total: i64,
    pub card_total: i64,
    pub tips_total: i64,
    pub service_charge_total: i64,
    pub cashback_total: i64,
    pub loyalty_total: i64,
    pub account_total: i64,
    pub account_repayments_cash: i64,
    pub account_repayments_card: i64,
    pub account_repayments_other: i64,
    pub account_tips_total: i64,
    pub account_service_charge_total: i64,
    pub account_cashback_total: i64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FrozenWholeSystemReport {
    pub token: String,
    pub cutoff_at: String,
    pub period_start: String,
    pub expected_last_marker: Option<String>,
    pub overview: FrozenSalesOverview,
    pub breakdown: FrozenPaymentBreakdown,
    pub top_products: Vec<FrozenTopProduct>,
    pub till_summaries: Vec<FrozenTillSalesSummary>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PreparedTillReportClose {
    pub expected_last_marker: Option<String>,
    pub period_start: String,
    pub cutoff_at: String,
    pub overview: FrozenSalesOverview,
    pub breakdown: FrozenPaymentBreakdown,
    pub top_products: Vec<FrozenTopProduct>,
    pub till_summaries: Vec<FrozenTillSalesSummary>,
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StockChange {
    pub product_id: String,
    pub delta: i64,
    pub log_id: String,
    pub employee_id: String,
    pub notes: String,
    #[serde(default = "default_sale_movement")]
    pub movement_type: String,
}

fn default_sale_movement() -> String {
    "sale".into()
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuditRecord {
    pub id: String,
    pub employee_id: String,
    pub action: String,
    pub entity_type: String,
    pub entity_id: String,
    pub old_data: String,
    pub new_data: String,
    pub created_at: String,
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoyaltyChange {
    pub id: String,
    pub customer_id: String,
    pub order_id: String,
    pub points_change: i64,
    pub reason: String,
    pub created_at: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CustomerLoyaltyAdjustmentInput {
    pub id: String,
    pub customer_id: String,
    pub expected_points: i64,
    pub new_points: i64,
    pub reason: String,
    pub employee_id: String,
    pub actor_expected_updated_at: String,
    pub created_at: String,
    #[serde(default)]
    pub server_data_epoch: String,
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CustomerLoyaltyAdjustmentEntry {
    pub id: String,
    pub customer_id: String,
    pub order_id: String,
    pub points_change: i64,
    pub reason: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CustomerLoyaltyAdjustmentResult {
    pub customer_id: String,
    pub loyalty_points: i64,
    pub customer_updated_at: String,
    pub entry: CustomerLoyaltyAdjustmentEntry,
    pub audit: AuditRecord,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SaleBundle {
    #[serde(default)]
    pub report_epoch: String,
    #[serde(default)]
    pub server_data_epoch: String,
    pub order: OrderRecord,
    pub lines: Vec<OrderLineRecord>,
    pub payment: PaymentRecord,
    pub stock_changes: Vec<StockChange>,
    #[serde(default)]
    pub loyalty_changes: Vec<LoyaltyChange>,
    #[serde(default)]
    pub account_changes: Vec<CustomerAccountChange>,
    pub audit: AuditRecord,
    #[serde(default)]
    pub original_order_to_update: Option<String>,
    #[serde(default)]
    pub original_status_update: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommitSaleResult {
    pub bundle: SaleBundle,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TransactionPurgeResult {
    pub marker: String,
    pub till_numbers: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StockReceiptRecord {
    pub id: String,
    pub supplier_id: String,
    pub employee_id: String,
    pub reference: String,
    pub notes: String,
    pub total_cost: i64,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StockReceiptLineRecord {
    pub id: String,
    pub receipt_id: String,
    pub product_id: String,
    pub product_name: String,
    pub quantity: i64,
    pub unit_cost: i64,
    pub inventory_log_id: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StockReceiptBundle {
    #[serde(default)]
    pub server_data_epoch: String,
    pub receipt: StockReceiptRecord,
    pub lines: Vec<StockReceiptLineRecord>,
    pub audit: AuditRecord,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreDatabaseResult {
    pub restored_from: String,
    pub replaced_database: String,
    pub safety_backup: Option<String>,
    pub restart_required: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomaticSetupBackupResult {
    pub path: String,
    pub created: bool,
}

#[derive(Debug, Deserialize, Serialize)]
struct PendingRestoreMarker {
    source: String,
    preserve_from: Option<String>,
}

pub(crate) fn local_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("pos.db"))
}

fn local_backup_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let backup_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("backups");
    fs::create_dir_all(&backup_dir).map_err(|e| e.to_string())?;
    Ok(backup_dir)
}

fn safe_backup_folder_component(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, ' ' | '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .take(40)
        .collect();
    cleaned.trim_matches([' ', '-', '_']).to_string()
}

async fn selected_till_backup_dir(
    app: &AppHandle,
    source: &PathBuf,
    backup_directory: Option<&str>,
) -> Result<PathBuf, String> {
    let custom = backup_directory.unwrap_or_default().trim();
    if custom.is_empty() {
        return local_backup_dir(app);
    }
    let base_directory = restore_source_path(custom)?;
    fs::create_dir_all(&base_directory).map_err(|e| {
        format!(
            "Could not open the selected backup folder {}: {e}",
            base_directory.display()
        )
    })?;
    if !base_directory.is_dir() {
        return Err("The selected backup destination is not a folder".into());
    }

    let uri = format!("sqlite://{}?mode=ro", source.display());
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&uri)
        .await
        .map_err(|e| format!("Could not read this till's backup identity: {e}"))?;
    let identity_rows =
        sqlx::query("SELECT key, value FROM settings WHERE key IN ('till_id', 'till_name')")
            .fetch_all(&pool)
            .await
            .map_err(|e| format!("Could not read this till's backup identity: {e}"))?;
    pool.close().await;
    let mut till_id = String::new();
    let mut till_name = String::new();
    for row in identity_rows {
        let key = row.try_get::<String, _>("key").unwrap_or_default();
        let value = row.try_get::<String, _>("value").unwrap_or_default();
        if key == "till_id" {
            till_id = value;
        } else if key == "till_name" {
            till_name = value;
        }
    }
    let name = safe_backup_folder_component(&till_name);
    let id = safe_backup_folder_component(&till_id.chars().take(8).collect::<String>());
    let scope = match (name.is_empty(), id.is_empty()) {
        (false, false) => format!("{name}-{id}"),
        (false, true) => name,
        (true, false) => format!("Till-{id}"),
        (true, true) => "This-Till".into(),
    };
    let directory = base_directory.join("LBj POS Backups").join(scope);
    fs::create_dir_all(&directory).map_err(|e| {
        format!(
            "Could not open the selected backup folder {}: {e}",
            directory.display()
        )
    })?;
    if !directory.is_dir() {
        return Err("The selected backup destination is not a folder".into());
    }
    Ok(directory)
}

fn is_user_backup(path: &PathBuf) -> bool {
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    name.starts_with("pos-backup-") && name.ends_with(".db")
}

fn is_automatic_setup_backup(path: &PathBuf) -> bool {
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    name.starts_with("shop-setup-backup-") && name.ends_with(".db")
}

fn latest_user_backup_in_dir(backup_dir: &PathBuf) -> Result<Option<PathBuf>, String> {
    if !backup_dir.exists() {
        return Ok(None);
    }
    let mut files: Vec<PathBuf> = fs::read_dir(backup_dir)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(is_user_backup)
        .collect();
    files.sort_by(|left, right| left.file_name().cmp(&right.file_name()));
    Ok(files.pop())
}

fn automatic_setup_backups_in_dir(backup_dir: &PathBuf) -> Result<Vec<PathBuf>, String> {
    if !backup_dir.exists() {
        return Ok(Vec::new());
    }
    let mut files: Vec<PathBuf> = fs::read_dir(backup_dir)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(is_automatic_setup_backup)
        .collect();
    files.sort_by(|left, right| left.file_name().cmp(&right.file_name()));
    Ok(files)
}

fn prune_automatic_setup_backups(backup_dir: &PathBuf) -> Result<(), String> {
    let files = automatic_setup_backups_in_dir(backup_dir)?;
    let remove_count = files.len().saturating_sub(2);
    for path in files.into_iter().take(remove_count) {
        fs::remove_file(&path).map_err(|e| {
            format!(
                "Could not remove old automatic setup backup {}: {e}",
                path.display()
            )
        })?;
    }
    Ok(())
}

fn pending_restore_marker_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("pending-restore.txt"))
}

fn restore_source_path(source_path: &str) -> Result<PathBuf, String> {
    let trimmed = source_path
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim();
    if trimmed.is_empty() {
        return Err("Choose or paste the old till database file path first".into());
    }
    Ok(PathBuf::from(trimmed))
}

async fn connect_mysql_for_pos(mysql_uri: &str) -> Result<MySqlPool, sqlx::Error> {
    MySqlPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_millis(650))
        .connect(mysql_uri)
        .await
}

const MYSQL_WHOLE_SYSTEM_CLOSE_METADATA_TIMEOUT_SQL: &str = "SET SESSION lock_wait_timeout = 5";
const MYSQL_WHOLE_SYSTEM_CLOSE_ROW_TIMEOUT_SQL: &str = "SET SESSION innodb_lock_wait_timeout = 5";
const WHOLE_SYSTEM_CLOSE_SCHEMA_PREPARE_TIMEOUT_SECONDS: u64 = 20;

async fn connect_mysql_for_whole_system_close(mysql_uri: &str) -> Result<MySqlPool, sqlx::Error> {
    let pool = connect_mysql_for_pos(mysql_uri).await?;
    // MariaDB's default metadata timeout can be extremely long and its default
    // InnoDB row-lock timeout is longer than the UI close deadline. Every close
    // command uses one pooled connection, so these session limits bound both
    // schema preparation and barrier locking without changing server globals.
    sqlx::query(MYSQL_WHOLE_SYSTEM_CLOSE_METADATA_TIMEOUT_SQL)
        .execute(&pool)
        .await?;
    sqlx::query(MYSQL_WHOLE_SYSTEM_CLOSE_ROW_TIMEOUT_SQL)
        .execute(&pool)
        .await?;
    Ok(pool)
}

const RECEIPT_BLOCK: i64 = 1_000_000;
const RECEIPT_HIGH_WATER_KEY: &str = "receipt_number_high_water";
const MARIADB_RESTORE_MAINTENANCE_CODE: &str = "MARIADB_RESTORE_MAINTENANCE";
const ACCOUNT_LEDGER_AUTHORITY_CODE: &str = "ACCOUNT_LEDGER_AUTHORITY_REQUIRED";
const MARIADB_RESTORE_GATE_TABLE: &str = "pos_restore_gate";
const MARIADB_RESTORE_LOCK_NAME: &str = "lbj-pos:mariadb-restore-replace";
const MARIADB_ATTENDANCE_AUDIT_IMPORT_LOCK_NAME: &str = "lbj-pos:attendance-audit-import";
const MARIADB_ATTENDANCE_AUDIT_IMPORT_LOCK_SECONDS: i64 = 8;
const MARIADB_ATTENDANCE_AUDIT_IMPORT_TABLE: &str = "pos_attendance_audit_import_sessions";
const MARIADB_EMPLOYEE_PROFILE_AUTHORITY_TABLE: &str = "pos_employee_profile_write_authority";
const MYSQL_SIGNED_CONNECTION_ID_SELECT: &str = "SELECT CAST(CONNECTION_ID() AS SIGNED)";
const MYSQL_SIGNED_EMPLOYEE_ACTIVE_PROJECTION: &str =
    "CAST(COALESCE(isActive, 0) AS SIGNED) AS isActive";
const MARIADB_EMPLOYEE_PROFILE_AUTHORITY_SECONDS: i64 = 15;
const MARIADB_EMPLOYEE_ADMIN_BOOTSTRAP_LOCK_NAME: &str = "lbj-pos:employee-admin-bootstrap";
const MARIADB_CONTROLLED_IMPORT_OWNER_KEY: &str = "staff_attendance_import_owner";
const MARIADB_CONTROLLED_IMPORT_EMPTY_TABLES: &[&str] = &[
    "employees",
    "employee_attendance",
    "audit_logs",
    "categories",
    "product_images",
    "pos_pages",
    "pos_tiles",
    "tax_rates",
    "discounts",
    "promo_groups",
    "promo_group_items",
    "customers",
    "customer_accounts",
    "customer_account_entries",
    "products",
    "suppliers",
    "product_suppliers",
    "orders",
    "order_lines",
    "payments",
    "shifts",
    "cash_movements",
    "inventory_logs",
    "loyalty_logs",
    "manager_approvals",
    "till_report_markers",
    "stock_receipts",
    "stock_receipt_lines",
    "daily_sales_summary",
    "tombstones",
];
const MARIADB_RESTORE_MAINTENANCE_KEY: &str = "restore_maintenance_owner";
const MARIADB_RESTORE_ONLINE_WINDOW_SECONDS: i64 = 45;
const CUSTOMER_DELETED_CODE: &str = "CUSTOMER_DELETED";
const MAX_LOYALTY_POINTS: i64 = i32::MAX as i64;
const WHOLE_SYSTEM_CLOSE_IN_PROGRESS_CODE: &str = "WHOLE_SYSTEM_CLOSE_IN_PROGRESS";
const WHOLE_SYSTEM_CLOSE_WAITING_CODE: &str = "WHOLE_SYSTEM_CLOSE_WAITING";
const WHOLE_SYSTEM_CLOSE_SETUP_TIMEOUT_CODE: &str = "WHOLE_SYSTEM_CLOSE_SETUP_TIMEOUT";
const WHOLE_SYSTEM_CLOSE_REPORT_TIMEOUT_CODE: &str = "WHOLE_SYSTEM_CLOSE_REPORT_TIMEOUT";
const WHOLE_SYSTEM_CLOSE_PROTOCOL_VERSION: i64 = 1;
const WHOLE_SYSTEM_CLOSE_ONLINE_SECONDS: i64 = 45;
const WHOLE_SYSTEM_CLOSE_PREPARE_SECONDS: i64 = 120;
const WHOLE_SYSTEM_CLOSE_FROZEN_SECONDS: i64 = 300;
const WHOLE_SYSTEM_CLOSE_REPORT_LOAD_TIMEOUT_SECONDS: u64 = 25;
const REPORT_PERIOD_ORIGIN: &str = "2000-01-01T00:00:00.000Z";
const ONLINE_FINANCIAL_INTENT_PENDING_CODE: &str = "ONLINE_FINANCIAL_INTENT_PENDING";
const ONLINE_FINANCIAL_INTENT_EPOCH_CODE: &str = "ONLINE_FINANCIAL_INTENT_EPOCH_MISMATCH";
const ONLINE_FINANCIAL_INTENT_TABLE: &str = "_online_financial_intent";
const MYSQL_COORDINATION_SCHEMA_MISSING_CODE: &str = "MYSQL_COORDINATION_SCHEMA_MISSING";
const MYSQL_COORDINATION_SCHEMA_CORRUPT_CODE: &str = "MYSQL_COORDINATION_SCHEMA_CORRUPT";
const MYSQL_IDENTIFIER_COLLATION_MIGRATION: &str = "2026-07-relational-identifier-collation-v2";
const MYSQL_IDENTIFIER_COLLATION_REQUIRED_CODE: &str =
    "MYSQL_IDENTIFIER_COLLATION_MIGRATION_REQUIRED";
const MYSQL_GUARD_V4_BODY_MARKER: &str = "lbj_guard_v4_body_2026_07_29_r2";
// MariaDB/SQLx can expose VARCHAR values with a binary collation as VARBINARY.
// Keep binary collation for exact coordination-token comparisons, but make the
// wire type textual whenever those values are decoded into Rust `String`s.
const MYSQL_RESTORE_GATE_LOCK_SELECT: &str =
    "SELECT CAST(ownerTillId AS CHAR CHARACTER SET utf8mb4) AS ownerTillId,
            isActive
     FROM pos_restore_gate WHERE id = 1 FOR UPDATE";
const MYSQL_RESTORE_GATE_ACTIVE_OWNER_SELECT: &str =
    "SELECT CAST(ownerTillId AS CHAR CHARACTER SET utf8mb4) AS ownerTillId
     FROM pos_restore_gate WHERE id = 1 AND isActive = 1 LIMIT 1";
const MYSQL_RESTORE_SESSION_BYPASS_SELECT: &str = "SELECT CAST(
       NULLIF(COALESCE(@lbj_pos_restore_bypass, ''), '')
       AS CHAR CHARACTER SET utf8mb4
     )";
const MYSQL_WRITE_BARRIER_LOCK_SELECT: &str =
    "SELECT CAST(state AS CHAR CHARACTER SET utf8mb4) AS state,
            CASE WHEN expiresAt IS NOT NULL
                       AND expiresAt <= UTC_TIMESTAMP(3)
                 THEN 1 ELSE 0 END AS isExpired,
            CAST(COALESCE(DATE_FORMAT(lastClosedAt, '%Y-%m-%dT%H:%i:%s.%fZ'), '')
                 AS CHAR CHARACTER SET utf8mb4) AS lastClosedAt
     FROM pos_close_barrier WHERE id = 1 FOR UPDATE";
const MYSQL_CLOSE_BARRIER_LOCK_SELECT: &str =
    "SELECT CAST(token AS CHAR CHARACTER SET utf8mb4) AS token,
            CAST(state AS CHAR CHARACTER SET utf8mb4) AS state,
            CAST(ownerTillId AS CHAR CHARACTER SET utf8mb4) AS ownerTillId,
            CAST(COALESCE(DATE_FORMAT(requestedAt, '%Y-%m-%dT%H:%i:%s.%fZ'), '')
                 AS CHAR CHARACTER SET utf8mb4) AS requestedAt,
            CAST(COALESCE(DATE_FORMAT(expiresAt, '%Y-%m-%dT%H:%i:%s.%fZ'), '')
                 AS CHAR CHARACTER SET utf8mb4) AS expiresAt,
            CAST(COALESCE(DATE_FORMAT(cutoffAt, '%Y-%m-%dT%H:%i:%s.%fZ'), '')
                 AS CHAR CHARACTER SET utf8mb4) AS cutoffAt
     FROM pos_close_barrier WHERE id = 1 FOR UPDATE";
const MYSQL_CLOSE_BARRIER_READY_COLUMN_COUNT_SELECT: &str =
    "SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'pos_close_barrier'
       AND COLUMN_NAME IN
         ('id', 'token', 'state', 'ownerTillId', 'requestedAt',
          'expiresAt', 'cutoffAt')";

const WHOLE_SYSTEM_CLOSE_GUARDED_TABLES: &[&str] = &[
    "orders",
    "order_lines",
    "payments",
    "products",
    "inventory_logs",
    "customers",
    "loyalty_logs",
    "customer_accounts",
    "customer_account_entries",
    "shifts",
    "cash_movements",
    "till_report_markers",
    "manager_approvals",
    "audit_logs",
    "stock_receipts",
    "stock_receipt_lines",
    "daily_sales_summary",
    "payment_terminal_attempts",
    "tombstones",
];

// Registers describe installed hardware and remain server-owned. Everything
// else here belongs to the restored full backup. Order matters for foreign
// keys during upload.
const MARIADB_RESTORE_COPY_TABLES: &[&str] = &[
    "app_identity",
    "categories",
    "tax_rates",
    "employees",
    "employee_attendance",
    "customers",
    "suppliers",
    "products",
    "product_images",
    "pos_pages",
    "pos_tiles",
    "promo_groups",
    "discounts",
    "promo_group_items",
    "product_suppliers",
    "shifts",
    "orders",
    "order_lines",
    "payments",
    "customer_accounts",
    "customer_account_entries",
    "inventory_logs",
    "loyalty_logs",
    "cash_movements",
    "audit_logs",
    "till_report_markers",
    "manager_approvals",
    "stock_receipts",
    "stock_receipt_lines",
    "daily_sales_summary",
    "settings",
    // Deletion intent is backup-owned state. Copy it only after every business
    // row so anti-resurrection triggers do not reject valid restored rows.
    "tombstones",
];

// Initial single-till → MariaDB migration owns an empty destination. Unlike a
// later restore, installed-register identities are part of that first upload.
// Audit rows precede attendance while its live audit triggers are suppressed.
const MARIADB_CONTROLLED_IMPORT_COPY_TABLES: &[&str] = &[
    "app_identity",
    "categories",
    "tax_rates",
    "employees",
    "audit_logs",
    "employee_attendance",
    "customers",
    "registers",
    "suppliers",
    "products",
    "product_images",
    "pos_pages",
    "pos_tiles",
    "promo_groups",
    "discounts",
    "promo_group_items",
    "product_suppliers",
    "shifts",
    "orders",
    "order_lines",
    "payments",
    "customer_accounts",
    "customer_account_entries",
    "inventory_logs",
    "loyalty_logs",
    "cash_movements",
    "till_report_markers",
    "manager_approvals",
    "stock_receipts",
    "stock_receipt_lines",
    "daily_sales_summary",
    "settings",
    "tombstones",
];

const MARIADB_RESTORE_DELETE_TABLES: &[&str] = &[
    "daily_sales_summary",
    "stock_receipt_lines",
    "stock_receipts",
    "manager_approvals",
    "till_report_markers",
    "cash_movements",
    "payments",
    "order_lines",
    "customer_account_entries",
    "orders",
    "shifts",
    "customer_accounts",
    "loyalty_logs",
    "audit_logs",
    "inventory_logs",
    "product_suppliers",
    "suppliers",
    "promo_group_items",
    "discounts",
    "promo_groups",
    "pos_tiles",
    "pos_pages",
    "product_images",
    "products",
    "customers",
    "tax_rates",
    "categories",
    "employee_attendance",
    "employees",
    "app_identity",
    // Customer/account DELETE triggers emit tombstones, so clear these last.
    "tombstones",
];

// These permanent server-side guards protect old installed clients which do
// not know how to call the native transaction preflight yet.
const MARIADB_RESTORE_GUARDED_TABLES: &[&str] = &[
    "app_identity",
    "categories",
    "products",
    "product_images",
    "pos_pages",
    "pos_tiles",
    "tax_rates",
    "discounts",
    "promo_groups",
    "promo_group_items",
    "employees",
    "employee_attendance",
    "settings",
    "customers",
    "registers",
    "customer_accounts",
    "customer_account_entries",
    "suppliers",
    "product_suppliers",
    "inventory_logs",
    "orders",
    "order_lines",
    "payments",
    "loyalty_logs",
    "audit_logs",
    "shifts",
    "cash_movements",
    "till_report_markers",
    "manager_approvals",
    "stock_receipts",
    "stock_receipt_lines",
    "daily_sales_summary",
    "payment_terminal_attempts",
    "payment_terminal_locks",
    "tombstones",
];

// A Pay Later commit cannot be valid without these relational/account tables.
// Other guarded tables are optional on a partial legacy schema, but every
// guarded table that does exist must still have all three current V4 guards.
const PAY_LATER_REQUIRED_GUARDED_TABLES: &[&str] = &[
    "orders",
    "order_lines",
    "payments",
    "customers",
    "customer_accounts",
    "customer_account_entries",
    "audit_logs",
    "tombstones",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MariaDbRestoreResult {
    pub server_data_epoch: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttendanceAuditImportResult {
    pub employee_count: i64,
    pub attendance_count: i64,
    pub audit_count: i64,
    pub server_data_epoch: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmployeeProfileRecord {
    pub id: String,
    #[serde(default)]
    pub store_id: String,
    pub name: String,
    #[serde(default)]
    pub pin: String,
    #[serde(default)]
    pub pin_hash: String,
    pub role: String,
    #[serde(default)]
    pub email: String,
    pub is_active: bool,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug)]
enum RestoreValue {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

fn utc_stamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn random_record_id() -> String {
    let mut random = [0_u8; 16];
    OsRng.fill_bytes(&mut random);
    random.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn account_protocol_error(message: impl Into<String>) -> sqlx::Error {
    sqlx::Error::Protocol(message.into())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RestoreGateWriteDecision {
    Allowed,
    MaintenanceBlocked,
    Corrupt,
}

fn restore_gate_write_decision(
    is_active: i64,
    owner: &str,
    session_bypass: Option<&str>,
) -> RestoreGateWriteDecision {
    match is_active {
        0 => RestoreGateWriteDecision::Allowed,
        1 if owner.trim().is_empty() => RestoreGateWriteDecision::Corrupt,
        1 => match session_bypass.filter(|value| !value.trim().is_empty()) {
            Some(session) if session == owner => RestoreGateWriteDecision::Allowed,
            _ => RestoreGateWriteDecision::MaintenanceBlocked,
        },
        _ => RestoreGateWriteDecision::Corrupt,
    }
}

/// Fail closed inside every native MariaDB commerce transaction. The permanent
/// MariaDB triggers installed by the restore path protect older clients too;
/// this explicit check gives current clients a clear error before any business
/// row is changed.
async fn assert_mysql_restore_writes_allowed(
    tx: &mut sqlx::Transaction<'_, sqlx::MySql>,
) -> Result<String, sqlx::Error> {
    let migration_table_exists: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pos_schema_migrations'",
    )
    .fetch_one(&mut **tx)
    .await?;
    if migration_table_exists == 0 {
        return Err(account_protocol_error(format!(
            "{MYSQL_IDENTIFIER_COLLATION_REQUIRED_CODE}: {MYSQL_IDENTIFIER_COLLATION_MIGRATION} must complete before MariaDB writes"
        )));
    }
    let collation_ready: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pos_schema_migrations WHERE BINARY name = BINARY ?",
    )
    .bind(MYSQL_IDENTIFIER_COLLATION_MIGRATION)
    .fetch_one(&mut **tx)
    .await?;
    if collation_ready != 1 {
        return Err(account_protocol_error(format!(
            "{MYSQL_IDENTIFIER_COLLATION_REQUIRED_CODE}: {MYSQL_IDENTIFIER_COLLATION_MIGRATION} must complete before MariaDB writes"
        )));
    }

    // Global coordination rows are always locked close-barrier first, restore
    // gate second. Keeping one order prevents close/restore transition deadlocks.
    let close_barrier_exists: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pos_close_barrier'",
    )
    .fetch_one(&mut **tx)
    .await?;
    if close_barrier_exists == 0 {
        return Err(account_protocol_error(format!(
            "{MYSQL_COORDINATION_SCHEMA_MISSING_CODE}: pos_close_barrier is required before MariaDB writes"
        )));
    }
    // A current locking read is the close-cutoff serialization point. Every
    // native financial transaction holds this row until commit, so freeze
    // waits for earlier writers and later writers wait to observe frozen.
    let barrier: Option<(String, i64, String)> = sqlx::query_as(MYSQL_WRITE_BARRIER_LOCK_SELECT)
        .fetch_optional(&mut **tx)
        .await?;
    let (state, is_expired, last_closed_at) = barrier.ok_or_else(|| {
        account_protocol_error(format!(
            "{MYSQL_COORDINATION_SCHEMA_MISSING_CODE}: pos_close_barrier row 1 is required before MariaDB writes"
        ))
    })?;
    let report_epoch = canonical_report_epoch(&last_closed_at)?;
    if state != "idle" && is_expired != 0 {
        sqlx::query(
            "UPDATE pos_close_barrier
             SET token = '', state = 'idle', ownerTillId = '',
                 requestedAt = NULL, expiresAt = NULL, cutoffAt = NULL
             WHERE id = 1",
        )
        .execute(&mut **tx)
        .await?;
    } else if state == "frozen" {
        return Err(account_protocol_error(format!(
            "{WHOLE_SYSTEM_CLOSE_IN_PROGRESS_CODE}: financial writes are paused while the whole-system report is closing"
        )));
    }

    let gate_exists: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
    )
    .bind(MARIADB_RESTORE_GATE_TABLE)
    .fetch_one(&mut **tx)
    .await?;
    if gate_exists == 0 {
        return Err(account_protocol_error(format!(
            "{MYSQL_COORDINATION_SCHEMA_MISSING_CODE}: pos_restore_gate is required before MariaDB writes"
        )));
    }
    let gate: Option<(String, i64)> = sqlx::query_as(MYSQL_RESTORE_GATE_LOCK_SELECT)
        .fetch_optional(&mut **tx)
        .await?;
    let gate = gate.ok_or_else(|| {
        account_protocol_error(format!(
            "{MYSQL_COORDINATION_SCHEMA_MISSING_CODE}: pos_restore_gate row 1 is required before MariaDB writes"
        ))
    })?;
    let session_bypass: Option<String> = sqlx::query_scalar(MYSQL_RESTORE_SESSION_BYPASS_SELECT)
        .fetch_one(&mut **tx)
        .await?;
    match restore_gate_write_decision(gate.1, &gate.0, session_bypass.as_deref()) {
        RestoreGateWriteDecision::Allowed => {}
        RestoreGateWriteDecision::MaintenanceBlocked => {
            return Err(account_protocol_error(format!(
                "{MARIADB_RESTORE_MAINTENANCE_CODE}: MariaDB is being restored; this write was not committed"
            )));
        }
        RestoreGateWriteDecision::Corrupt => {
            return Err(account_protocol_error(format!(
                "{MYSQL_COORDINATION_SCHEMA_CORRUPT_CODE}: pos_restore_gate row 1 has an invalid state"
            )));
        }
    }
    Ok(report_epoch)
}

fn mysql_identifier(value: &str) -> String {
    format!("`{}`", value.replace('`', "``"))
}

async fn mysql_table_exists(pool: &MySqlPool, table: &str) -> Result<bool, sqlx::Error> {
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
    )
    .bind(table)
    .fetch_one(pool)
    .await?;
    Ok(count > 0)
}

async fn mysql_identifier_collation_ready_on(
    connection: &mut MySqlConnection,
) -> Result<bool, sqlx::Error> {
    let migration_table_exists: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pos_schema_migrations'",
    )
    .fetch_one(&mut *connection)
    .await?;
    if migration_table_exists == 0 {
        return Ok(false);
    }
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pos_schema_migrations WHERE BINARY name = BINARY ?",
    )
    .bind(MYSQL_IDENTIFIER_COLLATION_MIGRATION)
    .fetch_one(&mut *connection)
    .await?;
    Ok(count == 1)
}

async fn mysql_identifier_collation_ready(pool: &MySqlPool) -> Result<bool, sqlx::Error> {
    let mut connection = pool.acquire().await?;
    mysql_identifier_collation_ready_on(&mut connection).await
}

fn mysql_customer_guard_v4_sql(table: &str, operation: &str) -> &'static str {
    match (table, operation) {
        ("customers", "INSERT") => {
            "IF restoreActive = 0 THEN
               INSERT INTO pos_customer_write_locks (customerId) VALUES (NEW.id)
                 ON DUPLICATE KEY UPDATE customerId = VALUES(customerId);
               SELECT customerId INTO lockedCustomerId
                 FROM pos_customer_write_locks
                 WHERE CONVERT(customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
                       = CONVERT(NEW.id USING utf8mb4) COLLATE utf8mb4_unicode_ci FOR UPDATE;
               IF EXISTS (SELECT 1 FROM tombstones
                           WHERE table_name = 'customers'
                             AND CONVERT(row_id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                                 = CONVERT(NEW.id USING utf8mb4) COLLATE utf8mb4_unicode_ci) THEN
                 SIGNAL SQLSTATE '45000'
                   SET MESSAGE_TEXT = 'CUSTOMER_DELETED: customer cannot be recreated';
               END IF;
             END IF;"
        }
        ("customers", "UPDATE") => {
            "IF CONVERT(NEW.id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                <> CONVERT(OLD.id USING utf8mb4) COLLATE utf8mb4_unicode_ci THEN
               SIGNAL SQLSTATE '45000'
                 SET MESSAGE_TEXT = 'CUSTOMER_ID_IMMUTABLE: customer id cannot change';
             END IF;
             IF restoreActive = 0 THEN
               INSERT INTO pos_customer_write_locks (customerId) VALUES (NEW.id)
                 ON DUPLICATE KEY UPDATE customerId = VALUES(customerId);
               SELECT customerId INTO lockedCustomerId
                 FROM pos_customer_write_locks
                 WHERE CONVERT(customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
                       = CONVERT(NEW.id USING utf8mb4) COLLATE utf8mb4_unicode_ci FOR UPDATE;
               IF EXISTS (SELECT 1 FROM tombstones
                           WHERE table_name = 'customers'
                             AND CONVERT(row_id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                                 = CONVERT(NEW.id USING utf8mb4) COLLATE utf8mb4_unicode_ci) THEN
                 SIGNAL SQLSTATE '45000'
                   SET MESSAGE_TEXT = 'CUSTOMER_DELETED: customer cannot be updated';
               END IF;
             END IF;"
        }
        ("customers", "DELETE") => {
            "IF restoreActive = 0 THEN
               INSERT INTO pos_customer_write_locks (customerId) VALUES (OLD.id)
                 ON DUPLICATE KEY UPDATE customerId = VALUES(customerId);
               SELECT customerId INTO lockedCustomerId
                 FROM pos_customer_write_locks
                 WHERE CONVERT(customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
                       = CONVERT(OLD.id USING utf8mb4) COLLATE utf8mb4_unicode_ci FOR UPDATE;
             END IF;"
        }
        ("customer_accounts", "INSERT") => {
            "IF restoreActive = 0 THEN
               INSERT INTO pos_customer_write_locks (customerId) VALUES (NEW.customerId)
                 ON DUPLICATE KEY UPDATE customerId = VALUES(customerId);
               SELECT customerId INTO lockedCustomerId FROM pos_customer_write_locks
                 WHERE CONVERT(customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
                       = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci FOR UPDATE;
               IF EXISTS (SELECT 1 FROM tombstones
                           WHERE (table_name = 'customers'
                                  AND CONVERT(row_id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                                      = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci)
                              OR (table_name = 'customer_accounts'
                                  AND CONVERT(row_id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                                      = CONVERT(NEW.id USING utf8mb4) COLLATE utf8mb4_unicode_ci))
                  OR NOT EXISTS (SELECT 1 FROM customers
                                 WHERE CONVERT(id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                                       = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci) THEN
                 SIGNAL SQLSTATE '45000'
                   SET MESSAGE_TEXT = 'CUSTOMER_DELETED: customer account cannot be recreated';
               END IF;
             END IF;"
        }
        ("customer_accounts", "UPDATE") => {
            "IF CONVERT(NEW.id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                <> CONVERT(OLD.id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                OR CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
                   <> CONVERT(OLD.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci THEN
               SIGNAL SQLSTATE '45000'
                 SET MESSAGE_TEXT = 'CUSTOMER_ID_IMMUTABLE: account ownership cannot change';
             END IF;
             IF restoreActive = 0 THEN
               INSERT INTO pos_customer_write_locks (customerId) VALUES (NEW.customerId)
                 ON DUPLICATE KEY UPDATE customerId = VALUES(customerId);
               SELECT customerId INTO lockedCustomerId FROM pos_customer_write_locks
                 WHERE CONVERT(customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
                       = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci FOR UPDATE;
               IF EXISTS (SELECT 1 FROM tombstones
                           WHERE (table_name = 'customers'
                                  AND CONVERT(row_id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                                      = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci)
                              OR (table_name = 'customer_accounts'
                                  AND CONVERT(row_id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                                      = CONVERT(NEW.id USING utf8mb4) COLLATE utf8mb4_unicode_ci))
                  OR NOT EXISTS (SELECT 1 FROM customers
                                 WHERE CONVERT(id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                                       = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci) THEN
                 SIGNAL SQLSTATE '45000'
                   SET MESSAGE_TEXT = 'CUSTOMER_DELETED: customer account cannot be updated';
               END IF;
             END IF;"
        }
        ("customer_accounts", "DELETE") => {
            "IF restoreActive = 0 THEN
               INSERT INTO pos_customer_write_locks (customerId) VALUES (OLD.customerId)
                 ON DUPLICATE KEY UPDATE customerId = VALUES(customerId);
               SELECT customerId INTO lockedCustomerId FROM pos_customer_write_locks
                 WHERE CONVERT(customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
                       = CONVERT(OLD.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci FOR UPDATE;
             END IF;"
        }
        ("orders", "INSERT") => {
            "IF restoreActive = 0 AND lastClosed IS NOT NULL
                AND COALESCE(NEW.completedAt, '') <> ''
                AND NEW.completedAt <= DATE_FORMAT(lastClosed, '%Y-%m-%dT%H:%i:%s.%fZ') THEN
               SIGNAL SQLSTATE '45000'
                 SET MESSAGE_TEXT = 'REPORT_PERIOD_CLOSED: sale timestamp is before the latest close';
             END IF;
             IF restoreActive = 0 AND COALESCE(TRIM(NEW.customerId), '') <> '' THEN
               INSERT INTO pos_customer_write_locks (customerId) VALUES (NEW.customerId)
                 ON DUPLICATE KEY UPDATE customerId = VALUES(customerId);
               SELECT customerId INTO lockedCustomerId FROM pos_customer_write_locks
                 WHERE CONVERT(customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
                       = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci FOR UPDATE;
               IF EXISTS (SELECT 1 FROM tombstones
                           WHERE table_name = 'customers'
                             AND CONVERT(row_id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                                 = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci)
                  OR NOT EXISTS (SELECT 1 FROM customers
                                 WHERE CONVERT(id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                                       = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci) THEN
                 SIGNAL SQLSTATE '45000'
                   SET MESSAGE_TEXT = 'CUSTOMER_DELETED: order customer is unavailable';
               END IF;
             END IF;"
        }
        ("orders", "UPDATE") => {
            "IF restoreActive = 0 AND lastClosed IS NOT NULL
                AND COALESCE(NEW.status, '') IN
                    ('completed', 'refunded', 'partially_refunded', 'voided')
                AND COALESCE(NEW.completedAt, '') <> ''
                AND NEW.completedAt <= DATE_FORMAT(lastClosed, '%Y-%m-%dT%H:%i:%s.%fZ') THEN
               SIGNAL SQLSTATE '45000'
                 SET MESSAGE_TEXT = 'REPORT_PERIOD_CLOSED: order update is before the latest close';
             END IF;
             IF CONVERT(COALESCE(NEW.customerId, '') USING utf8mb4) COLLATE utf8mb4_unicode_ci
                <> CONVERT(COALESCE(OLD.customerId, '') USING utf8mb4) COLLATE utf8mb4_unicode_ci THEN
               SIGNAL SQLSTATE '45000'
                 SET MESSAGE_TEXT = 'CUSTOMER_ID_IMMUTABLE: order customer cannot change';
             END IF;
             IF restoreActive = 0 AND COALESCE(TRIM(NEW.customerId), '') <> '' THEN
               INSERT INTO pos_customer_write_locks (customerId) VALUES (NEW.customerId)
                 ON DUPLICATE KEY UPDATE customerId = VALUES(customerId);
               SELECT customerId INTO lockedCustomerId FROM pos_customer_write_locks
                 WHERE CONVERT(customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
                       = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci FOR UPDATE;
               IF EXISTS (SELECT 1 FROM tombstones
                           WHERE table_name = 'customers'
                             AND CONVERT(row_id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                                 = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci)
                  OR NOT EXISTS (SELECT 1 FROM customers
                                 WHERE CONVERT(id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                                       = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci) THEN
                 SIGNAL SQLSTATE '45000'
                   SET MESSAGE_TEXT = 'CUSTOMER_DELETED: order customer is unavailable';
               END IF;
             END IF;"
        }
        ("orders", "DELETE") => {
            "IF restoreActive = 0 AND COALESCE(TRIM(OLD.customerId), '') <> '' THEN
               INSERT INTO pos_customer_write_locks (customerId) VALUES (OLD.customerId)
                 ON DUPLICATE KEY UPDATE customerId = VALUES(customerId);
               SELECT customerId INTO lockedCustomerId FROM pos_customer_write_locks
                 WHERE CONVERT(customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
                       = CONVERT(OLD.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci FOR UPDATE;
             END IF;"
        }
        ("loyalty_logs", "INSERT") => {
            "IF restoreActive = 0 AND COALESCE(TRIM(NEW.customerId), '') <> '' THEN
               INSERT INTO pos_customer_write_locks (customerId) VALUES (NEW.customerId)
                 ON DUPLICATE KEY UPDATE customerId = VALUES(customerId);
               SELECT customerId INTO lockedCustomerId FROM pos_customer_write_locks
                 WHERE CONVERT(customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
                       = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci FOR UPDATE;
               IF EXISTS (SELECT 1 FROM tombstones
                           WHERE table_name = 'customers'
                             AND CONVERT(row_id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                                 = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci)
                  OR NOT EXISTS (SELECT 1 FROM customers
                                 WHERE CONVERT(id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                                       = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci) THEN
                 SIGNAL SQLSTATE '45000'
                   SET MESSAGE_TEXT = 'CUSTOMER_DELETED: loyalty customer is unavailable';
               END IF;
             END IF;"
        }
        ("loyalty_logs", "UPDATE") => {
            "IF CONVERT(NEW.id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                <> CONVERT(OLD.id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                OR CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
                   <> CONVERT(OLD.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci THEN
               SIGNAL SQLSTATE '45000'
                 SET MESSAGE_TEXT = 'CUSTOMER_ID_IMMUTABLE: loyalty ownership cannot change';
             END IF;
             IF restoreActive = 0 AND COALESCE(TRIM(NEW.customerId), '') <> '' THEN
               INSERT INTO pos_customer_write_locks (customerId) VALUES (NEW.customerId)
                 ON DUPLICATE KEY UPDATE customerId = VALUES(customerId);
               SELECT customerId INTO lockedCustomerId FROM pos_customer_write_locks
                 WHERE CONVERT(customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
                       = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci FOR UPDATE;
               IF EXISTS (SELECT 1 FROM tombstones
                           WHERE table_name = 'customers'
                             AND CONVERT(row_id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                                 = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci)
                  OR NOT EXISTS (SELECT 1 FROM customers
                                 WHERE CONVERT(id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                                       = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci) THEN
                 SIGNAL SQLSTATE '45000'
                   SET MESSAGE_TEXT = 'CUSTOMER_DELETED: loyalty customer is unavailable';
               END IF;
             END IF;"
        }
        ("loyalty_logs", "DELETE") => {
            "IF restoreActive = 0 AND COALESCE(TRIM(OLD.customerId), '') <> '' THEN
               INSERT INTO pos_customer_write_locks (customerId) VALUES (OLD.customerId)
                 ON DUPLICATE KEY UPDATE customerId = VALUES(customerId);
               SELECT customerId INTO lockedCustomerId FROM pos_customer_write_locks
                 WHERE CONVERT(customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
                       = CONVERT(OLD.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci FOR UPDATE;
             END IF;"
        }
        ("customer_account_entries", "INSERT") => {
            "IF restoreActive = 0 AND COALESCE(TRIM(NEW.customerId), '') <> '' THEN
               INSERT INTO pos_customer_write_locks (customerId) VALUES (NEW.customerId)
                 ON DUPLICATE KEY UPDATE customerId = VALUES(customerId);
               SELECT customerId INTO lockedCustomerId FROM pos_customer_write_locks
                 WHERE CONVERT(customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
                       = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci FOR UPDATE;
               IF EXISTS (SELECT 1 FROM tombstones
                           WHERE (table_name = 'customers'
                                  AND CONVERT(row_id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                                      = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci)
                              OR (table_name = 'customer_accounts'
                                  AND CONVERT(row_id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                                      = CONVERT(NEW.accountId USING utf8mb4) COLLATE utf8mb4_unicode_ci))
                  OR NOT EXISTS (SELECT 1 FROM customers
                                 WHERE CONVERT(id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                                       = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci)
                  OR NOT EXISTS (SELECT 1 FROM customer_accounts
                                  WHERE CONVERT(id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                                        = CONVERT(NEW.accountId USING utf8mb4) COLLATE utf8mb4_unicode_ci
                                    AND CONVERT(customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
                                        = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci) THEN
                 SIGNAL SQLSTATE '45000'
                   SET MESSAGE_TEXT = 'CUSTOMER_DELETED: account entry owner is unavailable';
               END IF;
             END IF;"
        }
        ("customer_account_entries", "UPDATE") => {
            "IF CONVERT(NEW.id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                <> CONVERT(OLD.id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                OR CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
                   <> CONVERT(OLD.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
                OR CONVERT(NEW.accountId USING utf8mb4) COLLATE utf8mb4_unicode_ci
                   <> CONVERT(OLD.accountId USING utf8mb4) COLLATE utf8mb4_unicode_ci THEN
               SIGNAL SQLSTATE '45000'
                 SET MESSAGE_TEXT = 'CUSTOMER_ID_IMMUTABLE: account entry ownership cannot change';
             END IF;
             IF restoreActive = 0 AND COALESCE(TRIM(NEW.customerId), '') <> '' THEN
               INSERT INTO pos_customer_write_locks (customerId) VALUES (NEW.customerId)
                 ON DUPLICATE KEY UPDATE customerId = VALUES(customerId);
               SELECT customerId INTO lockedCustomerId FROM pos_customer_write_locks
                 WHERE CONVERT(customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
                       = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci FOR UPDATE;
               IF EXISTS (SELECT 1 FROM tombstones
                           WHERE (table_name = 'customers'
                                  AND CONVERT(row_id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                                      = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci)
                              OR (table_name = 'customer_accounts'
                                  AND CONVERT(row_id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                                      = CONVERT(NEW.accountId USING utf8mb4) COLLATE utf8mb4_unicode_ci))
                  OR NOT EXISTS (SELECT 1 FROM customers
                                 WHERE CONVERT(id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                                       = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci)
                  OR NOT EXISTS (SELECT 1 FROM customer_accounts
                                  WHERE CONVERT(id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                                        = CONVERT(NEW.accountId USING utf8mb4) COLLATE utf8mb4_unicode_ci
                                    AND CONVERT(customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
                                        = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci) THEN
                 SIGNAL SQLSTATE '45000'
                   SET MESSAGE_TEXT = 'CUSTOMER_DELETED: account entry owner is unavailable';
               END IF;
             END IF;"
        }
        ("customer_account_entries", "DELETE") => {
            "IF restoreActive = 0 AND COALESCE(TRIM(OLD.customerId), '') <> '' THEN
               INSERT INTO pos_customer_write_locks (customerId) VALUES (OLD.customerId)
                 ON DUPLICATE KEY UPDATE customerId = VALUES(customerId);
               SELECT customerId INTO lockedCustomerId FROM pos_customer_write_locks
                 WHERE CONVERT(customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
                       = CONVERT(OLD.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci FOR UPDATE;
             END IF;"
        }
        _ => "",
    }
}

fn mysql_guarded_preflight_v4_sql(
    trigger_name: &str,
    table: &str,
    operation: &str,
    ordering: &str,
    identity_guard: &str,
) -> String {
    format!(
        "CREATE OR REPLACE TRIGGER {} BEFORE {operation} ON {} FOR EACH ROW{ordering}
         BEGIN
           DECLARE guardRevision VARCHAR(64) DEFAULT '{MYSQL_GUARD_V4_BODY_MARKER}';
           DECLARE barrierState VARCHAR(16) DEFAULT '__missing__';
           DECLARE barrierExpiry DATETIME(3) DEFAULT NULL;
           DECLARE lastClosed DATETIME(3) DEFAULT NULL;
           DECLARE restoreOwner VARCHAR(191) DEFAULT '';
           DECLARE restoreActive TINYINT DEFAULT -1;
           DECLARE lockedCustomerId VARCHAR(64) DEFAULT '';
           SELECT state, expiresAt, lastClosedAt
             INTO barrierState, barrierExpiry, lastClosed
             FROM pos_close_barrier WHERE id = 1 FOR UPDATE;
           IF barrierState = '__missing__' THEN
             SIGNAL SQLSTATE '45000'
               SET MESSAGE_TEXT = 'MYSQL_COORDINATION_SCHEMA_MISSING: close barrier row missing';
           END IF;
           IF barrierState <> 'idle' AND barrierExpiry IS NOT NULL
              AND barrierExpiry <= UTC_TIMESTAMP(3) THEN
             UPDATE pos_close_barrier
             SET token = '', state = 'idle', ownerTillId = '',
                 requestedAt = NULL, expiresAt = NULL, cutoffAt = NULL
             WHERE id = 1;
             SET barrierState = 'idle';
           END IF;
           IF barrierState = 'frozen' THEN
             SIGNAL SQLSTATE '45000'
               SET MESSAGE_TEXT = 'WHOLE_SYSTEM_CLOSE_IN_PROGRESS: write blocked';
           END IF;
           SELECT ownerTillId, isActive INTO restoreOwner, restoreActive
             FROM pos_restore_gate WHERE id = 1 FOR UPDATE;
           IF restoreActive = -1 THEN
             SIGNAL SQLSTATE '45000'
               SET MESSAGE_TEXT = 'MYSQL_COORDINATION_SCHEMA_MISSING: restore gate row missing';
           END IF;
           IF restoreActive IS NULL OR restoreActive NOT IN (0, 1)
              OR (restoreActive = 1
                  AND COALESCE(CHAR_LENGTH(TRIM(restoreOwner)), 0) = 0) THEN
             SIGNAL SQLSTATE '45000'
               SET MESSAGE_TEXT = 'MYSQL_COORDINATION_SCHEMA_CORRUPT: restore gate state invalid';
           END IF;
           IF restoreActive = 1
              AND (
                COALESCE(CHAR_LENGTH(TRIM(@lbj_pos_restore_bypass)), 0) = 0
                OR BINARY restoreOwner
                   <> BINARY COALESCE(@lbj_pos_restore_bypass, '')
              ) THEN
             SIGNAL SQLSTATE '45000'
               SET MESSAGE_TEXT = 'MARIADB_RESTORE_MAINTENANCE: write blocked';
           END IF;
           {identity_guard}
         END",
        mysql_identifier(trigger_name),
        mysql_identifier(table),
    )
}

fn mysql_guard_v4_definition_is_current(
    expected_table: &str,
    expected_operation: &str,
    actual_table: &str,
    actual_operation: &str,
    actual_timing: &str,
    action_order: i64,
    action_statement: &str,
) -> bool {
    actual_table == expected_table
        && actual_operation.eq_ignore_ascii_case(expected_operation)
        && actual_timing.eq_ignore_ascii_case("BEFORE")
        && action_order == 1
        && action_statement.contains(MYSQL_GUARD_V4_BODY_MARKER)
        && action_statement.contains(MYSQL_COORDINATION_SCHEMA_CORRUPT_CODE)
        && action_statement.contains(MARIADB_RESTORE_MAINTENANCE_CODE)
        && (expected_table != "orders"
            || !expected_operation.eq_ignore_ascii_case("UPDATE")
            || action_statement.contains("REPORT_PERIOD_CLOSED"))
}

fn mysql_guarded_preflight_v4_health_is_current(
    required_guarded_tables: i64,
    guarded_tables: i64,
    current_guards: i64,
    legacy_guards: i64,
    coordination_tables: i64,
    close_rows: i64,
    restore_rows: i64,
) -> bool {
    required_guarded_tables == PAY_LATER_REQUIRED_GUARDED_TABLES.len() as i64
        && guarded_tables > 0
        && current_guards == guarded_tables.saturating_mul(3)
        && legacy_guards == 0
        && coordination_tables == 3
        && close_rows == 1
        && restore_rows == 1
}

/// Check the installed write-guard set in a small, fixed number of reads.
///
/// Account checkout calls the guard installer defensively, so the healthy
/// path must not walk every table/trigger or issue DDL. The transaction still
/// performs its own locking close/restore/epoch checks; this read-only health
/// check only decides whether schema repair is actually necessary.
async fn mysql_guarded_preflight_v4_is_current_on(
    connection: &mut MySqlConnection,
) -> Result<bool, sqlx::Error> {
    if !mysql_identifier_collation_ready_on(connection).await? {
        return Ok(false);
    }

    let mut tables = MARIADB_RESTORE_GUARDED_TABLES
        .iter()
        .chain(WHOLE_SYSTEM_CLOSE_GUARDED_TABLES.iter())
        .copied()
        .collect::<Vec<_>>();
    tables.sort_unstable();
    tables.dedup();

    let mut query = QueryBuilder::<MySql>::new(
        "SELECT
           CAST(COUNT(DISTINCT guarded.TABLE_NAME) AS SIGNED),
           CAST(COUNT(DISTINCT CASE WHEN
             guard.TRIGGER_NAME = CONCAT(
               'lbj_guard_v4_', guarded.TABLE_NAME, '_',
               LOWER(guard.EVENT_MANIPULATION)
             )
             AND guard.ACTION_TIMING = 'BEFORE'
             AND guard.ACTION_ORDER = 1
             AND LOCATE(",
    );
    query.push_bind(MYSQL_GUARD_V4_BODY_MARKER);
    query.push(", guard.ACTION_STATEMENT) > 0 AND LOCATE(");
    query.push_bind(MYSQL_COORDINATION_SCHEMA_CORRUPT_CODE);
    query.push(", guard.ACTION_STATEMENT) > 0 AND LOCATE(");
    query.push_bind(MARIADB_RESTORE_MAINTENANCE_CODE);
    query.push(
        ", guard.ACTION_STATEMENT) > 0
             AND (
               guarded.TABLE_NAME <> 'orders'
               OR guard.EVENT_MANIPULATION <> 'UPDATE'
               OR LOCATE(",
    );
    query.push_bind("REPORT_PERIOD_CLOSED");
    query.push(
        ", guard.ACTION_STATEMENT) > 0
             )
             THEN guard.TRIGGER_NAME END) AS SIGNED),
           CAST(COUNT(DISTINCT CASE WHEN
             guard.TRIGGER_NAME IN (
               CONCAT('lbj_guard_v3_', guarded.TABLE_NAME, '_insert'),
               CONCAT('lbj_guard_v3_', guarded.TABLE_NAME, '_update'),
               CONCAT('lbj_guard_v3_', guarded.TABLE_NAME, '_delete'),
               CONCAT('lbj_restore_guard_', guarded.TABLE_NAME, '_insert'),
               CONCAT('lbj_restore_guard_', guarded.TABLE_NAME, '_update'),
               CONCAT('lbj_restore_guard_', guarded.TABLE_NAME, '_delete')
             )
             THEN guard.TRIGGER_NAME END) AS SIGNED),
           CAST((SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
                  WHERE TABLE_SCHEMA = DATABASE()
                    AND TABLE_NAME IN (
                      'pos_close_barrier', 'pos_restore_gate',
                      'pos_customer_write_locks'
                    )) AS SIGNED),
           CAST((SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
                  WHERE TABLE_SCHEMA = DATABASE()
                    AND TABLE_NAME IN (",
    );
    {
        let mut separated = query.separated(", ");
        for table in PAY_LATER_REQUIRED_GUARDED_TABLES {
            separated.push_bind(table);
        }
    }
    query.push(
        ")) AS SIGNED)
         FROM INFORMATION_SCHEMA.TABLES AS guarded
         LEFT JOIN INFORMATION_SCHEMA.TRIGGERS AS guard
           ON guard.TRIGGER_SCHEMA = guarded.TABLE_SCHEMA
          AND guard.EVENT_OBJECT_TABLE = guarded.TABLE_NAME
         WHERE guarded.TABLE_SCHEMA = DATABASE()
           AND guarded.TABLE_NAME IN (",
    );
    {
        let mut separated = query.separated(", ");
        for table in &tables {
            separated.push_bind(table);
        }
    }
    query.push(")");
    let (
        guarded_tables,
        current_guards,
        legacy_guards,
        coordination_tables,
        required_guarded_tables,
    ): (i64, i64, i64, i64, i64) = query.build_query_as().fetch_one(&mut *connection).await?;

    if required_guarded_tables != PAY_LATER_REQUIRED_GUARDED_TABLES.len() as i64
        || guarded_tables == 0
        || current_guards != guarded_tables.saturating_mul(3)
        || legacy_guards != 0
        || coordination_tables != 3
    {
        return Ok(false);
    }

    // Query the singleton rows only after INFORMATION_SCHEMA proved both
    // tables exist, keeping a partially installed schema on the repair path.
    let (close_rows, restore_rows): (i64, i64) = sqlx::query_as(
        "SELECT
           (SELECT COUNT(*) FROM pos_close_barrier WHERE id = 1),
           (SELECT COUNT(*) FROM pos_restore_gate WHERE id = 1)",
    )
    .fetch_one(&mut *connection)
    .await?;
    Ok(mysql_guarded_preflight_v4_health_is_current(
        required_guarded_tables,
        guarded_tables,
        current_guards,
        legacy_guards,
        coordination_tables,
        close_rows,
        restore_rows,
    ))
}

async fn mysql_guarded_preflight_v4_is_current(pool: &MySqlPool) -> Result<bool, sqlx::Error> {
    let mut connection = pool.acquire().await?;
    mysql_guarded_preflight_v4_is_current_on(&mut connection).await
}

/// Every legacy/raw writer must acquire the same durable locks as current
/// native writers: close barrier, restore gate, then (when applicable) the
/// customer identity mutex. PRECEDES makes this one combined trigger the first
/// BEFORE trigger. V4 explicitly converts customer identifiers to one Unicode
/// case-insensitive collation, preserving legacy ID matching without allowing
/// MariaDB to combine incompatible implicit collations. Every V4 trigger is
/// installed and verified before V3 is retired.
async fn ensure_mysql_guarded_preflight_v4(pool: &MySqlPool) -> Result<(), sqlx::Error> {
    if mysql_guarded_preflight_v4_is_current(pool).await? {
        return Ok(());
    }
    if !mysql_identifier_collation_ready(pool).await? {
        return Err(account_protocol_error(format!(
            "{MYSQL_IDENTIFIER_COLLATION_REQUIRED_CODE}: {MYSQL_IDENTIFIER_COLLATION_MIGRATION} must complete before installing MariaDB write guards"
        )));
    }
    for required in [
        "pos_close_barrier",
        "pos_restore_gate",
        "pos_customer_write_locks",
    ] {
        if !mysql_table_exists(pool, required).await? {
            return Err(account_protocol_error(format!(
                "{MYSQL_COORDINATION_SCHEMA_MISSING_CODE}: {required} is required before installing MariaDB write guards"
            )));
        }
    }
    let (close_rows, restore_rows): (i64, i64) = sqlx::query_as(
        "SELECT
           (SELECT COUNT(*) FROM pos_close_barrier WHERE id = 1),
           (SELECT COUNT(*) FROM pos_restore_gate WHERE id = 1)",
    )
    .fetch_one(pool)
    .await?;
    if close_rows != 1 || restore_rows != 1 {
        return Err(account_protocol_error(format!(
            "{MYSQL_COORDINATION_SCHEMA_MISSING_CODE}: pos_close_barrier row 1 and pos_restore_gate row 1 are required before installing MariaDB write guards"
        )));
    }

    let mut tables = MARIADB_RESTORE_GUARDED_TABLES
        .iter()
        .chain(WHOLE_SYSTEM_CLOSE_GUARDED_TABLES.iter())
        .copied()
        .collect::<Vec<_>>();
    tables.sort_unstable();
    tables.dedup();
    let customer_identity_ready = mysql_table_exists(pool, "customers").await?
        && mysql_table_exists(pool, "tombstones").await?;
    let account_identity_ready =
        customer_identity_ready && mysql_table_exists(pool, "customer_accounts").await?;

    for &table in &tables {
        if !mysql_table_exists(pool, table).await? {
            continue;
        }
        for (suffix, operation) in [
            ("insert", "INSERT"),
            ("update", "UPDATE"),
            ("delete", "DELETE"),
        ] {
            let trigger_name = format!("lbj_guard_v4_{table}_{suffix}");
            let existing: Option<(String, String, String, i64, String)> = sqlx::query_as(
                "SELECT EVENT_OBJECT_TABLE, EVENT_MANIPULATION, ACTION_TIMING,
                        CAST(ACTION_ORDER AS SIGNED), ACTION_STATEMENT
                 FROM INFORMATION_SCHEMA.TRIGGERS
                 WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME = ?",
            )
            .bind(&trigger_name)
            .fetch_optional(pool)
            .await?;
            if existing.as_ref().is_some_and(
                |(actual_table, actual_operation, actual_timing, action_order, statement)| {
                    mysql_guard_v4_definition_is_current(
                        table,
                        operation,
                        actual_table,
                        actual_operation,
                        actual_timing,
                        *action_order,
                        statement,
                    )
                },
            ) {
                continue;
            }

            let earliest: Option<String> = sqlx::query_scalar(
                "SELECT TRIGGER_NAME FROM INFORMATION_SCHEMA.TRIGGERS
                 WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = ?
                   AND ACTION_TIMING = 'BEFORE' AND EVENT_MANIPULATION = ?
                   AND TRIGGER_NAME <> ?
                 ORDER BY ACTION_ORDER LIMIT 1",
            )
            .bind(table)
            .bind(operation)
            .bind(&trigger_name)
            .fetch_optional(pool)
            .await?;
            let ordering = earliest
                .as_deref()
                .map(|name| format!(" PRECEDES {}", mysql_identifier(name)))
                .unwrap_or_default();
            let identity_guard = if (matches!(table, "customers" | "orders" | "loyalty_logs")
                && customer_identity_ready)
                || (matches!(table, "customer_accounts" | "customer_account_entries")
                    && account_identity_ready)
            {
                mysql_customer_guard_v4_sql(table, operation)
            } else {
                ""
            };
            let sql = mysql_guarded_preflight_v4_sql(
                &trigger_name,
                table,
                operation,
                &ordering,
                identity_guard,
            );
            sqlx::query(&sql).execute(pool).await?;

            let installed: Option<(String, String, String, i64, String)> = sqlx::query_as(
                "SELECT EVENT_OBJECT_TABLE, EVENT_MANIPULATION, ACTION_TIMING,
                        CAST(ACTION_ORDER AS SIGNED), ACTION_STATEMENT
                 FROM INFORMATION_SCHEMA.TRIGGERS
                 WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME = ?",
            )
            .bind(&trigger_name)
            .fetch_optional(pool)
            .await?;
            let installed_is_current = installed.as_ref().is_some_and(
                |(actual_table, actual_operation, actual_timing, action_order, statement)| {
                    mysql_guard_v4_definition_is_current(
                        table,
                        operation,
                        actual_table,
                        actual_operation,
                        actual_timing,
                        *action_order,
                        statement,
                    )
                },
            );
            if !installed_is_current {
                return Err(account_protocol_error(format!(
                    "MYSQL_GUARD_DEFINITION_INVALID: failed to install current {trigger_name} first"
                )));
            }
        }
    }

    // Do not remove a previous combined/restore guard until every applicable
    // V4 trigger exists and has been verified as the first BEFORE trigger. If
    // any install above fails, the older protection remains and the upgrade
    // fails closed.
    for &table in &tables {
        for suffix in ["insert", "update", "delete"] {
            for old_trigger in [
                format!("lbj_guard_v3_{table}_{suffix}"),
                format!("lbj_restore_guard_{table}_{suffix}"),
            ] {
                sqlx::query(&format!(
                    "DROP TRIGGER IF EXISTS {}",
                    mysql_identifier(&old_trigger)
                ))
                .execute(pool)
                .await?;
            }
        }
    }
    Ok(())
}

/// Install the durable identity mutex and fail-closed guards used by both
/// current native writers and old clients that still write customer rows
/// directly. DDL is intentionally completed before a deletion transaction
/// begins, because MariaDB implicitly commits around CREATE TRIGGER.
async fn ensure_mysql_customer_deletion_guards(pool: &MySqlPool) -> Result<(), sqlx::Error> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS pos_customer_write_locks (
            customerId VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
              NOT NULL PRIMARY KEY
         ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
    )
    .execute(pool)
    .await?;

    // Establish the combined V4 protection before replacing any legacy
    // defense-in-depth trigger. MariaDB DDL must never leave customer identity
    // writes unguarded during an installed-app upgrade.
    ensure_mysql_guarded_preflight_v4(pool).await?;

    for sql in [
        "CREATE OR REPLACE TRIGGER pos_guard_customer_resurrection_insert
         BEFORE INSERT ON customers FOR EACH ROW
         BEGIN
           DECLARE lockedCustomerId VARCHAR(64);
           IF NOT EXISTS (
             SELECT 1 FROM pos_restore_gate
              WHERE id = 1 AND isActive = 1
                AND BINARY ownerTillId
                    = BINARY COALESCE(@lbj_pos_restore_bypass, '')
           ) THEN
             INSERT INTO pos_customer_write_locks (customerId) VALUES (NEW.id)
               ON DUPLICATE KEY UPDATE customerId = VALUES(customerId);
             SELECT customerId INTO lockedCustomerId
               FROM pos_customer_write_locks
               WHERE CONVERT(customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
                     = CONVERT(NEW.id USING utf8mb4) COLLATE utf8mb4_unicode_ci FOR UPDATE;
             IF EXISTS (
               SELECT 1 FROM tombstones
                WHERE table_name = 'customers'
                  AND CONVERT(row_id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                      = CONVERT(NEW.id USING utf8mb4) COLLATE utf8mb4_unicode_ci
             ) THEN
               SIGNAL SQLSTATE '45000'
                 SET MESSAGE_TEXT = 'CUSTOMER_DELETED: customer cannot be recreated';
             END IF;
           END IF;
         END",
        "CREATE OR REPLACE TRIGGER pos_guard_customer_resurrection_update
         BEFORE UPDATE ON customers FOR EACH ROW
         BEGIN
           DECLARE lockedCustomerId VARCHAR(64);
           IF CONVERT(NEW.id USING utf8mb4) COLLATE utf8mb4_unicode_ci
              <> CONVERT(OLD.id USING utf8mb4) COLLATE utf8mb4_unicode_ci THEN
             SIGNAL SQLSTATE '45000'
               SET MESSAGE_TEXT = 'CUSTOMER_ID_IMMUTABLE: customer id cannot change';
           END IF;
           IF NOT EXISTS (
             SELECT 1 FROM pos_restore_gate
              WHERE id = 1 AND isActive = 1
                AND BINARY ownerTillId
                    = BINARY COALESCE(@lbj_pos_restore_bypass, '')
           ) THEN
             INSERT INTO pos_customer_write_locks (customerId) VALUES (NEW.id)
               ON DUPLICATE KEY UPDATE customerId = VALUES(customerId);
             SELECT customerId INTO lockedCustomerId
               FROM pos_customer_write_locks
               WHERE CONVERT(customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
                     = CONVERT(NEW.id USING utf8mb4) COLLATE utf8mb4_unicode_ci FOR UPDATE;
             IF EXISTS (
               SELECT 1 FROM tombstones
                WHERE table_name = 'customers'
                  AND CONVERT(row_id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                      = CONVERT(NEW.id USING utf8mb4) COLLATE utf8mb4_unicode_ci
             ) THEN
               SIGNAL SQLSTATE '45000'
                 SET MESSAGE_TEXT = 'CUSTOMER_DELETED: customer cannot be updated';
             END IF;
           END IF;
         END",
        "CREATE OR REPLACE TRIGGER pos_guard_customer_account_resurrection_insert
         BEFORE INSERT ON customer_accounts FOR EACH ROW
         BEGIN
           DECLARE lockedCustomerId VARCHAR(64);
           IF NOT EXISTS (
             SELECT 1 FROM pos_restore_gate
              WHERE id = 1 AND isActive = 1
                AND BINARY ownerTillId
                    = BINARY COALESCE(@lbj_pos_restore_bypass, '')
           ) THEN
             INSERT INTO pos_customer_write_locks (customerId) VALUES (NEW.customerId)
               ON DUPLICATE KEY UPDATE customerId = VALUES(customerId);
             SELECT customerId INTO lockedCustomerId
               FROM pos_customer_write_locks
               WHERE CONVERT(customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
                     = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci FOR UPDATE;
             IF EXISTS (
               SELECT 1 FROM tombstones
                WHERE (table_name = 'customers'
                       AND CONVERT(row_id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                           = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci)
                   OR (table_name = 'customer_accounts'
                       AND CONVERT(row_id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                           = CONVERT(NEW.id USING utf8mb4) COLLATE utf8mb4_unicode_ci)
             ) OR NOT EXISTS (
               SELECT 1 FROM customers
               WHERE CONVERT(id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                     = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
             ) THEN
               SIGNAL SQLSTATE '45000'
                 SET MESSAGE_TEXT = 'CUSTOMER_DELETED: customer account cannot be recreated';
             END IF;
           END IF;
         END",
        "CREATE OR REPLACE TRIGGER pos_guard_customer_account_resurrection_update
         BEFORE UPDATE ON customer_accounts FOR EACH ROW
         BEGIN
           DECLARE lockedCustomerId VARCHAR(64);
           IF CONVERT(NEW.id USING utf8mb4) COLLATE utf8mb4_unicode_ci
              <> CONVERT(OLD.id USING utf8mb4) COLLATE utf8mb4_unicode_ci
              OR CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
                 <> CONVERT(OLD.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci THEN
             SIGNAL SQLSTATE '45000'
               SET MESSAGE_TEXT = 'CUSTOMER_ID_IMMUTABLE: account ownership cannot change';
           END IF;
           IF NOT EXISTS (
             SELECT 1 FROM pos_restore_gate
              WHERE id = 1 AND isActive = 1
                AND BINARY ownerTillId
                    = BINARY COALESCE(@lbj_pos_restore_bypass, '')
           ) THEN
             INSERT INTO pos_customer_write_locks (customerId) VALUES (NEW.customerId)
               ON DUPLICATE KEY UPDATE customerId = VALUES(customerId);
             SELECT customerId INTO lockedCustomerId
               FROM pos_customer_write_locks
               WHERE CONVERT(customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
                     = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci FOR UPDATE;
             IF EXISTS (
               SELECT 1 FROM tombstones
                WHERE (table_name = 'customers'
                       AND CONVERT(row_id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                           = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci)
                   OR (table_name = 'customer_accounts'
                       AND CONVERT(row_id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                           = CONVERT(NEW.id USING utf8mb4) COLLATE utf8mb4_unicode_ci)
             ) OR NOT EXISTS (
               SELECT 1 FROM customers
               WHERE CONVERT(id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                     = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
             ) THEN
               SIGNAL SQLSTATE '45000'
                 SET MESSAGE_TEXT = 'CUSTOMER_DELETED: customer account cannot be updated';
             END IF;
           END IF;
         END",
        "CREATE OR REPLACE TRIGGER pos_guard_customer_order_insert
         BEFORE INSERT ON orders FOR EACH ROW
         BEGIN
           DECLARE lockedCustomerId VARCHAR(64);
           IF COALESCE(TRIM(NEW.customerId), '') <> '' AND NOT EXISTS (
             SELECT 1 FROM pos_restore_gate
              WHERE id = 1 AND isActive = 1
                AND BINARY ownerTillId
                    = BINARY COALESCE(@lbj_pos_restore_bypass, '')
           ) THEN
             INSERT INTO pos_customer_write_locks (customerId) VALUES (NEW.customerId)
               ON DUPLICATE KEY UPDATE customerId = VALUES(customerId);
             SELECT customerId INTO lockedCustomerId
               FROM pos_customer_write_locks
               WHERE CONVERT(customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
                     = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci FOR UPDATE;
             IF EXISTS (
               SELECT 1 FROM tombstones
                WHERE table_name = 'customers'
                  AND CONVERT(row_id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                      = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
             ) OR NOT EXISTS (
               SELECT 1 FROM customers
               WHERE CONVERT(id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                     = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
             ) THEN
               SIGNAL SQLSTATE '45000'
                 SET MESSAGE_TEXT = 'CUSTOMER_DELETED: order customer is unavailable';
             END IF;
           END IF;
         END",
        "CREATE OR REPLACE TRIGGER pos_guard_customer_order_update
         BEFORE UPDATE ON orders FOR EACH ROW
         BEGIN
           DECLARE lockedCustomerId VARCHAR(64);
           IF CONVERT(COALESCE(NEW.customerId, '') USING utf8mb4) COLLATE utf8mb4_unicode_ci
              <> CONVERT(COALESCE(OLD.customerId, '') USING utf8mb4) COLLATE utf8mb4_unicode_ci THEN
             SIGNAL SQLSTATE '45000'
               SET MESSAGE_TEXT = 'CUSTOMER_ID_IMMUTABLE: order customer cannot change';
           END IF;
           IF COALESCE(TRIM(NEW.customerId), '') <> '' AND NOT EXISTS (
             SELECT 1 FROM pos_restore_gate
              WHERE id = 1 AND isActive = 1
                AND BINARY ownerTillId
                    = BINARY COALESCE(@lbj_pos_restore_bypass, '')
           ) THEN
             INSERT INTO pos_customer_write_locks (customerId) VALUES (NEW.customerId)
               ON DUPLICATE KEY UPDATE customerId = VALUES(customerId);
             SELECT customerId INTO lockedCustomerId
               FROM pos_customer_write_locks
               WHERE CONVERT(customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
                     = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci FOR UPDATE;
             IF EXISTS (
               SELECT 1 FROM tombstones
                WHERE table_name = 'customers'
                  AND CONVERT(row_id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                      = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
             ) OR NOT EXISTS (
               SELECT 1 FROM customers
               WHERE CONVERT(id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                     = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
             ) THEN
               SIGNAL SQLSTATE '45000'
                 SET MESSAGE_TEXT = 'CUSTOMER_DELETED: order customer is unavailable';
             END IF;
           END IF;
         END",
        "CREATE OR REPLACE TRIGGER pos_guard_customer_loyalty_log_insert
         BEFORE INSERT ON loyalty_logs FOR EACH ROW
         BEGIN
           DECLARE lockedCustomerId VARCHAR(64);
           IF COALESCE(TRIM(NEW.customerId), '') <> '' AND NOT EXISTS (
             SELECT 1 FROM pos_restore_gate
              WHERE id = 1 AND isActive = 1
                AND BINARY ownerTillId
                    = BINARY COALESCE(@lbj_pos_restore_bypass, '')
           ) THEN
             INSERT INTO pos_customer_write_locks (customerId) VALUES (NEW.customerId)
               ON DUPLICATE KEY UPDATE customerId = VALUES(customerId);
             SELECT customerId INTO lockedCustomerId
               FROM pos_customer_write_locks
               WHERE CONVERT(customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
                     = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci FOR UPDATE;
             IF EXISTS (
               SELECT 1 FROM tombstones
                WHERE table_name = 'customers'
                  AND CONVERT(row_id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                      = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
             ) OR NOT EXISTS (
               SELECT 1 FROM customers
               WHERE CONVERT(id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                     = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
             ) THEN
               SIGNAL SQLSTATE '45000'
                 SET MESSAGE_TEXT = 'CUSTOMER_DELETED: loyalty customer is unavailable';
             END IF;
           END IF;
         END",
        "CREATE OR REPLACE TRIGGER pos_guard_customer_loyalty_log_update
         BEFORE UPDATE ON loyalty_logs FOR EACH ROW
         BEGIN
           DECLARE lockedCustomerId VARCHAR(64);
           IF CONVERT(NEW.id USING utf8mb4) COLLATE utf8mb4_unicode_ci
              <> CONVERT(OLD.id USING utf8mb4) COLLATE utf8mb4_unicode_ci
              OR CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
                 <> CONVERT(OLD.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci THEN
             SIGNAL SQLSTATE '45000'
               SET MESSAGE_TEXT = 'CUSTOMER_ID_IMMUTABLE: loyalty ownership cannot change';
           END IF;
           IF COALESCE(TRIM(NEW.customerId), '') <> '' AND NOT EXISTS (
             SELECT 1 FROM pos_restore_gate
              WHERE id = 1 AND isActive = 1
                AND BINARY ownerTillId
                    = BINARY COALESCE(@lbj_pos_restore_bypass, '')
           ) THEN
             INSERT INTO pos_customer_write_locks (customerId) VALUES (NEW.customerId)
               ON DUPLICATE KEY UPDATE customerId = VALUES(customerId);
             SELECT customerId INTO lockedCustomerId
               FROM pos_customer_write_locks
               WHERE CONVERT(customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
                     = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci FOR UPDATE;
             IF EXISTS (
               SELECT 1 FROM tombstones
                WHERE table_name = 'customers'
                  AND CONVERT(row_id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                      = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
             ) OR NOT EXISTS (
               SELECT 1 FROM customers
               WHERE CONVERT(id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                     = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
             ) THEN
               SIGNAL SQLSTATE '45000'
                 SET MESSAGE_TEXT = 'CUSTOMER_DELETED: loyalty customer is unavailable';
             END IF;
           END IF;
         END",
        "CREATE OR REPLACE TRIGGER pos_guard_customer_account_entry_insert
         BEFORE INSERT ON customer_account_entries FOR EACH ROW
         BEGIN
           DECLARE lockedCustomerId VARCHAR(64);
           IF COALESCE(TRIM(NEW.customerId), '') <> '' AND NOT EXISTS (
             SELECT 1 FROM pos_restore_gate
              WHERE id = 1 AND isActive = 1
                AND BINARY ownerTillId
                    = BINARY COALESCE(@lbj_pos_restore_bypass, '')
           ) THEN
             INSERT INTO pos_customer_write_locks (customerId) VALUES (NEW.customerId)
               ON DUPLICATE KEY UPDATE customerId = VALUES(customerId);
             SELECT customerId INTO lockedCustomerId
               FROM pos_customer_write_locks
               WHERE CONVERT(customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
                     = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci FOR UPDATE;
             IF EXISTS (
               SELECT 1 FROM tombstones
                WHERE (table_name = 'customers'
                       AND CONVERT(row_id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                           = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci)
                   OR (table_name = 'customer_accounts'
                       AND CONVERT(row_id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                           = CONVERT(NEW.accountId USING utf8mb4) COLLATE utf8mb4_unicode_ci)
             ) OR NOT EXISTS (
               SELECT 1 FROM customers
               WHERE CONVERT(id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                     = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
             ) OR NOT EXISTS (
               SELECT 1 FROM customer_accounts
                WHERE CONVERT(id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                      = CONVERT(NEW.accountId USING utf8mb4) COLLATE utf8mb4_unicode_ci
                  AND CONVERT(customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
                      = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
             ) THEN
               SIGNAL SQLSTATE '45000'
                 SET MESSAGE_TEXT = 'CUSTOMER_DELETED: account entry owner is unavailable';
             END IF;
           END IF;
         END",
        "CREATE OR REPLACE TRIGGER pos_guard_customer_account_entry_update
         BEFORE UPDATE ON customer_account_entries FOR EACH ROW
         BEGIN
           DECLARE lockedCustomerId VARCHAR(64);
           IF CONVERT(NEW.id USING utf8mb4) COLLATE utf8mb4_unicode_ci
              <> CONVERT(OLD.id USING utf8mb4) COLLATE utf8mb4_unicode_ci
              OR CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
                 <> CONVERT(OLD.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
              OR CONVERT(NEW.accountId USING utf8mb4) COLLATE utf8mb4_unicode_ci
                 <> CONVERT(OLD.accountId USING utf8mb4) COLLATE utf8mb4_unicode_ci THEN
             SIGNAL SQLSTATE '45000'
               SET MESSAGE_TEXT = 'CUSTOMER_ID_IMMUTABLE: account entry ownership cannot change';
           END IF;
           IF COALESCE(TRIM(NEW.customerId), '') <> '' AND NOT EXISTS (
             SELECT 1 FROM pos_restore_gate
              WHERE id = 1 AND isActive = 1
                AND BINARY ownerTillId
                    = BINARY COALESCE(@lbj_pos_restore_bypass, '')
           ) THEN
             INSERT INTO pos_customer_write_locks (customerId) VALUES (NEW.customerId)
               ON DUPLICATE KEY UPDATE customerId = VALUES(customerId);
             SELECT customerId INTO lockedCustomerId
               FROM pos_customer_write_locks
               WHERE CONVERT(customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
                     = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci FOR UPDATE;
             IF EXISTS (
               SELECT 1 FROM tombstones
                WHERE (table_name = 'customers'
                       AND CONVERT(row_id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                           = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci)
                   OR (table_name = 'customer_accounts'
                       AND CONVERT(row_id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                           = CONVERT(NEW.accountId USING utf8mb4) COLLATE utf8mb4_unicode_ci)
             ) OR NOT EXISTS (
               SELECT 1 FROM customers
               WHERE CONVERT(id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                     = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
             ) OR NOT EXISTS (
               SELECT 1 FROM customer_accounts
                WHERE CONVERT(id USING utf8mb4) COLLATE utf8mb4_unicode_ci
                      = CONVERT(NEW.accountId USING utf8mb4) COLLATE utf8mb4_unicode_ci
                  AND CONVERT(customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
                      = CONVERT(NEW.customerId USING utf8mb4) COLLATE utf8mb4_unicode_ci
             ) THEN
               SIGNAL SQLSTATE '45000'
                 SET MESSAGE_TEXT = 'CUSTOMER_DELETED: account entry owner is unavailable';
             END IF;
           END IF;
         END",
        "CREATE TRIGGER IF NOT EXISTS pos_delete_customers
         AFTER DELETE ON customers FOR EACH ROW
         INSERT INTO tombstones (id, table_name, row_id, deletedAt, updatedAt)
         VALUES (
           CONCAT('customers:', OLD.id), 'customers', OLD.id,
           DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ'),
           DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ')
         )
         ON DUPLICATE KEY UPDATE
           deletedAt = VALUES(deletedAt), updatedAt = VALUES(updatedAt)",
        "CREATE TRIGGER IF NOT EXISTS pos_delete_customer_accounts
         AFTER DELETE ON customer_accounts FOR EACH ROW
         INSERT INTO tombstones (id, table_name, row_id, deletedAt, updatedAt)
         VALUES (
           CONCAT('customer_accounts:', OLD.id), 'customer_accounts', OLD.id,
           DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ'),
           DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ')
         )
         ON DUPLICATE KEY UPDATE
           deletedAt = VALUES(deletedAt), updatedAt = VALUES(updatedAt)",
    ] {
        sqlx::query(sql).execute(pool).await?;
    }
    ensure_mysql_guarded_preflight_v4(pool).await?;
    Ok(())
}

/// Install database-boundary protection for durable receivables. A legacy or
/// generic sync writer may still update account configuration, but it cannot
/// replace a balance or mutate ledger history. DDL completes before the native
/// transaction starts because MariaDB implicitly commits around CREATE TRIGGER.
async fn mysql_account_ledger_guards_are_current(pool: &MySqlPool) -> Result<bool, sqlx::Error> {
    let mut query = QueryBuilder::<MySql>::new(
        "SELECT
           CAST((SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
                  WHERE TABLE_SCHEMA = DATABASE()
                    AND TABLE_NAME IN (
                      'pos_restore_gate', 'pos_account_write_authority'
                    )) AS SIGNED),
           CAST(COUNT(DISTINCT CASE WHEN
             guard.ACTION_TIMING = 'BEFORE'
             AND (
               (guard.TRIGGER_NAME = 'pos_guard_account_balance_insert'
                AND guard.EVENT_OBJECT_TABLE = 'customer_accounts'
                AND guard.EVENT_MANIPULATION = 'INSERT')
               OR (guard.TRIGGER_NAME = 'pos_guard_account_balance_update'
                   AND guard.EVENT_OBJECT_TABLE = 'customer_accounts'
                   AND guard.EVENT_MANIPULATION = 'UPDATE')
               OR (guard.TRIGGER_NAME = 'pos_guard_account_delete'
                   AND guard.EVENT_OBJECT_TABLE = 'customer_accounts'
                   AND guard.EVENT_MANIPULATION = 'DELETE')
               OR (guard.TRIGGER_NAME = 'pos_guard_account_entry_insert'
                   AND guard.EVENT_OBJECT_TABLE = 'customer_account_entries'
                   AND guard.EVENT_MANIPULATION = 'INSERT')
               OR (guard.TRIGGER_NAME = 'pos_guard_account_entry_update'
                   AND guard.EVENT_OBJECT_TABLE = 'customer_account_entries'
                   AND guard.EVENT_MANIPULATION = 'UPDATE')
               OR (guard.TRIGGER_NAME = 'pos_guard_account_entry_delete'
                   AND guard.EVENT_OBJECT_TABLE = 'customer_account_entries'
                   AND guard.EVENT_MANIPULATION = 'DELETE')
             )
             AND LOCATE(",
    );
    query.push_bind(ACCOUNT_LEDGER_AUTHORITY_CODE);
    query.push(
        ", guard.ACTION_STATEMENT) > 0
             AND LOCATE('pos_account_write_authority', guard.ACTION_STATEMENT) > 0
             AND LOCATE('@lbj_pos_account_authority', guard.ACTION_STATEMENT) > 0
             AND LOCATE('CONNECTION_ID()', guard.ACTION_STATEMENT) > 0
             AND LOCATE('authority.expiresAt > UTC_TIMESTAMP(3)',
                        guard.ACTION_STATEMENT) > 0
             AND LOCATE('BINARY authority.authorityToken',
                        guard.ACTION_STATEMENT) > 0
             AND LOCATE('pos_restore_gate', guard.ACTION_STATEMENT) > 0
             AND LOCATE('@lbj_pos_restore_bypass', guard.ACTION_STATEMENT) > 0
             AND LOCATE('isActive = 1', guard.ACTION_STATEMENT) > 0
             AND LOCATE('BINARY ownerTillId', guard.ACTION_STATEMENT) > 0
             THEN guard.TRIGGER_NAME END) AS SIGNED)
         FROM INFORMATION_SCHEMA.TRIGGERS AS guard
         WHERE guard.TRIGGER_SCHEMA = DATABASE()
           AND guard.TRIGGER_NAME IN (
             'pos_guard_account_balance_insert',
             'pos_guard_account_balance_update',
             'pos_guard_account_delete',
             'pos_guard_account_entry_insert',
             'pos_guard_account_entry_update',
             'pos_guard_account_entry_delete'
           )",
    );
    let (coordination_tables, current_guards): (i64, i64) =
        query.build_query_as().fetch_one(pool).await?;
    Ok(coordination_tables == 2 && current_guards == 6)
}

async fn ensure_mysql_account_ledger_guards(pool: &MySqlPool) -> Result<(), sqlx::Error> {
    if mysql_account_ledger_guards_are_current(pool).await? {
        ensure_mysql_guarded_preflight_v4(pool).await?;
        return Ok(());
    }

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS pos_restore_gate (
            id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
            ownerTillId VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
              NOT NULL DEFAULT '',
            isActive TINYINT NOT NULL DEFAULT 0,
            claimedAt VARCHAR(40) NOT NULL DEFAULT ''
         ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "INSERT IGNORE INTO pos_restore_gate (id, ownerTillId, isActive, claimedAt)
         VALUES (1, '', 0, '')",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS pos_account_write_authority (
            connectionId BIGINT UNSIGNED NOT NULL PRIMARY KEY,
            authorityToken VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
            expiresAt DATETIME(3) NOT NULL
         ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin",
    )
    .execute(pool)
    .await?;

    for sql in [
        "CREATE OR REPLACE TRIGGER pos_guard_account_balance_insert
         BEFORE INSERT ON customer_accounts FOR EACH ROW
         BEGIN
           IF COALESCE(NEW.balancePence, 0) <> 0 AND NOT (
             EXISTS (
               SELECT 1 FROM pos_account_write_authority AS authority
                WHERE authority.connectionId = CONNECTION_ID()
                  AND BINARY authority.authorityToken
                      = BINARY COALESCE(@lbj_pos_account_authority, '')
                  AND BINARY authority.authorityToken <> BINARY ''
                  AND authority.expiresAt > UTC_TIMESTAMP(3)
             ) OR EXISTS (
               SELECT 1 FROM pos_restore_gate
                WHERE id = 1 AND isActive = 1
                  AND BINARY ownerTillId <> BINARY ''
                  AND BINARY ownerTillId
                      = BINARY COALESCE(@lbj_pos_restore_bypass, '')
             )
           ) THEN
             SIGNAL SQLSTATE '45000'
               SET MESSAGE_TEXT = 'ACCOUNT_LEDGER_AUTHORITY_REQUIRED: nonzero account balance insert blocked';
           END IF;
         END",
        "CREATE OR REPLACE TRIGGER pos_guard_account_balance_update
         BEFORE UPDATE ON customer_accounts FOR EACH ROW
         BEGIN
           IF NOT (NEW.balancePence <=> OLD.balancePence) AND NOT (
             EXISTS (
               SELECT 1 FROM pos_account_write_authority AS authority
                WHERE authority.connectionId = CONNECTION_ID()
                  AND BINARY authority.authorityToken
                      = BINARY COALESCE(@lbj_pos_account_authority, '')
                  AND BINARY authority.authorityToken <> BINARY ''
                  AND authority.expiresAt > UTC_TIMESTAMP(3)
             ) OR EXISTS (
               SELECT 1 FROM pos_restore_gate
                WHERE id = 1 AND isActive = 1
                  AND BINARY ownerTillId <> BINARY ''
                  AND BINARY ownerTillId
                      = BINARY COALESCE(@lbj_pos_restore_bypass, '')
             )
           ) THEN
             SIGNAL SQLSTATE '45000'
               SET MESSAGE_TEXT = 'ACCOUNT_LEDGER_AUTHORITY_REQUIRED: account balance update blocked';
           END IF;
         END",
        "CREATE OR REPLACE TRIGGER pos_guard_account_delete
         BEFORE DELETE ON customer_accounts FOR EACH ROW
         BEGIN
           IF NOT (
             EXISTS (
               SELECT 1 FROM pos_account_write_authority AS authority
                WHERE authority.connectionId = CONNECTION_ID()
                  AND BINARY authority.authorityToken
                      = BINARY COALESCE(@lbj_pos_account_authority, '')
                  AND BINARY authority.authorityToken <> BINARY ''
                  AND authority.expiresAt > UTC_TIMESTAMP(3)
             ) OR EXISTS (
               SELECT 1 FROM pos_restore_gate
                WHERE id = 1 AND isActive = 1
                  AND BINARY ownerTillId <> BINARY ''
                  AND BINARY ownerTillId
                      = BINARY COALESCE(@lbj_pos_restore_bypass, '')
             )
           ) THEN
             SIGNAL SQLSTATE '45000'
               SET MESSAGE_TEXT = 'ACCOUNT_LEDGER_AUTHORITY_REQUIRED: account deletion blocked';
           END IF;
         END",
        "CREATE OR REPLACE TRIGGER pos_guard_account_entry_insert
         BEFORE INSERT ON customer_account_entries FOR EACH ROW
         BEGIN
           IF NOT (
             EXISTS (
               SELECT 1 FROM pos_account_write_authority AS authority
                WHERE authority.connectionId = CONNECTION_ID()
                  AND BINARY authority.authorityToken
                      = BINARY COALESCE(@lbj_pos_account_authority, '')
                  AND BINARY authority.authorityToken <> BINARY ''
                  AND authority.expiresAt > UTC_TIMESTAMP(3)
             ) OR EXISTS (
               SELECT 1 FROM pos_restore_gate
                WHERE id = 1 AND isActive = 1
                  AND BINARY ownerTillId <> BINARY ''
                  AND BINARY ownerTillId
                      = BINARY COALESCE(@lbj_pos_restore_bypass, '')
             )
           ) THEN
             SIGNAL SQLSTATE '45000'
               SET MESSAGE_TEXT = 'ACCOUNT_LEDGER_AUTHORITY_REQUIRED: account ledger insert blocked';
           END IF;
         END",
        "CREATE OR REPLACE TRIGGER pos_guard_account_entry_update
         BEFORE UPDATE ON customer_account_entries FOR EACH ROW
         BEGIN
           IF NOT (
             EXISTS (
               SELECT 1 FROM pos_account_write_authority AS authority
                WHERE authority.connectionId = CONNECTION_ID()
                  AND BINARY authority.authorityToken
                      = BINARY COALESCE(@lbj_pos_account_authority, '')
                  AND BINARY authority.authorityToken <> BINARY ''
                  AND authority.expiresAt > UTC_TIMESTAMP(3)
             ) OR EXISTS (
               SELECT 1 FROM pos_restore_gate
                WHERE id = 1 AND isActive = 1
                  AND BINARY ownerTillId <> BINARY ''
                  AND BINARY ownerTillId
                      = BINARY COALESCE(@lbj_pos_restore_bypass, '')
             )
           ) THEN
             SIGNAL SQLSTATE '45000'
               SET MESSAGE_TEXT = 'ACCOUNT_LEDGER_AUTHORITY_REQUIRED: account ledger update blocked';
           END IF;
         END",
        "CREATE OR REPLACE TRIGGER pos_guard_account_entry_delete
         BEFORE DELETE ON customer_account_entries FOR EACH ROW
         BEGIN
           IF NOT (
             EXISTS (
               SELECT 1 FROM pos_account_write_authority AS authority
                WHERE authority.connectionId = CONNECTION_ID()
                  AND BINARY authority.authorityToken
                      = BINARY COALESCE(@lbj_pos_account_authority, '')
                  AND BINARY authority.authorityToken <> BINARY ''
                  AND authority.expiresAt > UTC_TIMESTAMP(3)
             ) OR EXISTS (
               SELECT 1 FROM pos_restore_gate
                WHERE id = 1 AND isActive = 1
                  AND BINARY ownerTillId <> BINARY ''
                  AND BINARY ownerTillId
                      = BINARY COALESCE(@lbj_pos_restore_bypass, '')
             )
           ) THEN
             SIGNAL SQLSTATE '45000'
               SET MESSAGE_TEXT = 'ACCOUNT_LEDGER_AUTHORITY_REQUIRED: account ledger deletion blocked';
           END IF;
         END",
    ] {
        sqlx::query(sql).execute(pool).await?;
    }
    ensure_mysql_guarded_preflight_v4(pool).await?;
    Ok(())
}

fn new_mysql_account_authority_token() -> String {
    let mut random = [0_u8; 32];
    OsRng.fill_bytes(&mut random);
    random.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Grant authority only to the current physical MariaDB connection and only
/// inside the caller's transaction. The guard row is inserted and revoked in
/// that same transaction, so a rollback or dropped connection cannot leak a
/// reusable privilege into the pool.
async fn grant_mysql_account_write_authority(
    tx: &mut sqlx::Transaction<'_, sqlx::MySql>,
) -> Result<String, sqlx::Error> {
    let token = new_mysql_account_authority_token();
    sqlx::query("SET @lbj_pos_account_authority = ?")
        .bind(&token)
        .execute(&mut **tx)
        .await?;
    sqlx::query(
        "INSERT INTO pos_account_write_authority
            (connectionId, authorityToken, expiresAt)
         VALUES (CONNECTION_ID(), ?, TIMESTAMPADD(MINUTE, 5, UTC_TIMESTAMP(3)))
         ON DUPLICATE KEY UPDATE
            authorityToken = VALUES(authorityToken), expiresAt = VALUES(expiresAt)",
    )
    .bind(&token)
    .execute(&mut **tx)
    .await?;
    Ok(token)
}

async fn revoke_mysql_account_write_authority(
    tx: &mut sqlx::Transaction<'_, sqlx::MySql>,
    token: &str,
) -> Result<(), sqlx::Error> {
    let deleted = sqlx::query(
        "DELETE FROM pos_account_write_authority
         WHERE connectionId = CONNECTION_ID() AND authorityToken = ?",
    )
    .bind(token)
    .execute(&mut **tx)
    .await?;
    // Always clear the non-transactional session variable before returning the
    // pooled connection, including the fail-closed missing-row case.
    sqlx::query("SET @lbj_pos_account_authority = NULL")
        .execute(&mut **tx)
        .await?;
    if deleted.rows_affected() != 1 {
        return Err(account_protocol_error(format!(
            "{ACCOUNT_LEDGER_AUTHORITY_CODE}: native account authority was lost"
        )));
    }
    Ok(())
}

/// Transaction-scoped mutex for one logical customer identity. It exists even
/// after the business row is deleted, so a stale INSERT cannot pass a tombstone
/// check before deletion and then complete afterward.
async fn lock_mysql_customer_identity(
    tx: &mut sqlx::Transaction<'_, sqlx::MySql>,
    customer_id: &str,
) -> Result<(), sqlx::Error> {
    // Use an idempotent UPDATE rather than INSERT IGNORE. On an existing row,
    // INSERT IGNORE can first acquire a shared duplicate-key lock; two writers
    // can then deadlock while both upgrade it for SELECT ... FOR UPDATE. This
    // no-op upsert takes the durable identity mutex exclusively up front.
    sqlx::query(
        "INSERT INTO pos_customer_write_locks (customerId) VALUES (?)
         ON DUPLICATE KEY UPDATE customerId = VALUES(customerId)",
    )
    .bind(customer_id)
    .execute(&mut **tx)
    .await?;
    let _: String = sqlx::query_scalar(
        "SELECT CAST(customerId AS CHAR) FROM pos_customer_write_locks
         WHERE customerId = ? FOR UPDATE",
    )
    .bind(customer_id)
    .fetch_one(&mut **tx)
    .await?;
    Ok(())
}

/// Lock and verify a customer before any native order, loyalty, or account
/// writer touches dependent rows. Account locks must always be taken later.
async fn lock_mysql_customer_for_write(
    tx: &mut sqlx::Transaction<'_, sqlx::MySql>,
    customer_id: &str,
) -> Result<i64, sqlx::Error> {
    lock_mysql_customer_identity(tx, customer_id).await?;
    let loyalty_points: Option<i64> = sqlx::query_scalar(
        "SELECT CAST(COALESCE(loyaltyPoints, 0) AS SIGNED)
         FROM customers WHERE id = ? LIMIT 1 FOR UPDATE",
    )
    .bind(customer_id)
    .fetch_optional(&mut **tx)
    .await?;
    let tombstoned: i64 = sqlx::query_scalar(
        "SELECT EXISTS(
           SELECT 1 FROM tombstones
            WHERE table_name = 'customers' AND row_id = ?
         )",
    )
    .bind(customer_id)
    .fetch_one(&mut **tx)
    .await?;
    if tombstoned != 0 {
        return Err(account_protocol_error(format!(
            "{CUSTOMER_DELETED_CODE}: customer was permanently deleted"
        )));
    }
    loyalty_points.ok_or_else(|| account_protocol_error("Customer was not found"))
}

async fn lock_mysql_bundle_customers(
    tx: &mut sqlx::Transaction<'_, sqlx::MySql>,
    bundle: &SaleBundle,
) -> Result<(), sqlx::Error> {
    let mut customer_ids = bundle
        .loyalty_changes
        .iter()
        .map(|change| change.customer_id.trim())
        .chain(
            bundle
                .account_changes
                .iter()
                .map(|change| change.customer_id.trim()),
        )
        .filter(|customer_id| !customer_id.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    let order_customer_id = bundle.order.customer_id.trim();
    if !order_customer_id.is_empty() {
        customer_ids.push(order_customer_id.to_string());
    }
    if let Some(original_order_id) = bundle
        .original_order_to_update
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let original_customer_id: Option<String> = sqlx::query_scalar(
            "SELECT CAST(customerId AS CHAR) FROM orders
             WHERE id = ? AND COALESCE(TRIM(customerId), '') <> '' LIMIT 1",
        )
        .bind(original_order_id)
        .fetch_optional(&mut **tx)
        .await?;
        if let Some(customer_id) = original_customer_id {
            customer_ids.push(customer_id);
        }
    }
    customer_ids.sort();
    customer_ids.dedup();
    for customer_id in customer_ids {
        lock_mysql_customer_for_write(tx, &customer_id).await?;
    }
    Ok(())
}

async fn sqlite_restore_table_exists(pool: &SqlitePool, table: &str) -> Result<bool, sqlx::Error> {
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?")
            .bind(table)
            .fetch_one(pool)
            .await?;
    Ok(count > 0)
}

async fn ensure_mysql_restore_guard_schema(pool: &MySqlPool) -> Result<(), sqlx::Error> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS pos_restore_gate (
            id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
            ownerTillId VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
              NOT NULL DEFAULT '',
            isActive TINYINT NOT NULL DEFAULT 0,
            claimedAt VARCHAR(40) NOT NULL DEFAULT ''
         ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS pos_customer_write_locks (
            customerId VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
              NOT NULL PRIMARY KEY
         ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "INSERT IGNORE INTO pos_restore_gate (id, ownerTillId, isActive, claimedAt)
         VALUES (1, '', 0, '')",
    )
    .execute(pool)
    .await?;

    for table in MARIADB_RESTORE_GUARDED_TABLES {
        if !mysql_table_exists(pool, table).await? {
            continue;
        }
        for (operation, timing) in [
            ("insert", "INSERT"),
            ("update", "UPDATE"),
            ("delete", "DELETE"),
        ] {
            let trigger_name = format!("lbj_restore_guard_{table}_{operation}");
            let exists: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TRIGGERS
                 WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME = ?",
            )
            .bind(&trigger_name)
            .fetch_one(pool)
            .await?;
            if exists > 0 {
                continue;
            }
            let sql = format!(
                "CREATE TRIGGER {} BEFORE {timing} ON {} FOR EACH ROW
                 BEGIN
                   IF EXISTS (
                     SELECT 1 FROM pos_restore_gate
                     WHERE id = 1 AND isActive = 1
                       AND BINARY ownerTillId
                           <> BINARY COALESCE(@lbj_pos_restore_bypass, '')
                   ) THEN
                     SIGNAL SQLSTATE '45000'
                       SET MESSAGE_TEXT = 'MARIADB_RESTORE_MAINTENANCE: write blocked';
                   END IF;
                 END",
                mysql_identifier(&trigger_name),
                mysql_identifier(table),
            );
            sqlx::query(&sql).execute(pool).await?;
        }
    }
    Ok(())
}

async fn ensure_mysql_whole_system_close_schema(pool: &MySqlPool) -> Result<(), sqlx::Error> {
    // Close coordination is also the migration entry point on installations
    // which have never performed a restore or deleted a customer. Create the
    // two later locks now so V4 can always establish the complete order.
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS pos_restore_gate (
            id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
            ownerTillId VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
              NOT NULL DEFAULT '',
            isActive TINYINT NOT NULL DEFAULT 0,
            claimedAt VARCHAR(40) NOT NULL DEFAULT ''
         ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "INSERT IGNORE INTO pos_restore_gate (id, ownerTillId, isActive, claimedAt)
         VALUES (1, '', 0, '')",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS pos_customer_write_locks (
            customerId VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
              NOT NULL PRIMARY KEY
         ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS pos_close_barrier (
            id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
            token VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
              NOT NULL DEFAULT '',
            state VARCHAR(16) NOT NULL DEFAULT 'idle',
            ownerTillId VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
              NOT NULL DEFAULT '',
            requestedAt DATETIME(3) NULL,
            expiresAt DATETIME(3) NULL,
            cutoffAt DATETIME(3) NULL,
            lastClosedAt DATETIME(3) NULL
         ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin",
    )
    .execute(pool)
    .await?;
    let last_closed_exists: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pos_close_barrier'
           AND COLUMN_NAME = 'lastClosedAt'",
    )
    .fetch_one(pool)
    .await?;
    if last_closed_exists == 0 {
        sqlx::query("ALTER TABLE pos_close_barrier ADD COLUMN lastClosedAt DATETIME(3) NULL")
            .execute(pool)
            .await?;
    }
    sqlx::query(
        "INSERT IGNORE INTO pos_close_barrier
            (id, token, state, ownerTillId, requestedAt, expiresAt, cutoffAt)
         VALUES (1, '', 'idle', '', NULL, NULL, NULL)",
    )
    .execute(pool)
    .await?;

    if !mysql_table_exists(pool, "till_presence").await? {
        return Err(account_protocol_error(
            "Whole-system close requires the till_presence table",
        ));
    }
    for definition in [
        "closeProtocolVersion INT NOT NULL DEFAULT 0",
        "closeBarrierToken VARCHAR(191) NOT NULL DEFAULT ''",
        "closeBarrierPhase VARCHAR(16) NOT NULL DEFAULT ''",
        "outboxCount BIGINT NOT NULL DEFAULT 0",
        "localTerminalAttemptCount BIGINT NOT NULL DEFAULT 0",
        "syncConflictCount BIGINT NOT NULL DEFAULT 0",
        "barrierObservedAt DATETIME(3) NULL",
    ] {
        let column = definition.split_whitespace().next().unwrap_or_default();
        let exists: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'till_presence'
               AND COLUMN_NAME = ?",
        )
        .bind(column)
        .fetch_one(pool)
        .await?;
        if exists == 0 {
            sqlx::query(&format!(
                "ALTER TABLE till_presence ADD COLUMN {}",
                definition
            ))
            .execute(pool)
            .await?;
        }
    }

    for table in WHOLE_SYSTEM_CLOSE_GUARDED_TABLES {
        if !mysql_table_exists(pool, table).await? {
            continue;
        }
        for (operation, timing) in [
            ("insert", "INSERT"),
            ("update", "UPDATE"),
            ("delete", "DELETE"),
        ] {
            // v2 adds a locking read. Keep any v1 trigger in place during an
            // upgrade so there is never an unguarded DDL replacement window.
            let trigger_name = format!("lbj_close_guard_v2_{table}_{operation}");
            let exists: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TRIGGERS
                 WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME = ?",
            )
            .bind(&trigger_name)
            .fetch_one(pool)
            .await?;
            if exists > 0 {
                continue;
            }
            let sql = format!(
                "CREATE TRIGGER {} BEFORE {timing} ON {} FOR EACH ROW
                 BEGIN
                   DECLARE barrierState VARCHAR(16) DEFAULT 'idle';
                   DECLARE barrierExpiry DATETIME(3) DEFAULT NULL;
                   SELECT state, expiresAt INTO barrierState, barrierExpiry
                     FROM pos_close_barrier WHERE id = 1 FOR UPDATE;
                   IF barrierState = 'frozen'
                      AND barrierExpiry IS NOT NULL
                      AND barrierExpiry <= UTC_TIMESTAMP(3) THEN
                     UPDATE pos_close_barrier
                     SET token = '', state = 'idle', ownerTillId = '',
                         requestedAt = NULL, expiresAt = NULL, cutoffAt = NULL
                     WHERE id = 1;
                     SET barrierState = 'idle';
                   END IF;
                   IF barrierState = 'frozen' THEN
                     SIGNAL SQLSTATE '45000'
                       SET MESSAGE_TEXT = 'WHOLE_SYSTEM_CLOSE_IN_PROGRESS: write blocked';
                   END IF;
                 END",
                mysql_identifier(&trigger_name),
                mysql_identifier(table),
            );
            sqlx::query(&sql).execute(pool).await?;
        }
    }
    // Install the combined first trigger before retiring the legacy cutoff
    // trigger, so there is no DDL window where raw order inserts are unguarded.
    ensure_mysql_guarded_preflight_v4(pool).await?;
    if mysql_table_exists(pool, "orders").await? {
        // V4 already enforces both restore and cutoff protection, so refreshing
        // this defense-in-depth trigger cannot create an unguarded write window.
        for sql in [
            "CREATE OR REPLACE TRIGGER lbj_close_cutoff_guard_v2_orders_insert
                 BEFORE INSERT ON orders FOR EACH ROW
                 BEGIN
                   DECLARE lastClosed DATETIME(3) DEFAULT NULL;
                   IF NOT EXISTS (
                     SELECT 1 FROM pos_restore_gate
                      WHERE id = 1 AND isActive = 1
                        AND BINARY ownerTillId <> BINARY ''
                        AND BINARY ownerTillId
                            = BINARY COALESCE(@lbj_pos_restore_bypass, '')
                   ) THEN
                     SELECT lastClosedAt INTO lastClosed
                       FROM pos_close_barrier WHERE id = 1;
                     IF lastClosed IS NOT NULL
                        AND COALESCE(NEW.completedAt, '') <> ''
                        AND NEW.completedAt <= DATE_FORMAT(lastClosed, '%Y-%m-%dT%H:%i:%s.%fZ') THEN
                       SIGNAL SQLSTATE '45000'
                         SET MESSAGE_TEXT = 'REPORT_PERIOD_CLOSED: sale timestamp is before the latest close';
                     END IF;
                   END IF;
                 END",
            "CREATE OR REPLACE TRIGGER lbj_close_cutoff_guard_v2_orders_update
                 BEFORE UPDATE ON orders FOR EACH ROW
                 BEGIN
                   DECLARE lastClosed DATETIME(3) DEFAULT NULL;
                   IF NOT EXISTS (
                     SELECT 1 FROM pos_restore_gate
                      WHERE id = 1 AND isActive = 1
                        AND BINARY ownerTillId <> BINARY ''
                        AND BINARY ownerTillId
                            = BINARY COALESCE(@lbj_pos_restore_bypass, '')
                   ) THEN
                     SELECT lastClosedAt INTO lastClosed
                       FROM pos_close_barrier WHERE id = 1;
                     IF lastClosed IS NOT NULL
                        AND COALESCE(NEW.status, '') IN
                            ('completed', 'refunded', 'partially_refunded', 'voided')
                        AND COALESCE(NEW.completedAt, '') <> ''
                        AND NEW.completedAt <= DATE_FORMAT(lastClosed, '%Y-%m-%dT%H:%i:%s.%fZ') THEN
                       SIGNAL SQLSTATE '45000'
                         SET MESSAGE_TEXT = 'REPORT_PERIOD_CLOSED: order update is before the latest close';
                     END IF;
                   END IF;
                 END",
        ] {
            sqlx::query(sql).execute(pool).await?;
        }
        sqlx::query("DROP TRIGGER IF EXISTS lbj_close_cutoff_guard_orders_insert")
            .execute(pool)
            .await?;
        sqlx::query("DROP TRIGGER IF EXISTS lbj_close_cutoff_guard_orders_update")
            .execute(pool)
            .await?;
    }
    if mysql_table_exists(pool, "till_report_markers").await? {
        sqlx::query(
            "UPDATE pos_close_barrier
             SET lastClosedAt = (
               SELECT MAX(STR_TO_DATE(
                 REPLACE(REPLACE(markerTime, 'T', ' '), 'Z', ''),
                 '%Y-%m-%d %H:%i:%s.%f'
               )) FROM till_report_markers
               WHERE tillNumber = '' AND type = 'period'
             )
             WHERE id = 1 AND lastClosedAt IS NULL",
        )
        .execute(pool)
        .await?;
    }
    Ok(())
}

/// Close polling runs once per second while every active till acknowledges the
/// barrier. The full migration above is deliberately kept out of that hot path:
/// it inspects and may replace triggers, which can wait on MariaDB metadata
/// locks. A successful `begin_whole_system_close` has already run the migration,
/// so subsequent commands only need to fail closed if that coordination schema
/// was removed or damaged underneath the active close.
async fn assert_mysql_whole_system_close_barrier_ready(
    pool: &MySqlPool,
) -> Result<(), sqlx::Error> {
    let column_count: i64 = sqlx::query_scalar(MYSQL_CLOSE_BARRIER_READY_COLUMN_COUNT_SELECT)
        .fetch_one(pool)
        .await?;
    if column_count != 7 {
        return Err(account_protocol_error(format!(
            "{MYSQL_COORDINATION_SCHEMA_MISSING_CODE}: the whole-system close barrier is unavailable"
        )));
    }
    let close_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pos_close_barrier WHERE id = 1")
        .fetch_one(pool)
        .await?;
    if close_rows != 1 {
        return Err(account_protocol_error(format!(
            "{MYSQL_COORDINATION_SCHEMA_MISSING_CODE}: the whole-system close barrier row is unavailable"
        )));
    }
    Ok(())
}

async fn assert_mysql_whole_system_close_schema_ready(pool: &MySqlPool) -> Result<(), sqlx::Error> {
    let (table_count, column_count): (i64, i64) = sqlx::query_as(
        "SELECT
           (SELECT COUNT(DISTINCT TABLE_NAME)
              FROM INFORMATION_SCHEMA.TABLES
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME IN
                   ('pos_close_barrier', 'pos_restore_gate', 'till_presence')),
           (SELECT COUNT(*)
              FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND (
                 (TABLE_NAME = 'pos_close_barrier' AND COLUMN_NAME IN
                    ('id', 'token', 'state', 'ownerTillId', 'requestedAt',
                     'expiresAt', 'cutoffAt', 'lastClosedAt'))
                 OR
                 (TABLE_NAME = 'pos_restore_gate' AND COLUMN_NAME IN
                    ('id', 'ownerTillId', 'isActive', 'claimedAt'))
                 OR
                 (TABLE_NAME = 'till_presence' AND COLUMN_NAME IN
                    ('tillId', 'tillName', 'lastSeenAt', 'closeProtocolVersion',
                     'closeBarrierToken', 'closeBarrierPhase', 'outboxCount',
                     'localTerminalAttemptCount', 'syncConflictCount',
                     'barrierObservedAt'))
               ))",
    )
    .fetch_one(pool)
    .await?;
    if table_count != 3 || column_count != 22 {
        return Err(account_protocol_error(format!(
            "{MYSQL_COORDINATION_SCHEMA_MISSING_CODE}: whole-system close coordination changed after the close started; cancel and begin again"
        )));
    }

    let (close_rows, restore_rows): (i64, i64) = sqlx::query_as(
        "SELECT
           (SELECT COUNT(*) FROM pos_close_barrier WHERE id = 1),
           (SELECT COUNT(*) FROM pos_restore_gate WHERE id = 1)",
    )
    .fetch_one(pool)
    .await?;
    if close_rows != 1 || restore_rows != 1 {
        return Err(account_protocol_error(format!(
            "{MYSQL_COORDINATION_SCHEMA_MISSING_CODE}: whole-system close coordination rows changed after the close started; cancel and begin again"
        )));
    }
    Ok(())
}

async fn assert_mysql_whole_system_close_guards_ready(
    tx: &mut sqlx::Transaction<'_, MySql>,
) -> Result<(), sqlx::Error> {
    if mysql_guarded_preflight_v4_is_current_on(&mut **tx).await? {
        return Ok(());
    }
    Err(account_protocol_error(format!(
        "{MYSQL_COORDINATION_SCHEMA_CORRUPT_CODE}: required MariaDB V4 write guards changed after the whole-system close started; abort and begin again"
    )))
}

fn is_restore_pushable_setting_key(key: &str) -> bool {
    let normalized = key.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return false;
    }
    if normalized.starts_with("sync_ts_") || normalized.starts_with("sync_reconcile_") || normalized.starts_with("migration_") {
        return false;
    }
    !matches!(
        normalized.as_str(),
        "pos_mode"
            | "mysql_config"
            | "device_operating_mode"
            | "held_order_recovery_v1"
            | "till_id"
            | "till_name"
            | "till_name_manual"
            | "till_seq"
            | "receipt_number_high_water"
            | "automatic_setup_backup_enabled"
            | "automatic_setup_backup_time"
            | "automatic_setup_backup_directory"
            | "backup_directory"
            | "last_sync_time"
            | "last_fast_sync_time"
            | "bootstrap_uploaded"
            | "transaction_purge_applied_at"
            | "sync_change_cursor"
            | "restore_pending_mariadb_replace"
            | "training_mode_enabled"
            | "owner_cloud_reporter_password"
            | "cctv_pos_enabled"
            | "cctv_pos_host"
            | "cctv_pos_port"
            | "cctv_pos_number"
            | "cctv_pos_name"
            | "cctv_pos_source_ip"
            | "cctv_pos_encoding"
            | "cctv_pos_line_width"
            | "cctv_pos_send_items"
            | "cctv_pos_send_receipts"
            | "cctv_pos_framing"
            | "cctv_pos_start_marker"
            | "cctv_pos_line_separator"
            | "cctv_pos_end_marker"
            | "cash_drawer_enabled"
            | "cash_drawer_printer_host"
            | "cash_drawer_printer_port"
            | "cash_drawer_printer_name"
            | "cash_drawer_printer_device_path"
            | "cash_drawer_module_id"
            | "cash_drawer_module_device_id"
            | "cash_drawer_baud_rate"
            | "cash_drawer_pin"
            | "cash_drawer_pulse_on_ms"
            | "cash_drawer_pulse_off_ms"
            | "receipt_printer_enabled"
            | "receipt_printer_connection"
            | "receipt_printer_host"
            | "receipt_printer_port"
            | "receipt_printer_name"
            | "receipt_printer_device_path"
            | "receipt_printer_module_id"
            | "receipt_printer_module_device_id"
            | "receipt_printer_baud_rate"
            | "receipt_printer_paper_width"
            | "receipt_printer_model"
            | "receipt_printer_auto_print_after_payment"
            | "receipt_printer_cut_paper"
            | "receipt_printer_cut_feed_lines"
            | "receipt_printer_open_drawer_after_cash"
            | "receipt_printer_open_drawer_after_payment"
            | "receipt_printer_encoding"
            | "label_printer_enabled"
            | "label_printer_connection"
            | "label_printer_protocol"
            | "label_printer_host"
            | "label_printer_port"
            | "label_printer_name"
            | "label_printer_device_path"
            | "label_printer_module_id"
            | "label_printer_module_device_id"
            | "label_printer_baud_rate"
            | "label_printer_cut_paper"
            | "label_printer_gap_lines"
            | "label_printer_dpi"
            | "scale_hardware_enabled"
            | "scale_hardware_device_path"
            | "scale_hardware_baud_rate"
            | "scale_hardware_poll_ms"
            | "scale_hardware_request_mode"
            | "feedback_button_sound_enabled"
            | "feedback_item_sound_enabled"
            | "feedback_scan_sound_enabled"
            | "feedback_haptics_enabled"
            | "feedback_sale_sound_enabled"
            | "barcode_error_sound"
            | "till_seq_counter"
            | "bootstrap_done"
            | "restore_maintenance_owner"
            | "staff_attendance_import_owner"
            | "server_data_epoch"
            | "server_data_epoch_seen"
            | "report_epoch_cache"
    )
}

fn sqlite_restore_value(
    row: &SqliteRow,
    index: usize,
    declared_type: &str,
) -> Result<RestoreValue, sqlx::Error> {
    if row.try_get_raw(index)?.is_null() {
        return Ok(RestoreValue::Null);
    }
    let affinity = declared_type.to_ascii_uppercase();
    if affinity.contains("INT") {
        Ok(RestoreValue::Integer(row.try_get(index)?))
    } else if affinity.contains("REAL") || affinity.contains("FLOA") || affinity.contains("DOUB") {
        Ok(RestoreValue::Real(row.try_get(index)?))
    } else if affinity.contains("BLOB") {
        Ok(RestoreValue::Blob(row.try_get(index)?))
    } else {
        Ok(RestoreValue::Text(row.try_get(index)?))
    }
}

fn push_restore_value<'args>(
    separated: &mut sqlx::query_builder::Separated<'_, 'args, MySql, &'static str>,
    value: &'args RestoreValue,
) {
    match value {
        RestoreValue::Null => {
            separated.push_bind(Option::<String>::None);
        }
        RestoreValue::Integer(value) => {
            separated.push_bind(*value);
        }
        RestoreValue::Real(value) => {
            separated.push_bind(*value);
        }
        RestoreValue::Text(value) => {
            separated.push_bind(value);
        }
        RestoreValue::Blob(value) => {
            separated.push_bind(value);
        }
    }
}

async fn copy_restore_table_to_mysql(
    local: &SqlitePool,
    tx: &mut sqlx::Transaction<'_, MySql>,
    table: &str,
) -> Result<i64, sqlx::Error> {
    let local_exists = sqlite_restore_table_exists(local, table).await?;
    let remote_exists: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
    )
    .bind(table)
    .fetch_one(&mut **tx)
    .await?;
    if !local_exists || remote_exists == 0 {
        return Err(account_protocol_error(format!(
            "MariaDB replacement cannot copy missing table {table}"
        )));
    }

    let remote_column_rows = sqlx::query(
        "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
           AND EXTRA NOT LIKE '%GENERATED%'
         ORDER BY ORDINAL_POSITION",
    )
    .bind(table)
    .fetch_all(&mut **tx)
    .await?;
    let remote_columns: HashSet<String> = remote_column_rows
        .iter()
        .map(|row| row.try_get::<String, _>("COLUMN_NAME"))
        .collect::<Result<_, _>>()?;

    let pragma_sql = format!("PRAGMA table_info({})", mysql_identifier(table));
    let local_column_rows = sqlx::query(&pragma_sql).fetch_all(local).await?;
    let mut columns: Vec<(String, String)> = Vec::new();
    for row in local_column_rows {
        let name: String = row.try_get("name")?;
        if remote_columns.contains(&name) {
            columns.push((name, row.try_get::<String, _>("type").unwrap_or_default()));
        }
    }
    if columns.is_empty() {
        return Err(account_protocol_error(format!(
            "MariaDB replacement found no compatible columns for {table}"
        )));
    }

    let quoted_columns = columns
        .iter()
        .map(|(name, _)| mysql_identifier(name))
        .collect::<Vec<_>>();
    let select_sql = format!(
        "SELECT {} FROM {}",
        quoted_columns.join(", "),
        mysql_identifier(table)
    );
    let source_rows = sqlx::query(&select_sql).fetch_all(local).await?;
    let mut values: Vec<Vec<RestoreValue>> = Vec::with_capacity(source_rows.len());
    for row in source_rows {
        if table == "settings" {
            let key: String = row.try_get("key")?;
            if !is_restore_pushable_setting_key(&key) {
                continue;
            }
        }
        let mut row_values = Vec::with_capacity(columns.len());
        for (index, (_, declared_type)) in columns.iter().enumerate() {
            row_values.push(sqlite_restore_value(&row, index, declared_type)?);
        }
        values.push(row_values);
    }

    let chunk_size = if table == "product_images" { 10 } else { 100 };
    for chunk in values.chunks(chunk_size) {
        let mut builder = QueryBuilder::<MySql>::new(format!(
            "INSERT INTO {} ({}) ",
            mysql_identifier(table),
            quoted_columns.join(", ")
        ));
        builder.push_values(chunk, |mut separated, row_values| {
            for value in row_values {
                push_restore_value(&mut separated, value);
            }
        });
        builder.push(" ON DUPLICATE KEY UPDATE ");
        {
            let mut updates = builder.separated(", ");
            for column in &quoted_columns {
                updates.push(format!("{column} = VALUES({column})"));
            }
        }
        builder.build().execute(&mut **tx).await?;
    }
    Ok(values.len() as i64)
}

/// Copy one table from a caller-owned SQLite read transaction. This variant is
/// used when attendance and its original audit rows must come from exactly the
/// same local snapshot.
async fn copy_restore_table_to_mysql_from_connection(
    local: &mut SqliteConnection,
    tx: &mut sqlx::Transaction<'_, MySql>,
    table: &str,
) -> Result<i64, sqlx::Error> {
    let local_exists: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?")
            .bind(table)
            .fetch_one(&mut *local)
            .await?;
    let remote_exists: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
    )
    .bind(table)
    .fetch_one(&mut **tx)
    .await?;
    if local_exists == 0 || remote_exists == 0 {
        return Err(account_protocol_error(format!(
            "MariaDB import cannot copy missing table {table}"
        )));
    }

    let remote_column_rows = sqlx::query(
        "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
           AND EXTRA NOT LIKE '%GENERATED%'
         ORDER BY ORDINAL_POSITION",
    )
    .bind(table)
    .fetch_all(&mut **tx)
    .await?;
    let remote_columns: HashSet<String> = remote_column_rows
        .iter()
        .map(|row| row.try_get::<String, _>("COLUMN_NAME"))
        .collect::<Result<_, _>>()?;

    let pragma_sql = format!("PRAGMA table_info({})", mysql_identifier(table));
    let local_column_rows = sqlx::query(&pragma_sql).fetch_all(&mut *local).await?;
    let mut columns: Vec<(String, String)> = Vec::new();
    for row in local_column_rows {
        let name: String = row.try_get("name")?;
        if remote_columns.contains(&name) {
            columns.push((name, row.try_get::<String, _>("type").unwrap_or_default()));
        }
    }
    if columns.is_empty() {
        return Err(account_protocol_error(format!(
            "MariaDB import found no compatible columns for {table}"
        )));
    }

    if table == "settings" {
        let alias_collisions: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM (
               SELECT LOWER(TRIM(`key`)) AS normalized_key
                 FROM settings
                GROUP BY LOWER(TRIM(`key`))
               HAVING COUNT(*) > 1
             ) setting_aliases",
        )
        .fetch_one(&mut *local)
        .await?;
        if alias_collisions != 0 {
            return Err(account_protocol_error(
                "MariaDB import rejected settings keys that differ only by case or surrounding whitespace",
            ));
        }
    }

    let quoted_columns = columns
        .iter()
        .map(|(name, _)| mysql_identifier(name))
        .collect::<Vec<_>>();
    let select_sql = format!(
        "SELECT {} FROM {}",
        quoted_columns.join(", "),
        mysql_identifier(table)
    );
    let source_rows = sqlx::query(&select_sql).fetch_all(&mut *local).await?;
    let mut values: Vec<Vec<RestoreValue>> = Vec::with_capacity(source_rows.len());
    for row in source_rows {
        if table == "settings" {
            let key: String = row.try_get("key")?;
            if !is_restore_pushable_setting_key(&key) {
                continue;
            }
        }
        let mut row_values = Vec::with_capacity(columns.len());
        for (index, (_, declared_type)) in columns.iter().enumerate() {
            row_values.push(sqlite_restore_value(&row, index, declared_type)?);
        }
        values.push(row_values);
    }

    let chunk_size = if table == "product_images" { 10 } else { 100 };
    for chunk in values.chunks(chunk_size) {
        let mut builder = QueryBuilder::<MySql>::new(format!(
            "INSERT INTO {} ({}) ",
            mysql_identifier(table),
            quoted_columns.join(", ")
        ));
        builder.push_values(chunk, |mut separated, row_values| {
            for value in row_values {
                push_restore_value(&mut separated, value);
            }
        });
        builder.push(" ON DUPLICATE KEY UPDATE ");
        {
            let mut updates = builder.separated(", ");
            for column in &quoted_columns {
                updates.push(format!("{column} = VALUES({column})"));
            }
        }
        builder.build().execute(&mut **tx).await?;
    }
    Ok(values.len() as i64)
}

async fn assert_attendance_audit_import_schema_ready(mysql: &MySqlPool) -> Result<(), sqlx::Error> {
    let table_ready: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = ?
           AND COLUMN_NAME IN ('connectionId', 'token')",
    )
    .bind(MARIADB_ATTENDANCE_AUDIT_IMPORT_TABLE)
    .fetch_one(mysql)
    .await?;
    if table_ready != 2 {
        return Err(account_protocol_error(
            "MARIADB_ATTENDANCE_AUDIT_IMPORT_SCHEMA_REQUIRED: reconnect this till to finish the MariaDB attendance migration",
        ));
    }

    let trigger_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TRIGGERS
         WHERE TRIGGER_SCHEMA = DATABASE()
           AND TRIGGER_NAME IN (
             'pos_audit_employee_attendance_insert',
             'pos_audit_employee_attendance_update'
           )
           AND LOCATE('pos_attendance_audit_import_sessions', ACTION_STATEMENT) > 0
           AND LOCATE('@lbj_pos_attendance_audit_import', ACTION_STATEMENT) > 0
           AND LOCATE('CONNECTION_ID()', ACTION_STATEMENT) > 0",
    )
    .fetch_one(mysql)
    .await?;
    if trigger_count != 2 {
        return Err(account_protocol_error(
            "MARIADB_ATTENDANCE_AUDIT_IMPORT_SCHEMA_REQUIRED: attendance audit triggers are not current",
        ));
    }
    Ok(())
}

async fn begin_attendance_audit_import(
    tx: &mut sqlx::Transaction<'_, MySql>,
    token: &str,
) -> Result<i64, sqlx::Error> {
    let connection_id: i64 = sqlx::query_scalar(MYSQL_SIGNED_CONNECTION_ID_SELECT)
        .fetch_one(&mut **tx)
        .await?;
    sqlx::query(
        "DELETE FROM pos_attendance_audit_import_sessions
         WHERE connectionId = CONNECTION_ID()",
    )
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        "INSERT INTO pos_attendance_audit_import_sessions (connectionId, token)
         VALUES (CONNECTION_ID(), ?)",
    )
    .bind(token)
    .execute(&mut **tx)
    .await?;
    sqlx::query("SET @lbj_pos_attendance_audit_import = ?")
        .bind(token)
        .execute(&mut **tx)
        .await?;
    Ok(connection_id)
}

async fn finish_attendance_audit_import(
    tx: &mut sqlx::Transaction<'_, MySql>,
    connection_id: i64,
    token: &str,
) -> Result<(), sqlx::Error> {
    let removed = sqlx::query(
        "DELETE FROM pos_attendance_audit_import_sessions
         WHERE connectionId = ? AND BINARY token = BINARY ?",
    )
    .bind(connection_id)
    .bind(token)
    .execute(&mut **tx)
    .await?;
    if removed.rows_affected() != 1 {
        return Err(account_protocol_error(
            "MARIADB_ATTENDANCE_AUDIT_IMPORT_STATE_CHANGED: attendance import marker was lost",
        ));
    }
    sqlx::query("SET @lbj_pos_attendance_audit_import = NULL")
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn assert_employee_profile_authority_schema_ready(
    mysql: &MySqlPool,
) -> Result<(), sqlx::Error> {
    let columns: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = ?
           AND COLUMN_NAME IN ('connectionId', 'token', 'expiresAt')",
    )
    .bind(MARIADB_EMPLOYEE_PROFILE_AUTHORITY_TABLE)
    .fetch_one(mysql)
    .await?;
    if columns != 3 {
        return Err(account_protocol_error(
            "EMPLOYEE_PROFILE_AUTHORITY_REQUIRED: reconnect this till to finish the MariaDB staff-security migration",
        ));
    }
    let triggers: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TRIGGERS
         WHERE TRIGGER_SCHEMA = DATABASE()
           AND TRIGGER_NAME IN (
             'pos_guard_attendance_employee_insert',
             'pos_guard_attendance_employee_update'
           )
           AND LOCATE('pos_employee_profile_write_authority', ACTION_STATEMENT) > 0
           AND LOCATE('@lbj_pos_employee_profile_authority', ACTION_STATEMENT) > 0
           AND LOCATE('CONNECTION_ID()', ACTION_STATEMENT) > 0",
    )
    .fetch_one(mysql)
    .await?;
    if triggers != 2 {
        return Err(account_protocol_error(
            "EMPLOYEE_PROFILE_AUTHORITY_REQUIRED: MariaDB staff-security triggers are not current",
        ));
    }
    Ok(())
}

async fn begin_employee_profile_authority(
    tx: &mut sqlx::Transaction<'_, MySql>,
    token: &str,
) -> Result<i64, sqlx::Error> {
    let connection_id: i64 = sqlx::query_scalar(MYSQL_SIGNED_CONNECTION_ID_SELECT)
        .fetch_one(&mut **tx)
        .await?;
    sqlx::query(
        "DELETE FROM pos_employee_profile_write_authority
         WHERE connectionId = CONNECTION_ID()",
    )
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        "INSERT INTO pos_employee_profile_write_authority
            (connectionId, token, expiresAt)
         VALUES (CONNECTION_ID(), ?, TIMESTAMPADD(SECOND, ?, UTC_TIMESTAMP(3)))",
    )
    .bind(token)
    .bind(MARIADB_EMPLOYEE_PROFILE_AUTHORITY_SECONDS)
    .execute(&mut **tx)
    .await?;
    sqlx::query("SET @lbj_pos_employee_profile_authority = ?")
        .bind(token)
        .execute(&mut **tx)
        .await?;
    Ok(connection_id)
}

async fn finish_employee_profile_authority(
    tx: &mut sqlx::Transaction<'_, MySql>,
    connection_id: i64,
    token: &str,
) -> Result<(), sqlx::Error> {
    let removed = sqlx::query(
        "DELETE FROM pos_employee_profile_write_authority
         WHERE connectionId = ? AND BINARY token = BINARY ?",
    )
    .bind(connection_id)
    .bind(token)
    .execute(&mut **tx)
    .await?;
    if removed.rows_affected() != 1 {
        return Err(account_protocol_error(
            "EMPLOYEE_PROFILE_AUTHORITY_CHANGED: staff write authority was lost",
        ));
    }
    sqlx::query("SET @lbj_pos_employee_profile_authority = NULL")
        .execute(&mut **tx)
        .await?;
    Ok(())
}

fn employee_profile_from_mysql_row(row: &MySqlRow) -> Result<EmployeeProfileRecord, sqlx::Error> {
    Ok(EmployeeProfileRecord {
        id: row.try_get("id")?,
        store_id: row.try_get("storeId")?,
        name: row.try_get("name")?,
        pin: row.try_get("pin")?,
        pin_hash: row.try_get("pinHash")?,
        role: row.try_get("role")?,
        email: row.try_get("email")?,
        is_active: row.try_get::<i64, _>("isActive")? != 0,
        created_at: row.try_get("createdAt")?,
        updated_at: row.try_get("updatedAt")?,
    })
}

async fn select_employee_profile_for_update(
    tx: &mut sqlx::Transaction<'_, MySql>,
    employee_id: &str,
) -> Result<Option<EmployeeProfileRecord>, sqlx::Error> {
    let sql = format!(
        "SELECT CAST(id AS CHAR CHARACTER SET utf8mb4) AS id,
                COALESCE(storeId, '') AS storeId, COALESCE(name, '') AS name,
                COALESCE(pin, '') AS pin, COALESCE(pinHash, '') AS pinHash,
                COALESCE(role, '') AS role, COALESCE(email, '') AS email,
                {MYSQL_SIGNED_EMPLOYEE_ACTIVE_PROJECTION},
                COALESCE(createdAt, '') AS createdAt,
                COALESCE(updatedAt, '') AS updatedAt
         FROM employees WHERE BINARY id = BINARY ? LIMIT 1 FOR UPDATE"
    );
    let row = sqlx::query(&sql)
        .bind(employee_id)
        .fetch_optional(&mut **tx)
        .await?;
    row.as_ref()
        .map(employee_profile_from_mysql_row)
        .transpose()
}

fn employee_profile_audit_json(employee: &EmployeeProfileRecord) -> String {
    serde_json::json!({
        "id": employee.id,
        "storeId": employee.store_id,
        "name": employee.name,
        "pin": "[redacted]",
        "pinHash": "[redacted]",
        "role": employee.role,
        "email": employee.email,
        "isActive": employee.is_active,
        "createdAt": employee.created_at,
    })
    .to_string()
}

fn decoded_base64_pin_component_len(value: &str) -> Option<usize> {
    if value.is_empty() || value.len() % 4 != 0 {
        return None;
    }
    let mut padding = false;
    let mut padding_count = 0usize;
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'+' | b'/' if !padding => {}
            b'=' => {
                padding = true;
                padding_count += 1;
                if padding_count > 2 {
                    return None;
                }
            }
            _ => return None,
        }
    }
    STANDARD_BASE64
        .decode(value)
        .ok()
        .map(|decoded| decoded.len())
}

fn is_valid_pbkdf2_pin_hash(value: &str) -> bool {
    let parts: Vec<_> = value.split('$').collect();
    if parts.len() != 4 || parts[0] != "pbkdf2-sha256" {
        return false;
    }
    let Ok(iterations) = parts[1].parse::<u64>() else {
        return false;
    };
    let salt_len = decoded_base64_pin_component_len(parts[2]);
    let digest_len = decoded_base64_pin_component_len(parts[3]);
    (100_000..=1_000_000).contains(&iterations)
        && salt_len.is_some_and(|len| (16..=64).contains(&len))
        && digest_len == Some(32)
}

fn is_valid_legacy_sha256_pin_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn is_valid_legacy_plaintext_pin(value: &str) -> bool {
    (4..=8).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn employee_has_valid_runtime_pin(employee: &EmployeeProfileRecord) -> bool {
    match (employee.pin.is_empty(), employee.pin_hash.is_empty()) {
        (true, false) => {
            is_valid_pbkdf2_pin_hash(&employee.pin_hash)
                || is_valid_legacy_sha256_pin_hash(&employee.pin_hash)
        }
        (false, true) => is_valid_legacy_plaintext_pin(&employee.pin),
        _ => false,
    }
}

fn employee_has_valid_persisted_pin(employee: &EmployeeProfileRecord) -> bool {
    const ATTENDANCE_ENVELOPE: &str = "attendance-only-v1$";
    if employee.role == "attendance" {
        return employee.pin.is_empty()
            && employee
                .pin_hash
                .strip_prefix(ATTENDANCE_ENVELOPE)
                .is_some_and(is_valid_pbkdf2_pin_hash);
    }
    employee_has_valid_runtime_pin(employee)
}

fn employee_profile_credentials_allowed(
    before: Option<&EmployeeProfileRecord>,
    after: &EmployeeProfileRecord,
) -> bool {
    let credentials_unchanged = before
        .is_some_and(|current| current.pin == after.pin && current.pin_hash == after.pin_hash);
    if credentials_unchanged {
        return employee_has_valid_persisted_pin(after);
    }
    if after.role == "attendance" {
        return after.pin.is_empty()
            && after
                .pin_hash
                .strip_prefix("attendance-only-v1$")
                .is_some_and(is_valid_pbkdf2_pin_hash);
    }
    after.pin.is_empty() && is_valid_pbkdf2_pin_hash(&after.pin_hash)
}

fn employee_is_usable_admin(employee: &EmployeeProfileRecord) -> bool {
    employee.is_active && employee.role == "admin" && employee_has_valid_runtime_pin(employee)
}

async fn lock_all_employee_profiles(
    tx: &mut sqlx::Transaction<'_, MySql>,
) -> Result<Vec<EmployeeProfileRecord>, sqlx::Error> {
    let sql = format!(
        "SELECT CAST(id AS CHAR CHARACTER SET utf8mb4) AS id,
                COALESCE(storeId, '') AS storeId, COALESCE(name, '') AS name,
                COALESCE(pin, '') AS pin, COALESCE(pinHash, '') AS pinHash,
                COALESCE(role, '') AS role, COALESCE(email, '') AS email,
                {MYSQL_SIGNED_EMPLOYEE_ACTIVE_PROJECTION},
                COALESCE(createdAt, '') AS createdAt,
                COALESCE(updatedAt, '') AS updatedAt
         FROM employees ORDER BY BINARY id FOR UPDATE"
    );
    sqlx::query(&sql)
        .fetch_all(&mut **tx)
        .await?
        .iter()
        .map(employee_profile_from_mysql_row)
        .collect()
}

fn configured_role_can_open_employees(role: &str, raw: Option<&str>) -> bool {
    if role == "admin" {
        return true;
    }
    if !matches!(role, "manager" | "supervisor" | "cashier") {
        return false;
    }
    let Some(raw) = raw.filter(|value| !value.trim().is_empty()) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return false;
    };
    let roles = value.get("roles").unwrap_or(&value);
    roles
        .get(role)
        .and_then(serde_json::Value::as_array)
        .is_some_and(|permissions| {
            permissions
                .iter()
                .any(|permission| permission.as_str() == Some("open_employees"))
        })
}

async fn authorize_employee_profile_actor(
    tx: &mut sqlx::Transaction<'_, MySql>,
    actor_employee_id: &str,
    actor_expected_updated_at: &str,
) -> Result<EmployeeProfileRecord, sqlx::Error> {
    if actor_employee_id.is_empty() || actor_expected_updated_at.is_empty() {
        return Err(account_protocol_error(
            "EMPLOYEE_PROFILE_ACTOR_REQUIRED: sign in again before changing staff access",
        ));
    }
    let actor = select_employee_profile_for_update(tx, actor_employee_id)
        .await?
        .ok_or_else(|| {
            account_protocol_error(
                "EMPLOYEE_PROFILE_ACTOR_REQUIRED: the authorizing staff account no longer exists",
            )
        })?;
    if !actor.is_active
        || !matches!(
            actor.role.as_str(),
            "admin" | "manager" | "supervisor" | "cashier"
        )
        || actor.updated_at != actor_expected_updated_at
    {
        return Err(account_protocol_error(
            "EMPLOYEE_PROFILE_ACTOR_STALE: authorizing staff access changed; sign in again",
        ));
    }
    let permission_json: Option<String> = sqlx::query_scalar(
        "SELECT CAST(value AS CHAR CHARACTER SET utf8mb4)
         FROM settings WHERE `key` = 'role_permissions' LIMIT 1 FOR UPDATE",
    )
    .fetch_optional(&mut **tx)
    .await?;
    if !configured_role_can_open_employees(&actor.role, permission_json.as_deref()) {
        return Err(account_protocol_error(
            "EMPLOYEE_PROFILE_ACTOR_FORBIDDEN: this staff member cannot manage employees",
        ));
    }
    Ok(actor)
}

fn assert_first_admin_bootstrap_allowed(
    employee: &EmployeeProfileRecord,
    locked_existing_employees: &[EmployeeProfileRecord],
) -> Result<(), sqlx::Error> {
    if employee.role != "admin"
        || !employee.is_active
        || !employee.pin.is_empty()
        || !is_valid_pbkdf2_pin_hash(&employee.pin_hash)
    {
        return Err(account_protocol_error(
            "EMPLOYEE_PROFILE_ACTOR_REQUIRED: the first staff account must be an active administrator with a secure PIN",
        ));
    }
    if !locked_existing_employees.is_empty() {
        return Err(account_protocol_error(
            "EMPLOYEE_PROFILE_ACTOR_REQUIRED: first-administrator bootstrap is allowed only before any staff records exist",
        ));
    }
    Ok(())
}

fn assert_employee_profile_actor_scope(
    actor: &EmployeeProfileRecord,
    before: Option<&EmployeeProfileRecord>,
    after: &EmployeeProfileRecord,
) -> Result<(), sqlx::Error> {
    if actor.role == "admin" {
        return Ok(());
    }
    if after.role == "admin" || before.is_some_and(|employee| employee.role == "admin") {
        return Err(account_protocol_error(
            "EMPLOYEE_PROFILE_ACTOR_FORBIDDEN: only an administrator can create or change an administrator",
        ));
    }
    if actor.id == after.id {
        let Some(before) = before else {
            return Err(account_protocol_error(
                "EMPLOYEE_PROFILE_ACTOR_FORBIDDEN: staff cannot create their own account",
            ));
        };
        if before.role != after.role
            || before.is_active != after.is_active
            || before.pin != after.pin
            || before.pin_hash != after.pin_hash
        {
            return Err(account_protocol_error(
                "EMPLOYEE_PROFILE_ACTOR_FORBIDDEN: non-administrators cannot change their own access or PIN",
            ));
        }
    }
    Ok(())
}

async fn assert_no_other_active_tills_in_restore(
    tx: &mut sqlx::Transaction<'_, MySql>,
    till_id: &str,
) -> Result<(), sqlx::Error> {
    let presence_exists: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'till_presence'",
    )
    .fetch_one(&mut **tx)
    .await?;
    if presence_exists == 0 {
        return Err(account_protocol_error(
            "MariaDB replacement cannot verify connected tills because till_presence is missing",
        ));
    }
    let rows = sqlx::query(
        "SELECT CAST(tillId AS CHAR CHARACTER SET utf8mb4) AS tillId,
                CAST(tillName AS CHAR CHARACTER SET utf8mb4) AS tillName
         FROM till_presence
         WHERE lastSeenAt >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 45 SECOND)
           AND tillId <> ?
         ORDER BY tillName, tillId",
    )
    .bind(till_id)
    .fetch_all(&mut **tx)
    .await?;
    if rows.is_empty() {
        return Ok(());
    }
    let names = rows
        .iter()
        .map(|row| {
            row.try_get::<String, _>("tillName")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .or_else(|| row.try_get::<String, _>("tillId").ok())
                .unwrap_or_else(|| "another till".into())
        })
        .collect::<Vec<_>>()
        .join(", ");
    Err(account_protocol_error(format!(
        "MariaDB restore requires maintenance mode. Close these tills and wait {MARIADB_RESTORE_ONLINE_WINDOW_SECONDS} seconds: {names}"
    )))
}

enum ControlledImportGateClaim {
    Claimed,
    RecoveredCommitted(String),
}

async fn claim_controlled_import_gate(
    mysql: &MySqlPool,
    till_id: &str,
) -> Result<ControlledImportGateClaim, sqlx::Error> {
    sqlx::query("SET @lbj_pos_restore_bypass = ?")
        .bind(till_id)
        .execute(mysql)
        .await?;
    let stamp: String = sqlx::query_scalar(
        "SELECT CONCAT(LEFT(DATE_FORMAT(UTC_TIMESTAMP(3),
                '%Y-%m-%dT%H:%i:%s.%fZ'), 23), 'Z')",
    )
    .fetch_one(mysql)
    .await?;
    let mut tx = mysql.begin().await?;
    cleanup_expired_whole_system_close(&mut tx).await?;
    let close_barrier = locked_whole_system_close_barrier(&mut tx).await?;
    if close_barrier.state != "idle" {
        return Err(account_protocol_error(format!(
            "{WHOLE_SYSTEM_CLOSE_IN_PROGRESS_CODE}: abort the whole-system close before importing local data"
        )));
    }
    let gate: Option<(String, i64)> = sqlx::query_as(MYSQL_RESTORE_GATE_LOCK_SELECT)
        .fetch_optional(&mut *tx)
        .await?;
    let (gate_owner, gate_active) = gate.ok_or_else(|| {
        account_protocol_error(format!(
            "{MYSQL_COORDINATION_SCHEMA_MISSING_CODE}: pos_restore_gate row 1 is required before importing local data"
        ))
    })?;
    match restore_gate_write_decision(gate_active, &gate_owner, Some(till_id)) {
        RestoreGateWriteDecision::Allowed => {}
        RestoreGateWriteDecision::MaintenanceBlocked => {
            return Err(account_protocol_error(format!(
                "{MARIADB_RESTORE_MAINTENANCE_CODE}: MariaDB import is owned by another till"
            )));
        }
        RestoreGateWriteDecision::Corrupt => {
            return Err(account_protocol_error(format!(
                "{MYSQL_COORDINATION_SCHEMA_CORRUPT_CODE}: pos_restore_gate row 1 has an invalid state"
            )));
        }
    }

    let bootstrap_epoch: Option<String> = sqlx::query_scalar(
        "SELECT CAST(value AS CHAR CHARACTER SET utf8mb4)
         FROM settings WHERE `key` = 'server_data_epoch' LIMIT 1 FOR UPDATE",
    )
    .fetch_optional(&mut *tx)
    .await?;
    let bootstrap_done: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM settings WHERE `key` = 'bootstrap_done' FOR UPDATE",
    )
    .fetch_one(&mut *tx)
    .await?;
    let controlled_owner: Option<String> = sqlx::query_scalar(
        "SELECT CAST(value AS CHAR CHARACTER SET utf8mb4)
         FROM settings WHERE `key` = ? LIMIT 1 FOR UPDATE",
    )
    .bind(MARIADB_CONTROLLED_IMPORT_OWNER_KEY)
    .fetch_optional(&mut *tx)
    .await?;
    if gate_active == 1 && gate_owner == till_id && controlled_owner.as_deref() != Some(till_id) {
        return Err(account_protocol_error(format!(
            "{MARIADB_RESTORE_MAINTENANCE_CODE}: this maintenance gate belongs to another operation"
        )));
    }
    if gate_active == 1 && gate_owner == till_id && bootstrap_done == 1 {
        sqlx::query(
            "UPDATE pos_restore_gate SET isActive = 0, claimedAt = ?
             WHERE id = 1 AND isActive = 1 AND BINARY ownerTillId = BINARY ?",
        )
        .bind(&stamp)
        .bind(till_id)
        .execute(&mut *tx)
        .await?;
        sqlx::query("DELETE FROM settings WHERE `key` = ? AND BINARY value = BINARY ?")
            .bind(MARIADB_RESTORE_MAINTENANCE_KEY)
            .bind(till_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM settings WHERE `key` = ? AND BINARY value = BINARY ?")
            .bind(MARIADB_CONTROLLED_IMPORT_OWNER_KEY)
            .bind(till_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        return Ok(ControlledImportGateClaim::RecoveredCommitted(
            bootstrap_epoch.unwrap_or(stamp),
        ));
    }
    if bootstrap_done != 0 {
        return Err(account_protocol_error(
            "CONTROLLED_IMPORT_DESTINATION_NOT_EMPTY: MariaDB bootstrap is already complete",
        ));
    }
    if controlled_owner
        .as_deref()
        .is_some_and(|owner| owner != till_id)
    {
        return Err(account_protocol_error(
            "CONTROLLED_IMPORT_DESTINATION_NOT_EMPTY: another till owns the unfinished import",
        ));
    }

    let mut populated = Vec::new();
    for table in MARIADB_CONTROLLED_IMPORT_EMPTY_TABLES {
        let row = sqlx::query(&format!(
            "SELECT 1 FROM {} LIMIT 1 FOR UPDATE",
            mysql_identifier(table)
        ))
        .fetch_optional(&mut *tx)
        .await?;
        if row.is_some() {
            populated.push(*table);
        }
    }
    let remote_role_permissions: Option<String> = sqlx::query_scalar(
        "SELECT `key` FROM settings
         WHERE LOWER(TRIM(`key`)) = 'role_permissions' LIMIT 1 FOR UPDATE",
    )
    .fetch_optional(&mut *tx)
    .await?;
    if remote_role_permissions.is_some() {
        populated.push("settings.role_permissions");
    }
    if !populated.is_empty() {
        return Err(account_protocol_error(format!(
            "CONTROLLED_IMPORT_DESTINATION_NOT_EMPTY: MariaDB already contains {}",
            populated.join(", ")
        )));
    }
    sqlx::query(
        "UPDATE pos_restore_gate
         SET ownerTillId = ?, isActive = 1, claimedAt = ?
         WHERE id = 1 AND (
           isActive = 0 OR (isActive = 1 AND BINARY ownerTillId = BINARY ?)
         )",
    )
    .bind(till_id)
    .bind(&stamp)
    .bind(till_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO settings (`key`, value, updatedAt)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE
           value = IF(BINARY value = BINARY VALUES(value), VALUES(value), value),
           updatedAt = IF(BINARY value = BINARY VALUES(value), VALUES(updatedAt), updatedAt)",
    )
    .bind(MARIADB_RESTORE_MAINTENANCE_KEY)
    .bind(till_id)
    .bind(&stamp)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO settings (`key`, value, updatedAt)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE
           value = IF(BINARY value = BINARY VALUES(value), VALUES(value), value),
           updatedAt = IF(BINARY value = BINARY VALUES(value), VALUES(updatedAt), updatedAt)",
    )
    .bind(MARIADB_CONTROLLED_IMPORT_OWNER_KEY)
    .bind(till_id)
    .bind(&stamp)
    .execute(&mut *tx)
    .await?;
    let claimed_owner: Option<String> = sqlx::query_scalar(MYSQL_RESTORE_GATE_ACTIVE_OWNER_SELECT)
        .fetch_optional(&mut *tx)
        .await?;
    let marker_owner: Option<String> = sqlx::query_scalar(
        "SELECT CAST(value AS CHAR CHARACTER SET utf8mb4)
         FROM settings WHERE `key` = ? LIMIT 1",
    )
    .bind(MARIADB_RESTORE_MAINTENANCE_KEY)
    .fetch_optional(&mut *tx)
    .await?;
    let controlled_owner: Option<String> = sqlx::query_scalar(
        "SELECT CAST(value AS CHAR CHARACTER SET utf8mb4)
         FROM settings WHERE `key` = ? LIMIT 1",
    )
    .bind(MARIADB_CONTROLLED_IMPORT_OWNER_KEY)
    .fetch_optional(&mut *tx)
    .await?;
    if claimed_owner.as_deref() != Some(till_id)
        || marker_owner.as_deref() != Some(till_id)
        || controlled_owner.as_deref() != Some(till_id)
    {
        return Err(account_protocol_error(format!(
            "{MARIADB_RESTORE_MAINTENANCE_CODE}: MariaDB import ownership changed"
        )));
    }
    tx.commit().await?;
    Ok(ControlledImportGateClaim::Claimed)
}

async fn release_controlled_import_gate(
    mysql: &MySqlPool,
    till_id: &str,
    epoch: &str,
) -> Result<(), sqlx::Error> {
    let mut tx = mysql.begin().await?;
    let released = sqlx::query(
        "UPDATE pos_restore_gate SET isActive = 0, claimedAt = ?
         WHERE id = 1 AND isActive = 1 AND BINARY ownerTillId = BINARY ?",
    )
    .bind(epoch)
    .bind(till_id)
    .execute(&mut *tx)
    .await?;
    if released.rows_affected() != 1 {
        return Err(account_protocol_error(format!(
            "{MARIADB_RESTORE_MAINTENANCE_CODE}: the controlled-import gate could not be released; retry from the same till"
        )));
    }
    sqlx::query("DELETE FROM settings WHERE `key` = ? AND BINARY value = BINARY ?")
        .bind(MARIADB_RESTORE_MAINTENANCE_KEY)
        .bind(till_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM settings WHERE `key` = ? AND BINARY value = BINARY ?")
        .bind(MARIADB_CONTROLLED_IMPORT_OWNER_KEY)
        .bind(till_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await
}

async fn assert_no_active_terminal_attempts_in_restore(
    tx: &mut sqlx::Transaction<'_, MySql>,
) -> Result<(), sqlx::Error> {
    let exists: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payment_terminal_attempts'",
    )
    .fetch_one(&mut **tx)
    .await?;
    if exists == 0 {
        return Ok(());
    }
    let active: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM payment_terminal_attempts
         WHERE status IN ('prepared', 'started', 'uncertain', 'approved',
                          'commit_failed', 'completion_pending')",
    )
    .fetch_one(&mut **tx)
    .await?;
    if active > 0 {
        return Err(account_protocol_error(format!(
            "MariaDB restore cannot continue while {active} terminal payment attempt(s) still need completion or recovery"
        )));
    }
    Ok(())
}

async fn assert_no_active_local_terminal_attempts_in_restore(
    local: &SqlitePool,
) -> Result<(), sqlx::Error> {
    if !sqlite_restore_table_exists(local, "payment_terminal_attempts").await? {
        return Ok(());
    }
    let active: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM payment_terminal_attempts
         WHERE status IN ('prepared', 'started', 'uncertain', 'approved',
                          'commit_failed', 'completion_pending')",
    )
    .fetch_one(local)
    .await?;
    if active > 0 {
        return Err(account_protocol_error(format!(
            "MariaDB restore cannot continue while this till has {active} terminal payment attempt(s) still needing completion or recovery"
        )));
    }
    Ok(())
}

async fn assert_no_active_local_terminal_attempts_from_connection(
    local: &mut SqliteConnection,
) -> Result<(), sqlx::Error> {
    let exists: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master
         WHERE type = 'table' AND name = 'payment_terminal_attempts'",
    )
    .fetch_one(&mut *local)
    .await?;
    if exists == 0 {
        return Ok(());
    }
    let active: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM payment_terminal_attempts
         WHERE status IN ('prepared', 'started', 'uncertain', 'approved',
                          'commit_failed', 'completion_pending')",
    )
    .fetch_one(&mut *local)
    .await?;
    if active > 0 {
        return Err(account_protocol_error(format!(
            "MariaDB restore cannot continue while this till has {active} terminal payment attempt(s) still needing completion or recovery"
        )));
    }
    Ok(())
}

fn sqlite_account_from_row(row: &SqliteRow) -> Result<CustomerAccountRecord, sqlx::Error> {
    Ok(CustomerAccountRecord {
        id: row.try_get("id")?,
        customer_id: row.try_get("customerId")?,
        is_enabled: row.try_get::<i64, _>("isEnabled")? != 0,
        credit_limit_pence: row.try_get("creditLimitPence")?,
        balance_pence: row.try_get("balancePence")?,
        created_at: row.try_get("createdAt")?,
        updated_at: row.try_get("updatedAt")?,
    })
}

fn mysql_account_from_row(row: &MySqlRow) -> Result<CustomerAccountRecord, sqlx::Error> {
    Ok(CustomerAccountRecord {
        id: row.try_get("id")?,
        customer_id: row.try_get("customerId")?,
        is_enabled: row.try_get::<i64, _>("isEnabled")? != 0,
        credit_limit_pence: row.try_get("creditLimitPence")?,
        balance_pence: row.try_get("balancePence")?,
        created_at: row.try_get("createdAt")?,
        updated_at: row.try_get("updatedAt")?,
    })
}

fn sqlite_account_entry_from_row(
    row: &SqliteRow,
) -> Result<CustomerAccountEntryRecord, sqlx::Error> {
    Ok(CustomerAccountEntryRecord {
        id: row.try_get("id")?,
        account_id: row.try_get("accountId")?,
        customer_id: row.try_get("customerId")?,
        order_id: row.try_get("orderId")?,
        entry_type: row.try_get("entryType")?,
        amount_pence: row.try_get("amountPence")?,
        payment_method: row.try_get("paymentMethod")?,
        tips_amount: row.try_get("tipsAmount")?,
        service_charge_amount: row.try_get("serviceChargeAmount")?,
        cashback_amount: row.try_get("cashbackAmount")?,
        reference: row.try_get("reference")?,
        description: row.try_get("description")?,
        receipt_number: row.try_get("receiptNumber")?,
        receipt_key: row.try_get("receiptKey")?,
        employee_id: row.try_get("employeeId")?,
        till_number: row.try_get("tillNumber")?,
        shift_id: row.try_get("shiftId")?,
        idempotency_key: row.try_get("idempotencyKey")?,
        reverses_entry_id: row.try_get("reversesEntryId")?,
        balance_after_pence: row.try_get("balanceAfterPence")?,
        created_at: row.try_get("createdAt")?,
        updated_at: row.try_get("updatedAt")?,
    })
}

fn mysql_account_entry_from_row(row: &MySqlRow) -> Result<CustomerAccountEntryRecord, sqlx::Error> {
    Ok(CustomerAccountEntryRecord {
        id: row.try_get("id")?,
        account_id: row.try_get("accountId")?,
        customer_id: row.try_get("customerId")?,
        order_id: row.try_get("orderId")?,
        entry_type: row.try_get("entryType")?,
        amount_pence: row.try_get("amountPence")?,
        payment_method: row.try_get("paymentMethod")?,
        tips_amount: row.try_get("tipsAmount")?,
        service_charge_amount: row.try_get("serviceChargeAmount")?,
        cashback_amount: row.try_get("cashbackAmount")?,
        reference: row.try_get("reference")?,
        description: row.try_get("description")?,
        receipt_number: row.try_get("receiptNumber")?,
        receipt_key: row.try_get("receiptKey")?,
        employee_id: row.try_get("employeeId")?,
        till_number: row.try_get("tillNumber")?,
        shift_id: row.try_get("shiftId")?,
        idempotency_key: row.try_get("idempotencyKey")?,
        reverses_entry_id: row.try_get("reversesEntryId")?,
        balance_after_pence: row.try_get("balanceAfterPence")?,
        created_at: row.try_get("createdAt")?,
        updated_at: row.try_get("updatedAt")?,
    })
}

fn entry_matches_change(
    entry: &CustomerAccountEntryRecord,
    change: &CustomerAccountChange,
) -> bool {
    entry.account_id == change.customer_id
        && entry.customer_id == change.customer_id
        && entry.order_id == change.order_id
        && entry.entry_type == change.entry_type
        && entry.amount_pence == change.amount_pence
        && entry.payment_method == change.payment_method
        && entry.tips_amount == change.tips_amount
        && entry.service_charge_amount == change.service_charge_amount
        && entry.cashback_amount == change.cashback_amount
        && entry.reference == change.reference
        && entry.description == change.description
        && entry.receipt_number == change.receipt_number
        && entry.receipt_key == change.receipt_key
        && entry.employee_id == change.employee_id
        && entry.till_number == change.till_number
        && entry.shift_id == change.shift_id
        && entry.idempotency_key == change.idempotency_key
        && entry.reverses_entry_id == change.reverses_entry_id
}

fn validate_account_change_shape(change: &CustomerAccountChange) -> Result<(), sqlx::Error> {
    let extras = checked_terminal_extras(
        change.tips_amount,
        change.service_charge_amount,
        change.cashback_amount,
    )?;
    if extras > 0 {
        if change.entry_type != "payment"
            || change.payment_method != "card"
            || change.reference.trim().is_empty()
            || change.amount_pence >= 0
        {
            return Err(account_protocol_error(
                "Terminal additions require a referenced card account payment",
            ));
        }
        checked_card_collection(change.amount_pence.checked_neg().ok_or_else(|| {
            account_protocol_error("Invalid customer account payment amount")
        })?, extras)?;
    }
    if change.id.trim().is_empty()
        || change.customer_id.trim().is_empty()
        || change.idempotency_key.trim().is_empty()
        || change.employee_id.trim().is_empty()
        || change.amount_pence == 0
    {
        return Err(account_protocol_error("Invalid customer account entry"));
    }
    match change.entry_type.as_str() {
        "charge" | "opening_balance" if change.amount_pence <= 0 => {
            return Err(account_protocol_error(
                "Customer account charges must increase the amount owed",
            ));
        }
        "payment" | "refund" if change.amount_pence >= 0 => {
            return Err(account_protocol_error(
                "Customer account payments and refunds must reduce the amount owed",
            ));
        }
        "adjustment" if change.description.trim().is_empty() => {
            return Err(account_protocol_error(
                "Customer account adjustments require a reason",
            ));
        }
        "reversal" if change.reverses_entry_id.trim().is_empty() => {
            return Err(account_protocol_error(
                "Customer account reversals require the original entry",
            ));
        }
        "charge" | "payment" | "adjustment" | "refund" | "reversal" | "opening_balance" => {}
        _ => {
            return Err(account_protocol_error(
                "Invalid customer account entry type",
            ))
        }
    }
    if change.entry_type == "payment"
        && !matches!(change.payment_method.as_str(), "cash" | "card" | "other")
    {
        return Err(account_protocol_error(
            "Customer account payments require cash, card, or other",
        ));
    }
    if change.allow_credit_balance
        && (change.entry_type != "payment"
            || change.payment_method != "card"
            || change.reference.trim().is_empty())
    {
        return Err(account_protocol_error(
            "Only an approved card payment with a terminal reference may create customer credit",
        ));
    }
    if change.entry_type != "reversal" && !change.reverses_entry_id.trim().is_empty() {
        return Err(account_protocol_error(
            "Only a reversal can reference another account entry",
        ));
    }
    Ok(())
}

fn validate_account_balance_change(
    account: &CustomerAccountRecord,
    change: &CustomerAccountChange,
) -> Result<i64, sqlx::Error> {
    let balance = account
        .balance_pence
        .checked_add(change.amount_pence)
        .ok_or_else(|| account_protocol_error("Customer account balance is too large"))?;
    if change.entry_type == "payment" && balance < 0 && !change.allow_credit_balance {
        return Err(account_protocol_error(
            "Payment exceeds the amount this customer owes",
        ));
    }
    if change.amount_pence > 0 && change.entry_type != "reversal" {
        if !account.is_enabled {
            return Err(account_protocol_error(
                "This customer's Pay Later account is not enabled",
            ));
        }
        if account.credit_limit_pence > 0 && balance > account.credit_limit_pence {
            return Err(account_protocol_error(
                "This purchase exceeds the customer's credit limit",
            ));
        }
    }
    Ok(balance)
}

fn change_to_entry(change: &CustomerAccountChange, updated_at: &str) -> CustomerAccountEntryRecord {
    CustomerAccountEntryRecord {
        id: change.id.clone(),
        account_id: change.customer_id.clone(),
        customer_id: change.customer_id.clone(),
        order_id: change.order_id.clone(),
        entry_type: change.entry_type.clone(),
        amount_pence: change.amount_pence,
        payment_method: change.payment_method.clone(),
        tips_amount: change.tips_amount,
        service_charge_amount: change.service_charge_amount,
        cashback_amount: change.cashback_amount,
        reference: change.reference.clone(),
        description: change.description.clone(),
        receipt_number: change.receipt_number,
        receipt_key: change.receipt_key.clone(),
        employee_id: change.employee_id.clone(),
        till_number: change.till_number.clone(),
        shift_id: change.shift_id.clone(),
        idempotency_key: change.idempotency_key.clone(),
        reverses_entry_id: change.reverses_entry_id.clone(),
        balance_after_pence: change.balance_after_pence,
        created_at: change.created_at.clone(),
        updated_at: updated_at.to_string(),
    }
}

async fn fetch_sqlite_account(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    customer_id: &str,
) -> Result<CustomerAccountRecord, sqlx::Error> {
    let row = sqlx::query(
        "SELECT id, customerId, isEnabled, creditLimitPence, balancePence, createdAt, updatedAt
         FROM customer_accounts WHERE customerId = ? LIMIT 1",
    )
    .bind(customer_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| account_protocol_error("Customer Pay Later account was not found"))?;
    sqlite_account_from_row(&row)
}

async fn fetch_mysql_account(
    tx: &mut sqlx::Transaction<'_, sqlx::MySql>,
    customer_id: &str,
    lock: bool,
) -> Result<CustomerAccountRecord, sqlx::Error> {
    let sql = if lock {
        "SELECT CAST(id AS CHAR) AS id, CAST(customerId AS CHAR) AS customerId,
                CAST(isEnabled AS SIGNED) AS isEnabled,
                CAST(creditLimitPence AS SIGNED) AS creditLimitPence,
                CAST(balancePence AS SIGNED) AS balancePence,
                CAST(createdAt AS CHAR) AS createdAt, CAST(updatedAt AS CHAR) AS updatedAt
         FROM customer_accounts WHERE customerId = ? LIMIT 1 FOR UPDATE"
    } else {
        "SELECT CAST(id AS CHAR) AS id, CAST(customerId AS CHAR) AS customerId,
                CAST(isEnabled AS SIGNED) AS isEnabled,
                CAST(creditLimitPence AS SIGNED) AS creditLimitPence,
                CAST(balancePence AS SIGNED) AS balancePence,
                CAST(createdAt AS CHAR) AS createdAt, CAST(updatedAt AS CHAR) AS updatedAt
         FROM customer_accounts WHERE customerId = ? LIMIT 1"
    };
    let row = sqlx::query(sql)
        .bind(customer_id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| account_protocol_error("Customer Pay Later account was not found"))?;
    mysql_account_from_row(&row)
}

async fn find_sqlite_account_entry(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    change: &CustomerAccountChange,
) -> Result<Option<CustomerAccountEntryRecord>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT id, accountId, customerId, orderId, entryType, amountPence, paymentMethod,
                COALESCE(tipsAmount, 0) AS tipsAmount, COALESCE(serviceChargeAmount, 0) AS serviceChargeAmount,
                COALESCE(cashbackAmount, 0) AS cashbackAmount,
                reference, description, receiptNumber, receiptKey, employeeId, tillNumber,
                shiftId, idempotencyKey, reversesEntryId, balanceAfterPence, createdAt, updatedAt
         FROM customer_account_entries WHERE id = ? OR idempotencyKey = ? LIMIT 1",
    )
    .bind(&change.id)
    .bind(&change.idempotency_key)
    .fetch_optional(&mut **tx)
    .await?;
    row.as_ref().map(sqlite_account_entry_from_row).transpose()
}

async fn find_mysql_account_entry(
    tx: &mut sqlx::Transaction<'_, sqlx::MySql>,
    change: &CustomerAccountChange,
) -> Result<Option<CustomerAccountEntryRecord>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT CAST(id AS CHAR) AS id, CAST(accountId AS CHAR) AS accountId,
                CAST(customerId AS CHAR) AS customerId, CAST(orderId AS CHAR) AS orderId,
                CAST(entryType AS CHAR) AS entryType, CAST(amountPence AS SIGNED) AS amountPence,
                CAST(paymentMethod AS CHAR) AS paymentMethod, CAST(reference AS CHAR) AS reference,
                CAST(COALESCE(tipsAmount, 0) AS SIGNED) AS tipsAmount,
                CAST(COALESCE(serviceChargeAmount, 0) AS SIGNED) AS serviceChargeAmount,
                CAST(COALESCE(cashbackAmount, 0) AS SIGNED) AS cashbackAmount,
                CAST(description AS CHAR) AS description, CAST(receiptNumber AS SIGNED) AS receiptNumber,
                CAST(receiptKey AS CHAR) AS receiptKey, CAST(employeeId AS CHAR) AS employeeId,
                CAST(tillNumber AS CHAR) AS tillNumber, CAST(shiftId AS CHAR) AS shiftId,
                CAST(idempotencyKey AS CHAR) AS idempotencyKey,
                CAST(reversesEntryId AS CHAR) AS reversesEntryId,
                CAST(balanceAfterPence AS SIGNED) AS balanceAfterPence,
                CAST(createdAt AS CHAR) AS createdAt, CAST(updatedAt AS CHAR) AS updatedAt
         FROM customer_account_entries WHERE id = ? OR idempotencyKey = ? LIMIT 1",
    )
    .bind(&change.id)
    .bind(&change.idempotency_key)
    .fetch_optional(&mut **tx)
    .await?;
    row.as_ref().map(mysql_account_entry_from_row).transpose()
}

async fn validate_sqlite_opening_balance_is_first(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    change: &CustomerAccountChange,
) -> Result<(), sqlx::Error> {
    if change.entry_type != "opening_balance" {
        return Ok(());
    }
    let existing: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM customer_account_entries WHERE customerId = ? LIMIT 1")
            .bind(&change.customer_id)
            .fetch_optional(&mut **tx)
            .await?;
    if existing.is_some() {
        return Err(account_protocol_error(
            "An opening balance can only be posted before any account activity",
        ));
    }
    Ok(())
}

async fn validate_mysql_opening_balance_is_first(
    tx: &mut sqlx::Transaction<'_, sqlx::MySql>,
    change: &CustomerAccountChange,
) -> Result<(), sqlx::Error> {
    if change.entry_type != "opening_balance" {
        return Ok(());
    }
    // Every account mutation locks the customer_accounts row first, so two tills
    // cannot both pass this check for the same customer.
    let existing: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM customer_account_entries WHERE customerId = ? LIMIT 1")
            .bind(&change.customer_id)
            .fetch_optional(&mut **tx)
            .await?;
    if existing.is_some() {
        return Err(account_protocol_error(
            "An opening balance can only be posted before any account activity",
        ));
    }
    Ok(())
}

async fn validate_sqlite_account_reversal(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    change: &CustomerAccountChange,
) -> Result<(), sqlx::Error> {
    if change.entry_type != "reversal" {
        return Ok(());
    }
    let original: Option<(String, i64)> = sqlx::query_as(
        "SELECT customerId, amountPence FROM customer_account_entries WHERE id = ? LIMIT 1",
    )
    .bind(&change.reverses_entry_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some((customer_id, amount)) = original else {
        return Err(account_protocol_error(
            "The customer account entry being reversed was not found",
        ));
    };
    let already_reversed: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM customer_account_entries WHERE reversesEntryId = ? LIMIT 1",
    )
    .bind(&change.reverses_entry_id)
    .fetch_optional(&mut **tx)
    .await?;
    if customer_id != change.customer_id
        || amount.checked_neg() != Some(change.amount_pence)
        || already_reversed.is_some()
    {
        return Err(account_protocol_error("Invalid customer account reversal"));
    }
    Ok(())
}

async fn validate_mysql_account_reversal(
    tx: &mut sqlx::Transaction<'_, sqlx::MySql>,
    change: &CustomerAccountChange,
) -> Result<(), sqlx::Error> {
    if change.entry_type != "reversal" {
        return Ok(());
    }
    let original: Option<(String, i64)> = sqlx::query_as(
        "SELECT CAST(customerId AS CHAR), CAST(amountPence AS SIGNED)
         FROM customer_account_entries WHERE id = ? LIMIT 1 FOR UPDATE",
    )
    .bind(&change.reverses_entry_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some((customer_id, amount)) = original else {
        return Err(account_protocol_error(
            "The customer account entry being reversed was not found",
        ));
    };
    let already_reversed: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM customer_account_entries WHERE reversesEntryId = ? LIMIT 1 FOR UPDATE",
    )
    .bind(&change.reverses_entry_id)
    .fetch_optional(&mut **tx)
    .await?;
    if customer_id != change.customer_id
        || amount.checked_neg() != Some(change.amount_pence)
        || already_reversed.is_some()
    {
        return Err(account_protocol_error("Invalid customer account reversal"));
    }
    Ok(())
}

async fn apply_sqlite_account_change(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    change: &mut CustomerAccountChange,
) -> Result<CustomerAccountMutationResult, sqlx::Error> {
    validate_account_change_shape(change)?;
    let mut account = fetch_sqlite_account(tx, &change.customer_id).await?;
    if let Some(entry) = find_sqlite_account_entry(tx, change).await? {
        if !entry_matches_change(&entry, change) {
            return Err(account_protocol_error(
                "Customer account idempotency conflict",
            ));
        }
        change.id = entry.id.clone();
        change.balance_after_pence = entry.balance_after_pence;
        change.created_at = entry.created_at.clone();
        change.updated_at = entry.updated_at.clone();
        return Ok(CustomerAccountMutationResult { account, entry });
    }
    validate_sqlite_opening_balance_is_first(tx, change).await?;
    validate_sqlite_account_reversal(tx, change).await?;
    let balance = validate_account_balance_change(&account, change)?;
    let stamp = if change.updated_at.trim().is_empty() {
        utc_stamp()
    } else {
        change.updated_at.clone()
    };
    if change.created_at.trim().is_empty() {
        change.created_at = stamp.clone();
    }
    change.updated_at = stamp.clone();
    change.balance_after_pence = balance;
    let result = sqlx::query(
        "UPDATE customer_accounts SET balancePence = ?, updatedAt = ?
         WHERE customerId = ? AND balancePence = ?",
    )
    .bind(balance)
    .bind(&stamp)
    .bind(&change.customer_id)
    .bind(account.balance_pence)
    .execute(&mut **tx)
    .await?;
    if result.rows_affected() != 1 {
        return Err(account_protocol_error(
            "Customer account balance changed; refresh and try again",
        ));
    }
    sqlx::query(
        "INSERT INTO customer_account_entries
         (id, accountId, customerId, orderId, entryType, amountPence, paymentMethod,
          reference, description, receiptNumber, receiptKey, employeeId, tillNumber,
          shiftId, idempotencyKey, reversesEntryId, balanceAfterPence, createdAt, updatedAt,
          tipsAmount, serviceChargeAmount, cashbackAmount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&change.id)
    .bind(&change.customer_id)
    .bind(&change.customer_id)
    .bind(&change.order_id)
    .bind(&change.entry_type)
    .bind(change.amount_pence)
    .bind(&change.payment_method)
    .bind(&change.reference)
    .bind(&change.description)
    .bind(change.receipt_number)
    .bind(&change.receipt_key)
    .bind(&change.employee_id)
    .bind(&change.till_number)
    .bind(&change.shift_id)
    .bind(&change.idempotency_key)
    .bind(&change.reverses_entry_id)
    .bind(balance)
    .bind(&change.created_at)
    .bind(&stamp)
    .bind(change.tips_amount)
    .bind(change.service_charge_amount)
    .bind(change.cashback_amount)
    .execute(&mut **tx)
    .await?;
    account.balance_pence = balance;
    account.updated_at = stamp.clone();
    let entry = change_to_entry(change, &stamp);
    Ok(CustomerAccountMutationResult { account, entry })
}

async fn apply_mysql_account_change(
    tx: &mut sqlx::Transaction<'_, sqlx::MySql>,
    change: &mut CustomerAccountChange,
    stamp: &str,
) -> Result<CustomerAccountMutationResult, sqlx::Error> {
    validate_account_change_shape(change)?;
    let mut account = fetch_mysql_account(tx, &change.customer_id, true).await?;
    if let Some(entry) = find_mysql_account_entry(tx, change).await? {
        if !entry_matches_change(&entry, change) {
            return Err(account_protocol_error(
                "Customer account idempotency conflict",
            ));
        }
        change.id = entry.id.clone();
        change.balance_after_pence = entry.balance_after_pence;
        change.created_at = entry.created_at.clone();
        change.updated_at = entry.updated_at.clone();
        return Ok(CustomerAccountMutationResult { account, entry });
    }
    validate_mysql_opening_balance_is_first(tx, change).await?;
    validate_mysql_account_reversal(tx, change).await?;
    let balance = validate_account_balance_change(&account, change)?;
    // MariaDB's clock defines report periods. A slow or fast till must not be
    // able to move a newly accepted repayment across a Z-report cutoff. The
    // idempotent replay path above preserves the original server timestamp.
    stamp_new_mysql_account_change(change, stamp);
    change.balance_after_pence = balance;
    let result = sqlx::query(
        "UPDATE customer_accounts SET balancePence = ?, updatedAt = ? WHERE customerId = ?",
    )
    .bind(balance)
    .bind(stamp)
    .bind(&change.customer_id)
    .execute(&mut **tx)
    .await?;
    if result.rows_affected() != 1 {
        return Err(account_protocol_error(
            "Customer account balance changed; refresh and try again",
        ));
    }
    sqlx::query(
        "INSERT INTO customer_account_entries
         (id, accountId, customerId, orderId, entryType, amountPence, paymentMethod,
          reference, description, receiptNumber, receiptKey, employeeId, tillNumber,
          shiftId, idempotencyKey, reversesEntryId, balanceAfterPence, createdAt, updatedAt,
          tipsAmount, serviceChargeAmount, cashbackAmount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&change.id)
    .bind(&change.customer_id)
    .bind(&change.customer_id)
    .bind(&change.order_id)
    .bind(&change.entry_type)
    .bind(change.amount_pence)
    .bind(&change.payment_method)
    .bind(&change.reference)
    .bind(&change.description)
    .bind(change.receipt_number)
    .bind(&change.receipt_key)
    .bind(&change.employee_id)
    .bind(&change.till_number)
    .bind(&change.shift_id)
    .bind(&change.idempotency_key)
    .bind(&change.reverses_entry_id)
    .bind(balance)
    .bind(&change.created_at)
    .bind(stamp)
    .bind(change.tips_amount)
    .bind(change.service_charge_amount)
    .bind(change.cashback_amount)
    .execute(&mut **tx)
    .await?;
    account.balance_pence = balance;
    account.updated_at = stamp.to_string();
    let entry = change_to_entry(change, stamp);
    Ok(CustomerAccountMutationResult { account, entry })
}

fn stamp_new_mysql_account_change(change: &mut CustomerAccountChange, stamp: &str) {
    change.created_at = stamp.to_string();
    change.updated_at = stamp.to_string();
}

async fn apply_authoritative_sqlite_account_change(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    change: &mut CustomerAccountChange,
) -> Result<CustomerAccountMutationResult, sqlx::Error> {
    validate_account_change_shape(change)?;
    let mut account = fetch_sqlite_account(tx, &change.customer_id).await?;
    let existing = find_sqlite_account_entry(tx, change).await?;
    if let Some(entry) = existing.as_ref() {
        if !entry_matches_change(entry, change) {
            return Err(account_protocol_error(
                "Customer account idempotency conflict",
            ));
        }
        change.id = entry.id.clone();
    }

    // MariaDB has already serialized and validated this movement. Its final
    // balance must replace the cache value; adding the delta to stale SQLite can
    // lose a movement made by another till and then share MariaDB's timestamp.
    let stamp = change.updated_at.clone();
    if stamp.trim().is_empty() {
        return Err(account_protocol_error(
            "Authoritative customer account entry is missing its server timestamp",
        ));
    }
    sqlx::query(
        "UPDATE customer_accounts SET balancePence = ?, updatedAt = ? WHERE customerId = ?",
    )
    .bind(change.balance_after_pence)
    .bind(&stamp)
    .bind(&change.customer_id)
    .execute(&mut **tx)
    .await?;

    if existing.is_some() {
        sqlx::query(
            "UPDATE customer_account_entries
             SET balanceAfterPence = ?, updatedAt = ?
             WHERE id = ?",
        )
        .bind(change.balance_after_pence)
        .bind(&stamp)
        .bind(&change.id)
        .execute(&mut **tx)
        .await?;
    } else {
        sqlx::query(
            "INSERT INTO customer_account_entries
             (id, accountId, customerId, orderId, entryType, amountPence, paymentMethod,
              reference, description, receiptNumber, receiptKey, employeeId, tillNumber,
              shiftId, idempotencyKey, reversesEntryId, balanceAfterPence, createdAt, updatedAt,
              tipsAmount, serviceChargeAmount, cashbackAmount)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&change.id)
        .bind(&change.customer_id)
        .bind(&change.customer_id)
        .bind(&change.order_id)
        .bind(&change.entry_type)
        .bind(change.amount_pence)
        .bind(&change.payment_method)
        .bind(&change.reference)
        .bind(&change.description)
        .bind(change.receipt_number)
        .bind(&change.receipt_key)
        .bind(&change.employee_id)
        .bind(&change.till_number)
        .bind(&change.shift_id)
        .bind(&change.idempotency_key)
        .bind(&change.reverses_entry_id)
        .bind(change.balance_after_pence)
        .bind(&change.created_at)
        .bind(&stamp)
        .bind(change.tips_amount)
        .bind(change.service_charge_amount)
        .bind(change.cashback_amount)
        .execute(&mut **tx)
        .await?;
    }

    account.balance_pence = change.balance_after_pence;
    account.updated_at = stamp.clone();
    let entry = change_to_entry(change, &stamp);
    Ok(CustomerAccountMutationResult { account, entry })
}

struct ReversalValidationContext {
    original_status: String,
    original_shift_id: String,
    original_customer_id: String,
    remaining: i64,
    original_subtotal: i64,
    original_discount_amount: i64,
    original_tax_total: i64,
    previous_subtotal: i64,
    previous_discount_amount: i64,
    previous_tax_total: i64,
    expected_stock: Vec<(String, i64)>,
    expected_line_quantities: Vec<(String, i64)>,
    void_period_closed: bool,
    original_payment: (i64, i64, i64, i64),
    previous_payment: (i64, i64, i64, i64),
    original_points: i64,
    previous_points_adjustment: i64,
}

fn payment_allocation(payment: &PaymentRecord) -> Result<(i64, i64, i64, i64), sqlx::Error> {
    let total = payment
        .amount
        .checked_abs()
        .ok_or_else(|| account_protocol_error("Invalid payment amount"))?;
    let mut cash = payment
        .cash_amount
        .checked_abs()
        .ok_or_else(|| account_protocol_error("Invalid cash amount"))?;
    let mut card = payment
        .card_amount
        .checked_abs()
        .ok_or_else(|| account_protocol_error("Invalid card amount"))?;
    let mut loyalty = payment
        .loyalty_amount
        .checked_abs()
        .ok_or_else(|| account_protocol_error("Invalid loyalty amount"))?;
    let mut account = payment
        .account_amount
        .checked_abs()
        .ok_or_else(|| account_protocol_error("Invalid customer account amount"))?;

    // Older receipts predate the explicit component columns. Preserve their
    // allocation while ensuring new Pay Later amounts can never be mistaken
    // for loyalty during a refund.
    if cash == 0 && payment.method == "cash" {
        cash = total;
    }
    if card == 0 && payment.method == "card" {
        card = total;
    }
    if loyalty == 0 && payment.method == "loyalty" {
        loyalty = total;
    }
    if account == 0
        && matches!(
            payment.method.as_str(),
            "account" | "pay_later" | "customer_account"
        )
    {
        account = total;
    }
    let allocated = cash
        .checked_add(card)
        .and_then(|value| value.checked_add(loyalty))
        .and_then(|value| value.checked_add(account))
        .ok_or_else(|| account_protocol_error("Payment allocation is too large"))?;
    if allocated > total {
        return Err(account_protocol_error(
            "Payment allocation exceeds the payment total",
        ));
    }
    if allocated < total {
        if payment.loyalty_amount == 0 && payment.account_amount == 0 {
            loyalty = loyalty
                .checked_add(total - allocated)
                .ok_or_else(|| account_protocol_error("Payment allocation is too large"))?;
        } else {
            return Err(account_protocol_error(
                "Payment components do not match the payment total",
            ));
        }
    }
    Ok((cash, card, loyalty, account))
}

fn sum_payment_allocations(
    payments: impl IntoIterator<Item = PaymentRecord>,
) -> Result<(i64, i64, i64, i64), sqlx::Error> {
    let mut result = (0_i64, 0_i64, 0_i64, 0_i64);
    for payment in payments {
        let allocation = payment_allocation(&payment)?;
        result.0 = result
            .0
            .checked_add(allocation.0)
            .ok_or_else(|| account_protocol_error("Payment allocation is too large"))?;
        result.1 = result
            .1
            .checked_add(allocation.1)
            .ok_or_else(|| account_protocol_error("Payment allocation is too large"))?;
        result.2 = result
            .2
            .checked_add(allocation.2)
            .ok_or_else(|| account_protocol_error("Payment allocation is too large"))?;
        result.3 = result
            .3
            .checked_add(allocation.3)
            .ok_or_else(|| account_protocol_error("Payment allocation is too large"))?;
    }
    Ok(result)
}

fn sum_payment_allocation_rows(
    rows: Vec<(String, i64, i64, i64, i64, i64)>,
) -> Result<(i64, i64, i64, i64), sqlx::Error> {
    sum_payment_allocations(rows.into_iter().map(
        |(method, amount, cash_amount, card_amount, loyalty_amount, account_amount)| {
            PaymentRecord {
                id: String::new(),
                order_id: String::new(),
                method,
                amount,
                cash_amount,
                card_amount,
                tips_amount: 0,
                service_charge_amount: 0,
                cashback_amount: 0,
                loyalty_amount,
                account_amount,
                reference: String::new(),
                change_given: 0,
                created_at: String::new(),
                updated_at: String::new(),
            }
        },
    ))
}

fn same_quantities(expected: &[(String, i64)], actual: &[(String, i64)]) -> bool {
    expected.len() == actual.len()
        && expected.iter().all(|(product_id, quantity)| {
            actual.iter().any(|(actual_id, actual_quantity)| {
                actual_id == product_id && actual_quantity == quantity
            })
        })
}

const MAX_SAFE_TERMINAL_MONEY: i64 = 9_007_199_254_740_991;

fn checked_terminal_extras(tips: i64, service_charge: i64, cashback: i64) -> Result<i64, sqlx::Error> {
    if [tips, service_charge, cashback].iter().any(|value| *value < 0) {
        return Err(account_protocol_error("Terminal additions cannot be negative"));
    }
    tips.checked_add(service_charge)
        .and_then(|value| value.checked_add(cashback))
        .filter(|value| *value <= MAX_SAFE_TERMINAL_MONEY)
        .ok_or_else(|| account_protocol_error("Terminal additions are too large"))
}

fn checked_card_collection(base: i64, extras: i64) -> Result<i64, sqlx::Error> {
    base.checked_add(extras)
        .filter(|value| base > 0 && *value <= MAX_SAFE_TERMINAL_MONEY)
        .ok_or_else(|| account_protocol_error("The total card collection is invalid or too large"))
}

fn validate_sale_terminal_extras(bundle: &SaleBundle) -> Result<(), sqlx::Error> {
    let payment = &bundle.payment;
    let extras = checked_terminal_extras(
        payment.tips_amount,
        payment.service_charge_amount,
        payment.cashback_amount,
    )?;
    if extras > 0 {
        if bundle.order.order_type != "sale" || payment.reference.trim().is_empty() {
            return Err(account_protocol_error(
                "Terminal additions belong to the original referenced sale; goods refunds exclude them",
            ));
        }
        // Product tender allocation remains unchanged. Extras affect the
        // terminal collection and drawer only, never stock, VAT or loyalty.
        checked_card_collection(payment.card_amount, extras)?;
        payment_allocation(payment)?;
    }
    Ok(())
}

fn prepare_sale_account_changes(bundle: &mut SaleBundle) -> Result<(), sqlx::Error> {
    validate_sale_terminal_extras(bundle)?;
    let account_amount = bundle.payment.account_amount;
    if account_amount == 0 && bundle.account_changes.is_empty() {
        return Ok(());
    }
    let order = &bundle.order;
    let expected_type = match order.order_type.as_str() {
        "sale" if account_amount > 0 => "charge",
        "return" if account_amount < 0 => "refund",
        _ => {
            return Err(account_protocol_error(
                "Invalid Pay Later allocation for this transaction",
            ));
        }
    };
    if order.customer_id.trim().is_empty()
        || bundle.payment.order_id != order.id
        || bundle.account_changes.is_empty()
    {
        return Err(account_protocol_error(
            "Pay Later requires a selected customer and account entry",
        ));
    }
    let change_total = bundle
        .account_changes
        .iter()
        .try_fold(0_i64, |sum, change| {
            sum.checked_add(change.amount_pence)
                .ok_or_else(|| account_protocol_error("Customer account amount is too large"))
        })?;
    if change_total != account_amount {
        return Err(account_protocol_error(
            "Customer account entries do not match the Pay Later amount",
        ));
    }
    let mut ids = HashSet::new();
    let mut idempotency_keys = HashSet::new();
    for change in &mut bundle.account_changes {
        if change.customer_id != order.customer_id
            || change.order_id != order.id
            || change.entry_type != expected_type
            || !ids.insert(change.id.clone())
            || !idempotency_keys.insert(change.idempotency_key.clone())
            || (change.receipt_number != 0 && change.receipt_number != order.order_number)
            || (!change.receipt_key.trim().is_empty() && change.receipt_key != order.receipt_key)
            || (!change.employee_id.trim().is_empty() && change.employee_id != order.employee_id)
            || (!change.till_number.trim().is_empty() && change.till_number != order.till_number)
            || (!change.shift_id.trim().is_empty() && change.shift_id != order.shift_id)
        {
            return Err(account_protocol_error(
                "Invalid customer account sale entry",
            ));
        }
        change.receipt_number = order.order_number;
        change.receipt_key = order.receipt_key.clone();
        change.employee_id = order.employee_id.clone();
        change.till_number = order.till_number.clone();
        change.shift_id = order.shift_id.clone();
        if change.created_at.trim().is_empty() {
            change.created_at = order.completed_at.clone();
        }
        change.updated_at = order.updated_at.clone();
        change.balance_after_pence = 0;
        validate_account_change_shape(change)?;
    }
    let allocation = payment_allocation(&bundle.payment)?;
    if allocation.3 != account_amount.abs() {
        return Err(account_protocol_error(
            "Pay Later allocation does not match the payment",
        ));
    }
    Ok(())
}

fn validate_reversal_bundle(
    bundle: &SaleBundle,
    context: &ReversalValidationContext,
) -> Result<(), sqlx::Error> {
    let o = &bundle.order;
    let refund_amount = o
        .total
        .checked_abs()
        .ok_or_else(|| sqlx::Error::Protocol("Invalid reversal amount".into()))?;
    let target_status = bundle.original_status_update.as_deref().unwrap_or("");
    let is_void = bundle.audit.action == "order_voided" || o.notes.starts_with("Void of receipt");
    let line_discount = bundle
        .lines
        .iter()
        .map(|line| line.discount_amount)
        .sum::<i64>();
    let line_tax = bundle.lines.iter().map(|line| line.tax_amount).sum::<i64>();
    let payment_allocation = payment_allocation(&bundle.payment)?;

    if o.status != "completed"
        || bundle.lines.is_empty()
        || bundle.payment.order_id != o.id
        || bundle.payment.amount != o.total
        || bundle.payment.method != o.payment_method
        || bundle.payment.cash_amount > 0
        || bundle.payment.card_amount > 0
        || bundle.payment.loyalty_amount > 0
        || bundle.payment.account_amount > 0
        || o.amount_tendered != o.total
        || o.customer_id != context.original_customer_id
        || o.subtotal > 0
        || o.discount_amount > 0
        || o.tax_total > 0
        || bundle.audit.entity_id != o.original_order_id
        || bundle.original_order_to_update.as_deref() != Some(o.original_order_id.as_str())
        || bundle.lines.iter().any(|line| {
            line.order_id != o.id
                || line.line_total > 0
                || line.discount_amount > 0
                || line.tax_amount > 0
                || !context
                    .expected_line_quantities
                    .iter()
                    .any(|(product_id, _)| product_id == &line.product_id)
        })
        || bundle.lines.iter().map(|line| line.line_total).sum::<i64>() != o.total
        || line_discount != o.discount_amount
        || line_tax != o.tax_total
        || bundle.loyalty_changes.len() > 1
        || bundle.loyalty_changes.iter().any(|change| {
            change.order_id != o.id
                || change.customer_id != o.customer_id
                || change.reason != "refund_adjustment"
        })
        || bundle.account_changes.len() > 1
        || bundle.account_changes.iter().any(|change| {
            change.order_id != o.id
                || change.customer_id != o.customer_id
                || change.entry_type != "refund"
                || change.amount_pence != -payment_allocation.3
        })
        || (payment_allocation.3 == 0) != bundle.account_changes.is_empty()
    {
        return Err(sqlx::Error::Protocol("Invalid reversal bundle".into()));
    }

    let cumulative_subtotal = context.previous_subtotal + o.subtotal.abs();
    let cumulative_discount = context.previous_discount_amount + o.discount_amount.abs();
    let cumulative_tax = context.previous_tax_total + o.tax_total.abs();
    if cumulative_subtotal > context.original_subtotal.abs()
        || cumulative_discount > context.original_discount_amount.abs()
        || cumulative_tax > context.original_tax_total.abs()
    {
        return Err(sqlx::Error::Protocol(
            "Reversal financial values exceed the original sale".into(),
        ));
    }

    let (cash, card, loyalty, account) = payment_allocation;
    let cumulative_payment = (
        context.previous_payment.0 + cash,
        context.previous_payment.1 + card,
        context.previous_payment.2 + loyalty,
        context.previous_payment.3 + account,
    );
    if cumulative_payment.0 > context.original_payment.0
        || cumulative_payment.1 > context.original_payment.1
        || cumulative_payment.2 > context.original_payment.2
        || cumulative_payment.3 > context.original_payment.3
    {
        return Err(sqlx::Error::Protocol(
            "Refund payment allocation exceeds the original payment".into(),
        ));
    }

    let current_points = bundle
        .loyalty_changes
        .iter()
        .map(|change| change.points_change)
        .sum::<i64>();
    let cumulative_points = context.previous_points_adjustment + current_points;
    if (context.original_points == 0 && cumulative_points != 0)
        || (context.original_points != 0
            && cumulative_points != 0
            && cumulative_points.signum() == context.original_points.signum())
        || cumulative_points.abs() > context.original_points.abs()
    {
        return Err(sqlx::Error::Protocol(
            "Invalid loyalty adjustment for reversal".into(),
        ));
    }

    let expected_status = if is_void {
        if context.original_status != "completed"
            || refund_amount != context.remaining
            || o.shift_id != context.original_shift_id
            || context.void_period_closed
        {
            return Err(sqlx::Error::Protocol("Invalid void request".into()));
        }
        "voided"
    } else if refund_amount == context.remaining {
        "refunded"
    } else {
        "partially_refunded"
    };
    if target_status != expected_status {
        return Err(sqlx::Error::Protocol("Invalid reversal status".into()));
    }
    let expected_action = if is_void {
        "order_voided"
    } else if expected_status == "partially_refunded" {
        "order_partially_refunded"
    } else {
        "order_refunded"
    };
    if bundle.audit.action != expected_action {
        return Err(sqlx::Error::Protocol(
            "Invalid reversal audit action".into(),
        ));
    }

    if expected_status != "partially_refunded"
        && (cumulative_payment != context.original_payment
            || cumulative_points != -context.original_points)
    {
        return Err(sqlx::Error::Protocol(
            "Full reversal does not restore the original payment and loyalty balance".into(),
        ));
    }

    if expected_status == "partially_refunded" {
        if !bundle.stock_changes.is_empty() || bundle.lines.iter().any(|line| line.quantity != 0) {
            return Err(sqlx::Error::Protocol(
                "Partial refunds cannot restore stock".into(),
            ));
        }
    } else {
        if bundle.lines.iter().any(|line| line.quantity > 0) {
            return Err(sqlx::Error::Protocol(
                "Invalid full reversal quantities".into(),
            ));
        }
        let mut actual_stock: Vec<(String, i64)> = Vec::new();
        for change in &bundle.stock_changes {
            if change.delta <= 0 || change.movement_type != "return" {
                return Err(sqlx::Error::Protocol(
                    "Invalid reversal stock change".into(),
                ));
            }
            if let Some(existing) = actual_stock
                .iter_mut()
                .find(|(product_id, _)| product_id == &change.product_id)
            {
                existing.1 += change.delta;
            } else {
                actual_stock.push((change.product_id.clone(), change.delta));
            }
        }
        if !same_quantities(&context.expected_stock, &actual_stock) {
            return Err(sqlx::Error::Protocol(
                "Invalid reversal stock restoration; synchronize and try again".into(),
            ));
        }

        let mut actual_lines: Vec<(String, i64)> = Vec::new();
        for line in &bundle.lines {
            if let Some(existing) = actual_lines
                .iter_mut()
                .find(|(product_id, _)| product_id == &line.product_id)
            {
                existing.1 += line.quantity.abs();
            } else {
                actual_lines.push((line.product_id.clone(), line.quantity.abs()));
            }
        }
        if !same_quantities(&context.expected_line_quantities, &actual_lines) {
            return Err(sqlx::Error::Protocol(
                "Full reversal quantities do not match the original sale".into(),
            ));
        }
    }
    Ok(())
}

async fn validate_sqlite_reversal(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    bundle: &SaleBundle,
) -> Result<(), sqlx::Error> {
    let o = &bundle.order;
    if o.order_type != "return" {
        return Ok(());
    }
    if o.original_order_id.is_empty() || o.total >= 0 {
        return Err(sqlx::Error::Protocol("Invalid refund transaction".into()));
    }
    let original: Option<(i64, String, String, String, String, i64, i64, i64, String)> =
        sqlx::query_as(
            "SELECT total, status, COALESCE(shiftId, ''), COALESCE(tillNumber, ''),
                    COALESCE(completedAt, ''), subtotal, discountAmount, taxTotal,
                    COALESCE(customerId, '')
             FROM orders WHERE id = ? LIMIT 1",
        )
        .bind(&o.original_order_id)
        .fetch_optional(&mut **tx)
        .await?;
    let Some((
        original_total,
        original_status,
        original_shift_id,
        original_till_number,
        original_completed_at,
        original_subtotal,
        original_discount_amount,
        original_tax_total,
        original_customer_id,
    )) = original
    else {
        return Err(sqlx::Error::Protocol("Original sale was not found".into()));
    };
    if original_status != "completed" && original_status != "partially_refunded" {
        return Err(sqlx::Error::Protocol(
            "Sale is not available for refund".into(),
        ));
    }
    if bundle.audit.action == "order_voided" || o.notes.starts_with("Void of receipt") {
        let with_extras: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM payments WHERE orderId = ?
             AND (COALESCE(tipsAmount, 0) <> 0 OR COALESCE(serviceChargeAmount, 0) <> 0
                  OR COALESCE(cashbackAmount, 0) <> 0)",
        )
        .bind(&o.original_order_id)
        .fetch_one(&mut **tx)
        .await?;
        if with_extras > 0 {
            return Err(account_protocol_error(
                "A sale with terminal additions cannot be voided; refund goods without reversing tips, service charge or cashback",
            ));
        }
    }
    let previous_financials: (i64, i64, i64, i64) = sqlx::query_as(
        "SELECT COALESCE(SUM(ABS(total)), 0), COALESCE(SUM(ABS(subtotal)), 0),
                COALESCE(SUM(ABS(discountAmount)), 0), COALESCE(SUM(ABS(taxTotal)), 0)
         FROM orders WHERE type = 'return' AND originalOrderId = ?",
    )
    .bind(&o.original_order_id)
    .fetch_one(&mut **tx)
    .await?;
    let remaining = (original_total - previous_financials.0).max(0);
    if o.total.abs() > remaining {
        return Err(sqlx::Error::Protocol(
            "Refund exceeds the remaining sale balance".into(),
        ));
    }
    let expected_stock: Vec<(String, i64)> = sqlx::query_as(
        "SELECT productId, SUM(ABS(quantityChange)) FROM inventory_logs
         WHERE referenceId = ? AND type = 'sale' AND quantityChange < 0 GROUP BY productId",
    )
    .bind(&o.original_order_id)
    .fetch_all(&mut **tx)
    .await?;
    let expected_line_quantities: Vec<(String, i64)> = sqlx::query_as(
        "SELECT productId, SUM(ABS(quantity)) FROM order_lines
         WHERE orderId = ? GROUP BY productId",
    )
    .bind(&o.original_order_id)
    .fetch_all(&mut **tx)
    .await?;
    let original_payment_rows: Vec<(String, i64, i64, i64, i64, i64)> = sqlx::query_as(
        "SELECT method, amount, COALESCE(cashAmount, 0), COALESCE(cardAmount, 0),
                COALESCE(loyaltyAmount, 0), COALESCE(accountAmount, 0)
         FROM payments WHERE orderId = ?",
    )
    .bind(&o.original_order_id)
    .fetch_all(&mut **tx)
    .await?;
    let original_payment = sum_payment_allocation_rows(original_payment_rows)?;
    let previous_payment_rows: Vec<(String, i64, i64, i64, i64, i64)> = sqlx::query_as(
        "SELECT p.method, p.amount, COALESCE(p.cashAmount, 0), COALESCE(p.cardAmount, 0),
                COALESCE(p.loyaltyAmount, 0), COALESCE(p.accountAmount, 0)
         FROM payments p JOIN orders r ON r.id = p.orderId
         WHERE r.type = 'return' AND r.originalOrderId = ?",
    )
    .bind(&o.original_order_id)
    .fetch_all(&mut **tx)
    .await?;
    let previous_payment = sum_payment_allocation_rows(previous_payment_rows)?;
    let original_points: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(pointsChange), 0) FROM loyalty_logs WHERE orderId = ?",
    )
    .bind(&o.original_order_id)
    .fetch_one(&mut **tx)
    .await?;
    let previous_points_adjustment: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(l.pointsChange), 0) FROM loyalty_logs l
         JOIN orders r ON r.id = l.orderId
         WHERE r.type = 'return' AND r.originalOrderId = ? AND l.reason = 'refund_adjustment'",
    )
    .bind(&o.original_order_id)
    .fetch_one(&mut **tx)
    .await?;
    let last_close_marker: Option<String> = sqlx::query_scalar(
        "SELECT MAX(markerTime) FROM till_report_markers WHERE tillNumber = '' OR tillNumber = ?",
    )
    .bind(&original_till_number)
    .fetch_one(&mut **tx)
    .await?;
    let context = ReversalValidationContext {
        original_status,
        original_shift_id,
        original_customer_id,
        remaining,
        original_subtotal,
        original_discount_amount,
        original_tax_total,
        previous_subtotal: previous_financials.1,
        previous_discount_amount: previous_financials.2,
        previous_tax_total: previous_financials.3,
        expected_stock,
        expected_line_quantities,
        void_period_closed: last_close_marker.as_deref().is_some_and(|marker| {
            !original_completed_at.is_empty() && original_completed_at.as_str() <= marker
        }),
        original_payment,
        previous_payment,
        original_points,
        previous_points_adjustment,
    };
    validate_reversal_bundle(bundle, &context)
}

async fn validate_mysql_reversal(
    tx: &mut sqlx::Transaction<'_, sqlx::MySql>,
    bundle: &SaleBundle,
) -> Result<(), sqlx::Error> {
    let o = &bundle.order;
    if o.order_type != "return" {
        return Ok(());
    }
    if o.original_order_id.is_empty() || o.total >= 0 {
        return Err(sqlx::Error::Protocol("Invalid refund transaction".into()));
    }
    let original: Option<(i64, String, String, String, String, i64, i64, i64, String)> =
        sqlx::query_as(
            "SELECT total, CAST(status AS CHAR), CAST(COALESCE(shiftId, '') AS CHAR),
                CAST(COALESCE(tillNumber, '') AS CHAR), CAST(COALESCE(completedAt, '') AS CHAR),
                subtotal, discountAmount, taxTotal, CAST(COALESCE(customerId, '') AS CHAR)
         FROM orders WHERE id = ? LIMIT 1 FOR UPDATE",
        )
        .bind(&o.original_order_id)
        .fetch_optional(&mut **tx)
        .await?;
    let Some((
        original_total,
        original_status,
        original_shift_id,
        original_till_number,
        original_completed_at,
        original_subtotal,
        original_discount_amount,
        original_tax_total,
        original_customer_id,
    )) = original
    else {
        return Err(sqlx::Error::Protocol("Original sale was not found".into()));
    };
    if original_status != "completed" && original_status != "partially_refunded" {
        return Err(sqlx::Error::Protocol(
            "Sale is not available for refund".into(),
        ));
    }
    if bundle.audit.action == "order_voided" || o.notes.starts_with("Void of receipt") {
        let with_extras: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM payments WHERE orderId = ?
             AND (COALESCE(tipsAmount, 0) <> 0 OR COALESCE(serviceChargeAmount, 0) <> 0
                  OR COALESCE(cashbackAmount, 0) <> 0)",
        )
        .bind(&o.original_order_id)
        .fetch_one(&mut **tx)
        .await?;
        if with_extras > 0 {
            return Err(account_protocol_error(
                "A sale with terminal additions cannot be voided; refund goods without reversing tips, service charge or cashback",
            ));
        }
    }
    let previous_financials: (i64, i64, i64, i64) = sqlx::query_as(
        "SELECT CAST(COALESCE(SUM(ABS(total)), 0) AS SIGNED),
                CAST(COALESCE(SUM(ABS(subtotal)), 0) AS SIGNED),
                CAST(COALESCE(SUM(ABS(discountAmount)), 0) AS SIGNED),
                CAST(COALESCE(SUM(ABS(taxTotal)), 0) AS SIGNED)
         FROM orders WHERE type = 'return' AND originalOrderId = ?",
    )
    .bind(&o.original_order_id)
    .fetch_one(&mut **tx)
    .await?;
    let remaining = (original_total - previous_financials.0).max(0);
    if o.total.abs() > remaining {
        return Err(sqlx::Error::Protocol(
            "Refund exceeds the remaining sale balance".into(),
        ));
    }
    let expected_stock: Vec<(String, i64)> = sqlx::query_as(
        "SELECT productId, CAST(SUM(ABS(quantityChange)) AS SIGNED) FROM inventory_logs
         WHERE referenceId = ? AND type = 'sale' AND quantityChange < 0 GROUP BY productId",
    )
    .bind(&o.original_order_id)
    .fetch_all(&mut **tx)
    .await?;
    let expected_line_quantities: Vec<(String, i64)> = sqlx::query_as(
        "SELECT CAST(productId AS CHAR), CAST(SUM(ABS(quantity)) AS SIGNED) FROM order_lines
         WHERE orderId = ? GROUP BY productId",
    )
    .bind(&o.original_order_id)
    .fetch_all(&mut **tx)
    .await?;
    let original_payment_rows: Vec<(String, i64, i64, i64, i64, i64)> = sqlx::query_as(
        "SELECT CAST(method AS CHAR), CAST(amount AS SIGNED),
                CAST(COALESCE(cashAmount, 0) AS SIGNED),
                CAST(COALESCE(cardAmount, 0) AS SIGNED),
                CAST(COALESCE(loyaltyAmount, 0) AS SIGNED),
                CAST(COALESCE(accountAmount, 0) AS SIGNED)
         FROM payments WHERE orderId = ?",
    )
    .bind(&o.original_order_id)
    .fetch_all(&mut **tx)
    .await?;
    let original_payment = sum_payment_allocation_rows(original_payment_rows)?;
    let previous_payment_rows: Vec<(String, i64, i64, i64, i64, i64)> = sqlx::query_as(
        "SELECT CAST(p.method AS CHAR), CAST(p.amount AS SIGNED),
                CAST(COALESCE(p.cashAmount, 0) AS SIGNED),
                CAST(COALESCE(p.cardAmount, 0) AS SIGNED),
                CAST(COALESCE(p.loyaltyAmount, 0) AS SIGNED),
                CAST(COALESCE(p.accountAmount, 0) AS SIGNED)
         FROM payments p JOIN orders r ON r.id = p.orderId
         WHERE r.type = 'return' AND r.originalOrderId = ?",
    )
    .bind(&o.original_order_id)
    .fetch_all(&mut **tx)
    .await?;
    let previous_payment = sum_payment_allocation_rows(previous_payment_rows)?;
    let original_points: i64 = sqlx::query_scalar(
        "SELECT CAST(COALESCE(SUM(pointsChange), 0) AS SIGNED) FROM loyalty_logs WHERE orderId = ?",
    )
    .bind(&o.original_order_id)
    .fetch_one(&mut **tx)
    .await?;
    let previous_points_adjustment: i64 = sqlx::query_scalar(
        "SELECT CAST(COALESCE(SUM(l.pointsChange), 0) AS SIGNED) FROM loyalty_logs l
         JOIN orders r ON r.id = l.orderId
         WHERE r.type = 'return' AND r.originalOrderId = ? AND l.reason = 'refund_adjustment'",
    )
    .bind(&o.original_order_id)
    .fetch_one(&mut **tx)
    .await?;
    let last_close_marker: Option<String> = sqlx::query_scalar(
        "SELECT CAST(MAX(markerTime) AS CHAR) FROM till_report_markers WHERE tillNumber = '' OR tillNumber = ?",
    )
    .bind(&original_till_number)
    .fetch_one(&mut **tx)
    .await?;
    let context = ReversalValidationContext {
        original_status,
        original_shift_id,
        original_customer_id,
        remaining,
        original_subtotal,
        original_discount_amount,
        original_tax_total,
        previous_subtotal: previous_financials.1,
        previous_discount_amount: previous_financials.2,
        previous_tax_total: previous_financials.3,
        expected_stock,
        expected_line_quantities,
        void_period_closed: last_close_marker.as_deref().is_some_and(|marker| {
            !original_completed_at.is_empty() && original_completed_at.as_str() <= marker
        }),
        original_payment,
        previous_payment,
        original_points,
        previous_points_adjustment,
    };
    validate_reversal_bundle(bundle, &context)
}

async fn allocate_local_receipt(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    o: &mut OrderRecord,
) -> Result<(), sqlx::Error> {
    if o.order_number > 0 && !o.receipt_key.trim().is_empty() {
        return Ok(());
    }

    let till_seq: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key = 'till_seq'")
            .fetch_optional(&mut **tx)
            .await?;
    let start: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key = 'starting_receipt_number'")
            .fetch_optional(&mut **tx)
            .await?;
    let high_water: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = ?")
        .bind(RECEIPT_HIGH_WATER_KEY)
        .fetch_optional(&mut **tx)
        .await?;
    let start_num = start
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(1);
    let till_seq = till_seq
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(0);
    let high_water = high_water
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(0);

    let next = if till_seq > 0 {
        let block_start = till_seq * RECEIPT_BLOCK;
        let block_end = block_start + RECEIPT_BLOCK;
        let local_max: Option<i64> = sqlx::query_scalar(
            "SELECT MAX(orderNumber) FROM orders WHERE orderNumber >= ? AND orderNumber < ?",
        )
        .bind(block_start)
        .bind(block_end)
        .fetch_one(&mut **tx)
        .await?;
        let block_high_water = if high_water >= block_start && high_water < block_end {
            high_water
        } else {
            0
        };
        match local_max.unwrap_or(0).max(block_high_water) {
            max if max >= block_start => max + 1,
            _ => block_start + start_num,
        }
    } else {
        let global_max: Option<i64> =
            sqlx::query_scalar("SELECT MAX(orderNumber) FROM orders WHERE orderNumber > 0")
                .fetch_one(&mut **tx)
                .await?;
        let next = global_max.unwrap_or(0).max(high_water) + 1;
        next.max(start_num)
    };

    o.order_number = next;
    o.receipt_key = format!("{}:{}", o.till_number, next);
    Ok(())
}

async fn ensure_sqlite_online_financial_intent_schema(
    pool: &SqlitePool,
) -> Result<(), sqlx::Error> {
    sqlx::query(&format!(
        "CREATE TABLE IF NOT EXISTS {ONLINE_FINANCIAL_INTENT_TABLE} (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            operation TEXT NOT NULL,
            orderId TEXT NOT NULL UNIQUE,
            requestJson TEXT NOT NULL,
            bundleJson TEXT NOT NULL,
            serverDataEpoch TEXT NOT NULL DEFAULT '',
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL,
            lastError TEXT NOT NULL DEFAULT ''
         )"
    ))
    .execute(pool)
    .await?;
    let has_epoch_column = sqlx::query(&format!(
        "PRAGMA table_info({ONLINE_FINANCIAL_INTENT_TABLE})"
    ))
    .fetch_all(pool)
    .await?
    .iter()
    .any(|row| {
        row.try_get::<String, _>("name")
            .is_ok_and(|name| name == "serverDataEpoch")
    });
    if !has_epoch_column {
        // Existing unresolved intents deliberately receive an empty epoch.
        // Replay will accept that only against an equally legacy empty remote
        // epoch; it must never guess which non-empty shop epoch they belong to.
        sqlx::query(&format!(
            "ALTER TABLE {ONLINE_FINANCIAL_INTENT_TABLE}
             ADD COLUMN serverDataEpoch TEXT NOT NULL DEFAULT ''"
        ))
        .execute(pool)
        .await?;
    }
    Ok(())
}

async fn reserve_sqlite_online_financial_intent(
    pool: &SqlitePool,
    operation: &str,
    bundle: &SaleBundle,
    validate_reversal: bool,
) -> Result<SaleBundle, sqlx::Error> {
    ensure_sqlite_online_financial_intent_schema(pool).await?;
    let request_json =
        serde_json::to_string(bundle).map_err(|error| account_protocol_error(error.to_string()))?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let existing: Option<(String, String, String, String, String)> = sqlx::query_as(&format!(
        "SELECT operation, orderId, requestJson, bundleJson, serverDataEpoch
         FROM {ONLINE_FINANCIAL_INTENT_TABLE} WHERE id = 1"
    ))
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((saved_operation, saved_order_id, saved_request, saved_bundle, _)) = existing {
        if saved_operation != operation
            || saved_order_id != bundle.order.id
            || saved_request != request_json
        {
            return Err(account_protocol_error(format!(
                "{ONLINE_FINANCIAL_INTENT_PENDING_CODE}: order {saved_order_id} ({saved_operation}) must finish before another shared financial transaction"
            )));
        }
        let reserved: SaleBundle = serde_json::from_str(&saved_bundle)
            .map_err(|error| account_protocol_error(error.to_string()))?;
        tx.commit().await?;
        return Ok(reserved);
    }

    let mut reserved = bundle.clone();
    allocate_local_receipt(&mut tx, &mut reserved.order).await?;
    prepare_sale_account_changes(&mut reserved)?;
    if validate_reversal {
        validate_sqlite_reversal(&mut tx, &reserved).await?;
    }
    reserved.audit.new_data = serde_json::json!({
        "orderNumber": reserved.order.order_number,
        "total": reserved.order.total,
    })
    .to_string();
    sqlx::query(
        "INSERT INTO settings (key, value, updatedAt) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
            value = CASE
                WHEN CAST(COALESCE(settings.value, '0') AS INTEGER) < CAST(excluded.value AS INTEGER)
                THEN excluded.value ELSE settings.value END,
            updatedAt = excluded.updatedAt",
    )
    .bind(RECEIPT_HIGH_WATER_KEY)
    .bind(reserved.order.order_number.to_string())
    .bind(utc_stamp())
    .execute(&mut *tx)
    .await?;
    let server_data_epoch: String = sqlx::query_scalar(
        "SELECT COALESCE((SELECT value FROM settings
                          WHERE key = 'server_data_epoch_seen' LIMIT 1), '')",
    )
    .fetch_one(&mut *tx)
    .await?;
    reserved.server_data_epoch = server_data_epoch.trim().to_string();
    let bundle_json = serde_json::to_string(&reserved)
        .map_err(|error| account_protocol_error(error.to_string()))?;
    let stamp = utc_stamp();
    sqlx::query(&format!(
        "INSERT INTO {ONLINE_FINANCIAL_INTENT_TABLE}
            (id, operation, orderId, requestJson, bundleJson, serverDataEpoch,
             createdAt, updatedAt, lastError)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, '')"
    ))
    .bind(operation)
    .bind(&reserved.order.id)
    .bind(request_json)
    .bind(bundle_json)
    .bind(&reserved.server_data_epoch)
    .bind(&stamp)
    .bind(&stamp)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(reserved)
}

async fn load_sqlite_online_financial_intent(
    pool: &SqlitePool,
) -> Result<Option<(String, SaleBundle, String)>, sqlx::Error> {
    ensure_sqlite_online_financial_intent_schema(pool).await?;
    let row: Option<(String, String, String)> = sqlx::query_as(&format!(
        "SELECT operation, bundleJson, serverDataEpoch
         FROM {ONLINE_FINANCIAL_INTENT_TABLE} WHERE id = 1"
    ))
    .fetch_optional(pool)
    .await?;
    row.map(|(operation, json, epoch)| {
        serde_json::from_str(&json)
            .map(|bundle| (operation, bundle, epoch.trim().to_string()))
            .map_err(|error| account_protocol_error(error.to_string()))
    })
    .transpose()
}

async fn record_sqlite_online_financial_intent_error(
    pool: &SqlitePool,
    error: &sqlx::Error,
) -> Result<(), sqlx::Error> {
    ensure_sqlite_online_financial_intent_schema(pool).await?;
    sqlx::query(&format!(
        "UPDATE {ONLINE_FINANCIAL_INTENT_TABLE}
         SET lastError = ?, updatedAt = ? WHERE id = 1"
    ))
    .bind(error.to_string())
    .bind(utc_stamp())
    .execute(pool)
    .await?;
    Ok(())
}

async fn update_sqlite_online_financial_intent_bundle(
    pool: &SqlitePool,
    operation: &str,
    bundle: &SaleBundle,
) -> Result<(), sqlx::Error> {
    let json =
        serde_json::to_string(bundle).map_err(|error| account_protocol_error(error.to_string()))?;
    let result = sqlx::query(&format!(
        "UPDATE {ONLINE_FINANCIAL_INTENT_TABLE}
         SET bundleJson = ?, updatedAt = ?, lastError = ''
         WHERE id = 1 AND operation = ? AND orderId = ?"
    ))
    .bind(json)
    .bind(utc_stamp())
    .bind(operation)
    .bind(&bundle.order.id)
    .execute(pool)
    .await?;
    if result.rows_affected() != 1 {
        return Err(account_protocol_error(
            "Online financial intent changed before its authoritative result was saved",
        ));
    }
    Ok(())
}

async fn clear_sqlite_online_financial_intent(
    pool: &SqlitePool,
    operation: &str,
    order_id: &str,
) -> Result<(), sqlx::Error> {
    let result = sqlx::query(&format!(
        "DELETE FROM {ONLINE_FINANCIAL_INTENT_TABLE}
         WHERE id = 1 AND operation = ? AND orderId = ?"
    ))
    .bind(operation)
    .bind(order_id)
    .execute(pool)
    .await?;
    if result.rows_affected() != 1 {
        return Err(account_protocol_error(
            "Online financial intent changed before it could be completed",
        ));
    }
    Ok(())
}

async fn sqlite_bundle_row_exists(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    table: &str,
    id: &str,
) -> Result<bool, sqlx::Error> {
    let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table} WHERE id = ?"))
        .bind(id)
        .fetch_one(&mut **tx)
        .await?;
    Ok(count == 1)
}

async fn sqlite_bundle_already_committed(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    bundle: &SaleBundle,
) -> Result<bool, sqlx::Error> {
    let receipt: Option<String> = sqlx::query_scalar("SELECT receiptKey FROM orders WHERE id = ?")
        .bind(&bundle.order.id)
        .fetch_optional(&mut **tx)
        .await?;
    let Some(receipt) = receipt else {
        return Ok(false);
    };
    if receipt != bundle.order.receipt_key {
        return Err(account_protocol_error(
            "Local order id already exists with a different receipt",
        ));
    }
    if !sqlite_bundle_row_exists(tx, "payments", &bundle.payment.id).await? {
        return Err(account_protocol_error(
            "Local order exists without its authoritative payment",
        ));
    }
    for (table, ids) in [
        (
            "order_lines",
            bundle
                .lines
                .iter()
                .map(|row| row.id.as_str())
                .collect::<Vec<_>>(),
        ),
        (
            "inventory_logs",
            bundle
                .stock_changes
                .iter()
                .map(|row| row.log_id.as_str())
                .collect::<Vec<_>>(),
        ),
        (
            "loyalty_logs",
            bundle
                .loyalty_changes
                .iter()
                .map(|row| row.id.as_str())
                .collect::<Vec<_>>(),
        ),
        (
            "customer_account_entries",
            bundle
                .account_changes
                .iter()
                .map(|row| row.id.as_str())
                .collect::<Vec<_>>(),
        ),
        ("audit_logs", vec![bundle.audit.id.as_str()]),
    ] {
        for id in ids {
            if !sqlite_bundle_row_exists(tx, table, id).await? {
                return Err(account_protocol_error(format!(
                    "Local order exists without its authoritative {table} row"
                )));
            }
        }
    }
    Ok(true)
}

async fn insert_sqlite_bundle_with_account_authority(
    pool: &SqlitePool,
    bundle: &SaleBundle,
    authoritative_account_changes: bool,
    outbox_id: Option<&str>,
) -> Result<SaleBundle, sqlx::Error> {
    // Claim SQLite's write lock before reading the next receipt number, so
    // simultaneous payments cannot both allocate the same receipt.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    // An IPC response can be lost after SQLite commits. Replaying the same
    // durable outbox identity must return the already-allocated receipt rather
    // than inserting a second sale or decrementing stock twice.
    if let Some(outbox_id) = outbox_id.filter(|value| !value.trim().is_empty()) {
        let existing: Option<(String, String, String)> = sqlx::query_as(
            "SELECT table_name, operation, data FROM _offline_queue WHERE id = ? LIMIT 1",
        )
        .bind(outbox_id)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some((table_name, operation, data)) = existing {
            if table_name != "sale_bundle" || operation != "saleBundle" {
                return Err(sqlx::Error::Protocol(
                    "Sale outbox id is already used by another operation".into(),
                ));
            }
            let committed: SaleBundle = serde_json::from_str(&data)
                .map_err(|error| sqlx::Error::Protocol(error.to_string()))?;
            let mut normalized_request = bundle.clone();
            normalized_request.order.order_number = committed.order.order_number;
            normalized_request.order.receipt_key = committed.order.receipt_key.clone();
            normalized_request.audit.new_data = committed.audit.new_data.clone();
            normalized_request.server_data_epoch = committed.server_data_epoch.clone();
            let request_json = serde_json::to_value(&normalized_request)
                .map_err(|error| sqlx::Error::Protocol(error.to_string()))?;
            let committed_json = serde_json::to_value(&committed)
                .map_err(|error| sqlx::Error::Protocol(error.to_string()))?;
            if request_json != committed_json {
                return Err(sqlx::Error::Protocol(
                    "Sale outbox idempotency conflict".into(),
                ));
            }
            let persisted: Option<(String, String)> = sqlx::query_as(
                "SELECT o.receiptKey, p.id
                 FROM orders o JOIN payments p ON p.orderId = o.id
                 WHERE o.id = ? AND p.id = ? LIMIT 1",
            )
            .bind(&committed.order.id)
            .bind(&committed.payment.id)
            .fetch_optional(&mut *tx)
            .await?;
            if persisted.as_ref().map(|row| row.0.as_str())
                != Some(committed.order.receipt_key.as_str())
            {
                return Err(sqlx::Error::Protocol(
                    "Sale outbox exists without its committed receipt".into(),
                ));
            }
            tx.commit().await?;
            return Ok(committed);
        }
    }
    if outbox_id.is_none() && sqlite_bundle_already_committed(&mut tx, bundle).await? {
        tx.commit().await?;
        return Ok(bundle.clone());
    }
    let mut committed = bundle.clone();
    if outbox_id.is_some_and(|value| !value.trim().is_empty()) {
        committed.server_data_epoch = sqlx::query_scalar(
            "SELECT COALESCE((SELECT value FROM settings
                              WHERE key = 'server_data_epoch_seen' LIMIT 1), '')",
        )
        .fetch_one(&mut *tx)
        .await?;
        committed.server_data_epoch = committed.server_data_epoch.trim().to_string();
    }
    allocate_local_receipt(&mut tx, &mut committed.order).await?;
    prepare_sale_account_changes(&mut committed)?;
    validate_sqlite_reversal(&mut tx, &committed).await?;
    committed.audit.new_data = serde_json::json!({
        "orderNumber": committed.order.order_number,
        "total": committed.order.total,
    })
    .to_string();
    let o = &committed.order;
    sqlx::query(
        "INSERT INTO orders (id, shiftId, customerId, employeeId, orderNumber, receiptKey, type, status, originalOrderId, subtotal, discountId, discountAmount, taxTotal, total, tillNumber, notes, paymentMethod, amountTendered, createdAt, completedAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(&o.id).bind(&o.shift_id).bind(&o.customer_id).bind(&o.employee_id)
    .bind(o.order_number).bind(&o.receipt_key).bind(&o.order_type).bind(&o.status).bind(&o.original_order_id)
    .bind(o.subtotal).bind(&o.discount_id).bind(o.discount_amount).bind(o.tax_total)
    .bind(o.total).bind(&o.till_number).bind(&o.notes).bind(&o.payment_method)
    .bind(o.amount_tendered).bind(&o.created_at).bind(&o.completed_at).bind(&o.updated_at)
    .execute(&mut *tx).await?;

    for l in &committed.lines {
        sqlx::query(
            "INSERT INTO order_lines (id, orderId, productId, productName, quantity, unitPrice, costPrice, discountId, discountAmount, taxRate, taxAmount, lineTotal, isPriceOverride, originalPrice, notes, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(&l.id).bind(&l.order_id).bind(&l.product_id).bind(&l.product_name)
        .bind(l.quantity).bind(l.unit_price).bind(l.cost_price).bind(&l.discount_id)
        .bind(l.discount_amount).bind(l.tax_rate).bind(l.tax_amount).bind(l.line_total)
        .bind(if l.is_price_override { 1 } else { 0 }).bind(l.original_price)
        .bind(&l.notes).bind(&l.updated_at).execute(&mut *tx).await?;
    }

    let p = &committed.payment;
    sqlx::query(
        "INSERT INTO payments (id, orderId, method, amount, cashAmount, cardAmount, loyaltyAmount, accountAmount, reference, changeGiven, createdAt, updatedAt, tipsAmount, serviceChargeAmount, cashbackAmount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(&p.id).bind(&p.order_id).bind(&p.method).bind(p.amount).bind(p.cash_amount)
    .bind(p.card_amount).bind(p.loyalty_amount).bind(p.account_amount)
    .bind(&p.reference).bind(p.change_given).bind(&p.created_at)
    .bind(&p.updated_at).bind(p.tips_amount).bind(p.service_charge_amount).bind(p.cashback_amount)
    .execute(&mut *tx).await?;

    for s in &committed.stock_changes {
        sqlx::query("UPDATE products SET stockLevel = stockLevel + ?, updatedAt = ? WHERE id = ?")
            .bind(s.delta)
            .bind(&o.updated_at)
            .bind(&s.product_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "INSERT INTO inventory_logs (id, productId, quantityChange, type, referenceId, employeeId, notes, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(&s.log_id).bind(&s.product_id).bind(s.delta).bind(&s.movement_type).bind(&o.id).bind(&s.employee_id)
        .bind(&s.notes).bind(&o.completed_at).bind(&o.updated_at).execute(&mut *tx).await?;
    }

    for change in &committed.loyalty_changes {
        let result = if change.points_change < 0 && change.reason == "redeemed" {
            sqlx::query("UPDATE customers SET loyaltyPoints = loyaltyPoints + ?, updatedAt = ? WHERE id = ? AND loyaltyPoints >= ?")
                .bind(change.points_change).bind(&o.updated_at).bind(&change.customer_id).bind(-change.points_change)
                .execute(&mut *tx).await?
        } else {
            sqlx::query("UPDATE customers SET loyaltyPoints = loyaltyPoints + ?, updatedAt = ? WHERE id = ?")
                .bind(change.points_change).bind(&o.updated_at).bind(&change.customer_id)
                .execute(&mut *tx).await?
        };
        if result.rows_affected() != 1 {
            return Err(sqlx::Error::Protocol(
                "Customer loyalty balance changed; refresh and try again".into(),
            ));
        }
        sqlx::query("INSERT INTO loyalty_logs (id, customerId, orderId, pointsChange, reason, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .bind(&change.id).bind(&change.customer_id).bind(&change.order_id).bind(change.points_change)
            .bind(&change.reason).bind(&change.created_at).bind(&o.updated_at).execute(&mut *tx).await?;
    }

    for change in &mut committed.account_changes {
        if authoritative_account_changes {
            apply_authoritative_sqlite_account_change(&mut tx, change).await?;
        } else {
            apply_sqlite_account_change(&mut tx, change).await?;
        }
    }

    let a = &committed.audit;
    sqlx::query(
        "INSERT INTO audit_logs (id, employeeId, action, entityType, entityId, oldData, newData, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(&a.id).bind(&a.employee_id).bind(&a.action).bind(&a.entity_type).bind(&a.entity_id)
    .bind(&a.old_data).bind(&a.new_data).bind(&a.created_at).bind(&o.updated_at)
    .execute(&mut *tx).await?;
    if let (Some(id), Some(status)) = (
        &bundle.original_order_to_update,
        &bundle.original_status_update,
    ) {
        sqlx::query("UPDATE orders SET status = ?, updatedAt = ? WHERE id = ?")
            .bind(status)
            .bind(&o.updated_at)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }

    if let Some(outbox_id) = outbox_id.filter(|value| !value.trim().is_empty()) {
        // Serialize only after receipt allocation/account normalization. This
        // exact immutable bundle is what commit_mysql_sale must receive.
        let data = serde_json::to_string(&committed)
            .map_err(|error| sqlx::Error::Protocol(error.to_string()))?;
        sqlx::query(
            "INSERT INTO _offline_queue (id, table_name, operation, data, id_key, created_at)
             VALUES (?, 'sale_bundle', 'saleBundle', ?, 'id', ?)",
        )
        .bind(outbox_id)
        .bind(data)
        .bind(utc_stamp())
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(committed)
}

#[cfg_attr(not(test), allow(dead_code))]
async fn insert_sqlite_bundle(
    pool: &SqlitePool,
    bundle: &SaleBundle,
) -> Result<SaleBundle, sqlx::Error> {
    insert_sqlite_bundle_with_account_authority(pool, bundle, false, None).await
}

async fn insert_sqlite_bundle_with_outbox(
    pool: &SqlitePool,
    bundle: &SaleBundle,
    outbox_id: Option<&str>,
) -> Result<SaleBundle, sqlx::Error> {
    insert_sqlite_bundle_with_account_authority(pool, bundle, false, outbox_id).await
}

fn apply_server_financial_stamp(bundle: &mut SaleBundle, stamp: &str) {
    bundle.order.created_at = stamp.into();
    bundle.order.completed_at = stamp.into();
    bundle.order.updated_at = stamp.into();
    for line in &mut bundle.lines {
        line.updated_at = stamp.into();
    }
    bundle.payment.created_at = stamp.into();
    bundle.payment.updated_at = stamp.into();
    for change in &mut bundle.loyalty_changes {
        change.created_at = stamp.into();
    }
    for change in &mut bundle.account_changes {
        change.created_at = stamp.into();
        change.updated_at = stamp.into();
    }
    bundle.audit.created_at = stamp.into();
}

fn canonical_report_epoch(value: &str) -> Result<String, sqlx::Error> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(String::new());
    }
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|stamp| {
            stamp
                .with_timezone(&chrono::Utc)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        })
        .map_err(|error| {
            account_protocol_error(format!(
                "REPORT_EPOCH_INVALID: report epoch '{value}' is not RFC3339: {error}"
            ))
        })
}

fn exclusive_report_cutoff(server_tick: &str) -> Result<String, sqlx::Error> {
    let tick = chrono::DateTime::parse_from_rfc3339(server_tick.trim()).map_err(|error| {
        account_protocol_error(format!(
            "REPORT_CUTOFF_INVALID: server tick '{server_tick}' is not RFC3339: {error}"
        ))
    })?;
    tick.with_timezone(&chrono::Utc)
        .checked_add_signed(chrono::Duration::milliseconds(1))
        .map(|cutoff| cutoff.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .ok_or_else(|| account_protocol_error("REPORT_CUTOFF_INVALID: server tick overflow"))
}

fn sync_conflict(message: impl Into<String>) -> sqlx::Error {
    account_protocol_error(format!("SYNC_CONFLICT: {}", message.into()))
}

fn validate_replay_server_timestamp(
    value: &str,
    financial_stamp: &str,
    record: &str,
) -> Result<(), sqlx::Error> {
    let value_stamp = chrono::DateTime::parse_from_rfc3339(value.trim())
        .map_err(|_| sync_conflict(format!("{record} has an invalid server update timestamp")))?;
    let financial_stamp = chrono::DateTime::parse_from_rfc3339(financial_stamp.trim())
        .map_err(|_| sync_conflict("the replayed order has an invalid financial timestamp"))?;
    if value_stamp < financial_stamp {
        return Err(sync_conflict(format!(
            "{record} has a server update timestamp before the financial timestamp"
        )));
    }
    Ok(())
}

fn replay_status_is_compatible(requested: &str, authoritative: &str) -> bool {
    requested == authoritative
        || matches!(
            (requested, authoritative),
            ("completed", "partially_refunded" | "refunded" | "voided")
                | ("partially_refunded", "refunded")
        )
}

fn validate_online_financial_intent_epoch(
    intent_epoch: &str,
    remote_epoch: &str,
) -> Result<(), sqlx::Error> {
    let intent_epoch = intent_epoch.trim();
    let remote_epoch = remote_epoch.trim();
    if intent_epoch == remote_epoch {
        return Ok(());
    }
    let detail = if intent_epoch.is_empty() && !remote_epoch.is_empty() {
        "the pending intent predates epoch stamping and cannot be assigned to this MariaDB dataset"
            .to_string()
    } else {
        format!(
            "pending intent epoch '{}' does not match MariaDB epoch '{}'",
            intent_epoch, remote_epoch
        )
    };
    Err(account_protocol_error(format!(
        "{ONLINE_FINANCIAL_INTENT_EPOCH_CODE}: {detail}"
    )))
}

async fn assert_mysql_server_data_epoch(
    tx: &mut sqlx::Transaction<'_, sqlx::MySql>,
    intent_epoch: &str,
) -> Result<(), sqlx::Error> {
    // The caller already holds close-barrier then restore-gate. Lock the epoch
    // setting in that same transaction so dataset replacement cannot race the
    // validation and the subsequent replay.
    let remote_epoch: Option<String> = sqlx::query_scalar(
        "SELECT CAST(value AS CHAR) FROM settings
         WHERE `key` = 'server_data_epoch' LIMIT 1 FOR UPDATE",
    )
    .fetch_optional(&mut **tx)
    .await?;
    validate_online_financial_intent_epoch(intent_epoch, remote_epoch.as_deref().unwrap_or(""))
}

fn mysql_order_from_replay_row(row: &MySqlRow) -> Result<OrderRecord, sqlx::Error> {
    Ok(OrderRecord {
        id: row.try_get("id")?,
        shift_id: row.try_get("shiftId")?,
        customer_id: row.try_get("customerId")?,
        employee_id: row.try_get("employeeId")?,
        order_number: row.try_get("orderNumber")?,
        receipt_key: row.try_get("receiptKey")?,
        order_type: row.try_get("type")?,
        status: row.try_get("status")?,
        original_order_id: row.try_get("originalOrderId")?,
        subtotal: row.try_get("subtotal")?,
        discount_id: row.try_get("discountId")?,
        discount_amount: row.try_get("discountAmount")?,
        tax_total: row.try_get("taxTotal")?,
        total: row.try_get("total")?,
        till_number: row.try_get("tillNumber")?,
        notes: row.try_get("notes")?,
        payment_method: row.try_get("paymentMethod")?,
        amount_tendered: row.try_get("amountTendered")?,
        created_at: row.try_get("createdAt")?,
        completed_at: row.try_get("completedAt")?,
        updated_at: row.try_get("updatedAt")?,
    })
}

fn mysql_order_line_from_replay_row(row: &MySqlRow) -> Result<OrderLineRecord, sqlx::Error> {
    Ok(OrderLineRecord {
        id: row.try_get("id")?,
        order_id: row.try_get("orderId")?,
        product_id: row.try_get("productId")?,
        product_name: row.try_get("productName")?,
        quantity: row.try_get("quantity")?,
        unit_price: row.try_get("unitPrice")?,
        cost_price: row.try_get("costPrice")?,
        discount_id: row.try_get("discountId")?,
        discount_amount: row.try_get("discountAmount")?,
        tax_rate: row.try_get("taxRate")?,
        tax_amount: row.try_get("taxAmount")?,
        line_total: row.try_get("lineTotal")?,
        is_price_override: row.try_get::<i64, _>("isPriceOverride")? != 0,
        original_price: row.try_get("originalPrice")?,
        notes: row.try_get("notes")?,
        updated_at: row.try_get("updatedAt")?,
    })
}

fn mysql_payment_from_replay_row(row: &MySqlRow) -> Result<PaymentRecord, sqlx::Error> {
    Ok(PaymentRecord {
        id: row.try_get("id")?,
        order_id: row.try_get("orderId")?,
        method: row.try_get("method")?,
        amount: row.try_get("amount")?,
        cash_amount: row.try_get("cashAmount")?,
        card_amount: row.try_get("cardAmount")?,
        tips_amount: row.try_get("tipsAmount")?,
        service_charge_amount: row.try_get("serviceChargeAmount")?,
        cashback_amount: row.try_get("cashbackAmount")?,
        loyalty_amount: row.try_get("loyaltyAmount")?,
        account_amount: row.try_get("accountAmount")?,
        reference: row.try_get("reference")?,
        change_given: row.try_get("changeGiven")?,
        created_at: row.try_get("createdAt")?,
        updated_at: row.try_get("updatedAt")?,
    })
}

fn mysql_stock_change_from_replay_row(row: &MySqlRow) -> Result<StockChange, sqlx::Error> {
    Ok(StockChange {
        product_id: row.try_get("productId")?,
        delta: row.try_get("delta")?,
        log_id: row.try_get("logId")?,
        employee_id: row.try_get("employeeId")?,
        notes: row.try_get("notes")?,
        movement_type: row.try_get("movementType")?,
    })
}

fn mysql_loyalty_change_from_replay_row(row: &MySqlRow) -> Result<LoyaltyChange, sqlx::Error> {
    Ok(LoyaltyChange {
        id: row.try_get("id")?,
        customer_id: row.try_get("customerId")?,
        order_id: row.try_get("orderId")?,
        points_change: row.try_get("pointsChange")?,
        reason: row.try_get("reason")?,
        created_at: row.try_get("createdAt")?,
    })
}

fn mysql_audit_from_replay_row(row: &MySqlRow) -> Result<AuditRecord, sqlx::Error> {
    Ok(AuditRecord {
        id: row.try_get("id")?,
        employee_id: row.try_get("employeeId")?,
        action: row.try_get("action")?,
        entity_type: row.try_get("entityType")?,
        entity_id: row.try_get("entityId")?,
        old_data: row.try_get("oldData")?,
        new_data: row.try_get("newData")?,
        created_at: row.try_get("createdAt")?,
    })
}

async fn load_and_validate_existing_mysql_bundle(
    tx: &mut sqlx::Transaction<'_, sqlx::MySql>,
    requested: &SaleBundle,
) -> Result<SaleBundle, sqlx::Error> {
    let order_row = sqlx::query(
        "SELECT CAST(id AS CHAR) AS id, CAST(COALESCE(shiftId, '') AS CHAR) AS shiftId,
                CAST(COALESCE(customerId, '') AS CHAR) AS customerId,
                CAST(COALESCE(employeeId, '') AS CHAR) AS employeeId,
                CAST(COALESCE(orderNumber, 0) AS SIGNED) AS orderNumber,
                CAST(COALESCE(receiptKey, '') AS CHAR) AS receiptKey,
                CAST(COALESCE(type, '') AS CHAR) AS type,
                CAST(COALESCE(status, '') AS CHAR) AS status,
                CAST(COALESCE(originalOrderId, '') AS CHAR) AS originalOrderId,
                CAST(COALESCE(subtotal, 0) AS SIGNED) AS subtotal,
                CAST(COALESCE(discountId, '') AS CHAR) AS discountId,
                CAST(COALESCE(discountAmount, 0) AS SIGNED) AS discountAmount,
                CAST(COALESCE(taxTotal, 0) AS SIGNED) AS taxTotal,
                CAST(COALESCE(total, 0) AS SIGNED) AS total,
                CAST(COALESCE(tillNumber, '') AS CHAR) AS tillNumber,
                CAST(COALESCE(notes, '') AS CHAR) AS notes,
                CAST(COALESCE(paymentMethod, '') AS CHAR) AS paymentMethod,
                CAST(COALESCE(amountTendered, 0) AS SIGNED) AS amountTendered,
                CAST(COALESCE(createdAt, '') AS CHAR) AS createdAt,
                CAST(COALESCE(completedAt, '') AS CHAR) AS completedAt,
                CAST(COALESCE(updatedAt, '') AS CHAR) AS updatedAt
         FROM orders WHERE id = ? LIMIT 1 FOR UPDATE",
    )
    .bind(&requested.order.id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| sync_conflict("the replayed order disappeared"))?;
    let remote_order = mysql_order_from_replay_row(&order_row)?;
    if remote_order.created_at != remote_order.completed_at {
        return Err(sync_conflict(
            "order has noncanonical financial creation timestamps",
        ));
    }
    validate_replay_server_timestamp(
        &remote_order.updated_at,
        &remote_order.completed_at,
        "order",
    )?;
    if !replay_status_is_compatible(&requested.order.status, &remote_order.status) {
        return Err(sync_conflict(
            "order status differs from the replay request",
        ));
    }
    let mut expected_order = requested.order.clone();
    expected_order.status = remote_order.status.clone();
    expected_order.created_at = remote_order.created_at.clone();
    expected_order.completed_at = remote_order.completed_at.clone();
    expected_order.updated_at = remote_order.updated_at.clone();
    if expected_order != remote_order {
        return Err(sync_conflict(
            "order id exists but its canonical order fields differ",
        ));
    }

    let line_rows = sqlx::query(
        "SELECT CAST(id AS CHAR) AS id, CAST(COALESCE(orderId, '') AS CHAR) AS orderId,
                CAST(COALESCE(productId, '') AS CHAR) AS productId,
                CAST(COALESCE(productName, '') AS CHAR) AS productName,
                CAST(COALESCE(quantity, 0) AS SIGNED) AS quantity,
                CAST(COALESCE(unitPrice, 0) AS SIGNED) AS unitPrice,
                CAST(COALESCE(costPrice, 0) AS SIGNED) AS costPrice,
                CAST(COALESCE(discountId, '') AS CHAR) AS discountId,
                CAST(COALESCE(discountAmount, 0) AS SIGNED) AS discountAmount,
                COALESCE(taxRate, 0) AS taxRate,
                CAST(COALESCE(taxAmount, 0) AS SIGNED) AS taxAmount,
                CAST(COALESCE(lineTotal, 0) AS SIGNED) AS lineTotal,
                CAST(COALESCE(isPriceOverride, 0) AS SIGNED) AS isPriceOverride,
                CAST(COALESCE(originalPrice, 0) AS SIGNED) AS originalPrice,
                CAST(COALESCE(notes, '') AS CHAR) AS notes,
                CAST(COALESCE(updatedAt, '') AS CHAR) AS updatedAt
         FROM order_lines WHERE orderId = ? ORDER BY id FOR UPDATE",
    )
    .bind(&requested.order.id)
    .fetch_all(&mut **tx)
    .await?;
    if line_rows.len() != requested.lines.len() {
        return Err(sync_conflict(
            "order line set is incomplete or has extra rows",
        ));
    }
    let mut remote_lines = HashMap::new();
    for row in &line_rows {
        let line = mysql_order_line_from_replay_row(row)?;
        if remote_lines.insert(line.id.clone(), line).is_some() {
            return Err(sync_conflict("order line ids are not unique"));
        }
    }
    let mut authoritative_lines = Vec::with_capacity(requested.lines.len());
    for requested_line in &requested.lines {
        let remote_line = remote_lines
            .remove(&requested_line.id)
            .ok_or_else(|| sync_conflict("an expected order line is missing"))?;
        validate_replay_server_timestamp(
            &remote_line.updated_at,
            &remote_order.completed_at,
            "an order line",
        )?;
        let mut expected_line = requested_line.clone();
        expected_line.updated_at = remote_line.updated_at.clone();
        if expected_line != remote_line {
            return Err(sync_conflict(
                "an order line differs from the replay request",
            ));
        }
        authoritative_lines.push(remote_line);
    }

    let payment_rows = sqlx::query(
        "SELECT CAST(id AS CHAR) AS id, CAST(COALESCE(orderId, '') AS CHAR) AS orderId,
                CAST(COALESCE(method, '') AS CHAR) AS method,
                CAST(COALESCE(amount, 0) AS SIGNED) AS amount,
                CAST(COALESCE(cashAmount, 0) AS SIGNED) AS cashAmount,
                CAST(COALESCE(cardAmount, 0) AS SIGNED) AS cardAmount,
                CAST(COALESCE(tipsAmount, 0) AS SIGNED) AS tipsAmount,
                CAST(COALESCE(serviceChargeAmount, 0) AS SIGNED) AS serviceChargeAmount,
                CAST(COALESCE(cashbackAmount, 0) AS SIGNED) AS cashbackAmount,
                CAST(COALESCE(loyaltyAmount, 0) AS SIGNED) AS loyaltyAmount,
                CAST(COALESCE(accountAmount, 0) AS SIGNED) AS accountAmount,
                CAST(COALESCE(reference, '') AS CHAR) AS reference,
                CAST(COALESCE(changeGiven, 0) AS SIGNED) AS changeGiven,
                CAST(COALESCE(createdAt, '') AS CHAR) AS createdAt,
                CAST(COALESCE(updatedAt, '') AS CHAR) AS updatedAt
         FROM payments WHERE orderId = ? ORDER BY id FOR UPDATE",
    )
    .bind(&requested.order.id)
    .fetch_all(&mut **tx)
    .await?;
    if payment_rows.len() != 1 {
        return Err(sync_conflict(
            "existing order must have exactly one canonical payment",
        ));
    }
    let remote_payment = mysql_payment_from_replay_row(&payment_rows[0])?;
    if remote_payment.created_at != remote_order.completed_at {
        return Err(sync_conflict(
            "payment has a noncanonical financial creation timestamp",
        ));
    }
    validate_replay_server_timestamp(
        &remote_payment.updated_at,
        &remote_order.completed_at,
        "payment",
    )?;
    let mut expected_payment = requested.payment.clone();
    expected_payment.created_at = remote_payment.created_at.clone();
    expected_payment.updated_at = remote_payment.updated_at.clone();
    if expected_payment != remote_payment {
        return Err(sync_conflict("payment differs from the replay request"));
    }

    let stock_rows = sqlx::query(
        "SELECT CAST(COALESCE(productId, '') AS CHAR) AS productId,
                CAST(COALESCE(quantityChange, 0) AS SIGNED) AS delta,
                CAST(id AS CHAR) AS logId,
                CAST(COALESCE(employeeId, '') AS CHAR) AS employeeId,
                CAST(COALESCE(notes, '') AS CHAR) AS notes,
                CAST(COALESCE(type, '') AS CHAR) AS movementType,
                CAST(COALESCE(createdAt, '') AS CHAR) AS createdAt,
                CAST(COALESCE(updatedAt, '') AS CHAR) AS updatedAt
         FROM inventory_logs WHERE referenceId = ? ORDER BY id FOR UPDATE",
    )
    .bind(&requested.order.id)
    .fetch_all(&mut **tx)
    .await?;
    if stock_rows.len() != requested.stock_changes.len() {
        return Err(sync_conflict(
            "stock movement set is incomplete or has extra rows",
        ));
    }
    let mut remote_stock = HashMap::new();
    for row in &stock_rows {
        let created_at: String = row.try_get("createdAt")?;
        let updated_at: String = row.try_get("updatedAt")?;
        if created_at != remote_order.completed_at {
            return Err(sync_conflict(
                "a stock movement has a noncanonical financial creation timestamp",
            ));
        }
        validate_replay_server_timestamp(
            &updated_at,
            &remote_order.completed_at,
            "a stock movement",
        )?;
        let change = mysql_stock_change_from_replay_row(row)?;
        if remote_stock.insert(change.log_id.clone(), change).is_some() {
            return Err(sync_conflict("stock movement ids are not unique"));
        }
    }
    let mut authoritative_stock = Vec::with_capacity(requested.stock_changes.len());
    for requested_change in &requested.stock_changes {
        let remote_change = remote_stock
            .remove(&requested_change.log_id)
            .ok_or_else(|| sync_conflict("an expected stock movement is missing"))?;
        if requested_change != &remote_change {
            return Err(sync_conflict(
                "a stock movement differs from the replay request",
            ));
        }
        authoritative_stock.push(remote_change);
    }

    let loyalty_rows = sqlx::query(
        "SELECT CAST(id AS CHAR) AS id,
                CAST(COALESCE(customerId, '') AS CHAR) AS customerId,
                CAST(COALESCE(orderId, '') AS CHAR) AS orderId,
                CAST(COALESCE(pointsChange, 0) AS SIGNED) AS pointsChange,
                CAST(COALESCE(reason, '') AS CHAR) AS reason,
                CAST(COALESCE(createdAt, '') AS CHAR) AS createdAt,
                CAST(COALESCE(updatedAt, '') AS CHAR) AS updatedAt
         FROM loyalty_logs WHERE orderId = ? ORDER BY id FOR UPDATE",
    )
    .bind(&requested.order.id)
    .fetch_all(&mut **tx)
    .await?;
    if loyalty_rows.len() != requested.loyalty_changes.len() {
        return Err(sync_conflict(
            "loyalty movement set is incomplete or has extra rows",
        ));
    }
    let mut remote_loyalty = HashMap::new();
    for row in &loyalty_rows {
        let updated_at: String = row.try_get("updatedAt")?;
        let change = mysql_loyalty_change_from_replay_row(row)?;
        if change.created_at != remote_order.completed_at {
            return Err(sync_conflict(
                "a loyalty movement has a noncanonical creation timestamp",
            ));
        }
        validate_replay_server_timestamp(
            &updated_at,
            &remote_order.completed_at,
            "a loyalty movement",
        )?;
        if remote_loyalty.insert(change.id.clone(), change).is_some() {
            return Err(sync_conflict("loyalty movement ids are not unique"));
        }
    }
    let mut authoritative_loyalty = Vec::with_capacity(requested.loyalty_changes.len());
    for requested_change in &requested.loyalty_changes {
        let remote_change = remote_loyalty
            .remove(&requested_change.id)
            .ok_or_else(|| sync_conflict("an expected loyalty movement is missing"))?;
        let mut expected_change = requested_change.clone();
        expected_change.created_at = remote_change.created_at.clone();
        if expected_change != remote_change {
            return Err(sync_conflict(
                "a loyalty movement differs from the replay request",
            ));
        }
        authoritative_loyalty.push(remote_change);
    }

    let account_rows = sqlx::query(
        "SELECT CAST(id AS CHAR) AS id, CAST(accountId AS CHAR) AS accountId,
                CAST(customerId AS CHAR) AS customerId,
                CAST(COALESCE(orderId, '') AS CHAR) AS orderId,
                CAST(entryType AS CHAR) AS entryType,
                CAST(amountPence AS SIGNED) AS amountPence,
                CAST(COALESCE(paymentMethod, '') AS CHAR) AS paymentMethod,
                CAST(COALESCE(tipsAmount, 0) AS SIGNED) AS tipsAmount,
                CAST(COALESCE(serviceChargeAmount, 0) AS SIGNED) AS serviceChargeAmount,
                CAST(COALESCE(cashbackAmount, 0) AS SIGNED) AS cashbackAmount,
                CAST(COALESCE(reference, '') AS CHAR) AS reference,
                CAST(COALESCE(description, '') AS CHAR) AS description,
                CAST(COALESCE(receiptNumber, 0) AS SIGNED) AS receiptNumber,
                CAST(COALESCE(receiptKey, '') AS CHAR) AS receiptKey,
                CAST(COALESCE(employeeId, '') AS CHAR) AS employeeId,
                CAST(COALESCE(tillNumber, '') AS CHAR) AS tillNumber,
                CAST(COALESCE(shiftId, '') AS CHAR) AS shiftId,
                CAST(idempotencyKey AS CHAR) AS idempotencyKey,
                CAST(COALESCE(reversesEntryId, '') AS CHAR) AS reversesEntryId,
                CAST(balanceAfterPence AS SIGNED) AS balanceAfterPence,
                CAST(COALESCE(createdAt, '') AS CHAR) AS createdAt,
                CAST(COALESCE(updatedAt, '') AS CHAR) AS updatedAt
         FROM customer_account_entries WHERE orderId = ? ORDER BY id FOR UPDATE",
    )
    .bind(&requested.order.id)
    .fetch_all(&mut **tx)
    .await?;
    if account_rows.len() != requested.account_changes.len() {
        return Err(sync_conflict(
            "customer account entry set is incomplete or has extra rows",
        ));
    }
    let mut remote_account_entries = account_rows
        .iter()
        .map(mysql_account_entry_from_row)
        .collect::<Result<Vec<_>, _>>()?;
    let mut authoritative_account_changes = Vec::with_capacity(requested.account_changes.len());
    for requested_change in &requested.account_changes {
        let position = remote_account_entries.iter().position(|entry| {
            entry.id == requested_change.id
                || entry.idempotency_key == requested_change.idempotency_key
        });
        let entry = position
            .map(|index| remote_account_entries.remove(index))
            .ok_or_else(|| sync_conflict("an expected customer account entry is missing"))?;
        if !entry_matches_change(&entry, requested_change) {
            return Err(sync_conflict(
                "a customer account entry differs from the replay request",
            ));
        }
        if entry.created_at != remote_order.completed_at {
            return Err(sync_conflict(
                "a customer account entry has a noncanonical financial creation timestamp",
            ));
        }
        validate_replay_server_timestamp(
            &entry.updated_at,
            &remote_order.completed_at,
            "a customer account entry",
        )?;
        let mut change = requested_change.clone();
        change.id = entry.id;
        change.balance_after_pence = entry.balance_after_pence;
        change.created_at = entry.created_at;
        change.updated_at = entry.updated_at;
        authoritative_account_changes.push(change);
    }

    let audit_row = sqlx::query(
        "SELECT CAST(id AS CHAR) AS id,
                CAST(COALESCE(employeeId, '') AS CHAR) AS employeeId,
                CAST(COALESCE(action, '') AS CHAR) AS action,
                CAST(COALESCE(entityType, '') AS CHAR) AS entityType,
                CAST(COALESCE(entityId, '') AS CHAR) AS entityId,
                CAST(COALESCE(oldData, '') AS CHAR) AS oldData,
                CAST(COALESCE(newData, '') AS CHAR) AS newData,
                CAST(COALESCE(createdAt, '') AS CHAR) AS createdAt,
                CAST(COALESCE(updatedAt, '') AS CHAR) AS updatedAt
         FROM audit_logs WHERE id = ? LIMIT 1 FOR UPDATE",
    )
    .bind(&requested.audit.id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| sync_conflict("existing order is missing its audit record"))?;
    let remote_audit = mysql_audit_from_replay_row(&audit_row)?;
    let audit_updated_at: String = audit_row.try_get("updatedAt")?;
    if remote_audit.created_at != remote_order.completed_at {
        return Err(sync_conflict(
            "audit record has a noncanonical financial creation timestamp",
        ));
    }
    validate_replay_server_timestamp(
        &audit_updated_at,
        &remote_order.completed_at,
        "audit record",
    )?;
    let mut expected_audit = requested.audit.clone();
    expected_audit.created_at = remote_audit.created_at.clone();
    if expected_audit != remote_audit {
        return Err(sync_conflict(
            "audit record differs from the replay request",
        ));
    }

    let mut authoritative_original_status = requested.original_status_update.clone();
    if let (Some(original_id), Some(expected_status)) = (
        requested.original_order_to_update.as_deref(),
        requested.original_status_update.as_deref(),
    ) {
        let remote_status: Option<String> = sqlx::query_scalar(
            "SELECT CAST(COALESCE(status, '') AS CHAR) FROM orders
             WHERE id = ? LIMIT 1 FOR UPDATE",
        )
        .bind(original_id)
        .fetch_optional(&mut **tx)
        .await?;
        let remote_status =
            remote_status.ok_or_else(|| sync_conflict("the reversal target order is missing"))?;
        if !replay_status_is_compatible(expected_status, &remote_status) {
            return Err(sync_conflict(
                "the reversal target status differs from the replay request",
            ));
        }
        authoritative_original_status = Some(remote_status);
    }

    let mut authoritative = requested.clone();
    authoritative.order = remote_order;
    authoritative.lines = authoritative_lines;
    authoritative.payment = remote_payment;
    authoritative.stock_changes = authoritative_stock;
    authoritative.loyalty_changes = authoritative_loyalty;
    authoritative.account_changes = authoritative_account_changes;
    authoritative.audit = remote_audit;
    authoritative.original_status_update = authoritative_original_status;
    Ok(authoritative)
}

async fn insert_mysql_bundle(
    pool: &MySqlPool,
    bundle: &SaleBundle,
) -> Result<SaleBundle, sqlx::Error> {
    insert_mysql_bundle_with_intent_epoch(pool, bundle, None).await
}

const MYSQL_TRANSACTION_RETRY_ATTEMPTS: usize = 3;

fn mysql_transaction_contention_error(code: Option<&str>, message: &str) -> bool {
    if code == Some("40001") {
        return true;
    }
    let message = message.to_ascii_lowercase();
    message.contains("record has changed since last read")
        || message.contains("deadlock found when trying to get lock")
        || message.contains("lock wait timeout exceeded")
}

fn is_retryable_mysql_transaction_error(error: &sqlx::Error) -> bool {
    let sqlx::Error::Database(database_error) = error else {
        return false;
    };
    let code = database_error.code();
    mysql_transaction_contention_error(code.as_deref(), database_error.message())
}

async fn insert_mysql_bundle_with_intent_epoch(
    pool: &MySqlPool,
    bundle: &SaleBundle,
    intent_epoch: Option<&str>,
) -> Result<SaleBundle, sqlx::Error> {
    // Guard installation is schema maintenance, not a transaction retry step.
    // Verify/install it once so lock contention never multiplies metadata and
    // DDL work for a Pay Later checkout.
    if !bundle.account_changes.is_empty() {
        ensure_mysql_account_ledger_guards(pool).await?;
    }
    for attempt in 0..MYSQL_TRANSACTION_RETRY_ATTEMPTS {
        match insert_mysql_bundle_once_with_intent_epoch(pool, bundle, intent_epoch).await {
            Ok(committed) => return Ok(committed),
            Err(error)
                if attempt + 1 < MYSQL_TRANSACTION_RETRY_ATTEMPTS
                    && is_retryable_mysql_transaction_error(&error) =>
            {
                continue;
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!("MariaDB transaction retry loop always returns")
}

async fn insert_mysql_bundle_once_with_intent_epoch(
    pool: &MySqlPool,
    bundle: &SaleBundle,
    intent_epoch: Option<&str>,
) -> Result<SaleBundle, sqlx::Error> {
    let mut tx = pool.begin().await?;
    // This takes the close-barrier lock before the restore gate or any
    // customer row. The captured epoch therefore cannot change until commit.
    let current_epoch = assert_mysql_restore_writes_allowed(&mut tx).await?;
    let expected_server_epoch = intent_epoch.unwrap_or(&bundle.server_data_epoch);
    assert_mysql_server_data_epoch(&mut tx, expected_server_epoch).await?;
    let mut committed = bundle.clone();
    prepare_sale_account_changes(&mut committed)?;
    // A till can lose the network response after MariaDB committed the sale.
    // Treat only an exact canonical relational replay as success. Never repair
    // missing child rows here: stock, loyalty, and account side effects cannot
    // safely be inferred from a partial historical write.
    let existing_order: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM orders WHERE id = ? LIMIT 1")
            .bind(&committed.order.id)
            .fetch_optional(&mut *tx)
            .await?;
    if existing_order.is_some() {
        lock_mysql_bundle_customers(&mut tx, &committed).await?;
        let authoritative = load_and_validate_existing_mysql_bundle(&mut tx, &committed).await?;
        tx.commit().await?;
        return Ok(authoritative);
    }
    let expected_epoch = canonical_report_epoch(&committed.report_epoch)?;
    if expected_epoch != current_epoch {
        return Err(account_protocol_error(format!(
            "REPORT_EPOCH_STALE: expected report epoch '{}', current epoch '{}'",
            expected_epoch, current_epoch
        )));
    }
    committed.report_epoch = current_epoch;
    lock_mysql_bundle_customers(&mut tx, &committed).await?;
    let stamp: String =
        sqlx::query_scalar("SELECT DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ')")
            .fetch_one(&mut *tx)
            .await?;
    apply_server_financial_stamp(&mut committed, &stamp);
    prepare_sale_account_changes(&mut committed)?;
    validate_mysql_reversal(&mut tx, &committed).await?;
    let o = &committed.order;
    sqlx::query(
        "INSERT INTO orders (id, shiftId, customerId, employeeId, orderNumber, receiptKey, type, status, originalOrderId, subtotal, discountId, discountAmount, taxTotal, total, tillNumber, notes, paymentMethod, amountTendered, createdAt, completedAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(&o.id).bind(&o.shift_id).bind(&o.customer_id).bind(&o.employee_id)
    .bind(o.order_number).bind(&o.receipt_key).bind(&o.order_type).bind(&o.status).bind(&o.original_order_id)
    .bind(o.subtotal).bind(&o.discount_id).bind(o.discount_amount).bind(o.tax_total)
    .bind(o.total).bind(&o.till_number).bind(&o.notes).bind(&o.payment_method)
    .bind(o.amount_tendered).bind(&o.created_at).bind(&o.completed_at).bind(&o.updated_at)
    .execute(&mut *tx).await?;

    for l in &committed.lines {
        sqlx::query(
            "INSERT INTO order_lines (id, orderId, productId, productName, quantity, unitPrice, costPrice, discountId, discountAmount, taxRate, taxAmount, lineTotal, isPriceOverride, originalPrice, notes, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(&l.id).bind(&l.order_id).bind(&l.product_id).bind(&l.product_name)
        .bind(l.quantity).bind(l.unit_price).bind(l.cost_price).bind(&l.discount_id)
        .bind(l.discount_amount).bind(l.tax_rate).bind(l.tax_amount).bind(l.line_total)
        .bind(if l.is_price_override { 1 } else { 0 }).bind(l.original_price)
        .bind(&l.notes).bind(&l.updated_at).execute(&mut *tx).await?;
    }
    let p = &committed.payment;
    sqlx::query(
        "INSERT INTO payments (id, orderId, method, amount, cashAmount, cardAmount, loyaltyAmount, accountAmount, reference, changeGiven, createdAt, updatedAt, tipsAmount, serviceChargeAmount, cashbackAmount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(&p.id).bind(&p.order_id).bind(&p.method).bind(p.amount).bind(p.cash_amount)
    .bind(p.card_amount).bind(p.loyalty_amount).bind(p.account_amount)
    .bind(&p.reference).bind(p.change_given).bind(&p.created_at)
    .bind(&p.updated_at).bind(p.tips_amount).bind(p.service_charge_amount).bind(p.cashback_amount)
    .execute(&mut *tx).await?;

    for s in &committed.stock_changes {
        sqlx::query("UPDATE products SET stockLevel = stockLevel + ?, updatedAt = ? WHERE id = ?")
            .bind(s.delta)
            .bind(&stamp)
            .bind(&s.product_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "INSERT INTO inventory_logs (id, productId, quantityChange, type, referenceId, employeeId, notes, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(&s.log_id).bind(&s.product_id).bind(s.delta).bind(&s.movement_type).bind(&o.id).bind(&s.employee_id)
        .bind(&s.notes).bind(&o.completed_at).bind(&o.updated_at).execute(&mut *tx).await?;
    }
    for change in &committed.loyalty_changes {
        let result = if change.points_change < 0 && change.reason == "redeemed" {
            sqlx::query("UPDATE customers SET loyaltyPoints = loyaltyPoints + ?, updatedAt = ? WHERE id = ? AND loyaltyPoints >= ?")
            .bind(change.points_change).bind(&o.updated_at).bind(&change.customer_id).bind(-change.points_change)
                .execute(&mut *tx).await?
        } else {
            sqlx::query("UPDATE customers SET loyaltyPoints = loyaltyPoints + ?, updatedAt = ? WHERE id = ?")
            .bind(change.points_change).bind(&o.updated_at).bind(&change.customer_id)
                .execute(&mut *tx).await?
        };
        if result.rows_affected() != 1 {
            return Err(sqlx::Error::Protocol(
                "Customer loyalty balance changed; refresh and try again".into(),
            ));
        }
        sqlx::query("INSERT INTO loyalty_logs (id, customerId, orderId, pointsChange, reason, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .bind(&change.id).bind(&change.customer_id).bind(&change.order_id).bind(change.points_change)
            .bind(&change.reason).bind(&change.created_at).bind(&o.updated_at).execute(&mut *tx).await?;
    }
    let account_authority = if committed.account_changes.is_empty() {
        None
    } else {
        Some(grant_mysql_account_write_authority(&mut tx).await?)
    };
    for change in &mut committed.account_changes {
        apply_mysql_account_change(&mut tx, change, &o.updated_at).await?;
    }
    if let Some(authority) = account_authority {
        revoke_mysql_account_write_authority(&mut tx, &authority).await?;
    }
    let a = &committed.audit;
    sqlx::query(
        "INSERT INTO audit_logs (id, employeeId, action, entityType, entityId, oldData, newData, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(&a.id).bind(&a.employee_id).bind(&a.action).bind(&a.entity_type).bind(&a.entity_id)
    .bind(&a.old_data).bind(&a.new_data).bind(&a.created_at).bind(&o.updated_at)
    .execute(&mut *tx).await?;
    if let (Some(id), Some(status)) = (
        &committed.original_order_to_update,
        &committed.original_status_update,
    ) {
        sqlx::query("UPDATE orders SET status = ?, updatedAt = ? WHERE id = ?")
            .bind(status)
            .bind(&o.updated_at)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    // Timestamp-maintenance triggers may normalize `updatedAt` after each
    // insert. Return the rows MariaDB actually committed so a successful
    // first attempt and an idempotent replay produce the same bundle.
    let authoritative = load_and_validate_existing_mysql_bundle(&mut tx, &committed).await?;
    tx.commit().await?;
    Ok(authoritative)
}

async fn save_sqlite_customer_account_config(
    pool: &SqlitePool,
    input: &SaveCustomerAccountConfigInput,
) -> Result<CustomerAccountRecord, sqlx::Error> {
    if input.customer_id.trim().is_empty() || input.credit_limit_pence < 0 {
        return Err(account_protocol_error("Invalid customer account settings"));
    }
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let customer_exists: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM customers WHERE id = ? LIMIT 1")
            .bind(&input.customer_id)
            .fetch_optional(&mut *tx)
            .await?;
    if customer_exists.is_none() {
        return Err(account_protocol_error("Customer was not found"));
    }
    let stamp = utc_stamp();
    sqlx::query(
        "INSERT INTO customer_accounts
         (id, customerId, isEnabled, creditLimitPence, balancePence, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(customerId) DO UPDATE SET
           isEnabled = excluded.isEnabled,
           creditLimitPence = excluded.creditLimitPence,
           updatedAt = excluded.updatedAt",
    )
    .bind(&input.customer_id)
    .bind(&input.customer_id)
    .bind(if input.is_enabled { 1 } else { 0 })
    .bind(input.credit_limit_pence)
    .bind(&stamp)
    .bind(&stamp)
    .execute(&mut *tx)
    .await?;
    let account = fetch_sqlite_account(&mut tx, &input.customer_id).await?;
    tx.commit().await?;
    Ok(account)
}

async fn save_mysql_customer_account_config(
    pool: &MySqlPool,
    input: &SaveCustomerAccountConfigInput,
) -> Result<CustomerAccountRecord, sqlx::Error> {
    if input.customer_id.trim().is_empty() || input.credit_limit_pence < 0 {
        return Err(account_protocol_error("Invalid customer account settings"));
    }
    ensure_mysql_account_ledger_guards(pool).await?;
    let mut tx = pool.begin().await?;
    assert_mysql_restore_writes_allowed(&mut tx).await?;
    assert_mysql_server_data_epoch(&mut tx, &input.server_data_epoch).await?;
    lock_mysql_customer_for_write(&mut tx, &input.customer_id).await?;
    let stamp: String =
        sqlx::query_scalar("SELECT DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ')")
            .fetch_one(&mut *tx)
            .await?;
    sqlx::query(
        "INSERT INTO customer_accounts
         (id, customerId, isEnabled, creditLimitPence, balancePence, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, 0, ?, ?)
         ON DUPLICATE KEY UPDATE
           isEnabled = VALUES(isEnabled),
           creditLimitPence = VALUES(creditLimitPence),
           updatedAt = VALUES(updatedAt)",
    )
    .bind(&input.customer_id)
    .bind(&input.customer_id)
    .bind(if input.is_enabled { 1 } else { 0 })
    .bind(input.credit_limit_pence)
    .bind(&stamp)
    .bind(&stamp)
    .execute(&mut *tx)
    .await?;
    let account = fetch_mysql_account(&mut tx, &input.customer_id, true).await?;
    tx.commit().await?;
    Ok(account)
}

fn normalize_customer_loyalty_adjustment_input(
    mut input: CustomerLoyaltyAdjustmentInput,
) -> Result<CustomerLoyaltyAdjustmentInput, sqlx::Error> {
    input.id = input.id.trim().to_string();
    input.customer_id = input.customer_id.trim().to_string();
    input.reason = input.reason.trim().to_string();
    input.employee_id = input.employee_id.trim().to_string();
    input.actor_expected_updated_at = input.actor_expected_updated_at.trim().to_string();
    input.created_at = input.created_at.trim().to_string();
    input.server_data_epoch = input.server_data_epoch.trim().to_string();

    if input.id.is_empty() || input.id.len() > 36 || input.id.chars().any(char::is_control) {
        return Err(account_protocol_error(
            "CUSTOMER_LOYALTY_INVALID: adjustment ID is invalid",
        ));
    }
    if input.customer_id.is_empty()
        || input.customer_id.len() > 36
        || input.customer_id.chars().any(char::is_control)
    {
        return Err(account_protocol_error(
            "CUSTOMER_LOYALTY_INVALID: customer ID is invalid",
        ));
    }
    if input.employee_id.is_empty()
        || input.employee_id.len() > 36
        || input.employee_id.chars().any(char::is_control)
        || input.actor_expected_updated_at.is_empty()
        || input.actor_expected_updated_at.len() > 64
    {
        return Err(account_protocol_error(
            "CUSTOMER_LOYALTY_ACTOR_REQUIRED: sign in again before changing loyalty points",
        ));
    }
    let reason_length = input.reason.chars().count();
    if !(3..=240).contains(&reason_length) || input.reason.chars().any(char::is_control) {
        return Err(account_protocol_error(
            "CUSTOMER_LOYALTY_INVALID: enter a reason between 3 and 240 characters",
        ));
    }
    if input.created_at.is_empty()
        || input.created_at.len() > 64
        || chrono::DateTime::parse_from_rfc3339(&input.created_at).is_err()
    {
        return Err(account_protocol_error(
            "CUSTOMER_LOYALTY_INVALID: adjustment timestamp is invalid",
        ));
    }
    // A refund may reverse points after those points were already redeemed.
    // Keep that signed starting balance for CAS; corrections must finish at a
    // nonnegative balance and fit the signed INT movement stored in the ledger.
    if !(i32::MIN as i64..=MAX_LOYALTY_POINTS).contains(&input.expected_points)
        || !(0..=MAX_LOYALTY_POINTS).contains(&input.new_points)
    {
        return Err(account_protocol_error(format!(
            "CUSTOMER_LOYALTY_INVALID: starting points must fit a signed INT and corrected points must be between 0 and {MAX_LOYALTY_POINTS}"
        )));
    }
    if input.expected_points == input.new_points {
        return Err(account_protocol_error(
            "CUSTOMER_LOYALTY_INVALID: the corrected balance is unchanged",
        ));
    }
    customer_loyalty_adjustment_delta(&input)?;
    Ok(input)
}

fn configured_role_can_adjust_customer_loyalty(role: &str, raw: Option<&str>) -> bool {
    let role = role.trim();
    if role == "admin" {
        return true;
    }
    if !matches!(role, "manager" | "supervisor" | "cashier") {
        return false;
    }

    // Match the renderer's permission policy: missing or malformed settings
    // use the default matrix (manager allowed). Once a custom matrix exists,
    // this newly privileged action is opt-in for every non-admin role.
    let default_allowed = role == "manager";
    let Some(raw) = raw.filter(|value| !value.trim().is_empty()) else {
        return default_allowed;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return default_allowed;
    };
    let roles = value.get("roles").unwrap_or(&value);
    match roles.get(role) {
        Some(serde_json::Value::Array(permissions)) => permissions
            .iter()
            .any(|permission| permission.as_str() == Some("adjust_customer_loyalty")),
        Some(_) | None => default_allowed,
    }
}

fn customer_loyalty_adjustment_delta(
    input: &CustomerLoyaltyAdjustmentInput,
) -> Result<i64, sqlx::Error> {
    input
        .new_points
        .checked_sub(input.expected_points)
        .filter(|change| *change != 0 && i32::try_from(*change).is_ok())
        .ok_or_else(|| {
            account_protocol_error("CUSTOMER_LOYALTY_INVALID: points change is out of range")
        })
}

fn customer_loyalty_adjustment_reason(input: &CustomerLoyaltyAdjustmentInput) -> String {
    format!("manual_adjustment: {}", input.reason)
}

fn customer_loyalty_adjustment_audit(
    input: &CustomerLoyaltyAdjustmentInput,
    points_change: i64,
) -> AuditRecord {
    AuditRecord {
        id: input.id.clone(),
        employee_id: input.employee_id.clone(),
        action: "customer_loyalty_adjusted".into(),
        entity_type: "customer".into(),
        entity_id: input.customer_id.clone(),
        old_data: serde_json::json!({
            "loyaltyPoints": input.expected_points,
        })
        .to_string(),
        new_data: serde_json::json!({
            "actorEmployeeId": input.employee_id,
            "loyaltyLogId": input.id,
            "loyaltyPoints": input.new_points,
            "pointsChange": points_change,
            "reason": input.reason,
        })
        .to_string(),
        created_at: input.created_at.clone(),
    }
}

fn customer_loyalty_adjustment_entry(
    input: &CustomerLoyaltyAdjustmentInput,
    points_change: i64,
    updated_at: String,
) -> CustomerLoyaltyAdjustmentEntry {
    CustomerLoyaltyAdjustmentEntry {
        id: input.id.clone(),
        customer_id: input.customer_id.clone(),
        order_id: String::new(),
        points_change,
        reason: customer_loyalty_adjustment_reason(input),
        created_at: input.created_at.clone(),
        updated_at,
    }
}

fn loyalty_adjustment_idempotency_error() -> sqlx::Error {
    account_protocol_error(
        "CUSTOMER_LOYALTY_IDEMPOTENCY_CONFLICT: adjustment ID was already used for different data",
    )
}

fn exact_loyalty_adjustment_replay(
    input: &CustomerLoyaltyAdjustmentInput,
    entry: &CustomerLoyaltyAdjustmentEntry,
    audit: &AuditRecord,
) -> Result<(), sqlx::Error> {
    let points_change = customer_loyalty_adjustment_delta(input)?;
    // `createdAt` is presentation metadata, not part of the idempotent
    // business operation. The renderer may retry an ambiguous commit with the
    // same adjustment ID but a newly generated timestamp. Preserve and return
    // the original timestamps while comparing every stable semantic field.
    if entry.created_at != audit.created_at {
        return Err(loyalty_adjustment_idempotency_error());
    }
    let mut persisted_input = input.clone();
    persisted_input.created_at = entry.created_at.clone();
    let expected_entry = customer_loyalty_adjustment_entry(
        &persisted_input,
        points_change,
        entry.updated_at.clone(),
    );
    let expected_audit = customer_loyalty_adjustment_audit(&persisted_input, points_change);
    if entry != &expected_entry || audit != &expected_audit {
        return Err(loyalty_adjustment_idempotency_error());
    }
    Ok(())
}

async fn authorize_sqlite_customer_loyalty_actor(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    input: &CustomerLoyaltyAdjustmentInput,
) -> Result<(), sqlx::Error> {
    let actor: Option<(String, i64, String)> = sqlx::query_as(
        "SELECT COALESCE(role, ''), COALESCE(isActive, 0), COALESCE(updatedAt, '')
         FROM employees WHERE id = ? LIMIT 1",
    )
    .bind(&input.employee_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some((role, is_active, updated_at)) = actor else {
        return Err(account_protocol_error(
            "CUSTOMER_LOYALTY_ACTOR_REQUIRED: the authorizing staff account no longer exists",
        ));
    };
    if is_active == 0 || updated_at != input.actor_expected_updated_at {
        return Err(account_protocol_error(
            "CUSTOMER_LOYALTY_ACTOR_STALE: authorizing staff access changed; sign in again",
        ));
    }
    let permission_json: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key = 'role_permissions' LIMIT 1")
            .fetch_optional(&mut **tx)
            .await?;
    if !configured_role_can_adjust_customer_loyalty(&role, permission_json.as_deref()) {
        return Err(account_protocol_error(
            "CUSTOMER_LOYALTY_ACTOR_FORBIDDEN: this staff member cannot adjust loyalty points",
        ));
    }
    Ok(())
}

async fn authorize_mysql_customer_loyalty_actor(
    tx: &mut sqlx::Transaction<'_, MySql>,
    input: &CustomerLoyaltyAdjustmentInput,
) -> Result<(), sqlx::Error> {
    let actor = select_employee_profile_for_update(tx, &input.employee_id)
        .await?
        .ok_or_else(|| {
            account_protocol_error(
                "CUSTOMER_LOYALTY_ACTOR_REQUIRED: the authorizing staff account no longer exists",
            )
        })?;
    if !actor.is_active || actor.updated_at != input.actor_expected_updated_at {
        return Err(account_protocol_error(
            "CUSTOMER_LOYALTY_ACTOR_STALE: authorizing staff access changed; sign in again",
        ));
    }
    let permission_json: Option<String> = sqlx::query_scalar(
        "SELECT CAST(value AS CHAR CHARACTER SET utf8mb4)
         FROM settings WHERE `key` = 'role_permissions' LIMIT 1 FOR UPDATE",
    )
    .fetch_optional(&mut **tx)
    .await?;
    if !configured_role_can_adjust_customer_loyalty(&actor.role, permission_json.as_deref()) {
        return Err(account_protocol_error(
            "CUSTOMER_LOYALTY_ACTOR_FORBIDDEN: this staff member cannot adjust loyalty points",
        ));
    }
    Ok(())
}

async fn sqlite_existing_customer_loyalty_adjustment(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    adjustment_id: &str,
) -> Result<Option<(CustomerLoyaltyAdjustmentEntry, AuditRecord)>, sqlx::Error> {
    let entry: Option<(String, String, i64, String, String, String)> = sqlx::query_as(
        "SELECT COALESCE(customerId, ''), COALESCE(orderId, ''),
                COALESCE(pointsChange, 0), COALESCE(reason, ''),
                COALESCE(createdAt, ''), COALESCE(updatedAt, '')
         FROM loyalty_logs WHERE id = ? LIMIT 1",
    )
    .bind(adjustment_id)
    .fetch_optional(&mut **tx)
    .await?;
    let audit: Option<(String, String, String, String, String, String, String)> = sqlx::query_as(
        "SELECT COALESCE(employeeId, ''), COALESCE(action, ''),
                COALESCE(entityType, ''), COALESCE(entityId, ''),
                COALESCE(oldData, ''), COALESCE(newData, ''), COALESCE(createdAt, '')
         FROM audit_logs WHERE id = ? LIMIT 1",
    )
    .bind(adjustment_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some((customer_id, order_id, points_change, reason, created_at, updated_at)) = entry else {
        return if audit.is_none() {
            Ok(None)
        } else {
            Err(loyalty_adjustment_idempotency_error())
        };
    };
    let Some((employee_id, action, entity_type, entity_id, old_data, new_data, audit_created_at)) =
        audit
    else {
        return Err(loyalty_adjustment_idempotency_error());
    };
    Ok(Some((
        CustomerLoyaltyAdjustmentEntry {
            id: adjustment_id.to_string(),
            customer_id,
            order_id,
            points_change,
            reason,
            created_at,
            updated_at,
        },
        AuditRecord {
            id: adjustment_id.to_string(),
            employee_id,
            action,
            entity_type,
            entity_id,
            old_data,
            new_data,
            created_at: audit_created_at,
        },
    )))
}

async fn mysql_existing_customer_loyalty_adjustment(
    tx: &mut sqlx::Transaction<'_, MySql>,
    adjustment_id: &str,
) -> Result<Option<(CustomerLoyaltyAdjustmentEntry, AuditRecord)>, sqlx::Error> {
    let entry: Option<(String, String, i64, String, String, String)> = sqlx::query_as(
        "SELECT CAST(COALESCE(customerId, '') AS CHAR CHARACTER SET utf8mb4),
                CAST(COALESCE(orderId, '') AS CHAR CHARACTER SET utf8mb4),
                CAST(COALESCE(pointsChange, 0) AS SIGNED),
                CAST(COALESCE(reason, '') AS CHAR CHARACTER SET utf8mb4),
                CAST(COALESCE(createdAt, '') AS CHAR CHARACTER SET utf8mb4),
                CAST(COALESCE(updatedAt, '') AS CHAR CHARACTER SET utf8mb4)
         FROM loyalty_logs WHERE id = ? LIMIT 1 FOR UPDATE",
    )
    .bind(adjustment_id)
    .fetch_optional(&mut **tx)
    .await?;
    let audit: Option<(String, String, String, String, String, String, String)> = sqlx::query_as(
        "SELECT CAST(COALESCE(employeeId, '') AS CHAR CHARACTER SET utf8mb4),
                CAST(COALESCE(action, '') AS CHAR CHARACTER SET utf8mb4),
                CAST(COALESCE(entityType, '') AS CHAR CHARACTER SET utf8mb4),
                CAST(COALESCE(entityId, '') AS CHAR CHARACTER SET utf8mb4),
                CAST(COALESCE(oldData, '') AS CHAR CHARACTER SET utf8mb4),
                CAST(COALESCE(newData, '') AS CHAR CHARACTER SET utf8mb4),
                CAST(COALESCE(createdAt, '') AS CHAR CHARACTER SET utf8mb4)
         FROM audit_logs WHERE id = ? LIMIT 1 FOR UPDATE",
    )
    .bind(adjustment_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some((customer_id, order_id, points_change, reason, created_at, updated_at)) = entry else {
        return if audit.is_none() {
            Ok(None)
        } else {
            Err(loyalty_adjustment_idempotency_error())
        };
    };
    let Some((employee_id, action, entity_type, entity_id, old_data, new_data, audit_created_at)) =
        audit
    else {
        return Err(loyalty_adjustment_idempotency_error());
    };
    Ok(Some((
        CustomerLoyaltyAdjustmentEntry {
            id: adjustment_id.to_string(),
            customer_id,
            order_id,
            points_change,
            reason,
            created_at,
            updated_at,
        },
        AuditRecord {
            id: adjustment_id.to_string(),
            employee_id,
            action,
            entity_type,
            entity_id,
            old_data,
            new_data,
            created_at: audit_created_at,
        },
    )))
}

async fn adjust_sqlite_customer_loyalty(
    pool: &SqlitePool,
    input: &CustomerLoyaltyAdjustmentInput,
) -> Result<CustomerLoyaltyAdjustmentResult, sqlx::Error> {
    let points_change = customer_loyalty_adjustment_delta(input)?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let current: Option<(i64, String)> = sqlx::query_as(
        "SELECT COALESCE(loyaltyPoints, 0), COALESCE(updatedAt, '')
         FROM customers WHERE id = ? LIMIT 1",
    )
    .bind(&input.customer_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((current_points, current_updated_at)) = current else {
        return Err(account_protocol_error("Customer was not found"));
    };

    if let Some((entry, audit)) =
        sqlite_existing_customer_loyalty_adjustment(&mut tx, &input.id).await?
    {
        exact_loyalty_adjustment_replay(input, &entry, &audit)?;
        tx.commit().await?;
        return Ok(CustomerLoyaltyAdjustmentResult {
            customer_id: input.customer_id.clone(),
            loyalty_points: current_points,
            customer_updated_at: current_updated_at,
            entry,
            audit,
        });
    }

    authorize_sqlite_customer_loyalty_actor(&mut tx, input).await?;
    if current_points != input.expected_points {
        return Err(account_protocol_error(
            "CUSTOMER_LOYALTY_CONFLICT: points changed; refresh and try again",
        ));
    }
    let stamp = utc_stamp();
    let mut persisted_input = input.clone();
    // Permanent history uses the trusted native clock, not a renderer clock
    // that could be wrong or directly manipulated.
    persisted_input.created_at = stamp.clone();
    let expected_audit = customer_loyalty_adjustment_audit(&persisted_input, points_change);
    let updated = sqlx::query(
        "UPDATE customers SET loyaltyPoints = ?, updatedAt = ?
         WHERE id = ? AND COALESCE(loyaltyPoints, 0) = ?",
    )
    .bind(input.new_points)
    .bind(&stamp)
    .bind(&input.customer_id)
    .bind(input.expected_points)
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(account_protocol_error(
            "CUSTOMER_LOYALTY_CONFLICT: points changed; refresh and try again",
        ));
    }
    let entry =
        customer_loyalty_adjustment_entry(&persisted_input, points_change, stamp.clone());
    sqlx::query(
        "INSERT INTO loyalty_logs
            (id, customerId, orderId, pointsChange, reason, createdAt, updatedAt)
         VALUES (?, ?, '', ?, ?, ?, ?)",
    )
    .bind(&entry.id)
    .bind(&entry.customer_id)
    .bind(entry.points_change)
    .bind(&entry.reason)
    .bind(&entry.created_at)
    .bind(&entry.updated_at)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO audit_logs
            (id, employeeId, action, entityType, entityId,
             oldData, newData, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&expected_audit.id)
    .bind(&expected_audit.employee_id)
    .bind(&expected_audit.action)
    .bind(&expected_audit.entity_type)
    .bind(&expected_audit.entity_id)
    .bind(&expected_audit.old_data)
    .bind(&expected_audit.new_data)
    .bind(&expected_audit.created_at)
    .bind(&stamp)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(CustomerLoyaltyAdjustmentResult {
        customer_id: input.customer_id.clone(),
        loyalty_points: input.new_points,
        customer_updated_at: stamp,
        entry,
        audit: expected_audit,
    })
}

async fn adjust_mysql_customer_loyalty(
    pool: &MySqlPool,
    input: &CustomerLoyaltyAdjustmentInput,
) -> Result<CustomerLoyaltyAdjustmentResult, sqlx::Error> {
    let points_change = customer_loyalty_adjustment_delta(input)?;
    let mut tx = pool.begin().await?;
    assert_mysql_restore_writes_allowed(&mut tx).await?;
    assert_mysql_server_data_epoch(&mut tx, &input.server_data_epoch).await?;
    let current_points = lock_mysql_customer_for_write(&mut tx, &input.customer_id).await?;
    let current_updated_at: String = sqlx::query_scalar(
        "SELECT CAST(COALESCE(updatedAt, '') AS CHAR CHARACTER SET utf8mb4)
         FROM customers WHERE id = ? LIMIT 1",
    )
    .bind(&input.customer_id)
    .fetch_one(&mut *tx)
    .await?;

    if let Some((entry, audit)) =
        mysql_existing_customer_loyalty_adjustment(&mut tx, &input.id).await?
    {
        exact_loyalty_adjustment_replay(input, &entry, &audit)?;
        tx.commit().await?;
        return Ok(CustomerLoyaltyAdjustmentResult {
            customer_id: input.customer_id.clone(),
            loyalty_points: current_points,
            customer_updated_at: current_updated_at,
            entry,
            audit,
        });
    }

    authorize_mysql_customer_loyalty_actor(&mut tx, input).await?;
    if current_points != input.expected_points {
        return Err(account_protocol_error(
            "CUSTOMER_LOYALTY_CONFLICT: points changed; refresh and try again",
        ));
    }
    let stamp: String = sqlx::query_scalar(
        "SELECT CONCAT(LEFT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ'), 23), 'Z')",
    )
    .fetch_one(&mut *tx)
    .await?;
    let mut persisted_input = input.clone();
    // Use MariaDB's clock for the immutable activity time. The generic sync
    // triggers may also restamp updatedAt, which is re-read below.
    persisted_input.created_at = stamp.clone();
    let expected_audit = customer_loyalty_adjustment_audit(&persisted_input, points_change);
    let updated = sqlx::query(
        "UPDATE customers SET loyaltyPoints = ?, updatedAt = ?
         WHERE id = ? AND COALESCE(loyaltyPoints, 0) = ?",
    )
    .bind(input.new_points)
    .bind(&stamp)
    .bind(&input.customer_id)
    .bind(input.expected_points)
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(account_protocol_error(
            "CUSTOMER_LOYALTY_CONFLICT: points changed; refresh and try again",
        ));
    }
    let entry =
        customer_loyalty_adjustment_entry(&persisted_input, points_change, stamp.clone());
    sqlx::query(
        "INSERT INTO loyalty_logs
            (id, customerId, orderId, pointsChange, reason, createdAt, updatedAt)
         VALUES (?, ?, '', ?, ?, ?, ?)",
    )
    .bind(&entry.id)
    .bind(&entry.customer_id)
    .bind(entry.points_change)
    .bind(&entry.reason)
    .bind(&entry.created_at)
    .bind(&entry.updated_at)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO audit_logs
            (id, employeeId, action, entityType, entityId,
             oldData, newData, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&expected_audit.id)
    .bind(&expected_audit.employee_id)
    .bind(&expected_audit.action)
    .bind(&expected_audit.entity_type)
    .bind(&expected_audit.entity_id)
    .bind(&expected_audit.old_data)
    .bind(&expected_audit.new_data)
    .bind(&expected_audit.created_at)
    .bind(&stamp)
    .execute(&mut *tx)
    .await?;
    let (entry, audit) = mysql_existing_customer_loyalty_adjustment(&mut tx, &input.id)
        .await?
        .ok_or_else(|| {
            account_protocol_error(
                "CUSTOMER_LOYALTY_COMMIT_INCOMPLETE: committed history could not be re-read",
            )
        })?;
    exact_loyalty_adjustment_replay(&persisted_input, &entry, &audit)?;
    let (persisted_points, persisted_updated_at): (i64, String) = sqlx::query_as(
        "SELECT CAST(COALESCE(loyaltyPoints, 0) AS SIGNED),
                CAST(COALESCE(updatedAt, '') AS CHAR CHARACTER SET utf8mb4)
         FROM customers WHERE id = ? LIMIT 1 FOR UPDATE",
    )
    .bind(&input.customer_id)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(CustomerLoyaltyAdjustmentResult {
        customer_id: input.customer_id.clone(),
        loyalty_points: persisted_points,
        customer_updated_at: persisted_updated_at,
        entry,
        audit,
    })
}

async fn cache_sqlite_customer_loyalty_adjustment(
    pool: &SqlitePool,
    result: &CustomerLoyaltyAdjustmentResult,
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let expected_points = result
        .loyalty_points
        .checked_sub(result.entry.points_change)
        .ok_or_else(|| account_protocol_error("CUSTOMER_LOYALTY_INVALID: cached points overflow"))?;
    // A newer shared update may already have reached SQLite while this
    // command was returning. Never move that cache backwards to the balance
    // from this earlier commit. For equal millisecond timestamps, only apply
    // when the cached balance is this operation's expected or resulting value.
    sqlx::query(
        "UPDATE customers SET loyaltyPoints = ?, updatedAt = ?
         WHERE id = ?
           AND (
             COALESCE(updatedAt, '') < ?
             OR (
               COALESCE(updatedAt, '') = ?
               AND COALESCE(loyaltyPoints, 0) IN (?, ?)
             )
           )",
    )
        .bind(result.loyalty_points)
        .bind(&result.customer_updated_at)
        .bind(&result.customer_id)
        .bind(&result.customer_updated_at)
        .bind(&result.customer_updated_at)
        .bind(expected_points)
        .bind(result.loyalty_points)
        .execute(&mut *tx)
        .await?;
    let entry = &result.entry;
    sqlx::query(
        "INSERT INTO loyalty_logs
            (id, customerId, orderId, pointsChange, reason, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           customerId = excluded.customerId,
           orderId = excluded.orderId,
           pointsChange = excluded.pointsChange,
           reason = excluded.reason,
           createdAt = excluded.createdAt,
           updatedAt = excluded.updatedAt",
    )
    .bind(&entry.id)
    .bind(&entry.customer_id)
    .bind(&entry.order_id)
    .bind(entry.points_change)
    .bind(&entry.reason)
    .bind(&entry.created_at)
    .bind(&entry.updated_at)
    .execute(&mut *tx)
    .await?;
    let audit = &result.audit;
    sqlx::query(
        "INSERT INTO audit_logs
            (id, employeeId, action, entityType, entityId,
             oldData, newData, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           employeeId = excluded.employeeId,
           action = excluded.action,
           entityType = excluded.entityType,
           entityId = excluded.entityId,
           oldData = excluded.oldData,
           newData = excluded.newData,
           createdAt = excluded.createdAt,
           updatedAt = excluded.updatedAt",
    )
    .bind(&audit.id)
    .bind(&audit.employee_id)
    .bind(&audit.action)
    .bind(&audit.entity_type)
    .bind(&audit.entity_id)
    .bind(&audit.old_data)
    .bind(&audit.new_data)
    .bind(&audit.created_at)
    .bind(&result.customer_updated_at)
    .execute(&mut *tx)
    .await?;
    tx.commit().await
}

async fn post_sqlite_customer_account_entry(
    pool: &SqlitePool,
    input: &CustomerAccountChange,
) -> Result<CustomerAccountMutationResult, sqlx::Error> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let mut change = input.clone();
    let result = apply_sqlite_account_change(&mut tx, &mut change).await?;
    tx.commit().await?;
    Ok(result)
}

async fn post_mysql_customer_account_entry(
    pool: &MySqlPool,
    input: &CustomerAccountChange,
) -> Result<CustomerAccountMutationResult, sqlx::Error> {
    ensure_mysql_account_ledger_guards(pool).await?;
    let mut tx = pool.begin().await?;
    let current_report_epoch = assert_mysql_restore_writes_allowed(&mut tx).await?;
    assert_mysql_server_data_epoch(&mut tx, &input.server_data_epoch).await?;
    let expected_report_epoch = canonical_report_epoch(&input.report_epoch)?;
    if expected_report_epoch != current_report_epoch {
        return Err(account_protocol_error(format!(
            "REPORT_EPOCH_STALE: expected report epoch '{}', current epoch '{}'",
            expected_report_epoch, current_report_epoch
        )));
    }
    lock_mysql_customer_for_write(&mut tx, &input.customer_id).await?;
    let stamp: String =
        sqlx::query_scalar("SELECT DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ')")
            .fetch_one(&mut *tx)
            .await?;
    let account_authority = grant_mysql_account_write_authority(&mut tx).await?;
    let mut change = input.clone();
    let result = apply_mysql_account_change(&mut tx, &mut change, &stamp).await?;
    revoke_mysql_account_write_authority(&mut tx, &account_authority).await?;
    tx.commit().await?;
    Ok(result)
}

async fn delete_mysql_customer(
    pool: &MySqlPool,
    customer_id: &str,
    server_data_epoch: &str,
) -> Result<CustomerDeletionResult, sqlx::Error> {
    let customer_id = customer_id.trim();
    if customer_id.is_empty() || customer_id.len() > 64 || customer_id.chars().any(char::is_control)
    {
        return Err(account_protocol_error("Invalid customer ID"));
    }

    ensure_mysql_account_ledger_guards(pool).await?;
    let mut tx = pool.begin().await?;
    assert_mysql_restore_writes_allowed(&mut tx).await?;
    assert_mysql_server_data_epoch(&mut tx, server_data_epoch).await?;

    // Global customer identity mutex first, the customer row second, and all
    // account rows third. Every current financial writer follows this order.
    lock_mysql_customer_identity(&mut tx, customer_id).await?;
    let loyalty_points: Option<i64> = sqlx::query_scalar(
        "SELECT CAST(COALESCE(loyaltyPoints, 0) AS SIGNED)
         FROM customers WHERE id = ? LIMIT 1 FOR UPDATE",
    )
    .bind(customer_id)
    .fetch_optional(&mut *tx)
    .await?;
    let account_rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT CAST(id AS CHAR), CAST(COALESCE(balancePence, 0) AS SIGNED)
         FROM customer_accounts
         WHERE customerId = ? ORDER BY id FOR UPDATE",
    )
    .bind(customer_id)
    .fetch_all(&mut *tx)
    .await?;

    let customer_tombstoned: i64 = sqlx::query_scalar(
        "SELECT EXISTS(
           SELECT 1 FROM tombstones
            WHERE table_name = 'customers' AND row_id = ?
         )",
    )
    .bind(customer_id)
    .fetch_one(&mut *tx)
    .await?;
    if loyalty_points.is_none() && customer_tombstoned == 0 {
        return Err(account_protocol_error("Customer was not found"));
    }
    if loyalty_points.unwrap_or(0) != 0 {
        return Err(account_protocol_error(
            "This customer still has a loyalty-points balance and cannot be deleted",
        ));
    }
    if account_rows.iter().any(|(_, balance)| *balance != 0) {
        return Err(account_protocol_error(
            "This customer still has an account balance and cannot be deleted",
        ));
    }

    let (orders_exist, loyalty_history_exists, account_history_exists): (i64, i64, i64) =
        sqlx::query_as(
            "SELECT
               EXISTS(SELECT 1 FROM orders WHERE customerId = ? LIMIT 1),
               EXISTS(SELECT 1 FROM loyalty_logs WHERE customerId = ? LIMIT 1),
               EXISTS(
                 SELECT 1 FROM customer_account_entries entry
                  WHERE entry.customerId = ?
                     OR entry.accountId IN (
                       SELECT account.id FROM customer_accounts account
                        WHERE account.customerId = ?
                     )
                  LIMIT 1
               )",
        )
        .bind(customer_id)
        .bind(customer_id)
        .bind(customer_id)
        .bind(customer_id)
        .fetch_one(&mut *tx)
        .await?;
    if account_history_exists != 0 {
        return Err(account_protocol_error(
            "This customer has account history that must be retained; archive the customer instead",
        ));
    }
    if orders_exist != 0 || loyalty_history_exists != 0 {
        return Err(account_protocol_error(
            "This customer has linked sales or loyalty history and cannot be deleted",
        ));
    }

    let account_ids = account_rows
        .iter()
        .map(|(account_id, _)| account_id.clone())
        .collect::<Vec<_>>();
    if !account_ids.is_empty() {
        let account_authority = grant_mysql_account_write_authority(&mut tx).await?;
        let deleted = sqlx::query("DELETE FROM customer_accounts WHERE customerId = ?")
            .bind(customer_id)
            .execute(&mut *tx)
            .await?;
        if deleted.rows_affected() != account_ids.len() as u64 {
            return Err(account_protocol_error(
                "Customer account changed while deletion was in progress",
            ));
        }
        revoke_mysql_account_write_authority(&mut tx, &account_authority).await?;
    }
    let already_deleted = loyalty_points.is_none();
    if !already_deleted {
        let deleted = sqlx::query("DELETE FROM customers WHERE id = ?")
            .bind(customer_id)
            .execute(&mut *tx)
            .await?;
        if deleted.rows_affected() != 1 {
            return Err(account_protocol_error(
                "Customer changed while deletion was in progress",
            ));
        }
    }

    // Delete triggers are part of the durability contract. Verify their rows
    // before commit so missing or disabled triggers roll back the deletion.
    let customer_tombstone_at: Option<String> = sqlx::query_scalar(
        "SELECT CAST(COALESCE(NULLIF(deletedAt, ''), updatedAt) AS CHAR)
         FROM tombstones
         WHERE table_name = 'customers' AND row_id = ? LIMIT 1 FOR UPDATE",
    )
    .bind(customer_id)
    .fetch_optional(&mut *tx)
    .await?;
    let deleted_at = customer_tombstone_at
        .filter(|stamp| !stamp.trim().is_empty())
        .ok_or_else(|| {
            account_protocol_error(
                "Customer deletion did not create its required MariaDB tombstone",
            )
        })?;
    for account_id in &account_ids {
        let account_tombstoned: i64 = sqlx::query_scalar(
            "SELECT EXISTS(
               SELECT 1 FROM tombstones
                WHERE table_name = 'customer_accounts' AND row_id = ?
             )",
        )
        .bind(account_id)
        .fetch_one(&mut *tx)
        .await?;
        if account_tombstoned == 0 {
            return Err(account_protocol_error(
                "Customer account deletion did not create its required MariaDB tombstone",
            ));
        }
    }

    tx.commit().await?;
    Ok(CustomerDeletionResult {
        customer_id: customer_id.to_string(),
        account_ids,
        already_deleted,
        deleted_at,
    })
}

async fn cleanup_sqlite_deleted_customer(
    pool: &SqlitePool,
    result: &CustomerDeletionResult,
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let local_account_ids: Vec<String> =
        sqlx::query_scalar("SELECT id FROM customer_accounts WHERE customerId = ? ORDER BY id")
            .bind(&result.customer_id)
            .fetch_all(&mut *tx)
            .await?;
    let mut account_ids = result.account_ids.clone();
    account_ids.extend(local_account_ids);
    account_ids.sort();
    account_ids.dedup();

    sqlx::query("DELETE FROM customer_account_entries WHERE customerId = ?")
        .bind(&result.customer_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM customer_accounts WHERE customerId = ?")
        .bind(&result.customer_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM customers WHERE id = ?")
        .bind(&result.customer_id)
        .execute(&mut *tx)
        .await?;

    sqlx::query(
        "INSERT INTO tombstones (id, table_name, row_id, deletedAt, updatedAt)
         VALUES (?, 'customers', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           deletedAt = excluded.deletedAt, updatedAt = excluded.updatedAt",
    )
    .bind(format!("customers:{}", result.customer_id))
    .bind(&result.customer_id)
    .bind(&result.deleted_at)
    .bind(&result.deleted_at)
    .execute(&mut *tx)
    .await?;
    for account_id in account_ids {
        sqlx::query(
            "INSERT INTO tombstones (id, table_name, row_id, deletedAt, updatedAt)
             VALUES (?, 'customer_accounts', ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               deletedAt = excluded.deletedAt, updatedAt = excluded.updatedAt",
        )
        .bind(format!("customer_accounts:{account_id}"))
        .bind(account_id)
        .bind(&result.deleted_at)
        .bind(&result.deleted_at)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await
}

async fn cache_sqlite_customer_account(
    pool: &SqlitePool,
    account: &CustomerAccountRecord,
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    sqlx::query(
        "INSERT INTO customer_accounts
         (id, customerId, isEnabled, creditLimitPence, balancePence, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(customerId) DO UPDATE SET
           isEnabled = excluded.isEnabled,
           creditLimitPence = excluded.creditLimitPence,
           balancePence = excluded.balancePence,
           updatedAt = excluded.updatedAt",
    )
    .bind(&account.id)
    .bind(&account.customer_id)
    .bind(if account.is_enabled { 1 } else { 0 })
    .bind(account.credit_limit_pence)
    .bind(account.balance_pence)
    .bind(&account.created_at)
    .bind(&account.updated_at)
    .execute(&mut *tx)
    .await?;
    tx.commit().await
}

async fn cache_sqlite_customer_account_mutation(
    pool: &SqlitePool,
    result: &CustomerAccountMutationResult,
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let account = &result.account;
    sqlx::query(
        "INSERT INTO customer_accounts
         (id, customerId, isEnabled, creditLimitPence, balancePence, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(customerId) DO UPDATE SET
           isEnabled = excluded.isEnabled,
           creditLimitPence = excluded.creditLimitPence,
           balancePence = excluded.balancePence,
           updatedAt = excluded.updatedAt",
    )
    .bind(&account.id)
    .bind(&account.customer_id)
    .bind(if account.is_enabled { 1 } else { 0 })
    .bind(account.credit_limit_pence)
    .bind(account.balance_pence)
    .bind(&account.created_at)
    .bind(&account.updated_at)
    .execute(&mut *tx)
    .await?;
    let entry = &result.entry;
    sqlx::query(
        "INSERT INTO customer_account_entries
         (id, accountId, customerId, orderId, entryType, amountPence, paymentMethod,
          reference, description, receiptNumber, receiptKey, employeeId, tillNumber,
          shiftId, idempotencyKey, reversesEntryId, balanceAfterPence, createdAt, updatedAt,
          tipsAmount, serviceChargeAmount, cashbackAmount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           balanceAfterPence = excluded.balanceAfterPence,
           updatedAt = excluded.updatedAt",
    )
    .bind(&entry.id)
    .bind(&entry.account_id)
    .bind(&entry.customer_id)
    .bind(&entry.order_id)
    .bind(&entry.entry_type)
    .bind(entry.amount_pence)
    .bind(&entry.payment_method)
    .bind(&entry.reference)
    .bind(&entry.description)
    .bind(entry.receipt_number)
    .bind(&entry.receipt_key)
    .bind(&entry.employee_id)
    .bind(&entry.till_number)
    .bind(&entry.shift_id)
    .bind(&entry.idempotency_key)
    .bind(&entry.reverses_entry_id)
    .bind(entry.balance_after_pence)
    .bind(&entry.created_at)
    .bind(&entry.updated_at)
    .bind(entry.tips_amount)
    .bind(entry.service_charge_amount)
    .bind(entry.cashback_amount)
    .execute(&mut *tx)
    .await?;
    tx.commit().await
}

const MAX_STOCK_RECEIPT_MONEY: i64 = 9_007_199_254_740_991;

fn validate_stock_receipt_bundle(bundle: &StockReceiptBundle) -> Result<(), sqlx::Error> {
    let receipt = &bundle.receipt;
    if receipt.id.trim().is_empty()
        || receipt.employee_id.trim().is_empty()
        || receipt.status != "received"
        || bundle.lines.is_empty()
    {
        return Err(sqlx::Error::Protocol("Invalid stock receipt".into()));
    }

    let mut product_ids = HashSet::new();
    let mut line_ids = HashSet::new();
    let mut log_ids = HashSet::new();
    let mut calculated_total = 0_i64;
    for line in &bundle.lines {
        if line.id.trim().is_empty()
            || line.receipt_id != receipt.id
            || line.product_id.trim().is_empty()
            || line.inventory_log_id.trim().is_empty()
            || line.quantity <= 0
            || line.quantity > i32::MAX as i64
            || line.unit_cost < 0
            || line.unit_cost > MAX_STOCK_RECEIPT_MONEY
            || !product_ids.insert(line.product_id.as_str())
            || !line_ids.insert(line.id.as_str())
            || !log_ids.insert(line.inventory_log_id.as_str())
        {
            return Err(sqlx::Error::Protocol("Invalid stock receipt line".into()));
        }
        calculated_total =
            calculated_total
                .checked_add(line.quantity.checked_mul(line.unit_cost).ok_or_else(|| {
                    sqlx::Error::Protocol("Stock receipt total is too large".into())
                })?)
                .ok_or_else(|| sqlx::Error::Protocol("Stock receipt total is too large".into()))?;
        if calculated_total > MAX_STOCK_RECEIPT_MONEY {
            return Err(sqlx::Error::Protocol("Stock receipt total is too large".into()));
        }
    }
    if receipt.total_cost != calculated_total {
        return Err(sqlx::Error::Protocol(
            "Stock receipt total does not match its lines".into(),
        ));
    }
    if bundle.audit.id.trim().is_empty()
        || bundle.audit.employee_id != receipt.employee_id
        || bundle.audit.entity_id != receipt.id
        || bundle.audit.entity_type != "stock_receipt"
        || bundle.audit.action != "stock_received"
    {
        return Err(sqlx::Error::Protocol("Invalid stock receipt audit".into()));
    }
    Ok(())
}

async fn insert_sqlite_stock_receipt_bundle(
    pool: &SqlitePool,
    bundle: &StockReceiptBundle,
    outbox_id: Option<&str>,
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let mut committed = bundle.clone();
    if outbox_id.is_some_and(|value| !value.trim().is_empty()) {
        committed.server_data_epoch = sqlx::query_scalar(
            "SELECT COALESCE((SELECT value FROM settings
                              WHERE key = 'server_data_epoch_seen' LIMIT 1), '')",
        )
        .fetch_one(&mut *tx)
        .await?;
        committed.server_data_epoch = committed.server_data_epoch.trim().to_string();
    }
    validate_stock_receipt_bundle(&committed)?;
    let bundle = &committed;
    let receipt = &bundle.receipt;
    let existing: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM stock_receipts WHERE id = ? LIMIT 1")
            .bind(&receipt.id)
            .fetch_optional(&mut *tx)
            .await?;
    if existing.is_some() {
        tx.commit().await?;
        return Ok(());
    }

    sqlx::query(
        "INSERT INTO stock_receipts (id, supplierId, employeeId, reference, notes, totalCost, status, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&receipt.id)
    .bind(&receipt.supplier_id)
    .bind(&receipt.employee_id)
    .bind(&receipt.reference)
    .bind(&receipt.notes)
    .bind(receipt.total_cost)
    .bind(&receipt.status)
    .bind(&receipt.created_at)
    .bind(&receipt.updated_at)
    .execute(&mut *tx)
    .await?;

    let log_notes = if receipt.reference.trim().is_empty() {
        "Stock receipt".to_string()
    } else {
        format!("Stock receipt {}", receipt.reference.trim())
    };
    for line in &bundle.lines {
        sqlx::query(
            "INSERT INTO stock_receipt_lines (id, receiptId, productId, quantity, unitCost, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&line.id)
        .bind(&line.receipt_id)
        .bind(&line.product_id)
        .bind(line.quantity)
        .bind(line.unit_cost)
        .bind(&line.created_at)
        .bind(&line.updated_at)
        .execute(&mut *tx)
        .await?;

        let result = sqlx::query(
            "UPDATE products SET stockLevel = COALESCE(stockLevel, 0) + ?, updatedAt = ?
             WHERE id = ? AND COALESCE(stockLevel, 0) BETWEEN ? AND ?",
        )
        .bind(line.quantity)
        .bind(&receipt.updated_at)
        .bind(&line.product_id)
        .bind(i32::MIN as i64)
        .bind(i32::MAX as i64 - line.quantity)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() != 1 {
            return Err(sqlx::Error::Protocol(format!(
                "Product {} is unavailable or its stock quantity would exceed the supported range",
                line.product_name
            )));
        }

        sqlx::query(
            "INSERT INTO inventory_logs (id, productId, quantityChange, type, referenceId, employeeId, notes, createdAt, updatedAt)
             VALUES (?, ?, ?, 'restock', ?, ?, ?, ?, ?)",
        )
        .bind(&line.inventory_log_id)
        .bind(&line.product_id)
        .bind(line.quantity)
        .bind(&receipt.id)
        .bind(&receipt.employee_id)
        .bind(&log_notes)
        .bind(&line.created_at)
        .bind(&line.updated_at)
        .execute(&mut *tx)
        .await?;
    }

    let audit = &bundle.audit;
    sqlx::query(
        "INSERT INTO audit_logs (id, employeeId, action, entityType, entityId, oldData, newData, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&audit.id)
    .bind(&audit.employee_id)
    .bind(&audit.action)
    .bind(&audit.entity_type)
    .bind(&audit.entity_id)
    .bind(&audit.old_data)
    .bind(&audit.new_data)
    .bind(&audit.created_at)
    .bind(&receipt.updated_at)
    .execute(&mut *tx)
    .await?;

    if let Some(outbox_id) = outbox_id.filter(|value| !value.trim().is_empty()) {
        let data = serde_json::to_string(bundle)
            .map_err(|error| sqlx::Error::Protocol(error.to_string()))?;
        sqlx::query(
            "INSERT INTO _offline_queue (id, table_name, operation, data, id_key, created_at)
             VALUES (?, 'stock_receipts', 'stockReceiptBundle', ?, 'id', ?)",
        )
        .bind(outbox_id)
        .bind(data)
        .bind(&receipt.created_at)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await
}

async fn insert_mysql_stock_receipt_bundle(
    pool: &MySqlPool,
    bundle: &StockReceiptBundle,
) -> Result<(), sqlx::Error> {
    validate_stock_receipt_bundle(bundle)?;
    let mut tx = pool.begin().await?;
    assert_mysql_restore_writes_allowed(&mut tx).await?;
    assert_mysql_server_data_epoch(&mut tx, &bundle.server_data_epoch).await?;
    let receipt = &bundle.receipt;
    let existing: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM stock_receipts WHERE id = ? LIMIT 1")
            .bind(&receipt.id)
            .fetch_optional(&mut *tx)
            .await?;
    if existing.is_some() {
        tx.commit().await?;
        return Ok(());
    }
    let stamp: String =
        sqlx::query_scalar("SELECT DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ')")
            .fetch_one(&mut *tx)
            .await?;

    sqlx::query(
        "INSERT INTO stock_receipts (id, supplierId, employeeId, reference, notes, totalCost, status, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&receipt.id)
    .bind(&receipt.supplier_id)
    .bind(&receipt.employee_id)
    .bind(&receipt.reference)
    .bind(&receipt.notes)
    .bind(receipt.total_cost)
    .bind(&receipt.status)
    .bind(&receipt.created_at)
    .bind(&stamp)
    .execute(&mut *tx)
    .await?;

    let log_notes = if receipt.reference.trim().is_empty() {
        "Stock receipt".to_string()
    } else {
        format!("Stock receipt {}", receipt.reference.trim())
    };
    for line in &bundle.lines {
        sqlx::query(
            "INSERT INTO stock_receipt_lines (id, receiptId, productId, quantity, unitCost, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&line.id)
        .bind(&line.receipt_id)
        .bind(&line.product_id)
        .bind(line.quantity)
        .bind(line.unit_cost)
        .bind(&line.created_at)
        .bind(&stamp)
        .execute(&mut *tx)
        .await?;

        let result = sqlx::query(
            "UPDATE products SET stockLevel = COALESCE(stockLevel, 0) + ?, updatedAt = ?
             WHERE id = ? AND COALESCE(stockLevel, 0) BETWEEN ? AND ?",
        )
        .bind(line.quantity)
        .bind(&stamp)
        .bind(&line.product_id)
        .bind(i32::MIN as i64)
        .bind(i32::MAX as i64 - line.quantity)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() != 1 {
            return Err(sqlx::Error::Protocol(format!(
                "Product {} is unavailable or its stock quantity would exceed the supported range",
                line.product_name
            )));
        }

        sqlx::query(
            "INSERT INTO inventory_logs (id, productId, quantityChange, type, referenceId, employeeId, notes, createdAt, updatedAt)
             VALUES (?, ?, ?, 'restock', ?, ?, ?, ?, ?)",
        )
        .bind(&line.inventory_log_id)
        .bind(&line.product_id)
        .bind(line.quantity)
        .bind(&receipt.id)
        .bind(&receipt.employee_id)
        .bind(&log_notes)
        .bind(&line.created_at)
        .bind(&stamp)
        .execute(&mut *tx)
        .await?;
    }

    let audit = &bundle.audit;
    sqlx::query(
        "INSERT INTO audit_logs (id, employeeId, action, entityType, entityId, oldData, newData, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&audit.id)
    .bind(&audit.employee_id)
    .bind(&audit.action)
    .bind(&audit.entity_type)
    .bind(&audit.entity_id)
    .bind(&audit.old_data)
    .bind(&audit.new_data)
    .bind(&audit.created_at)
    .bind(&stamp)
    .execute(&mut *tx)
    .await?;

    tx.commit().await
}

fn generic_mysql_outbox_table_allowed(table: &str) -> bool {
    matches!(
        table,
        "app_identity"
            | "categories"
            | "products"
            | "product_images"
            | "pos_pages"
            | "pos_tiles"
            | "tax_rates"
            | "discounts"
            | "promo_groups"
            | "promo_group_items"
            | "employees"
            | "employee_attendance"
            | "settings"
            | "customers"
            | "registers"
            | "suppliers"
            | "product_suppliers"
            | "audit_logs"
            | "shifts"
            | "cash_movements"
            | "till_report_markers"
            | "manager_approvals"
            | "daily_sales_summary"
            | "tombstones"
    )
}

fn safe_mysql_column_name(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|character| character == '_' || character.is_ascii_alphanumeric())
}

fn generic_mysql_outbox_id_key_allowed(table: &str, id_key: &str) -> bool {
    if table == "settings" {
        id_key == "key"
    } else {
        id_key == "id"
    }
}

fn generic_tombstone_target_allowed(table: &str) -> bool {
    (generic_mysql_outbox_table_allowed(table) && !matches!(table, "settings" | "tombstones"))
        || matches!(table, "orders" | "order_lines")
}

fn validate_generic_tombstone(data: &serde_json::Value) -> Result<(), sqlx::Error> {
    let table = data
        .get("table_name")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let row_id = data
        .get("row_id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let id = data
        .get("id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    if !generic_tombstone_target_allowed(table)
        || row_id.trim().is_empty()
        || row_id.len() > 255
        || id != format!("{table}:{row_id}")
    {
        return Err(account_protocol_error("Invalid tombstone outbox row"));
    }
    Ok(())
}

fn json_mysql_value(value: &serde_json::Value) -> Result<RestoreValue, sqlx::Error> {
    match value {
        serde_json::Value::Null => Ok(RestoreValue::Null),
        serde_json::Value::Bool(value) => Ok(RestoreValue::Integer(i64::from(*value))),
        serde_json::Value::Number(value) => {
            if let Some(value) = value.as_i64() {
                Ok(RestoreValue::Integer(value))
            } else if let Some(value) = value.as_u64() {
                i64::try_from(value)
                    .map(RestoreValue::Integer)
                    .map_err(|_| account_protocol_error("Outbox integer is too large"))
            } else {
                value
                    .as_f64()
                    .map(RestoreValue::Real)
                    .ok_or_else(|| account_protocol_error("Invalid outbox number"))
            }
        }
        serde_json::Value::String(value) => Ok(RestoreValue::Text(value.clone())),
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => {
            Ok(RestoreValue::Text(value.to_string()))
        }
    }
}

fn normalized_outbox_mysql_value(
    table: &str,
    column: &str,
    value: &serde_json::Value,
) -> Result<RestoreValue, sqlx::Error> {
    if table == "products" && matches!(column, "barcode" | "scalePlu" | "sku") {
        if let Some(value) = value.as_str() {
            let value = value.trim();
            return if value.is_empty() {
                Ok(RestoreValue::Null)
            } else {
                Ok(RestoreValue::Text(value.to_string()))
            };
        }
    }
    if table == "customers" && column == "loyaltyCode" {
        if value.is_null() {
            return Ok(RestoreValue::Null);
        }
        let value = value.as_str().unwrap_or_default().trim().to_uppercase();
        if value.is_empty() {
            return Ok(RestoreValue::Null);
        }
        let valid = value.len() <= 32
            && value.chars().all(|character| {
                character.is_ascii_uppercase()
                    || character.is_ascii_digit()
                    || matches!(character, '.' | ' ' | '$' | '/' | '+' | '%' | '-')
            });
        if !valid {
            return Err(account_protocol_error(
                "Customer loyalty code has an invalid format",
            ));
        }
        return Ok(RestoreValue::Text(value));
    }
    json_mysql_value(value)
}

fn push_mysql_query_value<'args>(
    builder: &mut QueryBuilder<'args, MySql>,
    value: &'args RestoreValue,
) {
    match value {
        RestoreValue::Null => {
            builder.push_bind(Option::<String>::None);
        }
        RestoreValue::Integer(value) => {
            builder.push_bind(*value);
        }
        RestoreValue::Real(value) => {
            builder.push_bind(*value);
        }
        RestoreValue::Text(value) => {
            builder.push_bind(value);
        }
        RestoreValue::Blob(value) => {
            builder.push_bind(value);
        }
    }
}

async fn mysql_outbox_table_columns(
    tx: &mut sqlx::Transaction<'_, MySql>,
    table: &str,
) -> Result<HashSet<String>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
           AND EXTRA NOT LIKE '%GENERATED%'",
    )
    .bind(table)
    .fetch_all(&mut **tx)
    .await?;
    if rows.is_empty() {
        return Err(account_protocol_error(format!(
            "Outbox target table {table} does not exist"
        )));
    }
    rows.iter()
        .map(|row| row.try_get::<String, _>("COLUMN_NAME"))
        .collect()
}

const CUSTOMER_PROFILE_FIELDS: &[&str] = &[
    "name", "phone", "email", "postcode", "loyaltyCode", "notes",
];

fn normalized_customer_profile(
    value: &serde_json::Value,
) -> Result<serde_json::Value, sqlx::Error> {
    let object = value
        .as_object()
        .ok_or_else(|| account_protocol_error("Customer profile must be an object"))?;
    let mut profile = serde_json::Map::new();
    for &field in CUSTOMER_PROFILE_FIELDS {
        let text = match object.get(field) {
            None | Some(serde_json::Value::Null) => "",
            Some(serde_json::Value::String(text)) => text.trim(),
            Some(_) => return Err(account_protocol_error(format!("Customer {field} must be text"))),
        };
        let text = if matches!(field, "postcode" | "loyaltyCode") {
            text.to_uppercase()
        } else {
            text.to_string()
        };
        profile.insert(field.to_string(), serde_json::Value::String(text));
    }
    Ok(serde_json::Value::Object(profile))
}

#[derive(Debug, PartialEq)]
enum CustomerProfileSyncDecision {
    AlreadyApplied,
    Apply,
}

fn customer_profile_conflict() -> sqlx::Error {
    sync_conflict("CUSTOMER_PROFILE_CONFLICT: customer details changed on another till; reopen the customer and review the current details before saving")
}

fn customer_profile_sync_decision(
    current: Option<&serde_json::Value>,
    desired: &serde_json::Value,
    before: Option<&serde_json::Value>,
) -> Result<CustomerProfileSyncDecision, sqlx::Error> {
    let desired_profile = normalized_customer_profile(desired)?;
    let current_profile = current.map(normalized_customer_profile).transpose()?;
    if let Some(before) = before {
        let before_profile = if before.is_null() {
            None
        } else {
            Some(normalized_customer_profile(before)?)
        };
        // An ambiguous acknowledgement can be retried without changing the
        // balance, timestamp, or a profile another till has subsequently saved.
        if current_profile.as_ref() == Some(&desired_profile) {
            return Ok(CustomerProfileSyncDecision::AlreadyApplied);
        }
        if current_profile != before_profile {
            return Err(customer_profile_conflict());
        }
        return Ok(CustomerProfileSyncDecision::Apply);
    }
    // Legacy generic outbox entries have no editor snapshot. An unchanged
    // replay is safe, but never guess that a later save timestamp proves that
    // an old profile (or its loyalty balance) should replace the shared row.
    if let Some(current) = current_profile {
        if CUSTOMER_PROFILE_FIELDS.iter().any(|field| {
            desired.get(*field).is_some() && current[*field] != desired_profile[*field]
        }) {
            return Err(customer_profile_conflict());
        }
        return Ok(CustomerProfileSyncDecision::AlreadyApplied);
    }
    if desired.get("loyaltyPoints").is_some_and(|points| {
        !points.is_null() && points.as_i64() != Some(0) && points.as_str().map(str::trim) != Some("0")
    }) {
        return Err(sync_conflict("CUSTOMER_PROFILE_CONFLICT: a legacy customer creation contains loyalty points; reconcile its ledger before syncing instead of discarding or importing a balance"));
    }
    Ok(CustomerProfileSyncDecision::Apply)
}

fn customer_profile_operation_data(
    data: &serde_json::Value,
) -> Result<(serde_json::Value, &serde_json::Value), sqlx::Error> {
    let id = data.get("id").and_then(serde_json::Value::as_str)
        .filter(|id| !id.trim().is_empty() && id.len() <= 36)
        .ok_or_else(|| account_protocol_error("Customer profile ID is invalid"))?;
    let customer = data.get("customer")
        .ok_or_else(|| account_protocol_error("Customer profile is missing"))?;
    let before = data.get("before")
        .ok_or_else(|| account_protocol_error("Customer profile before-state is required"))?;
    if customer.get("id").and_then(serde_json::Value::as_str) != Some(id)
        || before.get("id").is_some_and(|value| value.as_str() != Some(id))
        || CUSTOMER_PROFILE_FIELDS.iter().any(|field| customer.get(*field).is_none())
        || (!before.is_null() && CUSTOMER_PROFILE_FIELDS.iter().any(|field| before.get(*field).is_none()))
    {
        return Err(account_protocol_error("Customer profile snapshot is incomplete or belongs to another customer"));
    }
    let mut profile = normalized_customer_profile(customer)?;
    if profile["name"].as_str().unwrap_or_default().is_empty() {
        return Err(account_protocol_error("Customer name is required"));
    }
    let object = profile.as_object_mut().expect("normalized customer object");
    object.insert("id".into(), serde_json::Value::String(id.into()));
    if let Some(created_at) = customer.get("createdAt") {
        object.insert("createdAt".into(), created_at.clone());
    }
    Ok((profile, before))
}

async fn mysql_customer_profile_for_update(
    tx: &mut sqlx::Transaction<'_, MySql>,
    customer_id: &str,
) -> Result<Option<serde_json::Value>, sqlx::Error> {
    let fields = CUSTOMER_PROFILE_FIELDS.iter()
        .map(|field| format!("'{field}', {}", mysql_identifier(field)))
        .collect::<Vec<_>>().join(", ");
    let row: Option<String> = sqlx::query_scalar(&format!(
        "SELECT CAST(JSON_OBJECT({fields}) AS CHAR CHARACTER SET utf8mb4)
         FROM customers WHERE id = ? LIMIT 1 FOR UPDATE"
    ))
    .bind(customer_id)
    .fetch_optional(&mut **tx)
    .await?;
    row.map(|row| serde_json::from_str(&row)
        .map_err(|_| account_protocol_error("Cannot decode current customer profile"))).transpose()
}

async fn mysql_epoch_fenced_outbox_upsert(
    tx: &mut sqlx::Transaction<'_, MySql>,
    table: &str,
    data: &serde_json::Value,
    id_key: &str,
    reject_newer_server_row: bool,
) -> Result<(), sqlx::Error> {
    mysql_epoch_fenced_outbox_upsert_with_customer_base(
        tx, table, data, id_key, reject_newer_server_row, None,
    ).await
}

async fn mysql_epoch_fenced_outbox_upsert_with_customer_base(
    tx: &mut sqlx::Transaction<'_, MySql>,
    table: &str,
    data: &serde_json::Value,
    id_key: &str,
    reject_newer_server_row: bool,
    customer_profile_before: Option<&serde_json::Value>,
) -> Result<(), sqlx::Error> {
    if !generic_mysql_outbox_table_allowed(table)
        || !safe_mysql_column_name(id_key)
        || !generic_mysql_outbox_id_key_allowed(table, id_key)
    {
        return Err(account_protocol_error("Unsupported outbox upsert target"));
    }
    let object = data
        .as_object()
        .ok_or_else(|| account_protocol_error("Outbox upsert data must be an object"))?;
    if table == "tombstones" {
        validate_generic_tombstone(data)?;
    }
    if table == "settings" {
        let key = object
            .get("key")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        if !is_restore_pushable_setting_key(key) {
            return Ok(());
        }
    }
    let remote_columns = mysql_outbox_table_columns(tx, table).await?;
    if !remote_columns.contains(id_key) {
        return Err(account_protocol_error(format!(
            "Outbox target {table} has no key column {id_key}"
        )));
    }
    let id_json = object
        .get(id_key)
        .ok_or_else(|| account_protocol_error("Outbox row is missing its key"))?;
    if table != "settings" && id_json.as_str().is_none_or(|value| value.trim().is_empty()) {
        return Err(account_protocol_error(
            "Outbox row id must be a nonempty string",
        ));
    }
    let id_value = normalized_outbox_mysql_value(table, id_key, id_json)?;
    if !matches!(table, "settings" | "tombstones") {
        let tombstoned: i64 = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM tombstones
                            WHERE table_name = ? AND row_id = ?)",
        )
        .bind(table)
        .bind(id_json.as_str().unwrap_or_default())
        .fetch_one(&mut **tx)
        .await?;
        if tombstoned != 0 {
            return Err(sync_conflict(format!(
                "{table}/{} was already deleted",
                id_json.as_str().unwrap_or_default()
            )));
        }
    }

    let mut customer_exists = false;
    if table == "customers" {
        let current = mysql_customer_profile_for_update(tx, id_json.as_str().unwrap_or_default()).await?;
        customer_exists = current.is_some();
        if customer_profile_sync_decision(current.as_ref(), data, customer_profile_before)?
            == CustomerProfileSyncDecision::AlreadyApplied
        {
            return Ok(());
        }
    }

    if table != "customers" && reject_newer_server_row && remote_columns.contains("updatedAt") {
        if let Some(incoming_stamp) = object
            .get("updatedAt")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.trim().is_empty())
        {
            let mut query = QueryBuilder::<MySql>::new(format!(
                "SELECT CAST(COALESCE(`updatedAt`, '') AS CHAR) FROM {} WHERE {} = ",
                mysql_identifier(table),
                mysql_identifier(id_key)
            ));
            push_mysql_query_value(&mut query, &id_value);
            query.push(" LIMIT 1 FOR UPDATE");
            let remote_stamp: Option<String> =
                query.build_query_scalar().fetch_optional(&mut **tx).await?;
            if remote_stamp
                .as_deref()
                .is_some_and(|stamp| !stamp.is_empty() && stamp > incoming_stamp)
            {
                return Err(sync_conflict(format!(
                    "server {table}/{} is newer",
                    id_json
                )));
            }
        }
    }

    let mut columns = Vec::new();
    let mut values = Vec::new();
    for (name, value) in object {
        if name == "updatedAt" || !remote_columns.contains(name) {
            continue;
        }
        // Financial balances have dedicated transactional ledger operations.
        // Customer profile sync must never import stale points or reset them.
        if table == "customers" && (name == "loyaltyPoints"
            || (customer_exists && name == "createdAt")
            || !(name == "id" || name == "createdAt" || CUSTOMER_PROFILE_FIELDS.contains(&name.as_str())))
        {
            continue;
        }
        columns.push(name.clone());
        values.push(normalized_outbox_mysql_value(table, name, value)?);
    }
    if table == "customers" && !customer_exists && remote_columns.contains("loyaltyPoints") {
        columns.push("loyaltyPoints".into());
        values.push(RestoreValue::Integer(0));
    }
    if !columns.iter().any(|column| column == id_key) {
        return Err(account_protocol_error("Outbox row key is not writable"));
    }
    if remote_columns.contains("updatedAt") {
        let stamp: String =
            sqlx::query_scalar("SELECT DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ')")
                .fetch_one(&mut **tx)
                .await?;
        columns.push("updatedAt".to_string());
        values.push(RestoreValue::Text(stamp));
    }

    // Lock and update by the declared identity. A broad ON DUPLICATE KEY
    // UPDATE could let a conflicting barcode, loyalty code, or tile position
    // overwrite a different row.
    let mut exists_query = QueryBuilder::<MySql>::new(format!(
        "SELECT 1 FROM {} WHERE {} = ",
        mysql_identifier(table),
        mysql_identifier(id_key)
    ));
    push_mysql_query_value(&mut exists_query, &id_value);
    exists_query.push(" LIMIT 1 FOR UPDATE");
    let exists: Option<i64> = exists_query
        .build_query_scalar()
        .fetch_optional(&mut **tx)
        .await?;

    // In READ COMMITTED an absent-row read need not hold a gap lock. If a
    // concurrent create appeared since the profile CAS read, never turn this
    // create into an update (which would also import its initial zero points).
    if table == "customers" && exists.is_some() != customer_exists {
        return Err(customer_profile_conflict());
    }

    if exists.is_some() {
        let update_pairs = columns
            .iter()
            .zip(values.iter())
            .filter(|(column, _)| column.as_str() != id_key)
            .collect::<Vec<_>>();
        if update_pairs.is_empty() {
            return Ok(());
        }
        let mut builder =
            QueryBuilder::<MySql>::new(format!("UPDATE {} SET ", mysql_identifier(table)));
        for (index, (column, value)) in update_pairs.into_iter().enumerate() {
            if index > 0 {
                builder.push(", ");
            }
            builder.push(mysql_identifier(column));
            builder.push(" = ");
            push_mysql_query_value(&mut builder, value);
        }
        builder.push(format!(" WHERE {} = ", mysql_identifier(id_key)));
        push_mysql_query_value(&mut builder, &id_value);
        return builder.build().execute(&mut **tx).await.map(|_| ());
    }

    let mut builder =
        QueryBuilder::<MySql>::new(format!("INSERT INTO {} (", mysql_identifier(table)));
    {
        let mut separated = builder.separated(", ");
        for column in &columns {
            separated.push(mysql_identifier(column));
        }
    }
    builder.push(") VALUES (");
    {
        let mut separated = builder.separated(", ");
        for value in &values {
            push_restore_value(&mut separated, value);
        }
    }
    builder.push(")");
    match builder.build().execute(&mut **tx).await {
        Ok(_) => Ok(()),
        Err(error)
            if table == "promo_group_items"
                && error
                    .to_string()
                    .to_ascii_lowercase()
                    .contains("duplicate entry") =>
        {
            Ok(())
        }
        Err(error)
            if error
                .to_string()
                .to_ascii_lowercase()
                .contains("duplicate entry") =>
        {
            Err(sync_conflict(error.to_string()))
        }
        Err(error) => Err(error),
    }
}

async fn mysql_epoch_fenced_outbox_remove(
    tx: &mut sqlx::Transaction<'_, MySql>,
    table: &str,
    data: &serde_json::Value,
    id_key: &str,
) -> Result<(), sqlx::Error> {
    if !generic_mysql_outbox_table_allowed(table)
        || !safe_mysql_column_name(id_key)
        || !generic_mysql_outbox_id_key_allowed(table, id_key)
    {
        return Err(account_protocol_error("Unsupported outbox delete target"));
    }
    let columns = mysql_outbox_table_columns(tx, table).await?;
    if !columns.contains(id_key) {
        return Err(account_protocol_error("Outbox delete key does not exist"));
    }
    let object = data
        .as_object()
        .ok_or_else(|| account_protocol_error("Outbox delete data must be an object"))?;
    if table == "tombstones" {
        return Err(account_protocol_error(
            "Tombstones cannot be removed by generic sync",
        ));
    }
    let id_json = object
        .get(id_key)
        .or_else(|| object.get("id"))
        .ok_or_else(|| account_protocol_error("Outbox delete is missing its key"))?;
    if table == "settings" {
        let key = id_json.as_str().unwrap_or_default();
        if !is_restore_pushable_setting_key(key) {
            return Ok(());
        }
    }
    let id_value = json_mysql_value(id_json)?;
    let mut builder = QueryBuilder::<MySql>::new(format!(
        "DELETE FROM {} WHERE {} = ",
        mysql_identifier(table),
        mysql_identifier(id_key)
    ));
    push_mysql_query_value(&mut builder, &id_value);
    builder.build().execute(&mut **tx).await?;
    Ok(())
}

fn validate_held_order_record(order: &OrderRecord) -> Result<(), sqlx::Error> {
    if order.id.trim().is_empty()
        || order.shift_id.trim().is_empty()
        || order.employee_id.trim().is_empty()
        || order.order_type != "sale"
        || order.status != "hold"
        || order.order_number != 0
        || !order.receipt_key.trim().is_empty()
        || !order.original_order_id.trim().is_empty()
        || !order.payment_method.trim().is_empty()
        || order.amount_tendered != 0
        || !order.completed_at.trim().is_empty()
    {
        return Err(account_protocol_error(
            "Only an unpaid, unreceipted sale on hold can use held-order sync",
        ));
    }
    Ok(())
}

// SQLite snapshots contain NULL for unused optional receipt fields. Normalize
// only optional text here, not identifiers, totals or paid/held status.
fn decode_held_order(data: &serde_json::Value) -> Result<OrderRecord, sqlx::Error> {
    let mut data = data.clone();
    if let Some(object) = data.as_object_mut() {
        for key in ["customerId", "receiptKey", "originalOrderId", "discountId", "notes", "paymentMethod", "completedAt"] {
            if object.get(key).is_none_or(serde_json::Value::is_null) {
                object.insert(key.into(), serde_json::Value::String(String::new()));
            }
        }
    }
    serde_json::from_value(data).map_err(|error| account_protocol_error(format!("Invalid held order: {error}")))
}

fn decode_held_line(data: &serde_json::Value) -> Result<OrderLineRecord, sqlx::Error> {
    let mut data = data.clone();
    if let Some(object) = data.as_object_mut() {
        for key in ["discountId", "notes"] {
            if object.get(key).is_none_or(serde_json::Value::is_null) {
                object.insert(key.into(), serde_json::Value::String(String::new()));
            }
        }
    }
    serde_json::from_value(data).map_err(|error| account_protocol_error(format!("Invalid held-order line: {error}")))
}

fn validate_held_order_line_record(line: &OrderLineRecord) -> Result<(), sqlx::Error> {
    if line.id.trim().is_empty()
        || line.order_id.trim().is_empty()
        || line.product_id.trim().is_empty()
        || line.quantity <= 0
        || !line.tax_rate.is_finite()
    {
        return Err(account_protocol_error("Invalid held-order line"));
    }
    Ok(())
}

async fn mysql_epoch_fenced_held_order_upsert(
    tx: &mut sqlx::Transaction<'_, MySql>,
    data: &serde_json::Value,
) -> Result<(), sqlx::Error> {
    let order = decode_held_order(data)?;
    validate_held_order_record(&order)?;
    let tombstoned: i64 = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM tombstones
                        WHERE table_name = 'orders' AND row_id = ?)",
    )
    .bind(&order.id)
    .fetch_one(&mut **tx)
    .await?;
    if tombstoned != 0 {
        return Err(sync_conflict("held order was already retrieved or deleted"));
    }
    let existing: Option<(String, String, String, String, String, i64, i64)> = sqlx::query_as(
        "SELECT CAST(COALESCE(type, '') AS CHAR),
                CAST(COALESCE(status, '') AS CHAR),
                CAST(COALESCE(receiptKey, '') AS CHAR),
                CAST(COALESCE(paymentMethod, '') AS CHAR),
                CAST(COALESCE(completedAt, '') AS CHAR),
                CAST(COALESCE(amountTendered, 0) AS SIGNED),
                (SELECT COUNT(*) FROM payments WHERE orderId = orders.id)
         FROM orders WHERE id = ? LIMIT 1 FOR UPDATE",
    )
    .bind(&order.id)
    .fetch_optional(&mut **tx)
    .await?;
    let order_exists = existing.is_some();
    if let Some((kind, status, receipt, method, completed, tendered, payment_count)) = existing {
        if kind != "sale"
            || status != "hold"
            || !receipt.is_empty()
            || !method.is_empty()
            || !completed.is_empty()
            || tendered != 0
            || payment_count != 0
        {
            return Err(sync_conflict(
                "order id belongs to a transaction that is not an unpaid hold",
            ));
        }
        if !order.updated_at.trim().is_empty() {
            let remote_updated: String = sqlx::query_scalar(
                "SELECT CAST(COALESCE(updatedAt, '') AS CHAR) FROM orders WHERE id = ?",
            )
            .bind(&order.id)
            .fetch_one(&mut **tx)
            .await?;
            if !remote_updated.is_empty() && remote_updated > order.updated_at {
                return Err(sync_conflict("server held order is newer"));
            }
        }
    }
    let stamp: String =
        sqlx::query_scalar("SELECT DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ')")
            .fetch_one(&mut **tx)
            .await?;
    let o = &order;
    if order_exists {
        sqlx::query(
            "UPDATE orders SET shiftId = ?, customerId = ?, employeeId = ?, subtotal = ?, discountId = ?,
                    discountAmount = ?, taxTotal = ?, total = ?, tillNumber = ?, notes = ?,
                    createdAt = ?, updatedAt = ? WHERE id = ? AND status = 'hold'",
        )
        .bind(&o.shift_id)
        .bind(&o.customer_id)
        .bind(&o.employee_id)
        .bind(o.subtotal)
        .bind(&o.discount_id)
        .bind(o.discount_amount)
        .bind(o.tax_total)
        .bind(o.total)
        .bind(&o.till_number)
        .bind(&o.notes)
        .bind(&o.created_at)
        .bind(&stamp)
        .bind(&o.id)
        .execute(&mut **tx)
        .await?;
    } else {
        sqlx::query(
            "INSERT INTO orders
             (id, shiftId, customerId, employeeId, orderNumber, receiptKey, type, status,
              originalOrderId, subtotal, discountId, discountAmount, taxTotal, total,
              tillNumber, notes, paymentMethod, amountTendered, createdAt, completedAt, updatedAt)
             VALUES (?, ?, ?, ?, 0, NULL, 'sale', 'hold', '', ?, ?, ?, ?, ?, ?, ?, '', 0, ?, NULL, ?)",
        )
        .bind(&o.id)
        .bind(&o.shift_id)
        .bind(&o.customer_id)
        .bind(&o.employee_id)
        .bind(o.subtotal)
        .bind(&o.discount_id)
        .bind(o.discount_amount)
        .bind(o.tax_total)
        .bind(o.total)
        .bind(&o.till_number)
        .bind(&o.notes)
        .bind(&o.created_at)
        .bind(&stamp)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

async fn mysql_epoch_fenced_held_order_line_upsert(
    tx: &mut sqlx::Transaction<'_, MySql>,
    data: &serde_json::Value,
) -> Result<(), sqlx::Error> {
    let line = decode_held_line(data)?;
    validate_held_order_line_record(&line)?;
    let parent: Option<(String, String, String, String, String, i64)> = sqlx::query_as(
        "SELECT CAST(COALESCE(type, '') AS CHAR), CAST(COALESCE(status, '') AS CHAR),
                CAST(COALESCE(receiptKey, '') AS CHAR),
                CAST(COALESCE(paymentMethod, '') AS CHAR),
                CAST(COALESCE(completedAt, '') AS CHAR),
                CAST(COALESCE(amountTendered, 0) AS SIGNED)
         FROM orders WHERE id = ? LIMIT 1 FOR UPDATE",
    )
    .bind(&line.order_id)
    .fetch_optional(&mut **tx)
    .await?;
    if !matches!(parent, Some((ref kind, ref status, ref receipt, ref method, ref completed, tendered))
        if kind == "sale" && status == "hold" && receipt.is_empty() && method.is_empty()
           && completed.is_empty() && tendered == 0)
    {
        return Err(sync_conflict(
            "held-order line has no locked unpaid hold parent",
        ));
    }
    let existing_order_id: Option<String> = sqlx::query_scalar(
        "SELECT CAST(orderId AS CHAR) FROM order_lines WHERE id = ? LIMIT 1 FOR UPDATE",
    )
    .bind(&line.id)
    .fetch_optional(&mut **tx)
    .await?;
    let line_exists = existing_order_id.is_some();
    if existing_order_id
        .as_deref()
        .is_some_and(|value| value != line.order_id)
    {
        return Err(sync_conflict("held-order line id belongs to another order"));
    }
    let stamp: String =
        sqlx::query_scalar("SELECT DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ')")
            .fetch_one(&mut **tx)
            .await?;
    let l = &line;
    if line_exists {
        sqlx::query(
            "UPDATE order_lines SET productId = ?, productName = ?, quantity = ?, unitPrice = ?,
                    costPrice = ?, discountId = ?, discountAmount = ?, taxRate = ?, taxAmount = ?,
                    lineTotal = ?, isPriceOverride = ?, originalPrice = ?, notes = ?, updatedAt = ?
             WHERE id = ? AND orderId = ?",
        )
        .bind(&l.product_id)
        .bind(&l.product_name)
        .bind(l.quantity)
        .bind(l.unit_price)
        .bind(l.cost_price)
        .bind(&l.discount_id)
        .bind(l.discount_amount)
        .bind(l.tax_rate)
        .bind(l.tax_amount)
        .bind(l.line_total)
        .bind(if l.is_price_override { 1 } else { 0 })
        .bind(l.original_price)
        .bind(&l.notes)
        .bind(&stamp)
        .bind(&l.id)
        .bind(&l.order_id)
        .execute(&mut **tx)
        .await?;
    } else {
        sqlx::query(
            "INSERT INTO order_lines
             (id, orderId, productId, productName, quantity, unitPrice, costPrice, discountId,
              discountAmount, taxRate, taxAmount, lineTotal, isPriceOverride, originalPrice, notes, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&l.id)
        .bind(&l.order_id)
        .bind(&l.product_id)
        .bind(&l.product_name)
        .bind(l.quantity)
        .bind(l.unit_price)
        .bind(l.cost_price)
        .bind(&l.discount_id)
        .bind(l.discount_amount)
        .bind(l.tax_rate)
        .bind(l.tax_amount)
        .bind(l.line_total)
        .bind(if l.is_price_override { 1 } else { 0 })
        .bind(l.original_price)
        .bind(&l.notes)
        .bind(&stamp)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

async fn held_snapshot_matches(
    tx: &mut sqlx::Transaction<'_, MySql>, table: &str, data: &serde_json::Value,
) -> Result<bool, sqlx::Error> {
    // Both callers supply serialized native records, never arbitrary columns.
    let fields = data.as_object().ok_or_else(|| account_protocol_error("Invalid held snapshot"))?
        .iter().filter(|(key, _)| key.as_str() != "updatedAt")
        .map(|(key, value)| Ok((key, value.is_string(), json_mysql_value(value)?)))
        .collect::<Result<Vec<_>, sqlx::Error>>()?;
    let mut query = QueryBuilder::<MySql>::new(format!("SELECT COUNT(*) FROM {} WHERE ", mysql_identifier(table)));
    let mut first = true;
    for (key, text, value) in &fields {
        if !first { query.push(" AND "); }
        first = false;
        if *text {
            query.push(format!("BINARY COALESCE({}, '') = BINARY ", mysql_identifier(key)));
        } else {
            query.push(format!("COALESCE({}, 0) = ", mysql_identifier(key)));
        }
        push_mysql_query_value(&mut query, value);
    }
    let count: i64 = query.build_query_scalar().fetch_one(&mut **tx).await?;
    Ok(count == 1)
}

async fn mysql_epoch_fenced_held_order_bundle(
    tx: &mut sqlx::Transaction<'_, MySql>, data: &serde_json::Value,
) -> Result<(), sqlx::Error> {
    let order = decode_held_order(&data["order"])?;
    validate_held_order_record(&order)?;
    let raw_lines = data["lines"].as_array().filter(|lines| !lines.is_empty() && lines.len() <= 1998)
        .ok_or_else(|| account_protocol_error("A held trolley needs matching item lines"))?;
    let mut ids = HashSet::new();
    let mut lines = Vec::new();
    for raw in raw_lines {
        let line = decode_held_line(raw)?;
        validate_held_order_line_record(&line)?;
        if line.order_id != order.id || !ids.insert(line.id.clone()) {
            return Err(account_protocol_error("Held trolley lines do not match their order"));
        }
        lines.push(line);
    }
    let tombstoned: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tombstones WHERE table_name = 'orders' AND row_id = ?")
        .bind(&order.id).fetch_one(&mut **tx).await?;
    if tombstoned != 0 { return Err(sync_conflict("held order was already retrieved or deleted")); }
    let existing: Option<String> = sqlx::query_scalar("SELECT CAST(id AS CHAR) FROM orders WHERE id = ? FOR UPDATE")
        .bind(&order.id).fetch_optional(&mut **tx).await?;
    if existing.is_some() {
        if !held_snapshot_matches(tx, "orders", &serde_json::to_value(&order).unwrap()).await? {
            return Err(sync_conflict("shared held trolley differs from this upload"));
        }
        let saved_ids: Vec<String> = sqlx::query_scalar("SELECT CAST(id AS CHAR) FROM order_lines WHERE orderId = ? FOR UPDATE")
            .bind(&order.id).fetch_all(&mut **tx).await?;
        if saved_ids.iter().any(|id| !ids.contains(id)) {
            return Err(sync_conflict("shared held trolley has different item lines"));
        }
        for line in &lines {
            if saved_ids.contains(&line.id)
                && !held_snapshot_matches(tx, "order_lines", &serde_json::to_value(line).unwrap()).await? {
                return Err(sync_conflict("shared held trolley item was changed"));
            }
        }
    } else {
        mysql_epoch_fenced_held_order_upsert(tx, &serde_json::to_value(&order).unwrap()).await?;
    }
    for line in lines {
        mysql_epoch_fenced_held_order_line_upsert(tx, &serde_json::to_value(line).unwrap()).await?;
    }
    Ok(())
}

async fn mysql_epoch_fenced_held_order_remove(
    tx: &mut sqlx::Transaction<'_, MySql>,
    data: &serde_json::Value,
) -> Result<bool, sqlx::Error> {
    let order_id = data
        .get("id")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| account_protocol_error("Held-order removal is missing its id"))?;
    let existing: Option<(String, String, String, String, String, i64, i64)> = sqlx::query_as(
        "SELECT CAST(COALESCE(type, '') AS CHAR), CAST(COALESCE(status, '') AS CHAR),
                CAST(COALESCE(receiptKey, '') AS CHAR),
                CAST(COALESCE(paymentMethod, '') AS CHAR),
                CAST(COALESCE(completedAt, '') AS CHAR),
                CAST(COALESCE(amountTendered, 0) AS SIGNED),
                (SELECT COUNT(*) FROM payments WHERE orderId = orders.id)
         FROM orders WHERE id = ? LIMIT 1 FOR UPDATE",
    )
    .bind(order_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some((kind, status, receipt, method, completed, tendered, payment_count)) = existing else {
        return Ok(false);
    };
    if kind != "sale"
        || status != "hold"
        || !receipt.is_empty()
        || !method.is_empty()
        || !completed.is_empty()
        || tendered != 0
        || payment_count != 0
    {
        return Err(sync_conflict(
            "only a missing or unpaid held order can be removed by generic sync",
        ));
    }
    let result = sqlx::query("DELETE FROM orders WHERE id = ? AND status = 'hold'")
        .bind(order_id)
        .execute(&mut **tx)
        .await?;
    Ok(result.rows_affected() == 1)
}

const PROMOTION_GROUP_TEXT: &[&str] = &["id", "name", "startAt", "endAt"];
const PROMOTION_DISCOUNT_TEXT: &[&str] = &["id", "name", "type", "kind", "groupId", "startAt", "endAt"];
const PROMOTION_DISCOUNT_NUMBERS: &[&str] = &["value", "minQuantity", "secondPrice", "bundleQuantity", "bundlePrice", "priority", "maxApplications"];

// Sync timestamps describe arrival at MariaDB, not the version the user edited.
// Compare the complete business snapshot instead, allowing a queued A -> B -> C
// chain and exact replay without ignoring edits made by another till.
fn normalized_promotion_snapshot(snapshot: &serde_json::Value) -> serde_json::Value {
    fn row(value: &serde_json::Value, text: &[&str], numbers: &[&str], booleans: &[&str]) -> serde_json::Value {
        let mut result = serde_json::Map::new();
        for field in text {
            result.insert((*field).into(), serde_json::Value::from(value[*field].as_str().unwrap_or_default()));
        }
        for field in numbers {
            let v = &value[*field];
            if *field == "maxApplications" && (v.is_null() || v.as_str() == Some("")) {
                result.insert((*field).into(), serde_json::Value::Null);
                continue;
            }
            let default = if *field == "minQuantity" { 1.0 } else { 0.0 };
            let number = v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok())).unwrap_or(default);
            result.insert((*field).into(), serde_json::json!(number));
        }
        for field in booleans {
            let v = &value[*field];
            let active = if v.is_null() { *field == "isActive" } else {
                v.as_bool().unwrap_or_else(|| v.as_i64() == Some(1) || matches!(v.as_str(), Some("1" | "true")))
            };
            result.insert((*field).into(), serde_json::Value::from(active));
        }
        serde_json::Value::Object(result)
    }
    let mut discounts = snapshot["discounts"].as_array().into_iter().flatten()
        .map(|value| row(value, PROMOTION_DISCOUNT_TEXT, PROMOTION_DISCOUNT_NUMBERS, &["isActive", "autoApply"]))
        .collect::<Vec<_>>();
    discounts.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    let mut items = snapshot["items"].as_array().into_iter().flatten()
        .map(|value| row(value, &["id", "groupId", "productId"], &[], &[])).collect::<Vec<_>>();
    items.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    serde_json::json!({
        "group": if snapshot["group"].is_null() { serde_json::Value::Null }
            else { row(&snapshot["group"], PROMOTION_GROUP_TEXT, &[], &["isActive"]) },
        "discounts": discounts, "items": items,
    })
}

#[derive(Debug, PartialEq)]
enum PromotionSyncDecision { AlreadyApplied, Apply, Legacy }

fn promotion_sync_decision(
    current: &serde_json::Value, desired: &serde_json::Value, base: Option<&serde_json::Value>,
) -> Result<PromotionSyncDecision, sqlx::Error> {
    let current = normalized_promotion_snapshot(current);
    if current == normalized_promotion_snapshot(desired) {
        return Ok(PromotionSyncDecision::AlreadyApplied);
    }
    match base {
        Some(base) if base.is_object() && base["discounts"].is_array() && base["items"].is_array() => {
            if current != normalized_promotion_snapshot(base) {
                return Err(sync_conflict("promotion was changed on another till; review the current offer before saving again"));
            }
            Ok(PromotionSyncDecision::Apply)
        }
        Some(_) => Err(account_protocol_error("Promotion before-state is invalid")),
        None => Ok(PromotionSyncDecision::Legacy),
    }
}

fn validate_promotion_numbers(discount: &serde_json::Value) -> Result<(), sqlx::Error> {
    for field in ["minQuantity", "bundleQuantity", "maxApplications"] {
        if discount[field].is_null() { continue; }
        let minimum = if field == "maxApplications" { 1 } else { 0 };
        if discount[field].as_i64().is_none_or(|value| value < minimum || value > i32::MAX as i64) {
            return Err(account_protocol_error(format!("Promotion {field} is outside the supported quantity range")));
        }
    }
    for field in ["secondPrice", "bundlePrice"] {
        if discount[field].is_null() { continue; }
        if discount[field].as_i64().is_none_or(|value| !(0..=9_007_199_254_740_991).contains(&value)) {
            return Err(account_protocol_error(format!("Promotion {field} must be a safe, nonnegative penny amount")));
        }
    }
    let kind = discount["kind"].as_str().unwrap_or_default();
    match kind {
        "bundle_fixed_price" if discount["bundleQuantity"].as_i64().unwrap_or(0) < 2
            || discount["bundlePrice"].as_i64().unwrap_or(0) <= 0 => {
            return Err(account_protocol_error("A bundle needs at least two items and a positive price"));
        }
        "bogo_fixed_price" if discount["minQuantity"].as_i64().unwrap_or(0) < 1 => {
            return Err(account_protocol_error("BOGO buy quantity must be positive"));
        }
        "temporary_item" | "manual_percent" => {
            let value = discount["value"].as_f64().unwrap_or(f64::NAN);
            let percentage = discount["type"].as_str() == Some("percentage");
            if !value.is_finite() || value <= 0.0 || (percentage && value > 100.0)
                || (!percentage && (value.fract() != 0.0 || value > 9_007_199_254_740_991.0)) {
                return Err(account_protocol_error("Promotion discount value is invalid"));
            }
        }
        _ => {}
    }
    Ok(())
}

async fn mysql_promotion_snapshot(
    tx: &mut sqlx::Transaction<'_, MySql>, group_id: &str, discount_ids: &[String],
) -> Result<serde_json::Value, sqlx::Error> {
    async fn rows(tx: &mut sqlx::Transaction<'_, MySql>, table: &str, fields: &[&str], predicate: &str, ids: &[String]) -> Result<Vec<serde_json::Value>, sqlx::Error> {
        let fields = fields.iter().map(|field| format!("'{field}', {}", mysql_identifier(field))).collect::<Vec<_>>().join(", ");
        let sql = format!("SELECT CAST(JSON_OBJECT({fields}) AS CHAR) FROM {} WHERE {predicate} FOR UPDATE", mysql_identifier(table));
        let mut query = sqlx::query_scalar::<_, String>(&sql);
        for id in ids { query = query.bind(id); }
        query.fetch_all(&mut **tx).await?.into_iter()
            .map(|row| serde_json::from_str(&row).map_err(|_| account_protocol_error("Cannot decode current promotion"))).collect()
    }
    let group = if group_id.is_empty() { None } else {
        let fields = [PROMOTION_GROUP_TEXT, &["isActive"]].concat();
        rows(tx, "promo_groups", &fields, "id = ?", &[group_id.to_string()]).await?.into_iter().next()
    };
    let mut params = discount_ids.to_vec();
    let mut predicates = Vec::new();
    if !params.is_empty() { predicates.push(format!("id IN ({})", vec!["?"; params.len()].join(", "))); }
    if !group_id.is_empty() { predicates.push("groupId = ?".into()); params.push(group_id.to_string()); }
    let discounts = if predicates.is_empty() { vec![] } else {
        let fields = [PROMOTION_DISCOUNT_TEXT, PROMOTION_DISCOUNT_NUMBERS, &["isActive", "autoApply"]].concat();
        rows(tx, "discounts", &fields, &predicates.join(" OR "), &params).await?
    };
    let items = if group_id.is_empty() { vec![] } else {
        rows(tx, "promo_group_items", &["id", "groupId", "productId"], "groupId = ?", &[group_id.to_string()]).await?
    };
    Ok(serde_json::json!({"group": group, "discounts": discounts, "items": items}))
}

async fn mysql_epoch_fenced_promotion_bundle(
    tx: &mut sqlx::Transaction<'_, MySql>,
    data: &serde_json::Value,
) -> Result<(), sqlx::Error> {
    let object = data
        .as_object()
        .ok_or_else(|| account_protocol_error("Promotion bundle must be an object"))?;
    let group = object
        .get("group")
        .ok_or_else(|| account_protocol_error("Promotion group is missing"))?;
    let discount = object
        .get("discount")
        .ok_or_else(|| account_protocol_error("Promotion discount is missing"))?;
    validate_promotion_numbers(discount)?;
    let items = object
        .get("items")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut products = object
        .get("products")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut known_product_ids = products
        .iter()
        .filter_map(|product| product.get("id").and_then(serde_json::Value::as_str))
        .map(str::to_string)
        .collect::<HashSet<_>>();
    for item in &items {
        let Some(product_id) = item
            .get("productId")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        if known_product_ids.insert(product_id.to_string()) {
            products.push(serde_json::json!({
                "id": product_id,
                "name": "Synced promotion item",
                "price": 0,
                "costPrice": 0,
            }));
        }
    }

    let group_id = if group.is_null() { "" } else {
        group.get("id").and_then(serde_json::Value::as_str).filter(|value| !value.trim().is_empty())
            .ok_or_else(|| account_protocol_error("Promotion group id is missing"))?
    };
    let discount_id = discount
        .get("id")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| account_protocol_error("Promotion discount id is missing"))?;
    if discount.get("groupId").and_then(serde_json::Value::as_str).unwrap_or_default() != group_id
        || (group_id.is_empty() && !items.is_empty()) {
        return Err(account_protocol_error(
            "Promotion discount does not belong to its group",
        ));
    }
    let mut item_ids_seen = HashSet::new();
    let mut product_ids_seen = HashSet::new();
    for item in &items {
        let item_id = item
            .get("id")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| account_protocol_error("Promotion item id is missing"))?;
        let item_group_id = item
            .get("groupId")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        let product_id = item
            .get("productId")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| account_protocol_error("Promotion item product id is missing"))?;
        if item_group_id != group_id
            || !item_ids_seen.insert(item_id)
            || !product_ids_seen.insert(product_id)
        {
            return Err(account_protocol_error(
                "Promotion items must be unique and belong to the supplied group",
            ));
        }
    }
    let current = mysql_promotion_snapshot(tx, group_id, &[discount_id.to_string()]).await?;
    let base = object.get("baseSnapshot");
    let previous_discounts = base.unwrap_or(&current)["discounts"].as_array().cloned().unwrap_or_default();
    let mut desired_discounts = previous_discounts.into_iter().filter(|row| row["id"].as_str() != Some(discount_id)).collect::<Vec<_>>();
    desired_discounts.push(discount.clone());
    let desired = serde_json::json!({ "group": group, "discounts": desired_discounts, "items": items });
    let decision = promotion_sync_decision(&current, &desired, base)?;
    if decision == PromotionSyncDecision::AlreadyApplied { return Ok(()); }

    let mut protected_rows = vec![("discounts", discount_id)];
    if !group_id.is_empty() { protected_rows.push(("promo_groups", group_id)); }
    protected_rows.extend(item_ids_seen.iter().map(|id| ("promo_group_items", *id)));
    for (table, row_id) in protected_rows {
        let tombstoned: i64 = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM tombstones
                            WHERE table_name = ? AND row_id = ?)",
        )
        .bind(table)
        .bind(row_id)
        .fetch_one(&mut **tx)
        .await?;
        if tombstoned != 0 {
            return Err(sync_conflict(format!(
                "promotion row {table}/{row_id} was already deleted"
            )));
        }
    }
    let incoming_revision = std::iter::once(group)
        .chain(std::iter::once(discount))
        .chain(items.iter())
        .filter_map(|row| row.get("updatedAt").and_then(serde_json::Value::as_str))
        .max()
        .unwrap_or_default();
    if decision == PromotionSyncDecision::Legacy && !incoming_revision.is_empty() {
        let remote_revision: Option<String> = sqlx::query_scalar(
            "SELECT MAX(revision) FROM (
               SELECT DATE_FORMAT(updatedAt, '%Y-%m-%dT%H:%i:%s.%fZ') AS revision
                 FROM promo_groups WHERE id = ?
               UNION ALL
               SELECT DATE_FORMAT(updatedAt, '%Y-%m-%dT%H:%i:%s.%fZ')
                 FROM discounts WHERE id = ? OR groupId = ?
               UNION ALL
               SELECT DATE_FORMAT(updatedAt, '%Y-%m-%dT%H:%i:%s.%fZ')
                 FROM promo_group_items WHERE groupId = ?
             ) revisions",
        )
        .bind(group_id)
        .bind(discount_id)
        .bind(group_id)
        .bind(group_id)
        .fetch_one(&mut **tx)
        .await?;
        if remote_revision
            .as_deref()
            .is_some_and(|revision| revision > incoming_revision)
        {
            return Err(sync_conflict("server promotion package is newer"));
        }
    }

    for product in products {
        let Some(product_id) = product.get("id").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let exists: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM products WHERE id = ?)")
            .bind(product_id)
            .fetch_one(&mut **tx)
            .await?;
        if exists == 0 {
            mysql_epoch_fenced_outbox_upsert(tx, "products", &product, "id", true).await?;
        }
    }
    // The CAS lock above protects new packages; comparing per-row server arrival
    // times again would reject legitimate offline edits to unchanged members.
    let reject_newer = decision == PromotionSyncDecision::Legacy;
    if !group_id.is_empty() {
        mysql_epoch_fenced_outbox_upsert(tx, "promo_groups", group, "id", reject_newer).await?;
    }
    mysql_epoch_fenced_outbox_upsert(tx, "discounts", discount, "id", reject_newer).await?;
    if group_id.is_empty() { return Ok(()); }

    let mut item_ids = Vec::new();
    for item in &items {
        let Some(item_id) = item.get("id").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let Some(item_group_id) = item.get("groupId").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let Some(product_id) = item.get("productId").and_then(serde_json::Value::as_str) else {
            continue;
        };
        sqlx::query(
            "DELETE FROM promo_group_items
             WHERE groupId = ? AND productId = ? AND id <> ?",
        )
        .bind(item_group_id)
        .bind(product_id)
        .bind(item_id)
        .execute(&mut **tx)
        .await?;
        mysql_epoch_fenced_outbox_upsert(tx, "promo_group_items", item, "id", reject_newer).await?;
        item_ids.push(item_id.to_string());
    }
    if item_ids.is_empty() {
        sqlx::query("DELETE FROM promo_group_items WHERE groupId = ?")
            .bind(group_id)
            .execute(&mut **tx)
            .await?;
    } else {
        let mut builder =
            QueryBuilder::<MySql>::new("DELETE FROM promo_group_items WHERE groupId = ");
        builder.push_bind(group_id);
        builder.push(" AND id NOT IN (");
        {
            let mut separated = builder.separated(", ");
            for item_id in &item_ids {
                separated.push_bind(item_id);
            }
        }
        builder.push(")");
        builder.build().execute(&mut **tx).await?;
    }
    let discount_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM discounts WHERE id = ?")
        .bind(discount_id)
        .fetch_one(&mut **tx)
        .await?;
    let item_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM promo_group_items WHERE groupId = ?")
            .bind(group_id)
            .fetch_one(&mut **tx)
            .await?;
    if discount_count != 1 || item_count != item_ids.len() as i64 {
        return Err(account_protocol_error(format!(
            "Promotion sync verification failed for group {group_id}"
        )));
    }
    Ok(())
}

async fn mysql_epoch_fenced_promotion_delete(
    tx: &mut sqlx::Transaction<'_, MySql>,
    data: &serde_json::Value,
) -> Result<(), sqlx::Error> {
    let object = data
        .as_object()
        .ok_or_else(|| account_protocol_error("Promotion delete must be an object"))?;
    let group_id = object
        .get("groupId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let mut discount_ids = object
        .get("discountIds")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    if let Some(discount_id) = object
        .get("discountId")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
    {
        discount_ids.push(discount_id.to_string());
    }
    discount_ids.sort();
    discount_ids.dedup();
    if let Some(base) = object.get("baseSnapshot") {
        let current = mysql_promotion_snapshot(tx, group_id, &discount_ids).await?;
        let desired = serde_json::json!({ "group": null, "discounts": [], "items": [] });
        if promotion_sync_decision(&current, &desired, Some(base))? == PromotionSyncDecision::AlreadyApplied {
            return Ok(());
        }
    }
    if !group_id.is_empty() {
        sqlx::query("DELETE FROM promo_group_items WHERE groupId = ?")
            .bind(group_id)
            .execute(&mut **tx)
            .await?;
    }
    if !discount_ids.is_empty() {
        let mut builder = QueryBuilder::<MySql>::new("DELETE FROM discounts WHERE ");
        if !group_id.is_empty() {
            builder.push("groupId = ");
            builder.push_bind(group_id);
            builder.push(" OR ");
        }
        builder.push("id IN (");
        {
            let mut separated = builder.separated(", ");
            for discount_id in &discount_ids {
                separated.push_bind(discount_id);
            }
        }
        builder.push(")");
        builder.build().execute(&mut **tx).await?;
    } else if !group_id.is_empty() {
        sqlx::query("DELETE FROM discounts WHERE groupId = ?")
            .bind(group_id)
            .execute(&mut **tx)
            .await?;
    }
    if !group_id.is_empty() {
        sqlx::query("DELETE FROM promo_groups WHERE id = ?")
            .bind(group_id)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}

async fn execute_mysql_epoch_fenced_outbox_operation(
    pool: &MySqlPool,
    table: &str,
    operation: &str,
    data: &serde_json::Value,
    id_key: &str,
    server_data_epoch: &str,
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    assert_mysql_restore_writes_allowed(&mut tx).await?;
    assert_mysql_server_data_epoch(&mut tx, server_data_epoch).await?;
    match operation {
        "customerProfile" if table == "customers" && id_key == "id" => {
            let (customer, before) = customer_profile_operation_data(data)?;
            mysql_epoch_fenced_outbox_upsert_with_customer_base(
                &mut tx, "customers", &customer, "id", false, Some(before),
            ).await?;
        }
        "heldOrderBundle" if table == "orders" => {
            mysql_epoch_fenced_held_order_bundle(&mut tx, data).await?;
        }
        "upsert" if table == "orders" => {
            mysql_epoch_fenced_held_order_upsert(&mut tx, data).await?;
        }
        "upsert" if table == "order_lines" => {
            mysql_epoch_fenced_held_order_line_upsert(&mut tx, data).await?;
        }
        "remove" if table == "orders" => {
            let _ = mysql_epoch_fenced_held_order_remove(&mut tx, data).await?;
        }
        "upsert" => {
            mysql_epoch_fenced_outbox_upsert(&mut tx, table, data, id_key, true).await?;
        }
        "remove" => {
            mysql_epoch_fenced_outbox_remove(&mut tx, table, data, id_key).await?;
        }
        "adjustStock" if table == "products" => {
            let product_id = data
                .get("id")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| account_protocol_error("Stock adjustment product is missing"))?;
            let delta = data
                .get("delta")
                .and_then(serde_json::Value::as_i64)
                .ok_or_else(|| account_protocol_error("Stock adjustment delta is invalid"))?;
            sqlx::query(
                "UPDATE products SET stockLevel = stockLevel + ?,
                 updatedAt = DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ')
                 WHERE id = ?",
            )
            .bind(delta)
            .bind(product_id)
            .execute(&mut *tx)
            .await?;
        }
        "promotionBundle" => {
            mysql_epoch_fenced_promotion_bundle(&mut tx, data).await?;
        }
        "promotionDelete" => {
            mysql_epoch_fenced_promotion_delete(&mut tx, data).await?;
        }
        "limitGoodsMenuItems" if table == "products" => {
            let stamp: String =
                sqlx::query_scalar("SELECT DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ')")
                    .fetch_one(&mut *tx)
                    .await?;
            sqlx::query("UPDATE products SET showInGoods = 0, goodsSortOrder = 0, updatedAt = ?")
                .bind(&stamp)
                .execute(&mut *tx)
                .await?;
            let product_ids: Vec<String> = sqlx::query_scalar(
                "SELECT CAST(id AS CHAR) FROM products
                 WHERE isActive = 1 ORDER BY name ASC LIMIT 10 FOR UPDATE",
            )
            .fetch_all(&mut *tx)
            .await?;
            for (index, product_id) in product_ids.iter().enumerate() {
                sqlx::query(
                    "UPDATE products SET showInGoods = 1, goodsSortOrder = ?, updatedAt = ?
                     WHERE id = ?",
                )
                .bind((index + 1) as i64)
                .bind(&stamp)
                .bind(product_id)
                .execute(&mut *tx)
                .await?;
            }
        }
        _ => return Err(account_protocol_error("Unsupported offline operation")),
    }
    tx.commit().await
}

#[tauri::command]
pub async fn commit_local_sale(
    app: AppHandle,
    bundle: SaleBundle,
    outbox_id: Option<String>,
) -> Result<CommitSaleResult, String> {
    crate::licensing::require_sale_access(&app).await?;
    let uri = format!("sqlite://{}?mode=rwc", local_db_path(&app)?.display());
    let pool = SqlitePool::connect(&uri).await.map_err(|e| e.to_string())?;
    let bundle = insert_sqlite_bundle_with_outbox(&pool, &bundle, outbox_id.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    Ok(CommitSaleResult { bundle })
}

#[tauri::command]
pub async fn commit_mysql_sale(mysql_uri: String, bundle: SaleBundle) -> Result<(), String> {
    let pool = connect_mysql_for_pos(&mysql_uri)
        .await
        .map_err(|e| e.to_string())?;
    insert_mysql_bundle(&pool, &bundle)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Replay a non-sale outbox operation under the same dataset-replacement
/// fence used by native financial commits. The allowlist and operation
/// dispatch remain native so renderer-provided table names can never turn
/// this into an unrestricted SQL endpoint.
#[tauri::command]
pub async fn commit_mysql_outbox_operation(
    mysql_uri: String,
    table_name: String,
    operation: String,
    data: serde_json::Value,
    id_key: Option<String>,
    server_data_epoch: Option<String>,
) -> Result<(), String> {
    let pool = connect_mysql_for_pos(&mysql_uri)
        .await
        .map_err(|error| error.to_string())?;
    execute_mysql_epoch_fenced_outbox_operation(
        &pool,
        table_name.trim(),
        operation.trim(),
        &data,
        id_key.as_deref().unwrap_or("id").trim(),
        server_data_epoch.as_deref().unwrap_or("").trim(),
    )
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn claim_mysql_held_order(
    mysql_uri: String,
    order_id: String,
    claim_id: String,
    server_data_epoch: Option<String>,
) -> Result<bool, String> {
    if claim_id.len() < 16 || claim_id.len() > 64 { return Err("A persistent trolley claim ID is required".into()); }
    let pool = connect_mysql_for_pos(&mysql_uri)
        .await
        .map_err(|error| error.to_string())?;
    let mut tx = pool.begin().await.map_err(|error| error.to_string())?;
    assert_mysql_restore_writes_allowed(&mut tx)
        .await
        .map_err(|error| error.to_string())?;
    assert_mysql_server_data_epoch(&mut tx, server_data_epoch.as_deref().unwrap_or("").trim())
        .await
        .map_err(|error| error.to_string())?;
    let existing: Option<(String, String)> = sqlx::query_as(
        "SELECT CAST(claimId AS CHAR), CAST(serverDataEpoch AS CHAR) FROM pos_held_order_claims WHERE orderId = ? AND serverDataEpoch = ?")
        .bind(&order_id).bind(server_data_epoch.as_deref().unwrap_or("")).fetch_optional(&mut *tx).await.map_err(|e| e.to_string())?;
    if let Some((owner, epoch)) = existing {
        return Ok(owner == claim_id && epoch == server_data_epoch.as_deref().unwrap_or(""));
    }
    let removed =
        mysql_epoch_fenced_held_order_remove(&mut tx, &serde_json::json!({ "id": &order_id }))
            .await
            .map_err(|error| error.to_string())?;
    if removed {
        sqlx::query("INSERT INTO pos_held_order_claims (orderId, claimId, serverDataEpoch, claimedAt) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE claimId = VALUES(claimId), serverDataEpoch = VALUES(serverDataEpoch), claimedAt = VALUES(claimedAt)")
            .bind(&order_id).bind(&claim_id).bind(server_data_epoch.as_deref().unwrap_or(""))
            .bind(chrono::Utc::now().to_rfc3339()).execute(&mut *tx).await.map_err(|e| e.to_string())?;
    }
    tx.commit().await.map_err(|error| error.to_string())?;
    if removed { return Ok(true); }
    // Another claimant may have committed while our DELETE waited for its row
    // lock. A fresh read resolves a retry of our own previously committed claim.
    let owner: Option<(String,)> = sqlx::query_as("SELECT CAST(claimId AS CHAR) FROM pos_held_order_claims WHERE orderId = ? AND serverDataEpoch = ?")
        .bind(&order_id).bind(server_data_epoch.as_deref().unwrap_or("")).fetch_optional(&pool).await.map_err(|e| e.to_string())?;
    match owner {
        Some((owner,)) => Ok(owner == claim_id),
        None => Err("HELD_ORDER_NOT_SHARED: This trolley is not available on the main database. Check its pending upload; it has not been confirmed as retrieved by another till.".into()),
    }
}

#[tauri::command]
pub async fn save_local_customer_account_config(
    app: AppHandle,
    input: SaveCustomerAccountConfigInput,
) -> Result<CustomerAccountRecord, String> {
    let uri = format!("sqlite://{}?mode=rwc", local_db_path(&app)?.display());
    let pool = SqlitePool::connect(&uri).await.map_err(|e| e.to_string())?;
    save_sqlite_customer_account_config(&pool, &input)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_online_customer_account_config(
    app: AppHandle,
    mysql_uri: String,
    input: SaveCustomerAccountConfigInput,
) -> Result<CustomerAccountRecord, String> {
    let mysql_pool = connect_mysql_for_pos(&mysql_uri)
        .await
        .map_err(|e| e.to_string())?;
    let account = save_mysql_customer_account_config(&mysql_pool, &input)
        .await
        .map_err(|e| e.to_string())?;
    let local_uri = format!("sqlite://{}?mode=rwc", local_db_path(&app)?.display());
    match SqlitePool::connect(&local_uri).await {
        Ok(local_pool) => {
            if let Err(error) = cache_sqlite_customer_account(&local_pool, &account).await {
                eprintln!(
                    "MariaDB accepted customer account settings but the local cache update failed; background sync will repair it: {error}"
                );
            }
        }
        Err(error) => eprintln!(
            "MariaDB accepted customer account settings but the local cache could not be opened; background sync will repair it: {error}"
        ),
    }
    Ok(account)
}

#[tauri::command]
pub async fn adjust_local_customer_loyalty(
    app: AppHandle,
    input: CustomerLoyaltyAdjustmentInput,
) -> Result<CustomerLoyaltyAdjustmentResult, String> {
    let input =
        normalize_customer_loyalty_adjustment_input(input).map_err(|error| error.to_string())?;
    let uri = format!("sqlite://{}?mode=rwc", local_db_path(&app)?.display());
    let pool = SqlitePool::connect(&uri)
        .await
        .map_err(|error| error.to_string())?;
    adjust_sqlite_customer_loyalty(&pool, &input)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn adjust_online_customer_loyalty(
    app: AppHandle,
    mysql_uri: String,
    input: CustomerLoyaltyAdjustmentInput,
) -> Result<CustomerLoyaltyAdjustmentResult, String> {
    let input =
        normalize_customer_loyalty_adjustment_input(input).map_err(|error| error.to_string())?;
    let mysql_pool = connect_mysql_for_pos(&mysql_uri)
        .await
        .map_err(|error| error.to_string())?;
    // Verify the permanent trigger layer before taking the in-transaction
    // close, restore, dataset-epoch, customer, and actor locks below.
    ensure_mysql_guarded_preflight_v4(&mysql_pool)
        .await
        .map_err(|error| error.to_string())?;
    let result = {
        let mut committed = None;
        let mut failure = None;
        for attempt in 0..MYSQL_TRANSACTION_RETRY_ATTEMPTS {
            match adjust_mysql_customer_loyalty(&mysql_pool, &input).await {
                Ok(result) => {
                    committed = Some(result);
                    break;
                }
                Err(error)
                    if attempt + 1 < MYSQL_TRANSACTION_RETRY_ATTEMPTS
                        && is_retryable_mysql_transaction_error(&error) =>
                {
                    continue;
                }
                Err(error) => {
                    failure = Some(error);
                    break;
                }
            }
        }
        match (committed, failure) {
            (Some(result), _) => result,
            (_, Some(error)) => return Err(error.to_string()),
            _ => unreachable!("MariaDB transaction retry loop always returns"),
        }
    };

    // MariaDB is authoritative. Do not report a committed correction as a
    // failure merely because this till's disposable cache could not be
    // refreshed; normal sync can repair it.
    match local_db_path(&app) {
        Ok(local_path) => {
            let local_uri = format!("sqlite://{}?mode=rwc", local_path.display());
            match SqlitePool::connect(&local_uri).await {
                Ok(local_pool) => {
                    if let Err(error) =
                        cache_sqlite_customer_loyalty_adjustment(&local_pool, &result).await
                    {
                        eprintln!(
                            "MariaDB accepted the loyalty correction but the local cache update failed; background sync will repair it: {error}"
                        );
                    }
                }
                Err(error) => eprintln!(
                    "MariaDB accepted the loyalty correction but the local cache could not be opened; background sync will repair it: {error}"
                ),
            }
        }
        Err(error) => eprintln!(
            "MariaDB accepted the loyalty correction but the local cache path was unavailable; background sync will repair it: {error}"
        ),
    }
    Ok(result)
}

#[tauri::command]
pub async fn commit_local_customer_account_entry(
    app: AppHandle,
    input: CustomerAccountChange,
) -> Result<CustomerAccountMutationResult, String> {
    let uri = format!("sqlite://{}?mode=rwc", local_db_path(&app)?.display());
    let pool = SqlitePool::connect(&uri).await.map_err(|e| e.to_string())?;
    post_sqlite_customer_account_entry(&pool, &input)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn commit_online_customer_account_entry(
    app: AppHandle,
    mysql_uri: String,
    input: CustomerAccountChange,
) -> Result<CustomerAccountMutationResult, String> {
    let mysql_pool = connect_mysql_for_pos(&mysql_uri)
        .await
        .map_err(|e| e.to_string())?;
    let result = post_mysql_customer_account_entry(&mysql_pool, &input)
        .await
        .map_err(|e| e.to_string())?;
    let local_uri = format!("sqlite://{}?mode=rwc", local_db_path(&app)?.display());
    match SqlitePool::connect(&local_uri).await {
        Ok(local_pool) => {
            if let Err(error) =
                cache_sqlite_customer_account_mutation(&local_pool, &result).await
            {
                eprintln!(
                    "MariaDB accepted the customer account entry but the local cache update failed; background sync will repair it: {error}"
                );
            }
        }
        Err(error) => eprintln!(
            "MariaDB accepted the customer account entry but the local cache could not be opened; background sync will repair it: {error}"
        ),
    }
    Ok(result)
}

#[tauri::command]
pub async fn delete_online_customer(
    app: AppHandle,
    mysql_uri: String,
    customer_id: String,
    server_data_epoch: Option<String>,
) -> Result<CustomerDeletionResult, String> {
    let mysql_pool = connect_mysql_for_pos(&mysql_uri)
        .await
        .map_err(|error| error.to_string())?;
    ensure_mysql_customer_deletion_guards(&mysql_pool)
        .await
        .map_err(|error| {
            format!("Could not install the MariaDB customer-deletion guards: {error}")
        })?;
    let result = delete_mysql_customer(
        &mysql_pool,
        &customer_id,
        server_data_epoch.as_deref().unwrap_or(""),
    )
    .await
    .map_err(|error| error.to_string())?;

    // MariaDB is authoritative. A local-cache failure must not turn a committed
    // deletion into an apparent failure that encourages unsafe workarounds;
    // an idempotent retry or normal tombstone sync will repair the cache.
    match local_db_path(&app) {
        Ok(path) => {
            let local_uri = format!("sqlite://{}?mode=rwc", path.display());
            match SqlitePool::connect(&local_uri).await {
                Ok(local_pool) => {
                    if let Err(error) = cleanup_sqlite_deleted_customer(&local_pool, &result).await {
                        eprintln!(
                            "MariaDB deleted customer {} but local cache cleanup failed; retry or tombstone sync will repair it: {error}",
                            result.customer_id
                        );
                    }
                }
                Err(error) => eprintln!(
                    "MariaDB deleted customer {} but the local cache could not be opened; tombstone sync will repair it: {error}",
                    result.customer_id
                ),
            }
        }
        Err(error) => eprintln!(
            "MariaDB deleted customer {} but its local cache path is unavailable; tombstone sync will repair it: {error}",
            result.customer_id
        ),
    }
    Ok(result)
}

#[tauri::command]
pub async fn commit_local_stock_receipt(
    app: AppHandle,
    bundle: StockReceiptBundle,
    outbox_id: Option<String>,
) -> Result<(), String> {
    let uri = format!("sqlite://{}?mode=rwc", local_db_path(&app)?.display());
    let pool = SqlitePool::connect(&uri).await.map_err(|e| e.to_string())?;
    insert_sqlite_stock_receipt_bundle(&pool, &bundle, outbox_id.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn commit_mysql_stock_receipt(
    mysql_uri: String,
    bundle: StockReceiptBundle,
) -> Result<(), String> {
    let pool = connect_mysql_for_pos(&mysql_uri)
        .await
        .map_err(|e| e.to_string())?;
    insert_mysql_stock_receipt_bundle(&pool, &bundle)
        .await
        .map_err(|e| e.to_string())
}

async fn replay_reserved_online_financial_intent(
    local_pool: &SqlitePool,
    mysql_pool: &MySqlPool,
    operation: &str,
    reserved: &SaleBundle,
    server_data_epoch: &str,
) -> Result<SaleBundle, sqlx::Error> {
    let committed =
        match insert_mysql_bundle_with_intent_epoch(mysql_pool, reserved, Some(server_data_epoch))
            .await
        {
            Ok(bundle) => bundle,
            Err(error) => {
                let _ = record_sqlite_online_financial_intent_error(local_pool, &error).await;
                return Err(error);
            }
        };
    if let Err(error) =
        update_sqlite_online_financial_intent_bundle(local_pool, operation, &committed).await
    {
        let _ = record_sqlite_online_financial_intent_error(local_pool, &error).await;
        return Err(error);
    }
    if let Err(error) =
        insert_sqlite_bundle_with_account_authority(local_pool, &committed, true, None).await
    {
        let _ = record_sqlite_online_financial_intent_error(local_pool, &error).await;
        return Err(error);
    }
    clear_sqlite_online_financial_intent(local_pool, operation, &committed.order.id).await?;
    Ok(committed)
}

async fn commit_new_online_financial_intent(
    app: &AppHandle,
    mysql_uri: &str,
    operation: &str,
    bundle: &SaleBundle,
    validate_reversal: bool,
) -> Result<SaleBundle, sqlx::Error> {
    let local_path = local_db_path(app).map_err(account_protocol_error)?;
    let local_uri = format!("sqlite://{}?mode=rwc", local_path.display());
    let local_pool = SqlitePool::connect(&local_uri).await?;
    // This SQLite commit is the point of no return for a new shared financial
    // operation. It reserves the receipt and journal before MariaDB is touched.
    let reserved =
        reserve_sqlite_online_financial_intent(&local_pool, operation, bundle, validate_reversal)
            .await?;
    let (saved_operation, saved_order, server_data_epoch) =
        load_sqlite_online_financial_intent(&local_pool)
            .await?
            .ok_or_else(|| {
                account_protocol_error("Online financial intent reservation was lost")
            })?;
    if saved_operation != operation || saved_order.order.id != reserved.order.id {
        return Err(account_protocol_error(
            "Online financial intent changed before MariaDB replay",
        ));
    }
    let mysql_pool = match connect_mysql_for_pos(mysql_uri).await {
        Ok(pool) => pool,
        Err(error) => {
            let _ = record_sqlite_online_financial_intent_error(&local_pool, &error).await;
            return Err(error);
        }
    };
    replay_reserved_online_financial_intent(
        &local_pool,
        &mysql_pool,
        operation,
        &reserved,
        &server_data_epoch,
    )
    .await
}

#[tauri::command]
pub async fn recover_online_financial_intent(
    app: AppHandle,
    mysql_uri: String,
) -> Result<Option<CommitSaleResult>, String> {
    let local_uri = format!("sqlite://{}?mode=rwc", local_db_path(&app)?.display());
    let local_pool = SqlitePool::connect(&local_uri)
        .await
        .map_err(|error| error.to_string())?;
    let Some((operation, reserved, server_data_epoch)) =
        load_sqlite_online_financial_intent(&local_pool)
            .await
            .map_err(|error| error.to_string())?
    else {
        return Ok(None);
    };
    if !matches!(
        operation.as_str(),
        "reversal" | "loyalty_sale" | "customer_account_sale"
    ) {
        return Err(format!(
            "Unknown online financial intent operation: {operation}"
        ));
    }
    let mysql_pool = connect_mysql_for_pos(&mysql_uri)
        .await
        .map_err(|error| error.to_string())?;
    let bundle = replay_reserved_online_financial_intent(
        &local_pool,
        &mysql_pool,
        &operation,
        &reserved,
        &server_data_epoch,
    )
    .await
    .map_err(|error| error.to_string())?;
    Ok(Some(CommitSaleResult { bundle }))
}

#[tauri::command]
pub async fn commit_online_reversal(
    app: AppHandle,
    mysql_uri: String,
    bundle: SaleBundle,
) -> Result<CommitSaleResult, String> {
    crate::licensing::require_sale_access(&app).await?;
    let bundle = commit_new_online_financial_intent(&app, &mysql_uri, "reversal", &bundle, true)
        .await
        .map_err(|error| error.to_string())?;
    Ok(CommitSaleResult { bundle })
}

#[tauri::command]
pub async fn commit_online_loyalty_sale(
    app: AppHandle,
    mysql_uri: String,
    bundle: SaleBundle,
) -> Result<CommitSaleResult, String> {
    crate::licensing::require_sale_access(&app).await?;
    let has_redemption = bundle
        .loyalty_changes
        .iter()
        .any(|change| change.reason == "redeemed" && change.points_change < 0);
    let invalid_change = bundle.loyalty_changes.iter().any(|change| {
        change.order_id != bundle.order.id
            || change.customer_id != bundle.order.customer_id
            || !matches!(change.reason.as_str(), "redeemed" | "earned")
    });
    if bundle.order.order_type != "sale"
        || bundle.order.customer_id.trim().is_empty()
        || !has_redemption
        || invalid_change
    {
        return Err("Invalid loyalty redemption sale".into());
    }

    let bundle =
        commit_new_online_financial_intent(&app, &mysql_uri, "loyalty_sale", &bundle, false)
            .await
            .map_err(|error| error.to_string())?;
    Ok(CommitSaleResult { bundle })
}

#[tauri::command]
pub async fn commit_online_customer_account_sale(
    app: AppHandle,
    mysql_uri: String,
    bundle: SaleBundle,
) -> Result<CommitSaleResult, String> {
    crate::licensing::require_sale_access(&app).await?;
    if bundle.order.order_type != "sale"
        || bundle.order.customer_id.trim().is_empty()
        || bundle.payment.account_amount <= 0
        || bundle.account_changes.is_empty()
        || bundle.account_changes.iter().any(|change| {
            change.customer_id != bundle.order.customer_id
                || change.order_id != bundle.order.id
                || change.entry_type != "charge"
                || change.amount_pence <= 0
        })
    {
        return Err("Invalid Pay Later sale".into());
    }

    let committed = commit_new_online_financial_intent(
        &app,
        &mysql_uri,
        "customer_account_sale",
        &bundle,
        false,
    )
    .await
    .map_err(|error| error.to_string())?;
    Ok(CommitSaleResult { bundle: committed })
}

async fn preserve_sqlite_receipt_high_water(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    stamp: &str,
) -> Result<(), sqlx::Error> {
    let settings: Vec<(String, String)> = sqlx::query_as(
        "SELECT key, COALESCE(value, '') FROM settings
         WHERE key IN ('till_seq', 'receipt_number_high_water')",
    )
    .fetch_all(&mut **tx)
    .await?;
    let setting = |key: &str| {
        settings
            .iter()
            .find(|row| row.0 == key)
            .and_then(|row| row.1.parse::<i64>().ok())
            .unwrap_or(0)
    };
    let till_seq = setting("till_seq").max(0);
    let saved_high_water = setting(RECEIPT_HIGH_WATER_KEY).max(0);
    let (max_issued, applicable_saved) = if till_seq > 0 {
        let block_start = till_seq * RECEIPT_BLOCK;
        let block_end = block_start + RECEIPT_BLOCK;
        let issued: Option<i64> = sqlx::query_scalar(
            "SELECT MAX(orderNumber) FROM orders
             WHERE orderNumber >= ? AND orderNumber < ?",
        )
        .bind(block_start)
        .bind(block_end)
        .fetch_one(&mut **tx)
        .await?;
        let saved = if saved_high_water >= block_start && saved_high_water < block_end {
            saved_high_water
        } else {
            0
        };
        (issued.unwrap_or(0), saved)
    } else {
        let issued: Option<i64> =
            sqlx::query_scalar("SELECT MAX(orderNumber) FROM orders WHERE orderNumber > 0")
                .fetch_one(&mut **tx)
                .await?;
        (issued.unwrap_or(0), saved_high_water)
    };
    let high_water = max_issued.max(applicable_saved);
    if high_water > 0 {
        sqlx::query(
            "INSERT INTO settings (key, value, updatedAt) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt",
        )
        .bind(RECEIPT_HIGH_WATER_KEY)
        .bind(high_water.to_string())
        .bind(stamp)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

async fn sqlite_purge_till_numbers(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    remote_till_numbers: &[String],
) -> Result<Vec<String>, sqlx::Error> {
    let rows: Vec<String> = sqlx::query_scalar(
        "SELECT tillNumber FROM (
            SELECT id AS tillNumber FROM registers
            UNION SELECT tillNumber FROM orders
            UNION SELECT registerId AS tillNumber FROM shifts
            UNION SELECT tillNumber FROM customer_account_entries
            UNION SELECT tillNumber FROM till_report_markers
         ) WHERE TRIM(COALESCE(tillNumber, '')) <> ''",
    )
    .fetch_all(&mut **tx)
    .await?;
    let mut tills: HashSet<String> = rows
        .into_iter()
        .chain(remote_till_numbers.iter().cloned())
        .filter(|value| !value.trim().is_empty())
        .collect();
    let mut tills: Vec<String> = tills.drain().collect();
    tills.sort();
    Ok(tills)
}

async fn purge_sqlite_transactions_before(
    pool: &SqlitePool,
    marker: &str,
    remote_till_numbers: &[String],
    fail_after_payments: bool,
) -> Result<TransactionPurgeResult, sqlx::Error> {
    if marker.trim().is_empty() {
        return Err(account_protocol_error(
            "Transaction purge marker is required",
        ));
    }
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    preserve_sqlite_receipt_high_water(&mut tx, marker).await?;
    let till_numbers = sqlite_purge_till_numbers(&mut tx, remote_till_numbers).await?;
    let old_order = "(createdAt IS NULL OR createdAt = '' OR createdAt <= ?)";
    let old_shift = "(openedAt IS NULL OR openedAt = '' OR openedAt <= ?)";

    sqlx::query(&format!(
        "DELETE FROM inventory_logs WHERE referenceId IN (SELECT id FROM orders WHERE {old_order})"
    ))
    .bind(marker)
    .execute(&mut *tx)
    .await?;
    sqlx::query(&format!(
        "DELETE FROM audit_logs
         WHERE entityId IN (SELECT id FROM orders WHERE {old_order})
            OR entityId IN (SELECT id FROM shifts WHERE {old_shift})
            OR ((entityType IN ('order','shift','cash_movement','report')
                 OR action IN ('sale_completed','order_refunded','order_partially_refunded',
                               'order_voided','refund_completed','report_period_closed'))
                AND (createdAt IS NULL OR createdAt = '' OR createdAt <= ?))"
    ))
    .bind(marker)
    .bind(marker)
    .bind(marker)
    .execute(&mut *tx)
    .await?;
    sqlx::query(&format!(
        "DELETE FROM manager_approvals
         WHERE entityId IN (SELECT id FROM orders WHERE {old_order})
            OR ((entityType = 'order' OR action = 'refund_void')
                AND (createdAt IS NULL OR createdAt = '' OR createdAt <= ?))"
    ))
    .bind(marker)
    .bind(marker)
    .execute(&mut *tx)
    .await?;
    sqlx::query(&format!(
        "DELETE FROM payments WHERE orderId IN (SELECT id FROM orders WHERE {old_order})"
    ))
    .bind(marker)
    .execute(&mut *tx)
    .await?;
    if fail_after_payments {
        tx.rollback().await?;
        return Err(account_protocol_error("forced transaction purge failure"));
    }
    sqlx::query(
        "DELETE FROM payment_terminal_attempts
         WHERE status NOT IN ('prepared','started','uncertain','approved','commit_failed','completion_pending')
           AND (createdAt IS NULL OR createdAt = '' OR createdAt <= ?)",
    )
    .bind(marker)
    .execute(&mut *tx)
    .await?;
    sqlx::query(&format!(
        "DELETE FROM order_lines WHERE orderId IN (SELECT id FROM orders WHERE {old_order})"
    ))
    .bind(marker)
    .execute(&mut *tx)
    .await?;
    sqlx::query(&format!(
        "DELETE FROM cash_movements WHERE shiftId IN (SELECT id FROM shifts WHERE {old_shift})"
    ))
    .bind(marker)
    .execute(&mut *tx)
    .await?;
    sqlx::query(&format!("DELETE FROM orders WHERE {old_order}"))
        .bind(marker)
        .execute(&mut *tx)
        .await?;
    sqlx::query(&format!("DELETE FROM shifts WHERE {old_shift}"))
        .bind(marker)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM daily_sales_summary")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM till_report_markers")
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "DELETE FROM _offline_queue
         WHERE created_at <= ?
           AND operation <> 'saleBundle'
           AND table_name IN ('orders','order_lines','payments','shifts','cash_movements',
                              'inventory_logs','audit_logs','manager_approvals')",
    )
    .bind(marker)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "DELETE FROM tombstones
         WHERE table_name IN ('orders','order_lines','payments','shifts','cash_movements',
                              'inventory_logs','audit_logs','manager_approvals')
           AND (deletedAt IS NULL OR deletedAt = '' OR deletedAt <= ?)",
    )
    .bind(marker)
    .execute(&mut *tx)
    .await?;

    for till_number in std::iter::once("").chain(till_numbers.iter().map(String::as_str)) {
        sqlx::query(
            "INSERT INTO till_report_markers
                (id, tillNumber, type, markerTime, periodStart, periodEnd, employeeId,
                 reportText, reportTotal, createdAt, updatedAt)
             VALUES (?, ?, 'period', ?, ?, ?, '', 'Transaction history purge baseline', 0, ?, ?)",
        )
        .bind(random_record_id())
        .bind(till_number)
        .bind(marker)
        .bind(marker)
        .bind(marker)
        .bind(marker)
        .bind(marker)
        .execute(&mut *tx)
        .await?;
    }
    for key in ["transaction_purge_at", "transaction_purge_applied_at"] {
        sqlx::query(
            "INSERT INTO settings (key, value, updatedAt) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt",
        )
        .bind(key)
        .bind(marker)
        .bind(marker)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(TransactionPurgeResult {
        marker: marker.into(),
        till_numbers,
    })
}

#[tauri::command]
pub async fn purge_local_transactions(
    app: AppHandle,
    marker: String,
    remote_till_numbers: Vec<String>,
) -> Result<TransactionPurgeResult, String> {
    let uri = format!("sqlite://{}?mode=rwc", local_db_path(&app)?.display());
    let pool = SqlitePool::connect(&uri)
        .await
        .map_err(|error| error.to_string())?;
    purge_sqlite_transactions_before(&pool, marker.trim(), &remote_till_numbers, false)
        .await
        .map_err(|error| error.to_string())
}

fn new_whole_system_close_token() -> String {
    let mut random = [0_u8; 24];
    OsRng.fill_bytes(&mut random);
    random.iter().map(|byte| format!("{byte:02x}")).collect()
}

async fn cleanup_expired_whole_system_close(
    tx: &mut sqlx::Transaction<'_, MySql>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE pos_close_barrier
         SET token = '', state = 'idle', ownerTillId = '',
             requestedAt = NULL, expiresAt = NULL, cutoffAt = NULL
         WHERE id = 1 AND state <> 'idle'
           AND expiresAt IS NOT NULL AND expiresAt <= UTC_TIMESTAMP(3)",
    )
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn locked_whole_system_close_barrier(
    tx: &mut sqlx::Transaction<'_, MySql>,
) -> Result<WholeSystemCloseBarrierResult, sqlx::Error> {
    let row = sqlx::query(MYSQL_CLOSE_BARRIER_LOCK_SELECT)
        .fetch_one(&mut **tx)
        .await?;
    Ok(WholeSystemCloseBarrierResult {
        token: row.try_get("token")?,
        state: row.try_get("state")?,
        owner_till_id: row.try_get("ownerTillId")?,
        requested_at: row.try_get("requestedAt")?,
        expires_at: row.try_get("expiresAt")?,
        cutoff_at: row.try_get("cutoffAt")?,
        latest_marker: None,
    })
}

async fn latest_system_report_marker(
    tx: &mut sqlx::Transaction<'_, MySql>,
    lock: bool,
) -> Result<Option<String>, sqlx::Error> {
    let suffix = if lock { " FOR UPDATE" } else { "" };
    sqlx::query_scalar(&format!(
        "SELECT CAST(markerTime AS CHAR) FROM till_report_markers
         WHERE tillNumber = '' AND type = 'period'
         ORDER BY markerTime DESC LIMIT 1{suffix}"
    ))
    .fetch_optional(&mut **tx)
    .await
}

async fn latest_effective_till_report_marker(
    tx: &mut sqlx::Transaction<'_, MySql>,
    till_number: &str,
) -> Result<Option<String>, sqlx::Error> {
    let marker: Option<String> = sqlx::query_scalar(
        "SELECT CAST(markerTime AS CHAR) FROM till_report_markers
         WHERE type = 'period' AND (tillNumber = '' OR tillNumber = ?)
         ORDER BY markerTime DESC LIMIT 1",
    )
    .bind(till_number)
    .fetch_optional(&mut **tx)
    .await?;
    canonical_optional_report_epoch(marker.as_deref())
}

fn validate_whole_system_close_owner(
    barrier: &WholeSystemCloseBarrierResult,
    token: &str,
    owner_till_id: &str,
    expected_state: &str,
) -> Result<(), sqlx::Error> {
    if barrier.state != expected_state
        || barrier.token != token
        || barrier.owner_till_id != owner_till_id
    {
        return Err(account_protocol_error(
            "WHOLE_SYSTEM_CLOSE_TOKEN_INVALID: this whole-system close is no longer active",
        ));
    }
    Ok(())
}

fn mysql_whole_system_close_readiness_select() -> String {
    format!(
        "SELECT CAST(r.id AS CHAR CHARACTER SET utf8mb4) AS tillId,
                CAST(COALESCE(NULLIF(r.name, ''), r.id) AS CHAR CHARACTER SET utf8mb4) AS tillName,
                CASE WHEN p.tillId IS NOT NULL
                           AND p.lastSeenAt >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL {WHOLE_SYSTEM_CLOSE_ONLINE_SECONDS} SECOND)
                     THEN 1 ELSE 0 END AS isOnline,
                COALESCE(p.closeProtocolVersion, 0) AS protocolVersion,
                CAST(COALESCE(p.closeBarrierToken, '') AS CHAR CHARACTER SET utf8mb4) AS barrierToken,
                CAST(COALESCE(p.closeBarrierPhase, '') AS CHAR CHARACTER SET utf8mb4) AS barrierPhase,
                COALESCE(p.outboxCount, 0) AS outboxCount,
                COALESCE(p.localTerminalAttemptCount, 0) AS terminalCount,
                COALESCE(p.syncConflictCount, 0) AS conflictCount
         FROM registers r
         LEFT JOIN till_presence p
           ON p.tillId = CONVERT(r.id USING utf8mb4) COLLATE utf8mb4_bin
         WHERE COALESCE(r.isActive, 1) <> 0
           AND r.id NOT IN ('register-main', 'legacy-till')
         ORDER BY r.name, r.id"
    )
}

struct WholeSystemCloseTillReadiness {
    till_id: String,
    till_name: String,
    online: i64,
    protocol: i64,
    observed_token: String,
    observed_phase: String,
    outbox: i64,
    terminals: i64,
    conflicts: i64,
}

fn whole_system_close_till_label(till_id: &str, till_name: &str, duplicate_name: bool) -> String {
    if !duplicate_name || till_id.trim().is_empty() {
        return till_name.into();
    }
    let short_id = till_id.chars().take(8).collect::<String>();
    format!("{till_name} [{short_id}]")
}

async fn whole_system_close_readiness_issues(
    tx: &mut sqlx::Transaction<'_, MySql>,
    token: &str,
    phase: &str,
) -> Result<Vec<String>, sqlx::Error> {
    let select = mysql_whole_system_close_readiness_select();
    let rows = sqlx::query(&select).fetch_all(&mut **tx).await?;
    if rows.is_empty() {
        return Ok(vec![
            "No active installed till is registered in MariaDB".into()
        ]);
    }
    let readiness = rows
        .into_iter()
        .map(|row| {
            Ok(WholeSystemCloseTillReadiness {
                till_id: row.try_get("tillId")?,
                till_name: row.try_get("tillName")?,
                online: row.try_get("isOnline")?,
                protocol: row.try_get("protocolVersion")?,
                observed_token: row.try_get("barrierToken")?,
                observed_phase: row.try_get("barrierPhase")?,
                outbox: row.try_get("outboxCount")?,
                terminals: row.try_get("terminalCount")?,
                conflicts: row.try_get("conflictCount")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()?;
    let mut name_counts = HashMap::<String, usize>::new();
    for till in &readiness {
        *name_counts
            .entry(till.till_name.trim().to_lowercase())
            .or_default() += 1;
    }

    let mut issues = Vec::new();
    for till in readiness {
        let duplicate_name = name_counts
            .get(&till.till_name.trim().to_lowercase())
            .copied()
            .unwrap_or_default()
            > 1;
        let label = whole_system_close_till_label(&till.till_id, &till.till_name, duplicate_name);
        if till.online == 0 {
            issues.push(format!("{label} is offline"));
        } else if till.protocol < WHOLE_SYSTEM_CLOSE_PROTOCOL_VERSION {
            issues.push(format!("{label} must update to the current close protocol"));
        } else if till.observed_token != token || till.observed_phase != phase {
            issues.push(format!("{label} has not acknowledged the {phase} phase"));
        } else if till.outbox > 0 {
            issues.push(format!(
                "{label} still has {} queued change(s)",
                till.outbox
            ));
        } else if till.conflicts > 0 {
            issues.push(format!(
                "{label} has {} unresolved sync conflict(s)",
                till.conflicts
            ));
        } else if till.terminals > 0 {
            issues.push(format!(
                "{label} has {} terminal payment attempt(s) to recover",
                till.terminals
            ));
        }
    }
    Ok(issues)
}

async fn assert_remote_terminal_journal_empty(
    tx: &mut sqlx::Transaction<'_, MySql>,
) -> Result<(), sqlx::Error> {
    let exists: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payment_terminal_attempts'",
    )
    .fetch_one(&mut **tx)
    .await?;
    if exists == 0 {
        return Err(account_protocol_error(
            "Whole-system close cannot verify the remote terminal journal",
        ));
    }
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM payment_terminal_attempts
         WHERE status IN ('prepared', 'started', 'uncertain', 'approved',
                          'commit_failed', 'completion_pending')",
    )
    .fetch_one(&mut **tx)
    .await?;
    if count > 0 {
        return Err(account_protocol_error(format!(
            "{WHOLE_SYSTEM_CLOSE_WAITING_CODE}: MariaDB has {count} terminal payment attempt(s) to recover"
        )));
    }
    Ok(())
}

async fn assert_remote_till_terminal_journal_empty(
    tx: &mut sqlx::Transaction<'_, MySql>,
    till_number: &str,
) -> Result<(), sqlx::Error> {
    let exists: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payment_terminal_attempts'",
    )
    .fetch_one(&mut **tx)
    .await?;
    if exists == 0 {
        return Err(account_protocol_error(
            "Till close cannot verify the remote terminal journal",
        ));
    }
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM payment_terminal_attempts
         WHERE (tillId = ? OR TRIM(COALESCE(tillId, '')) = '')
           AND status IN ('prepared', 'started', 'uncertain', 'approved',
                          'commit_failed', 'completion_pending')",
    )
    .bind(till_number)
    .fetch_one(&mut **tx)
    .await?;
    if count > 0 {
        return Err(account_protocol_error(format!(
            "TERMINAL_RECOVERY_PENDING: this till has {count} card payment attempt(s) to complete or recover before its Z report can close"
        )));
    }
    Ok(())
}

fn validate_report_close_marker(
    latest_marker: Option<&str>,
    expected_marker: Option<&str>,
) -> Result<(), sqlx::Error> {
    if latest_marker == expected_marker {
        return Ok(());
    }
    Err(account_protocol_error(
        "REPORT_PERIOD_CHANGED: another manager already closed this reporting period; refresh the report",
    ))
}

fn canonical_optional_report_epoch(value: Option<&str>) -> Result<Option<String>, sqlx::Error> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(canonical_report_epoch)
        .transpose()
}

fn canonical_report_period_bounds(
    period_start: &str,
    period_end: &str,
) -> Result<(String, String), sqlx::Error> {
    let start = canonical_report_epoch(period_start)?;
    let end = canonical_report_epoch(period_end)?;
    if start.is_empty() || end.is_empty() {
        return Err(account_protocol_error(
            "REPORT_PERIOD_INVALID: report period bounds are required",
        ));
    }
    let start_stamp = chrono::DateTime::parse_from_rfc3339(&start)
        .map_err(|error| account_protocol_error(format!("REPORT_PERIOD_INVALID: {error}")))?;
    let end_stamp = chrono::DateTime::parse_from_rfc3339(&end)
        .map_err(|error| account_protocol_error(format!("REPORT_PERIOD_INVALID: {error}")))?;
    if start_stamp >= end_stamp {
        return Err(account_protocol_error(
            "REPORT_PERIOD_INVALID: report period start must be before its server cutoff",
        ));
    }
    Ok((start, end))
}

fn validate_till_report_close_request(
    latest_marker: Option<&str>,
    expected_marker: Option<&str>,
    period_start: &str,
    period_end: &str,
    latest_allowed_cutoff: &str,
) -> Result<(String, String), sqlx::Error> {
    let latest = canonical_optional_report_epoch(latest_marker)?;
    let expected = canonical_optional_report_epoch(expected_marker)?;
    validate_report_close_marker(latest.as_deref(), expected.as_deref())?;

    let (start, end) = canonical_report_period_bounds(period_start, period_end)?;
    let expected_start = latest.as_deref().unwrap_or(REPORT_PERIOD_ORIGIN);
    if start != expected_start {
        return Err(account_protocol_error(
            "REPORT_PERIOD_CHANGED: the till report no longer starts at the latest effective marker; generate a fresh report",
        ));
    }
    let latest_allowed = canonical_report_epoch(latest_allowed_cutoff)?;
    if latest_allowed.is_empty() || end > latest_allowed {
        return Err(account_protocol_error(
            "REPORT_CUTOFF_INVALID: the till report cutoff is ahead of MariaDB server time",
        ));
    }
    Ok((start, end))
}

/// Build a closable per-till report from one authoritative MariaDB snapshot.
/// The barrier lock waits for every earlier financial writer and stays held
/// until all report sections have been read. The sampled server tick is the
/// exclusive upper bound: a later writer stamped on the same millisecond is
/// deliberately deferred to the next period instead of racing this snapshot.
#[tauri::command]
pub async fn prepare_till_report_close(
    mysql_uri: String,
    till_number: String,
) -> Result<PreparedTillReportClose, String> {
    let till_number = till_number.trim();
    if till_number.is_empty() {
        return Err("A closable till report requires this till's stable ID".into());
    }
    let pool = connect_mysql_for_whole_system_close(&mysql_uri)
        .await
        .map_err(|error| error.to_string())?;
    tokio::time::timeout(
        Duration::from_secs(WHOLE_SYSTEM_CLOSE_SCHEMA_PREPARE_TIMEOUT_SECONDS),
        ensure_mysql_whole_system_close_schema(&pool),
    )
    .await
    .map_err(|_| {
        format!(
            "{WHOLE_SYSTEM_CLOSE_SETUP_TIMEOUT_CODE}: MariaDB report safety setup stayed busy; no till report was opened"
        )
    })?
    .map_err(|error| error.to_string())?;

    let mut tx = pool.begin().await.map_err(|error| error.to_string())?;
    cleanup_expired_whole_system_close(&mut tx)
        .await
        .map_err(|error| error.to_string())?;
    assert_mysql_restore_writes_allowed(&mut tx)
        .await
        .map_err(|error| error.to_string())?;
    let barrier = locked_whole_system_close_barrier(&mut tx)
        .await
        .map_err(|error| error.to_string())?;
    if barrier.state != "idle" {
        return Err(format!(
            "{WHOLE_SYSTEM_CLOSE_IN_PROGRESS_CODE}: another report close is already in progress"
        ));
    }
    assert_mysql_whole_system_close_guards_ready(&mut tx)
        .await
        .map_err(|error| error.to_string())?;
    assert_remote_till_terminal_journal_empty(&mut tx, till_number)
        .await
        .map_err(|error| error.to_string())?;

    let expected_last_marker = latest_effective_till_report_marker(&mut tx, till_number)
        .await
        .map_err(|error| error.to_string())?;
    let period_start = expected_last_marker
        .clone()
        .unwrap_or_else(|| REPORT_PERIOD_ORIGIN.into());
    let server_tick: String =
        sqlx::query_scalar("SELECT DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ')")
            .fetch_one(&mut *tx)
            .await
            .map_err(|error| error.to_string())?;
    let cutoff_at = canonical_report_epoch(&server_tick).map_err(|error| error.to_string())?;
    canonical_report_period_bounds(&period_start, &cutoff_at).map_err(|error| error.to_string())?;

    let report = tokio::time::timeout(
        Duration::from_secs(WHOLE_SYSTEM_CLOSE_REPORT_LOAD_TIMEOUT_SECONDS),
        load_frozen_whole_system_report(&mut tx, &period_start, &cutoff_at, Some(till_number)),
    )
    .await;
    let (overview, breakdown, top_products, till_summaries) = match report {
        Ok(Ok(report)) => report,
        Ok(Err(error)) => return Err(error.to_string()),
        Err(_) => {
            return Err(format!(
                "{WHOLE_SYSTEM_CLOSE_REPORT_TIMEOUT_CODE}: authoritative till report totals exceeded {WHOLE_SYSTEM_CLOSE_REPORT_LOAD_TIMEOUT_SECONDS} seconds; try again"
            ))
        }
    };
    tx.commit().await.map_err(|error| error.to_string())?;
    Ok(PreparedTillReportClose {
        expected_last_marker,
        period_start,
        cutoff_at,
        overview,
        breakdown,
        top_products,
        till_summaries,
    })
}

#[tauri::command]
pub async fn begin_whole_system_close(
    mysql_uri: String,
    owner_till_id: String,
) -> Result<WholeSystemCloseBarrierResult, String> {
    if owner_till_id.trim().is_empty() {
        return Err("Whole-system close requires this till's stable ID".into());
    }
    let pool = connect_mysql_for_whole_system_close(&mysql_uri)
        .await
        .map_err(|error| error.to_string())?;
    tokio::time::timeout(
        Duration::from_secs(WHOLE_SYSTEM_CLOSE_SCHEMA_PREPARE_TIMEOUT_SECONDS),
        ensure_mysql_whole_system_close_schema(&pool),
    )
        .await
        .map_err(|_| {
            format!(
                "{WHOLE_SYSTEM_CLOSE_SETUP_TIMEOUT_CODE}: MariaDB schema preparation stayed busy; no close token was created"
            )
        })?
        .map_err(|error| error.to_string())?;
    let mut tx = pool.begin().await.map_err(|error| error.to_string())?;
    cleanup_expired_whole_system_close(&mut tx)
        .await
        .map_err(|error| error.to_string())?;
    let mut barrier = locked_whole_system_close_barrier(&mut tx)
        .await
        .map_err(|error| error.to_string())?;
    if barrier.state != "idle" {
        if barrier.owner_till_id != owner_till_id.trim() {
            return Err(format!(
                "{WHOLE_SYSTEM_CLOSE_IN_PROGRESS_CODE}: {} is already coordinating the whole-system close",
                barrier.owner_till_id
            ));
        }
        barrier.latest_marker = latest_system_report_marker(&mut tx, true)
            .await
            .map_err(|error| error.to_string())?;
        tx.commit().await.map_err(|error| error.to_string())?;
        return Ok(barrier);
    }
    assert_mysql_restore_writes_allowed(&mut tx)
        .await
        .map_err(|error| error.to_string())?;

    let token = new_whole_system_close_token();
    sqlx::query(
        "UPDATE pos_close_barrier
         SET token = ?, state = 'preparing', ownerTillId = ?,
             requestedAt = UTC_TIMESTAMP(3),
             expiresAt = TIMESTAMPADD(SECOND, ?, UTC_TIMESTAMP(3)),
             cutoffAt = NULL
         WHERE id = 1 AND state = 'idle'",
    )
    .bind(&token)
    .bind(owner_till_id.trim())
    .bind(WHOLE_SYSTEM_CLOSE_PREPARE_SECONDS)
    .execute(&mut *tx)
    .await
    .map_err(|error| error.to_string())?;
    barrier = locked_whole_system_close_barrier(&mut tx)
        .await
        .map_err(|error| error.to_string())?;
    barrier.latest_marker = latest_system_report_marker(&mut tx, true)
        .await
        .map_err(|error| error.to_string())?;
    tx.commit().await.map_err(|error| error.to_string())?;
    Ok(barrier)
}

#[tauri::command]
pub async fn freeze_whole_system_close(
    mysql_uri: String,
    token: String,
    owner_till_id: String,
) -> Result<WholeSystemCloseBarrierResult, String> {
    let pool = connect_mysql_for_whole_system_close(&mysql_uri)
        .await
        .map_err(|error| error.to_string())?;
    assert_mysql_whole_system_close_schema_ready(&pool)
        .await
        .map_err(|error| error.to_string())?;
    let mut tx = pool.begin().await.map_err(|error| error.to_string())?;
    cleanup_expired_whole_system_close(&mut tx)
        .await
        .map_err(|error| error.to_string())?;
    let barrier = locked_whole_system_close_barrier(&mut tx)
        .await
        .map_err(|error| error.to_string())?;
    if barrier.state == "frozen" {
        validate_whole_system_close_owner(&barrier, token.trim(), owner_till_id.trim(), "frozen")
            .map_err(|error| error.to_string())?;
        tx.commit().await.map_err(|error| error.to_string())?;
        return Ok(barrier);
    }
    validate_whole_system_close_owner(&barrier, token.trim(), owner_till_id.trim(), "preparing")
        .map_err(|error| error.to_string())?;
    let issues = whole_system_close_readiness_issues(&mut tx, token.trim(), "prepared")
        .await
        .map_err(|error| error.to_string())?;
    if !issues.is_empty() {
        let message = format!("{WHOLE_SYSTEM_CLOSE_WAITING_CODE}: {}", issues.join("; "));
        tx.rollback()
            .await
            .map_err(|error| format!("{message}; could not release the close lock: {error}"))?;
        return Err(message);
    }
    if let Err(error) = assert_remote_terminal_journal_empty(&mut tx).await {
        let message = error.to_string();
        tx.rollback().await.map_err(|rollback| {
            format!("{message}; could not release the close lock: {rollback}")
        })?;
        return Err(message);
    }
    if let Err(error) = assert_mysql_whole_system_close_guards_ready(&mut tx).await {
        let message = error.to_string();
        tx.rollback().await.map_err(|rollback| {
            format!("{message}; could not release the close lock: {rollback}")
        })?;
        return Err(message);
    }
    // MariaDB business timestamps are millisecond-precision. Use the immediate
    // successor of one locked server-clock tick as the exclusive report end,
    // so a writer stamped on that tick is included and a later writer can
    // never be rejected merely because it equals lastClosedAt.
    let server_tick: String =
        sqlx::query_scalar("SELECT DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ')")
            .fetch_one(&mut *tx)
            .await
            .map_err(|error| error.to_string())?;
    let cutoff_at = exclusive_report_cutoff(&server_tick).map_err(|error| error.to_string())?;
    sqlx::query(
        "UPDATE pos_close_barrier
         SET state = 'frozen',
             cutoffAt = STR_TO_DATE(
               REPLACE(REPLACE(?, 'T', ' '), 'Z', ''),
               '%Y-%m-%d %H:%i:%s.%f'
             ),
             expiresAt = TIMESTAMPADD(SECOND, ?, UTC_TIMESTAMP(3))
         WHERE id = 1 AND token = ? AND state = 'preparing'",
    )
    .bind(&cutoff_at)
    .bind(WHOLE_SYSTEM_CLOSE_FROZEN_SECONDS)
    .bind(token.trim())
    .execute(&mut *tx)
    .await
    .map_err(|error| error.to_string())?;
    let mut frozen = locked_whole_system_close_barrier(&mut tx)
        .await
        .map_err(|error| error.to_string())?;
    frozen.latest_marker = latest_system_report_marker(&mut tx, true)
        .await
        .map_err(|error| error.to_string())?;
    tx.commit().await.map_err(|error| error.to_string())?;
    Ok(frozen)
}

#[tauri::command]
pub async fn abort_whole_system_close(
    mysql_uri: String,
    token: String,
    owner_till_id: String,
) -> Result<(), String> {
    let pool = connect_mysql_for_whole_system_close(&mysql_uri)
        .await
        .map_err(|error| error.to_string())?;
    assert_mysql_whole_system_close_barrier_ready(&pool)
        .await
        .map_err(|error| error.to_string())?;
    let mut tx = pool.begin().await.map_err(|error| error.to_string())?;
    cleanup_expired_whole_system_close(&mut tx)
        .await
        .map_err(|error| error.to_string())?;
    let barrier = locked_whole_system_close_barrier(&mut tx)
        .await
        .map_err(|error| error.to_string())?;
    if barrier.state == "idle" {
        tx.commit().await.map_err(|error| error.to_string())?;
        return Ok(());
    }
    if barrier.token != token.trim() || barrier.owner_till_id != owner_till_id.trim() {
        let message =
            "WHOLE_SYSTEM_CLOSE_TOKEN_INVALID: another till owns this close barrier".to_string();
        tx.rollback()
            .await
            .map_err(|error| format!("{message}; could not release the close lock: {error}"))?;
        return Err(message);
    }
    sqlx::query(
        "UPDATE pos_close_barrier
         SET token = '', state = 'idle', ownerTillId = '',
             requestedAt = NULL, expiresAt = NULL, cutoffAt = NULL
         WHERE id = 1 AND token = ?",
    )
    .bind(token.trim())
    .execute(&mut *tx)
    .await
    .map_err(|error| error.to_string())?;
    tx.commit().await.map_err(|error| error.to_string())?;
    Ok(())
}

async fn purge_mysql_transactions_under_frozen_close(
    pool: &MySqlPool,
    token: &str,
    owner_till_id: &str,
    fail_after_payments: bool,
) -> Result<TransactionPurgeResult, sqlx::Error> {
    let mut tx = pool.begin().await?;
    cleanup_expired_whole_system_close(&mut tx).await?;
    let barrier = locked_whole_system_close_barrier(&mut tx).await?;
    validate_whole_system_close_owner(&barrier, token, owner_till_id, "frozen")?;
    let issues = whole_system_close_readiness_issues(&mut tx, token, "frozen").await?;
    if !issues.is_empty() {
        let error = account_protocol_error(format!(
            "{WHOLE_SYSTEM_CLOSE_WAITING_CODE}: {}",
            issues.join("; ")
        ));
        tx.rollback().await?;
        return Err(error);
    }
    if let Err(error) = assert_remote_terminal_journal_empty(&mut tx).await {
        tx.rollback().await?;
        return Err(error);
    }
    if let Err(error) = assert_mysql_whole_system_close_guards_ready(&mut tx).await {
        tx.rollback().await?;
        return Err(error);
    }
    if barrier.cutoff_at.trim().is_empty() {
        return Err(account_protocol_error(
            "Transaction purge requires a frozen server cutoff",
        ));
    }
    let marker = barrier.cutoff_at.clone();
    let rows: Vec<String> = sqlx::query_scalar(
        "SELECT CAST(tillNumber AS CHAR) FROM (
            SELECT id AS tillNumber FROM registers
            UNION SELECT tillNumber FROM orders
            UNION SELECT registerId AS tillNumber FROM shifts
            UNION SELECT tillNumber FROM customer_account_entries
            UNION SELECT tillNumber FROM till_report_markers
         ) purge_tills
         WHERE TRIM(COALESCE(tillNumber, '')) <> ''",
    )
    .fetch_all(&mut *tx)
    .await?;
    let mut till_numbers: Vec<String> = rows
        .into_iter()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    till_numbers.sort();

    // Other sessions continue to observe `frozen` until this transaction
    // commits. Releasing inside the transaction lets this transaction's own
    // permanent close triggers perform the bounded purge and makes release,
    // deletion, cutoff, and replacement report baselines visible atomically.
    sqlx::query(
        "UPDATE pos_close_barrier
         SET lastClosedAt = cutoffAt,
             token = '', state = 'idle', ownerTillId = '',
             requestedAt = NULL, expiresAt = NULL, cutoffAt = NULL
         WHERE id = 1 AND token = ? AND state = 'frozen'",
    )
    .bind(token)
    .execute(&mut *tx)
    .await?;

    let old_order = "(createdAt IS NULL OR createdAt = '' OR createdAt <= ?)";
    let old_shift = "(openedAt IS NULL OR openedAt = '' OR openedAt <= ?)";
    sqlx::query(&format!(
        "DELETE FROM inventory_logs WHERE referenceId IN (SELECT id FROM orders WHERE {old_order})"
    ))
    .bind(&marker)
    .execute(&mut *tx)
    .await?;
    sqlx::query(&format!(
        "DELETE FROM audit_logs
         WHERE entityId IN (SELECT id FROM orders WHERE {old_order})
            OR entityId IN (SELECT id FROM shifts WHERE {old_shift})
            OR ((entityType IN ('order','shift','cash_movement','report')
                 OR action IN ('sale_completed','order_refunded','order_partially_refunded',
                               'order_voided','refund_completed','report_period_closed'))
                AND (createdAt IS NULL OR createdAt = '' OR createdAt <= ?))"
    ))
    .bind(&marker)
    .bind(&marker)
    .bind(&marker)
    .execute(&mut *tx)
    .await?;
    sqlx::query(&format!(
        "DELETE FROM manager_approvals
         WHERE entityId IN (SELECT id FROM orders WHERE {old_order})
            OR ((entityType = 'order' OR action = 'refund_void')
                AND (createdAt IS NULL OR createdAt = '' OR createdAt <= ?))"
    ))
    .bind(&marker)
    .bind(&marker)
    .execute(&mut *tx)
    .await?;
    sqlx::query(&format!(
        "DELETE FROM payments WHERE orderId IN (SELECT id FROM orders WHERE {old_order})"
    ))
    .bind(&marker)
    .execute(&mut *tx)
    .await?;
    if fail_after_payments {
        tx.rollback().await?;
        return Err(account_protocol_error("forced transaction purge failure"));
    }
    sqlx::query(&format!(
        "DELETE FROM order_lines WHERE orderId IN (SELECT id FROM orders WHERE {old_order})"
    ))
    .bind(&marker)
    .execute(&mut *tx)
    .await?;
    sqlx::query(&format!(
        "DELETE FROM cash_movements WHERE shiftId IN (SELECT id FROM shifts WHERE {old_shift})"
    ))
    .bind(&marker)
    .execute(&mut *tx)
    .await?;
    sqlx::query(&format!("DELETE FROM orders WHERE {old_order}"))
        .bind(&marker)
        .execute(&mut *tx)
        .await?;
    sqlx::query(&format!("DELETE FROM shifts WHERE {old_shift}"))
        .bind(&marker)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM daily_sales_summary")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM till_report_markers")
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "DELETE FROM tombstones
         WHERE table_name IN ('orders','order_lines','payments','shifts','cash_movements',
                              'inventory_logs','audit_logs','manager_approvals')
           AND (deletedAt IS NULL OR deletedAt = '' OR deletedAt <= ?)",
    )
    .bind(&marker)
    .execute(&mut *tx)
    .await?;

    for till_number in std::iter::once("").chain(till_numbers.iter().map(String::as_str)) {
        sqlx::query(
            "INSERT INTO till_report_markers
                (id, tillNumber, type, markerTime, periodStart, periodEnd, employeeId,
                 reportText, reportTotal, createdAt, updatedAt)
             VALUES (?, ?, 'period', ?, ?, ?, '', 'Transaction history purge baseline', 0, ?, ?)",
        )
        .bind(random_record_id())
        .bind(till_number)
        .bind(&marker)
        .bind(&marker)
        .bind(&marker)
        .bind(&marker)
        .bind(&marker)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query(
        "INSERT INTO settings (`key`, value, updatedAt) VALUES ('transaction_purge_at', ?, ?)
         ON DUPLICATE KEY UPDATE value = VALUES(value), updatedAt = VALUES(updatedAt)",
    )
    .bind(&marker)
    .bind(&marker)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(TransactionPurgeResult {
        marker,
        till_numbers,
    })
}

#[tauri::command]
pub async fn purge_mysql_transactions(
    mysql_uri: String,
    token: String,
    owner_till_id: String,
) -> Result<TransactionPurgeResult, String> {
    let pool = connect_mysql_for_whole_system_close(&mysql_uri)
        .await
        .map_err(|error| error.to_string())?;
    assert_mysql_whole_system_close_schema_ready(&pool)
        .await
        .map_err(|error| error.to_string())?;
    purge_mysql_transactions_under_frozen_close(&pool, token.trim(), owner_till_id.trim(), false)
        .await
        .map_err(|error| error.to_string())
}

const UNASSIGNED_TILL_SUMMARY_KEY: &str = "__unassigned__";

fn empty_frozen_till_sales_summary(id: String, name: String) -> FrozenTillSalesSummary {
    FrozenTillSalesSummary {
        id,
        name,
        net_sales: 0,
        gross_sales: 0,
        refunds: 0,
        tax_total: 0,
        transactions: 0,
        refund_transactions: 0,
        items_sold: 0,
        cash_total: 0,
        card_total: 0,
        tips_total: 0,
        service_charge_total: 0,
        cashback_total: 0,
        loyalty_total: 0,
        account_total: 0,
        account_repayments_cash: 0,
        account_repayments_card: 0,
        account_repayments_other: 0,
        account_tips_total: 0,
        account_service_charge_total: 0,
        account_cashback_total: 0,
    }
}

async fn load_frozen_till_sales_summaries(
    tx: &mut sqlx::Transaction<'_, MySql>,
    start_time: &str,
    end_time: &str,
) -> Result<Vec<FrozenTillSalesSummary>, sqlx::Error> {
    // Seed every real active register so a manager can see that an open till had
    // no sales. The two compatibility placeholders are not physical tills, so
    // omit them when idle; their names stay in register_names so exact-period
    // sales or account-payment activity can still create a labelled row.
    let register_rows = sqlx::query(
        "SELECT CAST(id AS CHAR) AS id,
                CAST(COALESCE(NULLIF(TRIM(name), ''), id) AS CHAR) AS name,
                CAST(COALESCE(isActive, 1) AS SIGNED) AS isActive
         FROM registers",
    )
    .fetch_all(&mut **tx)
    .await?;
    let mut register_names = HashMap::<String, String>::new();
    let mut summaries = HashMap::<String, FrozenTillSalesSummary>::new();
    for row in register_rows {
        let id = row
            .try_get::<Option<String>, _>("id")?
            .unwrap_or_default()
            .trim()
            .to_string();
        if id.is_empty() {
            continue;
        }
        let name = row
            .try_get::<Option<String>, _>("name")?
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| id.clone());
        register_names.insert(id.clone(), name.clone());
        let is_compatibility_placeholder = matches!(id.as_str(), "register-main" | "legacy-till");
        if row.try_get::<i64, _>("isActive")? != 0 && !is_compatibility_placeholder {
            summaries.insert(id.clone(), empty_frozen_till_sales_summary(id, name));
        }
    }

    // Aggregate each order once. Correlated child sums avoid multiplying order
    // totals when an order contains several lines or payment records.
    let sales_rows = sqlx::query(
        "SELECT CAST(COALESCE(NULLIF(TRIM(o.tillNumber), ''), '') AS CHAR) AS id,
                CAST(COALESCE(SUM(o.total), 0) AS SIGNED) AS netSales,
                CAST(COALESCE(SUM(CASE WHEN o.type != 'return'
                     THEN o.total + COALESCE(o.discountAmount, 0) ELSE 0 END), 0) AS SIGNED) AS grossSales,
                CAST(ABS(COALESCE(SUM(CASE WHEN o.total < 0 THEN o.total ELSE 0 END), 0)) AS SIGNED) AS refunds,
                CAST(COALESCE(SUM(o.taxTotal), 0) AS SIGNED) AS taxTotal,
                CAST(COALESCE(SUM(CASE WHEN o.type != 'return' THEN 1 ELSE 0 END), 0) AS SIGNED) AS transactions,
                CAST(COALESCE(SUM(CASE WHEN o.type = 'return' THEN 1 ELSE 0 END), 0) AS SIGNED) AS refundTransactions,
                CAST(COALESCE(SUM((SELECT SUM(ol.quantity)
                     FROM order_lines ol WHERE ol.orderId = o.id)), 0) AS SIGNED) AS itemsSold,
                CAST(COALESCE(SUM((SELECT SUM(CASE
                     WHEN COALESCE(p.cashAmount, 0) != 0 THEN p.cashAmount
                     WHEN p.method = 'cash' THEN p.amount ELSE 0 END)
                     FROM payments p WHERE p.orderId = o.id)), 0) AS SIGNED) AS cashTotal,
                CAST(COALESCE(SUM((SELECT SUM(CASE
                     WHEN COALESCE(p.cardAmount, 0) != 0 THEN p.cardAmount
                     WHEN p.method IN ('card', 'sumup', 'dojo', 'mobile') THEN p.amount ELSE 0 END)
                     FROM payments p WHERE p.orderId = o.id)), 0) AS SIGNED) AS cardTotal,
                CAST(COALESCE(SUM((SELECT SUM(COALESCE(p.tipsAmount, 0))
                     FROM payments p WHERE p.orderId = o.id)), 0) AS SIGNED) AS tipsTotal,
                CAST(COALESCE(SUM((SELECT SUM(COALESCE(p.serviceChargeAmount, 0))
                     FROM payments p WHERE p.orderId = o.id)), 0) AS SIGNED) AS serviceChargeTotal,
                CAST(COALESCE(SUM((SELECT SUM(COALESCE(p.cashbackAmount, 0))
                     FROM payments p WHERE p.orderId = o.id)), 0) AS SIGNED) AS cashbackTotal,
                CAST(COALESCE(SUM((SELECT SUM(COALESCE(p.loyaltyAmount, 0))
                     FROM payments p WHERE p.orderId = o.id)), 0) AS SIGNED) AS loyaltyTotal,
                CAST(COALESCE(SUM((SELECT SUM(COALESCE(p.accountAmount, 0))
                     FROM payments p WHERE p.orderId = o.id)), 0) AS SIGNED) AS accountTotal
         FROM orders o
         WHERE o.status IN ('completed','refunded','partially_refunded','voided')
           AND o.status != 'voided'
           AND NOT (o.type = 'return' AND COALESCE(o.notes, '') LIKE 'Void of receipt %')
           AND o.completedAt >= ? AND o.completedAt < ?
         GROUP BY COALESCE(NULLIF(TRIM(o.tillNumber), ''), '')",
    )
    .bind(start_time)
    .bind(end_time)
    .fetch_all(&mut **tx)
    .await?;
    for row in sales_rows {
        let raw_id = row
            .try_get::<Option<String>, _>("id")?
            .unwrap_or_default()
            .trim()
            .to_string();
        let key = if raw_id.is_empty() {
            UNASSIGNED_TILL_SUMMARY_KEY.to_string()
        } else {
            raw_id
        };
        let name = if key == UNASSIGNED_TILL_SUMMARY_KEY {
            "Unassigned / legacy".to_string()
        } else {
            register_names
                .get(&key)
                .cloned()
                .unwrap_or_else(|| key.clone())
        };
        let output_id = if key == UNASSIGNED_TILL_SUMMARY_KEY {
            String::new()
        } else {
            key.clone()
        };
        let summary = summaries
            .entry(key)
            .or_insert_with(|| empty_frozen_till_sales_summary(output_id, name));
        summary.net_sales = row.try_get("netSales")?;
        summary.gross_sales = row.try_get("grossSales")?;
        summary.refunds = row.try_get("refunds")?;
        summary.tax_total = row.try_get("taxTotal")?;
        summary.transactions = row.try_get("transactions")?;
        summary.refund_transactions = row.try_get("refundTransactions")?;
        summary.items_sold = row.try_get("itemsSold")?;
        summary.cash_total = row.try_get("cashTotal")?;
        summary.card_total = row.try_get("cardTotal")?;
        summary.tips_total = row.try_get("tipsTotal")?;
        summary.service_charge_total = row.try_get("serviceChargeTotal")?;
        summary.cashback_total = row.try_get("cashbackTotal")?;
        summary.loyalty_total = row.try_get("loyaltyTotal")?;
        summary.account_total = row.try_get("accountTotal")?;
    }

    // Account repayments are cash movements, not new sales, but the existing
    // TillSalesSummary contract exposes them per till for reconciliation.
    let collection_rows = sqlx::query(
        "SELECT CAST(COALESCE(NULLIF(TRIM(tillNumber), ''), '') AS CHAR) AS id,
                CAST(COALESCE(SUM(CASE WHEN paymentMethod = 'cash' AND amountPence < 0
                     THEN -amountPence ELSE 0 END), 0) AS SIGNED) AS accountRepaymentsCash,
                CAST(COALESCE(SUM(CASE WHEN paymentMethod = 'card' AND amountPence < 0
                     THEN -amountPence ELSE 0 END), 0) AS SIGNED) AS accountRepaymentsCard,
                CAST(COALESCE(SUM(CASE WHEN paymentMethod = 'other' AND amountPence < 0
                     THEN -amountPence ELSE 0 END), 0) AS SIGNED) AS accountRepaymentsOther,
                CAST(COALESCE(SUM(tipsAmount), 0) AS SIGNED) AS accountTipsTotal,
                CAST(COALESCE(SUM(serviceChargeAmount), 0) AS SIGNED) AS accountServiceChargeTotal,
                CAST(COALESCE(SUM(cashbackAmount), 0) AS SIGNED) AS accountCashbackTotal
         FROM customer_account_entries
         WHERE entryType = 'payment'
           AND createdAt >= ? AND createdAt < ?
         GROUP BY COALESCE(NULLIF(TRIM(tillNumber), ''), '')",
    )
    .bind(start_time)
    .bind(end_time)
    .fetch_all(&mut **tx)
    .await?;
    for row in collection_rows {
        let raw_id = row
            .try_get::<Option<String>, _>("id")?
            .unwrap_or_default()
            .trim()
            .to_string();
        let key = if raw_id.is_empty() {
            UNASSIGNED_TILL_SUMMARY_KEY.to_string()
        } else {
            raw_id
        };
        let name = if key == UNASSIGNED_TILL_SUMMARY_KEY {
            "Unassigned / legacy".to_string()
        } else {
            register_names
                .get(&key)
                .cloned()
                .unwrap_or_else(|| key.clone())
        };
        let output_id = if key == UNASSIGNED_TILL_SUMMARY_KEY {
            String::new()
        } else {
            key.clone()
        };
        let summary = summaries
            .entry(key)
            .or_insert_with(|| empty_frozen_till_sales_summary(output_id, name));
        summary.account_repayments_cash = row.try_get("accountRepaymentsCash")?;
        summary.account_repayments_card = row.try_get("accountRepaymentsCard")?;
        summary.account_repayments_other = row.try_get("accountRepaymentsOther")?;
        summary.account_tips_total = row.try_get("accountTipsTotal")?;
        summary.account_service_charge_total = row.try_get("accountServiceChargeTotal")?;
        summary.account_cashback_total = row.try_get("accountCashbackTotal")?;
    }

    let mut result: Vec<FrozenTillSalesSummary> = summaries.into_values().collect();
    result.sort_by(|left, right| {
        let left_unassigned = left.id.is_empty();
        let right_unassigned = right.id.is_empty();
        left_unassigned
            .cmp(&right_unassigned)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.id.cmp(&right.id))
    });

    // Duplicate register display names are legal; disambiguate them so the
    // printed close report still identifies each physical till.
    let mut used_names = HashMap::<String, usize>::new();
    for summary in &mut result {
        let base_name = summary.name.clone();
        let occurrence = used_names.entry(base_name.clone()).or_insert(0);
        *occurrence += 1;
        if *occurrence > 1 {
            summary.name = format!("{base_name} ({occurrence})");
        }
    }
    Ok(result)
}

async fn load_frozen_whole_system_report(
    tx: &mut sqlx::Transaction<'_, MySql>,
    start_time: &str,
    end_time: &str,
    till_number: Option<&str>,
) -> Result<
    (
        FrozenSalesOverview,
        FrozenPaymentBreakdown,
        Vec<FrozenTopProduct>,
        Vec<FrozenTillSalesSummary>,
    ),
    sqlx::Error,
> {
    let till_filter = if till_number.is_some() {
        " AND o.tillNumber = ?"
    } else {
        ""
    };
    let revenue_sql = format!(
        "SELECT CAST(COALESCE(SUM(o.total), 0) AS SIGNED) AS totalRevenue,
                CAST(COALESCE(SUM(CASE WHEN o.type != 'return' THEN o.total ELSE 0 END), 0) AS SIGNED) AS saleRevenue,
                CAST(COALESCE(SUM(CASE WHEN o.type != 'return' THEN 1 ELSE 0 END), 0) AS SIGNED) AS totalTransactions,
                CAST(COALESCE(SUM(CASE WHEN o.type = 'return' THEN 1 ELSE 0 END), 0) AS SIGNED) AS refundTransactions
         FROM orders o
         WHERE o.status IN ('completed','refunded','partially_refunded','voided')
           AND o.status != 'voided'
           AND NOT (o.type = 'return' AND COALESCE(o.notes, '') LIKE 'Void of receipt %')
           AND o.completedAt >= ? AND o.completedAt < ?{till_filter}"
    );
    let mut revenue_query = sqlx::query(&revenue_sql).bind(start_time).bind(end_time);
    if let Some(till_number) = till_number {
        revenue_query = revenue_query.bind(till_number);
    }
    let revenue = revenue_query.fetch_one(&mut **tx).await?;
    let items_sql = format!(
        "SELECT CAST(COALESCE(SUM(ol.quantity), 0) AS SIGNED)
         FROM order_lines ol JOIN orders o ON ol.orderId = o.id
         WHERE o.status IN ('completed','refunded','partially_refunded','voided')
           AND o.status != 'voided'
           AND NOT (o.type = 'return' AND COALESCE(o.notes, '') LIKE 'Void of receipt %')
           AND o.completedAt >= ? AND o.completedAt < ?{till_filter}"
    );
    let mut items_query = sqlx::query_scalar(&items_sql)
        .bind(start_time)
        .bind(end_time);
    if let Some(till_number) = till_number {
        items_query = items_query.bind(till_number);
    }
    let items: i64 = items_query.fetch_one(&mut **tx).await?;
    let total_revenue: i64 = revenue.try_get("totalRevenue")?;
    let sale_revenue: i64 = revenue.try_get("saleRevenue")?;
    let transactions: i64 = revenue.try_get("totalTransactions")?;
    let overview = FrozenSalesOverview {
        total_revenue,
        total_transactions: transactions,
        refund_transactions: revenue.try_get("refundTransactions")?,
        avg_transaction_value: if transactions > 0 {
            (sale_revenue as f64 / transactions as f64).round() as i64
        } else {
            0
        },
        total_items_sold: items,
    };

    let payments_sql = format!(
        "SELECT
            CAST(COALESCE(SUM(p.totalCash), 0) AS SIGNED) AS totalCash,
            CAST(COALESCE(SUM(p.totalCard), 0) AS SIGNED) AS totalCard,
            CAST(COALESCE(SUM(p.tipsTotal), 0) AS SIGNED) AS tipsTotal,
            CAST(COALESCE(SUM(p.serviceChargeTotal), 0) AS SIGNED) AS serviceChargeTotal,
            CAST(COALESCE(SUM(p.cashbackTotal), 0) AS SIGNED) AS cashbackTotal,
            CAST(COALESCE(SUM(p.totalLoyalty), 0) AS SIGNED) AS totalLoyalty,
            CAST(COALESCE(SUM(p.totalAccount), 0) AS SIGNED) AS totalAccount,
            CAST(COALESCE(SUM(CASE WHEN p.orderId IS NULL THEN o.total ELSE 0 END), 0) AS SIGNED) AS unrecordedAmount,
            CAST(COALESCE(SUM(o.total), 0) AS SIGNED) AS totalAmount,
            CAST(COALESCE(SUM(CASE WHEN p.hasCash = 1 AND p.hasCard = 0 THEN 1 ELSE 0 END), 0) AS SIGNED) AS cashTxCount,
            CAST(COALESCE(SUM(CASE WHEN p.hasCard = 1 AND p.hasCash = 0 THEN 1 ELSE 0 END), 0) AS SIGNED) AS cardTxCount,
            CAST(COALESCE(SUM(CASE WHEN p.hasCash = 1 AND p.hasCard = 1 THEN 1 ELSE 0 END), 0) AS SIGNED) AS splitTxCount,
            CAST(COALESCE(SUM(CASE WHEN p.hasLoyalty = 1 THEN 1 ELSE 0 END), 0) AS SIGNED) AS loyaltyTxCount,
            CAST(COALESCE(SUM(CASE WHEN p.hasAccount = 1 THEN 1 ELSE 0 END), 0) AS SIGNED) AS accountTxCount,
            CAST(COALESCE(SUM(CASE WHEN p.orderId IS NULL THEN 1 ELSE 0 END), 0) AS SIGNED) AS unrecordedTxCount
         FROM orders o
         LEFT JOIN (
            SELECT orderId,
                SUM(CASE WHEN COALESCE(cashAmount, 0) != 0 THEN cashAmount WHEN method = 'cash' THEN amount ELSE 0 END) AS totalCash,
                SUM(CASE WHEN COALESCE(cardAmount, 0) != 0 THEN cardAmount WHEN method IN ('card', 'sumup', 'dojo', 'mobile') THEN amount ELSE 0 END) AS totalCard,
                SUM(COALESCE(tipsAmount, 0)) AS tipsTotal,
                SUM(COALESCE(serviceChargeAmount, 0)) AS serviceChargeTotal,
                SUM(COALESCE(cashbackAmount, 0)) AS cashbackTotal,
                SUM(COALESCE(loyaltyAmount, 0)) AS totalLoyalty,
                SUM(COALESCE(accountAmount, 0)) AS totalAccount,
                MAX(CASE WHEN COALESCE(cashAmount, 0) != 0 OR method = 'cash' THEN 1 ELSE 0 END) AS hasCash,
                MAX(CASE WHEN COALESCE(cardAmount, 0) != 0 OR method IN ('card', 'sumup', 'dojo', 'mobile') THEN 1 ELSE 0 END) AS hasCard,
                MAX(CASE WHEN COALESCE(loyaltyAmount, 0) != 0 THEN 1 ELSE 0 END) AS hasLoyalty,
                MAX(CASE WHEN COALESCE(accountAmount, 0) != 0 THEN 1 ELSE 0 END) AS hasAccount
            FROM payments GROUP BY orderId
         ) p ON o.id = p.orderId
         WHERE o.status IN ('completed','refunded','partially_refunded','voided')
           AND o.status != 'voided'
           AND NOT (o.type = 'return' AND COALESCE(o.notes, '') LIKE 'Void of receipt %')
           AND o.completedAt >= ? AND o.completedAt < ?{till_filter}"
    );
    let mut payments_query = sqlx::query(&payments_sql).bind(start_time).bind(end_time);
    if let Some(till_number) = till_number {
        payments_query = payments_query.bind(till_number);
    }
    let payments = payments_query.fetch_one(&mut **tx).await?;
    let account_activity = sqlx::query(
        "SELECT
            CAST(COALESCE(SUM(CASE WHEN entryType = 'charge' THEN amountPence ELSE 0 END), 0) AS SIGNED) AS accountCharges,
            CAST(COALESCE(SUM(CASE WHEN entryType = 'payment' AND paymentMethod = 'cash' AND amountPence < 0 THEN -amountPence ELSE 0 END), 0) AS SIGNED) AS accountRepaymentsCash,
            CAST(COALESCE(SUM(CASE WHEN entryType = 'payment' AND paymentMethod = 'card' AND amountPence < 0 THEN -amountPence ELSE 0 END), 0) AS SIGNED) AS accountRepaymentsCard,
            CAST(COALESCE(SUM(CASE WHEN entryType = 'payment' AND paymentMethod = 'other' AND amountPence < 0 THEN -amountPence ELSE 0 END), 0) AS SIGNED) AS accountRepaymentsOther,
            CAST(COALESCE(SUM(CASE WHEN entryType = 'payment' THEN tipsAmount ELSE 0 END), 0) AS SIGNED) AS accountTipsTotal,
            CAST(COALESCE(SUM(CASE WHEN entryType = 'payment' THEN serviceChargeAmount ELSE 0 END), 0) AS SIGNED) AS accountServiceChargeTotal,
            CAST(COALESCE(SUM(CASE WHEN entryType = 'payment' THEN cashbackAmount ELSE 0 END), 0) AS SIGNED) AS accountCashbackTotal,
            CAST(COALESCE(SUM(CASE WHEN entryType NOT IN ('charge', 'payment') THEN amountPence ELSE 0 END), 0) AS SIGNED) AS accountAdjustments
         FROM customer_account_entries
         WHERE createdAt >= ? AND createdAt < ?",
    )
    .bind(start_time)
    .bind(end_time)
    .fetch_one(&mut **tx)
    .await?;
    let opening: i64 = sqlx::query_scalar(
        "SELECT CAST(COALESCE(SUM(amountPence), 0) AS SIGNED)
         FROM customer_account_entries WHERE createdAt < ?",
    )
    .bind(start_time)
    .fetch_one(&mut **tx)
    .await?;
    let closing: i64 = sqlx::query_scalar(
        "SELECT CAST(COALESCE(SUM(amountPence), 0) AS SIGNED)
         FROM customer_account_entries WHERE createdAt < ?",
    )
    .bind(end_time)
    .fetch_one(&mut **tx)
    .await?;
    let breakdown = FrozenPaymentBreakdown {
        total_cash: payments.try_get("totalCash")?,
        total_card: payments.try_get("totalCard")?,
        tips_total: payments.try_get("tipsTotal")?,
        service_charge_total: payments.try_get("serviceChargeTotal")?,
        cashback_total: payments.try_get("cashbackTotal")?,
        total_loyalty: payments.try_get("totalLoyalty")?,
        total_account: payments.try_get("totalAccount")?,
        cash_tx_count: payments.try_get("cashTxCount")?,
        card_tx_count: payments.try_get("cardTxCount")?,
        split_tx_count: payments.try_get("splitTxCount")?,
        loyalty_tx_count: payments.try_get("loyaltyTxCount")?,
        account_tx_count: payments.try_get("accountTxCount")?,
        account_charges: account_activity.try_get("accountCharges")?,
        account_repayments_cash: account_activity.try_get("accountRepaymentsCash")?,
        account_repayments_card: account_activity.try_get("accountRepaymentsCard")?,
        account_repayments_other: account_activity.try_get("accountRepaymentsOther")?,
        account_tips_total: account_activity.try_get("accountTipsTotal")?,
        account_service_charge_total: account_activity.try_get("accountServiceChargeTotal")?,
        account_cashback_total: account_activity.try_get("accountCashbackTotal")?,
        account_adjustments: account_activity.try_get("accountAdjustments")?,
        opening_account_owed: opening,
        closing_account_owed: closing,
        account_activity_scope: "shop".into(),
        total_amount: payments.try_get("totalAmount")?,
        unrecorded_amount: payments.try_get("unrecordedAmount")?,
        unrecorded_tx_count: payments.try_get("unrecordedTxCount")?,
    };

    let top_products_sql = format!(
        "SELECT CAST(ol.productName AS CHAR) AS name,
                CAST(COALESCE(pr.sku, '') AS CHAR) AS sku,
                CAST(SUM(ol.quantity) AS SIGNED) AS qtySold,
                CAST(SUM(ol.lineTotal) AS SIGNED) AS totalRevenue,
                CAST(ROUND(SUM(ol.lineTotal) / NULLIF(SUM(ol.quantity), 0)) AS SIGNED) AS avgPrice
         FROM order_lines ol
         JOIN orders o ON ol.orderId = o.id
         LEFT JOIN products pr ON ol.productId = pr.id
         WHERE o.status IN ('completed','refunded','partially_refunded','voided')
           AND o.status != 'voided'
           AND NOT (o.type = 'return' AND COALESCE(o.notes, '') LIKE 'Void of receipt %')
           AND o.completedAt >= ? AND o.completedAt < ?{till_filter}
         GROUP BY ol.productId, ol.productName, pr.sku
         HAVING SUM(ol.quantity) != 0 OR SUM(ol.lineTotal) != 0
         ORDER BY qtySold DESC LIMIT 10"
    );
    let mut top_products_query = sqlx::query(&top_products_sql)
        .bind(start_time)
        .bind(end_time);
    if let Some(till_number) = till_number {
        top_products_query = top_products_query.bind(till_number);
    }
    let top_rows = top_products_query.fetch_all(&mut **tx).await?;
    let top_products = top_rows
        .into_iter()
        .map(|row| {
            Ok(FrozenTopProduct {
                name: row
                    .try_get::<Option<String>, _>("name")?
                    .unwrap_or_else(|| "Unknown".into()),
                sku: row.try_get::<Option<String>, _>("sku")?.unwrap_or_default(),
                qty_sold: row.try_get("qtySold")?,
                total_revenue: row.try_get("totalRevenue")?,
                avg_price: row.try_get::<Option<i64>, _>("avgPrice")?.unwrap_or(0),
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()?;
    let mut till_summaries = load_frozen_till_sales_summaries(tx, start_time, end_time).await?;
    if let Some(till_number) = till_number {
        till_summaries.retain(|summary| summary.id == till_number);
        if till_summaries.is_empty() {
            let name: Option<String> = sqlx::query_scalar(
                "SELECT CAST(COALESCE(NULLIF(TRIM(name), ''), id) AS CHAR)
                 FROM registers WHERE id = ? LIMIT 1",
            )
            .bind(till_number)
            .fetch_optional(&mut **tx)
            .await?;
            till_summaries.push(empty_frozen_till_sales_summary(
                till_number.to_string(),
                name.unwrap_or_else(|| till_number.to_string()),
            ));
        }
    }
    Ok((overview, breakdown, top_products, till_summaries))
}

#[tauri::command]
pub async fn get_frozen_whole_system_report(
    mysql_uri: String,
    token: String,
    owner_till_id: String,
    period_start: String,
) -> Result<FrozenWholeSystemReport, String> {
    if period_start.trim().is_empty() {
        return Err("Whole-system report period start is missing".into());
    }
    let pool = connect_mysql_for_whole_system_close(&mysql_uri)
        .await
        .map_err(|error| error.to_string())?;
    assert_mysql_whole_system_close_schema_ready(&pool)
        .await
        .map_err(|error| error.to_string())?;
    let mut tx = pool.begin().await.map_err(|error| error.to_string())?;
    cleanup_expired_whole_system_close(&mut tx)
        .await
        .map_err(|error| error.to_string())?;
    let barrier = locked_whole_system_close_barrier(&mut tx)
        .await
        .map_err(|error| error.to_string())?;
    validate_whole_system_close_owner(&barrier, token.trim(), owner_till_id.trim(), "frozen")
        .map_err(|error| error.to_string())?;
    let issues = whole_system_close_readiness_issues(&mut tx, token.trim(), "frozen")
        .await
        .map_err(|error| error.to_string())?;
    if !issues.is_empty() {
        let message = format!("{WHOLE_SYSTEM_CLOSE_WAITING_CODE}: {}", issues.join("; "));
        tx.rollback()
            .await
            .map_err(|error| format!("{message}; could not release the close lock: {error}"))?;
        return Err(message);
    }
    if let Err(error) = assert_remote_terminal_journal_empty(&mut tx).await {
        let message = error.to_string();
        tx.rollback().await.map_err(|rollback| {
            format!("{message}; could not release the close lock: {rollback}")
        })?;
        return Err(message);
    }
    if let Err(error) = assert_mysql_whole_system_close_guards_ready(&mut tx).await {
        let message = error.to_string();
        tx.rollback().await.map_err(|rollback| {
            format!("{message}; could not release the close lock: {rollback}")
        })?;
        return Err(message);
    }
    let latest_marker = latest_system_report_marker(&mut tx, true)
        .await
        .map_err(|error| error.to_string())?;
    let expected_period_start = latest_marker
        .clone()
        .unwrap_or_else(|| "2000-01-01T00:00:00.000Z".into());
    if period_start != expected_period_start {
        return Err(
            "REPORT_PERIOD_CHANGED: the whole-system report start changed; begin again".into(),
        );
    }
    if barrier.cutoff_at.is_empty() {
        return Err("WHOLE_SYSTEM_CLOSE_TOKEN_INVALID: frozen cutoff is missing".into());
    }
    // Keep the lease alive for the manager to review/print the frozen result.
    sqlx::query(
        "UPDATE pos_close_barrier
         SET expiresAt = TIMESTAMPADD(SECOND, ?, UTC_TIMESTAMP(3))
         WHERE id = 1 AND token = ? AND state = 'frozen'",
    )
    .bind(WHOLE_SYSTEM_CLOSE_FROZEN_SECONDS)
    .bind(token.trim())
    .execute(&mut *tx)
    .await
    .map_err(|error| error.to_string())?;
    let report = tokio::time::timeout(
        Duration::from_secs(WHOLE_SYSTEM_CLOSE_REPORT_LOAD_TIMEOUT_SECONDS),
        load_frozen_whole_system_report(&mut tx, &period_start, &barrier.cutoff_at, None),
    )
    .await;
    let (overview, breakdown, top_products, till_summaries) = match report {
        Ok(Ok(report)) => report,
        Ok(Err(error)) => {
            let message = error.to_string();
            tx.rollback().await.map_err(|rollback| {
                format!("{message}; could not release the close lock: {rollback}")
            })?;
            return Err(message);
        }
        Err(_) => {
            let message = format!(
                "{WHOLE_SYSTEM_CLOSE_REPORT_TIMEOUT_CODE}: frozen report totals exceeded {WHOLE_SYSTEM_CLOSE_REPORT_LOAD_TIMEOUT_SECONDS} seconds; try again"
            );
            tx.rollback().await.map_err(|rollback| {
                format!("{message}; could not release the close lock: {rollback}")
            })?;
            return Err(message);
        }
    };
    tx.commit().await.map_err(|error| error.to_string())?;
    Ok(FrozenWholeSystemReport {
        token: token.trim().into(),
        cutoff_at: barrier.cutoff_at,
        period_start,
        expected_last_marker: latest_marker,
        overview,
        breakdown,
        top_products,
        till_summaries,
    })
}

#[tauri::command]
pub async fn finish_whole_system_close(
    mysql_uri: String,
    input: FinishWholeSystemCloseInput,
) -> Result<ReportMarkerRecord, String> {
    if input.token.trim().is_empty()
        || input.owner_till_id.trim().is_empty()
        || input.id.trim().is_empty()
        || input.period_start.trim().is_empty()
    {
        return Err("Invalid whole-system close completion request".into());
    }
    let pool = connect_mysql_for_whole_system_close(&mysql_uri)
        .await
        .map_err(|error| error.to_string())?;
    assert_mysql_whole_system_close_schema_ready(&pool)
        .await
        .map_err(|error| error.to_string())?;
    let mut tx = pool.begin().await.map_err(|error| error.to_string())?;
    cleanup_expired_whole_system_close(&mut tx)
        .await
        .map_err(|error| error.to_string())?;
    let barrier = locked_whole_system_close_barrier(&mut tx)
        .await
        .map_err(|error| error.to_string())?;
    validate_whole_system_close_owner(
        &barrier,
        input.token.trim(),
        input.owner_till_id.trim(),
        "frozen",
    )
    .map_err(|error| error.to_string())?;
    if let Err(error) = assert_mysql_whole_system_close_guards_ready(&mut tx).await {
        let message = error.to_string();
        tx.rollback().await.map_err(|rollback| {
            format!("{message}; could not release the close lock: {rollback}")
        })?;
        return Err(message);
    }
    let latest_marker = latest_system_report_marker(&mut tx, true)
        .await
        .map_err(|error| error.to_string())?;
    validate_report_close_marker(
        latest_marker.as_deref(),
        input.expected_last_marker.as_deref(),
    )
    .map_err(|error| error.to_string())?;
    let expected_period_start = latest_marker
        .clone()
        .unwrap_or_else(|| "2000-01-01T00:00:00.000Z".into());
    if input.period_start != expected_period_start || barrier.cutoff_at.is_empty() {
        return Err(
            "REPORT_PERIOD_CHANGED: the frozen report no longer matches the open period".into(),
        );
    }
    let stamp: String =
        sqlx::query_scalar("SELECT DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ')")
            .fetch_one(&mut *tx)
            .await
            .map_err(|error| error.to_string())?;
    let row = ReportMarkerRecord {
        id: input.id,
        till_number: String::new(),
        marker_type: "period".into(),
        marker_time: barrier.cutoff_at.clone(),
        period_start: input.period_start,
        period_end: barrier.cutoff_at,
        employee_id: input.employee_id,
        report_text: input.report_text,
        report_total: input.report_total,
        created_at: stamp.clone(),
        updated_at: stamp,
    };
    // Release inside this transaction before inserting the marker. Other
    // sessions still see frozen until commit, while this transaction's marker
    // trigger sees idle. Marker + release therefore become visible atomically.
    sqlx::query(
        "UPDATE pos_close_barrier
         SET lastClosedAt = cutoffAt,
             token = '', state = 'idle', ownerTillId = '',
             requestedAt = NULL, expiresAt = NULL, cutoffAt = NULL
         WHERE id = 1 AND token = ? AND state = 'frozen'",
    )
    .bind(input.token.trim())
    .execute(&mut *tx)
    .await
    .map_err(|error| error.to_string())?;
    sqlx::query(
        "INSERT INTO till_report_markers
            (id, tillNumber, type, markerTime, periodStart, periodEnd, employeeId,
             reportText, reportTotal, createdAt, updatedAt)
         VALUES (?, '', 'period', ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&row.id)
    .bind(&row.marker_time)
    .bind(&row.period_start)
    .bind(&row.period_end)
    .bind(&row.employee_id)
    .bind(&row.report_text)
    .bind(row.report_total)
    .bind(&row.created_at)
    .bind(&row.updated_at)
    .execute(&mut *tx)
    .await
    .map_err(|error| error.to_string())?;
    tx.commit().await.map_err(|error| error.to_string())?;
    Ok(row)
}

/// Commit a per-till marker only if the effective till-or-system marker still
/// matches the snapshot that the manager reviewed. The close barrier is the
/// serialization point for current native writers and the permanent MariaDB
/// guards, so marker comparison and insert are one authoritative transaction.
#[tauri::command]
pub async fn commit_till_report_close(
    mysql_uri: String,
    input: CommitTillReportCloseInput,
) -> Result<ReportMarkerRecord, String> {
    if input.id.trim().is_empty()
        || input.till_number.trim().is_empty()
        || input.period_start.trim().is_empty()
        || input.period_end.trim().is_empty()
    {
        return Err("Invalid till report close request".into());
    }
    let pool = connect_mysql_for_whole_system_close(&mysql_uri)
        .await
        .map_err(|error| error.to_string())?;
    assert_mysql_whole_system_close_schema_ready(&pool)
        .await
        .map_err(|error| error.to_string())?;
    let mut tx = pool.begin().await.map_err(|error| error.to_string())?;
    cleanup_expired_whole_system_close(&mut tx)
        .await
        .map_err(|error| error.to_string())?;
    assert_mysql_restore_writes_allowed(&mut tx)
        .await
        .map_err(|error| error.to_string())?;
    let barrier = locked_whole_system_close_barrier(&mut tx)
        .await
        .map_err(|error| error.to_string())?;
    if barrier.state != "idle" {
        return Err(format!(
            "{WHOLE_SYSTEM_CLOSE_IN_PROGRESS_CODE}: another report close is already in progress"
        ));
    }
    assert_mysql_whole_system_close_guards_ready(&mut tx)
        .await
        .map_err(|error| error.to_string())?;
    assert_remote_till_terminal_journal_empty(&mut tx, input.till_number.trim())
        .await
        .map_err(|error| error.to_string())?;

    let latest_marker = latest_effective_till_report_marker(&mut tx, input.till_number.trim())
        .await
        .map_err(|error| error.to_string())?;
    let server_tick: String =
        sqlx::query_scalar("SELECT DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ')")
            .fetch_one(&mut *tx)
            .await
            .map_err(|error| error.to_string())?;
    let latest_allowed_cutoff =
        canonical_report_epoch(&server_tick).map_err(|error| error.to_string())?;
    let (period_start, period_end) = validate_till_report_close_request(
        latest_marker.as_deref(),
        input.expected_last_marker.as_deref(),
        &input.period_start,
        &input.period_end,
        &latest_allowed_cutoff,
    )
    .map_err(|error| error.to_string())?;

    let stamp: String =
        sqlx::query_scalar("SELECT DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ')")
            .fetch_one(&mut *tx)
            .await
            .map_err(|error| error.to_string())?;
    let row = ReportMarkerRecord {
        id: input.id,
        till_number: input.till_number.trim().into(),
        marker_type: "period".into(),
        marker_time: period_end.clone(),
        period_start,
        period_end,
        employee_id: input.employee_id,
        report_text: input.report_text,
        report_total: input.report_total,
        created_at: stamp.clone(),
        updated_at: stamp,
    };
    sqlx::query(
        "INSERT INTO till_report_markers
            (id, tillNumber, type, markerTime, periodStart, periodEnd, employeeId,
             reportText, reportTotal, createdAt, updatedAt)
         VALUES (?, ?, 'period', ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&row.id)
    .bind(&row.till_number)
    .bind(&row.marker_time)
    .bind(&row.period_start)
    .bind(&row.period_end)
    .bind(&row.employee_id)
    .bind(&row.report_text)
    .bind(row.report_total)
    .bind(&row.created_at)
    .bind(&row.updated_at)
    .execute(&mut *tx)
    .await
    .map_err(|error| error.to_string())?;
    tx.commit().await.map_err(|error| error.to_string())?;
    Ok(row)
}

#[tauri::command]
pub async fn allocate_mysql_till_sequence(mysql_uri: String) -> Result<i64, String> {
    let pool = connect_mysql_for_pos(&mysql_uri)
        .await
        .map_err(|e| e.to_string())?;
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    assert_mysql_restore_writes_allowed(&mut tx)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query(
        "INSERT INTO settings (`key`, value, updatedAt) VALUES ('till_seq_counter', '1', DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ'))
         ON DUPLICATE KEY UPDATE value = LAST_INSERT_ID(CAST(value AS UNSIGNED) + 1), updatedAt = DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ')"
    )
    .execute(&mut *tx).await.map_err(|e| e.to_string())?;
    let value: String = sqlx::query_scalar(
        "SELECT value FROM settings WHERE `key` = 'till_seq_counter' FOR UPDATE",
    )
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    value.parse::<i64>().map_err(|e| e.to_string())
}

async fn run_mariadb_attendance_audit_import(
    mysql: &MySqlPool,
    local: &SqlitePool,
    till_id: &str,
) -> Result<AttendanceAuditImportResult, sqlx::Error> {
    let committed_controlled_owner: Option<String> = sqlx::query_scalar(
        "SELECT CAST(value AS CHAR CHARACTER SET utf8mb4)
         FROM settings WHERE `key` = ? LIMIT 1",
    )
    .bind(MARIADB_CONTROLLED_IMPORT_OWNER_KEY)
    .fetch_optional(mysql)
    .await?;
    let bootstrap_done: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM settings WHERE `key` = 'bootstrap_done'")
            .fetch_one(mysql)
            .await?;
    if committed_controlled_owner.as_deref() == Some(till_id) && bootstrap_done == 1 {
        let ControlledImportGateClaim::RecoveredCommitted(server_data_epoch) =
            claim_controlled_import_gate(mysql, till_id).await?
        else {
            return Err(account_protocol_error(
                "CONTROLLED_IMPORT_STATE_CHANGED: completed import could not release maintenance",
            ));
        };
        let employee_count = sqlx::query_scalar("SELECT COUNT(*) FROM employees")
            .fetch_one(local)
            .await?;
        let attendance_count = sqlx::query_scalar("SELECT COUNT(*) FROM employee_attendance")
            .fetch_one(local)
            .await?;
        let audit_count = sqlx::query_scalar("SELECT COUNT(*) FROM audit_logs")
            .fetch_one(local)
            .await?;
        return Ok(AttendanceAuditImportResult {
            employee_count,
            attendance_count,
            audit_count,
            server_data_epoch,
        });
    }

    // BEGIN IMMEDIATE blocks local writers for validation and copying. The
    // second pooled connection can run the existing read-only validators while
    // every query observes the same no-writer SQLite state.
    let mut local_snapshot = local.acquire().await?;
    sqlx::query("PRAGMA busy_timeout = 5000")
        .execute(&mut *local_snapshot)
        .await?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *local_snapshot)
        .await?;
    if let Err(error) = validate_restore_schema(local).await {
        let _ = sqlx::query("ROLLBACK").execute(&mut *local_snapshot).await;
        return Err(account_protocol_error(error));
    }
    if let Err(error) = validate_restore_data(local, false).await {
        let _ = sqlx::query("ROLLBACK").execute(&mut *local_snapshot).await;
        return Err(account_protocol_error(error));
    }

    let gate_claim = match claim_controlled_import_gate(mysql, till_id).await {
        Ok(claim) => claim,
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *local_snapshot).await;
            return Err(error);
        }
    };
    if let ControlledImportGateClaim::RecoveredCommitted(server_data_epoch) = gate_claim {
        let _ = sqlx::query("ROLLBACK").execute(&mut *local_snapshot).await;
        let employee_count = sqlx::query_scalar("SELECT COUNT(*) FROM employees")
            .fetch_one(local)
            .await?;
        let attendance_count = sqlx::query_scalar("SELECT COUNT(*) FROM employee_attendance")
            .fetch_one(local)
            .await?;
        let audit_count = sqlx::query_scalar("SELECT COUNT(*) FROM audit_logs")
            .fetch_one(local)
            .await?;
        return Ok(AttendanceAuditImportResult {
            employee_count,
            attendance_count,
            audit_count,
            server_data_epoch,
        });
    }

    // Every remote table and bootstrap marker becomes visible in one commit
    // while the durable restore gate blocks every other MariaDB session.
    let mut mysql_tx = match mysql.begin().await {
        Ok(tx) => tx,
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *local_snapshot).await;
            return match release_controlled_import_gate(mysql, till_id, &utc_stamp()).await {
                Ok(()) => Err(error),
                Err(release_error) => {
                    Err(account_protocol_error(format!("{error}; {release_error}")))
                }
            };
        }
    };
    let operation = async {
        assert_mysql_restore_writes_allowed(&mut mysql_tx).await?;
        assert_no_other_active_tills_in_restore(&mut mysql_tx, till_id).await?;
        assert_no_active_terminal_attempts_in_restore(&mut mysql_tx).await?;

        let local_terminal_table: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'table' AND name = 'payment_terminal_attempts'",
        )
        .fetch_one(&mut *local_snapshot)
        .await?;
        if local_terminal_table != 0 {
            let active: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM payment_terminal_attempts
                 WHERE status IN ('prepared', 'started', 'uncertain', 'approved',
                                  'commit_failed', 'completion_pending')",
            )
            .fetch_one(&mut *local_snapshot)
            .await?;
            if active != 0 {
                return Err(account_protocol_error(format!(
                    "MariaDB import cannot continue while this till has {active} terminal payment attempt(s) needing completion or recovery"
                )));
            }
        }

        let local_shop_id: Option<String> = sqlx::query_scalar(
            "SELECT shopId FROM app_identity WHERE id = 'main' LIMIT 1",
        )
        .fetch_optional(&mut *local_snapshot)
        .await?;
        let local_shop_id = local_shop_id
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                account_protocol_error(
                    "DATABASE_IDENTITY_UNVERIFIED: local SQLite has no verified shop identity",
                )
            })?;
        let remote_shop_id: Option<String> = sqlx::query_scalar(
            "SELECT shopId FROM app_identity WHERE id = 'main' LIMIT 1 FOR UPDATE",
        )
        .fetch_optional(&mut *mysql_tx)
        .await?;
        if remote_shop_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .is_some_and(|value| value != local_shop_id)
        {
            return Err(account_protocol_error(
                "DATABASE_IDENTITY_MISMATCH: local SQLite belongs to a different shop",
            ));
        }
        let mut expected_counts = Vec::new();
        let mut employee_count = 0;
        let mut attendance_count = 0;
        let mut audit_count = 0;
        for table in MARIADB_CONTROLLED_IMPORT_COPY_TABLES {
            let attendance_import = if *table == "employee_attendance" {
                let token = random_record_id();
                let connection_id = begin_attendance_audit_import(&mut mysql_tx, &token).await?;
                Some((connection_id, token))
            } else {
                None
            };
            let copied = copy_restore_table_to_mysql_from_connection(
                &mut *local_snapshot,
                &mut mysql_tx,
                table,
            )
            .await?;
            if let Some((connection_id, token)) = attendance_import {
                finish_attendance_audit_import(&mut mysql_tx, connection_id, &token).await?;
            }
            match *table {
                "employees" => employee_count = copied,
                "employee_attendance" => attendance_count = copied,
                "audit_logs" => audit_count = copied,
                _ => {}
            }
            if *table != "settings" {
                expected_counts.push((*table, copied));
            }
        }

        for (table, expected) in expected_counts {
            let actual: i64 = sqlx::query_scalar(&format!(
                "SELECT COUNT(*) FROM {}",
                mysql_identifier(table)
            ))
            .fetch_one(&mut *mysql_tx)
            .await?;
            if actual != expected {
                return Err(account_protocol_error(format!(
                    "Controlled MariaDB import verification failed for {table}: expected {expected}, found {actual}"
                )));
            }
        }
        let server_data_epoch: String = sqlx::query_scalar(
            "SELECT CONCAT(LEFT(DATE_FORMAT(UTC_TIMESTAMP(3),
                    '%Y-%m-%dT%H:%i:%s.%fZ'), 23), 'Z')",
        )
        .fetch_one(&mut *mysql_tx)
        .await?;
        sqlx::query(
            "INSERT INTO settings (`key`, value, updatedAt)
             VALUES ('bootstrap_done', '1', ?)
             ON DUPLICATE KEY UPDATE value = '1', updatedAt = VALUES(updatedAt)",
        )
        .bind(&server_data_epoch)
        .execute(&mut *mysql_tx)
        .await?;
        sqlx::query(
            "INSERT INTO settings (`key`, value, updatedAt)
             VALUES ('server_data_epoch', ?, ?)
             ON DUPLICATE KEY UPDATE value = VALUES(value), updatedAt = VALUES(updatedAt)",
        )
        .bind(&server_data_epoch)
        .bind(&server_data_epoch)
        .execute(&mut *mysql_tx)
        .await?;
        sqlx::query("DELETE FROM sync_change_log")
            .execute(&mut *mysql_tx)
            .await?;
        Ok::<_, sqlx::Error>(AttendanceAuditImportResult {
            employee_count,
            attendance_count,
            audit_count,
            server_data_epoch,
        })
    }
    .await;

    match operation {
        Ok(result) => {
            if let Err(error) = mysql_tx.commit().await {
                let _ = sqlx::query("ROLLBACK").execute(&mut *local_snapshot).await;
                // A failed commit is ambiguous. Keep the durable gate active so
                // another till cannot observe or build on an uncertain import;
                // retrying this same command performs committed-state recovery.
                return Err(account_protocol_error(format!(
                    "{MARIADB_RESTORE_MAINTENANCE_CODE}: controlled-import commit could not be confirmed ({error}); retry from this till"
                )));
            }
            // This is a read-only snapshot. Rollback releases it without any
            // accidental future write becoming part of the import boundary.
            let _ = sqlx::query("ROLLBACK").execute(&mut *local_snapshot).await;
            release_controlled_import_gate(mysql, till_id, &result.server_data_epoch).await?;
            Ok(result)
        }
        Err(error) => {
            if let Err(rollback_error) = mysql_tx.rollback().await {
                let _ = sqlx::query("ROLLBACK").execute(&mut *local_snapshot).await;
                // Only a confirmed remote rollback may open maintenance again.
                return Err(account_protocol_error(format!(
                    "{MARIADB_RESTORE_MAINTENANCE_CODE}: {error}; MariaDB rollback could not be confirmed ({rollback_error}); retry from this till"
                )));
            }
            let _ = sqlx::query("ROLLBACK").execute(&mut *local_snapshot).await;
            match release_controlled_import_gate(mysql, till_id, &utc_stamp()).await {
                Ok(()) => Err(error),
                Err(release_error) => {
                    Err(account_protocol_error(format!("{error}; {release_error}")))
                }
            }
        }
    }
}

/// Atomically bootstrap an empty MariaDB database from one complete local
/// SQLite snapshot. The durable restore gate hides the entire transaction from
/// every other till; only this exact connection/token suppresses duplicate
/// attendance audits while original audit rows are copied.
#[tauri::command]
pub async fn import_mariadb_attendance_audit_snapshot(
    app: AppHandle,
    mysql_uri: String,
    till_id: String,
) -> Result<AttendanceAuditImportResult, String> {
    if till_id.trim().is_empty() {
        return Err("Controlled MariaDB import requires this till's stable ID".into());
    }
    let mysql = connect_mysql_for_pos(&mysql_uri)
        .await
        .map_err(|error| error.to_string())?;
    sqlx::query("SET SESSION lock_wait_timeout = 8")
        .execute(&mysql)
        .await
        .map_err(|error| error.to_string())?;
    sqlx::query("SET SESSION innodb_lock_wait_timeout = 8")
        .execute(&mysql)
        .await
        .map_err(|error| error.to_string())?;
    let acquired: Option<i64> = sqlx::query_scalar("SELECT GET_LOCK(?, ?)")
        .bind(MARIADB_ATTENDANCE_AUDIT_IMPORT_LOCK_NAME)
        .bind(MARIADB_ATTENDANCE_AUDIT_IMPORT_LOCK_SECONDS)
        .fetch_one(&mysql)
        .await
        .map_err(|error| error.to_string())?;
    if acquired != Some(1) {
        mysql.close().await;
        return Err("Another till is already importing attendance history; try again".into());
    }

    let result = async {
        let local_path = local_db_path(&app).map_err(|error| account_protocol_error(error))?;
        if !local_path.exists() {
            return Err(account_protocol_error("Local database does not exist"));
        }
        let local = SqlitePoolOptions::new()
            .max_connections(2)
            .connect(&format!("sqlite://{}?mode=rw", local_path.display()))
            .await?;
        ensure_mysql_restore_guard_schema(&mysql).await?;
        ensure_mysql_whole_system_close_schema(&mysql).await?;
        ensure_mysql_account_ledger_guards(&mysql).await?;
        assert_attendance_audit_import_schema_ready(&mysql).await?;
        assert_employee_profile_authority_schema_ready(&mysql).await?;
        let imported = run_mariadb_attendance_audit_import(&mysql, &local, till_id.trim()).await;
        local.close().await;
        imported
    }
    .await;

    // Defense in depth for every error/commit path. A committed import has no
    // marker; a rolled-back one loses it atomically. Clearing both makes a
    // reused pooled session incapable of suppressing a later live audit.
    let _ = sqlx::query("SET @lbj_pos_attendance_audit_import = NULL")
        .execute(&mysql)
        .await;
    let _ = sqlx::query("SET @lbj_pos_employee_profile_authority = NULL")
        .execute(&mysql)
        .await;
    let _ = sqlx::query("SET @lbj_pos_restore_bypass = NULL")
        .execute(&mysql)
        .await;
    let _ = sqlx::query(
        "DELETE FROM pos_attendance_audit_import_sessions
         WHERE connectionId = CONNECTION_ID()",
    )
    .execute(&mysql)
    .await;
    let _ = sqlx::query(
        "DELETE FROM pos_employee_profile_write_authority
         WHERE connectionId = CONNECTION_ID()",
    )
    .execute(&mysql)
    .await;
    let _ = sqlx::query("SELECT RELEASE_LOCK(?)")
        .bind(MARIADB_ATTENDANCE_AUDIT_IMPORT_LOCK_NAME)
        .execute(&mysql)
        .await;
    mysql.close().await;
    result.map_err(|error| error.to_string())
}

async fn run_mariadb_employee_profile_cas(
    mysql: &MySqlPool,
    employee: &EmployeeProfileRecord,
    expected_updated_at: Option<&str>,
    actor_employee_id: &str,
    actor_expected_updated_at: &str,
) -> Result<EmployeeProfileRecord, sqlx::Error> {
    let mut tx = mysql.begin().await?;
    let operation = async {
        assert_mysql_restore_writes_allowed(&mut tx).await?;
        // Staff authorization changes are rare. Locking the complete set gives
        // first-admin creation and the last-admin invariant one serialization
        // point, including the empty-table next-key gap.
        let locked_employees = lock_all_employee_profiles(&mut tx).await?;
        let before = locked_employees
            .iter()
            .find(|current| current.id == employee.id)
            .cloned();
        if !employee_profile_credentials_allowed(before.as_ref(), employee) {
            return Err(account_protocol_error(
                "EMPLOYEE_PROFILE_PIN_INVALID: new or changed staff credentials require a secure PIN reset",
            ));
        }
        let audit_actor = if actor_employee_id.is_empty() {
            assert_first_admin_bootstrap_allowed(employee, &locked_employees)?;
            "system/bootstrap".to_string()
        } else {
            let actor = authorize_employee_profile_actor(
                &mut tx,
                actor_employee_id,
                actor_expected_updated_at,
            )
            .await?;
            assert_employee_profile_actor_scope(&actor, before.as_ref(), employee)?;
            actor.id
        };
        match (expected_updated_at, before.as_ref()) {
            (None, Some(_)) | (Some(_), None) => {
                return Err(account_protocol_error("EMPLOYEE_PROFILE_CONFLICT"));
            }
            (Some(expected), Some(current)) if current.updated_at != expected => {
                return Err(account_protocol_error("EMPLOYEE_PROFILE_CONFLICT"));
            }
            _ => {}
        }

        let token = random_record_id();
        let connection_id = begin_employee_profile_authority(&mut tx, &token).await?;
        let stamp = "CONCAT(LEFT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ'), 23), 'Z')";
        if expected_updated_at.is_none() {
            sqlx::query(&format!(
                "INSERT INTO employees
                    (id, storeId, name, pin, pinHash, role, email, isActive,
                     createdAt, updatedAt)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, {stamp})"
            ))
            .bind(&employee.id)
            .bind(&employee.store_id)
            .bind(&employee.name)
            .bind(&employee.pin)
            .bind(&employee.pin_hash)
            .bind(&employee.role)
            .bind(&employee.email)
            .bind(i64::from(employee.is_active))
            .bind(&employee.created_at)
            .execute(&mut *tx)
            .await
            .map_err(|error| {
                if error
                    .as_database_error()
                    .and_then(|db| db.code())
                    .as_deref()
                    == Some("1062")
                {
                    account_protocol_error("EMPLOYEE_PROFILE_CONFLICT")
                } else {
                    error
                }
            })?;
        } else {
            let result = sqlx::query(&format!(
                "UPDATE employees e
                 LEFT JOIN employee_attendance attendance
                   ON attendance.employeeId = e.id AND attendance.status = 'open'
                 SET e.storeId = ?, e.name = ?, e.pin = ?, e.pinHash = ?,
                     e.role = ?, e.email = ?, e.isActive = ?, e.updatedAt = {stamp}
                 WHERE BINARY e.id = BINARY ?
                   AND BINARY COALESCE(e.updatedAt, '') = BINARY ?
                   AND (? <> 0 OR attendance.id IS NULL)"
            ))
            .bind(&employee.store_id)
            .bind(&employee.name)
            .bind(&employee.pin)
            .bind(&employee.pin_hash)
            .bind(&employee.role)
            .bind(&employee.email)
            .bind(i64::from(employee.is_active))
            .bind(&employee.id)
            .bind(expected_updated_at.unwrap_or_default())
            .bind(i64::from(employee.is_active))
            .execute(&mut *tx)
            .await?;
            if result.rows_affected() != 1 {
                let open_attendance: i64 = sqlx::query_scalar(
                    "SELECT COUNT(*) FROM employee_attendance
                     WHERE BINARY employeeId = BINARY ? AND status = 'open'",
                )
                .bind(&employee.id)
                .fetch_one(&mut *tx)
                .await?;
                return Err(account_protocol_error(if !employee.is_active && open_attendance > 0 {
                    "ATTENDANCE_OPEN_SESSION"
                } else {
                    "EMPLOYEE_PROFILE_CONFLICT"
                }));
            }
        }

        let saved = select_employee_profile_for_update(&mut tx, &employee.id)
            .await?
            .ok_or_else(|| account_protocol_error("Could not confirm the staff change in MariaDB"))?;
        let authoritative_employees = lock_all_employee_profiles(&mut tx).await?;
        if !authoritative_employees.iter().any(employee_is_usable_admin) {
            return Err(account_protocol_error(
                "LAST_ACTIVE_ADMIN_REQUIRED: at least one active administrator with a usable PIN must remain",
            ));
        }
        let audit_id = random_record_id();
        let old_data = before
            .as_ref()
            .map(employee_profile_audit_json)
            .unwrap_or_default();
        let new_data = employee_profile_audit_json(&saved);
        sqlx::query(&format!(
            "INSERT INTO audit_logs
                (id, employeeId, action, entityType, entityId,
                 oldData, newData, createdAt, updatedAt)
             VALUES (?, ?, ?, 'employee', ?, ?, ?, {stamp}, {stamp})"
        ))
        .bind(&audit_id)
        .bind(&audit_actor)
        .bind(if before.is_some() {
            "employee_updated"
        } else {
            "employee_created"
        })
        .bind(&saved.id)
        .bind(old_data)
        .bind(new_data)
        .execute(&mut *tx)
        .await?;
        finish_employee_profile_authority(&mut tx, connection_id, &token).await?;
        Ok::<_, sqlx::Error>(saved)
    }
    .await;

    match operation {
        Ok(saved) => {
            tx.commit().await?;
            Ok(saved)
        }
        Err(error) => {
            let _ = tx.rollback().await;
            Err(error)
        }
    }
}

fn legacy_pin_sha256(pin: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("pos-pin-v1:{pin}").as_bytes());
    format!("{:x}", hasher.finalize())
}

fn legacy_employee_pin_matches(employee: &EmployeeProfileRecord, candidate: &str) -> bool {
    if employee.pin_hash.is_empty() {
        is_valid_legacy_plaintext_pin(&employee.pin) && employee.pin == candidate
    } else {
        is_valid_legacy_sha256_pin_hash(&employee.pin_hash)
            && employee
                .pin_hash
                .eq_ignore_ascii_case(&legacy_pin_sha256(candidate))
    }
}

async fn run_mariadb_employee_legacy_pin_upgrade(
    mysql: &MySqlPool,
    employee_id: &str,
    expected_updated_at: &str,
    old_pin: &str,
    new_pin_hash: &str,
) -> Result<EmployeeProfileRecord, sqlx::Error> {
    let mut tx = mysql.begin().await?;
    let operation = async {
        assert_mysql_restore_writes_allowed(&mut tx).await?;
        let before = select_employee_profile_for_update(&mut tx, employee_id)
            .await?
            .ok_or_else(|| account_protocol_error("EMPLOYEE_PROFILE_CONFLICT"))?;
        if before.updated_at != expected_updated_at {
            return Err(account_protocol_error("EMPLOYEE_PROFILE_CONFLICT"));
        }
        if !before.is_active
            || !matches!(
                before.role.as_str(),
                "admin" | "manager" | "supervisor" | "cashier"
            )
        {
            return Err(account_protocol_error(
                "EMPLOYEE_PROFILE_ACTOR_STALE: this staff account can no longer sign in",
            ));
        }
        if !legacy_employee_pin_matches(&before, old_pin) {
            return Err(account_protocol_error(
                "EMPLOYEE_PROFILE_LEGACY_PIN_MISMATCH: the authoritative legacy PIN changed",
            ));
        }

        let token = random_record_id();
        let connection_id = begin_employee_profile_authority(&mut tx, &token).await?;
        let stamp = "CONCAT(LEFT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ'), 23), 'Z')";
        let updated = sqlx::query(&format!(
            "UPDATE employees SET pin = '', pinHash = ?, updatedAt = {stamp}
             WHERE BINARY id = BINARY ?
               AND BINARY COALESCE(updatedAt, '') = BINARY ?"
        ))
        .bind(new_pin_hash)
        .bind(employee_id)
        .bind(expected_updated_at)
        .execute(&mut *tx)
        .await?;
        if updated.rows_affected() != 1 {
            return Err(account_protocol_error("EMPLOYEE_PROFILE_CONFLICT"));
        }
        let saved = select_employee_profile_for_update(&mut tx, employee_id)
            .await?
            .ok_or_else(|| account_protocol_error("EMPLOYEE_PROFILE_CONFLICT"))?;
        sqlx::query(&format!(
            "INSERT INTO audit_logs
                (id, employeeId, action, entityType, entityId,
                 oldData, newData, createdAt, updatedAt)
             VALUES (?, ?, 'employee_pin_hash_upgraded', 'employee', ?, ?, ?, {stamp}, {stamp})"
        ))
        .bind(random_record_id())
        .bind(employee_id)
        .bind(employee_id)
        .bind(employee_profile_audit_json(&before))
        .bind(employee_profile_audit_json(&saved))
        .execute(&mut *tx)
        .await?;
        finish_employee_profile_authority(&mut tx, connection_id, &token).await?;
        Ok::<_, sqlx::Error>(saved)
    }
    .await;
    match operation {
        Ok(saved) => {
            tx.commit().await?;
            Ok(saved)
        }
        Err(error) => {
            let _ = tx.rollback().await;
            Err(error)
        }
    }
}

/// Narrow self-service migration used only immediately after a successful
/// authoritative legacy-PIN login. It cannot change role, activation, or any
/// profile field besides the credential representation and server timestamp.
#[tauri::command]
pub async fn upgrade_mariadb_employee_legacy_pin(
    mysql_uri: String,
    employee_id: String,
    expected_updated_at: String,
    old_pin: String,
    new_pin_hash: String,
) -> Result<EmployeeProfileRecord, String> {
    if employee_id.trim().is_empty()
        || expected_updated_at.trim().is_empty()
        || !is_valid_legacy_plaintext_pin(&old_pin)
        || !is_valid_pbkdf2_pin_hash(&new_pin_hash)
    {
        return Err("Invalid legacy PIN upgrade request".into());
    }
    let mysql = connect_mysql_for_pos(&mysql_uri)
        .await
        .map_err(|error| error.to_string())?;
    sqlx::query("SET SESSION innodb_lock_wait_timeout = 5")
        .execute(&mysql)
        .await
        .map_err(|error| error.to_string())?;
    let result = async {
        assert_employee_profile_authority_schema_ready(&mysql).await?;
        run_mariadb_employee_legacy_pin_upgrade(
            &mysql,
            employee_id.trim(),
            expected_updated_at.trim(),
            &old_pin,
            &new_pin_hash,
        )
        .await
    }
    .await;
    let _ = sqlx::query("SET @lbj_pos_employee_profile_authority = NULL")
        .execute(&mysql)
        .await;
    let _ = sqlx::query(
        "DELETE FROM pos_employee_profile_write_authority
         WHERE connectionId = CONNECTION_ID()",
    )
    .execute(&mysql)
    .await;
    mysql.close().await;
    result.map_err(|error| error.to_string())
}

/// Server-authoritative staff mutation. The short-lived write authority, CAS,
/// employee row, and redacted audit event all commit or roll back together.
#[tauri::command]
pub async fn save_mariadb_employee_profile_cas(
    mysql_uri: String,
    employee: EmployeeProfileRecord,
    expected_updated_at: Option<String>,
    actor_employee_id: String,
    actor_expected_updated_at: String,
) -> Result<EmployeeProfileRecord, String> {
    if employee.id.trim().is_empty() || employee.name.trim().is_empty() {
        return Err("Staff ID and name are required".into());
    }
    let bootstrap_actor = actor_employee_id.trim().is_empty();
    if bootstrap_actor
        && (expected_updated_at.is_some() || employee.role != "admin" || !employee.is_active)
    {
        return Err("The manager authorizing this staff change is required".into());
    }
    if !bootstrap_actor && actor_expected_updated_at.trim().is_empty() {
        return Err("The authorizing staff session is stale; sign in again".into());
    }
    if let Some(expected) = expected_updated_at.as_deref() {
        if expected.trim().is_empty() {
            return Err("EMPLOYEE_PROFILE_CONFLICT: the expected staff version is missing".into());
        }
    }
    if !matches!(
        employee.role.as_str(),
        "admin" | "manager" | "supervisor" | "cashier" | "attendance"
    ) {
        return Err("Choose a valid staff role".into());
    }

    let mysql = connect_mysql_for_pos(&mysql_uri)
        .await
        .map_err(|error| error.to_string())?;
    sqlx::query("SET SESSION innodb_lock_wait_timeout = 5")
        .execute(&mysql)
        .await
        .map_err(|error| error.to_string())?;
    let bootstrap_lock = if bootstrap_actor {
        let acquired: Option<i64> = sqlx::query_scalar("SELECT GET_LOCK(?, 5)")
            .bind(MARIADB_EMPLOYEE_ADMIN_BOOTSTRAP_LOCK_NAME)
            .fetch_one(&mysql)
            .await
            .map_err(|error| error.to_string())?;
        if acquired != Some(1) {
            mysql.close().await;
            return Err("Another till is creating the first administrator; try again".into());
        }
        true
    } else {
        false
    };
    let result = async {
        assert_employee_profile_authority_schema_ready(&mysql).await?;
        run_mariadb_employee_profile_cas(
            &mysql,
            &employee,
            expected_updated_at.as_deref(),
            actor_employee_id.trim(),
            actor_expected_updated_at.trim(),
        )
        .await
    }
    .await;
    let _ = sqlx::query("SET @lbj_pos_employee_profile_authority = NULL")
        .execute(&mysql)
        .await;
    let _ = sqlx::query(
        "DELETE FROM pos_employee_profile_write_authority
         WHERE connectionId = CONNECTION_ID()",
    )
    .execute(&mysql)
    .await;
    if bootstrap_lock {
        let _ = sqlx::query("SELECT RELEASE_LOCK(?)")
            .bind(MARIADB_EMPLOYEE_ADMIN_BOOTSTRAP_LOCK_NAME)
            .execute(&mysql)
            .await;
    }
    mysql.close().await;
    result.map_err(|error| error.to_string())
}

async fn validate_mariadb_restore_identity(
    local: &SqlitePool,
    tx: &mut sqlx::Transaction<'_, MySql>,
) -> Result<(), sqlx::Error> {
    let local_shop_id: Option<String> =
        sqlx::query_scalar("SELECT shopId FROM app_identity WHERE id = 'main' LIMIT 1")
            .fetch_optional(local)
            .await?;
    let local_shop_id = local_shop_id
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            account_protocol_error(
                "DATABASE_IDENTITY_UNVERIFIED: restored SQLite has no verified shop identity",
            )
        })?;
    let remote_shop_id: Option<String> =
        sqlx::query_scalar("SELECT shopId FROM app_identity WHERE id = 'main' LIMIT 1")
            .fetch_optional(&mut **tx)
            .await?;
    if let Some(remote_shop_id) = remote_shop_id.filter(|value| !value.trim().is_empty()) {
        if remote_shop_id != local_shop_id {
            return Err(account_protocol_error(
                "DATABASE_IDENTITY_MISMATCH: restored SQLite belongs to a different shop",
            ));
        }
    } else {
        let populated: i64 = sqlx::query_scalar(
            "SELECT
               (SELECT COUNT(*) FROM products)
             + (SELECT COUNT(*) FROM categories)
             + (SELECT COUNT(*) FROM orders)
             + (SELECT COUNT(*) FROM customers)",
        )
        .fetch_one(&mut **tx)
        .await?;
        if populated > 0 {
            return Err(account_protocol_error(
                "DATABASE_IDENTITY_UNVERIFIED: populated MariaDB has no verified shop identity",
            ));
        }
    }
    Ok(())
}

async fn validate_mariadb_restore_identity_from_connection(
    local: &mut SqliteConnection,
    tx: &mut sqlx::Transaction<'_, MySql>,
) -> Result<(), sqlx::Error> {
    let local_shop_id: Option<String> =
        sqlx::query_scalar("SELECT shopId FROM app_identity WHERE id = 'main' LIMIT 1")
            .fetch_optional(&mut *local)
            .await?;
    let local_shop_id = local_shop_id
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            account_protocol_error(
                "DATABASE_IDENTITY_UNVERIFIED: restored SQLite has no verified shop identity",
            )
        })?;
    let remote_shop_id: Option<String> =
        sqlx::query_scalar("SELECT shopId FROM app_identity WHERE id = 'main' LIMIT 1")
            .fetch_optional(&mut **tx)
            .await?;
    if let Some(remote_shop_id) = remote_shop_id.filter(|value| !value.trim().is_empty()) {
        if remote_shop_id != local_shop_id {
            return Err(account_protocol_error(
                "DATABASE_IDENTITY_MISMATCH: restored SQLite belongs to a different shop",
            ));
        }
    } else {
        let populated: i64 = sqlx::query_scalar(
            "SELECT
               (SELECT COUNT(*) FROM products)
             + (SELECT COUNT(*) FROM categories)
             + (SELECT COUNT(*) FROM orders)
             + (SELECT COUNT(*) FROM customers)",
        )
        .fetch_one(&mut **tx)
        .await?;
        if populated > 0 {
            return Err(account_protocol_error(
                "DATABASE_IDENTITY_UNVERIFIED: populated MariaDB has no verified shop identity",
            ));
        }
    }
    Ok(())
}

async fn run_mariadb_restore_replacement(
    mysql: &MySqlPool,
    local: &SqlitePool,
    till_id: &str,
) -> Result<MariaDbRestoreResult, sqlx::Error> {
    // Freeze and validate the local source before activating durable MariaDB
    // maintenance. A busy/corrupt SQLite file therefore cannot strand every
    // till behind a restore gate that never began copying.
    let mut local_snapshot = local.acquire().await?;
    sqlx::query("PRAGMA busy_timeout = 5000")
        .execute(&mut *local_snapshot)
        .await?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *local_snapshot)
        .await?;
    if let Err(error) = validate_restore_schema(local).await {
        let _ = sqlx::query("ROLLBACK").execute(&mut *local_snapshot).await;
        return Err(account_protocol_error(error));
    }
    if let Err(error) = validate_restore_data(local, false).await {
        let _ = sqlx::query("ROLLBACK").execute(&mut *local_snapshot).await;
        return Err(account_protocol_error(error));
    }

    let existing_marker: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE `key` = ? LIMIT 1")
            .bind(MARIADB_RESTORE_MAINTENANCE_KEY)
            .fetch_optional(mysql)
            .await?;
    let marker_owner = existing_marker.as_deref().unwrap_or("");
    match restore_gate_write_decision(
        i64::from(existing_marker.is_some()),
        marker_owner,
        Some(till_id),
    ) {
        RestoreGateWriteDecision::Allowed => {}
        RestoreGateWriteDecision::MaintenanceBlocked => {
            return Err(account_protocol_error(format!(
                "{MARIADB_RESTORE_MAINTENANCE_CODE}: MariaDB restore is owned by another till"
            )));
        }
        RestoreGateWriteDecision::Corrupt => {
            return Err(account_protocol_error(format!(
                "{MYSQL_COORDINATION_SCHEMA_CORRUPT_CODE}: restore maintenance owner is blank"
            )));
        }
    }

    sqlx::query("SET @lbj_pos_restore_bypass = ?")
        .bind(till_id)
        .execute(mysql)
        .await?;
    let stamp: String =
        sqlx::query_scalar("SELECT DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ')")
            .fetch_one(mysql)
            .await?;

    // Atomically exclude a whole-system close and claim the restore gate. Both
    // transitions lock close-barrier first and restore-gate second, so neither
    // can pass a stale check while the other activates.
    let mut claim_tx = mysql.begin().await?;
    cleanup_expired_whole_system_close(&mut claim_tx).await?;
    let close_barrier = locked_whole_system_close_barrier(&mut claim_tx).await?;
    if close_barrier.state != "idle" {
        return Err(account_protocol_error(format!(
            "{WHOLE_SYSTEM_CLOSE_IN_PROGRESS_CODE}: abort the whole-system close before restoring MariaDB"
        )));
    }
    let gate: Option<(String, i64)> = sqlx::query_as(MYSQL_RESTORE_GATE_LOCK_SELECT)
        .fetch_optional(&mut *claim_tx)
        .await?;
    let (gate_owner, gate_active) = gate.ok_or_else(|| {
        account_protocol_error(format!(
            "{MYSQL_COORDINATION_SCHEMA_MISSING_CODE}: pos_restore_gate row 1 is required before restoring MariaDB"
        ))
    })?;
    match restore_gate_write_decision(gate_active, &gate_owner, Some(till_id)) {
        RestoreGateWriteDecision::Allowed => {}
        RestoreGateWriteDecision::MaintenanceBlocked => {
            return Err(account_protocol_error(format!(
                "{MARIADB_RESTORE_MAINTENANCE_CODE}: MariaDB restore is owned by another till"
            )));
        }
        RestoreGateWriteDecision::Corrupt => {
            return Err(account_protocol_error(format!(
                "{MYSQL_COORDINATION_SCHEMA_CORRUPT_CODE}: pos_restore_gate row 1 has an invalid state"
            )));
        }
    }
    sqlx::query(
        "UPDATE pos_restore_gate
         SET ownerTillId = ?, isActive = 1, claimedAt = ?
         WHERE id = 1 AND (
           isActive = 0 OR (
             isActive = 1 AND BINARY ownerTillId = BINARY ?
           )
         )",
    )
    .bind(till_id)
    .bind(&stamp)
    .bind(till_id)
    .execute(&mut *claim_tx)
    .await?;
    let claimed_owner: Option<String> = sqlx::query_scalar(MYSQL_RESTORE_GATE_ACTIVE_OWNER_SELECT)
        .fetch_optional(&mut *claim_tx)
        .await?;
    if claimed_owner.as_deref() != Some(till_id) {
        return Err(account_protocol_error(format!(
            "{MARIADB_RESTORE_MAINTENANCE_CODE}: MariaDB restore ownership changed"
        )));
    }
    sqlx::query(
        "INSERT INTO settings (`key`, value, updatedAt)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE
           value = IF(value = VALUES(value), VALUES(value), value),
           updatedAt = IF(value = VALUES(value), VALUES(updatedAt), updatedAt)",
    )
    .bind(MARIADB_RESTORE_MAINTENANCE_KEY)
    .bind(till_id)
    .bind(&stamp)
    .execute(&mut *claim_tx)
    .await?;
    let marker_owner: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE `key` = ? LIMIT 1")
            .bind(MARIADB_RESTORE_MAINTENANCE_KEY)
            .fetch_optional(&mut *claim_tx)
            .await?;
    if marker_owner.as_deref() != Some(till_id) {
        return Err(account_protocol_error(format!(
            "{MARIADB_RESTORE_MAINTENANCE_CODE}: the legacy maintenance marker is owned by another till"
        )));
    }
    claim_tx.commit().await?;

    let mut tx = mysql.begin().await?;
    assert_mysql_restore_writes_allowed(&mut tx).await?;
    // Recheck after the gate is active and again in the same transaction which
    // performs the first delete. A newly-awakened till is still blocked by the
    // permanent triggers even if it appears immediately after this query.
    assert_no_other_active_tills_in_restore(&mut tx, till_id).await?;
    assert_no_active_terminal_attempts_in_restore(&mut tx).await?;
    assert_no_active_local_terminal_attempts_from_connection(&mut *local_snapshot).await?;
    validate_mariadb_restore_identity_from_connection(&mut *local_snapshot, &mut tx).await?;

    for table in MARIADB_RESTORE_DELETE_TABLES {
        let exists: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
        )
        .bind(table)
        .fetch_one(&mut *tx)
        .await?;
        if exists > 0 {
            sqlx::query(&format!("DELETE FROM {}", mysql_identifier(table)))
                .execute(&mut *tx)
                .await?;
        }
    }
    sqlx::query(
        "DELETE FROM settings
         WHERE `key` NOT IN (?, 'till_seq_counter', 'bootstrap_done', 'server_data_epoch')",
    )
    .bind(MARIADB_RESTORE_MAINTENANCE_KEY)
    .execute(&mut *tx)
    .await?;
    let mut expected_counts = Vec::new();
    for table in MARIADB_RESTORE_COPY_TABLES {
        let attendance_import = if *table == "employee_attendance" {
            let token = random_record_id();
            let connection_id = begin_attendance_audit_import(&mut tx, &token).await?;
            Some((connection_id, token))
        } else {
            None
        };
        let copied =
            copy_restore_table_to_mysql_from_connection(&mut *local_snapshot, &mut tx, table)
                .await?;
        if let Some((connection_id, token)) = attendance_import {
            finish_attendance_audit_import(&mut tx, connection_id, &token).await?;
        }
        if *table != "settings" {
            expected_counts.push((*table, copied));
        }
    }
    for (table, expected) in expected_counts {
        let actual: i64 =
            sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {}", mysql_identifier(table)))
                .fetch_one(&mut *tx)
                .await?;
        if actual != expected {
            return Err(account_protocol_error(format!(
                "MariaDB replace verification failed for {table}: expected {expected}, found {actual}"
            )));
        }
    }

    // The cutoff guard is durable server metadata rather than backup-owned
    // data. Realign it to the markers that were just restored in this same
    // transaction; otherwise an older/newer backup could retain the previous
    // server cutoff and reject valid queued sales or admit stale ones.
    sqlx::query(
        "UPDATE pos_close_barrier
         SET lastClosedAt = (
           SELECT MAX(STR_TO_DATE(
             REPLACE(REPLACE(markerTime, 'T', ' '), 'Z', ''),
             '%Y-%m-%d %H:%i:%s.%f'
           )) FROM till_report_markers
           WHERE tillNumber = '' AND type = 'period'
         )
         WHERE id = 1",
    )
    .execute(&mut *tx)
    .await?;

    let epoch: String =
        sqlx::query_scalar("SELECT DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ')")
            .fetch_one(&mut *tx)
            .await?;
    sqlx::query(
        "INSERT INTO settings (`key`, value, updatedAt)
         VALUES ('bootstrap_done', '1', ?)
         ON DUPLICATE KEY UPDATE value = '1', updatedAt = VALUES(updatedAt)",
    )
    .bind(&epoch)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO settings (`key`, value, updatedAt)
         VALUES ('server_data_epoch', ?, ?)
         ON DUPLICATE KEY UPDATE value = VALUES(value), updatedAt = VALUES(updatedAt)",
    )
    .bind(&epoch)
    .bind(&epoch)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM sync_change_log")
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    sqlx::query("ROLLBACK")
        .execute(&mut *local_snapshot)
        .await?;

    // Committed data is now coherent. Open the gate first, then remove the
    // legacy marker. A crash before this point leaves a fail-closed retry.
    sqlx::query(
        "UPDATE pos_restore_gate
         SET isActive = 0, claimedAt = ?
         WHERE id = 1 AND ownerTillId = ? AND isActive = 1",
    )
    .bind(&epoch)
    .bind(till_id)
    .execute(mysql)
    .await?;
    let still_active: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM pos_restore_gate WHERE id = 1 AND isActive = 1")
            .fetch_one(mysql)
            .await?;
    if still_active > 0 {
        return Err(account_protocol_error(format!(
            "{MARIADB_RESTORE_MAINTENANCE_CODE}: replacement committed but the durable gate could not be released"
        )));
    }
    sqlx::query("DELETE FROM settings WHERE `key` = ? AND value = ?")
        .bind(MARIADB_RESTORE_MAINTENANCE_KEY)
        .bind(till_id)
        .execute(mysql)
        .await?;
    Ok(MariaDbRestoreResult {
        server_data_epoch: epoch,
    })
}

#[tauri::command]
pub async fn replace_mariadb_from_local_restore(
    app: AppHandle,
    mysql_uri: String,
    till_id: String,
) -> Result<MariaDbRestoreResult, String> {
    if till_id.trim().is_empty() {
        return Err("MariaDB replacement requires this till's stable ID".into());
    }
    let local_path = local_db_path(&app)?;
    if !local_path.exists() {
        return Err("Local restored database does not exist".into());
    }
    let local_uri = format!("sqlite://{}?mode=rw", local_path.display());
    let local = SqlitePoolOptions::new()
        .max_connections(2)
        .connect(&local_uri)
        .await
        .map_err(|error| format!("Could not open restored SQLite: {error}"))?;
    validate_restore_schema(&local).await?;
    validate_restore_data(&local, false).await?;

    let mysql = connect_mysql_for_pos(&mysql_uri)
        .await
        .map_err(|error| error.to_string())?;
    let acquired: Option<i64> = sqlx::query_scalar("SELECT GET_LOCK(?, 8)")
        .bind(MARIADB_RESTORE_LOCK_NAME)
        .fetch_one(&mysql)
        .await
        .map_err(|error| error.to_string())?;
    if acquired != Some(1) {
        local.close().await;
        mysql.close().await;
        return Err("Another till is already preparing a MariaDB replacement".into());
    }

    let result = async {
        ensure_mysql_restore_guard_schema(&mysql).await?;
        ensure_mysql_whole_system_close_schema(&mysql).await?;
        ensure_mysql_account_ledger_guards(&mysql).await?;
        assert_attendance_audit_import_schema_ready(&mysql).await?;
        assert_employee_profile_authority_schema_ready(&mysql).await?;
        run_mariadb_restore_replacement(&mysql, &local, till_id.trim()).await
    }
    .await;
    // Never let a bypass escape into later work on this pooled session.
    let _ = sqlx::query("SET @lbj_pos_restore_bypass = NULL")
        .execute(&mysql)
        .await;
    let _ = sqlx::query("SET @lbj_pos_attendance_audit_import = NULL")
        .execute(&mysql)
        .await;
    let _ = sqlx::query("SET @lbj_pos_employee_profile_authority = NULL")
        .execute(&mysql)
        .await;
    let _ = sqlx::query("SELECT RELEASE_LOCK(?)")
        .bind(MARIADB_RESTORE_LOCK_NAME)
        .execute(&mysql)
        .await;
    local.close().await;
    mysql.close().await;
    result.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn create_local_backup(
    app: AppHandle,
    backup_directory: Option<String>,
) -> Result<String, String> {
    let source = local_db_path(&app)?;
    if !source.exists() {
        return Err("Local database does not exist yet".into());
    }
    let backup_dir = selected_till_backup_dir(&app, &source, backup_directory.as_deref()).await?;
    create_local_backup_in_dir(&source, &backup_dir)
        .await
        .map(|path| path.display().to_string())
}

async fn validate_backup_snapshot(source: &PathBuf) -> Result<(), String> {
    if !source.is_file() {
        return Err("The backup file was not created".into());
    }
    let uri = format!("sqlite://{}?mode=ro", source.display());
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&uri)
        .await
        .map_err(|e| format!("Could not open the new backup: {e}"))?;
    let result = async {
        let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
            .fetch_one(&pool)
            .await
            .map_err(|e| format!("Could not verify the new backup: {e}"))?;
        if !integrity.eq_ignore_ascii_case("ok") {
            return Err(format!(
                "The new backup failed its integrity check: {integrity}"
            ));
        }
        for table in ["settings", "products"] {
            let count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
            )
            .bind(table)
            .fetch_one(&pool)
            .await
            .map_err(|e| format!("Could not inspect the new backup: {e}"))?;
            if count == 0 {
                return Err(format!("The new backup is missing required table {table}"));
            }
        }
        Ok(())
    }
    .await;
    pool.close().await;
    result
}

async fn create_local_backup_in_dir(
    source: &PathBuf,
    backup_dir: &PathBuf,
) -> Result<PathBuf, String> {
    fs::create_dir_all(backup_dir).map_err(|e| e.to_string())?;
    let name = format!(
        "pos-backup-{}.db",
        chrono::Utc::now().format("%Y%m%d-%H%M%S-%3f")
    );
    let target = backup_dir.join(name);
    if target.exists() {
        return Err("A backup with the same timestamp already exists; try again".into());
    }
    create_sqlite_snapshot(source, &target).await?;
    if let Err(error) = validate_backup_snapshot(&target).await {
        let _ = fs::remove_file(&target);
        return Err(error);
    }
    Ok(target)
}

async fn create_sqlite_snapshot(source: &PathBuf, target: &PathBuf) -> Result<(), String> {
    let uri = format!("sqlite://{}?mode=rw", source.display());
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&uri)
        .await
        .map_err(|e| format!("Could not open the local database for backup: {e}"))?;
    let _ = sqlx::query("PRAGMA busy_timeout = 10000")
        .execute(&pool)
        .await;
    let escaped = target.display().to_string().replace('\'', "''");
    let backup_result = sqlx::query(&format!("VACUUM INTO '{escaped}'"))
        .execute(&pool)
        .await
        .map_err(|e| format!("Could not create the local backup: {e}"));
    pool.close().await;
    if let Err(error) = backup_result {
        let _ = fs::remove_file(&target);
        return Err(error);
    }
    Ok(())
}

async fn sanitize_automatic_setup_backup(target: &PathBuf) -> Result<(), String> {
    let uri = format!("sqlite://{}?mode=rw", target.display());
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&uri)
        .await
        .map_err(|e| format!("Could not open the automatic setup backup: {e}"))?;
    let table_rows = sqlx::query("SELECT name FROM sqlite_master WHERE type = 'table'")
        .fetch_all(&pool)
        .await
        .map_err(|e| format!("Could not inspect automatic setup backup tables: {e}"))?;
    let tables: std::collections::HashSet<String> = table_rows
        .into_iter()
        .filter_map(|row| row.try_get::<String, _>("name").ok())
        .collect();
    sqlx::query("PRAGMA secure_delete = ON")
        .execute(&pool)
        .await
        .map_err(|e| format!("Could not enable secure cleanup for setup backup: {e}"))?;

    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("Could not prepare the automatic setup backup: {e}"))?;
    let result = async {
        // A setup backup is portable shop data, not a clone of the source
        // machine. The restoring till recreates its own register identity.
        if tables.contains("registers") {
            sqlx::query("DELETE FROM registers")
                .execute(&mut *tx)
                .await
                .map_err(|e| format!("Could not remove till identities from setup backup: {e}"))?;
        }
        if tables.contains("orders") && tables.contains("inventory_logs") {
            sqlx::query(
                "DELETE FROM inventory_logs WHERE referenceId IN (SELECT id FROM orders)",
            )
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("Could not remove sales stock history: {e}"))?;
        }
        if tables.contains("audit_logs") {
            let mut predicates = vec![
                "entityType IN ('order','shift','cash_movement','report')".to_string(),
                "action IN ('sale_completed','order_refunded','order_partially_refunded','order_voided','refund_completed','report_period_closed')".to_string(),
            ];
            if tables.contains("orders") {
                predicates.push("entityId IN (SELECT id FROM orders)".to_string());
            }
            if tables.contains("shifts") {
                predicates.push("entityId IN (SELECT id FROM shifts)".to_string());
            }
            sqlx::query(&format!(
                "DELETE FROM audit_logs WHERE {}",
                predicates.join(" OR ")
            ))
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("Could not remove sales audit history: {e}"))?;
        }
        if tables.contains("manager_approvals") {
            let mut predicates = vec![
                "entityType = 'order'".to_string(),
                "action = 'refund_void'".to_string(),
            ];
            if tables.contains("orders") {
                predicates.push("entityId IN (SELECT id FROM orders)".to_string());
            }
            sqlx::query(&format!(
                "DELETE FROM manager_approvals WHERE {}",
                predicates.join(" OR ")
            ))
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("Could not remove sales approvals: {e}"))?;
        }
        if tables.contains("loyalty_logs") {
            sqlx::query(
                "DELETE FROM loyalty_logs WHERE orderId IS NOT NULL AND TRIM(orderId) <> ''",
            )
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("Could not remove order-linked loyalty history: {e}"))?;
        }
        for table in [
            "payment_terminal_attempts",
            "payments",
            "order_lines",
            "cash_movements",
            "orders",
            "shifts",
            "daily_sales_summary",
            "till_report_markers",
        ] {
            if tables.contains(table) {
                sqlx::query(&format!("DELETE FROM {table}"))
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| format!("Could not clear {table} from setup backup: {e}"))?;
            }
        }
        if tables.contains("_offline_queue") {
            sqlx::query(
                "DELETE FROM _offline_queue
                 WHERE operation = 'saleBundle'
                    OR table_name IN ('registers','orders','order_lines','payments','shifts','cash_movements','inventory_logs','audit_logs','manager_approvals')",
            )
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("Could not remove queued sales from setup backup: {e}"))?;
        }
        if tables.contains("tombstones") {
            sqlx::query(
                "DELETE FROM tombstones
                 WHERE table_name IN ('registers','orders','order_lines','payments','shifts','cash_movements','inventory_logs','audit_logs','manager_approvals')",
            )
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("Could not remove sales deletion markers: {e}"))?;
        }
        Ok::<(), String>(())
    }
    .await;

    if let Err(error) = result {
        let _ = tx.rollback().await;
        pool.close().await;
        return Err(error);
    }
    tx.commit()
        .await
        .map_err(|e| format!("Could not finish automatic setup backup cleanup: {e}"))?;
    pool.close().await;
    Ok(())
}

async fn validate_automatic_setup_backup(target: &PathBuf) -> Result<(), String> {
    validate_backup_snapshot(target).await?;
    let uri = format!("sqlite://{}?mode=ro", target.display());
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&uri)
        .await
        .map_err(|e| format!("Could not verify the automatic setup backup: {e}"))?;
    let result = async {
        for table in [
            "registers",
            "orders",
            "order_lines",
            "payments",
            "payment_terminal_attempts",
            "shifts",
            "cash_movements",
            "daily_sales_summary",
            "till_report_markers",
            ONLINE_FINANCIAL_INTENT_TABLE,
        ] {
            if table_exists(&pool, "main", table).await? {
                let count = count_rows(&pool, &format!("SELECT COUNT(*) FROM {table}")).await?;
                if count != 0 {
                    return Err(format!(
                        "Automatic setup backup still contains {count} row(s) in {table}"
                    ));
                }
            }
        }
        if table_exists(&pool, "main", "_offline_queue").await? {
            let count = count_rows(
                &pool,
                "SELECT COUNT(*) FROM _offline_queue
                 WHERE operation = 'saleBundle'
                    OR table_name IN ('registers','orders','order_lines','payments','shifts','cash_movements','inventory_logs','audit_logs','manager_approvals')",
            )
            .await?;
            if count != 0 {
                return Err(format!(
                    "Automatic setup backup still contains {count} queued sales/register operation(s)"
                ));
            }
        }
        if table_exists(&pool, "main", "tombstones").await? {
            let count = count_rows(
                &pool,
                "SELECT COUNT(*) FROM tombstones
                 WHERE table_name IN ('registers','orders','order_lines','payments','shifts','cash_movements','inventory_logs','audit_logs','manager_approvals')",
            )
            .await?;
            if count != 0 {
                return Err(format!(
                    "Automatic setup backup still contains {count} sales/register deletion marker(s)"
                ));
            }
        }
        Ok(())
    }
    .await;
    pool.close().await;
    result
}

async fn pending_online_financial_intent_count(source: &PathBuf) -> Result<i64, String> {
    let uri = format!("sqlite://{}?mode=ro", source.display());
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&uri)
        .await
        .map_err(|error| format!("Could not inspect the local database before backup: {error}"))?;
    let result = async {
        if !table_exists(&pool, "main", ONLINE_FINANCIAL_INTENT_TABLE).await? {
            return Ok(0);
        }
        count_rows(
            &pool,
            &format!("SELECT COUNT(*) FROM {ONLINE_FINANCIAL_INTENT_TABLE}"),
        )
        .await
    }
    .await;
    pool.close().await;
    result
}

async fn create_automatic_setup_backup_in_dir(
    source: &PathBuf,
    backup_dir: &PathBuf,
    date: &str,
) -> Result<(PathBuf, bool), String> {
    let pending_intents = pending_online_financial_intent_count(source).await?;
    if pending_intents != 0 {
        return Err(format!(
            "{ONLINE_FINANCIAL_INTENT_PENDING_CODE}: automatic setup backup paused while {pending_intents} online financial transaction(s) still need recovery"
        ));
    }
    fs::create_dir_all(backup_dir).map_err(|e| e.to_string())?;
    let target = backup_dir.join(format!("shop-setup-backup-{date}.db"));
    if target.exists() {
        if target
            .metadata()
            .map(|metadata| metadata.len() > 0)
            .unwrap_or(false)
        {
            match validate_automatic_setup_backup(&target).await {
                Ok(()) => {
                    prune_automatic_setup_backups(backup_dir)?;
                    return Ok((target, false));
                }
                Err(error) => {
                    eprintln!(
                        "Existing automatic setup backup is invalid and will be replaced: {error}"
                    );
                }
            }
        }
        fs::remove_file(&target)
            .map_err(|e| format!("Could not replace an invalid automatic setup backup: {e}"))?;
    }

    if let Err(error) = create_sqlite_snapshot(source, &target).await {
        let _ = fs::remove_file(&target);
        return Err(error);
    }
    if let Err(error) = sanitize_automatic_setup_backup(&target).await {
        let _ = fs::remove_file(&target);
        return Err(error);
    }
    if let Err(error) = validate_automatic_setup_backup(&target).await {
        let _ = fs::remove_file(&target);
        return Err(error);
    }
    prune_automatic_setup_backups(backup_dir)?;
    Ok((target, true))
}

#[tauri::command]
pub async fn create_automatic_setup_backup(
    app: AppHandle,
    backup_directory: Option<String>,
) -> Result<AutomaticSetupBackupResult, String> {
    let source = local_db_path(&app)?;
    if !source.exists() {
        return Err("Local database does not exist yet".into());
    }
    let backup_dir = selected_till_backup_dir(&app, &source, backup_directory.as_deref()).await?;
    let date = chrono::Local::now().format("%Y%m%d").to_string();
    let (path, created) = create_automatic_setup_backup_in_dir(&source, &backup_dir, &date).await?;
    Ok(AutomaticSetupBackupResult {
        path: path.display().to_string(),
        created,
    })
}

#[tauri::command]
pub async fn latest_automatic_setup_backup(
    app: AppHandle,
    backup_directory: Option<String>,
) -> Result<Option<String>, String> {
    let source = local_db_path(&app)?;
    let backup_dir = selected_till_backup_dir(&app, &source, backup_directory.as_deref()).await?;
    let mut files = automatic_setup_backups_in_dir(&backup_dir)?;
    Ok(files.pop().map(|path| path.display().to_string()))
}

#[tauri::command]
pub async fn latest_local_backup(
    app: AppHandle,
    backup_directory: Option<String>,
) -> Result<Option<String>, String> {
    let source = local_db_path(&app)?;
    let backup_dir = selected_till_backup_dir(&app, &source, backup_directory.as_deref()).await?;
    latest_user_backup_in_dir(&backup_dir)
        .map(|backup| backup.map(|path| path.display().to_string()))
}

#[tauri::command]
pub async fn validate_local_database_backup(source_path: String) -> Result<(), String> {
    let source = restore_source_path(&source_path)?;
    validate_restore_source(&source).await
}

async fn validate_restore_database(source: &PathBuf) -> Result<(), String> {
    validate_restore_database_with_options(source, false).await
}

async fn validate_restore_source(source: &PathBuf) -> Result<(), String> {
    validate_restore_database_with_options(source, true).await
}

async fn validate_restore_database_with_options(
    source: &PathBuf,
    allow_repairable_transaction_orphans: bool,
) -> Result<(), String> {
    if !source.exists() {
        return Err("The selected database file does not exist".into());
    }
    if !source.is_file() {
        return Err("The selected path is not a database file".into());
    }

    let uri = format!("sqlite://{}?mode=ro", source.display());
    let pool = SqlitePool::connect(&uri)
        .await
        .map_err(|e| format!("Could not open the selected database: {e}"))?;
    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(&pool)
        .await
        .map_err(|e| format!("Could not check database integrity: {e}"))?;
    if integrity.to_lowercase() != "ok" {
        return Err(format!(
            "The selected database failed integrity check: {integrity}"
        ));
    }

    let required_tables = ["settings", "products"];
    for table in required_tables {
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .bind(table)
        .fetch_one(&pool)
        .await
        .map_err(|e| format!("Could not inspect database tables: {e}"))?;
        if count == 0 {
            return Err(format!(
                "The selected database does not look like an L&Bj POS database. Missing table: {table}"
            ));
        }
    }

    validate_restore_schema(&pool).await?;
    validate_restore_data(&pool, allow_repairable_transaction_orphans).await?;

    pool.close().await;
    Ok(())
}

async fn validate_restore_schema(pool: &SqlitePool) -> Result<(), String> {
    let required_columns = [
        ("settings", vec!["key", "value"]),
        ("products", vec!["id", "name", "price", "costPrice"]),
        ("categories", vec!["id", "name"]),
        ("customers", vec!["id", "name"]),
        ("orders", vec!["id", "receiptKey", "total"]),
        (
            "order_lines",
            vec!["id", "orderId", "productId", "lineTotal"],
        ),
        ("payments", vec!["id", "orderId", "amount"]),
    ];

    for (table, columns) in required_columns {
        if !table_exists(pool, "main", table).await? {
            // Older backups may not contain every optional table, but the core
            // tables above must have the columns they advertise when present.
            continue;
        }
        let actual: std::collections::HashSet<_> = table_columns(pool, "main", table)
            .await?
            .into_iter()
            .collect();
        for column in columns {
            if !actual.contains(column) {
                return Err(format!(
                    "The selected database is missing required column {table}.{column}"
                ));
            }
        }
    }

    // These fields contain safety-critical values which cannot be reconstructed
    // by a later migration. Silently accepting an older backup would reset age
    // restrictions and/or customer balances to defaults.
    let critical_compatibility_columns = [
        ("products", vec!["isAgeRestricted"]),
        (
            "customer_accounts",
            vec![
                "id",
                "customerId",
                "isEnabled",
                "creditLimitPence",
                "balancePence",
                "createdAt",
                "updatedAt",
            ],
        ),
        (
            "customer_account_entries",
            vec![
                "id",
                "accountId",
                "customerId",
                "orderId",
                "entryType",
                "amountPence",
                "idempotencyKey",
                "balanceAfterPence",
                "createdAt",
                "updatedAt",
            ],
        ),
    ];
    for (table, columns) in critical_compatibility_columns {
        if !table_exists(pool, "main", table).await? {
            return Err(format!(
                "BACKUP_COMPATIBILITY_WARNING: This backup is from an older app and is missing {table}. Restoring it could erase age-restriction or customer-account values. Upgrade the app that created the backup, open it once to migrate the database, then create a new backup."
            ));
        }
        let actual: std::collections::HashSet<_> = table_columns(pool, "main", table)
            .await?
            .into_iter()
            .collect();
        let mut missing: Vec<_> = columns
            .into_iter()
            .filter(|column| !actual.contains(*column))
            .collect();
        // Match the startup migration's fail-closed rule: an empty legacy
        // ledger can safely gain paymentMethod with its default, but existing
        // financial entries must never have that field invented during restore.
        if table == "customer_account_entries" && !actual.contains("paymentMethod") {
            let entry_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM customer_account_entries")
                    .fetch_one(pool)
                    .await
                    .map_err(|e| format!("Could not inspect customer account ledger rows: {e}"))?;
            if entry_count > 0 {
                missing.push("paymentMethod");
            }
        }
        if !missing.is_empty() {
            return Err(format!(
                "BACKUP_COMPATIBILITY_WARNING: This backup is from an older app and is missing {}. Restoring it could erase age-restriction or customer-account values. Upgrade the app that created the backup, open it once to migrate the database, then create a new backup.",
                missing
                    .into_iter()
                    .map(|column| format!("{table}.{column}"))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
    }
    Ok(())
}

async fn count_rows(pool: &SqlitePool, sql: &str) -> Result<i64, String> {
    sqlx::query_scalar(sql)
        .fetch_one(pool)
        .await
        .map_err(|e| format!("Could not validate restore data: {e}"))
}

async fn restore_example_rows(pool: &SqlitePool, sql: &str) -> Result<String, String> {
    let rows = sqlx::query(sql)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("Could not read restore validation examples: {e}"))?;
    let examples: Vec<String> = rows
        .into_iter()
        .filter_map(|row| {
            let id = row.try_get::<String, _>("id").ok()?;
            let name = row.try_get::<String, _>("name").unwrap_or_default();
            Some(format!("{name} ({id})"))
        })
        .collect();
    Ok(examples.join(", "))
}

async fn add_issue_for_count(
    pool: &SqlitePool,
    issues: &mut Vec<String>,
    label: &str,
    count_sql: &str,
    example_sql: Option<&str>,
) -> Result<(), String> {
    let count = count_rows(pool, count_sql).await?;
    if count == 0 {
        return Ok(());
    }
    let examples = match example_sql {
        Some(sql) => restore_example_rows(pool, sql).await?,
        None => String::new(),
    };
    if examples.is_empty() {
        issues.push(format!("{label}: {count} row(s)"));
    } else {
        issues.push(format!("{label}: {count} row(s). Examples: {examples}"));
    }
    Ok(())
}

async fn validate_restore_data(
    pool: &SqlitePool,
    allow_repairable_transaction_orphans: bool,
) -> Result<(), String> {
    let mut issues = Vec::new();

    if table_exists(pool, "main", ONLINE_FINANCIAL_INTENT_TABLE).await? {
        add_issue_for_count(
            pool,
            &mut issues,
            "Unresolved online financial intents",
            &format!("SELECT COUNT(*) FROM {ONLINE_FINANCIAL_INTENT_TABLE}"),
            None,
        )
        .await?;
    }

    add_issue_for_count(
        pool,
        &mut issues,
        "Products with missing id/name",
        "SELECT COUNT(*) FROM products WHERE id IS NULL OR TRIM(id) = '' OR name IS NULL OR TRIM(name) = ''",
        Some("SELECT id, name FROM products WHERE id IS NULL OR TRIM(id) = '' OR name IS NULL OR TRIM(name) = '' LIMIT 5"),
    )
    .await?;
    add_issue_for_count(
        pool,
        &mut issues,
        "Products with impossible prices",
        "SELECT COUNT(*) FROM products WHERE price IS NULL OR price < 0 OR COALESCE(costPrice, 0) < 0 OR price > 1000000 OR COALESCE(costPrice, 0) > 1000000",
        Some("SELECT id, name FROM products WHERE price IS NULL OR price < 0 OR COALESCE(costPrice, 0) < 0 OR price > 1000000 OR COALESCE(costPrice, 0) > 1000000 LIMIT 5"),
    )
    .await?;

    if table_exists(pool, "main", "customer_account_entries").await?
        && table_columns(pool, "main", "customer_account_entries")
            .await?
            .iter()
            .any(|column| column == "paymentMethod")
    {
        add_issue_for_count(
            pool,
            &mut issues,
            "Customer account payments with missing payment method",
            "SELECT COUNT(*) FROM customer_account_entries
             WHERE entryType = 'payment'
               AND TRIM(COALESCE(paymentMethod, '')) = ''",
            None,
        )
        .await?;
    }

    for column in ["barcode", "sku", "scalePlu"] {
        if !table_columns(pool, "main", "products")
            .await?
            .iter()
            .any(|name| name == column)
        {
            continue;
        }
        let duplicate_sql = format!(
            "SELECT COUNT(*) FROM (
                SELECT {column} FROM products
                WHERE {column} IS NOT NULL AND TRIM({column}) <> ''
                GROUP BY {column} HAVING COUNT(*) > 1
             )"
        );
        add_issue_for_count(
            pool,
            &mut issues,
            &format!("Duplicate product {column} values"),
            &duplicate_sql,
            None,
        )
        .await?;
    }

    let orphan_checks = [
        (
            "POS tiles pointing to missing products",
            vec!["pos_tiles", "products"],
            "SELECT COUNT(*) FROM pos_tiles t LEFT JOIN products p ON p.id = t.productId WHERE p.id IS NULL",
            false,
        ),
        (
            "POS tiles pointing to missing pages",
            vec!["pos_tiles", "pos_pages"],
            "SELECT COUNT(*) FROM pos_tiles t LEFT JOIN pos_pages p ON p.id = t.pageId WHERE p.id IS NULL",
            false,
        ),
        (
            "Promotion items pointing to missing products",
            vec!["promo_group_items", "products"],
            "SELECT COUNT(*) FROM promo_group_items i LEFT JOIN products p ON p.id = i.productId WHERE p.id IS NULL",
            false,
        ),
        (
            "Promotion items pointing to missing groups",
            vec!["promo_group_items", "promo_groups"],
            "SELECT COUNT(*) FROM promo_group_items i LEFT JOIN promo_groups g ON g.id = i.groupId WHERE g.id IS NULL",
            false,
        ),
        (
            "Order lines pointing to missing orders",
            vec!["order_lines", "orders"],
            "SELECT COUNT(*) FROM order_lines l LEFT JOIN orders o ON o.id = l.orderId WHERE o.id IS NULL",
            true,
        ),
        (
            "Payments pointing to missing orders",
            vec!["payments", "orders"],
            "SELECT COUNT(*) FROM payments p LEFT JOIN orders o ON o.id = p.orderId WHERE o.id IS NULL",
            true,
        ),
    ];
    for (label, tables, sql, repairable) in orphan_checks {
        if repairable && allow_repairable_transaction_orphans {
            continue;
        }
        let mut has_all_tables = true;
        for table in tables {
            if !table_exists(pool, "main", table).await? {
                has_all_tables = false;
                break;
            }
        }
        if has_all_tables {
            add_issue_for_count(pool, &mut issues, label, sql, None).await?;
        }
    }

    if !issues.is_empty() {
        return Err(format!(
            "Restore stopped before changing data. The selected database has unsafe data: {}",
            issues.join(" | ")
        ));
    }
    Ok(())
}

async fn repair_restore_pool(pool: &SqlitePool) -> Result<(), String> {
    for (child_table, parent_table, foreign_key) in [
        ("order_lines", "orders", "orderId"),
        ("payments", "orders", "orderId"),
    ] {
        if !table_exists(pool, "main", child_table).await?
            || !table_exists(pool, "main", parent_table).await?
        {
            continue;
        }
        let query = format!(
            "DELETE FROM {child_table}
             WHERE {foreign_key} IS NULL
                OR TRIM({foreign_key}) = ''
                OR NOT EXISTS (
                    SELECT 1 FROM {parent_table}
                    WHERE {parent_table}.id = {child_table}.{foreign_key}
                )"
        );
        sqlx::query(&query).execute(pool).await.map_err(|e| {
            format!("Could not remove repairable orphan rows from {child_table}: {e}")
        })?;
    }
    Ok(())
}

async fn repair_restore_database(source: &PathBuf) -> Result<(), String> {
    let uri = format!("sqlite://{}?mode=rw", source.display());
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&uri)
        .await
        .map_err(|e| format!("Could not open the prepared restore database: {e}"))?;
    let result = repair_restore_pool(&pool).await;
    pool.close().await;
    result
}

fn retry_file_operation<T, F>(mut operation: F) -> Result<T, std::io::Error>
where
    F: FnMut() -> Result<T, std::io::Error>,
{
    let mut last_error = None;
    for _ in 0..8 {
        match operation() {
            Ok(value) => return Ok(value),
            Err(error) => {
                last_error = Some(error);
                thread::sleep(Duration::from_millis(150));
            }
        }
    }
    Err(last_error.expect("retry_file_operation should always run at least once"))
}

fn rollback_replaced_database(
    target: &PathBuf,
    safety_backup: Option<&PathBuf>,
) -> Result<(), String> {
    if target.exists() {
        retry_file_operation(|| fs::remove_file(target))
            .map_err(|e| format!("Could not remove the failed restored database: {e}"))?;
    }
    if let Some(backup) = safety_backup {
        if !backup.exists() {
            return Err(format!(
                "The pre-restore safety backup is missing: {}",
                backup.display()
            ));
        }
        retry_file_operation(|| fs::copy(backup, target))
            .map_err(|e| format!("Could not put the original database back: {e}"))?;
    }
    Ok(())
}

fn quote_sqlite_text(value: &str) -> String {
    value.replace('\'', "''")
}

const PRESERVED_LOCAL_SETTING_FILTER: &str = "key IN (
        'pos_mode', 'mysql_config', 'device_operating_mode',
        'till_id', 'till_name', 'till_name_manual', 'till_seq',
        'receipt_number_high_water', 'automatic_setup_backup_enabled',
        'automatic_setup_backup_time', 'automatic_setup_backup_directory', 'backup_directory',
        'last_sync_time', 'last_fast_sync_time', 'bootstrap_uploaded',
        'transaction_purge_applied_at', 'sync_change_cursor', 'training_mode_enabled',
        'owner_cloud_reporter_password', 'server_data_epoch_seen'
     )
     OR key LIKE 'sync_ts_%'
     OR key LIKE 'receipt_printer_%'
     OR key LIKE 'label_printer_%'
     OR key LIKE 'cash_drawer_%'
     OR key LIKE 'scale_hardware_%'
     OR key LIKE 'cctv_pos_%'
     OR key LIKE 'feedback_%'
     OR key = 'barcode_error_sound'";

#[derive(Debug, Default)]
struct RestoreShopContext {
    pos_mode: Option<String>,
    shop_id: Option<String>,
}

async fn inspect_restore_shop_context(path: &PathBuf) -> Result<RestoreShopContext, String> {
    let uri = format!("sqlite://{}?mode=ro", path.display());
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&uri)
        .await
        .map_err(|e| format!("Could not inspect restore shop identity: {e}"))?;
    let result = async {
        let pos_mode = if table_exists(&pool, "main", "settings").await? {
            sqlx::query_scalar("SELECT value FROM settings WHERE key = 'pos_mode' LIMIT 1")
                .fetch_optional(&pool)
                .await
                .map_err(|e| format!("Could not read restore POS mode: {e}"))?
        } else {
            None
        };
        let shop_id = if table_exists(&pool, "main", "app_identity").await?
            && table_columns(&pool, "main", "app_identity")
                .await?
                .iter()
                .any(|column| column == "shopId")
        {
            sqlx::query_scalar(
                "SELECT shopId FROM app_identity
                 WHERE id = 'main' AND TRIM(COALESCE(shopId, '')) <> '' LIMIT 1",
            )
            .fetch_optional(&pool)
            .await
            .map_err(|e| format!("Could not read restore shop identity: {e}"))?
        } else {
            None
        };
        Ok::<RestoreShopContext, String>(RestoreShopContext { pos_mode, shop_id })
    }
    .await;
    pool.close().await;
    result
}

fn validate_restore_shop_identity_values(
    current_mode: Option<&str>,
    source_shop_id: Option<&str>,
    current_shop_id: Option<&str>,
) -> Result<(), String> {
    if current_mode.map(str::trim) != Some("multi") {
        return Ok(());
    }
    let source = source_shop_id
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let current = current_shop_id
        .map(str::trim)
        .filter(|value| !value.is_empty());
    match (source, current) {
        (Some(source), Some(current)) if source == current => Ok(()),
        (Some(_), Some(_)) => Err(
            "DATABASE_IDENTITY_MISMATCH: Restore blocked before changing data because the selected backup belongs to a different shop than this till's MariaDB database."
                .into(),
        ),
        _ => Err(
            "DATABASE_IDENTITY_UNVERIFIED: Restore blocked before changing data because the selected backup and this multi-till installation do not both contain a verifiable shop identity. Open the old database in the current app and create a new backup first."
                .into(),
        ),
    }
}

async fn validate_restore_shop_identity_paths(
    source: &PathBuf,
    current: Option<&PathBuf>,
) -> Result<(), String> {
    let Some(current) = current.filter(|path| path.exists()) else {
        return Ok(());
    };
    let current_context = inspect_restore_shop_context(current).await?;
    if current_context.pos_mode.as_deref().map(str::trim) != Some("multi") {
        return Ok(());
    }
    let source_context = inspect_restore_shop_context(source).await?;
    validate_restore_shop_identity_values(
        current_context.pos_mode.as_deref(),
        source_context.shop_id.as_deref(),
        current_context.shop_id.as_deref(),
    )
}

async fn table_exists(pool: &SqlitePool, schema: &str, table: &str) -> Result<bool, String> {
    let query =
        format!("SELECT COUNT(*) FROM {schema}.sqlite_master WHERE type = 'table' AND name = ?");
    let count: i64 = sqlx::query_scalar(&query)
        .bind(table)
        .fetch_one(pool)
        .await
        .map_err(|e| format!("Could not inspect {schema}.{table}: {e}"))?;
    Ok(count > 0)
}

async fn table_columns(
    pool: &SqlitePool,
    schema: &str,
    table: &str,
) -> Result<Vec<String>, String> {
    let query = format!("PRAGMA {schema}.table_info({table})");
    let rows = sqlx::query(&query)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("Could not inspect {schema}.{table} columns: {e}"))?;
    Ok(rows
        .into_iter()
        .filter_map(|row| row.try_get::<String, _>("name").ok())
        .collect())
}

async fn copy_preserved_table(
    pool: &SqlitePool,
    table: &str,
    where_clause: Option<&str>,
) -> Result<(), String> {
    if !table_exists(pool, "main", table).await? || !table_exists(pool, "preserved", table).await? {
        return Ok(());
    }

    let target_columns = table_columns(pool, "main", table).await?;
    let source_columns = table_columns(pool, "preserved", table).await?;
    let source_set: std::collections::HashSet<_> = source_columns.iter().cloned().collect();
    let columns: Vec<String> = target_columns
        .into_iter()
        .filter(|column| source_set.contains(column))
        .collect();
    if columns.is_empty() {
        return Ok(());
    }

    let column_list = columns.join(", ");
    let delete_query = match where_clause {
        Some(clause) => format!("DELETE FROM main.{table} WHERE {clause}"),
        None => format!("DELETE FROM main.{table}"),
    };
    sqlx::query(&delete_query)
        .execute(pool)
        .await
        .map_err(|e| format!("Could not clear preserved {table}: {e}"))?;

    let insert_query = match where_clause {
        Some(clause) => format!(
            "INSERT INTO main.{table} ({column_list}) SELECT {column_list} FROM preserved.{table} WHERE {clause}"
        ),
        None => format!(
            "INSERT INTO main.{table} ({column_list}) SELECT {column_list} FROM preserved.{table}"
        ),
    };
    sqlx::query(&insert_query)
        .execute(pool)
        .await
        .map_err(|e| format!("Could not copy preserved {table}: {e}"))?;
    Ok(())
}

async fn ensure_restore_compatibility_schema(pool: &SqlitePool) -> Result<(), String> {
    if table_exists(pool, "main", "settings").await?
        && !table_columns(pool, "main", "settings")
            .await?
            .iter()
            .any(|column| column == "updatedAt")
    {
        sqlx::query("ALTER TABLE settings ADD COLUMN updatedAt TEXT")
            .execute(pool)
            .await
            .map_err(|e| format!("Could not migrate restored settings metadata: {e}"))?;
    }
    Ok(())
}

async fn restore_preserved_local_setup(
    target: &PathBuf,
    preserve_from: Option<&str>,
) -> Result<(), String> {
    let target_uri = format!("sqlite://{}", target.display());
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&target_uri)
        .await
        .map_err(|e| format!("Could not reopen restored database to preserve settings: {e}"))?;
    ensure_restore_compatibility_schema(&pool).await?;
    let backup_mode: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key = 'pos_mode' LIMIT 1")
            .fetch_optional(&pool)
            .await
            .map_err(|e| format!("Could not read backup POS mode: {e}"))?;
    let preserve_path = preserve_from
        .map(PathBuf::from)
        .filter(|path| path.exists());
    if let Some(path) = &preserve_path {
        let attach = format!(
            "ATTACH DATABASE '{}' AS preserved",
            quote_sqlite_text(&path.display().to_string())
        );
        sqlx::query(&attach)
            .execute(&pool)
            .await
            .map_err(|e| format!("Could not read safety backup to preserve settings: {e}"))?;

        // A full backup owns business settings, staff, and shop identity. Only
        // settings tied to this physical till are copied from the current DB.
        copy_preserved_table(&pool, "settings", Some(PRESERVED_LOCAL_SETTING_FILTER)).await?;
    } else {
        // A first-machine restore has no target hardware to preserve. Remove
        // source till identity and printer/scale targets so another machine
        // never inherits COM ports, USB queues, IPs, or installed-module IDs.
        sqlx::query(&format!(
            "DELETE FROM settings WHERE {PRESERVED_LOCAL_SETTING_FILTER}"
        ))
        .execute(&pool)
        .await
        .map_err(|e| format!("Could not remove the source till identity: {e}"))?;

        // Retain whether this was a single- or multi-till shop, but never copy
        // MariaDB credentials to a new machine. A multi-till backup receives
        // the explicit replacement marker below and Setup asks for connection
        // details before any remote mutation.
        if matches!(backup_mode.as_deref(), Some("single" | "multi")) {
            sqlx::query(
                "INSERT INTO settings (key, value, updatedAt)
                 VALUES ('pos_mode', ?, ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt",
            )
            .bind(backup_mode.as_deref().unwrap_or_default())
            .bind(chrono::Utc::now().to_rfc3339())
            .execute(&pool)
            .await
            .map_err(|e| format!("Could not retain the restored POS mode: {e}"))?;
        }
    }

    // Never adopt register rows from the backup. When a target identity was
    // preserved above, rebuild exactly that till; otherwise leave the table
    // empty so normal startup can create a fresh machine identity.
    if table_exists(&pool, "main", "registers").await? {
        let till_id: Option<String> =
            sqlx::query_scalar("SELECT value FROM settings WHERE key = 'till_id' LIMIT 1")
                .fetch_optional(&pool)
                .await
                .map_err(|e| format!("Could not read the target till identity: {e}"))?;
        let till_name: Option<String> =
            sqlx::query_scalar("SELECT value FROM settings WHERE key = 'till_name' LIMIT 1")
                .fetch_optional(&pool)
                .await
                .map_err(|e| format!("Could not read the target till name: {e}"))?;

        sqlx::query("DELETE FROM registers")
            .execute(&pool)
            .await
            .map_err(|e| format!("Could not clear restored till identities: {e}"))?;

        if let Some(till_id) = till_id.filter(|value| !value.trim().is_empty()) {
            let name = till_name
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "Till 1".to_string());
            sqlx::query("INSERT INTO registers (id, name) VALUES (?, ?)")
                .bind(till_id.trim())
                .bind(name.trim())
                .execute(&pool)
                .await
                .map_err(|e| format!("Could not restore this till's register identity: {e}"))?;

            let columns: std::collections::HashSet<_> = table_columns(&pool, "main", "registers")
                .await?
                .into_iter()
                .collect();
            if columns.contains("storeId") {
                sqlx::query("UPDATE registers SET storeId = 'store-main' WHERE id = ?")
                    .bind(till_id.trim())
                    .execute(&pool)
                    .await
                    .map_err(|e| format!("Could not restore the till's store identity: {e}"))?;
            }
            if columns.contains("isActive") {
                sqlx::query("UPDATE registers SET isActive = 1 WHERE id = ?")
                    .bind(till_id.trim())
                    .execute(&pool)
                    .await
                    .map_err(|e| format!("Could not activate the restored till: {e}"))?;
            }
            let stamp = chrono::Utc::now().to_rfc3339();
            if columns.contains("createdAt") {
                sqlx::query("UPDATE registers SET createdAt = ? WHERE id = ?")
                    .bind(&stamp)
                    .bind(till_id.trim())
                    .execute(&pool)
                    .await
                    .map_err(|e| format!("Could not timestamp the restored till: {e}"))?;
            }
            if columns.contains("updatedAt") {
                sqlx::query("UPDATE registers SET updatedAt = ? WHERE id = ?")
                    .bind(&stamp)
                    .bind(till_id.trim())
                    .execute(&pool)
                    .await
                    .map_err(|e| format!("Could not timestamp the restored till: {e}"))?;
            }
        }
    }
    if table_exists(&pool, "main", "_offline_queue").await? {
        sqlx::query("DELETE FROM _offline_queue WHERE table_name = 'registers'")
            .execute(&pool)
            .await
            .map_err(|e| format!("Could not clear restored register sync work: {e}"))?;
    }
    if table_exists(&pool, "main", "tombstones").await? {
        sqlx::query("DELETE FROM tombstones WHERE table_name = 'registers'")
            .execute(&pool)
            .await
            .map_err(|e| format!("Could not clear restored register deletion markers: {e}"))?;
    }

    sqlx::query(
        "DELETE FROM settings
         WHERE key LIKE 'sync_ts_%'
            OR key IN ('last_sync_time', 'last_fast_sync_time', 'bootstrap_uploaded', 'transaction_purge_applied_at')",
    )
    .execute(&pool)
    .await
    .map_err(|e| format!("Could not clear old sync markers after restore: {e}"))?;

    let restored_mode: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key = 'pos_mode' LIMIT 1")
            .fetch_optional(&pool)
            .await
            .map_err(|e| format!("Could not read restored POS mode: {e}"))?;

    if restored_mode.as_deref() == Some("multi") {
        sqlx::query(
            "INSERT INTO settings (key, value, updatedAt)
             VALUES ('restore_pending_mariadb_replace', '1', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt",
        )
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(&pool)
        .await
        .map_err(|e| format!("Could not mark restore for MariaDB replacement: {e}"))?;
    } else {
        sqlx::query("DELETE FROM settings WHERE key = 'restore_pending_mariadb_replace'")
            .execute(&pool)
            .await
            .map_err(|e| format!("Could not clear MariaDB restore marker: {e}"))?;
    }

    if preserve_path.is_some() {
        let _ = sqlx::query("DETACH DATABASE preserved")
            .execute(&pool)
            .await;
    }
    pool.close().await;
    Ok(())
}

fn schedule_pending_restore(
    app: &AppHandle,
    staging_path: &PathBuf,
    preserve_from: Option<&str>,
) -> Result<(), String> {
    let marker = pending_restore_marker_path(app)?;
    let payload = PendingRestoreMarker {
        source: staging_path.display().to_string(),
        preserve_from: preserve_from.map(str::to_string),
    };
    let text = serde_json::to_string(&payload)
        .map_err(|e| format!("Could not prepare pending restore marker: {e}"))?;
    fs::write(&marker, text).map_err(|e| format!("Could not schedule restore for restart: {e}"))?;
    Ok(())
}

pub fn apply_pending_restore_on_startup(app: &AppHandle) -> Result<(), String> {
    let marker = pending_restore_marker_path(app)?;
    if !marker.exists() {
        return Ok(());
    }

    let source_text = fs::read_to_string(&marker)
        .map_err(|e| format!("Could not read pending restore marker: {e}"))?;
    let pending = serde_json::from_str::<PendingRestoreMarker>(&source_text).unwrap_or(
        PendingRestoreMarker {
            source: source_text.trim().to_string(),
            preserve_from: None,
        },
    );
    let source = PathBuf::from(pending.source.trim());
    if !source.exists() {
        let _ = fs::remove_file(&marker);
        return Err("Pending restore file is missing. Restore was cancelled.".into());
    }

    let target = local_db_path(app)?;
    let preserved_identity_path = pending
        .preserve_from
        .as_ref()
        .map(PathBuf::from)
        .filter(|path| path.exists());
    let current_identity_path = if target.exists() {
        Some(&target)
    } else {
        preserved_identity_path.as_ref()
    };
    tauri::async_runtime::block_on(validate_restore_shop_identity_paths(
        &source,
        current_identity_path,
    ))?;
    tauri::async_runtime::block_on(repair_restore_database(&source))?;
    tauri::async_runtime::block_on(validate_restore_database(&source))?;
    let backup_dir = local_backup_dir(app)?;
    let backup_path = backup_dir.join(format!(
        "pre-startup-restore-backup-{}.db",
        chrono::Utc::now().format("%Y%m%d-%H%M%S")
    ));
    let had_target = target.exists();

    if had_target {
        fs::copy(&target, &backup_path)
            .map_err(|e| format!("Could not create startup safety backup before restore: {e}"))?;
        fs::remove_file(&target)
            .map_err(|e| format!("Could not replace local database during startup: {e}"))?;
    }

    // Keep the prepared source and marker until every post-swap migration and
    // machine-setting step succeeds, so a failed startup restore is retryable.
    fs::copy(&source, &target)
        .map(|_| ())
        .map_err(|e| format!("Could not finish pending restore during startup: {e}"))?;
    let fallback_preserve = had_target.then(|| backup_path.display().to_string());
    let preserve_from = pending
        .preserve_from
        .as_deref()
        .or(fallback_preserve.as_deref());
    if let Err(error) =
        tauri::async_runtime::block_on(restore_preserved_local_setup(&target, preserve_from))
    {
        let rollback = rollback_replaced_database(&target, had_target.then_some(&backup_path));
        return match rollback {
            Ok(()) => Err(format!(
                "Pending restore failed after the database swap and the original database was restored automatically: {error}"
            )),
            Err(rollback_error) => Err(format!(
                "Pending restore failed after the database swap: {error}. Automatic rollback also failed: {rollback_error}"
            )),
        };
    }
    let _ = fs::remove_file(&source);
    let _ = fs::remove_file(&marker);
    Ok(())
}

async fn restore_local_database_from_path_impl(
    app: AppHandle,
    source: PathBuf,
) -> Result<RestoreDatabaseResult, String> {
    validate_restore_source(&source).await?;

    let target = local_db_path(&app)?;
    if source.canonicalize().ok() == target.canonicalize().ok() {
        return Err("The selected file is already the live till database".into());
    }
    validate_restore_shop_identity_paths(&source, Some(&target)).await?;

    let backup_dir = local_backup_dir(&app)?;
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    let staging_path = backup_dir.join(format!("restore-staging-{stamp}.db"));
    fs::copy(&source, &staging_path).map_err(|e| {
        format!(
            "Restore stopped before changing data: could not prepare the selected database: {e}"
        )
    })?;
    if let Err(error) = repair_restore_database(&staging_path).await {
        let _ = fs::remove_file(&staging_path);
        return Err(format!(
            "Restore stopped before changing data: could not repair the prepared database: {error}"
        ));
    }
    if let Err(error) = validate_restore_database(&staging_path).await {
        let _ = fs::remove_file(&staging_path);
        return Err(format!(
            "Restore stopped before changing data: the prepared database failed safety check: {error}"
        ));
    }

    let safety_backup = if target.exists() {
        let target_path = backup_dir.join(format!("pre-restore-pos-backup-{stamp}.db"));
        retry_file_operation(|| fs::copy(&target, &target_path))
            .map_err(|e| format!("Could not create safety backup before restore: {e}"))?;
        Some(target_path.display().to_string())
    } else {
        None
    };

    if target.exists() {
        if retry_file_operation(|| fs::remove_file(&target)).is_err() {
            schedule_pending_restore(&app, &staging_path, safety_backup.as_deref())?;
            return Ok(RestoreDatabaseResult {
                restored_from: source.display().to_string(),
                replaced_database: target.display().to_string(),
                safety_backup,
                restart_required: true,
            });
        }
    }

    if retry_file_operation(|| fs::rename(&staging_path, &target)).is_err() {
        if let Some(backup) = &safety_backup {
            let _ = fs::copy(backup, &target);
        }
        schedule_pending_restore(&app, &staging_path, safety_backup.as_deref())?;
        return Ok(RestoreDatabaseResult {
            restored_from: source.display().to_string(),
            replaced_database: target.display().to_string(),
            safety_backup,
            restart_required: true,
        });
    }

    if let Err(error) = restore_preserved_local_setup(&target, safety_backup.as_deref()).await {
        let backup_path = safety_backup.as_ref().map(PathBuf::from);
        let rollback = rollback_replaced_database(&target, backup_path.as_ref());
        return match rollback {
            Ok(()) => Err(format!(
                "Restore failed after the database swap and the original database was restored automatically: {error}"
            )),
            Err(rollback_error) => Err(format!(
                "Restore failed after the database swap: {error}. Automatic rollback also failed: {rollback_error}"
            )),
        };
    }

    Ok(RestoreDatabaseResult {
        restored_from: source.display().to_string(),
        replaced_database: target.display().to_string(),
        safety_backup,
        restart_required: false,
    })
}

#[tauri::command]
pub async fn restore_latest_local_backup(
    app: AppHandle,
    backup_directory: Option<String>,
) -> Result<RestoreDatabaseResult, String> {
    let backup = latest_local_backup(app.clone(), backup_directory)
        .await?
        .ok_or_else(|| "No local backup is available".to_string())?;
    restore_local_database_from_path_impl(app, PathBuf::from(backup)).await
}

#[tauri::command]
pub async fn restore_local_database_from_path(
    app: AppHandle,
    source_path: String,
) -> Result<RestoreDatabaseResult, String> {
    let source = restore_source_path(&source_path)?;
    restore_local_database_from_path_impl(app, source).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    fn customer_profile_test_snapshot(phone: &str, notes: &str) -> serde_json::Value {
        serde_json::json!({
            "id": "customer-1", "name": "Customer", "phone": phone,
            "email": "", "postcode": "SW1A 1AA", "loyaltyCode": "MEMBER-1",
            "notes": notes, "loyaltyPoints": 150, "updatedAt": "old timestamp",
        })
    }

    #[test]
    fn customer_profile_cas_rejects_stale_edits_and_accepts_exact_retries() {
        let original = customer_profile_test_snapshot("111", "Original");
        let first_till = customer_profile_test_snapshot("222", "Original");
        let second_till = customer_profile_test_snapshot("111", "New notes");
        assert_eq!(customer_profile_sync_decision(Some(&original), &first_till, Some(&original)).unwrap(), CustomerProfileSyncDecision::Apply);
        let error = customer_profile_sync_decision(Some(&first_till), &second_till, Some(&original)).unwrap_err().to_string();
        assert!(error.contains("CUSTOMER_PROFILE_CONFLICT"));
        assert_eq!(customer_profile_sync_decision(Some(&first_till), &first_till, Some(&original)).unwrap(), CustomerProfileSyncDecision::AlreadyApplied);
        assert!(customer_profile_sync_decision(Some(&second_till), &first_till, Some(&original)).is_err(), "Retry must not overwrite a later different profile");
    }

    #[test]
    fn customer_profile_cas_ignores_balance_and_timestamp_but_detects_deletion() {
        let original = customer_profile_test_snapshot("111", "Original");
        let mut earned_points = original.clone();
        earned_points["loyaltyPoints"] = serde_json::json!(300);
        earned_points["updatedAt"] = serde_json::json!("new server timestamp");
        earned_points["email"] = serde_json::Value::Null;
        let desired = customer_profile_test_snapshot("111", "New notes");
        assert_eq!(customer_profile_sync_decision(Some(&earned_points), &desired, Some(&original)).unwrap(), CustomerProfileSyncDecision::Apply);
        assert!(customer_profile_sync_decision(None, &desired, Some(&original)).is_err());
        assert!(customer_profile_sync_decision(Some(&original), &desired, Some(&serde_json::Value::Null)).is_err());
        assert_eq!(customer_profile_sync_decision(None, &desired, Some(&serde_json::Value::Null)).unwrap(), CustomerProfileSyncDecision::Apply);
    }

    #[test]
    fn customer_profile_legacy_sync_cannot_overwrite_profiles_or_balances() {
        let current = customer_profile_test_snapshot("222", "Original");
        let stale = customer_profile_test_snapshot("111", "Original");
        assert!(customer_profile_sync_decision(Some(&current), &stale, None).is_err());
        // Returning AlreadyApplied exits before building any SQL update, even
        // if a legacy full-row payload includes an obsolete loyalty balance.
        let stale_points_only = serde_json::json!({"id": "customer-1", "loyaltyPoints": 0});
        assert_eq!(customer_profile_sync_decision(Some(&current), &stale_points_only, None).unwrap(), CustomerProfileSyncDecision::AlreadyApplied);
        assert_eq!(customer_profile_sync_decision(Some(&current), &current, None).unwrap(), CustomerProfileSyncDecision::AlreadyApplied);
        assert!(customer_profile_sync_decision(None, &stale, None).is_err(), "Do not silently discard legacy points when the customer is missing");
        let mut legacy_create = stale;
        legacy_create["loyaltyPoints"] = serde_json::json!(0);
        assert_eq!(customer_profile_sync_decision(None, &legacy_create, None).unwrap(), CustomerProfileSyncDecision::Apply);
    }

    #[test]
    fn customer_profile_payload_requires_a_complete_base_and_discards_financial_fields() {
        let customer = customer_profile_test_snapshot("111", "Original");
        let mut payload = serde_json::json!({"id": "customer-1", "customer": customer, "before": null});
        let (profile, _) = customer_profile_operation_data(&payload).unwrap();
        assert!(profile.get("loyaltyPoints").is_none());
        assert!(profile.get("updatedAt").is_none());
        payload.as_object_mut().unwrap().remove("before");
        assert!(customer_profile_operation_data(&payload).is_err());
        payload["before"] = serde_json::json!({"phone": "111"});
        assert!(customer_profile_operation_data(&payload).is_err());
        payload["before"] = customer;
        payload["before"]["id"] = serde_json::json!("other-customer");
        assert!(customer_profile_operation_data(&payload).is_err());
    }

    fn promotion_test_snapshot(price: i64, stamp: &str) -> serde_json::Value {
        serde_json::json!({
            "group": {"id": "g", "name": "Offer", "isActive": true, "updatedAt": stamp},
            "discounts": [{"id": "d", "groupId": "g", "kind": "bundle_fixed_price", "type": "fixed",
                "bundleQuantity": 2, "bundlePrice": price, "isActive": true, "autoApply": true, "updatedAt": stamp}],
            "items": [{"id": "i", "groupId": "g", "productId": "p", "updatedAt": stamp}],
        })
    }

    #[test]
    fn promotion_sync_offline_edit_chain_ignores_server_arrival_timestamps() {
        let a = promotion_test_snapshot(500, "09:00");
        let b = promotion_test_snapshot(400, "09:01");
        let c = promotion_test_snapshot(300, "09:02");
        let server_a = promotion_test_snapshot(500, "11:00");
        let server_b = promotion_test_snapshot(400, "11:01");
        assert_eq!(promotion_sync_decision(&server_a, &b, Some(&a)).unwrap(), PromotionSyncDecision::Apply);
        assert_eq!(promotion_sync_decision(&server_b, &c, Some(&b)).unwrap(), PromotionSyncDecision::Apply);
    }

    #[test]
    fn promotion_sync_ack_retry_is_a_noop_but_does_not_overwrite_other_till() {
        let a = promotion_test_snapshot(500, "09:00");
        let b = promotion_test_snapshot(400, "09:01");
        let saved_b = promotion_test_snapshot(400, "11:00");
        assert_eq!(promotion_sync_decision(&saved_b, &b, Some(&a)).unwrap(), PromotionSyncDecision::AlreadyApplied);
        let other_till = promotion_test_snapshot(350, "08:00");
        assert!(promotion_sync_decision(&other_till, &b, Some(&a)).unwrap_err().to_string().contains("SYNC_CONFLICT"));
    }

    #[test]
    fn promotion_sync_normalizes_nulls_booleans_and_metadata() {
        let a = promotion_test_snapshot(500, "09:00");
        let mut remote = a.clone();
        remote["group"]["isActive"] = serde_json::json!(1);
        remote["group"]["startAt"] = serde_json::Value::Null;
        remote["group"]["createdAt"] = serde_json::json!("server metadata");
        remote["discounts"][0]["bundlePrice"] = serde_json::json!("500");
        remote["discounts"][0]["autoApply"] = serde_json::json!(1);
        assert_eq!(normalized_promotion_snapshot(&a), normalized_promotion_snapshot(&remote));
    }

    #[test]
    fn promotion_sync_removed_member_is_a_conflict_not_a_deleted_offer() {
        let a = promotion_test_snapshot(500, "09:00");
        let mut remote = a.clone();
        remote["items"] = serde_json::json!([]);
        let b = promotion_test_snapshot(400, "09:01");
        assert!(promotion_sync_decision(&remote, &b, Some(&a)).is_err());
        assert!(remote["group"].is_object());
    }

    #[test]
    fn promotion_sync_delete_retry_and_manual_percentage_are_supported() {
        let empty = serde_json::json!({"group": null, "discounts": [], "items": []});
        let manual = serde_json::json!({"group": null, "discounts": [{"id": "d", "kind": "manual_percent", "value": 10}], "items": []});
        assert_eq!(promotion_sync_decision(&empty, &manual, Some(&empty)).unwrap(), PromotionSyncDecision::Apply);
        assert_eq!(promotion_sync_decision(&empty, &empty, Some(&manual)).unwrap(), PromotionSyncDecision::AlreadyApplied);
        assert_eq!(promotion_sync_decision(&manual, &manual, None).unwrap(), PromotionSyncDecision::AlreadyApplied);
    }

    #[test]
    fn promotion_sync_rejects_schema_overflow_and_invalid_price_values() {
        let valid = promotion_test_snapshot(500, "09:00")["discounts"][0].clone();
        validate_promotion_numbers(&valid).unwrap();
        for (field, value) in [
            ("bundleQuantity", serde_json::json!(2_147_483_648_i64)),
            ("minQuantity", serde_json::json!(1.5)),
            ("maxApplications", serde_json::json!(0)),
            ("bundlePrice", serde_json::json!(9_007_199_254_740_992_i64)),
            ("secondPrice", serde_json::json!(-1)),
        ] {
            let mut discount = valid.clone();
            discount[field] = value;
            assert!(validate_promotion_numbers(&discount).is_err(), "{field}");
        }
        let percentage = serde_json::json!({"kind":"manual_percent", "type":"percentage", "value":101});
        assert!(validate_promotion_numbers(&percentage).is_err());
    }

    static REAL_MARIADB_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn temporary_backup_test_dir(label: &str) -> PathBuf {
        let stamp = chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default();
        let path =
            std::env::temp_dir().join(format!("lbj-pos-{label}-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    async fn create_restore_ledger_validation_fixture(
        path: &PathBuf,
        include_payment_method: bool,
        ledger_entry: Option<(&str, &str)>,
    ) {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&format!("sqlite://{}?mode=rwc", path.display()))
            .await
            .unwrap();
        for sql in [
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)",
            "CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT, price INTEGER, costPrice INTEGER, isAgeRestricted INTEGER)",
            "CREATE TABLE customer_accounts (id TEXT PRIMARY KEY, customerId TEXT, isEnabled INTEGER, creditLimitPence INTEGER, balancePence INTEGER, createdAt TEXT, updatedAt TEXT)",
            "INSERT INTO products VALUES ('product-1', 'Restore product', 100, 50, 0)",
        ] {
            sqlx::query(sql).execute(&pool).await.unwrap();
        }
        let payment_method_column = if include_payment_method {
            ", paymentMethod TEXT"
        } else {
            ""
        };
        sqlx::query(&format!(
            "CREATE TABLE customer_account_entries (
                id TEXT PRIMARY KEY,
                accountId TEXT,
                customerId TEXT,
                orderId TEXT,
                entryType TEXT,
                amountPence INTEGER,
                idempotencyKey TEXT,
                balanceAfterPence INTEGER,
                createdAt TEXT,
                updatedAt TEXT
                {payment_method_column}
            )"
        ))
        .execute(&pool)
        .await
        .unwrap();

        if let Some((entry_type, payment_method)) = ledger_entry {
            sqlx::query(
                "INSERT INTO customer_accounts
                 VALUES ('account-1', 'customer-1', 1, 10000, 500, '2026-07-29T10:00:00Z', '2026-07-29T10:00:00Z')",
            )
            .execute(&pool)
            .await
            .unwrap();
            if include_payment_method {
                sqlx::query(
                    "INSERT INTO customer_account_entries
                     (id, accountId, customerId, orderId, entryType, amountPence,
                      idempotencyKey, balanceAfterPence, createdAt, updatedAt, paymentMethod)
                     VALUES ('entry-1', 'account-1', 'customer-1', '', ?, 500,
                             'entry-key-1', 500, '2026-07-29T10:00:00Z',
                             '2026-07-29T10:00:00Z', ?)",
                )
                .bind(entry_type)
                .bind(payment_method)
                .execute(&pool)
                .await
                .unwrap();
            } else {
                sqlx::query(
                    "INSERT INTO customer_account_entries
                     (id, accountId, customerId, orderId, entryType, amountPence,
                      idempotencyKey, balanceAfterPence, createdAt, updatedAt)
                     VALUES ('entry-1', 'account-1', 'customer-1', '', ?, 500,
                             'entry-key-1', 500, '2026-07-29T10:00:00Z',
                             '2026-07-29T10:00:00Z')",
                )
                .bind(entry_type)
                .execute(&pool)
                .await
                .unwrap();
            }
        }
        pool.close().await;
    }

    #[test]
    fn restore_gate_is_fail_closed_except_for_one_exact_claiming_session() {
        assert_eq!(
            restore_gate_write_decision(0, "", None),
            RestoreGateWriteDecision::Allowed
        );
        assert_eq!(
            restore_gate_write_decision(0, "stale-owner", None),
            RestoreGateWriteDecision::Allowed
        );
        assert_eq!(
            restore_gate_write_decision(1, "till-a", Some("till-a")),
            RestoreGateWriteDecision::Allowed
        );
        for decision in [
            restore_gate_write_decision(1, "till-a", None),
            restore_gate_write_decision(1, "till-a", Some("")),
            restore_gate_write_decision(1, "till-a", Some("till-b")),
            restore_gate_write_decision(1, "Till-A", Some("till-a")),
        ] {
            assert_eq!(decision, RestoreGateWriteDecision::MaintenanceBlocked);
        }
        for decision in [
            restore_gate_write_decision(1, "", Some("")),
            restore_gate_write_decision(1, "   ", Some("   ")),
            restore_gate_write_decision(2, "till-a", Some("till-a")),
            restore_gate_write_decision(-1, "till-a", Some("till-a")),
        ] {
            assert_eq!(decision, RestoreGateWriteDecision::Corrupt);
        }
    }

    #[test]
    fn mariadb_binary_coordination_reads_cast_to_utf8mb4_text() {
        for sql in [
            MYSQL_RESTORE_GATE_LOCK_SELECT,
            MYSQL_RESTORE_GATE_ACTIVE_OWNER_SELECT,
        ] {
            assert!(sql.contains("CAST(ownerTillId AS CHAR CHARACTER SET utf8mb4) AS ownerTillId"));
        }
        assert!(MYSQL_RESTORE_SESSION_BYPASS_SELECT.contains("AS CHAR CHARACTER SET utf8mb4"));
        assert!(MYSQL_WRITE_BARRIER_LOCK_SELECT
            .contains("CAST(state AS CHAR CHARACTER SET utf8mb4) AS state"));
        for projection in [
            "CAST(token AS CHAR CHARACTER SET utf8mb4) AS token",
            "CAST(state AS CHAR CHARACTER SET utf8mb4) AS state",
            "CAST(ownerTillId AS CHAR CHARACTER SET utf8mb4) AS ownerTillId",
            "AS CHAR CHARACTER SET utf8mb4) AS requestedAt",
            "AS CHAR CHARACTER SET utf8mb4) AS expiresAt",
            "AS CHAR CHARACTER SET utf8mb4) AS cutoffAt",
        ] {
            assert!(MYSQL_CLOSE_BARRIER_LOCK_SELECT.contains(projection));
        }
        let readiness = mysql_whole_system_close_readiness_select();
        assert!(readiness.contains(
            "CAST(COALESCE(p.closeBarrierToken, '') AS CHAR CHARACTER SET utf8mb4) AS barrierToken"
        ));
        assert!(readiness.contains(
            "CAST(COALESCE(p.closeBarrierPhase, '') AS CHAR CHARACTER SET utf8mb4) AS barrierPhase"
        ));
    }

    #[test]
    fn whole_system_close_duplicate_till_names_include_a_safe_short_id() {
        assert_eq!(
            whole_system_close_till_label("8f12637f-674f-4b47-a4f3-172ee8ebb2b2", "Till 1", false,),
            "Till 1"
        );
        assert_eq!(
            whole_system_close_till_label("8f12637f-674f-4b47-a4f3-172ee8ebb2b2", "Till 1", true,),
            "Till 1 [8f12637f]"
        );
        assert_eq!(
            whole_system_close_till_label("تۆمارکەر-دوو", "Till 1", true),
            "Till 1 [تۆمارکەر]"
        );
    }

    #[test]
    fn whole_system_close_setup_and_barrier_locks_are_bounded_and_abort_is_minimal() {
        assert_eq!(
            MYSQL_WHOLE_SYSTEM_CLOSE_METADATA_TIMEOUT_SQL,
            "SET SESSION lock_wait_timeout = 5"
        );
        assert_eq!(
            MYSQL_WHOLE_SYSTEM_CLOSE_ROW_TIMEOUT_SQL,
            "SET SESSION innodb_lock_wait_timeout = 5"
        );
        assert!((5..=30).contains(&WHOLE_SYSTEM_CLOSE_SCHEMA_PREPARE_TIMEOUT_SECONDS));
        assert!(WHOLE_SYSTEM_CLOSE_SETUP_TIMEOUT_CODE.contains("SETUP_TIMEOUT"));
        assert!((10..=30).contains(&WHOLE_SYSTEM_CLOSE_REPORT_LOAD_TIMEOUT_SECONDS));
        assert!(WHOLE_SYSTEM_CLOSE_REPORT_TIMEOUT_CODE.contains("REPORT_TIMEOUT"));

        assert!(MYSQL_CLOSE_BARRIER_READY_COLUMN_COUNT_SELECT
            .contains("TABLE_NAME = 'pos_close_barrier'"));
        for nonessential in [
            "till_presence",
            "pos_restore_gate",
            "pos_customer_write_locks",
            "lastClosedAt",
            "TRIGGERS",
        ] {
            assert!(!MYSQL_CLOSE_BARRIER_READY_COLUMN_COUNT_SELECT.contains(nonessential));
        }
    }

    #[test]
    fn mariadb_v4_guard_definition_requires_current_body_and_metadata() {
        let identity_guard = mysql_customer_guard_v4_sql("orders", "UPDATE");
        let statement = mysql_guarded_preflight_v4_sql(
            "lbj_guard_v4_orders_update",
            "orders",
            "UPDATE",
            "",
            identity_guard,
        );
        assert!(statement.contains("CREATE OR REPLACE TRIGGER"));
        assert!(statement.contains(MYSQL_GUARD_V4_BODY_MARKER));
        assert!(statement.contains(MYSQL_COORDINATION_SCHEMA_CORRUPT_CODE));
        assert!(statement.contains("restoreActive NOT IN (0, 1)"));
        assert!(statement.contains("REPORT_PERIOD_CLOSED"));
        assert!(mysql_guard_v4_definition_is_current(
            "orders", "UPDATE", "orders", "UPDATE", "BEFORE", 1, &statement,
        ));
        assert!(!mysql_guard_v4_definition_is_current(
            "orders", "UPDATE", "orders", "INSERT", "BEFORE", 1, &statement,
        ));
        assert!(!mysql_guard_v4_definition_is_current(
            "orders", "UPDATE", "orders", "UPDATE", "AFTER", 1, &statement,
        ));
        assert!(!mysql_guard_v4_definition_is_current(
            "orders", "UPDATE", "orders", "UPDATE", "BEFORE", 2, &statement,
        ));
        assert!(!mysql_guard_v4_definition_is_current(
            "orders",
            "UPDATE",
            "orders",
            "UPDATE",
            "BEFORE",
            1,
            &statement.replace(MYSQL_GUARD_V4_BODY_MARKER, "stale-body"),
        ));
    }

    #[test]
    fn mariadb_v4_guard_health_requires_every_current_guard_and_no_legacy_guard() {
        assert!(mysql_guarded_preflight_v4_health_is_current(
            8, 34, 102, 0, 3, 1, 1,
        ));
        // Missing optional legacy-era tables do not force schema maintenance
        // on every checkout; all guards on the 33 installed tables still do.
        assert!(mysql_guarded_preflight_v4_health_is_current(
            8, 33, 99, 0, 3, 1, 1,
        ));
        for unhealthy in [
            (7, 33, 99, 0, 3, 1, 1),
            (8, 34, 101, 0, 3, 1, 1),
            (8, 34, 102, 1, 3, 1, 1),
            (8, 34, 102, 0, 2, 1, 1),
            (8, 34, 102, 0, 3, 0, 1),
            (8, 34, 102, 0, 3, 1, 0),
            (0, 0, 0, 0, 3, 1, 1),
        ] {
            assert!(!mysql_guarded_preflight_v4_health_is_current(
                unhealthy.0,
                unhealthy.1,
                unhealthy.2,
                unhealthy.3,
                unhealthy.4,
                unhealthy.5,
                unhealthy.6,
            ));
        }
    }

    #[test]
    fn mariadb_v4_customer_guards_use_one_explicit_unicode_collation() {
        for table in [
            "customers",
            "customer_accounts",
            "orders",
            "loyalty_logs",
            "customer_account_entries",
        ] {
            for operation in ["INSERT", "UPDATE", "DELETE"] {
                let sql = mysql_customer_guard_v4_sql(table, operation);
                assert!(!sql.is_empty(), "missing {operation} guard for {table}");
                assert!(
                    sql.contains("CONVERT(") && sql.contains("COLLATE utf8mb4_unicode_ci"),
                    "{table} {operation} must use explicit compatible identifier collation"
                );
                for unsafe_comparison in [
                    "row_id = NEW.",
                    "row_id = OLD.",
                    "WHERE id = NEW.",
                    "WHERE id = OLD.",
                    "WHERE customerId = NEW.",
                    "WHERE customerId = OLD.",
                ] {
                    assert!(
                        !sql.contains(unsafe_comparison),
                        "{table} {operation} retained unsafe comparison {unsafe_comparison}"
                    );
                }
            }
        }
    }

    #[test]
    fn native_mariadb_writes_require_the_canonical_collation_marker() {
        assert_eq!(
            MYSQL_IDENTIFIER_COLLATION_MIGRATION,
            "2026-07-relational-identifier-collation-v2"
        );
        assert!(MYSQL_IDENTIFIER_COLLATION_REQUIRED_CODE.contains("REQUIRED"));
        assert!(MYSQL_COORDINATION_SCHEMA_MISSING_CODE.contains("MISSING"));
    }

    #[test]
    fn restore_upload_never_copies_device_or_control_settings() {
        for key in [
            "mysql_config",
            "device_operating_mode",
            "till_id",
            "receipt_printer_name",
            "restore_pending_mariadb_replace",
            "restore_maintenance_owner",
            "staff_attendance_import_owner",
            "server_data_epoch",
            "server_data_epoch_seen",
            "report_epoch_cache",
            "sync_ts_products",
            " STAFF_ATTENDANCE_IMPORT_OWNER ",
            "SYNC_TS_EMPLOYEES",
        ] {
            assert!(!is_restore_pushable_setting_key(key), "{key}");
        }
        assert!(is_restore_pushable_setting_key("store_info"));
        assert!(is_restore_pushable_setting_key("receipt_design"));
    }

    fn test_employee(id: &str, role: &str, pin: &str, pin_hash: &str) -> EmployeeProfileRecord {
        EmployeeProfileRecord {
            id: id.into(),
            store_id: "store-main".into(),
            name: "Test employee".into(),
            pin: pin.into(),
            pin_hash: pin_hash.into(),
            role: role.into(),
            email: String::new(),
            is_active: true,
            created_at: "2026-08-22T10:00:00.000Z".into(),
            updated_at: "2026-08-22T10:00:00.000Z".into(),
        }
    }

    #[test]
    fn native_employee_pin_validation_matches_runtime_formats() {
        let valid_pbkdf2 = concat!(
            "pbkdf2-sha256$210000$AAAAAAAAAAAAAAAAAAAAAA==$",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
        );
        assert!(is_valid_pbkdf2_pin_hash(valid_pbkdf2));
        for invalid in [
            "pbkdf2-sha256$99999$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            "pbkdf2-sha256$1000001$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            "pbkdf2-sha256$210000$not-base64!$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            "pbkdf2-sha256$210000$AAAAAAAAAAAAAAAAAAAAAA==$short",
            "pbkdf2-sha256$210000$AAAAAAAAAAAAAAAAAAAAAA==",
        ] {
            assert!(!is_valid_pbkdf2_pin_hash(invalid), "{invalid}");
        }
        let digest = STANDARD_BASE64.encode([0_u8; 32]);
        for invalid_salt_size in [15_usize, 65] {
            let salt = STANDARD_BASE64.encode(vec![0_u8; invalid_salt_size]);
            assert!(!is_valid_pbkdf2_pin_hash(&format!(
                "pbkdf2-sha256$210000${salt}${digest}"
            )));
        }
        let salt = STANDARD_BASE64.encode([0_u8; 16]);
        for invalid_digest_size in [31_usize, 33] {
            let invalid_digest = STANDARD_BASE64.encode(vec![0_u8; invalid_digest_size]);
            assert!(!is_valid_pbkdf2_pin_hash(&format!(
                "pbkdf2-sha256$210000${salt}${invalid_digest}"
            )));
        }
        assert!(employee_has_valid_runtime_pin(&test_employee(
            "legacy-hash",
            "admin",
            "",
            &"a".repeat(64),
        )));
        assert!(employee_has_valid_runtime_pin(&test_employee(
            "legacy-plain",
            "admin",
            "1234",
            "",
        )));
        assert!(!employee_has_valid_runtime_pin(&test_employee(
            "bad-prefix",
            "admin",
            "",
            "pbkdf2-sha256$210000$bad$bad",
        )));
        assert_eq!(
            legacy_pin_sha256("2468"),
            "16049d6bc2114d422dd7abe6280a96052677d2d0187f1646ea654c71bee11ad1"
        );
        let uppercase_legacy = test_employee(
            "legacy-upper",
            "cashier",
            "",
            &legacy_pin_sha256("2468").to_ascii_uppercase(),
        );
        assert!(legacy_employee_pin_matches(&uppercase_legacy, "2468"));
        assert!(!legacy_employee_pin_matches(&uppercase_legacy, "1357"));
    }

    #[test]
    fn native_employee_authority_queries_normalize_unsigned_mariadb_values() {
        assert_eq!(
            MYSQL_SIGNED_CONNECTION_ID_SELECT,
            "SELECT CAST(CONNECTION_ID() AS SIGNED)"
        );
        assert_eq!(
            MYSQL_SIGNED_EMPLOYEE_ACTIVE_PROJECTION,
            "CAST(COALESCE(isActive, 0) AS SIGNED) AS isActive"
        );
    }

    #[test]
    fn usable_admin_invariant_rejects_inactive_or_malformed_credentials() {
        let mut valid = test_employee("admin", "admin", "1234", "");
        assert!(employee_is_usable_admin(&valid));
        valid.is_active = false;
        assert!(!employee_is_usable_admin(&valid));
        let malformed = test_employee("bad-admin", "admin", "", "pbkdf2-sha256$210000$bad$bad");
        assert!(!employee_is_usable_admin(&malformed));
    }

    #[test]
    fn employee_profile_cas_preserves_legacy_credentials_but_never_creates_them() {
        let legacy = test_employee("cashier", "cashier", "1234", "");
        assert!(employee_profile_credentials_allowed(Some(&legacy), &legacy));
        assert!(!employee_profile_credentials_allowed(None, &legacy));

        let legacy_sha = test_employee("manager", "manager", "", &"A".repeat(64));
        assert!(employee_profile_credentials_allowed(
            Some(&legacy_sha),
            &legacy_sha
        ));
        assert!(!employee_profile_credentials_allowed(None, &legacy_sha));

        let hash = concat!(
            "pbkdf2-sha256$210000$AAAAAAAAAAAAAAAAAAAAAA==$",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
        );
        let pbkdf = test_employee("new", "cashier", "", hash);
        assert!(employee_profile_credentials_allowed(None, &pbkdf));
        let mixed = EmployeeProfileRecord {
            pin: "1234".into(),
            ..pbkdf.clone()
        };
        assert!(!employee_profile_credentials_allowed(None, &mixed));
        assert!(!employee_profile_credentials_allowed(Some(&mixed), &mixed));

        let changed_to_legacy = EmployeeProfileRecord {
            pin: "9876".into(),
            pin_hash: String::new(),
            ..pbkdf
        };
        assert!(!employee_profile_credentials_allowed(
            Some(&legacy),
            &changed_to_legacy
        ));
    }

    #[test]
    fn first_admin_bootstrap_requires_a_truly_empty_staff_table() {
        let hash = concat!(
            "pbkdf2-sha256$210000$AAAAAAAAAAAAAAAAAAAAAA==$",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
        );
        let admin = test_employee("admin", "admin", "", hash);
        assert!(assert_first_admin_bootstrap_allowed(&admin, &[]).is_ok());
        let inactive_cashier = EmployeeProfileRecord {
            is_active: false,
            ..test_employee("cashier", "cashier", "1234", "")
        };
        assert!(assert_first_admin_bootstrap_allowed(&admin, &[inactive_cashier]).is_err());
    }

    #[test]
    fn delegated_staff_editor_cannot_mint_or_modify_admin_access() {
        let manager = test_employee("manager", "manager", "1234", "");
        let cashier = test_employee("cashier", "cashier", "2468", "");
        let promoted = EmployeeProfileRecord {
            role: "admin".into(),
            ..cashier.clone()
        };
        assert!(assert_employee_profile_actor_scope(&manager, Some(&cashier), &promoted).is_err());
        let admin = test_employee("admin", "admin", "1357", "");
        assert!(assert_employee_profile_actor_scope(&manager, Some(&admin), &admin).is_err());
        let renamed = EmployeeProfileRecord {
            name: "Renamed cashier".into(),
            ..cashier.clone()
        };
        assert!(assert_employee_profile_actor_scope(&manager, Some(&cashier), &renamed).is_ok());
        assert!(assert_employee_profile_actor_scope(&admin, Some(&cashier), &promoted).is_ok());
    }

    #[test]
    fn controlled_import_covers_every_authority_and_history_table() {
        for table in [
            "employees",
            "employee_attendance",
            "audit_logs",
            "customers",
            "customer_account_entries",
            "orders",
            "payments",
            "settings",
            "tombstones",
        ] {
            assert!(
                MARIADB_CONTROLLED_IMPORT_COPY_TABLES.contains(&table),
                "{table}"
            );
        }
    }

    #[test]
    fn generic_outbox_keeps_financial_tables_narrow_and_identity_keys_fixed() {
        assert!(generic_mysql_outbox_table_allowed("products"));
        assert!(!generic_mysql_outbox_table_allowed("orders"));
        assert!(!generic_mysql_outbox_table_allowed("order_lines"));
        assert!(!generic_mysql_outbox_table_allowed("payments"));
        assert!(!generic_mysql_outbox_table_allowed(
            "customer_account_entries"
        ));
        assert!(generic_mysql_outbox_id_key_allowed("settings", "key"));
        assert!(!generic_mysql_outbox_id_key_allowed("settings", "id"));
        assert!(generic_mysql_outbox_id_key_allowed("products", "id"));
        assert!(!generic_mysql_outbox_id_key_allowed("products", "barcode"));
    }

    #[test]
    fn generic_tombstones_require_an_exact_supported_identity() {
        assert!(validate_generic_tombstone(&serde_json::json!({
            "id": "products:product-1",
            "table_name": "products",
            "row_id": "product-1",
        }))
        .is_ok());
        assert!(validate_generic_tombstone(&serde_json::json!({
            "id": "settings:server_data_epoch",
            "table_name": "settings",
            "row_id": "server_data_epoch",
        }))
        .is_err());
        assert!(validate_generic_tombstone(&serde_json::json!({
            "id": "products:other",
            "table_name": "products",
            "row_id": "product-1",
        }))
        .is_err());
    }

    #[test]
    fn restore_replaces_backup_tombstones_after_all_business_rows() {
        assert_eq!(MARIADB_RESTORE_DELETE_TABLES.last(), Some(&"tombstones"));
        assert_eq!(MARIADB_RESTORE_COPY_TABLES.last(), Some(&"tombstones"));
        assert!(MARIADB_RESTORE_COPY_TABLES.contains(&"customers"));
        assert!(MARIADB_RESTORE_COPY_TABLES.contains(&"customer_accounts"));
    }

    #[test]
    fn latest_backup_ignores_internal_restore_files() {
        let dir = temporary_backup_test_dir("backup-selection");
        for name in [
            "pos-backup-20260701-100000-000.db",
            "pos-backup-20260702-100000-000.db",
            "pre-restore-pos-backup-20260712-120000.db",
            "restore-staging-20260712-120001.db",
        ] {
            fs::write(dir.join(name), b"test").unwrap();
        }

        let latest = latest_user_backup_in_dir(&dir).unwrap().unwrap();
        assert_eq!(
            latest.file_name().and_then(|name| name.to_str()),
            Some("pos-backup-20260702-100000-000.db")
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_post_swap_restore_puts_the_original_database_back() {
        let dir = temporary_backup_test_dir("restore-file-rollback");
        let target = dir.join("pos.db");
        let safety = dir.join("pre-restore.db");
        fs::write(&target, b"failed restored database").unwrap();
        fs::write(&safety, b"original database").unwrap();

        rollback_replaced_database(&target, Some(&safety)).unwrap();

        assert_eq!(fs::read(&target).unwrap(), b"original database");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn multi_till_restore_requires_the_same_verified_shop_identity() {
        assert!(validate_restore_shop_identity_values(
            Some("multi"),
            Some("shop-a"),
            Some("shop-a")
        )
        .is_ok());
        assert!(validate_restore_shop_identity_values(
            Some("single"),
            Some("shop-a"),
            Some("shop-b")
        )
        .is_ok());

        let mismatch =
            validate_restore_shop_identity_values(Some("multi"), Some("shop-a"), Some("shop-b"))
                .unwrap_err();
        assert!(mismatch.contains("DATABASE_IDENTITY_MISMATCH"));

        let missing =
            validate_restore_shop_identity_values(Some("multi"), None, Some("shop-b")).unwrap_err();
        assert!(missing.contains("DATABASE_IDENTITY_UNVERIFIED"));
    }

    #[test]
    fn legacy_backup_without_critical_age_and_account_fields_is_rejected() {
        tauri::async_runtime::block_on(async {
            let dir = temporary_backup_test_dir("legacy-restore-compatibility");
            let source = dir.join("legacy.db");
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect(&format!("sqlite://{}?mode=rwc", source.display()))
                .await
                .unwrap();
            sqlx::query("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query(
                "CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT, price INTEGER, costPrice INTEGER)",
            )
            .execute(&pool)
            .await
            .unwrap();

            let error = validate_restore_schema(&pool).await.unwrap_err();
            assert!(error.contains("BACKUP_COMPATIBILITY_WARNING"));
            assert!(error.contains("products.isAgeRestricted"));
            pool.close().await;
            fs::remove_dir_all(dir).unwrap();
        });
    }

    #[test]
    fn nonempty_restore_ledger_missing_payment_method_is_rejected_before_swap() {
        tauri::async_runtime::block_on(async {
            let dir = temporary_backup_test_dir("restore-ledger-missing-payment-method");
            let source = dir.join("backup.db");
            let untouched_live_database = dir.join("live.db");
            fs::write(&untouched_live_database, b"live database sentinel").unwrap();
            create_restore_ledger_validation_fixture(&source, false, Some(("charge", ""))).await;

            let error = validate_restore_source(&source).await.unwrap_err();
            assert!(error.contains("BACKUP_COMPATIBILITY_WARNING"));
            assert!(error.contains("customer_account_entries.paymentMethod"));
            assert_eq!(
                fs::read(&untouched_live_database).unwrap(),
                b"live database sentinel"
            );
            fs::remove_dir_all(dir).unwrap();
        });
    }

    #[test]
    fn empty_restore_ledger_without_payment_method_is_safe_to_migrate() {
        tauri::async_runtime::block_on(async {
            let dir = temporary_backup_test_dir("restore-empty-ledger-migration");
            let source = dir.join("backup.db");
            create_restore_ledger_validation_fixture(&source, false, None).await;

            validate_restore_source(&source).await.unwrap();
            fs::remove_dir_all(dir).unwrap();
        });
    }

    #[test]
    fn restore_rejects_payment_ledger_rows_with_blank_payment_method() {
        tauri::async_runtime::block_on(async {
            let dir = temporary_backup_test_dir("restore-blank-ledger-payment-method");
            let source = dir.join("backup.db");
            create_restore_ledger_validation_fixture(&source, true, Some(("payment", "   "))).await;

            let error = validate_restore_source(&source).await.unwrap_err();
            assert!(error.contains("Restore stopped before changing data"));
            assert!(error.contains("Customer account payments with missing payment method"));
            fs::remove_dir_all(dir).unwrap();
        });
    }

    #[test]
    fn creates_and_verifies_a_consistent_sqlite_backup() {
        tauri::async_runtime::block_on(async {
            let dir = temporary_backup_test_dir("backup-create");
            let source = dir.join("pos.db");
            let backup_dir = dir.join("backups");
            let uri = format!("sqlite://{}?mode=rwc", source.display());
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect(&uri)
                .await
                .unwrap();
            sqlx::query("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updatedAt TEXT)")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT, price INTEGER, costPrice INTEGER)")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query(
                "INSERT INTO products (id, name, price, costPrice) VALUES ('p1', 'Test', 125, 50)",
            )
            .execute(&pool)
            .await
            .unwrap();
            pool.close().await;

            let backup = create_local_backup_in_dir(&source, &backup_dir)
                .await
                .unwrap();
            assert!(is_user_backup(&backup));
            validate_backup_snapshot(&backup).await.unwrap();

            let backup_uri = format!("sqlite://{}?mode=ro", backup.display());
            let backup_pool = SqlitePool::connect(&backup_uri).await.unwrap();
            let product_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM products")
                .fetch_one(&backup_pool)
                .await
                .unwrap();
            backup_pool.close().await;
            assert_eq!(product_count, 1);
            fs::remove_dir_all(dir).unwrap();
        });
    }

    #[test]
    fn restore_keeps_only_the_target_till_identity() {
        tauri::async_runtime::block_on(async {
            let dir = temporary_backup_test_dir("restore-register-identity");
            let target = dir.join("restored.db");
            let preserved = dir.join("current-till.db");

            let target_pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect(&format!("sqlite://{}?mode=rwc", target.display()))
                .await
                .unwrap();
            for sql in [
                "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updatedAt TEXT)",
                "CREATE TABLE employees (id TEXT PRIMARY KEY, name TEXT)",
                "CREATE TABLE app_identity (id TEXT PRIMARY KEY, shopId TEXT, shopName TEXT)",
                "CREATE TABLE registers (id TEXT PRIMARY KEY, storeId TEXT, name TEXT NOT NULL, isActive INTEGER DEFAULT 1, createdAt TEXT, updatedAt TEXT)",
                "CREATE TABLE _offline_queue (id TEXT PRIMARY KEY, table_name TEXT)",
                "CREATE TABLE tombstones (id TEXT PRIMARY KEY, table_name TEXT)",
                "INSERT INTO settings VALUES ('till_id', 'source-till', '')",
                "INSERT INTO settings VALUES ('till_name', 'Source Till', '')",
                "INSERT INTO settings VALUES ('device_operating_mode', 'back_office', '')",
                "INSERT INTO settings VALUES ('receipt_printer_name', 'Source Printer', '')",
                "INSERT INTO settings VALUES ('store_info', '{\"name\":\"Backup Store\"}', '')",
                "INSERT INTO employees VALUES ('backup-employee', 'Backup Employee')",
                "INSERT INTO app_identity VALUES ('main', 'backup-shop', 'Backup Store')",
                "INSERT INTO registers VALUES ('source-till', 'store-main', 'Source Till', 1, '', '')",
                "INSERT INTO registers VALUES ('legacy-till', 'store-main', 'Main Register', 1, '', '')",
                "INSERT INTO _offline_queue VALUES ('register-work', 'registers')",
                "INSERT INTO _offline_queue VALUES ('product-work', 'products')",
                "INSERT INTO tombstones VALUES ('register-delete', 'registers')",
                "INSERT INTO tombstones VALUES ('product-delete', 'products')",
            ] {
                sqlx::query(sql).execute(&target_pool).await.unwrap();
            }
            target_pool.close().await;

            let preserved_pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect(&format!("sqlite://{}?mode=rwc", preserved.display()))
                .await
                .unwrap();
            for sql in [
                "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updatedAt TEXT)",
                "CREATE TABLE employees (id TEXT PRIMARY KEY, name TEXT)",
                "CREATE TABLE app_identity (id TEXT PRIMARY KEY, shopId TEXT, shopName TEXT)",
                "CREATE TABLE registers (id TEXT PRIMARY KEY, storeId TEXT, name TEXT NOT NULL, isActive INTEGER DEFAULT 1, createdAt TEXT, updatedAt TEXT)",
                "INSERT INTO settings VALUES ('till_id', 'target-till', '')",
                "INSERT INTO settings VALUES ('till_name', 'Front Till', '')",
                "INSERT INTO settings VALUES ('device_operating_mode', 'checkout', '')",
                "INSERT INTO settings VALUES ('receipt_printer_name', 'Target Printer', '')",
                "INSERT INTO settings VALUES ('store_info', '{\"name\":\"Current Store\"}', '')",
                "INSERT INTO employees VALUES ('current-employee', 'Current Employee')",
                "INSERT INTO app_identity VALUES ('main', 'current-shop', 'Current Store')",
                "INSERT INTO registers VALUES ('target-till', 'store-main', 'Front Till', 1, '', '')",
                "INSERT INTO registers VALUES ('old-local-till', 'store-main', 'Old Till', 1, '', '')",
            ] {
                sqlx::query(sql).execute(&preserved_pool).await.unwrap();
            }
            preserved_pool.close().await;

            restore_preserved_local_setup(&target, preserved.to_str())
                .await
                .unwrap();

            let restored_pool =
                SqlitePool::connect(&format!("sqlite://{}?mode=ro", target.display()))
                    .await
                    .unwrap();
            let registers: Vec<(String, String, i64)> =
                sqlx::query_as("SELECT id, name, isActive FROM registers ORDER BY id")
                    .fetch_all(&restored_pool)
                    .await
                    .unwrap();
            assert_eq!(
                registers,
                vec![("target-till".into(), "Front Till".into(), 1)]
            );

            let employee_ids: Vec<String> =
                sqlx::query_scalar("SELECT id FROM employees ORDER BY id")
                    .fetch_all(&restored_pool)
                    .await
                    .unwrap();
            assert_eq!(employee_ids, vec!["backup-employee"]);
            let shop_id: String =
                sqlx::query_scalar("SELECT shopId FROM app_identity WHERE id = 'main'")
                    .fetch_one(&restored_pool)
                    .await
                    .unwrap();
            assert_eq!(shop_id, "backup-shop");
            let business_setting: String =
                sqlx::query_scalar("SELECT value FROM settings WHERE key = 'store_info'")
                    .fetch_one(&restored_pool)
                    .await
                    .unwrap();
            assert!(business_setting.contains("Backup Store"));
            let printer_setting: String =
                sqlx::query_scalar("SELECT value FROM settings WHERE key = 'receipt_printer_name'")
                    .fetch_one(&restored_pool)
                    .await
                    .unwrap();
            assert_eq!(printer_setting, "Target Printer");
            let device_mode: String = sqlx::query_scalar(
                "SELECT value FROM settings WHERE key = 'device_operating_mode'",
            )
            .fetch_one(&restored_pool)
            .await
            .unwrap();
            assert_eq!(device_mode, "checkout");

            let queued_tables: Vec<String> =
                sqlx::query_scalar("SELECT table_name FROM _offline_queue ORDER BY table_name")
                    .fetch_all(&restored_pool)
                    .await
                    .unwrap();
            assert_eq!(queued_tables, vec!["products"]);
            let tombstone_tables: Vec<String> =
                sqlx::query_scalar("SELECT table_name FROM tombstones ORDER BY table_name")
                    .fetch_all(&restored_pool)
                    .await
                    .unwrap();
            assert_eq!(tombstone_tables, vec!["products"]);
            restored_pool.close().await;

            fs::remove_dir_all(dir).unwrap();
        });
    }

    #[test]
    fn first_machine_restore_does_not_adopt_the_source_till() {
        tauri::async_runtime::block_on(async {
            let dir = temporary_backup_test_dir("restore-without-target-identity");
            let target = dir.join("restored.db");
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect(&format!("sqlite://{}?mode=rwc", target.display()))
                .await
                .unwrap();
            for sql in [
                "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updatedAt TEXT)",
                "CREATE TABLE registers (id TEXT PRIMARY KEY, name TEXT NOT NULL)",
                "INSERT INTO settings VALUES ('till_id', 'source-till', '')",
                "INSERT INTO settings VALUES ('till_name', 'Source Till', '')",
                "INSERT INTO settings VALUES ('till_seq', '4', '')",
                "INSERT INTO settings VALUES ('pos_mode', 'multi', '')",
                "INSERT INTO settings VALUES ('mysql_config', '{\"host\":\"source\"}', '')",
                "INSERT INTO settings VALUES ('device_operating_mode', 'back_office', '')",
                "INSERT INTO settings VALUES ('receipt_printer_name', 'Source Star Printer', '')",
                "INSERT INTO settings VALUES ('receipt_printer_module_id', 'source-sdk', '')",
                "INSERT INTO settings VALUES ('label_printer_device_path', 'COM9', '')",
                "INSERT INTO settings VALUES ('receipt_design', '{\"paperWidth\":\"80mm\"}', '')",
                "INSERT INTO registers VALUES ('source-till', 'Source Till')",
                "INSERT INTO registers VALUES ('legacy-till', 'Main Register')",
            ] {
                sqlx::query(sql).execute(&pool).await.unwrap();
            }
            pool.close().await;

            restore_preserved_local_setup(&target, None).await.unwrap();

            let restored_pool =
                SqlitePool::connect(&format!("sqlite://{}?mode=ro", target.display()))
                    .await
                    .unwrap();
            let register_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM registers")
                .fetch_one(&restored_pool)
                .await
                .unwrap();
            let identity_count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM settings
                 WHERE key IN ('till_id', 'till_name', 'till_name_manual', 'till_seq')",
            )
            .fetch_one(&restored_pool)
            .await
            .unwrap();
            let hardware_setting_count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM settings
                 WHERE key LIKE 'receipt_printer_%'
                    OR key LIKE 'label_printer_%'
                    OR key LIKE 'cash_drawer_%'
                    OR key LIKE 'scale_hardware_%'",
            )
            .fetch_one(&restored_pool)
            .await
            .unwrap();
            let design_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM settings WHERE key = 'receipt_design'")
                    .fetch_one(&restored_pool)
                    .await
                    .unwrap();
            let mysql_config_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM settings WHERE key = 'mysql_config'")
                    .fetch_one(&restored_pool)
                    .await
                    .unwrap();
            let device_mode_count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM settings WHERE key = 'device_operating_mode'",
            )
            .fetch_one(&restored_pool)
            .await
            .unwrap();
            let restored_mode: String =
                sqlx::query_scalar("SELECT value FROM settings WHERE key = 'pos_mode'")
                    .fetch_one(&restored_pool)
                    .await
                    .unwrap();
            let restore_marker_count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM settings WHERE key = 'restore_pending_mariadb_replace'",
            )
            .fetch_one(&restored_pool)
            .await
            .unwrap();
            assert_eq!(register_count, 0);
            assert_eq!(identity_count, 0);
            assert_eq!(hardware_setting_count, 0);
            assert_eq!(mysql_config_count, 0);
            assert_eq!(device_mode_count, 0);
            assert_eq!(restored_mode, "multi");
            assert_eq!(restore_marker_count, 1);
            assert_eq!(design_count, 1);
            restored_pool.close().await;

            fs::remove_dir_all(dir).unwrap();
        });
    }

    #[test]
    fn restore_migrates_legacy_settings_metadata_before_post_swap_work() {
        tauri::async_runtime::block_on(async {
            let dir = temporary_backup_test_dir("restore-legacy-settings-metadata");
            let target = dir.join("restored.db");
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect(&format!("sqlite://{}?mode=rwc", target.display()))
                .await
                .unwrap();
            sqlx::query("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO settings VALUES ('store_info', '{}')")
                .execute(&pool)
                .await
                .unwrap();
            pool.close().await;

            restore_preserved_local_setup(&target, None).await.unwrap();
            let restored = SqlitePool::connect(&format!("sqlite://{}?mode=ro", target.display()))
                .await
                .unwrap();
            let columns = table_columns(&restored, "main", "settings").await.unwrap();
            assert!(columns.iter().any(|column| column == "updatedAt"));
            let store_info: String =
                sqlx::query_scalar("SELECT value FROM settings WHERE key = 'store_info'")
                    .fetch_one(&restored)
                    .await
                    .unwrap();
            assert_eq!(store_info, "{}");
            restored.close().await;
            fs::remove_dir_all(dir).unwrap();
        });
    }

    #[test]
    fn automatic_setup_backup_refuses_and_validator_rejects_pending_online_intent() {
        tauri::async_runtime::block_on(async {
            let dir = temporary_backup_test_dir("automatic-setup-pending-intent");
            let source = dir.join("pos.db");
            let backup_dir = dir.join("backups");
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect(&format!("sqlite://{}?mode=rwc", source.display()))
                .await
                .unwrap();
            for sql in [
                "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)",
                "CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT, price INTEGER, costPrice INTEGER)",
                "INSERT INTO settings VALUES ('store_info', '{}')",
                "INSERT INTO products VALUES ('product-1', 'Product', 100, 50)",
            ] {
                sqlx::query(sql).execute(&pool).await.unwrap();
            }
            ensure_sqlite_online_financial_intent_schema(&pool)
                .await
                .unwrap();
            sqlx::query(&format!(
                "INSERT INTO {ONLINE_FINANCIAL_INTENT_TABLE}
                    (id, operation, orderId, requestJson, bundleJson,
                     serverDataEpoch, createdAt, updatedAt, lastError)
                 VALUES (1, 'loyalty_sale', 'pending-order', '{{}}', '{{}}',
                         'epoch-1', '', '', '')"
            ))
            .execute(&pool)
            .await
            .unwrap();
            pool.close().await;

            let error = create_automatic_setup_backup_in_dir(&source, &backup_dir, "20260729")
                .await
                .unwrap_err();
            assert!(error.contains(ONLINE_FINANCIAL_INTENT_PENDING_CODE));
            let validation_error = validate_automatic_setup_backup(&source).await.unwrap_err();
            assert!(validation_error.contains(ONLINE_FINANCIAL_INTENT_TABLE));
            fs::remove_dir_all(dir).unwrap();
        });
    }

    #[test]
    fn automatic_setup_backup_strips_sales_and_keeps_only_two_daily_files() {
        tauri::async_runtime::block_on(async {
            let dir = temporary_backup_test_dir("automatic-setup-backup");
            let source = dir.join("pos.db");
            let backup_dir = dir.join("backups");
            let uri = format!("sqlite://{}?mode=rwc", source.display());
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect(&uri)
                .await
                .unwrap();
            for sql in [
                "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updatedAt TEXT)",
                "CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT, price INTEGER, costPrice INTEGER)",
                "CREATE TABLE registers (id TEXT PRIMARY KEY, name TEXT)",
                "CREATE TABLE orders (id TEXT PRIMARY KEY)",
                "CREATE TABLE order_lines (id TEXT PRIMARY KEY, orderId TEXT)",
                "CREATE TABLE payments (id TEXT PRIMARY KEY, orderId TEXT)",
                "CREATE TABLE payment_terminal_attempts (id TEXT PRIMARY KEY)",
                "CREATE TABLE shifts (id TEXT PRIMARY KEY)",
                "CREATE TABLE cash_movements (id TEXT PRIMARY KEY, shiftId TEXT)",
                "CREATE TABLE inventory_logs (id TEXT PRIMARY KEY, referenceId TEXT)",
                "CREATE TABLE audit_logs (id TEXT PRIMARY KEY, entityId TEXT, entityType TEXT, action TEXT)",
                "CREATE TABLE manager_approvals (id TEXT PRIMARY KEY, entityId TEXT, entityType TEXT, action TEXT)",
                "CREATE TABLE loyalty_logs (id TEXT PRIMARY KEY, orderId TEXT)",
                "CREATE TABLE customer_accounts (id TEXT PRIMARY KEY, customerId TEXT, balancePence INTEGER)",
                "CREATE TABLE customer_account_entries (id TEXT PRIMARY KEY, accountId TEXT, customerId TEXT, orderId TEXT, balanceAfterPence INTEGER)",
                "CREATE TABLE daily_sales_summary (id TEXT PRIMARY KEY)",
                "CREATE TABLE till_report_markers (id TEXT PRIMARY KEY)",
                "CREATE TABLE _offline_queue (id TEXT PRIMARY KEY, operation TEXT, table_name TEXT)",
                "CREATE TABLE tombstones (id TEXT PRIMARY KEY, table_name TEXT)",
                "INSERT INTO settings VALUES ('store_info', '{}', '')",
                "INSERT INTO products VALUES ('product-1', 'Product', 100, 50)",
                "INSERT INTO registers VALUES ('source-till', 'Source Till')",
                "INSERT INTO registers VALUES ('legacy-till', 'Main Register')",
                "INSERT INTO orders VALUES ('order-1')",
                "INSERT INTO order_lines VALUES ('line-1', 'order-1')",
                "INSERT INTO payments VALUES ('payment-1', 'order-1')",
                "INSERT INTO payment_terminal_attempts VALUES ('terminal-attempt-1')",
                "INSERT INTO shifts VALUES ('shift-1')",
                "INSERT INTO cash_movements VALUES ('cash-1', 'shift-1')",
                "INSERT INTO inventory_logs VALUES ('stock-sale', 'order-1')",
                "INSERT INTO inventory_logs VALUES ('stock-manual', 'manual-adjustment')",
                "INSERT INTO audit_logs VALUES ('audit-sale', 'order-1', 'order', 'sale_completed')",
                "INSERT INTO audit_logs VALUES ('audit-product', 'product-1', 'product', 'updated')",
                "INSERT INTO manager_approvals VALUES ('approval-1', 'order-1', 'order', 'refund_void')",
                "INSERT INTO loyalty_logs VALUES ('loyalty-sale', 'order-1')",
                "INSERT INTO loyalty_logs VALUES ('loyalty-manual', '')",
                "INSERT INTO customer_accounts VALUES ('customer-1', 'customer-1', 3750)",
                "INSERT INTO customer_account_entries VALUES ('account-entry-1', 'customer-1', 'customer-1', 'order-1', 3750)",
                "INSERT INTO daily_sales_summary VALUES ('summary-1')",
                "INSERT INTO till_report_markers VALUES ('marker-1')",
                "INSERT INTO _offline_queue VALUES ('queue-sale', 'saleBundle', 'orders')",
                "INSERT INTO _offline_queue VALUES ('queue-register', 'upsert', 'registers')",
                "INSERT INTO tombstones VALUES ('tomb-sale', 'orders')",
                "INSERT INTO tombstones VALUES ('tomb-register', 'registers')",
            ] {
                sqlx::query(sql).execute(&pool).await.unwrap();
            }
            pool.close().await;

            let (first, created) =
                create_automatic_setup_backup_in_dir(&source, &backup_dir, "20260710")
                    .await
                    .unwrap();
            assert!(created);
            assert!(first.exists());
            let (_, duplicate_created) =
                create_automatic_setup_backup_in_dir(&source, &backup_dir, "20260710")
                    .await
                    .unwrap();
            assert!(!duplicate_created);
            fs::write(&first, b"not a sqlite database").unwrap();
            let (_, invalid_recreated) =
                create_automatic_setup_backup_in_dir(&source, &backup_dir, "20260710")
                    .await
                    .unwrap();
            assert!(invalid_recreated);
            validate_automatic_setup_backup(&first).await.unwrap();

            let manual_backup = create_local_backup_in_dir(&source, &backup_dir)
                .await
                .unwrap();
            create_automatic_setup_backup_in_dir(&source, &backup_dir, "20260711")
                .await
                .unwrap();
            let (latest, _) =
                create_automatic_setup_backup_in_dir(&source, &backup_dir, "20260712")
                    .await
                    .unwrap();

            let automatic_files = automatic_setup_backups_in_dir(&backup_dir).unwrap();
            assert_eq!(automatic_files.len(), 2);
            assert!(!first.exists());
            assert!(manual_backup.exists());

            let backup_uri = format!("sqlite://{}?mode=ro", latest.display());
            let backup_pool = SqlitePool::connect(&backup_uri).await.unwrap();
            for table in [
                "registers",
                "orders",
                "order_lines",
                "payments",
                "payment_terminal_attempts",
                "shifts",
                "cash_movements",
                "daily_sales_summary",
                "till_report_markers",
            ] {
                let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
                    .fetch_one(&backup_pool)
                    .await
                    .unwrap();
                assert_eq!(count, 0, "{table} should be empty in setup backup");
            }
            for (table, expected) in [
                ("products", 1_i64),
                ("inventory_logs", 1),
                ("audit_logs", 1),
                ("loyalty_logs", 1),
                ("customer_accounts", 1),
                ("customer_account_entries", 1),
            ] {
                let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
                    .fetch_one(&backup_pool)
                    .await
                    .unwrap();
                assert_eq!(count, expected, "{table} shop data should be preserved");
            }
            backup_pool.close().await;

            let source_pool =
                SqlitePool::connect(&format!("sqlite://{}?mode=ro", source.display()))
                    .await
                    .unwrap();
            let source_orders: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM orders")
                .fetch_one(&source_pool)
                .await
                .unwrap();
            source_pool.close().await;
            assert_eq!(source_orders, 1, "the live source must not be modified");
            fs::remove_dir_all(dir).unwrap();
        });
    }

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        for sql in [
            "CREATE TABLE orders (id TEXT PRIMARY KEY, shiftId TEXT, customerId TEXT, employeeId TEXT, orderNumber INTEGER, receiptKey TEXT UNIQUE, type TEXT, status TEXT, originalOrderId TEXT, subtotal INTEGER, discountId TEXT, discountAmount INTEGER, taxTotal INTEGER, total INTEGER, tillNumber TEXT, notes TEXT, paymentMethod TEXT, amountTendered INTEGER, createdAt TEXT, completedAt TEXT, updatedAt TEXT)",
            "CREATE TABLE order_lines (id TEXT PRIMARY KEY, orderId TEXT, productId TEXT, productName TEXT, quantity INTEGER, unitPrice INTEGER, costPrice INTEGER, discountId TEXT, discountAmount INTEGER, taxRate REAL, taxAmount INTEGER, lineTotal INTEGER, isPriceOverride INTEGER, originalPrice INTEGER, notes TEXT, updatedAt TEXT)",
            "CREATE TABLE payments (id TEXT PRIMARY KEY, orderId TEXT, method TEXT, amount INTEGER, cashAmount INTEGER, cardAmount INTEGER, loyaltyAmount INTEGER DEFAULT 0, accountAmount INTEGER DEFAULT 0, tipsAmount INTEGER NOT NULL DEFAULT 0, serviceChargeAmount INTEGER NOT NULL DEFAULT 0, cashbackAmount INTEGER NOT NULL DEFAULT 0, reference TEXT, changeGiven INTEGER, createdAt TEXT, updatedAt TEXT)",
            "CREATE TABLE products (id TEXT PRIMARY KEY, stockLevel INTEGER, updatedAt TEXT)",
            "CREATE TABLE inventory_logs (id TEXT PRIMARY KEY, productId TEXT, quantityChange INTEGER, type TEXT, referenceId TEXT, employeeId TEXT, notes TEXT, createdAt TEXT, updatedAt TEXT)",
            "CREATE TABLE audit_logs (id TEXT PRIMARY KEY, employeeId TEXT, action TEXT, entityType TEXT, entityId TEXT, oldData TEXT, newData TEXT, createdAt TEXT, updatedAt TEXT)",
            "CREATE TABLE customers (id TEXT PRIMARY KEY, loyaltyPoints INTEGER, updatedAt TEXT)",
            "CREATE TABLE customer_accounts (id TEXT PRIMARY KEY, customerId TEXT NOT NULL UNIQUE, isEnabled INTEGER NOT NULL DEFAULT 0, creditLimitPence INTEGER NOT NULL DEFAULT 0, balancePence INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)",
            "CREATE TABLE customer_account_entries (id TEXT PRIMARY KEY, accountId TEXT NOT NULL, customerId TEXT NOT NULL, orderId TEXT NOT NULL DEFAULT '', entryType TEXT NOT NULL, amountPence INTEGER NOT NULL, paymentMethod TEXT NOT NULL DEFAULT '', tipsAmount INTEGER NOT NULL DEFAULT 0, serviceChargeAmount INTEGER NOT NULL DEFAULT 0, cashbackAmount INTEGER NOT NULL DEFAULT 0, reference TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', receiptNumber INTEGER NOT NULL DEFAULT 0, receiptKey TEXT NOT NULL DEFAULT '', employeeId TEXT NOT NULL DEFAULT '', tillNumber TEXT NOT NULL DEFAULT '', shiftId TEXT NOT NULL DEFAULT '', idempotencyKey TEXT NOT NULL UNIQUE, reversesEntryId TEXT NOT NULL DEFAULT '', balanceAfterPence INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)",
            "CREATE TABLE loyalty_logs (id TEXT PRIMARY KEY, customerId TEXT, orderId TEXT, pointsChange INTEGER, reason TEXT, createdAt TEXT, updatedAt TEXT)",
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updatedAt TEXT)",
            "CREATE TABLE till_report_markers (id TEXT PRIMARY KEY, tillNumber TEXT, markerTime TEXT)",
            "CREATE TABLE stock_receipts (id TEXT PRIMARY KEY, supplierId TEXT, employeeId TEXT, reference TEXT, notes TEXT, totalCost INTEGER, status TEXT, createdAt TEXT, updatedAt TEXT)",
            "CREATE TABLE stock_receipt_lines (id TEXT PRIMARY KEY, receiptId TEXT, productId TEXT, quantity INTEGER, unitCost INTEGER, createdAt TEXT, updatedAt TEXT)",
            "CREATE TABLE _offline_queue (id TEXT PRIMARY KEY, table_name TEXT, operation TEXT, data TEXT, id_key TEXT, created_at TEXT, attempt_count INTEGER DEFAULT 0, last_error TEXT DEFAULT '', next_attempt_at TEXT DEFAULT '')",
        ] {
            sqlx::query(sql).execute(&pool).await.unwrap();
        }
        sqlx::query("INSERT INTO products (id, stockLevel) VALUES ('product-1', 10)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO customers (id, loyaltyPoints) VALUES ('customer-1', 150)")
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    async fn install_loyalty_adjustment_test_actor(
        pool: &SqlitePool,
        id: &str,
        role: &str,
        is_active: bool,
        updated_at: &str,
    ) {
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS employees (
                id TEXT PRIMARY KEY, role TEXT, isActive INTEGER, updatedAt TEXT
             )",
        )
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO employees (id, role, isActive, updatedAt)
             VALUES (?, ?, ?, ?)",
        )
        .bind(id)
        .bind(role)
        .bind(if is_active { 1 } else { 0 })
        .bind(updated_at)
        .execute(pool)
        .await
        .unwrap();
    }

    fn loyalty_adjustment_input(
        id: &str,
        expected_points: i64,
        new_points: i64,
    ) -> CustomerLoyaltyAdjustmentInput {
        CustomerLoyaltyAdjustmentInput {
            id: id.into(),
            customer_id: "customer-1".into(),
            expected_points,
            new_points,
            reason: "Correct an earlier points mistake".into(),
            employee_id: "admin-1".into(),
            actor_expected_updated_at: "2026-09-04T12:00:00.000Z".into(),
            created_at: "2026-09-04T12:05:00.000Z".into(),
            server_data_epoch: String::new(),
        }
    }

    #[test]
    fn loyalty_adjustment_validation_and_permissions_match_the_renderer_policy() {
        let mut valid = loyalty_adjustment_input("adjust-validation", 150, 125);
        valid.reason = "ڕاستکردنەوە".repeat(20);
        assert!(normalize_customer_loyalty_adjustment_input(valid).is_ok());

        let mut short_reason = loyalty_adjustment_input("adjust-short", 150, 125);
        short_reason.reason = "no".into();
        assert!(normalize_customer_loyalty_adjustment_input(short_reason).is_err());
        let mut long_reason = loyalty_adjustment_input("adjust-long", 150, 125);
        long_reason.reason = "ڕ".repeat(241);
        assert!(normalize_customer_loyalty_adjustment_input(long_reason).is_err());
        let mut negative = loyalty_adjustment_input("adjust-negative", 150, -1);
        assert!(normalize_customer_loyalty_adjustment_input(negative.clone()).is_err());
        negative.new_points = MAX_LOYALTY_POINTS + 1;
        assert!(normalize_customer_loyalty_adjustment_input(negative).is_err());

        let negative_start = loyalty_adjustment_input("adjust-refund-debt", -100, 0);
        assert!(normalize_customer_loyalty_adjustment_input(negative_start).is_ok());
        for (expected, corrected) in [
            (i32::MIN as i64 - 1, 0),
            (i32::MIN as i64, 0), // balance fits, but movement overflows the ledger
            (-100, MAX_LOYALTY_POINTS),
            (-100, -1),
            (i64::MIN, i64::MAX),
        ] {
            assert!(normalize_customer_loyalty_adjustment_input(
                loyalty_adjustment_input("adjust-range", expected, corrected),
            ).is_err(), "{expected} -> {corrected}");
        }

        assert!(configured_role_can_adjust_customer_loyalty(
            " manager ",
            None
        ));
        assert!(configured_role_can_adjust_customer_loyalty(
            "manager",
            Some("not-json")
        ));
        assert!(!configured_role_can_adjust_customer_loyalty(
            "manager",
            Some(r#"{"version":6,"roles":{"manager":["open_customers"]}}"#)
        ));
        assert!(configured_role_can_adjust_customer_loyalty(
            "manager",
            Some(
                r#"{"version":7,"roles":{"manager":["open_customers","adjust_customer_loyalty"]}}"#
            )
        ));
        assert!(configured_role_can_adjust_customer_loyalty(
            "admin",
            Some(r#"{"roles":{"admin":[]}}"#)
        ));
        assert!(!configured_role_can_adjust_customer_loyalty(
            "attendance",
            Some(r#"{"roles":{"attendance":["adjust_customer_loyalty"]}}"#)
        ));
    }

    #[test]
    fn local_loyalty_adjustment_repairs_refund_debt_with_cas_and_idempotency() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool().await;
            install_loyalty_adjustment_test_actor(
                &pool, "admin-1", "admin", true, "2026-09-04T12:00:00.000Z",
            ).await;
            // The sale/refund ledger may legitimately become negative once
            // earned points have been spent before their sale is refunded.
            sqlx::query("UPDATE customers SET loyaltyPoints = -100 WHERE id = 'customer-1'")
                .execute(&pool).await.unwrap();
            let stale = normalize_customer_loyalty_adjustment_input(
                loyalty_adjustment_input("adjust-stale-negative", -99, 0),
            ).unwrap();
            assert!(adjust_sqlite_customer_loyalty(&pool, &stale).await.unwrap_err()
                .to_string().contains("CUSTOMER_LOYALTY_CONFLICT"));
            let input = normalize_customer_loyalty_adjustment_input(
                loyalty_adjustment_input("adjust-refund-debt", -100, 0),
            ).unwrap();
            let first = adjust_sqlite_customer_loyalty(&pool, &input).await.unwrap();
            assert_eq!(first.loyalty_points, 0);
            assert_eq!(first.entry.points_change, 100);
            assert_eq!(serde_json::from_str::<serde_json::Value>(&first.audit.old_data).unwrap()["loyaltyPoints"], -100);
            let replay = adjust_sqlite_customer_loyalty(&pool, &input).await.unwrap();
            assert_eq!(replay.entry, first.entry);
            assert_eq!(replay.audit, first.audit);
            let mut changed_retry = input;
            changed_retry.new_points = 25;
            assert!(adjust_sqlite_customer_loyalty(&pool, &changed_retry).await.unwrap_err()
                .to_string().contains("CUSTOMER_LOYALTY_IDEMPOTENCY_CONFLICT"));
            let counts: (i64, i64, i64) = sqlx::query_as(
                "SELECT (SELECT loyaltyPoints FROM customers WHERE id = 'customer-1'),
                        (SELECT COUNT(*) FROM loyalty_logs), (SELECT COUNT(*) FROM audit_logs)",
            ).fetch_one(&pool).await.unwrap();
            assert_eq!(counts, (0, 1, 1));
            pool.close().await;
        });
    }

    #[test]
    fn local_loyalty_adjustment_is_atomic_audited_and_retry_safe() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool().await;
            install_loyalty_adjustment_test_actor(
                &pool,
                "admin-1",
                "admin",
                true,
                "2026-09-04T12:00:00.000Z",
            )
            .await;
            let input = loyalty_adjustment_input("adjust-success", 150, 25);
            let first = adjust_sqlite_customer_loyalty(&pool, &input).await.unwrap();
            assert_eq!(first.customer_id, "customer-1");
            assert_eq!(first.loyalty_points, 25);
            assert_eq!(first.entry.points_change, -125);
            assert_eq!(first.entry.order_id, "");
            assert_eq!(
                first.entry.reason,
                "manual_adjustment: Correct an earlier points mistake"
            );
            assert_eq!(first.audit.action, "customer_loyalty_adjusted");
            assert_eq!(first.audit.entity_type, "customer");
            assert_eq!(first.audit.employee_id, "admin-1");

            let mut retry = input.clone();
            retry.created_at = "2026-09-04T12:06:00.000Z".into();
            retry.actor_expected_updated_at = "a retry need not reuse an auth snapshot".into();
            let replay = adjust_sqlite_customer_loyalty(&pool, &retry).await.unwrap();
            assert_eq!(replay.entry, first.entry);
            assert_eq!(replay.audit, first.audit);
            assert_eq!(replay.loyalty_points, 25);

            let customer_points: i64 =
                sqlx::query_scalar("SELECT loyaltyPoints FROM customers WHERE id = 'customer-1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            let loyalty_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM loyalty_logs WHERE id = 'adjust-success'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            let audit_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM audit_logs WHERE id = 'adjust-success'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!((customer_points, loyalty_count, audit_count), (25, 1, 1));

            let mut mismatched = retry;
            mismatched.reason = "A different correction".into();
            let error = adjust_sqlite_customer_loyalty(&pool, &mismatched)
                .await
                .unwrap_err()
                .to_string();
            assert!(error.contains("CUSTOMER_LOYALTY_IDEMPOTENCY_CONFLICT"));
            pool.close().await;
        });
    }

    #[test]
    fn local_loyalty_adjustment_rolls_back_conflicts_and_unauthorized_changes() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool().await;
            install_loyalty_adjustment_test_actor(
                &pool,
                "admin-1",
                "admin",
                true,
                "2026-09-04T12:00:00.000Z",
            )
            .await;

            let stale = loyalty_adjustment_input("adjust-stale", 149, 10);
            let stale_error = adjust_sqlite_customer_loyalty(&pool, &stale)
                .await
                .unwrap_err()
                .to_string();
            assert!(stale_error.contains("CUSTOMER_LOYALTY_CONFLICT"));

            let mut stale_actor = loyalty_adjustment_input("adjust-stale-actor", 150, 10);
            stale_actor.actor_expected_updated_at = "2026-09-04T11:00:00.000Z".into();
            let actor_error = adjust_sqlite_customer_loyalty(&pool, &stale_actor)
                .await
                .unwrap_err()
                .to_string();
            assert!(actor_error.contains("CUSTOMER_LOYALTY_ACTOR_STALE"));

            sqlx::query(
                "INSERT INTO audit_logs
                    (id, employeeId, action, entityType, entityId,
                     oldData, newData, createdAt, updatedAt)
                 VALUES ('adjust-audit-collision', 'someone-else', 'other_action',
                         'other', 'other', '{}', '{}', '', '')",
            )
            .execute(&pool)
            .await
            .unwrap();
            let collision = loyalty_adjustment_input("adjust-audit-collision", 150, 10);
            let collision_error = adjust_sqlite_customer_loyalty(&pool, &collision)
                .await
                .unwrap_err()
                .to_string();
            assert!(collision_error.contains("CUSTOMER_LOYALTY_IDEMPOTENCY_CONFLICT"));

            let customer_points: i64 =
                sqlx::query_scalar("SELECT loyaltyPoints FROM customers WHERE id = 'customer-1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            let loyalty_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM loyalty_logs")
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!((customer_points, loyalty_count), (150, 0));
            pool.close().await;
        });
    }

    #[test]
    fn manual_loyalty_history_survives_receipt_history_purge() {
        tauri::async_runtime::block_on(async {
            let pool = purge_test_pool().await;
            install_loyalty_adjustment_test_actor(
                &pool,
                "admin-1",
                "admin",
                true,
                "2026-09-04T12:00:00.000Z",
            )
            .await;
            let input = loyalty_adjustment_input("adjust-survives-purge", 150, 125);
            adjust_sqlite_customer_loyalty(&pool, &input).await.unwrap();

            purge_sqlite_transactions_before(&pool, "2026-09-05T00:00:00.000Z", &[], false)
                .await
                .unwrap();
            let customer_points: i64 =
                sqlx::query_scalar("SELECT loyaltyPoints FROM customers WHERE id = 'customer-1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            let loyalty_count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM loyalty_logs WHERE id = 'adjust-survives-purge'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            let audit_count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM audit_logs WHERE id = 'adjust-survives-purge'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!((customer_points, loyalty_count, audit_count), (125, 1, 1));
            pool.close().await;
        });
    }

    async fn purge_test_pool() -> SqlitePool {
        let pool = test_pool().await;
        for sql in [
            "CREATE TABLE registers (id TEXT PRIMARY KEY)",
            "CREATE TABLE shifts (id TEXT PRIMARY KEY, registerId TEXT, openedAt TEXT)",
            "CREATE TABLE cash_movements (id TEXT PRIMARY KEY, shiftId TEXT, createdAt TEXT)",
            "CREATE TABLE manager_approvals (id TEXT PRIMARY KEY, entityId TEXT, entityType TEXT, action TEXT, createdAt TEXT)",
            "CREATE TABLE payment_terminal_attempts (id TEXT PRIMARY KEY, status TEXT, createdAt TEXT)",
            "CREATE TABLE daily_sales_summary (id TEXT PRIMARY KEY)",
            "CREATE TABLE tombstones (id TEXT PRIMARY KEY, table_name TEXT, deletedAt TEXT)",
            "ALTER TABLE till_report_markers ADD COLUMN type TEXT",
            "ALTER TABLE till_report_markers ADD COLUMN periodStart TEXT",
            "ALTER TABLE till_report_markers ADD COLUMN periodEnd TEXT",
            "ALTER TABLE till_report_markers ADD COLUMN employeeId TEXT",
            "ALTER TABLE till_report_markers ADD COLUMN reportText TEXT",
            "ALTER TABLE till_report_markers ADD COLUMN reportTotal INTEGER",
            "ALTER TABLE till_report_markers ADD COLUMN createdAt TEXT",
            "ALTER TABLE till_report_markers ADD COLUMN updatedAt TEXT",
        ] {
            sqlx::query(sql).execute(&pool).await.unwrap();
        }
        pool
    }

    async fn cleanup_mariadb_customer_delete_fixture(
        pool: &MySqlPool,
        customer_id: &str,
        order_id: &str,
        product_id: &str,
    ) {
        ensure_mysql_account_ledger_guards(pool).await.unwrap();
        let mut row_ids: Vec<String> = sqlx::query_scalar(
            "SELECT CAST(id AS CHAR) FROM payments WHERE orderId = ?
             UNION SELECT CAST(id AS CHAR) FROM order_lines WHERE orderId = ?
             UNION SELECT CAST(id AS CHAR) FROM inventory_logs WHERE referenceId = ?
             UNION SELECT CAST(id AS CHAR) FROM audit_logs WHERE entityId = ?
             UNION SELECT CAST(id AS CHAR) FROM loyalty_logs WHERE customerId = ?
             UNION SELECT CAST(id AS CHAR) FROM customer_account_entries WHERE customerId = ?
             UNION SELECT CAST(id AS CHAR) FROM customer_accounts WHERE customerId = ?",
        )
        .bind(order_id)
        .bind(order_id)
        .bind(order_id)
        .bind(order_id)
        .bind(customer_id)
        .bind(customer_id)
        .bind(customer_id)
        .fetch_all(pool)
        .await
        .unwrap();
        row_ids.extend([
            customer_id.to_string(),
            order_id.to_string(),
            product_id.to_string(),
        ]);
        let mut tx = pool.begin().await.unwrap();
        let account_authority = grant_mysql_account_write_authority(&mut tx).await.unwrap();
        for (sql, value) in [
            ("DELETE FROM audit_logs WHERE entityId = ?", order_id),
            ("DELETE FROM inventory_logs WHERE referenceId = ?", order_id),
            ("DELETE FROM payments WHERE orderId = ?", order_id),
            ("DELETE FROM order_lines WHERE orderId = ?", order_id),
            ("DELETE FROM orders WHERE id = ?", order_id),
            ("DELETE FROM loyalty_logs WHERE customerId = ?", customer_id),
            (
                "DELETE FROM customer_account_entries WHERE customerId = ?",
                customer_id,
            ),
            (
                "DELETE FROM customer_accounts WHERE customerId = ?",
                customer_id,
            ),
            ("DELETE FROM customers WHERE id = ?", customer_id),
            ("DELETE FROM products WHERE id = ?", product_id),
        ] {
            sqlx::query(sql)
                .bind(value)
                .execute(&mut *tx)
                .await
                .unwrap();
        }
        revoke_mysql_account_write_authority(&mut tx, &account_authority)
            .await
            .unwrap();
        for row_id in row_ids {
            sqlx::query("DELETE FROM tombstones WHERE row_id = ?")
                .bind(row_id)
                .execute(&mut *tx)
                .await
                .unwrap();
        }
        sqlx::query("DELETE FROM pos_customer_write_locks WHERE customerId = ?")
            .bind(customer_id)
            .execute(&mut *tx)
            .await
            .unwrap();
        tx.commit().await.unwrap();
    }

    async fn configured_mariadb_server_epoch(pool: &MySqlPool) -> String {
        sqlx::query_scalar(
            "SELECT CAST(COALESCE((SELECT value FROM settings
                                   WHERE `key` = 'server_data_epoch' LIMIT 1), '') AS CHAR)",
        )
        .fetch_one(pool)
        .await
        .unwrap()
    }

    /// Provision only the application-owned base tables exercised by the
    /// configured MariaDB integration tests. Production still owns schema
    /// creation; this helper makes each opt-in test independent of test order
    /// and able to run against a freshly created disposable database.
    async fn ensure_real_mariadb_test_base_schema(pool: &MySqlPool) -> Result<(), sqlx::Error> {
        for sql in [
            "CREATE TABLE IF NOT EXISTS pos_schema_migrations (
                name VARCHAR(191) PRIMARY KEY,
                appliedAt VARCHAR(40) NOT NULL
             ) ENGINE=InnoDB",
            "CREATE TABLE IF NOT EXISTS settings (
                `key` VARCHAR(191) PRIMARY KEY,
                value TEXT,
                updatedAt TEXT
             ) ENGINE=InnoDB",
            "CREATE TABLE IF NOT EXISTS registers (
                id VARCHAR(64) PRIMARY KEY,
                storeId VARCHAR(64),
                name VARCHAR(255) NOT NULL DEFAULT '',
                isActive TINYINT NOT NULL DEFAULT 1,
                createdAt TEXT,
                updatedAt TEXT
             ) ENGINE=InnoDB",
            "CREATE TABLE IF NOT EXISTS till_presence (
                tillId VARCHAR(64) PRIMARY KEY,
                tillName VARCHAR(255) NOT NULL,
                lastSeenAt DATETIME(3) NOT NULL
             ) ENGINE=InnoDB",
            "CREATE TABLE IF NOT EXISTS customers (
                id VARCHAR(64) PRIMARY KEY,
                name TEXT NOT NULL,
                phone TEXT,
                email TEXT,
                postcode TEXT,
                loyaltyCode VARCHAR(32),
                loyaltyPoints BIGINT NOT NULL DEFAULT 0,
                notes TEXT,
                createdAt TEXT,
                updatedAt TEXT
             ) ENGINE=InnoDB",
            "CREATE TABLE IF NOT EXISTS products (
                id VARCHAR(64) PRIMARY KEY,
                categoryId VARCHAR(64),
                taxRateId VARCHAR(64),
                name TEXT NOT NULL,
                sku VARCHAR(191),
                barcode VARCHAR(191),
                scalePlu VARCHAR(191),
                price BIGINT NOT NULL DEFAULT 0,
                costPrice BIGINT NOT NULL DEFAULT 0,
                stockLevel BIGINT NOT NULL DEFAULT 0,
                trackStock TINYINT NOT NULL DEFAULT 0,
                allowPriceOverride TINYINT NOT NULL DEFAULT 0,
                isAgeRestricted TINYINT NOT NULL DEFAULT 0,
                isWeighable TINYINT NOT NULL DEFAULT 0,
                showInGoods TINYINT NOT NULL DEFAULT 0,
                goodsSortOrder BIGINT NOT NULL DEFAULT 0,
                color TEXT,
                image MEDIUMTEXT,
                isActive TINYINT NOT NULL DEFAULT 1,
                createdAt TEXT,
                updatedAt TEXT
             ) ENGINE=InnoDB",
            "CREATE TABLE IF NOT EXISTS customer_accounts (
                id VARCHAR(64) PRIMARY KEY,
                customerId VARCHAR(64) NOT NULL UNIQUE,
                isEnabled TINYINT NOT NULL DEFAULT 0,
                creditLimitPence BIGINT NOT NULL DEFAULT 0,
                balancePence BIGINT NOT NULL DEFAULT 0,
                createdAt TEXT NOT NULL,
                updatedAt TEXT NOT NULL
             ) ENGINE=InnoDB",
            "CREATE TABLE IF NOT EXISTS customer_account_entries (
                id VARCHAR(64) PRIMARY KEY,
                accountId VARCHAR(64) NOT NULL DEFAULT '',
                customerId VARCHAR(64) NOT NULL DEFAULT '',
                orderId VARCHAR(64) NOT NULL DEFAULT '',
                entryType VARCHAR(32) NOT NULL DEFAULT 'adjustment',
                amountPence BIGINT NOT NULL DEFAULT 0,
                paymentMethod VARCHAR(16) NOT NULL DEFAULT '',
                tipsAmount BIGINT NOT NULL DEFAULT 0,
                serviceChargeAmount BIGINT NOT NULL DEFAULT 0,
                cashbackAmount BIGINT NOT NULL DEFAULT 0,
                reference TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '',
                receiptNumber BIGINT NOT NULL DEFAULT 0,
                receiptKey VARCHAR(100) NOT NULL DEFAULT '',
                employeeId VARCHAR(64) NOT NULL DEFAULT '',
                tillNumber VARCHAR(64) NOT NULL DEFAULT '',
                shiftId VARCHAR(64) NOT NULL DEFAULT '',
                idempotencyKey VARCHAR(191) NULL UNIQUE,
                reversesEntryId VARCHAR(64) NOT NULL DEFAULT '',
                balanceAfterPence BIGINT NOT NULL DEFAULT 0,
                createdAt TEXT NOT NULL,
                updatedAt TEXT NULL
             ) ENGINE=InnoDB",
            "CREATE TABLE IF NOT EXISTS orders (
                id VARCHAR(64) PRIMARY KEY,
                shiftId VARCHAR(64),
                customerId VARCHAR(64),
                employeeId VARCHAR(64),
                orderNumber BIGINT NOT NULL DEFAULT 0,
                receiptKey VARCHAR(100) NULL UNIQUE,
                type VARCHAR(32) NOT NULL DEFAULT 'sale',
                status VARCHAR(32) NOT NULL DEFAULT 'completed',
                originalOrderId VARCHAR(64),
                subtotal BIGINT NOT NULL DEFAULT 0,
                discountId VARCHAR(64),
                discountAmount BIGINT NOT NULL DEFAULT 0,
                taxTotal BIGINT NOT NULL DEFAULT 0,
                total BIGINT NOT NULL DEFAULT 0,
                tillNumber VARCHAR(64) NOT NULL DEFAULT '',
                notes TEXT,
                paymentMethod VARCHAR(32) NOT NULL DEFAULT '',
                amountTendered BIGINT NOT NULL DEFAULT 0,
                createdAt TEXT,
                completedAt TEXT,
                updatedAt TEXT
             ) ENGINE=InnoDB",
            "CREATE TABLE IF NOT EXISTS order_lines (
                id VARCHAR(64) PRIMARY KEY,
                orderId VARCHAR(64),
                productId VARCHAR(64),
                productName TEXT,
                quantity BIGINT NOT NULL DEFAULT 0,
                unitPrice BIGINT NOT NULL DEFAULT 0,
                costPrice BIGINT NOT NULL DEFAULT 0,
                discountId VARCHAR(64),
                discountAmount BIGINT NOT NULL DEFAULT 0,
                taxRate DOUBLE NOT NULL DEFAULT 0,
                taxAmount BIGINT NOT NULL DEFAULT 0,
                lineTotal BIGINT NOT NULL DEFAULT 0,
                isPriceOverride TINYINT NOT NULL DEFAULT 0,
                originalPrice BIGINT NOT NULL DEFAULT 0,
                notes TEXT,
                updatedAt TEXT
             ) ENGINE=InnoDB",
            "CREATE TABLE IF NOT EXISTS payments (
                id VARCHAR(64) PRIMARY KEY,
                orderId VARCHAR(64),
                method VARCHAR(32),
                amount BIGINT NOT NULL DEFAULT 0,
                cashAmount BIGINT NOT NULL DEFAULT 0,
                cardAmount BIGINT NOT NULL DEFAULT 0,
                loyaltyAmount BIGINT NOT NULL DEFAULT 0,
                accountAmount BIGINT NOT NULL DEFAULT 0,
                tipsAmount BIGINT NOT NULL DEFAULT 0,
                serviceChargeAmount BIGINT NOT NULL DEFAULT 0,
                cashbackAmount BIGINT NOT NULL DEFAULT 0,
                reference TEXT,
                changeGiven BIGINT NOT NULL DEFAULT 0,
                createdAt TEXT,
                updatedAt TEXT
             ) ENGINE=InnoDB",
            "CREATE TABLE IF NOT EXISTS inventory_logs (
                id VARCHAR(64) PRIMARY KEY,
                productId VARCHAR(64),
                quantityChange BIGINT NOT NULL DEFAULT 0,
                type VARCHAR(32),
                referenceId VARCHAR(64),
                employeeId VARCHAR(64),
                notes TEXT,
                createdAt TEXT,
                updatedAt TEXT
             ) ENGINE=InnoDB",
            "CREATE TABLE IF NOT EXISTS loyalty_logs (
                id VARCHAR(64) PRIMARY KEY,
                customerId VARCHAR(64),
                orderId VARCHAR(64),
                pointsChange BIGINT NOT NULL DEFAULT 0,
                reason TEXT,
                createdAt TEXT,
                updatedAt TEXT
             ) ENGINE=InnoDB",
            "CREATE TABLE IF NOT EXISTS audit_logs (
                id VARCHAR(64) PRIMARY KEY,
                employeeId VARCHAR(64),
                action TEXT,
                entityType TEXT,
                entityId VARCHAR(191),
                oldData MEDIUMTEXT,
                newData MEDIUMTEXT,
                createdAt TEXT,
                updatedAt TEXT
             ) ENGINE=InnoDB",
            "CREATE TABLE IF NOT EXISTS tombstones (
                id VARCHAR(191) PRIMARY KEY,
                table_name VARCHAR(64) NOT NULL,
                row_id VARCHAR(191) NOT NULL,
                deletedAt TEXT,
                updatedAt TEXT
             ) ENGINE=InnoDB",
            "CREATE TABLE IF NOT EXISTS till_report_markers (
                id VARCHAR(64) PRIMARY KEY,
                tillNumber VARCHAR(64) NOT NULL,
                type VARCHAR(32) NOT NULL,
                markerTime TEXT NOT NULL,
                periodStart TEXT,
                periodEnd TEXT,
                employeeId VARCHAR(64),
                reportText TEXT,
                reportTotal BIGINT NOT NULL DEFAULT 0,
                createdAt TEXT,
                updatedAt TEXT
             ) ENGINE=InnoDB",
            "CREATE TABLE IF NOT EXISTS payment_terminal_attempts (
                id VARCHAR(191) PRIMARY KEY,
                status VARCHAR(32) NOT NULL,
                createdAt TEXT,
                updatedAt TEXT
             ) ENGINE=InnoDB",
        ] {
            sqlx::query(sql).execute(pool).await?;
        }
        for table in ["payments", "customer_account_entries"] {
            for column in ["tipsAmount", "serviceChargeAmount", "cashbackAmount"] {
                sqlx::query(&format!(
                    "ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {column} BIGINT NOT NULL DEFAULT 0"
                ))
                .execute(pool)
                .await?;
            }
        }
        sqlx::query(
            "INSERT IGNORE INTO pos_schema_migrations (name, appliedAt)
             VALUES (?, 'test-fixture')",
        )
        .bind(MYSQL_IDENTIFIER_COLLATION_MIGRATION)
        .execute(pool)
        .await?;
        Ok(())
    }

    async fn configured_mariadb_report_epoch(pool: &MySqlPool) -> String {
        let value: Option<String> = sqlx::query_scalar(
            "SELECT CAST(DATE_FORMAT(lastClosedAt, '%Y-%m-%dT%H:%i:%s.%fZ')
                         AS CHAR CHARACTER SET utf8mb4)
             FROM pos_close_barrier WHERE id = 1",
        )
        .fetch_optional(pool)
        .await
        .unwrap()
        .flatten();
        canonical_report_epoch(value.as_deref().unwrap_or("")).unwrap()
    }

    #[test]
    fn restore_repair_removes_only_orphan_transaction_children() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool().await;
            sqlx::query("INSERT INTO orders (id) VALUES ('order-1')")
                .execute(&pool)
                .await
                .unwrap();
            for sql in [
                "INSERT INTO order_lines (id, orderId) VALUES ('line-valid', 'order-1')",
                "INSERT INTO order_lines (id, orderId) VALUES ('line-orphan', 'missing-order')",
                "INSERT INTO payments (id, orderId) VALUES ('payment-valid', 'order-1')",
                "INSERT INTO payments (id, orderId) VALUES ('payment-orphan', 'missing-order')",
            ] {
                sqlx::query(sql).execute(&pool).await.unwrap();
            }

            repair_restore_pool(&pool).await.unwrap();

            let line_ids: Vec<String> =
                sqlx::query_scalar("SELECT id FROM order_lines ORDER BY id")
                    .fetch_all(&pool)
                    .await
                    .unwrap();
            let payment_ids: Vec<String> =
                sqlx::query_scalar("SELECT id FROM payments ORDER BY id")
                    .fetch_all(&pool)
                    .await
                    .unwrap();
            assert_eq!(line_ids, vec!["line-valid"]);
            assert_eq!(payment_ids, vec!["payment-valid"]);
            pool.close().await;
        });
    }

    fn bundle(id: &str, receipt: &str, payment: &str) -> SaleBundle {
        let stamp = "2026-06-07T12:00:00.000Z".to_string();
        SaleBundle {
            report_epoch: String::new(),
            server_data_epoch: String::new(),
            order: OrderRecord {
                id: id.into(),
                shift_id: "shift".into(),
                customer_id: "".into(),
                employee_id: "employee".into(),
                order_number: 1,
                receipt_key: receipt.into(),
                order_type: "sale".into(),
                status: "completed".into(),
                original_order_id: "".into(),
                subtotal: 100,
                discount_id: "".into(),
                discount_amount: 0,
                tax_total: 17,
                total: 100,
                till_number: receipt.into(),
                notes: "".into(),
                payment_method: "cash".into(),
                amount_tendered: 100,
                created_at: stamp.clone(),
                completed_at: stamp.clone(),
                updated_at: stamp.clone(),
            },
            lines: vec![OrderLineRecord {
                id: format!("line-{id}"),
                order_id: id.into(),
                product_id: "product-1".into(),
                product_name: "Product".into(),
                quantity: 1,
                unit_price: 100,
                cost_price: 40,
                discount_id: "".into(),
                discount_amount: 0,
                tax_rate: 0.2,
                tax_amount: 17,
                line_total: 100,
                is_price_override: false,
                original_price: 100,
                notes: "".into(),
                updated_at: stamp.clone(),
            }],
            payment: PaymentRecord {
                id: payment.into(),
                order_id: id.into(),
                method: "cash".into(),
                amount: 100,
                cash_amount: 100,
                card_amount: 0,
                tips_amount: 0,
                service_charge_amount: 0,
                cashback_amount: 0,
                loyalty_amount: 0,
                account_amount: 0,
                reference: "".into(),
                change_given: 0,
                created_at: stamp.clone(),
                updated_at: stamp.clone(),
            },
            stock_changes: vec![StockChange {
                product_id: "product-1".into(),
                delta: -1,
                log_id: format!("log-{id}"),
                employee_id: "employee".into(),
                notes: "sale".into(),
                movement_type: "sale".into(),
            }],
            loyalty_changes: vec![],
            account_changes: vec![],
            audit: AuditRecord {
                id: format!("audit-{id}"),
                employee_id: "employee".into(),
                action: "sale_completed".into(),
                entity_type: "order".into(),
                entity_id: id.into(),
                old_data: "".into(),
                new_data: "".into(),
                created_at: stamp,
            },
            original_order_to_update: None,
            original_status_update: None,
        }
    }

    #[test]
    fn held_order_protocol_accepts_only_unpaid_hold_rows() {
        let mut sale = bundle("held-order", "", "unused-payment");
        sale.order.order_number = 0;
        sale.order.status = "hold".into();
        sale.order.payment_method.clear();
        sale.order.amount_tendered = 0;
        sale.order.completed_at.clear();
        assert!(validate_held_order_record(&sale.order).is_ok());
        assert!(validate_held_order_line_record(&sale.lines[0]).is_ok());

        let mut sqlite_snapshot = serde_json::to_value(&sale.order).unwrap();
        sqlite_snapshot["receiptKey"] = serde_json::Value::Null;
        sqlite_snapshot["customerId"] = serde_json::json!("selected-customer");
        let decoded = decode_held_order(&sqlite_snapshot).unwrap();
        assert!(validate_held_order_record(&decoded).is_ok());
        assert_eq!(decoded.customer_id, "selected-customer");
        sqlite_snapshot["id"] = serde_json::Value::Null;
        assert!(decode_held_order(&sqlite_snapshot).is_err());

        sale.order.receipt_key = "till-1:42".into();
        assert!(validate_held_order_record(&sale.order).is_err());
        sale.order.receipt_key.clear();
        sale.order.status = "completed".into();
        assert!(validate_held_order_record(&sale.order).is_err());
    }

    #[test]
    fn real_mariadb_held_claim_retry_keeps_one_owner_when_configured() {
        let Ok(uri) = std::env::var("POS_TEST_MYSQL_URI") else { return; };
        assert!(uri.contains("pos_audit_") || uri.contains("pos_test_"), "Use a disposable database");
        let _serial = REAL_MARIADB_TEST_LOCK.lock().unwrap();
        tauri::async_runtime::block_on(async {
            let pool = MySqlPool::connect(&uri).await.unwrap();
            ensure_mysql_restore_guard_schema(&pool).await.unwrap();
            ensure_mysql_whole_system_close_schema(&pool).await.unwrap();
            let epoch = configured_mariadb_server_epoch(&pool).await;
            let id = format!("hold-test-{:016x}", rand::random::<u64>());
            let mut sale = bundle(&id, "", "unused-payment");
            // Use the normal first-administrator workflow, including credential
            // validation and write-authority triggers, on this empty test DB.
            let employee_id = "held-recovery-test-admin";
            let existing: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM employees WHERE id = ?")
                .bind(employee_id).fetch_one(&pool).await.unwrap();
            if existing == 0 {
                let test_hash = concat!("pbkdf2-sha256$210000$AAAAAAAAAAAAAAAAAAAAAA==$",
                    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
                save_mariadb_employee_profile_cas(uri.clone(),
                    test_employee(employee_id, "admin", "", test_hash), None,
                    String::new(), String::new()).await.unwrap();
            }
            sale.order.employee_id = employee_id.into();
            sale.order.order_number = 0;
            sale.order.status = "hold".into();
            sale.order.payment_method.clear();
            sale.order.amount_tendered = 0;
            sale.order.completed_at.clear();
            // Exercise the REAL full SQLite-shaped payload (including the NULL
            // receipt field that caused the regression), not just a typed header.
            let mut payload = serde_json::json!({"order": sale.order, "lines": sale.lines});
            payload["order"]["receiptKey"] = serde_json::Value::Null;
            let mut tx = pool.begin().await.unwrap();
            mysql_epoch_fenced_held_order_bundle(&mut tx, &payload).await.unwrap();
            let visible: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM orders WHERE id = ?")
                .bind(&id).fetch_one(&pool).await.unwrap();
            assert_eq!(visible, 0, "Other tills must not see the header before all lines commit");
            tx.commit().await.unwrap();
            // A lost upload response is safely replayed without duplicating
            // lines or treating the server timestamp as a competing edit.
            execute_mysql_epoch_fenced_outbox_operation(&pool, "orders", "heldOrderBundle", &payload, "id", &epoch).await.unwrap();
            let line_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM order_lines WHERE orderId = ?")
                .bind(&id).fetch_one(&pool).await.unwrap();
            assert_eq!(line_count, 1);
            // Multiple unpaid holds must coexist under the unique receipt-key
            // index: MariaDB stores SQL NULL, not a shared empty receipt string.
            let second_id = format!("hold-test-{:016x}", rand::random::<u64>());
            let mut second = payload.clone();
            second["order"]["id"] = serde_json::json!(second_id);
            second["lines"][0]["id"] = serde_json::json!(format!("line-{second_id}"));
            second["lines"][0]["orderId"] = serde_json::json!(second_id);
            execute_mysql_epoch_fenced_outbox_operation(&pool, "orders", "heldOrderBundle", &second, "id", &epoch).await.unwrap();
            let unreceipted: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM orders WHERE id IN (?, ?) AND receiptKey IS NULL")
                .bind(&id).bind(&second_id).fetch_one(&pool).await.unwrap();
            assert_eq!(unreceipted, 2);
            execute_mysql_epoch_fenced_outbox_operation(&pool, "orders", "heldOrderBundle", &second, "id", &epoch).await.unwrap();
            let mut invalid = payload.clone();
            let bad_id = format!("bad-hold-{:016x}", rand::random::<u64>());
            invalid["order"]["id"] = serde_json::json!(bad_id);
            invalid["lines"][0]["orderId"] = serde_json::json!(bad_id);
            // Reusing the original line's ID must fail after header insertion
            // and roll back that header, not leave a partly shared trolley.
            assert!(execute_mysql_epoch_fenced_outbox_operation(&pool, "orders", "heldOrderBundle", &invalid, "id", &epoch).await.is_err());
            let bad_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM orders WHERE id = ?")
                .bind(&bad_id).fetch_one(&pool).await.unwrap();
            assert_eq!(bad_count, 0);
            let missing = claim_mysql_held_order(uri.clone(), bad_id, "missing-hold-owner".into(), Some(epoch.clone())).await.unwrap_err();
            assert!(missing.contains("HELD_ORDER_NOT_SHARED"));
            let owner = "persistent-claim-owner".to_string();
            assert!(claim_mysql_held_order(uri.clone(), id.clone(), owner.clone(), Some(epoch.clone())).await.unwrap());
            // Simulate losing the first success response and restarting the UI.
            assert!(claim_mysql_held_order(uri.clone(), id.clone(), owner, Some(epoch.clone())).await.unwrap());
            assert!(execute_mysql_epoch_fenced_outbox_operation(&pool, "orders", "heldOrderBundle", &payload, "id", &epoch).await.is_err(), "An old upload must never resurrect a claimed hold");
            assert!(!claim_mysql_held_order(uri.clone(), id, "another-till-claim".into(), Some(epoch.clone())).await.unwrap());
            assert!(claim_mysql_held_order(uri, second_id, "second-trolley-owner".into(), Some(epoch)).await.unwrap());
        });
    }

    async fn enable_test_account(pool: &SqlitePool, credit_limit_pence: i64) {
        sqlx::query(
            "INSERT INTO customer_accounts
             (id, customerId, isEnabled, creditLimitPence, balancePence, createdAt, updatedAt)
             VALUES ('customer-1', 'customer-1', 1, ?, 0,
                     '2026-07-27T12:00:00.000Z', '2026-07-27T12:00:00.000Z')",
        )
        .bind(credit_limit_pence)
        .execute(pool)
        .await
        .unwrap();
    }

    fn account_change(
        id: &str,
        order_id: &str,
        entry_type: &str,
        amount_pence: i64,
        payment_method: &str,
    ) -> CustomerAccountChange {
        CustomerAccountChange {
            id: id.into(),
            customer_id: "customer-1".into(),
            order_id: order_id.into(),
            entry_type: entry_type.into(),
            amount_pence,
            payment_method: payment_method.into(),
            tips_amount: 0,
            service_charge_amount: 0,
            cashback_amount: 0,
            reference: String::new(),
            description: if entry_type == "adjustment" {
                "Test adjustment".into()
            } else {
                String::new()
            },
            receipt_number: 0,
            receipt_key: String::new(),
            employee_id: "employee".into(),
            till_number: String::new(),
            shift_id: String::new(),
            idempotency_key: format!("idempotency-{id}"),
            reverses_entry_id: String::new(),
            allow_credit_balance: false,
            balance_after_pence: 0,
            created_at: "2026-07-27T12:00:00.000Z".into(),
            updated_at: "2026-07-27T12:00:00.000Z".into(),
            report_epoch: String::new(),
            server_data_epoch: String::new(),
        }
    }

    #[test]
    fn slow_till_repayment_is_stamped_after_the_mariadb_report_cutoff() {
        let cutoff = "2026-07-29T12:00:00.000000Z";
        let server_stamp = "2026-07-29T12:00:00.001000Z";
        let mut repayment = account_change("slow-clock", "", "payment", -500, "cash");
        repayment.created_at = "2026-07-29T11:59:30.000000Z".into();
        repayment.updated_at = repayment.created_at.clone();

        stamp_new_mysql_account_change(&mut repayment, server_stamp);

        assert_eq!(repayment.created_at, server_stamp);
        assert_eq!(repayment.updated_at, server_stamp);
        assert!(repayment.created_at.as_str() >= cutoff);
    }

    fn account_sale(id: &str, receipt: &str, amount_pence: i64) -> SaleBundle {
        let mut sale = bundle(id, receipt, &format!("payment-{id}"));
        sale.order.customer_id = "customer-1".into();
        sale.order.payment_method = "account".into();
        sale.order.total = amount_pence;
        sale.order.subtotal = amount_pence;
        sale.order.tax_total = 0;
        sale.order.amount_tendered = amount_pence;
        sale.lines[0].line_total = amount_pence;
        sale.lines[0].unit_price = amount_pence;
        sale.lines[0].tax_amount = 0;
        sale.payment.method = "account".into();
        sale.payment.amount = amount_pence;
        sale.payment.cash_amount = 0;
        sale.payment.card_amount = 0;
        sale.payment.loyalty_amount = 0;
        sale.payment.account_amount = amount_pence;
        sale.account_changes = vec![account_change(
            &format!("account-charge-{id}"),
            id,
            "charge",
            amount_pence,
            "",
        )];
        sale
    }

    #[test]
    fn report_epoch_accepts_equivalent_rfc3339_precision_and_rejects_invalid_values() {
        assert_eq!(
            canonical_report_epoch("2026-07-29T12:00:00.000000Z").unwrap(),
            "2026-07-29T12:00:00.000Z"
        );
        assert_eq!(
            canonical_report_epoch("2026-07-29T13:00:00.000+01:00").unwrap(),
            "2026-07-29T12:00:00.000Z"
        );
        assert_eq!(canonical_report_epoch("").unwrap(), "");
        assert!(canonical_report_epoch("not-a-timestamp").is_err());
    }

    #[test]
    fn report_cutoff_is_the_exclusive_successor_of_the_server_tick() {
        let tick = "2026-07-29T12:00:00.123Z";
        let cutoff = exclusive_report_cutoff(tick).unwrap();
        assert_eq!(cutoff, "2026-07-29T12:00:00.124Z");
        assert!(
            tick < cutoff.as_str(),
            "an equal-tick writer must be included"
        );
    }

    #[test]
    fn per_till_snapshot_uses_the_exact_server_tick_as_its_exclusive_bound() {
        let tick = "2026-07-29T12:00:00.123000Z";
        let cutoff = canonical_report_epoch(tick).unwrap();
        assert_eq!(cutoff, "2026-07-29T12:00:00.123Z");
        assert!(
            "2026-07-29T12:00:00.123Z" >= cutoff.as_str(),
            "a same-tick writer released after the snapshot must be deferred by the report's < cutoff predicate"
        );
    }

    #[test]
    fn mariadb_transaction_retry_is_limited_to_contention_failures() {
        assert!(mysql_transaction_contention_error(
            Some("HY000"),
            "Record has changed since last read in table 'products'; try restarting transaction",
        ));
        assert!(mysql_transaction_contention_error(
            Some("40001"),
            "serialization failure",
        ));
        assert!(mysql_transaction_contention_error(
            Some("HY000"),
            "Lock wait timeout exceeded; try restarting transaction",
        ));
        assert!(!mysql_transaction_contention_error(
            Some("23000"),
            "Duplicate entry 'receipt' for key 'receiptKey'",
        ));
        assert!(!mysql_transaction_contention_error(
            Some("HY000"),
            "Illegal mix of collations",
        ));
    }

    #[test]
    fn replay_accepts_server_update_stamps_at_or_after_the_financial_stamp() {
        let financial = "2026-07-29T12:00:00.123000Z";
        assert!(validate_replay_server_timestamp(financial, financial, "row").is_ok());
        assert!(
            validate_replay_server_timestamp("2026-07-29T12:00:00.124000Z", financial, "row",)
                .is_ok()
        );
        assert!(
            validate_replay_server_timestamp("2026-07-29T12:00:00.122000Z", financial, "row",)
                .is_err()
        );
        assert!(validate_replay_server_timestamp("not-a-time", financial, "row").is_err());
    }

    #[test]
    fn online_intent_epoch_is_fail_closed_for_legacy_or_different_datasets() {
        assert!(validate_online_financial_intent_epoch("shop-epoch", "shop-epoch").is_ok());
        assert!(validate_online_financial_intent_epoch("", "").is_ok());
        let legacy = validate_online_financial_intent_epoch("", "shop-epoch")
            .unwrap_err()
            .to_string();
        assert!(legacy.contains(ONLINE_FINANCIAL_INTENT_EPOCH_CODE));
        let mismatch = validate_online_financial_intent_epoch("old-epoch", "new-epoch")
            .unwrap_err()
            .to_string();
        assert!(mismatch.contains(ONLINE_FINANCIAL_INTENT_EPOCH_CODE));
    }

    #[test]
    fn online_financial_intent_reservation_and_local_replay_are_idempotent() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool().await;
            let mut request = bundle("intent-order", "", "intent-payment");
            request.order.order_number = 0;
            request.order.receipt_key.clear();
            request.order.till_number = "till-intent".into();
            sqlx::query(
                "INSERT INTO settings (key, value)
                 VALUES ('server_data_epoch_seen', 'intent-epoch-1')",
            )
            .execute(&pool)
            .await
            .unwrap();

            let reserved =
                reserve_sqlite_online_financial_intent(&pool, "loyalty_sale", &request, false)
                    .await
                    .unwrap();
            assert_eq!(reserved.order.order_number, 1);
            assert_eq!(reserved.order.receipt_key, "till-intent:1");
            let stored_epoch: String = sqlx::query_scalar(&format!(
                "SELECT serverDataEpoch FROM {ONLINE_FINANCIAL_INTENT_TABLE} WHERE id = 1"
            ))
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(stored_epoch, "intent-epoch-1");

            let same_retry =
                reserve_sqlite_online_financial_intent(&pool, "loyalty_sale", &request, false)
                    .await
                    .unwrap();
            assert_eq!(same_retry.order.receipt_key, reserved.order.receipt_key);

            let mut different = bundle("different-order", "", "different-payment");
            different.order.order_number = 0;
            different.order.receipt_key.clear();
            let error =
                reserve_sqlite_online_financial_intent(&pool, "loyalty_sale", &different, false)
                    .await
                    .unwrap_err();
            assert!(error
                .to_string()
                .contains(ONLINE_FINANCIAL_INTENT_PENDING_CODE));

            insert_sqlite_bundle_with_account_authority(&pool, &reserved, true, None)
                .await
                .unwrap();
            insert_sqlite_bundle_with_account_authority(&pool, &reserved, true, None)
                .await
                .unwrap();
            let order_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM orders WHERE id = 'intent-order'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            let stock: i64 =
                sqlx::query_scalar("SELECT stockLevel FROM products WHERE id = 'product-1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(order_count, 1);
            assert_eq!(stock, 9, "a replay must not decrement stock twice");

            clear_sqlite_online_financial_intent(&pool, "loyalty_sale", "intent-order")
                .await
                .unwrap();
            assert!(load_sqlite_online_financial_intent(&pool)
                .await
                .unwrap()
                .is_none());
            let high_water: String = sqlx::query_scalar(
                "SELECT value FROM settings WHERE key = 'receipt_number_high_water'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(high_water, "1");
            pool.close().await;
        });
    }

    #[test]
    fn legacy_online_intent_schema_gains_an_empty_fail_closed_epoch() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool().await;
            sqlx::query(&format!(
                "CREATE TABLE {ONLINE_FINANCIAL_INTENT_TABLE} (
                    id INTEGER PRIMARY KEY, operation TEXT NOT NULL,
                    orderId TEXT NOT NULL, requestJson TEXT NOT NULL,
                    bundleJson TEXT NOT NULL, createdAt TEXT NOT NULL,
                    updatedAt TEXT NOT NULL, lastError TEXT NOT NULL DEFAULT ''
                 )"
            ))
            .execute(&pool)
            .await
            .unwrap();
            sqlx::query(&format!(
                "INSERT INTO {ONLINE_FINANCIAL_INTENT_TABLE}
                 (id, operation, orderId, requestJson, bundleJson, createdAt, updatedAt)
                 VALUES (1, 'loyalty_sale', 'legacy-order', '{{}}', '{{}}', '', '')"
            ))
            .execute(&pool)
            .await
            .unwrap();

            ensure_sqlite_online_financial_intent_schema(&pool)
                .await
                .unwrap();
            let epoch: String = sqlx::query_scalar(&format!(
                "SELECT serverDataEpoch FROM {ONLINE_FINANCIAL_INTENT_TABLE} WHERE id = 1"
            ))
            .fetch_one(&pool)
            .await
            .unwrap();
            assert!(epoch.is_empty());
            pool.close().await;
        });
    }

    #[test]
    fn local_transaction_purge_rolls_back_failure_and_preserves_account_ledger() {
        tauri::async_runtime::block_on(async {
            let pool = purge_test_pool().await;
            enable_test_account(&pool, 1_000).await;
            sqlx::query(
                "INSERT INTO settings (key, value, updatedAt)
                 VALUES ('till_seq', '1', '2026-06-07T12:00:00.000Z')",
            )
            .execute(&pool)
            .await
            .unwrap();
            let mut sale = account_sale("purge-order", "till-1:1000001", 100);
            sale.order.order_number = 1_000_001;
            sale.order.till_number = "till-1".into();
            sale.account_changes[0].created_at = sale.order.created_at.clone();
            sale.account_changes[0].updated_at = sale.order.updated_at.clone();
            insert_sqlite_bundle(&pool, &sale).await.unwrap();

            let marker = "2026-06-08T00:00:00.000Z";
            assert!(purge_sqlite_transactions_before(&pool, marker, &[], true)
                .await
                .is_err());
            for table in ["orders", "payments", "customer_account_entries"] {
                let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
                    .fetch_one(&pool)
                    .await
                    .unwrap();
                assert_eq!(count, 1, "{table} must survive a rolled-back purge");
            }
            let failed_marker_count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM settings WHERE key = 'transaction_purge_applied_at'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(failed_marker_count, 0);

            let result = purge_sqlite_transactions_before(&pool, marker, &[], false)
                .await
                .unwrap();
            assert_eq!(result.till_numbers, vec!["till-1"]);
            for table in ["orders", "payments"] {
                let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
                    .fetch_one(&pool)
                    .await
                    .unwrap();
                assert_eq!(count, 0, "{table} history should be removed");
            }
            let ledger_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM customer_account_entries")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(
                ledger_count, 1,
                "credit ledger must outlive receipt history"
            );
            let movement_after_baseline: i64 = sqlx::query_scalar(
                "SELECT COALESCE(SUM(amountPence), 0) FROM customer_account_entries
                 WHERE createdAt > ?",
            )
            .bind(marker)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(movement_after_baseline, 0);
            let baselines: Vec<String> = sqlx::query_scalar(
                "SELECT tillNumber FROM till_report_markers
                 WHERE type = 'period' AND markerTime = ? ORDER BY tillNumber",
            )
            .bind(marker)
            .fetch_all(&pool)
            .await
            .unwrap();
            assert_eq!(baselines, vec!["", "till-1"]);
            let high_water: String = sqlx::query_scalar(
                "SELECT value FROM settings WHERE key = 'receipt_number_high_water'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(high_water, "1000001");
            let applied: String = sqlx::query_scalar(
                "SELECT value FROM settings WHERE key = 'transaction_purge_applied_at'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(applied, marker);
            pool.close().await;
        });
    }

    fn stock_receipt_bundle() -> StockReceiptBundle {
        let stamp = "2026-07-24T12:00:00.000Z".to_string();
        StockReceiptBundle {
            server_data_epoch: String::new(),
            receipt: StockReceiptRecord {
                id: "receipt-1".into(),
                supplier_id: "supplier-1".into(),
                employee_id: "employee-1".into(),
                reference: "INV-1".into(),
                notes: "".into(),
                total_cost: 120,
                status: "received".into(),
                created_at: stamp.clone(),
                updated_at: stamp.clone(),
            },
            lines: vec![StockReceiptLineRecord {
                id: "receipt-line-1".into(),
                receipt_id: "receipt-1".into(),
                product_id: "product-1".into(),
                product_name: "Test Product".into(),
                quantity: 3,
                unit_cost: 40,
                inventory_log_id: "receipt-log-1".into(),
                created_at: stamp.clone(),
                updated_at: stamp.clone(),
            }],
            audit: AuditRecord {
                id: "receipt-audit-1".into(),
                employee_id: "employee-1".into(),
                action: "stock_received".into(),
                entity_type: "stock_receipt".into(),
                entity_id: "receipt-1".into(),
                old_data: "".into(),
                new_data: "{\"lineCount\":1}".into(),
                created_at: stamp,
            },
        }
    }

    fn terminal_extras_sale(id: &str) -> SaleBundle {
        let mut sale = bundle(id, "", &format!("payment-{id}"));
        sale.payment.method = "dojo".into();
        sale.order.payment_method = "dojo".into();
        sale.payment.cash_amount = 0;
        sale.payment.card_amount = 100;
        sale.payment.tips_amount = 20;
        sale.payment.service_charge_amount = 5;
        sale.payment.cashback_amount = 200;
        sale.payment.reference = format!("Dojo pi-{id}");
        sale
    }

    #[test]
    fn terminal_extras_legacy_payloads_default_to_zero_and_validate_separately() {
        let sale = terminal_extras_sale("extras-legacy");
        let mut value = serde_json::to_value(&sale).unwrap();
        let payment = value["payment"].as_object_mut().unwrap();
        for field in ["tipsAmount", "serviceChargeAmount", "cashbackAmount"] {
            payment.remove(field);
        }
        let legacy: SaleBundle = serde_json::from_value(value).unwrap();
        assert_eq!(legacy.payment.tips_amount, 0);
        assert_eq!(legacy.payment.service_charge_amount, 0);
        assert_eq!(legacy.payment.cashback_amount, 0);
        // Persisted online-intent requests compare serialized JSON: zero additions
        // must preserve the old shape so upgrades can safely replay them.
        let legacy_json = serde_json::to_value(&legacy).unwrap();
        for field in ["tipsAmount", "serviceChargeAmount", "cashbackAmount"] {
            assert!(legacy_json["payment"].get(field).is_none());
        }
        let sale_json = serde_json::to_value(&sale).unwrap();
        assert_eq!(sale_json["payment"]["tipsAmount"], 20);
        assert_eq!(sale_json["payment"]["serviceChargeAmount"], 5);
        assert_eq!(sale_json["payment"]["cashbackAmount"], 200);
        let legacy_account = account_change("legacy-account", "", "payment", -40, "card");
        let legacy_account_json = serde_json::to_value(&legacy_account).unwrap();
        for field in ["tipsAmount", "serviceChargeAmount", "cashbackAmount"] {
            assert!(legacy_account_json.get(field).is_none());
        }
        let parsed_account: CustomerAccountChange = serde_json::from_value(legacy_account_json).unwrap();
        assert_eq!(parsed_account, legacy_account);
        assert_eq!(payment_allocation(&sale.payment).unwrap(), (0, 100, 0, 0));
        validate_sale_terminal_extras(&sale).unwrap();
        assert_eq!(checked_card_collection(100, checked_terminal_extras(20, 5, 200).unwrap()).unwrap(), 325);

        for invalid in [-1, i64::MAX] {
            let mut changed = sale.clone();
            changed.payment.tips_amount = invalid;
            assert!(validate_sale_terminal_extras(&changed).is_err());
        }
        let mut refund = sale.clone();
        refund.order.order_type = "return".into();
        assert!(validate_sale_terminal_extras(&refund).is_err());
        let mut cash_only = sale;
        cash_only.payment.cash_amount = 100;
        cash_only.payment.card_amount = 0;
        assert!(validate_sale_terminal_extras(&cash_only).is_err());
    }

    #[test]
    fn terminal_extras_sale_persists_and_replays_without_changing_product_revenue() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool().await;
            let sale = terminal_extras_sale("extras-sale");
            let first = insert_sqlite_bundle_with_outbox(&pool, &sale, Some("extras-outbox")).await.unwrap();
            let replay = insert_sqlite_bundle_with_outbox(&pool, &sale, Some("extras-outbox")).await.unwrap();
            assert_eq!(first.payment, replay.payment);
            let row: (i64, i64, i64, i64, i64, i64, i64) = sqlx::query_as(
                "SELECT o.total, p.amount, p.cardAmount, p.tipsAmount, p.serviceChargeAmount,
                        p.cashbackAmount, p.cashAmount - p.cashbackAmount
                 FROM orders o JOIN payments p ON p.orderId = o.id WHERE o.id = 'extras-sale'",
            ).fetch_one(&pool).await.unwrap();
            assert_eq!(row, (100, 100, 100, 20, 5, 200, -200));
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM payments").fetch_one(&pool).await.unwrap();
            assert_eq!(count, 1);
            let mut changed = sale;
            changed.payment.cashback_amount += 1;
            assert!(insert_sqlite_bundle_with_outbox(&pool, &changed, Some("extras-outbox")).await.is_err());
        });
    }

    #[test]
    fn terminal_extras_goods_refund_retains_additions_and_void_is_rejected() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool().await;
            let sale = terminal_extras_sale("extras-refund");
            insert_sqlite_bundle(&pool, &sale).await.unwrap();
            let mut void = void_bundle("extras-void", "extras-refund");
            void.payment.method = "dojo".into();
            void.order.payment_method = "dojo".into();
            void.payment.cash_amount = 0;
            void.payment.card_amount = -100;
            assert!(insert_sqlite_bundle(&pool, &void).await.unwrap_err().to_string().contains("cannot be voided"));

            let mut refund = refund_bundle("extras-product-refund", "extras-refund", 100, "refunded");
            refund.payment.method = "dojo".into();
            refund.order.payment_method = "dojo".into();
            refund.payment.cash_amount = 0;
            refund.payment.card_amount = -100;
            insert_sqlite_bundle(&pool, &refund).await.unwrap();
            let totals: (i64, i64, i64, i64, i64) = sqlx::query_as(
                "SELECT SUM(amount), SUM(cardAmount), SUM(tipsAmount), SUM(serviceChargeAmount), SUM(cashbackAmount) FROM payments",
            ).fetch_one(&pool).await.unwrap();
            assert_eq!(totals, (0, 0, 20, 5, 200));
        });
    }

    #[test]
    fn terminal_extras_account_repayment_preserves_base_debt_and_idempotency() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool().await;
            enable_test_account(&pool, 500).await;
            let opening = account_change("extras-opening", "", "opening_balance", 100, "");
            post_sqlite_customer_account_entry(&pool, &opening).await.unwrap();
            let mut payment = account_change("extras-repayment", "", "payment", -40, "card");
            payment.reference = "Dojo pi-repayment".into();
            payment.tips_amount = 10;
            payment.service_charge_amount = 5;
            payment.cashback_amount = 200;
            let first = post_sqlite_customer_account_entry(&pool, &payment).await.unwrap();
            assert_eq!(first.account.balance_pence, 60);
            assert_eq!(first.entry.amount_pence, -40);
            assert_eq!((first.entry.tips_amount, first.entry.service_charge_amount, first.entry.cashback_amount), (10, 5, 200));
            let replay = post_sqlite_customer_account_entry(&pool, &payment).await.unwrap();
            assert_eq!(replay.account.balance_pence, 60);
            assert_eq!(replay.entry.cashback_amount, 200);
            payment.tips_amount += 1;
            assert!(post_sqlite_customer_account_entry(&pool, &payment).await.unwrap_err().to_string().contains("idempotency conflict"));

            let cache = test_pool().await;
            cache_sqlite_customer_account_mutation(&cache, &first).await.unwrap();
            let mut tx = cache.begin().await.unwrap();
            payment.tips_amount -= 1;
            let cached = find_sqlite_account_entry(&mut tx, &payment).await.unwrap().unwrap();
            assert!(entry_matches_change(&cached, &payment));
        });
    }

    #[test]
    fn terminal_extras_account_additions_require_card_payment_and_safe_total() {
        let mut payment = account_change("extras-shape", "", "payment", -40, "card");
        payment.reference = "Dojo pi-shape".into();
        payment.tips_amount = 10;
        validate_account_change_shape(&payment).unwrap();
        payment.payment_method = "cash".into();
        assert!(validate_account_change_shape(&payment).is_err());
        payment.payment_method = "card".into();
        payment.tips_amount = MAX_SAFE_TERMINAL_MONEY;
        assert!(validate_account_change_shape(&payment).is_err());
        payment.tips_amount = -1;
        assert!(validate_account_change_shape(&payment).is_err());
    }

    #[test]
    fn database_shaped_refund_bundle_accepts_integer_boolean_flags() {
        let sale = bundle("refund-order", "", "refund-payment");
        let mut json = serde_json::to_value(sale).unwrap();
        json["lines"][0]["isPriceOverride"] = serde_json::json!(0);

        let parsed: SaleBundle = serde_json::from_value(json).unwrap();
        assert!(!parsed.lines[0].is_price_override);
    }

    fn refund_bundle(id: &str, original_id: &str, amount: i64, status: &str) -> SaleBundle {
        let mut refund = bundle(id, "", &format!("payment-{id}"));
        refund.order.order_number = 0;
        refund.order.receipt_key = "".into();
        refund.order.order_type = "return".into();
        refund.order.original_order_id = original_id.into();
        refund.order.subtotal = -amount;
        refund.order.tax_total = 0;
        refund.order.total = -amount;
        refund.order.amount_tendered = -amount;
        refund.lines[0].id = format!("line-{id}");
        refund.lines[0].order_id = id.into();
        refund.lines[0].quantity = 0;
        refund.lines[0].tax_amount = 0;
        refund.lines[0].line_total = -amount;
        refund.payment.order_id = id.into();
        refund.payment.amount = -amount;
        refund.payment.cash_amount = -amount;
        refund.audit.id = format!("audit-{id}");
        refund.audit.entity_id = original_id.into();
        refund.audit.action = if status == "partially_refunded" {
            "order_partially_refunded".into()
        } else {
            "order_refunded".into()
        };
        refund.stock_changes = vec![];
        if status == "refunded" {
            refund.lines[0].quantity = -1;
            refund.stock_changes = vec![StockChange {
                product_id: "product-1".into(),
                delta: 1,
                log_id: format!("stock-{id}"),
                employee_id: "employee".into(),
                notes: "refund".into(),
                movement_type: "return".into(),
            }];
        }
        refund.original_order_to_update = Some(original_id.into());
        refund.original_status_update = Some(status.into());
        refund
    }

    fn void_bundle(id: &str, original_id: &str) -> SaleBundle {
        let mut reversal = refund_bundle(id, original_id, 100, "refunded");
        reversal.order.notes = "Void of receipt 1".into();
        reversal.audit.action = "order_voided".into();
        reversal.original_status_update = Some("voided".into());
        reversal
    }

    #[test]
    fn partial_then_final_refund_commits_and_blocks_over_refund() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool().await;
            insert_sqlite_bundle(
                &pool,
                &bundle("sale-to-refund", "till-1:1000001", "sale-payment"),
            )
            .await
            .unwrap();
            insert_sqlite_bundle(
                &pool,
                &refund_bundle("partial-refund", "sale-to-refund", 40, "partially_refunded"),
            )
            .await
            .unwrap();
            insert_sqlite_bundle(
                &pool,
                &refund_bundle("final-refund", "sale-to-refund", 60, "refunded"),
            )
            .await
            .unwrap();

            let status: String =
                sqlx::query_scalar("SELECT status FROM orders WHERE id = 'sale-to-refund'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            let refunded: i64 = sqlx::query_scalar(
                "SELECT COALESCE(SUM(ABS(total)), 0) FROM orders WHERE type = 'return' AND originalOrderId = 'sale-to-refund'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(status, "refunded");
            assert_eq!(refunded, 100);

            let over_refund = insert_sqlite_bundle(
                &pool,
                &refund_bundle("over-refund", "sale-to-refund", 1, "refunded"),
            )
            .await;
            assert!(over_refund.is_err());
        });
    }

    #[test]
    fn malformed_refund_bundle_is_rejected() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool().await;
            insert_sqlite_bundle(
                &pool,
                &bundle("sale-malformed", "till-1:1000001", "sale-payment-malformed"),
            )
            .await
            .unwrap();

            let mut refund = refund_bundle("bad-refund", "sale-malformed", 100, "refunded");
            refund.payment.amount = -99;
            let result = insert_sqlite_bundle(&pool, &refund).await;
            assert!(result.is_err());
        });
    }

    #[test]
    fn full_refund_requires_exact_original_stock_restoration() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool().await;
            insert_sqlite_bundle(
                &pool,
                &bundle("sale-stock", "till-1:1000001", "sale-payment-stock"),
            )
            .await
            .unwrap();

            let mut refund = refund_bundle("bad-stock-refund", "sale-stock", 100, "refunded");
            refund.stock_changes.clear();
            let result = insert_sqlite_bundle(&pool, &refund).await;
            assert!(result.is_err());
        });
    }

    #[test]
    fn legacy_cash_payment_without_split_columns_can_be_refunded() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool().await;
            let mut sale = bundle("legacy-cash-sale", "till-1:1000001", "legacy-cash-payment");
            sale.payment.cash_amount = 0;
            insert_sqlite_bundle(&pool, &sale).await.unwrap();

            insert_sqlite_bundle(
                &pool,
                &refund_bundle("legacy-cash-refund", "legacy-cash-sale", 100, "refunded"),
            )
            .await
            .unwrap();

            let status: String =
                sqlx::query_scalar("SELECT status FROM orders WHERE id = 'legacy-cash-sale'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(status, "refunded");
        });
    }

    #[test]
    fn void_requires_original_open_shift_and_rejects_closed_periods() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool().await;
            insert_sqlite_bundle(
                &pool,
                &bundle(
                    "sale-valid-void",
                    "till-1:1000001",
                    "original-payment-valid-void",
                ),
            )
            .await
            .unwrap();
            insert_sqlite_bundle(&pool, &void_bundle("valid-void", "sale-valid-void"))
                .await
                .unwrap();

            insert_sqlite_bundle(
                &pool,
                &bundle(
                    "sale-protected-void",
                    "till-1:1000002",
                    "payment-protected-void",
                ),
            )
            .await
            .unwrap();
            let mut wrong_shift = void_bundle("wrong-shift-void", "sale-protected-void");
            wrong_shift.order.shift_id = "another-shift".into();
            assert!(insert_sqlite_bundle(&pool, &wrong_shift).await.is_err());

            sqlx::query(
                "INSERT INTO till_report_markers (id, tillNumber, markerTime)
                 VALUES ('closed-period', 'till-1:1000002', '2026-06-07T12:00:01.000Z')",
            )
            .execute(&pool)
            .await
            .unwrap();
            assert!(insert_sqlite_bundle(
                &pool,
                &void_bundle("closed-period-void", "sale-protected-void"),
            )
            .await
            .is_err());
        });
    }

    #[test]
    fn refund_financial_fields_cannot_exceed_original_sale() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool().await;
            insert_sqlite_bundle(
                &pool,
                &bundle("sale-financials", "till-1:1000001", "payment-financials"),
            )
            .await
            .unwrap();

            let mut refund = refund_bundle("bad-financials", "sale-financials", 100, "refunded");
            refund.order.tax_total = -18;
            refund.lines[0].tax_amount = -18;
            assert!(insert_sqlite_bundle(&pool, &refund).await.is_err());
        });
    }

    #[test]
    fn two_tills_accumulate_stock_and_keep_unique_receipts() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool().await;
            insert_sqlite_bundle(&pool, &bundle("order-1", "till-1:1000001", "payment-1"))
                .await
                .unwrap();
            insert_sqlite_bundle(&pool, &bundle("order-2", "till-2:2000001", "payment-2"))
                .await
                .unwrap();
            let stock: i64 =
                sqlx::query_scalar("SELECT stockLevel FROM products WHERE id = 'product-1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            let orders: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM orders")
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(stock, 8);
            assert_eq!(orders, 2);
        });
    }

    #[test]
    fn loyalty_changes_commit_with_the_sale() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool().await;
            let mut sale = bundle("order-loyalty", "till-1:1000001", "payment-loyalty");
            sale.loyalty_changes = vec![
                LoyaltyChange {
                    id: "loyalty-redeem".into(),
                    customer_id: "customer-1".into(),
                    order_id: "order-loyalty".into(),
                    points_change: -100,
                    reason: "redeemed".into(),
                    created_at: sale.order.created_at.clone(),
                },
                LoyaltyChange {
                    id: "loyalty-earn".into(),
                    customer_id: "customer-1".into(),
                    order_id: "order-loyalty".into(),
                    points_change: 1,
                    reason: "earned".into(),
                    created_at: sale.order.created_at.clone(),
                },
            ];
            insert_sqlite_bundle(&pool, &sale).await.unwrap();
            let points: i64 =
                sqlx::query_scalar("SELECT loyaltyPoints FROM customers WHERE id = 'customer-1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            let logs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM loyalty_logs")
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(points, 51);
            assert_eq!(logs, 2);
        });
    }

    #[test]
    fn insufficient_loyalty_balance_rolls_back_the_entire_sale() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool().await;
            let mut sale = bundle(
                "order-loyalty-rejected",
                "till-1:1000001",
                "payment-loyalty-rejected",
            );
            sale.loyalty_changes = vec![LoyaltyChange {
                id: "loyalty-overdraw".into(),
                customer_id: "customer-1".into(),
                order_id: sale.order.id.clone(),
                points_change: -151,
                reason: "redeemed".into(),
                created_at: sale.order.created_at.clone(),
            }];

            let result = insert_sqlite_bundle(&pool, &sale).await;
            assert!(result.is_err());
            let points: i64 =
                sqlx::query_scalar("SELECT loyaltyPoints FROM customers WHERE id = 'customer-1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            let orders: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM orders WHERE id = 'order-loyalty-rejected'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            let logs: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM loyalty_logs WHERE orderId = 'order-loyalty-rejected'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(points, 150);
            assert_eq!(orders, 0);
            assert_eq!(logs, 0);
        });
    }

    #[test]
    fn account_charge_and_idempotent_payment_update_the_ledger_atomically() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool().await;
            enable_test_account(&pool, 500).await;
            let sale = account_sale("account-sale", "till-1:1000001", 100);
            let committed = insert_sqlite_bundle(&pool, &sale).await.unwrap();
            assert_eq!(committed.account_changes[0].balance_after_pence, 100);

            let payment = account_change("account-payment", "", "payment", -40, "cash");
            let first = post_sqlite_customer_account_entry(&pool, &payment)
                .await
                .unwrap();
            let mut retry = payment.clone();
            retry.id = "account-payment-retry".into();
            let replay = post_sqlite_customer_account_entry(&pool, &retry)
                .await
                .unwrap();
            let balance: i64 = sqlx::query_scalar(
                "SELECT balancePence FROM customer_accounts WHERE customerId = 'customer-1'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            let entries: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM customer_account_entries")
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(first.entry.balance_after_pence, 60);
            assert_eq!(replay.entry.balance_after_pence, 60);
            assert_eq!(replay.entry.id, "account-payment");
            assert_eq!((balance, entries), (60, 2));
        });
    }

    #[test]
    fn opening_balance_is_atomic_and_can_only_be_posted_once() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool().await;
            enable_test_account(&pool, 500).await;
            let first = account_change("opening-one", "", "opening_balance", 100, "");
            let second = account_change("opening-two", "", "opening_balance", 100, "");
            let first_pool = pool.clone();
            let second_pool = pool.clone();
            let first_result = tauri::async_runtime::spawn(async move {
                post_sqlite_customer_account_entry(&first_pool, &first).await
            });
            let second_result = tauri::async_runtime::spawn(async move {
                post_sqlite_customer_account_entry(&second_pool, &second).await
            });
            let results = [first_result.await.unwrap(), second_result.await.unwrap()];
            assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
            assert_eq!(results.iter().filter(|result| result.is_err()).count(), 1);

            let balance: i64 = sqlx::query_scalar(
                "SELECT balancePence FROM customer_accounts WHERE customerId = 'customer-1'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            let openings: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM customer_account_entries WHERE entryType = 'opening_balance'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!((balance, openings), (100, 1));
        });
    }

    #[test]
    fn authoritative_account_cache_adopts_the_remote_final_balance() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool().await;
            enable_test_account(&pool, 500).await;
            sqlx::query(
                "UPDATE customer_accounts SET balancePence = 40 WHERE customerId = 'customer-1'",
            )
            .execute(&pool)
            .await
            .unwrap();

            let mut remote_change =
                account_change("remote-account-charge", "remote-order", "charge", 20, "");
            // Another till also moved the MariaDB balance. Replaying only this
            // +20 delta against SQLite's stale 40 would incorrectly produce 60.
            remote_change.balance_after_pence = 120;
            remote_change.updated_at = "2026-07-27T12:10:00.000Z".into();
            let mut tx = pool.begin().await.unwrap();
            let result = apply_authoritative_sqlite_account_change(&mut tx, &mut remote_change)
                .await
                .unwrap();
            tx.commit().await.unwrap();

            let balance: i64 = sqlx::query_scalar(
                "SELECT balancePence FROM customer_accounts WHERE customerId = 'customer-1'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            let entry_balance: i64 = sqlx::query_scalar(
                "SELECT balanceAfterPence FROM customer_account_entries WHERE id = 'remote-account-charge'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(result.account.balance_pence, 120);
            assert_eq!((balance, entry_balance), (120, 120));
        });
    }

    #[test]
    fn whole_system_close_marker_requires_the_expected_latest_marker() {
        assert!(validate_report_close_marker(None, None).is_ok());
        assert!(validate_report_close_marker(
            Some("2026-07-27T12:00:00.000Z"),
            Some("2026-07-27T12:00:00.000Z"),
        )
        .is_ok());
        let error = validate_report_close_marker(
            Some("2026-07-27T12:01:00.000Z"),
            Some("2026-07-27T12:00:00.000Z"),
        )
        .unwrap_err();
        assert!(error.to_string().contains("REPORT_PERIOD_CHANGED"));
    }

    #[test]
    fn till_close_cas_uses_the_effective_marker_and_server_bounded_period() {
        let (start, end) = validate_till_report_close_request(
            Some("2026-07-27T12:00:00.000000Z"),
            Some("2026-07-27T12:00:00.000Z"),
            "2026-07-27T12:00:00.000Z",
            "2026-07-27T13:00:00.000Z",
            "2026-07-27T13:00:01.000Z",
        )
        .unwrap();
        assert_eq!(start, "2026-07-27T12:00:00.000Z");
        assert_eq!(end, "2026-07-27T13:00:00.000Z");

        let changed = validate_till_report_close_request(
            Some("2026-07-27T12:01:00.000Z"),
            Some("2026-07-27T12:00:00.000Z"),
            "2026-07-27T12:00:00.000Z",
            "2026-07-27T13:00:00.000Z",
            "2026-07-27T13:00:01.000Z",
        )
        .unwrap_err();
        assert!(changed.to_string().contains("REPORT_PERIOD_CHANGED"));

        let future_cutoff = validate_till_report_close_request(
            None,
            None,
            REPORT_PERIOD_ORIGIN,
            "2026-07-27T13:00:02.000Z",
            "2026-07-27T13:00:01.000Z",
        )
        .unwrap_err();
        assert!(future_cutoff.to_string().contains("REPORT_CUTOFF_INVALID"));
    }

    #[test]
    fn report_period_bounds_reject_empty_or_reversed_cutoffs() {
        assert!(canonical_report_period_bounds(
            "2026-07-27T12:00:00.000Z",
            "2026-07-27T12:00:00.000Z",
        )
        .is_err());
        assert!(canonical_report_period_bounds(
            "2026-07-27T12:00:01.000Z",
            "2026-07-27T12:00:00.000Z",
        )
        .is_err());
    }

    #[test]
    fn account_limit_failure_rolls_back_the_entire_sale() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool().await;
            enable_test_account(&pool, 50).await;
            let result = insert_sqlite_bundle(
                &pool,
                &account_sale("account-over-limit", "till-1:1000001", 100),
            )
            .await;
            assert!(result.is_err());
            let balance: i64 = sqlx::query_scalar(
                "SELECT balancePence FROM customer_accounts WHERE customerId = 'customer-1'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            let orders: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM orders WHERE id = 'account-over-limit'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            let stock: i64 =
                sqlx::query_scalar("SELECT stockLevel FROM products WHERE id = 'product-1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!((balance, orders, stock), (0, 0, 10));
        });
    }

    #[test]
    fn account_payment_cannot_exceed_the_amount_owed() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool().await;
            enable_test_account(&pool, 500).await;
            insert_sqlite_bundle(
                &pool,
                &account_sale("account-overpay-sale", "till-1:1000001", 100),
            )
            .await
            .unwrap();
            let overpayment = account_change("account-overpayment", "", "payment", -101, "card");
            assert!(post_sqlite_customer_account_entry(&pool, &overpayment)
                .await
                .is_err());
            let balance: i64 = sqlx::query_scalar(
                "SELECT balancePence FROM customer_accounts WHERE customerId = 'customer-1'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            let payments: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM customer_account_entries WHERE entryType = 'payment'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!((balance, payments), (100, 0));
        });
    }

    #[test]
    fn approved_referenced_card_payment_can_preserve_excess_as_customer_credit() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool().await;
            enable_test_account(&pool, 500).await;
            insert_sqlite_bundle(
                &pool,
                &account_sale("approved-card-race-sale", "till-1:1000001", 100),
            )
            .await
            .unwrap();

            // The terminal approved the original £1.00 while another till
            // reduced the live debt by 40p. All money received is still
            // accounted for: the excess becomes explicit customer credit.
            sqlx::query(
                "UPDATE customer_accounts SET balancePence = 60 WHERE customerId = 'customer-1'",
            )
            .execute(&pool)
            .await
            .unwrap();
            let mut approved =
                account_change("approved-card-race-payment", "", "payment", -100, "card");
            approved.reference = "Dojo transaction-123 [id:pi_123]".into();
            approved.allow_credit_balance = true;
            let result = post_sqlite_customer_account_entry(&pool, &approved)
                .await
                .unwrap();

            assert_eq!(result.account.balance_pence, -40);
            assert_eq!(result.entry.balance_after_pence, -40);
        });
    }

    #[test]
    fn on_account_refund_is_not_reclassified_as_loyalty() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool().await;
            enable_test_account(&pool, 500).await;
            insert_sqlite_bundle(
                &pool,
                &account_sale("account-refund-sale", "till-1:1000001", 100),
            )
            .await
            .unwrap();
            let repayment = account_change("account-refund-payment", "", "payment", -100, "cash");
            post_sqlite_customer_account_entry(&pool, &repayment)
                .await
                .unwrap();

            let mut refund =
                refund_bundle("account-refund", "account-refund-sale", 100, "refunded");
            refund.order.customer_id = "customer-1".into();
            refund.order.payment_method = "account".into();
            refund.payment.method = "account".into();
            refund.payment.cash_amount = 0;
            refund.payment.account_amount = -100;
            refund.account_changes = vec![account_change(
                "account-refund-entry",
                "account-refund",
                "refund",
                -100,
                "",
            )];
            let committed = insert_sqlite_bundle(&pool, &refund).await.unwrap();
            let balance: i64 = sqlx::query_scalar(
                "SELECT balancePence FROM customer_accounts WHERE customerId = 'customer-1'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(committed.account_changes[0].balance_after_pence, -100);
            assert_eq!(balance, -100);
        });
    }

    #[test]
    fn local_transaction_allocates_unique_receipts_for_stale_bundles() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool().await;
            sqlx::query("INSERT INTO settings (key, value) VALUES ('till_seq', '2')")
                .execute(&pool)
                .await
                .unwrap();

            let mut first = bundle("order-1", "", "payment-1");
            first.order.order_number = 0;
            first.order.till_number = "till-2".into();
            let mut second = bundle("order-2", "", "payment-2");
            second.order.order_number = 0;
            second.order.till_number = "till-2".into();

            let first = insert_sqlite_bundle(&pool, &first).await.unwrap();
            let second = insert_sqlite_bundle(&pool, &second).await.unwrap();

            assert_eq!(first.order.order_number, 2_000_001);
            assert_eq!(second.order.order_number, 2_000_002);
            assert_eq!(first.order.receipt_key, "till-2:2000001");
            assert_eq!(second.order.receipt_key, "till-2:2000002");
        });
    }

    #[test]
    fn local_transaction_continues_multi_till_receipts_after_history_purge() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool().await;
            sqlx::query(
                "INSERT INTO settings (key, value) VALUES ('till_seq', '2'), ('receipt_number_high_water', '2000456')",
            )
            .execute(&pool)
            .await
            .unwrap();

            let mut sale = bundle("order-after-purge", "", "payment-after-purge");
            sale.order.order_number = 0;
            sale.order.till_number = "till-2".into();
            let committed = insert_sqlite_bundle(&pool, &sale).await.unwrap();

            assert_eq!(committed.order.order_number, 2_000_457);
            assert_eq!(committed.order.receipt_key, "till-2:2000457");
        });
    }

    #[test]
    fn local_transaction_continues_standalone_receipts_after_history_purge() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool().await;
            sqlx::query(
                "INSERT INTO settings (key, value) VALUES ('receipt_number_high_water', '456')",
            )
            .execute(&pool)
            .await
            .unwrap();

            let mut sale = bundle("order-after-purge", "", "payment-after-purge");
            sale.order.order_number = 0;
            let committed = insert_sqlite_bundle(&pool, &sale).await.unwrap();

            assert_eq!(committed.order.order_number, 457);
        });
    }

    #[test]
    fn simultaneous_local_sales_allocate_different_receipts() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool().await;
            sqlx::query("INSERT INTO settings (key, value) VALUES ('till_seq', '3')")
                .execute(&pool)
                .await
                .unwrap();

            let mut first = bundle("order-1", "", "payment-1");
            first.order.order_number = 0;
            first.order.till_number = "till-3".into();
            let mut second = bundle("order-2", "", "payment-2");
            second.order.order_number = 0;
            second.order.till_number = "till-3".into();

            let pool_one = pool.clone();
            let pool_two = pool.clone();
            let one = tauri::async_runtime::spawn(async move {
                insert_sqlite_bundle(&pool_one, &first).await.unwrap()
            });
            let two = tauri::async_runtime::spawn(async move {
                insert_sqlite_bundle(&pool_two, &second).await.unwrap()
            });
            let one = one.await.unwrap();
            let two = two.await.unwrap();
            let mut numbers = [one.order.order_number, two.order.order_number];
            numbers.sort();
            assert_eq!(numbers, [3_000_001, 3_000_002]);
        });
    }

    #[test]
    fn stock_receipt_rejects_values_that_cannot_sync_or_render_exactly() {
        let mut oversized_quantity = stock_receipt_bundle();
        oversized_quantity.lines[0].quantity = i32::MAX as i64 + 1;
        oversized_quantity.lines[0].unit_cost = 0;
        oversized_quantity.receipt.total_cost = 0;
        assert!(validate_stock_receipt_bundle(&oversized_quantity).is_err());

        let mut oversized_money = stock_receipt_bundle();
        oversized_money.lines[0].quantity = 1;
        oversized_money.lines[0].unit_cost = MAX_STOCK_RECEIPT_MONEY + 1;
        oversized_money.receipt.total_cost = MAX_STOCK_RECEIPT_MONEY + 1;
        assert!(validate_stock_receipt_bundle(&oversized_money).is_err());

        let mut oversized_total = stock_receipt_bundle();
        oversized_total.lines[0].quantity = 2;
        oversized_total.lines[0].unit_cost = MAX_STOCK_RECEIPT_MONEY;
        oversized_total.receipt.total_cost = MAX_STOCK_RECEIPT_MONEY * 2;
        assert!(validate_stock_receipt_bundle(&oversized_total).is_err());

        let mut maximum = stock_receipt_bundle();
        maximum.lines[0].quantity = 1;
        maximum.lines[0].unit_cost = MAX_STOCK_RECEIPT_MONEY;
        maximum.receipt.total_cost = MAX_STOCK_RECEIPT_MONEY;
        assert!(validate_stock_receipt_bundle(&maximum).is_ok());
    }

    #[test]
    fn stock_receipt_rejects_duplicate_record_ids_and_mismatched_audit_actor() {
        for duplicate_log in [false, true] {
            let mut receipt = stock_receipt_bundle();
            let mut second = receipt.lines[0].clone();
            second.product_id = "product-2".into();
            if duplicate_log {
                second.id = "line-2".into();
            } else {
                second.inventory_log_id = "log-2".into();
            }
            receipt.lines.push(second);
            receipt.receipt.total_cost *= 2;
            assert!(validate_stock_receipt_bundle(&receipt).is_err());
        }

        let mut receipt = stock_receipt_bundle();
        receipt.audit.employee_id = "different-employee".into();
        assert!(validate_stock_receipt_bundle(&receipt).is_err());
    }

    #[test]
    fn stock_receipt_rejects_stock_overflow_without_committing_any_part() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool().await;
            let initial_stock = i32::MAX as i64 - 1;
            sqlx::query("UPDATE products SET stockLevel = ? WHERE id = 'product-1'")
                .bind(initial_stock)
                .execute(&pool)
                .await
                .unwrap();
            let result = insert_sqlite_stock_receipt_bundle(
                &pool,
                &stock_receipt_bundle(),
                Some("overflow-outbox"),
            )
            .await;
            assert!(result.unwrap_err().to_string().contains("supported range"));
            for table in ["stock_receipts", "stock_receipt_lines", "inventory_logs", "audit_logs", "_offline_queue"] {
                let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {}", table))
                    .fetch_one(&pool)
                    .await
                    .unwrap();
                assert_eq!(count, 0, "{} must roll back", table);
            }
            let stock: i64 = sqlx::query_scalar("SELECT stockLevel FROM products WHERE id = 'product-1'")
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(stock, initial_stock);
        });
    }

    #[test]
    fn stock_receipt_handles_legacy_null_and_negative_stock() {
        tauri::async_runtime::block_on(async {
            for initial_stock in [None, Some(-5_i64), Some(i32::MAX as i64 - 3)] {
                let pool = test_pool().await;
                sqlx::query("UPDATE products SET stockLevel = ? WHERE id = 'product-1'")
                    .bind(initial_stock)
                    .execute(&pool)
                    .await
                    .unwrap();
                insert_sqlite_stock_receipt_bundle(&pool, &stock_receipt_bundle(), None)
                    .await
                    .unwrap();
                let stock: i64 = sqlx::query_scalar("SELECT stockLevel FROM products WHERE id = 'product-1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
                assert_eq!(stock, initial_stock.unwrap_or(0) + 3);
            }
        });
    }

    #[test]
    fn stock_receipt_commits_once_with_its_outbox() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool().await;
            sqlx::query(
                "INSERT INTO settings (key, value)
                 VALUES ('server_data_epoch_seen', 'stock-epoch-1')",
            )
            .execute(&pool)
            .await
            .unwrap();
            let bundle = stock_receipt_bundle();
            insert_sqlite_stock_receipt_bundle(&pool, &bundle, Some("stock-outbox-1"))
                .await
                .unwrap();
            insert_sqlite_stock_receipt_bundle(&pool, &bundle, Some("stock-outbox-1"))
                .await
                .unwrap();

            let receipts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM stock_receipts")
                .fetch_one(&pool)
                .await
                .unwrap();
            let lines: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM stock_receipt_lines")
                .fetch_one(&pool)
                .await
                .unwrap();
            let logs: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM inventory_logs WHERE referenceId = 'receipt-1'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            let stock: i64 =
                sqlx::query_scalar("SELECT stockLevel FROM products WHERE id = 'product-1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            let outbox: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM _offline_queue WHERE operation = 'stockReceiptBundle'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            let queued_data: String = sqlx::query_scalar(
                "SELECT data FROM _offline_queue
                 WHERE operation = 'stockReceiptBundle' LIMIT 1",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            let queued_bundle: StockReceiptBundle = serde_json::from_str(&queued_data).unwrap();
            assert_eq!((receipts, lines, logs, stock, outbox), (1, 1, 1, 13, 1));
            assert_eq!(queued_bundle.server_data_epoch, "stock-epoch-1");
        });
    }

    #[test]
    fn failed_stock_receipt_rolls_back_every_part() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool().await;
            let mut bundle = stock_receipt_bundle();
            bundle.lines.push(StockReceiptLineRecord {
                id: "receipt-line-missing".into(),
                receipt_id: bundle.receipt.id.clone(),
                product_id: "missing-product".into(),
                product_name: "Missing Product".into(),
                quantity: 1,
                unit_cost: 25,
                inventory_log_id: "receipt-log-missing".into(),
                created_at: bundle.receipt.created_at.clone(),
                updated_at: bundle.receipt.updated_at.clone(),
            });
            bundle.receipt.total_cost += 25;

            let result =
                insert_sqlite_stock_receipt_bundle(&pool, &bundle, Some("stock-outbox-failed"))
                    .await;
            assert!(result.is_err());

            let receipts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM stock_receipts")
                .fetch_one(&pool)
                .await
                .unwrap();
            let logs: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM inventory_logs WHERE referenceId = 'receipt-1'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            let stock: i64 =
                sqlx::query_scalar("SELECT stockLevel FROM products WHERE id = 'product-1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            let outbox: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _offline_queue")
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!((receipts, logs, stock, outbox), (0, 0, 10, 0));
        });
    }

    #[test]
    fn failed_sale_rolls_back_every_part() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool().await;
            sqlx::query("INSERT INTO payments (id) VALUES ('duplicate-payment')")
                .execute(&pool)
                .await
                .unwrap();
            let result = insert_sqlite_bundle(
                &pool,
                &bundle("failed-order", "till-1:1000001", "duplicate-payment"),
            )
            .await;
            assert!(result.is_err());
            let orders: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM orders")
                .fetch_one(&pool)
                .await
                .unwrap();
            let stock: i64 =
                sqlx::query_scalar("SELECT stockLevel FROM products WHERE id = 'product-1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(orders, 0);
            assert_eq!(stock, 10);
        });
    }

    #[test]
    fn local_sale_commits_once_with_exact_allocated_outbox_bundle() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool().await;
            sqlx::query(
                "INSERT INTO settings (key, value)
                 VALUES ('server_data_epoch_seen', 'outbox-epoch-1')",
            )
            .execute(&pool)
            .await
            .unwrap();
            let requested = bundle("outbox-order", "", "outbox-payment");
            let first =
                insert_sqlite_bundle_with_outbox(&pool, &requested, Some("sale-outbox-order"))
                    .await
                    .unwrap();
            assert!(first.order.order_number > 0);
            assert!(!first.order.receipt_key.is_empty());

            let queued: String = sqlx::query_scalar(
                "SELECT data FROM _offline_queue
                 WHERE id = 'sale-outbox-order' AND operation = 'saleBundle'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            let queued: SaleBundle = serde_json::from_str(&queued).unwrap();
            assert_eq!(queued.order.order_number, first.order.order_number);
            assert_eq!(queued.order.receipt_key, first.order.receipt_key);
            assert_eq!(queued.audit.new_data, first.audit.new_data);
            assert_eq!(queued.server_data_epoch, "outbox-epoch-1");

            // Simulate a lost invoke response. The same request/outbox id must
            // return the allocated receipt without applying stock again.
            let replay =
                insert_sqlite_bundle_with_outbox(&pool, &requested, Some("sale-outbox-order"))
                    .await
                    .unwrap();
            let orders: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM orders")
                .fetch_one(&pool)
                .await
                .unwrap();
            let outbox: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _offline_queue")
                .fetch_one(&pool)
                .await
                .unwrap();
            let stock: i64 =
                sqlx::query_scalar("SELECT stockLevel FROM products WHERE id = 'product-1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(replay.order.receipt_key, first.order.receipt_key);
            assert_eq!((orders, outbox, stock), (1, 1, 9));
        });
    }

    #[test]
    fn sale_rolls_back_when_its_atomic_outbox_insert_fails() {
        tauri::async_runtime::block_on(async {
            let pool = test_pool().await;
            sqlx::query(
                "CREATE TRIGGER reject_sale_outbox
                 BEFORE INSERT ON _offline_queue
                 WHEN NEW.operation = 'saleBundle'
                 BEGIN SELECT RAISE(ABORT, 'forced sale outbox failure'); END",
            )
            .execute(&pool)
            .await
            .unwrap();

            let result = insert_sqlite_bundle_with_outbox(
                &pool,
                &bundle("rolled-back-order", "", "rolled-back-payment"),
                Some("sale-outbox-failure"),
            )
            .await;
            assert!(result.is_err());
            let orders: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM orders")
                .fetch_one(&pool)
                .await
                .unwrap();
            let logs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM inventory_logs")
                .fetch_one(&pool)
                .await
                .unwrap();
            let outbox: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _offline_queue")
                .fetch_one(&pool)
                .await
                .unwrap();
            let stock: i64 =
                sqlx::query_scalar("SELECT stockLevel FROM products WHERE id = 'product-1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!((orders, logs, outbox, stock), (0, 0, 0, 10));
        });
    }

    #[test]
    fn real_mariadb_signed_employee_authority_values_decode_when_configured() {
        let Ok(uri) = std::env::var("POS_TEST_MYSQL_URI") else {
            return;
        };
        let _serial = REAL_MARIADB_TEST_LOCK.lock().unwrap();
        tauri::async_runtime::block_on(async {
            let pool = MySqlPool::connect(&uri).await.unwrap();
            let connection_id: i64 = sqlx::query_scalar(MYSQL_SIGNED_CONNECTION_ID_SELECT)
                .fetch_one(&pool)
                .await
                .unwrap();
            let active_sql = format!(
                "SELECT {MYSQL_SIGNED_EMPLOYEE_ACTIVE_PROJECTION}
                   FROM (SELECT CAST(1 AS UNSIGNED) AS isActive) unsigned_employee"
            );
            let is_active: i64 = sqlx::query_scalar(&active_sql)
                .fetch_one(&pool)
                .await
                .unwrap();
            assert!(connection_id > 0);
            assert_eq!(is_active, 1);
            pool.close().await;
        });
    }

    #[test]
    fn real_mariadb_customer_delete_races_and_guards_when_configured() {
        let Ok(uri) = std::env::var("POS_TEST_MYSQL_URI") else {
            return;
        };
        let _serial = REAL_MARIADB_TEST_LOCK.lock().unwrap();
        tauri::async_runtime::block_on(async {
            let pool = MySqlPool::connect(&uri).await.unwrap();
            ensure_real_mariadb_test_base_schema(&pool).await.unwrap();
            ensure_mysql_restore_guard_schema(&pool).await.unwrap();
            ensure_mysql_whole_system_close_schema(&pool).await.unwrap();
            ensure_mysql_customer_deletion_guards(&pool).await.unwrap();
            let restore_active: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM pos_restore_gate WHERE id = 1 AND isActive = 1",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(restore_active, 0, "configured MariaDB is in restore mode");
            let server_data_epoch = configured_mariadb_server_epoch(&pool).await;

            let race_suffix = format!("{:016x}", rand::random::<u64>());
            let race_customer = format!("del-race-{race_suffix}");
            let race_order = format!("ord-race-{race_suffix}");
            let race_product = format!("prd-race-{race_suffix}");
            cleanup_mariadb_customer_delete_fixture(
                &pool,
                &race_customer,
                &race_order,
                &race_product,
            )
            .await;
            sqlx::query(
                "INSERT INTO customers
                 (id, name, loyaltyPoints, createdAt, updatedAt)
                 VALUES (?, 'Delete race customer', 0, ?, ?)",
            )
            .bind(&race_customer)
            .bind(utc_stamp())
            .bind(utc_stamp())
            .execute(&pool)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO products
                 (id, name, price, costPrice, stockLevel, trackStock, isActive, createdAt, updatedAt)
                 VALUES (?, 'Delete race product', 100, 20, 10, 1, 1, ?, ?)",
            )
            .bind(&race_product)
            .bind(utc_stamp())
            .bind(utc_stamp())
            .execute(&pool)
            .await
            .unwrap();
            let mut sale = bundle(
                &race_order,
                &format!("race:{race_suffix}"),
                &format!("pay-race-{race_suffix}"),
            );
            sale.order.customer_id = race_customer.clone();
            sale.lines[0].product_id = race_product.clone();
            sale.stock_changes[0].product_id = race_product.clone();
            sale.server_data_epoch = configured_mariadb_server_epoch(&pool).await;
            sale.report_epoch = configured_mariadb_report_epoch(&pool).await;

            let delete_pool = pool.clone();
            let delete_customer = race_customer.clone();
            let delete_server_data_epoch = server_data_epoch.clone();
            let delete_task = tauri::async_runtime::spawn(async move {
                delete_mysql_customer(&delete_pool, &delete_customer, &delete_server_data_epoch)
                    .await
            });
            let sale_pool = pool.clone();
            let sale_task =
                tauri::async_runtime::spawn(
                    async move { insert_mysql_bundle(&sale_pool, &sale).await },
                );
            let delete_result = delete_task.await.unwrap();
            let sale_result = sale_task.await.unwrap();
            let customer_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM customers WHERE id = ?")
                    .bind(&race_customer)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            let order_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM orders WHERE id = ?")
                .bind(&race_order)
                .fetch_one(&pool)
                .await
                .unwrap();
            let customer_tombstones: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM tombstones
                 WHERE table_name = 'customers' AND row_id = ?",
            )
            .bind(&race_customer)
            .fetch_one(&pool)
            .await
            .unwrap();
            let delete_error = delete_result.as_ref().err().map(ToString::to_string);
            let sale_error = sale_result.as_ref().err().map(ToString::to_string);
            cleanup_mariadb_customer_delete_fixture(
                &pool,
                &race_customer,
                &race_order,
                &race_product,
            )
            .await;

            assert_ne!(
                delete_result.is_ok(),
                sale_result.is_ok(),
                "delete result: {delete_error:?}; sale result: {sale_error:?}"
            );
            if delete_result.is_ok() {
                assert_eq!(
                    (customer_count, order_count, customer_tombstones),
                    (0, 0, 1)
                );
                let error = sale_error.unwrap_or_default();
                assert!(
                    error.contains(CUSTOMER_DELETED_CODE) || error.contains("not found"),
                    "unexpected sale error: {error}"
                );
            } else {
                assert_eq!((customer_count, order_count), (1, 1));
                let error = delete_error.unwrap_or_default();
                assert!(
                    error.contains("linked sales"),
                    "unexpected delete error: {error}"
                );
            }

            // Simulate an older/direct client which inserts an order without
            // calling any native preflight. The permanent BEFORE INSERT guard
            // must take the same durable identity mutex as deletion, so either
            // the history wins and deletion refuses, or deletion wins and the
            // late insert sees the tombstone. It may never orphan the order.
            let direct_suffix = format!("{:016x}", rand::random::<u64>());
            let direct_customer = format!("del-direct-{direct_suffix}");
            let direct_order = format!("ord-direct-{direct_suffix}");
            let direct_product = format!("prd-direct-{direct_suffix}");
            cleanup_mariadb_customer_delete_fixture(
                &pool,
                &direct_customer,
                &direct_order,
                &direct_product,
            )
            .await;
            sqlx::query(
                "INSERT INTO customers
                 (id, name, loyaltyPoints, createdAt, updatedAt)
                 VALUES (?, 'Direct writer race customer', 0, ?, ?)",
            )
            .bind(&direct_customer)
            .bind(utc_stamp())
            .bind(utc_stamp())
            .execute(&pool)
            .await
            .unwrap();

            let direct_delete_pool = pool.clone();
            let direct_delete_customer = direct_customer.clone();
            let direct_delete_server_data_epoch = server_data_epoch.clone();
            let direct_delete_task = tauri::async_runtime::spawn(async move {
                delete_mysql_customer(
                    &direct_delete_pool,
                    &direct_delete_customer,
                    &direct_delete_server_data_epoch,
                )
                .await
            });
            let direct_insert_pool = pool.clone();
            let direct_insert_customer = direct_customer.clone();
            let direct_insert_order = direct_order.clone();
            let direct_insert_task = tauri::async_runtime::spawn(async move {
                sqlx::query(
                    "INSERT INTO orders
                     (id, customerId, receiptKey, status, createdAt, updatedAt)
                     VALUES (?, ?, ?, 'completed', ?, ?)",
                )
                .bind(&direct_insert_order)
                .bind(&direct_insert_customer)
                .bind(format!("direct:{direct_suffix}"))
                .bind(utc_stamp())
                .bind(utc_stamp())
                .execute(&direct_insert_pool)
                .await
            });
            let direct_delete_result = direct_delete_task.await.unwrap();
            let direct_insert_result = direct_insert_task.await.unwrap();
            let direct_customer_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM customers WHERE id = ?")
                    .bind(&direct_customer)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            let direct_order_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM orders WHERE id = ?")
                    .bind(&direct_order)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            let direct_delete_error = direct_delete_result.as_ref().err().map(ToString::to_string);
            let direct_insert_error = direct_insert_result.as_ref().err().map(ToString::to_string);
            cleanup_mariadb_customer_delete_fixture(
                &pool,
                &direct_customer,
                &direct_order,
                &direct_product,
            )
            .await;

            assert_ne!(
                direct_delete_result.is_ok(),
                direct_insert_result.is_ok(),
                "direct delete: {direct_delete_error:?}; direct insert: {direct_insert_error:?}"
            );
            if direct_delete_result.is_ok() {
                assert_eq!((direct_customer_count, direct_order_count), (0, 0));
                assert!(direct_insert_error
                    .unwrap_or_default()
                    .contains(CUSTOMER_DELETED_CODE));
            } else {
                assert_eq!((direct_customer_count, direct_order_count), (1, 1));
                assert!(direct_delete_error
                    .unwrap_or_default()
                    .contains("linked sales"));
            }

            let stale_suffix = format!("{:016x}", rand::random::<u64>());
            let stale_customer = format!("del-old-{stale_suffix}");
            let stale_order = format!("ord-old-{stale_suffix}");
            let stale_product = format!("prd-old-{stale_suffix}");
            cleanup_mariadb_customer_delete_fixture(
                &pool,
                &stale_customer,
                &stale_order,
                &stale_product,
            )
            .await;
            sqlx::query(
                "INSERT INTO customers
                 (id, name, loyaltyPoints, createdAt, updatedAt)
                 VALUES (?, 'Stale client customer', 0, ?, ?)",
            )
            .bind(&stale_customer)
            .bind(utc_stamp())
            .bind(utc_stamp())
            .execute(&pool)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO customer_accounts
                 (id, customerId, isEnabled, creditLimitPence, balancePence, createdAt, updatedAt)
                 VALUES (?, ?, 0, 0, 0, ?, ?)",
            )
            .bind(&stale_customer)
            .bind(&stale_customer)
            .bind(utc_stamp())
            .bind(utc_stamp())
            .execute(&pool)
            .await
            .unwrap();

            let first_delete = delete_mysql_customer(&pool, &stale_customer, &server_data_epoch)
                .await
                .unwrap();
            let retry_delete = delete_mysql_customer(&pool, &stale_customer, &server_data_epoch)
                .await
                .unwrap();
            let stale_customer_upsert = sqlx::query(
                "INSERT INTO customers
                 (id, name, loyaltyPoints, createdAt, updatedAt)
                 VALUES (?, 'Resurrected customer', 0, ?, ?)
                 ON DUPLICATE KEY UPDATE name = VALUES(name)",
            )
            .bind(&stale_customer)
            .bind(utc_stamp())
            .bind(utc_stamp())
            .execute(&pool)
            .await;
            let stale_account_upsert = sqlx::query(
                "INSERT INTO customer_accounts
                 (id, customerId, isEnabled, creditLimitPence, balancePence, createdAt, updatedAt)
                 VALUES (?, ?, 0, 0, 0, ?, ?)
                 ON DUPLICATE KEY UPDATE isEnabled = VALUES(isEnabled)",
            )
            .bind(&stale_customer)
            .bind(&stale_customer)
            .bind(utc_stamp())
            .bind(utc_stamp())
            .execute(&pool)
            .await;
            let stale_order_upsert = sqlx::query(
                "INSERT INTO orders
                 (id, customerId, receiptKey, status, createdAt, updatedAt)
                 VALUES (?, ?, ?, 'completed', ?, ?)
                 ON DUPLICATE KEY UPDATE status = VALUES(status)",
            )
            .bind(&stale_order)
            .bind(&stale_customer)
            .bind(format!("stale:{stale_suffix}"))
            .bind(utc_stamp())
            .bind(utc_stamp())
            .execute(&pool)
            .await;
            let stale_loyalty_upsert = sqlx::query(
                "INSERT INTO loyalty_logs
                 (id, customerId, orderId, pointsChange, reason, createdAt, updatedAt)
                 VALUES (?, ?, ?, 1, 'stale', ?, ?)
                 ON DUPLICATE KEY UPDATE reason = VALUES(reason)",
            )
            .bind(format!("loy-old-{stale_suffix}"))
            .bind(&stale_customer)
            .bind(&stale_order)
            .bind(utc_stamp())
            .bind(utc_stamp())
            .execute(&pool)
            .await;
            let stale_entry_upsert = sqlx::query(
                "INSERT INTO customer_account_entries
                 (id, accountId, customerId, orderId, entryType, amountPence,
                  paymentMethod, reference, description, receiptNumber, receiptKey,
                  employeeId, tillNumber, shiftId, idempotencyKey, reversesEntryId,
                  balanceAfterPence, createdAt, updatedAt)
                 VALUES (?, ?, ?, '', 'adjustment', 1, 'other', '', 'stale', 0, '',
                         '', '', '', ?, '', 1, ?, ?)
                 ON DUPLICATE KEY UPDATE description = VALUES(description)",
            )
            .bind(format!("ent-old-{stale_suffix}"))
            .bind(&stale_customer)
            .bind(&stale_customer)
            .bind(format!("stale-entry:{stale_suffix}"))
            .bind(utc_stamp())
            .bind(utc_stamp())
            .execute(&pool)
            .await;
            let stale_customer_error = stale_customer_upsert.unwrap_err().to_string();
            let stale_account_error = stale_account_upsert.unwrap_err().to_string();
            let stale_order_error = stale_order_upsert.unwrap_err().to_string();
            let stale_loyalty_error = stale_loyalty_upsert.unwrap_err().to_string();
            let stale_entry_error = stale_entry_upsert.unwrap_err().to_string();

            // A restore may legitimately rebuild a customer before it removes
            // the delete-generated tombstones and copies the backup's own
            // tombstones. Only the active gate owner with the exact session
            // bypass is allowed through; an arbitrary stale client is not.
            let restore_owner = connect_mysql_for_pos(&uri).await.unwrap();
            let restore_owner_id = format!("delete-restore-{stale_suffix}");
            sqlx::query("SET @lbj_pos_restore_bypass = ?")
                .bind(&restore_owner_id)
                .execute(&restore_owner)
                .await
                .unwrap();
            sqlx::query(
                "UPDATE pos_restore_gate
                 SET ownerTillId = ?, isActive = 1, claimedAt = ? WHERE id = 1",
            )
            .bind(&restore_owner_id)
            .bind(utc_stamp())
            .execute(&restore_owner)
            .await
            .unwrap();
            let restore_reinsert = sqlx::query(
                "INSERT INTO customers
                 (id, name, loyaltyPoints, createdAt, updatedAt)
                 VALUES (?, 'Restore-owned customer', 0, ?, ?)",
            )
            .bind(&stale_customer)
            .bind(utc_stamp())
            .bind(utc_stamp())
            .execute(&restore_owner)
            .await;
            let restore_tombstone_cleanup = if restore_reinsert.is_ok() {
                sqlx::query(
                    "DELETE FROM tombstones
                     WHERE table_name = 'customers' AND row_id = ?",
                )
                .bind(&stale_customer)
                .execute(&restore_owner)
                .await
            } else {
                Ok(Default::default())
            };
            let restore_gate_release = sqlx::query(
                "UPDATE pos_restore_gate
                 SET ownerTillId = '', isActive = 0, claimedAt = '' WHERE id = 1",
            )
            .execute(&restore_owner)
            .await;
            let _ = sqlx::query("SET @lbj_pos_restore_bypass = NULL")
                .execute(&restore_owner)
                .await;
            restore_gate_release.unwrap();
            restore_reinsert.unwrap();
            restore_tombstone_cleanup.unwrap();
            cleanup_mariadb_customer_delete_fixture(
                &pool,
                &stale_customer,
                &stale_order,
                &stale_product,
            )
            .await;

            assert!(!first_delete.already_deleted);
            assert_eq!(first_delete.account_ids, vec![stale_customer.clone()]);
            assert!(retry_delete.already_deleted);
            assert!(stale_customer_error.contains(CUSTOMER_DELETED_CODE));
            assert!(stale_account_error.contains(CUSTOMER_DELETED_CODE));
            assert!(stale_order_error.contains(CUSTOMER_DELETED_CODE));
            assert!(stale_loyalty_error.contains(CUSTOMER_DELETED_CODE));
            assert!(
                stale_entry_error.contains(CUSTOMER_DELETED_CODE)
                    || stale_entry_error.contains(ACCOUNT_LEDGER_AUTHORITY_CODE)
            );
        });
    }

    #[test]
    fn real_mariadb_account_ledger_rejects_stale_writers_when_configured() {
        let Ok(uri) = std::env::var("POS_TEST_MYSQL_URI") else {
            return;
        };
        let _serial = REAL_MARIADB_TEST_LOCK.lock().unwrap();
        tauri::async_runtime::block_on(async {
            let pool = MySqlPool::connect(&uri).await.unwrap();
            ensure_real_mariadb_test_base_schema(&pool).await.unwrap();
            ensure_mysql_restore_guard_schema(&pool).await.unwrap();
            ensure_mysql_whole_system_close_schema(&pool).await.unwrap();
            ensure_mysql_customer_deletion_guards(&pool).await.unwrap();
            ensure_mysql_account_ledger_guards(&pool).await.unwrap();
            let restore_active: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM pos_restore_gate WHERE id = 1 AND isActive = 1",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(restore_active, 0, "configured MariaDB is in restore mode");
            let server_data_epoch = configured_mariadb_server_epoch(&pool).await;
            let report_epoch = configured_mariadb_report_epoch(&pool).await;

            let suffix = format!("{:016x}", rand::random::<u64>());
            let customer_id = format!("ledger-{suffix}");
            let entry_id = format!("entry-{suffix}");
            let cleanup_order = format!("cleanup-{suffix}");
            let cleanup_product = format!("product-{suffix}");
            cleanup_mariadb_customer_delete_fixture(
                &pool,
                &customer_id,
                &cleanup_order,
                &cleanup_product,
            )
            .await;

            let stamp = utc_stamp();
            sqlx::query(
                "INSERT INTO customers
                 (id, name, loyaltyPoints, createdAt, updatedAt)
                 VALUES (?, 'Ledger guard customer', 0, ?, ?)",
            )
            .bind(&customer_id)
            .bind(&stamp)
            .bind(&stamp)
            .execute(&pool)
            .await
            .unwrap();
            save_mysql_customer_account_config(
                &pool,
                &SaveCustomerAccountConfigInput {
                    customer_id: customer_id.clone(),
                    is_enabled: true,
                    credit_limit_pence: 5_000,
                    employee_id: "ledger-test".into(),
                    server_data_epoch: server_data_epoch.clone(),
                },
            )
            .await
            .unwrap();

            let mut charge = account_change(&entry_id, "", "charge", 500, "");
            charge.customer_id = customer_id.clone();
            charge.idempotency_key = format!("ledger-charge-{suffix}");
            charge.report_epoch = report_epoch.clone();
            charge.server_data_epoch = server_data_epoch.clone();
            let native_charge = post_mysql_customer_account_entry(&pool, &charge)
                .await
                .unwrap();
            assert_eq!(native_charge.account.balance_pence, 500);

            // This is the shape used by a broad/stale table synchronizer. It
            // may update account configuration, but its copied balance is not
            // authoritative and must be rejected at the database boundary.
            let stale_upsert = sqlx::query(
                "INSERT INTO customer_accounts
                 (id, customerId, isEnabled, creditLimitPence, balancePence, createdAt, updatedAt)
                 VALUES (?, ?, 1, 5000, 1, ?, ?)
                 ON DUPLICATE KEY UPDATE
                   isEnabled = VALUES(isEnabled),
                   creditLimitPence = VALUES(creditLimitPence),
                   balancePence = VALUES(balancePence),
                   updatedAt = VALUES(updatedAt)",
            )
            .bind(&customer_id)
            .bind(&customer_id)
            .bind(&stamp)
            .bind(&stamp)
            .execute(&pool)
            .await
            .unwrap_err()
            .to_string();
            assert!(stale_upsert.contains(ACCOUNT_LEDGER_AUTHORITY_CODE));

            let stale_entry_update = sqlx::query(
                "UPDATE customer_account_entries
                 SET description = 'rewritten by stale sync' WHERE id = ?",
            )
            .bind(&entry_id)
            .execute(&pool)
            .await
            .unwrap_err()
            .to_string();
            assert!(stale_entry_update.contains(ACCOUNT_LEDGER_AUTHORITY_CODE));

            let stale_entry_delete =
                sqlx::query("DELETE FROM customer_account_entries WHERE id = ?")
                    .bind(&entry_id)
                    .execute(&pool)
                    .await
                    .unwrap_err()
                    .to_string();
            assert!(stale_entry_delete.contains(ACCOUNT_LEDGER_AUTHORITY_CODE));

            let (balance, description, entry_count): (i64, String, i64) = sqlx::query_as(
                "SELECT
                   CAST(account.balancePence AS SIGNED),
                   CAST(entry.description AS CHAR),
                   (SELECT COUNT(*) FROM customer_account_entries WHERE id = ?)
                 FROM customer_accounts account
                 JOIN customer_account_entries entry ON entry.id = ?
                 WHERE account.customerId = ?",
            )
            .bind(&entry_id)
            .bind(&entry_id)
            .bind(&customer_id)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!((balance, description, entry_count), (500, String::new(), 1));

            // Failed generic writes must neither damage the ledger nor leak a
            // privilege. A later native payment still commits atomically.
            let report_cutoff: String =
                sqlx::query_scalar("SELECT DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ')")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            thread::sleep(Duration::from_millis(5));
            let mut payment =
                account_change(&format!("payment-{suffix}"), "", "payment", -500, "cash");
            payment.customer_id = customer_id.clone();
            payment.idempotency_key = format!("ledger-payment-{suffix}");
            payment.report_epoch = report_epoch;
            payment.server_data_epoch = server_data_epoch;
            payment.created_at = "2000-01-01T00:00:00.000Z".into();
            payment.updated_at = payment.created_at.clone();
            let native_payment = post_mysql_customer_account_entry(&pool, &payment)
                .await
                .unwrap();
            assert_eq!(native_payment.account.balance_pence, 0);
            assert_ne!(native_payment.entry.created_at, payment.created_at);
            assert!(native_payment.entry.created_at >= report_cutoff);
            let report_end: String = sqlx::query_scalar(
                "SELECT DATE_FORMAT(TIMESTAMPADD(SECOND, 1, UTC_TIMESTAMP(3)),
                                    '%Y-%m-%dT%H:%i:%s.%fZ')",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            let collected_after_cutoff: i64 = sqlx::query_scalar(
                "SELECT CAST(COALESCE(SUM(-amountPence), 0) AS SIGNED)
                 FROM customer_account_entries
                 WHERE entryType = 'payment' AND paymentMethod = 'cash'
                   AND amountPence < 0 AND createdAt >= ? AND createdAt < ?",
            )
            .bind(&report_cutoff)
            .bind(&report_end)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(collected_after_cutoff, 500);

            let replay = post_mysql_customer_account_entry(&pool, &payment)
                .await
                .unwrap();
            assert_eq!(replay.entry.created_at, native_payment.entry.created_at);

            cleanup_mariadb_customer_delete_fixture(
                &pool,
                &customer_id,
                &cleanup_order,
                &cleanup_product,
            )
            .await;
            pool.close().await;
        });
    }

    #[test]
    fn real_mariadb_whole_system_close_serializes_writers_and_recovers_expiry_when_configured() {
        let Ok(uri) = std::env::var("POS_TEST_MYSQL_URI") else {
            return;
        };
        let _serial = REAL_MARIADB_TEST_LOCK.lock().unwrap();
        tauri::async_runtime::block_on(async {
            let pool = MySqlPool::connect(&uri).await.unwrap();
            ensure_real_mariadb_test_base_schema(&pool).await.unwrap();
            // This focused test also works against the dedicated empty schema
            // used in CI/developer simulations.
            for sql in [
                "CREATE TABLE IF NOT EXISTS registers (
                    id VARCHAR(64) PRIMARY KEY, name VARCHAR(255), isActive TINYINT DEFAULT 1
                 ) ENGINE=InnoDB",
                "CREATE TABLE IF NOT EXISTS till_presence (
                    tillId VARCHAR(64) PRIMARY KEY, tillName VARCHAR(255) NOT NULL,
                    lastSeenAt DATETIME(3) NOT NULL
                 ) ENGINE=InnoDB",
                "CREATE TABLE IF NOT EXISTS products (
                    id VARCHAR(36) PRIMARY KEY, name TEXT, price BIGINT DEFAULT 0,
                    costPrice BIGINT DEFAULT 0, stockLevel BIGINT DEFAULT 0,
                    trackStock TINYINT DEFAULT 0, isActive TINYINT DEFAULT 1,
                    sku VARCHAR(191), createdAt TEXT, updatedAt TEXT
                 ) ENGINE=InnoDB",
                "CREATE TABLE IF NOT EXISTS orders (
                    id VARCHAR(36) PRIMARY KEY, total BIGINT DEFAULT 0,
                    discountAmount BIGINT DEFAULT 0, taxTotal BIGINT DEFAULT 0,
                    tillNumber VARCHAR(64),
                    type VARCHAR(32) NOT NULL DEFAULT 'sale',
                    status VARCHAR(32) NOT NULL DEFAULT 'completed', notes TEXT,
                    completedAt DATETIME(3) NULL
                 ) ENGINE=InnoDB",
                "CREATE TABLE IF NOT EXISTS order_lines (
                    id VARCHAR(36) PRIMARY KEY, orderId VARCHAR(36) NOT NULL,
                    productId VARCHAR(36), productName TEXT,
                    quantity BIGINT DEFAULT 0, lineTotal BIGINT DEFAULT 0
                 ) ENGINE=InnoDB",
                "CREATE TABLE IF NOT EXISTS payments (
                    id VARCHAR(36) PRIMARY KEY, orderId VARCHAR(36), method VARCHAR(32),
                    amount BIGINT DEFAULT 0, cashAmount BIGINT DEFAULT 0,
                    cardAmount BIGINT DEFAULT 0, loyaltyAmount BIGINT DEFAULT 0,
                    accountAmount BIGINT DEFAULT 0,
                    tipsAmount BIGINT NOT NULL DEFAULT 0,
                    serviceChargeAmount BIGINT NOT NULL DEFAULT 0,
                    cashbackAmount BIGINT NOT NULL DEFAULT 0
                 ) ENGINE=InnoDB",
                "CREATE TABLE IF NOT EXISTS customer_account_entries (
                    id VARCHAR(36) PRIMARY KEY, entryType VARCHAR(32),
                    paymentMethod VARCHAR(32), amountPence BIGINT DEFAULT 0,
                    tipsAmount BIGINT NOT NULL DEFAULT 0,
                    serviceChargeAmount BIGINT NOT NULL DEFAULT 0,
                    cashbackAmount BIGINT NOT NULL DEFAULT 0,
                    tillNumber VARCHAR(64), createdAt DATETIME(3) NULL
                 ) ENGINE=InnoDB",
                "CREATE TABLE IF NOT EXISTS payment_terminal_attempts (
                    id VARCHAR(64) PRIMARY KEY, status VARCHAR(32) NOT NULL
                 ) ENGINE=InnoDB",
                "CREATE TABLE IF NOT EXISTS till_report_markers (
                    id VARCHAR(36) PRIMARY KEY, tillNumber VARCHAR(36) NOT NULL,
                    type VARCHAR(32) NOT NULL, markerTime TEXT NOT NULL,
                    periodStart TEXT, periodEnd TEXT, employeeId VARCHAR(36),
                    reportText TEXT, reportTotal BIGINT DEFAULT 0,
                    createdAt TEXT, updatedAt TEXT
                 ) ENGINE=InnoDB",
            ] {
                sqlx::query(sql).execute(&pool).await.unwrap();
            }
            sqlx::query("ALTER TABLE products ADD COLUMN IF NOT EXISTS sku VARCHAR(191) NULL")
                .execute(&pool)
                .await
                .unwrap();
            for sql in [
                "ALTER TABLE orders ADD COLUMN IF NOT EXISTS discountAmount BIGINT DEFAULT 0",
                "ALTER TABLE orders ADD COLUMN IF NOT EXISTS taxTotal BIGINT DEFAULT 0",
                "ALTER TABLE orders ADD COLUMN IF NOT EXISTS tillNumber VARCHAR(64) NULL",
                "ALTER TABLE customer_account_entries ADD COLUMN IF NOT EXISTS tillNumber VARCHAR(64) NULL",
                "ALTER TABLE payment_terminal_attempts ADD COLUMN IF NOT EXISTS tillId VARCHAR(64) NULL",
                "ALTER TABLE payments ADD COLUMN IF NOT EXISTS tipsAmount BIGINT NOT NULL DEFAULT 0",
                "ALTER TABLE payments ADD COLUMN IF NOT EXISTS serviceChargeAmount BIGINT NOT NULL DEFAULT 0",
                "ALTER TABLE payments ADD COLUMN IF NOT EXISTS cashbackAmount BIGINT NOT NULL DEFAULT 0",
                "ALTER TABLE customer_account_entries ADD COLUMN IF NOT EXISTS tipsAmount BIGINT NOT NULL DEFAULT 0",
                "ALTER TABLE customer_account_entries ADD COLUMN IF NOT EXISTS serviceChargeAmount BIGINT NOT NULL DEFAULT 0",
                "ALTER TABLE customer_account_entries ADD COLUMN IF NOT EXISTS cashbackAmount BIGINT NOT NULL DEFAULT 0",
            ] {
                sqlx::query(sql).execute(&pool).await.unwrap();
            }
            ensure_mysql_whole_system_close_schema(&pool).await.unwrap();
            ensure_mysql_account_ledger_guards(&pool).await.unwrap();

            let suffix = format!("{:016x}", rand::random::<u64>());
            let till_id = format!("z-till-{suffix}");
            let zero_till_id = format!("z-zero-till-{suffix}");
            let product_id = format!("z-product-{suffix}");
            let order_id = format!("z-order-{suffix}");
            let legacy_order_id = format!("z-legacy-order-{suffix}");
            let legacy_line_id = format!("z-legacy-line-{suffix}");
            let legacy_payment_id = format!("z-legacy-payment-{suffix}");
            let stale_order_id = format!("z-stale-order-{suffix}");
            let account_payment_id = format!("z-account-other-{suffix}");
            let account_id = format!("z-account-{suffix}");
            let account_customer_id = format!("z-customer-{suffix}");
            let start_marker_id = format!("z-start-{suffix}");
            let finish_marker_id = format!("z-finish-{suffix}");
            let till_finish_marker_id = format!("z-till-close-{suffix}");
            sqlx::query(
                "UPDATE pos_close_barrier
                 SET token = '', state = 'idle', ownerTillId = '', requestedAt = NULL,
                     expiresAt = NULL, cutoffAt = NULL WHERE id = 1",
            )
            .execute(&pool)
            .await
            .unwrap();
            sqlx::query("DELETE FROM registers")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("DELETE FROM till_presence")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("DELETE FROM payment_terminal_attempts")
                .execute(&pool)
                .await
                .unwrap();
            cleanup_mariadb_customer_delete_fixture(
                &pool,
                &account_customer_id,
                &order_id,
                &product_id,
            )
            .await;
            sqlx::query("DELETE FROM payments WHERE orderId IN (?, ?)")
                .bind(&order_id)
                .bind(&legacy_order_id)
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("DELETE FROM order_lines WHERE orderId IN (?, ?)")
                .bind(&order_id)
                .bind(&legacy_order_id)
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("DELETE FROM orders WHERE id IN (?, ?)")
                .bind(&order_id)
                .bind(&legacy_order_id)
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("DELETE FROM till_report_markers WHERE id IN (?, ?)")
                .bind(&start_marker_id)
                .bind(&finish_marker_id)
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("DELETE FROM products WHERE id = ?")
                .bind(&product_id)
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO registers (id, name, isActive) VALUES (?, 'Z test till', 1)")
                .bind(&till_id)
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query(
                "INSERT INTO registers (id, name, isActive) VALUES (?, 'Z zero-sales till', 1)",
            )
            .bind(&zero_till_id)
            .execute(&pool)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO till_presence
                    (tillId, tillName, closeProtocolVersion, closeBarrierToken,
                     closeBarrierPhase, outboxCount, localTerminalAttemptCount,
                     syncConflictCount, barrierObservedAt, lastSeenAt)
                 VALUES (?, 'Z test till', ?, '', '', 0, 0, 0,
                         NULL, UTC_TIMESTAMP(3)),
                        (?, 'Z zero-sales till', ?, '', '', 0, 0, 0,
                         NULL, UTC_TIMESTAMP(3))",
            )
            .bind(&till_id)
            .bind(WHOLE_SYSTEM_CLOSE_PROTOCOL_VERSION)
            .bind(&zero_till_id)
            .bind(WHOLE_SYSTEM_CLOSE_PROTOCOL_VERSION)
            .execute(&pool)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO products
                    (id, name, price, stockLevel, trackStock, isActive, createdAt, updatedAt)
                 VALUES (?, 'Z barrier product', 100, 10, 1, 1, '', '')",
            )
            .bind(&product_id)
            .execute(&pool)
            .await
            .unwrap();
            let account_stamp = utc_stamp();
            sqlx::query(
                "INSERT INTO customers
                    (id, name, loyaltyPoints, createdAt, updatedAt)
                 VALUES (?, 'Z close report customer', 0, ?, ?)",
            )
            .bind(&account_customer_id)
            .bind(&account_stamp)
            .bind(&account_stamp)
            .execute(&pool)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO customer_accounts
                    (id, customerId, isEnabled, creditLimitPence, balancePence,
                     createdAt, updatedAt)
                 VALUES (?, ?, 1, 0, 0, ?, ?)",
            )
            .bind(&account_id)
            .bind(&account_customer_id)
            .bind(&account_stamp)
            .bind(&account_stamp)
            .execute(&pool)
            .await
            .unwrap();
            let period_start: String =
                sqlx::query_scalar("SELECT DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ')")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            sqlx::query(
                "INSERT INTO till_report_markers
                    (id, tillNumber, type, markerTime, periodStart, periodEnd,
                     employeeId, reportText, reportTotal, createdAt, updatedAt)
                 VALUES (?, '', 'period', ?, ?, ?, '', '', 0, ?, ?)",
            )
            .bind(&start_marker_id)
            .bind(&period_start)
            .bind(&period_start)
            .bind(&period_start)
            .bind(&period_start)
            .bind(&period_start)
            .execute(&pool)
            .await
            .unwrap();
            let begun = begin_whole_system_close(uri.clone(), till_id.clone())
                .await
                .unwrap();
            let token = begun.token;
            assert_eq!(begun.latest_marker.as_deref(), Some(period_start.as_str()));
            sqlx::query(
                "UPDATE till_presence
                 SET closeBarrierToken = ?, closeBarrierPhase = 'prepared',
                     barrierObservedAt = UTC_TIMESTAMP(3), lastSeenAt = UTC_TIMESTAMP(3)
                 WHERE tillId IN (?, ?)",
            )
            .bind(&token)
            .bind(&till_id)
            .bind(&zero_till_id)
            .execute(&pool)
            .await
            .unwrap();

            // The raw writer represents an old client with no native preflight.
            // Its v2 trigger locks the singleton barrier until this transaction
            // commits, so freeze cannot establish a cutoff ahead of it.
            let mut writer_tx = pool.begin().await.unwrap();
            let writer_account_authority = grant_mysql_account_write_authority(&mut writer_tx)
                .await
                .unwrap();
            sqlx::query(
                "INSERT INTO orders
                    (id, total, discountAmount, taxTotal, tillNumber,
                     type, status, notes, completedAt)
                 VALUES (?, 100, 20, 17, ?, 'sale', 'completed', '',
                         DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ'))",
            )
            .bind(&order_id)
            .bind(&till_id)
            .execute(&mut *writer_tx)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO order_lines
                    (id, orderId, productId, productName, quantity, lineTotal)
                 VALUES (?, ?, ?, 'Z barrier product', 1, 100)",
            )
            .bind(format!("z-line-{suffix}"))
            .bind(&order_id)
            .bind(&product_id)
            .execute(&mut *writer_tx)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO payments
                    (id, orderId, method, amount, cashAmount, cardAmount,
                     loyaltyAmount, accountAmount)
                 VALUES (?, ?, 'cash', 100, 100, 0, 0, 0)",
            )
            .bind(format!("z-payment-{suffix}"))
            .bind(&order_id)
            .execute(&mut *writer_tx)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO orders
                    (id, total, discountAmount, taxTotal, tillNumber,
                     type, status, notes, completedAt)
                 VALUES (?, 40, 5, 7, '', 'sale', 'completed', '',
                         DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ'))",
            )
            .bind(&legacy_order_id)
            .execute(&mut *writer_tx)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO order_lines
                    (id, orderId, productId, productName, quantity, lineTotal)
                 VALUES (?, ?, ?, 'Z barrier product', 2, 40)",
            )
            .bind(&legacy_line_id)
            .bind(&legacy_order_id)
            .bind(&product_id)
            .execute(&mut *writer_tx)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO payments
                    (id, orderId, method, amount, cashAmount, cardAmount,
                     loyaltyAmount, accountAmount)
                 VALUES (?, ?, 'card', 40, 0, 40, 0, 0)",
            )
            .bind(&legacy_payment_id)
            .bind(&legacy_order_id)
            .execute(&mut *writer_tx)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO customer_account_entries
                    (id, accountId, customerId, entryType, paymentMethod,
                     amountPence, reference, description, idempotencyKey,
                     balanceAfterPence, tillNumber, createdAt, updatedAt)
                 VALUES (?, ?, ?, 'payment', 'other', -60, '',
                         'Whole-system close integration fixture', ?, -60,
                         ?,
                         DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ'),
                         DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ'))",
            )
            .bind(&account_payment_id)
            .bind(&account_id)
            .bind(&account_customer_id)
            .bind(format!("z-close:{suffix}"))
            .bind(&till_id)
            .execute(&mut *writer_tx)
            .await
            .unwrap();
            sqlx::query(
                "UPDATE products SET stockLevel = stockLevel + 1,
                                     updatedAt = DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ')
                 WHERE id = ?",
            )
            .bind(&product_id)
            .execute(&mut *writer_tx)
            .await
            .unwrap();
            revoke_mysql_account_write_authority(&mut writer_tx, &writer_account_authority)
                .await
                .unwrap();

            let freeze_uri = uri.clone();
            let freeze_token = token.clone();
            let freeze_owner = till_id.clone();
            let freeze_task = tauri::async_runtime::spawn(async move {
                freeze_whole_system_close(freeze_uri, freeze_token, freeze_owner).await
            });
            tauri::async_runtime::spawn_blocking(|| thread::sleep(Duration::from_millis(180)))
                .await
                .unwrap();
            let state_while_writer_open: String = sqlx::query_scalar(
                "SELECT CAST(state AS CHAR CHARACTER SET utf8mb4)
                 FROM pos_close_barrier WHERE id = 1",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(state_while_writer_open, "preparing");

            writer_tx.commit().await.unwrap();
            let frozen = freeze_task.await.unwrap().unwrap();
            assert_eq!(frozen.state, "frozen");
            let writer_stamp: String = sqlx::query_scalar(
                "SELECT DATE_FORMAT(completedAt, '%Y-%m-%dT%H:%i:%s.%fZ')
                 FROM orders WHERE id = ?",
            )
            .bind(&order_id)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert!(
                writer_stamp < frozen.cutoff_at,
                "a writer on the freeze server tick must remain before the exclusive successor cutoff"
            );
            let included_stock: i64 =
                sqlx::query_scalar("SELECT stockLevel FROM products WHERE id = ?")
                    .bind(&product_id)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(included_stock, 11);

            sqlx::query(
                "UPDATE till_presence
                 SET closeBarrierPhase = 'frozen', barrierObservedAt = UTC_TIMESTAMP(3),
                     lastSeenAt = UTC_TIMESTAMP(3) WHERE tillId IN (?, ?)",
            )
            .bind(&till_id)
            .bind(&zero_till_id)
            .execute(&pool)
            .await
            .unwrap();
            let snapshot = get_frozen_whole_system_report(
                uri.clone(),
                token.clone(),
                till_id.clone(),
                period_start.clone(),
            )
            .await
            .unwrap();
            assert_eq!(snapshot.overview.total_revenue, 140);
            assert_eq!(snapshot.overview.total_transactions, 2);
            assert_eq!(snapshot.breakdown.total_cash, 100);
            assert_eq!(snapshot.breakdown.total_card, 40);
            assert_eq!(snapshot.breakdown.account_repayments_other, 60);
            assert_eq!(snapshot.till_summaries.len(), 3);
            let selling_till = snapshot
                .till_summaries
                .iter()
                .find(|summary| summary.id == till_id)
                .expect("selling till summary");
            assert_eq!(selling_till.name, "Z test till");
            assert_eq!(selling_till.net_sales, 100);
            assert_eq!(selling_till.gross_sales, 120);
            assert_eq!(selling_till.tax_total, 17);
            assert_eq!(selling_till.transactions, 1);
            assert_eq!(selling_till.items_sold, 1);
            assert_eq!(selling_till.cash_total, 100);
            assert_eq!(selling_till.card_total, 0);
            assert_eq!(selling_till.account_repayments_other, 60);
            let zero_sales_till = snapshot
                .till_summaries
                .iter()
                .find(|summary| summary.id == zero_till_id)
                .expect("active zero-sales till summary");
            assert_eq!(zero_sales_till.name, "Z zero-sales till");
            assert_eq!(zero_sales_till.net_sales, 0);
            assert_eq!(zero_sales_till.gross_sales, 0);
            assert_eq!(zero_sales_till.transactions, 0);
            assert_eq!(zero_sales_till.items_sold, 0);
            let legacy_till = snapshot
                .till_summaries
                .iter()
                .find(|summary| summary.id.is_empty())
                .expect("unassigned legacy till summary");
            assert_eq!(legacy_till.name, "Unassigned / legacy");
            assert_eq!(legacy_till.net_sales, 40);
            assert_eq!(legacy_till.gross_sales, 45);
            assert_eq!(legacy_till.tax_total, 7);
            assert_eq!(legacy_till.transactions, 1);
            assert_eq!(legacy_till.items_sold, 2);
            assert_eq!(legacy_till.cash_total, 0);
            assert_eq!(legacy_till.card_total, 40);
            assert_eq!(
                snapshot.expected_last_marker.as_deref(),
                Some(period_start.as_str())
            );

            let blocked = sqlx::query("UPDATE products SET stockLevel = 12 WHERE id = ?")
                .bind(&product_id)
                .execute(&pool)
                .await
                .unwrap_err()
                .to_string();
            assert!(blocked.contains(WHOLE_SYSTEM_CLOSE_IN_PROGRESS_CODE));

            let finished = finish_whole_system_close(
                uri.clone(),
                FinishWholeSystemCloseInput {
                    token: token.clone(),
                    owner_till_id: till_id.clone(),
                    id: finish_marker_id.clone(),
                    expected_last_marker: Some(period_start.clone()),
                    period_start: period_start.clone(),
                    employee_id: "z-test-manager".into(),
                    report_text: "Z close integration test".into(),
                    report_total: snapshot.overview.total_revenue,
                },
            )
            .await
            .unwrap();
            assert_eq!(finished.marker_time, snapshot.cutoff_at);
            let state_after_finish: String = sqlx::query_scalar(
                "SELECT CAST(state AS CHAR CHARACTER SET utf8mb4)
                 FROM pos_close_barrier WHERE id = 1",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(state_after_finish, "idle");
            let last_closed_after_finish: String = sqlx::query_scalar(
                "SELECT CAST(DATE_FORMAT(lastClosedAt, '%Y-%m-%dT%H:%i:%s.%fZ')
                             AS CHAR CHARACTER SET utf8mb4)
                 FROM pos_close_barrier WHERE id = 1",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(last_closed_after_finish, snapshot.cutoff_at);

            // A whole-shop Z closes every till's previous period. A later till
            // Z must not repeat the £1 sale included above, even when that till
            // has never been individually closed. Its own close must also not
            // advance the shop-wide period (otherwise the next shop report
            // would silently omit sales on other tills).
            tokio::time::sleep(Duration::from_millis(20)).await;
            let till_after_system = prepare_till_report_close(uri.clone(), till_id.clone())
                .await
                .unwrap();
            let system_cutoff = canonical_report_epoch(&snapshot.cutoff_at).unwrap();
            assert_eq!(till_after_system.period_start, system_cutoff);
            assert_eq!(till_after_system.overview.total_revenue, 0);
            assert_eq!(till_after_system.overview.total_transactions, 0);
            let till_closed = commit_till_report_close(
                uri.clone(),
                CommitTillReportCloseInput {
                    id: till_finish_marker_id.clone(),
                    till_number: till_id.clone(),
                    expected_last_marker: till_after_system.expected_last_marker,
                    period_start: till_after_system.period_start,
                    period_end: till_after_system.cutoff_at,
                    employee_id: "z-test-manager".into(),
                    report_text: "Till close after whole-system close".into(),
                    report_total: 0,
                },
            )
            .await
            .unwrap();
            let mut verify_markers = pool.begin().await.unwrap();
            assert_eq!(
                latest_system_report_marker(&mut verify_markers, false).await.unwrap(),
                Some(snapshot.cutoff_at.clone()),
            );
            assert_eq!(
                latest_effective_till_report_marker(&mut verify_markers, &till_id).await.unwrap(),
                Some(till_closed.marker_time),
            );
            assert_eq!(
                latest_effective_till_report_marker(&mut verify_markers, &zero_till_id).await.unwrap(),
                Some(system_cutoff),
            );
            verify_markers.commit().await.unwrap();
            let stale_after_finish = sqlx::query(
                "INSERT INTO orders (id, total, type, status, notes, completedAt)
                 VALUES (?, 100, 'sale', 'completed', '',
                         STR_TO_DATE(REPLACE(REPLACE(?, 'T', ' '), 'Z', ''),
                                     '%Y-%m-%d %H:%i:%s.%f'))",
            )
            .bind(&stale_order_id)
            .bind(&period_start)
            .execute(&pool)
            .await
            .unwrap_err()
            .to_string();
            assert!(
                stale_after_finish.contains("REPORT_PERIOD_CLOSED"),
                "unexpected stale-order error: {stale_after_finish}"
            );

            // A stranded frozen lease self-recovers in the permanent trigger;
            // old clients resume without administrator intervention.
            sqlx::query(
                "UPDATE pos_close_barrier
                 SET token = 'expired-test', state = 'frozen', ownerTillId = ?,
                     requestedAt = TIMESTAMPADD(SECOND, -10, UTC_TIMESTAMP(3)),
                     cutoffAt = TIMESTAMPADD(SECOND, -5, UTC_TIMESTAMP(3)),
                     expiresAt = TIMESTAMPADD(SECOND, -1, UTC_TIMESTAMP(3))
                 WHERE id = 1",
            )
            .bind(&till_id)
            .execute(&pool)
            .await
            .unwrap();
            sqlx::query("UPDATE products SET stockLevel = 13 WHERE id = ?")
                .bind(&product_id)
                .execute(&pool)
                .await
                .unwrap();
            let recovered_state: String = sqlx::query_scalar(
                "SELECT CAST(state AS CHAR CHARACTER SET utf8mb4)
                 FROM pos_close_barrier WHERE id = 1",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(recovered_state, "idle");

            sqlx::query("DELETE FROM payments WHERE orderId IN (?, ?)")
                .bind(&order_id)
                .bind(&legacy_order_id)
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("DELETE FROM order_lines WHERE orderId IN (?, ?)")
                .bind(&order_id)
                .bind(&legacy_order_id)
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("DELETE FROM orders WHERE id IN (?, ?)")
                .bind(&order_id)
                .bind(&legacy_order_id)
                .execute(&pool)
                .await
                .unwrap();
            cleanup_mariadb_customer_delete_fixture(
                &pool,
                &account_customer_id,
                &order_id,
                &product_id,
            )
            .await;
            sqlx::query("DELETE FROM till_report_markers WHERE id IN (?, ?)")
                .bind(&start_marker_id)
                .bind(&finish_marker_id)
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("DELETE FROM till_report_markers WHERE id = ?")
                .bind(&till_finish_marker_id)
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("DELETE FROM products WHERE id = ?")
                .bind(&product_id)
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("DELETE FROM till_presence WHERE tillId = ?")
                .bind(&till_id)
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("DELETE FROM registers WHERE id IN (?, ?)")
                .bind(&till_id)
                .bind(&zero_till_id)
                .execute(&pool)
                .await
                .unwrap();
            pool.close().await;
        });
    }

    #[test]
    fn real_mariadb_two_till_simulation_when_configured() {
        let Ok(uri) = std::env::var("POS_TEST_MYSQL_URI") else {
            return;
        };
        let _serial = REAL_MARIADB_TEST_LOCK.lock().unwrap();
        tauri::async_runtime::block_on(async {
            let pool = MySqlPool::connect(&uri).await.unwrap();
            ensure_real_mariadb_test_base_schema(&pool).await.unwrap();
            ensure_mysql_restore_guard_schema(&pool).await.unwrap();
            ensure_mysql_whole_system_close_schema(&pool).await.unwrap();
            // Recover safely if a prior explicitly configured integration run
            // was interrupted while exercising the gate.
            sqlx::query("UPDATE pos_restore_gate SET isActive = 0 WHERE id = 1")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("DELETE FROM audit_logs WHERE entityId LIKE 'simulation-order-%'")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("DELETE FROM inventory_logs WHERE referenceId LIKE 'simulation-order-%'")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("DELETE FROM payments WHERE orderId LIKE 'simulation-order-%'")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("DELETE FROM order_lines WHERE orderId LIKE 'simulation-order-%'")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("DELETE FROM orders WHERE id LIKE 'simulation-order-%'")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query(
                "INSERT INTO products (id, name, price, stockLevel, trackStock, updatedAt)
                 VALUES ('simulation-product', 'Two Till Test Product', 100, 10, 1, '2026-06-07T12:00:00.000Z')
                 ON DUPLICATE KEY UPDATE stockLevel = 10, updatedAt = VALUES(updatedAt)"
            ).execute(&pool).await.unwrap();

            let mut till_one = bundle(
                "simulation-order-1",
                "till-1:1000001",
                "simulation-payment-1",
            );
            let server_data_epoch = configured_mariadb_server_epoch(&pool).await;
            let report_epoch = configured_mariadb_report_epoch(&pool).await;
            till_one.server_data_epoch = server_data_epoch.clone();
            till_one.report_epoch = report_epoch.clone();
            till_one.lines[0].product_id = "simulation-product".into();
            till_one.stock_changes[0].product_id = "simulation-product".into();
            let mut till_two = bundle(
                "simulation-order-2",
                "till-2:2000001",
                "simulation-payment-2",
            );
            till_two.server_data_epoch = server_data_epoch;
            till_two.report_epoch = report_epoch;
            till_two.lines[0].product_id = "simulation-product".into();
            till_two.stock_changes[0].product_id = "simulation-product".into();
            let replay_one = till_one.clone();
            let pool_one = pool.clone();
            let pool_two = pool.clone();
            let one = tauri::async_runtime::spawn(async move {
                insert_mysql_bundle(&pool_one, &till_one).await
            });
            let two = tauri::async_runtime::spawn(async move {
                insert_mysql_bundle(&pool_two, &till_two).await
            });
            let committed_one = one.await.unwrap().unwrap();
            two.await.unwrap().unwrap();

            let stock: i64 = sqlx::query_scalar(
                "SELECT stockLevel FROM products WHERE id = 'simulation-product'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            let orders: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM orders WHERE id LIKE 'simulation-order-%'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(stock, 8);
            assert_eq!(orders, 2);

            for (table, event) in [("orders", "INSERT"), ("settings", "INSERT")] {
                let trigger_name = format!("lbj_guard_v4_{table}_insert");
                let action_order: i64 = sqlx::query_scalar(
                    "SELECT CAST(ACTION_ORDER AS SIGNED)
                     FROM INFORMATION_SCHEMA.TRIGGERS
                     WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME = ?
                       AND EVENT_OBJECT_TABLE = ? AND EVENT_MANIPULATION = ?",
                )
                .bind(&trigger_name)
                .bind(table)
                .bind(event)
                .fetch_one(&pool)
                .await
                .unwrap();
                assert_eq!(action_order, 1, "{trigger_name} must run first");

                let legacy_count: i64 = sqlx::query_scalar(
                    "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TRIGGERS
                     WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME = ?",
                )
                .bind(format!("lbj_guard_v3_{table}_insert"))
                .fetch_one(&pool)
                .await
                .unwrap();
                assert_eq!(legacy_count, 0, "V3 must be retired only after V4 exists");
            }

            // Lost-response replay reconstructs the server stamps and verifies
            // every relational child without applying stock twice.
            let replayed = insert_mysql_bundle(&pool, &replay_one).await.unwrap();
            assert_eq!(replayed.order.updated_at, committed_one.order.updated_at);
            assert_eq!(
                replayed.payment.updated_at,
                committed_one.payment.updated_at
            );
            let stock_after_replay: i64 = sqlx::query_scalar(
                "SELECT stockLevel FROM products WHERE id = 'simulation-product'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(stock_after_replay, 8);

            // An unstamped/wrong-epoch intent is rejected under the same
            // barrier/gate transaction before it can create an order.
            let remote_epoch: Option<String> = sqlx::query_scalar(
                "SELECT CAST(value AS CHAR) FROM settings
                 WHERE `key` = 'server_data_epoch' LIMIT 1",
            )
            .fetch_optional(&pool)
            .await
            .unwrap();
            let wrong_epoch = format!(
                "{}-definitely-not-this-epoch",
                remote_epoch.as_deref().unwrap_or("empty")
            );
            let epoch_suffix = format!("{:016x}", rand::random::<u64>());
            let epoch_order_id = format!("simulation-order-epoch-{epoch_suffix}");
            let mut epoch_bundle = bundle(
                &epoch_order_id,
                &format!("epoch:{epoch_suffix}"),
                &format!("simulation-payment-epoch-{epoch_suffix}"),
            );
            epoch_bundle.lines[0].product_id = "simulation-product".into();
            epoch_bundle.stock_changes[0].product_id = "simulation-product".into();
            let epoch_error =
                insert_mysql_bundle_with_intent_epoch(&pool, &epoch_bundle, Some(&wrong_epoch))
                    .await
                    .unwrap_err()
                    .to_string();
            assert!(epoch_error.contains(ONLINE_FINANCIAL_INTENT_EPOCH_CODE));
            let epoch_order_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM orders WHERE id = ?")
                    .bind(&epoch_order_id)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(epoch_order_count, 0);

            // A partial historical graph must not be "repaired", because the
            // stock/loyalty side effects may already have happened.
            sqlx::query("DELETE FROM payments WHERE orderId = 'simulation-order-1'")
                .execute(&pool)
                .await
                .unwrap();
            let partial_error = insert_mysql_bundle(&pool, &replay_one)
                .await
                .unwrap_err()
                .to_string();
            assert!(partial_error.contains("SYNC_CONFLICT"));

            // Hold the gate on one dedicated session. A current native writer
            // must fail at transaction preflight, while an old/raw writer which
            // skips that preflight must still be rejected by the DB trigger.
            let owner = connect_mysql_for_pos(&uri).await.unwrap();
            sqlx::query("SET @lbj_pos_restore_bypass = 'restore-gate-test-owner'")
                .execute(&owner)
                .await
                .unwrap();
            let previous_last_closed: Option<String> = sqlx::query_scalar(
                "SELECT CAST(DATE_FORMAT(lastClosedAt, '%Y-%m-%dT%H:%i:%s.%fZ')
                             AS CHAR CHARACTER SET utf8mb4)
                 FROM pos_close_barrier WHERE id = 1",
            )
            .fetch_one(&owner)
            .await
            .unwrap();
            sqlx::query("DELETE FROM settings WHERE `key` = 'restore_gate_concurrency_test'")
                .execute(&owner)
                .await
                .unwrap();
            sqlx::query(
                "UPDATE pos_restore_gate
                 SET ownerTillId = 'restore-gate-test-owner', isActive = 1,
                     claimedAt = '2026-07-29T12:00:00.000Z'
                 WHERE id = 1",
            )
            .execute(&owner)
            .await
            .unwrap();

            // A full restore owns historical timestamps. Both the first V4
            // trigger and the replacement cutoff trigger must honor only the
            // active claiming session's bypass even when a prior Z cutoff is
            // already present.
            // Keep generated fixture ids within the production VARCHAR(36)
            // contract while retaining the common cleanup prefix.
            let restore_order_id = format!("simulation-order-r-{epoch_suffix}");
            sqlx::query(
                "UPDATE pos_close_barrier SET lastClosedAt = UTC_TIMESTAMP(3) WHERE id = 1",
            )
            .execute(&owner)
            .await
            .unwrap();
            let restore_insert_result = sqlx::query(
                "INSERT INTO orders
                    (id, receiptKey, type, status, total, createdAt, completedAt, updatedAt)
                 VALUES (?, ?, 'sale', 'completed', 0,
                         '2000-01-01T00:00:00.000Z',
                         '2000-01-01T00:00:00.000Z',
                         '2000-01-01T00:00:00.000Z')",
            )
            .bind(&restore_order_id)
            .bind(format!("restore:{epoch_suffix}"))
            .execute(&owner)
            .await;
            let restored_historical_count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM orders WHERE id = ?")
                    .bind(&restore_order_id)
                    .fetch_one(&owner)
                    .await
                    .unwrap();
            let _ = sqlx::query("DELETE FROM orders WHERE id = ?")
                .bind(&restore_order_id)
                .execute(&owner)
                .await;
            sqlx::query(
                "UPDATE pos_close_barrier
                 SET lastClosedAt = STR_TO_DATE(
                   REPLACE(REPLACE(NULLIF(?, ''), 'T', ' '), 'Z', ''),
                   '%Y-%m-%d %H:%i:%s.%f'
                 ) WHERE id = 1",
            )
            .bind(previous_last_closed.as_deref().unwrap_or(""))
            .execute(&owner)
            .await
            .unwrap();

            let raw_writer_result = sqlx::query(
                "INSERT INTO settings (`key`, value, updatedAt)
                 VALUES ('restore_gate_concurrency_test', 'raw-writer', '')",
            )
            .execute(&pool)
            .await;
            let mut native_tx = pool.begin().await.unwrap();
            let native_writer_result = assert_mysql_restore_writes_allowed(&mut native_tx).await;
            let _ = native_tx.rollback().await;
            let owner_writer_result = sqlx::query(
                "INSERT INTO settings (`key`, value, updatedAt)
                 VALUES ('restore_gate_concurrency_test', 'restore-owner', '')",
            )
            .execute(&owner)
            .await;

            // Always release the test gate before asserting, so a failed test
            // cannot strand the configured developer database in maintenance.
            let _ =
                sqlx::query("DELETE FROM settings WHERE `key` = 'restore_gate_concurrency_test'")
                    .execute(&owner)
                    .await;
            sqlx::query("UPDATE pos_restore_gate SET isActive = 0 WHERE id = 1")
                .execute(&owner)
                .await
                .unwrap();
            let _ = sqlx::query("SET @lbj_pos_restore_bypass = NULL")
                .execute(&owner)
                .await;

            let raw_error = raw_writer_result.unwrap_err().to_string();
            assert!(raw_error.contains(MARIADB_RESTORE_MAINTENANCE_CODE));
            let native_error = native_writer_result.unwrap_err().to_string();
            assert!(native_error.contains(MARIADB_RESTORE_MAINTENANCE_CODE));
            owner_writer_result.unwrap();
            restore_insert_result.unwrap();
            assert_eq!(restored_historical_count, 1);

            sqlx::query("DELETE FROM audit_logs WHERE entityId LIKE 'simulation-order-%'")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("DELETE FROM inventory_logs WHERE referenceId LIKE 'simulation-order-%'")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("DELETE FROM payments WHERE orderId LIKE 'simulation-order-%'")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("DELETE FROM order_lines WHERE orderId LIKE 'simulation-order-%'")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("DELETE FROM orders WHERE id LIKE 'simulation-order-%'")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("DELETE FROM products WHERE id = 'simulation-product'")
                .execute(&pool)
                .await
                .unwrap();
        });
    }
}
