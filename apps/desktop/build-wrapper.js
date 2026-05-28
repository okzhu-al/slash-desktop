const { spawnSync } = require("child_process");

const env = { ...process.env };
if (env.TAURI_SIGNING_PRIVATE_KEY) {
  env.TAURI_SIGNING_PRIVATE_KEY = env.TAURI_SIGNING_PRIVATE_KEY.replace(/\r/g, "");
  console.log("🔒 TAURI_SIGNING_PRIVATE_KEY has been cleaned up in memory (CRLF removed). Length:", env.TAURI_SIGNING_PRIVATE_KEY.length);
} else {
  console.log("⚠️ TAURI_SIGNING_PRIVATE_KEY is not defined in env!");
}

const rustTarget = process.env.RUST_TARGET;
const targetPlatform = process.env.TARGET_PLATFORM;

if (!rustTarget || !targetPlatform) {
  console.error("❌ RUST_TARGET or TARGET_PLATFORM environment variables are missing!");
  process.exit(1);
}

const args = ["tauri", "build", "--target", rustTarget];
const isMac = process.platform === "darwin";

const config = {
  bundle: {
    resources: ["binaries/slash-sidecar-" + targetPlatform]
  }
};

if (isMac) {
  args.push("--bundles", "app");
} else {
  config.bundle.active = true;
  config.bundle.targets = ["nsis"];
  config.bundle.createUpdaterArtifacts = true;
}

args.push("--config", JSON.stringify(config));

console.log("🚀 Executing: npx " + args.join(" "));
const res = spawnSync("npx", args, { env, stdio: "inherit", shell: true });
process.exit(res.status || 0);
