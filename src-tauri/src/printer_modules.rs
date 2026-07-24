use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};
use tauri::{AppHandle, Manager};
use wait_timeout::ChildExt;
use zip::ZipArchive;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const MODULE_API_VERSION: u32 = 1;
const MODULE_SCHEMA_VERSION: u32 = 1;
const MAX_PACKAGE_BYTES: u64 = 200 * 1024 * 1024;
const MAX_RESPONSE_BYTES: u64 = 1024 * 1024;
const SIGNATURE_DOMAIN: &[u8] = b"LBJ-PRINTER-MODULE-V1\n";
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);
static MODULE_QUEUES: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrinterModuleFile {
    pub path: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrinterModuleManifest {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub vendor: String,
    pub version: String,
    pub api_version: u32,
    pub executable: String,
    #[serde(default)]
    pub supported_os: Vec<String>,
    #[serde(default)]
    pub supported_arch: Vec<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    pub files: Vec<PrinterModuleFile>,
    pub key_id: String,
    pub signature: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SignedPrinterModuleManifest<'a> {
    schema_version: u32,
    id: &'a str,
    name: &'a str,
    vendor: &'a str,
    version: &'a str,
    api_version: u32,
    executable: &'a str,
    supported_os: &'a [String],
    supported_arch: &'a [String],
    capabilities: &'a [String],
    files: Vec<PrinterModuleFile>,
    key_id: &'a str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterModuleInfo {
    id: String,
    name: String,
    vendor: String,
    version: String,
    api_version: u32,
    capabilities: Vec<String>,
    enabled: bool,
    compatible: bool,
    trusted: bool,
    status: String,
}

fn module_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Could not find the local application-data folder: {error}"))?
        .join("printer-modules");
    fs::create_dir_all(&root)
        .map_err(|error| format!("Could not create the printer-module folder: {error}"))?;
    Ok(root)
}

fn valid_module_id(value: &str) -> bool {
    if value.is_empty() || value.len() > 64 {
        return false;
    }
    let bytes = value.as_bytes();
    if !bytes.first().is_some_and(u8::is_ascii_alphanumeric)
        || !bytes.last().is_some_and(u8::is_ascii_alphanumeric)
        || !bytes.iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'.')
        })
    {
        return false;
    }

    let windows_stem = value
        .split('.')
        .next()
        .unwrap_or(value)
        .to_ascii_uppercase();
    !matches!(windows_stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        && !(windows_stem.len() == 4
            && (windows_stem.starts_with("COM") || windows_stem.starts_with("LPT"))
            && matches!(windows_stem.as_bytes()[3], b'1'..=b'9'))
}

fn safe_relative_path(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if value.trim().is_empty() || value.contains('\\') || path.is_absolute() {
        return Err("Module file paths must be relative".into());
    }
    if !path
        .components()
        .all(|component| matches!(component, Component::Normal(_)))
    {
        return Err(format!("Unsafe module file path: {value}"));
    }
    Ok(path.to_path_buf())
}

fn configured_public_keys() -> Result<HashMap<String, VerifyingKey>, String> {
    let encoded: HashMap<String, String> =
        serde_json::from_str(include_str!("../printer-module-public-keys.json"))
            .map_err(|error| format!("Printer-module public keys are invalid: {error}"))?;
    let mut keys = HashMap::new();
    for (key_id, value) in encoded {
        let decoded = URL_SAFE_NO_PAD
            .decode(value.trim())
            .map_err(|_| format!("Printer-module public key {key_id} is not valid base64url"))?;
        let bytes: [u8; 32] = decoded
            .try_into()
            .map_err(|_| format!("Printer-module public key {key_id} must contain 32 bytes"))?;
        let key = VerifyingKey::from_bytes(&bytes)
            .map_err(|_| format!("Printer-module public key {key_id} is invalid"))?;
        keys.insert(key_id, key);
    }
    Ok(keys)
}

