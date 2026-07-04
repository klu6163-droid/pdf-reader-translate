"""PDF 文本块编辑服务（基于 PyMuPDF，真实修改内容流）。

设计要点：
- 解析：page.get_text("dict") 取 span 级文本块（id / 文本 / bbox / 字体 / 字号 / 颜色）。
- 编辑：add_redact_annot + apply_redactions 把原文字**从内容流中物理移除**（保留图片/矢量图），
  再用 insert_textbox 在目标位置写入**新的真实文本**。不是"盖白块"式 overlay。
- 字体保真分两档，仅由 _resolve_font 决定，其余逻辑共用：
    * text（文本块编辑）：拉丁文映射到 base-14 标准字体，观感基本一致。
    * compatible（兼容编辑）：CJK / 子集化 CID 字体无法渲染任意新字形，改用内置替代字体，
      并明确告知用户。
- 保存永远写到新文件，绝不覆盖原 PDF；所有异常都降级处理，不让流程崩溃。
"""
from __future__ import annotations

import logging
import os
from typing import Any, Optional

_logger = logging.getLogger("pdf_edit_service")


# ---------- 友好文案 ----------

MODE_LABELS = {
    "text": "该 PDF 支持文本块编辑",
    "compatible": "该 PDF 结构较复杂，已使用兼容编辑模式（替代字体，观感可能略有差异）",
}
SAVED_NOTE = "编辑后的 PDF 已另存为新文件，原文件未被修改"


def _mode_label(mode: str) -> str:
    return MODE_LABELS.get(mode, MODE_LABELS["compatible"])


# ---------- 字体处理（真实 vs 兼容的唯一分歧点）----------

# 中文/非拉丁替代字体候选（含 Latin/Cyrillic/Greek/CJK，覆盖面广）。
_CJK_FONT_CANDIDATES = (
    r"C:\Windows\Fonts\msyh.ttc",       # Microsoft YaHei
    r"C:\Windows\Fonts\simsun.ttc",     # SimSun
    r"C:\Windows\Fonts\simhei.ttf",     # SimHei
    r"C:\Windows\Fonts\STSONG.TTF",
    r"C:\Windows\Fonts\NotoSansSC-VF.ttf",
)

_CJK_FONT_CACHE: list[Optional[str]] = []

# base-14 标准字体代号（PyMuPDF 内置，无需 fontfile）。
_HELV = {(False, False): "helv", (True, False): "hebo", (False, True): "heit", (True, True): "hebi"}
_TIMES = {(False, False): "tiro", (True, False): "tibo", (False, True): "tiit", (True, True): "tibi"}
_COUR = {(False, False): "cour", (True, False): "cobo", (False, True): "coit", (True, True): "cobi"}

_CJK_FONTNAME = "EDITCJK"


def _cjk_font_path() -> Optional[str]:
    if not _CJK_FONT_CACHE:
        found = next((p for p in _CJK_FONT_CANDIDATES if os.path.exists(p)), None)
        _CJK_FONT_CACHE.append(found)
    return _CJK_FONT_CACHE[0]


def _strip_subset(font_name: str) -> str:
    """去掉子集前缀，如 'ABCDEF+Arial-Bold' -> 'Arial-Bold'。"""
    if "+" in font_name and font_name.split("+", 1)[0].isalpha():
        return font_name.split("+", 1)[1]
    return font_name


def _needs_substitute(text: str) -> bool:
    """含非 Latin-1 字符（CJK/西里尔/希腊等）时，base-14 无法渲染，需替代字体。"""
    return any(ord(ch) > 0xFF for ch in text)


def _resolve_font(font_name: str, text: str) -> tuple[str, Optional[str], bool]:
    """返回 (fontname, fontfile, is_true)。

    is_true=True 表示能用标准字体较忠实地渲染（text 模式）；
    is_true=False 表示只能用替代字体（compatible 模式）。
    """
    if _needs_substitute(text):
        fp = _cjk_font_path()
        if fp:
            return (_CJK_FONTNAME, fp, False)
        return ("helv", None, False)  # 实在没有中文字体，退回 helv（可能缺字形）

    name = _strip_subset(font_name).lower()
    bold = any(k in name for k in ("bold", "black", "heavy", "semibold"))
    italic = any(k in name for k in ("italic", "oblique"))
    if any(k in name for k in ("times", "serif", "roman", "georgia", "minion", "song", "ming")):
        table = _TIMES
    elif any(k in name for k in ("courier", "mono", "consol", "typewriter")):
        table = _COUR
    else:
        table = _HELV
    return (table[(bold, italic)], None, True)


