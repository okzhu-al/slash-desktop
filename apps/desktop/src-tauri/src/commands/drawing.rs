//! Drawing Commands
//!
//! Tauri commands for saving and loading Tldraw drawings.
//! Drawings are stored as dual files: PNG (for viewing) and .tldr (JSON for editing).

use chrono::Local;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// Result returned when saving a drawing
#[derive(Serialize)]
pub struct SaveDrawingResult {
    /// Relative path to PNG file (e.g., "assets/drawing-20260203.png")
    pub png_path: String,
    /// Relative path to JSON file (e.g., "assets/drawing-20260203.tldr")
    pub json_path: String,
}

/// Helper: generate unique filename with timestamp
#[allow(dead_code)]
fn generate_drawing_filename(assets_dir: &Path, extension: &str) -> String {
    let now = Local::now();
    let base_name = format!("drawing_{}", now.format("%Y%m%d%H%M%S"));

    let mut filename = format!("{}.{}", base_name, extension);
    let mut counter = 1;

    while assets_dir.join(&filename).exists() {
        filename = format!("{}_{}.{}", base_name, counter, extension);
        counter += 1;
    }

    filename
}

/// Save a drawing (PNG + JSON) to the assets folder
///
/// # Arguments
/// * `vault_path` - Absolute path to the vault
/// * `png_data` - PNG image bytes
/// * `json_data` - Tldraw JSON state string
/// * `existing_png_path` - Optional existing PNG path to overwrite (e.g., "assets/drawing_xxx.png")
/// * `existing_json_path` - Optional existing JSON path to overwrite (e.g., "assets/drawing_xxx.tldr")
///
/// # Returns
/// Paths to both saved files relative to vault
#[tauri::command]
pub async fn save_drawing(
    vault_path: String,
    png_data: Vec<u8>,
    json_data: String,
    existing_png_path: Option<String>,
    existing_json_path: Option<String>,
) -> Result<SaveDrawingResult, String> {
    let vault = PathBuf::from(&vault_path);
    let assets_dir = vault.join("assets");

    // Ensure assets directory exists
    if !assets_dir.exists() {
        fs::create_dir_all(&assets_dir)
            .map_err(|e| format!("Failed to create assets dir: {}", e))?;
    }

    // Determine file paths: reuse existing or generate new
    let (png_relative, json_relative) = if let (Some(existing_png), Some(existing_json)) =
        (&existing_png_path, &existing_json_path)
    {
        // Overwrite existing files
        (existing_png.clone(), existing_json.clone())
    } else {
        // Generate unique filenames with timestamp
        let now = Local::now();
        let base_name = format!("drawing_{}", now.format("%Y%m%d%H%M%S"));

        let mut final_base = base_name.clone();
        let mut counter = 1;
        while assets_dir.join(format!("{}.png", final_base)).exists()
            || assets_dir.join(format!("{}.tldr", final_base)).exists()
        {
            final_base = format!("{}_{}", base_name, counter);
            counter += 1;
        }

        (
            format!("assets/{}.png", final_base),
            format!("assets/{}.tldr", final_base),
        )
    };

    let png_path = vault.join(&png_relative);
    let json_path = vault.join(&json_relative);

    // Write PNG file
    fs::write(&png_path, &png_data).map_err(|e| format!("Failed to write PNG: {}", e))?;

    // Write JSON file
    fs::write(&json_path, &json_data).map_err(|e| format!("Failed to write JSON: {}", e))?;

    log::error!("[Drawing] Saved: {} + {}", png_relative, json_relative);

    Ok(SaveDrawingResult {
        png_path: png_relative,
        json_path: json_relative,
    })
}

/// Load a drawing's JSON state from file
///
/// # Arguments
/// * `vault_path` - Absolute path to the vault
/// * `json_path` - Relative path to JSON file (e.g., "assets/drawing.tldr")
///
/// # Returns
/// JSON string content
#[tauri::command]
pub async fn load_drawing_json(vault_path: String, json_path: String) -> Result<String, String> {
    let vault = PathBuf::from(&vault_path);
    let full_path = vault.join(&json_path);

    if !full_path.exists() {
        return Err(format!("Drawing not found: {}", json_path));
    }

    let content =
        fs::read_to_string(&full_path).map_err(|e| format!("Failed to read drawing: {}", e))?;

    Ok(content)
}

/// Delete a drawing's files (both PNG and JSON)
///
/// # Arguments
/// * `vault_path` - Absolute path to the vault
/// * `png_path` - Relative path to PNG file
/// * `json_path` - Relative path to JSON file
#[tauri::command]
pub async fn delete_drawing(
    vault_path: String,
    png_path: Option<String>,
    json_path: Option<String>,
) -> Result<(), String> {
    let vault = PathBuf::from(&vault_path);

    // Delete PNG if exists
    if let Some(png) = png_path {
        let full_path = vault.join(&png);
        if full_path.exists() {
            fs::remove_file(&full_path).map_err(|e| format!("Failed to delete PNG: {}", e))?;
        }
    }

    // Delete JSON if exists
    if let Some(json) = json_path {
        let full_path = vault.join(&json);
        if full_path.exists() {
            fs::remove_file(&full_path).map_err(|e| format!("Failed to delete JSON: {}", e))?;
        }
    }

    Ok(())
}
