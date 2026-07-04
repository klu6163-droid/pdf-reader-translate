"""PDF 编辑导出路由。与翻译路由独立，无需 API Key。"""
from __future__ import annotations

import json

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import Response

from app.services.edit_service import apply_edits

router = APIRouter(prefix="/api/pdf/edit", tags=["pdf-edit"])


@router.post("/export")
async def export_edited_pdf(
    file: UploadFile = File(...),
    edits: str = Form(...),
) -> Response:
    """接收原 PDF + EditState JSON，返回应用编辑后的 PDF 字节。"""
    pdf_bytes = await file.read()
    try:
        edits_obj = json.loads(edits)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=400, detail=f"edits JSON 解析失败: {e}")
    try:
        out_bytes = apply_edits(pdf_bytes, edits_obj)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"应用编辑失败: {e}")
    return Response(content=out_bytes, media_type="application/pdf")
