"""结构化翻译路由（长任务 + SSE 进度 + JSON 结果 + MD/PDF 导出）。"""
from __future__ import annotations

import asyncio
import json
import os
import tempfile

from fastapi import APIRouter, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse, StreamingResponse

from app.models.schemas import LLMConfig, StartTaskResponse
from app.services import structtrans_service as ss
from app.services.file_utils import (
    cleanup_later,
    cleanup_old_entries,
    safe_pdf_filename,
    scoped_path,
)
from app.services.task_manager import task_manager

router = APIRouter(prefix="/api/structtrans/pdf", tags=["struct-translate"])

# 上传与结果的临时目录
WORK_DIR = os.path.join(tempfile.gettempdir(), "pdf_structtrans")
os.makedirs(WORK_DIR, exist_ok=True)
cleanup_old_entries(WORK_DIR)


@router.post("/start", response_model=StartTaskResponse)
async def start_struct_translate(
    file: UploadFile = File(...),
    target_lang: str = Form("zh"),
    api_key: str = Header("", alias="x-llm-api-key"),
    base_url: str = Header("https://api.openai.com/v1", alias="x-llm-base-url"),
    model: str = Header("gpt-4o-mini", alias="x-llm-model"),
) -> StartTaskResponse:
    """接收 PDF，创建结构化翻译任务，立即返回 task_id。"""
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
            async for prog in ss.translate_structured(
                upload_path, out_dir, config, target_lang
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
            msg = f"结构化翻译失败: {e}"
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
async def struct_progress(task_id: str) -> StreamingResponse:
    """SSE 进度流。"""
    task = task_manager.get(task_id)

    async def event_gen():
        if not task:
            event = {
                "progress": 1.0,
                "message": "任务不存在或已清理（后端可能已重启），请重新发起结构化翻译",
                "done": True,
                "error": True,
            }
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
            return

        if task.finished:
            event = task.last_event or {
                "progress": 1.0,
                "message": task.error or "结构化翻译完成",
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


def _load_blocks_from_result(task):
    """从 task.result（blocks.json 路径）读取并重建 StructBlock 列表 + 原始 JSON。"""
    if not task or not task.result or not os.path.exists(task.result):
        raise HTTPException(
            status_code=404,
            detail="结果不存在或已清理，请重新发起结构化翻译",
        )
    with open(task.result, "r", encoding="utf-8") as f:
        data = json.load(f)
    blocks = [
        ss.StructBlock(
            page=b["page"],
            block_id=b["block_id"],
            bbox=tuple(b["bbox"]),
            type=b["type"],
            source_text=b["source_text"],
            translated_text=b.get("translated_text", ""),
        )
        for b in data.get("blocks", [])
    ]
    return blocks, data


@router.get("/result/{task_id}")
async def struct_result(task_id: str):
    """返回结构化翻译 JSON（blocks 列表）。"""
    task = task_manager.get(task_id)
    if not task:
        raise HTTPException(
            status_code=404, detail="任务不存在或已清理，请重新发起结构化翻译"
        )
    _, data = _load_blocks_from_result(task)
    return data


@router.get("/export/{task_id}")
async def struct_export(task_id: str, format: str = Query("md")):
    """导出 Markdown（text）或重排中文 PDF（file）。"""
    task = task_manager.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在或已清理")
    blocks, data = _load_blocks_from_result(task)
    source_name = data.get("source_name", "translated.pdf")
    base = os.path.splitext(source_name)[0]

    if format == "md":
        md = ss.to_markdown(blocks, source_name)
        return PlainTextResponse(
            md,
            media_type="text/markdown; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{base}-zh.md"'},
        )
    if format == "pdf":
        out_path = scoped_path(WORK_DIR, f"{task_id}_export.pdf")
        ss.to_pdf(blocks, source_name, out_path)
        return FileResponse(
            out_path, media_type="application/pdf", filename=f"{base}-zh.pdf"
        )
    raise HTTPException(status_code=400, detail="format 只支持 md 或 pdf")