fn signed_manifest_bytes(manifest: &PrinterModuleManifest) -> Result<Vec<u8>, String> {
    let mut files = manifest.files.clone();
    files.sort_by(|left, right| left.path.cmp(&right.path));
    let signed = SignedPrinterModuleManifest {
        schema_version: manifest.schema_version,
        id: &manifest.id,
        name: &manifest.name,
        vendor: &manifest.vendor,
        version: &manifest.version,
        api_version: manifest.api_version,
        executable: &manifest.executable,
        supported_os: &manifest.supported_os,
        supported_arch: &manifest.supported_arch,
        capabilities: &manifest.capabilities,
        files,
        key_id: &manifest.key_id,
    };
    let mut payload = SIGNATURE_DOMAIN.to_vec();
    payload.extend(
        serde_json::to_vec(&signed)
            .map_err(|error| format!("Could not prepare the module signature payload: {error}"))?,
    );
    Ok(payload)
}

fn verify_manifest_signature(
    manifest: &PrinterModuleManifest,
    keys: &HashMap<String, VerifyingKey>,
) -> Result<(), String> {
    let key = keys
        .get(&manifest.key_id)
        .ok_or_else(|| format!("The module signing key {} is not trusted", manifest.key_id))?;
    let signature_bytes = URL_SAFE_NO_PAD
        .decode(manifest.signature.trim())
        .map_err(|_| "The printer-module signature is damaged".to_string())?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| "The printer-module signature is damaged".to_string())?;
    key.verify(&signed_manifest_bytes(manifest)?, &signature)
        .map_err(|_| "The printer-module signature is not valid".to_string())
}

fn validate_manifest(manifest: &PrinterModuleManifest) -> Result<(), String> {
    if manifest.schema_version != MODULE_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported printer-module schema {}",
            manifest.schema_version
        ));
    }
    if manifest.api_version != MODULE_API_VERSION {
        return Err(format!(
            "This module needs printer API {}, but this POS provides API {}",
            manifest.api_version, MODULE_API_VERSION
        ));
    }
    if !valid_module_id(&manifest.id) {
        return Err("The printer-module ID is invalid".into());
    }
    if manifest.name.trim().is_empty()
        || manifest.vendor.trim().is_empty()
        || manifest.version.trim().is_empty()
    {
        return Err("The module name, vendor, and version are required".into());
    }
    safe_relative_path(&manifest.executable)?;
    if manifest.files.is_empty() || manifest.files.len() > 256 {
        return Err("A printer module must list between 1 and 256 files".into());
    }
    let mut paths = HashSet::new();
    for file in &manifest.files {
        safe_relative_path(&file.path)?;
        if !paths.insert(file.path.clone()) {
            return Err(format!("Duplicate module file: {}", file.path));
        }
        if file.sha256.len() != 64 || !file.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(format!("Invalid SHA-256 for module file {}", file.path));
        }
    }
    if !paths.contains(&manifest.executable) {
        return Err("The module executable must be included in the signed file list".into());
    }
    verify_manifest_signature(manifest, &configured_public_keys()?)
}

