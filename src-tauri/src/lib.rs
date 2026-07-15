mod commerce;

use serde::Serialize;
use std::{
    fs::OpenOptions,
    io::Write,
    net::{TcpStream, ToSocketAddrs},
    time::{Duration, Instant},
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemPrinterInfo {
    name: String,
    driver_name: String,
    port_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SerialPortInfo {
    path: String,
    label: String,
    kind: String,
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

#[cfg(target_os = "windows")]
fn platform_serial_ports() -> Result<Vec<SerialPortInfo>, String> {
    use windows_sys::Win32::Devices::Communication::GetCommPorts;

    let mut ports = vec![0u32; 256];
    let mut found = 0u32;
    let status = unsafe { GetCommPorts(ports.as_mut_ptr(), ports.len() as u32, &mut found) };
    if status != 0 {
        return Err(format!(
            "Could not list serial ports (Windows error {status})"
        ));
    }

    ports.truncate(found as usize);
    ports.sort_unstable();
    ports.dedup();

    Ok(ports
        .into_iter()
        .map(|port| {
            let path = format!("COM{port}");
            SerialPortInfo {
                label: format!("{path} - serial scale/printer port"),
                path,
                kind: "serial".into(),
            }
        })
        .collect())
}

#[cfg(not(target_os = "windows"))]
fn platform_serial_ports() -> Result<Vec<SerialPortInfo>, String> {
    fn add_matching_ports(
        ports: &mut Vec<SerialPortInfo>,
        dir: &str,
        prefixes: &[&str],
        kind: &str,
    ) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !prefixes.iter().any(|prefix| name.starts_with(prefix)) {
                continue;
            }
            let path = format!("{}/{}", dir.trim_end_matches('/'), name);
            ports.push(SerialPortInfo {
                label: format!("{path} - {kind}"),
                path,
                kind: kind.into(),
            });
        }
    }

    let mut ports = Vec::new();
    if cfg!(target_os = "macos") {
        add_matching_ports(
            &mut ports,
            "/dev",
            &[
                "cu.usb",
                "tty.usb",
                "cu.SLAB",
                "tty.SLAB",
                "cu.wchusb",
                "tty.wchusb",
                "cu.Bluetooth",
                "tty.Bluetooth",
            ],
            "macOS serial port",
        );
    } else {
        add_matching_ports(
            &mut ports,
            "/dev",
            &["ttyUSB", "ttyACM", "ttyS"],
            "Linux serial port",
        );
        add_matching_ports(
            &mut ports,
            "/dev/serial/by-id",
            &["usb-", "pci-"],
            "Linux serial adapter",
        );
    }

    ports.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    ports.dedup_by(|a, b| a.path == b.path);
    Ok(ports)
}

#[tauri::command]
fn list_serial_ports() -> Result<Vec<SerialPortInfo>, String> {
    platform_serial_ports()
}

#[cfg(target_os = "windows")]
fn platform_select_restore_database_file() -> Result<Option<String>, String> {
    use windows_sys::Win32::UI::Controls::Dialogs::{
        CommDlgExtendedError, GetOpenFileNameW, OFN_EXPLORER, OFN_FILEMUSTEXIST, OFN_NOCHANGEDIR,
        OFN_PATHMUSTEXIST, OPENFILENAMEW,
    };

    let mut file_buffer = vec![0u16; 32_768];
    let mut filter = wide_null(
        "SQLite database (*.db;*.sqlite;*.sqlite3)\0*.db;*.sqlite;*.sqlite3\0All files (*.*)\0*.*\0",
    );
    let mut title = wide_null("Choose old till database");
    let mut default_ext = wide_null("db");
    let mut dialog: OPENFILENAMEW = unsafe { std::mem::zeroed() };
    dialog.lStructSize = std::mem::size_of::<OPENFILENAMEW>() as u32;
    dialog.lpstrFilter = filter.as_mut_ptr();
    dialog.nFilterIndex = 1;
    dialog.lpstrFile = file_buffer.as_mut_ptr();
    dialog.nMaxFile = file_buffer.len() as u32;
    dialog.lpstrTitle = title.as_mut_ptr();
    dialog.lpstrDefExt = default_ext.as_mut_ptr();
    dialog.Flags = OFN_EXPLORER | OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;

    let selected = unsafe { GetOpenFileNameW(&mut dialog) };
    if selected == 0 {
        let error = unsafe { CommDlgExtendedError() };
        if error == 0 {
            return Ok(None);
        }
        return Err(format!("Windows file picker failed (dialog error {error})"));
    }

    let len = file_buffer
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(file_buffer.len());
    Ok(Some(String::from_utf16_lossy(&file_buffer[..len])))
}

#[cfg(target_os = "macos")]
fn platform_select_restore_database_file() -> Result<Option<String>, String> {
    use std::process::Command;

    let script = r#"try
  set dbFile to choose file with prompt "Choose old till database" of type {"db", "sqlite", "sqlite3"}
  return POSIX path of dbFile
on error number -128
  return ""
end try"#;
    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|error| format!("Could not open macOS file picker: {error}"))?;

    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if message.is_empty() {
            "macOS file picker failed".into()
        } else {
            format!("macOS file picker failed: {message}")
        });
    }

    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        Ok(None)
    } else {
        Ok(Some(path))
    }
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn platform_select_restore_database_file() -> Result<Option<String>, String> {
    Err(
        "File picker is available on Windows and macOS. Paste the database path on this machine."
            .into(),
    )
}

