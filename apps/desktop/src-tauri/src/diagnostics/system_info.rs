use crate::diagnostics::DiagnosticSource;
use serde_json::json;
use std::io::Write;
use tauri::AppHandle;
use zip::{write::FileOptions, ZipWriter};

pub struct SystemInfoSource;

impl DiagnosticSource for SystemInfoSource {
    fn name(&self) -> &'static str {
        "SystemInfoSource"
    }

    fn collect(
        &self,
        app: &AppHandle,
        zip: &mut ZipWriter<std::fs::File>,
        options: FileOptions<()>,
    ) -> Result<(), String> {
        let os_type = std::env::consts::OS;
        let arch = std::env::consts::ARCH;
        let app_version = app.package_info().version.to_string();
        
        // System time
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        let info = json!({
            "os": os_type,
            "architecture": arch,
            "app_version": app_version,
            "timestamp_secs": timestamp,
        });

        if zip.start_file("system_info.json", options).is_ok() {
            let pretty_json = serde_json::to_string_pretty(&info).unwrap_or_default();
            let _ = zip.write_all(pretty_json.as_bytes());
        }

        Ok(())
    }
}
