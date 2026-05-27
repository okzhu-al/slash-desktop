# OPT-05/06 阶段四 + 阶段五：Zero-Shot 本地转写 + Embedding 多媒体语义织网 — 研发执行指令

> **签发**: 架构师  
> **日期**: 2026-04-28  
> **前置依赖**: 阶段零 ✅ + 阶段一 ✅ + 阶段二+三 ✅（Sidecar 路径直读已通）  
> **预计工作量**: 中等  
> **交付范围**: Sidecar 转写引擎替换 + Rust Embedding 管线增强

---

## 一、项目背景

### 当前现状

1. **音频/视频转写**：Sidecar 使用 `speech_recognition` 库 + Google Web Speech API（`recognize_google`），存在三个致命问题：
   - **依赖外网**：Google API 需要互联网连接，离线完全不可用
   - **Monkey Patch 脆弱**：通过 `contextvars` + 运行时替换 `recognize_google` 实现多语言，代码晦涩且易碎
   - **精度差**：Google Web Speech API 为免费层，对中文长音频识别率极低

2. **Embedding 语义盲区**：当前 `trigger_ai_skill`（`skills.rs` 第 148 行）只对 Markdown 纯文本做 Embedding：
   ```rust
   let embedding = service.generate_embedding(&content).await;
   ```
   笔记中嵌入的 `![](assets/xxx.mp4)` 或 `![](assets/xxx.png)` 完全被忽略——AI 搜索和 GhostLink 对多媒体笔记"看不见"。

### 阶段二+三的基建成果

Sidecar `/parse` 端点已支持 **路径直读模式**：
```json
POST /parse
Content-Type: application/json
{ "local_path": "/Users/xxx/vault/assets/video.mp4", "filename": "video.mp4" }
```
Sidecar 直接通过 `Path(local_path).read_bytes()` 系统级读取，无 HTTP 传输开销。**这正是阶段五 Rust Embedding 调用 Sidecar 的基础**。

---

## 二、阶段四：Zero-Shot 本地转写引擎

### 2.1 目标

用 `faster-whisper`（CTranslate2 加速的 Whisper）替换 `speech_recognition` + Google API：
- **纯离线**：不依赖外网
- **多语种自动检测**：不传 `language` 参数，模型自动识别语种
- **精度飞跃**：Whisper tiny 模型在中英文混合场景下远优于 Google Web Speech API

### 2.2 改动清单

#### 2.2.1 `requirements.txt` — 新增依赖

```diff
 markitdown[all]
 markdownify<0.14
 fastapi>=0.115
 uvicorn[standard]>=0.34
 python-multipart>=0.0.18
 openai>=1.50.0
 youtube-transcript-api
+faster-whisper>=1.1.0
```

#### 2.2.2 `main.py` — 替换转写引擎

**删除**：第 38-64 行的全部 Monkey Patch 代码块：
```python
# 删除整个 speech_recognition monkey patch 块
# 从 "import contextvars" 到 "print("[WARN] speech_recognition not found...")"
```

**新增**：在 `md = MarkItDown(enable_plugins=True)` 之前，添加 faster-whisper 单例初始化：

```python
# ── faster-whisper 离线转写引擎（懒加载单例）──
_whisper_model = None

def get_whisper_model():
    """懒加载 WhisperModel，首次调用时初始化"""
    global _whisper_model
    if _whisper_model is None:
        from faster_whisper import WhisperModel
        _whisper_model = WhisperModel("tiny", device="cpu", compute_type="int8")
        print("[INFO] faster-whisper 'tiny' model loaded (cpu/int8)")
    return _whisper_model

# 音视频文件扩展名集合
AUDIO_VIDEO_EXTENSIONS = {"mp3", "wav", "mp4", "avi", "m4a", "mkv", "mov", "webm", "flac", "ogg"}
```

**修改**：在 `/parse` 端点的 `convert_stream` 调用之前，插入音视频分流逻辑：

