use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Duration, Local, NaiveDate, Utc};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sqlx::{sqlite::SqlitePoolOptions, Row, SqlitePool};
use std::{collections::HashMap, fs, path::PathBuf};
use tauri::{AppHandle, Manager};

const LICENSE_FORMAT: &str = "LBJ1";
const LICENSE_REQUEST_FORMAT: &str = "LBJREQ1";
const APP_IDENTITY_ID: &str = "main";
const TRIAL_DAYS: i64 = 10;
const EXPIRY_WARNING_DAYS: i64 = 7;
const MAX_LICENSE_BYTES: usize = 16 * 1024;

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

async fn activate_token(app: &AppHandle, token: String) -> Result<LicenseStatus, String> {
    let token = token.trim().to_string();
    let pool = open_local_db(app).await?;
    let identity = read_identity(&pool).await?;
    let active_tills = active_till_count(&pool).await?;
    let keys = configured_public_keys()?;
    let (claims, _) = decode_and_verify_token(
        &token,
        &identity.shop_id,
        active_tills,
        Local::now().date_naive(),
        &keys,
    )
    .map_err(|failure| match failure {
        ValidationFailure::Missing => "Enter a licence code first".into(),
        ValidationFailure::Invalid(message) => message,
        ValidationFailure::ShopMismatch => "This licence belongs to a different shop".into(),
        ValidationFailure::Expired(_, _) => "This licence has already expired".into(),
        ValidationFailure::TillLimit(claims, _) => format!(
            "This licence allows {} tills, but {} active tills are registered",
            claims.max_tills, active_tills
        ),
    })?;

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
