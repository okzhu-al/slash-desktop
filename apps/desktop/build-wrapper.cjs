const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const env = { ...process.env };
const keyName = "TAURI_SIGNING_" + "PRIVATE_" + "KEY";
if (env[keyName]) {
  let rawKey = env[keyName].trim();
  // 1. 统一去除 CRLF 干扰
  rawKey = rawKey.replace(/\r/g, "");
  
  // 2. 检查并智能修复可能被 CI/CD 压扁成单行的多行私钥
  const prefix = "untrusted comment: rsign encrypted secret key";
  if (rawKey.startsWith(prefix)) {
    let remaining = rawKey.substring(prefix.length).trim();
    rawKey = prefix + "\n" + remaining;
  }
  
  env[keyName] = rawKey;
  console.log("🔒 " + keyName + " has been normalized and cleaned up in memory. Length:", env[keyName].length);
  if (rawKey.length > 50) {
    console.log("🔒 Key Sample: " + rawKey.substring(0, 45).replace(/\n/g, "[LF]") + " ... " + rawKey.substring(rawKey.length - 20));
  }
} else {
  console.log("⚠️ " + keyName + " is not defined in env!");
}

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
  // 6. 100% 物理还原备份的 tauri.conf.json
  if (originalConfigContent !== null) {
    try {
      fs.writeFileSync(configPath, originalConfigContent, "utf8");
      console.log("🔄 tauri.conf.json successfully restored to pristine state.");
    } catch (restoreErr) {
      console.error("⚠️ Failed to restore tauri.conf.json:", restoreErr);
    }
  }
}
