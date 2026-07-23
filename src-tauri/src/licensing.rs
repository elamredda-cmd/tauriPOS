use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Duration, Local, NaiveDate, Utc};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sqlx::{sqlite::SqlitePoolOptions, Row, SqlitePool};
use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};
use tauri::{AppHandle, Manager};

const LICENSE_FORMAT: &str = "LBJ1";
const LICENSE_REQUEST_FORMAT: &str = "LBJREQ1";
const SUPPORT_TOKEN_FORMAT: &str = "LBJSUP1";
const SUPPORT_REQUEST_FORMAT: &str = "LBJSUPREQ1";
const APP_IDENTITY_ID: &str = "main";
const TRIAL_DAYS: i64 = 10;
const EXPIRY_WARNING_DAYS: i64 = 7;
const SUPPORT_REQUEST_MINUTES: i64 = 10;
const SUPPORT_SESSION_MINUTES: i64 = 30;
const SUPPORT_CLOCK_SKEW_MINUTES: i64 = 5;
const MAX_LICENSE_BYTES: usize = 16 * 1024;
const MAX_LICENSE_FEATURES: usize = 20;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LicenseClaims {
    #[serde(rename = "v")]
    pub version: u8,
    pub license_id: String,
    pub shop_id: String,
    #[serde(default)]
    pub customer_name: String,
    pub issued_at: String,
    pub expires_on: String,
    pub max_tills: u32,
    #[serde(default)]
    pub features: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseStatus {
    pub state: String,
    pub message: String,
    pub access_allowed: bool,
    pub enforcement_enabled: bool,
    pub signature_valid: bool,
    pub is_trial: bool,
    pub trial_started_at: String,
    pub shop_id: String,
    pub shop_code: String,
    pub shop_name: String,
    pub license_id: String,
    pub customer_name: String,
    pub issued_at: String,
    pub expires_on: String,
    pub days_remaining: Option<i64>,
    pub max_tills: u32,
    pub active_tills: u32,
    pub features: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseRequest {
    pub code: String,
    pub request_id: String,
    pub shop_id: String,
    pub shop_code: String,
    pub shop_name: String,
    pub active_tills: u32,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportAccessRequest {
    pub code: String,
    pub request_id: String,
    pub shop_id: String,
    pub shop_code: String,
    pub shop_name: String,
    pub till_id: String,
    pub till_name: String,
    pub created_at: String,
    pub expires_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SupportAccessRequestPayload {
    #[serde(rename = "v")]
    version: u8,
    request_id: String,
    shop_id: String,
    shop_name: String,
    till_id: String,
    till_name: String,
    created_at: String,
    expires_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SupportAccessClaims {
    #[serde(rename = "v")]
    pub version: u8,
    pub session_id: String,
    pub request_id: String,
    pub shop_id: String,
    pub issued_at: String,
    pub expires_at: String,
    pub actor_name: String,
    pub scope: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportSessionGrant {
    pub session_id: String,
    pub shop_id: String,
    pub shop_code: String,
    pub actor_name: String,
    pub issued_at: String,
    pub expires_at: String,
    pub minutes_remaining: i64,
}

#[derive(Debug, Clone)]
struct PendingSupportRequest {
    request_id: String,
    shop_id: String,
    created_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
}

static PENDING_SUPPORT_REQUEST: OnceLock<Mutex<Option<PendingSupportRequest>>> = OnceLock::new();

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LicenseRequestPayload {
    #[serde(rename = "v")]
    version: u8,
    request_id: String,
    shop_id: String,
    shop_name: String,
    active_tills: u32,
    created_at: String,
}

#[derive(Debug)]
struct IdentityRecord {
    shop_id: String,
    shop_name: String,
    license_id: String,
    token: String,
    created_at: String,
}

#[derive(Debug)]
enum ValidationFailure {
    Missing,
    Invalid(String),
    ShopMismatch,
    Expired(LicenseClaims, i64),
    TillLimit(LicenseClaims, i64),
}

fn enforcement_enabled() -> bool {
    !matches!(
        option_env!("LBJ_LICENSE_ENFORCEMENT"),
        Some(value)
            if value.eq_ignore_ascii_case("off")
                || value.eq_ignore_ascii_case("preview")
                || value.eq_ignore_ascii_case("disabled")
                || value == "0"
    )
}

fn app_data_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join("pos.db"))
        .map_err(|error| error.to_string())
}

async fn open_local_db(app: &AppHandle) -> Result<SqlitePool, String> {
    let path = app_data_db_path(app)?;
    if !path.exists() {
        return Err("The local POS database is not ready".into());
    }
    let uri = format!("sqlite://{}?mode=rw", path.display());
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&uri)
        .await
        .map_err(|error| format!("Could not open the POS licence record: {error}"))?;
    sqlx::query("PRAGMA busy_timeout = 10000")
        .execute(&pool)
        .await
        .map_err(|error| format!("Could not prepare the POS licence record: {error}"))?;
    Ok(pool)
}

async fn read_identity(pool: &SqlitePool) -> Result<IdentityRecord, String> {
    let row = sqlx::query(
        "SELECT shopId, shopName, licenseId, identitySignature, createdAt
         FROM app_identity WHERE id = ? LIMIT 1",
    )
    .bind(APP_IDENTITY_ID)
    .fetch_optional(pool)
    .await
    .map_err(|error| format!("Could not read the shop identity: {error}"))?
    .ok_or_else(|| "Finish shop setup before creating a licence request".to_string())?;

    Ok(IdentityRecord {
        shop_id: row.try_get::<String, _>("shopId").unwrap_or_default(),
        shop_name: row.try_get::<String, _>("shopName").unwrap_or_default(),
        license_id: row.try_get::<String, _>("licenseId").unwrap_or_default(),
        token: row
            .try_get::<String, _>("identitySignature")
            .unwrap_or_default(),
        created_at: row.try_get::<String, _>("createdAt").unwrap_or_default(),
    })
}

async fn ensure_trial_start(
    pool: &SqlitePool,
    identity: &mut IdentityRecord,
) -> Result<(), String> {
    if parse_trial_start(&identity.created_at).is_some() {
        return Ok(());
    }
    let stamp = Utc::now().to_rfc3339();
    sqlx::query(
        "UPDATE app_identity
         SET createdAt = ?, updatedAt = ?
         WHERE id = ? AND shopId = ?",
    )
    .bind(&stamp)
    .bind(&stamp)
    .bind(APP_IDENTITY_ID)
    .bind(&identity.shop_id)
    .execute(pool)
    .await
    .map_err(|error| format!("Could not initialize the shop trial: {error}"))?;
    identity.created_at = stamp;
    Ok(())
}

async fn active_till_count(pool: &SqlitePool) -> Result<u32, String> {
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM registers
         WHERE COALESCE(isActive, 1) <> 0
           AND id NOT IN ('register-main', 'legacy-till')",
    )
    .fetch_one(pool)
    .await
    .map_err(|error| format!("Could not count the registered tills: {error}"))?;
    Ok(count.max(1).min(u32::MAX as i64) as u32)
}

fn shop_code(shop_id: &str) -> String {
    shop_id
        .trim()
        .strip_prefix("shop_")
        .unwrap_or(shop_id.trim())
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .take(8)
        .collect::<String>()
        .to_ascii_uppercase()
}

fn configured_public_keys() -> Result<HashMap<String, VerifyingKey>, String> {
    let encoded: HashMap<String, String> =
        serde_json::from_str(include_str!("../license-public-keys.json"))
            .map_err(|error| format!("The licence public-key configuration is invalid: {error}"))?;
    let mut keys = HashMap::new();
    for (key_id, value) in encoded {
        let decoded = URL_SAFE_NO_PAD
            .decode(value.trim())
            .map_err(|_| format!("Licence public key {key_id} is not valid base64url"))?;
        let bytes: [u8; 32] = decoded
            .try_into()
            .map_err(|_| format!("Licence public key {key_id} must contain 32 bytes"))?;
        let key = VerifyingKey::from_bytes(&bytes)
            .map_err(|_| format!("Licence public key {key_id} is invalid"))?;
        keys.insert(key_id, key);
    }
    Ok(keys)
}

fn pending_support_request() -> &'static Mutex<Option<PendingSupportRequest>> {
    PENDING_SUPPORT_REQUEST.get_or_init(|| Mutex::new(None))
}

fn consume_support_request(
    slot: &Mutex<Option<PendingSupportRequest>>,
    expected_request_id: &str,
) -> Result<(), String> {
    let mut current = slot
        .lock()
        .map_err(|_| "Could not consume the one-time support request".to_string())?;
    if current.as_ref().map(|request| request.request_id.as_str()) != Some(expected_request_id) {
        return Err("This support request was already used or replaced".into());
    }
    *current = None;
    Ok(())
}

async fn read_local_setting(pool: &SqlitePool, key: &str) -> Result<String, String> {
    sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ? LIMIT 1")
        .bind(key)
        .fetch_optional(pool)
        .await
        .map(|value| value.unwrap_or_default())
        .map_err(|error| format!("Could not read the local till identity: {error}"))
}

fn validate_support_identifier(value: &str, label: &str, maximum: usize) -> Result<(), String> {
    let clean = value.trim();
    if clean.is_empty()
        || clean.len() > maximum
        || !clean
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
    {
        return Err(format!("The support {label} is invalid"));
    }
    Ok(())
}

fn decode_and_verify_support_token(
    token: &str,
    expected_shop_id: &str,
    expected_request: &PendingSupportRequest,
    now: DateTime<Utc>,
    public_keys: &HashMap<String, VerifyingKey>,
) -> Result<SupportAccessClaims, String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("Enter the support code from the CRM".into());
    }
    if token.len() > MAX_LICENSE_BYTES {
        return Err("The support code is too large".into());
    }
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 4 || parts[0] != SUPPORT_TOKEN_FORMAT {
        return Err("This is not an L&Bj Support code".into());
    }

    let key_id = parts[1];
    validate_support_identifier(key_id, "key ID", 80)?;
    let key = public_keys
        .get(key_id)
        .ok_or_else(|| "This support code was issued by an unknown key".to_string())?;
    let signature_bytes = URL_SAFE_NO_PAD
        .decode(parts[3])
        .map_err(|_| "The support-code signature is damaged".to_string())?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| "The support-code signature is damaged".to_string())?;
    let signed_message = format!("{}.{}.{}", parts[0], parts[1], parts[2]);
    key.verify(signed_message.as_bytes(), &signature)
        .map_err(|_| "The support-code signature is not valid".to_string())?;

    let payload = URL_SAFE_NO_PAD
        .decode(parts[2])
        .map_err(|_| "The support-code details are damaged".to_string())?;
    let claims: SupportAccessClaims = serde_json::from_slice(&payload)
        .map_err(|_| "The support-code details are invalid".to_string())?;
    if claims.version != 1 {
        return Err("This support-code version is not supported".into());
    }
    validate_support_identifier(&claims.session_id, "session ID", 100)?;
    validate_support_identifier(&claims.request_id, "request ID", 100)?;
    validate_support_identifier(&claims.shop_id, "shop ID", 160)?;
    if claims.shop_id != expected_shop_id || claims.shop_id != expected_request.shop_id {
        return Err("This support code belongs to a different shop".into());
    }
    if claims.request_id != expected_request.request_id {
        return Err(
            "This support code belongs to an older request. Create a new code in the CRM.".into(),
        );
    }
    if claims.actor_name != "L&Bj Support" || claims.scope != "full_support" {
        return Err("This support code does not grant L&Bj Support access".into());
    }

    let issued_at = DateTime::parse_from_rfc3339(&claims.issued_at)
        .map_err(|_| "The support-code issue time is invalid".to_string())?
        .with_timezone(&Utc);
    let expires_at = DateTime::parse_from_rfc3339(&claims.expires_at)
        .map_err(|_| "The support-code expiry time is invalid".to_string())?
        .with_timezone(&Utc);
    if now > expected_request.expires_at {
        return Err("This POS support request has expired. Create a new request.".into());
    }
    if issued_at > now + Duration::minutes(SUPPORT_CLOCK_SKEW_MINUTES) {
        return Err("The support code was issued in the future. Check this till's clock.".into());
    }
    if issued_at < expected_request.created_at - Duration::minutes(SUPPORT_CLOCK_SKEW_MINUTES) {
        return Err("This support code predates the current request".into());
    }
    let lifetime = expires_at.signed_duration_since(issued_at);
    if lifetime <= Duration::zero() || lifetime > Duration::minutes(SUPPORT_SESSION_MINUTES) {
        return Err("The support-code lifetime is invalid".into());
    }
    if expires_at <= now {
        return Err("This support code has expired. Create a new request.".into());
    }
    Ok(claims)
}

