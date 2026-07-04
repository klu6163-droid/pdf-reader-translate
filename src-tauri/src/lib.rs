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
            // 注意：必须在 Destroyed（真正销毁）而非 CloseRequested（关闭请求）时杀后端。
            // 前端会拦截 CloseRequested 弹「是否保留批注」，若在请求阶段就杀后端，
            // 用户点「取消」继续用时后端已经没了。
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<BackendProcess>() {
                    if let Ok(mut child) = state.0.lock() {
                        if let Some(proc) = child.take() {
                            let _ = proc.kill();
                        }
                    }
                }
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

/// 探测本地 8765 端口是否有服务在监听。
fn backend_is_up() -> bool {
    use std::net::TcpStream;
    use std::time::Duration;
    let addr = match "127.0.0.1:8765".parse() {
        Ok(a) => a,
        Err(_) => return false,
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
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