fn platform_compatible(manifest: &PrinterModuleManifest) -> bool {
    let current_os = std::env::consts::OS;
    let current_arch = std::env::consts::ARCH;
    (manifest.supported_os.is_empty()
        || manifest
            .supported_os
            .iter()
            .any(|value| value.eq_ignore_ascii_case(current_os)))
        && (manifest.supported_arch.is_empty()
            || manifest
                .supported_arch
                .iter()
                .any(|value| value.eq_ignore_ascii_case(current_arch)))
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut file =
        File::open(path).map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn verify_installed_files(
    directory: &Path,
    manifest: &PrinterModuleManifest,
) -> Result<(), String> {
    let expected = manifest
        .files
        .iter()
        .map(|file| safe_relative_path(&file.path))
        .collect::<Result<HashSet<_>, _>>()?;
    verify_no_unsigned_files(directory, directory, &expected)?;
    for expected in &manifest.files {
        let path = directory.join(safe_relative_path(&expected.path)?);
        let actual = hash_file(&path)?;
        if !actual.eq_ignore_ascii_case(&expected.sha256) {
            return Err(format!(
                "Module file {} was changed or damaged",
                expected.path
            ));
        }
    }
    Ok(())
}

fn verify_no_unsigned_files(
    root: &Path,
    directory: &Path,
    expected: &HashSet<PathBuf>,
) -> Result<(), String> {
    for entry in fs::read_dir(directory)
        .map_err(|error| format!("Could not inspect installed module files: {error}"))?
    {
        let entry = entry.map_err(|error| format!("Could not inspect a module file: {error}"))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;
        if file_type.is_symlink() {
            return Err(format!(
                "Printer module contains an unsupported symbolic link: {}",
                path.display()
            ));
        }
        if file_type.is_dir() {
            verify_no_unsigned_files(root, &path, expected)?;
            continue;
        }
        if !file_type.is_file() {
            return Err(format!(
                "Printer module contains an unsupported file: {}",
                path.display()
            ));
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "Could not resolve an installed module file".to_string())?;
        if relative == Path::new("manifest.json") || relative == Path::new(".disabled") {
            continue;
        }
        if !expected.contains(relative) {
            return Err(format!(
                "Unsigned extra file in installed printer module: {}",
                relative.display()
            ));
        }
    }
    Ok(())
}

fn read_installed_manifest(directory: &Path) -> Result<PrinterModuleManifest, String> {
    let bytes = fs::read(directory.join("manifest.json"))
        .map_err(|error| format!("Could not read the module manifest: {error}"))?;
    let manifest: PrinterModuleManifest = serde_json::from_slice(&bytes)
        .map_err(|error| format!("The module manifest is invalid: {error}"))?;
    validate_manifest(&manifest)?;
    verify_installed_files(directory, &manifest)?;
    Ok(manifest)
}

fn module_info(directory: &Path, manifest: PrinterModuleManifest) -> PrinterModuleInfo {
    let compatible = platform_compatible(&manifest);
    let enabled = compatible && !directory.join(".disabled").exists();
    PrinterModuleInfo {
        id: manifest.id,
        name: manifest.name,
        vendor: manifest.vendor,
        version: manifest.version,
        api_version: manifest.api_version,
        capabilities: manifest.capabilities,
        enabled,
        compatible,
        trusted: true,
        status: if compatible {
            if enabled {
                "Ready"
            } else {
                "Disabled"
            }
        } else {
            "Not compatible with this till"
        }
        .into(),
    }
}

#[tauri::command]
pub fn list_printer_modules(app: AppHandle) -> Result<Vec<PrinterModuleInfo>, String> {
    let root = module_root(&app)?;
    let mut modules = Vec::new();
    for entry in fs::read_dir(&root)
        .map_err(|error| format!("Could not read installed printer modules: {error}"))?
        .flatten()
    {
        let directory = entry.path();
        if !directory.is_dir() || entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        match read_installed_manifest(&directory) {
            Ok(manifest) => modules.push(module_info(&directory, manifest)),
            Err(error) => modules.push(PrinterModuleInfo {
                id: entry.file_name().to_string_lossy().to_string(),
                name: "Invalid printer module".into(),
                vendor: "Unknown".into(),
                version: "-".into(),
                api_version: 0,
                capabilities: Vec::new(),
                enabled: false,
                compatible: false,
                trusted: false,
                status: error,
            }),
        }
    }
    modules.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(modules)
}

fn read_package_manifest(archive: &mut ZipArchive<File>) -> Result<PrinterModuleManifest, String> {
    let mut entry = archive
        .by_name("manifest.json")
        .map_err(|_| "The printer-module package has no manifest.json".to_string())?;
    if entry.size() > 256 * 1024 {
        return Err("The printer-module manifest is too large".into());
    }
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read the module manifest: {error}"))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("The printer-module manifest is invalid: {error}"))
}

fn extract_verified_package(
    package_path: &Path,
    staging: &Path,
) -> Result<PrinterModuleManifest, String> {
    let package = File::open(package_path)
        .map_err(|error| format!("Could not open the printer-module package: {error}"))?;
    let metadata = package
        .metadata()
        .map_err(|error| format!("Could not inspect the printer-module package: {error}"))?;
    if metadata.len() > MAX_PACKAGE_BYTES {
        return Err("The printer-module package is larger than 200 MB".into());
    }
    let mut archive = ZipArchive::new(package).map_err(|error| {
        format!("The printer-module package is not a valid ZIP archive: {error}")
    })?;
    let manifest = read_package_manifest(&mut archive)?;
    validate_manifest(&manifest)?;
    if !platform_compatible(&manifest) {
        return Err(format!(
            "This module does not support {} / {}",
            std::env::consts::OS,
            std::env::consts::ARCH
        ));
    }

    let expected: HashSet<&str> = manifest
        .files
        .iter()
        .map(|file| file.path.as_str())
        .collect();
    let mut seen = HashSet::new();
    let mut total_uncompressed = 0u64;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("Could not inspect the module package: {error}"))?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().to_string();
        safe_relative_path(&name)?;
        if name == "manifest.json" {
            continue;
        }
        if !expected.contains(name.as_str()) {
            return Err(format!("Unsigned extra file in module package: {name}"));
        }
        if !seen.insert(name.clone()) {
            return Err(format!("Duplicate file in module package: {name}"));
        }
        total_uncompressed = total_uncompressed.saturating_add(entry.size());
        if total_uncompressed > MAX_PACKAGE_BYTES {
            return Err("The extracted printer module would be larger than 200 MB".into());
        }
    }
    if seen.len() != expected.len() {
        return Err("The printer-module package is missing one or more signed files".into());
    }

    fs::create_dir_all(staging)
        .map_err(|error| format!("Could not prepare module installation: {error}"))?;
    fs::write(
        staging.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest)
            .map_err(|error| format!("Could not store the module manifest: {error}"))?,
    )
    .map_err(|error| format!("Could not store the module manifest: {error}"))?;

    for expected_file in &manifest.files {
        let relative = safe_relative_path(&expected_file.path)?;
        let mut source = archive
            .by_name(&expected_file.path)
            .map_err(|_| format!("Missing module file {}", expected_file.path))?;
        let destination = staging.join(relative);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Could not create module folder: {error}"))?;
        }
        let mut output = File::create(&destination).map_err(|error| {
            format!(
                "Could not install module file {}: {error}",
                expected_file.path
            )
        })?;
        let mut hasher = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let read = source
                .read(&mut buffer)
                .map_err(|error| format!("Could not unpack {}: {error}", expected_file.path))?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
            output
                .write_all(&buffer[..read])
                .map_err(|error| format!("Could not install {}: {error}", expected_file.path))?;
        }
        let actual = format!("{:x}", hasher.finalize());
        if !actual.eq_ignore_ascii_case(&expected_file.sha256) {
            return Err(format!(
                "Module file {} failed its SHA-256 check",
                expected_file.path
            ));
        }
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let executable = staging.join(safe_relative_path(&manifest.executable)?);
        let mut permissions = fs::metadata(&executable)
            .map_err(|error| format!("Could not inspect module executable: {error}"))?
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(executable, permissions)
            .map_err(|error| format!("Could not make the module executable: {error}"))?;
    }

    verify_installed_files(staging, &manifest)?;
    Ok(manifest)
}