```python
        # ── 音视频分流：使用 faster-whisper 本地转写 ──
        if ext in AUDIO_VIDEO_EXTENSIONS:
            f.write(f"[DEBUG] 检测到音视频文件 (.{ext})，启动 faster-whisper 转写...\n")
            try:
                model = get_whisper_model()
                # 写临时文件（faster-whisper 需要文件路径）
                import tempfile
                with tempfile.NamedTemporaryFile(suffix=f".{ext}", delete=False) as tmp:
                    tmp.write(content)
                    tmp_path = tmp.name
                
                segments, info = model.transcribe(tmp_path, beam_size=5)
                detected_lang = info.language
                f.write(f"[DEBUG] 检测到语言: {detected_lang} (概率: {info.language_probability:.2f})\n")
                
                transcript_parts = []
                for segment in segments:
                    transcript_parts.append(segment.text.strip())
                
                # 清理临时文件
                import os
                os.unlink(tmp_path)
                
                markdown_text = "\n".join(transcript_parts) if transcript_parts else ""
                
                if not markdown_text:
                    markdown_text = "> [!NOTE]\n> 音频/视频语音内容提取结束：未检测到可识别的清晰人声或语音片段。\n"
                else:
                    markdown_text = f"> **语言**: {detected_lang}\n\n{markdown_text}"
                
                f.write(f"[DEBUG] faster-whisper 转写完成，文本长度: {len(markdown_text)}\n")
                
            except Exception as e:
                import traceback
                f.write(f"[ERROR] faster-whisper 转写异常:\n{traceback.format_exc()}\n")
                markdown_text = "> [!NOTE]\n> 音频/视频语音内容提取结束：转写引擎异常。\n"
            
            elapsed_ms = int((time.monotonic() - start) * 1000)
            f.write(f"[DEBUG] 全部完成，耗时 {elapsed_ms} ms ===\n\n")
            
            # 直接返回，不走 MarkItDown 的 convert_stream
            return ParseResponse(
                filename=file.filename,
                markdown=markdown_text,
                size=len(content),
                elapsed_ms=elapsed_ms,
            )
        
        # ── 非音视频文件：走原有 MarkItDown 通道 ──
        # (原有 processing_md.convert_stream 逻辑保持不变)
```

**关键设计**：
- `start = time.monotonic()` 应在分流之前（保持现有位置）
- 音视频文件走 faster-whisper 后 **直接 return**，不进入 `convert_stream`
- 非音视频文件（PDF/Word/Excel/图片等）走原有 MarkItDown 通道，零影响

#### 2.2.3 `Dockerfile` — 无需改动

`ffmpeg` 已在 Dockerfile 中安装（第 11 行），faster-whisper 依赖的音频解码器已就绪。`faster-whisper` 本身通过 `pip install` 安装 CTranslate2 CPU 版本，无需额外系统包。

#### 2.2.4 清理 `audio_lang_ctx`

Monkey Patch 删除后，`audio_lang_ctx` 上下文变量不再被 speech_recognition 使用。但 `/parse` 端点仍接收 `audio_lang` 参数（前端可能传来）。

**保留** `audio_lang` 参数的接收，但不再设置 `audio_lang_ctx`。faster-whisper 自动检测语言，不需要外部指定。在日志中记录前端传来的 `audio_lang` 仅作参考：

```python
    # audio_lang 仅作日志参考，faster-whisper 自动检测语言
    if audio_lang:
        f.write(f"[DEBUG] 前端请求语言偏好: {audio_lang} (faster-whisper 将自动检测)\n")
```

---

## 三、阶段五：Rust Embedding 多媒体语义织网

### 3.1 目标

在 `trigger_ai_skill` 的 Embedding 生成流程中，扫描笔记内容中的多媒体引用，调用 Sidecar `/parse` 获取 OCR/转写文本，将其融合到 Embedding 输入中。

### 3.2 数据流

```
笔记内容: "## 会议记录\n![](assets/abc123.mp4)\n讨论了Q2目标..."
              ↓ 正则提取
      资产路径: ["assets/abc123.mp4"]
              ↓ 组装绝对路径
      绝对路径: "/Users/xxx/vault/assets/abc123.mp4"
              ↓ HTTP POST to Sidecar /parse (JSON 路径模式)
      转写文本: "大家好，今天讨论Q2的OKR..."
              ↓ Append 到原始内容
      超级文本: "## 会议记录\n讨论了Q2目标...\n\n---\n[Media: abc123.mp4]\n大家好，今天讨论Q2的OKR..."
              ↓ generate_embedding(&super_content)
      融合向量: [0.12, -0.34, ...]
```

### 3.3 改动清单

#### 3.3.1 `skills.rs` — Embedding 前注入多媒体语义

**文件**: `apps/desktop/src-tauri/src/commands/ai/skills.rs`

在第 147 行 `let embedding = if should_embed {` 之前，插入多媒体语义提取逻辑：

