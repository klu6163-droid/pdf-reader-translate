"""BodySizeLimitMiddleware / HeavyTaskGate 单元测试。"""
from __future__ import annotations

import asyncio

import pytest
from fastapi import FastAPI
from httpx import AsyncClient, ASGITransport

from app.middlewares import BodySizeLimitMiddleware, HeavyTaskGate


def _make_app(max_bytes: int) -> FastAPI:
    app = FastAPI()
    app.add_middleware(BodySizeLimitMiddleware, max_bytes=max_bytes)

    @app.post("/echo")
    async def echo(payload: dict) -> dict:
        return {"ok": True, "len": len(payload.get("data", ""))}

    return app


@pytest.mark.asyncio
async def test_reject_oversized_body():
    app = _make_app(max_bytes=128)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        big = "x" * 512
        r = await client.post("/echo", json={"data": big})
        assert r.status_code == 413
        assert "过大" in r.json()["detail"]


@pytest.mark.asyncio
async def test_allow_small_body():
    app = _make_app(max_bytes=1024)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        r = await client.post("/echo", json={"data": "hi"})
        assert r.status_code == 200
        assert r.json()["len"] == 2


@pytest.mark.asyncio
async def test_heavy_task_gate_serializes():
    """并发进入闸门时，同时活动的协程数不超过 limit。"""
    gate = HeavyTaskGate(limit=2)
    active = 0
    peak = 0
    lock = asyncio.Lock()

    async def worker():
        nonlocal active, peak
        async with gate:
            async with lock:
                active += 1
                peak = max(peak, active)
            await asyncio.sleep(0.01)
            async with lock:
                active -= 1

    await asyncio.gather(*[worker() for _ in range(10)])
    assert peak <= 2
    assert peak >= 2  # 10 worker + sleep(0.01) 足以达到并发上限，防止 gate 退化为串行


@pytest.mark.asyncio
async def test_reject_oversized_chunked():
    """无 Content-Length（chunked）的带体请求，累计字节超限也返回 413。

    直接在 ASGI 层调用中间件，绕过 httpx（httpx 总会带 Content-Length）。
    """

    async def downstream(scope, receive, send):
        # 把 body 读完
        while True:
            msg = await receive()
            if msg.get("type") == "http.request" and not msg.get("more_body"):
                break
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    app = BodySizeLimitMiddleware(downstream, max_bytes=128)

    chunks = [b"x" * 100, b"x" * 100]  # 共 200 > 128
    idx = {"i": 0}

    async def receive():
        if idx["i"] < len(chunks):
            msg = {"type": "http.request", "body": chunks[idx["i"]], "more_body": True}
            idx["i"] += 1
            return msg
        return {"type": "http.request", "body": b"", "more_body": False}

    sent: list = []

    async def send(message):
        sent.append(message)

    scope = {"type": "http", "method": "POST", "path": "/echo", "headers": []}
    await app(scope, receive, send)

    starts = [m for m in sent if m.get("type") == "http.response.start"]
    assert starts and starts[0]["status"] == 413
    # 下游的 200 响应应被吞掉，不出现两个 response.start
    assert len(starts) == 1
