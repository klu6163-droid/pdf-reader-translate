"""内存态任务管理器，用于长任务（全文翻译 / 总结）的进度与结果暂存。

MVP 阶段用内存字典即可；生产可替换为 Redis。每个任务保存：
- 进度队列（asyncio.Queue），供 SSE 消费
- 最终结果路径 / 状态
"""
from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class Task:
    id: str
    queue: "asyncio.Queue[dict]" = field(default_factory=asyncio.Queue)
    result: Optional[Any] = None
    error: Optional[str] = None
    finished: bool = False


class TaskManager:
    def __init__(self) -> None:
        self._tasks: dict[str, Task] = {}

    def create(self) -> Task:
        tid = uuid.uuid4().hex
        task = Task(id=tid)
        self._tasks[tid] = task
        return task

    def get(self, task_id: str) -> Optional[Task]:
        return self._tasks.get(task_id)

    async def push(self, task_id: str, event: dict) -> None:
        task = self._tasks.get(task_id)
        if task:
            await task.queue.put(event)

    def finish(self, task_id: str, result: Any = None, error: Optional[str] = None) -> None:
        task = self._tasks.get(task_id)
        if task:
            task.result = result
            task.error = error
            task.finished = True

    def cleanup(self, task_id: str) -> None:
        self._tasks.pop(task_id, None)


# 全局单例
task_manager = TaskManager()
