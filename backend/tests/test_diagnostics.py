"""Diagnostic metadata and privacy regression tests."""
from __future__ import annotations

import json
import logging

from httpx import ASGITransport, AsyncClient

from app.main import app
from app.services.diagnostics import (
    recent_translation_statuses,
    reset_recent_translation_statuses,
    start_translation,
)


def setup_function() -> None:
    reset_recent_translation_statuses()


def test_recent_translation_schema_contains_no_document_content() -> None:
    trace = start_translation("text", "task-safe")
    trace.finish(True)

    statuses = recent_translation_statuses()
    assert statuses == [
        {
            "task_id": "task-safe",
            "mode": "text",
            "duration_ms": statuses[0]["duration_ms"],
            "succeeded": True,
        }
    ]
    assert set(statuses[0]) == {"task_id", "mode", "duration_ms", "succeeded"}
    assert isinstance(statuses[0]["duration_ms"], int)


def test_recent_translation_list_is_bounded_to_twenty() -> None:
    for index in range(25):
        trace = start_translation("text", f"task-{index}")
        trace.finish(index % 2 == 0)

    statuses = recent_translation_statuses()
    assert len(statuses) == 20
    assert statuses[0]["task_id"] == "task-24"
    assert statuses[-1]["task_id"] == "task-5"


async def test_diagnostic_status_is_metadata_only() -> None:
    secret_text = "UNPUBLISHED_PAPER_CONTENT_DO_NOT_EXPORT"
    translated_text = "INTERNAL_TRANSLATION_DO_NOT_EXPORT"
    api_key = "sk-diagnostic-secret"
    trace = start_translation("pdf", "task-private")
    trace.finish(False, "fallback")

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/diagnostics/status")

    assert response.status_code == 200
    payload = response.json()
    encoded = json.dumps(payload, ensure_ascii=False)
    assert secret_text not in encoded
    assert translated_text not in encoded
    assert api_key not in encoded
    assert payload["recent_translations"] == [
        {
            "task_id": "task-private",
            "mode": "fallback",
            "duration_ms": payload["recent_translations"][0]["duration_ms"],
            "succeeded": False,
        }
    ]


def test_lifecycle_log_has_task_mode_times_and_duration(caplog) -> None:
    caplog.set_level(logging.INFO, logger="translation.lifecycle")
    trace = start_translation("overlay", "task-log")
    trace.finish(True, "fallback")

    text = caplog.text
    assert "translation started task_id=task-log mode=overlay started_at=" in text
    assert "translation completed task_id=task-log mode=fallback started_at=" in text
    assert "completed_at=" in text
    assert "duration_ms=" in text
    assert "succeeded=true" in text
