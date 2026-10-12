//! Bounded local mutations on ONE connection. The SQL plugin is pooled, so a
//! JavaScript BEGIN/COMMIT pair cannot provide this guarantee.
use serde::Deserialize;
use serde_json::{Map, Value};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteRow},
    Column, Connection, Row, SqliteConnection, TypeInfo, ValueRef,
};
use std::{collections::HashMap, time::Duration};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mutation {
    table: String,
    #[serde(default = "default_kind")]
    kind: String,
    #[serde(default = "default_key")]
    id_key: String,
    data: Map<String, Value>,
    queue_id: Option<String>,
    server_data_epoch: Option<String>,
    #[serde(default)]
    protect_pending: bool,
    #[serde(default)]
    authoritative_catalogue_delete: bool,
    expected_tax_rates: Option<Vec<Map<String, Value>>>,
}
fn default_kind() -> String {
    "upsert".into()
}
fn default_key() -> String {
    "id".into()
}

fn allowed_table(table: &str) -> bool {
    matches!(
        table,
        "app_identity"
            | "products"
            | "product_images"
            | "categories"
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
            | "customer_accounts"
            | "customer_account_entries"
            | "registers"
            | "suppliers"
            | "product_suppliers"
            | "inventory_logs"
            | "orders"
            | "order_lines"
            | "payments"
            | "loyalty_logs"
            | "audit_logs"
            | "shifts"
            | "cash_movements"
            | "till_report_markers"
            | "manager_approvals"
            | "stock_receipts"
            | "stock_receipt_lines"
            | "tombstones"
            | "daily_sales_summary"
    )
}
fn row_json(row: &SqliteRow) -> Result<Map<String, Value>, sqlx::Error> {
    let mut result = Map::new();
    for column in row.columns() {
        let value = row.try_get_raw(column.ordinal())?;
        let json = if value.is_null() {
            Value::Null
        } else {
            match value.type_info().name() {
                "INTEGER" => Value::from(row.try_get::<i64, _>(column.ordinal())?),
                "REAL" => Value::from(row.try_get::<f64, _>(column.ordinal())?),
                _ => Value::from(row.try_get::<String, _>(column.ordinal())?),
            }
        };
        result.insert(column.name().to_string(), json);
    }
    Ok(result)
}
async fn execute_values(
    conn: &mut SqliteConnection,
    sql: &str,
    values: Vec<Value>,
) -> Result<u64, sqlx::Error> {
    let mut query = sqlx::query(sql);
    for value in values {
        query = match value {
            Value::Null => query.bind(Option::<String>::None),
            Value::Bool(v) => query.bind(i64::from(v)),
            Value::Number(v) if v.is_i64() => query.bind(v.as_i64().unwrap()),
            Value::Number(v) => query.bind(v.as_f64().unwrap()),
            Value::String(v) => query.bind(v),
            v => query.bind(v.to_string()),
        };
    }
    Ok(query.execute(conn).await?.rows_affected())
}

async fn check_catalogue_mutation(conn: &mut SqliteConnection, mutation: &Mutation, id: &str) -> Result<(), String> {
    let fail = |message: &str| format!("CATALOGUE_INTEGRITY: {message}");
    let table = mutation.table.as_str();
    if mutation.authoritative_catalogue_delete &&
        (mutation.kind != "remove" || !matches!(table, "categories" | "tax_rates") || mutation.queue_id.is_some()) {
        return Err("Authoritative catalogue deletion is only for a nonqueued server-confirmed cache removal".into());
    }
    if mutation.kind == "remove" && matches!(table, "categories" | "tax_rates") && !mutation.authoritative_catalogue_delete {
        let field = if table == "categories" { "categoryId" } else { "taxRateId" };
        let used: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM products WHERE {field} = ?"))
            .bind(id).fetch_one(&mut *conn).await.map_err(|e| e.to_string())?;
        if used > 0 { return Err(fail("This record is used by items. Move all active and deactivated items first")); }
        let default: i64 = if table == "categories" {
            sqlx::query_scalar("SELECT COUNT(*) FROM settings WHERE key = 'default_product_category_id' AND value = ?")
                .bind(id).fetch_one(&mut *conn).await.map_err(|e| e.to_string())?
        } else {
            sqlx::query_scalar("SELECT COUNT(*) FROM tax_rates WHERE id = ? AND isDefault = 1")
                .bind(id).fetch_one(&mut *conn).await.map_err(|e| e.to_string())?
        };
        if default > 0 { return Err(fail("Choose another default before deleting this record")); }
    }
    // Server downloads may arrive by table/page, so validate local edits, not
    // a temporary cache download order. All user edits share BEGIN IMMEDIATE.
    if mutation.protect_pending || !matches!(mutation.kind.as_str(), "upsert" | "insert" | "patch") { return Ok(()); }
    if table == "products" {
        for (field, parent) in [("categoryId", "categories"), ("taxRateId", "tax_rates")] {
            let Some(reference) = mutation.data.get(field).and_then(Value::as_str).filter(|value| !value.is_empty()) else { continue; };
            let previous: Option<String> = sqlx::query_scalar(&format!("SELECT {field} FROM products WHERE id = ?"))
                .bind(id).fetch_optional(&mut *conn).await.map_err(|e| e.to_string())?.flatten();
            if previous.as_deref() == Some(reference) { continue; }
            let exists: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {parent} WHERE id = ?"))
                .bind(reference).fetch_one(&mut *conn).await.map_err(|e| e.to_string())?;
            if exists == 0 { return Err(fail("The selected category or tax rate no longer exists")); }
        }
    }
    if table == "settings" && id == "default_product_category_id" {
        if let Some(value) = mutation.data.get("value").and_then(Value::as_str).filter(|value| !value.is_empty()) {
            let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM categories WHERE id = ? AND isActive = 1")
                .bind(value).fetch_one(&mut *conn).await.map_err(|e| e.to_string())?;
            if exists == 0 { return Err(fail("Choose an existing active default category")); }
        }
    }
    if table == "categories" && mutation.data.get("isActive").map(|value| value == &Value::Bool(false) || value.as_i64() == Some(0)).unwrap_or(false) {
        let default: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM settings WHERE key = 'default_product_category_id' AND value = ?")
            .bind(id).fetch_one(&mut *conn).await.map_err(|e| e.to_string())?;
        if default > 0 { return Err(fail("Choose another default category before deactivating this one")); }
    }
    if table == "tombstones" {
        if let (Some(parent), Some(row_id)) = (mutation.data.get("table_name").and_then(Value::as_str), mutation.data.get("row_id").and_then(Value::as_str)) {
            if matches!(parent, "categories" | "tax_rates") {
                let exists: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {parent} WHERE id = ?"))
                    .bind(row_id).fetch_one(&mut *conn).await.map_err(|e| e.to_string())?;
                if exists > 0 { return Err(fail("Cannot publish a deletion while the catalogue row still exists")); }
            }
        }
    }
    Ok(())
}

