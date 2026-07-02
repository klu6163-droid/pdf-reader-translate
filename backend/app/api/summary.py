"""文献总结路由（提取全文 + 流式 LLM 输出）。"""
from __future__ import annotations

import json
import os
import tempfile

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

from app.models.schemas import LLMConfig
from app.services import pdf_service
from app.services.llm import LLMService, LLMError

router = APIRouter(prefix="/api/summary", tags=["summary"])

WORK_DIR = os.path.join(tempfile.gettempdir(), "pdf_summary")
os.makedirs(WORK_DIR, exist_ok=True)


@router.post("/stream")
async def summary_stream(
    file: UploadFile = File(...),
    api_key: str = Form(...),
    base_url: str = Form("https://api.openai.com/v1"),
    model: str = Form("gpt-4o-mini"),
) -> StreamingResponse:
    """一次性接收 PDF，提取全文后流式返回结构化中文总结。"""
    if not api_key:
        raise HTTPException(status_code=400, detail="缺少 API Key")

    # 保存并提取文本
    tmp_path = os.path.join(WORK_DIR, file.filename or "upload.pdf")
    with open(tmp_path, "wb") as f:
        f.write(await file.read())

    try:
        full_text = pdf_service.extract_text(tmp_path)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"PDF 文本提取失败: {e}")

    if not full_text.strip():
        raise HTTPException(
            status_code=422,
            detail="未能从 PDF 提取到文本（可能是扫描件），无法总结",
        )

    config = LLMConfig(api_key=api_key, base_url=base_url, model=model)
    svc = LLMService(config)
    messages = svc.build_summary_messages(full_text)

    async def event_gen():
        try:
            async for delta in svc.chat_stream(messages, temperature=0.2):
                yield f"data: {json.dumps({'delta': delta}, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps({'done': True}, ensure_ascii=False)}\n\n"
        except LLMError as e:
            yield f"data: {json.dumps({'error': str(e), 'done': True}, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )
