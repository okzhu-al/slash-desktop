import re

with open("apps/desktop/src-tauri/src/commands/ai/orchestrator.rs", "r") as f:
    original = f.read()

# Remove the execution lock variables
text = re.sub(r'// ============================================================================\n// Execution Lock \(Prevent concurrent execution on same note\)\n// ============================================================================\n\n.*?fn release_execution_lock.*?}\n\n', '', original, flags=re.DOTALL)

# Refactor trigger_ai_orchestrated
trigger_replacement = """
#[tauri::command]
pub async fn trigger_ai_orchestrated(
    trigger_type: String,
    note_path: String,
    content: String,
    db_state: State<'_, DbStateWrapper>,
    ai_state: State<'_, AIStateWrapper>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let content_chars = content.chars().count();
    if content_chars == 0 {
        return Ok("skipped:empty".to_string());
    }

    let vault_path = db_state.0.vault_path.lock().unwrap().clone().ok_or("Vault path not set")?;
    let relative_path = std::path::Path::new(&note_path)
        .strip_prefix(&vault_path)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or(note_path.clone());
    let content_hash = slash_core::calculate_content_hash(&content);

    // Queue for execution
    if let Some(queue) = ai_state.queue.get() {
        let job = crate::core::ai::queue::FastJob {
            note_path: relative_path,
            content,
            hash: content_hash,
            trigger_type,
        };
        let _ = queue.submit_fast(job).await;
        Ok("AI orchestrated processing queued".to_string())
    } else {
        Err("AI Queue not initialized".to_string())
    }
}

pub async fn process_fast_job(
    app_handle: tauri::AppHandle,
    trigger_type: String,
    relative_path_clone: String,
    content_clone: String,
    content_hash_clone: String,
) {
    use tauri::Manager;
    let db_state = app_handle.state::<DbStateWrapper>();
    let ai_state = app_handle.state::<AIStateWrapper>();

    let editor_state = match trigger_type.as_str() {
        "on_open" => EditorState::Open,
        "on_button" | "on_blur" | "on_save" => EditorState::Blur,
        "on_idle" | "on_idle_embedding" => EditorState::Idle,
        "on_change" | "on_active" => EditorState::Active,
        _ => { eprintln!("Unknown trigger type: {}", trigger_type); return; }
    };

    let vault_path_clone = match db_state.0.vault_path.lock().unwrap().clone() {
        Some(p) => p,
        None => return,
    };
    let db_path = std::path::Path::new(&vault_path_clone).join(".slash").join("slash.db");

    let mut service = ai_state.service().clone();
    let runtime = ai_state.runtime.clone();
    let app_handle_clone = app_handle.clone();
"""

text = re.sub(r'#\[tauri::command\]\npub fn trigger_ai_orchestrated.*?let app_handle_clone = app_handle\.clone\(\);', trigger_replacement, text, flags=re.DOTALL)

tail_replacement = """
    // Avoid double-wrapping since we're already async
    let conn = match rusqlite::Connection::open(&db_path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("❌ [Orchestrator] Failed to open DB: {}", e);
            return;
        }
    };
"""

text = re.sub(r'    // Spawn background task\n    std::thread::spawn\(move \|\| \{\n        runtime\.block_on\(async \{\n            // Open DB connection\n            let conn = match rusqlite::Connection::open\(&db_path\) \{\n                Ok\(c\) => c,\n                Err\(e\) => \{\n                    eprintln!\("❌ \[Orchestrator\] Failed to open DB: \{\}", e\);\n                    return;\n                \}\n            \};\n\n            // P-009/P-011: Acquire execution lock to prevent concurrent execution\n            if !try_acquire_execution_lock\(&relative_path_clone\) \{\n                eprintln!\("⏭️ \[Orchestrator\] Skipping \{\} - already executing", relative_path_clone\);\n                return;\n            \}\n            // Ensure lock is released when we exit this scope\n            // Use Rc<RefCell> to allow adding new paths during execution \(e\.g\., after rename\)\n            use std::cell::RefCell;\n            use std::rc::Rc;\n            struct LockGuard\(Rc<RefCell<Vec<String>>>\);\n            impl Drop for LockGuard \{\n                fn drop\(&mut self\) \{\n                    for path in self\.0\.borrow\(\)\.iter\(\) \{\n                        release_execution_lock\(path\);\n                    \}\n                \}\n            \}\n            let locked_paths = Rc::new\(RefCell::new\(vec!\[relative_path_clone\.clone\(\)\]\)\);\n            let _lock_guard = LockGuard\(locked_paths\.clone\(\)\);', tail_replacement, text, flags=re.DOTALL)

text = re.sub(r'}, editor_state\n                \);\n\n                // Guard: clean up stale', r'}, editor_state\n                );\n\n                // Guard: clean up stale', text)

text = text.replace("""            // Emit completion event for frontend UI state
            let _ = app_handle_clone.emit(
                "ai:note-updated",
                serde_json::json!({
                    "path": current_path,
                    "status": "done",
                    "skills": [],
                    "state": format!("{:?}", editor_state),
                    "hash_changed": hash_changed,
                }),
            );
        });
    });

    Ok("AI orchestrated processing started".to_string())
}""", """            // Emit completion event for frontend UI state
            let _ = app_handle_clone.emit(
                "ai:note-updated",
                serde_json::json!({
                    "path": current_path,
                    "status": "done",
                    "skills": [],
                    "state": format!("{:?}", editor_state),
                    "hash_changed": hash_changed,
                }),
            );
}""")

with open("apps/desktop/src-tauri/src/commands/ai/orchestrator.rs", "w") as f:
    f.write(text)

