from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path
from typing import Any
from uuid import uuid4

from ..database import Database, now_iso
from .contracts import PptPatch


class PptStorage:
    def __init__(self, database: Database, root: Path):
        self.database = database
        self.root = Path(root) / "presentations"
        self.root.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _initialize(self) -> None:
        with self.database.connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS ppt_presentations (
                  id TEXT PRIMARY KEY,
                  name TEXT NOT NULL,
                  original_sha256 TEXT NOT NULL,
                  current_version_id TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS ppt_versions (
                  id TEXT PRIMARY KEY,
                  presentation_id TEXT NOT NULL REFERENCES ppt_presentations(id) ON DELETE CASCADE,
                  parent_version_id TEXT,
                  source_kind TEXT NOT NULL,
                  file_sha256 TEXT NOT NULL,
                  relative_path TEXT NOT NULL,
                  snapshot_path TEXT NOT NULL,
                  created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS ppt_assets (
                  id TEXT PRIMARY KEY,
                  presentation_id TEXT NOT NULL REFERENCES ppt_presentations(id) ON DELETE CASCADE,
                  file_name TEXT NOT NULL,
                  mime_type TEXT NOT NULL,
                  sha256 TEXT NOT NULL,
                  relative_path TEXT NOT NULL,
                  created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS ppt_patches (
                  id TEXT PRIMARY KEY,
                  presentation_id TEXT NOT NULL REFERENCES ppt_presentations(id) ON DELETE CASCADE,
                  base_version_id TEXT NOT NULL,
                  slide_id TEXT NOT NULL,
                  instruction TEXT NOT NULL,
                  model_name TEXT NOT NULL,
                  model_output_sha256 TEXT NOT NULL,
                  operations_json TEXT NOT NULL,
                  canonical_json TEXT NOT NULL,
                  patch_sha256 TEXT NOT NULL,
                  status TEXT NOT NULL,
                  staged_relative_path TEXT,
                  verification_json TEXT NOT NULL DEFAULT '{}',
                  warning TEXT,
                  published_version_id TEXT,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS ppt_events (
                  id TEXT PRIMARY KEY,
                  patch_id TEXT NOT NULL REFERENCES ppt_patches(id) ON DELETE CASCADE,
                  event_type TEXT NOT NULL,
                  data_json TEXT NOT NULL DEFAULT '{}',
                  created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_ppt_versions_presentation ON ppt_versions(presentation_id, created_at);
                CREATE INDEX IF NOT EXISTS idx_ppt_patches_presentation ON ppt_patches(presentation_id, created_at);
                CREATE INDEX IF NOT EXISTS idx_ppt_events_patch ON ppt_events(patch_id, created_at);
                """
            )

    def prepare_import(self, name: str, data: bytes) -> dict[str, Any]:
        presentation_id = str(uuid4())
        digest = hashlib.sha256(data).hexdigest()
        version_id = self._version_id(presentation_id, digest)
        base = self.root / presentation_id
        original = base / "original" / "source.pptx"
        version_path = base / "versions" / version_id / "presentation.pptx"
        original.parent.mkdir(parents=True, exist_ok=True)
        version_path.parent.mkdir(parents=True, exist_ok=True)
        original.write_bytes(data)
        try:
            original.chmod(0o444)
        except OSError:
            pass
        shutil.copy2(original, version_path)
        try:
            version_path.chmod(0o666)
        except OSError:
            pass
        return {
            "id": presentation_id, "name": Path(name).name[:180], "sha256": digest,
            "versionId": version_id, "originalPath": original, "versionPath": version_path,
            "versionDir": version_path.parent,
        }

    def commit_import(self, prepared: dict[str, Any], snapshot_path: Path) -> dict[str, Any]:
        created = now_iso()
        with self.database.connect() as connection:
            connection.execute(
                "INSERT INTO ppt_presentations(id, name, original_sha256, current_version_id, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)",
                (prepared["id"], prepared["name"], prepared["sha256"], prepared["versionId"], created, created),
            )
            connection.execute(
                """INSERT INTO ppt_versions(id, presentation_id, parent_version_id, source_kind, file_sha256, relative_path, snapshot_path, created_at)
                   VALUES(?, ?, NULL, 'import', ?, ?, ?, ?)""",
                (prepared["versionId"], prepared["id"], prepared["sha256"], self._relative(prepared["versionPath"]), self._relative(snapshot_path), created),
            )
        return self.get_presentation(prepared["id"]) or {}

    def cleanup_prepared(self, prepared: dict[str, Any]) -> None:
        shutil.rmtree(self.root / str(prepared.get("id", "")), ignore_errors=True)

    def list_presentations(self) -> list[dict[str, Any]]:
        with self.database.connect() as connection:
            rows = connection.execute(
                """SELECT p.*, COUNT(v.id) AS version_count FROM ppt_presentations p
                   LEFT JOIN ppt_versions v ON v.presentation_id = p.id
                   GROUP BY p.id ORDER BY p.updated_at DESC"""
            ).fetchall()
        return [self._presentation(row) for row in rows]

    def get_presentation(self, presentation_id: str) -> dict[str, Any] | None:
        with self.database.connect() as connection:
            row = connection.execute(
                """SELECT p.*, COUNT(v.id) AS version_count FROM ppt_presentations p
                   LEFT JOIN ppt_versions v ON v.presentation_id = p.id WHERE p.id = ? GROUP BY p.id""",
                (presentation_id,),
            ).fetchone()
            if not row:
                return None
            versions = connection.execute(
                "SELECT id, parent_version_id, source_kind, file_sha256, created_at FROM ppt_versions WHERE presentation_id = ? ORDER BY created_at DESC",
                (presentation_id,),
            ).fetchall()
        item = self._presentation(row)
        item["versions"] = [
            {"id": v["id"], "parentVersionId": v["parent_version_id"], "sourceKind": v["source_kind"], "sha256": v["file_sha256"], "createdAt": v["created_at"]}
            for v in versions
        ]
        return item

    def get_version(self, presentation_id: str, version_id: str | None = None) -> dict[str, Any] | None:
        presentation = self.get_presentation(presentation_id)
        if not presentation:
            return None
        target = version_id or presentation["currentVersionId"]
        with self.database.connect() as connection:
            row = connection.execute("SELECT * FROM ppt_versions WHERE id = ? AND presentation_id = ?", (target, presentation_id)).fetchone()
        if not row:
            return None
        item = dict(row)
        item["path"] = str(self._absolute(item["relative_path"]))
        item["snapshotPath"] = str(self._absolute(item["snapshot_path"]))
        item["slidesDir"] = str(self._absolute(item["relative_path"]).parent / "slides")
        return item

    def save_asset(self, presentation_id: str, name: str, mime_type: str, data: bytes) -> dict[str, Any]:
        if not self.get_presentation(presentation_id):
            raise KeyError(presentation_id)
        asset_id = str(uuid4())
        suffix = Path(name).suffix.lower() or ".img"
        path = self.root / presentation_id / "assets" / f"{asset_id}{suffix}"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        digest = hashlib.sha256(data).hexdigest()
        with self.database.connect() as connection:
            connection.execute(
                "INSERT INTO ppt_assets(id, presentation_id, file_name, mime_type, sha256, relative_path, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)",
                (asset_id, presentation_id, Path(name).name[:180], mime_type, digest, self._relative(path), now_iso()),
            )
        return {"id": asset_id, "uri": f"asset://upload/{asset_id}", "name": Path(name).name, "mimeType": mime_type, "sha256": digest}

    def get_asset(self, asset_id: str) -> dict[str, Any] | None:
        with self.database.connect() as connection:
            row = connection.execute("SELECT * FROM ppt_assets WHERE id = ?", (asset_id,)).fetchone()
        if not row:
            return None
        item = dict(row)
        return {"id": item["id"], "presentationId": item["presentation_id"], "path": str(self._absolute(item["relative_path"])), "mimeType": item["mime_type"], "sha256": item["sha256"]}

    def create_patch(self, patch: PptPatch, instruction: str, model_name: str, raw_output: str, warning: str | None) -> dict[str, Any]:
        patch_id = str(uuid4())
        created = now_iso()
        with self.database.connect() as connection:
            connection.execute(
                """INSERT INTO ppt_patches(id, presentation_id, base_version_id, slide_id, instruction, model_name,
                   model_output_sha256, operations_json, canonical_json, patch_sha256, status, warning, created_at, updated_at)
                   VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PLANNED', ?, ?, ?)""",
                (
                    patch_id, patch.document_id, patch.base_version, patch.slide_id, instruction[:4000], model_name,
                    hashlib.sha256(raw_output.encode("utf-8")).hexdigest(),
                    json.dumps([item.as_dict() for item in patch.operations], ensure_ascii=False, sort_keys=True),
                    patch.canonical_json(), patch.patch_hash, warning, created, created,
                ),
            )
            self._event(connection, patch_id, "ppt_plan", {"operationCount": len(patch.operations), "patchHash": patch.patch_hash})
        return self.get_patch(patch_id) or {}

    def get_patch(self, patch_id: str) -> dict[str, Any] | None:
        with self.database.connect() as connection:
            row = connection.execute("SELECT * FROM ppt_patches WHERE id = ?", (patch_id,)).fetchone()
            if not row:
                return None
            events = connection.execute("SELECT event_type, data_json, created_at FROM ppt_events WHERE patch_id = ? ORDER BY created_at", (patch_id,)).fetchall()
        item = dict(row)
        return {
            "id": item["id"], "presentationId": item["presentation_id"], "baseVersion": item["base_version_id"],
            "slideId": item["slide_id"], "instruction": item["instruction"], "model": item["model_name"],
            "modelOutputSha256": item["model_output_sha256"], "operations": json.loads(item["operations_json"]),
            "canonicalJson": item["canonical_json"],
            "patchHash": item["patch_sha256"], "status": item["status"], "warning": item["warning"],
            "verification": json.loads(item["verification_json"] or "{}"), "publishedVersionId": item["published_version_id"],
            "createdAt": item["created_at"], "updatedAt": item["updated_at"],
            "stagedPath": str(self._absolute(item["staged_relative_path"])) if item["staged_relative_path"] else None,
            "events": [{"type": e["event_type"], "data": json.loads(e["data_json"]), "createdAt": e["created_at"]} for e in events],
        }

    def list_assets(self, presentation_id: str) -> list[dict[str, Any]]:
        with self.database.connect() as connection:
            rows = connection.execute("SELECT id, file_name, mime_type, sha256 FROM ppt_assets WHERE presentation_id = ? ORDER BY created_at", (presentation_id,)).fetchall()
        return [{"id": row["id"], "uri": f"asset://upload/{row['id']}", "name": row["file_name"], "mimeType": row["mime_type"], "sha256": row["sha256"]} for row in rows]

    def update_patch(self, patch_id: str, status: str, *, staged_path: Path | None = None, verification: dict[str, Any] | None = None, published_version_id: str | None = None, event: str, event_data: dict[str, Any]) -> None:
        with self.database.connect() as connection:
            connection.execute(
                """UPDATE ppt_patches SET status = ?, staged_relative_path = COALESCE(?, staged_relative_path),
                   verification_json = COALESCE(?, verification_json), published_version_id = COALESCE(?, published_version_id), updated_at = ? WHERE id = ?""",
                (status, self._relative(staged_path) if staged_path else None, json.dumps(verification, ensure_ascii=False, sort_keys=True) if verification is not None else None, published_version_id, now_iso(), patch_id),
            )
            self._event(connection, patch_id, event, event_data)

    def staged_path(self, presentation_id: str, patch_id: str) -> Path:
        path = self.root / presentation_id / "staged" / patch_id / "candidate.pptx"
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    def publish_patch(self, patch: dict[str, Any], version_id: str, snapshot_path: Path, slides_dir: Path, file_sha256: str) -> dict[str, Any]:
        presentation_id = patch["presentationId"]
        version_dir = self.root / presentation_id / "versions" / version_id
        version_dir.mkdir(parents=True, exist_ok=True)
        destination = version_dir / "presentation.pptx"
        shutil.copy2(Path(patch["stagedPath"]), destination)
        final_snapshot = version_dir / "snapshot.json"
        shutil.copy2(snapshot_path, final_snapshot)
        if slides_dir.exists():
            shutil.copytree(slides_dir, version_dir / "slides", dirs_exist_ok=True)
        created = now_iso()
        with self.database.connect() as connection:
            current = connection.execute("SELECT current_version_id FROM ppt_presentations WHERE id = ?", (presentation_id,)).fetchone()
            if not current or current["current_version_id"] != patch["baseVersion"]:
                raise RuntimeError("PPT_BASE_VERSION_STALE")
            connection.execute(
                "INSERT INTO ppt_versions(id, presentation_id, parent_version_id, source_kind, file_sha256, relative_path, snapshot_path, created_at) VALUES(?, ?, ?, 'patch', ?, ?, ?, ?)",
                (version_id, presentation_id, patch["baseVersion"], file_sha256, self._relative(destination), self._relative(final_snapshot), created),
            )
            connection.execute("UPDATE ppt_presentations SET current_version_id = ?, updated_at = ? WHERE id = ?", (version_id, created, presentation_id))
        return {"id": version_id, "presentationId": presentation_id, "sha256": file_sha256, "createdAt": created}

    def new_version_id(self, presentation_id: str, digest: str) -> str:
        return self._version_id(presentation_id, digest)

    def restore_version(self, presentation_id: str, source_version_id: str) -> dict[str, Any]:
        source = self.get_version(presentation_id, source_version_id)
        current = self.get_version(presentation_id)
        if not source or not current:
            raise KeyError(source_version_id)
        digest = source["file_sha256"]
        version_id = self._version_id(presentation_id, digest)
        version_dir = self.root / presentation_id / "versions" / version_id
        version_dir.mkdir(parents=True, exist_ok=True)
        destination = version_dir / "presentation.pptx"
        snapshot = version_dir / "snapshot.json"
        shutil.copy2(source["path"], destination)
        shutil.copy2(source["snapshotPath"], snapshot)
        source_slides = Path(source["slidesDir"])
        if source_slides.exists():
            shutil.copytree(source_slides, version_dir / "slides", dirs_exist_ok=True)
        created = now_iso()
        with self.database.connect() as connection:
            connection.execute(
                "INSERT INTO ppt_versions(id, presentation_id, parent_version_id, source_kind, file_sha256, relative_path, snapshot_path, created_at) VALUES(?, ?, ?, 'restore', ?, ?, ?, ?)",
                (version_id, presentation_id, current["id"], digest, self._relative(destination), self._relative(snapshot), created),
            )
            connection.execute("UPDATE ppt_presentations SET current_version_id = ?, updated_at = ? WHERE id = ?", (version_id, created, presentation_id))
        return {"id": version_id, "presentationId": presentation_id, "restoredFrom": source_version_id, "createdAt": created}

    def delete_staged(self, patch: dict[str, Any]) -> None:
        shutil.rmtree(self.root / patch["presentationId"] / "staged" / patch["id"], ignore_errors=True)

    @staticmethod
    def _version_id(presentation_id: str, digest: str) -> str:
        return f"{presentation_id[:8]}@{digest[:12]}-{uuid4().hex[:8]}"

    @staticmethod
    def _presentation(row: Any) -> dict[str, Any]:
        item = dict(row)
        return {"id": item["id"], "name": item["name"], "originalSha256": item["original_sha256"], "currentVersionId": item["current_version_id"], "versionCount": int(item.get("version_count", 0)), "createdAt": item["created_at"], "updatedAt": item["updated_at"]}

    def _relative(self, path: Path) -> str:
        return str(Path(path).resolve().relative_to(self.root.resolve()))

    def _absolute(self, relative: str) -> Path:
        candidate = (self.root / relative).resolve()
        candidate.relative_to(self.root.resolve())
        return candidate

    @staticmethod
    def _event(connection: Any, patch_id: str, event_type: str, data: dict[str, Any]) -> None:
        connection.execute(
            "INSERT INTO ppt_events(id, patch_id, event_type, data_json, created_at) VALUES(?, ?, ?, ?, ?)",
            (str(uuid4()), patch_id, event_type, json.dumps(data, ensure_ascii=False, sort_keys=True), now_iso()),
        )
