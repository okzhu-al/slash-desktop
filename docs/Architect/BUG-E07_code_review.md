# BUG-E07 代码审查结论

**审查时间**：2026-04-21 22:33  
**审查对象**：开发同学的 BUG-E07 修复实现  
**编译状态**：✅ Rust 客户端 / ✅ Rust 服务端 / ✅ TypeScript 前端 — 三端全部通过

---

## 逐项对照验收

| 修复点 | 指令要求 | 实际实现 | 判定 |
|--------|---------|---------|------|
| **Fix 1** — `handleAdminDeleteDir` 本地清理 | 物理删除 + unified_state 清理 | ✅ 第 150-199 行，`remove(physPath, { recursive: true })` + JSON 状态清理，case-insensitive 匹配 | **通过** |
| **Fix 1b** — `handleAdminDeleteFile` 本地清理 | 单文件物理删除 + unified_state 清理 | ✅ 第 65-102 行，`remove(physPath)` + JSON 状态清理 | **通过** |
| **Fix 2** — `detect_team_deleted` PARA 根回退 | `reverse_mappings` 失败时用 PARA 根映射 | ✅ 第 953-971 行，使用 `PARA_TEAM_TO_PERSONAL` 回退 | **通过** |
| **Fix 3** — negotiate Step 4 放宽条件 | `client_has_file \|\| dir_unmatched` | ✅ 第 547-554 行，准确实现了双条件放宽 | **通过** |
| **Fix 4** — 空壳目录递归清理 | `server_deleted` 后向上溯源清理空目录 | ✅ 第 409-433 行，`while dir > *root` 循环 | **通过** |

---

## 发现的问题

### ⚠️ 问题 1：useCallback 依赖数组缺少 `rootDir`（非阻塞）

两个 `useCallback` 都使用了闭包中的 `rootDir`，但依赖数组中没有声明：

```
第 124 行: }, [t, refreshTeamData, resolveTeamToPhysicalPaths, onNoteDeleted]);
                                                                  ↑ 缺少 rootDir

第 236 行: }, [t, refreshTeamData, removeMapping, resolveTeamToPhysicalPaths, onNoteDeleted]);
                                                                               ↑ 缺少 rootDir
```

**风险评估**：`rootDir` 在组件生命周期内基本不变（来自 vault 根路径），实际不会引发 stale closure 问题。但 React 规范上应补全。

**建议**：两处依赖数组均追加 `rootDir`。

### ⚠️ 问题 2：`handleAdminDeleteFile` 存在变量名遮蔽（非阻塞）

```typescript
// 第 66 行
const physPaths = resolveTeamToPhysicalPaths(filePath);

// 第 113 行（在同一个 try block 内再次声明）
const physPaths = resolveTeamToPhysicalPaths(filePath);
```

同一个 `try` 块内用 `const` 声明了两次 `physPaths`。TypeScript 编译器因为作用域隔离（if 块 vs 外层）允许了这个写法，但可读性差。第二次声明是原有代码（tab 关闭用），可复用第一次的结果。

**建议**：删除第 113 行的重复声明，直接复用第 66 行的 `physPaths`。

---

## 最终判定

> **✅ 修复通过，可以部署测试。**

四个修复点全部准确按照架构指令实现，核心逻辑正确，双端防线完整。两个小问题都是非阻塞的代码规范问题，不影响功能正确性，可在测试验证后统一清理。
