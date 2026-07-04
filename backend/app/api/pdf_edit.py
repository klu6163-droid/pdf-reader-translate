"""PDF 文本块编辑路由。

流程：analyze（上传 → 解析文本块）→ 前端编辑 → save（应用编辑，另存新 PDF）→ result（下载）。
编辑不涉及 LLM，纯本地 PyMuPDF；所有产物写在按 edit_id 隔离的临时子目录里，绝不覆盖原文件。
"""
from __future__ import annotations

import asyncio
import os
import tempfile
import uuid
from typing import Optional

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.services import pdf_edit_service
from app.services.file_utils import cleanup_old_entries, scoped_path

router = APIRouter(prefix="/api/edit/pdf", tags=["pdf-edit"])

# 编辑用临时目录：%TEMP%/pdf_edit/<edit_id>/{source.pdf, edited.pdf}
EDIT_WORK_DIR = os.path.join(tempfile.gettempdir(), "pdf_edit")
os.makedirs(EDIT_WORK_DIR, exist_ok=True)
cleanup_old_entries(EDIT_WORK_DIR)


class EditOp(BaseModel):
    id: str
    text: Optional[str] = None
    bbox: Optional[list[float]] = None
    size: Optional[float] = None
    color: Optional[str] = None
    deleted: Optional[bool] = False


class SaveEditsRequest(BaseModel):
    edit_id: str
    edits: list[EditOp]


def _edit_dir(edit_id: str) -> str:
    # scoped_path 会校验不越界；edit_id 只应是我们生成的 hex
    return scoped_path(EDIT_WORK_DIR, edit_id)


@router.post("/analyze")
async def analyze(file: UploadFile = File(...)) -> dict:
    """上传 PDF，解析每页文本块，返回 edit_id + 文本块 + 预测编辑模式。"""
    edit_id = uuid.uuid4().hex
    work = _edit_dir(edit_id)
    os.makedirs(work, exist_ok=True)
    source = os.path.join(work, "source.pdf")
    try:
        with open(source, "wb") as f:
            f.write(await file.read())
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"保存上传文件失败：{e}")

    try:
        result = await asyncio.to_thread(pdf_edit_service.analyze_pdf, source)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(e))

    result["edit_id"] = edit_id
    return result


@router.post("/save")
async def save(req: SaveEditsRequest) -> dict:
    """应用编辑并另存为新 PDF。返回实际编辑模式与友好提示。"""
    work = _edit_dir(req.edit_id)
    source = os.path.join(work, "source.pdf")
    if not os.path.exists(source):
        raise HTTPException(
            status_code=404,
            detail="编辑会话已失效（后端可能已重启或已清理），请重新打开 PDF 进入编辑",
        )
    out_path = os.path.join(work, "edited.pdf")
    edits = [e.model_dump() for e in req.edits]
    try:
        result = await asyncio.to_thread(
            pdf_edit_service.apply_edits, source, edits, out_path
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"保存编辑失败：{e}")

    result["edit_id"] = req.edit_id
    result["ok"] = True
    return result


@router.get("/result/{edit_id}")
async def result(edit_id: str) -> FileResponse:
    """下载编辑后的新 PDF。"""
    work = _edit_dir(edit_id)
    out_path = os.path.join(work, "edited.pdf")
    if not os.path.exists(out_path):
        raise HTTPException(status_code=404, detail="编辑结果不存在或已清理，请重新保存")
    return FileResponse(
        out_path, media_type="application/pdf", filename="edited.pdf"
    )
