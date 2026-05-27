use crate::diagnostics::DiagnosticSource;
use std::fs;
use std::io::Write;
use std::time::{SystemTime, Duration};
use tauri::{AppHandle, Manager};
use zip::{write::FileOptions, ZipWriter};

pub struct LogFilesSource;

impl DiagnosticSource for LogFilesSource {
    fn name(&self) -> &'static str {
        "LogFilesSource"
    }

    fn collect(
        &self,
        app: &AppHandle,
        zip: &mut ZipWriter<std::fs::File>,
        options: FileOptions<()>,
    ) -> Result<(), String> {
        let log_dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
        
        if log_dir.exists() {
            if let Ok(entries) = fs::read_dir(&log_dir) {
                // Limit to log files modified within the last 7 days to avoid bundling outdated files.
                let max_age = Duration::from_secs(7 * 24 * 60 * 60);

                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_file() {
                        let file_name = path.file_name().unwrap_or_default().to_string_lossy();
                        let name_lower = file_name.to_lowercase();
                        
                        // Collect Tauri logs (.log) and any Python Sidecar logs if configured to drop here
                        if name_lower.ends_with(".log") || name_lower.contains("slash.log") || name_lower.contains("sidecar") {
                            let is_recent = if let Ok(metadata) = entry.metadata() {
                                if let Ok(modified) = metadata.modified() {
                                    if let Ok(elapsed) = SystemTime::now().duration_since(modified) {
                                        elapsed <= max_age
                                    } else {
                                        true
                                    }
                                } else {
                                    true
                                }
                            } else {
                                true
                            };

                            if is_recent {
                                if let Ok(contents) = fs::read(&path) {
                                    let zip_path = format!("logs/{}", file_name);
                                    if zip.start_file(zip_path, options.clone()).is_ok() {
                                        let _ = zip.write_all(&contents);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        Ok(())
    }
}
