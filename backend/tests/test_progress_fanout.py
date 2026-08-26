"""集成回归（审计 3.2）：多个并发 SSE 连接必须各自收到全量进度事件。

红色历史（未修复代码实测）：
- Task 只有单个全局 asyncio.Queue，多连接 `queue.get()` 破坏性单消费；
- 两个并发 /progress 连接瓜分事件流（各收约一半，合起来才是全集）；
- done 事件只被其中一个连接取走，另一连接在 `queue.get()` 上永久阻塞
  （finish() 只置标志、不唤醒等待者）→ 本测试以 wait_for 超时应诊。

修复目标（绿色）：每连接独立订阅队列 + 广播，两个连接各自收到完整有序序列 + done。
"""
from __future__ import annotations

import asyncio
import json

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.services import pdf_service
from app.services.pdf_service import TranslateProgress

STEP_COUNT = 10
PER_STREAM_TIMEOUT = 5.0


def _expected_messages() -> list[str]:
    return [f"step-{i}" for i in range(STEP_COUNT)] + ["全部完成"]


@pytest.fixture
def fake_generators(monkeypatch):
    """把两条翻译路由的生成器换成假进度源：无需 LLM/真实 PDF 处理。

    首事件前留 0.1s、事件间 0.02s，保证两个并发 SSE 连接都来得及订阅，
    使「瓜分」现象在旧代码上稳定出现。
    """

    async def fake_translate(upload_path, out_dir, config, target_lang):
        await asyncio.sleep(0.1)
        for i in range(STEP_COUNT):
            await asyncio.sleep(0.02)
            yield TranslateProgress(
                progress=(i + 1) / (STEP_COUNT + 1), message=f"step-{i}"
            )
        yield TranslateProgress(
            progress=1.0,
            message="全部完成",
            done=True,
            result_path=out_dir + "/fake.pdf",
        )

    async def fake_overlay(upload_path, out_dir, config):
        async for prog in fake_translate(upload_path, out_dir, config, "zh"):
            yield prog

    monkeypatch.setattr(pdf_service, "translate_pdf", fake_translate)
    monkeypatch.setattr(pdf_service, "generate_overlay_translation", fake_overlay)


async def _start_task(client: AsyncClient, start_path: str) -> str:
    files = {"file": ("t.pdf", b"%PDF-1.4 fake", "application/pdf")}
    r = await client.post(
        start_path,
        files=files,
        data={"target_lang": "zh"},
        headers={"x-llm-api-key": "sk-test"},
    )
    assert r.status_code == 200, r.text
    return r.json()["task_id"]


@pytest.mark.parametrize(
    "start_path,progress_prefix",
    [
        ("/api/translate/pdf/start", "/api/translate/pdf/progress"),
        ("/api/overlay/pdf/start", "/api/overlay/pdf/progress"),
    ],
    ids=["full-translate", "overlay-translate"],
)
async def test_two_sse_connections_both_receive_full_sequence(
    fake_generators, start_path, progress_prefix
):
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://test", timeout=15
    ) as client:
        task_id = await _start_task(client, start_path)
        url = f"{progress_prefix}/{task_id}"

        async def collect() -> list[dict]:
            events: list[dict] = []
            async with client.stream("GET", url) as resp:
                assert resp.status_code == 200
                async for line in resp.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    ev = json.loads(line[len("data: "):])
                    events.append(ev)
                    if ev.get("done"):
                        return events
            return events  # 流结束但未收到 done（同样是失败证据）

        results = await asyncio.gather(
            asyncio.wait_for(collect(), timeout=PER_STREAM_TIMEOUT),
            asyncio.wait_for(collect(), timeout=PER_STREAM_TIMEOUT),
            return_exceptions=True,
        )

        expected = _expected_messages()
        got_lists = []
        for idx, res in enumerate(results, 1):
            assert not isinstance(res, BaseException), (
                f"连接 {idx} 未收到 done：{res!r}。"
                "旧代码单队列破坏性单消费：done 被另一连接取走后，"
                "本连接在 queue.get() 上永久等待（finish 不唤醒）"
            )
            got_lists.append([e["message"] for e in res])

        for idx, got in enumerate(got_lists, 1):
            other = got_lists[1] if idx == 1 else got_lists[0]
            assert got == expected, (
                f"连接 {idx} 收到 {len(got)} 条（期望 {len(expected)} 条全量序列）：{got}；"
                f"另一连接收到 {len(other)} 条：{other}。"
                "两连接瓜分了同一事件流"
            )
