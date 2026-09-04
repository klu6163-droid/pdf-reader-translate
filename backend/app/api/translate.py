"""文本翻译 / 配置测试路由。"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from app.models.schemas import (
    TextTranslateRequest,
    TextTranslateResponse,
    TermsExplainRequest,
    TermsExplainResponse,
    TestConfigRequest,
    TestConfigResponse,
)
from app.services.llm import LLMService, LLMError, test_config
from app.services.diagnostics import start_translation

router = APIRouter(prefix="/api", tags=["translate"])
logger = logging.getLogger("app.translate")


@router.post("/translate/text", response_model=TextTranslateResponse)
async def translate_text(req: TextTranslateRequest) -> TextTranslateResponse:
    """划词 / 划段落翻译。"""
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="待翻译文本为空")
    trace = start_translation("text")
    try:
        svc = LLMService(req.config)
        translated = await svc.translate(
            text, target_lang=req.target_lang, source_lang=req.source_lang
        )
    except LLMError as e:
        trace.finish(False)
        # 不记录原文、API Key 或 Base URL；保留模型和上游错误正文供诊断包定位。
        logger.warning(
            "text translation failed model=%s error_type=%s error=%s",
            req.config.model,
            type(e).__name__,
            e,
        )
        raise HTTPException(status_code=502, detail=str(e))
    except Exception:
        trace.finish(False)
        raise
    trace.finish(True)
    return TextTranslateResponse(
        original=text, translated=translated, model=req.config.model
    )


@router.post("/translate/terms", response_model=TermsExplainResponse)
async def explain_terms(req: TermsExplainRequest) -> TermsExplainResponse:
    """专业术语解释；由本地后端代理调用上游 LLM。"""
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="待解释文本为空")
    try:
        terms = await LLMService(req.config).explain_terms(text)
    except LLMError as e:
        # 不记录原文、API Key 或 Base URL；保留模型与上游错误便于诊断。
        logger.warning(
            "terms explanation failed model=%s error_type=%s error=%s",
            req.config.model,
            type(e).__name__,
            e,
        )
        raise HTTPException(status_code=502, detail=str(e))
    return TermsExplainResponse(terms=terms, model=req.config.model)


@router.post("/settings/test", response_model=TestConfigResponse)
async def settings_test(req: TestConfigRequest) -> TestConfigResponse:
    """测试 API 配置是否可用。"""
    ok, msg = await test_config(req.config)
    return TestConfigResponse(ok=ok, message=msg)
