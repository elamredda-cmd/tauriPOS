//! Short-lived, pinned sessions for consistent reports and coordinated schema
//! upgrades. Normal checkout continues to use its dedicated commerce commands.
use serde::Serialize;
use serde_json::{Map, Value};
use sqlx::{Column, Connection, MySqlConnection, Row, TypeInfo, ValueRef};
use std::{
    collections::HashMap,
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

struct Session {
    conn: MySqlConnection,
    read_only: bool,
    touched: Instant,
}
type Sessions = Mutex<HashMap<String, Arc<Mutex<Session>>>>;
fn sessions() -> &'static Sessions {
    static SESSIONS: OnceLock<Sessions> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
pub async fn open_mysql_session(mysql_uri: String, purpose: String) -> Result<String, String> {
    if !matches!(purpose.as_str(), "report" | "schema") {
        return Err("Unsupported database session purpose".into());
    }
    if sessions().lock().await.len() >= 4 {
        return Err("Database is busy; try again shortly".into());
    }
    let mut conn =
        tokio::time::timeout(Duration::from_secs(5), MySqlConnection::connect(&mysql_uri))
            .await
            .map_err(|_| "Database connection timed out")?
            .map_err(|e| e.to_string())?;
    let read_only = purpose == "report";
    if read_only {
        sqlx::query("SET SESSION max_statement_time = 8")
            .execute(&mut conn)
            .await
            .map_err(|e| e.to_string())?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            .execute(&mut conn)
            .await
            .map_err(|e| e.to_string())?;
        sqlx::query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY")
            .execute(&mut conn)
            .await
            .map_err(|e| e.to_string())?;
    } else {
        // Named locks belong to the CONNECTION, which is why this cannot use
        // independent plugin execute calls. Disconnect releases it on failure.
        let locked: Option<i64> = sqlx::query_scalar(
            "SELECT GET_LOCK(CONCAT('pos_schema:', LEFT(SHA2(DATABASE(), 256), 40)), 10)",
        )
        .fetch_one(&mut conn)
        .await
        .map_err(|e| e.to_string())?;
        if locked != Some(1) {
            return Err("Another till is upgrading the database. Try again shortly.".into());
        }
        sqlx::query("SET SESSION lock_wait_timeout = 10")
            .execute(&mut conn)
            .await
            .map_err(|e| e.to_string())?;
    }
    let token = rand::random::<[u8; 24]>()
        .iter()
        .map(|v| format!("{v:02x}"))
        .collect::<String>();
    {
        let mut active = sessions().lock().await;
        // Recheck under the insertion lock: simultaneous connection opens may
        // both have passed the early, inexpensive capacity check.
        if active.len() >= 4 {
            return Err("Database is busy; try again shortly".into());
        }
        active.insert(
            token.clone(),
            Arc::new(Mutex::new(Session {
                conn,
                read_only,
                touched: Instant::now(),
            })),
        );
    }
    let expiry_token = token.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            let session = sessions().lock().await.get(&expiry_token).cloned();
            let Some(session) = session else {
                return;
            };
            if session.lock().await.touched.elapsed() > Duration::from_secs(60) {
                sessions().lock().await.remove(&expiry_token);
                return;
            }
        }
    });
    Ok(token)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    rows: Vec<Value>,
    rows_affected: u64,
    last_insert_id: u64,
}