fn validate_identifier(value: &str, label: &str, maximum: usize) -> Result<(), ValidationFailure> {
    let clean = value.trim();
    if clean.is_empty() || clean.len() > maximum {
        return Err(ValidationFailure::Invalid(format!(
            "The licence {label} is invalid"
        )));
    }
    if !clean
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
    {
        return Err(ValidationFailure::Invalid(format!(
            "The licence {label} contains unsupported characters"
        )));
    }
    Ok(())
}

fn decode_and_verify_token(
    token: &str,
    expected_shop_id: &str,
    active_tills: u32,
    today: NaiveDate,
    public_keys: &HashMap<String, VerifyingKey>,
) -> Result<(LicenseClaims, i64), ValidationFailure> {
    let token = token.trim();
    if token.is_empty() {
        return Err(ValidationFailure::Missing);
    }
    if token.len() > MAX_LICENSE_BYTES {
        return Err(ValidationFailure::Invalid(
            "The licence code is too large".into(),
        ));
    }
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 4 || parts[0] != LICENSE_FORMAT {
        return Err(ValidationFailure::Invalid(
            "This is not an L&Bj POS licence code".into(),
        ));
    }

    let key_id = parts[1];
    validate_identifier(key_id, "key ID", 80)?;
    let key = public_keys.get(key_id).ok_or_else(|| {
        ValidationFailure::Invalid("This licence was issued by an unknown key".into())
    })?;
    let signature_bytes = URL_SAFE_NO_PAD
        .decode(parts[3])
        .map_err(|_| ValidationFailure::Invalid("The licence signature is damaged".into()))?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| ValidationFailure::Invalid("The licence signature is damaged".into()))?;
    let signed_message = format!("{}.{}.{}", parts[0], parts[1], parts[2]);
    key.verify(signed_message.as_bytes(), &signature)
        .map_err(|_| ValidationFailure::Invalid("The licence signature is not valid".into()))?;

    let payload = URL_SAFE_NO_PAD
        .decode(parts[2])
        .map_err(|_| ValidationFailure::Invalid("The licence details are damaged".into()))?;
    let claims: LicenseClaims = serde_json::from_slice(&payload)
        .map_err(|_| ValidationFailure::Invalid("The licence details are invalid".into()))?;
    if claims.version != 1 {
        return Err(ValidationFailure::Invalid(
            "This licence version is not supported".into(),
        ));
    }
    validate_identifier(&claims.license_id, "ID", 64)?;
    validate_identifier(&claims.shop_id, "shop ID", 160)?;
    if claims.shop_id != expected_shop_id {
        return Err(ValidationFailure::ShopMismatch);
    }
    if claims.max_tills == 0 || claims.max_tills > 100 {
        return Err(ValidationFailure::Invalid(
            "The licence till allowance is invalid".into(),
        ));
    }
    if claims.features.len() > MAX_LICENSE_FEATURES {
        return Err(ValidationFailure::Invalid(
            "The licence contains too many features".into(),
        ));
    }
    for feature in &claims.features {
        validate_identifier(feature, "feature", 40)?;
    }
    if !claims.features.iter().any(|feature| feature == "pos") {
        return Err(ValidationFailure::Invalid(
            "This licence does not include POS sales".into(),
        ));
    }
    DateTime::parse_from_rfc3339(&claims.issued_at)
        .map_err(|_| ValidationFailure::Invalid("The licence issue date is invalid".into()))?;
    let expiry = NaiveDate::parse_from_str(&claims.expires_on, "%Y-%m-%d")
        .map_err(|_| ValidationFailure::Invalid("The licence expiry date is invalid".into()))?;
    let days_remaining = (expiry - today).num_days();
    // `expires_on` is the first local calendar day on which access is blocked.
    if days_remaining <= 0 {
        return Err(ValidationFailure::Expired(claims, days_remaining));
    }
    if active_tills > claims.max_tills {
        return Err(ValidationFailure::TillLimit(claims, days_remaining));
    }
    Ok((claims, days_remaining))
}

