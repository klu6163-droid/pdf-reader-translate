"""后端启动脚本。Tauri 会拉起此脚本；也可手动 `python start.py` 独立运行。"""
from __future__ import annotations

import os
import sys

# 确保能 import app 包
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import uvicorn

if __name__ == "__main__":
    port = int(os.environ.get("BACKEND_PORT", "8765"))
    uvicorn.run("app.main:app", host="127.0.0.1", port=port, reload=False)
