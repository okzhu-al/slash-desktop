#!/usr/bin/env bash
set -euo pipefail
SRC_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST_ROOT="${DESKTOP_REPO:-$SRC_ROOT/../slash-desktop}"

echo "=================================================="
echo "🚀 Publishing Slash Desktop mirror"
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

# Copy public desktop files from source
echo "📦 Copying files from source..."
rsync -av \
  --exclude='.git' \
  --exclude='.docker-data' \
  --exclude='**/.venv' \
  --exclude='**/binaries' \
  --exclude='**/dist' \
  --exclude='**/build' \
  --exclude='**/__pycache__' \
  --exclude='**/.DS_Store' \
  --exclude='apps/server' \
  --exclude='scripts/dev' \
  --exclude='node_modules' \
  --exclude='target' \
  --exclude='scratch' \
  --exclude='tmp' \
  --exclude='tmp_*' \
  --exclude='temp' \
  --exclude='temp_*' \
  --exclude='tmp_pm' \
  --exclude='temp_skip' \
  --exclude='*.log' \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='secrets' \
  --exclude='*.pem' \
  --exclude='*.key' \
  --exclude='*.p12' \
  --exclude='*.mobileprovision' \
  "$SRC_ROOT/" "$DEST_ROOT/"

cd "$DEST_ROOT"

# Hard-remove anything that must never be public
echo "🗑️  Enforcing deletion of forbidden paths..."
rm -rf apps/server
rm -rf target dist node_modules tmp_pm temp_skip
rm -rf scripts/dev
git rm -rf --ignore-unmatch scripts/dev 2>/dev/null || true
rm -f *.log
rm -f home_network_backup.md
rm -f docker-compose.yml
# Remove obvious scratch files
rm -f test.rs test_path.rs test_paths.js test-note-id.js test-custom-skill.sh
rm -f tmp_migration.rs

# Publish desktop-facing user docs.
echo "📚 Publishing desktop user documentation..."
rm -rf docs
mkdir -p docs/user/desktop
rsync -av "$SRC_ROOT/docs/user/desktop/" docs/user/desktop/
cp "$SRC_ROOT/docs/user/desktop/README.md" README.md

# Public repo must not include private server implementation
if [ -d "apps/server" ]; then
  echo "ERROR: apps/server still exists in desktop mirror"
  exit 1
fi

# --- Workspace adjustments ---
echo "⚙️  Adjusting Cargo.toml workspace members..."
python3 -c '
import pathlib
path = pathlib.Path("Cargo.toml")
if path.exists():
    content = path.read_text()
    # Strip apps/server
    content = content.replace("    \"apps/server\",\n", "")
    path.write_text(content)
'

echo "⚙️  Adjusting pnpm-workspace.yaml packages..."
python3 -c '
import pathlib
path = pathlib.Path("pnpm-workspace.yaml")
if path.exists():
    content = """packages:
  - "apps/desktop"
  - "apps/python-sidecar"
  - "packages/*"

patchedDependencies:
  "@tiptap/extension-code-block-lowlight@3.15.3": patches/@tiptap__extension-code-block-lowlight@3.15.3.patch
  tiptap-markdown@0.9.0: patches/tiptap-markdown@0.9.0.patch
"""
    path.write_text(content)
'

echo "⚙️  Scrubbing Apple credentials from apps/desktop/package.json..."
python3 -c '
import pathlib, re
path = pathlib.Path("apps/desktop/package.json")
if path.exists():
    content = path.read_text()
    content = re.sub(r"APPLE_ID=\S+\s+APPLE_PASSWORD=\S+\s+APPLE_TEAM_ID=\S+\s+tauri", "tauri", content)
    path.write_text(content)
'

# Copy the check-sensitive script to run inside DEST_ROOT for self-audit
echo "🛡️  Running sensitive info scan for public desktop mirror..."
# We run the scanner in DEST_ROOT
if git grep -nE \
  "SECRET|TOKEN|PASSWORD|PRIVATE_KEY|ACCESS_KEY|AWS_|OPENAI|ANTHROPIC|DATABASE_URL|TAURI_PRIVATE|APPLE|CERT|MINIO|SENTRY" \
  -- . \
  ':!pnpm-lock.yaml' \
  ':!Cargo.lock' \
  ':!docs/**' \
  ':!scripts/**' \
  ':!.agent/**' \
  ':!apps/desktop/public/fonts/**' \
  ':!apps/desktop/src/services/SyncService.ts'; then
  echo ""
  echo "ERROR: possible sensitive strings found. Review before publishing."
  exit 1
fi

# ⚙️ 确保 binaries 目录在桌面分仓中存在，但剔除其内大文件（由极小占位文件替代以满足 Tauri 编译校验）
echo "⚙️  Creating binaries placeholder to satisfy Tauri resources build check..."
mkdir -p apps/desktop/src-tauri/binaries
touch apps/desktop/src-tauri/binaries/.gitkeep

# ⚙️ 自动将专属于分仓的 Release 脚本部署到镜像分仓的 .github/workflows 下
echo "⚙️  Deploying public workflows to .github/workflows in mirror repo..."
mkdir -p .github/workflows
rm -f .github/workflows/ci.yml
cp "$SRC_ROOT/scripts/workflows/release-desktop.yml" .github/workflows/

echo ""
echo "✨ Desktop mirror staging complete."
echo ""
git status --short
echo ""
echo "Review changes, then run:"
echo "  cd $DEST_ROOT"
echo "  git add ."
echo "  git commit -m \"Update desktop public mirror\""
echo "  git push"