#[tauri::command]
fn select_restore_database_file() -> Result<Option<String>, String> {
    platform_select_restore_database_file()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScaleWeightReading {
    weight: f64,
    unit: String,
    raw: String,
}

#[derive(Clone, Copy)]
struct NumberCandidate {
    start: usize,
    end: usize,
    value: f64,
}

fn clean_scale_raw(raw: &str) -> String {
    raw.chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn number_candidates(text: &str) -> Vec<NumberCandidate> {
    let mut candidates = Vec::new();
    let mut start: Option<usize> = None;
    let mut end = 0usize;
    let mut has_digit = false;
    let mut has_decimal = false;

    fn finish_candidate(
        text: &str,
        candidates: &mut Vec<NumberCandidate>,
        start: Option<usize>,
        end: usize,
        has_digit: bool,
    ) {
        let Some(candidate_start) = start.filter(|_| has_digit) else {
            return;
        };
        let token = text[candidate_start..end].replace(',', ".");
        if let Ok(value) = token.parse::<f64>() {
            candidates.push(NumberCandidate {
                start: candidate_start,
                end,
                value,
            });
        }
    }

    for (index, ch) in text.char_indices() {
        if ch.is_ascii_digit() {
            if start.is_none() {
                start = Some(index);
                has_decimal = false;
            }
            has_digit = true;
            end = index + ch.len_utf8();
            continue;
        }

        if (ch == '+' || ch == '-') && start.is_none() {
            start = Some(index);
            end = index + ch.len_utf8();
            has_digit = false;
            has_decimal = false;
            continue;
        }

        if (ch == '.' || ch == ',') && start.is_some() && has_digit && !has_decimal {
            has_decimal = true;
            end = index + ch.len_utf8();
            continue;
        }

        finish_candidate(text, &mut candidates, start, end, has_digit);
        start = None;
        has_digit = false;
        has_decimal = false;
    }

    finish_candidate(text, &mut candidates, start, end, has_digit);

    candidates
}

fn gram_unit_index(text: &str) -> Option<usize> {
    let chars = text.char_indices().collect::<Vec<_>>();
    for (position, (index, ch)) in chars.iter().enumerate() {
        if *ch != 'g' {
            continue;
        }
        if position > 0 && chars[position - 1].1 == 'k' {
            continue;
        }
        if let Some((_, next)) = chars.get(position + 1) {
            if next.is_ascii_alphabetic() {
                continue;
            }
        }
        return Some(*index);
    }
    None
}

fn closest_number_before(numbers: &[NumberCandidate], unit_index: usize) -> Option<f64> {
    numbers
        .iter()
        .filter(|candidate| candidate.end <= unit_index && candidate.value.is_finite())
        .min_by_key(|candidate| unit_index.saturating_sub(candidate.end))
        .map(|candidate| candidate.value)
}

fn closest_number_after(numbers: &[NumberCandidate], unit_index: usize) -> Option<f64> {
    numbers
        .iter()
        .filter(|candidate| candidate.start >= unit_index && candidate.value.is_finite())
        .min_by_key(|candidate| candidate.start.saturating_sub(unit_index))
        .map(|candidate| candidate.value)
}

fn parse_scale_weight(raw: &str) -> Option<ScaleWeightReading> {
    let cleaned = clean_scale_raw(raw);
    let text = cleaned.to_ascii_lowercase();
    let numbers = number_candidates(&text);
    if numbers.is_empty() {
        return None;
    }

    if let Some(unit_index) = text.find("kg") {
        let weight = closest_number_before(&numbers, unit_index)
            .or_else(|| closest_number_after(&numbers, unit_index))?;
        return Some(ScaleWeightReading {
            weight,
            unit: "kg".into(),
            raw: cleaned,
        });
    }

    if let Some(unit_index) = gram_unit_index(&text) {
        let weight = closest_number_before(&numbers, unit_index)
            .or_else(|| closest_number_after(&numbers, unit_index))?;
        return Some(ScaleWeightReading {
            weight,
            unit: "g".into(),
            raw: cleaned,
        });
    }

    let weight = numbers
        .iter()
        .find(|candidate| candidate.value.is_finite())
        .map(|candidate| candidate.value)?;
    Some(ScaleWeightReading {
        weight,
        unit: "kg".into(),
        raw: cleaned,
    })
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ScaleRequestMode {
    Auto,
    Listen,
    AdamPrint,
}

fn scale_request_mode(value: Option<&str>) -> ScaleRequestMode {
    match value.unwrap_or("auto").trim().to_ascii_lowercase().as_str() {
        "listen" => ScaleRequestMode::Listen,
        "adam_print" => ScaleRequestMode::AdamPrint,
        _ => ScaleRequestMode::Auto,
    }
}

#[tauri::command]
async fn read_scale_weight(
    device_path: String,
    baud_rate: Option<u32>,
    timeout_ms: Option<u64>,
    request_mode: Option<String>,
) -> Result<ScaleWeightReading, String> {
    tauri::async_runtime::spawn_blocking(move || {
        platform_read_scale_weight(device_path, baud_rate, timeout_ms, request_mode)
    })
    .await
    .map_err(|error| format!("Scale read worker failed: {error}"))?
}

#[cfg(target_os = "windows")]
fn send_windows_scale_print_request(
    handle: windows_sys::Win32::Foundation::HANDLE,
) -> Result<(), String> {
    use windows_sys::Win32::Storage::FileSystem::WriteFile;

    let request = b"P\r\n";
    let mut written = 0u32;
    let ok = unsafe {
        WriteFile(
            handle,
            request.as_ptr(),
            request.len() as u32,
            &mut written,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 || written != request.len() as u32 {
        return Err(last_windows_error("Could not send the Adam PRINT command"));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn platform_read_scale_weight(
    device_path: String,
    baud_rate: Option<u32>,
    timeout_ms: Option<u64>,
    request_mode: Option<String>,
) -> Result<ScaleWeightReading, String> {
    use windows_sys::Win32::Devices::Communication::{
        GetCommState, SetCommState, SetCommTimeouts, COMMTIMEOUTS, DCB, NOPARITY, ONESTOPBIT,
    };
    use windows_sys::Win32::Foundation::{
        CloseHandle, GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, ReadFile, FILE_ATTRIBUTE_NORMAL, OPEN_EXISTING,
    };

    let device_path = device_path.trim();
    if device_path.is_empty() {
        return Err("Scale port is required".into());
    }

    let path = {
        let upper = device_path.to_ascii_uppercase();
        if upper.starts_with("COM") && !device_path.starts_with(r"\\.\") {
            format!(r"\\.\{device_path}")
        } else {
            device_path.to_string()
        }
    };

    let mut path_w = wide_null(&path);
    let handle = unsafe {
        CreateFileW(
            path_w.as_mut_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(last_windows_error("Could not open scale port"));
    }

    let result = (|| {
        let baud = baud_rate.unwrap_or(9_600).clamp(1_200, 115_200);
        let timeout = Duration::from_millis(timeout_ms.unwrap_or(1_200).clamp(200, 5_000));
        let request_mode = scale_request_mode(request_mode.as_deref());

        let mut dcb: DCB = unsafe { std::mem::zeroed() };
        dcb.DCBlength = std::mem::size_of::<DCB>() as u32;
        if unsafe { GetCommState(handle, &mut dcb) } == 0 {
            return Err(last_windows_error("Could not read scale port settings"));
        }
        dcb.BaudRate = baud;
        dcb.ByteSize = 8;
        dcb.Parity = NOPARITY;
        dcb.StopBits = ONESTOPBIT;
        if unsafe { SetCommState(handle, &dcb) } == 0 {
            return Err(last_windows_error("Could not set scale port speed"));
        }

        let timeouts = COMMTIMEOUTS {
            ReadIntervalTimeout: 50,
            ReadTotalTimeoutMultiplier: 0,
            ReadTotalTimeoutConstant: 75,
            WriteTotalTimeoutMultiplier: 0,
            WriteTotalTimeoutConstant: timeout.as_millis() as u32,
        };
        if unsafe { SetCommTimeouts(handle, &timeouts) } == 0 {
            return Err(last_windows_error("Could not set scale read timeout"));
        }

        let started = Instant::now();
        let mut raw = Vec::new();
        let mut last_data_at: Option<Instant> = None;
        let mut request_sent = false;
        let mut request_error = String::new();
        if request_mode == ScaleRequestMode::AdamPrint {
            send_windows_scale_print_request(handle)?;
            request_sent = true;
        }
        while started.elapsed() < timeout && raw.len() < 4_096 {
            let mut buffer = [0u8; 256];
            let mut read = 0u32;
            let ok = unsafe {
                ReadFile(
                    handle,
                    buffer.as_mut_ptr(),
                    buffer.len() as u32,
                    &mut read,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 {
                return Err(last_windows_error("Could not read from scale port"));
            }
            if read == 0 {
                if request_mode == ScaleRequestMode::Auto
                    && !request_sent
                    && raw.is_empty()
                    && started.elapsed() >= Duration::from_millis(200)
                {
                    request_sent = true;
                    if let Err(error) = send_windows_scale_print_request(handle) {
                        request_error = error;
                    }
                }
                if last_data_at
                    .is_some_and(|received| received.elapsed() >= Duration::from_millis(120))
                {
                    break;
                }
                continue;
            }
            raw.extend_from_slice(&buffer[..read as usize]);
            last_data_at = Some(Instant::now());
        }

        if raw.is_empty() {
            let request_detail = if request_error.is_empty() {
                String::new()
            } else {
                format!(" The automatic PRINT request also failed: {request_error}.")
            };
            return Err(format!(
                "No scale data received.{request_detail} Close any other scale software, confirm the COM port, and check that the scale output is enabled."
            ));
        }

        let text = String::from_utf8_lossy(&raw);
        parse_scale_weight(&text).ok_or_else(|| {
            format!(
                "Could not find a weight in the scale data: {}",
                clean_scale_raw(&text)
            )
        })
    })();

    unsafe {
        CloseHandle(handle);
    }
    result
}

#[cfg(not(target_os = "windows"))]
fn platform_read_scale_weight(
    device_path: String,
    baud_rate: Option<u32>,
    timeout_ms: Option<u64>,
    request_mode: Option<String>,
) -> Result<ScaleWeightReading, String> {
    use std::io::{Read, Write};
    use std::os::unix::fs::OpenOptionsExt;
    use std::process::Command;
    use std::thread;

    #[cfg(target_os = "macos")]
    const NONBLOCK_FLAG: i32 = 0x0004;
    #[cfg(not(target_os = "macos"))]
    const NONBLOCK_FLAG: i32 = 0o4000;

    let device_path = device_path.trim();
    if device_path.is_empty() {
        return Err("Scale device path is required".into());
    }

    let baud = baud_rate.unwrap_or(9_600).clamp(1_200, 115_200);
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(1_200).clamp(200, 5_000));
    let request_mode = scale_request_mode(request_mode.as_deref());
    let stty_device_flag = if cfg!(target_os = "macos") {
        "-f"
    } else {
        "-F"
    };
    let _ = Command::new("stty")
        .arg(stty_device_flag)
        .arg(device_path)
        .arg(baud.to_string())
        .args(["cs8", "-cstopb", "-parenb", "-ixon", "-ixoff", "raw"])
        .status();

    let mut open_options = OpenOptions::new();
    open_options.read(true).custom_flags(NONBLOCK_FLAG);
    if request_mode != ScaleRequestMode::Listen {
        open_options.write(true);
    }
    let mut file = open_options
        .open(device_path)
        .map_err(|error| format!("Could not open scale device {device_path}: {error}"))?;

    let started = Instant::now();
    let mut raw = Vec::new();
    let mut last_data_at: Option<Instant> = None;
    let mut request_sent = false;
    let mut request_error = String::new();
    if request_mode == ScaleRequestMode::AdamPrint {
        file.write_all(b"P\r\n")
            .map_err(|error| format!("Could not send the Adam PRINT command: {error}"))?;
        request_sent = true;
    }
    while started.elapsed() < timeout && raw.len() < 4_096 {
        let mut buffer = [0u8; 256];
        match file.read(&mut buffer) {
            Ok(0) => {
                if request_mode == ScaleRequestMode::Auto
                    && !request_sent
                    && raw.is_empty()
                    && started.elapsed() >= Duration::from_millis(200)
                {
                    request_sent = true;
                    if let Err(error) = file.write_all(b"P\r\n") {
                        request_error = format!("Could not send the Adam PRINT command: {error}");
                    }
                }
                if last_data_at
                    .is_some_and(|received| received.elapsed() >= Duration::from_millis(120))
                {
                    break;
                }
                thread::sleep(Duration::from_millis(40));
            }
            Ok(read) => {
                raw.extend_from_slice(&buffer[..read]);
                last_data_at = Some(Instant::now());
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(40));
            }
            Err(error) => return Err(format!("Could not read from scale device: {error}")),
        }
    }

    if raw.is_empty() {
        let request_detail = if request_error.is_empty() {
            String::new()
        } else {
            format!(" The automatic PRINT request also failed: {request_error}.")
        };
        return Err(format!(
            "No scale data received.{request_detail} Close any other scale software, confirm the serial port, and check that the scale output is enabled."
        ));
    }

    let text = String::from_utf8_lossy(&raw);
    parse_scale_weight(&text).ok_or_else(|| {
        format!(
            "Could not find a weight in the scale data: {}",
            clean_scale_raw(&text)
        )
    })
}

#[cfg(test)]
mod scale_tests {
    use super::{parse_scale_weight, scale_request_mode, ScaleRequestMode};

    #[test]
    fn parses_weight_from_a_multiline_adam_packet() {
        let reading =
            parse_scale_weight("Date: 11/07/2026\r\nTime: 02:15\r\nG/W:      1.250 kg\r\n")
                .expect("weight should be parsed");

        assert!((reading.weight - 1.25).abs() < f64::EPSILON);
        assert_eq!(reading.unit, "kg");
        assert!(reading.raw.contains("G/W: 1.250 kg"));
    }

    #[test]
    fn parses_compact_gram_output() {
        let reading = parse_scale_weight("ST,+000425g\r\n").expect("grams should be parsed");

        assert!((reading.weight - 425.0).abs() < f64::EPSILON);
        assert_eq!(reading.unit, "g");
    }

    #[test]
    fn defaults_to_automatic_request_mode() {
        assert!(scale_request_mode(None) == ScaleRequestMode::Auto);
        assert!(scale_request_mode(Some("listen")) == ScaleRequestMode::Listen);
        assert!(scale_request_mode(Some("adam_print")) == ScaleRequestMode::AdamPrint);
    }
}

fn encode_pos_text(text: &str, encoding: &str) -> Vec<u8> {
    if encoding.eq_ignore_ascii_case("latin1") || encoding.eq_ignore_ascii_case("latin-1") {
        text.chars()
            .map(|ch| {
                let code = ch as u32;
                if code <= 0xff {
                    code as u8
                } else {
                    b'?'
                }
            })
            .collect()
    } else {
        text.as_bytes().to_vec()
    }
}

fn send_cctv_pos_text_blocking(
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
    stream
        .flush()
        .map_err(|error| format!("Could not flush CCTV POS text: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod cctv_tests {
    use super::{encode_pos_text, send_cctv_pos_text_blocking};
    use std::{io::Read, net::TcpListener, thread};

    #[test]
    fn latin1_keeps_pound_sign_and_replaces_unsupported_characters() {
        assert_eq!(encode_pos_text("GBP £1 😀", "latin1"), b"GBP \xa31 ?");
    }

    #[test]
    fn sends_overlay_text_to_the_configured_tcp_port() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("test listener should bind");
        let port = listener
            .local_addr()
            .expect("listener should have an address")
            .port();
        let receiver = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("sender should connect");
            let mut bytes = Vec::new();
            stream
                .read_to_end(&mut bytes)
                .expect("overlay bytes should be readable");
            bytes
        });

        send_cctv_pos_text_blocking(
            "127.0.0.1".into(),
            port,
            "TEST £1.23\r\n\r\n".into(),
            Some(500),
            Some("latin1".into()),
        )
        .expect("overlay should send");

        assert_eq!(
            receiver.join().expect("receiver thread should finish"),
            b"TEST \xa31.23\r\n\r\n"
        );
    }
}

#[tauri::command]
async fn send_cctv_pos_text(
    host: String,
    port: u16,
    text: String,
    timeout_ms: Option<u64>,
    encoding: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        send_cctv_pos_text_blocking(host, port, text, timeout_ms, encoding)
    })
    .await
    .map_err(|error| format!("CCTV network task failed: {error}"))?
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
    stream
        .flush()
        .map_err(|error| format!("Could not flush printer data: {error}"))?;
    Ok(())
}

#[tauri::command]
fn send_device_printer_data(device_path: String, data: Vec<u8>) -> Result<(), String> {
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
        OpenPrinterW(
            printer_name_w.as_mut_ptr(),
            &mut printer,
            std::ptr::null_mut(),
        )
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
    stream
        .flush()
        .map_err(|error| format!("Could not flush drawer pulse: {error}"))?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if let Err(error) = commerce::apply_pending_restore_on_startup(app.handle()) {
                eprintln!("Could not apply pending database restore: {error}");
            }

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
            list_serial_ports,
            select_restore_database_file,
            read_scale_weight,
            open_cash_drawer,
            commerce::commit_local_sale,
            commerce::commit_mysql_sale,
            commerce::commit_online_reversal,
            commerce::allocate_mysql_till_sequence,
            commerce::create_local_backup,
            commerce::latest_local_backup,
            commerce::create_automatic_setup_backup,
            commerce::latest_automatic_setup_backup,
            commerce::validate_local_database_backup,
            commerce::restore_latest_local_backup,
            commerce::restore_local_database_from_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
