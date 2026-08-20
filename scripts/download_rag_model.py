"""Download the default Chinese embedding model for offline RAG exactly once."""

from __future__ import annotations

from pathlib import Path

from huggingface_hub import snapshot_download


ROOT_DIR = Path(__file__).resolve().parents[1]
MODEL_ID = "BAAI/bge-small-zh-v1.5"
LOCAL_DIR = ROOT_DIR / "artifacts" / "models" / "bge-small-zh-v1.5"


if __name__ == "__main__":
    LOCAL_DIR.mkdir(parents=True, exist_ok=True)
    path = snapshot_download(repo_id=MODEL_ID, local_dir=LOCAL_DIR)
    print(f"RAG embedding model ready: {path}")
