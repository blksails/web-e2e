use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex};

use once_cell::sync::{Lazy, OnceCell};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

/// 应用层持久路径 —— 在 setup() 里填好一次，之后同步读取。
struct AppPaths {
    app_data_dir: PathBuf,
    resource_dir: PathBuf,
}
static APP_PATHS: OnceCell<AppPaths> = OnceCell::new();

/// 活跃子进程表：job_id -> Child。
/// 用于 kill_job 停止正在跑的任务。
static JOBS: Lazy<Arc<Mutex<HashMap<String, Child>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashMap::new())));

#[derive(Clone, Debug, Serialize)]
struct LogEvent {
    job: String,
    kind: String, // stdout | stderr | status | error
    line: String,
}

#[derive(Debug, Deserialize)]
struct RunArgs {
    job: String,
    /// pnpm 子命令参数数组，例如 ["test:smoke"] 或 ["record", "--", "--name", "x"]
    args: Vec<String>,
    /// 额外环境变量（例如 test:any 需要 E2E_SPEC_DIR）
    #[serde(default)]
    env: Option<HashMap<String, String>>,
}

/// 找到包含 package.json 的 e2e 项目根。
/// 优先级：
/// 1. 环境变量 E2E_PROJECT_ROOT （显式指定，测试人员可用）
/// 2. 当前工作目录向上最多 5 级查找 package.json+playwright.config
/// 3. 可执行文件所在目录向上查找（Mac .app bundle 场景）
/// 4. 报错：空路径，上层会感知并提示用户
static PROJECT_ROOT_CACHE: Lazy<StdMutex<Option<PathBuf>>> =
    Lazy::new(|| StdMutex::new(None));

fn project_root() -> PathBuf {
    let mut guard = PROJECT_ROOT_CACHE.lock().unwrap();
    if guard.is_none() {
        *guard = Some(resolve_project_root_inner());
    }
    guard.as_ref().cloned().unwrap_or_default()
}

fn invalidate_project_root() {
    if let Ok(mut guard) = PROJECT_ROOT_CACHE.lock() {
        *guard = None;
    }
}

fn looks_like_project(dir: &Path) -> bool {
    // package.json 必须存在 + 看起来像 e2e 项目（有 playwright.config.* 或 tests/）
    if !dir.join("package.json").exists() {
        return false;
    }
    dir.join("playwright.config.ts").exists()
        || dir.join("playwright.config.js").exists()
        || dir.join("tests").is_dir()
}

fn walk_up_for_project(mut dir: PathBuf, depth: usize) -> Option<PathBuf> {
    for _ in 0..=depth {
        if looks_like_project(&dir) {
            return Some(dir);
        }
        if !dir.pop() {
            break;
        }
    }
    None
}

fn resolve_project_root_inner() -> PathBuf {
    // 1. 显式环境变量（最高优先，便于工程师调试）
    if let Some(env) = std::env::var_os("E2E_PROJECT_ROOT") {
        let p = PathBuf::from(env);
        if looks_like_project(&p) {
            return p;
        }
    }
    // 2. 用户在 UI 保存的全局配置
    if let Some(saved) = read_global_config()
        .and_then(|c| c.project_root)
        .map(PathBuf::from)
    {
        if looks_like_project(&saved) {
            return saved;
        }
    }
    // 3. 已解压的默认模板（只在桌面构建后首次点"用默认模板"后存在）
    if let Some(paths) = APP_PATHS.get() {
        let tpl = paths.app_data_dir.join("template-project");
        if looks_like_project(&tpl) {
            return tpl;
        }
    }
    // 4. cwd 向上最多 5 级（dev 模式：pnpm desktop 从项目根跑）
    if let Ok(cwd) = std::env::current_dir() {
        if let Some(p) = walk_up_for_project(cwd, 5) {
            return p;
        }
    }
    // 5. 可执行文件目录向上最多 6 级（Mac .app/Contents/MacOS 下需要多爬几级）
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            if let Some(p) = walk_up_for_project(parent.to_path_buf(), 6) {
                return p;
            }
        }
    }
    PathBuf::new()
}

// ---------- 全局桌面配置：跟当前项目解耦，按用户账号存在 app_data_dir ----------

#[derive(Debug, Default, Serialize, Deserialize, Clone)]
struct GlobalConfig {
    #[serde(default)]
    project_root: Option<String>,
}

fn global_config_path() -> Option<PathBuf> {
    APP_PATHS
        .get()
        .map(|p| p.app_data_dir.join("desktop-global.json"))
}

