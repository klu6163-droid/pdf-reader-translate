"""pdf_annot_service 回归测试（审计 2.9）。

缺陷机制：打开会话时导入失败的原有批注不进 annotations.json；
保存时按 live_xrefs 清理 → 这些批注被 delete_annot 静默移出产物。

复现不依赖真实畸形 PDF：monkeypatch _import_annot 对其中一条抛异常，
模拟第三方批注结构异常导致的导入失败。
"""
from __future__ import annotations

import os

import fitz

from app.services import pdf_annot_service as svc


def _make_pdf_with_two_highlights(path) -> None:
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 100), "aaa bbb ccc", fontsize=12)
    page.insert_text((72, 140), "ddd eee fff", fontsize=12)
    page.add_highlight_annot(fitz.Rect(70, 90, 160, 105))
    page.add_highlight_annot(fitz.Rect(70, 130, 160, 145))
    doc.save(str(path))
    doc.close()


def _count_annots(pdf_path: str) -> int:
    doc = fitz.open(pdf_path)
    n = sum(len(list(p.annots() or [])) for p in doc)
    doc.close()
    return n


def test_failed_import_annotations_are_preserved(tmp_path, monkeypatch):
    """导入失败的原有批注必须在输出 PDF 中原样保留，不得被保存流程删除。"""
    src = tmp_path / "input.pdf"
    _make_pdf_with_two_highlights(src)

    work = str(tmp_path / "session")
    with open(src, "rb") as f:
        svc.init_session_dir(work, f.read())

    # 让第二条批注导入失败（模拟畸形批注结构）
    real_import = svc._import_annot
    calls = {"n": 0}

    def flaky_import(an, pno):
        calls["n"] += 1
        if calls["n"] == 2:
            raise ValueError("模拟畸形批注导致的导入失败")
        return real_import(an, pno)

    monkeypatch.setattr(svc, "_import_annot", flaky_import)

    opened = svc.open_session(work)
    assert len(opened["annotations"]) == 1, "应只成功导入一条"

    svc.save_annotated_pdf(work, opened["annotations"])

    out = os.path.join(work, svc.OUTPUT_PDF)
    assert _count_annots(out) == 2, "导入失败的批注应原样保留，不能被静默删除"


def test_normal_delete_still_works(tmp_path):
    """对照组：用户在列表中删掉的导入批注，保存时仍会正常从 PDF 移除。"""
    src = tmp_path / "input.pdf"
    _make_pdf_with_two_highlights(src)

    work = str(tmp_path / "session")
    with open(src, "rb") as f:
        svc.init_session_dir(work, f.read())

    opened = svc.open_session(work)
    assert len(opened["annotations"]) == 2

    # 前端权威：只保留第一条（等价于用户删了第二条）
    svc.save_annotated_pdf(work, opened["annotations"][:1])

    out = os.path.join(work, svc.OUTPUT_PDF)
    assert _count_annots(out) == 1
