---
title: Slash的全文搜索
summary: >-
  你提供的文档详细地介绍了如何构建一个高效的搜索系统，并结合了多种技术来提升用户体验和性能。以下是对文档内容的一个总结和一些补充建议：


  ### 一、核心架构：混合检索 (The Hybrid Engine)


  #### 1. 为什么需要混合？


  - **场景 A (精准)**：用户搜 "Error 502"，向量搜索可能会推荐“网络故障排查”，但用户只想要包含 "Error 502"
  这个具体字符串的笔记。 -> **FTS5 胜。**


  - **场景 B (模糊)**：用户搜“怎么做饭”，笔记里只有“红烧肉食谱”。FTS5 搜不到，向量能搜到。 -> **BGE-m3 胜。**


  #### 2. 实现策略：RRF (Reciprocal Rank Fusion)


  Rust 后端同时发起两个查询：


  1. **Lexical Search**: SQLite FTS5 查询，按匹配度排序。


  2. **Semantic Search**: BGE-m3 Embedding 相似度查询。


  然后使用 RRF 算法将两组结果重新排序融合：


  $Score=\frac{1}{k+rank_{vector}}​​+\frac{1}{k+rank_{keyword​1}}$


  这样，既包含关键词、语义又相关的笔记会排在最前面。


  ### 二、进阶功能：智能过滤 (Natural Language Filtering)


  这是利用 Qwen 2.5 3B 的杀手锏。在进行搜索之前，先用 LLM 解析用户的“自然语言意图”，转化为 **SQL 过滤条件**。


  - **用户输入**：“上周关于 Rust 的待办事项”


  - **Qwen 3B 解析 (Text-to-SQL/Filter)**：

    JSON

    ```
    {
      "keywords": "Rust",
      "date_range": "last_7_days",
      "has_todo": true,
      "folder": null
    }
    
    ```

  - **Rust 执行逻辑**：

    1. 先执行 SQL `WHERE date >= ... AND has_todo = true`。

    2. 在过滤后的结果集中，再进行关键词或向量搜索。

  - **价值**：极大提升搜索速度（减少了向量计算范围）和准确度（排除了不相关的旧笔记）。


  ### 三、呈现层：从“搜索列表”到“生成式回答” (Project RAG)


  既然你有 Qwen 3B，别只给用户一个笔记列表。用户往往不是为了看笔记，而是为了找其中的信息。


  #### 1. 智能摘要 (Search Summary)


  在搜索结果列表的顶部，展示一个由 AI 生成的**综合答案**。


  - **流程**：

    1. 混合检索出 Top 5 笔记片段。

    2. **Prompt**: “基于以下 5 个笔记片段，回答用户的问题：‘{user_query}’。如果不相关，则忽略。”

    3. **UI**: 类似于 Google 的 AI Overview，直接给出答案，并标注引用来源（\[笔记A\], \[笔记B\]）。

  #### 2. 块级引用 (Chunk-Level Citation)


  BGE-m3 支持长文本，但为了 RAG 效果，建议**入库时进行切片（Chunking）**。


  - **策略**：按 `## 标题` 进行切分。


  - **搜索结果**：不要返回整篇长笔记，而是直接定位到笔记中的**某一段落**。


  - **UI**：点击结果，直接跳转到笔记的该行，并高亮显示。


  ### 四、针对 Slash 的特色建议


  结合之前讨论的 **Tasks 数据库** 和 **PARA 结构**：


  #### 1. "Action First" 搜索模式


  如果用户的搜索词包含动词（如“安装”、“购买”、“联系”），或者 Qwen 判定意图是寻找任务：


  - **权重调整**：大幅提升 `01_Projects` 和 `02_Areas` 中包含 `[ ]` 待办事项的笔记权重。


  - **UI 变化**：直接把搜索结果里的 Task 单独提取出来，展示为一个临时的 Checklist。

    - *搜 "NAS 部署"* -> 结果顶端显示：

      - \[ \] 购买树莓派电源 (来自《硬件清单》)

      - \[ \] 刷写 SD 卡 (来自《系统安装》)

  #### 2. "Serendipity"（意外发现）推荐


  利用 BGE-m3 的多语言和跨语义能力，在搜索结果底部增加\*\*“猜你想看”\*\*。


  - **逻辑**：不是基于搜索词，而是基于搜索结果 Top 1 的笔记，去寻找**跨文件夹**的关联笔记。


  - **场景**：用户搜“Python 爬虫”，底部推荐了 `03_Resources/正则表达式`（虽然没有 Python 字样，但在语义上高度相关）。


  ### 五、技术落地的“坑”与填坑指南


  #### 1. 索引颗粒度 (Granularity)


  - **坑**：把整篇笔记作为一个向量。如果笔记很长，包含了 Python、做饭、旅游，向量会非常模糊（中心化），搜什么都搜不准。


  - **建议**：**Parent-Child Indexing（父子索引）**。

    - **Child**: 把笔记按段落或 H2 标题切分，计算 Embedding。搜索时搜这些 Child。

    - **Parent**: 搜索命中 Child 后，返回它所属的整篇 Note 给用户。

    - *BGE-m3 支持 8192 context，但切分依然有助于提升 RAG 的精准度。*

  #### 2. 本地性能优化


  - **坑**：每次搜索都调用 Qwen 3B 做意图解析会慢（增加 1-2秒 延迟）。


  - **建议**：**推测性执行 (Speculative Execution)**。

    1. 用户按下回车瞬间，**立即**发起 FTS5 + BGE-m3 搜索（这个很快）。

    2. **同时**异步调用 Qwen 3B 做意图解析。

    3. 先展示基础结果。

    4. 等 Qwen 解析完了（比如发现用户其实是想搜“上周的”），再动态刷新/过滤结果，或者在顶部弹出“为你过滤了上周的结果”。

  ### 总结建议的搜索形态


  **Slash 的搜索框不应该只是一个放大镜，而应该是一个对话框。**


  1. **输入**：支持自然语言（“找一下上周关于 NAS 的笔记”）。


  2. **处理**：Qwen 3B 提取元数据（时间、Tag） + BGE-m3 检索语义 + SQLite 检索关键词。


  3. **输出**：

     - **顶部**：AI 总结的直接答案。

     - **中部**：提取出的相关 Action Items (Checklist)。

     - **下部**：高亮命中段落的笔记列表。

  这才是真正的“第二大脑”搜索——**它是你的外脑突触，而不仅仅是硬盘索引。**


  ### 建议补充


  1. **多语言支持**：
     -wen 3B 的多语言能力可以进一步提升用户体验，特别是在跨语言查询和翻译方面。
     
  2. **个性化推荐**：
     利用用户的搜索历史、偏好等信息进行个性化推荐，提高搜索的针对性和效率。

  3. **实时更新与缓存机制**：
     实时更新数据库中的笔记内容，并结合缓存技术减少对后端服务的压力，提升响应速度。
     
  4. **多设备同步**：
     支持跨平台（如手机、平板等）的数据同步，确保用户在不同设备上都能获得一致的搜索体验。

  5. **隐私保护与安全措施**：
     确保用户的搜索数据和笔记内容得到妥善保管，并采取必要的加密和访问控制措施以保障用户隐私。

  通过这些补充建议和技术落地指南，可以进一步完善 Slash 的搜索系统，使其更加智能化、个性化和高效。
