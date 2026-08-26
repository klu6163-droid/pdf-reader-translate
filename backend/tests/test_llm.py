"""llm 服务测试（审计 1.3 / 2.11：null content、网络异常包装）。"""
from __future__ import annotations

import asyncio

import httpx
import pytest

from app.models.schemas import LLMConfig
from app.services.llm import LLMError, LLMService
from app.services.llm_rate_limit import SharedRequestLimiter


def _svc(**overrides) -> LLMService:
    return LLMService(
        LLMConfig(
            api_key="k",
            base_url="http://127.0.0.1:9/v1",
            model="m",
            request_interval_ms=0,
            **overrides,
        )
    )


async def test_chat_network_error_wrapped():
    """网络异常（端口不可达）应包成 LLMError，不得裸抛。"""
    with pytest.raises(LLMError):
        await _svc().chat([{"role": "user", "content": "hi"}], timeout=2.0)


async def test_chat_null_content_raises_llm_error(monkeypatch):
    """content=null 是合法响应（内容审查拒答等），必须转成可读的 LLMError。"""

    async def fake_post(self, url, **kwargs):
        return httpx.Response(200, json={"choices": [{"message": {"content": None}}]})

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    with pytest.raises(LLMError, match="空内容"):
        await _svc().chat([{"role": "user", "content": "hi"}])


async def test_chat_retries_429_with_exponential_backoff(monkeypatch):
    """429 应按 2^n 退避重试，成功后正常返回。"""
    responses = [
        httpx.Response(429, text="rate limited"),
        httpx.Response(429, text="rate limited again"),
        httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]}),
    ]
    calls = 0

    async def fake_post(self, url, **kwargs):
        nonlocal calls
        calls += 1
        return responses.pop(0)

    svc = _svc(max_retries=2, retry_base_seconds=0.1)
    deferred: list[float] = []

    async def fake_defer(delay: float) -> None:
        deferred.append(delay)

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    monkeypatch.setattr(svc._limiter, "defer", fake_defer)

    result = await svc.chat([{"role": "user", "content": "hi"}])

    assert result == "ok"
    assert calls == 3
    assert deferred == [0.1, 0.2]


async def test_chat_429_retry_exhaustion_is_readable(monkeypatch):
    """重试耗尽后必须给可读错误，且请求次数为首次 + max_retries。"""
    calls = 0

    async def fake_post(self, url, **kwargs):
        nonlocal calls
        calls += 1
        return httpx.Response(429, text="quota exceeded")

    svc = _svc(max_retries=1, retry_base_seconds=0.1)

    async def no_wait(delay: float) -> None:
        return None

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    monkeypatch.setattr(svc._limiter, "defer", no_wait)

    with pytest.raises(LLMError, match="已重试 1 次"):
        await svc.chat([{"role": "user", "content": "hi"}])
    assert calls == 2


async def test_chat_stream_retries_429_before_yielding(monkeypatch):
    """总结等流式请求也必须在尚未输出内容时自动恢复 429。"""
    responses = [
        httpx.Response(429, text="slow down", headers={"Retry-After": "0"}),
        httpx.Response(
            200,
            content=(
                b'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'
                b"data: [DONE]\n\n"
            ),
        ),
    ]

    class FakeStreamContext:
        def __init__(self, response: httpx.Response):
            self.response = response

        async def __aenter__(self):
            return self.response

        async def __aexit__(self, exc_type, exc, tb):
            return False

    def fake_stream(self, *args, **kwargs):
        return FakeStreamContext(responses.pop(0))

    svc = _svc(max_retries=1, retry_base_seconds=0.1)
    monkeypatch.setattr(httpx.AsyncClient, "stream", fake_stream)

    chunks = [
        chunk
        async for chunk in svc.chat_stream([{"role": "user", "content": "hi"}])
    ]

    assert chunks == ["ok"]
    assert responses == []


async def test_shared_limiter_caps_concurrent_requests():
    """同一配置创建的并发调用不得超过用户设置的上限。"""
    limiter = SharedRequestLimiter(max_concurrency=1, request_interval_ms=0)
    active = 0
    peak = 0

    async def worker() -> None:
        nonlocal active, peak
        async with limiter.slot():
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(0.01)
            active -= 1

    await asyncio.gather(*(worker() for _ in range(4)))
    assert peak == 1


async def test_shared_limiter_smooths_request_start_times():
    """即使并发槽充足，请求开始时间也必须按设置的间隔平滑排开。"""
    limiter = SharedRequestLimiter(max_concurrency=3, request_interval_ms=30)
    started: list[float] = []

    async def worker() -> None:
        async with limiter.slot():
            started.append(asyncio.get_running_loop().time())

    await asyncio.gather(*(worker() for _ in range(3)))
    intervals = [later - earlier for earlier, later in zip(started, started[1:])]
    # 给 Windows 计时器留 10ms 余量；错误实现（同时放行）的间隔接近 0。
    assert all(interval >= 0.02 for interval in intervals), intervals
