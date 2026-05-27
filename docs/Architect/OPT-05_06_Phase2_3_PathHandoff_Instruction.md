# OPT-05/06 阶段二 + 阶段三：Path-based Handoff + Sidecar 路径直读 — 研发执行指令

> **签发**: 架构师  
> **日期**: 2026-04-28  
> **前置依赖**: 阶段零 ✅ + 阶段一 ✅  
> **预计工作量**: 中等偏轻  
> **注意**: 阶段二和三是配套改造，合并为一次交付

---

## 一、项目背景

Slash 桌面应用中，用户通过 Drag、Paste、ImportHub 三种途径将多媒体文件引入笔记。阶段一已将体积限额从硬编码 50MB 升级为 Admin 动态配置（最高 10GB）。

**但限额放开后，大文件实际进来会崩溃**，因为当前链路存在两个内存爆炸点：

### 爆炸点 1：前端 → Rust（MediaService.saveAsset）

```
clipboardHandlers.ts
  → file.arrayBuffer()          ← 80MB 文件整体加载到 WebView 内存
  → new Uint8Array(arrayBuffer)  ← 再复制一份
  → Array.from(uint8Array)       ← 再转为 JS Array（3 倍膨胀）
  → invoke('save_asset', { fileData: [...] })  ← JSON 序列化传输
```

一个 80MB 文件在这条路径上会消耗 ~240MB WebView 内存。

### 爆炸点 2：前端 → Sidecar（ImportService.importFile）

```
ImportService.ts
  → readFile(filePath)           ← Tauri readFile 整体加载到 WebView
  → new Blob([fileData])         ← 再包装一次
  → FormData.append(blob)        ← HTTP 传输整个 body
  → Sidecar: file.read()         ← Python 侧再全量读一次
```

一个 80MB 视频在这条路径上会在前端和 Sidecar 各消耗 80MB。

---

## 二、改造目标

### 阶段二：前端 OOM 根治

**核心原则**：文件始终以 **路径** 形式流转，前端永不加载二进制内容到 WebView 内存。

### 阶段三：Sidecar 路径直读

**核心原则**：Sidecar 收到**本地绝对路径**，直接通过系统 I/O 读取文件，绕过 HTTP 上传。

---

## 三、当前代码分析

### 3.1 Drag 入口（clipboardHandlers.ts 第 96-114 行）

```typescript
// 当前逻辑
if (filePath) {
    relativePath = await mediaService.saveAssetFromPath(filePath);  // ✅ 已走路径
} else {
    relativePath = await mediaService.saveAsset(file, false);       // ❌ 走内存
}
```

**分析**：Drag 入口在 Tauri 环境下，`(file as any).path` 通常有值，**已经走 `saveAssetFromPath`**（零拷贝路径）。`else` 分支是兜底（理论上不会命中）。**此入口无需改动**。

### 3.2 Paste 入口（clipboardHandlers.ts 第 352-369 行）

```typescript
if (path) {
    relativePath = await mediaService.saveAssetFromPath(path);  // ✅ 已走路径
} else {
    relativePath = await mediaService.saveAsset(file, false);   // ❌ 走内存（截图粘贴等）
}
```

**分析**：与 Drag 相同。`else` 分支仅在**系统截图粘贴**时命中（此时 `file` 来自剪贴板 DataTransfer，没有磁盘路径，且通常 < 5MB）。**此入口无需改动**。

### 3.3 ImportHub 入口（ImportService.ts 第 41-80 行）— 🔴 核心改造点

```typescript
// 当前逻辑
const fileData = await readFile(filePath);                    // ← 整个文件读进 WebView
const blob = new Blob([fileData], { type: ... });             // ← 内存翻倍
formData.append('file', blob, fileName);                      // ← HTTP body 三倍
const resp = await fetch(`${SIDECAR_URL}/parse`, { body: formData });
```

**这是唯一真正的 OOM 爆炸点**：
- ImportHub 导入的是 PDF/Word/Excel/视频等文件，通常 5MB~500MB
- `readFile` 把整个文件加载到 WebView
- 然后通过 HTTP FormData 传给运行在 Docker 中的 Python Sidecar
- Sidecar 再全量 `await file.read()`

### 3.4 MediaService.saveAsset（MediaService.ts 第 29-50 行）— ⚠️ 次要改造点

