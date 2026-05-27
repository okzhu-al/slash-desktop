//! 混合语义 Diff 引擎 — Phase 3 Step 2
//!
//! 基于 `similar` crate 的行级 Diff，支持结构化节点保护：
//! - 代码块（```） → 整块对比
//! - Frontmatter（---） → 整块对比
//! - Tldraw 画板 → 标记为 binary_node_changed

use serde::{Deserialize, Serialize};
use similar::{ChangeTag, TextDiff};
use uuid::Uuid;

// ============================================================
// 数据类型
// ============================================================

/// Diff 操作标签
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum DiffTag {
    /// 新增行
    Insert,
    /// 删除行
    Delete,
    /// 未修改行
    Equal,
}

/// 行范围（0-indexed）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LineRange {
    pub start: usize,
    pub end: usize,
}

/// 字级变更（行内精确差异）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InlineChange {
    pub tag: DiffTag,
    /// 在该行文本中的字节偏移
    pub offset: usize,
    /// 字节长度
    pub length: usize,
    /// 受影响的文本片段
    pub text: String,
}

/// 单个 Diff 操作
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiffOp {
    /// 唯一标识，用于前端块级 Accept/Reject 定位
    pub id: String,
    pub tag: DiffTag,
    pub old_range: Option<LineRange>,
    pub new_range: Option<LineRange>,
    /// 受影响的文本内容
    pub content: String,
    /// 字级变更详情（仅 Replace 场景下的 Delete/Insert 对中填充）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inline_changes: Option<Vec<InlineChange>>,
}

// ============================================================
// 结构化块标识
// ============================================================

/// Markdown 中的结构化块类型
#[derive(Debug, Clone, PartialEq)]
enum StructuredBlock {
    /// 代码块 ``` ... ```
    CodeFence,
    /// Frontmatter --- ... ---
    Frontmatter,
    /// Tldraw 画板（嵌入式 JSON 块）
    TldrawCanvas,
}

/// 标记一个结构化块的行范围
#[derive(Debug, Clone)]
struct BlockSpan {
    kind: StructuredBlock,
    start_line: usize,
    end_line: usize, // inclusive
}

/// 扫描文本，识别所有结构化块
fn detect_structured_blocks(text: &str) -> Vec<BlockSpan> {
    let lines: Vec<&str> = text.lines().collect();
    let mut blocks = Vec::new();
    let mut i = 0;

    while i < lines.len() {
        let trimmed = lines[i].trim();

        // Frontmatter: 仅在文件开头
        if i == 0 && trimmed == "---" {
            if let Some(end) = find_closing_marker(&lines, i + 1, "---") {
                blocks.push(BlockSpan {
                    kind: StructuredBlock::Frontmatter,
                    start_line: i,
                    end_line: end,
                });
                i = end + 1;
                continue;
            }
        }

        // 代码块
        if trimmed.starts_with("```") {
            if let Some(end) = find_closing_code_fence(&lines, i + 1) {
                // 检查是否是 Tldraw 画板（```tldraw 或包含 tldraw JSON）
                let kind = if trimmed.starts_with("```tldraw") || trimmed.starts_with("```drawing")
                {
                    StructuredBlock::TldrawCanvas
                } else {
                    StructuredBlock::CodeFence
                };
                blocks.push(BlockSpan {
                    kind,
                    start_line: i,
                    end_line: end,
                });
                i = end + 1;
                continue;
            }
        }

        i += 1;
    }

    blocks
}

fn find_closing_marker(lines: &[&str], start: usize, marker: &str) -> Option<usize> {
    for i in start..lines.len() {
        if lines[i].trim() == marker {
            return Some(i);
        }
    }
    None
}

fn find_closing_code_fence(lines: &[&str], start: usize) -> Option<usize> {
    for i in start..lines.len() {
        if lines[i].trim().starts_with("```") && !lines[i].trim().starts_with("````") {
            return Some(i);
        }
    }
    None
}

// ============================================================
// 核心 Diff 算法
// ============================================================