---
### 用户希望在Slash搜索到什么

如果要搜一个完全不知道答案的事物，没有人会使用笔记的搜索。因此当用户在一个笔记软件中搜索时，他是在检索自己的“记忆”

## 核心原则

1. 只在笔记库内找答案，严禁 AI 使用外部世界知识回答事实性问题！
2. 用户可以 100% 相信 Slash 给出答案一定是自己记录过的。

基于 **BGE-m3 (强检索)** + **Qwen2.5 3B (快推理)** + **Rust/SQLite (高性能本地架构)** 的技术栈，采用 **“混合检索 (Hybrid Search) + RAG 问答”** 的分层架构来设计搜索功能。

---

### ⚡️ Phase 1: 极速查找 (Vector Expansion + Hybrid Search)

单纯的向量搜索有时候会“太发散”，单纯的关键词搜索又“太死板”。 Slash 应该采用 **混合检索 (Hybrid Search)**。

#### 1. 向量膨胀 (Vector Expansion / HyDE)

使用**HyDE (Hypothetical Document Embeddings)技术**。

- **原理：** 用户的问题往往很短（如“Rust 内存”），而笔记很长。这两者的向量空间不对齐。

- **做法：**

  1. **用户输入：** “Rust 怎么管理内存？”

  2. **LLM 脑补 (Expansion)：** 让 Qwen 快速写一段 **“假想的答案”**（比如：“Rust 使用所有权机制和借用检查器来管理内存...”）。

  3. **向量化：** 把这段 **“假想答案”** 转成向量。

  4. **匹配：** 用这个向量去库里搜。

