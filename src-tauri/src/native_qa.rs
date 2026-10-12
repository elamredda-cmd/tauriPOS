//! Explicitly compiled, isolated native UI fault scenarios. Never compiled into
//! a release command handler. No data, permissions or successful results are
//! fabricated; a checkpoint can only delay or reject an existing operation.

pub const APP_IDENTIFIER: &str = "com.elamreda.tauri-app.native-qa";

pub fn forbid_provider_network(app: &tauri::AppHandle) -> Result<(), String> {
    if app.config().identifier == APP_IDENTIFIER {
        return Err("Provider network calls are disabled in the isolated native QA application".into());
    }
    Ok(())
}

pub fn restrict_printer_network(app: &tauri::AppHandle, host: &str) -> Result<(), String> {
    if app.config().identifier == APP_IDENTIFIER && !matches!(host.trim(), "127.0.0.1" | "::1" | "localhost") {
        return Err("Native QA printer and drawer transport is restricted to loopback".into());
    }
    Ok(())
}

pub fn validate_startup(app: &tauri::AppHandle) -> Result<(), String> {
    #[cfg(native_qa)]
    {
        if option_env!("LBJ_NATIVE_QA") != Some("1") || app.config().identifier != APP_IDENTIFIER {
            return Err("Native QA requires LBJ_NATIVE_QA=1 at compile time and the isolated QA identifier".into());
        }
    }
    #[cfg(not(native_qa))]
    let _ = app;
    Ok(())
}

pub async fn checkpoint(app: &tauri::AppHandle, point: &str) -> Result<(), String> {
    #[cfg(native_qa)]
    { enabled::checkpoint(app, point).await }
    #[cfg(not(native_qa))]
    { let _ = (app, point); Ok(()) }
}

#[cfg(native_qa)]
pub(crate) mod enabled {
    use serde::Serialize;
    use std::{collections::BTreeMap, sync::{Arc, Mutex, OnceLock}, time::Duration};
    use tokio::sync::Notify;

    const POINTS: &[&str] = &[
        "settings.before-commit", "settings.before-audit", "settings.font",
        "provider.dojo.read", "provider.sumup.read", "provider.dojo.save", "provider.sumup.save",
        "schema.validate", "conflicts.refresh", "conflicts.dismiss",
        "stock.before-count", "stock.before-audit", "maintenance.backup",
        "checkout.after-sale-commit", "checkout.before-hold-commit", "checkout.after-hold-commit",
        "items.generate-plu", "items.image-read", "scale.selected-products", "scale.available-products",
        "label.suggestions", "suppliers.load", "tax.before-commit",
        "items.save", "items.goods-save", "suppliers.save", "printer.network", "printer.device",
        "printer.system", "drawer.network",
        "setup.after-reconnect-save",
    ];

    #[derive(Clone, Debug)]
    struct Fault { delay_ms: u64, reject: bool }

    #[derive(Default)]
    struct QaState {
        armed: BTreeMap<String, Fault>,
        pending: BTreeMap<u64, (String, Arc<Notify>)>,
        events: Vec<String>,
        hits: BTreeMap<String, u64>,
        sequence: u64,
    }

    #[derive(Serialize)]
    pub struct Status { armed: Vec<String>, pending: Vec<String>, events: Vec<String>, hits: BTreeMap<String, u64> }

