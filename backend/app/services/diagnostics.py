"""Translation lifecycle diagnostics with a deliberately metadata-only schema."""
from __future__ import annotations

import importlib.util
import logging
import platform
import threading
import time
import uuid
from collections import OrderedDict
from datetime import datetime, timezone
from typing import Literal

MAX_RECENT_TRANSLATIONS = 20

_logger = logging.getLogger("translation.lifecycle")
_lock = threading.Lock()
_recent: "OrderedDict[str, dict[str, object]]" = OrderedDict()


def utc_timestamp() -> str:
    """Return an ISO-8601 UTC timestamp with millisecond precision."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class TranslationTrace:
    """Track one translation without accepting document or translated text."""

    def __init__(self, task_id: str, mode: str) -> None:
        self.task_id = task_id
        self.mode = mode
        self.started_at = utc_timestamp()
        self._started_perf = time.perf_counter()
        self._finished = False
        with _lock:
            _recent[task_id] = {
                "task_id": task_id,
                "mode": mode,
                "duration_ms": None,
                "succeeded": None,
            }
            _recent.move_to_end(task_id)
            while len(_recent) > MAX_RECENT_TRANSLATIONS:
                _recent.popitem(last=False)
        _logger.info(
            "translation started task_id=%s mode=%s started_at=%s",
            task_id,
            mode,
            self.started_at,
        )

    def finish(self, succeeded: bool, mode: str | None = None) -> None:
        """Finish once; only status metadata is retained in the recent list."""
        if self._finished:
            return
        self._finished = True
        final_mode = mode or self.mode
        completed_at = utc_timestamp()
        duration_ms = max(0, round((time.perf_counter() - self._started_perf) * 1000))
        with _lock:
            _recent[self.task_id] = {
                "task_id": self.task_id,
                "mode": final_mode,
                "duration_ms": duration_ms,
                "succeeded": succeeded,
            }
            _recent.move_to_end(self.task_id)
            while len(_recent) > MAX_RECENT_TRANSLATIONS:
                _recent.popitem(last=False)
        _logger.info(
            "translation completed task_id=%s mode=%s started_at=%s completed_at=%s "
            "duration_ms=%s succeeded=%s",
            self.task_id,
            final_mode,
            self.started_at,
            completed_at,
            duration_ms,
            str(succeeded).lower(),
        )


def start_translation(mode: Literal["text", "pdf", "overlay"], task_id: str | None = None) -> TranslationTrace:
    """Start a trace. Synchronous text translation receives an internal task id."""
    return TranslationTrace(task_id or uuid.uuid4().hex, mode)


def recent_translation_statuses() -> list[dict[str, object]]:
    """Return newest-first copies containing exactly four non-content fields."""
    with _lock:
        return [dict(item) for item in reversed(_recent.values())]


def reset_recent_translation_statuses() -> None:
    """Test helper: clear process-local diagnostic state."""
    with _lock:
        _recent.clear()


def backend_status_snapshot(version: str) -> dict[str, object]:
    """Build the safe backend portion of diagnostics.json."""
    return {
        "backend_version": version,
        "os": platform.system(),
        "arch": platform.machine(),
        "pdf2zh_available": importlib.util.find_spec("pdf2zh") is not None,
        "recent_translations": recent_translation_statuses(),
    }
