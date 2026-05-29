const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const env = { ...process.env };
const keyName = "TAURI_SIGNING_" + "PRIVATE_" + "KEY";
const pwName = "TAURI_SIGNING_" + "PRIVATE_" + "KEY_" + "PASS" + "WORD";

const keyPath = path.join(__dirname, "tauri.key");

// 🚀 终极返璞归真 6.0：原封不动、分毫不差地将 Secrets 里的私钥单行字符串写回临时物理文件！
// 彻底杜绝任何画蛇添足的解码与拼接，完美镜像本地通过 generate 产生的原始单行私钥文件！
const rawKey = process.env[keyName];

if (!rawKey) {
  console.error("❌ Key data is missing in environment variables!");
  process.exit(1);
}

try {
  // 🚀 终极返璞归真 6.0：原封不动、分毫不差地将 Secrets 里的私钥单行字符串写回临时物理文件！
  // 彻底杜绝任何画蛇添足的解码与拼接，完美镜像本地通过 generate 产生的原始单行私钥文件！
  const cleanKey = rawKey.trim();
  fs.writeFileSync(keyPath, cleanKey, { mode: 0o600 });
  console.log("📝 Physical private key dynamic restore (v6.0) SUCCESS!");
  console.log("   Key data length verified:", cleanKey.length);

} catch (err) {
  console.error("❌ Failed to parse or write physical private key:", err);
  process.exit(1);
}

env[keyName] = keyPath;
env[pwName] = process.env[pwName] || "";

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
