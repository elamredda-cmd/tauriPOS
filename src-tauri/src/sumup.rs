use reqwest::{Client, Response, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, path::PathBuf, time::Duration};
use tauri::{AppHandle, Manager};

const SUMUP_API_BASE: &str = "https://api.sumup.com";
const CONFIG_FILE_NAME: &str = "sumup.json";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SumupStoredConfig {
    enabled: bool,
    merchant_code: String,
    reader_id: String,
    reader_name: String,
    currency: String,
    affiliate_app_id: String,
    api_key: String,
    affiliate_key: String,
}

impl Default for SumupStoredConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            merchant_code: String::new(),
            reader_id: String::new(),
            reader_name: String::new(),
            currency: "GBP".into(),
            affiliate_app_id: String::new(),
            api_key: String::new(),
            affiliate_key: String::new(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SumupConfigInput {
    enabled: bool,
    merchant_code: String,
    reader_id: String,
    reader_name: String,
    currency: String,
    affiliate_app_id: String,
    api_key: Option<String>,
    affiliate_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SumupPublicConfig {
    enabled: bool,
    merchant_code: String,
    reader_id: String,
    reader_name: String,
    currency: String,
    affiliate_app_id: String,
    api_key_configured: bool,
    affiliate_key_configured: bool,
    ready: bool,
}

impl From<&SumupStoredConfig> for SumupPublicConfig {
    fn from(value: &SumupStoredConfig) -> Self {
        Self {
            enabled: value.enabled,
            merchant_code: value.merchant_code.clone(),
            reader_id: value.reader_id.clone(),
            reader_name: value.reader_name.clone(),
            currency: value.currency.clone(),
            affiliate_app_id: value.affiliate_app_id.clone(),
            api_key_configured: !value.api_key.is_empty(),
            affiliate_key_configured: !value.affiliate_key.is_empty(),
            ready: config_is_ready(value),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SumupReaderDevice {
    identifier: Option<String>,
    model: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SumupReader {
    id: String,
    name: String,
    status: String,
    device: Option<SumupReaderDevice>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SumupReaderStatus {
    status: String,
    state: String,
    battery_level: Option<f64>,
    connection_type: Option<String>,
    firmware_version: Option<String>,
    last_activity: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SumupCheckoutResult {
    client_transaction_id: String,
    foreign_transaction_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SumupTransactionStatus {
    status: String,
    simple_status: String,
    transaction_id: Option<String>,
    transaction_code: Option<String>,
    client_transaction_id: String,
    foreign_transaction_id: Option<String>,
    amount: Option<f64>,
    currency: Option<String>,
    refunded_amount: Option<f64>,
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create the SumUp settings folder: {error}"))?;
    Ok(directory.join(CONFIG_FILE_NAME))
}

fn load_config(app: &AppHandle) -> Result<SumupStoredConfig, String> {
    let path = config_path(app)?;
    if !path.exists() {
        return Ok(SumupStoredConfig::default());
    }
    let contents = fs::read_to_string(path)
        .map_err(|error| format!("Could not read the SumUp settings: {error}"))?;
    serde_json::from_str(&contents)
        .map_err(|error| format!("The saved SumUp settings are invalid: {error}"))
}

fn save_config_file(app: &AppHandle, config: &SumupStoredConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let temporary = path.with_extension("json.tmp");
    let contents = serde_json::to_vec_pretty(config)
        .map_err(|error| format!("Could not prepare the SumUp settings: {error}"))?;
    fs::write(&temporary, contents)
        .map_err(|error| format!("Could not save the SumUp settings: {error}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("Could not protect the SumUp settings: {error}"))?;
    }

    fs::rename(&temporary, &path)
        .map_err(|error| format!("Could not finish saving the SumUp settings: {error}"))
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

fn config_is_ready(config: &SumupStoredConfig) -> bool {
    !config.merchant_code.is_empty()
        && !config.reader_id.is_empty()
        && !config.affiliate_app_id.is_empty()
        && !config.api_key.is_empty()
        && !config.affiliate_key.is_empty()
}

fn require_api_config(app: &AppHandle, require_reader: bool) -> Result<SumupStoredConfig, String> {
    let config = load_config(app)?;
    if config.merchant_code.is_empty() {
        return Err("Enter the SumUp merchant code first".into());
    }
    if config.api_key.is_empty() {
        return Err("Enter the SumUp API key first".into());
    }
    if require_reader && config.reader_id.is_empty() {
        return Err("Choose a SumUp Solo reader first".into());
    }
    Ok(config)
}

fn api_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(6))
        .timeout(Duration::from_secs(20))
        .user_agent("LBj-POS/0.1 SumUp-Cloud-API")
        .build()
        .map_err(|error| format!("Could not start the SumUp connection: {error}"))
}

async fn api_error(response: Response) -> String {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if let Ok(value) = serde_json::from_str::<Value>(&body) {
        if let Some(detail) = value.get("detail").and_then(Value::as_str) {
            return format!("SumUp returned {}: {detail}", status.as_u16());
        }
        if let Some(title) = value.get("title").and_then(Value::as_str) {
            return format!("SumUp returned {}: {title}", status.as_u16());
        }
    }
    if body.trim().is_empty() {
        format!("SumUp returned HTTP {}", status.as_u16())
    } else {
        format!("SumUp returned HTTP {}: {}", status.as_u16(), body.trim())
    }
}

fn bearer_request(
    client: &Client,
    method: reqwest::Method,
    url: String,
    api_key: &str,
) -> reqwest::RequestBuilder {
    client.request(method, url).bearer_auth(api_key)
}

fn refunded_amount(value: &Value) -> Option<f64> {
    if let Some(amount) = value.get("refunded_amount").and_then(Value::as_f64) {
        return Some(amount);
    }

    let events = value
        .get("events")
        .or_else(|| value.get("transaction_events"))
        .and_then(Value::as_array);
    if let Some(events) = events {
        let amount = events
            .iter()
            .filter(|event| {
                let event_type = event
                    .get("type")
                    .or_else(|| event.get("event_type"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let status = event
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                event_type == "REFUND" && matches!(status, "REFUNDED" | "SUCCESSFUL")
            })
            .filter_map(|event| event.get("amount").and_then(Value::as_f64))
            .sum();
        return Some(amount);
    }

    let status = value
        .get("simple_status")
        .or_else(|| value.get("status"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if matches!(status, "SUCCESSFUL" | "PAID_OUT" | "PENDING") {
        Some(0.0)
    } else {
        None
    }
}

async fn fetch_transaction(
    config: &SumupStoredConfig,
    query_name: &'static str,
    query_value: String,
) -> Result<SumupTransactionStatus, String> {
    let client = api_client()?;
    let url = format!(
        "{SUMUP_API_BASE}/v2.1/merchants/{}/transactions",
        config.merchant_code
    );
    let response = bearer_request(&client, reqwest::Method::GET, url, &config.api_key)
        .query(&[(query_name, query_value.as_str())])
        .send()
        .await
        .map_err(|error| format!("Could not contact SumUp: {error}"))?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(SumupTransactionStatus {
            status: "NOT_FOUND".into(),
            simple_status: "NOT_FOUND".into(),
            transaction_id: None,
            transaction_code: None,
            client_transaction_id: if query_name == "client_transaction_id" {
                query_value
            } else {
                String::new()
            },
            foreign_transaction_id: None,
            amount: None,
            currency: None,
            refunded_amount: None,
        });
    }
    if !response.status().is_success() {
        return Err(api_error(response).await);
    }
    let value: Value = response
        .json()
        .await
        .map_err(|error| format!("SumUp returned invalid transaction data: {error}"))?;
    Ok(SumupTransactionStatus {
        status: value
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("UNKNOWN")
            .to_string(),
        simple_status: value
            .get("simple_status")
            .and_then(Value::as_str)
            .unwrap_or("UNKNOWN")
            .to_string(),
        transaction_id: value.get("id").and_then(Value::as_str).map(str::to_string),
        transaction_code: value
            .get("transaction_code")
            .and_then(Value::as_str)
            .map(str::to_string),
        client_transaction_id: value
            .get("client_transaction_id")
            .and_then(Value::as_str)
            .unwrap_or(if query_name == "client_transaction_id" {
                &query_value
            } else {
                ""
            })
            .to_string(),
        foreign_transaction_id: value
            .get("foreign_transaction_id")
            .and_then(Value::as_str)
            .map(str::to_string),
        amount: value.get("amount").and_then(Value::as_f64),
        currency: value
            .get("currency")
            .and_then(Value::as_str)
            .map(str::to_string),
        refunded_amount: refunded_amount(&value),
    })
}

#[tauri::command]
pub fn sumup_get_config(app: AppHandle) -> Result<SumupPublicConfig, String> {
    let config = load_config(&app)?;
    Ok(SumupPublicConfig::from(&config))
}

#[tauri::command]
pub fn sumup_save_config(
    app: AppHandle,
    config: SumupConfigInput,
) -> Result<SumupPublicConfig, String> {
    let current = load_config(&app)?;
    let api_key = config.api_key.unwrap_or_default().trim().to_string();
    let affiliate_key = config.affiliate_key.unwrap_or_default().trim().to_string();
    let next = SumupStoredConfig {
        enabled: config.enabled,
        merchant_code: clean_identifier(&config.merchant_code, "Merchant code", 64)?,
        reader_id: clean_identifier(&config.reader_id, "Reader ID", 128)?,
        reader_name: clean_identifier(&config.reader_name, "Reader name", 500)?,
        currency: normalize_currency(&config.currency)?,
        affiliate_app_id: clean_identifier(&config.affiliate_app_id, "Affiliate App ID", 255)?,
        api_key: if api_key.is_empty() {
            current.api_key
        } else {
            api_key
        },
        affiliate_key: if affiliate_key.is_empty() {
            current.affiliate_key
        } else {
            affiliate_key
        },
    };
    if next.enabled && !config_is_ready(&next) {
        return Err(
            "Complete the merchant, reader, API key, and affiliate fields before enabling SumUp"
                .into(),
        );
    }
    save_config_file(&app, &next)?;
    Ok(SumupPublicConfig::from(&next))
}

#[tauri::command]
pub fn sumup_clear_secrets(app: AppHandle) -> Result<SumupPublicConfig, String> {
    let mut config = load_config(&app)?;
    config.enabled = false;
    config.api_key.clear();
    config.affiliate_key.clear();
    save_config_file(&app, &config)?;
    Ok(SumupPublicConfig::from(&config))
}

#[tauri::command]
pub async fn sumup_list_readers(app: AppHandle) -> Result<Vec<SumupReader>, String> {
    let config = require_api_config(&app, false)?;
    let client = api_client()?;
    let url = format!(
        "{SUMUP_API_BASE}/v0.1/merchants/{}/readers",
        config.merchant_code
    );
    let response = bearer_request(&client, reqwest::Method::GET, url, &config.api_key)
        .send()
        .await
        .map_err(|error| format!("Could not contact SumUp: {error}"))?;
    if !response.status().is_success() {
        return Err(api_error(response).await);
    }
    let value: Value = response
        .json()
        .await
        .map_err(|error| format!("SumUp returned invalid reader data: {error}"))?;
    serde_json::from_value(value.get("items").cloned().unwrap_or_else(|| json!([])))
        .map_err(|error| format!("SumUp returned invalid reader data: {error}"))
}

#[tauri::command]
pub async fn sumup_pair_reader(
    app: AppHandle,
    pairing_code: String,
    reader_name: String,
) -> Result<SumupReader, String> {
    let config = require_api_config(&app, false)?;
    let pairing_code = clean_identifier(&pairing_code, "Pairing code", 9)?.to_ascii_uppercase();
    if !(8..=9).contains(&pairing_code.len())
        || !pairing_code
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        return Err("Enter the 8 or 9 character pairing code shown by the Solo".into());
    }
    let reader_name = clean_identifier(&reader_name, "Reader name", 500)?;
    if reader_name.is_empty() {
        return Err("Enter a name for this reader".into());
    }
    let client = api_client()?;
    let url = format!(
        "{SUMUP_API_BASE}/v0.1/merchants/{}/readers",
        config.merchant_code
    );
    let response = bearer_request(&client, reqwest::Method::POST, url, &config.api_key)
        .json(&json!({ "pairing_code": pairing_code, "name": reader_name }))
        .send()
        .await
        .map_err(|error| format!("Could not contact SumUp: {error}"))?;
    if !response.status().is_success() {
        return Err(api_error(response).await);
    }
    response
        .json()
        .await
        .map_err(|error| format!("SumUp returned invalid reader data: {error}"))
}

#[tauri::command]
pub async fn sumup_reader_status(app: AppHandle) -> Result<SumupReaderStatus, String> {
    let config = require_api_config(&app, true)?;
    let client = api_client()?;
    let url = format!(
        "{SUMUP_API_BASE}/v0.1/merchants/{}/readers/{}/status",
        config.merchant_code, config.reader_id
    );
    let response = bearer_request(&client, reqwest::Method::GET, url, &config.api_key)
        .send()
        .await
        .map_err(|error| format!("Could not contact SumUp: {error}"))?;
    if !response.status().is_success() {
        return Err(api_error(response).await);
    }
    let value: Value = response
        .json()
        .await
        .map_err(|error| format!("SumUp returned invalid status data: {error}"))?;
    let data = value.get("data").unwrap_or(&value);
    Ok(SumupReaderStatus {
        status: data
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("UNKNOWN")
            .to_string(),
        state: data
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("UNKNOWN")
            .to_string(),
        battery_level: data.get("battery_level").and_then(Value::as_f64),
        connection_type: data
            .get("connection_type")
            .and_then(Value::as_str)
            .map(str::to_string),
        firmware_version: data
            .get("firmware_version")
            .and_then(Value::as_str)
            .map(str::to_string),
        last_activity: data
            .get("last_activity")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

#[tauri::command]
pub async fn sumup_create_checkout(
    app: AppHandle,
    amount_pence: i64,
    foreign_transaction_id: String,
    description: String,
) -> Result<SumupCheckoutResult, String> {
    let config = require_api_config(&app, true)?;
    if !config.enabled || !config_is_ready(&config) {
        return Err("SumUp is not enabled and fully configured on this till".into());
    }
    if amount_pence <= 0 || amount_pence > 99_999_999 {
        return Err("The SumUp payment amount is invalid".into());
    }
    let foreign_transaction_id =
        clean_identifier(&foreign_transaction_id, "Payment reference", 255)?;
    if foreign_transaction_id.is_empty() {
        return Err("A unique payment reference is required".into());
    }
    let description: String = description.trim().chars().take(255).collect();
    let client = api_client()?;
    let url = format!(
        "{SUMUP_API_BASE}/v0.1/merchants/{}/readers/{}/checkout",
        config.merchant_code, config.reader_id
    );
    let body = json!({
        "total_amount": {
            "currency": config.currency,
            "minor_unit": 2,
            "value": amount_pence
        },
        "description": description,
        "affiliate": {
            "app_id": config.affiliate_app_id,
            "key": config.affiliate_key,
            "foreign_transaction_id": foreign_transaction_id,
            "tags": { "source": "lbj-pos" }
        }
    });
    let response = bearer_request(&client, reqwest::Method::POST, url, &config.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("Could not contact SumUp: {error}"))?;
    if !response.status().is_success() {
        return Err(api_error(response).await);
    }
    let value: Value = response
        .json()
        .await
        .map_err(|error| format!("SumUp returned invalid checkout data: {error}"))?;
    let client_transaction_id = value
        .pointer("/data/client_transaction_id")
        .and_then(Value::as_str)
        .ok_or_else(|| "SumUp did not return a transaction ID".to_string())?
        .to_string();
    Ok(SumupCheckoutResult {
        client_transaction_id,
        foreign_transaction_id,
    })
}

#[tauri::command]
pub async fn sumup_transaction_status(
    app: AppHandle,
    client_transaction_id: String,
) -> Result<SumupTransactionStatus, String> {
    let config = require_api_config(&app, false)?;
    let client_transaction_id = clean_identifier(&client_transaction_id, "Transaction ID", 255)?;
    fetch_transaction(&config, "client_transaction_id", client_transaction_id).await
}

#[tauri::command]
pub async fn sumup_transaction_by_reference(
    app: AppHandle,
    foreign_transaction_id: String,
) -> Result<SumupTransactionStatus, String> {
    let config = require_api_config(&app, false)?;
    let foreign_transaction_id =
        clean_identifier(&foreign_transaction_id, "Payment reference", 255)?;
    fetch_transaction(&config, "foreign_transaction_id", foreign_transaction_id).await
}

#[tauri::command]
pub async fn sumup_refund_transaction(
    app: AppHandle,
    transaction_id: String,
    amount_pence: i64,
) -> Result<(), String> {
    let config = require_api_config(&app, false)?;
    if !config.enabled || !config_is_ready(&config) {
        return Err("SumUp is not enabled and fully configured on this till".into());
    }
    if amount_pence <= 0 || amount_pence > 99_999_999 {
        return Err("The SumUp refund amount is invalid".into());
    }
    let transaction_id = clean_identifier(&transaction_id, "Transaction ID", 255)?;
    if transaction_id.is_empty() {
        return Err("The original SumUp transaction ID is missing".into());
    }

    let client = api_client()?;
    let url = format!(
        "{SUMUP_API_BASE}/v1.0/merchants/{}/payments/{}/refunds",
        config.merchant_code, transaction_id
    );
    let response = bearer_request(&client, reqwest::Method::POST, url, &config.api_key)
        .json(&json!({ "amount": amount_pence as f64 / 100.0 }))
        .send()
        .await
        .map_err(|error| format!("Could not contact SumUp while refunding: {error}"))?;
    if !response.status().is_success() {
        return Err(api_error(response).await);
    }
    Ok(())
}

#[tauri::command]
pub async fn sumup_terminate_checkout(app: AppHandle) -> Result<(), String> {
    let config = require_api_config(&app, true)?;
    let client = api_client()?;
    let url = format!(
        "{SUMUP_API_BASE}/v0.1/merchants/{}/readers/{}/terminate",
        config.merchant_code, config.reader_id
    );
    let response = bearer_request(&client, reqwest::Method::POST, url, &config.api_key)
        .send()
        .await
        .map_err(|error| format!("Could not contact SumUp: {error}"))?;
    if !response.status().is_success() {
        return Err(api_error(response).await);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn currency_is_normalized() {
        assert_eq!(normalize_currency(" gbp ").unwrap(), "GBP");
        assert!(normalize_currency("pounds").is_err());
    }

    #[test]
    fn ready_config_requires_all_payment_fields() {
        let mut config = SumupStoredConfig::default();
        assert!(!config_is_ready(&config));
        config.merchant_code = "merchant".into();
        config.reader_id = "reader".into();
        config.affiliate_app_id = "app".into();
        config.api_key = "api".into();
        config.affiliate_key = "affiliate".into();
        assert!(config_is_ready(&config));
    }

    #[test]
    fn refund_amount_uses_successful_refund_events() {
        let value = json!({
            "simple_status": "REFUNDED",
            "events": [
                { "type": "REFUND", "status": "REFUNDED", "amount": 2.5 },
                { "type": "REFUND", "status": "FAILED", "amount": 1.0 },
                { "type": "PAYOUT", "status": "SUCCESSFUL", "amount": 5.0 }
            ]
        });
        assert_eq!(refunded_amount(&value), Some(2.5));
    }
}
