"""文献总结路由（提取全文 + 流式 LLM 输出）。"""
from __future__ import annotations

import json
import os
import tempfile
import uuid

from fastapi import APIRouter, File, Header, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

from app.models.schemas import LLMConfig
from app.services import pdf_service
from app.services.file_utils import (
    cleanup_old_entries,
    remove_path,
    safe_pdf_filename,
    scoped_path,
)
from app.services.llm import LLMService, LLMError

router = APIRouter(prefix="/api/summary", tags=["summary"])

WORK_DIR = os.path.join(tempfile.gettempdir(), "pdf_summary")
os.makedirs(WORK_DIR, exist_ok=True)
cleanup_old_entries(WORK_DIR)


@router.post("/stream")
async def summary_stream(
    file: UploadFile = File(...),
    api_key: str = Header("", alias="x-llm-api-key"),
    base_url: str = Header("https://api.openai.com/v1", alias="x-llm-base-url"),
    model: str = Header("gpt-4o-mini", alias="x-llm-model"),
) -> StreamingResponse:
    """一次性接收 PDF，提取全文后流式返回结构化中文总结。"""
    if not api_key:
        raise HTTPException(status_code=400, detail="缺少 API Key")

    safe_name = safe_pdf_filename(file.filename)
    tmp_path = scoped_path(WORK_DIR, f"{uuid.uuid4().hex}_{safe_name}")
    with open(tmp_path, "wb") as f:
        f.write(await file.read())

    try:
        full_text = pdf_service.extract_text(tmp_path)
    except Exception as e:  # noqa: BLE001
        remove_path(tmp_path)
        raise HTTPException(status_code=500, detail=f"PDF 文本提取失败: {e}")

    if not full_text.strip():
        remove_path(tmp_path)
        raise HTTPException(
            status_code=422,
            detail="未能从 PDF 提取到文本（可能是扫描件），无法总结",
        )

    config = LLMConfig(api_key=api_key, base_url=base_url, model=model)
    svc = LLMService(config)

    async def event_gen():
        try:
            async for delta in svc.summary_stream(full_text):
                yield f"data: {json.dumps({'delta': delta}, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps({'done': True}, ensure_ascii=False)}\n\n"
        except LLMError as e:
            yield f"data: {json.dumps({'error': str(e), 'done': True}, ensure_ascii=False)}\n\n"
        finally:
            remove_path(tmp_path)

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )
