"""File/path helpers for uploads and temporary outputs."""
from __future__ import annotations

import asyncio
import os
import re
import shutil
import time
from collections.abc import Callable
from pathlib import Path
from typing import Iterable


SAFE_NAME_RE = re.compile(r"[^\w.\-() ]+", re.UNICODE)
DEFAULT_TTL_SECONDS = 6 * 60 * 60
STARTUP_MAX_AGE_SECONDS = 24 * 60 * 60


def safe_pdf_filename(filename: str | None, default: str = "upload.pdf") -> str:
    """Return a path-segment-safe PDF filename."""
    raw = os.path.basename(filename or "") or default
    cleaned = SAFE_NAME_RE.sub("_", raw).strip(" ._")
    if not cleaned:
        cleaned = default
    if not cleaned.lower().endswith(".pdf"):
        cleaned = f"{cleaned}.pdf"
    return cleaned[:180]


def scoped_path(root: str, *parts: str) -> str:
    """Join and verify that the result stays under root."""
    base = Path(root).resolve()
    target = base.joinpath(*parts).resolve()
    if target != base and base not in target.parents:
        raise ValueError("路径越界")
    return str(target)


def cleanup_old_entries(root: str, max_age_seconds: int = STARTUP_MAX_AGE_SECONDS) -> None:
    """Remove stale files/directories owned by this app."""
    if not os.path.isdir(root):
        return
    cutoff = time.time() - max_age_seconds
    for entry in os.scandir(root):
        try:
            if entry.stat().st_mtime < cutoff:
                remove_path(entry.path)
        except OSError:
            continue


async def cleanup_later(
    paths: Iterable[str],
    delay_seconds: int = DEFAULT_TTL_SECONDS,
    on_done: Callable[[], None] | None = None,
) -> None:
    """Delete paths after a delay; intended for background task cleanup."""
    await asyncio.sleep(delay_seconds)
    for path in paths:
        remove_path(path)
    if on_done:
        on_done()


def remove_path(path: str) -> None:
    try:
        if os.path.isdir(path):
            shutil.rmtree(path, ignore_errors=True)
        else:
            os.remove(path)
    except FileNotFoundError:
        return
    except OSError:
        return
