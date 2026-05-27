//! Task Scanner Module
//!
//! Extracts task metadata from markdown content using independent extractors.
//! Supports Date/User/Priority in any order.

use crate::core::db::models::{Task, TaskPriority};
use regex::Regex;

/// Extract due date from task text
/// Pattern: 📅YYYY-MM-DD
fn extract_date(text: &str) -> Option<String> {
    // Match emoji followed by date, or just date pattern
    let re = Regex::new(r"📅(\d{4}-\d{2}-\d{2})").ok()?;
    re.captures(text)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().to_string())
}

/// Extract all assignees from task text
/// Pattern: @username (non-whitespace after @)
/// Returns comma-separated list if multiple: "张三,李四"
fn extract_assignee(text: &str) -> Option<String> {
    // Match @ preceded by whitespace or start of line, followed by non-whitespace characters
    let re = Regex::new(r"(?:\s|^)@(\S+?)(?:\s|$|[，。！？、])").ok()?;
    let assignees: Vec<String> = re
        .captures_iter(text)
        .filter_map(|caps| caps.get(1))
        .map(|m| m.as_str().to_string())
        .collect();

    if assignees.is_empty() {
        None
    } else {
        Some(assignees.join(","))
    }
}

/// Extract priority from task text
/// Pattern: 🚩High/Medium/Low OR #High/Medium/Low or Chinese equivalents
fn extract_priority(text: &str) -> Option<String> {
    // Match emoji OR # followed by priority text
    let re = Regex::new(r"(?:🚩|#)(High|Medium|Low|Med|高|中|低)").ok()?;
    re.captures(text)
        .and_then(|caps| caps.get(1))
        .and_then(|m| TaskPriority::from_str(m.as_str()))
        .map(|p| p.as_str().to_string())
}

/// Parse a single line as a task
/// Returns None if the line is not a task
pub fn parse_task_line(line: &str, note_path: &str, line_number: i32) -> Option<Task> {
    let line_trimmed = line.trim();

    // 基于第一性原理，使用 starts_with 绝对安全地处理 UTF-8 字符串前缀，彻底防御 Char Boundary 切片 Panic
    let (is_completed, rest) = if line_trimmed.starts_with("- [ ]") || line_trimmed.starts_with("* [ ]") {
        (false, &line_trimmed[5..])
    } else if line_trimmed.starts_with("- [x]") || line_trimmed.starts_with("- [X]") ||
              line_trimmed.starts_with("* [x]") || line_trimmed.starts_with("* [X]") {
        (true, &line_trimmed[5..])
    } else {
        return None;
    };

    let task_text = rest.trim();
    let mut task = Task::new(note_path, line_number, task_text, is_completed);

    task.due_date = extract_date(rest);
    task.assignee = extract_assignee(rest);
    task.priority = extract_priority(rest);

    Some(task)
}

/// Scan content for all tasks
pub fn scan_tasks(content: &str, note_path: &str) -> Vec<Task> {
    content
        .lines()
        .enumerate()
        .filter_map(|(idx, line)| parse_task_line(line, note_path, (idx + 1) as i32))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_date() {
        assert_eq!(
            extract_date("任务 📅2026-01-25"),
            Some("2026-01-25".to_string())
        );
        assert_eq!(
            extract_date("任务 📅2026-12-31 @老王"),
            Some("2026-12-31".to_string())
        );
        assert_eq!(extract_date("没有日期"), None);
    }

    #[test]
    fn test_extract_assignee() {
        assert_eq!(extract_assignee("任务 @老王"), Some("老王".to_string()));
        assert_eq!(
            extract_assignee("任务 @john_doe 完成"),
            Some("john_doe".to_string())
        );
        assert_eq!(extract_assignee("没有@人员"), None);
    }

    #[test]
    fn test_extract_priority() {
        assert_eq!(extract_priority("任务 🚩High"), Some("high".to_string()));
        assert_eq!(
            extract_priority("任务 🚩Medium 其他"),
            Some("medium".to_string())
        );
        assert_eq!(extract_priority("任务 🚩低"), Some("low".to_string()));
        assert_eq!(extract_priority("没有优先级"), None);
    }

    #[test]
    fn test_parse_task_line() {
        let task = parse_task_line("- [ ] 任务 📅2026-01-25 @老王 🚩High", "test.md", 1);
        assert!(task.is_some());
        let t = task.unwrap();
        assert!(!t.is_completed);
        assert_eq!(t.due_date, Some("2026-01-25".to_string()));
        assert_eq!(t.assignee, Some("老王".to_string()));
        assert_eq!(t.priority, Some("high".to_string()));
    }

    #[test]
    fn test_parse_task_any_order() {
        // Different order: priority, user, date
        let task = parse_task_line("- [ ] 任务 🚩Low @张三 📅2026-02-01", "test.md", 2);
        assert!(task.is_some());
        let t = task.unwrap();
        assert_eq!(t.due_date, Some("2026-02-01".to_string()));
        assert_eq!(t.assignee, Some("张三".to_string()));
        assert_eq!(t.priority, Some("low".to_string()));
    }

    #[test]
    fn test_completed_task() {
        let task = parse_task_line("- [x] 已完成 @李四", "test.md", 3);
        assert!(task.is_some());
        let t = task.unwrap();
        assert!(t.is_completed);
        assert_eq!(t.assignee, Some("李四".to_string()));
    }

    #[test]
    fn test_minimal_task() {
        let task = parse_task_line("- [ ] 无元数据任务", "test.md", 4);
        assert!(task.is_some());
        let t = task.unwrap();
        assert!(t.due_date.is_none());
        assert!(t.assignee.is_none());
        assert!(t.priority.is_none());
    }

    #[test]
    fn test_parse_task_edge_cases() {
        // 没有尾随空格且为空
        let task1 = parse_task_line("- [ ]", "test.md", 1);
        assert!(task1.is_some());
        let t1 = task1.unwrap();
        assert!(!t1.is_completed);
        assert_eq!(t1.raw_text, "");

        // 星号开头且没有空格
        let task2 = parse_task_line("* [x]星号任务", "test.md", 2);
        assert!(task2.is_some());
        let t2 = task2.unwrap();
        assert!(t2.is_completed);
        assert_eq!(t2.raw_text, "星号任务");

        // 星号开头有空格
        let task3 = parse_task_line("* [ ] 星号未完成", "test.md", 3);
        assert!(task3.is_some());
        let t3 = task3.unwrap();
        assert!(!t3.is_completed);
        assert_eq!(t3.raw_text, "星号未完成");
    }
}
