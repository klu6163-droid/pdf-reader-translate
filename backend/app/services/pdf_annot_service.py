"""PDF 批注服务（基于 PyMuPDF，写标准 PDF annotation）。

设计要点：
- 所有批注写成标准 PDF annotation（Highlight/Underline/StrikeOut/Square/Ink/Text），
  其他阅读器（Edge/Acrobat/福昕）打开也能看到、能改注释。
- 会话 = 磁盘目录（source.pdf + annotations.json），后端重启不丢正在进行的批注。
- 保存永远另存 annotated.pdf，绝不写回原文件。
- 打开时导入 PDF 里已有批注（source="pdf"，带 xref），支持
  「打开已批注 PDF → 继续批注/删除旧批注 → 再另存」的往返工作流。
- 单条批注写入失败只跳过该条并计数，不让整个保存失败。

坐标：前后端统一用 PDF 点、左上原点（fitz 默认页面坐标系），与 pdf.js viewport 一致。
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

_logger = logging.getLogger("pdf_annot_service")

ANNOT_FILE = "annotations.json"
SOURCE_PDF = "source.pdf"
OUTPUT_PDF = "annotated.pdf"

SAVED_NOTE = "批注已保存为新 PDF，原文件未被修改。"

# 我们支持的批注类型
TYPES = ("highlight", "underline", "strikeout", "note", "rectangle", "ink")

# fitz 批注类型名 → 我们的 type（导入已有批注用）
_FITZ_TYPE_MAP = {
    "Highlight": "highlight",
    "Underline": "underline",
    "StrikeOut": "strikeout",
    "Squiggly": "underline",   # 波浪线归入下划线
    "Square": "rectangle",
    "Ink": "ink",
    "Text": "note",
    "FreeText": "note",
}

_TYPE_LABELS = {
    "highlight": "高亮", "underline": "下划线", "strikeout": "删除线",
    "note": "批注", "rectangle": "矩形框", "ink": "画笔",
}


def _require_fitz():
    try:
        import fitz  # noqa: F401
        return fitz
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(f"PyMuPDF 不可用，无法批注 PDF：{e}") from e


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _pdf_date(iso: str) -> str:
    """ISO 时间 → PDF 日期串 D:YYYYMMDDHHmmSS。失败返回空。"""
    try:
        dt = datetime.fromisoformat(iso)
        return dt.strftime("D:%Y%m%d%H%M%S")
    except Exception:  # noqa: BLE001
        return ""


# ---------- 颜色 ----------

def _hex_to_rgb(color_hex: str) -> tuple[float, float, float]:
    try:
        s = (color_hex or "").lstrip("#")
        if len(s) == 3:
            s = "".join(c * 2 for c in s)
        return (int(s[0:2], 16) / 255.0, int(s[2:4], 16) / 255.0, int(s[4:6], 16) / 255.0)
    except Exception:  # noqa: BLE001
        return (1.0, 0.85, 0.2)  # 默认黄


def _rgb_to_hex(rgb) -> str:
    try:
        r, g, b = (max(0.0, min(1.0, float(v))) for v in rgb[:3])
        return f"#{int(r*255):02x}{int(g*255):02x}{int(b*255):02x}"
    except Exception:  # noqa: BLE001
        return "#ffd633"


# ---------- 会话存储（annotations.json 读改写）----------

def _annot_path(work: str) -> str:
    return os.path.join(work, ANNOT_FILE)


def _load(work: str) -> list[dict[str, Any]]:
    p = _annot_path(work)
    if not os.path.exists(p):
        return []
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception as e:  # noqa: BLE001
        _logger.info("annotations.json 读取失败，视为空: %s", e)
        return []


def _store(work: str, annots: list[dict[str, Any]]) -> None:
    with open(_annot_path(work), "w", encoding="utf-8") as f:
        json.dump(annots, f, ensure_ascii=False, indent=1)


def _normalize(annot: dict[str, Any]) -> dict[str, Any]:
    """补齐字段/清洗类型，保证结构一致。"""
    a = dict(annot)
    # 注意用真值判断而非 setdefault：路由 model_dump 会带 id=None 的键
    if not a.get("id"):
        a["id"] = uuid.uuid4().hex
    a["page"] = int(a.get("page") or 0)
    if a.get("type") not in TYPES:
        a["type"] = "highlight"
    a["text"] = str(a.get("text", "") or "")
    a["comment"] = str(a.get("comment", "") or "")
    a["color"] = str(a.get("color", "") or "#ffd633")
    a.setdefault("rect", None)
    a.setdefault("quads", None)
    a.setdefault("ink", None)
    if a.get("source") not in ("user", "pdf"):
        a["source"] = "user"
    a.setdefault("xref", None)
    now = _now_iso()
    if not a.get("created_at"):
        a["created_at"] = now
    a["updated_at"] = a.get("updated_at") or now
    return a


# ---------- 打开会话：导入 PDF 中已有批注 ----------

def open_session(work: str) -> dict[str, Any]:
    """解析 source.pdf 中已有批注 → 初始化 annotations.json，返回列表与页尺寸。"""
    fitz = _require_fitz()
    src = os.path.join(work, SOURCE_PDF)
    doc = fitz.open(src)
    if doc.needs_pass:
        doc.close()
        raise RuntimeError("该 PDF 已加密，暂不支持批注")

    imported: list[dict[str, Any]] = []
    pages: list[dict[str, Any]] = []
    try:
        for pno in range(len(doc)):
            page = doc[pno]
            pages.append({
                "page": pno,
                "width": round(float(page.rect.width), 2),
                "height": round(float(page.rect.height), 2),
            })
            try:
                annots = list(page.annots() or [])
            except Exception:  # noqa: BLE001
                annots = []
            for an in annots:
                try:
                    imported_annot = _import_annot(an, pno)
                    if imported_annot:
                        imported.append(imported_annot)
                except Exception as e:  # noqa: BLE001
                    _logger.info("导入已有批注失败(page=%s): %s", pno, e)
    finally:
        doc.close()

    _store(work, imported)
    return {"annotations": imported, "pages": pages, "page_count": len(pages)}


def _import_annot(an, pno: int) -> Optional[dict[str, Any]]:
    """把 fitz 已有批注转成我们的结构；不认识的类型返回 None。"""
    type_name = (an.type[1] if isinstance(an.type, (list, tuple)) and len(an.type) > 1
                 else str(an.type))
    our_type = _FITZ_TYPE_MAP.get(type_name)
    if not our_type:
        return None

    info = an.info or {}
    colors = an.colors or {}
    color = _rgb_to_hex(colors.get("stroke") or colors.get("fill") or (1, 0.85, 0.2))
    rect = [round(float(v), 2) for v in an.rect]

    quads = None
    if our_type in ("highlight", "underline", "strikeout"):
        v = an.vertices or []
        quads = []
        # vertices 每 4 点一组：ul, ur, ll, lr
        for i in range(0, len(v) - 3, 4):
            xs = [p[0] for p in v[i:i + 4]]
            ys = [p[1] for p in v[i:i + 4]]
            quads.append([round(min(xs), 2), round(min(ys), 2),
                          round(max(xs), 2), round(max(ys), 2)])
        if not quads:
            quads = [rect]

    ink = None
    if our_type == "ink":
        ink = [[[round(float(x), 2), round(float(y), 2)] for x, y in stroke]
               for stroke in (an.vertices or [])] or None

    return _normalize({
        "id": uuid.uuid4().hex,
        "page": pno,
        "type": our_type,
        "text": "",
        "comment": info.get("content", "") or "",
        "color": color,
        "rect": rect,
        "quads": quads,
        "ink": ink,
        "source": "pdf",
        "xref": int(an.xref),
        "created_at": _now_iso(),
    })


# ---------- CRUD ----------

def get_pdf_annotations(work: str) -> list[dict[str, Any]]:
    return _load(work)


def add_pdf_annotation(work: str, annot: dict[str, Any]) -> dict[str, Any]:
    a = _normalize(annot)
    a["source"] = "user"
    a["xref"] = None
    annots = _load(work)
    annots.append(a)
    _store(work, annots)
    return a


def update_pdf_annotation(work: str, annot_id: str, patch: dict[str, Any]) -> dict[str, Any]:
    annots = _load(work)
    for a in annots:
        if a.get("id") == annot_id:
            for k in ("text", "comment", "color", "rect", "quads", "ink", "page", "type"):
                if k in patch and patch[k] is not None:
                    a[k] = patch[k]
            a["updated_at"] = _now_iso()
            _store(work, annots)
            return a
    raise KeyError(f"批注不存在: {annot_id}")


def delete_pdf_annotation(work: str, annot_id: str) -> bool:
    annots = _load(work)
    kept = [a for a in annots if a.get("id") != annot_id]
    if len(kept) == len(annots):
        return False
    _store(work, kept)
    return True


# ---------- 保存：把批注真正写入 PDF ----------

def save_annotated_pdf(work: str, annotations: Optional[list[dict[str, Any]]] = None) -> dict[str, Any]:
    """把批注写入 source.pdf 的副本，存为 annotated.pdf。

    annotations 非 None 时以它为准覆盖会话（前端 state 是权威，保证幂等）。
    返回 {written, skipped, deleted_existing, message, out_path}。
    """
    fitz = _require_fitz()
    src = os.path.join(work, SOURCE_PDF)
    out = os.path.join(work, OUTPUT_PDF)
    if not os.path.exists(src):
        raise RuntimeError("批注会话已失效（后端可能已重启），请重新打开 PDF")

    if annotations is not None:
        annots = [_normalize(a) for a in annotations]
        _store(work, annots)
    else:
        annots = _load(work)

    doc = fitz.open(src)
    written = 0
    skipped = 0
    deleted_existing = 0
    try:
        # 1) 处理导入批注（source="pdf"）：被删的从副本移除；注释被改的更新 content
        live_xrefs = {a.get("xref") for a in annots if a.get("source") == "pdf"}
        by_xref = {a.get("xref"): a for a in annots if a.get("source") == "pdf"}
        for pno in range(len(doc)):
            page = doc[pno]
            try:
                existing = list(page.annots() or [])
            except Exception:  # noqa: BLE001
                existing = []
            for an in existing:
                type_name = (an.type[1] if isinstance(an.type, (list, tuple)) and len(an.type) > 1
                             else str(an.type))
                if type_name not in _FITZ_TYPE_MAP:
                    continue  # 不认识的类型原样保留
                if an.xref not in live_xrefs:
                    try:
                        page.delete_annot(an)
                        deleted_existing += 1
                    except Exception as e:  # noqa: BLE001
                        _logger.info("删除原有批注失败 xref=%s: %s", an.xref, e)
                else:
                    ours = by_xref.get(an.xref)
                    if ours and (an.info or {}).get("content", "") != ours.get("comment", ""):
                        try:
                            an.set_info(content=ours.get("comment", ""))
                            an.update()
                        except Exception as e:  # noqa: BLE001
                            _logger.info("更新原有批注注释失败 xref=%s: %s", an.xref, e)

        # 2) 写入用户新批注
        for a in annots:
            if a.get("source") == "pdf":
                continue
            try:
                if _write_annot(fitz, doc, a):
                    written += 1
                else:
                    skipped += 1
            except Exception as e:  # noqa: BLE001
                skipped += 1
                _logger.info("写入批注失败 id=%s type=%s: %s", a.get("id"), a.get("type"), e)

        doc.save(out, garbage=1, deflate=True)
    finally:
        doc.close()

    msg = SAVED_NOTE
    if skipped:
        msg = f"{skipped} 条批注写入失败已跳过。" + msg
    return {
        "ok": True,
        "written": written,
        "skipped": skipped,
        "deleted_existing": deleted_existing,
        "message": msg,
    }


def _write_annot(fitz, doc, a: dict[str, Any]) -> bool:
    """按类型把单条批注写入 doc。返回是否写入。"""
    pno = int(a.get("page", 0))
    if pno < 0 or pno >= len(doc):
        return False
    page = doc[pno]
    typ = a.get("type")
    color = _hex_to_rgb(a.get("color", ""))
    comment = a.get("comment", "") or ""

    annot = None
    if typ in ("highlight", "underline", "strikeout"):
        quads = a.get("quads") or ([a["rect"]] if a.get("rect") else [])
        qlist = []
        for q in quads:
            try:
                r = fitz.Rect(q)
                if not r.is_empty and r.is_valid:
                    qlist.append(r.quad)
            except Exception:  # noqa: BLE001
                continue
        if not qlist:
            return False
        fn = {
            "highlight": page.add_highlight_annot,
            "underline": page.add_underline_annot,
            "strikeout": page.add_strikeout_annot,
        }[typ]
        annot = fn(qlist)
        annot.set_colors(stroke=color)
    elif typ == "rectangle":
        if not a.get("rect"):
            return False
        r = fitz.Rect(a["rect"])
        if r.is_empty or not r.is_valid:
            return False
        annot = page.add_rect_annot(r)
        annot.set_colors(stroke=color)
        try:
            annot.set_border(width=1.5)
        except Exception:  # noqa: BLE001
            pass
    elif typ == "ink":
        strokes = a.get("ink") or []
        # add_ink_annot 要求 float 对序列（不收 Point 对象）
        pts = [[(float(p[0]), float(p[1])) for p in s
                if isinstance(p, (list, tuple)) and len(p) >= 2]
               for s in strokes]
        pts = [s for s in pts if len(s) >= 2]
        if not pts:
            return False
        annot = page.add_ink_annot(pts)
        annot.set_colors(stroke=color)
        try:
            annot.set_border(width=1.8)
        except Exception:  # noqa: BLE001
            pass
    elif typ == "note":
        if not a.get("rect"):
            return False
        r = fitz.Rect(a["rect"])
        annot = page.add_text_annot(fitz.Point(r.x0, r.y0), comment or a.get("text", "") or "批注",
                                    icon="Comment")
        try:
            annot.set_colors(stroke=color)
        except Exception:  # noqa: BLE001
            pass
    else:
        return False

    # 元信息：标题（作者）/ 注释内容 / 时间
    try:
        info = {"title": "PDF 阅读翻译"}
        if comment and typ != "note":
            info["content"] = comment
        cd = _pdf_date(a.get("created_at", ""))
        md = _pdf_date(a.get("updated_at", ""))
        if cd:
            info["creationDate"] = cd
        if md:
            info["modDate"] = md
        annot.set_info(**info)
    except Exception:  # noqa: BLE001
        pass
    try:
        if typ == "highlight":
            annot.set_opacity(0.45)
        annot.update()
    except Exception:  # noqa: BLE001
        pass
    return True


# ---------- 导出 ----------

def export_annotations(work: str, fmt: str = "json") -> tuple[str, str]:
    """导出批注列表。返回 (content, media_type)。"""
    annots = _load(work)
    if fmt == "markdown":
        lines: list[str] = ["# PDF 批注", ""]
        by_page: dict[int, list[dict]] = {}
        for a in annots:
            by_page.setdefault(int(a.get("page", 0)), []).append(a)
        for pno in sorted(by_page):
            lines.append(f"## 第 {pno + 1} 页")
            lines.append("")
            for a in by_page[pno]:
                label = _TYPE_LABELS.get(a.get("type", ""), a.get("type", ""))
                excerpt = (a.get("text") or "").strip().replace("\n", " ")
                comment = (a.get("comment") or "").strip()
                item = f"- **[{label}]**"
                if excerpt:
                    item += f" {excerpt}"
                if comment:
                    item += f" — {comment}"
                lines.append(item)
            lines.append("")
        return ("\n".join(lines), "text/markdown")
    return (json.dumps(annots, ensure_ascii=False, indent=1), "application/json")


# ---------- 会话初始化辅助（路由用）----------

def init_session_dir(work: str, pdf_bytes: bytes) -> None:
    """写入 source.pdf（新会话）。"""
    os.makedirs(work, exist_ok=True)
    with open(os.path.join(work, SOURCE_PDF), "wb") as f:
        f.write(pdf_bytes)


def output_pdf_path(work: str) -> str:
    return os.path.join(work, OUTPUT_PDF)


def has_source(work: str) -> bool:
    return os.path.exists(os.path.join(work, SOURCE_PDF))
