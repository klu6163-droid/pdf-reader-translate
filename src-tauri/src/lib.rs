// Tauri 应用核心逻辑。main.rs 只调用本文件的 run()，
// 以符合 Tauri v2 官方模板结构（lib + bin），便于将来扩展移动端。

use std::sync::Mutex;
use tauri::Manager;
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

/// 保存 Python 子进程句柄，应用退出时一并关闭
struct BackendProcess(Mutex<Option<tauri_plugin_shell::process::CommandChild>>);

/// 杀掉启动时存入的 sidecar 子进程：先 kill 句柄，再按 PID 杀整棵进程树
/// （PyInstaller onefile 的子进程不会被 bootloader 的 kill 带走，/T 兜住）。
/// 不再用 /IM 按映像名全局杀：双开会杀掉另一实例的后端，还可能误杀同名无关进程。
fn kill_backend(window: &tauri::Window) {
    let pid: Option<u32> = window.try_state::<BackendProcess>().and_then(|state| {
        state
            .0
            .lock()
            .ok()
            .and_then(|mut child| child.take())
            .map(|proc| {
                let pid = proc.pid();
                let _ = proc.kill();
                pid
            })
    });
    let _ = pid; // 仅发布版 Windows 需要；其余平台避免 unused 警告
    #[cfg(all(windows, not(debug_assertions)))]
    if let Some(pid) = pid {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![read_pdf_file, write_file])
        .manage(BackendProcess(Mutex::new(None)))
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

    // 双模式：开发用系统 Python（改后端代码免重打包），发布用 sidecar exe
    #[cfg(debug_assertions)]
    start_backend_dev(app).await;
    #[cfg(not(debug_assertions))]
    start_backend_sidecar(app).await;
}

/// 开发模式：用系统 Python 跑 backend/start.py
#[cfg(debug_assertions)]
async fn start_backend_dev(app: &tauri::AppHandle) {
    let script_path = match locate_backend_script() {
        Some(p) => p,
        None => {
            eprintln!(
                "[Tauri] 未找到 backend/start.py，请手动启动后端：cd backend && python start.py"
            );
            return;
        }
    };
    println!("[Tauri] Using backend script: {script_path}");

    for py in ["python", "python3"] {
        match app.shell().command(py).args([&script_path]).spawn() {
            Ok((_, child)) => {
                if let Some(state) = app.try_state::<BackendProcess>() {
                    if let Ok(mut guard) = state.0.lock() {
                        *guard = Some(child);
                    }
                }
                println!("[Tauri] Python backend started via '{py}'");
                return;
            }
            Err(e) => {
                eprintln!("[Tauri] '{py}' 启动失败: {e}，尝试下一个候选");
            }
        }
    }
    eprintln!("[Tauri] 无法启动 Python 后端，请手动运行：python backend/start.py");
}

/// 发布模式：启动打包好的 backend sidecar exe
#[cfg(not(debug_assertions))]
async fn start_backend_sidecar(app: &tauri::AppHandle) {
    let cmd = match app.shell().sidecar("backend") {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[Tauri] sidecar 构造失败: {e}");
            return;
        }
    };
    match cmd.spawn() {
        Ok((_rx, child)) => {
            if let Some(state) = app.try_state::<BackendProcess>() {
                if let Ok(mut guard) = state.0.lock() {
                    *guard = Some(child);
                }
            }
            println!("[Tauri] backend sidecar started");
        }
        Err(e) => eprintln!("[Tauri] sidecar spawn 失败: {e}"),
    }
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
