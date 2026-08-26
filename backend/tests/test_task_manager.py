"""task_manager 单元测试：生命周期、广播送达、背压、finish 唤醒与重放。"""
from __future__ import annotations

import asyncio

import pytest

from app.services.task_manager import MAX_QUEUE_SIZE, TaskManager


@pytest.mark.asyncio
async def test_create_and_get():
    tm = TaskManager()
    task = tm.create()
    assert task.id
    assert tm.get(task.id) is task
    assert tm.get("nonexistent") is None


@pytest.mark.asyncio
async def test_push_records_last_event_and_broadcasts():
    """push 更新 last_event，且每个订阅者队列都收到广播（审计 3.2）。"""
    tm = TaskManager()
    task = tm.create()
    q1 = tm.subscribe(task.id)
    q2 = tm.subscribe(task.id)
    await tm.push(task.id, {"progress": 0.5, "message": "half"})

    assert task.last_event == {"progress": 0.5, "message": "half"}
    assert q1 is not None and q2 is not None
    seq1, event1 = await asyncio.wait_for(q1.get(), timeout=1)
    seq2, event2 = await asyncio.wait_for(q2.get(), timeout=1)
    assert event1["message"] == "half"
    assert event2["message"] == "half"
    assert seq1 == seq2 == task.seq


@pytest.mark.asyncio
async def test_finish_and_cleanup():
    tm = TaskManager()
    task = tm.create()
    tm.finish(task.id, result="/tmp/out.pdf")
    assert task.finished is True
    assert task.result == "/tmp/out.pdf"
    assert task.error is None
    tm.cleanup(task.id)
    assert tm.get(task.id) is None


@pytest.mark.asyncio
async def test_push_to_missing_task_is_noop():
    tm = TaskManager()
    # 不应抛异常；只是 no-op
    await tm.push("nope", {"progress": 1.0})
    assert tm.subscribe("nope") is None
    tm.unsubscribe("nope", asyncio.Queue())  # 同样 no-op


@pytest.mark.asyncio
async def test_finish_wakes_all_subscribers():
    """finish 时向每个订阅者注入兜底 done，等待者不会被永久挂起（审计 3.2）。"""
    tm = TaskManager()
    task = tm.create()
    q1 = tm.subscribe(task.id)
    q2 = tm.subscribe(task.id)

    tm.finish(task.id, error="boom")

    assert q1 is not None and q2 is not None
    for q in (q1, q2):
        _seq, wake = await asyncio.wait_for(q.get(), timeout=1)
        assert wake["done"] is True
        assert wake["error"] is True
        assert wake["message"] == "boom"


@pytest.mark.asyncio
async def test_full_queue_drops_oldest():
    """订阅者队列有界：满时丢最旧，最新事件必达（生产者不阻塞）。"""
    tm = TaskManager()
    task = tm.create()
    q = tm.subscribe(task.id)
    assert q is not None

    total = MAX_QUEUE_SIZE + 44
    for i in range(total):
        await tm.push(task.id, {"message": f"m{i}"})

    assert q.qsize() == MAX_QUEUE_SIZE
    kept = [q.get_nowait() for _ in range(MAX_QUEUE_SIZE)]
    assert kept[0][1]["message"] == f"m{total - MAX_QUEUE_SIZE}"  # 最旧的 44 条被丢
    assert kept[-1][1]["message"] == f"m{total - 1}"  # 最新事件必在
    assert task.last_event == {"message": f"m{total - 1}"}


@pytest.mark.asyncio
async def test_subscribe_events_replay_then_live_without_dup_or_gap():
    """入场重放 last_event 恰好一次，其后实时事件无缝衔接、无重复无缺口。"""
    tm = TaskManager()
    task = tm.create()
    await tm.push(task.id, {"message": "e1"})
    await tm.push(task.id, {"message": "e2"})

    consumer = asyncio.create_task(
        _collect_until_done(tm, task.id)
    )
    # 等待订阅注册完成（注册在生成器首个 await 之前，同步发生）
    while not task.subscribers:
        await asyncio.sleep(0.01)

    await tm.push(task.id, {"message": "e3"})
    await tm.push(task.id, {"message": "end", "done": True})
    tm.finish(task.id, result="/tmp/out.pdf")

    events = await asyncio.wait_for(consumer, timeout=2)
    # e1 属历史（重放语义只追当前状态，与现网一致）；e2 重放一次不重复
    assert [e["message"] for e in events] == ["e2", "e3", "end"]
    # 消费结束后退订，不泄漏订阅队列
    assert task.subscribers == []


@pytest.mark.asyncio
async def test_subscribe_events_on_finished_task_replays_done_once():
    """完成后（重）订阅：重放 done 事件即终态（2.2 重连 / 切标签自愈回归）。"""
    tm = TaskManager()
    task = tm.create()
    await tm.push(task.id, {"message": "work"})
    await tm.push(task.id, {"message": "finished-ok", "done": True})
    tm.finish(task.id, result="/tmp/out.pdf")

    events = await asyncio.wait_for(_collect_until_done(tm, task.id), timeout=2)
    assert len(events) == 1
    assert events[0]["done"] is True
    assert events[0]["message"] == "finished-ok"


@pytest.mark.asyncio
async def test_subscribe_events_synthesizes_done_when_finished_without_events():
    """防御兜底：任务从未推过事件就 finish，（重）订阅也能收到合成 done。"""
    tm = TaskManager()
    task = tm.create()
    tm.finish(task.id, error="boom")

    events = await asyncio.wait_for(_collect_until_done(tm, task.id), timeout=2)
    assert len(events) == 1
    assert events[0]["done"] is True
    assert events[0]["error"] is True
    assert events[0]["message"] == "boom"


@pytest.mark.asyncio
async def test_subscribe_events_missing_task_yields_nothing():
    tm = TaskManager()
    events = [e async for e in tm.subscribe_events("nope")]
    assert events == []


async def _collect_until_done(tm: TaskManager, task_id: str) -> list[dict]:
    return [event async for event in tm.subscribe_events(task_id)]
