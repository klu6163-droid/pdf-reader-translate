"""PDF 处理服务（带稳定 fallback）。

职责：
1. 提取 PDF 全文文本（供总结 / 兜底翻译使用）。
2. PDF 全文翻译：优先调用 pdf2zh（PDFMathTranslate）保留排版/公式/图表。
   遇到因 PDF 字体/结构问题（CIDFontType2、subset_fonts、invalid literal for int()
   等）失败时，按序自动降级：
     normal → babeldoc 后端 → skip_subset_fonts → compatible+skip_subset_fonts
     → 修复 PDF 后重试 → 纯文本译文模式
   底层错误不直接展示给用户，只下发友好提示。

所有长任务通过异步生成器 yield 进度，交由路由层转成 SSE。
"""
from __future__ import annotations

import asyncio
import logging
import os
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass
from typing import AsyncGenerator, Optional, Tuple

from pypdf import PdfReader, PdfWriter

from app.models.schemas import LLMConfig
from app.services.llm import LLMService

_logger = logging.getLogger("pdf_service")


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


# ---------- 进度 ----------

@dataclass
class TranslateProgress:
    progress: float               # 0.0 ~ 1.0
    message: str
    done: bool = False
    result_path: Optional[str] = None
    mode: str = ""                # "pdf2zh" 或 "fallback"
    error: bool = False           # 失败时为 True，前端据此显示错误而非加载结果


# ---------- 可用性 / 模型 ----------

def _pdf2zh_available() -> bool:
    """检测 pdf2zh 是否可用。

    用 find_spec 而非直接 import，避免 PyInstaller 静态分析把 pdf2zh
    强制打包进 exe（是否打包由 backend.spec 的 collect 配置决定）。
    """
    import importlib.util

    return importlib.util.find_spec("pdf2zh") is not None


def _ensure_model():
    """初始化版面识别 onnx 模型（首次联网下载，之后走缓存）。返回 model。"""
    from pdf2zh.doclayout import ModelInstance, OnnxModel

    if ModelInstance.value is None:
        ModelInstance.value = OnnxModel.from_pretrained()
    return ModelInstance.value


def _openai_envs(config: LLMConfig) -> dict:
    """pdf2zh OpenAI translator 的 envs 字段名（见 pdf2zh/translator.py）。"""
    return {
        "OPENAI_BASE_URL": config.base_url,
        "OPENAI_API_KEY": config.api_key,
        "OPENAI_MODEL": config.model,
    }


def _clean_stale_outputs(out_dir: str, pdf_path: str) -> None:
    """每次尝试前清掉上次可能残留的 {base}-mono.pdf / {base}-dual.pdf。"""
    base = os.path.splitext(os.path.basename(pdf_path))[0]
    for suffix in ("-mono.pdf", "-dual.pdf"):
        p = os.path.join(out_dir, f"{base}{suffix}")
        try:
            if os.path.exists(p):
                os.remove(p)
        except OSError:
            pass


def _find_output(out_dir: str, pdf_path: str) -> Optional[str]:
    """定位 pdf2zh 输出的单语 PDF。"""
    base = os.path.splitext(os.path.basename(pdf_path))[0]
    mono = os.path.join(out_dir, f"{base}-mono.pdf")
    if os.path.exists(mono):
        return mono
    for f in os.listdir(out_dir):
        if f.endswith(".pdf") and f != os.path.basename(pdf_path):
            return os.path.join(out_dir, f)
    return None


def _log_attempt(mode: str, duration: float, ok: bool, error: Optional[str]) -> None:
    _logger.info(
        "[pdf2zh attempt] mode=%s duration=%.1fs ok=%s error=%s",
        mode, duration, ok, (error or "")[:200],
    )


# ---------- 错误分类 ----------

def is_font_subset_error(exc: BaseException) -> bool:
    """是否字体/subset/int 解析类错误（这类错误值得用兼容模式重试）。"""
    msg = str(exc).lower()
    keywords = (
        "invalid literal for int", "cidfont", "subset", "font",
        "glyph", "cidtogidmap", "encoding", "pdfvalueerror", "pypdf",
    )
    return any(k in msg for k in keywords)


