use crate::diagnostics::DiagnosticSource;
use serde_json::Value;
use std::fs;
use std::io::Write;
use tauri::{AppHandle, Manager};
use zip::{write::FileOptions, ZipWriter};

pub struct ConfigMaskerSource;

impl ConfigMaskerSource {
    fn mask_json_value(val: &mut Value) {
        match val {
            Value::Object(map) => {
                for (k, v) in map.iter_mut() {
                    let k_lower = k.to_lowercase();
                    // Sensitive keywords to mask
                    if k_lower.contains("api_key")
                        || k_lower.contains("password")
                        || k_lower.contains("token")
                        || k_lower.contains("secret")
                        || k_lower.contains("credential")
                    {
                        if v.is_string() {
                            *v = Value::String("********".to_string());
                        } else if !v.is_null() {
                            // If it's a number/boolean/array and marked sensitive, still mask it somehow
                            *v = Value::String("********".to_string());
                        }
                    } else {
                        Self::mask_json_value(v);
                    }
                }
            }
            Value::Array(arr) => {
                for item in arr.iter_mut() {
                    Self::mask_json_value(item);
                }
            }
            _ => {}
        }
    }
}

impl DiagnosticSource for ConfigMaskerSource {
    fn name(&self) -> &'static str {
        "ConfigMaskerSource"
    }

    fn collect(
        &self,
        app: &AppHandle,
        zip: &mut ZipWriter<std::fs::File>,
        options: FileOptions<()>,
    ) -> Result<(), String> {
        let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;

        // Add any JSON configuration files that might exist in the app data dir.
        // Currently we know about ai_config.json, maybe others in the future.
        let target_files = vec!["ai_config.json", "settings.json"];

        for file_name in target_files {
            let file_path = data_dir.join(file_name);
            if file_path.exists() {
                if let Ok(raw_str) = fs::read_to_string(&file_path) {
                    let content_to_write = if let Ok(mut json_val) = serde_json::from_str::<Value>(&raw_str) {
                        Self::mask_json_value(&mut json_val);
                        serde_json::to_string_pretty(&json_val).unwrap_or(raw_str)
                    } else {
                        // Not valid JSON? Just mask the whole file to be safe if we can't parse it
                        String::from("******** [Failed to parse JSON]")
                    };

                    let zip_path = format!("config/{}", file_name);
                    if zip.start_file(zip_path, options.clone()).is_ok() {
                        let _ = zip.write_all(content_to_write.as_bytes());
                    }
                }
            }
        }

        Ok(())
    }
}
