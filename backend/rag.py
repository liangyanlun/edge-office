from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import threading
import time
from collections import Counter, defaultdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

import faiss
import numpy as np

from .database import Database


DEFAULT_QUERY_INSTRUCTION = "为这个句子生成表示以用于检索相关文章："
_VECTOR_MASK = (1 << 63) - 1


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for block in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _tokens(text: str) -> list[str]:
    """Mixed Chinese/English tokens for lexical recall and sentence selection."""
    normalized = str(text or "").lower()
    output = re.findall(r"[a-z0-9]+", normalized)
    for phrase in re.findall(r"[\u4e00-\u9fff]{2,}", normalized):
        output.append(phrase)
        output.extend(phrase[index:index + 2] for index in range(len(phrase) - 1))
    return output or ["空文本"]


class EmbeddingProvider:
    """Local BGE embeddings; hash vectors are explicit degraded-demo mode only."""

    dimension = 384

    def __init__(self, model_path: str = "", query_instruction: str = DEFAULT_QUERY_INSTRUCTION):
        self.model_path = Path(model_path).expanduser() if model_path else None
        self.query_instruction = query_instruction
        self._model: Any | None = None
        self._model_sha256: str | None = None
        self.name = "hash-embedding-384"
        self.mode = "offline-fallback"
        self.fallback_reason = "未找到本地嵌入模型"
        if self.model_path and self.model_path.exists():
            self.name = self.model_path.name
            self.mode = "local-sentence-transformer"
            self.fallback_reason = ""

    def _load_model(self) -> Any:
        if self.mode != "local-sentence-transformer":
            return None
        if self._model is None:
            from sentence_transformers import SentenceTransformer

            self._model = SentenceTransformer(str(self.model_path), local_files_only=True)
            get_dimension = getattr(self._model, "get_embedding_dimension", self._model.get_sentence_embedding_dimension)
            self.dimension = int(get_dimension())
        return self._model

    def encode_passages(self, texts: list[str]) -> np.ndarray:
        if self.mode == "local-sentence-transformer":
            model = self._load_model()
            vectors = model.encode(texts, normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False)
            return np.ascontiguousarray(vectors.astype("float32"))
        return self._hash_encode(texts)

    def encode_query(self, query: str) -> np.ndarray:
        text = f"{self.query_instruction}{query}" if self.mode == "local-sentence-transformer" else query
        return self.encode_passages([text])

    def _hash_encode(self, texts: list[str]) -> np.ndarray:
        vectors = np.zeros((len(texts), self.dimension), dtype="float32")
        for row, text in enumerate(texts):
            for token in _tokens(text):
                digest = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
                bucket = int.from_bytes(digest[:4], "little") % self.dimension
                vectors[row, bucket] += 1.0 if digest[4] % 2 else -1.0
        norms = np.linalg.norm(vectors, axis=1, keepdims=True)
        vectors /= np.maximum(norms, 1e-8)
        return vectors

    def status(self) -> dict[str, Any]:
        model_file = self.model_path / "model.safetensors" if self.model_path else None
        if model_file and model_file.is_file() and self._model_sha256 is None:
            self._model_sha256 = _sha256_file(model_file)
        return {
            "name": self.name,
            "mode": self.mode,
            "dimension": self.dimension,
            "configuredPath": str(self.model_path or ""),
            "modelSha256": self._model_sha256,
            "queryInstruction": self.query_instruction if self.mode == "local-sentence-transformer" else "",
            "fallbackReason": self.fallback_reason or None,
        }


