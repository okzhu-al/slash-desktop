"""
Slash MarkItDown Sidecar — 文件解析微服务

将各种文件格式（PDF、Word、Excel、PPT、HTML、CSV 等）转换为 Markdown。
基于 Microsoft MarkItDown (https://github.com/microsoft/markitdown)

API:
  POST /parse       — 上传文件，返回 Markdown 文本
  GET  /health      — 健康检查
  GET  /formats     — 支持的格式列表
"""

import io
import time
from pathlib import Path

from fastapi import FastAPI, File, UploadFile, HTTPException, Form, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from markitdown import MarkItDown
from openai import OpenAI

import requests

# ── Monkey Patch requests User-Agent ──
# Many websites (e.g. Bilibili) block default python-requests User-Agent and return 412 or 403.
old_request = requests.Session.request

def new_request(self, method, url, **kwargs):
    headers = kwargs.get('headers', {})
    if 'User-Agent' not in headers:
        headers['User-Agent'] = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    kwargs['headers'] = headers
    return old_request(self, method, url, **kwargs)

requests.Session.request = new_request

# ── App ──

import sys
import argparse
import json

def get_sidecar_version() -> str:
    try:
        if hasattr(sys, "_MEIPASS"):
            v_path = Path(sys._MEIPASS) / "version.json"
        else:
            v_path = Path(__file__).parent.parent / "version.json"
        if v_path.exists():
            with open(v_path, "r", encoding="utf-8") as f:
                return json.load(f).get("sidecar_version", "1.0.0")
    except Exception:
        pass
    return "1.0.0"

SIDECAR_VERSION = get_sidecar_version()

import logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] (%(filename)s:%(lineno)d) %(message)s",
    stream=sys.stdout
)
logger = logging.getLogger("slash-sidecar")

import re

def sanitize_sensitive_data(text: str) -> str:
    """
    敏感数据脱敏过滤器：
    自动遮蔽 text 中以 sk- 开头或 AIza 开头的 API Key 格式字符串，
    防范 Traceback 或 Exception 信息在全局共享调试日志中明文暴露。
    """
    if not text:
        return text
    # 遮蔽 OpenAI 格式 sk-... key
    text = re.sub(r"sk-[a-zA-Z0-9]{20,}", "sk-••••••••", text)
    # 遮蔽 Google Gemini 格式 AIza... key
    text = re.sub(r"AIza[a-zA-Z0-9_-]{20,}", "AIza••••••••", text)
    # 遮蔽可能出现的 Bearer sk-...
    text = re.sub(r"Bearer\s+([a-zA-Z0-9_-]{10,})", "Bearer ••••••••", text, flags=re.IGNORECASE)
    return text


