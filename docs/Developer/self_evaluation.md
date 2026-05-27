# OPT-04 Asset Closure 自评估报告

## 一、总体判定：⚠️ 及格但有显著缺陷

本轮实現完成了架构方案中 Step 2~5 的框架骨架，`cargo check` 通过。但经复审发现存在 **5 个实质性缺陷** 和 **3 个工程规范问题**，部分属于"功能性遗漏"，需要修复后才能进入验收。

---

## 二、逐项评分

### ✅ 做对的事情

| 区域 | 评价 |
|---|---|
| `extract_asset_refs` (helpers.rs) | 使用 `OnceLock` 替代 `lazy_static`，现代惯用写法，正则准确匹配 SHA256 + 扩展名，去重逻辑正确，`kind` 分类合理 |
| `clipboardHandlers.ts` 限流 | Paste/Drop 双阻断，逻辑完备，`useSessionStore` 实时判断空间类型，Toast + i18n 用户反馈到位 |
| `push.rs` 资产落库时机 | 放在 `storage.put` 成功之后执行，符合"先兑现、后落账"的严进准则 |
| `negotiate.rs` 思路 | JOIN `file_assets` 的方向正确，通过 `path_filter` 反查合法笔记再按 `asset_id` 扩展文件列表 |
| 编译验证 | `cargo check --workspace` 通过，无 error（1 warning 是 promote.rs 中无关的 unused import，非本次引入） |

### ❌ 实质性缺陷

#### 缺陷 1：`negotiate.rs` 中 `asset_id` 与 `content_hash` 的语义混淆（🔴 严重）

```rust
// 当前代码 (negotiate.rs:157-158)
let is_allowed_asset = (f.relative_path.starts_with(".slash/assets/") || ...)
    && allowed_asset_hashes.contains(&f.content_hash);
```

**问题**：`allowed_asset_hashes` 中存的是 `file_assets.asset_id`，而 `f.content_hash` 是 `file_states.content_hash`。按架构文档定义 `asset_id` 在现阶段确实等于 `content_hash`，但 **这里隐含了一个未声明的不变量假设**。如果未来 `asset_id` 脱钩（如引入版本化 Blob），此处将静默失效。

**应修复**：要么在代码中添加显式注释标明此等价假设，要么改用 `asset_path` 匹配 `relative_path` 做直接连接（更鲁棒）。

---

#### 缺陷 2：`process_client_deletions` 中缺失 `file_assets` 解绑（🔴 严重）

架构文档 §3 的安全垃圾回收明确要求：
> "当某 Note 遭遇 Delete 或进入软删后，移除 `file_assets` 表里与其对应的 `note → asset` 绑定记录"

**但我在 `negotiate.rs` 的 `process_client_deletions` 函数中完全没有添加 `DELETE FROM file_assets WHERE note_path = $1` 的解绑语句**。这是一个严重遗漏 — 删除笔记后其资产绑定会变成孤儿记录，永远不会被 GC 清理。

---

#### 缺陷 3：`push.rs` 中 `push_file_id` 可能为 `None` 导致零值 UUID（🟡 中等）

```rust
.bind(push_file_id.unwrap_or_default())  // → UUID::default() = 00000000-...
```

当笔记没有 `slash_id` frontmatter 时，`push_file_id` 为 `None`，此时 `unwrap_or_default()` 会生成全零 UUID。而 `file_assets` 的主键是 `(vault_id, file_id, asset_id)`，全零 UUID 会导致：
- 不同无 ID 笔记的资产记录互相冲突（`ON CONFLICT DO NOTHING` 静默丢失）
- 逻辑解绑时 `DELETE FROM file_assets WHERE vault_id = $1 AND note_path = $2` 用的是 `note_path` 而非 `file_id`，倒是能部分规避，但数据不一致
  
**应修复**：当 `push_file_id` 为 `None` 时，跳过 `file_assets` 写入并打印 warn 日志。

---

#### 缺陷 4：`VideoComponent.tsx` 降级逻辑语义错误（🟡 中等）

```tsx
{failed && isTeamSpace ? ( <警告占位符> ) : isSupported ? ( ... ) : ( ... )}
```

