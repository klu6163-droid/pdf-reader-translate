"""文献总结 API 的最小主流程集成测试。"""
from __future__ import annotations

import io
import json

from httpx import ASGITransport, AsyncClient
from reportlab.pdfgen import canvas

from app.api import summary as summary_api
from app.main import app


def _one_page_pdf() -> bytes:
    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer)
    pdf.drawString(72, 720, "Summary integration source")
    pdf.save()
    return buffer.getvalue()


async def test_summary_stream_returns_sse_for_in_memory_pdf(monkeypatch):
    seen_text: list[str] = []

    class FakeLLMService:
        def __init__(self, config):
            assert config.api_key == "sk-test"

        async def summary_stream(self, full_text: str):
            seen_text.append(full_text)
            yield "fake summary"

    monkeypatch.setattr(summary_api, "LLMService", FakeLLMService)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/summary/stream",
            files={"file": ("paper.pdf", _one_page_pdf(), "application/pdf")},
            headers={"x-llm-api-key": "sk-test"},
        )

    assert response.status_code == 200, response.text
    events = [
        json.loads(line.removeprefix("data: "))
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert events == [{"delta": "fake summary"}, {"done": True}]
    assert seen_text and "Summary integration source" in seen_text[0]