def clean_pdf_markdown(text: str) -> str:
    """
    智能 PDF 排版与格式清洗引擎：
    1. 自动过滤物理页码、页眉页脚物理噪声；
    2. 自动根据语义和句尾标点，把因为物理行宽强行折行切碎的行，合并回完整的、具有软换行属性的连贯语义段落（中英文自适应）；
    3. 自动识别和美化 Markdown 缺失的章节标题并加上标题符号前缀；
    4. 压缩由于噪声剔除导致的多余空行。
    """
    if not text:
        return ""
        
    lines = text.split("\n")
    cleaned_lines = []
    
    # 1. 过滤页眉页脚与页码的正则表达式
    page_num_patterns = [
        r"^\s*\d+\s*$",                    # 纯数字页码
        r"^\s*-\s*\d+\s*-\s*$",            # - 1 - 页码
        r"^\s*Page\s+\d+(\s+of\s+\d+)?\s*$", # Page 1 of 10 或 Page 1
        r"^\s*第\s*\d+\s*页\s*$",          # 第 1 页
    ]
    
    compiled_patterns = [re.compile(p, re.IGNORECASE) for p in page_num_patterns]
    
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        is_noise = False
        for pattern in compiled_patterns:
            if pattern.match(line):
                is_noise = True
                break
        if is_noise:
            i += 1
            continue
        cleaned_lines.append(lines[i])
        i += 1

    # 2. 段落物理换行合并
    merged_lines = []
    temp_paragraph = []
    
    for idx, line in enumerate(cleaned_lines):
        stripped = line.strip()
        if not stripped:
            if temp_paragraph:
                merged_lines.append(reconnect_paragraph(temp_paragraph))
                temp_paragraph = []
            merged_lines.append("")
            continue
            
        # 识别是否是新的排版块起点（如标题、列表）
        is_block_start = (
            stripped.startswith("#") or
            stripped.startswith("- ") or
            stripped.startswith("* ") or
            re.match(r"^\d+\.\s+", stripped) or
            re.match(r"^(第[一二三四五六七八九十百]+[章章节回]|\d+(\.\d+)*\s+)", stripped)
        )
        
        if is_block_start:
            if temp_paragraph:
                merged_lines.append(reconnect_paragraph(temp_paragraph))
                temp_paragraph = []
            # 块起始行独立输出，不参与正文段落合并
            merged_lines.append(line)
            continue
            
        is_sentence_end = False
        if stripped:
            last_char = stripped[-1]
            if last_char in "。！？’”；.!?\";":
                is_sentence_end = True
                
        if is_sentence_end:
            temp_paragraph.append(line)
            merged_lines.append(reconnect_paragraph(temp_paragraph))
            temp_paragraph = []
        else:
            temp_paragraph.append(line)
            
    if temp_paragraph:
        merged_lines.append(reconnect_paragraph(temp_paragraph))
        
    text_after_merge = "\n".join(merged_lines)
    
    # 3. 章节标题智能恢复与美化
    lines_for_headers = text_after_merge.split("\n")
    final_lines = []
    for line in lines_for_headers:
        stripped = line.strip()
        if 3 < len(stripped) < 40 and not stripped.endswith((".", "。", "！", "!", "?", "？", ",", "，", ";", "；")):
            if not (stripped.startswith("#") or stripped.startswith(">") or stripped.startswith("-") or stripped.startswith("*")):
                is_header_pattern = (
                    re.match(r"^(第[一二三四五六七八九十百]+[章章节回])", stripped) or
                    re.match(r"^([一二三四五六七八九十百]+[、])", stripped) or
                    re.match(r"^(\d+(\.\d+)*\s+[A-Za-z\u4e00-\u9fa5]+)", stripped) or
                    re.match(r"^(Chapter\s+\d+)", stripped, re.IGNORECASE) or
                    stripped.isupper()
                )
                if is_header_pattern:
                    final_lines.append(f"## {stripped}")
                    continue
        final_lines.append(line)
        
    result = "\n".join(final_lines)
    result = re.sub(r"\n{3,}", "\n\n", result)
    return result.strip()


def reconnect_paragraph(lines: list[str]) -> str:
    """合并段落行并实现中英文换行拼接自适应规则"""
    if not lines:
        return ""
    paragraph = ""
    for idx, line in enumerate(lines):
        line_str = line.strip()
        if not line_str:
            continue
        if not paragraph:
            paragraph = line_str
        else:
            last_char = paragraph[-1]
            first_char = line_str[0]
            # 中文字符范围校验
            is_c_last = '\u4e00' <= last_char <= '\u9fff'
            is_c_first = '\u4e00' <= first_char <= '\u9fff'
            if is_c_last and is_c_first:
                paragraph += line_str
            else:
                # 英文、数字或符号间拼接，自动补回物理换行丢失的空格
                paragraph += " " + line_str
    return paragraph


