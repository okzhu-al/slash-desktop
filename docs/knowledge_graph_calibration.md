# 空间知识图谱 (Spatial Knowledge Graph) - LOD与性能校准记录

本文档记录了为实现“全局沉浸与极简稳定”的知识图谱，我们在视距缩放 (Level of Detail)、无极坐标物理映射、ReactFlow 性能榨取等方向的历次校准调优参数。

## 1. 缩放阈值与展示信息深度 (LOD Engine)
通过分离出四层视觉，以确保不管多密集的节点在缩放时也不会对用户造成视觉灾难，且隐藏层级的关系边能减少绝大多数情况下的渲染计算：

- **Min / Max Zoom**: `[0.20, 1.2]` (在此范围内滑动滚轮，保障极小比例不破图，最大平级不越界)
- **L0 (Ultra-far)**: `Zoom < 0.4`
  - 显示模式：上帝全景视角。
  - 节点大小：Note Node 收缩为 `16x16` 像素（极简点阵），Folder 中心节点收缩为 `24x24`（集线器）。
  - 连接边显示：隐藏 (`lod < 3`)，极大缓解计算量和画面混乱。
- **L1 (Far)**: `0.4 <= Zoom < 0.6`
  - 节点大小恢复到极简胶囊 (Minimal Pill)。
- **L2 (Mid)**: `0.6 <= Zoom < 0.8`
  - 节点展现完整的 Label Card 和预览。
- **L3 (Near)**: `Zoom >= 0.8`
  - 最高细节：完整详情展开、标签渲染；并**恢复所有线段 (Relation Edges) 的渲染**。

## 2. 空间宇宙坐标重载 (Spatial Bounds)
为了让 `Min Zoom: 0.2` 这个缩放级别刚好能框住全局图谱（无需手动去拖动平移），调整了底层大地图网格的绝对单位，从旧的 `10000` 降为 `5000`，物理间距瞬间收缩 100%。

- **网格物理分布 (MapLayout)：**
  - `yTop`: 875
  - `yBot`: 1625
  - `xLeft`: 833
  - `xRight`: 1666
- **坐标偏移补偿 (Center Offset)：**
  - 所有节点的独立算法偏移设定为 `CX: 1250, CY: 1250`，强制将整个物理宇宙置中对齐坐标中心点 `(0, 0)`。

## 3. 背景大区渲染防剔除与重对齐 (ViewBox Culling Strategy)
我们遇到了一个由 ReactFlow `<ReactFlow />` 引擎底层渲染逻辑引发的 Bug：底层 PARA 区域在平移鼠标时经常全部消失或大字错位。
- **病因**：如果给背景节点设 `position: absolute`，ReactFlow 获取到的原始包裹尺寸会变成 `0x0`，一但离开物理屏幕中心一点，ReactFlow 就会为了节省内存激进地卸载 (Unmount) 这个底层大区。
- **最终校准参数**：
  - **Node Position (起始点)**：在初始化图谱时强行安插于极遥远的西北角： `position: { x: -10000, y: -10000 }`。
  - **原生体积支撑 (Native Dimensions)**：给包裹的 div 直接打上暴力的死规定宽高：`width: 12500, height: 12500`。以确保该节点在绝大部分极限缩放与平移中永远被包含在 ReactFlow 的视窗追踪内。
  - **坐标扭转魔法 (viewBox Mapping)**：配套内建 `<svg viewBox="-3750 -3750 12500 12500">` 强制把绘图的绝对 `0,0` 中点死死锚定到真正的新架构空间中点。

## 4. 水印文本防出界视觉 (Watermark Anchors)
通过空间坐标重载后，原本的 watermark ("PROJECTS" 等) 飘在了极限 `Zoom: 0.2` 下的浏览器纵向画框之外。
- **校准结果**：
  - PROJECTS: `ty: D.yTop - 450`（将其从绝对物理极限高处往下拉，紧贴在 Project 绿点节点的头顶，保持安全可视领域）。
  - INBOX: `ty: D.yBot + 90`（由于笔记本屏幕宽高比原因，下方并未越界，保留不动）。

## 5. ReactFlow 高频状态隔离防抖 (High-frequency Rerenders Isolation)
修复了原由于监控跟踪当前实时缩放率 (`currentZoom`) 而引发的极度卡顿：
- 摒弃了将 `currentZoom` 放进主图谱 Component `useState` 的危险操作（该操作会导致每次鼠标滚轮的 1 像素移动都在刷新全场超过 300 个节点的 VDOM DOM）。
- 改为使用一个纯隔离的局部微型探针组件 `<ZoomDebugger />`，内置挂载 `@xyflow/react` 提供的 `useStore((s) => s.transform[2])` 来订阅缩放，做到了真正的零重绘防卡顿体验。
