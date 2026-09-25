from __future__ import annotations

import re
from typing import Any, Callable

from .contracts import PptContractError, PptPatch
from .snapshot import snapshot_for_slide


ASSET_URI = re.compile(r"^asset://upload/([A-Za-z0-9-]{8,80})$")


def validate_patch(
    patch: PptPatch,
    snapshot: dict[str, Any],
    asset_lookup: Callable[[str], dict[str, Any] | None],
) -> list[dict[str, Any]]:
    if len(patch.operations) > 32:
        raise PptContractError("PPT_TOO_MANY_OPERATIONS", "单个 PPT 计划最多允许 32 个操作")
    try:
        slide = snapshot_for_slide(snapshot, patch.slide_id)
    except KeyError as exc:
        raise PptContractError("PPT_SLIDE_NOT_FOUND", "目标幻灯片不存在") from exc
    text_shapes = {int(item["id"]): item for item in slide["elements"] if item.get("kind") == "text"}
    image_shapes = {int(item["id"]): item for item in slide["elements"] if item.get("kind") == "image"}
    image_ids = set(image_shapes)
    paragraph_ids = {shape_id: {int(p["id"]) for p in shape.get("paragraphs", [])} for shape_id, shape in text_shapes.items()}
    resolved: list[dict[str, Any]] = []
    for operation in patch.operations:
        item = operation.as_dict()
        name = operation.name
        if name in {"replace_paragraph", "clone_paragraph", "del_paragraph"}:
            div_id = _integer(item.get("div_id"), "PPT_TEXT_TARGET_INVALID")
            paragraph_id = _integer(item.get("paragraph_id"), "PPT_PARAGRAPH_TARGET_INVALID")
            shape = text_shapes.get(div_id)
            if not shape:
                raise PptContractError("PPT_TEXT_TARGET_NOT_FOUND", f"未找到文本对象 {div_id}")
            if not shape.get("editable", True):
                raise PptContractError("PPT_SPECIAL_PLACEHOLDER_FORBIDDEN", "不允许修改日期、页码等特殊占位符")
            if paragraph_id not in paragraph_ids[div_id]:
                raise PptContractError("PPT_PARAGRAPH_NOT_FOUND", f"未找到段落 {paragraph_id}")
            if name == "replace_paragraph" and len(str(item.get("text", ""))) > 10_000:
                raise PptContractError("PPT_TEXT_TOO_LARGE", "单个替换段落不能超过 10000 个字符")
            if name == "clone_paragraph":
                paragraph_ids[div_id].add(max(paragraph_ids[div_id], default=-1) + 1)
            elif name == "del_paragraph":
                paragraph_ids[div_id].remove(paragraph_id)
        if name in {"replace_image", "del_image"}:
            image_id = _integer(item.get("image_id"), "PPT_IMAGE_TARGET_INVALID")
            if image_id not in image_ids:
                raise PptContractError("PPT_IMAGE_TARGET_NOT_FOUND", f"未找到图片对象 {image_id}")
            if name == "del_image":
                image_ids.remove(image_id)
        if name == "replace_image":
            match = ASSET_URI.fullmatch(str(item.get("image_path") or ""))
            if not match:
                raise PptContractError("PPT_ASSET_URI_REQUIRED", "替换图片只能引用本次上传的 asset://upload/... 资源")
            asset = asset_lookup(match.group(1))
            if not asset or asset.get("presentationId") != patch.document_id:
                raise PptContractError("PPT_ASSET_NOT_FOUND", "替换图片资源不存在或不属于当前演示文稿")
            item["assetId"] = match.group(1)
            item["assetPath"] = asset["path"]
        resolved.append(item)
    return resolved


def _integer(value: Any, code: str) -> int:
    if isinstance(value, bool):
        raise PptContractError(code, "PPT 对象 ID 必须是非负整数")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise PptContractError(code, "PPT 对象 ID 必须是非负整数") from exc
    if parsed < 0:
        raise PptContractError(code, "PPT 对象 ID 必须是非负整数")
    return parsed
