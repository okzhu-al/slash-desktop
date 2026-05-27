# Slash Note App

Slash is a local-first, modern knowledge management and collaboration tool built with Tauri, React, and Rust.

## Beta Architecture

### English
Slash Desktop is local-first and can run without the Slash Server.
During beta, this repository contains the public desktop client, local runtime, editor packages, and shared protocol types.
The Slash Server is private during beta while we stabilize team sync, permissions, asset transfer, and managed collaboration features.
Personal use and small teams are free during beta. Official Sync, hosted team collaboration, and larger team usage require beta access or a commercial license.

### 中文
Slash Desktop 是本地优先应用，可以在不依赖 Slash Server 的情况下完整运行。
内测阶段，本仓库公开 Desktop 客户端、本地运行时、编辑器包和共享协议类型。
Slash Server 在内测阶段保持私有。我们会先稳定团队同步、权限模型、资源传输和托管协作能力，再决定后续开放方式。
内测期间，个人使用和小团队使用免费。官方同步、托管团队协作和更大规模团队使用需要内测资格或商业许可。

---

## Repository Hierarchy

- `apps/desktop` - Main Tauri desktop application.
- `apps/python-sidecar` - Local helper sidecar.
- `packages/js-editor-core` - Highly customized TipTap-based rich text editor component.
- `packages/js-shared-types` - Shared JS type definitions.
- `packages/slash-core` - Core Rust knowledge management libraries.
- `packages/slash-sync-proto` - Shared synchronization protocols.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [pnpm](https://pnpm.io/) (v8+)
- [Rust & Cargo](https://www.rust-lang.org/) (v1.75+)

### Local Development

1. **Install Dependencies**:
   ```bash
   pnpm install
   ```

2. **Run Desktop Client in Development**:
   ```bash
   pnpm --filter tauri-appslash dev
   ```

## Documentation

For more architecture details and developmental design guides, please refer to the `docs/` folder:
- [Repository Mirroring](file:///Users/junior/Projects/slash/docs/dev/MIRRORING.md)
