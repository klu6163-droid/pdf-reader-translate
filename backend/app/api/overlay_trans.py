"""覆盖翻译路由（跳过 pdf2zh，直接原位覆盖；长任务 + SSE 进度）。

与全文翻译（pdf_trans）走同一套 task_manager + SSE 模式，但后端直接调
pdf_service.generate_overlay_translation，不加载 pdf2zh 模型、不尝试原位替换，
适合 pdf2zh 效果不理想时改用覆盖翻译。
"""
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

router = APIRouter(prefix="/api/overlay/pdf", tags=["overlay-translate"])

# 上传与结果的临时目录
WORK_DIR = os.path.join(tempfile.gettempdir(), "pdf_overlay")
os.makedirs(WORK_DIR, exist_ok=True)
cleanup_old_entries(WORK_DIR)


@router.post("/start", response_model=StartTaskResponse)
async def start_overlay_translate(
    file: UploadFile = File(...),
    target_lang: str = Form("zh"),
    api_key: str = Header("", alias="x-llm-api-key"),
    base_url: str = Header("https://api.openai.com/v1", alias="x-llm-base-url"),
    model: str = Header("gpt-4o-mini", alias="x-llm-model"),
) -> StartTaskResponse:
    """接收 PDF，创建覆盖翻译任务（跳过 pdf2zh），立即返回 task_id。"""
    if not api_key:
        raise HTTPException(status_code=400, detail="缺少 API Key")

    safe_name = safe_pdf_filename(file.filename)
    task = task_manager.create()
    upload_path = scoped_path(WORK_DIR, f"{task.id}_{safe_name}")
    with open(upload_path, "wb") as f:
        f.write(await file.read())

    config = LLMConfig(api_key=api_key, base_url=base_url, model=model)
    out_dir = scoped_path(WORK_DIR, task.id)

    async def _run() -> None:
        try:
            async for prog in pdf_service.generate_overlay_translation(
                upload_path, out_dir, config
            ):
                event = {
                    "progress": round(prog.progress, 4),
                    "message": prog.message,
                    "mode": prog.mode,
                    "done": prog.done,
                    "error": prog.error,
                }
                await task_manager.push(task.id, event)
                if prog.done:
                    task_manager.finish(
                        task.id,
                        result=prog.result_path,
                        error=prog.message if prog.error else None,
                    )
        except Exception as e:  # noqa: BLE001
            msg = f"覆盖翻译失败: {e}"
            await task_manager.push(
                task.id,
                {"progress": 1.0, "message": msg, "done": True, "error": True},
            )
            task_manager.finish(task.id, error=str(e))
        finally:
            asyncio.create_task(
                cleanup_later(
                    [upload_path, out_dir],
                    on_done=lambda: task_manager.cleanup(task.id),
                )
            )

    asyncio.create_task(_run())
    return StartTaskResponse(task_id=task.id)


@router.get("/progress/{task_id}")
async def overlay_progress(task_id: str) -> StreamingResponse:
    """SSE 进度流。"""
    task = task_manager.get(task_id)

    async def event_gen():
        if not task:
            event = {
                "progress": 1.0,
                "message": "任务不存在或已清理（后端可能已重启），请重新发起覆盖翻译",
                "done": True,
                "error": True,
            }
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
            return

        if task.finished:
            event = task.last_event or {
                "progress": 1.0,
                "message": task.error or "覆盖翻译完成",
                "done": True,
                "error": bool(task.error),
            }
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
            return

        if task.last_event:
            yield f"data: {json.dumps(task.last_event, ensure_ascii=False)}\n\n"

        while True:
            event = await task.queue.get()
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
            if event.get("done"):
                break

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )


@router.get("/result/{task_id}")
async def overlay_result(task_id: str) -> FileResponse:
    """下载覆盖翻译后的 PDF。"""
    task = task_manager.get(task_id)
    if not task:
        raise HTTPException(
            status_code=404,
            detail="任务不存在或已清理（后端可能已重启），请重新发起覆盖翻译",
        )
    if not task.result:
        raise HTTPException(status_code=404, detail="结果不存在或未完成")
    if not os.path.exists(task.result):
        raise HTTPException(status_code=404, detail="结果文件已清理，请重新发起覆盖翻译")
    return FileResponse(
        task.result,
        media_type="application/pdf",
        filename=os.path.basename(task.result),
    )