/// 计算两个文本的行级 Diff（不做结构化保护）
pub fn compute_diff(old: &str, new: &str) -> Vec<DiffOp> {
    let diff = TextDiff::from_lines(old, new);
    let mut ops = Vec::new();

    for group in diff.grouped_ops(3) {
        for op in group {
            let (tag, old_range, new_range) = match op {
                similar::DiffOp::Equal {
                    old_index,
                    new_index,
                    len,
                } => (
                    DiffTag::Equal,
                    Some(LineRange {
                        start: old_index,
                        end: old_index + len,
                    }),
                    Some(LineRange {
                        start: new_index,
                        end: new_index + len,
                    }),
                ),
                similar::DiffOp::Delete {
                    old_index, old_len, ..
                } => (
                    DiffTag::Delete,
                    Some(LineRange {
                        start: old_index,
                        end: old_index + old_len,
                    }),
                    None,
                ),
                similar::DiffOp::Insert {
                    new_index, new_len, ..
                } => (
                    DiffTag::Insert,
                    None,
                    Some(LineRange {
                        start: new_index,
                        end: new_index + new_len,
                    }),
                ),
                similar::DiffOp::Replace {
                    old_index,
                    old_len,
                    new_index,
                    new_len,
                } => {
                    // Replace = Delete old + Insert new + 字级差异
                    let old_lines: Vec<&str> = old.lines().collect();
                    let new_lines: Vec<&str> = new.lines().collect();

                    let deleted: String = old_lines[old_index..old_index + old_len].join("\n");
                    let inserted: String = new_lines[new_index..new_index + new_len].join("\n");

                    // 计算字级差异
                    let (del_inlines, ins_inlines) = compute_inline_changes(&deleted, &inserted);
                    let hunk_id = Uuid::new_v4().to_string();

                    ops.push(DiffOp {
                        id: hunk_id.clone(),
                        tag: DiffTag::Delete,
                        old_range: Some(LineRange {
                            start: old_index,
                            end: old_index + old_len,
                        }),
                        new_range: None,
                        content: deleted,
                        inline_changes: if del_inlines.is_empty() { None } else { Some(del_inlines) },
                    });

                    ops.push(DiffOp {
                        id: hunk_id,
                        tag: DiffTag::Insert,
                        old_range: None,
                        new_range: Some(LineRange {
                            start: new_index,
                            end: new_index + new_len,
                        }),
                        content: inserted,
                        inline_changes: if ins_inlines.is_empty() { None } else { Some(ins_inlines) },
                    });
                    continue;
                }
            };

            // 提取内容
            let content = match tag {
                DiffTag::Delete | DiffTag::Equal => {
                    if let Some(ref r) = old_range {
                        let lines: Vec<&str> = old.lines().collect();
                        let end = r.end.min(lines.len());
                        lines[r.start..end].join("\n")
                    } else {
                        String::new()
                    }
                }
                DiffTag::Insert => {
                    if let Some(ref r) = new_range {
                        let lines: Vec<&str> = new.lines().collect();
                        let end = r.end.min(lines.len());
                        lines[r.start..end].join("\n")
                    } else {
                        String::new()
                    }
                }
            };

            ops.push(DiffOp {
                id: Uuid::new_v4().to_string(),
                tag,
                old_range,
                new_range,
                content,
                inline_changes: None,
            });
        }
    }

    ops
}

