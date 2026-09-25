from __future__ import annotations

from pathlib import Path

from backend.app import create_app
from backend.config import ROOT_DIR


def make_app(tmp_path: Path, **overrides):
    config = {
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
    config.update(overrides)
    return create_app(config)


def test_mobile_bootstrap_and_chunk_upload(tmp_path: Path):
    client = make_app(tmp_path).test_client()
    bootstrap = client.get("/api/v1/mobile/bootstrap")
    assert bootstrap.status_code == 200
    assert bootstrap.get_json()["capabilities"]["resumableUpload"] is True

    created = client.post("/api/v1/uploads/init", json={"name": "mobile.txt", "size": 6})
    assert created.status_code == 201
    upload_id = created.get_json()["item"]["id"]
    assert client.put(f"/api/v1/uploads/{upload_id}/parts/0", data=b"abc123").status_code == 200
    assert client.post(f"/api/v1/uploads/{upload_id}/complete").status_code == 201
    imported = client.post("/api/v1/documents/import", json={"uploadId": upload_id})
    assert imported.status_code == 201
    assert imported.get_json()["item"]["name"] == "mobile.txt"


def test_lan_requires_pairing_and_rejects_wrong_code(tmp_path: Path):
    client = make_app(
        tmp_path,
        MOBILE_MODE="lan",
        MOBILE_PAIRING_CODE="123456789012",
        MOBILE_PAIRING_SECRET="s" * 32,
    ).test_client()
    remote = {"REMOTE_ADDR": "10.0.0.5"}
    assert client.get("/api/v1/preferences", environ_overrides=remote).status_code == 401
    assert client.post("/api/v1/mobile/pair", json={"code": "wrong"}, environ_overrides=remote).status_code == 401
    assert client.post("/api/v1/mobile/pair", json={"code": "123456789012"}, environ_overrides=remote).status_code == 200
    assert client.get("/api/v1/preferences", environ_overrides=remote).status_code == 200
