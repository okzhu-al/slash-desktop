import re

with open("apps/desktop/src-tauri/src/commands/ai/orchestrator.rs", "r") as f:
    text = f.read()

def extract_and_refactor(text, function_name, process_name, block_start, queue_enum):
    # Find the function boundary
    pattern = rf'#\[tauri::command\]\npub async fn {function_name}\(.*?\) -> Result<(.*?), String> \{{(.*?\n)\n\n///'
    match = re.search(pattern, text, re.DOTALL)
    if not match:
        pattern = rf'#\[tauri::command\]\npub async fn {function_name}\(.*?\) -> Result<(.*?), String> \{{(.*?\n)\n///'
        match = re.search(pattern, text, re.DOTALL)

    if match:
        result_type = match.group(1)
        body = match.group(2)
        
        # Build the queue submitter
        new_command = f"""#[tauri::command]
pub async fn {function_name}(
    note_path: String,
    content: String,
    db_state: tauri::State<'_, DbStateWrapper>,
    ai_state: tauri::State<'_, AIStateWrapper>,
    app_handle: tauri::AppHandle,
) -> Result<{result_type}, String> {{
    if let Some(queue) = ai_state.queue.get() {{
        let (tx, rx) = tokio::sync::oneshot::channel();
        let hash = slash_core::calculate_content_hash(&content);
        let job = crate::core::ai::queue::HeavyJob::{queue_enum} {{
            note_path,
            content,
            hash,
            responder: tx,
        }};
        let _ = queue.submit_heavy(job).await;
        rx.await.unwrap_or_else(|_| Err("Queue communication failed".to_string()))
    }} else {{
        Err("AI Queue not initialized".to_string())
    }}
}}

pub async fn {process_name}(
    app_handle: tauri::AppHandle,
    note_path: String,
    content: String,
    content_hash: String,
) -> Result<{result_type}, String> {{
    use tauri::Manager;
    let db_state = app_handle.state::<DbStateWrapper>();
    let ai_state = app_handle.state::<AIStateWrapper>();
"""

        # Cleanup locks
        body = re.sub(r'    // P-009: Execution lock — prevent concurrent AI processing on same note\n    if !try_acquire_execution_lock\(&relative_path\) \{\n        return Ok\(SkillResult \{ status: "skipped"\.into\(\), data: None, timestamp: 0 \}\);\n    \}\n    struct AtomicLockGuard\(String\);\n    impl Drop for AtomicLockGuard \{ fn drop\(&mut self\) \{ release_execution_lock\(&self\.0\); \} \}\n    let _lock = AtomicLockGuard\(relative_path\.clone\(\)\);\n', '', body, flags=re.DOTALL)
        body = re.sub(r'    let content_hash = calculate_content_hash\(&content\);\n', '', body)

        # Remove lock from smart rename
        body = re.sub(r'    if !try_acquire_execution_lock\(&relative_path\) \{\n        return Ok\(RenameResult \{ status: "skipped"\.into\(\), old_path: note_path\.clone\(\), new_path: "".into\(\), new_title: "".into\(\) \}\);\n    \}\n    struct AtomicRenameLockGuard\(String\);\n    impl Drop for AtomicRenameLockGuard \{ fn drop\(&mut self\) \{ release_execution_lock\(&self\.0\); \} \}\n    let _lock = AtomicRenameLockGuard\(relative_path\.clone\(\)\);\n', '', body, flags=re.DOTALL)

        new_command += body + "\n}\n\n///"
        text = text.replace(match.group(0), new_command)
    return text

text = extract_and_refactor(text, "run_summary", "process_heavy_summary", "✨ [Atomic] run_summary", "Summarize")
text = extract_and_refactor(text, "run_tagging", "process_heavy_tagging", "✨ [Atomic] run_tagging", "Tagging")
text = extract_and_refactor(text, "run_smart_rename", "process_heavy_rename", "✨ [Atomic] run_smart_rename", "SmartRename")

with open("apps/desktop/src-tauri/src/commands/ai/orchestrator.rs", "w") as f:
    f.write(text)

