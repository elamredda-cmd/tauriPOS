use chrono::{DateTime, Duration as ChronoDuration, SecondsFormat, Utc};
use reqwest::{Client, Response};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashSet, fs, path::PathBuf, time::Duration};
use tauri::{AppHandle, Manager};

use crate::secret_store::{self, DOJO_API_KEY};

const DOJO_API_BASE: &str = "https://api.dojo.tech";
const DOJO_API_VERSION: &str = "2026-02-27";
const CONFIG_FILE_NAME: &str = "dojo.json";
const PAYMENT_INTENT_SEARCH_PAGE_LIMIT: u64 = 50;
const PAYMENT_INTENT_SEARCH_MAX_PAGES: usize = 100;
const PAYMENT_INTENT_STATUSES: [&str; 6] = [
    "Created",
    "Authorized",
    "Captured",
    "Reversed",
    "Refunded",
    "Canceled",
];

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DojoStoredConfig {
    enabled: bool,
    terminal_id: String,
    terminal_name: String,
    currency: String,
    software_house_id: String,
    reseller_id: String,
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
pub struct DojoPaymentIntentStatus {
    id: String,
    status: String,
    reference: String,
    amount: Option<i64>,
    currency: Option<String>,
    refunded_amount: Option<i64>,
    transaction_id: Option<String>,
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

fn load_config(app: &AppHandle) -> Result<DojoStoredConfig, String> {
    let path = config_path(app)?;
    if !path.exists() {
        let mut config = DojoStoredConfig::default();
        config.api_key = secret_store::load(DOJO_API_KEY)?;
        return Ok(config);
    }
    let contents = fs::read_to_string(path)
        .map_err(|error| format!("Could not read the Dojo settings: {error}"))?;
    let mut config: DojoStoredConfig = serde_json::from_str(&contents)
        .map_err(|error| format!("The saved Dojo settings are invalid: {error}"))?;
    let legacy_api_key = std::mem::take(&mut config.api_key);
    if !legacy_api_key.is_empty() {
        secret_store::save(DOJO_API_KEY, &legacy_api_key)?;
    }
    config.api_key = secret_store::load(DOJO_API_KEY)?;
    if !legacy_api_key.is_empty() {
        save_config_file(app, &config)?;
    }
    Ok(config)
}

fn save_config_file(app: &AppHandle, config: &DojoStoredConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let temporary = path.with_extension("json.tmp");
    let contents = serde_json::to_vec_pretty(config)
        .map_err(|error| format!("Could not prepare the Dojo settings: {error}"))?;
    fs::write(&temporary, contents)
        .map_err(|error| format!("Could not save the Dojo settings: {error}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("Could not protect the Dojo settings: {error}"))?;
    }

    fs::rename(&temporary, &path)
        .map_err(|error| format!("Could not finish saving the Dojo settings: {error}"))
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
}

fn require_api_config(app: &AppHandle, require_terminal: bool) -> Result<DojoStoredConfig, String> {
    let config = load_config(app)?;
    if config.api_key.is_empty() {
        return Err("Enter the Dojo secret API key first".into());
    }
    if config.software_house_id.is_empty() || config.reseller_id.is_empty() {
        return Err("Enter the Dojo software-house and reseller IDs first".into());
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
        .user_agent("LBj-POS/0.1 Dojo-Pay-at-Counter")
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

async fn api_error(response: Response) -> String {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if let Ok(value) = serde_json::from_str::<Value>(&body) {
        let detail = value
            .get("detail")
            .or_else(|| value.get("title"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !detail.is_empty() {
            return format!("Dojo returned {}: {detail}", status.as_u16());
        }
    }
    if body.trim().is_empty() {
        format!("Dojo returned HTTP {}", status.as_u16())
    } else {
        format!("Dojo returned HTTP {}: {}", status.as_u16(), body.trim())
    }
}

fn payment_intent_from_value(value: &Value) -> DojoPaymentIntentStatus {
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
        amount: value.pointer("/amount/value").and_then(Value::as_i64),
        currency: value
            .pointer("/amount/currencyCode")
            .and_then(Value::as_str)
            .map(str::to_string),
        refunded_amount: value.get("refundedAmount").and_then(Value::as_i64),
        transaction_id: value
            .pointer("/paymentDetails/transactionId")
            .and_then(Value::as_str)
            .map(str::to_string),
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

#[tauri::command]
pub fn dojo_get_config(app: AppHandle) -> Result<DojoPublicConfig, String> {
    let config = load_config(&app)?;
    Ok(DojoPublicConfig::from(&config))
}

#[tauri::command]
pub fn dojo_save_config(
    app: AppHandle,
    config: DojoConfigInput,
) -> Result<DojoPublicConfig, String> {
    let current = load_config(&app)?;
    let supplied_key = config.api_key.unwrap_or_default().trim().to_string();
    let next = DojoStoredConfig {
        enabled: config.enabled,
        terminal_id: clean_identifier(&config.terminal_id, "Terminal ID", 128)?,
        terminal_name: clean_identifier(&config.terminal_name, "Terminal name", 160)?,
        currency: normalize_currency(&config.currency)?,
        software_house_id: clean_identifier(&config.software_house_id, "Software-house ID", 128)?,
        reseller_id: clean_identifier(&config.reseller_id, "Reseller ID", 128)?,
        api_key: if supplied_key.is_empty() {
            current.api_key
        } else {
            supplied_key
        },
    };
    if next.enabled && !config_is_ready(&next) {
        return Err(
            "Complete the API key, integration IDs, and terminal before enabling Dojo".into(),
        );
    }
    secret_store::save(DOJO_API_KEY, &next.api_key)?;
    save_config_file(&app, &next)?;
    Ok(DojoPublicConfig::from(&next))
}

#[tauri::command]
pub fn dojo_clear_secret(app: AppHandle) -> Result<DojoPublicConfig, String> {
    let mut config = load_config(&app)?;
    config.enabled = false;
    secret_store::delete(DOJO_API_KEY)?;
    config.api_key.clear();
    save_config_file(&app, &config)?;
    Ok(DojoPublicConfig::from(&config))
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
        let _ = api_request(
            &client,
            reqwest::Method::DELETE,
            format!("{DOJO_API_BASE}/payment-intents/{payment_intent_id}"),
            &config,
            false,
        )
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
    let response = api_request(
        &api_client()?,
        reqwest::Method::PUT,
        format!("{DOJO_API_BASE}/terminal-sessions/{terminal_session_id}/cancel"),
        &config,
        true,
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
        return Err(api_error(response).await);
    }
    let value: Value = response
        .json()
        .await
        .map_err(|error| format!("Dojo returned invalid refund data: {error}"))?;
    Ok(DojoRefundResult {
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

#[cfg(test)]
mod tests {
    use super::*;

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
