// Tauri 应用核心逻辑。main.rs 只调用本文件的 run()，
// 以符合 Tauri v2 官方模板结构（lib + bin），便于将来扩展移动端。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// 读取本地 PDF 文件，以 IPC 裸字节通道（`tauri::ipc::Response`）返回。
/// 前端通过 invoke("read_pdf_file", { path }) 调用，拿到 ArrayBuffer。
/// 用 Rust 直接读文件，不依赖 tauri-plugin-fs 的 scope 配置。
///
/// 审计 3.5：不走 JSON number[] 返回——大文件（上限 200MB）会有 8~16 倍内存放大
/// 和巨慢的序列化/反序列化，直接卡死或 OOM。
#[tauri::command]
fn read_pdf_file(path: String) -> Result<tauri::ipc::Response, String> {
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
    let bytes = std::fs::read(&path).map_err(|e| format!("读取文件失败：{e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// 把字节流写入本地文件（用于导出/另存 PDF）。
/// 前端通过 invoke("write_file", bytes, { headers: { path } }) 调用：
/// 字节以裸请求体（application/octet-stream）传输，目标路径经请求头传入
/// （encodeURIComponent 编码），与 tauri-plugin-fs 的 write_file 同款机制。
/// 只允许 .pdf 后缀，与 read_pdf_file 对称。
///
/// 审计 3.5：原实现 data: Vec<u8> 走 JSON number[]，200MB 文件会产生
/// 数百 MB JSON 文本 + serde_json::Value 中间态，直接卡死或 OOM。
#[tauri::command]
fn write_file(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let path = request
        .headers()
        .get("path")
        .ok_or_else(|| "缺少保存路径（path 请求头）".to_string())
        .and_then(|v| v.to_str().map_err(|_| "保存路径不是合法字符串".to_string()))
        .and_then(percent_decode)?;

    let p = std::path::Path::new(&path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if ext != "pdf" {
        return Err(format!("不支持的文件类型：{ext}，仅支持保存 PDF"));
    }

    let data: std::borrow::Cow<'_, [u8]> = match request.body() {
        // 正常路径：裸字节请求体，零 JSON 开销
        tauri::ipc::InvokeBody::Raw(data) => std::borrow::Cow::Borrowed(data),
        // 防御兜底：异常传输以 JSON number[] 传字节（正常前端不会走到这里）
        tauri::ipc::InvokeBody::Json(serde_json::Value::Array(arr)) => {
            std::borrow::Cow::Owned(
                arr.iter()
                    .flat_map(|v| v.as_number().and_then(|v| v.as_u64().map(|v| v as u8)))
                    .collect(),
            )
        }
        _ => return Err("不支持的请求体：仅接受字节流".to_string()),
    };

    std::fs::write(&p, &data).map_err(|e| format!("写入文件失败：{e}"))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticExportRequest {
    path: String,
    backend_snapshot: Option<serde_json::Value>,
    base_urls: Vec<String>,
    redact_secrets: Vec<String>,
}

/// React 顶层 Error Boundary 将崩溃详情写入用户可直接取得的固定位置。
#[tauri::command]
fn record_frontend_crash(
    message: String,
    stack: String,
    component_stack: String,
) -> Result<String, String> {
    let path = frontend_crash_log_path().ok_or_else(|| "无法确定前端崩溃日志目录".to_string())?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建日志目录失败：{e}"))?;
    }
    let clean = |value: &str| {
        let limited: String = value.chars().take(20_000).collect();
        sanitize_log_text(&limited, &[], &[])
    };
    let entry = format!(
        "{} ERROR frontend.crash message={}\nstack={}\ncomponent_stack={}\n",
        utc_timestamp(),
        clean(&message),
        clean(&stack),
        clean(&component_stack)
    );
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("打开前端崩溃日志失败：{e}"))?;
    use std::io::Write;
    file.write_all(entry.as_bytes())
        .map_err(|e| format!("写入前端崩溃日志失败：{e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// 生成单个 diagnostics.json。即使 Python 后端离线，Rust 仍可导出本地日志。
#[tauri::command]
fn export_diagnostics(
    app: tauri::AppHandle,
    request: DiagnosticExportRequest,
) -> Result<String, String> {
    let target = std::path::PathBuf::from(&request.path);
    let version = app.package_info().version.to_string();
    let dir = log_dir();
    export_diagnostics_json(
        &target,
        &version,
        request.backend_snapshot.as_ref(),
        &request.base_urls,
        &request.redact_secrets,
        dir.as_deref(),
    )
}

/// Production export implementation, exposed so an integration test can exercise the exact
/// file-writing and redaction path without constructing a GUI `AppHandle`.
#[doc(hidden)]
pub fn export_diagnostics_json(
    target: &std::path::Path,
    app_version: &str,
    backend_snapshot: Option<&serde_json::Value>,
    base_urls: &[String],
    redact_secrets: &[String],
    source_log_dir: Option<&std::path::Path>,
) -> Result<String, String> {
    let extension = target
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if !extension.eq_ignore_ascii_case("json") {
        return Err("诊断包只能保存为 .json 文件".into());
    }

    let hosts: Vec<String> = base_urls
        .iter()
        .filter_map(|value| extract_hostname(value))
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let backend = backend_snapshot.map(sanitize_backend_snapshot);
    let log = |path: Option<std::path::PathBuf>| -> Option<String> {
        path.and_then(|value| read_log_tail(&value))
            .map(|text| sanitize_log_text(&text, redact_secrets, base_urls))
    };
    let report = serde_json::json!({
        "schema_version": 1,
        "generated_at": utc_timestamp(),
        "app": {
            "version": app_version,
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
        },
        "base_url_hosts": hosts,
        "backend": backend,
        "logs": {
            "backend.log": log(source_log_dir.map(|value| value.join("backend.log"))),
            "backend.log.1": log(source_log_dir.map(|value| value.join("backend.log.1"))),
            "backend-restart.log": log(source_log_dir.map(|value| value.join("backend-restart.log"))),
            "frontend-crash.log": log(source_log_dir.map(|value| value.join("frontend-crash.log"))),
        },
    });
    let encoded = serde_json::to_string_pretty(&report)
        .map_err(|e| format!("序列化诊断包失败：{e}"))?;
    std::fs::write(target, encoded).map_err(|e| format!("写入诊断包失败：{e}"))?;
    Ok(target.to_string_lossy().into_owned())
}

/// 解码 encodeURIComponent 编码的字符串（用于 write_file 的 path 请求头）。
/// 手写而不用 percent-encoding crate：只需处理 %XX 十六进制转义与
/// 原样 ASCII 字符，解码结果按 UTF-8 校验。
/// pub 仅为集成测试可见（见 tests/percent_decode.rs）。
pub fn percent_decode(input: &str) -> Result<String, String> {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return Err("保存路径含不完整的 % 转义".to_string());
            }
            match (
                (bytes[i + 1] as char).to_digit(16),
                (bytes[i + 2] as char).to_digit(16),
            ) {
                (Some(h), Some(l)) => out.push((h * 16 + l) as u8),
                _ => return Err("保存路径含非法的 % 转义".to_string()),
            }
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "保存路径不是合法 UTF-8".to_string())
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

fn frontend_crash_log_path() -> Option<std::path::PathBuf> {
    log_dir().map(|d| d.join("frontend-crash.log"))
}

#[doc(hidden)]
pub fn format_unix_millis(total_millis: u128) -> String {
    let total_seconds = (total_millis / 1000) as i64;
    let millis = (total_millis % 1000) as u32;
    let days = total_seconds.div_euclid(86_400);
    let seconds_in_day = total_seconds.rem_euclid(86_400);
    let hour = seconds_in_day / 3_600;
    let minute = (seconds_in_day % 3_600) / 60;
    let second = seconds_in_day % 60;

    // Howard Hinnant's civil_from_days algorithm; avoids a new date/time crate.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += if month <= 2 { 1 } else { 0 };
    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z"
    )
}

fn utc_timestamp() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    format_unix_millis(millis)
}

#[doc(hidden)]
pub fn extract_hostname(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let authority_and_path = trimmed
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(trimmed);
    let authority = authority_and_path
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .rsplit('@')
        .next()
        .unwrap_or("");
    let host = if authority.starts_with('[') {
        authority
            .strip_prefix('[')
            .and_then(|rest| rest.split_once(']').map(|(host, _)| host))
            .unwrap_or("")
    } else {
        authority.split(':').next().unwrap_or("")
    }
    .trim()
    .to_ascii_lowercase();
    if host.is_empty()
        || !host
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | ':'))
    {
        return None;
    }
    Some(host)
}

