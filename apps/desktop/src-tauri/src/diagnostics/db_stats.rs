use crate::diagnostics::DiagnosticSource;
use serde_json::{json, Value};
use std::io::Write;
use tauri::{AppHandle, Manager};
use zip::{write::FileOptions, ZipWriter};
use crate::state::DbStateWrapper;

pub struct DbStatsSource;

impl DiagnosticSource for DbStatsSource {
    fn name(&self) -> &'static str {
        "DbStatsSource"
    }

    fn collect(
        &self,
        app: &AppHandle,
        zip: &mut ZipWriter<std::fs::File>,
        options: FileOptions<()>,
    ) -> Result<(), String> {
        let db_state = app.state::<DbStateWrapper>();
        
        let stats_map_result = db_state.0.with_connection(|conn| {
            // We use a Map to collect stats dynamically
            let mut stats_map = serde_json::Map::new();

        // 1. Schema Version
        let schema_ver: i32 = conn
            .query_row(
                "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);
        stats_map.insert("schema_version".to_string(), json!(schema_ver));

        // 2. Table Counts
        let tables = vec!["notes", "tasks", "embeddings_v2", "ai_usage_log", "ai_feedback", "ai_task_suggestions", "folder_embeddings"];
        let mut counts = serde_json::Map::new();
        for table in tables {
            let q = format!("SELECT COUNT(*) FROM {}", table);
            let count: i64 = conn.query_row(&q, [], |row| row.get(0)).unwrap_or(-1);
            counts.insert(table.to_string(), json!(count));
        }
        stats_map.insert("table_counts".to_string(), Value::Object(counts));

        // 3. Embeddings V2 Status Grouping
        let mut embed_stats = serde_json::Map::new();
        if let Ok(mut stmt) = conn.prepare("SELECT status, COUNT(*) FROM embeddings_v2 GROUP BY status") {
            if let Ok(mut rows) = stmt.query([]) {
                while let Ok(Some(row)) = rows.next() {
                    if let (Ok(status), Ok(count)) = (row.get::<_, String>(0), row.get::<_, i64>(1)) {
                        embed_stats.insert(status, json!(count));
                    }
                }
            }
        }
        stats_map.insert("embeddings_status".to_string(), Value::Object(embed_stats));

        // 4. AI Skill Config
        let mut ai_skills = Vec::new();
        if let Ok(mut stmt) = conn.prepare("SELECT skill_id, enabled, rule_active, rule_idle, rule_blur, rule_open FROM ai_skill_config") {
            if let Ok(mut rows) = stmt.query([]) {
                while let Ok(Some(row)) = rows.next() {
                    let skill_id: String = row.get(0).unwrap_or_default();
                    let enabled: i32 = row.get(1).unwrap_or(0);
                    let rule_active: Option<String> = row.get(2).ok();
                    let rule_idle: Option<String> = row.get(3).ok();
                    let rule_blur: Option<String> = row.get(4).ok();
                    let rule_open: Option<String> = row.get(5).ok();
                    
                    ai_skills.push(json!({
                        "skill_id": skill_id,
                        "enabled": enabled,
                        "rule_active": rule_active,
                        "rule_idle": rule_idle,
                        "rule_blur": rule_blur,
                        "rule_open": rule_open,
                    }));
                }
            }
        }
        stats_map.insert("ai_skill_config".to_string(), json!(ai_skills));

        // 5. Recent AI Failures (No private content, just error strings)
        let mut ai_failures = Vec::new();
        if let Ok(mut stmt) = conn.prepare("SELECT skill_id, provider, model, error_type, error_message, duration_ms, created_at FROM ai_usage_log WHERE status = 'failed' ORDER BY created_at DESC LIMIT 50") {
            if let Ok(mut rows) = stmt.query([]) {
                while let Ok(Some(row)) = rows.next() {
                    ai_failures.push(json!({
                        "skill_id": row.get::<_, String>(0).unwrap_or_default(),
                        "provider": row.get::<_, String>(1).unwrap_or_default(),
                        "model": row.get::<_, String>(2).unwrap_or_default(),
                        "error_type": row.get::<_, Option<String>>(3).unwrap_or_default(),
                        "error_message": row.get::<_, Option<String>>(4).unwrap_or_default(),
                        "duration_ms": row.get::<_, i64>(5).unwrap_or(0),
                        "created_at": row.get::<_, i64>(6).unwrap_or(0),
                    }));
                }
            }
        }
        stats_map.insert("recent_ai_failures".to_string(), json!(ai_failures));

        Ok(stats_map)
        });

        match stats_map_result {
            Ok(stats_map) => {
                if zip.start_file("data/db_diagnostics.json", options).is_ok() {
                    let pretty_json = serde_json::to_string_pretty(&stats_map).unwrap_or_default();
                    let _ = zip.write_all(pretty_json.as_bytes());
                }
            }
            Err(e) => {
                log::warn!("[Diagnostics] Failed to collect db stats: {}", e);
            }
        }

        Ok(())
    }
}
