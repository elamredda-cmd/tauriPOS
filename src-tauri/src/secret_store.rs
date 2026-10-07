use fs2::FileExt;
use keyring::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{self, ErrorKind, Write},
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard, OnceLock},
};
use tauri::{AppHandle, Manager};

const SERVICE_NAME: &str = "com.elamreda.tauri-app";
const SECRET_FILE_NAME: &str = "device-secrets.json";
const SECRET_LOCK_FILE_NAME: &str = "device-secrets.lock";
const SECRET_FILE_VERSION: u32 = 1;
const ALLOWED_RELATED_CONFIG_FILES: [&str; 2] = ["sumup.json", "dojo.json"];

pub const OWNER_CLOUD_REPORTER_PASSWORD: &str = "owner-cloud-reporter-password";
pub const SUMUP_API_KEY: &str = "sumup-api-key";
pub const SUMUP_AFFILIATE_KEY: &str = "sumup-affiliate-key";
pub const DOJO_API_KEY: &str = "dojo-api-key";

const KNOWN_ACCOUNTS: [&str; 4] = [
    OWNER_CLOUD_REPORTER_PASSWORD,
    SUMUP_API_KEY,
    SUMUP_AFFILIATE_KEY,
    DOJO_API_KEY,
];

// Normal application work never opens the operating-system credential store.
// The keyring crate is retained temporarily only for migrate_legacy_keychain_once,
// which imports each known legacy entry during startup and records that account
// only after its local atomic write succeeds.

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceSecretFile {
    version: u32,
    #[serde(default)]
    legacy_keychain_automatic_attempted: bool,
    #[serde(default)]
    secrets: BTreeMap<String, String>,
    #[serde(default)]
    legacy_keychain_accounts_checked: BTreeSet<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending_related_config_rollback: Option<PendingRelatedConfigRollback>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviousDeviceSecretState {
    legacy_keychain_automatic_attempted: bool,
    secrets: BTreeMap<String, String>,
    legacy_keychain_accounts_checked: BTreeSet<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingRelatedConfigRollback {
    target_file_name: String,
    description: String,
    previous_related_contents: Option<String>,
    previous_secret_state: PreviousDeviceSecretState,
}

impl Default for DeviceSecretFile {
    fn default() -> Self {
        Self {
            version: SECRET_FILE_VERSION,
            legacy_keychain_automatic_attempted: false,
            secrets: BTreeMap::new(),
            legacy_keychain_accounts_checked: BTreeSet::new(),
            pending_related_config_rollback: None,
        }
    }
}

impl DeviceSecretFile {
    fn state_without_pending_rollback(&self) -> PreviousDeviceSecretState {
        PreviousDeviceSecretState {
            legacy_keychain_automatic_attempted: self.legacy_keychain_automatic_attempted,
            secrets: self.secrets.clone(),
            legacy_keychain_accounts_checked: self.legacy_keychain_accounts_checked.clone(),
        }
    }

    fn restore_previous_state(&mut self, previous: PreviousDeviceSecretState) {
        self.legacy_keychain_automatic_attempted = previous.legacy_keychain_automatic_attempted;
        self.secrets = previous.secrets;
        self.legacy_keychain_accounts_checked = previous.legacy_keychain_accounts_checked;
        self.pending_related_config_rollback = None;
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
struct MigrationSummary {
    imported: usize,
    confirmed_absent: usize,
    already_local: usize,
    already_checked: usize,
    automatic_attempt_skipped: bool,
}

#[derive(Debug)]
enum MigrationFailure {
    LegacyRead(String),
    LocalStorage(String),
}

static SECRET_FILE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn secret_file_lock() -> MutexGuard<'static, ()> {
    SECRET_FILE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn lock_secret_file_across_processes(secret_path: &Path) -> Result<File, String> {
    let directory = secret_path
        .parent()
        .ok_or_else(|| "The device-local credential path has no parent folder".to_string())?;
    let lock_path = directory.join(SECRET_LOCK_FILE_NAME);
    let lock_file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(&lock_path)
        .map_err(|error| format!("Could not open the device credential lock: {error}"))?;
    #[cfg(unix)]
    protect_private_file(&lock_path, "device credential lock")?;
    FileExt::lock_exclusive(&lock_file)
        .map_err(|error| format!("Could not lock the device-local credentials: {error}"))?;
    recover_pending_related_config(secret_path)?;
    Ok(lock_file)
}

fn validate_account(account: &str) -> Result<(), String> {
    if KNOWN_ACCOUNTS.contains(&account) {
        Ok(())
    } else {
        Err("Unknown device-local credential account".into())
    }
}

fn secret_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Could not locate the local settings folder: {error}"))?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create the local settings folder: {error}"))?;
    Ok(directory.join(SECRET_FILE_NAME))
}

fn read_secret_file(path: &Path) -> Result<DeviceSecretFile, String> {
    if !path.exists() {
        return Ok(DeviceSecretFile::default());
    }

    #[cfg(unix)]
    protect_private_file(path, "device-local credentials")?;

    let contents = fs::read(path)
        .map_err(|error| format!("Could not read the device-local credentials: {error}"))?;
    let secret_file: DeviceSecretFile = serde_json::from_slice(&contents)
        .map_err(|error| format!("The device-local credential file is invalid: {error}"))?;
    if secret_file.version != SECRET_FILE_VERSION {
        return Err(format!(
            "The device-local credential file uses unsupported version {}",
            secret_file.version
        ));
    }
    Ok(secret_file)
}

#[cfg(unix)]
fn protect_private_file(path: &Path, description: &str) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("Could not protect the {description}: {error}"))
}

