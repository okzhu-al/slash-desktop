# Slash MarkItDown Sidecar

基于 [Microsoft MarkItDown](https://github.com/microsoft/markitdown) 的文件解析微服务。

将各种文件格式转换为 Markdown，供 Slash 笔记系统导入和处理。

## 支持格式

| 类别 | 格式 |
|------|------|
| 文档 | PDF, Word (.docx/.doc), PowerPoint (.pptx), Excel (.xlsx/.xls) |
| 标记 | HTML, CSV, JSON, XML, Markdown |
| 媒体 | JPEG/PNG (EXIF), WAV/MP3 (语音转录) |
| 其他 | ZIP (递归解析), EPUB |

## 快速开始

### 本地运行

```bash
cd apps/python-sidecar
pip install -r requirements.txt
python -m app.main
```

服务运行在 `http://localhost:3722`

### Docker 运行

```bash
docker build -t slash-markitdown .
docker run -p 3722:3722 slash-markitdown
```

## API

### `GET /health`

健康检查。

### `GET /formats`

返回支持的格式列表。

### `POST /parse`

上传文件并转换为 Markdown。

```bash
curl -F "file=@document.pdf" http://localhost:3722/parse
```

响应：

```json
{
  "filename": "document.pdf",
  "markdown": "# Document Title\n\n...",
  "size": 12345,
  "elapsed_ms": 230
}
```
