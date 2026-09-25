from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from pathlib import Path
from typing import Any, Callable
from uuid import uuid4

from flask import Blueprint, Response, current_app, g, jsonify, request


def _signature(payload: str, secret: str, code: str) -> str:
    digest = hmac.new(secret.encode("utf-8"), f"{payload}.{code}".encode("utf-8"), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def create_mobile_token(secret: str, code: str) -> str:
    payload = f"{int(time.time())}.{secrets.token_urlsafe(18)}"
    return f"{payload}.{_signature(payload, secret, code)}"


def verify_mobile_token(token: str, secret: str, code: str, max_age: int = 30 * 24 * 60 * 60) -> bool:
    try:
        issued, nonce, signature = token.split(".", 2)
        issued_at = int(issued)
        if not nonce or not 0 <= int(time.time()) - issued_at <= max_age:
            return False
        return hmac.compare_digest(signature, _signature(f"{issued}.{nonce}", secret, code))
    except (TypeError, ValueError):
        return False


def create_mobile_blueprint(runtime_status: Callable[[], dict[str, Any]], data_dir: Path, max_upload_bytes: int) -> Blueprint:
    blueprint = Blueprint("mobile", __name__)
    failed_attempts: dict[str, list[float]] = {}
    upload_root = Path(data_dir) / "mobile_uploads"

    @blueprint.get("/api/v1/mobile/bootstrap")
    def bootstrap() -> Response:
        runtime = runtime_status()
        model = runtime.get("model", {})
        ppt_capability = runtime.get("ppt", {}).get("capability", {})
        pairing_required = bool(current_app.config.get("MOBILE_PAIRING_CODE"))
        return jsonify({
            "appVersion": str(current_app.config.get("MOBILE_APP_VERSION", "0.2.0")),
            "apiVersion": "0.3",
            "mode": str(current_app.config.get("MOBILE_MODE", "local")),
            "pairingRequired": pairing_required,
            "paired": bool(getattr(g, "mobile_authenticated", False)) or not pairing_required,
            "capabilities": {
                "rag": bool(runtime.get("rag", {}).get("ready")),
                "agent": True,
                "ppt": True,
                "streaming": True,
                "localInference": model.get("status") == "ready",
                "resumableUpload": True,
            },
            "model": {
                "name": model.get("modelName") or model.get("modelPath"),
                "status": model.get("status"),
                "pptRecommended": bool(ppt_capability.get("recommended", False)),
                "pptWarning": ppt_capability.get("warning"),
            },
            "limits": {"maxUploadBytes": max_upload_bytes},
        })

    @blueprint.get("/api/v1/mobile/capabilities")
    def capabilities() -> Response:
        return bootstrap()

    @blueprint.post("/api/v1/mobile/pair")
    def pair() -> Response:
        configured = str(current_app.config.get("MOBILE_PAIRING_CODE", ""))
        if not configured:
            return jsonify({"error": {"code": "PAIRING_DISABLED", "message": "当前服务未启用手机配对"}}), 503
        peer = request.remote_addr or "unknown"
        now = time.monotonic()
        attempts = [stamp for stamp in failed_attempts.get(peer, []) if now - stamp < 600]
        if len(attempts) >= 5:
            return jsonify({"error": {"code": "PAIRING_RATE_LIMITED", "message": "尝试次数过多，请稍后再试"}}), 429
        payload = request.get_json(silent=True)
        code = str(payload.get("code") or "").strip() if isinstance(payload, dict) else ""
        if not hmac.compare_digest(code, configured):
            failed_attempts[peer] = attempts + [now]
            return jsonify({"error": {"code": "PAIRING_CODE_INVALID", "message": "配对码不正确"}}), 401
        failed_attempts.pop(peer, None)
        secret = str(current_app.config["MOBILE_PAIRING_SECRET"])
        token = create_mobile_token(secret, code)
        response = jsonify({"item": {"paired": True}})
        response.set_cookie("edge_office_mobile", token, max_age=30 * 24 * 60 * 60, httponly=True, samesite="Strict", secure=request.is_secure)
        return response

    @blueprint.post("/api/v1/mobile/unpair")
    def unpair() -> Response:
        response = jsonify({"ok": True})
        response.delete_cookie("edge_office_mobile", samesite="Strict")
        return response

    @blueprint.post("/api/v1/uploads/init")
    def init_upload() -> Response:
        payload = request.get_json(silent=True) or {}
        name = Path(str(payload.get("name") or "upload.bin")).name[:120]
        try:
            size = int(payload.get("size"))
        except (TypeError, ValueError):
            return jsonify({"error": {"code": "INVALID_UPLOAD_SIZE", "message": "上传大小不正确"}}), 400
        if size <= 0 or size > max_upload_bytes:
            return jsonify({"error": {"code": "FILE_TOO_LARGE", "message": "文件超过当前上传限制"}}), 413
        upload_id = str(uuid4())
        root = upload_root / upload_id
        root.mkdir(parents=True, exist_ok=False)
        metadata = {"id": upload_id, "name": name, "size": size, "received": 0, "createdAt": int(time.time())}
        (root / "metadata.json").write_text(json.dumps(metadata, ensure_ascii=False), encoding="utf-8")
        return jsonify({"item": {**metadata, "chunkBytes": int(current_app.config.get("MOBILE_UPLOAD_CHUNK_BYTES", 5 * 1024 * 1024))}}), 201

    @blueprint.put("/api/v1/uploads/<upload_id>/parts/<int:part_no>")
    def upload_part(upload_id: str, part_no: int) -> Response:
        root = upload_root / upload_id
        metadata_path = root / "metadata.json"
        if part_no < 0 or not metadata_path.is_file():
            return jsonify({"error": {"code": "UPLOAD_NOT_FOUND", "message": "上传任务不存在"}}), 404
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        data = request.get_data(cache=False)
        chunk_bytes = int(current_app.config.get("MOBILE_UPLOAD_CHUNK_BYTES", 5 * 1024 * 1024))
        if not data or len(data) > chunk_bytes:
            return jsonify({"error": {"code": "INVALID_UPLOAD_PART", "message": "分片大小不正确"}}), 400
        part_path = root / f"part-{part_no:08d}.bin"
        if not part_path.exists():
            metadata["received"] = int(metadata.get("received", 0)) + len(data)
        if metadata["received"] > int(metadata["size"]):
            return jsonify({"error": {"code": "UPLOAD_SIZE_MISMATCH", "message": "上传数据超过声明大小"}}), 400
        part_path.write_bytes(data)
        metadata_path.write_text(json.dumps(metadata, ensure_ascii=False), encoding="utf-8")
        return jsonify({"item": {"uploadId": upload_id, "part": part_no, "received": metadata["received"], "size": metadata["size"]}})

    @blueprint.post("/api/v1/uploads/<upload_id>/complete")
    def complete_upload(upload_id: str) -> Response:
        root = upload_root / upload_id
        metadata_path = root / "metadata.json"
        if not metadata_path.is_file():
            return jsonify({"error": {"code": "UPLOAD_NOT_FOUND", "message": "上传任务不存在"}}), 404
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        if int(metadata.get("received", 0)) != int(metadata.get("size", 0)):
            return jsonify({"error": {"code": "UPLOAD_INCOMPLETE", "message": "分片尚未全部上传"}}), 409
        output = root / metadata["name"]
        with output.open("wb") as handle:
            for part in sorted(root.glob("part-*.bin")):
                handle.write(part.read_bytes())
        digest = hashlib.sha256(output.read_bytes()).hexdigest()
        return jsonify({"item": {"uploadId": upload_id, "name": metadata["name"], "size": metadata["size"], "sha256": digest}}), 201

    return blueprint
