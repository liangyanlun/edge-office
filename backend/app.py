from __future__ import annotations

import ctypes
import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any, Generator
from uuid import uuid4

from flask import Flask, Response, jsonify, request, send_from_directory, stream_with_context

from .agent import AgentOrchestrator, PlanValidationError
from .config import default_config
from .database import Database
from .inference import InferenceAdapter, LocalModelRegistry
from .parsers import ParseError, parse_upload
from .rag import FaissRagService


SEED_DOCUMENTS = [
    {"id": "doc-overview", "name": "项目综述（内置）", "source": "立项申请摘要", "locator": "项目综述", "content": "本项目面向日常办公场景，研究并实现一套高效实用的轻量级智能对话系统。系统通过深度蒸馏获得轻量语言内核，再通过精准 RAG 外脑补充本地知识，适合个人电脑和离线终端。"},
    {"id": "doc-goals", "name": "研究目标与性能指标（内置）", "source": "立项申请摘要", "locator": "研究目的", "content": "项目目标是在参数量减少 90% 以上的前提下，在办公对话任务中保持较高性能，任务完成准确率和指令遵循度损失不超过 5%。系统面向 CPU 与资源受限环境，目标首 token 响应延迟小于 500ms，整体运行内存小于 1GB。"},
    {"id": "doc-rag", "name": "精准 RAG 机制（内置）", "source": "立项申请摘要", "locator": "研究内容 4", "content": "精准化 RAG 先从本地知识库检索候选信息，再通过引用提取模块从长文档中定位最相关的 1 到 2 个句子。它避免把整段文档直接输入小模型，从而减少上下文开销，提升回答的事实性和专业性。"},
    {"id": "doc-roadmap", "name": "实施路线（内置）", "source": "立项申请摘要", "locator": "研究路线", "content": "实施路线分为基础构建与蒸馏实验、RAG 增强与协同设计、边缘适配与深度优化、系统集成与综合验证四个阶段。最终交付可交互应用原型、技术报告、评测结果与可复现实验材料。"},
]


def sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def process_memory_mb() -> float:
    if os.name != "nt":
        return 0.0
    try:
        class PROCESS_MEMORY_COUNTERS_EX(ctypes.Structure):
            _fields_ = [("cb", ctypes.c_ulong), ("PageFaultCount", ctypes.c_ulong), ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t), ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t), ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t), ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t), ("PrivateUsage", ctypes.c_size_t)]

        counters = PROCESS_MEMORY_COUNTERS_EX()
        counters.cb = ctypes.sizeof(counters)
        ok = ctypes.windll.psapi.GetProcessMemoryInfo(ctypes.windll.kernel32.GetCurrentProcess(), ctypes.byref(counters), counters.cb)
        return round(counters.WorkingSetSize / 1024 / 1024, 1) if ok else 0.0
    except Exception:
        return 0.0