- **效果：** 极其精准，因为它是在用“答案搜答案”，而不是“问题搜答案”。

#### 2. 混合排序 (Hybrid Ranking)

- **关键词 (Keyword):** 使用 SQLite 的 `FTS5` 模块，匹配精准词汇。

- **语义 (Semantic):** 使用 BGE-M3 计算 Cosine Similarity。

- **结果：** 取两者的并集，按加权分排序。

### 🤖 Phase 2: 深度问答 (Strict RAG)

在这个环节**严格限定只搜索笔记仓库中有的内容**，绝不使用LLM自己的知识去回答用户的问题

#### 🛡️ 核心 Prompt 设计 (The Iron Shield)

我们需要在 System Prompt 里给 AI 戴上“镣铐”。

```rust
// src-tauri/src/core/ai/skills/qa.rs

    fn system_prompt(&self) -> String {
        r#"You are Slash, a strict knowledge base assistant.
Your goal is to answer the user's question **using ONLY the provided Context**.

### 🚫 CRITICAL RULES (Strict Adherence Required):
1. **NO External Knowledge:** Do NOT use your own training data. If the answer is not in the Context, say "知识库中未找到相关内容".
2. **Citation:** When you state a fact, reference the source note title (e.g., "根据 [[Rust基础]]...").
3. **Honesty:** Do not make up facts. Do not hallucinate links.
4. **Language:** Answer in the SAME language as the user's question.

### Context (From User's Vault):
{{context_snippets}}
"#.to_string()
    }
```

### 🛠️ 落地执行方案

#### 1. 数据库准备：启用 FTS5

为了支持关键词快搜，我们需要在 `init_db` 时创建虚拟表。

```sql
-- schema.sql 追加
-- 全文检索虚拟表
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    path UNINDEXED, 
    title, 
    content, -- 注意：我们之前只存了 path，做搜索可能需要把纯文本内容（去除 markdown 符号）存一份冗余，或者运行时读取
    tokenize = 'trigram' -- 更好的中文支持
);
```

*(注：如果不想存 content 进数据库，快搜只能搜 title + tags + summary，这也是一种轻量级策略。)*

#### 2. Rust 实现：混合检索器 (`search.rs`)

Rust

```rust
pub async fn search(query: String) -> Vec<SearchResult> {
    // 1. 并行执行：FTS 搜索 + 向量搜索
    let keyword_results = db.fts_search(&query);
    
    // 1.1 向量膨胀 (HyDE) - 可选，视性能而定
    let hypothetical_answer = ai.generate("Write a short passage answering: " + query);
    let query_vec = ai.embed(hypothetical_answer);
    let vector_results = db.vector_search(query_vec);

    // 2. RRF (Reciprocal Rank Fusion) 合并结果
    let merged = merge_results(keyword_results, vector_results);
    
    // 3. 返回 Top 10 给前端展示
    return merged.take(10);
}
```

