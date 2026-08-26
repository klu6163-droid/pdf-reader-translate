"""PDF 处理服务（带稳定 fallback）。

职责：
1. 提取 PDF 全文文本（供总结 / 兜底翻译使用）。
2. PDF 全文翻译：优先调用 pdf2zh（PDFMathTranslate）保留排版/公式/图表。
   遇到因 PDF 字体/结构问题（CIDFontType2、subset_fonts、invalid literal for int()
   等）失败时，按序自动降级：
     normal → babeldoc 后端 → skip_subset_fonts → compatible+skip_subset_fonts
     → 修复 PDF 后重试 → 覆盖翻译模式
   底层错误不直接展示给用户，只下发友好提示。

所有长任务通过异步生成器 yield 进度，交由路由层转成 SSE。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import subprocess
import tempfile
import threading
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


def _doclayout_model_cached() -> bool:
    """版面识别模型是否已落盘缓存（用于显示准确的进度文案，避免每次都提示「首次需联网下载」）。"""
    try:
        from babeldoc.const import get_cache_file_path

        return get_cache_file_path(
            "doclayout_yolo_docstructbench_imgsz1024.onnx", "models"
        ).exists()
    except Exception:
        return False


def _openai_envs(config: LLMConfig) -> dict:
    """pdf2zh OpenAI translator 的 envs 字段名（见 pdf2zh/translator.py）。"""
    return {
        "OPENAI_BASE_URL": config.base_url,
        "OPENAI_API_KEY": config.api_key,
        "OPENAI_MODEL": config.model,
    }


# ---------- 超时回收（审计 3.1）----------

# 超时置取消信号后，等待线程/任务真正退出的上限（秒）。
# 上限内退出记「回收成功」；超上限记「放弃回收」——取消信号已置位，
# 线程会在下一个检查点（页边界 / babeldoc 内部检查点）自行退出，
# 且它只能写进自己那次尝试的隔离子目录，不再污染其他路径。
GRACE_REAP_SECONDS = 60.0


class _AttemptTimeout(Exception):
    """内部异常：某次尝试超时，str 已含回收结果描述。"""


def _timeout_msg(timeout: float, exited: bool, wait_secs: float) -> str:
    """统一的超时文案：挂到 _log_attempt 的 error 字段与返回值上。"""
    if exited:
        return f"超时（{timeout:.0f}s），取消信号生效，{wait_secs:.1f}s 内退出"
    return (
        f"超时（{timeout:.0f}s），等待 {wait_secs:.0f}s 仍未退出，放弃回收"
        "（取消信号已置位，将在下一检查点退出；产物限于本次尝试目录）"
    )


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


def _prepare_pdf2zh_input(pdf_path: str, out_dir: str) -> str:
    """给 pdf2zh 一个可删除的输入副本，避免它清理掉原始上传文件。

    pdf2zh 1.9.x 会删除位于 tempfile.gettempdir() 下的输入文件。我们的上传文件也在
    %TEMP% 下，所以每次尝试都复制一份给 pdf2zh 使用，原文件留给后续 fallback。
    """
    os.makedirs(out_dir, exist_ok=True)
    attempt_path = os.path.join(out_dir, os.path.basename(pdf_path))
    if os.path.abspath(attempt_path) == os.path.abspath(pdf_path):
        return pdf_path
    shutil.copy2(pdf_path, attempt_path)
    return attempt_path


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

    超时处理（审计 3.1）：wait_for 只能取消等待、杀不死线程——旧实现超时后
    僵尸线程继续烧 LLM 额度，收尾时还会往共享目录写产物。现在：
    - pdf2zh 路线：向 translate() 传 cancellation_event，超时置位后线程在下一页
      边界收到 CancelledError 退出；再等至多 GRACE_REAP_SECONDS 确认退出
      （回收成功），超上限放弃回收并记录——取消信号已置位，线程最迟在下一
      检查点退出。
    - babeldoc 路线：其 async_translate 会吞 CancelledError 并无界等待内部
      worker，直接 wait_for 会被拖着无上限，改用「主超时 + 回收上限」两段
      有界等待（见 _run_babeldoc_with_timeout）。
    调用方传入的 out_dir 是本次尝试的隔离子目录（见
    translate_pdf_with_fallback），被放弃线程的残留写入不会交叉污染。
    """
    os.makedirs(out_dir, exist_ok=True)
    attempt_path = _prepare_pdf2zh_input(pdf_path, out_dir)
    start = time.monotonic()
    try:
        if mode == "babeldoc":
            result_path = await _run_babeldoc_with_timeout(
                attempt_path, out_dir, config, target_lang, timeout
            )
        else:
            from pdf2zh import translate  # 延迟导入，配合 find_spec

            kwargs = dict(
                files=[attempt_path],
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

            # set() 在事件循环线程调用；is_set() 由工作线程在页边界轮询，
            # 只读布尔值，跨线程安全
            cancel_event = asyncio.Event()
            finished = threading.Event()

            def _runner() -> None:
                try:
                    translate(cancellation_event=cancel_event, **kwargs)
                finally:
                    finished.set()

            try:
                await asyncio.wait_for(asyncio.to_thread(_runner), timeout=timeout)
            except asyncio.TimeoutError:
                cancel_event.set()
                reap_start = time.monotonic()
                exited = await asyncio.to_thread(finished.wait, GRACE_REAP_SECONDS)
                raise _AttemptTimeout(
                    _timeout_msg(timeout, exited, time.monotonic() - reap_start)
                )
            result_path = _find_output(out_dir, pdf_path)
        if not result_path:
            raise RuntimeError("pdf2zh 未生成结果文件")
        _log_attempt(mode, time.monotonic() - start, True, None)
        return True, result_path, None
    except _AttemptTimeout as e:
        msg = str(e)
        _log_attempt(mode, time.monotonic() - start, False, msg)
        return False, None, msg
    except Exception as e:  # noqa: BLE001
        msg = f"{type(e).__name__}: {e}"
        _log_attempt(mode, time.monotonic() - start, False, msg)
        return False, None, msg


def _noop_cb(*args, **kwargs) -> None:
    pass


async def _run_babeldoc_with_timeout(
    pdf_path: str,
    out_dir: str,
    config: LLMConfig,
    target_lang: str,
    timeout: float,
) -> str:
    """有界等待的 babeldoc 尝试。

    不能直接 wait_for：babeldoc 的 async_translate 捕获 CancelledError 后
    `await finish_event.wait()` 等内部 worker 收尾，吞掉取消后外层等待没有
    上限。这里两段等待：主超时 → 取消 → 至多再等 GRACE_REAP_SECONDS →
    仍不退出则放弃回收（记录）。放弃后任务继续收尾，其写入限于本次尝试
    的隔离目录；babeldoc 内部会按自己的 cancel 检查点停下。
    """
    task = asyncio.create_task(_run_babeldoc(pdf_path, out_dir, config, target_lang))
    done, _ = await asyncio.wait({task}, timeout=timeout)
    if done:
        return task.result()  # 内部异常抛给调用方统一记日志

    task.cancel()
    reap_start = time.monotonic()
    done, _ = await asyncio.wait({task}, timeout=GRACE_REAP_SECONDS)
    exited = bool(done)
    if not exited:
        # 放弃的任务最终收尾时可能带异常，取走以免
        # "Task exception was never retrieved" 警告
        task.add_done_callback(
            lambda t: t.exception() if not t.cancelled() else None
        )
    raise _AttemptTimeout(_timeout_msg(timeout, exited, time.monotonic() - reap_start))


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


# ---------- 覆盖译文模式（最终兜底）----------

def _overlay_font_path() -> Optional[str]:
    """返回可嵌入 PDF 的中文字体路径。"""
    from app.services.fonts import resolve_cjk_font_path
    return resolve_cjk_font_path()


def _page_text_blocks(page) -> list[tuple[object, str]]:
    """提取适合覆盖翻译的文本块；图片内容保持原样。"""
    import fitz

    blocks: list[tuple[object, str]] = []
    page_rect = page.rect
    for raw in page.get_text("blocks"):
        if len(raw) < 5:
            continue
        block_type = raw[6] if len(raw) > 6 else 0
        if block_type != 0:
            continue
        text = _clean_overlay_text(str(raw[4]))
        rect = fitz.Rect(raw[:4])
        if _skip_overlay_text(text, rect, page_rect):
            continue
        blocks.append((rect, text))
    return blocks


def _clean_overlay_text(text: str) -> str:
    return "\n".join(line.strip() for line in text.splitlines() if line.strip()).strip()


def _skip_overlay_text(text: str, rect, page_rect) -> bool:
    if not text:
        return True
    compact = text.replace(" ", "")
    if len(compact) <= 1:
        return True
    if compact.isdigit() and rect.height < 20 and (
        rect.y0 < page_rect.height * 0.12 or rect.y1 > page_rect.height * 0.88
    ):
        return True
    # 很短的符号/编号多半是页眉页脚或图内标号，先不覆盖，降低误伤 figure 的概率。
    if len(compact) <= 3 and all(ch in "0123456789.,;:()[]{}-/" for ch in compact):
        return True
    return False


async def _translate_overlay_blocks(svc: LLMService, texts: list[str]) -> list[str]:
    """按页批量翻译文本块，要求 LLM 返回等长 JSON 数组。"""
    if not texts:
        return []

    system = (
        "你是专业的学术 PDF 覆盖翻译器。用户会给出一个 JSON 字符串数组，"
        "每个元素是一块 PDF 页面文本。请逐项忠实翻译成中文，保持数组长度和顺序完全一致。"
        "保留数字、单位、公式、变量、缩写、材料名称、引用编号和专有名词；只翻译，不解释。"
        "严格只返回 JSON 数组，不要返回 Markdown，不要添加原文没有的信息。"
    )
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": json.dumps(texts, ensure_ascii=False)},
    ]
    try:
        reply = await svc.chat(messages, temperature=0.1, timeout=180.0)
        parsed = _parse_json_string_array(reply)
        if len(parsed) == len(texts):
            return parsed
        _logger.info("覆盖翻译 JSON 数量不匹配: expected=%s got=%s", len(texts), len(parsed))
    except Exception as e:  # noqa: BLE001
        _logger.info("覆盖翻译批量调用失败，改为逐块翻译: %s", e)

    translated: list[str] = []
    for text in texts:
        try:
            translated.append(await svc.translate(text, target_lang="中文"))
        except Exception as e:  # noqa: BLE001
            translated.append(f"[本块翻译失败: {e}]")
    return translated


