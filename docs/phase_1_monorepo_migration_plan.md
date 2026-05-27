# Slash Team Edition: Phase 1 (Monorepo Migration) 详细实施方案

本文档规定了如何无痛、安全地将目前的 Slash 本地版代码库迁移至 `pnpm + Cargo Workspace` Monorepo 架构。
**最高铁律：阶段一仅改变文件的物理位置和模块引用关系，绝对不允许修改现有的业务逻辑。** 每一步完成后，必须保证 `pnpm dev` 和 `cargo check` 正常通过。

## 架构蓝图 (最终形态)
```text
slash/
├── package.json
├── pnpm-workspace.yaml
├── Cargo.toml (Virtual Manifest)
│
├── apps/
│   ├── desktop/                # 即当前的所有的 src/ 和 src-tauri/
│       ├── package.json
│       ├── src-tauri/Cargo.toml
│
├── packages/
│   ├── slash-core/             # Rust: 纯算法、Hash、基础抽象结构
│   ├── slash-sync-proto/       # Rust: 端云通讯的同步协议、逻辑时钟定义
│   ├── js-editor-core/         # TipTap/TS: 脱离 Tauri 的文本跨平台渲染模块
│   └── js-shared-types/        # TS: 跨界接口签名，保证 JSON 序列化一致性
```

---

## 🚧 Step 1: 确立 Monorepo 根基盘 (Root Foundation)

**动作：**
1. 在根目录创建 `pnpm-workspace.yaml`，内容如下：
   ```yaml
   packages:
     - 'apps/*'
     - 'packages/*'
   ```
2. （可选，视你当前的 Cargo.toml 位置）在根目录准备一个顶级的 `Cargo.toml` 来统筹所有 Rust crate。如果为了保守起见，第一步我们先在 `src-tauri` 的层级把工作区配置好，这里建议我们在 `src-tauri` 目录内部件工作区：
   修改 `src-tauri/Cargo.toml` 的顶部：
   ```toml
   [workspace]
   members = [
       ".",
       "../../packages/slash-core",
       "../../packages/slash-sync-proto"
   ]
   resolver = "2"
   ```

---

## 🧳 Step 2: 物理搬家与路由修复 (The Big Move)

**动作：**
这是动作最大的一步，我们将目前散列在外面的前端工程装入 `apps/desktop`。
1. 在根目录新建大文件夹：`mkdir -p apps/desktop packages/slash-core packages/slash-sync-proto packages/js-editor-core packages/js-shared-types`。
2. 将以下文件全部移入 `apps/desktop/`：
   `src/`, `src-tauri/`, `index.html`, `vite.config.ts`, `package.json`, `tsconfig.json`, `postcss.config.js`, `tailwind.config.js`。
   *(注意：`.git`, `docs/`, `PHASE_X.md`, `.gitignore` 等工程/描述文件留在外层根目录)*
3. **修复相对路径炸弹**：
   - 检查 `apps/desktop/package.json` 中的 script。
   - 检查 `apps/desktop/src-tauri/tauri.conf.json` 中配置的 `frontendDist` 等字段是否因为目录层级变动而失效（原本构建目录在 `../dist`，现在依然是相对 `tauri.conf.json` 所在的上一级，这其实是不变的，但需要仔细核对）。
4. **验证阀门**：
   - 此时在根目录执行 `pnpm install`。
   - 进入 `apps/desktop` 执行 `pnpm dev`，进入 `src-tauri` 执行 `cargo check`。**如果跑不起来，Git Reset 撤回！不能往下走。**

---

## 🧩 Step 3: 前端第一块积木脱离 (js-shared-types)

**动作：**
跑通 Monorepo 的包依赖（Frontend）。
1. 在 `packages/js-shared-types` 下创建基础的 TypeScript 工程体系（`package.json`, `tsconfig.json`, `index.ts`）。
   - name: `@slash/shared-types`。
2. 返回 `apps/desktop/package.json`，添加私有工作区依赖：`"@slash/shared-types": "workspace:*"`，并且执行 `pnpm i` 打通软链。
3. 从 `apps/desktop/src/...` 中切除一块基础的类型定义（例如 `NoteMetadata` 的 TypeScript Interface）放入 `js-shared-types/index.ts` 中并 export。
4. 全局搜索并替换原项目中的相对引用为：`import { NoteMetadata } from '@slash/shared-types';`。
5. **验证阀门**：Vite 正常启动且无 TS 报错。证实 pnpm workspace 工作流畅通。

---

## 🦀 Step 4: 后端第一块积木脱离 (slash-core)

**动作：**
跑通 Cargo Workspace 的包依赖（Backend）。
1. 进入 `packages/slash-core` 执行 `cargo init --lib`。
2. 在 `packages/slash-core/Cargo.toml` 中配置 `name = "slash-core"`。
3. 查找 `apps/desktop/src-tauri/src/` 中完全**不依赖 tauri::State 和 IPC 上下文**的纯函数算法。例如 `hash` 计算函数，将其移动至 `packages/slash-core/src/lib.rs`。
4. 在 `apps/desktop/src-tauri/Cargo.toml` 的 dependencies 中加入：
   `slash-core = { path = "../../../packages/slash-core" }`。
5. 将桌面端旧代码中的引用替换为对新包层 `slash_core::hash_func` 的调用。
6. **验证阀门**：执行 `cargo build` 或 `cargo check`，证实 Cargo workspace 挂载无缝衔接。

---

## 🏋️‍♂️ Step 5: 分离编辑器的灵魂 (js-editor-core 抽离)

**动作：**
执行此项目最困难的剥离，将核心的 Tiptap AST 解析与双向绑定逻辑剥离出具体业务。
1. 在 `packages/js-editor-core` 初始化。
2. 从 `apps/desktop/src/features/editor/` 和 `src/core/markdown/` 中提取**纯排版规则、TipTap Extensions 和 Markdown Bridge 转换器**。
3. **彻底切断原生的 Tauri 依赖**。如果某个 Extension 需要调用原生的读写文件 / 选择对话框（例如 ImageExtension 或 FileDrop），重构该扩展，使其接受外部传入的 **Hooks 或 Provider Callback**，例如 `onUploadImage(file) => Promise<string>`。
4. 在 `apps/desktop` 中的 `Editor.tsx` 里，引入 `@slash/editor-core` 并将具体的 Tauri 侧读写方法注入进去。
5. **验证阀门**：应用正常启动，Markdown 解析完好无损，列表、图片均能正常运作。

至此，我们的代码树就如同做完了器官切除和人造心脏移植，接下来的 Team Edition 无论怎么扩展 Server 和 Mobile，底层渲染和算法核心都已经是极其干净纯粹的基础库了。
