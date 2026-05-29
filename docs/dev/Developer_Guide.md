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

### 开发纪律与发版规范约束

#### 1. 唯一修改源
- **核心原则**：所有代码编写、新特性开发、版本号修改都**必须且只能在 `slash` 私有主仓中进行**。
- **严禁直接修改镜像仓**：绝对不在 `slash-desktop` 或 `slash-server` 中直接修改代码（任何直接在分仓做出的改动都只会被同步脚本无情覆盖抹除）。

#### 2. 发版原则（Tag-Triggered Release）
- **Commit/Push 不发版**：日常的普通 commit 与 push 仅用于在仓库中记录和沉淀代码，**绝不会触发任何远程 Actions 构建或发布**。这不仅能保持 GitHub Releases 页面极其干净，更是对 Actions 算力与额度的科学管理。
- **Tag 触发构建**：**只有通过推送新的版本 Tag（如 `v0.1.1-beta.23`）**，才会正式启动 GitHub Actions 的全套编译、代码签名、苹果公证以及 Release 发布。客户端也只会在检测到已上架 Release 的新版本时自动或手动拉取更新。

#### 3. 发布节奏规范
- **日常小修**：只 commit / push 记录，不推进版本号，不打 Tag 发版。
- **累积迭代**：累积了一批开发特征（Features）或日常缺陷修复后，在 `apps/desktop/package.json` 与 `apps/desktop/src-tauri/tauri.conf.json` 中统一推进版本号（**两处版本号必须 100% 保持完全一致**），提交并推送 Tag 执行阶段性发布。
- **紧急热修（Hotfix）**：发生阻断性严重 Bug 时，可以立刻修改版本号，提交并单独推送 Tag 进行紧急 Hotfix 发布。

#### 4. 热更新发布规则 (Updater Strategy)
- **坚决采用方案 A（每次全量覆盖）**：基于 Gatekeeper 跨进程权限控制和 macOS/Windows 操作系统对未在 App 容器内进行苹果公证（Notarized）的“动态野外二进制文件”的封杀与隔离防御（极易报木马误杀或直接杀死进程），**热更新坚决不采用任何“主程序与 Python Sidecar 剥离、用户本地数据目录下动态解压运行”的碎片化方案**。
- **绝对的安全性与高可用性**：每次热更新，统一通过官方内置的 Tauri Updater 机制下载包含了已公证 Python Sidecar 的全量 `.tar.gz` 升级包（在现代网络环境下 100-200MB 的包体大小通常 3 - 5 秒即可下载完毕，体验极佳）进行整体覆盖物理更新，确保 100% 的极高稳定度与签名合规性，将崩溃率降至零点！

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

第一次干净推送
1. 发布公共 Desktop 仓库 (Public)
```bash
cd ../slash-desktop
git add .
git commit -m "Initial public desktop beta"
# 在 GitHub 上新建名为 slash-desktop 的公共仓库并推送
git remote add origin git@github.com:<your-org>/slash-desktop.git
git push -u origin main
```

2. 发布私有 Server 仓库 (Private)
```bash
cd ../slash-server
git add .
git commit -m "Update server private mirror"
# 在 GitHub 上新建名为 slash-server 的私有仓库并推送
git remote add origin git@github.com:<your-org>/slash-server.git
git push -u origin main
```

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

---

## 七、发版时序、自动更新与签名回填 SOP

为了确保最终用户能够百分之百顺畅地进行在线版本检测与热升级，发版过程必须严格防范**更新通道时序竞争（Race Condition）**与**云端构建死循环（Build Loop）**。以下是基于项目工程实践的最佳发布闭环流程规范：

### 1. 核心工程原理与设计逻辑

#### 1.1 更新空档期的安全拦截（时序竞争防范）
如果我们在云端 Actions 打包编译之前，就把包含了新版本号的 `update.json` 推送到云端公开分仓的 `main` 分支上，那么：
* 在 Actions 漫长的编译和苹果官方公证（通常需要 5 - 15 分钟）空档期中，云端的 `update.json` 已经是新版，但 `signature` 仍是初始的占位符。
* 期间若有任何客户端用户点击“检查更新”，客户端能成功发现并下载升级包，但会由于**签名校验失败**直接抛出“安装包损坏”错误，破坏用户体验。
* **隔离设计**：在发版时，我们**只打 Tag 并单独推送 Tag，绝对不要提前将包含新版号的 `update.json` 推送到镜像仓的 `main` 分支**。云端 `main` 的 `update.json` 保持在旧版本，客户端在空档期内不会检测到任何更新。

#### 1.2 为什么必须“双向回填”？（唯一修改源的捍卫）
* **主仓沉淀**：我们必须将最新拉取到的真实数字签名也同步回填写入**主仓** `/update.json`。否则，下一次您在主仓开发功能并运行同步脚本 `./scripts/publish-all.sh` 时，分仓里填好的 `update.json` 就会被主仓中过时的配置**强行物理覆盖和抹除**！
* **分仓发布**：分仓 `/update.json` 推送到 `main` 分支，担任轻量级静态 CDN 配置，向客户端分发更新。

