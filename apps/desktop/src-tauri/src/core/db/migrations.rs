use rusqlite::{Connection, Result as SqliteResult};

/// Helper function to safely add a column to a table only if it does not already exist.
/// This prevents "duplicate column name" errors during migrations on fresh installs
/// where the initial schema.sql may already contain columns added in later migrations.
fn add_column_if_not_exists(
    conn: &Connection,
    table: &str,
    column: &str,
    col_def: &str,
) -> SqliteResult<()> {
    let column_exists: bool = conn
        .query_row(
            &format!(
                "SELECT count(*) FROM pragma_table_info('{}') WHERE name='{}'",
                table, column
            ),
            [],
            |row| row.get::<_, i32>(0),
        )
        .map(|count| count > 0)
        .unwrap_or(false);

    if !column_exists {
        conn.execute(
            &format!("ALTER TABLE {} ADD COLUMN {} {}", table, column, col_def),
            [],
        )?;
    }
    Ok(())
}

// ============================================================
// Database Migrations (V1-V32) + FTS5 Repair
// ============================================================

/// V1 migration: Initial schema
pub fn migrate_v1(conn: &Connection) -> SqliteResult<()> {
    conn.execute_batch(include_str!("schema.sql"))?;

    // Record migration
    conn.execute("INSERT INTO schema_version (version) VALUES (1)", [])?;

    Ok(())
}

/// V2 migration: (legacy - ai_feedback_logs removed in V24, creation skipped)
pub fn migrate_v2(conn: &Connection) -> SqliteResult<()> {
    // ai_feedback_logs was created here originally but dropped in V24.
    // Skipping creation to avoid create-then-drop on fresh installs.

    // Record migration
    conn.execute("INSERT INTO schema_version (version) VALUES (2)", [])?;

    Ok(())
}

/// V3 migration: (legacy - ai_feedback_logs columns removed in V24, ALTER skipped)
pub fn migrate_v3(conn: &Connection) -> SqliteResult<()> {
    // ai_feedback_logs ALTER TABLE was here originally but table dropped in V24.
    // Skipping to avoid errors on fresh installs.

    // Record migration
    conn.execute("INSERT INTO schema_version (version) VALUES (3)", [])?;

    Ok(())
}

/// V4 migration: AI Skill configuration table
pub fn migrate_v4(conn: &Connection) -> SqliteResult<()> {
    conn.execute_batch(
        r#"
        -- AI Skill Configuration: User-customizable trigger settings
        CREATE TABLE IF NOT EXISTS ai_skill_config (
            skill_id TEXT PRIMARY KEY,
            enabled INTEGER DEFAULT 1,
            on_button INTEGER DEFAULT 1,
            on_blur INTEGER DEFAULT 1,
            on_idle_enabled INTEGER DEFAULT 1,
            on_idle_delay_ms INTEGER DEFAULT 5000,
            updated_at INTEGER DEFAULT (unixepoch())
        );
        
        -- Insert default configurations
        INSERT OR IGNORE INTO ai_skill_config (skill_id, on_idle_delay_ms) VALUES ('tagging', 5000);
        INSERT OR IGNORE INTO ai_skill_config (skill_id, on_idle_delay_ms) VALUES ('summarization', 10000);
        INSERT OR IGNORE INTO ai_skill_config (skill_id, on_idle_enabled, on_idle_delay_ms) VALUES ('embedding', 0, 0);
        "#,
    )?;

    conn.execute("INSERT INTO schema_version (version) VALUES (4)", [])?;

    Ok(())
}

/// V5 migration: GhostLink skill configuration
pub fn migrate_v5(conn: &Connection) -> SqliteResult<()> {
    // Add config column if not exists (for storing JSON like similarity_threshold)
    let _ = add_column_if_not_exists(conn, "ai_skill_config", "config", "TEXT DEFAULT '{}'");

    // Insert ghostlink configuration with default similarity threshold
    conn.execute(
        r#"INSERT OR IGNORE INTO ai_skill_config 
           (skill_id, enabled, on_button, on_blur, on_idle_enabled, on_idle_delay_ms, config) 
           VALUES ('ghostlink', 1, 0, 1, 0, 0, '{"similarity_threshold": 0.60}')"#,
        [],
    )?;

    conn.execute("INSERT INTO schema_version (version) VALUES (5)", [])?;

    Ok(())
}

/// V6 migration: Ghost Link blacklist table
pub fn migrate_v6(conn: &Connection) -> SqliteResult<()> {
    conn.execute_batch(
        r#"
        -- Ghost Link blacklist: user-ignored recommendations
        CREATE TABLE IF NOT EXISTS ghost_link_blacklist (
            source_path TEXT NOT NULL,
            target_path TEXT NOT NULL,
            created_at INTEGER DEFAULT (unixepoch()),
            PRIMARY KEY (source_path, target_path)
        );
        
        CREATE INDEX IF NOT EXISTS idx_blacklist_source ON ghost_link_blacklist(source_path);
        "#,
    )?;

    conn.execute("INSERT INTO schema_version (version) VALUES (6)", [])?;

    Ok(())
}

/// V7 migration: AI Suggestion Cache for reasoning results
pub fn migrate_v7(conn: &Connection) -> SqliteResult<()> {
    conn.execute_batch(
        r#"
        -- AI Suggestion Cache: mtime-based caching for LLM reasoning results
        CREATE TABLE IF NOT EXISTS ai_suggestion_cache (
            source_path TEXT NOT NULL,
            target_path TEXT NOT NULL,
            source_mtime INTEGER NOT NULL,
            target_mtime INTEGER NOT NULL,
            relation TEXT NOT NULL,
            reason TEXT NOT NULL,
            created_at INTEGER DEFAULT (unixepoch()),
            PRIMARY KEY (source_path, target_path)
        );
        
        CREATE INDEX IF NOT EXISTS idx_cache_source ON ai_suggestion_cache(source_path);
        "#,
    )?;

    conn.execute("INSERT INTO schema_version (version) VALUES (7)", [])?;

    Ok(())
}

/// V8 migration: Tag dictionary for RAG
pub fn migrate_v8(conn: &Connection) -> SqliteResult<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS tag_dictionary (
            name TEXT PRIMARY KEY,
            aliases TEXT,
            category TEXT,
            usage_count INTEGER DEFAULT 0,
            created_at INTEGER DEFAULT (unixepoch()),
            updated_at INTEGER DEFAULT (unixepoch())
        );
        "#,
    )?;

    conn.execute("INSERT INTO schema_version (version) VALUES (8)", [])?;

    Ok(())
}