#[tauri::command]
pub async fn install_printer_module(
    app: AppHandle,
    package_path: String,
) -> Result<PrinterModuleInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let package_path = PathBuf::from(package_path.trim());
        if package_path.extension().and_then(|value| value.to_str()) != Some("lbjprinter") {
            return Err("Choose a signed .lbjprinter package".into());
        }
        let root = module_root(&app)?;
        let staging = root.join(format!(
            ".staging-{}-{}",
            std::process::id(),
            NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed)
        ));
        if staging.exists() {
            fs::remove_dir_all(&staging)
                .map_err(|error| format!("Could not clear an old staging folder: {error}"))?;
        }
        let install_result = extract_verified_package(&package_path, &staging);
        let manifest = match install_result {
            Ok(manifest) => manifest,
            Err(error) => {
                let _ = fs::remove_dir_all(&staging);
                return Err(error);
            }
        };
        let queue = module_queue(&manifest.id)?;
        let _guard = queue
            .lock()
            .map_err(|_| "The printer-module queue is unavailable".to_string())?;
        let target = root.join(&manifest.id);
        let backup = root.join(format!(".backup-{}", manifest.id));
        let was_disabled = target.join(".disabled").exists();
        if backup.exists() {
            fs::remove_dir_all(&backup)
                .map_err(|error| format!("Could not clear an old module backup: {error}"))?;
        }
        if target.exists() {
            fs::rename(&target, &backup).map_err(|error| {
                format!("Could not prepare the existing module for update: {error}")
            })?;
        }
        if let Err(error) = fs::rename(&staging, &target) {
            if backup.exists() {
                let _ = fs::rename(&backup, &target);
            }
            return Err(format!("Could not install the printer module: {error}"));
        }
        if was_disabled && fs::write(target.join(".disabled"), b"disabled").is_err() {
            let _ = fs::remove_dir_all(&target);
            if backup.exists() {
                let _ = fs::rename(&backup, &target);
            }
            return Err(
                "Could not preserve the disabled state; the previous module was restored".into(),
            );
        }
        if backup.exists() {
            let _ = fs::remove_dir_all(&backup);
        }
        Ok(module_info(&target, manifest))
    })
    .await
    .map_err(|error| format!("Printer-module installer failed: {error}"))?
}

