use chrono::{DateTime, Duration as ChronoDuration, SecondsFormat, Utc};
use reqwest::{Client, Response};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Connection, Row};
use std::{collections::HashSet, fs, path::PathBuf, time::Duration};
use tauri::{AppHandle, Manager};

use crate::local_terminal::{self, TerminalOwnership};
use crate::secret_store::{self, DOJO_API_KEY};

const DOJO_API_BASE: &str = "https://api.dojo.tech";
const DOJO_API_VERSION: &str = "2026-02-27";
const CONFIG_FILE_NAME: &str = "dojo.json";
const PAYMENT_INTENT_SEARCH_PAGE_LIMIT: u64 = 50;
const PAYMENT_INTENT_SEARCH_MAX_PAGES: usize = 100;
const API_ERROR_MAX_BODY_BYTES: usize = 16 * 1024;
const API_ERROR_MAX_DETAIL_CHARS: usize = 240;
const PAYMENT_INTENT_STATUSES: [&str; 6] = [
    "Created",
    "Authorized",
    "Captured",
    "Reversed",
    "Refunded",
    "Canceled",
];

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct DojoStoredConfig {
    enabled: bool,
    terminal_id: String,
    terminal_name: String,
    currency: String,
    software_house_id: String,
    reseller_id: String,
    #[serde(default)]
    terminal_ownership: TerminalOwnership,
    #[serde(default, skip_serializing)]
    api_key: String,
}

