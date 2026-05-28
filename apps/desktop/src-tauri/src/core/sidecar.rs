//! Sidecar 进程管理器
//!
//! 管理 Python MarkItDown sidecar 的生命周期：启动、端口发现、崩溃恢复。
//! Sidecar 通过 stdout 输出 `SIDECAR_READY:{port}` 信号通知可用端口。
//!
//! 使用 std::process 而非 tauri-plugin-shell，无需额外插件依赖。

use std::io::BufRead;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

// ── 配置常量 ──

/// 最大自动重启次数
const MAX_RESTART_ATTEMPTS: u32 = 3;
/// 健康检查间隔（秒）— 模型加载/视频转写可能阻塞数十秒，需放宽
const HEALTH_CHECK_INTERVAL_SECS: u64 = 60;
/// 健康检查超时（毫秒）
const HEALTH_CHECK_TIMEOUT_MS: u64 = 5000;
/// 连续失败多少次后触发重启 — 需要容忍长时间阻塞操作
const HEALTH_CHECK_FAIL_THRESHOLD: u32 = 5;

// ── 全局端口 ──

/// 全局 sidecar 端口（由 SidecarManager::start 设置）
static GLOBAL_SIDECAR_PORT: OnceLock<Arc<Mutex<Option<u16>>>> = OnceLock::new();

/// 从任意位置获取 sidecar base URL（无需 Tauri State）
pub fn get_sidecar_base_url() -> String {
    if let Some(port_lock) = GLOBAL_SIDECAR_PORT.get() {
        if let Ok(port) = port_lock.lock() {
            if let Some(p) = *port {
                return format!("http://127.0.0.1:{}", p);
            }
        }
    }
    // Fallback to Docker-era address for backward compatibility
    "http://localhost:3722".to_string()
}

// ── Sidecar 内部共享状态 ──

/// 所有线程（stdout reader、health checker、try_restart）共享的状态
#[derive(Clone)]
struct SidecarShared {
    port: Arc<Mutex<Option<u16>>>,
    child: Arc<Mutex<Option<Child>>>,
    binary_path: Arc<Mutex<Option<PathBuf>>>,
    restart_count: Arc<Mutex<u32>>,
    is_shutting_down: Arc<AtomicBool>,
}

// ── SidecarManager ──

/// Sidecar 管理器状态
pub struct SidecarManager {
    shared: SidecarShared,
}

impl SidecarManager {
    pub fn new() -> Self {
        let port = Arc::new(Mutex::new(None));
        // Register port to global so backend threads can access without Tauri State
        let _ = GLOBAL_SIDECAR_PORT.set(port.clone());
        Self {
            shared: SidecarShared {
                port,
                child: Arc::new(Mutex::new(None)),
                binary_path: Arc::new(Mutex::new(None)),
                restart_count: Arc::new(Mutex::new(0)),
                is_shutting_down: Arc::new(AtomicBool::new(false)),
            },
        }
    }

    /// 获取 sidecar 的 base URL。如果 sidecar 未就绪则返回 None。
    pub fn base_url(&self) -> Option<String> {
        self.shared
            .port
            .lock()
            .ok()
            .and_then(|p| p.map(|port| format!("http://127.0.0.1:{}", port)))
    }

    /// 获取 sidecar 的 base URL，如果未就绪则 fallback 到旧的 Docker 地址。
    pub fn base_url_or_fallback(&self) -> String {
        self.base_url()
            .unwrap_or_else(|| "http://localhost:3722".to_string())
    }

