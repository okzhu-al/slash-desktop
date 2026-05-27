# Tauri v2 Auto-Updater Implementation Plan

This document outlines the architecture and steps required to enable the online auto-update feature for the Slash application across macOS and Windows.

## 1. Key Management & Security
Enabling the updater requires generating cryptographic keys to sign the update packages. 
- Run: `npx tauri signer generate -w ~/.tauri/slash.key`
- Keep the Private Key secure and add it to the GitHub Repository Secrets as `TAURI_SIGNING_PRIVATE_KEY`.
- The Public Key will be embedded in `tauri.conf.json`.

## 2. Update Delivery Method (GitHub Releases)
We need a place to host a static `update.json` file so the app knows when a new version is available.
- **Approach:** CI (GitHub Actions) automatically generates this `update.json` file and attaches it as an asset to the GitHub Release.
- **Endpoint:** The app will poll `https://github.com/okzhu-al/slash/releases/latest/download/update.json`.

## 3. Configuration & Infrastructure

### 3.1. `tauri.conf.json`
- Add the `updater` configuration inside the `plugins` object.
- Configure the endpoint to point to the GitHub releases latest download URL.
- Inject the generated Public Key.

### 3.2. `.github/workflows/release.yml`
- Inject `TAURI_SIGNING_PRIVATE_KEY` into the `tauri build` step.
- Ensure the updater artifacts (`.tar.gz`, `.zip`, and `.sig` files) are captured and uploaded to the GitHub release.
- **[New CI Step]** Add a script to dynamically generate `update.json` based on the built artifacts and their `.sig` signatures, and upload it as a release asset.

## 4. Code Changes

### 4.1. Backend (Rust)
- Add `tauri-plugin-updater = "2"` to `apps/desktop/src-tauri/Cargo.toml`.
- Register the updater plugin: `.plugin(tauri_plugin_updater::Builder::new().build())` in `apps/desktop/src-tauri/src/lib.rs`.

### 4.2. Frontend (React)
- Install `@tauri-apps/plugin-updater` in `apps/desktop/package.json`.
- Create an `UpdateChecker` React component.
- Implement the update logic: listen for update events and display an "Update Available" modal with release notes and a download progress bar.

## 5. Verification Plan
1. Generate dummy keys locally to verify the build process succeeds without CI.
2. After the keys are added to GitHub Secrets, trigger a dummy release on GitHub.
3. Install the previous client, open it, and verify that the "Update Available" prompt appears, downloads the update, and restarts smoothly.
