const { spawnSync } = require("child_process");

const env = { ...process.env };
const keyName = "TAURI_SIGNING_" + "PRIVATE_" + "KEY";
if (env[keyName]) {
  env[keyName] = env[keyName].replace(/\r/g, "");
  console.log("🔒 " + keyName + " has been cleaned up in memory (CRLF removed). Length:", env[keyName].length);
} else {
  console.log("⚠️ " + keyName + " is not defined in env!");
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

console.log("🚀 Executing: pnpm " + args.join(" "));
const res = spawnSync("pnpm", args, { env, stdio: "inherit", shell: true });
process.exit(res.status || 0);
