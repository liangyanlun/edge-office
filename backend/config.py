from __future__ import annotations

import os
import sys
from pathlib import Path


def _resource_root() -> Path:
    """Return bundled resources when frozen, otherwise the source checkout."""
    if getattr(sys, "frozen", False) and getattr(sys, "_MEIPASS", None):
        return Path(sys._MEIPASS).resolve()
    return Path(__file__).resolve().parent.parent


ROOT_DIR = _resource_root()


def _runtime_root() -> Path:
    """Keep mutable user data outside the installed application directory."""
    configured = os.getenv("EDGE_OFFICE_HOME", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    if getattr(sys, "frozen", False):
        local_app_data = os.getenv("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return (Path(local_app_data) / "EdgeOffice").resolve()
    return ROOT_DIR


def default_config() -> dict[str, object]:
    runtime_root = _runtime_root()
    artifacts = runtime_root / "artifacts"
    default_embedding_model = artifacts / "models" / "bge-small-zh-v1.5"
    default_model_dir = artifacts / "models" / "qwen3_5_0p8_office_q8_0"
    default_model_file = default_model_dir / "Qwen3.5-0.8B-office.Q8_0.gguf"
    four_b_model_dir = artifacts / "models" / "qwen3_5_4b_office_q4_k_m"
    four_b_model_file = four_b_model_dir / "Qwen3.5-4B-office.Q4_K_M.gguf"
    release_required_default = "false" if getattr(sys, "frozen", False) else "true"
    return {
        "APP_VERSION": "0.2.0-dev.20260925",
        "ROOT_DIR": ROOT_DIR,
        "RUNTIME_DIR": runtime_root,
        "DATA_DIR": artifacts / "data",
        "INDEX_DIR": artifacts / "indexes",
        "MODELS_DIR": artifacts / "models",
        "DATABASE_PATH": artifacts / "data" / "edge_office.db",
        # Chinese edge RAG default: BAAI/bge-small-zh-v1.5 (~96 MB weights).
        # It is downloaded once into artifacts/models and always loaded locally.
        "EMBEDDING_MODEL_PATH": os.getenv("RAG_EMBEDDING_MODEL", str(default_embedding_model)),
        "RAG_QUERY_INSTRUCTION": os.getenv("RAG_QUERY_INSTRUCTION", "为这个句子生成表示以用于检索相关文章："),
        "RAG_TOP_K": int(os.getenv("RAG_TOP_K", "4")),
        "RAG_CANDIDATE_K": int(os.getenv("RAG_CANDIDATE_K", "12")),
        "RAG_RERANK_K": int(os.getenv("RAG_RERANK_K", "5")),
        "RAG_EVIDENCE_TOKEN_BUDGET": int(os.getenv("RAG_EVIDENCE_TOKEN_BUDGET", "900")),
        "RAG_MIN_CONFIDENCE": float(os.getenv("RAG_MIN_CONFIDENCE", "0.42")),
        "RAG_ALLOWED_SECURITY_LEVELS": tuple(
            level.strip() for level in os.getenv("RAG_ALLOWED_SECURITY_LEVELS", "public,internal").split(",") if level.strip()
        ),
        # llama.cpp runs inside the Flask process. The GGUF file stays outside
        # source control and can be replaced with LLAMA_MODEL_PATH.
        "LLAMA_CPP_ENABLED": os.getenv("LLAMA_CPP_ENABLED", "true").lower() in {"1", "true", "yes"},
        "LLAMA_MODEL_PATH": os.getenv(
            "LLAMA_MODEL_PATH",
            str(default_model_file),
        ),
        "LLAMA_RELEASE_MANIFEST": os.getenv(
            "LLAMA_RELEASE_MANIFEST",
            str(default_model_dir / "release.manifest.json"),
        ),
        "LLAMA_RELEASE_CHECKSUM": os.getenv(
            "LLAMA_RELEASE_CHECKSUM",
            str(default_model_dir / f"{default_model_file.stem}.SHA256SUMS.txt"),
        ),
        "LLAMA_RELEASE_REQUIRED": os.getenv("LLAMA_RELEASE_REQUIRED", release_required_default).lower() in {"1", "true", "yes"},
        # The downloader is intentionally pinned to one public repository. The
        # browser never provides a URL or a destination path.
        "MODEL_RELEASE_DOWNLOAD_ENABLED": os.getenv("MODEL_RELEASE_DOWNLOAD_ENABLED", "true").lower() in {"1", "true", "yes"},
        "MODEL_RELEASE_REPOSITORY": os.getenv("MODEL_RELEASE_REPOSITORY", "liangyanlun/edge-office"),
        # Pin the public model release so first-run downloads do not depend on
        # GitHub's unauthenticated API quota. Maintainers can still override it.
        "MODEL_RELEASE_TAG": os.getenv("MODEL_RELEASE_TAG", "v0.1.0").strip(),
        # The 4B Release is intentionally a visible, disabled placeholder until
        # the GGUF, manifest and checksum have passed the separate 4B/PPT gate.
        # Enabling this flag later exposes the same fixed-asset downloader without
        # changing the repository or accepting a browser-provided URL.
        "MODEL_4B_MODEL_PATH": os.getenv("MODEL_4B_MODEL_PATH", str(four_b_model_file)),
        "MODEL_4B_RELEASE_MANIFEST": os.getenv(
            "MODEL_4B_RELEASE_MANIFEST", str(four_b_model_dir / "release.manifest.json")
        ),
        "MODEL_4B_RELEASE_CHECKSUM": os.getenv(
            "MODEL_4B_RELEASE_CHECKSUM", str(four_b_model_dir / f"{four_b_model_file.stem}.SHA256SUMS.txt")
        ),
        "MODEL_4B_RELEASE_TAG": os.getenv("MODEL_4B_RELEASE_TAG", "v0.2.0-4b").strip(),
        "MODEL_4B_DOWNLOAD_ENABLED": os.getenv("MODEL_4B_DOWNLOAD_ENABLED", "false").lower() in {"1", "true", "yes"},
        "MODEL_DOWNLOAD_TIMEOUT_SECONDS": int(os.getenv("MODEL_DOWNLOAD_TIMEOUT_SECONDS", "30")),
        "MODEL_DOWNLOAD_MAX_BYTES": int(os.getenv("MODEL_DOWNLOAD_MAX_BYTES", str(2 * 1024 * 1024 * 1024))),
        "LLAMA_N_CTX": int(os.getenv("LLAMA_N_CTX", "2048")),
        "LLAMA_N_THREADS": int(os.getenv("LLAMA_N_THREADS", str(max(1, (os.cpu_count() or 2) // 2)))),
        "LLAMA_N_GPU_LAYERS": int(os.getenv("LLAMA_N_GPU_LAYERS", "0")),
        "MAX_DOCUMENT_CHARACTERS": 200_000,
        "MAX_UPLOAD_BYTES": 20 * 1024 * 1024,
        "OCR_ENABLED": os.getenv("OCR_ENABLED", "true").lower() in {"1", "true", "yes"},
        "MAX_PDF_PAGES": int(os.getenv("MAX_PDF_PAGES", "200")),
        "MAX_OCR_PAGES": int(os.getenv("MAX_OCR_PAGES", "30")),
        "MAX_XLSX_SHEETS": int(os.getenv("MAX_XLSX_SHEETS", "30")),
        "MAX_XLSX_ROWS_PER_SHEET": int(os.getenv("MAX_XLSX_ROWS_PER_SHEET", "5000")),
        "MAX_XLSX_COLUMNS": int(os.getenv("MAX_XLSX_COLUMNS", "100")),
        "MAX_PPTX_SLIDES": int(os.getenv("MAX_PPTX_SLIDES", "300")),
        "MAX_AGENT_STEPS": 1,
        "AGENT_CONFIRMATION_TTL_SECONDS": int(os.getenv("AGENT_CONFIRMATION_TTL_SECONDS", "300")),
        "AGENT_LOCAL_USER_ID": os.getenv("AGENT_LOCAL_USER_ID", "local-user"),
        # Schedule parsing is explicit and deterministic; users can override the
        # default Chinese locale instead of asking the small model to infer a zone.
        "SCHEDULE_TIMEZONE": os.getenv("EDGE_OFFICE_TIMEZONE", "Asia/Shanghai").strip() or "Asia/Shanghai",
        # Calendar is a preserved internal experiment, not a launch feature.
        "CALENDAR_EXPERIMENTAL_ENABLED": os.getenv("EDGE_OFFICE_CALENDAR_EXPERIMENTAL", "false").lower() in {"1", "true", "yes"},
        # Mobile access is opt-in. Keep loopback/local-cookie behavior unchanged
        # unless an administrator explicitly configures a pairing code.
        "MOBILE_APP_VERSION": os.getenv("EDGE_OFFICE_APP_VERSION", "0.2.0"),
        "MOBILE_MODE": os.getenv("EDGE_OFFICE_MODE", "local"),
        "MOBILE_PAIRING_CODE": os.getenv("EDGE_OFFICE_PAIRING_CODE", "").strip(),
        "MOBILE_PAIRING_SECRET": os.getenv("EDGE_OFFICE_PAIRING_SECRET", "").strip(),
        "MOBILE_UPLOAD_CHUNK_BYTES": int(os.getenv("EDGE_OFFICE_UPLOAD_CHUNK_BYTES", str(5 * 1024 * 1024))),
        "TESTING": False,
    }