fn module_directory(app: &AppHandle, module_id: &str) -> Result<PathBuf, String> {
    if !valid_module_id(module_id) {
        return Err("The printer-module ID is invalid".into());
    }
    Ok(module_root(app)?.join(module_id))
}

#[tauri::command]
pub async fn set_printer_module_enabled(
    app: AppHandle,
    module_id: String,
    enabled: bool,
) -> Result<PrinterModuleInfo, String> {
    let queue = module_queue(&module_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = queue
            .lock()
            .map_err(|_| "The printer-module queue is unavailable".to_string())?;
        let directory = module_directory(&app, &module_id)?;
        let manifest = read_installed_manifest(&directory)?;
        if enabled && !platform_compatible(&manifest) {
            return Err("This printer module is not compatible with this till".into());
        }
        let marker = directory.join(".disabled");
        if enabled {
            if marker.exists() {
                fs::remove_file(&marker)
                    .map_err(|error| format!("Could not enable the printer module: {error}"))?;
            }
        } else {
            fs::write(&marker, b"disabled")
                .map_err(|error| format!("Could not disable the printer module: {error}"))?;
        }
        Ok(module_info(&directory, manifest))
    })
    .await
    .map_err(|error| format!("Printer-module task failed: {error}"))?
}

#[tauri::command]
pub async fn uninstall_printer_module(app: AppHandle, module_id: String) -> Result<(), String> {
    let queue = module_queue(&module_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = queue
            .lock()
            .map_err(|_| "The printer-module queue is unavailable".to_string())?;
        let directory = module_directory(&app, &module_id)?;
        if !directory.exists() {
            return Err("That printer module is not installed".into());
        }
        fs::remove_dir_all(directory)
            .map_err(|error| format!("Could not uninstall the printer module: {error}"))
    })
    .await
    .map_err(|error| format!("Printer-module task failed: {error}"))?
}

