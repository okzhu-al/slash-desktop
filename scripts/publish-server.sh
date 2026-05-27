#!/usr/bin/env bash
set -euo pipefail
SRC_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST_ROOT="${SERVER_REPO:-$SRC_ROOT/../slash-server}"

echo "=================================================="
echo "🚀 Publishing Slash Server mirror"
echo "Source: $SRC_ROOT"
echo "Destination: $DEST_ROOT"
echo "=================================================="

if [ ! -d "$DEST_ROOT/.git" ]; then
  echo "💡 Destination is not a git repo. Initializing a new git repository in $DEST_ROOT..."
  mkdir -p "$DEST_ROOT"
  git -C "$DEST_ROOT" init -b main || git -C "$DEST_ROOT" init
fi
if [ "$SRC_ROOT" = "$DEST_ROOT" ]; then
  echo "ERROR: source and destination are the same"
  exit 1
fi

# Clean destination but keep .git
echo "🧹 Cleaning destination directory (keeping .git)..."
find "$DEST_ROOT" -mindepth 1 -maxdepth 1 ! -name ".git" -exec rm -rf {} +

# Create target directory layout
mkdir -p "$DEST_ROOT/apps"
mkdir -p "$DEST_ROOT/packages"

# Sync server and shared dependencies
echo "📦 Copying files from source..."
rsync -av "$SRC_ROOT/apps/server/" "$DEST_ROOT/apps/server/"

if [ -d "$SRC_ROOT/packages/slash-core" ]; then
  rsync -av "$SRC_ROOT/packages/slash-core/" "$DEST_ROOT/packages/slash-core/"
fi
if [ -d "$SRC_ROOT/packages/slash-sync-proto" ]; then
  rsync -av "$SRC_ROOT/packages/slash-sync-proto/" "$DEST_ROOT/packages/slash-sync-proto/"
fi

# Copy workspace cargo definitions
cp "$SRC_ROOT/Cargo.toml" "$DEST_ROOT/Cargo.toml"
cp "$SRC_ROOT/Cargo.lock" "$DEST_ROOT/Cargo.lock"

if [ -f "$SRC_ROOT/docker-compose.yml" ]; then
  cp "$SRC_ROOT/docker-compose.yml" "$DEST_ROOT/docker-compose.yml"
fi

if [ -d "$SRC_ROOT/docs/server" ]; then
  mkdir -p "$DEST_ROOT/docs"
  rsync -av "$SRC_ROOT/docs/server/" "$DEST_ROOT/docs/server/"
fi

cd "$DEST_ROOT"

# Hard-remove anything that must never be in server
echo "🗑️  Enforcing deletion of forbidden paths..."
rm -rf target node_modules dist
rm -f *.log

# --- Workspace adjustments ---
echo "⚙️  Adjusting Cargo.toml and Dockerfile configurations..."
python3 -c '
import pathlib
import re

# 1. Adjust Cargo.toml workspace members
path = pathlib.Path("Cargo.toml")
if path.exists():
    content = path.read_text()
    content = content.replace("    \"apps/desktop/src-tauri\",\n", "")
    path.write_text(content)

# 2. Strip apps/desktop build steps from apps/server/Dockerfile
dockerfile_path = pathlib.Path("apps/server/Dockerfile")
if dockerfile_path.exists():
    content = dockerfile_path.read_text()
    pattern = r"# Desktop 不编译[\s\S]*?COPY apps/desktop/src-tauri/Cargo\.toml apps/desktop/src-tauri/Cargo\.toml\n?"
    content = re.sub(pattern, "", content)
    dockerfile_path.write_text(content)
'

echo ""
echo "✨ Server mirror staging complete."
echo ""
git status --short
echo ""
echo "Review changes, then run:"
echo "  cd $DEST_ROOT"
echo "  git add ."
echo "  git commit -m \"Update server private mirror\""
echo "  git push"
