#!/bin/bash
set -euo pipefail

SIDECAR_DIR="apps/desktop/src-tauri/binaries/slash-sidecar-aarch64-apple-darwin"
SIGN_IDENTITY="Developer ID Application: Jasper Zhu (H83XQSDL83)"

echo "Signing macOS sidecar directory: $SIDECAR_DIR"

if [ ! -d "$SIDECAR_DIR" ]; then
  echo "ERROR: sidecar directory not found: $SIDECAR_DIR"
  exit 1
fi

echo "Step 1: Sign all physical Mach-O files, libraries, and executables"
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

echo "Step 2: Verify all physical signatures"
find "$SIDECAR_DIR" -type f | while IFS= read -r file; do
  if file "$file" | grep -q "Mach-O"; then
    echo "Verifying Mach-O: $file"
    codesign --verify --verbose=2 "$file"
  fi
done