fn write_secret_file(path: &Path, secret_file: &DeviceSecretFile) -> Result<(), String> {
    let contents = serde_json::to_vec_pretty(secret_file)
        .map_err(|error| format!("Could not prepare the device-local credentials: {error}"))?;
    atomic_write_private_file(path, &contents, "device-local credentials")
}

fn create_unique_temporary_file(path: &Path) -> Result<(PathBuf, File), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "The private file path has no parent folder".to_string())?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("private-file");

    for _ in 0..16 {
        let temporary = parent.join(format!(
            ".{file_name}.{}.{}.tmp",
            std::process::id(),
            rand::random::<u64>()
        ));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&temporary) {
            Ok(file) => return Ok((temporary, file)),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Could not create a private temporary file: {error}"
                ))
            }
        }
    }

    Err("Could not allocate a unique private temporary file".into())
}

/// Atomically replaces a private app-config file. Callers that share mutable
/// state across processes must hold their own cross-process lock while calling.
pub(crate) fn atomic_write_private_file(
    path: &Path,
    contents: &[u8],
    description: &str,
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("The {description} path has no parent folder"))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create the {description} folder: {error}"))?;

    let (temporary, mut file) = create_unique_temporary_file(path)?;

    let write_result = (|| -> Result<(), String> {
        #[cfg(unix)]
        protect_private_file(&temporary, description)?;
        file.write_all(&contents)
            .map_err(|error| format!("Could not save the {description}: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Could not finish writing the {description}: {error}"))?;
        drop(file);

        replace_file(&temporary, path)
            .map_err(|error| format!("Could not replace the {description} file: {error}"))?;
        #[cfg(unix)]
        {
            // The temporary file was already 0600; rename preserves its mode.
            // Keep all fallible permission work before the atomic replacement
            // so an Err can never mean "the new generation may be installed".
            let directory = fs::File::open(parent)
                .map_err(|error| format!("Could not open the {description} folder: {error}"))?;
            directory
                .sync_all()
                .map_err(|error| format!("Could not sync the {description} folder: {error}"))?;
        }
        Ok(())
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

#[cfg(unix)]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

fn related_config_target(secret_path: &Path, file_name: &str) -> Result<PathBuf, String> {
    if !ALLOWED_RELATED_CONFIG_FILES.contains(&file_name) {
        return Err("The pending credential transaction has an invalid provider target".into());
    }
    let parent = secret_path
        .parent()
        .ok_or_else(|| "The device-local credential path has no parent folder".to_string())?;
    Ok(parent.join(file_name))
}

fn recover_pending_related_config(secret_path: &Path) -> Result<(), String> {
    let mut secret_file = read_secret_file(secret_path)?;
    let Some(pending) = secret_file.pending_related_config_rollback.clone() else {
        return Ok(());
    };
    let target = related_config_target(secret_path, &pending.target_file_name)?;

    match &pending.previous_related_contents {
        Some(contents) => {
            atomic_write_private_file(&target, contents.as_bytes(), &pending.description)?
        }
        None if target.exists() => {
            fs::remove_file(&target).map_err(|error| {
                format!(
                    "Could not roll back the interrupted {} update: {error}",
                    pending.description
                )
            })?;
            #[cfg(unix)]
            if let Some(parent) = target.parent() {
                let directory = fs::File::open(parent).map_err(|error| {
                    format!("Could not open the {} folder: {error}", pending.description)
                })?;
                directory.sync_all().map_err(|error| {
                    format!("Could not sync the {} folder: {error}", pending.description)
                })?;
            }
        }
        None => {}
    }

    secret_file.restore_previous_state(pending.previous_secret_state);
    write_secret_file(secret_path, &secret_file).map_err(|error| {
        format!("Could not finish rolling back interrupted payment settings: {error}")
    })
}

#[cfg(target_os = "windows")]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(any(unix, target_os = "windows")))]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    if destination.exists() {
        fs::remove_file(destination)?;
    }
    fs::rename(source, destination)
}