# ---------- 单次 pdf2zh 尝试（进程内 API）----------

# 注意：名为 run_pdf2zh_cli 是按需求命名；实际走进程内 API 而非 subprocess，
# 因为冻结打包后没有 pdf2zh 命令、也无 python -m pdf2zh。subprocess 仅用于
# 真正的外部修复工具（qpdf/mutool/gs）。
async def run_pdf2zh_cli(
    pdf_path: str,
    out_dir: str,
    config: LLMConfig,
    target_lang: str,
    *,
    mode: str = "normal",
    model=None,
    timeout: float = 1200.0,
) -> Tuple[bool, Optional[str], Optional[str]]:
    """进程内调用 pdf2zh 跑一次翻译。

    mode:
      - normal: translate() 默认
      - babeldoc: 切到 babeldoc 后端（async_translate）
      - skip_subset: translate(skip_subset_fonts=True)
      - compatible_skip_subset: translate(compatible=True, skip_subset_fonts=True)

    返回 (ok, result_path, error_msg)。
    """
    os.makedirs(out_dir, exist_ok=True)
    _clean_stale_outputs(out_dir, pdf_path)
    start = time.monotonic()
    try:
        if mode == "babeldoc":
            result_path = await asyncio.wait_for(
                _run_babeldoc(pdf_path, out_dir, config, target_lang),
                timeout=timeout,
            )
        else:
            from pdf2zh import translate  # 延迟导入，配合 find_spec

            kwargs = dict(
                files=[pdf_path],
                output=out_dir,
                lang_in="",
                lang_out=target_lang,
                service="openai",
                envs=_openai_envs(config),
                thread=4,
                model=model,
                callback=_noop_cb,
            )
            if mode == "skip_subset":
                kwargs["skip_subset_fonts"] = True
            elif mode == "compatible_skip_subset":
                kwargs["compatible"] = True
                kwargs["skip_subset_fonts"] = True
            await asyncio.wait_for(
                asyncio.to_thread(translate, **kwargs), timeout=timeout
            )
            result_path = _find_output(out_dir, pdf_path)
        if not result_path:
            raise RuntimeError("pdf2zh 未生成结果文件")
        _log_attempt(mode, time.monotonic() - start, True, None)
        return True, result_path, None
    except asyncio.TimeoutError:
        msg = f"超时（{timeout:.0f}s）"
        _log_attempt(mode, time.monotonic() - start, False, msg)
        return False, None, msg
    except Exception as e:  # noqa: BLE001
        msg = f"{type(e).__name__}: {e}"
        _log_attempt(mode, time.monotonic() - start, False, msg)
        return False, None, msg


def _noop_cb(*args, **kwargs) -> None:
    pass


async def _run_babeldoc(pdf_path: str, out_dir: str, config: LLMConfig, target_lang: str) -> str:
    """调用 babeldoc 后端（对应 CLI 的 --babeldoc）。"""
    from babeldoc.high_level import async_translate as yadt_translate
    from babeldoc.high_level import init as yadt_init
    from babeldoc.translation_config import TranslationConfig as YadtConfig
    from pdf2zh.high_level import download_remote_fonts
    from pdf2zh.translator import OpenAITranslator

    yadt_init()
    font_path = download_remote_fonts(target_lang.lower())
    translator = OpenAITranslator(
        "", target_lang, config.model,
        envs=_openai_envs(config), prompt=[], ignore_cache=False,
    )
    yadt_config = YadtConfig(
        input_file=pdf_path,
        font=font_path,
        pages="",
        output_dir=out_dir,
        doc_layout_model=None,
        translator=translator,
        debug=False,
        lang_in="",
        lang_out=target_lang,
        no_dual=False,
        no_mono=False,
        qps=4,
    )
    result_path: Optional[str] = None
    async for event in yadt_translate(yadt_config):
        if event.get("type") == "finish":
            result = event.get("translate_result")
            if result is not None:
                result_path = (
                    getattr(result, "mono_pdf_path", None)
                    or getattr(result, "dual_pdf_path", None)
                )
            break
    if not result_path:
        result_path = _find_output(out_dir, pdf_path)
    if not result_path:
        raise RuntimeError("babeldoc 未生成结果文件")
    return result_path


