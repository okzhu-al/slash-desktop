//! 关系推理技能 (ReasoningSkill)
//!
//! 批量分析候选笔记与源笔记的语义关系
//! 使用编号选择题式 prompt，4 类 18 种分层关系分类
//!
//! 输入: 源笔记摘要 + 候选笔记摘要
//! 输出: JSON { "1": {"relation": "A3", "reason": "..."}, ... }

use super::{Skill, TriggerType};
use anyhow::Result;
use serde::{Deserialize, Serialize};

// ============================================================================
// Relation Taxonomy: 4 categories, 18 types
// ============================================================================

/// Map relation code (e.g. "A3") to canonical English slug
pub fn code_to_slug(code: &str) -> &'static str {
    match code.to_uppercase().as_str() {
        // A. Cognitive (How ideas connect)
        "A1" => "supports",
        "A2" => "contradicts",
        "A3" => "extends",
        "A4" => "example",
        "A5" => "precedes",
        "A6" => "partOf",
        "A7" => "analogy",
        // B. Practical (How things get done)
        "B1" => "implements",
        "B2" => "applies",
        "B3" => "alternative",
        "B4" => "evolves",
        // C. Entity (Who/What/Where)
        "C1" => "creates",
        "C2" => "belongsTo",
        "C3" => "locatedIn",
        "C4" => "uses",
        // D. Social (How people connect)
        "D1" => "collaborates",
        "D2" => "mentors",
        "D3" => "influences",
        "D4" => "opposes",
        // Fallback
        _ => "related",
    }
}

/// Map Chinese relation names to canonical slugs (backward compatibility)
pub fn cn_to_slug(cn: &str) -> &'static str {
    match cn {
        "支持" => "supports",
        "反驳" => "contradicts",
        "扩展" => "extends",
        "案例" => "example",
        "前置" => "precedes",
        "组成" => "partOf",
        "类比" => "analogy",
        "实现" => "implements",
        "应用" | "应用于" => "applies",
        "替代" => "alternative",
        "演化" => "evolves",
        "创建" | "作者" => "creates",
        "属于" | "亲属" => "belongsTo",
        "位于" => "locatedIn",
        "使用" => "uses",
        "合作" => "collaborates",
        "师承" | "师生" => "mentors",
        "影响" | "启发自" => "influences",
        "对立" | "敌对" => "opposes",
        "相关" => "related",
        _ => "related",
    }
}

/// Normalize any relation string (code like "A3", Chinese like "支持", or slug like "supports") to slug
pub fn normalize_relation(raw: &str) -> String {
    let trimmed = raw.trim();

    // 1. Try code (e.g. "A3", "B1")
    if trimmed.len() == 2 {
        let slug = code_to_slug(trimmed);
        if slug != "related" || trimmed.eq_ignore_ascii_case("A0") {
            return slug.to_string();
        }
    }

    // 2. Try Chinese
    let slug = cn_to_slug(trimmed);
    if slug != "related" || trimmed == "相关" {
        return slug.to_string();
    }

    // 3. Already a valid English slug? Return as-is
    let known_slugs = [
        "supports",
        "contradicts",
        "extends",
        "example",
        "precedes",
        "partOf",
        "analogy",
        "implements",
        "applies",
        "alternative",
        "evolves",
        "creates",
        "belongsTo",
        "locatedIn",
        "uses",
        "collaborates",
        "mentors",
        "influences",
        "opposes",
        "related",
    ];
    let lower = trimmed.to_lowercase();
    for s in &known_slugs {
        if lower == s.to_lowercase() {
            return s.to_string();
        }
    }

    // 4. Fallback
    "related".to_string()
}

// ============================================================================
// Data Types
// ============================================================================

