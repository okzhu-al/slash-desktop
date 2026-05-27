#!/bin/bash
# 🍏 Slash macOS App 全自动签名、公证、凭证钉入与 DMG 打包一键构建脚本

set -e

# ==========================================
# 💎 苹果官方公证密钥信息注入 (单引号完美防御 $ 字符变量失效)
# ==========================================
export APPLE_ID="zhu.jh.qiqi@gmail.com"
export APPLE_PASSWORD='hheu-tdsl-chck-auet'
export APPLE_TEAM_ID="H83XQSDL83"

# ==========================================
# 🔐 Python Sidecar 内部嵌套二进制 & .so 递归代码签名
# ==========================================
SIDECAR_DIR="$(dirname "$0")/apps/desktop/src-tauri/binaries/slash-sidecar-aarch64-apple-darwin"
if [ -d "$SIDECAR_DIR" ]; then
  echo "🔐 [Slash Notarizer] 正在对 Python Sidecar 嵌套的全部二进制和 .so 文件执行递归代码签名..."
  find "$SIDECAR_DIR" -type f \( -name "*.so" -o -name "*.dylib" -o -name "slash-sidecar-aarch64-apple-darwin" \) -exec codesign --force --options runtime --timestamp --sign "Developer ID Application: Jasper Zhu (H83XQSDL83)" {} \;
  echo "✅ [Slash Notarizer] Sidecar 深度递归代码签名成功完成！"
else
  echo "⚠️ [Slash Notarizer] 未检测到 Sidecar 物理路径，跳过递归签名。"
fi

echo "=========================================================="
echo "🍎 [Slash Notarizer] 正在为您开启 macOS 平台全自动签名公证构建流水线..."
echo "👤 Apple ID: $APPLE_ID"
echo "🆔 Team ID: $APPLE_TEAM_ID"
echo "=========================================================="

# 确保脚本即使在子目录下启动也能正确定位根目录
cd "$(dirname "$0")/apps/desktop"

# 启动全自动打包公证
echo "🔨 [1/2] 启动前端静态资产编译与 Tauri Native Bundler 构建..."
npx tauri build

echo "🍏 [2/2] Apple 公证流程已在打包过程中自动完成，Ticket 已自动 Stapled 钉入程序包！"
echo "🎉 终极发布版公证 DMG 镜像构建成功！"
echo "📂 生成路径: /Users/junior/Projects/slash/target/release/bundle/dmg/"
echo "=========================================================="
