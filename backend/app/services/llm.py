"""统一 LLM 调用层，兼容 OpenAI-compatible API。

设计要点：
- 所有配置（api_key / base_url / model）来自请求，绝不写死。
- 提供普通调用与流式调用两种模式。
- 通过强约束的 system prompt 抑制模型编造：不确定的信息必须显式标注
  「原文未明确说明」，而不是凭空生成。
"""
from __future__ import annotations

import json
from typing import AsyncGenerator

import httpx

from app.models.schemas import LLMConfig


# 抑制幻觉的通用指令，追加到所有 system prompt 后
ANTI_HALLUCINATION = (
    "严格要求：只依据用户提供的原文作答，不得编造、不得补充原文没有的信息。"
    "若某项信息在原文中无法找到或不确定，必须原样输出「原文未明确说明」，"
    "禁止猜测或杜撰。"
)

SUMMARY_HEADINGS = "## 研究问题\n## 方法\n## 主要贡献\n## 实验结果\n## 结论\n## 局限性\n## 中文摘要"


class LLMError(Exception):
    """LLM 调用相关错误。"""


class LLMService:
    """OpenAI-compatible Chat Completions 封装。"""

    def __init__(self, config: LLMConfig):
        if not config.api_key:
            raise LLMError("未配置 API Key")
        self.config = config
        self._base = config.base_url.rstrip("/")

    @property
    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.config.api_key}",
            "Content-Type": "application/json",
        }

    async def chat(
        self,
        messages: list[dict],
        temperature: float = 0.2,
        timeout: float = 120.0,
    ) -> str:
        """非流式调用，返回完整文本。"""
        payload = {
            "model": self.config.model,
            "messages": messages,
            "temperature": temperature,
            "stream": False,
        }
        url = f"{self._base}/chat/completions"
        async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
            resp = await client.post(url, headers=self._headers, json=payload)
            if resp.status_code != 200:
                raise LLMError(f"LLM 返回 {resp.status_code}: {resp.text[:200]}")
            data = resp.json()
            try:
                return data["choices"][0]["message"]["content"]
            except (KeyError, IndexError) as e:
                raise LLMError(f"LLM 响应格式异常: {e}")

    async def chat_stream(
        self,
        messages: list[dict],
        temperature: float = 0.2,
        timeout: float = 300.0,
    ) -> AsyncGenerator[str, None]:
        """流式调用，逐段 yield 文本增量。"""
        payload = {
            "model": self.config.model,
            "messages": messages,
            "temperature": temperature,
            "stream": True,
        }
        url = f"{self._base}/chat/completions"
        async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
            async with client.stream(
                "POST", url, headers=self._headers, json=payload
            ) as resp:
                if resp.status_code != 200:
                    body = await resp.aread()
                    raise LLMError(
                        f"LLM 返回 {resp.status_code}: {body.decode('utf-8', 'ignore')[:200]}"
                    )
                async for line in resp.aiter_lines():
                    if not line or not line.startswith("data:"):
                        continue
                    chunk = line[len("data:"):].strip()
                    if chunk == "[DONE]":
                        break
                    try:
                        obj = json.loads(chunk)
                        delta = obj["choices"][0]["delta"].get("content")
                        if delta:
                            yield delta
                    except (json.JSONDecodeError, KeyError, IndexError):
                        continue

    # -------- 高层业务方法 --------

    async def translate(
        self, text: str, target_lang: str = "中文", source_lang: str = "auto"
    ) -> str:
        """翻译单段文本。保持术语与公式符号，不擅自增删。"""
        system = (
            f"你是专业的学术文献翻译。将用户提供的{source_lang}文本忠实翻译为{target_lang}。"
            "要求：保留专业术语、数学符号、公式、引用标记；只翻译不解释；"
            "不添加原文没有的内容。" + ANTI_HALLUCINATION
        )
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": text},
        ]
        return await self.chat(messages)

    def build_summary_messages(self, full_text: str) -> list[dict]:
        """构造文献总结的消息。要求结构化、可控、不编造。"""
        system = (
            "你是严谨的学术论文分析助手。请依据用户提供的论文全文，"
            "输出结构化中文总结，使用如下 Markdown 小标题，缺失项写「原文未明确说明」：\n"
            f"{SUMMARY_HEADINGS}\n" + ANTI_HALLUCINATION
        )
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": f"论文全文如下：\n\n{full_text}"},
        ]
        return messages

    async def summary_stream(self, full_text: str) -> AsyncGenerator[str, None]:
        """流式生成结构化总结。长文先分块提炼，再汇总。"""
        chunks = _chunk_text(full_text, max_chars=28000)
        if len(chunks) == 1:
            async for delta in self.chat_stream(
                self.build_summary_messages(chunks[0]), temperature=0.2
            ):
                yield delta
            return

        notes: list[str] = []
        for idx, chunk in enumerate(chunks, start=1):
            notes.append(
                await self.chat(
                    self.build_chunk_summary_messages(chunk, idx, len(chunks)),
                    temperature=0.1,
                    timeout=180.0,
                )
            )

        notes = await self.compact_summary_notes(notes)

        async for delta in self.chat_stream(
            self.build_final_summary_messages(notes), temperature=0.2, timeout=300.0
        ):
            yield delta

    def build_chunk_summary_messages(self, chunk: str, index: int, total: int) -> list[dict]:
        """构造长文分块证据笔记的消息。"""
        system = (
            "你是严谨的学术论文分析助手。请只依据当前分段，提取可用于最终总结的证据笔记。"
            "按研究问题、方法、主要贡献、实验结果、结论、局限性、摘要要点组织；"
            "当前分段没有的信息写「原文未明确说明」。" + ANTI_HALLUCINATION
        )
        user = (
            f"这是论文全文按顺序切分后的第 {index}/{total} 段。"
            "请输出简洁中文证据笔记，不要写最终总结。\n\n"
            f"{chunk}"
        )
        return [{"role": "system", "content": system}, {"role": "user", "content": user}]

    async def compact_summary_notes(self, notes: list[str]) -> list[str]:
        """Compress intermediate notes if they would make the final prompt too large."""
        while len("\n\n".join(notes)) > 48000 and len(notes) > 1:
            reduced: list[str] = []
            for start in range(0, len(notes), 4):
                group = notes[start:start + 4]
                reduced.append(
                    await self.chat(
                        self.build_notes_reduce_messages(group, start // 4 + 1),
                        temperature=0.1,
                        timeout=180.0,
                    )
                )
            notes = reduced
        return notes

    def build_notes_reduce_messages(self, notes: list[str], group_index: int) -> list[dict]:
        """Construct a prompt that compresses several evidence-note chunks."""
        system = (
            "你是严谨的学术论文分析助手。请合并多段证据笔记，保留具体方法、结果、贡献和局限性，"
            "删除重复信息；不得加入笔记没有的信息。" + ANTI_HALLUCINATION
        )
        joined = "\n\n".join(
            f"### 待合并笔记 {i}\n{note}" for i, note in enumerate(notes, start=1)
        )
        user = f"这是第 {group_index} 组分段证据笔记，请压缩合并：\n\n{joined}"
        return [{"role": "system", "content": system}, {"role": "user", "content": user}]

    def build_final_summary_messages(self, notes: list[str]) -> list[dict]:
        """构造长文最终汇总消息。"""
        system = (
            "你是严谨的学术论文分析助手。请依据按原文顺序整理的分段证据笔记，"
            "输出结构化中文总结，使用如下 Markdown 小标题，缺失项写「原文未明确说明」：\n"
            f"{SUMMARY_HEADINGS}\n" + ANTI_HALLUCINATION
        )
        joined = "\n\n".join(
            f"### 分段笔记 {i}\n{note}" for i, note in enumerate(notes, start=1)
        )
        return [
            {"role": "system", "content": system},
            {"role": "user", "content": f"分段证据笔记如下：\n\n{joined}"},
        ]


def _chunk_text(text: str, max_chars: int) -> list[str]:
    """Split text by paragraphs while respecting a soft character limit."""
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    if not paragraphs:
        return [text]

    chunks: list[str] = []
    current: list[str] = []
    current_len = 0

    def flush() -> None:
        nonlocal current, current_len
        if current:
            chunks.append("\n\n".join(current))
            current = []
            current_len = 0

    for para in paragraphs:
        if len(para) > max_chars:
            flush()
            for start in range(0, len(para), max_chars):
                chunks.append(para[start:start + max_chars])
            continue
        next_len = current_len + len(para) + (2 if current else 0)
        if next_len > max_chars:
            flush()
        current.append(para)
        current_len += len(para) + (2 if current_len else 0)
    flush()
    return chunks


async def test_config(config: LLMConfig) -> tuple[bool, str]:
    """测试配置是否可用，返回 (ok, message)。"""
    try:
        svc = LLMService(config)
        reply = await svc.chat(
            [{"role": "user", "content": "回复 OK 两个字符即可"}],
            timeout=30.0,
        )
        return True, f"连接成功，模型返回: {reply[:50]}"
    except LLMError as e:
        return False, str(e)
    except Exception as e:  # noqa: BLE001
        return False, f"连接失败: {e}"