/// V9 migration: AI Skill State for orchestrator persistence
pub fn migrate_v9(conn: &Connection) -> SqliteResult<()> {
    conn.execute_batch(
        r#"
        -- AI Skill State: Track execution state for each note × skill combination
        -- Used by AIScheduler for content-hash based deduplication and cooldown tracking
        CREATE TABLE IF NOT EXISTS ai_skill_state (
            note_path TEXT NOT NULL,
            skill_id TEXT NOT NULL,
            last_content_hash TEXT,           -- SHA-256 hash of content when skill last executed
            last_run_time INTEGER,            -- Unix timestamp (ms) of last execution
            execution_count INTEGER DEFAULT 0, -- Total times this skill ran on this note
            last_result TEXT,                 -- 'success' | 'failed' | 'skipped'
            updated_at INTEGER DEFAULT (unixepoch()),
            PRIMARY KEY (note_path, skill_id)
        );
        
        CREATE INDEX IF NOT EXISTS idx_skill_state_note ON ai_skill_state(note_path);
        CREATE INDEX IF NOT EXISTS idx_skill_state_skill ON ai_skill_state(skill_id);
        "#,
    )?;

    conn.execute("INSERT INTO schema_version (version) VALUES (9)", [])?;

    Ok(())
}
/// V10 migration: Add rule_expression columns for per-state rule configuration
pub fn migrate_v10(conn: &Connection) -> SqliteResult<()> {
    // Add rule expression columns for each state
    // Store JSON-serialized RuleExpression for each state
    let _ = add_column_if_not_exists(conn, "ai_skill_config", "rule_active", "TEXT DEFAULT NULL");
    let _ = add_column_if_not_exists(conn, "ai_skill_config", "rule_idle", "TEXT DEFAULT NULL");
    let _ = add_column_if_not_exists(conn, "ai_skill_config", "rule_blur", "TEXT DEFAULT NULL");

    // Set default rule templates for existing skills
    // embedding: Active=cooldown_and_change, Idle=once_per_state, Blur=immediate
    conn.execute(
        r#"UPDATE ai_skill_config SET 
           rule_active = '{"op": "ref", "name": "cooldown_and_change"}',
           rule_idle = '{"op": "ref", "name": "once_per_state"}',
           rule_blur = '{"op": "always"}'
           WHERE skill_id = 'embedding'"#,
        [],
    )?;

    // tagging: Active=disabled, Idle=once_per_state, Blur=immediate
    conn.execute(
        r#"UPDATE ai_skill_config SET 
           rule_active = '{"op": "never"}',
           rule_idle = '{"op": "ref", "name": "once_per_state"}',
           rule_blur = '{"op": "always"}'
           WHERE skill_id = 'tagging'"#,
        [],
    )?;

    // summarization: Active=disabled, Idle=once_and_change_10pct, Blur=immediate
    conn.execute(
        r#"UPDATE ai_skill_config SET 
           rule_active = '{"op": "never"}',
           rule_idle = '{"op": "ref", "name": "once_and_change_10pct"}',
           rule_blur = '{"op": "always"}'
           WHERE skill_id = 'summarization'"#,
        [],
    )?;

    // ghostlink: Active=disabled, Idle=once_per_state, Blur=immediate
    conn.execute(
        r#"UPDATE ai_skill_config SET 
           rule_active = '{"op": "never"}',
           rule_idle = '{"op": "ref", "name": "once_per_state"}',
           rule_blur = '{"op": "always"}'
           WHERE skill_id = 'ghostlink'"#,
        [],
    )?;

    conn.execute("INSERT INTO schema_version (version) VALUES (10)", [])?;

    Ok(())
}

/// V11 migration: Add rule_open column for Open state in four-state model
pub fn migrate_v11(conn: &Connection) -> SqliteResult<()> {
    log::debug!("📦 [DB] Running V11 migration: Add rule_open column");

    // Add rule_open column
    add_column_if_not_exists(conn, "ai_skill_config", "rule_open", "TEXT")?;

    // Set default values based on plan:
    // - embedding/tagging/summarization: Open = never (don't run on load)
    // - ghostlink: Open = always (show recommendations on load)
    conn.execute(
        r#"UPDATE ai_skill_config SET rule_open = '{"op": "never"}'
           WHERE skill_id IN ('embedding', 'tagging', 'summarization')"#,
        [],
    )?;

    conn.execute(
        r#"UPDATE ai_skill_config SET rule_open = '{"op": "always"}'
           WHERE skill_id = 'ghostlink'"#,
        [],
    )?;

    conn.execute("INSERT INTO schema_version (version) VALUES (11)", [])?;

    Ok(())
}

/// V12 migration: Add char_count column for delta calculation
pub fn migrate_v12(conn: &Connection) -> SqliteResult<()> {
    // Add char_count column to ai_skill_state for delta calculation
    add_column_if_not_exists(conn, "ai_skill_state", "char_count", "INTEGER DEFAULT 0")?;

    conn.execute("INSERT INTO schema_version (version) VALUES (12)", [])?;

    Ok(())
}

/// V13 migration: Add ai_title and user_title for intelligent renaming
pub fn migrate_v13(conn: &Connection) -> SqliteResult<()> {
    log::debug!("📦 [DB] Running V13 migration: Add ai_title/user_title columns");

    // ai_title: AI-generated suggested title for default-named notes
    add_column_if_not_exists(conn, "notes", "ai_title", "TEXT DEFAULT NULL")?;

    // user_title: User-confirmed title (takes precedence over ai_title)
    add_column_if_not_exists(conn, "notes", "user_title", "TEXT DEFAULT NULL")?;

    // Add smart_rename skill configuration
    conn.execute(
        r#"INSERT OR IGNORE INTO ai_skill_config 
           (skill_id, enabled, on_button, on_blur, on_idle_enabled, on_idle_delay_ms, rule_active, rule_idle, rule_blur, rule_open) 
           VALUES ('smart_rename', 1, 0, 1, 1, 5000, 
                   '{"op": "never"}',
                   '{"op": "ref", "name": "once_per_state"}',
                   '{"op": "always"}',
                   '{"op": "never"}')
         "#,
        [],
    )?;

    conn.execute("INSERT INTO schema_version (version) VALUES (13)", [])?;

    Ok(())
}

/// V14 migration: Tasks table for task metadata extraction
pub fn migrate_v14(conn: &Connection) -> SqliteResult<()> {
    log::debug!("📦 [DB] Running V14 migration: Create tasks table");

    conn.execute_batch(
        r#"
        -- Tasks: Extracted task metadata from markdown
        CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            note_path TEXT NOT NULL,           -- Associated note path
            line_number INTEGER NOT NULL,      -- Line number in the note
            raw_text TEXT NOT NULL,            -- Original task text
            is_completed BOOLEAN DEFAULT 0,   -- Whether task is done
            
            -- Metadata (independently extracted, nullable)
            due_date TEXT,                     -- ISO date: "2026-01-25"
            assignee TEXT,                     -- Username: "老王"
            priority TEXT,                     -- "high" | "medium" | "low"
            
            -- Timestamps
            created_at INTEGER DEFAULT (unixepoch()),
            updated_at INTEGER DEFAULT (unixepoch()),
            
            FOREIGN KEY(note_path) REFERENCES notes(path) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_tasks_note ON tasks(note_path);
        CREATE INDEX IF NOT EXISTS idx_tasks_date ON tasks(due_date);
        CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee);
        CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
        CREATE INDEX IF NOT EXISTS idx_tasks_completed ON tasks(is_completed);
        "#,
    )?;

    conn.execute("INSERT INTO schema_version (version) VALUES (14)", [])?;

    Ok(())
}

/// V15 migration: AI Task Suggestions table
pub fn migrate_v15(conn: &Connection) -> SqliteResult<()> {
    log::debug!("📦 [DB] Running V15 migration: Create ai_task_suggestions table");

    conn.execute_batch(
        r#"
        -- AI Task Suggestions: Tasks extracted by AI from note content
        CREATE TABLE IF NOT EXISTS ai_task_suggestions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            note_path TEXT NOT NULL,           -- Source note path
            raw_text TEXT NOT NULL,            -- Cleaned task description
            original_text TEXT NOT NULL,       -- Original quote from note (for highlighting)
            suggested_date TEXT,               -- AI suggested due date
            suggested_assignee TEXT,           -- AI suggested assignee
            suggested_priority TEXT,           -- AI suggested priority
            status TEXT DEFAULT 'pending',     -- pending/accepted/dismissed
            created_at INTEGER DEFAULT (unixepoch()),
            
            FOREIGN KEY(note_path) REFERENCES notes(path) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_ai_suggestions_note ON ai_task_suggestions(note_path);
        CREATE INDEX IF NOT EXISTS idx_ai_suggestions_status ON ai_task_suggestions(status);
        "#,
    )?;

    conn.execute("INSERT INTO schema_version (version) VALUES (15)", [])?;

    Ok(())
}

