# About Slash

> 状态：当前
> 受众：用户
> 负责：Slash
> 最后审阅：2026-05-31

Slash 是一个本地优先的 Markdown 知识工作台。你可以用它记录笔记、整理资料、管理任务、搜索知识库、使用 AI 辅助归档与总结，并按需要连接自托管的 Slash Server 做个人同步或团队协作。

## 本地优先

Slash 的核心内容保存在你自己的 Vault 中。

- 笔记是普通 Markdown 文件。
- 图片、视频、PDF 等资源保存在 Vault 的 `assets/` 目录。
- 即使不使用 Slash，你也可以用其他 Markdown 编辑器打开和备份这些文件。
- 本地索引、任务聚合和 AI 缓存用于提升体验，但不替代你的 Markdown 文件。

## Vault 与 PARA

Slash 使用 Vault 承载一个知识库。新 Vault 会包含一组 PARA 根目录：

- `00_Inbox`：临时收集、未整理内容。
- `01_Projects`：有明确目标和结束时间的项目。
- `02_Areas`：长期维护的责任和关注领域。
- `03_Resources`：资料、主题、兴趣和参考内容。
- `04_Archives`：已结束或暂不活跃的内容。

PARA 不是严格分类学，而是行动规则：正在推进的放 Projects，长期维护的放 Areas，作为资料保存的放 Resources，不再活跃的放 Archives。

## 编辑与组织

Slash 提供面向长时间写作和整理的桌面工作区：

- 文件树和标签页。
- Markdown 编辑器。
- WikiLink 双向链接。
- 任务列表和任务元数据。
- 图片、视频、PDF、表格、代码块、Mermaid 和画板。
- 全文搜索、任务搜索和语义搜索。

## AI 辅助

Slash AI 用来辅助整理和处理内容，不替代你的判断。

- 生成摘要和标签建议。
- 对选中文字执行 AI Skill。
- 推荐潜在关联的 GhostLink。
- 辅助 Inbox 内容归档。
- 参与语义搜索和知识发现。

AI 支持本地 Ollama 和在线 OpenAI-compatible Provider。无论生成模型使用本地还是在线，当前语义嵌入固定依赖本地 Ollama `bge-m3`。

## 同步与团队协作

Slash 可以在完全本地模式下使用。需要多设备同步或团队协作时，可以连接 Slash Server。

Slash Server 提供：

- 个人 Vault 同步。
- 团队空间。
- 团队目录权限。
- 评论、批注、版本历史和协作事件。
- 必要时的协作编辑锁。

当前协作模型不是实时多人同时编辑同一段文字，而是本地优先、异步同步、权限控制、评论批注和版本追踪。

## 适合谁

Slash 适合：

- 想保留本地 Markdown 文件控制权的用户。
- 需要长期整理项目、资料和任务的人。
- 想把 AI 用作辅助，而不是让 AI 接管知识库的人。
- 想自托管同步服务或小团队知识库的人。

## 从哪里开始

1. 创建或打开一个 Vault。
2. 先把新内容放到 `00_Inbox`。
3. 用 Markdown 或 `/` 菜单开始写作。
4. 用 WikiLink 建立笔记关系。
5. 用任务列表记录行动项。
6. 按需要配置 AI 或 Server 同步。

## 另见

- [[Slash Input Guide]]
- [[Slash AI Guide]]
- [[Slash Team Guide]]

---

# About Slash

> Status: Current
> Audience: Users
> Owner: Slash
> Last reviewed: 2026-05-31

Slash is a local-first Markdown workspace for knowledge work. You can use it to write notes, organize reference material, manage tasks, search your vault, use AI-assisted organization and summarization, and connect to a self-hosted Slash Server when you need personal sync or team collaboration.

## Local First

Your core content lives in your own Vault.

- Notes are regular Markdown files.
- Images, videos, PDFs, and other assets are stored under the Vault `assets/` directory.
- You can still open and back up your files with other Markdown tools.
- Local indexes, task aggregation, and AI caches improve the experience, but they do not replace your Markdown files.

## Vault and PARA

Slash uses a Vault as the container for a knowledge base. A new Vault starts with PARA root folders:

- `00_Inbox`: quick capture and unsorted material.
- `01_Projects`: efforts with a goal and an expected end.
- `02_Areas`: ongoing responsibilities and standards.
- `03_Resources`: reference material, topics, interests, and reusable knowledge.
- `04_Archives`: completed or inactive material.

PARA is not a strict taxonomy. It is a decision rule: active outcomes go to Projects, ongoing responsibilities go to Areas, reusable references go to Resources, and inactive material goes to Archives.

## Editing and Organization

Slash provides a desktop workspace for long-form writing and repeated organization work:

- File tree and tabs.
- Markdown editor.
- WikiLink backlinks.
- Task lists and task metadata.
- Images, videos, PDFs, tables, code blocks, Mermaid diagrams, and drawing boards.
- Full-text search, task search, and semantic search.

## AI Assistance

Slash AI assists your work. It does not replace your judgment.

- Suggest summaries and tags.
- Run AI Skills on selected text.
- Recommend potential GhostLinks.
- Help classify Inbox notes.
- Support semantic search and knowledge discovery.

AI supports local Ollama and online OpenAI-compatible providers. Regardless of whether the generation model is local or online, semantic embedding currently depends on the local Ollama `bge-m3` model.

## Sync and Team Collaboration

You can use Slash completely offline. When you need multi-device sync or team collaboration, connect Slash Desktop to Slash Server.

Slash Server provides:

- Personal Vault sync.
- Team spaces.
- Team directory permissions.
- Comments, annotations, version history, and collaboration events.
- Collaboration edit locks when needed.

The current collaboration model is not real-time co-editing of the same paragraph. It is local-first editing with asynchronous sync, permissions, comments, annotations, and version tracking.

## Who Slash Is For

Slash is a good fit if you:

- Want to keep control of local Markdown files.
- Need to organize projects, references, and tasks over time.
- Want AI as an assistant rather than the owner of your knowledge base.
- Want self-hosted sync or a small-team knowledge workspace.

## Start Here

1. Create or open a Vault.
2. Put new material into `00_Inbox` first.
3. Move stable references to `03_Resources`.
4. Use links, tags, tasks, and AI suggestions as your workflow becomes clearer.

See also:

- [[Slash Input Guide]]
- [[Slash AI Guide]]
- [[Slash Team Guide]]