```typescript
const arrayBuffer = await file.arrayBuffer();     // ← 内存加载
const uint8Array = new Uint8Array(arrayBuffer);   // ← 复制
invoke('save_asset', { fileData: Array.from(uint8Array) }); // ← JSON 序列化爆炸
```

此方法仅在 Drag/Paste 的 `else` 分支命中（无路径的剪贴板粘贴），文件通常很小（截图 < 5MB）。**优先级低，可暂不改造**。

---

## 四、详细改动

### 4.1 ImportService.ts — 路径透传改造（阶段二核心）

**文件**: `apps/desktop/src/services/ImportService.ts`

将 `importFile` 方法从"读取文件→上传 Blob"改为"传路径→Sidecar 自己读"。

**改造后**：
```typescript
async importFile(
    filePath: string,
    vaultPath: string,
    llmConfig?: { baseUrl: string; apiKey?: string; model: string },
    audioLang?: string,
    appLang?: string
): Promise<string> {
    const fileName = filePath.split('/').pop() || 'imported';
    const baseName = fileName.replace(/\.[^.]+$/, '');
    const ext = fileName.split('.').pop()?.toLowerCase() || '';

    // ── 改造：不再 readFile，改为 JSON 传路径 ──
    const payload: Record<string, string> = {
        local_path: filePath,       // 新增：本地绝对路径
        filename: fileName,         // 仍需告知 Sidecar 文件名（用于判断扩展名）
    };
    if (llmConfig) {
        payload.base_url = llmConfig.baseUrl;
        if (llmConfig.apiKey) payload.api_key = llmConfig.apiKey;
        payload.llm_model = llmConfig.model;
    }
    if (audioLang) payload.audio_lang = audioLang;
    if (appLang) payload.app_lang = appLang;

    const resp = await fetch(`${SIDECAR_URL}/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    // ... 后续 response 处理保持不变
}
```

**关键变化**：
1. 删除 `readFile(filePath)` — 前端零内存开销
2. 删除 `new Blob()` 和 `FormData` — 无 HTTP body 膨胀
3. 改为 `JSON POST` 传 `local_path` — 几十字节的路径字符串
4. 不再需要 `import { readFile } from '@tauri-apps/plugin-fs'`（如果此文件中其他地方不再使用的话，可以清理）

### 4.2 Sidecar `/parse` 端点 — 双模兼容改造（阶段三核心）

**文件**: `apps/python-sidecar/app/main.py`

将 `/parse` 端点改为支持两种输入模式：
1. **路径模式**（新）：收到 `local_path` → 直接 `open(path, "rb")` 读取
2. **上传模式**（兼容保留）：收到 `FormData` 的 `file` → 原有逻辑不变

**改造后**：

```python
from fastapi import FastAPI, File, UploadFile, HTTPException, Form, Request

@app.post("/parse", response_model=ParseResponse)
async def parse(request: Request):
    """
    双模解析：
    1. JSON 模式（路径直读）：{ "local_path": "/path/to/file", "filename": "test.pdf", ... }
    2. FormData 模式（上传兼容）：file=@test.pdf
    """
    content_type = request.headers.get("content-type", "")
    
    if "application/json" in content_type:
        # ── 路径直读模式 ──
        body = await request.json()
        local_path = body.get("local_path")
        filename = body.get("filename")
        
        if not local_path or not filename:
            raise HTTPException(400, detail="local_path 和 filename 为必填项")
        
        path = Path(local_path)
        if not path.exists():
            raise HTTPException(400, detail=f"文件不存在: {local_path}")
        if not path.is_file():
            raise HTTPException(400, detail=f"路径不是文件: {local_path}")
        
        ext = path.suffix.lower().lstrip(".")
        if ext not in SUPPORTED_FORMATS:
            raise HTTPException(415, detail=f"不支持的格式: .{ext}")
        
        # 直接从磁盘读取，绕过 HTTP 传输
        content = path.read_bytes()
        file_size = len(content)
        
        # 提取其他可选参数
        base_url = body.get("base_url")
        api_key = body.get("api_key")
        llm_model = body.get("llm_model")
        audio_lang = body.get("audio_lang")
        app_lang = body.get("app_lang")
        
    else:
        # ── FormData 上传兼容模式（保持原逻辑）──
        form = await request.form()
        file: UploadFile = form.get("file")
        if not file or not file.filename:
            raise HTTPException(400, detail="缺少文件")
        
        filename = file.filename
        ext = Path(filename).suffix.lower().lstrip(".")
        if ext not in SUPPORTED_FORMATS:
            raise HTTPException(415, detail=f"不支持的格式: .{ext}")
        
        content = await file.read()
        file_size = len(content)
        
        base_url = form.get("base_url")
        api_key = form.get("api_key")
        llm_model = form.get("llm_model")
        audio_lang = form.get("audio_lang")
        app_lang = form.get("app_lang")
    
    if not content:
        raise HTTPException(400, detail="文件为空")
    
    # ── 以下为原有的解析逻辑，完全不变 ──
    if audio_lang:
        audio_lang_ctx.set(audio_lang)
    else:
        audio_lang_ctx.set("zh-CN")
    
    # ... 原有的 MarkItDown 处理逻辑 ...
