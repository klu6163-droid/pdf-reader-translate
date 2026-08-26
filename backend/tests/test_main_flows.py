"""核心 HTTP 主流程集成测试：文本翻译与两条 PDF 长任务链路。"""
from __future__ import annotations

import asyncio
import io
import json
import os
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient
from reportlab.pdfgen import canvas

from app.api import overlay_trans, pdf_annot, pdf_edit, pdf_trans
from app.api import translate as translate_api
from app.main import app
from app.services import pdf_service
from app.services.llm import LLMError
from app.services.pdf_service import TranslateProgress
from app.services.task_manager import task_manager


def _one_page_pdf(text: str = "Main flow integration source") -> bytes:
    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer)
    pdf.drawString(72, 720, text)
    pdf.save()
    return buffer.getvalue()


def _text_request(text: str = " hello ") -> dict:
    return {
        "text": text,
        "source_lang": "auto",
        "target_lang": "中文",
        "config": {
            "api_key": "sk-test",
            "base_url": "https://llm.invalid/v1",
            "model": "fake-model",
        },
    }


async def test_text_translate_success(monkeypatch):
    seen: dict[str, str] = {}

    class FakeLLMService:
        def __init__(self, config):
            seen["api_key"] = config.api_key
            seen["model"] = config.model

        async def translate(self, text: str, target_lang: str, source_lang: str):
            seen["text"] = text
            seen["target_lang"] = target_lang
            seen["source_lang"] = source_lang
            return "你好"

    monkeypatch.setattr(translate_api, "LLMService", FakeLLMService)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post("/api/translate/text", json=_text_request())

    assert response.status_code == 200, response.text
    assert response.json() == {
        "original": "hello",
        "translated": "你好",
        "model": "fake-model",
    }
    assert seen == {
        "api_key": "sk-test",
        "model": "fake-model",
        "text": "hello",
        "target_lang": "中文",
        "source_lang": "auto",
    }


async def test_text_translate_upstream_error_returns_502(monkeypatch):
    class FailingLLMService:
        def __init__(self, config):
            assert config.api_key == "sk-test"

        async def translate(self, text: str, target_lang: str, source_lang: str):
            raise LLMError("上游 LLM 暂不可用")

    monkeypatch.setattr(translate_api, "LLMService", FailingLLMService)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post("/api/translate/text", json=_text_request())

    assert response.status_code == 502
    assert response.json() == {"detail": "上游 LLM 暂不可用"}


async def test_terms_explanation_success_uses_backend_llm(monkeypatch):
    seen: dict[str, str] = {}

    class FakeLLMService:
        def __init__(self, config):
            seen["api_key"] = config.api_key
            seen["base_url"] = config.base_url
            seen["model"] = config.model

        async def explain_terms(self, text: str):
            seen["text"] = text
            return "- polymer：聚合物"

    monkeypatch.setattr(translate_api, "LLMService", FakeLLMService)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/translate/terms",
            json={"text": " polymer ", "config": _text_request()["config"]},
        )

    assert response.status_code == 200, response.text
    assert response.json() == {"terms": "- polymer：聚合物", "model": "fake-model"}
    assert seen == {
        "api_key": "sk-test",
        "base_url": "https://llm.invalid/v1",
        "model": "fake-model",
        "text": "polymer",
    }


async def test_terms_explanation_upstream_error_is_logged_without_source(
    monkeypatch, caplog
):
    source = "CONFIDENTIAL_TERM_SOURCE"

    class FailingLLMService:
        def __init__(self, config):
            assert config.api_key == "sk-test"

        async def explain_terms(self, text: str):
            assert text == source
            raise LLMError("上游术语服务失败")

    monkeypatch.setattr(translate_api, "LLMService", FailingLLMService)
    caplog.set_level("WARNING", logger="app.translate")
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/translate/terms",
            json={"text": source, "config": _text_request()["config"]},
        )

    assert response.status_code == 502
    assert response.json() == {"detail": "上游术语服务失败"}
    assert "terms explanation failed model=fake-model" in caplog.text
    assert source not in caplog.text
    assert "sk-test" not in caplog.text


async def _no_cleanup(*args, **kwargs) -> None:
    """测试自行用 tmp_path 回收产物，避免创建 6 小时后台清理任务。"""