fn read_global_config() -> Option<GlobalConfig> {
    let path = global_config_path()?;
    let text = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_global_config(cfg: &GlobalConfig) -> Result<(), String> {
    let path = global_config_path().ok_or_else(|| "app_data_dir 未初始化".to_string())?;
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let text = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_global_config() -> GlobalConfig {
    read_global_config().unwrap_or_default()
}

#[tauri::command]
fn set_project_root(path: String) -> Result<(), String> {
    let trimmed = path.trim().to_string();
    if trimmed.is_empty() {
        return Err("路径不能为空".into());
    }
    let p = PathBuf::from(&trimmed);
    if !p.exists() {
        return Err(format!("路径不存在：{}", trimmed));
    }
    if !looks_like_project(&p) {
        return Err(
            "该目录不像是 e2e 项目：找不到 package.json + playwright.config 或 tests/ 目录。"
                .into(),
        );
    }
    let mut cfg = read_global_config().unwrap_or_default();
    cfg.project_root = Some(trimmed);
    write_global_config(&cfg)?;
    invalidate_project_root();
    Ok(())
}

#[tauri::command]
fn clear_project_root() -> Result<(), String> {
    let mut cfg = read_global_config().unwrap_or_default();
    cfg.project_root = None;
    write_global_config(&cfg)?;
    invalidate_project_root();
    Ok(())
}

fn template_zip_path() -> Option<PathBuf> {
    APP_PATHS.get().and_then(|p| {
        // dev 模式 resource_dir 可能不同于 build 模式 — 尝试多个位置
        for candidate in [
            p.resource_dir.join("template-project.zip"),
            p.resource_dir.join("_up_").join("template-project.zip"),
        ] {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        None
    })
}

#[tauri::command]
fn template_available() -> bool {
    template_zip_path().is_some()
}

/// 在项目根写入一个健壮的 .npmrc（若不存在）。
/// 用 hoisted 模式规避 Windows 上 pnpm 的 -4094 抖动、深路径、硬链接 AV 误报。
/// 已存在的 .npmrc 不碰，防止覆盖用户配置。
#[tauri::command]
fn ensure_npmrc() -> Result<String, String> {
    let root = project_root();
    if root.as_os_str().is_empty() {
        return Err("项目目录未找到".into());
    }
    let path = root.join(".npmrc");
    if path.exists() {
        return Ok(format!("保留已有 {}（未改动）", path.display()));
    }
    let content = "# Written by BlackSail Desktop to avoid Windows FS flakiness\nnode-linker=hoisted\npackage-import-method=copy\nauto-install-peers=true\nstrict-peer-dependencies=false\n";
    std::fs::write(&path, content).map_err(|e| format!("写入失败：{e}"))?;
    Ok(format!("已写入 {}", path.display()))
}

/// 删除 project_root 下的 node_modules —— 用于"修复安装"时的 clean reinstall。
/// 只动 node_modules 本身，别的都不碰。
#[tauri::command]
fn wipe_node_modules() -> Result<(), String> {
    let root = project_root();
    if root.as_os_str().is_empty() {
        return Err("项目目录未找到".into());
    }
    let nm = root.join("node_modules");
    if !nm.exists() {
        return Ok(()); // 没得可删，等同成功
    }
    if !nm.is_dir() {
        return Err("node_modules 存在但不是目录".into());
    }
    // 安全保险：只允许删 project_root 正下方的 node_modules
    let parent_ok = nm.parent().map(|p| p == root).unwrap_or(false);
    if !parent_ok {
        return Err("node_modules 不在项目根下，已阻止删除".into());
    }
    std::fs::remove_dir_all(&nm).map_err(|e| format!("删除失败：{e}"))?;
    Ok(())
}

#[tauri::command]
fn default_template_dest() -> Result<String, String> {
    APP_PATHS
        .get()
        .map(|p| p.app_data_dir.join("template-project").to_string_lossy().into_owned())
        .ok_or_else(|| "app_data_dir 未初始化".to_string())
}

/// 把资源里的 template-project.zip 解压到指定目录（默认 app_data_dir/template-project），
/// 并把全局配置的 project_root 指向它。若目标已是 e2e 项目且未强制覆盖则复用。
///
/// 参数：
///   dest_dir: 可选。不给就用 app_data_dir/template-project。
///   force:    true 时删除已有目录后重新解压；false 且目标已是有效项目则复用。
#[tauri::command]
fn extract_template(
    dest_dir: Option<String>,
    force: Option<bool>,
) -> Result<String, String> {
    let paths = APP_PATHS
        .get()
        .ok_or_else(|| "app_data_dir 未初始化".to_string())?;
    let zip_path = template_zip_path().ok_or_else(|| {
        "当前构建不含默认模板（只有 `pnpm desktop:build` 产出的安装包会把模板打进去）。".to_string()
    })?;

    let dest: PathBuf = match dest_dir.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => {
            let p = PathBuf::from(s);
            if !p.is_absolute() {
                return Err("目标路径必须是绝对路径".into());
            }
            p
        }
        None => paths.app_data_dir.join("template-project"),
    };

    // 安全：不允许解压到文件之上
    if dest.exists() && dest.is_file() {
        return Err(format!("{} 已存在且是个文件，不能解压到这里", dest.display()));
    }

    let should_extract = force.unwrap_or(false) || !looks_like_project(&dest);
    if should_extract {
        // 目标目录已存在又强制覆盖 → 清空
        if dest.exists() && force.unwrap_or(false) {
            std::fs::remove_dir_all(&dest)
                .map_err(|e| format!("清理目标目录失败：{e}"))?;
        }
        // 目标目录已存在且非空（非项目）→ 拒绝，避免误覆盖用户文件
        if dest.exists() {
            let is_empty = std::fs::read_dir(&dest)
                .map_err(|e| format!("读取目标目录失败：{e}"))?
                .next()
                .is_none();
            if !is_empty && !looks_like_project(&dest) {
                return Err(format!(
                    "{} 已存在且不是空目录、也不像 e2e 项目；请换一个空目录，或勾选「强制覆盖」。",
                    dest.display()
                ));
            }
        }
        std::fs::create_dir_all(&dest).map_err(|e| format!("创建目录失败：{e}"))?;
        unzip_to(&zip_path, &dest).map_err(|e| format!("解压模板失败：{e}"))?;
    }

    let abs = dest.canonicalize().unwrap_or(dest.clone());
    let abs_str = abs.to_string_lossy().into_owned();

    let mut cfg = read_global_config().unwrap_or_default();
    cfg.project_root = Some(abs_str.clone());
    write_global_config(&cfg)?;
    invalidate_project_root();

    Ok(abs_str)
}

fn unzip_to(zip_path: &Path, dest: &Path) -> std::io::Result<()> {
    let file = std::fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;
        // 安全路径：只使用 enclosed_name，拒绝路径穿越
        let rel = match entry.enclosed_name() {
            Some(p) => p.to_path_buf(),
            None => continue,
        };
        let out_path = dest.join(&rel);

        if entry.is_dir() || entry.name().ends_with('/') {
            std::fs::create_dir_all(&out_path)?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut out = std::fs::File::create(&out_path)?;
        std::io::copy(&mut entry, &mut out)?;

        // Unix 权限位还原
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Some(mode) = entry.unix_mode() {
                let _ = std::fs::set_permissions(&out_path, std::fs::Permissions::from_mode(mode));
            }
        }
    }
    Ok(())
}

fn pnpm_program() -> &'static str {
    if cfg!(windows) {
        "pnpm.cmd"
    } else {
        "pnpm"
    }
}

