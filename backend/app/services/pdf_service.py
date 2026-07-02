"""PDF 处理服务。

职责：
1. 提取 PDF 全文文本（供总结 / 兜底翻译使用）。
2. PDF 全文翻译：优先调用 pdf2zh（PDFMathTranslate）保留排版/公式/图表；
   若环境未安装 pdf2zh，则降级为「逐页文本翻译并重排」的简版实现，
   并在进度信息里明确告知用户当前使用的是降级模式。

所有长任务通过异步生成器 yield 进度，交由路由层转成 SSE。
"""
from __future__ import annotations

import asyncio
import os
import tempfile
from dataclasses import dataclass, field
from typing import AsyncGenerator, Optional

from pypdf import PdfReader

from app.models.schemas import LLMConfig
from app.services.llm import LLMService


# ---------- 文本提取 ----------

def extract_text(pdf_path: str) -> str:
    """提取整篇 PDF 的纯文本。"""
    reader = PdfReader(pdf_path)
    parts: list[str] = []
    for page in reader.pages:
        try:
            parts.append(page.extract_text() or "")
        except Exception:  # noqa: BLE001
            parts.append("")
    return "\n\n".join(parts)


def extract_text_per_page(pdf_path: str) -> list[str]:
    """按页提取文本。"""
    reader = PdfReader(pdf_path)
    pages: list[str] = []
    for page in reader.pages:
        try:
            pages.append(page.extract_text() or "")
        except Exception:  # noqa: BLE001
            pages.append("")
    return pages


# ---------- 全文翻译 ----------

@dataclass
class TranslateProgress:
    progress: float               # 0.0 ~ 1.0
    message: str
    done: bool = False
    result_path: Optional[str] = None
    mode: str = ""                # "pdf2zh" 或 "fallback"


def _pdf2zh_available() -> bool:
    try:
        import pdf2zh  # noqa: F401
        return True
    except Exception:  # noqa: BLE001
        return False


async def translate_pdf(
    pdf_path: str,
    out_dir: str,
    config: LLMConfig,
    target_lang: str = "zh",
) -> AsyncGenerator[TranslateProgress, None]:
    """全文翻译入口，按进度 yield。"""
    if _pdf2zh_available():
        async for p in _translate_with_pdf2zh(pdf_path, out_dir, config, target_lang):
            yield p
    else:
        async for p in _translate_fallback(pdf_path, out_dir, config):
            yield p


async def _translate_with_pdf2zh(
    pdf_path: str,
    out_dir: str,
    config: LLMConfig,
    target_lang: str,
) -> AsyncGenerator[TranslateProgress, None]:
    """调用 pdf2zh 保留排版翻译。

    pdf2zh 通过环境变量读取 OpenAI-compatible 配置，这里在子进程中注入，
    避免污染主进程环境，也不会把 key 写入磁盘。
    """
    yield TranslateProgress(0.02, "启动 pdf2zh 引擎...", mode="pdf2zh")

    os.makedirs(out_dir, exist_ok=True)
    env = os.environ.copy()
    env["OPENAI_API_KEY"] = config.api_key
    env["OPENAI_BASE_URL"] = config.base_url
    env["OPENAI_MODEL"] = config.model

    # pdf2zh 输出 {name}-mono.pdf（单语）与 {name}-dual.pdf（双语对照）
    base = os.path.splitext(os.path.basename(pdf_path))[0]
    cmd = [
        "pdf2zh",
        pdf_path,
        "-o",
        out_dir,
        "-lo",
        target_lang,
        "-s",
        "openai",
    ]

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        env=env,
    )

    # pdf2zh 会往 stdout 打印进度（含百分比），这里做粗略解析
    assert proc.stdout is not None
    last = 0.05
    async for raw in proc.stdout:
        line = raw.decode("utf-8", "ignore").strip()
        if not line:
            continue
        pct = _parse_percent(line)
        if pct is not None:
            last = 0.05 + pct * 0.9
        yield TranslateProgress(min(last, 0.95), f"翻译中: {line[:80]}", mode="pdf2zh")

    await proc.wait()

    mono = os.path.join(out_dir, f"{base}-mono.pdf")
    result = mono if os.path.exists(mono) else None
    if result is None:
        # 兜底：目录里找任意生成的 pdf
        for f in os.listdir(out_dir):
            if f.endswith(".pdf") and f != os.path.basename(pdf_path):
                result = os.path.join(out_dir, f)
                break

    if result and os.path.exists(result):
        yield TranslateProgress(1.0, "翻译完成", done=True, result_path=result, mode="pdf2zh")
    else:
        yield TranslateProgress(
            1.0,
            "pdf2zh 未生成结果文件，请检查配置或改用降级模式",
            done=True,
            mode="pdf2zh",
        )