fn normalized_tax_snapshot(rows: &[Map<String, Value>]) -> Vec<Value> {
    let mut normalized: Vec<Value> = rows.iter().map(|row| {
        let value = |key: &str| row.get(key).cloned().unwrap_or(Value::Null);
        let default = row.get("isDefault").map(|v| v == &Value::Bool(true) || v.as_i64() == Some(1)).unwrap_or(false);
        serde_json::json!({"id": value("id"), "name": value("name"),
            "rate": row.get("rate").and_then(Value::as_f64).unwrap_or(0.0),
            "isDefault": default, "createdAt": value("createdAt")})
    }).collect();
    normalized.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    normalized
}

#[cfg(test)]
pub async fn apply(conn: &mut SqliteConnection, mutations: &[Mutation]) -> Result<u64, String> {
    apply_inner(conn, mutations, None).await
}

async fn apply_inner(conn: &mut SqliteConnection, mutations: &[Mutation], qa_app: Option<&tauri::AppHandle>) -> Result<u64, String> {
    if mutations.len() > 2000 {
        return Err("Local batch exceeds 2000 mutations".into());
    }
    // Obtain the write lock before reading pending uploads or partial patches.
    let mut tx = conn
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|e| e.to_string())?;
    let mut columns: HashMap<String, Vec<String>> = HashMap::new();
    let mut changed = 0;
    for mutation in mutations {
        if mutation.table == "audit_logs" {
            if let Some(app) = qa_app {
                if mutations.iter().any(|row| row.table == "settings") {
                    crate::native_qa::checkpoint(app, "settings.before-audit").await?;
                }
                if mutations.iter().any(|row| row.kind == "setStock" && !row.protect_pending) {
                    crate::native_qa::checkpoint(app, "stock.before-audit").await?;
                }
            }
        }
        if let Some(expected) = &mutation.expected_tax_rates {
            if mutation.table != "tax_rates" || expected.len() > 2000 {
                return Err("A tax baseline is only valid for a bounded tax-rate save".into());
            }
            let current = sqlx::query("SELECT id, name, rate, isDefault, createdAt FROM tax_rates ORDER BY id")
                .fetch_all(&mut *tx).await.map_err(|e| e.to_string())?
                .iter().map(row_json).collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
            if normalized_tax_snapshot(&current) != normalized_tax_snapshot(expected) {
                return Err("Tax rates changed. Reload before saving.".into());
            }
        }
        let table = &mutation.table;
        let key = &mutation.id_key;
        if mutation.kind == "queue" {
            let operation = match table.as_str() {
                "promotion_bundle" => "promotionBundle",
                "promotion_delete" => "promotionDelete",
                "orders" => "heldOrderBundle",
                _ => return Err("Unsupported package upload".into()),
            };
            let queue_id = mutation
                .queue_id
                .as_deref()
                .ok_or("Package upload requires an identity")?;
            let mut payload = mutation.data.clone();
            payload.insert(
                "serverDataEpoch".into(),
                Value::from(mutation.server_data_epoch.as_deref().unwrap_or("")),
            );
            sqlx::query("INSERT INTO _offline_queue (id, table_name, operation, data, id_key, created_at) VALUES (?, ?, ?, ?, 'id', ?)")
                .bind(queue_id).bind(table).bind(operation).bind(Value::Object(payload).to_string())
                .bind(chrono::Utc::now().to_rfc3339()).execute(&mut *tx).await.map_err(|e| e.to_string())?;
            continue;
        }
        if !allowed_table(table) || (key != "id" && !(table == "settings" && key == "key")) {
            return Err("Unsupported local mutation table or key".into());
        }
        if !matches!(
            mutation.kind.as_str(),
            "upsert" | "insert" | "patch" | "remove" | "adjustStock" | "setStock"
        ) {
            return Err("Unsupported local mutation operation".into());
        }
        let id = mutation
            .data
            .get(key)
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .ok_or("Local mutation requires a non-empty row identity")?;
        if mutation.queue_id.is_some()
            && matches!(
                table.as_str(),
                "customer_accounts"
                    | "customer_account_entries"
                    | "employees"
                    | "employee_attendance"
            )
        {
            return Err("This operation requires its dedicated online command".into());
        }
        if mutation.kind == "setStock" && (table != "products" || mutation.queue_id.is_some()) {
            return Err("Counted stock requires products and cannot be queued as an absolute write".into());
        }
        let protected_identity;
        let mutation = if table == "app_identity" {
            if !matches!(mutation.kind.as_str(), "upsert" | "insert") {
                return Err("Shop identity requires its protected merge operation".into());
            }
            let existing = sqlx::query("SELECT * FROM app_identity WHERE id = ? LIMIT 1")
                .bind(id).fetch_optional(&mut *tx).await.map_err(|e| e.to_string())?
                .map(|row| row_json(&row)).transpose().map_err(|e| e.to_string())?;
            let merged = crate::licensing::merge_shop_license_identity(existing.as_ref(), &mutation.data)?;
            if existing.as_ref() == Some(&merged) && mutation.queue_id.is_none() {
                continue;
            }
            protected_identity = Mutation { data: merged, ..mutation.clone() };
            &protected_identity
        } else {
            mutation
        };
        // Signed issue time resolves pending licence renewals; an old queued
        // renewal must not hide a still newer licence downloaded from the shop.
        if mutation.protect_pending && table != "app_identity" {
            // A delayed tax snapshot must not undo a newer authoritative save.
            // Recheck under BEGIN IMMEDIATE, not just the JS preflight read.
            if table == "tax_rates" {
                let current: Option<String> = sqlx::query_scalar("SELECT updatedAt FROM tax_rates WHERE id = ?")
                    .bind(id).fetch_optional(&mut *tx).await.map_err(|e| e.to_string())?.flatten();
                if let (Some(current), Some(incoming)) = (current, mutation.data.get("updatedAt").and_then(Value::as_str)) {
                    if let (Ok(current), Ok(incoming)) = (chrono::DateTime::parse_from_rfc3339(&current), chrono::DateTime::parse_from_rfc3339(incoming)) {
                        if incoming < current { continue; }
                    }
                }
            }
            if matches!(table.as_str(), "orders" | "order_lines") {
                let pending_holds: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _offline_queue WHERE operation = 'heldOrderBundle'")
                    .fetch_one(&mut *tx).await.map_err(|e| e.to_string())?;
                if pending_holds > 0 { continue; }
            }
            if matches!(
                table.as_str(),
                "promo_groups" | "promo_group_items" | "discounts"
            ) {
                let packages: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _offline_queue WHERE operation IN ('promotionBundle','promotionDelete')")
                    .fetch_one(&mut *tx).await.map_err(|e| e.to_string())?;
                if packages > 0 {
                    continue;
                }
            }
            let pending: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM _offline_queue WHERE table_name = ? AND operation IN ('upsert','remove','adjustStock') AND CAST(json_extract(CASE WHEN json_valid(data) THEN data ELSE '{}' END, '$.' || id_key) AS TEXT) = ?")
                .bind(table).bind(id).fetch_one(&mut *tx).await.map_err(|e| e.to_string())?;
            if pending > 0 {
                continue;
            }
        }
        check_catalogue_mutation(&mut tx, mutation, id).await?;
        if !columns.contains_key(table) {
            let rows = sqlx::query(&format!("PRAGMA table_info(\"{table}\")"))
                .fetch_all(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
            columns.insert(
                table.clone(),
                rows.iter().map(|r| r.get::<String, _>("name")).collect(),
            );
        }
        let keys: Vec<&String> = mutation
            .data
            .keys()
            .filter(|k| columns[table].contains(k))
            .collect();
        let quote = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
        if mutation.kind == "remove" {
            if table == "pos_pages" {
                execute_values(
                    &mut tx,
                    "DELETE FROM pos_tiles WHERE pageId = ?",
                    vec![Value::from(id)],
                )
                .await
                .map_err(|e| e.to_string())?;
            }
            changed += execute_values(
                &mut tx,
                &format!("DELETE FROM {} WHERE {} = ?", quote(table), quote(key)),
                vec![Value::from(id)],
            )
            .await
            .map_err(|e| e.to_string())?;
        } else if mutation.kind == "setStock" {
            let quantity = |field: &str| -> Result<i64, String> {
                mutation.data.get(field).and_then(Value::as_i64)
                    .filter(|value| i32::try_from(*value).is_ok())
                    .ok_or_else(|| "Counted and expected stock must be whole numbers within the supported range".into())
            };
            let stock = quantity("stockLevel")?;
            let expected = quantity("expectedStockLevel")?;
            if mutation.protect_pending {
                // Server-first count cache only: never overwrite a sale/receipt
                // or another download which raced the authority round trip.
                let epoch: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'server_data_epoch_seen' LIMIT 1")
                    .fetch_optional(&mut *tx).await.map_err(|e| e.to_string())?;
                let expected_epoch = mutation.server_data_epoch.as_deref().filter(|value| !value.is_empty());
                if expected_epoch.is_none() || expected_epoch != epoch.as_deref() {
                    continue;
                }
                let pending: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM (SELECT table_name,operation,data FROM _offline_queue UNION ALL SELECT table_name,operation,data FROM _sync_conflicts) AS pending WHERE operation IN ('saleBundle','stockReceiptBundle') OR (table_name = 'products' AND CAST(json_extract(CASE WHEN json_valid(data) THEN data ELSE '{}' END, '$.id') AS TEXT) = ?)")
                    .bind(id).fetch_one(&mut *tx).await.map_err(|e| e.to_string())?;
                if pending > 0 { continue; }
                let current: Option<(i64, String)> = sqlx::query_as("SELECT COALESCE(stockLevel, 0), COALESCE(updatedAt, '') FROM products WHERE id = ?")
                    .bind(id).fetch_optional(&mut *tx).await.map_err(|e| e.to_string())?;
                let expected_stamp = mutation.data.get("expectedUpdatedAt").and_then(Value::as_str)
                    .ok_or("Stock cache refresh requires its original local version")?;
                if current.as_ref().is_none_or(|(stock, stamp)| *stock != expected || stamp != expected_stamp) {
                    continue;
                }
            }
            let stamp = mutation.data.get("updatedAt").and_then(Value::as_str)
                .map(str::to_owned).unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
            let count = execute_values(&mut tx,
                "UPDATE products SET stockLevel = ?, updatedAt = ? WHERE id = ? AND COALESCE(stockLevel, 0) = ?",
                vec![Value::from(stock), Value::from(stamp), Value::from(id), Value::from(expected)])
                .await.map_err(|e| e.to_string())?;
            if count != 1 { return Err("STOCK_COUNT_CONFLICT: Stock changed or the item was removed. Reload before counting again.".into()); }
            changed += count;
        } else if mutation.kind == "adjustStock" {
            if table != "products" {
                return Err("Stock changes require products".into());
            }
            let delta = mutation
                .data
                .get("delta")
                .and_then(Value::as_i64)
                .ok_or("Stock change requires a whole number")?;
            let count = execute_values(&mut tx, "UPDATE products SET stockLevel = COALESCE(stockLevel,0) + ?, updatedAt = ? WHERE id = ?",
                vec![Value::from(delta), Value::from(chrono::Utc::now().to_rfc3339()), Value::from(id)]).await.map_err(|e| e.to_string())?;
            if count == 0 {
                return Err("The product no longer exists".into());
            }
            changed += count;
        } else {
            if table == "pos_tiles" {
                if let (Some(page), Some(position)) =
                    (mutation.data.get("pageId"), mutation.data.get("position"))
                {
                    execute_values(
                        &mut tx,
                        "DELETE FROM pos_tiles WHERE pageId = ? AND position = ? AND id <> ?",
                        vec![page.clone(), position.clone(), Value::from(id)],
                    )
                    .await
                    .map_err(|e| e.to_string())?;
                }
            }
            if table == "promo_group_items" {
                if let (Some(group), Some(product)) =
                    (mutation.data.get("groupId"), mutation.data.get("productId"))
                {
                    execute_values(&mut tx, "DELETE FROM promo_group_items WHERE groupId = ? AND productId = ? AND id <> ?", vec![group.clone(), product.clone(), Value::from(id)])
                        .await.map_err(|e| e.to_string())?;
                }
            }
            let edits: Vec<_> = keys.iter().filter(|k| k.as_str() != key).copied().collect();
            let (sql, values) = if mutation.kind == "patch" {
                if edits.is_empty() {
                    return Err("Empty local patch".into());
                }
                let mut values: Vec<Value> =
                    edits.iter().map(|k| mutation.data[*k].clone()).collect();
                values.push(Value::from(id));
                (
                    format!(
                        "UPDATE {} SET {} WHERE {} = ?",
                        quote(table),
                        edits
                            .iter()
                            .map(|k| format!("{} = ?", quote(k)))
                            .collect::<Vec<_>>()
                            .join(","),
                        quote(key)
                    ),
                    values,
                )
            } else {
                let conflict = if edits.is_empty() || mutation.kind == "insert" {
                    "DO NOTHING".into()
                } else {
                    format!(
                        "DO UPDATE SET {}",
                        edits
                            .iter()
                            .map(|k| format!("{} = excluded.{}", quote(k), quote(k)))
                            .collect::<Vec<_>>()
                            .join(",")
                    )
                };
                (
                    format!(
                        "INSERT INTO {} ({}) VALUES ({}) ON CONFLICT({}) {}",
                        quote(table),
                        keys.iter().map(|k| quote(k)).collect::<Vec<_>>().join(","),
                        vec!["?"; keys.len()].join(","),
                        quote(key),
                        conflict
                    ),
                    keys.iter().map(|k| mutation.data[*k].clone()).collect(),
                )
            };
            let count = execute_values(&mut tx, &sql, values)
                .await
                .map_err(|e| e.to_string())?;
            if mutation.kind == "patch" && count == 0 {
                return Err("The edited row no longer exists".into());
            }
            if mutation.kind == "insert" && count == 0 {
                continue;
            }
            changed += count;
        }
        if let Some(queue_id) = &mutation.queue_id {
            let mut snapshot = if mutation.kind == "remove" || mutation.kind == "adjustStock" {
                mutation.data.clone()
            } else {
                let row = sqlx::query(&format!(
                    "SELECT * FROM {} WHERE {} = ?",
                    quote(table),
                    quote(key)
                ))
                .bind(id)
                .fetch_one(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
                row_json(&row).map_err(|e| e.to_string())?
            };
            snapshot.insert(
                "serverDataEpoch".into(),
                Value::from(mutation.server_data_epoch.as_deref().unwrap_or("")),
            );
            sqlx::query("INSERT INTO _offline_queue (id, table_name, operation, data, id_key, created_at) VALUES (?, ?, ?, ?, ?, ?)")
                .bind(queue_id).bind(table).bind(match mutation.kind.as_str() { "remove" => "remove", "adjustStock" => "adjustStock", _ => "upsert" })
                .bind(Value::Object(snapshot).to_string()).bind(key).bind(chrono::Utc::now().to_rfc3339())
                .execute(&mut *tx).await.map_err(|e| e.to_string())?;
        }
    }
    if mutations.iter().any(|mutation| mutation.expected_tax_rates.is_some()) {
        let defaults: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tax_rates WHERE isDefault = 1")
            .fetch_one(&mut *tx).await.map_err(|e| e.to_string())?;
        if defaults != 1 { return Err("Choose exactly one default tax rate".into()); }
    }
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(changed)
}

#[tauri::command]
pub async fn commit_local_batch(
    app: tauri::AppHandle,
    mutations: Vec<Mutation>,
) -> Result<u64, String> {
    // These checkpoints never alter the batch. Audit rejection happens inside
    // the real transaction so preceding mutations must roll back normally.
    if mutations.iter().any(|row| row.table == "settings") {
        crate::native_qa::checkpoint(&app, "settings.before-commit").await?;
    }
    if mutations.iter().any(|row| row.table == "settings" && row.data.get("key").and_then(Value::as_str).is_some_and(|key| key.starts_with("ui_font_"))) {
        crate::native_qa::checkpoint(&app, "settings.font").await?;
    }
    if mutations.iter().any(|row| row.kind == "setStock" && !row.protect_pending) {
        crate::native_qa::checkpoint(&app, "stock.before-count").await?;
    }
    if mutations.iter().any(|row| row.expected_tax_rates.is_some()) {
        crate::native_qa::checkpoint(&app, "tax.before-commit").await?;
    }
    let options = SqliteConnectOptions::new()
        .filename(crate::commerce::local_db_path(&app)?)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(10));
    let mut conn = SqliteConnection::connect_with(&options)
        .await
        .map_err(|e| e.to_string())?;
    apply_inner(&mut conn, &mutations, Some(&app)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tax_default_save_is_atomic_and_rejects_stale_editor() {
        tauri::async_runtime::block_on(async {
            let mut db = database().await;
            sqlx::query("CREATE TABLE tax_rates (id TEXT PRIMARY KEY, name TEXT NOT NULL, rate REAL, isDefault INTEGER, createdAt TEXT); INSERT INTO tax_rates VALUES ('old','Standard',0.2,1,'stamp')")
                .execute(&mut db).await.unwrap();
            let before = serde_json::json!([{"id":"old","name":"Standard","rate":0.2,"isDefault":true,"createdAt":"stamp"}]);
            let clear = || mutation(serde_json::json!({"table":"tax_rates","expectedTaxRates":before,"data":{"id":"old","name":"Standard","rate":0.2,"isDefault":false,"createdAt":"stamp"}}));
            let bad = mutation(serde_json::json!({"table":"tax_rates","data":{"id":"new","rate":0.0,"isDefault":true,"createdAt":"stamp"}}));
            assert!(apply(&mut db, &[clear(), bad]).await.is_err());
            let default: i64 = sqlx::query_scalar("SELECT isDefault FROM tax_rates WHERE id='old'").fetch_one(&mut db).await.unwrap();
            assert_eq!(default, 1);
            let saved = || mutation(serde_json::json!({"table":"tax_rates","data":{"id":"new","name":"Zero","rate":0.0,"isDefault":true,"createdAt":"stamp"}}));
            apply(&mut db, &[clear(), saved()]).await.unwrap();
            let defaults: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tax_rates WHERE isDefault=1").fetch_one(&mut db).await.unwrap();
            assert_eq!(defaults, 1);
            assert!(apply(&mut db, &[clear(), saved()]).await.unwrap_err().contains("Reload"));
            let actual: String = sqlx::query_scalar("SELECT id FROM tax_rates WHERE isDefault=1").fetch_one(&mut db).await.unwrap();
            assert_eq!(actual, "new");
        });
    }
    #[test]
    fn protected_tax_download_is_monotonic_and_accepts_fresh_rows() {
        tauri::async_runtime::block_on(async {
            let mut db = database().await;
            sqlx::query("CREATE TABLE tax_rates (id TEXT PRIMARY KEY, name TEXT NOT NULL, rate REAL, isDefault INTEGER, createdAt TEXT, updatedAt TEXT);
                INSERT INTO tax_rates VALUES ('standard','Standard',0.2,0,'created','2026-10-12T20:00:00.000Z');
                INSERT INTO tax_rates VALUES ('zero','Zero',0.0,1,'created','2026-10-12T20:00:00.000Z');")
                .execute(&mut db).await.unwrap();
            let download = |id: &str, name: &str, rate: f64, default: bool, stamp: &str| {
                mutation(serde_json::json!({"table":"tax_rates","protectPending":true,
                    "data":{"id":id,"name":name,"rate":rate,"isDefault":default,
                        "createdAt":"created","updatedAt":stamp}}))
            };
            // This older snapshot was read before the local default switch but
            // reaches the cache afterwards. Offset timestamps deliberately do
            // not sort lexically in UTC order: use actual instants, not strings.
            let stale = [
                download("standard", "Stale Standard", 0.2, true, "2026-10-12T20:59:59+01:00"),
                download("zero", "Stale Zero", 0.0, false, "2026-10-12T20:59:59+01:00"),
            ];
            assert_eq!(apply(&mut db, &stale).await.unwrap(), 0);
            let cached: Vec<(String, String, i64, String)> = sqlx::query_as(
                "SELECT id, name, isDefault, updatedAt FROM tax_rates ORDER BY id")
                .fetch_all(&mut db).await.unwrap();
            assert_eq!(cached, vec![
                ("standard".into(), "Standard".into(), 0, "2026-10-12T20:00:00.000Z".into()),
                ("zero".into(), "Zero".into(), 1, "2026-10-12T20:00:00.000Z".into()),
            ]);

            let fresh_stamp = "2026-10-12T21:01:00+01:00";
            let fresh = [
                download("standard", "Fresh Standard", 0.2, true, fresh_stamp),
                download("zero", "Fresh Zero", 0.0, false, fresh_stamp),
                download("reduced", "Reduced", 0.05, false, fresh_stamp),
            ];
            assert_eq!(apply(&mut db, &fresh).await.unwrap(), 3);
            let updated: Vec<(String, String, i64, String)> = sqlx::query_as(
                "SELECT id, name, isDefault, updatedAt FROM tax_rates ORDER BY id")
                .fetch_all(&mut db).await.unwrap();
            assert_eq!(updated, vec![
                ("reduced".into(), "Reduced".into(), 0, fresh_stamp.into()),
                ("standard".into(), "Fresh Standard".into(), 1, fresh_stamp.into()),
                ("zero".into(), "Fresh Zero".into(), 0, fresh_stamp.into()),
            ]);
            let defaults: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tax_rates WHERE isDefault = 1")
                .fetch_one(&mut db).await.unwrap();
            assert_eq!(defaults, 1);
            let queued: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _offline_queue")
                .fetch_one(&mut db).await.unwrap();
            assert_eq!(queued, 0, "Authoritative downloads must not create upload work");
        });
    }
    async fn database() -> SqliteConnection {
        let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL); CREATE TABLE _offline_queue (id TEXT PRIMARY KEY, table_name TEXT, operation TEXT, data TEXT, id_key TEXT, created_at TEXT)").execute(&mut db).await.unwrap();
        db
    }
    fn mutation(value: Value) -> Mutation {
        serde_json::from_value(value).unwrap()
    }
    async fn stock_database() -> SqliteConnection {
        let mut db = database().await;
        sqlx::query("ALTER TABLE products ADD COLUMN stockLevel INTEGER; ALTER TABLE products ADD COLUMN updatedAt TEXT;
            CREATE TABLE audit_logs (id TEXT PRIMARY KEY, action TEXT NOT NULL);
            CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE _sync_conflicts (id TEXT PRIMARY KEY, table_name TEXT, operation TEXT, data TEXT);
            INSERT INTO settings VALUES ('server_data_epoch_seen','epoch');
            INSERT INTO products VALUES ('p','Keep metadata',100,10,'original');")
            .execute(&mut db).await.unwrap();
        db
    }
    fn stock_count(expected: i64, stock: i64) -> Mutation {
        mutation(serde_json::json!({"table":"products","kind":"setStock","data":{
            "id":"p","stockLevel":stock,"expectedStockLevel":expected,"updatedAt":"counted"}}))
    }
    #[test]
    fn stock_count_cas_and_audit_are_atomic_without_full_product_upload() {
        tauri::async_runtime::block_on(async {
            let mut db = stock_database().await;
            let audit = mutation(serde_json::json!({"table":"audit_logs","data":{"id":"audit","action":"stock_counted"}}));
            apply(&mut db, &[stock_count(10,12), audit.clone()]).await.unwrap();
            let row: (i64,String,i64) = sqlx::query_as("SELECT stockLevel,name,price FROM products WHERE id='p'").fetch_one(&mut db).await.unwrap();
            assert_eq!(row,(12,"Keep metadata".into(),100));
            assert!(apply(&mut db, &[stock_count(10,99), audit]).await.unwrap_err().contains("STOCK_COUNT_CONFLICT"));
            let result: (i64,i64,i64) = sqlx::query_as("SELECT (SELECT stockLevel FROM products WHERE id='p'),(SELECT COUNT(*) FROM audit_logs),(SELECT COUNT(*) FROM _offline_queue)").fetch_one(&mut db).await.unwrap();
            assert_eq!(result,(12,1,0));
            let invalid_audit = mutation(serde_json::json!({"table":"audit_logs","data":{"id":"bad"}}));
            assert!(apply(&mut db, &[stock_count(12,20), invalid_audit]).await.is_err());
            let stock: i64 = sqlx::query_scalar("SELECT stockLevel FROM products WHERE id='p'").fetch_one(&mut db).await.unwrap();
            assert_eq!(stock,12,"Audit failure must roll back the count");
        });
    }
    #[test]
    fn stock_count_rejects_missing_fractional_overflow_and_queued_absolute_counts() {
        tauri::async_runtime::block_on(async {
            let mut db = stock_database().await;
            for data in [serde_json::json!({"id":"missing","stockLevel":12,"expectedStockLevel":10}),
                serde_json::json!({"id":"p","stockLevel":12.5,"expectedStockLevel":10}),
                serde_json::json!({"id":"p","stockLevel":2147483648_i64,"expectedStockLevel":10}),
                serde_json::json!({"id":"p","stockLevel":12,"expectedStockLevel":10.5})] {
                assert!(apply(&mut db,&[mutation(serde_json::json!({"table":"products","kind":"setStock","data":data}))]).await.is_err());
            }
            let mut queued = stock_count(10,12); queued.queue_id = Some("forbidden".into());
            assert!(apply(&mut db,&[queued]).await.unwrap_err().contains("cannot be queued"));
            let result: (i64,i64) = sqlx::query_as("SELECT (SELECT stockLevel FROM products WHERE id='p'),(SELECT COUNT(*) FROM _offline_queue)").fetch_one(&mut db).await.unwrap();
            assert_eq!(result,(10,0));
        });
    }
    #[test]
    fn shared_stock_cache_only_accepts_unchanged_same_epoch_unqueued_baseline() {
        tauri::async_runtime::block_on(async {
            for case in ["accept","stock","version","epoch","missing-epoch","product-queue","saleBundle","stockReceiptBundle","product-conflict","sale-conflict","receipt-conflict"] {
                let mut db = stock_database().await;
                let mut count = stock_count(10,12);
                count.protect_pending = true;
                count.server_data_epoch = Some("epoch".into());
                count.data.insert("expectedUpdatedAt".into(),Value::from("original"));
                match case {
                    "stock" => { sqlx::query("UPDATE products SET stockLevel=9").execute(&mut db).await.unwrap(); },
                    "version" => { sqlx::query("UPDATE products SET updatedAt='newer'").execute(&mut db).await.unwrap(); },
                    "epoch" => { sqlx::query("UPDATE settings SET value='replaced'").execute(&mut db).await.unwrap(); },
                    "missing-epoch" => { count.server_data_epoch=None; sqlx::query("DELETE FROM settings").execute(&mut db).await.unwrap(); },
                    "product-queue" => { sqlx::query("INSERT INTO _offline_queue (id,table_name,operation,data,id_key) VALUES ('q','products','adjustStock','{\"id\":\"p\",\"delta\":-1}','id')").execute(&mut db).await.unwrap(); },
                    "saleBundle" | "stockReceiptBundle" => { sqlx::query("INSERT INTO _offline_queue (id,table_name,operation,data,id_key) VALUES ('q','orders',?,'{}','id')").bind(case).execute(&mut db).await.unwrap(); },
                    "product-conflict" => { sqlx::query("INSERT INTO _sync_conflicts VALUES ('c','products','adjustStock','{\"id\":\"p\",\"delta\":-1}')").execute(&mut db).await.unwrap(); },
                    "sale-conflict" | "receipt-conflict" => { sqlx::query("INSERT INTO _sync_conflicts VALUES ('c','orders',?,'{}')").bind(if case=="sale-conflict" {"saleBundle"} else {"stockReceiptBundle"}).execute(&mut db).await.unwrap(); },
                    _ => {},
                }
                apply(&mut db,&[count]).await.unwrap();
                let row:(i64,String,i64)=sqlx::query_as("SELECT stockLevel,name,price FROM products WHERE id='p'").fetch_one(&mut db).await.unwrap();
                assert_eq!(row,(if case=="accept" {12} else if case=="stock" {9} else {10},"Keep metadata".into(),100),"{case}");
            }
        });
    }
    async fn catalogue_database() -> SqliteConnection {
        let mut db = database().await;
        sqlx::query("ALTER TABLE products ADD COLUMN categoryId TEXT; ALTER TABLE products ADD COLUMN taxRateId TEXT; ALTER TABLE products ADD COLUMN isActive INTEGER DEFAULT 1;
            CREATE TABLE categories (id TEXT PRIMARY KEY, isActive INTEGER DEFAULT 1);
            CREATE TABLE tax_rates (id TEXT PRIMARY KEY, isDefault INTEGER DEFAULT 0);
            CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE tombstones (id TEXT PRIMARY KEY, table_name TEXT, row_id TEXT);
            INSERT INTO categories VALUES ('cat', 1); INSERT INTO tax_rates VALUES ('tax', 0);")
            .execute(&mut db).await.unwrap();
        db
    }
    fn deletion(table: &str, id: &str) -> Vec<Mutation> {
        vec![
            mutation(serde_json::json!({"table":table,"kind":"remove","data":{"id":id},"queueId":"delete-q"})),
            mutation(serde_json::json!({"table":"tombstones","data":{"id":format!("{table}:{id}"),"table_name":table,"row_id":id},"queueId":"tombstone-q"})),
        ]
    }
    #[test]
    fn used_catalogue_deletion_rolls_back_record_tombstone_and_uploads() {
        tauri::async_runtime::block_on(async {
            for (table, id) in [("categories", "cat"), ("tax_rates", "tax")] {
                let mut db = catalogue_database().await;
                sqlx::query("INSERT INTO products (id,name,price,categoryId,taxRateId,isActive) VALUES ('p','Inactive item',100,'cat','tax',0)")
                    .execute(&mut db).await.unwrap();
                assert!(apply(&mut db, &deletion(table, id)).await.unwrap_err().contains("used by items"));
                let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table} WHERE id = ?"))
                    .bind(id).fetch_one(&mut db).await.unwrap();
                assert_eq!(count, 1);
                let leftovers: i64 = sqlx::query_scalar("SELECT (SELECT COUNT(*) FROM tombstones) + (SELECT COUNT(*) FROM _offline_queue)")
                    .fetch_one(&mut db).await.unwrap();
                assert_eq!(leftovers, 0);
            }
        });
    }
    #[test]
    fn catalogue_defaults_cannot_be_deleted_or_deactivated() {
        tauri::async_runtime::block_on(async {
            let mut db = catalogue_database().await;
            sqlx::query("INSERT INTO settings VALUES ('default_product_category_id','cat'); UPDATE tax_rates SET isDefault = 1")
                .execute(&mut db).await.unwrap();
            for (table, id) in [("categories", "cat"), ("tax_rates", "tax")] {
                assert!(apply(&mut db, &deletion(table, id)).await.unwrap_err().contains("another default"));
            }
            assert!(apply(&mut db, &[mutation(serde_json::json!({"table":"categories","kind":"patch","data":{"id":"cat","isActive":false}}))])
                .await.unwrap_err().contains("deactivating"));
        });
    }
    #[test]
    fn unused_catalogue_delete_commits_once_and_rejects_later_assignments() {
        tauri::async_runtime::block_on(async {
            let mut db = catalogue_database().await;
            apply(&mut db, &deletion("categories", "cat")).await.unwrap();
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tombstones").fetch_one(&mut db).await.unwrap();
            assert_eq!(count, 1);
            let product = mutation(serde_json::json!({"table":"products","data":{"id":"p","name":"New item","price":100,"categoryId":"cat"},"queueId":"product-q"}));
            assert!(apply(&mut db, &[product]).await.unwrap_err().contains("no longer exists"));
            let setting = mutation(serde_json::json!({"table":"settings","idKey":"key","data":{"key":"default_product_category_id","value":"cat"}}));
            assert!(apply(&mut db, &[setting]).await.unwrap_err().contains("existing active"));
        });
    }
    #[test]
    fn catalogue_assignment_and_delete_in_one_batch_are_atomic() {
        tauri::async_runtime::block_on(async {
            let mut db = catalogue_database().await;
            let mut operations = vec![mutation(serde_json::json!({"table":"products","data":{"id":"p","name":"New item","price":100,"categoryId":"cat"},"queueId":"product-q"}))];
            operations.extend(deletion("categories", "cat"));
            assert!(apply(&mut db, &operations).await.unwrap_err().contains("used by items"));
            let count: i64 = sqlx::query_scalar("SELECT (SELECT COUNT(*) FROM products) + (SELECT COUNT(*) FROM tombstones) + (SELECT COUNT(*) FROM _offline_queue)")
                .fetch_one(&mut db).await.unwrap();
            assert_eq!(count, 0);
        });
    }
    #[test]
    fn catalogue_guard_preserves_authoritative_download_order_and_unchanged_legacy_references() {
        tauri::async_runtime::block_on(async {
            let mut db = catalogue_database().await;
            let data = serde_json::json!({"id":"p","name":"Downloaded item","price":100,"categoryId":"not-downloaded-yet"});
            apply(&mut db, &[mutation(serde_json::json!({"table":"products","data":data,"protectPending":true}))]).await.unwrap();
            apply(&mut db, &[mutation(serde_json::json!({"table":"products","kind":"patch","data":{"id":"p","price":150,"categoryId":"not-downloaded-yet"}}))]).await.unwrap();
            assert!(apply(&mut db, &[mutation(serde_json::json!({"table":"products","kind":"patch","data":{"id":"p","categoryId":"another-missing-category"}}))])
                .await.unwrap_err().contains("no longer exists"));
        });
    }
    #[test]
    fn authoritative_catalogue_tombstone_can_precede_stale_product_and_default_downloads() {
        tauri::async_runtime::block_on(async {
            let mut db = catalogue_database().await;
            sqlx::query("INSERT INTO products (id,name,price,categoryId) VALUES ('p','Stale cached item',100,'cat');
                INSERT INTO settings VALUES ('default_product_category_id','cat'); INSERT INTO categories VALUES ('replacement',1);")
                .execute(&mut db).await.unwrap();
            // A user delete is still forbidden, including with protectPending.
            let unsafe_delete = mutation(serde_json::json!({"table":"categories","kind":"remove","data":{"id":"cat"},"protectPending":true}));
            assert!(apply(&mut db, &[unsafe_delete]).await.unwrap_err().contains("used by items"));
            // The server already moved the item/default and deleted the old
            // category. Tombstone sync runs before those dependency pages.
            let removal = mutation(serde_json::json!({"table":"categories","kind":"remove","data":{"id":"cat"},"authoritativeCatalogueDelete":true}));
            let tombstone = mutation(serde_json::json!({"table":"tombstones","data":{"id":"categories:cat","table_name":"categories","row_id":"cat"}}));
            apply(&mut db, &[removal, tombstone]).await.unwrap();
            apply(&mut db, &[
                mutation(serde_json::json!({"table":"products","kind":"patch","data":{"id":"p","categoryId":"replacement"},"protectPending":true})),
                mutation(serde_json::json!({"table":"settings","idKey":"key","data":{"key":"default_product_category_id","value":"replacement"},"protectPending":true})),
            ]).await.unwrap();
            let dangling: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM products p LEFT JOIN categories c ON c.id = p.categoryId WHERE c.id IS NULL")
                .fetch_one(&mut db).await.unwrap();
            assert_eq!(dangling, 0);
            let queued: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _offline_queue").fetch_one(&mut db).await.unwrap();
            assert_eq!(queued, 0);
        });
    }
    #[test]
    fn authoritative_catalogue_cache_marker_cannot_queue_a_delete_or_bypass_other_mutations() {
        tauri::async_runtime::block_on(async {
            let mut db = catalogue_database().await;
            for value in [
                serde_json::json!({"table":"categories","kind":"remove","data":{"id":"cat"},"queueId":"q","authoritativeCatalogueDelete":true}),
                serde_json::json!({"table":"categories","data":{"id":"cat","isActive":false},"authoritativeCatalogueDelete":true}),
                serde_json::json!({"table":"products","kind":"remove","data":{"id":"p"},"authoritativeCatalogueDelete":true}),
            ] {
                assert!(apply(&mut db, &[mutation(value)]).await.unwrap_err().contains("nonqueued server-confirmed"));
            }
        });
    }
    #[test]
    fn mutation_and_queue_roll_back_together() {
        tauri::async_runtime::block_on(async {
            let mut db = database().await;
            let op = || {
                mutation(
                    serde_json::json!({"table":"products","data":{"id":"p","name":"Bread","price":100},"queueId":"q","serverDataEpoch":"epoch"}),
                )
            };
            apply(&mut db, &[op()]).await.unwrap();
            let bad = mutation(
                serde_json::json!({"table":"products","kind":"patch","data":{"id":"p","price":200},"queueId":"q"}),
            );
            assert!(apply(&mut db, &[bad]).await.is_err());
            let price: i64 = sqlx::query_scalar("SELECT price FROM products")
                .fetch_one(&mut db)
                .await
                .unwrap();
            assert_eq!(price, 100);
        });
    }
    #[test]
    fn pending_local_edit_is_not_overwritten_by_download() {
        tauri::async_runtime::block_on(async {
            let mut db = database().await;
            let edit = mutation(
                serde_json::json!({"table":"products","data":{"id":"p","name":"Bread","price":100},"queueId":"q"}),
            );
            apply(&mut db, &[edit]).await.unwrap();
            let remote = mutation(
                serde_json::json!({"table":"products","data":{"id":"p","name":"Old","price":50},"protectPending":true}),
            );
            assert_eq!(apply(&mut db, &[remote]).await.unwrap(), 0);
        });
    }
    #[test]
    fn licence_download_keeps_local_paid_token_even_without_a_successful_upload_queue() {
        tauri::async_runtime::block_on(async {
            let mut db = database().await;
            sqlx::query("CREATE TABLE app_identity (id TEXT PRIMARY KEY, shopId TEXT, shopName TEXT, licenseId TEXT, identitySignature TEXT, createdAt TEXT, updatedAt TEXT)")
                .execute(&mut db).await.unwrap();
            // Existing public interoperability fixture; no private signing key
            // or real shop record is used in this isolated in-memory database.
            let token = "LBJ1.lbj-cloud-2026-07.eyJ2IjoxLCJsaWNlbnNlSWQiOiJsaWNfY2xvdWRfZml4dHVyZV8wMDEiLCJzaG9wSWQiOiJzaG9wX2Nsb3VkZml4dHVyZSIsImN1c3RvbWVyTmFtZSI6IkNsb3VkIEZpeHR1cmUgU2hvcCIsImlzc3VlZEF0IjoiMjAyNi0wNy0yMFQxMjowMDowMC4wMDBaIiwiZXhwaXJlc09uIjoiMjA5OS0xMi0zMSIsIm1heFRpbGxzIjoyLCJmZWF0dXJlcyI6WyJwb3MiXX0.SB54piDCwRkLtruLbFjNoYjOg0GBrr18v8bKEaT6P6GUMpJLbtuT20ElT7WKtnVvVXqIjbyrzuAa7seUCd3IAg";
            let paid = serde_json::json!({"id":"main","shopId":"shop_cloudfixture","shopName":"Fixture", "licenseId":"lic_cloud_fixture_001","identitySignature":token,"createdAt":"2026-07-01T00:00:00Z","updatedAt":"2026-07-20T00:00:00Z"});
            apply(&mut db, &[mutation(serde_json::json!({"table":"app_identity","data":paid}))]).await.unwrap();
            let mut older_remote = paid.clone();
            older_remote["identitySignature"] = Value::from("");
            older_remote["licenseId"] = Value::from("");
            older_remote["updatedAt"] = Value::from("2099-01-01T00:00:00Z");
            older_remote["createdAt"] = Value::from("2099-01-01T00:00:00Z");
            apply(&mut db, &[mutation(serde_json::json!({"table":"app_identity","data":older_remote,"protectPending":true}))]).await.unwrap();
            let stored: (String, String) = sqlx::query_as("SELECT identitySignature, createdAt FROM app_identity")
                .fetch_one(&mut db).await.unwrap();
            assert_eq!(stored, (token.to_string(), "2026-07-01T00:00:00Z".to_string()));

            // Even a queued stale upload cannot prevent a verified downloaded
            // code from repairing the cache; the upload merge also checks it.
            sqlx::query("UPDATE app_identity SET identitySignature = '', licenseId = ''")
                .execute(&mut db).await.unwrap();
            sqlx::query("INSERT INTO _offline_queue VALUES ('q-licence', 'app_identity', 'upsert', ?, 'id', '')")
                .bind(older_remote.to_string()).execute(&mut db).await.unwrap();
            apply(&mut db, &[mutation(serde_json::json!({"table":"app_identity","data":paid,"protectPending":true}))]).await.unwrap();
            let restored: String = sqlx::query_scalar("SELECT identitySignature FROM app_identity")
                .fetch_one(&mut db).await.unwrap();
            assert_eq!(restored, token);
            assert!(apply(&mut db, &[mutation(serde_json::json!({"table":"app_identity","kind":"remove","data":{"id":"main"}}))]).await.is_err());
        });
    }
    #[test]
    fn entire_page_rolls_back_on_invalid_row() {
        tauri::async_runtime::block_on(async {
            let mut db = database().await;
            let good = mutation(
                serde_json::json!({"table":"products","data":{"id":"a","name":"A","price":1}}),
            );
            let bad = mutation(serde_json::json!({"table":"products","data":{"id":"b","price":2}}));
            assert!(apply(&mut db, &[good, bad]).await.is_err());
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM products")
                .fetch_one(&mut db)
                .await
                .unwrap();
            assert_eq!(count, 0);
        });
    }
    #[test]
    fn failed_package_upload_rolls_back_local_edits() {
        tauri::async_runtime::block_on(async {
            let mut db = database().await;
            let upload = || {
                mutation(
                    serde_json::json!({"table":"promotion_bundle","kind":"queue","data":{"group":{"id":"g"}},"queueId":"q"}),
                )
            };
            apply(&mut db, &[upload()]).await.unwrap();
            let edit = mutation(
                serde_json::json!({"table":"products","data":{"id":"p","name":"Bread","price":100}}),
            );
            assert!(apply(&mut db, &[edit, upload()]).await.is_err());
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM products")
                .fetch_one(&mut db)
                .await
                .unwrap();
            assert_eq!(count, 0);
        });
    }
    #[test]
    fn reholding_clears_recovery_only_with_a_complete_local_save() {
        tauri::async_runtime::block_on(async {
            let mut db = database().await;
            sqlx::query("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); INSERT INTO settings VALUES ('held_order_recovery_v1', 'draft')").execute(&mut db).await.unwrap();
            let clear = || {
                mutation(
                    serde_json::json!({"table":"settings","idKey":"key","kind":"remove","data":{"key":"held_order_recovery_v1"}}),
                )
            };
            let bad =
                mutation(serde_json::json!({"table":"products","data":{"id":"bad","price":100}}));
            assert!(apply(&mut db, &[clear(), bad]).await.is_err());
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM settings")
                .fetch_one(&mut db)
                .await
                .unwrap();
            assert_eq!(count, 1);
            let good = mutation(
                serde_json::json!({"table":"products","data":{"id":"good","name":"Bread","price":100}}),
            );
            apply(&mut db, &[good, clear()]).await.unwrap();
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM settings")
                .fetch_one(&mut db)
                .await
                .unwrap();
            assert_eq!(count, 0);
        });
    }
}