class Bm25Ranker:
    """Small in-process lexical retriever; deterministic and dependency-free."""

    def __init__(self, chunks: list[dict[str, Any]]):
        self.chunk_ids = [int(chunk["vector_id"]) for chunk in chunks]
        self.term_frequencies = [Counter(_tokens(chunk["content"])) for chunk in chunks]
        self.lengths = [sum(frequencies.values()) for frequencies in self.term_frequencies]
        self.average_length = sum(self.lengths) / max(1, len(self.lengths))
        document_frequency: Counter[str] = Counter()
        for frequencies in self.term_frequencies:
            document_frequency.update(frequencies.keys())
        self.document_frequency = document_frequency

    def search(self, query: str, limit: int, eligible_ids: set[int] | None = None) -> list[tuple[int, float]]:
        if not self.chunk_ids:
            return []
        query_terms = set(_tokens(query))
        count = len(self.chunk_ids)
        scores: list[tuple[int, float]] = []
        for index, frequencies in enumerate(self.term_frequencies):
            chunk_id = self.chunk_ids[index]
            if eligible_ids is not None and chunk_id not in eligible_ids:
                continue
            score = 0.0
            for term in query_terms:
                frequency = frequencies.get(term, 0)
                if not frequency:
                    continue
                idf = math.log(1 + (count - self.document_frequency[term] + 0.5) / (self.document_frequency[term] + 0.5))
                denominator = frequency + 1.5 * (1 - 0.75 + 0.75 * self.lengths[index] / self.average_length)
                score += idf * frequency * 2.5 / denominator
            if score > 0:
                scores.append((chunk_id, score))
        return sorted(scores, key=lambda item: item[1], reverse=True)[:limit]


def chunk_document(document: dict[str, Any], max_characters: int = 360, overlap: int = 48) -> list[dict[str, Any]]:
    """Sentence-aware chunks with stable IDs and evidence hashes."""
    content = str(document["content"]).strip()
    version_id = str(document.get("version_id") or f"{document['id']}@{_sha256_text(content)[:12]}")
    security_level = str(document.get("security_level") or "internal")
    marker = re.compile(r"\[\[LOCATOR:([^\]]+)\]\]\s*")
    source_units: list[tuple[str, str]] = []
    cursor, locator = 0, str(document["locator"])
    for match in marker.finditer(content):
        preceding = content[cursor:match.start()].strip()
        if preceding:
            source_units.append((locator, preceding))
        locator, cursor = match.group(1).strip() or locator, match.end()
    trailing = content[cursor:].strip()
    if trailing:
        source_units.append((locator, trailing))
    if not source_units:
        source_units = [(str(document["locator"]), content)]

    chunks: list[tuple[str, str]] = []
    for unit_locator, unit_content in source_units:
        parts = [piece.strip() for piece in re.split(r"\n{2,}|(?<=[。！？；])", unit_content) if piece.strip()]
        buffer = ""
        for part in parts or [unit_content]:
            while part:
                separator = "\n" if buffer else ""
                space = max_characters - len(buffer) - len(separator)
                if space <= 0:
                    chunks.append((unit_locator, buffer))
                    buffer = buffer[-overlap:]
                    continue
                if len(part) > space:
                    buffer = f"{buffer}{separator}{part[:space]}".strip()
                    chunks.append((unit_locator, buffer))
                    buffer = buffer[-overlap:]
                    part = part[space:]
                    continue
                buffer = f"{buffer}{separator}{part}".strip()
                break
        if buffer:
            chunks.append((unit_locator, buffer))
    created_at = datetime.now(UTC).isoformat()
    used_vector_ids: set[int] = set()
    output: list[dict[str, Any]] = []
    for index, (chunk_locator, chunk) in enumerate(chunks):
        if not chunk.strip():
            continue
        content_hash = _sha256_text(chunk)
        stable_id = f"{version_id}#chunk-{index + 1:04d}-{content_hash[:12]}"
        vector_id = int.from_bytes(hashlib.sha256(stable_id.encode("utf-8")).digest()[:8], "big") & _VECTOR_MASK
        while vector_id in used_vector_ids:
            vector_id = (vector_id + 1) & _VECTOR_MASK
        used_vector_ids.add(vector_id)
        output.append(
            {
                "document_id": document["id"], "locator": f"{chunk_locator} · 片段 {index + 1}",
                "content": chunk, "created_at": created_at, "stable_id": stable_id, "version_id": version_id,
                "content_sha256": content_hash, "vector_id": vector_id, "security_level": security_level,
            }
        )
    return output