/// macOS GUI 应用（从 Dock/Launchpad 启动）不继承登录 shell 的 PATH。
/// 我们通过调用 `zsh -lc 'echo $PATH'`（或 bash）拿到用户实际的 PATH。
#[cfg(unix)]
fn shell_login_path() -> Option<String> {
    use std::process::Command as StdCommand;
    let mut candidates: Vec<String> = vec![];
    if let Ok(s) = std::env::var("SHELL") {
        if !s.is_empty() {
            candidates.push(s);
        }
    }
    candidates.extend(["/bin/zsh".into(), "/bin/bash".into(), "zsh".into(), "bash".into()]);

    for sh in candidates {
        if let Ok(out) = StdCommand::new(&sh)
            .args(["-lc", "echo -n $PATH"])
            .output()
        {
            if out.status.success() {
                let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !s.is_empty() {
                    return Some(s);
                }
            }
        }
    }
    None
}

/// 版本号按语义顺序排序，挑最新（粗粒度，够用）。只看前三段数字。
fn version_key(name: &str) -> (u32, u32, u32) {
    let s = name.trim_start_matches(|c: char| !c.is_ascii_digit());
    let parts: Vec<u32> = s
        .split(|c: char| !c.is_ascii_digit())
        .filter(|p| !p.is_empty())
        .take(3)
        .filter_map(|p| p.parse().ok())
        .collect();
    let a = parts.first().copied().unwrap_or(0);
    let b = parts.get(1).copied().unwrap_or(0);
    let c = parts.get(2).copied().unwrap_or(0);
    (a, b, c)
}

/// 扫描目录取最新子目录（按版本号）。返回该子目录路径。
fn latest_subdir(base: &Path) -> Option<PathBuf> {
    if !base.is_dir() {
        return None;
    }
    let mut best: Option<(PathBuf, (u32, u32, u32))> = None;
    for entry in std::fs::read_dir(base).ok()?.flatten() {
        if !entry.file_type().ok().map_or(false, |t| t.is_dir()) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let key = version_key(&name);
        let path = entry.path();
        match &best {
            None => best = Some((path, key)),
            Some((_, bk)) if key > *bk => best = Some((path, key)),
            _ => {}
        }
    }
    best.map(|(p, _)| p)
}

/// 收集所有 Node 版本管理器装的 node 可执行文件所在目录（bin 级）。
fn node_manager_bin_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = vec![];

    // Unix: nvm / volta / fnm
    #[cfg(unix)]
    {
        if let Some(home) = std::env::var_os("HOME") {
            let h = PathBuf::from(home);
            let nvm_root = std::env::var_os("NVM_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| h.join(".nvm"));
            let nvm_node_dir = nvm_root.join("versions").join("node");
            if let Some(latest) = latest_subdir(&nvm_node_dir) {
                let bin = latest.join("bin");
                if bin.is_dir() { dirs.push(bin); }
            }
            // volta shim
            let volta_bin = h.join(".volta").join("bin");
            if volta_bin.is_dir() { dirs.push(volta_bin); }
            // fnm (new layout: ~/.local/share/fnm/node-versions/<ver>/installation/bin)
            let fnm_base = h.join(".local").join("share").join("fnm").join("node-versions");
            if let Some(latest) = latest_subdir(&fnm_base) {
                let bin = latest.join("installation").join("bin");
                if bin.is_dir() { dirs.push(bin); }
            }
            // fnm (legacy: ~/.fnm/node-versions)
            let fnm_legacy = h.join(".fnm").join("node-versions");
            if let Some(latest) = latest_subdir(&fnm_legacy) {
                let bin = latest.join("installation").join("bin");
                if bin.is_dir() { dirs.push(bin); }
            }
        }
    }

    // Windows: nvm-windows (coreybutler/nvm-windows)
    #[cfg(windows)]
    {
        let candidates: Vec<PathBuf> = [
            std::env::var_os("NVM_HOME").map(PathBuf::from),
            std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("nvm")),
            std::env::var_os("LOCALAPPDATA").map(|a| PathBuf::from(a).join("nvm")),
            Some(PathBuf::from("C:\\nvm")),
        ]
        .into_iter()
        .flatten()
        .collect();

        for c in candidates {
            if let Some(latest) = latest_subdir(&c) {
                // nvm-windows: C:\Users\...\nvm\v22.1.0\node.exe （node 在目录根，不是 bin）
                if latest.join("node.exe").is_file() {
                    dirs.push(latest);
                }
            }
            // nvm-windows 还会把当前激活的版本符号链到 Program Files\nodejs 或 C:\nodejs
        }
        // 常见的 node 固定安装位置
        let fixed = [
            std::env::var_os("ProgramFiles").map(|p| PathBuf::from(p).join("nodejs")),
            std::env::var_os("ProgramFiles(x86)").map(|p| PathBuf::from(p).join("nodejs")),
            Some(PathBuf::from("C:\\nodejs")),
        ];
        for f in fixed.into_iter().flatten() {
            if f.join("node.exe").is_file() {
                dirs.push(f);
            }
        }

        // volta on Windows
        if let Some(home) = std::env::var_os("USERPROFILE") {
            let volta_bin = PathBuf::from(home).join(".volta").join("bin");
            if volta_bin.is_dir() { dirs.push(volta_bin); }
        }
    }

    dirs
}

