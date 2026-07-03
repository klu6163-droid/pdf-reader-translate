"""后端启动脚本。Tauri 会拉起此脚本；也可手动 `python start.py` 独立运行。"""
from __future__ import annotations

import os
import sys

# 非 PyInstaller 环境下，把脚本所在目录加入 path 以便 import app 包。
# PyInstaller 冻结模式下 app 已随包内嵌，无需此 hack。
if not getattr(sys, "frozen", False):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import uvicorn
from app.main import app  # 静态导入，便于 PyInstaller 跟踪依赖

if __name__ == "__main__":
    port = int(os.environ.get("BACKEND_PORT", "8765"))
    uvicorn.run(app, host="127.0.0.1", port=port, reload=False)