class FaissRagService:
    """Offline hybrid RAG with provenance, authorization-before-scoring and atomic generations."""

    def __init__(
        self,
        database: Database,
        index_dir: Path,
        embedding_model_path: str = "",
        query_instruction: str = DEFAULT_QUERY_INSTRUCTION,
        candidate_k: int = 12,
        rerank_k: int = 5,
        min_confidence: float = 0.42,
        allowed_security_levels: tuple[str, ...] = ("public", "internal"),
    ):
        self.database = database
        self.index_dir = Path(index_dir)
        self.index_path = self.index_dir / "knowledge.faiss"  # Compatibility copy for existing tooling.
        self.meta_path = self.index_dir / "knowledge.manifest.json"
        self.generations_dir = self.index_dir / "generations"
        self.active_path = self.index_dir / "active.json"
        self.embedder = EmbeddingProvider(embedding_model_path, query_instruction)
        self.candidate_k = max(4, candidate_k)
        self.rerank_k = max(1, min(6, rerank_k))
        self.min_confidence = max(0.0, min(0.99, min_confidence))
        self.allowed_security_levels = frozenset(allowed_security_levels)
        self.index: faiss.IndexIDMap2 | None = None
        self._vectors = np.zeros((0, self.embedder.dimension), dtype="float32")
        self._chunks_by_vector_id: dict[int, dict[str, Any]] = {}
        self._chunks_by_document: dict[str, list[dict[str, Any]]] = {}
        self._vector_row: dict[int, int] = {}
        self._bm25 = Bm25Ranker([])
        self._active_generation = "unbuilt"
        self._manifest: dict[str, Any] = {}
        self._state_lock = threading.RLock()
        self._rebuild_lock = threading.Lock()

    def initialize(self) -> None:
        self.index_dir.mkdir(parents=True, exist_ok=True)
        self.generations_dir.mkdir(parents=True, exist_ok=True)
        self.rebuild()

    def rebuild(self) -> dict[str, Any]:
        """Build a verified generation before swapping the active in-memory snapshot."""
        with self._rebuild_lock:
            documents = [self.database.get_document(item["id"]) for item in self.database.list_documents()]
            chunk_rows = [chunk for document in documents if document for chunk in chunk_document(document)]
            document_metadata = {str(document["id"]): document for document in documents if document}
            for row in chunk_rows:
                document = document_metadata[str(row["document_id"])]
                row["file_name"] = document["name"]
                row["source"] = document["source"]
                row["file_sha256"] = document["file_sha256"]
            used_vector_ids: set[int] = set()
            for row in chunk_rows:
                while int(row["vector_id"]) in used_vector_ids:
                    row["vector_id"] = (int(row["vector_id"]) + 1) & _VECTOR_MASK
                used_vector_ids.add(int(row["vector_id"]))
            vectors = self.embedder.encode_passages([item["content"] for item in chunk_rows]) if chunk_rows else np.zeros((0, self.embedder.dimension), dtype="float32")
            vectors = np.ascontiguousarray(vectors.astype("float32"))
            dimension = int(vectors.shape[1]) if len(vectors) else self.embedder.dimension
            self.embedder.dimension = dimension
            index = faiss.IndexIDMap2(faiss.IndexFlatIP(dimension))
            if chunk_rows:
                index.add_with_ids(vectors, np.asarray([item["vector_id"] for item in chunk_rows], dtype="int64"))
            self._verify_index(index, chunk_rows, dimension)
            manifest = self._manifest_for(documents, chunk_rows, dimension)
            generation = manifest["generation"]
            generation_dir = self.generations_dir / generation
            temporary_dir = self.generations_dir / f".building-{generation}"
            temporary_dir.mkdir(parents=True, exist_ok=False)
            try:
                (temporary_dir / "knowledge.faiss").write_bytes(faiss.serialize_index(index).tobytes())
                (temporary_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
                os.replace(temporary_dir, generation_dir)
                # The database changes only after embedding and index verification succeeded.
                self.database.replace_chunks(chunk_rows)
                self._write_compatibility_files(generation_dir)
                self._write_active_pointer(generation, manifest)
            except Exception:
                if temporary_dir.exists():
                    shutil.rmtree(temporary_dir, ignore_errors=True)
                raise

            by_document: dict[str, list[dict[str, Any]]] = defaultdict(list)
            by_vector_id: dict[int, dict[str, Any]] = {}
            for row in chunk_rows:
                by_document[str(row["document_id"])].append(row)
                by_vector_id[int(row["vector_id"])] = row
            with self._state_lock:
                self.index = index
                self._vectors = vectors
                self._chunks_by_vector_id = by_vector_id
                self._chunks_by_document = dict(by_document)
                self._vector_row = {int(row["vector_id"]): position for position, row in enumerate(chunk_rows)}
                self._bm25 = Bm25Ranker(chunk_rows)
                self._active_generation = generation
                self._manifest = manifest
            return manifest

    def search(
        self,
        query: str,
        top_k: int = 2,
        document_ids: list[str] | None = None,
        allowed_security_levels: set[str] | None = None,
        request_id: str | None = None,
    ) -> list[dict[str, Any]]:
        began = time.perf_counter()
        query = str(query or "").strip()
        if not query:
            return []
        with self._state_lock:
            index = self.index
            vectors = self._vectors
            chunks = self._chunks_by_vector_id.copy()
            chunks_by_document = {key: list(value) for key, value in self._chunks_by_document.items()}
            vector_row = self._vector_row.copy()
            bm25 = self._bm25
            generation = self._active_generation
        if index is None or index.ntotal == 0:
            return self._finish_search(request_id, query, generation, document_ids, [], "empty_index", began)

        levels = set(allowed_security_levels or self.allowed_security_levels)
        allowed_documents = set(document_ids) if document_ids is not None else None
        eligible = {
            vector_id: row for vector_id, row in chunks.items()
            if row.get("security_level", "internal") in levels and (allowed_documents is None or row["document_id"] in allowed_documents)
        }
        if not eligible:
            return self._finish_search(request_id, query, generation, document_ids, [], "no_authorized_evidence", began, levels)

        top_k = max(1, min(int(top_k), 4))
        candidate_limit = min(max(self.candidate_k, top_k * 6), len(eligible))
        query_vector = self.embedder.encode_query(query)
        eligible_ids = set(eligible)
        dense = self._dense_search(index, vectors, vector_row, query_vector, eligible_ids, candidate_limit)
        # If a filter is active, lexical corpus statistics are also limited to authorized chunks.
        lexical_ranker = bm25 if len(eligible) == len(chunks) else Bm25Ranker(list(eligible.values()))
        lexical = dict(lexical_ranker.search(query, candidate_limit, eligible_ids))
        maximum_lexical = max(lexical.values(), default=1.0)
        ranked = self._rerank(query, eligible, dense, lexical, maximum_lexical)
        # De-duplicate identical content before selecting evidence.
        unique_ranked: list[tuple[float, dict[str, Any], float, float]] = []
        seen_content: set[str] = set()
        for item in ranked:
            content_hash = str(item[1]["content_sha256"])
            if content_hash not in seen_content:
                unique_ranked.append(item)
                seen_content.add(content_hash)
        reranked = unique_ranked[: self.rerank_k]
        threshold = self.min_confidence if self.embedder.mode == "local-sentence-transformer" else min(0.25, self.min_confidence)
        if not reranked or reranked[0][0] < threshold:
            return self._finish_search(request_id, query, generation, document_ids, [], "insufficient_confidence", began, levels)

        evidence = [self._evidence(query, record, final_score, dense_score, lexical_score, chunks_by_document) for final_score, record, dense_score, lexical_score in reranked[:top_k]]
        return self._finish_search(request_id, query, generation, document_ids, evidence, "ok", began, levels)

    def status(self) -> dict[str, Any]:
        with self._state_lock:
            return {
                "ready": self.index is not None,
                "chunkCount": int(self.index.ntotal) if self.index else 0,
                "indexPath": str(self.index_path),
                "activeGeneration": self._active_generation,
                "embedding": self.embedder.status(),
                "retrieval": {
                    "dense": "FAISS IndexFlatIP", "lexical": "BM25", "reranker": "hybrid-score + sentence-overlap",
                    "candidateK": self.candidate_k, "rerankK": self.rerank_k, "minimumConfidence": self.min_confidence,
                    "allowedSecurityLevels": sorted(self.allowed_security_levels),
                },
            }

    def _dense_search(
        self,
        index: faiss.IndexIDMap2,
        vectors: np.ndarray,
        vector_row: dict[int, int],
        query_vector: np.ndarray,
        eligible_ids: set[int],
        limit: int,
    ) -> dict[int, float]:
        if len(eligible_ids) == int(index.ntotal):
            scores, ids = index.search(query_vector, limit)
            return {int(vector_id): float(score) for vector_id, score in zip(ids[0], scores[0], strict=True) if int(vector_id) >= 0}
        # Authorization is applied before scoring: build an ephemeral filtered index over only allowed rows.
        ordered_ids = sorted(eligible_ids)
        filtered_vectors = np.ascontiguousarray(np.vstack([vectors[vector_row[item]] for item in ordered_ids]).astype("float32"))
        filtered_index = faiss.IndexIDMap2(faiss.IndexFlatIP(filtered_vectors.shape[1]))
        filtered_index.add_with_ids(filtered_vectors, np.asarray(ordered_ids, dtype="int64"))
        scores, ids = filtered_index.search(query_vector, limit)
        return {int(vector_id): float(score) for vector_id, score in zip(ids[0], scores[0], strict=True) if int(vector_id) >= 0}

    def _rerank(
        self,
        query: str,
        eligible: dict[int, dict[str, Any]],
        dense: dict[int, float],
        lexical: dict[int, float],
        maximum_lexical: float,
    ) -> list[tuple[float, dict[str, Any], float, float]]:
        ranked: list[tuple[float, dict[str, Any], float, float]] = []
        query_terms = set(_tokens(query))
        dense_weight = 0.72 if self.embedder.mode == "local-sentence-transformer" else 0.32
        lexical_weight = 1.0 - dense_weight
        for vector_id in set(dense) | set(lexical):
            record = eligible.get(vector_id)
            if not record:
                continue
            # IndexFlatIP receives normalized vectors, so its inner product is cosine similarity.
            # A zero/negative cosine is not evidence and must not pass the abstention threshold.
            dense_score = max(0.0, min(1.0, dense.get(vector_id, 0.0)))
            lexical_score = max(0.0, min(1.0, lexical.get(vector_id, 0.0) / maximum_lexical))
            sentence_score = self._sentence_overlap(record["content"], query_terms)
            final_score = 0.88 * (dense_weight * dense_score + lexical_weight * lexical_score) + 0.12 * sentence_score
            ranked.append((final_score, record, dense_score, lexical_score))
        return sorted(ranked, key=lambda item: (-item[0], item[1]["stable_id"]))

    def _evidence(
        self,
        query: str,
        record: dict[str, Any],
        final_score: float,
        dense_score: float,
        lexical_score: float,
        chunks_by_document: dict[str, list[dict[str, Any]]],
    ) -> dict[str, Any]:
        quote, quote_start, quote_end = self._best_sentence(record["content"], query)
        return {
            "id": record["stable_id"], "chunkId": record["stable_id"], "documentId": record["document_id"],
            "versionId": record["version_id"], "fileName": record.get("file_name", "本地材料"), "locator": record["locator"],
            "quote": quote, "quoteStart": quote_start, "quoteEnd": quote_end, "quoteSha256": _sha256_text(quote),
            "context": self._context_with_neighbor(record, chunks_by_document), "score": round(max(0.0, min(0.99, final_score)), 3),
            "denseScore": round(dense_score, 3), "lexicalScore": round(lexical_score, 3),
            "securityLevel": record["security_level"],
        }

    def _context_with_neighbor(self, record: dict[str, Any], chunks_by_document: dict[str, list[dict[str, Any]]], maximum_characters: int = 560) -> str:
        context = str(record["content"])[:maximum_characters]
        if len(context) >= maximum_characters:
            return context
        siblings = chunks_by_document.get(str(record["document_id"]), [])
        position = next((index for index, item in enumerate(siblings) if item["stable_id"] == record["stable_id"]), -1)
        if position < 0 or position + 1 >= len(siblings):
            return context
        return f"{context}\n{str(siblings[position + 1]['content'])[:maximum_characters - len(context)]}".strip()

    def _manifest_for(self, documents: list[dict[str, Any] | None], chunks: list[dict[str, Any]], dimension: int) -> dict[str, Any]:
        documents = [item for item in documents if item]
        config = {
            "chunkCharacters": 360, "chunkOverlap": 48, "candidateK": self.candidate_k, "rerankK": self.rerank_k,
            "minimumConfidence": self.min_confidence, "queryInstruction": self.embedder.query_instruction,
        }
        config_sha256 = _sha256_text(json.dumps(config, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
        return {
            "version": 3,
            "generation": f"gen-{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}-{uuid4().hex[:8]}",
            "chunks": len(chunks), "dimension": dimension, "embedding": self.embedder.status(), "config": config,
            "configSha256": config_sha256,
            "documents": [{"documentId": item["id"], "versionId": item.get("version_id"), "fileSha256": item.get("file_sha256"), "securityLevel": item.get("security_level", "internal")} for item in documents],
            "retrieval": {"dense": "FAISS IndexFlatIP", "lexical": "BM25", "reranker": "hybrid-score + sentence-overlap"},
            "updatedAt": datetime.now(UTC).isoformat(),
        }

    def _write_active_pointer(self, generation: str, manifest: dict[str, Any]) -> None:
        temporary = self.active_path.with_suffix(".tmp")
        temporary.write_text(json.dumps({"generation": generation, "manifestSha256": _sha256_text(json.dumps(manifest, ensure_ascii=False, sort_keys=True))}, ensure_ascii=False), encoding="utf-8")
        os.replace(temporary, self.active_path)

    def _write_compatibility_files(self, generation_dir: Path) -> None:
        temp_index = self.index_path.with_suffix(".tmp")
        temp_manifest = self.meta_path.with_suffix(".tmp")
        shutil.copyfile(generation_dir / "knowledge.faiss", temp_index)
        shutil.copyfile(generation_dir / "manifest.json", temp_manifest)
        os.replace(temp_index, self.index_path)
        os.replace(temp_manifest, self.meta_path)

    @staticmethod
    def _verify_index(index: faiss.IndexIDMap2, chunks: list[dict[str, Any]], dimension: int) -> None:
        if int(index.ntotal) != len(chunks) or dimension <= 0:
            raise RuntimeError("RAG 索引验证失败")
        identifiers = [int(item["vector_id"]) for item in chunks]
        if len(identifiers) != len(set(identifiers)):
            raise RuntimeError("RAG 切片向量 ID 冲突")

    def _finish_search(
        self,
        request_id: str | None,
        query: str,
        generation: str,
        document_ids: list[str] | None,
        evidence: list[dict[str, Any]],
        status: str,
        began: float,
        allowed_security_levels: set[str] | None = None,
    ) -> list[dict[str, Any]]:
        if request_id:
            audit_evidence = [{"chunkId": item["chunkId"], "score": item["score"], "quoteSha256": item["quoteSha256"]} for item in evidence]
            self.database.add_retrieval_event(
                request_id, _sha256_text(query), generation,
                {"documentIds": sorted(document_ids or []), "allowedSecurityLevels": sorted(allowed_security_levels or self.allowed_security_levels)},
                audit_evidence, status, max(1, round((time.perf_counter() - began) * 1000)),
            )
        return evidence

    @staticmethod
    def _sentence_overlap(content: str, query_terms: set[str]) -> float:
        candidates = [item.strip() for item in re.split(r"(?<=[。！？；])|\n", content) if item.strip()]
        return min(1.0, max((len(query_terms.intersection(_tokens(item))) / max(1, len(query_terms)) for item in candidates), default=0.0))

    @staticmethod
    def _best_sentence(content: str, query: str) -> tuple[str, int, int]:
        candidates = [item.strip() for item in re.split(r"(?<=[。！？；])|\n", content) if item.strip()]
        query_terms = set(_tokens(query))
        quote = max(candidates, key=lambda item: (len(query_terms.intersection(_tokens(item))), len(item)))[:260] if candidates else content[:260]
        start = content.find(quote)
        return quote, max(0, start), max(0, start) + len(quote)
