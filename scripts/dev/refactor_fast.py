import re

with open("apps/desktop/src-tauri/src/commands/ai/orchestrator.rs", "r") as f:
    text = f.read()

trigger_ai_match = re.search(r'#\[tauri::command\]\npub fn trigger_ai_orchestrated\((.*?)\) -> Result<String, String> \{(.*?)\n}\n\n// ===', text, re.DOTALL)

if trigger_ai_match:
    original = trigger_ai_match.group(0)
    
    body = trigger_ai_match.group(2)
    # The new orchestrator command
    command_str = """#[tauri::command]
pub async fn trigger_ai_orchestrated(
    trigger_type: String,
    note_path: String,
    content: String,
    db_state: tauri::State<'_, DbStateWrapper>,
    ai_state: tauri::State<'_, AIStateWrapper>,
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
"""
    
    # We take the content inside `runtime.block_on(async {`
    inner_block_match = re.search(r'runtime\.block_on\(async \{(.*?\n)        \}\);\n    \}\);\n\n    Ok\("AI orchestrated processing started"\.to_string\(\)\)', body, re.DOTALL)
    
    if inner_block_match:
        inner_block = inner_block_match.group(1)
        
        # Unindent inner block
        inner_lines = inner_block.split('\n')
        unindented = [line[12:] if line.startswith('            ') else line for line in inner_lines]
        inner_block = '\n'.join(unindented)
        
        # Let's add the setup block for inner_block
        setup_block = """    use tauri::Manager;
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
        
        # Remove execution lock setup
        inner_block = re.sub(r'// P-009/P-011: Acquire execution lock to prevent concurrent execution\nif !try_acquire_execution_lock\(&relative_path_clone\) \{\n    eprintln!\("⏭️ \[Orchestrator\] Skipping \{\} - already executing", relative_path_clone\);\n    return;\n\}\n// Ensure lock is released when we exit this scope\n// Use Rc<RefCell> to allow adding new paths during execution \(e\.g\., after rename\)\nuse std::cell::RefCell;\nuse std::rc::Rc;\nstruct LockGuard\(Rc<RefCell<Vec<String>>>\);\nimpl Drop for LockGuard \{\n    fn drop\(&mut self\) \{\n        for path in self\.0\.borrow\(\)\.iter\(\) \{\n            release_execution_lock\(path\);\n        \}\n    \}\n\}\nlet locked_paths = Rc::new\(RefCell::new\(vec!\[relative_path_clone\.clone\(\)\]\)\);\nlet _lock_guard = LockGuard\(locked_paths\.clone\(\)\);\n', '', inner_block)

        # Merge setup and inner block
        complete_func = command_str + setup_block + inner_block + "\n}\n\n// ==="
        
        text = text.replace(original, complete_func)

with open("apps/desktop/src-tauri/src/commands/ai/orchestrator.rs", "w") as f:
    f.write(text)