/// V16 migration: Folder embeddings table for Smart Classification
pub fn migrate_v16(conn: &Connection) -> SqliteResult<()> {
    log::debug!("📦 [DB] Running V16 migration: Create folder_embeddings table");

    conn.execute_batch(
        r#"
        -- Folder Embeddings: Cached embeddings for Smart Classification
        CREATE TABLE IF NOT EXISTS folder_embeddings (
            folder_path TEXT PRIMARY KEY,       -- Relative path (e.g., "01_Projects/Slash")
            embedding BLOB,                     -- BGE-m3 embedding (1024 float32)
            semantic_profile TEXT,              -- The text string used to generate embedding (for debugging)
            last_calculated_at INTEGER,         -- Unix timestamp of last embedding calculation
            is_dirty INTEGER DEFAULT 1,         -- 1=needs recalculation, 0=up-to-date
            access_count INTEGER DEFAULT 0,     -- How many times this folder was written to
            last_active_at INTEGER              -- Last time a file was added/modified in this folder
        );

        CREATE INDEX IF NOT EXISTS idx_folder_dirty ON folder_embeddings(is_dirty);
        CREATE INDEX IF NOT EXISTS idx_folder_active ON folder_embeddings(last_active_at);

        -- Add classification skill configuration
        INSERT OR IGNORE INTO ai_skill_config 
           (skill_id, enabled, on_button, on_blur, on_idle_enabled, on_idle_delay_ms, 
            rule_active, rule_idle, rule_blur, rule_open) 
           VALUES ('classification', 1, 1, 0, 0, 0, 
                   '{"op": "never"}',
                   '{"op": "never"}',
                   '{"op": "never"}',
                   '{"op": "never"}');
        "#,
    )?;

    conn.execute("INSERT INTO schema_version (version) VALUES (16)", [])?;

    Ok(())
}

/// V17 migration: Classification cache table
pub fn migrate_v17(conn: &Connection) -> SqliteResult<()> {
    log::debug!("📦 [DB] Running V17 migration: Create classification_cache table");

    conn.execute_batch(
        r#"
        -- Classification Cache: Cache AI classification results to avoid redundant calls
        CREATE TABLE IF NOT EXISTS classification_cache (
            note_path TEXT PRIMARY KEY,         -- Relative path of the note
            content_hash TEXT NOT NULL,         -- SHA-256 hash of content when cached
            suggestions TEXT NOT NULL,          -- JSON serialized ClassificationResult
            has_pending_tasks INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
        );

        CREATE INDEX IF NOT EXISTS idx_classification_hash ON classification_cache(content_hash);
        "#,
    )?;

    conn.execute("INSERT INTO schema_version (version) VALUES (17)", [])?;

    Ok(())
}

/// V18 migration: FTS5 full-text search index
pub fn migrate_v18(conn: &Connection) -> SqliteResult<()> {
    log::debug!("📦 [DB] Running V18 migration: Create FTS5 full-text search index");

    // Ensure notes table has ai_summary and ai_tags columns before building FTS
    // (They might be missing on fresh installs using the updated V1 schema.sql,
    //  but they are required here because they are later migrated and dropped in V31/V32)
    add_column_if_not_exists(conn, "notes", "ai_summary", "TEXT")?;
    add_column_if_not_exists(conn, "notes", "ai_tags", "TEXT")?;

    conn.execute_batch(
        r#"
        -- FTS5 Virtual Table for full-text search
        -- Uses external content mode for efficient storage
        CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
            path,
            title,
            ai_summary,
            ai_tags,
            user_tags,
            content='notes',
            content_rowid='id',
            tokenize='unicode61 remove_diacritics 2'
        );

        -- Populate FTS index from existing notes
        INSERT INTO notes_fts(notes_fts) VALUES('rebuild');
        "#,
    )?;

    conn.execute("INSERT INTO schema_version (version) VALUES (18)", [])?;

    Ok(())
}

/// V19 migration: FTS5 auto-sync triggers
/// Automatically keeps notes_fts synchronized with notes table
pub fn migrate_v19(conn: &Connection) -> SqliteResult<()> {
    log::debug!("📦 [DB] Running V19 migration: Create FTS5 auto-sync triggers");

    conn.execute_batch(
        r#"
        -- Trigger: After INSERT on notes, add to FTS index
        CREATE TRIGGER IF NOT EXISTS notes_fts_insert AFTER INSERT ON notes BEGIN
            INSERT INTO notes_fts(rowid, path, title, ai_summary, ai_tags, user_tags)
            VALUES (NEW.id, NEW.path, NEW.title, NEW.ai_summary, NEW.ai_tags, NEW.user_tags);
        END;

        -- Trigger: After UPDATE on notes, update FTS index
        -- FTS5 external content requires DELETE + INSERT to update
        CREATE TRIGGER IF NOT EXISTS notes_fts_update AFTER UPDATE ON notes BEGIN
            DELETE FROM notes_fts WHERE rowid = OLD.id;
            INSERT INTO notes_fts(rowid, path, title, ai_summary, ai_tags, user_tags)
            VALUES (NEW.id, NEW.path, NEW.title, NEW.ai_summary, NEW.ai_tags, NEW.user_tags);
        END;

        -- Trigger: After DELETE on notes, remove from FTS index
        CREATE TRIGGER IF NOT EXISTS notes_fts_delete AFTER DELETE ON notes BEGIN
            DELETE FROM notes_fts WHERE rowid = OLD.id;
        END;

        -- Rebuild FTS index to ensure consistency after adding triggers
        INSERT INTO notes_fts(notes_fts) VALUES('rebuild');
        "#,
    )?;

    conn.execute("INSERT INTO schema_version (version) VALUES (19)", [])?;

    log::debug!("✅ [DB] V19 migration complete: FTS5 triggers created");
    Ok(())
}

/// V20 migration: Embedding Pipeline v2 table
/// Supports multi-product vectors, hash-based dedup, versioning, and job status tracking
pub fn migrate_v20(conn: &Connection) -> SqliteResult<()> {
    log::debug!("📦 [DB] Running V20 migration: Create embeddings_v2 table");

    conn.execute_batch(
        r#"
        -- Embedding Pipeline v2: Multi-product vectors with full lifecycle tracking
        CREATE TABLE IF NOT EXISTS embeddings_v2 (
            id INTEGER PRIMARY KEY,
            note_path TEXT NOT NULL,
            product_type TEXT NOT NULL,      -- 'full_text', 'summary', 'paragraph'
            chunk_index INTEGER DEFAULT 0,   -- For paragraphs: 0, 1, 2...
            content_hash TEXT NOT NULL,      -- SHA256 of cleaned content
            embedding BLOB NOT NULL,
            model_version TEXT NOT NULL,     -- 'bge-m3:latest'
            pipeline_version INTEGER DEFAULT 1,
            status TEXT DEFAULT 'completed', -- 'pending', 'processing', 'completed', 'failed'
            retry_count INTEGER DEFAULT 0,
            error_message TEXT,
            created_at INTEGER DEFAULT (unixepoch()),
            updated_at INTEGER DEFAULT (unixepoch()),
            
            UNIQUE(note_path, product_type, chunk_index)
        );

        -- Indexes for efficient lookups
        CREATE INDEX IF NOT EXISTS idx_emb_v2_path ON embeddings_v2(note_path);
        CREATE INDEX IF NOT EXISTS idx_emb_v2_status ON embeddings_v2(status);
        CREATE INDEX IF NOT EXISTS idx_emb_v2_hash ON embeddings_v2(content_hash);
        CREATE INDEX IF NOT EXISTS idx_emb_v2_model ON embeddings_v2(model_version);
        "#,
    )?;

    conn.execute("INSERT INTO schema_version (version) VALUES (20)", [])?;

    log::debug!("✅ [DB] V20 migration complete: embeddings_v2 table created");
    Ok(())
}