# ---------- 颜色 ----------

def _int_to_hex(color: int) -> str:
    try:
        r = (color >> 16) & 0xFF
        g = (color >> 8) & 0xFF
        b = color & 0xFF
        return f"#{r:02x}{g:02x}{b:02x}"
    except Exception:  # noqa: BLE001
        return "#000000"


def _hex_to_rgb(color_hex: str) -> tuple[float, float, float]:
    try:
        s = color_hex.lstrip("#")
        if len(s) == 3:
            s = "".join(c * 2 for c in s)
        r = int(s[0:2], 16) / 255.0
        g = int(s[2:4], 16) / 255.0
        b = int(s[4:6], 16) / 255.0
        return (r, g, b)
    except Exception:  # noqa: BLE001
        return (0.0, 0.0, 0.0)


# ---------- span 提取（analyze 与 apply 共用同一套 id 规则）----------

def _page_spans(page, pno: int) -> list[dict[str, Any]]:
    """提取单页所有可编辑 span，id 稳定为 '页:块:行:span'。"""
    out: list[dict[str, Any]] = []
    data = page.get_text("dict")
    for bi, block in enumerate(data.get("blocks", [])):
        if block.get("type", 0) != 0:  # 跳过图片块
            continue
        for li, line in enumerate(block.get("lines", [])):
            for si, span in enumerate(line.get("spans", [])):
                text = span.get("text", "")
                if not text.strip():
                    continue
                bbox = span.get("bbox", (0, 0, 0, 0))
                font = span.get("font", "")
                flags = int(span.get("flags", 0))
                out.append({
                    "id": f"{pno}:{bi}:{li}:{si}",
                    "page": pno,
                    "text": text,
                    "bbox": [round(float(v), 2) for v in bbox],
                    "font": font,
                    "size": round(float(span.get("size", 0.0)), 2),
                    "color": _int_to_hex(int(span.get("color", 0))),
                    "bold": bool(flags & 16) or "bold" in font.lower(),
                    "italic": bool(flags & 2) or "italic" in font.lower(),
                })
    return out


def _require_fitz():
    try:
        import fitz  # noqa: F401
        return fitz
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(f"PyMuPDF 不可用，无法编辑 PDF：{e}") from e


# ---------- 对外：解析 ----------

def analyze_pdf(pdf_path: str) -> dict[str, Any]:
    """解析 PDF，返回每页文本块与预测编辑模式。"""
    fitz = _require_fitz()
    doc = fitz.open(pdf_path)
    if doc.needs_pass:
        doc.close()
        raise RuntimeError("该 PDF 已加密，暂不支持编辑")

    pages: list[dict[str, Any]] = []
    total_chars = 0
    sub_chars = 0  # 需替代字体（非 Latin-1）的字符数
    try:
        for pno in range(len(doc)):
            page = doc[pno]
            rect = page.rect
            blocks = _page_spans(page, pno)
            for b in blocks:
                for ch in b["text"]:
                    total_chars += 1
                    if ord(ch) > 0xFF:
                        sub_chars += 1
            pages.append({
                "page": pno,
                "width": round(float(rect.width), 2),
                "height": round(float(rect.height), 2),
                "blocks": blocks,
            })
    finally:
        doc.close()

    # 少量连字/花引号（如 ﬁ、'、—）不应把整篇拉丁文档判为兼容模式；
    # 仅当非 Latin-1 字符占比较高（CJK 类文档）时才预测为兼容模式。
    ratio = (sub_chars / total_chars) if total_chars else 0.0
    mode = "compatible" if ratio > 0.10 else "text"
    return {
        "mode": mode,
        "mode_label": _mode_label(mode),
        "page_count": len(pages),
        "pages": pages,
    }


# ---------- 对外：应用编辑并另存 ----------

