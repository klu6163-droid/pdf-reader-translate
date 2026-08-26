"""兜底翻译不阻塞事件循环回归测试（审计 3.3）。

旧实现把全文抽取 / fitz 逐页处理 / reportlab 写盘等同步重活直接跑在
async 生成器里，独占事件循环 → /api/health 无响应，前端误判后端「离线」。

测试手法：把同步重活 monkeypatch 成 time.sleep 的慢速同步版本，生成器与
10ms 节拍的心跳任务并发跑。重活若仍在事件循环上（旧实现），心跳完全
停摆；正确下放工作线程后，心跳应持续跳动。
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
import time

import pytest

from app.models.schemas import LLMConfig
from app.services import pdf_service

_HEARTBEAT_INTERVAL = 0.01


class _FakeLLM:
    """假 LLMService：不走网络，满足覆盖翻译的 chat()/translate() 契约。"""

    def __init__(self, config):
        pass

    async def translate(self, text, target_lang="中文", source_lang="auto"):
        await asyncio.sleep(0)
        return f"译:{text[:20]}"

    async def chat(self, messages, temperature=0.2, timeout=120.0):
        # _translate_overlay_blocks 要求返回与输入等长的 JSON 字符串数组
        texts = json.loads(messages[-1]["content"])
        return json.dumps([f"译:{t}" for t in texts], ensure_ascii=False)


def _make_small_pdf(tmp_path) -> str:
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas

    path = tmp_path / "small.pdf"
    c = canvas.Canvas(str(path), pagesize=A4)
    c.drawString(72, 720, "hello world")
    c.showPage()
    c.save()
    return str(path)


async def _drain_with_heartbeat(gen):
    """消费生成器并统计期间 10ms 心跳的跳动次数。

    返回 (events, ticks, elapsed)。ticks≈0 说明事件循环被同步代码独占。
    """
    ticks = 0

    async def heartbeat():
        nonlocal ticks
        while True:
            ticks += 1
            await asyncio.sleep(_HEARTBEAT_INTERVAL)

    hb = asyncio.create_task(heartbeat())
    events = []
    start = time.monotonic()
    try:
        async for prog in gen:
            events.append(prog)
    finally:
        hb.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await hb
    return events, ticks, time.monotonic() - start


async def test_text_only_fallback_keeps_loop_alive(monkeypatch, tmp_path):
    """纯文本兜底：全文抽取 + reportlab 写盘不得阻塞事件循环。"""
    pdf_path = _make_small_pdf(tmp_path)
    monkeypatch.setattr(pdf_service, "LLMService", _FakeLLM)

    def slow_extract(_path):
        time.sleep(0.3)  # 模拟大文档全文抽取
        return ["hello world"]

    def slow_write(pages, out_path):
        time.sleep(0.3)  # 模拟折行 + 写盘
        with open(out_path, "wb") as f:
            f.write(b"%PDF-1.4 fake")

    monkeypatch.setattr(pdf_service, "extract_text_per_page", slow_extract)
    monkeypatch.setattr(pdf_service, "_write_text_pdf", slow_write)

    events, ticks, elapsed = await _drain_with_heartbeat(
        pdf_service.generate_text_only_translation(
            pdf_path, str(tmp_path / "out"), LLMConfig(api_key="k")
        )
    )

    # 慢速补丁确实生效（否则测试失去意义）
    assert elapsed >= 0.5, "同步重活补丁未生效，测试无效"
    assert events and events[-1].done
    assert events[-1].result_path.endswith("-zh.pdf")
    # 约 0.6s 同步重活期间，10ms 心跳至少应跳若干次；旧实现 ≈ 0 次
    assert ticks >= 10, f"事件循环被阻塞：{elapsed:.2f}s 内心跳仅 {ticks} 次"


async def test_overlay_fallback_keeps_loop_alive(monkeypatch, tmp_path):
    """覆盖翻译兜底：fitz 逐页重活不得阻塞事件循环（走真实 fitz 端到端）。"""
    fitz = pytest.importorskip("fitz")
    from app.services.fonts import resolve_cjk_font_path

    if resolve_cjk_font_path() is None:
        pytest.skip("本机无 CJK 字体，覆盖路径会退化为纯文本模式，无法覆盖本测试目标")

    pdf_path = _make_small_pdf(tmp_path)
    monkeypatch.setattr(pdf_service, "LLMService", _FakeLLM)

    def slow_blocks(page):
        time.sleep(0.25)  # 模拟单页 get_text("blocks") 重活
        return [(fitz.Rect(40, 40, 220, 90), "hello world")]

    monkeypatch.setattr(pdf_service, "_page_text_blocks", slow_blocks)

    events, ticks, elapsed = await _drain_with_heartbeat(
        pdf_service.generate_overlay_translation(
            pdf_path, str(tmp_path / "out"), LLMConfig(api_key="k")
        )
    )

    assert elapsed >= 0.2, "同步重活补丁未生效，测试无效"
    assert events and events[-1].done
    # 端到端正确性：fitz open/insert_font/绘制/子集化/保存（均经 to_thread）仍产出有效结果
    assert events[-1].result_path and os.path.exists(events[-1].result_path)
    assert ticks >= 8, f"事件循环被阻塞：{elapsed:.2f}s 内心跳仅 {ticks} 次"