fn module_queue(module_id: &str) -> Result<Arc<Mutex<()>>, String> {
    let queues = MODULE_QUEUES.get_or_init(|| Mutex::new(HashMap::new()));
    let mut queues = queues
        .lock()
        .map_err(|_| "The printer-module queue is unavailable".to_string())?;
    Ok(queues
        .entry(module_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone())
}

fn execute_module_blocking(
    app: AppHandle,
    module_id: String,
    operation: String,
    payload: Value,
    timeout_ms: Option<u64>,
) -> Result<Value, String> {
    const OPERATIONS: &[&str] = &[
        "discoverDevices",
        "getCapabilities",
        "printRaw",
        "printReceipt",
        "printLabel",
        "openDrawer",
        "getStatus",
        "cancelJob",
        "healthCheck",
    ];
    if !OPERATIONS.contains(&operation.as_str()) {
        return Err("Unsupported printer-module operation".into());
    }
    let directory = module_directory(&app, &module_id)?;
    let manifest = read_installed_manifest(&directory)?;
    if directory.join(".disabled").exists() {
        return Err("That printer module is disabled".into());
    }
    if !platform_compatible(&manifest) {
        return Err("That printer module is not compatible with this till".into());
    }
    if !matches!(operation.as_str(), "healthCheck" | "getCapabilities")
        && !manifest
            .capabilities
            .iter()
            .any(|value| value == &operation)
    {
        return Err(format!("The module does not provide {operation}"));
    }

    let executable = directory.join(safe_relative_path(&manifest.executable)?);
    let canonical_directory = directory
        .canonicalize()
        .map_err(|error| format!("Could not resolve the module directory: {error}"))?;
    let canonical_executable = executable
        .canonicalize()
        .map_err(|error| format!("Could not resolve the module executable: {error}"))?;
    if !canonical_executable.starts_with(&canonical_directory) {
        return Err("The module executable resolves outside its installation folder".into());
    }

    let request_id = NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed);
    let request = serde_json::to_vec(&json!({
        "apiVersion": MODULE_API_VERSION,
        "requestId": request_id,
        "operation": operation,
        "payload": payload,
    }))
    .map_err(|error| format!("Could not prepare the printer-module request: {error}"))?;
    if request.len() > 16 * 1024 * 1024 {
        return Err("The printer-module request is too large".into());
    }

    let mut command = Command::new(&canonical_executable);
    command
        .arg("--lbj-printer-module")
        .current_dir(&directory)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start printer module {}: {error}", manifest.name))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not capture printer-module output".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Could not capture printer-module diagnostics".to_string())?;
    let output_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout
            .take(MAX_RESPONSE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let error_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr
            .take(64 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    if let Some(mut stdin) = child.stdin.take() {
        if let Err(error) = stdin
            .write_all(&request)
            .and_then(|_| stdin.write_all(b"\n"))
        {
            let _ = child.kill();
            let _ = child.wait();
            let _ = output_reader.join();
            let _ = error_reader.join();
            return Err(format!(
                "Could not send the job to the printer module: {error}"
            ));
        }
    }

    let timeout = Duration::from_millis(timeout_ms.unwrap_or(15_000).clamp(250, 60_000));
    let status = match child
        .wait_timeout(timeout)
        .map_err(|error| format!("Could not wait for the printer module: {error}"))?
    {
        Some(status) => status,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            let _ = output_reader.join();
            let _ = error_reader.join();
            return Err(format!("Printer module {} timed out", manifest.name));
        }
    };
    let output = output_reader
        .join()
        .map_err(|_| "The printer-module output reader stopped".to_string())?
        .map_err(|error| format!("Could not read the printer-module response: {error}"))?;
    let stderr = error_reader
        .join()
        .map_err(|_| "The printer-module diagnostic reader stopped".to_string())?
        .map_err(|error| format!("Could not read printer-module diagnostics: {error}"))?;
    if output.len() as u64 > MAX_RESPONSE_BYTES {
        return Err("The printer module returned too much data".into());
    }
    if !status.success() {
        let stderr = String::from_utf8_lossy(&stderr);
        let detail = stderr.trim();
        return Err(if detail.is_empty() {
            format!("Printer module {} failed with {status}", manifest.name)
        } else {
            format!("Printer module {} failed: {detail}", manifest.name)
        });
    }
    let response: Value = serde_json::from_slice(&output)
        .map_err(|error| format!("The printer module returned invalid JSON: {error}"))?;
    if response.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(response
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("The printer module rejected the request")
            .to_string());
    }
    Ok(response)
}

