#!/usr/bin/env python3
"""Verify Slash desktop updater metadata before/after release finalization."""

from __future__ import annotations

import argparse
import base64
import json
import sys
from pathlib import Path


PENDING_SIGNATURE = "__PENDING_SIGNATURE__"


def die(message: str) -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)


def decode_signature(signature: str, platform: str) -> str:
    try:
        return base64.b64decode(signature, validate=True).decode("utf-8", errors="replace")
    except Exception as exc:
        die(f"{platform} signature is not valid base64 text: {exc}")


def verify_signature(
    *,
    platform: str,
    signature: str | None,
    expected_file: str,
    current_version: str,
    allow_pending: bool,
) -> None:
    if signature == PENDING_SIGNATURE and allow_pending:
        return
    if not signature:
        die(f"{platform} signature is empty")
    if signature == PENDING_SIGNATURE:
        die(f"{platform} signature is still pending")

    decoded = decode_signature(signature, platform)
    if f"file:{expected_file}" not in decoded:
        die(
            f"{platform} signature does not target expected asset {expected_file!r}. "
            "This usually means update.json kept an old signature."
        )

    if platform == "windows-x86_64" and current_version not in decoded:
        die(f"{platform} signature does not include current version {current_version}")


def load_previous_signatures(path: Path | None) -> dict[str, str]:
    if not path:
        return {}
    try:
        data = json.loads(path.read_text())
    except Exception as exc:
        die(f"could not read previous updater metadata {path}: {exc}")
    platforms = data.get("platforms") or {}
    result = {}
    for platform, meta in platforms.items():
        if isinstance(meta, dict) and isinstance(meta.get("signature"), str):
            result[platform] = meta["signature"]
    return result


def verify(path: Path, version: str, repo: str, allow_pending: bool, previous_file: Path | None) -> None:
    try:
        data = json.loads(path.read_text())
    except Exception as exc:
        die(f"could not read {path}: {exc}")

    actual_version = data.get("version")
    if actual_version != version:
        die(f"{path} version is {actual_version!r}, expected {version!r}")

    platforms = data.get("platforms")
    if not isinstance(platforms, dict):
        die(f"{path} is missing platforms object")

    expected = {
        "darwin-aarch64": {
            "url": f"https://github.com/{repo}/releases/download/v{version}/Slash.app.tar.gz",
            "file": "Slash.app.tar.gz",
        },
        "windows-x86_64": {
            "url": f"https://github.com/{repo}/releases/download/v{version}/Slash_{version}_x64-setup.exe",
            "file": f"Slash_{version}_x64-setup.exe",
        },
    }

    previous_signatures = load_previous_signatures(previous_file)

    for platform, spec in expected.items():
        meta = platforms.get(platform)
        if not isinstance(meta, dict):
            die(f"{path} is missing platform {platform}")
        url = meta.get("url")
        if url != spec["url"]:
            die(f"{path} {platform} url is {url!r}, expected {spec['url']!r}")
        signature = meta.get("signature")
        if (
            not allow_pending
            and signature
            and signature != PENDING_SIGNATURE
            and previous_signatures.get(platform) == signature
        ):
            die(f"{path} {platform} signature is identical to the previous release signature")
        verify_signature(
            platform=platform,
            signature=signature,
            expected_file=spec["file"],
            current_version=version,
            allow_pending=allow_pending,
        )

    print(f"Updater metadata OK: {path}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--file", required=True, type=Path)
    parser.add_argument("--repo", default="okzhu-al/slash-desktop")
    parser.add_argument(
        "--allow-pending",
        action="store_true",
        help="Allow __PENDING_SIGNATURE__ placeholders during release preparation.",
    )
    parser.add_argument(
        "--previous-file",
        type=Path,
        help="Previous updater metadata. Final signatures must differ from this file.",
    )
    args = parser.parse_args()
    verify(args.file, args.version, args.repo, args.allow_pending, args.previous_file)


if __name__ == "__main__":
    main()
