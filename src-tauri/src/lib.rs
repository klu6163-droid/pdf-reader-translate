// Tauri 应用核心逻辑。main.rs 只调用本文件的 run()，
// 以符合 Tauri v2 官方模板结构（lib + bin），便于将来扩展移动端。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// 读取本地 PDF 文件，返回字节数组。
/// 前端通过 invoke("read_pdf_file", { path }) 调用。
/// 用 Rust 直接读文件，不依赖 tauri-plugin-fs 的 scope 配置。
#[tauri::command]
fn read_pdf_file(path: String) -> Result<Vec<u8>, String> {
    // 只允许 .pdf 后缀，防止前端传入意外路径
    let p = std::path::Path::new(&path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if ext != "pdf" {
        return Err(format!("不支持的文件类型：{ext}，请选择 PDF 文件"));
    }
    std::fs::read(&path).map_err(|e| format!("读取文件失败：{e}"))
}

/// 把字节数组写入本地文件（用于导出/另存 PDF）。
/// 前端通过 invoke("write_file", { path, data }) 调用。
/// 只允许 .pdf 后缀，与 read_pdf_file 对称。
#[tauri::command]
fn write_file(path: String, data: Vec<u8>) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if ext != "pdf" {
        return Err(format!("不支持的文件类型：{ext}，仅支持保存 PDF"));
    }
    std::fs::write(&path, &data).map_err(|e| format!("写入文件失败：{e}"))
}

/// 手动重启后端（前端离线卡片的「重启后端」按钮）。
///
/// 强制换新语义：先杀旧实例再拉起新的，**不做** backend_is_up() 探活短路——
/// /api/health 返回 200 不代表健康（存在半死状态，如僵尸翻译线程占着事件循环，
/// 健康检查照样通过）。只杀我们持有句柄的进程（按 PID 杀进程树，复用关窗清理逻辑）；
/// 外部启动的后端没有 PID 不接管，返回可读错误让用户自行处理。
#[tauri::command]
async fn restart_backend(app: tauri::AppHandle) -> Result<(), String> {
    log_restart("manual restart requested");
    // 先作废旧 watcher（它可能正睡在自动重拉的退避里），防止它把我们杀掉的进程又拉起一遍
    bump_epoch(&app);
    let child = take_child(&app);
    if let Some(child) = child {
        let pid = kill_child(child);
        log_restart(&format!("manual restart: killed old backend pid={pid}"));
        // 给旧进程一点时间释放 8765 端口；即使新实例 bind 失败退出，
        // 新 watcher 也会按自动重拉策略在 2s 后再试
        sleep_async(std::time::Duration::from_millis(500)).await;
    } else if backend_is_up() {
        return Err("检测到不是本应用启动的后端（可能是手动启动或另一实例），无法接管。请先手动关闭它，再点一次「重启后端」。".into());
    }
    spawn_and_watch(&app)
        .await
        .map_err(|e| format!("重启后端失败：{e}"))?;
    let _ = app.emit(
        "backend-status",
        serde_json::json!({ "state": "restarting", "attempt": 0, "max": MAX_RESTARTS }),
    );
    Ok(())
}

/// 保存 Python 子进程句柄，应用退出时一并关闭
struct BackendProcess(Mutex<Option<CommandChild>>);

/// 应用正在退出（窗口已销毁）：watcher 见此标志不再重拉后端
struct ShuttingDown(AtomicBool);

/// 后端「世代」计数：每次由 setup / 手动重启发起的新拉起 +1。
/// watcher 启动时记住自己的世代，发现当前世代已变（说明有别人接管了拉起/清理），
/// 立即退出，避免新旧两个 watcher 各自重拉造成混战。
/// 注意：watcher 自己自动重拉时**不**加世代（它就是当前接管者）。
struct BackendEpoch(AtomicU64);

