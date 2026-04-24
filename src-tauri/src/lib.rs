use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

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
fn project_root() -> PathBuf {
    static CACHE: Lazy<PathBuf> = Lazy::new(resolve_project_root_inner);
    CACHE.clone()
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
    // 1. 显式环境变量
    if let Some(env) = std::env::var_os("E2E_PROJECT_ROOT") {
        let p = PathBuf::from(env);
        if looks_like_project(&p) {
            return p;
        }
    }
    // 2. cwd 向上最多 5 级（dev 模式足够）
    if let Ok(cwd) = std::env::current_dir() {
        if let Some(p) = walk_up_for_project(cwd, 5) {
            return p;
        }
    }
    // 3. 可执行文件目录向上最多 6 级（Mac .app/Contents/MacOS 下需要多爬几级）
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            if let Some(p) = walk_up_for_project(parent.to_path_buf(), 6) {
                return p;
            }
        }
    }
    PathBuf::new()
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
    // 先尝试 SHELL 环境变量指定的 shell，再兜底 zsh/bash
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

/// 构建一份"更完整"的 PATH：登录 shell PATH + 常见 Node/pnpm 安装点 + 系统 PATH。
#[cfg(unix)]
fn augmented_path() -> String {
    static PATH: Lazy<String> = Lazy::new(|| {
        let mut parts: Vec<String> = vec![];
        if let Some(login) = shell_login_path() {
            parts.push(login);
        }
        // Mac/Linux 上 pnpm / node 的常见位置
        if let Some(home) = std::env::var_os("HOME") {
            let h = PathBuf::from(home);
            let guesses = [
                ".local/share/pnpm",
                ".volta/bin",
                ".npm-global/bin",
                ".fnm/aliases/default/bin",
                ".cargo/bin",
                ".nix-profile/bin",
            ];
            for g in guesses {
                let p = h.join(g);
                if p.exists() {
                    parts.push(p.to_string_lossy().into_owned());
                }
            }
        }
        for sys in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
            parts.push(sys.to_string());
        }
        if let Ok(existing) = std::env::var("PATH") {
            if !existing.is_empty() {
                parts.push(existing);
            }
        }
        // 去重（保序）
        let mut seen = std::collections::HashSet::new();
        parts.retain(|p| seen.insert(p.clone()));
        parts.join(":")
    });
    PATH.clone()
}

fn apply_command_env(cmd: &mut Command) {
    #[cfg(unix)]
    {
        cmd.env("PATH", augmented_path());
    }
    #[cfg(not(unix))]
    {
        let _ = cmd;
    }
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
            match spawn_pnpm(&app_bg, &job_id, &step.args, None).await {
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
    let take = limit.unwrap_or(10).min(entries.len());
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

#[cfg(unix)]
fn detect_pnpm_hint() -> Option<String> {
    // 用 augmented PATH 下的 which 定位 pnpm，帮助用户排查"启动 pnpm 失败"
    use std::process::Command as StdCommand;
    let out = StdCommand::new("which")
        .arg("pnpm")
        .env("PATH", augmented_path())
        .output()
        .ok()?;
    if out.status.success() {
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !s.is_empty() {
            return Some(s);
        }
    }
    None
}

#[cfg(not(unix))]
fn detect_pnpm_hint() -> Option<String> { None }

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
            pick_directory
        ])
        .setup(|app| {
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
