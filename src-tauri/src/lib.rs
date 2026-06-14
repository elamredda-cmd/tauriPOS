mod commerce;

use std::{
    io::Write,
    net::{TcpStream, ToSocketAddrs},
    time::Duration,
};
use tauri::Manager;

#[cfg(target_os = "windows")]
struct WindowsKeepAwake;

#[cfg(target_os = "windows")]
impl WindowsKeepAwake {
    fn enable() -> Result<Self, String> {
        use windows_sys::Win32::System::Power::{
            SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED,
        };

        let result = unsafe {
            SetThreadExecutionState(ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED)
        };
        if result == 0 {
            Err("Windows rejected the keep-awake request".into())
        } else {
            Ok(Self)
        }
    }
}

#[cfg(target_os = "windows")]
impl Drop for WindowsKeepAwake {
    fn drop(&mut self) {
        use windows_sys::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS};
        unsafe {
            SetThreadExecutionState(ES_CONTINUOUS);
        }
    }
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

fn encode_pos_text(text: &str, encoding: &str) -> Vec<u8> {
    if encoding.eq_ignore_ascii_case("latin1") || encoding.eq_ignore_ascii_case("latin-1") {
        text.chars()
            .map(|ch| {
                let code = ch as u32;
                if code <= 0xff { code as u8 } else { b'?' }
            })
            .collect()
    } else {
        text.as_bytes().to_vec()
    }
}

#[tauri::command]
fn send_cctv_pos_text(
    host: String,
    port: u16,
    text: String,
    timeout_ms: Option<u64>,
    encoding: Option<String>,
) -> Result<(), String> {
    let host = host.trim();
    if host.is_empty() {
        return Err("CCTV host is required".into());
    }
    if port == 0 {
        return Err("CCTV port is required".into());
    }
    if text.trim().is_empty() {
        return Err("CCTV message is empty".into());
    }
    if text.len() > 16_000 {
        return Err("CCTV message is too long".into());
    }

    let timeout = Duration::from_millis(timeout_ms.unwrap_or(800).clamp(100, 5_000));
    let address = (host, port)
        .to_socket_addrs()
        .map_err(|error| format!("Could not resolve CCTV host: {error}"))?
        .next()
        .ok_or_else(|| "Could not resolve CCTV host".to_string())?;

    let mut stream = TcpStream::connect_timeout(&address, timeout)
        .map_err(|error| format!("Could not connect to CCTV POS port: {error}"))?;
    let _ = stream.set_write_timeout(Some(timeout));
    let payload = encode_pos_text(&text, encoding.as_deref().unwrap_or("latin1"));
    stream
        .write_all(&payload)
        .map_err(|error| format!("Could not send CCTV POS text: {error}"))?;
    stream.flush().map_err(|error| format!("Could not flush CCTV POS text: {error}"))?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            #[cfg(target_os = "windows")]
            match WindowsKeepAwake::enable() {
                Ok(guard) => {
                    app.manage(guard);
                }
                Err(error) => eprintln!("Could not keep Windows awake: {error}"),
            }

            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Regular);

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                #[cfg(desktop)]
                {
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            send_cctv_pos_text,
            commerce::commit_local_sale,
            commerce::commit_mysql_sale,
            commerce::commit_online_reversal,
            commerce::allocate_mysql_till_sequence,
            commerce::create_local_backup,
            commerce::latest_local_backup,
            commerce::restore_latest_local_backup,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
