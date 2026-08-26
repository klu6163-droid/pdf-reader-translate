"""内存态任务管理器，用于长任务（全文翻译 / 覆盖翻译）的进度与结果暂存。

MVP 阶段用内存字典即可；生产可替换为 Redis。每个任务保存：
- 订阅者队列（每个 SSE 连接一个独立有界队列，事件广播送达；
  早期版本用单个共享队列，多连接破坏性单消费会瓜分事件流，见审计 3.2）
- 最后一条事件，供 SSE（重）订阅立即恢复当前状态（前端 2.2 重连依赖此重放）
- 最终结果路径 / 状态

送达契约：
- push() 广播到全部订阅者并更新 last_event；
- finish() 置完成标志，并向每个订阅者注入兜底 done 事件，保证没有等待者被永久挂起；
  生产者约定先推业务 done 事件再调 finish()，届时注入事件与之重复，
  消费端收到首个 done 即退出，幂等无害——兜底只兜「finish 前未推 done」的路径。
- 订阅者队列有界（MAX_QUEUE_SIZE），满时丢最旧：进度是状态量，
  丢中间事件不丢状态，且 done 永远是最新事件、不会被丢；
  生产者广播全程 put_nowait，慢/卡消费者不阻塞翻译任务。
"""
from __future__ import annotations

import asyncio
import contextlib
import uuid
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Optional

# 单个订阅者队列最多积压的事件数。进度事件每条 ~几百字节，
# 256 条封顶 ≈ 卡死连接最坏 ~75KB 内存，生产者永不阻塞。
MAX_QUEUE_SIZE = 256


@dataclass
class Task:
    id: str
    result: Optional[Any] = None
    error: Optional[str] = None
    finished: bool = False
    last_event: Optional[dict] = None
    # 全局递增事件序号（push/finish 各 +1）。订阅者队列存 (seq, event)；
    # 消费端用它对「入场重放」与「实时广播」去重。仅内部状态，不进 SSE payload。
    seq: int = 0
    subscribers: "list[asyncio.Queue[tuple[int, dict]]]" = field(default_factory=list)


def _enqueue(q: "asyncio.Queue[tuple[int, dict]]", item: tuple[int, dict]) -> None:
    """非阻塞入队；队列满时丢弃最旧事件。"""
    if q.full():
        with contextlib.suppress(asyncio.QueueEmpty):
            q.get_nowait()
    with contextlib.suppress(asyncio.QueueFull):
        q.put_nowait(item)


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

    def subscribe(self, task_id: str) -> Optional["asyncio.Queue[tuple[int, dict]]"]:
        """为一个 SSE 连接注册独立订阅队列；任务不存在返回 None。"""
        task = self._tasks.get(task_id)
        if task is None:
            return None
        q: "asyncio.Queue[tuple[int, dict]]" = asyncio.Queue(maxsize=MAX_QUEUE_SIZE)
        task.subscribers.append(q)
        return q

    def unsubscribe(self, task_id: str, q: "asyncio.Queue[tuple[int, dict]]") -> None:
        task = self._tasks.get(task_id)
        if task is not None:
            with contextlib.suppress(ValueError):
                task.subscribers.remove(q)

    async def push(self, task_id: str, event: dict) -> None:
        """广播事件到全部订阅者，并记录 last_event 供（重）订阅重放。"""
        task = self._tasks.get(task_id)
        if task is None:
            return
        task.seq += 1
        task.last_event = event
        for q in list(task.subscribers):
            _enqueue(q, (task.seq, event))

    def finish(self, task_id: str, result: Any = None, error: Optional[str] = None) -> None:
        task = self._tasks.get(task_id)
        if task is None:
            return
        task.result = result
        task.error = error
        task.finished = True
        # 唤醒全部订阅者：注入兜底 done（生产者已先推过 done 时，消费端收到
        # 首个 done 即退出，重复注入幂等无害）。此行保证任何「finish 前未推
        # done」的路径下也没有等待者被永久挂起（审计 3.2）。
        wake = (
            task.last_event
            if task.last_event is not None and task.last_event.get("done")
            else {
                "progress": 1.0,
                "message": error or "任务结束",
                "done": True,
                "error": bool(error),
            }
        )
        task.seq += 1
        for q in list(task.subscribers):
            _enqueue(q, (task.seq, wake))

    def cleanup(self, task_id: str) -> None:
        self._tasks.pop(task_id, None)

    async def subscribe_events(
        self, task_id: str, done_message: str = "任务结束"
    ) -> AsyncIterator[dict]:
        """以单个 SSE 连接的身份消费事件，逐条 yield 事件 dict。

        - 先注册订阅，再做快照：两者之间无 await，不会漏事件；
          快照时的 last_event 作为入场重放（2.2 重连兼容），
          与重放重叠的队列事件按 seq 去重。
        - 快照必须在首个 yield 前一次性取完（seq/last_event/finished/error），
          否则 yield 挂起期间任务可能完成，重放的旧事件不含 done。
        - 任务已结束时重放即终态；防御性兜底：重放事件不含 done 时
          补发一条合成 done。
        - finally 无条件退订：正常结束、异常、客户端断开（ASGI 取消）
          都不泄漏订阅者队列。
        """
        task = self._tasks.get(task_id)
        if task is None:
            return
        q = self.subscribe(task_id)
        assert q is not None  # 上一行刚确认任务存在
        try:
            replay_seq = task.seq
            replay_event = task.last_event
            finished = task.finished
            error = task.error
            if replay_event is not None:
                yield replay_event
            if finished:
                if replay_event is None or not replay_event.get("done"):
                    yield {
                        "progress": 1.0,
                        "message": error or done_message,
                        "done": True,
                        "error": bool(error),
                    }
                return
            while True:
                seq, event = await q.get()
                if seq <= replay_seq:
                    continue  # 入场重放已覆盖（防御性去重）
                yield event
                if event.get("done"):
                    return
        finally:
            self.unsubscribe(task_id, q)


# 全局单例
task_manager = TaskManager()
