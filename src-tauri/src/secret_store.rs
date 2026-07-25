use keyring::{Entry, Error};

const SERVICE_NAME: &str = "com.elamreda.tauri-app";
pub const OWNER_CLOUD_REPORTER_PASSWORD: &str = "owner-cloud-reporter-password";
pub const SUMUP_API_KEY: &str = "sumup-api-key";
pub const SUMUP_AFFILIATE_KEY: &str = "sumup-affiliate-key";
pub const DOJO_API_KEY: &str = "dojo-api-key";

fn entry(account: &str) -> Result<Entry, String> {
    Entry::new(SERVICE_NAME, account)
        .map_err(|error| format!("Could not open the system credential store: {error}"))
}

pub fn load(account: &str) -> Result<String, String> {
    match entry(account)?.get_password() {
        Ok(value) => Ok(value),
        Err(Error::NoEntry) => Ok(String::new()),
        Err(error) => Err(format!(
            "Could not read the system credential store: {error}"
        )),
    }
}

pub fn save(account: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return delete(account);
    }
    entry(account)?
        .set_password(value)
        .map_err(|error| format!("Could not protect the credential: {error}"))
}

pub fn delete(account: &str) -> Result<(), String> {
    match entry(account)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
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