#[tauri::command]
pub async fn query_mysql_session(
    token: String,
    sql: String,
    values: Vec<Value>,
    select: bool,
) -> Result<QueryResult, String> {
    let handle = sessions()
        .lock()
        .await
        .get(&token)
        .cloned()
        .ok_or("Database session expired; retry the operation")?;
    let mut session = handle.lock().await;
    let trimmed = sql.trim_start().to_ascii_uppercase();
    if session.read_only && (!select || trimmed.split_whitespace().next() != Some("SELECT")) {
        return Err("Report sessions only permit SELECT".into());
    }
    session.touched = Instant::now();
    let mut query = sqlx::query(&sql);
    for value in values {
        query = match value {
            Value::Null => query.bind(Option::<String>::None),
            Value::Bool(v) => query.bind(v),
            Value::Number(v) if v.is_i64() => query.bind(v.as_i64().unwrap()),
            Value::Number(v) => query.bind(v.as_f64().unwrap()),
            Value::String(v) => query.bind(v),
            v => query.bind(v.to_string()),
        };
    }
    if !select {
        let result =
            tokio::time::timeout(Duration::from_secs(60), query.execute(&mut session.conn))
                .await
                .map_err(|_| "Database maintenance timed out")?
                .map_err(|e| e.to_string())?;
        return Ok(QueryResult {
            rows: vec![],
            rows_affected: result.rows_affected(),
            last_insert_id: result.last_insert_id(),
        });
    }
    let rows = tokio::time::timeout(Duration::from_secs(30), query.fetch_all(&mut session.conn))
        .await
        .map_err(|_| "Database read timed out")?
        .map_err(|e| e.to_string())?;
    let mut result = Vec::with_capacity(rows.len());
    for row in rows {
        let mut object = Map::new();
        for column in row.columns() {
            let value = row
                .try_get_raw(column.ordinal())
                .map_err(|e| e.to_string())?;
            let kind = value.type_info().name().to_string();
            let json = if value.is_null() {
                Value::Null
            } else if kind.ends_with("UNSIGNED") || kind == "YEAR" {
                Value::from(
                    row.try_get::<u64, _>(column.ordinal())
                        .map_err(|e| e.to_string())?,
                )
            } else if matches!(
                kind.as_str(),
                "TINYINT" | "SMALLINT" | "INT" | "MEDIUMINT" | "BIGINT"
            ) {
                Value::from(
                    row.try_get::<i64, _>(column.ordinal())
                        .map_err(|e| e.to_string())?,
                )
            } else if kind == "FLOAT" {
                Value::from(
                    row.try_get::<f32, _>(column.ordinal())
                        .map_err(|e| e.to_string())?,
                )
            } else if kind == "DOUBLE" {
                Value::from(
                    row.try_get::<f64, _>(column.ordinal())
                        .map_err(|e| e.to_string())?,
                )
            } else if let Ok(text) = row.try_get::<String, _>(column.ordinal()) {
                Value::String(text)
            } else if let Ok(bytes) = row.try_get::<Vec<u8>, _>(column.ordinal()) {
                Value::String(String::from_utf8(bytes).map_err(|e| e.to_string())?)
            } else {
                return Err(format!(
                    "Unsupported result type {kind}; cast the selected column explicitly"
                ));
            };
            object.insert(column.name().into(), json);
        }
        result.push(Value::Object(object));
    }
    Ok(QueryResult {
        rows: result,
        rows_affected: 0,
        last_insert_id: 0,
    })
}

#[tauri::command]
pub async fn close_mysql_session(token: String) -> Result<(), String> {
    // Dropping the connection rolls back the read snapshot / releases GET_LOCK.
    sessions().lock().await.remove(&token);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn live_snapshot_is_consistent_and_schema_lock_is_connection_scoped() {
        let Ok(uri) = std::env::var("POS_TEST_MYSQL_URI") else {
            return;
        };
        assert!(
            uri.contains("pos_audit_") || uri.contains("pos_test_"),
            "Only disposable test databases may be used"
        );
        tauri::async_runtime::block_on(async {
            let mut writer = MySqlConnection::connect(&uri).await.unwrap();
            sqlx::query("CREATE TABLE pos_test_snapshot (id INT PRIMARY KEY, amount BIGINT)")
                .execute(&mut writer)
                .await
                .unwrap();
            sqlx::query("INSERT INTO pos_test_snapshot VALUES (1, 100)")
                .execute(&mut writer)
                .await
                .unwrap();
            let token = open_mysql_session(uri.clone(), "report".into())
                .await
                .unwrap();
            let first = query_mysql_session(
                token.clone(),
                "SELECT\n amount FROM pos_test_snapshot WHERE id = 1".into(),
                vec![],
                true,
            )
            .await
            .unwrap();
            sqlx::query("UPDATE pos_test_snapshot SET amount = 200 WHERE id = 1")
                .execute(&mut writer)
                .await
                .unwrap();
            let second = query_mysql_session(
                token.clone(),
                "SELECT amount FROM pos_test_snapshot WHERE id = 1".into(),
                vec![],
                true,
            )
            .await
            .unwrap();
            assert_eq!(first.rows[0]["amount"], 100);
            assert_eq!(second.rows[0]["amount"], 100);
            assert!(query_mysql_session(
                token.clone(),
                "DELETE FROM pos_test_snapshot".into(),
                vec![],
                false
            )
            .await
            .is_err());
            close_mysql_session(token).await.unwrap();
            let schema = open_mysql_session(uri, "schema".into()).await.unwrap();
            let locked: i64 = sqlx::query_scalar(
                "SELECT GET_LOCK(CONCAT('pos_schema:', LEFT(SHA2(DATABASE(), 256), 40)), 0)",
            )
            .fetch_one(&mut writer)
            .await
            .unwrap();
            assert_eq!(locked, 0);
            close_mysql_session(schema).await.unwrap();
            let acquired: i64 = sqlx::query_scalar(
                "SELECT GET_LOCK(CONCAT('pos_schema:', LEFT(SHA2(DATABASE(), 256), 40)), 3)",
            )
            .fetch_one(&mut writer)
            .await
            .unwrap();
            assert_eq!(acquired, 1);
            sqlx::query("DROP TABLE pos_test_snapshot")
                .execute(&mut writer)
                .await
                .unwrap();
        });
    }
}
