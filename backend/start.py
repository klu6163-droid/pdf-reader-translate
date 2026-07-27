"""后端启动脚本。Tauri 会拉起此脚本；也可手动 `python start.py` 独立运行。"""
from __future__ import annotations

import os
import sys

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


def _reset_log_if_too_big(path: str) -> None:
    """超过 5MB 则重置，避免无限增长。"""
    try:
        if os.path.exists(path) and os.path.getsize(path) > 5 * 1024 * 1024:
            os.remove(path)
    except OSError:
        pass


if getattr(sys, "frozen", False):
    try:
        os.makedirs(_LOG_DIR, exist_ok=True)
        _reset_log_if_too_big(_LOG_PATH)
        _f = open(_LOG_PATH, "a", encoding="utf-8", buffering=1)
        _fd = _f.fileno()
        os.dup2(_fd, 1)  # C 层 stdout（onnxruntime 等）
        os.dup2(_fd, 2)  # C 层 stderr
        sys.stdout = _f  # Python 层（tqdm / logging）
        sys.stderr = _f
    except Exception:
        # 兜底：丢弃所有输出，绝不让无效句柄被使用
        try:
            _n = os.open(os.devnull, os.O_WRONLY)
            os.dup2(_n, 1)
            os.dup2(_n, 2)
            os.close(_n)
        except Exception:
            pass
else:
    # dev：终端 + 文件双写。C 层 fd 1/2 仍指向终端（保留 onnxruntime 等直接写 fd 的输出）；
    # Python 层 sys.stdout/stderr 替换为 Tee，print/tqdm/logging/uvicorn 都会同步落盘。
    try:
        os.makedirs(_LOG_DIR, exist_ok=True)
        _reset_log_if_too_big(_LOG_PATH)
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
    except Exception:
        # 失败则保持原终端输出，不影响开发
        pass

# 非 PyInstaller 环境下，把脚本所在目录加入 path 以便 import app 包。
# PyInstaller 冻结模式下 app 已随包内嵌，无需此 hack。
if not getattr(sys, "frozen", False):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import uvicorn
from app.main import app  # 静态导入，便于 PyInstaller 跟踪依赖

if __name__ == "__main__":
    port = int(os.environ.get("BACKEND_PORT", "8765"))
    uvicorn.run(app, host="127.0.0.1", port=port, reload=False)

