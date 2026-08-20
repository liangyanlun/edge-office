from __future__ import annotations

from pathlib import Path
from io import BytesIO

import pytest

from backend.app import create_app
from backend.agent import AgentOrchestrator, PlanValidationError, parse_action_plan
from backend.config import ROOT_DIR
from backend.inference import InferenceAdapter
from backend.parsers import ParseError, parse_upload


@pytest.fixture()
def app(tmp_path: Path):
    application = create_app(
        {
            "ROOT_DIR": ROOT_DIR,
            "DATA_DIR": tmp_path / "data",
            "INDEX_DIR": tmp_path / "indexes",
            "MODELS_DIR": tmp_path / "models",
            "DATABASE_PATH": tmp_path / "data" / "test.db",
            "EMBEDDING_MODEL_PATH": "",
            "LLAMA_CPP_ENABLED": False,
            "OCR_ENABLED": False,
            "TESTING": True,
        }
    )
    yield application


@pytest.fixture()
def client(app):
    return app.test_client()


def test_health_and_faiss_index_are_ready(client, app, tmp_path: Path):
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    assert response.get_json()["status"] == "ok"
    assert (tmp_path / "indexes" / "knowledge.faiss").exists()
    runtime = client.get("/api/v1/runtime/status").get_json()
    assert runtime["rag"]["chunkCount"] > 0
    assert runtime["rag"]["embedding"]["mode"] == "offline-fallback"
    assert runtime["ingestion"]["formats"] == ["txt", "md", "pdf", "docx", "xlsx", "csv", "pptx", "html"]
    assert runtime["ingestion"]["ocr"]["enabled"] is False


def test_faiss_index_can_be_written_under_a_chinese_path(tmp_path: Path):
    unicode_root = tmp_path / "大创索引"
    application = create_app(
        {
            "ROOT_DIR": ROOT_DIR,
            "DATA_DIR": unicode_root / "数据",
            "INDEX_DIR": unicode_root / "索引",
            "MODELS_DIR": unicode_root / "模型",
            "DATABASE_PATH": unicode_root / "数据" / "test.db",
            "EMBEDDING_MODEL_PATH": "",
            "LLAMA_CPP_ENABLED": False,
            "TESTING": True,
        }
    )
    assert application.test_client().get("/api/v1/health").status_code == 200
    assert (unicode_root / "索引" / "knowledge.faiss").exists()


def test_document_import_builds_faiss_and_returns_cited_sse(client):
    imported = client.post(
        "/api/v1/documents",
        json={"name": "中期检查通知.md", "content": "中期检查材料需要在周五前提交，并附上实验记录和运行截图。"},
    )
    assert imported.status_code == 201
    assert imported.get_json()["index"]["chunks"] >= 5

    stream = client.post("/api/v1/chat/stream", json={"message": "中期检查材料什么时候提交？", "ragEnabled": True})
    body = stream.data.decode("utf-8")
    assert stream.status_code == 200
    assert "event: plan" in body
    assert "event: tool_start" in body
    assert "event: citations" in body
    assert "中期检查通知.md" in body
    assert "周五前提交" in body
    assert "event: done" in body


def test_agent_lists_documents_and_persists_the_conversation(client):
    response = client.post("/api/v1/agent/runs", json={"message": "有哪些材料可以查看？", "ragEnabled": True})
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["run"]["action"] == "list_documents"
    assert "项目综述" in payload["answer"]
    conversation = client.get(f"/api/v1/conversations/{payload['conversationId']}").get_json()["item"]
    assert len(conversation["messages"]) == 2