#### 3. 交互流程 (UI)

1. **用户按** `Cmd+K` **：** 弹出搜索框。

2. **输入问题：** “Rust 所有权”。

3. **瞬时反馈 (Fast)：** 下方列出 n 篇相关笔记（基于混合检索）。

   - *用户可以直接点笔记跳转。*

4. **深度追问 (Slow)：** 列表顶部有一个 **“✨ Ask AI”** 选项。

   - 用户回车选中它。

   - **后端：** 取 Top 5 笔记的摘要/全文，塞进 Prompt，调用 Qwen。

   - **输出：** 打字机效果显示：“根据您的笔记《Rust基础》和《内存管理》，所有权的核心规则是...”

### 搜索功能实现

#### 发起

`Cmd + / `**弹出搜索框：用户输入查询内容**

#### 预处理

##### 1. 关键词膨胀

利用 **BGE-m3** 的能力。用户搜“电脑”，BGE-m3 生成的向量，天然就能匹配到笔记里的“计算机”向量。

**工程实现步骤**

我们需要在两个阶段进行处理：**入库（Indexing）** 和 **检索（Retrieval）**。

第一步：入库时 (Indexing) —— 埋下“锚点”

当用户保存一篇笔记时，我们要算出这篇笔记的向量，存入数据库。

第二步：搜索时 (Retrieval) —— 模糊匹配

当用户输入“电脑”时，我们不需要做文字替换，直接做向量计算。

##### 2. 术语/缩写对齐

1. **参数提取**：k8s

#### 检索

1. **混合检索：**

#### 答案生成

1. **片段提取：**

#### 展现

1. **文字页面：**
2. **图谱页面：**

**Phase 1: 预处理 (Pre-Search - Qwen 3B)**

- **任务**: 意图识别 & 查询膨胀。

**Phase 2: 混合检索 (Hybrid Retrieval - Rust)**

- **Lexical**: SQLite FTS5 搜索 `entity` 和 `keywords`。 (锚定实体)

- **Semantic**: BGE-m3 搜索 `semantic_expansion` 向量。 (模糊对齐)

- **Rerank**: 使用 RRF 算法融合两者排名。

**Phase 3: 答案定位 (Answer Locator - Qwen 3B)**

- **任务**: 从 Top 3 笔记中**摘录**答案。

**Qwen 3B 的工作：**

1. **关键词膨胀（Query Expansion）** 在用户按下回车的 100ms 内，Qwen 悄悄把用户的搜索词“翻译”成更丰富的关键词组合，喂给 FTS5。

- **场景 A：跨语言精准匹配**

  - **用户搜**：“树莓派 显存设置”

  - **Qwen 3B 处理**：`User Query: "树莓派 显存设置" -> Expand to: "Raspberry Pi GPU Memory split vram"`

  - **结果**：FTS5 成功命中了笔记里的一行代码 `gpu_mem=256`。如果没有这一步，搜中文是搜不到这行代码的。

- **场景 B：术语/缩写对齐**

  - **用户搜**：“K8s 部署”

  - **Qwen 3B 处理**：`Expand to: "Kubernetes k8s deploy installation"`

  - **结果**：同时召回了写着 `Kubernetes` 和写着 `k8s` 的两篇笔记。

**定义**：Qwen 在这里不做生成，只做**同义词/翻译词的映射**。这是 3B 模型最擅长的“词联想”。

### 2. 结构化意图提取（Natural Language to Filters）

**——把“自然语言”变成“数据库查询语句”。**

这是 3B 模型的**高光时刻**。用户懒得去点筛选器，他们习惯说话。 3B 模型虽然写长文不行，但提取 `Key-Value` 对（Slot Filling）极其精准。

**Qwen 3B 的工作：** **参数提取器（Param Extractor）**

- **场景**：用户搜 **“上个月关于 Rust 的未完成待办”**

- **Qwen 3B 输出**：

```json
{
  "keywords": "Rust",
  "time_range": "2023-12-01_to_2023-12-31", // 自动计算相对时间
  "has_todo": true,
  "todo_status": "unchecked"
}
```

