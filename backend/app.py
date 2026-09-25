from __future__ import annotations

import ctypes
import hashlib
import json
import os
import re
import secrets
import time
from pathlib import Path
from typing import Any, Generator
from uuid import uuid4

from flask import Flask, Response, g, jsonify, request, send_from_directory, stream_with_context

from .agent import AgentOrchestrator, PlanValidationError
from .config import default_config
from .database import Database
from .inference import InferenceAdapter, LocalModelRegistry
from .model_download import ModelDownloadError, ModelReleaseDownloader
from .model_catalog import FOUR_B_MODEL_ID, build_model_catalog
from .mobile import create_mobile_blueprint, verify_mobile_token
from .parsers import ParseError, parse_upload
from .ppt import PptService, create_ppt_blueprint
from .rag import FaissRagService
from .schedule import ScheduleParseError, day_window


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
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        psapi = ctypes.WinDLL("psapi", use_last_error=True)
        kernel32.GetCurrentProcess.restype = ctypes.c_void_p
        get_process_memory_info = psapi.GetProcessMemoryInfo
        get_process_memory_info.argtypes = [ctypes.c_void_p, ctypes.POINTER(PROCESS_MEMORY_COUNTERS_EX), ctypes.c_ulong]
        get_process_memory_info.restype = ctypes.c_int
        ok = get_process_memory_info(kernel32.GetCurrentProcess(), ctypes.byref(counters), counters.cb)
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
    if app.config.get("MOBILE_MODE") != "local":
        if len(str(app.config.get("MOBILE_PAIRING_CODE", ""))) < 12 or len(str(app.config.get("MOBILE_PAIRING_SECRET", ""))) < 32:
            raise RuntimeError("手机/LAN 模式需要至少 12 位配对码和 32 位签名密钥")

    database = Database(Path(app.config["DATABASE_PATH"]))
    database.initialize()
    # Versions before 0.1.1 inserted four demo documents.  Remove only records
    # marked builtin so a user upgrade keeps every personally imported document.
    database.remove_builtin_documents()
    rag = FaissRagService(
        database,
        Path(app.config["INDEX_DIR"]),
        str(app.config["EMBEDDING_MODEL_PATH"]),
        query_instruction=str(app.config["RAG_QUERY_INSTRUCTION"]),
        candidate_k=int(app.config["RAG_CANDIDATE_K"]),
        rerank_k=int(app.config["RAG_RERANK_K"]),
        evidence_token_budget=int(app.config["RAG_EVIDENCE_TOKEN_BUDGET"]),
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
        release_manifest=Path(str(app.config["LLAMA_RELEASE_MANIFEST"])),
        release_checksum=Path(str(app.config["LLAMA_RELEASE_CHECKSUM"])),
        release_required=bool(app.config["LLAMA_RELEASE_REQUIRED"]),
    )
    model_downloader = ModelReleaseDownloader(
        enabled=bool(app.config["MODEL_RELEASE_DOWNLOAD_ENABLED"]),
        repository=str(app.config["MODEL_RELEASE_REPOSITORY"]),
        release_tag=str(app.config["MODEL_RELEASE_TAG"]),
        models_dir=Path(str(app.config["MODELS_DIR"])),
        model_path=Path(str(app.config["LLAMA_MODEL_PATH"])),
        manifest_path=Path(str(app.config["LLAMA_RELEASE_MANIFEST"])),
        checksum_path=Path(str(app.config["LLAMA_RELEASE_CHECKSUM"])),
        n_ctx=int(app.config["LLAMA_N_CTX"]),
        release_required=bool(app.config["LLAMA_RELEASE_REQUIRED"]),
        timeout_seconds=int(app.config["MODEL_DOWNLOAD_TIMEOUT_SECONDS"]),
        max_bytes=int(app.config["MODEL_DOWNLOAD_MAX_BYTES"]),
        on_installed=inference.refresh_model_file_state,
        can_replace=inference.can_replace_model_file,
    )
    four_b_downloader = ModelReleaseDownloader(
        enabled=bool(app.config["MODEL_4B_DOWNLOAD_ENABLED"]),
        repository=str(app.config["MODEL_RELEASE_REPOSITORY"]),
        release_tag=str(app.config["MODEL_4B_RELEASE_TAG"]),
        models_dir=Path(str(app.config["MODELS_DIR"])),
        model_path=Path(str(app.config["MODEL_4B_MODEL_PATH"])),
        manifest_path=Path(str(app.config["MODEL_4B_RELEASE_MANIFEST"])),
        checksum_path=Path(str(app.config["MODEL_4B_RELEASE_CHECKSUM"])),
        n_ctx=int(app.config["LLAMA_N_CTX"]),
        # A 4B model is not considered downloadable until its release manifest
        # and acceptance gate are explicitly enabled by the maintainer.
        release_required=True,
        timeout_seconds=int(app.config["MODEL_DOWNLOAD_TIMEOUT_SECONDS"]),
        max_bytes=int(app.config["MODEL_DOWNLOAD_MAX_BYTES"]),
        can_replace=inference.can_replace_model_file,
    )
    model_downloaders = {"default": model_downloader, FOUR_B_MODEL_ID: four_b_downloader}
    ppt_service = PptService(
        database, Path(app.config["DATA_DIR"]), inference, int(app.config["MAX_UPLOAD_BYTES"]), int(app.config["MAX_PPTX_SLIDES"]),
        allow_external_renderer=not bool(app.config["TESTING"]),
    )

    def runtime_status() -> dict[str, Any]:
        return {
            "model": inference.status(),
            "modelDownload": model_downloader.status(),
            "models": build_model_catalog(app.config, inference, model_downloaders),
            "rag": rag.status(),
            "resources": {"rssMb": process_memory_mb()},
            "documentCount": len(database.list_documents()),
            **({"calendar": {
                "timezone": str(app.config["SCHEDULE_TIMEZONE"]),
                "storedEventCount": len(database.list_calendar_events()),
                "externalConnected": False,
                "mode": "local-sandbox",
            }} if app.config["CALENDAR_EXPERIMENTAL_ENABLED"] else {}),
            "ingestion": {
                "formats": ["txt", "md", "pdf", "docx", "xlsx", "csv", "pptx", "html"],
                "ocr": {"enabled": bool(app.config["OCR_ENABLED"]), "engine": "RapidOCR + ONNX Runtime", "maxPages": int(app.config["MAX_OCR_PAGES"])},
                "maxUploadMb": round(int(app.config["MAX_UPLOAD_BYTES"]) / 1024 / 1024),
            },
            "ppt": ppt_service.runtime(),
        }

    agent = AgentOrchestrator(
        database, rag, inference, runtime_status, rag_top_k=int(app.config["RAG_TOP_K"]),
        confirmation_ttl_seconds=int(app.config["AGENT_CONFIRMATION_TTL_SECONDS"]),
        user_id=str(app.config["AGENT_LOCAL_USER_ID"]),
        schedule_timezone=str(app.config["SCHEDULE_TIMEZONE"]),
        calendar_enabled=bool(app.config["CALENDAR_EXPERIMENTAL_ENABLED"]),
    )
    app.extensions["database"] = database
    app.extensions["rag"] = rag
    app.extensions["agent"] = agent
    app.extensions["inference"] = inference
    app.extensions["model_downloader"] = model_downloader
    app.extensions["model_downloaders"] = model_downloaders
    app.extensions["runtime_status"] = runtime_status
    app.extensions["ppt"] = ppt_service
    app.register_blueprint(create_ppt_blueprint(ppt_service))
    app.register_blueprint(create_mobile_blueprint(runtime_status, Path(app.config["DATA_DIR"]), int(app.config["MAX_UPLOAD_BYTES"])))

    @app.before_request
    def bind_local_session() -> Response | None:
        mobile_token = request.cookies.get("edge_office_mobile", "")
        authorization = request.headers.get("Authorization", "")
        if authorization.startswith("Bearer "):
            mobile_token = authorization[7:].strip()
        pairing_code = str(app.config.get("MOBILE_PAIRING_CODE", ""))
        pairing_secret = str(app.config.get("MOBILE_PAIRING_SECRET", ""))
        if mobile_token and pairing_code and verify_mobile_token(mobile_token, pairing_secret, pairing_code):
            token = mobile_token
            g.mobile_authenticated = True
        else:
            token = request.cookies.get("edge_office_session", "")
            g.mobile_authenticated = False
        remote = request.remote_addr not in {"127.0.0.1", "::1"}
        public_mobile = request.path in {"/api/v1/health", "/api/v1/mobile/bootstrap", "/api/v1/mobile/pair"}
        if remote and app.config.get("MOBILE_MODE") != "local" and request.path.startswith("/api/") and not public_mobile:
            if not g.mobile_authenticated:
                return jsonify({"error": {"code": "MOBILE_PAIRING_REQUIRED", "message": "请先配对手机"}}), 401
            if request.method not in {"GET", "HEAD", "OPTIONS"}:
                origin = request.headers.get("Origin", "")
                if origin and origin != request.host_url.rstrip("/"):
                    return jsonify({"error": {"code": "INVALID_ORIGIN", "message": "请求来源不受信任"}}), 403
        if g.mobile_authenticated:
            g.local_session_id = hashlib.sha256(token.encode("utf-8")).hexdigest()
        else:
            if not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", token):
                token = secrets.token_urlsafe(32)
                g.set_local_session_cookie = True
                g.local_session_token = token
            g.local_session_id = hashlib.sha256(token.encode("utf-8")).hexdigest()
        profile_token = request.cookies.get("edge_office_profile", "")
        if not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", profile_token):
            profile_token = secrets.token_urlsafe(32)
            g.set_profile_cookie = True
            g.local_profile_token = profile_token
        g.local_profile_id = hashlib.sha256(profile_token.encode("utf-8")).hexdigest()

    @app.after_request
    def persist_local_session(response: Response) -> Response:
        if getattr(g, "set_local_session_cookie", False):
            response.set_cookie(
                "edge_office_session", g.local_session_token,
                max_age=24 * 60 * 60, httponly=True, samesite="Strict", secure=False,
            )
        if getattr(g, "set_profile_cookie", False):
            response.set_cookie(
                "edge_office_profile", g.local_profile_token,
                max_age=365 * 24 * 60 * 60, httponly=True, samesite="Strict", secure=False,
            )
        return response

    @app.get("/")
    def home() -> Response:
        return send_from_directory(app.static_folder, "index.html")

    @app.get("/api/v1/health")
    def health() -> Response:
        return jsonify({"status": "ok", "appVersion": str(app.config["APP_VERSION"]), "apiVersion": "0.2", "modelStatus": inference.status()["status"], "indexStatus": "ready" if rag.status()["ready"] else "building"})

    @app.get("/api/v1/runtime/status")
    def get_runtime_status() -> Response:
        return jsonify(runtime_status())

    @app.get("/api/v1/model/download")
    def model_download_status() -> Response:
        return jsonify({"item": model_downloader.status()})

    @app.post("/api/v1/model/download")
    def start_model_download() -> Response:
        payload = request.get_json(silent=True)
        if payload not in (None, {}):
            return error("UNTRUSTED_MODEL_DOWNLOAD_PAYLOAD", "模型下载不接受自定义链接或路径", 400)
        try:
            return jsonify({"item": model_downloader.start()}), 202
        except ModelDownloadError as exc:
            return error("MODEL_DOWNLOAD_UNAVAILABLE", str(exc), 409)

    @app.get("/api/v1/models")
    def list_models() -> Response:
        return jsonify({"items": build_model_catalog(app.config, inference, model_downloaders)})

    @app.get("/api/v1/models/<model_id>/download")
    def model_profile_download_status(model_id: str) -> Response:
        downloader = model_downloaders.get(model_id)
        if downloader is None:
            return error("MODEL_NOT_FOUND", "未找到该模型配置", 404)
        return jsonify({"item": downloader.status(), "modelId": model_id})

    @app.post("/api/v1/models/<model_id>/download")
    def start_model_profile_download(model_id: str) -> Response:
        payload = request.get_json(silent=True)
        if payload not in (None, {}):
            return error("UNTRUSTED_MODEL_DOWNLOAD_PAYLOAD", "模型下载不接受自定义链接或路径", 400)
        downloader = model_downloaders.get(model_id)
        if downloader is None:
            return error("MODEL_NOT_FOUND", "未找到该模型配置", 404)
        try:
            return jsonify({"item": downloader.start(), "modelId": model_id}), 202
        except ModelDownloadError as exc:
            code = "MODEL_RELEASE_NOT_READY" if model_id == FOUR_B_MODEL_ID and not app.config["MODEL_4B_DOWNLOAD_ENABLED"] else "MODEL_DOWNLOAD_UNAVAILABLE"
            return error(code, str(exc) if app.config["MODEL_4B_DOWNLOAD_ENABLED"] or model_id != FOUR_B_MODEL_ID else "4B 模型仍在开发和验收中，当前 Release 尚未开放下载", 409)

    @app.get("/api/v1/preferences")
    def get_preferences() -> Response:
        return jsonify({"item": database.get_preferences(g.local_profile_id)})

    @app.put("/api/v1/preferences")
    def update_preferences() -> Response:
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return error("INVALID_PREFERENCES", "偏好设置必须是 JSON 对象", 400)
        changes: dict[str, Any] = {}
        for api_key, database_key in {
            "displayName": "display_name", "role": "role", "writingTone": "writing_tone", "lastView": "last_view",
        }.items():
            if api_key in payload:
                value = str(payload[api_key]).strip()
                if len(value) > 40:
                    return error("INVALID_PREFERENCES", f"{api_key} 不能超过 40 个字符", 400)
                changes[database_key] = value
        if "writingTone" in payload and changes.get("writing_tone") not in {"professional", "concise", "natural"}:
            return error("INVALID_PREFERENCES", "writingTone 不在允许范围内", 400)
        if "lastView" in payload and changes.get("last_view") not in {"home", "chat", "knowledge", "ppt", "tools"}:
            return error("INVALID_PREFERENCES", "lastView 不在允许范围内", 400)
        for api_key, database_key in {"ragEnabled": "rag_enabled", "onboardingComplete": "onboarding_complete"}.items():
            if api_key in payload:
                if not isinstance(payload[api_key], bool):
                    return error("INVALID_PREFERENCES", f"{api_key} 必须是布尔值", 400)
                changes[database_key] = payload[api_key]
        for api_key, database_key in {"pinnedTools": "pinned_tools", "seenTips": "seen_tips"}.items():
            if api_key in payload:
                value = payload[api_key]
                if not isinstance(value, list) or len(value) > 12 or any(not isinstance(item, str) or len(item) > 32 for item in value):
                    return error("INVALID_PREFERENCES", f"{api_key} 格式不正确", 400)
                changes[database_key] = value
        return jsonify({"item": database.update_preferences(g.local_profile_id, changes)})

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
        payload = request.get_json(silent=True) if not uploaded else None
        staged_name = ""
        if uploaded and uploaded.filename:
            staged_name = Path(uploaded.filename).name
            data = uploaded.stream.read(int(app.config["MAX_UPLOAD_BYTES"]) + 1)
        elif isinstance(payload, dict) and payload.get("uploadId"):
            upload_id = str(payload.get("uploadId"))
            if not re.fullmatch(r"[0-9a-f-]{36}", upload_id):
                return error("UPLOAD_NOT_FOUND", "上传任务不存在", 404)
            upload_root = Path(app.config["DATA_DIR"]) / "mobile_uploads" / upload_id
            metadata_path = upload_root / "metadata.json"
            if not metadata_path.is_file():
                return error("UPLOAD_NOT_FOUND", "上传任务不存在", 404)
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            staged_name = Path(str(metadata.get("name") or "upload.bin")).name
            staged_file = upload_root / staged_name
            if not staged_file.is_file():
                return error("UPLOAD_INCOMPLETE", "上传文件尚未合并", 409)
            data = staged_file.read_bytes()
        else:
            return error("FILE_REQUIRED", "请选择要导入的文件", 400)
        security_level = str((request.form.get("securityLevel") if not payload else payload.get("securityLevel")) or "internal")
        if security_level not in {"public", "internal"}:
            return error("INVALID_SECURITY_LEVEL", "仅支持 public 或 internal 材料级别", 400)
        if len(data) > int(app.config["MAX_UPLOAD_BYTES"]):
            return error("FILE_TOO_LARGE", "文件超过当前 20MB 限制", 413)
        try:
            parsed = parse_upload(
                staged_name, data, int(app.config["MAX_DOCUMENT_CHARACTERS"]),
                ocr_enabled=bool(app.config["OCR_ENABLED"]), max_pdf_pages=int(app.config["MAX_PDF_PAGES"]),
                max_ocr_pages=int(app.config["MAX_OCR_PAGES"]), max_sheets=int(app.config["MAX_XLSX_SHEETS"]),
                max_sheet_rows=int(app.config["MAX_XLSX_ROWS_PER_SHEET"]),
                max_sheet_columns=int(app.config["MAX_XLSX_COLUMNS"]), max_slides=int(app.config["MAX_PPTX_SLIDES"]),
            )
        except ParseError as exc:
            return error(exc.code, str(exc), 400)
        item = database.create_document(
            staged_name, parsed.content, security_level=security_level, mime_type=parsed.mime_type,
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

    @app.get("/api/v1/calendar/events")
    def calendar_events() -> Response:
        if not app.config["CALENDAR_EXPERIMENTAL_ENABLED"]:
            return error("FEATURE_UNAVAILABLE", "日历功能未在当前版本开放", 404)
        date_text = str(request.args.get("date") or "").strip()
        start_at = str(request.args.get("start") or "").strip() or None
        end_at = str(request.args.get("end") or "").strip() or None
        if date_text:
            try:
                start_at, end_at = day_window(date_text, timezone=str(app.config["SCHEDULE_TIMEZONE"]))
            except ScheduleParseError as exc:
                return error("INVALID_CALENDAR_DATE", str(exc), 400)
        return jsonify({"items": database.list_calendar_events(start_at=start_at, end_at=end_at), "timezone": str(app.config["SCHEDULE_TIMEZONE"])})

    @app.get("/api/v1/calendar/conflicts")
    def calendar_conflicts() -> Response:
        if not app.config["CALENDAR_EXPERIMENTAL_ENABLED"]:
            return error("FEATURE_UNAVAILABLE", "日历功能未在当前版本开放", 404)
        start_at = str(request.args.get("start") or "").strip()
        end_at = str(request.args.get("end") or "").strip()
        if not start_at or not end_at:
            return error("CALENDAR_WINDOW_REQUIRED", "冲突检查需要 start 和 end 参数", 400)
        if len(start_at) > 64 or len(end_at) > 64:
            return error("INVALID_CALENDAR_WINDOW", "时间范围格式不正确", 400)
        return jsonify({"items": database.find_calendar_conflicts(start_at, end_at), "timezone": str(app.config["SCHEDULE_TIMEZONE"])})

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
        return jsonify({"items": agent.tools(calendar_enabled=agent.calendar_enabled), "policyVersion": "edge-office-agent-policy/1.0", "sandbox": True})

    @app.post("/api/v1/plans")
    def create_plan() -> Response:
        payload = request.get_json(silent=True) or {}
        message = str(payload.get("message") or "").strip()
        if not message:
            return error("EMPTY_MESSAGE", "请输入任务描述", 400)
        conversation_id = str(payload.get("conversationId") or "") or None
        if conversation_id and not database.get_conversation(conversation_id):
            return error("CONVERSATION_NOT_FOUND", "会话不存在", 404)
        plan = agent.plan(message, conversation_id, payload.get("ragEnabled") is not False, str(uuid4()), session_id=g.local_session_id)
        return jsonify({"item": plan}), 201

    @app.get("/api/v1/plans/<plan_id>")
    def get_plan(plan_id: str) -> Response:
        plan = database.get_agent_plan(plan_id)
        return jsonify({"item": plan}) if plan else error("PLAN_NOT_FOUND", "计划不存在", 404)

    @app.post("/api/v1/plans/<plan_id>/confirm")
    def confirm_plan(plan_id: str) -> Response:
        payload = request.get_json(silent=True)
        if payload not in (None, {}):
            return error("UNTRUSTED_CONFIRMATION_PAYLOAD", "确认请求只能由计划 ID 触发", 400)
        try:
            result = agent.confirm(plan_id, session_id=g.local_session_id)
            return jsonify(result)
        except PlanValidationError as exc:
            return error(exc.code, str(exc), 409 if exc.code.startswith("CONFIRMATION_") or exc.code == "FEATURE_UNAVAILABLE" else 400)

    @app.post("/api/v1/plans/<plan_id>/cancel")
    def cancel_plan(plan_id: str) -> Response:
        try:
            return jsonify({"item": agent.cancel(plan_id, session_id=g.local_session_id)})
        except PlanValidationError as exc:
            return error(exc.code, str(exc), 404 if exc.code == "PLAN_NOT_FOUND" else 409)

    @app.get("/api/v1/audit/<request_id>")
    def get_audit(request_id: str) -> Response:
        return jsonify(database.audit_for_request(request_id))

    @app.post("/api/v1/agent/runs")
    def run_agent() -> Response:
        payload = request.get_json(silent=True) or {}
        message = str(payload.get("message") or "").strip()
        display_message = str(payload.get("displayMessage") or message).strip()
        if not message:
            return error("EMPTY_MESSAGE", "请输入问题", 400)
        if not display_message or len(display_message) > 1000:
            return error("INVALID_DISPLAY_MESSAGE", "对话显示文本不能为空且不能超过 1000 个字符", 400)
        conversation_id = str(payload.get("conversationId") or "")
        if not conversation_id:
            conversation_id = database.create_conversation()["id"]
        if not database.get_conversation(conversation_id):
            return error("CONVERSATION_NOT_FOUND", "会话不存在", 404)
        database.add_message(conversation_id, "user", display_message)
        request_id = str(uuid4())
        answer, citations, info, _ = agent.execute(message, conversation_id, payload.get("ragEnabled") is not False, request_id=request_id, session_id=g.local_session_id)
        timings = info.get("timings", {})
        database.add_message(conversation_id, "assistant", answer, citations, {"agentAction": info["action"], **timings})
        return jsonify({"conversationId": conversation_id, "answer": answer, "citations": citations, "run": info})

    @app.post("/api/v1/chat/stream")
    def chat_stream() -> Response:
        payload = request.get_json(silent=True) or {}
        message = str(payload.get("message") or "").strip()
        display_message = str(payload.get("displayMessage") or message).strip()
        if not message:
            return error("EMPTY_MESSAGE", "请输入问题", 400)
        if not display_message or len(display_message) > 1000:
            return error("INVALID_DISPLAY_MESSAGE", "对话显示文本不能为空且不能超过 1000 个字符", 400)
        conversation_id = str(payload.get("conversationId") or "")
        if not conversation_id:
            conversation_id = database.create_conversation()["id"]
        if not database.get_conversation(conversation_id):
            return error("CONVERSATION_NOT_FOUND", "会话不存在", 404)
        rag_enabled = payload.get("ragEnabled") is not False
        database.add_message(conversation_id, "user", display_message)

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
                answer, citations, run, agent_events = agent.execute(message, conversation_id, rag_enabled, request_id=request_id, session_id=g.local_session_id)
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
                timings = run.get("timings", {})
                response_latency_ms = max(1, round((first_token_at - began) * 1000))
                metrics = {
                    "responseLatencyMs": response_latency_ms,
                    "ttftMs": response_latency_ms,
                    "planningMs": timings.get("planningMs"),
                    "retrievalMs": timings.get("retrievalMs"),
                    "generationMs": timings.get("modelGenerationMs"),
                    "tokensPerSecond": timings.get("tokensPerSecond"),
                    "promptTokens": timings.get("promptTokens"),
                    "completionTokens": timings.get("completionTokens"),
                    "peakRssMb": process_memory_mb(),
                    "agentAction": run["action"],
                    "ragEnabled": rag_enabled,
                }
                database.add_message(conversation_id, "assistant", emitted, citations, metrics)
                yield sse("metrics", metrics)
                yield sse("done", {"finishReason": "stop", "usage": {"inputTokens": timings.get("promptTokens"), "outputTokens": timings.get("completionTokens")}})
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