fn verified_claims_from_result(
    result: Result<(LicenseClaims, i64), ValidationFailure>,
) -> Option<LicenseClaims> {
    match result {
        Ok((claims, _))
        | Err(ValidationFailure::Expired(claims, _))
        | Err(ValidationFailure::TillLimit(claims, _)) => Some(claims),
        Err(_) => None,
    }
}

fn ensure_not_older_than_installed(
    new_claims: &LicenseClaims,
    installed_claims: Option<&LicenseClaims>,
) -> Result<(), String> {
    let Some(installed) = installed_claims else {
        return Ok(());
    };
    if installed.license_id == new_claims.license_id {
        return Ok(());
    }

    let installed_issued_at = DateTime::parse_from_rfc3339(&installed.issued_at)
        .map_err(|_| "The installed licence issue date is invalid".to_string())?;
    let new_issued_at = DateTime::parse_from_rfc3339(&new_claims.issued_at)
        .map_err(|_| "The new licence issue date is invalid".to_string())?;
    if new_issued_at <= installed_issued_at {
        return Err(
            "This licence is older than the licence already installed. Ask for a newly issued code."
                .into(),
        );
    }
    Ok(())
}

fn blank_status(
    identity: &IdentityRecord,
    active_tills: u32,
    state: &str,
    message: String,
) -> LicenseStatus {
    let enforced = enforcement_enabled();
    LicenseStatus {
        state: state.into(),
        message,
        access_allowed: !enforced,
        enforcement_enabled: enforced,
        signature_valid: false,
        is_trial: false,
        trial_started_at: String::new(),
        shop_id: identity.shop_id.clone(),
        shop_code: shop_code(&identity.shop_id),
        shop_name: identity.shop_name.clone(),
        license_id: identity.license_id.clone(),
        customer_name: String::new(),
        issued_at: String::new(),
        expires_on: String::new(),
        days_remaining: None,
        max_tills: 0,
        active_tills,
        features: Vec::new(),
    }
}