#### 1.3 静态 CDN 抓取（绕过 API 403 限流拦截）
* 自动填充签名脚本 `auto_update_windows_sig.py` 在运行轮询时，不请求 GitHub 限流极严（每小时 60 次）的 REST API，而是直接高频轮询 **GitHub Releases 的原始静态下载 CDN 地址**（不受 API 频次限流约束），在网络抖动时具备极强的生命力，完全不会产生“急性猝死”。

#### 1.4 Tag 触发构建唯一性（规避构建死循环）
* 镜像分仓的 CI/CD 被配置为仅在 `push.tags: ['v*']` 时启动。因此，脚本在回填完成后向分仓 `main` 分支推送的 `git push origin main` 动作**绝对不会二次触发 GitHub Actions 编译**，彻底避开了“推送配置 -> 触发编译 -> 生成新签名 -> 再次回填推送 -> 再次触发编译”的恐怖死循环黑洞。

---

### 2. 完美的正式发版标准 SOP (Tag-to-Release)

> [!IMPORTANT]
> **发版前的绝对红线纪律：必须同步推进 `update.json` 版号并执行 `publish`**
> 在分仓打 Tag 触发云端 CI/CD 构建之前，不仅要在主仓中升级 `package.json` 和 `tauri.conf.json` 的版本号，**还必须在主仓的 [/update.json](file:///Users/junior/Projects/slash/update.json) 中将版本号推进为新版本、同步更新下载 URL，并必须立即执行 `./scripts/publish-all.sh` 级联同步拷贝到分仓目录中！**
> 如果遗漏了发版前的 `publish` 拷贝步骤就直接打 Tag 构建，Actions 产生签名后，我们在本地运行填充脚本时，脚本会将最新的数字签名强行灌入本地版本号还是旧版（如 `.40`）的分仓 `update.json` 里并直接推上云端。这将导致**“版本号与签名错位”**的奇特现象（云端 JSON 版本仍显示为旧版，客户端比对时认为已是最新版，导致全球更新通道彻底卡死！）。

当您准备正式向所有客户端用户推送升级（如 `v0.1.1-beta.41`）时，请按照以下绝对安全的流程进行操作：

#### 第一步：版本号同步与推进（主仓）
1. 在主仓的 `apps/desktop/package.json` 与 `tauri.conf.json` 中，推进版本号至新版。
2. 同步在主仓的 [/update.json](file:///Users/junior/Projects/slash/update.json) 中，将 `"version"` 字段改为新版本号，将 `url` 分别指向新版本的下载链接，**保持 signature 字段为占位符不变**。
3. **【绝对红线】**在主仓执行同步，将所有配置和版号物理同步分发到分仓中：`./scripts/publish-all.sh`。

#### 第二步：只推送 Tag 触发构建（分仓）
1. 进入镜像仓目录 `../slash-desktop`。
2. 提交本地改动，并**打上版本 Tag，仅推送该 Tag，切勿推送 `main` 分支**：
   ```bash
   cd ../slash-desktop
   git add .
   git commit -m "feat: release v0.1.1-beta.41"
   git tag v0.1.1-beta.41
   git push origin v0.1.1-beta.41  # 👈 仅推送版本 Tag！
   ```
   *(此时云端 Actions 正常拉起，开始长达 10 分钟的代码签名和 Notarization 公证。在此期间云端 `main` 分支上的 `update.json` 仍为旧版，空档期被安全隔离)*。

#### 第三步：一键运行自动签名填充脚本（主仓）
1. 回到主仓目录，运行签名填充服务：
   ```bash
   cd ../slash
   python3 scratch/auto_update_windows_sig.py
   ```
2. 该脚本会自动：
   * 读取我们第一步在主仓 `update.json` 里预设好的新版本号。
   * 启动长轮询，从 GitHub CDN 稳定拉取最新的 macOS 与 Windows 的真实公钥签名。
   * 将真实签名双向安全填写入**主仓**与**分仓**本地的两个 `update.json` 文件中。
   * **自动进入分仓目录，执行提交并将回填后的 `update.json` 正式 push 推送到云端分仓的 `main` 分支！**

#### 第四步：收尾与沉淀
1. 脚本回填并推送完成后，我们在主仓的 git 历史中，将本地已填充了真实签名的高清 `update.json` 提交并推送：
   ```bash
   cd ../slash
   git add update.json
   git commit -m "chore: auto-populate dual-platform updater signatures for v0.1.1-beta.41"
   git push
   ```
2. 至此，发版流程以零多余磁盘 I/O 开销、零脏代码外泄风险、零时序校验报错的完美姿态闭环落幕！

