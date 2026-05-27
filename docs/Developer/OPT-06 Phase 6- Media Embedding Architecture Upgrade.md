# OPT-06 Phase 6: Media Embedding Architecture Upgrade

This plan addresses the serious performance bottlenecks and infinite-loop bugs discovered during Phase 4/5 testing, specifically:
- A single image being processed 8 times (taking ~4m 28s).
- Unstable LLM output causing chunk ID drift and infinite retry loops.
- Local model usage causing CPU/GPU monopolization and UI stuttering.
- Lack of result persistence and user control.

## Proposed Changes

### 1. Database Schema (`apps/desktop/src-tauri/src/core/db/migrations.rs`)

We will add a new migration (`V31`) to handle the media enrichment caching and `embeddings_v2` tracking.

#### [MODIFY] `embeddings_v2` Table
```sql
ALTER TABLE embeddings_v2 ADD COLUMN enriched_content TEXT DEFAULT '';
```

#### [NEW] `media_enrich_cache` Table
```sql
CREATE TABLE IF NOT EXISTS media_enrich_cache (
    asset_hash TEXT PRIMARY KEY,
    enriched_text TEXT NOT NULL,
    model_name TEXT NOT NULL,
    char_count INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
```

### 2. Worker Layer (`apps/desktop/src-tauri/src/core/embedding/worker.rs`)

#### [MODIFY] Worker Cycle Protection
Implement a processing lock to prevent overlapping worker cycles from fighting over the same notes.

#### [MODIFY] `schedule_note_for_embedding`
Detect media references (`![](assets/...)`).
- **Check `media_enrich_cache`**: If all assets are cached, use the cached text directly, chunk the document, and insert chunks with `status = 'pending'`.
- **If any miss**: Do NOT call `enrich_with_media` (Sidecar). Instead, insert a tracking record into `embeddings_v2` with `status = 'media_pending'`. The background worker will skip these records.

### 3. Pipeline & Orchestrator (`apps/desktop/src-tauri/src/core/embedding/pipeline.rs`)

#### [MODIFY] `enrich_with_media`
Modify this function to accept a `rusqlite::Connection`.
For each asset:
- Query `media_enrich_cache`. If hit, use the text (0 Sidecar calls).
- If miss, call Sidecar. Save the result into `media_enrich_cache` to ensure identical text is returned for future calls, completely eliminating chunk ID drift.

#### [MODIFY] `process_pending_paragraphs_with_vault`
Remove the inline `enrich_with_media` call here, as the scheduling layer (or the manual trigger) will now guarantee that the `content` being chunked is already enriched or that `enrich_with_media` is instant (100% cache hit).

### 4. Media Scheduler & Tauri Commands (`apps/desktop/src-tauri/src/core/embedding/media_scheduler.rs`)

#### [NEW] `media_scheduler.rs`
A dedicated handler for `media_pending` records.
- Sequentially processes images (no concurrency) to avoid GPU hogging.
- Triggered exclusively by user action from the frontend.
- When processing is complete, the `media_pending` record is deleted and `schedule_note_for_embedding` is re-run (which will now hit the cache and become `pending` for the normal BGE-M3 worker).

#### [NEW] Tauri Commands (e.g., in `commands/ai.rs` or `commands/embedding.rs`)
- `get_media_pending_count`: Returns the number of distinct `media_pending` jobs.
- `trigger_media_embedding`: Starts the `MediaScheduler`.
- `get_enriched_content`: Retrieves the LLM text for hover previews.

### 5. Frontend (`apps/desktop/src/features/...`)

#### [MODIFY] Status Bar
Add a media indexing status pill next to the word count:
- "📎 N media waiting" with a "Start" button.
- Progress indication when running (e.g., "Indexing 1/3...").

#### [NEW] Media Hover Preview
When hovering over an image in the editor, show a tooltip displaying the `enriched_content` fetched via `get_enriched_content`. If not yet indexed, display "📎 Pending Indexing — Click to start".

## User Review Required

> [!WARNING]
> Schema Modification: `ALTER TABLE embeddings_v2` will be executed. This is generally safe in SQLite, but please confirm if you want a complete table recreation (like V21) or just an `ALTER TABLE ADD COLUMN`. The `ALTER TABLE` is proposed for simplicity since there are no index changes.

## Verification Plan

### Automated Tests
- Run `cargo check` to ensure the new scheduler and pipeline compile correctly.
- Test the new V31 database migration on app startup.

### Manual Verification
1. Paste an image into a note. Verify the status bar shows "1 media waiting" and CPU usage remains flat (no automatic background LLM invocation).
2. Click "Start". Verify the Sidecar is called exactly once.
3. Paste the same image into a second note. Verify it instantly becomes `pending` for vectorization (cache hit) with zero Sidecar calls.
4. Hover over the image to ensure the LLM extracted text floats up.
