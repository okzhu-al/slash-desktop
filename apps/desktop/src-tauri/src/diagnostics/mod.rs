use std::path::PathBuf;
use tauri::AppHandle;
use zip::{write::FileOptions, ZipWriter};

pub mod config;
pub mod db_stats;
pub mod logs;
pub mod system_info;

/// A generalized trait for any diagnostic data source.
/// Implement this trait to add new types of logs or statistics to the export archive.
pub trait DiagnosticSource {
    /// Provide a short name for logging/debugging
    fn name(&self) -> &'static str;

    /// Collect data and write it to the zip archive.
    fn collect(
        &self,
        app: &AppHandle,
        zip: &mut ZipWriter<std::fs::File>,
        options: FileOptions<()>,
    ) -> Result<(), String>;
}

/// Orchestrates the collection of all registered diagnostic sources.
pub fn run_diagnostics_export(
    app: &AppHandle,
    target_path: PathBuf,
    sources: &[Box<dyn DiagnosticSource>],
) -> Result<(), String> {
    if let Some(parent) = target_path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create parent dir: {}", e))?;
        }
    }

    let file = std::fs::File::create(&target_path)
        .map_err(|e| format!("Failed to create zip file: {}", e))?;
    let mut zip = ZipWriter::new(file);
    let options = FileOptions::<()>::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o755);

    for source in sources {
        log::info!("[Diagnostics] Running source: {}", source.name());
        if let Err(e) = source.collect(app, &mut zip, options.clone()) {
            log::warn!("[Diagnostics] Source {} encountered an error: {}", source.name(), e);
            // We do not fail the entire export if one source fails.
        }
    }

    zip.finish().map_err(|e| format!("Failed to finish zip: {}", e))?;

    Ok(())
}
