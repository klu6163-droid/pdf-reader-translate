"""集中读取运行期配置（环境变量），保持默认值合理。

- MAX_UPLOAD_BYTES: 单请求 Content-Length 上限（超出立即 413）。默认 200MB。
- MAX_CONCURRENT_TASKS: 重任务（全文翻译/覆盖翻译）的并发闸门。默认 2。
- ALLOWED_ORIGINS: 逗号分隔，CORS 白名单。默认覆盖 Tauri 与本地 Vite。
"""
from __future__ import annotations

import os
from typing import List


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return max(1, int(raw))
    except ValueError:
        return default


MAX_UPLOAD_BYTES: int = _int_env("MAX_UPLOAD_BYTES", 200 * 1024 * 1024)
MAX_CONCURRENT_TASKS: int = _int_env("MAX_CONCURRENT_TASKS", 2)

_DEFAULT_ORIGINS = (
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "http://localhost:1420",
    "http://127.0.0.1:1420",
)


def allowed_origins() -> List[str]:
    raw = os.environ.get("ALLOWED_ORIGINS", "").strip()
    if not raw:
        return list(_DEFAULT_ORIGINS)
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    return parts or list(_DEFAULT_ORIGINS)