/// 构建一份"更完整"的 PATH：登录 shell PATH + 常见 Node/pnpm 安装点 + Node 版本管理器 + 系统 PATH。
fn augmented_path() -> String {
    static PATH: Lazy<String> = Lazy::new(|| {
        let sep = if cfg!(windows) { ";" } else { ":" };
        let mut parts: Vec<String> = vec![];

        #[cfg(unix)]
        if let Some(login) = shell_login_path() {
            parts.push(login);
        }

        // Node 版本管理器的 bin 目录
        for d in node_manager_bin_dirs() {
            parts.push(d.to_string_lossy().into_owned());
        }

        #[cfg(unix)]
        if let Some(home) = std::env::var_os("HOME") {
            let h = PathBuf::from(home);
            for g in [
                ".local/share/pnpm",
                ".npm-global/bin",
                ".cargo/bin",
                ".nix-profile/bin",
            ] {
                let p = h.join(g);
                if p.exists() {
                    parts.push(p.to_string_lossy().into_owned());
                }
            }
        }
        #[cfg(unix)]
        for sys in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
            parts.push(sys.to_string());
        }

        #[cfg(windows)]
        if let Some(home) = std::env::var_os("USERPROFILE") {
            let h = PathBuf::from(home);
            for g in [
                "AppData\\Local\\pnpm",
                "AppData\\Roaming\\npm",
                "scoop\\shims",
                ".cargo\\bin",
            ] {
                let p = h.join(g);
                if p.exists() {
                    parts.push(p.to_string_lossy().into_owned());
                }
            }
        }

        if let Ok(existing) = std::env::var("PATH") {
            if !existing.is_empty() {
                parts.push(existing);
            }
        }
        // 去重（保序）
        let mut seen = std::collections::HashSet::new();
        parts.retain(|p| seen.insert(p.to_lowercase()));
        parts.join(sep)
    });
    PATH.clone()
}

fn apply_command_env(cmd: &mut Command) {
    cmd.env("PATH", augmented_path());
}

async fn stream_reader<R>(
    app: AppHandle,
    job: String,
    kind: &'static str,
    reader: R,
) where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    let mut lines = BufReader::new(reader).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                let _ = app.emit(
                    "job-log",
                    LogEvent {
                        job: job.clone(),
                        kind: kind.into(),
                        line,
                    },
                );
            }
            Ok(None) => break,
            Err(e) => {
                let _ = app.emit(
                    "job-log",
                    LogEvent {
                        job: job.clone(),
                        kind: "error".into(),
                        line: format!("read error: {e}"),
                    },
                );
                break;
            }
        }
    }
}

