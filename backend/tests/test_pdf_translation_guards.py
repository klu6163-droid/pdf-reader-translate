"""全文/覆盖翻译的文字层预检与译文后检回归测试。"""

from __future__ import annotations

import io
import json
import os
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient
from pypdf import PdfWriter
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

from app.api import overlay_trans, pdf_trans
from app.main import app
from app.services import pdf_service
from app.services.pdf_service import PdfTextLayerStats, TranslateProgress
from app.services.task_manager import task_manager


def _blank_pdf() -> bytes:
    buffer = io.BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=595, height=842)
    writer.write(buffer)
    return buffer.getvalue()


def _english_pdf() -> bytes:
    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=A4)
    pdf.drawString(72, 720, "English source text for translation guard")
    pdf.showPage()
    pdf.save()
    return buffer.getvalue()


async def _no_cleanup(paths, delay=600, on_done=None):
    return None


async def _progress_events(client: AsyncClient, url: str) -> list[dict]:
    events: list[dict] = []
    async with client.stream("GET", url) as response:
        assert response.status_code == 200
        async for line in response.aiter_lines():
            if line.startswith("data: "):
                events.append(json.loads(line.removeprefix("data: ")))
    return events


def test_source_guard_rejects_pdf_without_text_layer(tmp_path):
    image_only = tmp_path / "image-only.pdf"
    image_only.write_bytes(_blank_pdf())
    searchable = tmp_path / "searchable.pdf"
    searchable.write_bytes(_english_pdf())

    issue = pdf_service.source_pdf_text_issue(str(image_only))

    assert issue is not None
    assert "OCR" in issue
    assert "文字层" in issue
    assert pdf_service.source_pdf_text_issue(str(searchable)) is None


def test_translated_guard_requires_chinese_for_chinese_target(monkeypatch):
    english_only = PdfTextLayerStats(
        page_count=2,
        text_page_count=2,
        meaningful_chars=300,
        cjk_chars=0,
        latin_letters=280,
    )
    with_chinese = PdfTextLayerStats(
        page_count=2,
        text_page_count=2,
        meaningful_chars=300,
        cjk_chars=120,
        latin_letters=160,
    )

    monkeypatch.setattr(
        pdf_service, "inspect_pdf_text_layer", lambda _path: english_only
    )
    issue = pdf_service.translated_pdf_issue("result.pdf", "zh-CN")
    assert issue is not None
    assert "没有检测到中文" in issue

    monkeypatch.setattr(
        pdf_service, "inspect_pdf_text_layer", lambda _path: with_chinese
    )
    assert pdf_service.translated_pdf_issue("result.pdf", "中文") is None

    monkeypatch.setattr(
        pdf_service,
        "inspect_pdf_text_layer",
        lambda _path: (_ for _ in ()).throw(AssertionError("英文目标不应检查中文")),
    )
    assert pdf_service.translated_pdf_issue("result.pdf", "en") is None


@pytest.mark.parametrize(
    "kind,start_path,progress_prefix",
    [
        ("full", "/api/translate/pdf/start", "/api/translate/pdf/progress"),
        ("overlay", "/api/overlay/pdf/start", "/api/overlay/pdf/progress"),
    ],
)
async def test_routes_stop_image_only_pdf_before_translation(
    monkeypatch, tmp_path, kind: str, start_path: str, progress_prefix: str
):
    called = False
    work_dir = tmp_path / kind
    work_dir.mkdir()

    async def fake_translate(*args, **kwargs):
        nonlocal called
        called = True
        yield TranslateProgress(1.0, "不应执行", done=True)

    if kind == "full":
        monkeypatch.setattr(pdf_trans, "WORK_DIR", str(work_dir))
        monkeypatch.setattr(pdf_trans, "cleanup_later", _no_cleanup)
        monkeypatch.setattr(pdf_service, "translate_pdf", fake_translate)
    else:
        monkeypatch.setattr(overlay_trans, "WORK_DIR", str(work_dir))
        monkeypatch.setattr(overlay_trans, "cleanup_later", _no_cleanup)
        monkeypatch.setattr(pdf_service, "generate_overlay_translation", fake_translate)

    task_id: str | None = None
    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                start_path,
                files={"file": ("scan.pdf", _blank_pdf(), "application/pdf")},
                data={"target_lang": "zh"},
                headers={"x-llm-api-key": "sk-test"},
            )
            assert response.status_code == 200
            task_id = response.json()["task_id"]
            events = await _progress_events(client, f"{progress_prefix}/{task_id}")

        assert called is False
        assert events[-1]["done"] is True
        assert events[-1]["error"] is True
        assert "OCR" in events[-1]["message"]
        assert task_manager.get(task_id).result is None
    finally:
        if task_id is not None:
            task_manager.cleanup(task_id)


@pytest.mark.parametrize(
    "kind,start_path,progress_prefix",
    [
        ("full", "/api/translate/pdf/start", "/api/translate/pdf/progress"),
        ("overlay", "/api/overlay/pdf/start", "/api/overlay/pdf/progress"),
    ],
)
async def test_routes_reject_english_only_translation_result(
    monkeypatch, tmp_path, kind: str, start_path: str, progress_prefix: str
):
    work_dir = tmp_path / kind
    work_dir.mkdir()

    async def fake_translate(upload_path, out_dir, config, *args, **kwargs):
        os.makedirs(out_dir, exist_ok=True)
        result_path = Path(out_dir) / "english-result.pdf"
        result_path.write_bytes(_english_pdf())
        yield TranslateProgress(
            1.0,
            "处理完成",
            mode="pdf2zh" if kind == "full" else "fallback",
            done=True,
            result_path=str(result_path),
        )

    if kind == "full":
        monkeypatch.setattr(pdf_trans, "WORK_DIR", str(work_dir))
        monkeypatch.setattr(pdf_trans, "cleanup_later", _no_cleanup)
        monkeypatch.setattr(pdf_service, "translate_pdf", fake_translate)
    else:
        monkeypatch.setattr(overlay_trans, "WORK_DIR", str(work_dir))
        monkeypatch.setattr(overlay_trans, "cleanup_later", _no_cleanup)
        monkeypatch.setattr(pdf_service, "generate_overlay_translation", fake_translate)

    task_id: str | None = None
    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                start_path,
                files={"file": ("paper.pdf", _english_pdf(), "application/pdf")},
                data={"target_lang": "zh"},
                headers={"x-llm-api-key": "sk-test"},
            )
            assert response.status_code == 200
            task_id = response.json()["task_id"]
            events = await _progress_events(client, f"{progress_prefix}/{task_id}")

        assert events[-1]["done"] is True
        assert events[-1]["error"] is True
        assert "没有检测到中文" in events[-1]["message"]
        assert task_manager.get(task_id).result is None
    finally:
        if task_id is not None:
            task_manager.cleanup(task_id)
