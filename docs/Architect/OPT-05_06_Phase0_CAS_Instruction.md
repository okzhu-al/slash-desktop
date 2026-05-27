# OPT-05/06 阶段零：CAS 内容寻址存储改造 — 研发执行指令

> **签发**: 架构师  
> **日期**: 2026-04-27  
> **优先级**: P0（后续所有 OPT-05/06 阶段的硬性前置）  
> **预计工作量**: 轻量级，核心改动集中在 2 个 Rust 文件

---

## 一、项目背景

Slash 是一款本地优先的结构化笔记应用，支持个人空间和团队空间同步。用户可以在笔记中通过拖拽 (Drag)、粘贴 (Paste)、侧边栏导入 (ImportHub) 三种方式插入多媒体附件（图片、视频、音频）。

**附件生命周期**：
1. 用户插入附件 → Rust 后端将文件复制到 `{vault}/assets/` 目录
2. 编辑器中生成 Markdown 引用：`![](assets/filename.png)`
3. 同步时，客户端扫描 Markdown 中的附件引用，构建 `AssetRef` 闭包声明
4. 服务端将 `(vault_id, file_id, asset_id)` 关系写入 PostgreSQL 的 `file_assets` 表

**附件去重**：系统已实现基于 SHA-256 内容哈希的去重机制。每次插入附件时会先计算哈希，如果索引中已存在相同哈希则直接复用已有文件路径。

---

## 二、问题定义

当前代码存在一个**设计缺陷**：附件落盘时使用**原始文件名**（如 `screenshot.png`、`D8BC1DB8-xxxx.jpeg`），而 `file_assets` 表的 `asset_id` 字段也直接使用这个文件名。

这违背了 OPT-04 架构文档中"asset_id 现阶段直接等于 content_hash"的设计规定，会导致：

1. **碰撞风险**：两个用户各自拖入不同内容但同名的 `screenshot.png`，`asset_id` 相同但内容不同，`file_assets` 表产生幻影覆盖
2. **去重漏洞**：同一文件通过 Drag（保留原名 `photo.jpg`）和 Paste（生成 `Pasted_image_20260427.jpg`）引入，因文件名不同产生两份磁盘副本
3. **跨端污染**：服务端基于 `asset_id` 做存储和分发，文件名碰撞会导致 A 用户的图片被 B 用户的同名图片覆盖

---

## 三、改造目标

将附件存储从"基于原始文件名"改为"基于内容哈希（CAS, Content-Addressable Storage）"：

- 磁盘文件名：`assets/{content_hash}.{ext}` （如 `assets/a3f8b2c1d4e5f6a7.png`）
- Markdown 引用：`![](assets/a3f8b2c1d4e5f6a7.png)`
- `file_assets.asset_id`：`a3f8b2c1d4e5f6a7.png`（即文件名本身）

---

## 四、需要修改的文件与具体指令

### 4.1 `apps/desktop/src-tauri/src/commands/assets.rs`

这是核心改动文件。当前有两个落盘函数需要修改：

#### `save_asset` 函数（第 33-127 行）

**当前行为**（第 87-104 行）：
```rust
let base_name = match original_name {
    Some(name) if !name.is_empty() => {
        Path::new(&name).file_stem()
            .map(|s| s.to_string_lossy().to_string().replace(' ', "_"))
            .unwrap_or_else(|| name.replace(' ', "_"))
    }
    _ => {
        let now = Local::now();
        format!("Pasted_image_{}", now.format("%Y%m%d%H%M%S"))
    }
};
let filename = get_unique_filename(&assets_dir, &base_name, ext);
```

**改为**：直接使用已计算好的 `file_hash`（第 49 行）作为文件名基干：
```rust
// CAS: 使用 content_hash 作为文件名，天然去重且无碰撞
let filename = format!("{}.{}", &file_hash, ext);
```

同时删除 `get_unique_filename` 的调用（哈希天然唯一，不需要递增后缀逻辑）。

> **注意**：`file_hash` 是完整的 SHA-256（64 字符十六进制），可以考虑截取前 16 位以保持文件名可读性。但需要评估碰撞概率是否可接受。建议保留完整 64 位，安全第一。

#### `save_asset_from_path` 函数（第 130-218 行）