fn redact_sk_tokens(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut remaining = input;
    while let Some(index) = remaining.find("sk-") {
        output.push_str(&remaining[..index]);
        output.push_str("[REDACTED_API_KEY]");
        let token = &remaining[index + 3..];
        let end = token
            .char_indices()
            .find(|(_, ch)| !(ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-')))
            .map(|(idx, _)| idx)
            .unwrap_or(token.len());
        remaining = &token[end..];
    }
    output.push_str(remaining);
    output
}

fn urls_to_hosts(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut remaining = input;
    loop {
        let http = remaining.find("http://");
        let https = remaining.find("https://");
        let Some(index) = [http, https].into_iter().flatten().min() else {
            output.push_str(remaining);
            break;
        };
        output.push_str(&remaining[..index]);
        let url_and_rest = &remaining[index..];
        let end = url_and_rest
            .char_indices()
            .find(|(_, ch)| {
                ch.is_whitespace()
                    || matches!(
                        ch,
                        '"' | '\'' | '<' | '>' | '(' | ')' | '[' | ']' | '{' | '}' | ',' | ';'
                    )
            })
            .map(|(idx, _)| idx)
            .unwrap_or(url_and_rest.len());
        let candidate = &url_and_rest[..end];
        if let Some(host) = extract_hostname(candidate) {
            output.push_str(&host);
        } else {
            output.push_str(candidate);
        }
        remaining = &url_and_rest[end..];
    }
    output
}

#[doc(hidden)]
pub fn sanitize_log_text(input: &str, secrets: &[String], base_urls: &[String]) -> String {
    let mut text = input.to_string();
    for secret in secrets.iter().filter(|value| value.len() >= 4) {
        text = text.replace(secret, "[REDACTED_API_KEY]");
    }
    text = urls_to_hosts(&text);
    for base_url in base_urls {
        if let Some(host) = extract_hostname(base_url) {
            text = text.replace(base_url, &host);
        }
    }
    let text = redact_sk_tokens(&text);
    text.lines()
        .map(|line| {
            let lower = line.to_ascii_lowercase();
            if lower.contains("authorization")
                || lower.contains("api_key")
                || lower.contains("api-key")
                || lower.contains("bearer ")
                || lower.contains(".pdf")
                || lower.contains("original_text")
                || lower.contains("translated_text")
                || lower.contains("source_text")
                || lower.contains("target_text")
                || lower.contains("原文")
                || lower.contains("译文")
            {
                "[REDACTED_SENSITIVE_LINE]".to_string()
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[doc(hidden)]
pub fn sanitize_backend_snapshot(input: &serde_json::Value) -> serde_json::Value {
    let translations = input
        .get("recent_translations")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .take(20)
                .map(|item| {
                    serde_json::json!({
                        "task_id": item.get("task_id").and_then(|value| value.as_str()).unwrap_or("").chars().take(64).collect::<String>(),
                        "mode": item.get("mode").and_then(|value| value.as_str()).unwrap_or("").chars().take(32).collect::<String>(),
                        "duration_ms": item.get("duration_ms").and_then(|value| value.as_u64()),
                        "succeeded": item.get("succeeded").and_then(|value| value.as_bool()),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    serde_json::json!({
        "backend_version": input.get("backend_version").and_then(|value| value.as_str()).unwrap_or("").chars().take(32).collect::<String>(),
        "os": input.get("os").and_then(|value| value.as_str()).unwrap_or("").chars().take(64).collect::<String>(),
        "arch": input.get("arch").and_then(|value| value.as_str()).unwrap_or("").chars().take(64).collect::<String>(),
        "pdf2zh_available": input.get("pdf2zh_available").and_then(|value| value.as_bool()),
        "recent_translations": translations,
    })
}

fn read_log_tail(path: &std::path::Path) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    const MAX_EXPORT_LOG_BYTES: u64 = 5 * 1024 * 1024;
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    if len > MAX_EXPORT_LOG_BYTES {
        file.seek(SeekFrom::Start(len - MAX_EXPORT_LOG_BYTES)).ok()?;
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// 追加一条重启轨迹；时间戳与 Python/前端日志统一为 UTC ISO-8601 毫秒。
/// 写失败静默忽略——日志永远不该影响主流程。
fn log_restart(line: &str) {
    eprintln!("[Tauri] {line}");
    let Some(path) = restart_log_path() else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        use std::io::Write;
        let _ = writeln!(f, "{} INFO tauri.backend {line}", utc_timestamp());
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
            restart_backend,
            record_frontend_crash,
            export_diagnostics
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