/// 一次 pnpm 调用的原子实现：注册到 JOBS、流式回传 stdout/stderr、等到退出并返回 ExitStatus。
/// 不发送最终 "任务结束" 状态事件 —— 留给调用方决定（单步任务发成功/失败；链式任务只在全部结束时发一次）。
async fn spawn_pnpm(
    app: &AppHandle,
    job: &str,
    args: &[String],
    extra_env: Option<&HashMap<String, String>>,
) -> Result<std::process::ExitStatus, String> {
    let root = project_root();
    let _ = app.emit(
        "job-log",
        LogEvent {
            job: job.to_string(),
            kind: "status".into(),
            line: format!("$ pnpm {}", args.join(" ")),
        },
    );

    if root.as_os_str().is_empty() {
        return Err(
            "找不到 e2e 项目目录：请设置环境变量 E2E_PROJECT_ROOT，或在项目目录内启动应用。"
                .into(),
        );
    }

    let mut cmd = Command::new(pnpm_program());
    cmd.args(args)
        .current_dir(&root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    apply_command_env(&mut cmd);
    if let Some(extra) = extra_env {
        for (k, v) in extra {
            cmd.env(k, v);
        }
    }

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 pnpm 失败：{e}。请确认 pnpm 已在 PATH 中。"))?;

    let stdout = child.stdout.take().ok_or("无 stdout 管道")?;
    let stderr = child.stderr.take().ok_or("无 stderr 管道")?;

    {
        let mut jobs = JOBS.lock().await;
        jobs.insert(job.to_string(), child);
    }

    tokio::spawn(stream_reader(app.clone(), job.to_string(), "stdout", stdout));
    tokio::spawn(stream_reader(app.clone(), job.to_string(), "stderr", stderr));

    // 把 child 从 JOBS 拿出来等 wait；如果被 kill_job 先拿走了，wait 就走不到这里。
    let status = {
        let mut jobs = JOBS.lock().await;
        let mut child = jobs
            .remove(job)
            .ok_or_else(|| "任务被提前终止".to_string())?;
        drop(jobs);
        child.wait().await.map_err(|e| format!("wait 失败：{e}"))?
    };

    Ok(status)
}

fn emit_final(app: &AppHandle, job: &str, success: bool, code: Option<i32>) {
    let (kind, line): (&str, String) = if success {
        ("status", "任务成功结束 (exit 0)".into())
    } else {
        ("status", format!("任务结束，退出码 {:?}", code))
    };
    let _ = app.emit(
        "job-log",
        LogEvent {
            job: job.to_string(),
            kind: kind.into(),
            line,
        },
    );
}

#[tauri::command]
async fn run_pnpm(app: AppHandle, args: RunArgs) -> Result<(), String> {
    {
        let jobs = JOBS.lock().await;
        if jobs.contains_key(&args.job) {
            return Err(format!("job `{}` 已在运行", args.job));
        }
    }

    // 单步任务异步执行：立刻返回，状态通过事件推送
    let app_bg = app.clone();
    let job_id = args.job.clone();
    let argv = args.args.clone();
    let env = args.env.clone();
    tokio::spawn(async move {
        match spawn_pnpm(&app_bg, &job_id, &argv, env.as_ref()).await {
            Ok(s) => emit_final(&app_bg, &job_id, s.success(), s.code()),
            Err(e) => {
                let _ = app_bg.emit(
                    "job-log",
                    LogEvent {
                        job: job_id,
                        kind: "error".into(),
                        line: e,
                    },
                );
            }
        }
    });

    Ok(())
}

#[derive(Debug, Deserialize)]
struct ChainStep {
    label: String,
    args: Vec<String>,
    /// 每个 step 可以单独带 env（比如批量跑录制时每个文件 E2E_SPEC_DIR / E2E_FORCE_ANON 都不同）。
    /// None 时 spawn_pnpm 不附加额外 env，行为与之前一致。
    #[serde(default)]
    env: Option<HashMap<String, String>>,
}

#[derive(Debug, Deserialize)]
struct ChainArgs {
    job: String,
    steps: Vec<ChainStep>,
}

#[tauri::command]
async fn run_pnpm_chain(app: AppHandle, args: ChainArgs) -> Result<(), String> {
    {
        let jobs = JOBS.lock().await;
        if jobs.contains_key(&args.job) {
            return Err(format!("job `{}` 已在运行", args.job));
        }
    }

    let app_bg = app.clone();
    let job_id = args.job.clone();
    let steps = args.steps;

    tokio::spawn(async move {
        let total = steps.len();
        for (i, step) in steps.iter().enumerate() {
            let _ = app_bg.emit(
                "job-log",
                LogEvent {
                    job: job_id.clone(),
                    kind: "status".into(),
                    line: format!("[{}/{}] {}", i + 1, total, step.label),
                },
            );
            match spawn_pnpm(&app_bg, &job_id, &step.args, step.env.as_ref()).await {
                Ok(s) if s.success() => { /* 继续下一步 */ }
                Ok(s) => {
                    emit_final(&app_bg, &job_id, false, s.code());
                    let _ = app_bg.emit(
                        "job-log",
                        LogEvent {
                            job: job_id.clone(),
                            kind: "error".into(),
                            line: format!("步骤 [{}/{}] {} 失败，中止链式任务", i + 1, total, step.label),
                        },
                    );
                    return;
                }
                Err(e) => {
                    let _ = app_bg.emit(
                        "job-log",
                        LogEvent {
                            job: job_id.clone(),
                            kind: "error".into(),
                            line: e,
                        },
                    );
                    return;
                }
            }
        }
        emit_final(&app_bg, &job_id, true, Some(0));
    });

    Ok(())
}

#[tauri::command]
async fn kill_job(job: String) -> Result<(), String> {
    let mut jobs = JOBS.lock().await;
    if let Some(mut child) = jobs.remove(&job) {
        child.kill().await.map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err(format!("任务 `{job}` 未在运行"))
    }
}

#[tauri::command]
async fn active_jobs() -> Vec<String> {
    let jobs = JOBS.lock().await;
    jobs.keys().cloned().collect()
}

#[derive(Serialize)]
struct DocEntry {
    name: String,
    title: String,
}

#[tauri::command]
fn list_docs() -> Result<Vec<DocEntry>, String> {
    let dir = project_root().join("docs");
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut entries = vec![];
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let title = extract_title(&path).unwrap_or_else(|| name.clone());
        entries.push(DocEntry { name, title });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

fn extract_title(path: &Path) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    for line in content.lines().take(40) {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("# ") {
            return Some(rest.trim().to_string());
        }
    }
    None
}

/// 读取一个 `.spec.ts` 的文本内容，前端用来做"是否含登录行为"的轻量检测。
/// 限制：只允许 .spec.ts 后缀，且大小 <= 1 MiB —— 避免把任意文件经 IPC 抽出。
/// 路径可绝对（用户在项目外的录制）也可项目相对。
#[tauri::command]
fn read_spec_text(path: String) -> Result<String, String> {
    let p = if Path::new(&path).is_absolute() {
        PathBuf::from(&path)
    } else {
        project_root().join(&path)
    };
    let lower = p.to_string_lossy().to_lowercase();
    if !lower.ends_with(".spec.ts") {
        return Err("仅支持 .spec.ts 文件".into());
    }
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    if meta.len() > 1024 * 1024 {
        return Err("文件超过 1 MiB，已拒绝读取".into());
    }
    std::fs::read_to_string(&p).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_doc(name: String) -> Result<String, String> {
    let root = project_root();
    let docs = root.join("docs");
    let target = docs.join(&name);

    // 防越权：确保在 docs/ 下
    let real_docs = docs.canonicalize().map_err(|e| e.to_string())?;
    let real_target = target.canonicalize().map_err(|e| e.to_string())?;
    if !real_target.starts_with(&real_docs) {
        return Err("越权访问被拒绝".into());
    }
    std::fs::read_to_string(&real_target).map_err(|e| e.to_string())
}

// ---------- .env.local 读写（保留注释与行顺序） ----------

const ENV_KEYS: &[&str] = &[
    "E2E_BASE_URL",
    "E2E_ENV",
    "E2E_EXPECTED_COMPANY_ID",
    "E2E_ADMIN_EMAIL",
    "E2E_ADMIN_PASSWORD",
    "E2E_MEMBER_EMAIL",
    "E2E_MEMBER_PASSWORD",
    "E2E_RECORDINGS_DIR",
];

fn parse_dotenv(text: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for raw in text.lines() {
        let line = raw.trim_start();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(eq) = line.find('=') {
            let key = line[..eq].trim().to_string();
            let mut val = line[eq + 1..].trim().to_string();
            // 去掉成对引号
            if (val.starts_with('"') && val.ends_with('"'))
                || (val.starts_with('\'') && val.ends_with('\''))
            {
                val = val[1..val.len() - 1].to_string();
            }
            map.insert(key, val);
        }
    }
    map
}

#[tauri::command]
fn read_env_local() -> Result<HashMap<String, String>, String> {
    let root = project_root();
    if root.as_os_str().is_empty() {
        return Err("项目目录未找到".into());
    }
    let path = root.join(".env.local");
    if !path.exists() {
        // 不存在就从 .env.example 读出模板（保留 key，值留空）
        let sample = root.join(".env.example");
        if sample.exists() {
            let text = std::fs::read_to_string(&sample).map_err(|e| e.to_string())?;
            let mut map = parse_dotenv(&text);
            // 清空敏感字段 — 只留作 placeholder
            for k in ["E2E_ADMIN_PASSWORD", "E2E_MEMBER_PASSWORD"] {
                map.insert(k.to_string(), String::new());
            }
            return Ok(map);
        }
        return Ok(HashMap::new());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(parse_dotenv(&text))
}

#[tauri::command]
fn write_env_local(updates: HashMap<String, String>) -> Result<(), String> {
    let root = project_root();
    if root.as_os_str().is_empty() {
        return Err("项目目录未找到".into());
    }
    let path = root.join(".env.local");

    // 原文（如果存在）
    let existing = if path.exists() {
        std::fs::read_to_string(&path).map_err(|e| e.to_string())?
    } else if root.join(".env.example").exists() {
        std::fs::read_to_string(root.join(".env.example")).map_err(|e| e.to_string())?
    } else {
        String::new()
    };

    let mut applied: HashMap<String, bool> = updates.keys().map(|k| (k.clone(), false)).collect();

    let mut out = String::new();
    for raw in existing.lines() {
        let trimmed = raw.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            out.push_str(raw);
            out.push('\n');
            continue;
        }
        if let Some(eq) = trimmed.find('=') {
            let key = trimmed[..eq].trim().to_string();
            if let Some(new_val) = updates.get(&key) {
                out.push_str(&format!("{}={}", key, new_val));
                out.push('\n');
                applied.insert(key, true);
                continue;
            }
        }
        out.push_str(raw);
        out.push('\n');
    }

    // 追加没命中的新 key
    let mut appended_header = false;
    for (k, done) in &applied {
        if !done && !updates.get(k).map(String::is_empty).unwrap_or(true) {
            if !appended_header {
                if !out.ends_with('\n') {
                    out.push('\n');
                }
                out.push_str("\n# Added by Desktop Console\n");
                appended_header = true;
            }
            out.push_str(&format!("{}={}\n", k, updates.get(k).unwrap()));
        }
    }

    std::fs::write(&path, out).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn env_keys() -> Vec<String> {
    ENV_KEYS.iter().map(|s| s.to_string()).collect()
}

// ---------- 桌面应用本地配置 (.desktop-config.json) ----------

#[derive(Debug, Default, Serialize, Deserialize, Clone)]
struct DesktopConfig {
    #[serde(default)]
    recordings_dir: Option<String>,
    #[serde(default)]
    imports_dir: Option<String>,
}

fn config_path() -> Option<PathBuf> {
    let root = project_root();
    if root.as_os_str().is_empty() {
        None
    } else {
        Some(root.join(".desktop-config.json"))
    }
}

#[tauri::command]
fn read_config() -> DesktopConfig {
    if let Some(p) = config_path() {
        if let Ok(text) = std::fs::read_to_string(&p) {
            if let Ok(cfg) = serde_json::from_str::<DesktopConfig>(&text) {
                return cfg;
            }
        }
    }
    DesktopConfig::default()
}

#[tauri::command]
fn write_config(cfg: DesktopConfig) -> Result<(), String> {
    let p = config_path().ok_or_else(|| "项目目录未找到".to_string())?;
    let s = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    std::fs::write(&p, s).map_err(|e| e.to_string())?;
    Ok(())
}

fn resolve_dir(raw: &str) -> Result<String, String> {
    let root = project_root();
    if root.as_os_str().is_empty() {
        return Err("项目目录未找到".into());
    }
    let abs = if Path::new(raw).is_absolute() {
        PathBuf::from(raw)
    } else {
        root.join(raw)
    };
    Ok(abs.to_string_lossy().into_owned())
}

#[tauri::command]
fn resolve_recordings_dir() -> Result<String, String> {
    let cfg = read_config();
    resolve_dir(&cfg.recordings_dir.unwrap_or_else(|| "recordings".into()))
}

#[tauri::command]
fn resolve_imports_dir() -> Result<String, String> {
    let cfg = read_config();
    resolve_dir(&cfg.imports_dir.unwrap_or_else(|| "tests/recorded".into()))
}

#[derive(Serialize)]
struct RecordingEntry {
    path: String,       // 绝对路径
    relative: String,   // 相对项目根
    name: String,       // 文件名
    modified_ms: u128,  // 自 epoch 毫秒
}

#[tauri::command]
fn list_recordings(limit: Option<usize>) -> Result<Vec<RecordingEntry>, String> {
    let root = project_root();
    if root.as_os_str().is_empty() {
        return Err("项目目录未找到".into());
    }
    let dir_str = resolve_recordings_dir()?;
    let dir = PathBuf::from(&dir_str);
    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut entries: Vec<RecordingEntry> = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = match path.file_name().and_then(|s| s.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if !name.ends_with(".spec.ts") {
            continue;
        }
        let modified_ms = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|t| {
                t.duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0)
            })
            .unwrap_or(0);
        let relative = path
            .strip_prefix(&root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| path.to_string_lossy().into_owned());
        entries.push(RecordingEntry {
            path: path.to_string_lossy().into_owned(),
            relative,
            name,
            modified_ms,
        });
    }

    // 按 mtime 倒序
    entries.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    // None / Some(0) → 返回全部；Some(n) → 取前 n
    let take = match limit {
        Some(0) | None => entries.len(),
        Some(n) => n.min(entries.len()),
    };
    entries.truncate(take);
    Ok(entries)
}

#[tauri::command]
fn latest_recording() -> Result<Option<RecordingEntry>, String> {
    let mut list = list_recordings(Some(1))?;
    Ok(list.pop())
}

// ---------- 原生文件 / 文件夹选择器 ----------

#[derive(Debug, Deserialize)]
struct FilterSpec {
    name: String,
    extensions: Vec<String>,
}

#[tauri::command]
async fn pick_file(
    app: AppHandle,
    filters: Option<Vec<FilterSpec>>,
    default_path: Option<String>,
) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut builder = app.dialog().file();
    if let Some(fs) = filters.as_ref() {
        for f in fs {
            let exts: Vec<&str> = f.extensions.iter().map(String::as_str).collect();
            builder = builder.add_filter(&f.name, &exts);
        }
    }
    if let Some(p) = default_path.as_deref() {
        if !p.is_empty() {
            builder = builder.set_directory(p);
        }
    }
    builder.pick_file(move |fp| {
        let _ = tx.send(fp);
    });
    rx.await.ok().flatten().map(|fp| fp.to_string())
}

