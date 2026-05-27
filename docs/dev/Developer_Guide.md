# Slash 开发者指南：三仓拆分、安全脱敏与 CI/CD 签名公证架构

本指南面向 Slash 核心开发团队，详细阐述主 monorepo 仓库的整理规范、自动化镜像同步流水线、敏感数据安全脱敏技术，以及在脱敏后如何通过 CI/CD（GitHub Actions）安全地执行 macOS 桌面端签名与苹果官方公证（Notarization）。

---

## 一、三仓发布策略概述

为了在保障核心商业逻辑与服务端代码私密性的同时，向公众开放 Desktop 桌面端源码，项目采用**三仓拆分与镜像发布策略**：

| 仓库名称 | 可见性 | 定位 | 是否直接开发 |
| :--- | :--- | :--- | :--- |
| **`slash`** | **Private** | 主开发仓，包含完整前后端 Monorepo 源码（唯一真实源） | **是** |
| **`slash-desktop`** | **Public** | 对外发布的桌面端开源镜像仓（Local-First，完全解耦） | 否（仅由脚本同步生成） |
| **`slash-server`** | **Private** | 用于内测/团队私有部署的服务端镜像仓 | 否（仅由脚本同步生成） |

### 开发纪律约束
1. **唯一修改源**：所有代码编写、新特性开发都必须在 `slash` 私有主仓中进行。
2. **严禁直接修改镜像仓**：绝对不在 `slash-desktop` 或 `slash-server` 中直接修改代码（除非紧急 hotfix，且修改必须第一时间手动回拔至主仓 `slash`）。

---

## 二、本地工作目录结构与清理规范

### 1. 推荐的本地目录布局
未来本地的开发目录应保持如下结构：
```text
~/Projects/
  ├── slash/            # 主 Monorepo 开发仓 (Private)
  ├── slash-desktop/    # 桌面端发布镜像仓 (Public)
  └── slash-server/     # 服务端发布镜像仓 (Private)
```

