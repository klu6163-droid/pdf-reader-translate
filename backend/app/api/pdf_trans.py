"""PDF 全文翻译路由（长任务 + SSE 进度）。"""
from __future__ import annotations

import json
import os
import tempfile

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse

from app.models.schemas import LLMConfig, StartTaskResponse
from app.services import pdf_service
from app.services.task_manager import task_manager

router = APIRouter(prefix="/api/translate/pdf", tags=["pdf-translate"])

# 上传与结果的临时目录
WORK_DIR = os.path.join(tempfile.gettempdir(), "pdf_translate")
os.makedirs(WORK_DIR, exist_ok=True)


@router.post("/start", response_model=StartTaskResponse)
async def start_pdf_translate(
    file: UploadFile = File(...),
    target_lang: str = Form("zh"),
    api_key: str = Form(...),
    base_url: str = Form("https://api.openai.com/v1"),
    model: str = Form("gpt-4o-mini"),
) -> StartTaskResponse:
    """接收 PDF，创建翻译任务，立即返回 task_id。"""
    if not api_key:
        raise HTTPException(status_code=400, detail="缺少 API Key")

    task = task_manager.create()
    # 保存上传文件
    upload_path = os.path.join(WORK_DIR, f"{task.id}_{file.filename}")
    with open(upload_path, "wb") as f:
        f.write(await file.read())

    config = LLMConfig(api_key=api_key, base_url=base_url, model=model)
    out_dir = os.path.join(WORK_DIR, task.id)

    # 后台执行翻译，把进度写入任务队列
    import asyncio

    async def _run() -> None:
        try:
            async for prog in pdf_service.translate_pdf(
                upload_path, out_dir, config, target_lang
            ):
                await task_manager.push(
                    task.id,
                    {
                        "progress": round(prog.progress, 4),
                        "message": prog.message,
                        "mode": prog.mode,
                        "done": prog.done,
                    },
                )
                if prog.done and prog.result_path:
                    task_manager.finish(task.id, result=prog.result_path)
        except Exception as e:  # noqa: BLE001
            await task_manager.push(
                task.id, {"progress": 1.0, "message": f"翻译失败: {e}", "done": True, "error": True}
            )
            task_manager.finish(task.id, error=str(e))

    asyncio.create_task(_run())
    return StartTaskResponse(task_id=task.id)


@router.get("/progress/{task_id}")
async def pdf_progress(task_id: str) -> StreamingResponse:
    """SSE 进度流。"""
    task = task_manager.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")

    async def event_gen():
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
async def pdf_result(task_id: str) -> FileResponse:
    """下载翻译后的 PDF。"""
    task = task_manager.get(task_id)
    if not task or not task.result:
        raise HTTPException(status_code=404, detail="结果不存在或未完成")
    if not os.path.exists(task.result):
        raise HTTPException(status_code=404, detail="结果文件已丢失")
    return FileResponse(
        task.result,
        media_type="application/pdf",
        filename=os.path.basename(task.result),
    )
