"""HTTP 中间件：请求大小限制、重任务并发闸门。

- BodySizeLimitMiddleware: 依据 Content-Length 直接拒绝超大请求（413）。
  避免 UploadFile 把 GB 级 PDF 全部落到 spooled tempfile 后再报错。
- HeavyTaskGate: asyncio.Semaphore 包装，供路由层显式 `async with gate:` 使用，
  控制翻译类重任务并发数。轻请求（summary、健康检查、EventSource stream）不进闸门。
"""
from __future__ import annotations

import asyncio
import logging
from typing import Awaitable, Callable

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

from app.config import MAX_CONCURRENT_TASKS, MAX_UPLOAD_BYTES

logger = logging.getLogger("app.middlewares")


class BodySizeLimitMiddleware(BaseHTTPMiddleware):
    """基于 Content-Length 的粗粒度请求大小限制。

    未携带 Content-Length（chunked）的请求放行，由业务层自行处理。
    """

    def __init__(self, app: ASGIApp, max_bytes: int = MAX_UPLOAD_BYTES) -> None:
        super().__init__(app)
        self._max = max_bytes

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[JSONResponse]],
    ) -> JSONResponse:
        cl = request.headers.get("content-length")
        if cl and cl.isdigit() and int(cl) > self._max:
            mb = self._max // (1024 * 1024)
            logger.warning(
                "请求体过大 %s %s: %s bytes > %s",
                request.method, request.url.path, cl, self._max,
            )
            return JSONResponse(
                status_code=413,
                content={"detail": f"上传内容过大，最大允许 {mb} MB"},
            )
        return await call_next(request)


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
