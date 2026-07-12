fn main() {
    let app_manifest = tauri_build::AppManifest::new().commands(&[
        "greet",
        "send_cctv_pos_text",
        "send_raw_printer_data",
        "send_device_printer_data",
        "send_system_printer_data",
        "list_system_printers",
        "list_serial_ports",
        "select_restore_database_file",
        "read_scale_weight",
        "open_cash_drawer",
        "commit_local_sale",
        "commit_mysql_sale",
        "commit_online_reversal",
        "allocate_mysql_till_sequence",
        "create_local_backup",
        "latest_local_backup",
        "create_automatic_setup_backup",
        "latest_automatic_setup_backup",
        "validate_local_database_backup",
        "restore_latest_local_backup",
        "restore_local_database_from_path",
    ]);

    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(app_manifest))
        .expect("failed to run Tauri build script");
}
