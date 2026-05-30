#!/usr/bin/env bash
set -euo pipefail

echo "=================================================="
echo "🛡️  Scanning for possible sensitive strings..."
echo "=================================================="

critical_hits="$(git grep -nE \
  "ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----" \
  -- . \
  ':!pnpm-lock.yaml' \
  ':!Cargo.lock' \
  ':!docs/**' \
  || true)"

if [ -n "$critical_hits" ]; then
  echo "🚨 Critical secret pattern detected. Remove the secret and rotate the credential before publishing."
  echo "$critical_hits"
  exit 1
fi

git grep -nE \
  "SECRET|TOKEN|PASSWORD|PRIVATE_KEY|ACCESS_KEY|AWS_|OPENAI|ANTHROPIC|DATABASE_URL|TAURI_PRIVATE|APPLE|CERT|MINIO|SENTRY" \
  -- . \
  ':!pnpm-lock.yaml' \
  ':!Cargo.lock' \
  ':!docs/**' \
  ':!.agent/**' \
  || true

echo ""
echo "=================================================="
echo "📂 Checking sensitive file patterns..."
echo "=================================================="
sensitive_files="$(find . \
  -path '*/node_modules' -prune \
  -o -path '*/.git' -prune \
  -o -path '*/target' -prune \
  -o -path '*/dist' -prune \
  -o -path '*/.venv' -prune \
  -o -path '*/venv' -prune \
  -o -path '*/tmp_pm' -prune \
  -o -path './docs/archive' -prune \
  -o \( \
    \( -name ".env*" -a ! -name ".env.example" \) \
    -o \( -name "*.pem" -a ! -name "cacert.pem" \) \
    -o -name "*.key" \
    -o -name "*.p12" \
    -o -name "*.mobileprovision" \
  \) -print)"

if [ -n "$sensitive_files" ]; then
  echo "🚨 Sensitive file pattern detected. Remove these files or add a deliberate scoped exception:"
  echo "$sensitive_files"
  exit 1
fi

echo "No critical secret patterns or sensitive files found."
