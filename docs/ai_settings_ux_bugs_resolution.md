# AI 设置页 UX 与状态管理的重构与修复总结

*文档记录日期：2026-03-31*

近期对 `AITab.tsx` 及 `SettingsModal.tsx` 进行了一次专门针对可用性（UX）和状态管理同步的深层修复。修复目的在于解决配置流程中用户容易遇到的一系列状态穿透、无按钮反馈、假性提示以及 UI 层级混乱等问题。具体的 Bug 复盘和技术修复手段如下。

## 1. UI 布局重组 (UI Architecture)

早期版本中，界面的「模型设定」被粗略分为两栏，且“向量嵌入模型”并未被正确挂载在统一的 Ollama 引擎语境下。

**重构细节：**
- **抽取「模型驱动引擎 (Model Engine)」模块**：由于本地运行模型底层依赖统一的 Local Ollama 服务，现已将 Ollama 的 Host（地址）与 Port（端口）单独拔高一个层级以作为全局引擎。
- **合并「本地模型 (Local Model)」模块**：将原处于散乱状态的“向量嵌入模型 (Embedding Model)”和“生成模型 (Generation Model / LLM)”归于一类，直观地挂载在“模型驱动引擎”下方。
- **国际化 (18n) 补充**：重新引入了标准的 `t()` 函数翻译键，添加了 `model_engine_title`，`model_engine_desc`，和 `local_section_desc_new`，同步修改了 `en` 与 `zh-CN` 配置。

## 2. 状态不同步与异常复位 Bug (State Persistence Desync)

这是本次修复的关键——在快速切换多个 Online Provider （服务商标签页）时，遗留的 React hook 缓存机制出现了互相覆盖与干扰。

### Bug 3 & 4：服务商切换造成假 “已连接/已保存” 与 表单污染
- **问题所在**：在缓存用户输入但是尚未保存的配置时，使用了 `baseUrl` 作为 `Map` 字典的键值。但初始化时，大量未被选配的服务商默认 `baseUrl` 其实都是隐性的空字符串 `''`。这导致了跨服务商的表单相互覆写，且一经命中缓存就会盲目赋予前端 `setProviderTestResult({ok: true})` （绿色的“已连接”提示）。
- **修正方案**：现在所有内存挂载切换（Cache）不再使用 `baseUrl` 作为凭证，改用严格的 `preset.id` （例如：'gemini', 'openai', 'custom'） 进行独立隔离。同时封存了切换后的默认已连接状态，未经过底层真实保存操作打通的配置，将绝不赋予 “已连接” 的绿色标。

### Bug 5：保存配置后 API Key 不会隐藏
- **问题所在**：成功保存设置后，用户能直观看到绿色对钩，但刚才手输的那串明文 API Key 依然顽固地保留在输入框中呈现可编辑的字面形态（没有锁死感）。
- **修正方案**：在 `SettingsModal.tsx` 内的 `handleSaveOnlineProvider` 执行结束前加入了 `setOnlineApiKey('')` 的重置指令。此时为空之后，视图层的 `<input>` 会自动接管显示默认的 `placeholder="••••••••"` 星号蒙层，给予用户一种安全的“确立”感。

### Bug 6：移除配置时状态未复位，Delete 按钮排版诡异
- **问题所在**：点击右下方远远隔开的删除按键后，底层命令调用了清除，但右下角的 "已保存" 提示依然傲然挺立。
- **修正方案**：执行 `delete_online_provider` 结束之后新增了 `setProviderTestResult(null)` 与清理 Map 的动作；切除了原带有 `ml-auto` 的隔离排版类，让功能性按钮更和谐地抱团集中。

## 3. UI 反馈交互缺失 (Interaction Misfires)

### Bug 2：初次输入 API Key 没有获取模型的下一步按钮
- **问题所在**：获取模型按钮的触发条件是 `(onlineBaseUrl && onlineApiKey)`。如果是白屏且首次全新装载这个应用，`SettingsModal` 给到子孙组件的 `onlineBaseUrl` 是初始化默认值空串 `''`。但用户看到文本框里确实印着 Google 的域名，因为那是 fallback 提供给 `placeholder` 的视觉安慰剂，导致条件无法命中。
- **修正方案**：不修改底层空字符绑定的哲学，而是将 UI 感知的触发条件放宽到：`((onlineBaseUrl || selectedPreset.baseUrl) && onlineApiKey)`。这一改动同样运用于后台实际拉取时 `invoke` 对于参数的兜底打包中。现已实现用户只需起头填写 Key，下一步的操作项就会顺滑掉落。

## 4. 架构卫生度与技术债评估 (Code Architecture & Hygiene Assessment)
在本次密集修复过程中，针对 AI 模块的前后端代码架构及其整洁程度，得出以下评估报告：

### 4.1 核心痛点：前端组件的重度耦合 (High Coupling in React Components)
目前配置面板高度集中在 `SettingsModal.tsx`（约 500+ 行）与 `AITab.tsx`（约 700+ 行）两个巨型组件中。状态管理采用了极其原始的“Top-Down”逐层下传模式：所有的网络请求结果、API Key 表单值、拉取中的 Loading 状态、甚至部分缓存 `Map` 的派生对象，全部通过 Props 从顶层的 Modal 中心化派发给 `AITab`。
这就成为了导致本次修复中**多数脏状态残留现象的罪魁祸首**——由于表单和数据验证的控制权在顶层，而用户触发（切换标签、清除缓存等逻辑）则在子组件深处；缓存逻辑被迫混写在各处的 `useEffect` 中，极易引发状态脱节。

### 4.2 渲染与业务骨架的纠缠 (UI Intertwined with Logic)
在 `AITab.tsx` 的实现中，大量包含副作用的短流程（如“获取模型中(modelsFetching)”、“下载本地镜像(ebdPulling)”）被直接包裹在复杂的 JSX 嵌套树和 `onClick` 闭包里。目前系统没有任何基于 Custom Hooks（如 `useModelDownload` 或 `useOnlineProviderSetup`）的逻辑剥离，导致想要增加一条最基本的视图显隐判断（比如我们刚才补充的 URL 后备补全）都需要侵入 `button` 和 `input` 最内侧的底层作用域。

### 4.3 后端：优秀的事件驱动基础 (Strong Event-Driven Foundation)
Tauri 的 Rust 端实现（如 `orchestrator.rs` 与 `classification.rs`）在架构上体现出了出色的整洁度。
得益于采用了全局 Tauri Event（如 `ai:degraded`），后端发生模型降级或配置报错时，能够以单向数据流的形式主动推送脱离业务阻塞的广播。这种解耦设计让报错与警告逻辑可以极度轻量级地挂载在根视图层（比如上次我们在 `App.tsx` 中的无缝切入 toast 处理）。在配合我们刚刚去除了 Hardcoded 中文转为通用 I18n Key 之后，当前后端的模块隔绝性和卫生度都达到了较高水平。

**中长期重构及改善建议（Refactoring Suggestions）：**
- **拆离上帝组件（Contextualization）：** 急需使用轻量级状态库（如 Zustand）或 React Context 对顶层 `SettingsModal` 瘦身。把“AI 设置数据”、“同步设置数据”等专域自治型状态提取到各自模块特定的 Hook 中，截断当前跨层级的超大 Props 传递。
- **在线供应商字典抽象（Registry Pattern）：** 即在 `AITab` 剥离散修散打的条件验证（if baseUrl && key && ID...），为其提供一个统一的 `ProviderConfigManager` 对象，把读取预设、校验连通性、下行落盘的能力进行隔离和模块化。
