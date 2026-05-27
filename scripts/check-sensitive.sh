#!/usr/bin/env bash
set -euo pipefail

echo "=================================================="
echo "🛡️  Scanning for possible sensitive strings..."
echo "=================================================="
git grep -nE \
  "SECRET|TOKEN|PASSWORD|PRIVATE_KEY|ACCESS_KEY|AWS_|OPENAI|ANTHROPIC|DATABASE_URL|TAURI_PRIVATE|APPLE|CERT|MINIO|SENTRY" \
  -- . \
  ':!pnpm-lock.yaml' \
  ':!Cargo.lock' \
  ':!docs/**' \
  || true

echo ""
echo "=================================================="
echo "📂 Checking sensitive file patterns..."
echo "=================================================="
find . \
  -path '*/node_modules' -prune \
  -o -path '*/.git' -prune \
  -o -path '*/target' -prune \
  -o -path '*/dist' -prune \
  -o -path '*/tmp_pm' -prune \
  -o \( \
    \( -name ".env*" -a ! -name ".env.example" \) \
    -o -name "*.pem" \
    -o -name "*.key" \
    -o -name "*.p12" \
    -o -name "*.mobileprovision" \
  \) -print
