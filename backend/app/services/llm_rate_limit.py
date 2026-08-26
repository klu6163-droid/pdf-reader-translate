"""进程内共享的 LLM 并发、节流与 429 退避工具。

限流器按事件循环和「凭据指纹 + Base URL + 模型 + 限流参数」共享：
- 同一上游配置创建多个 LLMService 时仍受同一并发/请求间隔约束；
- 注册表只保存 API Key 的 SHA-256 指纹，不保存原始密钥；
- 不同 pytest 事件循环不会复用 asyncio 锁，避免跨循环绑定错误。
"""
from __future__ import annotations

import asyncio
import hashlib
import threading
import weakref
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import AsyncIterator, Optional

from app.models.schemas import LLMConfig


class SharedRequestLimiter:
    """限制并发数，并平滑相邻请求的开始时间。"""

    def __init__(self, max_concurrency: int, request_interval_ms: int):
        self._semaphore = asyncio.Semaphore(max_concurrency)
        self._pace_lock = asyncio.Lock()
        self._interval = request_interval_ms / 1000.0
        self._next_allowed = 0.0

    @asynccontextmanager
    async def slot(self) -> AsyncIterator[None]:
        """占用一个并发槽，并在发请求前执行平滑节流。"""
        await self._semaphore.acquire()
        try:
            async with self._pace_lock:
                loop = asyncio.get_running_loop()
                delay = max(0.0, self._next_allowed - loop.time())
                if delay:
                    await asyncio.sleep(delay)
                now = loop.time()
                self._next_allowed = max(self._next_allowed, now) + self._interval
            yield
        finally:
            self._semaphore.release()

    async def defer(self, delay: float) -> None:
        """429 后推迟该配置的所有后续请求，避免各调用者继续撞限额。"""
        async with self._pace_lock:
            loop = asyncio.get_running_loop()
            self._next_allowed = max(self._next_allowed, loop.time() + delay)


_REGISTRY_LOCK = threading.Lock()
_LIMITERS: weakref.WeakKeyDictionary[
    asyncio.AbstractEventLoop, dict[tuple[object, ...], SharedRequestLimiter]
] = weakref.WeakKeyDictionary()


def get_shared_limiter(config: LLMConfig) -> SharedRequestLimiter:
    """取得当前事件循环中与该上游配置对应的共享限流器。"""
    loop = asyncio.get_running_loop()
    credential_fingerprint = hashlib.sha256(config.api_key.encode("utf-8")).hexdigest()
    key = (
        credential_fingerprint,
        config.base_url.rstrip("/"),
        config.model,
        config.max_concurrency,
        config.request_interval_ms,
    )
    with _REGISTRY_LOCK:
        per_loop = _LIMITERS.setdefault(loop, {})
        limiter = per_loop.get(key)
        if limiter is None:
            limiter = SharedRequestLimiter(
                config.max_concurrency, config.request_interval_ms
            )
            per_loop[key] = limiter
        return limiter


def retry_delay_seconds(
    retry_after: Optional[str], retry_index: int, base_seconds: float
) -> float:
    """计算 429 等待时间；优先遵守 Retry-After，否则使用指数退避。"""
    parsed_retry_after = _parse_retry_after(retry_after)
    if parsed_retry_after is not None:
        return min(max(parsed_retry_after, 0.0), 300.0)
    return min(base_seconds * (2 ** retry_index), 300.0)


def _parse_retry_after(value: Optional[str]) -> Optional[float]:
    if not value:
        return None
    try:
        return float(value)
    except ValueError:
        pass
    try:
        retry_at = parsedate_to_datetime(value)
        if retry_at.tzinfo is None:
            retry_at = retry_at.replace(tzinfo=timezone.utc)
        return (retry_at - datetime.now(timezone.utc)).total_seconds()
    except (TypeError, ValueError, OverflowError):
        return None
