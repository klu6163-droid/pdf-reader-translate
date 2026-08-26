"""Log formatting and keep-one-backup rotation tests."""
from __future__ import annotations

import logging
import re

from app.logging_utils import UtcIsoFormatter, backup_and_truncate_open_log, rotate_closed_log


def test_utc_formatter_uses_iso_milliseconds() -> None:
    formatter = UtcIsoFormatter(
        "%(asctime)s.%(msecs)03dZ %(levelname)s %(message)s",
        "%Y-%m-%dT%H:%M:%S",
    )
    record = logging.LogRecord("test", logging.INFO, __file__, 1, "hello", (), None)
    rendered = formatter.format(record)
    assert re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z INFO hello$", rendered)


def test_closed_log_is_preserved_as_dot_one_before_reset(tmp_path) -> None:
    path = tmp_path / "backend.log"
    path.write_text("old-log-content", encoding="utf-8")

    assert rotate_closed_log(str(path), max_bytes=4) is True
    assert not path.exists()
    assert (tmp_path / "backend.log.1").read_text(encoding="utf-8") == "old-log-content"


def test_open_log_is_backed_up_before_truncate(tmp_path) -> None:
    path = tmp_path / "backend.log"
    path.write_text("first-generation", encoding="utf-8")
    with path.open("a+", encoding="utf-8") as log_file:
        assert backup_and_truncate_open_log(log_file, str(path), max_bytes=4) is True
        log_file.write("new-generation")
        log_file.flush()

    assert (tmp_path / "backend.log.1").read_text(encoding="utf-8") == "first-generation"
    assert path.read_text(encoding="utf-8") == "new-generation"


def test_backup_failure_never_truncates_current_log(monkeypatch, tmp_path) -> None:
    path = tmp_path / "backend.log"
    path.write_text("must-survive", encoding="utf-8")

    def fail_copy(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr("app.logging_utils.shutil.copyfile", fail_copy)
    with path.open("a+", encoding="utf-8") as log_file:
        assert backup_and_truncate_open_log(log_file, str(path), max_bytes=4) is False

    assert path.read_text(encoding="utf-8") == "must-survive"
    assert not (tmp_path / "backend.log.1").exists()
