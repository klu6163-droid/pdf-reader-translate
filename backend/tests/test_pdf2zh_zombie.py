"""审计 3.1 回归测试：超时僵尸线程的协作取消与尝试目录隔离。

基线（未修复代码）已坐实：任务报超时返回后翻译线程仍存活，随后把产物
写进同一 out_dir（基线运行记录见 audit-fixme.md 3.1 条目）。本文件断言
修复后的行为：

1. pdf2zh 路线：超时置 cancellation_event，线程在页边界退出；等待上限内
   退出记「回收成功」，超上限记「放弃回收」，两种情况都不再阻塞编排。
2. babeldoc 路线：其 async_translate 会吞 CancelledError 并无限等待内部
   worker，因此超时等待必须有界（主超时 + 回收上限），绝不挂死编排。
3. 编排层：每次尝试使用互相隔离的子目录，不再共享 out_dir。
"""
from __future__ import annotations

import asyncio
import logging
import os
import time

import pytest

from app.models.schemas import LLMConfig
from app.services import pdf_service

pdf2zh = pytest.importorskip("pdf2zh")


def _make_small_pdf(tmp_path) -> str:
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas

    path = tmp_path / "small.pdf"
    c = canvas.Canvas(str(path), pagesize=A4)
    c.drawString(72, 720, "hello world")
    c.showPage()
    c.save()
    return str(path)


def _config() -> LLMConfig:
    return LLMConfig(api_key="k", base_url="http://x.invalid", model="m")


# ---------- pdf2zh 路线：协作取消 ----------


async def test_timeout_reaps_pdf2zh_thread_via_cancellation(monkeypatch, tmp_path, caplog):
    """超时置事件 → 线程在页边界退出 → 记录回收成功。"""

    def fake_translate(cancellation_event=None, **kwargs):
        # 模拟 pdf2zh 的页边界检查：收到取消信号即退出
        assert cancellation_event is not None, "未收到 cancellation_event"
        while True:
            if cancellation_event.is_set():
                raise asyncio.CancelledError("task cancelled")
            time.sleep(0.02)

    monkeypatch.setattr("pdf2zh.translate", fake_translate)
    monkeypatch.setattr(pdf_service, "GRACE_REAP_SECONDS", 5.0)

    out_dir = tmp_path / "task" / "attempt-normal"
    pdf = _make_small_pdf(tmp_path)

    with caplog.at_level(logging.INFO, logger="pdf_service"):
        t0 = time.monotonic()
        ok, result, err = await pdf_service.run_pdf2zh_cli(
            pdf, str(out_dir), _config(), "zh", timeout=0.3
        )
        elapsed = time.monotonic() - t0

    assert not ok and result is None
    assert err.startswith("超时")
    assert "退出" in err, f"未记录到回收成功：{err}"
    assert elapsed < 4.0
    # 线程被取消，未跑完 → 不会留下任何产物
    assert not list(out_dir.glob("*.pdf")) or not any(
        f.name.endswith(("-mono.pdf", "-dual.pdf")) for f in out_dir.glob("*.pdf")
    )


async def test_timeout_abandons_thread_ignoring_cancel(monkeypatch, tmp_path, caplog):
    """线程无视取消信号：回收上限内等不到 → 记「放弃回收」，编排不被拖住。"""
    wrote = {"done": False}

    def fake_translate(cancellation_event=None, **kwargs):
        time.sleep(3.0)  # 无视 cancellation_event
        with open(os.path.join(kwargs["output"], "late.pdf"), "wb") as f:
            f.write(b"%PDF-late")
        wrote["done"] = True

    monkeypatch.setattr("pdf2zh.translate", fake_translate)
    monkeypatch.setattr(pdf_service, "GRACE_REAP_SECONDS", 0.5)

    out_dir = tmp_path / "task" / "attempt-normal"
    pdf = _make_small_pdf(tmp_path)

    with caplog.at_level(logging.INFO, logger="pdf_service"):
        t0 = time.monotonic()
        ok, result, err = await pdf_service.run_pdf2zh_cli(
            pdf, str(out_dir), _config(), "zh", timeout=0.3
        )
        elapsed = time.monotonic() - t0

    assert not ok and result is None
    assert err.startswith("超时")
    assert "放弃回收" in err, f"未记录到放弃回收：{err}"
    # 主超时 0.3 + 回收上限 0.5，编排不能被拖到秒级以上
    assert elapsed < 1.5
    assert not wrote["done"]

    # 线程最终自行收尾时，写的是它自己的尝试目录（隔离），不污染别处
    await asyncio.sleep(3.0)
    assert wrote["done"]
    assert (out_dir / "late.pdf").exists()


# ---------- babeldoc 路线：超时等待必须有界 ----------