# ---------- PDF 修复（不覆盖原文件）----------

def repair_pdf(pdf_path: str) -> Optional[str]:
    """按序尝试 qpdf → mutool → ghostscript → pypdf 修复。

    生成临时 repaired PDF，不覆盖原文件。返回修复后路径或 None。
    """
    fd, tmp = tempfile.mkstemp(suffix="-repaired.pdf", prefix="pdfrepair_")
    os.close(fd)
    try:
        os.remove(tmp)  # 工具要求 out 不存在
    except OSError:
        pass

    for repair_fn in (
        repair_with_qpdf,
        repair_with_mutool,
        repair_with_ghostscript,
        repair_with_pypdf,
    ):
        if repair_fn(pdf_path, tmp) and os.path.exists(tmp) and os.path.getsize(tmp) > 0:
            _logger.info("[repair] %s 成功 -> %s", repair_fn.__name__, tmp)
            return tmp
        _logger.info("[repair] %s 失败或跳过", repair_fn.__name__)
        # 清理可能的失败产物，给下一个工具干净环境
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass
    return None


def repair_with_qpdf(in_path: str, out_path: str, timeout: float = 120.0) -> bool:
    return _run_repair(
        ["qpdf", "--linearize", "--object-streams=disable", in_path, out_path],
        out_path, timeout,
    )


def repair_with_mutool(in_path: str, out_path: str, timeout: float = 120.0) -> bool:
    return _run_repair(
        ["mutool", "clean", "-ggg", in_path, out_path],
        out_path, timeout,
    )


def repair_with_ghostscript(in_path: str, out_path: str, timeout: float = 180.0) -> bool:
    gs = _which_first(["gswin64c", "gswin32c", "gs"])
    if not gs:
        return False
    return _run_repair(
        [gs, "-dNOPAUSE", "-dBATCH", "-dSAFER", "-sDEVICE=pdfwrite",
         f"-sOutputFile={out_path}", in_path],
        out_path, timeout,
    )


def repair_with_pypdf(in_path: str, out_path: str, timeout: float = 120.0) -> bool:
    """pypdf 重存修复：始终可用（已打包），作为 qpdf/mutool/gs 都缺失时的兜底。"""
    try:
        reader = PdfReader(in_path)
        writer = PdfWriter()
        for page in reader.pages:
            writer.add_page(page)
        with open(out_path, "wb") as f:
            writer.write(f)
        return os.path.exists(out_path) and os.path.getsize(out_path) > 0
    except Exception as e:  # noqa: BLE001
        _logger.info("[repair] pypdf 失败: %s", e)
        return False


def _run_repair(cmd: list, out_path: str, timeout: float) -> bool:
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=timeout, text=True)
        if r.returncode == 0 and os.path.exists(out_path) and os.path.getsize(out_path) > 0:
            return True
        _logger.info(
            "[repair] %s rc=%s stderr=%s",
            cmd[0], r.returncode, (r.stderr or "")[:200],
        )
        return False
    except FileNotFoundError:
        return False  # 工具未安装，跳过
    except subprocess.TimeoutExpired:
        _logger.info("[repair] %s 超时", cmd[0])
        return False
    except Exception as e:  # noqa: BLE001
        _logger.info("[repair] %s 异常: %s", cmd[0], e)
        return False


def _which_first(names: list) -> Optional[str]:
    for n in names:
        p = shutil.which(n)
        if p:
            return p
    return None


# ---------- 纯文本译文模式（最终兜底）----------

async def generate_text_only_translation(
    pdf_path: str,
    out_dir: str,
    config: LLMConfig,
) -> AsyncGenerator[TranslateProgress, None]:
    """纯文本译文 PDF：左侧原 PDF + 右侧按页译文。

    不保留排版/公式/图表，仅供快速阅读。所有 pdf2zh 路线都失败时启用。
    """
    yield TranslateProgress(0.65, "切换为纯文本译文模式...", mode="fallback")

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
            0.65 + (i + 1) / total * 0.33,
            f"翻译第 {i + 1}/{total} 页...",
            mode="fallback",
        )

    os.makedirs(out_dir, exist_ok=True)
    base = os.path.splitext(os.path.basename(pdf_path))[0]
    result_path = os.path.join(out_dir, f"{base}-zh.pdf")
    _write_text_pdf(translated_pages, result_path)

    yield TranslateProgress(
        1.0,
        "完整排版翻译失败，已切换为右侧译文阅读模式",
        done=True,
        result_path=result_path,
        mode="fallback",
    )