fn claims_status(
    identity: &IdentityRecord,
    active_tills: u32,
    claims: LicenseClaims,
    state: &str,
    message: String,
    days_remaining: i64,
    signature_valid: bool,
    policy_allows: bool,
) -> LicenseStatus {
    let enforced = enforcement_enabled();
    LicenseStatus {
        state: state.into(),
        message,
        access_allowed: policy_allows || !enforced,
        enforcement_enabled: enforced,
        signature_valid,
        is_trial: false,
        trial_started_at: String::new(),
        shop_id: identity.shop_id.clone(),
        shop_code: shop_code(&identity.shop_id),
        shop_name: identity.shop_name.clone(),
        license_id: claims.license_id,
        customer_name: claims.customer_name,
        issued_at: claims.issued_at,
        expires_on: claims.expires_on,
        days_remaining: Some(days_remaining),
        max_tills: claims.max_tills,
        active_tills,
        features: claims.features,
    }
}

fn parse_trial_start(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value.trim())
        .ok()
        .map(|date| date.with_timezone(&Utc))
}

fn trial_status(identity: &IdentityRecord, active_tills: u32, now: DateTime<Utc>) -> LicenseStatus {
    let enforced = enforcement_enabled();
    let started_at = parse_trial_start(&identity.created_at).unwrap_or(now);
    let ends_at = started_at + Duration::days(TRIAL_DAYS);
    let seconds_remaining = ends_at.signed_duration_since(now).num_seconds();
    let trial_active = seconds_remaining > 0;
    let days_remaining = if trial_active {
        ((seconds_remaining + 86_399) / 86_400).clamp(1, TRIAL_DAYS)
    } else {
        0
    };
    let message = if trial_active {
        if days_remaining == 1 {
            "Free trial: 1 day remaining".to_string()
        } else {
            format!("Free trial: {days_remaining} days remaining")
        }
    } else {
        "Free trial has ended. Enter an activation code to continue".to_string()
    };

    LicenseStatus {
        state: if trial_active {
            "trial"
        } else {
            "trial_expired"
        }
        .into(),
        message,
        access_allowed: trial_active || !enforced,
        enforcement_enabled: enforced,
        signature_valid: false,
        is_trial: true,
        trial_started_at: started_at.to_rfc3339(),
        shop_id: identity.shop_id.clone(),
        shop_code: shop_code(&identity.shop_id),
        shop_name: identity.shop_name.clone(),
        license_id: String::new(),
        customer_name: String::new(),
        issued_at: String::new(),
        expires_on: ends_at.date_naive().format("%Y-%m-%d").to_string(),
        days_remaining: Some(days_remaining),
        max_tills: 0,
        active_tills,
        features: Vec::new(),
    }
}

fn status_for_token_on_date(
    identity: &IdentityRecord,
    active_tills: u32,
    now: DateTime<Utc>,
    today: NaiveDate,
    public_keys: &HashMap<String, VerifyingKey>,
) -> LicenseStatus {
    match decode_and_verify_token(
        &identity.token,
        &identity.shop_id,
        active_tills,
        today,
        public_keys,
    ) {
        Ok((claims, days_remaining)) => {
            let (state, message) = if days_remaining <= EXPIRY_WARNING_DAYS {
                let message = match days_remaining {
                    1 => "Licence expires in 1 day".to_string(),
                    days => format!("Licence expires in {days} days"),
                };
                ("expiring", message)
            } else {
                ("active", "Licence is active".into())
            };
            claims_status(
                identity,
                active_tills,
                claims,
                state,
                message,
                days_remaining,
                true,
                true,
            )
        }
        Err(ValidationFailure::Missing) => trial_status(identity, active_tills, now),
        Err(ValidationFailure::Invalid(message)) => {
            blank_status(identity, active_tills, "invalid", message)
        }
        Err(ValidationFailure::ShopMismatch) => blank_status(
            identity,
            active_tills,
            "shop_mismatch",
            "This licence belongs to a different shop".into(),
        ),
        Err(ValidationFailure::Expired(claims, days_remaining)) => claims_status(
            identity,
            active_tills,
            claims,
            "expired",
            "Licence has expired".into(),
            days_remaining,
            true,
            false,
        ),
        Err(ValidationFailure::TillLimit(claims, days_remaining)) => claims_status(
            identity,
            active_tills,
            claims,
            "till_limit",
            "This shop has more active tills than the licence allows".into(),
            days_remaining,
            true,
            false,
        ),
    }
}