app = FastAPI(
    title="Slash MarkItDown Sidecar",
    version=SIDECAR_VERSION,
    description="文件 → Markdown 转换微服务（本地嵌入式）",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── faster-whisper 离线转写引擎（可切换模型管理器）──

# HuggingFace 多镜像源（按优先级排序：国内镜像优先，官方兜底）
HF_MIRRORS = [
    "https://hf-mirror.com",
    "https://aifasthub.com",
    "https://huggingface.sukaka.top",
    "https://huggingface.co",
]

# Whisper 模型元信息
WHISPER_MODELS = {
    "tiny":       {"size_mb": 75,   "description": "最快速度，适合简单对话"},
    "base":       {"size_mb": 145,  "description": "平衡速度与质量"},
    "small":      {"size_mb": 488,  "description": "较好质量，适合大多数场景"},
    "medium":     {"size_mb": 1460, "description": "高质量，适合专业转写"},
    "large-v3":   {"size_mb": 3090, "description": "最高质量，需要较多资源"},
}

_whisper_model = None
_current_whisper_model_name = "tiny"
_download_progress = {}  # {model_name: {"progress": 0-100, "status": "downloading|done|error", "error": ""}}

def get_whisper_model():
    """懒加载 WhisperModel，使用当前选中的模型"""
    global _whisper_model, _current_whisper_model_name
    if _whisper_model is None:
        from faster_whisper import WhisperModel
        _whisper_model = WhisperModel(_current_whisper_model_name, device="cpu", compute_type="int8")
        print(f"[INFO] faster-whisper '{_current_whisper_model_name}' model loaded (cpu/int8)")
    return _whisper_model

# 音视频文件扩展名集合
AUDIO_VIDEO_EXTENSIONS = {"mp3", "wav", "mp4", "avi", "m4a", "mkv", "mov", "webm", "flac", "ogg", "wmv", "flv", "aac", "wma"}

md = MarkItDown()

# ── 支持的格式 ──

SUPPORTED_FORMATS = {
    "pdf": "PDF 文档",
    "docx": "Word 文档",
    "doc": "旧版 Word 文档",
    "pptx": "PowerPoint 演示",
    "xlsx": "Excel 表格",
    "xls": "旧版 Excel 表格",
    "csv": "CSV 文件",
    "json": "JSON 文件",
    "xml": "XML 文件",
    "html": "HTML 网页",
    "htm": "HTML 网页",
    "txt": "纯文本",
    "md": "Markdown 文件",
    "epub": "电子书",
    "jpg": "JPEG 图片（EXIF 元数据）",
    "jpeg": "JPEG 图片（EXIF 元数据）",
    "png": "PNG 图片",
    "gif": "GIF 动图（包含视觉描述）",
    "webp": "WebP 图片（包含视觉描述）",
    "bmp": "BMP 图片",
    "wav": "WAV 音频（语音转录）",
    "mp3": "MP3 音频（语音转录）",
    "ogg": "OGG 音频（语音转录）",
    "flac": "FLAC 音频（语音转录）",
    "m4a": "M4A 音频（语音转录）",
    "aac": "AAC 音频（语音转录）",
    "wma": "WMA 音频（语音转录）",
    "mp4": "MP4 视频（语音转录）",
    "avi": "AVI 视频（语音转录）",
    "mov": "MOV 视频（语音转录）",
    "webm": "WebM 视频（语音转录）",
    "mkv": "MKV 视频（语音转录）",
    "wmv": "WMV 视频（语音转录）",
    "flv": "FLV 视频（语音转录）",
    "m4v": "M4V 视频（语音转录）",
    "zip": "ZIP 压缩包（遍历内容）",
}

# ── Models ──


class ParseResponse(BaseModel):
    filename: str
    markdown: str
    size: int
    elapsed_ms: int


class HealthResponse(BaseModel):
    status: str
    service: str
    version: str


# ── Routes ──


@app.get("/health", response_model=HealthResponse)
async def health():
    return HealthResponse(
        status="ok",
        service="markitdown-sidecar",
        version=SIDECAR_VERSION,
    )


# ── Whisper 模型管理 API ──


def _is_model_downloaded(model_name: str) -> bool:
    """检查模型是否已下载到本地缓存（直接扫描文件系统，兼容 PyInstaller）"""
    import os
    # HuggingFace 缓存目录：~/.cache/huggingface/hub/models--{org}--{repo}/snapshots/
    cache_dir = os.path.join(os.path.expanduser("~"), ".cache", "huggingface", "hub")
    repo_dir_name = f"models--Systran--faster-whisper-{model_name}"
    snapshots_dir = os.path.join(cache_dir, repo_dir_name, "snapshots")
    if not os.path.isdir(snapshots_dir):
        return False
    # 检查是否有至少一个快照包含 model.bin
    try:
        for snapshot in os.listdir(snapshots_dir):
            model_bin = os.path.join(snapshots_dir, snapshot, "model.bin")
            if os.path.isfile(model_bin):
                return True
    except OSError:
        pass
    return False


@app.get("/whisper/models")
async def whisper_models():
    """返回可用 Whisper 模型列表 + 下载/激活状态"""
    models = []
    for name, meta in WHISPER_MODELS.items():
        downloaded = _is_model_downloaded(name)
        progress_info = _download_progress.get(name, {})
        models.append({
            "name": name,
            "size_mb": meta["size_mb"],
            "description": meta["description"],
            "downloaded": downloaded,
            "active": name == _current_whisper_model_name and _whisper_model is not None and downloaded,
            "download_status": progress_info.get("status"),
            "download_progress": progress_info.get("progress", 0),
            "download_error": progress_info.get("error"),
        })
    return {"models": models, "active_model": _current_whisper_model_name}


@app.post("/whisper/download")
async def whisper_download(request: dict):
    """后台下载指定 Whisper 模型（支持多镜像源）"""
    import threading
    model_name = request.get("model_name", "").strip()

    if model_name not in WHISPER_MODELS:
        raise HTTPException(status_code=400, detail=f"Unknown model: {model_name}")

    if _is_model_downloaded(model_name):
        return {"status": "already_downloaded", "model": model_name}

    if model_name in _download_progress and _download_progress[model_name].get("status") == "downloading":
        return {"status": "already_downloading", "model": model_name}

    # 后台线程下载
    def download_worker():
        _download_progress[model_name] = {"status": "downloading", "progress": 0, "error": None}
        try:
            from huggingface_hub import snapshot_download
            import os

            repo_id = f"Systran/faster-whisper-{model_name}"

            # 尝试多个镜像源
            last_error = None
            for mirror in HF_MIRRORS:
                try:
                    os.environ["HF_ENDPOINT"] = mirror
                    print(f"[INFO] Downloading {model_name} from {mirror}...")
                    _download_progress[model_name]["progress"] = 10

                    snapshot_download(repo_id, local_files_only=False)

                    _download_progress[model_name] = {"status": "done", "progress": 100, "error": None}
                    print(f"[INFO] Model {model_name} downloaded successfully from {mirror}")
                    return
                except Exception as e:
                    last_error = str(e)
                    print(f"[WARN] Mirror {mirror} failed: {e}")
                    continue

            # Classify error: network issues get a structured code for friendly frontend display
            error_lower = (last_error or "").lower()
            is_network = any(kw in error_lower for kw in [
                "connecttimeout", "connectionerror", "timeout",
                "unreachable", "network", "dns", "refused",
                "winerror", "sslerror", "proxy", "connect",
                "locate the files on the hub",
                "appropriate snapshot",
            ])
            if is_network:
                _download_progress[model_name] = {"status": "error", "progress": 0, "error": "NETWORK_UNREACHABLE"}
            else:
                _download_progress[model_name] = {"status": "error", "progress": 0, "error": last_error}
        except Exception as e:
            _download_progress[model_name] = {"status": "error", "progress": 0, "error": str(e)}

    threading.Thread(target=download_worker, daemon=True).start()
    return {"status": "download_started", "model": model_name}


@app.post("/whisper/activate")
async def whisper_activate(request: dict):
    """切换当前活跃的 Whisper 模型"""
    global _whisper_model, _current_whisper_model_name
    model_name = request.get("model_name", "").strip()

    if model_name not in WHISPER_MODELS:
        raise HTTPException(status_code=400, detail=f"Unknown model: {model_name}")

    if not _is_model_downloaded(model_name):
        raise HTTPException(status_code=400, detail=f"Model {model_name} not downloaded yet")

    if model_name == _current_whisper_model_name and _whisper_model is not None:
        return {"status": "already_active", "model": model_name}

    # 卸载旧模型，加载新模型
    _whisper_model = None
    _current_whisper_model_name = model_name

    try:
        from faster_whisper import WhisperModel
        _whisper_model = WhisperModel(model_name, device="cpu", compute_type="int8")
        print(f"[INFO] Switched to whisper model: {model_name}")
        return {"status": "activated", "model": model_name}
    except Exception as e:
        _whisper_model = None
        raise HTTPException(status_code=500, detail=f"Failed to load model: {e}")


@app.get("/formats")
async def formats():
    return SUPPORTED_FORMATS


@app.post("/parse", response_model=ParseResponse)
async def parse(request: Request):
    """
    双模解析：
    1. JSON 模式（路径直读）：{ "local_path": "/path/to/file", "filename": "test.pdf", ... }
    2. FormData 模式（上传兼容）：file=@test.pdf
    """
    content_type = request.headers.get("content-type", "")
    
    if "application/json" in content_type:
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
            
        content = path.read_bytes()
        
        base_url = body.get("base_url")
        api_key = body.get("api_key")
        llm_model = body.get("llm_model")
        audio_lang = body.get("audio_lang")
        app_lang = body.get("app_lang")
        
        # 为了兼容下方日志，用类似 UploadFile 的对象包装下 filename
        class _FileMock:
            def __init__(self, fn):
                self.filename = fn
        file = _FileMock(filename)
        
    else:
        form = await request.form()
        file = form.get("file")
        if not file or not file.filename:
            raise HTTPException(400, detail="缺少文件")
            
        ext = Path(file.filename).suffix.lower().lstrip(".")
        if ext not in SUPPORTED_FORMATS:
            raise HTTPException(415, detail=f"不支持的格式: .{ext}")
            
        content = await file.read()
        
        base_url = form.get("base_url")
        api_key = form.get("api_key")
        llm_model = form.get("llm_model")
        audio_lang = form.get("audio_lang")
        app_lang = form.get("app_lang")

    if not content:
        raise HTTPException(status_code=400, detail="文件为空")

    # Context cleanup: audio_lang_ctx has been removed

    # Normalize base_url for local LLM services
    if base_url and ('127.0.0.1' in base_url or 'localhost' in base_url):
        pass  # Local sidecar: no rewriting needed

    class CleanLogger:
        def __enter__(self):
            return self
        def __exit__(self, exc_type, exc_val, exc_tb):
            pass
        def write(self, message: str):
            clean_msg = message.strip()
            if not clean_msg:
                return
            if clean_msg.startswith("[DEBUG] "):
                clean_msg = clean_msg[8:]
            elif clean_msg.startswith("[ERROR] "):
                clean_msg = clean_msg[8:]
            logger.info(sanitize_sensitive_data(clean_msg))

    with CleanLogger() as f:
        f.write(f"\n[DEBUG] === 正在解析文件: {file.filename} (大小: {len(content)} 字节) ===\n")
        f.write(f"[DEBUG] base_url: {base_url}\n")
        f.write(f"[DEBUG] api_key 长度: {len(api_key) if api_key else 0}\n")
        f.write(f"[DEBUG] llm_model: {llm_model}\n")
        
        # audio_lang 仅作日志参考，faster-whisper 自动检测语言
        if audio_lang:
            f.write(f"[DEBUG] 前端请求语言偏好: {audio_lang} (faster-whisper 将自动检测)\n")

        # 默认使用全局 MarkItDown 实例（无 LLM），如果提供了 LLM 配置则覆盖
        processing_md = md

        if base_url and llm_model:
            try:
                f.write("[DEBUG] 尝试初始化 OpenAI 客户端...\n")
                client = OpenAI(base_url=base_url, api_key=api_key or "sk-dummy-key")
                # 语言映射字典表，支持无限扩展未来语种
                lang_map = {
                    "en": "English",
                    "zh-CN": "Simplified Chinese (简体中文)",
                    "fr-FR": "French (Français)",
                    "ja-JP": "Japanese (日本語)",
                    "ko-KR": "Korean (한국어)",
                    "de-DE": "German (Deutsch)",
                    "es-ES": "Spanish (Español)",
                    "ru-RU": "Russian (Русский)"
                }
                # 默认回落为使用请求的原文设定，或如果为空则退回中文
                target_fallback_lang = lang_map.get(app_lang, "Simplified Chinese (简体中文)")

                ocr_prompt = (
                    "You are a professional image analysis assistant.\n"
                    "For EVERY image you process, output your response strictly in the following TWO-PART format without regurgitating my instructions:\n\n"
                    "**[Illustration]**\n"
                    f"Write a detailed semantic description of the image's visual contents, context, and overall meaning here. THIS ENTIRE SECTION MUST BE WRITTEN EXCLUSIVELY IN {target_fallback_lang}.\n\n"
                    "**[Text Content]**\n"
                    "Perform precise OCR extraction of all text found in the image here. If no text exists, output 'None'. Preserve the original language and layout of the extracted text.\n\n"
                    "CRITICAL RULES:\n"
                    "1. Do NOT output any Markdown image syntax (like '![]()').\n"
                    "2. Do NOT copy these instructions into your output.\n"
                    f"3. The [Illustration] section MUST use {target_fallback_lang}. Do NOT use English unless the requested language is English."
                )
                processing_md = MarkItDown(
                    llm_client=client, 
                    llm_model=llm_model,
                    llm_prompt=ocr_prompt,

                )
                f.write("[DEBUG] OpenAI 客户端与 MarkItDown 绑定成功!\n")
            except Exception as e:
                f.write(sanitize_sensitive_data(f"[ERROR] OpenAI 初始化异常: {e}\n"))
                raise HTTPException(
                    status_code=500,
                    detail=sanitize_sensitive_data(f"OpenAI 客户端初始化失败: {e}")
                )

        start = time.monotonic()
        
        # ── 音视频分流：使用 faster-whisper 本地转写（异步线程池，避免阻塞 event loop）──
        if ext in AUDIO_VIDEO_EXTENSIONS:
            f.write(f"[DEBUG] 检测到音视频文件 (.{ext})，启动 faster-whisper 转写...\n")

            import asyncio

            def _transcribe_sync(audio_bytes, suffix):
                """在工作线程中运行同步的 whisper 转写"""
                import tempfile, os
                model = get_whisper_model()
                with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
                    tmp.write(audio_bytes)
                    tmp_path = tmp.name
                try:
                    segments, info = model.transcribe(tmp_path, beam_size=5)
                    detected_lang = info.language
                    lang_prob = info.language_probability
                    transcript_parts = [seg.text.strip() for seg in segments]
                finally:
                    os.unlink(tmp_path)
                return detected_lang, lang_prob, transcript_parts

            try:
                detected_lang, lang_prob, transcript_parts = await asyncio.to_thread(
                    _transcribe_sync, content, f".{ext}"
                )
                f.write(f"[DEBUG] 检测到语言: {detected_lang} (概率: {lang_prob:.2f})\n")

                markdown_text = "\n".join(transcript_parts) if transcript_parts else ""

                if not markdown_text:
                    markdown_text = "> [!NOTE]\n> 音频/视频语音内容提取结束：未检测到可识别的清晰人声或语音片段。\n"
                else:
                    markdown_text = f"> **语言**: {detected_lang}\n\n{markdown_text}"

                f.write(f"[DEBUG] faster-whisper 转写完成，文本长度: {len(markdown_text)}\n")

            except Exception as e:
                import traceback
                f.write(sanitize_sensitive_data(f"[ERROR] faster-whisper 转写异常:\n{traceback.format_exc()}\n"))
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
        try:
            f.write("[DEBUG] 开始调用 convert_stream...\n")
            result = processing_md.convert_stream(
                io.BytesIO(content),
                file_extension=f".{ext}",
                keep_data_uris=True
            )
            markdown_text = result.text_content or ""
            if ext.lower() == "pdf" and markdown_text:
                f.write("[DEBUG] 正在对 PDF 提取文本进行智能流排版与格式清洗...\n")
                markdown_text = clean_pdf_markdown(markdown_text)
            if ext == "json" and not markdown_text.startswith("```json"):
                markdown_text = f"```json\n{markdown_text.strip()}\n```"
            f.write(f"[DEBUG] convert_stream 完成！提取到的文本长度: {len(markdown_text)}\n")
            if len(markdown_text) < 100:
                f.write(f"[DEBUG] 提取到的内容前掠: {markdown_text!r}\n")
        except Exception as e:
            import traceback
            err_msg = str(e)
            f.write(sanitize_sensitive_data(f"[ERROR] convert_stream 发生异常:\n{traceback.format_exc()}\n"))
            
            # 优雅降级：如果是语音识别无法识别到文字（纯音乐、无声、或者背景音杂乱），返回一个兜底的 Markdown 文本
            # 而不是让整个文件导入流程崩溃
            if "UnknownValueError" in err_msg:
                markdown_text = "> [!NOTE]\n> 音频/视频语音内容提取结束：未检测到可识别的清晰人声或语音片段。\n"
            else:
                raise HTTPException(
                    status_code=500,
                    detail=sanitize_sensitive_data(err_msg),
                )

        elapsed_ms = int((time.monotonic() - start) * 1000)
        f.write(f"[DEBUG] 全部完成，耗时 {elapsed_ms} ms ===\n\n")

    return ParseResponse(
        filename=file.filename,
        markdown=markdown_text,
        size=len(content),
        elapsed_ms=elapsed_ms,
    )


class ParseUrlRequest(BaseModel):
    url: str
    base_url: str | None = None
    api_key: str | None = None
    llm_model: str | None = None
    audio_lang: str | None = None
    app_lang: str | None = None


@app.post("/parse-url", response_model=ParseResponse)
async def parse_url(payload: ParseUrlRequest):
    """
    抓取并转换 URL 为 Markdown。
    如果传递了大模型参数，可以使用视觉或更强大的模型解析复杂网页内容。
    """

    # Normalize base_url for local LLM services
    if payload.base_url and ('127.0.0.1' in payload.base_url or 'localhost' in payload.base_url):
        pass  # Local sidecar: no rewriting needed

    if not payload.url:
        raise HTTPException(status_code=400, detail="缺少 url 参数")

    # 动态初始化带 LLM 解析的 MarkItDown 实例
    processing_md = md
    if payload.base_url and payload.llm_model:
        try:
            client = OpenAI(base_url=payload.base_url, api_key=payload.api_key or "sk-dummy-key")
            # 语言映射字典表，支持无限扩展未来语种
            lang_map = {
                "en": "English",
                "zh-CN": "Simplified Chinese (简体中文)",
                "fr-FR": "French (Français)",
                "ja-JP": "Japanese (日本語)",
                "ko-KR": "Korean (한국어)",
                "de-DE": "German (Deutsch)",
                "es-ES": "Spanish (Español)",
                "ru-RU": "Russian (Русский)"
            }
            # 默认回落为使用请求的原文设定，或如果为空则退回中文
            target_fallback_lang = lang_map.get(payload.app_lang, "Simplified Chinese (简体中文)")

            ocr_prompt = (
                "You are a professional image analysis assistant.\n"
                "For EVERY image you process, output your response strictly in the following TWO-PART format without regurgitating my instructions:\n\n"
                "**[Illustration]**\n"
                f"Write a detailed semantic description of the image's visual contents, context, and overall meaning here. THIS ENTIRE SECTION MUST BE WRITTEN EXCLUSIVELY IN {target_fallback_lang}.\n\n"
                "**[Text Content]**\n"
                "Perform precise OCR extraction of all text found in the image here. If no text exists, output 'None'. Preserve the original language and layout of the extracted text.\n\n"
                "CRITICAL RULES:\n"
                "1. Do NOT output any Markdown image syntax (like '![]()').\n"
                "2. Do NOT copy these instructions into your output.\n"
                f"3. The [Illustration] section MUST use {target_fallback_lang}. Do NOT use English unless the requested language is English."
            )
            processing_md = MarkItDown(
                llm_client=client, 
                llm_model=payload.llm_model,
                llm_prompt=ocr_prompt,
            )
        except Exception as e:
            raise HTTPException(
                status_code=500,
                detail=f"OpenAI 客户端初始化失败: {e}"
            )

    # 转换
    start = time.monotonic()
    try:
        # requests fallback inside MarkItDown will fetch and parse
        result = processing_md.convert(payload.url, keep_data_uris=True)
        markdown_text = result.text_content or ""
        if payload.url.lower().endswith(".pdf") and markdown_text:
            markdown_text = clean_pdf_markdown(markdown_text)
    except Exception as e:
        err_msg = str(e)
        if "UnknownValueError" in err_msg:
            markdown_text = "> [!NOTE]\n> 音频/视频语音内容提取结束：未检测到可识别的清晰人声或语音片段。\n"
        else:
            # 尝试使用 Jina Reader 作为防爬虫兜底方案
            try:
                import requests
                jina_url = f"https://r.jina.ai/{payload.url}"
                jina_res = requests.get(jina_url, timeout=20)
                if jina_res.status_code == 200:
                    markdown_text = jina_res.text
                    if not markdown_text.strip():
                        raise ValueError("Jina API 返回内容为空")
                    markdown_text = f"> [!NOTE]\n> 当前网页启用了反爬虫策略，已切换至阅读器模式为您提取内容。\n>\n> 若提取内容为 404 Not Found 或提示登录，说明该页面可能是**私有页面（如私有 GitHub 仓库、需要登录的内网页面等）**，服务端无法获取您的浏览器 Cookie，请手动复制内容。\n\n{markdown_text}"
                else:
                    raise Exception(f"原始报错: {err_msg}\nJina 兜底服务也失败了，HTTP 状态码: {jina_res.status_code}")
            except Exception as fallback_e:
                raise HTTPException(
                    status_code=500,
                    detail=str(fallback_e)
                )

    elapsed_ms = int((time.monotonic() - start) * 1000)

    # 用 URL 的最后一段或域名作为粗糙的文件名
    try:
        from urllib.parse import urlparse
        parsed = urlparse(payload.url)
        filename = parsed.path.split('/')[-1]
        if not filename or filename == "":
            filename = parsed.netloc
    except:
        filename = "web_import"

    # append .md if missing
    import re
    filename = re.sub(r'[\\/*?:"<>|]', '_', filename) # sanitize
    if not filename.endswith(".md"):
        filename += ".md"

    return ParseResponse(
        filename=filename,
        markdown=markdown_text,
        size=len(markdown_text.encode('utf-8')),
        elapsed_ms=elapsed_ms,
    )

# ── 入口 ──

if __name__ == "__main__":
    import multiprocessing
    multiprocessing.freeze_support()  # PyInstaller 环境必须：防止子进程传递 -B -S -I 参数
    import uvicorn
    import threading
    import sys
    import os

    def stdin_watchdog():
        """
        监视 stdin 管道。当父进程（Tauri）退出或崩溃时，
        系统会自动关闭管道写入端，此处 read() 会返回 EOF，
        从而触发安全退出，防止产生僵尸进程。
        """
        try:
            sys.stdin.read()
        except:
            pass
        print("[Watchdog] stdin closed, parent process likely died. Exiting...", flush=True)
        os._exit(0)

    # 只有在非交互式终端（被 Tauri 启动时）才启动 watchdog
    if not sys.stdin.isatty():
        threading.Thread(target=stdin_watchdog, daemon=True).start()

    parser = argparse.ArgumentParser(description="Slash MarkItDown Sidecar")
    parser.add_argument("--port", type=int, default=0, help="Port to listen on (0 = auto)")
    args = parser.parse_args()

    config = uvicorn.Config(app, host="127.0.0.1", port=args.port, log_level="warning")
    server = uvicorn.Server(config)

    original_startup = server.startup

    async def patched_startup(sockets=None):
        await original_startup(sockets)
        # After startup, server.servers contains the actual bound sockets
        actual_port = args.port
        if server.servers:
            for srv in server.servers:
                for sock in srv.sockets:
                    addr = sock.getsockname()
                    if addr and addr[1]:
                        actual_port = addr[1]
                        break
        # Signal to Tauri parent process that sidecar is ready with ACTUAL port
        print(f"SIDECAR_READY:{actual_port}", flush=True)

    server.startup = patched_startup
    server.run()
