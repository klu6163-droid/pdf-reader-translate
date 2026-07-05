"""结构化翻译服务：PyMuPDF 提取文本块 → 清洗 → 分类 → LLM 逐块翻译 → JSON/MD/PDF。

与 pdf2zh 的原位替换不同，本服务把 PDF 拆成结构化文本块再翻译，
适合 pdf2zh 效果差的多栏/字体异常文献；输出可重排的中文 PDF，不依赖原排版。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from dataclasses import dataclass
from typing import AsyncGenerator

from app.models.schemas import LLMConfig
from app.services.llm import LLMService, ANTI_HALLUCINATION
from app.services.pdf_service import TranslateProgress, _register_text_pdf_font

_logger = logging.getLogger("structtrans")

# 水印 / 页眉页脚（独立成行的常见文献水印）
_WATERMARK_PATTERNS = [
    re.compile(r"^\s*Downloaded from\s+.*$", re.I | re.M),
    re.compile(r"^\s*Downloaded by\s+.*$", re.I | re.M),
    re.compile(r"^\s*Published (by|in|on)\s+.*$", re.I | re.M),
    re.compile(r"^\s*doi:\s*10\.\S+\s*$", re.I | re.M),
    re.compile(r"^\s*https?://\S+\s*$", re.I | re.M),
]
# 英文断词修复：devel-\nopment → development
_HYPHEN_BREAK = re.compile(r"([A-Za-z])-\n([a-z])")


@dataclass
class StructBlock:
    page: int  # 1-based
    block_id: str
    bbox: tuple[float, float, float, float]
    type: str  # title/abstract/body/caption/table/references
    source_text: str
    translated_text: str = ""
    font_size: float = 0.0  # 内部用，不导出 JSON


# ---------- 提取 ----------

def extract_blocks(pdf_path: str) -> list[StructBlock]:
    """PyMuPDF 逐页提取文本块（含字号，供分类）。返回 1-based 页码的块列表。"""
    import fitz  # PyMuPDF

    blocks: list[StructBlock] = []
    doc = fitz.open(pdf_path)
    try:
        for pno in range(len(doc)):
            page = doc[pno]
            d = page.get_text("dict")
            for idx, blk in enumerate(d.get("blocks", [])):
                if blk.get("type") != 0:  # 0=文本块，1=图片块
                    continue
                bbox = blk.get("bbox", (0, 0, 0, 0))
                texts: list[str] = []
                max_size = 0.0
                for line in blk.get("lines", []):
                    texts.append(
                        "".join(span.get("text", "") for span in line.get("spans", []))
                    )
                    for span in line.get("spans", []):
                        sz = span.get("size", 0.0)
                        if sz > max_size:
                            max_size = sz
                text = "\n".join(texts).strip()
                if not text:
                    continue
                blocks.append(
                    StructBlock(
                        page=pno + 1,
                        block_id=f"{pno + 1}-{idx}",
                        bbox=(
                            round(bbox[0], 1),
                            round(bbox[1], 1),
                            round(bbox[2], 1),
                            round(bbox[3], 1),
                        ),
                        type="body",
                        source_text=text,
                        font_size=round(max_size, 1),
                    )
                )
    finally:
        doc.close()
    return blocks


# ---------- 清洗 ----------

def clean_text(text: str) -> str:
    """去水印/页眉页脚、修断词、合并段内断行。"""
    if not text:
        return ""
    for pat in _WATERMARK_PATTERNS:
        text = pat.sub("", text)
    text = _HYPHEN_BREAK.sub(r"\1\2", text)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    # 段内单换行 → 空格（保留 \n\n 段落分隔）
    text = re.sub(r"(?<!\n)\n(?!\n)", " ", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


# ---------- 分类 ----------

def classify_block(block: StructBlock) -> str:
    """启发式分类：title/abstract/body/caption/table/references。"""
    text = block.source_text.strip()
    low = text.lower()
    if block.page == 1 and block.font_size >= 12 and len(text) < 200:
        return "title"
    if low.startswith("abstract") or low.startswith("摘要"):
        return "abstract"
    if re.match(r"^(figure|fig\.|table|tab\.)\s*\d", low):
        return "caption"
    if low.startswith("references") or low.startswith("bibliography") or re.match(r"^\[\d+\]", text):
        return "references"
    digits = sum(c.isdigit() for c in text)
    if len(text) > 20 and digits / len(text) > 0.3 and text.count("\n") > 3:
        return "table"
    return "body"


# ---------- 翻译 ----------

def _target_lang_name(target_lang: str) -> str:
    return "中文" if target_lang.lower().startswith("zh") else target_lang


async def _translate_one(svc: LLMService, text: str, target_lang_name: str) -> str:
    """单块翻译，医学/学术术语强约束。"""
    system = (
        f"你是专业的医学/学术文献翻译。将用户提供的文本忠实翻译为{target_lang_name}。"
        "要求：医学专业术语（疾病名、药物、解剖、统计指标等）务必准确，"
        "保留缩写、数字、单位、符号、引用标记 [1]；只翻译不解释，不添加原文没有的内容。"
        + ANTI_HALLUCINATION
    )
    return await svc.chat(
        [{"role": "system", "content": system}, {"role": "user", "content": text}],
        temperature=0.2,
    )


# ---------- 输出 ----------

def to_json(blocks: list[StructBlock], page_count: int, source_name: str) -> dict:
    return {
        "page_count": page_count,
        "source_name": source_name,
        "blocks": [
            {
                "page": b.page,
                "block_id": b.block_id,
                "bbox": list(b.bbox),
                "type": b.type,
                "source_text": b.source_text,
                "translated_text": b.translated_text,
            }
            for b in blocks
        ],
    }


def to_markdown(blocks: list[StructBlock], source_name: str) -> str:
    out: list[str] = [f"# {source_name} 译文", ""]
    by_page: dict[int, list[StructBlock]] = {}
    for b in blocks:
        by_page.setdefault(b.page, []).append(b)
    for page in sorted(by_page):
        out.append(f"\n## 第 {page} 页\n")
        for b in by_page[page]:
            t = b.translated_text or b.source_text
            if b.type == "title":
                out.append(f"### {t}\n")
            elif b.type == "abstract":
                out.append(f"**摘要**：{t}\n")
            elif b.type == "caption":
                out.append(f"*{t}*\n")
            elif b.type == "references":
                out.append(f"- {t}")
            elif b.type == "table":
                out.append(f"```\n{t}\n```\n")
            else:
                out.append(f"{t}\n")
    return "\n".join(out)


def _wrap(text: str, width: int = 80) -> list[str]:
    """中英混排换行：英文按词、中文按字符（CJK 算 2 宽）。"""
    out: list[str] = []
    for para in text.split("\n"):
        if not para.strip():
            out.append("")
            continue
        if " " in para:
            cur = ""
            for word in para.split(" "):
                if cur and len(cur) + len(word) + 1 > width:
                    out.append(cur)
                    cur = word
                else:
                    cur = (cur + " " + word).strip()
            if cur:
                out.append(cur)
        else:
            cur = ""
            w = 0
            for ch in para:
                cw = 2 if ord(ch) > 127 else 1
                if w + cw > width and cur:
                    out.append(cur)
                    cur = ch
                    w = cw
                else:
                    cur += ch
                    w += cw
            if cur:
                out.append(cur)
    return out


def to_pdf(blocks: list[StructBlock], source_name: str, out_path: str) -> None:
    """reportlab 重排中文 PDF（复用 pdf_service 的中文字体注册）。"""
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas

    font = _register_text_pdf_font()
    c = canvas.Canvas(out_path, pagesize=A4)
    _, height = A4
    y = height - 50

    def draw(text: str, size: int, gap: int, width: int = 80) -> None:
        nonlocal y
        c.setFont(font, size)
        for line in _wrap(text, width):
            if y < 40:
                c.showPage()
                c.setFont(font, size)
                y = height - 40
            c.drawString(40, y, line)
            y -= gap

    draw(source_name, 16, 22, width=56)
    y -= 8
    by_page: dict[int, list[StructBlock]] = {}
    for b in blocks:
        by_page.setdefault(b.page, []).append(b)
    for page in sorted(by_page):
        draw(f"— 第 {page} 页 —", 10, 14)
        y -= 4
        for b in by_page[page]:
            text = b.translated_text or b.source_text
            if b.type == "title":
                draw(text, 14, 18, width=60)
            elif b.type in ("caption", "references"):
                draw(text, 9, 12, width=88)
            else:
                draw(text, 10, 14, width=80)
            y -= 4
    c.save()


# ---------- 编排 ----------

async def translate_structured(
    pdf_path: str,
    out_dir: str,
    config: LLMConfig,
    target_lang: str = "zh",
) -> AsyncGenerator[TranslateProgress, None]:
    """结构化翻译入口，按进度 yield。结果为 blocks.json 路径。"""
    target_lang_name = _target_lang_name(target_lang)
    source_name = os.path.basename(pdf_path)

    yield TranslateProgress(0.02, "提取文本块...", mode="struct")
    blocks = await asyncio.to_thread(extract_blocks, pdf_path)
    if not blocks:
        yield TranslateProgress(
            1.0,
            "未提取到任何文本（可能是扫描版 PDF，需 OCR）",
            done=True,
            error=True,
            mode="struct",
        )
        return

    yield TranslateProgress(
        0.05, f"提取到 {len(blocks)} 个块，清洗与分类...", mode="struct"
    )
    for b in blocks:
        b.source_text = clean_text(b.source_text)
        b.type = classify_block(b)
    blocks = [b for b in blocks if b.source_text]
    page_count = max((b.page for b in blocks), default=0)

    yield TranslateProgress(0.08, "开始逐块翻译...", mode="struct")
    svc = LLMService(config)
    total = len(blocks)
    for i, b in enumerate(blocks):
        src = b.source_text.strip()
        if not src:
            b.translated_text = ""
        else:
            try:
                b.translated_text = await _translate_one(svc, src, target_lang_name)
            except Exception as e:  # noqa: BLE001
                _logger.warning("块 %s 翻译失败: %s", b.block_id, e)
                b.translated_text = f"[本块翻译失败: {e}]"
        yield TranslateProgress(
            0.08 + (i + 1) / total * 0.9,
            f"翻译 {i + 1}/{total}...",
            mode="struct",
        )

    os.makedirs(out_dir, exist_ok=True)
    json_path = os.path.join(out_dir, "blocks.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(to_json(blocks, page_count, source_name), f, ensure_ascii=False, indent=2)

    yield TranslateProgress(
        1.0, "结构化翻译完成", done=True, result_path=json_path, mode="struct"
    )


# ---------- 健康检查（供 pdf_service 回退用） ----------

def pdf_is_unhealthy(pdf_path: str) -> tuple[bool, str]:
    """检测 PDF 是否不适合 pdf2zh 原位翻译。
    返回 (unhealthy, reason)。unhealthy=True 时建议走结构化模式。
    """
    import fitz

    try:
        doc = fitz.open(pdf_path)
    except Exception:
        return True, "PDF 无法打开"

    try:
        total_text = 0
        garbled = 0
        multi_col_pages = 0
        sample = min(len(doc), 10)
        for pno in range(sample):
            page = doc[pno]
            txt = page.get_text("text") or ""
            total_text += len(txt)
            garbled += sum(
                1 for ch in txt if ch == "�" or (ord(ch) < 9 and ch not in "\n\r\t")
            )
            blocks = [b for b in page.get_text("blocks") if b[6] == 0]
            if blocks:
                page_w = page.rect.width
                left = sum(1 for b in blocks if b[0] < page_w / 2)
                right = sum(1 for b in blocks if b[2] > page_w / 2)
                if left >= 3 and right >= 3:
                    multi_col_pages += 1
        if total_text and garbled / max(total_text, 1) > 0.05:
            return True, "文本乱码率高（疑似 CID 字体解析失败）"
        if multi_col_pages >= 3:
            return True, "多栏排版（pdf2zh 原位替换易乱序）"
        return False, ""
    finally:
        doc.close()
