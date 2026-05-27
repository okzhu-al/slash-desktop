-- SQLite Schema for Slash Metadata Store
-- Version: 1.0

-- Table: NOTES (Nodes)
CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,           -- Relative path: "02_Areas/Logic/Aristotle.md"
    title TEXT NOT NULL,
    extension TEXT NOT NULL,
    mtime INTEGER NOT NULL,              -- FS modification time (Unix timestamp)
    size INTEGER NOT NULL,
    
    -- PARA Attributes (derived from path)
    category TEXT,                       -- 'inbox', 'project', 'area', 'resource', 'archive'
    parent_folder TEXT,                  -- Immediate parent folder name
    
    is_embedded BOOLEAN DEFAULT 0,       
    last_processed_at INTEGER DEFAULT 0, 
    
    -- User Metadata (from YAML frontmatter)
    user_tags TEXT,                      -- JSON Array of user tags
    user_summary TEXT,                   -- User-written summary
    user_title TEXT,                     
    slash_id TEXT UNIQUE,                -- UUID-First identity
    
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_notes_path ON notes(path);
CREATE INDEX IF NOT EXISTS idx_notes_category ON notes(category);
CREATE INDEX IF NOT EXISTS idx_notes_mtime ON notes(mtime);

-- Table: LINKS (Edges)
CREATE TABLE IF NOT EXISTS links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_path TEXT NOT NULL,           -- Source note path
    target_path TEXT,                    -- Resolved target path (NULL if dead link)
    target_anchor TEXT NOT NULL,         -- Raw text: "[[Plato]]" or "[[柏拉图|Plato]]"
    
    -- Edge Properties
    label TEXT,                          -- Relation name (e.g., "Teacher", "Author")
    link_type TEXT DEFAULT 'explicit',   -- 'explicit', 'attribute', 'yaml', 'structural'
    
    created_at INTEGER DEFAULT (unixepoch()),
    
    FOREIGN KEY(source_path) REFERENCES notes(path) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_links_source ON links(source_path);
CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_path);
CREATE INDEX IF NOT EXISTS idx_links_label ON links(label);

