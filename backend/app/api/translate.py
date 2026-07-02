"""文本翻译 / 配置测试路由。"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.models.schemas import (
    TextTranslateRequest,
    TextTranslateResponse,
    TestConfigRequest,
    TestConfigResponse,
)
from app.services.llm import LLMService, LLMError, test_config

router = APIRouter(prefix="/api", tags=["translate"])


@router.post("/translate/text", response_model=TextTranslateResponse)
async def translate_text(req: TextTranslateRequest) -> TextTranslateResponse:
    """划词 / 划段落翻译。"""
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="待翻译文本为空")
    try:
        svc = LLMService(req.config)
        translated = await svc.translate(
            text, target_lang=req.target_lang, source_lang=req.source_lang
        )
    except LLMError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return TextTranslateResponse(
        original=text, translated=translated, model=req.config.model
    )


@router.post("/settings/test", response_model=TestConfigResponse)
async def settings_test(req: TestConfigRequest) -> TestConfigResponse:
    """测试 API 配置是否可用。"""
    ok, msg = await test_config(req.config)
    return TestConfigResponse(ok=ok, message=msg)