### 2. 垃圾文件与临时产物清理
主仓配置了严格的 [.gitignore](file:///Users/junior/Projects/slash/.gitignore) 规则，以下文件在同步时会被自动物理剔除，日常开发中也严禁将其提交：
* 构建产物：`target/`、`dist/`、`build/`、`src-tauri/target/`
* 依赖库：`node_modules/`、`.pnpm-store/`
* 日志文件：`*.log`（如 `build-error.log`、`undo_debug.log`）
* 临时与缓存：`tmp/`、`temp/`、`tmp_*/`、`.cache/`、`tmp_pm/`、`temp_skip/`
* 敏感配置：`.env`、真实 `.env.*`（如 `.env.production`，仅允许提交 `.env.example` 模板）

---

## 三、敏感数据扫描与防护机制

为了防止任何机密、私钥或凭证意外泄露至 GitHub 公共仓，主仓内置了高标准的安检机制。

### 1. 全局敏感词扫描器 (`scripts/check-sensitive.sh`)
通过运行 `./scripts/check-sensitive.sh`，脚本会：
* 扫描代码中是否含有明文的敏感词，包括：`SECRET`、`TOKEN`、`PASSWORD`、`PRIVATE_KEY`、`AWS_`、`OPENAI`、`ANTHROPIC`、`DATABASE_URL`、`TAURI_PRIVATE`、`APPLE`、`CERT`、`MINIO`、`SENTRY` 等。
* 过滤无需审计的目录：如 `.git`、`node_modules`、`Cargo.lock`、`pnpm-lock.yaml` 及文档目录。
* 检查敏感文件模式（如 `.env*` 真实配置文件、`*.pem`、`*.key`、`*.p12`、`*.mobileprovision`）。

---

## 四、自动化镜像同步与修剪流水线

主仓中提供了以下发布脚本，用于将代码同步至外部镜像仓库：

* **`scripts/publish-desktop.sh`**（公开桌面镜像同步）
* **`scripts/publish-server.sh`**（私有服务镜像同步）
* **`scripts/publish-all.sh`**（级联同步总控）

### 1. `publish-desktop.sh` 核心工作流
当运行桌面端同步脚本时，会自动化执行以下四个解耦与安全防护步骤：

#### 步骤 A：物理隔离与 rsync 同步
清空目标 `../slash-desktop` 文件夹（**保留 `.git` 目录以维护 Git 提交历史**），接着使用 `rsync` 白名单同步桌面应用、侧边栏、共享包、patches 以及公共文档。**强制排除 `apps/server` 服务端源码**。

#### 步骤 B：Workspace 自动重构与依赖剥离
* **修剪 Rust 依赖**：使用内置 Python 脚本自动读取目标仓中的 `Cargo.toml`，并原地（In-place）删除 `"apps/server"` workspace 成员：
  ```python
  content = content.replace("    \"apps/server\",\n", "")
  ```
* **修剪 Node 依赖**：原地修改 `pnpm-workspace.yaml`，只保留公共桌面成员，剔除 `server`：
  ```yaml
  packages:
    - "apps/desktop"
    - "apps/python-sidecar"
    - "packages/*"
  ```
通过这种方式，使得 `slash-desktop` 成为一个完美的、可独立编译运行的 Local-First 客户端项目。

#### 步骤 C：硬核证书与密码脱敏
在同步到镜像仓的过程中，Python 脚本会扫描 `apps/desktop/package.json` 中的 `scripts` 部分，**利用正则表达式自动把硬编码的 Apple ID、专用应用密码和团队 ID 抹去**，还原成干净的标准化 Tauri 指令：

```python
# 脱敏前：
# "tauri": "APPLE_ID=zhu.jh.qiqi@gmail.com APPLE_PASSWORD='hheu-tdsl-chck-auet' APPLE_TEAM_ID=H83XQSDL83 tauri"

# 脱敏后（自动重写为）：
# "tauri": "tauri"
# "tauri:build": "tauri build"
```

#### 步骤 D：安全扫描与熔断机制
同步完成后，会在目标镜像仓目录中强制执行敏感字审计。**一旦发现任何疑似密码或密钥残留，脚本会立即抛出 ERROR 强行中断发布过程**，防止意外泄漏。

---

## 五、脱敏后 CI/CD 自动签名与苹果公证架构

抹去 `package.json` 中的硬编码苹果凭证后，为了让 GitHub Actions (CI/CD) 仍能打包出拥有苹果官方签名与公证 (Notarization) 认证、双击运行时不报“未知开发者”警告的 `.dmg` / `.app` 安装包，我们采用**托管凭证 (Secrets) + 动态注入**的安全架构。

### 1. GitHub Actions 密钥库 (Secrets) 配置
在 GitHub 镜像仓库的 `Settings -> Secrets and variables -> Actions` 中，配置以下安全 Secrets：

| Secret 键名 | 说明 | 示例/获取途径 |
| :--- | :--- | :--- |
| **`APPLE_ID`** | 苹果开发者账号邮箱 | `zhu.jh.qiqi@gmail.com` |
| **`APPLE_PASSWORD`** | 苹果开发者专用应用密码 | 在 `appleid.apple.com` 后台生成 (格式如 `aaaa-bbbb-cccc-dddd`) |
| **`APPLE_TEAM_ID`** | 苹果团队 ID | 苹果开发者后台 (10位字符串，如 `H83XQSDL83`) |
| **`APPLE_CERTIFICATE`** | 代码签名证书的 Base64 字符串 | 将导出的 `Developer ID Application.p12` 证书转换为 Base64 保存 |
| **`APPLE_CERTIFICATE_PASSWORD`** | `.p12` 证书的提取密码 | 导出证书时设置的密码 |
| **`TAURI_PRIVATE_KEY`** | Tauri 自动更新签名私钥 | Tauri CLI 生成的公私钥对中的私钥内容 |
| **`TAURI_KEY_PASSWORD`** | Tauri 自动更新私钥密码 | 生成私钥时设定的密码（若有） |

### 2. CI/CD 打包流水线配置示例
在 `slash-desktop` 镜像仓下的 `.github/workflows/release.yml` 中配置如下工作流，即可自动完成代码签名、向苹果服务器发送公证请求，并自动上传打包好的 dmg 产物：

```yaml
name: "Publish Desktop Release"

on:
  push:
    tags:
      - 'v*' # 当推送版本标签 (如 v1.0.0) 时触发

jobs:
  publish-tauri:
    permissions:
      contents: write
    runs-on: macos-latest # 苹果签名与公证必须在 macOS 容器中运行
    
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install Rust
        uses: dtolnay/rust-toolchain@stable

      # ----------------------------------------------------------------
      # 步骤 1：动态将 Secrets 中的加密 Base64 证书解码并导入 macOS 钥匙串
      # ----------------------------------------------------------------
      - name: Import Apple Code Signing Certificates
        uses: apple-actions/import-codesign-certs@v3
        with:
          p12-file-base64: ${{ secrets.APPLE_CERTIFICATE }}
          p12-password: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}

      - name: Install pnpm & dependencies
        run: |
          npm install -g pnpm
          pnpm install

      # ----------------------------------------------------------------
      # 步骤 2：注入机密环境变量，运行 Tauri 编译、签名与苹果公证
      # ----------------------------------------------------------------
      - name: Build and Notarize Tauri App
        run: pnpm tauri build
        env:
          # 将 GitHub Secrets 动态注入为编译时环境变量
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_KEY_PASSWORD }}

      # ----------------------------------------------------------------
      # 步骤 3：自动将公证无误的发布包发布至 GitHub Release 页面
      # ----------------------------------------------------------------
      - name: Upload Artifacts to Release
        uses: softprops/action-gh-release@v2
        with:
          files: |
            apps/desktop/src-tauri/target/share/bundle/dmg/*.dmg
            apps/desktop/src-tauri/target/share/bundle/macos/*.app
```

---

## 六、日常发布标准操作流程 (SOP)

当您在主仓开发并验证了新功能后，请严格遵循以下 SOP 进行镜像发布：

1. **第一步：主仓本地测试与提交**
   确保主仓所有改动本地测试无误：
   ```bash
   pnpm build
   cargo check
   git add .
   git commit -m "feat: your new feature"
   ```

2. **第二步：运行敏感扫描，杜绝泄密**
   ```bash
   ./scripts/check-sensitive.sh
   ```

3. **第三步：一键运行同步脚本**
   ```bash
   ./scripts/publish-all.sh
   ```

4. **第四步：推送 `slash-desktop` 镜像仓 (Public)**
   ```bash
   cd ../slash-desktop
   git status --short      # 仔细核对改动，确保没有 apps/server
   git diff                # 查看差异
   git add .
   git commit -m "feat: sync desktop features"
   git tag v1.0.0          # (可选) 打上版本 tag 触发 GitHub Action 自动签名公证
   git push origin main --tags
   ```

5. **第五步：推送 `slash-server` 镜像仓 (Private)**
   ```bash
   cd ../slash-server
   git status --short      # 确保只有服务端及共享核心依赖
   git add .
   git commit -m "feat: sync server features"
   git push origin main
   ```

通过本套脱敏与签名公证架构，不仅极大解放了多仓维护的生产力，更将代码开发质量、开源安全性及企业级 CI/CD 认证安全性提升到了行业顶尖水准！