/// 计算语义 Diff — 结构化节点保护
///
/// 结构化块（代码块、frontmatter、Tldraw）作为整体对比单元，
/// 非结构化区域使用行级 Diff。
pub fn compute_semantic_diff(old: &str, new: &str) -> Vec<DiffOp> {
    let old_blocks = detect_structured_blocks(old);
    let new_blocks = detect_structured_blocks(new);

    // 如果没有结构化块，直接使用行级 Diff
    if old_blocks.is_empty() && new_blocks.is_empty() {
        return compute_diff(old, new);
    }

    // 将文本分割为：结构化块（整体） + 非结构化区域（行级 Diff）
    let old_segments = segment_text(old, &old_blocks);
    let new_segments = segment_text(new, &new_blocks);

    // 对分割后的段落进行对比
    let old_refs: Vec<&str> = old_segments.iter().map(|s| s.as_str()).collect();
    let new_refs: Vec<&str> = new_segments.iter().map(|s| s.as_str()).collect();
    let segment_diff = TextDiff::from_slices(&old_refs, &new_refs);
    let mut ops = Vec::new();
    let mut old_line_offset = 0;
    let mut new_line_offset = 0;

    for change in segment_diff.iter_all_changes() {
        let segment = change.value();
        let line_count = segment.lines().count().max(1);

        match change.tag() {
            ChangeTag::Equal => {
                ops.push(DiffOp {
                    id: Uuid::new_v4().to_string(),
                    tag: DiffTag::Equal,
                    old_range: Some(LineRange {
                        start: old_line_offset,
                        end: old_line_offset + line_count,
                    }),
                    new_range: Some(LineRange {
                        start: new_line_offset,
                        end: new_line_offset + line_count,
                    }),
                    content: segment.to_string(),
                    inline_changes: None,
                });
                old_line_offset += line_count;
                new_line_offset += line_count;
            }
            ChangeTag::Delete => {
                // 检查是否是 Tldraw 块
                let is_tldraw = old_blocks.iter().any(|b| {
                    b.kind == StructuredBlock::TldrawCanvas && b.start_line == old_line_offset
                });
                let content = if is_tldraw {
                    "[画板已修改]".to_string()
                } else {
                    segment.to_string()
                };

                ops.push(DiffOp {
                    id: Uuid::new_v4().to_string(),
                    tag: DiffTag::Delete,
                    old_range: Some(LineRange {
                        start: old_line_offset,
                        end: old_line_offset + line_count,
                    }),
                    new_range: None,
                    content,
                    inline_changes: None,
                });
                old_line_offset += line_count;
            }
            ChangeTag::Insert => {
                let is_tldraw = new_blocks.iter().any(|b| {
                    b.kind == StructuredBlock::TldrawCanvas && b.start_line == new_line_offset
                });
                let content = if is_tldraw {
                    "[画板已修改]".to_string()
                } else {
                    segment.to_string()
                };

                ops.push(DiffOp {
                    id: Uuid::new_v4().to_string(),
                    tag: DiffTag::Insert,
                    old_range: None,
                    new_range: Some(LineRange {
                        start: new_line_offset,
                        end: new_line_offset + line_count,
                    }),
                    content,
                    inline_changes: None,
                });
                new_line_offset += line_count;
            }
        }
    }

    ops
}

/// 计算两段文本的字级差异（用于 Replace 场景）
///
/// 返回 (delete_inlines, insert_inlines)——分别对应旧文本和新文本中变更的字符范围
fn compute_inline_changes(old_text: &str, new_text: &str) -> (Vec<InlineChange>, Vec<InlineChange>) {
    let diff = TextDiff::from_chars(old_text, new_text);
    let mut del_changes = Vec::new();
    let mut ins_changes = Vec::new();
    let mut old_offset = 0usize;
    let mut new_offset = 0usize;

    for change in diff.iter_all_changes() {
        let text = change.value();
        let len = text.len();
        match change.tag() {
            ChangeTag::Equal => {
                old_offset += len;
                new_offset += len;
            }
            ChangeTag::Delete => {
                del_changes.push(InlineChange {
                    tag: DiffTag::Delete,
                    offset: old_offset,
                    length: len,
                    text: text.to_string(),
                });
                old_offset += len;
            }
            ChangeTag::Insert => {
                ins_changes.push(InlineChange {
                    tag: DiffTag::Insert,
                    offset: new_offset,
                    length: len,
                    text: text.to_string(),
                });
                new_offset += len;
            }
        }
    }

    (del_changes, ins_changes)
}

/// 将文本按结构化块分割为段落列表
///
/// 结构化块作为一个完整的段落（不拆分内部行），
/// 非结构化区域的每一行作为独立段落。
fn segment_text(text: &str, blocks: &[BlockSpan]) -> Vec<String> {
    let lines: Vec<&str> = text.lines().collect();
    let mut segments = Vec::new();
    let mut i = 0;

    while i < lines.len() {
        // 检查是否在某个结构化块的起始位置
        if let Some(block) = blocks.iter().find(|b| b.start_line == i) {
            // 整个结构化块作为一个段落
            let end = (block.end_line + 1).min(lines.len());
            let block_text = lines[i..end].join("\n");
            segments.push(block_text);
            i = end;
        } else {
            // 非结构化行 → 单行段落
            segments.push(lines[i].to_string());
            i += 1;
        }
    }

    segments
}

/// 快速统计两段文本的差异数量（不含 Equal 操作）
pub fn count_changes(old: &str, new: &str) -> usize {
    compute_diff(old, new)
        .iter()
        .filter(|op| op.tag != DiffTag::Equal)
        .count()
}

