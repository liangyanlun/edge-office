from __future__ import annotations

import hashlib
import json
import re
import secrets
import time
from dataclasses import dataclass
from typing import Any, Callable

from .database import Database
from .inference import InferenceAdapter
from .rag import FaissRagService


POLICY_VERSION = "edge-office-agent-policy/1.0"
MAX_ARGUMENT_BYTES = 8_192
HIGH_RISK = {"email_send", "calendar_commit", "task_delete", "file_overwrite"}


class PlanValidationError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class ToolDefinition:
    name: str
    risk_class: str
    label: str
    permission: str
    legacy_action: str
    fields: dict[str, tuple[type, bool]]


TOOL_REGISTRY: dict[str, ToolDefinition] = {
    "document_search": ToolDefinition("document_search", "read_only", "检索本地材料", "documents.read", "search_knowledge", {"query": (str, True), "top_k": (int, False)}),
    "document_quote": ToolDefinition("document_quote", "read_only", "定位材料原文", "documents.read", "search_knowledge", {"query": (str, True), "top_k": (int, False)}),
    "calendar_find_slots": ToolDefinition("calendar_find_slots", "read_only", "查询日程空档（沙箱）", "calendar.read", "get_runtime_status", {"date": (str, False)}),
    "task_list": ToolDefinition("task_list", "read_only", "查看本地材料", "tasks.read", "list_documents", {"keyword": (str, False), "limit": (int, False)}),
    "email_create_draft": ToolDefinition("email_create_draft", "draft", "创建邮件草稿", "email.draft", "create_office_draft", {"to": (str, False), "subject": (str, False), "body": (str, True), "tone": (str, False)}),
    "calendar_create_draft": ToolDefinition("calendar_create_draft", "draft", "创建日程草稿", "calendar.draft", "create_office_draft", {"title": (str, True), "time": (str, False), "participants": (list, False)}),
    "task_create_draft": ToolDefinition("task_create_draft", "draft", "创建待办草稿", "tasks.draft", "create_office_draft", {"title": (str, True), "due": (str, False)}),
    "task_update_draft": ToolDefinition("task_update_draft", "draft", "更新待办草稿", "tasks.draft", "create_office_draft", {"task_id": (str, True), "title": (str, False), "due": (str, False)}),
    "email_send": ToolDefinition("email_send", "high_risk", "发送邮件（沙箱）", "email.send", "create_office_draft", {"to": (str, True), "subject": (str, True), "body": (str, True)}),
    "calendar_commit": ToolDefinition("calendar_commit", "high_risk", "提交日程（沙箱）", "calendar.write", "create_office_draft", {"title": (str, True), "time": (str, True), "participants": (list, False)}),
    "task_delete": ToolDefinition("task_delete", "high_risk", "删除待办（沙箱）", "tasks.delete", "create_office_draft", {"task_id": (str, True)}),
    "file_overwrite": ToolDefinition("file_overwrite", "high_risk", "覆盖文件（未开放）", "files.write", "create_office_draft", {"path": (str, True), "content": (str, True)}),
    "request_clarification": ToolDefinition("request_clarification", "control", "请求补充信息", "none", "search_knowledge", {"question": (str, True)}),
    "respond_without_tool": ToolDefinition("respond_without_tool", "control", "直接回答", "none", "search_knowledge", {"response": (str, True)}),
}


