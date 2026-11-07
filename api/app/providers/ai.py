"""LLM provider adapters. The model only ever sees owner-scoped tool results and can only
call read-only tools; it has no way to write financial data."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Protocol

from ..core.config import Settings
from ..core.errors import AppError


@dataclass
class ToolCall:
    name: str
    args: dict


@dataclass
class Completion:
    text: str
    tool_calls: list[ToolCall] = field(default_factory=list)
    input_tokens: int | None = None
    output_tokens: int | None = None
    cached_tokens: int | None = None
    reasoning_tokens: int | None = None


class AIProvider(Protocol):
    name: str

    def complete(self, *, model: str, system: str, messages: list[dict], tools: list[dict], max_output: int) -> Completion: ...


class MockAIProvider:
    """Deterministic local provider: keyword intent → tool call, then templated answer.
    Reports token usage so quota metering is exercised end-to-end. Not a real model."""

    name = "mock"
    _INTENTS = [
        (r"overdue|बकाया|நிலுவை|late|due", "overdue_tenants"),
        (r"deposit|जमा|வைப்பு|అడ్వాన్స్|advance", "deposit_summary"),
        (r"collect|received|वसूल|வசூல்|this month", "collection_summary"),
        (r"remind|याद|நினைவூட்", "reminder_candidates"),
        (r"rent|किराया|வாடகை", "unit_lookup"),
        (r"history|payments|भुगतान", "payment_history"),
    ]

    def complete(self, *, model: str, system: str, messages: list[dict], tools: list[dict], max_output: int) -> Completion:
        m_tr = re.search(r"\[\[from=(\w+) to=(\w+)\]\]", system)
        if m_tr:     # translation request: not a real translation, just the text tagged with the target language (never used in production)
            body = re.sub(r"^\[[a-z]{2}\]\s*", "", messages[-1]["content"].strip())
            return Completion(f"[{m_tr.group(2)}] {body}", [], (len(system) + len(body)) // 3 + 10, len(body) // 3 + 5)
        last = messages[-1]
        prompt_chars = len(system) + sum(len(json.dumps(m, ensure_ascii=False)) for m in messages)
        if last["role"] == "user":
            q = last["content"].lower()
            for pattern, tool in self._INTENTS:
                if re.search(pattern, q):
                    args = {}
                    m = re.search(r"\b([A-Za-z]?-?\d+[A-Za-z]?)\b", last["content"])
                    if tool in ("unit_lookup", "deposit_summary", "payment_history") and m:
                        args = {"unit": m.group(1)}
                    return Completion("", [ToolCall(tool, args)], prompt_chars // 3 + 20, 15)
            return Completion("I can answer questions about collections, dues, deposits and reminders.", [],
                              prompt_chars // 3 + 20, 20)
        result = last["content"]
        text = "Here is what I found:\n" + _summarise(result)
        return Completion(text[: max_output * 3], [], prompt_chars // 3 + 20, min(max_output, len(text) // 3 + 5))


def _summarise(tool_json: str) -> str:
    try:
        data = json.loads(tool_json)
    except json.JSONDecodeError:
        return tool_json
    if isinstance(data, dict) and "rows" in data:
        lines = [", ".join(f"{k}: {v}" for k, v in r.items()) for r in data["rows"][:10]]
        return "\n".join(lines) or "Nothing found."
    return ", ".join(f"{k}: {v}" for k, v in data.items()) if isinstance(data, dict) else str(data)


class BedrockProvider:
    """Amazon Bedrock Converse API in ap-south-1. Model ids come from settings; confirm model
    availability, cross-region inference profile and pricing in your account before enabling."""

    name = "bedrock"

    def __init__(self, region: str, model_map: dict[str, str]) -> None:
        import boto3
        self.client = boto3.client("bedrock-runtime", region_name=region)
        self.model_map = model_map

    def complete(self, *, model: str, system: str, messages: list[dict], tools: list[dict], max_output: int) -> Completion:
        model_id = self.model_map.get(model)
        if not model_id:
            raise AppError("AI_MODEL_NOT_ALLOWED", "model not mapped")
        conv = []
        for m in messages:
            if m["role"] == "tool":
                conv.append({"role": "user", "content": [{"toolResult": {"toolUseId": m["tool_use_id"],
                                                                          "content": [{"text": m["content"]}]}}]})
            elif m["role"] == "assistant_tool":
                conv.append({"role": "assistant", "content": [{"toolUse": {"toolUseId": m["tool_use_id"],
                                                                            "name": m["name"], "input": m["args"]}}]})
            else:
                conv.append({"role": m["role"], "content": [{"text": m["content"]}]})
        kwargs: dict = {"modelId": model_id, "system": [{"text": system}], "messages": conv,
                        "inferenceConfig": {"maxTokens": max_output, "temperature": 0}}
        if tools:
            kwargs["toolConfig"] = {"tools": [{"toolSpec": {"name": t["name"], "description": t["description"],
                                                            "inputSchema": {"json": t["parameters"]}}} for t in tools]}
        r = self.client.converse(**kwargs)
        usage = r.get("usage", {})
        out = Completion("", [], usage.get("inputTokens"), usage.get("outputTokens"), usage.get("cacheReadInputTokens"))
        for block in r["output"]["message"]["content"]:
            if "text" in block:
                out.text += block["text"]
            if "toolUse" in block:
                out.tool_calls.append(ToolCall(block["toolUse"]["name"], block["toolUse"].get("input", {})))
                out.tool_calls[-1].args["_id"] = block["toolUse"]["toolUseId"]
        return out


def get_ai_provider(s: Settings) -> AIProvider:
    if not s.ai_enabled:
        raise AppError("AI_DISABLED", "AI assistant is turned off")
    if s.ai_provider == "mock":
        return MockAIProvider()
    if s.ai_provider == "bedrock":
        return BedrockProvider(s.aws_region, s.ai_bedrock_model_map)
    raise AppError("AI_DISABLED", "unknown AI provider")