- **Rust 后端**： 拿到 JSON -&gt; 生成 SQL：`SELECT * FROM notes WHERE content MATCH 'Rust' AND date BETWEEN ... AND has_task=1`。
- **价值**：这一步直接把搜索范围缩小了 90%，既快又准。用户会觉得“它听懂了我的复杂指令”。

### 3. 片段级“针眼”提取（Fine-grained Fact Extraction）

**——解决“笔记太长，不想通读”的问题。**

注意，这里不是让 AI “总结全文”（那是生成），而是让 AI **“高亮答案”**（这是提取）。 在 RAG（检索增强生成）中，3B 模型最适合做 **Extractive QA**。

**Qwen 3B 的工作：** **阅读理解与定位**

- **场景**：用户搜 **“我的那台服务器 IP 是多少？”**

- **检索结果**：命中了一篇 5000 字的《服务器运维手册》。

- **Qwen 3B 任务**：

  - Input: 用户问题 + 命中笔记的 Top 3 段落。

  - Prompt: `请从参考文本中提取出符合问题的具体值。只输出值，不要废话。`

- **输出**：`192.168.1.105`

- **UI 呈现**：

  - 搜索列表第一条直接显示：

    > **🎯 最佳匹配：192.168.1.105** *来源：\[服务器运维手册\] 第 32 行*

**定义**：不是重写，而是**摘录**。3B 模型做这个非常稳，因为它只需要在原文里找，找不到就闭嘴，不会产生幻觉。

数据结构

性能

UI展示

### 一、 核心架构：混合检索 (The Hybrid Engine)

**BGE-m3 的优势在于语义，SQLite FTS5 的优势在于精准匹配。两者必须结合。**

#### 1. 为什么需要混合？

- **场景 A (精准)**：用户搜 "Error 502"，向量搜索可能会给你推荐“网络故障排查”，但用户只想要包含 "Error 502" 这个具体字符串的笔记。 -&gt; **FTS5 胜。**

- **场景 B (模糊)**：用户搜“怎么做饭”，笔记里只有“红烧肉食谱”。FTS5 搜不到，向量能搜到。 -&gt; **BGE-m3 胜。**

#### 2. 实现策略：RRF (Reciprocal Rank Fusion)

Rust 后端同时发起两个查询：

1. **Lexical Search**: SQLite FTS5 查询，按匹配度排序。

2. **Semantic Search**: BGE-m3 Embedding 相似度查询。

然后使用 **RRF 算法** 将两组结果重新排序融合：

$Score=\frac{1}{k+rank_{vector}}​​+\frac{1}{k+rank_{keyword​1}}$

这样，既包含关键词、语义又相关的笔记会排在最前面。

---

### 二、 进阶功能：智能过滤 (Natural Language Filtering)

这是利用 **Qwen 2.5 3B** 的杀手锏。在进行搜索之前，先用 LLM 解析用户的“自然语言意图”，转化为 **SQL 过滤条件**。

- **用户输入**：“上周关于 Rust 的待办事项”

- **Qwen 3B 解析 (Text-to-SQL/Filter)**：

  JSON

  ```
  {
    "keywords": "Rust",
    "date_range": "last_7_days",
    "has_todo": true,
    "folder": null
  }
  
  ```

- **Rust 执行逻辑**：

  1. 先执行 SQL `WHERE date >= ... AND has_todo = true`。

  2. 在过滤后的结果集中，再进行关键词或向量搜索。

- **价值**：极大提升搜索速度（减少了向量计算范围）和准确度（排除了不相关的旧笔记）。

---

### 三、 呈现层：从“搜索列表”到“生成式回答” (Project RAG)

既然你有 Qwen 3B，别只给用户一个笔记列表。用户往往不是为了看笔记，而是为了找其中的**信息**。

#### 1. 智能摘要 (Search Summary)

在搜索结果列表的顶部，展示一个由 AI 生成的**综合答案**。