def canonical_json(value: dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def parse_action_plan(raw: str | dict[str, Any]) -> dict[str, Any]:
    """Parse the strict model contract. `confirmed` is never authority."""
    def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise PlanValidationError("DUPLICATE_FIELD", "计划包含重复字段")
            result[key] = value
        return result

    try:
        data = json.loads(raw, object_pairs_hook=reject_duplicates, parse_constant=lambda _: (_ for _ in ()).throw(ValueError())) if isinstance(raw, str) else raw
    except (ValueError, TypeError, json.JSONDecodeError) as error:
        raise PlanValidationError("INVALID_JSON", "模型计划不是有效 JSON") from error
    if not isinstance(data, dict) or set(data) != {"tool", "arguments", "confirmed"}:
        raise PlanValidationError("INVALID_PLAN_SHAPE", "计划必须且只能包含 tool、arguments、confirmed")
    if not isinstance(data["tool"], str) or data["tool"] not in TOOL_REGISTRY:
        raise PlanValidationError("UNKNOWN_TOOL", "计划使用了未允许的工具")
    if type(data["confirmed"]) is not bool or data["confirmed"]:
        raise PlanValidationError("UNTRUSTED_CONFIRMATION", "模型不能确认任何操作")
    if not isinstance(data["arguments"], dict) or len(canonical_json(data["arguments"]).encode("utf-8")) > MAX_ARGUMENT_BYTES:
        raise PlanValidationError("INVALID_ARGUMENTS", "工具参数格式不正确或过大")
    tool = TOOL_REGISTRY[data["tool"]]
    if set(data["arguments"]) - set(tool.fields):
        raise PlanValidationError("UNKNOWN_ARGUMENT", "计划包含未定义参数")
    for name, (expected_type, required) in tool.fields.items():
        value = data["arguments"].get(name)
        if required and (value is None or value == ""):
            raise PlanValidationError("MISSING_ARGUMENT", f"缺少必要参数：{name}")
        if value is not None and (type(value) is not expected_type or (isinstance(value, str) and len(value) > 4_000)):
            raise PlanValidationError("INVALID_ARGUMENT", f"参数格式不正确：{name}")
    if data["tool"] == "file_overwrite" and re.search(r"(^[a-zA-Z]:|^[/\\]|\.\.|\\\\|^\\\\\.\\)", str(data["arguments"].get("path", ""))):
        raise PlanValidationError("PATH_NOT_ALLOWED", "文件路径不在允许范围内")
    for key in ("to", "participants"):
        value = data["arguments"].get(key)
        values = value if isinstance(value, list) else [value]
        if any(isinstance(item, str) and ("\n" in item or "\r" in item) for item in values):
            raise PlanValidationError("INVALID_RECIPIENT", "收件人或参与者格式不正确")
    return {"tool": data["tool"], "arguments": data["arguments"], "confirmed": False}


class AgentOrchestrator:
    """One-action policy Agent. Tools are allow-listed and sandbox-only."""

    def __init__(self, database: Database, rag: FaissRagService, inference: InferenceAdapter, runtime_status: Callable[[], dict[str, Any]], rag_top_k: int = 2, confirmation_ttl_seconds: int = 300, user_id: str = "local-user"):
        self.database, self.rag, self.inference, self.runtime_status = database, rag, inference, runtime_status
        self.rag_top_k = max(1, min(int(rag_top_k), 4))
        self.confirmation_ttl_seconds = max(30, min(int(confirmation_ttl_seconds), 3600))
        self.user_id = user_id

    @staticmethod
    def tools() -> list[dict[str, Any]]:
        return [{"name": item.name, "label": item.label, "riskClass": item.risk_class, "permission": item.permission, "requiresConfirmation": item.name in HIGH_RISK, "sandbox": True, "schema": {key: {"type": typ.__name__, "required": required} for key, (typ, required) in item.fields.items()}} for item in TOOL_REGISTRY.values()]

    def plan(self, message: str, conversation_id: str | None, rag_enabled: bool, request_id: str) -> dict[str, Any]:
        raw_output = ""
        try:
            raw_output = self.inference.create_action_plan(message, self.candidate_tools(message, rag_enabled))
            action_plan = parse_action_plan(raw_output)
        except (RuntimeError, PlanValidationError):
            action_plan = self._fallback_plan(message, rag_enabled)
            raw_output = canonical_json(action_plan)
        tool = TOOL_REGISTRY[action_plan["tool"]]
        canonical_plan = canonical_json({"tool": tool.name, "arguments": action_plan["arguments"]})
        plan_hash = hashlib.sha256((POLICY_VERSION + "\n" + canonical_plan).encode("utf-8")).hexdigest()
        needs_confirmation = tool.name in HIGH_RISK
        plan = self.database.create_agent_plan(
            request_id=request_id, conversation_id=conversation_id, tool=tool.name, arguments=action_plan["arguments"], canonical_json=canonical_plan, plan_sha256=plan_hash,
            risk_class=tool.risk_class, policy_version=POLICY_VERSION, model_name=self.inference.status()["name"], model_output_sha256=hashlib.sha256(raw_output.encode("utf-8")).hexdigest(),
            status="AWAITING_CONFIRMATION" if needs_confirmation else "VALIDATED", expires_in_seconds=self.confirmation_ttl_seconds if needs_confirmation else None,
        )
        if needs_confirmation:
            nonce = secrets.token_urlsafe(24)
            confirmation_id = self.database.create_confirmation(plan["id"], plan_hash, self.user_id, plan["expiresAt"], hashlib.sha256(nonce.encode()).hexdigest())
            plan = self.database.get_agent_plan(plan["id"]) or plan
            plan.update({"confirmationId": confirmation_id, "confirmationNonce": nonce})
        return plan

    @staticmethod
    def candidate_tools(message: str, rag_enabled: bool = True) -> list[dict[str, Any]]:
        """Trusted intent gate: small models fill parameters, never broaden tool authority."""
        def select(name: str) -> list[dict[str, Any]]:
            item = next(tool for tool in AgentOrchestrator.tools() if tool["name"] == name)
            # Keep only mandatory keys in the grammar. Optional data is retained in
            # the user message/draft text, while this prevents a small model from
            # spending its output budget hallucinating long participant lists.
            return [{**item, "schema": {key: spec for key, spec in item["schema"].items() if spec["required"]}}]

        text, lower = message.strip(), message.lower()
        email = re.search(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", text)
        if "发送" in text and "邮件" in text:
            return select("email_send" if email and "主题" in text and "正文" in text else "request_clarification")
        if "覆盖" in text and any(term in text for term in ("文件", ".txt", ".md")):
            return select("file_overwrite")
        if "删除" in text and "待办" in text:
            return select("task_delete")
        if "更新" in text and "待办" in text:
            return select("task_update_draft")
        if any(term in text for term in ("创建待办", "新增待办", "待办草稿")):
            return select("task_create_draft")
        if any(term in text for term in ("创建日程", "日程草稿", "安排会议")):
            return select("calendar_create_draft")
        if "日程" in text and any(term in text for term in ("空档", "空闲", "时间")):
            return select("calendar_find_slots")
        if any(term in text for term in ("列出", "有哪些", "所有文档", "材料列表", "查看材料", "查看文档")):
            return select("task_list")
        if any(term in text for term in ("引用", "原文", "原句")):
            return select("document_quote")
        if "邮件" in text and any(term in text for term in ("草拟", "草稿", "写一封")):
            return select("email_create_draft")
        if any(term in lower for term in ("你好", "谢谢", "运行状态", "内存")):
            return select("respond_without_tool")
        return select("document_search")

    def execute(self, message: str, conversation_id: str, rag_enabled: bool, request_id: str | None = None) -> tuple[str, list[dict[str, Any]], dict[str, Any], list[dict[str, Any]]]:
        request_id = request_id or secrets.token_hex(16)
        plan = self.plan(message, conversation_id, rag_enabled, request_id)
        tool = TOOL_REGISTRY[plan["tool"]]
        events = [{"event": "plan", "data": self._plan_event(plan)}]
        if plan["status"] == "AWAITING_CONFIRMATION":
            return self._preview(plan), [], {"action": tool.legacy_action, "tool": tool.name, "durationMs": 0, "runId": plan["id"], "plan": plan}, events
        answer, citations, duration_ms = self._execute_plan(plan, rag_enabled, request_id)
        events += [{"event": "tool_start", "data": {"action": tool.name, "label": tool.label}}, {"event": "tool_result", "data": {"action": tool.name, "durationMs": duration_ms}}]
        return answer, citations, {"action": tool.legacy_action, "tool": tool.name, "durationMs": duration_ms, "runId": plan["id"], "plan": self.database.get_agent_plan(plan["id"])}, events

    def confirm(self, plan_id: str, confirmation_id: str, nonce: str, request_id: str | None = None) -> dict[str, Any]:
        plan = self.database.get_agent_plan(plan_id)
        if not plan:
            raise PlanValidationError("PLAN_NOT_FOUND", "计划不存在")
        result = self.database.consume_confirmation(plan_id, confirmation_id, plan["planHash"], self.user_id, hashlib.sha256(nonce.encode()).hexdigest())
        if result != "CONFIRMED":
            raise PlanValidationError(f"CONFIRMATION_{result}", "确认已失效、被取消或已使用")
        updated = self.database.get_agent_plan(plan_id)
        assert updated is not None
        answer, citations, duration_ms = self._execute_plan(updated, True, request_id or updated["requestId"])
        return {"plan": self.database.get_agent_plan(plan_id), "answer": answer, "citations": citations, "durationMs": duration_ms}

    def cancel(self, plan_id: str) -> dict[str, Any]:
        result = self.database.cancel_agent_plan(plan_id)
        if result == "NOT_FOUND":
            raise PlanValidationError("PLAN_NOT_FOUND", "计划不存在")
        if result != "CANCELLED":
            raise PlanValidationError("PLAN_NOT_CANCELLABLE", "该计划已不能取消")
        return self.database.get_agent_plan(plan_id) or {}

    def _execute_plan(self, plan: dict[str, Any], rag_enabled: bool, request_id: str) -> tuple[str, list[dict[str, Any]], int]:
        current = self.database.get_agent_plan(plan["id"])
        if not current or current["status"] not in {"VALIDATED", "CONFIRMED"}:
            raise PlanValidationError("PLAN_NOT_EXECUTABLE", "计划当前不能执行")
        self.database.update_agent_plan_status(plan["id"], "EXECUTING", "EXECUTING", {})
        attempt_id = self.database.create_tool_attempt(plan["id"], f"plan:{plan['id']}")
        started, citations = time.perf_counter(), []
        tool, arguments = plan["tool"], plan["arguments"]
        try:
            if tool in {"document_search", "document_quote"}:
                citations = self.rag.search(arguments["query"], int(arguments.get("top_k", self.rag_top_k)), request_id=request_id) if rag_enabled else []
                answer = self.inference.compose_answer(arguments["query"], citations, rag_enabled, "search_knowledge")
            elif tool == "task_list":
                docs = self.database.list_documents(keyword=arguments.get("keyword") or None, limit=min(int(arguments.get("limit", 10)), 20))
                answer = self.inference.compose_answer("列出材料", docs, True, "list_documents")
            elif tool == "calendar_find_slots":
                answer = "当前为本地沙箱模式，尚未连接真实日历。可先创建日程草稿，待授权接入后再查询真实空档。"
            elif tool == "email_create_draft":
                answer = self.inference.create_draft("邮件", arguments.get("body", ""), arguments.get("tone", "正式"))
            elif tool in {"calendar_create_draft", "task_create_draft", "task_update_draft"}:
                answer = self._draft_summary(tool, arguments)
            elif tool == "request_clarification":
                answer = arguments["question"]
            elif tool == "respond_without_tool":
                answer = arguments["response"]
            elif tool in HIGH_RISK:
                answer = f"已在本地沙箱完成“{TOOL_REGISTRY[tool].label}”演练；当前未配置真实外部连接，不会产生邮件、日历、待办或文件副作用。"
            else:
                raise PlanValidationError("UNKNOWN_TOOL", "未允许的工具")
            duration_ms = max(1, round((time.perf_counter() - started) * 1000))
            self.database.finish_tool_attempt(attempt_id, "SUCCEEDED", {"summary": answer[:500], "citationIds": [item.get("chunkId") for item in citations]})
            self.database.update_agent_plan_status(plan["id"], "SUCCEEDED", "SUCCEEDED", {"durationMs": duration_ms})
            return answer, citations, duration_ms
        except Exception:
            self.database.finish_tool_attempt(attempt_id, "FAILED", {}, "TOOL_FAILED")
            self.database.update_agent_plan_status(plan["id"], "FAILED", "FAILED", {"errorCode": "TOOL_FAILED"})
            raise

    def _fallback_plan(self, message: str, rag_enabled: bool) -> dict[str, Any]:
        text, lower = message.strip(), message.lower()
        routed = self.candidate_tools(text, rag_enabled)[0]["name"]
        if routed == "request_clarification":
            return {"tool": routed, "arguments": {"question": "请提供收件人邮箱、邮件主题和正文；我会展示准确的发送计划供你确认。"}, "confirmed": False}
        if routed == "email_send":
            email = re.search(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", text)
            return {"tool": routed, "arguments": {"to": email.group(0) if email else "", "subject": "待补充主题", "body": text}, "confirmed": False}
        if routed == "task_list":
            return {"tool": "task_list", "arguments": {"keyword": "", "limit": 10}, "confirmed": False}
        if routed == "email_create_draft":
            return {"tool": "email_create_draft", "arguments": {"body": text, "tone": "正式"}, "confirmed": False}
        if routed == "calendar_create_draft":
            return {"tool": routed, "arguments": {"title": text}, "confirmed": False}
        if routed == "task_create_draft":
            return {"tool": routed, "arguments": {"title": text}, "confirmed": False}
        if routed == "task_update_draft":
            task = re.search(r"(?:task|待办)[-_ ]?([\w-]+)", text, re.IGNORECASE)
            return {"tool": routed, "arguments": {"task_id": task.group(0) if task else "待补充待办编号"}, "confirmed": False}
        if routed == "task_delete":
            task = re.search(r"(?:task|待办)[-_ ]?([\w-]+)", text, re.IGNORECASE)
            return {"tool": routed, "arguments": {"task_id": task.group(0) if task else "待补充待办编号"}, "confirmed": False}
        if routed == "file_overwrite":
            path = re.search(r"([\w.-]+[\\/][\w.-]+|[\w.-]+\.(?:txt|md))", text)
            return {"tool": routed, "arguments": {"path": path.group(0) if path else "notes/draft.txt", "content": text}, "confirmed": False}
        if routed == "respond_without_tool":
            status = self.runtime_status()
            return {"tool": "respond_without_tool", "arguments": {"response": f"本地运行正常：模型 {status['model']['name']}，知识库 {status['rag']['chunkCount']} 个切片，当前 {status['documentCount']} 份材料。"}, "confirmed": False}
        return {"tool": routed, "arguments": {"query": text, "top_k": self.rag_top_k if rag_enabled else 1}, "confirmed": False}

    @staticmethod
    def _draft_summary(tool: str, arguments: dict[str, Any]) -> str:
        lines = [f"{TOOL_REGISTRY[tool].label}（本地可编辑，未提交）"]
        lines.extend(f"{key}：{', '.join(value) if isinstance(value, list) else value}" for key, value in arguments.items() if value)
        return "\n".join(lines) + "\n\n请核对内容后再进行真实系统接入。"

    @staticmethod
    def _preview(plan: dict[str, Any]) -> str:
        tool = TOOL_REGISTRY[plan["tool"]]
        args = "；".join(f"{key}：{value}" for key, value in plan["arguments"].items()) or "无参数"
        return f"待确认操作：{tool.label}\n风险等级：高风险（当前为本地沙箱，不会产生外部副作用）\n内容：{args}\n请在下方确认或取消。"

    @staticmethod
    def _plan_event(plan: dict[str, Any]) -> dict[str, Any]:
        tool = TOOL_REGISTRY[plan["tool"]]
        return {"planId": plan["id"], "action": tool.name, "legacyAction": tool.legacy_action, "label": tool.label, "riskClass": tool.risk_class, "status": plan["status"], "arguments": plan["arguments"], "expiresAt": plan.get("expiresAt"), "confirmationId": plan.get("confirmationId"), "confirmationNonce": plan.get("confirmationNonce")}
