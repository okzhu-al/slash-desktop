const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const sidecarDir = path.join(rootDir, 'apps/desktop/src-tauri/binaries/slash-sidecar-aarch64-apple-darwin');

if (process.platform === 'darwin') {
    if (fs.existsSync(sidecarDir)) {
        console.log("🔐 [Tauri Builder] macOS platform detected. Executing recursive codesign on Python Sidecar binaries and libraries...");
        try {
            // 递归对 .so, .dylib 以及 main sidecar 二进制文件执行 codesign 强签名
            const cmd = `find "${sidecarDir}" -type f \\( -name "*.so" -o -name "*.dylib" -o -name "slash-sidecar-aarch64-apple-darwin" \\) -exec codesign --force --options runtime --timestamp --sign "Developer ID Application: Jasper Zhu (H83XQSDL83)" {} \\;`;
            execSync(cmd, { stdio: 'inherit' });
            console.log("✨ [Tauri Builder] Codesign completed successfully.");
        } catch (err) {
            console.error("❌ [Tauri Builder] Codesign failed:", err);
            process.exit(1);
        }
    } else {
        console.log("ℹ️ [Tauri Builder] Sidecar binaries directory not found at " + sidecarDir + ", skipping codesign.");
    }
} else {
    console.log(`ℹ️ [Tauri Builder] Non-macOS platform (${process.platform}) detected. Skipping codesign.`);
}
