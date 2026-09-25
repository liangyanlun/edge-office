from __future__ import annotations

from pathlib import Path
from typing import Any
from urllib.parse import quote


FOUR_B_MODEL_ID = "qwen3.5-4b-office"


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
    four_b_installed = four_b_model_path.is_file()
    four_b_verified = four_b_manifest.is_file() or four_b_checksum.is_file()

    def is_active(path: Path) -> bool:
        try:
            return path.resolve() == active_path
        except OSError:
            return False

    current_path = Path(str(current_downloader["modelPath"]))
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
            "capabilities": ["chat", "rag", "agent"],
            "message": "当前默认模型，适合低资源设备。",
        },
        {
            "id": FOUR_B_MODEL_ID,
            "name": "Qwen3.5 Office 4B",
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
            "status": "installed" if four_b_installed else "development",
            "capabilities": ["chat", "rag", "agent", "ppt_planner"],
            "message": (
                "模型文件尚未上传，当前 Release 仅用于说明开发进度。"
                if not four_b_enabled
                else "模型已开放下载；下载完成后需要重启并切换模型。"
            ),
            "releaseManifest": str(four_b_manifest),
            "releaseChecksum": str(four_b_checksum),
            "download": four_b_downloader,
            "storageRoot": str(models_dir),
        },
    ]
