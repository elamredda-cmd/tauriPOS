//! Explicit, administrator-authenticated handover of old sandbox journals.
//! Provider evidence is fetched natively; no renderer-supplied outcome is trusted.
use super::*;
use sqlx::SqliteConnection;

const ACTIVE: &str =
    "'prepared','started','uncertain','approved','commit_failed','completion_pending'";
const SETTLE_SECONDS: i64 = 30;

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DojoSandboxRecoveryResult {
    resolved: usize,
    remaining: i64,
    switched_to_dedicated: bool,
    issues: Vec<String>,
    waiting_for_confirmation: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    id: String,
    provider: String,
    terminal_key: String,
    client_transaction_id: String,
    terminal_session_id: String,
    operation_kind: String,
    amount: i64,
    expected_provider_amount: i64,
    currency: String,
    status: String,
    sale_bundle: String,
    provider_reference: String,
    operator_resolution: String,
    error: String,
    till_id: String,
    created_at: String,
    updated_at: String,
    journal_scope: String,
}

#[derive(Debug, Clone, PartialEq)]
struct Evidence {
    payment_id: String,
    session_id: String,
    provider_status: String,
}

async fn ensure_receipts(conn: &mut SqliteConnection) -> Result<(), String> {
    local_terminal::ensure_schema(conn).await?;
    sqlx::query("CREATE TABLE IF NOT EXISTS dojo_sandbox_recovery_receipts(attemptId TEXT PRIMARY KEY,terminalKey TEXT NOT NULL,paymentIntentId TEXT NOT NULL,terminalSessionId TEXT NOT NULL DEFAULT '',amount INTEGER NOT NULL,currency TEXT NOT NULL,providerStatus TEXT NOT NULL,verifiedAt TEXT NOT NULL,confirmedAt TEXT NOT NULL DEFAULT '',employeeId TEXT NOT NULL,originalJournal TEXT NOT NULL)")
        .execute(conn).await.map_err(|e| e.to_string())?;
    Ok(())
}

fn journal_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<Journal, String> {
    macro_rules! field {
        ($name:literal) => {
            row.try_get($name).map_err(|e| e.to_string())?
        };
    }
    Ok(Journal {
        id: field!("id"),
        provider: field!("provider"),
        terminal_key: field!("terminalKey"),
        client_transaction_id: field!("clientTransactionId"),
        terminal_session_id: field!("terminalSessionId"),
        operation_kind: field!("operationKind"),
        amount: field!("amount"),
        expected_provider_amount: field!("expectedProviderAmount"),
        currency: field!("currency"),
        status: field!("status"),
        sale_bundle: field!("saleBundle"),
        provider_reference: field!("providerReference"),
        operator_resolution: field!("operatorResolution"),
        error: field!("error"),
        till_id: field!("tillId"),
        created_at: field!("createdAt"),
        updated_at: field!("updatedAt"),
        journal_scope: field!("journalScope"),
    })
}

async fn read_journal(conn: &mut SqliteConnection, id: &str) -> Result<Journal, String> {
    let row = sqlx::query("SELECT * FROM payment_terminal_attempts WHERE id=? AND provider='dojo'")
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("The original payment journal is missing; no payment was cleared.")?;
    journal_from_row(&row)
}