fn load_from_path(path: &Path, account: &str) -> Result<String, String> {
    Ok(load_many_from_path(path, &[account])?
        .into_iter()
        .next()
        .unwrap_or_default())
}

fn load_many_from_path(path: &Path, accounts: &[&str]) -> Result<Vec<String>, String> {
    let secret_file = read_secret_file(path)?;
    load_many_from_secret_file(&secret_file, accounts)
}

fn load_many_from_secret_file(
    secret_file: &DeviceSecretFile,
    accounts: &[&str],
) -> Result<Vec<String>, String> {
    for account in accounts {
        validate_account(account)?;
    }
    Ok(accounts
        .iter()
        .map(|account| {
            secret_file
                .secrets
                .get(*account)
                .cloned()
                .unwrap_or_default()
        })
        .collect())
}

pub(crate) struct RelatedConfigMutation<T> {
    pub value: T,
    pub secret_updates: Vec<(String, String)>,
    pub related_config_write: Option<RelatedConfigWrite>,
}

pub(crate) struct RelatedConfigWrite {
    pub path: PathBuf,
    pub contents: Vec<u8>,
    pub description: String,
}

fn save_to_path(path: &Path, account: &str, value: &str) -> Result<(), String> {
    let mut secret_file = read_secret_file(path)?;
    apply_secret_updates(&mut secret_file, &[(account, value)])?;
    write_secret_file(path, &secret_file)
}

fn apply_secret_updates(
    secret_file: &mut DeviceSecretFile,
    updates: &[(&str, &str)],
) -> Result<(), String> {
    for (account, _) in updates {
        validate_account(account)?;
    }

    for (account, value) in updates {
        if value.is_empty() {
            secret_file.secrets.remove(*account);
        } else {
            secret_file
                .secrets
                .insert((*account).to_string(), (*value).to_string());
        }
        // An explicit local save/delete wins over any legacy Keychain value.
        secret_file
            .legacy_keychain_accounts_checked
            .insert((*account).to_string());
    }
    Ok(())
}

fn transaction_error_with_recovery(path: &Path, error: String) -> String {
    match recover_pending_related_config(path) {
        Ok(()) => error,
        Err(recovery_error) => format!(
            "{error}; interrupted payment settings also could not be rolled back: {recovery_error}"
        ),
    }
}

fn mutate_related_config_at_path_with_writer<T, P, W>(
    path: &Path,
    accounts: &[&str],
    prepare: P,
    write_related_config: W,
) -> Result<T, String>
where
    P: FnOnce(Vec<String>) -> Result<RelatedConfigMutation<T>, String>,
    W: FnOnce(&RelatedConfigWrite) -> Result<(), String>,
{
    let original = read_secret_file(path)?;
    let current_values = load_many_from_secret_file(&original, accounts)?;
    let mutation = prepare(current_values)?;
    if mutation.related_config_write.is_none() && !mutation.secret_updates.is_empty() {
        return Err("A secret update requires an atomic related-config write".into());
    }

    let mut updated = original.clone();
    let update_refs = mutation
        .secret_updates
        .iter()
        .map(|(account, value)| (account.as_str(), value.as_str()))
        .collect::<Vec<_>>();
    apply_secret_updates(&mut updated, &update_refs)?;
    let changed = updated != original;
    let Some(related_write) = mutation.related_config_write else {
        return Ok(mutation.value);
    };
    let target_file_name = related_write
        .path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "The provider settings path has no valid file name".to_string())?;
    let expected_target = related_config_target(path, target_file_name)?;
    if expected_target != related_write.path {
        return Err("The provider settings path is outside the local settings folder".into());
    }

    if !changed {
        write_related_config(&related_write)?;
        return Ok(mutation.value);
    }

    let previous_related_contents = if related_write.path.exists() {
        Some(fs::read_to_string(&related_write.path).map_err(|error| {
            format!(
                "Could not prepare rollback for the {}: {error}",
                related_write.description
            )
        })?)
    } else {
        None
    };
    let rollback = PendingRelatedConfigRollback {
        target_file_name: target_file_name.to_string(),
        description: related_write.description.clone(),
        previous_related_contents,
        previous_secret_state: original.state_without_pending_rollback(),
    };

    // First fsync the rollback record while both live files are still old.
    let mut journaled_original = original.clone();
    journaled_original.pending_related_config_rollback = Some(rollback.clone());
    write_secret_file(path, &journaled_original)?;

    // Then install the new secret generation while retaining the durable
    // rollback record. A crash anywhere from here is repaired on next access.
    updated.pending_related_config_rollback = Some(rollback);
    if let Err(error) = write_secret_file(path, &updated) {
        return Err(transaction_error_with_recovery(path, error));
    }
    if let Err(error) = write_related_config(&related_write) {
        return Err(transaction_error_with_recovery(path, error));
    }

    updated.pending_related_config_rollback = None;
    if let Err(error) = write_secret_file(path, &updated) {
        return Err(transaction_error_with_recovery(
            path,
            format!("Could not finalize the payment-settings transaction: {error}"),
        ));
    }
    Ok(mutation.value)
}

