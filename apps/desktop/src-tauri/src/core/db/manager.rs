use rusqlite::{Connection, Result as SqliteResult};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Database state managed by Tauri
pub struct DbState {
    pub connection: Mutex<Option<Connection>>,
    pub vault_path: Mutex<Option<PathBuf>>,
}

impl Default for DbState {
    fn default() -> Self {
        DbState {
            connection: Mutex::new(None),
            vault_path: Mutex::new(None),
        }
    }
}

impl DbState {
    /// Get database path for a vault
    pub fn db_path(vault_path: &Path) -> PathBuf {
        vault_path.join(".slash").join("slash.db")
    }

    /// Initialize database connection for a vault
    pub fn init(&self, vault_path: &Path) -> SqliteResult<()> {
        // Ensure .slash directory exists
        let slash_dir = vault_path.join(".slash");
        if !slash_dir.exists() {
            fs::create_dir_all(&slash_dir)
                .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        }

        // Open/create database
        let db_path = Self::db_path(vault_path);
        let conn = Connection::open(&db_path)?;

        // ---------------------------------------------------------
        // 🛠️ 核心优化区 (Performance Tuning)
        // ---------------------------------------------------------

        // 1. 开启 WAL 模式：允许"边读边写"，防止 AI 后台任务卡死 UI
        conn.execute_batch("PRAGMA journal_mode = WAL;")?;

        // 2. 开启外键约束：保证数据一致性 (级联删除)
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;

        // 3. 优化写入同步等级：NORMAL 在 WAL 模式下既安全又快
        conn.execute_batch("PRAGMA synchronous = NORMAL;")?;

        // ---------------------------------------------------------

        // Run migrations
        self.migrate(&conn)?;

        // FTS5 Health Check
        self.repair_fts5_if_needed(&conn);

        // Store connection
        let mut conn_guard = self.connection.lock().unwrap();
        *conn_guard = Some(conn);

        let mut vault_guard = self.vault_path.lock().unwrap();
        *vault_guard = Some(vault_path.to_path_buf());

        Ok(())
    }

    /// Close current database connection
    pub fn close(&self) {
        let mut conn_guard = self.connection.lock().unwrap();
        *conn_guard = None;

        let mut vault_guard = self.vault_path.lock().unwrap();
        *vault_guard = None;
    }

    /// Run database migrations (V1-V34)
    fn migrate(&self, conn: &Connection) -> SqliteResult<()> {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER PRIMARY KEY,
                applied_at INTEGER DEFAULT (unixepoch())
            );
        "#,
        )?;

        let current_version: i32 = conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM schema_version",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        // Delegated to migrations module — table-driven dispatch
        use super::migrations;
        let migration_fns: &[fn(&Connection) -> SqliteResult<()>] = &[
            migrations::migrate_v1,  migrations::migrate_v2,  migrations::migrate_v3,
            migrations::migrate_v4,  migrations::migrate_v5,  migrations::migrate_v6,
            migrations::migrate_v7,  migrations::migrate_v8,  migrations::migrate_v9,
            migrations::migrate_v10, migrations::migrate_v11, migrations::migrate_v12,
            migrations::migrate_v13, migrations::migrate_v14, migrations::migrate_v15,
            migrations::migrate_v16, migrations::migrate_v17, migrations::migrate_v18,
            migrations::migrate_v19, migrations::migrate_v20, migrations::migrate_v21,
            migrations::migrate_v22, migrations::migrate_v23, migrations::migrate_v24,
            migrations::migrate_v25, migrations::migrate_v26, migrations::migrate_v27,
            migrations::migrate_v28, migrations::migrate_v29, migrations::migrate_v30,
            migrations::migrate_v31, migrations::migrate_v32,
            migrations::migrate_v33,
            migrations::migrate_v34,
            migrations::migrate_v35,
        ];

        for (i, migrate_fn) in migration_fns.iter().enumerate() {
            let version = (i + 1) as i32;
            if current_version < version {
                migrate_fn(conn)?;
            }
        }

        Ok(())
    }

    /// FTS5 Health Check: detect and repair corrupted FTS5 shadow tables
    fn repair_fts5_if_needed(&self, conn: &Connection) {
        super::migrations::repair_fts5_if_needed(conn);
    }

    /// Execute with connection
    pub fn with_connection<F, T>(&self, f: F) -> Result<T, String>
    where
        F: FnOnce(&Connection) -> SqliteResult<T>,
    {
        let conn_guard = self.connection.lock().unwrap();
        match conn_guard.as_ref() {
            Some(conn) => f(conn).map_err(|e| e.to_string()),
            None => Err("Database not initialized".to_string()),
        }
    }
}