#[tauri::command]
pub async fn execute_printer_module(
    app: AppHandle,
    module_id: String,
    operation: String,
    payload: Value,
    timeout_ms: Option<u64>,
) -> Result<Value, String> {
    let queue = module_queue(&module_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = queue
            .lock()
            .map_err(|_| "The printer-module queue is unavailable".to_string())?;
        execute_module_blocking(app, module_id, operation, payload, timeout_ms)
    })
    .await
    .map_err(|error| format!("Printer-module task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn test_manifest(signing: &SigningKey) -> PrinterModuleManifest {
        let mut manifest = PrinterModuleManifest {
            schema_version: 1,
            id: "star-prnt".into(),
            name: "StarPRNT".into(),
            vendor: "L&Bj".into(),
            version: "1.0.0".into(),
            api_version: 1,
            executable: "star-prnt.exe".into(),
            supported_os: vec!["windows".into()],
            supported_arch: vec!["x86_64".into()],
            capabilities: vec!["printRaw".into()],
            files: vec![PrinterModuleFile {
                path: "star-prnt.exe".into(),
                sha256: "0".repeat(64),
            }],
            key_id: "test".into(),
            signature: String::new(),
        };
        manifest.signature = URL_SAFE_NO_PAD.encode(
            signing
                .sign(&signed_manifest_bytes(&manifest).unwrap())
                .to_bytes(),
        );
        manifest
    }

    #[test]
    fn signed_payload_is_stable_when_file_order_changes() {
        let signing = SigningKey::from_bytes(&[7u8; 32]);
        let mut first = test_manifest(&signing);
        first.files.extend([
            PrinterModuleFile {
                path: "vendor.dll".into(),
                sha256: "1".repeat(64),
            },
            PrinterModuleFile {
                path: "STAR-SDK-LICENSE.txt".into(),
                sha256: "2".repeat(64),
            },
        ]);
        let mut second = first.clone();
        second.files.reverse();
        assert_eq!(
            signed_manifest_bytes(&first).unwrap(),
            signed_manifest_bytes(&second).unwrap()
        );

        let payload = String::from_utf8(signed_manifest_bytes(&first).unwrap()).unwrap();
        assert!(
            payload.find("\"path\":\"STAR-SDK-LICENSE.txt\"").unwrap()
                < payload.find("\"path\":\"star-prnt.exe\"").unwrap()
        );
        assert!(
            payload.find("\"path\":\"star-prnt.exe\"").unwrap()
                < payload.find("\"path\":\"vendor.dll\"").unwrap()
        );
    }

    #[test]
    fn verifies_signature_and_rejects_manifest_tampering() {
        let signing = SigningKey::from_bytes(&[9u8; 32]);
        let manifest = test_manifest(&signing);
        let keys = HashMap::from([("test".to_string(), signing.verifying_key())]);
        assert!(verify_manifest_signature(&manifest, &keys).is_ok());

        let mut tampered = manifest;
        tampered.vendor = "Changed vendor".into();
        assert!(verify_manifest_signature(&tampered, &keys).is_err());
    }

    #[test]
    fn rejects_path_traversal() {
        assert!(safe_relative_path("../printer.exe").is_err());
        assert!(safe_relative_path("/tmp/printer.exe").is_err());
        assert!(safe_relative_path("bin/printer.exe").is_ok());
    }

    #[test]
    fn module_ids_are_safe_directory_names() {
        assert!(valid_module_id("star-prnt.v1"));
        assert!(!valid_module_id("Star PRNT"));
        assert!(!valid_module_id("../star"));
        assert!(!valid_module_id("."));
        assert!(!valid_module_id(".."));
        assert!(!valid_module_id(".hidden"));
        assert!(!valid_module_id("con"));
        assert!(!valid_module_id("com1"));
    }

    #[test]
    fn rejects_unsigned_files_added_after_installation() {
        let root = std::env::temp_dir().join(format!(
            "lbj-printer-module-extra-file-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("adapter.bin"), b"signed adapter").unwrap();
        fs::write(root.join("unexpected.dll"), b"not signed").unwrap();
        let expected = HashSet::from([PathBuf::from("adapter.bin")]);
        let result = verify_no_unsigned_files(&root, &root, &expected);
        assert!(result.is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn validates_a_package_created_by_the_javascript_packager_when_supplied() {
        let Ok(package) = std::env::var("LBJ_PRINTER_MODULE_TEST_PACKAGE") else {
            return;
        };
        let file = File::open(package).unwrap();
        let mut archive = ZipArchive::new(file).unwrap();
        let manifest = read_package_manifest(&mut archive).unwrap();
        validate_manifest(&manifest).unwrap();
        assert!(!manifest.files.is_empty());
    }
}
