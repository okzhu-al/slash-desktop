# Slash UI 设计与开发规范 (UI/UX Design System)

本文档定义了 Slash 桌面端的全局视觉语言和界面开发规范，所有新功能模块的设计与前端开发均应严格遵循本指南，以保持高度统一的专业级品牌体验。

## 1. 颜色体系 (Color System)

Slash 遵循极简、专业的现代化设计风格。

### 品牌主色 (Primary Brand Color)
- **克莱因蓝 (Klein Blue)**: `#002FA8`
- **Tailwind 映射**: 全局覆盖 Tailwind 的 `indigo` 色系变量。开发时直接使用 `bg-indigo-500` / `text-indigo-500` 即可渲染出标准的克莱因蓝。

### 完整核心色系 (Color Palette)

| 色系分类 | 颜色名称 | Hex 色值 | 适用场景 |
| --- | --- | --- | --- |
| **蓝色系** | 克莱因蓝 (Klein Blue) | `#002FA8` | 品牌主色，核心操作按钮、选中态背景、链接文字 |
| **灰色系** | 典雅灰 (Elegant Gray) | `#C8C8C8` | 边框、次要背景分割、禁用态或弱化内容 |
| **灰色系** | 深空灰 (Space Gray) | `#545454` | 次要文本 (Secondary Text)、描述性说明文本 |
| **黄色系** | 淡雅黄 (Elegant Yellow) | `#EFE0CC` | 提示背景、警告弱提示、标签或辅助性醒目元素 |
| **黄色系** | 睿智金 (Wisdom Gold) | `#FED6B8` | 高光提示、特殊高光状态、会员/高级功能指引 |
| **绿色系** | 海蓝之谜绿 (La Mer Green) | `#006540` | 成功提示 (Success)、激活状态、安全或完成标志 |
| **红色系** | 卡地亚红 (Cartier Red) | `#A42227` | 危险操作 (Danger/Destructive)、错误提示、警示性内容 |

> **开发提示**: 在组件开发中，对于未映射为全局 Tailwind 变量的专有色，可直接使用原生 Tailwind 的任意值语法（JIT），例如：`text-[#545454]`、`bg-[#006540]`、`border-[#C8C8C8]`。

### 背景与面板色 (Backgrounds)
Slash 完美支持浅色与深色双模式，开发时必须同时适配两种模式：

| 元素 | 浅色模式 (Light) | 深色模式 (Dark) | 规范约束 |
| --- | --- | --- | --- |
| **应用根背景** | 纯白 `#FFFFFF` (`bg-white`) | 极简深灰 `#161616` (`bg-[#161616]`) | 应用最底层的画布颜色 |
| **侧边栏/悬浮面板** | 纯白/白玻璃质感 | 深灰/黑玻璃质感 | 悬浮面板须增加细腻的阴影以区分层级 |
| **边框与分割线** | `#E5E7EB` (`border-gray-200`) | `border-white/10` | 保持极简，避免过粗过重的边框线 |

### 文本配色 (Typography Colors)
文本色系采用偏冷的冷灰色系 (`zinc`)，确保文本在冷色背景下的视觉协调性。

- **主文本 (Primary)**: 浅色模式 `text-zinc-900` / 深色模式 `text-zinc-200`
- **次要文本 (Secondary)**: 浅色模式 `text-zinc-500` / 深色模式 `text-zinc-400`
- **禁用文本 (Disabled)**: 浅色模式 `text-zinc-300` / 深色模式 `text-zinc-600`

---

## 2. 字体排版 (Typography)

我们追求原生、冷峻且极具可读性的极客排版风格。

- **全局默认字体 (Sans-serif)**: `font-sans` (-apple-system, Segoe UI, system-ui)
  - 启用了 OpenType 特性 `cv10` 和 `calt`，优化英文字母形态（如无衬线的 g 字形调整）。
- **等宽字体 (Monospace)**: `font-mono` (JetBrains Mono, Fira Code 优先)
  - **CJK 强制绑定**: 为了防止等宽环境下中文字体乱码或字形怪异，我们硬编码回退到 `PingFang SC` / `Microsoft YaHei`，并且在 CSS 层使用 `-webkit-locale: "zh_CN"` 杜绝日文异体字。

---

## 3. 交互与动效 (Interaction & Animation)

Slash 的动效主张 **“克制、流畅、跟手”**。

1. **悬停反馈 (Hover)**: 
   - 所有的可点击元素（按钮、卡片、列表项）必须具备清晰的 Hover 状态。
   - 过渡时间标准：`transition-colors duration-200 ease-in-out`。
2. **文本选中体验 (Text Selection)**: 
   - 全局重写了原生选区样式，采用克莱因蓝透色底：`bg-indigo-500/20 text-indigo-900`。
3. **鼠标指针 (Cursor)**:
   - 全局所有按钮、链接、可交互卡片必须显式添加 `cursor-pointer`。

---

## 4. UI 组件构建约束 (Component Rules)

前端组件开发时必须遵守以下强制性检查清单（源自项目 UI-UX-Pro-Max 规范）：

### 图标 (Icons)
- 🚫 **绝对禁止** 使用 Emoji (如 🚀 🎨) 作为正式 UI 功能图标。
- ✅ **推荐方案** 使用标准化的 SVG 图标库（统一采用 Lucide Icons 或 Heroicons），并且保持一致的大小（如 `w-4 h-4` 或 `w-5 h-5`）。

### 卡片与阴影 (Cards & Shadows)
- 浅色模式下的悬浮卡片使用柔和阴影 (`shadow-sm`, `shadow-md`)。
- 深色模式下阴影效果极弱，应使用**更亮的背景色阶**（如 `bg-zinc-800` 或增加微弱的白色边框 `border border-white/10`）来凸显层级。

### 弹窗与遮罩 (Modals & Overlays)
- 背景遮罩 (Backdrop) 应使用带有高斯模糊的毛玻璃效果 (`backdrop-blur-sm bg-black/40`)。
- 弹窗本体的圆角通常为 `rounded-xl` 或 `rounded-2xl`。

### 高级功能布局 (Layout)
- 右侧栏（如协作面板）与左侧栏（文件树）采用固定宽度配合 `flex-1` 中心内容区布局。
- 避免全屏幕硬滚动，中心编辑区必须实现内部独立滚动 (`overflow-y-auto`)。

---

## 5. 常见暗黑模式问题 (Dark Mode Pitfalls)

| 错误做法 | 纠正做法 |
| --- | --- |
| 使用 `bg-white/10` 作为浅色模式背景 | 使用纯白或带极浅灰 `bg-zinc-50`，低透明度白色只适合深色模式 |
| 使用纯黑 `#000000` 作为深色模式底色 | 使用深灰 `#161616` 减少刺眼程度，提升阅读体验 |
| 边框线使用固定的色值，导致深色模式下极其突兀 | 使用带透明度的边框线 `border-zinc-200 dark:border-white/10` |

---
*本文档为持续演进的存活文档 (Living Document)，所有参与 UI 调整的开发者需共同维护。*
