# OPT-04 精准多媒体资源闭包架构 — 实施计划

> **目标**: 将同步对象从单一"节点文件"升级为**内容闭包（Note Content Closure）**，实现资源精确绑定、跨团队隔离与安全垃圾回收。

## 调研结论

通过对全栈代码的深度调研，确认以下关键现状：

| 维度 | 现状 | 目标 |
|------|------|------|
| 文件大小限制 | `slash-core/lib.rs` L218: 全局硬拦截 `>25MB` 跳过同步（含个人空间） | 仅 Team 空间 50MB 拦截，个人空间不限 |
| 前端拦截 | `clipboardHandlers.ts` L102/352: 已有 50MB 的 file.size 判断，**但不区分 Team/Personal** | 仅 Team 空间启用阻断 |
| 协议层 | `FileManifest` 无 `assets` 字段 | 新增 `assets: Option<Vec<AssetRef>>` |
| Server Push | `push.rs` 直接 upsert `file_states` + storage.put，无资源关联逻辑 | 增加 `file_assets` 验资落池 |
| Server Negotiate | `negotiate.rs` 基于 `file_states` 构建 client_needs/server_needs，无资源下发 | JOIN `file_assets` 按权发放 |
| DB | 已有 16 个迁移脚本（最新 `016_backfill_trash_directory_id.sql`） | 新增 `017_file_assets.sql` |

## User Review Required

> [!IMPORTANT]
> **迁移文件编号**: 架构文档标注 `016_file_assets.sql`，但实际已有 16 个迁移（编号 001-016）。执行时采用 **`017_file_assets.sql`** 避免冲突。

> [!WARNING]
> **Step 1 协议兼容性**: `FileManifest.assets` 使用 `Option<Vec<AssetRef>>` + `#[serde(default)]`，旧客户端推送时 `assets` 为 `None`，Server 无感知兼容。新客户端连接旧 Server 时 Server 会忽略 `assets` 字段。**向前向后均兼容**。

> [!IMPORTANT]
> **Step 2 行为变更**: 当前 `slash-core` 的 25MB 全局拦截会让个人空间的大文件也无法被 scan，修改后个人空间将允许任意大小文件参与同步扫描。**请确认这是期望的行为**。

---

## Proposed Changes

### Step 1: 协议与 DB 基建扩容

#### [MODIFY] [lib.rs](file:///Users/junior/Projects/slash/packages/slash-sync-proto/src/lib.rs)

新增 `AssetRef` 结构体与 `FileManifest.assets` 可选字段：

```rust
/// 多媒体资源引用 — 内容闭包的最小资产单元
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AssetRef {
    /// 服务端核心信任根（现阶段等于 content_hash）
    pub asset_id: String,
    /// 仅用作定位/兼容字段
    pub relative_path: String,
    /// 仅 Metadata，非安全基准 (e.g. "image/png", "video/mp4")
    pub kind: String,
    /// 分组标识（如 Tldraw sidecar 的两个文件归属同一 group）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
}
```

在 `FileManifest` 末尾增加：
```rust
/// 内容闭包 — 此笔记显式声明的全部附件资源引用
#[serde(default, skip_serializing_if = "Option::is_none")]
pub assets: Option<Vec<AssetRef>>,
```

更新序列化测试以覆盖新字段。

---

#### [NEW] [017_file_assets.sql](file:///Users/junior/Projects/slash/apps/server/migrations/017_file_assets.sql)

```sql
-- OPT-04: 多媒体资源依赖图谱 (Asset Dependency Graph)
CREATE TABLE IF NOT EXISTS file_assets (
    vault_id UUID NOT NULL,
    file_id  UUID NOT NULL,
    asset_id TEXT NOT NULL,
    note_path TEXT,
    asset_path TEXT,
    asset_kind TEXT,
    group_id TEXT,
    PRIMARY KEY (vault_id, file_id, asset_id)
);
```

**验收**: `cargo check` 通过；Server 启动后 `file_assets` 表存在。

---

### Step 2: 前端 Team 限流与 UI 降级