```rust
            // ── OPT-06: 多媒体语义织网 ──
            // 扫描笔记中的资产引用，调用 Sidecar 提取 OCR/转写文本
            let enriched_content = {
                let media_regex = regex::Regex::new(r"!\[.*?\]\((assets/[^)]+)\)").unwrap();
                let mut media_texts: Vec<String> = Vec::new();
                
                for cap in media_regex.captures_iter(&content) {
                    let asset_rel_path = &cap[1];
                    let asset_abs_path = std::path::Path::new(&vault_path_str).join(asset_rel_path);
                    
                    if !asset_abs_path.exists() {
                        log::warn!("⚠️ [MediaEmbed] Asset not found: {}", asset_abs_path.display());
                        continue;
                    }
                    
                    // 提取文件名和扩展名
                    let filename = asset_abs_path.file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("unknown");
                    
                    log::error!("🎬 [MediaEmbed] Extracting semantic from: {}", filename);
                    
                    // 调用 Sidecar /parse（路径直读模式）
                    match reqwest::Client::new()
                        .post("http://localhost:3722/parse")
                        .json(&serde_json::json!({
                            "local_path": asset_abs_path.to_string_lossy(),
                            "filename": filename
                        }))
                        .timeout(std::time::Duration::from_secs(120))
                        .send()
                        .await
                    {
                        Ok(resp) if resp.status().is_success() => {
                            if let Ok(body) = resp.json::<serde_json::Value>().await {
                                if let Some(md_text) = body["markdown"].as_str() {
                                    if !md_text.is_empty() {
                                        media_texts.push(format!(
                                            "\n---\n[Media: {}]\n{}",
                                            filename,
                                            md_text.chars().take(2000).collect::<String>()
                                        ));
                                        log::error!("✅ [MediaEmbed] Got {} chars from {}", md_text.len(), filename);
                                    }
                                }
                            }
                        }
                        Ok(resp) => {
                            log::warn!("⚠️ [MediaEmbed] Sidecar returned {}: {}", resp.status(), filename);
                        }
                        Err(e) => {
                            log::warn!("⚠️ [MediaEmbed] Sidecar request failed for {}: {}", filename, e);
                        }
                    }
                }
                
                if media_texts.is_empty() {
                    content.clone()
                } else {
                    log::error!("🧬 [MediaEmbed] Enriched content with {} media extractions", media_texts.len());
                    format!("{}{}", content, media_texts.join(""))
                }
            };
```

然后将第 148 行改为使用 `enriched_content`：

```rust
            let embedding = if should_embed {
                match service.generate_embedding(&enriched_content).await {
```

#### 3.3.2 `Cargo.toml` — 确认依赖

**文件**: `apps/desktop/src-tauri/Cargo.toml`

确认以下依赖存在（`skills.rs` 使用了 `regex` 和 `reqwest`）：

```toml
regex = "1"
reqwest = { version = "0.12", features = ["json"] }
```

> 这两个依赖大概率已存在于项目中。请先 `grep` 确认，如果缺失再添加。

### 3.4 关键设计决策

1. **超时 120 秒**：大型视频文件的 faster-whisper 转写可能需要较长时间。120 秒是合理上限。
2. **文本截断 2000 字符**：转写文本可能很长，取前 2000 字符足以携带语义，避免 Embedding 输入过大。
3. **静默失败**：Sidecar 请求失败时 `log::warn` 但不阻塞。Embedding 仍使用原始文本生成——降级而非崩溃。
4. **仅图片和音视频**：正则 `!\[.*?\]\((assets/[^)]+)\)` 匹配 Markdown 图片/音视频语法。不匹配 `[link](file)` 的文件附件链接。

---

## 四、不需要修改的文件

| 文件 | 原因 |
|:---|:---|
| `ImportService.ts` | 前端导入逻辑不变，Sidecar 返回格式一致 |
| `clipboardHandlers.ts` | 拖拽/粘贴逻辑不变 |
| `MediaService.ts` | 资产落盘逻辑不变 |
| `negotiate.rs` / `push.rs` | 同步管线不受影响 |
| `capabilities.ts` | 体积限制逻辑不变 |

---

## 五、验收条件

### 阶段四验证

1. **离线转写**：断网状态下，通过 ImportHub 导入一个包含中文语音的 `.mp3` 文件 → 成功返回中文转写文本
2. **自动语种检测**：导入一个英文 `.wav` 文件 → 返回英文转写，不需要手动选择语言
3. **兼容降级**：导入一个纯音乐 `.mp3`（无人声）→ 返回 `> [!NOTE]` 提示，不崩溃
4. **非音频不受影响**：导入 PDF/Word/Excel → 走原有 MarkItDown 通道，结果不变
5. **Monkey Patch 清除**：`main.py` 中不再有 `speech_recognition` 相关代码

### 阶段五验证

6. **语义融合**：创建一个笔记，插入一个含语音的视频 → 触发 AI Skill（on_idle/on_blur）→ 查看 SQLite `embeddings_v2` 表，确认生成了 Embedding
7. **GhostLink 增强**：笔记 A 有一个"Q2 OKR 讨论"的视频，笔记 B 文字内容提到"Q2 OKR 目标" → GhostLink 应将 A 和 B 关联
8. **Sidecar 不可用时降级**：停止 Sidecar 容器 → 触发 AI Skill → Embedding 仍基于纯文本生成，无报错
9. **编译通过**：`cargo check` + TypeScript 无新增错误

---

## 六、Docker 重建提醒

阶段四涉及 Sidecar 的 `requirements.txt` 和 `main.py` 改动，完成后需要重建：

```bash
docker compose build sidecar && docker compose up -d sidecar
```

> **注意**：`faster-whisper` 首次安装会下载 CTranslate2 二进制（约 100MB），Docker 构建时间会增加。模型权重（`tiny` ≈ 75MB）在首次调用 `get_whisper_model()` 时自动下载。
