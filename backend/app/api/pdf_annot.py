"""PDF 批注路由。

流程：open（上传 → 导入已有批注）→ 前端交互式增删改（实时同步会话）
→ save（把批注写入副本，另存 annotated.pdf）→ result 下载 / export 导出列表。
纯本地 PyMuPDF，无 LLM；会话隔离在 %TEMP%/pdf_annot/<annot_id>，原文件绝不被改。
"""
from __future__ import annotations

import asyncio
import os
import tempfile
import uuid
from typing import Any, Optional

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from app.services import pdf_annot_service as svc
from app.services.file_utils import cleanup_old_entries, scoped_path

router = APIRouter(prefix="/api/annot/pdf", tags=["pdf-annot"])

ANNOT_WORK_DIR = os.path.join(tempfile.gettempdir(), "pdf_annot")
os.makedirs(ANNOT_WORK_DIR, exist_ok=True)
cleanup_old_entries(ANNOT_WORK_DIR)


class AnnotationBody(BaseModel):
    id: Optional[str] = None
    page: int = 0
    type: str = "highlight"
    text: str = ""
    comment: str = ""
    color: str = "#ffd633"
    rect: Optional[list[float]] = None
    quads: Optional[list[list[float]]] = None
    ink: Optional[list[list[list[float]]]] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    source: Optional[str] = "user"
    xref: Optional[int] = None


class SaveRequest(BaseModel):
    annotations: list[AnnotationBody]


def _work(annot_id: str) -> str:
    if not annot_id.isalnum():
        raise HTTPException(status_code=400, detail="非法会话 ID")
    return scoped_path(ANNOT_WORK_DIR, annot_id)


def _require_session(annot_id: str) -> str:
    work = _work(annot_id)
    if not svc.has_source(work):
        raise HTTPException(
            status_code=404,
            detail="批注会话已失效（后端可能已重启或已清理），请重新打开批注",
        )
    return work


@router.post("/open")
async def open_pdf(file: UploadFile = File(...)) -> dict:
    """上传 PDF 建立批注会话；返回 annot_id、页尺寸与 PDF 内已有批注。"""
    annot_id = uuid.uuid4().hex
    work = _work(annot_id)
    try:
        svc.init_session_dir(work, await file.read())
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"保存上传文件失败：{e}")
    try:
        result = await asyncio.to_thread(svc.open_session, work)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(e))
    result["annot_id"] = annot_id
    return result


@router.get("/{annot_id}/annotations")
async def list_annotations(annot_id: str) -> dict:
    work = _require_session(annot_id)
    return {"annotations": svc.get_pdf_annotations(work)}


@router.post("/{annot_id}/annotations")
async def add_annotation(annot_id: str, body: AnnotationBody) -> dict:
    work = _require_session(annot_id)
    try:
        return svc.add_pdf_annotation(work, body.model_dump())
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"添加批注失败：{e}")


@router.put("/{annot_id}/annotations/{aid}")
async def update_annotation(annot_id: str, aid: str, body: dict[str, Any]) -> dict:
    work = _require_session(annot_id)
    try:
        return svc.update_pdf_annotation(work, aid, body)
    except KeyError:
        raise HTTPException(status_code=404, detail="批注不存在")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"更新批注失败：{e}")


@router.delete("/{annot_id}/annotations/{aid}")
async def delete_annotation(annot_id: str, aid: str) -> dict:
    work = _require_session(annot_id)
    return {"deleted": svc.delete_pdf_annotation(work, aid)}


@router.post("/{annot_id}/save")
async def save_annotated(annot_id: str, req: SaveRequest) -> dict:
    """把批注写入 PDF 副本，另存 annotated.pdf。body 带完整列表（前端为准）。"""
    work = _require_session(annot_id)
    annots = [a.model_dump() for a in req.annotations]
    try:
        return await asyncio.to_thread(svc.save_annotated_pdf, work, annots)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"批注保存失败，请重试：{e}")


@router.get("/{annot_id}/result")
async def download_result(annot_id: str) -> FileResponse:
    work = _require_session(annot_id)
    out = svc.output_pdf_path(work)
    if not os.path.exists(out):
        raise HTTPException(status_code=404, detail="批注结果不存在，请先保存")
    return FileResponse(out, media_type="application/pdf", filename="annotated.pdf")


@router.get("/{annot_id}/export")
async def export_annotations(annot_id: str, format: str = "json") -> Response:
    work = _require_session(annot_id)
    fmt = "markdown" if format.lower() in ("md", "markdown") else "json"
    content, media = svc.export_annotations(work, fmt)
    return Response(content=content, media_type=f"{media}; charset=utf-8")
