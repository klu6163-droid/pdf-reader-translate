"""后端启动脚本。Tauri 会拉起此脚本；也可手动 `python start.py` 独立运行。"""
from __future__ import annotations

import os
import sys

# ----- 冻结模式下重定向 stdout/stderr 到日志文件 -----
# Tauri（无控制台的窗口程序）拉起本 sidecar 时，stdout/stderr 句柄在 Windows 上
# 可能不可写：pdf2zh / babeldoc / onnxruntime 的 tqdm 进度条与日志输出写句柄时会抛
# [Errno 22] Invalid argument，导致全文翻译直接失败。重定向到文件既修复该问题，
# 又提供可排查的后端日志（release 模式下原本无可见日志）。
if getattr(sys, "frozen", False):
    try:
        _log_dir = os.path.join(
            os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"),
            "PDF Reader Translate",
        )
        os.makedirs(_log_dir, exist_ok=True)
        _log_path = os.path.join(_log_dir, "backend.log")
        # 超过 5MB 则重置，避免无限增长
        try:
            if os.path.getsize(_log_path) > 5 * 1024 * 1024:
                os.remove(_log_path)
        except OSError:
            pass
        _f = open(_log_path, "a", encoding="utf-8", buffering=1)
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

# 非 PyInstaller 环境下，把脚本所在目录加入 path 以便 import app 包。
# PyInstaller 冻结模式下 app 已随包内嵌，无需此 hack。
if not getattr(sys, "frozen", False):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import uvicorn
from app.main import app  # 静态导入，便于 PyInstaller 跟踪依赖

if __name__ == "__main__":
    port = int(os.environ.get("BACKEND_PORT", "8765"))
    uvicorn.run(app, host="127.0.0.1", port=port, reload=False)

