use serde::{Deserialize, Serialize};

/// PARA category derived from file path
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ParaCategory {
    Inbox,
    Project,
    Area,
    Resource,
    Archive,
    Other,
}

impl ParaCategory {
    /// Parse PARA category from relative path
    pub fn from_path(path: &str) -> Self {
        let parts: Vec<&str> = path.split(['/', '\\']).collect();
        if parts.is_empty() {
            return ParaCategory::Other;
        }

        match parts[0] {
            s if s.starts_with("00_Inbox") => ParaCategory::Inbox,
            s if s.starts_with("01_Projects") => ParaCategory::Project,
            s if s.starts_with("02_Areas") => ParaCategory::Area,
            s if s.starts_with("03_Resources") => ParaCategory::Resource,
            s if s.starts_with("04_Archives") => ParaCategory::Archive,
            _ => ParaCategory::Other,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            ParaCategory::Inbox => "inbox",
            ParaCategory::Project => "project",
            ParaCategory::Area => "area",
            ParaCategory::Resource => "resource",
            ParaCategory::Archive => "archive",
            ParaCategory::Other => "other",
        }
    }
}

/// Note record in database
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    pub id: Option<i64>,
    pub path: String,
    pub title: String,
    pub extension: String,
    pub mtime: i64,
    pub size: i64,
    pub category: Option<String>,
    pub parent_folder: Option<String>,
    pub is_embedded: bool,
    pub last_processed_at: i64,
    pub ai_summary: Option<String>,
    pub ai_tags: Option<String>,
    pub user_tags: Option<String>,
    pub user_summary: Option<String>,
    pub ai_title: Option<String>,   // AI-generated suggested title
    pub user_title: Option<String>, // User-confirmed title (takes precedence)
    pub slash_id: Option<String>,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
}

impl Note {
    /// Create a new note from file metadata
    pub fn from_file(relative_path: &str, title: &str, mtime: i64, size: i64) -> Self {
        let path = std::path::Path::new(relative_path);
        let extension = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_string();

        let parent_folder = path
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .map(|s| s.to_string());

        let category = ParaCategory::from_path(relative_path);

        Note {
            id: None,
            path: relative_path.to_string(),
            title: title.to_string(),
            extension,
            mtime,
            size,
            category: Some(category.as_str().to_string()),
            parent_folder,
            is_embedded: false,
            last_processed_at: 0,
            ai_summary: None,
            ai_tags: None,
            user_tags: None,
            user_summary: None,
            ai_title: None,
            user_title: None,
            slash_id: None,
            created_at: None,
            updated_at: None,
        }
    }
}

/// Link type enumeration
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum LinkType {
    Explicit,   // [[link]]
    Attribute,  // Key:: [[link]]
    Yaml,       // relations: { key: [[link]] }
    Structural, // Parent/child folder relationship
}

impl LinkType {
    pub fn as_str(&self) -> &'static str {
        match self {
            LinkType::Explicit => "explicit",
            LinkType::Attribute => "attribute",
            LinkType::Yaml => "yaml",
            LinkType::Structural => "structural",
        }
    }
}

/// Link record in database
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Link {
    pub id: Option<i64>,
    pub source_path: String,
    pub target_path: Option<String>,
    pub target_anchor: String,
    pub label: Option<String>,
    pub link_type: String,
    pub created_at: Option<i64>,
}

impl Link {
    /// Create a new explicit link
    pub fn explicit(source_path: &str, target_anchor: &str) -> Self {
        Link {
            id: None,
            source_path: source_path.to_string(),
            target_path: None, // Will be resolved later
            target_anchor: target_anchor.to_string(),
            label: None,
            link_type: LinkType::Explicit.as_str().to_string(),
            created_at: None,
        }
    }

    /// Create a labeled link (attribute or yaml)
    pub fn labeled(
        source_path: &str,
        target_anchor: &str,
        label: &str,
        link_type: LinkType,
    ) -> Self {
        Link {
            id: None,
            source_path: source_path.to_string(),
            target_path: None,
            target_anchor: target_anchor.to_string(),
            label: Some(label.to_string()),
            link_type: link_type.as_str().to_string(),
            created_at: None,
        }
    }
}

/// AI metadata from YAML frontmatter `ai:` namespace
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AiFrontmatter {
    pub tags: Option<Vec<String>>,
    pub summary: Option<String>,
    pub title: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub processed_at: Option<String>,
}

/// Parsed frontmatter from markdown file
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ParsedFrontmatter {
    pub slash_id: Option<String>,
    pub title: Option<String>,
    pub tags: Vec<String>,
    pub summary: Option<String>,
    pub relations: std::collections::HashMap<String, Vec<String>>,
    /// AI metadata from `ai:` namespace in YAML frontmatter
    pub ai: Option<AiFrontmatter>,
}

/// Result of scanning a single file
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanResult {
    pub note: Note,
    pub links: Vec<Link>,
}

/// Task priority level
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum TaskPriority {
    High,
    Medium,
    Low,
}

impl TaskPriority {
    pub fn as_str(&self) -> &'static str {
        match self {
            TaskPriority::High => "high",
            TaskPriority::Medium => "medium",
            TaskPriority::Low => "low",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "high" | "高" => Some(TaskPriority::High),
            "medium" | "med" | "中" => Some(TaskPriority::Medium),
            "low" | "低" => Some(TaskPriority::Low),
            _ => None,
        }
    }
}

/// Task record extracted from markdown
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: Option<i64>,
    pub note_path: String,
    pub line_number: i32,
    pub raw_text: String,
    pub is_completed: bool,
    pub due_date: Option<String>, // ISO date: "2026-01-25"
    pub assignee: Option<String>, // Username
    pub priority: Option<String>, // "high" | "medium" | "low"
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
}

impl Task {
    /// Create a new task from parsed data
    pub fn new(note_path: &str, line_number: i32, raw_text: &str, is_completed: bool) -> Self {
        Task {
            id: None,
            note_path: note_path.to_string(),
            line_number,
            raw_text: raw_text.to_string(),
            is_completed,
            due_date: None,
            assignee: None,
            priority: None,
            created_at: None,
            updated_at: None,
        }
    }
}