def test_rag_persists_provenance_and_atomic_generation(app, client, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    imported = client.post(
        "/api/v1/documents",
        json={"name": "保密事项.md", "content": "内部代号 ORION 只允许项目组成员查看。", "securityLevel": "internal"},
    )
    assert imported.status_code == 201
    item = imported.get_json()["item"]
    assert item["versionId"].startswith(f"{item['id']}@")
    assert len(item["fileSha256"]) == 64
    assert item["securityLevel"] == "internal"

    rag = app.extensions["rag"]
    first_generation = rag.status()["activeGeneration"]
    assert (tmp_path / "indexes" / "active.json").exists()
    assert (tmp_path / "indexes" / "generations" / first_generation / "manifest.json").exists()
    assert rag.search("ORION", top_k=1)[0]["chunkId"].startswith(item["versionId"])

    original_encode_passages = rag.embedder.encode_passages
    monkeypatch.setattr(rag.embedder, "encode_passages", lambda _: (_ for _ in ()).throw(RuntimeError("embedding failed")))
    with pytest.raises(RuntimeError, match="embedding failed"):
        rag.rebuild()
    monkeypatch.setattr(rag.embedder, "encode_passages", original_encode_passages)
    assert rag.status()["activeGeneration"] == first_generation
    assert rag.search("ORION", top_k=1)[0]["documentId"] == item["id"]


def test_rag_filters_before_scoring_rejects_low_confidence_and_audits(app, client):
    internal = client.post(
        "/api/v1/documents",
        json={"name": "内部计划.md", "content": "ORION-77 将于周五提交，只供内部查看。", "securityLevel": "internal"},
    ).get_json()["item"]
    public = client.post(
        "/api/v1/documents",
        json={"name": "公开说明.md", "content": "本项目面向日常办公场景。", "securityLevel": "public"},
    ).get_json()["item"]
    rag = app.extensions["rag"]

    denied = rag.search("ORION-77 什么时候提交？", top_k=2, allowed_security_levels={"public"}, request_id="denied-request")
    assert denied == []
    allowed = rag.search("ORION-77 什么时候提交？", top_k=2, document_ids=[internal["id"]], request_id="allowed-request")
    assert allowed and all(item["documentId"] == internal["id"] for item in allowed)
    assert all("chunkId" in item and "quoteSha256" in item and "quoteEnd" in item for item in allowed)
    assert rag.search("完全不存在的编号 ZXQ-9999", top_k=2) == []

    database = app.extensions["database"]
    with database.connect() as connection:
        denied_event = connection.execute("SELECT status FROM retrieval_events WHERE request_id = ?", ("denied-request",)).fetchone()
        allowed_event = connection.execute("SELECT status, evidence_json FROM retrieval_events WHERE request_id = ?", ("allowed-request",)).fetchone()
    assert denied_event["status"] == "insufficient_confidence"
    assert allowed_event["status"] == "ok"
    assert "ORION-77" not in allowed_event["evidence_json"]
    assert public["id"] != internal["id"]


def test_model_citation_validation_only_keeps_returned_evidence():
    evidence = [{"chunkId": "doc@v#chunk-1", "quote": "证据"}]
    answer = InferenceAdapter._ensure_citations("模型错误标注【9】。", evidence)
    assert "【9】" not in answer
    assert "【1】" in answer


def test_action_plan_rejects_invented_confirmation_unknown_fields_and_path_escape():
    with pytest.raises(PlanValidationError, match="模型不能确认"):
        parse_action_plan('{"tool":"email_send","arguments":{"to":"a@example.com","subject":"s","body":"b"},"confirmed":true}')
    with pytest.raises(PlanValidationError, match="只能包含"):
        parse_action_plan('{"tool":"document_search","arguments":{"query":"x"},"confirmed":false,"admin":true}')
    with pytest.raises(PlanValidationError, match="允许范围"):
        parse_action_plan('{"tool":"file_overwrite","arguments":{"path":"..\\\\secret.txt","content":"x"},"confirmed":false}')


def test_high_risk_plan_requires_bound_single_use_confirmation_and_is_audited(client, app):
    created = client.post("/api/v1/plans", json={"message": "请发送邮件给 team@example.com，主题是中期检查，正文是材料已准备完成。", "ragEnabled": False})
    assert created.status_code == 201
    plan = created.get_json()["item"]
    assert plan["tool"] == "email_send"
    assert plan["status"] == "AWAITING_CONFIRMATION"
    assert plan["confirmationId"] and plan["confirmationNonce"]

    confirmed = client.post(
        f"/api/v1/plans/{plan['id']}/confirm",
        json={"confirmationId": plan["confirmationId"], "confirmationNonce": plan["confirmationNonce"]},
    )
    assert confirmed.status_code == 200
    assert confirmed.get_json()["plan"]["status"] == "SUCCEEDED"
    assert "沙箱" in confirmed.get_json()["answer"]
    replay = client.post(
        f"/api/v1/plans/{plan['id']}/confirm",
        json={"confirmationId": plan["confirmationId"], "confirmationNonce": plan["confirmationNonce"]},
    )
    assert replay.status_code == 409

    audit = client.get(f"/api/v1/audit/{plan['requestId']}").get_json()
    assert audit["plans"][0]["status"] == "SUCCEEDED"
    assert {event["type"] for event in audit["plans"][0]["events"]} >= {"PLANNED", "VALIDATED", "CONFIRMED", "EXECUTING", "SUCCEEDED"}


def test_expired_confirmation_fails_closed(client, app):
    plan = client.post("/api/v1/plans", json={"message": "请发送邮件给 team@example.com，主题是中期检查，正文是材料已准备完成。"}).get_json()["item"]
    database = app.extensions["database"]
    with database.connect() as connection:
        connection.execute("UPDATE agent_plans SET expires_at = '2000-01-01T00:00:00+00:00' WHERE id = ?", (plan["id"],))
    response = client.post(
        f"/api/v1/plans/{plan['id']}/confirm",
        json={"confirmationId": plan["confirmationId"], "confirmationNonce": plan["confirmationNonce"]},
    )
    assert response.status_code == 409
    assert app.extensions["database"].get_agent_plan(plan["id"])["status"] == "EXPIRED"


def test_trusted_intent_gate_never_broadens_a_small_model_tool_choice():
    assert AgentOrchestrator.candidate_tools("发送邮件给 alice@example.invalid，主题是项目进度，正文是已完成")[0]["name"] == "email_send"
    assert AgentOrchestrator.candidate_tools("帮我发送一封邮件")[0]["name"] == "request_clarification"
    assert AgentOrchestrator.candidate_tools("删除待办 task-12")[0]["name"] == "task_delete"
    assert AgentOrchestrator.candidate_tools("引用项目目标原文")[0]["name"] == "document_quote"


def test_upload_import_parses_csv_html_and_preserves_source_locators(client, app):
    csv_file = client.post(
        "/api/v1/documents/import",
        data={"file": (BytesIO("事项,截止时间\n提交中期材料,周五\n".encode("utf-8")), "任务.csv")},
        content_type="multipart/form-data",
    )
    assert csv_file.status_code == 201
    item = csv_file.get_json()["item"]
    assert item["mimeType"] == "text/csv"
    assert item["parserName"] == "csv"
    chunks = app.extensions["database"].list_chunks()
    assert any(chunk["document_id"] == item["id"] and "第 2 行" in chunk["locator"] for chunk in chunks)

    html_file = client.post(
        "/api/v1/documents/import",
        data={"file": (BytesIO(b"<h1>\xe9\xa1\xb9\xe7\x9b\xae\xe8\xbf\x9b\xe5\xba\xa6</h1><script>ignore()</script><p>\xe5\x91\xa8\xe4\xba\x94\xe6\x8f\x90\xe4\xba\xa4</p>"), "进度.html")},
        content_type="multipart/form-data",
    )
    assert html_file.status_code == 201
    assert html_file.get_json()["item"]["parserName"] == "html.parser"


def test_docx_and_scanned_pdf_parse_statuses(client):
    from docx import Document
    from PIL import Image, ImageDraw
    from pypdf import PdfWriter

    document = Document()
    document.add_heading("验收安排", level=1)
    document.add_paragraph("验收材料应于周五前提交。")
    payload = BytesIO()
    document.save(payload)
    docx_file = client.post(
        "/api/v1/documents/import",
        data={"file": (BytesIO(payload.getvalue()), "验收.docx")}, content_type="multipart/form-data",
    )
    assert docx_file.status_code == 201
    assert docx_file.get_json()["item"]["parserName"] == "python-docx"

    writer = PdfWriter()
    writer.add_blank_page(width=100, height=100)
    empty_pdf = BytesIO()
    writer.write(empty_pdf)
    scanned = client.post(
        "/api/v1/documents/import",
        data={"file": (BytesIO(empty_pdf.getvalue()), "扫描件.pdf")}, content_type="multipart/form-data",
    )
    assert scanned.status_code == 400
    assert scanned.get_json()["error"]["code"] == "NO_EXTRACTABLE_TEXT"

    scan_image = Image.new("RGB", (600, 200), "white")
    ImageDraw.Draw(scan_image).text((40, 80), "SCANNED DEADLINE FRIDAY", fill="black")
    scan_payload = BytesIO()
    scan_image.save(scan_payload, format="PDF", resolution=150)
    scan_image.close()
    ocr_disabled = client.post(
        "/api/v1/documents/import",
        data={"file": (BytesIO(scan_payload.getvalue()), "文字扫描件.pdf")}, content_type="multipart/form-data",
    )
    assert ocr_disabled.status_code == 400
    assert ocr_disabled.get_json()["error"]["code"] == "OCR_REQUIRED"


def test_xlsx_import_preserves_sheet_headers_and_cell_ranges(client, app):
    from openpyxl import Workbook

    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "项目进度"
    sheet.append(["事项", "负责人", "截止日期"])
    sheet.append(["中期检查", "张三", "2026-09-01"])
    payload = BytesIO()
    workbook.save(payload)
    imported = client.post(
        "/api/v1/documents/import",
        data={"file": (BytesIO(payload.getvalue()), "项目进度.xlsx")}, content_type="multipart/form-data",
    )
    assert imported.status_code == 201
    item = imported.get_json()["item"]
    assert item["parserName"] == "openpyxl"
    assert item["parserMetadata"] == {"dataRowCount": 1, "sheetCount": 1}
    assert any(
        chunk["document_id"] == item["id"] and "工作表 项目进度 · A2:C2" in chunk["locator"] and "负责人：张三" in chunk["content"]
        for chunk in app.extensions["database"].list_chunks()
    )


def test_pptx_import_preserves_slide_table_and_notes(client, app):
    from pptx import Presentation
    from pptx.util import Inches

    presentation = Presentation()
    slide = presentation.slides.add_slide(presentation.slide_layouts[5])
    slide.shapes.title.text = "系统验收"
    table = slide.shapes.add_table(2, 2, Inches(1), Inches(2), Inches(6), Inches(1.5)).table
    table.cell(0, 0).text, table.cell(0, 1).text = "材料", "截止"
    table.cell(1, 0).text, table.cell(1, 1).text = "实验截图", "周五"
    slide.notes_slide.notes_text_frame.text = "答辩时展示离线运行过程"
    payload = BytesIO()
    presentation.save(payload)
    imported = client.post(
        "/api/v1/documents/import",
        data={"file": (BytesIO(payload.getvalue()), "验收安排.pptx")}, content_type="multipart/form-data",
    )
    assert imported.status_code == 201
    item = imported.get_json()["item"]
    assert item["parserName"] == "python-pptx"
    assert item["parserMetadata"] == {"slideCount": 1}
    assert any(
        chunk["document_id"] == item["id"] and "第 1 页" in chunk["locator"] and "材料：实验截图" in chunk["content"]
        for chunk in app.extensions["database"].list_chunks()
    )


def test_office_limits_fail_before_database_write(client, app):
    from openpyxl import Workbook

    workbook = Workbook()
    sheet = workbook.active
    sheet.append(["列"])
    sheet.append(["数据"])
    payload = BytesIO()
    workbook.save(payload)
    app.config["MAX_XLSX_ROWS_PER_SHEET"] = 1
    before = len(app.extensions["database"].list_documents())
    rejected = client.post(
        "/api/v1/documents/import",
        data={"file": (BytesIO(payload.getvalue()), "超限.xlsx")}, content_type="multipart/form-data",
    )
    assert rejected.status_code == 400
    assert rejected.get_json()["error"]["code"] == "XLSX_ROW_LIMIT"
    assert len(app.extensions["database"].list_documents()) == before