#[cfg(test)]
fn status_for_token(
    identity: &IdentityRecord,
    active_tills: u32,
    now: DateTime<Utc>,
    public_keys: &HashMap<String, VerifyingKey>,
) -> LicenseStatus {
    status_for_token_on_date(identity, active_tills, now, now.date_naive(), public_keys)
}

async fn read_status(app: &AppHandle) -> Result<LicenseStatus, String> {
    let pool = open_local_db(app).await?;
    let mut identity = read_identity(&pool).await?;
    ensure_trial_start(&pool, &mut identity).await?;
    let active_tills = active_till_count(&pool).await?;
    let keys = configured_public_keys()?;
    let local_now = Local::now();
    Ok(status_for_token_on_date(
        &identity,
        active_tills,
        local_now.with_timezone(&Utc),
        local_now.date_naive(),
        &keys,
    ))
}

#[tauri::command]
pub async fn manual_license_status(app: AppHandle) -> Result<LicenseStatus, String> {
    read_status(&app).await
}

#[tauri::command]
pub async fn create_manual_license_request(app: AppHandle) -> Result<LicenseRequest, String> {
    let pool = open_local_db(&app).await?;
    let identity = read_identity(&pool).await?;
    let active_tills = active_till_count(&pool).await?;
    let created_at = Utc::now().to_rfc3339();
    let request_id = format!(
        "req_{}_{}",
        shop_code(&identity.shop_id).to_ascii_lowercase(),
        Utc::now().timestamp_millis()
    );
    let payload = LicenseRequestPayload {
        version: 1,
        request_id: request_id.clone(),
        shop_id: identity.shop_id.clone(),
        shop_name: identity.shop_name.clone(),
        active_tills,
        created_at: created_at.clone(),
    };
    let json = serde_json::to_vec(&payload)
        .map_err(|error| format!("Could not create the licence request: {error}"))?;
    Ok(LicenseRequest {
        code: format!("{LICENSE_REQUEST_FORMAT}.{}", URL_SAFE_NO_PAD.encode(json)),
        request_id,
        shop_id: identity.shop_id.clone(),
        shop_code: shop_code(&identity.shop_id),
        shop_name: identity.shop_name,
        active_tills,
        created_at,
    })
}

#[tauri::command]
pub async fn create_support_access_request(app: AppHandle) -> Result<SupportAccessRequest, String> {
    let pool = open_local_db(&app).await?;
    let identity = read_identity(&pool).await?;
    let till_id = read_local_setting(&pool, "till_id").await?;
    let till_name = read_local_setting(&pool, "till_name").await?;
    let created_at = Utc::now();
    let expires_at = created_at + Duration::minutes(SUPPORT_REQUEST_MINUTES);
    let mut random = [0_u8; 18];
    OsRng.fill_bytes(&mut random);
    let request_id = format!(
        "supreq_{}_{}",
        shop_code(&identity.shop_id).to_ascii_lowercase(),
        URL_SAFE_NO_PAD.encode(random)
    );
    let payload = SupportAccessRequestPayload {
        version: 1,
        request_id: request_id.clone(),
        shop_id: identity.shop_id.clone(),
        shop_name: identity.shop_name.clone(),
        till_id: till_id.clone(),
        till_name: if till_name.trim().is_empty() {
            "Till 1".into()
        } else {
            till_name.clone()
        },
        created_at: created_at.to_rfc3339(),
        expires_at: expires_at.to_rfc3339(),
    };
    let json = serde_json::to_vec(&payload)
        .map_err(|error| format!("Could not create the support request: {error}"))?;
    let request = PendingSupportRequest {
        request_id: request_id.clone(),
        shop_id: identity.shop_id.clone(),
        created_at,
        expires_at,
    };
    *pending_support_request()
        .lock()
        .map_err(|_| "Could not prepare the one-time support request".to_string())? = Some(request);

    Ok(SupportAccessRequest {
        code: format!("{SUPPORT_REQUEST_FORMAT}.{}", URL_SAFE_NO_PAD.encode(json)),
        request_id,
        shop_id: identity.shop_id.clone(),
        shop_code: shop_code(&identity.shop_id),
        shop_name: identity.shop_name,
        till_id,
        till_name: payload.till_name,
        created_at: payload.created_at,
        expires_at: payload.expires_at,
    })
}

#[tauri::command]
pub async fn activate_support_access(
    app: AppHandle,
    token: String,
) -> Result<SupportSessionGrant, String> {
    let pool = open_local_db(&app).await?;
    let identity = read_identity(&pool).await?;
    let pending = pending_support_request()
        .lock()
        .map_err(|_| "Could not read the one-time support request".to_string())?
        .clone()
        .ok_or_else(|| "Create a new support request on this till first".to_string())?;
    let now = Utc::now();
    let keys = configured_public_keys()?;
    let claims = decode_and_verify_support_token(&token, &identity.shop_id, &pending, now, &keys)?;

    consume_support_request(pending_support_request(), &pending.request_id)?;

    let expires_at = DateTime::parse_from_rfc3339(&claims.expires_at)
        .map_err(|_| "The support-code expiry time is invalid".to_string())?
        .with_timezone(&Utc);
    let seconds_remaining = expires_at.signed_duration_since(now).num_seconds().max(1);
    Ok(SupportSessionGrant {
        session_id: claims.session_id,
        shop_id: claims.shop_id.clone(),
        shop_code: shop_code(&claims.shop_id),
        actor_name: claims.actor_name,
        issued_at: claims.issued_at,
        expires_at: claims.expires_at,
        minutes_remaining: (seconds_remaining + 59) / 60,
    })
}

