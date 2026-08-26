"""Safe, metadata-only diagnostic status endpoint."""
from __future__ import annotations

from fastapi import APIRouter, Request

from app.services.diagnostics import backend_status_snapshot

router = APIRouter(prefix="/api/diagnostics", tags=["diagnostics"])


@router.get("/status")
async def diagnostic_status(request: Request) -> dict[str, object]:
    return backend_status_snapshot(request.app.version)
