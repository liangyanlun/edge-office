from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Generator

from flask import Blueprint, Response, current_app, jsonify, request, send_file, stream_with_context

from .service import PptService, PptServiceError


def create_ppt_blueprint(service: PptService) -> Blueprint:
    blueprint = Blueprint("ppt", __name__)

    @blueprint.get("/api/v1/presentations")
    def list_presentations() -> Response:
        return jsonify({"items": service.list_presentations(), "runtime": service.runtime()})

    @blueprint.post("/api/v1/presentations/import")
    def import_presentation() -> tuple[Response, int] | Response:
        uploaded = request.files.get("file")
        if not uploaded or not uploaded.filename:
            return _error("PPT_FILE_REQUIRED", "请选择要导入的 .pptx 文件", 400)
        data = uploaded.stream.read(service.max_upload_bytes + 1)
        return jsonify({"item": service.import_presentation(uploaded.filename, data)}), 201

    @blueprint.get("/api/v1/presentations/<presentation_id>")
    def get_presentation(presentation_id: str) -> Response:
        return jsonify({"item": service.get_presentation(presentation_id)})

    @blueprint.get("/api/v1/presentations/<presentation_id>/slides")
    def slides(presentation_id: str) -> Response:
        return jsonify(service.slides(presentation_id))

    @blueprint.get("/api/v1/presentations/<presentation_id>/slides/<slide_id>/snapshot")
    def slide_snapshot(presentation_id: str, slide_id: str) -> Response:
        return jsonify(service.slide_snapshot(presentation_id, slide_id))

    @blueprint.post("/api/v1/presentations/<presentation_id>/assets")
    def upload_asset(presentation_id: str) -> tuple[Response, int] | Response:
        uploaded = request.files.get("file")
        if not uploaded or not uploaded.filename:
            return _error("PPT_IMAGE_REQUIRED", "请选择替换图片", 400)
        data = uploaded.stream.read(12 * 1024 * 1024 + 1)
        item = service.upload_asset(presentation_id, uploaded.filename, uploaded.mimetype or "application/octet-stream", data)
        return jsonify({"item": item}), 201

    @blueprint.post("/api/v1/presentations/<presentation_id>/patches")
    def create_patch(presentation_id: str) -> tuple[Response, int] | Response:
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return _error("PPT_PATCH_INPUT_INVALID", "PPT 修改要求必须是 JSON 对象", 400)
        manual = str(payload.get("apiSequence")) if current_app.testing and payload.get("apiSequence") is not None else None
        return jsonify({"item": service.create_patch(presentation_id, payload, api_sequence=manual)}), 201

    @blueprint.get("/api/v1/ppt-patches/<patch_id>")
    def get_patch(patch_id: str) -> Response:
        return jsonify({"item": service.get_patch(patch_id)})

    @blueprint.post("/api/v1/ppt-patches/<patch_id>/simulate")
    def simulate(patch_id: str) -> Response:
        return jsonify({"item": service.simulate(patch_id)})

    @blueprint.post("/api/v1/ppt-patches/<patch_id>/confirm")
    def confirm(patch_id: str) -> Response:
        payload = request.get_json(silent=True)
        if payload not in (None, {}):
            return _error("PPT_CONFIRMATION_PAYLOAD_FORBIDDEN", "确认只接受 patch_id，不接受操作参数", 400)
        return jsonify(service.confirm(patch_id))

    @blueprint.post("/api/v1/ppt-patches/<patch_id>/cancel")
    def cancel(patch_id: str) -> Response:
        return jsonify({"item": service.cancel(patch_id)})

    @blueprint.get("/api/v1/ppt-jobs/<job_id>/events")
    def events(job_id: str) -> Response:
        def generate() -> Generator[str, None, None]:
            for item in service.events(job_id):
                yield f"event: {item['type']}\ndata: {json.dumps(item['data'], ensure_ascii=False)}\n\n"
            yield "event: done\ndata: {}\n\n"
        response = Response(stream_with_context(generate()), mimetype="text/event-stream")
        response.headers["Cache-Control"] = "no-cache, no-transform"
        response.headers["X-Accel-Buffering"] = "no"
        return response

    @blueprint.get("/api/v1/presentations/<presentation_id>/versions/<version_id>/download")
    def download(presentation_id: str, version_id: str) -> Response:
        path = service.version_file(presentation_id, version_id)
        return send_file(path, as_attachment=True, download_name=f"edge-office-{version_id[:20]}.pptx", mimetype="application/vnd.openxmlformats-officedocument.presentationml.presentation")

    @blueprint.post("/api/v1/presentations/<presentation_id>/versions/<version_id>/restore")
    def restore(presentation_id: str, version_id: str) -> Response:
        payload = request.get_json(silent=True)
        if payload not in (None, {}):
            return _error("PPT_RESTORE_PAYLOAD_FORBIDDEN", "恢复版本只接受版本 ID", 400)
        return jsonify({"item": service.restore(presentation_id, version_id)})

    @blueprint.get("/api/v1/presentations/<presentation_id>/versions/<version_id>/slides/<slide_id>/preview")
    def version_preview(presentation_id: str, version_id: str, slide_id: str) -> Response:
        return send_file(service.preview_file(presentation_id, version_id, slide_id), mimetype="image/png", conditional=True)

    @blueprint.get("/api/v1/ppt-patches/<patch_id>/slides/<slide_id>/preview")
    def patch_preview(patch_id: str, slide_id: str) -> Response:
        return send_file(service.patch_preview_file(patch_id, slide_id), mimetype="image/png", conditional=True)

    @blueprint.errorhandler(PptServiceError)
    def handle_service_error(exc: PptServiceError) -> tuple[Response, int]:
        return _error(exc.code, str(exc), exc.status)

    return blueprint


def _error(code: str, message: str, status: int) -> tuple[Response, int]:
    return jsonify({"error": {"code": code, "message": message}}), status