fn mutate_related_config_at_path<T, P>(
    path: &Path,
    accounts: &[&str],
    prepare: P,
) -> Result<T, String>
where
    P: FnOnce(Vec<String>) -> Result<RelatedConfigMutation<T>, String>,
{
    mutate_related_config_at_path_with_writer(path, accounts, prepare, |related_write| {
        atomic_write_private_file(
            &related_write.path,
            &related_write.contents,
            &related_write.description,
        )
    })
}

fn migrate_pending_accounts<F>(
    path: &Path,
    mut load_legacy: F,
) -> Result<MigrationSummary, MigrationFailure>
where
    F: FnMut(&str) -> Result<Option<String>, String>,
{
    let mut secret_file = read_secret_file(path).map_err(MigrationFailure::LocalStorage)?;
    let mut summary = MigrationSummary::default();

    for account in KNOWN_ACCOUNTS {
        if secret_file
            .legacy_keychain_accounts_checked
            .contains(account)
        {
            summary.already_checked += 1;
            continue;
        }

        if secret_file
            .secrets
            .get(account)
            .is_some_and(|value| !value.is_empty())
        {
            secret_file
                .legacy_keychain_accounts_checked
                .insert(account.to_string());
            write_secret_file(path, &secret_file).map_err(MigrationFailure::LocalStorage)?;
            summary.already_local += 1;
            continue;
        }

        let legacy_value = load_legacy(account).map_err(|error| {
            MigrationFailure::LegacyRead(format!(
                "Could not import legacy credential '{account}'. No later credential was read, and automatic migration will not retry on a future launch to avoid repeated system password prompts. Re-enter this credential in Settings if needed: {error}"
            ))
        })?;

        match legacy_value.filter(|value| !value.is_empty()) {
            Some(value) => {
                secret_file.secrets.insert(account.to_string(), value);
                summary.imported += 1;
            }
            None => summary.confirmed_absent += 1,
        }
        secret_file
            .legacy_keychain_accounts_checked
            .insert(account.to_string());
        // Commit each account independently. A crash can never mark an entry
        // checked without also committing its imported value (or NoEntry).
        write_secret_file(path, &secret_file).map_err(MigrationFailure::LocalStorage)?;
    }

    Ok(summary)
}

fn migrate_legacy_keychain_automatically_once<F>(
    path: &Path,
    load_legacy: F,
) -> Result<MigrationSummary, String>
where
    F: FnMut(&str) -> Result<Option<String>, String>,
{
    let mut secret_file = read_secret_file(path)?;
    if secret_file.legacy_keychain_automatic_attempted {
        return Ok(MigrationSummary {
            automatic_attempt_skipped: true,
            ..MigrationSummary::default()
        });
    }

    match migrate_pending_accounts(path, load_legacy) {
        Ok(summary) => {
            secret_file = read_secret_file(path)?;
            secret_file.legacy_keychain_automatic_attempted = true;
            write_secret_file(path, &secret_file).map_err(|marker_error| {
                format!(
                    "Legacy credentials were imported, but the one-time migration marker could not be saved: {marker_error}"
                )
            })?;
            Ok(summary)
        }
        Err(MigrationFailure::LegacyRead(migration_error)) => {
            // A handled OS denial gets a durable no-auto-retry marker so the
            // cashier is not prompted every launch.
            secret_file = read_secret_file(path)?;
            secret_file.legacy_keychain_automatic_attempted = true;
            write_secret_file(path, &secret_file).map_err(|marker_error| {
                format!(
                    "{migration_error}; additionally, the one-time migration marker could not be saved, so the system may ask again next launch: {marker_error}"
                )
            })?;
            Err(migration_error)
        }
        Err(MigrationFailure::LocalStorage(local_error)) => {
            // A local disk failure is safe to retry. Do not disable the only
            // remaining automatic recovery path before a durable import.
            Err(local_error)
        }
    }
}