#### [MODIFY] [lib.rs](file:///Users/junior/Projects/slash/packages/slash-core/src/lib.rs)

将 `scan_directory_manifests` 中 L218 的全局 25MB 硬拦截改为条件式：

- **废弃**全局 `if size > 25 * 1024 * 1024 { continue; }` 硬拦截
- 新增公共常量:
  ```rust
  /// Team 空间的单文件同步体积上限（50MB）
  pub const TEAM_ASSET_MAX_SIZE: u64 = 50 * 1024 * 1024;
  ```
- `scan_directory_manifests` 新增 `is_team: bool` 参数，**仅当 `is_team && size > TEAM_ASSET_MAX_SIZE` 时跳过**
- 为保持向后兼容，保留原签名并提供新函数 `scan_directory_manifests_with_team_filter` 或通过 wrapper 适配

> [!NOTE]
> 所有调用 `scan_directory_manifests` 的客户端代码（`team.rs`, `personal.rs`, `promote.rs`）需要适配新签名。personal 同步传 `false`，team 同步传 `true`。

---

#### [MODIFY] [clipboardHandlers.ts](file:///Users/junior/Projects/slash/apps/desktop/src/features/editor/utils/clipboardHandlers.ts)

- L102 / L352 的 `file.size > 50 * 1024 * 1024` 的判断增加 Team 空间检测：
  ```typescript
  import { useSessionStore } from '@/stores/useSessionStore';
  // ...
  const isTeam = !!useSessionStore.getState().teamVaultId;
  if (isTeam && file.size > 50 * 1024 * 1024) {
      // 展示 toast 提示
      console.warn(`⚠️ Team Space: File too large: ${file.size} bytes`);
      return;
  }
  ```
- **个人空间不再受大小限制**，仅保留 memory-read 的 50MB 安全阈值

---

#### [MODIFY] [VideoComponent.tsx](file:///Users/junior/Projects/slash/packages/js-editor-core/src/extensions/Media/VideoComponent.tsx)

新增降级兜底占位：当 Team 空间中视频资源加载失败（404 或超限），自动显示优雅降级文案：

> **"视频文件超出团队文件大小限制，无法同步到团队空间"**

具体实现：
- 在 `onError` 回调中检测错误类型
- 3 次重试均失败后，替换为降级占位 UI（带 i18n 支持）

---

#### [MODIFY] [common.json](file:///Users/junior/Projects/slash/apps/desktop/src/locales/zh-CN/common.json) + en/common.json

新增 i18n key：
```json
"media": {
    "team_size_limit_title": "文件超出限制",
    "team_size_limit_block": "此文件超出团队空间 50MB 大小限制，无法引入",
    "team_size_limit_fallback": "视频文件超出团队文件大小限制，无法同步到团队空间"
}
```

**验收**: 向团队目录拖入 60MB 视频被前端阻断并弹出提示；个人空间拖入同等文件正常落盘。

---

### Step 3: 客户端内容闭包扫描引擎

#### [MODIFY] [helpers.rs](file:///Users/junior/Projects/slash/apps/desktop/src-tauri/src/commands/sync/helpers.rs)

新增 `extract_asset_refs` 函数：

```rust
/// 从 Markdown 内容中扫描所有多媒体依赖，生成 AssetRef 图谱
/// 支持模式: ![img](relative/path), video src, Tldraw sidecar 等
pub fn extract_asset_refs(
    content: &[u8],
    root: &std::path::Path,
    is_team: bool,
) -> Vec<slash_sync_proto::AssetRef> {
    // 1. 正则匹配 ![...](relative_path) 和 video/audio 节点
    // 2. 计算每个依赖文件的 content_hash 作为 asset_id
    // 3. 若 is_team && size > 50MB → 剥离不纳入闭包
    // 4. 返回去重后的 AssetRef 列表
}
```

在 `manifest_to_payload` 和 `collect_mapped_files_for_push` 中注入 assets 闭包：
```rust
manifest.assets = Some(extract_asset_refs(&content, root, is_team));
```

