"""PDF 编辑导出：用 PyMuPDF (fitz) 把 EditState 应用到 PDF。

EditState JSON 结构对应前端 src/types/editTypes.ts。
坐标：overlay 用页面相对值 (0~1, y 向下，相对未旋转页)；
fitz 左上原点、y 向下，直接 rel × 页面点尺寸即可，无需翻转。
旋转：先在未旋转页坐标系画 overlays，再 page.set_rotation，fitz 会把内容+overlays 一起旋转。
"""
from __future__ import annotations

import base64
import math

import fitz  # PyMuPDF


def _hex_to_rgb(hex_color: str) -> tuple[float, float, float]:
    h = (hex_color or "#000000").lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    try:
        n = int(h, 16)
        return ((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255
    except ValueError:
        return 0.0, 0.0, 0.0


def _data_url_to_bytes(data_url: str) -> bytes:
    """data:image/png;base64,xxxx → bytes"""
    b64 = data_url.split(",", 1)[1] if "," in data_url else data_url
    return base64.b64decode(b64)


def apply_edits(pdf_bytes: bytes, edits: dict) -> bytes:
    """把 EditState 应用到 PDF，返回新 PDF 字节。"""
    src = fitz.open(stream=pdf_bytes, filetype="pdf")
    out = fitz.open()

    page_order = edits.get("pageOrder") or list(range(1, src.page_count + 1))
    rotations = edits.get("rotations") or {}
    overlays = edits.get("overlays") or []

    # 按 pageOrder 拷贝页面（跳过被删除的页）
    valid_pages: list[int] = []
    for orig_page in page_order:
        if 1 <= orig_page <= src.page_count:
            out.insert_pdf(src, from_page=orig_page - 1, to_page=orig_page - 1)
            valid_pages.append(orig_page)

    # overlays 按原始页号分组
    by_page: dict[int, list[dict]] = {}
    for o in overlays:
        p = o.get("page")
        if p is not None:
            by_page.setdefault(int(p), []).append(o)

    for out_idx, orig_page in enumerate(valid_pages):
        page = out[out_idx]
        W = page.rect.width   # 未旋转尺寸
        H = page.rect.height
        # 先画 overlays（未旋转坐标系）
        for o in by_page.get(orig_page, []):
            _draw_overlay(page, o, W, H)
        # 再设旋转（fitz 把内容 + overlays 一起旋转）
        rot = int(rotations.get(str(orig_page), 0)) or 0
        if rot % 360:
            page.set_rotation(rot % 360)

    return out.tobytes()


def _draw_overlay(page, o: dict, W: float, H: float) -> None:
    t = o.get("type")
    rgb = _hex_to_rgb(o.get("color", "#000000"))
    sw = float(o.get("strokeWidth", 2))

    if t == "text":
        x = float(o.get("x", 0)) * W
        y = float(o.get("y", 0)) * H
        size = float(o.get("fontSize", 16))
        page.insert_text((x, y + size), o.get("text", ""), fontsize=size, color=rgb)

    elif t == "highlight":
        x, y = float(o.get("x", 0)) * W, float(o.get("y", 0)) * H
        w, h = float(o.get("w", 0)) * W, float(o.get("h", 0)) * H
        page.draw_rect(fitz.Rect(x, y, x + w, y + h), color=rgb, fill=rgb,
                       fill_opacity=0.4, overlay=True)

    elif t == "underline":
        x, y = float(o.get("x", 0)) * W, float(o.get("y", 0)) * H
        w, h = float(o.get("w", 0)) * W, float(o.get("h", 0)) * H
        page.draw_line(fitz.Point(x, y + h), fitz.Point(x + w, y + h),
                       color=rgb, width=sw)

    elif t == "rectangle":
        x, y = float(o.get("x", 0)) * W, float(o.get("y", 0)) * H
        w, h = float(o.get("w", 0)) * W, float(o.get("h", 0)) * H
        page.draw_rect(fitz.Rect(x, y, x + w, y + h), color=rgb, width=sw)

    elif t == "draw":
        pts = o.get("points") or []
        for i in range(1, len(pts)):
            a, b = pts[i - 1], pts[i]
            page.draw_line(
                fitz.Point(a["x"] * W, a["y"] * H),
                fitz.Point(b["x"] * W, b["y"] * H),
                color=rgb, width=sw,
            )

    elif t == "arrow":
        x1, y1 = float(o.get("x1", 0)) * W, float(o.get("y1", 0)) * H
        x2, y2 = float(o.get("x2", 0)) * W, float(o.get("y2", 0)) * H
        page.draw_line(fitz.Point(x1, y1), fitz.Point(x2, y2), color=rgb, width=sw)
        ang = math.atan2(y2 - y1, x2 - x1)
        head = 8
        for da in (math.pi - 0.4, math.pi + 0.4):
            hx = x2 + head * math.cos(ang + da)
            hy = y2 + head * math.sin(ang + da)
            page.draw_line(fitz.Point(x2, y2), fitz.Point(hx, hy), color=rgb, width=sw)

    elif t == "redact":
        x, y = float(o.get("x", 0)) * W, float(o.get("y", 0)) * H
        w, h = float(o.get("w", 0)) * W, float(o.get("h", 0)) * H
        page.draw_rect(fitz.Rect(x, y, x + w, y + h), color=(0, 0, 0),
                       fill=(0, 0, 0), fill_opacity=1.0, overlay=True)

    elif t == "image":
        x, y = float(o.get("x", 0)) * W, float(o.get("y", 0)) * H
        w, h = float(o.get("w", 0)) * W, float(o.get("h", 0)) * H
        img_data = o.get("imageData", "")
        if img_data:
            try:
                img_bytes = _data_url_to_bytes(img_data)
                page.insert_image(fitz.Rect(x, y, x + w, y + h), stream=img_bytes)
            except Exception:
                pass