#[tauri::command]
async fn pick_directory(
    app: AppHandle,
    default_path: Option<String>,
) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut builder = app.dialog().file();
    if let Some(p) = default_path.as_deref() {
        if !p.is_empty() {
            builder = builder.set_directory(p);
        }
    }
    builder.pick_folder(move |fp| {
        let _ = tx.send(fp);
    });
    rx.await.ok().flatten().map(|fp| fp.to_string())
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    // 只放行 http/https，避免滥用 start 执行任意东西
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("仅允许 http/https URL".into());
    }
    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn open_in_shell(target: String) -> Result<(), String> {
    let root = project_root();
    let path = if Path::new(&target).is_absolute() {
        PathBuf::from(&target)
    } else {
        root.join(&target)
    };
    if !path.exists() {
        return Err(format!("{} 不存在（可能还没生成）", path.display()));
    }

    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", path.to_str().ok_or("路径含非 UTF8")?])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Serialize)]
struct EnvInfo {
    project_root: String,
    project_root_found: bool,
    env_local_exists: bool,
    auth_exists: bool,
    has_reports: bool,
    has_recordings: bool,
    node_modules_installed: bool,
    playwright_installed: bool,
    platform: String,
    pnpm_hint: Option<String>,
}

#[tauri::command]
fn env_info() -> EnvInfo {
    let root = project_root();
    let found = !root.as_os_str().is_empty();
    EnvInfo {
        env_local_exists: found && root.join(".env.local").exists(),
        auth_exists: found && root.join(".auth").join("admin.json").exists(),
        has_reports: found && root.join("reports").join("index.html").exists(),
        has_recordings: found && root.join("recordings").exists(),
        node_modules_installed: found && root.join("node_modules").exists(),
        playwright_installed: found
            && root
                .join("node_modules")
                .join("@playwright")
                .join("test")
                .exists(),
        project_root: root.to_string_lossy().into_owned(),
        project_root_found: found,
        platform: std::env::consts::OS.to_string(),
        pnpm_hint: detect_pnpm_hint(),
    }
}

/// 在 augmented_path 上定位某个可执行文件（用于 UI "pnpm / node 路径" 显示）。
fn find_in_path(exe: &str) -> Option<String> {
    use std::process::Command as StdCommand;
    let (finder, args): (&str, Vec<&str>) = if cfg!(windows) {
        ("where", vec![exe])
    } else {
        ("which", vec![exe])
    };
    let out = StdCommand::new(finder)
        .args(&args)
        .env("PATH", augmented_path())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    let first = s.lines().next().unwrap_or("").trim();
    if first.is_empty() { None } else { Some(first.to_string()) }
}

fn detect_pnpm_hint() -> Option<String> {
    find_in_path(if cfg!(windows) { "pnpm.cmd" } else { "pnpm" })
        .or_else(|| find_in_path("pnpm"))
}

/// 运行某个命令拿 stdout（用 augmented PATH）。失败返回 None。
fn run_capture(program: &str, args: &[&str]) -> Option<String> {
    use std::process::Command as StdCommand;
    let mut cmd = StdCommand::new(program);
    cmd.args(args).env("PATH", augmented_path());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().ok()?;
    if out.status.success() {
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if s.is_empty() { None } else { Some(s) }
    } else {
        None
    }
}

#[derive(Serialize)]
struct NvmVersion {
    name: String,
    path: String,
}

#[derive(Serialize)]
struct NodeInfo {
    node_found: bool,
    node_path: Option<String>,
    node_version: Option<String>,
    npm_version: Option<String>,
    pnpm_found: bool,
    pnpm_path: Option<String>,
    pnpm_version: Option<String>,
    /// 来源标签：system / nvm / nvm-windows / volta / fnm / none
    source: String,
    nvm_versions: Vec<NvmVersion>,
    nvm_kind: Option<String>,           // "nvm-sh" | "nvm-windows" | None
    /// 对应平台下载页
    download_url: String,
}

fn platform_download_url() -> &'static str {
    if cfg!(target_os = "windows") {
        "https://nodejs.org/zh-cn/download/prebuilt-installer"
    } else if cfg!(target_os = "macos") {
        "https://nodejs.org/zh-cn/download/prebuilt-installer"
    } else {
        "https://nodejs.org/zh-cn/download"
    }
}

