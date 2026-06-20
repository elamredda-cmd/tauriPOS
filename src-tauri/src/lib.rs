mod commerce;

use std::{
    fs::OpenOptions,
    io::Write,
    net::{TcpStream, ToSocketAddrs},
    time::Duration,
};
use serde::Serialize;
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemPrinterInfo {
    name: String,
    driver_name: String,
    port_name: String,
}

#[cfg(target_os = "windows")]
fn wide_ptr_to_string(ptr: *const u16) -> String {
    if ptr.is_null() {
        return String::new();
    }
    let mut len = 0usize;
    unsafe {
        while *ptr.add(len) != 0 {
            len += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len))
    }
}

#[cfg(target_os = "windows")]
fn platform_printers() -> Result<Vec<SystemPrinterInfo>, String> {
    use windows_sys::Win32::Graphics::Printing::{
        EnumPrintersW, PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL, PRINTER_INFO_5W,
    };

    let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
    let mut needed = 0u32;
    let mut returned = 0u32;

    unsafe {
        EnumPrintersW(
            flags,
            std::ptr::null_mut(),
            5,
            std::ptr::null_mut(),
            0,
            &mut needed,
            &mut returned,
        );
    }

    if needed == 0 {
        return Ok(Vec::new());
    }

    let mut buffer = vec![0u8; needed as usize];
    let ok = unsafe {
        EnumPrintersW(
            flags,
            std::ptr::null_mut(),
            5,
            buffer.as_mut_ptr(),
            needed,
            &mut needed,
            &mut returned,
        )
    };
    if ok == 0 {
        return Err(last_windows_error("Could not list Windows printers"));
    }

    let rows = unsafe {
        std::slice::from_raw_parts(buffer.as_ptr() as *const PRINTER_INFO_5W, returned as usize)
    };
    let mut printers: Vec<SystemPrinterInfo> = rows
        .iter()
        .filter_map(|row| {
            let name = wide_ptr_to_string(row.pPrinterName);
            if name.trim().is_empty() {
                return None;
            }
            Some(SystemPrinterInfo {
                name,
                driver_name: String::new(),
                port_name: wide_ptr_to_string(row.pPortName),
            })
        })
        .collect();

    printers.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    printers.dedup_by(|a, b| a.name.eq_ignore_ascii_case(&b.name));
    Ok(printers)
}