/// V21 migration: Embedding Pipeline v2.1 schema enhancements
/// - chunk_index → chunk_id (hash-based stable ID)
/// - Add heartbeat_at for processing timeout detection
/// - Add priority for rebuild ordering
/// - Add chunk_kind for content type filtering
pub fn migrate_v21(conn: &Connection) -> SqliteResult<()> {
    log::debug!("📦 [DB] Running V21 migration: Enhance embeddings_v2 schema");

    // SQLite doesn't support ALTER COLUMN, so we need to recreate the table
    conn.execute_batch(
        r#"
        -- Create new table with updated schema
        CREATE TABLE IF NOT EXISTS embeddings_v2_new (
            id INTEGER PRIMARY KEY,
            note_path TEXT NOT NULL,
            product_type TEXT NOT NULL,      -- 'paragraph', 'note_profile', 'summary'
            chunk_id TEXT NOT NULL,          -- Hash-based stable ID (12 chars)
            content_hash TEXT NOT NULL,      -- SHA256 of cleaned content
            embedding BLOB NOT NULL,
            model_version TEXT NOT NULL,     -- 'bge-m3:latest'
            pipeline_version INTEGER DEFAULT 2,
            status TEXT DEFAULT 'completed', -- 'pending', 'processing', 'completed', 'failed'
            retry_count INTEGER DEFAULT 0,
            error_message TEXT,
            heartbeat_at INTEGER,            -- For processing timeout detection
            priority INTEGER DEFAULT 0,      -- Rebuild priority (higher = sooner)
            chunk_kind TEXT DEFAULT 'text',  -- 'text', 'code', 'list', 'table'
            heading_path TEXT,               -- Context path (e.g. Title, Section)
            created_at INTEGER DEFAULT (unixepoch()),
            updated_at INTEGER DEFAULT (unixepoch()),
            
            UNIQUE(note_path, product_type, chunk_id)
        );

        -- Migrate existing data (chunk_index as string becomes chunk_id)
        INSERT OR IGNORE INTO embeddings_v2_new 
            (note_path, product_type, chunk_id, content_hash, embedding, 
             model_version, pipeline_version, status, retry_count, error_message,
             created_at, updated_at)
        SELECT 
            note_path, 
            CASE product_type 
                WHEN 'full_text' THEN 'note_profile'
                ELSE product_type 
            END,
            CAST(chunk_index AS TEXT),
            content_hash, embedding, model_version, pipeline_version, 
            status, retry_count, error_message, created_at, updated_at
        FROM embeddings_v2;

        -- Drop old table and rename new
        DROP TABLE IF EXISTS embeddings_v2;
        ALTER TABLE embeddings_v2_new RENAME TO embeddings_v2;

        -- Recreate indexes
        CREATE INDEX IF NOT EXISTS idx_emb_v2_path ON embeddings_v2(note_path);
        CREATE INDEX IF NOT EXISTS idx_emb_v2_status ON embeddings_v2(status);
        CREATE INDEX IF NOT EXISTS idx_emb_v2_hash ON embeddings_v2(content_hash);
        CREATE INDEX IF NOT EXISTS idx_emb_v2_model ON embeddings_v2(model_version);
        CREATE INDEX IF NOT EXISTS idx_emb_v2_heartbeat ON embeddings_v2(heartbeat_at);
        CREATE INDEX IF NOT EXISTS idx_emb_v2_priority ON embeddings_v2(priority);
        "#,
    )?;

    conn.execute("INSERT INTO schema_version (version) VALUES (21)", [])?;

    log::debug!("✅ [DB] V21 migration complete: embeddings_v2 enhanced with chunk_id, heartbeat, priority");
    Ok(())
}

/// V22 migration: Fix embeddings_v2 to allow NULL embedding for pending jobs
/// This is required for the job scheduling workflow where records are created
/// with 'pending' status before embedding is generated
pub fn migrate_v22(conn: &Connection) -> SqliteResult<()> {
    log::debug!("📦 [DB] Running V22 migration: Allow NULL embedding for pending jobs");

    // SQLite doesn't support ALTER COLUMN, so we need to recreate the table
    conn.execute_batch(
        r#"
        -- Create new table with nullable embedding
        CREATE TABLE IF NOT EXISTS embeddings_v2_new (
            id INTEGER PRIMARY KEY,
            note_path TEXT NOT NULL,
            product_type TEXT NOT NULL,
            chunk_id TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            embedding BLOB,                    -- Now nullable for pending jobs
            model_version TEXT,                -- Nullable for pending (filled on completion)
            pipeline_version INTEGER DEFAULT 2,
            status TEXT DEFAULT 'pending',
            retry_count INTEGER DEFAULT 0,
            error_message TEXT,
            heartbeat_at INTEGER,
            priority INTEGER DEFAULT 0,
            chunk_kind TEXT DEFAULT 'text',
            heading_path TEXT,
            created_at INTEGER DEFAULT (unixepoch()),
            updated_at INTEGER DEFAULT (unixepoch()),
            
            UNIQUE(note_path, product_type, chunk_id)
        );

        -- Migrate existing data
        INSERT OR IGNORE INTO embeddings_v2_new 
            (note_path, product_type, chunk_id, content_hash, embedding, 
             model_version, pipeline_version, status, retry_count, error_message,
             heartbeat_at, priority, chunk_kind, heading_path, created_at, updated_at)
        SELECT 
            note_path, product_type, chunk_id, content_hash, embedding,
            model_version, pipeline_version, status, retry_count, error_message,
            heartbeat_at, priority, chunk_kind, heading_path, created_at, updated_at
        FROM embeddings_v2;

        -- Drop old table and rename new
        DROP TABLE IF EXISTS embeddings_v2;
        ALTER TABLE embeddings_v2_new RENAME TO embeddings_v2;

        -- Recreate indexes
        CREATE INDEX IF NOT EXISTS idx_emb_v2_path ON embeddings_v2(note_path);
        CREATE INDEX IF NOT EXISTS idx_emb_v2_status ON embeddings_v2(status);
        CREATE INDEX IF NOT EXISTS idx_emb_v2_hash ON embeddings_v2(content_hash);
        CREATE INDEX IF NOT EXISTS idx_emb_v2_model ON embeddings_v2(model_version);
        CREATE INDEX IF NOT EXISTS idx_emb_v2_heartbeat ON embeddings_v2(heartbeat_at);
        CREATE INDEX IF NOT EXISTS idx_emb_v2_priority ON embeddings_v2(priority);
        "#,
    )?;

    conn.execute("INSERT INTO schema_version (version) VALUES (22)", [])?;

    log::debug!("✅ [DB] V22 migration complete: embeddings_v2 now supports pending jobs");
    Ok(())
}