fn load_legacy_keychain(account: &str) -> Result<Option<String>, String> {
    let entry = Entry::new(SERVICE_NAME, account)
        .map_err(|error| format!("could not open the system credential store: {error}"))?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(format!(
            "could not read the system credential store: {error}"
        )),
    }
}

/// One bounded compatibility pass for releases that previously used Keychain
/// or Credential Manager. Normal load/save/delete calls are strictly file-only.
pub fn migrate_legacy_keychain_once(app: &AppHandle) -> Result<(), String> {
    let path = secret_file_path(app)?;
    let _process_guard = secret_file_lock();
    let _cross_process_guard = lock_secret_file_across_processes(&path)?;
    migrate_legacy_keychain_automatically_once(&path, load_legacy_keychain).map(|_| ())
}

pub fn load(app: &AppHandle, account: &str) -> Result<String, String> {
    let path = secret_file_path(app)?;
    let _process_guard = secret_file_lock();
    let _cross_process_guard = lock_secret_file_across_processes(&path)?;
    load_from_path(&path, account)
}

pub fn save(app: &AppHandle, account: &str, value: &str) -> Result<(), String> {
    let path = secret_file_path(app)?;
    let _process_guard = secret_file_lock();
    let _cross_process_guard = lock_secret_file_across_processes(&path)?;
    save_to_path(&path, account, value)
}

pub fn delete(app: &AppHandle, account: &str) -> Result<(), String> {
    save(app, account, "")
}

/// Holds one process-wide and cross-process lock across provider read, secret
/// merge, journal, secret write, and provider write. An interrupted or failed
/// update rolls both files back to their exact previous generation.
pub(crate) fn mutate_related_config<T, P>(
    app: &AppHandle,
    accounts: &[&str],
    prepare: P,
) -> Result<T, String>
where
    P: FnOnce(Vec<String>) -> Result<RelatedConfigMutation<T>, String>,
{
    let path = secret_file_path(app)?;
    let _process_guard = secret_file_lock();
    let _cross_process_guard = lock_secret_file_across_processes(&path)?;
    mutate_related_config_at_path(&path, accounts, prepare)
}

#[tauri::command]
pub fn owner_cloud_get_reporter_secret(app: AppHandle) -> Result<String, String> {
    load(&app, OWNER_CLOUD_REPORTER_PASSWORD)
}

#[tauri::command]
pub fn owner_cloud_store_reporter_secret(app: AppHandle, secret: String) -> Result<(), String> {
    save(&app, OWNER_CLOUD_REPORTER_PASSWORD, &secret)
}