def _parse_percent(line: str) -> Optional[float]:
    """从 pdf2zh 日志行中解析百分比（0~1）。"""
    import re

    m = re.search(r"(\d{1,3})%", line)
    if m:
        try:
            return min(int(m.group(1)) / 100.0, 1.0)
        except ValueError:
            return None
    return None


async def _translate_fallback(
    pdf_path: str,
    out_dir: str,
    config: LLMConfig,
) -> AsyncGenerator[TranslateProgress, None]:
    """降级实现：逐页提取文本翻译，生成纯文本对照版 PDF。

    明确告知用户：此模式不保留公式/图表/排版，仅供快速阅读。
    """
    yield TranslateProgress(
        0.02,
        "未检测到 pdf2zh，使用降级模式（纯文本翻译，不保留排版/公式/图表）",
        mode="fallback",
    )

    pages = extract_text_per_page(pdf_path)
    total = len(pages) or 1
    svc = LLMService(config)
    translated_pages: list[str] = []

    for i, text in enumerate(pages):
        if text.strip():
            try:
                zh = await svc.translate(text, target_lang="中文")
            except Exception as e:  # noqa: BLE001
                zh = f"[本页翻译失败: {e}]"
        else:
            zh = "[本页无可提取文本，可能是扫描图片]"
        translated_pages.append(zh)
        yield TranslateProgress(
            0.05 + (i + 1) / total * 0.9,
            f"翻译第 {i + 1}/{total} 页...",
            mode="fallback",
        )

    os.makedirs(out_dir, exist_ok=True)
    base = os.path.splitext(os.path.basename(pdf_path))[0]
    result_path = os.path.join(out_dir, f"{base}-zh.pdf")
    _write_text_pdf(translated_pages, result_path)

    yield TranslateProgress(
        1.0,
        "降级翻译完成（纯文本版）",
        done=True,
        result_path=result_path,
        mode="fallback",
    )


def _write_text_pdf(pages: list[str], out_path: str) -> None:
    """把逐页文本写成一个简单 PDF（降级模式用）。

    仅依赖 pypdf 无法直接生成文本 PDF，这里用 reportlab；
    若 reportlab 也不可用，退化为写 .txt 并改后缀，保证流程不中断。
    """
    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.pdfgen import canvas
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.cidfonts import UnicodeCIDFont

        pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
        c = canvas.Canvas(out_path, pagesize=A4)
        width, height = A4
        for page_text in pages:
            c.setFont("STSong-Light", 10)
            y = height - 40
            for line in _wrap_lines(page_text, 90):
                if y < 40:
                    c.showPage()
                    c.setFont("STSong-Light", 10)
                    y = height - 40
                c.drawString(40, y, line)
                y -= 14
            c.showPage()
        c.save()
    except Exception:  # noqa: BLE001
        # 最终兜底：写纯文本
        txt_path = out_path.replace(".pdf", ".txt")
        with open(txt_path, "w", encoding="utf-8") as f:
            f.write("\n\n===== 分页 =====\n\n".join(pages))
        # 复制一份为 .pdf 名以满足下游读取（实际是文本）
        with open(out_path, "wb") as f:
            f.write(open(txt_path, "rb").read())


def _wrap_lines(text: str, width: int) -> list[str]:
    """简单按宽度折行。"""
    out: list[str] = []
    for raw in text.split("\n"):
        while len(raw) > width:
            out.append(raw[:width])
            raw = raw[width:]
        out.append(raw)
    return out
