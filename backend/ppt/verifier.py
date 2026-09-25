from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from .contracts import PptContractError, PptPatch
from .snapshot import build_snapshot, slide_structure_digest, snapshot_for_slide, write_snapshot


def verify_candidate(
    candidate_path: Path,
    base_snapshot: dict[str, Any],
    patch: PptPatch,
    operations: list[dict[str, Any]],
    snapshot_path: Path,
) -> dict[str, Any]:
    try:
        result = build_snapshot(candidate_path, f"staged:{patch.patch_hash[:12]}")
    except Exception as exc:
        raise PptContractError("PPT_REOPEN_FAILED", "PPT 保存后无法重新打开") from exc
    base_slides = {item["slideId"]: item for item in base_snapshot["slides"]}
    result_slides = {item["slideId"]: item for item in result["slides"]}
    if set(base_slides) != set(result_slides):
        raise PptContractError("PPT_SLIDE_SET_CHANGED", "执行后幻灯片数量发生了变化")
    for slide_id, before in base_slides.items():
        if slide_id == patch.slide_id:
            continue
        if slide_structure_digest(before) != slide_structure_digest(result_slides[slide_id]):
            raise PptContractError("PPT_NON_TARGET_CHANGED", f"非目标页 {slide_id} 被意外修改")
    _verify_target(snapshot_for_slide(base_snapshot, patch.slide_id), snapshot_for_slide(result, patch.slide_id), operations)
    write_snapshot(result, snapshot_path)
    digest = hashlib.sha256(candidate_path.read_bytes()).hexdigest()
    return {
        "ok": True,
        "candidateSha256": digest,
        "slideCount": len(result["slides"]),
        "targetSlide": patch.slide_id,
        "operationCount": len(operations),
        "nonTargetSlidesVerified": max(0, len(result["slides"]) - 1),
    }


def _verify_target(before: dict[str, Any], after: dict[str, Any], operations: list[dict[str, Any]]) -> None:
    expected_text = {
        int(item["id"]): [{"id": int(p["id"]), "text": p["text"]} for p in item.get("paragraphs", [])]
        for item in before["elements"] if item.get("kind") == "text"
    }
    expected_images = {
        int(item["id"]): {"sha256": item["imageSha256"], "bounds": item["bounds"]}
        for item in before["elements"] if item.get("kind") == "image"
    }
    for operation in operations:
        name = operation["operation"]
        if name == "replace_paragraph":
            paragraph = _logical_paragraph(expected_text[int(operation["div_id"])], int(operation["paragraph_id"]))
            paragraph["text"] = str(operation["text"])
        elif name == "clone_paragraph":
            paragraphs = expected_text[int(operation["div_id"])]
            source = _logical_paragraph(paragraphs, int(operation["paragraph_id"]))
            new_id = max((item["id"] for item in paragraphs), default=-1) + 1
            paragraphs.insert(paragraphs.index(source) + 1, {"id": new_id, "text": source["text"]})
        elif name == "del_paragraph":
            paragraphs = expected_text[int(operation["div_id"])]
            paragraphs.remove(_logical_paragraph(paragraphs, int(operation["paragraph_id"])))
        elif name == "replace_image":
            image = expected_images[int(operation["image_id"])]
            image["sha256"] = hashlib.sha256(Path(operation["assetPath"]).read_bytes()).hexdigest()
        elif name == "del_image":
            del expected_images[int(operation["image_id"])]
    actual_text = {
        int(item["id"]): [p["text"] for p in item.get("paragraphs", [])]
        for item in after["elements"] if item.get("kind") == "text"
    }
    for shape_id, paragraphs in expected_text.items():
        if actual_text.get(shape_id) != [item["text"] for item in paragraphs]:
            raise PptContractError("PPT_FINAL_STATE_MISMATCH", f"文本对象 {shape_id} 的最终状态与计划不一致")
    expected_image_state = sorted((item["sha256"], _bounds_tuple(item["bounds"])) for item in expected_images.values())
    actual_image_state = sorted(
        (item["imageSha256"], _bounds_tuple(item["bounds"])) for item in after["elements"] if item.get("kind") == "image"
    )
    if actual_image_state != expected_image_state:
        raise PptContractError("PPT_FINAL_STATE_MISMATCH", "图片内容或位置尺寸与计划不一致")


def _logical_paragraph(paragraphs: list[dict[str, Any]], paragraph_id: int) -> dict[str, Any]:
    for paragraph in paragraphs:
        if paragraph["id"] == paragraph_id:
            return paragraph
    raise PptContractError("PPT_FINAL_STATE_MISMATCH", f"逻辑段落 {paragraph_id} 不存在")


def _bounds_tuple(bounds: dict[str, Any]) -> tuple[int, int, int, int]:
    return (int(bounds["left"]), int(bounds["top"]), int(bounds["width"]), int(bounds["height"]))