def create_app(overrides: dict[str, object] | None = None) -> Flask:
    config = default_config()
    if overrides:
        config.update(overrides)
    root_dir = Path(config["ROOT_DIR"])
    app = Flask(__name__, static_folder=str(root_dir / "public"), static_url_path="")
    app.config.update(config)

    database = Database(Path(app.config["DATABASE_PATH"]))
    database.initialize()
    database.seed_documents(SEED_DOCUMENTS)
    rag = FaissRagService(
        database,
        Path(app.config["INDEX_DIR"]),
        str(app.config["EMBEDDING_MODEL_PATH"]),
        query_instruction=str(app.config["RAG_QUERY_INSTRUCTION"]),
        candidate_k=int(app.config["RAG_CANDIDATE_K"]),
        rerank_k=int(app.config["RAG_RERANK_K"]),
        min_confidence=float(app.config["RAG_MIN_CONFIDENCE"]),
        allowed_security_levels=tuple(app.config["RAG_ALLOWED_SECURITY_LEVELS"]),
    )
    rag.initialize()
    registry = LocalModelRegistry(Path(app.config["MODELS_DIR"]))
    inference = InferenceAdapter(
        registry,
        llama_cpp_enabled=bool(app.config["LLAMA_CPP_ENABLED"]),
        model_path=Path(str(app.config["LLAMA_MODEL_PATH"])),
        n_ctx=int(app.config["LLAMA_N_CTX"]),
        n_threads=int(app.config["LLAMA_N_THREADS"]),
        n_gpu_layers=int(app.config["LLAMA_N_GPU_LAYERS"]),
    )

    def runtime_status() -> dict[str, Any]:
        return {
            "model": inference.status(),
            "rag": rag.status(),
            "resources": {"rssMb": process_memory_mb()},
            "documentCount": len(database.list_documents()),
            "ingestion": {
                "formats": ["txt", "md", "pdf", "docx", "xlsx", "csv", "pptx", "html"],
                "ocr": {"enabled": bool(app.config["OCR_ENABLED"]), "engine": "RapidOCR + ONNX Runtime", "maxPages": int(app.config["MAX_OCR_PAGES"])},
                "maxUploadMb": round(int(app.config["MAX_UPLOAD_BYTES"]) / 1024 / 1024),
            },
        }

    agent = AgentOrchestrator(
        database, rag, inference, runtime_status, rag_top_k=int(app.config["RAG_TOP_K"]),
        confirmation_ttl_seconds=int(app.config["AGENT_CONFIRMATION_TTL_SECONDS"]),
        user_id=str(app.config["AGENT_LOCAL_USER_ID"]),
    )
    app.extensions["database"] = database
    app.extensions["rag"] = rag
    app.extensions["agent"] = agent
    app.extensions["runtime_status"] = runtime_status

    @app.get("/")
    def home() -> Response:
        return send_from_directory(app.static_folder, "index.html")

    @app.get("/api/v1/health")
    def health() -> Response:
        return jsonify({"status": "ok", "apiVersion": "0.2", "modelStatus": inference.status()["status"], "indexStatus": "ready" if rag.status()["ready"] else "building"})

    @app.get("/api/v1/runtime/status")
    def get_runtime_status() -> Response:
        return jsonify(runtime_status())

    @app.get("/api/v1/documents")
    def documents() -> Response:
        return jsonify({"items": database.list_documents()})

    @app.post("/api/v1/documents")
    def import_document() -> Response:
        payload = request.get_json(silent=True) or {}
        name = str(payload.get("name") or "未命名材料").strip()[:100]
        content = str(payload.get("content") or "").strip()
        if not content:
            return error("EMPTY_DOCUMENT", "文档内容不能为空", 400)
        if len(content) > int(app.config["MAX_DOCUMENT_CHARACTERS"]):
            return error("DOCUMENT_TOO_LARGE", "单份文本超过当前 200KB 限制", 400)
        security_level = str(payload.get("securityLevel") or "internal")
        if security_level not in {"public", "internal"}:
            return error("INVALID_SECURITY_LEVEL", "仅支持 public 或 internal 材料级别", 400)
        item = database.create_document(name, content, security_level=security_level)
        manifest = rag.rebuild()
        return jsonify({"item": item, "index": manifest}), 201

    @app.post("/api/v1/documents/import")
    def import_uploaded_document() -> Response:
        uploaded = request.files.get("file")
        if not uploaded or not uploaded.filename:
            return error("FILE_REQUIRED", "请选择要导入的文件", 400)
        security_level = str(request.form.get("securityLevel") or "internal")
        if security_level not in {"public", "internal"}:
            return error("INVALID_SECURITY_LEVEL", "仅支持 public 或 internal 材料级别", 400)
        data = uploaded.stream.read(int(app.config["MAX_UPLOAD_BYTES"]) + 1)
        if len(data) > int(app.config["MAX_UPLOAD_BYTES"]):
            return error("FILE_TOO_LARGE", "文件超过当前 20MB 限制", 413)
        try:
            parsed = parse_upload(
                uploaded.filename, data, int(app.config["MAX_DOCUMENT_CHARACTERS"]),
                ocr_enabled=bool(app.config["OCR_ENABLED"]), max_pdf_pages=int(app.config["MAX_PDF_PAGES"]),
                max_ocr_pages=int(app.config["MAX_OCR_PAGES"]), max_sheets=int(app.config["MAX_XLSX_SHEETS"]),
                max_sheet_rows=int(app.config["MAX_XLSX_ROWS_PER_SHEET"]),
                max_sheet_columns=int(app.config["MAX_XLSX_COLUMNS"]), max_slides=int(app.config["MAX_PPTX_SLIDES"]),
            )
        except ParseError as exc:
            return error(exc.code, str(exc), 400)
        item = database.create_document(
            Path(uploaded.filename).name, parsed.content, security_level=security_level, mime_type=parsed.mime_type,
            locator=parsed.locator, parser_name=parsed.parser_name, parser_version=parsed.parser_version,
            file_sha256=hashlib.sha256(data).hexdigest(),
            extraction_quality=parsed.extraction_quality, parser_metadata=parsed.metadata,
        )
        manifest = rag.rebuild()
        return jsonify({"item": item, "index": manifest, "parser": parsed.parser_name, "quality": parsed.extraction_quality}), 201

    @app.delete("/api/v1/documents/<document_id>")
    def remove_document(document_id: str) -> Response:
        result = database.delete_document(document_id)
        if result == "not_found":
            return error("NOT_FOUND", "未找到请求的资源", 404)
        if result == "builtin":
            return error("BUILTIN_DOCUMENT", "内置材料不能删除", 400)
        rag.rebuild()
        return jsonify({"ok": True})

    @app.get("/api/v1/conversations")
    def conversations() -> Response:
        return jsonify({"items": database.list_conversations()})

    @app.post("/api/v1/conversations")
    def create_conversation() -> Response:
        return jsonify({"item": database.create_conversation()}), 201

    @app.get("/api/v1/conversations/<conversation_id>")
    def conversation(conversation_id: str) -> Response:
        item = database.get_conversation(conversation_id)
        return jsonify({"item": item}) if item else error("CONVERSATION_NOT_FOUND", "会话不存在", 404)

    @app.get("/api/v1/agent/tools")
    def agent_tools() -> Response:
        return jsonify({"items": agent.tools(), "policyVersion": "edge-office-agent-policy/1.0", "sandbox": True})

    @app.post("/api/v1/plans")
    def create_plan() -> Response:
        payload = request.get_json(silent=True) or {}
        message = str(payload.get("message") or "").strip()
        if not message:
            return error("EMPTY_MESSAGE", "请输入任务描述", 400)
        conversation_id = str(payload.get("conversationId") or "") or None
        if conversation_id and not database.get_conversation(conversation_id):
            return error("CONVERSATION_NOT_FOUND", "会话不存在", 404)
        plan = agent.plan(message, conversation_id, payload.get("ragEnabled") is not False, str(uuid4()))
        return jsonify({"item": plan}), 201

    @app.get("/api/v1/plans/<plan_id>")
    def get_plan(plan_id: str) -> Response:
        plan = database.get_agent_plan(plan_id)
        return jsonify({"item": plan}) if plan else error("PLAN_NOT_FOUND", "计划不存在", 404)

    @app.post("/api/v1/plans/<plan_id>/confirm")
    def confirm_plan(plan_id: str) -> Response:
        payload = request.get_json(silent=True) or {}
        confirmation_id = str(payload.get("confirmationId") or "")
        nonce = str(payload.get("confirmationNonce") or "")
        if not confirmation_id or not nonce:
            return error("CONFIRMATION_REQUIRED", "缺少确认凭据", 400)
        try:
            result = agent.confirm(plan_id, confirmation_id, nonce)
            return jsonify(result)
        except PlanValidationError as exc:
            return error(exc.code, str(exc), 409 if exc.code.startswith("CONFIRMATION_") else 400)

    @app.post("/api/v1/plans/<plan_id>/cancel")
    def cancel_plan(plan_id: str) -> Response:
        try:
            return jsonify({"item": agent.cancel(plan_id)})
        except PlanValidationError as exc:
            return error(exc.code, str(exc), 404 if exc.code == "PLAN_NOT_FOUND" else 409)

    @app.get("/api/v1/audit/<request_id>")
    def get_audit(request_id: str) -> Response:
        return jsonify(database.audit_for_request(request_id))

    @app.post("/api/v1/agent/runs")
    def run_agent() -> Response:
        payload = request.get_json(silent=True) or {}
        message = str(payload.get("message") or "").strip()
        if not message:
            return error("EMPTY_MESSAGE", "请输入问题", 400)
        conversation_id = str(payload.get("conversationId") or "")
        if not conversation_id:
            conversation_id = database.create_conversation()["id"]
        if not database.get_conversation(conversation_id):
            return error("CONVERSATION_NOT_FOUND", "会话不存在", 404)
        database.add_message(conversation_id, "user", message)
        request_id = str(uuid4())
        answer, citations, info, _ = agent.execute(message, conversation_id, payload.get("ragEnabled") is not False, request_id=request_id)
        database.add_message(conversation_id, "assistant", answer, citations, {"agentAction": info["action"], "retrievalMs": info["durationMs"]})
        return jsonify({"conversationId": conversation_id, "answer": answer, "citations": citations, "run": info})

    @app.post("/api/v1/chat/stream")
    def chat_stream() -> Response:
        payload = request.get_json(silent=True) or {}
        message = str(payload.get("message") or "").strip()
        if not message:
            return error("EMPTY_MESSAGE", "请输入问题", 400)
        conversation_id = str(payload.get("conversationId") or "")
        if not conversation_id:
            conversation_id = database.create_conversation()["id"]
        if not database.get_conversation(conversation_id):
            return error("CONVERSATION_NOT_FOUND", "会话不存在", 404)
        rag_enabled = payload.get("ragEnabled") is not False
        database.add_message(conversation_id, "user", message)

        def generate() -> Generator[str, None, None]:
            began = time.perf_counter()
            request_id = str(uuid4())
            model = inference.status()["name"]
            yield sse("meta", {
                "requestId": request_id,
                "conversationId": conversation_id,
                "model": model,
                "mode": "flask-agent-rag" if rag_enabled else "flask-agent-local-model",
                "ragEnabled": rag_enabled,
            })
            yield sse("stage", {"name": "agent", "label": "正在规划本地办公任务"})
            try:
                answer, citations, run, agent_events = agent.execute(message, conversation_id, rag_enabled, request_id=request_id)
                for item in agent_events:
                    yield sse(item["event"], item["data"])
                if citations:
                    yield sse("citations", {"items": citations})
                yield sse("stage", {"name": "generation", "label": "正在生成可追溯回答"})
                first_token_at = time.perf_counter()
                emitted = ""
                for index in range(0, len(answer), 12):
                    token = answer[index:index + 12]
                    emitted += token
                    yield sse("token", {"text": token})
                generation_ms = max(1, round((time.perf_counter() - first_token_at) * 1000))
                metrics = {"ttftMs": round((first_token_at - began) * 1000), "retrievalMs": run["durationMs"], "generationMs": generation_ms, "tokensPerSecond": round(max(1, len(emitted) / 1.8) / generation_ms * 1000, 1), "peakRssMb": process_memory_mb(), "agentAction": run["action"]}
                database.add_message(conversation_id, "assistant", emitted, citations, metrics)
                yield sse("metrics", metrics)
                yield sse("done", {"finishReason": "stop", "usage": {"inputTokens": max(1, len(message) // 2), "outputTokens": max(1, len(emitted) // 2)}})
            except Exception as exc:
                yield sse("error", {"code": "AGENT_ERROR", "message": str(exc) or "Agent 执行失败"})

        response = Response(stream_with_context(generate()), mimetype="text/event-stream")
        response.headers["Cache-Control"] = "no-cache, no-transform"
        response.headers["X-Accel-Buffering"] = "no"
        return response

    @app.errorhandler(404)
    def not_found(_: Exception) -> Response:
        return error("NOT_FOUND", "未找到请求的资源", 404)

    return app


def error(code: str, message: str, status: int) -> tuple[Response, int]:
    return jsonify({"error": {"code": code, "message": message}}), status
