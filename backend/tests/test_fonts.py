"""fonts 模块跨平台字体解析测试（不依赖真实字体存在）。"""
from __future__ import annotations

import os
from unittest.mock import patch

from app.services import fonts


def test_iter_candidates_nonempty_on_any_platform():
    candidates = list(fonts.iter_cjk_font_candidates())
    assert candidates, "任何平台都应有候选字体清单"


def test_resolve_returns_none_when_no_candidate_exists():
    fonts.clear_cache()
    with patch("app.services.fonts._platform_candidates", return_value=("/definitely/not/exist.ttf",)):
        with patch("app.services.fonts.shutil.which", return_value=None):
            assert fonts.resolve_cjk_font_path() is None
    fonts.clear_cache()


def test_resolve_returns_first_existing(tmp_path):
    fonts.clear_cache()
    fake = tmp_path / "fake.ttf"
    fake.write_bytes(b"\x00")
    with patch(
        "app.services.fonts._platform_candidates",
        return_value=("/missing.ttf", str(fake)),
    ):
        assert fonts.resolve_cjk_font_path() == str(fake)
    fonts.clear_cache()
