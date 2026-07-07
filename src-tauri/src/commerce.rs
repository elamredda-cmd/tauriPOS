use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize};
use sqlx::mysql::MySqlPoolOptions;
use sqlx::sqlite::SqlitePoolOptions;
use sqlx::{MySqlPool, Row, SqlitePool};
use std::{fs, path::PathBuf, thread, time::Duration};
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

#[derive(Debug, Deserialize, Serialize, Clone)]
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

#[derive(Debug, Deserialize, Serialize, Clone)]
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

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PaymentRecord {
    pub id: String,
    pub order_id: String,
    pub method: String,
    pub amount: i64,
    pub cash_amount: i64,
    pub card_amount: i64,
    pub reference: String,
    pub change_given: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
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

#[derive(Debug, Deserialize, Serialize, Clone)]
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

#[derive(Debug, Deserialize, Serialize, Clone)]
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
    pub order: OrderRecord,
    pub lines: Vec<OrderLineRecord>,
    pub payment: PaymentRecord,
    pub stock_changes: Vec<StockChange>,
    #[serde(default)]
    pub loyalty_changes: Vec<LoyaltyChange>,
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreDatabaseResult {
    pub restored_from: String,
    pub replaced_database: String,
    pub safety_backup: Option<String>,
    pub restart_required: bool,
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

fn validate_reversal_bundle(
    bundle: &SaleBundle,
    original_status: &str,
    remaining: i64,
    expected_stock: &[(String, i64)],
) -> Result<(), sqlx::Error> {
    let o = &bundle.order;
    let refund_amount = o.total.abs();
    let target_status = bundle.original_status_update.as_deref().unwrap_or("");
    let is_void = bundle.audit.action == "order_voided" || o.notes.starts_with("Void of receipt");

    if o.status != "completed"
        || bundle.lines.is_empty()
        || bundle.payment.order_id != o.id
        || bundle.payment.amount != o.total
        || bundle.payment.method != o.payment_method
        || bundle.payment.cash_amount > 0
        || bundle.payment.card_amount > 0
        || bundle.payment.cash_amount.abs() + bundle.payment.card_amount.abs() > refund_amount
        || o.amount_tendered != o.total
        || bundle.audit.entity_id != o.original_order_id
        || bundle.original_order_to_update.as_deref() != Some(o.original_order_id.as_str())
        || bundle
            .lines
            .iter()
            .any(|line| line.order_id != o.id || line.line_total > 0)
        || bundle.lines.iter().map(|line| line.line_total).sum::<i64>() != o.total
        || bundle.loyalty_changes.iter().any(|change| {
            change.order_id != o.id
                || change.customer_id != o.customer_id
                || change.reason != "refund_adjustment"
        })
    {
        return Err(sqlx::Error::Protocol("Invalid reversal bundle".into()));
    }

    let expected_status = if is_void {
        if original_status != "completed" || refund_amount != remaining {
            return Err(sqlx::Error::Protocol("Invalid void request".into()));
        }
        "voided"
    } else if refund_amount == remaining {
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
        let stock_matches = expected_stock.len() == actual_stock.len()
            && expected_stock.iter().all(|(product_id, quantity)| {
                actual_stock.iter().any(|(actual_id, actual_quantity)| {
                    actual_id == product_id && actual_quantity == quantity
                })
            });
        if !stock_matches {
            return Err(sqlx::Error::Protocol(
                "Invalid reversal stock restoration; synchronize and try again".into(),
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
    let original: Option<(i64, String)> =
        sqlx::query_as("SELECT total, status FROM orders WHERE id = ? LIMIT 1")
            .bind(&o.original_order_id)
            .fetch_optional(&mut **tx)
            .await?;
    let Some((original_total, original_status)) = original else {
        return Err(sqlx::Error::Protocol("Original sale was not found".into()));
    };
    if original_status != "completed" && original_status != "partially_refunded" {
        return Err(sqlx::Error::Protocol(
            "Sale is not available for refund".into(),
        ));
    }
    let previously_refunded: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(ABS(total)), 0) FROM orders WHERE type = 'return' AND originalOrderId = ?",
    )
    .bind(&o.original_order_id)
    .fetch_one(&mut **tx)
    .await?;
    let remaining = (original_total - previously_refunded).max(0);
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
    validate_reversal_bundle(bundle, &original_status, remaining, &expected_stock)
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
    let original: Option<(i64, String)> = sqlx::query_as(
        "SELECT total, CAST(status AS CHAR) FROM orders WHERE id = ? LIMIT 1 FOR UPDATE",
    )
    .bind(&o.original_order_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some((original_total, original_status)) = original else {
        return Err(sqlx::Error::Protocol("Original sale was not found".into()));
    };
    if original_status != "completed" && original_status != "partially_refunded" {
        return Err(sqlx::Error::Protocol(
            "Sale is not available for refund".into(),
        ));
    }
    let previously_refunded: i64 = sqlx::query_scalar(
        "SELECT CAST(COALESCE(SUM(ABS(total)), 0) AS SIGNED) FROM orders WHERE type = 'return' AND originalOrderId = ?",
    )
    .bind(&o.original_order_id)
    .fetch_one(&mut **tx)
    .await?;
    let remaining = (original_total - previously_refunded).max(0);
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
    validate_reversal_bundle(bundle, &original_status, remaining, &expected_stock)
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
    let start_num = start
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(1);
    let till_seq = till_seq
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
        match local_max {
            Some(max) if max >= block_start => max + 1,
            _ => block_start + start_num,
        }
    } else {
        let global_max: Option<i64> =
            sqlx::query_scalar("SELECT MAX(orderNumber) FROM orders WHERE orderNumber > 0")
                .fetch_one(&mut **tx)
                .await?;
        let next = global_max.unwrap_or(0) + 1;
        next.max(start_num)
    };

    o.order_number = next;
    o.receipt_key = format!("{}:{}", o.till_number, next);
    Ok(())
}

async fn insert_sqlite_bundle(
    pool: &SqlitePool,
    bundle: &SaleBundle,
) -> Result<SaleBundle, sqlx::Error> {
    // Claim SQLite's write lock before reading the next receipt number, so
    // simultaneous payments cannot both allocate the same receipt.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let mut committed = bundle.clone();
    validate_sqlite_reversal(&mut tx, &committed).await?;
    allocate_local_receipt(&mut tx, &mut committed.order).await?;
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

    for l in &bundle.lines {
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

    let p = &bundle.payment;
    sqlx::query(
        "INSERT INTO payments (id, orderId, method, amount, cashAmount, cardAmount, reference, changeGiven, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(&p.id).bind(&p.order_id).bind(&p.method).bind(p.amount).bind(p.cash_amount)
    .bind(p.card_amount).bind(&p.reference).bind(p.change_given).bind(&p.created_at)
    .bind(&p.updated_at).execute(&mut *tx).await?;

    for s in &bundle.stock_changes {
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

    for change in &bundle.loyalty_changes {
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

    let a = &bundle.audit;
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
    tx.commit().await?;
    Ok(committed)
}

async fn insert_mysql_bundle(pool: &MySqlPool, bundle: &SaleBundle) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    let o = &bundle.order;
    // A till can lose the network response after MariaDB committed the sale.
    // Treat replaying that exact immutable order as success instead of blocking
    // every later offline operation with a duplicate-key error.
    let existing_receipt: Option<String> =
        sqlx::query_scalar("SELECT receiptKey FROM orders WHERE id = ? LIMIT 1")
            .bind(&o.id)
            .fetch_optional(&mut *tx)
            .await?;
    if let Some(receipt_key) = existing_receipt {
        if receipt_key == o.receipt_key {
            tx.commit().await?;
            return Ok(());
        }
        return Err(sqlx::Error::Protocol(
            "SYNC_CONFLICT: order id already exists with a different receipt".into(),
        ));
    }
    validate_mysql_reversal(&mut tx, bundle).await?;
    // Delta sync checkpoints use MariaDB's clock. Stamp the bundle when the
    // server receives it so sales created while offline are not hidden behind
    // a checkpoint that advanced before they were uploaded.
    let stamp: String =
        sqlx::query_scalar("SELECT DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ')")
            .fetch_one(&mut *tx)
            .await?;
    sqlx::query(
        "INSERT INTO orders (id, shiftId, customerId, employeeId, orderNumber, receiptKey, type, status, originalOrderId, subtotal, discountId, discountAmount, taxTotal, total, tillNumber, notes, paymentMethod, amountTendered, createdAt, completedAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(&o.id).bind(&o.shift_id).bind(&o.customer_id).bind(&o.employee_id)
    .bind(o.order_number).bind(&o.receipt_key).bind(&o.order_type).bind(&o.status).bind(&o.original_order_id)
    .bind(o.subtotal).bind(&o.discount_id).bind(o.discount_amount).bind(o.tax_total)
    .bind(o.total).bind(&o.till_number).bind(&o.notes).bind(&o.payment_method)
    .bind(o.amount_tendered).bind(&o.created_at).bind(&o.completed_at).bind(&stamp)
    .execute(&mut *tx).await?;

    for l in &bundle.lines {
        sqlx::query(
            "INSERT INTO order_lines (id, orderId, productId, productName, quantity, unitPrice, costPrice, discountId, discountAmount, taxRate, taxAmount, lineTotal, isPriceOverride, originalPrice, notes, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(&l.id).bind(&l.order_id).bind(&l.product_id).bind(&l.product_name)
        .bind(l.quantity).bind(l.unit_price).bind(l.cost_price).bind(&l.discount_id)
        .bind(l.discount_amount).bind(l.tax_rate).bind(l.tax_amount).bind(l.line_total)
        .bind(if l.is_price_override { 1 } else { 0 }).bind(l.original_price)
        .bind(&l.notes).bind(&stamp).execute(&mut *tx).await?;
    }
    let p = &bundle.payment;
    sqlx::query(
        "INSERT INTO payments (id, orderId, method, amount, cashAmount, cardAmount, reference, changeGiven, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(&p.id).bind(&p.order_id).bind(&p.method).bind(p.amount).bind(p.cash_amount)
    .bind(p.card_amount).bind(&p.reference).bind(p.change_given).bind(&p.created_at)
    .bind(&stamp).execute(&mut *tx).await?;

    for s in &bundle.stock_changes {
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
        .bind(&s.notes).bind(&o.completed_at).bind(&stamp).execute(&mut *tx).await?;
    }
    for change in &bundle.loyalty_changes {
        let result = if change.points_change < 0 && change.reason == "redeemed" {
            sqlx::query("UPDATE customers SET loyaltyPoints = loyaltyPoints + ?, updatedAt = ? WHERE id = ? AND loyaltyPoints >= ?")
                .bind(change.points_change).bind(&stamp).bind(&change.customer_id).bind(-change.points_change)
                .execute(&mut *tx).await?
        } else {
            sqlx::query("UPDATE customers SET loyaltyPoints = loyaltyPoints + ?, updatedAt = ? WHERE id = ?")
                .bind(change.points_change).bind(&stamp).bind(&change.customer_id)
                .execute(&mut *tx).await?
        };
        if result.rows_affected() != 1 {
            return Err(sqlx::Error::Protocol(
                "Customer loyalty balance changed; refresh and try again".into(),
            ));
        }
        sqlx::query("INSERT INTO loyalty_logs (id, customerId, orderId, pointsChange, reason, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .bind(&change.id).bind(&change.customer_id).bind(&change.order_id).bind(change.points_change)
            .bind(&change.reason).bind(&change.created_at).bind(&stamp).execute(&mut *tx).await?;
    }
    let a = &bundle.audit;
    sqlx::query(
        "INSERT INTO audit_logs (id, employeeId, action, entityType, entityId, oldData, newData, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(&a.id).bind(&a.employee_id).bind(&a.action).bind(&a.entity_type).bind(&a.entity_id)
    .bind(&a.old_data).bind(&a.new_data).bind(&a.created_at).bind(&stamp)
    .execute(&mut *tx).await?;
    if let (Some(id), Some(status)) = (
        &bundle.original_order_to_update,
        &bundle.original_status_update,
    ) {
        sqlx::query("UPDATE orders SET status = ?, updatedAt = ? WHERE id = ?")
            .bind(status)
            .bind(&stamp)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await
}

#[tauri::command]
pub async fn commit_local_sale(
    app: AppHandle,
    bundle: SaleBundle,
) -> Result<CommitSaleResult, String> {
    let uri = format!("sqlite://{}?mode=rwc", local_db_path(&app)?.display());
    let pool = SqlitePool::connect(&uri).await.map_err(|e| e.to_string())?;
    let bundle = insert_sqlite_bundle(&pool, &bundle)
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
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn commit_online_reversal(
    app: AppHandle,
    mysql_uri: String,
    bundle: SaleBundle,
) -> Result<CommitSaleResult, String> {
    let local_uri = format!("sqlite://{}?mode=rwc", local_db_path(&app)?.display());
    let local_pool = SqlitePool::connect(&local_uri)
        .await
        .map_err(|e| e.to_string())?;

    // Reserve the same receipt identity that will be used by both databases.
    // No local reversal is written until MariaDB has accepted it.
    let mut local_tx = local_pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|e| e.to_string())?;
    let mut committed = bundle.clone();
    validate_sqlite_reversal(&mut local_tx, &committed)
        .await
        .map_err(|e| e.to_string())?;
    allocate_local_receipt(&mut local_tx, &mut committed.order)
        .await
        .map_err(|e| e.to_string())?;
    local_tx.rollback().await.map_err(|e| e.to_string())?;

    let mysql_pool = connect_mysql_for_pos(&mysql_uri)
        .await
        .map_err(|e| e.to_string())?;
    insert_mysql_bundle(&mysql_pool, &committed)
        .await
        .map_err(|e| e.to_string())?;
    let committed = match insert_sqlite_bundle(&local_pool, &committed).await {
        Ok(local) => local,
        Err(error) => {
            eprintln!("MariaDB accepted reversal but local cache insert failed; background sync will repair it: {error}");
            committed
        }
    };
    Ok(CommitSaleResult { bundle: committed })
}

#[tauri::command]
pub async fn allocate_mysql_till_sequence(mysql_uri: String) -> Result<i64, String> {
    let pool = connect_mysql_for_pos(&mysql_uri)
        .await
        .map_err(|e| e.to_string())?;
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
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

#[tauri::command]
pub async fn create_local_backup(app: AppHandle) -> Result<String, String> {
    let source = local_db_path(&app)?;
    if !source.exists() {
        return Err("Local database does not exist yet".into());
    }
    let backup_dir = local_backup_dir(&app)?;
    let name = format!(
        "pos-backup-{}.db",
        chrono::Utc::now().format("%Y%m%d-%H%M%S")
    );
    let target = backup_dir.join(name);
    let uri = format!("sqlite://{}?mode=rwc", source.display());
    let pool = SqlitePool::connect(&uri).await.map_err(|e| e.to_string())?;
    let escaped = target.display().to_string().replace('\'', "''");
    sqlx::query(&format!("VACUUM INTO '{escaped}'"))
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(target.display().to_string())
}

#[tauri::command]
pub async fn latest_local_backup(app: AppHandle) -> Result<Option<String>, String> {
    let backup_dir = local_backup_dir(&app)?;
    if !backup_dir.exists() {
        return Ok(None);
    }
    let mut files: Vec<_> = fs::read_dir(backup_dir)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter(|e| e.path().extension().is_some_and(|x| x == "db"))
        .collect();
    files.sort_by_key(|e| e.file_name());
    Ok(files.last().map(|e| e.path().display().to_string()))
}

async fn validate_restore_database(source: &PathBuf) -> Result<(), String> {
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
    validate_restore_data(&pool).await?;

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
        ("order_lines", vec!["id", "orderId", "productId", "lineTotal"]),
        ("payments", vec!["id", "orderId", "amount"]),
    ];

    for (table, columns) in required_columns {
        if !table_exists(pool, "main", table).await? {
            // Older backups may not contain every optional table, but the core
            // tables above must have the columns they advertise when present.
            continue;
        }
        let actual: std::collections::HashSet<_> =
            table_columns(pool, "main", table).await?.into_iter().collect();
        for column in columns {
            if !actual.contains(column) {
                return Err(format!(
                    "The selected database is missing required column {table}.{column}"
                ));
            }
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

async fn validate_restore_data(pool: &SqlitePool) -> Result<(), String> {
    let mut issues = Vec::new();

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
        ),
        (
            "POS tiles pointing to missing pages",
            vec!["pos_tiles", "pos_pages"],
            "SELECT COUNT(*) FROM pos_tiles t LEFT JOIN pos_pages p ON p.id = t.pageId WHERE p.id IS NULL",
        ),
        (
            "Promotion items pointing to missing products",
            vec!["promo_group_items", "products"],
            "SELECT COUNT(*) FROM promo_group_items i LEFT JOIN products p ON p.id = i.productId WHERE p.id IS NULL",
        ),
        (
            "Promotion items pointing to missing groups",
            vec!["promo_group_items", "promo_groups"],
            "SELECT COUNT(*) FROM promo_group_items i LEFT JOIN promo_groups g ON g.id = i.groupId WHERE g.id IS NULL",
        ),
        (
            "Order lines pointing to missing orders",
            vec!["order_lines", "orders"],
            "SELECT COUNT(*) FROM order_lines l LEFT JOIN orders o ON o.id = l.orderId WHERE o.id IS NULL",
        ),
        (
            "Payments pointing to missing orders",
            vec!["payments", "orders"],
            "SELECT COUNT(*) FROM payments p LEFT JOIN orders o ON o.id = p.orderId WHERE o.id IS NULL",
        ),
    ];
    for (label, tables, sql) in orphan_checks {
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

fn quote_sqlite_text(value: &str) -> String {
    value.replace('\'', "''")
}

async fn table_exists(pool: &SqlitePool, schema: &str, table: &str) -> Result<bool, String> {
    let query = format!(
        "SELECT COUNT(*) FROM {schema}.sqlite_master WHERE type = 'table' AND name = ?"
    );
    let count: i64 = sqlx::query_scalar(&query)
        .bind(table)
        .fetch_one(pool)
        .await
        .map_err(|e| format!("Could not inspect {schema}.{table}: {e}"))?;
    Ok(count > 0)
}

async fn table_columns(pool: &SqlitePool, schema: &str, table: &str) -> Result<Vec<String>, String> {
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

async fn restore_preserved_local_setup(target: &PathBuf, preserve_from: Option<&str>) -> Result<(), String> {
    let Some(preserve_from) = preserve_from else {
        return Ok(());
    };
    if !PathBuf::from(preserve_from).exists() {
        return Ok(());
    }

    let target_uri = format!("sqlite://{}", target.display());
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&target_uri)
        .await
        .map_err(|e| format!("Could not reopen restored database to preserve settings: {e}"))?;
    let attach = format!(
        "ATTACH DATABASE '{}' AS preserved",
        quote_sqlite_text(preserve_from)
    );
    sqlx::query(&attach)
        .execute(&pool)
        .await
        .map_err(|e| format!("Could not read safety backup to preserve settings: {e}"))?;

    copy_preserved_table(&pool, "employees", None).await?;
    copy_preserved_table(&pool, "settings", None).await?;
    copy_preserved_table(&pool, "app_identity", None).await?;

    sqlx::query(
        "DELETE FROM settings
         WHERE key LIKE 'sync_ts_%'
            OR key IN ('last_sync_time', 'last_fast_sync_time', 'bootstrap_uploaded', 'transaction_purge_applied_at')",
    )
    .execute(&pool)
    .await
    .map_err(|e| format!("Could not clear old sync markers after restore: {e}"))?;

    let restored_mode: Option<String> = sqlx::query_scalar(
        "SELECT value FROM settings WHERE key = 'pos_mode' LIMIT 1",
    )
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

    let _ = sqlx::query("DETACH DATABASE preserved").execute(&pool).await;
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
    fs::write(&marker, text)
        .map_err(|e| format!("Could not schedule restore for restart: {e}"))?;
    Ok(())
}

pub fn apply_pending_restore_on_startup(app: &AppHandle) -> Result<(), String> {
    let marker = pending_restore_marker_path(app)?;
    if !marker.exists() {
        return Ok(());
    }

    let source_text = fs::read_to_string(&marker)
        .map_err(|e| format!("Could not read pending restore marker: {e}"))?;
    let pending = serde_json::from_str::<PendingRestoreMarker>(&source_text)
        .unwrap_or(PendingRestoreMarker {
            source: source_text.trim().to_string(),
            preserve_from: None,
        });
    let source = PathBuf::from(pending.source.trim());
    if !source.exists() {
        let _ = fs::remove_file(&marker);
        return Err("Pending restore file is missing. Restore was cancelled.".into());
    }

    tauri::async_runtime::block_on(validate_restore_database(&source))?;
    let target = local_db_path(app)?;
    let backup_dir = local_backup_dir(app)?;
    let backup_path = backup_dir.join(format!(
        "pre-startup-restore-backup-{}.db",
        chrono::Utc::now().format("%Y%m%d-%H%M%S")
    ));

    if target.exists() {
        fs::copy(&target, &backup_path)
            .map_err(|e| format!("Could not create startup safety backup before restore: {e}"))?;
        fs::remove_file(&target)
            .map_err(|e| format!("Could not replace local database during startup: {e}"))?;
    }

    fs::rename(&source, &target)
        .or_else(|_| fs::copy(&source, &target).map(|_| ()))
        .map_err(|e| format!("Could not finish pending restore during startup: {e}"))?;
    tauri::async_runtime::block_on(restore_preserved_local_setup(
        &target,
        pending.preserve_from.as_deref(),
    ))?;
    let _ = fs::remove_file(&source);
    let _ = fs::remove_file(&marker);
    Ok(())
}

async fn restore_local_database_from_path_impl(
    app: AppHandle,
    source: PathBuf,
) -> Result<RestoreDatabaseResult, String> {
    validate_restore_database(&source).await?;

    let target = local_db_path(&app)?;
    if source.canonicalize().ok() == target.canonicalize().ok() {
        return Err("The selected file is already the live till database".into());
    }

    let backup_dir = local_backup_dir(&app)?;
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    let staging_path = backup_dir.join(format!("restore-staging-{stamp}.db"));
    fs::copy(&source, &staging_path)
        .map_err(|e| format!("Restore stopped before changing data: could not prepare the selected database: {e}"))?;
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

    restore_preserved_local_setup(&target, safety_backup.as_deref()).await?;

    Ok(RestoreDatabaseResult {
        restored_from: source.display().to_string(),
        replaced_database: target.display().to_string(),
        safety_backup,
        restart_required: false,
    })
}

#[tauri::command]
pub async fn restore_latest_local_backup(app: AppHandle) -> Result<RestoreDatabaseResult, String> {
    let backup = latest_local_backup(app.clone())
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

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        for sql in [
            "CREATE TABLE orders (id TEXT PRIMARY KEY, shiftId TEXT, customerId TEXT, employeeId TEXT, orderNumber INTEGER, receiptKey TEXT UNIQUE, type TEXT, status TEXT, originalOrderId TEXT, subtotal INTEGER, discountId TEXT, discountAmount INTEGER, taxTotal INTEGER, total INTEGER, tillNumber TEXT, notes TEXT, paymentMethod TEXT, amountTendered INTEGER, createdAt TEXT, completedAt TEXT, updatedAt TEXT)",
            "CREATE TABLE order_lines (id TEXT PRIMARY KEY, orderId TEXT, productId TEXT, productName TEXT, quantity INTEGER, unitPrice INTEGER, costPrice INTEGER, discountId TEXT, discountAmount INTEGER, taxRate REAL, taxAmount INTEGER, lineTotal INTEGER, isPriceOverride INTEGER, originalPrice INTEGER, notes TEXT, updatedAt TEXT)",
            "CREATE TABLE payments (id TEXT PRIMARY KEY, orderId TEXT, method TEXT, amount INTEGER, cashAmount INTEGER, cardAmount INTEGER, reference TEXT, changeGiven INTEGER, createdAt TEXT, updatedAt TEXT)",
            "CREATE TABLE products (id TEXT PRIMARY KEY, stockLevel INTEGER, updatedAt TEXT)",
            "CREATE TABLE inventory_logs (id TEXT PRIMARY KEY, productId TEXT, quantityChange INTEGER, type TEXT, referenceId TEXT, employeeId TEXT, notes TEXT, createdAt TEXT, updatedAt TEXT)",
            "CREATE TABLE audit_logs (id TEXT PRIMARY KEY, employeeId TEXT, action TEXT, entityType TEXT, entityId TEXT, oldData TEXT, newData TEXT, createdAt TEXT, updatedAt TEXT)",
            "CREATE TABLE customers (id TEXT PRIMARY KEY, loyaltyPoints INTEGER, updatedAt TEXT)",
            "CREATE TABLE loyalty_logs (id TEXT PRIMARY KEY, customerId TEXT, orderId TEXT, pointsChange INTEGER, reason TEXT, createdAt TEXT, updatedAt TEXT)",
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updatedAt TEXT)",
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

    fn bundle(id: &str, receipt: &str, payment: &str) -> SaleBundle {
        let stamp = "2026-06-07T12:00:00.000Z".to_string();
        SaleBundle {
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
    fn real_mariadb_two_till_simulation_when_configured() {
        let Ok(uri) = std::env::var("POS_TEST_MYSQL_URI") else {
            return;
        };
        tauri::async_runtime::block_on(async {
            let pool = MySqlPool::connect(&uri).await.unwrap();
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
            till_one.lines[0].product_id = "simulation-product".into();
            till_one.stock_changes[0].product_id = "simulation-product".into();
            let mut till_two = bundle(
                "simulation-order-2",
                "till-2:2000001",
                "simulation-payment-2",
            );
            till_two.lines[0].product_id = "simulation-product".into();
            till_two.stock_changes[0].product_id = "simulation-product".into();
            let pool_one = pool.clone();
            let pool_two = pool.clone();
            let one = tauri::async_runtime::spawn(async move {
                insert_mysql_bundle(&pool_one, &till_one).await
            });
            let two = tauri::async_runtime::spawn(async move {
                insert_mysql_bundle(&pool_two, &till_two).await
            });
            one.await.unwrap().unwrap();
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
        });
    }
}