- **流程**：

  1. 混合检索出 Top 5 笔记片段。

  2. **Prompt**: “基于以下 5 个笔记片段，回答用户的问题：‘{user_query}’。如果不相关，则忽略。”

  3. **UI**: 类似于 Google 的 AI Overview，直接给出答案，并标注引用来源（\[笔记A\], \[笔记B\]）。

#### 2. 块级引用 (Chunk-Level Citation)

BGE-m3 支持长文本，但为了 RAG 效果，建议**入库时进行切片（Chunking）**。

- **策略**：按 `## 标题` 进行切分。

- **搜素结果**：不要返回整篇长笔记，而是直接定位到笔记中的**某一段落**。

- **UI**：点击结果，直接跳转到笔记的该行，并高亮显示。

---

### 四、 针对 Slash 的特色建议

结合之前讨论的 **Tasks 数据库** 和 **PARA** 结构：

#### 1. "Action First" 搜索模式

如果用户的搜索词包含动词（如“安装”、“购买”、“联系”），或者 Qwen 判定意图是寻找任务：

- **权重调整**：大幅提升 `01_Projects` 和 `02_Areas` 中包含 `[ ]` 待办事项的笔记权重。

- **UI 变化**：直接把搜索结果里的 Task 单独提取出来，展示为一个临时的 Checklist。

  - *搜 "NAS 部署"* -&gt; 结果顶端显示：

    - \[ \] 购买树莓派电源 (来自《硬件清单》)

    - \[ \] 刷写 SD 卡 (来自《系统安装》)

#### 2. "Serendipity"（意外发现）推荐

利用 BGE-m3 的多语言和跨语义能力，在搜索结果底部增加\*\*“猜你想看”\*\*。

- **逻辑**：不是基于搜索词，而是基于搜索结果 Top 1 的笔记，去寻找**跨文件夹**的关联笔记。

- **场景**：用户搜“Python 爬虫”，底部推荐了 `03_Resources/正则表达式`（虽然没有 Python 字样，但在语义上高度相关）。

---

### 五、 技术落地的“坑”与填坑指南

#### 1. 索引颗粒度 (Granularity)

- **坑**：把整篇笔记作为一个向量。如果笔记很长，包含了 Python、做饭、旅游，向量会非常模糊（中心化），搜什么都搜不准。

- **建议**：**Parent-Child Indexing（父子索引）**。

  - **Child**: 把笔记按段落或 H2 标题切分，计算 Embedding。搜索时搜这些 Child。

  - **Parent**: 搜索命中 Child 后，返回它所属的整篇 Note 给用户。

  - *BGE-m3 支持 8192 context，但切分依然有助于提升 RAG 的精准度。*

#### 2. 本地性能优化

- **坑**：每次搜索都调用 Qwen 3B 做意图解析会慢（增加 1-2秒 延迟）。

- **建议**：**推测性执行 (Speculative Execution)**。

  1. 用户按下回车瞬间，**立即**发起 FTS5 + BGE-m3 搜索（这个很快）。

  2. **同时**异步调用 Qwen 3B 做意图解析。

  3. 先展示基础结果。

  4. 等 Qwen 解析完了（比如发现用户其实是想搜“上周的”），再动态刷新/过滤结果，或者在顶部弹出“为你过滤了上周的结果”。

### 总结建议的搜索形态

**Slash 的搜索框不应该只是一个放大镜，而应该是一个对话框。**

1. **输入**：支持自然语言（“找一下上周关于 NAS 的笔记”）。

2. **处理**：Qwen 3B 提取元数据（时间、Tag） + BGE-m3 检索语义 + SQLite 检索关键词。

3. **输出**：

   - **顶部**：AI 总结的直接答案。

   - **中部**：提取出的相关 Action Items (Checklist)。

   - **下部**：高亮命中段落的笔记列表。

这才是真正的“第二大脑”搜索——**它是你的外脑突触，而不仅仅是硬盘索引。**
