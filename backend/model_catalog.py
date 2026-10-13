from __future__ import annotations

from pathlib import Path
from typing import Any
from urllib.parse import quote


FOUR_B_MODEL_ID = "qwen3.5-4b-office"
ZERO_EIGHT_B_SHA256 = "d64517eb198e0c0ebc1f717b9de02f52b476fa3bede99e7af2ac4eace1d3abd3"
FOUR_B_FILE_NAME = "Qwen3.5-4B-PPT.Q4_K_M.gguf"
FOUR_B_SHA256 = "31af22f3791eefaef07c431378b9e417d45895458b36e81063289892bb037f38"
FOUR_B_PARTS = (
    (FOUR_B_FILE_NAME + ".part-00", 1_800_000_000, "103363136f7c6dd3024cabf7db6cf1e1fdf28a6d4ddb199c5336ec3b31e409d2"),
    (FOUR_B_FILE_NAME + ".part-01", 908_804_288, "5259c12d930c00ddef8808f34360b3aa38915c0145756c357e76e9ea699fd463"),
)


def build_model_catalog(config: dict[str, Any], inference: Any, downloaders: dict[str, Any]) -> list[dict[str, Any]]:
    """Return the user-visible, fixed model catalog.

    The catalog deliberately contains no user supplied URL or path.  A model can
    be downloaded only from the repository/tag configured by the server owner.
    """
    repository = str(config["MODEL_RELEASE_REPOSITORY"])
    models_dir = Path(str(config["MODELS_DIR"]))
    four_b_model_path = Path(str(config["MODEL_4B_MODEL_PATH"]))
    four_b_manifest = Path(str(config["MODEL_4B_RELEASE_MANIFEST"]))
    four_b_checksum = Path(str(config["MODEL_4B_RELEASE_CHECKSUM"]))
    active_path = Path(str(getattr(inference, "model_path", ""))).resolve()

    current_downloader = downloaders["default"].status()
    four_b_downloader = downloaders[FOUR_B_MODEL_ID].status()
    four_b_enabled = bool(config["MODEL_4B_DOWNLOAD_ENABLED"])
    mirror_repository_0p8 = str(config.get("MODEL_MODELSCOPE_0P8_REPOSITORY") or "").strip()
    mirror_repository_4b = str(config.get("MODEL_MODELSCOPE_4B_REPOSITORY") or "").strip()
    mirror_ready_0p8 = bool(mirror_repository_0p8 and config.get("MODEL_MODELSCOPE_0P8_VERIFIED"))
    mirror_ready_4b = bool(mirror_repository_4b and config.get("MODEL_MODELSCOPE_4B_VERIFIED"))
    four_b_installed = four_b_model_path.is_file()
    four_b_verified = four_b_manifest.is_file() or four_b_checksum.is_file()

    def is_active(path: Path) -> bool:
        try:
            return path.resolve() == active_path
        except OSError:
            return False

    current_path = Path(str(current_downloader["modelPath"]))
    def sources(mirror_ready: bool, mirror_repository: str) -> list[dict[str, Any]]:
        return [
            {"id": "github", "label": "GitHub Releases", "available": True},
            {"id": "modelscope", "label": "国内镜像 · 魔搭 ModelScope", "available": mirror_ready,
             "repository": mirror_repository,
             "reason": "镜像仓库与文件尚未完成核验" if not mirror_ready else ""},
        ]
    return [
        {
            "id": "qwen3.5-0.8b-office",
            "name": "Qwen3.5 Office 0.8B",
            "parameterBillions": 0.8,
            "quantization": "Q8_0",
            "releaseTag": current_downloader["configuredTag"],
            "releaseUrl": f"https://github.com/{repository}/releases/tag/{quote(str(current_downloader['configuredTag']), safe='')}",
            "modelPath": current_downloader["modelPath"],
            "modelDirectory": current_downloader["modelDirectory"],
            "installed": bool(current_downloader["modelInstalled"]),
            "verified": bool(current_downloader["manifestInstalled"] or current_downloader["checksumInstalled"]),
            "active": is_active(current_path),
            "downloadEnabled": bool(current_downloader["enabled"]),
            "downloadState": current_downloader["state"],
            "downloadAvailable": bool(current_downloader["enabled"]),
            "status": "installed" if current_downloader["modelInstalled"] else "available",
            "sources": sources(mirror_ready_0p8, mirror_repository_0p8),
            "defaultSourceId": "modelscope" if mirror_ready_0p8 else "github",
            "capabilities": ["chat", "rag", "agent"],
            "message": "当前默认模型，适合低资源设备。",
        },
        {
            "id": FOUR_B_MODEL_ID,
            "name": "Qwen3.5 4B PPT · 预发布",
            "parameterBillions": 4.0,
            "quantization": "Q4_K_M",
            "releaseTag": str(config["MODEL_4B_RELEASE_TAG"]),
            "releaseUrl": f"https://github.com/{repository}/releases/tag/{quote(str(config['MODEL_4B_RELEASE_TAG']), safe='')}",
            "modelPath": str(four_b_model_path),
            "modelDirectory": str(four_b_model_path.parent),
            "installed": four_b_installed,
            "verified": four_b_verified,
            "active": is_active(four_b_model_path),
            "downloadEnabled": four_b_enabled,
            "downloadState": four_b_downloader["state"],
            "downloadAvailable": four_b_enabled,
            "status": "preview-installed" if four_b_installed else "preview",
            "sources": sources(mirror_ready_4b, mirror_repository_4b),
            "defaultSourceId": "modelscope" if mirror_ready_4b else "github",
            "capabilities": ["chat", "rag", "agent", "ppt_planner_experimental"],
            "message": "已选中 4B 时，普通对话、RAG、Agent 与 PPT 编辑均使用 4B。两个分片会逐片及合并校验；正式文件仍请核对预览和引用。",
            "releaseManifest": str(four_b_manifest),
            "releaseChecksum": str(four_b_checksum),
            "download": four_b_downloader,
            "storageRoot": str(models_dir),
        },
    ]