    /// 定位 sidecar 二进制路径
    fn find_sidecar_binary() -> Option<PathBuf> {
        let target_triple = Self::current_target_triple();
        let binary_name = format!("slash-sidecar-{}", target_triple);

        // Windows 上 PyInstaller 输出的可执行文件带 .exe 后缀
        let exe_name = if cfg!(target_os = "windows") {
            format!("{}.exe", binary_name)
        } else {
            binary_name.clone()
        };

        // 1. 检查 App Support 目录 (生产模式，独立更新)
        if let Some(app_support) = dirs::data_dir() {
            let app_path = app_support
                .join("Slash")
                .join("sidecar")
                .join(&binary_name)
                .join(&exe_name);
            if app_path.exists() {
                log::info!("🔧 [Sidecar] Found at: {:?}", app_path);
                return Some(app_path);
            }
            // 也检查不带 .exe 的路径（兼容旧版）
            let app_path_legacy = app_support
                .join("Slash")
                .join("sidecar")
                .join(&binary_name);
            if app_path_legacy.exists() {
                log::info!("🔧 [Sidecar] Found at (legacy): {:?}", app_path_legacy);
                return Some(app_path_legacy);
            }
        }

        // 2. 检查与可执行文件同级的 binaries 目录 (打包模式)
        if let Ok(exe) = std::env::current_exe() {
            if let Some(exe_dir) = exe.parent() {
                // macOS: Slash.app/Contents/MacOS/slash → ../Resources/binaries/
                let resources = exe_dir
                    .parent()
                    .unwrap_or(exe_dir)
                    .join("Resources")
                    .join("binaries")
                    .join(&binary_name)
                    .join(&exe_name);
                if resources.exists() {
                    return Some(resources);
                }
                
                // macOS v2 fallback: without "binaries" subfolder in Resources
                let resources_v2 = exe_dir
                    .parent()
                    .unwrap_or(exe_dir)
                    .join("Resources")
                    .join(&binary_name)
                    .join(&exe_name);
                if resources_v2.exists() {
                    return Some(resources_v2);
                }

                // Flat layout (Windows/Linux)
                let flat = exe_dir.join("binaries").join(&binary_name).join(&exe_name);
                if flat.exists() {
                    return Some(flat);
                }
            }
        }

        // 3. 开发模式: src-tauri/binaries/ (onedir 结构: dir/exe)
        let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(&binary_name)
            .join(&exe_name);
        if dev_path.exists() {
            return Some(dev_path);
        }

        log::warn!("🔧 [Sidecar] Binary not found: {}", binary_name);
        None
    }