/// V23 migration: Data Persistence consolidation
/// - DROP legacy embeddings V1 table
/// - Add ai_provider/ai_model columns to notes table
/// - Create unified ai_feedback table for model training
pub fn migrate_v23(conn: &Connection) -> SqliteResult<()> {
    log::debug!("🔄 [DB] Running V23 migration: Data Persistence consolidation");

    add_column_if_not_exists(conn, "notes", "ai_provider", "TEXT")?;
    add_column_if_not_exists(conn, "notes", "ai_model", "TEXT")?;

    conn.execute_batch(
        r#"
        -- Drop legacy embeddings V1 table
        DROP TABLE IF EXISTS embeddings;

        -- Unified AI feedback table for model training
        CREATE TABLE IF NOT EXISTS ai_feedback (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            skill_id TEXT NOT NULL,
            note_path TEXT NOT NULL,
            action TEXT NOT NULL,
            ai_output TEXT NOT NULL,
            user_final TEXT,
            content_snippet TEXT,
            provider TEXT,
            model TEXT,
            created_at INTEGER DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS idx_ai_feedback_skill ON ai_feedback(skill_id);
        CREATE INDEX IF NOT EXISTS idx_ai_feedback_note ON ai_feedback(note_path);
        "#,
    )?;

    conn.execute("INSERT INTO schema_version (version) VALUES (23)", [])?;

    log::debug!("✅ [DB] V23 migration complete: embeddings V1 dropped, ai_feedback created");
    Ok(())
}

/// V24 migration: Feedback table consolidation
/// - Drop legacy ai_feedback_logs table (data migration skipped as table no longer created)
pub fn migrate_v24(conn: &Connection) -> SqliteResult<()> {
    log::debug!("🔄 [DB] Running V24 migration: Feedback table consolidation");

    conn.execute_batch(
        r#"
        -- Drop legacy feedback table (may not exist on fresh installs)
        DROP TABLE IF EXISTS ai_feedback_logs;
        "#,
    )?;

    conn.execute("INSERT INTO schema_version (version) VALUES (24)", [])?;

    log::debug!("✅ [DB] V24 migration complete: ai_feedback_logs dropped");
    Ok(())
}
/// V25 migration: AI usage logging table
pub fn migrate_v25(conn: &Connection) -> SqliteResult<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS ai_usage_log (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id    TEXT NOT NULL,
            skill_id      TEXT NOT NULL,
            provider      TEXT NOT NULL DEFAULT 'ollama',
            model         TEXT NOT NULL,
            note_path     TEXT,
            status        TEXT NOT NULL,
            input_chars   INTEGER,
            output_chars  INTEGER,
            duration_ms   INTEGER,
            retry_count   INTEGER DEFAULT 0,
            error_type    TEXT,
            error_message TEXT,
            created_at    INTEGER DEFAULT (unixepoch())
        );

        CREATE INDEX IF NOT EXISTS idx_usage_session ON ai_usage_log(session_id);
        CREATE INDEX IF NOT EXISTS idx_usage_created ON ai_usage_log(created_at);
        CREATE INDEX IF NOT EXISTS idx_usage_skill ON ai_usage_log(skill_id, created_at);
        "#,
    )?;

    conn.execute("INSERT INTO schema_version (version) VALUES (25)", [])?;

    log::debug!("✅ [DB] V25 migration complete: ai_usage_log table created");
    Ok(())
}

/// V26 migration: AI provider settings table
pub fn migrate_v26(conn: &Connection) -> SqliteResult<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS ai_settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        "#,
    )?;

    conn.execute("INSERT INTO schema_version (version) VALUES (26)", [])?;

    log::debug!("✅ [DB] V26 migration complete: ai_settings table created");
    Ok(())
}

/// V27 migration: Clean up ai_skill_config (remove legacy columns) + add dimensions to embeddings_v2
pub fn migrate_v27(conn: &Connection) -> SqliteResult<()> {
    log::debug!(
        "📦 [DB] Running V27 migration: ai_skill_config cleanup + embeddings_v2 dimensions"
    );

    // Step A: Rebuild ai_skill_config without legacy columns
    // (on_button, on_blur, on_idle_enabled, on_idle_delay_ms were superseded by rule_* JSON in V10)
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS ai_skill_config_new (
            skill_id    TEXT PRIMARY KEY,
            enabled     INTEGER DEFAULT 1,
            config      TEXT DEFAULT '{}',
            rule_open   TEXT,
            rule_active TEXT,
            rule_idle   TEXT,
            rule_blur   TEXT,
            updated_at  INTEGER DEFAULT (unixepoch())
        );

        INSERT INTO ai_skill_config_new
            (skill_id, enabled, config, rule_open, rule_active, rule_idle, rule_blur, updated_at)
        SELECT skill_id, enabled, config, rule_open, rule_active, rule_idle, rule_blur, updated_at
        FROM ai_skill_config;

        DROP TABLE ai_skill_config;
        ALTER TABLE ai_skill_config_new RENAME TO ai_skill_config;
        "#,
    )?;

    // Step B: Add dimensions column to embeddings_v2
    let _ = conn.execute(
        "ALTER TABLE embeddings_v2 ADD COLUMN dimensions INTEGER",
        [],
    );

    conn.execute("INSERT INTO schema_version (version) VALUES (27)", [])?;

    log::debug!(
        "✅ [DB] V27 migration complete: ai_skill_config cleaned, embeddings_v2 got dimensions"
    );
    Ok(())
}

/// V28 migration: Add provider_key to ai_suggestion_cache
/// Rebuilds table via rename-copy to change PK to (source_path, target_path, provider_key)
pub fn migrate_v28(conn: &Connection) -> SqliteResult<()> {
    log::debug!("📦 [DB] Running V28 migration: ai_suggestion_cache provider_key binding");

    conn.execute_batch(
        r#"
        -- Step 1: Create new table with provider_key in PK
        CREATE TABLE IF NOT EXISTS ai_suggestion_cache_new (
            source_path  TEXT NOT NULL,
            target_path  TEXT NOT NULL,
            provider_key TEXT NOT NULL DEFAULT '',
            source_mtime INTEGER NOT NULL,
            target_mtime INTEGER NOT NULL,
            relation     TEXT NOT NULL,
            reason       TEXT NOT NULL,
            created_at   INTEGER DEFAULT (unixepoch()),
            PRIMARY KEY (source_path, target_path, provider_key)
        );

        -- Step 2: Copy existing data (provider_key = '' for legacy rows)
        INSERT OR IGNORE INTO ai_suggestion_cache_new
            (source_path, target_path, provider_key, source_mtime, target_mtime, relation, reason, created_at)
        SELECT source_path, target_path, '', source_mtime, target_mtime, relation, reason, created_at
        FROM ai_suggestion_cache;

        -- Step 3: Drop old table and rename
        DROP TABLE IF EXISTS ai_suggestion_cache;
        ALTER TABLE ai_suggestion_cache_new RENAME TO ai_suggestion_cache;

        -- Rebuild index
        CREATE INDEX IF NOT EXISTS idx_cache_source ON ai_suggestion_cache(source_path);
        "#,
    )?;

    conn.execute("INSERT INTO schema_version (version) VALUES (28)", [])?;

    log::debug!("✅ [DB] V28 migration complete: ai_suggestion_cache now has provider_key");
    Ok(())
}

/// V29 migration: Clear stale classification cache
/// After fixing the Create/Select decision logic, old fallback results must be purged.
pub fn migrate_v29(conn: &Connection) -> SqliteResult<()> {
    log::debug!("📦 [DB] Running V29 migration: Clear stale classification_cache");
    conn.execute("DELETE FROM classification_cache", [])?;
    conn.execute("INSERT INTO schema_version (version) VALUES (29)", [])?;
    log::debug!("✅ [DB] V29 complete: classification_cache cleared");
    Ok(())
}

/// V30 migration: Clear provider-bound caches
/// Cache keys are now provider-agnostic. Old entries with provider-bound keys must be purged.
pub fn migrate_v30(conn: &Connection) -> SqliteResult<()> {
    log::debug!("📦 [DB] Running V30 migration: Clear provider-bound caches");
    conn.execute("DELETE FROM classification_cache", [])?;
    conn.execute("DELETE FROM ai_suggestion_cache", [])?;
    conn.execute("INSERT INTO schema_version (version) VALUES (30)", [])?;
    log::debug!("✅ [DB] V30 complete: classification_cache + ai_suggestion_cache cleared");
    Ok(())
}