**当前行为**（第 166-178 行）：
```rust
let original_name = source.file_stem()
    .map(|s| s.to_string_lossy().to_string().replace(' ', "_"))
    .unwrap_or_else(|| "file".to_string());
let ext = source.extension()...;
let filename = get_unique_filename(&assets_dir, &original_name, &ext);
```

**改为**：同样使用 `file_hash`（第 150 行已计算）：
```rust
let ext = source.extension()
    .map(|e| e.to_string_lossy().to_string())
    .unwrap_or_else(|| "bin".to_string());
// CAS: 使用 content_hash 作为文件名
let filename = format!("{}.{}", &file_hash, ext);
```

**额外优化**：由于 CAS 文件名天然幂等，如果 `assets_dir.join(&filename)` 已经存在，说明内容完全相同，可以直接返回已有路径，无需再次写入磁盘：
```rust
let target_path = assets_dir.join(&filename);
let relative_path = format!("assets/{}", filename);

// CAS 幂等：如果文件已存在，内容必然相同（hash 相同），直接复用
if target_path.exists() {
    // 更新索引（可能是索引缺失但文件在的情况）
    // ...
    return Ok(SaveAssetResult { relative_path, is_duplicate: true });
}
```

#### `get_unique_filename` 辅助函数（第 9-19 行）

此函数在 CAS 模式下不再被需要。确认无其他调用点后，标记为 `#[allow(dead_code)]` 或直接删除。

---

### 4.2 `apps/desktop/src-tauri/src/commands/sync/helpers.rs`

#### `extract_asset_refs` 函数（第 35-67 行）

**当前行为**（第 53-54 行）：
```rust
assets.push(slash_sync_proto::AssetRef {
    asset_id: filename.clone(),  // ← 文件名作为 asset_id
    ...
});
```

改造后，由于磁盘文件名本身就是 `{hash}.{ext}`，`filename` 自然就包含了 hash。这里的 `asset_id` 值会自动变为 `a3f8b2c1d4e5f6a7.png`，**无需额外改动**。

但请**验证确认**：正则捕获组 `caps.get(1)` 提取的 `filename` 确实是 `{hash}.{ext}` 而非含有 `assets/` 前缀的完整路径。当前正则 `assets[/\\]([^"'\)\]\s]+...)` 的捕获组 1 确实只是文件名部分，所以此处无需改动。

---

### 4.3 无需改动的文件（确认兼容性）

| 文件 | 原因 |
|:---|:---|
| `state.rs` (AssetIndex) | `entries` 的 key 已经是 SHA-256 hash，value 是 `relative_path`。CAS 改造后 value 从 `assets/原名.png` 变为 `assets/{hash}.png`，结构不变，天然兼容 |
| `apps/server/src/routes/sync/push.rs` | 服务端按 `asset_id` 存储，不关心 ID 的内容是文件名还是 hash，天然兼容 |
| `MediaService.ts` (前端) | 只消费 Rust 返回的 `relative_path`，不关心命名规则，天然兼容 |
| `FileSystemNoteRepository.ts` | `_extractAssetRefsOffline` 基于正则匹配 `assets/` 前缀，不依赖文件名格式，天然兼容 |

---

## 五、验收条件

1. **基本功能**：在笔记中拖入一张图片 → `assets/` 目录下生成的文件名为 `{64位sha256hex}.png` 格式
2. **去重验证**：将同一张图片先拖入、再从剪贴板粘贴 → 两次操作返回相同的 `relative_path`，磁盘上只有一份文件
3. **同步闭包**：查看 Push 请求中的 `FileManifest.assets` 数组 → `asset_id` 为 `{hash}.{ext}` 格式
4. **编译通过**：`cargo check` 全通过，无新 warning
5. **回归测试**：现有的图片渲染、视频播放、资产清理（AutoClean）功能不受影响

---

## 六、注意事项

- **不需要做存量数据迁移**。项目处于 Beta 阶段，没有历史包袱，直接改代码即可
- **不要修改 `slash_sync_proto` 协议**。`AssetRef` 的 `asset_id` 字段类型是 `String`，内容从文件名变为 hash 不影响协议
- 修改完成后请撰写简要报告放在 `docs/Developer/` 目录下