**验收**: 拦截抓包可观测 `SyncPushRequest` 内 `FileManifest.assets` 有值且不含超限资产。

---

### Step 4: Server Push 验资落池与安全 GC

#### [MODIFY] [push.rs](file:///Users/junior/Projects/slash/apps/server/src/routes/sync/push.rs)

在文件 upsert 成功后（L369-393 区域），新增 `file_assets` 落池逻辑：

1. **读取** `manifest.assets`，遍历每个 `AssetRef`
2. **验资**: `storage.exists(vault_id, asset_ref.relative_path)` 确认 Blob 可兑现
3. **落池**: `INSERT INTO file_assets ... ON CONFLICT DO UPDATE`
4. **拒绝未声明的孤岛 Blob**（未来增量实现）

在删除逻辑中（对应 negotiate 的 `process_client_deletions`）：
1. **解绑**: `DELETE FROM file_assets WHERE vault_id = $1 AND file_id = $2`
2. **空引用检查**: 若同 vault 无其他引用 → 标记物理释放（Safe GC，可先软标记以后批量执行）

**验收**: 恶意跳脱协议上传空资产被 Rejected；同一 Vault 内不同笔记引用的资产秒传复用。

---

### Step 5: Server Negotiate 按需发放

#### [MODIFY] [negotiate.rs](file:///Users/junior/Projects/slash/apps/server/src/routes/sync/negotiate.rs)

在 `diff_server_files` → `client_needs` 构建阶段之后：

```rust
// OPT-04: 基于合法笔记权限，JOIN file_assets 获取资产清单追加到 client_needs
let asset_paths: Vec<String> = sqlx::query_scalar(
    "SELECT DISTINCT fa.asset_path FROM file_assets fa
     INNER JOIN file_states fs ON fa.vault_id = fs.vault_id AND fa.file_id = fs.file_id
     WHERE fa.vault_id = $1 AND fs.relative_path = ANY($2) AND fs.is_deleted = false"
)
.bind(ctx.vault_uuid)
.bind(&ctx.client_needs) // 用户有权拉取的笔记列表
.fetch_all(ctx.pool).await.unwrap_or_default();

for asset_path in asset_paths {
    if !ctx.client_needs.contains(&asset_path) {
        ctx.client_needs.push(asset_path);
    }
}
```

**验收**: 未获授权的用户拿不到他人笔记的配套媒体；确权用户 Negotiate 时顺利同步媒体资产。

---

## Open Questions

> [!IMPORTANT]
> 1. **`scan_directory_manifests` 签名变更**: 当前函数被 3 处调用（team.rs, personal.rs, promote.rs），修改签名会导致全链路适配。是否接受增加 `is_team` 参数？还是倾向于保留原签名，仅在调用侧加过滤？

> [!WARNING]
> 2. **Safe GC 实现时机**: 架构文档要求"引用耗尽才物理删除"。在 Step 4 中是否要求完整实现物理 Blob 删除？还是先仅做 `file_assets` 解绑记录，后续 OPT-05 再做批量 GC？

---

## Verification Plan

### Automated Tests
1. `cargo check` — 全栈编译通过
2. `cargo test -p slash-sync-proto` — `FileManifest` 序列化含 `assets` 字段的 roundtrip 测试
3. `npm run build` (desktop) — 前端编译通过

### Manual Verification
1. **Step 2**: 向团队空间拖拽 >50MB 视频文件 → 前端弹出阻断提示；个人空间拖入同等文件 → 正常落盘
2. **Step 3**: 在带有图片/视频引用的笔记中执行同步 → 观测 Push 请求含 `assets` 数组
3. **Step 4**: 通过 psql 查询 `SELECT * FROM file_assets` 确认资源关系正确写入
4. **Step 5**: 确权用户 Negotiate 后拉取到配套媒体文件

### 推荐分期提交
按架构文档建议的 Step 1→5 顺序逐步提交验证，每步完成后 `cargo check` + `npm run build` 确保不引入回归。
