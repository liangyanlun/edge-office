from __future__ import annotations

import os
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parent.parent


def default_config() -> dict[str, object]:
    artifacts = ROOT_DIR / "artifacts"
    default_embedding_model = artifacts / "models" / "bge-small-zh-v1.5"
    return {
        "ROOT_DIR": ROOT_DIR,
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
            str(artifacts / "models" / "qwen3_0p8_gguf" / "Qwen3.5-0.8B.Q4_K_M.gguf"),
        ),
        "LLAMA_RELEASE_MANIFEST": os.getenv(
            "LLAMA_RELEASE_MANIFEST",
            str(artifacts / "models" / "qwen3_0p8_gguf" / "release.manifest.json"),
        ),
        "LLAMA_RELEASE_REQUIRED": os.getenv("LLAMA_RELEASE_REQUIRED", "true").lower() in {"1", "true", "yes"},
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
        "TESTING": False,
    }