async fn activate_token(app: &AppHandle, token: String) -> Result<LicenseStatus, String> {
    let token = token.trim().to_string();
    let pool = open_local_db(app).await?;
    let identity = read_identity(&pool).await?;
    let active_tills = active_till_count(&pool).await?;
    let keys = configured_public_keys()?;
    let today = Local::now().date_naive();
    let (claims, _) =
        decode_and_verify_token(&token, &identity.shop_id, active_tills, today, &keys).map_err(
            |failure| match failure {
                ValidationFailure::Missing => "Enter a licence code first".into(),
                ValidationFailure::Invalid(message) => message,
                ValidationFailure::ShopMismatch => {
                    "This licence belongs to a different shop".into()
                }
                ValidationFailure::Expired(_, _) => "This licence has already expired".into(),
                ValidationFailure::TillLimit(claims, _) => format!(
                    "This licence allows {} tills, but {} active tills are registered",
                    claims.max_tills, active_tills
                ),
            },
        )?;

    let installed_claims = verified_claims_from_result(decode_and_verify_token(
        &identity.token,
        &identity.shop_id,
        active_tills,
        today,
        &keys,
    ));
    ensure_not_older_than_installed(&claims, installed_claims.as_ref())?;

    let stamp = Utc::now().to_rfc3339();
    let result = sqlx::query(
        "UPDATE app_identity
         SET licenseId = ?, identitySignature = ?, updatedAt = ?
         WHERE id = ? AND shopId = ?",
    )
    .bind(&claims.license_id)
    .bind(&token)
    .bind(&stamp)
    .bind(APP_IDENTITY_ID)
    .bind(&identity.shop_id)
    .execute(&pool)
    .await
    .map_err(|error| format!("Could not save the licence: {error}"))?;
    if result.rows_affected() != 1 {
        return Err("The shop identity changed while activating the licence".into());
    }
    drop(pool);
    read_status(app).await
}

#[tauri::command]
pub async fn activate_manual_license(
    app: AppHandle,
    token: String,
) -> Result<LicenseStatus, String> {
    activate_token(&app, token).await
}

#[derive(Deserialize)]
struct LicenseFile {
    token: String,
}

#[tauri::command]
pub async fn activate_manual_license_file(
    app: AppHandle,
    path: String,
) -> Result<LicenseStatus, String> {
    let path = PathBuf::from(path);
    let metadata =
        fs::metadata(&path).map_err(|error| format!("Could not open the licence file: {error}"))?;
    if metadata.len() as usize > MAX_LICENSE_BYTES {
        return Err("The licence file is too large".into());
    }
    let contents = fs::read_to_string(&path)
        .map_err(|error| format!("Could not read the licence file: {error}"))?;
    let token = if contents.trim_start().starts_with('{') {
        serde_json::from_str::<LicenseFile>(&contents)
            .map_err(|_| "The licence file is invalid".to_string())?
            .token
    } else {
        contents
    };
    activate_token(&app, token).await
}