    fn state() -> &'static Mutex<QaState> {
        static STATE: OnceLock<Mutex<QaState>> = OnceLock::new();
        STATE.get_or_init(|| Mutex::new(QaState::default()))
    }

    fn require_profile(app: &tauri::AppHandle) -> Result<(), String> {
        if option_env!("LBJ_NATIVE_QA") != Some("1") || app.config().identifier != super::APP_IDENTIFIER {
            return Err("Native QA is restricted to the isolated QA application".into());
        }
        Ok(())
    }

    fn validate(point: &str, mode: &str, delay_ms: u64) -> Result<Fault, String> {
        if !POINTS.contains(&point) { return Err("Unknown native QA checkpoint".into()); }
        if !matches!(mode, "delay" | "reject" | "delay-reject") { return Err("Unknown native QA mode".into()); }
        if delay_ms > 30_000 { return Err("Native QA delays are limited to 30 seconds".into()); }
        Ok(Fault { delay_ms: if mode == "reject" { 0 } else { delay_ms }, reject: mode != "delay" })
    }

    impl QaState {
        fn snapshot(&self) -> Status {
            Status {
                armed: self.armed.keys().cloned().collect(),
                pending: self.pending.values().map(|(point, _)| point.clone()).collect(),
                events: self.events.clone(),
                hits: self.hits.clone(),
            }
        }
        fn record(&mut self, event: String) {
            self.events.push(event);
            if self.events.len() > 24 { self.events.remove(0); }
        }
        fn take(&mut self, point: &str) -> Option<Fault> { self.armed.remove(point) }
    }

    #[tauri::command]
    pub fn native_qa_arm(app: tauri::AppHandle, point: String, mode: String, delay_ms: u64) -> Result<Status, String> {
        require_profile(&app)?;
        let fault = validate(&point, &mode, delay_ms)?;
        let mut current = state().lock().map_err(|_| "Native QA lock unavailable")?;
        current.armed.insert(point.clone(), fault);
        current.record(format!("Armed {point}: {mode}"));
        Ok(current.snapshot())
    }

    #[tauri::command]
    pub fn native_qa_release(app: tauri::AppHandle) -> Result<Status, String> {
        require_profile(&app)?;
        let mut current = state().lock().map_err(|_| "Native QA lock unavailable")?;
        current.armed.clear();
        for (_, notify) in current.pending.values() { notify.notify_one(); }
        current.record("Released pending delays and cleared unused faults".into());
        Ok(current.snapshot())
    }

    #[tauri::command]
    pub fn native_qa_status(app: tauri::AppHandle) -> Result<Status, String> {
        require_profile(&app)?;
        Ok(state().lock().map_err(|_| "Native QA lock unavailable")?.snapshot())
    }

    #[tauri::command]
    pub async fn native_qa_checkpoint(app: tauri::AppHandle, point: String) -> Result<(), String> {
        checkpoint(&app, &point).await
    }

    pub async fn checkpoint(app: &tauri::AppHandle, point: &str) -> Result<(), String> {
        require_profile(app)?;
        if !POINTS.contains(&point) { return Err("Unknown native QA checkpoint".into()); }
        let Some((fault, sequence, notify)) = ({
            let mut current = state().lock().map_err(|_| "Native QA lock unavailable")?;
            *current.hits.entry(point.into()).or_default() += 1;
            current.take(point).map(|fault| {
                current.sequence += 1;
                let sequence = current.sequence;
                let notify = Arc::new(Notify::new());
                current.pending.insert(sequence, (point.into(), notify.clone()));
                current.record(format!("Entered {point} #{sequence}"));
                (fault, sequence, notify)
            })
        }) else { return Ok(()); };
        if fault.delay_ms > 0 {
            let _ = tokio::time::timeout(Duration::from_millis(fault.delay_ms), notify.notified()).await;
        }
        {
            let mut current = state().lock().map_err(|_| "Native QA lock unavailable")?;
            current.pending.remove(&sequence);
            current.record(format!("{} {point} #{sequence}", if fault.reject { "Rejected" } else { "Released" }));
        }
        if fault.reject { Err(format!("Controlled native QA rejection: {point}")) } else { Ok(()) }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn only_known_bounded_failure_modes_are_allowed() {
            assert!(validate("settings.before-commit", "delay-reject", 15_000).is_ok());
            for point in ["checkout.after-sale-commit", "checkout.before-hold-commit", "checkout.after-hold-commit"] {
                assert!(validate(point, "delay", 30_000).is_ok());
            }
            assert!(validate("settings.before-commit", "success", 0).is_err());
            assert!(validate("arbitrary-sql", "delay", 1).is_err());
            assert!(validate("settings.font", "delay", 30_001).is_err());
            assert_eq!(validate("settings.font", "reject", 30_000).unwrap().delay_ms, 0);
        }
        #[test]
        fn faults_are_consumed_exactly_once_without_matching_other_operations() {
            let mut state = QaState::default();
            state.armed.insert("settings.font".into(), validate("settings.font", "delay", 1).unwrap());
            assert!(state.take("settings.before-commit").is_none());
            assert!(state.take("settings.font").is_some());
            assert!(state.take("settings.font").is_none());
        }
        #[test]
        fn diagnostics_are_bounded() {
            let mut state = QaState::default();
            for index in 0..100 { state.record(format!("{index}")); }
            assert_eq!(state.events.len(), 24);
            assert_eq!(state.events.first().unwrap(), "76");
        }
    }
}
