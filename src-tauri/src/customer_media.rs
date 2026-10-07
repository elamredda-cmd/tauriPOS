use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{fs, io::{Read, Write}, path::Path};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

const MAX_BYTES: u64 = 100 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaFile { id: String, name: String, kind: String }
#[derive(Serialize, Default)]
pub struct ImportResult { files: Vec<MediaFile>, errors: Vec<String> }

fn media_kind(bytes: &[u8], extension: &str) -> Option<&'static str> {
    match extension {
        "jpg" | "jpeg" if bytes.starts_with(&[0xff, 0xd8, 0xff]) => Some("image"),
        "png" if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => Some("image"),
        "webp" if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") => Some("image"),
        "mp4" if bytes.get(4..8) == Some(b"ftyp") => Some("video"),
        _ => None,
    }
}

fn import_file(source: &Path, directory: &Path) -> Result<MediaFile, String> {
    let name = source.file_name().ok_or("Invalid file name")?.to_string_lossy().to_string();
    let extension = source.extension().unwrap_or_default().to_string_lossy().to_ascii_lowercase();
    let file = fs::File::open(source).map_err(|e| e.to_string())?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() { return Err("Choose a regular media file".into()); }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BYTES { return Err("Maximum file size is 100 MB".into()); }
    let kind = media_kind(&bytes, &extension).ok_or("Use JPG, PNG, WebP or MP4 media")?;
    if kind == "image" && bytes.len() > 10 * 1024 * 1024 { return Err("Pictures must be 10 MB or smaller".into()); }
    let id = format!("{:x}.{}", Sha256::digest(&bytes), extension);
    let target = directory.join(&id);
    // Content-addressed names keep duplicate imports small; never overwrite files.
    match fs::OpenOptions::new().write(true).create_new(true).open(&target) {
        Ok(mut output) => {
            if let Err(error) = output.write_all(&bytes).and_then(|_| output.sync_all()) {
                let _ = fs::remove_file(&target);
                return Err(error.to_string());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.to_string()),
    }
    Ok(MediaFile { id, name, kind: kind.into() })
}

#[tauri::command]
pub async fn import_customer_display_media(app: tauri::AppHandle) -> Result<ImportResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let selected = app.dialog().file().set_title("Add customer display pictures or videos")
            .add_filter("Pictures and short videos", &["jpg", "jpeg", "png", "webp", "mp4"])
            .blocking_pick_files();
        let mut result = ImportResult::default();
        let Some(files) = selected else { return Ok(result); };
        if files.len() > 24 { return Err("Choose up to 24 files at a time".into()); }
        let directory = app.path().app_data_dir().map_err(|e| e.to_string())?.join("customer-display-media");
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        for file in files {
            match file.into_path() {
                Ok(path) => match import_file(&path, &directory) {
                    Ok(media) => result.files.push(media),
                    Err(error) => result.errors.push(format!("{}: {error}", path.file_name().unwrap_or_default().to_string_lossy())),
                },
                Err(error) => result.errors.push(error.to_string()),
            }
        }
        Ok(result)
    }).await.map_err(|e| e.to_string())?
}

fn valid_media_id(id: &str) -> bool {
    let Some((hash, ext)) = id.split_once('.') else { return false; };
    hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit())
        && matches!(ext, "jpg" | "jpeg" | "png" | "webp" | "mp4")
}

#[tauri::command]
pub async fn remove_customer_display_media(app: tauri::AppHandle, id: String) -> Result<(), String> {
    if !valid_media_id(&id) { return Err("Invalid media identifier".into()); }
    let path = app.path().app_data_dir().map_err(|e| e.to_string())?.join("customer-display-media").join(id);
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn media_access_is_limited_to_generated_names() {
        assert!(valid_media_id(&format!("{}.mp4", "a".repeat(64))));
        for id in ["../pos.db", "/tmp/video.mp4", "file.svg", "abc.mp4", "../foo/abc.png"] {
            assert!(!valid_media_id(id));
        }
    }
    #[test]
    fn checks_content_as_well_as_extension() {
        assert_eq!(media_kind(b"\x89PNG\r\n\x1a\nrest", "png"), Some("image"));
        assert_eq!(media_kind(b"<svg onload='alert(1)'>", "png"), None);
        assert_eq!(media_kind(b"\0\0\0\x20ftypisom", "mp4"), Some("video"));
    }
}