// ---- 自动重拉策略（审计 3.6，数字经用户确认）----
/// 一轮连续故障内最多重拉次数，耗尽后放弃并通知前端
const MAX_RESTARTS: u32 = 3;
/// 第 1/2/3 次重拉前的等待秒数（后端冷启动约 3~10s，太密无意义）
const RESTART_DELAYS_SECS: [u64; MAX_RESTARTS as usize] = [2, 4, 8];
/// 上一实例存活超过该秒数才崩溃 → 视为偶发，重拉计数器清零
const HEALTHY_WINDOW_SECS: u64 = 60;

/// 杀掉单个子进程句柄：先 kill 句柄，再按 PID 杀整棵进程树，返回 PID。
/// （PyInstaller onefile 的子进程不会被句柄 kill 带走，/T 兜住。）
/// 不再用 /IM 按映像名全局杀：双开会杀掉另一实例的后端，还可能误杀同名无关进程。
fn kill_child(proc: CommandChild) -> u32 {
    let pid = proc.pid();
    let _ = proc.kill();
    let _ = pid; // 仅发布版 Windows 需要；其余平台避免 unused 警告
    #[cfg(all(windows, not(debug_assertions)))]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    pid
}

/// 窗口销毁时清理后端：置退出标志（watcher 不再重拉）+ 杀进程树
fn kill_backend(window: &tauri::Window) {
    if let Some(state) = window.try_state::<ShuttingDown>() {
        state.0.store(true, Ordering::SeqCst);
    }
    let child = window
        .try_state::<BackendProcess>()
        .and_then(|state| state.0.lock().ok().and_then(|mut guard| guard.take()));
    if let Some(child) = child {
        kill_child(child);
    }
}

fn store_child(app: &tauri::AppHandle, child: CommandChild) {
    if let Some(state) = app.try_state::<BackendProcess>() {
        if let Ok(mut guard) = state.0.lock() {
            *guard = Some(child);
        }
    }
}

fn take_child(app: &tauri::AppHandle) -> Option<CommandChild> {
    app.try_state::<BackendProcess>()
        .and_then(|state| state.0.lock().ok().and_then(|mut guard| guard.take()))
}

fn bump_epoch(app: &tauri::AppHandle) -> u64 {
    app.try_state::<BackendEpoch>()
        .map(|s| s.0.fetch_add(1, Ordering::SeqCst) + 1)
        .unwrap_or(0)
}

fn current_epoch(app: &tauri::AppHandle) -> u64 {
    app.try_state::<BackendEpoch>()
        .map(|s| s.0.load(Ordering::SeqCst))
        .unwrap_or(0)
}

/// 异步等待（tauri::async_runtime 未导出 tokio::time::sleep，
/// 用 spawn_blocking 包一层；只用于秒级等待，不占事件循环）
async fn sleep_async(dur: std::time::Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(dur)).await;
}

fn is_shutting_down(app: &tauri::AppHandle) -> bool {
    app.try_state::<ShuttingDown>()
        .map(|s| s.0.load(Ordering::SeqCst))
        .unwrap_or(true)
}

// ---- 重启轨迹日志（发布版无控制台，eprintln 会丢）----

/// 与 backend/start.py 保持一致：%LOCALAPPDATA%\PDF Reader Translate（其余平台 ~/…）
fn log_dir() -> Option<std::path::PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA").or_else(|| std::env::var_os("HOME"))?;
    Some(std::path::PathBuf::from(base).join("PDF Reader Translate"))
}

