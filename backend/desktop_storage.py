"""Storage chosen explicitly through the desktop's native folder picker."""
from __future__ import annotations

import json
import os
from pathlib import Path
from uuid import uuid4

PROFILES = {
    "qwen3.5-0.8b-office": ("MODEL_0P8", "qwen3_5_0p8_office_q8_0", "Qwen3.5-0.8B-office.Q8_0.gguf"),
    "qwen3.5-4b-office": ("MODEL_4B", "qwen3_5_4b_office_q4_k_m", "Qwen3.5-4B-PPT.Q4_K_M.gguf"),
}


def read_storage_preferences(path: Path) -> dict[str, str]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        locations = data.get("modelDirectories", {})
        if not isinstance(locations, dict):
            return {}
        return {key: value for key, value in locations.items()
                if key in PROFILES and isinstance(value, str) and Path(value).is_absolute()}
    except (OSError, ValueError, AttributeError):
        return {}


def profile_paths(prefix: str, directory: Path, filename: str) -> dict[str, str]:
    model = directory / filename
    return {prefix + "_MODEL_PATH": str(model),
            prefix + "_RELEASE_MANIFEST": str(directory / "release.manifest.json"),
            prefix + "_RELEASE_CHECKSUM": str(directory / (model.stem + ".SHA256SUMS.txt"))}


def save_model_directory(app, model_id: str, selected_root: Path) -> str:
    """Native-only entry: HTTP and model tools cannot supply a filesystem path."""
    if model_id not in PROFILES:
        raise ValueError("未找到该模型配置")
    root = selected_root.resolve(strict=True)
    if not root.is_dir():
        raise ValueError("请选择文件夹")
    directory = root / PROFILES[model_id][1]
    public = (Path(app.config["ROOT_DIR"]) / "public").resolve()
    if directory.resolve().is_relative_to(public):
        raise ValueError("请选择应用公开资源以外的文件夹")
    with app.extensions["model_storage_lock"]:
        downloaders = app.extensions["model_downloaders"]
        if any(d.status()["state"] == "downloading" for d in set(downloaders.values())):
            raise ValueError("模型下载正在进行，完成后再选择位置")
        downloader = downloaders[model_id]
        if downloader.model_path.is_file():
            raise ValueError("该模型已下载；下载位置需在下载前选择")
        inference = app.extensions["inference"]
        with inference._load_lock:
            active = inference.model_path.resolve() == downloader.model_path.resolve()
            if active and inference._model is not None:
                raise ValueError("模型正在使用，无法更改下载位置")
            # A real write probe also detects a full disk/read-only directory.
            probe = root / (".edge-office-write-probe-" + uuid4().hex)
            try:
                with probe.open("xb") as handle:
                    handle.write(b"ok")
            finally:
                if probe.exists():
                    probe.unlink()
            settings = Path(app.config["MODEL_STORAGE_SETTINGS"])
            preferences = read_storage_preferences(settings)
            preferences[model_id] = str(directory)
            settings.parent.mkdir(parents=True, exist_ok=True)
            temporary = settings.with_name(settings.name + "." + uuid4().hex + ".pending")
            try:
                temporary.write_text(json.dumps({"modelDirectories": preferences}, ensure_ascii=False), encoding="utf-8")
                os.replace(temporary, settings)
            finally:
                temporary.unlink(missing_ok=True)
            prefix, _, filename = PROFILES[model_id]
            changes = profile_paths(prefix, directory, filename)
            app.config.update(changes)
            downloader.models_dir = root
            downloader.model_path = Path(changes[prefix + "_MODEL_PATH"])
            downloader.manifest_path = Path(changes[prefix + "_RELEASE_MANIFEST"])
            downloader.checksum_path = Path(changes[prefix + "_RELEASE_CHECKSUM"])
            if active:
                inference.model_path = downloader.model_path
                inference.release_manifest = downloader.manifest_path
                inference.release_checksum = downloader.checksum_path
                inference._release = None
                inference._load_error = ""
                app.config.update(LLAMA_MODEL_PATH=str(inference.model_path),
                                  LLAMA_RELEASE_MANIFEST=str(inference.release_manifest),
                                  LLAMA_RELEASE_CHECKSUM=str(inference.release_checksum))
            return str(directory)