    fn current_target_triple() -> &'static str {
        if cfg!(target_os = "macos") {
            if cfg!(target_arch = "aarch64") {
                "aarch64-apple-darwin"
            } else {
                "x86_64-apple-darwin"
            }
        } else if cfg!(target_os = "windows") {
            "x86_64-pc-windows-msvc"
        } else {
            "x86_64-unknown-linux-gnu"
        }
    }

    /// 清理可能遗留的僵尸进程
    fn kill_existing_sidecars() {
        let target_triple = Self::current_target_triple();
        let binary_name = format!("slash-sidecar-{}", target_triple);
        
        #[cfg(target_os = "windows")]
        {
            let exe_name = format!("{}.exe", binary_name);
            let _ = std::process::Command::new("taskkill")
                .args(["/F", "/IM", &exe_name])
                .output();
        }

        #[cfg(unix)]
        {
            let _ = std::process::Command::new("pkill")
                .arg("-f")
                .arg(&binary_name)
                .output();
        }
    }

    /// 启动 sidecar 进程
    pub fn start(&self) -> Result<(), String> {
        // 检查是否已在运行
        if let Ok(port) = self.shared.port.lock() {
            if port.is_some() {
                log::info!("🔧 [Sidecar] Already running on port {}", port.unwrap());
                return Ok(());
            }
        }

        // P1-1: 安装分发 + 版本兼容性检查
        if let Err(e) = self.ensure_sidecar_installed() {
            log::warn!("🔧 [Sidecar] Install check warning: {}", e);
        }
        if let Err(e) = self.check_version_compatibility() {
            log::warn!("🔧 [Sidecar] Version check warning: {}", e);
        }

        // 清理旧的遗留进程，防止开发阶段 pnpm tauri dev 产生僵尸进程堆积
        Self::kill_existing_sidecars();

        let binary = Self::find_sidecar_binary()
            .ok_or_else(|| "Sidecar binary not found".to_string())?;

        // macOS 动态修复嵌套 Python Framework 软链，治愈 codesign 物理抹除导致的启动缺陷
        #[cfg(target_os = "macos")]
        {
            if let Some(sidecar_dir) = binary.parent() {
                let framework_dir = sidecar_dir.join("_internal").join("Python.framework");
                let framework_python_link = framework_dir.join("Python");
                let target_python_binary = framework_dir.join("Versions").join("3.12").join("Python");
                
                if target_python_binary.exists() {
                    let needs_create = if framework_python_link.exists() {
                        if let Ok(metadata) = std::fs::symlink_metadata(&framework_python_link) {
                            !metadata.file_type().is_symlink()
                        } else {
                            true
                        }
                    } else {
                        true
                    };

                    if needs_create {
                        log::info!("🔧 [Sidecar] Dynamically creating macOS Python.framework/Python relative symlink...");
                        if framework_python_link.exists() || framework_python_link.is_symlink() {
                            let _ = std::fs::remove_file(&framework_python_link);
                        }
                        if let Err(e) = std::os::unix::fs::symlink("Versions/3.12/Python", &framework_python_link) {
                            log::error!("❌ [Sidecar] Failed to create dynamic symlink: {}", e);
                        } else {
                            log::info!("✅ [Sidecar] Dynamic symlink created successfully!");
                        }
                    }
                }
            }
        }

        // 缓存二进制路径，供 try_restart 复用
        if let Ok(mut bp) = self.shared.binary_path.lock() {
            *bp = Some(binary.clone());
        }

        // 重置关闭标志
        self.shared.is_shutting_down.store(false, Ordering::SeqCst);

        Self::spawn_process(&self.shared, &binary)?;

        // 启动健康检查线程
        self.start_health_checker();

        Ok(())
    }

    /// P1-1: 确保 App Support 中有 sidecar，若无则从 bundle 复制
    fn ensure_sidecar_installed(&self) -> Result<(), String> {
        let target_triple = Self::current_target_triple();
        let binary_name = format!("slash-sidecar-{}", target_triple);

        let app_support = dirs::data_dir()
            .ok_or_else(|| "Cannot determine App Support directory".to_string())?;
        let dest_dir = app_support.join("Slash").join("sidecar").join(&binary_name);

        // 如果 App Support 已有 sidecar 且存在 version.json，跳过
        let version_file_internal = dest_dir.join("_internal").join("version.json");
        let version_file_root = dest_dir.join("version.json");
        let has_version = version_file_internal.exists() || version_file_root.exists();

        if dest_dir.exists() && has_version {
            return Ok(());
        }

        if dest_dir.exists() {
            log::warn!(
                "🔧 [Sidecar] Sidecar directory {:?} exists but version.json is missing (incomplete installation). Re-installing...",
                dest_dir
            );
            let _ = std::fs::remove_dir_all(&dest_dir);
        }

        // 从 bundle Resources 复制
        let bundle_source = self.find_bundle_sidecar_dir(&binary_name);
        if let Some(source) = bundle_source {
            log::info!("🔧 [Sidecar] Installing from bundle: {:?} → {:?}", source, dest_dir);
            Self::copy_dir_recursive(&source, &dest_dir)?;

            // 设置可执行权限 (Unix)
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let exe_path = dest_dir.join(&binary_name);
                if exe_path.exists() {
                    let _ = std::fs::set_permissions(
                        &exe_path,
                        std::fs::Permissions::from_mode(0o755),
                    );
                }
            }
            log::info!("🔧 [Sidecar] Installation complete");
        }

        Ok(())
    }

    /// P1-1: 版本兼容性检查与静默升级 — 比对 bundle 与 installed 的版本进行双向同步
    fn check_version_compatibility(&self) -> Result<(), String> {
        let target_triple = Self::current_target_triple();
        let binary_name = format!("slash-sidecar-{}", target_triple);

        let app_support = match dirs::data_dir() {
            Some(d) => d,
            None => return Ok(()),
        };
        let sidecar_dir = app_support.join("Slash").join("sidecar").join(&binary_name);
        let version_file = sidecar_dir.join("_internal").join("version.json");

        // 也检查根目录（PyInstaller --add-data 放在此处）
        let version_file = if version_file.exists() {
            version_file
        } else {
            let alt = sidecar_dir.join("version.json");
            if alt.exists() {
                alt
            } else {
                // 无 version.json，跳过检查
                return Ok(());
            }
        };

        let content = std::fs::read_to_string(&version_file)
            .map_err(|e| format!("Failed to read version.json: {}", e))?;

        // 解析 JSON
        let json: serde_json::Value = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse version.json: {}", e))?;

        let min_app_version_str = json
            .get("min_app_version")
            .and_then(|v| v.as_str())
            .unwrap_or("0.0.0");
        let sidecar_version_str = json
            .get("sidecar_version")
            .and_then(|v| v.as_str())
            .unwrap_or("0.0.0");

        let app_version = semver::Version::parse(env!("CARGO_PKG_VERSION"))
            .unwrap_or_else(|_| semver::Version::new(0, 0, 0));
        let min_app = semver::Version::parse(min_app_version_str)
            .unwrap_or_else(|_| semver::Version::new(0, 0, 0));
        let installed_sidecar_ver = semver::Version::parse(sidecar_version_str)
            .unwrap_or_else(|_| semver::Version::new(0, 0, 0));

        // 读取 bundle 里的 sidecar 版本
        let mut bundle_sidecar_ver = semver::Version::new(0, 0, 0);
        let bundle_source = self.find_bundle_sidecar_dir(&binary_name);
        if let Some(ref source) = bundle_source {
            let b_version_file = source.join("_internal").join("version.json");
            let b_version_file = if b_version_file.exists() {
                b_version_file
            } else {
                source.join("version.json")
            };
            if b_version_file.exists() {
                if let Ok(b_content) = std::fs::read_to_string(&b_version_file) {
                    if let Ok(b_json) = serde_json::from_str::<serde_json::Value>(&b_content) {
                        if let Some(b_ver_str) = b_json.get("sidecar_version").and_then(|v| v.as_str()) {
                            if let Ok(parsed) = semver::Version::parse(b_ver_str) {
                                bundle_sidecar_ver = parsed;
                            }
                        }
                    }
                }
            }
        }

        log::info!(
            "🔧 [Sidecar] Version check: installed_sidecar={}, bundle_sidecar={}, min_app={}, current_app={}",
            installed_sidecar_ver,
            bundle_sidecar_ver,
            min_app_version_str,
            app_version
        );

        let need_downgrade = app_version < min_app;
        let need_upgrade = bundle_sidecar_ver > installed_sidecar_ver;

        if need_downgrade || need_upgrade {
            if need_downgrade {
                log::warn!(
                    "🔧 [Sidecar] Installed sidecar (v{}) requires app >= {} but current app is {}. Downgrading to bundle version.",
                    sidecar_version_str,
                    min_app_version_str,
                    app_version
                );
            } else {
                log::info!(
                    "🔧 [Sidecar] Bundle has newer sidecar (v{}) than installed (v{}). Upgrading...",
                    bundle_sidecar_ver,
                    installed_sidecar_ver
                );
            }

            if let Some(source) = bundle_source {
                // 删除旧版本
                let _ = std::fs::remove_dir_all(&sidecar_dir);
                Self::copy_dir_recursive(&source, &sidecar_dir)?;

                // 设置可执行权限 (Unix)
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let exe_path = sidecar_dir.join(&binary_name);
                    if exe_path.exists() {
                        let _ = std::fs::set_permissions(
                            &exe_path,
                            std::fs::Permissions::from_mode(0o755),
                        );
                    }
                }
                log::info!("🔧 [Sidecar] Sidecar updated from bundle successfully");
            }
        }

        Ok(())
    }

    /// 查找 bundle 内的 sidecar 目录
    fn find_bundle_sidecar_dir(&self, binary_name: &str) -> Option<PathBuf> {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(exe_dir) = exe.parent() {
                // macOS: Contents/MacOS/ → ../Resources/binaries/{name}/
                let resources = exe_dir
                    .parent()
                    .unwrap_or(exe_dir)
                    .join("Resources")
                    .join("binaries")
                    .join(binary_name);
                if resources.exists() {
                    return Some(resources);
                }

                // macOS v2 fallback: without "binaries" subfolder in Resources
                let resources_v2 = exe_dir
                    .parent()
                    .unwrap_or(exe_dir)
                    .join("Resources")
                    .join(binary_name);
                if resources_v2.exists() {
                    return Some(resources_v2);
                }

                // Flat layout (Windows/Linux): binaries/{name}/
                let flat = exe_dir.join("binaries").join(binary_name);
                if flat.exists() {
                    return Some(flat);
                }
            }
        }
        None
    }

    /// 递归复制目录 (完备处理 Unix 软链接，防止 std::fs::copy 实体化污染)
    fn copy_dir_recursive(src: &PathBuf, dst: &PathBuf) -> Result<(), String> {
        std::fs::create_dir_all(dst)
            .map_err(|e| format!("Failed to create directory {:?}: {}", dst, e))?;

        let entries = std::fs::read_dir(src)
            .map_err(|e| format!("Failed to read directory {:?}: {}", src, e))?;

        for entry in entries {
            let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
            let src_path = entry.path();
            let dst_path = dst.join(entry.file_name());

            // 使用 symlink_metadata 获取元数据，不追踪软链接
            let metadata = std::fs::symlink_metadata(&src_path)
                .map_err(|e| format!("Failed to read metadata for {:?}: {}", src_path, e))?;

            if metadata.file_type().is_symlink() {
                #[cfg(unix)]
                {
                    let target = std::fs::read_link(&src_path)
                        .map_err(|e| format!("Failed to read symlink target for {:?}: {}", src_path, e))?;
                    // 如果目标软链已经存在，删除它以防冲突
                    if dst_path.exists() || dst_path.is_symlink() {
                        let _ = std::fs::remove_file(&dst_path);
                    }
                    std::os::unix::fs::symlink(&target, &dst_path)
                        .map_err(|e| format!("Failed to create symlink {:?} → {:?}: {}", dst_path, target, e))?;
                }
                #[cfg(not(unix))]
                {
                    // 非 Unix 平台 fallback 物理复制
                    std::fs::copy(&src_path, &dst_path)
                        .map_err(|e| format!("Failed to copy legacy symlink {:?} → {:?}: {}", src_path, dst_path, e))?;
                }
            } else if src_path.is_dir() {
                Self::copy_dir_recursive(&src_path, &dst_path)?;
            } else {
                std::fs::copy(&src_path, &dst_path)
                    .map_err(|e| format!("Failed to copy file {:?} → {:?}: {}", src_path, dst_path, e))?;
            }
        }

        Ok(())
    }

    /// 内部：spawn sidecar 子进程并设置 stdout/stderr reader
    fn spawn_process(shared: &SidecarShared, binary: &PathBuf) -> Result<(), String> {
        log::info!("🔧 [Sidecar] Starting: {:?}", binary);

        #[allow(unused_mut)]
        let mut command = Command::new(binary);
        command.stdin(Stdio::piped())
               .stdout(Stdio::piped())
               .stderr(Stdio::piped());

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = command.spawn()
            .map_err(|e| format!("Failed to spawn sidecar: {}", e))?;

        // Read stdout to capture SIDECAR_READY signal
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to capture sidecar stdout".to_string())?;

        let shared_for_reader = shared.clone();

        // Spawn thread to read stdout — doubles as crash watchdog
        std::thread::spawn(move || {
            let reader = std::io::BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(text) => {
                        let trimmed = text.trim();
                        if let Some(port_str) = trimmed.strip_prefix("SIDECAR_READY:") {
                            if let Ok(port) = port_str.parse::<u16>() {
                                log::info!("🔧 [Sidecar] Ready on port {}", port);
                                if let Ok(mut p) = shared_for_reader.port.lock() {
                                    *p = Some(port);
                                }
                                // 启动成功，重置重启计数
                                if let Ok(mut rc) = shared_for_reader.restart_count.lock() {
                                    *rc = 0;
                                }
                            }
                        } else if !trimmed.is_empty() {
                            log::info!("🔧 [Sidecar] {}", trimmed);
                        }
                    }
                    Err(_) => break,
                }
            }

            // stdout 关闭 = 进程退出
            log::warn!("🔧 [Sidecar] stdout reader exited — process died");

            // 清除端口
            if let Ok(mut p) = shared_for_reader.port.lock() {
                *p = None;
            }

            // 如果不是主动关闭，则尝试自动重启
            if !shared_for_reader.is_shutting_down.load(Ordering::SeqCst) {
                Self::try_restart(&shared_for_reader);
            }
        });

        // Pipe stderr to log
        if let Some(stderr) = child.stderr.take() {
            std::thread::spawn(move || {
                let reader = std::io::BufReader::new(stderr);
                for line in reader.lines() {
                    if let Ok(text) = line {
                        if !text.trim().is_empty() {
                            log::warn!("🔧 [Sidecar] stderr: {}", text.trim());
                        }
                    }
                }
            });
        }

        // Store child
        if let Ok(mut c) = shared.child.lock() {
            *c = Some(child);
        }

        Ok(())
    }

    /// 尝试自动重启 sidecar（指数退避）
    fn try_restart(shared: &SidecarShared) {
        if shared.is_shutting_down.load(Ordering::SeqCst) {
            return;
        }

        let attempt = {
            let mut rc = match shared.restart_count.lock() {
                Ok(rc) => rc,
                Err(_) => return,
            };
            *rc += 1;
            *rc
        };

        if attempt > MAX_RESTART_ATTEMPTS {
            log::error!(
                "🔧 [Sidecar] Max restart attempts ({}) reached — giving up",
                MAX_RESTART_ATTEMPTS
            );
            return;
        }

        // 指数退避：1s, 2s, 4s
        let delay = Duration::from_secs(1u64 << (attempt - 1));
        log::warn!(
            "🔧 [Sidecar] Restart attempt {}/{} in {:?}",
            attempt,
            MAX_RESTART_ATTEMPTS,
            delay
        );
        std::thread::sleep(delay);

        // 再次检查是否在关闭中
        if shared.is_shutting_down.load(Ordering::SeqCst) {
            return;
        }

        let binary = match shared.binary_path.lock() {
            Ok(bp) => match bp.as_ref() {
                Some(p) => p.clone(),
                None => {
                    log::error!("🔧 [Sidecar] No cached binary path for restart");
                    return;
                }
            },
            Err(_) => return,
        };

        match Self::spawn_process(shared, &binary) {
            Ok(()) => {
                log::info!("🔧 [Sidecar] Restart spawn succeeded (attempt {})", attempt);
            }
            Err(e) => {
                log::error!("🔧 [Sidecar] Restart spawn failed: {}", e);
                // spawn 失败也消耗了一次重试配额，如果还有配额继续重试
                if attempt < MAX_RESTART_ATTEMPTS {
                    Self::try_restart(shared);
                }
            }
        }
    }

    /// 启动后台健康检查线程
    fn start_health_checker(&self) {
        let shared = self.shared.clone();

        std::thread::spawn(move || {
            // 等待首次启动完成
            std::thread::sleep(Duration::from_secs(HEALTH_CHECK_INTERVAL_SECS));

            let mut consecutive_failures: u32 = 0;

            loop {
                if shared.is_shutting_down.load(Ordering::SeqCst) {
                    log::info!("🔧 [Sidecar] Health checker stopping (shutdown)");
                    break;
                }

                // 仅在有端口时做健康检查
                let port = match shared.port.lock() {
                    Ok(p) => *p,
                    Err(_) => None,
                };

                if let Some(p) = port {
                    let url = format!("http://127.0.0.1:{}/health", p);
                    match Self::http_get_ok(&url) {
                        true => {
                            if consecutive_failures > 0 {
                                log::info!("🔧 [Sidecar] Health check recovered after {} failures", consecutive_failures);
                            }
                            consecutive_failures = 0;
                            // 健康检查成功，重置重启计数
                            if let Ok(mut rc) = shared.restart_count.lock() {
                                *rc = 0;
                            }
                        }
                        false => {
                            consecutive_failures += 1;
                            log::warn!(
                                "🔧 [Sidecar] Health check failed ({}/{})",
                                consecutive_failures,
                                HEALTH_CHECK_FAIL_THRESHOLD
                            );

                            if consecutive_failures >= HEALTH_CHECK_FAIL_THRESHOLD {
                                log::error!("🔧 [Sidecar] Health check threshold reached — killing and restarting");
                                consecutive_failures = 0;

                                // Kill 当前进程
                                if let Ok(mut child) = shared.child.lock() {
                                    if let Some(mut c) = child.take() {
                                        let _ = c.kill();
                                        let _ = c.wait();
                                    }
                                }
                                if let Ok(mut p) = shared.port.lock() {
                                    *p = None;
                                }

                                // 尝试重启
                                Self::try_restart(&shared);
                            }
                        }
                    }
                }

                std::thread::sleep(Duration::from_secs(HEALTH_CHECK_INTERVAL_SECS));
            }
        });
    }

    /// 简单的阻塞式 HTTP GET 检查（仅判断是否返回 200）
    fn http_get_ok(url: &str) -> bool {
        // 使用 std::net 做最简单的 TCP 连接 + HTTP 请求，避免引入异步依赖
        use std::io::{Read, Write};
        use std::net::TcpStream;

        let url_str = url.strip_prefix("http://").unwrap_or(url);
        let (host_port, path) = match url_str.find('/') {
            Some(i) => (&url_str[..i], &url_str[i..]),
            None => (url_str, "/"),
        };

        let stream = match TcpStream::connect(host_port) {
            Ok(s) => s,
            Err(_) => return false,
        };
        let _ = stream.set_read_timeout(Some(Duration::from_millis(HEALTH_CHECK_TIMEOUT_MS)));
        let _ = stream.set_write_timeout(Some(Duration::from_millis(HEALTH_CHECK_TIMEOUT_MS)));

        let mut stream = stream;
        let request = format!("GET {} HTTP/1.0\r\nHost: {}\r\n\r\n", path, host_port);
        if stream.write_all(request.as_bytes()).is_err() {
            return false;
        }

        let mut response = [0u8; 64];
        match stream.read(&mut response) {
            Ok(n) if n > 12 => {
                let resp_str = String::from_utf8_lossy(&response[..n]);
                resp_str.contains("200")
            }
            _ => false,
        }
    }

    /// 关闭 sidecar 进程
    pub fn shutdown(&self) {
        // 先标记关闭中，防止 watchdog/reader 触发自动重启
        self.shared.is_shutting_down.store(true, Ordering::SeqCst);

        if let Ok(mut child) = self.shared.child.lock() {
            if let Some(mut c) = child.take() {
                log::info!("🔧 [Sidecar] Shutting down...");
                let _ = c.kill();
                let _ = c.wait();
            }
        }
        if let Ok(mut p) = self.shared.port.lock() {
            *p = None;
        }
    }
}

impl Drop for SidecarManager {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Tauri State wrapper
pub struct SidecarState(pub SidecarManager);
