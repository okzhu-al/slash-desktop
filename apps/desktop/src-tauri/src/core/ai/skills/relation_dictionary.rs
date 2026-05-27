//! Relation Dictionary Module
//!
//! Unified relation taxonomy for normalizing LLM relation classifications.
//! Architecture aligned with `domain_dictionary.rs`.
//! 4 categories, 18 relation types with code/Chinese/English aliases.

// ============================================================================
// Relation Taxonomy
// ============================================================================

/// Relation taxonomy entry: (slug, category, aliases)
///
/// Aliases include: relation code (A1~D4), Chinese names, and English variants.
pub const RELATION_TAXONOMY: &[(&str, &str, &[&str])] = &[
    // A. Cognitive (How ideas connect)
    ("supports", "Cognitive", &["A1", "支持"]),
    ("contradicts", "Cognitive", &["A2", "反驳"]),
    ("extends", "Cognitive", &["A3", "扩展"]),
    ("example", "Cognitive", &["A4", "案例"]),
    ("precedes", "Cognitive", &["A5", "前置"]),
    ("partOf", "Cognitive", &["A6", "组成"]),
    ("analogy", "Cognitive", &["A7", "类比"]),
    // B. Practical (How things get done)
    ("implements", "Practical", &["B1", "实现"]),
    ("applies", "Practical", &["B2", "应用", "应用于"]),
    ("alternative", "Practical", &["B3", "替代"]),
    ("evolves", "Practical", &["B4", "演化"]),
    // C. Entity (Who/What/Where)
    ("creates", "Entity", &["C1", "创建", "作者"]),
    ("belongsTo", "Entity", &["C2", "属于", "亲属"]),
    ("locatedIn", "Entity", &["C3", "位于"]),
    ("uses", "Entity", &["C4", "使用"]),
    // D. Social (How people connect)
    ("collaborates", "Social", &["D1", "合作"]),
    ("mentors", "Social", &["D2", "师承", "师生"]),
    ("influences", "Social", &["D3", "影响", "启发自"]),
    ("opposes", "Social", &["D4", "对立", "敌对"]),
];

/// Fallback slug for unrecognized relations
pub const FALLBACK_SLUG: &str = "related";

// ============================================================================
// Normalization
// ============================================================================

/// Normalize any relation string to its canonical slug.
///
/// Accepts:
/// - Relation codes: "A3" → "extends"
/// - Chinese names: "支持" → "supports"
/// - English slugs: "supports" → "supports" (passthrough)
/// - Unknown: → "related"
pub fn normalize_relation(raw: &str) -> String {
    let trimmed = raw.trim();
    let lower = trimmed.to_lowercase();

    // 1. Try matching as alias (code or Chinese name)
    for (slug, _, aliases) in RELATION_TAXONOMY {
        for alias in *aliases {
            if lower == alias.to_lowercase() || trimmed == *alias {
                return slug.to_string();
            }
        }
    }

    // 2. Try matching as existing slug (case-insensitive)
    for (slug, _, _) in RELATION_TAXONOMY {
        if lower == slug.to_lowercase() {
            return slug.to_string();
        }
    }

    // 3. Fallback
    FALLBACK_SLUG.to_string()
}

/// Get taxonomy prompt text for LLM injection
pub fn get_taxonomy_prompt() -> String {
    let mut categories: Vec<(&str, Vec<String>)> = Vec::new();

    for (slug, category, aliases) in RELATION_TAXONOMY {
        let code = aliases.first().unwrap_or(&"");
        let entry = format!("{}.{}", code, slug);

        if let Some(cat) = categories.iter_mut().find(|(c, _)| c == category) {
            cat.1.push(entry);
        } else {
            categories.push((category, vec![entry]));
        }
    }

    categories
        .iter()
        .map(|(cat, entries)| format!("{}: {}", cat, entries.join(" ")))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Get all canonical slugs
pub fn get_all_slugs() -> Vec<&'static str> {
    RELATION_TAXONOMY.iter().map(|(slug, _, _)| *slug).collect()
}

/// Get all categories
pub fn get_categories() -> Vec<&'static str> {
    let mut cats = Vec::new();
    for (_, category, _) in RELATION_TAXONOMY {
        if !cats.contains(category) {
            cats.push(*category);
        }
    }
    cats
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_code() {
        assert_eq!(normalize_relation("A1"), "supports");
        assert_eq!(normalize_relation("a3"), "extends");
        assert_eq!(normalize_relation("B4"), "evolves");
        assert_eq!(normalize_relation("D2"), "mentors");
    }

    #[test]
    fn test_normalize_chinese() {
        assert_eq!(normalize_relation("支持"), "supports");
        assert_eq!(normalize_relation("类比"), "analogy");
        assert_eq!(normalize_relation("敌对"), "opposes");
        assert_eq!(normalize_relation("应用于"), "applies");
        assert_eq!(normalize_relation("师承"), "mentors");
        assert_eq!(normalize_relation("启发自"), "influences");
    }

    #[test]
    fn test_normalize_slug_passthrough() {
        assert_eq!(normalize_relation("supports"), "supports");
        assert_eq!(normalize_relation("partOf"), "partOf");
        assert_eq!(normalize_relation("belongsTo"), "belongsTo");
    }

    #[test]
    fn test_normalize_fallback() {
        assert_eq!(normalize_relation("random_text"), "related");
        assert_eq!(normalize_relation("未知"), "related");
        assert_eq!(normalize_relation("ZZ"), "related");
    }

    #[test]
    fn test_get_all_slugs() {
        let slugs = get_all_slugs();
        assert_eq!(slugs.len(), 19);
        assert!(slugs.contains(&"supports"));
        assert!(slugs.contains(&"opposes"));
    }

    #[test]
    fn test_get_categories() {
        let cats = get_categories();
        assert_eq!(cats, vec!["Cognitive", "Practical", "Entity", "Social"]);
    }

    #[test]
    fn test_taxonomy_prompt_format() {
        let prompt = get_taxonomy_prompt();
        assert!(prompt.contains("Cognitive:"));
        assert!(prompt.contains("A1.supports"));
        assert!(prompt.contains("D4.opposes"));
    }
}