def _parse_json_string_array(reply: str) -> list[str]:
    data = reply.strip()
    if not data.startswith("["):
        start = data.find("[")
        end = data.rfind("]")
        if start >= 0 and end > start:
            data = data[start:end + 1]
    obj = json.loads(data)
    if not isinstance(obj, list):
        return []
    return [str(item) for item in obj]


def _fit_overlay_font_size(text: str, rect) -> float:
    """估算能放进原文本块的中文字号。"""
    if not text:
        return 6.0
    for size in (9.5, 8.5, 7.5, 6.5, 5.5, 4.8):
        chars_per_line = max(4, int(rect.width / max(size * 0.72, 1)))
        lines = sum(max(1, (len(line) + chars_per_line - 1) // chars_per_line)
                    for line in text.splitlines() or [text])
        if lines * size * 1.22 <= rect.height:
            return size
    return 4.8


def _draw_overlay_text(page, rect, text: str, font_name: str) -> None:
    import fitz

    page_rect = page.rect
    bg = fitz.Rect(
        max(page_rect.x0, rect.x0 - 1.2),
        max(page_rect.y0, rect.y0 - 1.2),
        min(page_rect.x1, rect.x1 + 1.2),
        min(page_rect.y1, rect.y1 + 1.2),
    )
    target = fitz.Rect(bg.x0 + 1.5, bg.y0 + 1.0, bg.x1 - 1.5, bg.y1 - 1.0)
    if target.is_empty or target.width < 8 or target.height < 6:
        return

    page.draw_rect(bg, color=None, fill=(1, 1, 1), fill_opacity=0.96, overlay=True)
    for size in (_fit_overlay_font_size(text, target), 8.0, 7.0, 6.0, 5.0, 4.5):
        rc = page.insert_textbox(
            target,
            text,
            fontname=font_name,
            fontsize=size,
            lineheight=1.05,
            color=(0, 0, 0),
            overlay=True,
        )
        if rc >= -0.1:
            return
        # 没放下时用白底重盖上一轮尝试，再缩小字号。
        page.draw_rect(bg, color=None, fill=(1, 1, 1), fill_opacity=0.96, overlay=True)


def _draw_overlay_page_blocks(
    page, blocks: list, translations: list[str], font_name: str
) -> None:
    """在一页上绘制全部译文块（同步重活，由调用方放进工作线程执行）。"""
    for (rect, _), zh in zip(blocks, translations):
        if zh.strip():
            _draw_overlay_text(page, rect, zh.strip(), font_name)


def _import_fitz():
    """导入 PyMuPDF 并返回模块。

    冻结打包后首次导入可达 1~2s，放进工作线程避免阻塞事件循环。
    """
    import fitz

    return fitz


async def generate_overlay_translation(
    pdf_path: str,
    out_dir: str,
    config: LLMConfig,
    *,
    fallback: bool = False,
) -> AsyncGenerator[TranslateProgress, None]:
    """覆盖译文 PDF：保留原页面图像/figure，只覆盖可识别文本块。

    所有同步重调用（fitz 导入/解析/逐页提取/字体注册/绘制/子集化/保存）一律
    `await asyncio.to_thread(...)` 下放工作线程，否则事件循环被长时间独占，
    /api/health 无法响应，前端会把后端误判为「离线」。
    线程安全说明：每次 to_thread 都 await 完成后才有下一次，同一 fitz Document
    只会被串行访问（PyMuPDF 禁止同一文档跨线程并发使用，串行是允许的）；
    不要在本生成器内并发操作同一 doc。
    """
    progress_base = 0.65 if fallback else 0.0
    progress_span = 0.33 if fallback else 0.98
    yield TranslateProgress(
        progress_base,
        "切换为覆盖翻译模式..." if fallback else "正在准备覆盖翻译...",
        mode="fallback",
    )

    try:
        fitz = await asyncio.to_thread(_import_fitz)
    except Exception as e:  # noqa: BLE001
        _logger.info("PyMuPDF 不可用，改为纯文本译文模式: %s", e)
        async for p in generate_text_only_translation(
            pdf_path, out_dir, config, fallback=fallback
        ):
            yield p
        return

    font_path = _overlay_font_path()
    if not font_path:
        _logger.info("未找到可嵌入中文字体，改为纯文本译文模式")
        async for p in generate_text_only_translation(
            pdf_path, out_dir, config, fallback=fallback
        ):
            yield p
        return

    os.makedirs(out_dir, exist_ok=True)
    base = os.path.splitext(os.path.basename(pdf_path))[0]
    result_path = os.path.join(out_dir, f"{base}-zh.pdf")
    svc = LLMService(config)
    doc = await asyncio.to_thread(fitz.open, pdf_path)
    total = max(len(doc), 1)
    font_name = "AppOverlayCJK"

    try:
        for i, page in enumerate(doc):
            blocks = await asyncio.to_thread(_page_text_blocks, page)
            texts = [text for _, text in blocks]
            translations = await _translate_overlay_blocks(svc, texts)
            try:
                await asyncio.to_thread(
                    page.insert_font, fontname=font_name, fontfile=font_path
                )
            except Exception as e:  # noqa: BLE001
                _logger.info("注册覆盖字体失败: %s", e)
                raise
            await asyncio.to_thread(
                _draw_overlay_page_blocks, page, blocks, translations, font_name
            )
            yield TranslateProgress(
                progress_base + (i + 1) / total * progress_span,
                f"覆盖翻译第 {i + 1}/{total} 页...",
                mode="fallback",
            )

        try:
            await asyncio.to_thread(doc.subset_fonts)
        except Exception as e:  # noqa: BLE001
            _logger.info("覆盖译文 PDF 字体子集化失败，继续保存: %s", e)
        await asyncio.to_thread(doc.save, result_path, garbage=4, deflate=True)
    finally:
        doc.close()

    yield TranslateProgress(
        1.0,
        (
            "完整排版翻译失败，已切换为覆盖翻译模式（figure 保留原样）"
            if fallback
            else "覆盖翻译完成（figure 保留原样）"
        ),
        done=True,
        result_path=result_path,
        mode="fallback",
    )

# ---------- 纯文本译文模式（最终兜底）----------

async def generate_text_only_translation(
    pdf_path: str,
    out_dir: str,
    config: LLMConfig,
    *,
    fallback: bool = True,
) -> AsyncGenerator[TranslateProgress, None]:
    """纯文本译文 PDF：左侧原 PDF + 右侧按页译文。

    不保留排版/公式/图表，仅供快速阅读。所有 pdf2zh 路线都失败时启用。

    全文抽取与 reportlab 写盘均为同步重活，必须经 asyncio.to_thread 下放
    工作线程，否则事件循环被独占（/api/health 无响应 → 前端误判「离线」）。
    """
    progress_base = 0.65 if fallback else 0.0
    progress_span = 0.33 if fallback else 0.98
    yield TranslateProgress(
        progress_base,
        "切换为纯文本译文模式..." if fallback else "正在生成文本译文...",
        mode="fallback",
    )

    pages = await asyncio.to_thread(extract_text_per_page, pdf_path)
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
            progress_base + (i + 1) / total * progress_span,
            f"翻译第 {i + 1}/{total} 页...",
            mode="fallback",
        )

    os.makedirs(out_dir, exist_ok=True)
    base = os.path.splitext(os.path.basename(pdf_path))[0]
    result_path = os.path.join(out_dir, f"{base}-zh.pdf")
    await asyncio.to_thread(_write_text_pdf, translated_pages, result_path)

    yield TranslateProgress(
        1.0,
        "完整排版翻译失败，已切换为右侧译文阅读模式"
        if fallback
        else "文本译文生成完成",
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
    if _doclayout_model_cached():
        yield TranslateProgress(0.03, "加载版面识别模型...", mode="pdf2zh")
    else:
        yield TranslateProgress(0.03, "下载版面识别模型（首次需联网，约 70MB）...", mode="pdf2zh")
    try:
        model = await asyncio.to_thread(_ensure_model)
    except Exception as e:  # noqa: BLE001
        _logger.warning("模型加载失败，直接覆盖翻译: %s", e)
        async for p in generate_overlay_translation(
            pdf_path, out_dir, config, fallback=True
        ):
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
        # 每次尝试独立子目录（审计 3.1）：超时被放弃的线程只能写进本次目录，
        # 各尝试产物互不串扰，也免去清理上一次残留的逻辑
        attempt_dir = os.path.join(out_dir, f"attempt-{mode}")
        ok, result, err = await run_pdf2zh_cli(
            pdf_path, attempt_dir, config, target_lang, mode=mode, model=model,
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
                # 修复副本的尝试同样用独立子目录（与首轮尝试区分开）
                attempt_dir = os.path.join(out_dir, f"repaired-{mode}")
                ok, result, err = await run_pdf2zh_cli(
                    repaired, attempt_dir, config, target_lang, mode=mode, model=model,
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

    # 9. 全失败 → 覆盖翻译模式
    async for p in generate_overlay_translation(
        pdf_path, out_dir, config, fallback=True
    ):
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
        async for p in generate_overlay_translation(
            pdf_path, out_dir, config, fallback=True
        ):
            yield p


# ---------- 纯文本 PDF 生成（降级模式用）----------


def _register_text_pdf_font() -> str:
    """注册可被 pdf.js 稳定渲染的中文字体。"""
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.pdfbase.ttfonts import TTFont

    from app.services.fonts import iter_cjk_font_candidates

    font_name = "AppFallbackCJK"
    # 集合字体路径来自 fonts 模块（跨平台）；ttc 一律取 subfontIndex=0。
    for font_path in iter_cjk_font_candidates():
        if not os.path.exists(font_path):
            continue
        try:
            pdfmetrics.registerFont(
                TTFont(font_name, font_path, subfontIndex=0)
            )
            return font_name
        except Exception as e:  # noqa: BLE001
            _logger.warning("注册降级 PDF 字体失败 %s: %s", font_path, e)

    # 最后兜底：可提取文字，但部分 pdf.js 环境可能需要 CMap 才能显示。
    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    return "STSong-Light"


def _write_text_pdf(pages: list[str], out_path: str) -> None:
    """把逐页文本写成一个简单 PDF（降级模式用）。

    仅依赖 pypdf 无法直接生成文本 PDF，这里用 reportlab；
    若 reportlab 也不可用，退化为写 .txt 并改后缀，保证流程不中断。
    """
    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.pdfgen import canvas

        font_name = _register_text_pdf_font()
        c = canvas.Canvas(out_path, pagesize=A4)
        width, height = A4
        margin = 40
        font_size = 10
        # 按实际绘制宽度折行（旧实现固定 90 字符：中文全宽 10pt/字 → 900pt，
        # 远超 A4 可用宽度 ~515pt，半行文字被裁掉）
        draw_width = width - margin * 2
        for page_text in pages:
            c.setFont(font_name, font_size)
            y = height - margin
            for line in _wrap_lines_by_width(page_text, font_name, font_size, draw_width):
                if y < margin:
                    c.showPage()
                    c.setFont(font_name, font_size)
                    y = height - margin
                c.drawString(margin, y, line)
                y -= 14
            c.showPage()
        c.save()
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(f"生成降级 PDF 失败: {e}") from e


def _est_char_width(ch: str, font_size: float) -> float:
    """估算单字符宽度：CJK/全角约等于字号，拉丁字符约为字号的 55%。"""
    return font_size if ord(ch) > 0x2E7F else font_size * 0.55


def _wrap_lines_by_width(
    text: str, font_name: str, font_size: float, max_width: float
) -> list[str]:
    """按绘制宽度折行：优先用 pdfmetrics 实测，失败退化为字符宽度估算。"""
    from reportlab.pdfbase import pdfmetrics

    def measure(s: str) -> float:
        try:
            return pdfmetrics.stringWidth(s, font_name, font_size)
        except Exception:  # noqa: BLE001
            return sum(_est_char_width(c, font_size) for c in s)

    out: list[str] = []
    for raw in text.split("\n"):
        line = ""
        for ch in raw:
            if line and measure(line + ch) > max_width:
                out.append(line)
                line = ch
            else:
                line += ch
        out.append(line)
    return out
