//! Bounded local mutations on ONE connection. The SQL plugin is pooled, so a
//! JavaScript BEGIN/COMMIT pair cannot provide this guarantee.
use serde::Deserialize;
use serde_json::{Map, Value};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteRow},
    Column, Connection, Row, SqliteConnection, TypeInfo, ValueRef,
};
use std::{collections::HashMap, time::Duration};

#[derive(Debug, Deserialize)]
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

pub async fn apply(conn: &mut SqliteConnection, mutations: &[Mutation]) -> Result<u64, String> {
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
            "upsert" | "insert" | "patch" | "remove" | "adjustStock"
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
        if mutation.protect_pending {
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
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(changed)
}

#[tauri::command]
pub async fn commit_local_batch(
    app: tauri::AppHandle,
    mutations: Vec<Mutation>,
) -> Result<u64, String> {
    let options = SqliteConnectOptions::new()
        .filename(crate::commerce::local_db_path(&app)?)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(10));
    let mut conn = SqliteConnection::connect_with(&options)
        .await
        .map_err(|e| e.to_string())?;
    apply(&mut conn, &mutations).await
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn database() -> SqliteConnection {
        let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL); CREATE TABLE _offline_queue (id TEXT PRIMARY KEY, table_name TEXT, operation TEXT, data TEXT, id_key TEXT, created_at TEXT)").execute(&mut db).await.unwrap();
        db
    }
    fn mutation(value: Value) -> Mutation {
        serde_json::from_value(value).unwrap()
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
