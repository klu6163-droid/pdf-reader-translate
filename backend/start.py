"""后端启动脚本。Tauri 会拉起此脚本；也可手动 `python start.py` 独立运行。"""
from __future__ import annotations

import os
import sys
import time
import urllib.request
import webbrowser
from pathlib import Path


def _portable_web_dir() -> Path | None:
    """Return the sibling web bundle used by the no-install browser edition."""
    configured = os.environ.get("PDF_READER_WEB_DIR", "").strip()
    if configured:
        candidate = Path(configured).expanduser().resolve()
    elif getattr(sys, "frozen", False):
        candidate = Path(sys.executable).resolve().parent / "web"
    else:
        return None
    return candidate if (candidate / "index.html").is_file() else None


_PORTABLE_WEB_DIR = _portable_web_dir()
if _PORTABLE_WEB_DIR is not None:
    # app.main reads this before registering the final static-file mount.
    os.environ["PDF_READER_WEB_DIR"] = str(_PORTABLE_WEB_DIR)

_PORTABLE_URL = "http://127.0.0.1:8765/"


def _portable_backend_ready() -> bool:
    """Confirm that port 8765 belongs to a running portable edition."""
    try:
        with urllib.request.urlopen(f"{_PORTABLE_URL}api/health", timeout=0.8) as response:
            if response.status != 200:
                return False
        with urllib.request.urlopen(_PORTABLE_URL, timeout=0.8) as response:
            content_type = response.headers.get("Content-Type", "")
            body = response.read(65536).decode("utf-8", errors="ignore")
        return response.status == 200 and "text/html" in content_type and 'id="root"' in body
    except Exception:
        return False


def _open_portable_ui_when_ready() -> None:
    """Wait for Uvicorn, then open the locally hosted UI in the default browser."""
    for _ in range(120):
        if _portable_backend_ready():
            webbrowser.open(_PORTABLE_URL)
            return
        time.sleep(0.25)


# A second launch should focus the existing browser service instead of failing
# with an opaque "address already in use" error after importing heavy PDF modules.
if (
    __name__ == "__main__"
    and _PORTABLE_WEB_DIR is not None
    and _portable_backend_ready()
):
    if os.environ.get("PDF_READER_NO_BROWSER") != "1":
        webbrowser.open(_PORTABLE_URL)
    raise SystemExit(0)

# ----- stdout/stderr 重定向到日志文件 -----
# frozen（打包）模式：Tauri 无控制台，stdout/stderr 句柄在 Windows 上可能不可写，
#   pdf2zh/babeldoc/onnxruntime 的 tqdm 与日志写句柄会抛 [Errno 22] Invalid argument
#   导致全文翻译直接失败。把 C 层 fd 1/2 + Python sys.stdout/stderr 都指向文件。
# dev（开发）模式：终端输出保留，同时 Tee 一份到同一 backend.log，
#   方便排查 pdf2zh 等报错（dev 下原本只在终端可见，无法事后翻看）。
_LOG_DIR = os.path.join(
    os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"),
    "PDF Reader Translate",
)
_LOG_PATH = os.path.join(_LOG_DIR, "backend.log")


def _start_log_watchdog(log_file, path: str) -> None:
    """运行期滚动检查日志大小（长会话中启动时检查一次不够）。

    超限时先保留为 backend.log.1，备份成功后才清空当前打开句柄。
    """
    import threading
    import time
    from app.logging_utils import backup_and_truncate_open_log

    def _watch() -> None:
        while True:
            time.sleep(60)
            backup_and_truncate_open_log(log_file, path)

    threading.Thread(target=_watch, daemon=True, name="log-watchdog").start()


if getattr(sys, "frozen", False):
    try:
        from app.logging_utils import rotate_closed_log

        os.makedirs(_LOG_DIR, exist_ok=True)
        rotate_closed_log(_LOG_PATH)
        _f = open(_LOG_PATH, "a", encoding="utf-8", buffering=1)
        _fd = _f.fileno()
        os.dup2(_fd, 1)  # C 层 stdout（onnxruntime 等）
        os.dup2(_fd, 2)  # C 层 stderr
        sys.stdout = _f  # Python 层（tqdm / logging）
        sys.stderr = _f
        _start_log_watchdog(_f, _LOG_PATH)
    except Exception:
        # 兜底：丢弃所有输出，绝不让无效句柄被使用
        try:
            _n = os.open(os.devnull, os.O_WRONLY)
            os.dup2(_n, 1)
            os.dup2(_n, 2)
            os.close(_n)
        except Exception:
            pass
        # C 层 fd 修好的同时，Python 层 stdout/stderr 也必须替换，
        # 否则 print/tqdm/logging 仍用坏句柄，会复现本要修的写句柄崩溃
        try:
            _null = open(os.devnull, "w", encoding="utf-8")
            sys.stdout = _null
            sys.stderr = _null
        except Exception:
            pass
else:
    # dev：终端 + 文件双写。C 层 fd 1/2 仍指向终端（保留 onnxruntime 等直接写 fd 的输出）；
    # Python 层 sys.stdout/stderr 替换为 Tee，print/tqdm/logging/uvicorn 都会同步落盘。
    try:
        from app.logging_utils import rotate_closed_log

        os.makedirs(_LOG_DIR, exist_ok=True)
        rotate_closed_log(_LOG_PATH)
        _dev_f = open(_LOG_PATH, "a", encoding="utf-8", buffering=1)

        class _Tee:
            """同时写多个流的代理对象（dev 日志：终端 + 文件）。"""

            def __init__(self, *streams):
                self._streams = streams

            def write(self, data):
                if not data:
                    return
                for s in self._streams:
                    try:
                        s.write(data)
                    except Exception:
                        pass
                try:
                    _dev_f.flush()
                except Exception:
                    pass

            def flush(self):
                for s in self._streams:
                    try:
                        s.flush()
                    except Exception:
                        pass

            def isatty(self):
                return any(
                    getattr(s, "isatty", lambda: False)() for s in self._streams
                )

            def fileno(self):
                return self._streams[0].fileno()

            def __getattr__(self, name):
                return getattr(self._streams[0], name)

        sys.stdout = _Tee(sys.__stdout__, _dev_f)
        sys.stderr = _Tee(sys.__stderr__, _dev_f)
        _start_log_watchdog(_dev_f, _LOG_PATH)
    except Exception:
        # 失败则保持原终端输出，不影响开发
        pass

# 非 PyInstaller 环境下，把脚本所在目录加入 path 以便 import app 包。
# PyInstaller 冻结模式下 app 已随包内嵌，无需此 hack。
if not getattr(sys, "frozen", False):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import uvicorn  # noqa: E402
from app.logging_utils import configure_logging  # noqa: E402
from app.main import app  # noqa: E402  # 静态导入，便于 PyInstaller 跟踪依赖

configure_logging()

if __name__ == "__main__":
    if (
        _PORTABLE_WEB_DIR is not None
        and os.environ.get("PDF_READER_NO_BROWSER") != "1"
    ):
        import threading

        threading.Thread(
            target=_open_portable_ui_when_ready,
            daemon=True,
            name="portable-browser-opener",
        ).start()
    # 端口固定 8765（审计 2.7）：前端 BASE 与 Tauri 探测都以该值为准，
    # 旧的 BACKEND_PORT 环境变量只有后端遵守，改它反而让前后端整体断连，故移除
    uvicorn.run(app, host="127.0.0.1", port=8765, reload=False, log_config=None)
