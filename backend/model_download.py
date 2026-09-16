from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import threading
import time
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen
from uuid import uuid4


class ModelDownloadError(RuntimeError):
    """Raised for user-safe model release download failures."""


class ModelReleaseDownloader:
    """Downloads one approved GGUF release into the local models directory."""

    _REPOSITORY_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
    _SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")

    def __init__(
        self,
        *,
        enabled: bool,
        repository: str,
        release_tag: str,
        models_dir: Path,
        model_path: Path,
        manifest_path: Path,
        checksum_path: Path,
        n_ctx: int,
        release_required: bool,
        timeout_seconds: int = 30,
        max_bytes: int = 2 * 1024 * 1024 * 1024,
        on_installed: Callable[[], None] | None = None,
        can_replace: Callable[[], bool] | None = None,
        opener: Callable[..., Any] = urlopen,
    ):
        self.enabled = enabled
        self.repository = repository.strip()
        self.release_tag = release_tag.strip()
        self.models_dir = Path(models_dir)
        self.model_path = Path(model_path)
        self.manifest_path = Path(manifest_path)
        self.checksum_path = Path(checksum_path)
        self.n_ctx = n_ctx
        self.release_required = release_required
        self.timeout_seconds = max(5, timeout_seconds)
        self.max_bytes = max(1, max_bytes)
        self.on_installed = on_installed
        self.can_replace = can_replace or (lambda: True)
        self.opener = opener
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._state: dict[str, Any] = {
            "state": "idle",
            "phase": "",
            "downloadedBytes": 0,
            "totalBytes": None,
            "releaseTag": None,
            "verification": None,
            "error": None,
            "updatedAt": None,
        }
        self._validate_configuration()

    def status(self) -> dict[str, Any]:
        with self._lock:
            state = dict(self._state)
            running = bool(self._thread and self._thread.is_alive())
        total = state["totalBytes"]
        downloaded = state["downloadedBytes"]
        return {
            "enabled": self.enabled,
            "repository": self.repository,
            "configuredTag": self.release_tag or "latest",
            "state": "downloading" if running else state["state"],
            "phase": state["phase"],
            "downloadedBytes": downloaded,
            "totalBytes": total,
            "progressPercent": round(downloaded * 100 / total, 1) if isinstance(total, int) and total > 0 else None,
            "releaseTag": state["releaseTag"],
            "verification": state["verification"],
            "error": state["error"],
            "modelInstalled": self.model_path.is_file(),
            "manifestInstalled": self.manifest_path.is_file(),
            "checksumInstalled": self.checksum_path.is_file(),
            "manifestRequired": self.release_required,
            "updatedAt": state["updatedAt"],
        }

    def start(self) -> dict[str, Any]:
        if not self.enabled:
            raise ModelDownloadError("当前版本未启用模型下载")
        if not self.can_replace():
            raise ModelDownloadError("模型正在被本地推理占用。请重启应用后再下载或更新模型")
        with self._lock:
            if self._thread and self._thread.is_alive():
                already_running = True
            else:
                already_running = False
                self._state.update({
                    "state": "downloading", "phase": "正在连接 GitHub Release", "downloadedBytes": 0,
                    "totalBytes": None, "releaseTag": None, "verification": None, "error": None,
                    "updatedAt": int(time.time()),
                })
                self._thread = threading.Thread(target=self._run, name="edge-office-model-download", daemon=True)
                self._thread.start()
        if already_running:
            return self.status()
        return self.status()

    def install_sync(self) -> dict[str, Any]:
        """Synchronous install entrypoint used only by isolated unit tests."""
        if not self.can_replace():
            raise ModelDownloadError("模型正在被本地推理占用。请重启应用后再下载或更新模型")
        self._set_state(state="downloading", phase="正在连接 GitHub Release", error=None, downloadedBytes=0, totalBytes=None)
        self._install()
        return self.status()

    def _run(self) -> None:
        try:
            self._install()
        except ModelDownloadError as error:
            self._set_state(state="failed", phase="下载失败", error=str(error))
        except Exception:
            self._set_state(state="failed", phase="下载失败", error="模型下载失败，请检查网络后重试")

    def _install(self) -> None:
        if self.release_tag:
            self._install_pinned_release()
            return
        release = self._fetch_release()
        tag_name = str(release.get("tag_name") or "").strip()
        if not tag_name:
            raise ModelDownloadError("Release 缺少版本标签")
        assets = release.get("assets")
        if not isinstance(assets, list):
            raise ModelDownloadError("Release 资源列表不可用")
        model_asset = self._find_asset(assets, self.model_path.name, required=True)
        manifest_asset = self._find_asset(assets, self.manifest_path.name, required=False)
        checksum_asset = self._find_checksum_asset(assets)
        self._set_state(releaseTag=tag_name)

        staging_root = self.models_dir / ".downloads" / str(uuid4())
        staging_root.mkdir(parents=True, exist_ok=False)
        staged_model = staging_root / self.model_path.name
        staged_manifest = staging_root / self.manifest_path.name
        staged_checksum = staging_root / self.checksum_path.name
        try:
            expected_sha = None
            verification = None
            if manifest_asset:
                self._set_state(phase="正在下载发布清单")
                self._download_asset(manifest_asset, staged_manifest, track_progress=False)
                expected_sha = self._validate_manifest(staged_manifest)
                verification = "release-manifest-sha256"
            elif checksum_asset:
                self._set_state(phase="正在下载 SHA-256 校验文件")
                self._download_asset(checksum_asset, staged_checksum, track_progress=False)
                expected_sha = self._parse_checksum(staged_checksum)
                verification = "sha256sums"
            elif self.release_required:
                raise ModelDownloadError("该 Release 缺少 release.manifest.json 或 SHA-256 校验文件")
            else:
                digest = str(model_asset.get("digest") or "")
                if digest.startswith("sha256:") and self._SHA256_PATTERN.fullmatch(digest[7:]):
                    expected_sha = digest[7:]
                    verification = "github-release-sha256"

            self._set_state(phase="正在下载模型")
            actual_sha = self._download_asset(model_asset, staged_model, track_progress=True)
            self._set_state(phase="正在校验模型")
            if expected_sha and actual_sha != expected_sha:
                raise ModelDownloadError("模型文件校验失败，已取消安装")
            if not self.can_replace():
                raise ModelDownloadError("模型正在被本地推理占用。请重启应用后再下载或更新模型")
            self._set_state(phase="正在安装到本机")
            self._install_files(staged_model, staged_manifest if manifest_asset else None, staged_checksum if checksum_asset else None)
            if self.on_installed:
                self.on_installed()
            self._set_state(state="completed", phase="模型已安装", verification=verification or "未提供发布校验", error=None)
        finally:
            shutil.rmtree(staging_root, ignore_errors=True)

    def _install_pinned_release(self) -> None:
        """Download the approved assets directly for a fixed public tag.

        This bypasses GitHub's rate-limited REST discovery endpoint while still
        retaining a fixed repository, tag, filenames, maximum size and SHA-256
        verification boundary.
        """
        release_tag = self.release_tag
        base = f"https://github.com/{self.repository}/releases/download/{quote(release_tag, safe='')}"
        model_asset = {"name": self.model_path.name, "browser_download_url": f"{base}/{quote(self.model_path.name)}"}
        checksum_asset = {"name": self.checksum_path.name, "browser_download_url": f"{base}/{quote(self.checksum_path.name)}"}
        self._set_state(releaseTag=release_tag, phase="正在读取固定 Release")

        staging_root = self.models_dir / ".downloads" / str(uuid4())
        staging_root.mkdir(parents=True, exist_ok=False)
        staged_model = staging_root / self.model_path.name
        staged_checksum = staging_root / self.checksum_path.name
        try:
            self._set_state(phase="正在下载 SHA-256 校验文件")
            self._download_asset(checksum_asset, staged_checksum, track_progress=False)
            expected_sha = self._parse_checksum(staged_checksum)
            self._set_state(phase="正在下载模型")
            actual_sha = self._download_asset(model_asset, staged_model, track_progress=True)
            self._set_state(phase="正在校验模型")
            if actual_sha != expected_sha:
                raise ModelDownloadError("模型文件校验失败，已取消安装")
            if not self.can_replace():
                raise ModelDownloadError("模型正在被本地推理占用。请重启应用后再下载或更新模型")
            self._set_state(phase="正在安装到本机")
            self._install_files(staged_model, None, staged_checksum)
            if self.on_installed:
                self.on_installed()
            self._set_state(state="completed", phase="模型已安装", verification="sha256sums", error=None)
        finally:
            shutil.rmtree(staging_root, ignore_errors=True)

    def _fetch_release(self) -> dict[str, Any]:
        endpoint = "latest" if not self.release_tag else f"tags/{quote(self.release_tag, safe='')}"
        url = f"https://api.github.com/repos/{self.repository}/releases/{endpoint}"
        self._set_state(phase="正在读取 GitHub Release")
        request = Request(url, headers={"Accept": "application/vnd.github+json", "User-Agent": "EdgeOffice-ModelDownloader/1.0"})
        try:
            with self.opener(request, timeout=self.timeout_seconds) as response:
                data = response.read()
        except Exception as error:
            raise ModelDownloadError("无法连接 GitHub Release，请检查网络后重试") from error
        try:
            release = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ModelDownloadError("GitHub Release 返回的数据不可读取") from error
        if not isinstance(release, dict) or release.get("draft") is True:
            raise ModelDownloadError("未找到可下载的公开模型 Release")
        return release

    def _find_asset(self, assets: list[Any], name: str, *, required: bool) -> dict[str, Any] | None:
        for asset in assets:
            if isinstance(asset, dict) and asset.get("name") == name:
                self._validate_asset(asset)
                return asset
        if required:
            raise ModelDownloadError(f"Release 中缺少模型文件 {name}")
        return None

    def _find_checksum_asset(self, assets: list[Any]) -> dict[str, Any] | None:
        allowed_names = {self.checksum_path.name, "SHA256SUMS.txt"}
        for asset in assets:
            if isinstance(asset, dict) and asset.get("name") in allowed_names:
                self._validate_asset(asset)
                return asset
        return None

    def _validate_asset(self, asset: dict[str, Any]) -> None:
        size = asset.get("size")
        if not isinstance(size, int) or size <= 0 or size > self.max_bytes:
            raise ModelDownloadError("Release 中的模型文件大小不在允许范围内")
        url = str(asset.get("browser_download_url") or "")
        parsed = urlparse(url)
        prefix = f"/{self.repository}/releases/download/"
        if parsed.scheme != "https" or parsed.netloc.lower() != "github.com" or not parsed.path.startswith(prefix):
            raise ModelDownloadError("Release 资源地址不受信任")

    def _download_asset(self, asset: dict[str, Any], destination: Path, *, track_progress: bool) -> str:
        declared_size = asset.get("size")
        expected_size = declared_size if isinstance(declared_size, int) and declared_size > 0 else None
        request = Request(str(asset["browser_download_url"]), headers={"Accept": "application/octet-stream", "User-Agent": "EdgeOffice-ModelDownloader/1.0"})
        digest = hashlib.sha256()
        downloaded = 0
        try:
            with self.opener(request, timeout=self.timeout_seconds) as response, destination.open("wb") as handle:
                content_length = response.headers.get("Content-Length")
                remote_size = int(content_length) if content_length and content_length.isdigit() else None
                if remote_size and remote_size > self.max_bytes:
                    raise ModelDownloadError("模型文件超过本机允许的下载上限")
                total_size = expected_size or remote_size
                while True:
                    block = response.read(1024 * 1024)
                    if not block:
                        break
                    downloaded += len(block)
                    if downloaded > self.max_bytes:
                        raise ModelDownloadError("模型文件超过本机允许的下载上限")
                    handle.write(block)
                    digest.update(block)
                    if track_progress:
                        self._set_state(downloadedBytes=downloaded, totalBytes=total_size)
        except ModelDownloadError:
            raise
        except Exception as error:
            raise ModelDownloadError("模型文件下载中断，请检查网络后重试") from error
        if expected_size is not None and downloaded != expected_size:
            raise ModelDownloadError("模型文件大小与 Release 元数据不一致")
        return digest.hexdigest()

    def _validate_manifest(self, manifest_path: Path) -> str:
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ModelDownloadError("发布清单不可读取") from error
        if not isinstance(manifest, dict) or manifest.get("schema") != "edge_office_model_release_v1":
            raise ModelDownloadError("发布清单版本不受支持")
        if Path(str(manifest.get("model_file") or "")).name != self.model_path.name:
            raise ModelDownloadError("发布清单与当前模型文件不匹配")
        if str(manifest.get("quantization") or "").upper() not in {"Q4_K_M", "Q8_0", "F16"}:
            raise ModelDownloadError("发布清单中的量化格式不受支持")
        if int(manifest.get("context_length") or 0) != self.n_ctx:
            raise ModelDownloadError("发布清单与当前上下文长度不一致")
        if manifest.get("acceptance_passed") is not True:
            raise ModelDownloadError("发布模型尚未通过验收")
        digest = str(manifest.get("sha256") or "").lower()
        if not self._SHA256_PATTERN.fullmatch(digest):
            raise ModelDownloadError("发布清单缺少有效的 SHA-256")
        return digest

    def _parse_checksum(self, checksum_path: Path) -> str:
        try:
            lines = checksum_path.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeDecodeError) as error:
            raise ModelDownloadError("SHA-256 校验文件不可读取") from error
        pattern = re.compile(r"^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$")
        for line in lines:
            match = pattern.match(line.strip())
            if match and Path(match.group(2)).name == self.model_path.name:
                return match.group(1).lower()
        raise ModelDownloadError("SHA-256 校验文件未包含当前 GGUF")

    def _install_files(self, staged_model: Path, staged_manifest: Path | None, staged_checksum: Path | None) -> None:
        models_root = self.models_dir.resolve()
        target_model = self.model_path.resolve()
        target_manifest = self.manifest_path.resolve()
        target_checksum = self.checksum_path.resolve()
        try:
            target_model.relative_to(models_root)
            target_manifest.relative_to(models_root)
            target_checksum.relative_to(models_root)
        except ValueError as error:
            raise ModelDownloadError("模型安装路径不在受控目录内") from error
        target_model.parent.mkdir(parents=True, exist_ok=True)
        target_manifest.parent.mkdir(parents=True, exist_ok=True)
        target_checksum.parent.mkdir(parents=True, exist_ok=True)
        targets = [target_model, target_manifest, target_checksum]
        backups: dict[Path, Path] = {}
        installed: list[Path] = []
        try:
            for target in targets:
                if target.exists():
                    backup = target.with_name(f"{target.name}.backup-{uuid4().hex}")
                    os.replace(target, backup)
                    backups[target] = backup
            os.replace(staged_model, target_model)
            installed.append(target_model)
            if staged_manifest:
                os.replace(staged_manifest, target_manifest)
                installed.append(target_manifest)
            if staged_checksum:
                os.replace(staged_checksum, target_checksum)
                installed.append(target_checksum)
        except OSError as error:
            for target in installed:
                target.unlink(missing_ok=True)
            for target, backup in backups.items():
                if backup.exists():
                    os.replace(backup, target)
            raise ModelDownloadError("模型无法写入本机目录，请检查文件占用或磁盘空间") from error
        for backup in backups.values():
            backup.unlink(missing_ok=True)

    def _validate_configuration(self) -> None:
        if not self._REPOSITORY_PATTERN.fullmatch(self.repository):
            raise ValueError("MODEL_RELEASE_REPOSITORY 格式不正确")
        if self.max_bytes < 1024 * 1024:
            raise ValueError("MODEL_DOWNLOAD_MAX_BYTES 过小")

    def _set_state(self, **changes: Any) -> None:
        with self._lock:
            self._state.update(changes)
            self._state["updatedAt"] = int(time.time())
