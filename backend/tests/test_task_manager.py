"""task_manager 单元测试：生命周期与 SSE 事件传递。"""
from __future__ import annotations

import asyncio

import pytest

from app.services.task_manager import TaskManager


@pytest.mark.asyncio
async def test_create_and_get():
    tm = TaskManager()
    task = tm.create()
    assert task.id
    assert tm.get(task.id) is task
    assert tm.get("nonexistent") is None


@pytest.mark.asyncio
async def test_push_records_last_event_and_queues():
    tm = TaskManager()
    task = tm.create()
    await tm.push(task.id, {"progress": 0.5, "message": "half"})
    assert task.last_event == {"progress": 0.5, "message": "half"}
    event = await asyncio.wait_for(task.queue.get(), timeout=1)
    assert event["message"] == "half"


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
