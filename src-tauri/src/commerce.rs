use rand::{rngs::OsRng, RngCore};
use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize};
use sqlx::mysql::{MySqlPoolOptions, MySqlRow};
use sqlx::sqlite::{SqlitePoolOptions, SqliteRow};
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

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PaymentRecord {
    pub id: String,
    pub order_id: String,
    pub method: String,
    pub amount: i64,
    pub cash_amount: i64,
    pub card_amount: i64,
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
pub struct FrozenWholeSystemReport {
    pub token: String,
    pub cutoff_at: String,
    pub period_start: String,
    pub expected_last_marker: Option<String>,
    pub overview: FrozenSalesOverview,
    pub breakdown: FrozenPaymentBreakdown,
    pub top_products: Vec<FrozenTopProduct>,
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

fn local_db_path(app: &AppHandle) -> Result<PathBuf, String> {
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

const RECEIPT_BLOCK: i64 = 1_000_000;
const RECEIPT_HIGH_WATER_KEY: &str = "receipt_number_high_water";
const MARIADB_RESTORE_MAINTENANCE_CODE: &str = "MARIADB_RESTORE_MAINTENANCE";
const ACCOUNT_LEDGER_AUTHORITY_CODE: &str = "ACCOUNT_LEDGER_AUTHORITY_REQUIRED";
const MARIADB_RESTORE_GATE_TABLE: &str = "pos_restore_gate";
const MARIADB_RESTORE_LOCK_NAME: &str = "lbj-pos:mariadb-restore-replace";
const MARIADB_RESTORE_MAINTENANCE_KEY: &str = "restore_maintenance_owner";
const MARIADB_RESTORE_ONLINE_WINDOW_SECONDS: i64 = 45;
const CUSTOMER_DELETED_CODE: &str = "CUSTOMER_DELETED";
const WHOLE_SYSTEM_CLOSE_IN_PROGRESS_CODE: &str = "WHOLE_SYSTEM_CLOSE_IN_PROGRESS";
const WHOLE_SYSTEM_CLOSE_WAITING_CODE: &str = "WHOLE_SYSTEM_CLOSE_WAITING";
const WHOLE_SYSTEM_CLOSE_PROTOCOL_VERSION: i64 = 1;
const WHOLE_SYSTEM_CLOSE_ONLINE_SECONDS: i64 = 45;
const WHOLE_SYSTEM_CLOSE_PREPARE_SECONDS: i64 = 120;
const WHOLE_SYSTEM_CLOSE_FROZEN_SECONDS: i64 = 300;
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

async fn mysql_identifier_collation_ready(pool: &MySqlPool) -> Result<bool, sqlx::Error> {
    if !mysql_table_exists(pool, "pos_schema_migrations").await? {
        return Ok(false);
    }
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pos_schema_migrations WHERE BINARY name = BINARY ?",
    )
    .bind(MYSQL_IDENTIFIER_COLLATION_MIGRATION)
    .fetch_one(pool)
    .await?;
    Ok(count == 1)
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
async fn mysql_guarded_preflight_v4_is_current(pool: &MySqlPool) -> Result<bool, sqlx::Error> {
    if !mysql_identifier_collation_ready(pool).await? {
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
    ): (i64, i64, i64, i64, i64) = query.build_query_as().fetch_one(pool).await?;

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
    .fetch_one(pool)
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

fn is_restore_pushable_setting_key(key: &str) -> bool {
    if key.starts_with("sync_ts_") || key.starts_with("migration_") {
        return false;
    }
    !matches!(
        key,
        "pos_mode"
            | "mysql_config"
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
          shiftId, idempotencyKey, reversesEntryId, balanceAfterPence, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
          shiftId, idempotencyKey, reversesEntryId, balanceAfterPence, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
              shiftId, idempotencyKey, reversesEntryId, balanceAfterPence, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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

fn prepare_sale_account_changes(bundle: &mut SaleBundle) -> Result<(), sqlx::Error> {
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
        "INSERT INTO payments (id, orderId, method, amount, cashAmount, cardAmount, loyaltyAmount, accountAmount, reference, changeGiven, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(&p.id).bind(&p.order_id).bind(&p.method).bind(p.amount).bind(p.cash_amount)
    .bind(p.card_amount).bind(p.loyalty_amount).bind(p.account_amount)
    .bind(&p.reference).bind(p.change_given).bind(&p.created_at)
    .bind(&p.updated_at).execute(&mut *tx).await?;

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
        "INSERT INTO payments (id, orderId, method, amount, cashAmount, cardAmount, loyaltyAmount, accountAmount, reference, changeGiven, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(&p.id).bind(&p.order_id).bind(&p.method).bind(p.amount).bind(p.cash_amount)
    .bind(p.card_amount).bind(p.loyalty_amount).bind(p.account_amount)
    .bind(&p.reference).bind(p.change_given).bind(&p.created_at)
    .bind(&p.updated_at).execute(&mut *tx).await?;

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
          shiftId, idempotencyKey, reversesEntryId, balanceAfterPence, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    .execute(&mut *tx)
    .await?;
    tx.commit().await
}

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
    let mut calculated_total = 0_i64;
    for line in &bundle.lines {
        if line.id.trim().is_empty()
            || line.receipt_id != receipt.id
            || line.product_id.trim().is_empty()
            || line.inventory_log_id.trim().is_empty()
            || line.quantity <= 0
            || line.unit_cost < 0
            || !product_ids.insert(line.product_id.as_str())
        {
            return Err(sqlx::Error::Protocol("Invalid stock receipt line".into()));
        }
        calculated_total =
            calculated_total
                .checked_add(line.quantity.checked_mul(line.unit_cost).ok_or_else(|| {
                    sqlx::Error::Protocol("Stock receipt total is too large".into())
                })?)
                .ok_or_else(|| sqlx::Error::Protocol("Stock receipt total is too large".into()))?;
    }
    if receipt.total_cost != calculated_total {
        return Err(sqlx::Error::Protocol(
            "Stock receipt total does not match its lines".into(),
        ));
    }
    if bundle.audit.entity_id != receipt.id
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
            "UPDATE products SET stockLevel = stockLevel + ?, updatedAt = ? WHERE id = ?",
        )
        .bind(line.quantity)
        .bind(&receipt.updated_at)
        .bind(&line.product_id)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() != 1 {
            return Err(sqlx::Error::Protocol(format!(
                "Product {} is no longer available",
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
            "UPDATE products SET stockLevel = stockLevel + ?, updatedAt = ? WHERE id = ?",
        )
        .bind(line.quantity)
        .bind(&stamp)
        .bind(&line.product_id)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() != 1 {
            return Err(sqlx::Error::Protocol(format!(
                "Product {} is no longer available",
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

async fn mysql_epoch_fenced_outbox_upsert(
    tx: &mut sqlx::Transaction<'_, MySql>,
    table: &str,
    data: &serde_json::Value,
    id_key: &str,
    reject_newer_server_row: bool,
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

    if reject_newer_server_row && remote_columns.contains("updatedAt") {
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
        columns.push(name.clone());
        values.push(normalized_outbox_mysql_value(table, name, value)?);
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
        || !order.customer_id.trim().is_empty()
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
    let order: OrderRecord = serde_json::from_value(data.clone())
        .map_err(|error| account_protocol_error(format!("Invalid held order: {error}")))?;
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
            "UPDATE orders SET shiftId = ?, employeeId = ?, subtotal = ?, discountId = ?,
                    discountAmount = ?, taxTotal = ?, total = ?, tillNumber = ?, notes = ?,
                    createdAt = ?, updatedAt = ? WHERE id = ? AND status = 'hold'",
        )
        .bind(&o.shift_id)
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
             VALUES (?, ?, '', ?, 0, '', 'sale', 'hold', '', ?, ?, ?, ?, ?, ?, ?, '', 0, ?, NULL, ?)",
        )
        .bind(&o.id)
        .bind(&o.shift_id)
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
    let line: OrderLineRecord = serde_json::from_value(data.clone())
        .map_err(|error| account_protocol_error(format!("Invalid held-order line: {error}")))?;
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

    let group_id = group
        .get("id")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| account_protocol_error("Promotion group id is missing"))?;
    let discount_id = discount
        .get("id")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| account_protocol_error("Promotion discount id is missing"))?;
    if discount.get("groupId").and_then(serde_json::Value::as_str) != Some(group_id) {
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
    let mut protected_rows = vec![("promo_groups", group_id), ("discounts", discount_id)];
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
    if !incoming_revision.is_empty() {
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
    mysql_epoch_fenced_outbox_upsert(tx, "promo_groups", group, "id", true).await?;
    mysql_epoch_fenced_outbox_upsert(tx, "discounts", discount, "id", true).await?;

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
        mysql_epoch_fenced_outbox_upsert(tx, "promo_group_items", item, "id", true).await?;
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
    server_data_epoch: Option<String>,
) -> Result<bool, String> {
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
    let removed =
        mysql_epoch_fenced_held_order_remove(&mut tx, &serde_json::json!({ "id": order_id }))
            .await
            .map_err(|error| error.to_string())?;
    tx.commit().await.map_err(|error| error.to_string())?;
    Ok(removed)
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
    let mut issues = Vec::new();
    for row in rows {
        let name: String = row.try_get("tillName")?;
        let online: i64 = row.try_get("isOnline")?;
        let protocol: i64 = row.try_get("protocolVersion")?;
        let observed_token: String = row.try_get("barrierToken")?;
        let observed_phase: String = row.try_get("barrierPhase")?;
        let outbox: i64 = row.try_get("outboxCount")?;
        let terminals: i64 = row.try_get("terminalCount")?;
        let conflicts: i64 = row.try_get("conflictCount")?;
        if online == 0 {
            issues.push(format!("{name} is offline"));
        } else if protocol < WHOLE_SYSTEM_CLOSE_PROTOCOL_VERSION {
            issues.push(format!("{name} must update to the current close protocol"));
        } else if observed_token != token || observed_phase != phase {
            issues.push(format!("{name} has not acknowledged the {phase} phase"));
        } else if outbox > 0 {
            issues.push(format!("{name} still has {outbox} queued change(s)"));
        } else if conflicts > 0 {
            issues.push(format!(
                "{name} has {conflicts} unresolved sync conflict(s)"
            ));
        } else if terminals > 0 {
            issues.push(format!(
                "{name} has {terminals} terminal payment attempt(s) to recover"
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

#[tauri::command]
pub async fn begin_whole_system_close(
    mysql_uri: String,
    owner_till_id: String,
) -> Result<WholeSystemCloseBarrierResult, String> {
    if owner_till_id.trim().is_empty() {
        return Err("Whole-system close requires this till's stable ID".into());
    }
    let pool = connect_mysql_for_pos(&mysql_uri)
        .await
        .map_err(|error| error.to_string())?;
    ensure_mysql_whole_system_close_schema(&pool)
        .await
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
    let pool = connect_mysql_for_pos(&mysql_uri)
        .await
        .map_err(|error| error.to_string())?;
    ensure_mysql_whole_system_close_schema(&pool)
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
        return Err(format!(
            "{WHOLE_SYSTEM_CLOSE_WAITING_CODE}: {}",
            issues.join("; ")
        ));
    }
    assert_remote_terminal_journal_empty(&mut tx)
        .await
        .map_err(|error| error.to_string())?;
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
    let pool = connect_mysql_for_pos(&mysql_uri)
        .await
        .map_err(|error| error.to_string())?;
    ensure_mysql_whole_system_close_schema(&pool)
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
        return Err(
            "WHOLE_SYSTEM_CLOSE_TOKEN_INVALID: another till owns this close barrier".into(),
        );
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
        return Err(account_protocol_error(format!(
            "{WHOLE_SYSTEM_CLOSE_WAITING_CODE}: {}",
            issues.join("; ")
        )));
    }
    assert_remote_terminal_journal_empty(&mut tx).await?;
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
    let pool = connect_mysql_for_pos(&mysql_uri)
        .await
        .map_err(|error| error.to_string())?;
    ensure_mysql_whole_system_close_schema(&pool)
        .await
        .map_err(|error| error.to_string())?;
    purge_mysql_transactions_under_frozen_close(&pool, token.trim(), owner_till_id.trim(), false)
        .await
        .map_err(|error| error.to_string())
}

async fn load_frozen_whole_system_report(
    tx: &mut sqlx::Transaction<'_, MySql>,
    start_time: &str,
    end_time: &str,
) -> Result<
    (
        FrozenSalesOverview,
        FrozenPaymentBreakdown,
        Vec<FrozenTopProduct>,
    ),
    sqlx::Error,
> {
    let revenue = sqlx::query(
        "SELECT CAST(COALESCE(SUM(o.total), 0) AS SIGNED) AS totalRevenue,
                CAST(COALESCE(SUM(CASE WHEN o.type != 'return' THEN o.total ELSE 0 END), 0) AS SIGNED) AS saleRevenue,
                CAST(COALESCE(SUM(CASE WHEN o.type != 'return' THEN 1 ELSE 0 END), 0) AS SIGNED) AS totalTransactions,
                CAST(COALESCE(SUM(CASE WHEN o.type = 'return' THEN 1 ELSE 0 END), 0) AS SIGNED) AS refundTransactions
         FROM orders o
         WHERE o.status IN ('completed','refunded','partially_refunded','voided')
           AND o.status != 'voided'
           AND NOT (o.type = 'return' AND COALESCE(o.notes, '') LIKE 'Void of receipt %')
           AND o.completedAt >= ? AND o.completedAt < ?",
    )
    .bind(start_time)
    .bind(end_time)
    .fetch_one(&mut **tx)
    .await?;
    let items: i64 = sqlx::query_scalar(
        "SELECT CAST(COALESCE(SUM(ol.quantity), 0) AS SIGNED)
         FROM order_lines ol JOIN orders o ON ol.orderId = o.id
         WHERE o.status IN ('completed','refunded','partially_refunded','voided')
           AND o.status != 'voided'
           AND NOT (o.type = 'return' AND COALESCE(o.notes, '') LIKE 'Void of receipt %')
           AND o.completedAt >= ? AND o.completedAt < ?",
    )
    .bind(start_time)
    .bind(end_time)
    .fetch_one(&mut **tx)
    .await?;
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

    let payments = sqlx::query(
        "SELECT
            CAST(COALESCE(SUM(p.totalCash), 0) AS SIGNED) AS totalCash,
            CAST(COALESCE(SUM(p.totalCard), 0) AS SIGNED) AS totalCard,
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
           AND o.completedAt >= ? AND o.completedAt < ?",
    )
    .bind(start_time)
    .bind(end_time)
    .fetch_one(&mut **tx)
    .await?;
    let account_activity = sqlx::query(
        "SELECT
            CAST(COALESCE(SUM(CASE WHEN entryType = 'charge' THEN amountPence ELSE 0 END), 0) AS SIGNED) AS accountCharges,
            CAST(COALESCE(SUM(CASE WHEN entryType = 'payment' AND paymentMethod = 'cash' AND amountPence < 0 THEN -amountPence ELSE 0 END), 0) AS SIGNED) AS accountRepaymentsCash,
            CAST(COALESCE(SUM(CASE WHEN entryType = 'payment' AND paymentMethod = 'card' AND amountPence < 0 THEN -amountPence ELSE 0 END), 0) AS SIGNED) AS accountRepaymentsCard,
            CAST(COALESCE(SUM(CASE WHEN entryType = 'payment' AND paymentMethod = 'other' AND amountPence < 0 THEN -amountPence ELSE 0 END), 0) AS SIGNED) AS accountRepaymentsOther,
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
        account_adjustments: account_activity.try_get("accountAdjustments")?,
        opening_account_owed: opening,
        closing_account_owed: closing,
        account_activity_scope: "shop".into(),
        total_amount: payments.try_get("totalAmount")?,
        unrecorded_amount: payments.try_get("unrecordedAmount")?,
        unrecorded_tx_count: payments.try_get("unrecordedTxCount")?,
    };

    let top_rows = sqlx::query(
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
           AND o.completedAt >= ? AND o.completedAt < ?
         GROUP BY ol.productId, ol.productName, pr.sku
         HAVING SUM(ol.quantity) != 0 OR SUM(ol.lineTotal) != 0
         ORDER BY qtySold DESC LIMIT 10",
    )
    .bind(start_time)
    .bind(end_time)
    .fetch_all(&mut **tx)
    .await?;
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
    Ok((overview, breakdown, top_products))
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
    let pool = connect_mysql_for_pos(&mysql_uri)
        .await
        .map_err(|error| error.to_string())?;
    ensure_mysql_whole_system_close_schema(&pool)
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
        return Err(format!(
            "{WHOLE_SYSTEM_CLOSE_WAITING_CODE}: {}",
            issues.join("; ")
        ));
    }
    assert_remote_terminal_journal_empty(&mut tx)
        .await
        .map_err(|error| error.to_string())?;
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
    let (overview, breakdown, top_products) =
        load_frozen_whole_system_report(&mut tx, &period_start, &barrier.cutoff_at)
            .await
            .map_err(|error| error.to_string())?;
    tx.commit().await.map_err(|error| error.to_string())?;
    Ok(FrozenWholeSystemReport {
        token: token.trim().into(),
        cutoff_at: barrier.cutoff_at,
        period_start,
        expected_last_marker: latest_marker,
        overview,
        breakdown,
        top_products,
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
    let pool = connect_mysql_for_pos(&mysql_uri)
        .await
        .map_err(|error| error.to_string())?;
    ensure_mysql_whole_system_close_schema(&pool)
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

async fn run_mariadb_restore_replacement(
    mysql: &MySqlPool,
    local: &SqlitePool,
    till_id: &str,
) -> Result<MariaDbRestoreResult, sqlx::Error> {
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
    assert_no_active_local_terminal_attempts_in_restore(local).await?;
    validate_mariadb_restore_identity(local, &mut tx).await?;

    let local_products: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM products")
        .fetch_one(local)
        .await?;
    if local_products == 0 {
        return Err(account_protocol_error(
            "This till has no restored products to upload",
        ));
    }

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
        let copied = copy_restore_table_to_mysql(local, &mut tx, table).await?;
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
    let local_uri = format!("sqlite://{}?mode=ro", local_path.display());
    let local = SqlitePoolOptions::new()
        .max_connections(1)
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
        run_mariadb_restore_replacement(&mysql, &local, till_id.trim()).await
    }
    .await;
    // Never let a bypass escape into later work on this pooled session.
    let _ = sqlx::query("SET @lbj_pos_restore_bypass = NULL")
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
        'pos_mode', 'mysql_config', 'till_id', 'till_name', 'till_name_manual', 'till_seq',
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
            "till_id",
            "receipt_printer_name",
            "restore_pending_mariadb_replace",
            "restore_maintenance_owner",
            "server_data_epoch",
            "server_data_epoch_seen",
            "report_epoch_cache",
            "sync_ts_products",
        ] {
            assert!(!is_restore_pushable_setting_key(key), "{key}");
        }
        assert!(is_restore_pushable_setting_key("store_info"));
        assert!(is_restore_pushable_setting_key("receipt_design"));
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
            "CREATE TABLE payments (id TEXT PRIMARY KEY, orderId TEXT, method TEXT, amount INTEGER, cashAmount INTEGER, cardAmount INTEGER, loyaltyAmount INTEGER DEFAULT 0, accountAmount INTEGER DEFAULT 0, reference TEXT, changeGiven INTEGER, createdAt TEXT, updatedAt TEXT)",
            "CREATE TABLE products (id TEXT PRIMARY KEY, stockLevel INTEGER, updatedAt TEXT)",
            "CREATE TABLE inventory_logs (id TEXT PRIMARY KEY, productId TEXT, quantityChange INTEGER, type TEXT, referenceId TEXT, employeeId TEXT, notes TEXT, createdAt TEXT, updatedAt TEXT)",
            "CREATE TABLE audit_logs (id TEXT PRIMARY KEY, employeeId TEXT, action TEXT, entityType TEXT, entityId TEXT, oldData TEXT, newData TEXT, createdAt TEXT, updatedAt TEXT)",
            "CREATE TABLE customers (id TEXT PRIMARY KEY, loyaltyPoints INTEGER, updatedAt TEXT)",
            "CREATE TABLE customer_accounts (id TEXT PRIMARY KEY, customerId TEXT NOT NULL UNIQUE, isEnabled INTEGER NOT NULL DEFAULT 0, creditLimitPence INTEGER NOT NULL DEFAULT 0, balancePence INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)",
            "CREATE TABLE customer_account_entries (id TEXT PRIMARY KEY, accountId TEXT NOT NULL, customerId TEXT NOT NULL, orderId TEXT NOT NULL DEFAULT '', entryType TEXT NOT NULL, amountPence INTEGER NOT NULL, paymentMethod TEXT NOT NULL DEFAULT '', reference TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', receiptNumber INTEGER NOT NULL DEFAULT 0, receiptKey TEXT NOT NULL DEFAULT '', employeeId TEXT NOT NULL DEFAULT '', tillNumber TEXT NOT NULL DEFAULT '', shiftId TEXT NOT NULL DEFAULT '', idempotencyKey TEXT NOT NULL UNIQUE, reversesEntryId TEXT NOT NULL DEFAULT '', balanceAfterPence INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)",
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

        sale.order.receipt_key = "till-1:42".into();
        assert!(validate_held_order_record(&sale.order).is_err());
        sale.order.receipt_key.clear();
        sale.order.status = "completed".into();
        assert!(validate_held_order_record(&sale.order).is_err());
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
                    accountAmount BIGINT DEFAULT 0
                 ) ENGINE=InnoDB",
                "CREATE TABLE IF NOT EXISTS customer_account_entries (
                    id VARCHAR(36) PRIMARY KEY, entryType VARCHAR(32),
                    paymentMethod VARCHAR(32), amountPence BIGINT DEFAULT 0,
                    createdAt DATETIME(3) NULL
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
            ensure_mysql_whole_system_close_schema(&pool).await.unwrap();
            ensure_mysql_account_ledger_guards(&pool).await.unwrap();

            let suffix = format!("{:016x}", rand::random::<u64>());
            let till_id = format!("z-till-{suffix}");
            let product_id = format!("z-product-{suffix}");
            let order_id = format!("z-order-{suffix}");
            let stale_order_id = format!("z-stale-order-{suffix}");
            let account_payment_id = format!("z-account-other-{suffix}");
            let account_id = format!("z-account-{suffix}");
            let account_customer_id = format!("z-customer-{suffix}");
            let start_marker_id = format!("z-start-{suffix}");
            let finish_marker_id = format!("z-finish-{suffix}");
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
            sqlx::query("DELETE FROM payments WHERE orderId = ?")
                .bind(&order_id)
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("DELETE FROM order_lines WHERE orderId = ?")
                .bind(&order_id)
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("DELETE FROM orders WHERE id = ?")
                .bind(&order_id)
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
                "INSERT INTO till_presence
                    (tillId, tillName, closeProtocolVersion, closeBarrierToken,
                     closeBarrierPhase, outboxCount, localTerminalAttemptCount,
                     syncConflictCount, barrierObservedAt, lastSeenAt)
                 VALUES (?, 'Z test till', ?, '', '', 0, 0, 0,
                         NULL, UTC_TIMESTAMP(3))",
            )
            .bind(&till_id)
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
                 WHERE tillId = ?",
            )
            .bind(&token)
            .bind(&till_id)
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
                "INSERT INTO orders (id, total, type, status, notes, completedAt)
                 VALUES (?, 100, 'sale', 'completed', '',
                         DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ'))",
            )
            .bind(&order_id)
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
                "INSERT INTO customer_account_entries
                    (id, accountId, customerId, entryType, paymentMethod,
                     amountPence, reference, description, idempotencyKey,
                     balanceAfterPence, createdAt, updatedAt)
                 VALUES (?, ?, ?, 'payment', 'other', -60, '',
                         'Whole-system close integration fixture', ?, -60,
                         DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ'),
                         DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ'))",
            )
            .bind(&account_payment_id)
            .bind(&account_id)
            .bind(&account_customer_id)
            .bind(format!("z-close:{suffix}"))
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
                     lastSeenAt = UTC_TIMESTAMP(3) WHERE tillId = ?",
            )
            .bind(&till_id)
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
            assert_eq!(snapshot.overview.total_revenue, 100);
            assert_eq!(snapshot.overview.total_transactions, 1);
            assert_eq!(snapshot.breakdown.total_cash, 100);
            assert_eq!(snapshot.breakdown.account_repayments_other, 60);
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

            sqlx::query("DELETE FROM payments WHERE orderId = ?")
                .bind(&order_id)
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("DELETE FROM order_lines WHERE orderId = ?")
                .bind(&order_id)
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("DELETE FROM orders WHERE id = ?")
                .bind(&order_id)
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
            sqlx::query("DELETE FROM registers WHERE id = ?")
                .bind(&till_id)
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