/// 扫描所有能找到的 nvm 已装 Node 版本；返回 (kind, versions)。
fn scan_nvm_versions() -> (Option<&'static str>, Vec<NvmVersion>) {
    let mut versions: Vec<NvmVersion> = vec![];
    #[cfg(unix)]
    {
        if let Some(home) = std::env::var_os("HOME") {
            let h = PathBuf::from(home);
            let nvm_root = std::env::var_os("NVM_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| h.join(".nvm"));
            let node_dir = nvm_root.join("versions").join("node");
            if node_dir.is_dir() {
                if let Ok(rd) = std::fs::read_dir(&node_dir) {
                    for e in rd.flatten() {
                        if e.file_type().ok().map_or(false, |t| t.is_dir()) {
                            let path = e.path().join("bin").join("node");
                            if path.is_file() {
                                versions.push(NvmVersion {
                                    name: e.file_name().to_string_lossy().into_owned(),
                                    path: path.to_string_lossy().into_owned(),
                                });
                            }
                        }
                    }
                }
                versions.sort_by(|a, b| version_key(&b.name).cmp(&version_key(&a.name)));
                if !versions.is_empty() {
                    return (Some("nvm-sh"), versions);
                }
            }
        }
    }
    #[cfg(windows)]
    {
        let candidates: Vec<PathBuf> = [
            std::env::var_os("NVM_HOME").map(PathBuf::from),
            std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("nvm")),
            std::env::var_os("LOCALAPPDATA").map(|a| PathBuf::from(a).join("nvm")),
            Some(PathBuf::from("C:\\nvm")),
        ]
        .into_iter()
        .flatten()
        .collect();

        for c in candidates {
            if !c.is_dir() { continue; }
            if let Ok(rd) = std::fs::read_dir(&c) {
                for e in rd.flatten() {
                    if !e.file_type().ok().map_or(false, |t| t.is_dir()) { continue; }
                    let path = e.path().join("node.exe");
                    if path.is_file() {
                        versions.push(NvmVersion {
                            name: e.file_name().to_string_lossy().into_owned(),
                            path: path.to_string_lossy().into_owned(),
                        });
                    }
                }
            }
            if !versions.is_empty() {
                versions.sort_by(|a, b| version_key(&b.name).cmp(&version_key(&a.name)));
                return (Some("nvm-windows"), versions);
            }
        }
    }
    (None, versions)
}

