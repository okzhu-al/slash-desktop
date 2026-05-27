# OPT-04 精准多媒体资源闭包架构方案与执行计划 (Asset Dependency Graph)

> **文档状态**: 架构敲定，等待研发排单接入 (Ready for Dev)  
> **相关标签**: Sync, RBAC Isolation, Asset Closure, Garbage Collection

## 一、方案核心目标

彻底消除通过全局正则白名单抽取资源带来的**跨团队越权漏洞**与**大文件断链崩溃（HTTP 404 Sync Crash）**。
将同步对象由单一的“节点文件”升级为**内容闭包（Note Content Closure）**。客户端负责显式声明多媒体依赖图谱，服务端负责确权、存取并严防死守 `file_assets` 表，实现隔离与精确拉取。

### 6 项基石原则 (The 6 Pillars)
1. Asset 绝不进入全局白名单。
2. 同步单元从文件升级为 Note Content Closure。
3. 客户端在 Markdown 变更时声明依赖，服务端持久化依赖树。
4. 服务端通过“此 Client 有权访问此 Note → 反查 Asset”来下发资源清单。
5. 超大文件（强统一为 **50MB**）被严格阻断在 Team Strong Closure 之外。
6. “前端防爆阻断”与“闭包声明过滤”形成双保险，防止幻影节点。

---

## 二、架构变更明细 (Architecture Proposed Changes)

### 1. [Backend/Database] PostgreSQL Schema Migrations
**引入 `016_file_assets.sql` 结构**
创建服务端细粒度的媒体资源关联表，支持对资源本身赋予 `asset_id`。
> 注意：主键采用 `(vault_id, file_id, asset_id)`，本方案放弃兼容缺乏 `file_id` 的历史孤儿脏数据，采取“做好当下”原则。

```sql
CREATE TABLE file_assets (
    vault_id UUID NOT NULL,
    file_id UUID NOT NULL,
    asset_id TEXT NOT NULL,
    note_path TEXT,
    asset_path TEXT,
    asset_kind TEXT,     -- 仅作为前端 Metadata，不作为安全信任根（Security Primitive）
    group_id TEXT,
    PRIMARY KEY (vault_id, file_id, asset_id)
);
```

### 2. [Protocol] slash-sync-proto 协议更新
引入 `AssetRef`，并在 `FileManifest` (传输结构) 中扩增可选的 `assets` 清单：
> **信任边界定义：** 服务端真正信任的是 `asset_id` (作为 Blob 的主键标识与隔离依据)，而 `relative_path` 仅仅作为客户端定位和前端还原路径的兼容字段。
```rust
pub struct AssetRef {
    pub asset_id: String, // 服务端核心信任根（现阶段直接等于 content_hash）
    pub relative_path: String, // 仅用作定位/兼容字段
    pub kind: String, // 仅 Metadata，非安全基准
    pub group_id: Option<String>,
}

pub struct FileManifest {
    // 现有常规字段
    ...
    // 明确其所依赖的全部附件资源闭包
    pub assets: Option<Vec<AssetRef>>,
}
```

### 3. [Backend/Sync Engine] Server Push 与生命周期管控
*   **统一上传与边界拒收机制：**
    *   同次 `Push` 中，在 manifest **显式声明**的 `AssetRef` 才能进入后续检查。
    *   未声明但试图“夹带私货”上传的二进制 blob 会被**完全拒绝或隔离**。
    *   **精确复用逻辑：** 若服务端在**同一 vault 内**已存在相同 `asset_id` 的有效 blob，则允许直接复用（跳过物理落盘）。以此摒弃模糊的“权限组”概念，杜绝跨 Vault 泄露和人员变动带来的越权问题。
*   **严进准则（ `file_assets` 的落账时机 ）**：
    *   `file_assets` 绝不是“客户端登记表”，而是**“Server 端验收后的有效图谱”**。
    *   **只有当**关联的二进制 Blob 确实在 Server 侧**可兑现**（无论是刚刚成功落盘还是在同一 Vault 内已被确认存在）后，服务端的 Push 流程才能将对应的 `(vault_id, file_id, asset_id)` 关系写入 `file_assets` 表。不能接受未能兑现的“空指针依赖”。
*   **安全垃圾回收（Safe GC）**：
    *   **第一步（解绑）：** 当某 Note (File) 遭遇 Delete 或进入软删后，移除 `file_assets` 表里与其对应的 `note → asset` 绑定记录。
    *   **第二步（物理释放）：** 当同一 Vault 内没有任何其他 Note 继续引用此 `asset_id` 时，才执行物理 Blob 文件的抹除并真正释放该空间的存储配额。

### 4. [Backend/Sync Engine] Server Negotiate 下发管控
*   在返回给客户端前，先获得该用户有权拉取的合规 Note 列表，然后 **`JOIN file_assets`** 表，按合法闭包向 `client_needs` 下发其严格依赖的 `asset_path/asset_id` 集合。