/// FTS5 Health Check & Auto-Repair
/// 
/// FTS5 shadow tables can become corrupted when WAL checkpoints run during
/// concurrent long-running operations. PRAGMA integrity_check does NOT detect
/// FTS5 corruption — the only reliable test is to attempt an actual write that
/// triggers the FTS update trigger.
/// 
/// Strategy: attempt a harmless UPDATE on notes (set a column to its own value)
/// with triggers active. If it fails with "malformed", DROP + recreate FTS5.
pub fn repair_fts5_if_needed(conn: &Connection) {
    // Check if notes_fts exists at all
    let fts_exists: bool = conn.query_row(
        "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='notes_fts'",
        [], |row| row.get(0)
    ).unwrap_or(false);

    if !fts_exists {
        log::error!("⚠️ [DB/FTS5] notes_fts table missing, recreating...");
        rebuild_fts5(conn);
        return;
    }

    // Probe test: try to run the FTS5 integrity-check command
    let integrity_ok = conn.execute_batch(
        "INSERT INTO notes_fts(notes_fts) VALUES('integrity-check');"
    );

    if integrity_ok.is_ok() {
        // Further probe: attempt a real trigger-firing UPDATE on a dummy row
        // Use a transaction so we can roll back the no-op change
        let probe_result = conn.execute_batch(
            "BEGIN; \
             UPDATE notes SET updated_at = updated_at WHERE id = (SELECT MIN(id) FROM notes); \
             ROLLBACK;"
        );
        if probe_result.is_ok() {
            log::debug!("✅ [DB/FTS5] Health check passed");
            return;
        }
        log::error!("🔴 [DB/FTS5] Trigger probe FAILED: {:?}", probe_result.err());
    } else {
        log::error!("🔴 [DB/FTS5] integrity-check FAILED: {:?}", integrity_ok.err());
    }

    // FTS5 is corrupted — nuclear rebuild
    log::info!("🔧 [DB/FTS5] Performing full DROP + rebuild...");
    rebuild_fts5(conn);
}

/// Drop and recreate FTS5 table with all triggers, then rebuild index from notes data
pub fn rebuild_fts5(conn: &Connection) {
    // Step 1: Remove all FTS artifacts
    let _ = conn.execute_batch(
        "DROP TRIGGER IF EXISTS notes_fts_update; \
         DROP TRIGGER IF EXISTS notes_fts_insert; \
         DROP TRIGGER IF EXISTS notes_fts_delete; \
         DROP TABLE IF EXISTS notes_fts;"
    );

    // Step 2: Recreate FTS5 virtual table
    let create_result = conn.execute_batch(
        "CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5( \
             path, title, ai_summary, ai_tags, user_tags, \
             content='notes', content_rowid='id', \
             tokenize='unicode61 remove_diacritics 2' \
         );"
    );
    if let Err(e) = create_result {
        log::error!("🔴 [DB/FTS5] Failed to create notes_fts: {}", e);
        return;
    }

    // Step 3: Populate from existing data
    let rebuild_result = conn.execute_batch(
        "INSERT INTO notes_fts(notes_fts) VALUES('rebuild');"
    );
    if let Err(e) = rebuild_result {
        log::error!("🔴 [DB/FTS5] rebuild command failed: {}", e);
        // If rebuild fails, drop the broken table so triggers don't interfere
        let _ = conn.execute_batch("DROP TABLE IF EXISTS notes_fts;");
        return;
    }

    // Step 4: Recreate triggers
    let trigger_result = conn.execute_batch(
        "CREATE TRIGGER IF NOT EXISTS notes_fts_insert AFTER INSERT ON notes BEGIN \
             INSERT INTO notes_fts(rowid, path, title, ai_summary, ai_tags, user_tags) \
             VALUES (NEW.id, NEW.path, NEW.title, NEW.ai_summary, NEW.ai_tags, NEW.user_tags); \
         END; \
         CREATE TRIGGER IF NOT EXISTS notes_fts_update AFTER UPDATE ON notes BEGIN \
             DELETE FROM notes_fts WHERE rowid = OLD.id; \
             INSERT INTO notes_fts(rowid, path, title, ai_summary, ai_tags, user_tags) \
             VALUES (NEW.id, NEW.path, NEW.title, NEW.ai_summary, NEW.ai_tags, NEW.user_tags); \
         END; \
         CREATE TRIGGER IF NOT EXISTS notes_fts_delete AFTER DELETE ON notes BEGIN \
             DELETE FROM notes_fts WHERE rowid = OLD.id; \
         END;"
    );
    if let Err(e) = trigger_result {
        log::error!("🔴 [DB/FTS5] Failed to create triggers: {}", e);
        return;
    }

    // Step 5: Verify the fix worked
    let verify = conn.execute_batch(
        "BEGIN; \
         UPDATE notes SET updated_at = updated_at WHERE id = (SELECT MIN(id) FROM notes); \
         ROLLBACK;"
    );
    if verify.is_ok() {
        log::info!("✅ [DB/FTS5] Full rebuild completed successfully!");
    } else {
        log::error!("🔴 [DB/FTS5] Rebuild verification FAILED — dropping FTS to unblock writes");
        let _ = conn.execute_batch(
            "DROP TRIGGER IF EXISTS notes_fts_update; \
             DROP TRIGGER IF EXISTS notes_fts_insert; \
             DROP TRIGGER IF EXISTS notes_fts_delete; \
             DROP TABLE IF EXISTS notes_fts;"
        );
    }
}

