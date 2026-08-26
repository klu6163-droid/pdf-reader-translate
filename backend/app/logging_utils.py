"""Logging configuration and cross-platform keep-one-backup rotation helpers."""
from __future__ import annotations

import logging
import os
import shutil
import time
from typing import TextIO

MAX_LOG_BYTES = 5 * 1024 * 1024


class UtcIsoFormatter(logging.Formatter):
    """Format application log records as ISO-8601 UTC with milliseconds."""

    converter = time.gmtime


def configure_logging() -> None:
    """Use one timestamp format for application and Uvicorn loggers."""
    handler = logging.StreamHandler()
    handler.setFormatter(
        UtcIsoFormatter(
            fmt="%(asctime)s.%(msecs)03dZ %(levelname)s %(name)s %(message)s",
            datefmt="%Y-%m-%dT%H:%M:%S",
        )
    )
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(logging.INFO)
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        child = logging.getLogger(name)
        child.handlers.clear()
        child.propagate = True


def rotate_closed_log(path: str, max_bytes: int = MAX_LOG_BYTES) -> bool:
    """Move an oversized closed log to .1; leave it untouched if backup fails."""
    try:
        if not os.path.exists(path) or os.path.getsize(path) <= max_bytes:
            return False
        os.replace(path, f"{path}.1")
        return True
    except OSError:
        return False


def backup_and_truncate_open_log(
    log_file: TextIO,
    path: str,
    max_bytes: int = MAX_LOG_BYTES,
) -> bool:
    """Back up an oversized open log atomically before truncating its handle."""
    backup = f"{path}.1"
    temporary = f"{backup}.tmp"
    try:
        if os.path.getsize(path) <= max_bytes:
            return False
        log_file.flush()
        shutil.copyfile(path, temporary)
        os.replace(temporary, backup)
        os.ftruncate(log_file.fileno(), 0)
        log_file.seek(0, os.SEEK_END)
        return True
    except OSError:
        try:
            if os.path.exists(temporary):
                os.remove(temporary)
        except OSError:
            pass
        return False