```

**关键设计**：
1. 通过 `Content-Type` 头自动区分两种模式
2. 路径模式下 `path.read_bytes()` 是系统级 I/O，不经过 HTTP buffer
3. FormData 模式**完整保留**，确保向后兼容和未来远程调用场景

### 4.3 Docker 挂载验证

**文件**: `docker-compose.yml`

Sidecar 容器需要能访问宿主机的 Vault 目录。确认已有挂载：

```yaml
sidecar:
  volumes:
    - ${VAULT_PATH}:/data/vault   # 确保 Sidecar 能读取 Vault 文件
```

> **⚠️ 关键**：如果 Sidecar 运行在 Docker 中，`local_path` 是宿主机路径，Sidecar 内部看不到。有两种解法：
> 
> **方案 A（推荐）**：前端传路径时，将宿主机路径映射为容器内路径。例如宿主机 `/Users/alice/vault/assets/xxx.pdf` → 容器内 `/data/vault/assets/xxx.pdf`。需要客户端知道映射规则。
> 
> **方案 B**：Sidecar 不走 Docker，直接在宿主机跑（`pip install` 本地运行）。此时路径天然可达。
> 
> **实际情况**：Slash 的 Sidecar 目前是否运行在 Docker 中？请检查 `docker-compose.yml`，如果 Sidecar 和桌面客户端在同一宿主机上运行（Tauri 桌面应用），那么路径天然可达，无需映射。

---

## 五、不需要修改的文件

| 文件 | 原因 |
|:---|:---|
| `clipboardHandlers.ts` | Drag/Paste 已走 `saveAssetFromPath`（路径模式），`else` 分支仅用于小型截图 |
| `MediaService.saveAsset` | 仅剪贴板截图命中（< 5MB），不是 OOM 根因 |
| `MediaService.saveAssetFromPath` | 已经是零拷贝路径传输，不需要改 |
| `assets.rs` | Rust 侧落盘逻辑与 OOM 无关 |
| `negotiate.rs` / `push.rs` | 同步管线不受影响 |

---

## 六、验收条件

1. **OOM 消除**：通过 ImportHub 导入一个 100MB 视频文件 → 不崩溃，WebView 内存增量 < 10MB
2. **Sidecar 路径直读**：Sidecar 日志中显示 `[PATH MODE]` 而非 `FormData`，解析正常完成
3. **FormData 兼容**：手动发送 `curl -F "file=@test.pdf" http://localhost:3722/parse` → 仍正常工作
4. **小文件不受影响**：剪贴板粘贴截图（< 5MB）→ 正常插入，走原有内存路径
5. **编译通过**：`npm run typecheck` + `cargo check` 通过
6. **Docker 挂载**：如果 Sidecar 在 Docker 中运行，确认路径映射正确

---

## 七、注意事项

- `readFile` 的 import 如果在 `ImportService.ts` 中不再被使用，应清理掉
- Sidecar 的 `/parse` 端点签名从 `file: UploadFile = File(...)` 改为 `request: Request`，这是 FastAPI 的 raw request 模式，需要手动解析
- 路径安全校验：Sidecar 端建议检查路径是否在预期目录下（防止路径穿越），但此为加固项，不阻塞主流程
- 修改完成后请撰写简要报告放在 `docs/Developer/OPT-05_06_Phase2_3_Report.md`
