"""pdf_edit_service 回归测试（审计项 1.1）。

致命缺陷复现路径：前端只移动/缩放/改色文本块（未改文字）时，
EditOp.model_dump() 恒带 text=None 键；旧代码
`text = e.get("text", info["text"])` 拿到 None，redaction 移除原文后
把字面字符串 "None" 写进 PDF。
"""
from __future__ import annotations

import fitz

from app.services import pdf_edit_service


def _make_source_pdf(path) -> str:
    """生成一个含单段拉丁文本的简单 PDF。"""
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 100), "Hello World", fontsize=12, fontname="helv")
    doc.save(str(path))
    doc.close()
    return str(path)


def test_move_only_edit_keeps_original_text_no_literal_none(tmp_path):
    """只移动文本块（text=None）的编辑：输出保留原文，绝不出现字面 'None'。"""
    src = _make_source_pdf(tmp_path / "src.pdf")
    out = str(tmp_path / "out.pdf")

    analyzed = pdf_edit_service.analyze_pdf(src)
    block = analyzed["pages"][0]["blocks"][0]
    assert block["text"] == "Hello World"

    x0, y0, x1, y1 = block["bbox"]
    # 模拟 EditOp.model_dump() 的真实形态：所有键都在，未改动的字段为 None
    edit = {
        "id": block["id"],
        "text": None,
        "bbox": [x0, y0 + 50, x1, y1 + 50],
        "size": None,
        "color": None,
        "deleted": False,
    }
    result = pdf_edit_service.apply_edits(src, [edit], out)
    assert result["edited"] == 1

    doc = fitz.open(out)
    text = doc[0].get_text()
    doc.close()
    assert "None" not in text, "只移动文本块后不应把字面 'None' 写进 PDF"
    assert "Hello World" in text


def test_explicit_text_edit_still_applies(tmp_path):
    """显式改文字的编辑仍正常生效（防止回归修复矫枉过正）。"""
    src = _make_source_pdf(tmp_path / "src.pdf")
    out = str(tmp_path / "out.pdf")

    analyzed = pdf_edit_service.analyze_pdf(src)
    block = analyzed["pages"][0]["blocks"][0]
    edit = {
        "id": block["id"],
        "text": "New Text",
        "bbox": None,
        "size": None,
        "color": None,
        "deleted": False,
    }
    result = pdf_edit_service.apply_edits(src, [edit], out)
    assert result["edited"] == 1

    doc = fitz.open(out)
    text = doc[0].get_text()
    doc.close()
    assert "New Text" in text
    assert "Hello World" not in text
