"""FastAPI 应用入口。"""
from __future__ import annotations

import logging
import os

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api import diagnostics, overlay_trans, pdf_annot, pdf_edit, pdf_trans, summary, translate
from app.config import allowed_origins
from app.middlewares import BodySizeLimitMiddleware

# 后端不走系统代理，直连用户配置的 base_url。
# 避免 httpx 自动套用系统代理（Clash/V2Ray 等）导致 TLS 握手失败；
# pdf2zh 内部的 httpx/openai 客户端也读这些环境变量，一并清空。
for _k in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
           "http_proxy", "https_proxy", "all_proxy"):
    os.environ.pop(_k, None)

logger = logging.getLogger("app")

app = FastAPI(title="PDF 阅读翻译后端", version="0.2.2")

# 请求大小限制（默认 200MB，可通过 MAX_UPLOAD_BYTES 调整）。
# ⚠️ 必须先于 CORS 注册：Starlette add_middleware 用 insert(0)，后注册的在最外层。
# 若 CORS 在内层，BodySizeLimit 返回的 413 不带 CORS 头，浏览器会拦截，
# 前端读不到「上传内容过大」提示而误报「无法连接」。
app.add_middleware(BodySizeLimitMiddleware)

# 允许 Tauri / Vite 前端跨域访问（默认白名单在 app.config.allowed_origins）。
# 生产上如需临时放宽，可通过环境变量 ALLOWED_ORIGINS="a,b,c" 覆盖。
# allow_methods 必须含 PUT（批注更新 pdf_annot.py 用 @router.put）；
# allow_headers 必须含全部 x-llm-* 头（pdf_trans/overlay_trans/summary 共用），
# 否则预检拦截 -> 三大翻译功能全挂。
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins(),
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=[
        "Content-Type",
        "Accept",
        "Authorization",
        "x-llm-api-key",
        "x-llm-base-url",
        "x-llm-model",
        "x-llm-max-concurrency",
        "x-llm-request-interval-ms",
        "x-llm-max-retries",
        "x-llm-retry-base-seconds",
    ],
)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """兜底异常处理：返回结构化 JSON（detail 字段与前端约定一致），而非裸 500。

    不回传 exc 详情，避免泄漏内部路径/依赖；完整 traceback 已由 logger.exception 落日志。
    """
    logger.exception("未处理异常: %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={"detail": "服务器内部错误"},
    )


app.include_router(translate.router)
app.include_router(pdf_trans.router)
app.include_router(summary.router)
app.include_router(pdf_edit.router)
app.include_router(pdf_annot.router)
app.include_router(overlay_trans.router)
app.include_router(diagnostics.router)


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok"}