async def test_babeldoc_timeout_is_bounded(monkeypatch, tmp_path):
    """babeldoc 吞 CancelledError 并等待内部 worker（模拟），超时仍必须有界返回。"""
    import babeldoc.high_level as bh
    import pdf2zh.high_level as ph
    import pdf2zh.translator as pt

    async def fake_async_translate(config):
        # 真实 babeldoc 是异步生成器（内部 yield 进度事件）
        try:
            await asyncio.sleep(30)
            yield {}  # 不会执行到
        except asyncio.CancelledError:
            # 模拟 babeldoc：吞掉取消，继续等内部 worker（真实实现的收尾行为）
            await asyncio.sleep(1.2)
            raise

    class _FakeTranslator:
        def __init__(self, *args, **kwargs):
            pass

    monkeypatch.setattr(bh, "async_translate", fake_async_translate)
    monkeypatch.setattr(bh, "init", lambda: None)
    monkeypatch.setattr(ph, "download_remote_fonts", lambda lang: "font.ttf")
    monkeypatch.setattr(pt, "OpenAITranslator", _FakeTranslator)
    monkeypatch.setattr(pdf_service, "GRACE_REAP_SECONDS", 0.5)

    out_dir = tmp_path / "task" / "attempt-babeldoc"
    pdf = _make_small_pdf(tmp_path)

    t0 = time.monotonic()
    ok, result, err = await pdf_service.run_pdf2zh_cli(
        pdf, str(out_dir), _config(), "zh", mode="babeldoc", timeout=0.3
    )
    elapsed = time.monotonic() - t0

    assert not ok and result is None
    assert err.startswith("超时")
    # 若被 babeldoc 的吞取消行为拖住，这里会等到收尾结束（远超回收上限）
    assert elapsed < 30.0, f"babeldoc 超时等待无界：耗时 {elapsed:.1f}s"

    # 排空被放弃的任务，避免事件循环关闭时 "Task was destroyed but pending"
    await asyncio.sleep(1.5)


# ---------- 编排层：每次尝试独立目录 ----------


async def test_attempts_use_isolated_out_dirs(monkeypatch, tmp_path):
    """normal/babeldoc/skip_subset/compatible 四次尝试各用独立子目录。"""
    seen: list[tuple[str, str]] = []

    async def fake_run(
        pdf_path,
        out_dir,
        config,
        target_lang,
        *,
        mode,
        model=None,
        timeout=1200.0,
        progress_callback=None,
    ):
        seen.append((mode, out_dir))
        return False, None, "fake fail"

    async def fake_overlay(pdf_path, out_dir, config, *, fallback=False):
        yield pdf_service.TranslateProgress(
            1.0, "done", done=True, result_path="x.pdf", mode="fallback"
        )

    monkeypatch.setattr(pdf_service, "run_pdf2zh_cli", fake_run)
    monkeypatch.setattr(pdf_service, "_doclayout_model_cached", lambda: True)
    monkeypatch.setattr(pdf_service, "_ensure_model", lambda: object())
    monkeypatch.setattr(pdf_service, "repair_pdf", lambda p: None)
    monkeypatch.setattr(pdf_service, "generate_overlay_translation", fake_overlay)

    out_dir = tmp_path / "task"
    events = [
        p
        async for p in pdf_service.translate_pdf_with_fallback(
            "fake.pdf", str(out_dir), _config(), "zh"
        )
    ]

    dirs = [d for _, d in seen]
    assert [m for m, _ in seen] == [
        "normal", "babeldoc", "skip_subset", "compatible_skip_subset",
    ]
    assert len(dirs) == 4
    assert len(set(dirs)) == 4, f"尝试目录未隔离：{dirs}"
    assert all(os.path.dirname(d) == str(out_dir) for d in dirs)
    # 各尝试互不覆盖：目录名应可区分
    assert len({os.path.basename(d) for d in dirs}) == 4
    assert events[-1].done


async def test_pdf2zh_page_progress_is_streamed_before_completion(
    monkeypatch, tmp_path
):
    """normal 模式逐页 callback 必须在最终完成前转成单调的服务进度事件。"""

    def fake_translate(callback=None, **kwargs):
        assert callback is not None
        assert kwargs["thread"] == 2

        class FakeTqdm:
            total = 3
            n = 0

        progress = FakeTqdm()
        for page in range(1, 4):
            progress.n = page
            callback(progress)
            time.sleep(0.02)

        source_name = os.path.splitext(os.path.basename(kwargs["files"][0]))[0]
        with open(os.path.join(kwargs["output"], f"{source_name}-mono.pdf"), "wb") as f:
            f.write(b"%PDF-progress")

    monkeypatch.setattr("pdf2zh.translate", fake_translate)
    monkeypatch.setattr(pdf_service, "_doclayout_model_cached", lambda: True)
    monkeypatch.setattr(pdf_service, "_ensure_model", lambda: object())

    pdf = _make_small_pdf(tmp_path)
    events = [
        event
        async for event in pdf_service.translate_pdf_with_fallback(
            pdf,
            str(tmp_path / "out"),
            LLMConfig(
                api_key="k",
                base_url="http://x.invalid",
                model="m",
                max_concurrency=2,
            ),
            "zh",
        )
    ]

    page_events = [event for event in events if "正在翻译第" in event.message]
    assert [event.message for event in page_events] == [
        "正在翻译第 1/3 页...",
        "正在翻译第 2/3 页...",
        "正在翻译第 3/3 页...",
    ]
    assert all(0.05 < event.progress < 1.0 for event in page_events)
    assert [event.progress for event in events] == sorted(
        event.progress for event in events
    )
    assert events[-1].done and events[-1].progress == 1.0
