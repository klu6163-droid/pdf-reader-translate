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