pub fn migrate_v31(conn: &Connection) -> SqliteResult<()> {
    log::debug!("Migrating DB to v31 (Side-Table for AI Metadata)...");
    conn.execute_batch(
        "BEGIN;

        -- 1. Create ai_metadata table
        CREATE TABLE IF NOT EXISTS ai_metadata (
            note_id INTEGER PRIMARY KEY,
            summary TEXT,
            tags TEXT,
            classification_result TEXT,
            reasoning TEXT,
            last_inferred_at INTEGER DEFAULT (unixepoch()),
            FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE
        );

        -- 2. Migrate existing data from notes to ai_metadata
        INSERT OR IGNORE INTO ai_metadata (note_id, summary, tags)
        SELECT id, ai_summary, ai_tags 
        FROM notes 
        WHERE ai_summary IS NOT NULL OR ai_tags IS NOT NULL;

        -- 3. Drop FTS triggers since we are rebuilding them
        DROP TRIGGER IF EXISTS notes_fts_insert;
        DROP TRIGGER IF EXISTS notes_fts_update;
        DROP TRIGGER IF EXISTS notes_fts_delete;

        -- 4. Rebuild FTS using a View
        DROP TABLE IF EXISTS notes_fts;
        DROP VIEW IF EXISTS notes_fts_view;
        CREATE VIEW IF NOT EXISTS notes_fts_view AS 
        SELECT 
            n.id as rowid, n.path, n.title, a.summary as ai_summary, a.tags as ai_tags, n.user_tags
        FROM notes n LEFT JOIN ai_metadata a ON n.id = a.note_id;

        CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
             path, title, ai_summary, ai_tags, user_tags,
             content='notes_fts_view', content_rowid='rowid',
             tokenize='unicode61 remove_diacritics 2'
        );

        -- Repopulate FTS
        INSERT INTO notes_fts(notes_fts) VALUES('rebuild');

        -- 5. Create new triggers for both notes and ai_metadata
        CREATE TRIGGER IF NOT EXISTS notes_fts_insert AFTER INSERT ON notes BEGIN
             INSERT INTO notes_fts(rowid, path, title, ai_summary, ai_tags, user_tags)
             VALUES (NEW.id, NEW.path, NEW.title, NULL, NULL, NEW.user_tags);
        END;

        CREATE TRIGGER IF NOT EXISTS notes_fts_update AFTER UPDATE ON notes BEGIN
             DELETE FROM notes_fts WHERE rowid = OLD.id;
             INSERT INTO notes_fts(rowid, path, title, ai_summary, ai_tags, user_tags)
             VALUES (
                 NEW.id, 
                 NEW.path, 
                 NEW.title, 
                 (SELECT summary FROM ai_metadata WHERE note_id = NEW.id),
                 (SELECT tags FROM ai_metadata WHERE note_id = NEW.id),
                 NEW.user_tags
             );
        END;

        CREATE TRIGGER IF NOT EXISTS notes_fts_delete AFTER DELETE ON notes BEGIN
             DELETE FROM notes_fts WHERE rowid = OLD.id;
        END;

        -- AI Metadata triggers
        CREATE TRIGGER IF NOT EXISTS ai_metadata_insert AFTER INSERT ON ai_metadata BEGIN
             DELETE FROM notes_fts WHERE rowid = NEW.note_id;
             INSERT INTO notes_fts(rowid, path, title, ai_summary, ai_tags, user_tags)
             SELECT n.id, n.path, n.title, NEW.summary, NEW.tags, n.user_tags
             FROM notes n WHERE n.id = NEW.note_id;
        END;

        CREATE TRIGGER IF NOT EXISTS ai_metadata_update AFTER UPDATE ON ai_metadata BEGIN
             DELETE FROM notes_fts WHERE rowid = NEW.note_id;
             INSERT INTO notes_fts(rowid, path, title, ai_summary, ai_tags, user_tags)
             SELECT n.id, n.path, n.title, NEW.summary, NEW.tags, n.user_tags
             FROM notes n WHERE n.id = NEW.note_id;
        END;

        CREATE TRIGGER IF NOT EXISTS ai_metadata_delete AFTER DELETE ON ai_metadata BEGIN
             DELETE FROM notes_fts WHERE rowid = OLD.note_id;
             INSERT INTO notes_fts(rowid, path, title, ai_summary, ai_tags, user_tags)
             SELECT n.id, n.path, n.title, NULL, NULL, n.user_tags
             FROM notes n WHERE n.id = OLD.note_id;
        END;

        INSERT INTO schema_version (version) VALUES (31);
        COMMIT;"
    )?;
    Ok(())
}

/// V32 migration: Completely decouple AI metadata schemas from Notes table
pub fn migrate_v32(conn: &Connection) -> SqliteResult<()> {
    log::debug!("Migrating DB to v32 (Decouple AI metadata from notes)...");
    
    // Turn off foreign keys OUTSIDE the transaction for schema alterations
    conn.execute_batch("PRAGMA foreign_keys=off;")?;
    
    // Execute the heavy migration inside a transaction
    let tx_result = conn.execute_batch(
        "BEGIN;

        -- 0. Drop the FTS views and triggers early to prevent schema parse failures 
        -- when we drop the ai_metadata table that the view and triggers depend on
        DROP TABLE IF EXISTS notes_fts;
        DROP VIEW IF EXISTS notes_fts_view;
        
        -- Explicitly drop FTS triggers before dropping the table
        DROP TRIGGER IF EXISTS notes_fts_insert;
        DROP TRIGGER IF EXISTS notes_fts_update;
        DROP TRIGGER IF EXISTS notes_fts_delete;
        DROP TRIGGER IF EXISTS ai_metadata_insert;
        DROP TRIGGER IF EXISTS ai_metadata_update;
        DROP TRIGGER IF EXISTS ai_metadata_delete;
        -- Recreate ai_metadata just in case to add title column
        CREATE TABLE IF NOT EXISTS ai_metadata_new (
            note_id INTEGER PRIMARY KEY,
            title TEXT,
            summary TEXT,
            tags TEXT,
            classification_result TEXT,
            reasoning TEXT,
            provider TEXT,
            model TEXT,
            last_inferred_at INTEGER DEFAULT (unixepoch()),
            FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE
        );
        
        INSERT OR IGNORE INTO ai_metadata_new (note_id, summary, tags, classification_result, reasoning, last_inferred_at)
        SELECT note_id, summary, tags, classification_result, reasoning, last_inferred_at FROM ai_metadata;
        
        -- Migrate ai_title, ai_provider, and ai_model from notes into ai_metadata_new
        UPDATE ai_metadata_new 
        SET title = (SELECT ai_title FROM notes WHERE notes.id = ai_metadata_new.note_id),
            provider = (SELECT ai_provider FROM notes WHERE notes.id = ai_metadata_new.note_id),
            model = (SELECT ai_model FROM notes WHERE notes.id = ai_metadata_new.note_id)
        WHERE title IS NULL OR provider IS NULL;
        
        -- Insert missing rows for notes that have AI fields but no ai_metadata row yet
        INSERT OR IGNORE INTO ai_metadata_new (note_id, title, provider, model)
        SELECT id, ai_title, ai_provider, ai_model FROM notes 
        WHERE ai_title IS NOT NULL OR ai_provider IS NOT NULL;

        DROP TABLE ai_metadata;
        ALTER TABLE ai_metadata_new RENAME TO ai_metadata;

        -- 2. Recreate notes table without AI columns
        CREATE TABLE IF NOT EXISTS notes_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            extension TEXT NOT NULL,
            mtime INTEGER NOT NULL,
            size INTEGER NOT NULL,
            category TEXT,
            parent_folder TEXT,
            is_embedded BOOLEAN DEFAULT 0,
            last_processed_at INTEGER DEFAULT 0,
            user_tags TEXT,
            user_summary TEXT,
            user_title TEXT,
            created_at INTEGER DEFAULT (unixepoch()),
            updated_at INTEGER DEFAULT (unixepoch())
        );

        INSERT INTO notes_new (
            id, path, title, extension, mtime, size, category, parent_folder,
            is_embedded, last_processed_at, user_tags, user_summary, user_title, created_at, updated_at
        )
        SELECT 
            id, path, title, extension, mtime, size, category, parent_folder,
            is_embedded, last_processed_at, user_tags, user_summary, user_title, created_at, updated_at
        FROM notes;

        -- Drop old table
        DROP TABLE notes;
        
        -- Rename new table
        ALTER TABLE notes_new RENAME TO notes;

        -- Restore notes indexes
        CREATE INDEX IF NOT EXISTS idx_notes_path ON notes(path);
        CREATE INDEX IF NOT EXISTS idx_notes_category ON notes(category);
        CREATE INDEX IF NOT EXISTS idx_notes_mtime ON notes(mtime);

        -- 3. Rebuild FTS View without ai_title for now
        DROP VIEW IF EXISTS notes_fts_view;
        CREATE VIEW IF NOT EXISTS notes_fts_view AS 
        SELECT 
            n.id as rowid, n.path, n.title, a.summary as ai_summary, a.tags as ai_tags, n.user_tags
        FROM notes n LEFT JOIN ai_metadata a ON n.id = a.note_id;

        -- 4. Rebuild FTS5 Virtual Table
        DROP TABLE IF EXISTS notes_fts;
        CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
             path, title, ai_summary, ai_tags, user_tags,
             content='notes_fts_view', content_rowid='rowid',
             tokenize='unicode61 remove_diacritics 2'
        );
        INSERT INTO notes_fts(notes_fts) VALUES('rebuild');

        -- 5. Re-create triggers for FTS synchronization
        -- FTS5 External Content requires DELETEs to run BEFORE the base tables are modified
        CREATE TRIGGER IF NOT EXISTS notes_fts_before_update BEFORE UPDATE ON notes BEGIN
             DELETE FROM notes_fts WHERE rowid = OLD.id;
        END;

        CREATE TRIGGER IF NOT EXISTS notes_fts_after_update AFTER UPDATE ON notes BEGIN
             INSERT INTO notes_fts(rowid, path, title, ai_summary, ai_tags, user_tags)
             SELECT NEW.id, NEW.path, NEW.title, a.summary, a.tags, NEW.user_tags
             FROM notes n LEFT JOIN ai_metadata a ON n.id = a.note_id WHERE n.id = NEW.id;
        END;

        CREATE TRIGGER IF NOT EXISTS notes_fts_before_delete BEFORE DELETE ON notes BEGIN
             DELETE FROM notes_fts WHERE rowid = OLD.id;
        END;

        CREATE TRIGGER IF NOT EXISTS notes_fts_insert AFTER INSERT ON notes BEGIN
             INSERT INTO notes_fts(rowid, path, title, ai_summary, ai_tags, user_tags)
             VALUES (NEW.id, NEW.path, NEW.title, NULL, NULL, NEW.user_tags);
        END;

        CREATE TRIGGER IF NOT EXISTS ai_metadata_before_insert BEFORE INSERT ON ai_metadata BEGIN
             DELETE FROM notes_fts WHERE rowid = NEW.note_id;
        END;

        CREATE TRIGGER IF NOT EXISTS ai_metadata_after_insert AFTER INSERT ON ai_metadata BEGIN
             INSERT INTO notes_fts(rowid, path, title, ai_summary, ai_tags, user_tags)
             SELECT n.id, n.path, n.title, NEW.summary, NEW.tags, n.user_tags
             FROM notes n WHERE n.id = NEW.note_id;
        END;

        CREATE TRIGGER IF NOT EXISTS ai_metadata_before_update BEFORE UPDATE ON ai_metadata BEGIN
             DELETE FROM notes_fts WHERE rowid = OLD.note_id;
        END;

        CREATE TRIGGER IF NOT EXISTS ai_metadata_after_update AFTER UPDATE ON ai_metadata BEGIN
             INSERT INTO notes_fts(rowid, path, title, ai_summary, ai_tags, user_tags)
             SELECT n.id, n.path, n.title, NEW.summary, NEW.tags, n.user_tags
             FROM notes n WHERE n.id = NEW.note_id;
        END;

        CREATE TRIGGER IF NOT EXISTS ai_metadata_before_delete BEFORE DELETE ON ai_metadata BEGIN
             DELETE FROM notes_fts WHERE rowid = OLD.note_id;
        END;

        CREATE TRIGGER IF NOT EXISTS ai_metadata_after_delete AFTER DELETE ON ai_metadata BEGIN
             INSERT INTO notes_fts(rowid, path, title, ai_summary, ai_tags, user_tags)
             SELECT n.id, n.path, n.title, NULL, NULL, n.user_tags
             FROM notes n WHERE n.id = OLD.note_id;
        END;

        INSERT INTO schema_version (version) VALUES (32);
        COMMIT;"
    );

    // Turn foreign keys back ON
    conn.execute_batch("PRAGMA foreign_keys=on;")?;
    
    // Return original transaction result inside the Ok wrapper
    tx_result?;

    Ok(())
}