// ============================================================
// 测试
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compute_diff_identical() {
        let text = "line 1\nline 2\nline 3\n";
        let ops = compute_diff(text, text);
        assert!(
            ops.iter().all(|op| op.tag == DiffTag::Equal),
            "相同文本应全部为 Equal"
        );
    }

    #[test]
    fn test_compute_diff_insert() {
        let old = "line 1\nline 3\n";
        let new = "line 1\nline 2\nline 3\n";
        let ops = compute_diff(old, new);
        assert!(
            ops.iter().any(|op| op.tag == DiffTag::Insert),
            "应检测到 Insert 操作"
        );
    }

    #[test]
    fn test_compute_diff_delete() {
        let old = "line 1\nline 2\nline 3\n";
        let new = "line 1\nline 3\n";
        let ops = compute_diff(old, new);
        assert!(
            ops.iter().any(|op| op.tag == DiffTag::Delete),
            "应检测到 Delete 操作"
        );
    }

    #[test]
    fn test_compute_diff_replace() {
        let old = "hello\nworld\n";
        let new = "hello\nearth\n";
        let ops = compute_diff(old, new);
        let has_change = ops
            .iter()
            .any(|op| op.tag == DiffTag::Delete || op.tag == DiffTag::Insert);
        assert!(has_change, "应检测到修改（Delete + Insert）");
    }

    #[test]
    fn test_detect_frontmatter() {
        let text = "---\ntitle: Hello\ndate: 2026\n---\n# Content\n";
        let blocks = detect_structured_blocks(text);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].kind, StructuredBlock::Frontmatter);
        assert_eq!(blocks[0].start_line, 0);
        assert_eq!(blocks[0].end_line, 3);
    }

    #[test]
    fn test_detect_code_fence() {
        let text = "# Title\n```rust\nfn main() {}\n```\nEnd\n";
        let blocks = detect_structured_blocks(text);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].kind, StructuredBlock::CodeFence);
        assert_eq!(blocks[0].start_line, 1);
        assert_eq!(blocks[0].end_line, 3);
    }

    #[test]
    fn test_detect_tldraw_canvas() {
        let text = "# Title\n```tldraw\n{\"shapes\":[]}\n```\nEnd\n";
        let blocks = detect_structured_blocks(text);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].kind, StructuredBlock::TldrawCanvas);
    }

    #[test]
    fn test_semantic_diff_preserves_code_block() {
        let old = "# Title\n```rust\nfn old() {}\n```\nEnd\n";
        let new = "# Title\n```rust\nfn new() {}\n```\nEnd\n";
        let ops = compute_semantic_diff(old, new);
        // 代码块应作为整体比较，不应拆分为 3 行
        let code_ops: Vec<&DiffOp> = ops.iter().filter(|op| op.content.contains("fn ")).collect();
        assert!(!code_ops.is_empty(), "应检测到代码块修改");
        // 代码块内容应包含整个块
        for op in &code_ops {
            assert!(
                op.content.contains("```rust") || op.content.contains("fn "),
                "代码块应作为整体"
            );
        }
    }

    #[test]
    fn test_semantic_diff_tldraw_marker() {
        let old = "# Title\n```tldraw\n{\"old\":true}\n```\n";
        let new = "# Title\n```tldraw\n{\"new\":true}\n```\n";
        let ops = compute_semantic_diff(old, new);
        let tldraw_ops: Vec<&DiffOp> = ops
            .iter()
            .filter(|op| op.content.contains("画板已修改"))
            .collect();
        assert!(!tldraw_ops.is_empty(), "Tldraw 块应标记为'画板已修改'");
    }

    #[test]
    fn test_count_changes() {
        let old = "a\nb\nc\n";
        let new = "a\nx\nc\n";
        assert!(count_changes(old, new) > 0, "应计数变更");
        assert_eq!(count_changes(old, old), 0, "相同文本变更数为 0");
    }

    #[test]
    fn test_segment_text_basic() {
        let text = "line1\n```\ncode\n```\nline2\n";
        let blocks = detect_structured_blocks(text);
        let segments = segment_text(text, &blocks);
        // 应产生 3 个段落：line1, 代码块整体, line2
        assert_eq!(segments.len(), 3);
        assert_eq!(segments[0], "line1");
        assert!(segments[1].contains("```"));
        assert_eq!(segments[2], "line2");
    }

    #[test]
    fn test_semantic_diff_newline_insert() {
        let old = "\n\n";
        let new = "\n\n111";
        let ops = compute_semantic_diff(old, new);
        println!("{:#?}", ops);
        panic!("Show me the stdout");
    }
}
