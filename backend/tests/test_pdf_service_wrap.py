"""降级纯文本 PDF 折行测试（审计 2.8：按绘制宽度折行）。"""
from __future__ import annotations

from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont

from app.services.pdf_service import _wrap_lines_by_width

# A4(595pt) 减去左右各 40pt 边距后的可用宽度
_DRAW_WIDTH = 595.27 - 80
_FONT_SIZE = 10


def _font() -> str:
    try:
        pdfmetrics.getFont("STSong-Light")
    except KeyError:
        pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    return "STSong-Light"


def test_cjk_line_fits_draw_width():
    """全中文行长不得超出绘制宽度（旧实现 90 字=900pt 会被裁掉）。"""
    font = _font()
    text = "测" * 200
    lines = _wrap_lines_by_width(text, font, _FONT_SIZE, _DRAW_WIDTH)
    assert len(lines) > 2, "200 个中文字应折成多行"
    for line in lines:
        assert pdfmetrics.stringWidth(line, font, _FONT_SIZE) <= _DRAW_WIDTH + 1e-6
    assert "".join(lines) == text, "折行不应丢字"


def test_latin_wraps_too():
    font = _font()
    text = "word " * 100
    lines = _wrap_lines_by_width(text.strip(), font, _FONT_SIZE, _DRAW_WIDTH)
    assert len(lines) > 1
    for line in lines:
        assert pdfmetrics.stringWidth(line, font, _FONT_SIZE) <= _DRAW_WIDTH + 1e-6


def test_preserves_existing_newlines():
    font = _font()
    lines = _wrap_lines_by_width("短行一\n短行二", font, _FONT_SIZE, _DRAW_WIDTH)
    assert lines == ["短行一", "短行二"]