fn backend_log_path() -> String {
    log_dir()
        .map(|d| d.join("backend.log").to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn restart_log_path() -> Option<std::path::PathBuf> {
    log_dir().map(|d| d.join("backend-restart.log"))
}

/// 追加一条重启轨迹（时间戳为 Unix 秒；人类可读的崩溃详情在隔壁 backend.log）。
/// 写失败静默忽略——日志永远不该影响主流程。
fn log_restart(line: &str) {
    eprintln!("[Tauri] {line}");
    let Some(path) = restart_log_path() else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        use std::io::Write;
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(f, "[{ts}] {line}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            read_pdf_file,
            write_file,
            restart_backend
        ])
        .manage(BackendProcess(Mutex::new(None)))
        .manage(ShuttingDown(AtomicBool::new(false)))
        .manage(BackendEpoch(AtomicU64::new(0)))
        .setup(|app| {
            // 启动 Python 后端 sidecar（开发阶段直接用系统 Python）
            // 打包后可替换为 sidecar 可执行文件
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                start_backend(&handle).await;
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关窗由前端 onCloseRequested 处理（弹「保留批注」对话框或直接 destroy）；
            // 窗口真正销毁后杀后端（taskkill 杀进程树，清掉 PyInstaller onefile 子进程）。
            if let tauri::WindowEvent::Destroyed = event {
                kill_backend(window);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

async fn start_backend(app: &tauri::AppHandle) {
    // 若后端已在运行（用户手动启动，或上次未退干净），则不再重复拉起
    if backend_is_up() {
        println!("[Tauri] Backend already running on 127.0.0.1:8765, skip spawn");
        return;
    }
    if let Err(e) = spawn_and_watch(app).await {
        // 拉起失败不 emit failed（可能只是慢）：前端轮询会走原有「启动中→离线」路径，
        // 离线卡片上的「重启后端」按钮仍可手动补救
        log_restart(&format!("initial spawn failed: {e}"));
    }
}

/// 拉起后端并挂上退出监听。世代 +1，作废旧 watcher。
async fn spawn_and_watch(app: &tauri::AppHandle) -> Result<(), String> {
    let (rx, child) = spawn_backend(app).await?;
    store_child(app, child);
    let epoch = bump_epoch(app);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        watch_backend(handle, rx, epoch).await;
    });
    Ok(())
}

/// 监听后端进程退出事件，按策略限次重拉（审计 3.6）。
///
/// 事件驱动（消费 spawn 返回的 Receiver），不轮询：能拿到退出码，零延迟。
/// 重拉预算（MAX_RESTARTS 次、退避间隔）是**每次接管**独立的局部变量；
/// 上一实例健康运行超过 HEALTHY_WINDOW_SECS 才崩，预算清零重来。
async fn watch_backend(
    app: tauri::AppHandle,
    mut rx: tauri::async_runtime::Receiver<CommandEvent>,
    my_epoch: u64,
) {
    // 是否已被别人接管：应用退出，或有更新的拉起动作（手动重启/新一轮 spawn_and_watch）
    let superseded = || is_shutting_down(&app) || current_epoch(&app) != my_epoch;

    let mut failures: u32 = 0;
    let mut spawned_at = std::time::Instant::now();

    loop {
        let event = match rx.recv().await {
            Some(e) => e,
            None => return, // 通道关闭：进程已被别的 watcher/清理逻辑接管
        };
        let CommandEvent::Terminated(payload) = event else {
            continue; // Stdout/Stderr 等：后端日志已自己落盘，这里不关心
        };
        if superseded() {
            return; // 关窗清理或手动重启杀的进程，不归我们重拉
        }

        let alive_secs = spawned_at.elapsed().as_secs();
        log_restart(&format!(
            "backend exited: code={:?} signal={:?} alive={alive_secs}s",
            payload.code, payload.signal
        ));

        // 跑了很久才崩 → 偶发事故，不占用重拉预算
        if alive_secs >= HEALTHY_WINDOW_SECS {
            failures = 0;
        }

        // 重拉尝试循环：每次失败（含拉起本身失败）消耗一次预算
        loop {
            if failures >= MAX_RESTARTS {
                log_restart(&format!("restart budget exhausted ({MAX_RESTARTS}), giving up"));
                let _ = app.emit(
                    "backend-status",
                    serde_json::json!({
                        "state": "failed",
                        "code": payload.code,
                        "logPath": backend_log_path(),
                        "restartLog": restart_log_path()
                            .map(|p| p.to_string_lossy().into_owned())
                            .unwrap_or_default(),
                    }),
                );
                return;
            }
            let delay = RESTART_DELAYS_SECS[failures as usize];
            failures += 1;
            let _ = app.emit(
                "backend-status",
                serde_json::json!({ "state": "restarting", "attempt": failures, "max": MAX_RESTARTS }),
            );
            log_restart(&format!("restart attempt #{failures}/{MAX_RESTARTS} in {delay}s"));
            sleep_async(std::time::Duration::from_secs(delay)).await;
            if superseded() {
                return;
            }
            // 等待期间后端已恢复（残留进程复活/用户手动起了）就不重拉——
            // 自动路径保持「探活→活着就不重拉」语义
            if backend_is_up() {
                log_restart("backend is up again, skip restart");
                let _ = app.emit("backend-status", serde_json::json!({ "state": "running" }));
                return; // 没有可监听的子进程句柄，交回前端轮询
            }
            match spawn_backend(&app).await {
                Ok((new_rx, child)) => {
                    log_restart(&format!("restart spawn ok, pid={}", child.pid()));
                    store_child(&app, child);
                    spawned_at = std::time::Instant::now();
                    rx = new_rx;
                    break; // 回到外层等待这个新实例的退出事件
                }
                Err(e) => {
                    log_restart(&format!("restart spawn failed: {e}"));
                    // 继续消耗预算重试（回到 loop 顶部）
                }
            }
        }
    }
}

/// 双模式：开发用系统 Python（改后端代码免重打包），发布用 sidecar exe
#[cfg(debug_assertions)]
async fn spawn_backend(
    app: &tauri::AppHandle,
) -> Result<(tauri::async_runtime::Receiver<CommandEvent>, CommandChild), String> {
    let script_path = locate_backend_script().ok_or_else(|| {
        "未找到 backend/start.py，请手动启动后端：cd backend && python start.py".to_string()
    })?;
    let mut last_err = String::new();
    for py in ["python", "python3"] {
        match app.shell().command(py).args([&script_path]).spawn() {
            Ok((rx, child)) => {
                println!("[Tauri] Python backend started via '{py}'");
                return Ok((rx, child));
            }
            Err(e) => last_err = format!("'{py}' 启动失败: {e}"),
        }
    }
    Err(format!("{last_err}。也可手动运行：python backend/start.py"))
}

#[cfg(not(debug_assertions))]
async fn spawn_backend(
    app: &tauri::AppHandle,
) -> Result<(tauri::async_runtime::Receiver<CommandEvent>, CommandChild), String> {
    let cmd = app
        .shell()
        .sidecar("backend")
        .map_err(|e| format!("sidecar 构造失败: {e}"))?;
    cmd.spawn()
        .map_err(|e| format!("sidecar spawn 失败: {e}"))
}

/// 探测「我们的后端」是否已在监听：请求 /api/health 并检查 200。
/// 裸 TCP 连接无法区分自己的后端与占用 8765 的无关进程——
/// 那会让应用跳过拉起后端并永久「离线」。
fn backend_is_up() -> bool {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Duration;
    let addr = match "127.0.0.1:8765".parse() {
        Ok(a) => a,
        Err(_) => return false,
    };
    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(300)) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(300)));
    if stream
        .write_all(b"GET /api/health HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut buf = vec![0u8; 512];
    let n = stream.read(&mut buf).unwrap_or(0);
    // 响应状态行形如 "HTTP/1.1 200 OK"
    String::from_utf8_lossy(&buf[..n]).contains(" 200 ")
}

/// 在多个候选路径中查找 start.py，返回第一个存在的绝对路径。（仅开发模式用）
#[cfg(debug_assertions)]
fn locate_backend_script() -> Option<String> {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();

    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("backend/start.py"));
        candidates.push(cwd.join("../backend/start.py"));
        candidates.push(cwd.join("../../backend/start.py"));
    }

    candidates
        .into_iter()
        .find(|p| p.exists())
        .and_then(|p| p.canonicalize().ok())
        .and_then(|p| p.to_str().map(|s| s.to_string()))
}