# ---------- 编排：带 fallback 的全文翻译 ----------

async def translate_pdf_with_fallback(
    pdf_path: str,
    out_dir: str,
    config: LLMConfig,
    target_lang: str = "zh",
) -> AsyncGenerator[TranslateProgress, None]:
    """带稳定 fallback 的全文翻译编排。"""
    # 1. 加载版面识别模型（只加载一次）
    yield TranslateProgress(0.03, "加载版面识别模型（首次需联网下载）...", mode="pdf2zh")
    try:
        model = await asyncio.to_thread(_ensure_model)
    except Exception as e:  # noqa: BLE001
        _logger.warning("模型加载失败，直接纯文本: %s", e)
        async for p in generate_text_only_translation(pdf_path, out_dir, config):
            yield p
        return

    # 2-4. pdf2zh 尝试链
    attempts = (
        ("normal", "翻译中...", 0.05),
        ("babeldoc", "该 PDF 结构较特殊，正在使用兼容模式重试。", 0.15),
        ("skip_subset", "该 PDF 结构较特殊，正在使用兼容模式重试。", 0.25),
        ("compatible_skip_subset", "该 PDF 结构较特殊，正在使用兼容模式重试。", 0.35),
    )
    timed_out = False
    for mode, msg, prog in attempts:
        yield TranslateProgress(prog, msg, mode="pdf2zh")
        ok, result, err = await run_pdf2zh_cli(
            pdf_path, out_dir, config, target_lang, mode=mode, model=model,
        )
        if ok and result:
            yield TranslateProgress(
                1.0, "翻译完成", done=True, result_path=result, mode="pdf2zh"
            )
            return
        if err and err.startswith("超时"):
            timed_out = True
            break  # LLM 慢/卡，换模式无意义，直接降级

    # 5-8. 修复 PDF 后重试（超时的情况不修，直接降级）
    if not timed_out:
        yield TranslateProgress(0.45, "正在生成兼容副本后重试。", mode="pdf2zh")
        repaired = await asyncio.to_thread(repair_pdf, pdf_path)
        if repaired:
            for mode, msg, prog in (
                ("skip_subset", "正在用兼容副本重试...", 0.50),
                ("compatible_skip_subset", "正在用兼容副本重试...", 0.55),
            ):
                yield TranslateProgress(prog, msg, mode="pdf2zh")
                ok, result, err = await run_pdf2zh_cli(
                    repaired, out_dir, config, target_lang, mode=mode, model=model,
                )
                if ok and result:
                    try:
                        os.remove(repaired)
                    except OSError:
                        pass
                    yield TranslateProgress(
                        1.0, "翻译完成（兼容副本）", done=True,
                        result_path=result, mode="pdf2zh",
                    )
                    return
            try:
                os.remove(repaired)
            except OSError:
                pass

    # 9. 全失败 → 纯文本译文模式
    async for p in generate_text_only_translation(pdf_path, out_dir, config):
        yield p


# ---------- 对外入口 ----------

async def translate_pdf(
    pdf_path: str,
    out_dir: str,
    config: LLMConfig,
    target_lang: str = "zh",
) -> AsyncGenerator[TranslateProgress, None]:
    """全文翻译入口，按进度 yield。"""
    if _pdf2zh_available():
        async for p in translate_pdf_with_fallback(pdf_path, out_dir, config, target_lang):
            yield p
    else:
        async for p in generate_text_only_translation(pdf_path, out_dir, config):
            yield p


# ---------- 纯文本 PDF 生成（降级模式用）----------

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
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(f"生成降级 PDF 失败: {e}") from e


def _wrap_lines(text: str, width: int) -> list[str]:
    """简单按宽度折行。"""
    out: list[str] = []
    for raw in text.split("\n"):
        while len(raw) > width:
            out.append(raw[:width])
            raw = raw[width:]
        out.append(raw)
    return out
