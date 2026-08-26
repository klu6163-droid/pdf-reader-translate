"""PDF 全文翻译路由（长任务 + SSE 进度）。"""
from __future__ import annotations

import asyncio
import json
import os
import tempfile

from fastapi import APIRouter, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse

from app.models.schemas import LLMConfig, StartTaskResponse
from app.services import pdf_service
from app.services.file_utils import (
    cleanup_later,
    cleanup_old_entries,
    safe_pdf_filename,
    scoped_path,
)
from app.services.task_manager import task_manager
from app.services.diagnostics import start_translation
from app.middlewares import heavy_task_gate

router = APIRouter(prefix="/api/translate/pdf", tags=["pdf-translate"])

# 上传与结果的临时目录
WORK_DIR = os.path.join(tempfile.gettempdir(), "pdf_translate")
os.makedirs(WORK_DIR, exist_ok=True)
cleanup_old_entries(WORK_DIR)


@router.post("/start", response_model=StartTaskResponse)
async def start_pdf_translate(
    file: UploadFile = File(...),
    target_lang: str = Form("zh"),
    api_key: str = Header("", alias="x-llm-api-key"),
    base_url: str = Header("https://api.openai.com/v1", alias="x-llm-base-url"),
    model: str = Header("gpt-4o-mini", alias="x-llm-model"),
    max_concurrency: int = Header(1, alias="x-llm-max-concurrency", ge=1, le=8),
    request_interval_ms: int = Header(
        1100, alias="x-llm-request-interval-ms", ge=0, le=60000
    ),
    max_retries: int = Header(5, alias="x-llm-max-retries", ge=0, le=10),
    retry_base_seconds: float = Header(
        2.0, alias="x-llm-retry-base-seconds", ge=0.1, le=60.0
    ),
) -> StartTaskResponse:
    """接收 PDF，创建翻译任务，立即返回 task_id。"""
    if not api_key:
        raise HTTPException(status_code=400, detail="缺少 API Key")

    safe_name = safe_pdf_filename(file.filename)
    task = task_manager.create()
    upload_path = scoped_path(WORK_DIR, f"{task.id}_{safe_name}")
    with open(upload_path, "wb") as f:
        f.write(await file.read())

    config = LLMConfig(
        api_key=api_key,
        base_url=base_url,
        model=model,
        max_concurrency=max_concurrency,
        request_interval_ms=request_interval_ms,
        max_retries=max_retries,
        retry_base_seconds=retry_base_seconds,
    )
    out_dir = scoped_path(WORK_DIR, task.id)
    trace = start_translation("pdf", task.id)

    async def _run() -> None:
        succeeded = False
        final_mode = "pdf"
        try:
            # 重任务闸门：限制同时进行的翻译任务数，避免 CPU/内存打爆。
            async with heavy_task_gate:
                async for prog in pdf_service.translate_pdf(
                    upload_path, out_dir, config, target_lang
                ):
                    if prog.mode:
                        final_mode = prog.mode
                    event = {
                        "progress": round(prog.progress, 4),
                        "message": prog.message,
                        "mode": prog.mode,
                        "done": prog.done,
                        "error": prog.error,
                    }
                    await task_manager.push(task.id, event)
                    if prog.done:
                        succeeded = not prog.error
                        task_manager.finish(
                            task.id,
                            result=prog.result_path,
                            error=prog.message if prog.error else None,
                        )
        except Exception as e:  # noqa: BLE001
            msg = f"翻译失败: {e}"
            await task_manager.push(
                task.id,
                {"progress": 1.0, "message": msg, "done": True, "error": True},
            )
            task_manager.finish(task.id, error=str(e))
        finally:
            trace.finish(succeeded, final_mode)
            asyncio.create_task(
                cleanup_later(
                    [upload_path, out_dir],
                    on_done=lambda: task_manager.cleanup(task.id),
                )
            )

    asyncio.create_task(_run())
    return StartTaskResponse(task_id=task.id)


@router.get("/progress/{task_id}")
async def pdf_progress(task_id: str) -> StreamingResponse:
    """SSE 进度流：每连接独立订阅，多并发连接各自收到全量事件（审计 3.2）。"""

    async def event_gen():
        if task_manager.get(task_id) is None:
            event = {
                "progress": 1.0,
                "message": "任务不存在或已清理（后端可能已重启），请重新发起全文翻译",
                "done": True,
                "error": True,
            }
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
            return

        # 入场重放 last_event + 实时广播直到 done，由 subscribe_events 统一保证
        # （重连重放兼容 2.2；finally 退订，客户端断开不泄漏订阅队列）。
        async for event in task_manager.subscribe_events(task_id, done_message="翻译完成"):
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )


@router.get("/result/{task_id}")
async def pdf_result(task_id: str) -> FileResponse:
    """下载翻译后的 PDF。"""
    task = task_manager.get(task_id)
    if not task:
        raise HTTPException(
            status_code=404,
            detail="任务不存在或已清理（后端可能已重启），请重新发起全文翻译",
        )
    if not task.result:
        raise HTTPException(status_code=404, detail="结果不存在或未完成")
    if not os.path.exists(task.result):
        raise HTTPException(status_code=404, detail="结果文件已清理，请重新发起全文翻译")
    return FileResponse(
        task.result,
        media_type="application/pdf",
        filename=os.path.basename(task.result),
    )
