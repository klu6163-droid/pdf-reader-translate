"""llm 服务测试（审计 1.3 / 2.11：null content、网络异常包装）。"""
from __future__ import annotations

import httpx
import pytest

from app.models.schemas import LLMConfig
from app.services.llm import LLMError, LLMService


def _svc() -> LLMService:
    return LLMService(LLMConfig(api_key="k", base_url="http://127.0.0.1:9/v1", model="m"))


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
