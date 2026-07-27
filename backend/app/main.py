"""FastAPI 应用入口。"""
from __future__ import annotations

import logging
import os

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api import translate, pdf_trans, summary, pdf_edit, pdf_annot, overlay_trans
from app.config import allowed_origins
from app.middlewares import BodySizeLimitMiddleware

# 后端不走系统代理，直连用户配置的 base_url。
# 避免 httpx 自动套用系统代理（Clash/V2Ray 等）导致 TLS 握手失败；
# pdf2zh 内部的 httpx/openai 客户端也读这些环境变量，一并清空。
for _k in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
           "http_proxy", "https_proxy", "all_proxy"):
    os.environ.pop(_k, None)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("app")

app = FastAPI(title="PDF 阅读翻译后端", version="0.2.2")

# 允许 Tauri / Vite 前端跨域访问（默认白名单在 app.config.allowed_origins）。
# 生产上如需临时放宽，可通过环境变量 ALLOWED_ORIGINS="a,b,c" 覆盖。
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins(),
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Accept", "Authorization", "x-llm-api-key"],
)

# 请求大小限制（默认 200MB，可通过 MAX_UPLOAD_BYTES 调整）。
app.add_middleware(BodySizeLimitMiddleware)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """兜底异常处理：返回结构化 JSON（detail 字段与前端约定一致），而非裸 500。"""
    logger.exception("未处理异常: %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={"detail": f"服务器内部错误: {exc.__class__.__name__}: {exc}"},
    )


app.include_router(translate.router)
app.include_router(pdf_trans.router)
app.include_router(summary.router)
app.include_router(pdf_edit.router)
app.include_router(pdf_annot.router)
app.include_router(overlay_trans.router)


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok"}
