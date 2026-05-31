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


def extract_public_notes(section: str) -> str:
    public_heading_re = re.compile(r"^###\s+公开更新说明\s*$", re.MULTILINE)
    match = public_heading_re.search(section)
    if not match:
        raise SystemExit("public release notes section not found: expected '### 公开更新说明'")

    next_heading = re.search(r"^###\s+", section[match.end():], re.MULTILINE)
    end = match.end() + next_heading.start() if next_heading else len(section)
    return section[match.end():end].strip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract one version section from beta-change-log.md")
    parser.add_argument("--version", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--output")
    parser.add_argument("--body-only", action="store_true")
    parser.add_argument("--public", action="store_true", help="Extract only the public bilingual release notes block")
    args = parser.parse_args()

    source = Path(args.source)
    section = extract_section(source.read_text(encoding="utf-8"), args.version)
    if args.public:
        public_notes = extract_public_notes(section)
        section = public_notes if args.body_only else f"## v{args.version}\n\n{public_notes}"
    elif args.body_only:
        section = re.sub(rf"^##\s+v?{re.escape(args.version)}\s*\n+", "", section, count=1)

    if args.output:
        Path(args.output).write_text(section, encoding="utf-8")
    else:
        sys.stdout.write(section)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
