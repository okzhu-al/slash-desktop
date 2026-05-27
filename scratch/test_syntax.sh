#!/bin/bash
set -euo pipefail

SIDECAR_DIR="apps/desktop/src-tauri/binaries/slash-sidecar-aarch64-apple-darwin"
SIGN_IDENTITY="Developer ID Application: Jasper Zhu (H83XQSDL83)"

echo "Signing macOS sidecar directory: $SIDECAR_DIR"

if [ ! -d "$SIDECAR_DIR" ]; then
  echo "ERROR: sidecar directory not found: $SIDECAR_DIR"
  exit 1
fi

# ⚙️ 动态自愈非标准 Python.framework 的 Info.plist 缺失问题，彻底打通 codesign 歧义
FRAMEWORK_DIR="$SIDECAR_DIR/_internal/Python.framework"
if [ -d "$FRAMEWORK_DIR" ]; then
  echo "🔧 [Fix] Python.framework detected. Creating a valid Info.plist to resolve codesign ambiguity..."
  mkdir -p "$FRAMEWORK_DIR/Resources"
  echo "PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz4KPCFET0NUWVBFIHBsaXN0IFBVQkxJQyAiLS8vQXBwbGUvL0RURCBQTElTVCAxLjAvL0VOIiAiaHR0cDovL3d3dy5hcHBsZS5jb20vRFREcy9Qcm9wZXJ0eUxpc3QtMS4wLmR0ZCI+CjxwbGlzdCB2ZXJzaW9uPSIxLjAiPgo8ZGljdD4KICAgIDxrZXk+Q0ZCdW5kbGVEZXZlbG9wbWVudFJlZ2lvbjwva2V5PgogICAgPHN0cmluZz5FbmdsaXNoPC9zdHJpbmc+CiAgICA8a2V5PkNGQnVuZGxlSWRlbnRpZmllcjwva2V5PgogICAgPHN0cmluZz5vcmcucHl0aG9uLnB5dGhvbjwvc3RyaW5nPgogICAgPGtleT5DRkJ1bmRsZUluZm9EaWN0aW9uYXJ5VmVyc2lvbjwva2V5PgogICAgPHN0cmluZz42LjA8L3N0cmluZz4KICAgIDxrZXk+Q0ZCdW5kbGVOYW1lPC9rZXk+CiAgICA8c3RyaW5nPlB5dGhvbjwvc3RyaW5nPgogICAgPGtleT5DRkJ1bmRsZVBhY2thZ2VUeXBlPC9rZXk+CiAgICA8c3RyaW5nPkZNV0s8L3N0cmluZz4KICAgIDxrZXk+Q0ZCdW5kbGVTaG9ydFZlcnNpb25TdHJpbmc8L2tleT4KICAgIDxzdHJpbmc+My4xMjwvc3RyaW5nPgogICAgPGtleT5DRkJ1bmRsZVNpZ25hdHVyZTwva2V5PgogICAgPHN0cmluZz4/Pz8/PC9zdHJpbmc+CiAgICA8a2V5PkNGQnVuZGxlVmVyc2lvbjwva2V5PgogICAgPHN0cmluZz4zLjEyPC9zdHJpbmc+CjwvZGljdD4KPC9wbGlzdD4=" | base64 --decode > "$FRAMEWORK_DIR/Resources/Info.plist"
  cp "$FRAMEWORK_DIR/Resources/Info.plist" "$FRAMEWORK_DIR/Info.plist"
  echo "✨ [Fix] Info.plist created successfully at $FRAMEWORK_DIR/Resources/Info.plist and $FRAMEWORK_DIR/Info.plist"
fi

echo "Step 1: Sign Mach-O files, dylibs, and shared libraries"
find "$SIDECAR_DIR" -type f | while IFS= read -r file; do
  base="$(basename "$file")"

  if file "$file" | grep -q "Mach-O"; then
    echo "Signing Mach-O: $file"
    codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$file"
  elif [[ "$file" == *.so || "$file" == *.dylib ]]; then
    echo "Signing library: $file"
    codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$file"
  elif [[ -x "$file" || "$base" == "Python" ]]; then
    echo "Signing executable-like file: $file"
    codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$file"
  fi
done

echo "Step 2: Sign framework directories after inner binaries"
find "$SIDECAR_DIR" -type d -name "*.framework" | while IFS= read -r framework; do
  echo "Signing framework: $framework"
  codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$framework" || true
done

echo "Step 3: Sign sidecar directory container if codesign accepts it"
codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$SIDECAR_DIR" || true

echo "Step 4: Verify important signatures"
find "$SIDECAR_DIR" -type f | while IFS= read -r file; do
  if file "$file" | grep -q "Mach-O"; then
    echo "Verifying Mach-O: $file"
    codesign --verify --verbose=2 "$file"
  fi
done

find "$SIDECAR_DIR" -type d -name "*.framework" | while IFS= read -r framework; do
  echo "Verifying framework: $framework"
  codesign --verify --deep --strict --verbose=2 "$framework" || true
done
