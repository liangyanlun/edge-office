from __future__ import annotations

import ast
import hashlib
import json
from dataclasses import dataclass
from typing import Any


CONTRACT_VERSION = "edge-office-ppt-patch/1.0"
SUPPORTED_OPERATIONS = {
    "replace_paragraph": 3,
    "clone_paragraph": 2,
    "del_paragraph": 2,
    "replace_image": 2,
    "del_image": 1,
}


class PptContractError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class PptOperation:
    name: str
    arguments: tuple[str | int, ...]

    def as_dict(self) -> dict[str, Any]:
        keys = {
            "replace_paragraph": ("div_id", "paragraph_id", "text"),
            "clone_paragraph": ("div_id", "paragraph_id"),
            "del_paragraph": ("div_id", "paragraph_id"),
            "replace_image": ("image_id", "image_path"),
            "del_image": ("image_id",),
        }[self.name]
        return {"operation": self.name, **dict(zip(keys, self.arguments, strict=True))}


@dataclass(frozen=True)
class PptPatch:
    document_id: str
    base_version: str
    slide_id: str
    operations: tuple[PptOperation, ...]
    patch_hash: str
    contract_version: str = CONTRACT_VERSION

    @classmethod
    def create(cls, document_id: str, base_version: str, slide_id: str, operations: list[PptOperation]) -> "PptPatch":
        canonical = canonical_patch(document_id, base_version, slide_id, operations)
        digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        return cls(document_id, base_version, slide_id, tuple(operations), digest)

    def canonical_json(self) -> str:
        return canonical_patch(self.document_id, self.base_version, self.slide_id, list(self.operations))

    def as_dict(self) -> dict[str, Any]:
        return {
            "contractVersion": self.contract_version,
            "documentId": self.document_id,
            "baseVersion": self.base_version,
            "slideId": self.slide_id,
            "operations": [item.as_dict() for item in self.operations],
            "patchHash": self.patch_hash,
        }


def canonical_patch(document_id: str, base_version: str, slide_id: str, operations: list[PptOperation]) -> str:
    return json.dumps(
        {
            "contractVersion": CONTRACT_VERSION,
            "documentId": document_id,
            "baseVersion": base_version,
            "slideId": slide_id,
            "operations": [item.as_dict() for item in operations],
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def parse_ppt_calls(source: str) -> list[PptOperation]:
    """Parse the exact API-call sequence used by the PPT SFT corpus."""
    if not isinstance(source, str) or not source.strip():
        raise PptContractError("PPT_MODEL_OUTPUT_EMPTY", "PPT 模型没有返回操作序列")
    if len(source) > 100_000:
        raise PptContractError("PPT_MODEL_OUTPUT_TOO_LARGE", "PPT 操作序列超过限制")
    cleaned = source.strip()
    if cleaned.startswith("```"):
        lines = cleaned.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        cleaned = "\n".join(lines).strip()
    try:
        tree = ast.parse(cleaned, mode="exec")
    except SyntaxError as exc:
        raise PptContractError("PPT_CALL_SYNTAX_INVALID", "模型返回的 PPT API 序列语法不正确") from exc
    operations: list[PptOperation] = []
    for statement in tree.body:
        if not isinstance(statement, ast.Expr) or not isinstance(statement.value, ast.Call):
            raise PptContractError("PPT_CALL_STATEMENT_INVALID", "PPT 计划只能包含 API 调用")
        call = statement.value
        if not isinstance(call.func, ast.Name) or call.func.id not in SUPPORTED_OPERATIONS:
            raise PptContractError("PPT_OPERATION_UNSUPPORTED", "PPT 计划包含未开放的操作")
        if call.keywords:
            raise PptContractError("PPT_KEYWORDS_FORBIDDEN", "PPT API 不接受关键字参数")
        name = call.func.id
        if len(call.args) != SUPPORTED_OPERATIONS[name]:
            raise PptContractError("PPT_CALL_ARITY_INVALID", f"{name} 参数数量不正确")
        arguments: list[str | int] = []
        for argument in call.args:
            try:
                value = ast.literal_eval(argument)
            except (ValueError, SyntaxError) as exc:
                raise PptContractError("PPT_ARGUMENT_NOT_LITERAL", "PPT API 参数必须是字符串或整数常量") from exc
            if isinstance(value, bool) or not isinstance(value, (str, int)):
                raise PptContractError("PPT_ARGUMENT_TYPE_INVALID", "PPT API 参数类型不受支持")
            if isinstance(value, int) and value < 0:
                raise PptContractError("PPT_IDENTIFIER_INVALID", "PPT 对象 ID 不能为负数")
            if isinstance(value, str) and (len(value) > 20_000 or "\x00" in value):
                raise PptContractError("PPT_STRING_INVALID", "PPT 文本参数超过限制或包含非法字符")
            arguments.append(value)
        operations.append(PptOperation(name, tuple(arguments)))
    if not operations:
        raise PptContractError("PPT_OPERATIONS_EMPTY", "PPT 计划至少需要一个操作")
    return operations