#[tauri::command]
pub fn owner_cloud_clear_reporter_secret(app: AppHandle) -> Result<(), String> {
    delete(&app, OWNER_CLOUD_REPORTER_PASSWORD)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, rc::Rc};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "pos-device-secret-test-{}-{}",
                std::process::id(),
                rand::random::<u64>()
            ));
            fs::create_dir_all(&path).expect("create test directory");
            Self(path)
        }

        fn secret_path(&self) -> PathBuf {
            self.0.join(SECRET_FILE_NAME)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn local_save_load_and_delete_never_need_a_legacy_loader() {
        let directory = TestDirectory::new();
        let path = directory.secret_path();

        save_to_path(&path, OWNER_CLOUD_REPORTER_PASSWORD, "owner-secret").unwrap();
        assert_eq!(
            load_from_path(&path, OWNER_CLOUD_REPORTER_PASSWORD).unwrap(),
            "owner-secret"
        );
        save_to_path(&path, OWNER_CLOUD_REPORTER_PASSWORD, "").unwrap();
        assert!(load_from_path(&path, OWNER_CLOUD_REPORTER_PASSWORD)
            .unwrap()
            .is_empty());

        let stored = read_secret_file(&path).unwrap();
        assert!(stored
            .legacy_keychain_accounts_checked
            .contains(OWNER_CLOUD_REPORTER_PASSWORD));
    }

    #[test]
    fn owner_cloud_password_roundtrip_preserves_whitespace_exactly() {
        let directory = TestDirectory::new();
        let path = directory.secret_path();
        let password = "  owner password with spaces  \n";

        save_to_path(&path, OWNER_CLOUD_REPORTER_PASSWORD, password).unwrap();
        assert_eq!(
            load_from_path(&path, OWNER_CLOUD_REPORTER_PASSWORD).unwrap(),
            password
        );
    }

    #[test]
    fn migration_commits_each_account_and_never_reads_it_twice() {
        let directory = TestDirectory::new();
        let path = directory.secret_path();
        let calls = Rc::new(RefCell::new(Vec::<String>::new()));
        let tracked_calls = Rc::clone(&calls);

        let first = migrate_legacy_keychain_automatically_once(&path, move |account| {
            tracked_calls.borrow_mut().push(account.to_string());
            Ok(match account {
                OWNER_CLOUD_REPORTER_PASSWORD => Some("owner-secret".into()),
                DOJO_API_KEY => Some("dojo-secret".into()),
                _ => None,
            })
        })
        .unwrap();
        assert_eq!(first.imported, 2);
        assert_eq!(first.confirmed_absent, 2);
        assert_eq!(calls.borrow().len(), KNOWN_ACCOUNTS.len());

        let second = migrate_legacy_keychain_automatically_once(&path, |_| {
            panic!("automatic legacy migration must never run twice")
        })
        .unwrap();
        assert!(second.automatic_attempt_skipped);
        assert_eq!(
            load_from_path(&path, OWNER_CLOUD_REPORTER_PASSWORD).unwrap(),
            "owner-secret"
        );
        assert_eq!(load_from_path(&path, DOJO_API_KEY).unwrap(), "dojo-secret");
    }

    #[test]
    fn migration_failure_leaves_current_and_later_accounts_pending() {
        let directory = TestDirectory::new();
        let path = directory.secret_path();

        let error = migrate_legacy_keychain_automatically_once(&path, |account| match account {
            OWNER_CLOUD_REPORTER_PASSWORD => Ok(Some("owner-secret".into())),
            SUMUP_API_KEY => Err("permission denied".into()),
            _ => panic!("migration must stop after the first keychain error"),
        })
        .unwrap_err();
        assert!(error.contains(SUMUP_API_KEY));
        assert!(error.contains("will not retry"));

        let stored = read_secret_file(&path).unwrap();
        assert!(stored.legacy_keychain_automatic_attempted);
        assert_eq!(
            stored.secrets.get(OWNER_CLOUD_REPORTER_PASSWORD),
            Some(&"owner-secret".to_string())
        );
        assert!(stored
            .legacy_keychain_accounts_checked
            .contains(OWNER_CLOUD_REPORTER_PASSWORD));
        assert!(!stored
            .legacy_keychain_accounts_checked
            .contains(SUMUP_API_KEY));
        assert!(!stored
            .legacy_keychain_accounts_checked
            .contains(DOJO_API_KEY));

        let second = migrate_legacy_keychain_automatically_once(&path, |_| {
            panic!("a denied automatic migration must not prompt again")
        })
        .unwrap();
        assert!(second.automatic_attempt_skipped);
    }

    #[test]
    fn interrupted_migration_can_resume_from_per_account_markers() {
        let directory = TestDirectory::new();
        let path = directory.secret_path();

        let interrupted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = migrate_legacy_keychain_automatically_once(&path, |account| match account {
                OWNER_CLOUD_REPORTER_PASSWORD => Ok(Some("owner-secret".into())),
                SUMUP_API_KEY => panic!("simulated process interruption"),
                _ => unreachable!(),
            });
        }));
        assert!(interrupted.is_err());
        let after_interruption = read_secret_file(&path).unwrap();
        assert!(!after_interruption.legacy_keychain_automatic_attempted);
        assert!(after_interruption
            .legacy_keychain_accounts_checked
            .contains(OWNER_CLOUD_REPORTER_PASSWORD));

        let resumed_calls = Rc::new(RefCell::new(Vec::<String>::new()));
        let tracked_calls = Rc::clone(&resumed_calls);
        migrate_legacy_keychain_automatically_once(&path, move |account| {
            tracked_calls.borrow_mut().push(account.to_string());
            Ok(None)
        })
        .unwrap();
        assert!(!resumed_calls
            .borrow()
            .contains(&OWNER_CLOUD_REPORTER_PASSWORD.to_string()));
        assert_eq!(resumed_calls.borrow().len(), KNOWN_ACCOUNTS.len() - 1);
    }

    #[test]
    fn existing_local_value_wins_without_reading_keychain() {
        let directory = TestDirectory::new();
        let path = directory.secret_path();
        let mut stored = DeviceSecretFile::default();
        stored
            .secrets
            .insert(SUMUP_API_KEY.into(), "local-secret".into());
        write_secret_file(&path, &stored).unwrap();

        let summary = migrate_legacy_keychain_automatically_once(&path, |account| {
            if account == SUMUP_API_KEY {
                panic!("an existing local value must not be replaced from keychain");
            }
            Ok(None)
        })
        .unwrap();
        assert_eq!(summary.already_local, 1);
        assert_eq!(
            load_from_path(&path, SUMUP_API_KEY).unwrap(),
            "local-secret"
        );
    }

    #[test]
    fn related_config_failure_rolls_back_a_multi_secret_update() {
        let directory = TestDirectory::new();
        let path = directory.secret_path();
        let provider_path = directory.0.join("sumup.json");
        save_to_path(&path, SUMUP_API_KEY, "old-api").unwrap();
        save_to_path(&path, SUMUP_AFFILIATE_KEY, "old-affiliate").unwrap();
        atomic_write_private_file(&provider_path, b"old-config", "SumUp settings").unwrap();

        let error = mutate_related_config_at_path_with_writer(
            &path,
            &[SUMUP_API_KEY, SUMUP_AFFILIATE_KEY],
            |current| {
                assert_eq!(current, vec!["old-api", "old-affiliate"]);
                Ok(RelatedConfigMutation {
                    value: (),
                    secret_updates: vec![
                        (SUMUP_API_KEY.to_string(), "new-api".to_string()),
                        (SUMUP_AFFILIATE_KEY.to_string(), "new-affiliate".to_string()),
                    ],
                    related_config_write: Some(RelatedConfigWrite {
                        path: provider_path.clone(),
                        contents: b"new-config".to_vec(),
                        description: "SumUp settings".into(),
                    }),
                })
            },
            |_| Err("provider config disk full".into()),
        )
        .unwrap_err();
        assert_eq!(error, "provider config disk full");
        assert_eq!(load_from_path(&path, SUMUP_API_KEY).unwrap(), "old-api");
        assert_eq!(
            load_from_path(&path, SUMUP_AFFILIATE_KEY).unwrap(),
            "old-affiliate"
        );
        assert_eq!(fs::read_to_string(provider_path).unwrap(), "old-config");
    }

    #[test]
    fn related_config_failure_rolls_back_a_secret_clear() {
        let directory = TestDirectory::new();
        let path = directory.secret_path();
        let provider_path = directory.0.join("dojo.json");
        save_to_path(&path, DOJO_API_KEY, "old-dojo").unwrap();
        atomic_write_private_file(&provider_path, b"old-config", "Dojo settings").unwrap();

        mutate_related_config_at_path_with_writer(
            &path,
            &[DOJO_API_KEY],
            |_| {
                Ok(RelatedConfigMutation {
                    value: (),
                    secret_updates: vec![(DOJO_API_KEY.to_string(), String::new())],
                    related_config_write: Some(RelatedConfigWrite {
                        path: provider_path.clone(),
                        contents: b"new-config".to_vec(),
                        description: "Dojo settings".into(),
                    }),
                })
            },
            |_| Err("provider config is read-only".into()),
        )
        .unwrap_err();
        assert_eq!(load_from_path(&path, DOJO_API_KEY).unwrap(), "old-dojo");
        assert_eq!(fs::read_to_string(provider_path).unwrap(), "old-config");
    }

    #[test]
    fn next_lock_recovers_a_crash_between_provider_commit_and_journal_clear() {
        let directory = TestDirectory::new();
        let path = directory.secret_path();
        let provider_path = directory.0.join("sumup.json");
        save_to_path(&path, SUMUP_API_KEY, "old-secret").unwrap();
        atomic_write_private_file(&provider_path, b"old-config", "SumUp settings").unwrap();

        let original = read_secret_file(&path).unwrap();
        let rollback = PendingRelatedConfigRollback {
            target_file_name: "sumup.json".into(),
            description: "SumUp settings".into(),
            previous_related_contents: Some("old-config".into()),
            previous_secret_state: original.state_without_pending_rollback(),
        };
        let mut interrupted = original;
        apply_secret_updates(&mut interrupted, &[(SUMUP_API_KEY, "new-secret")]).unwrap();
        interrupted.pending_related_config_rollback = Some(rollback);
        write_secret_file(&path, &interrupted).unwrap();
        atomic_write_private_file(&provider_path, b"new-config", "SumUp settings").unwrap();

        let recovery_lock = lock_secret_file_across_processes(&path).unwrap();
        drop(recovery_lock);
        assert_eq!(load_from_path(&path, SUMUP_API_KEY).unwrap(), "old-secret");
        assert_eq!(fs::read_to_string(provider_path).unwrap(), "old-config");
        assert!(read_secret_file(&path)
            .unwrap()
            .pending_related_config_rollback
            .is_none());
    }

    #[test]
    fn atomic_writes_do_not_use_a_shared_fixed_temporary_name() {
        let directory = TestDirectory::new();
        let path = directory.secret_path();
        save_to_path(&path, DOJO_API_KEY, "dojo-secret").unwrap();

        let leftovers = fs::read_dir(&directory.0)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(leftovers, 0);
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn cross_process_lock_prevents_a_mixed_provider_and_secret_snapshot() {
        use std::{sync::mpsc, thread, time::Duration};

        let directory = TestDirectory::new();
        let secret_path = directory.secret_path();
        let related_path = directory.0.join("provider.json");
        save_to_path(&secret_path, SUMUP_API_KEY, "old-secret").unwrap();
        atomic_write_private_file(&related_path, b"old-config", "test provider").unwrap();

        let writer_secret_path = secret_path.clone();
        let writer_related_path = related_path.clone();
        let (writer_ready_tx, writer_ready_rx) = mpsc::channel();
        let (finish_writer_tx, finish_writer_rx) = mpsc::channel();
        let writer = thread::spawn(move || {
            let _lock = lock_secret_file_across_processes(&writer_secret_path).unwrap();
            atomic_write_private_file(&writer_related_path, b"new-config", "test provider")
                .unwrap();
            writer_ready_tx.send(()).unwrap();
            finish_writer_rx.recv().unwrap();
            save_to_path(&writer_secret_path, SUMUP_API_KEY, "new-secret").unwrap();
        });
        writer_ready_rx.recv().unwrap();

        let reader_secret_path = secret_path.clone();
        let reader_related_path = related_path.clone();
        let (reader_attempting_tx, reader_attempting_rx) = mpsc::channel();
        let (snapshot_tx, snapshot_rx) = mpsc::channel();
        let reader = thread::spawn(move || {
            reader_attempting_tx.send(()).unwrap();
            let _lock = lock_secret_file_across_processes(&reader_secret_path).unwrap();
            let config = fs::read_to_string(reader_related_path).unwrap();
            let secret = load_from_path(&reader_secret_path, SUMUP_API_KEY).unwrap();
            snapshot_tx.send((config, secret)).unwrap();
        });
        reader_attempting_rx.recv().unwrap();
        assert!(snapshot_rx.recv_timeout(Duration::from_millis(50)).is_err());

        finish_writer_tx.send(()).unwrap();
        assert_eq!(
            snapshot_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            ("new-config".to_string(), "new-secret".to_string())
        );
        writer.join().unwrap();
        reader.join().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn local_write_failure_does_not_disable_crash_recovery() {
        use std::os::unix::fs::PermissionsExt;

        let directory = TestDirectory::new();
        let path = directory.secret_path();
        write_secret_file(&path, &DeviceSecretFile::default()).unwrap();
        fs::set_permissions(&directory.0, fs::Permissions::from_mode(0o500)).unwrap();

        let result =
            migrate_legacy_keychain_automatically_once(&path, |_| Ok(Some("legacy-secret".into())));
        fs::set_permissions(&directory.0, fs::Permissions::from_mode(0o700)).unwrap();

        assert!(result.is_err());
        assert!(
            !read_secret_file(&path)
                .unwrap()
                .legacy_keychain_automatic_attempted
        );
    }

    #[cfg(unix)]
    #[test]
    fn secret_file_is_restricted_to_the_current_user() {
        use std::os::unix::fs::PermissionsExt;

        let directory = TestDirectory::new();
        let path = directory.secret_path();
        save_to_path(&path, DOJO_API_KEY, "dojo-secret").unwrap();
        let mode = fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}