@pytest.mark.parametrize(
    "kind,start_path,progress_prefix,result_prefix",
    [
        (
            "full",
            "/api/translate/pdf/start",
            "/api/translate/pdf/progress",
            "/api/translate/pdf/result",
        ),
        (
            "overlay",
            "/api/overlay/pdf/start",
            "/api/overlay/pdf/progress",
            "/api/overlay/pdf/result",
        ),
    ],
    ids=["full-translate", "overlay-translate"],
)
async def test_pdf_translation_start_progress_result(
    monkeypatch,
    tmp_path,
    kind: str,
    start_path: str,
    progress_prefix: str,
    result_prefix: str,
):
    source_pdf = _one_page_pdf()
    seen: dict[str, object] = {}
    task_id: str | None = None
    work_dir = tmp_path / kind
    work_dir.mkdir(parents=True, exist_ok=True)

    async def fake_progress(upload_path: str, out_dir: str, config, mode: str):
        seen["upload_is_pdf"] = Path(upload_path).read_bytes().startswith(b"%PDF")
        seen["api_key"] = config.api_key
        seen["max_concurrency"] = config.max_concurrency
        seen["request_interval_ms"] = config.request_interval_ms
        seen["max_retries"] = config.max_retries
        seen["retry_base_seconds"] = config.retry_base_seconds
        seen["mode"] = mode
        await asyncio.sleep(0.05)
        yield TranslateProgress(0.25, "处理中", mode=mode)
        os.makedirs(out_dir, exist_ok=True)
        result_path = os.path.join(out_dir, f"{kind}-result.pdf")
        Path(result_path).write_bytes(Path(upload_path).read_bytes())
        yield TranslateProgress(
            1.0,
            "处理完成",
            mode=mode,
            done=True,
            result_path=result_path,
        )

    if kind == "full":
        monkeypatch.setattr(pdf_trans, "WORK_DIR", str(work_dir))
        monkeypatch.setattr(pdf_trans, "cleanup_later", _no_cleanup)

        async def fake_translate(upload_path, out_dir, config, target_lang):
            seen["target_lang"] = target_lang
            async for event in fake_progress(upload_path, out_dir, config, "pdf2zh"):
                yield event

        monkeypatch.setattr(pdf_service, "translate_pdf", fake_translate)
    else:
        monkeypatch.setattr(overlay_trans, "WORK_DIR", str(work_dir))
        monkeypatch.setattr(overlay_trans, "cleanup_later", _no_cleanup)

        async def fake_overlay(upload_path, out_dir, config, *, fallback=False):
            seen["fallback"] = fallback
            async for event in fake_progress(upload_path, out_dir, config, "fallback"):
                yield event

        monkeypatch.setattr(pdf_service, "generate_overlay_translation", fake_overlay)

    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(
            transport=transport,
            base_url="http://test",
            timeout=5,
        ) as client:
            started = await client.post(
                start_path,
                files={"file": ("paper.pdf", source_pdf, "application/pdf")},
                data={"target_lang": "zh"},
                headers={
                    "x-llm-api-key": "sk-test",
                    "x-llm-base-url": "https://llm.invalid/v1",
                    "x-llm-model": "fake-model",
                    "x-llm-max-concurrency": "2",
                    "x-llm-request-interval-ms": "750",
                    "x-llm-max-retries": "3",
                    "x-llm-retry-base-seconds": "1.5",
                },
            )
            assert started.status_code == 200, started.text
            task_id = started.json()["task_id"]

            events: list[dict] = []
            async with client.stream("GET", f"{progress_prefix}/{task_id}") as progress:
                assert progress.status_code == 200
                async for line in progress.aiter_lines():
                    if line.startswith("data: "):
                        events.append(json.loads(line.removeprefix("data: ")))

            assert [event["message"] for event in events] == ["处理中", "处理完成"]
            assert events[-1]["done"] is True
            assert events[-1]["error"] is False

            result = await client.get(f"{result_prefix}/{task_id}")
            assert result.status_code == 200, result.text
            assert result.headers["content-type"].startswith("application/pdf")
            assert result.content == source_pdf
    finally:
        if task_id is not None:
            task_manager.cleanup(task_id)

    assert seen["upload_is_pdf"] is True
    assert seen["api_key"] == "sk-test"
    assert seen["max_concurrency"] == 2
    assert seen["request_interval_ms"] == 750
    assert seen["max_retries"] == 3
    assert seen["retry_base_seconds"] == 1.5
    if kind == "full":
        assert seen["target_lang"] == "zh"
    else:
        assert seen["fallback"] is False


async def test_edit_analyze_rejects_non_pdf_upload(monkeypatch, tmp_path):
    monkeypatch.setattr(pdf_edit, "EDIT_WORK_DIR", str(tmp_path / "edit"))
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/edit/pdf/analyze",
            files={"file": ("notes.txt", b"not a pdf", "text/plain")},
        )

    assert 400 <= response.status_code < 500
    detail = response.json().get("detail")
    assert isinstance(detail, str) and detail.strip()
    assert detail != "服务器内部错误"


async def test_annot_open_rejects_damaged_pdf(monkeypatch, tmp_path):
    monkeypatch.setattr(pdf_annot, "ANNOT_WORK_DIR", str(tmp_path / "annot"))
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/annot/pdf/open",
            files={
                "file": (
                    "broken.pdf",
                    b"%PDF-1.7 definitely broken",
                    "application/pdf",
                )
            },
        )

    assert 400 <= response.status_code < 500
    detail = response.json().get("detail")
    assert isinstance(detail, str) and detail.strip()
    assert detail != "服务器内部错误"