fn classify_source(node_path: Option<&str>, nvm_kind: Option<&str>) -> String {
    let Some(p) = node_path else { return "none".into() };
    let lower = p.to_lowercase();
    if lower.contains("/.nvm/") || lower.contains("\\nvm\\") {
        return nvm_kind.unwrap_or("nvm").to_string();
    }
    if lower.contains("/.volta/") || lower.contains("\\.volta\\") {
        return "volta".into();
    }
    if lower.contains("/fnm/") || lower.contains("\\fnm\\") {
        return "fnm".into();
    }
    "system".into()
}

#[tauri::command]
fn detect_node_env() -> NodeInfo {
    let node_exe = if cfg!(windows) { "node.exe" } else { "node" };
    let node_path = find_in_path(node_exe).or_else(|| find_in_path("node"));
    let node_version = run_capture("node", &["--version"]);
    let npm_version = run_capture(if cfg!(windows) { "npm.cmd" } else { "npm" }, &["--version"])
        .or_else(|| run_capture("npm", &["--version"]));
    let pnpm_path = detect_pnpm_hint();
    let pnpm_version = run_capture(if cfg!(windows) { "pnpm.cmd" } else { "pnpm" }, &["--version"])
        .or_else(|| run_capture("pnpm", &["--version"]));

    let (nvm_kind, nvm_versions) = scan_nvm_versions();
    let source = classify_source(node_path.as_deref(), nvm_kind);

    NodeInfo {
        node_found: node_path.is_some() && node_version.is_some(),
        node_path,
        node_version,
        npm_version,
        pnpm_found: pnpm_path.is_some(),
        pnpm_path,
        pnpm_version,
        source,
        nvm_versions,
        nvm_kind: nvm_kind.map(String::from),
        download_url: platform_download_url().to_string(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            run_pnpm,
            run_pnpm_chain,
            kill_job,
            active_jobs,
            list_docs,
            read_doc,
            read_spec_text,
            open_in_shell,
            env_info,
            read_env_local,
            write_env_local,
            env_keys,
            read_config,
            write_config,
            resolve_recordings_dir,
            resolve_imports_dir,
            list_recordings,
            latest_recording,
            pick_file,
            pick_directory,
            get_global_config,
            set_project_root,
            clear_project_root,
            template_available,
            extract_template,
            default_template_dest,
            wipe_node_modules,
            ensure_npmrc,
            detect_node_env,
            open_external_url
        ])
        .setup(|app| {
            // 建立一次性路径上下文：app_data_dir 持久目录 + resource_dir 安装资源目录
            let app_data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            let _ = std::fs::create_dir_all(&app_data_dir);
            let resource_dir = app
                .path()
                .resource_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            let _ = APP_PATHS.set(AppPaths {
                app_data_dir,
                resource_dir,
            });
            // 路径配置变了，让 project_root 重算
            invalidate_project_root();

            #[cfg(debug_assertions)]
            {
                if let Some(w) = app.get_webview_window("main") {
                    w.open_devtools();
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}
