use keyring::{Entry, Error};
use std::{
    collections::HashMap,
    sync::{Mutex, MutexGuard, OnceLock},
};

const SERVICE_NAME: &str = "com.elamreda.tauri-app";
pub const OWNER_CLOUD_REPORTER_PASSWORD: &str = "owner-cloud-reporter-password";
pub const SUMUP_API_KEY: &str = "sumup-api-key";
pub const SUMUP_AFFILIATE_KEY: &str = "sumup-affiliate-key";
pub const DOJO_API_KEY: &str = "dojo-api-key";

// macOS may ask the user to approve every Keychain read when a development
// binary is rebuilt or is not signed with a stable identity. Keep secrets in
// process memory after the first successful lookup so recurring background
// work (such as owner-cloud heartbeats) does not repeatedly invoke Keychain.
// The operating-system credential store remains the only persistent storage.
static SECRET_CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn secret_cache() -> MutexGuard<'static, HashMap<String, String>> {
    SECRET_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn entry(account: &str) -> Result<Entry, String> {
    Entry::new(SERVICE_NAME, account)
        .map_err(|error| format!("Could not open the system credential store: {error}"))
}

pub fn load(account: &str) -> Result<String, String> {
    let mut cache = secret_cache();
    if let Some(value) = cache.get(account) {
        return Ok(value.clone());
    }

    let value = match entry(account)?.get_password() {
        Ok(value) => value,
        Err(Error::NoEntry) => String::new(),
        Err(error) => {
            return Err(format!(
                "Could not read the system credential store: {error}"
            ))
        }
    };
    cache.insert(account.to_string(), value.clone());
    Ok(value)
}

pub fn save(account: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return delete(account);
    }
    entry(account)?
        .set_password(value)
        .map_err(|error| format!("Could not protect the credential: {error}"))?;
    secret_cache().insert(account.to_string(), value.to_string());
    Ok(())
}

pub fn delete(account: &str) -> Result<(), String> {
    match entry(account)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => {
            // Cache the known absence too. Otherwise a background caller would
            // immediately query the operating-system store again.
            secret_cache().insert(account.to_string(), String::new());
            Ok(())
        }
        Err(error) => Err(format!(
            "Could not remove the protected credential: {error}"
        )),
    }
}

#[tauri::command]
pub fn owner_cloud_get_reporter_secret() -> Result<String, String> {
    load(OWNER_CLOUD_REPORTER_PASSWORD)
}

#[tauri::command]
pub fn owner_cloud_store_reporter_secret(secret: String) -> Result<(), String> {
    save(OWNER_CLOUD_REPORTER_PASSWORD, secret.trim())
}

#[tauri::command]
pub fn owner_cloud_clear_reporter_secret() -> Result<(), String> {
    delete(OWNER_CLOUD_REPORTER_PASSWORD)
}
