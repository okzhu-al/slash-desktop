#!/usr/bin/env python3
import argparse
import re
import sys
from pathlib import Path


def extract_section(text: str, version: str) -> str:
    heading_re = re.compile(rf"^##\s+v?{re.escape(version)}\s*$", re.MULTILINE)
    match = heading_re.search(text)
    if not match:
        raise SystemExit(f"release notes for v{version} not found")

    next_match = re.search(r"^##\s+", text[match.end():], re.MULTILINE)
    end = match.end() + next_match.start() if next_match else len(text)
    return text[match.start():end].strip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract one version section from beta-change-log.md")
    parser.add_argument("--version", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--output")
    parser.add_argument("--body-only", action="store_true")
    args = parser.parse_args()

    source = Path(args.source)
    section = extract_section(source.read_text(encoding="utf-8"), args.version)
    if args.body_only:
        section = re.sub(rf"^##\s+v?{re.escape(args.version)}\s*\n+", "", section, count=1)

    if args.output:
        Path(args.output).write_text(section, encoding="utf-8")
    else:
        sys.stdout.write(section)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