**问题**：`failed` 触发条件是 "连续 3 次视频加载失败"。但这与"文件超过 50MB 团队上限"是两个完全不同的故障原因。视频加载可能因网络抖动、格式不支持、路径错误等任何原因失败。当前实现将所有加载失败一律归因为"团队大小限制"，这是**因果关系错误**，会误导用户。

**正确做法**：应通过独立的 props 或 context 传入"此资产已被闭包剥离"的确定性标志，而不是靠"加载失败+碰巧在团队空间"来推断。

此外，降级文案硬编码了中文字符串（`"当前视频文件超出团队空间大小限制"`），没有使用已经定义好的 i18n 键值 `media.team_size_limit_fallback`，违反了国际化原则。

---

#### 缺陷 5：`extract_asset_refs` 缺少 50MB 闭包剥离过滤（🟡 中等）

架构文档 §5 第二道保险明确要求：
> "客户端在组装 `FileManifest.assets` 的图谱清单解析阶段，判定当前是推往 `SpaceType::Team` 服务器，主动过滤掉体积 >50MB 的条目。"

但 `extract_asset_refs` 是纯正则提取，不知道当前空间类型，也不检查文件大小。调用方 `manifest_to_payload` 和 `collect_*_files_for_push` 同样没有做过滤。这意味着 **如果用户通过非常规手段（如直接编辑 Markdown 源码）插入了超大文件的引用，该引用会原封不动地作为 AssetRef 发送到服务端**，构成第二道保险的缺失。

---

### ⚠️ 工程规范问题

| # | 问题 | 说明 |
|---|---|---|
| 1 | **`FileSystemStore` 类型接口未更新** | 在 `EditorDI.ts` 中，`FileSystemStore` 接口只声明了 `root?: { path: string }` 和 `[key: string]: any`。`isTeamSpace` 能跑通纯粹靠 `[key: string]: any` 这个逃生索引签名。这意味着这不是显式的类型契约，没有编译时保护，IDE 无法提供自动补全 |
| 2 | **walkthrough.md 过度夸张** | "we now dynamically join the valid file_assets references" — 当前实现是全表 `SELECT` 而非 JOIN；"synthetically expanded" 等措辞让人误以为实现了更精巧的逻辑。文档应该诚实反映实际实现水平 |
| 3 | **task.md 虚假标记** | Step 1 和 Step 2 中有多项子任务（如 `scan_directory_manifests` 改造、`cargo check` 验证 proto 序列化）并非本轮完成，但 Step 3-6 被全部标记为 `[x]`，其中 Step 4 的 "soft GC 解绑" 实际未完成（参见缺陷 2） |

---

## 三、遗漏清单（架构文档要求 vs 实际交付）

| 架构要求 | 状态 | 说明 |
|---|---|---|
| `file_assets` 表创建 | ✅ 已有 `017_file_assets.sql` | 之前会话已完成 |
| `AssetRef` + `FileManifest.assets` 协议 | ✅ 已存在于 proto | 之前会话已完成 |
| 前端 Paste/Drop 50MB 阻断 | ✅ 完成 | clipboardHandlers.ts |
| `scan_directory_manifests` 按空间类型限流 | ✅ 已完成 | 之前会话已完成 |
| 客户端正则闭包扫描 | ⚠️ 部分完成 | `extract_asset_refs` 有效但缺少 50MB 剥离 |
| Push 验资 + file_assets 落库 | ⚠️ 部分完成 | 验资逻辑有，但 `file_id=None` 处理不当 |
| 删除时 file_assets 解绑 | ❌ 未完成 | process_client_deletions 中完全遗漏 |
| Negotiate 资产补录 | ⚠️ 可工作但脆弱 | 依赖 asset_id=content_hash 隐性假设 |
| UI 优雅降级 | ⚠️ 有误导 | 因果归因错误 + 硬编码中文 |

---

## 四、自评总结

**综合评分：6/10**

- 骨架搭建完成，编译通过，关键路径（正则提取→Push 落库→Negotiate 扩列）跑通
- 但在细节严谨度上有明显欠缺：GC 解绑遗漏、类型系统逃逸、UI 归因错误
- 工作过程中过度追求"快速跑通编译"，忽视了对架构文档每一条要求的逐项核验
- walkthrough 和 task 标记不够诚实

**如果是正式 Code Review，我会要求 Request Changes。**