pub async fn require_sale_access(app: &AppHandle) -> Result<(), String> {
    if !enforcement_enabled() {
        return Ok(());
    }
    let status = read_status(app).await?;
    if status.access_allowed {
        Ok(())
    } else {
        Err(format!(
            "SALE_LICENSE_REQUIRED: {}. Open Settings > Licence.",
            status.message
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn test_keys() -> (SigningKey, HashMap<String, VerifyingKey>) {
        let signing = SigningKey::from_bytes(&[7_u8; 32]);
        let mut keys = HashMap::new();
        keys.insert("test-2026".into(), signing.verifying_key());
        (signing, keys)
    }

    fn token_for(signing: &SigningKey, claims: &LicenseClaims) -> String {
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).unwrap());
        let message = format!("{LICENSE_FORMAT}.test-2026.{payload}");
        let signature = signing.sign(message.as_bytes());
        format!("{message}.{}", URL_SAFE_NO_PAD.encode(signature.to_bytes()))
    }

    fn support_token_for(signing: &SigningKey, claims: &SupportAccessClaims) -> String {
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).unwrap());
        let message = format!("{SUPPORT_TOKEN_FORMAT}.test-2026.{payload}");
        let signature = signing.sign(message.as_bytes());
        format!("{message}.{}", URL_SAFE_NO_PAD.encode(signature.to_bytes()))
    }

    fn claims() -> LicenseClaims {
        LicenseClaims {
            version: 1,
            license_id: "lic_test_001".into(),
            shop_id: "shop_12345678-abcd".into(),
            customer_name: "Test Shop".into(),
            issued_at: "2026-07-19T12:00:00Z".into(),
            expires_on: "2027-07-19".into(),
            max_tills: 2,
            features: vec!["pos".into()],
        }
    }

    fn support_claims() -> SupportAccessClaims {
        SupportAccessClaims {
            version: 1,
            session_id: "sup_12345678_abcd1234".into(),
            request_id: "supreq_12345678_randomchallenge".into(),
            shop_id: "shop_12345678-abcd".into(),
            issued_at: "2026-07-22T10:05:00Z".into(),
            expires_at: "2026-07-22T10:35:00Z".into(),
            actor_name: "L&Bj Support".into(),
            scope: "full_support".into(),
        }
    }

    fn pending_support() -> PendingSupportRequest {
        PendingSupportRequest {
            request_id: "supreq_12345678_randomchallenge".into(),
            shop_id: "shop_12345678-abcd".into(),
            created_at: utc("2026-07-22T10:00:00Z"),
            expires_at: utc("2026-07-22T10:10:00Z"),
        }
    }

    fn identity(token: String, created_at: &str) -> IdentityRecord {
        IdentityRecord {
            shop_id: "shop_12345678-abcd".into(),
            shop_name: "Test Shop".into(),
            license_id: String::new(),
            token,
            created_at: created_at.into(),
        }
    }

    fn utc(value: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(value)
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn accepts_a_valid_shop_bound_support_code() {
        let (signing, keys) = test_keys();
        let claims = support_claims();
        let token = support_token_for(&signing, &claims);
        let verified = decode_and_verify_support_token(
            &token,
            &claims.shop_id,
            &pending_support(),
            utc("2026-07-22T10:06:00Z"),
            &keys,
        )
        .unwrap();

        assert_eq!(verified, claims);
    }

    #[test]
    fn rejects_support_code_for_another_request_or_shop() {
        let (signing, keys) = test_keys();
        let claims = support_claims();
        let token = support_token_for(&signing, &claims);
        let mut older_request = pending_support();
        older_request.request_id = "supreq_12345678_replaced".into();

        assert!(decode_and_verify_support_token(
            &token,
            &claims.shop_id,
            &older_request,
            utc("2026-07-22T10:06:00Z"),
            &keys,
        )
        .unwrap_err()
        .contains("older request"));
        assert!(decode_and_verify_support_token(
            &token,
            "shop_other",
            &pending_support(),
            utc("2026-07-22T10:06:00Z"),
            &keys,
        )
        .unwrap_err()
        .contains("different shop"));
    }

    #[test]
    fn rejects_expired_or_overlong_support_codes() {
        let (signing, keys) = test_keys();
        let mut claims = support_claims();
        let expired = support_token_for(&signing, &claims);
        assert!(decode_and_verify_support_token(
            &expired,
            &claims.shop_id,
            &pending_support(),
            utc("2026-07-22T10:36:00Z"),
            &keys,
        )
        .is_err());

        claims.expires_at = "2026-07-22T11:05:00Z".into();
        let overlong = support_token_for(&signing, &claims);
        assert!(decode_and_verify_support_token(
            &overlong,
            &claims.shop_id,
            &pending_support(),
            utc("2026-07-22T10:06:00Z"),
            &keys,
        )
        .unwrap_err()
        .contains("lifetime"));
    }

    #[test]
    fn support_request_can_only_be_consumed_once() {
        let slot = Mutex::new(Some(pending_support()));
        assert!(consume_support_request(&slot, "supreq_12345678_randomchallenge").is_ok());
        assert!(consume_support_request(&slot, "supreq_12345678_randomchallenge").is_err());
    }

    #[test]
    fn missing_license_starts_a_ten_day_trial() {
        let status = status_for_token(
            &identity(String::new(), "2026-07-19T10:00:00Z"),
            1,
            utc("2026-07-19T10:00:00Z"),
            &HashMap::new(),
        );

        assert_eq!(status.state, "trial");
        assert_eq!(status.days_remaining, Some(10));
        assert_eq!(status.expires_on, "2026-07-29");
        assert!(status.access_allowed);
        assert!(status.is_trial);
    }

    #[test]
    fn trial_ends_after_ten_complete_days() {
        let identity = identity(String::new(), "2026-07-19T10:00:00Z");
        let just_before =
            status_for_token(&identity, 1, utc("2026-07-29T09:59:59Z"), &HashMap::new());
        let ended = status_for_token(&identity, 1, utc("2026-07-29T10:00:00Z"), &HashMap::new());

        assert_eq!(just_before.state, "trial");
        assert_eq!(just_before.days_remaining, Some(1));
        assert_eq!(ended.state, "trial_expired");
        assert_eq!(ended.days_remaining, Some(0));
        assert_eq!(ended.access_allowed, !enforcement_enabled());
    }

    #[test]
    fn paid_license_warns_from_seven_days_before_expiry() {
        let (signing, keys) = test_keys();
        let token = token_for(&signing, &claims());
        let identity = identity(token, "2026-07-19T10:00:00Z");

        let eight_days = status_for_token(&identity, 1, utc("2027-07-11T10:00:00Z"), &keys);
        let seven_days = status_for_token(&identity, 1, utc("2027-07-12T10:00:00Z"), &keys);
        let one_day = status_for_token(&identity, 1, utc("2027-07-18T10:00:00Z"), &keys);

        assert_eq!(eight_days.state, "active");
        assert_eq!(eight_days.days_remaining, Some(8));
        assert_eq!(seven_days.state, "expiring");
        assert_eq!(seven_days.days_remaining, Some(7));
        assert_eq!(one_day.message, "Licence expires in 1 day");
    }

    #[test]
    fn accepts_a_valid_shop_license() {
        let (signing, keys) = test_keys();
        let claims = claims();
        let token = token_for(&signing, &claims);
        let (verified, remaining) = decode_and_verify_token(
            &token,
            &claims.shop_id,
            2,
            NaiveDate::from_ymd_opt(2026, 7, 19).unwrap(),
            &keys,
        )
        .unwrap();
        assert_eq!(verified, claims);
        assert_eq!(remaining, 365);
    }

    #[test]
    fn accepts_a_real_cloud_kms_signature() {
        const TOKEN: &str = "LBJ1.lbj-cloud-2026-07.eyJ2IjoxLCJsaWNlbnNlSWQiOiJsaWNfY2xvdWRfZml4dHVyZV8wMDEiLCJzaG9wSWQiOiJzaG9wX2Nsb3VkZml4dHVyZSIsImN1c3RvbWVyTmFtZSI6IkNsb3VkIEZpeHR1cmUgU2hvcCIsImlzc3VlZEF0IjoiMjAyNi0wNy0yMFQxMjowMDowMC4wMDBaIiwiZXhwaXJlc09uIjoiMjA5OS0xMi0zMSIsIm1heFRpbGxzIjoyLCJmZWF0dXJlcyI6WyJwb3MiXX0.SB54piDCwRkLtruLbFjNoYjOg0GBrr18v8bKEaT6P6GUMpJLbtuT20ElT7WKtnVvVXqIjbyrzuAa7seUCd3IAg";
        let keys = configured_public_keys().unwrap();
        let (claims, _) = decode_and_verify_token(
            TOKEN,
            "shop_cloudfixture",
            2,
            NaiveDate::from_ymd_opt(2026, 7, 20).unwrap(),
            &keys,
        )
        .unwrap();

        assert_eq!(claims.license_id, "lic_cloud_fixture_001");
        assert_eq!(claims.max_tills, 2);
    }

    #[test]
    fn rejects_a_tampered_payload() {
        let (signing, keys) = test_keys();
        let claims = claims();
        let token = token_for(&signing, &claims);
        let tampered = token.replacen("LBJ1", "LBJ1", 1) + "x";
        assert!(matches!(
            decode_and_verify_token(
                &tampered,
                &claims.shop_id,
                1,
                NaiveDate::from_ymd_opt(2026, 7, 19).unwrap(),
                &keys,
            ),
            Err(ValidationFailure::Invalid(_))
        ));
    }

    #[test]
    fn rejects_a_license_for_another_shop() {
        let (signing, keys) = test_keys();
        let token = token_for(&signing, &claims());
        assert!(matches!(
            decode_and_verify_token(
                &token,
                "shop_other",
                1,
                NaiveDate::from_ymd_opt(2026, 7, 19).unwrap(),
                &keys,
            ),
            Err(ValidationFailure::ShopMismatch)
        ));
    }

    #[test]
    fn expiry_date_is_the_first_blocked_day() {
        let (signing, keys) = test_keys();
        let claims = claims();
        let token = token_for(&signing, &claims);
        assert!(decode_and_verify_token(
            &token,
            &claims.shop_id,
            1,
            NaiveDate::from_ymd_opt(2027, 7, 18).unwrap(),
            &keys,
        )
        .is_ok());
        assert!(matches!(
            decode_and_verify_token(
                &token,
                &claims.shop_id,
                1,
                NaiveDate::from_ymd_opt(2027, 7, 19).unwrap(),
                &keys,
            ),
            Err(ValidationFailure::Expired(_, 0))
        ));
    }

    #[test]
    fn paid_expiry_uses_the_supplied_local_calendar_date() {
        let (signing, keys) = test_keys();
        let token = token_for(&signing, &claims());
        let status = status_for_token_on_date(
            &identity(token, "2026-07-19T10:00:00Z"),
            1,
            utc("2027-07-18T23:30:00Z"),
            NaiveDate::from_ymd_opt(2027, 7, 19).unwrap(),
            &keys,
        );

        assert_eq!(status.state, "expired");
        assert_eq!(status.days_remaining, Some(0));
        assert_eq!(status.access_allowed, !enforcement_enabled());
    }

    #[test]
    fn enforces_the_till_allowance() {
        let (signing, keys) = test_keys();
        let claims = claims();
        let token = token_for(&signing, &claims);
        assert!(matches!(
            decode_and_verify_token(
                &token,
                &claims.shop_id,
                3,
                NaiveDate::from_ymd_opt(2026, 7, 19).unwrap(),
                &keys,
            ),
            Err(ValidationFailure::TillLimit(_, _))
        ));
    }

    #[test]
    fn rejects_a_license_without_pos_sales() {
        let (signing, keys) = test_keys();
        let mut claims = claims();
        claims.features = vec!["reports".into()];
        let token = token_for(&signing, &claims);

        assert!(matches!(
            decode_and_verify_token(
                &token,
                &claims.shop_id,
                1,
                NaiveDate::from_ymd_opt(2026, 7, 19).unwrap(),
                &keys,
            ),
            Err(ValidationFailure::Invalid(message))
                if message == "This licence does not include POS sales"
        ));
    }

    #[test]
    fn older_license_cannot_replace_a_newer_installed_license() {
        let installed = claims();
        let mut older = claims();
        older.license_id = "lic_test_older".into();
        older.issued_at = "2026-07-18T12:00:00Z".into();

        assert!(ensure_not_older_than_installed(&older, Some(&installed)).is_err());

        let mut same_license = older;
        same_license.license_id = installed.license_id.clone();
        assert!(ensure_not_older_than_installed(&same_license, Some(&installed)).is_ok());
    }

    #[test]
    fn till_count_ignores_only_known_legacy_placeholders() {
        tauri::async_runtime::block_on(async {
            let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
            sqlx::query(
                "CREATE TABLE registers (
                    id TEXT PRIMARY KEY,
                    name TEXT,
                    isActive INTEGER
                )",
            )
            .execute(&pool)
            .await
            .unwrap();
            for (id, name, active) in [
                ("register-main", "Main Register", 1),
                ("legacy-till", "Main Register", 1),
                ("till-a", "Till 1", 1),
                ("till-b", "Till 2", 1),
                ("retired-till", "Old Till", 0),
            ] {
                sqlx::query("INSERT INTO registers (id, name, isActive) VALUES (?, ?, ?)")
                    .bind(id)
                    .bind(name)
                    .bind(active)
                    .execute(&pool)
                    .await
                    .unwrap();
            }

            assert_eq!(active_till_count(&pool).await.unwrap(), 2);
        });
    }
}
