from __future__ import annotations

import json
import hashlib
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Iterable
from uuid import uuid4


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


class Database:
    def __init__(self, path: Path):
        self.path = Path(path)

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        return connection

    def initialize(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS documents (
                  id TEXT PRIMARY KEY,
                  name TEXT NOT NULL,
                  source TEXT NOT NULL,
                  locator TEXT NOT NULL,
                  builtin INTEGER NOT NULL DEFAULT 0,
                  content TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  version_id TEXT,
                  file_sha256 TEXT,
                  mime_type TEXT NOT NULL DEFAULT 'text/plain',
                  security_level TEXT NOT NULL DEFAULT 'internal',
                  parser_name TEXT NOT NULL DEFAULT 'plain-text',
                  parser_version TEXT NOT NULL DEFAULT '1',
                  ingestion_status TEXT NOT NULL DEFAULT 'ready',
                  extraction_quality TEXT NOT NULL DEFAULT 'native',
                  parser_metadata_json TEXT NOT NULL DEFAULT '{}'
                );
                CREATE TABLE IF NOT EXISTS chunks (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                  locator TEXT NOT NULL,
                  content TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  stable_id TEXT,
                  version_id TEXT,
                  content_sha256 TEXT,
                  vector_id INTEGER,
                  security_level TEXT NOT NULL DEFAULT 'internal'
                );
                CREATE TABLE IF NOT EXISTS conversations (
                  id TEXT PRIMARY KEY,
                  title TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS messages (
                  id TEXT PRIMARY KEY,
                  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                  role TEXT NOT NULL,
                  content TEXT NOT NULL,
                  citations_json TEXT NOT NULL DEFAULT '[]',
                  metrics_json TEXT NOT NULL DEFAULT '{}',
                  created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS agent_runs (
                  id TEXT PRIMARY KEY,
                  conversation_id TEXT,
                  user_message TEXT NOT NULL,
                  route TEXT NOT NULL,
                  status TEXT NOT NULL,
                  model_name TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  completed_at TEXT
                );
                CREATE TABLE IF NOT EXISTS agent_steps (
                  id TEXT PRIMARY KEY,
                  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
                  step_index INTEGER NOT NULL,
                  action TEXT NOT NULL,
                  arguments_json TEXT NOT NULL,
                  status TEXT NOT NULL,
                  result_summary TEXT,
                  duration_ms INTEGER,
                  created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS retrieval_events (
                  id TEXT PRIMARY KEY,
                  request_id TEXT NOT NULL,
                  query_sha256 TEXT NOT NULL,
                  index_generation TEXT NOT NULL,
                  filters_json TEXT NOT NULL,
                  evidence_json TEXT NOT NULL,
                  status TEXT NOT NULL,
                  duration_ms INTEGER NOT NULL,
                  created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS agent_plans (
                  id TEXT PRIMARY KEY,
                  request_id TEXT NOT NULL,
                  conversation_id TEXT,
                  tool TEXT NOT NULL,
                  arguments_json TEXT NOT NULL,
                  canonical_json TEXT NOT NULL,
                  plan_sha256 TEXT NOT NULL,
                  risk_class TEXT NOT NULL,
                  policy_version TEXT NOT NULL,
                  model_name TEXT NOT NULL,
                  model_output_sha256 TEXT,
                  request_input_sha256 TEXT,
                  status TEXT NOT NULL,
                  expires_at TEXT,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS agent_plan_events (
                  id TEXT PRIMARY KEY,
                  plan_id TEXT NOT NULL REFERENCES agent_plans(id) ON DELETE CASCADE,
                  event_type TEXT NOT NULL,
                  detail_json TEXT NOT NULL DEFAULT '{}',
                  created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS agent_confirmations (
                  id TEXT PRIMARY KEY,
                  plan_id TEXT NOT NULL REFERENCES agent_plans(id) ON DELETE CASCADE,
                  plan_sha256 TEXT NOT NULL,
                  user_id TEXT NOT NULL,
                  nonce_sha256 TEXT NOT NULL,
                  expires_at TEXT NOT NULL,
                  status TEXT NOT NULL,
                  consumed_at TEXT,
                  created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS agent_tool_attempts (
                  id TEXT PRIMARY KEY,
                  plan_id TEXT NOT NULL REFERENCES agent_plans(id) ON DELETE CASCADE,
                  idempotency_key TEXT NOT NULL,
                  status TEXT NOT NULL,
                  result_json TEXT NOT NULL DEFAULT '{}',
                  error_code TEXT,
                  started_at TEXT NOT NULL,
                  completed_at TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks(document_id);
                CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id, created_at);
                CREATE INDEX IF NOT EXISTS idx_agent_steps_run_id ON agent_steps(run_id, step_index);
                CREATE INDEX IF NOT EXISTS idx_retrieval_events_request_id ON retrieval_events(request_id, created_at);
                CREATE INDEX IF NOT EXISTS idx_agent_plans_request_id ON agent_plans(request_id, created_at);
                CREATE INDEX IF NOT EXISTS idx_agent_plan_events_plan_id ON agent_plan_events(plan_id, created_at);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tool_attempts_idempotency ON agent_tool_attempts(idempotency_key);
                """
            )
            self._ensure_columns(connection)
            self._backfill_provenance(connection)
            connection.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_stable_id ON chunks(stable_id)")
            connection.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_vector_id ON chunks(vector_id)")

    @staticmethod
    def _ensure_columns(connection: sqlite3.Connection) -> None:
        """SQLite-compatible additive migration for databases created by earlier demos."""
        expected = {
            "documents": {
                "version_id": "TEXT", "file_sha256": "TEXT", "mime_type": "TEXT NOT NULL DEFAULT 'text/plain'",
                "security_level": "TEXT NOT NULL DEFAULT 'internal'", "parser_name": "TEXT NOT NULL DEFAULT 'plain-text'",
                "parser_version": "TEXT NOT NULL DEFAULT '1'", "ingestion_status": "TEXT NOT NULL DEFAULT 'ready'",
                "extraction_quality": "TEXT NOT NULL DEFAULT 'native'", "parser_metadata_json": "TEXT NOT NULL DEFAULT '{}'",
            },
            "chunks": {
                "stable_id": "TEXT", "version_id": "TEXT", "content_sha256": "TEXT", "vector_id": "INTEGER",
                "security_level": "TEXT NOT NULL DEFAULT 'internal'",
            },
            "agent_plans": {"request_input_sha256": "TEXT"},
        }
        for table, columns in expected.items():
            existing = {row["name"] for row in connection.execute(f"PRAGMA table_info({table})")}
            for name, definition in columns.items():
                if name not in existing:
                    connection.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")

    @staticmethod
    def _backfill_provenance(connection: sqlite3.Connection) -> None:
        rows = connection.execute("SELECT id, content, version_id, file_sha256 FROM documents").fetchall()
        for row in rows:
            content_hash = hashlib.sha256(str(row["content"]).encode("utf-8")).hexdigest()
            version_id = row["version_id"] or f"{row['id']}@{content_hash[:12]}"
            connection.execute(
                "UPDATE documents SET file_sha256 = COALESCE(file_sha256, ?), version_id = COALESCE(version_id, ?) WHERE id = ?",
                (content_hash, version_id, row["id"]),
            )

    def seed_documents(self, documents: Iterable[dict[str, Any]]) -> bool:
        with self.connect() as connection:
            existing = connection.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
            if existing:
                return False
            created_at = now_iso()
            for document in documents:
                content = str(document["content"])
                content_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
                connection.execute(
                    """INSERT INTO documents(
                         id, name, source, locator, builtin, content, created_at, version_id, file_sha256,
                         mime_type, security_level, parser_name, parser_version, ingestion_status
                       ) VALUES(
                         :id, :name, :source, :locator, :builtin, :content, :created_at, :version_id, :file_sha256,
                         :mime_type, :security_level, :parser_name, :parser_version, :ingestion_status
                       )""",
                    {
                        **document, "content": content, "builtin": 1, "created_at": created_at,
                        "version_id": f"{document['id']}@{content_hash[:12]}", "file_sha256": content_hash,
                        "mime_type": "text/plain", "security_level": "internal", "parser_name": "seed-text",
                        "parser_version": "1", "ingestion_status": "ready",
                    },
                )
        return True

    def list_documents(self, keyword: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
        sql = "SELECT * FROM documents"
        params: list[Any] = []
        if keyword:
            sql += " WHERE name LIKE ? OR content LIKE ?"
            params.extend([f"%{keyword}%", f"%{keyword}%"])
        sql += " ORDER BY builtin DESC, created_at ASC LIMIT ?"
        params.append(limit)
        with self.connect() as connection:
            return [self._document_summary(row) for row in connection.execute(sql, params).fetchall()]

    def get_document(self, document_id: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute("SELECT * FROM documents WHERE id = ?", (document_id,)).fetchone()
        return dict(row) if row else None

    def create_document(
        self,
        name: str,
        content: str,
        source: str = "用户导入",
        security_level: str = "internal",
        mime_type: str | None = None,
        locator: str = "文本内容",
        parser_name: str = "plain-text",
        parser_version: str = "1",
        file_sha256: str | None = None,
        extraction_quality: str = "native",
        parser_metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        document_id = str(uuid4())
        content_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
        identity_hash = file_sha256 or content_hash
        extension = Path(name).suffix.lower()
        detected_mime = "text/markdown" if extension == ".md" else "text/plain"
        document = {
            "id": document_id,
            "name": name,
            "source": source,
            "locator": locator,
            "builtin": 0,
            "content": content,
            "created_at": now_iso(),
            "version_id": f"{document_id}@{identity_hash[:12]}",
            "file_sha256": identity_hash,
            "mime_type": mime_type or detected_mime,
            "security_level": security_level,
            "parser_name": parser_name,
            "parser_version": parser_version,
            "ingestion_status": "ready",
            "extraction_quality": extraction_quality,
            "parser_metadata_json": json.dumps(parser_metadata or {}, ensure_ascii=False, sort_keys=True),
        }
        with self.connect() as connection:
            connection.execute(
                """INSERT INTO documents(
                     id, name, source, locator, builtin, content, created_at, version_id, file_sha256,
                     mime_type, security_level, parser_name, parser_version, ingestion_status,
                     extraction_quality, parser_metadata_json
                   ) VALUES(
                     :id, :name, :source, :locator, :builtin, :content, :created_at, :version_id, :file_sha256,
                     :mime_type, :security_level, :parser_name, :parser_version, :ingestion_status,
                     :extraction_quality, :parser_metadata_json
                   )""",
                document,
            )
        return self._document_summary(document)

    def delete_document(self, document_id: str) -> str:
        with self.connect() as connection:
            document = connection.execute("SELECT builtin FROM documents WHERE id = ?", (document_id,)).fetchone()
            if not document:
                return "not_found"
            if document["builtin"]:
                return "builtin"
            connection.execute("DELETE FROM documents WHERE id = ?", (document_id,))
        return "deleted"

    def replace_chunks(self, chunks: Iterable[dict[str, Any]]) -> None:
        with self.connect() as connection:
            connection.execute("DELETE FROM chunks")
            connection.executemany(
                """INSERT INTO chunks(
                     document_id, locator, content, created_at, stable_id, version_id,
                     content_sha256, vector_id, security_level
                   ) VALUES(
                     :document_id, :locator, :content, :created_at, :stable_id, :version_id,
                     :content_sha256, :vector_id, :security_level
                   )""",
                list(chunks),
            )

    def list_chunks(self) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                """SELECT chunks.id, chunks.document_id, chunks.locator, chunks.content, chunks.stable_id,
                          chunks.version_id, chunks.content_sha256, chunks.vector_id, chunks.security_level,
                          documents.name AS file_name, documents.source AS source, documents.file_sha256,
                          documents.mime_type, documents.ingestion_status
                   FROM chunks JOIN documents ON chunks.document_id = documents.id
                   ORDER BY chunks.document_id, chunks.stable_id"""
            ).fetchall()
        return [dict(row) for row in rows]

    def chunks_by_ids(self, chunk_ids: Iterable[int]) -> dict[int, dict[str, Any]]:
        ids = [int(item) for item in chunk_ids if int(item) >= 0]
        if not ids:
            return {}
        placeholders = ",".join("?" for _ in ids)
        with self.connect() as connection:
            rows = connection.execute(
                f"""SELECT chunks.id, chunks.document_id, chunks.locator, chunks.content, chunks.stable_id,
                           chunks.version_id, chunks.content_sha256, chunks.vector_id, chunks.security_level,
                           documents.name AS file_name, documents.source AS source
                    FROM chunks JOIN documents ON chunks.document_id = documents.id
                    WHERE chunks.id IN ({placeholders})""",
                ids,
            ).fetchall()
        return {int(row["id"]): dict(row) for row in rows}

    def add_retrieval_event(
        self,
        request_id: str,
        query_sha256: str,
        index_generation: str,
        filters: dict[str, Any],
        evidence: list[dict[str, Any]],
        status: str,
        duration_ms: int,
    ) -> None:
        with self.connect() as connection:
            connection.execute(
                """INSERT INTO retrieval_events(
                     id, request_id, query_sha256, index_generation, filters_json, evidence_json,
                     status, duration_ms, created_at
                   ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    str(uuid4()), request_id, query_sha256, index_generation,
                    json.dumps(filters, ensure_ascii=False), json.dumps(evidence, ensure_ascii=False),
                    status, duration_ms, now_iso(),
                ),
            )

    def create_agent_plan(
        self,
        *,
        request_id: str,
        conversation_id: str | None,
        tool: str,
        arguments: dict[str, Any],
        canonical_json: str,
        plan_sha256: str,
        risk_class: str,
        policy_version: str,
        model_name: str,
        model_output_sha256: str | None,
        request_input_sha256: str,
        status: str,
        expires_in_seconds: int | None = None,
    ) -> dict[str, Any]:
        created_at = now_iso()
        expires_at = (datetime.now(UTC) + timedelta(seconds=expires_in_seconds)).isoformat() if expires_in_seconds else None
        plan = {
            "id": str(uuid4()), "request_id": request_id, "conversation_id": conversation_id,
            "tool": tool, "arguments_json": json.dumps(arguments, ensure_ascii=False, sort_keys=True),
            "canonical_json": canonical_json, "plan_sha256": plan_sha256, "risk_class": risk_class,
            "policy_version": policy_version, "model_name": model_name, "model_output_sha256": model_output_sha256,
            "request_input_sha256": request_input_sha256,
            "status": status, "expires_at": expires_at, "created_at": created_at, "updated_at": created_at,
        }
        with self.connect() as connection:
            connection.execute(
                """INSERT INTO agent_plans(id, request_id, conversation_id, tool, arguments_json, canonical_json,
                   plan_sha256, risk_class, policy_version, model_name, model_output_sha256, request_input_sha256, status, expires_at, created_at, updated_at)
                   VALUES(:id, :request_id, :conversation_id, :tool, :arguments_json, :canonical_json, :plan_sha256,
                   :risk_class, :policy_version, :model_name, :model_output_sha256, :request_input_sha256, :status, :expires_at, :created_at, :updated_at)""",
                plan,
            )
            self._add_plan_event(connection, plan["id"], "RECEIVED", {"status": status, "inputSha256": request_input_sha256})
            self._add_plan_event(connection, plan["id"], "PLANNED", {"tool": tool, "riskClass": risk_class})
            self._add_plan_event(connection, plan["id"], "VALIDATED", {"policyVersion": policy_version})
        return self.get_agent_plan(plan["id"]) or {}

    @staticmethod
    def _add_plan_event(connection: sqlite3.Connection, plan_id: str, event_type: str, detail: dict[str, Any] | None = None) -> None:
        connection.execute(
            "INSERT INTO agent_plan_events(id, plan_id, event_type, detail_json, created_at) VALUES(?, ?, ?, ?, ?)",
            (str(uuid4()), plan_id, event_type, json.dumps(detail or {}, ensure_ascii=False, sort_keys=True), now_iso()),
        )

    def add_plan_event(self, plan_id: str, event_type: str, detail: dict[str, Any] | None = None) -> None:
        with self.connect() as connection:
            self._add_plan_event(connection, plan_id, event_type, detail)

    def get_agent_plan(self, plan_id: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            plan = connection.execute("SELECT * FROM agent_plans WHERE id = ?", (plan_id,)).fetchone()
            if not plan:
                return None
            events = connection.execute("SELECT event_type, detail_json, created_at FROM agent_plan_events WHERE plan_id = ? ORDER BY created_at", (plan_id,)).fetchall()
        return self._agent_plan(plan, events)

    def update_agent_plan_status(self, plan_id: str, status: str, event_type: str, detail: dict[str, Any] | None = None) -> None:
        with self.connect() as connection:
            connection.execute("UPDATE agent_plans SET status = ?, updated_at = ? WHERE id = ?", (status, now_iso(), plan_id))
            self._add_plan_event(connection, plan_id, event_type, detail)

    def create_confirmation(self, plan_id: str, plan_sha256: str, user_id: str, expires_at: str, nonce_sha256: str) -> str:
        confirmation_id = str(uuid4())
        with self.connect() as connection:
            connection.execute(
                """INSERT INTO agent_confirmations(id, plan_id, plan_sha256, user_id, nonce_sha256, expires_at, status, created_at)
                   VALUES(?, ?, ?, ?, ?, ?, 'PENDING', ?)""",
                (confirmation_id, plan_id, plan_sha256, user_id, nonce_sha256, expires_at, now_iso()),
            )
            self._add_plan_event(connection, plan_id, "AWAITING_CONFIRMATION", {"confirmationId": confirmation_id, "expiresAt": expires_at})
        return confirmation_id

    def consume_confirmation(self, plan_id: str, confirmation_id: str, plan_sha256: str, user_id: str, nonce_sha256: str) -> str:
        """Atomically consume a bound, unexpired confirmation. Returns a machine-readable state."""
        now = now_iso()
        with self.connect() as connection:
            plan = connection.execute("SELECT status, plan_sha256, expires_at FROM agent_plans WHERE id = ?", (plan_id,)).fetchone()
            if not plan:
                return "NOT_FOUND"
            if plan["status"] != "AWAITING_CONFIRMATION":
                return "INVALID_STATE"
            if plan["plan_sha256"] != plan_sha256 or (plan["expires_at"] and plan["expires_at"] <= now):
                connection.execute("UPDATE agent_plans SET status = 'EXPIRED', updated_at = ? WHERE id = ?", (now, plan_id))
                self._add_plan_event(connection, plan_id, "EXPIRED", {})
                return "EXPIRED"
            confirmation = connection.execute(
                "SELECT * FROM agent_confirmations WHERE id = ? AND plan_id = ?", (confirmation_id, plan_id)
            ).fetchone()
            if not confirmation or confirmation["status"] != "PENDING":
                return "REPLAYED"
            if (confirmation["plan_sha256"] != plan_sha256 or confirmation["user_id"] != user_id or
                    confirmation["nonce_sha256"] != nonce_sha256 or confirmation["expires_at"] <= now):
                return "DENIED"
            connection.execute("UPDATE agent_confirmations SET status = 'CONSUMED', consumed_at = ? WHERE id = ?", (now, confirmation_id))
            connection.execute("UPDATE agent_plans SET status = 'CONFIRMED', updated_at = ? WHERE id = ?", (now, plan_id))
            self._add_plan_event(connection, plan_id, "CONFIRMED", {"confirmationId": confirmation_id})
        return "CONFIRMED"

    def cancel_agent_plan(self, plan_id: str) -> str:
        with self.connect() as connection:
            plan = connection.execute("SELECT status FROM agent_plans WHERE id = ?", (plan_id,)).fetchone()
            if not plan:
                return "NOT_FOUND"
            if plan["status"] not in {"RECEIVED", "PLANNED", "VALIDATED", "AWAITING_CONFIRMATION"}:
                return "INVALID_STATE"
            connection.execute("UPDATE agent_plans SET status = 'CANCELLED', updated_at = ? WHERE id = ?", (now_iso(), plan_id))
            self._add_plan_event(connection, plan_id, "CANCELLED", {})
        return "CANCELLED"

    def create_tool_attempt(self, plan_id: str, idempotency_key: str) -> str:
        attempt_id = str(uuid4())
        with self.connect() as connection:
            connection.execute(
                "INSERT INTO agent_tool_attempts(id, plan_id, idempotency_key, status, started_at) VALUES(?, ?, ?, 'EXECUTING', ?)",
                (attempt_id, plan_id, idempotency_key, now_iso()),
            )
        return attempt_id

    def finish_tool_attempt(self, attempt_id: str, status: str, result: dict[str, Any], error_code: str | None = None) -> None:
        safe_result = self._redact_for_audit(result)
        with self.connect() as connection:
            connection.execute(
                "UPDATE agent_tool_attempts SET status = ?, result_json = ?, error_code = ?, completed_at = ? WHERE id = ?",
                (status, json.dumps(safe_result, ensure_ascii=False, sort_keys=True), error_code, now_iso(), attempt_id),
            )

    def audit_for_request(self, request_id: str) -> dict[str, Any]:
        with self.connect() as connection:
            plans = connection.execute("SELECT * FROM agent_plans WHERE request_id = ? ORDER BY created_at", (request_id,)).fetchall()
            retrievals = connection.execute(
                "SELECT index_generation, filters_json, evidence_json, status, duration_ms, created_at FROM retrieval_events WHERE request_id = ? ORDER BY created_at",
                (request_id,),
            ).fetchall()
            events_by_plan = {
                plan["id"]: connection.execute(
                    "SELECT event_type, detail_json, created_at FROM agent_plan_events WHERE plan_id = ? ORDER BY created_at", (plan["id"],)
                ).fetchall()
                for plan in plans
            }
            attempts_by_plan = {
                plan["id"]: connection.execute(
                    "SELECT id, idempotency_key, status, result_json, error_code, started_at, completed_at FROM agent_tool_attempts WHERE plan_id = ? ORDER BY started_at",
                    (plan["id"],),
                ).fetchall()
                for plan in plans
            }
            confirmations_by_plan = {
                plan["id"]: connection.execute(
                    "SELECT id, plan_sha256, user_id, expires_at, status, consumed_at, created_at FROM agent_confirmations WHERE plan_id = ? ORDER BY created_at",
                    (plan["id"],),
                ).fetchall()
                for plan in plans
            }
        audit_plans = []
        for plan in plans:
            item = self._agent_plan(plan, events_by_plan[plan["id"]])
            item["arguments"] = self._redact_for_audit(item["arguments"])
            item["events"] = self._redact_for_audit(item["events"])
            item["toolAttempts"] = [
                {
                    "id": attempt["id"], "idempotencyKey": attempt["idempotency_key"], "status": attempt["status"],
                    "result": self._redact_for_audit(json.loads(attempt["result_json"])), "errorCode": attempt["error_code"],
                    "startedAt": attempt["started_at"], "completedAt": attempt["completed_at"],
                }
                for attempt in attempts_by_plan[plan["id"]]
            ]
            item["confirmations"] = [dict(confirmation) for confirmation in confirmations_by_plan[plan["id"]]]
            audit_plans.append(item)
        audit_retrieval = [
            {
                "indexGeneration": row["index_generation"], "filters": json.loads(row["filters_json"]),
                "evidence": json.loads(row["evidence_json"]), "status": row["status"],
                "durationMs": row["duration_ms"], "createdAt": row["created_at"],
            }
            for row in retrievals
        ]
        return {"requestId": request_id, "plans": audit_plans, "retrieval": audit_retrieval}

    @staticmethod
    def _redact_for_audit(value: Any) -> Any:
        if isinstance(value, dict):
            return {key: ("[REDACTED]" if key.lower() in {"body", "content", "token", "password", "secret", "authorization"} else Database._redact_for_audit(item)) for key, item in value.items()}
        if isinstance(value, list):
            return [Database._redact_for_audit(item) for item in value]
        return value

    @staticmethod
    def _agent_plan(row: sqlite3.Row | dict[str, Any], events: Iterable[sqlite3.Row] = ()) -> dict[str, Any]:
        plan = dict(row)
        return {
            "id": plan["id"], "requestId": plan["request_id"], "conversationId": plan["conversation_id"],
            "tool": plan["tool"], "arguments": json.loads(plan["arguments_json"]), "planHash": plan["plan_sha256"],
            "riskClass": plan["risk_class"], "policyVersion": plan["policy_version"], "model": plan["model_name"],
            "inputSha256": plan.get("request_input_sha256"), "modelOutputSha256": plan.get("model_output_sha256"),
            "status": plan["status"], "expiresAt": plan["expires_at"], "createdAt": plan["created_at"],
            "updatedAt": plan["updated_at"],
            "events": [{"type": item["event_type"], "detail": json.loads(item["detail_json"]), "createdAt": item["created_at"]} for item in events],
        }

    def create_conversation(self) -> dict[str, Any]:
        conversation = {"id": str(uuid4()), "title": "新对话", "created_at": now_iso(), "updated_at": now_iso()}
        with self.connect() as connection:
            connection.execute(
                "INSERT INTO conversations(id, title, created_at, updated_at) VALUES(:id, :title, :created_at, :updated_at)",
                conversation,
            )
        return self._conversation_summary(conversation, 0)

    def list_conversations(self) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                """SELECT conversations.*, COUNT(messages.id) AS message_count
                   FROM conversations LEFT JOIN messages ON messages.conversation_id = conversations.id
                   GROUP BY conversations.id ORDER BY conversations.updated_at DESC"""
            ).fetchall()
        return [self._conversation_summary(row, int(row["message_count"])) for row in rows]

    def get_conversation(self, conversation_id: str) -> dict[str, Any] | None:
        with self.connect() as connection:
            conversation = connection.execute("SELECT * FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
            if not conversation:
                return None
            messages = connection.execute(
                "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at", (conversation_id,)
            ).fetchall()
        return {
            **self._conversation_summary(conversation, len(messages)),
            "messages": [self._message(row) for row in messages],
        }

    def add_message(
        self,
        conversation_id: str,
        role: str,
        content: str,
        citations: list[dict[str, Any]] | None = None,
        metrics: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        created_at = now_iso()
        message = {
            "id": str(uuid4()),
            "conversation_id": conversation_id,
            "role": role,
            "content": content,
            "citations_json": json.dumps(citations or [], ensure_ascii=False),
            "metrics_json": json.dumps(metrics or {}, ensure_ascii=False),
            "created_at": created_at,
        }
        with self.connect() as connection:
            connection.execute(
                """INSERT INTO messages(id, conversation_id, role, content, citations_json, metrics_json, created_at)
                   VALUES(:id, :conversation_id, :role, :content, :citations_json, :metrics_json, :created_at)""",
                message,
            )
            if role == "user":
                conversation = connection.execute("SELECT title FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
                if conversation and conversation["title"] == "新对话":
                    connection.execute("UPDATE conversations SET title = ? WHERE id = ?", (content[:16], conversation_id))
            connection.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (created_at, conversation_id))
        return self._message(message)

    def create_agent_run(self, conversation_id: str | None, user_message: str, route: str, model_name: str) -> str:
        run_id = str(uuid4())
        with self.connect() as connection:
            connection.execute(
                """INSERT INTO agent_runs(id, conversation_id, user_message, route, status, model_name, created_at)
                   VALUES(?, ?, ?, ?, 'running', ?, ?)""",
                (run_id, conversation_id, user_message, route, model_name, now_iso()),
            )
        return run_id

    def add_agent_step(self, run_id: str, step_index: int, action: str, arguments: dict[str, Any], status: str, result_summary: str, duration_ms: int) -> None:
        with self.connect() as connection:
            connection.execute(
                """INSERT INTO agent_steps(id, run_id, step_index, action, arguments_json, status, result_summary, duration_ms, created_at)
                   VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (str(uuid4()), run_id, step_index, action, json.dumps(arguments, ensure_ascii=False), status, result_summary[:1000], duration_ms, now_iso()),
            )

    def finish_agent_run(self, run_id: str, status: str) -> None:
        with self.connect() as connection:
            connection.execute("UPDATE agent_runs SET status = ?, completed_at = ? WHERE id = ?", (status, now_iso(), run_id))

    @staticmethod
    def _document_summary(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
        document = dict(row)
        return {
            "id": document["id"], "name": document["name"], "source": document["source"],
            "locator": document["locator"], "builtin": bool(document["builtin"]),
            "characters": len(document["content"]), "createdAt": document["created_at"],
            "versionId": document.get("version_id"), "fileSha256": document.get("file_sha256"),
            "mimeType": document.get("mime_type", "text/plain"), "securityLevel": document.get("security_level", "internal"),
            "ingestionStatus": document.get("ingestion_status", "ready"), "parserName": document.get("parser_name", "plain-text"),
            "extractionQuality": document.get("extraction_quality", "native"),
            "parserMetadata": json.loads(document.get("parser_metadata_json") or "{}"),
        }

    @staticmethod
    def _conversation_summary(row: sqlite3.Row | dict[str, Any], message_count: int) -> dict[str, Any]:
        item = dict(row)
        return {"id": item["id"], "title": item["title"], "createdAt": item["created_at"], "messageCount": message_count}

    @staticmethod
    def _message(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
        item = dict(row)
        return {
            "id": item["id"], "role": item["role"], "content": item["content"],
            "citations": json.loads(item["citations_json"]), "metrics": json.loads(item["metrics_json"]),
            "createdAt": item["created_at"],
        }
