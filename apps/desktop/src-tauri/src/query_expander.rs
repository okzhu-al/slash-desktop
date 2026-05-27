use std::collections::HashMap;

use crate::core::ai::service::AIService;

// ---------------------------------------------------------
// Type Definitions
// ---------------------------------------------------------

/// 模拟从 JSON 加载的字典
pub type AliasMap = HashMap<String, Vec<String>>;

/// HyDE 生成结果
#[derive(Debug, Clone)]
pub struct HyDeResult {
    /// 生成的假设文档
    pub hypothetical_document: String,
    /// 从假设文档生成的 embedding
    pub embedding: Option<Vec<f32>>,
}

// ---------------------------------------------------------
// 核心功能实现
// ---------------------------------------------------------

/// 核心函数：输入原始查询，输出 FTS5 友好的查询字符串
pub fn expand_query(raw_query: &str, aliases: &AliasMap) -> String {
    // 1. 按空格分词 (生产环境建议用 unicode-segmentation 处理中文分词)
    let tokens: Vec<&str> = raw_query.split_whitespace().collect();
    let mut new_parts = Vec::new();

    for token in tokens {
        // 转小写，用于查字典（忽略大小写）
        let key = token.to_lowercase();

        if let Some(synonyms) = aliases.get(&key) {
            // 命中字典！
            // 构造格式: (原词 OR 同义词1 OR 同义词2)
            // 这种格式 SQLite FTS5 能完美识别
            let mut group = vec![token.to_string()]; // 保留原词(保持原大小写)
            group.extend(synonyms.clone());

            // 组合成字符串: "(k8s OR kubernetes OR kube)"
            let combined = format!("({})", group.join(" OR "));
            new_parts.push(combined);
        } else {
            // 未命中，保留原词
            new_parts.push(token.to_string());
        }
    }

    // 重新组合成字符串
    new_parts.join(" ")
}

// ---------------------------------------------------------
// HyDE (Hypothetical Document Embedding) 实现
// ---------------------------------------------------------

/// HyDE System Prompt - 生成假设文档
const HYDE_SYSTEM_PROMPT: &str = r#"你是一个帮助用户搜索笔记的助手。
用户会提供一个搜索查询，你需要想象并生成一个可能匹配这个查询的笔记内容片段。

规则：
1. 生成 100-200 字的中文段落
2. 内容应该像是从真实笔记中摘录的
3. 包含与查询相关的关键概念和术语
4. 不要解释你在做什么，直接输出假设的笔记内容
5. 使用 Markdown 格式（可包含标题、列表、代码块等）"#;

/// 使用 LLM 生成 HyDE 假设文档 (Provider-agnostic)
pub async fn generate_hyde_document(query: &str, service: &AIService) -> Result<String, String> {
    let prompt = format!(
        "{}\n\n用户搜索: {}\n\n请生成一个可能包含上述搜索内容的笔记片段：",
        HYDE_SYSTEM_PROMPT, query
    );

    log::error!("🔮 [HyDE] Generating hypothetical document for: {}", query);

    let doc = service.complete_raw(&prompt, 0.7).await?;

    log::error!(
        "🔮 [HyDE] Generated document ({} chars): {}...",
        doc.len(),
        doc.chars().take(100).collect::<String>()
    );

    Ok(doc)
}

/// 完整的 HyDE 流程：生成假设文档 + 获取 embedding (Provider-agnostic)
pub async fn hyde_expand(query: &str, service: &AIService) -> Result<HyDeResult, String> {
    // Step 1: 生成假设文档 (via CompletionProvider)
    let hypothetical_document = generate_hyde_document(query, service).await?;

    // Step 2: 为假设文档生成 embedding (via EmbeddingProvider)
    log::error!("🔮 [HyDE] Generating embedding for hypothetical document...");

    let embedding = match service.generate_embedding(&hypothetical_document).await {
        Ok(emb) => Some(emb),
        Err(e) => {
            log::error!("⚠️ [HyDE] Embedding generation failed: {}", e);
            None
        }
    };

    log::error!(
        "🔮 [HyDE] Generated embedding with {} dimensions",
        embedding.as_ref().map(|e| e.len()).unwrap_or(0)
    );

    Ok(HyDeResult {
        hypothetical_document,
        embedding,
    })
}

// ---------------------------------------------------------
// 测试部分
// ---------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    // 辅助函数：构造测试用的字典
    fn setup_aliases() -> AliasMap {
        let mut m = HashMap::new();
        m.insert(
            "k8s".to_string(),
            vec!["kubernetes".to_string(), "kube".to_string()],
        );
        m.insert(
            "nas".to_string(),
            vec!["synology".to_string(), "qnap".to_string()],
        );
        m.insert("js".to_string(), vec!["javascript".to_string()]);
        m
    }

    #[test]
    fn test_basic_expansion() {
        let aliases = setup_aliases();
        let input = "k8s 部署";
        let output = expand_query(input, &aliases);

        // 断言：验证输出是否符合预期
        assert_eq!(output, "(k8s OR kubernetes OR kube) 部署");
    }

    #[test]
    fn test_case_insensitive() {
        let aliases = setup_aliases();
        // 用户输入大写 NAS，字典里是小写 nas，应该也能匹配
        let input = "NAS 选购指南";
        let output = expand_query(input, &aliases);

        // 注意：原词 "NAS" 被保留了，这是对的
        assert_eq!(output, "(NAS OR synology OR qnap) 选购指南");
    }

    #[test]
    fn test_no_match() {
        let aliases = setup_aliases();
        let input = "Rust 语言";
        let output = expand_query(input, &aliases);

        // 没有匹配项，应该原样返回
        assert_eq!(output, "Rust 语言");
    }

    #[test]
    fn test_mixed_query() {
        let aliases = setup_aliases();
        let input = "用 js 写 k8s 脚本";
        let output = expand_query(input, &aliases);

        assert_eq!(
            output,
            "用 (js OR javascript) 写 (k8s OR kubernetes OR kube) 脚本"
        );
    }
}