/// V33 migration: Media Enrichment Cache + embeddings_v2 enriched_content
///
/// Solves:
/// 1. Redundant LLM calls (8x per image) → 0x via content-addressed cache
/// 2. Chunk ID drift from non-deterministic LLM output → frozen text per asset hash
/// 3. Lack of persistence → enriched text survives rebuild
pub fn migrate_v33(conn: &Connection) -> SqliteResult<()> {
    log::debug!("📦 [DB] Running V33 migration: media_enrich_cache + enriched_content");

    // 1. Create media enrichment cache (keyed by CAS asset hash)
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS media_enrich_cache (
            asset_hash   TEXT PRIMARY KEY,
            enriched_text TEXT NOT NULL,
            model_name   TEXT NOT NULL,
            char_count   INTEGER NOT NULL,
            created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
            updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
        );
        "#,
    )?;

    // 2. Add enriched_content column to embeddings_v2 (nullable, safe ALTER)
    let _ = conn.execute(
        "ALTER TABLE embeddings_v2 ADD COLUMN enriched_content TEXT DEFAULT ''",
        [],
    );

    conn.execute("INSERT INTO schema_version (version) VALUES (33)", [])?;

    log::debug!("✅ [DB] V33 migration complete: media_enrich_cache created, embeddings_v2 got enriched_content");
    Ok(())
}

/// V34 migration: Transfer Queue for Background Asset Transfer (Phase 6)
///
/// Persistent SQLite queue for managing chunked upload/download tasks.
/// Uses `LocalTransferState` enum values for task lifecycle.
/// Guarantees crash recovery: on restart, `active` tasks resume or re-negotiate.
pub fn migrate_v34(conn: &Connection) -> SqliteResult<()> {
    log::debug!("📦 [DB] Running V34 migration: transfer_queue for Background Asset Transfer");

    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS transfer_queue (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            vault_id         TEXT NOT NULL,
            hash             TEXT NOT NULL,
            asset_path       TEXT NOT NULL,
            direction        TEXT NOT NULL,     -- 'upload' | 'download'
            status           TEXT NOT NULL DEFAULT 'pending',  -- pending, active, paused, completed, failed
            upload_id        TEXT,              -- 服务端返回的 upload session ID（上传时使用）
            total_bytes      INTEGER NOT NULL DEFAULT 0,
            transferred_bytes INTEGER NOT NULL DEFAULT 0,
            chunk_size       INTEGER NOT NULL DEFAULT 4194304,  -- 4MB
            retry_count      INTEGER NOT NULL DEFAULT 0,
            max_retries      INTEGER NOT NULL DEFAULT 5,
            error_message    TEXT,
            created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
            updated_at       INTEGER NOT NULL DEFAULT (unixepoch()),
            UNIQUE(vault_id, hash, direction)
        );

        CREATE INDEX IF NOT EXISTS idx_tq_status ON transfer_queue(status);
        CREATE INDEX IF NOT EXISTS idx_tq_vault ON transfer_queue(vault_id);
        CREATE INDEX IF NOT EXISTS idx_tq_direction ON transfer_queue(vault_id, direction);
        "#,
    )?;

    conn.execute("INSERT INTO schema_version (version) VALUES (34)", [])?;

    log::debug!("✅ [DB] V34 migration complete: transfer_queue created for Phase 6");
    Ok(())
}

/// V35 migration: Add slash_id TEXT UNIQUE to notes
pub fn migrate_v35(conn: &Connection) -> SqliteResult<()> {
    log::debug!("📦 [DB] Running V35 migration: Add slash_id TEXT UNIQUE to notes");

    // Check if column already exists
    let column_exists: bool = conn.query_row(
        "SELECT count(*) FROM pragma_table_info('notes') WHERE name='slash_id'",
        [],
        |row| row.get::<_, i32>(0)
    ).map(|count| count > 0).unwrap_or(false);

    if !column_exists {
        conn.execute("ALTER TABLE notes ADD COLUMN slash_id TEXT", [])?;
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_slash_id ON notes(slash_id)", [])?;
    }

    conn.execute("INSERT INTO schema_version (version) VALUES (35)", [])?;

    log::debug!("✅ [DB] V35 migration complete: slash_id column added to notes");
    Ok(())
}