#[cfg(not(target_os = "windows"))]
fn platform_printers() -> Result<Vec<SystemPrinterInfo>, String> {
    use std::process::Command;

    let output = Command::new("lpstat")
        .arg("-v")
        .output()
        .map_err(|error| format!("Could not ask the system for printers: {error}"))?;

    if !output.status.success() {
        return Ok(Vec::new());
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let mut printers: Vec<SystemPrinterInfo> = text
        .lines()
        .filter_map(|line| {
            let value = line.trim().strip_prefix("device for ")?;
            let (name, device) = value.split_once(':')?;
            let name = name.trim().to_string();
            if name.is_empty() {
                return None;
            }
            Some(SystemPrinterInfo {
                name,
                driver_name: String::new(),
                port_name: device.trim().to_string(),
            })
        })
        .collect();

    printers.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    printers.dedup_by(|a, b| a.name.eq_ignore_ascii_case(&b.name));
    Ok(printers)
}

#[tauri::command]
fn list_system_printers() -> Result<Vec<SystemPrinterInfo>, String> {
    platform_printers()
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

#[tauri::command]
fn send_raw_printer_data(
    host: String,
    port: u16,
    data: Vec<u8>,
    timeout_ms: Option<u64>,
) -> Result<(), String> {
    let host = host.trim();
    if host.is_empty() {
        return Err("Printer IP address is required".into());
    }
    if port == 0 {
        return Err("Printer port is required".into());
    }
    if data.is_empty() {
        return Err("Printer data is empty".into());
    }
    if data.len() > 256_000 {
        return Err("Printer data is too large".into());
    }

    let timeout = Duration::from_millis(timeout_ms.unwrap_or(1_500).clamp(100, 10_000));
    let address = (host, port)
        .to_socket_addrs()
        .map_err(|error| format!("Could not resolve printer: {error}"))?
        .next()
        .ok_or_else(|| "Could not resolve printer".to_string())?;

    let mut stream = TcpStream::connect_timeout(&address, timeout)
        .map_err(|error| format!("Could not connect to printer: {error}"))?;
    let _ = stream.set_write_timeout(Some(timeout));
    stream
        .write_all(&data)
        .map_err(|error| format!("Could not send printer data: {error}"))?;
    stream.flush().map_err(|error| format!("Could not flush printer data: {error}"))?;
    Ok(())
}

#[tauri::command]
fn send_device_printer_data(
    device_path: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let device_path = device_path.trim();
    if device_path.is_empty() {
        return Err("Printer device path is required".into());
    }
    if data.is_empty() {
        return Err("Printer data is empty".into());
    }
    if data.len() > 256_000 {
        return Err("Printer data is too large".into());
    }

    #[cfg(target_os = "windows")]
    let path = {
        let upper = device_path.to_ascii_uppercase();
        if upper.starts_with("COM") && !device_path.starts_with(r"\\.\") {
            format!(r"\\.\{device_path}")
        } else {
            device_path.to_string()
        }
    };
    #[cfg(not(target_os = "windows"))]
    let path = device_path.to_string();

    let mut file = OpenOptions::new()
        .write(true)
        .open(&path)
        .map_err(|error| format!("Could not open printer device {device_path}: {error}"))?;
    file.write_all(&data)
        .map_err(|error| format!("Could not write printer data: {error}"))?;
    file.flush()
        .map_err(|error| format!("Could not flush printer data: {error}"))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(target_os = "windows")]
fn last_windows_error(context: &str) -> String {
    use windows_sys::Win32::Foundation::GetLastError;
    let code = unsafe { GetLastError() };
    format!("{context} (Windows error {code})")
}

#[tauri::command]
#[cfg(target_os = "windows")]
fn send_system_printer_data(
    printer_name: String,
    data: Vec<u8>,
    document_name: Option<String>,
) -> Result<(), String> {
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Graphics::Printing::{
        ClosePrinter, EndDocPrinter, EndPagePrinter, OpenPrinterW, StartDocPrinterW,
        StartPagePrinter, WritePrinter, DOC_INFO_1W,
    };

    let printer_name = printer_name.trim();
    if printer_name.is_empty() {
        return Err("Windows printer name is required".into());
    }
    if data.is_empty() {
        return Err("Printer data is empty".into());
    }
    if data.len() > 256_000 {
        return Err("Printer data is too large".into());
    }

    let mut printer_name_w = wide_null(printer_name);
    let mut printer: HANDLE = std::ptr::null_mut();
    let opened = unsafe {
        OpenPrinterW(printer_name_w.as_mut_ptr(), &mut printer, std::ptr::null_mut())
    };
    if opened == 0 {
        return Err(last_windows_error("Could not open Windows printer"));
    }

    let result = (|| {
        let mut doc_name_w = wide_null(document_name.as_deref().unwrap_or("L&Bj POS print job"));
        let mut data_type_w = wide_null("RAW");
        let doc_info = DOC_INFO_1W {
            pDocName: doc_name_w.as_mut_ptr(),
            pOutputFile: std::ptr::null_mut(),
            pDatatype: data_type_w.as_mut_ptr(),
        };

        let job = unsafe { StartDocPrinterW(printer, 1, &doc_info) };
        if job == 0 {
            return Err(last_windows_error("Could not start raw print job"));
        }

        let page_started = unsafe { StartPagePrinter(printer) };
        if page_started == 0 {
            unsafe { EndDocPrinter(printer) };
            return Err(last_windows_error("Could not start printer page"));
        }

        let mut written = 0u32;
        let wrote = unsafe {
            WritePrinter(
                printer,
                data.as_ptr() as *const c_void,
                data.len() as u32,
                &mut written,
            )
        };
        unsafe {
            EndPagePrinter(printer);
            EndDocPrinter(printer);
        }
        if wrote == 0 || written as usize != data.len() {
            return Err(last_windows_error("Could not write raw printer data"));
        }
        Ok(())
    })();

    unsafe { ClosePrinter(printer) };
    result
}

#[tauri::command]
#[cfg(target_os = "macos")]
fn send_system_printer_data(
    _printer_name: String,
    _data: Vec<u8>,
    _document_name: Option<String>,
) -> Result<(), String> {
    Err("Raw USB/system printer mode uses the Windows print spooler and is not available on macOS. Use network ESC/POS or a macOS device path instead.".into())
}

#[tauri::command]
#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn send_system_printer_data(
    _printer_name: String,
    _data: Vec<u8>,
    _document_name: Option<String>,
) -> Result<(), String> {
    Err("Raw USB/system printer mode is currently available on Windows only. Use network ESC/POS or serial device path on this machine.".into())
}

#[tauri::command]
fn open_cash_drawer(
    host: String,
    port: u16,
    pin: Option<u8>,
    pulse_on_ms: Option<u16>,
    pulse_off_ms: Option<u16>,
    timeout_ms: Option<u64>,
) -> Result<(), String> {
    let host = host.trim();
    if host.is_empty() {
        return Err("Drawer printer IP address is required".into());
    }
    if port == 0 {
        return Err("Drawer printer port is required".into());
    }

    let timeout = Duration::from_millis(timeout_ms.unwrap_or(800).clamp(100, 5_000));
    let address = (host, port)
        .to_socket_addrs()
        .map_err(|error| format!("Could not resolve drawer printer: {error}"))?
        .next()
        .ok_or_else(|| "Could not resolve drawer printer".to_string())?;

    let drawer_pin = match pin.unwrap_or(0) {
        0 | 1 => pin.unwrap_or(0),
        _ => return Err("Drawer pin must be 0 or 1".into()),
    };
    let on_units = ((pulse_on_ms.unwrap_or(50).max(2) as u32 + 1) / 2).clamp(1, 255) as u8;
    let off_units = ((pulse_off_ms.unwrap_or(250).max(2) as u32 + 1) / 2).clamp(1, 255) as u8;
    let payload = [0x1b, 0x70, drawer_pin, on_units, off_units];

    let mut stream = TcpStream::connect_timeout(&address, timeout)
        .map_err(|error| format!("Could not connect to drawer printer: {error}"))?;
    let _ = stream.set_write_timeout(Some(timeout));
    stream
        .write_all(&payload)
        .map_err(|error| format!("Could not send drawer pulse: {error}"))?;
    stream.flush().map_err(|error| format!("Could not flush drawer pulse: {error}"))?;
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
            send_raw_printer_data,
            send_device_printer_data,
            send_system_printer_data,
            list_system_printers,
            open_cash_drawer,
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