def _insert_text(page, rect, text: str, fontname: str, fontfile: Optional[str],
                 size: float, color_hex: str) -> None:
    """在 rect 内写入 text，放不下时自动缩字号，最终兜底 insert_text 不抛错。"""
    fitz = _require_fitz()
    color = _hex_to_rgb(color_hex)
    # 允许向下扩展高度以容纳换行，宽度沿用原块宽度
    box = fitz.Rect(rect.x0, rect.y0, rect.x1, rect.y0 + max(rect.height, size * 1.4))
    fs = max(float(size), 1.0)
    for _ in range(8):
        try:
            rc = page.insert_textbox(
                box, text, fontname=fontname, fontfile=fontfile,
                fontsize=fs, color=color, align=0,
            )
        except Exception as e:  # noqa: BLE001
            _logger.info("insert_textbox 失败(%s)，尝试缩小: %s", fontname, e)
            rc = -1
        if rc >= 0:
            return
        fs *= 0.9
        if fs < 4:
            break
    # 兜底：基线写入，可能略溢出但不崩
    try:
        page.insert_text(
            (rect.x0, rect.y1 - size * 0.2), text,
            fontname=fontname, fontfile=fontfile, fontsize=max(fs, 4.0), color=color,
        )
    except Exception as e:  # noqa: BLE001
        _logger.info("insert_text 兜底也失败，跳过该块: %s", e)


def apply_edits(pdf_path: str, edits: list[dict[str, Any]], out_path: str) -> dict[str, Any]:
    """应用编辑，写入 out_path（新文件）。edits: [{id, text?, bbox?, size?, color?, deleted?}]。"""
    fitz = _require_fitz()
    if os.path.abspath(out_path) == os.path.abspath(pdf_path):
        raise ValueError("输出路径不能与原文件相同")

    doc = fitz.open(pdf_path)
    if doc.needs_pass:
        doc.close()
        raise RuntimeError("该 PDF 已加密，暂不支持编辑")

    used_compatible = False
    used_cover_fallback = False
    edited = 0
    try:
        # 原始 span 索引：{id: block}，用于拿权威的原始 bbox / 字体 / 字号 / 颜色
        index: dict[str, dict[str, Any]] = {}
        for pno in range(len(doc)):
            for b in _page_spans(doc[pno], pno):
                index[b["id"]] = b

        # 按页归并（编辑需先对整页 redaction，再统一写新字）
        by_page: dict[int, list[tuple[dict, dict]]] = {}
        for e in edits:
            info = index.get(e.get("id", ""))
            if not info:
                continue
            by_page.setdefault(info["page"], []).append((e, info))

        for pno, items in by_page.items():
            page = doc[pno]
            redaction_ok = True
            # 1) 先把所有被编辑块的原文字标记删除（fill=False 不涂白，避免破坏背景）
            for _e, info in items:
                try:
                    page.add_redact_annot(fitz.Rect(info["bbox"]), fill=False)
                except Exception as ex:  # noqa: BLE001
                    _logger.info("add_redact_annot 失败: %s", ex)
            try:
                try:
                    page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)
                except TypeError:
                    page.apply_redactions()  # 老版本无 images 参数
            except Exception as ex:  # noqa: BLE001
                redaction_ok = False
                _logger.info("apply_redactions 失败，改用遮盖兜底: %s", ex)

            # 2) 逐块写入新文本（删除的块只 redaction，不重写）
            for e, info in items:
                if e.get("deleted"):
                    edited += 1
                    continue
                text = e.get("text", info["text"])
                if not str(text):
                    edited += 1
                    continue
                bbox = e.get("bbox") or info["bbox"]
                size = float(e.get("size") or info["size"] or 12.0)
                color_hex = e.get("color") or info["color"]
                rect = fitz.Rect(bbox)

                # redaction 失败时的最后兜底：涂白遮盖原区域，保证新字清晰可读
                if not redaction_ok:
                    used_cover_fallback = True
                    try:
                        page.draw_rect(fitz.Rect(info["bbox"]), color=None,
                                       fill=(1, 1, 1), overlay=True)
                    except Exception:  # noqa: BLE001
                        pass

                fontname, fontfile, is_true = _resolve_font(info["font"], str(text))
                if not is_true:
                    used_compatible = True
                _insert_text(page, rect, str(text), fontname, fontfile, size, color_hex)
                edited += 1

        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        if used_compatible:
            # 嵌入过替代 CJK 字体时做子集化，避免输出体积膨胀（msyh 全量约 12MB+）
            try:
                doc.subset_fonts()
            except Exception as ex:  # noqa: BLE001
                _logger.info("subset_fonts 失败，继续保存: %s", ex)
        doc.save(out_path, garbage=3, deflate=True)
    finally:
        doc.close()

    mode = "compatible" if (used_compatible or used_cover_fallback) else "text"
    message = _mode_label(mode) + "。" + SAVED_NOTE
    if used_cover_fallback:
        message = "部分区域改用兼容遮盖模式。" + SAVED_NOTE
    return {"mode": mode, "mode_label": _mode_label(mode), "edited": edited, "message": message}