/// Reasoning input: source summary and target candidates
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReasoningInput {
    pub source_title: String,
    pub source_summary: String,
    pub targets: Vec<TargetCandidate>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TargetCandidate {
    pub title: String,
    pub summary: String,
    pub similarity: f64,
}

/// Reasoning output for a single target
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReasoningResult {
    pub relation: String,
    pub reason: String,
}

// ============================================================================
// Skill Implementation
// ============================================================================

const TAXONOMY_PROMPT: &str = r#"A.Cognitive: A1.Supports A2.Contradicts A3.Extends A4.Example A5.Precedes A6.PartOf A7.Analogy
B.Practical: B1.Implements B2.Applies B3.Alternative B4.Evolves
C.Entity: C1.Creates C2.BelongsTo C3.LocatedIn C4.Uses
D.Social: D1.Collaborates D2.Mentors D3.Influences D4.Opposes"#;

/// Reasoning Skill - Batch analysis of semantic relationships
pub struct ReasoningSkill;

impl Skill for ReasoningSkill {
    type Output = Vec<ReasoningResult>;

    fn id(&self) -> &'static str {
        "reasoning"
    }

    fn default_triggers(&self) -> Vec<TriggerType> {
        // Reasoning is lazy-loaded on demand, not auto-triggered
        vec![]
    }

    fn system_prompt(&self) -> String {
        format!(
            r#"You are a knowledge graph relation classifier.
Given a SOURCE note and a TARGET note, pick the SINGLE best relation code for the pair.

### Relation Taxonomy:
{}

### Output Format:
CRITICAL: Output EXACTLY one flat JSON object with BOTH "relation" and "reason" keys. Nothing else.
Example: {{"relation": "A3", "reason": "both discuss knowledge management"}}

WARNING: Do NOT use numbered keys like {{"1": {{...}}}}.
WARNING: The "reason" key is MANDATORY. Do NOT output only the relation.

### Rules:
1. HIGHEST PRIORITY - LANGUAGE: Write the reason in the SAME language as the notes.
   - Chinese notes -> Chinese reason. English notes -> English reason.
   - 如果笔记是中文，你必须用中文写 reason。
2. Use the relation CODE (like "A3"), not the name.
3. Reason must be under 30 words. Be SPECIFIC: mention the concrete concepts that connect the two notes. Do NOT write generic reasons like 'both discuss similar topics'.
4. Choose the MOST SPECIFIC relation code. Prefer A1-A5 over C1-C5 when a clear conceptual match exists.
5. Only set relation to empty string if there is absolutely NO conceptual connection.
6. NEVER use double quotes inside reason text. Use single quotes instead.
7. NEVER wrap in markdown code fences. Just raw JSON."#,
            TAXONOMY_PROMPT
        )
    }

    fn user_prompt(&self, content: &str) -> String {
        // Pass content through directly - format instructions are in system_prompt
        content.to_string()
    }

    fn parse_response(&self, raw_response: &str) -> Result<Self::Output> {
        let raw_chars = raw_response.chars().count();
        let raw_bytes = raw_response.len();
        let tail: String = raw_response
            .chars()
            .rev()
            .take(60)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        log::debug!(
            "🧠 [ReasoningSkill] Raw response: {} chars / {} bytes, tail=|{}|",
            raw_chars, raw_bytes, tail
        );

        let cleaned = extract_json(raw_response);
        log::debug!(
            "🧠 [ReasoningSkill] Cleaned JSON: {} chars / {} bytes",
            cleaned.chars().count(),
            cleaned.len()
        );

        match serde_json::from_str::<serde_json::Value>(&cleaned) {
            Ok(parsed) => {
                let mut results = Vec::new();
                if let Some(obj) = parsed.as_object() {
                    // Flat format: {"relation": "A3", "reason": "..."}
                    if obj.contains_key("relation") {
                        let raw_relation =
                            obj.get("relation").and_then(|v| v.as_str()).unwrap_or("");
                        let relation = normalize_relation(raw_relation);
                        let reason = obj
                            .get("reason")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        results.push(ReasoningResult { relation, reason });
                    } else {
                        // Fallback: numbered format {"1": {...}} - extract first valid entry
                        for i in 1..=obj.len() {
                            let key = i.to_string();
                            if let Some(item) = obj.get(&key) {
                                let raw_relation =
                                    item.get("relation").and_then(|v| v.as_str()).unwrap_or("");
                                let relation = normalize_relation(raw_relation);
                                let reason = item
                                    .get("reason")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                results.push(ReasoningResult { relation, reason });
                                // Only take the first valid result (single-target mode)
                                break;
                            }
                        }
                    }
                }
                // Filter out entries with empty relation (LLM said "no relation") or empty reason
                results.retain(|r| {
                    let valid_relation = !r.relation.is_empty() && r.relation != "none";
                    let valid_reason = !r.reason.trim().is_empty();
                    if valid_relation && !valid_reason {
                        log::warn!(
                            "⚠️ [ReasoningSkill] Dropping result due to empty reason (relation={})",
                            r.relation
                        );
                    }
                    valid_relation && valid_reason
                });
                if results.is_empty() {
                    log::warn!(
                        "⏭️ [ReasoningSkill] All results had empty/none relation or empty reason, returning empty"
                    );
                }
                Ok(results)
            }
            Err(e) => {
                log::warn!(
                    "⚠️ [ReasoningSkill] JSON parse failed: {}, trying Level C regex extraction",
                    e
                );

                // Level C: regex extraction from broken/truncated JSON
                let relation_re = regex::Regex::new(r#"["']?relation["']?\s*:\s*["']([^"']+)["']"#).unwrap();
                if let Some(cap) = relation_re.captures(&cleaned) {
                    let relation = normalize_relation(&cap[1]);
                    
                    let reason = if let Some(c) = regex::Regex::new(r#"(?s)"reason"\s*:\s*"(.*)"#).unwrap().captures(&cleaned) {
                        c[1].trim_end_matches(|ch| ch == '}' || ch == ' ' || ch == '\n' || ch == '\r' || ch == '"').to_string()
                    } else if let Some(c) = regex::Regex::new(r#"(?s)'reason'\s*:\s*'(.*)"#).unwrap().captures(&cleaned) {
                        c[1].trim_end_matches(|ch| ch == '}' || ch == ' ' || ch == '\n' || ch == '\r' || ch == '\'').to_string()
                    } else if let Some(c) = regex::Regex::new(r#"(?s)["']?reason["']?\s*:\s*["']?(.*)"#).unwrap().captures(&cleaned) {
                        c[1].trim_end_matches(|ch| ch == '}' || ch == ' ' || ch == '\n' || ch == '\r' || ch == '"' || ch == '\'').to_string()
                    } else {
                        String::new()
                    };
                    // If we got here, JSON was broken → reason is likely truncated
                    if reason.trim().is_empty() {
                        log::warn!(
                            "❌ [ReasoningSkill] Level C extract failed: reason is empty (relation={})",
                            relation
                        );
                        return Ok(vec![]);
                    }
                    let final_reason = format!("{}…(截断)", reason);
                    log::warn!(
                        "🔧 [ReasoningSkill] Level C rescue: relation='{}', reason_truncated=true",
                        relation
                    );
                    return Ok(vec![ReasoningResult {
                        relation,
                        reason: final_reason,
                    }]);
                }

                // Level D: nothing extractable
                log::warn!("❌ [ReasoningSkill] Level C failed too, returning empty");
                Ok(vec![])
            }
        }
    }

    fn max_output_tokens(&self) -> u32 {
        1024
    }
}

// ============================================================================
// Prompt Builders
// ============================================================================

/// Build the user prompt content for reasoning (GhostLink scenario)
pub fn build_reasoning_prompt(input: &ReasoningInput) -> String {
    let clean_source_title = super::sanitize_prompt_content(&input.source_title);
    let clean_source_summary = super::sanitize_prompt_content(&input.source_summary);
    let clean_targets: Vec<TargetCandidate> = input
        .targets
        .iter()
        .map(|t| TargetCandidate {
            title: super::sanitize_prompt_content(&t.title),
            summary: super::sanitize_prompt_content(&t.summary),
            similarity: t.similarity,
        })
        .collect();

    // Detect if content is primarily CJK (Chinese/Japanese/Korean)
    let all_text = format!(
        "{} {} {}",
        clean_source_title,
        clean_source_summary,
        clean_targets
            .iter()
            .map(|t| format!("{} {}", t.title, t.summary))
            .collect::<Vec<_>>()
            .join(" ")
    );
    let cjk_count = all_text
        .chars()
        .filter(|c| {
            let cp = *c as u32;
            (0x4E00..=0x9FFF).contains(&cp) ||  // CJK Unified
        (0x3400..=0x4DBF).contains(&cp) ||  // CJK Extension A
        (0x3000..=0x303F).contains(&cp) // CJK Symbols
        })
        .count();
    let is_cjk = cjk_count > 5; // If more than 5 CJK chars, treat as CJK content
    let lang_hint = if is_cjk {
        "\n\n[LANGUAGE: 请用中文写 reason。]"
    } else {
        ""
    };

    // Single-target mode (always used by GhostLink backend)
    if clean_targets.len() == 1 {
        let t = &clean_targets[0];
        return format!(
            r#"SOURCE [{}]: "{}"

TARGET [{}] (similarity: {:.0}%): "{}"{}"#,
            clean_source_title,
            clean_source_summary,
            t.title,
            t.similarity * 100.0,
            t.summary,
            lang_hint
        );
    }

    // Multi-target mode: numbered list (batch scenario)
    let mut targets_str = String::new();
    for (i, target) in clean_targets.iter().enumerate() {
        targets_str.push_str(&format!(
            "{}. [{}] (similarity: {:.0}%): \"{}\"\n",
            i + 1,
            target.title,
            target.similarity * 100.0,
            target.summary
        ));
    }

    format!(
        r#"SOURCE [{}]: "{}"

TARGETS (pre-filtered by semantic similarity):
{}{}"#,
        clean_source_title,
        clean_source_summary,
        targets_str.trim(),
        lang_hint
    )
}

/// Build prompt for single-pair reasoning (WikiLink scenario)
pub fn build_pairwise_prompt(
    source_title: &str,
    source_summary: &str,
    target_title: &str,
    target_summary: &str,
) -> String {
    let clean_source_title = super::sanitize_prompt_content(source_title);
    let clean_source_summary = super::sanitize_prompt_content(source_summary);
    let clean_target_title = super::sanitize_prompt_content(target_title);
    let clean_target_summary = super::sanitize_prompt_content(target_summary);

    format!(
        r#"SOURCE [{}]: "{}"

TARGETS:
1. [{}]: "{}""#,
        clean_source_title, clean_source_summary, clean_target_title, clean_target_summary
    )
}

// ============================================================================
// JSON Extraction Helpers
// ============================================================================

/// Try to extract valid JSON from potentially mixed text
fn extract_json(raw: &str) -> String {
    let trimmed = raw.trim();

    // Remove markdown code fences (multiple patterns)
    let cleaned = trimmed
        .trim_start_matches("```json")
        .trim_start_matches("```JSON")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    // Check if it starts with array bracket
    if cleaned.starts_with('[') {
        if let Some(end) = cleaned.rfind(']') {
            let array_str = &cleaned[..=end];

            // Try to parse as array and merge into single object
            if let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(array_str) {
                let mut merged = serde_json::Map::new();
                for item in arr {
                    if let Some(obj) = item.as_object() {
                        for (k, v) in obj {
                            merged.insert(k.clone(), v.clone());
                        }
                    }
                }
                if !merged.is_empty() {
                    return serde_json::to_string(&merged).unwrap_or_else(|_| cleaned.to_string());
                }
            }

            // Handle malformed JSON like [ "1": {...}, "2": {...} ]
            if array_str.contains("\": {") || array_str.contains("\":") {
                let fixed = format!("{{{}}}", &array_str[1..array_str.len() - 1]);
                if serde_json::from_str::<serde_json::Value>(&fixed).is_ok() {
                    return fixed;
                }
            }
        }
    }

    // Try to find JSON object boundaries
    if let Some(start) = cleaned.find('{') {
        if let Some(end) = cleaned.rfind('}') {
            if end > start {
                let candidate = cleaned[start..=end].to_string();
                // Verify the extracted JSON is valid; if not, try repair
                if serde_json::from_str::<serde_json::Value>(&candidate).is_ok() {
                    return candidate;
                }
                // Fix: double JSON like "{}\n{...actual...}" - try last complete object
                // Find the last '{' that starts a valid JSON object
                let bytes = cleaned.as_bytes();
                let mut pos = end;
                while pos > start {
                    if bytes[pos] == b'}' {
                        // Walk backwards to find matching '{'
                        let mut depth = 0;
                        let mut scan = pos;
                        loop {
                            if bytes[scan] == b'}' {
                                depth += 1;
                            } else if bytes[scan] == b'{' {
                                depth -= 1;
                                if depth == 0 {
                                    let last_obj = &cleaned[scan..=pos];
                                    if serde_json::from_str::<serde_json::Value>(last_obj).is_ok() {
                                        log::warn!(
                                            "🔧 [ReasoningSkill] Extracted last JSON object from multi-JSON (offset {})",
                                            scan
                                        );
                                        return last_obj.to_string();
                                    }
                                    break;
                                }
                            }
                            if scan == 0 {
                                break;
                            }
                            scan -= 1;
                        }
                    }
                    if pos == 0 {
                        break;
                    }
                    pos -= 1;
                }
            }
        }
        // No valid JSON found — truncated or malformed
        // Stage 1: try to truncate to last safe token boundary, then repair
        let fragment = &cleaned[start..];
        let repaired = repair_truncated_json(fragment);
        if serde_json::from_str::<serde_json::Value>(&repaired).is_ok() {
            log::warn!(
                "🔧 [ReasoningSkill] Repaired truncated JSON (local, {} bytes)",
                repaired.len()
            );
            return repaired;
        }
        log::warn!(
            "[ReasoningSkill] Local repair failed for fragment starting at byte {}, returning raw",
            start
        );
    }

    cleaned.to_string()
}

/// Attempt to repair truncated JSON by:
/// 1. Truncating to last safe entry boundary (e.g., last "}, or "})
/// 2. Closing unclosed strings
/// 3. Closing unclosed brackets/braces
fn repair_truncated_json(fragment: &str) -> String {
    let mut result = fragment.to_string();

    // Step 1: Try to truncate to last safe entry boundary
    // Look for the last complete entry marker: "}, or "}
    // This discards partial entries that would fail to parse even after bracket closing
    let safe_boundaries = ["\"},", "\"}"];
    let mut best_boundary_end = None;
    for boundary in &safe_boundaries {
        if let Some(pos) = result.rfind(boundary) {
            let end = pos + boundary.len();
            match best_boundary_end {
                None => best_boundary_end = Some(end),
                Some(prev) if end > prev => best_boundary_end = Some(end),
                _ => {}
            }
        }
    }
    if let Some(boundary_end) = best_boundary_end {
        // Only truncate if we'd be discarding a meaningful incomplete tail
        let tail = result[boundary_end..].trim();
        if !tail.is_empty() && serde_json::from_str::<serde_json::Value>(&result).is_err() {
            log::warn!(
                "✂️ [Repair] Truncating to safe boundary at byte {} (discarding {} bytes of incomplete tail)",
                boundary_end,
                result.len() - boundary_end
            );
            result = result[..boundary_end].to_string();
        }
    }

    // Step 2: Remove trailing comma if present (invalid JSON)
    let trimmed = result.trim_end();
    if trimmed.ends_with(',') {
        result = trimmed[..trimmed.len() - 1].to_string();
    }

    // Step 3: Check if we're inside an unclosed string
    let mut in_string = false;
    let mut escape_next = false;
    for ch in result.chars() {
        if escape_next {
            escape_next = false;
            continue;
        }
        if ch == '\\' {
            escape_next = true;
            continue;
        }
        if ch == '"' {
            in_string = !in_string;
        }
    }
    if in_string {
        result.push('"');
    }

    // Step 4: Count unclosed braces and brackets
    let mut brace_depth = 0i32;
    let mut bracket_depth = 0i32;
    in_string = false;
    escape_next = false;
    for ch in result.chars() {
        if escape_next {
            escape_next = false;
            continue;
        }
        if ch == '\\' {
            escape_next = true;
            continue;
        }
        if ch == '"' {
            in_string = !in_string;
            continue;
        }
        if in_string {
            continue;
        }
        match ch {
            '{' => brace_depth += 1,
            '}' => brace_depth -= 1,
            '[' => bracket_depth += 1,
            ']' => bracket_depth -= 1,
            _ => {}
        }
    }

    // Step 5: Close unclosed brackets then braces
    for _ in 0..bracket_depth {
        result.push(']');
    }
    for _ in 0..brace_depth {
        result.push('}');
    }

    result
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_code_to_slug() {
        assert_eq!(code_to_slug("A1"), "supports");
        assert_eq!(code_to_slug("a3"), "extends");
        assert_eq!(code_to_slug("B4"), "evolves");
        assert_eq!(code_to_slug("D2"), "mentors");
        assert_eq!(code_to_slug("ZZ"), "related"); // fallback
    }

    #[test]
    fn test_cn_to_slug() {
        assert_eq!(cn_to_slug("支持"), "supports");
        assert_eq!(cn_to_slug("类比"), "analogy");
        assert_eq!(cn_to_slug("敌对"), "opposes");
        assert_eq!(cn_to_slug("未知"), "related"); // fallback
    }

    #[test]
    fn test_normalize_relation() {
        assert_eq!(normalize_relation("A3"), "extends");
        assert_eq!(normalize_relation("支持"), "supports");
        assert_eq!(normalize_relation("supports"), "supports");
        assert_eq!(normalize_relation("partOf"), "partOf");
        assert_eq!(normalize_relation("random_text"), "related");
    }

    #[test]
    fn test_parse_response_with_codes() {
        let skill = ReasoningSkill;
        let response = r#"{
  "1": { "relation": "A4", "reason": "马斯克造火箭是第一性原理的典型应用。" },
  "2": { "relation": "A1", "reason": "两者都阐述了孤立系统必然走向无序。" }
}"#;
        let results = skill.parse_response(response).unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].relation, "example");
        assert_eq!(results[1].relation, "supports");
    }

    #[test]
    fn test_parse_response_backward_compat() {
        let skill = ReasoningSkill;
        // Old-style Chinese relation names should still work
        let response = r#"{
  "1": { "relation": "案例", "reason": "test" },
  "2": { "relation": "反驳", "reason": "test" }
}"#;
        let results = skill.parse_response(response).unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].relation, "example");
        assert_eq!(results[1].relation, "contradicts");
    }

    #[test]
    fn test_build_pairwise_prompt() {
        let prompt = build_pairwise_prompt("NoteA", "Summary A", "NoteB", "Summary B");
        assert!(prompt.contains("SOURCE [NoteA]"));
        assert!(prompt.contains("1. [NoteB]"));
    }

    #[test]
    fn test_extract_json_code_fence() {
        let input = "```json\n{\"1\": {\"relation\": \"A3\", \"reason\": \"test\"}}\n```";
        let result = extract_json(input);
        assert!(serde_json::from_str::<serde_json::Value>(&result).is_ok());
    }

    #[test]
    fn test_repair_truncated_json() {
        // Simulates LLM output cut off mid-JSON
        let truncated = r#"{"1": {"relation": "A4", "reason": "马斯克造火箭是第一性原理的典型应用。"}, "2": {"relation": "A1", "reason": "两者都阐述了"#;
        let repaired = repair_truncated_json(truncated);
        let parsed = serde_json::from_str::<serde_json::Value>(&repaired);
        assert!(
            parsed.is_ok(),
            "Repaired JSON should be valid: {}",
            repaired
        );
    }

    #[test]
    fn test_extract_json_truncated_no_closing_brace() {
        // extract_json should repair truncated JSON via safe boundary truncation
        let input = r#"{"1": {"relation": "A3", "reason": "extends the concept"#;
        let result = extract_json(input);
        let parsed = serde_json::from_str::<serde_json::Value>(&result);
        // With repair restored, this truncated JSON should be repaired
        // (closes unclosed string + braces)
        assert!(
            parsed.is_ok(),
            "Truncated JSON should be repaired: {}",
            result
        );
    }

    #[test]
    fn test_parse_response_truncated() {
        let skill = ReasoningSkill;
        // Simulates actual truncated LLM output observed in logs
        let response = r#"```json
{"1": {"relation": "A4", "reason": "first principles example"}, "2": {"relation": "A1""#;
        let results = skill.parse_response(response).unwrap();
        // With repair restored + safe boundary truncation, the first complete entry is recovered
        assert_eq!(
            results.len(),
            1,
            "Repaired JSON should yield 1 entry (2nd incomplete entry discarded), got {}",
            results.len()
        );
        // "A4" gets normalized to "example" by normalize_relation
        assert_eq!(results[0].relation, "example");
    }

    #[test]
    fn test_parse_response_level_c_truncated() {
        let skill = ReasoningSkill;
        // Malformed JSON that repair cannot fix (unescaped quotes inside reason break structure)
        // but regex can still extract "relation": "supports"
        let response = r#"Here is my analysis: {"1": {"relation": "supports", "reason": "Note A says "first principles" which"#;
        let results = skill.parse_response(response).unwrap();
        assert!(
            !results.is_empty(),
            "Level C should rescue at least one result from broken JSON"
        );
        assert_eq!(results[0].relation, "supports");
    }
}
