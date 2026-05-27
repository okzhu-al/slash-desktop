use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::AppHandle;

use crate::diagnostics::{
    config::ConfigMaskerSource,
    db_stats::DbStatsSource,
    logs::LogFilesSource,
    run_diagnostics_export,
    system_info::SystemInfoSource,
    DiagnosticSource,
};

#[derive(Debug, Serialize, Deserialize)]
pub struct ExportDiagnosticsResult {
    pub success: bool,
    pub path: Option<String>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn export_diagnostics(
    app: AppHandle,
    target_path: String,
) -> Result<ExportDiagnosticsResult, String> {
    
    // Register the modular diagnostic sources
    // This allows easy addition/removal of log sources.
    let sources: Vec<Box<dyn DiagnosticSource>> = vec![
        Box::new(SystemInfoSource),
        Box::new(LogFilesSource),
        Box::new(ConfigMaskerSource),
        Box::new(DbStatsSource),
    ];

    let path = PathBuf::from(&target_path);

    match run_diagnostics_export(&app, path, &sources) {
        Ok(_) => Ok(ExportDiagnosticsResult {
            success: true,
            path: Some(target_path),
            error: None,
        }),
        Err(e) => Ok(ExportDiagnosticsResult {
            success: false,
            path: None,
            error: Some(e),
        }),
    }
}
