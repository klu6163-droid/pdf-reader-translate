"""HTTP 中间件：请求大小限制、重任务并发闸门。

- BodySizeLimitMiddleware: 纯 ASGI 请求体大小限制。
  - 有 Content-Length：直接判断，超限返回 413，不读 body。
  - 无 Content-Length（chunked）的带体请求：包装 receive 累计已读字节，超限即
    发送 413 并向应用返回空 EOF，阻止继续读取，堵住 chunked 绕过。
  纯 ASGI 实现，避免 BaseHTTPMiddleware 对 StreamingResponse（SSE 等）的潜在影响。
- HeavyTaskGate: asyncio.Semaphore 包装，供路由层显式 `async with gate:` 使用，
  控制翻译类重任务并发数。轻请求（summary、健康检查、EventSource stream）不进闸门。
"""
from __future__ import annotations

import asyncio
import json
import logging

from starlette.types import ASGIApp, Receive, Scope, Send

from app.config import MAX_CONCURRENT_TASKS, MAX_UPLOAD_BYTES

logger = logging.getLogger("app.middlewares")


def _content_length(scope: Scope) -> int | None:
    """从 ASGI scope 头里取 content-length，无效或缺失返回 None。"""
    for key, value in scope.get("headers") or []:
        if key.lower() == b"content-length":
            try:
                return int(value)
            except (ValueError, TypeError):
                return None
    return None


class BodySizeLimitMiddleware:
    """请求体大小限制（纯 ASGI）。"""

    def __init__(self, app: ASGIApp, max_bytes: int = MAX_UPLOAD_BYTES) -> None:
        self.app = app
        self._max = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        cl = _content_length(scope)
        if cl is not None and cl > self._max:
            # 有 Content-Length 且超限：直接 413，不进入应用
            await self._reject(send, scope, f"content-length={cl}")
            return

        # 无 Content-Length 的带体请求（chunked）：累计字节防绕过
        if scope.get("method", "") in ("POST", "PUT", "PATCH") and cl is None:
            await self._run_stream_limited(scope, receive, send)
            return

        await self.app(scope, receive, send)

    async def _run_stream_limited(self, scope: Scope, receive: Receive, send: Send) -> None:
        limit = self._max
        state = {"received": 0, "too_large": False}

        async def counting_receive():
            message = await receive()
            if message.get("type") == "http.request":
                if state["too_large"]:
                    # 已超限：向应用返回空 EOF，停止继续读取
                    return {"type": "http.request", "body": b"", "more_body": False}
                body = message.get("body", b"") or b""
                state["received"] += len(body)
                if state["received"] > limit:
                    state["too_large"] = True
                    await self._reject(send, scope, f"streamed={state['received']}")
                    return {"type": "http.request", "body": b"", "more_body": False}
            return message

        async def guarded_send(message):
            # 超限后吞掉应用自身的响应发送，避免覆盖已发出的 413
            if state["too_large"]:
                return
            await send(message)

        await self.app(scope, counting_receive, guarded_send)

    async def _reject(self, send: Send, scope: Scope, hint: str) -> None:
        mb = self._max // (1024 * 1024)
        logger.warning(
            "请求体过大 %s %s (%s) > %s",
            scope.get("method"), scope.get("path"), hint, self._max,
        )
        body = json.dumps({"detail": f"上传内容过大，最大允许 {mb} MB"}).encode("utf-8")
        await send({
            "type": "http.response.start",
            "status": 413,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode("latin-1")),
            ],
        })
        await send({"type": "http.response.body", "body": body})


class HeavyTaskGate:
    """重任务并发闸门（asyncio.Semaphore 的语义包装）。

    用法：
        async with heavy_task_gate:
            ... # 翻译等重任务
    """

    def __init__(self, limit: int = MAX_CONCURRENT_TASKS) -> None:
        self._sem = asyncio.Semaphore(limit)
        self._limit = limit

    @property
    def limit(self) -> int:
        return self._limit

    async def __aenter__(self) -> "HeavyTaskGate":
        await self._sem.acquire()
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        self._sem.release()


# 全局单例
heavy_task_gate = HeavyTaskGate()