impl Default for DojoStoredConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            terminal_id: String::new(),
            terminal_name: String::new(),
            currency: "GBP".into(),
            software_house_id: "softwareHouse1".into(),
            reseller_id: "reseller1".into(),
            terminal_ownership: TerminalOwnership::Dedicated,
            api_key: String::new(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DojoConfigInput {
    enabled: bool,
    terminal_id: String,
    terminal_name: String,
    currency: String,
    software_house_id: String,
    reseller_id: String,
    #[serde(default)]
    terminal_ownership: TerminalOwnership,
    api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DojoPublicConfig {
    enabled: bool,
    terminal_id: String,
    terminal_name: String,
    currency: String,
    software_house_id: String,
    reseller_id: String,
    terminal_ownership: TerminalOwnership,
    api_key_configured: bool,
    api_environment: String,
    api_version: String,
    ready: bool,
}

impl From<&DojoStoredConfig> for DojoPublicConfig {
    fn from(value: &DojoStoredConfig) -> Self {
        Self {
            enabled: value.enabled,
            terminal_id: value.terminal_id.clone(),
            terminal_name: value.terminal_name.clone(),
            currency: value.currency.clone(),
            software_house_id: value.software_house_id.clone(),
            reseller_id: value.reseller_id.clone(),
            terminal_ownership: value.terminal_ownership,
            api_key_configured: !value.api_key.is_empty(),
            api_environment: if value.api_key.starts_with("sk_prod_") {
                "Production".into()
            } else if value.api_key.starts_with("sk_sandbox_") {
                "Sandbox".into()
            } else {
                "Unknown".into()
            },
            api_version: DOJO_API_VERSION.into(),
            ready: config_is_ready(value),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DojoTerminalProperties {
    tid: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DojoTerminal {
    id: String,
    properties: DojoTerminalProperties,
    status: String,
    updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DojoPaymentResult {
    payment_intent_id: String,
    terminal_session_id: String,
    reference: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DojoMoney {
    value: i64,
    currency_code: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DojoPaymentIntentStatus {
    id: String,
    status: String,
    reference: String,
    amount: Option<i64>,
    currency: Option<String>,
    total_amount: Option<DojoMoney>,
    tips_amount: Option<DojoMoney>,
    cashback_amount: Option<DojoMoney>,
    service_charge_amount: Option<DojoMoney>,
    money_validation_error: Option<String>,
    refunded_amount: Option<i64>,
    transaction_id: Option<String>,
    latest_terminal_session_id: Option<String>,
    terminal_history_error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DojoPaymentIntentReferenceResult {
    payment: DojoPaymentIntentStatus,
    terminal_session_id: Option<String>,
    terminal_session_status: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DojoTerminalSessionStatus {
    id: String,
    terminal_id: String,
    payment_intent_id: String,
    status: String,
    latest_notification: Option<String>,
    payment: Option<DojoPaymentIntentStatus>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DojoRefundResult {
    refund_id: String,
    payment_intent_id: String,
    rejected: bool,
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create the Dojo settings folder: {error}"))?;
    Ok(directory.join(CONFIG_FILE_NAME))
}

fn read_config_file(path: &PathBuf) -> Result<Option<DojoStoredConfig>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let contents = fs::read_to_string(path)
        .map_err(|error| format!("Could not read the Dojo settings: {error}"))?;
    serde_json::from_str(&contents)
        .map(Some)
        .map_err(|error| format!("The saved Dojo settings are invalid: {error}"))
}

fn load_config(app: &AppHandle) -> Result<DojoStoredConfig, String> {
    let path = config_path(app)?;
    secret_store::mutate_related_config(app, &[DOJO_API_KEY], |secrets| {
        let mut config = read_config_file(&path)?.unwrap_or_default();
        let legacy_api_key = std::mem::take(&mut config.api_key);
        config.api_key = secrets.first().cloned().unwrap_or_default();
        let mut updates = Vec::new();
        if config.api_key.is_empty() && !legacy_api_key.is_empty() {
            config.api_key = legacy_api_key.clone();
            updates.push((DOJO_API_KEY.to_string(), legacy_api_key.clone()));
        }
        let related_config_write = if legacy_api_key.is_empty() {
            None
        } else {
            Some(config_write(app, &config)?)
        };
        Ok(secret_store::RelatedConfigMutation {
            value: config,
            secret_updates: updates,
            related_config_write,
        })
    })
}

fn config_write(
    app: &AppHandle,
    config: &DojoStoredConfig,
) -> Result<secret_store::RelatedConfigWrite, String> {
    let path = config_path(app)?;
    let contents = serde_json::to_vec_pretty(config)
        .map_err(|error| format!("Could not prepare the Dojo settings: {error}"))?;
    Ok(secret_store::RelatedConfigWrite {
        path,
        contents,
        description: "Dojo settings".into(),
    })
}

fn clean_identifier(value: &str, field_name: &str, maximum: usize) -> Result<String, String> {
    let value = value.trim();
    if value.len() > maximum {
        return Err(format!("{field_name} is too long"));
    }
    if value.chars().any(char::is_control) {
        return Err(format!("{field_name} contains invalid characters"));
    }
    Ok(value.to_string())
}

fn normalize_currency(value: &str) -> Result<String, String> {
    let currency = value.trim().to_ascii_uppercase();
    if currency.len() != 3
        || !currency
            .chars()
            .all(|character| character.is_ascii_alphabetic())
    {
        return Err("Currency must be a three-letter code such as GBP".into());
    }
    Ok(currency)
}

fn config_is_ready(config: &DojoStoredConfig) -> bool {
    !config.terminal_id.is_empty()
        && !config.software_house_id.is_empty()
        && !config.reseller_id.is_empty()
        && !config.api_key.is_empty()
        && production_config_issue(config).is_none()
}

fn production_config_issue(config: &DojoStoredConfig) -> Option<&'static str> {
    if config.api_key.starts_with("sk_prod_") {
        if config.software_house_id == "softwareHouse1" || config.reseller_id == "reseller1" {
            return Some("Production requires the software-house and reseller IDs assigned by Dojo. Replace the sandbox example IDs before enabling live payments.");
        }
        if config.terminal_id.starts_with("tm_sandbox_") {
            return Some("A live Dojo API key cannot use a sandbox terminal. Find and select the assigned live terminal.");
        }
    }
    None
}

fn require_api_config(app: &AppHandle, require_terminal: bool) -> Result<DojoStoredConfig, String> {
    let config = load_config(app)?;
    if config.api_key.is_empty() {
        return Err("Enter the Dojo secret API key first".into());
    }
    if config.software_house_id.is_empty() || config.reseller_id.is_empty() {
        return Err("Enter the Dojo software-house and reseller IDs first".into());
    }
    if let Some(issue) = production_config_issue(&config) {
        return Err(issue.into());
    }
    if require_terminal && config.terminal_id.is_empty() {
        return Err("Choose a Dojo terminal first".into());
    }
    Ok(config)
}

fn api_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(6))
        .timeout(Duration::from_secs(24))
        .user_agent(concat!(
            "LBj-POS/",
            env!("CARGO_PKG_VERSION"),
            " Dojo-Pay-at-Counter"
        ))
        .build()
        .map_err(|error| format!("Could not start the Dojo connection: {error}"))
}

fn api_request(
    client: &Client,
    method: reqwest::Method,
    url: String,
    config: &DojoStoredConfig,
    terminal_headers: bool,
) -> reqwest::RequestBuilder {
    let mut request = client
        .request(method, url)
        .header("Authorization", format!("Basic {}", config.api_key))
        .header("version", DOJO_API_VERSION)
        .header("Accept", "application/json");
    if terminal_headers {
        request = request
            .header("software-house-id", &config.software_house_id)
            .header("reseller-id", &config.reseller_id);
    }
    request
}

fn terminal_session_cancel_request(
    client: &Client,
    api_base: &str,
    config: &DojoStoredConfig,
    terminal_session_id: &str,
) -> reqwest::RequestBuilder {
    api_request(
        client,
        reqwest::Method::PUT,
        format!("{api_base}/terminal-sessions/{terminal_session_id}/cancel"),
        config,
        true,
    )
    // Dojo's gateway requires explicit framing even though cancel has no payload.
    .header(reqwest::header::CONTENT_LENGTH, "0")
    .body("")
}

fn payment_intent_cancel_request(
    client: &Client,
    api_base: &str,
    config: &DojoStoredConfig,
    payment_intent_id: &str,
) -> reqwest::RequestBuilder {
    api_request(
        client,
        reqwest::Method::DELETE,
        format!("{api_base}/payment-intents/{payment_intent_id}"),
        config,
        false,
    )
    .header(reqwest::header::CONTENT_LENGTH, "0")
    .body("")
}

fn readable_api_detail(value: &Value) -> Option<String> {
    let detail = value.as_str()?;
    let lower = detail.to_ascii_lowercase();
    // Structured errors can also contain gateway markup. Never show a document
    // or HTML-encoded document in the payment dialog, even inside a JSON field.
    if detail.contains(['<', '>']) || lower.contains("&lt;") || lower.contains("&#") {
        return None;
    }
    let normalized: String = detail
        .chars()
        .filter(|character| !character.is_control() || character.is_whitespace())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if normalized.is_empty() {
        return None;
    }
    let mut characters = normalized.chars();
    let mut summary: String = characters
        .by_ref()
        .take(API_ERROR_MAX_DETAIL_CHARS)
        .collect();
    if characters.next().is_some() {
        summary.push('…');
    }
    Some(summary)
}

fn readable_api_error(status: reqwest::StatusCode, body: &[u8]) -> String {
    let advice = match status.as_u16() {
        401 | 403 => " Check the Dojo API key and account permissions in Payment Settings.",
        404 => " Check that the selected terminal or payment belongs to this Dojo account and that the terminal is online.",
        409 => " The terminal is busy or offline. Check the card machine before trying again.",
        422 => " This action is not allowed at the current payment stage. Check the original payment result.",
        _ => "",
    };
    let fallback = format!("Dojo returned HTTP {status}{advice}");
    if body.len() > API_ERROR_MAX_BODY_BYTES {
        return fallback;
    }
    if let Ok(value) = serde_json::from_slice::<Value>(body) {
        for field in ["detail", "Detail", "title", "Title", "message", "Message"] {
            if let Some(detail) = value.get(field).and_then(readable_api_detail) {
                return format!("Dojo returned HTTP {}: {detail}{advice}", status.as_u16());
            }
        }
    }
    // Unstructured provider bodies may contain HTML, internal diagnostics, or
    // identifiers. The HTTP status/reason is sufficient and safe for the till.
    fallback
}

fn refund_explicitly_failed(status: reqwest::StatusCode, body: &[u8]) -> bool {
    // Only this provider final result proves rejection. Generic 400s, gateway
    // errors and transport failures must still be reconciled, never cleared.
    if status != reqwest::StatusCode::BAD_REQUEST || body.len() > API_ERROR_MAX_BODY_BYTES {
        return false;
    }
    serde_json::from_slice::<Value>(body)
        .ok()
        .is_some_and(|value| {
            value
                .get("detail")
                .or_else(|| value.get("Detail"))
                .and_then(Value::as_str)
                == Some("Your refund request was not successful. Status: Failed.")
        })
}

async fn api_error(mut response: Response) -> String {
    let status = response.status();
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if chunk.len() > API_ERROR_MAX_BODY_BYTES.saturating_sub(body.len()) {
                    return readable_api_error(status, &[]);
                }
                body.extend_from_slice(&chunk);
            }
            Ok(None) => return readable_api_error(status, &body),
            Err(_) => return readable_api_error(status, &[]),
        }
    }
}

fn payment_money(value: &Value, field: &str) -> Result<Option<DojoMoney>, String> {
    let Some(money) = value.get(field).filter(|money| !money.is_null()) else {
        return Ok(None);
    };
    // Money is an object in Dojo's 2026-02-27 API, never a scalar. Keep
    // malformed-present distinct from absent so a capture cannot lose money.
    let amount = money
        .get("value")
        .and_then(Value::as_i64)
        .filter(|amount| *amount >= 0 && *amount <= 9_007_199_254_740_991)
        .ok_or_else(|| format!("Dojo returned an invalid {field} value"))?;
    let currency = money
        .get("currencyCode")
        .and_then(Value::as_str)
        .filter(|currency| currency.len() == 3 && currency.bytes().all(|c| c.is_ascii_uppercase()))
        .ok_or_else(|| format!("Dojo returned an invalid {field} currency"))?;
    Ok(Some(DojoMoney {
        value: amount,
        currency_code: currency.to_string(),
    }))
}

fn payment_intent_from_value(value: &Value) -> DojoPaymentIntentStatus {
    let (latest_terminal_session_id, terminal_history_error) =
        match latest_terminal_session_from_value(value) {
            Ok((id, _)) => (id, None),
            Err(error) => (None, Some(error)),
        };
    let mut money_validation_error = None;
    let mut read_money = |field| match payment_money(value, field) {
        Ok(money) => money,
        Err(error) => {
            money_validation_error.get_or_insert(error);
            None
        }
    };
    let amount = read_money("amount");
    let total_amount = read_money("totalAmount");
    let tips_amount = read_money("tipsAmount");
    let cashback_amount = read_money("cashbackAmount");
    let service_charge_amount = read_money("serviceChargeAmount");
    let refunded_amount = value
        .get("refundedAmount")
        .filter(|value| !value.is_null())
        .and_then(|value| {
            match value
                .as_i64()
                .filter(|amount| *amount >= 0 && *amount <= 9_007_199_254_740_991)
            {
                Some(amount) => Some(amount),
                None => {
                    money_validation_error.get_or_insert_with(|| {
                        "Dojo returned an invalid refundedAmount".to_string()
                    });
                    None
                }
            }
        });
    DojoPaymentIntentStatus {
        id: value
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        status: value
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("Unknown")
            .to_string(),
        reference: value
            .get("reference")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        amount: amount.as_ref().map(|money| money.value),
        currency: amount.map(|money| money.currency_code),
        total_amount,
        tips_amount,
        cashback_amount,
        service_charge_amount,
        money_validation_error,
        refunded_amount,
        transaction_id: value
            .pointer("/paymentDetails/transactionId")
            .and_then(Value::as_str)
            .map(str::to_string),
        latest_terminal_session_id,
        terminal_history_error,
    }
}

fn payment_intent_search_window(
    created_at: &str,
    now: DateTime<Utc>,
) -> Result<(String, String), String> {
    let created_at = DateTime::parse_from_rfc3339(created_at.trim())
        .map_err(|_| {
            "The Dojo payment creation time is not a valid ISO 8601 timestamp".to_string()
        })?
        .with_timezone(&Utc);
    let start = created_at
        .checked_sub_signed(ChronoDuration::minutes(5))
        .ok_or_else(|| {
            "The Dojo payment creation time is outside the supported range".to_string()
        })?;
    let end = now
        .checked_add_signed(ChronoDuration::minutes(5))
        .ok_or_else(|| "The current time is outside the supported range".to_string())?;
    if start > end {
        return Err("The Dojo payment creation time is too far in the future".into());
    }
    Ok((
        start.to_rfc3339_opts(SecondsFormat::Millis, true),
        end.to_rfc3339_opts(SecondsFormat::Millis, true),
    ))
}

fn latest_terminal_session_from_value(
    value: &Value,
) -> Result<(Option<String>, Option<String>), String> {
    let history = match value.get("terminalSessionHistory") {
        None | Some(Value::Null) => return Ok((None, None)),
        Some(Value::Array(history)) => history,
        Some(_) => return Err("Dojo returned invalid terminal-session history".into()),
    };
    let Some(latest) = history.last() else {
        return Ok((None, None));
    };
    let session = latest
        .get("terminalSession")
        .and_then(Value::as_object)
        .ok_or_else(|| "Dojo returned invalid terminal-session history".to_string())?;
    let id = session
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| "Dojo returned a terminal session without an ID".to_string())?;
    let status = session
        .get("status")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|status| !status.is_empty())
        .ok_or_else(|| "Dojo returned a terminal session without a status".to_string())?;
    Ok((Some(id.to_string()), Some(status.to_string())))
}

fn payment_intent_reference_result_from_value(
    value: &Value,
    expected_reference: &str,
) -> Result<Option<DojoPaymentIntentReferenceResult>, String> {
    let returned_reference = value
        .get("reference")
        .and_then(Value::as_str)
        .ok_or_else(|| "Dojo returned a payment intent without a reference".to_string())?;
    if returned_reference != expected_reference {
        return Ok(None);
    }
    let payment = payment_intent_from_value(value);
    if payment.id.trim().is_empty() {
        return Err("Dojo returned a matching payment intent without an ID".into());
    }
    if !PAYMENT_INTENT_STATUSES.contains(&payment.status.as_str()) {
        return Err("Dojo returned a matching payment intent with an invalid status".into());
    }
    let (terminal_session_id, terminal_session_status) = latest_terminal_session_from_value(value)?;
    Ok(Some(DojoPaymentIntentReferenceResult {
        payment,
        terminal_session_id,
        terminal_session_status,
    }))
}

fn parse_payment_intent_search_page(
    value: &Value,
    expected_reference: &str,
) -> Result<(Vec<DojoPaymentIntentReferenceResult>, Option<String>), String> {
    let data = match value.get("data") {
        Some(Value::Array(data)) => data.as_slice(),
        Some(Value::Null) => &[],
        _ => return Err("Dojo returned invalid payment-search data".into()),
    };
    let mut matches = Vec::new();
    for payment_intent in data {
        if let Some(result) =
            payment_intent_reference_result_from_value(payment_intent, expected_reference)?
        {
            matches.push(result);
        }
    }
    let after = match value.get("after") {
        None | Some(Value::Null) => None,
        Some(Value::String(after)) if after.is_empty() => None,
        Some(Value::String(after))
            if after.len() <= 200 && !after.chars().any(char::is_control) =>
        {
            Some(after.clone())
        }
        Some(_) => return Err("Dojo returned an invalid payment-search cursor".into()),
    };
    Ok((matches, after))
}

fn merge_unique_reference_matches(
    found: &mut Option<DojoPaymentIntentReferenceResult>,
    matches: Vec<DojoPaymentIntentReferenceResult>,
) -> Result<(), String> {
    for result in matches {
        if found.is_some() {
            return Err(
                "Dojo returned more than one payment intent for this exact reference; check the Dojo portal before retrying"
                    .into(),
            );
        }
        *found = Some(result);
    }
    Ok(())
}

fn payment_intent_search_payload(start_date: &str, end_date: &str, after: Option<&str>) -> Value {
    let mut cursor = json!({ "limit": PAYMENT_INTENT_SEARCH_PAGE_LIMIT });
    if let Some(after) = after {
        cursor["after"] = Value::String(after.to_string());
    }
    json!({
        "statuses": PAYMENT_INTENT_STATUSES,
        "startDate": start_date,
        "endDate": end_date,
        "cursor": cursor,
    })
}

async fn fetch_payment_intent(
    client: &Client,
    config: &DojoStoredConfig,
    payment_intent_id: &str,
) -> Result<DojoPaymentIntentStatus, String> {
    let response = api_request(
        client,
        reqwest::Method::GET,
        format!("{DOJO_API_BASE}/payment-intents/{payment_intent_id}?returnCanceled=true"),
        config,
        false,
    )
    .send()
    .await
    .map_err(|error| format!("Could not contact Dojo: {error}"))?;
    if !response.status().is_success() {
        return Err(api_error(response).await);
    }
    let value: Value = response
        .json()
        .await
        .map_err(|error| format!("Dojo returned invalid payment data: {error}"))?;
    Ok(payment_intent_from_value(&value))
}

#[derive(Debug, Clone, PartialEq)]
struct SandboxCancellationProof {
    attempt_id: String,
    terminal_key: String,
    payment_intent_id: String,
    terminal_session_id: String,
    operation_kind: String,
    amount: i64,
    currency: String,
    status: String,
}

fn validate_sandbox_cancellation_proof(
    config: &DojoStoredConfig,
    proof: &SandboxCancellationProof,
) -> Result<String, String> {
    // The actual secret loaded natively is authoritative, never a renderer flag.
    if !config.api_key.starts_with("sk_sandbox_") || config.api_key.len() <= "sk_sandbox_".len() {
        return Err("Expired test-payment cancellation is available only with a saved Dojo sandbox key. Live payments cannot use this action.".into());
    }
    if !matches!(proof.status.as_str(), "prepared" | "started" | "uncertain")
        || !matches!(
            proof.operation_kind.as_str(),
            "sale" | "customer_account_payment"
        )
    {
        return Err("Only an unresolved, unapproved sandbox collection can be canceled. Refunds and approved/final work must use normal recovery.".into());
    }
    let terminal = proof
        .terminal_key
        .strip_prefix(&format!("dojo:{}:", config.software_house_id))
        .filter(|value| !value.is_empty())
        .ok_or("The journal does not match the saved Dojo software-house identity.")?;
    for value in [
        proof.attempt_id.as_str(),
        proof.payment_intent_id.as_str(),
        proof.terminal_session_id.as_str(),
        terminal,
    ] {
        if value.is_empty()
            || value.len() > 128
            || !value
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        {
            return Err(
                "The sandbox cancellation journal has missing or invalid durable identifiers."
                    .into(),
            );
        }
    }
    if proof.amount <= 0
        || proof.amount > 9_007_199_254_740_991
        || normalize_currency(&proof.currency)? != proof.currency
    {
        return Err("The sandbox cancellation journal has an invalid amount or currency.".into());
    }
    Ok(terminal.into())
}

fn validate_sandbox_cancellation_session(
    proof: &SandboxCancellationProof,
    terminal: &str,
    session: &Value,
) -> Result<(), String> {
    if session.get("id").and_then(Value::as_str) != Some(proof.terminal_session_id.as_str())
        || session.get("terminalId").and_then(Value::as_str) != Some(terminal)
        || session
            .pointer("/details/sale/paymentIntentId")
            .and_then(Value::as_str)
            != Some(proof.payment_intent_id.as_str())
    {
        return Err("Dojo returned a different terminal session, terminal or payment intent; no cancellation was sent.".into());
    }
    if session.get("status").and_then(Value::as_str) != Some("Expired") {
        return Err("Only a provider-confirmed Expired sandbox terminal session can use this action; no cancellation was sent.".into());
    }
    Ok(())
}

fn validate_sandbox_cancellation_payment(
    proof: &SandboxCancellationProof,
    payment: &DojoPaymentIntentStatus,
    expected_status: &str,
) -> Result<(), String> {
    if payment.id != proof.payment_intent_id
        || payment.reference != proof.attempt_id
        || payment.amount != Some(proof.amount)
        || payment.currency.as_deref() != Some(proof.currency.as_str())
        || payment.money_validation_error.is_some()
        || [
            &payment.total_amount,
            &payment.tips_amount,
            &payment.cashback_amount,
            &payment.service_charge_amount,
        ]
        .into_iter()
        .filter_map(|money| money.as_ref())
        .any(|money| money.currency_code != proof.currency)
        || payment.refunded_amount.is_some_and(|amount| amount != 0)
    {
        return Err("Dojo payment identity, reference, amount or currency does not match the durable test journal. Keep it unresolved for review.".into());
    }
    if payment.status != expected_status {
        return Err(format!("Dojo payment intent is {}, not {expected_status}. No journal was cleared; run Check payment results to recover any capture.", payment.status));
    }
    Ok(())
}

async fn read_sandbox_cancellation_proof(
    app: &AppHandle,
    attempt_id: &str,
) -> Result<SandboxCancellationProof, String> {
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(crate::commerce::local_db_path(app)?)
        .create_if_missing(false)
        .read_only(true)
        .busy_timeout(Duration::from_secs(5));
    let mut connection = sqlx::SqliteConnection::connect_with(&options)
        .await
        .map_err(|e| e.to_string())?;
    let row = sqlx::query("SELECT id, terminalKey, clientTransactionId, terminalSessionId, operationKind, amount, currency, status FROM payment_terminal_attempts WHERE id = ? AND provider = 'dojo' LIMIT 1")
        .bind(attempt_id).fetch_optional(&mut connection).await.map_err(|e| e.to_string())?
        .ok_or("The durable Dojo journal is missing; refresh payment recovery before trying again.")?;
    Ok(SandboxCancellationProof {
        attempt_id: row.try_get("id").map_err(|e| e.to_string())?,
        terminal_key: row.try_get("terminalKey").map_err(|e| e.to_string())?,
        payment_intent_id: row
            .try_get("clientTransactionId")
            .map_err(|e| e.to_string())?,
        terminal_session_id: row
            .try_get("terminalSessionId")
            .map_err(|e| e.to_string())?,
        operation_kind: row.try_get("operationKind").map_err(|e| e.to_string())?,
        amount: row.try_get("amount").map_err(|e| e.to_string())?,
        currency: row.try_get("currency").map_err(|e| e.to_string())?,
        status: row.try_get("status").map_err(|e| e.to_string())?,
    })
}

/// Guarded sandbox expiry cleanup, for a managed flow or explicit recovery.
/// Cancellation is a provider operation, NOT evidence for finalizing the POS
/// journal. The caller must retain its lease and reconcile the provider result.
#[tauri::command]
pub async fn dojo_cancel_expired_sandbox_payment(
    app: AppHandle,
    attempt_id: String,
) -> Result<(), String> {
    let config = require_api_config(&app, false)?;
    let proof = read_sandbox_cancellation_proof(&app, &attempt_id).await?;
    let terminal = validate_sandbox_cancellation_proof(&config, &proof)?;
    let client = api_client()?;
    let current_payment = fetch_payment_intent(&client, &config, &proof.payment_intent_id).await?;
    if let Some(error) = &current_payment.terminal_history_error {
        return Err(error.clone());
    }
    let mut session_proof = proof.clone();
    if let Some(id) = current_payment.latest_terminal_session_id {
        session_proof.terminal_session_id = id;
    }
    let response = api_request(
        &client,
        reqwest::Method::GET,
        format!(
            "{DOJO_API_BASE}/terminal-sessions/{}",
            session_proof.terminal_session_id
        ),
        &config,
        true,
    )
    .send()
    .await
    .map_err(|e| format!("Could not verify the expired Dojo session: {e}"))?;
    if !response.status().is_success() {
        return Err(api_error(response).await);
    }
    let session: Value = response
        .json()
        .await
        .map_err(|e| format!("Dojo returned invalid terminal-session data: {e}"))?;
    validate_sandbox_cancellation_session(&session_proof, &terminal, &session)?;
    // Get the payment AFTER the session, so Created is the freshest preflight.
    let payment = fetch_payment_intent(&client, &config, &proof.payment_intent_id).await?;
    validate_sandbox_cancellation_payment(&proof, &payment, "Created")?;
    let latest_proof = read_sandbox_cancellation_proof(&app, &attempt_id).await?;
    if latest_proof != proof {
        return Err("The payment journal changed during verification. No cancellation was sent; refresh recovery.".into());
    }
    validate_sandbox_cancellation_proof(&config, &latest_proof)?;
    // Exactly one DELETE, no automatic retry. A capture racing this request
    // must remain available to the normal capture-wins recovery path.
    let request_error = match payment_intent_cancel_request(
        &client,
        DOJO_API_BASE,
        &config,
        &proof.payment_intent_id,
    )
    .send()
    .await
    {
        Ok(response) if response.status().is_success() => None,
        Ok(response) => Some(api_error(response).await),
        Err(error) => Some(format!(
            "Dojo cancellation reply was not confirmed: {error}"
        )),
    };
    let final_payment = fetch_payment_intent(&client, &config, &proof.payment_intent_id).await
        .map_err(|error| format!("Cancellation outcome is still uncertain; keep the journal and run recovery. {error}"))?;
    validate_sandbox_cancellation_payment(&proof, &final_payment, "Canceled").map_err(|error| {
        match request_error {
            Some(request) => format!("{error} {request}"),
            None => error,
        }
    })
}

#[tauri::command]
pub fn dojo_get_config(app: AppHandle) -> Result<DojoPublicConfig, String> {
    let config = load_config(&app)?;
    Ok(DojoPublicConfig::from(&config))
}

#[tauri::command]
pub async fn dojo_save_config(
    app: AppHandle,
    config: DojoConfigInput,
    mysql_uri: Option<String>,
) -> Result<DojoPublicConfig, String> {
    let _registration = local_terminal::registration_guard(&app).await?;
    let supplied_key = config.api_key.unwrap_or_default().trim().to_string();
    let terminal_id = clean_identifier(&config.terminal_id, "Terminal ID", 128)?;
    let terminal_name = clean_identifier(&config.terminal_name, "Terminal name", 160)?;
    let currency = normalize_currency(&config.currency)?;
    let software_house_id = clean_identifier(&config.software_house_id, "Software-house ID", 128)?;
    let reseller_id = clean_identifier(&config.reseller_id, "Reseller ID", 128)?;
    let path = config_path(&app)?;
    let previous = load_config(&app)?;
    let sensitive_change = previous.terminal_id != terminal_id
        || previous.software_house_id != software_house_id
        || previous.reseller_id != reseller_id
        || previous.currency != currency
        || previous.terminal_ownership != config.terminal_ownership
        || (!supplied_key.is_empty() && previous.api_key != supplied_key);
    if sensitive_change {
        let old_key = if previous.terminal_id.is_empty() {
            String::new()
        } else {
            format!(
                "dojo:{}:{}",
                previous.software_house_id, previous.terminal_id
            )
        };
        local_terminal::guard_configuration_change(
            &app,
            "dojo",
            &old_key,
            previous.terminal_ownership,
            mysql_uri.as_deref(),
        )
        .await?;
    }
    let next = secret_store::mutate_related_config(&app, &[DOJO_API_KEY], |secrets| {
        let legacy = read_config_file(&path)?.unwrap_or_default();
        if legacy.terminal_id != previous.terminal_id
            || legacy.software_house_id != previous.software_house_id
            || legacy.terminal_ownership != previous.terminal_ownership
        {
            return Err("Dojo registration changed while it was being checked. Reload settings and try again.".into());
        }
        let current_api_key = secrets
            .first()
            .filter(|value| !value.is_empty())
            .cloned()
            .unwrap_or(legacy.api_key);
        let next = DojoStoredConfig {
            enabled: config.enabled,
            terminal_id,
            terminal_name,
            currency,
            software_house_id,
            reseller_id,
            terminal_ownership: config.terminal_ownership,
            api_key: if supplied_key.is_empty() {
                current_api_key
            } else {
                supplied_key
            },
        };
        if next.enabled {
            if let Some(issue) = production_config_issue(&next) {
                return Err(issue.into());
            }
        }
        if next.enabled && !config_is_ready(&next) {
            return Err(
                "Complete the API key, integration IDs, and terminal before enabling Dojo".into(),
            );
        }
        Ok(secret_store::RelatedConfigMutation {
            secret_updates: vec![(DOJO_API_KEY.to_string(), next.api_key.clone())],
            related_config_write: Some(config_write(&app, &next)?),
            value: next,
        })
    })?;
    Ok(DojoPublicConfig::from(&next))
}

#[tauri::command]
pub async fn dojo_clear_secret(
    app: AppHandle,
    mysql_uri: Option<String>,
) -> Result<DojoPublicConfig, String> {
    let _registration = local_terminal::registration_guard(&app).await?;
    let previous = load_config(&app)?;
    let old_key = if previous.terminal_id.is_empty() {
        String::new()
    } else {
        format!(
            "dojo:{}:{}",
            previous.software_house_id, previous.terminal_id
        )
    };
    local_terminal::guard_configuration_change(
        &app,
        "dojo",
        &old_key,
        previous.terminal_ownership,
        mysql_uri.as_deref(),
    )
    .await?;
    let path = config_path(&app)?;
    let config = secret_store::mutate_related_config(&app, &[DOJO_API_KEY], |_| {
        let mut config = read_config_file(&path)?.unwrap_or_default();
        config.enabled = false;
        config.api_key.clear();
        Ok(secret_store::RelatedConfigMutation {
            related_config_write: Some(config_write(&app, &config)?),
            value: config,
            secret_updates: vec![(DOJO_API_KEY.to_string(), String::new())],
        })
    })?;
    Ok(DojoPublicConfig::from(&config))
}

pub(crate) fn validate_local_registration(
    app: &AppHandle,
    terminal_key: &str,
    currency: &str,
) -> Result<(), String> {
    let config = require_api_config(app, true)?;
    if !config.enabled
        || config.terminal_ownership != TerminalOwnership::Dedicated
        || terminal_key != format!("dojo:{}:{}", config.software_house_id, config.terminal_id)
        || currency != config.currency
    {
        return Err("Dojo registration changed. Reload this till's payment settings before preparing a new payment.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn dojo_list_terminals(app: AppHandle) -> Result<Vec<DojoTerminal>, String> {
    let config = require_api_config(&app, false)?;
    let client = api_client()?;
    let response = api_request(
        &client,
        reqwest::Method::GET,
        format!("{DOJO_API_BASE}/terminals"),
        &config,
        true,
    )
    .send()
    .await
    .map_err(|error| format!("Could not contact Dojo: {error}"))?;
    if !response.status().is_success() {
        return Err(api_error(response).await);
    }
    response
        .json::<Vec<DojoTerminal>>()
        .await
        .map_err(|error| format!("Dojo returned invalid terminal data: {error}"))
}

#[tauri::command]
pub async fn dojo_terminal_status(app: AppHandle) -> Result<DojoTerminal, String> {
    let config = require_api_config(&app, true)?;
    let client = api_client()?;
    let response = api_request(
        &client,
        reqwest::Method::GET,
        format!("{DOJO_API_BASE}/terminals/{}", config.terminal_id),
        &config,
        true,
    )
    .send()
    .await
    .map_err(|error| format!("Could not contact Dojo: {error}"))?;
    if !response.status().is_success() {
        return Err(api_error(response).await);
    }
    response
        .json::<DojoTerminal>()
        .await
        .map_err(|error| format!("Dojo returned invalid terminal data: {error}"))
}

#[tauri::command]
pub async fn dojo_create_payment(
    app: AppHandle,
    amount_pence: i64,
    reference: String,
    description: String,
) -> Result<DojoPaymentResult, String> {
    // Reject new charges natively before contacting the provider. Status,
    // cancellation and signature completion remain available for recovery.
    crate::licensing::require_sale_access(&app).await?;
    let config = require_api_config(&app, true)?;
    if !config.enabled || !config_is_ready(&config) {
        return Err("Dojo is not enabled and fully configured on this till".into());
    }
    if amount_pence <= 0 || amount_pence > 99_999_999 {
        return Err("The Dojo payment amount is invalid".into());
    }
    let reference = clean_identifier(&reference, "Payment reference", 60)?;
    if reference.is_empty() {
        return Err("A unique payment reference is required".into());
    }
    local_terminal::reserve_dispatch(
        &app,
        "dojo",
        &reference,
        &format!("dojo:{}:{}", config.software_house_id, config.terminal_id),
        amount_pence,
        &config.currency,
        config.terminal_ownership,
        "create",
        None,
    )
    .await?;
    let description: String = description.trim().chars().take(4096).collect();
    let client = api_client()?;
    let response = api_request(
        &client,
        reqwest::Method::POST,
        format!("{DOJO_API_BASE}/payment-intents"),
        &config,
        false,
    )
    .json(&json!({
        "amount": { "value": amount_pence, "currencyCode": config.currency },
        "reference": reference,
        "description": description,
        "captureMode": "Auto"
    }))
    .send()
    .await
    .map_err(|error| format!("Could not contact Dojo: {error}"))?;
    if !response.status().is_success() {
        return Err(api_error(response).await);
    }
    let intent: Value = response
        .json()
        .await
        .map_err(|error| format!("Dojo returned invalid payment data: {error}"))?;
    let payment_intent_id = intent
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "Dojo did not return a payment-intent ID".to_string())?
        .to_string();

    let response = api_request(
        &client,
        reqwest::Method::POST,
        format!("{DOJO_API_BASE}/terminal-sessions"),
        &config,
        true,
    )
    .json(&json!({
        "terminalId": config.terminal_id,
        "details": {
            "sale": { "paymentIntentId": payment_intent_id },
            "sessionType": "Sale"
        }
    }))
    .send()
    .await
    .map_err(|error| format!("Could not contact Dojo: {error}"))?;
    if !response.status().is_success() {
        let message = api_error(response).await;
        let _ = payment_intent_cancel_request(&client, DOJO_API_BASE, &config, &payment_intent_id)
            .send()
            .await;
        return Err(message);
    }
    let session: Value = response
        .json()
        .await
        .map_err(|error| format!("Dojo returned invalid terminal-session data: {error}"))?;
    let terminal_session_id = session
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "Dojo did not return a terminal-session ID".to_string())?
        .to_string();
    Ok(DojoPaymentResult {
        payment_intent_id,
        terminal_session_id,
        reference,
    })
}

#[tauri::command]
pub async fn dojo_terminal_session_status(
    app: AppHandle,
    terminal_session_id: String,
) -> Result<DojoTerminalSessionStatus, String> {
    let config = require_api_config(&app, false)?;
    let terminal_session_id = clean_identifier(&terminal_session_id, "Terminal session ID", 128)?;
    let client = api_client()?;
    let response = api_request(
        &client,
        reqwest::Method::GET,
        format!("{DOJO_API_BASE}/terminal-sessions/{terminal_session_id}"),
        &config,
        true,
    )
    .send()
    .await
    .map_err(|error| format!("Could not contact Dojo: {error}"))?;
    if !response.status().is_success() {
        return Err(api_error(response).await);
    }
    let value: Value = response
        .json()
        .await
        .map_err(|error| format!("Dojo returned invalid terminal-session data: {error}"))?;
    let status = value
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("Unknown")
        .to_string();
    let payment_intent_id = value
        .pointer("/details/sale/paymentIntentId")
        .or_else(|| value.pointer("/details/matchedRefund/paymentIntentId"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let latest_notification = value
        .get("notificationEvents")
        .and_then(Value::as_array)
        .and_then(|items| items.last())
        .and_then(|item| item.get("notificationType"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let payment = if !payment_intent_id.is_empty()
        && matches!(
            status.as_str(),
            "Captured"
                | "Authorized"
                | "SignatureVerificationAccepted"
                | "SignatureVerificationRejected"
        ) {
        Some(fetch_payment_intent(&client, &config, &payment_intent_id).await?)
    } else {
        None
    };
    Ok(DojoTerminalSessionStatus {
        id: value
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or(&terminal_session_id)
            .to_string(),
        terminal_id: value
            .get("terminalId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        payment_intent_id,
        status,
        latest_notification,
        payment,
    })
}

fn validate_retry_payment(
    proof: &SandboxCancellationProof,
    payment: &DojoPaymentIntentStatus,
    session: &DojoTerminalSessionStatus,
    terminal_id: &str,
) -> Result<(), String> {
    validate_sandbox_cancellation_payment(proof, payment, "Created")?;
    if proof.status != "started"
        || !matches!(
            proof.operation_kind.as_str(),
            "sale" | "customer_account_payment"
        )
        || session.terminal_id != terminal_id
        || session.payment_intent_id != proof.payment_intent_id
        || !matches!(
            session.status.as_str(),
            "Declined" | "SignatureVerificationRejected"
        )
        || payment.terminal_history_error.is_some()
        || payment
            .latest_terminal_session_id
            .as_deref()
            .unwrap_or(&proof.terminal_session_id)
            != session.id
    {
        return Err("This payment cannot be retried safely. Check the original Dojo result; no new card request was sent.".into());
    }
    Ok(())
}

/// Retry a definitive decline using the original intent and durable sale.
/// The renderer keeps the same terminal lease and first-session journal anchor.
#[tauri::command]
pub async fn dojo_retry_payment(
    app: AppHandle,
    attempt_id: String,
    terminal_session_id: String,
) -> Result<DojoPaymentResult, String> {
    crate::licensing::require_sale_access(&app).await?;
    static RETRY: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = RETRY
        .try_lock()
        .map_err(|_| "A Dojo retry is already being sent")?;
    let config = require_api_config(&app, true)?;
    if !config.enabled {
        return Err("Enable Dojo before retrying".into());
    }
    let proof = read_sandbox_cancellation_proof(&app, &attempt_id).await?;
    if proof.terminal_key != format!("dojo:{}:{}", config.software_house_id, config.terminal_id) {
        return Err("The terminal configuration changed. Check the original payment.".into());
    }
    let session = dojo_terminal_session_status(app.clone(), terminal_session_id).await?;
    let client = api_client()?;
    let payment = fetch_payment_intent(&client, &config, &proof.payment_intent_id).await?;
    validate_retry_payment(&proof, &payment, &session, &config.terminal_id)?;
    if read_sandbox_cancellation_proof(&app, &attempt_id).await? != proof {
        return Err("The Dojo journal changed. No retry was sent.".into());
    }
    local_terminal::reserve_dispatch(
        &app,
        "dojo",
        &attempt_id,
        &proof.terminal_key,
        proof.amount,
        &proof.currency,
        config.terminal_ownership,
        &format!("retry:{}", session.id),
        Some(&proof.payment_intent_id),
    )
    .await?;
    let response = api_request(&client, reqwest::Method::POST,
        format!("{DOJO_API_BASE}/terminal-sessions"), &config, true)
        .json(&json!({"terminalId": config.terminal_id,
            "details": {"sale": {"paymentIntentId": proof.payment_intent_id}, "sessionType": "Sale"}}))
        .send().await.map_err(|e| format!("The Dojo retry response is uncertain; check the original payment: {e}"))?;
    if !response.status().is_success() {
        return Err(api_error(response).await);
    }
    let value: Value = response
        .json()
        .await
        .map_err(|e| format!("Invalid Dojo retry response: {e}"))?;
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or("Dojo did not return the retry session ID; check the original payment")?;
    Ok(DojoPaymentResult {
        payment_intent_id: proof.payment_intent_id,
        terminal_session_id: id.into(),
        reference: proof.attempt_id,
    })
}

#[tauri::command]
pub async fn dojo_payment_intent_status(
    app: AppHandle,
    payment_intent_id: String,
) -> Result<DojoPaymentIntentStatus, String> {
    let config = require_api_config(&app, false)?;
    let payment_intent_id = clean_identifier(&payment_intent_id, "Payment intent ID", 128)?;
    fetch_payment_intent(&api_client()?, &config, &payment_intent_id).await
}

#[tauri::command]
pub async fn dojo_payment_intent_by_reference(
    app: AppHandle,
    reference: String,
    created_at: String,
) -> Result<Option<DojoPaymentIntentReferenceResult>, String> {
    let config = require_api_config(&app, false)?;
    let reference = clean_identifier(&reference, "Payment reference", 60)?;
    if reference.is_empty() {
        return Err("A unique payment reference is required".into());
    }
    let (start_date, end_date) = payment_intent_search_window(&created_at, Utc::now())?;
    let client = api_client()?;
    let mut after: Option<String> = None;
    let mut seen_cursors = HashSet::new();
    let mut found = None;

    for _ in 0..PAYMENT_INTENT_SEARCH_MAX_PAGES {
        let response = api_request(
            &client,
            reqwest::Method::POST,
            format!("{DOJO_API_BASE}/payment-intents/search"),
            &config,
            false,
        )
        .json(&payment_intent_search_payload(
            &start_date,
            &end_date,
            after.as_deref(),
        ))
        .send()
        .await
        .map_err(|error| format!("Could not contact Dojo while recovering the payment: {error}"))?;
        if !response.status().is_success() {
            return Err(api_error(response).await);
        }
        let page: Value = response
            .json()
            .await
            .map_err(|error| format!("Dojo returned invalid payment-search data: {error}"))?;
        let (matches, next_after) = parse_payment_intent_search_page(&page, &reference)?;
        merge_unique_reference_matches(&mut found, matches)?;

        let Some(next_after) = next_after else {
            return Ok(found);
        };
        if !seen_cursors.insert(next_after.clone()) {
            return Err(
                "Dojo repeated a payment-search cursor; check the Dojo portal before retrying"
                    .into(),
            );
        }
        after = Some(next_after);
    }

    Err("Dojo returned too many payment-search pages; check the Dojo portal before retrying".into())
}

#[tauri::command]
pub async fn dojo_cancel_terminal_session(
    app: AppHandle,
    terminal_session_id: String,
) -> Result<(), String> {
    let config = require_api_config(&app, false)?;
    let terminal_session_id = clean_identifier(&terminal_session_id, "Terminal session ID", 128)?;
    let response = terminal_session_cancel_request(
        &api_client()?,
        DOJO_API_BASE,
        &config,
        &terminal_session_id,
    )
    .send()
    .await
    .map_err(|error| format!("Could not contact Dojo: {error}"))?;
    if !response.status().is_success() {
        return Err(api_error(response).await);
    }
    Ok(())
}

#[tauri::command]
pub async fn dojo_respond_signature(
    app: AppHandle,
    terminal_session_id: String,
    accepted: bool,
) -> Result<(), String> {
    let config = require_api_config(&app, false)?;
    let terminal_session_id = clean_identifier(&terminal_session_id, "Terminal session ID", 128)?;
    let response = api_request(
        &api_client()?,
        reqwest::Method::PUT,
        format!("{DOJO_API_BASE}/terminal-sessions/{terminal_session_id}/signature"),
        &config,
        true,
    )
    .json(&json!({ "accepted": accepted }))
    .send()
    .await
    .map_err(|error| format!("Could not contact Dojo: {error}"))?;
    if !response.status().is_success() {
        return Err(api_error(response).await);
    }
    Ok(())
}

#[tauri::command]
pub async fn dojo_refund_payment_intent(
    app: AppHandle,
    payment_intent_id: String,
    amount_pence: i64,
    idempotency_key: String,
) -> Result<DojoRefundResult, String> {
    let config = require_api_config(&app, false)?;
    if !config.enabled || !config_is_ready(&config) {
        return Err("Dojo is not enabled and fully configured on this till".into());
    }
    if amount_pence <= 0 || amount_pence > 99_999_999 {
        return Err("The Dojo refund amount is invalid".into());
    }
    let payment_intent_id = clean_identifier(&payment_intent_id, "Payment intent ID", 128)?;
    let idempotency_key = clean_identifier(&idempotency_key, "Refund idempotency key", 100)?;
    if payment_intent_id.is_empty() || idempotency_key.is_empty() {
        return Err("The original Dojo payment and refund reference are required".into());
    }
    local_terminal::reserve_dispatch(
        &app,
        "dojo",
        &idempotency_key,
        &format!("dojo:{}:{}", config.software_house_id, config.terminal_id),
        amount_pence,
        &config.currency,
        config.terminal_ownership,
        "refund",
        Some(&payment_intent_id),
    )
    .await?;
    let response = api_request(
        &api_client()?,
        reqwest::Method::POST,
        format!("{DOJO_API_BASE}/payment-intents/{payment_intent_id}/refunds"),
        &config,
        false,
    )
    .header("idempotencyKey", idempotency_key)
    .json(&json!({
        "amount": amount_pence,
        "refundReason": "POS customer refund"
    }))
    .send()
    .await
    .map_err(|error| format!("Could not contact Dojo while refunding: {error}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let mut response = response;
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Could not read Dojo refund result; check the original refund")?
        {
            if chunk.len() > API_ERROR_MAX_BODY_BYTES.saturating_sub(body.len()) {
                return Err(readable_api_error(status, &[]));
            }
            body.extend_from_slice(&chunk);
        }
        if refund_explicitly_failed(status, &body) {
            return Ok(DojoRefundResult {
                refund_id: String::new(),
                payment_intent_id,
                rejected: true,
            });
        }
        return Err(readable_api_error(status, &body));
    }
    let value: Value = response
        .json()
        .await
        .map_err(|error| format!("Dojo returned invalid refund data: {error}"))?;
    Ok(DojoRefundResult {
        rejected: false,
        refund_id: value
            .get("refundId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        payment_intent_id: value
            .get("paymentIntentId")
            .and_then(Value::as_str)
            .unwrap_or(&payment_intent_id)
            .to_string(),
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DojoExpiryReview {
    attempt_id: String,
    decision: String,
    receipt_reference: String,
    note: String,
    tips_amount: i64,
    service_charge_amount: i64,
    cashback_amount: i64,
}

fn validate_expiry_review(review: &DojoExpiryReview) -> Result<(), String> {
    if !matches!(review.decision.as_str(), "paid" | "not_paid")
        || review.receipt_reference.trim().len() < 3
        || review.receipt_reference.len() > 120
        || review.note.trim().len() < 5
        || review.note.len() > 500
        || review.receipt_reference.chars().any(char::is_control)
        || [
            review.tips_amount,
            review.service_charge_amount,
            review.cashback_amount,
        ]
        .iter()
        .any(|amount| !(0..=99_999_999).contains(amount))
        || (review.decision == "not_paid"
            && (review.tips_amount != 0
                || review.service_charge_amount != 0
                || review.cashback_amount != 0))
    {
        return Err("Choose the checked card result, enter a receipt/transaction reference and review note, and check the extra amounts.".into());
    }
    Ok(())
}

fn mysql_text(row: &sqlx::mysql::MySqlRow, column: &str) -> Result<String, String> {
    row.try_get::<String, _>(column)
        .or_else(|original| {
            row.try_get::<Vec<u8>, _>(column)
                .and_then(|bytes| {
                    String::from_utf8(bytes).map_err(|error| sqlx::Error::Decode(Box::new(error)))
                })
                .map_err(|_| original)
        })
        .map_err(|error| error.to_string())
}

/// Records a receipt-checked operator decision separately from provider proof.
/// No renderer-provided success status can enter this path without native
/// administrator authentication, an exclusive lease and fresh expiry checks.
#[tauri::command]
pub async fn dojo_review_expired_payment(
    app: AppHandle,
    mysql_uri: Option<String>,
    employee_id: String,
    pin: String,
    till_id: String,
    lease_reference: String,
    review: DojoExpiryReview,
) -> Result<(), String> {
    validate_expiry_review(&review)?;
    let config = require_api_config(&app, false)?;
    let proof = read_sandbox_cancellation_proof(&app, &review.attempt_id).await?;
    if !matches!(proof.status.as_str(), "started" | "uncertain")
        || !matches!(
            proof.operation_kind.as_str(),
            "sale" | "customer_account_payment"
        )
    {
        return Err("Only an unresolved Dojo sale or account payment can be reviewed.".into());
    }
    let terminal = proof
        .terminal_key
        .strip_prefix(&format!("dojo:{}:", config.software_house_id))
        .filter(|id| !id.is_empty())
        .ok_or("The Dojo account does not match this payment")?;
    let scope = local_terminal::attempt_scope(&app, &proof.attempt_id).await?;
    if scope == "local" {
        return review_local_expired_payment(
            &app,
            &config,
            &proof,
            terminal,
            &employee_id,
            &pin,
            &till_id,
            &lease_reference,
            &review,
        )
        .await;
    }
    if scope != "shared" {
        return Err("Unknown payment journal ownership; no review was recorded.".into());
    }
    let mysql_uri = mysql_uri.filter(|uri| !uri.trim().is_empty())
        .ok_or("This older shared payment must be reviewed while connected to its original MariaDB journal.")?;
    let mut conn = sqlx::MySqlConnection::connect(&mysql_uri)
        .await
        .map_err(|_| "Could not connect to the shared payment journal".to_string())?;
    sqlx::query("SET SESSION innodb_lock_wait_timeout = 5")
        .execute(&mut conn)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("START TRANSACTION")
        .execute(&mut conn)
        .await
        .map_err(|e| e.to_string())?;
    let (mut conn, employee_name) =
        crate::cash_control::authenticate_payment_administrator(conn, &employee_id, &pin).await?;
    // Follow the same maintenance/close lock order as commerce writes.
    let restoring: i64 = sqlx::query_scalar(
        "SELECT CAST(isActive AS SIGNED) FROM pos_restore_gate WHERE id = 1 FOR UPDATE",
    )
    .fetch_one(&mut conn)
    .await
    .map_err(|e| e.to_string())?;
    let barrier = sqlx::query("SELECT state FROM pos_close_barrier WHERE id = 1 FOR UPDATE")
        .fetch_one(&mut conn)
        .await
        .map_err(|e| e.to_string())?;
    if restoring != 0 || mysql_text(&barrier, "state")? != "idle" {
        return Err(
            "Finish or cancel the report close/database maintenance before reviewing a payment."
                .into(),
        );
    }
    let lease = sqlx::query("SELECT tillId, paymentReference, CAST(expiresAt > UTC_TIMESTAMP(3) AS SIGNED) AS valid FROM payment_terminal_locks WHERE terminalKey = ? FOR UPDATE")
        .bind(&proof.terminal_key).fetch_optional(&mut conn).await.map_err(|e| e.to_string())?
        .ok_or("The payment review no longer owns the terminal reservation")?;
    if mysql_text(&lease, "tillId")? != till_id
        || mysql_text(&lease, "paymentReference")? != lease_reference
        || lease
            .try_get::<i64, _>("valid")
            .map_err(|e| e.to_string())?
            != 1
    {
        return Err("The payment review no longer owns the terminal reservation.".into());
    }
    let row = sqlx::query(
        "SELECT * FROM payment_terminal_attempts WHERE id = ? AND provider = 'dojo' FOR UPDATE",
    )
    .bind(&proof.attempt_id)
    .fetch_one(&mut conn)
    .await
    .map_err(|e| e.to_string())?;
    for (column, expected) in [
        ("terminalKey", &proof.terminal_key),
        ("clientTransactionId", &proof.payment_intent_id),
        ("terminalSessionId", &proof.terminal_session_id),
        ("operationKind", &proof.operation_kind),
        ("currency", &proof.currency),
        ("status", &proof.status),
    ] {
        if mysql_text(&row, column)? != *expected {
            return Err("The shared payment changed; refresh the review.".into());
        }
    }
    if row.try_get::<i64, _>("amount").map_err(|e| e.to_string())? != proof.amount
        || !mysql_text(&row, "operatorResolution")?.is_empty()
    {
        return Err(
            "This payment already has a review or the amount changed. Refresh payment checks."
                .into(),
        );
    }
    let session_id = confirm_expired_review(&app, &config, &proof, terminal, &review).await?;
    let stamp = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let resolution = expiry_resolution(
        &proof,
        &session_id,
        &review,
        &employee_id,
        &employee_name,
        &stamp,
    );
    let encoded = resolution.to_string();
    sqlx::query("UPDATE payment_terminal_attempts SET operatorResolution = ?, status = 'uncertain', updatedAt = ?, error = 'Administrator recorded the terminal receipt result; ledger recovery pending' WHERE id = ? AND provider = 'dojo'")
        .bind(&encoded).bind(&stamp).bind(&proof.attempt_id).execute(&mut conn).await.map_err(|e| e.to_string())?;
    let audit_id = rand::random::<[u8; 16]>()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    sqlx::query("INSERT INTO audit_logs (id, employeeId, action, entityType, entityId, oldData, newData, createdAt, updatedAt) VALUES (?, ?, 'dojo_expired_payment_review', 'payment_terminal_attempt', ?, '{}', ?, ?, ?)")
        .bind(audit_id).bind(&employee_id).bind(&proof.attempt_id).bind(encoded).bind(&stamp).bind(&stamp)
        .execute(&mut conn).await.map_err(|e| e.to_string())?;
    sqlx::query("COMMIT")
        .execute(&mut conn)
        .await
        .map_err(|_| {
            "The review save could not be confirmed. Refresh payment checks before repeating it."
                .to_string()
        })?;
    Ok(())
}

async fn confirm_expired_review(
    app: &AppHandle,
    config: &DojoStoredConfig,
    proof: &SandboxCancellationProof,
    terminal: &str,
    review: &DojoExpiryReview,
) -> Result<String, String> {
    let client = api_client()?;
    let payment = fetch_payment_intent(&client, config, &proof.payment_intent_id).await?;
    if payment.terminal_history_error.is_some() {
        return Err("Dojo session history could not be verified.".into());
    }
    let session_id = payment
        .latest_terminal_session_id
        .as_deref()
        .unwrap_or(&proof.terminal_session_id);
    let session = dojo_terminal_session_status(app.clone(), session_id.into()).await?;
    if session.status != "Expired"
        || session.terminal_id != terminal
        || session.payment_intent_id != proof.payment_intent_id
    {
        return Err("Dojo has not confirmed an expired session for this payment. Run Check payment results.".into());
    }
    let fresh = fetch_payment_intent(&client, config, &proof.payment_intent_id).await?;
    validate_sandbox_cancellation_payment(proof, &fresh, "Created")?;
    if fresh.terminal_history_error.is_some()
        || fresh
            .latest_terminal_session_id
            .as_deref()
            .unwrap_or(&proof.terminal_session_id)
            != session_id
    {
        return Err("The Dojo session changed during review. Run Check payment results.".into());
    }
    if review.decision == "not_paid" {
        // Retire the unused intent before releasing the journal. A racing
        // capture must win and be recovered, never erased by this decision.
        let response =
            payment_intent_cancel_request(&client, DOJO_API_BASE, config, &proof.payment_intent_id)
                .send()
                .await
                .map_err(|_| "Cancellation could not be confirmed. Keep the payment unresolved.")?;
        if !response.status().is_success() {
            return Err(api_error(response).await);
        }
        let canceled = fetch_payment_intent(&client, config, &proof.payment_intent_id).await?;
        validate_sandbox_cancellation_payment(proof, &canceled, "Canceled")?;
    }
    Ok(session_id.into())
}

fn expiry_resolution(
    proof: &SandboxCancellationProof,
    session_id: &str,
    review: &DojoExpiryReview,
    employee_id: &str,
    employee_name: &str,
    stamp: &str,
) -> Value {
    json!({"version":1, "attemptId":proof.attempt_id,
        "paymentIntentId":proof.payment_intent_id,"terminalSessionId":session_id,
        "decision":review.decision,"amount":proof.amount,"currency":proof.currency,
        "receiptReference":review.receipt_reference.trim(),"note":review.note.trim(),
        "tipsAmount":review.tips_amount,"serviceChargeAmount":review.service_charge_amount,
        "cashbackAmount":review.cashback_amount,"employeeId":employee_id,"employeeName":employee_name,"createdAt":stamp})
}

async fn validate_local_expiry_row(
    conn: &mut sqlx::SqliteConnection,
    proof: &SandboxCancellationProof,
    till_id: &str,
    lease_reference: &str,
) -> Result<(), String> {
    local_terminal::assert_local_write_allowed(conn).await?;
    local_terminal::require_lease(conn, &proof.terminal_key, till_id, lease_reference).await?;
    let row = sqlx::query("SELECT * FROM payment_terminal_attempts WHERE id=? AND provider='dojo' AND journalScope='local'")
        .bind(&proof.attempt_id).fetch_optional(conn).await.map_err(|e| e.to_string())?
        .ok_or("The original local payment journal is missing.")?;
    for (column, expected) in [
        ("terminalKey", &proof.terminal_key),
        ("clientTransactionId", &proof.payment_intent_id),
        ("terminalSessionId", &proof.terminal_session_id),
        ("operationKind", &proof.operation_kind),
        ("currency", &proof.currency),
        ("status", &proof.status),
    ] {
        if row
            .try_get::<String, _>(column)
            .map_err(|e| e.to_string())?
            != *expected
        {
            return Err("The local payment changed; refresh payment recovery.".into());
        }
    }
    if row.try_get::<i64, _>("amount").map_err(|e| e.to_string())? != proof.amount
        || row
            .try_get::<String, _>("tillId")
            .map_err(|e| e.to_string())?
            != till_id
        || !row
            .try_get::<String, _>("operatorResolution")
            .map_err(|e| e.to_string())?
            .is_empty()
    {
        return Err("The local payment changed or already has an administrator review.".into());
    }
    Ok(())
}

async fn review_local_expired_payment(
    app: &AppHandle,
    config: &DojoStoredConfig,
    proof: &SandboxCancellationProof,
    terminal: &str,
    employee_id: &str,
    pin: &str,
    till_id: &str,
    lease_reference: &str,
    review: &DojoExpiryReview,
) -> Result<(), String> {
    let mut conn = local_terminal::connect(app).await?;
    local_terminal::ensure_schema(&mut conn).await?;
    let (mut conn, _) =
        crate::cash_control::authenticate_local_payment_administrator(conn, employee_id, pin)
            .await?;
    validate_local_expiry_row(&mut conn, proof, till_id, lease_reference).await?;
    conn.close().await.map_err(|e| e.to_string())?;
    // Do not hold SQLite's whole-database write lock across provider HTTP.
    // Reauthenticate and compare the complete proof inside the final short
    // transaction so a concurrent recovery or staff revocation wins safely.
    let session_id = confirm_expired_review(app, config, proof, terminal, review).await?;
    let mut conn = local_terminal::connect(app).await?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut conn)
        .await
        .map_err(|e| e.to_string())?;
    let (mut conn, employee_name) =
        crate::cash_control::authenticate_local_payment_administrator(conn, employee_id, pin)
            .await?;
    validate_local_expiry_row(&mut conn, proof, till_id, lease_reference).await?;
    let stamp = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let encoded = expiry_resolution(
        proof,
        &session_id,
        review,
        employee_id,
        &employee_name,
        &stamp,
    )
    .to_string();
    sqlx::query("UPDATE payment_terminal_attempts SET operatorResolution = ?, status = 'uncertain', updatedAt = ?, error = 'Administrator recorded the terminal receipt result; ledger recovery pending' WHERE id = ? AND provider = 'dojo' AND journalScope='local'")
        .bind(&encoded).bind(&stamp).bind(&proof.attempt_id).execute(&mut conn).await.map_err(|e| e.to_string())?;
    let audit_id = rand::random::<[u8; 16]>()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    sqlx::query("INSERT INTO audit_logs (id, employeeId, action, entityType, entityId, oldData, newData, createdAt, updatedAt) VALUES (?, ?, 'dojo_expired_payment_review', 'payment_terminal_attempt', ?, '{}', ?, ?, ?)")
        .bind(audit_id).bind(employee_id).bind(&proof.attempt_id).bind(encoded).bind(&stamp).bind(&stamp)
        .execute(&mut conn).await.map_err(|e| e.to_string())?;
    sqlx::query("COMMIT")
        .execute(&mut conn)
        .await
        .map_err(|_| {
            "The review save could not be confirmed. Refresh payment checks before repeating it."
                .to_string()
        })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };

    #[test]
    fn new_registration_is_dedicated_but_legacy_registration_remains_shared() {
        assert_eq!(
            DojoStoredConfig::default().terminal_ownership,
            TerminalOwnership::Dedicated
        );
        let mut legacy = serde_json::to_value(DojoStoredConfig::default()).unwrap();
        legacy.as_object_mut().unwrap().remove("terminalOwnership");
        let decoded: DojoStoredConfig = serde_json::from_value(legacy).unwrap();
        assert_eq!(decoded.terminal_ownership, TerminalOwnership::Shared);
    }

    // These tests use dummy credentials and a loopback HTTP server only. They
    // exercise the production request builders without contacting Dojo.
    fn loopback_response(status: &str, body: &str) -> (String, thread::JoinHandle<Vec<u8>>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let receiver = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 1024];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let count = stream.read(&mut buffer).unwrap();
                assert!(count > 0, "request ended before its headers");
                request.extend_from_slice(&buffer[..count]);
                assert!(
                    request.len() < 16 * 1024,
                    "test request headers are too large"
                );
            }
            // A bounded error reader may close early when rejecting a large body.
            let _ = stream.write_all(response.as_bytes());
            request
        });
        (base, receiver)
    }

    #[test]
    fn cancellation_requests_send_explicit_zero_length_on_the_wire() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let client = Client::builder()
                .no_proxy()
                .http1_only()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap();
            let config = DojoStoredConfig {
                api_key: "not-a-real-key".into(),
                ..DojoStoredConfig::default()
            };
            for terminal in [true, false] {
                let (base, receiver) = loopback_response("204 No Content", "");
                let (request, method, path) = if terminal {
                    (
                        terminal_session_cancel_request(&client, &base, &config, "ts_test"),
                        "PUT",
                        "/terminal-sessions/ts_test/cancel",
                    )
                } else {
                    (
                        payment_intent_cancel_request(&client, &base, &config, "pi_test"),
                        "DELETE",
                        "/payment-intents/pi_test",
                    )
                };
                let request = request.build().unwrap();
                assert_eq!(
                    request.body().and_then(reqwest::Body::as_bytes),
                    Some(&b""[..])
                );
                let response = client.execute(request).await.unwrap();
                assert_eq!(response.status(), reqwest::StatusCode::NO_CONTENT);
                let bytes = receiver.join().unwrap();
                let wire = String::from_utf8(bytes).unwrap();
                assert!(wire.starts_with(&format!("{method} {path} HTTP/1.1\r\n")));
                let headers = wire.to_ascii_lowercase();
                assert_eq!(headers.matches("\r\ncontent-length: 0\r\n").count(), 1);
                assert!(!headers.contains("transfer-encoding:"));
                assert!(headers.contains("\r\nauthorization: basic not-a-real-key\r\n"));
                assert!(headers.contains(&format!("\r\nversion: {DOJO_API_VERSION}\r\n")));
                assert_eq!(headers.contains("\r\nsoftware-house-id:"), terminal);
                assert_eq!(headers.contains("\r\nreseller-id:"), terminal);
                assert!(wire.ends_with("\r\n\r\n"), "cancel must have no body");
            }
        });
    }

    #[test]
    fn api_errors_do_not_expose_html_or_unstructured_response_bodies() {
        for body in [
            "",
            "<html><head><title>Length Required</title></head><body>POST requests require a Content-length header.</body></html>",
            "upstream diagnostics containing identifiers",
            "{malformed json}",
            r#"{"detail":"<html>Length Required</html>"}"#,
            r#"{"detail":"&lt;HTML&gt;Length Required&lt;/HTML&gt;"}"#,
            r#"{"detail":"&#x3c;html&#x3e;Length Required"}"#,
        ] {
            assert_eq!(
                readable_api_error(reqwest::StatusCode::LENGTH_REQUIRED, body.as_bytes()),
                "Dojo returned HTTP 411 Length Required"
            );
        }
    }

    #[test]
    fn api_errors_preserve_readable_json_details_and_fall_back_to_safe_titles() {
        for (body, expected) in [
            (
                json!({"detail": "  Cancellation\n is\t not permitted.\u{0}", "title": "Ignored"}),
                "Cancellation is not permitted.",
            ),
            (
                json!({"detail": "", "title": "Invalid terminal session"}),
                "Invalid terminal session",
            ),
            (
                json!({"Detail": "Your refund request was not successful. Status: Failed."}),
                "Your refund request was not successful. Status: Failed.",
            ),
            (
                json!({"detail": 411, "title": "Invalid terminal session"}),
                "Invalid terminal session",
            ),
            (
                json!({"detail": "<html>gateway error</html>", "title": "Invalid terminal session"}),
                "Invalid terminal session",
            ),
        ] {
            assert_eq!(
                readable_api_error(
                    reqwest::StatusCode::UNPROCESSABLE_ENTITY,
                    &serde_json::to_vec(&body).unwrap()
                ),
                format!("Dojo returned HTTP 422: {expected} This action is not allowed at the current payment stage. Check the original payment result.")
            );
        }
    }

    #[test]
    fn refund_rejection_requires_exact_final_provider_result() {
        let body =
            br#"{"Status":400,"Detail":"Your refund request was not successful. Status: Failed."}"#;
        assert!(refund_explicitly_failed(
            reqwest::StatusCode::BAD_REQUEST,
            body
        ));
        assert!(!refund_explicitly_failed(
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
            body
        ));
        assert!(!refund_explicitly_failed(
            reqwest::StatusCode::BAD_REQUEST,
            br#"{"Detail":"Pending"}"#
        ));
        assert!(!refund_explicitly_failed(
            reqwest::StatusCode::BAD_REQUEST,
            b"gateway error"
        ));
    }

    #[test]
    fn api_error_details_are_unicode_safe_and_bounded() {
        let body = json!({"detail": "é".repeat(API_ERROR_MAX_DETAIL_CHARS + 20)});
        assert_eq!(
            readable_api_error(
                reqwest::StatusCode::BAD_REQUEST,
                &serde_json::to_vec(&body).unwrap()
            ),
            format!(
                "Dojo returned HTTP 400: {}…",
                "é".repeat(API_ERROR_MAX_DETAIL_CHARS)
            )
        );
    }

    #[test]
    fn api_error_reads_are_bounded_and_html_falls_back_to_status() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let client = Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap();
            for body in [
                "<html><body>Length Required</body></html>".to_string(),
                json!({"detail": "Must not show a body over the limit", "padding": "x".repeat(API_ERROR_MAX_BODY_BYTES)}).to_string(),
            ] {
                let (base, receiver) = loopback_response("411 Length Required", &body);
                let response = client.get(base).send().await.unwrap();
                assert_eq!(api_error(response).await, "Dojo returned HTTP 411 Length Required");
                receiver.join().unwrap();
            }
        });
    }

    fn sandbox_proof() -> SandboxCancellationProof {
        SandboxCancellationProof {
            attempt_id: "sale-1".into(),
            terminal_key: "dojo:softwareHouse1:tm_sandbox_test".into(),
            payment_intent_id: "pi_sandbox_test".into(),
            terminal_session_id: "ts_sandbox_test".into(),
            operation_kind: "sale".into(),
            amount: 1055,
            currency: "GBP".into(),
            status: "uncertain".into(),
        }
    }

    #[test]
    fn retry_requires_latest_declined_session_and_uncharged_matching_intent() {
        let mut proof = sandbox_proof();
        proof.status = "started".into();
        let mut value = json!({"id":"pi_sandbox_test","reference":"sale-1","status":"Created",
            "amount":{"value":1055,"currencyCode":"GBP"},
            "terminalSessionHistory":[{"terminalSession":{"id":"ts_sandbox_test","status":"Declined"}}]});
        let mut session = DojoTerminalSessionStatus {
            id: "ts_sandbox_test".into(),
            terminal_id: "tm_sandbox_test".into(),
            payment_intent_id: "pi_sandbox_test".into(),
            status: "Declined".into(),
            latest_notification: None,
            payment: None,
        };
        assert!(validate_retry_payment(
            &proof,
            &payment_intent_from_value(&value),
            &session,
            "tm_sandbox_test"
        )
        .is_ok());
        for status in ["Captured", "Authorized", "Expired", "Initiated", "Canceled"] {
            session.status = status.into();
            assert!(validate_retry_payment(
                &proof,
                &payment_intent_from_value(&value),
                &session,
                "tm_sandbox_test"
            )
            .is_err());
        }
        session.status = "Declined".into();
        for status in ["Captured", "Authorized", "Canceled", "Refunded"] {
            value["status"] = json!(status);
            assert!(validate_retry_payment(
                &proof,
                &payment_intent_from_value(&value),
                &session,
                "tm_sandbox_test"
            )
            .is_err());
        }
        value["status"] = json!("Created");
        value["terminalSessionHistory"][0]["terminalSession"]["id"] = json!("ts_new");
        assert!(validate_retry_payment(
            &proof,
            &payment_intent_from_value(&value),
            &session,
            "tm_sandbox_test"
        )
        .is_err());
    }

    #[test]
    fn expiry_review_requires_receipt_evidence_and_whole_nonnegative_extras() {
        let mut review = DojoExpiryReview {
            attempt_id: "sale-1".into(),
            decision: "paid".into(),
            receipt_reference: "receipt-123".into(),
            note: "Checked approved merchant receipt".into(),
            tips_amount: 100,
            service_charge_amount: 0,
            cashback_amount: 200,
        };
        assert!(validate_expiry_review(&review).is_ok());
        review.decision = "not_paid".into();
        assert!(validate_expiry_review(&review).is_err());
        review.tips_amount = 0;
        review.cashback_amount = 0;
        assert!(validate_expiry_review(&review).is_ok());
        review.receipt_reference.clear();
        assert!(validate_expiry_review(&review).is_err());
    }

    #[test]
    fn production_requires_assigned_partner_ids_and_live_terminal() {
        let mut config = DojoStoredConfig {
            api_key: "sk_prod_example".into(),
            terminal_id: "tm_sandbox_example".into(),
            ..DojoStoredConfig::default()
        };
        assert!(!config_is_ready(&config));
        config.software_house_id = "assigned-house".into();
        config.reseller_id = "assigned-reseller".into();
        assert!(!config_is_ready(&config));
        config.terminal_id = "tm_live_example".into();
        assert!(config_is_ready(&config));
    }

    #[test]
    fn sandbox_cancellation_requires_actual_sandbox_key_and_unapproved_journal() {
        let mut config = DojoStoredConfig::default();
        let proof = sandbox_proof();
        for key in ["", "sk_prod_test", "sk_sandbox_", "unknown"] {
            config.api_key = key.into();
            assert!(validate_sandbox_cancellation_proof(&config, &proof).is_err());
        }
        config.api_key = "sk_sandbox_test".into();
        assert_eq!(
            validate_sandbox_cancellation_proof(&config, &proof).unwrap(),
            "tm_sandbox_test"
        );
        for status in [
            "approved",
            "commit_failed",
            "completion_pending",
            "completed",
            "failed",
            "cancelled",
        ] {
            let mut changed = proof.clone();
            changed.status = status.into();
            assert!(validate_sandbox_cancellation_proof(&config, &changed).is_err());
        }
        let mut changed = proof.clone();
        changed.operation_kind = "refund".into();
        assert!(validate_sandbox_cancellation_proof(&config, &changed).is_err());
        changed = proof.clone();
        changed.payment_intent_id = "bad/path".into();
        assert!(validate_sandbox_cancellation_proof(&config, &changed).is_err());
        changed = proof.clone();
        changed.terminal_key = "dojo:other:tm_sandbox_test".into();
        assert!(validate_sandbox_cancellation_proof(&config, &changed).is_err());
    }

    #[test]
    fn sandbox_cancellation_requires_exact_expired_session_linkage() {
        let proof = sandbox_proof();
        let session = json!({"id":"ts_sandbox_test","terminalId":"tm_sandbox_test","status":"Expired","details":{"sale":{"paymentIntentId":"pi_sandbox_test"}}});
        assert!(validate_sandbox_cancellation_session(&proof, "tm_sandbox_test", &session).is_ok());
        for pointer in [
            "/id",
            "/terminalId",
            "/details/sale/paymentIntentId",
            "/status",
        ] {
            let mut changed = session.clone();
            *changed.pointer_mut(pointer).unwrap() = json!("wrong");
            assert!(
                validate_sandbox_cancellation_session(&proof, "tm_sandbox_test", &changed).is_err()
            );
        }
        let mut changed = session;
        changed.as_object_mut().unwrap().remove("id");
        assert!(
            validate_sandbox_cancellation_session(&proof, "tm_sandbox_test", &changed).is_err()
        );
    }

    #[test]
    fn sandbox_cancellation_requires_created_then_confirmed_canceled_and_preserves_capture_race() {
        let proof = sandbox_proof();
        let mut value = json!({"id":"pi_sandbox_test","reference":"sale-1","status":"Created","amount":{"value":1055,"currencyCode":"GBP"}});
        assert!(validate_sandbox_cancellation_payment(
            &proof,
            &payment_intent_from_value(&value),
            "Created"
        )
        .is_ok());
        for status in ["Captured", "Authorized", "Reversed", "Unknown", "Created"] {
            value["status"] = json!(status);
            assert!(validate_sandbox_cancellation_payment(
                &proof,
                &payment_intent_from_value(&value),
                "Canceled"
            )
            .is_err());
        }
        value["status"] = json!("Canceled");
        assert!(validate_sandbox_cancellation_payment(
            &proof,
            &payment_intent_from_value(&value),
            "Canceled"
        )
        .is_ok());
        assert!(validate_sandbox_cancellation_payment(
            &proof,
            &payment_intent_from_value(&value),
            "Created"
        )
        .is_err());
        for (pointer, replacement) in [
            ("/id", json!("pi_other")),
            ("/reference", json!("other")),
            ("/amount/value", json!(1056)),
            ("/amount/currencyCode", json!("EUR")),
        ] {
            let mut changed = value.clone();
            *changed.pointer_mut(pointer).unwrap() = replacement;
            assert!(validate_sandbox_cancellation_payment(
                &proof,
                &payment_intent_from_value(&changed),
                "Canceled"
            )
            .is_err());
        }
    }

    #[test]
    fn ready_config_requires_terminal_and_partner_access() {
        let mut config = DojoStoredConfig::default();
        assert!(!config_is_ready(&config));
        config.terminal_id = "tm_sandbox_test".into();
        config.api_key = "sk_sandbox_test".into();
        assert!(config_is_ready(&config));
    }

    #[test]
    fn saved_config_never_serializes_secret() {
        let mut config = DojoStoredConfig::default();
        config.api_key = "private-api-key".into();
        let serialized = serde_json::to_string(&config).unwrap();
        assert!(!serialized.contains("private-api-key"));
        assert!(!serialized.contains("apiKey"));
    }

    #[test]
    fn payment_intent_uses_minor_units() {
        let value = json!({
            "id": "pi_test",
            "status": "Captured",
            "reference": "order-1",
            "amount": { "value": 1250, "currencyCode": "GBP" },
            "refundedAmount": 250,
            "paymentDetails": { "transactionId": "txn-1" }
        });
        let status = payment_intent_from_value(&value);
        assert_eq!(status.amount, Some(1250));
        assert_eq!(status.refunded_amount, Some(250));
        assert_eq!(status.transaction_id.as_deref(), Some("txn-1"));
    }

    #[test]
    fn payment_intent_preserves_money_breakdown() {
        let status = payment_intent_from_value(&json!({
            "amount": { "value": 600, "currencyCode": "GBP" },
            "tipsAmount": { "value": 60, "currencyCode": "GBP" },
            "cashbackAmount": { "value": 1000, "currencyCode": "GBP" },
            "serviceChargeAmount": { "value": 40, "currencyCode": "GBP" },
            "totalAmount": { "value": 1700, "currencyCode": "GBP" }
        }));
        assert_eq!(status.amount, Some(600));
        assert_eq!(status.tips_amount.unwrap().value, 60);
        assert_eq!(status.cashback_amount.unwrap().value, 1000);
        assert_eq!(status.service_charge_amount.unwrap().value, 40);
        assert_eq!(status.total_amount.unwrap().value, 1700);
        assert!(status.money_validation_error.is_none());
    }

    #[test]
    fn malformed_present_money_never_becomes_an_omitted_extra() {
        for invalid in [
            json!(60),
            json!({"value": "60", "currencyCode": "GBP"}),
            json!({"value": 1.5, "currencyCode": "GBP"}),
            json!({"value": -1, "currencyCode": "GBP"}),
            json!({"value": 60}),
            json!({"value": 9007199254740992_i64, "currencyCode": "GBP"}),
        ] {
            let status = payment_intent_from_value(&json!({"tipsAmount": invalid}));
            assert!(status.money_validation_error.is_some());
        }
        assert!(payment_intent_from_value(&json!({"tipsAmount": null}))
            .money_validation_error
            .is_none());
    }

    #[test]
    fn reference_search_parses_exact_match_and_latest_terminal_session() {
        let page = json!({
            "data": [
                {
                    "id": "pi_other",
                    "status": "Captured",
                    "reference": "order-other",
                    "terminalSessionHistory": []
                },
                {
                    "id": "pi_match",
                    "status": "Captured",
                    "reference": "order-123",
                    "amount": { "value": 2599, "currencyCode": "GBP" },
                    "terminalSessionHistory": [
                        {
                            "terminalSession": {
                                "id": "ts_first",
                                "status": "InitiateRequested",
                                "updatedAt": "2026-07-29T09:00:01Z"
                            }
                        },
                        {
                            "terminalSession": {
                                "id": "ts_latest",
                                "status": "Captured",
                                "updatedAt": "2026-07-29T09:00:05Z"
                            }
                        }
                    ]
                }
            ],
            "after": "next-page-token"
        });

        let (matches, after) = parse_payment_intent_search_page(&page, "order-123").unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].payment.id, "pi_match");
        assert_eq!(matches[0].payment.amount, Some(2599));
        assert_eq!(matches[0].terminal_session_id.as_deref(), Some("ts_latest"));
        assert_eq!(
            matches[0].terminal_session_status.as_deref(),
            Some("Captured")
        );
        assert_eq!(after.as_deref(), Some("next-page-token"));
    }

    #[test]
    fn reference_search_accepts_a_match_without_terminal_history() {
        let page = json!({
            "data": [{
                "id": "pi_created",
                "status": "Created",
                "reference": "order-123",
                "terminalSessionHistory": null
            }],
            "after": null
        });

        let (matches, after) = parse_payment_intent_search_page(&page, "order-123").unwrap();
        assert_eq!(matches.len(), 1);
        assert!(matches[0].terminal_session_id.is_none());
        assert!(matches[0].terminal_session_status.is_none());
        assert!(after.is_none());
    }

    #[test]
    fn reference_search_rejects_malformed_matching_terminal_history() {
        let page = json!({
            "data": [{
                "id": "pi_match",
                "status": "Captured",
                "reference": "order-123",
                "terminalSessionHistory": [{ "terminalSession": { "status": "Captured" } }]
            }],
            "after": null
        });

        let error = parse_payment_intent_search_page(&page, "order-123").unwrap_err();
        assert!(error.contains("without an ID"));
    }

    #[test]
    fn reference_search_rejects_duplicate_exact_matches() {
        let value = json!({
            "id": "pi_match_1",
            "status": "Captured",
            "reference": "order-123",
            "terminalSessionHistory": []
        });
        let first = payment_intent_reference_result_from_value(&value, "order-123")
            .unwrap()
            .unwrap();
        let mut second_value = value;
        second_value["id"] = Value::String("pi_match_2".into());
        let second = payment_intent_reference_result_from_value(&second_value, "order-123")
            .unwrap()
            .unwrap();
        let mut found = None;

        let error = merge_unique_reference_matches(&mut found, vec![first, second]).unwrap_err();
        assert!(error.contains("more than one"));
    }

    #[test]
    fn reference_search_window_has_five_minute_safety_margins() {
        let now = DateTime::parse_from_rfc3339("2026-07-29T10:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let (start, end) = payment_intent_search_window("2026-07-29T09:30:00Z", now).unwrap();

        assert_eq!(start, "2026-07-29T09:25:00.000Z");
        assert_eq!(end, "2026-07-29T10:05:00.000Z");
        let payload = payment_intent_search_payload(&start, &end, Some("cursor-2"));
        assert_eq!(
            payload.pointer("/cursor/limit").and_then(Value::as_u64),
            Some(50)
        );
        assert_eq!(
            payload.pointer("/cursor/after").and_then(Value::as_str),
            Some("cursor-2")
        );
        assert_eq!(
            payload
                .get("statuses")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(PAYMENT_INTENT_STATUSES.len())
        );
    }
}