fn sandbox_id(value: &str, prefix: &str) -> bool {
    value.starts_with(prefix)
        && value.len() > prefix.len()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

fn validate_config(config: &DojoStoredConfig) -> Result<(), String> {
    if !config.api_key.starts_with("sk_sandbox_")
        || config.api_key.len() <= "sk_sandbox_".len()
        || !sandbox_id(&config.terminal_id, "tm_sandbox_")
    {
        return Err("This recovery action requires the saved sandbox API key and a sandbox terminal. Live payments require normal payment review.".into());
    }
    Ok(())
}

fn validate_journal(config: &DojoStoredConfig, journal: &Journal) -> Result<String, String> {
    validate_config(config)?;
    if journal.provider != "dojo"
        || journal.journal_scope != "shared"
        || !matches!(
            journal.status.as_str(),
            "prepared" | "started" | "uncertain"
        )
        || journal.operation_kind != "sale"
        || !journal.operator_resolution.is_empty()
    {
        return Err("This payment has approved, financial-account or reviewed work and needs normal payment review.".into());
    }
    let terminal = journal
        .terminal_key
        .strip_prefix(&format!("dojo:{}:", config.software_house_id))
        .filter(|id| sandbox_id(id, "tm_sandbox_"))
        .ok_or("This journal does not identify a sandbox terminal for the saved integration.")?;
    if journal.id.is_empty()
        || journal.id.len() > 60
        || !journal
            .id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        || journal.amount <= 0
        || journal.amount > 9_007_199_254_740_991
        || (journal.expected_provider_amount != 0
            && journal.expected_provider_amount != journal.amount)
        || normalize_currency(&journal.currency)? != journal.currency
        || (!journal.client_transaction_id.is_empty()
            && !sandbox_id(&journal.client_transaction_id, "pi_sandbox_"))
        || (!journal.terminal_session_id.is_empty()
            && !sandbox_id(&journal.terminal_session_id, "ts_sandbox_"))
    {
        return Err("The sandbox journal has missing or inconsistent payment details; it was kept for review.".into());
    }
    validate_sale_payload(journal)?;
    Ok(terminal.into())
}

fn validate_sale_payload(journal: &Journal) -> Result<String, String> {
    let payload: Value = serde_json::from_str(&journal.sale_bundle)
        .map_err(|_| "The old payment payload is invalid; keep this payment for review.")?;
    let payment_id = payload
        .pointer("/payment/id")
        .and_then(Value::as_str)
        .unwrap_or("");
    let accounts_empty = match payload.get("accountChanges") {
        None | Some(Value::Null) => true,
        Some(Value::Array(changes)) => changes.is_empty(),
        _ => false,
    };
    let account_amount = payload.pointer("/payment/accountAmount");
    if payload.get("kind").is_some_and(|kind| !kind.is_null())
        || payload.pointer("/order/type").and_then(Value::as_str) != Some("sale")
        || payload.pointer("/order/id").and_then(Value::as_str) != Some(journal.id.as_str())
        || payload.pointer("/payment/orderId").and_then(Value::as_str) != Some(journal.id.as_str())
        || payload
            .pointer("/payment/cardAmount")
            .and_then(Value::as_i64)
            != Some(journal.amount)
        || payment_id.trim().is_empty()
        || payment_id.len() > 128
        || payment_id.chars().any(char::is_control)
        || !accounts_empty
        || account_amount.is_some_and(|value| !value.is_null() && value.as_i64() != Some(0))
        || payload
            .get("originalOrderToUpdate")
            .is_some_and(|value| !value.is_null() && value.as_str() != Some(""))
        || payload
            .get("originalStatusUpdate")
            .is_some_and(|value| !value.is_null() && value.as_str() != Some(""))
    {
        return Err("The stored payload is not a matching ordinary card sale. Customer-account, refund or inconsistent financial work needs normal review.".into());
    }
    Ok(payment_id.into())
}

async fn get_value(
    client: &Client,
    base: &str,
    config: &DojoStoredConfig,
    path: &str,
    terminal: bool,
) -> Result<Value, String> {
    let response = api_request(
        client,
        reqwest::Method::GET,
        format!("{base}{path}"),
        config,
        terminal,
    )
    .send()
    .await
    .map_err(|_| "Could not contact Dojo. Keep the key and retry when internet is available.")?;
    if !response.status().is_success() {
        return Err(api_error(response).await);
    }
    response
        .json()
        .await
        .map_err(|_| "Dojo returned invalid recovery data.".into())
}

async fn search(
    client: &Client,
    base: &str,
    config: &DojoStoredConfig,
    journal: &Journal,
) -> Result<DojoPaymentIntentReferenceResult, String> {
    let (start, end) = payment_intent_search_window(&journal.created_at, Utc::now())?;
    let mut after = None;
    let mut seen = HashSet::new();
    let mut found = None;
    for _ in 0..PAYMENT_INTENT_SEARCH_MAX_PAGES {
        let response = api_request(
            client,
            reqwest::Method::POST,
            format!("{base}/payment-intents/search"),
            config,
            false,
        )
        .json(&payment_intent_search_payload(
            &start,
            &end,
            after.as_deref(),
        ))
        .send()
        .await
        .map_err(|_| "Could not contact Dojo while looking up the old payment.")?;
        if !response.status().is_success() {
            return Err(api_error(response).await);
        }
        let value: Value = response
            .json()
            .await
            .map_err(|_| "Dojo returned invalid payment-search data.")?;
        let (matches, next) = parse_payment_intent_search_page(&value, &journal.id)?;
        merge_unique_reference_matches(&mut found, matches)?;
        match next {
            None => return found.ok_or_else(|| "Dojo could not find this payment reference. It remains unresolved; keep its key for review.".into()),
            Some(next) if seen.insert(next.clone()) => after = Some(next),
            Some(_) => return Err("Dojo repeated a search page; no payment was cleared.".into()),
        }
    }
    Err("Dojo returned too many search pages; no payment was cleared.".into())
}

fn validate_payment(
    journal: &Journal,
    payment: &DojoPaymentIntentStatus,
    id: &str,
) -> Result<(), String> {
    let proof = SandboxCancellationProof {
        attempt_id: journal.id.clone(),
        terminal_key: journal.terminal_key.clone(),
        payment_intent_id: id.into(),
        terminal_session_id: journal.terminal_session_id.clone(),
        operation_kind: journal.operation_kind.clone(),
        amount: journal.amount,
        currency: journal.currency.clone(),
        status: journal.status.clone(),
    };
    validate_sandbox_cancellation_payment(&proof, payment, &payment.status)?;
    if !sandbox_id(id, "pi_sandbox_")
        || payment.terminal_history_error.is_some()
        || payment
            .total_amount
            .as_ref()
            .is_some_and(|money| money.value != journal.amount)
        || [
            &payment.tips_amount,
            &payment.cashback_amount,
            &payment.service_charge_amount,
        ]
        .into_iter()
        .flatten()
        .any(|money| money.value != 0)
    {
        return Err("The provider payment contains inconsistent money or terminal history; keep it for review.".into());
    }
    Ok(())
}

fn validate_session(
    journal: &Journal,
    terminal: &str,
    intent: &str,
    session_id: &str,
    value: &Value,
) -> Result<(), String> {
    if !sandbox_id(session_id, "ts_sandbox_")
        || value.get("id").and_then(Value::as_str) != Some(session_id)
        || value.get("terminalId").and_then(Value::as_str) != Some(terminal)
        || value
            .pointer("/details/sale/paymentIntentId")
            .and_then(Value::as_str)
            != Some(intent)
    {
        return Err(format!(
            "Dojo returned different terminal/payment details for {}. It remains unresolved.",
            journal.id
        ));
    }
    match value.get("status").and_then(Value::as_str) {
        Some("Expired" | "Declined" | "Canceled" | "SignatureVerificationRejected") => Ok(()),
        _ => Err("This terminal session is active, successful or unconfirmed. Finish it on its original till or use normal payment review.".into()),
    }
}

async fn verify_provider(
    client: &Client,
    base: &str,
    config: &DojoStoredConfig,
    journal: &Journal,
) -> Result<Evidence, String> {
    let terminal = validate_journal(config, journal)?;
    let searched =
        if journal.client_transaction_id.is_empty() || journal.terminal_session_id.is_empty() {
            Some(search(client, base, config, journal).await?)
        } else {
            None
        };
    let id = if journal.client_transaction_id.is_empty() {
        searched
            .as_ref()
            .map(|r| r.payment.id.as_str())
            .ok_or("The provider payment ID is missing.")?
    } else {
        &journal.client_transaction_id
    };
    if !sandbox_id(id, "pi_sandbox_") || searched.as_ref().is_some_and(|r| r.payment.id != id) {
        return Err(
            "Reference search disagreed with the original payment ID; no payment was cleared."
                .into(),
        );
    }
    let raw = get_value(
        client,
        base,
        config,
        &format!("/payment-intents/{id}?returnCanceled=true"),
        false,
    )
    .await?;
    let payment = payment_intent_from_value(&raw);
    validate_payment(journal, &payment, id)?;
    let latest = payment.latest_terminal_session_id.as_deref().unwrap_or("");
    let session_id = if journal.terminal_session_id.is_empty() {
        latest
    } else {
        &journal.terminal_session_id
    };
    if payment.status == "Created" && !session_id.is_empty() && latest != session_id {
        return Err("Dojo did not confirm that this is the latest terminal session. The unused payment was not cancelled; keep it for review.".into());
    }
    if !latest.is_empty() && latest != session_id {
        return Err("The payment has a newer terminal session than this journal. Review the original payment before changing registration.".into());
    }
    if !session_id.is_empty() {
        let session = get_value(
            client,
            base,
            config,
            &format!("/terminal-sessions/{session_id}"),
            true,
        )
        .await?;
        validate_session(journal, &terminal, id, session_id, &session)?;
    } else if searched
        .as_ref()
        .is_none_or(|r| r.terminal_session_id.is_some())
    {
        return Err(
            "The payment has no verified terminal-session history; it remains unresolved.".into(),
        );
    }
    if payment.status == "Created" {
        let response = payment_intent_cancel_request(client, base, config, id)
            .send()
            .await;
        // Always re-read after DELETE, including transport failure/capture race.
        if let Ok(response) = response {
            if !response.status().is_success() {
                let _ = api_error(response).await;
            }
        }
    } else if !matches!(payment.status.as_str(), "Canceled" | "Reversed") {
        return Err(format!("Dojo reports {}. Approved or captured money must be recovered normally; this payment was not cleared.", payment.status));
    }
    let final_value = get_value(
        client,
        base,
        config,
        &format!("/payment-intents/{id}?returnCanceled=true"),
        false,
    )
    .await?;
    let final_payment = payment_intent_from_value(&final_value);
    validate_payment(journal, &final_payment, id)?;
    if !matches!(final_payment.status.as_str(), "Canceled" | "Reversed")
        || final_payment
            .latest_terminal_session_id
            .as_deref()
            .unwrap_or("")
            != latest
    {
        return Err(format!(
            "Dojo still reports {} or changed terminal history. No payment was cleared.",
            final_payment.status
        ));
    }
    Ok(Evidence {
        payment_id: id.into(),
        session_id: session_id.into(),
        provider_status: final_payment.status,
    })
}

async fn no_ledger(
    conn: &mut SqliteConnection,
    journal: &Journal,
    evidence: &Evidence,
) -> Result<(), String> {
    let payment_id = validate_sale_payload(journal)?;
    let orders: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM orders WHERE id=?")
        .bind(&journal.id)
        .fetch_one(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
    let payments: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM payments WHERE orderId=? OR reference=? OR reference=? OR id=?",
    )
    .bind(&journal.id)
    .bind(&evidence.payment_id)
    .bind(&journal.id)
    .bind(payment_id)
    .fetch_one(conn)
    .await
    .map_err(|e| e.to_string())?;
    if orders != 0 || payments != 0 {
        return Err(
            "This payment already has local accounting entries; use normal payment review.".into(),
        );
    }
    Ok(())
}

async fn staff_version(conn: &mut SqliteConnection, employee: &str) -> Result<String, String> {
    sqlx::query_scalar("SELECT updatedAt FROM employees WHERE id=? AND role='admin' AND isActive=1")
        .bind(employee)
        .fetch_optional(conn)
        .await
        .map_err(|e| e.to_string())?
        .filter(|s: &String| !s.is_empty())
        .ok_or_else(|| "The administrator profile changed; sign in again before recovery.".into())
}

/// Called only within a short IMMEDIATE transaction, after reauthentication.
async fn persist_evidence(
    conn: &mut SqliteConnection,
    journal: &Journal,
    evidence: &Evidence,
    employee: &str,
    now: DateTime<Utc>,
) -> Result<bool, String> {
    local_terminal::assert_local_write_allowed(conn).await?;
    if read_journal(conn, &journal.id).await? != *journal {
        return Err(
            "The payment journal changed while Dojo was checked. Refresh and retry recovery."
                .into(),
        );
    }
    no_ledger(conn, journal, evidence).await?;
    let original = serde_json::to_string(journal).map_err(|e| e.to_string())?;
    let previous = sqlx::query("SELECT * FROM dojo_sandbox_recovery_receipts WHERE attemptId=?")
        .bind(&journal.id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
    let settled = if let Some(row) = previous {
        let same = row
            .try_get::<String, _>("originalJournal")
            .map_err(|e| e.to_string())?
            == original
            && row
                .try_get::<String, _>("paymentIntentId")
                .map_err(|e| e.to_string())?
                == evidence.payment_id
            && row
                .try_get::<String, _>("terminalSessionId")
                .map_err(|e| e.to_string())?
                == evidence.session_id
            && row
                .try_get::<String, _>("providerStatus")
                .map_err(|e| e.to_string())?
                == evidence.provider_status;
        let first: String = row.try_get("verifiedAt").map_err(|e| e.to_string())?;
        same && DateTime::parse_from_rfc3339(&first)
            .ok()
            .is_some_and(|first| now.signed_duration_since(first).num_seconds() >= SETTLE_SECONDS)
    } else {
        false
    };
    let stamp = now.to_rfc3339_opts(SecondsFormat::Millis, true);
    if !settled {
        // Preserve the first matching observation; a changed identity/outcome restarts settling.
        sqlx::query("INSERT INTO dojo_sandbox_recovery_receipts(attemptId,terminalKey,paymentIntentId,terminalSessionId,amount,currency,providerStatus,verifiedAt,confirmedAt,employeeId,originalJournal) VALUES(?,?,?,?,?,?,?,?,'',?,?) ON CONFLICT(attemptId) DO UPDATE SET terminalKey=excluded.terminalKey,paymentIntentId=excluded.paymentIntentId,terminalSessionId=excluded.terminalSessionId,amount=excluded.amount,currency=excluded.currency,providerStatus=excluded.providerStatus,verifiedAt=CASE WHEN dojo_sandbox_recovery_receipts.originalJournal=excluded.originalJournal AND dojo_sandbox_recovery_receipts.paymentIntentId=excluded.paymentIntentId AND dojo_sandbox_recovery_receipts.terminalSessionId=excluded.terminalSessionId AND dojo_sandbox_recovery_receipts.providerStatus=excluded.providerStatus THEN dojo_sandbox_recovery_receipts.verifiedAt ELSE excluded.verifiedAt END,confirmedAt='',employeeId=excluded.employeeId,originalJournal=excluded.originalJournal")
            .bind(&journal.id).bind(&journal.terminal_key).bind(&evidence.payment_id).bind(&evidence.session_id).bind(journal.amount).bind(&journal.currency)
            .bind(&evidence.provider_status).bind(&stamp).bind(employee).bind(&original).execute(&mut *conn).await.map_err(|e| e.to_string())?;
        return Ok(false);
    }
    sqlx::query("UPDATE payment_terminal_attempts SET status='cancelled',clientTransactionId=?,terminalSessionId=?,error='Dojo sandbox no-charge result verified twice; shared acknowledgement pending',updatedAt=? WHERE id=? AND provider='dojo' AND journalScope='shared'")
        .bind(&evidence.payment_id).bind(&evidence.session_id).bind(&stamp).bind(&journal.id).execute(&mut *conn).await.map_err(|e| e.to_string())?;
    sqlx::query(
        "UPDATE dojo_sandbox_recovery_receipts SET confirmedAt=?,employeeId=? WHERE attemptId=?",
    )
    .bind(&stamp)
    .bind(employee)
    .bind(&journal.id)
    .execute(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    let audit_id = format!("{:032x}", rand::random::<u128>());
    sqlx::query("INSERT INTO audit_logs(id,employeeId,action,entityType,entityId,oldData,newData,createdAt,updatedAt) VALUES(?,?,'dojo_sandbox_shared_recovery','payment_terminal_attempt',?,?,?,?,?)")
        .bind(audit_id).bind(employee).bind(&journal.id).bind(original)
        .bind(json!({"paymentIntentId":evidence.payment_id,"terminalSessionId":evidence.session_id,"providerStatus":evidence.provider_status,"status":"cancelled","confirmedAt":stamp}).to_string())
        .bind(&stamp).bind(&stamp).execute(conn).await.map_err(|e| e.to_string())?;
    Ok(true)
}

async fn active_count(conn: &mut SqliteConnection) -> Result<i64, String> {
    sqlx::query_scalar(&format!("SELECT COUNT(*) FROM payment_terminal_attempts WHERE provider='dojo' AND status IN ({ACTIVE})"))
        .fetch_one(conn).await.map_err(|e| e.to_string())
}

fn validate_handover_terminal(config: &DojoStoredConfig, terminal: &Value) -> Result<(), String> {
    validate_config(config)?;
    if terminal.get("id").and_then(Value::as_str) != Some(config.terminal_id.as_str())
        || !matches!(
            terminal.get("status").and_then(Value::as_str),
            Some("Available" | "Offline")
        )
    {
        return Err("The selected sandbox terminal is busy or its status is unconfirmed. Wait until it is idle and run recovery again.".into());
    }
    Ok(())
}

fn dedicated_config(
    expected: &DojoStoredConfig,
    mut current: DojoStoredConfig,
) -> Result<DojoStoredConfig, String> {
    validate_config(&current)?;
    if &current != expected {
        return Err("Dojo registration changed during recovery. Reload settings.".into());
    }
    current.terminal_ownership = TerminalOwnership::Dedicated;
    Ok(current)
}

async fn validate_handover_local(
    conn: &mut SqliteConnection,
    employee: &str,
    version: &str,
) -> Result<(), String> {
    local_terminal::assert_local_write_allowed(conn).await?;
    if staff_version(conn, employee).await? != version || active_count(conn).await? != 0 {
        return Err(
            "Staff or pending payments changed during recovery. Refresh and try again.".into(),
        );
    }
    Ok(())
}

pub(super) async fn recover(
    app: &AppHandle,
    employee: &str,
    pin: &str,
) -> Result<DojoSandboxRecoveryResult, String> {
    let _registration = local_terminal::registration_guard(app).await?;
    let config = require_api_config(app, true)?;
    validate_config(&config)?;
    let mut conn = local_terminal::connect(app).await?;
    ensure_receipts(&mut conn).await?;
    let (mut conn, _) =
        crate::cash_control::authenticate_local_payment_administrator(conn, employee, pin).await?;
    local_terminal::assert_local_write_allowed(&mut conn).await?;
    let version = staff_version(&mut conn, employee).await?;
    let rows = sqlx::query(&format!("SELECT * FROM payment_terminal_attempts WHERE provider='dojo' AND status IN ({ACTIVE}) ORDER BY createdAt,id"))
        .fetch_all(&mut conn).await.map_err(|e| e.to_string())?;
    let journals = rows
        .iter()
        .map(journal_from_row)
        .collect::<Result<Vec<_>, _>>()?;
    conn.close().await.map_err(|e| e.to_string())?;
    let client = api_client()?;
    let mut result = DojoSandboxRecoveryResult::default();
    for journal in journals {
        let evidence = match verify_provider(&client, DOJO_API_BASE, &config, &journal).await {
            Ok(evidence) => evidence,
            Err(error) => {
                result.issues.push(format!("{}: {error}", journal.id));
                continue;
            }
        };
        let mut conn = local_terminal::connect(app).await?;
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut conn)
            .await
            .map_err(|e| e.to_string())?;
        let (mut conn, _) =
            crate::cash_control::authenticate_local_payment_administrator(conn, employee, pin)
                .await?;
        if staff_version(&mut conn, employee).await? != version || load_config(app)? != config {
            return Err("Staff or Dojo registration changed during recovery. Refresh settings and try again.".into());
        }
        match persist_evidence(&mut conn, &journal, &evidence, employee, Utc::now()).await {
            Ok(resolved) => {
                sqlx::query("COMMIT")
                    .execute(&mut conn)
                    .await
                    .map_err(|e| e.to_string())?;
                if resolved {
                    result.resolved += 1;
                } else {
                    result.waiting_for_confirmation = true;
                }
            }
            Err(error) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut conn).await;
                result.issues.push(format!("{}: {error}", journal.id));
            }
        }
    }
    let mut conn = local_terminal::connect(app).await?;
    result.remaining = active_count(&mut conn).await?;
    if result.remaining != 0 {
        return Ok(result);
    }
    let terminal = match get_value(
        &client,
        DOJO_API_BASE,
        &config,
        &format!("/terminals/{}", config.terminal_id),
        true,
    )
    .await
    {
        Ok(value) => value,
        Err(error) => {
            result.issues.push(error);
            return Ok(result);
        }
    };
    if let Err(error) = validate_handover_terminal(&config, &terminal) {
        result.issues.push(error);
        return Ok(result);
    }
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut conn)
        .await
        .map_err(|e| e.to_string())?;
    let (mut conn, _) =
        crate::cash_control::authenticate_local_payment_administrator(conn, employee, pin).await?;
    validate_handover_local(&mut conn, employee, &version).await?;
    let path = config_path(app)?;
    secret_store::mutate_related_config(app, &[DOJO_API_KEY], |secrets| {
        let mut current =
            read_config_file(&path)?.ok_or("The saved Dojo registration is missing.")?;
        current.api_key = secrets.first().cloned().unwrap_or_default();
        let current = dedicated_config(&config, current)?;
        Ok(secret_store::RelatedConfigMutation {
            value: (),
            secret_updates: vec![],
            related_config_write: Some(config_write(app, &current)?),
        })
    })?;
    sqlx::query("COMMIT")
        .execute(&mut conn)
        .await
        .map_err(|e| e.to_string())?;
    result.switched_to_dedicated = true;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };

    fn run(test: impl std::future::Future<Output = ()>) {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(test);
    }
    fn config() -> DojoStoredConfig {
        DojoStoredConfig {
            api_key: "sk_sandbox_fixture".into(),
            terminal_id: "tm_sandbox_fixture".into(),
            terminal_ownership: TerminalOwnership::Shared,
            ..DojoStoredConfig::default()
        }
    }
    fn journal() -> Journal {
        Journal {
            id: "sale-one".into(),
            provider: "dojo".into(),
            terminal_key: "dojo:softwareHouse1:tm_sandbox_fixture".into(),
            client_transaction_id: "pi_sandbox_fixture".into(),
            terminal_session_id: "ts_sandbox_fixture".into(),
            operation_kind: "sale".into(),
            amount: 109,
            expected_provider_amount: 109,
            currency: "GBP".into(),
            status: "uncertain".into(),
            sale_bundle: json!({"order":{"id":"sale-one","type":"sale"},"payment":{"id":"payment-one","orderId":"sale-one","cardAmount":109}}).to_string(),
            provider_reference: String::new(),
            operator_resolution: String::new(),
            error: "network error".into(),
            till_id: "till-one".into(),
            created_at: "2026-10-11T01:00:00Z".into(),
            updated_at: "2026-10-11T01:01:00Z".into(),
            journal_scope: "shared".into(),
        }
    }
    fn evidence() -> Evidence {
        Evidence {
            payment_id: "pi_sandbox_fixture".into(),
            session_id: "ts_sandbox_fixture".into(),
            provider_status: "Canceled".into(),
        }
    }
    fn payment(status: &str, session: bool) -> Value {
        let mut value = json!({"id":"pi_sandbox_fixture","reference":"sale-one","status":status,"amount":{"value":109,"currencyCode":"GBP"}});
        if session {
            value["terminalSessionHistory"] =
                json!([{"terminalSession":{"id":"ts_sandbox_fixture","status":"Expired"}}]);
        }
        value
    }
    fn session(status: &str) -> Value {
        json!({"id":"ts_sandbox_fixture","terminalId":"tm_sandbox_fixture","status":status,"details":{"sale":{"paymentIntentId":"pi_sandbox_fixture"}}})
    }
    fn mock_http(
        responses: Vec<(&'static str, Value)>,
    ) -> (String, thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let handle = thread::spawn(move || {
            let mut requests = Vec::new();
            for (expected, body) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buf = [0u8; 2048];
                loop {
                    let n = stream.read(&mut buf).unwrap();
                    if n == 0 {
                        break;
                    }
                    request.extend_from_slice(&buf[..n]);
                    if request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                        break;
                    }
                }
                let first = String::from_utf8_lossy(&request)
                    .lines()
                    .next()
                    .unwrap()
                    .to_string();
                assert!(
                    first.starts_with(expected),
                    "Expected {expected}, got {first}"
                );
                requests.push(first);
                let body = body.to_string();
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
            }
            requests
        });
        (url, handle)
    }

    async fn db() -> SqliteConnection {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        for sql in [
            "CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
            "CREATE TABLE employees(id TEXT PRIMARY KEY,name TEXT,pin TEXT,pinHash TEXT,role TEXT,isActive INTEGER,updatedAt TEXT)",
            "CREATE TABLE orders(id TEXT PRIMARY KEY)",
            "CREATE TABLE payments(id TEXT PRIMARY KEY,orderId TEXT,reference TEXT)",
            "CREATE TABLE audit_logs(id TEXT PRIMARY KEY,employeeId TEXT,action TEXT,entityType TEXT,entityId TEXT,oldData TEXT,newData TEXT,createdAt TEXT,updatedAt TEXT)",
            "CREATE TABLE payment_terminal_attempts(id TEXT PRIMARY KEY,provider TEXT,terminalKey TEXT,clientTransactionId TEXT,terminalSessionId TEXT,operationKind TEXT,amount INTEGER,expectedProviderAmount INTEGER,currency TEXT,status TEXT,saleBundle TEXT,providerReference TEXT,operatorResolution TEXT,error TEXT,tillId TEXT,createdAt TEXT,updatedAt TEXT,journalScope TEXT)",
            "INSERT INTO employees VALUES('admin-one','Test Admin','1212','','admin',1,'v1')",
        ] { sqlx::query(sql).execute(&mut conn).await.unwrap(); }
        let j = journal();
        sqlx::query(
            "INSERT INTO payment_terminal_attempts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(j.id)
        .bind(j.provider)
        .bind(j.terminal_key)
        .bind(j.client_transaction_id)
        .bind(j.terminal_session_id)
        .bind(j.operation_kind)
        .bind(j.amount)
        .bind(j.expected_provider_amount)
        .bind(j.currency)
        .bind(j.status)
        .bind(j.sale_bundle)
        .bind(j.provider_reference)
        .bind(j.operator_resolution)
        .bind(j.error)
        .bind(j.till_id)
        .bind(j.created_at)
        .bind(j.updated_at)
        .bind(j.journal_scope)
        .execute(&mut conn)
        .await
        .unwrap();
        ensure_receipts(&mut conn).await.unwrap();
        conn
    }

    #[test]
    fn legacy_sandbox_recovery_rejects_live_approved_account_and_malformed_journals() {
        let mut c = config();
        c.api_key = "sk_prod_fixture".into();
        assert!(validate_journal(&c, &journal()).is_err());
        c = config();
        c.terminal_id = "tm_live_fixture".into();
        assert!(validate_journal(&c, &journal()).is_err());
        for status in [
            "approved",
            "commit_failed",
            "completion_pending",
            "completed",
        ] {
            let mut j = journal();
            j.status = status.into();
            assert!(validate_journal(&config(), &j).is_err());
        }
        for operation in ["refund", "customer_account_payment"] {
            let mut j = journal();
            j.operation_kind = operation.into();
            assert!(validate_journal(&config(), &j).is_err());
        }
        let mut j = journal();
        j.client_transaction_id = "pi_live_payment".into();
        assert!(validate_journal(&config(), &j).is_err());
        j = journal();
        j.operator_resolution = "{}".into();
        assert!(validate_journal(&config(), &j).is_err());
        j = journal();
        j.expected_provider_amount = 110;
        assert!(validate_journal(&config(), &j).is_err());
        j = journal();
        j.journal_scope = "local".into();
        assert!(validate_journal(&config(), &j).is_err());
    }

    #[test]
    fn legacy_sandbox_recovery_deletes_created_expired_and_requires_canceled_readback() {
        run(async {
            let (base, server) = mock_http(vec![
                (
                    "GET /payment-intents/pi_sandbox_fixture?returnCanceled=true",
                    payment("Created", true),
                ),
                (
                    "GET /terminal-sessions/ts_sandbox_fixture",
                    session("Expired"),
                ),
                ("DELETE /payment-intents/pi_sandbox_fixture", json!({})),
                (
                    "GET /payment-intents/pi_sandbox_fixture?returnCanceled=true",
                    payment("Canceled", true),
                ),
            ]);
            assert_eq!(
                verify_provider(&api_client().unwrap(), &base, &config(), &journal())
                    .await
                    .unwrap(),
                evidence()
            );
            assert_eq!(server.join().unwrap().len(), 4);
        });
    }

    #[test]
    fn legacy_sandbox_recovery_capture_race_stays_unresolved() {
        run(async {
            let (base, server) = mock_http(vec![
                ("GET /payment-intents/", payment("Created", true)),
                ("GET /terminal-sessions/", session("Expired")),
                ("DELETE /payment-intents/", json!({})),
                ("GET /payment-intents/", payment("Captured", true)),
            ]);
            assert!(
                verify_provider(&api_client().unwrap(), &base, &config(), &journal())
                    .await
                    .unwrap_err()
                    .contains("Captured")
            );
            server.join().unwrap();
        });
    }

    #[test]
    fn legacy_sandbox_recovery_active_session_or_mismatch_never_sends_delete() {
        run(async {
            for value in [session("Initiated"), {
                let mut s = session("Expired");
                s["terminalId"] = json!("tm_sandbox_other");
                s
            }] {
                let (base, server) = mock_http(vec![
                    ("GET /payment-intents/", payment("Created", true)),
                    ("GET /terminal-sessions/", value),
                ]);
                assert!(
                    verify_provider(&api_client().unwrap(), &base, &config(), &journal())
                        .await
                        .is_err()
                );
                assert_eq!(server.join().unwrap().len(), 2);
            }
            let mut wrong = payment("Canceled", true);
            wrong["reference"] = json!("another-sale");
            let (base, server) = mock_http(vec![("GET /payment-intents/", wrong)]);
            assert!(
                verify_provider(&api_client().unwrap(), &base, &config(), &journal())
                    .await
                    .is_err()
            );
            assert_eq!(server.join().unwrap().len(), 1);
        });
    }

    #[test]
    fn legacy_sandbox_recovery_missing_ids_uses_unique_reference_and_preserves_not_found() {
        run(async {
            let mut j = journal();
            j.client_transaction_id.clear();
            j.terminal_session_id.clear();
            let (base, server) = mock_http(vec![
                (
                    "POST /payment-intents/search",
                    json!({"data":[payment("Created", false)]}),
                ),
                ("GET /payment-intents/", payment("Created", false)),
                ("DELETE /payment-intents/", json!({})),
                ("GET /payment-intents/", payment("Canceled", false)),
            ]);
            let e = verify_provider(&api_client().unwrap(), &base, &config(), &j)
                .await
                .unwrap();
            assert!(e.session_id.is_empty());
            server.join().unwrap();
            for data in [
                json!([]),
                json!([payment("Created", false), payment("Created", false)]),
            ] {
                let (base, server) =
                    mock_http(vec![("POST /payment-intents/search", json!({"data":data}))]);
                assert!(
                    verify_provider(&api_client().unwrap(), &base, &config(), &j)
                        .await
                        .is_err()
                );
                server.join().unwrap();
            }
        });
    }

    #[test]
    fn legacy_sandbox_recovery_settles_twice_preserves_history_scope_and_audit() {
        run(async {
            let mut conn = db().await;
            let now = Utc::now();
            assert!(
                !persist_evidence(&mut conn, &journal(), &evidence(), "admin-one", now)
                    .await
                    .unwrap()
            );
            assert_eq!(
                read_journal(&mut conn, "sale-one").await.unwrap(),
                journal()
            );
            assert!(!persist_evidence(
                &mut conn,
                &journal(),
                &evidence(),
                "admin-one",
                now + ChronoDuration::seconds(29)
            )
            .await
            .unwrap());
            assert!(persist_evidence(
                &mut conn,
                &journal(),
                &evidence(),
                "admin-one",
                now + ChronoDuration::seconds(31)
            )
            .await
            .unwrap());
            let final_journal = read_journal(&mut conn, "sale-one").await.unwrap();
            assert_eq!(final_journal.status, "cancelled");
            assert_eq!(final_journal.journal_scope, "shared");
            assert_eq!(final_journal.sale_bundle, journal().sale_bundle);
            assert_eq!(active_count(&mut conn).await.unwrap(), 0);
            let receipt: (String, String) = sqlx::query_as(
                "SELECT confirmedAt,originalJournal FROM dojo_sandbox_recovery_receipts",
            )
            .fetch_one(&mut conn)
            .await
            .unwrap();
            assert!(!receipt.0.is_empty());
            assert_eq!(receipt.1, serde_json::to_string(&journal()).unwrap());
            let count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM audit_logs WHERE action='dojo_sandbox_shared_recovery'",
            )
            .fetch_one(&mut conn)
            .await
            .unwrap();
            assert_eq!(count, 1);
            assert!(persist_evidence(
                &mut conn,
                &journal(),
                &evidence(),
                "admin-one",
                now + ChronoDuration::seconds(60)
            )
            .await
            .is_err());
        });
    }

    #[test]
    fn legacy_sandbox_recovery_changed_evidence_restarts_settling() {
        run(async {
            let mut conn = db().await;
            let now = Utc::now();
            assert!(
                !persist_evidence(&mut conn, &journal(), &evidence(), "admin-one", now)
                    .await
                    .unwrap()
            );
            let changed = Evidence {
                provider_status: "Reversed".into(),
                ..evidence()
            };
            assert!(!persist_evidence(
                &mut conn,
                &journal(),
                &changed,
                "admin-one",
                now + ChronoDuration::seconds(31)
            )
            .await
            .unwrap());
            assert!(!persist_evidence(
                &mut conn,
                &journal(),
                &changed,
                "admin-one",
                now + ChronoDuration::seconds(40)
            )
            .await
            .unwrap());
            assert!(persist_evidence(
                &mut conn,
                &journal(),
                &changed,
                "admin-one",
                now + ChronoDuration::seconds(62)
            )
            .await
            .unwrap());
        });
    }

    #[test]
    fn legacy_sandbox_recovery_accounting_changed_journal_and_close_barrier_block_resolution() {
        run(async {
            let mut conn = db().await;
            sqlx::query("INSERT INTO orders VALUES('sale-one')")
                .execute(&mut conn)
                .await
                .unwrap();
            assert!(
                persist_evidence(&mut conn, &journal(), &evidence(), "admin-one", Utc::now())
                    .await
                    .unwrap_err()
                    .contains("accounting")
            );
            sqlx::query("DELETE FROM orders")
                .execute(&mut conn)
                .await
                .unwrap();
            sqlx::query("UPDATE payment_terminal_attempts SET status='approved'")
                .execute(&mut conn)
                .await
                .unwrap();
            assert!(
                persist_evidence(&mut conn, &journal(), &evidence(), "admin-one", Utc::now())
                    .await
                    .unwrap_err()
                    .contains("journal changed")
            );
            sqlx::query("UPDATE payment_terminal_attempts SET status='uncertain'")
                .execute(&mut conn)
                .await
                .unwrap();
            sqlx::query("INSERT INTO settings VALUES('local_terminal_close_barrier','{\"state\":\"frozen\"}')").execute(&mut conn).await.unwrap();
            assert!(
                persist_evidence(&mut conn, &journal(), &evidence(), "admin-one", Utc::now())
                    .await
                    .unwrap_err()
                    .contains("CLOSE_IN_PROGRESS")
            );
            assert_eq!(
                read_journal(&mut conn, "sale-one").await.unwrap().status,
                "uncertain"
            );
        });
    }

    #[test]
    fn legacy_sandbox_recovery_requires_current_active_admin_and_tracks_profile_version() {
        run(async {
            let conn = db().await;
            let (mut conn, name) = crate::cash_control::authenticate_local_payment_administrator(
                conn,
                "admin-one",
                "1212",
            )
            .await
            .unwrap();
            assert_eq!(name, "Test Admin");
            assert_eq!(staff_version(&mut conn, "admin-one").await.unwrap(), "v1");
            sqlx::query("UPDATE employees SET updatedAt='v2'")
                .execute(&mut conn)
                .await
                .unwrap();
            assert_ne!(staff_version(&mut conn, "admin-one").await.unwrap(), "v1");
            sqlx::query("UPDATE employees SET isActive=0")
                .execute(&mut conn)
                .await
                .unwrap();
            assert!(staff_version(&mut conn, "admin-one").await.is_err());
            assert!(
                crate::cash_control::authenticate_local_payment_administrator(
                    conn,
                    "admin-one",
                    "1212"
                )
                .await
                .is_err()
            );
        });
    }

    #[test]
    fn legacy_sandbox_recovery_handover_requires_idle_exact_terminal_and_unchanged_saved_registration(
    ) {
        let c = config();
        for status in ["Available", "Offline"] {
            assert!(
                validate_handover_terminal(&c, &json!({"id":c.terminal_id,"status":status}))
                    .is_ok()
            );
        }
        for value in [
            json!({"id":c.terminal_id,"status":"InUse"}),
            json!({"id":c.terminal_id,"status":"Unknown"}),
            json!({"id":"tm_sandbox_other","status":"Available"}),
            json!({}),
        ] {
            assert!(validate_handover_terminal(&c, &value).is_err());
        }
        let switched = dedicated_config(&c, c.clone()).unwrap();
        assert_eq!(switched.terminal_ownership, TerminalOwnership::Dedicated);
        assert_eq!(switched.api_key, c.api_key);
        for current in [
            DojoStoredConfig {
                api_key: "sk_prod_changed".into(),
                ..c.clone()
            },
            DojoStoredConfig {
                api_key: "sk_sandbox_changed".into(),
                ..c.clone()
            },
            DojoStoredConfig {
                terminal_id: "tm_sandbox_other".into(),
                ..c.clone()
            },
        ] {
            assert!(dedicated_config(&c, current).is_err());
        }
    }

    #[test]
    fn legacy_sandbox_recovery_handover_cannot_ignore_new_active_work_or_staff_changes() {
        run(async {
            let mut conn = db().await;
            assert!(validate_handover_local(&mut conn, "admin-one", "v1")
                .await
                .is_err());
            let now = Utc::now();
            persist_evidence(&mut conn, &journal(), &evidence(), "admin-one", now)
                .await
                .unwrap();
            persist_evidence(
                &mut conn,
                &journal(),
                &evidence(),
                "admin-one",
                now + ChronoDuration::seconds(31),
            )
            .await
            .unwrap();
            assert!(validate_handover_local(&mut conn, "admin-one", "v1")
                .await
                .is_ok());
            assert!(
                validate_handover_local(&mut conn, "admin-one", "older-profile")
                    .await
                    .is_err()
            );
            sqlx::query(
                "UPDATE payment_terminal_attempts SET status='prepared',journalScope='local'",
            )
            .execute(&mut conn)
            .await
            .unwrap();
            assert!(validate_handover_local(&mut conn, "admin-one", "v1")
                .await
                .is_err());
        });
    }

    #[test]
    fn legacy_sandbox_recovery_accepts_legacy_zero_amount_hint_and_signature_rejection() {
        run(async {
            let mut j = journal();
            j.expected_provider_amount = 0;
            assert!(validate_journal(&config(), &j).is_ok());
            let (base, server) = mock_http(vec![
                ("GET /payment-intents/", payment("Created", true)),
                (
                    "GET /terminal-sessions/",
                    session("SignatureVerificationRejected"),
                ),
                ("DELETE /payment-intents/", json!({})),
                ("GET /payment-intents/", payment("Canceled", true)),
            ]);
            assert_eq!(
                verify_provider(&api_client().unwrap(), &base, &config(), &j)
                    .await
                    .unwrap(),
                evidence()
            );
            server.join().unwrap();
        });
    }

    #[test]
    fn legacy_sandbox_recovery_does_not_trust_default_sale_kind_or_ignore_existing_payment_id() {
        run(async {
            let original: Value = serde_json::from_str(&journal().sale_bundle).unwrap();
            for changed in [
                json!({"kind":"customer_account_payment","customerId":"customer-one"}),
                {
                    let mut p = original.clone();
                    p["order"]["type"] = json!("return");
                    p
                },
                {
                    let mut p = original.clone();
                    p["order"]["id"] = json!("other-order");
                    p
                },
                {
                    let mut p = original.clone();
                    p["payment"]["orderId"] = json!("other-order");
                    p
                },
                {
                    let mut p = original.clone();
                    p["payment"]["id"] = json!("");
                    p
                },
                {
                    let mut p = original.clone();
                    p["payment"]["cardAmount"] = json!(110);
                    p
                },
                {
                    let mut p = original.clone();
                    p["payment"]["accountAmount"] = json!(50);
                    p
                },
                {
                    let mut p = original.clone();
                    p["accountChanges"] = json!([{"amountPence":-109}]);
                    p
                },
                {
                    let mut p = original.clone();
                    p["originalOrderToUpdate"] = json!("return-parent");
                    p
                },
                json!({}),
            ] {
                let mut j = journal();
                j.sale_bundle = changed.to_string();
                assert!(validate_journal(&config(), &j).is_err());
            }
            let mut invalid = journal();
            invalid.sale_bundle = "not-json".into();
            assert!(validate_journal(&config(), &invalid).is_err());
            let mut conn = db().await;
            sqlx::query("INSERT INTO payments VALUES('payment-one','different-order','different-reference')").execute(&mut conn).await.unwrap();
            assert!(no_ledger(&mut conn, &journal(), &evidence())
                .await
                .unwrap_err()
                .contains("accounting"));
        });
    }

    #[test]
    fn legacy_sandbox_recovery_created_without_latest_history_does_not_cancel_old_session() {
        run(async {
            let (base, server) =
                mock_http(vec![("GET /payment-intents/", payment("Created", false))]);
            assert!(
                verify_provider(&api_client().unwrap(), &base, &config(), &journal())
                    .await
                    .unwrap_err()
                    .contains("latest terminal session")
            );
            assert_eq!(server.join().unwrap().len(), 1);
            let (base, server) = mock_http(vec![
                ("GET /payment-intents/", payment("Canceled", false)),
                ("GET /terminal-sessions/", session("Expired")),
                ("GET /payment-intents/", payment("Canceled", false)),
            ]);
            assert_eq!(
                verify_provider(&api_client().unwrap(), &base, &config(), &journal())
                    .await
                    .unwrap(),
                evidence()
            );
            assert_eq!(server.join().unwrap().len(), 3);
        });
    }
}
