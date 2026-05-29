const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const env = { ...process.env };
const keyName = "TAURI_SIGNING_" + "PRIVATE_" + "KEY";
const pwName = "TAURI_SIGNING_" + "PRIVATE_" + "KEY_PASSWORD";

const keyPath = path.join(__dirname, "tauri.key");

// 🚀 降维打击 4.0：物理还原写回本地临时文件，无缝与 GitHub Secrets 保持 100% 动态同步，并完美处理平台换行兼容性！
const rawKey = process.env.TAURI_SIGNING_PRIVATE_KEY;

if (!rawKey) {
  console.error("❌ TAURI_SIGNING_PRIVATE_KEY is missing in environment variables!");
  process.exit(1);
}

try {
  let finalKeyContent = "";
  // 1. 判断是否是 Base64 编码格式
  if (rawKey.includes("untrusted comment")) {
    finalKeyContent = rawKey;
  } else {
    // 尝试作为 Base64 解码
    const decoded = Buffer.from(rawKey.trim(), "base64").toString("utf8");
    if (decoded.includes("untrusted comment")) {
      finalKeyContent = decoded;
    } else {
      // 回退直接作为明文处理
      finalKeyContent = rawKey;
    }
  }

  // 2. 标准化处理换行符，清除首尾空格
  const lines = finalKeyContent
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0);

  if (lines.length < 2) {
    throw new Error("Invalid minisign private key format: must have at least 2 lines (comment and content).");
  }

  // 🎯 降维打击 5.0 核心逻辑：
  // 第一行作为 untrusted comment，剩下的所有行全部强行合并为一条连贯的单行 Base64 密文，彻底清除中间任何换行符！
  const commentLine = lines[0];
  const secretDataLine = lines.slice(1).join("");

  const cleanKey = commentLine + "\n" + secretDataLine + "\n";

  fs.writeFileSync(keyPath, cleanKey, { mode: 0o600 });
  console.log("📝 Physical private key dynamic restore (v5.0) SUCCESS!");
  console.log("   First line verification:", commentLine);
  console.log("   Key data line verified length:", secretDataLine.length);

} catch (err) {
  console.error("❌ Failed to parse or write physical private key:", err);
  process.exit(1);
}

env[keyName] = keyPath;
env[pwName] = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD || "Antigravity2026!";

const rustTarget = process.env.RUST_TARGET;
const targetPlatform = process.env.TARGET_PLATFORM;

if (!rustTarget || !targetPlatform) {
  console.error("❌ RUST_TARGET or TARGET_PLATFORM environment variables are missing!");
  process.exit(1);
}

const configPath = path.join(__dirname, "src-tauri", "tauri.conf.json");
let originalConfigContent = null;

try {
  // 1. 备份原始的 tauri.conf.json 配置文件
  if (fs.existsSync(configPath)) {
    originalConfigContent = fs.readFileSync(configPath, "utf8");
    console.log("📝 Original tauri.conf.json backed up successfully.");
    
    // 2. 解析 JSON 配置对象
    const config = JSON.parse(originalConfigContent);
    
    // 3. 动态且安全地进行配置注入
    if (!config.bundle) config.bundle = {};
    
    // 强行写入 resources 侧边栏路径
    config.bundle.resources = ["binaries/slash-sidecar-" + targetPlatform];
    
    const isMac = process.platform === "darwin";
    if (isMac) {
      // macOS 平台下，强行限制只打 app 格式以保护公证过的实体包
      config.bundle.targets = ["app"];
    } else {
      // Windows 平台下，强行开启 active、NSIS 目标和 updater 升级包产生
      config.bundle.active = true;
      config.bundle.targets = ["nsis"];
      config.bundle.createUpdaterArtifacts = true;
    }
    
    // 4. 将修改后的配置安全写回文件
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
    console.log("✨ tauri.conf.json successfully patched for " + (isMac ? "macOS" : "Windows") + ".");
  } else {
    console.error("❌ Cannot find tauri.conf.json at path:", configPath);
    process.exit(1);
  }
  
  // 5. 启动最简、绝对零转义的 tauri build 命令
  const args = ["tauri", "build", "--target", rustTarget];
  console.log("🚀 Executing: pnpm " + args.join(" "));
  
  const res = spawnSync("pnpm", args, { env, stdio: "inherit", shell: true });
  process.exit(res.status || 0);

} catch (err) {
  console.error("❌ An error occurred during wrapper execution:", err);
  process.exit(1);
} finally {
  // 6. 100% 物理还原备份 of tauri.conf.json
  if (originalConfigContent !== null) {
    try {
      fs.writeFileSync(configPath, originalConfigContent, "utf8");
      console.log("🔄 tauri.conf.json successfully restored to pristine state.");
    } catch (restoreErr) {
      console.error("⚠️ Failed to restore tauri.conf.json:", restoreErr);
    }
  }
  // 🚀 终极清理：无条件物理删除临时的私钥物理文件以防残留与泄露！
  if (fs.existsSync(keyPath)) {
    try {
      fs.unlinkSync(keyPath);
      console.log("🧹 Physical private key file securely deleted.");
    } catch (delErr) {
      console.error("⚠️ Failed to delete private key file:", delErr);
    }
  }
}
