#!/usr/bin/env python3
"""
Slash Sidecar 打包脚本
用 PyInstaller 将 sidecar 打包为各平台独立可执行文件。

使用方法:
    python build.py                  # 当前平台打包
    python build.py --target-suffix aarch64-apple-darwin  # 指定目标后缀
"""

import io
import sys

# Windows CI (cp1252) 无法输出 emoji/中文，强制 UTF-8
if sys.stdout.encoding != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
if sys.stderr.encoding != "utf-8":
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

import json
import platform
import subprocess
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).parent
VERSION_FILE = ROOT / "version.json"
MAIN_PY = ROOT / "app" / "main.py"
DIST_DIR = ROOT / "dist"


def detect_target_suffix() -> str:
    """根据当前平台检测 Tauri 兼容的目标后缀"""
    machine = platform.machine().lower()
    system = platform.system().lower()

    if system == "darwin":
        arch = "aarch64" if machine == "arm64" else "x86_64"
        return f"{arch}-apple-darwin"
    elif system == "windows":
        return "x86_64-pc-windows-msvc"
    elif system == "linux":
        return "x86_64-unknown-linux-gnu"
    else:
        raise RuntimeError(f"不支持的平台: {system} {machine}")


def update_version_file():
    """更新 version.json 中的构建日期"""
    with open(VERSION_FILE) as f:
        data = json.load(f)
    data["build_date"] = datetime.now().isoformat()
    with open(VERSION_FILE, "w") as f:
        json.dump(data, f, indent=4)
    return data


def build(target_suffix: str | None = None):
    if target_suffix is None:
        target_suffix = detect_target_suffix()

    # PyInstaller --name 不应包含 .exe（PyInstaller 在 Windows 自动加 .exe 后缀）
    # --name 同时决定输出目录名和二进制名，保持目录名干净
    dir_name = f"slash-sidecar-{target_suffix}"
    binary_name = f"{dir_name}.exe" if "windows" in target_suffix else dir_name

    print(f"🔨 打包目标: {binary_name}")
    print(f"📁 输出目录: {DIST_DIR / dir_name}")

    # 更新版本信息
    version_data = update_version_file()
    print(f"📌 版本: {version_data['sidecar_version']}")

    # Windows 使用 ; 作为 --add-data 分隔符，macOS/Linux 使用 :
    add_data_sep = ";" if "windows" in target_suffix else ":"

    # PyInstaller 命令 (--onedir 模式：免解压，启动快)
    # --name 使用 dir_name（不带 .exe），PyInstaller 在 Windows 会自动给二进制加 .exe
    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm",
        "--onedir",
        "--name", dir_name,
        "--distpath", str(DIST_DIR),
        "--workpath", str(ROOT / "build"),
        "--specpath", str(ROOT),
        # 附带 version.json
        "--add-data", f"{VERSION_FILE}{add_data_sep}.",
        # 包含包内数据文件（模型、配置等）
        "--collect-data", "magika",
        "--collect-data", "markitdown",
        "--collect-data", "faster_whisper",
        "--collect-data", "ctranslate2",
        "--collect-data", "huggingface_hub",
        "--collect-data", "pdfminer",
        "--collect-data", "pypdfium2",
        "--collect-data", "certifi",
        # Hidden imports
        "--hidden-import", "faster_whisper",
        "--hidden-import", "ctranslate2",
        "--hidden-import", "markitdown",
        "--hidden-import", "markdownify",
        "--hidden-import", "uvicorn.logging",
        "--hidden-import", "uvicorn.protocols.http",
        "--hidden-import", "uvicorn.protocols.http.auto",
        "--hidden-import", "uvicorn.protocols.websockets",
        "--hidden-import", "uvicorn.protocols.websockets.auto",
        "--hidden-import", "uvicorn.lifespan",
        "--hidden-import", "uvicorn.lifespan.on",
        # 入口
        str(MAIN_PY),
    ]

    import os
    if sys.platform == "darwin":
        codesign_identity = os.environ.get("PYINSTALLER_CODESIGN_IDENTITY")
        if codesign_identity:
            cmd.extend(["--codesign-identity", codesign_identity])
            print(f"🔒 [Signing] PyInstaller Codesign Identity: {codesign_identity}")

        entitlements_file = os.environ.get("PYINSTALLER_ENTITLEMENTS_FILE")
        if entitlements_file:
            entitlements_path = Path(entitlements_file)
            if entitlements_path.exists():
                cmd.extend(["--osx-entitlements-file", str(entitlements_path)])
                print(f"🔒 [Signing] PyInstaller Entitlements File: {entitlements_path}")
            else:
                print(f"⚠️ [Signing] Entitlements file not found at: {entitlements_file}")

    print(f"\n🚀 执行: {' '.join(cmd)}\n")
    result = subprocess.run(cmd)

    if result.returncode == 0:
        # --onedir 输出结构: dist/{dir_name}/{binary_name}
        # dir_name 不带 .exe，binary_name 在 Windows 带 .exe
        output_dir = DIST_DIR / dir_name
        output_exe = output_dir / binary_name
        if output_exe.exists():
            # 计算整个目录体积
            total_size = sum(f.stat().st_size for f in output_dir.rglob("*") if f.is_file())
            size_mb = total_size / (1024 * 1024)
            print(f"\n✅ 打包成功: {output_dir}")
            print(f"📦 总体积: {size_mb:.1f} MB")

            # 复制整个目录到 Tauri binaries
            tauri_bin_dir = ROOT.parent / "desktop" / "src-tauri" / "binaries"
            dest = tauri_bin_dir / dir_name
            import shutil
            if dest.exists():
                shutil.rmtree(dest)
            shutil.copytree(output_dir, dest)
            print(f"📋 已复制到: {dest}")
        else:
            print(f"\n❌ 输出文件不存在: {output_exe}")
            sys.exit(1)
    else:
        print(f"\n❌ 打包失败 (exit code: {result.returncode})")
        sys.exit(1)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Slash Sidecar 打包工具")
    parser.add_argument("--target-suffix", help="目标平台后缀 (如 aarch64-apple-darwin)")
    args = parser.parse_args()
    build(args.target_suffix)
