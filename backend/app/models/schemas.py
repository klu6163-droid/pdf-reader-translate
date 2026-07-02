"""Pydantic 数据模型定义。"""
from __future__ import annotations

from typing import Optional
from pydantic import BaseModel, Field


class LLMConfig(BaseModel):
    """OpenAI-compatible LLM 配置。API Key 由前端每次请求携带，绝不写死。"""

    api_key: str = Field(..., description="API 密钥")
    base_url: str = Field(
        default="https://api.openai.com/v1",
        description="OpenAI-compatible Base URL",
    )
    model: str = Field(default="gpt-4o-mini", description="模型名称")


class TextTranslateRequest(BaseModel):
    """划词 / 划段落翻译请求。"""

    text: str = Field(..., description="待翻译文本")
    source_lang: str = Field(default="auto", description="源语言")
    target_lang: str = Field(default="中文", description="目标语言")
    config: LLMConfig


class TextTranslateResponse(BaseModel):
    original: str
    translated: str
    model: str


class TestConfigRequest(BaseModel):
    config: LLMConfig


class TestConfigResponse(BaseModel):
    ok: bool
    message: str


class StartTaskResponse(BaseModel):
    task_id: str


class SummaryResult(BaseModel):
    """文献结构化总结。字段缺失时用固定占位说明，不允许模型编造。"""

    research_question: str = Field(default="", description="研究问题")
    methods: str = Field(default="", description="方法")
    contributions: str = Field(default="", description="主要贡献")
    experiments: str = Field(default="", description="实验结果")
    conclusion: str = Field(default="", description="结论")
    limitations: str = Field(default="", description="局限性")
    abstract_zh: str = Field(default="", description="中文摘要")