### 5. [Client/Frontend] 前端超限双保险与优雅降级
*   **全局统一限流**：所有媒体引入阈值消除多重历史包袱，严格向 **50MB** 对齐，且**此约束仅针对 Team 空间启用（个人空间正常落盘不设限）**。
*   **前端引入阻断（第一道保险）**：
    *   在拖拽、粘贴或从系统中选择文件等直接引入环节，识别到基于 Team 模式且文件超过 50MB 时，打断引入流程，禁止将其存储为标准的相对路径节点。
*   **推文闭包剥离防雪崩（第二道保险）**：
    *   针对通过 Promote 或非常规手段遗留下来的“特大文件”，客户端在组装 `FileManifest.assets` 的图谱清单解析阶段，判定当前是推往 `SpaceType::Team` 服务器，主动过滤掉体积 `>50MB` 的条目。拒绝纳入闭包发送防止 Server 端形成坏链。
*   **无缝 UI 降级展示**：
    *   队友或 Web 端试图渲染遭到剥离的超限 Asset 节点（即拉取不到该 Asset）时，自动显示优雅兜底占位文案：
        > **“视频文件超出团队文件大小限制，无法同步到团队空间”**

---

## 三、执行分解计划 (Task Breakdown)

> 依照实施复杂度，整个架构转型被切分为 5 个子步骤，推荐研发按顺序依次完成、分期提交与验证。

- `[ ]` **Step 1: 协议与 DB 基建扩容 (Protocol & Schema)**
  - **目标**: 为 Server 端增加 `file_assets` 关系表记录依赖图谱，升级全栈 `slash-sync-proto` 通讯协议，承载 `AssetRef` 闭包声明。
  - **改动文件**:
    - `packages/slash-sync-proto/src/lib.rs`
    - `apps/server/migrations/2026xxxx_016_file_assets.sql`
  - **验收条件**: 后端完成 `cargo check`，起服后成功创建 `file_assets` 数据库表；全栈对新引入的 `FileManifest.assets` 类型解析兼容。

- `[ ]` **Step 2: 前客户端限流防爆与降级组件 (Frontend Team Limit & UI)**
  - **目标**: 全栈对齐 50MB 硬性防爆上限，**严格限制此拦阻策略仅在团队空间（Team Vault）下生效**。对于个人私有笔记的媒体引入保持不设卡。
  - **改动文件**:
    - `packages/slash-core/src/lib.rs` (将历史遗留的 `25 * 1024 * 1024` 全局拦截修改为**仅针对 Team 同步开启**的 50MB 拦截)
    - `apps/desktop/src/features/editor/utils/clipboardHandlers.ts` (基于当前 `Workspace/Vault` 类型判别，执行条件阻断)
    - `packages/js-editor-core/src/extensions/Media/VideoComponent.tsx`
    - `apps/desktop/src/locales/*/common.json`
  - **验收条件**: 尝试向 **团队目录** 拖入 60MB 视频，得到前端严格阻断提示；但在 **个人私有库** 拖入同等大文件允许正常本地落盘不受限。在 Markdown 源码强行写入死链接时，视图中呈现兜底文案 _“视频文件超出团队文件大小限制，无法同步到团队空间”_。

- `[ ]` **Step 3: 客户端内容闭包扫描引擎 (AST Closure Extractor)**
  - **目标**: 拦截客户端组装 `SyncPushRequest` 过程，正则提取/AST 获取依赖，生成 `AssetRef` 图谱结构；在判断推送环境为 `SpaceType::Team(_)` 的前提下，过滤出并剥离体积大于 50MB 的非法随车资产。
  - **改动文件**:
    - `apps/desktop/src-tauri/src/commands/sync/helpers.rs`（或产生 `FileManifest` 的等效构建模块）
  - **验收条件**: 拦截抓包可观测，发送至团队服务器的 `SyncPushRequest` 内附有彻底剥离超界（>50M）死链的纯净图谱 `FileManifest.assets` 数组。

- `[ ]` **Step 4: Server Push 验资库与安全重构 (Server Validations & Safe GC)**
  - **目标**: 落实“零信任验收落池”与“Vault 隔离复用”。明确阻断未知 Hash 二进制孤岛；确保实体二进制文件 100% 可用后，写入关联 `file_assets`。同步实现基于引用计数的 Safe GC 生命期托管。
  - **改动文件**:
    - `apps/server/src/routes/sync/push.rs`
  - **验收条件**: 恶意跳脱协议上传空资产立刻被 Rejected；同一 Vault 内不同笔记引用的资产完成高速秒传复用（不触发二次落盘）；通过服务端发生软删或硬删脱落关联关系的节点在 `file_assets` 中仅被解除链接，引用耗尽才会触发真删除释放容量。

- `[ ]` **Step 5: Server Negotiate 按需扩列发放许可 (Server Delivery)**
  - **目标**: 基于团队成员笔记存取授权进行 SQL JOIN，将经过上述层层验核确保安全合法的媒体资产补录到 `client_needs`。
  - **改动文件**:
    - `apps/server/src/routes/sync/negotiate.rs`
  - **验收条件**: 未获准看其父 Note 的用户获取不到下辖图片/视频的 URL 与许可票据，确权用户进行 Negotiate 时顺利同步随同文件的配套媒体树，达成精确分发不断链。
