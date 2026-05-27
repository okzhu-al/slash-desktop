# OPT-05/06 阶段二 & 三: Path-based Handoff 与 Sidecar 路径直读改造报告

**日期**: 2026-04-28  
**目标**: 根治大文件导入时的 OOM 问题，优化前后端内存消耗。

## 1. 改造内容

### 1.1 前端：`ImportService.ts` 零内存读取改造
- **移除二进制读取**: 完全移除了 `readFile(filePath)` 操作，前端不再将文件整体读入 WebView 内存。
- **废弃 Blob 与 FormData**: 删除了原有的 HTTP `multipart/form-data` 构建过程，避免内存使用量翻三倍。
- **改用 JSON 载荷**: `importFile` 接口现在仅通过 `application/json` 发送 `{ "local_path": "/...", "filename": "..." }` 等纯文本配置，流量消耗降低至几十字节。
- **清理无用代码**: 移除了无用的 `readFile` 导入和不再被使用的 `getMimeType` 私有方法。

### 1.2 后端：`apps/python-sidecar/app/main.py` 双模兼容改造
- **重构 `/parse` 端点**: 移除了原本仅支持 `UploadFile` 的签名，改为直接读取 `Request` 对象。
- **JSON 路径直读模式 (`application/json`)**:
  - 当检测到 JSON 头时，解析 `local_path`。
  - 进行安全性及有效性校验（如 `path.exists()` 和 `path.is_file()`）。
  - 直接调用操作系统 I/O `path.read_bytes()` 读取文件，**绕过 HTTP 上传层**，杜绝 HTTP Body 带来的额外内存开销。
- **FormData 兼容模式 (`multipart/form-data`)**:
  - 保留了对 `curl` 脚本或旧版调用的向下兼容。
  - 提取 `request.form()` 里的 `file` 进行和原来一模一样的处理逻辑。
- **日志兼容**: 通过注入模拟的 `_FileMock` 对象，使 JSON 模式能够兼容原有依赖 `file.filename` 的 `[DEBUG]` 日志输出机制。

## 2. 验证结果
1. **编译检查**: 运行 `npm run typecheck` 和 `cargo check` 均通过（前端 `getMimeType` 等废弃函数已被清理，无相关报错）。
2. **逻辑一致性**: 重构了请求入口分流逻辑，但完整的 `MarkItDown` 解析、LLM 视觉调用逻辑 (`client = OpenAI(...)`) 与音频处理环境 (`audio_lang_ctx`) 全部原封不动保留，规避了核心业务倒退风险。

## 3. 注意事项 (Docker 挂载)
此方案依赖**本地绝对路径**传递。正如设计中所假设，若 Sidecar 在 macOS 宿主机上原生运行，系统路径天然互通；**若 Sidecar 部署于 Docker 容器中**，Tauri 传来的宿主机路径（例如 `/Users/xxx/...`）将触发 Sidecar 的 `文件不存在` HTTP 400 异常。届时必须在 `docker-compose.yml` 中配置相应的 `- ${HOME}:${HOME}:ro` 等路径透传规则，或直接在原生环境启动 Sidecar 进行无缝对接。
