"""Pydantic 数据模型定义。"""
from __future__ import annotations

from typing import Literal, Optional
from pydantic import BaseModel, Field


class LLMConfig(BaseModel):
    """OpenAI-compatible LLM 配置。API Key 由前端每次请求携带，绝不写死。"""

    api_key: str = Field(..., description="API 密钥")
    base_url: str = Field(
        default="https://api.openai.com/v1",
        description="OpenAI-compatible Base URL",
    )
    model: str = Field(default="gpt-4o-mini", description="模型名称")
    max_concurrency: int = Field(
        default=1,
        ge=1,
        le=8,
        description="同一配置允许同时发出的最大 LLM 请求数",
    )
    request_interval_ms: int = Field(
        default=1100,
        ge=0,
        le=60000,
        description="相邻 LLM 请求开始时间的最小间隔（毫秒）",
    )
    max_retries: int = Field(
        default=5,
        ge=0,
        le=10,
        description="收到 HTTP 429 后的最大重试次数",
    )
    retry_base_seconds: float = Field(
        default=2.0,
        ge=0.1,
        le=60.0,
        description="HTTP 429 指数退避的初始等待秒数",
    )


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


class TermsExplainRequest(BaseModel):
    """术语解释请求；通过本地后端代理，不由浏览器直连上游。"""

    text: str = Field(..., max_length=4000, description="待识别专业术语的原文")
    config: LLMConfig


class TermsExplainResponse(BaseModel):
    terms: str
    model: str


class StartTaskResponse(BaseModel):
    task_id: str


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


class EditBlock(BaseModel):
    id: str
    page: int
    text: str
    bbox: list[float]
    font: str
    size: float
    color: str
    bold: bool
    italic: bool


class EditPage(BaseModel):
    page: int
    width: float
    height: float
    blocks: list[EditBlock]


class AnalyzePdfResponse(BaseModel):
    edit_id: str
    mode: Literal["text", "compatible"]
    mode_label: str
    page_count: int
    pages: list[EditPage]


class SaveEditsResponse(BaseModel):
    ok: bool
    edit_id: str
    mode: Literal["text", "compatible"]
    mode_label: str
    edited: int
    message: str


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


class AnnotationPatch(BaseModel):
    page: Optional[int] = None
    type: Optional[str] = None
    text: Optional[str] = None
    comment: Optional[str] = None
    color: Optional[str] = None
    rect: Optional[list[float]] = None
    quads: Optional[list[list[float]]] = None
    ink: Optional[list[list[list[float]]]] = None


class AnnotationResponse(AnnotationBody):
    id: str
    type: Literal[
        "highlight", "underline", "strikeout", "note", "rectangle", "ink"
    ]
    source: Optional[Literal["user", "pdf"]]


class SaveAnnotationsRequest(BaseModel):
    annotations: list[AnnotationBody]


class AnnotationPage(BaseModel):
    page: int
    width: float
    height: float


class OpenAnnotationsResponse(BaseModel):
    annot_id: str
    page_count: int
    pages: list[AnnotationPage]
    annotations: list[AnnotationResponse]


class AnnotationListResponse(BaseModel):
    annotations: list[AnnotationResponse]


class DeleteAnnotationResponse(BaseModel):
    deleted: bool


class SaveAnnotationsResponse(BaseModel):
    ok: bool
    written: int
    skipped: int
    deleted_existing: int
    message: str


class SummaryResult(BaseModel):
    """文献结构化总结。字段缺失时用固定占位说明，不允许模型编造。"""

    research_question: str = Field(default="", description="研究问题")
    methods: str = Field(default="", description="方法")
    contributions: str = Field(default="", description="主要贡献")
    experiments: str = Field(default="", description="实验结果")
    conclusion: str = Field(default="", description="结论")
    limitations: str = Field(default="", description="局限性")
    abstract_zh: str = Field(default="", description="中文摘要")
