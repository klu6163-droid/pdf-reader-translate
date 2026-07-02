// Tauri 应用核心逻辑。main.rs 只调用本文件的 run()，
// 以符合 Tauri v2 官方模板结构（lib + bin），便于将来扩展移动端。

use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_shell::ShellExt;

/// 保存 Python 子进程句柄，应用退出时一并关闭
struct BackendProcess(Mutex<Option<tauri_plugin_shell::process::CommandChild>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
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
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // 关闭窗口时终止后端进程
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

    // 在多个候选位置查找 backend/start.py：
    // - 开发模式：工作目录通常是 src-tauri，脚本在 ../backend
    // - 打包模式：随资源目录分发
    let script_path = match locate_backend_script(app) {
        Some(p) => p,
        None => {
            eprintln!(
                "[Tauri] 未找到 backend/start.py，请手动启动后端：cd backend && python start.py"
            );
            return;
        }
    };
    println!("[Tauri] Using backend script: {script_path}");

    // 依次尝试 python / python3，兼容不同系统
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

/// 在多个候选路径中查找 start.py，返回第一个存在的绝对路径。
fn locate_backend_script(app: &tauri::AppHandle) -> Option<String> {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();

    // 资源目录（打包后）
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join("backend/start.py"));
        candidates.push(res.join("../backend/start.py"));
    }
    // 当前工作目录及其上级（开发模式，cwd 常为 src-tauri 或项目根）
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
