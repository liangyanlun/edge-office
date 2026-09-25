from __future__ import annotations

import json
import re
from typing import Any

from ..inference import InferenceAdapter
from .contracts import PptPatch, parse_ppt_calls


class PptPlanner:
    def __init__(self, inference: InferenceAdapter):
        self.inference = inference

    def capability(self) -> dict[str, Any]:
        status = self.inference.status()
        name = str(status.get("name") or "")
        billions = _model_billions(name)
        recommended = billions is not None and billions >= 4.0
        warning = None
        if billions is None:
            warning = "无法识别当前模型参数规模；PPT 编辑建议使用已专项训练并通过评测的 4B 或更大模型。"
        elif billions < 4.0:
            warning = f"当前模型约 {billions:g}B，低于 PPT 编辑建议的 4B；计划可能不完整，确认前请重点核对预览和操作列表。"
        return {"model": name, "billions": billions, "recommended": recommended, "warning": warning}

    def plan(
        self,
        document_id: str,
        base_version: str,
        slide_id: str,
        instruction: str,
        slide_snapshot: dict[str, Any],
        assets: list[dict[str, Any]],
        api_sequence: str | None = None,
    ) -> tuple[PptPatch, str, dict[str, Any]]:
        capability = self.capability()
        if api_sequence is not None:
            raw = api_sequence
        else:
            asset_text = json.dumps([{"uri": item["uri"], "name": item["name"]} for item in assets], ensure_ascii=False)
            system = (
                "你是 PPT 专用计划器。只输出 API 调用序列，每行一个调用，不要 JSON、Markdown 或解释。"
                "只允许 replace_paragraph(div_id, paragraph_id, text)、clone_paragraph(div_id, paragraph_id)、"
                "del_paragraph(div_id, paragraph_id)、replace_image(image_id, image_path)、del_image(image_id)。"
                "ID 必须来自当前页 HTML；图片路径必须从可用 asset://upload/... 中选择；禁止新增幻灯片、表格、图表、备注、动画和母版。"
            )
            user = f"当前页 HTML：\n{slide_snapshot['html']}\n可用图片资源：{asset_text}\n用户要求：{instruction}"
            raw = self.inference.generate_constrained_text(system, user, max_tokens=512)
        operations = parse_ppt_calls(raw)
        return PptPatch.create(document_id, base_version, slide_id, operations), raw, capability


def _model_billions(name: str) -> float | None:
    normalized = name.replace("_", "-")
    match = re.search(r"(?<!\d)(\d+(?:\.\d+)?)\s*[Bb](?![A-Za-z])", normalized)
    if match:
        return float(match.group(1))
    match = re.search(r"(?<!\d)(\d+)p(\d+)(?:[Bb])?(?![A-Za-z])", normalized, flags=re.IGNORECASE)
    if match:
        return float(f"{match.group(1)}.{match.group(2)}")
    return None
